/**
 * The saved-login vault: every login the agent may use, whatever filled it —
 * a Chrome import, a CSV file, a login typed into a chat card, or 설정 › 인증
 * 관리. One sealed file (`browser-password-vault.bin`, credential-vault-file.ts)
 * in the format the Chrome import always wrote, `{ version: 1, credentials }`,
 * so older vaults keep opening; the fields added here (source, authenticator
 * key, the auto sign-in pause) are optional. One login per HTTPS origin and
 * username: saving the same pair again replaces it, everything else stays.
 *
 * Passwords and authenticator keys never leave this process: listings carry
 * only the site, the username and what is stored, and the agent sees masked
 * labels.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, safeStorage } from 'electron';

import { readVaultFile, writeVaultFile } from './credential-vault-file';
import { parseTotpSecret, totpCode } from './totp';

export const VAULT_FILE_NAME = 'browser-password-vault.bin';
const MAX_LOGINS = 100_000;
const MAX_FIELD = 4096;

export type VaultLoginSource = 'chat' | 'manual' | 'chrome' | 'csv';
const SOURCES: readonly VaultLoginSource[] = ['chat', 'manual', 'chrome', 'csv'];

export interface VaultLoginEntry {
  origin: string;
  username: string;
  password: string;
  source: VaultLoginSource;
  totpSecret?: string;
}

/** An import row (Chrome or a CSV file): the saved page address, the login,
 *  and optionally an authenticator key the export carried. */
export interface VaultImportEntry {
  url: string;
  username: string;
  password: string;
  note?: string;
  totpSecret?: string;
}

/** A saved login as listings show it: no password, no authenticator key. */
export interface VaultLoginSummary {
  id: string;
  origin: string;
  username: string;
  hasPassword: boolean;
  hasTotp: boolean;
  source: VaultLoginSource;
  note: string;
  /** False after the site was signed out here: the agent no longer signs in by itself. */
  autoSignIn: boolean;
}

/** An edit from 설정 › 인증 관리. A blank password keeps the saved one; a blank
 *  authenticator key removes it, an absent one keeps it. */
export interface VaultLoginUpdate {
  origin?: string;
  username?: string;
  password?: string;
  totpSecret?: string;
  note?: string;
}

interface StoredVaultLogin {
  id: string;
  /** The HTTPS address it was saved for (an origin, or a Chrome sign-in URL). */
  url: string;
  username: string;
  password: string;
  note: string;
  source: VaultLoginSource;
  totpSecret?: string;
  /** False once the site was signed out here; auto sign-in skips it until a save. */
  autoSignIn: boolean;
  /** When it was last saved or re-saved (ms); metadata, never the secret. */
  savedAt?: number;
  /** When auto sign-in last signed in with it (ms); metadata, never the secret. */
  lastUsedAt?: number;
}

/** `scheme://host[:port]` of an HTTPS URL with no credentials; '' otherwise. */
export function secureOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
}

/** A login's masked display label: the first and last visible character with
 *  the rest hidden, the host kept on an email. The agent never sees more. */
export function maskedCredentialLabel(username: string): string {
  const value = username.trim();
  if (!value) return '저장된 계정';
  const at = value.lastIndexOf('@');
  if (at > 0 && at < value.length - 1) {
    const local = value.slice(0, at);
    const masked = local.length < 3 ? `${local[0] || ''}•••` : `${local[0]}•••${local.at(-1)}`;
    return `${masked}@${value.slice(at + 1)}`;
  }
  if (value.length < 3) return '저장된 계정';
  return `${value[0]}•••${value.at(-1)}`;
}

function loginId(url: string, username: string): string {
  return createHash('sha256').update(`${url}\0${username}`).digest('hex').slice(0, 24);
}

function field(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD) : '';
}

function parseSource(value: unknown): VaultLoginSource {
  return SOURCES.includes(value as VaultLoginSource) ? (value as VaultLoginSource) : 'chrome';
}

const unsealVault = (sealed: Buffer): string => safeStorage.decryptString(sealed);

// One sealed file, possibly several CredentialVault instances (the importer
// builds its own). A read-modify-write must not interleave with another's, or
// a save clobbers logins it never saw — a lost login, or a resurrected delete.
// Every transaction runs in a per-path queue keyed by the resolved file path,
// so instances sharing a file share the queue.
const vaultLocks = new Map<string, Promise<unknown>>();

function withVaultLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = vaultLocks.get(key) ?? Promise.resolve();
  const result = previous.then(work, work);
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  vaultLocks.set(key, tail);
  void tail.then(() => {
    if (vaultLocks.get(key) === tail) vaultLocks.delete(key);
  });
  return result;
}

type Seal = (plaintext: string) => Buffer;
type Unseal = (sealed: Buffer) => string;

export interface CredentialVaultOptions {
  userDataDirectory: string;
  /** Test seam: the keychain that seals and opens the file; safeStorage by default. */
  seal?: Seal;
  unseal?: Unseal;
}

export class CredentialVault {
  private readonly file: string;
  /** The per-path transaction queue key: the resolved absolute file path. */
  private readonly lockKey: string;
  private readonly seal: Seal;
  private readonly unseal: Unseal;
  /** The default keychain enforces OS encryption availability; a test seam does not. */
  private readonly usesSafeStorage: boolean;

  constructor(options: CredentialVaultOptions) {
    this.file = join(options.userDataDirectory, VAULT_FILE_NAME);
    this.lockKey = resolve(this.file);
    this.usesSafeStorage = !options.seal;
    this.seal = options.seal ?? ((plaintext) => safeStorage.encryptString(plaintext));
    this.unseal = options.unseal ?? unsealVault;
  }

  /** Run a transaction in this file's queue (shared across instances). */
  private transaction<T>(work: () => Promise<T>): Promise<T> {
    return withVaultLock(this.lockKey, work);
  }

  /** The stored logins, keeping every entry an older vault held. */
  private async load(): Promise<StoredVaultLogin[]> {
    if (!existsSync(this.file)) return [];
    if (this.usesSafeStorage && !safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows credential encryption is unavailable.');
    }
    let parsed: unknown;
    try {
      parsed = await readVaultFile(this.file, this.unseal);
    } catch {
      throw new Error('The stored browser credential vault could not be opened.');
    }
    // A document that is not the vault's shape must not read as an empty
    // vault: the next save would replace it.
    if (parsed !== null && !(typeof parsed === 'object' && Array.isArray((parsed as { credentials?: unknown }).credentials))) {
      throw new Error('The stored browser credential vault could not be opened.');
    }
    const entries = parsed ? (parsed as { credentials: unknown[] }).credentials : [];
    if (entries.length > MAX_LOGINS) throw new Error('Stored browser credential vault is too large.');
    return entries.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const value = entry as Record<string, unknown>;
      const url = field(value.url);
      const username = field(value.username);
      const password = field(value.password);
      if (!/^[a-f0-9]{24}$/.test(String(value.id || '')) || !secureOrigin(url) || !username || !password) return [];
      return [
        {
          id: String(value.id),
          url,
          username,
          password,
          note: field(value.note),
          source: parseSource(value.source),
          ...(field(value.totpSecret) ? { totpSecret: field(value.totpSecret) } : {}),
          autoSignIn: value.autoSignIn !== false,
          ...(Number(value.savedAt) > 0 ? { savedAt: Number(value.savedAt) } : {}),
          ...(Number(value.lastUsedAt) > 0 ? { lastUsedAt: Number(value.lastUsedAt) } : {}),
        },
      ];
    });
  }

  private async save(logins: StoredVaultLogin[]): Promise<void> {
    const credentials = logins.map((login) => ({
      id: login.id,
      url: login.url,
      username: login.username,
      password: login.password,
      note: login.note,
      source: login.source,
      ...(login.totpSecret ? { totpSecret: login.totpSecret } : {}),
      ...(login.autoSignIn === false ? { autoSignIn: false } : {}),
      ...(login.savedAt ? { savedAt: login.savedAt } : {}),
      ...(login.lastUsedAt ? { lastUsedAt: login.lastUsedAt } : {}),
    }));
    await writeVaultFile(this.file, this.seal(JSON.stringify({ version: 1, credentials })), this.unseal);
  }

  private static summary(login: StoredVaultLogin): VaultLoginSummary {
    return {
      id: login.id,
      origin: secureOrigin(login.url),
      username: login.username,
      hasPassword: Boolean(login.password),
      hasTotp: Boolean(login.totpSecret),
      source: login.source,
      note: login.note,
      autoSignIn: login.autoSignIn,
    };
  }

  /** Every saved login, newest origins first, with no secrets. */
  list(): Promise<VaultLoginSummary[]> {
    return this.transaction(() => this.listCore());
  }

  private async listCore(): Promise<VaultLoginSummary[]> {
    return (await this.load())
      .map((login) => CredentialVault.summary(login))
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  }

  /** The accounts auto sign-in may use for `origin`: masked labels, and only
   *  logins with a password that were not signed out here. */
  accountsFor(origin: string): Promise<Array<{ id: string; label: string }>> {
    return this.transaction(() => this.accountsForCore(origin));
  }

  private async accountsForCore(origin: string): Promise<Array<{ id: string; label: string }>> {
    const wanted = secureOrigin(origin);
    if (!wanted) return [];
    return (await this.load())
      .filter((login) => secureOrigin(login.url) === wanted && login.password && login.autoSignIn)
      .map((login) => ({ id: login.id, label: maskedCredentialLabel(login.username) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /** The accounts auto sign-in may use for `origin`, the one to use first:
   *  the account whose username is the identifier `prefilled` on the page
   *  (exact; case-insensitive for an email), then the one last used for the
   *  site, then the most recently saved (a later entry of the file ties). Masked
   *  labels only. */
  preferredAccountsFor(origin: string, prefilled = ''): Promise<Array<{ id: string; label: string }>> {
    return this.transaction(async () => {
      const wanted = secureOrigin(origin);
      if (!wanted) return [];
      const typed = prefilled.trim();
      const same = (username: string) =>
        Boolean(typed) &&
        (typed.includes('@') || username.includes('@') ? username.toLowerCase() === typed.toLowerCase() : username === typed);
      return (await this.load())
        .map((login, index) => ({ login, index }))
        .filter(({ login }) => secureOrigin(login.url) === wanted && login.password && login.autoSignIn)
        .sort(
          (a, b) =>
            Number(same(b.login.username)) - Number(same(a.login.username)) ||
            (b.login.lastUsedAt ?? 0) - (a.login.lastUsedAt ?? 0) ||
            (b.login.savedAt ?? 0) - (a.login.savedAt ?? 0) ||
            b.index - a.index
        )
        .map(({ login }) => ({ id: login.id, label: maskedCredentialLabel(login.username) }));
    });
  }

  /** The current one-time code of login `id` on `origin` from its stored
   *  authenticator key; '' without a key, for another origin, or a bad key.
   *  Made here and handed to the host's fill only. */
  totpCodeFor(id: string, origin: string, nowMs: number = Date.now()): Promise<string> {
    return this.transaction(async () => {
      const wanted = secureOrigin(origin);
      const login = (await this.load()).find((candidate) => candidate.id === id);
      if (!wanted || !login?.totpSecret || secureOrigin(login.url) !== wanted) return '';
      try {
        return totpCode(parseTotpSecret(login.totpSecret), nowMs);
      } catch {
        return '';
      }
    });
  }

  /** Record that auto sign-in signed in with login `id` just now. */
  markUsed(id: string): Promise<void> {
    return this.transaction(async () => {
      const logins = await this.load();
      const login = logins.find((candidate) => candidate.id === id);
      if (!login) return;
      login.lastUsedAt = Date.now();
      await this.save(logins);
    });
  }

  /** Save one login (origin+username is one entry): its password, source and
   *  authenticator key are replaced, note kept unless the entry is new, and
   *  the auto sign-in pause is cleared. */
  upsert(entry: VaultLoginEntry): Promise<void> {
    return this.transaction(() => this.upsertCore(entry));
  }

  private async upsertCore(entry: VaultLoginEntry): Promise<void> {
    const origin = secureOrigin(entry.origin);
    if (!origin) throw new Error('A saved login needs an HTTPS site.');
    const username = field(entry.username).trim();
    const password = field(entry.password);
    if (!username || !password) throw new Error('A saved login needs a username and a password.');
    if (!SOURCES.includes(entry.source)) throw new Error('A saved login needs a known source.');
    const totpSecret = entry.totpSecret ? normalizeTotpSecret(entry.totpSecret) : undefined;
    const logins = await this.load();
    const existing = logins.find(
      (login) => secureOrigin(login.url) === origin && login.username.toLowerCase() === username.toLowerCase()
    );
    if (existing) {
      existing.password = password;
      existing.source = entry.source;
      existing.autoSignIn = true;
      existing.savedAt = Date.now();
      if (entry.totpSecret !== undefined) {
        if (totpSecret) existing.totpSecret = totpSecret;
        else delete existing.totpSecret;
      }
    } else {
      logins.push({
        id: loginId(origin, username),
        url: origin,
        username,
        password,
        note: '',
        source: entry.source,
        ...(totpSecret ? { totpSecret } : {}),
        autoSignIn: true,
        savedAt: Date.now(),
      });
    }
    await this.save(logins);
  }

  /** Merge an import (Chrome or CSV) into the vault: the same origin+username
   *  has its password and note replaced and keeps everything else; new logins
   *  are added. The vault is never wiped first. Returns how many were stored. */
  mergeImport(source: VaultLoginSource, entries: readonly VaultImportEntry[]): Promise<number> {
    return this.transaction(() => this.mergeImportCore(source, entries));
  }

  private async mergeImportCore(source: VaultLoginSource, entries: readonly VaultImportEntry[]): Promise<number> {
    const logins = await this.load();
    const index = new Map<string, StoredVaultLogin>();
    for (const login of logins) index.set(`${secureOrigin(login.url)}\0${login.username.toLowerCase()}`, login);
    let stored = 0;
    for (const entry of entries) {
      const origin = secureOrigin(entry.url);
      const username = field(entry.username).trim();
      const password = field(entry.password);
      if (!origin || !username || !password) continue;
      const totpSecret = entry.totpSecret ? normalizeTotpSecret(entry.totpSecret) : undefined;
      const key = `${origin}\0${username.toLowerCase()}`;
      const existing = index.get(key);
      if (existing) {
        existing.password = password;
        existing.note = field(entry.note) || existing.note;
        existing.source = source;
        if (totpSecret) existing.totpSecret = totpSecret;
      } else {
        const login: StoredVaultLogin = {
          id: loginId(entry.url, username),
          url: entry.url,
          username,
          password,
          note: field(entry.note),
          source,
          ...(totpSecret ? { totpSecret } : {}),
          autoSignIn: true,
        };
        logins.push(login);
        index.set(key, login);
      }
      stored += 1;
    }
    await this.save(logins);
    return stored;
  }

  /** Edit a saved login. A blank password keeps the stored one; a blank
   *  authenticator key removes it, an absent one keeps it. */
  update(id: string, patch: VaultLoginUpdate): Promise<void> {
    return this.transaction(() => this.updateCore(id, patch));
  }

  private async updateCore(id: string, patch: VaultLoginUpdate): Promise<void> {
    const logins = await this.load();
    const login = logins.find((candidate) => candidate.id === id);
    if (!login) throw new Error('The saved login no longer exists.');
    const origin = patch.origin !== undefined ? secureOrigin(patch.origin) : secureOrigin(login.url);
    if (!origin) throw new Error('A saved login needs an HTTPS site.');
    const username = patch.username !== undefined ? field(patch.username).trim() : login.username;
    if (!username) throw new Error('A saved login needs a username.');
    // A re-entered password with real content is an explicit re-save of the
    // credential; a metadata-only edit (note/username) — or a blank or
    // whitespace-only field — is not and must keep the paused state. The stored
    // value itself is kept verbatim, so a real password keeps its whitespace.
    const credentialResaved = patch.password !== undefined && patch.password.trim() !== '';
    if (credentialResaved) login.password = field(patch.password);
    if (!login.password) throw new Error('A saved login needs a password.');
    if (patch.note !== undefined) login.note = field(patch.note);
    if (patch.totpSecret !== undefined) {
      const totpSecret = patch.totpSecret ? normalizeTotpSecret(patch.totpSecret) : '';
      if (totpSecret) login.totpSecret = totpSecret;
      else delete login.totpSecret;
    }
    login.url = origin;
    login.username = username;
    const nextId = loginId(origin, username);
    if (
      nextId !== login.id &&
      logins.some((candidate) => candidate !== login && candidate.id === nextId)
    ) {
      throw new Error('A login for that site and username already exists.');
    }
    login.id = nextId;
    // Re-saving the credential (a new password) is an explicit intent to use
    // it, so it re-enables auto sign-in; a note-only edit leaves the sign-out
    // pause as it is.
    if (credentialResaved) {
      login.autoSignIn = true;
      login.savedAt = Date.now();
    }
    await this.save(logins);
  }

  /** 설정 › 인증 관리's add/edit: an id edits in place (a blank password keeps
   *  the saved one), no id creates a 직접 추가 login with its optional note. */
  saveManual(input: {
    id?: string;
    origin: string;
    username: string;
    password?: string;
    totpSecret?: string;
    note?: string;
  }): Promise<void> {
    return this.transaction(() => this.saveManualCore(input));
  }

  private async saveManualCore(input: {
    id?: string;
    origin: string;
    username: string;
    password?: string;
    totpSecret?: string;
    note?: string;
  }): Promise<void> {
    if (input.id) {
      await this.updateCore(input.id, {
        origin: input.origin,
        username: input.username,
        password: input.password,
        totpSecret: input.totpSecret,
        note: input.note,
      });
      return;
    }
    if (!input.password) throw new Error('A saved login needs a password.');
    await this.upsertCore({
      origin: input.origin,
      username: input.username,
      password: input.password,
      source: 'manual',
      ...(input.totpSecret ? { totpSecret: input.totpSecret } : {}),
    });
    if (input.note) {
      await this.updateCore(loginId(secureOrigin(input.origin), field(input.username).trim()), { note: input.note });
    }
  }

  /** Delete a saved login by id; true when one was removed. */
  remove(id: string): Promise<boolean> {
    return this.transaction(() => this.removeCore(id));
  }

  private async removeCore(id: string): Promise<boolean> {
    const logins = await this.load();
    const next = logins.filter((login) => login.id !== id);
    if (next.length === logins.length) return false;
    await this.save(next);
    return true;
  }

  /** Stop auto sign-in for every login of `origin` (a sign-out here): the
   *  password stays, but the agent no longer signs straight back in. */
  pauseOrigin(origin: string): Promise<void> {
    return this.transaction(() => this.pauseOriginCore(origin));
  }

  private async pauseOriginCore(origin: string): Promise<void> {
    const wanted = secureOrigin(origin) || secureOrigin(`https://${String(origin).trim()}`);
    if (!wanted) return;
    const logins = await this.load();
    let changed = false;
    for (const login of logins) {
      if (secureOrigin(login.url) === wanted && login.autoSignIn) {
        login.autoSignIn = false;
        changed = true;
      }
    }
    if (changed) await this.save(logins);
  }
}

/** Reject a saved authenticator key that is neither valid base32 nor a usable
 *  otpauth:// address, so a bad key never lands in the vault. */
function normalizeTotpSecret(value: string): string {
  const text = String(value).trim();
  if (!text) return '';
  parseTotpSecret(text);
  return text;
}

let defaultVault: CredentialVault | null = null;
function vault(): CredentialVault {
  if (!defaultVault) defaultVault = new CredentialVault({ userDataDirectory: app.getPath('userData') });
  return defaultVault;
}

// The contract other agents call. Passwords and authenticator keys go in here
// and never come back out: only masked labels and the no-secret summary do.

export function upsertVaultLogin(entry: VaultLoginEntry): Promise<void> {
  return vault().upsert(entry);
}

export function vaultAccountsFor(origin: string): Promise<Array<{ id: string; label: string }>> {
  return vault().accountsFor(origin);
}

export function vaultAutoSignInAccounts(origin: string, prefilled = ''): Promise<Array<{ id: string; label: string }>> {
  return vault().preferredAccountsFor(origin, prefilled);
}

export function vaultTotpCode(id: string, origin: string): Promise<string> {
  return vault().totpCodeFor(id, origin);
}

export function markVaultLoginUsed(id: string): Promise<void> {
  return vault().markUsed(id);
}

export function listVaultLogins(): Promise<VaultLoginSummary[]> {
  return vault().list();
}

export function updateVaultLogin(id: string, patch: VaultLoginUpdate): Promise<void> {
  return vault().update(id, patch);
}

export function deleteVaultLogin(id: string): Promise<boolean> {
  return vault().remove(id);
}

export function pauseVaultOrigin(origin: string): Promise<void> {
  return vault().pauseOrigin(origin);
}