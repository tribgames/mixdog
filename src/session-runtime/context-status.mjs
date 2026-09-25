// Live /context gauge computation with its self-owned memoization. The
// runtime injects live getters for the mutable session/route/cwd/mode locals;
// the shapes live in context-status-shape.mjs, the cache in
// context-status-cache.mjs and the inspector attachment in
// context-status-inspection.mjs. invalidateContextStatusCache() is returned
// for the runtime to call on catalog/route changes.
import {
  contextMessagesRevision,
  summarizeContextMessagesAtRevision,
  toolSchemaSignature,
} from '../runtime/agent/orchestrator/session/context-utils.mjs';
import { scopedProviderRequestTools } from './provider-request-tools.mjs';
import { hasRouteHistoryMessage } from './session-route-policy.mjs';
import { contextGauge, contextStatusValue, emptyContextStatus, requestTokenBudget } from './context-status-shape.mjs';
import { createContextStatusCache } from './context-status-cache.mjs';
import { createInspectionSnapshots } from './context-status-inspection.mjs';

const NO_NATIVE_TOOLS = Object.freeze([]);

export function createContextStatus({
  getSession,
  getRoute,
  getCurrentCwd,
  getMode,
  getNativeTools = () => NO_NATIVE_TOOLS,
}) {
  const cache = createContextStatusCache({ getNativeTools });
  const withInspection = createInspectionSnapshots();
  const env = () => ({ cwd: getCurrentCwd(), mode: getMode() });

  function contextStatus(options) {
    const session = getSession();
    const route = getRoute();
    const committedMessages = Array.isArray(session?.messages) ? session.messages : [];
    // Prefer the in-flight working transcript while a turn is running so the
    // context gauge reflects LIVE growth (user turn + tool calls/results) as
    // it accumulates, instead of freezing at the pre-turn committed snapshot.
    // askSession() sets session.liveTurnMessages for the turn duration and
    // clears it on commit/cancel/error, after which we fall back to the
    // authoritative committed transcript.
    const liveMessages = Array.isArray(session?.liveTurnMessages) ? session.liveTurnMessages : null;
    const messages = liveMessages || committedMessages;
    const active = hasRouteHistoryMessage(messages);
    if (!session?.id || !active) {
      return withInspection(emptyContextStatus(session, route, env()), [], [], options, session);
    }
    const requestProvider = session?.provider || route.provider;
    const messagesRevision = contextMessagesRevision(messages);
    // Do not even evaluate live native definitions when an in-flight request
    // scope owns the complete immutable provider surface.
    const scopedRequest = scopedProviderRequestTools(session, requestProvider, messages);
    const requestTools =
      scopedRequest?.requestTools || cache.requestTools(session, requestProvider, messages);
    const requestToolsSignature = toolSchemaSignature(requestTools);
    const key = cache.keyFor(session, route, env(), {
      messages,
      messagesRevision,
      requestProvider,
      requestTools,
      requestToolsSignature,
    });
    const cached = cache.lookup(key);
    if (cached) return withInspection(cached, messages, requestTools, options, session);

    const messageSummary = summarizeContextMessagesAtRevision(messages, messagesRevision);
    const value = contextStatusValue(session, route, env(), {
      messageSummary,
      request: requestTokenBudget(requestTools),
      gauge: contextGauge(session, route, requestTools, messages, messageSummary),
      hasConversationActivity: active,
    });
    cache.store(key, value);
    return withInspection(value, messages, requestTools, options, session);
  }

  return { contextStatus, invalidateContextStatusCache: cache.invalidate };
}

// One-shot gauge for a session that is NOT the runtime's current session (a
// listed/foreign session). The route is read off the session itself and the
// calculator is thrown away with its cache, so a foreign read can never poison
// the live gauge's memoization.
export function contextStatusForSession(session, { getMode, fallbackCwd = '' } = {}) {
  if (!session || typeof session !== 'object') return null;
  const { contextStatus } = createContextStatus({
    getSession: () => session,
    getRoute: () => ({
      provider: session.provider || '',
      model: session.model || '',
      contextWindow: session.contextWindow || null,
    }),
    getCurrentCwd: () => session.cwd || fallbackCwd,
    getMode,
  });
  return contextStatus();
}
