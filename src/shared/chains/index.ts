import { CHAIN_DEFINITIONS } from './definitions';
import { ChainConfigSchema, type ChainConfig, type ChainConfigInput } from './schema';

export type { ChainConfig, GasPreset } from './schema';

/** Parses and cross-checks chain definitions. Throws on the first problem. */
export function buildChainRegistry(
  defs: readonly ChainConfigInput[],
): ReadonlyMap<number, ChainConfig> {
  const byId = new Map<number, ChainConfig>();
  const keys = new Set<string>();
  const aliases = new Set<string>();

  for (const def of defs) {
    const chain = ChainConfigSchema.parse(def);
    if (byId.has(chain.id)) throw new Error(`duplicate chain id ${chain.id}`);
    if (keys.has(chain.key)) throw new Error(`duplicate chain key ${chain.key}`);
    for (const alias of chain.aliases) {
      if (aliases.has(alias)) throw new Error(`duplicate chain alias ${alias}`);
      aliases.add(alias);
    }
    keys.add(chain.key);
    byId.set(chain.id, Object.freeze(chain));
  }
  return byId;
}

export const CHAINS: ReadonlyMap<number, ChainConfig> = buildChainRegistry(CHAIN_DEFINITIONS);

export function getChain(id: number): ChainConfig | undefined {
  return CHAINS.get(id);
}

/** Resolves a URL slug such as "bsc" or "eth" to a chain. Case-insensitive. */
export function findChainByAlias(slug: string): ChainConfig | undefined {
  const s = slug.toLowerCase();
  for (const chain of CHAINS.values()) {
    if (chain.aliases.includes(s)) return chain;
  }
  return undefined;
}

export function explorerTxUrl(chain: ChainConfig, hash: string): string {
  return `${chain.explorer.url}/tx/${hash}`;
}
