// Remote credentials grant control of the desktop. Restrict new files before
// publication and tighten existing files before returning their contents.
import { promises as fsp } from 'node:fs';
import { writeFileAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';
import { enforceOwnerOnlyAclWin32Async } from '../../../../src/runtime/shared/file-permissions.mjs';
import { createKeyedSerialQueue } from '../../../../src/runtime/shared/keyed-serial-queue.mjs';

const SECRET_FILE_MODE = 0o600;
const secretWrites = createKeyedSerialQueue();

async function clamp(path: string): Promise<void> {
  if (process.platform === 'win32') await enforceOwnerOnlyAclWin32Async(path);
  else await fsp.chmod(path, SECRET_FILE_MODE);
}

/** Null only when absent; unreadable or unprotected credentials fail closed. */
export async function readSecretFile(path: string): Promise<string | null> {
  try {
    const text = await fsp.readFile(path, 'utf8');
    await clamp(path);
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Create the parent directory and atomically replace with an owner-only file. */
export function writeSecretFile(path: string, data: string): Promise<void> {
  return secretWrites(path, async () => {
    await writeFileAtomicAsync(path, data, { secret: true, fsyncDir: true });
  });
}
