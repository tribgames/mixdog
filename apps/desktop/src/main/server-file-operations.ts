// Daemon-side file lanes for server (ssh) windows. The window's renderer and
// main process run on the user's PC while these run on the server next to its
// files, so bytes cross the existing session connection in bounded base64
// chunks: uploads into a per-session staging folder, ranged reads for previews
// and downloads, and a trash that never reaches outside a registered project.
import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

import {
  SERVER_UPLOAD_CHUNK_BYTES,
  SERVER_UPLOAD_MAX_BYTES,
  SERVER_UPLOAD_RETENTION_MS,
  serverUploadScope,
} from '../shared/server-files';
import { projectEntryPathIn } from './project-files';

export { SERVER_UPLOAD_CHUNK_BYTES, SERVER_UPLOAD_MAX_BYTES };
/** Raw bytes per ranged read. */
export const SERVER_FILE_READ_MAX_BYTES = 4 * 1024 * 1024;
/** An upload nobody feeds for this long is abandoned and its partial file removed. */
export const SERVER_UPLOAD_IDLE_MS = 2 * 60 * 1000;

type ServerFileOperationName =
  | 'serverUploadBegin'
  | 'serverUploadChunk'
  | 'serverUploadCommit'
  | 'serverUploadAbort'
  | 'serverFileReadRange'
  | 'serverTrashInfo'
  | 'serverTrashEntry';

interface Upload {
  id: string;
  dir: string;
  temp: string;
  name: string;
  size: number;
  received: number;
  handle: FileHandle;
  writing: boolean;
  timer: NodeJS.Timeout | null;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

/** The staging folder name for one session (or a draft not yet sent). */
function uploadScope(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(text) || text === '.' || text === '..') {
    throw new TypeError('The upload scope is invalid.');
  }
  return text;
}

/** One path segment that names the uploaded file on a POSIX server. */
export function serverUploadFileName(value: unknown): string {
  const raw = typeof value === 'string' ? value : '';
  const name = basename(raw.replace(/\\/g, '/'))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is replaced.
    .replace(/[\u0000-\u001f\u007f/]/g, '_')
    .trim()
    .slice(0, 200);
  if (!name || name === '.' || name === '..') return 'attachment';
  return name;
}

/** The bytes of one base64 upload chunk, which must round-trip exactly. */
function decodeUploadChunk(rawData: unknown): Buffer {
  if (typeof rawData !== 'string' || !rawData) throw new TypeError('chunk data is invalid.');
  const bytes = Buffer.from(rawData, 'base64');
  if (!bytes.length || bytes.length > SERVER_UPLOAD_CHUNK_BYTES || bytes.toString('base64') !== rawData) {
    throw new TypeError('chunk data is invalid.');
  }
  return bytes;
}

function uploadGone(): Error {
  return new Error('The upload is gone: it was cancelled or sat idle too long.');
}

/** `name`, then `name (2).ext`, `name (3).ext`... reserved with a hard link so
 *  two uploads of the same name never overwrite each other. */
async function publishUnique(temp: string, dir: string, name: string): Promise<string> {
  const extension = extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidate = join(dir, attempt === 1 ? name : `${stem} (${attempt})${extension}`);
    try {
      await link(temp, candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Too many files with this name in the upload folder.');
}

/** The freedesktop.org trash of the server user. */
function trashHome(): string {
  const dataHome = process.env.XDG_DATA_HOME;
  return dataHome && isAbsolute(dataHome) ? join(dataHome, 'Trash') : join(homedir(), '.local', 'share', 'Trash');
}

function trashTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}:${pad(date.getSeconds())}`;
}

/** The subset of `folders` that a stored session record under `sessionsDir`
 *  mentions (as written into a transcript: JSON-escaped). One pass over the
 *  records, read one at a time; run only for folders already past retention. */
export async function sessionRecordsReferencing(sessionsDir: string, folders: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const needles = folders.map((folder) => ({ folder, text: `${JSON.stringify(folder).slice(1, -1)}/` }));
  let files: string[];
  try {
    files = (await readdir(sessionsDir)).filter((file) => file.endsWith('.json'));
  } catch (error) {
    // No session store yet: nothing can reference a folder. Any other failure
    // keeps every folder, since a removal could break a live transcript.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found;
    return new Set(folders);
  }
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(join(sessionsDir, file), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return new Set(folders);
    }
    for (const needle of needles) {
      if (!found.has(needle.folder) && text.includes(needle.text)) found.add(needle.folder);
    }
    if (found.size === needles.length) break;
  }
  return found;
}

/** Uploads in flight: each owns a temp file in its staging folder until it is
 *  committed, aborted, or sits idle past `idleMs`. */
function createUploadSessions({ userDataPath, idleMs }: { userDataPath: string; idleMs: number }) {
  const uploads = new Map<string, Upload>();

  const discard = async (upload: Upload): Promise<void> => {
    uploads.delete(upload.id);
    if (upload.timer) clearTimeout(upload.timer);
    await upload.handle.close().catch(() => {});
    await rm(upload.temp, { force: true });
  };

  const arm = (upload: Upload): void => {
    if (upload.timer) clearTimeout(upload.timer);
    upload.timer = setTimeout(() => void discard(upload).catch(() => {}), idleMs);
    upload.timer.unref?.();
  };

  const requiredUpload = (id: unknown): Upload => {
    const upload = uploads.get(typeof id === 'string' ? id : '');
    if (!upload) throw uploadGone();
    return upload;
  };

  async function begin(rawName: unknown, rawSize: unknown, rawScope: unknown) {
    const size = integer(rawSize, 'size', 1, SERVER_UPLOAD_MAX_BYTES);
    const dir = join(userDataPath, 'attachments', uploadScope(rawScope));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const temp = join(dir, `.${id}.part`);
    const handle = await open(temp, 'wx', 0o600);
    const upload: Upload = {
      id,
      dir,
      temp,
      name: serverUploadFileName(rawName),
      size,
      received: 0,
      handle,
      writing: false,
      timer: null,
    };
    uploads.set(id, upload);
    arm(upload);
    return { uploadId: id, chunkBytes: SERVER_UPLOAD_CHUNK_BYTES, maxBytes: SERVER_UPLOAD_MAX_BYTES };
  }

  async function chunk(rawId: unknown, rawOffset: unknown, rawData: unknown) {
    const upload = requiredUpload(rawId);
    const offset = integer(rawOffset, 'offset', 0, upload.size);
    const bytes = decodeUploadChunk(rawData);
    // A retried chunk the server already wrote is acknowledged, not rewritten.
    if (offset < upload.received && offset + bytes.length === upload.received) return { received: upload.received };
    if (offset !== upload.received) throw new Error('The upload chunk is out of order.');
    if (upload.writing) throw new Error('The upload is already writing a chunk.');
    if (upload.received + bytes.length > upload.size) {
      await discard(upload);
      throw new Error('The upload is larger than it declared.');
    }
    upload.writing = true;
    try {
      await upload.handle.write(bytes, 0, bytes.length, offset);
    } catch (error) {
      await discard(upload);
      throw error;
    } finally {
      upload.writing = false;
    }
    upload.received += bytes.length;
    arm(upload);
    return { received: upload.received };
  }

  async function commit(rawId: unknown) {
    const upload = requiredUpload(rawId);
    if (upload.writing) throw new Error('The upload is still writing a chunk.');
    if (upload.received !== upload.size) throw new Error('The upload is incomplete.');
    uploads.delete(upload.id);
    if (upload.timer) clearTimeout(upload.timer);
    try {
      await upload.handle.close();
      const absolutePath = await publishUnique(upload.temp, upload.dir, upload.name);
      return { absolutePath, name: basename(absolutePath), dir: false, size: upload.size };
    } finally {
      await rm(upload.temp, { force: true });
    }
  }

  async function abort(rawId: unknown): Promise<boolean> {
    const upload = uploads.get(typeof rawId === 'string' ? rawId : '');
    if (!upload) return false;
    await discard(upload);
    return true;
  }

  return {
    begin,
    chunk,
    commit,
    abort,
    /** Staging folders (by scope name) an upload is writing into. */
    busyScopes: (): Set<string> => new Set([...uploads.values()].map((upload) => basename(upload.dir))),
    ownedTemps: (): Set<string> => new Set([...uploads.values()].map((upload) => upload.temp)),
    async dispose(): Promise<void> {
      await Promise.all([...uploads.values()].map((upload) => discard(upload).catch(() => {})));
    },
  };
}

async function readRange(rawRoot: unknown, rawRel: unknown, rawOffset: unknown, rawLength: unknown) {
  const offset = integer(rawOffset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const length = integer(rawLength, 'length', 1, SERVER_FILE_READ_MAX_BYTES);
  const file = projectEntryPathIn(String(rawRoot || ''), String(rawRel || ''));
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Not a file.');
    const buffer = Buffer.alloc(Math.max(0, Math.min(length, info.size - offset)));
    const { bytesRead } = buffer.length ? await handle.read(buffer, 0, buffer.length, offset) : { bytesRead: 0 };
    return {
      data: buffer.subarray(0, bytesRead).toString('base64'),
      offset,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

/** Whether an entry of `root` can move to the user's trash: the trash
 *  folder exists (or can be made) on the same filesystem. */
async function trashInfo(rawRoot: unknown): Promise<{ available: boolean; path: string }> {
  const home = trashHome();
  try {
    await mkdir(join(home, 'files'), { recursive: true, mode: 0o700 });
    await mkdir(join(home, 'info'), { recursive: true, mode: 0o700 });
    const [rootInfo, trashInfoStat] = await Promise.all([stat(resolve(String(rawRoot || ''))), stat(home)]);
    return { available: rootInfo.dev === trashInfoStat.dev, path: home };
  } catch {
    return { available: false, path: home };
  }
}

async function trashEntry(now: () => Date, rawRoot: unknown, rawRel: unknown, rawPermanent: unknown) {
  const root = resolve(String(rawRoot || ''));
  const target = projectEntryPathIn(root, String(rawRel || ''));
  if (target === root) throw new Error('The project folder itself cannot be deleted here.');
  await stat(target);
  if (rawPermanent === true) {
    await rm(target, { recursive: true });
    return { mode: 'deleted' as const };
  }
  const home = trashHome();
  const { available } = await trashInfo(root);
  if (!available) {
    throw Object.assign(new Error('The server has no trash on this disk; delete permanently instead.'), {
      code: 'TRASH_UNAVAILABLE',
    });
  }
  const name = basename(target);
  // The .trashinfo file is the reservation (freedesktop.org trash spec).
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const trashedName = attempt === 1 ? name : `${name}.${attempt}`;
    const info = join(home, 'info', `${trashedName}.trashinfo`);
    try {
      await writeFile(info, `[Trash Info]\nPath=${encodeURI(target)}\nDeletionDate=${trashTimestamp(now())}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    const trashed = join(home, 'files', trashedName);
    try {
      await rename(target, trashed);
    } catch (error) {
      await unlink(info).catch(() => {});
      throw error;
    }
    return { mode: 'trash' as const, trashPath: trashed };
  }
  throw new Error('The trash has too many entries with this name.');
}

/** Newest modification time anywhere in a staging folder (one level: uploads are flat). */
async function newestChange(dir: string): Promise<number> {
  let newest = (await lstat(dir)).mtimeMs;
  for (const entry of await readdir(dir)) {
    const info = await lstat(join(dir, entry)).catch(() => null);
    if (info && info.mtimeMs > newest) newest = info.mtimeMs;
  }
  return newest;
}

/** Staging-folder cleanup: a deleted session's folder, and the age sweep. */
function createStagingCleanup({
  stagingRoot,
  idleMs,
  now,
  sessions: { busyScopes, ownedTemps },
}: {
  stagingRoot: string;
  idleMs: number;
  now: () => Date;
  sessions: Pick<ReturnType<typeof createUploadSessions>, 'busyScopes' | 'ownedTemps'>;
}) {
  /** Removes a deleted session's staging folder. A folder still receiving an
   *  upload is left for that upload (and the sweep) to finish. */
  async function removeSessionUploads(sessionId: string): Promise<boolean> {
    const scope = serverUploadScope(sessionId);
    if (scope === 'draft' || busyScopes().has(scope)) return false;
    const dir = join(stagingRoot, scope);
    if (!(await lstat(dir).catch(() => null))?.isDirectory()) return false;
    await rm(dir, { recursive: true, force: true });
    return true;
  }

  /** Partial files in a staging folder that no upload in this process owns and
   *  that nothing has fed for `idleMs`. */
  async function removeStalePartials(dir: string, owned: ReadonlySet<string>): Promise<void> {
    for (const entry of await readdir(dir)) {
      const file = join(dir, entry);
      if (!/^\..+\.part$/.test(entry) || owned.has(file)) continue;
      const info = await lstat(file).catch(() => null);
      if (info && info.mtimeMs < now().getTime() - idleMs) await rm(file, { force: true });
    }
  }

  /** Age sweep: removes every staging folder whose contents have not changed
   *  for `retentionMs` and that no live session owns (by name) or references
   *  (a draft's uploads live on in the session the draft became), plus
   *  partial files no upload in this process owns (a crashed daemon's
   *  leftovers). */
  async function sweepUploads({
    liveSessionIds,
    referencedFolders,
    retentionMs = SERVER_UPLOAD_RETENTION_MS,
  }: {
    liveSessionIds: Iterable<string>;
    /** The subset of `folders` a stored session still mentions. */
    referencedFolders(folders: string[]): Promise<Set<string>>;
    retentionMs?: number;
  }): Promise<{ removed: string[] }> {
    const live = new Set([...liveSessionIds].map((id) => serverUploadScope(id)));
    const busy = busyScopes();
    const owned = ownedTemps();
    const cutoff = now().getTime() - retentionMs;
    const removed: string[] = [];
    let entries: string[];
    try {
      entries = await readdir(stagingRoot);
    } catch {
      return { removed };
    }
    const candidates: string[] = [];
    for (const scope of entries) {
      const dir = join(stagingRoot, scope);
      try {
        if (!(await lstat(dir)).isDirectory() || busy.has(scope)) continue;
        // Measured before the partial-file cleanup below touches the folder.
        const expired = !live.has(scope) && (await newestChange(dir)) < cutoff;
        await removeStalePartials(dir, owned);
        if (expired) candidates.push(dir);
      } catch {
        /* a folder that vanished or cannot be read is left for the next sweep */
      }
    }
    if (!candidates.length) return { removed };
    const referenced = await referencedFolders(candidates);
    const stillBusy = busyScopes();
    for (const dir of candidates) {
      const scope = basename(dir);
      if (referenced.has(dir) || stillBusy.has(scope)) continue;
      try {
        await rm(dir, { recursive: true, force: true });
        removed.push(scope);
      } catch {
        /* retried by the next sweep */
      }
    }
    return { removed };
  }

  return { removeSessionUploads, sweepUploads };
}

export function createServerFileOperations({
  userDataPath,
  idleMs = SERVER_UPLOAD_IDLE_MS,
  now = () => new Date(),
}: {
  userDataPath: string;
  idleMs?: number;
  now?: () => Date;
}) {
  const sessions = createUploadSessions({ userDataPath, idleMs });
  const { removeSessionUploads, sweepUploads } = createStagingCleanup({
    stagingRoot: join(userDataPath, 'attachments'),
    idleMs,
    now,
    sessions,
  });

  const table: Record<ServerFileOperationName, (...args: unknown[]) => Promise<unknown>> = {
    serverUploadBegin: sessions.begin,
    serverUploadChunk: sessions.chunk,
    serverUploadCommit: sessions.commit,
    serverUploadAbort: sessions.abort,
    serverFileReadRange: readRange,
    serverTrashInfo: trashInfo,
    serverTrashEntry: (root, rel, permanent) => trashEntry(now, root, rel, permanent),
  };

  return {
    handles(name: string): name is ServerFileOperationName {
      return Object.hasOwn(table, name);
    },
    invoke(name: ServerFileOperationName, args: unknown[]): Promise<unknown> {
      return table[name](...args);
    },
    removeSessionUploads,
    sweepUploads,
    dispose: sessions.dispose,
  };
}
