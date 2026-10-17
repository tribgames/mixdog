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
import { clearTurnCheckpoint, recoverTurnCheckpoint } from './turn-checkpoint.mjs';

/** Whether this session's turn may still be running: in flight in this
 *  process, or owned by another live process holding the daemon record. */
export function isSessionTurnLive(sessionId) {
  if (isTurnInFlight(runtimeState.get(sessionId))) return true;
  const { owner, alive } = readSingletonOwner(join(dataDir(), 'daemon-owner.json'));
  return alive && Number(owner.pid) !== process.pid;
}

export function _recoverTurnCheckpointDurably(session, sessionId) {
  const recovery = recoverTurnCheckpoint(session);
  if (!recovery.changed) return recovery;
  // Recovery is a durable reconnect boundary, not a renderer-only view.
  // Persist before removing the checkpoint so a second crash leaves at
  // least one complete copy of the interrupted turn.
  saveSession(session, {
    sync: true,
    expectedGeneration: session.generation,
  });
  if (recovery.turnToken) {
    clearTurnCheckpoint(sessionId, recovery.turnToken);
  }
  return recovery;
}

// Reconnect-safe historical read used by desktop pane peeks. Unlike a normal
// read-only load, it resolves a dead owner's durable turn checkpoint before
// returning the transcript; a live turn is returned untouched.
export function recoverSessionAfterProcessRestart(sessionId) {
  const session = loadSession(sessionId);
  if (!session || session.closed === true || isSessionTurnLive(sessionId)) return session || null;
  _recoverTurnCheckpointDurably(session, sessionId);
  return session;
}
