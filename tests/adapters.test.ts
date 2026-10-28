import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { detect } from '../src/content/adapters';

const T = '0x988635ef13f78daf7022f6109dbf6b02f35c7777';
const T_CS = getAddress(T);
const POOL = '0xe96c99be1ffcc204714ebce32870ab12b8b362308fa50b9352c03b2486a5d448';

describe('detect', () => {
  it.each([
    [`https://gmgn.ai/bsc/token/${T}`, { siteId: 'gmgn', kind: 'token', chainId: 56 }],
    [`https://gmgn.ai/base/token/${T}?tab=activity`, { kind: 'token', chainId: 8453 }],
    [`https://gmgn.ai/eth/token/${T}`, { kind: 'token', chainId: 1 }],
    [`https://gmgn.ai/robinhood/token/${T}`, { kind: 'token', chainId: 4663 }],
    [`https://gmgn.ai/bsc/token/abc123_${T}`, { kind: 'token', chainId: 56 }],
    [`https://dexscreener.com/base/${T}`, { siteId: 'dexscreener', kind: 'pair', chainId: 8453 }],
    [`https://dexscreener.com/ethereum/${T}`, { kind: 'pair', chainId: 1 }],
    [
      `https://www.dextools.io/app/en/ether/pair-explorer/${T}`,
      { siteId: 'dextools', kind: 'pair', chainId: 1 },
    ],
    [
      `https://www.geckoterminal.com/bsc/pools/${T}`,
      { siteId: 'geckoterminal', kind: 'pair', chainId: 56 },
    ],
    [
      `https://birdeye.so/token/${T}?chain=base`,
      { siteId: 'birdeye', kind: 'token', chainId: 8453 },
    ],
    [`https://four.meme/token/${T}`, { siteId: 'generic', kind: 'unknown', chainId: 56 }],
    [`https://flap.sh/bnb/${T}`, { siteId: 'generic', kind: 'unknown', chainId: 56 }],
    [`https://flap.sh/base/${T}`, { kind: 'unknown', chainId: 8453 }],
    [`https://zora.co/coin/base:${T}`, { kind: 'unknown', chainId: 8453 }],
    [`https://www.ponsfamily.com/launchpad/${T}`, { kind: 'unknown', chainId: 4663 }],
    [
      `https://axiom.trade/meme/${T}?chain=bnb`,
      { siteId: 'generic', kind: 'unknown', chainId: 56 },
    ],
  ])('%s', (url, expected) => {
    const d = detect(url);
    expect(d).toMatchObject(expected);
    expect(d?.address).toBe(T_CS);
  });

  it('reads v4 pool ids', () => {
    expect(detect(`https://dexscreener.com/robinhood/${POOL}`)).toEqual({
      siteId: 'dexscreener',
      kind: 'pair',
      poolId: POOL,
      chainId: 4663,
    });
  });

  it('leaves the chain open when the URL has none', () => {
    const d = detect(`https://example.trade/t/${T}`);
    expect(d).toMatchObject({ kind: 'unknown', address: T_CS });
    expect(d?.chainId).toBeUndefined();
  });

  it.each([
    'https://gmgn.ai/?chain=bsc',
    `https://gmgn.ai/sol/token/${T}`,
    'https://dexscreener.com/base',
    `https://dexscreener.com/solana/${T}`,
    'https://example.com/',
    `http://gmgn.ai/bsc/token/${T}`,
    `https://gmgn.ai/bsc/token/${T}ff`,
    'not a url',
  ])('ignores %s', (url) => {
    expect(detect(url)).toBeNull();
  });
});
