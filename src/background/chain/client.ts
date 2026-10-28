import { createPublicClient, defineChain, fallback, http, type PublicClient } from 'viem';
import type { ChainConfig } from '../../shared/chains';

/** Deployed at the same address on all supported chains (checked via eth_getCode). */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export function toViemChain(c: ChainConfig) {
  return defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: c.nativeCurrency,
    rpcUrls: { default: { http: c.rpcUrls } },
    blockExplorers: { default: { name: c.explorer.name, url: c.explorer.url } },
    contracts: { multicall3: { address: MULTICALL3 } },
  });
}

/** One cached client per chain + RPC list. Custom RPCs (settings) go first. */
export class ClientPool {
  private readonly clients = new Map<string, PublicClient>();

  get(chain: ChainConfig, customRpcs: readonly string[] = []): PublicClient {
    const urls = [...new Set([...customRpcs, ...chain.rpcUrls])];
    const key = `${chain.id}|${urls.join(',')}`;
    let client = this.clients.get(key);
    if (!client) {
      client = createPublicClient({
        chain: toViemChain(chain),
        transport: fallback(urls.map((u) => http(u, { timeout: 8_000, retryCount: 1 }))),
        batch: { multicall: { wait: 0 } },
      });
      this.clients.set(key, client);
    }
    return client;
  }
}
