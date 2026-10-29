import { unlinkSync } from 'node:fs';
import { finalizeTurnInterruptionSnapshot } from './turn-interruption.mjs';
import {
  appendJournalLines,
  cancelJournalWrites,
  createTurnJournalEncoder,
  emptyInterruptionSnapshot,
  findTurnStart,
  listRetainedCheckpoints,
  openJournalForTurn,
  retainedCheckpointPath,
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
import { stripProviderReplayMessages } from './provider-replay.mjs';
import { sensitiveValuesVersion } from '../sensitive-values.mjs';
import { _hasPendingPersistence } from '../store/pending-saves.mjs';
import { hasSessionSaveFailure } from '../store/live-state.mjs';

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
  return projectTurnCheckpointChain(session, checkpoint ? [checkpoint] : []);
}

/** The same read-only projection over a session's retained turns and its
 *  current one (readTurnCheckpointChain). */
export function projectTurnCheckpointChain(session, chain) {
  const source = Array.isArray(session?.messages) ? session.messages : [];
  const applied = applicableChain(session, chain);
  return applied.length ? spliceTurns(source, applied, (checkpoint) => checkpoint.turnMessages) : source;
}

/** The chain entries recovery applies, oldest first: from the first one that
 *  describes this session's state on disk (checkpointAppliesTo) through the
 *  newest, skipping any of another generation. Retained turns before it are
 *  already covered by the record on disk. */
function applicableChain(session, chain) {
  if (!session?.id || !Array.isArray(chain)) return [];
  const own = chain.filter(
    (checkpoint) =>
      checkpoint?.sessionId === session.id &&
      Array.isArray(checkpoint.turnMessages) &&
      (Number(checkpoint.generation) || 0) === (Number(session.generation) || 0)
  );
  const from = own.findIndex((checkpoint) => checkpointAppliesTo(session, checkpoint));
  return from < 0 ? [] : own.slice(from);
}

/** Each turn replaces the record from its own prompt on (or the whole record,
 *  for a turn that compaction rewrote), oldest first: a turn already on disk
 *  is replaced once, never duplicated. */
function spliceTurns(source, chain, turnMessagesOf) {
  let messages = source;
  for (const checkpoint of chain) {
    const turnMessages = turnMessagesOf(checkpoint);
    if (checkpoint.fullTranscript === true) {
      messages = turnMessages.slice();
      continue;
    }
    const start = findTurnStart(messages, checkpoint.currentUserContent);
    messages = [...(start >= 0 ? messages.slice(0, start) : messages), ...turnMessages];
  }
  return messages;
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
  const encoder = createTurnJournalEncoder({ turnToken, sessionId });
  let opened = false;
  let stopped = false;
  // The sensitive-values version (sensitive-values.mjs) the header and
  // journal were written under. A newly marked value rewrites both from the
  // turn's current state with the value replaced, under a new journal epoch,
  // so no recovery record keeps it.
  let openedVersion = 0;
  return {
    get opened() {
      return opened;
    },
    /** True when this call wrote or queued durable state. */
    record({ currentUserContent, turnOutgoing, interruption, contextState = null }) {
      if (stopped || !sessionId || !turnToken) return false;
      const version = sensitiveValuesVersion(sessionId);
      if (!opened || version !== openedVersion) {
        const snapshot =
          typeof interruption?.snapshot === 'function' ? interruption.snapshot() : emptyInterruptionSnapshot();
        if (!opened) retainPreviousTurn({ sessionId, generation, turnToken, turnOutgoing, currentUserContent });
        const seed = encoder.seed(turnOutgoing, currentUserContent, interruption, contextState, {
          snapshot,
          epoch: version,
        });
        writeCheckpointHeader({
          sessionId,
          generation,
          turnToken,
          startedAt,
          currentUserContent,
          turnMessages: seed.turnMessages,
          ...(seed.fullTranscript ? { fullTranscript: true } : {}),
          ...(version ? { journalEpoch: version } : {}),
          interruption: snapshot,
          contextState: seed.contextState,
        });
        openedVersion = version;
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
      // Retire queued (not yet written) appends. The durable prefix stays on
      // disk on purpose: between turn commit and clearTurnCheckpoint a crash
      // must still recover the turn's work, not just its opening header.
      cancelJournalWrites(sessionId);
    },
  };
}

export function readTurnCheckpoint(sessionId) {
  const header = readTurnCheckpointHeader(sessionId);
  if (!header) return null;
  return replayTurnJournal(header);
}

// Sessions that may have retained checkpoints: retained by this process, or
// found on disk by a chain read. Clearing a turn consults the disk only for
// these, so the common turn end never lists the checkpoint directory.
const _retainedSessions = new Set();

/** The session's retained turns, oldest first, then its current turn. */
export function readTurnCheckpointChain(sessionId) {
  const retained = listRetainedCheckpoints(sessionId);
  if (retained.length) _retainedSessions.add(sessionId);
  const chain = retained.map((entry) => entry.header).filter(Boolean);
  const current = readTurnCheckpoint(sessionId);
  // A crash between retaining a turn and writing the next header leaves the
  // turn twice; the retained copy is the complete one.
  if (current && !chain.some((checkpoint) => checkpoint.turnToken === current.turnToken)) chain.push(current);
  return chain;
}

/**
 * A new turn's header replaces the session's current checkpoint. When that
 * checkpoint still exists, the save that covers its turn has not landed (a
 * landed save clears it), so the turn is kept as a retained checkpoint first.
 * A turn this process committed is taken from the new turn's history, which
 * holds it exactly as committed; one that is not in it (another process's
 * unrecovered turn) is kept as journaled. Either costs that turn's size once.
 */
function retainPreviousTurn({ sessionId, generation, turnToken, turnOutgoing, currentUserContent }) {
  const previous = readTurnCheckpoint(sessionId);
  if (!previous || previous.turnToken === turnToken) return;
  if ((Number(previous.generation) || 0) !== (Number(generation) || 0)) return;
  const source = Array.isArray(turnOutgoing) ? turnOutgoing : [];
  const opening = findTurnStart(source, currentUserContent);
  const history = opening >= 0 ? source.slice(0, opening) : source;
  const start = previous.fullTranscript === true ? 0 : findTurnStart(history, previous.currentUserContent);
  const retained =
    start >= 0
      ? {
          ...previous,
          turnMessages: history.slice(start),
          sealed: true,
          interruption: emptyInterruptionSnapshot(),
          contextState: null,
        }
      : previous;
  writeCheckpointHeader(retained, retainedCheckpointPath(sessionId, previous.startedAt));
  _retainedSessions.add(sessionId);
}

/** Remove retained checkpoints oldest first through `turnToken` (all of them
 *  for null). Returns whether `turnToken` was among them. */
function removeRetainedThrough(sessionId, turnToken, { listDisk = false } = {}) {
  if (!listDisk && !_retainedSessions.has(sessionId)) return false;
  const retained = listRetainedCheckpoints(sessionId);
  const index =
    turnToken === null ? retained.length - 1 : retained.findIndex((entry) => entry.header?.turnToken === turnToken);
  if (index < 0) return false;
  for (const { path } of retained.slice(0, index + 1)) {
    try {
      unlinkSync(path);
    } catch {
      /* already gone, or kept: a covered turn reapplies as itself */
    }
  }
  if (index === retained.length - 1) _retainedSessions.delete(sessionId);
  return true;
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
    removeRetainedThrough(sessionId, null, { listDisk: true });
    cancelJournalWrites(sessionId);
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
  // A landed save covers its turn and every turn before it: their retained
  // checkpoints go, oldest first.
  const retained = removeRetainedThrough(sessionId, turnToken);
  const current = readTurnCheckpointHeaderState(sessionId);
  if (!current.present) return true;
  // A token guard prevents an older turn's late terminal save from
  // deleting the checkpoint already created by its queued follow-up.
  if (current.header?.turnToken && current.header.turnToken !== turnToken) return retained;
  removeRetainedThrough(sessionId, null);
  cancelJournalWrites(sessionId);
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
  const chain = readTurnCheckpointChain(session.id);
  const marker = session.activeTurnCheckpoint;
  if (!chain.length) {
    if (!marker) return { changed: false, recovered: false, turnToken: null };
    delete session.activeTurnCheckpoint;
    return { changed: true, recovered: false, turnToken: null };
  }

  const applied = applicableChain(session, chain);
  if (!applied.length) {
    // A session held in this process may be ahead of its record on disk:
    // while a save of it is pending or failed, its checkpointed turns are not
    // stale but missing from disk, and stay until a landed save covers them
    // (the next turn retains them).
    if (_hasPendingPersistence(session.id) || hasSessionSaveFailure(session.id)) {
      return { changed: false, recovered: false, turnToken: null };
    }
    clearTurnCheckpoint(session.id, chain.at(-1).turnToken);
    if (typeof marker?.turnToken === 'string' && chain.some((entry) => entry.turnToken === marker.turnToken)) {
      delete session.activeTurnCheckpoint;
    }
    return { changed: false, recovered: false, turnToken: null };
  }

  // Retained turns were committed: they return exactly as committed. Only an
  // unfinished turn is finalized as interrupted by the crash.
  const checkpoint = applied.at(-1);
  let finalized = { responsePreserved: false };
  session.messages = spliceTurns(Array.isArray(session.messages) ? session.messages : [], applied, (entry) => {
    if (entry.sealed === true) return entry.turnMessages;
    finalized = finalizeTurnInterruptionSnapshot({
      turnOutgoing: entry.turnMessages,
      currentUserContent: entry.currentUserContent,
      snapshot: entry.interruption,
      abortReason: 'process-crash',
    });
    // The route switched models mid-turn (the marker says so) and the journal
    // may predate the switch: its turn still carries the previous provider's
    // native replay state, which the saved route's provider must not receive.
    return marker?.routeChanged === true ? stripProviderReplayMessages(finalized.messages) : finalized.messages;
  });
  // Re-anchor provider usage / post-compact replacement state to the exact
  // canonical checkpoint representation. If a legacy or corrupted checkpoint
  // cannot prove alignment, retain the last provider reading for display but
  // mark it unanchored so the first resumed send cannot compact from a gross
  // whole-transcript estimate.
  const contextStateRestored = restoreTurnCheckpointContextState(session, checkpoint);
  // Diagnostic only (anthropic-prefix-trace.mjs): the turn's last settled
  // request, whatever the context reading's alignment.
  if (checkpoint.contextState?.prefixBaseline) session.providerPrefixBaseline = checkpoint.contextState.prefixBaseline;
  delete session.activeTurnCheckpoint;
  delete session.providerState;
  delete session._providerPrefixGuardState;
  session.updatedAt = Date.now();
  session.lastUsedAt = Date.now();
  return {
    changed: true,
    recovered: true,
    // Clearing the newest turn clears every retained one before it.
    turnToken: chain.at(-1).turnToken,
    responsePreserved: finalized.responsePreserved,
    contextStateRestored,
  };
}
