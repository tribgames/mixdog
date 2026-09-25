// Memoization for the /context gauge: the status value keyed on every input it
// was computed from, and the provider request-tool snapshot the gauge meters.
import { snapshotProviderRequestTools } from './tool-catalog.mjs';
import { sessionTokenCounters } from './context-status-shape.mjs';

// Mirrors the tool-list portion of the Anthropic adapters without changing
// their wire serialization. Other native-deferred providers expose the
// catalog through BP2/system content, which is already metered there. The
// caller consults an in-flight request scope first; this is the live fallback.
function requestSerializedToolsForContext(session, provider, messages, nativeTools) {
  return snapshotProviderRequestTools({ provider, tools: session?.tools, nativeTools, messages, session });
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

  function keyFor(
    session,
    route,
    env,
    { messages, messagesRevision, requestProvider, requestTools, requestToolsSignature }
  ) {
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
    },
    // The gauge runs on a 2s pulse per session. The snapshot memoizes itself
    // per tool array (see provider-request-snapshot.mjs), so an unchanged
    // catalog and transcript return the same frozen list without normalizing
    // any schema, and an appended message is the only transcript entry read.
    requestTools(session, requestProvider, messages) {
      return requestSerializedToolsForContext(session, requestProvider, messages, getNativeTools());
    },
  };
}
