import { formatEther, formatUnits, isAddressEqual, type Address } from 'viem';
import type { TicketLeg, TradeTicket } from './panel';

/** What a wallet's Celera trades left open in a token: tokens and their native cost. */
export interface CostBasis {
  tokens: bigint;
  costWei: bigint;
}

/**
 * Average-cost basis per wallet from the activity log (newest first, as stored): buys add
 * tokens and the native paid, sells take tokens out at their average cost. Only confirmed
 * transactions with known amounts count; gas is left out. Tokens a wallet got outside
 * Celera have no cost here, so callers value only the part this covers.
 */
export function costBasis(
  history: readonly TradeTicket[],
  chainId: number,
  token: Address,
): Map<string, CostBasis> {
  const out = new Map<string, CostBasis>();
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i] as TradeTicket;
    if (t.chainId !== chainId || !t.token || !isAddressEqual(t.token, token)) continue;
    if (t.kind !== 'buy' && t.kind !== 'sell') continue;
    const byWallet = new Map<string, TicketLeg[]>();
    for (const l of t.legs) byWallet.set(l.walletId, [...(byWallet.get(l.walletId) ?? []), l]);
    for (const [walletId, legs] of byWallet) {
      const done = (kind: TicketLeg['kind']) =>
        legs.find((l) => l.kind === kind && l.status === 'confirmed');
      const swap = done('swap');
      if (!swap) continue;
      const pos = out.get(walletId) ?? { tokens: 0n, costWei: 0n };
      if (t.kind === 'buy') {
        // A funded curve bought in two transactions paid native in its first step.
        const paid = done('step')?.amountIn ?? swap.amountIn;
        if (!paid || !swap.amountOut) continue;
        pos.tokens += BigInt(swap.amountOut);
        pos.costWei += BigInt(paid);
      } else {
        if (!swap.amountIn || pos.tokens === 0n) continue;
        const sold = BigInt(swap.amountIn) < pos.tokens ? BigInt(swap.amountIn) : pos.tokens;
        pos.costWei -= (pos.costWei * sold) / pos.tokens;
        pos.tokens -= sold;
      }
      out.set(walletId, pos);
    }
  }
  return out;
}

/**
 * Unrealised profit or loss of the held tokens that have a cost basis, at today's prices
 * (`usd`, and `bps` of the cost). Null when nothing held has one, or a price is missing.
 */
export function unrealisedPnl(
  wallets: readonly { token: string; cost?: { tokens: string; costWei: string } }[],
  decimals: number,
  tokenUsd: number | null,
  nativeUsd: number | null,
): { usd: number; bps: number } | null {
  if (!tokenUsd || !nativeUsd) return null;
  let covered = 0n;
  let cost = 0n;
  for (const w of wallets) {
    const tokens = BigInt(w.cost?.tokens ?? '0');
    const held = BigInt(w.token);
    if (tokens <= 0n || held <= 0n) continue;
    // Sold or sent elsewhere: only what is still held counts, at its average cost.
    const part = held < tokens ? held : tokens;
    covered += part;
    cost += (BigInt(w.cost?.costWei ?? '0') * part) / tokens;
  }
  const costUsd = Number(formatEther(cost)) * nativeUsd;
  if (covered === 0n || costUsd <= 0) return null;
  const usd = Number(formatUnits(covered, decimals)) * tokenUsd - costUsd;
  return { usd, bps: Math.round((usd / costUsd) * 10_000) };
}
