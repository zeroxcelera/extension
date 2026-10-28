import { isAddressEqual, toEventSelector, type Address, type Hex } from 'viem';

/** What a receipt is read for: just the fields used here (viem's type is wider). */
export interface ReceiptLike {
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
}

const TRANSFER = toEventSelector('Transfer(address,address,uint256)');
const WITHDRAWAL = toEventSelector('Withdrawal(address,uint256)');

const topicAddress = (t: Hex | undefined): Address | null =>
  t && t.length === 66 ? (`0x${t.slice(26)}` as Address) : null;

const word = (data: Hex): bigint => (data.length >= 66 ? BigInt(data.slice(0, 66)) : 0n);

/**
 * Network fee actually paid: gas × price, plus the L1 data fee that OP-stack chains
 * (Base) report on the receipt as an extra field.
 */
export function feePaid(r: ReceiptLike): bigint {
  const l1 = (r as unknown as { l1Fee?: unknown }).l1Fee;
  const l1Fee =
    typeof l1 === 'bigint'
      ? l1
      : typeof l1 === 'string' && /^0x[0-9a-f]+$/i.test(l1)
        ? BigInt(l1)
        : 0n;
  return r.gasUsed * r.effectiveGasPrice + l1Fee;
}

/** Sum of `token` Transfer events into `to` (a buy's tokens received). */
export function tokenReceived(r: ReceiptLike, token: Address, to: Address): bigint {
  let sum = 0n;
  for (const log of r.logs) {
    if (log.topics[0] !== TRANSFER || log.topics.length !== 3) continue;
    if (!isAddressEqual(log.address, token)) continue;
    const dest = topicAddress(log.topics[2]);
    if (dest && isAddressEqual(dest, to)) sum += word(log.data);
  }
  return sum;
}

/**
 * Wrapped native unwrapped in the transaction (a sell's native out: the router unwraps
 * and forwards it). Zero when the pool trades native directly (Uniswap v4).
 */
export function nativeUnwrapped(r: ReceiptLike, wrapped: Address): bigint {
  let sum = 0n;
  for (const log of r.logs) {
    if (log.topics[0] !== WITHDRAWAL || !isAddressEqual(log.address, wrapped)) continue;
    sum += word(log.data);
  }
  return sum;
}
