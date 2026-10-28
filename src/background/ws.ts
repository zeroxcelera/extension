import { createPublicClient, webSocket, type PublicClient } from 'viem';
import type { ChainConfig } from '../shared/chains';
import { toViemChain } from './chain/client';

export type WsState = 'off' | 'connecting' | 'connected' | 'error';

export interface WsStatus {
  state: WsState;
  /** ms timestamp of the last block received, or null. */
  lastBlockAt: number | null;
}

interface Conn {
  url: string;
  client: PublicClient;
  unwatch: () => void;
  state: WsState;
  lastBlockAt: number | null;
}

/** A block is "recent" if it arrived within this window; otherwise we fall back to polling. */
const STALE_MS = 30_000;

/**
 * Optional WebSocket per chain, used only to stream new blocks (eth_subscribe newHeads).
 * Quotes and sending stay on HTTPS. Anything waiting on a block falls back to a timeout,
 * so a dropped socket degrades to polling instead of stalling.
 */
export class WsHub {
  private readonly conns = new Map<number, Conn>();
  private readonly waiters = new Map<number, Set<() => void>>();

  constructor(
    private readonly onBlock: (chainId: number, baseFee: bigint | null) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Connects, reconnects with a new URL, or disconnects when `url` is empty. */
  ensure(chain: ChainConfig, url: string): void {
    const cur = this.conns.get(chain.id);
    if (cur && cur.url === url) return;
    if (cur) {
      cur.unwatch();
      this.conns.delete(chain.id);
    }
    if (!url) return;

    const client = createPublicClient({
      chain: toViemChain(chain),
      transport: webSocket(url, {
        keepAlive: { interval: 20_000 },
        reconnect: { attempts: 20, delay: 3_000 },
        timeout: 10_000,
      }),
    });
    const conn: Conn = {
      url,
      client,
      unwatch: () => undefined,
      state: 'connecting',
      lastBlockAt: null,
    };
    conn.unwatch = client.watchBlocks({
      emitMissed: false,
      onBlock: (block) => {
        conn.state = 'connected';
        conn.lastBlockAt = this.now();
        this.onBlock(chain.id, block.baseFeePerGas ?? null);
        const ws = this.waiters.get(chain.id);
        if (ws) {
          this.waiters.delete(chain.id);
          for (const w of ws) w();
        }
      },
      onError: () => {
        conn.state = 'error';
      },
    });
    this.conns.set(chain.id, conn);
  }

  status(chainId: number): WsStatus {
    const c = this.conns.get(chainId);
    if (!c) return { state: 'off', lastBlockAt: null };
    const stale =
      c.state === 'connected' && (c.lastBlockAt === null || this.now() - c.lastBlockAt > STALE_MS);
    return { state: stale ? 'connecting' : c.state, lastBlockAt: c.lastBlockAt };
  }

  /** True when blocks are arriving, so callers can rely on block events. */
  live(chainId: number): boolean {
    return this.status(chainId).state === 'connected';
  }

  /** Resolves on the next block for the chain, or after `timeoutMs` (whichever first). */
  nextBlock(chainId: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      if (!this.live(chainId)) return;
      let set = this.waiters.get(chainId);
      if (!set) this.waiters.set(chainId, (set = new Set()));
      set.add(done);
    });
  }
}
