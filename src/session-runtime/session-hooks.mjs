// session-hooks.mjs — attaches the standard hook-bus bridge properties
// (beforeToolHook / afterToolHook / afterToolFailureHook / afterToolBatchHook /
// preCompactHook / postCompactHook) onto a freshly created session object.
// A self-contained cluster whose only couplings are the hooks bus and the
// facade's hookCommonPayload / currentCwd accessor + the session itself. All
// properties are non-enumerable/configurable/writable so the loop/manager can
// read them by name without changing session enumeration.
import { roomMemberOfSession } from '../runtime/agent/orchestrator/session/agent-room.mjs';
import { roomMemberToolDecision } from './room-member-gate.mjs';

export function attachSessionHooks(session, { hooks, hookCommonPayload, getCwd }) {
  const identity = (input) => ({
    session_id: input?.sessionId || input?.session_id || session?.id,
    cwd: input?.cwd || getCwd(),
  });
  const toolPayload = (input) => ({
    ...identity(input),
    tool_name: input?.name,
    tool_input: input?.args,
    tool_use_id: input?.toolCallId || input?.tool_use_id,
    tool_response: input?.result,
  });
  // payload { trigger: 'auto' | 'manual' }.
  const compactPayload = (input) => ({ ...identity(input), trigger: input?.trigger || 'auto' });
  const define = (name, value) =>
    Object.defineProperty(session, name, { value, enumerable: false, configurable: true, writable: true });
  // dispatch() returns a promise; every caller already try/catches, so a
  // rejection cannot escape the tool loop or the compaction flow.
  const dispatcher = (event, payload) => (input) => hooks.dispatch(event, hookCommonPayload(payload(input)));

  // PreToolUse bridge. A group-room member's mutating calls always ask the
  // user (room-member-gate.mjs), whatever the hooks decided short of a deny.
  define('beforeToolHook', async (input, options = {}) => {
    const name = input?.name || input?.tool_name;
    const args = input?.args || input?.tool_input;
    const cwd = input?.cwd || getCwd();
    const decision = await hooks.beforeTool(
      hookCommonPayload({
        ...input,
        session_id: input?.sessionId || input?.session_id || session?.id,
        tool_name: name,
        tool_input: args,
        tool_use_id: input?.toolCallId || input?.tool_use_id,
        cwd,
      }),
      options
    );
    if (!roomMemberOfSession(session?.id)) return decision;
    return roomMemberToolDecision({ name, args, cwd }, decision);
  });
  // PostToolUse: bridge runtime tool completions to the standard hook bus.
  define('afterToolHook', dispatcher('PostToolUse', toolPayload));
  // PostToolUseFailure: dispatched by loop.mjs only when a tool execution
  // resolved to a failure (thrown-error path or an is_error result). Same
  // shape as afterToolHook; `result` carries the error text. Best-effort.
  define('afterToolFailureHook', dispatcher('PostToolUseFailure', toolPayload));
  // PostToolBatch: dispatched by loop.mjs after a full parallel batch of
  // tool calls resolves and before the next model call. No matcher event.
  define('afterToolBatchHook', dispatcher('PostToolBatch', identity));
  // PreCompact / PostCompact: dispatched by manager.mjs/loop.mjs compaction
  // flow via these session-property hooks (manager has no hooks bus access).
  define('preCompactHook', dispatcher('PreCompact', compactPayload));
  define('postCompactHook', dispatcher('PostCompact', compactPayload));
  return session;
}
