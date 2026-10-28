import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { bytesToHex, type Address, type Hex } from 'viem';
import { HDKey, english as wordlist, privateKeyToAddress } from 'viem/accounts';
import { z } from 'zod';
import { AddressSchema } from '../../shared/chains/schema';
import type { WalletAccount } from '../../shared/wallet';
import {
  KdfParamsSchema,
  calibrateKdf,
  deriveKeyBytes,
  importAesKey,
  open,
  seal,
  wipe,
  type KdfParams,
} from './crypto';
import { fromBase64, toBase64 } from '../../shared/base64';
import { MAX_ACCOUNTS, MIN_PASSWORD_LENGTH } from './constants';

export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every stored item (used once, to index caches written before they were bounded). */
  getAll?(): Promise<Record<string, unknown>>;
}

export type VaultErrorCode =
  | 'no_vault'
  | 'exists'
  | 'locked'
  | 'bad_password'
  | 'weak_password'
  | 'bad_mnemonic'
  | 'bad_private_key'
  | 'duplicate'
  | 'not_found'
  | 'primary'
  | 'limit'
  | 'too_many_attempts'
  | 'corrupt';

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = 'VaultError';
  }
}

export { MAX_ACCOUNTS, MIN_PASSWORD_LENGTH };
const HD_PATH = (i: number) => `m/44'/60'/0'/0/${i}`;

const VAULT_KEY = 'celera.vault';
const SESSION_KEY = 'celera.session';
const FAILS_KEY = 'celera.unlockFails';

const SealedSchema = z.object({ iv: z.string(), ct: z.string() });
const VaultRecordSchema = z.object({
  version: z.literal(1),
  kdf: KdfParamsSchema,
  sealed: SealedSchema,
});
type VaultRecord = z.infer<typeof VaultRecordSchema>;

const HexKey = z.string().regex(/^0x[0-9a-f]{64}$/);
const AccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(32),
  address: AddressSchema,
  hidden: z.boolean(),
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('hd'), index: z.number().int().min(0) }),
    z.object({ type: z.literal('key'), keyId: z.string().min(1) }),
  ]),
});
type StoredAccount = z.infer<typeof AccountSchema>;

const PayloadSchema = z.object({
  v: z.literal(1),
  mnemonic: z.string(),
  nextIndex: z.number().int().min(0),
  keys: z.array(z.object({ id: z.string().min(1), privateKey: HexKey })),
  accounts: z.array(AccountSchema).min(1).max(MAX_ACCOUNTS),
  primaryId: z.string(),
});
type Payload = z.infer<typeof PayloadSchema>;

const SessionSchema = z.object({ key: z.string() });
const FailsSchema = z.object({ count: z.number().int(), until: z.number() });

function normalizeMnemonic(input: string): string {
  return input.trim().toLowerCase().split(/\s+/).join(' ');
}

export function isValidMnemonic(input: string): boolean {
  const m = normalizeMnemonic(input);
  const words = m.split(' ').length;
  return (words === 12 || words === 24) && validateMnemonic(m, wordlist);
}

/** Accepts 64 hex chars with or without 0x. Returns lowercase 0x-hex or null. */
export function normalizePrivateKey(input: string): Hex | null {
  const s = input.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(s)) return null;
  const hex = `0x${s}` as Hex;
  try {
    privateKeyToAddress(hex);
    return hex;
  } catch {
    return null;
  }
}

function aadFor(record: Pick<VaultRecord, 'version' | 'kdf'>): Uint8Array<ArrayBuffer> {
  // Binds the KDF parameters to the ciphertext so they cannot be downgraded.
  const k = record.kdf;
  return new TextEncoder().encode(
    `celera-vault|v${record.version}|${k.alg}|${k.memoryKiB}|${k.iterations}|${k.parallelism}|${k.salt}`,
  );
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, 32);
}

interface Unlocked {
  key: CryptoKey;
  record: VaultRecord;
  payload: Payload;
  hd: HDKey;
}

export interface VaultDeps {
  local: KeyValueStore;
  session: KeyValueStore;
  /** Produces fresh KDF params for a new vault. Defaults to ~500 ms calibration. */
  kdf?: () => Promise<KdfParams>;
  now?: () => number;
}

/**
 * Encrypted wallet store. Only ciphertext + KDF params live in storage.local; the
 * derived AES key lives in storage.session while unlocked so the service worker can
 * restart without asking for the password again.
 */
export class Vault {
  private unlocked: Unlocked | null = null;
  private readonly kdf: () => Promise<KdfParams>;
  private readonly now: () => number;

  constructor(private readonly deps: VaultDeps) {
    this.kdf = deps.kdf ?? (() => calibrateKdf());
    this.now = deps.now ?? Date.now;
  }

  async exists(): Promise<boolean> {
    return (await this.loadRecord()) !== null;
  }

  async isUnlocked(): Promise<boolean> {
    return (await this.restore()) !== null;
  }

  async create(mnemonicInput: string, password: string): Promise<WalletAccount[]> {
    if (await this.exists()) throw new VaultError('exists');
    if (password.length < MIN_PASSWORD_LENGTH) throw new VaultError('weak_password');
    if (!isValidMnemonic(mnemonicInput)) throw new VaultError('bad_mnemonic');
    const mnemonic = normalizeMnemonic(mnemonicInput);

    const hd = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
    const first = this.deriveAccount(hd, 0, 'Wallet 1');
    const payload: Payload = {
      v: 1,
      mnemonic,
      nextIndex: 1,
      keys: [],
      accounts: [first],
      primaryId: first.id,
    };

    const kdf = await this.kdf();
    const raw = await deriveKeyBytes(password, kdf);
    const key = await importAesKey(raw);
    const record: VaultRecord = { version: 1, kdf, sealed: { iv: '', ct: '' } };
    record.sealed = await seal(key, encode(payload), aadFor(record));
    await this.deps.local.set(VAULT_KEY, record);
    await this.deps.session.set(SESSION_KEY, { key: toBase64(raw) });
    wipe(raw);
    this.unlocked = { key, record, payload, hd };
    return this.publicAccounts(payload);
  }

  async unlock(password: string): Promise<WalletAccount[]> {
    const record = await this.loadRecord();
    if (!record) throw new VaultError('no_vault');
    await this.checkThrottle();

    const raw = await deriveKeyBytes(password, record.kdf);
    const key = await importAesKey(raw);
    let payload: Payload;
    try {
      payload = await this.decrypt(key, record);
    } catch (err) {
      wipe(raw);
      if (err instanceof VaultError && err.code === 'corrupt') throw err;
      await this.recordFailure();
      throw new VaultError('bad_password');
    }
    await this.deps.session.remove(FAILS_KEY);
    await this.deps.session.set(SESSION_KEY, { key: toBase64(raw) });
    wipe(raw);
    const hd = HDKey.fromMasterSeed(mnemonicToSeedSync(payload.mnemonic));
    this.verifyAddresses(payload, hd);
    this.unlocked = { key, record, payload, hd };
    return this.publicAccounts(payload);
  }

  async lock(): Promise<void> {
    this.unlocked = null;
    await this.deps.session.remove(SESSION_KEY);
  }

  /** Deletes the vault. Irreversible without the recovery phrase. */
  async reset(): Promise<void> {
    this.unlocked = null;
    await this.deps.session.remove(SESSION_KEY);
    await this.deps.session.remove(FAILS_KEY);
    await this.deps.local.remove(VAULT_KEY);
  }

  async listAccounts(): Promise<WalletAccount[]> {
    return this.publicAccounts((await this.require()).payload);
  }

  async addDerived(name?: string): Promise<WalletAccount> {
    const u = await this.require();
    const p = structuredClone(u.payload);
    if (p.accounts.length >= MAX_ACCOUNTS) throw new VaultError('limit');
    const account = this.deriveAccount(
      u.hd,
      p.nextIndex,
      name ?? `Wallet ${p.accounts.length + 1}`,
    );
    p.nextIndex += 1;
    p.accounts.push(account);
    await this.persist(u, p);
    return this.toPublic(account, p);
  }

  async importPrivateKey(input: string, name?: string): Promise<WalletAccount> {
    const u = await this.require();
    const privateKey = normalizePrivateKey(input);
    if (!privateKey) throw new VaultError('bad_private_key');
    const p = structuredClone(u.payload);
    if (p.accounts.length >= MAX_ACCOUNTS) throw new VaultError('limit');
    const address = privateKeyToAddress(privateKey);
    if (p.accounts.some((a) => a.address === address)) throw new VaultError('duplicate');

    const keyId = crypto.randomUUID();
    p.keys.push({ id: keyId, privateKey });
    const account: StoredAccount = {
      id: crypto.randomUUID(),
      name: cleanName(name ?? '') || `Imported ${p.keys.length}`,
      address,
      hidden: false,
      source: { type: 'key', keyId },
    };
    p.accounts.push(account);
    await this.persist(u, p);
    return this.toPublic(account, p);
  }

  async rename(id: string, name: string): Promise<void> {
    const n = cleanName(name);
    if (!n) throw new VaultError('not_found');
    await this.mutateAccount(id, (a) => {
      a.name = n;
    });
  }

  async setHidden(id: string, hidden: boolean): Promise<void> {
    const u = await this.require();
    if (hidden && u.payload.primaryId === id) throw new VaultError('primary');
    await this.mutateAccount(id, (a) => {
      a.hidden = hidden;
    });
  }

  async setPrimary(id: string): Promise<void> {
    const u = await this.require();
    const p = structuredClone(u.payload);
    const account = p.accounts.find((a) => a.id === id);
    if (!account) throw new VaultError('not_found');
    account.hidden = false;
    p.primaryId = id;
    await this.persist(u, p);
  }

  async remove(id: string): Promise<void> {
    const u = await this.require();
    const p = structuredClone(u.payload);
    const account = p.accounts.find((a) => a.id === id);
    if (!account) throw new VaultError('not_found');
    if (p.primaryId === id) throw new VaultError('primary');
    p.accounts = p.accounts.filter((a) => a.id !== id);
    if (account.source.type === 'key') {
      const keyId = account.source.keyId;
      p.keys = p.keys.filter((k) => k.id !== keyId);
    }
    await this.persist(u, p);
  }

  /** Requires the password again, even while unlocked. Only reachable from the popup. */
  async exportPrivateKey(id: string, password: string): Promise<Hex> {
    await this.verifyPassword(password);
    return this.privateKeyFor(id);
  }

  /** Re-checks the password while unlocked (throttled like unlock). */
  async verifyPassword(password: string): Promise<void> {
    const u = await this.require();
    await this.checkThrottle();
    const raw = await deriveKeyBytes(password, u.record.kdf);
    try {
      await this.decrypt(await importAesKey(raw), u.record);
    } catch {
      await this.recordFailure();
      throw new VaultError('bad_password');
    } finally {
      wipe(raw);
    }
    await this.deps.session.remove(FAILS_KEY);
  }

  /** Background-internal: used by the signer. Never sent over messaging. */
  async privateKeyFor(id: string): Promise<Hex> {
    const u = await this.require();
    const account = u.payload.accounts.find((a) => a.id === id);
    if (!account) throw new VaultError('not_found');
    if (account.source.type === 'key') {
      const keyId = account.source.keyId;
      const entry = u.payload.keys.find((k) => k.id === keyId);
      if (!entry) throw new VaultError('corrupt');
      return entry.privateKey as Hex;
    }
    const child = u.hd.derive(HD_PATH(account.source.index));
    if (!child.privateKey) throw new VaultError('corrupt');
    return bytesToHex(child.privateKey);
  }

  async addressOf(id: string): Promise<Address> {
    const u = await this.require();
    const account = u.payload.accounts.find((a) => a.id === id);
    if (!account) throw new VaultError('not_found');
    return account.address;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async require(): Promise<Unlocked> {
    const u = await this.restore();
    if (!u) throw new VaultError((await this.exists()) ? 'locked' : 'no_vault');
    return u;
  }

  /** Rehydrates after a service-worker restart using the session key. */
  private async restore(): Promise<Unlocked | null> {
    if (this.unlocked) return this.unlocked;
    const session = SessionSchema.safeParse(await this.deps.session.get(SESSION_KEY));
    if (!session.success) return null;
    const record = await this.loadRecord();
    if (!record) return null;
    try {
      const raw = fromBase64(session.data.key);
      const key = await importAesKey(raw);
      wipe(raw);
      const payload = await this.decrypt(key, record);
      const hd = HDKey.fromMasterSeed(mnemonicToSeedSync(payload.mnemonic));
      this.unlocked = { key, record, payload, hd };
      return this.unlocked;
    } catch {
      await this.deps.session.remove(SESSION_KEY);
      return null;
    }
  }

  private async loadRecord(): Promise<VaultRecord | null> {
    const raw = await this.deps.local.get(VAULT_KEY);
    if (raw === undefined || raw === null) return null;
    const parsed = VaultRecordSchema.safeParse(raw);
    if (!parsed.success) throw new VaultError('corrupt');
    return parsed.data;
  }

  private async decrypt(key: CryptoKey, record: VaultRecord): Promise<Payload> {
    const pt = await open(key, record.sealed, aadFor(record));
    const parsed = PayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(pt)));
    wipe(pt);
    if (!parsed.success) throw new VaultError('corrupt');
    return parsed.data;
  }

  private async persist(u: Unlocked, payload: Payload): Promise<void> {
    PayloadSchema.parse(payload);
    const record: VaultRecord = {
      ...u.record,
      sealed: await seal(u.key, encode(payload), aadFor(u.record)),
    };
    await this.deps.local.set(VAULT_KEY, record);
    u.record = record;
    u.payload = payload;
  }

  private async mutateAccount(id: string, fn: (a: StoredAccount) => void): Promise<void> {
    const u = await this.require();
    const p = structuredClone(u.payload);
    const account = p.accounts.find((a) => a.id === id);
    if (!account) throw new VaultError('not_found');
    fn(account);
    await this.persist(u, p);
  }

  private deriveAccount(hd: HDKey, index: number, name: string): StoredAccount {
    const child = hd.derive(HD_PATH(index));
    if (!child.privateKey) throw new VaultError('corrupt');
    return {
      id: crypto.randomUUID(),
      name: cleanName(name) || `Wallet ${index + 1}`,
      address: privateKeyToAddress(bytesToHex(child.privateKey)),
      hidden: false,
      source: { type: 'hd', index },
    };
  }

  /** Guards against a tampered payload pointing an account name at a foreign address. */
  private verifyAddresses(payload: Payload, hd: HDKey): void {
    for (const a of payload.accounts) {
      let expected: Address;
      if (a.source.type === 'hd') {
        const child = hd.derive(HD_PATH(a.source.index));
        if (!child.privateKey) throw new VaultError('corrupt');
        expected = privateKeyToAddress(bytesToHex(child.privateKey));
      } else {
        const keyId = a.source.keyId;
        const entry = payload.keys.find((k) => k.id === keyId);
        if (!entry) throw new VaultError('corrupt');
        expected = privateKeyToAddress(entry.privateKey as Hex);
      }
      if (expected !== a.address) throw new VaultError('corrupt');
    }
  }

  private publicAccounts(p: Payload): WalletAccount[] {
    return p.accounts.map((a) => this.toPublic(a, p));
  }

  private toPublic(a: StoredAccount, p: Payload): WalletAccount {
    return {
      id: a.id,
      name: a.name,
      address: a.address,
      hidden: a.hidden,
      primary: a.id === p.primaryId,
      kind: a.source.type === 'hd' ? 'derived' : 'imported',
      ...(a.source.type === 'hd' ? { index: a.source.index } : {}),
    };
  }

  private async checkThrottle(): Promise<void> {
    const fails = FailsSchema.safeParse(await this.deps.session.get(FAILS_KEY));
    if (fails.success && fails.data.until > this.now()) {
      throw new VaultError('too_many_attempts', fails.data.until - this.now());
    }
  }

  private async recordFailure(): Promise<void> {
    const prev = FailsSchema.safeParse(await this.deps.session.get(FAILS_KEY));
    const count = (prev.success ? prev.data.count : 0) + 1;
    // Free attempts first; then 30 s, 60 s, 120 s … capped at 15 min.
    const delay = count < 5 ? 0 : Math.min(15 * 60_000, 30_000 * 2 ** (count - 5));
    await this.deps.session.set(FAILS_KEY, { count, until: this.now() + delay });
  }
}

function encode(payload: Payload): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(payload));
}
