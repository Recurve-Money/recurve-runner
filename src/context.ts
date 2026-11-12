import type {Account, Chain, Hex, PublicClient, Transport, WalletClient} from "viem";
import type {Recurve} from "@recurvemoney/sdk";
import type {Config} from "./config.js";

/**
 * Everything a round needs, resolved once at boot: clients, the signing
 * account, and the on-chain constants the runner must agree with the
 * contracts on (fee tier, slippage cap, performance fee).
 */
export interface Context {
  cfg: Config;
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
  recurve: Recurve;
  account: Hex;
  /** The vault's denomination asset. */
  base: {address: Hex; decimals: number; symbol: string};
  /** The basket leg's token. */
  leg: {decimals: number; symbol: string};
  /** Pool fee tier the strategy swaps base/leg on. The quoter must use the same one. */
  feeTier: number;
  /** The strategy's own cap on how far below the stated quote the floor may sit. */
  maxSlippageBps: bigint;
  /** Governor performance fee, which settle pulls from this account. */
  performanceFeeBps: bigint;
  /** How many watcher blocks stop execution. */
  watcherBlockThreshold: bigint;
  log: (msg: string) => void;
}
