/**
 * Per-session writer claim shared by every Mixdog process on a data dir.
 *
 * A save replaces the whole session record, so two processes holding the same
 * session live would each rename their own snapshot over the other's. The
 * claim makes one process the session's only writer: an OS-held exclusive
 * lock (os-exclusive-lock.mjs) on `<dataDir>/session-writer-locks/<id>.lock`,
 * which the kernel releases however the process ends — nothing ever judges
 * whether a holder is still alive. A writer takes it before it reads the
 * session it will write (resume, turn open) or at its first save, keeps it
 * while the session stays open here, and gives it up when its close/detach
 * barrier lands, on delete and at process exit. Other sessions — and other
 * processes on the same data dir — are never blocked.
 *
 * A claim taken at a save rather than before the read also checks the copy
 * being saved: the record must still be the one that copy was parsed from (or
 * this process's own last commit), otherwise another writer landed in between.
 *
 * No write reaches the disk unless this process holds the lock for the whole
 * write: a save is admitted only while it is held, and letting it go cancels
 * every write admitted under it and keeps the lock until a rename already in
 * progress has landed — awaited, never waited for on the thread.
 */
import { unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
import { getPluginData } from '../../config.mjs';
import { acquireOsExclusiveLockSync } from '../../../../shared/os-exclusive-lock.mjs';
import { sessionPath, sessionRecordPath } from './session-paths.mjs';
import {
  CANONICAL_RECORD_UNREADABLE,
  ownCommittedLifecycle,
  readCanonicalSessionRecord,
  sameSessionStamp,
  statSessionStamp,
} from './canonical-reader.mjs';
import { _recordSaveDrop, _recordSaveFailure } from './live-state.mjs';
import { _hasSessionWriteControl, cancelSessionWrites, writeCommitSettled } from './write-guards.mjs';

const CLAIM_DIR = 'session-writer-locks';
const LOCK_NAMESPACE = 'session-writer';
const _held = new Map(); // lock path → the OS lock this process holds there
// lock path → token of a release still waiting for a rename to land (the
// lock stays in _held until then)
const _releasing = new Map();
const _baseStamps = new WeakMap(); // session document → stamp of the record it was parsed from
// session path → { stamp, barrier }: the record as it was when this process
// last let the session go, and whether its own close/detach barrier did. One
// entry per session let go, never evicted: provenance that expired would admit
// an old copy as current. It goes on delete, or once a resume or turn reads
// the session again (that read is the new base).
const _endedTenures = new Map();
const _heldListeners = new Set();

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
// delete unlinks the file, and a lock on the unlinked inode guards nothing.
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
    // Taken up again while its release waits for a rename: still held, and
    // the copy this claim admits is judged as at a fresh claim.
    _emitHeld(id, true);
    return { held: true, fresh: true };
  }
  if (mine?.intact()) return { held: true, fresh: false };
  if (mine) {
    // Its file is gone: the lock guards nothing, and nothing admitted under
    // it may land unless the claim below is won.
    if (_hasSessionWriteControl(id)) cancelSessionWrites(id);
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

/** Ids of the sessions whose claim this process holds now (none on its way out). */
export function heldSessionWriterIds() {
  return [..._held.keys()].filter((path) => !_releasing.has(path)).map((path) => basename(path, '.lock'));
}

// Let the lock on `path` go once no rename holds `id`'s commit lock: at once
// when none does, else when that rename's own release notifies (the lock is
// kept until then). A claim taken up again in between keeps it. `cancel`
// first cancels every write admitted under it. Resolves whether it went.
function _letGo(id, path, { cancel, after = null }) {
  const lock = _held.get(path);
  if (!lock) return Promise.resolve(false);
  if (cancel && _hasSessionWriteControl(id)) cancelSessionWrites(id);
  const drop = () => {
    _held.delete(path);
    _dropLock(path, lock);
    after?.();
    _emitHeld(id, false);
    return true;
  };
  const settled = writeCommitSettled(id);
  if (!settled) return Promise.resolve(drop());
  const token = {};
  _releasing.set(path, token);
  return settled.then(() => {
    if (_releasing.get(path) !== token || _held.get(path) !== lock) return false;
    _releasing.delete(path);
    return drop();
  });
}

/**
 * Give up this process's claim on `id`. Every write admitted under it is
 * cancelled first, and a rename already in progress lands while the lock is
 * still held: the release finishes when that rename does, never by waiting
 * on the thread. Resolves true once the lock is gone, false when this process
 * held none (or took it up again before it went).
 */
export function releaseSessionWriter(id) {
  let path;
  try {
    path = _claimPath(id);
  } catch {
    return Promise.resolve(false);
  }
  return _letGo(id, path, { cancel: true });
}

// A claim this very call took and admitted nothing under: no write to cancel
// (another tenure's, or a parked snapshot's guard, is not this claim's).
function _giveBackFreshClaim(id) {
  void _letGo(id, _claimPath(id), { cancel: false });
}

function _rememberTenureEnd(id, barrier) {
  try {
    const target = sessionPath(id);
    _endedTenures.set(target, { stamp: statSessionStamp(target), barrier });
  } catch {
    /* no record to remember: a later save of an old copy is judged strictly */
  }
}

/** A resume or turn read `id` again as its writer: that read is the base of
 *  every copy it hands out, so the provenance of the earlier tenure goes. */
export function sessionWriterReopened(id) {
  _endedTenures.delete(sessionPath(id));
}

/**
 * Idle unload: this process stops writing `id` while the session is idle
 * here, so another process may open it. The caller (store.mjs) makes sure no
 * write of it is outstanding and drops its in-memory copy; the next resume,
 * turn or save takes the claim again — a save only while the record is still
 * the one this process let go, else it is refused as changed elsewhere.
 * Null when it is not held here, else releaseSessionWriter's promise.
 */
export function releaseIdleSessionWriterClaim(id) {
  if (!sessionWriterHeldHere(id)) return null;
  _rememberTenureEnd(id, false);
  return releaseSessionWriter(id);
}

/** Delete: the lock goes, and so does its file (no id is ever reused). A
 *  process that locked the file just before the unlink finds it not intact. */
export function forgetSessionWriter(id) {
  const path = _claimPath(id);
  _endedTenures.delete(sessionPath(id));
  const unlink = () => {
    try {
      unlinkSync(path);
    } catch {
      /* absent, or still open in a process acquiring it: it stays */
    }
  };
  if (!_held.has(path)) {
    unlink();
    return Promise.resolve(false);
  }
  return _letGo(id, path, { cancel: true, after: unlink });
}

/** Process exit: every claim this process holds (the kernel would anyway). */
export function releaseHeldSessionWriters() {
  const paths = [..._held.keys()];
  for (const [path, lock] of _held) _dropLock(path, lock);
  _held.clear();
  _releasing.clear();
  for (const path of paths) _emitHeld(basename(path, '.lock'), false);
}

/**
 * Whether another process holds `id`'s claim, asked of the lock itself (taken
 * and given back at once when free). The save worker realm answers false: it
 * only ever writes what its parent admitted as the session's writer, and the
 * parent cancels those writes before it lets the session go.
 */
export function sessionWriterHeldElsewhere(id) {
  if (!isMainThread) return false;
  const path = _claimPath(id);
  if (_held.get(path)?.intact()) return false;
  const probe = _acquire(path);
  if (!probe.held) return true;
  _dropLock(path, probe);
  return false;
}

/** The load cache records the stamp of the record each document was parsed from. */
export function rememberSessionBaseStamp(doc, stamp) {
  if (doc && typeof doc === 'object' && stamp) _baseStamps.set(doc, stamp);
}

/** A landed close/detach barrier ends this process's tenure: the claim goes,
 *  and the record the barrier left is remembered as this process's own. */
export function releaseSessionWriterAfterBarrier(id) {
  _rememberTenureEnd(id, true);
  void releaseSessionWriter(id);
}

// How a claim just taken at a save relates to the record that save replaces:
// 'current' — nothing there, exactly the record the copy was parsed from,
//   this process's own commit, the record as this process let it go idle, or
//   a copy built here for a session this process never let go: it writes and
//   keeps the claim;
// 'released' — the record this process's own close/detach left (a late save
//   of a copy it already let go) or an unreadable file: written by nobody,
//   the save ends as a dropped no-op (only a resume or turn opens it again);
// 'stale' — another writer replaced the record after this copy was read, or
//   after this process let the session go.
function _freshClaimBase(id, session) {
  const target = sessionPath(id);
  let current;
  try {
    current = statSessionStamp(target);
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'current' : 'released';
  }
  const base = _baseStamps.get(session);
  if ((base && sameSessionStamp(base, current)) || ownCommittedLifecycle(target, current)) return 'current';
  const ended = _endedTenures.get(target);
  if (ended && sameSessionStamp(ended.stamp, current)) return ended.barrier ? 'released' : 'current';
  // A copy not parsed from a record (built in this process) has no read to be
  // stale against, unless this process let the session go since.
  if (!base && !ended) return 'current';
  const record = readCanonicalSessionRecord(target, true, { ownCommitsOnly: true });
  // A file holding no data is no record (see the load cache).
  if (record === null) return 'current';
  return record === CANONICAL_RECORD_UNREADABLE ? 'released' : 'stale';
}

/**
 * Save pre-admission: null when this process may write `session` — it then
 * holds the claim — else the refusal `{ id, reason, path? }`. A claim this
 * call took for a copy that may not keep it is given back, so a later fresh
 * load can take it.
 */
export function sessionWriterRefusal(session) {
  const id = session?.id;
  if (!id) return null;
  let claim;
  try {
    claim = claimSessionWriter(id);
  } catch (error) {
    return { id, reason: 'unclaimable', cause: error };
  }
  if (!claim.held) return { id, reason: 'claimed', path: claim.path };
  if (!claim.fresh) return null;
  const base = _freshClaimBase(id, session);
  if (base === 'current') return null;
  _giveBackFreshClaim(id);
  return { id, reason: base === 'stale' ? 'changed' : 'released' };
}

const REFUSAL_CODES = { claimed: 'ESESSIONCLAIMED', changed: 'ESESSIONCHANGED', unclaimable: 'ESESSIONUNCLAIMABLE' };

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

/** A refused save: reported on stderr and recorded as the id's save failure
 *  (desktop notice, getSessionSaveError), never a silent drop. A late save of
 *  a copy this process already let go ('released') writes nothing and ends
 *  as a dropped save, as the write admission drops a stale one: null. */
export function refuseSessionWrite(refusal) {
  if (refusal.reason === 'released') {
    _recordSaveDrop(refusal.id);
    return null;
  }
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
