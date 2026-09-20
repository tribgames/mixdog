// manager/ask-session.mjs
// The core ask pipeline: askSession holds the per-session mutex for the whole
// call and runs the queue-fed turn loop. Each turn is opened (ask-turn-open),
// executed (ask-turn-execute), committed and published (ask-turn-settle) or
// unwound (ask-turn-failure); the follow-up prompt FIFO is ask-queue and the
// abort-aware call wrapper is ask-call-interrupt. This file owns the lock,
// the loop and the runtime bookkeeping around each turn.
import { createHash } from 'node:crypto';
import {
  persistedAssistantTranscriptMetadata,
  persistedUserTranscriptMetadata,
} from '../../../../shared/transcript-metadata.mjs';
import { drainPendingMessages, hydratePendingMessages } from './pending-messages.mjs';
import { _unlinkParentAbortListener, _getRuntimeEntry, _evictTerminalSessionRuntime } from './runtime-liveness.mjs';
import { acquireSessionLock } from './session-lock.mjs';
import { createAskPromptQueue } from './ask-queue.mjs';
import { armTurnDurability, claimTurnRuntime } from './ask-turn-open.mjs';
import { prepareAskTurn, runAskAgentLoop } from './ask-turn-execute.mjs';
import { commitAskTurn, publishAskTurn } from './ask-turn-settle.mjs';
import { finalizeAskTurnFailure } from './ask-turn-failure.mjs';

export { _api_call_with_interrupt } from './ask-call-interrupt.mjs';
export {
  acknowledgeAskTextReset,
  emitAskSessionStart,
  resolveAskLiveProjection,
  settleAskCleanup,
} from './ask-support.mjs';

const traceAskStart = (sessionId, explicitPrefetch) => {
  if (!process.env.MIXDOG_DEBUG_AGENT) return;
  const sessionHash = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 8);
  const prefetchFiles = explicitPrefetch?.files?.length || 0;
  const prefetchCallers = explicitPrefetch?.callers?.length || 0;
  const prefetchRefs = explicitPrefetch?.references?.length || 0;
  process.stderr.write(
    `[agent-trace] t0-ask-start sessionHash=${sessionHash} role=? iteration=0 promptSrc=prompt prefetchFiles=${prefetchFiles} callers=${prefetchCallers} references=${prefetchRefs}\n`
  );
};

/** The transcript timestamps the caller supplied for this ask: the persisted
 *  user metadata plus a one-shot reader for the assistant metadata. */
function createAskTranscriptMeta(rawTranscriptMeta) {
  return {
    raw: rawTranscriptMeta,
    user: persistedUserTranscriptMetadata(rawTranscriptMeta),
    takeAssistant: () => {
      const metadata = persistedAssistantTranscriptMetadata(rawTranscriptMeta);
      if (rawTranscriptMeta && typeof rawTranscriptMeta === 'object') delete rawTranscriptMeta.assistantAt;
      return metadata;
    },
  };
}

/** One opened turn from provider call to terminal publish; a failure unwinds
 *  the turn state and rethrows. Returns the terminal result preview and the
 *  follow-ups drained right after the provider accepted the turn. */
async function runAskTurn({ sessionId, opened, input, askOpts, onToolCall, cwdOverride, transcript, askStartedAt }) {
  try {
    const prepared = await prepareAskTurn({ sessionId, opened, input, cwdOverride, transcriptMeta: transcript.user });
    const result = await runAskAgentLoop({
      sessionId,
      opened,
      prepared,
      input,
      askOpts,
      onToolCall,
      takeAssistantTranscriptMetadata: transcript.takeAssistant,
    });
    const terminalResultPreview = await commitAskTurn({
      sessionId,
      opened,
      prepared,
      result,
      rawTranscriptMeta: transcript.raw,
      askStartedAt,
    });
    const drained = publishAskTurn({
      sessionId,
      opened,
      terminalResultPreview,
      askOpts,
      rawTranscriptMeta: transcript.raw,
      askStartedAt,
    });
    return { result: terminalResultPreview, drained };
  } catch (err) {
    await finalizeAskTurnFailure({
      sessionId,
      err,
      turn: opened.turn,
      interruption: opened.interruption,
      prepareCloseSnapshot: opened.prepareCloseSnapshot,
      checkpoint: opened.checkpoint,
      generation: opened.askGeneration,
      turnCheckpointToken: opened.turnToken,
      runtime: opened.runtime,
    });
    throw err;
  }
}

export async function askSession(sessionId, prompt, context, onToolCall, cwdOverride, explicitPrefetch, askOpts = {}) {
  const askStartedAt = Date.now();
  const transcript = createAskTranscriptMeta(askOpts?.transcriptMeta);
  traceAskStart(sessionId, explicitPrefetch);
  const unlock = await acquireSessionLock(sessionId, askOpts?.signal);
  // Start crash-spool hydration without delaying the user turn. A completed
  // background hydration joins the id-deduped memory drain below.
  const takeoverHydration = hydratePendingMessages(sessionId);
  if (process.env.MIXDOG_DEBUG_AGENT) {
    process.stderr.write(`[agent-trace] lock-acquired waitedMs=${Date.now() - askStartedAt}\n`);
  }
  // A non-empty cross-process sweep starts an empty follow-up ask once the
  // current session lock is released; it never delays completion.
  const kickFollowUpAsk = () => {
    askSession(sessionId, '', null, onToolCall, cwdOverride, null, askOpts).catch(() => {});
  };
  // The mutex is held for the WHOLE askSession call, including any follow-up
  // turns drained from the pending-message queue below — the single outer
  // try/finally releases it exactly once. result holds the last turn's
  // return value (the queued tail turns supersede the original prompt's
  // result, mirroring how a live chat returns the latest turn).
  let result;
  const queue = createAskPromptQueue({ sessionId, promptSource: askOpts.promptSource });
  // Hoisted so the outer finally (which runs once after the whole turn loop)
  // can compare against the last turn's generation.
  let askGeneration = 0;
  let crashRecoveryChecked = false;
  let sessionStartEmitted = false;
  // A failed-turn retry rewinds only the turn it retries, never a drained
  // follow-up turn.
  let retryFailedTurn = askOpts.retryFailedTurn === true;
  try {
    // Turn loop (pendingMessages pattern): run the current prompt, then drain
    // any `agent type=send` messages that were queued while this turn was in
    // flight and run them — in order — as the next user turn(s). Because the
    // queued send always lands AFTER the in-flight prompt here, ordering is
    // preserved and the spawn/connecting startup race disappears.
    for (;;) {
      const input = queue.nextTurn({ prompt, context, explicitPrefetch });
      if (!input) {
        void takeoverHydration.then((count) => {
          if (count <= 0) return;
          setImmediate(kickFollowUpAsk);
        });
        _unlinkParentAbortListener(_getRuntimeEntry(sessionId));
        return result;
      }
      if (retryFailedTurn) {
        input.retryFailedTurn = true;
        retryFailedTurn = false;
      }
      // Synchronous pre-await setup (must happen before any await so
      // closeSession() can't interleave between load and registration).
      const claimed = claimTurnRuntime({
        sessionId,
        askOpts,
        recoverCheckpoint: !crashRecoveryChecked,
        emitStart: !sessionStartEmitted,
      });
      crashRecoveryChecked = true;
      sessionStartEmitted = true;
      askGeneration = claimed.askGeneration;
      const opened = {
        ...claimed,
        ...armTurnDurability({ sessionId, ...claimed, pendingEntries: input.pendingEntries }),
      };
      const turn = await runAskTurn({
        sessionId,
        opened,
        input,
        askOpts,
        onToolCall,
        cwdOverride,
        transcript,
        askStartedAt,
      });
      result = turn.result;
      // Turn complete. Drain the pending-message queue: any `agent type=send`
      // that arrived while this turn was in flight runs next, in order, as a
      // follow-up user turn. The mutex is still held, so a send racing this
      // drain either landed before (picked up here) or enqueues for the next
      // loop. When the queue is empty we return the latest turn's result.
      const drained = turn.drained.length > 0 ? turn.drained : drainPendingMessages(sessionId);
      if (queue.pushDrained(drained)) {
        // Carry the just-committed in-memory session into the follow-up
        // turn so the queued tail sees the preceding assistant/tool
        // context. loadSession() would return this same live snapshot
        // (setLiveSession published it), so skip the disk round-trip.
        opened.runtime.session = opened.turn.session;
        continue;
      }
      _unlinkParentAbortListener(_getRuntimeEntry(sessionId));
      // Pick up cross-process sends that landed after takeover hydration.
      setImmediate(() => {
        hydratePendingMessages(sessionId)
          .then((count) => {
            if (count <= 0) return;
            kickFollowUpAsk();
          })
          .catch(() => {});
      });
      return result;
    }
  } finally {
    // A thrown setup/provider path must never leave a delayed checkpoint
    // writer alive after the turn lock is released.
    // Clear the controller only if it's still ours (closeSession may have
    // swapped it). Leave the rest of the runtime entry intact so agent type=list
    // can still surface the final stage (done/error/cancelling).
    const entry = _getRuntimeEntry(sessionId);
    if (entry && entry.generation === askGeneration) {
      _unlinkParentAbortListener(entry);
      entry.controller = null;
      // Detach the live session reference; ask is over.
      entry.session = null;
    }
    // Final-stage runtime diagnostics are useful only while the turn is
    // unwinding. Once its controller is detached, retaining the full entry
    // (and any accidental references hanging from it) for the host lifetime
    // turns one-shot agent traffic into an unbounded manager Map.
    _evictTerminalSessionRuntime(sessionId);
    unlock();
  }
}
