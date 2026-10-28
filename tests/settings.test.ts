import { describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/background/settings';
import type { KeyValueStore } from '../src/background/vault/vault';
import { getChain } from '../src/shared/chains';
import {
  PanelChainPatchSchema,
  defaultChainSettings,
  effectivePreset,
} from '../src/shared/settings/defaults';

class MemoryStore implements KeyValueStore {
  data = new Map<string, unknown>();
  async get(key: string) {
    return structuredClone(this.data.get(key));
  }
  async set(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async remove(key: string) {
    this.data.delete(key);
  }
}

describe('chain trade settings', () => {
  const base = defaultChainSettings(getChain(8453)!);

  it('defaults to 10% slippage and the medium priority level', () => {
    expect(base.slippageBps).toBe(1000);
    expect(effectivePreset(base)).toEqual({
      priorityFeeGwei: base.priorityGwei.medium,
      maxFeeMultiplier: base.maxFeeMultiplier,
      slippageBps: 1000,
    });
  });

  it('uses the custom priority fee when selected', () => {
    const cs = { ...base, priority: 'custom' as const, customPriorityGwei: '0.42' };
    expect(effectivePreset(cs).priorityFeeGwei).toBe('0.42');
  });

  it('lets the panel change trade options but never RPC URLs', () => {
    expect(
      PanelChainPatchSchema.safeParse({ slippageBps: 2000, priority: 'high', mevEnabled: true })
        .success,
    ).toBe(true);
    expect(
      PanelChainPatchSchema.safeParse({ quickBuyAmounts: ['0.1', '0.2', '0.3', '0.4'] }).success,
    ).toBe(true);
    expect(PanelChainPatchSchema.safeParse({ customRpc: 'https://evil.example' }).success).toBe(
      false,
    );
    expect(PanelChainPatchSchema.safeParse({ mevRpc: 'https://evil.example' }).success).toBe(false);
    expect(PanelChainPatchSchema.safeParse({ slippageBps: 9000 }).success).toBe(false);
    expect(
      PanelChainPatchSchema.safeParse({ quickSellBps: [1000, 3333, 5000, 10_000] }).success,
    ).toBe(true);
    expect(PanelChainPatchSchema.safeParse({ quickSellBps: [0, 2500, 5000, 10_000] }).success).toBe(
      false,
    );
    expect(
      PanelChainPatchSchema.safeParse({ quickSellBps: [2500, 5000, 7500, 10_001] }).success,
    ).toBe(false);
    expect(PanelChainPatchSchema.safeParse({ quickSellBps: [2500, 5000] }).success).toBe(false);
  });

  it('reads settings saved by the old P1–P3 version without breaking', async () => {
    const local = new MemoryStore();
    await local.set('celera.chain.8453', {
      quickBuyAmounts: ['0.002', '0.004', '0.008', '0.016'],
      presets: { p1: {}, p2: {}, p3: {} },
      activePreset: 'p2',
      customRpc: '',
      mevEnabled: false,
      mevRpc: '',
    });
    const cs = await new SettingsStore(local).getChain(8453);
    expect(cs.quickBuyAmounts).toEqual(['0.002', '0.004', '0.008', '0.016']);
    expect(cs.slippageBps).toBe(1000);
    expect(cs.priority).toBe('medium');
    expect(cs).not.toHaveProperty('activePreset');
  });

  it('keeps panel positions per site, by the sender origin', async () => {
    const local = new MemoryStore();
    const store = new SettingsStore(local);
    await store.setPanelPrefs('https://gmgn.ai', { x: 10, y: 20, minimized: true, hidden: false });
    expect(await store.panelPrefs('https://gmgn.ai')).toEqual({
      x: 10,
      y: 20,
      minimized: true,
      hidden: false,
    });
    // Same key the content script used before, so saved positions survive the update.
    expect(await local.get('celera.panel.gmgn.ai')).toBeTruthy();
    expect((await store.panelPrefs('https://dexscreener.com')).x).toBe(-1);
    expect((await store.panelPrefs(undefined)).x).toBe(-1);
    await local.set('celera.panel.bad.example', { x: 'nope' });
    expect((await store.panelPrefs('https://bad.example')).x).toBe(-1);
  });

  it('fills an empty private RPC with the chain default (BSC included), protection stays a choice', async () => {
    const local = new MemoryStore();
    // Saved before BSC had a default: MEV "on" with no RPC used to mean the public mempool.
    await local.set('celera.chain.56', { mevEnabled: true, mevRpc: '' });
    await local.set('celera.chain.1', { mevEnabled: false, mevRpc: '' });
    const store = new SettingsStore(local);
    const bsc = await store.getChain(56);
    expect(bsc.mevEnabled).toBe(true);
    expect(bsc.mevRpc).toBe('https://bscrpc.pancakeswap.finance');
    const eth = await store.getChain(1);
    expect(eth.mevEnabled).toBe(false);
    expect(eth.mevRpc).toBe('https://rpc.flashbots.net/fast');
    // Chains without a mempool keep no private RPC.
    expect((await store.getChain(8453)).mevRpc).toBe('');
  });
});

describe('settings repair and limits', () => {
  it('resets only the invalid field of saved settings, and says which', async () => {
    const local = new MemoryStore();
    await local.set('celera.settings', { maxUsdPerTx: 40, maxUsdPerClick: 80, jitterMaxMs: 9999 });
    await local.set('celera.chain.56', {
      slippageBps: 0,
      quickBuyAmounts: ['0.1', '0.2', '0.3', '0.4'],
    });
    const store = new SettingsStore(local);
    const g = await store.get();
    expect(g.maxUsdPerTx).toBe(40);
    expect(g.maxUsdPerClick).toBe(80);
    expect(g.jitterMaxMs).toBe(0);
    const bsc = await store.getChain(56);
    expect(bsc.quickBuyAmounts).toEqual(['0.1', '0.2', '0.3', '0.4']);
    expect(bsc.slippageBps).toBe(1000);
    expect(store.repairs()).toEqual(['jitterMaxMs', 'BSC: slippageBps']);
  });

  it('refuses limits that contradict each other, with the reason', async () => {
    const store = new SettingsStore(new MemoryStore());
    await expect(store.update({ maxUsdPerTx: 100 })).rejects.toThrow(
      /can't be above max per click/,
    );
    await expect(store.update({ priceImpactWarnBps: 900 })).rejects.toThrow(
      /warning can't be above/,
    );
    await store.update({ maxUsdPerClick: 200 });
    expect((await store.update({ maxUsdPerTx: 100 })).maxUsdPerTx).toBe(100);
  });

  it('refuses quick buttons with the same value, from the panel and the popup', async () => {
    const store = new SettingsStore(new MemoryStore());
    await expect(
      store.updateChain(8453, { quickBuyAmounts: ['0.01', '0.010', '0.05', '0.1'] }),
    ).rejects.toThrow(/must all be different/);
    expect(
      PanelChainPatchSchema.safeParse({ quickSellBps: [2500, 2500, 7500, 10_000] }).success,
    ).toBe(false);
  });

  it('starts with hotkeys off', async () => {
    expect((await new SettingsStore(new MemoryStore()).get()).hotkeysEnabled).toBe(false);
  });
});
