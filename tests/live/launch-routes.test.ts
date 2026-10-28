import { parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { ClientPool } from '../../src/background/chain/client';
import { launchpadVenues } from '../../src/background/trade/launchpads';
import { Routing } from '../../src/background/trade/routing';
import type { VenueCtx } from '../../src/background/trade/types';
import { uniswapVenue } from '../../src/background/trade/uniswap/venue';
import { extraVenues } from '../../src/background/trade/venues';
import { getChain } from '../../src/shared/chains';

const routing = new Routing([uniswapVenue, ...extraVenues, ...launchpadVenues]);
const pool = new ClientPool();

/**
 * Launchpad tokens whose pools are only reachable through launchpad records (no pool
 * index): each must still get a route. Samples can die over time; replace them then.
 */
const CASES: [string, number, Address, RegExp][] = [
  ['Stockereum (v4 hook)', 1, '0x5d7602693a60afc4823991be8b25a83c84df78c2', /Uniswap v4/],
  ['Klik (v4 hook, native)', 1, '0xa7fc99ecb15f4cc732f8446071df06bea6bbbfb1', /Uniswap v4/],
  ['Bankr / Doppler (Base)', 8453, '0xB9B2F3016b5bC5D95B90D9eD48A60f6b5a8aabA3', /Uniswap v4/],
  [
    'Virtuals graduated (via VIRTUAL)',
    8453,
    '0x10c56f005a379f8eafc88ff5c3f40d30f0031ac9',
    /VIRTUAL|Uniswap/,
  ],
  ['Bankr / Doppler (Robinhood)', 4663, '0x100765a16f42636bd84ee1e86bc5107b84bcdba3', /Uniswap v4/],
];

describe('launchpad routes (mainnet reads, no funds)', () => {
  it.each(CASES)(
    '%s',
    async (_label, chainId, token, venue) => {
      const chain = getChain(chainId)!;
      const ctx: VenueCtx = {
        chain,
        client: pool.get(chain),
        now: Date.now,
        fetchJson: (u) => fetch(u).then((r) => r.json()),
      };
      const [route] = await routing.best(ctx, token, 'buy', [parseEther('0.0002')]);
      expect(route?.pool.label).toMatch(venue);
    },
    60_000,
  );
});
