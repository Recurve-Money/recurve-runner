# recurve-runner

Scheduled agent for one Recurve fund. Manages propose -> veto window -> execute
-> settle on an interval.

## Status: lifecycle works, strategy does not yet

`decideNextMove()` in `src/index.ts` currently returns `null` always, so the
runner deploys, connects, reads the vault, and logs -- but never proposes
anything. That is intentional, not a bug: proposing a real trade needs
`PortfolioStrategy` deployed for this vault, which needs a Uniswap V3
SwapRouter + QuoterV2 address on Robinhood Chain testnet (46630), which is not
yet confirmed to exist (only the mainnet, 4663, deployment is documented).

Everything else -- reading the vault snapshot, proposing, waiting out the real
veto window, checking proposal state, executing -- is real and uses
`@recurvemoney/sdk`.

## Env vars

| Variable | What it is |
|---|---|
| `RECURVE_RPC_URL` | Robinhood Chain testnet RPC |
| `RECURVE_VAULT` | The vault this runner operates |
| `RECURVE_GOVERNOR` | Its governor |
| `RECURVE_REGISTRY` | Watcher registry |
| `PRIVATE_KEY` | The agent key registered on the governor |
| `RUNNER_INTERVAL_MS` | Optional, defaults to once/day |

## Deploy

Same pattern as recurve-api: push to `main`, Railway rebuilds from
`railway.json`.
