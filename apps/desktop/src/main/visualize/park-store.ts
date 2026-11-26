import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import {
  deferInlineContent,
  type VisualizeGoneOpen,
  type VisualizeInlineContent,
  type VisualizeVersionTurn,
  type VisualizeVersionView,
} from '../../shared/visualize';
import type { VisualizeAnnotation } from '../../shared/visualize-annotations';
import type { HistoryEntry } from './history';
import { type FileTarget, resolvedCanonicalKey, type SessionState, type TabState } from './tab-state';

export interface ParkedTab {
  id: string;
  label: string;
  key: string;
  cwd: string;
  url?: string;
  verify?: true;
  targets: FileTarget[];
  revision: number;
  allowNetwork?: boolean;
  versions?: VisualizeVersionView[];
  shown?: { n: number; restoreAssets?: string[] } | null;
  compare?: boolean;
  pendingReload?: boolean;
  historyFull?: boolean;
  liveUnkept?: boolean;
  liveStat?: string;
  thumbnail?: string;
  thumbnailVersion?: number;
  inline?: VisualizeInlineContent;
  inlineHistory?: Array<{
    n: number;
    at: number;
    content: VisualizeInlineContent;
    thumbnail?: string;
    turns?: VisualizeVersionTurn[];
  }>;
  annotations?: { revision: number; marks: VisualizeAnnotation[] };
  missing?: boolean;
  lastCanonicalKey?: string;
}

export interface ParkedSession {
  active: string | null;
  counter: number;
  cwd?: string;
  history: HistoryEntry[];
  goneOpens?: VisualizeGoneOpen[];
  tabs: ParkedTab[];
}

const sessionFileName = (sessionId: string): string => `${createHash('sha1').update(sessionId).digest('hex')}.json`;

/** Sibling directory outside `versionsDir` so version-store init never wipes parked sessions. */
export const parkDirectoryFor = (versionsDir: string): string => {
  const resolved = resolve(versionsDir);
  return join(dirname(resolved), `${basename(resolved)}-parked`);
};

/** Lightweight history descriptors for parked sessions: drops inline sources so parked
 *  sessions do not retain up to MAX_HISTORY_INLINE_BYTES in RAM while hidden. */
export function stripParkedHistory(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return entries.map((entry) => ({
    ...entry,
    targets: [...entry.targets],
    ...(entry.content ? { content: deferInlineContent(entry.content) } : {}),
  }));
}

const serializeShown = (shown: NonNullable<TabState['shown']>): NonNullable<ParkedTab['shown']> => ({
  n: shown.n,
  ...(shown.restoreAssets.length ? { restoreAssets: shown.restoreAssets } : {}),
});

export function serializeSession(state: SessionState, cwd?: string): ParkedSession {
  return {
    active: state.active,
    counter: state.counter,
    ...(cwd !== undefined ? { cwd } : {}),
    history: state.history,
    ...(state.goneOpens?.length ? { goneOpens: state.goneOpens } : {}),
    tabs: state.tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      key: tab.key,
      cwd: tab.cwd,
      ...(tab.url ? { url: tab.url } : {}),
      ...(tab.verify ? { verify: true as const } : {}),
      targets: tab.targets,
      revision: tab.revision,
      ...(tab.allowNetwork !== undefined ? { allowNetwork: tab.allowNetwork } : {}),
      ...(tab.versions ? { versions: tab.versions } : {}),
      ...(tab.shown ? { shown: serializeShown(tab.shown) } : {}),
      ...(tab.compare ? { compare: true } : {}),
      ...(tab.pendingReload ? { pendingReload: true } : {}),
      ...(tab.historyFull ? { historyFull: true } : {}),
      ...(tab.liveUnkept ? { liveUnkept: true } : {}),
      ...(tab.liveStat ? { liveStat: tab.liveStat } : {}),
      ...(tab.thumbnail ? { thumbnail: tab.thumbnail } : {}),
      ...(tab.thumbnailVersion !== undefined ? { thumbnailVersion: tab.thumbnailVersion } : {}),
      ...(tab.inline ? { inline: tab.inline } : {}),
      ...(tab.inlineHistory ? { inlineHistory: tab.inlineHistory } : {}),
      ...(tab.annotations ? { annotations: tab.annotations } : {}),
      ...(tab.missing ? { missing: true } : {}),
      ...(tab.lastCanonicalKey ? { lastCanonicalKey: tab.lastCanonicalKey } : {}),
    })),
  };
}

export interface ParkStoreFs {
  existsSync: typeof existsSync;
  rmSync: typeof rmSync;
  mkdir: typeof mkdir;
  mkdtemp: typeof mkdtemp;
  readdir: typeof readdir;
  readFile: typeof readFile;
  rm: typeof rm;
  writeFile: typeof writeFile;
}

export function createVisualizeParkStore(directory?: string, fsOverrides?: Partial<ParkStoreFs>) {
  const fsOps: ParkStoreFs = {
    existsSync,
    rmSync,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    writeFile,
    ...fsOverrides,
  };
  let rootPromise: Promise<string> | null = null;
  let ownedTemp = false;
  let rootPath: string | null = null;
  let disposed = false;
  const writtenFiles = new Set<string>();
  const pendingWrites = new Set<Promise<void>>();
  let disposeCleanup: Promise<void> | null = null;

  const clearStaleFiles = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await fsOps.readdir(dir);
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((name) => name.endsWith('.json'))
        .map((name) => fsOps.rm(join(dir, name), { force: true }).catch(() => undefined))
    );
  };

  // Sweep stale parked files left by a prior crash before any new save writes to the folder.
  const staleCleanup: Promise<void> = directory ? clearStaleFiles(directory) : Promise.resolve();

  const ensureRoot = (): Promise<string> => {
    if (rootPromise) return rootPromise;
    rootPromise = (async () => {
      if (directory) {
        await staleCleanup;
        await fsOps.mkdir(directory, { recursive: true });
        rootPath = directory;
        return directory;
      }
      const dir = await fsOps.mkdtemp(join(tmpdir(), 'mixdog-visualize-park-'));
      ownedTemp = true;
      rootPath = dir;
      if (disposed) await fsOps.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return dir;
    })().catch((error) => {
      rootPromise = null;
      throw error;
    });
    return rootPromise;
  };

  const trackWrite = <T>(work: Promise<T>): Promise<T> => {
    const tracked = work.then(
      () => undefined,
      () => undefined
    );
    pendingWrites.add(tracked);
    void tracked.finally(() => pendingWrites.delete(tracked));
    return work;
  };

  const removeTrackedFile = async (file: string): Promise<void> => {
    try {
      await fsOps.rm(file, { force: true });
      writtenFiles.delete(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        writtenFiles.delete(file);
      }
    }
  };

  const sweepTrackedFiles = async (): Promise<void> => {
    for (const file of [...writtenFiles]) {
      await removeTrackedFile(file);
    }
    if (ownedTemp && rootPath) {
      const target = rootPath;
      try {
        await fsOps.rm(target, { recursive: true, force: true });
        rootPath = null;
      } catch {
        // Best effort on dispose.
      }
    }
  };

  return {
    save(sessionId: string, data: ParkedSession): Promise<void> {
      if (disposed) return Promise.resolve();
      return trackWrite(
        (async () => {
          const root = await ensureRoot();
          if (disposed) return;
          const target = join(root, sessionFileName(sessionId));
          const alreadyTracked = writtenFiles.has(target);
          writtenFiles.add(target);
          try {
            await fsOps.mkdir(root, { recursive: true });
            if (disposed) {
              if (!alreadyTracked && !fsOps.existsSync(target)) writtenFiles.delete(target);
              return;
            }
            await fsOps.writeFile(target, JSON.stringify(data), 'utf8');
          } catch (error) {
            if (!alreadyTracked && !fsOps.existsSync(target)) writtenFiles.delete(target);
            throw error;
          }
          if (disposed) {
            writtenFiles.add(target);
            await removeTrackedFile(target);
          }
        })()
      );
    },
    async load(sessionId: string): Promise<ParkedSession | null> {
      if (disposed || !rootPromise) return null;
      const root = await rootPromise;
      if (disposed) return null;
      let raw: string;
      try {
        raw = await fsOps.readFile(join(root, sessionFileName(sessionId)), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw error;
      }
      try {
        return JSON.parse(raw) as ParkedSession;
      } catch {
        return null;
      }
    },
    async remove(sessionId: string): Promise<void> {
      if (!rootPromise && !rootPath) return;
      let root: string | null;
      try {
        root = rootPath ?? (await rootPromise);
      } catch {
        return;
      }
      if (!root) return;
      await removeTrackedFile(join(root, sessionFileName(sessionId)));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const file of [...writtenFiles]) {
        try {
          fsOps.rmSync(file, { force: true });
          writtenFiles.delete(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            writtenFiles.delete(file);
          }
        }
      }
      if (ownedTemp && rootPath) {
        const target = rootPath;
        try {
          fsOps.rmSync(target, { recursive: true, force: true });
          rootPath = null;
        } catch {
          // Retried asynchronously below.
        }
      }
      disposeCleanup = (async () => {
        await staleCleanup;
        await Promise.allSettled([...pendingWrites]);
        if (rootPromise) await rootPromise.catch(() => undefined);
        await sweepTrackedFiles();
      })();
    },
    async settled(): Promise<void> {
      await staleCleanup;
      await Promise.allSettled([...pendingWrites]);
      if (disposeCleanup) await disposeCleanup;
      if (disposed && (writtenFiles.size > 0 || (ownedTemp && rootPath))) {
        await sweepTrackedFiles();
      }
    },
  };
}

export type VisualizeParkStore = ReturnType<typeof createVisualizeParkStore>;

export function createHydratedTab(parked: ParkedTab, panes: TabState['panes'], shown: TabState['shown']): TabState {
  const lastCanonicalKey = parked.lastCanonicalKey ?? resolvedCanonicalKey(parked.targets);
  return {
    id: parked.id,
    label: parked.label,
    key: parked.key,
    cwd: parked.cwd,
    ...(parked.url ? { url: parked.url } : {}),
    ...(parked.verify ? { verify: true as const } : {}),
    targets: parked.targets,
    panes,
    revision: parked.revision,
    unwatch: [],
    lifetime: new AbortController(),
    reloadTimer: null,
    problems: [],
    problemSeq: 0,
    ...(parked.allowNetwork !== undefined ? { allowNetwork: parked.allowNetwork } : {}),
    ...(parked.versions ? { versions: parked.versions } : {}),
    ...(shown ? { shown } : {}),
    ...(parked.compare ? { compare: true } : {}),
    ...(parked.pendingReload ? { pendingReload: true } : {}),
    ...(parked.historyFull ? { historyFull: true } : {}),
    ...(parked.liveUnkept ? { liveUnkept: true } : {}),
    ...(parked.liveStat ? { liveStat: parked.liveStat } : {}),
    ...(parked.thumbnail ? { thumbnail: parked.thumbnail } : {}),
    ...(parked.thumbnailVersion !== undefined ? { thumbnailVersion: parked.thumbnailVersion } : {}),
    ...(parked.inline ? { inline: parked.inline } : {}),
    ...(parked.inlineHistory ? { inlineHistory: parked.inlineHistory } : {}),
    ...(parked.annotations ? { annotations: parked.annotations } : {}),
    ...(parked.missing ? { missing: true } : {}),
    ...(lastCanonicalKey ? { lastCanonicalKey } : {}),
  };
}
