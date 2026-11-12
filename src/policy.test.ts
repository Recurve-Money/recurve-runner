import {describe, expect, it} from "vitest";
import {decide, deployable, settleFee, type FundView, type Policy} from "./policy.js";

const ETH = 10n ** 18n;
const ID = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const FUND = "0x2222222222222222222222222222222222222222222222222222222222222222" as const;

const policy: Policy = {
  minTrade: ETH / 1000n,
  reserveBps: 0n,
  holdSeconds: null,
  forceUnwind: false,
  paused: false,
};

/** An idle fund with 1 ETH float and nothing in flight. */
function view(over: Partial<FundView> = {}): FundView {
  return {
    now: 1_000_000n,
    float: ETH,
    deployed: 0n,
    totalAssets: ETH,
    queuedAssets: 0n,
    pending: null,
    funding: null,
    holdings: {base: 0n, leg: 0n},
    sold: false,
    returned: null,
    ...over,
  };
}

describe("deployable", () => {
  it("is the whole float when nothing is reserved or queued", () => {
    expect(deployable(view(), policy)).toBe(ETH);
  });

  it("keeps the reserve share of total assets in the float", () => {
    expect(deployable(view({totalAssets: 10n * ETH, float: 10n * ETH}), {...policy, reserveBps: 1000n})).toBe(
      9n * ETH,
    );
  });

  it("never deploys assets that queued exits are waiting on", () => {
    expect(deployable(view({queuedAssets: ETH / 4n}), policy)).toBe((ETH * 3n) / 4n);
  });

  it("is zero, not negative, when reserve and queue exceed the float", () => {
    expect(deployable(view({queuedAssets: 2n * ETH}), policy)).toBe(0n);
  });
});

describe("settleFee", () => {
  it("charges the fee on profit only", () => {
    expect(settleFee(110n * ETH, 100n * ETH, 500n)).toBe(ETH / 2n);
  });

  it("is zero on a loss", () => {
    expect(settleFee(90n * ETH, 100n * ETH, 500n)).toBe(0n);
  });

  it("is zero when flat", () => {
    expect(settleFee(100n * ETH, 100n * ETH, 500n)).toBe(0n);
  });
});

describe("decide: pause", () => {
  it("does nothing while paused, even with a proposal ready to execute", () => {
    const v = view({pending: {id: ID, executableAt: 1n, executable: true}});
    expect(decide(v, {...policy, paused: true})).toEqual({kind: "idle", reason: "paused"});
  });
});

describe("decide: a proposal is pending", () => {
  it("waits while the veto window is open", () => {
    const v = view({pending: {id: ID, executableAt: 1_000_100n, executable: true}});
    expect(decide(v, policy)).toEqual({kind: "wait", id: ID, secondsLeft: 100});
  });

  it("executes once the window has closed", () => {
    const v = view({pending: {id: ID, executableAt: 1_000_000n, executable: true}});
    expect(decide(v, policy)).toEqual({kind: "execute", id: ID});
  });

  it("abandons a closed proposal whose execution no longer simulates", () => {
    const v = view({pending: {id: ID, executableAt: 999_000n, executable: false}});
    expect(decide(v, policy)).toEqual({kind: "abandon", id: ID});
  });
});

describe("decide: nothing deployed", () => {
  it("proposes buying with the deployable float", () => {
    expect(decide(view(), policy)).toEqual({kind: "propose-buy", assets: ETH});
  });

  it("stays idle below the minimum trade size", () => {
    const v = view({float: ETH / 10_000n, totalAssets: ETH / 10_000n});
    expect(decide(v, policy)).toEqual({kind: "idle", reason: "deployable below minimum trade"});
  });

  it("stays idle when queued exits eat the float", () => {
    const v = view({queuedAssets: ETH});
    expect(decide(v, policy)).toEqual({kind: "idle", reason: "deployable below minimum trade"});
  });
});

describe("decide: capital is deployed", () => {
  const funding = {id: FUND, assets: ETH, executedAt: 900_000n};
  const holding = view({float: 0n, deployed: ETH, funding, holdings: {base: 0n, leg: 5000n * ETH}});

  it("holds the leg when nothing asks for an unwind", () => {
    expect(decide(holding, policy)).toEqual({kind: "idle", reason: "holding"});
  });

  it("sells the leg when the hold period has elapsed", () => {
    expect(decide(holding, {...policy, holdSeconds: 50_000n})).toEqual({
      kind: "propose-sell",
      amount: 5000n * ETH,
    });
  });

  it("keeps holding before the hold period elapses", () => {
    expect(decide(holding, {...policy, holdSeconds: 200_000n})).toEqual({kind: "idle", reason: "holding"});
  });

  it("sells the leg when queued exits exceed the float", () => {
    expect(decide({...holding, queuedAssets: ETH / 2n}, policy)).toEqual({
      kind: "propose-sell",
      amount: 5000n * ETH,
    });
  });

  it("sells the leg when an unwind is forced", () => {
    expect(decide(holding, {...policy, forceUnwind: true})).toEqual({
      kind: "propose-sell",
      amount: 5000n * ETH,
    });
  });

  it("stays idle after a forced unwind settles instead of buying again", () => {
    // Found rehearsing on a mainnet fork: the settled cycle went straight into a new buy.
    const flat = view(); // settled: 1 ETH back in the float, nothing deployed
    expect(decide(flat, policy).kind).toBe("propose-buy");
    expect(decide(flat, {...policy, forceUnwind: true})).toEqual({kind: "idle", reason: "force unwind: not opening a new position"});
  });

  it("returns base to the vault once the leg is sold", () => {
    const v = {...holding, sold: true, holdings: {base: ETH, leg: 0n}};
    expect(decide(v, policy)).toEqual({kind: "propose-return"});
  });

  it("does not sell twice: a speck of the leg sent in after the sell does not hold the return back", () => {
    // Anyone can send the strategy tokens. Selling again would cost a day's
    // veto window each time, for as long as someone kept sending.
    const v = {...holding, sold: true, holdings: {base: ETH, leg: 1n}};
    expect(decide(v, {...policy, forceUnwind: true})).toEqual({kind: "propose-return"});
  });

  it("settles as soon as a return has run, whatever was sent to the strategy since", () => {
    // Until settle the vault counts the returned assets twice, so nothing may
    // come between a return and its settle: not a stray wei of the base asset
    // (which used to mean another return, and another day), nor of the leg.
    const returned = (ETH * 11n) / 10n;
    const settle = {kind: "settle", id: FUND, returned};
    expect(decide({...holding, sold: true, holdings: {base: 1n, leg: 0n}, returned}, policy)).toEqual(settle);
    expect(decide({...holding, sold: true, holdings: {base: 0n, leg: 1n}, returned}, policy)).toEqual(settle);
    expect(decide({...holding, sold: true, holdings: {base: 1n, leg: 1n}, returned}, {...policy, forceUnwind: true})).toEqual(settle);
  });

  it("settles the funding proposal once the base is back in the vault", () => {
    const v = {...holding, holdings: {base: 0n, leg: 0n}, returned: (ETH * 11n) / 10n};
    expect(decide(v, policy)).toEqual({kind: "settle", id: FUND, returned: (ETH * 11n) / 10n});
  });

  it("refuses to settle without the returned amount", () => {
    const v = {...holding, holdings: {base: 0n, leg: 0n}, returned: null};
    expect(decide(v, policy)).toEqual({kind: "idle", reason: "returned amount unknown, not settling"});
  });

  it("refuses to settle without a funding proposal to book against", () => {
    const v = {...holding, funding: null, holdings: {base: 0n, leg: 0n}, returned: ETH};
    expect(decide(v, policy)).toEqual({kind: "idle", reason: "no executed funding proposal to settle"});
  });

  it("does not start a second funding while one is deployed", () => {
    // Float came back in through a deposit mid-cycle. Deploying it would add a
    // second funding proposal and break the one-settle-per-cycle accounting.
    expect(decide({...holding, float: ETH}, policy)).toEqual({kind: "idle", reason: "holding"});
  });
});
