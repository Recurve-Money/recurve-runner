import {describe, expect, it} from "vitest";
import {ProposalState} from "@recurvemoney/sdk";
import {encodeBuy, encodeReturn, encodeSell} from "./trade.js";
import {applyExit, currentFunding, newestPending, proposalKind, returnedSince, soldSince, waitingShares, type ProposalRecord} from "./select.js";

const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

function rec(over: Partial<ProposalRecord> & {n: number}): ProposalRecord {
  const {n, ...rest} = over;
  return {
    id: id(n),
    kind: "buy",
    assets: 0n,
    executableAt: 0n,
    postedBlock: BigInt(n),
    state: ProposalState.Pending,
    executedAt: null,
    executedBlock: null,
    ...rest,
  };
}

describe("newestPending", () => {
  it("returns the most recently posted proposal when it is pending", () => {
    const list = [rec({n: 1, state: ProposalState.Executed}), rec({n: 2, executableAt: 5n})];
    expect(newestPending(list)).toEqual({id: id(2), executableAt: 5n});
  });

  it("returns null when the newest proposal is not pending, even if an older one is", () => {
    // An older Pending is one the runner already walked away from. Reviving it
    // would execute a trade quoted at a price nobody has looked at since.
    const list = [rec({n: 1}), rec({n: 2, state: ProposalState.Vetoed})];
    expect(newestPending(list)).toBeNull();
  });

  it("returns null for an empty history", () => {
    expect(newestPending([])).toBeNull();
  });

  it("looks past a proposal that is not the runner's, pending or not", () => {
    // Another agent's proposal, or one aimed somewhere else: never executed
    // from here, and never a reason to stop working the runner's own.
    const mine = rec({n: 1, executableAt: 5n});
    expect(newestPending([mine, rec({n: 2, kind: "other"})])).toEqual({id: id(1), executableAt: 5n});
    expect(newestPending([rec({n: 1, kind: "other"})])).toBeNull();
  });

  it("returns null when the newest pending proposal has been abandoned", () => {
    // Abandoned once, abandoned for good: the runner moves on and proposes
    // afresh instead of reporting the same dead proposal every round.
    const list = [rec({n: 1}), rec({n: 2, executableAt: 5n})];
    expect(newestPending(list, new Set([id(2)]))).toBeNull();
  });
});

describe("currentFunding", () => {
  it("is the newest executed proposal that moved assets", () => {
    const list = [
      rec({n: 1, assets: 10n, state: ProposalState.Settled, executedAt: 100n, executedBlock: 1n}),
      rec({n: 2, assets: 20n, state: ProposalState.Executed, executedAt: 200n, executedBlock: 2n}),
      rec({n: 3, assets: 0n, state: ProposalState.Executed, executedAt: 300n, executedBlock: 3n}),
    ];
    expect(currentFunding(list)).toEqual({id: id(2), assets: 20n, executedAt: 200n, executedBlock: 2n});
  });

  it("is never a proposal that is not one of the runner's buys", () => {
    // Settling it would book this runner's return against someone else's funding.
    const list = [
      rec({n: 1, kind: "other", assets: 20n, state: ProposalState.Executed, executedAt: 200n, executedBlock: 2n}),
    ];
    expect(currentFunding(list)).toBeNull();
  });

  it("ignores settled, vetoed and pending proposals", () => {
    const list = [
      rec({n: 1, assets: 10n, state: ProposalState.Settled, executedAt: 100n, executedBlock: 1n}),
      rec({n: 2, assets: 20n, state: ProposalState.Vetoed}),
      rec({n: 3, assets: 30n}),
    ];
    expect(currentFunding(list)).toBeNull();
  });
});

describe("the exit queue", () => {
  it("counts a request from when it is queued until it is claimed", () => {
    const queue = new Map<bigint, bigint>();
    applyExit(queue, {kind: "queued", requestId: 0n, shares: 10n});
    applyExit(queue, {kind: "queued", requestId: 1n, shares: 5n});
    expect(waitingShares(queue)).toBe(15n);
    applyExit(queue, {kind: "claimed", requestId: 0n});
    expect(waitingShares(queue)).toBe(5n);
  });

  it("is empty before anything is queued, and a claim it never saw queued changes nothing", () => {
    const queue = new Map<bigint, bigint>();
    applyExit(queue, {kind: "claimed", requestId: 7n});
    expect(waitingShares(queue)).toBe(0n);
  });
});

describe("soldSince", () => {
  const sell = (n: number, block: bigint | null) =>
    rec({n, kind: "sell", state: block === null ? ProposalState.Pending : ProposalState.Executed, executedBlock: block});

  it("is true once a sell has executed after the funding", () => {
    expect(soldSince([sell(1, 12n)], 10n)).toBe(true);
  });

  it("is false for a sell that is only proposed, or that belongs to an earlier cycle", () => {
    expect(soldSince([sell(1, null)], 10n)).toBe(false);
    expect(soldSince([sell(1, 8n)], 10n)).toBe(false);
  });
});

describe("proposalKind", () => {
  const strategy = "0x00000000000000000000000000000000000000AA";
  const token = "0x00000000000000000000000000000000000000bb";
  const floor = {quotedOut: 2n, minAmountOut: 1n};

  it("names the three calls the runner makes on its strategy", () => {
    expect(proposalKind(strategy, encodeBuy(token, 1n, floor), strategy, token)).toBe("buy");
    expect(proposalKind(strategy, encodeSell(token, 1n, floor), strategy, token)).toBe("sell");
    expect(proposalKind(strategy, encodeReturn(), strategy, token)).toBe("return");
  });

  it("compares addresses whatever their case", () => {
    expect(proposalKind("0x00000000000000000000000000000000000000aa", encodeReturn(), strategy, token)).toBe("return");
    expect(proposalKind(strategy, encodeBuy(token, 1n, floor), strategy, "0x00000000000000000000000000000000000000BB")).toBe("buy");
  });

  it("is other for another target, another token, another call, or no call at all", () => {
    expect(proposalKind(token, encodeReturn(), strategy, token)).toBe("other");
    expect(proposalKind(strategy, encodeSell(strategy, 1n, floor), strategy, token)).toBe("other");
    expect(proposalKind(strategy, "0xa9059cbb0000", strategy, token)).toBe("other");
    expect(proposalKind(strategy, "0x", strategy, token)).toBe("other");
  });
});

describe("returnedSince", () => {
  it("adds up every Liquidated amount after the funding block", () => {
    // A second return in one cycle sends back only what arrived after the
    // first. Taking the last one alone would book the cycle as a loss.
    const logs = [
      {blockNumber: 5n, amount: 1n},
      {blockNumber: 12n, amount: 2n},
      {blockNumber: 15n, amount: 3n},
    ];
    expect(returnedSince(logs, 10n)).toBe(5n);
  });

  it("ignores a Liquidated from a previous cycle", () => {
    expect(returnedSince([{blockNumber: 5n, amount: 1n}], 10n)).toBeNull();
  });

  it("ignores a Liquidated in the funding block itself", () => {
    // execute() funds and buys in one transaction; nothing can have come back yet.
    expect(returnedSince([{blockNumber: 10n, amount: 1n}], 10n)).toBeNull();
  });
});
