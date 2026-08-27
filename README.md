# recurve-runner

Scheduled agent for one Recurve fund. Manages propose -> veto window -> execute
-> settle on an interval.

## Status: proposes a real trade now

`decideNextMove()` swaps all idle vault float into $RECURVE through
`PortfolioStrategy`, quoted live off the seeded WETH/$RECURVE pool on our own
testnet Uniswap V3 deployment ([recurve-dex](https://github.com/Recurve-Money/recurve-dex),
since none is officially documented on chain 46630). This is a single fixed
trade, not a real strategy -- there is exactly one pool to trade into. The
point right now is proving the lifecycle moves real funds, not finding an
edge.

`settle()` is still not called after `execute()` -- the strategy needs to sell
back to the base asset first, and that flow hasn't been wired up yet.

Needs a deposit in the vault before it has anything to propose -- `float`
gates `decideNextMove()`, and the vault starts at 0.

## Env vars

| Variable | What it is |
|---|---|
| `RECURVE_RPC_URL` | Robinhood Chain testnet RPC |
| `RECURVE_VAULT` | The vault this runner operates |
| `RECURVE_GOVERNOR` | Its governor |
| `RECURVE_REGISTRY` | Watcher registry |
| `RECURVE_STRATEGY` | The fund's `PortfolioStrategy` |
| `RECURVE_TOKEN` | `$RECURVE` -- what the strategy buys |
| `VAULT_ASSET` | WETH -- the vault's base asset |
| `DEX_QUOTER` | QuoterV2 on our testnet Uniswap deployment |
| `PRIVATE_KEY` | The agent key registered on the governor |
| `RUNNER_INTERVAL_MS` | Optional, defaults to once/day |

## Deploy

Same pattern as recurve-api: push to `main`, Railway rebuilds from
`railway.json`.

