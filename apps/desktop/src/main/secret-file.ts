// Owner-only file IO for the remote-access credentials (pairing token, relay
// device identity). Both grant full remote control, so every read clamps the
// mode of installs created before the hardening and every write lands at 0600
// instead of the writer default.
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';

const SECRET_FILE_MODE = 0o600;

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

/** Create the parent directory and write owner-only. */
export async function writeSecretFile(path: string, data: string): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true });
  await fsp.writeFile(path, data, { encoding: 'utf8', mode: SECRET_FILE_MODE });
  await clamp(path);
}
