import {
  concat,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  maxUint256,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { erc20Abi } from '../../src/background/chain/abis';
import { ClientPool } from '../../src/background/chain/client';
import {
  ROUTER_NATIVE,
  TRANSFER_PERMIT_TYPES,
  buildTransferPermit,
  celeraRouterAbi,
  celeraRouterRule,
  encodeRouterExecute,
  legSupported,
  routerBuyCalls,
  routerSellCalls,
  type FundedRoute,
} from '../../src/background/trade/celera-router';
import { launchpadVenues } from '../../src/background/trade/launchpads';
import { permitDomain } from '../../src/background/trade/permit2';
import { Routing } from '../../src/background/trade/routing';
import type { VenueCtx } from '../../src/background/trade/types';
import { PERMIT2, UNISWAP } from '../../src/background/trade/uniswap/addresses';
import { uniswapVenue } from '../../src/background/trade/uniswap/venue';
import { extraVenues, venueRules } from '../../src/background/trade/venues';
import { validateTx, type ValidationContext } from '../../src/background/trade/validator';
import { getChain, type ChainConfig } from '../../src/shared/chains';

/**
 * The extension's Celera Router transactions, simulated against mainnet state on the
 * deployed router (the address in the chain config). Nothing is sent. Each trade is
 * validated first, exactly as the engine does before signing, and the deployed code is
 * checked to be the compiled router (`forge build` in contracts/).
 */

const artifacts = import.meta.glob('../../contracts/out/CeleraRouter.sol/CeleraRouter.json', {
  eager: true,
  import: 'default',
}) as Record<string, { bytecode: { object: Hex } }>;
const creation = Object.values(artifacts)[0]?.bytecode.object;

const routing = new Routing([uniswapVenue, ...extraVenues, ...launchpadVenues]);
const pool = new ClientPool();

function setup(chainId: number) {
  const chain: ChainConfig = getChain(chainId)!;
  const ctx: VenueCtx = {
    chain,
    client: pool.get(chain),
    now: Date.now,
    fetchJson: (u) => fetch(u).then((r) => r.json()),
  };
  return { chain, ctx };
}

/** Runtime code with Permit2 baked in, from running the constructor in an eth_call. */
async function routerCode(ctx: VenueCtx): Promise<Hex> {
  const args = encodeAbiParameters([{ type: 'address' }], [PERMIT2]);
  const { data } = await ctx.client.call({ data: concat([creation as Hex, args]) });
  expect(data && data.length > 1000).toBe(true);
  return data as Hex;
}

/** Buys with the router, then sells everything back, in one simulation. */
async function roundTrip(chainId: number, token: Address, venueId: string, eth: bigint) {
  const { chain, ctx } = setup(chainId);
  const ROUTER = chain.celeraRouter!;
  expect(ROUTER, 'router configured').toBeTruthy();
  const [route] = await routing.best(ctx, token, 'buy', [eth]);
  if (!route || route.venue.id !== venueId) return null;
  const funding = route.venue.funding?.(ctx, route.pool);
  expect(funding, 'funded pool').toBeTruthy();
  const legVenue = routing.venue(funding!.leg.venueId)!;
  expect(legSupported(ctx, legVenue, funding!.leg)).toBe(true);

  const user = privateKeyToAccount(generatePrivateKey());
  const block = await ctx.client.getBlock();
  const nowS = Number(block.timestamp);
  const r: FundedRoute = {
    ctx,
    router: ROUTER,
    wallet: user.address,
    venue: route.venue,
    pool: route.pool,
    legVenue,
    leg: funding!.leg,
    asset: funding!.asset,
    deadline: BigInt(nowS + 600),
  };
  const rules = new Map(venueRules(chainId));
  for (const [a, rule] of route.venue.poolRules?.(ctx, route.pool) ?? [])
    rules.set(a.toLowerCase(), rule);
  rules.set(ROUTER.toLowerCase(), celeraRouterRule(ROUTER));
  const vctx = (extra: Partial<ValidationContext>): ValidationContext => ({
    chain,
    from: user.address,
    ownWallets: [user.address],
    token,
    fundingAsset: funding!.asset,
    router: UNISWAP[chainId]?.universalRouter,
    extraContracts: rules,
    maxValue: parseEther('1'),
    nowS,
    ...extra,
  });
  const expectValid = (tx: { to: Address; data: Hex; value: bigint }, c: ValidationContext) => {
    const v = validateTx(tx, c);
    expect(v.ok, JSON.stringify(v.actions.filter((a) => !a.ok))).toBe(true);
  };

  // Buy: quotes as the engine takes them, 10% slippage for the live market.
  const [assetOut] = await legVenue.quote(ctx, funding!.leg, 'buy', [eth]);
  const minOut = (route.out * 90n) / 100n;
  const buyCalls = routerBuyCalls({
    ...r,
    amountIn: eth,
    assetMin: (assetOut! * 95n) / 100n,
    minOut,
  });
  const buy = {
    to: ROUTER,
    data: encodeRouterExecute({
      calls: buyCalls,
      tokenOut: token,
      minOut,
      sweep: [funding!.asset, chain.wrappedNative],
      deadline: r.deadline,
    }),
    value: eth,
  };
  expectValid(buy, vctx({}));

  // What is deployed is exactly the router built from contracts/ (Permit2 baked in).
  expect(await ctx.client.getCode({ address: ROUTER })).toBe(await routerCode(ctx));
  const overrides = [{ address: user.address, balance: parseEther('1') }];
  const first = await ctx.client.simulateCalls({
    account: user.address,
    blockNumber: block.number,
    stateOverrides: overrides,
    calls: [buy],
  });
  expect(first.results[0]?.status, String(first.results[0]?.error)).toBe('success');
  const bought = decodeFunctionResult({
    abi: celeraRouterAbi,
    functionName: 'execute',
    data: first.results[0]!.data,
  });
  expect(bought).toBeGreaterThanOrEqual(minOut);

  // Sell exactly what was bought: approve Permit2 once, then the router call with a permit.
  const sellOut = await routing.requote(ctx, route.pool, 'sell', bought);
  const [assetBack] = await funding!.quoteAsset(ctx, 'sell', [bought]);
  const sellMin = ((sellOut ?? 1n) * 85n) / 100n;
  const permit = buildTransferPermit(token, bought, nowS);
  const signature = await user.signTypedData({
    domain: permitDomain(chainId),
    types: TRANSFER_PERMIT_TYPES,
    primaryType: 'PermitTransferFrom',
    message: { ...permit, spender: ROUTER },
  });
  const sellCalls = routerSellCalls({
    ...r,
    assetMin: ((assetBack ?? 1n) * 85n) / 100n,
    minOut: sellMin,
  })!;
  const sell = {
    to: ROUTER,
    data: encodeRouterExecute({
      calls: sellCalls,
      permit: { permit, signature },
      tokenOut: ROUTER_NATIVE,
      minOut: sellMin,
      sweep: [token, funding!.asset, chain.wrappedNative],
      deadline: r.deadline,
    }),
    value: 0n,
  };
  expectValid(sell, vctx({ maxPermit: bought, maxValue: 0n }));

  const approve = {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [PERMIT2, maxUint256],
    }),
    value: 0n,
  };
  const all = await ctx.client.simulateCalls({
    account: user.address,
    blockNumber: block.number,
    stateOverrides: overrides,
    calls: [buy, approve, sell],
  });
  for (const x of all.results) expect(x.status, String(x.error)).toBe('success');
  const out = decodeFunctionResult({
    abi: celeraRouterAbi,
    functionName: 'execute',
    data: all.results[2]!.data,
  });
  return { bought, out, eth, label: route.pool.label };
}

/** The newest Virtuals curve token still trading on its curve (Base). */
async function liveVirtualsToken(): Promise<Address | null> {
  const { ctx } = setup(8453);
  const bonding = '0x1a540088125d00dd3990f9da45ca0859af4d3b01' as Address;
  const abi = parseAbi(['function tokenInfos(uint256) view returns (address)']);
  const at = (i: bigint) =>
    ctx.client.readContract({ address: bonding, abi, functionName: 'tokenInfos', args: [i] });
  let lo = 0n;
  let hi = 1n << 20n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (
      await at(mid).then(
        () => true,
        () => false,
      )
    )
      lo = mid;
    else hi = mid;
  }
  for (let i = lo; i > lo - 10n; i--) {
    const t = await at(i);
    if ((await routing.discover(ctx, t, true)).some((p) => p.venueId === 'virtuals')) return t;
  }
  return null;
}

describe.skipIf(!creation)('Celera Router (simulated on mainnet state)', () => {
  it('Base: Virtuals curve quoted in VIRTUAL, buy and sell in one transaction each', async (t) => {
    const token = await liveVirtualsToken();
    const res = token && (await roundTrip(8453, token, 'virtuals', parseEther('0.002')));
    if (!res) return t.skip();
    expect(res.out).toBeGreaterThan((res.eth * 80n) / 100n);
  });

  it('BSC: Flap curve quoted in PEPE, buy and sell in one transaction each', async (t) => {
    const res = await roundTrip(
      56,
      '0x2CC05d18F221eaD699866791B66B23937a697777',
      'flap',
      parseEther('0.01'),
    );
    if (!res) return t.skip();
    expect(res.label).toBe('Flap curve via PEPE');
    expect(res.out).toBeGreaterThan((res.eth * 85n) / 100n);
  });

  it('Robinhood: Pons curve quoted in USDG, buy and sell in one transaction each', async (t) => {
    const res = await roundTrip(
      4663,
      '0x227642e8A9dFb94873EeE4e316af9cE06659FCEd',
      'pons',
      parseEther('0.002'),
    );
    if (!res) return t.skip();
    expect(res.label).toBe('Pons curve via USDG');
    expect(res.out).toBeGreaterThan((res.eth * 85n) / 100n);
  });
});
