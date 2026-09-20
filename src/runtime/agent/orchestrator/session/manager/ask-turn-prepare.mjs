// manager/ask-turn-prepare.mjs
// Everything askSession settles BEFORE the provider runs: the session's
// context-window/compaction figures for this turn, the optional transport
// prewarm, the single user turn that carries prompt + context + reminders,
// and the per-turn injected-context trace row.
import { withRuntimeUserContext } from '../runtime-user-context.mjs';
import { estimateJsonBytes } from '../../../../shared/json-metrics.mjs';
import { positiveInt } from '../../../../shared/numbers.mjs';
import { appendAgentTrace } from '../../agent-trace.mjs';
import { snapshotPendingDeferredToolDelta } from '../../../../../session-runtime/deferred-tool-delta.mjs';
import { snapshotPendingGoalReminder } from '../../../../../session-runtime/goal-reminder.mjs';
import { resolveSessionContextMeta } from './context-meta.mjs';
import { _buildRouteTurnReminder } from './rules-cache.mjs';
import {
  promptContentText,
  promptContentBytes,
  prefixUserTurnContent,
  suffixUserTurnReminders,
  buildCurrentTimeBlock,
} from './prompt-utils.mjs';
import { codexWireSendOpts } from './session-id.mjs';
import { _tryBridgeExplicitPrefetch } from './prefetch-bridge.mjs';
import { filterModelVisibleSessionMessages } from './message-sanitize.mjs';

// Legacy/alias compaction keys that never survive into this turn's config.
const RETIRED_COMPACTION_KEYS = [
  'type',
  'compactType',
  'compact_type',
  'semantic',
  'semanticModel',
  'prune',
  'tailTurns',
  'recallMemoryTimeoutMs',
  'recallIngestLimit',
  'recallChunkLimit',
  'recallLimit',
  'recallCycle1BatchSize',
  'recallRowsPerSession',
  'recallWindowSize',
  'recallConcurrency',
  'recallCycle1DeadlineMs',
];

/** Refreshes the session's context-window figures for this provider/model
 *  and normalizes its compaction config against them. */
export function applyTurnContextMeta(session, provider) {
  const contextMeta = resolveSessionContextMeta(provider, session.model, session);
  session.contextWindow = contextMeta.contextWindow;
  session.rawContextWindow = contextMeta.rawContextWindow;
  session.effectiveContextWindowPercent = contextMeta.effectiveContextWindowPercent;
  session.autoCompactTokenLimit = contextMeta.autoCompactTokenLimit;
  session.compactBoundaryTokens = contextMeta.compactBoundaryTokens;
  const compactState = { ...(session.compaction || {}) };
  if (!compactState.summaryModel && compactState.semanticModel) {
    compactState.summaryModel = compactState.semanticModel;
  }
  if (!compactState.memoryTimeoutMs && compactState.recallMemoryTimeoutMs) {
    compactState.memoryTimeoutMs = compactState.recallMemoryTimeoutMs;
  }
  for (const key of RETIRED_COMPACTION_KEYS) delete compactState[key];
  session.compaction = {
    ...compactState,
    auto: session.compaction?.auto !== false,
    boundaryTokens: contextMeta.compactBoundaryTokens,
    bufferTokens:
      positiveInt(session.compaction?.bufferTokens ?? session.compaction?.buffer) ||
      session.compaction?.bufferTokens ||
      null,
    contextWindow: contextMeta.contextWindow,
    rawContextWindow: contextMeta.rawContextWindow,
    effectiveContextWindowPercent: contextMeta.effectiveContextWindowPercent,
    autoCompactTokenLimit: contextMeta.autoCompactTokenLimit,
  };
}

/** A cold openai-oauth session dials its WS transport while the user turn is
 *  assembled. Returns the prewarm promise (never rejecting) or null. */
export function startProviderPrewarm({
  sessionId,
  session,
  provider,
  turnEffort,
  effortConfiguration,
  codexTurnId,
  startedAtMs,
}) {
  if (
    session.provider !== 'openai-oauth' ||
    Number(session.totalInputTokens || 0) !== 0 ||
    session.providerState ||
    typeof provider.prewarmWsTransportForSession !== 'function'
  ) {
    return null;
  }
  try {
    return Promise.resolve(
      provider.prewarmWsTransportForSession({
        sessionId,
        session,
        messages: filterModelVisibleSessionMessages(session.messages),
        model: session.model,
        tools: session.tools,
        effort: turnEffort,
        effortConfiguration,
        fast: session.fast === true,
        modelParameters: session.modelParameters || {},
        selectedContextWindow: session.selectedContextWindow || session.contextWindow || null,
        promptCacheKey: session.promptCacheKey || null,
        providerCacheKey: session.promptCacheKey || null,
        ...(session.providerCacheOpts || {}),
        ...(codexWireSendOpts(session, {
          requestKind: 'prewarm',
          turnId: codexTurnId,
          startedAtMs,
        }) || {}),
      })
    ).catch(() => false);
  } catch {
    return null;
  }
}

// Cap caller-supplied / prefetched context so an oversized payload can't
// blow the session token budget before the first model call. 32 KB ~ 8k
// tokens at the 4 B/tok working average; longer is silently truncated with
// a visible marker so the model still sees the prefix and a hint about the
// cut.
const CTX_CHAR_CAP = 32 * 1024;
const capContext = (text) => {
  if (typeof text !== 'string') return '';
  if (text.length <= CTX_CHAR_CAP) return text;
  return `${text.slice(0, CTX_CHAR_CAP)}\n\n... [context truncated; original ${text.length} chars]`;
};

/** Inlines context + prefetch INTO the prompt as a single user turn, marked
 *  with explicit section headers. The previous design pushed context as
 *  separate user messages with pre-injected assistant "Noted." acks; that
 *  conversational pattern taught some models a low-effort rhythm and they
 *  responded with "Noted." / empty tags even to the real task. Single-turn
 *  structure with a labelled `# Task` block forces the model to treat the
 *  brief as the work unit, not as another piece of context to ack. */
export async function buildUserTurn({
  session,
  prompt,
  context,
  explicitPrefetch,
  turnSignal,
  transcriptMeta,
  turnPromptSource,
  effortConfiguration,
}) {
  const explicitPrefetchResult = await _tryBridgeExplicitPrefetch(session, explicitPrefetch, turnSignal);
  let contextBlock = '';
  if (context) {
    contextBlock += `# Additional context\n${capContext(context)}\n\n`;
  }
  if (explicitPrefetchResult) {
    contextBlock += `# Prefetch\n${capContext(explicitPrefetchResult)}\n\n`;
  }
  const historyMessages = filterModelVisibleSessionMessages(session.messages);
  const promptTextForMetrics = promptContentText(prompt);
  // Soft warning only; real size management (compaction primary,
  // byte-budget trim as safety net) lives in agentLoop. Selecting a
  // 25% pre-trim here would starve compaction's 50% threshold.
  const softBudget = Math.floor(session.contextWindow * 0.25);
  const promptTokenEstimate = promptTextForMetrics.length * 0.5; // conservative for CJK
  if (promptTokenEstimate > softBudget * 0.7) {
    process.stderr.write(
      `[session] Warning: prompt is very large (est. ${Math.round(promptTokenEstimate)} tokens vs ${softBudget} soft budget)\n`
    );
  }
  const currentTimeBlock = buildCurrentTimeBlock(prompt);
  const deferredToolDelta = snapshotPendingDeferredToolDelta(session);
  // Read paused state after hydration and queue selection, not at
  // input intake: either can precede the previous turn's pause.
  // This supplies context only; it never resumes the Goal.
  const goalReminder = snapshotPendingGoalReminder(session, { includePaused: true });
  // Route policy's per-turn line (rules/routes/*.md, `turn-reminder:`):
  // read once before the turn's first response, part of the user turn
  // so it stays inside the cached transcript prefix.
  const routeReminder = _buildRouteTurnReminder({ provider: session.provider, model: session.model });
  const reminderBlock = [
    currentTimeBlock ? `<system-reminder>\n# Current Time\n${currentTimeBlock}\n</system-reminder>` : '',
    deferredToolDelta?.content || '',
    goalReminder?.content || '',
    routeReminder ? `<system-reminder>\n${routeReminder}\n</system-reminder>` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  // Reminders trail the human text (same order as the reference CLI): the
  // user's language stays the last signal before the reply.
  const userTurnMeta = {
    ...(transcriptMeta ? { transcript: transcriptMeta } : {}),
    ...(turnPromptSource || {}),
    ...(effortConfiguration ? { effortConfiguration } : {}),
  };
  const userTurnMessage = withRuntimeUserContext(
    {
      role: 'user',
      content: prefixUserTurnContent(prompt, contextBlock),
      ...(Object.keys(userTurnMeta).length ? { meta: userTurnMeta } : {}),
    },
    { suffix: suffixUserTurnReminders('', reminderBlock) }
  );
  return {
    explicitPrefetchResult,
    historyMessages,
    deferredToolDelta,
    goalReminder,
    userTurnMessage,
    outgoing: [...historyMessages, userTurnMessage],
  };
}

/** Per-turn injected-context trace row (complements kind:"usage"). Cheap
 *  byte-length accounting — no hashing, no payload bodies. Honors the same
 *  MIXDOG_AGENT_TRACE_DISABLE gate as usage rows; appendAgentTrace is a
 *  no-op when that env is set. Never throws into the ask path. */
export function traceTurnContext({
  sessionId,
  session,
  context,
  explicitPrefetchResult,
  prompt,
  userTurnContent,
  historyMessages,
}) {
  try {
    const contextBytes = Buffer.byteLength(context || '', 'utf8');
    const prefetchBytes = Buffer.byteLength(explicitPrefetchResult || '', 'utf8');
    const promptBytes = promptContentBytes(prompt);
    const userTurnBytes = promptContentBytes(userTurnContent);
    const messagesBytes = estimateJsonBytes(historyMessages || []);
    appendAgentTrace({
      kind: 'context',
      sessionId,
      model: session.model,
      provider: session.provider,
      totalBytes: userTurnBytes + messagesBytes,
      breakdown: {
        contextBytes,
        prefetchBytes,
        promptBytes,
        userTurnBytes,
        messagesBytes,
        messagesCount: historyMessages.length,
      },
    });
  } catch {
    /* trace must never break the ask path */
  }
}
