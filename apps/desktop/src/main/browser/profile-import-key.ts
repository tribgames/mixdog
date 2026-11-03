/**
 * The Chrome App-Bound ("v20") cookie key, kept so later cookie imports do not
 * need the elevated unwrap (a UAC prompt) again.
 *
 * The key is stored only encrypted with Electron `safeStorage` (OS user scope)
 * and is bound to the SHA-256 of the `app_bound_encrypted_key` text it was
 * unwrapped from: when Chrome rotates that blob the saved key no longer
 * belongs to it and is discarded. Without OS encryption nothing is stored.
 */
import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { writeFileAtomicAsync } from '../../../../../src/runtime/shared/atomic-file.mjs';

export const APP_BOUND_KEY_FILE = 'browser-app-bound-key.bin';

/** The slice of Electron `safeStorage` the store needs. */
export interface KeyEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** An automatic import needs the Chrome key but none is saved, or the saved
 *  one no longer fits: only a manual import (one UAC prompt) can provide it. */
export class SavedKeyUnavailableError extends Error {
  constructor() {
    super('A manual import is needed to save the Chrome key again.');
    this.name = 'SavedKeyUnavailableError';
  }
}

const BASE64_ALPHABET = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/');

/** Standard padded base64 of `bytes` as ASCII bytes. Unlike `toString('base64')`
 *  it creates no JS string, so key text never lands in memory that cannot be wiped. */
export function base64Bytes(bytes: Buffer): Buffer {
  const out = Buffer.alloc(Math.ceil(bytes.length / 3) * 4, 0x3d);
  for (let from = 0, to = 0; from < bytes.length; from += 3, to += 4) {
    const chunk = (bytes[from] << 16) | ((bytes[from + 1] ?? 0) << 8) | (bytes[from + 2] ?? 0);
    out[to] = BASE64_ALPHABET[(chunk >> 18) & 63];
    out[to + 1] = BASE64_ALPHABET[(chunk >> 12) & 63];
    if (from + 1 < bytes.length) out[to + 2] = BASE64_ALPHABET[(chunk >> 6) & 63];
    if (from + 2 < bytes.length) out[to + 3] = BASE64_ALPHABET[chunk & 63];
  }
  return out;
}

/** What `app_bound_encrypted_key` is bound by: the hash of its exact base64 text. */
export function appBoundBlobSha256(encoded: string): string {
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

/** The binding hash of the profile's current `app_bound_encrypted_key`, or
 *  undefined when Local State has none (an older Chrome) or cannot be read. */
export async function readAppBoundBlobSha256(localStatePath: string): Promise<string | undefined> {
  try {
    const state = JSON.parse(await readFile(localStatePath, 'utf8')) as {
      os_crypt?: { app_bound_encrypted_key?: unknown };
    };
    const blob = state.os_crypt?.app_bound_encrypted_key;
    return typeof blob === 'string' && blob ? appBoundBlobSha256(blob) : undefined;
  } catch {
    return undefined;
  }
}

export class AppBoundKeyStore {
  constructor(
    private readonly file: string,
    private readonly encryption: KeyEncryption
  ) {}

  /** Whether the OS can protect a key at rest; if not, none is ever stored. */
  available(): boolean {
    return this.encryption.isEncryptionAvailable();
  }

  /** Keep `key` for the blob `blobSha256`. False (nothing written) when the
   *  key or hash is malformed or OS encryption is unavailable. */
  async save(blobSha256: string, key: Buffer): Promise<boolean> {
    if (key.length !== 32 || !SHA256_HEX.test(blobSha256) || !this.available()) return false;
    const sealed = this.encryption.encryptString(
      JSON.stringify({ version: 1, blobSha256, key: key.toString('base64') })
    );
    await writeFileAtomicAsync(this.file, sealed, { secret: true });
    return true;
  }

  /** The saved key if it is still bound to `blobSha256`. A key bound to another
   *  blob (Chrome rotated it) or one that cannot be decrypted is deleted. */
  async load(blobSha256: string): Promise<Buffer | null> {
    let sealed: Buffer;
    try {
      sealed = await readFile(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    // Without OS encryption the file cannot be read, but it is not damaged.
    if (!this.available()) return null;
    let key: Buffer | null = null;
    try {
      const saved = JSON.parse(this.encryption.decryptString(sealed)) as Record<string, unknown>;
      if (saved.version === 1 && saved.blobSha256 === blobSha256 && typeof saved.key === 'string') {
        const candidate = Buffer.from(saved.key, 'base64');
        if (candidate.length === 32) key = candidate;
      }
    } catch {
      key = null;
    }
    if (!key) await this.forget();
    return key;
  }

  /** Whether a key file exists, without decrypting it. */
  async exists(): Promise<boolean> {
    return await stat(this.file).then(
      () => true,
      () => false
    );
  }

  async forget(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
