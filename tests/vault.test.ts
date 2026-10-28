import { beforeEach, describe, expect, it } from 'vitest';
import type { KdfParams } from '../src/background/vault/crypto';
import { toBase64 } from '../src/shared/base64';
import {
  Vault,
  VaultError,
  isValidMnemonic,
  normalizePrivateKey,
  type KeyValueStore,
} from '../src/background/vault/vault';

// Well-known development mnemonic (Hardhat/Anvil). Never holds real funds.
const DEV_MNEMONIC = 'test test test test test test test test test test test junk';
const DEV_ADDR_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const DEV_ADDR_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
// Anvil account #2 private key, imported as a standalone key.
const DEV_PK_2 = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const DEV_ADDR_2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const PASSWORD = 'correct horse battery';

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

// Tiny KDF so tests stay fast; production calibrates to ~500 ms.
const fastKdf = async (): Promise<KdfParams> => ({
  alg: 'argon2id',
  memoryKiB: 64,
  iterations: 1,
  parallelism: 1,
  salt: toBase64(crypto.getRandomValues(new Uint8Array(16))),
});

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e) => e instanceof VaultError && e.code === code);
}

describe('Vault', () => {
  let local: MemoryStore;
  let session: MemoryStore;
  let clock: number;
  let vault: Vault;

  beforeEach(() => {
    local = new MemoryStore();
    session = new MemoryStore();
    clock = 1_000_000;
    vault = new Vault({ local, session, kdf: fastKdf, now: () => clock });
  });

  it("creates a vault deriving m/44'/60'/0'/0/0", async () => {
    const accounts = await vault.create(DEV_MNEMONIC, PASSWORD);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      address: DEV_ADDR_0,
      primary: true,
      kind: 'derived',
      index: 0,
    });
  });

  it('stores only ciphertext in local storage', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    const dump = JSON.stringify([...local.data.values()]);
    expect(dump).not.toContain('test test');
    expect(dump.toLowerCase()).not.toContain(DEV_ADDR_0.slice(2).toLowerCase());
  });

  it('rejects weak passwords, bad mnemonics and a second create', async () => {
    await expectCode(vault.create(DEV_MNEMONIC, 'short'), 'weak_password');
    await expectCode(vault.create('test '.repeat(12), PASSWORD), 'bad_mnemonic');
    await vault.create(DEV_MNEMONIC, PASSWORD);
    await expectCode(vault.create(DEV_MNEMONIC, PASSWORD), 'exists');
  });

  it('locks and unlocks', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    await vault.lock();
    expect(await vault.isUnlocked()).toBe(false);
    await expectCode(vault.listAccounts(), 'locked');
    await expectCode(vault.unlock('wrong password'), 'bad_password');
    const accounts = await vault.unlock(PASSWORD);
    expect(accounts[0]?.address).toBe(DEV_ADDR_0);
  });

  it('survives a service-worker restart via the session key', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    const restarted = new Vault({ local, session, kdf: fastKdf });
    expect(await restarted.isUnlocked()).toBe(true);
    expect((await restarted.listAccounts())[0]?.address).toBe(DEV_ADDR_0);
  });

  it('is locked after the browser clears session storage', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    session.data.clear();
    const restarted = new Vault({ local, session, kdf: fastKdf });
    expect(await restarted.isUnlocked()).toBe(false);
  });

  it('throttles repeated wrong passwords', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    await vault.lock();
    for (let i = 0; i < 5; i++) await expectCode(vault.unlock('nope nope'), 'bad_password');
    await expectCode(vault.unlock(PASSWORD), 'too_many_attempts');
    clock += 31_000;
    await expect(vault.unlock(PASSWORD)).resolves.toHaveLength(1);
  });

  it('derives further accounts and imports private keys', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    const second = await vault.addDerived();
    expect(second).toMatchObject({ address: DEV_ADDR_1, index: 1, name: 'Wallet 2' });
    const imported = await vault.importPrivateKey(DEV_PK_2.slice(2), 'Sniper');
    expect(imported).toMatchObject({ address: DEV_ADDR_2, kind: 'imported', name: 'Sniper' });
    await expectCode(vault.importPrivateKey(DEV_PK_2), 'duplicate');
    await expectCode(vault.importPrivateKey('0x1234'), 'bad_private_key');
    await expectCode(vault.importPrivateKey('0x' + '0'.repeat(64)), 'bad_private_key');

    await vault.lock();
    const accounts = await vault.unlock(PASSWORD);
    expect(accounts.map((a) => a.address)).toEqual([DEV_ADDR_0, DEV_ADDR_1, DEV_ADDR_2]);
  });

  it('renames, hides, sets primary and removes', async () => {
    const [first] = await vault.create(DEV_MNEMONIC, PASSWORD);
    const second = await vault.addDerived();
    await vault.rename(second.id, '  Main   bag ');
    await expectCode(vault.setHidden(first!.id, true), 'primary');
    await vault.setHidden(second.id, true);
    await vault.setPrimary(second.id);
    let accounts = await vault.listAccounts();
    expect(accounts.find((a) => a.id === second.id)).toMatchObject({
      name: 'Main bag',
      hidden: false,
      primary: true,
    });
    await expectCode(vault.remove(second.id), 'primary');
    await vault.remove(first!.id);
    accounts = await vault.listAccounts();
    expect(accounts.map((a) => a.id)).toEqual([second.id]);
  });

  it('exports a key only with the password', async () => {
    const [first] = await vault.create(DEV_MNEMONIC, PASSWORD);
    await expectCode(vault.exportPrivateKey(first!.id, 'wrong password'), 'bad_password');
    expect(await vault.exportPrivateKey(first!.id, PASSWORD)).toBe(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    );
  });

  it('detects ciphertext and parameter tampering', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    await vault.lock();
    const record = (await local.get('celera.vault')) as { kdf: KdfParams; sealed: { ct: string } };

    const flipped = structuredClone(record);
    const bytes = atob(flipped.sealed.ct);
    flipped.sealed.ct = btoa(String.fromCharCode(bytes.charCodeAt(0) ^ 1) + bytes.slice(1));
    await local.set('celera.vault', flipped);
    await expectCode(vault.unlock(PASSWORD), 'bad_password');

    // Same key cannot be reused with downgraded params: AAD covers them.
    const downgraded = structuredClone(record);
    downgraded.kdf.memoryKiB = 32;
    await local.set('celera.vault', downgraded);
    await expectCode(vault.unlock(PASSWORD), 'bad_password');
  });

  it('reset removes everything', async () => {
    await vault.create(DEV_MNEMONIC, PASSWORD);
    await vault.reset();
    expect(await vault.exists()).toBe(false);
    expect(local.data.size + session.data.size).toBe(0);
  });
});

describe('input helpers', () => {
  it('validates mnemonics loosely formatted', () => {
    expect(isValidMnemonic(`  ${DEV_MNEMONIC.toUpperCase().replace(/ /g, '   ')} `)).toBe(true);
    expect(isValidMnemonic('test test test')).toBe(false);
  });

  it('normalizes private keys', () => {
    expect(normalizePrivateKey(DEV_PK_2.toUpperCase().replace('0X', ''))).toBe(DEV_PK_2);
    expect(normalizePrivateKey('xyz')).toBeNull();
  });
});
