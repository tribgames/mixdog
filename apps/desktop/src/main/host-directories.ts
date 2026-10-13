// Read-only, directories-only listing for a server window's add-project
// folder picker, usable before any project is registered. It validates like
// addProject (a canonical existing directory) and never returns files or
// file contents.
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Entry cap per listing; the client sees `truncated` when it applies. */
export const HOST_DIRECTORY_LIST_LIMIT = 1_000;
const HOST_DIRECTORY_PATH_MAX = 32_768;

/** An empty request starts at the host user's home directory. */
export function validatedHostDirectoryPath(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('path must be a string.');
  if (value.length > HOST_DIRECTORY_PATH_MAX) throw new TypeError('path is too long.');
  const path = value.trim();
  if (!path) return homedir();
  if (path.includes('\0')) throw new TypeError('path is invalid.');
  // Win32 device namespaces (\\?\ and \\.\) are never a project folder.
  if (/^[\\/]{2}[?.][\\/]/.test(path)) throw new TypeError('path is invalid.');
  if (!isAbsolute(path)) throw new TypeError('path must be absolute.');
  return path;
}

/** Sorted subdirectory names of the canonical directory behind `rawPath`. */
async function readDirectoryNames(
  rawPath: unknown,
  includeHidden: boolean
): Promise<{ canonical: string; names: string[] }> {
  const canonical = await realpath(validatedHostDirectoryPath(rawPath));
  if (!(await stat(canonical)).isDirectory()) throw new TypeError('path is not a directory.');
  const entries = await readdir(canonical, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory() && (includeHidden || !entry.name.startsWith('.')))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  return { canonical, names };
}

export interface ServerDirectoryEntry {
  name: string;
  /** The folder is a git work tree root (it holds a `.git` entry). */
  git: boolean;
}

export interface ServerDirectoryListing {
  /** Canonical directory that was listed. */
  path: string;
  entries: ServerDirectoryEntry[];
  truncated: boolean;
}

/** The folder picker's listing of a server: subfolders with a git marker, and
 *  hidden folders only on request. An empty path starts at the user's home. */
export async function listServerDirectories(
  rawPath: unknown,
  includeHidden: unknown = false
): Promise<ServerDirectoryListing> {
  const { canonical, names } = await readDirectoryNames(rawPath, includeHidden === true);
  const entries = await Promise.all(
    names.slice(0, HOST_DIRECTORY_LIST_LIMIT).map(async (name) => ({
      name,
      git: await stat(join(canonical, name, '.git')).then(
        () => true,
        () => false
      ),
    }))
  );
  return { path: canonical, entries, truncated: names.length > HOST_DIRECTORY_LIST_LIMIT };
}
