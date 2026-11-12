import {decodeFunctionData, getAddress} from "viem";
import {describe, expect, it} from "vitest";
import {strategyAbi} from "./abi.js";
import {encodeBuy, encodeReturn, encodeSell, tradeFloor} from "./trade.js";

const TOKEN = getAddress("0x" + "e".repeat(40));

describe("tradeFloor", () => {
  it("writes the tolerance into the quote and the strategy's slippage into the minimum", () => {
    expect(tradeFloor({quotedOut: 1000n, toleranceBps: 300n, maxSlippageBps: 300n})).toEqual({
      quotedOut: 970n,
      minAmountOut: 940n,
    });
  });

  it("keeps the live quote when the tolerance is zero", () => {
    expect(tradeFloor({quotedOut: 1000n, toleranceBps: 0n, maxSlippageBps: 300n})).toEqual({
      quotedOut: 1000n,
      minAmountOut: 970n,
    });
  });

  it("refuses a zero quote rather than encoding an unbounded trade", () => {
    expect(() => tradeFloor({quotedOut: 0n, toleranceBps: 300n, maxSlippageBps: 300n})).toThrow(/quote/);
  });
});

describe("calldata", () => {
  it("encodes buy with the floor the strategy will check", () => {
    const data = encodeBuy(TOKEN as `0x${string}`, 5n, {quotedOut: 970n, minAmountOut: 940n});
    expect(decodeFunctionData({abi: strategyAbi, data})).toEqual({
      functionName: "buy",
      args: [TOKEN, 5n, 940n, 970n],
    });
  });

  it("encodes sell the same way", () => {
    const data = encodeSell(TOKEN as `0x${string}`, 7n, {quotedOut: 100n, minAmountOut: 97n});
    expect(decodeFunctionData({abi: strategyAbi, data})).toEqual({
      functionName: "sell",
      args: [TOKEN, 7n, 97n, 100n],
    });
  });

  it("encodes returnToVault with no arguments", () => {
    expect(decodeFunctionData({abi: strategyAbi, data: encodeReturn()})).toEqual({
      functionName: "returnToVault",
      args: undefined,
    });
  });
});
