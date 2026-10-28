import { z } from 'zod';
import type { ChainConfig, GasPreset } from '../chains';

/**
 * Global settings. Defaults are deliberately conservative because the extension runs
 * against mainnet from day one: small USD limits and pre-sign simulation on.
 */
export const GlobalSettingsSchema = z.object({
  maxUsdPerTx: z.number().positive(),
  maxUsdPerClick: z.number().positive(),
  /** One-click actions above this USD value ask for confirmation first. */
  confirmAboveUsd: z.number().nonnegative(),
  /** Expected gas fee per transaction, in USD, above which nothing is signed. */
  maxGasUsd: z.number().positive(),
  autoLockMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  simulateBeforeSign: z.boolean(),
  hotkeysEnabled: z.boolean(),
  priceImpactWarnBps: z.number().int().positive(),
  priceImpactDangerBps: z.number().int().positive(),
  maxQuoteAgeMs: z.number().int().positive(),
  quoteRefreshMs: z.number().int().min(1_000),
  /**
   * Approve a token's sell spender once for the maximum, so later sells and buys never
   * need another approval. Off: bounded to holdings plus approvalBufferBps.
   */
  unlimitedApprovals: z.boolean(),
  /** Extra headroom on bounded approvals, on top of the amount held. */
  approvalBufferBps: z.number().int().min(0).max(10_000),
  multiWalletMode: z.enum(['each', 'split']),
  /** Random 0..N ms delay between wallets in a multi-wallet trade. 0 = off. */
  jitterMaxMs: z.number().int().min(0).max(300),
  selectedWalletIds: z.array(z.string()).max(100),
  /** Use the DEX Screener API as a pool index (results are verified on-chain). */
  usePoolIndex: z.boolean(),
  /** Ask KyberSwap for a route when no pool Celera knows can trade the token. */
  useAggregator: z.boolean(),
  /** Fetch token logos from DEX Screener's image CDN (reveals which tokens you look at). */
  showTokenLogos: z.boolean(),
});
export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = GlobalSettingsSchema.parse({
  maxUsdPerTx: 25,
  maxUsdPerClick: 50,
  confirmAboveUsd: 20,
  maxGasUsd: 10,
  autoLockMinutes: 15,
  simulateBeforeSign: true,
  // Off until the user turns them on: 1–4 buy instantly on any trading page.
  hotkeysEnabled: false,
  priceImpactWarnBps: 200,
  priceImpactDangerBps: 500,
  maxQuoteAgeMs: 6_000,
  quoteRefreshMs: 3_000,
  unlimitedApprovals: true,
  approvalBufferBps: 1_000,
  multiWalletMode: 'each',
  jitterMaxMs: 0,
  selectedWalletIds: [],
  usePoolIndex: true,
  useAggregator: true,
  showTokenLogos: true,
});

const HttpsUrl = z.url({ protocol: /^https$/ });

const Decimal = z.string().regex(/^\d+(\.\d{1,18})?$/);

const DEFAULT_QUICK_SELL_BPS = [2500, 5000, 7500, 10_000] as const;

export const PRIORITY_LEVELS = ['low', 'medium', 'high'] as const;
export type PriorityLevel = (typeof PRIORITY_LEVELS)[number] | 'custom';

/** Slippage shortcuts shown in the panel; any other value is "custom". */
export const SLIPPAGE_CHOICES_BPS = [1000, 2000, 4000] as const;
/** Max tax chips in the panel; 10 000 means no limit. */
export const MAX_TAX_CHOICES_BPS = [500, 1000, 2000] as const;

/** No two quick buttons may do the same thing (they share a hotkey slot and a busy state). */
const allDifferent = (xs: readonly (string | number)[]) =>
  new Set(xs.map((x) => Number(x))).size === xs.length;
export const QUICK_VALUES_DIFFER = 'The four quick values must all be different.';

export const ChainSettingsSchema = z.object({
  quickBuyAmounts: z.array(Decimal).length(4).refine(allDifferent, QUICK_VALUES_DIFFER),
  /** Quick-sell sizes in basis points of the holding (2500 = 25%). */
  quickSellBps: z
    .array(z.number().int().min(1).max(10_000))
    .length(4)
    .refine(allDifferent, QUICK_VALUES_DIFFER),
  /** Slippage tolerance in basis points (100 = 1%). */
  slippageBps: z.number().int().min(1).max(5000),
  priority: z.enum(['low', 'medium', 'high', 'custom']),
  /** Priority fee (gwei) behind Low / Medium / High. */
  priorityGwei: z.object({ low: Decimal, medium: Decimal, high: Decimal }),
  customPriorityGwei: Decimal,
  /** maxFeePerGas = baseFee × this + priority fee. */
  maxFeeMultiplier: z.number().min(1).max(10),
  /** Optional user RPC, tried before the built-in public ones. */
  customRpc: HttpsUrl.or(z.literal('')),
  /** Optional WebSocket RPC for new-block streaming (confirmations, per-block refresh). */
  wsRpc: z.url({ protocol: /^wss$/ }).or(z.literal('')),
  mevEnabled: z.boolean(),
  /** Buys are refused when the measured token tax (buy or sell) is above this. 10 000 = off. */
  maxTaxBps: z.number().int().min(0).max(10_000),
  /** Private RPC used for sending when MEV protection is on (Ethereum/BSC only). */
  mevRpc: HttpsUrl.or(z.literal('')),
});
export type ChainSettings = z.infer<typeof ChainSettingsSchema>;

/** Fields the trading panel may change directly (never RPC URLs). */
export const PanelChainPatchSchema = ChainSettingsSchema.pick({
  quickBuyAmounts: true,
  quickSellBps: true,
  slippageBps: true,
  priority: true,
  customPriorityGwei: true,
  mevEnabled: true,
  maxTaxBps: true,
})
  .partial()
  .strict();

export function defaultChainSettings(chain: ChainConfig): ChainSettings {
  const g = chain.gasPresets;
  return {
    quickBuyAmounts: [...chain.quickBuyAmounts],
    quickSellBps: [...DEFAULT_QUICK_SELL_BPS],
    slippageBps: 1000,
    priority: 'medium',
    priorityGwei: {
      low: g.p1.priorityFeeGwei,
      medium: g.p2.priorityFeeGwei,
      high: g.p3.priorityFeeGwei,
    },
    customPriorityGwei: g.p2.priorityFeeGwei,
    maxFeeMultiplier: g.p2.maxFeeMultiplier,
    customRpc: '',
    wsRpc: '',
    mevEnabled: chain.mev.supported,
    maxTaxBps: 10_000,
    mevRpc: chain.mev.supported ? (chain.mev.defaultRpc ?? '') : '',
  };
}

/** The gas/slippage parameters a trade uses right now. */
export function effectivePreset(cs: ChainSettings): GasPreset {
  return {
    priorityFeeGwei:
      cs.priority === 'custom' ? cs.customPriorityGwei : cs.priorityGwei[cs.priority],
    maxFeeMultiplier: cs.maxFeeMultiplier,
    slippageBps: cs.slippageBps,
  };
}
