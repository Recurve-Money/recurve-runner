/**
 * Recurve fund runner. Manages the propose -> veto window -> execute -> settle
 * lifecycle for one fund, on a schedule (see the bottom of this file).
 *
 * decideNextMove() proposes swapping all idle float into $RECURVE through
 * PortfolioStrategy, quoted live off our own testnet Uniswap V3 pool
 * (recurve-dex). It is deliberately a single fixed trade, not a real
 * strategy: there is a WETH/$RECURVE pool and nothing else, so "the
 * strategy" is entirely about proving propose -> veto -> watcher -> execute
 * -> settle moves real funds, not about a trading edge.
 */
import {createPublicClient, createWalletClient, http, defineChain, encodeFunctionData, parseAbiItem, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {Recurve, ProposalState} from "@recurvemoney/sdk";

const PROPOSAL_POSTED_EVENT = parseAbiItem(
  "event ProposalPosted(bytes32 indexed proposalId, address indexed target, uint256 assets, uint256 executableAt)"
);

/**
 * The contract itself does not track "the" current proposal -- propose()
 * happily accepts a second one while the first is still Pending. Scanning
 * for the most recent ProposalPosted event and checking its live state is
 * how the runner knows whether something is already in flight, and its ID
 * if so, so a restart mid-veto-window doesn't either re-propose from
 * scratch or forget to ever execute what's already posted.
 */
async function findPendingProposal(governor: Hex): Promise<Hex | null> {
  const latestBlock = await publicClient.getBlockNumber();
  const deployBlock = BigInt(process.env.RECURVE_DEPLOY_BLOCK ?? "0");
  const logs = await publicClient.getLogs({
    address: governor,
    event: PROPOSAL_POSTED_EVENT,
    fromBlock: deployBlock,
    toBlock: latestBlock,
  });
  if (logs.length === 0) return null;

  const mostRecent = logs[logs.length - 1]!;
  const id = mostRecent.args.proposalId!;
  const proposal = await recurve.agent.proposal(id);
  return proposal.state === ProposalState.Pending ? id : null;
}

const RECURVE_STRATEGY = requireEnv("RECURVE_STRATEGY") as Hex;
const RECURVE_TOKEN = requireEnv("RECURVE_TOKEN") as Hex;
const RECURVE_GOVERNOR = requireEnv("RECURVE_GOVERNOR") as Hex;
const DEX_QUOTER = requireEnv("DEX_QUOTER") as Hex;
const POOL_FEE = 3000; // the fee tier the seeded WETH/RECURVE pool actually uses
const MAX_SLIPPAGE_BPS = 300n; // 3%, matching the strategy's own configured max

const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable", // QuoterV2 reverts internally to compute the quote -- called via simulate, never sent as a real tx
    inputs: [
      {
        type: "tuple",
        components: [
          {name: "tokenIn", type: "address"},
          {name: "tokenOut", type: "address"},
          {name: "amountIn", type: "uint256"},
          {name: "fee", type: "uint24"},
          {name: "sqrtPriceLimitX96", type: "uint160"},
        ],
      },
    ],
    outputs: [
      {name: "amountOut", type: "uint256"},
      {name: "sqrtPriceX96After", type: "uint160"},
      {name: "initializedTicksCrossed", type: "uint32"},
      {name: "gasEstimate", type: "uint256"},
    ],
  },
] as const;

const strategyAbi = [
  {
    type: "function",
    name: "buy",
    inputs: [
      {name: "token", type: "address"},
      {name: "amountIn", type: "uint256"},
      {name: "minAmountOut", type: "uint256"},
      {name: "quotedOut", type: "uint256"},
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
  rpcUrls: {default: {http: [requireEnv("RECURVE_RPC_URL")]}},
});

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const account = privateKeyToAccount(requireEnv("PRIVATE_KEY") as Hex);

const publicClient = createPublicClient({chain: robinhoodTestnet, transport: http()});
const walletClient = createWalletClient({chain: robinhoodTestnet, transport: http(), account});

const recurve = new Recurve({
  publicClient,
  walletClient,
  addresses: {
    vault: requireEnv("RECURVE_VAULT") as Hex,
    governor: RECURVE_GOVERNOR,
    registry: requireEnv("RECURVE_REGISTRY") as Hex,
  },
});

/** Sleep helper, since we wait out real veto windows between steps. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * If there is idle float sitting in the vault, propose swapping all of it
 * into $RECURVE through PortfolioStrategy. Quotes the swap live off the
 * seeded WETH/$RECURVE pool first, so `minAmountOut` reflects the pool's
 * actual price rather than a guess -- the same protection a human trader
 * gets from a DEX front-end's slippage setting, just computed here instead.
 */
async function decideNextMove(): Promise<{target: Hex; assets: bigint; callData: Hex} | null> {
  const snap = await recurve.vault.snapshot();
  if (snap.float <= 0n) return null;

  const [quotedOut] = await publicClient.simulateContract({
    address: DEX_QUOTER,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: requireEnv("VAULT_ASSET") as Hex, // WETH
        tokenOut: RECURVE_TOKEN,
        amountIn: snap.float,
        fee: POOL_FEE,
        sqrtPriceLimitX96: 0n,
      },
    ],
  }).then((r) => r.result);

  const minAmountOut = (quotedOut * (10_000n - MAX_SLIPPAGE_BPS)) / 10_000n;

  const callData = encodeFunctionData({
    abi: strategyAbi,
    functionName: "buy",
    args: [RECURVE_TOKEN, snap.float, minAmountOut, quotedOut],
  });

  return {target: RECURVE_STRATEGY, assets: snap.float, callData};
}

async function runOnce(): Promise<void> {
  const snap = await recurve.vault.snapshot();
  console.log(`[runner] float=${snap.float} deployed=${snap.deployedAssets} sharePrice=${snap.sharePrice}`);

  const pendingId = await findPendingProposal(RECURVE_GOVERNOR);

  if (pendingId) {
    const waitSeconds = await recurve.agent.secondsUntilExecutable(pendingId);
    if (waitSeconds > 0) {
      console.log(`[runner] ${pendingId} is pending, ${waitSeconds}s left in its veto window -- checking again next interval`);
      return;
    }

    console.log(`[runner] ${pendingId}'s veto window has closed -- executing`);
    await recurve.agent.execute(pendingId);
    // A real strategy settles what it actually returned; a real implementation
    // reads that off the strategy's return value or a follow-up read, not a
    // hardcoded number. Left unresolved for the same reason as decideNextMove.
    console.log(`[runner] executed ${pendingId} -- settle() intentionally not called; see decideNextMove() TODO`);
    return;
  }

  const move = await decideNextMove();
  if (!move) {
    console.log("[runner] nothing to propose this round");
    return;
  }

  console.log(`[runner] proposing target=${move.target} assets=${move.assets}`);
  const id = await recurve.agent.propose(move.target, move.assets, move.callData);
  console.log(`[runner] proposed ${id} -- will execute once its veto window closes`);
}

const INTERVAL_MS = Number(process.env.RUNNER_INTERVAL_MS ?? 24 * 60 * 60 * 1000); // default: once/day

async function main() {
  console.log(`[runner] starting, interval=${INTERVAL_MS}ms, vault=${requireEnv("RECURVE_VAULT")}`);
  for (;;) {
    try {
      await runOnce();
    } catch (err) {
      // One bad round should not kill the process -- log and try again next
      // interval rather than crash-looping a Railway deploy.
      console.error("[runner] round failed:", err);
    }
    await sleep(INTERVAL_MS);
  }
}

main();
