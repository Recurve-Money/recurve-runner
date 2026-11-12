/**
 * Recurve fund runner. The agent for one fund: proposes a position, executes
 * it once the veto window closes, unwinds it when the policy says so, and
 * settles the result back into the vault.
 *
 * The cycle, each step a proposal that clears its own veto window:
 *
 *   float -> buy leg -> hold -> sell leg -> returnToVault -> settle
 *
 * Nothing here decides anything: policy.ts does, from a `FundView` that
 * view.ts reads off chain, and executor.ts carries the decision out. Boot
 * checks below refuse to start against a chain, a governor or a strategy
 * that does not match the configuration — this process signs with a hot key.
 */
import {existsSync} from "node:fs";
import {boot, log} from "./boot.js";
import {loadConfig} from "./config.js";
import {perform} from "./executor.js";
import {serveStatus, withoutUrlSecrets, type Status} from "./health.js";
import {decide} from "./policy.js";
import {ChainView} from "./view.js";

/** Long enough for the RPC to serve the block the execution landed in. */
const AFTER_EXECUTE_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- loop

async function main(): Promise<void> {
  // A .env beside package.json is for local runs; Railway injects variables
  // directly. Values already in the environment win over the file.
  if (existsSync(".env")) process.loadEnvFile(".env");
  const cfg = loadConfig(process.env);
  const ctx = await boot(cfg);
  const {policy} = cfg;

  log(`${cfg.dryRun ? "DRY RUN on" : "live on"} ${cfg.network.name} (${cfg.network.id}) as ${ctx.account}`);
  log(`vault ${cfg.vault} (${ctx.base.symbol}), strategy ${cfg.strategy} trading ${ctx.leg.symbol} on tier ${ctx.feeTier}`);
  log(
    `policy: minTrade=${cfg.minTrade} ${ctx.base.symbol}, reserve=${policy.reserveBps}bps, hold=${policy.holdSeconds === null ? "until exits or FORCE_UNWIND" : `${policy.holdSeconds}s`}, ` +
      `priceTolerance=${cfg.priceToleranceBps}bps + strategy slippage ${ctx.maxSlippageBps}bps, perfFee=${ctx.performanceFeeBps}bps` +
      (policy.forceUnwind ? ", FORCE_UNWIND" : "") +
      (policy.paused ? ", PAUSED" : ""),
  );

  const status: Status = {
    ok: true,
    chainId: cfg.network.id,
    account: ctx.account,
    vault: cfg.vault,
    dryRun: cfg.dryRun,
    paused: policy.paused,
    startedAt: new Date().toISOString(),
    rounds: 0,
    lastRoundAt: null,
    lastAction: null,
    lastError: null,
    failing: 0,
  };
  const server = serveStatus(cfg.healthPort, () => status);
  log(`status on :${cfg.healthPort}/health, polling every ${cfg.intervalMs}ms`);

  const view = new ChainView(ctx);
  let stopping = false;
  const stop = () => {
    if (!stopping) log("stopping after this round");
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (!stopping) {
    status.rounds += 1;
    // After a proposal executes the next step is often due at once, and one
    // of them cannot wait: until a return is settled the vault counts the
    // returned assets twice. So the round after an execution follows in
    // seconds, not after the usual interval.
    let executed = false;
    try {
      const fund = await view.read();
      const action = decide(fund, policy);
      const outcome = await perform(ctx, fund, action);
      executed = action.kind === "execute" && !cfg.dryRun;
      log(
        `float=${fund.float} deployed=${fund.deployed} queued=${fund.queuedAssets} leg=${fund.holdings.leg} base=${fund.holdings.base} -> ${outcome}`,
      );
      status.ok = true;
      status.failing = 0;
      status.lastAction = outcome;
      status.lastError = null;
    } catch (err) {
      // One bad round must not take the process down — Railway would restart
      // it into the same error — but three in a row is a real problem, and
      // /health says so.
      status.failing += 1;
      status.ok = status.failing < 3;
      status.lastError = withoutUrlSecrets(err instanceof Error ? err.message : String(err));
      console.error(`${new Date().toISOString()} [runner] round failed (${status.failing} in a row):`, err);
    }
    status.lastRoundAt = new Date().toISOString();

    // Back off while failing so a dead RPC is not hammered every minute.
    const wait = executed ? AFTER_EXECUTE_MS : Math.min(cfg.intervalMs * 2 ** Math.min(status.failing, 4), 10 * 60 * 1000);
    for (let waited = 0; waited < wait && !stopping; waited += 1000) await sleep(1000);
  }

  server.close();
}

main().catch((err) => {
  console.error(`${new Date().toISOString()} [runner] refusing to start:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
