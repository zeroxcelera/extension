import type { Hash, Hex } from 'viem';

export interface RawSender {
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hash>;
}

/**
 * Sends one signed transaction to every endpoint at once; the first to accept it wins.
 * The bytes (and so the hash) are identical everywhere, so a late duplicate is harmless.
 * Only for chains without a public mempool: elsewhere a public endpoint would leak a
 * transaction meant for a private one.
 */
export async function broadcastRaw(senders: readonly RawSender[], raw: Hex): Promise<Hash> {
  const [only] = senders;
  if (!only) throw new Error('No RPC to send to');
  if (senders.length === 1) return only.sendRawTransaction({ serializedTransaction: raw });
  try {
    return await Promise.any(
      senders.map((s) => s.sendRawTransaction({ serializedTransaction: raw })),
    );
  } catch (e) {
    // Every endpoint refused: report the first one's reason (the user's own RPC comes first).
    throw e instanceof AggregateError ? e.errors[0] : e;
  }
}
