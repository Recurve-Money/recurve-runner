import {toFunctionSelector, getAbiItem, type Hex} from "viem";
import {ProposalState} from "@recurvemoney/sdk";
import {strategyAbi} from "./abi.js";

/**
 * Picking the proposals that matter out of the governor's history. The
 * governor keeps proposals in a mapping with no list, so the runner
 * reconstructs the list from `ProposalPosted` logs and reads each one's live
 * state; these functions are the pure part of that.
 */

/**
 * What a proposal asks for, read off its target and calldata: one of the three
 * calls this runner makes on its strategy, or `other`. An `other` proposal is
 * not this runner's work, whoever posted it, and is never executed, waited on
 * or settled here.
 */
export type ProposalKind = "buy" | "sell" | "return" | "other";

const SELECTORS: Record<string, ProposalKind> = {
  [toFunctionSelector(getAbiItem({abi: strategyAbi, name: "buy"}))]: "buy",
  [toFunctionSelector(getAbiItem({abi: strategyAbi, name: "sell"}))]: "sell",
  [toFunctionSelector(getAbiItem({abi: strategyAbi, name: "returnToVault"}))]: "return",
};

export function proposalKind(target: Hex, callData: Hex, strategy: Hex): ProposalKind {
  if (target.toLowerCase() !== strategy.toLowerCase()) return "other";
  return SELECTORS[callData.slice(0, 10).toLowerCase()] ?? "other";
}

export interface ProposalRecord {
  id: Hex;
  kind: ProposalKind;
  assets: bigint;
  executableAt: bigint;
  postedBlock: bigint;
  state: ProposalState;
  /** Unix seconds of the executing block, when the proposal has executed. */
  executedAt: bigint | null;
  executedBlock: bigint | null;
}

/**
 * The proposal the runner is waiting on: the newest one, and only if it is
 * still Pending. Older Pending proposals are ones the runner already moved
 * past (a stale floor, a watcher block) and are never revived — their calldata
 * was priced for a market nobody has looked at since.
 */
export function newestPending(
  history: readonly ProposalRecord[],
  abandoned: ReadonlySet<Hex> = new Set(),
): {id: Hex; executableAt: bigint} | null {
  let last: ProposalRecord | undefined;
  for (let i = history.length - 1; i >= 0 && !last; i--) {
    if (history[i]!.kind !== "other") last = history[i];
  }
  if (!last || last.state !== ProposalState.Pending || abandoned.has(last.id)) return null;
  return {id: last.id, executableAt: last.executableAt};
}

/** The executed buy that put capital out — the one `settle` books against. */
export function currentFunding(
  history: readonly ProposalRecord[],
): {id: Hex; assets: bigint; executedAt: bigint; executedBlock: bigint} | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const p = history[i]!;
    if (p.kind !== "buy" || p.state !== ProposalState.Executed || p.assets === 0n) continue;
    if (p.executedAt === null || p.executedBlock === null) continue;
    return {id: p.id, assets: p.assets, executedAt: p.executedAt, executedBlock: p.executedBlock};
  }
  return null;
}

/** Whether a sell has executed since the funding: the leg has been sold this cycle. */
export function soldSince(history: readonly ProposalRecord[], fundingBlock: bigint): boolean {
  return history.some((p) => p.kind === "sell" && p.executedBlock !== null && p.executedBlock > fundingBlock);
}

/**
 * What `returnToVault` sent back this cycle, read off `Liquidated`: every
 * return since the funding, added up, or null when there has been none. Only
 * logs strictly after the funding block count: the funding transaction itself
 * cannot have returned anything, and anything earlier belongs to a previous
 * cycle.
 */
export function returnedSince(
  liquidated: ReadonlyArray<{blockNumber: bigint; amount: bigint}>,
  fundingBlock: bigint,
): bigint | null {
  let total: bigint | null = null;
  for (const log of liquidated) {
    if (log.blockNumber > fundingBlock) total = (total ?? 0n) + log.amount;
  }
  return total;
}
