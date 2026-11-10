// Live-callback plumbing between a dispatch caller and askSession: which
// observer callbacks a call carries, how they are bound to the prepared
// session, and the positional onToolCall + askOpts bag askSession receives.

const AGENT_DISPATCH_LIVE_CALLBACKS = Object.freeze([
  'onSessionStart',
  'onStageChange',
  'onReasoningDelta',
  'onTextDelta',
  'onTextReset',
  'onAssistantText',
  'onAssistantMessageCommitted',
  'onToolCall',
  'onToolResult',
]);

function pickDispatchCallback(factoryOpts, callArgs, name) {
  if (typeof callArgs?.[name] === 'function') return callArgs[name];
  if (typeof factoryOpts?.[name] === 'function') return factoryOpts[name];
  return undefined;
}

/**
 * Resolve live Agent-dispatch callbacks.
 *
 * `liveProjection` is a send-opt. It is true when the caller explicitly
 * sets it or supplies a live-text callback (onTextDelta / onAssistantText /
 * onTextReset). Tool/stage/reasoning observers do not un-suppress provider
 * streaming. The flag must never be written onto the session object.
 *
 * @param {object} [factoryOpts]
 * @param {object} [callArgs]
 * @returns {{ callbacks: object, liveProjection: boolean }}
 */
export function resolveAgentDispatchLiveCallbacks(factoryOpts = {}, callArgs = {}) {
  const callbacks = {};
  for (const name of AGENT_DISPATCH_LIVE_CALLBACKS) {
    const fn = pickDispatchCallback(factoryOpts, callArgs, name);
    if (fn) callbacks[name] = fn;
  }
  const liveProjection =
    factoryOpts.liveProjection === true ||
    callArgs.liveProjection === true ||
    typeof callbacks.onTextDelta === 'function' ||
    typeof callbacks.onAssistantText === 'function' ||
    typeof callbacks.onTextReset === 'function';
  return { callbacks, liveProjection };
}

/**
 * Adapt askSession's session-less callback signatures to the host contract
 * by prepending the prepared session on every call:
 *   onSessionStart(session)
 *   onStageChange(session, stage, detail)
 *   onReasoningDelta(session, chunk)
 *   onTextDelta(session, chunk)
 *   onTextReset(session, detail)  — return value is passed through unchanged
 *   onAssistantText(session, text)
 *   onAssistantMessageCommitted(session)
 *   onToolCall(session, iteration, calls)
 *   onToolResult(session, message)
 */
export function bindAgentDispatchHostCallbacks(hostCallbacks = {}, session) {
  const bound = {};
  if (typeof hostCallbacks.onSessionStart === 'function') {
    bound.onSessionStart = () => hostCallbacks.onSessionStart(session);
  }
  if (typeof hostCallbacks.onStageChange === 'function') {
    bound.onStageChange = (stage, detail) => hostCallbacks.onStageChange(session, stage, detail);
  }
  if (typeof hostCallbacks.onReasoningDelta === 'function') {
    bound.onReasoningDelta = (chunk) => hostCallbacks.onReasoningDelta(session, chunk);
  }
  if (typeof hostCallbacks.onTextDelta === 'function') {
    bound.onTextDelta = (chunk) => hostCallbacks.onTextDelta(session, chunk);
  }
  if (typeof hostCallbacks.onTextReset === 'function') {
    bound.onTextReset = (detail) => hostCallbacks.onTextReset(session, detail);
  }
  if (typeof hostCallbacks.onAssistantText === 'function') {
    bound.onAssistantText = (text) => hostCallbacks.onAssistantText(session, text);
  }
  if (typeof hostCallbacks.onAssistantMessageCommitted === 'function') {
    bound.onAssistantMessageCommitted = () => hostCallbacks.onAssistantMessageCommitted(session);
  }
  if (typeof hostCallbacks.onToolCall === 'function') {
    bound.onToolCall = (iteration, calls) => hostCallbacks.onToolCall(session, iteration, calls);
  }
  if (typeof hostCallbacks.onToolResult === 'function') {
    bound.onToolResult = (message) => hostCallbacks.onToolResult(session, message);
  }
  return bound;
}

/**
 * Build the positional `onToolCall` + askOpts bag forwarded to askSession.
 * `interactiveSessionSurface` is intentionally dropped — that in-memory
 * hint is owned by the standalone surface and must not be persisted or
 * re-homed onto a dispatch session.
 */
export function buildAgentDispatchAskSessionArgs(factoryOpts = {}, callArgs = {}, extraAskOpts = {}, session = null) {
  const { callbacks, liveProjection } = resolveAgentDispatchLiveCallbacks(factoryOpts, callArgs);
  const bound = session && typeof session === 'object' ? bindAgentDispatchHostCallbacks(callbacks, session) : callbacks;
  const onToolCall = typeof bound.onToolCall === 'function' ? bound.onToolCall : null;
  const askOpts = { liveProjection };
  for (const name of AGENT_DISPATCH_LIVE_CALLBACKS) {
    if (name === 'onToolCall') continue;
    if (typeof bound[name] === 'function') askOpts[name] = bound[name];
  }
  const extraCompact = extraAskOpts.onCompactEvent;
  if (typeof extraCompact === 'function') {
    const callerCompact = askOpts.onCompactEvent;
    askOpts.onCompactEvent = (event) => {
      extraCompact(event);
      try {
        callerCompact?.(event);
      } catch {
        /* best-effort */
      }
    };
  }
  for (const [key, value] of Object.entries(extraAskOpts)) {
    if (key === 'onCompactEvent' || key === 'liveProjection') continue;
    if (key === 'interactiveSessionSurface') continue;
    if (value !== undefined) askOpts[key] = value;
  }
  return { onToolCall, askOpts };
}
