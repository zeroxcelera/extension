import { getAddress, type Address, type Hex } from 'viem';
import { findChainByAlias } from '../shared/chains';
import type { Detection } from '../shared/detection';

/**
 * One adapter per terminal. Adapters only look at the URL (never the page DOM, which
 * the site controls). Adding a terminal = adding an entry to ADAPTERS.
 */
export interface SiteAdapter {
  id: string;
  /** Hostnames this adapter handles (exact match). */
  hosts: string[];
  parse(url: URL): Detection | null;
}

const ADDR = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
const POOL_ID = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/;

function addr(s: string | undefined): Address | undefined {
  const m = s?.match(ADDR);
  return m ? getAddress(m[0]) : undefined;
}

function chainFrom(slug: string | undefined, map: Record<string, number> = {}): number | undefined {
  if (!slug) return undefined;
  const s = slug.toLowerCase();
  return map[s] ?? findChainByAlias(s)?.id;
}

function segments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean);
}

/** Path like /<chain>/<pair-or-pool-id>: DEX Screener, GeckoTerminal, DEXTools style. */
function pairOrPool(
  siteId: string,
  chainId: number | undefined,
  id: string | undefined,
): Detection | null {
  if (!id) return null;
  const pool = id.match(POOL_ID);
  if (pool && id.length === 66)
    return {
      siteId,
      kind: 'pair',
      poolId: pool[0].toLowerCase() as Hex,
      ...(chainId ? { chainId } : {}),
    };
  const a = addr(id);
  return a ? { siteId, kind: 'pair', address: a, ...(chainId ? { chainId } : {}) } : null;
}

export const gmgn: SiteAdapter = {
  id: 'gmgn',
  hosts: ['gmgn.ai', 'www.gmgn.ai'],
  // /bsc/token/0x…  (also /bsc/token/<ref>_0x…)
  parse(url) {
    const [chain, kind, id] = segments(url);
    if (kind !== 'token') return null;
    const address = addr(id);
    const chainId = chainFrom(chain);
    return address && chainId ? { siteId: 'gmgn', kind: 'token', address, chainId } : null;
  },
};

export const dexscreener: SiteAdapter = {
  id: 'dexscreener',
  hosts: ['dexscreener.com', 'www.dexscreener.com'],
  // /base/0x<pair 20 bytes> or /base/0x<v4 pool id 32 bytes>
  parse(url) {
    const [chain, id] = segments(url);
    const chainId = chainFrom(chain);
    return chainId ? pairOrPool('dexscreener', chainId, id) : null;
  },
};

export const dextools: SiteAdapter = {
  id: 'dextools',
  hosts: ['www.dextools.io', 'dextools.io'],
  // /app/en/<chain>/pair-explorer/0x…
  parse(url) {
    const s = segments(url);
    const i = s.indexOf('pair-explorer');
    if (i < 1) return null;
    const chainId = chainFrom(s[i - 1], { ether: 1 });
    return chainId ? pairOrPool('dextools', chainId, s[i + 1]) : null;
  },
};

export const geckoterminal: SiteAdapter = {
  id: 'geckoterminal',
  hosts: ['www.geckoterminal.com', 'geckoterminal.com'],
  // /<network>/pools/0x…
  parse(url) {
    const s = segments(url);
    const i = s.indexOf('pools');
    if (i < 1) return null;
    const chainId = chainFrom(s[i - 1]);
    return chainId ? pairOrPool('geckoterminal', chainId, s[i + 1]) : null;
  },
};

export const birdeye: SiteAdapter = {
  id: 'birdeye',
  hosts: ['birdeye.so', 'www.birdeye.so'],
  // /token/0x…?chain=base  or  /<chain>/token/0x…
  parse(url) {
    const s = segments(url);
    const i = s.indexOf('token');
    if (i < 0) return null;
    const address = addr(s[i + 1]);
    const chainId = chainFrom(url.searchParams.get('chain') ?? s[i - 1]);
    return address
      ? { siteId: 'birdeye', kind: 'token', address, ...(chainId ? { chainId } : {}) }
      : null;
  },
};

/** Launchpad sites whose token pages are /…/<token address> on one known chain. */
const LAUNCHPAD_CHAINS: Record<string, number> = {
  'four.meme': 56,
  'www.ponsfamily.com': 4663,
  'ponsfamily.com': 4663,
  'app.long.xyz': 4663,
  'www.thestonks.exchange': 8453,
  'launch.o1.exchange': 8453,
  'bankr.bot': 8453,
  'zora.co': 8453,
  'stockereum.com': 1,
  'sender.family': 1,
  'trench.today': 1,
};

/**
 * Fallback for any other site (Axiom, BasedBot, launchpads, sites the user enabled):
 * takes the first address in the path or query and a chain slug from anywhere in the
 * URL. Without a chain, the background probes all chains for contract code.
 */
export const generic: SiteAdapter = {
  id: 'generic',
  hosts: [],
  parse(url) {
    const haystack = `${url.pathname}?${url.search}`;
    const pool = haystack.match(POOL_ID);
    const address = addr(haystack);
    let chainId: number | undefined = LAUNCHPAD_CHAINS[url.hostname];
    if (!chainId) {
      const tokens = [...segments(url), ...url.searchParams.values()].flatMap((p) =>
        p.toLowerCase().split(/[:_\-.]/),
      );
      for (const t of tokens) {
        chainId = chainFrom(t);
        if (chainId) break;
      }
    }
    if (pool && !address)
      return {
        siteId: 'generic',
        kind: 'pair',
        poolId: pool[0].toLowerCase() as Hex,
        ...(chainId ? { chainId } : {}),
      };
    if (!address) return null;
    return { siteId: 'generic', kind: 'unknown', address, ...(chainId ? { chainId } : {}) };
  },
};

const ADAPTERS: readonly SiteAdapter[] = [gmgn, dexscreener, dextools, geckoterminal, birdeye];

export function detect(href: string): Detection | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const adapter = ADAPTERS.find((a) => a.hosts.includes(url.hostname));
  // A dedicated adapter that does not recognise the page means "not a token page".
  if (adapter) return adapter.parse(url);
  return generic.parse(url);
}
