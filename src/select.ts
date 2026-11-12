import {decodeFunctionData, type Hex} from "viem";
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
 * never executed, waited on or settled here.
 *
 * This is the shape of a proposal, not who posted it: the governor does not
 * record that, and a runner restarted with a new key has to be able to finish
 * the cycle the old one began. Only an agent can post, the Safe decides who is
 * one, and the runner is written for a governor where it is the only one. A
 * second agent could post a buy or a sell here with a floor of its choosing,
 * and this runner would execute it, as that agent could itself.
 */
export type ProposalKind = "buy" | "sell" | "return" | "other";

export function proposalKind(target: Hex, callData: Hex, strategy: Hex, token: Hex): ProposalKind {
  if (target.toLowerCase() !== strategy.toLowerCase()) return "other";
  try {
    const call = decodeFunctionData({abi: strategyAbi, data: callData});
    if (call.functionName === "returnToVault") return "return";
    if (call.functionName !== "buy" && call.functionName !== "sell") return "other";
    // The one leg this runner trades. A swap of anything else is not its own.
    return call.args[0].toLowerCase() === token.toLowerCase() ? call.functionName : "other";
  } catch {
    return "other"; // no call, an unknown call, or arguments that do not decode
  }
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

/** One change to the exit queue, as the vault's events report it. */
export type ExitEvent = {kind: "queued"; requestId: bigint; shares: bigint} | {kind: "claimed"; requestId: bigint};

/** Keeps `queue` (request id to shares still waiting) in step with one event. */
export function applyExit(queue: Map<bigint, bigint>, event: ExitEvent): void {
  if (event.kind === "queued") queue.set(event.requestId, event.shares);
  else queue.delete(event.requestId);
}

/** Shares the queue is still waiting to redeem. */
export function waitingShares(queue: ReadonlyMap<bigint, bigint>): bigint {
  let total = 0n;
  for (const shares of queue.values()) total += shares;
  return total;
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
