import {describe, expect, it} from "vitest";
import type {Hex} from "viem";
import type {Context} from "./context.js";
import {encodeBuy, encodeReturn, encodeSell} from "./trade.js";
import {ChainView} from "./view.js";

/**
 * ChainView against a chain that exists only in this file: one full cycle
 * (buy, sell, return) and two queued exits, one of them claimed, spread over
 * 250 blocks that the view reads in steps of 100.
 */

const GOVERNOR = "0x00000000000000000000000000000000000000a1" as const;
const VAULT = "0x00000000000000000000000000000000000000a2" as const;
const STRATEGY = "0x00000000000000000000000000000000000000a3" as const;
const TOKEN = "0x00000000000000000000000000000000000000a4" as const;
const BASE = "0x00000000000000000000000000000000000000a5" as const;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const floor = {quotedOut: 2n, minAmountOut: 1n};

const PROPOSALS: Record<Hex, {assets: bigint; callData: Hex; state: number}> = {
  [id(1)]: {assets: 100n, callData: encodeBuy(TOKEN, 100n, floor), state: 4},
  [id(2)]: {assets: 0n, callData: encodeSell(TOKEN, 50n, floor), state: 4},
  [id(3)]: {assets: 0n, callData: encodeReturn(), state: 4},
};

const LOGS = [
  {address: GOVERNOR, blockNumber: 10n, eventName: "ProposalPosted", args: {proposalId: id(1), assets: 100n, executableAt: 15n}},
  {address: VAULT, blockNumber: 15n, eventName: "WithdrawalQueued", args: {requestId: 0n, shares: 7n}},
  {address: GOVERNOR, blockNumber: 20n, eventName: "ProposalExecuted", args: {proposalId: id(1)}},
  {address: VAULT, blockNumber: 25n, eventName: "WithdrawalQueued", args: {requestId: 1n, shares: 3n}},
  {address: GOVERNOR, blockNumber: 30n, eventName: "ProposalPosted", args: {proposalId: id(2), assets: 0n, executableAt: 35n}},
  {address: GOVERNOR, blockNumber: 40n, eventName: "ProposalExecuted", args: {proposalId: id(2)}},
  {address: GOVERNOR, blockNumber: 50n, eventName: "ProposalPosted", args: {proposalId: id(3), assets: 0n, executableAt: 55n}},
  {address: GOVERNOR, blockNumber: 60n, eventName: "ProposalExecuted", args: {proposalId: id(3)}},
  {address: STRATEGY, blockNumber: 60n, eventName: "Liquidated", args: {returnedToVault: 110n}},
  {address: VAULT, blockNumber: 150n, eventName: "WithdrawalClaimed", args: {requestId: 0n}},
];

/** A chain whose log requests can be told to fail: `failing(call)` is asked before each one. */
function chain(failing: (call: {address: string; fromBlock: bigint}) => boolean = () => false, queueLength = 2n) {
  const asked: {address: string; fromBlock: bigint; toBlock: bigint}[] = [];
  const publicClient = {
    getBlock: async (args?: {blockNumber: bigint}) =>
      args ? {number: args.blockNumber, timestamp: 1000n + args.blockNumber} : {number: 250n, timestamp: 5000n},
    getLogs: async ({address, fromBlock, toBlock}: {address: string; fromBlock: bigint; toBlock: bigint}) => {
      asked.push({address, fromBlock, toBlock});
      if (failing({address, fromBlock})) throw new Error("the RPC did not answer");
      return LOGS.filter((l) => l.address === address && l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    multicall: async ({contracts}: {contracts: {functionName: string; args: [Hex]}[]}) =>
      contracts.map((c) => {
        if (c.functionName !== "proposals") return 0n; // the strategy holds nothing: the cycle has returned
        const p = PROPOSALS[c.args[0]]!;
        return [STRATEGY, p.assets, p.callData, 0n, 0n, 0n, p.state];
      }),
    readContract: async ({functionName, args}: {functionName: string; args: [bigint]}) =>
      functionName === "queueLength" ? queueLength : args[0] * 2n, // previewRedeem: two assets a share
    simulateContract: async () => ({}),
  };
  const ctx = {
    cfg: {governor: GOVERNOR, vault: VAULT, strategy: STRATEGY, token: TOKEN, deployBlock: 0n, logChunk: 100n},
    publicClient,
    recurve: {vault: {snapshot: async () => ({float: 0n, deployedAssets: 100n, totalAssets: 100n})}},
    account: "0x00000000000000000000000000000000000000a6",
    base: {address: BASE, decimals: 18, symbol: "BASE"},
    log: () => {},
  } as unknown as Context;
  return {view: new ChainView(ctx), asked};
}

describe("ChainView", () => {
  it("reads a finished cycle: the funding, that it was sold, what came back, and who still waits", async () => {
    const {view} = chain();
    const fund = await view.read();
    expect(fund.funding).toEqual({id: id(1), assets: 100n, executedAt: 1020n});
    expect(fund.sold).toBe(true);
    expect(fund.returned).toBe(110n);
    expect(fund.pending).toBeNull();
    // Request 0 was claimed, so only request 1's three shares wait: six assets.
    expect(fund.queuedAssets).toBe(6n);
  });

  it("reads each step of the history once, however many rounds follow", async () => {
    const {view, asked} = chain();
    await view.read();
    const first = asked.length;
    await view.read();
    expect(asked.slice(first)).toEqual([]); // the head has not moved: nothing new to ask
  });

  it("sees a proposal posted in the head block, so it never posts the same step twice", async () => {
    // The chain makes a block only when there is a transaction: the runner's
    // own proposal can be the newest block for minutes.
    LOGS.push({address: GOVERNOR, blockNumber: 250n, eventName: "ProposalPosted", args: {proposalId: id(4), assets: 0n, executableAt: 9999n}});
    PROPOSALS[id(4)] = {assets: 0n, callData: encodeSell(TOKEN, 50n, floor), state: 1};
    try {
      const {view} = chain();
      const fund = await view.read();
      expect(fund.pending).toEqual({id: id(4), executableAt: 9999n, executable: true});
    } finally {
      LOGS.pop();
      delete PROPOSALS[id(4)];
    }
  });

  it("forgets its history when the chain no longer has what the logs showed, and reads it again", async () => {
    let reads = 0;
    const {view} = chain(() => false, 2n);
    const client = (view as unknown as {ctx: Context}).ctx.publicClient as unknown as {
      readContract: (a: {functionName: string; args: [bigint]}) => Promise<bigint>;
    };
    const plain = client.readContract;
    // The vault says one request the first time it is asked: one of the two in the logs is gone.
    client.readContract = async (a) => (a.functionName === "queueLength" && reads++ === 0 ? 1n : plain(a));
    await expect(view.read()).rejects.toThrow("reorganised");
    const fund = await view.read();
    expect(fund.returned).toBe(110n);
    expect(fund.queuedAssets).toBe(6n);
  });

  it("refuses to act when the vault's queue is longer than the logs account for", async () => {
    // Two requests are in the logs. A vault that says three has an exit the
    // runner never saw: its float is not free, whatever the logs suggest.
    const {view} = chain(() => false, 3n);
    await expect(view.read()).rejects.toThrow("holds 3 request(s)");
  });

  it("counts a return once when a later step fails and the round is run again", async () => {
    // The return is in the first step. The second step fails once, after the
    // first has been read: a retry that read the first step again would add
    // the return a second time, and settle would book 220.
    let failed = false;
    const {view} = chain(({address, fromBlock}) => {
      if (failed || address !== VAULT || fromBlock !== 100n) return false;
      failed = true;
      return true;
    });
    await expect(view.read()).rejects.toThrow("the RPC did not answer");
    const fund = await view.read();
    expect(fund.returned).toBe(110n);
    expect(fund.queuedAssets).toBe(6n);
    expect(fund.funding?.id).toBe(id(1));
  });
});
