import type { Venue } from './types';
import type { ExtraContractRule } from './validator';
import { v2RouterVenue } from './venues/v2router';
import { v3RouterVenue } from './venues/v3router';

// Addresses verified on-chain (router.factory() / WETH() and quoter.factory()).
const pancakeV2Bsc = v2RouterVenue({
  id: 'pancake-v2-bsc',
  label: 'PancakeSwap v2',
  chainId: 56,
  router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
  factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
  flavour: 'uniswap',
});

const pancakeV3Bsc = v3RouterVenue({
  id: 'pancake-v3-bsc',
  label: 'PancakeSwap v3',
  chainId: 56,
  router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
  factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
  fees: [100, 500, 2500, 10000],
});

// PancakeSwap v3 on Ethereum and Base (Clanker's Ethereum launches pair there).
const pancakeV3Eth = v3RouterVenue({
  id: 'pancake-v3-eth',
  label: 'PancakeSwap v3',
  chainId: 1,
  router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
  factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
  fees: [100, 500, 2500, 10000],
});

const pancakeV3Base = v3RouterVenue({
  id: 'pancake-v3-base',
  label: 'PancakeSwap v3',
  chainId: 8453,
  router: '0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86',
  factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
  fees: [100, 500, 2500, 10000],
});

const aerodromeBase = v2RouterVenue({
  id: 'aerodrome-base',
  label: 'Aerodrome',
  chainId: 8453,
  router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
  factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
  flavour: 'aerodrome',
});

const ALL = [pancakeV2Bsc, pancakeV3Bsc, pancakeV3Eth, pancakeV3Base, aerodromeBase];

/** Non-Uniswap AMMs. Adding one = one entry here (plus its addresses). */
export const extraVenues: Venue[] = ALL.map((v) => v.venue);

/** Validator rules for these venues' routers, keyed by lowercase address. */
export function venueRules(chainId: number): Map<string, ExtraContractRule> {
  const m = new Map<string, ExtraContractRule>();
  for (const v of ALL) {
    if (v.venue.supports(chainId)) {
      const router = v.venue.sellApproval({} as never, {} as never).router;
      m.set(router.toLowerCase(), v.rule);
    }
  }
  return m;
}
