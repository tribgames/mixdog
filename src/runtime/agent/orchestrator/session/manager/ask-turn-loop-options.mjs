// manager/ask-turn-loop-options.mjs
// The option bag one ask turn hands to agentLoop: every host callback is
// wrapped so the interruption tracker and the checkpoint sidecar observe the
// turn before the caller does, and the transport identity travels with it.
import { recordProviderContextBaseline } from '../loop/compact-policy.mjs';
import { acknowledgeAskTextReset, resolveAskLiveProjection } from './ask-support.mjs';
import {
  _groupPendingMessageEntries,
  drainPendingMessages,
  releasePendingMessages,
} from './pending-messages.mjs';
import { updateSessionStage, markSessionStreamDelta } from './runtime-liveness.mjs';
import { codexWireSendOpts } from './session-id.mjs';
import { persistIterationMetrics } from './usage-metrics.mjs';

const optionalFn = (value) => (typeof value === 'function' ? value : undefined);
const relay = (fn, ...args) => {
  try {
    fn?.(...args);
  } catch {}
};

/**
 * @param {object} input
 * @param {string} input.sessionId
 * @param {object} input.session
 * @param {object[]} input.outgoing  the working transcript agentLoop mutates
 * @param {object} input.turn        the ask turn state (pendingEntries)
 * @param {object} input.askOpts
 * @param {Function|null} input.onToolCall
 * @param {object} input.interruption
 * @param {object} input.checkpoint
 * @param {AbortSignal} input.signal
 */
export function buildAgentLoopOptions({
  sessionId,
  session,
  outgoing,
  turn,
  askOpts,
  onToolCall,
  interruption,
  checkpoint,
  turnEffort,
  effortConfiguration,
  codexTurnId,
  startedAtMs,
  signal,
  takeAssistantTranscriptMetadata,
}) {
  // Mid-chain queued prompt/notification drain is owned by agentLoop at
  // provider-continuation boundaries (after a tool batch, before the next
  // send). The post-loop tail drain in askSession still handles items that
  // arrive after the model would otherwise stop.
  const drainSteering = (sid, drainOptions = {}) => {
    const out = [];
    if (typeof askOpts?.drainSteering === 'function') {
      try {
        const drained = askOpts.drainSteering(sid || sessionId, drainOptions);
        if (Array.isArray(drained)) out.push(...drained);
      } catch {
        /* best-effort steering drain */
      }
    }
    // Manager/pending-messages entries carry no mode/priority/slash
    // metadata, so they stay OUT of the mid-chain (post-tool-batch) drain —
    // that would bypass the queued-command filters. At the TERMINAL boundary
    // they are exactly pending input: an `agent type=send` queued while the
    // terminal sample was in flight must be folded into THIS turn before any
    // stop hook runs, instead of losing its slot to a synthetic continuation
    // prompt. The mutex is held for the whole ask, so this drain races
    // nothing. Entries consumed here join the turn's pending entries: their
    // delivery/ack (and release on failure) rides this turn, and the
    // post-loop drain can no longer see them.
    if (drainOptions?.stage === 'terminal') {
      const pendingNow = drainPendingMessages(sessionId);
      if (pendingNow.length > 0) {
        // One steering entry per mode group: the merged prompt (if any) and
        // each task notification on its own, so the loop stores them apart.
        const groupsNow = _groupPendingMessageEntries(pendingNow);
        if (groupsNow.length > 0) {
          turn.pendingEntries.push(...pendingNow);
          for (const group of groupsNow) {
            out.push({
              content: group.content,
              text: group.text,
              ids: group.ids,
              mode: group.mode,
              ...(group.execution ? { execution: group.execution } : {}),
            });
          }
        } else {
          releasePendingMessages(sessionId, pendingNow);
        }
      }
    }
    return out;
  };
  return {
    effort: turnEffort,
    effortConfiguration,
    fast: session.fast === true,
    modelParameters: session.modelParameters || {},
    selectedContextWindow: session.selectedContextWindow || session.contextWindow || null,
    sessionId,
    onTextDelta: (chunk) => {
      interruption.recordTextDelta(chunk);
      checkpoint.schedule();
      if (typeof askOpts?.onTextDelta === 'function') askOpts.onTextDelta(chunk);
    },
    onTextReset: async (detail) =>
      acknowledgeAskTextReset(askOpts, detail, (resetDetail) => {
        interruption.tombstoneText(resetDetail?.chars);
        checkpoint.schedule(true);
      }),
    onReasoningDelta: (chunk) => {
      interruption.recordReasoningDelta(chunk);
      checkpoint.schedule();
      if (typeof askOpts?.onReasoningDelta === 'function') askOpts.onReasoningDelta(chunk);
    },
    onAssistantText: (text) => {
      interruption.recordAssistantText(text);
      checkpoint.schedule(true);
      if (typeof askOpts?.onAssistantText === 'function') askOpts.onAssistantText(text);
    },
    takeAssistantTranscriptMetadata,
    // Send-opt only. Never copy onto `session` — a transient
    // interactive/live flag must not survive this ask.
    liveProjection: resolveAskLiveProjection(askOpts),
    onAssistantMessageCommitted: (message) => {
      interruption.markAssistantMessageCommitted();
      checkpoint.schedule(true);
      relay(askOpts?.onAssistantMessageCommitted, message);
    },
    onAssistantToolCallObserved: (call, detail) => {
      interruption.recordToolCalls([call], detail);
      checkpoint.schedule(true);
      relay(askOpts?.onAssistantToolCallObserved, call, detail);
    },
    onProviderSendStarted: () => {
      interruption.markProviderSendStarted();
      checkpoint.schedule(true);
      relay(askOpts?.onProviderSendStarted);
    },
    onToolPhaseStarted: () => {
      interruption.markToolPhaseStarted();
      checkpoint.schedule(true);
      relay(askOpts?.onToolPhaseStarted);
    },
    onToolPhaseCompleted: (detail) => {
      relay(askOpts?.onToolPhaseCompleted, detail);
    },
    onUsageDelta: (d) => {
      persistIterationMetrics(d).catch(() => {});
      // provider_send usage arrives before agentLoop appends the assistant
      // response. Preserve the full actual input/cache/output count and mark
      // this request boundary; compact pressure will skip that first
      // assistant representation and estimate only later tool
      // results/steering.
      if (d?.source === 'provider_send') {
        recordProviderContextBaseline(
          session,
          outgoing,
          {
            mainUsageAvailable: d.contextUsageAvailable,
            inputTokens: d.contextInputTokens ?? d.deltaInput,
            outputTokens: d.contextOutputTokens ?? d.deltaOutput,
            promptTokens: d.contextPromptTokens ?? d.deltaPrompt,
            cachedTokens: d.contextCachedReadTokens ?? d.deltaCachedRead,
            cacheWriteTokens: d.contextCacheWriteTokens ?? d.deltaCacheWrite,
            contextTokens: d.contextMeasuredTokens ?? null,
          },
          { boundary: 'request', sendTools: d.sendTools }
        );
        checkpoint.refreshContextState();
        // Persist the actual provider reading in the SAME ordered
        // checkpoint lane as the request prefix.
        checkpoint.schedule(true);
      }
      relay(askOpts?.onUsageDelta, d);
    },
    onToolResult: (message) => {
      interruption.recordToolResult(message);
      checkpoint.schedule(true);
      if (typeof askOpts?.onToolResult === 'function') askOpts.onToolResult(message);
    },
    onToolApproval: optionalFn(askOpts?.onToolApproval),
    beforeToolExecution: optionalFn(askOpts?.beforeToolExecution),
    onCompactEvent: (event) => {
      checkpoint.refreshContextState();
      checkpoint.schedule(true);
      relay(askOpts?.onCompactEvent, event);
    },
    // Pre-send gauge sync. Defined only when a host listens so the loop
    // never computes a display number nobody reads.
    onContextPressure: optionalFn(askOpts?.onContextPressure),
    drainSteering,
    onSteerMessage: (text, detail) => {
      checkpoint.schedule(true);
      relay(askOpts?.onSteerMessage, text, detail);
    },
    notifyFn: optionalFn(askOpts?.notifyFn),
    // Same projection compaction uses, so a session presents one identity on
    // every request it makes.
    ...(codexWireSendOpts(session, { turnId: codexTurnId, startedAtMs }) || {}),
    promptCacheKey: session.promptCacheKey || sessionId,
    // Provider-scoped cache key (mixdog-codex, mixdog-claude…). Distinct
    // from sessionId — providers that pool sockets per-session (openai-oauth
    // WS) use sessionId as the pool bucket and providerCacheKey as the
    // server-side prompt-cache shard so parallel callers don't collide on a
    // mid-turn socket while still sharing prefix cache.
    providerCacheKey: session.promptCacheKey || null,
    signal,
    providerState: session.providerState ?? undefined,
    session,
    // Agent Runtime cache settings — merged last so session overrides don't
    // get overridden by defaults. When session has no profile,
    // providerCacheOpts is null and this spread is a no-op.
    ...(session.providerCacheOpts || {}),
    onStageChange: (stage, detail) => {
      updateSessionStage(sessionId, stage);
      relay(askOpts?.onStageChange, stage, detail);
    },
    onStreamDelta: (kind = 'semantic') => {
      markSessionStreamDelta(sessionId, kind).catch(() => {});
      // Raw transport is an internal health signal, not model progress.
      // Preserve the public callback's historical semantic-only contract.
      if (kind !== 'transport') relay(askOpts?.onStreamDelta, kind);
    },
  };
}

/** The tool-call callback agentLoop receives: the tracker sees every batch
 *  before the caller's hook runs. */
export function trackedToolCallHook({ onToolCall, interruption, checkpoint }) {
  return async (iteration, calls) => {
    interruption.recordToolCalls(calls);
    checkpoint.schedule(true);
    if (typeof onToolCall === 'function') return await onToolCall(iteration, calls);
    return undefined;
  };
}
