// The daemon's ownership of a data dir: the OS-held exclusive lock
// (os-exclusive-lock.mjs) on daemon-owner.lock, kept for the whole life of the
// process and dropped by the kernel however the process ends, so the next
// daemon acquires it at once.
//
// The lock file is created once and never rewritten or unlinked: one deleted or
// replaced while held would let a new daemon lock (or name) another, so the
// daemon watches it and `intact()` compares the identity at its path with the
// file locked.
import { join } from 'node:path';
import { acquireOsExclusiveLock, osExclusiveLockHeld } from '../runtime/shared/os-exclusive-lock.mjs';

const LOCK_OPTIONS = Object.freeze({ namespace: 'daemon-owner' });

export function daemonOwnerLockPath(dataDir) {
  return join(dataDir, 'daemon-owner.lock');
}

/** `{ held: false }` while another live daemon holds the lock, else the
 *  holder's handle `{ held, path, intact(), release() }`, which must stay
 *  referenced for as long as the daemon runs. */
// The handle this process holds, if any: what tells the daemon from every other
// process on the data dir (`daemonOwnerLockHeld` below answers for any holder).
let heldHere = null;

export async function acquireDaemonOwnerLock(lockPath) {
  const lock = await acquireOsExclusiveLock(lockPath, LOCK_OPTIONS);
  if (!lock.held) return lock;
  // Releasing ends the ownership too: the handle's own `held` stays true.
  const owned = {
    ...lock,
    release() {
      if (heldHere === owned) heldHere = null;
      lock.release();
    },
  };
  heldHere = owned;
  return owned;
}

/** Whether THIS process is the daemon that owns its data dir: it took the lock
 *  and the lock file is still the one it locked. */
export function daemonOwnerLockHeldHere() {
  return heldHere?.held === true && heldHere.intact();
}

/** Whether a live daemon (booting, serving or stopping) holds the lock. A
 *  daemon starting in the instant this asks loses its claim and exits for
 *  attach; its launcher asks again. */
export function daemonOwnerLockHeld(lockPath) {
  return osExclusiveLockHeld(lockPath, LOCK_OPTIONS);
}
