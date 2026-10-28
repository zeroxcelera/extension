import { formatEther, getAddress, parseAbiItem, type Address, type PublicClient } from 'viem';
import type { ChainConfig } from '../shared/chains';
import { readBalances } from './balances';
import { erc20Abi } from './chain/abis';
import { readTokenMeta } from './resolve';
import type { PriceService } from './trade/prices';
import type { Routing } from './trade/routing';
import type { VenueCtx } from './trade/types';
import type { KeyValueStore } from './vault/vault';

/** Below this USD value a holding counts as dust and is hidden by default. */
export const DUST_USD = 1;
/**
 * Most tokens priced per request: the user's own first (newest first), then tokens that
 * only arrived by transfer (likely spam, hidden anyway).
 */
const MAX_PRICED = 30;
/** First scan looks this many blocks back; later scans continue from where they stopped. */
const INITIAL_WINDOW = 20_000n;
/** eth_getLogs block span per request (public RPCs commonly cap at 2k–10k). */
const LOG_CHUNK = 2_000n;
const MAX_CHUNKS_PER_SCAN = 10;
const SCAN_EVERY_MS = 60_000;
/**
 * Public RPCs usually refuse Transfer-log queries without a contract address. When that
 * happens, wait this long before trying again (a custom RPC normally allows them).
 */
const SCAN_REFUSED_BACKOFF_MS = 60 * 60_000;

const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export interface PortfolioToken {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  /** Raw balances per wallet id (decimal strings). */
  perWallet: Record<string, string>;
  total: string;
  /** USD value of `total`, or null when no route/price was found. */
  valueUsd: number | null;
  dust: boolean;
  /**
   * Arrived on its own (found in incoming transfers) and was never bought through Celera
   * or added by hand: airdrop spam until the user says otherwise. Its price is often
   * faked with a thin pool, so it never counts toward totals.
   */
  unsolicited: boolean;
}

export interface Portfolio {
  chainId: number;
  nativeUsd: number | null;
  /** Native balance per wallet id. */
  native: Record<string, string>;
  tokens: PortfolioToken[];
}

interface ScanState {
  /** Next block to scan, per wallet set key. */
  next: string;
}

/**
 * Tokens held by the user's wallets. Discovery: tokens Celera traded, tokens added by
 * hand, and incoming ERC-20 Transfer logs (scanned incrementally where the RPC allows
 * address-less log queries — usually only a custom RPC). Prices come from the
 * same on-chain routing as trading.
 */
export class PortfolioService {
  private readonly lastScan = new Map<string, number>();
  private readonly meta = new Map<string, { symbol: string; name: string; decimals: number }>();

  constructor(
    private readonly local: KeyValueStore,
    private readonly routing: Routing,
    private readonly prices: PriceService,
  ) {}

  private tokensKey(chainId: number) {
    return `celera.tokens.${chainId}`;
  }

  private trustedKey(chainId: number) {
    return `celera.tokens.trusted.${chainId}`;
  }

  private async list(key: string): Promise<Address[] | null> {
    const v = await this.local.get(key);
    return Array.isArray(v) ? v.filter((x): x is Address => typeof x === 'string') : null;
  }

  async knownTokens(chainId: number): Promise<Address[]> {
    return (await this.list(this.tokensKey(chainId))) ?? [];
  }

  /** Bought through Celera, added by hand, or marked as the user's own. */
  async trustedTokens(chainId: number): Promise<Set<string>> {
    const trusted = (await this.list(this.trustedKey(chainId))) ?? [];
    return new Set(trusted.map((t) => t.toLowerCase()));
  }

  /**
   * `trusted`: the user chose this token (a trade or a manual add). Tokens found only in
   * incoming transfers are added untrusted and hidden as unsolicited.
   */
  async addTokens(chainId: number, tokens: readonly Address[], trusted = true): Promise<void> {
    if (tokens.length === 0) return;
    const known = await this.knownTokens(chainId);
    const set = new Set(known.map((t) => t.toLowerCase()));
    const add = tokens.map((t) => getAddress(t)).filter((t) => !set.has(t.toLowerCase()));
    if (add.length) await this.local.set(this.tokensKey(chainId), [...known, ...add].slice(-500));
    if (trusted) for (const t of tokens) await this.setTrusted(chainId, t, true);
  }

  /** Marks a token as the user's own (shown) or as unsolicited (hidden). */
  async setTrusted(chainId: number, token: Address, trusted: boolean): Promise<void> {
    const current = await this.trustedTokens(chainId);
    const key = token.toLowerCase();
    if (current.has(key) === trusted) return;
    const list = ((await this.list(this.trustedKey(chainId))) ?? []).filter(
      (t) => t.toLowerCase() !== key,
    );
    if (trusted) list.push(getAddress(token));
    await this.local.set(this.trustedKey(chainId), list.slice(-1000));
  }

  /** Incoming Transfer logs since the last scan (bounded work per call). */
  private async scan(
    chain: ChainConfig,
    client: PublicClient,
    wallets: readonly Address[],
    now: number,
  ) {
    if (wallets.length === 0) return;
    const setKey = `${chain.id}:${[...wallets]
      .map((w) => w.toLowerCase())
      .sort()
      .join(',')}`;
    if (now - (this.lastScan.get(setKey) ?? 0) < SCAN_EVERY_MS) return;
    this.lastScan.set(setKey, now);

    const stateKey = `celera.scan.${chain.id}`;
    const all = ((await this.local.get(stateKey)) ?? {}) as Record<string, ScanState>;
    const latest = await client.getBlockNumber();
    let from = all[setKey]
      ? BigInt(all[setKey].next)
      : latest > INITIAL_WINDOW
        ? latest - INITIAL_WINDOW
        : 0n;
    const found: Address[] = [];
    for (let i = 0; i < MAX_CHUNKS_PER_SCAN && from <= latest; i++) {
      const to = from + LOG_CHUNK - 1n < latest ? from + LOG_CHUNK - 1n : latest;
      try {
        const logs = await client.getLogs({
          event: transferEvent,
          args: { to: [...wallets] },
          fromBlock: from,
          toBlock: to,
        });
        for (const l of logs) found.push(l.address);
      } catch {
        // Refused (typical on public RPCs): back off, retry later from the same block.
        this.lastScan.set(setKey, now + SCAN_REFUSED_BACKOFF_MS - SCAN_EVERY_MS);
        break;
      }
      from = to + 1n;
    }
    all[setKey] = { next: from.toString() };
    await this.local.set(stateKey, all);
    await this.addTokens(chain.id, found, false);
  }

  private async metaOf(client: PublicClient, chainId: number, token: Address) {
    const key = `${chainId}:${token.toLowerCase()}`;
    let m = this.meta.get(key);
    if (!m) {
      m = (await readTokenMeta(client, token)) ?? undefined;
      if (m) this.meta.set(key, m);
    }
    return m;
  }

  async get(
    ctx: VenueCtx,
    wallets: readonly { id: string; address: Address }[],
  ): Promise<Portfolio> {
    const { chain, client } = ctx;
    const addrs = wallets.map((w) => w.address);
    await this.scan(chain, client, addrs, ctx.now()).catch(() => undefined);

    const [nativeBalances, tokens, trusted, nativeUsd] = await Promise.all([
      readBalances(client, null, addrs),
      this.knownTokens(chain.id),
      this.trustedTokens(chain.id),
      this.prices.nativeUsd(ctx).catch(() => null),
    ]);

    // Balances of every known token for every wallet, one multicall.
    const calls = tokens.flatMap((t) =>
      addrs.map(
        (w) => ({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [w] }) as const,
      ),
    );
    const res = calls.length
      ? await client.multicall({ allowFailure: true, contracts: calls })
      : [];
    const held: { token: Address; perWallet: Record<string, string>; total: bigint }[] = [];
    tokens.forEach((token, ti) => {
      let total = 0n;
      const perWallet: Record<string, string> = {};
      wallets.forEach((w, wi) => {
        const r = res[ti * wallets.length + wi];
        const bal = r?.status === 'success' ? (r.result as bigint) : 0n;
        if (bal > 0n) perWallet[w.id] = bal.toString();
        total += bal;
      });
      if (total > 0n) held.push({ token, perWallet, total });
    });
    // `tokens` is oldest first; with many holdings, a fresh buy must not fall off the list.
    const own = (t: Address) => (trusted.has(t.toLowerCase()) ? 0 : 1);
    const age = new Map(tokens.map((t, i) => [t.toLowerCase(), i]));
    held.sort(
      (a, b) =>
        own(a.token) - own(b.token) ||
        (age.get(b.token.toLowerCase()) ?? 0) - (age.get(a.token.toLowerCase()) ?? 0),
    );

    // Price the holdings: what the whole balance would sell for, in native → USD.
    const priced = await Promise.all(
      held.slice(0, MAX_PRICED).map(async (h) => {
        const meta = await this.metaOf(client, chain.id, h.token).catch(() => undefined);
        if (!meta) return null;
        const [route] = await this.routing
          .best(ctx, h.token, 'sell', [h.total])
          .catch(() => [null]);
        const valueUsd =
          route && nativeUsd !== null ? Number(formatEther(route.out)) * nativeUsd : null;
        return {
          address: h.token,
          ...meta,
          perWallet: h.perWallet,
          total: h.total.toString(),
          valueUsd,
          dust: valueUsd === null || valueUsd < DUST_USD,
          unsolicited: !trusted.has(h.token.toLowerCase()),
        } satisfies PortfolioToken;
      }),
    );

    return {
      chainId: chain.id,
      nativeUsd,
      native: Object.fromEntries(
        wallets.map((w, i) => [w.id, (nativeBalances[i]?.native ?? 0n).toString()]),
      ),
      tokens: priced
        .filter((t): t is PortfolioToken => t !== null)
        .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1)),
    };
  }
}
