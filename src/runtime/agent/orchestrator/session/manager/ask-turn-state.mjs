// manager/ask-turn-state.mjs
// The mutable state of one in-flight ask turn and its durability: the
// throttled crash-recovery checkpoint sidecar, and the close snapshot that
// canonicalizes the transcript when the turn is interrupted.
import { captureTurnCheckpointContextState, createTurnCheckpointRecorder } from './turn-checkpoint.mjs';
import { finalizeTurnInterruptionSnapshot } from './turn-interruption.mjs';
import { onSensitiveValuesMarked } from '../sensitive-values.mjs';
import { saveSessionAsync } from '../store.mjs';
import { setTranscriptSnapshotHook } from '../store/transcript-durability.mjs';
import { ingestSessionTurn } from '../../../../session-search/session-search-ingest.mjs';

// Coalescing window for streaming-delta flushes. Each flush journals only the
// delta since the previous one, so the window just bounds syscalls.
const TURN_CHECKPOINT_THROTTLE_MS = 150;

/** What one turn mutates while it runs; every helper reads the live values. */
export function createAskTurnState(session) {
  return {
    /** The session object the turn works on. */
    session,
    /** The working transcript agentLoop mutates in place; null before the
     *  user turn is assembled. */
    outgoing: null,
    /** The user turn exactly as sent, kept for interruption finalization. */
    userTurnContent: '',
    /** Index of the user turn in `outgoing` when it was assembled. */
    boundary: null,
    /** Queue entries this turn consumed: acked on commit, released on failure. */
    pendingEntries: [],
  };
}

/** The recorder writes this turn's header synchronously on its first flush
 *  (the crash-durability anchor for the prompt, landing before the provider
 *  runs) and appends bounded deltas afterwards. `base` is the durable
 *  transcript the turn opens on (store/transcript-durability.mjs). Every
 *  save of the session flushes first, so a history rewrite is in the
 *  checkpoint before any record carries its new epoch. */
export function createTurnCheckpointScheduler({ sessionId, generation, turnToken, startedAt, turn, interruption, base }) {
  let timer = null;
  let stopped = false;
  let lastAt = 0;
  let warned = false;
  let contextDirty = false;
  const recorder = createTurnCheckpointRecorder({
    session: turn.session,
    sessionId,
    generation,
    turnToken,
    startedAt,
    base,
  });
  const record = (messages, extra = {}) =>
    recorder.record({
      boundary: turn.boundary,
      currentUserContent: turn.userTurnContent,
      turnOutgoing: messages,
      interruption,
      captureContext: (boundary) => captureTurnCheckpointContextState(turn.session, messages, boundary),
      contextDirty,
      ...extra,
    });
  const warn = (error) => {
    if (warned) return;
    warned = true;
    try {
      process.stderr.write(`[turn-checkpoint] write failed session=${sessionId}: ${error?.message || error}\n`);
    } catch {
      // stderr may be closed; the checkpoint failure is only reported
    }
  };
  const flush = () => {
    if (stopped || !turn.outgoing || !turn.userTurnContent) return false;
    try {
      const written = record(turn.outgoing);
      contextDirty = false;
      if (written) lastAt = Date.now();
      return written;
    } catch (error) {
      warn(error);
      return false;
    }
  };
  const flushNow = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    flush();
  };
  // A value marked sensitive while the turn runs (sensitive-values.mjs) —
  // before the call that carries it executes: every stored copy that may hold
  // it is written again with it replaced. The checkpoint is rewritten in full
  // now (the recorder sees the new version); the session file gets a full
  // save (store/save-delta.mjs resyncs on the version) and the search rows a
  // transactional replacement (session-search-ingest.mjs).
  const stopMarks = onSensitiveValuesMarked(sessionId, () => {
    if (stopped) return;
    if (turn.outgoing) flushNow();
    saveSessionAsync(turn.session, { expectedGeneration: generation }).catch((err) => {
      try {
        process.stderr.write(`[session] sensitive-value save failed session=${sessionId}: ${err?.message || err}\n`);
      } catch {
        // stderr may be closed; the save failure is only reported
      }
    });
    ingestSessionTurn(turn.session);
  });
  const unhookSaves = setTranscriptSnapshotHook(turn.session, () => {
    if (!stopped && turn.outgoing) flushNow();
  });
  const halt = (options) => {
    stopped = true;
    stopMarks();
    unhookSaves();
    if (timer) clearTimeout(timer);
    timer = null;
    recorder.stop(options);
  };
  return {
    refreshContextState() {
      contextDirty = true;
    },
    schedule(immediate = false) {
      if (stopped || !turn.outgoing) return;
      if (immediate || Date.now() - lastAt >= TURN_CHECKPOINT_THROTTLE_MS) {
        flushNow();
        return;
      }
      if (timer) return;
      const waitMs = Math.max(1, TURN_CHECKPOINT_THROTTLE_MS - (Date.now() - lastAt));
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, waitMs);
      timer.unref?.();
    },
    /** Record the finished transcript (`turn.session.messages`, with the
     *  final assistant message and its completion) as sealed, then stop: a
     *  crash before a save covers the turn replays it as finished, not as
     *  interrupted. */
    seal() {
      if (stopped) return false;
      let written = false;
      if (turn.outgoing && turn.userTurnContent) {
        try {
          contextDirty = true;
          written = record(turn.session.messages, { sealed: true });
        } catch (error) {
          warn(error);
        }
      }
      halt({ keepQueued: true });
      return written;
    },
    stop() {
      if (stopped) return;
      halt();
    },
  };
}

// The live-session fields a staged close snapshot rewrites.
const CLOSE_SNAPSHOT_SESSION_FIELDS = [
  'liveTurnMessages',
  '_providerPrefixGuardState',
  'messages',
  'activeTurnCheckpoint',
  'providerState',
  'updatedAt',
  'lastUsedAt',
];

/** closeSession is synchronous and generation-first by design. This turn-local
 *  hook lets it canonicalize the in-flight transcript before
 *  bumpSessionGeneration()/markSessionClosed() writes the disk snapshot and
 *  invalidates the ordinary cancellation cleanup save. Finalizes at most once;
 *  later calls return the same snapshot.
 *
 *  `prepare.tentative(reason)` stages the snapshot on the live session only:
 *  the checkpoint scheduler and the interruption tracker keep running until
 *  `commit()`, and `rollback()` restores the live session exactly, so a close
 *  whose lifecycle barrier is refused leaves the turn as it was. */
export function createCloseSnapshot({ turn, interruption, checkpoint, runtime }) {
  let snapshot = null;
  const stage = (abortReason) => {
    const session = turn.session;
    if (!session) return null;
    const saved = CLOSE_SNAPSHOT_SESSION_FIELDS.map((key) => [key, Object.hasOwn(session, key), session[key]]);
    const savedRuntimeSession = runtime.session;
    // The tracker snapshot already counts retracted (tombstoned) text as
    // output, so finalizing from it leaves the tracker itself untouched.
    const finalized = finalizeTurnInterruptionSnapshot({
      turnOutgoing: turn.outgoing || session.messages,
      currentUserContent: turn.userTurnContent,
      snapshot: interruption.snapshot(),
      abortReason: abortReason ?? null,
    });
    session.liveTurnMessages = null;
    // The finalized transcript is a rewrite; the mid-turn provider prefix
    // snapshot must not survive it.
    delete session._providerPrefixGuardState;
    session.messages = finalized.messages;
    delete session.activeTurnCheckpoint;
    // A preserved response — or a non-user detach that keeps the provisional
    // prompt — makes the opaque provider continuation unsafe to reuse.
    if (finalized.responsePreserved || finalized.userTurnPreserved) session.providerState = undefined;
    session.updatedAt = Date.now();
    session.lastUsedAt = Date.now();
    runtime.session = session;
    return {
      snapshot: finalized,
      commit() {
        checkpoint.stop();
        interruption.restoreTombstonedText();
        snapshot = finalized;
      },
      rollback() {
        for (const [key, had, value] of saved) {
          if (had) session[key] = value;
          else delete session[key];
        }
        runtime.session = savedRuntimeSession;
      },
    };
  };
  const prepare = (abortReason) => {
    if (snapshot) return snapshot;
    const staged = stage(abortReason);
    if (!staged) return null;
    staged.commit();
    return staged.snapshot;
  };
  prepare.tentative = (abortReason) => {
    if (snapshot) return { snapshot, commit() {}, rollback() {} };
    return stage(abortReason);
  };
  return prepare;
}
