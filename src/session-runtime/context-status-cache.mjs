// Memoization for the /context gauge: the status value keyed on every input it
// was computed from, and the provider request-tool snapshot the gauge meters.
import { snapshotProviderRequestTools } from './tool-catalog.mjs';
import { scopedProviderRequestTools } from './provider-request-tools.mjs';
import { sessionTokenCounters } from './context-status-shape.mjs';

// Mirrors the tool-list portion of the Anthropic adapters without changing
// their wire serialization. Other native-deferred providers expose the
// catalog through BP2/system content, which is already metered there.
function requestSerializedToolsForContext(session, provider, messages = session?.messages, { nativeTools = [] } = {}) {
  return (
    scopedProviderRequestTools(session, provider, messages)?.requestTools ||
    snapshotProviderRequestTools({
      provider,
      tools: session?.tools,
      nativeTools,
      messages,
      session,
    })
  );
}

function sameCacheKey(a, b) {
  if (!a || !b) return false;
  for (const key of Object.keys(a)) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

export function createContextStatusCache({ getNativeTools }) {
  let cacheKey = null;
  let cacheValue = null;
  // The gauge runs on a 2s pulse per session; snapshotting every tool schema
  // (deep normalization of the whole catalog) on each tick dominated idle CPU.
  // Reuse the last snapshot while its inputs are the same references; the
  // runtime calls invalidate() on catalog/route changes.
  let requestToolsMemo = null;

  function keyFor(session, route, env, { messages, messagesRevision, requestProvider, requestTools, requestToolsSignature }) {
    const compaction = session?.compaction || {};
    const lastMessage = messages[messages.length - 1] || null;
    return {
      session,
      sessionId: session?.id || null,
      provider: session?.provider || route.provider,
      model: session?.model || route.model,
      cwd: env.cwd,
      mode: env.mode,
      messages,
      messageCount: messages.length,
      messagesRevision,
      lastMessage,
      lastMessageRole: lastMessage?.role || null,
      lastMessageContent: lastMessage?.content || null,
      toolCount: requestTools.length,
      toolsSignature: requestToolsSignature,
      requestProvider,
      requestToolCount: requestTools.length,
      requestToolsSignature,
      contextWindow: session?.contextWindow || null,
      rawContextWindow: session?.rawContextWindow || null,
      effectiveContextWindowPercent: session?.effectiveContextWindowPercent || null,
      ...sessionTokenCounters(session),
      compactionBoundaryTokens: Number(compaction.boundaryTokens || 0),
      compactionTriggerTokens: Number(compaction.triggerTokens || 0),
      compactionLastChangedAt: Number(compaction.lastChangedAt || 0),
      compactionLastCompactAt: Number(compaction.lastCompactAt || 0),
      contextUsageSnapshot: session?.contextUsageSnapshot || null,
    };
  }

  return {
    keyFor,
    /** The memoized status when `key` matches the last computation. */
    lookup(key) {
      return cacheValue && sameCacheKey(key, cacheKey) ? cacheValue : null;
    },
    store(key, value) {
      cacheKey = key;
      cacheValue = value;
    },
    invalidate() {
      cacheKey = null;
      cacheValue = null;
      requestToolsMemo = null;
    },
    requestTools(session, requestProvider, messages, messagesRevision) {
      const tools = session?.tools;
      const nativeTools = getNativeTools();
      const toolCount = Array.isArray(tools) ? tools.length : 0;
      const nativeCount = Array.isArray(nativeTools) ? nativeTools.length : 0;
      const memo = requestToolsMemo;
      if (
        memo &&
        memo.session === session &&
        memo.tools === tools &&
        memo.toolCount === toolCount &&
        memo.nativeCount === nativeCount &&
        // Callers may hand back a fresh empty array per call; identity only
        // matters once there is something in it.
        (nativeCount === 0 || memo.nativeTools === nativeTools) &&
        memo.requestProvider === requestProvider &&
        memo.messagesRevision === messagesRevision
      )
        return memo.requestTools;
      const requestTools = requestSerializedToolsForContext(session, requestProvider, messages, { nativeTools });
      requestToolsMemo = {
        session,
        tools,
        toolCount,
        nativeTools,
        nativeCount,
        requestProvider,
        messagesRevision,
        requestTools,
      };
      return requestTools;
    },
  };
}
