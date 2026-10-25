/**
 * The linked sign-in file (linked-sign-in.ts): which identity provider (and
 * account, when known) each site was last signed in with through Browser Use. One sealed file next
 * to the saved-login vault, `browser-linked-sign-ins.bin`, sealed and recovered
 * the way the vault is (safeStorage, credential-vault-file.ts), holding
 * `{ version: 1, links }`. A record is the site, the redirect host, the
 * provider, the identity and when it was last used — never a token, an OAuth
 * code or the provider's app list. One record per site and provider: a new
 * sign-in replaces its identity and time.
 */
import { existsSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { safeStorage } from 'electron';

import { readVaultFile, writeVaultFile } from './credential-vault-file';
import {
  type LinkedSignIn,
  type LinkedSignInInput,
  linkedSignInId,
  normalizeLinkedIdentity,
  registrableHost,
} from './linked-sign-in';

export const LINKED_SIGN_IN_FILE_NAME = 'browser-linked-sign-ins.bin';
const MAX_LINKS = 10_000;
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

type Seal = (plaintext: string) => Buffer;
type Unseal = (sealed: Buffer) => string;

const host = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text.length <= 253 && HOST.test(text) ? text : '';
};

/** A stored entry as a record, or null for anything else. */
function parseLink(value: unknown): LinkedSignIn | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  const provider = host(entry.provider);
  const site = host(entry.site);
  if (!provider || !site) return null;
  return {
    id: linkedSignInId(site, provider),
    site,
    redirectHost: host(entry.redirectHost),
    provider,
    identity: normalizeLinkedIdentity(entry.identity),
    lastUsedAt: Number(entry.lastUsedAt) > 0 ? Number(entry.lastUsedAt) : 0,
  };
}

export interface LinkedSignInStoreOptions {
  userDataDirectory: string;
  /** Test seam: the keychain that seals and opens the file; safeStorage by default. */
  seal?: Seal;
  unseal?: Unseal;
  now?: () => number;
}

export class LinkedSignInStore {
  private readonly file: string;
  private readonly seal: Seal;
  private readonly unseal: Unseal;
  private readonly usesSafeStorage: boolean;
  private readonly now: () => number;
  /** The records as last read or written; every reply reads them. */
  private cache: LinkedSignIn[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: LinkedSignInStoreOptions) {
    this.file = join(options.userDataDirectory, LINKED_SIGN_IN_FILE_NAME);
    this.usesSafeStorage = !options.seal;
    this.seal = options.seal ?? ((plaintext) => safeStorage.encryptString(plaintext));
    this.unseal = options.unseal ?? ((sealed) => safeStorage.decryptString(sealed));
    this.now = options.now ?? Date.now;
  }

  /** One read-modify-write at a time, so a save never drops another's record. */
  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async load(): Promise<LinkedSignIn[]> {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) return (this.cache = []);
    if (this.usesSafeStorage && !safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows credential encryption is unavailable.');
    }
    let parsed: unknown;
    try {
      parsed = await readVaultFile(this.file, this.unseal);
    } catch {
      throw new Error('The linked sign-in file could not be opened.');
    }
    // Another shape must not read as empty: the next save would replace it.
    if (parsed !== null && !(typeof parsed === 'object' && Array.isArray((parsed as { links?: unknown }).links))) {
      throw new Error('The linked sign-in file could not be opened.');
    }
    const entries = parsed ? (parsed as { links: unknown[] }).links : [];
    if (entries.length > MAX_LINKS) throw new Error('The linked sign-in file is too large.');
    const links = new Map<string, LinkedSignIn>();
    for (const entry of entries) {
      const link = parseLink(entry);
      if (link) links.set(link.id, link);
    }
    return (this.cache = [...links.values()]);
  }

  private async save(links: LinkedSignIn[]): Promise<void> {
    const stored = links.map(({ site, redirectHost, provider, identity, lastUsedAt }) => ({
      site,
      redirectHost,
      provider,
      identity,
      lastUsedAt,
    }));
    await writeVaultFile(this.file, this.seal(JSON.stringify({ version: 1, links: stored })), this.unseal);
    this.cache = links;
  }

  /** Every record, by site then provider. */
  list(): Promise<LinkedSignIn[]> {
    return this.transaction(async () =>
      [...(await this.load())].sort((a, b) => a.site.localeCompare(b.site) || a.provider.localeCompare(b.provider))
    );
  }

  /** A finished sign-in: the site+provider record now names `identity` (''
   *  when this sign-in named none — an older account is not carried over), used now. */
  record(input: LinkedSignInInput): Promise<void> {
    return this.transaction(async () => {
      const site = host(registrableHost(input.site));
      const provider = host(registrableHost(input.provider));
      if (!site || !provider) return;
      const id = linkedSignInId(site, provider);
      const next: LinkedSignIn = {
        id,
        site,
        redirectHost: host(input.redirectHost),
        provider,
        identity: normalizeLinkedIdentity(input.identity),
        lastUsedAt: this.now(),
      };
      await this.save([...(await this.load()).filter((link) => link.id !== id), next]);
    });
  }

  /** Forget one record; true when there was one. */
  remove(id: string): Promise<boolean> {
    return this.transaction(async () => {
      const links = await this.load();
      const next = links.filter((link) => link.id !== id);
      if (next.length === links.length) return false;
      await this.save(next);
      return true;
    });
  }

  /** Forget every record: the file, its last good copy and any damaged copy kept aside. */
  clear(): Promise<void> {
    return this.transaction(async () => {
      const directory = dirname(this.file);
      const name = basename(this.file);
      const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [] as string[];
        throw error;
      });
      const copies = entries.filter((entry) => entry === `${name}.bak` || entry.startsWith(`${name}.corrupt-`));
      await Promise.all([this.file, ...copies.map((entry) => join(directory, entry))].map((path) => rm(path, { force: true })));
      this.cache = [];
    });
  }
}
