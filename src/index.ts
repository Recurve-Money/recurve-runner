/**
 * Recurve fund runner. Manages the propose -> veto window -> execute -> settle
 * lifecycle for one fund, on a schedule (see the bottom of this file).
 *
 * WHAT WORKS RIGHT NOW: everything in `runOnce()` except `decideNextMove()`.
 * The lifecycle management (propose, wait, check state, execute, settle) is
 * real and uses the real SDK. What it proposes is not filled in yet, because
 * that needs a Uniswap V3 SwapRouter + QuoterV2 address on testnet (46630)
 * that we have not confirmed exists. See decideNextMove() below.
 */
import {createPublicClient, createWalletClient, http, defineChain, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {Recurve, ProposalState} from "@recurvemoney/sdk";

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
    governor: requireEnv("RECURVE_GOVERNOR") as Hex,
    registry: requireEnv("RECURVE_REGISTRY") as Hex,
  },
});

/** Sleep helper, since we wait out real veto windows between steps. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TODO(blocked): decide what to propose next.
 *
 * This is where a real strategy call gets built — e.g. a PortfolioStrategy
 * `buy(token, amountIn, minAmountOut, quotedOut)`. It is not implemented
 * because:
 *
 *   1. No PortfolioStrategy is deployed for this vault yet.
 *   2. Building `buy`'s calldata safely needs a live quote from Uniswap's
 *      QuoterV2, and we have not confirmed a Uniswap V3 deployment exists
 *      on chain 46630 at all (only mainnet, 4663, is documented).
 *
 * Returning `null` here means "nothing to propose this round" -- the runner
 * below treats that as a no-op, not an error, so it is safe to deploy and
 * run on a schedule before this is filled in. It just will not do anything
 * yet.
 */
async function decideNextMove(): Promise<{target: Hex; assets: bigint; callData: Hex} | null> {
  return null;
}

async function runOnce(): Promise<void> {
  const snap = await recurve.vault.snapshot();
  console.log(`[runner] float=${snap.float} deployed=${snap.deployedAssets} sharePrice=${snap.sharePrice}`);

  const move = await decideNextMove();
  if (!move) {
    console.log("[runner] nothing to propose this round");
    return;
  }

  console.log(`[runner] proposing target=${move.target} assets=${move.assets}`);
  const id = await recurve.agent.propose(move.target, move.assets, move.callData);
  console.log(`[runner] proposed ${id}, waiting out the veto window`);

  const waitSeconds = await recurve.agent.secondsUntilExecutable(id);
  if (waitSeconds > 0) await sleep((waitSeconds + 5) * 1000); // +5s buffer past the boundary

  const proposal = await recurve.agent.proposal(id);
  if (proposal.state !== ProposalState.Pending) {
    console.log(`[runner] ${id} is ${ProposalState[proposal.state]}, not Pending -- not executing`);
    return;
  }

  console.log(`[runner] executing ${id}`);
  await recurve.agent.execute(id);

  // A real strategy settles what it actually returned; a real implementation
  // reads that off the strategy's return value or a follow-up read, not a
  // hardcoded number. Left unresolved for the same reason as decideNextMove.
  console.log(`[runner] executed ${id} -- settle() intentionally not called; see decideNextMove() TODO`);
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
