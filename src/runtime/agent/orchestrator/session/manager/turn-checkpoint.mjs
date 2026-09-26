import { unlinkSync } from 'node:fs';
import { finalizeTurnInterruptionSnapshot } from './turn-interruption.mjs';
import {
  appendJournalLines,
  cancelJournalWrites,
  createTurnJournalEncoder,
  emptyInterruptionSnapshot,
  findTurnStart,
  openJournalForTurn,
  readTurnCheckpointHeader,
  readTurnCheckpointHeaderState,
  removeTurnJournal,
  replayTurnJournal,
  settleTurnJournalWrites,
  turnCheckpointPath,
  turnCheckpointReadPath,
  turnMessagesForCheckpoint,
  writeCheckpointHeader,
} from './turn-checkpoint-journal.mjs';
import { captureTurnCheckpointContextState, restoreTurnCheckpointContextState } from './turn-checkpoint-context.mjs';

export { turnCheckpointPath, turnMessagesForCheckpoint };
export { captureTurnCheckpointContextState, restoreTurnCheckpointContextState };

/** Resolve once every queued journal append for a session has been written. */
export const settleTurnCheckpointWrites = settleTurnJournalWrites;

/** Whether `checkpoint` describes this session's current turn: same
 *  generation, and either the session's active-turn marker names it or (with
 *  no marker) it is newer than the session record. */
function checkpointAppliesTo(session, checkpoint) {
  const sessionGeneration = Number(session.generation) || 0;
  const checkpointGeneration = Number(checkpoint.generation) || 0;
  const markerToken =
    typeof session.activeTurnCheckpoint?.turnToken === 'string' ? session.activeTurnCheckpoint.turnToken : null;
  const markerMatches = markerToken === checkpoint.turnToken;
  const checkpointIsNewer = Number(checkpoint.updatedAt) > Number(session.updatedAt || 0);
  return !(
    checkpointGeneration !== sessionGeneration ||
    (markerToken && !markerMatches) ||
    (!markerToken && !checkpointIsNewer)
  );
}

/** Read-only projection for a turn still owned by another process. Unlike
 * recoverTurnCheckpoint this never mutates the session, clears the checkpoint,
 * or marks a live turn as interrupted. */
export function projectTurnCheckpointMessages(session, checkpoint) {
  const source = Array.isArray(session?.messages) ? session.messages : [];
  if (!session?.id || checkpoint?.sessionId !== session.id || !Array.isArray(checkpoint?.turnMessages)) return source;
  if (!checkpointAppliesTo(session, checkpoint)) return source;
  if (checkpoint.fullTranscript === true) {
    return checkpoint.turnMessages.slice();
  }
  const start = findTurnStart(source, checkpoint.currentUserContent);
  return [...(start >= 0 ? source.slice(0, start) : source), ...checkpoint.turnMessages];
}

// ── Journal-backed checkpoint writes ─────────────────────────────────────────
// A turn is checkpointed as a write-once header plus an append-only delta
// journal (turn-checkpoint-journal.mjs). The recorder owns exactly one turn:
// the FIRST record() writes the header synchronously — it is the crash
// durability anchor for the prompt and must land before the provider runs —
// and every later record() appends ONLY what changed since the previous flush.
// Per-flush cost is therefore O(new bytes), not O(whole growing turn), so a
// long tool-heavy turn no longer amplifies into the shared engine thread that
// every fanned-out agent session shares.
export function createTurnCheckpointRecorder({ sessionId, generation, turnToken, startedAt }) {
  const encoder = createTurnJournalEncoder({ turnToken });
  let opened = false;
  let stopped = false;
  return {
    get opened() {
      return opened;
    },
    /** True when this call wrote or queued durable state. */
    record({ currentUserContent, turnOutgoing, interruption, contextState = null }) {
      if (stopped || !sessionId || !turnToken) return false;
      if (!opened) {
        const seed = encoder.seed(turnOutgoing, currentUserContent, interruption, contextState);
        writeCheckpointHeader({
          sessionId,
          generation,
          turnToken,
          startedAt,
          currentUserContent,
          turnMessages: seed.turnMessages,
          ...(seed.fullTranscript ? { fullTranscript: true } : {}),
          interruption:
            typeof interruption?.snapshot === 'function' ? interruption.snapshot() : emptyInterruptionSnapshot(),
          contextState: seed.contextState,
        });
        // Opening the journal is part of the anchor: a leftover journal
        // from an earlier turn of this session must never replay onto
        // the new header. It lands synchronously when the lane is idle
        // and is otherwise FENCED behind the older in-flight write, so
        // an old turn can never appear beneath this turn's token (the
        // head record's token guards the interim window).
        openJournalForTurn(sessionId, seed.openLines);
        opened = true;
        return true;
      }
      const lines = encoder.encode({
        turnOutgoing,
        currentUserContent,
        interruption,
        contextState,
      });
      if (lines.length === 0) return false;
      appendJournalLines(sessionId, lines);
      return true;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelPendingTurnCheckpoint(sessionId);
    },
  };
}

/** Retire queued (not yet written) journal appends for a session. The durable
 * prefix stays on disk on purpose: between turn commit and clearTurnCheckpoint
 * a crash must still recover the turn's work, not just its opening header. */
function cancelPendingTurnCheckpoint(sessionId) {
  cancelJournalWrites(sessionId);
}

export function readTurnCheckpoint(sessionId) {
  const header = readTurnCheckpointHeader(sessionId);
  if (!header) return null;
  return replayTurnJournal(header);
}

// The header stays a synchronous read + unlink: header writes are synchronous
// too, so the token check and the removal cannot interleave with a follow-up
// turn's new header. Only the journal removal (ordered by its write lane) and
// the directory probes left the event loop.
export function clearTurnCheckpoint(sessionId, turnToken = null) {
  const target = turnCheckpointReadPath(sessionId);
  // Queued appends are stale the moment the caller decides to clear this
  // turn's checkpoint; retire them BEFORE the token guard reads disk so a
  // lagging write can never resurrect state after the unlink.
  if (!turnToken) {
    cancelPendingTurnCheckpoint(sessionId);
    let removed = true;
    try {
      unlinkSync(target);
    } catch (error) {
      // A missing header is already cleared; still drop any orphan journal
      // (a late in-flight append can recreate it after a previous clear).
      if (error?.code !== 'ENOENT') removed = false;
    }
    removeTurnJournal(sessionId);
    return removed;
  }
  const current = readTurnCheckpointHeaderState(sessionId);
  if (!current.present) return true;
  // A token guard prevents an older turn's late terminal save from
  // deleting the checkpoint already created by its queued follow-up.
  if (current.header?.turnToken && current.header.turnToken !== turnToken) return false;
  cancelPendingTurnCheckpoint(sessionId);
  let removed = true;
  try {
    unlinkSync(target);
  } catch {
    removed = false;
  }
  removeTurnJournal(sessionId);
  return removed;
}

/**
 * Merge a force-killed turn checkpoint into a loaded session. The caller must
 * durably save the mutated session before clearing the returned token.
 */
export function recoverTurnCheckpoint(session) {
  if (!session?.id || session.closed === true) {
    return { changed: false, recovered: false, turnToken: null };
  }
  const checkpoint = readTurnCheckpoint(session.id);
  const marker = session.activeTurnCheckpoint;
  if (!checkpoint) {
    if (!marker) return { changed: false, recovered: false, turnToken: null };
    delete session.activeTurnCheckpoint;
    return { changed: true, recovered: false, turnToken: null };
  }

  if (!checkpointAppliesTo(session, checkpoint)) {
    clearTurnCheckpoint(session.id, checkpoint.turnToken);
    if (typeof marker?.turnToken === 'string' && marker.turnToken === checkpoint.turnToken) {
      delete session.activeTurnCheckpoint;
    }
    return { changed: false, recovered: false, turnToken: null };
  }

  const finalized = finalizeTurnInterruptionSnapshot({
    turnOutgoing: checkpoint.turnMessages,
    currentUserContent: checkpoint.currentUserContent,
    snapshot: checkpoint.interruption,
    abortReason: 'process-crash',
  });
  const current = Array.isArray(session.messages) ? session.messages : [];
  const start = findTurnStart(current, checkpoint.currentUserContent);
  const kept = start >= 0 ? current.slice(0, start) : current;
  session.messages = checkpoint.fullTranscript === true ? finalized.messages : [...kept, ...finalized.messages];
  // Re-anchor provider usage / post-compact replacement state to the exact
  // canonical checkpoint representation. If a legacy or corrupted checkpoint
  // cannot prove alignment, retain the last provider reading for display but
  // mark it unanchored so the first resumed send cannot compact from a gross
  // whole-transcript estimate.
  const contextStateRestored = restoreTurnCheckpointContextState(session, checkpoint);
  delete session.activeTurnCheckpoint;
  delete session.providerState;
  delete session._providerPrefixGuardState;
  session.updatedAt = Date.now();
  session.lastUsedAt = Date.now();
  return {
    changed: true,
    recovered: true,
    turnToken: checkpoint.turnToken,
    responsePreserved: finalized.responsePreserved,
    contextStateRestored,
  };
}
