// manager/ask-turn-state.mjs
// The mutable state of one in-flight ask turn and its durability: the
// throttled crash-recovery checkpoint sidecar, and the close snapshot that
// canonicalizes the transcript when the turn is interrupted.
import { captureTurnCheckpointContextState, createTurnCheckpointRecorder } from './turn-checkpoint.mjs';

// Coalescing window for streaming-delta flushes. It is no longer a throttle
// on a full-snapshot rewrite: each flush now journals only the delta since
// the previous one, so the window just bounds syscalls.
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
    /** Queue entries this turn consumed: acked on commit, released on failure. */
    pendingEntries: [],
  };
}

/** The recorder writes this turn's header synchronously on its first flush
 *  (the crash-durability anchor for the prompt, landing before the provider
 *  runs) and appends bounded deltas afterwards. */
export function createTurnCheckpointScheduler({ sessionId, generation, turnToken, startedAt, turn, interruption }) {
  let timer = null;
  let stopped = false;
  let lastAt = 0;
  let warned = false;
  let contextState = null;
  const recorder = createTurnCheckpointRecorder({ sessionId, generation, turnToken, startedAt });
  const flush = () => {
    if (stopped || !turn.outgoing || !turn.userTurnContent) return false;
    try {
      const written = recorder.record({
        currentUserContent: turn.userTurnContent,
        turnOutgoing: turn.outgoing,
        interruption,
        contextState,
      });
      if (written) lastAt = Date.now();
      return written;
    } catch (error) {
      if (!warned) {
        warned = true;
        try {
          process.stderr.write(`[turn-checkpoint] write failed session=${sessionId}: ${error?.message || error}\n`);
        } catch {}
      }
      return false;
    }
  };
  return {
    refreshContextState() {
      contextState = captureTurnCheckpointContextState(turn.session, turn.outgoing, turn.userTurnContent);
    },
    schedule(immediate = false) {
      if (stopped || !turn.outgoing) return;
      if (immediate || Date.now() - lastAt >= TURN_CHECKPOINT_THROTTLE_MS) {
        if (timer) clearTimeout(timer);
        timer = null;
        flush();
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
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      recorder.stop();
    },
  };
}

/** closeSession is synchronous and generation-first by design. This turn-local
 *  hook lets it canonicalize the in-flight transcript before
 *  bumpSessionGeneration()/markSessionClosed() writes the disk snapshot and
 *  invalidates the ordinary cancellation cleanup save. Finalizes at most once;
 *  later calls return the same snapshot. */
export function createCloseSnapshot({ turn, interruption, checkpoint, runtime }) {
  let snapshot = null;
  return (abortReason) => {
    if (snapshot) return snapshot;
    const session = turn.session;
    if (!session) return null;
    checkpoint.stop();
    session.liveTurnMessages = null;
    // Interruption finalize below rewrites the transcript; the
    // mid-turn provider prefix snapshot must not survive it.
    delete session._providerPrefixGuardState;
    interruption.restoreTombstonedText();
    const finalized = interruption.finalize({
      turnOutgoing: turn.outgoing || session.messages,
      currentUserContent: turn.userTurnContent,
      abortReason,
    });
    session.messages = finalized.messages;
    delete session.activeTurnCheckpoint;
    if (!finalized.responsePreserved) {
      if (finalized.userTurnPreserved) {
        // A non-user detach keeps the provisional prompt but makes
        // the opaque provider continuation unsafe to reuse.
        session.providerState = undefined;
      }
    } else {
      session.providerState = undefined;
    }
    session.updatedAt = Date.now();
    session.lastUsedAt = Date.now();
    runtime.session = session;
    snapshot = finalized;
    return finalized;
  };
}
