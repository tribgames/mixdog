function requiredSessionId(value) {
  const sessionId = String(value || '').trim();
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
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
  getOutputStyle,
  getContextStatus,
  getContextStatusForSession,
  renameSessionTitle,
}) {
  const currentSessionId = () => state.session?.id || state.reservedSessionId || null;
  return {
    ...leadingApi,
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
    get effort() {
      return state.route.effectiveEffort || state.route.effort || state.route.preset?.effort || null;
    },
    get fast() {
      return state.route.fast === true;
    },
    get fastCapable() {
      return state.route.fastCapable === true;
    },
    get modelParameters() {
      return state.route.modelParameters || {};
    },
    get effortOptions() {
      return state.route.effortOptions || [];
    },
    get contextWindow() {
      return state.session?.contextWindow || null;
    },
    get contextPercent() {
      return state.session?.contextPercent ?? state.route?.contextPercent ?? null;
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
    get outputStyle() {
      return getOutputStyle();
    },
    get cwd() {
      return state.currentCwd;
    },
    get session() {
      return state.session;
    },
    contextStatus() {
      return getContextStatus();
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
