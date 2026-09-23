// manager/ask-turn-commit.mjs
// What a completed turn leaves behind: the persisted assistant message (or
// its empty-final forensic record), the usage/cost ledger row, and the
// opaque provider continuation state.
import { cloneProviderReplay } from '../../providers/lib/provider-replay.mjs';
import { logLlmCall } from '../../../../shared/llm/usage-log.mjs';
import { runAbortable } from '../../../../shared/abort-race.mjs';
import { getAgentRuntimeSync } from './agent-runtime-singleton.mjs';
import { recordStandaloneStatusTelemetry } from './status-telemetry.mjs';

/** Appends the terminal assistant message for this turn to session.messages. */
export function appendAssistantTurnMessage({ session, sessionId, result, transcriptMeta }) {
  if (result.content || result.reasoningContent) {
    // Max-output recovery returns the complete concatenated text to
    // callers/TUI, while outgoing already contains prior partial assistant
    // turns and their continuation prompts. Persist only the terminal
    // segment here so model history contains every byte exactly once.
    const persistedAssistantContent =
      typeof result.historyContent === 'string' ? result.historyContent : result.content || '';
    const terminalStop = result?.stopReason ?? result?.stop_reason ?? null;
    const providerReplay = cloneProviderReplay(result.providerReplay);
    session.messages.push({
      role: 'assistant',
      // Keep content as-is in memory (model-visible). Image bytes, if any,
      // are swapped for a placeholder only at disk write time inside the
      // session store (store.mjs _sessionForDisk).
      content: persistedAssistantContent,
      ...(transcriptMeta ? { meta: { transcript: transcriptMeta } } : {}),
      ...(providerReplay ? { providerReplay } : {}),
      ...(typeof result.reasoningContent === 'string' ? { reasoningContent: result.reasoningContent } : {}),
      ...(result.providerMetadata && typeof result.providerMetadata === 'object'
        ? { providerMetadata: result.providerMetadata }
        : {}),
      // Keep terminal provider evidence for non-empty turns too. A safety
      // classifier can emit narration and then refuse; omitting this
      // metadata made that shape indistinguishable from an ordinary
      // successful final response.
      ...(terminalStop ? { stopReason: terminalStop } : {}),
      ...(result?.terminationReason ? { terminationReason: result.terminationReason } : {}),
      iterations: result?.iterations ?? null,
      toolCallsTotal: result?.toolCallsTotal ?? null,
    });
    return;
  }
  // Empty terminal turn: still persist a forensic record so post-mortem
  // inspection can distinguish "work landed but synthesis missing" from
  // "session never ran". Stop reason, usage, iterations, and tool-call
  // totals survive even when the assistant produced no content/reasoning.
  const emptyStop = result?.stopReason ?? result?.stop_reason ?? null;
  const emptyUsage = result?.usage
    ? {
        inputTokens: result.usage.inputTokens || 0,
        outputTokens: result.usage.outputTokens || 0,
        cachedTokens: result.usage.cachedTokens || 0,
        cacheWriteTokens: result.usage.cacheWriteTokens || 0,
      }
    : null;
  // Provider content-block classification — distinguishes a thinking-only
  // stall (model emitted reasoning blocks but no text/tool_use) from a true
  // silent empty turn. Anthropic providers (anthropic.mjs,
  // anthropic-oauth.mjs) set these fields on the result; other providers may
  // omit them.
  const emptyHasThinking = typeof result?.hasThinkingContent === 'boolean' ? result.hasThinkingContent : null;
  const emptyBlockTypes = Array.isArray(result?.contentBlockTypes) ? result.contentBlockTypes.slice() : null;
  session.messages.push({
    role: 'assistant',
    content: '',
    ...(typeof result.reasoningContent === 'string' ? { reasoningContent: result.reasoningContent } : {}),
    emptyFinal: true,
    ...(transcriptMeta ? { meta: { transcript: transcriptMeta } } : {}),
    stopReason: emptyStop,
    iterations: result?.iterations ?? null,
    toolCallsTotal: result?.toolCallsTotal ?? null,
    usage: emptyUsage,
    ...(emptyHasThinking !== null ? { hasThinkingContent: emptyHasThinking } : {}),
    ...(emptyBlockTypes !== null ? { contentBlockTypes: emptyBlockTypes } : {}),
    ts: Date.now(),
  });
  try {
    const blockTypesStr = emptyBlockTypes ? emptyBlockTypes.join(',') || 'none' : 'unknown';
    const thinkingStr = emptyHasThinking === null ? 'unknown' : String(emptyHasThinking);
    process.stderr.write(
      `[session] empty-final persisted sessionId=${sessionId} stopReason=${emptyStop ?? 'unknown'} iterations=${result?.iterations ?? 0} toolCallsTotal=${result?.toolCallsTotal ?? 0} outTokens=${emptyUsage?.outputTokens ?? 0} hasThinking=${thinkingStr} blockTypes=${blockTypesStr}\n`
    );
  } catch {}
}

/** Agent Runtime cache stats — hit/miss after every successful ask so the
 *  registry reflects all agent traffic, not just maintenance cycles.
 *  Guarded against any agent-runtime error so metric recording never breaks
 *  the ask itself. Returns the prefix hash for the usage log, if any. */
function recordAgentRuntimeCall(session, result) {
  const api = getAgentRuntimeSync();
  if (!session.profileId || !result.usage || !api) return null;
  try {
    const profile = api.getProfile(session.profileId);
    if (!profile) return null;
    // Collect every leading system-role message (BP1, BP2, ...) until the
    // first non-system message so the registry hash captures the full
    // ordered provider prefix, not just BP1.
    const systemMsgs = [];
    for (const m of session.messages) {
      if (m?.role !== 'system') break;
      systemMsgs.push(typeof m.content === 'string' ? m.content : '');
    }
    api.recordCall(profile, session.provider, {
      systemPrompt: systemMsgs,
      tools: session.tools || [],
      usage: result.usage,
    });
    const entry = api.registry?.data?.profiles?.[session.profileId]?.[session.provider];
    return entry?.prefixHash || null;
  } catch {
    return null;
  }
}

/** One usage-ledger row per completed ask with usage, plus the standalone
 *  status telemetry that reads the same figures. */
export async function recordAskUsage({ session, result, askStartedAt, turnSignal }) {
  const prefixHashForLog = recordAgentRuntimeCall(session, result);
  if (!result.usage) return;
  const inputTokens = result.usage.inputTokens || 0;
  const outputTokens = result.usage.outputTokens || 0;
  const cacheReadTokens = result.usage.cachedTokens || 0;
  const cacheWriteTokens = result.usage.cacheWriteTokens || 0;
  // Unified total-prompt field. Anthropic = input+cache_read+cache_write
  // (additive); OpenAI OAuth/API/Gemini = input_tokens already includes the
  // cached portion (inclusive), so the fallback must not double-count.
  const { isInclusiveProvider, computeCostUsd } = await runAbortable(
    turnSignal,
    () => import('../../../../shared/llm/cost.mjs')
  );
  const inclusive = isInclusiveProvider(session.provider);
  let promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  if (typeof result.usage.promptTokens === 'number') promptTokens = result.usage.promptTokens;
  else if (inclusive) promptTokens = Math.max(inputTokens, cacheReadTokens + cacheWriteTokens);
  let costUsd = result.usage.costUsd || 0;
  if (!costUsd) {
    try {
      costUsd = computeCostUsd({
        model: session.model,
        provider: session.provider,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        cacheWrite1hTokens: result.usage.cacheWrite1hTokens || 0,
      });
    } catch {
      /* best-effort */
    }
  }
  logLlmCall({
    ts: new Date().toISOString(),
    sourceType: session.sourceType || 'lead',
    sourceName: session.sourceName || session.agent || null,
    preset: session.presetName || null,
    model: session.model,
    provider: session.provider,
    duration: Date.now() - askStartedAt,
    profileId: session.profileId || null,
    sessionId: session.id,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    promptTokens,
    prefixHash: prefixHashForLog,
    costUsd,
    transportTiming: result.transportTiming || null,
  });
  recordStandaloneStatusTelemetry(session, result, Date.now() - askStartedAt);
}

/** Persist opaque providerState for stateful providers. The update bit
 *  distinguishes an adapter that emitted no state update from an explicit
 *  clear caused by compaction/provider reset. */
export function persistProviderState(session, result) {
  if (result.providerStateUpdated === true && (result.providerState === undefined || result.providerState === null)) {
    delete session.providerState;
  } else if (result.providerStateUpdated === true || result.providerState !== undefined) {
    session.providerState = result.providerState;
  }
}
