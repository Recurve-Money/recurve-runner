import {ContractFunctionExecutionError, type Hex} from "viem";
import {erc20Abi, governorExtraAbi, liquidatedEvent, proposalExecutedEvent, proposalPostedEvent, vaultQueueAbi} from "./abi.js";
import type {Context} from "./context.js";
import type {FundView} from "./policy.js";
import {currentFunding, newestPending, proposalKind, returnedSince, soldSince, type ProposalRecord} from "./select.js";

/**
 * Reads the chain into a `FundView` for the policy. The governor's proposal
 * history is rebuilt from logs once and then extended incrementally, so a
 * one-minute poll does not rescan from the deploy block every time.
 */

const FINAL = new Set([2, 3, 5]); // Vetoed, Blocked, Settled: never change again

export class ChainView {
  private history: ProposalRecord[] = [];
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
    const returned = funding ? await this.returned(funding.executedBlock, block.number) : null;
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

  private async extendHistory(latest: bigint): Promise<void> {
    const {publicClient, cfg} = this.ctx;
    const from = this.scannedTo === null ? cfg.deployBlock : this.scannedTo + 1n;
    if (from > latest) return;

    const chunk = cfg.logChunk;
    const executed = new Map<Hex, bigint>();
    for (let start = from; start <= latest; start += chunk) {
      const end = start + chunk - 1n < latest ? start + chunk - 1n : latest;
      const [posted, done] = await Promise.all([
        publicClient.getLogs({
          address: cfg.governor,
          event: proposalPostedEvent,
          fromBlock: start,
          toBlock: end,
          strict: true,
        }),
        publicClient.getLogs({
          address: cfg.governor,
          event: proposalExecutedEvent,
          fromBlock: start,
          toBlock: end,
          strict: true,
        }),
      ]);
      for (const log of posted) {
        this.history.push({
          id: log.args.proposalId,
          // Until its calldata is read, just below, a proposal is nobody's.
          kind: "other",
          assets: log.args.assets,
          executableAt: log.args.executableAt,
          postedBlock: log.blockNumber,
          state: 1,
          executedAt: null,
          executedBlock: null,
        });
      }
      for (const log of done) executed.set(log.args.proposalId, log.blockNumber);
    }

    for (const p of this.history) {
      const at = executed.get(p.id);
      if (at !== undefined && p.executedBlock === null) {
        p.executedBlock = at;
        p.executedAt = (await publicClient.getBlock({blockNumber: at})).timestamp;
      }
    }
    this.scannedTo = latest;
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
      p.kind = proposalKind(target, callData, cfg.strategy);
    });
  }

  // ---------------------------------------------------------------- reads

  /**
   * What the queued exits are owed. The vault holds the shares of every queued
   * exit itself until the exit is claimed, so its own share balance is the
   * whole queue in one read, however many requests there are: the queue only
   * grows, and anyone can add to it. Shares sent to the vault by mistake count
   * as well, which only keeps a little more of the float idle.
   */
  private async queuedAssets(): Promise<bigint> {
    const {publicClient, cfg} = this.ctx;
    const shares = await publicClient.readContract({address: cfg.vault, abi: erc20Abi, functionName: "balanceOf", args: [cfg.vault]});
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

  private async returned(fundingBlock: bigint, latest: bigint): Promise<bigint | null> {
    const {publicClient, cfg} = this.ctx;
    const logs = await publicClient.getLogs({
      address: cfg.strategy,
      event: liquidatedEvent,
      fromBlock: fundingBlock,
      toBlock: latest,
      strict: true,
    });
    return returnedSince(
      logs.map((l) => ({blockNumber: l.blockNumber, amount: l.args.returnedToVault})),
      fundingBlock,
    );
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
