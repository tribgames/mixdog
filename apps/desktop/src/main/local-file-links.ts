import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredRepositoryCwd } from './git-contract.mjs';
import { requiredString } from './ipc-validation';
import { localFileOpener, type LocalLinkOpened } from '../shared/local-files';

function assertInsideProject(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError('The file path escapes the project directory.');
  }
}

function localLinkPath(href: unknown): string {
  const raw = requiredString(href, 'file link', 4_096);
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new TypeError('Invalid file link.');
  let target: string;
  if (/^file:/i.test(raw)) {
    const url = new URL(raw);
    if (url.hostname && url.hostname.toLowerCase() !== 'localhost') {
      throw new TypeError('Network file links are not supported.');
    }
    target = fileURLToPath(url);
  } else {
    target = decodeURIComponent(raw.split(/[?#]/, 1)[0]);
  }
  target = target.replace(/\\/g, '/');
  const drivePath = /^[a-z]:\//i.test(target);
  if (
    !target ||
    target.startsWith('//') ||
    /[\u0000-\u001f\u007f<>|*"]/.test(target) ||
    (drivePath && !isAbsolute(target)) ||
    (drivePath ? target.slice(2) : target).includes(':')
  ) {
    throw new TypeError('Invalid local file path.');
  }
  if (
    process.platform === 'win32' &&
    target
      .split('/')
      .some(
        (part) =>
          (part !== '.' && part !== '..' && /[. ]$/.test(part)) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  ) {
    throw new TypeError('Invalid local file path.');
  }
  return target;
}

// Chat output is untrusted. A folder opens in the file manager and only
// binary document/media types may launch an associated app; every other
// file (source, text, data — and executables, scripts, shortcuts or
// macro-enabled formats) is handed back for Mixdog's editor, which never
// launches anything.
export async function openLocalFileLink(
  projectPath: unknown,
  href: unknown,
  openPath: (path: string) => Promise<string>
): Promise<LocalLinkOpened> {
  const root = resolve(requiredRepositoryCwd(projectPath));
  const absolute = resolve(root, localLinkPath(href));
  assertInsideProject(root, absolute);
  // Check real targets too: a directory junction or renamed symlink must not
  // bypass the Project boundary.
  const [realRoot, realTarget] = await Promise.all([
    realpath(root),
    realpath(absolute).catch((error: NodeJS.ErrnoException) => {
      // A chat link outlives its file: working copies get renamed or removed
      // after the reply is written. Say so instead of leaking ENOENT.
      if (error?.code !== 'ENOENT') throw error;
      throw new Error(`The file no longer exists: ${relative(root, absolute).replace(/\\/g, '/')}`);
    }),
  ]);
  assertInsideProject(realRoot, realTarget);
  const info = await stat(realTarget);
  if (info.isDirectory()) {
    const failure = await openPath(realTarget);
    if (failure) throw new Error(`Unable to open folder: ${failure}`);
    return 'folder';
  }
  if (!info.isFile()) throw new TypeError('The link must point to a file or folder.');
  if (localFileOpener(realTarget) !== 'os') return 'editor';
  if (process.platform !== 'win32' && (info.mode & 0o111) !== 0) {
    throw new TypeError('The link must point to a non-executable file.');
  }
  const failure = await openPath(realTarget);
  if (failure) throw new Error(`Unable to open file: ${failure}`);
  return 'file';
}
