import { unlinkSync } from 'node:fs';
import { finalizeTurnInterruptionSnapshot } from './turn-interruption.mjs';
import {
  appendJournalLines,
  cancelJournalWrites,
  createTurnJournalEncoder,
  emptyInterruptionSnapshot,
  finishPendingSetAside,
  openJournalForTurn,
  readTurnCheckpointHeader,
  readTurnCheckpointHeaderState,
  removeTurnJournal,
  replayTurnJournal,
  settleTurnJournalWrites,
  turnCheckpointPath,
  turnCheckpointReadPath,
  writeCheckpointHeader,
} from './turn-checkpoint-journal.mjs';
import { captureTurnCheckpointContextState, restoreTurnCheckpointContextState } from './turn-checkpoint-context.mjs';
import { stripProviderReplayMessages } from './provider-replay.mjs';
import { sensitiveValuesVersion } from '../sensitive-values.mjs';
import { contextMessagesSignature } from '../context-utils.mjs';
import { mintTranscriptEpoch, readDurableSessionRecord } from '../store/transcript-durability.mjs';

export { turnCheckpointPath };
export { captureTurnCheckpointContextState, restoreTurnCheckpointContextState };

/** Resolve once every queued journal append for a session has been written. */
export const settleTurnCheckpointWrites = settleTurnJournalWrites;

// ── What a checkpoint means against the durable record ──────────────────────
// A checkpoint names the base it was taken against: `base` (the transcript
// epoch and length of the landed record the turn opened on) and `boundary`
// (how many of that record's messages precede the turn). A self-contained
// checkpoint (`fullTranscript`) carries the whole context instead. Every
// history rewrite in this process mints a new transcript epoch before a
// record carries it, and only the base or a later save of the turn can be
// on disk after the turn opened (store/transcript-durability.mjs), so:
//   covered   the record carries the finished turn's coverage token: nothing
//             to replay, the checkpoint only awaits deletion;
//   replay    the record is of the base epoch and holds the base prefix (the
//             base itself, a pre-open save of it, or a save of this same
//             active turn), or — for a self-contained checkpoint — is this
//             same active turn's save on any epoch;
//   conflict  anything else. The checkpoint is kept and reported, never
//             spliced onto a record it was not taken against.
// A legacy checkpoint (written before checkpoints named their base: no
// `boundary`) replays only when the record is exactly the prefix the turn
// recorded in its context state (count and exact-content signature), or a
// save of that same turn holding that prefix; otherwise it is a conflict.

/** `{ action: 'covered' | 'replay' | 'conflict', reason?, boundary? }` for
 *  `checkpoint` against the canonical record `durable` (as it is on disk);
 *  `boundary` is how many of the record's messages a replay keeps. */
export function checkpointDisposition(durable, checkpoint) {
  if (!durable || !Array.isArray(durable.messages)) {
    return { action: 'conflict', reason: 'the session has no durable record' };
  }
  if (typeof checkpoint?.turnToken === 'string' && durable.turnCoverage === checkpoint.turnToken) {
    return { action: 'covered' };
  }
  if (checkpoint && !Object.hasOwn(checkpoint, 'boundary')) return legacyDisposition(durable, checkpoint);
  const base = checkpoint?.base;
  const baseEpoch = typeof base?.epoch === 'string' && base.epoch ? base.epoch : null;
  const sameTurn = durable.activeTurnCheckpoint?.turnToken === checkpoint?.turnToken;
  const onBaseEpoch = baseEpoch !== null && durable.transcriptEpoch === baseEpoch;
  if (checkpoint?.fullTranscript === true) {
    if (onBaseEpoch || sameTurn) return { action: 'replay' };
    return { action: 'conflict', reason: 'the record is neither the base nor a save of this turn' };
  }
  const boundary = checkpoint?.boundary;
  if (!baseEpoch || !Number.isInteger(boundary) || boundary < 0 || boundary > Number(base.length)) {
    return { action: 'conflict', reason: 'the checkpoint names no base revision' };
  }
  if (onBaseEpoch && durable.messages.length >= boundary) return { action: 'replay', boundary };
  return { action: 'conflict', reason: 'the record is not of the base the checkpoint was taken against' };
}

function legacyDisposition(durable, checkpoint) {
  const conflict = (reason) => ({ action: 'conflict', reason: `legacy checkpoint: ${reason}` });
  if ((Number(checkpoint.generation) || 0) !== (Number(durable.generation) || 0)) {
    return conflict('the record is of another lifecycle generation');
  }
  const marker = durable.activeTurnCheckpoint?.turnToken;
  if (typeof marker === 'string' && marker !== checkpoint.turnToken) {
    return conflict('the record names another active turn');
  }
  if (checkpoint.fullTranscript === true) return conflict('a self-contained checkpoint names no base');
  const state = checkpoint.contextState;
  const count = state?.committedPrefixCount;
  if (!Number.isInteger(count) || count < 0 || typeof state.committedPrefixSignature !== 'string') {
    return conflict('the checkpoint records no prefix');
  }
  if (
    durable.messages.length < count ||
    contextMessagesSignature(durable.messages, count) !== state.committedPrefixSignature
  ) {
    return conflict('the record does not hold the prefix the turn opened on');
  }
  if (durable.messages.length !== count && marker !== checkpoint.turnToken) {
    return conflict('the record holds more than the prefix the turn opened on');
  }
  return { action: 'replay', boundary: count };
}

/** The messages `checkpoint` contributes (finalized as interrupted unless it
 *  was sealed) and the transcript they make on `durable`, keeping its first
 *  `boundary` messages. */
function replayCheckpoint(durable, checkpoint, boundary, routeChanged) {
  const finalized =
    checkpoint.sealed === true
      ? { messages: checkpoint.turnMessages.slice(), responsePreserved: true }
      : finalizeTurnInterruptionSnapshot({
          turnOutgoing: checkpoint.turnMessages,
          currentUserContent: checkpoint.currentUserContent,
          snapshot: checkpoint.interruption,
          abortReason: 'process-crash',
        });
  // The route switched models mid-turn and the journal may predate the
  // switch: its turn still carries the previous provider's native replay
  // state, which the saved route's provider must not receive.
  const turnMessages = routeChanged ? stripProviderReplayMessages(finalized.messages) : finalized.messages;
  const messages =
    checkpoint.fullTranscript === true
      ? turnMessages
      : [...durable.messages.slice(0, boundary), ...turnMessages];
  return { messages, responsePreserved: finalized.responsePreserved };
}

const _reportedConflicts = new Set();

export function reportCheckpointConflict(sessionId, checkpoint, reason) {
  const key = `${sessionId}:${checkpoint?.turnToken}`;
  if (_reportedConflicts.has(key)) return;
  _reportedConflicts.add(key);
  try {
    process.stderr.write(
      `[turn-checkpoint] kept unrecovered checkpoint session=${sessionId} turn=${checkpoint?.turnToken}: ${reason}\n`
    );
  } catch {
    /* stderr best-effort */
  }
}

/** Read-only projection for a turn still owned by another process (or not
 *  yet durable in this one). Unlike recoverTurnCheckpoint this never mutates
 *  the session, clears the checkpoint, or marks a live turn as interrupted.
 *  `session` is read as the durable record. */
export function projectTurnCheckpointMessages(session, checkpoint) {
  const source = Array.isArray(session?.messages) ? session.messages : [];
  if (!session?.id || checkpoint?.sessionId !== session.id || !Array.isArray(checkpoint?.turnMessages)) return source;
  const disposition = checkpointDisposition(session, checkpoint);
  if (disposition.action !== 'replay') return source;
  if (checkpoint.fullTranscript === true) return checkpoint.turnMessages.slice();
  return [...source.slice(0, disposition.boundary), ...checkpoint.turnMessages];
}

// ── Journal-backed checkpoint writes ─────────────────────────────────────────
// A turn is checkpointed as a header plus an append-only delta journal
// (turn-checkpoint-journal.mjs). The recorder owns exactly one turn: the FIRST
// record() writes the header synchronously — it is the crash durability
// anchor for the prompt and must land before the provider runs — and every
// later record() appends ONLY what changed since the previous flush. Per-flush
// cost is therefore O(new bytes), not O(whole growing turn).
//
// The header names its base explicitly: the turn opens at `boundary` (the
// index of its user message) on the durable landed transcript `base`
// (`{ epoch, refs }`, store/transcript-durability.mjs). When the messages
// before the boundary are not exactly the base's, or a later flush finds any
// of them replaced (compaction, a prefix rewrite), the header is rewritten as
// ONE self-contained replacement of the whole context under a new transcript
// epoch — atomically, before any session record can carry that epoch — and
// the journal restarts under it. A bare index move is never journaled.
export function createTurnCheckpointRecorder({ session = null, sessionId, generation, turnToken, startedAt, base = null }) {
  const encoder = createTurnJournalEncoder({ turnToken, sessionId });
  let opened = false;
  let stopped = false;
  // The sensitive-values version (sensitive-values.mjs) the header and
  // journal were written under. A newly marked value rewrites both from the
  // turn's current state with the value replaced, so no recovery record
  // keeps it.
  let openedVersion = 0;
  let headerWrites = 0;
  // Frame: the header holds turnOutgoing[offset..] (offset 0 when
  // self-contained); `pinned` are the messages before the turn's own region,
  // any replacement of which is a history rewrite.
  let fullTranscript = false;
  let offset = 0;
  let pinned = [];
  let openingIndex = -1;
  let openingRef = null;
  let transcriptEpoch = null;
  let contextState = null;

  const adoptEpoch = (epoch) => {
    transcriptEpoch = epoch;
    if (session) session.transcriptEpoch = epoch;
  };
  const opensOnBase = (source, boundary) => {
    if (!base || typeof base.epoch !== 'string' || !Array.isArray(base.refs)) return false;
    if (session && session.transcriptEpoch !== base.epoch) return false;
    if (boundary > base.refs.length) return false;
    for (let index = 0; index < boundary; index += 1) if (source[index] !== base.refs[index]) return false;
    return true;
  };
  const pinnedIntact = (source) => {
    if (source.length < pinned.length) return false;
    for (let index = 0; index < pinned.length; index += 1) if (source[index] !== pinned[index]) return false;
    return true;
  };
  const trackOpening = (source) => {
    openingRef = openingIndex >= 0 ? (source[openingIndex] ?? null) : null;
  };
  const writeHeader = ({ source, currentUserContent, interruption, captureContext, sealed }) => {
    const snapshot =
      typeof interruption?.snapshot === 'function' ? interruption.snapshot() : emptyInterruptionSnapshot();
    if (typeof captureContext === 'function') contextState = captureContext(offset);
    headerWrites += 1;
    const seed = encoder.seed(source, interruption, contextState, { offset, snapshot, epoch: headerWrites });
    writeCheckpointHeader({
      sessionId,
      generation,
      turnToken,
      startedAt,
      currentUserContent,
      base: base ? { epoch: base.epoch, length: base.refs.length } : null,
      boundary: offset,
      transcriptEpoch,
      ...(fullTranscript ? { fullTranscript: true } : {}),
      ...(sealed ? { sealed: true } : {}),
      journalEpoch: headerWrites,
      turnMessages: seed.turnMessages,
      interruption: snapshot,
      contextState: seed.contextState,
    });
    // Opening the journal is part of the anchor: a leftover journal (an
    // earlier turn's, or this turn's under its previous header) must never
    // replay onto the new header. It lands synchronously when the lane is
    // idle and is otherwise FENCED behind the older in-flight write; the
    // head record's token and journal epoch guard the interim window.
    openJournalForTurn(sessionId, seed.openLines);
    trackOpening(source);
    return true;
  };
  return {
    get opened() {
      return opened;
    },
    /** True when this call wrote or queued durable state. `boundary` is the
     *  index of the turn's user message in `turnOutgoing` (read when the
     *  checkpoint opens); `captureContext(boundary)` reads the context state
     *  aligned with the header's split, re-read when `contextDirty`;
     *  `sealed` records the turn as finished. */
    record({
      boundary,
      currentUserContent,
      turnOutgoing,
      interruption,
      captureContext = null,
      contextDirty = false,
      sealed = false,
    }) {
      if (stopped || !sessionId || !turnToken) return false;
      const source = Array.isArray(turnOutgoing) ? turnOutgoing : [];
      const version = sensitiveValuesVersion(sessionId);
      const header = { source, currentUserContent, interruption, captureContext, sealed };
      if (!opened) {
        const at = Number.isInteger(boundary) && boundary >= 0 && boundary <= source.length ? boundary : source.length;
        if (opensOnBase(source, at)) {
          fullTranscript = false;
          offset = at;
          transcriptEpoch = base.epoch;
        } else {
          fullTranscript = true;
          offset = 0;
          adoptEpoch(mintTranscriptEpoch());
        }
        pinned = source.slice(0, at);
        openingIndex = at < source.length ? at : -1;
        openedVersion = version;
        opened = true;
        return writeHeader(header);
      }
      if (!pinnedIntact(source)) {
        // A history rewrite. The turn's own opening message, found by
        // identity, bounds the new pinned prefix; without it every message
        // present now is pinned.
        const at = openingRef ? source.indexOf(openingRef) : -1;
        fullTranscript = true;
        offset = 0;
        adoptEpoch(mintTranscriptEpoch());
        pinned = source.slice(0, at >= 0 ? at : source.length);
        openingIndex = at;
        openedVersion = version;
        return writeHeader(header);
      }
      if (version !== openedVersion) {
        openedVersion = version;
        return writeHeader(header);
      }
      if (contextDirty && typeof captureContext === 'function') contextState = captureContext(offset);
      const lines = encoder.encode({ turnOutgoing: source, interruption, contextState, sealed });
      trackOpening(source);
      if (lines.length === 0) return false;
      appendJournalLines(sessionId, lines, { immediate: sealed });
      return true;
    },
    /** `keepQueued`: the turn was sealed, so its queued appends still land. */
    stop({ keepQueued = false } = {}) {
      if (stopped) return;
      stopped = true;
      // Retire queued (not yet written) appends. The durable prefix stays on
      // disk on purpose: until a save covering the turn lands a crash must
      // still recover the turn's work, not just its opening header.
      if (!keepQueued) cancelJournalWrites(sessionId);
    },
  };
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
  // The files of a set-aside still being moved are not this checkpoint's to
  // clear (turn-checkpoint-journal.mjs): it is finished first, or kept.
  if (finishPendingSetAside(sessionId).pending) return false;
  // Queued appends are stale the moment the caller decides to clear this
  // turn's checkpoint; retire them BEFORE the token guard reads disk so a
  // lagging write can never resurrect state after the unlink.
  if (!turnToken) {
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
  const current = readTurnCheckpointHeaderState(sessionId);
  if (!current.present) return true;
  // A token guard prevents an older turn's late terminal save from
  // deleting the checkpoint already created by its queued follow-up.
  if (current.header?.turnToken && current.header.turnToken !== turnToken) return false;
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
 * Merge a force-killed turn checkpoint into a loaded session, deciding from
 * the canonical record `durable` as it is on disk (checkpointDisposition) —
 * never from the in-memory session's freshness. Returns `covered` when that
 * record already carries the turn (the caller deletes the checkpoint) and
 * `conflict` when the checkpoint was not taken against it (kept, reported).
 * A recovered session carries the turn's coverage token; the caller must
 * durably save it before clearing the returned token.
 */
export function recoverTurnCheckpoint(session, durableRecord = undefined) {
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

  const durable = durableRecord === undefined ? readDurableSessionRecord(session.id) : durableRecord;
  const disposition = checkpointDisposition(durable, checkpoint);
  if (disposition.action === 'covered') {
    return { changed: false, recovered: false, covered: true, turnToken: checkpoint.turnToken };
  }
  if (disposition.action === 'conflict') {
    reportCheckpointConflict(session.id, checkpoint, disposition.reason);
    return { changed: false, recovered: false, conflict: disposition.reason, turnToken: null };
  }

  const routeChanged = [durable.activeTurnCheckpoint, marker].some(
    (entry) => entry?.turnToken === checkpoint.turnToken && entry.routeChanged === true
  );
  const finalized = replayCheckpoint(durable, checkpoint, disposition.boundary, routeChanged);
  session.messages = finalized.messages;
  // The splice is a history rewrite of its own, and this record now covers
  // the turn: a crash after it is saved never replays the checkpoint again.
  session.transcriptEpoch = mintTranscriptEpoch();
  session.turnCoverage = checkpoint.turnToken;
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
    turnToken: checkpoint.turnToken,
    responsePreserved: finalized.responsePreserved,
    contextStateRestored,
  };
}
