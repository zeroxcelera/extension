import { CHAIN_DEFINITIONS } from './chains/definitions';

/**
 * Terminals that get a host permission at install time. Any other site is enabled
 * per-origin at runtime from the popup ("Enable on this site").
 */
export interface BuiltinSite {
  id: string;
  name: string;
  /** Match patterns used for both host_permissions and content-script matches. */
  matches: string[];
}

export const BUILTIN_SITES: readonly BuiltinSite[] = [
  { id: 'gmgn', name: 'GMGN', matches: ['https://gmgn.ai/*'] },
  { id: 'dexscreener', name: 'DEX Screener', matches: ['https://dexscreener.com/*'] },
  { id: 'dextools', name: 'DEXTools', matches: ['https://www.dextools.io/*'] },
  { id: 'geckoterminal', name: 'GeckoTerminal', matches: ['https://www.geckoterminal.com/*'] },
  { id: 'birdeye', name: 'Birdeye', matches: ['https://birdeye.so/*'] },
  { id: 'axiom', name: 'Axiom', matches: ['https://axiom.trade/*'] },
  { id: 'basedbot', name: 'BasedBot', matches: ['https://basedbot.app/*'] },
  { id: 'fourmeme', name: 'four.meme', matches: ['https://four.meme/*'] },
  { id: 'flap', name: 'Flap', matches: ['https://flap.sh/*'] },
];

export const BUILTIN_MATCHES: string[] = BUILTIN_SITES.flatMap((s) => s.matches);

/** Hosts the background fetches from (pool index). Not content-script targets. */
export const API_HOSTS: string[] = [
  'https://api.dexscreener.com/*',
  // Token logos (image CDN; redirects from dd. to cdn.).
  'https://dd.dexscreener.com/*',
  'https://cdn.dexscreener.com/*',
  // Bridge quotes and status.
  'https://api.relay.link/*',
  // Aggregator routes (fallback when no listed pool trades a token).
  'https://aggregator-api.kyberswap.com/*',
  // Built-in RPCs (incl. default MEV RPCs). With a host permission the browser skips
  // CORS, so an error page without CORS headers (rate limit, gateway error) reaches
  // viem as a real HTTP error and the next RPC is tried, instead of a CORS failure.
  ...new Set(
    CHAIN_DEFINITIONS.flatMap((c) => [
      ...c.rpcUrls,
      ...(c.mev.supported && c.mev.defaultRpc ? [c.mev.defaultRpc] : []),
    ]).map((u) => `${new URL(u).origin}/*`),
  ),
];

/** True when `origin` (e.g. "https://gmgn.ai") is covered by a built-in site. */
export function isBuiltinOrigin(origin: string): boolean {
  return BUILTIN_MATCHES.some((pattern) => pattern.replace(/\/\*$/, '') === origin);
}

/**
 * Registered content-script id for a runtime-enabled site. Every character outside
 * [a-z0-9] is escaped as `_` + its hex code, so two origins never share an id (a plain
 * replacement would make https://a-b.com and https://a_b.com collide).
 */
export function siteScriptId(origin: string): string {
  return `site-${origin.toLowerCase().replace(/[^a-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;
}
