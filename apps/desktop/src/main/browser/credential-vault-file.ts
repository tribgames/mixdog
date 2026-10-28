// The imported-password vault file: a sealed JSON document. Electron-free so
// its damage handling is testable; the caller supplies the unsealing.
import { readFile, rm } from 'node:fs/promises';

import { readJsonState, writeFileAtomicAsync, writeJsonAtomicAsync } from '../../../../../src/runtime/shared/atomic-file.mjs';

type Unseal = (sealed: Buffer) => string;

/** The vault's parsed document, or null when there is none. A vault that is
 *  empty, NUL-filled or cannot be unsealed is damaged: it is kept aside as
 *  `<file>.corrupt-<ts>` and the last good copy `<file>.bak` is restored, so a
 *  damaged file never blocks the stored logins. Read errors still throw. */
export function readVaultFile(file: string, unseal: Unseal): Promise<unknown> {
  return readJsonState(file, { decode: unseal, fallback: null, secret: true });
}

/** Replaces the vault durably. The version it replaces is kept as `<file>.bak`
 *  only while it still unseals, so a damaged vault never becomes the backup. */
export async function writeVaultFile(file: string, sealed: Buffer, unseal: Unseal): Promise<void> {
  const unseals = (content: Buffer) => {
    try {
      JSON.parse(unseal(content));
      return true;
    } catch {
      return false;
    }
  };
  await writeFileAtomicAsync(file, sealed, { secret: true, backup: true, backupAccepts: unseals });
}

/** The origins whose auto sign-in was paused while the vault could not be
 *  opened (no OS encryption): a plain, secret-free record next to the vault,
 *  folded into the sealed file the next time it opens. */
export const pendingPausesFile = (vaultFile: string): string => `${vaultFile}.pending-pauses.json`;

/** The recorded origins: `[]` when there is no record, `null` when it exists
 *  but cannot be trusted (unreadable, not JSON, not the record's shape). An
 *  empty reading of a damaged record would let paused sites sign in again, so
 *  it is never moved aside or replaced: the caller fails closed. */
export async function readPendingPauses(vaultFile: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await readFile(pendingPausesFile(vaultFile), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  try {
    const origins = (JSON.parse(text) as { origins?: unknown } | null)?.origins;
    return Array.isArray(origins) && origins.every((origin) => typeof origin === 'string') ? origins : null;
  } catch {
    return null;
  }
}

/** Records a pause. A damaged record is left exactly as it is (its earlier
 *  pauses may still be recoverable from it) and the new pause is not written:
 *  reading the vault stays refused while that record is damaged. */
export async function addPendingPause(vaultFile: string, origin: string): Promise<void> {
  const origins = await readPendingPauses(vaultFile);
  if (!origins || origins.includes(origin)) return;
  await writeJsonAtomicAsync(pendingPausesFile(vaultFile), { version: 1, origins: [...origins, origin] }, { secret: true });
}

export async function clearPendingPauses(vaultFile: string): Promise<void> {
  await rm(pendingPausesFile(vaultFile), { force: true });
}
