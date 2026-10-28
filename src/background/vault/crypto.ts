import { argon2id } from 'hash-wasm';
import { z } from 'zod';
import { fromBase64, toBase64 } from '../../shared/base64';

/** Argon2id parameters stored next to the ciphertext. */
export const KdfParamsSchema = z.object({
  alg: z.literal('argon2id'),
  /** Memory cost in KiB. */
  memoryKiB: z
    .number()
    .int()
    .min(8)
    .max(1024 * 1024),
  iterations: z.number().int().min(1).max(64),
  parallelism: z.number().int().min(1).max(4),
  /** base64 */
  salt: z.string().min(16),
});
export type KdfParams = z.infer<typeof KdfParamsSchema>;

const DEFAULT_MEMORY_KIB = 64 * 1024;
const MIN_ITERATIONS = 2;
const MAX_ITERATIONS = 16;

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Best-effort wipe; JS gives no guarantees but this shortens the lifetime of copies. */
export function wipe(bytes: Uint8Array | undefined): void {
  bytes?.fill(0);
}

function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

/** Derives a 32-byte key from the password. */
export async function deriveKeyBytes(
  password: string,
  params: KdfParams,
): Promise<Uint8Array<ArrayBuffer>> {
  const out = await argon2id({
    password: normalizePassword(password),
    salt: fromBase64(params.salt),
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memoryKiB,
    hashLength: 32,
    outputType: 'binary',
  });
  return new Uint8Array(out);
}

/**
 * Picks an iteration count so one derivation takes roughly `targetMs` on this machine.
 * Measured once at vault creation; the result is stored with the vault.
 */
export async function calibrateKdf(
  targetMs = 500,
  memoryKiB = DEFAULT_MEMORY_KIB,
  now: () => number = () => performance.now(),
): Promise<KdfParams> {
  const salt = toBase64(randomBytes(16));
  const probe: KdfParams = { alg: 'argon2id', memoryKiB, iterations: 1, parallelism: 1, salt };
  const start = now();
  await deriveKeyBytes('calibration', probe);
  const perIteration = Math.max(1, now() - start);
  const iterations = Math.min(
    MAX_ITERATIONS,
    Math.max(MIN_ITERATIONS, Math.round(targetMs / perIteration)),
  );
  return { ...probe, iterations, salt: toBase64(randomBytes(16)) };
}

export async function importAesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface Sealed {
  /** base64, 12 bytes */
  iv: string;
  /** base64 ciphertext incl. GCM tag */
  ct: string;
}

export async function seal(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    plaintext,
  );
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Throws if the key is wrong or anything (ciphertext, iv, aad) was tampered with. */
export async function open(
  key: CryptoKey,
  sealed: Sealed,
  aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(sealed.iv), additionalData: aad },
    key,
    fromBase64(sealed.ct),
  );
  return new Uint8Array(pt);
}
