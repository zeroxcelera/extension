import type { TradeTicket } from '../shared/panel';
import type { KeyValueStore } from './vault/vault';

const KEY = 'celera.history';
const MAX = 200;

/**
 * Activity log: every ticket (buy, sell, bridge, transfer), newest first, last 200.
 * Holds tx hashes, amounts and wallet names only — no key material.
 */
export class HistoryStore {
  private cache: TradeTicket[] | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly local: KeyValueStore) {}

  async list(): Promise<TradeTicket[]> {
    if (!this.cache) {
      const v = await this.local.get(KEY);
      this.cache = Array.isArray(v) ? (v as TradeTicket[]) : [];
    }
    return this.cache;
  }

  /**
   * Inserts or replaces by id. Writes are serialised so rapid updates do not race; a
   * failed write (e.g. storage full) rejects only its own call, never the ones after it.
   */
  upsert(ticket: TradeTicket): Promise<void> {
    const run = this.queue.then(async () => {
      const list = [...(await this.list())];
      const i = list.findIndex((t) => t.id === ticket.id);
      if (i >= 0) list[i] = ticket;
      else list.unshift(ticket);
      this.cache = list.slice(0, MAX);
      await this.local.set(KEY, this.cache);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async clear(): Promise<void> {
    this.cache = [];
    await this.local.remove(KEY);
  }
}
