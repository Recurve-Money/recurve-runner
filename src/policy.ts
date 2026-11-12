import type {Hex} from "viem";

/**
 * The decision layer. Pure: chain state comes in as a `FundView`, an `Action`
 * goes out, and nothing in here touches an RPC. Everything the runner might
 * do with real money is decided here, so it is the part with the tests.
 */

export interface PendingProposal {
  id: Hex;
  /** Unix seconds when the veto window closes. */
  executableAt: bigint;
  /** Whether `execute` simulates cleanly right now. False once the window has
   *  closed means the proposal is stuck — a stale price floor, a vetoed
   *  strategy, a watcher block — and the runner should stop waiting on it. */
  executable: boolean;
}

export interface FundingProposal {
  id: Hex;
  /** Assets the proposal moved out of the vault. The settle fee is on profit over this. */
  assets: bigint;
  /** Unix seconds the proposal executed, which starts the hold clock. */
  executedAt: bigint;
}

export interface FundView {
  /** Chain time, unix seconds. Never wall-clock: the veto window is on chain time. */
  now: bigint;
  float: bigint;
  deployed: bigint;
  totalAssets: bigint;
  /** Assets owed to unclaimed queued redemptions, priced at the current share price. */
  queuedAssets: bigint;
  /** The newest live Pending proposal on the governor, if any. */
  pending: PendingProposal | null;
  /** The executed proposal that funded the current cycle, if any. */
  funding: FundingProposal | null;
  /** What the strategy holds: base asset and the one basket leg. */
  holdings: {base: bigint; leg: bigint};
  /** Assets `returnToVault` sent back this cycle, read off its event. Null until it has run. */
  returned: bigint | null;
}

export interface Policy {
  /** Smallest funding worth a proposal; below it the gas is not worth the trade. */
  minTrade: bigint;
  /** Share of total assets kept idle so small exits clear without an unwind. */
  reserveBps: bigint;
  /** Unwind this long after funding. Null holds until exits or `forceUnwind` demand it. */
  holdSeconds: bigint | null;
  /** Operator kill switch for the position: sell and settle, then stay idle. */
  forceUnwind: boolean;
  /** Operator kill switch for the runner: observe, never act. */
  paused: boolean;
}

export type Action =
  | {kind: "idle"; reason: string}
  | {kind: "wait"; id: Hex; secondsLeft: number}
  | {kind: "execute"; id: Hex}
  | {kind: "abandon"; id: Hex}
  | {kind: "propose-buy"; assets: bigint}
  | {kind: "propose-sell"; amount: bigint}
  | {kind: "propose-return"}
  | {kind: "settle"; id: Hex; returned: bigint};

const BPS = 10_000n;

/** Float the runner may deploy: what is left after the reserve and the exit queue. */
export function deployable(view: FundView, policy: Policy): bigint {
  const reserve = (view.totalAssets * policy.reserveBps) / BPS;
  const free = view.float - view.queuedAssets - reserve;
  return free > 0n ? free : 0n;
}

/** Performance fee the governor will pull from the agent at settle: on profit only. */
export function settleFee(returned: bigint, funded: bigint, feeBps: bigint): bigint {
  if (returned <= funded) return 0n;
  return ((returned - funded) * feeBps) / BPS;
}

export function decide(view: FundView, policy: Policy): Action {
  if (policy.paused) return {kind: "idle", reason: "paused"};

  // One proposal in flight at a time. Whatever it is, it finishes (or dies)
  // before the runner considers anything else.
  if (view.pending) {
    const {id, executableAt, executable} = view.pending;
    if (executableAt > view.now) {
      return {kind: "wait", id, secondsLeft: Number(executableAt - view.now)};
    }
    return executable ? {kind: "execute", id} : {kind: "abandon", id};
  }

  if (view.deployed === 0n) {
    // The kill switch holds after the unwind it forced: a settled cycle must
    // not turn straight into a new position.
    if (policy.forceUnwind) return {kind: "idle", reason: "force unwind: not opening a new position"};
    const assets = deployable(view, policy);
    if (assets < policy.minTrade) return {kind: "idle", reason: "deployable below minimum trade"};
    return {kind: "propose-buy", assets};
  }

  // Capital is out. The cycle is sell -> return -> settle, and the vault's
  // holdings say which step is next. Float that arrives mid-cycle stays idle:
  // a second funding would break the one-settle-per-cycle accounting.
  const {base, leg} = view.holdings;

  if (leg > 0n) {
    return unwindDue(view, policy) ? {kind: "propose-sell", amount: leg} : {kind: "idle", reason: "holding"};
  }

  if (base > 0n) return {kind: "propose-return"};

  if (!view.funding) return {kind: "idle", reason: "no executed funding proposal to settle"};
  if (view.returned === null) return {kind: "idle", reason: "returned amount unknown, not settling"};
  return {kind: "settle", id: view.funding.id, returned: view.returned};
}

function unwindDue(view: FundView, policy: Policy): boolean {
  if (policy.forceUnwind) return true;
  // Depositors are queued for more than the float can pay: the position has to come back.
  if (view.queuedAssets > view.float) return true;
  if (policy.holdSeconds !== null && view.funding) {
    return view.now >= view.funding.executedAt + policy.holdSeconds;
  }
  return false;
}
