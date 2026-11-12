import {describe, expect, it} from "vitest";
import {ProposalState} from "@recurvemoney/sdk";
import {currentFunding, newestPending, returnedSince, type ProposalRecord} from "./select.js";

const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

function rec(over: Partial<ProposalRecord> & {n: number}): ProposalRecord {
  const {n, ...rest} = over;
  return {
    id: id(n),
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

  it("ignores settled, vetoed and pending proposals", () => {
    const list = [
      rec({n: 1, assets: 10n, state: ProposalState.Settled, executedAt: 100n, executedBlock: 1n}),
      rec({n: 2, assets: 20n, state: ProposalState.Vetoed}),
      rec({n: 3, assets: 30n}),
    ];
    expect(currentFunding(list)).toBeNull();
  });
});

describe("returnedSince", () => {
  it("is the latest Liquidated amount after the funding block", () => {
    const logs = [
      {blockNumber: 5n, amount: 1n},
      {blockNumber: 12n, amount: 2n},
      {blockNumber: 15n, amount: 3n},
    ];
    expect(returnedSince(logs, 10n)).toBe(3n);
  });

  it("ignores a Liquidated from a previous cycle", () => {
    expect(returnedSince([{blockNumber: 5n, amount: 1n}], 10n)).toBeNull();
  });

  it("ignores a Liquidated in the funding block itself", () => {
    // execute() funds and buys in one transaction; nothing can have come back yet.
    expect(returnedSince([{blockNumber: 10n, amount: 1n}], 10n)).toBeNull();
  });
});
