import { parseAbi, type Address, type PublicClient } from 'viem';
import { PERMIT2 } from './uniswap/addresses';
import type { PermitSingle } from './uniswap/codec';

export const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
]);

export const PERMIT_TYPES = {
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
} as const;

export function permitDomain(chainId: number) {
  return { name: 'Permit2', chainId, verifyingContract: PERMIT2 } as const;
}

/** Permit validity window. Short on purpose: the permit covers exactly one sell. */
const PERMIT_TTL_S = 30 * 60;

export async function readPermit2Allowance(
  client: PublicClient,
  owner: Address,
  token: Address,
  spender: Address,
): Promise<{ amount: bigint; expiration: number; nonce: number }> {
  const [amount, expiration, nonce] = await client.readContract({
    address: PERMIT2,
    abi: permit2Abi,
    functionName: 'allowance',
    args: [owner, token, spender],
  });
  return { amount, expiration, nonce };
}

export function buildPermit(
  token: Address,
  spender: Address,
  amount: bigint,
  nonce: number,
  nowS: number,
): PermitSingle {
  return {
    details: { token, amount, expiration: nowS + PERMIT_TTL_S, nonce },
    spender,
    sigDeadline: BigInt(nowS + PERMIT_TTL_S),
  };
}
