/**
 * Version history for visualize tabs. Each open and auto-reload snapshots the
 * tab's pane files when their content changed (HTML pages together with the
 * local styles, scripts and media they reference, so an old version renders
 * as it was). Snapshots live under the app's data folder, never the project,
 * each file at its path relative to its root (the cwd, or an outside page's
 * own folder) inside the version's folder (under the root's index when the
 * panes come from several roots). Tabs do not survive a restart, so the
 * folder starts empty every run.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { MAX_VERSION_TURNS, type VisualizeVersionTurn, type VisualizeVersionView } from '../../shared/visualize';
import { insidePath } from './targets';
import { evictVersions, floorBytes } from './version-eviction';
import { collectSnapshot, relOf, type SnapshotSource, snapshotHash } from './version-snapshot';

export { pageReferences, type SnapshotSource as VisualizeSnapshotSource } from './version-snapshot';

export const MAX_VERSIONS_PER_TAB = 20;
export const MAX_SESSION_VERSION_BYTES = 128 * 1024 * 1024;
/** One version's files together; a larger pane is shown live but not kept. */
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

export interface VisualizeVersion extends VisualizeVersionView {
  /** The version's folder (resolved); files sit at their kept paths. */
  dir: string;
  /** The folders the kept files came from (resolved), in pane order. */
  roots: string[];
  /** Each pane file's kept path (`/`-separated), in pane order. */
  panes: string[];
  /** The kept paths of the page assets kept with HTML panes. */
  assets: string[];
  hash: string;
  bytes: number;
  /** The chat card's picture of this version (a PNG data URL), taken when
   *  the turn that made it ended; also kept as `<dir>.png`. */
  thumbnail?: string;
}

/** Where a version's card picture is kept beside its folder. */
const thumbnailFile = (version: Pick<VisualizeVersion, 'dir'>): string => `${version.dir}.png`;

export interface VisualizeVersionLimits {
  maxVersionsPerTab?: number;
  maxSessionBytes?: number;
  maxSnapshotBytes?: number;
}

interface TabHistory {
  versions: VisualizeVersion[];
  next: number;
  /** Serializes snapshots and card picture writes of one tab, so equal
   *  content never lands twice and no file lands while the tab's folder is
   *  removed. Never rejects. */
  chain: Promise<unknown>;
}

const folderName = (value: string): string =>
  /^[\w-]{1,64}$/.test(value) ? value : createHash('sha256').update(value).digest('hex').slice(0, 24);

const sessionFolder = (sessionId: string): string => createHash('sha256').update(sessionId).digest('hex').slice(0, 24);

/** The session's version budget is held by versions eviction may not drop
 *  (each tab's newest and the shown ones), so the current files are not kept. */
export class VersionHistoryFullError extends Error {
  constructor(maxBytes: number) {
    super(`the session's version history is full (${Math.round(maxBytes / 1024 / 1024)} MiB)`);
    this.name = 'VersionHistoryFullError';
  }
}

/** Kept path `kept` of `version`: the folder it came from, its path there,
 *  and the folder of the version that holds that root's files. */
function keptLocation(
  version: Pick<VisualizeVersion, 'dir' | 'roots'>,
  kept: string
): { root: string; rel: string; keptRoot: string } {
  if (version.roots.length === 1) return { root: version.roots[0], rel: kept, keptRoot: version.dir };
  const cut = kept.indexOf('/');
  const index = kept.slice(0, cut);
  return { root: version.roots[Number(index)], rel: kept.slice(cut + 1), keptRoot: join(version.dir, index) };
}

/** The root each pane of `version` was kept from, in pane order. */
export const keptPaneRoots = (version: Pick<VisualizeVersion, 'dir' | 'roots' | 'panes'>): string[] =>
  version.panes.map((kept) => keptLocation(version, kept).root);

/** `live` (a tab's targets) as kept `version` shows them: each pane file in
 *  the version's folder, rooted in the folder that holds its root's files. */
export function keptTargets<T extends { path: string; root: string }>(
  version: Pick<VisualizeVersion, 'dir' | 'roots' | 'panes'>,
  live: T[]
): T[] {
  return version.panes.map((kept, pane) => {
    const { rel, keptRoot } = keptLocation(version, kept);
    return { ...live[pane], path: join(keptRoot, ...rel.split('/')), root: keptRoot };
  });
}

/** The name each kept page asset of `version` is listed, confirmed and
 *  restored by: its path in its root (`/`-separated), qualified with the
 *  root's folder name only when another root keeps an asset at the same path.
 *  Unique within the version (else the kept paths, which always are), so a
 *  confirmation of one root's file never names another root's. */
export function keptAssetNames(version: Pick<VisualizeVersion, 'dir' | 'roots' | 'assets'>): Map<string, string> {
  const located = version.assets.map((kept) => ({ kept, ...keptLocation(version, kept) }));
  const shared = (rel: string) => located.filter((other) => other.rel === rel).length > 1;
  const names = located.map(({ rel, root }) => (shared(rel) ? `${rel} (${basename(root)})` : rel));
  const unique = new Set(names).size === names.length;
  return new Map(located.map(({ kept }, index) => [kept, unique ? names[index] : kept]));
}

/** One file a restore writes: the kept bytes and where they go. */
export interface VisualizeRestoreChange {
  /** What it is listed and confirmed by: an asset's `keptAssetNames` name, a
   *  pane's path in its root. */
  name: string;
  path: string;
  /** The folder the write must stay inside. */
  root: string;
  data: Buffer;
  /** A page asset kept with an HTML pane, not one of the tab's own panes. */
  asset: boolean;
}

/** The files of `version` that differ from the current ones (a missing file,
 *  or one resolving outside its root, differs): page assets first, back in
 *  the folder they were kept from, then each pane at `panePaths[i]`, its
 *  current resolved file. Every destination is contained in the root the
 *  version recorded for it when it was kept, never in a root found later. */
export async function versionChanges(
  version: VisualizeVersion,
  panePaths: string[]
): Promise<VisualizeRestoreChange[]> {
  const names = keptAssetNames(version);
  const entries = [
    ...version.assets.map((kept) => {
      const { root, rel } = keptLocation(version, kept);
      return { name: names.get(kept) ?? kept, kept, path: join(root, ...rel.split('/')), root, asset: true };
    }),
    ...version.panes.map((kept, index) => {
      const { root } = keptLocation(version, kept);
      return { name: relOf(root, panePaths[index]), kept, path: panePaths[index], root, asset: false };
    }),
  ];
  const changes: VisualizeRestoreChange[] = [];
  for (const { kept, ...entry } of entries) {
    const data = await readFile(join(version.dir, ...kept.split('/')));
    const real = await realpath(entry.path).catch(() => null);
    const current = real && insidePath(entry.root, real) ? await readFile(real).catch(() => null) : null;
    if (!current?.equals(data)) changes.push({ ...entry, data });
  }
  return changes;
}

const outsideError = (rel: string) => new Error(`${rel} is outside the working directory`);

/** Where a restore may write `path` right now: its folder re-resolved inside
 *  `root` (a resolved folder), and the file in it, which must not be a link
 *  (never followed) or anything but a file. */
export async function restoreDestination(root: string, path: string): Promise<{ parent: string; file: string }> {
  const rel = relOf(root, path);
  if (!insidePath(root, path)) throw outsideError(rel);
  let parent: string;
  try {
    parent = await realpath(dirname(path));
  } catch {
    throw new Error(`the folder of ${rel} no longer exists`);
  }
  if (!insidePath(root, parent)) throw outsideError(rel);
  const file = join(parent, basename(path));
  const existing = await lstat(file).catch(() => null);
  if (existing?.isSymbolicLink()) throw new Error(`${rel} is a link; restore does not follow it`);
  if (existing && !existing.isFile()) throw new Error(`${rel} is not a file`);
  if (existing && existing.nlink > 1) throw new Error(`${rel} has other hard links; not restored`);
  return { parent, file };
}

type FileIdentity = { dev: bigint; ino: bigint };
const sameFile = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;

/** Write `data` to `path` inside `root` through a handle whose identity is
 *  proven, so no link swapped in at any point can carry the bytes outside:
 *  - an existing file: its identity (dev+ino) is taken from the cwd-contained
 *    path, it is opened without truncation (`O_NOFOLLOW` where the platform
 *    has it), and only when the handle is that same file and the path still
 *    resolves inside `root` is it truncated and written through that handle;
 *  - a missing file: created exclusively (`wx`) in the verified folder, then
 *    the same handle/path check, deleting it on a mismatch.
 *  Any mismatch closes the handle without writing and fails. `beforeOpen` is
 *  a test seam between validation and the open. */
export async function writeFileInside(
  root: string,
  path: string,
  data: Buffer,
  hooks: {
    beforeOpen?(): unknown;
    /** Fail with EEXIST instead of writing over an existing file. */
    exclusive?: boolean;
  } = {}
): Promise<void> {
  const rel = relOf(root, path);
  const { file } = await restoreDestination(root, path);
  const expected = await lstat(file, { bigint: true }).catch(() => null);
  if (expected && hooks.exclusive) throw Object.assign(new Error(`${rel} already exists`), { code: 'EEXIST' });
  if (expected?.isSymbolicLink()) throw new Error(`${rel} is a link; restore does not follow it`);
  if (expected && !expected.isFile()) throw new Error(`${rel} is not a file`);
  await hooks.beforeOpen?.();
  const handle = expected ? await open(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0)) : await open(file, 'wx');
  try {
    const opened = await handle.stat({ bigint: true });
    const real = await realpath(file).catch(() => null);
    const named = real ? await lstat(real, { bigint: true }).catch(() => null) : null;
    const proven =
      opened.isFile() &&
      (!expected || sameFile(opened, expected)) &&
      real !== null &&
      insidePath(root, real) &&
      named !== null &&
      sameFile(opened, named);
    if (!proven) {
      // A file this call created elsewhere is removed again (only if the
      // path still names exactly that file).
      if (!expected && real && named && sameFile(opened, named)) await rm(real, { force: true });
      throw new Error(`${rel} changed while it was restored; nothing was written`);
    }
    // Writing in place reaches every hard link of the file, and another name
    // of it may sit outside cwd: only a file with this single name is written.
    if ((await handle.stat({ bigint: true })).nlink > 1n) {
      if (!expected) await rm(real, { force: true });
      throw new Error(`${rel} has other hard links; not restored`);
    }
    await handle.truncate(0);
    // A fresh handle writes from offset 0.
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/** The tab's history, created on first use. */
function historyIn(sessions: Map<string, Map<string, TabHistory>>, sessionId: string, tabId: string): TabHistory {
  let tabs = sessions.get(sessionId);
  if (!tabs) {
    tabs = new Map();
    sessions.set(sessionId, tabs);
  }
  let history = tabs.get(tabId);
  if (!history) {
    history = { versions: [], next: 1, chain: Promise.resolve() };
    tabs.set(tabId, history);
  }
  return history;
}

interface SnapshotEnv {
  sessions: Map<string, Map<string, TabHistory>>;
  root(): Promise<string>;
  sessionFloor(sessionId: string, tabId: string): number;
  evict(sessionId: string): Promise<void>;
  maxSessionBytes: number;
  maxSnapshotBytes: number;
}

/** One queued snapshot of a tab's files (see the store's `snapshot`). */
async function takeSnapshot(
  { sessions, root, sessionFloor, evict, maxSessionBytes, maxSnapshotBytes }: SnapshotEnv,
  history: TabHistory,
  sessionId: string,
  tabId: string,
  sources: SnapshotSource[],
  label: string | undefined
): Promise<VisualizeVersion | null> {
  const collected = await collectSnapshot(sources, maxSnapshotBytes);
  if (!collected) return null;
  const hash = snapshotHash(collected);
  if (history.versions.at(-1)?.hash === hash) return null;
  if (sessionFloor(sessionId, tabId) + collected.bytes > maxSessionBytes) {
    throw new VersionHistoryFullError(maxSessionBytes);
  }
  const n = history.next;
  history.next += 1;
  const dir = join(await root(), sessionFolder(sessionId), folderName(tabId), String(n));
  for (const [rel, data] of collected.files) {
    const path = join(dir, ...rel.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  if (sessions.get(sessionId)?.get(tabId) !== history) {
    // The tab closed while its files were written.
    await rm(dir, { recursive: true, force: true });
    return null;
  }
  // Checked again together with the commit (no await in between): other
  // tabs' snapshots or the shown version may have changed meanwhile.
  if (sessionFloor(sessionId, tabId) + collected.bytes > maxSessionBytes) {
    await rm(dir, { recursive: true, force: true });
    throw new VersionHistoryFullError(maxSessionBytes);
  }
  const version: VisualizeVersion = {
    n,
    at: Date.now(),
    ...(label ? { label } : {}),
    dir,
    roots: collected.roots,
    panes: collected.panes,
    assets: collected.assets,
    hash,
    bytes: collected.bytes,
  };
  history.versions.push(version);
  await evict(sessionId);
  return version;
}

export function createVisualizeVersionStore(
  options: {
    directory: string;
    /** The version a tab is showing: never evicted. */
    pinned?(sessionId: string, tabId: string): number | null;
  } & VisualizeVersionLimits
) {
  const maxPerTab = options.maxVersionsPerTab ?? MAX_VERSIONS_PER_TAB;
  const maxSessionBytes = options.maxSessionBytes ?? MAX_SESSION_VERSION_BYTES;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES;
  const sessions = new Map<string, Map<string, TabHistory>>();
  /** Closed tabs' drops still running: their history is already forgotten, so
   *  `settled()` waits for them here. */
  const drops = new Set<Promise<void>>();

  let ready: Promise<string> | null = null;
  const root = (): Promise<string> => {
    ready ??= (async () => {
      await rm(options.directory, { recursive: true, force: true });
      await mkdir(options.directory, { recursive: true });
      return realpath(options.directory);
    })().catch((error: unknown) => {
      ready = null;
      throw error;
    });
    return ready;
  };

  /** The version `sessionId`'s tab `tabId` shows (never evicted), or null. */
  const pinnedIn = (sessionId: string) => (tabId: string) => options.pinned?.(sessionId, tabId) ?? null;
  const sessionFloor = (sessionId: string, tabId: string): number =>
    floorBytes(sessions.get(sessionId), pinnedIn(sessionId), tabId);

  /** Drop versions past the per-tab and per-session caps, with their files. */
  const evict = async (sessionId: string) => {
    const tabs = sessions.get(sessionId);
    if (!tabs) return;
    const removed = evictVersions(tabs, pinnedIn(sessionId), maxPerTab, maxSessionBytes);
    await Promise.all(
      removed.flatMap((version) => [
        rm(version.dir, { recursive: true, force: true }),
        rm(thumbnailFile(version), { force: true }),
      ])
    );
  };

  const snapshotEnv: SnapshotEnv = { sessions, root, sessionFloor, evict, maxSessionBytes, maxSnapshotBytes };

  const versionOf = (sessionId: string, tabId: string, n: number): VisualizeVersion | undefined =>
    sessions
      .get(sessionId)
      ?.get(tabId)
      ?.versions.find((version) => version.n === n);

  return {
    /** Keep the tab's current files as a new version unless they match the
     *  newest one (or a pane is too large). Resolves to the new version;
     *  rejects with VersionHistoryFullError, keeping and evicting nothing,
     *  when the versions eviction may not drop leave no room for it. */
    snapshot(
      sessionId: string,
      tabId: string,
      sources: SnapshotSource[],
      label?: string
    ): Promise<VisualizeVersion | null> {
      const history = historyIn(sessions, sessionId, tabId);
      const run = () => takeSnapshot(snapshotEnv, history, sessionId, tabId, sources, label);
      const result = history.chain.then(run, run);
      history.chain = result.catch(() => {});
      return result;
    },
    list(sessionId: string, tabId: string): VisualizeVersion[] {
      return [...(sessions.get(sessionId)?.get(tabId)?.versions ?? [])];
    },
    get(sessionId: string, tabId: string, n: number): VisualizeVersion | undefined {
      return versionOf(sessionId, tabId, n);
    },
    /** Keep `thumbnail` (a PNG data URL) as kept version `n`'s card picture:
     *  in memory at once, and best effort beside its folder as part of the
     *  tab's serialized work (`settled()` and `drop()` wait for the file).
     *  False without that version. */
    keepThumbnail(sessionId: string, tabId: string, n: number, thumbnail: string): boolean {
      const history = sessions.get(sessionId)?.get(tabId);
      const version = history?.versions.find((candidate) => candidate.n === n);
      if (!history || !version) return false;
      version.thumbnail = thumbnail;
      const png = Buffer.from(thumbnail.slice(thumbnail.indexOf(',') + 1), 'base64');
      history.chain = history.chain.then(async () => {
        // The tab closed or the version was evicted while this waited: no file.
        if (sessions.get(sessionId)?.get(tabId) !== history || !history.versions.includes(version)) return;
        try {
          await writeFile(thumbnailFile(version), png);
        } catch (error) {
          console.warn('visualize card picture write failed:', (error as Error).message);
        }
      });
      return true;
    },
    /** Remember that the turn `turn` ended on kept version `n` (it lives and
     *  goes with the version). False without that version. */
    keepTurn(sessionId: string, tabId: string, n: number, turn: VisualizeVersionTurn): boolean {
      const version = versionOf(sessionId, tabId, n);
      if (!version) return false;
      version.turns = [...(version.turns ?? []).filter((one) => one.since !== turn.since), turn].slice(
        -MAX_VERSION_TURNS
      );
      return true;
    },
    /** Resolves once every tab's queued snapshots and picture writes finished,
     *  and every closed tab's drop (which waits for its own writes) is done. */
    async settled(): Promise<void> {
      await Promise.all([
        ...[...sessions.values()].flatMap((tabs) => [...tabs.values()].map((history) => history.chain)),
        ...[...drops].map((pending) => pending.catch(() => {})),
      ]);
    },
    /** Forget a closed tab and delete its files. */
    drop(sessionId: string, tabId: string): Promise<void> {
      const run = (async () => {
        const tabs = sessions.get(sessionId);
        const history = tabs?.get(tabId);
        if (!tabs || !history) return;
        tabs.delete(tabId);
        if (!tabs.size) sessions.delete(sessionId);
        await history.chain;
        if (!ready) return;
        await rm(join(await root(), sessionFolder(sessionId), folderName(tabId)), { recursive: true, force: true });
      })();
      drops.add(run);
      const forget = () => drops.delete(run);
      run.then(forget, forget);
      return run;
    },
  };
}

export type VisualizeVersionStore = ReturnType<typeof createVisualizeVersionStore>;
