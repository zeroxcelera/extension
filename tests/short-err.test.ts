import { InvalidInputRpcError, RpcRequestError } from 'viem';
import { describe, expect, it } from 'vitest';
import { shortErr } from '../src/background/trade/engine';

const rpcError = (message: string) =>
  new InvalidInputRpcError(
    new RpcRequestError({ body: {}, url: 'https://rpc.example', error: { code: -32000, message } }),
  );

describe('shortErr', () => {
  it("shows the node's reason instead of a generic RPC code message", () => {
    expect(shortErr(rpcError('nonce too low: next nonce 5, tx nonce 4'))).toBe(
      'nonce too low: next nonce 5, tx nonce 4',
    );
  });

  it('cuts raw revert data to its ends, so it cannot stretch the layout', () => {
    const data = '0x5c0dee5d' + '0'.repeat(120) + '40' + '0'.repeat(62) + '84';
    const msg = shortErr(new Error(`Execution reverted with reason: ${data}.`));
    expect(msg).toBe('Execution reverted with reason: 0x5c0dee…000084.');
    // An address alone is still masked whole.
    expect(shortErr(new Error('to 0x15AA49e28cf51b3060666DB2366DabAe3F0952BB failed'))).toBe(
      'to 0x… failed',
    );
  });

  it('turns a gas shortfall into a plain reason without the address', () => {
    const msg =
      'insufficient funds for gas * price + value: address 0x15AA49e28cf51b3060666DB2366DabAe3F0952BB have 0 want 4';
    expect(shortErr(rpcError(msg))).toBe('Insufficient balance for gas');
  });

  it('never echoes an address', () => {
    expect(shortErr(new Error('bad sender 0x15AA49e28cf51b3060666DB2366DabAe3F0952BB'))).toBe(
      'bad sender 0x…',
    );
  });
});

describe('outside error text', () => {
  it('is stripped of characters that could reorder or hide what the user reads', () => {
    expect(shortErr(new Error('send to ‮evil‬ now​'))).toBe('send to evil now');
  });

  it("from Relay's API is cleaned and labelled as Relay's", async () => {
    const { createRelayClient } = await import('../src/background/trade/relay');
    const fetchFn = async () =>
      new Response(JSON.stringify({ message: 'Amount too low‮ — send ETH to 0xabc' }), {
        status: 400,
      });
    const relay = createRelayClient(fetchFn as typeof fetch);
    await expect(
      relay.quote({
        user: '0x1111111111111111111111111111111111111111',
        recipient: '0x1111111111111111111111111111111111111111',
        fromChainId: 8453,
        toChainId: 56,
        amount: 1n,
      }),
    ).rejects.toThrow('Relay: Amount too low — send ETH to 0xabc');
  });
});
