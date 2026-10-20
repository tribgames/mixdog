// The imported-password vault file: a sealed JSON document. Electron-free so
// its damage handling is testable; the caller supplies the unsealing.
import { readJsonState, writeFileAtomicAsync } from '../../../../../src/runtime/shared/atomic-file.mjs';

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
