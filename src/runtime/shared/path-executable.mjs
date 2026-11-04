// PATH lookups with no other runtime dependency, so a bundle that only needs
// "is this executable installed?" (the desktop service's feature gates) does
// not pull in the git worker or the rest of runtime-capabilities.
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { delimiter as pathDelimiter, join as pathJoin } from 'node:path';

function _pathDirectory(value) {
  const text = String(value || '').trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

function _executableNames(name, platform) {
  const text = String(name || '').trim();
  if (!text) return [];
  if (platform !== 'win32' || /\.(?:exe|cmd|bat|com)$/i.test(text)) return [text];
  return [text, `${text}.exe`, `${text}.cmd`, `${text}.bat`, `${text}.com`];
}

// PATH directories in search order, each once, at most `maxDirectories`.
function _pathDirectories(pathValue, platform, maxDirectories) {
  const directories = [];
  const seenDirectories = new Set();
  for (const rawDirectory of String(pathValue).split(pathDelimiter)) {
    const directory = _pathDirectory(rawDirectory);
    if (!directory) continue;
    const key = platform === 'win32' ? directory.toLowerCase() : directory;
    if (seenDirectories.has(key)) continue;
    seenDirectories.add(key);
    if (seenDirectories.size > maxDirectories) break;
    directories.push(directory);
  }
  return directories;
}

const _accessMode = (platform) => (platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
const _hit = (executable, directory) => `${executable} (${directory.replace(/\\/g, '/')})`;

export function findPathExecutable(
  name,
  { pathValue = process.env.PATH || '', platform = process.platform, maxDirectories = 64 } = {}
) {
  const names = _executableNames(name, platform);
  if (!names.length) return null;
  for (const directory of _pathDirectories(pathValue, platform, maxDirectories)) {
    for (const executable of names) {
      const file = pathJoin(directory, executable);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, _accessMode(platform));
        return _hit(executable, directory);
      } catch {}
    }
  }
  return null;
}

/**
 * findPathExecutable for several names at once, off the event loop: each PATH
 * directory is listed once (instead of one stat per name, extension and
 * directory) and only a listed candidate is stat'ed (every candidate, in a
 * directory that refuses the listing). Resolves name → the same
 * answer findPathExecutable gives (hit or null); never rejects.
 */
export async function findPathExecutablesAsync(
  names,
  { pathValue = process.env.PATH || '', platform = process.platform, maxDirectories = 64 } = {}
) {
  const fold = (text) => (platform === 'win32' ? text.toLowerCase() : text);
  const found = new Map(names.map((name) => [name, null]));
  const pending = new Map();
  for (const name of names) {
    const candidates = _executableNames(name, platform);
    if (candidates.length) pending.set(name, candidates);
  }
  const directories = _pathDirectories(pathValue, platform, maxDirectories);
  // A directory that exists but cannot be listed (traverse without list
  // permission) may still hold a runnable file: every candidate is checked
  // there one by one, as findPathExecutable does. Missing ones hold nothing.
  const listings = await Promise.all(
    directories.map((directory) =>
      readdir(directory).then(
        (names) => new Set(names.map(fold)),
        (error) => (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? null : 'unlisted')
      )
    )
  );
  for (let index = 0; index < directories.length && pending.size; index += 1) {
    const listed = listings[index];
    if (!listed) continue;
    for (const [name, candidates] of [...pending]) {
      for (const executable of candidates) {
        if (listed !== 'unlisted' && !listed.has(fold(executable))) continue;
        const file = pathJoin(directories[index], executable);
        try {
          if (!(await stat(file)).isFile()) continue;
          await access(file, _accessMode(platform));
        } catch {
          continue;
        }
        found.set(name, _hit(executable, directories[index]));
        pending.delete(name);
        break;
      }
    }
  }
  return found;
}

// Whether a `git` executable is on PATH. The tool surface asks on every
// policy refresh, so the PATH walk is memoized briefly; the short window still
// lets a session opened after a Git install pick the tool up.
const GIT_PRESENCE_TTL_MS = 30_000;
let _gitPresence = null;
export function gitExecutablePresent({ pathValue = process.env.PATH || '', platform = process.platform } = {}) {
  const now = Date.now();
  if (_gitPresence && _gitPresence.pathValue === pathValue && now - _gitPresence.at < GIT_PRESENCE_TTL_MS) {
    return _gitPresence.present;
  }
  const present = Boolean(findPathExecutable('git', { pathValue, platform }));
  _gitPresence = { pathValue, at: now, present };
  return present;
}
