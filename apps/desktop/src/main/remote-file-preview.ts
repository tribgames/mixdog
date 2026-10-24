// Remote file previews over the ENCRYPTED RPC lane. The Electron preview
// protocol URLs mean nothing to a browser and the plaintext HTTP media lane is
// disabled, so the browser pulls bytes in bounded base64 ranges and builds
// blob: URLs (or a sandboxed srcdoc page) itself. Authorization is exactly the
// editor's: a registered project directory or a one-file selected-file grant.
//
// A check on a pathname covers nothing once the path can change before the
// read, so every byte read opens the file first and authorizes the OPEN file:
// its real location (opened-file-path.ts) must lie inside the authorized
// folder, and the bytes come through that very handle. Work the desktop hands
// a path to (a snapshot, a document conversion) gets the same project or
// granted path here.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { filePreviewTypeForPath } from '../shared/file-preview';
import { pageAssetType } from './local-page-server';
import { requiredString } from './ipc-validation';
import { type AuthorizedFile, openAuthorizedFile, openedFileAuthorizationTestHooks } from './opened-file-authorization';
import { projectEntryPathIn } from './project-files';
import { leaseMediaFile } from './media-leases';
import type { DesktopService } from './desktop-service-contract';

/** Raw bytes per read. Base64 makes it ~5.6 MB per frame, far below the
 *  relay's 64 MiB frame ceiling, and keeps one slow read from stalling the UI
 *  socket for long. */
export const REMOTE_PREVIEW_MAX_READ_BYTES = 4 * 1024 * 1024;

export interface PreviewGrants {
  grantedFile(
    accessToken: unknown,
    projectPath: unknown,
    relPath: unknown
  ): { root: string; rel: string; absolute: string };
  grantedIf(accessToken: unknown): boolean;
}

type RemoteMethod = (params: unknown[]) => unknown;

function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

export { type AuthorizedFile, openAuthorizedFile } from './opened-file-authorization';
/** The opened-file check's test seam, under the name these lanes' tests use. */
export const remoteFilePreviewTestHooks = openedFileAuthorizationTestHooks;

/** Largest file handed to a conversion or snapshot as a private copy. */
export const AUTHORIZED_COPY_MAX_BYTES = 256 * 1024 * 1024;

/** Private copies in use, by path: the same bytes requested twice at once
 *  share one copy, removed when its last user is done. */
const copies = new Map<string, { users: number; ready: Promise<void>; directory: string; removal?: Promise<void> }>();

/** This process's private root, made once by mkdtemp (mode 0700, a fresh
 *  unpredictable name that cannot be a pre-created directory or link); every
 *  copy's folder lives inside it. */
let privateRoot: Promise<string> | undefined;
function authorizedCopiesRoot(): Promise<string> {
  privateRoot ??= mkdtemp(join(tmpdir(), 'mixdog-authorized-copies-')).catch((error) => {
    privateRoot = undefined;
    throw error;
  });
  return privateRoot;
}

/** A private copy of an authorized open file: its bytes, read through the
 *  handle, in a folder only this user can read, named after the content and
 *  modification time (so a conversion cache keyed by path and mtime keeps
 *  hitting) and given the source's mtime. */
async function privateCopy(file: AuthorizedFile): Promise<{ path: string; release(): Promise<void> }> {
  if (file.size > AUTHORIZED_COPY_MAX_BYTES) throw new Error('This file is too large to preview remotely.');
  const bytes = await file.handle.readFile();
  const name = basename(file.location);
  // The name is part of the key: a directory belongs to exactly one copy, so
  // removing it can never remove another preview's input.
  const key = createHash('sha256').update(bytes).update(`\0${file.mtimeMs}\0${name}`).digest('hex').slice(0, 32);
  const base = await authorizedCopiesRoot();
  const directory = join(base, key);
  const path = join(directory, name);
  let entry = copies.get(path);
  // A copy whose last user is gone is being removed: wait for that to finish
  // before creating it again, so the removal cannot take the new copy.
  while (entry?.removal) {
    await entry.removal;
    entry = copies.get(path);
  }
  if (!entry) {
    const created = {
      users: 0,
      directory,
      ready: (async () => {
        await mkdir(directory, { mode: 0o700 });
        await writeFile(path, bytes, { mode: 0o600 });
        const at = new Date(file.mtimeMs);
        await utimes(path, at, at);
      })(),
    };
    copies.set(path, created);
    entry = created;
  }
  const held = entry;
  held.users += 1;
  const release = async (): Promise<void> => {
    held.users -= 1;
    if (held.users > 0 || held.removal) return;
    held.removal = rm(held.directory, { recursive: true, force: true })
      .catch(() => undefined)
      .finally(() => {
        if (copies.get(path) === held) copies.delete(path);
      });
    await held.removal;
  };
  try {
    await held.ready;
  } catch (error) {
    await release();
    throw error;
  }
  return { path, release };
}

/** Runs `read` — work another process does by path (a conversion, a
 *  snapshot) — on a stable input: a private copy of the bytes read through
 *  the authorized handle of `absolute` within `within`, never the original
 *  path, which could be swapped and restored around the read. `read` gets the
 *  copy's folder and file name; the copy is removed afterwards. */
export async function withAuthorizedFile<T>(
  absolute: string,
  within: string,
  read: (file: { root: string; rel: string; location: string }) => Promise<T> | T
): Promise<T> {
  const file = await openAuthorizedFile(absolute, within);
  let copy: Awaited<ReturnType<typeof privateCopy>>;
  try {
    copy = await privateCopy(file);
  } finally {
    await file.handle.close();
  }
  try {
    return await read({ root: dirname(copy.path), rel: basename(copy.path), location: copy.path });
  } finally {
    await copy.release();
  }
}

/** One bounded base64 window of `absolute`, read through the handle whose
 *  real location was authorized inside `within` (openAuthorizedFile);
 *  `length` is capped at REMOTE_PREVIEW_MAX_READ_BYTES. Shared with the
 *  remote visualize panes. */
export async function readPreviewRange(
  absolute: string,
  within: string,
  mime: string,
  rawOffset: unknown,
  rawLength: unknown
): Promise<{ data: string; mime: string; offset: number; mtimeMs: number; size: number }> {
  const offset = integer(rawOffset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const length = integer(rawLength, 'length', 1, REMOTE_PREVIEW_MAX_READ_BYTES);
  const file = await openAuthorizedFile(absolute, within);
  try {
    const buffer = Buffer.alloc(Math.max(0, Math.min(length, file.size - offset)));
    const { bytesRead } = buffer.length ? await file.handle.read(buffer, 0, buffer.length, offset) : { bytesRead: 0 };
    return {
      data: buffer.subarray(0, bytesRead).toString('base64'),
      mime,
      offset,
      mtimeMs: file.mtimeMs,
      size: file.size,
    };
  } finally {
    await file.handle.close();
  }
}

/** SHA-256 (hex) of the authorized open file's bytes, with its size and
 *  modification time: a page's content identity for a device's cache. A file
 *  over `maxBytes` (by the opened handle's size, or by the bytes it really
 *  has when it grew since) gets no digest; at most `maxBytes + 1` are read. */
export async function authorizedFileDigest(
  absolute: string,
  within: string,
  maxBytes: number
): Promise<{ sha256: string | null; mtimeMs: number; size: number }> {
  const file = await openAuthorizedFile(absolute, within);
  try {
    const info = { mtimeMs: file.mtimeMs, size: file.size };
    if (file.size > maxBytes) return { ...info, sha256: null };
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, 1024 * 1024));
    let offset = 0;
    while (offset <= maxBytes) {
      const length = Math.min(buffer.length, maxBytes + 1 - offset);
      const { bytesRead } = await file.handle.read(buffer, 0, length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return { ...info, sha256: offset > maxBytes ? null : hash.digest('hex') };
  } finally {
    await file.handle.close();
  }
}

/** Size and modification time of the authorized open file, and a media lease
 *  of it: the lane re-authorizes the lease the same way when it serves it. */
export async function authorizedMediaFile(
  absolute: string,
  within: string,
  mime: string | null
): Promise<{ mtimeMs: number; size: number; mediaAssetId?: string }> {
  const file = await openAuthorizedFile(absolute, within);
  await file.handle.close();
  const info = { mtimeMs: file.mtimeMs, size: file.size };
  if (mime === null) return info;
  return { ...info, mediaAssetId: leaseMediaFile(file.location, mime, { within: file.root, identity: file.identity }) };
}

/** The file a paired device's (projectPath, relPath, accessToken) names, as
 *  the desktop's editor handlers resolve it: the one-file grant's file when a
 *  token is given, else a file of the registered project. Either way it is
 *  resolved by projectEntryPathIn — re-resolved per call, so a name later
 *  swapped for a link out of its folder is refused — and the lane that reads
 *  it authorizes the opened file again. `rel` is relative to `root`. An
 *  invalid argument or grant throws synchronously, before anything is
 *  resolved. */
export function remoteFileTarget(
  host: Pick<DesktopService, 'projectDirectory'>,
  grants: PreviewGrants,
  projectPath: unknown,
  relPath: unknown,
  accessToken: unknown
): Promise<{ root: string; rel: string; absolute: string; granted: boolean }> {
  const located = async (root: string, rel: string, granted: boolean) => ({
    root,
    rel,
    absolute: projectEntryPathIn(root, rel),
    granted,
  });
  if (grants.grantedIf(accessToken)) {
    const { root, rel } = grants.grantedFile(accessToken, projectPath, relPath);
    return located(root, rel, true);
  }
  const project = requiredString(projectPath, 'projectPath');
  const rel = requiredString(relPath, 'relPath', 4_096);
  return host.projectDirectory(project).then((root) => located(root, rel, false));
}

export function createRemoteFilePreviewMethods(deps: {
  host: Pick<DesktopService, 'projectDirectory'>;
  grants: PreviewGrants;
  /** Electron-only work runs in the window process; the snapshot window lives there. */
  hostRequest?: (method: 'captureFileSnapshot', args: unknown[]) => Promise<unknown>;
}): Record<string, RemoteMethod> {
  const { host, grants, hostRequest } = deps;
  const target = (projectPath: unknown, relPath: unknown, accessToken: unknown) =>
    remoteFileTarget(host, grants, projectPath, relPath, accessToken);
  return {
    // Metadata only: the browser then reads the bytes through the range method.
    previewProjectFile: async ([projectPath, relPath, accessToken]) => {
      const { root, absolute } = await target(projectPath, relPath, accessToken);
      const type = filePreviewTypeForPath(absolute);
      if (!type) throw new Error('This file type does not support an in-app preview.');
      // Streamable kinds also get a lease the encrypted relay media lane can
      // serve; a browser without that lane ignores it and reads ranges below.
      const info = await authorizedMediaFile(absolute, root, type.kind === 'pdf' ? null : type.mime);
      return { kind: type.kind, mime: type.mime, ...info };
    },
    // Resolved by the same grants/projects as the desktop's and captured
    // exactly as the desktop handler captures it (a granted file alone, a
    // project page with its project); the capture itself runs in the window
    // process (the daemon bundle has no Electron).
    captureFileSnapshot: async ([projectPath, relPath, accessToken]) => {
      if (!hostRequest) throw new TypeError('The desktop app is unavailable on this connection.');
      const { root, rel, granted } = await target(projectPath, relPath, accessToken);
      return hostRequest('captureFileSnapshot', [root, rel, granted]);
    },
    previewProjectFileRange: async ([projectPath, relPath, accessToken, rawOffset, rawLength]) => {
      // Arguments are checked before any path work, as before.
      integer(rawOffset, 'offset', 0, Number.MAX_SAFE_INTEGER);
      integer(rawLength, 'length', 1, REMOTE_PREVIEW_MAX_READ_BYTES);
      const { root, absolute } = await target(projectPath, relPath, accessToken);
      const mime = filePreviewTypeForPath(absolute)?.mime || pageAssetType(root, absolute);
      if (!mime) throw new Error('This file type does not support an in-app preview.');
      return readPreviewRange(absolute, root, mime, rawOffset, rawLength);
    },
  };
}
