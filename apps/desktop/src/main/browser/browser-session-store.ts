/**
 * Sign-ins across restarts. Chromium keeps the partition's persistent
 * cookies and storage on disk by itself, but a cookie without an expiry —
 * the shape most sign-in sessions take — dies with the process, so a
 * relaunch used to land the agent back on a login page. This store snapshots
 * those cookies, sealed with the OS keychain, and puts them back on the next
 * start. Nothing here reads cookie values into a reply.
 */
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  cookiePartitionKey,
  storedCookieSetDetails,
  type BrowserCookie,
  type BrowserCookieJar,
  type BrowserCookiePartitionKey,
  type BrowserCookieSetDetails,
} from './cookie-jar';

export interface StoredSessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
  partitionKey?: BrowserCookiePartitionKey;
}

export interface BrowserSessionStoreHost {
  cookies: Pick<BrowserCookieJar, 'get' | 'set' | 'supportsPartitions'>;
  directory: string;
  /** Seal and unseal the file; defaults to Electron's safeStorage. */
  encrypt?(text: string): Promise<Buffer | null>;
  decrypt?(data: Buffer): Promise<string | null>;
  now?(): number;
  autosaveMs?: number;
}

const FILE_NAME = 'session-cookies.bin';
const MAX_COOKIES = 4_000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const DEFAULT_AUTOSAVE_MS = 60_000;

async function safeStorageEncrypt(text: string): Promise<Buffer | null> {
  const { safeStorage } = await import('electron');
  if (!safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(text);
}

async function safeStorageDecrypt(data: Buffer): Promise<string | null> {
  const { safeStorage } = await import('electron');
  if (!safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.decryptString(data);
}

/** Only session cookies are worth keeping: the rest Chromium already keeps. */
export function serializeSessionCookies(cookies: BrowserCookie[]): StoredSessionCookie[] {
  const records: StoredSessionCookie[] = [];
  for (const cookie of cookies) {
    if (cookie.session !== true || !cookie.name || !cookie.domain) continue;
    records.push({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      hostOnly: cookie.hostOnly === true,
      sameSite: cookie.sameSite || 'unspecified',
      ...(cookie.partitionKey ? { partitionKey: cookiePartitionKey(cookie.partitionKey) } : {}),
    });
    if (records.length >= MAX_COOKIES) break;
  }
  return records;
}

/** The set request that recreates a stored cookie, still without an expiry. */
export function cookieSetDetails(record: StoredSessionCookie): BrowserCookieSetDetails | null {
  const name = String(record?.name || '');
  const domain = String(record?.domain || '').trim();
  if (!name || !domain) return null;
  const host = domain.replace(/^\./, '');
  if (!host || /[\s/]/.test(host)) return null;
  const path = String(record.path || '/');
  const secure = record.secure === true;
  let partitionKey: BrowserCookiePartitionKey | undefined;
  try {
    partitionKey = cookiePartitionKey(record.partitionKey);
  } catch {
    return null;
  }
  return storedCookieSetDetails({
    name,
    value: String(record.value ?? ''),
    domain,
    hostOnly: record.hostOnly === true,
    path: path.startsWith('/') ? path : `/${path}`,
    secure,
    httpOnly: record.httpOnly === true,
    sameSite: record.sameSite || 'unspecified',
    session: true,
    ...(partitionKey ? { partitionKey } : {}),
  });
}

export function createBrowserSessionStore(host: BrowserSessionStoreHost) {
  const encrypt = host.encrypt || safeStorageEncrypt;
  const decrypt = host.decrypt || safeStorageDecrypt;
  const now = host.now || Date.now;
  const file = join(host.directory, FILE_NAME);
  let saving: Promise<number> | null = null;

  /** Write the current session cookies; the number written is returned. */
  function save(): Promise<number> {
    if (saving) return saving;
    saving = (async () => {
      const records = serializeSessionCookies(await host.cookies.get({}));
      if (!records.length) {
        await rm(file, { force: true });
        return 0;
      }
      const sealed = await encrypt(JSON.stringify({ savedAt: now(), cookies: records }));
      if (!sealed) return 0;
      await mkdir(host.directory, { recursive: true });
      const staging = `${file}.${process.pid}.tmp`;
      await writeFile(staging, sealed, { mode: 0o600 });
      await rename(staging, file);
      return records.length;
    })().finally(() => {
      saving = null;
    });
    return saving;
  }

  /** Put the stored cookies back; the number restored is returned. A stale
   *  or unreadable file is discarded rather than trusted. */
  async function restore(): Promise<number> {
    let sealed: Buffer;
    try {
      sealed = await readFile(file);
    } catch {
      return 0;
    }
    const discard = async () => { await rm(file, { force: true }).catch(() => undefined); };
    const text = await decrypt(sealed).catch(() => null);
    if (!text) {
      await discard();
      return 0;
    }
    let parsed: { savedAt?: unknown; cookies?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      await discard();
      return 0;
    }
    if (typeof parsed?.savedAt !== 'number' || now() - parsed.savedAt > MAX_AGE_MS
      || !Array.isArray(parsed.cookies)) {
      await discard();
      return 0;
    }
    let restored = 0;
    for (const record of (parsed.cookies as StoredSessionCookie[]).slice(0, MAX_COOKIES)) {
      const details = cookieSetDetails(record);
      if (!details) continue;
      if (details.partitionKey && host.cookies.supportsPartitions !== true) continue;
      try {
        await host.cookies.set(details);
        restored += 1;
      } catch {
        // One rejected cookie must not cost the rest.
      }
    }
    return restored;
  }

  function startAutosave(): () => void {
    const timer = setInterval(() => {
      void save().catch(() => undefined);
    }, host.autosaveMs ?? DEFAULT_AUTOSAVE_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { save, restore, startAutosave, file };
}