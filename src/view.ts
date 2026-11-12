import {ContractFunctionExecutionError, type Hex} from "viem";
import {
  erc20Abi,
  governorExtraAbi,
  liquidatedEvent,
  proposalExecutedEvent,
  proposalPostedEvent,
  vaultQueueAbi,
  withdrawalClaimedEvent,
  withdrawalQueuedEvent,
} from "./abi.js";
import type {Context} from "./context.js";
import type {FundView} from "./policy.js";
import {applyExit, currentFunding, newestPending, proposalKind, returnedSince, soldSince, waitingShares, type ProposalRecord} from "./select.js";

/**
 * Reads the chain into a `FundView` for the policy. The governor's proposal
 * history is rebuilt from logs once and then extended incrementally, so a
 * one-minute poll does not rescan from the deploy block every time.
 */

const FINAL = new Set([2, 3, 5]); // Vetoed, Blocked, Settled: never change again

export class ChainView {
  private history: ProposalRecord[] = [];
  /** Every `Liquidated` the strategy has emitted: what each `returnToVault` sent back. */
  private liquidated: {blockNumber: bigint; amount: bigint}[] = [];
  /** Queued exits not yet claimed: request id to shares. */
  private queue = new Map<bigint, bigint>();
  private scannedTo: bigint | null = null;
  /** Proposals whose window closed with execute() reverting. Reported once, then skipped. */
  private abandoned = new Set<Hex>();

  constructor(private readonly ctx: Context) {}

  async read(): Promise<FundView> {
    const {publicClient, recurve} = this.ctx;
    const block = await publicClient.getBlock();
    const now = block.timestamp;

    await this.extendHistory(block.number);
    await this.refreshStates();

    const [snap, queuedAssets, holdings] = await Promise.all([
      recurve.vault.snapshot(),
      this.queuedAssets(),
      this.holdings(),
    ]);

    const funding = currentFunding(this.history);
    const returned = funding ? returnedSince(this.liquidated, funding.executedBlock) : null;
    const sold = funding ? soldSince(this.history, funding.executedBlock) : false;

    const head = newestPending(this.history, this.abandoned);
    let pending: FundView["pending"] = null;
    if (head) {
      // Only worth simulating once the window has closed; before that the
      // governor reverts with VetoWindowOpen no matter what.
      const executable = head.executableAt > now ? true : await this.executeSimulates(head.id);
      if (!executable) this.abandoned.add(head.id);
      pending = {...head, executable};
    }

    const stale = this.history.filter((p) => p.state === 1 && p.id !== head?.id && p.kind !== "other");
    if (stale.length > 0) {
      this.ctx.log(`warning: ${stale.length} older proposal(s) still Pending on the governor and ignored: ${stale.map((p) => p.id).join(", ")}`);
    }
    const foreign = this.history.filter((p) => p.state === 1 && p.kind === "other");
    if (foreign.length > 0) {
      this.ctx.log(`warning: ${foreign.length} Pending proposal(s) on the governor are not this runner's (another target, or a call it never makes) and are left alone: ${foreign.map((p) => p.id).join(", ")}`);
    }

    return {
      now,
      float: snap.float,
      deployed: snap.deployedAssets,
      totalAssets: snap.totalAssets,
      queuedAssets,
      pending,
      funding: funding ? {id: funding.id, assets: funding.assets, executedAt: funding.executedAt} : null,
      holdings,
      sold,
      returned,
    };
  }

  // ---------------------------------------------------------------- history

  /**
   * Reads the logs since the last round, in steps the RPC will answer. A step
   * is kept whole or not at all, and a step that was kept is never read again:
   * everything it needs from the chain is fetched first, and only then is any
   * of it added. A step added twice would count a return twice, and settle
   * would book the sum.
   */
  private async extendHistory(latest: bigint): Promise<void> {
    const {publicClient, cfg} = this.ctx;
    const from = this.scannedTo === null ? cfg.deployBlock : this.scannedTo + 1n;
    const chunk = cfg.logChunk;

    for (let start = from; start <= latest; start += chunk) {
      const end = start + chunk - 1n < latest ? start + chunk - 1n : latest;
      const [proposals, returns, exits] = await Promise.all([
        publicClient.getLogs({
          address: cfg.governor,
          events: [proposalPostedEvent, proposalExecutedEvent],
          fromBlock: start,
          toBlock: end,
          strict: true,
        }),
        // In the same bounded steps as the rest: a position can be held for
        // longer than the RPC will scan in one request.
        publicClient.getLogs({
          address: cfg.strategy,
          event: liquidatedEvent,
          fromBlock: start,
          toBlock: end,
          strict: true,
        }),
        publicClient.getLogs({
          address: cfg.vault,
          events: [withdrawalQueuedEvent, withdrawalClaimedEvent],
          fromBlock: start,
          toBlock: end,
          strict: true,
        }),
      ]);
      const executed = new Map<Hex, {block: bigint; at: bigint}>();
      for (const log of proposals) {
        if (log.eventName !== "ProposalExecuted") continue;
        const {timestamp} = await publicClient.getBlock({blockNumber: log.blockNumber});
        executed.set(log.args.proposalId, {block: log.blockNumber, at: timestamp});
      }

      // Nothing below asks the chain anything, so nothing below can fail halfway.
      for (const log of proposals) {
        if (log.eventName !== "ProposalPosted") continue;
        this.history.push({
          id: log.args.proposalId,
          // Until its calldata is read, in refreshStates, a proposal is nobody's.
          kind: "other",
          assets: log.args.assets,
          executableAt: log.args.executableAt,
          postedBlock: log.blockNumber,
          state: 1,
          executedAt: null,
          executedBlock: null,
        });
      }
      for (const p of this.history) {
        const done = executed.get(p.id);
        if (done && p.executedBlock === null) {
          p.executedBlock = done.block;
          p.executedAt = done.at;
        }
      }
      for (const log of returns) this.liquidated.push({blockNumber: log.blockNumber, amount: log.args.returnedToVault});
      for (const log of exits) {
        applyExit(
          this.queue,
          log.eventName === "WithdrawalQueued"
            ? {kind: "queued", requestId: log.args.requestId, shares: log.args.shares}
            : {kind: "claimed", requestId: log.args.requestId},
        );
      }
      this.scannedTo = end;
    }
  }

  /** Re-read every proposal that can still change: its state, and what it asks for. */
  private async refreshStates(): Promise<void> {
    const {publicClient, cfg} = this.ctx;
    const open = this.history.filter((p) => !FINAL.has(p.state));
    if (open.length === 0) return;
    const results = await publicClient.multicall({
      contracts: open.map((p) => ({
        address: cfg.governor,
        abi: governorExtraAbi,
        functionName: "proposals" as const,
        args: [p.id] as const,
      })),
      allowFailure: false,
    });
    open.forEach((p, i) => {
      const [target, , callData, , , , state] = results[i]!;
      p.state = Number(state);
      p.kind = proposalKind(target, callData, cfg.strategy, cfg.token);
    });
  }

  // ---------------------------------------------------------------- reads

  /**
   * What the queued exits are owed. The queue is kept from the vault's own
   * events, a request added when it is queued and dropped when it is claimed,
   * so a round reads only what is new: the queue itself only grows, anyone can
   * add to it, and reading it entry by entry would let them set how much work
   * a round is.
   */
  private async queuedAssets(): Promise<bigint> {
    const {publicClient, cfg} = this.ctx;
    const shares = waitingShares(this.queue);
    if (shares === 0n) return 0n;
    return publicClient.readContract({address: cfg.vault, abi: vaultQueueAbi, functionName: "previewRedeem", args: [shares]});
  }

  private async holdings(): Promise<{base: bigint; leg: bigint}> {
    const {publicClient, cfg, base} = this.ctx;
    const [b, l] = await publicClient.multicall({
      contracts: [
        {address: base.address, abi: erc20Abi, functionName: "balanceOf", args: [cfg.strategy]},
        {address: cfg.token, abi: erc20Abi, functionName: "balanceOf", args: [cfg.strategy]},
      ],
      allowFailure: false,
    });
    return {base: b, leg: l};
  }

  /**
   * Whether `execute` would go through right now. A revert is a stuck
   * proposal; anything else (an RPC that did not answer) is not a verdict,
   * and the round fails rather than abandoning a good proposal on a hiccup.
   */
  private async executeSimulates(id: Hex): Promise<boolean> {
    const {publicClient, cfg, account} = this.ctx;
    try {
      await publicClient.simulateContract({
        address: cfg.governor,
        abi: governorExtraAbi,
        functionName: "execute",
        args: [id],
        account,
      });
      return true;
    } catch (err) {
      if (!(err instanceof ContractFunctionExecutionError)) throw err;
      this.ctx.log(`execute(${id}) reverts: ${firstLine(err)}`);
      return false;
    }
  }
}

export function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0] ?? msg;
}
