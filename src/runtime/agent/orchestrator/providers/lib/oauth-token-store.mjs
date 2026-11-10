// Writers shared by the OAuth token stores whose saves are asynchronous. A
// sign-out and a refresh's publish go through the store's one write lock and
// compare the credential they act on under it, so a sign-out wins over any
// save or refresh already in flight instead of being undone by it.
import { existsSync, unlinkSync } from 'node:fs';
import { updateJsonAtomic, withFileLock } from '../../../../shared/atomic-file.mjs';

/** Runs `fn` under the write lock of the token file at `path`: the one
 *  updateJsonAtomic and writeJsonAtomicAsync({ lock: true }) take. */
export function withTokenStoreLock(path, fn) {
  return withFileLock(`${path}.lock`, fn, { secret: true });
}

/**
 * Deletes the token file under the store's write lock. A save or refresh
 * already queued on the lock publishes first and this removal lands after it,
 * so it cannot restore the sign-in once this has resolved. Resolves whether a
 * file was removed.
 */
export function removeStoredTokens(path) {
  return withTokenStoreLock(path, () => {
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  });
}

/**
 * Stores `next` over the token file only while it still holds the credential
 * `previous` was read from (access and refresh token), compared under the
 * store's write lock. A refresh that spent `previous` therefore never publishes
 * over a sign-out that removed it or a sign-in that replaced it while the
 * exchange was in flight. Resolves whether `next` was stored.
 */
export async function replaceStoredTokens(path, previous, next) {
  let replaced = false;
  await updateJsonAtomic(
    path,
    (stored) => {
      const holdsPrevious =
        stored?.access_token === previous.access_token && stored?.refresh_token === previous.refresh_token;
      if (!stored || !holdsPrevious) return undefined;
      replaced = true;
      return next;
    },
    { fsyncDir: true, mode: 0o600, secret: true }
  );
  return replaced;
}
