// The branch chip's menu (getBranchMenu / getProjectBranchMenu) is a runtime
// read that spawns git three to four times and parses the worktree registry:
// 1.0–2.1s per call, and the desktop window and every paired phone ask for it
// together on each turn start and end. Nothing in the answer changes unless
// one of the files below does, so an answer is reused while they hold still.
//
// What the menu is made of, and what records each part:
//   - local branch names          refs/heads (names) and packed-refs
//   - the project folder's branch HEAD of the common dir
//   - every linked checkout       worktrees/<id>/HEAD, and its folder (prunable)
//   - who retains each worktree   the managed worktree registry
//   - the session's workspace     its projection's workspace revision (guard)
//   - a pending "Worktree" choice set through this host's capabilities, which
//                                 drop every reused answer (see clear())
import { opendir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

// @ts-expect-error Plain-ESM runtime module without a declaration file.
import { registryPath } from '../../../../src/runtime/shared/worktrees/registry.mjs';

/** A file changed this close to a read's start may be one the read did not
 *  see yet (coarse or lagging file times): that answer is not reused. */
const RACY_MS = 2_000;
/** Kept answers, keyed per session (`session:<id>`) and per project. Nothing
 *  tells this cache a session was deleted, and a host can go days without a
 *  mutation that clears it, so it is a least-recently-used set bounded by
 *  count and by serialized size (a menu of a repository with thousands of
 *  branches is hundreds of KB). */
const MAX_ENTRIES = 64;
const MAX_BYTES = 4 * 1024 * 1024;

interface Stamp {
  key: string;
  /** Newest modification or change time among the stamped files. */
  newest: number;
}

interface Entry<T> {
  result: T;
  commonDir: string;
  folders: string[];
  guard: string;
  stamp: string;
  bytes: number;
}

async function fileStamp(path: string, newest: { value: number }): Promise<string> {
  try {
    const info = await stat(path);
    newest.value = Math.max(newest.value, info.mtimeMs, info.ctimeMs);
    return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;
  } catch {
    return '-';
  }
}

async function names(path: string): Promise<Array<{ name: string; directory: boolean }>> {
  try {
    const rows: Array<{ name: string; directory: boolean }> = [];
    for await (const entry of await opendir(path)) rows.push({ name: entry.name, directory: entry.isDirectory() });
    return rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  } catch {
    return [];
  }
}

/** Every branch name under refs/heads, nested folders included. */
async function refNames(path: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await names(path)) {
    if (entry.directory) out.push(...(await refNames(join(path, entry.name), `${prefix}${entry.name}/`)));
    else out.push(`${prefix}${entry.name}`);
  }
  return out;
}

/** The checkout folder a linked worktree's `gitdir` file points into. */
async function linkedCheckout(adminDir: string): Promise<string> {
  try {
    const target = (await readFile(join(adminDir, 'gitdir'), 'utf8')).trim();
    return target ? (isAbsolute(target) ? target : resolve(adminDir, target)) : '';
  } catch {
    return '';
  }
}

async function branchMenuStamp(commonDir: string, folders: readonly string[], registry: string): Promise<Stamp> {
  const newest = { value: 0 };
  const parts: string[] = [
    await fileStamp(join(commonDir, 'HEAD'), newest),
    await fileStamp(join(commonDir, 'packed-refs'), newest),
    await fileStamp(registry, newest),
    (await refNames(join(commonDir, 'refs', 'heads'))).join('\n'),
  ];
  for (const entry of await names(join(commonDir, 'worktrees'))) {
    if (!entry.directory) continue;
    const adminDir = join(commonDir, 'worktrees', entry.name);
    const checkout = await linkedCheckout(adminDir);
    // A registration whose folder is gone is prunable: it holds no branch.
    const present = checkout
      ? await stat(checkout).then(
          () => '+',
          () => '-'
        )
      : '?';
    parts.push(`${entry.name}:${await fileStamp(join(adminDir, 'HEAD'), newest)}:${checkout}:${present}`);
  }
  // The project folder and the session's checkout must still be folders.
  for (const folder of folders)
    parts.push(
      await stat(folder).then(
        (info) => `${info.isDirectory()}`,
        () => '-'
      )
    );
  return { key: parts.join('\0'), newest: newest.value };
}

/** The git common dir and folders a branch menu answer was read from. */
function menuSources(value: unknown): { commonDir: string; folders: string[] } | null {
  const workspace = (value as { workspace?: { repoCommonDir?: unknown; projectPath?: unknown; cwd?: unknown } } | null)
    ?.workspace;
  const commonDir = typeof workspace?.repoCommonDir === 'string' ? workspace.repoCommonDir : '';
  if (!commonDir) return null;
  const folders = [workspace?.projectPath, workspace?.cwd].filter(
    (folder): folder is string => typeof folder === 'string' && folder.length > 0
  );
  return { commonDir, folders };
}

export interface BranchMenuCache {
  /** The answer under `key`: reused while `guard` and the menu's files hold
   *  still, read through `load` otherwise. A null guard never reuses (or
   *  keeps) an answer. Concurrent identical reads share one load. */
  read<T extends { value: unknown }>(key: string, guard: string | null, load: () => Promise<T>): Promise<T>;
  /** Something this host did may have moved a branch, a worktree or a
   *  pending choice: no earlier answer is reused, nor one read before now. */
  clear(): void;
  /** Test/diagnostic seam: kept answers and their serialized size. */
  stats(): { entries: number; bytes: number };
}

export function createBranchMenuCache({
  registry = registryPath() as string,
  now = Date.now,
  maxEntries = MAX_ENTRIES,
  maxBytes = MAX_BYTES,
}: {
  registry?: string;
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
} = {}): BranchMenuCache {
  // Map order is least recently used first.
  const entries = new Map<string, Entry<{ value: unknown }>>();
  let retainedBytes = 0;
  let generation = 0;
  const drop = (key: string): void => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    retainedBytes -= entry.bytes;
  };
  const keep = (key: string, entry: Entry<{ value: unknown }>): void => {
    drop(key);
    if (entry.bytes > maxBytes) return;
    entries.set(key, entry);
    retainedBytes += entry.bytes;
    while (entries.size > maxEntries || retainedBytes > maxBytes) drop(entries.keys().next().value as string);
  };
  const validated = async (
    startedGeneration: number,
    key: string,
    guard: string | null,
    load: () => Promise<{ value: unknown }>
  ) => {
    const entry = entries.get(key);
    // A request made before a clear() never reuses an answer kept after it.
    if (entry && guard !== null && entry.guard === guard && startedGeneration === generation) {
      const current = await branchMenuStamp(entry.commonDir, entry.folders, registry);
      if (current.key === entry.stamp && entries.get(key) === entry && startedGeneration === generation) {
        keep(key, entry);
        return entry.result;
      }
    }
    if (startedGeneration === generation) drop(key);
    const startedAt = now();
    const result = await load();
    const sources = guard === null ? null : menuSources(result.value);
    if (sources) {
      const stamp = await branchMenuStamp(sources.commonDir, sources.folders, registry);
      if (startedGeneration === generation && stamp.newest < startedAt - RACY_MS) {
        const bytes = Buffer.byteLength(JSON.stringify(result));
        keep(key, { result, ...sources, guard: guard as string, stamp: stamp.key, bytes });
      }
    }
    return result;
  };
  // A read joins only a flight of its own generation and workspace guard: a
  // caller after clear() or a workspace move never shares an older answer.
  const flights = new Map<string, Promise<{ value: unknown }>>();
  return {
    read: <T extends { value: unknown }>(key: string, guard: string | null, load: () => Promise<T>) => {
      const startedGeneration = generation;
      const flight = JSON.stringify([startedGeneration, guard, key]);
      let shared = flights.get(flight);
      if (!shared) {
        shared = validated(startedGeneration, key, guard, load);
        flights.set(flight, shared);
        const settle = (): void => {
          if (flights.get(flight) === shared) flights.delete(flight);
        };
        shared.then(settle, settle);
      }
      return shared as Promise<T>;
    },
    clear: () => {
      generation += 1;
      entries.clear();
      retainedBytes = 0;
    },
    stats: () => ({ entries: entries.size, bytes: retainedBytes }),
  };
}
