# recurve-runner

The agent for one Recurve fund. Proposes a position, executes it once the veto
window closes, unwinds it when the policy says so, and settles the result back
into the vault. Runs forever on a poll; every round reads the chain, decides
one action, carries it out.

## The cycle

Capital leaves the vault only through the governor, and every step below is a
proposal that has to clear its own veto window (24 hours on the current
deploy) and watcher review before it runs:

```
float ─propose buy──▶ leg held by the strategy
                         │  hold until HOLD_SECONDS, a queued exit the float
                         │  cannot pay, or FORCE_UNWIND
                         ▼
                      propose sell ──▶ base asset held by the strategy
                                          │
                                          ▼
                                       propose returnToVault ──▶ back in the vault
                                                                     │
                                                                     ▼
                                                                  settle(funding proposal, returned)
```

One funding per cycle. Float that arrives mid-cycle stays idle until the cycle
settles: the governor books one `settle` per deployment, and a second funding
would make its fee and PnL accounting wrong.

The runner keeps no state. Each round it rebuilds the picture from chain — the
governor's `ProposalPosted`/`ProposalExecuted` logs, each proposal's live
state, the strategy's balances, the strategy's `Liquidated` event — so a
restart mid-cycle picks up exactly where the chain is.

## Layout

```
src/policy.ts    the decision: FundView in, Action out. Pure, fully tested.
src/select.ts    which proposals matter, from the governor's history. Pure.
src/trade.ts     price floors and calldata. Pure.
src/config.ts    env parsing and validation, networks.
src/view.ts      reads the chain into a FundView (incremental log scan).
src/executor.ts  carries an Action out: quote, simulate, send.
src/boot.ts      startup checks against the chain.
src/health.ts    GET /health.
src/index.ts     the loop.
```

```bash
npm install
npm test          # policy, selection, trade maths, config
npm run typecheck
cp .env.example .env   # filled in; loaded from this folder on start, environment wins
npm start
```

## Configuration

| Variable | Required | What it is |
|---|---|---|
| `PRIVATE_KEY` | yes | The agent key. Must be an agent on the governor (`isAgent`), hold ETH for gas, and hold the vault asset for performance fees (see below). |
| `RECURVE_VAULT` | yes | The vault this runner operates. |
| `RECURVE_GOVERNOR` | yes | Its governor. |
| `RECURVE_REGISTRY` | yes | The watcher registry. |
| `RECURVE_STRATEGY` | yes | The fund's `PortfolioStrategyV2`. |
| `RECURVE_TOKEN` | yes | The one basket leg the strategy buys: $RECURVE on the testnet fund, NVDA (`0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`) for the mainnet strategy `DeployStrategyV2.s.sol` deploys. |
| `DEX_QUOTER` | yes | Uniswap V3 `QuoterV2` on the same deployment the strategy's router belongs to. |
| `RECURVE_CHAIN_ID` | | `4663` (mainnet, default) or `46630` (testnet). Anything else is refused. |
| `RECURVE_RPC_URL` | | Overrides the network's public endpoint. Must be the same chain. |
| `RECURVE_DEPLOY_BLOCK` | | Block the governor went up. Bounds the log scan; from genesis it takes minutes. |
| `LOG_CHUNK` | | Blocks per `eth_getLogs`. Default `100000`: since October 2026 both Robinhood RPCs refuse a wider range ("Invalid parameters"). |
| `MIN_TRADE` | | Smallest funding worth a proposal, in whole units of the vault asset. Default `0.001`. |
| `RESERVE_BPS` | | Share of total assets kept idle so small exits clear instantly. Default `1000` (10%). |
| `HOLD_SECONDS` | | Unwind this long after the funding executes. Unset holds until exits or `FORCE_UNWIND` demand it. |
| `PRICE_TOLERANCE_BPS` | | How far the price may move between proposing and executing. Default `300`. See below. |
| `FORCE_UNWIND` | | `true` sells the leg, returns and settles, then stays idle. Operator kill switch for the position. |
| `PAUSED` | | `true` reads and reports, never acts. Operator kill switch for the runner. |
| `DRY_RUN` | | `true` simulates every action and logs what it would do; nothing is sent. |
| `RUNNER_INTERVAL_MS` | | Poll interval. Default `60000`. Rounds are reads; a proposal only goes out when the policy says. |
| `PORT` | | `/health` port. Railway sets it. Default `8080`. |

The pool fee tier, the strategy's slippage cap and the governor's performance
fee are read from the contracts, not configured, so they cannot disagree.

### The price floor

A proposal is quoted when it is posted and executed a day later. The live
quote cannot be the floor — any move against the fund inside the window would
revert the fill — so the calldata states `quote × (1 − PRICE_TOLERANCE_BPS)`
as its quote, and the strategy then enforces its own `maxSlippageBps` (3% on
the current deploy) below that. With the defaults a buy executes at anything
within ~6% of the price at proposal time. That is the number a watcher sees
in the calldata, and the number an operator should set deliberately: wider
survives a volatile day, narrower gives a sandwich less room.

If the price has moved past the floor by the time the window closes,
`execute` reverts, the round logs `ABANDONED`, and the runner proposes again
at a fresh quote. The old proposal stays `Pending` on the governor forever;
nothing can execute it but an agent key, and this one never will.

### The performance fee comes out of the agent's wallet

`RecurveGovernor.settle` pulls the performance fee (5% of profit on the
current deploy) from `msg.sender` — the agent — not from the vault. Before
settling a profitable cycle the runner checks the wallet holds the fee in the
vault asset and approves exactly that amount to the governor. If the balance
is short it logs the exact amount needed and retries next round; the position
is already back in the vault by then, so nothing is at risk while it waits.

## Operating it

`GET /health` answers with the last round: what it decided, when, and the
last error if any. It returns 503 after three failed rounds in a row, which is
what Railway's healthcheck is pointed at.

Every write is simulated before it is sent. Start any new deployment with
`DRY_RUN=true` and read a few rounds of log before removing it.

Boot refuses to start, with the reason on the first line, if: the RPC is not
the configured chain; the governor, vault and strategy do not reference each
other; the token is not in the strategy's basket; the key is not an agent;
the quoter cannot price the strategy's pool; or the wallet has no ETH.

## Addresses

Testnet (46630), the testnet fund: from
[recurve-protocol `addresses/46630.json`](https://github.com/Recurve-Money/recurve-protocol/blob/main/addresses/46630.json)
and [recurve-dex `addresses/46630.json`](https://github.com/Recurve-Money/recurve-dex/blob/main/addresses/46630.json).
`DEX_QUOTER=0x2691988858D1CA6176D67575Ad4d388BA2664fcA`, deploy block `103992284`.

Mainnet (4663): no Recurve contract yet. The official Uniswap V3 deployment
([Uniswap docs](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments)),
checked on chain 2026-09-17 — the factory matches the live WETH/NVDA pool and
the quoter prices it:

| Contract | Address |
|---|---|
| `UniswapV3Factory` | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| `SwapRouter02` (the strategy's `DEX_ROUTER`) | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| `QuoterV2` (`DEX_QUOTER`) | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |

The strategy must be deployed against `SwapRouter02` and a pool must exist
for base/$RECURVE on the fee tier the strategy is constructed with, or the
quoter check at boot fails.

## Deploy

It is one Node process: `npm ci && npm start` wherever Node 20 or later runs,
with the variables above in its environment. `railway.json` is there for
Railway, which rebuilds on a push to `main`. Set every required variable
first, and `RECURVE_CHAIN_ID` explicitly — the default is mainnet.
