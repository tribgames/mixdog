/**
 * Per-session writer claim shared by every Mixdog process on a data dir.
 *
 * A session's log has one writer: an OS-held exclusive lock
 * (os-exclusive-lock.mjs) on `<dataDir>/session-writer-locks/<id>.lock`, which
 * the kernel releases however the process ends — nothing ever judges whether
 * a holder is still alive. A writer takes it before it reads the session it
 * will write (resume, turn open) or at its first save, keeps it while the
 * session stays open here, and gives it up when its close/detach barrier
 * lands, on delete, on idle unload and at process exit. Other sessions — and
 * other processes on the same data dir — are never blocked.
 *
 * No record reaches the log unless this process holds the lock: the session
 * log writer checks it before every write. Letting it go first lets the
 * session's recorder finish (session-writers.mjs, through the release hook),
 * so no write of this process is in flight once another may take the lock.
 */
import { unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { getPluginData } from '../../config.mjs';
import { acquireOsExclusiveLockSync } from '../../../../shared/os-exclusive-lock.mjs';
import { sessionRecordPath } from './session-paths.mjs';
import { _recordSaveFailure } from './live-state.mjs';

const CLAIM_DIR = 'session-writer-locks';
const LOCK_NAMESPACE = 'session-writer';
const _held = new Map(); // lock path → the OS lock this process holds there
// lock path → token of a release still waiting for its recorder to finish
// (the lock stays in _held until then)
const _releasing = new Map();
const _heldListeners = new Set();
// (id) => Promise | null: finishes the session's recorder before its lock goes.
let _releaseHook = null;

// () => void: writes every recorder's records synchronously before the locks go at exit.
let _exitHook = null;

/** Registered by session-writers.mjs (an import back would be circular). */
export function setSessionWriterReleaseHook(hook, exitHook = null) {
  _releaseHook = typeof hook === 'function' ? hook : null;
  _exitHook = typeof exitHook === 'function' ? exitHook : null;
}

/** `listener(id, held)` whenever this process takes (true) or lets go (false)
 *  of a session's writer lock — the daemon's idle unload clock. */
export function onSessionWriterHeldChange(listener) {
  if (typeof listener !== 'function') return () => {};
  _heldListeners.add(listener);
  return () => _heldListeners.delete(listener);
}

function _emitHeld(id, held) {
  for (const listener of [..._heldListeners]) {
    try {
      listener(id, held);
    } catch {
      /* observers never affect the claim */
    }
  }
}

// `<dataDir>/session-writer-locks/<id>.lock`: the data dir is the namespace,
// whoever's home or profile the process runs under.
function _claimPath(id) {
  sessionRecordPath(id); // rejects an id that is not a safe file name
  return join(getPluginData(), CLAIM_DIR, `${id}.lock`);
}

// On Windows nobody can delete a lock file another handle has open, so the
// released file is removed at once: a process opening it after the removal
// creates and locks a new one. Elsewhere a file stays (see forgetSessionWriter).
function _dropLock(path, lock) {
  lock.release();
  if (process.platform !== 'win32') return;
  try {
    unlinkSync(path);
  } catch {
    /* another process has it open: it is theirs now */
  }
}

// The lock is only this session's while its file is still the one locked: a
// Windows release unlinks the file, and a lock on an unlinked file guards nothing.
function _acquire(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const lock = acquireOsExclusiveLockSync(path, { namespace: LOCK_NAMESPACE });
    if (!lock.held || lock.intact()) return lock;
    lock.release();
  }
  return { held: false };
}

/**
 * Become the session's writer, or learn that another holder is. `{ held:
 * true, fresh }` where `fresh` says this call took it (it was not ours a
 * moment ago), or `{ held: false, path }` while another process holds it.
 */
export function claimSessionWriter(id) {
  const path = _claimPath(id);
  const mine = _held.get(path);
  if (mine && _releasing.delete(path) && mine.intact()) {
    // Taken up again while its release waits for the recorder: still held.
    _emitHeld(id, true);
    return { held: true, fresh: true };
  }
  if (mine?.intact()) return { held: true, fresh: false };
  if (mine) {
    // Its file is gone: the lock guards nothing.
    _held.delete(path);
    mine.release();
  }
  const lock = _acquire(path);
  if (!lock.held) return { held: false, path };
  _held.set(path, lock);
  _emitHeld(id, true);
  return { held: true, fresh: true };
}

/** Whether this process holds `id`'s claim right now (not on its way out). */
export function sessionWriterHeldHere(id) {
  const path = _claimPath(id);
  return _held.get(path)?.intact() === true && !_releasing.has(path);
}

/** sessionWriterHeldHere for a verdict that lets work be skipped (the session
 *  load's replay): a claim file whose metadata cannot be read is not shown to
 *  be the locked one, so it does not count as held. */
export function sessionWriterHeldStrictlyHere(id) {
  const path = _claimPath(id);
  return _held.get(path)?.intactStrict() === true && !_releasing.has(path);
}

/** Ids of the sessions whose claim this process holds now (none on its way out). */
export function heldSessionWriterIds() {
  return [..._held.keys()].filter((path) => !_releasing.has(path)).map((path) => basename(path, '.lock'));
}

/**
 * Give up this process's claim on `id`. The session's recorder finishes first
 * (its acknowledged writes landed, nothing of it is in flight); a claim taken
 * up again meanwhile keeps the lock. Resolves true once the lock is gone,
 * false when this process held none (or took it up again before it went).
 */
export function releaseSessionWriter(id) {
  let path;
  try {
    path = _claimPath(id);
  } catch {
    return Promise.resolve(false);
  }
  const lock = _held.get(path);
  if (!lock) return Promise.resolve(false);
  const token = {};
  _releasing.set(path, token);
  const drop = () => {
    if (_releasing.get(path) !== token || _held.get(path) !== lock) return false;
    _releasing.delete(path);
    _held.delete(path);
    _dropLock(path, lock);
    _emitHeld(id, false);
    return true;
  };
  const finishing = _releaseHook?.(id);
  if (!finishing) return Promise.resolve(drop());
  return finishing.then(drop, () => drop());
}

/** Idle unload: this process stops writing `id`, so another process may open
 *  it. Null when it is not held here, else releaseSessionWriter's promise. */
export function releaseIdleSessionWriterClaim(id) {
  if (!sessionWriterHeldHere(id)) return null;
  return releaseSessionWriter(id);
}

/** Delete: the lock goes. Its file is removed only where that is safe (Windows,
 *  in _dropLock): elsewhere an unlink after the release would let a process
 *  that took the old file in between and one that creates the next both hold
 *  the claim of an id that can be created again (reserved and home ids are). */
export function forgetSessionWriter(id) {
  const path = _claimPath(id);
  if (_held.has(path)) return releaseSessionWriter(id);
  if (process.platform === 'win32') {
    try {
      unlinkSync(path);
    } catch {
      /* absent, or open in another process: it is theirs */
    }
  }
  return Promise.resolve(false);
}

/** Process exit: every claim this process holds (the kernel would anyway). */
export function releaseHeldSessionWriters() {
  // What the recorders hold lands while this process still holds the locks.
  _exitHook?.();
  const paths = [..._held.keys()];
  for (const [path, lock] of _held) _dropLock(path, lock);
  _held.clear();
  _releasing.clear();
  for (const path of paths) _emitHeld(basename(path, '.lock'), false);
}

/**
 * Keeps every writer of `id` out, for a decision about the session's record
 * (is it absent?) that a save must not change before the caller has acted on
 * it. Admission to a save takes this claim first, so while the lock is held no
 * save of `id` can be admitted by any process. A session that already has a
 * writer (open here, or a claim in another process) cannot be excluded: null.
 * Otherwise `{ release() }`. A try-lock, never a wait; it registers no claim
 * and announces nothing.
 */
export function excludeSessionWriters(id) {
  if (!isMainThread) return null;
  const path = _claimPath(id);
  if (_held.has(path)) return null;
  const lock = _acquire(path);
  if (!lock.held) return null;
  let released = false;
  _excluded.set(path, (_excluded.get(path) ?? 0) + 1);
  return {
    release() {
      if (released) return;
      released = true;
      _dropLock(path, lock);
      const left = (_excluded.get(path) ?? 1) - 1;
      if (left > 0) _excluded.set(path, left);
      else _excluded.delete(path);
      if (left === 0) for (const wake of _excludedWaiters.splice(0)) wake();
    },
  };
}

// Exclusions held in this process (path -> count) and the creators waiting.
const _excluded = new Map();
const _excludedWaiters = [];

/**
 * Resolves once no exclusion of `id`'s writers is held in this process: it
 * ends with its batch's index write, which wakes the waiters. A creator that
 * reuses an id (reserved, home and room ids are created again when missing)
 * awaits this before its claim. An exclusion held by ANOTHER process has no
 * such signal; the claim reports it as any other holder.
 */
export async function whenSessionWritersFree(id) {
  const path = _claimPath(id);
  while (_excluded.has(path)) await new Promise((resolve) => _excludedWaiters.push(resolve));
}

const REFUSAL_CODES = {
  claimed: 'ESESSIONCLAIMED',
  changed: 'ESESSIONCHANGED',
  unclaimable: 'ESESSIONUNCLAIMABLE',
};

export function sessionWriterRefusalError(refusal) {
  const { id, reason, path, cause } = refusal;
  let message;
  if (reason === 'claimed') {
    message = `Session ${id} is open in another Mixdog process; close it there before writing to it here (writer lock: ${path})`;
  } else if (reason === 'changed') {
    message = `Session ${id} was changed by another Mixdog process after it was loaded here; reload it before writing`;
  } else {
    message = `Session ${id}: cannot take its writer lock (${cause?.message || cause})`;
  }
  const error = new Error(message);
  error.code = REFUSAL_CODES[reason];
  error.sessionId = id;
  return error;
}

/**
 * Save pre-admission: null when this process holds (or just took) `id`'s
 * claim, else the refusal `{ id, reason, path? }`. `fresh` reports a claim
 * this call took.
 */
export function sessionWriterRefusal(id) {
  let claim;
  try {
    claim = claimSessionWriter(id);
  } catch (error) {
    return { refusal: { id, reason: 'unclaimable', cause: error } };
  }
  if (!claim.held) return { refusal: { id, reason: 'claimed', path: claim.path } };
  return { refusal: null, fresh: claim.fresh };
}

/** A refused save: reported on stderr and recorded as the id's save failure
 *  (desktop notice, getSessionSaveError), never a silent drop. */
export function refuseSessionWrite(refusal) {
  const error = sessionWriterRefusalError(refusal);
  process.stderr.write(`[session-store] ${error.message}\n`);
  _recordSaveFailure(refusal.id, error);
  return error;
}

/** Writer entry points (resume, turn open): take the claim before reading the
 *  session, or throw the refusal. */
export function claimSessionWriterOrThrow(id) {
  const claim = claimSessionWriter(id);
  if (!claim.held) throw sessionWriterRefusalError({ id, reason: 'claimed', path: claim.path });
  return claim;
}
