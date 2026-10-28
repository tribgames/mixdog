// Route tool calls through policy hooks, cancellation and scoped-cache tracking.
//
//   tool-exec/call-prep.mjs          — live cwd, coerced args, scoped cache, completion notifier
//   tool-exec/before-hook.mjs        — PreToolUse deny / rewrite / ask
//   tool-exec/dispatch.mjs           — executor per tool family
//   tool-exec/after-hook.mjs         — PostToolUse result override
//   tool-exec/read-only-deadline.mjs — bounded read-only I/O with partial-output grace
import { isMcpTool, resolveMcpToolAccount } from '../../mcp/client.mjs';
import { connectorPolicyAgentOf } from '../../mcp/agent-connectors.mjs';
import { prepareDeferredToolCallThrough } from './deferred-call-through.mjs';
import { refreshDeferredMcpToolCatalog } from '../../runtime-core/tool-catalog.mjs';
import { bridgeTargetUnavailable } from '../../runtime-core/tool-bridge.mjs';
import { preDispatchDenyForSession, routeWebFetchCall } from './pre-dispatch-deny.mjs';
import { runWithToolExecutionOwner } from '../../../../shared/tool-execution-owner.mjs';
import { runWithLocalSearchTelemetry } from '../../tools/builtin/local-search-telemetry.mjs';
import { throwIfAborted } from '../../../../shared/abort-race.mjs';
import { prepareToolCall } from './tool-exec/call-prep.mjs';
import { applyBeforeToolHook, applyConnectorApproval, applyShellElevationGate } from './tool-exec/before-hook.mjs';
import { dispatchToolCall } from './tool-exec/dispatch.mjs';
import { applyAfterToolHook } from './tool-exec/after-hook.mjs';
import { runReadOnlyIoWithDeadline } from './tool-exec/read-only-deadline.mjs';
import { guardShellCall, requestedShellType } from '../../tools/builtin/bash-tool/misuse-guard.mjs';

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
  // Shell misuse is judged before any hook or approval sees the call, so they
  // read the command that will run and the directory it runs in.
  let callArgs = prepared.args;
  if (name === 'shell') {
    const guarded = guardShellCall(callArgs, {
      shellType: requestedShellType(callArgs),
      agent: sessionRef?.agent || null,
      sessionId: callerSessionId,
      telemetry: executeOpts.resultTelemetry,
    });
    if (guarded.failure) return guarded.failure;
    callArgs = guarded.args;
    completionToolOpts.shellGuardNotes = guarded.notes;
  }
  // A connector call is bound to its account before any hook or card sees it,
  // so an approval approves that account, whatever is used last meanwhile.
  // It is bound by its unique name; `account` is its label, for display.
  let bound = '';
  let account = '';
  if (isMcpTool(name)) {
    try {
      const chosen = resolveMcpToolAccount(name, callArgs, {
        scopeId: sessionRef?.mcpScopeId || null,
        conversation: callerSessionId,
      });
      bound = chosen?.name || '';
      account = chosen?.label || '';
    } catch (error) {
      return `Error: ${error?.message || String(error)}`;
    }
    if (bound) callArgs = { ...callArgs, account: bound };
  }
  const hooked = await applyBeforeToolHook({
    name,
    args: callArgs,
    cwd: prepared.cwd,
    callerSessionId,
    executeOpts,
    beforeToolHook: hookFrom(executeOpts, sessionRef, 'beforeToolHook'),
    toolApprovalHook,
    mcpScopeId: sessionRef?.mcpScopeId || null,
    account,
  });
  if (hooked.denial) return hooked.denial;
  const connectorDenied = await applyConnectorApproval(hooked, {
    agentId: connectorPolicyAgentOf(sessionRef),
    callerSessionId,
    executeOpts,
    toolApprovalHook,
    account: hooked.name === name ? account : '',
  });
  if (connectorDenied) return connectorDenied.denial;
  // A hook's rewrite of the same tool keeps the bound account.
  if (bound && hooked.name === name) hooked.args = { ...hooked.args, account: bound };
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
  const deferredPrep = prepareDeferredToolCallThrough(sessionRef, call.name);
  if (deferredPrep?.deny) return deferredPrep.deny;
  // A bridged target was resolved when its call_tool was projected; it must
  // still be available in this session's scope (also after a hook rewrite).
  // The authorized identity is the public tool name, not its transport
  // (web_fetch routed to local_fetch/image_fetch stays web_fetch here).
  if (executeOpts.bridgeWireCall) {
    const unavailable = bridgeTargetUnavailable(sessionRef, finalCall.schemaName || finalCall.name);
    if (unavailable) return unavailable;
  }
  // Elevated launches skip Mixdog's own prompt; the OS elevation prompt confirms them.
  const elevation = applyShellElevationGate(call);
  throwIfAborted(executeOpts.signal);
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
      elevationApproved: elevation.elevationApproved === true,
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
