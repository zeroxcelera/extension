import type { Address } from 'viem';

/** Public view of a wallet account. Contains no secret material. */
export interface WalletAccount {
  id: string;
  name: string;
  address: Address;
  hidden: boolean;
  primary: boolean;
  kind: 'derived' | 'imported';
  /** BIP-44 address index for derived accounts. */
  index?: number;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
