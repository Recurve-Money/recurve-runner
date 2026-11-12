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
  /** How many exits the logs have shown being queued, claimed or not. */
  private requests = 0n;
  private scannedTo: bigint | null = null;
  /** The last head the scan reached, and its hash: the check that the chain read is still the chain. */
  private checkpoint: {number: bigint; hash: Hex} | null = null;
  /** Proposals whose window closed with execute() reverting. Reported once, then skipped. */
  private abandoned = new Set<Hex>();

  constructor(private readonly ctx: Context) {}

  async read(): Promise<FundView> {
    const {publicClient, recurve} = this.ctx;
    const block = await publicClient.getBlock();
    const now = block.timestamp;

    // Everything below is remembered from earlier rounds. If the block the last
    // round ended on has been replaced, so may anything read before it: drop
    // it all and read the history again.
    if (this.checkpoint) {
      const then = await publicClient.getBlock({blockNumber: this.checkpoint.number});
      if (then.hash !== this.checkpoint.hash) {
        this.ctx.log(`block ${this.checkpoint.number} is not the block this runner read: the chain was reorganised. Reading the history again from block ${this.ctx.cfg.deployBlock}.`);
        this.forget();
      }
    }

    // To the head: a proposal this runner posted last round has to be in the
    // history this round, or it would post the same step again. Robinhood
    // Chain makes a block only when there is a transaction, so "a few blocks
    // behind" can mean minutes. A replaced block is caught by the check above
    // on the next round.
    await this.extendHistory(block.number);
    if (this.scannedTo === block.number && block.hash) this.checkpoint = {number: block.number, hash: block.hash};
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

  /** Drops everything read from logs. The next round starts from the deploy block. */
  private forget(): void {
    this.history = [];
    this.liquidated = [];
    this.queue.clear();
    this.requests = 0n;
    this.scannedTo = null;
    this.checkpoint = null;
    // `abandoned` stays. It is what this runner decided, not what the logs said.
    // A proposal's id is a hash of its calldata and its time, so the same id
    // after a reorganisation is the same stale price, and still not revived; an
    // id that never comes back is simply never seen again.
  }

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
        if (log.eventName === "WithdrawalQueued") this.requests += 1n;
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
   *
   * The events are checked against the chain every round. The vault numbers
   * its requests from zero and never removes one, so its queue is exactly as
   * long as the number of requests the logs have shown, read at the same
   * block. If it is longer, the logs are incomplete (a deploy block set too
   * late, an RPC that drops logs) and exits are waiting that the runner cannot
   * see: the round fails rather than trade as if they were not there.
   */
  private async queuedAssets(): Promise<bigint> {
    const {publicClient, cfg} = this.ctx;
    // At the block the logs were read to, so the two counts describe the same
    // chain. An RPC that has fallen behind that block cannot answer, and the
    // round fails and is tried again, rather than seeing a shorter queue.
    const at = this.scannedTo ?? cfg.deployBlock;
    const length = await publicClient.readContract({address: cfg.vault, abi: vaultQueueAbi, functionName: "queueLength", blockNumber: at});
    if (length > this.requests) {
      throw new Error(
        `The vault's exit queue holds ${length} request(s) at block ${at} but the logs since block ${cfg.deployBlock} show ${this.requests}. ` +
          `RECURVE_DEPLOY_BLOCK is later than the vault's deploy, or the RPC is not returning every log; not acting on an incomplete queue.`,
      );
    }
    if (length < this.requests) {
      // The logs showed requests the chain no longer has: blocks this process
      // read were replaced. Nothing it remembers can be trusted, so it forgets
      // all of it and the next round reads the history again from the start.
      const seen = this.requests;
      this.forget();
      throw new Error(
        `The logs showed ${seen} exit request(s) but the vault holds ${length} at block ${at}: the chain was reorganised under this runner. ` +
          `Its history is dropped and rebuilt from block ${cfg.deployBlock} on the next round.`,
      );
    }
    const shares = waitingShares(this.queue);
    if (shares === 0n) return 0n;
    // The price at the same block as the count, so both describe one chain.
    return publicClient.readContract({address: cfg.vault, abi: vaultQueueAbi, functionName: "previewRedeem", args: [shares], blockNumber: at});
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
