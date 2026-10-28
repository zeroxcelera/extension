import { parseGwei, type PublicClient } from 'viem';
import type { ChainConfig, GasPreset } from '../../shared/chains';

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

const BLOCK_TTL_MS = 3_000;

/** Caches the latest base fee per chain so a click does not wait for a block fetch. */
export class FeeCache {
  private readonly base = new Map<number, { at: number; baseFee: bigint }>();

  async baseFee(chain: ChainConfig, client: PublicClient, now: number): Promise<bigint> {
    const hit = this.base.get(chain.id);
    if (hit && now - hit.at < BLOCK_TTL_MS) return hit.baseFee;
    const block = await client.getBlock({ blockTag: 'latest' });
    const baseFee = block.baseFeePerGas ?? 0n;
    this.base.set(chain.id, { at: now, baseFee });
    return baseFee;
  }

  /** Pushed by the WebSocket hub on every new block. */
  setBaseFee(chainId: number, baseFee: bigint, now: number): void {
    this.base.set(chainId, { at: now, baseFee });
  }

  async fees(
    chain: ChainConfig,
    client: PublicClient,
    preset: GasPreset,
    now: number,
  ): Promise<Fees> {
    return computeFees(chain, await this.baseFee(chain, client, now), preset);
  }
}

/**
 * Least max-fee headroom over the base fee, whatever the setting says. The base fee moves
 * between blocks (up to 12.5% on Ethereum, ~3% steps on Robinhood Chain) and a max fee
 * below it is refused outright, while the headroom itself costs nothing: only the actual
 * base fee (+ tip) is paid.
 */
const MIN_FEE_MULTIPLIER_BPS = 12_500n;

export function computeFees(chain: ChainConfig, baseFee: bigint, preset: GasPreset): Fees {
  const prio = chain.feeModel === 'arbitrum' ? 0n : parseGwei(preset.priorityFeeGwei);
  const setBps = BigInt(Math.round(preset.maxFeeMultiplier * 10_000));
  const multBps = setBps > MIN_FEE_MULTIPLIER_BPS ? setBps : MIN_FEE_MULTIPLIER_BPS;
  let maxFee = (baseFee * multBps) / 10_000n + prio;
  if (maxFee < prio) maxFee = prio;
  if (maxFee === 0n) maxFee = 1n;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio };
}

/** Replacement transactions must raise both fees by at least 10%; use 12.5%. */
export function bumpFees(f: Fees, floor: Fees): Fees {
  const bump = (x: bigint) => (x * 1125n) / 1000n + 1n;
  const prio =
    bump(f.maxPriorityFeePerGas) > floor.maxPriorityFeePerGas
      ? bump(f.maxPriorityFeePerGas)
      : floor.maxPriorityFeePerGas;
  let max = bump(f.maxFeePerGas) > floor.maxFeePerGas ? bump(f.maxFeePerGas) : floor.maxFeePerGas;
  if (max < prio) max = prio;
  return { maxFeePerGas: max, maxPriorityFeePerGas: prio };
}

/**
 * What a transaction does, for its gas: `transfer` moves native (no calldata),
 * `tokenTransfer` an ERC-20, `deposit` pays native into a contract (a bridge deposit),
 * `routed` is a Celera Router call: several venue calls in one transaction.
 */
export type GasKind = 'swap' | 'approve' | 'transfer' | 'tokenTransfer' | 'deposit' | 'routed';

/** Gas limits used when simulation is off or impossible (pending approval). */
export function staticGas(chain: ChainConfig, kind: GasKind): bigint {
  if (kind === 'transfer') return chain.feeModel === 'arbitrum' ? 300_000n : 21_000n;
  // An ERC-20 transfer costs about what an approval does: one or two storage writes.
  const small = kind === 'approve' || kind === 'tokenTransfer' || kind === 'deposit';
  // A router call chains an AMM swap (often two hops) and a curve trade: one swap's limit
  // is not enough for it (a funded buy on BSC used 495k).
  if (kind === 'routed') return chain.feeModel === 'arbitrum' ? 6_000_000n : 1_200_000n;
  if (chain.feeModel === 'arbitrum') return small ? 1_000_000n : 3_000_000n;
  return small ? 90_000n : 500_000n;
}
