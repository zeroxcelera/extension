import {
  encodeFunctionData,
  parseAbi,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import type { PoolRef, Venue, VenueCtx } from '../src/background/trade/types';
import { UNISWAP } from '../src/background/trade/uniswap/addresses';
import {
  ADDRESS_THIS,
  encodeExecute,
  encodeV3Path,
  type Command,
} from '../src/background/trade/uniswap/codec';
import { chainQuotes, uniswapVenue, type UniPool } from '../src/background/trade/uniswap/venue';
import { validateTx, type ValidationContext } from '../src/background/trade/validator';
import { extraVenues, venueRules } from '../src/background/trade/venues';
import { getChain } from '../src/shared/chains';

const base = getChain(8453)!;
const bsc = getChain(56)!;
const UR = UNISWAP[8453]!.universalRouter;
const WETH = base.wrappedNative;
const USDC = base.stablecoins[0]!.address;
const TOKEN: Address = '0x532f27101965dd16442E59d40670FaF5eBB142E4';
const RANDOM: Address = '0x4200000000000000000000000000000000000042';
const ME: Address = '0x1111111111111111111111111111111111111111';
const ATTACKER: Address = '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0';
const NOW = 1_800_000_000;
const DEADLINE = BigInt(NOW + 300);

function vctx(chainId: number, token = TOKEN): ValidationContext {
  const chain = getChain(chainId)!;
  return {
    chain,
    from: ME,
    ownWallets: [ME],
    token,
    router: UNISWAP[chainId]?.universalRouter,
    extraContracts: venueRules(chainId),
    maxValue: parseEther('1'),
    maxApproval: 1_000_000n,
    maxPermit: 1_000_000n,
    nowS: NOW,
  };
}
const venueCtx = (chainId: number) =>
  ({ chain: getChain(chainId)!, client: null, now: () => NOW * 1000 }) as unknown as VenueCtx;

function failing(r: ReturnType<typeof validateTx>) {
  return r.actions.filter((a) => !a.ok).map((a) => a.reason);
}

const via = { stable: USDC, pool: zeroAddress, fee: 500 };
const uniPools: PoolRef<UniPool>[] = [
  {
    venueId: 'uniswap',
    id: 'v2s',
    label: 'v2 via USDC',
    token: TOKEN,
    data: { kind: 'v2', pair: zeroAddress, quote: USDC, token0: TOKEN, via },
  },
  {
    venueId: 'uniswap',
    id: 'v3s',
    label: 'v3 via USDC',
    token: TOKEN,
    data: { kind: 'v3', pool: zeroAddress, quote: USDC, fee: 10000, via },
  },
  {
    venueId: 'uniswap',
    id: 'v4s',
    label: 'v4 via USDC',
    token: TOKEN,
    data: {
      kind: 'v4',
      poolId: '0x00',
      quote: USDC,
      key: { currency0: TOKEN, currency1: USDC, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
      via,
    },
  },
];

describe('stable-quoted routes: what Celera builds passes', () => {
  for (const p of uniPools) {
    it(`Uniswap ${p.label}: buy and sell`, () => {
      const c = venueCtx(8453);
      const buy = uniswapVenue.buildBuy(c, p, {
        wallet: ME,
        amountIn: parseEther('0.01'),
        minOut: 10n,
        deadline: DEADLINE,
      });
      const sell = uniswapVenue.buildSell(c, p, {
        wallet: ME,
        amountIn: 500n,
        minOut: 10n,
        deadline: DEADLINE,
      });
      expect(failing(validateTx(buy, vctx(8453)))).toEqual([]);
      expect(failing(validateTx(sell, vctx(8453)))).toEqual([]);
    });
  }

  const routerCases: [string, number, unknown][] = [
    ['pancake-v2-bsc', 56, { pair: zeroAddress, stable: false, via: bsc.stablecoins[0]!.address }],
    [
      'pancake-v3-bsc',
      56,
      { pool: zeroAddress, fee: 2500, via: { stable: bsc.stablecoins[2]!.address, fee: 100 } },
    ],
    ['aerodrome-base', 8453, { pair: zeroAddress, stable: true, via: USDC }],
  ];
  for (const [id, chainId, data] of routerCases) {
    it(`${id}: buy and sell through a stable`, () => {
      const venue = extraVenues.find((v) => v.id === id) as Venue;
      const ref: PoolRef = { venueId: id, id: 'x', label: id, token: TOKEN, data };
      const c = venueCtx(chainId);
      const buy = venue.buildBuy(c, ref, {
        wallet: ME,
        amountIn: parseEther('0.01'),
        minOut: 10n,
        deadline: DEADLINE,
      });
      const sell = venue.buildSell(c, ref, {
        wallet: ME,
        amountIn: 500n,
        minOut: 10n,
        deadline: DEADLINE,
      });
      expect(failing(validateTx(buy, vctx(chainId)))).toEqual([]);
      expect(failing(validateTx(sell, vctx(chainId)))).toEqual([]);
    });
  }
});

describe('stable-quoted routes: abuse is blocked', () => {
  const ur = (commands: Command[], value = parseEther('0.01')) => ({
    to: UR,
    data: encodeExecute(commands, DEADLINE),
    value,
  });
  const wrap: Command = { type: 'WRAP_ETH', recipient: ADDRESS_THIS, amount: parseEther('0.01') };

  it('stable left in the router (anyone could sweep it)', () => {
    const r = validateTx(
      ur([
        wrap,
        {
          type: 'V3_SWAP_EXACT_IN',
          recipient: ADDRESS_THIS,
          amountIn: parseEther('0.009'),
          amountOutMin: 1n,
          path: [{ tokenIn: WETH, fee: 500, tokenOut: USDC }],
          payerIsUser: false,
        },
        {
          type: 'V3_SWAP_EXACT_IN',
          recipient: ME,
          amountIn: parseEther('0.001'),
          amountOutMin: 1n,
          path: [{ tokenIn: WETH, fee: 3000, tokenOut: TOKEN }],
          payerIsUser: false,
        },
      ]),
      vctx(8453),
    );
    expect(r.ok).toBe(false);
    expect(failing(r)).toContain('Left in the router instead of being swapped on');
  });

  it('stable taken out of a v4 swap into the router and not used', () => {
    const r = validateTx(
      ur(
        [
          {
            type: 'V4_SWAP',
            actions: [
              {
                type: 'SWAP_EXACT_IN_SINGLE',
                poolKey: {
                  currency0: TOKEN,
                  currency1: USDC,
                  fee: 3000,
                  tickSpacing: 60,
                  hooks: zeroAddress,
                },
                zeroForOne: true,
                amountIn: 100n,
                amountOutMinimum: 1n,
                minHopPriceX36: 0n,
                hookData: '0x',
              },
              { type: 'SETTLE_ALL', currency: TOKEN, maxAmount: 100n },
              { type: 'TAKE', currency: USDC, recipient: ADDRESS_THIS, amount: 0n },
            ],
          },
          { type: 'UNWRAP_WETH', recipient: ME, amountMin: 1n },
        ],
        0n,
      ),
      vctx(8453),
    );
    expect(failing(r)).toContain('Left in the router instead of being swapped on');
  });

  it('native → stable paid to an attacker', () => {
    const r = validateTx(
      ur([
        wrap,
        {
          type: 'V3_SWAP_EXACT_IN',
          recipient: ATTACKER,
          amountIn: parseEther('0.01'),
          amountOutMin: 1n,
          path: [{ tokenIn: WETH, fee: 500, tokenOut: USDC }],
          payerIsUser: false,
        },
      ]),
      vctx(8453),
    );
    expect(r.ok).toBe(false);
  });

  it('a non-stable asset in the middle of a Universal Router path', () => {
    const r = validateTx(
      ur([
        wrap,
        {
          type: 'V3_SWAP_EXACT_IN',
          recipient: ME,
          amountIn: parseEther('0.01'),
          amountOutMin: 1n,
          path: [
            { tokenIn: WETH, fee: 500, tokenOut: TOKEN },
            { tokenIn: TOKEN, fee: 500, tokenOut: WETH },
            { tokenIn: WETH, fee: 3000, tokenOut: TOKEN },
          ],
          payerIsUser: false,
        },
      ]),
      vctx(8453),
    );
    expect(failing(r)).toContain('Only a stablecoin may sit between native and the token');
  });

  it('an unlisted asset as the hop on a v2 router', () => {
    const abi = parseAbi([
      'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256, address[], address, uint256) payable',
    ]);
    const tx = {
      to: '0x10ED43C718714eb63d5aA57B78B54704E256024E' as Address,
      data: encodeFunctionData({
        abi,
        functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
        args: [1n, [bsc.wrappedNative, RANDOM, TOKEN], ME, DEADLINE],
      }),
      value: parseEther('0.01'),
    };
    expect(failing(validateTx(tx, vctx(56)))).toContain(
      'Only a stablecoin may sit between native and the token',
    );
    const twoHops = {
      ...tx,
      data: encodeFunctionData({
        abi,
        functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
        args: [1n, [bsc.wrappedNative, bsc.stablecoins[0]!.address, RANDOM, TOKEN], ME, DEADLINE],
      }),
    };
    expect(failing(validateTx(twoHops, vctx(56)))).toContain(
      'Only direct swaps or one stablecoin hop are allowed',
    );
  });

  it('an unlisted asset as the hop on a v3 router', () => {
    const abi = parseAbi([
      'struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }',
      'function exactInput(ExactInputParams params) payable returns (uint256)',
      'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
    ]);
    const inner = encodeFunctionData({
      abi,
      functionName: 'exactInput',
      args: [
        {
          path: encodeV3Path([
            { tokenIn: bsc.wrappedNative, fee: 500, tokenOut: RANDOM },
            { tokenIn: RANDOM, fee: 500, tokenOut: TOKEN },
          ]),
          recipient: ME,
          amountIn: parseEther('0.01'),
          amountOutMinimum: 1n,
        },
      ],
    });
    const tx = {
      to: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4' as Address,
      data: encodeFunctionData({
        abi,
        functionName: 'multicall',
        args: [DEADLINE, [inner as Hex]],
      }),
      value: parseEther('0.01'),
    };
    expect(failing(validateTx(tx, vctx(56)))).toContain(
      'Only a stablecoin may sit between native and the token',
    );
  });
});

describe('chainQuotes', () => {
  it('keeps each amount in place and skips failed first legs', async () => {
    const out = await chainQuotes(
      [1n, 2n, 3n],
      async (a) => a.map((x) => (x === 2n ? null : x * 10n)),
      async (a) => a.map((x) => x + 1n),
    );
    expect(out).toEqual([11n, null, 31n]);
  });
});
