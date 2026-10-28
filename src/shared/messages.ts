import { z } from 'zod';
import { AddressSchema } from './chains/schema';
import type { ResolvedTarget } from './detection';
import type { PanelState, QuoteSet, TradeTicket } from './panel';
import type { ChainSettings, GlobalSettings } from './settings/defaults';
import {
  ChainSettingsSchema,
  GlobalSettingsSchema,
  PanelChainPatchSchema,
} from './settings/defaults';
import type { WalletAccount } from './wallet';

const Id = z.string().min(1).max(64);
const Password = z.string().min(1).max(1024);
const ChainId = z.number().int().positive();
const Decimal = z.string().regex(/^\d{1,30}(\.\d{1,18})?$/);
const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const Origin = z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d+)?$/);

const DetectionSchema = z
  .object({
    siteId: z.string().max(32),
    kind: z.enum(['token', 'pair', 'unknown']),
    address: AddressSchema.optional(),
    poolId: Hex32.optional(),
    chainId: ChainId.optional(),
  })
  .strict();

/** Where the panel sits on a site, and whether it is folded away. -1 = default position. */
export const PanelPrefsSchema = z
  .object({
    x: z.number().min(-1).max(100_000),
    y: z.number().min(-1).max(100_000),
    minimized: z.boolean(),
    hidden: z.boolean(),
  })
  .strict();
export type PanelPrefs = z.infer<typeof PanelPrefsSchema>;

const TradeTarget = { chainId: ChainId, token: AddressSchema };
const WalletIds = z.array(Id).min(1).max(100);
/** Epoch ms of the click in the page, for the click → sent timing. */
const ClickedAt = z.number().int().positive().optional();

/**
 * Every request to the background. Parsed with zod before anything else happens.
 * Which sender kinds may use which type is decided by CONTENT_TYPES / FRAME_TYPES below.
 */
export const RequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }).strict(),

  z.object({ type: z.literal('vault.status') }).strict(),
  z
    .object({ type: z.literal('vault.create'), mnemonic: z.string().max(1024), password: Password })
    .strict(),
  z.object({ type: z.literal('vault.unlock'), password: Password }).strict(),
  z.object({ type: z.literal('vault.lock') }).strict(),
  z.object({ type: z.literal('vault.reset'), confirm: z.literal('DELETE') }).strict(),

  z.object({ type: z.literal('wallets.list') }).strict(),
  z.object({ type: z.literal('wallets.add'), name: z.string().max(64).optional() }).strict(),
  z
    .object({
      type: z.literal('wallets.importKey'),
      privateKey: z.string().max(200),
      name: z.string().max(64).optional(),
    })
    .strict(),
  z.object({ type: z.literal('wallets.rename'), id: Id, name: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('wallets.setHidden'), id: Id, hidden: z.boolean() }).strict(),
  z.object({ type: z.literal('wallets.setPrimary'), id: Id }).strict(),
  z.object({ type: z.literal('wallets.remove'), id: Id }).strict(),
  z.object({ type: z.literal('wallets.exportKey'), id: Id, password: Password }).strict(),
  z.object({ type: z.literal('wallets.balances'), chainId: ChainId }).strict(),
  z
    .object({
      type: z.literal('wallets.distribute'),
      chainId: ChainId,
      /** The wallet the funds come from. */
      hubId: Id,
      walletIds: WalletIds,
      amountEach: Decimal,
    })
    .strict(),
  z
    .object({
      type: z.literal('wallets.collect'),
      chainId: ChainId,
      /** The wallet the funds go to. */
      hubId: Id,
      walletIds: WalletIds,
    })
    .strict(),

  // Send / receive: popup only (not in the content or frame allowlists).
  z
    .object({
      type: z.literal('send.prepare'),
      chainId: ChainId,
      walletId: Id,
      token: AddressSchema.optional(),
    })
    .strict(),
  z
    .object({ type: z.literal('send.checkRecipient'), chainId: ChainId, to: AddressSchema })
    .strict(),
  z
    .object({
      type: z.literal('send.execute'),
      chainId: ChainId,
      walletId: Id,
      to: AddressSchema,
      token: AddressSchema.optional(),
      amount: Decimal,
      password: Password.optional(),
    })
    .strict(),

  z.object({ type: z.literal('clipboard.scheduleClear') }).strict(),
  z.object({ type: z.literal('offscreen.done') }).strict(),

  z.object({ type: z.literal('settings.get') }).strict(),
  z.object({ type: z.literal('settings.repairs') }).strict(),
  z
    .object({ type: z.literal('settings.update'), patch: GlobalSettingsSchema.partial().strict() })
    .strict(),
  z.object({ type: z.literal('settings.getChain'), chainId: ChainId }).strict(),
  z
    .object({
      type: z.literal('settings.updateChain'),
      chainId: ChainId,
      patch: ChainSettingsSchema.partial().strict(),
    })
    .strict(),

  z.object({ type: z.literal('history.list') }).strict(),
  z.object({ type: z.literal('portfolio.get'), chainId: ChainId, walletIds: WalletIds }).strict(),
  z
    .object({ type: z.literal('portfolio.addToken'), chainId: ChainId, token: AddressSchema })
    .strict(),
  z
    .object({
      type: z.literal('portfolio.setTrusted'),
      chainId: ChainId,
      token: AddressSchema,
      trusted: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('logo.get'),
      chainId: ChainId,
      token: z.union([AddressSchema, z.literal('native')]),
    })
    .strict(),
  z
    .object({
      type: z.literal('bridge.quote'),
      fromChainId: ChainId,
      toChainId: ChainId,
      amount: Decimal,
      fromWalletId: Id,
      toWalletId: Id,
    })
    .strict(),
  z
    .object({
      type: z.literal('bridge.execute'),
      fromChainId: ChainId,
      toChainId: ChainId,
      amount: Decimal,
      fromWalletId: Id,
      toWalletId: Id,
      confirmed: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal('ws.status'), chainId: ChainId }).strict(),

  z.object({ type: z.literal('sites.status'), origin: Origin }).strict(),
  z.object({ type: z.literal('sites.enable'), origin: Origin, tabId: z.number().int() }).strict(),
  z.object({ type: z.literal('sites.disable'), origin: Origin }).strict(),

  // Panel (content script)
  z.object({ type: z.literal('panel.resolve'), detection: DetectionSchema }).strict(),
  z.object({ type: z.literal('panel.state'), ...TradeTarget }).strict(),
  z
    .object({
      type: z.literal('panel.quotes'),
      ...TradeTarget,
      buyAmounts: z.array(Decimal).max(8),
      sellBps: z.array(z.number().int().min(1).max(10_000)).max(8),
    })
    .strict(),
  z.object({ type: z.literal('rpc.warm'), chainId: ChainId }).strict(),
  z.object({ type: z.literal('panel.selectWallets'), walletIds: WalletIds }).strict(),
  z
    .object({
      type: z.literal('panel.setTrade'),
      chainId: ChainId,
      patch: PanelChainPatchSchema,
    })
    .strict(),
  // Panel position per site; the site is the sender's own origin, never a field.
  z.object({ type: z.literal('panel.getPrefs') }).strict(),
  z.object({ type: z.literal('panel.setPrefs'), prefs: PanelPrefsSchema }).strict(),

  // Trading (content script; every transaction still passes the validator)
  z
    .object({
      type: z.literal('trade.buy'),
      ...TradeTarget,
      amount: Decimal,
      walletIds: WalletIds,
      mode: z.enum(['each', 'split']),
      confirmed: z.boolean(),
      clickedAt: ClickedAt,
    })
    .strict(),
  z
    .object({
      type: z.literal('trade.sell'),
      ...TradeTarget,
      bps: z.number().int().min(1).max(10_000),
      walletIds: WalletIds,
      confirmed: z.boolean(),
      clickedAt: ClickedAt,
    })
    .strict(),
  z.object({ type: z.literal('trade.speedUp'), ticketId: Id, walletId: Id }).strict(),
  z.object({ type: z.literal('trade.cancel'), ticketId: Id, walletId: Id }).strict(),
]);
export type Request = z.infer<typeof RequestSchema>;
export type RequestType = Request['type'];
export type RequestOf<T extends RequestType> = Extract<Request, { type: T }>;

/** Requests a content script on a trading page may send. Never anything touching keys. */
export const CONTENT_TYPES: ReadonlySet<RequestType> = new Set<RequestType>([
  'ping',
  'vault.status',
  'panel.resolve',
  'panel.state',
  'panel.quotes',
  'rpc.warm',
  'panel.selectWallets',
  'panel.setTrade',
  'panel.getPrefs',
  'panel.setPrefs',
  'trade.buy',
  'trade.sell',
  'trade.speedUp',
  'trade.cancel',
]);

/** Requests an extension page embedded as an iframe inside a trading page may send. */
export const FRAME_TYPES: ReadonlySet<RequestType> = new Set<RequestType>([
  'ping',
  'vault.status',
  'vault.unlock',
]);

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
}

export interface PingResponse {
  version: string;
  locked: boolean;
}

export interface WalletBalanceView {
  id: string;
  native: string;
}

export interface BridgeQuoteView {
  /** Raw destination amount (wei). */
  amountOut: string;
  feeUsd: number | null;
  timeEstimateS: number | null;
  amountInUsd: number | null;
}

export interface WsStatusView {
  state: 'off' | 'connecting' | 'connected' | 'error';
  lastBlockAt: number | null;
}

export interface PortfolioTokenView {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  perWallet: Record<string, string>;
  total: string;
  valueUsd: number | null;
  dust: boolean;
  /** Received without being bought or added: likely airdrop spam, hidden by default. */
  unsolicited: boolean;
}

export interface Portfolio {
  chainId: number;
  nativeUsd: number | null;
  native: Record<string, string>;
  tokens: PortfolioTokenView[];
}

export interface SendPrep {
  /** Estimated network fee for the send (wei). */
  feeWei: string;
  /** Largest amount that can be sent (raw units), leaving the fee for native sends. */
  maxAmount: string;
}

export interface RecipientCheck {
  /** Name of your wallet with this address, if it is one. */
  ownName: string | null;
  /** Has code: an exchange deposit or smart wallet is fine, a token contract is not. */
  contract: boolean;
  /** Symbol when the address is a token contract (funds sent there are usually lost). */
  tokenSymbol: string | null;
  /** A previous Send went to this address. */
  sentBefore: boolean;
}

export interface SiteStatus {
  builtin: boolean;
  enabled: boolean;
}

export interface ResponseMap {
  ping: PingResponse;
  'vault.status': VaultStatus;
  'vault.create': WalletAccount[];
  'vault.unlock': WalletAccount[];
  'vault.lock': null;
  'vault.reset': null;
  'wallets.list': WalletAccount[];
  'wallets.add': WalletAccount;
  'wallets.importKey': WalletAccount;
  'wallets.rename': null;
  'wallets.setHidden': null;
  'wallets.setPrimary': null;
  'wallets.remove': null;
  'wallets.exportKey': { privateKey: string };
  'wallets.balances': WalletBalanceView[];
  'wallets.distribute': TradeTicket;
  'wallets.collect': TradeTicket;
  'send.prepare': SendPrep;
  'send.checkRecipient': RecipientCheck;
  'send.execute': TradeTicket;
  'clipboard.scheduleClear': null;
  'offscreen.done': null;
  'settings.get': GlobalSettings;
  /** Saved settings that were invalid and fell back to their defaults. */
  'settings.repairs': string[];
  'settings.update': GlobalSettings;
  'settings.getChain': ChainSettings;
  'settings.updateChain': ChainSettings;
  'history.list': TradeTicket[];
  'portfolio.get': Portfolio;
  'portfolio.addToken': null;
  'portfolio.setTrusted': null;
  'logo.get': string | null;
  'bridge.quote': BridgeQuoteView;
  'bridge.execute': TradeTicket;
  'ws.status': WsStatusView;
  'sites.status': SiteStatus;
  'sites.enable': SiteStatus;
  'sites.disable': SiteStatus;
  'panel.resolve': ResolvedTarget | null;
  'panel.state': PanelState;
  'panel.quotes': QuoteSet;
  'rpc.warm': null;
  'panel.selectWallets': null;
  'panel.setTrade': null;
  'panel.getPrefs': PanelPrefs;
  'panel.setPrefs': null;
  'trade.buy': TradeTicket;
  'trade.sell': TradeTicket;
  'trade.speedUp': TradeTicket;
  'trade.cancel': TradeTicket;
}

export type ErrorCode =
  | 'invalid_request'
  | 'forbidden'
  | 'internal'
  | 'no_vault'
  | 'exists'
  | 'locked'
  | 'bad_password'
  | 'weak_password'
  | 'bad_mnemonic'
  | 'bad_private_key'
  | 'duplicate'
  | 'not_found'
  | 'primary'
  | 'limit'
  | 'too_many_attempts'
  | 'corrupt'
  | 'unsupported_chain'
  | 'no_route'
  | 'needs_confirmation'
  | 'needs_password'
  | 'limit_exceeded'
  | 'tax_too_high'
  | 'insufficient_funds'
  | 'blocked'
  | 'rpc'
  | 'permission_denied'
  | 'invalid_settings';

export type Result<T> =
  { ok: true; data: T } | { ok: false; error: ErrorCode; retryAfterMs?: number; detail?: string };

export const ResultEnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    retryAfterMs: z.number().optional(),
    detail: z.string().optional(),
  }),
]);

/** Background → content script push events (via tabs.sendMessage). */
export type PushEvent =
  | { kind: 'celera.vault'; unlocked: boolean }
  | { kind: 'celera.ticket'; ticket: TradeTicket }
  | { kind: 'celera.block'; chainId: number };
