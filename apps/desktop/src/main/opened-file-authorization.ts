// The remote file lanes' check of an OPEN file. A check on a pathname covers
// nothing once the path can change before the read, so a remote read opens the
// file first and authorizes the open file: its real location
// (opened-file-path.ts) must lie inside the authorized folder — the project or
// granted folder, the boundary the desktop's own reads apply
// (projectEntryPathIn) — and the bytes come through that very handle. Shared
// by the RPC previews, the editor's remote reads and saves and the relay media
// lane, so every one of them applies the same rule.
import { constants } from 'node:fs';
import { type FileHandle, open, realpath } from 'node:fs/promises';
import { sep } from 'node:path';

import { LocalAccessDeniedError } from './local-access-denied';
import { openedFilePath } from './opened-file-path';

// O_NONBLOCK keeps a FIFO swapped in for the file from blocking the open; it
// does not exist on Windows, where the type check after opening covers it.
// A write opens read-write and never creates or truncates: nothing is
// written before the open file is authorized.
const OPEN_FLAGS = {
  read: constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  write: constants.O_RDWR | (constants.O_NONBLOCK ?? 0),
} as const;

export const comparablePath = (path: string): string =>
  process.platform === 'win32' ? path.toLocaleLowerCase() : path;

/** Whether `path` is `root` or inside it (both canonical). */
function inside(root: string, path: string): boolean {
  const base = comparablePath(root);
  const target = comparablePath(path);
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

/** An open file whose real location was authorized. */
export interface AuthorizedFile {
  handle: FileHandle;
  /** Canonical path of the open file. */
  location: string;
  /** Canonical form of the folder it was authorized within. */
  root: string;
  size: number;
  mtimeMs: number;
  identity: { dev: bigint; ino: bigint };
}

/** Test seam: runs after a path passed its checks and before it is opened —
 *  where a swapped folder or link would redirect the open. */
export const openedFileAuthorizationTestHooks: { beforeOpen?: (absolute: string) => Promise<void> | void } = {};

/** Opens `absolute` and authorizes the file the handle has open: a regular
 *  file whose real location is inside `within`. With `mode: 'write'` the
 *  handle is read-write and nothing is written until it is authorized. The
 *  caller closes the handle. */
export async function openAuthorizedFile(
  absolute: string,
  within: string,
  mode: keyof typeof OPEN_FLAGS = 'read'
): Promise<AuthorizedFile> {
  const root = await realpath(within);
  await openedFileAuthorizationTestHooks.beforeOpen?.(absolute);
  const handle = await open(absolute, OPEN_FLAGS[mode]);
  try {
    return await authorizeOpened(handle, absolute, root);
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The open file `handle` (opened by `absolute`) as an AuthorizedFile, or a
 *  rejection when it is no regular file or lies outside `root`. */
async function authorizeOpened(handle: FileHandle, absolute: string, root: string): Promise<AuthorizedFile> {
  const identity = await handle.stat({ bigint: true });
  if (!identity.isFile()) throw new Error('The preview target is not a file.');
  const location = await openedFilePath(handle, absolute, identity).catch(() => {
    throw new Error('The file changed while it was opened.');
  });
  if (!inside(root, location)) throw new LocalAccessDeniedError('The file resolves outside the project.');
  const info = await handle.stat();
  return {
    handle,
    location,
    root,
    size: info.size,
    mtimeMs: info.mtimeMs,
    identity: { dev: identity.dev, ino: identity.ino },
  };
}
