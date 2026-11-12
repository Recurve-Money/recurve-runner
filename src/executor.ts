import {formatUnits, type Hex} from "viem";
import {erc20Abi, governorExtraAbi, quoterAbi} from "./abi.js";
import type {Context} from "./context.js";
import {settleFee, type Action, type FundView} from "./policy.js";
import {encodeBuy, encodeReturn, encodeSell, tradeFloor, type Floor} from "./trade.js";
import {firstLine} from "./view.js";

/**
 * Carries out what the policy decided. Every write is simulated first, and in
 * dry-run mode the simulation is all that happens.
 */
export async function perform(ctx: Context, view: FundView, action: Action): Promise<string> {
  switch (action.kind) {
    case "idle":
      return `idle: ${action.reason}`;

    case "wait":
      return `waiting on ${action.id}: ${action.secondsLeft}s left in its veto window`;

    case "abandon":
      return `ABANDONED ${action.id}: its veto window closed but execute() reverts; moving on without it`;

    case "execute":
      return execute(ctx, action.id);

    case "propose-buy": {
      const quote = await quote_(ctx, ctx.base.address, ctx.cfg.token, action.assets);
      const floor = floorFor(ctx, quote);
      const data = encodeBuy(ctx.cfg.token, action.assets, floor);
      const what = `buy ${fmt(action.assets, ctx.base)} -> ${ctx.leg.symbol}, quoted ${fmt(quote, ctx.leg)}, floor ${fmt(floor.minAmountOut, ctx.leg)}`;
      return propose(ctx, action.assets, data, what);
    }

    case "propose-sell": {
      const quote = await quote_(ctx, ctx.cfg.token, ctx.base.address, action.amount);
      const floor = floorFor(ctx, quote);
      const data = encodeSell(ctx.cfg.token, action.amount, floor);
      const what = `sell ${fmt(action.amount, ctx.leg)} -> ${ctx.base.symbol}, quoted ${fmt(quote, ctx.base)}, floor ${fmt(floor.minAmountOut, ctx.base)}`;
      return propose(ctx, 0n, data, what);
    }

    case "propose-return":
      return propose(ctx, 0n, encodeReturn(), "returnToVault");

    case "settle":
      return settle(ctx, view, action.id, action.returned);
  }
}

// ---------------------------------------------------------------- pieces

async function quote_(ctx: Context, tokenIn: Hex, tokenOut: Hex, amountIn: bigint): Promise<bigint> {
  const {result} = await ctx.publicClient.simulateContract({
    address: ctx.cfg.quoter,
    abi: quoterAbi,
    functionName: "quoteExactInputSingle",
    args: [{tokenIn, tokenOut, amountIn, fee: ctx.feeTier, sqrtPriceLimitX96: 0n}],
  });
  return result[0];
}

function floorFor(ctx: Context, quotedOut: bigint): Floor {
  return tradeFloor({
    quotedOut,
    toleranceBps: ctx.cfg.priceToleranceBps,
    maxSlippageBps: ctx.maxSlippageBps,
  });
}

async function propose(ctx: Context, assets: bigint, callData: Hex, what: string): Promise<string> {
  const {cfg, publicClient, account, recurve} = ctx;
  // The SDK simulates before sending too; this one is so a dry run has
  // something to report and a live run fails before spending gas.
  await publicClient.simulateContract({
    address: cfg.governor,
    abi: governorExtraAbi,
    functionName: "propose",
    args: [cfg.strategy, assets, callData],
    account,
  });
  if (cfg.dryRun) return `DRY RUN would propose ${what}`;
  const id = await recurve.agent.propose(cfg.strategy, assets, callData);
  return `proposed ${id}: ${what}`;
}

async function execute(ctx: Context, id: Hex): Promise<string> {
  if (ctx.cfg.dryRun) return `DRY RUN would execute ${id}`;
  const hash = await ctx.recurve.agent.execute(id);
  return `executed ${id} in ${hash}`;
}

/**
 * Settle books the returned amount into the vault and pulls the performance
 * fee — on profit only — from the agent's own wallet, so that wallet needs the
 * fee in the vault asset and an allowance to the governor before the call.
 */
async function settle(ctx: Context, view: FundView, id: Hex, returned: bigint): Promise<string> {
  const {cfg, publicClient, walletClient, account, recurve, base} = ctx;
  const funded = view.funding?.assets ?? 0n;
  const fee = settleFee(returned, funded, ctx.performanceFeeBps);
  const pnl = returned - funded;

  if (fee > 0n) {
    const [balance, allowance] = await publicClient.multicall({
      contracts: [
        {address: base.address, abi: erc20Abi, functionName: "balanceOf", args: [account]},
        {address: base.address, abi: erc20Abi, functionName: "allowance", args: [account, cfg.governor]},
      ],
      allowFailure: false,
    });
    if (balance < fee) {
      throw new Error(
        `settle needs the agent wallet to hold the performance fee: ${fmt(fee, base)} needed, ${fmt(balance, base)} held. ` +
          `Top up ${account} with ${base.symbol} and the runner will settle on its next round.`,
      );
    }
    if (allowance < fee) {
      if (cfg.dryRun) {
        return `DRY RUN would approve ${fmt(fee, base)} to the governor, then settle ${id} with returned=${fmt(returned, base)}`;
      }
      const hash = await walletClient.writeContract({
        address: base.address,
        abi: erc20Abi,
        functionName: "approve",
        args: [cfg.governor, fee],
      });
      await publicClient.waitForTransactionReceipt({hash});
      ctx.log(`approved ${fmt(fee, base)} performance fee to the governor in ${hash}`);
    }
  }

  try {
    await publicClient.simulateContract({
      address: cfg.governor,
      abi: governorExtraAbi,
      functionName: "settle",
      args: [id, returned],
      account,
    });
  } catch (err) {
    throw new Error(`settle(${id}, ${returned}) does not simulate: ${firstLine(err)}`);
  }

  const what = `settle ${id}: returned ${fmt(returned, base)} on ${fmt(funded, base)} funded (pnl ${pnl < 0n ? "-" : "+"}${fmt(pnl < 0n ? -pnl : pnl, base)}, fee ${fmt(fee, base)})`;
  if (cfg.dryRun) return `DRY RUN would ${what}`;
  const hash = await recurve.agent.settle(id, returned);
  return `${what} in ${hash}`;
}

function fmt(amount: bigint, token: {decimals: number; symbol: string}): string {
  return `${formatUnits(amount, token.decimals)} ${token.symbol}`;
}
