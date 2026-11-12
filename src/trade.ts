import {encodeFunctionData, type Hex} from "viem";
import {strategyAbi} from "./abi.js";

/**
 * Turning a decision into calldata. Pure, like policy.ts: the quote comes in
 * from the caller, the floor and the bytes go out.
 */

export interface Floor {
  /** What the calldata states as the quote. The strategy allows `maxSlippageBps` below it. */
  quotedOut: bigint;
  /** The hard minimum the swap must return or revert. */
  minAmountOut: bigint;
}

const BPS = 10_000n;

/**
 * The floor a proposal commits to.
 *
 * A proposal executes a day after it is quoted, so the live quote cannot be the
 * floor: any move against us inside the veto window would make the fill
 * revert, and a memecoin moves. `toleranceBps` is how much of that move the
 * operator is prepared to eat. It is written into the calldata as the stated
 * quote, so a watcher reads exactly the price the agent is willing to take;
 * the strategy then enforces its own `maxSlippageBps` below that stated quote.
 */
export function tradeFloor(args: {quotedOut: bigint; toleranceBps: bigint; maxSlippageBps: bigint}): Floor {
  if (args.quotedOut <= 0n) throw new Error("Refusing to encode a trade against a zero quote.");
  const quotedOut = (args.quotedOut * (BPS - args.toleranceBps)) / BPS;
  const minAmountOut = (quotedOut * (BPS - args.maxSlippageBps)) / BPS;
  return {quotedOut, minAmountOut};
}

export function encodeBuy(token: Hex, amountIn: bigint, floor: Floor): Hex {
  return encodeFunctionData({
    abi: strategyAbi,
    functionName: "buy",
    args: [token, amountIn, floor.minAmountOut, floor.quotedOut],
  });
}

export function encodeSell(token: Hex, amountIn: bigint, floor: Floor): Hex {
  return encodeFunctionData({
    abi: strategyAbi,
    functionName: "sell",
    args: [token, amountIn, floor.minAmountOut, floor.quotedOut],
  });
}

export function encodeReturn(): Hex {
  return encodeFunctionData({abi: strategyAbi, functionName: "returnToVault"});
}

/** Shares still owed to the redemption queue. */
export function unclaimedShares(entries: ReadonlyArray<{shares: bigint; claimed: boolean}>): bigint {
  return entries.reduce((sum, e) => (e.claimed ? sum : sum + e.shares), 0n);
}
