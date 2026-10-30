// manager/turn-checkpoint-recovery.mjs
// Durable recovery of a turn interrupted by a process restart: an interrupted
// turn checkpoint is committed as interrupted on resume. Every session runs in
// the daemon, so a turn is live while this process runs it or while another
// live process owns the daemon; reads never recover a live turn.
import { join } from 'node:path';
import { readSingletonOwner } from '../../../../shared/singleton-owner.mjs';
import { loadSession, saveSession } from '../store.mjs';
import { dataDir } from '../store-summary-locations.mjs';
import { runtimeState, isTurnInFlight } from './runtime-state.mjs';
import {
  checkpointDisposition,
  clearTurnCheckpoint,
  readTurnCheckpoint,
  recoverTurnCheckpoint,
  reportCheckpointConflict,
} from './turn-checkpoint.mjs';
import {
  finishPendingSetAside,
  listUnrecoveredTurnCheckpoints,
  removeUnrecoveredTurnCheckpoint,
  setAsideTurnCheckpoint,
} from './turn-checkpoint-journal.mjs';
import { readDurableSessionRecord } from '../store/transcript-durability.mjs';
import { hasUnsettledTurn, TurnPersistenceError, turnCoveredOnDisk } from './turn-durability.mjs';

// ── Checkpoints recovery cannot apply ───────────────────────────────────────
// A conflicting checkpoint (or one whose header cannot be read) is never
// deleted and never overwritten by the next turn: it is set aside
// (setAsideTurnCheckpoint) before that turn opens its own, listed on the
// session as `unrecoveredTurns` for the read-only view, re-reported by every
// recovery, and deleted only when the durable record carries its coverage.

/** Set aside whatever checkpoint of `sessionId` is still in place, unless
 *  `session`'s last landed save covers it (then it is deleted). Throws
 *  TurnPersistenceError when it cannot be moved, so no new checkpoint is
 *  written over it. */
export function setAsideUnrecoveredCheckpoint(session, sessionId) {
  const refused = (error) =>
    new TurnPersistenceError(
      sessionId,
      'an unrecovered turn checkpoint could not be set aside, so the next turn cannot start',
      error
    );
  // An interrupted move first: until it is finished nothing below may run.
  const unfinished = finishPendingSetAside(sessionId);
  if (unfinished.pending) throw refused(null);
  let moved = unfinished.key !== null;
  const checkpoint = readTurnCheckpoint(sessionId);
  if (checkpoint && turnCoveredOnDisk(session, checkpoint.turnToken)) {
    clearTurnCheckpoint(sessionId, checkpoint.turnToken);
  } else {
    try {
      if (setAsideTurnCheckpoint(sessionId) !== null) moved = true;
    } catch (error) {
      throw refused(error);
    }
  }
  if (moved) listUnrecoveredTurns(session, sessionId);
}

/** Re-read the set-aside checkpoints of `sessionId`: delete those the durable
 *  record covers, report the rest and list them on `session`. */
function listUnrecoveredTurns(session, sessionId, durableRecord = undefined) {
  const entries = listUnrecoveredTurnCheckpoints(sessionId);
  let durable = durableRecord;
  const kept = [];
  for (const { key, checkpoint, pending } of entries) {
    if (durable === undefined) durable = readDurableSessionRecord(sessionId);
    const disposition = checkpoint
      ? checkpointDisposition(durable, checkpoint)
      : {
          action: 'conflict',
          reason: pending ? 'its set-aside is not finished yet' : 'the checkpoint header is unreadable',
        };
    if (disposition.action === 'covered') {
      removeUnrecoveredTurnCheckpoint(sessionId, key);
      continue;
    }
    const reason = disposition.reason || 'set aside before a later turn';
    reportCheckpointConflict(sessionId, checkpoint ?? { turnToken: key }, reason);
    kept.push({
      key,
      turnToken: checkpoint?.turnToken ?? null,
      startedAt: checkpoint?.startedAt ?? null,
      reason,
    });
  }
  if (kept.length) session.unrecoveredTurns = kept;
  else delete session.unrecoveredTurns;
}

/** Whether this session's turn may still be running — in flight in this
 *  process, or owned by another live process holding the daemon record — or
 *  is finished here but not yet durable (its checkpoint is projected, never
 *  recovered). */
export function isSessionTurnLive(sessionId) {
  if (isTurnInFlight(runtimeState.get(sessionId)) || hasUnsettledTurn(sessionId)) return true;
  const { owner, alive } = readSingletonOwner(join(dataDir(), 'daemon-owner.json'));
  return alive && Number(owner.pid) !== process.pid;
}

/** `durable`: the canonical record as just read from disk, when the caller
 *  holds it; otherwise it is read here. */
export function _recoverTurnCheckpointDurably(session, sessionId, durable = undefined) {
  // A turn this process finished but has not saved yet is in memory, not
  // lost: its own save gate settles it.
  if (hasUnsettledTurn(sessionId)) return { changed: false, recovered: false, turnToken: null };
  const recovery = recoverTurnCheckpoint(session, durable);
  // The record on disk already carries the turn: only the checkpoint goes.
  if (recovery.covered) clearTurnCheckpoint(sessionId, recovery.turnToken);
  if (recovery.conflict) {
    try {
      setAsideUnrecoveredCheckpoint(session, sessionId);
    } catch {
      // Still in place (or half-moved, which no reader replays): the next
      // turn's guard retries before it may write a checkpoint.
      listUnrecoveredTurns(session, sessionId, durable);
    }
  } else listUnrecoveredTurns(session, sessionId, durable);
  if (!recovery.changed) return recovery;
  // Recovery is a durable reconnect boundary, not a renderer-only view.
  // Persist (with the turn's coverage) before removing the checkpoint so a
  // second crash leaves at least one complete copy of the interrupted turn
  // and never replays it twice.
  saveSession(session, {
    sync: true,
    expectedGeneration: session.generation,
  });
  if (recovery.turnToken && turnCoveredOnDisk(session, recovery.turnToken)) {
    clearTurnCheckpoint(sessionId, recovery.turnToken);
  }
  return recovery;
}

// Reconnect-safe historical read used by desktop pane peeks. Unlike a normal
// read-only load, it resolves a dead owner's durable turn checkpoint before
// returning the transcript; a live turn is returned untouched.
export function recoverSessionAfterProcessRestart(sessionId, durable = undefined) {
  const session = loadSession(sessionId);
  if (!session || session.closed === true || isSessionTurnLive(sessionId)) return session || null;
  _recoverTurnCheckpointDurably(session, sessionId, durable);
  return session;
}
