import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { AggregatorCheck } from '../src/background/trade/aggregator-check';
import { Routing, type Routed } from '../src/background/trade/routing';
import { TaxService, type TaxInfo } from '../src/background/trade/tax';
import type { PoolRef, Venue, VenueCtx } from '../src/background/trade/types';
import { getChain } from '../src/shared/chains';

const TOKEN: Address = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
let now = 1_000_000;
const ctx: VenueCtx = { chain: getChain(56)!, client: {} as never, now: () => now };

/** A venue quoting `rate` tokens per unit in, or nothing. */
function venue(id: string, rate: bigint | null): Venue {
  return {
    id,
    supports: () => true,
    discover: async (_c, token) =>
      rate === null ? [] : [{ venueId: id, id, label: id, token, data: null } satisfies PoolRef],
    quote: async (_c, _p, _s, amounts) => amounts.map((a) => (rate === null ? null : a * rate)),
    buildBuy: () => ({ to: TOKEN, data: '0x', value: 0n }),
    buildSell: () => ({ to: TOKEN, data: '0x', value: 0n }),
    sellApproval: () => ({ spender: TOKEN, viaPermit2: false, router: TOKEN }),
  };
}

const info = (buyBps: number, venueBps = 0): TaxInfo => ({
  transfer: { buyBps, sellBps: 0 },
  venue: { buyBps: venueBps, sellBps: venueBps },
  sellFails: false,
});

describe('routing with an aggregator fallback', () => {
  const own = venue('pancake', 1000n);
  const kyber = venue('kyber', 1010n); // quotes 1% more
  const routing = () => new Routing([own], [kyber]);

  it('prefers the aggregator when it quotes clearly more', async () => {
    const [r] = await routing().best(ctx, TOKEN, 'buy', [10n]);
    expect(r?.venue.id).toBe('kyber');
  });

  it('never returns the aggregator for own-only lookups', async () => {
    const [r] = await routing().best(ctx, TOKEN, 'buy', [10n], { own: true });
    expect(r?.venue.id).toBe('pancake');
  });

  it('drops a distrusted aggregator while own pools can trade, for a while', async () => {
    const r = routing();
    r.distrust(ctx, TOKEN, 60_000);
    expect((await r.best(ctx, TOKEN, 'buy', [10n]))[0]?.venue.id).toBe('pancake');
    expect((await r.best(ctx, TOKEN, 'sell', [10n]))[0]?.venue.id).toBe('pancake');
    now += 60_001;
    expect((await r.best(ctx, TOKEN, 'buy', [10n]))[0]?.venue.id).toBe('kyber');
  });

  it("counts the aggregator route's extra gas: a better price can still cost more", async () => {
    // 2.8% more tokens, but the route's extra gas is twice the amount bought.
    const costly: Venue = { ...venue('kyber', 1028n), extraGasWei: (_c, _p, _s, a) => a * 2n };
    const r = new Routing([own], [costly]);
    expect((await r.best(ctx, TOKEN, 'buy', [10n]))[0]?.venue.id).toBe('pancake');
    // A trade large enough that the gas is a rounding error: the better price wins.
    const cheap: Venue = { ...venue('kyber', 1028n), extraGasWei: () => 1n };
    const big = new Routing([own], [cheap]);
    expect((await big.best(ctx, TOKEN, 'buy', [10_000n]))[0]?.venue.id).toBe('kyber');
    // Sells: the gas comes out of the native received.
    const sellCostly: Venue = { ...venue('kyber', 1028n), extraGasWei: () => 1_000n };
    const s = new Routing([own], [sellCostly]);
    expect((await s.best(ctx, TOKEN, 'sell', [10n]))[0]?.venue.id).toBe('pancake');
  });

  it('keeps a distrusted aggregator when it is the only way to trade the token', async () => {
    const r = new Routing([venue('pancake', null)], [kyber]);
    r.distrust(ctx, TOKEN, 60_000);
    expect((await r.best(ctx, TOKEN, 'buy', [10n]))[0]?.venue.id).toBe('kyber');
  });
});

describe('tax of aggregator-routed tokens', () => {
  const own = venue('pancake', 1000n);
  const kyber = venue('kyber', 1010n);

  it('is measured on the own pool, never on the aggregator route', async () => {
    const probed: string[] = [];
    const tax = new TaxService(new Routing([own], [kyber]), async (_c, v) => {
      probed.push(v.id);
      return info(0, 100);
    });
    const kyberRoute: Routed = {
      venue: kyber,
      pool: { venueId: 'kyber', id: 'kyber', label: 'KyberSwap', token: TOKEN, data: null },
      out: 10_100n,
    };
    const t = await tax.get(ctx, kyberRoute, 10n);
    expect(probed).toEqual(['pancake']);
    // The own pool's venue fee does not apply on the aggregator's path.
    expect(t?.venue).toEqual({ buyBps: 0, sellBps: 0 });
    expect(tax.peek(ctx, kyberRoute)?.transfer.buyBps).toBe(0);
  });

  it('is unknown when no own pool trades the token', async () => {
    const tax = new TaxService(new Routing([venue('pancake', null)], [kyber]), async () =>
      info(2080),
    );
    const kyberRoute: Routed = {
      venue: kyber,
      pool: { venueId: 'kyber', id: 'kyber', label: 'KyberSwap', token: TOKEN, data: null },
      out: 10_100n,
    };
    expect(await tax.get(ctx, kyberRoute, 10n)).toBeNull();
    // Remembered as unknown (shown as "Tax ?"), not looked up again on every refresh.
    expect(tax.peek(ctx, kyberRoute)).toBeNull();
  });
});

describe('aggregator fill check', () => {
  const own = venue('pancake', 1000n);
  const kyber = venue('kyber', 1010n);
  const kyberRoute = (out: bigint): Routed => ({
    venue: kyber,
    pool: { venueId: 'kyber', id: 'kyber', label: 'KyberSwap', token: TOKEN, data: null },
    out,
  });

  it('drops the aggregator for the token when its fill is worse than the own pool', async () => {
    // Quoted 10 100, delivers 7 920 (79.2%, as seen on BSC); the own pool gives 10 000.
    const routing = new Routing([own], [kyber]);
    const check = new AggregatorCheck(
      routing,
      new TaxService(routing, async () => info(0)),
      async () => 7_920n,
    );
    expect(await check.trusted(ctx, kyberRoute(10_100n), 10n)).toBe(false);
    expect((await routing.best(ctx, TOKEN, 'buy', [10n]))[0]?.venue.id).toBe('pancake');
  });

  it('keeps the aggregator when its fill beats the own pool after the token tax', async () => {
    const routing = new Routing([own], [kyber]);
    // A real 5% token tax: the own pool would deliver 9 500, the aggregator delivers 9 595.
    const check = new AggregatorCheck(
      routing,
      new TaxService(routing, async () => info(500)),
      async () => 9_595n,
    );
    expect(await check.trusted(ctx, kyberRoute(10_100n), 10n)).toBe(true);
    expect((await routing.best(ctx, TOKEN, 'buy', [10n]))[0]?.venue.id).toBe('kyber');
  });

  it('treats a reverting aggregator buy as a failed fill, and an unsimulatable one as unknown', async () => {
    const routing = new Routing([own], [kyber]);
    const tax = new TaxService(routing, async () => info(0));
    expect(
      await new AggregatorCheck(routing, tax, async () => 0n).trusted(
        ctx,
        kyberRoute(10_100n),
        10n,
      ),
    ).toBe(false);
    const r2 = new Routing([own], [kyber]);
    expect(
      await new AggregatorCheck(r2, tax, async () => null).trusted(ctx, kyberRoute(10_100n), 10n),
    ).toBe(true);
  });

  it('does not check routes of Celera’s own pools', async () => {
    const routing = new Routing([own], [kyber]);
    let simulated = false;
    const check = new AggregatorCheck(routing, new TaxService(routing), async () => {
      simulated = true;
      return 0n;
    });
    const ownRoute: Routed = {
      venue: own,
      pool: { venueId: 'pancake', id: 'pancake', label: 'pancake', token: TOKEN, data: null },
      out: 10_000n,
    };
    expect(await check.trusted(ctx, ownRoute, 10n)).toBe(true);
    expect(simulated).toBe(false);
  });
});
