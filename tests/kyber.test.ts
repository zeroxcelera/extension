import { encodeFunctionData, parseAbi, parseEther, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { KYBER_ROUTER, kyberRule } from '../src/background/trade/kyber';
import type { ValidationContext } from '../src/background/trade/validator';
import { getChain } from '../src/shared/chains';

const abi = parseAbi([
  'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
  'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
  'function swap(SwapExecutionParams execution) payable returns (uint256, uint256)',
]);

const NATIVE: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ME: Address = '0x000000000000000000000000000000000000bEEF';
const TOKEN: Address = '0x1111111111111111111111111111111111111111';
const EVIL: Address = '0x2222222222222222222222222222222222222222';

const ctx: ValidationContext = {
  chain: getChain(8453)!,
  from: ME,
  ownWallets: [ME],
  token: TOKEN,
  maxValue: parseEther('1'),
  nowS: 0,
};

function swap(over: Partial<Record<string, unknown>> = {}, value = parseEther('0.01')) {
  const desc = {
    srcToken: NATIVE,
    dstToken: TOKEN,
    srcReceivers: [],
    srcAmounts: [],
    feeReceivers: [] as Address[],
    feeAmounts: [] as bigint[],
    dstReceiver: ME,
    amount: parseEther('0.01'),
    minReturnAmount: 1000n,
    flags: 0n,
    permit: '0x' as const,
    ...over,
  };
  const data = encodeFunctionData({
    abi,
    functionName: 'swap',
    args: [{ callTarget: EVIL, approveTarget: EVIL, targetData: '0x', desc, clientData: '0x' }],
  });
  return { to: KYBER_ROUTER, data, value };
}

const reason = (tx: ReturnType<typeof swap>) =>
  kyberRule.validate(tx, ctx).find((a) => !a.ok)?.reason ?? null;

describe('KyberSwap validator rule', () => {
  it('accepts a buy paying the wallet', () => {
    expect(reason(swap())).toBeNull();
  });

  it('accepts a sell paying the wallet', () => {
    expect(reason(swap({ srcToken: TOKEN, dstToken: NATIVE }, 0n))).toBeNull();
  });

  it.each([
    ['output to someone else', { dstReceiver: EVIL }, /your wallet/],
    ['no minimum', { minReturnAmount: 0n }, /No minimum/],
    ['hidden fee', { feeReceivers: [EVIL], feeAmounts: [1n] }, /extra fee/],
    ['embedded permit', { permit: '0x1234' }, /permits/],
    ['another token', { dstToken: EVIL }, /Unexpected assets/],
  ])('blocks %s', (_l, over, re) => {
    expect(reason(swap(over))).toMatch(re);
  });

  it('blocks a value that does not match the input', () => {
    expect(reason(swap({}, parseEther('0.02')))).toMatch(/Value/);
  });
});
