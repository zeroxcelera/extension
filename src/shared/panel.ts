import type { Address, Hex } from 'viem';
import type { PriorityLevel } from './settings/defaults';

/** Amounts are decimal strings of raw integer units (bigint does not cross messaging). */
export interface PanelWallet {
  id: string;
  name: string;
  address: Address;
  primary: boolean;
  selected: boolean;
  native: string;
  token: string;
}

export interface PanelState {
  locked: boolean;
  wallets: PanelWallet[];
  nativeUsd: number | null;
  chain: {
    quickBuyAmounts: string[];
    quickSellBps: number[];
    slippageBps: number;
    priority: PriorityLevel;
    priorityGwei: { low: string; medium: string; high: string };
    customPriorityGwei: string;
    /** False on first-come-first-served sequencers, where a priority fee does nothing. */
    priorityApplies: boolean;
    /** `configured`: a private RPC is set, so the toggle can actually take effect. */
    mev: { supported: boolean; enabled: boolean; configured: boolean; reason?: string };
    /** Buys above this measured tax are refused. 10 000 = off. */
    maxTaxBps: number;
  };
  global: {
    hotkeysEnabled: boolean;
    multiWalletMode: 'each' | 'split';
    confirmAboveUsd: number;
    maxUsdPerTx: number;
    maxUsdPerClick: number;
    priceImpactWarnBps: number;
    priceImpactDangerBps: number;
    quoteRefreshMs: number;
  };
}

export interface QuoteView {
  amountIn: string;
  amountOut: string;
  priceImpactBps: number | null;
  venue: string;
}

export interface TaxView {
  buyBps: number;
  /** Null when the sell part could not be measured. */
  sellBps: number | null;
  /** The simulated sell reverted. */
  sellFails: boolean;
}

export interface QuoteSet {
  buys: (QuoteView | null)[];
  sells: (QuoteView | null)[];
  /** USD value of one whole token, if known. */
  tokenUsd: number | null;
  venue: string | null;
  /**
   * Token tax measured by simulating a buy then a sell on the quoted pool (transfer tax
   * plus any venue tax). Null until measured, or when it could not be.
   */
  tax: TaxView | null;
  /** The tax probe ran but could not measure (e.g. the RPC cannot simulate). */
  taxUnknown: boolean;
  fetchedAt: number;
}

export type LegStatus =
  'queued' | 'sending' | 'submitted' | 'confirmed' | 'failed' | 'skipped' | 'blocked';

export interface TicketLeg {
  walletId: string;
  walletName: string;
  /** 'step': a conversion around the trade (e.g. ETH → VIRTUAL for a Virtuals curve). */
  kind: 'approve' | 'swap' | 'transfer' | 'cancel' | 'bridge' | 'step';
  /** Shown instead of the wallet name, e.g. "ETH → VIRTUAL". */
  note?: string;
  status: LegStatus;
  hash?: Hex;
  nonce?: number;
  /** Raw amount in (native wei for buys, token units for sells). */
  amountIn?: string;
  error?: string;
  /** Ms from the click to the RPC accepting the transaction. */
  sentMs?: number;
  /**
   * Where sentMs went: routing before the checks, balance check + simulation,
   * nonce + signing, and the RPC accepting it.
   */
  phases?: { prepMs: number; checkMs: number; signMs: number; sendMs: number };
  /** Ms from sending to seeing the receipt. */
  confirmMs?: number;
  /** Network fee paid (wei), from the receipt. */
  feeWei?: string;
  /** Raw amount received: token units for buys, native wei for sells. */
  amountOut?: string;
}

/**
 * Ms from the click until the transaction was signed and ready to send: Celera's own part
 * of sentMs. The rest (`phases.sendMs`) is the network accepting it.
 */
export function readyMs(leg: TicketLeg): number | undefined {
  const p = leg.phases;
  return p ? p.prepMs + p.checkMs + p.signMs : undefined;
}

/** Trade settings in force when the ticket was sent. */
export interface TicketSettings {
  slippageBps: number;
  /** Absent where the priority fee does not apply (Arbitrum-based chains). */
  priority?: { level: string; gwei: string };
  /** Absent where private sending is not offered. */
  mev?: boolean;
}

export interface BlockedAction {
  label: string;
  ok: boolean;
  reason?: string;
}

export interface TradeTicket {
  id: string;
  kind: 'buy' | 'sell' | 'distribute' | 'collect' | 'bridge' | 'send';
  chainId: number;
  token?: Address;
  symbol?: string;
  status: 'working' | 'done' | 'partial' | 'failed' | 'blocked';
  legs: TicketLeg[];
  createdAt: number;
  explorer: string;
  blocked?: BlockedAction[];
  bridge?: BridgeInfo;
  /** Pool label, e.g. "Uniswap v3 · 0.3% via USDC". */
  route?: string;
  settings?: TicketSettings;
  /** Native price in USD at send time, for the USD figures in history. */
  nativeUsd?: number;
  /** Token decimals, for amounts in history. */
  decimals?: number;
  /** Send: the outside address the funds went to. */
  recipient?: Address;
}

/** Cross-chain transfer via Relay (native asset to native asset). */
export interface BridgeInfo {
  toChainId: number;
  /** Raw amounts (wei). */
  amountIn: string;
  amountOut: string;
  recipientName: string;
  requestId: string;
  /** Relay status: waiting → pending → success | failure | refund. */
  relayStatus: string;
  /** Destination tx, once filled. */
  outHash?: Hex;
}
