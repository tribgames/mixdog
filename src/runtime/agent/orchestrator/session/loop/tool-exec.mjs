// Route tool calls through policy hooks, cancellation and scoped-cache tracking.
//
//   tool-exec/call-prep.mjs          — live cwd, coerced args, scoped cache, completion notifier
//   tool-exec/before-hook.mjs        — PreToolUse deny / rewrite / ask
//   tool-exec/dispatch.mjs           — executor per tool family
//   tool-exec/after-hook.mjs         — PostToolUse result override
//   tool-exec/read-only-deadline.mjs — bounded read-only I/O with partial-output grace
import { isMcpTool } from '../../mcp/client.mjs';
import { prepareDeferredToolCallThrough } from './deferred-call-through.mjs';
import { refreshDeferredMcpToolCatalog } from '../../../../../session-runtime/tool-catalog.mjs';
import { preDispatchDenyForSession, routeWebFetchCall } from './pre-dispatch-deny.mjs';
import { runWithToolExecutionOwner } from '../../../../shared/tool-execution-owner.mjs';
import { runWithLocalSearchTelemetry } from '../../tools/builtin/local-search-telemetry.mjs';
import { throwIfAborted } from '../../../../shared/abort-race.mjs';
import { prepareToolCall } from './tool-exec/call-prep.mjs';
import { applyBeforeToolHook } from './tool-exec/before-hook.mjs';
import { dispatchToolCall } from './tool-exec/dispatch.mjs';
import { applyAfterToolHook } from './tool-exec/after-hook.mjs';
import { runReadOnlyIoWithDeadline } from './tool-exec/read-only-deadline.mjs';

export { runReadOnlyIoWithDeadline as _runReadOnlyIoWithDeadlineForTest };
export {
  resolveToolCompletionSessionId,
  resolveLiveToolCwd,
  _scopedCacheOutcomeForCall,
} from './tool-exec/call-prep.mjs';

export function executeTool(name, args, cwd, callerSessionId, sessionRef, executeOpts = {}) {
  return runWithToolExecutionOwner(callerSessionId, () =>
    runWithLocalSearchTelemetry(executeOpts.localSearchTelemetry, () =>
      executeToolOwned(name, args, cwd, callerSessionId, sessionRef, executeOpts)
    )
  );
}

const hookFrom = (executeOpts, sessionRef, key) =>
  typeof executeOpts[key] === 'function' ? executeOpts[key] : sessionRef?.[key];

async function executeToolOwned(name, args, cwd, callerSessionId, sessionRef, executeOpts = {}) {
  throwIfAborted(executeOpts.signal);
  const prepared = prepareToolCall(name, args, cwd, callerSessionId, sessionRef, executeOpts);
  const { toolOpts, notifyFn, completionToolOpts } = prepared;
  const toolApprovalHook = hookFrom(executeOpts, sessionRef, 'toolApprovalHook');
  const hooked = await applyBeforeToolHook({
    name,
    args: prepared.args,
    cwd: prepared.cwd,
    callerSessionId,
    executeOpts,
    beforeToolHook: hookFrom(executeOpts, sessionRef, 'beforeToolHook'),
    toolApprovalHook,
  });
  if (hooked.denial) return hooked.denial;
  // A decision can settle after its turn was cancelled. It must never
  // authorize a new mutation, even if the hook ignores the abort signal.
  throwIfAborted(executeOpts.signal);
  // A hook may replace the tool name, so pass the final call through the
  // same eager/serial boundary again. This prevents a rename from bypassing
  // role scoping and also applies built-in web_fetch transport routing.
  const finalCall = { name: hooked.name, arguments: hooked.args };
  routeWebFetchCall(finalCall);
  const denial = preDispatchDenyForSession(sessionRef, finalCall);
  if (denial !== null) return denial;
  const call = { name: finalCall.name, args: finalCall.arguments, cwd: prepared.cwd };
  if (isMcpTool(call.name)) refreshDeferredMcpToolCatalog(sessionRef);
  const deferredPrep = prepareDeferredToolCallThrough(sessionRef, call.name, call.args);
  if (deferredPrep?.deny) return deferredPrep.deny;
  const result = await runReadOnlyIoWithDeadline(call.name, executeOpts.signal || null, async (deadlineSignal) => {
    let callOpts = executeOpts;
    if (deadlineSignal !== executeOpts.signal) {
      callOpts = { ...executeOpts, signal: deadlineSignal };
      completionToolOpts.signal = deadlineSignal;
    }
    return await dispatchToolCall(call, {
      cwd: call.cwd,
      callerSessionId,
      sessionRef,
      executeOpts: callOpts,
      toolOpts,
      completionToolOpts,
      notifyFn,
      toolApprovalHook,
    });
  });
  return applyAfterToolHook(result, hookFrom(executeOpts, sessionRef, 'afterToolHook'), {
    name: call.name,
    args: call.args,
    cwd: call.cwd,
    callerSessionId,
    toolCallId: executeOpts.toolCallId || null,
  });
}
