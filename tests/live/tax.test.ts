import { parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { ClientPool } from '../../src/background/chain/client';
import { launchpadVenues } from '../../src/background/trade/launchpads';
import { Routing } from '../../src/background/trade/routing';
import { probeTax } from '../../src/background/trade/tax';
import type { VenueCtx } from '../../src/background/trade/types';
import { uniswapVenue } from '../../src/background/trade/uniswap/venue';
import { extraVenues } from '../../src/background/trade/venues';
import { getChain } from '../../src/shared/chains';

const routing = new Routing([uniswapVenue, ...extraVenues, ...launchpadVenues]);
const pool = new ClientPool();

/** Tax-free tokens: the probe must report ~0 transfer tax and a working sell. */
const CASES: [string, number, Address, string][] = [
  [
    'UNI on Ethereum (Uniswap, Permit2 sell)',
    1,
    '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    '0.001',
  ],
  ['DEGEN on Base', 8453, '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', '0.0005'],
  ['CAKE on BSC', 56, '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', '0.001'],
];

describe('tax probe (mainnet simulation, no funds)', () => {
  it.each(CASES)(
    '%s',
    async (_label, chainId, token, amount) => {
      const chain = getChain(chainId)!;
      const ctx: VenueCtx = { chain, client: pool.get(chain), now: Date.now };
      const amountIn = parseEther(amount);
      const [route] = await routing.best(ctx, token, 'buy', [amountIn]);
      expect(route).toBeTruthy();
      const info = await probeTax(ctx, route!.venue, route!.pool, amountIn, route!.out);
      expect(info, route!.pool.label).not.toBeNull();
      expect(info!.sellFails).toBe(false);
      expect(info!.transfer.buyBps).toBeLessThan(50);
      expect(info!.transfer.sellBps ?? 0).toBeLessThan(50);
    },
    60_000,
  );
});
