import { encodeFunctionData, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { erc20Abi } from '../../src/background/chain/abis';
import { ClientPool } from '../../src/background/chain/client';
import { PERMIT_TYPES, buildPermit, permitDomain } from '../../src/background/trade/permit2';
import type { PoolRef, VenueCtx } from '../../src/background/trade/types';
import { PERMIT2 } from '../../src/background/trade/uniswap/addresses';
import { uniswapVenue } from '../../src/background/trade/uniswap/venue';
import { getChain } from '../../src/shared/chains';

/**
 * End-to-end check of the swap encoding against real mainnet state, without funds:
 * a throwaway key gets a fake ETH balance via state override, then eth_simulateV1
 * runs buy → approve(Permit2) → sell (with a Permit2 signature) in sequence.
 */
const pool = new ClientPool();

function ctx(chainId: number): VenueCtx {
  const chain = getChain(chainId);
  if (!chain) throw new Error('chain');
  return {
    chain,
    client: pool.get(chain),
    fetchJson: async (url) => (await fetch(url)).json(),
    now: Date.now,
  };
}

async function roundTrip(
  chainId: number,
  token: Address,
  amountIn: bigint,
  pick?: (p: PoolRef) => boolean,
) {
  const c = ctx(chainId);
  const pools = (await uniswapVenue.discover(c, token)).filter(pick ?? (() => true));
  expect(pools.length, `no pools for ${token} on ${chainId}`).toBeGreaterThan(0);

  // Best pool for this size.
  const quotes = await Promise.all(pools.map((p) => uniswapVenue.quote(c, p, 'buy', [amountIn])));
  let best = 0;
  quotes.forEach((q, i) => {
    if ((q[0] ?? 0n) > (quotes[best]?.[0] ?? 0n)) best = i;
  });
  const ref = pools[best] as PoolRef;
  const out = quotes[best]?.[0] ?? 0n;
  expect(out).toBeGreaterThan(0n);

  const account = privateKeyToAccount(generatePrivateKey());
  const nowS = Math.floor(Date.now() / 1000);
  const deadline = BigInt(nowS + 600);
  const minOut = (out * 90n) / 100n;
  const buy = uniswapVenue.buildBuy(c, ref, {
    wallet: account.address,
    amountIn,
    minOut,
    deadline,
  });

  // Sell 50% of the minimum we are guaranteed to have received.
  const sellAmount = minOut / 2n;
  const { router } = uniswapVenue.sellApproval(c, ref);
  const permit = buildPermit(token, router, sellAmount, 0, nowS);
  const signature: Hex = await account.signTypedData({
    domain: permitDomain(chainId),
    types: PERMIT_TYPES,
    primaryType: 'PermitSingle',
    message: permit,
  });
  const sell = uniswapVenue.buildSell(c, ref, {
    wallet: account.address,
    amountIn: sellAmount,
    minOut: 1n,
    deadline,
    permit: { permit, signature },
  });

  const sim = await c.client.simulateCalls({
    account: account.address,
    stateOverrides: [{ address: account.address, balance: parseEther('10') }],
    calls: [
      { to: buy.to, data: buy.data, value: buy.value },
      {
        to: token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [PERMIT2, sellAmount],
        }),
      },
      { to: sell.to, data: sell.data, value: 0n },
    ],
  });
  const statuses = sim.results.map((r) => r.status);
  return {
    label: ref.label,
    statuses,
    errors: sim.results.map((r) => (r.status === 'failure' ? r.error?.message?.slice(0, 200) : '')),
  };
}

describe('Uniswap venue round trip (mainnet simulation, no funds)', () => {
  it('Ethereum: PEPE', async () => {
    const r = await roundTrip(1, '0x6982508145454Ce325dDbE47a25d4ec3d2311933', parseEther('0.01'));
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });

  it('Ethereum: PEPE via v2', async () => {
    const r = await roundTrip(
      1,
      '0x6982508145454Ce325dDbE47a25d4ec3d2311933',
      parseEther('0.01'),
      (p) => p.label.includes('v2'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });

  it('BSC: USDT against WBNB', async () => {
    const r = await roundTrip(56, '0x55d398326f99059fF775485246999027B3197955', parseEther('0.01'));
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });

  it('Base: USDC against WETH (v3 or v4)', async () => {
    const r = await roundTrip(
      8453,
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      parseEther('0.001'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });

  it('Base: USDC via a native-ETH v4 pool', async () => {
    const r = await roundTrip(
      8453,
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      parseEther('0.001'),
      (p) => p.label.includes('v4'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });

  it('Robinhood: v3 WETH pool (WALLET)', async () => {
    const r = await roundTrip(
      4663,
      '0x0339f5459FC690aC85F1782e15782A151b4A9E1b',
      parseEther('0.001'),
      (p) => p.label.includes('v3'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });

  it('Robinhood: v4 native-ETH pool found via the pool index (GIGATENEV)', async () => {
    const r = await roundTrip(
      4663,
      '0xC9675fe679C7d4e1b94416F66D61c96127eb964a',
      parseEther('0.001'),
      (p) => p.label.includes('v4'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });

  it('Arbitrum (config-only chain): ARB', async () => {
    const r = await roundTrip(
      42161,
      '0x912CE59144191C1204E64559FE8253a0e49E6548',
      parseEther('0.001'),
    );
    expect(r.statuses, JSON.stringify(r)).toEqual(['success', 'success', 'success']);
  });
});
