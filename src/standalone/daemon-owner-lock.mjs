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
export function acquireDaemonOwnerLock(lockPath) {
  return acquireOsExclusiveLock(lockPath, LOCK_OPTIONS);
}

/** Whether a live daemon (booting, serving or stopping) holds the lock. A
 *  daemon starting in the instant this asks loses its claim and exits for
 *  attach; its launcher asks again. */
export function daemonOwnerLockHeld(lockPath) {
  return osExclusiveLockHeld(lockPath, LOCK_OPTIONS);
}
