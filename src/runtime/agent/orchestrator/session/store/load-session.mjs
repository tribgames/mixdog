/**
 * Public session read: decides which copy of a session speaks for its id —
 * the validated disk record, a queued/in-flight write payload, the live
 * snapshot, or the evidence-backed failed-save snapshot. Nothing here writes;
 * the precedence rules are the whole responsibility.
 */
import { sessionPath } from './paths-heartbeat.mjs';
import { _savePending } from './pending-saves.mjs';
import { _liveSessions, _droppedSaveIds, getFailedSaveSnapshot } from './live-state.mjs';
import { _readStoredSessionCached } from './load-cache.mjs';
import { _ensureLifecycleFields } from './serialize.mjs';

export function loadSession(id) {
  const path = sessionPath(id);
  const pending = _savePending.get(id);
  const live = _liveSessions.get(id);
  const preferInMemory = (stored) => {
    // Read-your-writes: queued state is newer than the payload being written.
    const inMemory = (pending?.queued || pending?.payload)?.session;
    if (inMemory?.id === id) return inMemory;
    if (live?.id !== id) return null;
    // A higher disk generation means another process took ownership. A
    // dropped save is the exception: the live copy still contains unsaved
    // content, so a generation bump must not discard the only complete copy.
    const liveGen = typeof live.generation === 'number' ? live.generation : 0;
    const storedGen = stored && typeof stored.generation === 'number' ? stored.generation : 0;
    if (stored && storedGen > liveGen && !_droppedSaveIds.has(id)) return null;
    return live;
  };
  // An existing file owns this identity. Its contents must validate before
  // fresher in-memory state is allowed to shadow it. The cache retains a
  // validated disk header, rather than a second transcript, when that header
  // proves the live/pending snapshot will be served.
  const disk = _readStoredSessionCached(id, path, { preferInMemory });
  if (disk.exists && !disk.session) {
    // An existing-but-unreadable file OWNS the identity: an externally
    // corrupted, foreign, ambiguous or half-written file from another
    // writer is REPORTED (null), never masked by whatever this process
    // happens to hold in memory.
    //
    // Exactly ONE exception, and it is evidence-based rather than
    // state-based: the snapshot whose OWN write to this path failed in
    // this process (getFailedSaveSnapshot). That failure proves the bytes
    // never landed, so this copy is strictly newer than the file and is
    // the only good same-process copy — hiding it would turn a surfaced
    // save failure into silent session loss for every public reader.
    // A generic pending payload / _liveSessions entry proves nothing about
    // disk and may NOT stand in: unrelated corruption stays visible.
    // Lifecycle and pending-ownership authorities do not come through
    // here at all (they read the durable record directly), so they keep
    // seeing 'unreadable' and failing closed.
    const recovered = getFailedSaveSnapshot(id);
    if (recovered?.id === id) return _ensureLifecycleFields(recovered);
    return null;
  }
  const inMemory = preferInMemory(disk.session);
  if (inMemory) return _ensureLifecycleFields(inMemory);
  if (live?.id === id) _liveSessions.delete(id);
  return disk.session ? _ensureLifecycleFields(disk.session) : null;
}
