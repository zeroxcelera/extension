import {
  decodeFunctionData,
  encodeFunctionData,
  maxUint256,
  parseAbi,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ALL_VALUE,
  ROUTER_NATIVE,
  buildTransferPermit,
  celeraRouterAbi,
  celeraRouterRule,
  checkTransferPermit,
  encodeRouterExecute,
  injected,
  legSupported,
  routerBuyCalls,
  routerSellCalls,
  type FundedRoute,
  type RouterCall,
} from '../src/background/trade/celera-router';
import { launchpadVenues } from '../src/background/trade/launchpads';
import type { PoolRef, Venue, VenueCtx } from '../src/background/trade/types';
import { PERMIT2, UNISWAP } from '../src/background/trade/uniswap/addresses';
import { uniswapVenue, type UniPool } from '../src/background/trade/uniswap/venue';
import { extraVenues, venueRules } from '../src/background/trade/venues';
import { validateTx, type ValidationContext } from '../src/background/trade/validator';
import { getChain } from '../src/shared/chains';
import type { ChainConfig } from '../src/shared/chains';

const ROUTER: Address = '0xce1e7a0000000000000000000000000000000001';
const ME: Address = '0x1111111111111111111111111111111111111111';
const ATTACKER: Address = '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0';
const NOW = 1_800_000_000;
const SIG = `0x${'11'.repeat(65)}` as Hex;

const venue = (id: string) =>
  [...launchpadVenues, ...extraVenues, uniswapVenue].find((v) => v.id === id) as Venue;

function setup(chainId: number) {
  const chain: ChainConfig = { ...getChain(chainId)!, celeraRouter: ROUTER };
  const ctx: VenueCtx = { chain, client: {} as never, now: () => NOW * 1000 };
  return { chain, ctx };
}

// BSC: a Flap curve quoted in PEPE, funded through PancakeSwap v2.
const bsc = setup(56);
const PEPE: Address = '0x25d887Ce7a35172C62FeBFD67a1856F20FaEbB00';
const FLAP_TOKEN: Address = '0x2CC05d18F221eaD699866791B66B23937a697777';
const PORTAL: Address = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
const pepeLeg: PoolRef = {
  venueId: 'pancake-v2-bsc',
  id: 'pepe-wbnb',
  label: 'PancakeSwap v2',
  token: PEPE,
  data: { pair: '0x0000000000000000000000000000000000000abc', stable: false },
};
const flapPool: PoolRef = {
  venueId: 'flap',
  id: `flap:${FLAP_TOKEN.toLowerCase()}`,
  label: 'Flap curve via PEPE',
  token: FLAP_TOKEN,
  data: { portal: PORTAL, quote: PEPE, symbol: 'PEPE', leg: pepeLeg },
};

// Robinhood: a Pons curve quoted in USDG, funded through Uniswap v3 (Universal Router).
const rh = setup(4663);
const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NOODS: Address = '0x227642e8A9dFb94873EeE4e316af9cE06659FCEd';
const CURVE: Address = '0xA61E57E11e7a1765925aA1532073caAc52567c87';
const usdgLeg: PoolRef<UniPool> = {
  venueId: 'uniswap',
  id: 'usdg-weth',
  label: 'Uniswap v3',
  token: USDG,
  data: {
    kind: 'v3',
    pool: '0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca',
    quote: rh.chain.wrappedNative,
    fee: 100,
  },
};
const ponsPool: PoolRef = {
  venueId: 'pons',
  id: `pons:${CURVE.toLowerCase()}`,
  label: 'Pons curve via USDG',
  token: NOODS,
  data: { curve: CURVE, quote: USDG, symbol: 'USDG', leg: usdgLeg },
};

function route(ctx: VenueCtx, pool: PoolRef, leg: PoolRef, asset: Address): FundedRoute {
  return {
    ctx,
    router: ROUTER,
    wallet: ME,
    venue: venue(pool.venueId),
    pool,
    legVenue: venue(leg.venueId),
    leg,
    asset,
    deadline: BigInt(NOW + 600),
  };
}

function vctx(
  s: { chain: ChainConfig; ctx: VenueCtx },
  r: FundedRoute,
  extra: Partial<ValidationContext> = {},
): ValidationContext {
  const rules = new Map(venueRules(s.chain.id));
  for (const [a, rule] of r.venue.poolRules?.(s.ctx, r.pool) ?? [])
    rules.set(a.toLowerCase(), rule);
  rules.set(ROUTER.toLowerCase(), celeraRouterRule(ROUTER));
  return {
    chain: s.chain,
    from: ME,
    ownWallets: [ME],
    token: r.pool.token,
    fundingAsset: r.asset,
    router: UNISWAP[s.chain.id]?.universalRouter,
    extraContracts: rules,
    maxValue: parseEther('1'),
    nowS: NOW,
    ...extra,
  };
}

const permit = {
  permitted: { token: FLAP_TOKEN, amount: 1000n },
  nonce: 7n,
  deadline: BigInt(NOW + 600),
};

function buyTx(r: FundedRoute, sweep: Address[], calls?: RouterCall[]) {
  const c =
    calls ?? routerBuyCalls({ ...r, amountIn: parseEther('0.01'), assetMin: 1n, minOut: 5n });
  return {
    to: ROUTER,
    data: encodeRouterExecute({
      calls: c,
      tokenOut: r.pool.token,
      minOut: 5n,
      sweep,
      deadline: r.deadline,
    }),
    value: parseEther('0.01'),
  };
}

function sellTx(r: FundedRoute, sweep: Address[], calls?: RouterCall[], p = permit) {
  const c = calls ?? routerSellCalls({ ...r, assetMin: 1n, minOut: 5n })!;
  return {
    to: ROUTER,
    data: encodeRouterExecute({
      calls: c,
      permit: { permit: p, signature: SIG },
      tokenOut: ROUTER_NATIVE,
      minOut: 5n,
      sweep,
      deadline: r.deadline,
    }),
    value: 0n,
  };
}

const reasons = (v: ReturnType<typeof validateTx>) =>
  v.actions.filter((a) => !a.ok).map((a) => a.reason);

describe('balance injection', () => {
  const approveAbi = parseAbi(['function approve(address,uint256)']);
  it('finds the amount word wherever the encoder put it', () => {
    const c = injected(PEPE, (a) => ({
      to: PEPE,
      data: encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [PORTAL, a] }),
      value: 0n,
    }));
    expect(c.injectOffset).toBe(36n);
    expect(c.data.endsWith('0'.repeat(64))).toBe(true);
  });

  it('matches the offsets proven in the fork tests', () => {
    const buy = routerBuyCalls({
      ...route(bsc.ctx, flapPool, pepeLeg, PEPE),
      amountIn: 1n,
      assetMin: 1n,
      minOut: 1n,
    });
    // Flap swapExactInput: selector, tuple offset, inputToken, outputToken, inputAmount.
    expect(buy[1]?.injectOffset).toBe(100n);
    expect(buy[1]?.spender).toBe(PORTAL);
    const sell = routerSellCalls({
      ...route(rh.ctx, ponsPool, usdgLeg, USDG),
      assetMin: 1n,
      minOut: 1n,
    })!;
    expect(sell[0]?.injectOffset).toBe(4n); // Pons sell(tokensIn, ...)
    expect(sell[1]?.injectOffset).toBe(36n); // USDG transfer to the Universal Router
  });

  it('refuses a call where the amount cannot be placed exactly once', () => {
    expect(() =>
      injected(PEPE, (a) => ({
        to: PEPE,
        data: encodeFunctionData({
          abi: parseAbi(['function f(uint256,uint256)']),
          functionName: 'f',
          args: [a, a],
        }),
        value: 0n,
      })),
    ).toThrow();
    expect(() => injected(PEPE, (a) => ({ to: PEPE, data: '0x', value: a }))).toThrow();
  });
});

describe('router plans', () => {
  it('builds a Flap buy and sell through PancakeSwap v2', () => {
    const r = route(bsc.ctx, flapPool, pepeLeg, PEPE);
    const buy = routerBuyCalls({ ...r, amountIn: 5n, assetMin: 1n, minOut: 1n });
    const pancake = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
    // No approve steps: the router lets each step's spender pull for that call only.
    expect(buy.map((c) => [c.target, c.spender])).toEqual([
      [pancake, zeroAddress],
      [PORTAL, PORTAL],
    ]);
    expect(buy[0]?.value).toBe(5n);
    const sell = routerSellCalls({ ...r, assetMin: 1n, minOut: 1n })!;
    expect(sell.map((c) => [c.target, c.spender])).toEqual([
      [PORTAL, PORTAL],
      [pancake, pancake],
    ]);
  });

  it('sells into a Uniswap leg by handing the asset to the Universal Router', () => {
    const r = route(rh.ctx, ponsPool, usdgLeg, USDG);
    expect(legSupported(rh.ctx, uniswapVenue, usdgLeg)).toBe(true);
    const sell = routerSellCalls({ ...r, assetMin: 1n, minOut: 1n })!;
    expect(sell.map((c) => c.target)).toEqual([CURVE, USDG, UNISWAP[4663]!.universalRouter]);
  });

  it('cannot sell into a v4 leg (the router cannot sign Permit2)', () => {
    const v4: PoolRef<UniPool> = {
      ...usdgLeg,
      data: {
        kind: 'v4',
        poolId: '0x01',
        key: {
          currency0: zeroAddress,
          currency1: USDG,
          fee: 500,
          tickSpacing: 10,
          hooks: zeroAddress,
        },
        quote: zeroAddress,
      },
    };
    expect(legSupported(rh.ctx, uniswapVenue, v4)).toBe(false);
  });
});

describe('validator: Celera Router', () => {
  const fr = route(bsc.ctx, flapPool, pepeLeg, PEPE);
  const pr = route(rh.ctx, ponsPool, usdgLeg, USDG);
  const flapSweep = [PEPE, bsc.chain.wrappedNative];
  const sellSweep = [FLAP_TOKEN, PEPE, bsc.chain.wrappedNative];

  it('passes a Flap buy and sell (PancakeSwap v2 leg)', () => {
    const v = validateTx(buyTx(fr, flapSweep), vctx(bsc, fr));
    expect(reasons(v)).toEqual([]);
    const s = validateTx(sellTx(fr, sellSweep), vctx(bsc, fr, { maxPermit: 1000n, maxValue: 0n }));
    expect(reasons(s)).toEqual([]);
  });

  it('passes a Pons buy and sell (Uniswap v3 leg)', () => {
    const v = validateTx(buyTx(pr, [USDG, rh.chain.wrappedNative]), vctx(rh, pr));
    expect(reasons(v)).toEqual([]);
    const p = { ...permit, permitted: { token: NOODS, amount: 1000n } };
    const s = validateTx(
      sellTx(pr, [NOODS, USDG, rh.chain.wrappedNative], undefined, p),
      vctx(rh, pr, { maxPermit: 1000n, maxValue: 0n }),
    );
    expect(reasons(s)).toEqual([]);
  });

  it('is off without a funded route', () => {
    const v = validateTx(buyTx(fr, flapSweep), vctx(bsc, fr, { fundingAsset: undefined }));
    expect(v.ok).toBe(false);
  });

  it('blocks spending someone else’s allowance (transferFrom)', () => {
    const calls = routerBuyCalls({ ...fr, amountIn: 1n, assetMin: 1n, minOut: 5n });
    calls.push({
      target: FLAP_TOKEN,
      value: 0n,
      data: encodeFunctionData({
        abi: parseAbi(['function transferFrom(address,address,uint256)']),
        functionName: 'transferFrom',
        args: [ATTACKER, ME, 1n],
      }),
      injectToken: zeroAddress,
      injectOffset: 0n,
      spender: zeroAddress,
    });
    expect(reasons(validateTx(buyTx(fr, flapSweep, calls), vctx(bsc, fr)))).toContain(
      'Unknown function',
    );
  });

  it('blocks calls to Permit2 and to the router itself', () => {
    for (const target of [PERMIT2, ROUTER]) {
      const calls = [
        {
          target,
          value: 0n,
          data: '0x00' as Hex,
          injectToken: zeroAddress,
          injectOffset: 0n,
          spender: zeroAddress,
        },
      ];
      expect(reasons(validateTx(buyTx(fr, flapSweep, calls), vctx(bsc, fr)))).toContain(
        'Permit2 and the router itself are off limits',
      );
    }
  });

  it('blocks approve steps, unknown spenders and hand-overs to anyone but the next step', () => {
    const [fund, curveBuy] = routerBuyCalls({ ...fr, amountIn: 1n, assetMin: 1n, minOut: 5n });
    const erc20 = parseAbi([
      'function approve(address,uint256)',
      'function transfer(address,uint256)',
    ]);
    const step = (fn: 'approve' | 'transfer', to: Address) =>
      injected(PEPE, (a) => ({
        to: PEPE,
        data: encodeFunctionData({ abi: erc20, functionName: fn, args: [to, a] }),
        value: 0n,
      }));
    const check = (calls: RouterCall[]) =>
      reasons(validateTx(buyTx(fr, flapSweep, calls), vctx(bsc, fr)));
    // Even to a known venue: an approval made by a step would outlive it.
    expect(check([fund!, step('approve', PORTAL), curveBuy!])).toContain(
      'Approvals are made by the router itself',
    );
    expect(check([fund!, { ...curveBuy!, spender: ATTACKER }])).toContain(
      'Spender is not an allowlisted venue',
    );
    expect(check([fund!, step('transfer', ATTACKER), curveBuy!])).toContain(
      'Recipient is not the next step',
    );
  });

  it('blocks approvals and hand-overs that are not the router’s exact balance', () => {
    const calls = routerBuyCalls({ ...fr, amountIn: 1n, assetMin: 1n, minOut: 5n });
    for (const injectToken of [zeroAddress, ROUTER_NATIVE]) {
      const bad = [
        calls[0]!,
        { ...calls[1]!, injectToken, injectOffset: injectToken === zeroAddress ? 0n : 100n },
      ];
      expect(reasons(validateTx(buyTx(fr, flapSweep, bad), vctx(bsc, fr)))).toContain(
        'Approval without an injected token amount',
      );
    }
    const sell = routerSellCalls({ ...pr, assetMin: 1n, minOut: 5n })!;
    sell[1] = { ...sell[1]!, injectToken: zeroAddress, injectOffset: 0n };
    const p = { ...permit, permitted: { token: NOODS, amount: 1000n } };
    expect(
      reasons(
        validateTx(
          sellTx(pr, [NOODS, USDG, rh.chain.wrappedNative], sell, p),
          vctx(rh, pr, { maxPermit: 1000n, maxValue: 0n }),
        ),
      ),
    ).toContain("Amount is not the router's balance");
  });

  it('blocks a curve buy paid to someone else', () => {
    const calls = routerBuyCalls({
      ...pr,
      wallet: ATTACKER,
      amountIn: 1n,
      assetMin: 1n,
      minOut: 5n,
    });
    expect(
      reasons(validateTx(buyTx(pr, [USDG, rh.chain.wrappedNative], calls), vctx(rh, pr))),
    ).toContain('Recipient is not one of your wallets');
  });

  it('blocks unknown contracts and out-of-range amount slots', () => {
    const calls = routerBuyCalls({ ...fr, amountIn: 1n, assetMin: 1n, minOut: 5n });
    const odd = [{ ...(calls[1] as RouterCall), target: ATTACKER }];
    expect(reasons(validateTx(buyTx(fr, flapSweep, odd), vctx(bsc, fr)))).toContain(
      'Contract is not on the allowlist',
    );
    const slot = [{ ...(calls[1] as RouterCall), injectOffset: 10_000n }];
    expect(reasons(validateTx(buyTx(fr, flapSweep, slot), vctx(bsc, fr)))).toContain(
      'Outside the call data',
    );
  });

  it('requires every touched asset to be returned', () => {
    expect(reasons(validateTx(buyTx(fr, [bsc.chain.wrappedNative]), vctx(bsc, fr)))).toContain(
      'Left in the router instead of returned to you',
    );
  });

  it('checks what comes out and the Permit2 pull', () => {
    const tx = buyTx(fr, flapSweep);
    const call = decodeFunctionData({ abi: celeraRouterAbi, data: tx.data });
    const args = [...call.args] as unknown[];
    args[2] = PEPE; // pays out the quote asset instead of the token
    const bad = {
      ...tx,
      data: encodeFunctionData({
        abi: celeraRouterAbi,
        functionName: 'execute',
        args: args as never,
      }),
    };
    expect(reasons(validateTx(bad, vctx(bsc, fr)))).toContain(
      'A buy must pay out the selected token',
    );

    const other = { ...permit, permitted: { token: PEPE, amount: 1000n } };
    expect(
      reasons(
        validateTx(
          sellTx(fr, sellSweep, undefined, other),
          vctx(bsc, fr, { maxPermit: 1000n, maxValue: 0n }),
        ),
      ),
    ).toContain('Permit is for a different token');
    expect(
      reasons(validateTx(sellTx(fr, sellSweep), vctx(bsc, fr, { maxPermit: 999n, maxValue: 0n }))),
    ).toContain('Permit amount is above the amount being sold');
  });

  it('caps the ether steps may spend', () => {
    const calls = routerBuyCalls({ ...fr, amountIn: parseEther('0.02'), assetMin: 1n, minOut: 5n });
    expect(reasons(validateTx(buyTx(fr, flapSweep, calls), vctx(bsc, fr)))).toContain(
      'Steps spend more than the transaction value',
    );
    const all = [{ ...(calls[0] as RouterCall), value: ALL_VALUE }, ...calls.slice(1)];
    expect(reasons(validateTx(buyTx(fr, flapSweep, all), vctx(bsc, fr)))).not.toContain(
      'Steps spend more than the transaction value',
    );
  });
});

describe('transfer permits', () => {
  it('uses a fresh random nonce and a short deadline', () => {
    const a = buildTransferPermit(FLAP_TOKEN, 5n, NOW);
    const b = buildTransferPermit(FLAP_TOKEN, 5n, NOW);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.nonce < 2n ** 248n).toBe(true);
    expect(a.deadline).toBe(BigInt(NOW + 600));
  });

  it('is checked against the configured router', () => {
    const c = vctx(bsc, route(bsc.ctx, flapPool, pepeLeg, PEPE), { maxPermit: 1000n });
    expect(checkTransferPermit(permit, ROUTER, c).ok).toBe(true);
    expect(checkTransferPermit(permit, ATTACKER, c).reason).toBe(
      'Spender is not the Celera Router',
    );
    const late = { ...permit, deadline: maxUint256 };
    expect(checkTransferPermit(late, ROUTER, c).ok).toBe(false);
  });
});
