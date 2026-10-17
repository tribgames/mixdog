// The remote file lanes' check of an OPEN file. A check on a pathname covers
// nothing once the path can change before the read, so a remote read opens the
// file first and authorizes the open file: its real location
// (opened-file-path.ts) must lie inside the authorized folder and must not be
// secret-bearing (remote-sensitive-paths.ts), and the bytes come through that
// very handle. Shared by the RPC previews, the relay media lane and the local
// page server's remote leases, so every one of them applies the same rule.
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, realpath, unlink } from 'node:fs/promises';
import { sep } from 'node:path';

import { LocalAccessDeniedError } from './local-access-denied';
import { openedFilePath } from './opened-file-path';
import { SENSITIVE_PATH_MESSAGE, type SensitivePolicy, sensitivePathMatcher } from './remote-sensitive-paths';

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

const sensitiveDenial = (): LocalAccessDeniedError => new LocalAccessDeniedError(SENSITIVE_PATH_MESSAGE);

/** Test seam: runs after a path passed its name checks and before it is
 *  opened — where a swapped folder or link would redirect the open. */
export const openedFileAuthorizationTestHooks: { beforeOpen?: (absolute: string) => Promise<void> | void } = {};

/** Opens `absolute` and authorizes the file the handle has open: a regular
 *  file whose real location is inside `within` and neither its name nor that
 *  location is secret-bearing under `policy` (this process's by default). The
 *  name is judged before anything is opened; with `mode: 'write'` the handle
 *  is read-write and nothing is written until it is authorized. The caller
 *  closes the handle. */
export async function openAuthorizedFile(
  absolute: string,
  within: string,
  policy?: SensitivePolicy,
  mode: keyof typeof OPEN_FLAGS = 'read'
): Promise<AuthorizedFile> {
  const denied = await sensitivePathMatcher(policy);
  if (denied(absolute)) throw sensitiveDenial();
  const root = await realpath(within);
  await openedFileAuthorizationTestHooks.beforeOpen?.(absolute);
  const handle = await open(absolute, OPEN_FLAGS[mode]);
  try {
    return await authorizeOpened(handle, absolute, root, denied);
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The open file `handle` (opened by `absolute`) as an AuthorizedFile, or a
 *  rejection when it is no regular file, lies outside `root` or is denied. */
async function authorizeOpened(
  handle: FileHandle,
  absolute: string,
  root: string,
  denied: (path: string) => boolean
): Promise<AuthorizedFile> {
  const identity = await handle.stat({ bigint: true });
  if (!identity.isFile()) throw new Error('The preview target is not a file.');
  const location = await openedFilePath(handle, absolute, identity).catch(() => {
    throw new Error('The file changed while it was opened.');
  });
  if (!inside(root, location)) throw new LocalAccessDeniedError('The file resolves outside the project.');
  if (denied(location)) throw sensitiveDenial();
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

/** Creates `absolute` (which must not exist; its folder must) and authorizes
 *  the new file like openAuthorizedFile, read-write and still empty. A new
 *  file that turns out to be somewhere it may not be is removed again. */
export async function createAuthorizedFile(
  absolute: string,
  within: string,
  policy?: SensitivePolicy
): Promise<AuthorizedFile> {
  const denied = await sensitivePathMatcher(policy);
  if (denied(absolute)) throw sensitiveDenial();
  const root = await realpath(within);
  await openedFileAuthorizationTestHooks.beforeOpen?.(absolute);
  const handle = await open(absolute, OPEN_FLAGS.write | constants.O_CREAT | constants.O_EXCL, 0o644);
  try {
    return await authorizeOpened(handle, absolute, root, denied);
  } catch (error) {
    // Only the very file this call created goes: found by the handle.
    const identity = await handle.stat({ bigint: true });
    const location = await openedFilePath(handle, absolute, identity).catch(() => null);
    await handle.close();
    const now = location ? await lstat(location, { bigint: true }).catch(() => null) : null;
    if (location && now?.dev === identity.dev && now.ino === identity.ino) await unlink(location).catch(() => {});
    throw error;
  }
}
