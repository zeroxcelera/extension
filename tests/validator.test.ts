import {
  encodeFunctionData,
  parseAbi,
  parseEther,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { PERMIT2, UNISWAP } from '../src/background/trade/uniswap/addresses';
import {
  ADDRESS_THIS,
  MSG_SENDER,
  NATIVE,
  encodeExecute,
  type Command,
  type PermitSingle,
} from '../src/background/trade/uniswap/codec';
import { uniswapVenue, type UniPool } from '../src/background/trade/uniswap/venue';
import type { PoolRef, VenueCtx } from '../src/background/trade/types';
import {
  validatePermit,
  validateTx,
  type ValidationContext,
} from '../src/background/trade/validator';
import { getChain } from '../src/shared/chains';

const chain = getChain(8453)!;
const UR = UNISWAP[8453]!.universalRouter;
const WETH = chain.wrappedNative;
const TOKEN: Address = '0x532f27101965dd16442E59d40670FaF5eBB142E4';
const ME: Address = '0x1111111111111111111111111111111111111111';
const MY_OTHER: Address = '0x2222222222222222222222222222222222222222';
const ATTACKER: Address = '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0';
const NOW = 1_800_000_000;
const DEADLINE = BigInt(NOW + 300);
const SIG = `0x${'11'.repeat(65)}` as Hex;

const ctx: ValidationContext = {
  chain,
  from: ME,
  ownWallets: [ME, MY_OTHER],
  token: TOKEN,
  router: UR,
  maxValue: parseEther('0.05'),
  maxApproval: 1_000_000n,
  maxPermit: 500n,
  nowS: NOW,
};

const venueCtx = { chain, client: null, now: () => NOW * 1000 } as unknown as VenueCtx;
const pools: PoolRef<UniPool>[] = [
  {
    venueId: 'uniswap',
    id: 'v2',
    label: 'v2',
    token: TOKEN,
    data: { kind: 'v2', pair: zeroAddress, quote: WETH, token0: TOKEN },
  },
  {
    venueId: 'uniswap',
    id: 'v3',
    label: 'v3',
    token: TOKEN,
    data: { kind: 'v3', pool: zeroAddress, quote: WETH, fee: 10000 },
  },
  {
    venueId: 'uniswap',
    id: 'v4n',
    label: 'v4 native',
    token: TOKEN,
    data: {
      kind: 'v4',
      poolId: '0x00',
      quote: NATIVE,
      key: { currency0: NATIVE, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
    },
  },
  {
    venueId: 'uniswap',
    id: 'v4w',
    label: 'v4 weth',
    token: TOKEN,
    data: {
      kind: 'v4',
      poolId: '0x00',
      quote: WETH,
      key: { currency0: WETH, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
    },
  },
];

const permit: PermitSingle = {
  details: { token: TOKEN, amount: 400n, expiration: NOW + 1800, nonce: 0 },
  spender: UR,
  sigDeadline: BigInt(NOW + 1800),
};

function router(commands: Command[], value = 0n, deadline = DEADLINE) {
  return { to: UR, data: encodeExecute(commands, deadline), value };
}

function failing(r: ReturnType<typeof validateTx>) {
  return r.actions.filter((a) => !a.ok).map((a) => a.reason);
}

describe('validator: legitimate plans pass', () => {
  for (const p of pools) {
    it(`buy via ${p.label}`, () => {
      const tx = uniswapVenue.buildBuy(venueCtx, p, {
        wallet: ME,
        amountIn: parseEther('0.01'),
        minOut: 10n,
        deadline: DEADLINE,
      });
      const r = validateTx(tx, ctx);
      expect(failing(r)).toEqual([]);
      expect(r.ok).toBe(true);
    });

    it(`sell via ${p.label} with permit`, () => {
      const tx = uniswapVenue.buildSell(venueCtx, p, {
        wallet: ME,
        amountIn: 400n,
        minOut: 1n,
        deadline: DEADLINE,
        permit: { permit, signature: SIG },
      });
      expect(failing(validateTx(tx, ctx))).toEqual([]);
    });
  }

  it('bounded approve to Permit2', () => {
    const data = encodeFunctionData({
      abi: parseAbi(['function approve(address,uint256)']),
      functionName: 'approve',
      args: [PERMIT2, 1_000_000n],
    });
    expect(validateTx({ to: TOKEN, data, value: 0n }, ctx).ok).toBe(true);
  });

  it('native transfer between own wallets', () => {
    expect(validateTx({ to: MY_OTHER, data: '0x', value: parseEther('0.01') }, ctx).ok).toBe(true);
  });

  it('runs in well under 5 ms', () => {
    const tx = uniswapVenue.buildSell(venueCtx, pools[3]!, {
      wallet: ME,
      amountIn: 400n,
      minOut: 1n,
      deadline: DEADLINE,
      permit: { permit, signature: SIG },
    });
    validateTx(tx, ctx); // warm up
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) validateTx(tx, ctx);
    expect((performance.now() - t0) / 100).toBeLessThan(5);
  });
});

describe('validator: malicious payloads are blocked', () => {
  const cases: [string, { to: Address; data: Hex; value: bigint }, RegExp][] = [
    [
      'swap output to attacker',
      router(
        [
          { type: 'WRAP_ETH', recipient: ADDRESS_THIS, amount: parseEther('0.01') },
          {
            type: 'V3_SWAP_EXACT_IN',
            recipient: ATTACKER,
            amountIn: parseEther('0.01'),
            amountOutMin: 1n,
            path: [{ tokenIn: WETH, fee: 3000, tokenOut: TOKEN }],
            payerIsUser: false,
          },
        ],
        parseEther('0.01'),
      ),
      /not one of your wallets/,
    ],
    [
      'unwrap to attacker',
      router([
        {
          type: 'V2_SWAP_EXACT_IN',
          recipient: ADDRESS_THIS,
          amountIn: 1n,
          amountOutMin: 1n,
          path: [TOKEN, WETH],
          payerIsUser: true,
        },
        { type: 'UNWRAP_WETH', recipient: ATTACKER, amountMin: 1n },
      ]),
      /not one of your wallets/,
    ],
    [
      'sweep to attacker',
      router([{ type: 'SWEEP', token: WETH, recipient: ATTACKER, amountMin: 0n }]),
      /not one of your wallets/,
    ],
    [
      'output left in router (no step pays the user)',
      router(
        [
          { type: 'WRAP_ETH', recipient: ADDRESS_THIS, amount: parseEther('0.01') },
          {
            type: 'V3_SWAP_EXACT_IN',
            recipient: ADDRESS_THIS,
            amountIn: parseEther('0.01'),
            amountOutMin: 1n,
            path: [{ tokenIn: WETH, fee: 3000, tokenOut: TOKEN }],
            payerIsUser: false,
          },
        ],
        parseEther('0.01'),
      ),
      /No step sends the output/,
    ],
    [
      'swap into a different token',
      router(
        [
          { type: 'WRAP_ETH', recipient: ADDRESS_THIS, amount: parseEther('0.01') },
          {
            type: 'V2_SWAP_EXACT_IN',
            recipient: ME,
            amountIn: parseEther('0.01'),
            amountOutMin: 1n,
            path: [WETH, ATTACKER],
            payerIsUser: false,
          },
        ],
        parseEther('0.01'),
      ),
      /unexpected asset/,
    ],
    [
      'zero minimum output',
      router(
        [
          { type: 'WRAP_ETH', recipient: ADDRESS_THIS, amount: parseEther('0.01') },
          {
            type: 'V3_SWAP_EXACT_IN',
            recipient: ME,
            amountIn: parseEther('0.01'),
            amountOutMin: 0n,
            path: [{ tokenIn: WETH, fee: 3000, tokenOut: TOKEN }],
            payerIsUser: false,
          },
        ],
        parseEther('0.01'),
      ),
      /slippage/,
    ],
    [
      'v4 take to attacker',
      router(
        [
          {
            type: 'V4_SWAP',
            actions: [
              {
                type: 'SWAP_EXACT_IN_SINGLE',
                poolKey: {
                  currency0: NATIVE,
                  currency1: TOKEN,
                  fee: 3000,
                  tickSpacing: 60,
                  hooks: zeroAddress,
                },
                zeroForOne: true,
                amountIn: 1n,
                amountOutMinimum: 1n,
                minHopPriceX36: 0n,
                hookData: '0x',
              },
              { type: 'SETTLE_ALL', currency: NATIVE, maxAmount: 1n },
              { type: 'TAKE', currency: TOKEN, recipient: ATTACKER, amount: 0n },
            ],
          },
        ],
        1n,
      ),
      /not one of your wallets/,
    ],
    [
      'permit for a huge amount',
      router([
        {
          type: 'PERMIT2_PERMIT',
          permit: { ...permit, details: { ...permit.details, amount: 2n ** 159n } },
          signature: SIG,
        },
        {
          type: 'V2_SWAP_EXACT_IN',
          recipient: ME,
          amountIn: 1n,
          amountOutMin: 1n,
          path: [TOKEN, WETH],
          payerIsUser: true,
        },
      ]),
      /above the amount being sold/,
    ],
    [
      'permit for the attacker as spender',
      router([
        { type: 'PERMIT2_PERMIT', permit: { ...permit, spender: ATTACKER }, signature: SIG },
        {
          type: 'V2_SWAP_EXACT_IN',
          recipient: ME,
          amountIn: 1n,
          amountOutMin: 1n,
          path: [TOKEN, WETH],
          payerIsUser: true,
        },
      ]),
      /not the router/,
    ],
    [
      'far-future deadline',
      router([{ type: 'UNWRAP_WETH', recipient: ME, amountMin: 0n }], 0n, BigInt(NOW + 86_400)),
      /Deadline/,
    ],
    [
      'value above the per-tx limit',
      router(
        [
          { type: 'WRAP_ETH', recipient: ADDRESS_THIS, amount: parseEther('1') },
          { type: 'UNWRAP_WETH', recipient: ME, amountMin: 0n },
        ],
        parseEther('1'),
      ),
      /per-transaction limit/,
    ],
    [
      'unlimited approval',
      {
        to: TOKEN,
        data: encodeFunctionData({
          abi: parseAbi(['function approve(address,uint256)']),
          functionName: 'approve',
          args: [PERMIT2, 2n ** 256n - 1n],
        }),
        value: 0n,
      },
      /bounded amount/,
    ],
    [
      'approval to attacker',
      {
        to: TOKEN,
        data: encodeFunctionData({
          abi: parseAbi(['function approve(address,uint256)']),
          functionName: 'approve',
          args: [ATTACKER, 1n],
        }),
        value: 0n,
      },
      /Spender/,
    ],
    [
      'token transfer to attacker',
      {
        to: TOKEN,
        data: encodeFunctionData({
          abi: parseAbi(['function transfer(address,uint256)']),
          functionName: 'transfer',
          args: [ATTACKER, 1n],
        }),
        value: 0n,
      },
      /not one of your wallets/,
    ],
    [
      'unknown token function (transferFrom)',
      {
        to: TOKEN,
        data: encodeFunctionData({
          abi: parseAbi(['function transferFrom(address,address,uint256)']),
          functionName: 'transferFrom',
          args: [ME, ATTACKER, 1n],
        }),
        value: 0n,
      },
      /Unknown function/,
    ],
    ['native send to attacker', { to: ATTACKER, data: '0x', value: 1n }, /allowlist/],
    [
      'unknown contract',
      { to: '0x000000000000000000000000000000000000dEaD', data: '0x12345678', value: 0n },
      /allowlist/,
    ],
    ['garbage calldata to router', { to: UR, data: '0xdeadbeef', value: 0n }, /execute/],
    [
      'legacy execute without deadline',
      { to: UR, data: `0x24856bc3${'00'.repeat(64)}` as Hex, value: 0n },
      /execute/,
    ],
  ];

  for (const [name, tx, reason] of cases) {
    it(name, () => {
      const r = validateTx(tx, ctx);
      expect(r.ok).toBe(false);
      expect(failing(r).join(' | ')).toMatch(reason);
    });
  }

  it('rejects unknown router commands and the allow-revert flag', () => {
    // TRANSFER (0x05) with a raw input, then the same command with the 0x80 flag.
    const data = encodeFunctionData({
      abi: parseAbi(['function execute(bytes,bytes[],uint256)']),
      functionName: 'execute',
      args: ['0x05', [`0x${'00'.repeat(96)}`], DEADLINE],
    });
    expect(failing(validateTx({ to: UR, data, value: 0n }, ctx)).join()).toMatch(
      /unsupported router command 0x05/,
    );
    const flagged = encodeFunctionData({
      abi: parseAbi(['function execute(bytes,bytes[],uint256)']),
      functionName: 'execute',
      args: ['0x8c', [`0x${'00'.repeat(64)}`], DEADLINE],
    });
    expect(failing(validateTx({ to: UR, data: flagged, value: 0n }, ctx)).join()).toMatch(
      /allow-revert/,
    );
  });

  it('rejects a sender that is not an own wallet', () => {
    const tx = uniswapVenue.buildBuy(venueCtx, pools[1]!, {
      wallet: ME,
      amountIn: 1n,
      minOut: 1n,
      deadline: DEADLINE,
    });
    expect(validateTx(tx, { ...ctx, from: ATTACKER }).ok).toBe(false);
  });

  it('validates permits before signing', () => {
    expect(validatePermit(permit, ctx).ok).toBe(true);
    expect(validatePermit({ ...permit, details: { ...permit.details, token: WETH } }, ctx).ok).toBe(
      false,
    );
    expect(
      validatePermit(
        { ...permit, details: { ...permit.details, expiration: NOW + 86_400 * 30 } },
        ctx,
      ).ok,
    ).toBe(false);
  });
});

describe('validator: send to a confirmed outside address', () => {
  const FRIEND: Address = '0x3333333333333333333333333333333333333333';
  const transfer = (to: Address, amount: bigint) =>
    encodeFunctionData({
      abi: parseAbi(['function transfer(address,uint256)']),
      args: [to, amount],
    });

  it('native to the payee passes; to anyone else it is blocked', () => {
    const sendCtx = { ...ctx, token: undefined, payee: FRIEND, maxValue: parseEther('0.01') };
    expect(validateTx({ to: FRIEND, data: '0x', value: parseEther('0.01') }, sendCtx).ok).toBe(
      true,
    );
    expect(validateTx({ to: ATTACKER, data: '0x', value: parseEther('0.01') }, sendCtx).ok).toBe(
      false,
    );
  });

  it('native above the confirmed amount is blocked', () => {
    const sendCtx = { ...ctx, token: undefined, payee: FRIEND, maxValue: parseEther('0.01') };
    expect(validateTx({ to: FRIEND, data: '0x', value: parseEther('0.02') }, sendCtx).ok).toBe(
      false,
    );
  });

  it('calldata to the payee is blocked (a plain send only)', () => {
    const sendCtx = { ...ctx, token: undefined, payee: FRIEND, maxValue: parseEther('0.01') };
    expect(validateTx({ to: FRIEND, data: '0xdeadbeef', value: 0n }, sendCtx).ok).toBe(false);
  });

  it('token transfer to the payee passes; to anyone else it is blocked', () => {
    const sendCtx = { ...ctx, payee: FRIEND, maxValue: 0n };
    expect(validateTx({ to: TOKEN, data: transfer(FRIEND, 5n), value: 0n }, sendCtx).ok).toBe(true);
    expect(validateTx({ to: TOKEN, data: transfer(ATTACKER, 5n), value: 0n }, sendCtx).ok).toBe(
      false,
    );
  });

  it('without a payee an outside recipient is still blocked', () => {
    expect(validateTx({ to: TOKEN, data: transfer(FRIEND, 5n), value: 0n }, ctx).ok).toBe(false);
    expect(validateTx({ to: FRIEND, data: '0x', value: 1n }, ctx).ok).toBe(false);
  });
});

describe('validator: fuzz', () => {
  // Deterministic PRNG so failures are reproducible.
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const addrs = [
    ME,
    MY_OTHER,
    ATTACKER,
    ADDRESS_THIS,
    MSG_SENDER,
    WETH,
    TOKEN,
    NATIVE,
    UR,
    PERMIT2,
  ];

  function randomCommand(): Command {
    const t = pick(['WRAP_ETH', 'UNWRAP_WETH', 'SWEEP', 'V2', 'V3', 'V4'] as const);
    const amt = BigInt(Math.floor(rnd() * 1e6));
    switch (t) {
      case 'WRAP_ETH':
        return { type: 'WRAP_ETH', recipient: pick(addrs), amount: amt };
      case 'UNWRAP_WETH':
        return { type: 'UNWRAP_WETH', recipient: pick(addrs), amountMin: amt };
      case 'SWEEP':
        return { type: 'SWEEP', token: pick(addrs), recipient: pick(addrs), amountMin: amt };
      case 'V2':
        return {
          type: 'V2_SWAP_EXACT_IN',
          recipient: pick(addrs),
          amountIn: amt,
          amountOutMin: amt,
          path: [pick(addrs), pick(addrs)],
          payerIsUser: rnd() > 0.5,
        };
      case 'V3':
        return {
          type: 'V3_SWAP_EXACT_IN',
          recipient: pick(addrs),
          amountIn: amt,
          amountOutMin: amt,
          path: [{ tokenIn: pick(addrs), fee: 3000, tokenOut: pick(addrs) }],
          payerIsUser: rnd() > 0.5,
        };
      case 'V4':
        return {
          type: 'V4_SWAP',
          actions: [
            { type: 'TAKE', currency: pick(addrs), recipient: pick(addrs), amount: amt },
            { type: 'TAKE_ALL', currency: pick(addrs), minAmount: amt },
          ],
        };
    }
  }

  it('never approves a plan that sends value or tokens to a foreign address', () => {
    for (let i = 0; i < 2_000; i++) {
      const commands = Array.from({ length: 1 + Math.floor(rnd() * 4) }, randomCommand);
      const tx = router(commands, BigInt(Math.floor(rnd() * 1e6)));
      const r = validateTx(tx, ctx);
      if (!r.ok) continue;
      const json = JSON.stringify(commands, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      expect(json.toLowerCase(), json).not.toContain(ATTACKER.slice(2).toLowerCase());
    }
  });
});
