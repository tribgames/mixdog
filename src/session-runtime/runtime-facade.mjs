import { currentTurnEffort } from '../runtime/agent/orchestrator/session/turn-effort.mjs';
import { SESSION_ID_PATTERN } from '../runtime/agent/orchestrator/runtime-core/session-id.mjs';
import { SessionAddressError, bindSessionAddress } from './session-address.mjs';

function requiredSessionId(value) {
  const sessionId = String(value || '').trim();
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new TypeError('session id is invalid');
  }
  return sessionId;
}

export function createRuntimeFacade({
  state,
  leadingApi,
  goalApi,
  trailingApi,
  deliverToolCompletion,
  reserveSessionId,
  getAutoClear,
  getSystemShell,
  getWebSearchRoute,
  getWorkflow,
  getOrchestrationMode,
  getOutputStyle,
  getContextStatus,
  getContextStatusForSession,
  renameSessionTitle,
}) {
  // The durable address outlives the session object (terminal/closed, evicted).
  const currentSessionId = () => state.session?.id || state.reservedSessionId || state.addressedSessionId || null;
  return {
    ...leadingApi,
    isSessionTerminal: () => state.admission === 'terminal',
    /** Bind the durable address to the conversation this runtime just
     *  loaded (resume / load-on-demand). Idempotent for the same id. */
    bindSessionAddress(sessionId) {
      const id = requiredSessionId(sessionId);
      if (state.session?.id && state.session.id !== id) {
        throw new SessionAddressError(`runtime holds ${state.session.id}, not ${id}`, id);
      }
      return bindSessionAddress(state, id) === id;
    },
    get id() {
      return currentSessionId();
    },
    deliverToolCompletion(sessionId, text, meta = {}) {
      const target = String(sessionId || '').trim();
      if (!target || target !== String(currentSessionId() || '').trim()) return false;
      return deliverToolCompletion(target, text, meta);
    },
    reserveSessionId(sessionId) {
      const id = requiredSessionId(sessionId);
      reserveSessionId(id);
      return id;
    },
    ...goalApi,
    get provider() {
      return state.route.provider;
    },
    get model() {
      return state.route.model;
    },
    // The current session object's own route; diverges from provider/model
    // (the selected route) after a model change on a session with history.
    get sessionProvider() {
      return state.session?.provider ?? null;
    },
    get sessionModel() {
      return state.session?.model ?? null;
    },
    get effort() {
      return state.route.effectiveEffort || state.route.effort || state.route.preset?.effort || null;
    },
    get fast() {
      return state.route.fast === true;
    },
    // The route's Auto effort switch; absent means on.
    get autoEffort() {
      return state.route.autoEffort !== false;
    },
    get fastCapable() {
      return state.route.fastCapable === true;
    },
    get modelParameters() {
      return state.route.modelParameters || {};
    },
    // The effort the runtime resolved for the turn in flight (Auto judge), or null.
    get turnEffort() {
      return currentTurnEffort(state.session);
    },
    get effortOptions() {
      return state.route.effortOptions || [];
    },
    get contextWindow() {
      return state.session?.contextWindow || null;
    },
    get contextPercent() {
      // Picker preference for a new/inherited session, not the live gauge.
      return state.route?.contextPercent ?? state.session?.contextPercent ?? null;
    },
    get contextTokens() {
      // Exact window preference in tokens; null when the route uses a percent stop.
      return state.route ? state.route.contextTokens || null : state.session?.contextTokens || null;
    },
    get rawContextWindow() {
      return state.session?.rawContextWindow || state.session?.contextWindow || null;
    },
    get effectiveContextWindowPercent() {
      return state.session?.effectiveContextWindowPercent || null;
    },
    get toolMode() {
      return state.mode;
    },
    get autoClear() {
      return getAutoClear();
    },
    get systemShell() {
      return getSystemShell();
    },
    get webSearchRoute() {
      return getWebSearchRoute();
    },
    get workflow() {
      return getWorkflow();
    },
    get orchestrationMode() {
      return getOrchestrationMode();
    },
    get outputStyle() {
      return getOutputStyle();
    },
    get cwd() {
      return state.currentCwd;
    },
    get session() {
      return state.session;
    },
    /** Advances whenever another conversation (or none) is installed; a route
     *  selection captures it when enqueued (see model-route/route-ownership). */
    get sessionGeneration() {
      return state.sessionGeneration;
    },
    contextStatus(options) {
      return getContextStatus(options);
    },
    contextStatusForSession(session) {
      return getContextStatusForSession(session);
    },
    renameSessionTitle,
    get clientHostPid() {
      return state.session?.clientHostPid || process.pid;
    },
    ...trailingApi,
  };
}
