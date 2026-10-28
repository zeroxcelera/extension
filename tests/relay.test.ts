import { encodeFunctionData, parseAbi, parseEther, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { RELAY_DEPOSITORY, RelayError, checkQuote, relayRule } from '../src/background/trade/relay';
import { validateTx } from '../src/background/trade/validator';
import { getChain } from '../src/shared/chains';

const ME: Address = '0x1111111111111111111111111111111111111111';
const MY_OTHER: Address = '0x2222222222222222222222222222222222222222';
const ATTACKER: Address = '0xbadbadbadbadbadbadbadbadbadbadbadbadbad0';
const ID: Hex = `0x${'ab'.repeat(32)}`;
const AMOUNT = parseEther('0.05');
const abi = parseAbi(['function depositNative(address depositor, bytes32 id) payable']);

function quote(
  over: {
    to?: string;
    depositor?: Address;
    value?: bigint;
    chainId?: number;
    recipient?: string;
    extraStep?: boolean;
  } = {},
) {
  const data = encodeFunctionData({
    abi,
    functionName: 'depositNative',
    args: [over.depositor ?? ME, ID],
  });
  const step = {
    id: 'deposit',
    kind: 'transaction',
    items: [
      {
        data: {
          to: over.to ?? RELAY_DEPOSITORY,
          data,
          value: String(over.value ?? AMOUNT),
          chainId: over.chainId ?? 8453,
        },
        check: { endpoint: `/intents/status?requestId=${ID}` },
      },
    ],
  };
  return {
    steps: over.extraStep ? [step, step] : [step],
    fees: { gas: { amountUsd: '0.01' }, relayer: { amountUsd: '0.09' } },
    details: {
      recipient: over.recipient ?? MY_OTHER,
      timeEstimate: 2,
      currencyOut: { amount: '155700000000000000' },
    },
  };
}

const params = { user: ME, recipient: MY_OTHER, fromChainId: 8453, amount: AMOUNT };

describe('Relay quote checks', () => {
  it('accepts a single deposit for the requested amount and recipient', () => {
    const q = checkQuote(quote(), params);
    expect(q.tx).toMatchObject({ to: RELAY_DEPOSITORY, value: AMOUNT });
    expect(q.amountOut).toBe(155_700_000_000_000_000n);
    expect(q.feeUsd).toBeCloseTo(0.1);
    expect(q.statusPath).toBe(`/intents/status?requestId=${ID}`);
  });

  it.each([
    ['unknown contract', { to: ATTACKER }, /unknown contract/],
    ['deposit credited to someone else', { depositor: ATTACKER }, /not credited/],
    ['different value', { value: AMOUNT * 2n }, /value differs/],
    ['other chain', { chainId: 1 }, /different chain/],
    ['swapped recipient', { recipient: ATTACKER }, /recipient differs/],
    ['extra steps', { extraStep: true }, /unexpected steps/],
  ] as const)('rejects %s', (_name, over, msg) => {
    expect(() => checkQuote(quote(over), params)).toThrow(RelayError);
    expect(() => checkQuote(quote(over), params)).toThrow(msg);
  });

  it('rejects calldata that is not depositNative', () => {
    const q = quote();
    (q.steps[0]!.items[0]!.data as { data: string }).data = '0xa9059cbb' + '00'.repeat(64);
    expect(() => checkQuote(q, params)).toThrow(/not a native deposit/);
  });
});

describe('Relay validator rule', () => {
  const chain = getChain(8453)!;
  const ctx = {
    chain,
    from: ME,
    ownWallets: [ME, MY_OTHER],
    extraContracts: new Map([[RELAY_DEPOSITORY.toLowerCase(), relayRule]]),
    maxValue: parseEther('0.1'),
    nowS: 1_800_000_000,
  };
  const deposit = (depositor: Address, value = AMOUNT) => ({
    to: RELAY_DEPOSITORY,
    data: encodeFunctionData({ abi, functionName: 'depositNative', args: [depositor, ID] }),
    value,
  });

  it('allows a deposit credited to the sender', () => {
    expect(validateTx(deposit(ME), ctx).ok).toBe(true);
  });

  it('blocks deposits credited to another address, even another own wallet', () => {
    expect(validateTx(deposit(ATTACKER), ctx).ok).toBe(false);
    expect(validateTx(deposit(MY_OTHER), ctx).ok).toBe(false);
  });

  it('applies the per-transaction limit', () => {
    expect(validateTx(deposit(ME, parseEther('1')), ctx).ok).toBe(false);
  });
});
