// The phone's persisted sessions roster. A cold open used to receive the whole
// roster (~1,800 rows, ~822KB JSON) although almost nothing changed since the
// last visit. The phone now keeps the rows its decoder last held under the
// desktop's roster version (main/remote-roster-log.ts) and, on a sync, claims
// that version with its row count and a digest of its id set — never a row
// list. The desktop answers with only what changed (`__listCatch`) or with
// today's baseline; the phone then checks the rebuilt rows against the
// desktop's digest and resynchronizes from a baseline on any difference.
//
// Wire: the optional fourth `synchronizeViews` parameter,
//   { v: 1 }                                   (can hold a roster, holds none)
//   { v: 1, e: epoch, r: version, n: count, ids: sha256(sorted ids) }
// A desktop that predates it ignores the parameter; a phone that predates it
// never sends one and receives exactly what it always did.
import { viewResumeDigest, type ViewResumePoint } from './remote-view-resume';

export const ROSTER_CLAIM_VERSION = 1;
/** Bumped whenever the persisted record's meaning changes. */
const ROSTER_FORMAT = 1;
const MAX_ROSTER_ROWS = 10_000;
const MAX_ROSTER_CHARS = 8 * 1024 * 1024;
const SAVE_DELAY_MS = 2_000;
const EPOCH_PATTERN = /^[A-Za-z0-9_-]{8,64}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export interface RosterClaim {
  epoch: string;
  version: number;
  count: number;
  ids: string;
}

/** Null for a phone that sent no roster parameter; `claim` null when it can
 *  hold a roster but offers none (or offered one this build cannot read). */
export function readRosterClaim(value: unknown): { claim: RosterClaim | null } | null {
  if (!value || typeof value !== 'object' || (value as { v?: unknown }).v !== ROSTER_CLAIM_VERSION) return null;
  const { e, r, n, ids } = value as Record<string, unknown>;
  if (
    typeof e !== 'string' ||
    !EPOCH_PATTERN.test(e) ||
    !Number.isSafeInteger(r) ||
    (r as number) < 0 ||
    !Number.isSafeInteger(n) ||
    (n as number) < 0 ||
    typeof ids !== 'string' ||
    !DIGEST_PATTERN.test(ids)
  ) {
    return { claim: null };
  }
  return { claim: { epoch: e, version: r as number, count: n as number, ids } };
}

/** The stamp a sessions frame carries: the roster version it brought the
 *  phone to. */
export function readRosterStamp(payload: unknown): [string, number] | null {
  const stamp = payload && typeof payload === 'object' ? (payload as { __roster?: unknown }).__roster : undefined;
  if (!Array.isArray(stamp) || stamp.length !== 2) return null;
  const [epoch, version] = stamp as unknown[];
  return typeof epoch === 'string' && EPOCH_PATTERN.test(epoch) && Number.isSafeInteger(version) && (version as number) >= 0
    ? [epoch, version as number]
    : null;
}

export interface RosterStorage {
  load(): Promise<unknown>;
  save(record: unknown): Promise<void>;
  clear(): Promise<void>;
}

/** One record in one IndexedDB store: bounded by construction. */
export function createIndexedDbRosterStorage(name = 'mixdog-remote-roster'): RosterStorage {
  const STORE = 'roster';
  const KEY = 'sessions';
  let opened: Promise<IDBDatabase> | null = null;
  const database = (): Promise<IDBDatabase> =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error: unknown) => {
      opened = null;
      throw error;
    }));
  const run = async <R>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest): Promise<R> => {
    const db = await database();
    return new Promise<R>((resolve, reject) => {
      const request = act(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result as R);
      request.onerror = () => reject(request.error);
    });
  };
  return {
    load: () => run<unknown>('readonly', (store) => store.get(KEY)),
    save: (record) => run<void>('readwrite', (store) => store.put(record, KEY)),
    clear: () => run<void>('readwrite', (store) => store.delete(KEY)),
  };
}

interface RosterDecoder<T> {
  resumePoint(): ViewResumePoint | null;
  seed(held: ReadonlyArray<readonly [string, T]>): void;
}

interface RosterMirror<T> {
  epoch: string;
  version: number;
  held: Array<[string, T]>;
}

export interface RemoteRosterCache {
  /** The fourth `synchronizeViews` parameter. An empty decoder is seeded with
   *  the rows the claim describes, so a catch-up applies on top of them. */
  claim(): Promise<Record<string, unknown>>;
  /** After every successfully decoded sessions frame. */
  observe(payload: unknown): void;
  /** Wipes memory and storage: unpair, credential change, failed check. */
  clear(): void;
}

/** `scope` names the pairing (desktop + credential material); a record saved
 *  under another scope is never read and is dropped on sight. */
export function createRemoteRosterCache<T>(options: {
  storage: RosterStorage | null;
  scope: () => string | null;
  decoder: RosterDecoder<T>;
  /** The rebuilt rows differ from the desktop's: drop them and resync. */
  onMismatch: () => void;
  saveDelayMs?: number;
}): RemoteRosterCache {
  const { storage, decoder } = options;
  let mirror: RosterMirror<T> | null = null;
  /** The decoder holds exactly `mirror.held`. */
  let current = false;
  let generation = 0;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scopeDigest = async (): Promise<string | null> => {
    const scope = options.scope();
    return scope ? viewResumeDigest(scope) : null;
  };
  const loadGeneration = generation;
  const loaded: Promise<void> = (async () => {
    const [record, scope] = await Promise.all([storage?.load(), scopeDigest()]);
    if (!record || generation !== loadGeneration) return;
    const saved = record as { format?: unknown; scope?: unknown; epoch?: unknown; version?: unknown; held?: unknown };
    const stamp = readRosterStamp({ __roster: [saved.epoch, saved.version] });
    if (
      saved.format !== ROSTER_FORMAT ||
      !scope ||
      saved.scope !== scope ||
      !stamp ||
      !Array.isArray(saved.held) ||
      saved.held.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
    ) {
      await storage?.clear();
      return;
    }
    if (!mirror) mirror = { epoch: stamp[0], version: stamp[1], held: saved.held as Array<[string, T]> };
  })().catch(() => undefined);
  const save = async (): Promise<void> => {
    saveTimer = null;
    const snapshot = mirror;
    const scope = await scopeDigest();
    if (!storage || !snapshot || !scope || snapshot !== mirror) return;
    if (snapshot.held.length > MAX_ROSTER_ROWS || JSON.stringify(snapshot.held).length > MAX_ROSTER_CHARS) {
      await storage.clear();
      return;
    }
    await storage.save({ format: ROSTER_FORMAT, scope, ...snapshot });
  };
  const clear = (): void => {
    generation += 1;
    mirror = null;
    current = false;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    void storage?.clear().catch(() => undefined);
  };
  return {
    async claim() {
      await loaded;
      const none = { v: ROSTER_CLAIM_VERSION };
      const base = mirror;
      if (!base) return none;
      if (decoder.resumePoint()) {
        if (!current) return none;
      } else {
        decoder.seed(base.held);
        current = true;
      }
      const ids = base.held.map(([key]) => key).sort();
      return { ...none, e: base.epoch, r: base.version, n: ids.length, ids: await viewResumeDigest(ids) };
    },
    observe(payload) {
      const stamp = readRosterStamp(payload);
      const point = decoder.resumePoint();
      if (!stamp || !point) {
        current = false;
        return;
      }
      const held = point.held as Array<[string, T]>;
      mirror = { epoch: stamp[0], version: stamp[1], held };
      current = true;
      const check = (payload as { __listCatch?: { digest?: unknown } }).__listCatch;
      if (check) {
        const expected = check.digest;
        const checkedGeneration = generation;
        void viewResumeDigest(held).then((digest) => {
          if (digest === expected || generation !== checkedGeneration) return;
          clear();
          options.onMismatch();
        });
      }
      if (saveTimer === null && storage) {
        saveTimer = setTimeout(() => void save().catch(() => undefined), options.saveDelayMs ?? SAVE_DELAY_MS);
      }
    },
    clear,
  };
}
