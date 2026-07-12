// Tool dispatch/execution cluster, extracted from loop.mjs.
// executeTool routes a single tool call (Skill/skills/mcp/code_graph/internal/
// shell/apply_patch/builtin/external-adapter) through before/after hooks and the
// scoped-cache outcome bookkeeping. No behavior change: bodies are verbatim from
// loop.mjs, re-exported via the facade so existing importers keep working.
import { executeMcpTool, isMcpTool, isRegisteredMcpTool, mcpToolHasField } from '../../mcp/client.mjs';
import { executeBuiltinTool, formatUnknownBuiltinToolMessage, isBuiltinTool, isExternalAdapterTool } from '../../tools/builtin.mjs';
import { executeBashSessionTool } from '../../tools/bash-session.mjs';
import { executePatchTool } from '../../tools/patch.mjs';
import { executeInternalTool, isInternalTool } from '../../internal-tools.mjs';
import { normalizeToolEnvelope, makeToolEnvelope } from '../tool-envelope.mjs';
import { getSessionAbortSignal, enqueuePendingMessage, markCompletionEntry } from '../manager.mjs';
import { createScopedCacheOutcome } from '../cache/scoped-cache-outcome.mjs';
import { modelVisibleToolCompletionMessage } from '../../../../shared/tool-execution-contract.mjs';
import { _isScopedCacheableTool } from './tool-classify.mjs';
import {
    buildSkillsListResponse,
    viewSkill,
    resolveToolResultAfterHook,
    extractBashSessionId,
    buildAgentBashSessionArgs,
    resolvePreToolAskApproval,
} from './tool-helpers.mjs';
import { isOnDeferredToolSurface, prepareDeferredToolCallThrough } from './deferred-call-through.mjs';

let codeGraphRuntimePromise = null;
async function executeCodeGraphToolLazy(name, args, cwd, signal = null, options = {}) {
    codeGraphRuntimePromise ??= import('../../tools/code-graph.mjs');
    const mod = await codeGraphRuntimePromise;
    if (typeof mod.executeCodeGraphTool !== 'function') throw new Error('code_graph runtime is not available');
    return mod.executeCodeGraphTool(name, args, cwd, signal, options);
}

export function _scopedCacheOutcomeForCall(sessionRef, toolCallId, toolName, callerSessionId, executeOpts = {}) {
    if (executeOpts.scopedCacheOutcome) {
        if (sessionRef && toolCallId) {
            // instanceof guard: a session revived from disk (JSON round-trip) turns
            // this Map into a plain object `{}` — truthy, but without Map methods.
            if (!(sessionRef._scopedCacheOutcomeByCallId instanceof Map)) sessionRef._scopedCacheOutcomeByCallId = new Map();
            sessionRef._scopedCacheOutcomeByCallId.set(toolCallId, executeOpts.scopedCacheOutcome);
        }
        return executeOpts.scopedCacheOutcome;
    }
    if (!callerSessionId || !toolCallId || !_isScopedCacheableTool(toolName)) return null;
    const outcome = createScopedCacheOutcome();
    if (sessionRef) {
        if (!(sessionRef._scopedCacheOutcomeByCallId instanceof Map)) sessionRef._scopedCacheOutcomeByCallId = new Map();
        sessionRef._scopedCacheOutcomeByCallId.set(toolCallId, outcome);
    }
    return outcome;
}

export async function executeTool(name, args, cwd, callerSessionId, sessionRef, executeOpts = {}) {
    const scopedCacheOutcome = _scopedCacheOutcomeForCall(
        sessionRef,
        executeOpts.toolCallId,
        name,
        callerSessionId,
        executeOpts,
    );
    const toolOpts = scopedCacheOutcome
        ? { ...executeOpts, scopedCacheOutcome }
        : executeOpts;
    const notificationSessionId = String(executeOpts.notifySessionId || sessionRef?.ownerSessionId || callerSessionId || '').trim();
    const notifyFn = typeof executeOpts.notifyFn === 'function'
        ? executeOpts.notifyFn
        : (text, meta = {}) => {
            if (!notificationSessionId) return;
            try {
                const visible = modelVisibleToolCompletionMessage(text, meta);
                // Inherently a tool-completion notification → tag so a later
                // resume drops it instead of replaying it as user text.
                if (visible) enqueuePendingMessage(notificationSessionId, markCompletionEntry(visible));
            } catch { /* best effort */ }
        };
    const completionToolOpts = {
        ...toolOpts,
        sessionId: callerSessionId,
        callerSessionId: notificationSessionId || callerSessionId,
        routingSessionId: callerSessionId,
        clientHostPid: sessionRef?.clientHostPid,
        notifyFn,
    };
    const beforeToolHook = typeof executeOpts.beforeToolHook === 'function'
        ? executeOpts.beforeToolHook
        : sessionRef?.beforeToolHook;
    const toolApprovalHook = typeof executeOpts.toolApprovalHook === 'function'
        ? executeOpts.toolApprovalHook
        : sessionRef?.toolApprovalHook;
    if (beforeToolHook) {
        try {
            const decision = await beforeToolHook({
                name,
                args,
                cwd,
                sessionId: callerSessionId,
                toolCallId: executeOpts.toolCallId || null,
            });
            const action = String(decision?.action || decision?.decision || '').toLowerCase();
            if (action === 'deny' || action === 'block') {
                const reason = decision?.reason ? `: ${decision.reason}` : '';
                return `Error: tool "${name}" denied by hook${reason}`;
            }
            if (action === 'ask') {
                const askReason = String(decision?.reason || 'approval requested by hook').trim();
                const askOutcome = await resolvePreToolAskApproval({
                    toolName: name,
                    args,
                    cwd,
                    sessionId: callerSessionId,
                    toolCallId: executeOpts.toolCallId || null,
                    askReason,
                    toolApprovalHook,
                });
                if (askOutcome.denial) return askOutcome.denial;
                const approval = askOutcome.approval;
                if (approval && typeof approval === 'object' && approval.args && typeof approval.args === 'object' && !Array.isArray(approval.args)) {
                    args = approval.args;
                }
            }
            if ((action === 'modify' || action === 'rewrite') && decision?.args && typeof decision.args === 'object' && !Array.isArray(decision.args)) {
                args = decision.args;
            }
        } catch {
            // Hooks are policy extensions. A broken hook must not wedge the agent loop.
        }
    }
    const afterToolHook = typeof executeOpts.afterToolHook === 'function'
        ? executeOpts.afterToolHook
        : sessionRef?.afterToolHook;
    const deferredPrep = prepareDeferredToolCallThrough(sessionRef, name, args);
    if (deferredPrep?.deny) return deferredPrep.deny;
    const __result = await (async () => {
    if (name === 'Skill') {
        return viewSkill(cwd, args?.name);
    }
    if (name === 'skills_list') {
        return buildSkillsListResponse(cwd);
    }
    if (name === 'skill_view') {
        return viewSkill(cwd, args?.name);
    }
    if (isMcpTool(name)) {
        if (!isOnDeferredToolSurface(sessionRef, name) && !isRegisteredMcpTool(name)) {
            return formatUnknownBuiltinToolMessage(name, args, 'tool');
        }
        // 24h trace data shows ~24% of external MCP calls are cwd-sensitive
        // (bash / grep / read / list / glob etc.) but the worker session's
        // cwd was previously dropped here. Inject cwd only when the tool's
        // inputSchema declares the field — schemas without it would reject
        // an unknown argument.
        const needsCwdInjection = cwd
            && mcpToolHasField(name, 'cwd')
            && (args == null || args.cwd == null);
        const finalArgs = needsCwdInjection ? { ...(args || {}), cwd } : args;
        return executeMcpTool(name, finalArgs);
    }
    if (name === 'code_graph') {
        // cwd chain: args.cwd (caller-explicit) → session cwd → undefined (handler throws)
        const graphCwd = (typeof args?.cwd === 'string' && args.cwd.trim()) ? args.cwd.trim() : cwd;
        return executeCodeGraphToolLazy(name, args, graphCwd, null, toolOpts);
    }
    if (isInternalTool(name)) {
        // callerSessionId propagates into server.mjs dispatchTool so that
        // dispatchAiWrapped can detect and reject recursive calls from a
        // hidden-role session (recall/search/explore → self).
        return executeInternalTool(name, args, {
            callerSessionId,
            callerCwd: cwd,
            clientHostPid: sessionRef?.clientHostPid,
            signal: executeOpts.signal,
            routingSessionId: callerSessionId,
            notifyFn,
        });
    }
    if (name === 'shell') {
        const routedArgs = buildAgentBashSessionArgs(args, sessionRef);
        if (!routedArgs) {
            // clientHostPid scopes background shell-jobs to the dispatching
            // terminal's claude.exe pid (agent sessions store it on sessionRef);
            // without it resolveJobOwnerHostPid falls back to the daemon-global env.
            return executeBuiltinTool(name, args, cwd, completionToolOpts);
        }
        // Thread the session's AbortSignal so agent type=close can interrupt the
        // persistent child process. getSessionAbortSignal is imported from
        // manager.mjs; callerSessionId identifies the controller.
        let _bashAbortSignal = null;
        try { _bashAbortSignal = getSessionAbortSignal(callerSessionId); } catch { /* ignore */ }
        const result = await executeBashSessionTool('bash_session', routedArgs, cwd, {
            sessionId: callerSessionId,
            abortSignal: _bashAbortSignal,
        });
        const bashSid = extractBashSessionId(result);
        if (bashSid) {
            sessionRef.implicitBashSessionId = bashSid;
            // Track all persistent bash sessions for bulk teardown on close.
            if (sessionRef.allBashSessionIds) {
                if (!sessionRef.allBashSessionIds.includes(bashSid)) {
                    sessionRef.allBashSessionIds.push(bashSid);
                }
            } else {
                sessionRef.allBashSessionIds = [bashSid];
            }
        }
        return result;
    }
    if (name === 'apply_patch') {
        const patchArgs = typeof args === 'string' ? { patch: args } : args;
        return executePatchTool(name, patchArgs, cwd, { sessionId: callerSessionId, toolCallId: executeOpts.toolCallId || null });
    }
    if (isBuiltinTool(name)) {
        // clientHostPid threaded for the same per-terminal job-scope reason as
        // the bash branch above (see resolveJobOwnerHostPid).
        return executeBuiltinTool(name, args, cwd, completionToolOpts);
    }
    if (isExternalAdapterTool(name)) {
        // Foreign-CLI tool names (StrReplace/Write/bash variants) adapt to a
        // native execution inside executeBuiltinTool's default: case; on a
        // shape mismatch it falls back to the redirect guidance message.
        return executeBuiltinTool(name, args, cwd, completionToolOpts);
    }
    return formatUnknownBuiltinToolMessage(name, args, 'tool');
    })();
    if (typeof afterToolHook === 'function') {
        try {
            // Tool outcome metadata is runtime-internal. Hooks receive the same
            // model-visible result value they received before transient
            // envelopes existed, never the envelope object itself.
            const {
                result: __res,
                newMessages: __nm,
                explicitSuccess: __explicitSuccess,
            } = normalizeToolEnvelope(__result);
            const hookResult = await afterToolHook({
                name,
                args,
                cwd,
                sessionId: callerSessionId,
                toolCallId: executeOpts.toolCallId || null,
                result: __res,
            });
            // Envelope-aware hook override: a PostToolUse hook may override the
            // model-VISIBLE tool output (the envelope's `result` / stub), but it
            // must NEVER drop the `newMessages` channel. Split first, apply the
            // override to `result` only, then re-wrap so newMessages survive.
            const __overridden = resolveToolResultAfterHook(__res, hookResult);
            if (__nm.length || __explicitSuccess) {
                return makeToolEnvelope(__overridden, __nm, { explicitSuccess: __explicitSuccess });
            }
            return __overridden;
        } catch {
            // PostToolUse hooks are best-effort; never let one break the tool result.
        }
    }
    return __result;
}
