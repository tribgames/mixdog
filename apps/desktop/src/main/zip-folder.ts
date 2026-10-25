// A folder as an in-memory zip, for a paired device's "download this folder".
// Only regular files are packed. A symbolic link or junction is judged by
// where it leads: it is packed under its own name when its real location is
// inside the folder and not a folder the walk is already inside; anything
// else is left out. The walk stops with FolderTooLargeError
// once the walk ends past a cap — the caller says so, with the counted files
// and size, instead of building a huge archive. ZIP32, deflate, UTF-8 names
// (the caps keep every size far below the 4 GiB format limit).
//
// What the user means by "the folder" leaves out what is not part of the work.
// Inside a git work tree that is git's own verdict (`ls-files -co
// --exclude-standard`: untracked files stay, ignored ones go); outside git it
// is a list of well-known generated folders by name. Every nested repository,
// submodule and linked folder is judged by its own repository's rules, and an
// ignored folder that was asked for is filtered too (only tracked files stay).
// Outside git, a requested folder with a generated name is zipped whole. The
// caps count what is left after the exclusions.
import { deflateRawSync } from 'node:zlib';
import { type BigIntStats, constants } from 'node:fs';
import { type FileHandle, lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { streamNulRecords } from './git-runner';
import { comparablePath, insideRoot } from './opened-file-authorization';
import { openedFilePath } from './opened-file-path';

// O_NOFOLLOW refuses a final component swapped to a symlink after the walk and
// O_NONBLOCK keeps a swapped-in FIFO from blocking; neither exists on Windows,
// where the identity check after opening covers both.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const READ_CHUNK = 64 * 1024;

export interface FolderFile {
  rel: string;
  absolute: string;
  size: number;
  dev: bigint;
  ino: bigint;
}

/** The folder holds more than the caps allow, once exclusions are applied;
 *  `files` and `bytes` are what was counted. */
export class FolderTooLargeError extends Error {
  readonly files: number;
  readonly bytes: number;

  constructor(files: number, bytes: number) {
    super('The folder is too large to zip.');
    this.name = 'FolderTooLargeError';
    this.files = files;
    this.bytes = bytes;
  }
}

/** Outside git: generated folders that are not what "the folder" means. */
const GENERATED_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  'dist',
  'build',
  '.next',
  'target',
]);

type DirectoryVerdict = 'walk' | 'whole' | 'out';

/** What a folder walk leaves out. `null` (no rule) takes everything. */
interface Exclusion {
  /** Whether the file (or link) at `rel` stays. */
  file(rel: string): boolean;
  directory(rel: string, name: string): DirectoryVerdict;
  /** Ignored files counted up front (git); 0 when the walk counts the
   *  folders it leaves out itself (`countLeftOut`). */
  ignored: number;
  countLeftOut: boolean;
}

/** Regular files and links under `directory`, links not followed. */
async function countFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    count += entry.isDirectory() ? await countFiles(join(directory, entry.name)) : 1;
  }
  return count;
}

const GENERATED_FOLDER_RULE: Exclusion = {
  file: () => true,
  directory: (_rel, name) => (GENERATED_FOLDERS.has(name) ? 'out' : 'walk'),
  ignored: 0,
  countLeftOut: true,
};

/** Git's verdict for the work tree `root` is in; null when `root` is not
 *  inside one (or git cannot answer). */
async function gitExclusion(root: string): Promise<Exclusion | null> {
  const files = new Set<string>();
  const parents = new Set<string>();
  let ignored = 0;
  try {
    await streamNulRecords(root, ['ls-files', '-z', '-c', '-o', '--exclude-standard'], (record) => {
      // A nested repository is listed as `name/`.
      const rel = comparablePath(record.endsWith('/') ? record.slice(0, -1) : record);
      files.add(rel);
      for (let slash = rel.lastIndexOf('/'); slash > 0; slash = rel.lastIndexOf('/', slash - 1)) {
        if (parents.has(rel.slice(0, slash))) break;
        parents.add(rel.slice(0, slash));
      }
    });
    await streamNulRecords(root, ['ls-files', '-z', '-o', '-i', '--exclude-standard'], () => {
      ignored += 1;
    });
  } catch {
    return null;
  }
  return {
    file: (rel) => files.has(comparablePath(rel)),
    // A listed folder is a nested repository, taken as it is.
    directory: (rel) => {
      const key = comparablePath(rel);
      if (files.has(key)) return 'whole';
      return parents.has(key) ? 'walk' : 'out';
    },
    ignored,
    countLeftOut: false,
  };
}

/** The exclusion for the canonical folder `root`, by the rules of the
 *  repository it is in (an ignored `root` keeps only its tracked files). Null
 *  takes everything: outside git, a folder that is itself a generated name. */
async function exclusionFor(root: string): Promise<Exclusion | null> {
  const git = await gitExclusion(root);
  if (git) return git;
  return GENERATED_FOLDERS.has(basename(root)) ? null : GENERATED_FOLDER_RULE;
}

/** The folder to zip is not (or no longer) at its canonical path. */
export class FolderMovedError extends Error {
  constructor() {
    super('The folder moved while it was being zipped.');
    this.name = 'FolderMovedError';
  }
}

/** Test seam: runs after a directory entry was seen as a plain directory and
 *  before the walk descends into it. */
export const zipFolderTestHooks: { beforeDescend?: (directory: string) => Promise<void> | void } = {};

/** Whether `path` is itself the canonical path it names: no link anywhere on
 *  it leads elsewhere. */
async function isCanonical(path: string): Promise<boolean> {
  const real = await realpath(path).catch(() => null);
  return real !== null && comparablePath(real) === comparablePath(path);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface Packed {
  name: Buffer;
  crc: number;
  size: number;
  data: Buffer;
  method: 0 | 8;
  offset: number;
}

/** MS-DOS date/time of a fixed instant, so the same folder zips identically. */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

/** Where a folder entry really is: itself, or — for a link — its canonical
 *  target when that lies inside `root`. Null when the entry is left out. */
async function entryLocation(root: string, child: string): Promise<{ at: string; info: BigIntStats } | null> {
  const info = await lstat(child, { bigint: true });
  if (!info.isSymbolicLink()) return { at: child, info };
  const target = await realpath(child).catch(() => null);
  if (target === null || !insideRoot(root, target)) return null;
  const targetInfo = await lstat(target, { bigint: true }).catch(() => null);
  return targetInfo && !targetInfo.isSymbolicLink() ? { at: target, info: targetInfo } : null;
}

export interface FolderScan {
  files: FolderFile[];
  /** Files left out as git-ignored (or generated-folder) content. */
  ignored: number;
}

/** The regular files under `root` (a canonical path) that make up the folder,
 *  as relative `/`-separated paths in a stable order; a linked entry keeps its
 *  own name and is read from its canonical target. Ignored content is left
 *  out (see the header). Every directory walked must
 *  resolve to the very path it was reached by — one swapped for a link is left
 *  out — and a link back to a folder the walk is inside is not followed.
 *  Throws FolderTooLargeError when what is left passes either cap,
 *  FolderMovedError when `root` is not canonical. */
export async function scanFolder(root: string, limits: { maxBytes: number; maxFiles: number }): Promise<FolderScan> {
  if (!(await isCanonical(root))) throw new FolderMovedError();
  const rule = await exclusionFor(root);
  const files: FolderFile[] = [];
  let count = 0;
  let bytes = 0;
  let ignored = rule?.ignored ?? 0;
  const walk = async (
    absolute: string,
    rel: string,
    ancestors: ReadonlySet<string>,
    exclusion: Exclusion | null,
    exclRel: string
  ): Promise<void> => {
    const entries = (await readdir(absolute, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    // Checked after the listing: entries read through a redirected directory
    // are never kept.
    if (!(await isCanonical(absolute))) return;
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childExclRel = exclRel ? `${exclRel}/${entry.name}` : entry.name;
      let inside = exclusion;
      // A nested repository or a linked folder is judged by its own rules.
      let fresh = false;
      if (exclusion) {
        if (entry.isDirectory()) {
          const verdict = exclusion.directory(childExclRel, entry.name);
          if (verdict === 'out') {
            if (exclusion.countLeftOut) ignored += await countFiles(child);
            continue;
          }
          fresh = verdict === 'whole';
        } else {
          if (!exclusion.file(childExclRel)) continue;
          fresh = true;
        }
      }
      const location = await entryLocation(root, child);
      if (!location) continue;
      const { at, info } = location;
      if (info.isDirectory()) {
        if (ancestors.has(comparablePath(at))) continue;
        await zipFolderTestHooks.beforeDescend?.(at);
        let insideRel = childExclRel;
        if (fresh) {
          inside = await exclusionFor(at);
          insideRel = '';
          ignored += inside?.ignored ?? 0;
        }
        await walk(at, childRel, new Set([...ancestors, comparablePath(at)]), inside, insideRel);
      } else if (info.isFile()) {
        const size = Number(info.size);
        count += 1;
        bytes += size;
        // Past a cap the walk only counts, so the refusal can say how far over.
        if (count <= limits.maxFiles && bytes <= limits.maxBytes) {
          files.push({ rel: childRel, absolute: at, size, dev: info.dev, ino: info.ino });
        }
      }
    }
  };
  await walk(root, '', new Set([comparablePath(root)]), rule, '');
  if (count > limits.maxFiles || bytes > limits.maxBytes) throw new FolderTooLargeError(count, bytes);
  return { files, ignored };
}

/** The files of `scanFolder`, without the counts. */
export async function listFolderFiles(
  root: string,
  limits: { maxBytes: number; maxFiles: number }
): Promise<FolderFile[]> {
  return (await scanFolder(root, limits)).files;
}

/** The bytes of a listed file, read through the handle that proves it is still
 *  the regular file the walk saw (null when it was replaced since). Throws
 *  FolderTooLargeError as soon as it holds more than `budget` bytes. */
async function readListedFile(file: FolderFile, budget: number): Promise<Buffer | null> {
  let handle: FileHandle;
  try {
    handle = await open(file.absolute, OPEN_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return null;
    throw error;
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.dev !== file.dev || info.ino !== file.ino) return null;
    // The open file itself must live at the walked path: a directory above it
    // swapped for a link since the walk redirects the open, not the path.
    const at = await openedFilePath(handle, file.absolute, { dev: info.dev, ino: info.ino }).catch(() => null);
    if (at === null || comparablePath(at) !== comparablePath(file.absolute)) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(READ_CHUNK);
      const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > budget) throw new FolderTooLargeError(1, total);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

/** The zip of the folder (see scanFolder), with how many ignored files it
 *  leaves out. */
export async function zipFolder(
  root: string,
  limits: { maxBytes: number; maxFiles: number }
): Promise<{ archive: Buffer; ignored: number }> {
  const { files, ignored } = await scanFolder(root, limits);
  return { archive: await zipListedFiles(files, limits.maxBytes), ignored };
}

/** The zip of files from listFolderFiles. The caps hold for what is actually
 *  read, not only for the sizes the walk saw. */
export async function zipListedFiles(files: FolderFile[], maxBytes: number): Promise<Buffer> {
  const packed: Packed[] = [];
  const parts: Buffer[] = [];
  let offset = 0;
  let bytes = 0;
  for (const file of files) {
    const raw = await readListedFile(file, maxBytes - bytes).catch((error: unknown) => {
      // The file grew past the cap after the walk: counted as read so far.
      throw error instanceof FolderTooLargeError ? new FolderTooLargeError(files.length, bytes + error.bytes) : error;
    });
    if (!raw) continue;
    bytes += raw.length;
    const deflated = deflateRawSync(raw);
    const stored = deflated.length < raw.length;
    const data = stored ? deflated : raw;
    const name = Buffer.from(file.rel, 'utf8');
    const entry: Packed = { name, crc: crc32(raw), size: raw.length, data, method: stored ? 8 : 0, offset };
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(name.length, 26);
    parts.push(header, name, data);
    offset += header.length + name.length + data.length;
    packed.push(entry);
  }
  const directoryStart = offset;
  for (const entry of packed) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.data.length, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt32LE(entry.offset, 42);
    parts.push(header, entry.name);
    offset += header.length + entry.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(packed.length, 8);
  end.writeUInt16LE(packed.length, 10);
  end.writeUInt32LE(offset - directoryStart, 12);
  end.writeUInt32LE(directoryStart, 16);
  parts.push(end);
  return Buffer.concat(parts);
}
