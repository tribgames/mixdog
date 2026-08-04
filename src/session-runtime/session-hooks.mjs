// session-hooks.mjs — attaches the standard hook-bus bridge properties
// (beforeToolHook / afterToolHook / afterToolFailureHook / afterToolBatchHook /
// preCompactHook / postCompactHook) onto a freshly created session object.
// Extracted from mixdog-session-runtime.mjs createCurrentSession(): a
// self-contained cluster whose only couplings are the hooks bus and the
// facade's hookCommonPayload / currentCwd accessor + the session itself. All
// properties are non-enumerable/configurable/writable exactly as before so the
// loop/manager can read them by name without changing session enumeration.

export function attachSessionHooks(session, { hooks, hookCommonPayload, getCwd }) {
  const currentCwd = () => getCwd();
  // PreToolUse bridge.
  Object.defineProperty(session, 'beforeToolHook', {
    value: (input) => hooks.beforeTool(hookCommonPayload({
      ...input,
      session_id: input?.sessionId || input?.session_id || session?.id,
      tool_name: input?.name || input?.tool_name,
      tool_input: input?.args || input?.tool_input,
      tool_use_id: input?.toolCallId || input?.tool_use_id,
      cwd: input?.cwd || currentCwd(),
    })),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  // PostToolUse: bridge runtime tool completions to the standard hook bus.
  // dispatch() returns a promise; the loop's afterToolHook caller already
  // try/catches, so a rejection cannot escape the tool loop.
  Object.defineProperty(session, 'afterToolHook', {
    value: (input) => hooks.dispatch('PostToolUse', hookCommonPayload({
      session_id: input?.sessionId || input?.session_id || session?.id,
      cwd: input?.cwd || currentCwd(),
      tool_name: input?.name,
      tool_input: input?.args,
      tool_use_id: input?.toolCallId || input?.tool_use_id,
      tool_response: input?.result,
    })),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  // PostToolUseFailure: dispatched by loop.mjs only when a tool execution
  // resolved to a failure (thrown-error path or an is_error result). Same
  // shape as afterToolHook; `result` carries the error text. Best-effort.
  Object.defineProperty(session, 'afterToolFailureHook', {
    value: (input) => hooks.dispatch('PostToolUseFailure', hookCommonPayload({
      session_id: input?.sessionId || input?.session_id || session?.id,
      cwd: input?.cwd || currentCwd(),
      tool_name: input?.name,
      tool_input: input?.args,
      tool_use_id: input?.toolCallId || input?.tool_use_id,
      tool_response: input?.result,
    })),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  // PostToolBatch: dispatched by loop.mjs after a full parallel batch of
  // tool calls resolves and before the next model call. No matcher event.
  Object.defineProperty(session, 'afterToolBatchHook', {
    value: (input) => hooks.dispatch('PostToolBatch', hookCommonPayload({
      session_id: input?.sessionId || input?.session_id || session?.id,
      cwd: input?.cwd || currentCwd(),
    })),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  // PreCompact / PostCompact: dispatched by manager.mjs/loop.mjs compaction
  // flow via these session-property hooks (manager has no hooks bus access).
  // payload { trigger: 'auto' | 'manual' }. Best-effort.
  Object.defineProperty(session, 'preCompactHook', {
    value: (input) => hooks.dispatch('PreCompact', hookCommonPayload({
      session_id: input?.sessionId || input?.session_id || session?.id,
      cwd: input?.cwd || currentCwd(),
      trigger: input?.trigger || 'auto',
    })),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(session, 'postCompactHook', {
    value: (input) => hooks.dispatch('PostCompact', hookCommonPayload({
      session_id: input?.sessionId || input?.session_id || session?.id,
      cwd: input?.cwd || currentCwd(),
      trigger: input?.trigger || 'auto',
    })),
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return session;
}
