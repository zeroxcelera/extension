import { getChain } from '../../shared/chains';

/** GMGN path slugs for the chains it lists; others open on DEX Screener. */
const GMGN: Record<number, string> = { 1: 'eth', 56: 'bsc', 8453: 'base', 4663: 'robinhood' };

export function chartUrl(chainId: number, token: string): string {
  const slug = GMGN[chainId];
  if (slug) return `https://gmgn.ai/${slug}/token/${token}`;
  return `https://dexscreener.com/${getChain(chainId)?.dexscreenerSlug ?? 'ethereum'}/${token}`;
}

export function txUrl(chainId: number, hash: string): string {
  return `${getChain(chainId)?.explorer.url ?? 'https://etherscan.io'}/tx/${hash}`;
}
