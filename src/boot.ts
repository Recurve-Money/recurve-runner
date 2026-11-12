import {createPublicClient, createWalletClient, defineChain, formatEther, http, parseUnits, type Hex} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {Recurve} from "@recurvemoney/sdk";
import {erc20Abi, governorExtraAbi, quoterAbi, strategyAbi, vaultQueueAbi} from "./abi.js";
import type {Config} from "./config.js";
import type {Context} from "./context.js";
import {firstLine} from "./view.js";

export const log = (msg: string): void => console.log(`${new Date().toISOString()} [runner] ${msg}`);

/** Deployed on both Robinhood chains; lets the reads in a round share one call. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

// ---------------------------------------------------------------- boot

export async function boot(cfg: Config): Promise<Context> {
  const chain = defineChain({
    id: cfg.network.id,
    name: cfg.network.name,
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: [cfg.network.rpcUrl]}},
    contracts: {multicall3: {address: MULTICALL3}},
  });
  const account = privateKeyToAccount(cfg.privateKey);
  const publicClient = createPublicClient({chain, transport: http()});
  const walletClient = createWalletClient({chain, transport: http(), account});

  // The chain first. Everything after this is a contract read, and a contract
  // read against the wrong chain answers with somebody else's contract.
  const chainId = await publicClient.getChainId();
  if (chainId !== cfg.network.id) {
    throw new Error(`RPC ${cfg.network.rpcUrl} is chain ${chainId}, configuration says ${cfg.network.id} (${cfg.network.name}).`);
  }

  const contracts = [
    {address: cfg.governor, abi: governorExtraAbi, functionName: "vault"},
    {address: cfg.vault, abi: vaultQueueAbi, functionName: "governor"},
    {address: cfg.vault, abi: vaultQueueAbi, functionName: "asset"},
    {address: cfg.strategy, abi: strategyAbi, functionName: "vault"},
    {address: cfg.strategy, abi: strategyAbi, functionName: "governor"},
    {address: cfg.strategy, abi: strategyAbi, functionName: "baseAsset"},
    {address: cfg.strategy, abi: strategyAbi, functionName: "isAllowed", args: [cfg.token]},
    {address: cfg.strategy, abi: strategyAbi, functionName: "feeTier", args: [cfg.token]},
    {address: cfg.strategy, abi: strategyAbi, functionName: "maxSlippageBps"},
    {address: cfg.governor, abi: governorExtraAbi, functionName: "isAgent", args: [account.address]},
    {address: cfg.governor, abi: governorExtraAbi, functionName: "performanceFeeBps"},
    {address: cfg.governor, abi: governorExtraAbi, functionName: "watcherBlockThreshold"},
  ] as const;

  // Read every cross-reference in one call, failures allowed, so a wrong
  // address is reported by name — "returned no data" is what an address with
  // no Recurve contract behind it answers, which is exactly the testnet-
  // address-on-mainnet mistake.
  const answers = await publicClient.multicall({contracts, allowFailure: true});
  const bad = answers
    .map((r, i) => (r.status === "failure" ? `${contracts[i]!.functionName}() on ${contracts[i]!.address}` : null))
    .filter((x): x is string => x !== null);
  if (bad.length > 0) {
    throw new Error(
      `These reads failed, so at least one configured address is not a Recurve contract on ${cfg.network.name}:\n  - ${bad.join("\n  - ")}`,
    );
  }
  const [governorVault, vaultGovernor, vaultAsset, stratVault, stratGovernor, stratBase, tokenAllowed, feeTier, maxSlippageBps, isAgent, performanceFeeBps, watcherBlockThreshold] =
    answers.map((r) => r.result) as [Hex, Hex, Hex, Hex, Hex, Hex, boolean, number, bigint, boolean, bigint, bigint];

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const problems: string[] = [];
  if (!same(governorVault, cfg.vault)) problems.push(`RECURVE_GOVERNOR governs ${governorVault}, not RECURVE_VAULT ${cfg.vault}`);
  if (!same(vaultGovernor, cfg.governor)) problems.push(`RECURVE_VAULT's governor is ${vaultGovernor}, not RECURVE_GOVERNOR ${cfg.governor}`);
  if (!same(stratVault, cfg.vault)) problems.push(`RECURVE_STRATEGY returns funds to ${stratVault}, not RECURVE_VAULT ${cfg.vault}`);
  if (!same(stratGovernor, cfg.governor)) problems.push(`RECURVE_STRATEGY answers to ${stratGovernor}, not RECURVE_GOVERNOR ${cfg.governor}`);
  if (!same(stratBase, vaultAsset)) problems.push(`RECURVE_STRATEGY trades from ${stratBase} but the vault holds ${vaultAsset}`);
  if (!tokenAllowed) problems.push(`RECURVE_TOKEN ${cfg.token} is not in RECURVE_STRATEGY's basket`);
  if (!isAgent) problems.push(`${account.address} is not an agent on RECURVE_GOVERNOR; addAgent() it first`);
  if (problems.length > 0) throw new Error(`Configuration does not match the chain:\n  - ${problems.join("\n  - ")}`);

  const [baseDecimals, baseSymbol, legDecimals, legSymbol, gas] = await Promise.all([
    publicClient.readContract({address: vaultAsset, abi: erc20Abi, functionName: "decimals"}),
    publicClient.readContract({address: vaultAsset, abi: erc20Abi, functionName: "symbol"}),
    publicClient.readContract({address: cfg.token, abi: erc20Abi, functionName: "decimals"}),
    publicClient.readContract({address: cfg.token, abi: erc20Abi, functionName: "symbol"}),
    publicClient.getBalance({address: account.address}),
  ]);

  // The quoter has to price the exact pool the strategy will swap on, or the
  // floor written into a proposal is for a different market.
  try {
    await publicClient.simulateContract({
      address: cfg.quoter,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{tokenIn: vaultAsset, tokenOut: cfg.token, amountIn: parseUnits("1", baseDecimals), fee: feeTier, sqrtPriceLimitX96: 0n}],
    });
  } catch (err) {
    throw new Error(`DEX_QUOTER ${cfg.quoter} cannot quote ${baseSymbol}->${legSymbol} on fee tier ${feeTier}: ${firstLine(err)}`);
  }

  if (gas === 0n) throw new Error(`${account.address} holds no ETH for gas on ${cfg.network.name}.`);
  // A full cycle (propose, execute ×3 steps, settle) burned ~1.4M gas, ~0.00003
  // ETH at Robinhood mainnet's 0.02 gwei (fork measurement, 2026-10-31): warn
  // when fewer than about two cycles are left.
  if (gas < parseUnits("0.00005", 18)) log(`warning: ${account.address} holds only ${formatEther(gas)} ETH for gas`);

  cfg.policy.minTrade = parseUnits(cfg.minTrade, baseDecimals);

  const recurve = new Recurve({
    publicClient,
    walletClient,
    addresses: {vault: cfg.vault, governor: cfg.governor, registry: cfg.registry},
  });

  return {
    cfg,
    publicClient,
    walletClient,
    recurve,
    account: account.address,
    base: {address: vaultAsset as Hex, decimals: baseDecimals, symbol: baseSymbol},
    leg: {decimals: legDecimals, symbol: legSymbol},
    feeTier,
    maxSlippageBps,
    performanceFeeBps,
    watcherBlockThreshold,
    log,
  };
}

