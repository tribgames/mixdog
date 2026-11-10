import { unlinkSync } from 'node:fs';
import { rename } from 'node:fs/promises';

// ── Publication fence ───────────────────────────────────────────────────────
// A file may be published on the calling thread while an older write of it is
// in flight (the turn checkpoint's header, the Mixy heartbeat's state). A
// started rename cannot be cancelled, so the older write is staged first and
// only renamed over the target from the staged file. The newer publish claims
// that file before writing: when the claim (an unlink) finds it, the older
// rename can no longer land; when it does not, the older rename already landed
// and the newer write follows it. Either way the target never regresses.
// `op` is `{ stagedPath, headerPath, superseded }`.
const STAGED_RENAME_RETRY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const STAGED_RENAME_BACKOFFS_MS = [10, 25, 50, 100, 200, 400, 800];

export function claimStagedHeader(op) {
  op.superseded = true;
  try {
    unlinkSync(op.stagedPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

// False when a newer write was published meanwhile and this one was dropped.
export async function publishStagedHeader(op) {
  for (let attempt = 0; ; attempt++) {
    if (op.superseded) return false;
    try {
      await rename(op.stagedPath, op.headerPath);
      return true;
    } catch (error) {
      if (op.superseded) return false;
      if (!STAGED_RENAME_RETRY.has(error?.code) || attempt >= STAGED_RENAME_BACKOFFS_MS.length) throw error;
      await new Promise((resolve) => {
        setTimeout(resolve, STAGED_RENAME_BACKOFFS_MS[attempt]);
      });
    }
  }
}
