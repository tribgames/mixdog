import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { writeFileAtomicAsync, writeJsonAtomicAsync } from '../../../../../src/runtime/shared/atomic-file.mjs';
import {
  cookiePartitionKey,
  storedCookieSetDetails,
  type BrowserCookie,
  type BrowserCookieJar,
  type BrowserCookiePartitionKey,
  type BrowserCookieSetDetails,
} from './cookie-jar';
import { noticeSecretStorageFailure, noticingSafeStorage } from './secret-storage-notice';
import { cookieHost, signOutCookieMatcher, validSignOutSite } from './cookie-sign-out-scopes';

interface StoredSessionCookie {
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

interface BrowserSessionStoreHost {
  cookies: Pick<BrowserCookieJar, 'get' | 'set' | 'supportsPartitions'>;
  directory: string;
  /** Seal and unseal the file; defaults to Electron's safeStorage. */
  encrypt?(text: string): Promise<Buffer | null>;
  decrypt?(data: Buffer): Promise<string | null>;
  now?(): number;
  autosaveMs?: number;
}

const FILE_NAME = 'session-cookies.bin';
const LAYERED_HEADER = Buffer.from('MIXDOG-SESSION-LAYERS\n');
const MAX_COOKIES = 4_000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const DEFAULT_AUTOSAVE_MS = 60_000;

export async function safeStorageEncrypt(text: string): Promise<Buffer | null> {
  const { safeStorage } = await import('electron');
  if (!safeStorage.isEncryptionAvailable()) {
    noticeSecretStorageFailure();
    return null;
  }
  return noticingSafeStorage((plaintext: string) => safeStorage.encryptString(plaintext))(text);
}

export async function safeStorageDecrypt(data: Buffer): Promise<string | null> {
  const { safeStorage } = await import('electron');
  if (!safeStorage.isEncryptionAvailable()) {
    noticeSecretStorageFailure();
    return null;
  }
  return noticingSafeStorage((sealed: Buffer) => safeStorage.decryptString(sealed))(data);
}

/** Only session cookies are worth keeping: the rest Chromium already keeps. */
export function serializeSessionCookies(cookies: BrowserCookie[], limit = MAX_COOKIES): StoredSessionCookie[] {
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
    if (records.length >= limit) break;
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

interface SealedSessionLayer {
  sealed: string;
  excludedSites: string[];
}

function sessionCookieKey(record: StoredSessionCookie, details: BrowserCookieSetDetails): string {
  const partition = details.partitionKey;
  return JSON.stringify([
    cookieHost(String(record.domain).trim()),
    record.hostOnly === true,
    details.name,
    details.path,
    partition?.topLevelSite,
    partition?.hasCrossSiteAncestor,
  ]);
}

function isSignOutScopeList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((site) => typeof site === 'string' && validSignOutSite(site));
}

function readSealedLayers(snapshot: Buffer): SealedSessionLayer[] {
  if (!snapshot.subarray(0, LAYERED_HEADER.length).equals(LAYERED_HEADER)) {
    return [{ sealed: snapshot.toString('base64'), excludedSites: [] }];
  }
  const layers: unknown = JSON.parse(snapshot.subarray(LAYERED_HEADER.length).toString('utf8'));
  if (
    !Array.isArray(layers) ||
    layers.some(
      (layer) => !layer || typeof layer.sealed !== 'string' || !layer.sealed || !isSignOutScopeList(layer.excludedSites)
    )
  ) {
    throw new Error('Invalid browser session snapshot.');
  }
  return layers;
}

function excludeSites(layer: SealedSessionLayer, sites: string[]): SealedSessionLayer {
  return { ...layer, excludedSites: [...new Set([...layer.excludedSites, ...sites])] };
}

export function createBrowserSessionStore(host: BrowserSessionStoreHost) {
  const encrypt = host.encrypt || safeStorageEncrypt;
  const decrypt = host.decrypt || safeStorageDecrypt;
  const now = host.now || Date.now;
  const file = join(host.directory, FILE_NAME);
  const exclusionsFile = `${file}.sign-outs.json`;
  let saving: Promise<number> | null = null;
  let restoring: Promise<unknown> | null = null;
  let invalidating = false;
  // Retain the ordered prefix through the last opaque layer. Cookies restored
  // from that prefix are fallbacks, not new writes that can override it.
  let retainedLayers: SealedSessionLayer[] = [];
  let inherited = new Map<string, { record: StoredSessionCookie; details: BrowserCookieSetDetails }>();
  let tailKeys = new Set<string>();
  let hasReadableTail = false;
  let restoreBlocked = false;

  const digest = (sealed: Buffer) => createHash('sha256').update(sealed).digest('hex');
  async function exclusionsFor(sealed: Buffer): Promise<string[]> {
    let raw: string;
    try {
      raw = await readFile(exclusionsFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const record = JSON.parse(raw) as { digest: unknown; sites: unknown };
    if (typeof record.digest !== 'string' || !isSignOutScopeList(record.sites)) {
      throw new Error('Invalid session snapshot exclusions.');
    }
    return record.digest === digest(sealed) ? record.sites : [];
  }

  /** Write the current session cookies; the number written is returned. */
  function save(): Promise<number> {
    if (invalidating) return Promise.resolve(0);
    return saveSnapshot();
  }

  function saveSnapshot(): Promise<number> {
    if (saving) return saving;
    saving = (async () => {
      await restoring;
      if (restoreBlocked) return 0;
      const jar = await host.cookies.get({});
      let records = serializeSessionCookies(jar, retainedLayers.length ? Infinity : MAX_COOKIES);
      let removed = new Set<string>();
      const writtenKeys: string[] = [];
      if (retainedLayers.length) {
        // A missing cookie that was present in the jar (or already removed
        // by a saved delta) must not fall back to a retained layer later.
        removed = new Set([...inherited.keys(), ...tailKeys]);
        records = records.flatMap((record) => {
          const details = cookieSetDetails(record);
          if (!details) return [];
          const key = sessionCookieKey(record, details);
          removed.delete(key);
          const fallback = inherited.get(key);
          if (
            writtenKeys.length >= MAX_COOKIES ||
            (!tailKeys.has(key) && fallback && JSON.stringify(fallback.details) === JSON.stringify(details))
          )
            return [];
          writtenKeys.push(key);
          return [record];
        });
      }
      const hasUpdates = records.length > 0 || removed.size > 0;
      const sealed = hasUpdates
        ? await encrypt(
            JSON.stringify({ savedAt: now(), cookies: records, ...(removed.size ? { removed: [...removed] } : {}) })
          )
        : null;
      if (hasUpdates && !sealed) return 0;
      if (retainedLayers.length) {
        if (!sealed && !hasReadableTail) return 0;
        const layers = sealed
          ? [...retainedLayers, { sealed: sealed.toString('base64'), excludedSites: [] }]
          : retainedLayers;
        const snapshot = Buffer.concat([LAYERED_HEADER, Buffer.from(JSON.stringify(layers))]);
        await writeFileAtomicAsync(file, snapshot, { secret: true, fsyncDir: true });
      } else if (sealed) {
        await writeFileAtomicAsync(file, sealed, { secret: true, fsyncDir: true });
      } else {
        await rm(file, { force: true });
      }
      hasReadableTail = sealed !== null;
      tailKeys = new Set([...writtenKeys, ...removed]);
      await rm(exclusionsFile, { force: true }).catch(() => undefined);
      return records.length;
    })().finally(() => {
      saving = null;
    });
    return saving;
  }

  /** Restore readable layers, keeping undeciphered snapshots for a later start. */
  function restore(): Promise<number> {
    const run = restoreFromFile().catch((error: unknown) => {
      restoreBlocked = true;
      throw error;
    });
    restoring = run.catch(() => undefined);
    return run;
  }

  async function restoreFromFile(): Promise<number> {
    restoreBlocked = false;
    retainedLayers = [];
    inherited.clear();
    tailKeys.clear();
    hasReadableTail = false;
    let sealed: Buffer;
    try {
      sealed = await readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    if (sealed.length === 0) return 0;
    const sites = await exclusionsFor(sealed);
    const records = new Map<string, { record: StoredSessionCookie; details: BrowserCookieSetDetails }>();
    const layers = readSealedLayers(sealed);
    let prefixLength = 0;
    for (const [index, layer] of layers.entries()) {
      const text = await decrypt(Buffer.from(layer.sealed, 'base64')).catch(() => null);
      if (!text) {
        prefixLength = index + 1;
        if (hasReadableTail) inherited = new Map(records);
        tailKeys.clear();
        hasReadableTail = false;
        continue;
      }
      let parsed: { savedAt?: unknown; cookies?: unknown; removed?: unknown };
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      if (
        typeof parsed?.savedAt !== 'number' ||
        now() - parsed.savedAt > MAX_AGE_MS ||
        !Array.isArray(parsed.cookies)
      ) {
        continue;
      }
      hasReadableTail = true;
      if (Array.isArray(parsed.removed)) {
        for (const key of parsed.removed) {
          if (typeof key !== 'string') continue;
          records.delete(key);
          tailKeys.add(key);
        }
      }
      const excluded = signOutCookieMatcher([...layer.excludedSites, ...sites]);
      for (const record of (parsed.cookies as StoredSessionCookie[]).slice(0, MAX_COOKIES)) {
        const details = cookieSetDetails(record);
        if (!details || excluded(record.domain, record.hostOnly)) continue;
        const partition = details.partitionKey;
        if (partition && host.cookies.supportsPartitions !== true) continue;
        const key = sessionCookieKey(record, details);
        records.set(key, { record, details });
        tailKeys.add(key);
      }
    }
    retainedLayers = layers.slice(0, prefixLength).map((layer) => excludeSites(layer, sites));
    if (!hasReadableTail && !retainedLayers.length) await rm(file, { force: true }).catch(() => undefined);
    let restored = 0;
    for (const [key, { details }] of records) {
      try {
        await host.cookies.set(details);
        restored += 1;
      } catch {
        // A failed restore is not a deletion and must not mask an opaque layer.
        inherited.delete(key);
        tailKeys.delete(key);
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

  /** Bind exclusions to the old sealed bytes, so a restart can still restore
   * other sites and a newer snapshot can include a later deliberate sign-in. */
  async function withSnapshotInvalidated<T>(work: () => Promise<T>, site?: string): Promise<T> {
    invalidating = true;
    try {
      await restoring;
      await saving?.catch(() => undefined);
      if (site === undefined) {
        await writeFileAtomicAsync(file, Buffer.alloc(0), { secret: true, fsyncDir: true });
        retainedLayers = [];
        inherited.clear();
        tailKeys.clear();
        hasReadableTail = false;
        restoreBlocked = false;
      } else {
        if (!validSignOutSite(site)) throw new TypeError('Signed-in site is invalid.');
        const previous = await readFile(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (previous?.length) {
          const sites = [...new Set([...(await exclusionsFor(previous)), site])];
          await writeJsonAtomicAsync(
            exclusionsFile,
            { digest: digest(previous), sites },
            { secret: true, fsyncDir: true }
          );
          retainedLayers = retainedLayers.map((layer) => excludeSites(layer, sites));
          const excluded = signOutCookieMatcher(sites);
          for (const [key, { record }] of inherited) {
            if (excluded(record.domain, record.hostOnly)) inherited.delete(key);
          }
        }
      }
      const result = await work();
      await saveSnapshot();
      return result;
    } finally {
      invalidating = false;
    }
  }

  return { save, restore, withSnapshotInvalidated, startAutosave, file };
}

type CookieChangeListener = (event: unknown, cookie: { session?: boolean }, cause: string, removed: boolean) => void;

/** A sign-in (or sign-out) is written within a second of the cookie change,
 *  not at the next minute's autosave: a crash right after a login would
 *  lose its session cookies, and Chromium's own lazily flushed store could
 *  lose the persistent ones. Session cookies go through the sealed store,
 *  persistent ones are flushed to Chromium's profile. */
export function watchBrowserSessionCookies(
  cookies: {
    on(event: 'changed', listener: CookieChangeListener): unknown;
    removeListener(event: 'changed', listener: CookieChangeListener): unknown;
  },
  store: { save(): Promise<number> },
  jar: Pick<BrowserCookieJar, 'flushStore'>,
  delayMs = 1_000
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sessionChanged = false;
  const write = () => {
    timer = null;
    const saveSession = sessionChanged;
    sessionChanged = false;
    if (saveSession) void store.save().catch(() => undefined);
    void jar.flushStore().catch(() => undefined);
  };
  const listener: CookieChangeListener = (_event, cookie) => {
    if (cookie?.session === true) sessionChanged = true;
    timer ??= setTimeout(write, delayMs);
    timer.unref?.();
  };
  cookies.on('changed', listener);
  return () => {
    cookies.removeListener('changed', listener);
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
