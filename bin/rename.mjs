// Renames that wait out a transient refusal: on Windows an antivirus scan or an indexer holds a fresh folder for a moment.
// 1.4.5's schedule (file-lock.mjs DEFAULT_BACKOFFS_MS): about 4.2 s of retries.
import { renameSync, statSync } from 'node:fs';

const RENAME_BACKOFFS_MS = Object.freeze([25, 50, 100, ...Array(20).fill(200)]);
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST']);

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The jittered pause before the next rename attempt, or null when this error or attempt ends the retries: only a transient
 * refusal is worth waiting for, and Windows answers EPERM/EACCES also for renaming over a read-only file, which never clears.
 */
export function nextRenameDelayMs(error, attempt, to, random = Math.random) {
  if (!RETRY_CODES.has(error?.code) || attempt >= RENAME_BACKOFFS_MS.length) return null;
  if (error.code === 'EPERM' || error.code === 'EACCES') {
    try {
      const stat = statSync(to);
      if (stat.isFile() && (stat.mode & 0o200) === 0) return null;
    } catch {
      // Nothing there to be read-only.
    }
  }
  const base = RENAME_BACKOFFS_MS[attempt];
  return base + Math.floor(random() * Math.min(50, Math.max(1, base)));
}

/** `renameWithRetrySync` of 1.4.5. */
export function renameWithRetry(from, to, { rename = renameSync, sleep = sleepSync, random = Math.random } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const delay = nextRenameDelayMs(error, attempt, to, random);
      if (delay === null) throw error;
      sleep(delay);
    }
  }
}