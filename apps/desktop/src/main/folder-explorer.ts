// Windows-Explorer-style folder pane service: absolute-path directory
// listing/mutation for the desktop's local explorer surface. The pane carries
// the same trust level as the built-in terminal (the full user filesystem),
// so paths are validated for SHAPE (absolute, bounded, no NUL) instead of
// being sandboxed to a root; mutations still refuse self-nesting/overwrites.
import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, rename, stat, statfs, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export interface FolderDirEntry {
  name: string;
  dir: boolean;
  size: number;
  mtimeMs: number;
}

export interface FolderPlace {
  name: string;
  path: string;
  kind: 'home' | 'desktop' | 'downloads' | 'documents' | 'pictures' | 'music' | 'videos' | 'drive';
  /** Drive capacity (Explorer usage bar); omitted when statfs fails. */
  totalBytes?: number;
  freeBytes?: number;
}

const INVALID_FOLDER_ENTRY_NAME = /[\\/:*?"<>|\u0000-\u001f]/;
const WINDOWS_ATTRIB_MAX_BUFFER = 32 * 1024 * 1024;

/** Parse `attrib.exe` output without applying path-specific exceptions.
 *  Explorer hides either Hidden or System entries in its default view. */
export function windowsExplorerHiddenNames(output: string): Set<string> {
  const hidden = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const pathIndex = line.search(/(?:[A-Za-z]:\\|\\\\)/);
    if (pathIndex < 0 || !/[HS]/.test(line.slice(0, pathIndex))) continue;
    const path = line.slice(pathIndex).trimEnd();
    if (path) hidden.add(basename(path).toLowerCase());
  }
  return hidden;
}

function windowsHiddenSystemNames(dir: string): Promise<Set<string>> {
  if (process.platform !== 'win32') return Promise.resolve(new Set());
  return new Promise((resolveHidden) => {
    // The command is fixed and the browsed path is supplied only as cwd:
    // no user path reaches cmd parsing. UTF-8 keeps non-ASCII entry names
    // comparable with Node's readdir results.
    execFile(
      'cmd.exe',
      ['/d', '/s', '/c', 'chcp 65001>nul & attrib.exe /L /D *'],
      {
        cwd: dir,
        encoding: 'utf8',
        maxBuffer: WINDOWS_ATTRIB_MAX_BUFFER,
        timeout: 15_000,
        windowsHide: true,
      },
      (error, stdout) => {
        resolveHidden(error ? new Set() : windowsExplorerHiddenNames(stdout));
      },
    );
  });
}

/** Shape-validated absolute path for every explorer-pane IPC argument. */
export function browsableFolderPath(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('path must be a string.');
  const text = value.trim();
  if (!text || text.length > 16_384 || text.includes('\0')) {
    throw new TypeError('path is invalid.');
  }
  const resolved = resolve(text);
  if (!isAbsolute(resolved)) throw new TypeError('path must be absolute.');
  return resolved;
}

function folderEntryName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('name must be a string.');
  const name = value.trim();
  if (!name || name.length > 255 || INVALID_FOLDER_ENTRY_NAME.test(name)
    || name === '.' || name === '..' || /[. ]$/.test(name)) {
    throw new TypeError('name is invalid.');
  }
  return name;
}

/** One directory level with explorer metadata (folders first, name order).
 *  UNCAPPED like Explorer — the pane virtualizes rendering, so the only cost
 *  is the stat pass, which runs with bounded concurrency. */
export async function listFolderDirAbs(dir: string): Promise<FolderDirEntry[]> {
  const [allEntries, hiddenNames] = await Promise.all([
    readdir(dir, { withFileTypes: true }),
    windowsHiddenSystemNames(dir),
  ]);
  const entries = allEntries.filter((entry) => !hiddenNames.has(entry.name.toLowerCase()));
  const rows: FolderDirEntry[] = new Array(entries.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= entries.length) return;
      const entry = entries[index];
      const row: FolderDirEntry = {
        name: entry.name, dir: entry.isDirectory(), size: 0, mtimeMs: 0,
      };
      try {
        const info = await stat(join(dir, entry.name));
        row.dir = info.isDirectory();
        row.size = row.dir ? 0 : info.size;
        row.mtimeMs = info.mtimeMs;
      } catch {
        // Broken symlinks / vanished entries keep zeroed metadata.
      }
      rows[index] = row;
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(128, Math.max(1, entries.length)) },
    worker,
  ));
  return rows.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

/** Explorer "New folder"/"New file": never overwrites an existing entry. */
export async function createFolderEntryAbs(
  dir: string,
  name: string,
  isDir: boolean,
): Promise<{ name: string }> {
  // The MAIN process owns unique naming (Explorer "New folder (2)"): the
  // renderer's listing can be stale right after navigation, so a rename-based
  // guess would collide and silently fail.
  const base = folderEntryName(name);
  const dot = isDir ? -1 : base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const extension = dot > 0 ? base.slice(dot) : '';
  let candidate = base;
  for (let counter = 2; counter < 1000; counter++) {
    const target = join(dir, candidate);
    try {
      if (isDir) await mkdir(target);
      else await writeFile(target, '', { encoding: 'utf8', flag: 'wx' });
      return { name: candidate };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      candidate = `${stem} (${counter})${extension}`;
    }
  }
  throw new Error('Could not find a free name.');
}

/** Explorer F2 rename: same directory, never overwrites. */
export async function renameFolderEntryAbs(path: string, newName: string): Promise<void> {
  const target = join(dirname(path), folderEntryName(newName));
  if (target === path) return;
  if (dirname(path) === path) throw new Error('Cannot rename a drive root.');
  if (await stat(target).then(() => true, () => false)) {
    throw new Error('An entry with that name already exists.');
  }
  await rename(path, target);
}

export type FolderMoveStrategy = 'ask' | 'replace' | 'keepBoth' | 'skip';

export interface FolderMoveResult {
  /** Conflicting basenames found under 'ask' — NOTHING was moved. */
  conflicts?: string[];
  /** Every executed move, source → destination (the renderer's undo unit). */
  moved: Array<{ from: string; to: string }>;
}

/** Explorer cut-paste: move entries into a folder; refuses self-nesting.
 *  Name conflicts follow the caller's strategy (Explorer dialog grammar):
 *  'ask' reports and does nothing, 'replace' trashes the existing entry
 *  first (the ipc layer injects the trash step), 'keepBoth' renames like
 *  copy-paste, 'skip' leaves conflicting sources in place. */
export async function moveFolderEntriesAbs(
  paths: string[],
  targetDir: string,
  strategy: FolderMoveStrategy = 'ask',
  trashEntry?: (path: string) => Promise<void>,
): Promise<FolderMoveResult> {
  if (!(await stat(targetDir)).isDirectory()) throw new Error('Move target is not a folder.');
  const exists = (candidate: string) =>
    stat(candidate).then(() => true, () => false);
  const sources: string[] = [];
  const conflicts: string[] = [];
  for (const source of paths) {
    if (dirname(source) === source) throw new Error('Cannot move a drive root.');
    if (targetDir === source || targetDir.startsWith(source + sep)) {
      throw new Error('Cannot move a folder into itself.');
    }
    const destination = join(targetDir, basename(source));
    if (destination === source) continue;
    if (await exists(destination)) conflicts.push(basename(source));
    sources.push(source);
  }
  if (conflicts.length && strategy === 'ask') return { conflicts, moved: [] };
  const moved: Array<{ from: string; to: string }> = [];
  for (const source of sources) {
    let destination = join(targetDir, basename(source));
    if (await exists(destination)) {
      if (strategy === 'skip') continue;
      if (strategy === 'replace') {
        if (!trashEntry) throw new Error('Replace is unavailable.');
        await trashEntry(destination);
      } else {
        const name = basename(source);
        const isDir = (await stat(source)).isDirectory();
        const dot = isDir ? -1 : name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot) : '';
        for (let counter = 2; await exists(destination); counter++) {
          destination = join(targetDir, `${stem} (${counter})${extension}`);
        }
      }
    }
    await rename(source, destination);
    moved.push({ from: source, to: destination });
  }
  return { moved };
}

/** Explorer copy-paste: collisions take "name copy", "name copy 2", ...
 *  Returns the created destinations (the renderer's undo unit). */
export async function copyFolderEntriesAbs(
  paths: string[],
  targetDir: string,
): Promise<{ created: string[] }> {
  if (!(await stat(targetDir)).isDirectory()) throw new Error('Copy target is not a folder.');
  const created: string[] = [];
  for (const source of paths) {
    if (dirname(source) === source) throw new Error('Cannot copy a drive root.');
    if (targetDir === source || targetDir.startsWith(source + sep)) {
      throw new Error('Cannot copy a folder into itself.');
    }
    const sourceIsDir = (await stat(source)).isDirectory();
    const exists = (candidate: string) => stat(join(targetDir, candidate)).then(() => true, () => false);
    let name = basename(source);
    if (await exists(name)) {
      const dot = sourceIsDir ? -1 : name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot) : '';
      let counter = 0;
      while (await exists(name)) {
        counter += 1;
        name = counter === 1 ? `${stem} copy${extension}` : `${stem} copy ${counter}${extension}`;
      }
    }
    await cp(source, join(targetDir, name), { recursive: true, force: false, errorOnExist: true });
    created.push(join(targetDir, name));
  }
  return { created };
}

/** Explorer sidebar: known user folders plus mounted drive roots. */
export async function listFolderPlaces(
  getPath?: (name: 'home' | 'desktop' | 'downloads' | 'documents' | 'pictures' | 'music' | 'videos') => string,
): Promise<FolderPlace[]> {
  const home = homedir();
  const resolveKnown = (
    kind: Exclude<FolderPlace['kind'], 'drive'>,
    fallback: string,
  ): string => {
    try {
      const fromApp = getPath?.(kind);
      if (fromApp && isAbsolute(fromApp)) return fromApp;
    } catch { /* fall through to the home-relative default */ }
    return fallback;
  };
  const known: Array<[Exclude<FolderPlace['kind'], 'drive'>, string, string]> = [
    ['home', 'Home', home],
    ['desktop', 'Desktop', join(home, 'Desktop')],
    ['downloads', 'Downloads', join(home, 'Downloads')],
    ['documents', 'Documents', join(home, 'Documents')],
    ['pictures', 'Pictures', join(home, 'Pictures')],
    ['music', 'Music', join(home, 'Music')],
    ['videos', 'Videos', join(home, 'Videos')],
  ];
  const places: FolderPlace[] = [];
  for (const [kind, name, fallback] of known) {
    const path = resolveKnown(kind, fallback);
    if (await stat(path).then((info) => info.isDirectory(), () => false)) {
      places.push({ name, path, kind });
    }
  }
  if (process.platform === 'win32') {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const probes = await Promise.all([...letters].map(async (letter) => {
      const root = `${letter}:\\`;
      const mounted = await stat(root).then(() => true, () => false);
      return mounted ? root : '';
    }));
    for (const root of probes) {
      if (root) places.push(await drivePlace(root.slice(0, 2), root));
    }
  } else {
    places.push(await drivePlace('/', '/'));
  }
  return places;
}

/** Drive entry with capacity for the Explorer-style usage bar. */
async function drivePlace(name: string, root: string): Promise<FolderPlace> {
  try {
    const stats = await statfs(root);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail ?? stats.bfree) * Number(stats.bsize);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(free)) {
      return { name, path: root, kind: 'drive', totalBytes: total, freeBytes: free };
    }
  } catch { /* capacity is optional decoration */ }
  return { name, path: root, kind: 'drive' };
}
