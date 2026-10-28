import { getAddress, isAddress } from 'viem';
import { z } from 'zod';

export const AddressSchema = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), 'invalid address')
  .transform((v) => getAddress(v));

const HttpsUrl = z.url({ protocol: /^https$/ });

/** Decimal amount in the chain's native unit, e.g. "0.005". */
const DecimalAmount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'invalid decimal amount');

const GasPresetSchema = z.object({
  /** EIP-1559 priority fee, in gwei (decimal string). Ignored when feeModel is 'arbitrum'. */
  priorityFeeGwei: DecimalAmount,
  /** maxFeePerGas = baseFee * maxFeeMultiplier + priorityFee. */
  maxFeeMultiplier: z.number().min(1).max(10),
  /** Slippage tolerance in basis points (100 = 1%). */
  slippageBps: z.number().int().min(1).max(5000),
});
export type GasPreset = z.infer<typeof GasPresetSchema>;

export const ChainConfigSchema = z.object({
  id: z.number().int().positive(),
  /** Stable lowercase key used in storage and settings. */
  key: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  shortName: z.string().min(1).max(8),
  /** URL slugs terminals use for this chain (lowercase). Used by the generic adapter. */
  aliases: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1),
  nativeCurrency: z.object({
    name: z.string(),
    symbol: z.string(),
    decimals: z.literal(18),
  }),
  wrappedNative: AddressSchema,
  /** Stablecoins used as quote assets and for USD pricing. Checked on-chain via symbol(). */
  stablecoins: z.array(
    z.object({
      address: AddressSchema,
      symbol: z.string(),
      decimals: z.number().int().min(0).max(36),
    }),
  ),
  /**
   * Non-stable assets a route may pass through between native and the token, for tokens
   * launched against them (e.g. VIRTUAL, ZORA). Never used for USD pricing.
   */
  hopTokens: z
    .array(
      z.object({
        address: AddressSchema,
        symbol: z.string(),
        /**
         * The Uniswap v4 pool (paired with native) that converts native into this asset,
         * for assets without a v3 pool against wrapped native (e.g. Flaunch's flETH).
         */
        v4Bridge: z
          .object({ fee: z.number().int(), tickSpacing: z.number().int(), hooks: AddressSchema })
          .optional(),
      }),
    )
    .optional(),
  /**
   * Celera Router (contracts/) on this chain: runs a curve trade quoted in an ERC-20
   * together with its native ↔ asset swap in one transaction. Unset where it is not
   * deployed; there such trades take separate transactions.
   */
  celeraRouter: AddressSchema.optional(),
  /** Chain slug on api.dexscreener.com (used only as a fallback to resolve v4 pool ids). */
  dexscreenerSlug: z.string().regex(/^[a-z0-9-]+$/),
  rpcUrls: z.array(HttpsUrl).min(1),
  explorer: z.object({ name: z.string(), url: HttpsUrl }),
  /**
   * 'eip1559': priority fee buys ordering.
   * 'arbitrum': sequencer is first-come-first-served, priority fee is ignored.
   */
  feeModel: z.enum(['eip1559', 'arbitrum']),
  mev: z.discriminatedUnion('supported', [
    z.object({ supported: z.literal(true), defaultRpc: HttpsUrl.optional() }),
    z.object({ supported: z.literal(false), reason: z.string() }),
  ]),
  quickBuyAmounts: z.array(DecimalAmount).length(4),
  gasPresets: z.object({ p1: GasPresetSchema, p2: GasPresetSchema, p3: GasPresetSchema }),
});

export type ChainConfigInput = z.input<typeof ChainConfigSchema>;
export type ChainConfig = z.output<typeof ChainConfigSchema>;
