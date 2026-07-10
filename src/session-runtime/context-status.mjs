import {
  estimateRequestReserveTokens,
  estimateToolSchemaTokens,
  estimateTranscriptContextUsage,
  resolveSessionCompactPolicy,
  summarizeContextMessages,
} from '../runtime/agent/orchestrator/session/context-utils.mjs';
import { estimateToolSchemaBreakdown } from './tool-catalog.mjs';

// Live /context gauge computation + its self-owned memoization cache. Extracted
// verbatim from the runtime API object; the runtime injects live getters for
// the mutable session/route/cwd/mode locals. The cache (key + value) is owned
// here now, so invalidateContextStatusCache() is returned for the runtime to
// call from the same places it used to clear the inline locals.
export function createContextStatus({ getSession, getRoute, getCurrentCwd, getMode }) {
  let contextStatusCacheKey = null;
  let contextStatusCacheValue = null;

  function contextStatusCacheKeyFor({ messages, tools }) {
    const session = getSession();
    const route = getRoute();
    const compaction = session?.compaction || {};
    const lastMessage = messages[messages.length - 1] || null;
    return {
      session,
      sessionId: session?.id || null,
      provider: route.provider,
      model: route.model,
      cwd: getCurrentCwd(),
      mode: getMode(),
      messages,
      messageCount: messages.length,
      lastMessage,
      lastMessageRole: lastMessage?.role || null,
      lastMessageContent: lastMessage?.content || null,
      tools,
      toolCount: tools.length,
      contextWindow: session?.contextWindow || null,
      rawContextWindow: session?.rawContextWindow || null,
      effectiveContextWindowPercent: session?.effectiveContextWindowPercent || null,
      autoCompactTokenLimit: Number(session?.autoCompactTokenLimit || 0),
      lastContextTokens: Number(session?.lastContextTokens || 0),
      lastContextTokensUpdatedAt: Number(session?.lastContextTokensUpdatedAt || 0),
      lastContextTokensStaleAfterCompact: session?.lastContextTokensStaleAfterCompact === true,
      lastInputTokens: Number(session?.lastInputTokens || 0),
      lastUncachedInputTokens: Number(session?.lastUncachedInputTokens || 0),
      lastOutputTokens: Number(session?.lastOutputTokens || 0),
      lastCachedReadTokens: Number(session?.lastCachedReadTokens || 0),
      lastCacheWriteTokens: Number(session?.lastCacheWriteTokens || 0),
      totalInputTokens: Number(session?.totalInputTokens || 0),
      totalUncachedInputTokens: Number(session?.totalUncachedInputTokens || 0),
      totalOutputTokens: Number(session?.totalOutputTokens || 0),
      totalCachedReadTokens: Number(session?.totalCachedReadTokens || 0),
      totalCacheWriteTokens: Number(session?.totalCacheWriteTokens || 0),
      compactBoundaryTokens: Number(session?.compactBoundaryTokens || 0),
      compactionBoundaryTokens: Number(compaction.boundaryTokens || 0),
      compactionTriggerTokens: Number(compaction.triggerTokens || 0),
      compactionLastChangedAt: Number(compaction.lastChangedAt || 0),
      compactionLastCompactAt: Number(compaction.lastCompactAt || 0),
    };
  }

  function sameContextStatusCacheKey(a, b) {
    if (!a || !b) return false;
    for (const key of Object.keys(a)) {
      if (!Object.is(a[key], b[key])) return false;
    }
    return true;
  }

  function invalidateContextStatusCache() {
    contextStatusCacheKey = null;
    contextStatusCacheValue = null;
  }

  function contextStatus() {
    const session = getSession();
    const route = getRoute();
    // Prefer the in-flight working transcript while a turn is running so the
    // context gauge reflects LIVE growth (user turn + tool calls/results) as
    // it accumulates, instead of freezing at the pre-turn committed snapshot.
    // askSession() sets session.liveTurnMessages for the turn duration and
    // clears it on commit/cancel/error, after which we fall back to the
    // authoritative committed transcript.
    const liveTurnMessages = Array.isArray(session?.liveTurnMessages) ? session.liveTurnMessages : null;
    const messages = liveTurnMessages || (Array.isArray(session?.messages) ? session.messages : []);
    const tools = Array.isArray(session?.tools) ? session.tools : [];
    const cacheKey = contextStatusCacheKeyFor({ messages, tools });
    if (contextStatusCacheValue && sameContextStatusCacheKey(cacheKey, contextStatusCacheKey)) {
      return contextStatusCacheValue;
    }

    const messageSummary = summarizeContextMessages(messages);
    const toolSchemaTokens = estimateToolSchemaTokens(tools);
    const toolSchemaBreakdown = estimateToolSchemaBreakdown(tools);
    const requestReserveTokens = estimateRequestReserveTokens(tools);
    const requestOverheadTokens = Math.max(0, requestReserveTokens - toolSchemaTokens);
    const rawWindow = Number(session?.rawContextWindow || session?.contextWindow || 0);
    const effectiveWindow = Number(session?.contextWindow || rawWindow || 0);
    const lastContextTokens = Number(session?.lastContextTokens || 0);
    const estimatedContextTokens = estimateTranscriptContextUsage(messages, tools, {
      messageCount: messageSummary.count,
      estimatedMessageTokens: messageSummary.estimatedTokens,
    });
    const compactAt = Number(session?.compaction?.lastChangedAt || session?.compaction?.lastCompactAt || 0);
    const usageAt = Number(session?.lastContextTokensUpdatedAt || 0);
    const lastUsageStale = !!lastContextTokens && (
      session?.lastContextTokensStaleAfterCompact === true
      || (compactAt > 0 && usageAt > 0 && usageAt <= compactAt)
      || (compactAt > 0 && usageAt <= 0)
    );
    const compactBoundaryTokens = Number(session?.compactBoundaryTokens || session?.compaction?.boundaryTokens || 0);
    const displayWindow = compactBoundaryTokens || effectiveWindow;
    // The transcript estimate is the single source of truth for the displayed
    // context footprint. Provider-reported input_tokens (lastContextTokens)
    // swing non-monotonically and are not window-bounded on some providers
    // (e.g. OpenAI gpt-5.5 Responses API), so they are kept only as secondary
    // metadata (lastApiRequestTokens / usage.lastContextTokens) and never feed
    // the gauge numerator.
    const usedTokens = estimatedContextTokens;
    const freeTokens = displayWindow ? Math.max(0, displayWindow - usedTokens) : 0;
    // Use the same shared compact-policy math as manager/loop. Do not trust
    // persisted trigger telemetry as an independent policy input: it is an
    // output snapshot and was the source of repeated /context false positives.
    // Shared session-compaction policy (same math as manager/loop): agent-owned
    // semantic sessions report/fire at 90% of the boundary; main/user
    // recall-fasttrack report/fire on the boundary itself (100%).
    const compactPolicy = resolveSessionCompactPolicy(session || {}, compactBoundaryTokens);
    const compactTriggerTokens = compactPolicy.triggerTokens || 0;
    const compactBufferTokens = compactPolicy.bufferTokens || 0;
    const value = {
      sessionId: session?.id || null,
      provider: route.provider,
      model: route.model,
      cwd: getCurrentCwd(),
      toolMode: getMode(),
      contextWindow: displayWindow || effectiveWindow || null,
      effectiveContextWindow: effectiveWindow || null,
      rawContextWindow: rawWindow || null,
      effectiveContextWindowPercent: session?.effectiveContextWindowPercent || null,
      usedTokens,
      usedSource: 'estimated',
      currentEstimatedTokens: estimatedContextTokens,
      lastApiRequestTokens: lastContextTokens || 0,
      lastApiRequestStale: lastUsageStale,
      freeTokens,
      compaction: {
        ...(session?.compaction || {}),
        boundaryTokens: compactBoundaryTokens || null,
        triggerTokens: compactTriggerTokens || null,
        bufferTokens: compactBufferTokens || null,
        currentEstimatedTokens: estimatedContextTokens,
        lastApiRequestTokens: lastContextTokens || 0,
        lastApiRequestStale: lastUsageStale,
      },
      messages: messageSummary,
      request: {
        toolSchemaTokens,
        toolSchemaBreakdown,
        requestOverheadTokens,
        reserveTokens: requestReserveTokens,
      },
      usage: {
        lastInputTokens: Number(session?.lastInputTokens || 0),
        lastUncachedInputTokens: Number(session?.lastUncachedInputTokens || 0),
        lastOutputTokens: Number(session?.lastOutputTokens || 0),
        lastCachedReadTokens: Number(session?.lastCachedReadTokens || 0),
        lastCacheWriteTokens: Number(session?.lastCacheWriteTokens || 0),
        lastContextTokens,
        totalInputTokens: Number(session?.totalInputTokens || 0),
        totalUncachedInputTokens: Number(session?.totalUncachedInputTokens || 0),
        totalOutputTokens: Number(session?.totalOutputTokens || 0),
        totalCachedReadTokens: Number(session?.totalCachedReadTokens || 0),
        totalCacheWriteTokens: Number(session?.totalCacheWriteTokens || 0),
      },
    };
    contextStatusCacheKey = cacheKey;
    contextStatusCacheValue = value;
    return value;
  }

  return { contextStatus, invalidateContextStatusCache };
}
