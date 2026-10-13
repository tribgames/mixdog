/**
 * Version history for visualize tabs. Each open and auto-reload snapshots the
 * tab's pane files when their content changed (HTML pages together with the
 * local styles, scripts and media they reference, so an old version renders
 * as it was). Snapshots live under the app's data folder, never the project,
 * each file at its cwd-relative path inside the version's folder. Tabs do not
 * survive a restart, so the folder starts empty every run.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import type { VisualizeVersionView } from '../../shared/visualize';
import { pageAssetType } from '../local-page-server';
import { insidePath } from './targets';

export const MAX_VERSIONS_PER_TAB = 20;
export const MAX_SESSION_VERSION_BYTES = 128 * 1024 * 1024;
/** One version's files together; a larger pane is shown live but not kept. */
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_PAGE_ASSETS = 64;

export interface VisualizeSnapshotSource {
  kind: string;
  /** Symlink-resolved file inside the working directory. */
  path: string;
}

export interface VisualizeVersion extends VisualizeVersionView {
  /** The version's folder (resolved); files sit at their cwd-relative paths. */
  dir: string;
  /** Each pane file's cwd-relative path (`/`-separated), in pane order. */
  panes: string[];
  /** The page assets kept with HTML panes (cwd-relative, `/`-separated). */
  assets: string[];
  hash: string;
  bytes: number;
}

export interface VisualizeVersionLimits {
  maxVersionsPerTab?: number;
  maxSessionBytes?: number;
  maxSnapshotBytes?: number;
}

interface TabHistory {
  versions: VisualizeVersion[];
  next: number;
  /** Serializes snapshots of one tab, so equal content never lands twice. */
  chain: Promise<unknown>;
}

const ELEMENT = /<(?:link|script|img|source|video|audio|track|embed|input)\b[^>]*>/gi;
const REFERENCE = /\s(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Local relative references (styles, scripts, media) of an HTML page. */
export function pageReferences(html: string): string[] {
  const found = new Set<string>();
  for (const element of html.match(ELEMENT) ?? []) {
    for (const match of element.matchAll(REFERENCE)) {
      const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
      // Root-relative paths leave the page's lease; schemes are not local.
      if (!raw || raw.startsWith('#') || raw.startsWith('/') || raw.startsWith('\\') || SCHEME.test(raw)) continue;
      const path = raw.replace(/[?#].*$/, '');
      try {
        found.add(decodeURIComponent(path));
      } catch {
        found.add(path);
      }
      if (found.size >= MAX_PAGE_ASSETS) return [...found];
    }
  }
  return [...found];
}

const folderName = (value: string): string =>
  /^[\w-]{1,64}$/.test(value) ? value : createHash('sha256').update(value).digest('hex').slice(0, 24);

const sessionFolder = (sessionId: string): string => createHash('sha256').update(sessionId).digest('hex').slice(0, 24);

const relOf = (root: string, path: string): string => relative(root, path).split(sep).join('/');

/** The session's version budget is held by versions eviction may not drop
 *  (each tab's newest and the shown ones), so the current files are not kept. */
export class VersionHistoryFullError extends Error {
  constructor(maxBytes: number) {
    super(`the session's version history is full (${Math.round(maxBytes / 1024 / 1024)} MiB)`);
    this.name = 'VersionHistoryFullError';
  }
}

/** One file a restore writes: the kept bytes and where they go. */
export interface VisualizeRestoreChange {
  /** cwd-relative, `/`-separated. */
  rel: string;
  path: string;
  data: Buffer;
  /** A page asset kept with an HTML pane, not one of the tab's own panes. */
  asset: boolean;
}

/** The files of `version` that differ from the project's current ones (a
 *  missing file, or one resolving outside cwd, differs): page assets first,
 *  then each pane at `panePaths[i]`, its current resolved file. */
export async function versionChanges(
  version: VisualizeVersion,
  realCwd: string,
  panePaths: string[]
): Promise<VisualizeRestoreChange[]> {
  const entries = [
    ...version.assets.map((rel) => ({ rel, kept: rel, path: join(realCwd, ...rel.split('/')), asset: true })),
    ...version.panes.map((kept, index) => ({
      rel: relOf(realCwd, panePaths[index]),
      kept,
      path: panePaths[index],
      asset: false,
    })),
  ];
  const changes: VisualizeRestoreChange[] = [];
  for (const entry of entries) {
    const data = await readFile(join(version.dir, ...entry.kept.split('/')));
    const real = await realpath(entry.path).catch(() => null);
    const current = real && insidePath(realCwd, real) ? await readFile(real).catch(() => null) : null;
    if (!current?.equals(data)) changes.push({ rel: entry.rel, path: entry.path, data, asset: entry.asset });
  }
  return changes;
}

const outsideError = (rel: string) => new Error(`${rel} is outside the working directory`);

/** Where a restore may write `path` right now: its folder re-resolved inside
 *  `root` (the resolved cwd), and the file in it, which must not be a link
 *  (never followed) or anything but a file. */
export async function restoreDestination(
  root: string,
  path: string
): Promise<{ parent: string; file: string }> {
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
  hooks: { beforeOpen?(): unknown; /** Fail with EEXIST instead of writing over an existing file. */ exclusive?: boolean } = {}
): Promise<void> {
  const rel = relOf(root, path);
  const { file } = await restoreDestination(root, path);
  const expected = await lstat(file, { bigint: true }).catch(() => null);
  if (expected && hooks.exclusive) throw Object.assign(new Error(`${rel} already exists`), { code: 'EEXIST' });
  if (expected?.isSymbolicLink()) throw new Error(`${rel} is a link; restore does not follow it`);
  if (expected && !expected.isFile()) throw new Error(`${rel} is not a file`);
  await hooks.beforeOpen?.();
  const handle = expected
    ? await open(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0))
    : await open(file, 'wx');
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

  const historyOf = (sessionId: string, tabId: string): TabHistory => {
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
  };

  /** The files one version keeps, or null when a pane file is too large. */
  const collect = async (
    cwd: string,
    sources: VisualizeSnapshotSource[]
  ): Promise<{ files: Map<string, Buffer>; panes: string[]; assets: string[]; bytes: number } | null> => {
    const realCwd = await realpath(cwd);
    const files = new Map<string, Buffer>();
    const panes: string[] = [];
    let bytes = 0;
    /** false when the file does not fit the remaining budget. */
    const add = async (path: string): Promise<boolean> => {
      const rel = relOf(realCwd, path);
      if (files.has(rel)) return true;
      const info = await stat(path);
      if (!info.isFile() || bytes + info.size > maxSnapshotBytes) return false;
      const data = await readFile(path);
      if (bytes + data.length > maxSnapshotBytes) return false;
      bytes += data.length;
      files.set(rel, data);
      return true;
    };
    for (const source of sources) {
      if (!insidePath(realCwd, source.path)) throw new Error('a snapshot source is outside the working directory');
      panes.push(relOf(realCwd, source.path));
      if (!(await add(source.path))) return null;
      if (source.kind !== 'html') continue;
      const page = files.get(relOf(realCwd, source.path));
      for (const reference of pageReferences(page?.toString('utf8') ?? '')) {
        let real: string;
        try {
          real = await realpath(resolve(dirname(source.path), reference));
        } catch {
          continue;
        }
        // The page server's own asset policy: inside cwd, not hidden, a web type.
        if (!insidePath(realCwd, real) || !pageAssetType(realCwd, real, dirname(source.path))) continue;
        // An asset that does not fit is left out; the page itself is kept.
        await add(real).catch(() => false);
      }
    }
    const assets = [...files.keys()].filter((rel) => !panes.includes(rel));
    return { files, panes, assets, bytes };
  };

  /** Bytes eviction can never free once `tabId` gains a new newest version:
   *  every other tab's newest and every pinned (shown) version. */
  const floorBytes = (sessionId: string, tabId: string): number => {
    let bytes = 0;
    for (const [id, history] of sessions.get(sessionId) ?? []) {
      const pinned = options.pinned?.(sessionId, id) ?? null;
      const last = history.versions.length - 1;
      history.versions.forEach((version, index) => {
        if (version.n === pinned || (index === last && id !== tabId)) bytes += version.bytes;
      });
    }
    return bytes;
  };

  const hashOf = (files: Map<string, Buffer>, panes: string[]): string => {
    const hash = createHash('sha256').update(panes.join('\0'));
    for (const rel of [...files.keys()].sort()) {
      hash.update(`\0${rel}\0`).update(createHash('sha256').update(files.get(rel) as Buffer).digest());
    }
    return hash.digest('hex');
  };

  /** Drop versions past the per-tab and per-session caps, oldest first; a
   *  tab's newest version and every pinned one stay. */
  const evict = async (sessionId: string) => {
    const tabs = sessions.get(sessionId);
    if (!tabs) return;
    const removed: VisualizeVersion[] = [];
    const evictable = (tabId: string, history: TabHistory) => {
      const pinned = options.pinned?.(sessionId, tabId) ?? null;
      return history.versions.findIndex((version, index) => index < history.versions.length - 1 && version.n !== pinned);
    };
    for (const [tabId, history] of tabs) {
      while (history.versions.length > maxPerTab) {
        const index = evictable(tabId, history);
        if (index < 0) break;
        removed.push(...history.versions.splice(index, 1));
      }
    }
    let total = [...tabs.values()].reduce(
      (sum, history) => sum + history.versions.reduce((tabSum, version) => tabSum + version.bytes, 0),
      0
    );
    while (total > maxSessionBytes) {
      let pick: { history: TabHistory; index: number; at: number } | null = null;
      for (const [tabId, history] of tabs) {
        const index = evictable(tabId, history);
        if (index < 0) continue;
        const at = history.versions[index].at;
        if (!pick || at < pick.at) pick = { history, index, at };
      }
      if (!pick) break;
      const [version] = pick.history.versions.splice(pick.index, 1);
      removed.push(version);
      total -= version.bytes;
    }
    await Promise.all(removed.map((version) => rm(version.dir, { recursive: true, force: true })));
  };

  return {
    /** Keep the tab's current files as a new version unless they match the
     *  newest one (or a pane is too large). Resolves to the new version;
     *  rejects with VersionHistoryFullError, keeping and evicting nothing,
     *  when the versions eviction may not drop leave no room for it. */
    snapshot(
      sessionId: string,
      tabId: string,
      cwd: string,
      sources: VisualizeSnapshotSource[],
      label?: string
    ): Promise<VisualizeVersion | null> {
      const history = historyOf(sessionId, tabId);
      const run = async (): Promise<VisualizeVersion | null> => {
        const collected = await collect(cwd, sources);
        if (!collected) return null;
        const hash = hashOf(collected.files, collected.panes);
        if (history.versions.at(-1)?.hash === hash) return null;
        if (floorBytes(sessionId, tabId) + collected.bytes > maxSessionBytes) {
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
        if (floorBytes(sessionId, tabId) + collected.bytes > maxSessionBytes) {
          await rm(dir, { recursive: true, force: true });
          throw new VersionHistoryFullError(maxSessionBytes);
        }
        const version: VisualizeVersion = {
          n,
          at: Date.now(),
          ...(label ? { label } : {}),
          dir,
          panes: collected.panes,
          assets: collected.assets,
          hash,
          bytes: collected.bytes,
        };
        history.versions.push(version);
        await evict(sessionId);
        return version;
      };
      const result = history.chain.then(run, run);
      history.chain = result.catch(() => {});
      return result;
    },
    list(sessionId: string, tabId: string): VisualizeVersion[] {
      return [...(sessions.get(sessionId)?.get(tabId)?.versions ?? [])];
    },
    get(sessionId: string, tabId: string, n: number): VisualizeVersion | undefined {
      return sessions.get(sessionId)?.get(tabId)?.versions.find((version) => version.n === n);
    },
    /** Forget a closed tab and delete its files. */
    async drop(sessionId: string, tabId: string): Promise<void> {
      const tabs = sessions.get(sessionId);
      const history = tabs?.get(tabId);
      if (!tabs || !history) return;
      tabs.delete(tabId);
      if (!tabs.size) sessions.delete(sessionId);
      await history.chain;
      if (!ready) return;
      await rm(join(await root(), sessionFolder(sessionId), folderName(tabId)), { recursive: true, force: true });
    },
  };
}

export type VisualizeVersionStore = ReturnType<typeof createVisualizeVersionStore>;
