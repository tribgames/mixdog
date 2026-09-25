// manager/ask-turn-settle.mjs
// What happens after agentLoop returns: the closed/generation check and the
// committed transcript with usage and acknowledgements (commitAskTurn), then
// the terminal relay, the durable save and the terminal runtime stage
// (publishAskTurn).
import { saveSessionAsync, saveSessionAsyncDeferred } from '../store.mjs';
import { persistedAssistantTranscriptMetadata } from '../../../../shared/transcript-metadata.mjs';
import { acknowledgePendingDeferredToolDelta } from '../../../../../session-runtime/deferred-tool-delta.mjs';
import { acknowledgePendingGoalReminder } from '../../../../../session-runtime/goal-reminder.mjs';
import {
  finalizePendingMessageDelivery,
  drainPendingMessages,
  recordPendingMessageDelivery,
} from './pending-messages.mjs';
import { applyAskTerminalUsageTotals } from './usage-metrics.mjs';
import { markSessionDone, markSessionEmptyFinal, _getRuntimeEntry } from './runtime-liveness.mjs';
import { SessionClosedError } from './session-errors.mjs';
import { filterModelVisibleSessionMessages } from './message-sanitize.mjs';
import { clearTurnCheckpoint } from './turn-checkpoint.mjs';
import { recordProviderContextBaseline } from '../loop/compact-policy.mjs';
import { throwIfAborted } from '../../../../shared/abort-race.mjs';
import { appendAssistantTurnMessage, persistProviderState, recordAskUsage } from './ask-turn-commit.mjs';

function attachAssistantTranscriptCompletion(messages, completion, turnStartedAt = 0) {
  if (!Array.isArray(messages) || !completion || typeof completion !== 'object') return false;
  const elapsedMs = Math.max(0, Number(completion.elapsedMs || 0));
  const status = typeof completion.status === 'string' && completion.status ? completion.status : 'done';
  const verb = typeof completion.verb === 'string' && completion.verb ? completion.verb : 'Thought';
  let turnStart = -1;
  const expectedAt = Number(turnStartedAt || 0);
  if (expectedAt > 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'user') continue;
      if (Number(message?.meta?.transcript?.at || 0) !== expectedAt) continue;
      turnStart = index;
      break;
    }
  }
  for (let index = messages.length - 1; index > turnStart; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const content = message.content;
    const hasVisibleText =
      typeof content === 'string'
        ? Boolean(content.trim())
        : Array.isArray(content) &&
          content.some((part) => {
            if (typeof part === 'string') return Boolean(part.trim());
            if (!part || typeof part !== 'object') return false;
            return Boolean(String(part.text || part.content || '').trim());
          });
    if (!hasVisibleText) continue;
    const meta = message.meta && typeof message.meta === 'object' ? message.meta : {};
    const transcript = meta.transcript && typeof meta.transcript === 'object' ? meta.transcript : {};
    messages[index] = {
      ...message,
      meta: {
        ...meta,
        transcript: {
          ...transcript,
          completion: { status, verb, elapsedMs },
        },
      },
    };
    return true;
  }
  return false;
}

/** Commits the loop result into the session: messages, usage, provider state
 *  and queue acknowledgements. Returns the terminal result preview. */
export async function commitAskTurn({ sessionId, opened, prepared, result, rawTranscriptMeta, askStartedAt }) {
  const { turn, runtime, turnSignal, askGeneration, checkpoint, prepareCloseSnapshot } = opened;
  const session = turn.session;
  throwIfAborted(turnSignal);
  // Post-loop validation: if closeSession() landed while we were awaiting,
  // drop the save so the tombstone on disk isn't overwritten.
  const currentRuntime = _getRuntimeEntry(sessionId);
  if (currentRuntime?.closed || currentRuntime?.generation !== askGeneration) {
    const reason = currentRuntime?.closedReason;
    throw new SessionClosedError(sessionId, `closed during call (reason=${reason || 'unknown'})`, reason || null);
  }
  // Update and save. outgoing is mutated in place by agentLoop
  // (compaction + safety trim), so its length reflects post-loop state.
  const messagesDropped = Math.max(0, prepared.beforeCount - prepared.outgoing.length);
  session.messages = filterModelVisibleSessionMessages(prepared.outgoing);
  // Turn committed into session.messages; drop the live-turn alias so
  // contextStatus() reverts to the authoritative committed transcript.
  session.liveTurnMessages = null;
  checkpoint.stop();
  delete session.activeTurnCheckpoint;
  appendAssistantTurnMessage({
    session,
    sessionId,
    result,
    transcriptMeta: persistedAssistantTranscriptMetadata(rawTranscriptMeta),
  });
  // The terminal assistant message is now canonical. A close racing
  // any later await should persist this committed session as-is,
  // never re-finalize the pre-terminal outgoing array.
  if (runtime.prepareCloseSnapshot === prepareCloseSnapshot) {
    runtime.prepareCloseSnapshot = null;
  }
  session.updatedAt = Date.now();
  session.lastUsedAt = Date.now();
  applyAskTerminalUsageTotals(session, result, {
    skipTotalsIfIncremental: runtime?.usageMetricsTurnIncremental === true,
  });
  recordProviderContextBaseline(session, session.messages, result.lastTurnUsage || result.usage, {
    sendTools: result.lastSendTools,
  });
  await recordAskUsage({ session, result, askStartedAt, turnSignal });
  persistProviderState(session, result);
  if (prepared.deferredToolDelta) {
    acknowledgePendingDeferredToolDelta(session, prepared.deferredToolDelta.revision);
  }
  if (prepared.goalReminder) {
    acknowledgePendingGoalReminder(session, prepared.goalReminder.revision);
  }
  return {
    ...result,
    trimmed: messagesDropped > 0,
    messagesDropped,
  };
}

/** Acknowledges the consumed queue entries, relays the terminal result,
 *  starts the durable save and marks the session done. Returns the
 *  follow-up entries drained right after the provider accepted the turn. */
export function publishAskTurn({ sessionId, opened, terminalResultPreview, askOpts, rawTranscriptMeta, askStartedAt }) {
  const { turn, runtime, askGeneration, turnToken } = opened;
  const session = turn.session;
  // The provider accepted this queued turn: only now remove its
  // durable ids. A crash before here leaves them for at-least-once
  // replay; duplicate memory/spool copies share the same id.
  recordPendingMessageDelivery(session, turn.pendingEntries);
  const drained = drainPendingMessages(sessionId);
  if (drained.length === 0) {
    const turnStartedAt = Number(rawTranscriptMeta?.at || askStartedAt);
    attachAssistantTranscriptCompletion(
      session.messages,
      {
        status: 'done',
        verb: rawTranscriptMeta?.completionVerb,
        elapsedMs: Date.now() - turnStartedAt,
      },
      turnStartedAt
    );
  }
  let terminalRelayed = false;
  if (drained.length === 0 && typeof askOpts?.onTerminalResult === 'function') {
    terminalRelayed = true;
    try {
      askOpts.onTerminalResult(terminalResultPreview, {
        sessionId,
        beforeSave: true,
        durationMs: Date.now() - askStartedAt,
      });
    } catch {
      /* best-effort early completion relay */
    }
  }
  // Auto-compact runs at the start of the next
  // query/provider send (agentLoop pre-send), not after the previous
  // answer. This lets queued follow-up prompts resume immediately;
  // if they need compaction, their own spinner shows compacting first.
  // Fire-and-forget terminal save. The result is already produced and
  // (for agent surfaces) relayed via onTerminalResult above. When
  // completion was relayed to the UI, yield before postMessage
  // structured-clones the full session. Queued follow-up turns retain
  // the original immediate-save ordering; they did not inject a
  // terminal card and may mutate this same session on the next loop.
  const saveTerminalSession = terminalRelayed ? saveSessionAsyncDeferred : saveSessionAsync;
  const terminalSave = saveTerminalSession(session, { expectedGeneration: askGeneration });
  terminalSave.then(
    () => clearTurnCheckpoint(sessionId, turnToken),
    () => {}
  );
  finalizePendingMessageDelivery(session, turn.pendingEntries, terminalSave, () =>
    saveSessionAsync(session, { expectedGeneration: askGeneration })
  ).catch((err) => {
    try {
      process.stderr.write(`[session] terminal save failed: ${err?.message || err}\n`);
    } catch {}
  });
  turn.pendingEntries = [];
  runtime.session = session;
  // Tag empty-synthesis BEFORE markSessionDone so the watchdog
  // (which inspects entry.emptyFinal first) classifies the
  // terminal state correctly even if it ticks during unwind.
  const isEmptyFinal = !terminalResultPreview.content && !terminalResultPreview.reasoningContent;
  if (isEmptyFinal) {
    markSessionEmptyFinal(sessionId);
  }
  markSessionDone(sessionId, { empty: isEmptyFinal });
  return drained;
}
