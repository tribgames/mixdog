// PATH lookups with no other runtime dependency, so a bundle that only needs
// "is this executable installed?" (the desktop service's feature gates) does
// not pull in the git worker or the rest of runtime-capabilities.
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
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

export function findPathExecutable(
  name,
  { pathValue = process.env.PATH || '', platform = process.platform, maxDirectories = 64 } = {}
) {
  const names = _executableNames(name, platform);
  if (!names.length) return null;
  const seenDirectories = new Set();
  for (const rawDirectory of String(pathValue).split(pathDelimiter)) {
    const directory = _pathDirectory(rawDirectory);
    if (!directory) continue;
    const key = platform === 'win32' ? directory.toLowerCase() : directory;
    if (seenDirectories.has(key)) continue;
    seenDirectories.add(key);
    if (seenDirectories.size > maxDirectories) break;
    for (const executable of names) {
      const file = pathJoin(directory, executable);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
        return `${executable} (${directory.replace(/\\/g, '/')})`;
      } catch {}
    }
  }
  return null;
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
