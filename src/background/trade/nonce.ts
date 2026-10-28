import type { Address } from 'viem';

const RESYNC_MS = 30_000;

/**
 * Local nonce tracking per (chain, wallet) so rapid clicks get consecutive nonces
 * instead of all reading the same "pending" count from the RPC. Calls for the same
 * key are serialised.
 */
export class NonceManager {
  private readonly state = new Map<string, { next: number; syncedAt: number }>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly fetchPending: (chainId: number, address: Address) => Promise<number>,
    private readonly now: () => number = Date.now,
  ) {}

  private key(chainId: number, address: Address) {
    return `${chainId}:${address.toLowerCase()}`;
  }

  /** Runs `fn` with the next nonce reserved; on failure the nonce is released (resync). */
  async withNonce<T>(
    chainId: number,
    address: Address,
    fn: (nonce: number) => Promise<T>,
  ): Promise<T> {
    const key = this.key(chainId, address);
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.locks.set(
      key,
      prev.then(() => gate),
    );
    await prev.catch(() => undefined);
    try {
      const nonce = await this.reserve(chainId, address);
      try {
        return await fn(nonce);
      } catch (e) {
        // The RPC never saw it (or rejected it): forget local state and resync next time.
        this.state.delete(key);
        throw e;
      }
    } finally {
      release();
    }
  }

  private async reserve(chainId: number, address: Address): Promise<number> {
    const key = this.key(chainId, address);
    const s = this.state.get(key);
    const stale = !s || this.now() - s.syncedAt > RESYNC_MS;
    let next = s?.next ?? 0;
    if (stale) {
      const remote = await this.fetchPending(chainId, address);
      next = Math.max(next, remote);
    }
    this.state.set(key, {
      next: next + 1,
      syncedAt: stale ? this.now() : (s?.syncedAt ?? this.now()),
    });
    return next;
  }

  /** Syncs a stale entry from the RPC without reserving a nonce (called while idle). */
  async warm(chainId: number, address: Address): Promise<void> {
    const key = this.key(chainId, address);
    const s = this.state.get(key);
    if (s && this.now() - s.syncedAt <= RESYNC_MS / 2) return;
    const remote = await this.fetchPending(chainId, address);
    const cur = this.state.get(key);
    // Re-check: a send may have reserved a nonce while we were fetching.
    if (cur && cur.next > remote) return;
    this.state.set(key, { next: remote, syncedAt: this.now() });
  }

  reset(chainId: number, address: Address): void {
    this.state.delete(this.key(chainId, address));
  }
}
