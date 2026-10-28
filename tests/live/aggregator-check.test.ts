import { parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { ClientPool } from '../../src/background/chain/client';
import { AggregatorCheck, simulatedBuyOut } from '../../src/background/trade/aggregator-check';
import { kyberVenue } from '../../src/background/trade/kyber';
import { launchpadVenues } from '../../src/background/trade/launchpads';
import { Routing } from '../../src/background/trade/routing';
import { TaxService, totalBuyBps } from '../../src/background/trade/tax';
import type { VenueCtx } from '../../src/background/trade/types';
import { uniswapVenue } from '../../src/background/trade/uniswap/venue';
import { extraVenues } from '../../src/background/trade/venues';
import { getChain } from '../../src/shared/chains';

/**
 * KyberSwap once quoted 0.005 BNB → CAKE ~1% above PancakeSwap through a pool it
 * misjudged and delivered 79% of its quote; the probe then read the gap as a 20.8% "tax".
 * Whatever Kyber routes today, a token without tax must measure 0 tax, and a Kyber route
 * that is still used must really deliver at least what PancakeSwap would.
 */
const chain = getChain(56)!;
const json = (r: Response) => r.json();
const headers = { 'x-client-id': 'celera', 'content-type': 'application/json' };
const ctx: VenueCtx = {
  chain,
  client: new ClientPool().get(chain),
  now: Date.now,
  fetchJson: (u) => fetch(u).then(json),
  aggregator: {
    get: (u) => fetch(u, { headers }).then(json),
    post: (u, body) => fetch(u, { method: 'POST', headers, body: JSON.stringify(body) }).then(json),
  },
};
const CAKE: Address = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';

describe('aggregator routes (BSC mainnet simulation, no funds)', () => {
  it('CAKE: no tax through any route, and a used Kyber route really pays more', async () => {
    const routing = new Routing([uniswapVenue, ...extraVenues, ...launchpadVenues], [kyberVenue]);
    const tax = new TaxService(routing);
    const check = new AggregatorCheck(routing, tax);
    const amounts = ['0.005', '0.02', '0.05', '0.1'].map((a) => parseEther(a));
    const routes = await routing.best(ctx, CAKE, 'buy', amounts);

    for (const [i, route] of routes.entries()) {
      if (!route) continue;
      const amount = amounts[i] as bigint;
      const t = await tax.get(ctx, route, amount);
      expect(t && totalBuyBps(t), `tax via ${route.venue.id}`).toBe(0);
      if (!routing.isFallback(route.venue)) continue;
      const trusted = await check.trusted(ctx, route, amount);
      const [own] = await routing.best(ctx, CAKE, 'buy', [amount], { own: true });
      if (trusted) {
        const got = await simulatedBuyOut(ctx, route, amount);
        expect(got === null || got >= (own?.out ?? 0n), 'Kyber fill below own pool').toBe(true);
      } else {
        const [after] = await routing.best(ctx, CAKE, 'buy', [amount]);
        expect(after?.venue.id).not.toBe('kyber');
      }
    }
  });
});
