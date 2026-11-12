import {parseAbiItem} from "viem";

/**
 * ABI fragments the SDK does not export. Governor and vault basics come from
 * `@recurvemoney/sdk`; everything here is what the runner needs beyond them.
 */

/** PortfolioStrategyV2: the only surface the agent can propose against. */
export const strategyAbi = [
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [
      {name: "token", type: "address"},
      {name: "amountIn", type: "uint256"},
      {name: "minAmountOut", type: "uint256"},
      {name: "quotedOut", type: "uint256"},
    ],
    outputs: [{name: "amountOut", type: "uint256"}],
  },
  {
    type: "function",
    name: "sell",
    stateMutability: "nonpayable",
    inputs: [
      {name: "token", type: "address"},
      {name: "amountIn", type: "uint256"},
      {name: "minAmountOut", type: "uint256"},
      {name: "quotedOut", type: "uint256"},
    ],
    outputs: [{name: "amountOut", type: "uint256"}],
  },
  {
    type: "function",
    name: "returnToVault",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{name: "amount", type: "uint256"}],
  },
  {type: "function", name: "vault", stateMutability: "view", inputs: [], outputs: [{type: "address"}]},
  {type: "function", name: "governor", stateMutability: "view", inputs: [], outputs: [{type: "address"}]},
  {type: "function", name: "baseAsset", stateMutability: "view", inputs: [], outputs: [{type: "address"}]},
  {type: "function", name: "maxSlippageBps", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
  {
    type: "function",
    name: "isAllowed",
    stateMutability: "view",
    inputs: [{type: "address"}],
    outputs: [{type: "bool"}],
  },
  {
    type: "function",
    name: "feeTier",
    stateMutability: "view",
    inputs: [{type: "address"}],
    outputs: [{type: "uint24"}],
  },
  {
    type: "event",
    name: "Liquidated",
    inputs: [{name: "returnedToVault", type: "uint256", indexed: false}],
  },
] as const;

/** Governor reads the SDK leaves out. */
export const governorExtraAbi = [
  {
    type: "function",
    name: "isAgent",
    stateMutability: "view",
    inputs: [{type: "address"}],
    outputs: [{type: "bool"}],
  },
  {type: "function", name: "watcherBlockThreshold", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
  {type: "function", name: "performanceFeeBps", stateMutability: "view", inputs: [], outputs: [{type: "uint256"}]},
  {type: "function", name: "feeRecipient", stateMutability: "view", inputs: [], outputs: [{type: "address"}]},
  {type: "function", name: "vault", stateMutability: "view", inputs: [], outputs: [{type: "address"}]},
  {
    type: "function",
    name: "proposals",
    stateMutability: "view",
    inputs: [{type: "bytes32"}],
    outputs: [
      {name: "target", type: "address"},
      {name: "assets", type: "uint256"},
      {name: "callData", type: "bytes"},
      {name: "postedAt", type: "uint256"},
      {name: "snapshot", type: "uint256"},
      {name: "vetoWeight", type: "uint256"},
      {name: "state", type: "uint8"},
    ],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [{type: "bytes32"}],
    outputs: [],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [{type: "bytes32"}, {type: "uint256"}],
    outputs: [],
  },
  {
    type: "function",
    name: "propose",
    stateMutability: "nonpayable",
    inputs: [{type: "address"}, {type: "uint256"}, {type: "bytes"}],
    outputs: [{type: "bytes32"}],
  },
  {
    type: "event",
    name: "ProposalPosted",
    inputs: [
      {name: "proposalId", type: "bytes32", indexed: true},
      {name: "target", type: "address", indexed: true},
      {name: "assets", type: "uint256", indexed: false},
      {name: "executableAt", type: "uint256", indexed: false},
    ],
  },
  {
    type: "event",
    name: "ProposalExecuted",
    inputs: [
      {name: "proposalId", type: "bytes32", indexed: true},
      {name: "target", type: "address", indexed: true},
      {name: "assets", type: "uint256", indexed: false},
    ],
  },
] as const;

/** Vault reads the SDK does not expose. */
export const vaultQueueAbi = [
  {
    type: "function",
    name: "previewRedeem",
    stateMutability: "view",
    inputs: [{type: "uint256"}],
    outputs: [{type: "uint256"}],
  },
  {type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{type: "address"}]},
  {type: "function", name: "governor", stateMutability: "view", inputs: [], outputs: [{type: "address"}]},
] as const;

export const registryAbi = [
  {
    type: "function",
    name: "blockCount",
    stateMutability: "view",
    inputs: [{type: "bytes32"}],
    outputs: [{type: "uint256"}],
  },
] as const;

/** QuoterV2. Reverts internally to compute the quote, so it is only ever simulated. */
export const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        components: [
          {name: "tokenIn", type: "address"},
          {name: "tokenOut", type: "address"},
          {name: "amountIn", type: "uint256"},
          {name: "fee", type: "uint24"},
          {name: "sqrtPriceLimitX96", type: "uint160"},
        ],
      },
    ],
    outputs: [
      {name: "amountOut", type: "uint256"},
      {name: "sqrtPriceX96After", type: "uint160"},
      {name: "initializedTicksCrossed", type: "uint32"},
      {name: "gasEstimate", type: "uint256"},
    ],
  },
] as const;

export const erc20Abi = [
  {type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{type: "uint8"}]},
  {type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{type: "string"}]},
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{type: "address"}],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{type: "address"}, {type: "address"}],
    outputs: [{type: "uint256"}],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{type: "address"}, {type: "uint256"}],
    outputs: [{type: "bool"}],
  },
] as const;

/** Events the runner scans for, as standalone items for `getLogs`. */
export const proposalPostedEvent = parseAbiItem(
  "event ProposalPosted(bytes32 indexed proposalId, address indexed target, uint256 assets, uint256 executableAt)",
);
export const proposalExecutedEvent = parseAbiItem(
  "event ProposalExecuted(bytes32 indexed proposalId, address indexed target, uint256 assets)",
);
export const liquidatedEvent = parseAbiItem("event Liquidated(uint256 returnedToVault)");
