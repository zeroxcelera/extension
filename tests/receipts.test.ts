import { pad, toEventSelector, toHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  feePaid,
  nativeUnwrapped,
  tokenReceived,
  type ReceiptLike,
} from '../src/background/trade/receipts';

const TOKEN: Address = '0x532f27101965dd16442E59d40670FaF5eBB142E4';
const WETH: Address = '0x4200000000000000000000000000000000000006';
const ME: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const WITHDRAWAL = toEventSelector('Withdrawal(address,uint256)');

const topic = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });
const amount = (n: bigint): Hex => pad(toHex(n), { size: 32 });

function receipt(logs: ReceiptLike['logs'], extra: Record<string, unknown> = {}): ReceiptLike {
  return { gasUsed: 100_000n, effectiveGasPrice: 2_000_000_000n, logs, ...extra };
}

describe('receipts', () => {
  it('sums token transfers into the wallet only', () => {
    const r = receipt([
      { address: TOKEN, topics: [TRANSFER, topic(OTHER), topic(ME)], data: amount(700n) },
      { address: TOKEN, topics: [TRANSFER, topic(OTHER), topic(ME)], data: amount(300n) },
      { address: TOKEN, topics: [TRANSFER, topic(ME), topic(OTHER)], data: amount(50n) },
      { address: WETH, topics: [TRANSFER, topic(OTHER), topic(ME)], data: amount(9n) },
    ]);
    expect(tokenReceived(r, TOKEN, ME)).toBe(1_000n);
  });

  it('ignores ERC-721 style transfers (amount in a topic)', () => {
    const r = receipt([
      { address: TOKEN, topics: [TRANSFER, topic(OTHER), topic(ME), amount(5n)], data: '0x' },
    ]);
    expect(tokenReceived(r, TOKEN, ME)).toBe(0n);
  });

  it('reads native out from the wrapped-native withdrawal', () => {
    const r = receipt([
      { address: WETH, topics: [WITHDRAWAL, topic(OTHER)], data: amount(42n) },
      { address: TOKEN, topics: [WITHDRAWAL, topic(OTHER)], data: amount(1n) },
    ]);
    expect(nativeUnwrapped(r, WETH)).toBe(42n);
  });

  it('adds the OP-stack L1 fee to the gas cost', () => {
    expect(feePaid(receipt([]))).toBe(200_000_000_000_000n);
    expect(feePaid(receipt([], { l1Fee: '0x10' }))).toBe(200_000_000_000_016n);
    expect(feePaid(receipt([], { l1Fee: 16n }))).toBe(200_000_000_000_016n);
  });
});
