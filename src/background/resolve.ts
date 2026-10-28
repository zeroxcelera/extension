import {
  getAddress,
  hexToString,
  isAddressEqual,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { CHAINS, getChain, type ChainConfig } from '../shared/chains';
import type { Detection, ResolvedTarget } from '../shared/detection';
import { sanitizeLabel } from '../shared/sanitize';
import { erc20Abi, erc20Bytes32Abi, pairAbi } from './chain/abis';

export interface ResolveDeps {
  client: (chain: ChainConfig) => PublicClient;
  /** Last-resort lookup for v4 pool ids (DEX Screener API). */
  fetchJson?: (url: string) => Promise<unknown>;
  /** Extra resolvers (e.g. Uniswap v4 PositionManager) tried before the API fallback. */
  poolIdResolvers?: ((chain: ChainConfig, poolId: Hex) => Promise<Address | null>)[];
}

interface TokenMeta {
  name: string;
  symbol: string;
  decimals: number;
}

function isQuote(chain: ChainConfig, token: Address): boolean {
  return (
    isAddressEqual(token, chain.wrappedNative) ||
    chain.stablecoins.some((s) => isAddressEqual(s.address, token))
  );
}

/** Reads ERC-20 metadata; null if the address does not behave like a token. */
export async function readTokenMeta(
  client: PublicClient,
  token: Address,
): Promise<TokenMeta | null> {
  const [name, symbol, decimals] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: token, abi: erc20Abi, functionName: 'name' },
      { address: token, abi: erc20Abi, functionName: 'symbol' },
      { address: token, abi: erc20Abi, functionName: 'decimals' },
    ],
  });
  if (decimals.status !== 'success' || decimals.result > 36) return null;
  let n = name.status === 'success' ? name.result : '';
  let s = symbol.status === 'success' ? symbol.result : '';
  if (!s || !n) {
    const [n32, s32] = await client.multicall({
      allowFailure: true,
      contracts: [
        { address: token, abi: erc20Bytes32Abi, functionName: 'name' },
        { address: token, abi: erc20Bytes32Abi, functionName: 'symbol' },
      ],
    });
    if (!n && n32.status === 'success') n = hexToString(n32.result, { size: 32 });
    if (!s && s32.status === 'success') s = hexToString(s32.result, { size: 32 });
  }
  return {
    name: sanitizeLabel(n) || 'Unknown token',
    symbol: sanitizeLabel(s, 16) || '???',
    decimals: decimals.result,
  };
}

/** Picks the traded token from a pair: the side that is not a quote asset. */
function pickBaseToken(chain: ChainConfig, token0: Address, token1: Address): Address {
  const q0 = isQuote(chain, token0);
  const q1 = isQuote(chain, token1);
  if (q0 && !q1) return token1;
  return token0;
}

async function classify(
  chain: ChainConfig,
  client: PublicClient,
  address: Address,
  kind: Detection['kind'],
): Promise<Omit<ResolvedTarget, 'chainId'> | null> {
  const code = await client.getCode({ address });
  if (!code || code === '0x') return null;

  if (kind !== 'token') {
    const [t0, t1] = await client.multicall({
      allowFailure: true,
      contracts: [
        { address, abi: pairAbi, functionName: 'token0' },
        { address, abi: pairAbi, functionName: 'token1' },
      ],
    });
    if (t0.status === 'success' && t1.status === 'success') {
      const token = pickBaseToken(chain, t0.result, t1.result);
      const meta = await readTokenMeta(client, token);
      return meta ? { token, pair: address, source: 'pair', ...meta } : null;
    }
  }
  const meta = await readTokenMeta(client, address);
  return meta ? { token: address, source: 'url', ...meta } : null;
}

async function resolvePoolId(
  chain: ChainConfig,
  poolId: Hex,
  deps: ResolveDeps,
): Promise<{ token: Address; source: ResolvedTarget['source'] } | null> {
  for (const r of deps.poolIdResolvers ?? []) {
    const token = await r(chain, poolId).catch(() => null);
    if (token) return { token, source: 'pair' };
  }
  if (!deps.fetchJson) return null;
  const json = await deps.fetchJson(
    `https://api.dexscreener.com/latest/dex/pairs/${chain.dexscreenerSlug}/${poolId}`,
  );
  const pair = (json as { pairs?: { baseToken?: { address?: string } }[] } | null)?.pairs?.[0];
  const addr = pair?.baseToken?.address;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
  return { token: getAddress(addr), source: 'api' };
}

/**
 * Turns a URL hint into a verified token on a supported chain. Everything shown in
 * the panel comes from here, i.e. from the chain, not from the page.
 */
export async function resolveTarget(
  d: Detection,
  deps: ResolveDeps,
): Promise<ResolvedTarget | null> {
  const chains = d.chainId
    ? [getChain(d.chainId)].filter((c): c is ChainConfig => !!c)
    : [...CHAINS.values()];

  if (d.poolId) {
    for (const chain of chains) {
      const hit = await resolvePoolId(chain, d.poolId, deps).catch(() => null);
      if (!hit) continue;
      const meta = await readTokenMeta(deps.client(chain), hit.token);
      if (meta)
        return {
          chainId: chain.id,
          token: hit.token,
          poolId: d.poolId,
          source: hit.source,
          ...meta,
        };
    }
    return null;
  }

  if (!d.address) return null;
  const address = d.address;
  const results = await Promise.all(
    chains.map((chain) => classify(chain, deps.client(chain), address, d.kind).catch(() => null)),
  );
  for (let i = 0; i < chains.length; i++) {
    const r = results[i];
    const chain = chains[i];
    if (r && chain) return { chainId: chain.id, ...r };
  }
  return null;
}
