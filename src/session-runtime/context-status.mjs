import {
  estimateRequestReserveTokens,
  estimateToolSchemaTokens,
  contextMessagesRevision,
  resolveSessionCompactPolicy,
  summarizeContextMessages,
  toolSchemaSignature,
} from '../runtime/agent/orchestrator/session/context-utils.mjs';
import { SUMMARY_PREFIX } from '../runtime/agent/orchestrator/session/compact.mjs';
import { hasUserConversationMessage } from '../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import {
  resolveCompactionPressureTokens,
  resolveWorkerCompactPolicy,
} from '../runtime/agent/orchestrator/session/loop/compact-policy.mjs';
import {
  estimateToolSchemaBreakdown,
  snapshotProviderRequestTools,
} from './tool-catalog.mjs';
import { scopedProviderRequestTools } from './provider-request-tools.mjs';

// Mirrors the tool-list portion of the Anthropic adapters without changing
// their wire serialization. Other native-deferred providers expose the
// catalog through BP1/system content, which is already metered there.
export function requestSerializedToolsForContext(
  session,
  provider,
  messages = session?.messages,
  { nativeTools = [] } = {},
) {
  return scopedProviderRequestTools(session, provider, messages)?.requestTools
    || snapshotProviderRequestTools({
    provider,
    tools: session?.tools,
    nativeTools,
    messages,
    session,
  });
}

// Live /context gauge computation + its self-owned memoization cache. Extracted
// verbatim from the runtime API object; the runtime injects live getters for
// the mutable session/route/cwd/mode locals. The cache (key + value) is owned
// here now, so invalidateContextStatusCache() is returned for the runtime to
// call from the same places it used to clear the inline locals.
export function createContextStatus({
  getSession,
  getRoute,
  getCurrentCwd,
  getMode,
  getNativeTools = () => [],
}) {
  let contextStatusCacheKey = null;
  let contextStatusCacheValue = null;

  function contextStatusCacheKeyFor({
    messages,
    messagesRevision,
    toolsSignature,
    requestProvider,
    requestToolCount,
    requestToolsSignature,
  }) {
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
      messagesRevision,
      lastMessage,
      lastMessageRole: lastMessage?.role || null,
      lastMessageContent: lastMessage?.content || null,
      toolCount: requestToolCount,
      toolsSignature,
      requestProvider,
      requestToolCount,
      requestToolsSignature,
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
      contextPressureBaselineTokens: Number(session?.contextPressureBaselineTokens || 0),
      contextPressureBaselineOutputTokens: Number(session?.contextPressureBaselineOutputTokens || 0),
      contextPressureBaselineMessageCount: Number(session?.contextPressureBaselineMessageCount ?? -1),
      contextPressureBaselineUpdatedAt: Number(session?.contextPressureBaselineUpdatedAt || 0),
      contextPressureBaselineBoundary: session?.contextPressureBaselineBoundary || null,
      contextPressureBaselineProvider: session?.contextPressureBaselineProvider || null,
      contextPressureBaselineModel: session?.contextPressureBaselineModel || null,
      contextPressureBaselineToolSignature: session?.contextPressureBaselineToolSignature || null,
      contextPressureBaselinePrefixSignature: session?.contextPressureBaselinePrefixSignature || null,
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
    const committedMessages = Array.isArray(session?.messages) ? session.messages : [];
    const liveMessages = Array.isArray(session?.liveTurnMessages) ? session.liveTurnMessages : null;
    const activityMessages = liveMessages || committedMessages;
    const hasConversationActivity = hasUserConversationMessage(activityMessages)
      || activityMessages.some((message) => (
        message?.role === 'user'
        && typeof message.content === 'string'
        && message.content.startsWith(SUMMARY_PREFIX)
      ));
    // A route is not a conversation. Keep a pristine desktop/TUI task truly
    // empty until the first real turn. Remote auto-start may prepare a local
    // session shell containing system/tool templates, but those templates have
    // not entered a provider request and must not appear as consumed context.
    if (!session?.id || !hasConversationActivity) {
      const emptyCompactPolicy = session
        ? resolveWorkerCompactPolicy(session, Array.isArray(session.tools) ? session.tools : [])
        : null;
      const routeWindow = Math.max(0, Number(
        session?.compactBoundaryTokens
        || session?.contextWindow
        || route?.contextWindow
        || 0,
      ));
      return {
        sessionId: session?.id || null,
        provider: route.provider,
        model: route.model,
        cwd: getCurrentCwd(),
        toolMode: getMode(),
        contextWindow: routeWindow || null,
        effectiveContextWindow: routeWindow || null,
        rawContextWindow: routeWindow || null,
        effectiveContextWindowPercent: null,
        usedTokens: 0,
        usedSource: 'empty',
        currentEstimatedTokens: 0,
        lastApiRequestTokens: 0,
        lastApiRequestStale: false,
        freeTokens: routeWindow,
        compaction: {
          boundaryTokens: Number(session?.compactBoundaryTokens || emptyCompactPolicy?.boundaryTokens || 0) || null,
          triggerTokens: Number(emptyCompactPolicy?.triggerTokens || 0) || null,
          bufferTokens: Number(emptyCompactPolicy?.bufferTokens || 0) || null,
          bufferRatio: Number.isFinite(emptyCompactPolicy?.bufferRatio)
            ? emptyCompactPolicy.bufferRatio
            : null,
          currentEstimatedTokens: 0,
          lastApiRequestTokens: 0,
          lastApiRequestStale: false,
        },
        messages: summarizeContextMessages([]),
        request: {
          toolSchemaTokens: 0,
          toolSchemaBreakdown: {},
          requestOverheadTokens: 0,
          reserveTokens: 0,
        },
        usage: {
          lastInputTokens: 0,
          lastUncachedInputTokens: 0,
          lastOutputTokens: 0,
          lastCachedReadTokens: 0,
          lastCacheWriteTokens: 0,
          lastContextTokens: 0,
          totalInputTokens: 0,
          totalUncachedInputTokens: 0,
          totalOutputTokens: 0,
          totalCachedReadTokens: 0,
          totalCacheWriteTokens: 0,
        },
      };
    }
    // Prefer the in-flight working transcript while a turn is running so the
    // context gauge reflects LIVE growth (user turn + tool calls/results) as
    // it accumulates, instead of freezing at the pre-turn committed snapshot.
    // askSession() sets session.liveTurnMessages for the turn duration and
    // clears it on commit/cancel/error, after which we fall back to the
    // authoritative committed transcript.
    const messages = activityMessages;
    const requestProvider = session?.provider || route.provider;
    // Do not even evaluate live native definitions when an in-flight request
    // scope owns the complete immutable provider surface.
    const scopedRequest = scopedProviderRequestTools(session, requestProvider, messages);
    const requestTools = scopedRequest?.requestTools
      || requestSerializedToolsForContext(session, requestProvider, messages, {
        nativeTools: getNativeTools(),
      });
    const messagesRevision = contextMessagesRevision(messages);
    const requestToolsSignature = toolSchemaSignature(requestTools);
    const cacheKey = contextStatusCacheKeyFor({
      messages,
      messagesRevision,
      toolsSignature: requestToolsSignature,
      requestProvider,
      requestToolCount: requestTools.length,
      requestToolsSignature,
    });
    if (contextStatusCacheValue && sameContextStatusCacheKey(cacheKey, contextStatusCacheKey)) {
      return contextStatusCacheValue;
    }

    const messageSummary = summarizeContextMessages(messages);
    const toolSchemaTokens = estimateToolSchemaTokens(requestTools);
    const toolSchemaBreakdown = estimateToolSchemaBreakdown(requestTools);
    const requestReserveTokens = estimateRequestReserveTokens(requestTools);
    const requestOverheadTokens = Math.max(0, requestReserveTokens - toolSchemaTokens);
    const rawWindow = Number(session?.rawContextWindow || session?.contextWindow || 0);
    const effectiveWindow = Number(session?.contextWindow || rawWindow || 0);
    const lastContextTokens = Number(session?.lastContextTokens || 0);
    const compactAt = Number(session?.compaction?.lastChangedAt || session?.compaction?.lastCompactAt || 0);
    const usageAt = Number(session?.lastContextTokensUpdatedAt || 0);
    const lastUsageStale = !!lastContextTokens && (
      session?.lastContextTokensStaleAfterCompact === true
      || (compactAt > 0 && usageAt > 0 && usageAt <= compactAt)
      || (compactAt > 0 && usageAt <= 0)
    );
    const compactBoundaryTokens = Number(session?.compactBoundaryTokens || session?.compaction?.boundaryTokens || 0);
    const displayWindow = compactBoundaryTokens || effectiveWindow;
    // Use the worker policy when a boundary is available so target/reserve
    // headroom, trigger, buffer tokens, and buffer ratio stay identical to the
    // auto-compact decision. Fall back only for incomplete session metadata.
    // Meter the same pure provider-visible projection used by pre-send
    // compaction and the actual agent-loop send/baseline fingerprint.
    const workerCompactPolicy = resolveWorkerCompactPolicy(session, requestTools);
    const compactPolicy = workerCompactPolicy?.boundaryTokens
      ? workerCompactPolicy
      : resolveSessionCompactPolicy(session || {}, compactBoundaryTokens);
    // Match the pre-provider-send auto-compact check exactly: the gauge uses
    // the same provider-baseline-or-estimate pressure, including request and
    // configured reserves, rather than a separate transcript-only estimate.
    const compactionPressureTokens = resolveCompactionPressureTokens(
      messageSummary.estimatedTokens,
      compactPolicy,
      { messages, sessionRef: session },
    );
    const usedTokens = compactionPressureTokens;
    const freeTokens = displayWindow ? Math.max(0, displayWindow - usedTokens) : 0;
    const compactTriggerTokens = compactPolicy.triggerTokens || 0;
    const compactBufferTokens = compactPolicy.bufferTokens || 0;
    const compactBufferRatio = Number.isFinite(compactPolicy.bufferRatio)
      ? compactPolicy.bufferRatio
      : null;
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
      currentEstimatedTokens: compactionPressureTokens,
      lastApiRequestTokens: lastContextTokens || 0,
      lastApiRequestStale: lastUsageStale,
      freeTokens,
      compaction: {
        ...(session?.compaction || {}),
        boundaryTokens: compactBoundaryTokens || null,
        triggerTokens: compactTriggerTokens || null,
        bufferTokens: compactBufferTokens || null,
        bufferRatio: compactBufferRatio,
        currentEstimatedTokens: compactionPressureTokens,
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
