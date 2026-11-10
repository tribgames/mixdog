// Session actions whose protocol method or params are not the verbatim `<namespace>/<action>` form of
// action-namespaces.mjs (protocol.md §12.2–§12.4). Each builder maps today's positional arguments to
// `{ method, params }`; `ctx.threadId` is the thread the view is bound to. `opId` is the client library's.

const withDefined = (params) => Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

export const ACTION_OVERRIDES = Object.freeze({
  clear: (_args, { threadId }) => ({ method: 'thread/clear', params: { threadId } }),
  compact: ([options], { threadId }) => ({
    method: 'thread/compact/start',
    params: withDefined({ threadId, options }),
  }),
  rewindToItem: ([itemId, options], { threadId }) => ({
    method: 'thread/rewind',
    params: { threadId, itemId, restoreFiles: object(options).restoreFiles ?? true },
  }),
  renameSessionTitle: ([sessionId, title]) => ({
    method: 'thread/name/set',
    params: { threadId: sessionId, title },
  }),
  deleteSession: ([sessionId]) => ({ method: 'thread/delete', params: { threadId: sessionId } }),
  deleteSessionIfIdle: ([sessionId, expected]) => ({
    method: 'thread/delete',
    params: withDefined({ threadId: sessionId, ifIdle: expected }),
  }),
  stopShellJob: ([taskId], { threadId }) => ({
    method: 'thread/backgroundTerminals/terminate',
    params: { threadId, taskId },
  }),
  releaseShellJob: ([taskId], { threadId }) => ({
    method: 'thread/backgroundTerminals/release',
    params: { threadId, taskId },
  }),
  stopShellJobs: (_args, { threadId }) => ({ method: 'thread/backgroundTerminals/clean', params: { threadId } }),
  scheduleQuotaResume: ([sessionId]) => ({
    method: 'thread/quotaResume/schedule',
    params: { threadId: sessionId },
  }),
  cancelQuotaResume: ([sessionId]) => ({
    method: 'thread/quotaResume/cancel',
    params: { threadId: sessionId },
  }),
  retryFailedTurn: ([sessionId, turnKey]) => ({
    method: 'turn/retryFailed',
    params: { threadId: sessionId, turnKey },
  }),
  continueSessionInModel: ([sessionId, route]) => ({
    method: 'thread/continueInModel',
    params: { threadId: sessionId, route },
  }),
  // The bound thread is the already-created heir; the source is the argument.
  inheritFrom: ([sourceSessionId, options], { threadId }) => ({
    method: 'thread/fork',
    params: withDefined({
      threadId: sourceSessionId,
      intoThreadId: threadId,
      route: object(options).route,
      compact: object(options).compact,
    }),
  }),
  goalControl: ([args], { threadId }) => {
    const { action } = object(args);
    if (action === 'set') return { method: 'thread/goal/set', params: { threadId, goal: args } };
    if (action === 'clear') return { method: 'thread/goal/clear', params: { threadId } };
    return { method: 'thread/goal/control', params: withDefined({ threadId, action: action ?? 'command', args }) };
  },
  listProviderModels: ([options]) => ({ method: 'model/list', params: withDefined(object(options)) }),
  setFast: ([on], { threadId }) => ({ method: 'fast/set', params: { threadId, on } }),
  setRoute: ([route], { threadId }) => ({ method: 'route/set', params: { threadId, route } }),
});

/**
 * Where each override's thread comes from, declared per override (every key of `ACTION_OVERRIDES` has one):
 * - `session`: the call's session (`ctx.threadId`) is the thread the request addresses.
 * - `argument`: the thread is an argument (`sessionId`); the call's session plays no part in it. `inheritFrom` is one: its
 *   `threadId` is the source argument, and `intoThreadId` is the session the call is already bound to.
 * - `argument-else-session`: an argument, and when it is left out the call's session (`retryFailedTurn`).
 * - `none`: the request carries no thread.
 */
export const OVERRIDE_THREAD_SOURCE = Object.freeze({
  clear: 'session',
  compact: 'session',
  rewindToItem: 'session',
  renameSessionTitle: 'argument',
  deleteSession: 'argument',
  deleteSessionIfIdle: 'argument',
  stopShellJob: 'session',
  releaseShellJob: 'session',
  stopShellJobs: 'session',
  scheduleQuotaResume: 'argument',
  cancelQuotaResume: 'argument',
  retryFailedTurn: 'argument-else-session',
  continueSessionInModel: 'argument',
  inheritFrom: 'argument',
  goalControl: 'session',
  listProviderModels: 'none',
  setFast: 'session',
  setRoute: 'session',
});
