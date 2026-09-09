import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredRepositoryCwd } from './git-contract.mjs';
import { requiredString } from './ipc-validation';

// Chat output is untrusted. Only document/media types may launch an associated
// app; executables, scripts, shortcuts and macro-enabled formats stay excluded.
const documentExtensions = new Set([
  '.pptx', '.pdf', '.md', '.markdown', '.txt', '.log',
  '.docx', '.xlsx', '.csv', '.tsv', '.rtf', '.odt', '.ods', '.odp',
  '.json', '.yaml', '.yml', '.xml',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.ico',
  '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.mov', '.webm', '.mkv',
]);

function assertInsideProject(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError('The file path escapes the project directory.');
  }
}

function assertDocumentType(target: string): void {
  if (!documentExtensions.has(extname(target).toLowerCase())) {
    throw new TypeError('This file type cannot be opened from a chat link.');
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
  if (!target || target.startsWith('//') || /[\u0000-\u001f\u007f<>|*"]/.test(target)
    || (drivePath && !isAbsolute(target)) || (drivePath ? target.slice(2) : target).includes(':')) {
    throw new TypeError('Invalid local file path.');
  }
  if (process.platform === 'win32' && target.split('/').some((part) =>
    (part !== '.' && part !== '..' && /[. ]$/.test(part))
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new TypeError('Invalid local file path.');
  }
  return target;
}

export async function openLocalFileLink(
  projectPath: unknown,
  href: unknown,
  openPath: (path: string) => Promise<string>,
): Promise<void> {
  const root = resolve(requiredRepositoryCwd(projectPath));
  const absolute = resolve(root, localLinkPath(href));
  assertInsideProject(root, absolute);
  assertDocumentType(absolute);
  // Check real targets too: a directory junction or renamed symlink must not
  // bypass the Project boundary or the file-type restriction.
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(absolute)]);
  assertInsideProject(realRoot, realTarget);
  assertDocumentType(realTarget);
  const info = await stat(realTarget);
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o111) !== 0)) {
    throw new TypeError('The link must point to a non-executable file.');
  }
  const failure = await openPath(realTarget);
  if (failure) throw new Error(`Unable to open file: ${failure}`);
}
