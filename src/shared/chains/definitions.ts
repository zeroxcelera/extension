import type { ChainConfigInput } from './schema';

// Adding a chain = adding an entry here. Router / launchpad contracts are added per
// venue. Wrapped-native and stablecoin addresses were checked on-chain via symbol() and
// decimals().

/**
 * Celera Router (contracts/), deployed with CREATE2 at the same address on every chain
 * below (see contracts/README.md). It holds no funds and has no owner.
 */
const CELERA_ROUTER = '0xfdf24705a48f08558a6eed9B72d24cF3Bbce07e5';

export const ethereum: ChainConfigInput = {
  id: 1,
  key: 'ethereum',
  name: 'Ethereum',
  shortName: 'ETH',
  aliases: ['eth', 'ethereum', 'mainnet', 'ether'],
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  wrappedNative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  stablecoins: [
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
  ],
  dexscreenerSlug: 'ethereum',
  rpcUrls: ['https://ethereum-rpc.publicnode.com'],
  explorer: { name: 'Etherscan', url: 'https://etherscan.io' },
  feeModel: 'eip1559',
  celeraRouter: CELERA_ROUTER,
  mev: { supported: true, defaultRpc: 'https://rpc.flashbots.net/fast' },
  quickBuyAmounts: ['0.001', '0.005', '0.01', '0.05'],
  gasPresets: {
    p1: { priorityFeeGwei: '0.5', maxFeeMultiplier: 1.5, slippageBps: 500 },
    p2: { priorityFeeGwei: '2', maxFeeMultiplier: 2, slippageBps: 1000 },
    p3: { priorityFeeGwei: '5', maxFeeMultiplier: 3, slippageBps: 2000 },
  },
};

export const base: ChainConfigInput = {
  id: 8453,
  key: 'base',
  name: 'Base',
  shortName: 'BASE',
  aliases: ['base'],
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  wrappedNative: '0x4200000000000000000000000000000000000006',
  stablecoins: [
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  ],
  // Virtuals and Zora launches trade against these (WETH bridge pools on Uniswap v3).
  hopTokens: [
    { address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', symbol: 'VIRTUAL' },
    { address: '0x1111111111166b7FE7bd91427724B487980aFc69', symbol: 'ZORA' },
    // Flaunch pairs its coins with flETH; its hook pool wraps native 1:1.
    {
      address: '0x000000000D564D5be76f7f0d28fE52605afC7Cf8',
      symbol: 'flETH',
      v4Bridge: { fee: 0, tickSpacing: 60, hooks: '0x9e433f32bb5481a9ca7dff5b3af74a7ed041a888' },
    },
  ],
  dexscreenerSlug: 'base',
  rpcUrls: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  explorer: { name: 'Basescan', url: 'https://basescan.org' },
  feeModel: 'eip1559',
  celeraRouter: CELERA_ROUTER,
  mev: {
    supported: false,
    reason: 'Base has no public mempool; the sequencer orders transactions.',
  },
  quickBuyAmounts: ['0.001', '0.005', '0.01', '0.05'],
  gasPresets: {
    p1: { priorityFeeGwei: '0.001', maxFeeMultiplier: 1.5, slippageBps: 500 },
    p2: { priorityFeeGwei: '0.01', maxFeeMultiplier: 2, slippageBps: 1000 },
    p3: { priorityFeeGwei: '0.05', maxFeeMultiplier: 3, slippageBps: 2000 },
  },
};

export const bsc: ChainConfigInput = {
  id: 56,
  key: 'bsc',
  name: 'BNB Smart Chain',
  shortName: 'BSC',
  aliases: ['bsc', 'bnb', 'binance'],
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  wrappedNative: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  stablecoins: [
    { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 },
    { address: '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', symbol: 'USD1', decimals: 18 },
  ],
  dexscreenerSlug: 'bsc',
  rpcUrls: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com'],
  explorer: { name: 'BscScan', url: 'https://bscscan.com' },
  feeModel: 'eip1559',
  // No default: BSC private RPCs (48 Club, BlockRazor, bloXroute…) need the user's own endpoint.
  // PancakeSwap MEV Guard (48 Club): a free private RPC against sandwich attacks.
  celeraRouter: CELERA_ROUTER,
  mev: { supported: true, defaultRpc: 'https://bscrpc.pancakeswap.finance' },
  quickBuyAmounts: ['0.005', '0.02', '0.05', '0.1'],
  gasPresets: {
    p1: { priorityFeeGwei: '0.05', maxFeeMultiplier: 1.5, slippageBps: 500 },
    p2: { priorityFeeGwei: '0.1', maxFeeMultiplier: 2, slippageBps: 1000 },
    p3: { priorityFeeGwei: '1', maxFeeMultiplier: 3, slippageBps: 2000 },
  },
};

export const robinhood: ChainConfigInput = {
  // Chain ID confirmed via eth_chainId (0x1237) on the public RPC.
  id: 4663,
  key: 'robinhood',
  name: 'Robinhood Chain',
  shortName: 'RH',
  aliases: ['robinhood', 'robinhood-chain', 'rh'],
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  stablecoins: [
    // Note: 18 decimals on this chain.
    { address: '0x11D04a2491AB485a54dA3817C10C2A9178c7991e', symbol: 'USDC', decimals: 18 },
    { address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', symbol: 'USDG', decimals: 6 },
  ],
  dexscreenerSlug: 'robinhood',
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  explorer: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  feeModel: 'arbitrum',
  celeraRouter: CELERA_ROUTER,
  mev: {
    supported: false,
    reason: 'Robinhood Chain is an Arbitrum-stack L2 with a first-come-first-served sequencer.',
  },
  quickBuyAmounts: ['0.001', '0.005', '0.01', '0.05'],
  gasPresets: {
    p1: { priorityFeeGwei: '0', maxFeeMultiplier: 1.5, slippageBps: 500 },
    p2: { priorityFeeGwei: '0', maxFeeMultiplier: 2, slippageBps: 1000 },
    p3: { priorityFeeGwei: '0', maxFeeMultiplier: 3, slippageBps: 2000 },
  },
};

export const arbitrum: ChainConfigInput = {
  // Added as config only (chain + Uniswap addresses), no code changes.
  id: 42161,
  key: 'arbitrum',
  name: 'Arbitrum One',
  shortName: 'ARB',
  aliases: ['arbitrum', 'arb', 'arbitrum-one'],
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  wrappedNative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  stablecoins: [
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
  ],
  dexscreenerSlug: 'arbitrum',
  rpcUrls: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
  explorer: { name: 'Arbiscan', url: 'https://arbiscan.io' },
  feeModel: 'arbitrum',
  mev: {
    supported: false,
    reason: 'Arbitrum has a first-come-first-served sequencer and no public mempool.',
  },
  quickBuyAmounts: ['0.001', '0.005', '0.01', '0.05'],
  gasPresets: {
    p1: { priorityFeeGwei: '0', maxFeeMultiplier: 1.5, slippageBps: 500 },
    p2: { priorityFeeGwei: '0', maxFeeMultiplier: 2, slippageBps: 1000 },
    p3: { priorityFeeGwei: '0', maxFeeMultiplier: 3, slippageBps: 2000 },
  },
};

export const CHAIN_DEFINITIONS: readonly ChainConfigInput[] = [
  ethereum,
  base,
  bsc,
  robinhood,
  arbitrum,
];
