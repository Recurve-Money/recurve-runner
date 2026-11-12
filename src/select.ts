import type {Hex} from "viem";
import {ProposalState} from "@recurvemoney/sdk";

/**
 * Picking the proposals that matter out of the governor's history. The
 * governor keeps proposals in a mapping with no list, so the runner
 * reconstructs the list from `ProposalPosted` logs and reads each one's live
 * state; these functions are the pure part of that.
 */

export interface ProposalRecord {
  id: Hex;
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
  const last = history[history.length - 1];
  if (!last || last.state !== ProposalState.Pending || abandoned.has(last.id)) return null;
  return {id: last.id, executableAt: last.executableAt};
}

/** The executed proposal that put capital out — the one `settle` books against. */
export function currentFunding(
  history: readonly ProposalRecord[],
): {id: Hex; assets: bigint; executedAt: bigint; executedBlock: bigint} | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const p = history[i]!;
    if (p.state !== ProposalState.Executed || p.assets === 0n) continue;
    if (p.executedAt === null || p.executedBlock === null) continue;
    return {id: p.id, assets: p.assets, executedAt: p.executedAt, executedBlock: p.executedBlock};
  }
  return null;
}

/**
 * What `returnToVault` sent back this cycle, read off `Liquidated`. Only logs
 * strictly after the funding block count: the funding transaction itself
 * cannot have returned anything, and anything earlier belongs to a previous
 * cycle.
 */
export function returnedSince(
  liquidated: ReadonlyArray<{blockNumber: bigint; amount: bigint}>,
  fundingBlock: bigint,
): bigint | null {
  let latest: bigint | null = null;
  for (const log of liquidated) {
    if (log.blockNumber > fundingBlock) latest = log.amount;
  }
  return latest;
}
