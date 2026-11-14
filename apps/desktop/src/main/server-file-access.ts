// A server (ssh) window's file access, on THIS PC's side of the connection.
// Its paths are POSIX paths on the server: nothing here touches this PC's
// filesystem. Upload and preview bytes cross the window's own session
// connection through the daemon's server-file operations, never through a
// second ssh/scp channel; a download the user asked for is this PC's core's
// (`transfer/serverDownload/*`) and lands in the download folder.
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';

import { mediaResponsePlan } from '../../../relay/lib/media-http.mjs';
import type { DesktopLocalPathEntry } from '../shared/contract';
import { SERVER_UPLOAD_CHUNK_BYTES, SERVER_UPLOAD_MAX_BYTES } from '../shared/server-files';
import { filePreviewTypeForPath, type DesktopFilePreviewKind } from '../shared/file-preview';
import { FILE_PREVIEW_SCHEME } from './file-preview';
import { requiredString } from './ipc-validation';
import { SELECTED_FILE_GRANT_UNAVAILABLE } from '../shared/file-error-codes';
import { LocalAccessDeniedError } from './local-access-denied';
import { coreErrorForWindow } from '../shared/core-lanes/core-error';
import { routeDesktopOperation } from '../shared/core-lanes/desktop-operation-route';

export type ServerInvoke = <T>(method: string, args: unknown[]) => Promise<T>;

/** A desktop operation of this PC's core (the downloads' `serverDownload*`), over the connection to it. */
export function serverCoreInvoke(
  pcCore: { call(method: string, params: unknown): Promise<unknown> } | null | undefined
): ServerInvoke {
  return async <T>(name: string, args: unknown[]) => {
    if (!pcCore) throw new Error('The core connection is not available.');
    const { method, params } = routeDesktopOperation(name, args);
    // The core's refusal reaches the window as the operation lane hands it over (its message, its public code).
    return (await pcCore.call(method, params).catch((error: unknown) => {
      throw coreErrorForWindow(error);
    })) as T;
  };
}

/** Raw bytes per ranged read (the daemon's own ceiling). */
const SERVER_READ_CHUNK_BYTES = 4 * 1024 * 1024;
export { SERVER_UPLOAD_CHUNK_BYTES };
const MAX_GRANTS = 1_000;
const MAX_PREVIEWS = 256;

// ── Server answers ──────────────────────────────────────────────────────────
// The server is untrusted: every size, offset, id and byte count it returns is
// checked before this PC decodes, allocates or writes anything because of it.

/** A server answer that breaks the file-transfer protocol. */
class ServerResponseError extends Error {
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

/** "Download to this PC" of one server window: the stepwise, cancellable copy of a server file into this PC's download
 *  folder is this PC's core (`transfer/serverDownload/*`, over its own link to the server `serverId`); this holds the
 *  window's downloads so that closing the window cancels them. Only files the core fetched may then be opened. */
export function createServerDownloads({
  core,
  serverId,
  downloadsDir,
}: {
  /** An operation of this PC's core (not the window's own connection, which is the server's). */
  core: ServerInvoke;
  /** The id of the window's connection, which names this PC's link to the server. */
  serverId: string;
  downloadsDir: () => string;
}) {
  const unfinished = new Set<string>();
  const answer = (value: unknown, what: string): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`The core sent no ${what}.`);
    return value as Record<string, unknown>;
  };
  const required = (id: unknown): string => {
    if (typeof id !== 'string' || !id) throw new TypeError('downloadId is invalid.');
    return id;
  };

  return {
    async begin(root: string, rel: string): Promise<{ downloadId: string; name: string; size: number }> {
      const { downloadId, name, size } = answer(
        await core('serverDownloadBegin', [serverId, downloadsDir(), root, rel]),
        'download'
      );
      if (typeof downloadId !== 'string' || typeof name !== 'string' || typeof size !== 'number') {
        throw new TypeError('The core sent an invalid download.');
      }
      unfinished.add(downloadId);
      return { downloadId, name, size };
    },
    async step(id: unknown): Promise<{ received: number; size: number; done: boolean }> {
      const { received, size, done } = answer(await core('serverDownloadStep', [required(id)]), 'download step');
      if (typeof received !== 'number' || typeof size !== 'number' || typeof done !== 'boolean') {
        throw new TypeError('The core sent an invalid download step.');
      }
      return { received, size, done };
    },
    async finish(id: unknown): Promise<{ path: string }> {
      const downloadId = required(id);
      const { path } = answer(await core('serverDownloadFinish', [downloadId]), 'download path');
      unfinished.delete(downloadId);
      if (typeof path !== 'string') throw new TypeError('The core sent an invalid download path.');
      return { path };
    },
    async abort(id: unknown): Promise<boolean> {
      // An id that is no string names no download.
      if (typeof id !== 'string' || !id) return false;
      const downloadId = id;
      unfinished.delete(downloadId);
      return (await core('serverDownloadAbort', [downloadId])) === true;
    },
    /** Only a file this PC's core downloaded from the server may be handed to the OS. */
    async requireDownloaded(path: unknown): Promise<string> {
      const file = typeof path === 'string' ? path : '';
      if (!file || (await core('serverDownloadCheck', [file])) !== true) {
        throw new LocalAccessDeniedError('Only a file downloaded from the server can be opened.');
      }
      return file;
    },
    async dispose(): Promise<void> {
      const pending = [...unfinished];
      unfinished.clear();
      await Promise.all(pending.map((id) => core('serverDownloadAbort', [id]).catch(() => {})));
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
  core,
  serverId,
  listProjects,
  session,
  downloadsDir,
}: {
  invoke: ServerInvoke;
  /** An operation of this PC's core, which does the downloads (see createServerDownloads). */
  core: ServerInvoke;
  /** The window's connection id. */
  serverId: string;
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
  const downloads = createServerDownloads({ core, serverId, downloadsDir });
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
