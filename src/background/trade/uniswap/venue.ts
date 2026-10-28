import {
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseAbiParameters,
  sliceHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import type { BuyParams, PoolRef, SellParams, Side, TxDraft, Venue, VenueCtx } from '../types';
import { hopStables, stableSymbol } from '../stables';
import { PERMIT2, UNISWAP, type UniswapDeployment } from './addresses';
import {
  ADDRESS_THIS,
  NATIVE,
  OPEN_DELTA,
  encodeExecute,
  type Command,
  type PoolKey,
  type V4Action,
} from './codec';

const v2FactoryAbi = parseAbi(['function getPair(address, address) view returns (address)']);
const v2PairAbi = parseAbi([
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
]);
const v3FactoryAbi = parseAbi([
  'function getPool(address, address, uint24) view returns (address)',
]);
const v3PoolAbi = parseAbi(['function liquidity() view returns (uint128)']);
const quoterV2Abi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256 gasEstimate)',
]);
const stateViewAbi = parseAbi([
  'function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32) view returns (uint128)',
]);
const positionManagerAbi = parseAbi([
  'function poolKeys(bytes25) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)',
]);
const v4QuoterAbi = parseAbi([
  'function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData)) returns (uint256 amountOut, uint256 gasEstimate)',
]);
const zoraCoinAbi = parseAbi([
  'function getPoolKey() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
]);

// Launchpads that seed v4 pools straight through PoolManager: PositionManager never sees
// those keys, so they are rebuilt from the launchpad's own records (verified by liquidity).
const DYNAMIC_FEE = 0x800000;
const clankerAbi = parseAbi([
  'function tokenDeploymentInfo(address) view returns ((address token, address hook, address locker, address[] extensions))',
]);
const dopplerAbi = parseAbi([
  'function getAssetData(address) view returns (address numeraire, address timelock, address governance, address liquidityMigrator, address poolInitializer, address pool, address migrationPool, uint256 numTokensToSell, uint256 totalSupply, address integrator)',
]);
/** Clanker v4 factories (Clanker, and Bankr before it moved to Doppler). Paired with WETH. */
const CLANKER_V4: Record<number, Address[]> = {
  1: ['0x6c8599779b03b00aaae63c6378830919abb75473'],
  8453: ['0xE85A59c628F7d27878ACeB4bf3b35733630083a9'],
};
/** Doppler Airlocks (Bankr's current launches). The pool initializer is the pool's hook. */
const DOPPLER_AIRLOCK: Record<number, Address[]> = {
  8453: ['0x660eAaEdEBc968f8f3694354FA8EC0b4c5Ba8D12'],
  4663: ['0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862'],
};
const klikAbi = parseAbi(['function tokenHook(address) view returns (address)']);
const flaunchAbi = parseAbi([
  'function poolKey(address) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))',
]);
/** Flaunch position managers (each is also its pools' hook); coins are paired with flETH. */
const FLAUNCH: Record<number, Address[]> = {
  8453: [
    '0x23321f11a6d44fd1ab790044fdfde5758c902fdc',
    '0x588c683ecc450f8b2aadb13d7f63792b840425dc',
    '0x8dc3b85e1dc1c846ebf3971179a751896842e5dc',
  ],
};
/** Klik factories: per-token hook, paired with native ETH (fee 0, tick spacing 200). */
const KLIK: Record<number, Address[]> = {
  1: ['0xdfb7fe5e4ea0504afee387c42bb86e5860d29e8a'],
};
/** Fixed hook configurations, paired with wrapped native. */
const LAUNCH_HOOKS: Record<number, { hooks: Address; fee: number; tickSpacing: number }[]> = {
  // Stockereum
  1: [{ hooks: '0x322dcEc4958C14e021A9F1cD49DF11b9457968cC', fee: 0, tickSpacing: 200 }],
};

const V3_FEES = [100, 500, 3000, 10000] as const;
/** Hook-less v4 tiers worth probing directly (fee, tickSpacing). */
const V4_STANDARD: [number, number][] = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
];
const POOL_KEY_PARAMS = parseAbiParameters('address, address, uint24, int24, address');

/**
 * A pool pairing the token with a stablecoin is reached from native through a v3
 * native/stable pool (the bridge), in the same transaction.
 */
export interface Via {
  stable: Address;
  pool: Address;
  fee: number;
  /** Set when the native ↔ `stable` leg is a v4 pool (then `pool`/`fee` are unused). */
  v4Key?: PoolKey;
}

/** `quote` is the pool's other asset: native / wrapped native, or the stable of `via`. */
export type UniPool =
  | { kind: 'v2'; pair: Address; quote: Address; token0: Address; via?: Via }
  | { kind: 'v3'; pool: Address; quote: Address; fee: number; via?: Via }
  | { kind: 'v4'; poolId: Hex; key: PoolKey; quote: Address; via?: Via };

function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(POOL_KEY_PARAMS, [
      key.currency0,
      key.currency1,
      key.fee,
      key.tickSpacing,
      key.hooks,
    ]),
  );
}

function sortPair(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

function deployment(chainId: number): UniswapDeployment {
  const d = UNISWAP[chainId];
  if (!d) throw new Error(`uniswap not deployed on ${chainId}`);
  return d;
}

function feeLabel(fee: number): string {
  if (fee & 0x800000) return 'dynamic fee';
  return `${fee / 10_000}%`;
}

/** A v4 key is usable if it pairs `token` with native, wrapped native or one of `stables`. */
function v4QuoteSide(
  key: PoolKey,
  token: Address,
  wrapped: Address,
  stables: readonly Address[],
): Address | null {
  const other = isAddressEqual(key.currency0, token)
    ? key.currency1
    : isAddressEqual(key.currency1, token)
      ? key.currency0
      : null;
  if (!other) return null;
  if (
    isAddressEqual(other, NATIVE) ||
    isAddressEqual(other, wrapped) ||
    stables.some((s) => isAddressEqual(s, other))
  )
    return getAddress(other);
  return null;
}

async function poolIdsFromIndex(ctx: VenueCtx, token: Address): Promise<Hex[]> {
  if (!ctx.fetchJson) return [];
  const json = (await ctx
    .fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${token}`)
    .catch(() => null)) as {
    pairs?: { chainId?: string; pairAddress?: string }[];
  } | null;
  return (json?.pairs ?? [])
    .filter(
      (p) =>
        p.chainId === ctx.chain.dexscreenerSlug && /^0x[0-9a-fA-F]{64}$/.test(p.pairAddress ?? ''),
    )
    .map((p) => (p.pairAddress as string).toLowerCase() as Hex)
    .slice(0, 10);
}

/** Resolves a v4 pool id to its key via PositionManager (verified by re-hashing). */
export async function poolKeyFromId(ctx: VenueCtx, poolId: Hex): Promise<PoolKey | null> {
  const d = UNISWAP[ctx.chain.id];
  if (!d) return null;
  const r = await ctx.client
    .readContract({
      address: d.v4PositionManager,
      abi: positionManagerAbi,
      functionName: 'poolKeys',
      args: [sliceHex(poolId, 0, 25)],
    })
    .catch(() => null);
  if (!r) return null;
  const key: PoolKey = {
    currency0: r[0],
    currency1: r[1],
    fee: r[2],
    tickSpacing: r[3],
    hooks: r[4],
  };
  return poolIdOf(key) === poolId.toLowerCase() ? key : null;
}

/**
 * Candidate keys from launchpad records: Clanker's and Klik's hook per token, Doppler's
 * numeraire and initializer hook, and fixed hook configs. Wrong guesses have no liquidity and drop out.
 */
async function launchpadKeys(ctx: VenueCtx, token: Address): Promise<PoolKey[]> {
  const id = ctx.chain.id;
  const weth = ctx.chain.wrappedNative;
  const key = (other: Address, fee: number, tickSpacing: number, hooks: Address): PoolKey => {
    const [currency0, currency1] = sortPair(token, other);
    return { currency0, currency1, fee, tickSpacing, hooks };
  };
  const [clanker, doppler, klik, flaunch] = await Promise.all([
    Promise.all(
      (CLANKER_V4[id] ?? []).map((address) =>
        ctx.client
          .readContract({
            address,
            abi: clankerAbi,
            functionName: 'tokenDeploymentInfo',
            args: [token],
          })
          .catch(() => null),
      ),
    ),
    Promise.all(
      (DOPPLER_AIRLOCK[id] ?? []).map((address) =>
        ctx.client
          .readContract({ address, abi: dopplerAbi, functionName: 'getAssetData', args: [token] })
          .catch(() => null),
      ),
    ),
    Promise.all(
      (KLIK[id] ?? []).map((address) =>
        ctx.client
          .readContract({ address, abi: klikAbi, functionName: 'tokenHook', args: [token] })
          .catch(() => null),
      ),
    ),
    Promise.all(
      (FLAUNCH[id] ?? []).map((address) =>
        ctx.client
          .readContract({ address, abi: flaunchAbi, functionName: 'poolKey', args: [token] })
          .catch(() => null),
      ),
    ),
  ]);
  const out: PoolKey[] = [];
  for (const info of clanker) {
    if (info && isAddressEqual(info.token, token) && info.hook !== zeroAddress)
      out.push(key(weth, DYNAMIC_FEE, 200, info.hook));
  }
  for (const data of doppler) {
    const [numeraire, , , , initializer] = data ?? [];
    if (numeraire && initializer && initializer !== zeroAddress)
      out.push(key(numeraire === zeroAddress ? NATIVE : numeraire, DYNAMIC_FEE, 200, initializer));
  }
  for (const hook of klik) if (hook && hook !== zeroAddress) out.push(key(NATIVE, 0, 200, hook));
  // Flaunch returns the full key; it must actually hold `token` and be hooked by the manager.
  flaunch.forEach((k, i) => {
    const manager = FLAUNCH[id]?.[i];
    if (
      k &&
      manager &&
      isAddressEqual(k.hooks, manager) &&
      (isAddressEqual(k.currency0, token) || isAddressEqual(k.currency1, token))
    )
      out.push({ ...k });
  });
  for (const h of LAUNCH_HOOKS[id] ?? []) out.push(key(weth, h.fee, h.tickSpacing, h.hooks));
  return out;
}

async function discover(ctx: VenueCtx, token: Address): Promise<PoolRef<UniPool>[]> {
  const d = deployment(ctx.chain.id);
  const weth = ctx.chain.wrappedNative;
  const stables = hopStables(ctx, token);
  /** Quote assets for v2/v3: wrapped native, plus stablecoins (reached through a bridge pool). */
  const quotes = [weth, ...stables];
  const out: PoolRef<UniPool>[] = [];

  // Everything independent runs in parallel: factory lookups, Zora-style getPoolKey()
  // and the pool index (each index hit is verified via PositionManager).
  const indexedKeys = poolIdsFromIndex(ctx, token).then((ids) =>
    Promise.all(ids.map(async (id) => [id, await poolKeyFromId(ctx, id)] as const)),
  );
  const zoraKey = ctx.client
    .readContract({ address: token, abi: zoraCoinAbi, functionName: 'getPoolKey' })
    .catch(() => null);
  const launchKeys = launchpadKeys(ctx, token).catch(() => []);
  const v3Lookups = [
    ...quotes.flatMap((q) => V3_FEES.map((fee) => ({ a: token, b: q, fee }))),
    // Bridge candidates: wrapped native / stable, the leg every stable route shares.
    ...stables.flatMap((s) => V3_FEES.map((fee) => ({ a: weth, b: s, fee }))),
  ];
  const [v2Res, v3Res, zora, indexed, launched] = await Promise.all([
    ctx.client.multicall({
      allowFailure: true,
      contracts: quotes.map(
        (q) =>
          ({
            address: d.v2Factory,
            abi: v2FactoryAbi,
            functionName: 'getPair',
            args: [token, q],
          }) as const,
      ),
    }),
    ctx.client.multicall({
      allowFailure: true,
      contracts: v3Lookups.map(
        (l) =>
          ({
            address: d.v3Factory,
            abi: v3FactoryAbi,
            functionName: 'getPool',
            args: [l.a, l.b, l.fee],
          }) as const,
      ),
    }),
    zoraKey,
    indexedKeys.catch(() => []),
    launchKeys,
  ]);
  const pairs = quotes
    .map((q, i) => ({
      quote: q,
      pair: v2Res[i]?.status === 'success' ? v2Res[i].result : zeroAddress,
    }))
    .filter((p) => p.pair !== zeroAddress);
  const v3Found = v3Lookups
    .map((l, i) => {
      const r = v3Res[i];
      return { ...l, pool: r?.status === 'success' ? r.result : zeroAddress };
    })
    .filter((p) => p.pool !== zeroAddress);
  const v3Pools = v3Found.filter((p) => isAddressEqual(p.a, token));
  const bridgeCandidates = v3Found.filter((p) => !isAddressEqual(p.a, token));

  // v4 candidates: standard hook-less tiers, Zora-style getPoolKey(), and the pool index.
  const keys = new Map<Hex, PoolKey>();
  for (const quote of [NATIVE, weth, ...stables]) {
    const [c0, c1] = sortPair(token, quote);
    for (const [fee, tickSpacing] of V4_STANDARD) {
      const key = { currency0: c0, currency1: c1, fee, tickSpacing, hooks: zeroAddress };
      keys.set(poolIdOf(key), key);
    }
  }
  if (zora) keys.set(poolIdOf(zora), { ...zora });
  // Launch pools (e.g. Doppler auctions) can sit outside their liquidity range between
  // swaps, so in-range liquidity says nothing: the quote decides.
  const launchedIds = new Set<Hex>();
  for (const key of launched) {
    const id = poolIdOf(key);
    keys.set(id, key);
    launchedIds.add(id);
  }
  for (const [id, key] of indexed) {
    if (key && !keys.has(id)) keys.set(id, key);
  }
  const v4Candidates = [...keys.entries()]
    .map(([poolId, key]) => ({ poolId, key, quote: v4QuoteSide(key, token, weth, stables) }))
    .filter((c): c is { poolId: Hex; key: PoolKey; quote: Address } => c.quote !== null);

  // Liquidity checks for everything in one more multicall.
  const checks = await ctx.client.multicall({
    allowFailure: true,
    contracts: [
      ...pairs.flatMap(
        (p) =>
          [
            { address: p.pair, abi: v2PairAbi, functionName: 'getReserves' },
            { address: p.pair, abi: v2PairAbi, functionName: 'token0' },
          ] as const,
      ),
      ...[...v3Pools, ...bridgeCandidates].map(
        (p) => ({ address: p.pool, abi: v3PoolAbi, functionName: 'liquidity' }) as const,
      ),
      ...v4Candidates.map(
        (c) =>
          ({
            address: d.v4StateView,
            abi: stateViewAbi,
            functionName: 'getLiquidity',
            args: [c.poolId],
          }) as const,
      ),
    ],
  });
  let i = 0;
  const v2Live: { pair: Address; quote: Address; token0: Address }[] = [];
  for (const p of pairs) {
    const reserves = checks[i++];
    const t0 = checks[i++];
    if (reserves?.status === 'success' && t0?.status === 'success') {
      const [r0, r1] = reserves.result as readonly [bigint, bigint, number];
      if (r0 > 0n && r1 > 0n) v2Live.push({ ...p, token0: t0.result as Address });
    }
  }
  const liquidity = (): bigint => {
    const r = checks[i++];
    return r?.status === 'success' ? (r.result as bigint) : 0n;
  };
  const v3Live = v3Pools
    .map((p) => ({ ...p, liquidity: liquidity() }))
    .filter((p) => p.liquidity > 0n);
  // Per stable, the bridge pool with the most in-range liquidity.
  const bridges = new Map<string, Via>();
  const bridgeLiq = new Map<string, bigint>();
  for (const b of bridgeCandidates) {
    const l = liquidity();
    const k = b.b.toLowerCase();
    if (l > 0n && l > (bridgeLiq.get(k) ?? 0n)) {
      bridgeLiq.set(k, l);
      bridges.set(k, { stable: getAddress(b.b), pool: b.pool, fee: b.fee });
    }
  }
  const v4Live = v4Candidates.filter((c) => liquidity() > 0n || launchedIds.has(c.poolId));
  // Hop assets converted from native in a v4 pool (e.g. flETH). The pool may be a pure
  // hook with no liquidity of its own, so it is not liquidity-checked: quotes decide.
  for (const h of ctx.chain.hopTokens ?? []) {
    if (!h.v4Bridge || bridges.has(h.address.toLowerCase())) continue;
    if (!stables.some((s) => isAddressEqual(s, h.address))) continue;
    const [currency0, currency1] = sortPair(NATIVE, h.address);
    bridges.set(h.address.toLowerCase(), {
      stable: getAddress(h.address),
      pool: zeroAddress,
      fee: 0,
      v4Key: { currency0, currency1, ...h.v4Bridge },
    });
  }

  /** null = a stable-quoted pool with no bridge pool: unreachable from native, skipped. */
  const viaFor = (quote: Address): { via?: Via; suffix: string } | null => {
    if (isAddressEqual(quote, weth) || isAddressEqual(quote, NATIVE)) return { suffix: '' };
    const via = bridges.get(quote.toLowerCase());
    return via ? { via, suffix: ` via ${stableSymbol(ctx, quote)}` } : null;
  };

  for (const p of v2Live) {
    const v = viaFor(p.quote);
    if (!v || v.via?.v4Key) continue;
    out.push({
      venueId: 'uniswap',
      id: p.pair.toLowerCase(),
      label: `Uniswap v2${v.suffix}`,
      token,
      data: {
        kind: 'v2',
        pair: p.pair,
        quote: p.quote,
        token0: p.token0,
        ...(v.via ? { via: v.via } : {}),
      },
    });
  }
  for (const p of v3Live) {
    const v = viaFor(p.b);
    if (!v || v.via?.v4Key) continue;
    out.push({
      venueId: 'uniswap',
      id: p.pool.toLowerCase(),
      label: `Uniswap v3 · ${feeLabel(p.fee)}${v.suffix}`,
      token,
      data: { kind: 'v3', pool: p.pool, quote: p.b, fee: p.fee, ...(v.via ? { via: v.via } : {}) },
    });
  }
  for (const c of v4Live) {
    const v = viaFor(c.quote);
    if (!v) continue;
    const hooked = c.key.hooks !== zeroAddress;
    out.push({
      venueId: 'uniswap',
      id: c.poolId,
      label: `Uniswap v4 · ${feeLabel(c.key.fee)}${hooked ? ' · hook' : ''}${v.suffix}`,
      token,
      data: {
        kind: 'v4',
        poolId: c.poolId,
        key: c.key,
        quote: c.quote,
        ...(v.via ? { via: v.via } : {}),
      },
    });
  }
  return out;
}

/** Uniswap v2 constant-product output with the 0.3% fee. */
function v2AmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps = 30n,
): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const inWithFee = amountIn * (10_000n - feeBps);
  return (inWithFee * reserveOut) / (reserveIn * 10_000n + inWithFee);
}

/** One pool, `token` against the pool's quote asset. buy = quote → token. */
async function quoteLeg(
  ctx: VenueCtx,
  pool: UniPool,
  token: Address,
  side: Side,
  amounts: readonly bigint[],
): Promise<(bigint | null)[]> {
  const d = deployment(ctx.chain.id);
  if (amounts.length === 0) return [];

  if (pool.kind === 'v2') {
    const [r0, r1] = await ctx.client.readContract({
      address: pool.pair,
      abi: v2PairAbi,
      functionName: 'getReserves',
    });
    const tokenIs0 = isAddressEqual(pool.token0, token);
    const [rToken, rQuote] = tokenIs0 ? [r0, r1] : [r1, r0];
    return amounts.map((a) =>
      side === 'buy' ? v2AmountOut(a, rQuote, rToken) : v2AmountOut(a, rToken, rQuote),
    );
  }

  if (pool.kind === 'v3') {
    const [tokenIn, tokenOut] = side === 'buy' ? [pool.quote, token] : [token, pool.quote];
    const res = await ctx.client.multicall({
      allowFailure: true,
      contracts: amounts.map(
        (amountIn) =>
          ({
            address: d.v3QuoterV2,
            abi: quoterV2Abi,
            functionName: 'quoteExactInputSingle',
            args: [{ tokenIn, tokenOut, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n }],
          }) as const,
      ),
    });
    return res.map((r) =>
      r.status === 'success' ? ((r.result as readonly bigint[])[0] ?? null) : null,
    );
  }

  const tokenIs0 = isAddressEqual(pool.key.currency0, token);
  // buy: quote → token. zeroForOne means currency0 → currency1.
  const zeroForOne = side === 'buy' ? !tokenIs0 : tokenIs0;
  const res = await ctx.client.multicall({
    allowFailure: true,
    contracts: amounts.map(
      (exactAmount) =>
        ({
          address: d.v4Quoter,
          abi: v4QuoterAbi,
          functionName: 'quoteExactInputSingle',
          args: [{ poolKey: pool.key, zeroForOne, exactAmount, hookData: '0x' }],
        }) as const,
    ),
  });
  return res.map((r) =>
    r.status === 'success' ? ((r.result as readonly bigint[])[0] ?? null) : null,
  );
}

/** Runs `second` on the outputs of `first`, keeping each amount's position. */
export async function chainQuotes(
  amounts: readonly bigint[],
  first: (a: readonly bigint[]) => Promise<(bigint | null)[]>,
  second: (a: readonly bigint[]) => Promise<(bigint | null)[]>,
): Promise<(bigint | null)[]> {
  const mid = await first(amounts);
  const live = mid.flatMap((m, i) => (m !== null && m !== undefined && m > 0n ? [i] : []));
  const result: (bigint | null)[] = amounts.map(() => null);
  if (live.length === 0) return result;
  const outs = await second(live.map((i) => mid[i] as bigint));
  live.forEach((i, k) => (result[i] = outs[k] ?? null));
  return result;
}

function bridgePool(ctx: VenueCtx, via: Via): UniPool {
  if (via.v4Key) return { kind: 'v4', poolId: poolIdOf(via.v4Key), key: via.v4Key, quote: NATIVE };
  return { kind: 'v3', pool: via.pool, quote: ctx.chain.wrappedNative, fee: via.fee };
}

async function quote(
  ctx: VenueCtx,
  ref: PoolRef,
  side: Side,
  amounts: readonly bigint[],
): Promise<(bigint | null)[]> {
  const pool = ref.data as UniPool;
  if (!pool.via) return quoteLeg(ctx, pool, ref.token, side, amounts);
  const via = pool.via;
  const bridge = (s: Side) => (a: readonly bigint[]) =>
    quoteLeg(ctx, bridgePool(ctx, via), via.stable, s, a);
  const leg = (s: Side) => (a: readonly bigint[]) => quoteLeg(ctx, pool, ref.token, s, a);
  // buy: native → stable → token; sell: token → stable → native.
  return side === 'buy'
    ? chainQuotes(amounts, bridge('buy'), leg('buy'))
    : chainQuotes(amounts, leg('sell'), bridge('sell'));
}

/** Smallest non-zero minimum for a leg whose output stays in the router; the final leg carries the real minimum. */
const INNER_MIN = 1n;
/** Universal Router: "the router's whole balance of this token". */
const CONTRACT_BALANCE = 1n << 255n;

function buildBuy(ctx: VenueCtx, ref: PoolRef, p: BuyParams): TxDraft {
  const pool = ref.data as UniPool;
  const d = deployment(ctx.chain.id);
  const weth = ctx.chain.wrappedNative;
  const token = ref.token;
  const commands: Command[] = [];
  const via = pool.via;

  if (via?.v4Key && pool.kind === 'v4') {
    // Both legs v4, one unlock: native → hop asset, then its whole credit → token.
    commands.push({
      type: 'V4_SWAP',
      actions: [
        {
          type: 'SWAP_EXACT_IN_SINGLE',
          poolKey: via.v4Key,
          zeroForOne: isAddressEqual(via.v4Key.currency0, NATIVE),
          amountIn: p.amountIn,
          amountOutMinimum: INNER_MIN,
          minHopPriceX36: 0n,
          hookData: '0x',
        },
        {
          type: 'SWAP_EXACT_IN_SINGLE',
          poolKey: pool.key,
          zeroForOne: !isAddressEqual(pool.key.currency0, token),
          amountIn: OPEN_DELTA,
          amountOutMinimum: p.minOut,
          minHopPriceX36: 0n,
          hookData: '0x',
        },
        { type: 'SETTLE_ALL', currency: NATIVE, maxAmount: p.amountIn },
        { type: 'TAKE', currency: token, recipient: p.wallet, amount: OPEN_DELTA },
      ],
    });
  } else if (via) {
    commands.push({ type: 'WRAP_ETH', recipient: ADDRESS_THIS, amount: p.amountIn });
    const toStable = { tokenIn: weth, fee: via.fee, tokenOut: via.stable };
    if (pool.kind === 'v3') {
      // Both legs v3: one multi-hop path.
      commands.push({
        type: 'V3_SWAP_EXACT_IN',
        recipient: p.wallet,
        amountIn: p.amountIn,
        amountOutMin: p.minOut,
        path: [toStable, { tokenIn: via.stable, fee: pool.fee, tokenOut: token }],
        payerIsUser: false,
      });
    } else {
      // Native → stable into the router, then the router's whole stable balance → token.
      commands.push({
        type: 'V3_SWAP_EXACT_IN',
        recipient: ADDRESS_THIS,
        amountIn: p.amountIn,
        amountOutMin: INNER_MIN,
        path: [toStable],
        payerIsUser: false,
      });
      if (pool.kind === 'v2') {
        commands.push({
          type: 'V2_SWAP_EXACT_IN',
          recipient: p.wallet,
          amountIn: CONTRACT_BALANCE,
          amountOutMin: p.minOut,
          path: [via.stable, token],
          payerIsUser: false,
        });
      } else {
        const tokenIs0 = isAddressEqual(pool.key.currency0, token);
        commands.push({
          type: 'V4_SWAP',
          actions: [
            { type: 'SETTLE', currency: via.stable, amount: CONTRACT_BALANCE, payerIsUser: false },
            {
              type: 'SWAP_EXACT_IN_SINGLE',
              poolKey: pool.key,
              zeroForOne: !tokenIs0,
              amountIn: OPEN_DELTA,
              amountOutMinimum: p.minOut,
              minHopPriceX36: 0n,
              hookData: '0x',
            },
            { type: 'TAKE', currency: token, recipient: p.wallet, amount: OPEN_DELTA },
          ],
        });
      }
    }
  } else if (pool.kind === 'v2') {
    commands.push(
      { type: 'WRAP_ETH', recipient: ADDRESS_THIS, amount: p.amountIn },
      {
        type: 'V2_SWAP_EXACT_IN',
        recipient: p.wallet,
        amountIn: p.amountIn,
        amountOutMin: p.minOut,
        path: [weth, token],
        payerIsUser: false,
      },
    );
  } else if (pool.kind === 'v3') {
    commands.push(
      { type: 'WRAP_ETH', recipient: ADDRESS_THIS, amount: p.amountIn },
      {
        type: 'V3_SWAP_EXACT_IN',
        recipient: p.wallet,
        amountIn: p.amountIn,
        amountOutMin: p.minOut,
        path: [{ tokenIn: weth, fee: pool.fee, tokenOut: token }],
        payerIsUser: false,
      },
    );
  } else {
    const tokenIs0 = isAddressEqual(pool.key.currency0, token);
    const native = isAddressEqual(pool.quote, NATIVE);
    if (!native) commands.push({ type: 'WRAP_ETH', recipient: ADDRESS_THIS, amount: p.amountIn });
    const actions: V4Action[] = [
      {
        type: 'SWAP_EXACT_IN_SINGLE',
        poolKey: pool.key,
        zeroForOne: !tokenIs0,
        amountIn: p.amountIn,
        amountOutMinimum: p.minOut,
        minHopPriceX36: 0n,
        hookData: '0x',
      },
      native
        ? { type: 'SETTLE_ALL', currency: NATIVE, maxAmount: p.amountIn }
        : { type: 'SETTLE', currency: weth, amount: p.amountIn, payerIsUser: false },
      { type: 'TAKE', currency: token, recipient: p.wallet, amount: OPEN_DELTA },
    ];
    commands.push({ type: 'V4_SWAP', actions });
  }
  return { to: d.universalRouter, data: encodeExecute(commands, p.deadline), value: p.amountIn };
}

function buildSell(ctx: VenueCtx, ref: PoolRef, p: SellParams): TxDraft {
  const pool = ref.data as UniPool;
  const d = deployment(ctx.chain.id);
  const weth = ctx.chain.wrappedNative;
  const token = ref.token;
  const commands: Command[] = [];
  const via = pool.via;
  if (p.permit)
    commands.push({
      type: 'PERMIT2_PERMIT',
      permit: p.permit.permit,
      signature: p.permit.signature,
    });

  if (via?.v4Key && pool.kind === 'v4') {
    // token → hop asset, then its whole credit → native, in one unlock.
    commands.push({
      type: 'V4_SWAP',
      actions: [
        {
          type: 'SWAP_EXACT_IN_SINGLE',
          poolKey: pool.key,
          zeroForOne: isAddressEqual(pool.key.currency0, token),
          amountIn: p.amountIn,
          amountOutMinimum: INNER_MIN,
          minHopPriceX36: 0n,
          hookData: '0x',
        },
        {
          type: 'SWAP_EXACT_IN_SINGLE',
          poolKey: via.v4Key,
          zeroForOne: !isAddressEqual(via.v4Key.currency0, NATIVE),
          amountIn: OPEN_DELTA,
          amountOutMinimum: p.minOut,
          minHopPriceX36: 0n,
          hookData: '0x',
        },
        { type: 'SETTLE_ALL', currency: token, maxAmount: p.amountIn },
        { type: 'TAKE', currency: NATIVE, recipient: p.wallet, amount: OPEN_DELTA },
      ],
    });
  } else if (via) {
    const toNative = { tokenIn: via.stable, fee: via.fee, tokenOut: weth };
    if (pool.kind === 'v3') {
      commands.push({
        type: 'V3_SWAP_EXACT_IN',
        recipient: ADDRESS_THIS,
        amountIn: p.amountIn,
        amountOutMin: p.minOut,
        path: [{ tokenIn: token, fee: pool.fee, tokenOut: via.stable }, toNative],
        payerIsUser: true,
      });
    } else {
      // Token → stable into the router, then the router's whole stable balance → native.
      if (pool.kind === 'v2') {
        commands.push({
          type: 'V2_SWAP_EXACT_IN',
          recipient: ADDRESS_THIS,
          amountIn: p.amountIn,
          amountOutMin: INNER_MIN,
          path: [token, via.stable],
          payerIsUser: true,
        });
      } else {
        const tokenIs0 = isAddressEqual(pool.key.currency0, token);
        commands.push({
          type: 'V4_SWAP',
          actions: [
            {
              type: 'SWAP_EXACT_IN_SINGLE',
              poolKey: pool.key,
              zeroForOne: tokenIs0,
              amountIn: p.amountIn,
              amountOutMinimum: INNER_MIN,
              minHopPriceX36: 0n,
              hookData: '0x',
            },
            { type: 'SETTLE_ALL', currency: token, maxAmount: p.amountIn },
            { type: 'TAKE', currency: via.stable, recipient: ADDRESS_THIS, amount: OPEN_DELTA },
          ],
        });
      }
      commands.push({
        type: 'V3_SWAP_EXACT_IN',
        recipient: ADDRESS_THIS,
        amountIn: CONTRACT_BALANCE,
        amountOutMin: p.minOut,
        path: [toNative],
        payerIsUser: false,
      });
    }
    commands.push({ type: 'UNWRAP_WETH', recipient: p.wallet, amountMin: p.minOut });
  } else if (pool.kind === 'v2') {
    commands.push(
      {
        type: 'V2_SWAP_EXACT_IN',
        recipient: ADDRESS_THIS,
        amountIn: p.amountIn,
        amountOutMin: p.minOut,
        path: [token, weth],
        payerIsUser: true,
      },
      { type: 'UNWRAP_WETH', recipient: p.wallet, amountMin: p.minOut },
    );
  } else if (pool.kind === 'v3') {
    commands.push(
      {
        type: 'V3_SWAP_EXACT_IN',
        recipient: ADDRESS_THIS,
        amountIn: p.amountIn,
        amountOutMin: p.minOut,
        path: [{ tokenIn: token, fee: pool.fee, tokenOut: weth }],
        payerIsUser: true,
      },
      { type: 'UNWRAP_WETH', recipient: p.wallet, amountMin: p.minOut },
    );
  } else {
    const tokenIs0 = isAddressEqual(pool.key.currency0, token);
    const native = isAddressEqual(pool.quote, NATIVE);
    const actions: V4Action[] = [
      {
        type: 'SWAP_EXACT_IN_SINGLE',
        poolKey: pool.key,
        zeroForOne: tokenIs0,
        amountIn: p.amountIn,
        amountOutMinimum: p.minOut,
        minHopPriceX36: 0n,
        hookData: '0x',
      },
      { type: 'SETTLE_ALL', currency: token, maxAmount: p.amountIn },
      native
        ? { type: 'TAKE', currency: NATIVE, recipient: p.wallet, amount: OPEN_DELTA }
        : { type: 'TAKE', currency: weth, recipient: ADDRESS_THIS, amount: OPEN_DELTA },
    ];
    commands.push({ type: 'V4_SWAP', actions });
    if (!native) commands.push({ type: 'UNWRAP_WETH', recipient: p.wallet, amountMin: p.minOut });
  }
  return { to: d.universalRouter, data: encodeExecute(commands, p.deadline), value: 0n };
}

/**
 * Sells what was already transferred to the Universal Router (by the Celera Router, which
 * cannot sign Permit2): its whole balance of the token → native, paid to `p.wallet`.
 * v2/v3 pools only, direct or through a v3 stable hop.
 */
function buildSellPrefunded(
  ctx: VenueCtx,
  ref: PoolRef,
  p: Omit<BuyParams, 'amountIn'>,
): TxDraft | null {
  const pool = ref.data as UniPool;
  const weth = ctx.chain.wrappedNative;
  const token = ref.token;
  let swap: Command;
  if (pool.kind === 'v3') {
    const first = { tokenIn: token, fee: pool.fee, tokenOut: pool.via?.stable ?? weth };
    const hop =
      pool.via && !pool.via.v4Key
        ? [{ tokenIn: pool.via.stable, fee: pool.via.fee, tokenOut: weth }]
        : [];
    if (pool.via && hop.length === 0) return null;
    swap = {
      type: 'V3_SWAP_EXACT_IN',
      recipient: ADDRESS_THIS,
      amountIn: CONTRACT_BALANCE,
      amountOutMin: p.minOut,
      path: [first, ...hop],
      payerIsUser: false,
    };
  } else if (pool.kind === 'v2' && !pool.via) {
    swap = {
      type: 'V2_SWAP_EXACT_IN',
      recipient: ADDRESS_THIS,
      amountIn: CONTRACT_BALANCE,
      amountOutMin: p.minOut,
      path: [token, weth],
      payerIsUser: false,
    };
  } else return null;
  const commands: Command[] = [
    swap,
    { type: 'UNWRAP_WETH', recipient: p.wallet, amountMin: p.minOut },
  ];
  return {
    to: deployment(ctx.chain.id).universalRouter,
    data: encodeExecute(commands, p.deadline),
    value: 0n,
  };
}

export const uniswapVenue: Venue = {
  id: 'uniswap',
  supports: (chainId) => chainId in UNISWAP,
  discover,
  quote,
  buildBuy,
  buildSell,
  buildSellPrefunded,
  sellApproval: (ctx) => ({
    spender: PERMIT2,
    viaPermit2: true,
    router: deployment(ctx.chain.id).universalRouter,
  }),
};
