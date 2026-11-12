import type {Hex} from "viem";
import type {Policy} from "./policy.js";

/**
 * Every knob the runner has, read once at boot and validated together so a
 * misconfigured deploy fails on the first line of the log rather than on the
 * first transaction.
 */

export interface NetworkConfig {
  id: number;
  name: string;
  rpcUrl: string;
}

/**
 * Both Robinhood networks, mirroring api/src/chain.ts. Mainnet is the default;
 * testnet only when RECURVE_CHAIN_ID asks for it. An id outside these two is
 * refused outright — this process signs with a hot key, and "some other chain"
 * is not somewhere it should ever wake up.
 */
export const NETWORKS: Record<"mainnet" | "testnet", NetworkConfig> = {
  mainnet: {id: 4663, name: "Robinhood Chain", rpcUrl: "https://rpc.mainnet.chain.robinhood.com"},
  testnet: {id: 46630, name: "Robinhood Chain Testnet", rpcUrl: "https://rpc.testnet.chain.robinhood.com"},
};

export type Env = Record<string, string | undefined>;

export function selectNetwork(env: Env): NetworkConfig {
  const raw = env.RECURVE_CHAIN_ID;
  const id = raw === undefined || raw === "" ? NETWORKS.mainnet.id : Number(raw);
  const known = Object.values(NETWORKS).find((n) => n.id === id);
  if (!known) {
    const ids = Object.values(NETWORKS)
      .map((n) => `${n.id} (${n.name})`)
      .join(", ");
    throw new Error(`RECURVE_CHAIN_ID=${raw} is not a Recurve network. Known: ${ids}.`);
  }
  return {...known, rpcUrl: env.RECURVE_RPC_URL || known.rpcUrl};
}

export interface Config {
  network: NetworkConfig;
  privateKey: Hex;
  vault: Hex;
  governor: Hex;
  registry: Hex;
  strategy: Hex;
  /** The one basket leg the strategy trades, $RECURVE. */
  token: Hex;
  quoter: Hex;
  /** Block the governor went up. Bounds every log scan. */
  deployBlock: bigint;
  /** Blocks per eth_getLogs call. Both Robinhood RPCs take a million; smaller for ones that do not. */
  logChunk: bigint;
  /**
   * How far the price may move between proposing and executing before the
   * runner would rather re-propose than fill. The veto window is a day; the
   * quote is taken at proposal time; the floor written into the calldata is
   * quote × (1 − tolerance), and the strategy contract then allows its own
   * `maxSlippageBps` below that.
   */
  priceToleranceBps: bigint;
  /** Smallest funding worth proposing, in whole units of the vault asset. */
  minTrade: string;
  policy: Policy;
  /** Simulate and log every action, send nothing. */
  dryRun: boolean;
  intervalMs: number;
  healthPort: number;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const BPS = 10_000n;

export function loadConfig(env: Env): Config {
  const problems: string[] = [];

  const required = (name: string, pattern: RegExp, what: string): Hex => {
    const v = env[name];
    if (!v) {
      problems.push(`${name} is required (${what})`);
      return "0x";
    }
    if (!pattern.test(v)) problems.push(`${name} is not ${what}: ${v}`);
    return v as Hex;
  };

  const bps = (name: string, fallback: bigint, max: bigint): bigint => {
    const v = env[name];
    if (v === undefined || v === "") return fallback;
    if (!/^\d+$/.test(v) || BigInt(v) > max) {
      problems.push(`${name} must be an integer between 0 and ${max}: ${v}`);
      return fallback;
    }
    return BigInt(v);
  };

  const integer = (name: string, fallback: number): number => {
    const v = env[name];
    if (v === undefined || v === "") return fallback;
    if (!/^\d+$/.test(v)) {
      problems.push(`${name} must be a non-negative integer: ${v}`);
      return fallback;
    }
    return Number(v);
  };

  const flag = (name: string): boolean => {
    const v = (env[name] ?? "").trim().toLowerCase();
    return v === "1" || v === "true" || v === "yes" || v === "on";
  };

  let network: NetworkConfig = NETWORKS.mainnet;
  try {
    network = selectNetwork(env);
  } catch (err) {
    problems.push((err as Error).message);
  }

  const privateKey = required("PRIVATE_KEY", PRIVATE_KEY, "a 0x-prefixed 32-byte hex key");
  const vault = required("RECURVE_VAULT", ADDRESS, "an address");
  const governor = required("RECURVE_GOVERNOR", ADDRESS, "an address");
  const registry = required("RECURVE_REGISTRY", ADDRESS, "an address");
  const strategy = required("RECURVE_STRATEGY", ADDRESS, "an address");
  const token = required("RECURVE_TOKEN", ADDRESS, "an address");
  const quoter = required("DEX_QUOTER", ADDRESS, "an address");

  const holdRaw = env.HOLD_SECONDS;
  let holdSeconds: bigint | null = null;
  if (holdRaw !== undefined && holdRaw !== "") {
    if (!/^\d+$/.test(holdRaw)) problems.push(`HOLD_SECONDS must be a non-negative integer: ${holdRaw}`);
    else holdSeconds = BigInt(holdRaw);
  }

  const minTrade = env.MIN_TRADE ?? "0.001";
  if (!/^\d+(\.\d+)?$/.test(minTrade)) problems.push(`MIN_TRADE must be a decimal amount of the vault asset: ${minTrade}`);

  // A tolerance of 100% is a floor of zero, which is an invitation to be sandwiched.
  const priceToleranceBps = bps("PRICE_TOLERANCE_BPS", 300n, BPS - 1n);
  const reserveBps = bps("RESERVE_BPS", 1000n, BPS);

  const cfg: Config = {
    network,
    privateKey,
    vault,
    governor,
    registry,
    strategy,
    token,
    quoter,
    deployBlock: BigInt(integer("RECURVE_DEPLOY_BLOCK", 0)),
    logChunk: BigInt(integer("LOG_CHUNK", 100_000)),
    priceToleranceBps,
    minTrade,
    policy: {
      minTrade: 0n, // resolved at boot once the asset's decimals are known
      reserveBps,
      holdSeconds,
      forceUnwind: flag("FORCE_UNWIND"),
      paused: flag("PAUSED"),
    },
    dryRun: flag("DRY_RUN"),
    intervalMs: integer("RUNNER_INTERVAL_MS", 60_000),
    healthPort: integer("PORT", 8080),
  };

  if (problems.length > 0) {
    throw new Error(`Bad configuration:\n  - ${problems.join("\n  - ")}`);
  }
  return cfg;
}
