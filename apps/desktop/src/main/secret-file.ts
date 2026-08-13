// Owner-only file IO for the remote-access credentials (pairing token, relay
// device identity). Both grant full remote control, so every read clamps the
// mode of installs created before the hardening and every write lands at 0600
// instead of the writer default.
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';

const SECRET_FILE_MODE = 0o600;
const secretWrites = new Map<string, Promise<void>>();

async function clamp(path: string): Promise<void> {
  // Windows ignores POSIX bits (userData already inherits a user-scoped ACL),
  // so a failure here is never fatal.
  await fsp.chmod(path, SECRET_FILE_MODE).catch(() => { /* windows/fs quirk */ });
}

/** Read a secret file, tightening its mode; null when absent/unreadable. */
export async function readSecretFile(path: string): Promise<string | null> {
  try {
    const text = await fsp.readFile(path, 'utf8');
    await clamp(path);
    return text;
  } catch {
    return null;
  }
}

async function writeSecretFileAtomic(path: string, data: string): Promise<void> {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  await fsp.mkdir(directory, { recursive: true });
  try {
    handle = await fsp.open(temporary, 'wx', SECRET_FILE_MODE);
    await handle.writeFile(data, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(temporary, path);
    await clamp(path);
    // Persist the directory entry where supported; Windows rejects directory
    // handles, but the atomic rename still preserves the previous file there.
    const directoryHandle = await fsp.open(directory, 'r').catch(() => null);
    if (directoryHandle) {
      await directoryHandle.sync().catch(() => {});
      await directoryHandle.close().catch(() => {});
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Create the parent directory and atomically replace with an owner-only file. */
export function writeSecretFile(path: string, data: string): Promise<void> {
  const previous = secretWrites.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => writeSecretFileAtomic(path, data));
  secretWrites.set(path, pending);
  return pending.finally(() => {
    if (secretWrites.get(path) === pending) secretWrites.delete(path);
  });
}
