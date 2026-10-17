// A server (ssh) window's file access, on THIS PC's side of the connection.
// Its paths are POSIX paths on the server: nothing here touches this PC's
// filesystem except a download the user explicitly asked for. Bytes cross the
// window's own session connection through the daemon's server-file operations
// (server-file-operations.ts), never through a second ssh/scp channel.
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, rm, type FileHandle } from 'node:fs/promises';
import { dirname, extname, join, posix, resolve } from 'node:path';

import { mediaResponsePlan } from '../../../relay/lib/media-http.mjs';
import type { DesktopLocalPathEntry } from '../shared/contract';
import { SERVER_DOWNLOAD_MAX_BYTES, SERVER_UPLOAD_CHUNK_BYTES, SERVER_UPLOAD_MAX_BYTES } from '../shared/server-files';
import { filePreviewTypeForPath, type DesktopFilePreviewKind } from '../shared/file-preview';
import { FILE_PREVIEW_SCHEME } from './file-preview';
import { requiredString } from './ipc-validation';
import { SELECTED_FILE_GRANT_UNAVAILABLE } from '../shared/file-error-codes';
import { LocalAccessDeniedError } from './local-access-denied';

export type ServerInvoke = <T>(method: string, args: unknown[]) => Promise<T>;

/** Raw bytes per ranged read (the daemon's own ceiling). */
export const SERVER_READ_CHUNK_BYTES = 4 * 1024 * 1024;
export { SERVER_DOWNLOAD_MAX_BYTES, SERVER_UPLOAD_CHUNK_BYTES };
const DOWNLOAD_IDLE_MS = 2 * 60 * 1000;
const MAX_GRANTS = 1_000;
const MAX_PREVIEWS = 256;

// ── Server answers ──────────────────────────────────────────────────────────
// The server is untrusted: every size, offset, id and byte count it returns is
// checked before this PC decodes, allocates or writes anything because of it.

/** A server answer that breaks the file-transfer protocol. */
export class ServerResponseError extends Error {
  constructor(what: string) {
    super(`The server sent an invalid response: ${what}.`);
    this.name = 'ServerResponseError';
  }
}

function serverRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServerResponseError(`no ${what}`);
  return value as Record<string, unknown>;
}

/** A server-supplied integer within [min, max]. */
function serverInteger(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ServerResponseError(`${what} ${String(value).slice(0, 32)} is not an integer from ${min} to ${max}`);
  }
  return value;
}

function serverTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ServerResponseError('the file time is not a valid timestamp');
  }
  return value;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** A read's base64 bytes, decoded only after their length proves they hold
 *  at most the `requested` bytes; at least one byte, so every read advances. */
function serverChunkBytes(value: unknown, requested: number): Buffer {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64.test(value)) {
    throw new ServerResponseError('the chunk data is not base64');
  }
  if (value.length > Math.ceil(requested / 3) * 4) {
    throw new ServerResponseError(`a chunk longer than the ${requested} bytes requested`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > requested) throw new ServerResponseError(`a chunk longer than the ${requested} bytes requested`);
  return bytes;
}

/** The stat a preview or download is sized by. */
function serverFileStat(value: unknown): { size: number; mtimeMs: number } {
  const info = serverRecord(value, 'file information');
  return {
    size: serverInteger(info.size, 'the file size', 0, Number.MAX_SAFE_INTEGER),
    mtimeMs: serverTimestamp(info.mtimeMs),
  };
}

/** One ranged read of `requested` bytes at `offset`. */
function serverReadRange(
  value: unknown,
  offset: number,
  requested: number
): { bytes: Buffer; size: number; mtimeMs: number } {
  const chunk = serverRecord(value, 'file chunk');
  if (chunk.offset !== offset)
    throw new ServerResponseError(`a chunk for offset ${String(chunk.offset).slice(0, 32)}, not ${offset}`);
  const { size, mtimeMs } = serverFileStat(chunk);
  return { bytes: serverChunkBytes(chunk.data, requested), size, mtimeMs };
}

const UPLOAD_ID = /^[A-Za-z0-9-]{1,64}$/;

/** The upload id in the server's answer to `serverUploadBegin`; checked
 *  first, since without a well-formed id there is nothing to abort. */
export function serverUploadId(value: unknown): string {
  const { uploadId } = serverRecord(value, 'upload id');
  if (typeof uploadId !== 'string' || !UPLOAD_ID.test(uploadId)) {
    throw new ServerResponseError('the upload id is malformed');
  }
  return uploadId;
}

/** The server's answer to `serverUploadBegin`. */
export function serverUploadBegun(value: unknown): { uploadId: string; chunkBytes: number; maxBytes: number } {
  const begun = serverRecord(value, 'upload id');
  return {
    uploadId: serverUploadId(begun),
    chunkBytes: serverInteger(begun.chunkBytes, 'the upload chunk size', 1, SERVER_UPLOAD_CHUNK_BYTES),
    maxBytes: serverInteger(begun.maxBytes, 'the upload size limit', 1, SERVER_UPLOAD_MAX_BYTES),
  };
}

/** The server's acknowledgement of a chunk: exactly the bytes sent, so an
 *  upload always advances or fails. */
export function serverUploadAck(value: unknown, offset: number, length: number): { received: number } {
  const expected = offset + length;
  const received = serverInteger(
    serverRecord(value, 'chunk acknowledgement').received,
    'the received byte count',
    0,
    Number.MAX_SAFE_INTEGER
  );
  if (received !== expected)
    throw new ServerResponseError(`${received} bytes acknowledged after sending through byte ${expected}`);
  return { received };
}

/** The server's answer to `serverUploadCommit`: the one file of `size` bytes. */
export function serverUploadedEntry(
  value: unknown,
  size: number
): { absolutePath: string; name: string; dir: boolean; size: number } {
  const entry = serverRecord(value, 'uploaded file');
  let absolutePath: string;
  try {
    absolutePath = absoluteServerPath(entry.absolutePath);
  } catch {
    throw new ServerResponseError('the uploaded file path is not an absolute server path');
  }
  if (absolutePath === '/' || entry.dir !== false) throw new ServerResponseError('the upload is not a file');
  serverInteger(entry.size, 'the uploaded size', size, size);
  return { absolutePath, name: posix.basename(absolutePath), dir: false, size };
}

/** An absolute POSIX path on an ssh server (servers run POSIX shells). */
export function absoluteServerPath(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('path must be a string.');
  const text = value.trim();
  if (!text || text.length > 16_384 || text.includes('\0')) throw new TypeError('path is invalid.');
  if (!posix.isAbsolute(text)) throw new TypeError('path must be absolute.');
  return posix.normalize(text).replace(/(.)\/+$/, '$1');
}

/** The deepest registered project that contains `path`, if any. */
function owningServerProject(projects: Array<{ path: string }>, path: string): string | null {
  let owner: string | null = null;
  for (const project of projects) {
    let root: string;
    try {
      root = absoluteServerPath(project.path);
    } catch {
      continue;
    }
    const inside = root === '/' ? path !== '/' : path.startsWith(`${root}/`);
    if (inside && (!owner || root.length > owner.length)) owner = root;
  }
  return owner;
}

/** One-file grants for server paths outside every registered project (agent
 *  output links, uploaded attachments) — the server counterpart of
 *  SelectedFileAccess, held in memory for this window's life. */
export class ServerFileGrants {
  readonly #invoke: ServerInvoke;
  readonly #listProjects: () => Promise<Array<{ path: string }>>;
  readonly #grants = new Map<string, string>();

  constructor(invoke: ServerInvoke, listProjects: () => Promise<Array<{ path: string }>>) {
    this.#invoke = invoke;
    this.#listProjects = listProjects;
  }

  grant(absolutePath: string): string {
    // Describing a granted file again keeps its token (most recently used):
    // a fresh token per link verification evicted open files' grants.
    for (const [token, granted] of this.#grants) {
      if (granted !== absolutePath) continue;
      this.#grants.delete(token);
      this.#grants.set(token, absolutePath);
      return token;
    }
    const token = randomUUID();
    this.#grants.set(token, absolutePath);
    while (this.#grants.size > MAX_GRANTS) {
      const oldest = this.#grants.keys().next().value;
      if (oldest === undefined) break;
      this.#grants.delete(oldest);
    }
    return token;
  }

  /** Server paths described the way `resolveLocalPaths` describes this PC's. */
  async describe(paths: unknown): Promise<DesktopLocalPathEntry[]> {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 100) {
      throw new TypeError('paths are invalid.');
    }
    const absolutes = paths.map(absoluteServerPath);
    const projects = await this.#listProjects().catch(() => []);
    const rows: DesktopLocalPathEntry[] = [];
    for (const absolute of absolutes) {
      const info = serverRecord(await this.#invoke<unknown>('statLocalEntryAbs', [absolute]), 'file information');
      if (typeof info.dir !== 'boolean') throw new ServerResponseError('the entry kind is not a boolean');
      rows.push(
        this.entry(
          absolute,
          { dir: info.dir, size: serverInteger(info.size, 'the file size', 0, Number.MAX_SAFE_INTEGER) },
          projects
        )
      );
    }
    return rows;
  }

  /** The entry's name always derives from its path here, never from the server. */
  entry(
    absolutePath: string,
    info: { dir: boolean; size: number },
    projects: Array<{ path: string }> = []
  ): DesktopLocalPathEntry {
    const name = posix.basename(absolutePath) || absolutePath;
    const row: DesktopLocalPathEntry = { absolutePath, name, dir: info.dir, size: info.size };
    if (info.dir) return row;
    const owner = owningServerProject(projects, absolutePath);
    if (owner) return { ...row, projectPath: owner, relPath: absolutePath.slice(owner.length + 1) };
    return {
      ...row,
      projectPath: posix.dirname(absolutePath),
      relPath: posix.basename(absolutePath),
      accessToken: this.grant(absolutePath),
    };
  }

  requireGrant(accessToken: unknown, projectPath: unknown, relPath: unknown) {
    const token = requiredString(accessToken, 'file access token', 128);
    const granted = this.#grants.get(token);
    if (!granted)
      throw new LocalAccessDeniedError('The selected-file permission is unavailable.', SELECTED_FILE_GRANT_UNAVAILABLE);
    const requested = posix.resolve(
      absoluteServerPath(requiredString(projectPath, 'projectPath')),
      requiredString(relPath, 'relPath', 4_096)
    );
    if (requested !== granted)
      throw new LocalAccessDeniedError('The selected-file permission does not match this path.');
    return { root: posix.dirname(granted), rel: posix.basename(granted), absolute: granted };
  }
}

/** Server bytes [start, end] as a stream of daemon reads. */
export function serverByteStream(
  invoke: ServerInvoke,
  root: string,
  rel: string,
  start: number,
  end: number
): ReadableStream<Uint8Array> {
  let position = start;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (position > end) {
        controller.close();
        return;
      }
      const length = Math.min(SERVER_READ_CHUNK_BYTES, end - position + 1);
      const { bytes } = serverReadRange(
        await invoke<unknown>('serverFileReadRange', [root, rel, position, length]),
        position,
        length
      );
      if (!bytes.length) {
        controller.error(new Error('The server file changed while it was read.'));
        return;
      }
      position += bytes.length;
      controller.enqueue(new Uint8Array(bytes));
    },
  });
}

interface ServerPreview {
  root: string;
  rel: string;
  mime: string;
  kind: DesktopFilePreviewKind;
  key: string;
}

interface ProtocolSession {
  protocol: {
    handle(scheme: string, handler: (request: Request) => Promise<Response>): void;
    unhandle(scheme: string): void;
    isProtocolHandled(scheme: string): boolean;
  };
}

// The window that currently answers a partition's preview scheme: a closing
// window must not unregister the handler its successor installed.
const protocolOwners = new WeakMap<object, object>();

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** Tokenized `mixdog-media://preview/<token>/<name>` URLs for server files,
 *  answered on the window's own partition by ranged daemon reads. */
export function createServerFilePreviews({ session, invoke }: { session: ProtocolSession; invoke: ServerInvoke }) {
  const previews = new Map<string, ServerPreview>();
  const tokensByKey = new Map<string, string>();
  const owner = {};
  let installed = false;

  const handler = async (request: Request): Promise<Response> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return textResponse(400, 'Bad request.');
    }
    const token = url.hostname === 'preview' ? url.pathname.replace(/^\/+/, '').split('/', 1)[0] || '' : '';
    const preview = previews.get(token);
    if (!preview) return textResponse(404, 'Not found.');
    let stat: unknown;
    try {
      stat = await invoke<unknown>('statProjectFileIn', [preview.root, preview.rel]);
    } catch {
      return textResponse(404, 'Not found.');
    }
    let size: number;
    try {
      ({ size } = serverFileStat(stat));
    } catch (error) {
      return textResponse(502, (error as Error).message);
    }
    const plan = mediaResponsePlan({
      size,
      mime: preview.mime,
      assetId: token,
      variant: 'server',
      rangeHeader: request.headers.get('range'),
      ifNoneMatch: request.headers.get('if-none-match'),
    });
    const headers = {
      ...Object.fromEntries(Object.entries(plan.headers).map(([key, value]) => [key, String(value)])),
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    };
    if (plan.status >= 300 || request.method === 'HEAD' || size === 0) {
      return new Response(null, { status: plan.status, headers });
    }
    return new Response(serverByteStream(invoke, preview.root, preview.rel, plan.start, plan.end), {
      status: plan.status,
      headers,
    });
  };

  const ensureInstalled = (): void => {
    if (installed) return;
    if (session.protocol.isProtocolHandled(FILE_PREVIEW_SCHEME)) session.protocol.unhandle(FILE_PREVIEW_SCHEME);
    session.protocol.handle(FILE_PREVIEW_SCHEME, handler);
    protocolOwners.set(session, owner);
    installed = true;
  };

  return {
    /** A preview URL for a server file, or null when the type has no in-app preview. */
    register(
      root: string,
      rel: string,
      version: string
    ): { url: string; kind: DesktopFilePreviewKind; mime: string } | null {
      const type = filePreviewTypeForPath(rel);
      if (!type) return null;
      const key = `${root}\0${rel}\0${version}`;
      let token = tokensByKey.get(key);
      if (!token || !previews.has(token)) {
        token = randomUUID();
        previews.set(token, { root, rel, key, ...type });
        tokensByKey.set(key, token);
        while (previews.size > MAX_PREVIEWS) {
          const oldest = previews.keys().next().value;
          if (oldest === undefined) break;
          const dropped = previews.get(oldest);
          previews.delete(oldest);
          if (dropped && tokensByKey.get(dropped.key) === oldest) tokensByKey.delete(dropped.key);
        }
      }
      ensureInstalled();
      return {
        url: `${FILE_PREVIEW_SCHEME}://preview/${token}/${encodeURIComponent(posix.basename(rel))}`,
        kind: type.kind,
        mime: type.mime,
      };
    },
    handle: handler,
    dispose(): void {
      if (!installed) return;
      installed = false;
      if (protocolOwners.get(session) !== owner) return;
      protocolOwners.delete(session);
      session.protocol.unhandle(FILE_PREVIEW_SCHEME);
    },
  };
}

/** In-memory bytes into the server's upload staging folder, chunk by chunk. */
export async function uploadServerBytes(
  invoke: ServerInvoke,
  bytes: Uint8Array,
  name: string,
  scope: string
): Promise<{ absolutePath: string; name: string; dir: boolean; size: number }> {
  const begun = await invoke<unknown>('serverUploadBegin', [name, bytes.length, scope]);
  // Any violation after a well-formed id aborts the upload on the server.
  const uploadId = serverUploadId(begun);
  try {
    const { chunkBytes } = serverUploadBegun(begun);
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      const chunk = Buffer.from(bytes.buffer, bytes.byteOffset + offset, Math.min(chunkBytes, bytes.length - offset));
      serverUploadAck(
        await invoke('serverUploadChunk', [uploadId, offset, chunk.toString('base64')]),
        offset,
        chunk.length
      );
    }
    return serverUploadedEntry(await invoke('serverUploadCommit', [uploadId]), bytes.length);
  } catch (error) {
    await invoke('serverUploadAbort', [uploadId]).catch(() => {});
    throw error;
  }
}

interface Download {
  id: string;
  root: string;
  rel: string;
  name: string;
  size: number;
  mtimeMs: number;
  received: number;
  dir: string;
  temp: string;
  handle: FileHandle;
  busy: boolean;
  timer: NodeJS.Timeout | null;
}

/** A plain file name this PC's filesystem accepts: no separators, no
 *  traversal, no Windows device names. */
export function localDownloadName(name: string): string {
  const clean = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is stripped.
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/[\s.]+$/g, '')
    .replace(/^\.+/, '')
    .slice(0, 200)
    .replace(/[\s.]+$/g, '');
  if (!clean) return 'download';
  return /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(clean) ? `_${clean}` : clean;
}

/** `name` inside `dir`, refusing anything that would land elsewhere. */
function downloadTarget(dir: string, name: string): string {
  const target = resolve(dir, name);
  if (dirname(target) !== resolve(dir)) throw new Error('The download name leaves the download folder.');
  return target;
}

/** "Download to this PC": a stepwise, cancellable copy of one server file into
 *  this PC's download folder. Each step moves one ranged read, so the renderer
 *  owns progress and cancel. Only files fetched here may then be opened. */
export function createServerDownloads({
  invoke,
  downloadsDir,
  maxBytes = SERVER_DOWNLOAD_MAX_BYTES,
  idleMs = DOWNLOAD_IDLE_MS,
}: {
  invoke: ServerInvoke;
  downloadsDir: () => string;
  maxBytes?: number;
  idleMs?: number;
}) {
  const downloads = new Map<string, Download>();
  const finished = new Set<string>();

  const discard = async (download: Download): Promise<void> => {
    downloads.delete(download.id);
    if (download.timer) clearTimeout(download.timer);
    await download.handle.close().catch(() => {});
    await rm(download.temp, { force: true });
  };
  const arm = (download: Download): void => {
    if (download.timer) clearTimeout(download.timer);
    download.timer = setTimeout(() => void discard(download).catch(() => {}), idleMs);
    download.timer.unref?.();
  };
  const required = (id: unknown): Download => {
    const download = downloads.get(typeof id === 'string' ? id : '');
    if (!download) throw new Error('The download is gone: it was cancelled or sat idle too long.');
    return download;
  };

  return {
    async begin(root: string, rel: string) {
      const info = serverFileStat(await invoke<unknown>('statProjectFileIn', [root, rel]));
      if (info.size > maxBytes) {
        throw new Error(`The file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB download limit.`);
      }
      const dir = downloadsDir();
      if (!dir) throw new Error('This PC has no download folder.');
      await mkdir(dir, { recursive: true });
      const id = randomUUID();
      const temp = join(dir, `.mixdog-${id}.part`);
      const handle = await open(temp, 'wx');
      const download: Download = {
        id,
        root,
        rel,
        name: localDownloadName(posix.basename(rel)),
        size: info.size,
        mtimeMs: info.mtimeMs,
        received: 0,
        dir,
        temp,
        handle,
        busy: false,
        timer: null,
      };
      downloads.set(id, download);
      arm(download);
      return { downloadId: id, name: download.name, size: download.size };
    },
    async step(id: unknown) {
      const download = required(id);
      if (download.busy) throw new Error('The download is already reading.');
      if (download.received >= download.size) return { received: download.received, size: download.size, done: true };
      download.busy = true;
      try {
        const requested = Math.min(SERVER_READ_CHUNK_BYTES, download.size - download.received);
        const chunk = serverReadRange(
          await invoke<unknown>('serverFileReadRange', [download.root, download.rel, download.received, requested]),
          download.received,
          requested
        );
        const { bytes } = chunk;
        if (chunk.size !== download.size || chunk.mtimeMs !== download.mtimeMs || !bytes.length) {
          throw new Error('The server file changed while it was downloading.');
        }
        await download.handle.write(bytes, 0, bytes.length, download.received);
        download.received += bytes.length;
      } catch (error) {
        await discard(download);
        throw error;
      } finally {
        download.busy = false;
      }
      arm(download);
      return { received: download.received, size: download.size, done: download.received >= download.size };
    },
    async finish(id: unknown): Promise<{ path: string }> {
      const download = required(id);
      if (download.busy || download.received !== download.size) throw new Error('The download is incomplete.');
      downloads.delete(download.id);
      if (download.timer) clearTimeout(download.timer);
      try {
        await download.handle.close();
        const extension = extname(download.name);
        const stem = extension ? download.name.slice(0, -extension.length) : download.name;
        for (let attempt = 1; attempt < 1000; attempt += 1) {
          const candidate = downloadTarget(
            download.dir,
            attempt === 1 ? download.name : `${stem} (${attempt})${extension}`
          );
          try {
            await link(download.temp, candidate);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw error;
          }
          finished.add(candidate);
          return { path: candidate };
        }
        throw new Error('Too many downloads with this name.');
      } finally {
        await rm(download.temp, { force: true });
      }
    },
    async abort(id: unknown): Promise<boolean> {
      const download = downloads.get(typeof id === 'string' ? id : '');
      if (!download) return false;
      await discard(download);
      return true;
    },
    /** Only a file this window downloaded may be handed to the OS. */
    requireDownloaded(path: unknown): string {
      const file = typeof path === 'string' ? path : '';
      if (!finished.has(file))
        throw new LocalAccessDeniedError('Only a file downloaded from the server can be opened.');
      return file;
    },
    async dispose(): Promise<void> {
      await Promise.all([...downloads.values()].map((download) => discard(download).catch(() => {})));
    },
  };
}

/** Everything a server window's file handlers share. */
export interface ServerFiles {
  grants: ServerFileGrants;
  previews: ReturnType<typeof createServerFilePreviews>;
  downloads: ReturnType<typeof createServerDownloads>;
}

export function createServerFiles({
  invoke,
  listProjects,
  session,
  downloadsDir,
}: {
  invoke: ServerInvoke;
  listProjects: () => Promise<Array<{ path: string }>>;
  /** Read only when the first preview registers (the window's partition). */
  session: () => ProtocolSession;
  downloadsDir: () => string;
}): ServerFiles & { dispose(): Promise<void> } {
  let previews: ReturnType<typeof createServerFilePreviews> | null = null;
  const lazyPreviews: ReturnType<typeof createServerFilePreviews> = {
    register: (...args) => {
      previews ??= createServerFilePreviews({ session: session(), invoke });
      return previews.register(...args);
    },
    handle: (request) => (previews ? previews.handle(request) : Promise.resolve(textResponse(404, 'Not found.'))),
    dispose: () => previews?.dispose(),
  };
  const downloads = createServerDownloads({ invoke, downloadsDir });
  return {
    grants: new ServerFileGrants(invoke, listProjects),
    previews: lazyPreviews,
    downloads,
    async dispose() {
      lazyPreviews.dispose();
      await downloads.dispose();
    },
  };
}
