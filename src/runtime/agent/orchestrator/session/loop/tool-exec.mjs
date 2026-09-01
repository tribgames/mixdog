// Tool dispatch/execution cluster, extracted from loop.mjs.
// executeTool routes a single tool call (Skill/skills/mcp/code_graph/internal/
// shell/apply_patch/builtin/external-adapter) through before/after hooks and the
// scoped-cache outcome bookkeeping. No behavior change: bodies are verbatim from
// loop.mjs, re-exported via the facade so existing importers keep working.
import { executeMcpTool, isMcpTool, isRegisteredMcpTool, mcpToolHasField } from '../../mcp/client.mjs';
import { executeBuiltinTool, formatUnknownBuiltinToolMessage, isBuiltinTool, isExternalAdapterTool } from '../../tools/builtin.mjs';
import { executePatchTool } from '../../tools/patch.mjs';
import { executeInternalTool, isInternalTool } from '../../internal-tools.mjs';
import { normalizeToolEnvelope, makeToolEnvelope } from '../tool-envelope.mjs';
import { getSessionAbortSignal, enqueuePendingMessage, markCompletionEntry, markSessionToolOutputTail } from '../manager.mjs';
import { createScopedCacheOutcome } from '../cache/scoped-cache-outcome.mjs';
import { modelVisibleToolCompletionMessage } from '../../../../shared/tool-execution-contract.mjs';
import { _isScopedCacheableTool } from './tool-classify.mjs';
import {
    buildSkillsListResponse,
    viewSkill,
    resolveToolResultAfterHook,
    resolvePreToolAskApproval,
} from './tool-helpers.mjs';
import { isOnDeferredToolSurface, prepareDeferredToolCallThrough } from './deferred-call-through.mjs';
import { preDispatchDenyForSession, routeWebFetchCall } from './pre-dispatch-deny.mjs';
import { runWithToolExecutionOwner } from '../../../../shared/tool-execution-owner.mjs';
import { runWithLocalSearchTelemetry } from '../../tools/builtin/local-search-telemetry.mjs';

const READ_ONLY_IO_TOOL_NAMES = new Set([
    'read', 'head', 'tail', 'wc', 'summary', 'hex',
    'grep', 'glob', 'find', 'find_files', 'list', 'tree',
]);
const READ_ONLY_IO_TIMEOUT_MS = 20_000;
// After the deadline aborts the call, the tool gets this long to hand back
// whatever it already collected (rg/native search stream partial lines and
// close on abort). Throwing the whole call away discarded work the tool had
// in hand and forced a blind retry.
const READ_ONLY_IO_PARTIAL_GRACE_MS = 1_500;

function readOnlyIoTimeoutMs() {
    const raw = String(process.env.MIXDOG_IO_TOOL_TIMEOUT_MS ?? '').trim();
    if (raw === '0') return 0;
    const configured = Number(raw);
    return Number.isFinite(configured) && configured > 0
        ? Math.max(1, Math.floor(configured))
        : READ_ONLY_IO_TIMEOUT_MS;
}

function readOnlyIoDeadlineNotice(name, timeoutMs) {
    return `\n[warning] read-only I/O tool "${name}" hit the ${timeoutMs}ms deadline; PARTIAL results shown — narrow the scope (path, glob, more specific pattern, smaller limit) for the complete set.`;
}

function withReadOnlyIoDeadlineNotice(value, name, timeoutMs) {
    const notice = readOnlyIoDeadlineNotice(name, timeoutMs);
    if (typeof value === 'string') return value.length ? `${value}${notice}` : value;
    // Tool envelopes keep their structure; only the model-visible text grows.
    if (value && typeof value === 'object' && typeof value.result === 'string') {
        return { ...value, result: `${value.result}${notice}` };
    }
    return value;
}

async function runReadOnlyIoWithDeadline(name, parentSignal, run) {
    if (!READ_ONLY_IO_TOOL_NAMES.has(name)) return await run(parentSignal || null);
    const timeoutMs = readOnlyIoTimeoutMs();
    if (timeoutMs <= 0) return await run(parentSignal || null);
    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    // `reject` is false for the deadline: aborting the tool must NOT settle the
    // outer race, or the grace window below could never collect the partial.
    const abortWith = (reason, reject = true) => {
        if (controller.signal.aborted) return;
        const error = reason instanceof Error ? reason : new Error(String(reason || `tool "${name}" aborted`));
        if (reject) rejectAbort(error);
        controller.abort(error);
    };
    const onParentAbort = () => abortWith(parentSignal?.reason);
    if (parentSignal?.aborted) onParentAbort();
    else parentSignal?.addEventListener?.('abort', onParentAbort, { once: true });
    const timeoutError = new Error(
        `read-only I/O tool "${name}" timed out after ${timeoutMs}ms with no partial output; narrow the scope (path, glob, more specific pattern, smaller limit) and retry.`,
    );
    timeoutError.code = 'READ_ONLY_IO_TIMEOUT';
    let deadlineReached = false;
    let signalDeadline;
    const deadline = new Promise((resolve) => { signalDeadline = resolve; });
    const timer = setTimeout(() => {
        deadlineReached = true;
        abortWith(timeoutError, false);
        signalDeadline();
    }, timeoutMs);
    let graceTimer = null;
    // Never rejects: the deadline branch must be able to inspect the outcome
    // instead of losing it to an already-settled race.
    const settled = Promise.resolve()
        .then(() => run(controller.signal))
        .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
    try {
        const first = await Promise.race([settled, aborted, deadline]);
        if (!deadlineReached && first) {
            if (first.ok) return first.value;
            throw first.error;
        }
        // Deadline fired: wait briefly for the aborted tool's own partial result.
        const graced = await Promise.race([
            settled,
            new Promise((resolve) => { graceTimer = setTimeout(() => resolve(null), READ_ONLY_IO_PARTIAL_GRACE_MS); }),
        ]);
        if (graced?.ok && graced.value != null && graced.value !== '') {
            return withReadOnlyIoDeadlineNotice(graced.value, name, timeoutMs);
        }
        throw timeoutError;
    } finally {
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        parentSignal?.removeEventListener?.('abort', onParentAbort);
    }
}

export { runReadOnlyIoWithDeadline as _runReadOnlyIoWithDeadlineForTest };

export function resolveToolCompletionSessionId({ callerSessionId } = {}) {
    return String(callerSessionId || '').trim();
}

let codeGraphRuntimePromise = null;
async function executeCodeGraphToolLazy(name, args, cwd, signal = null, options = {}) {
    codeGraphRuntimePromise ??= import('../../tools/code-graph.mjs');
    const mod = await codeGraphRuntimePromise;
    if (typeof mod.executeCodeGraphTool !== 'function') throw new Error('code_graph runtime is not available');
    return mod.executeCodeGraphTool(name, args, cwd, signal, options);
}

export function resolveLiveToolCwd(cwd, sessionRef) {
    const liveCwd = typeof sessionRef?.cwd === 'string' ? sessionRef.cwd : '';
    return liveCwd || cwd;
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

export function executeTool(name, args, cwd, callerSessionId, sessionRef, executeOpts = {}) {
    return runWithToolExecutionOwner(callerSessionId, () =>
        runWithLocalSearchTelemetry(executeOpts.localSearchTelemetry, () =>
            executeToolOwned(name, args, cwd, callerSessionId, sessionRef, executeOpts)));
}

async function executeToolOwned(name, args, cwd, callerSessionId, sessionRef, executeOpts = {}) {
    // cwd is captured when the turn starts. The deferred cwd tool updates
    // sessionRef.cwd in place, so every later tool call must re-read that live
    // value instead of continuing to use the stale turn snapshot.
    cwd = resolveLiveToolCwd(cwd, sessionRef);
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
    // A background tool belongs to the session that invoked it. Subagent
    // sessions carry the top-level UI session in ownerSessionId, but routing a
    // shell completion there leaks the child task into the lead transcript.
    const notificationSessionId = resolveToolCompletionSessionId({
        callerSessionId,
        ownerSessionId: sessionRef?.ownerSessionId,
        requestedNotificationSessionId: executeOpts.notifySessionId,
    });
    const notifyFn = typeof executeOpts.notifyFn === 'function'
        ? executeOpts.notifyFn
        : (text, meta = {}) => {
            if (!notificationSessionId) return;
            try {
                const visible = modelVisibleToolCompletionMessage(text, meta);
                // Inherently a tool-completion notification → tag so a later
                // resume drops it instead of replaying it as user text.
                if (visible) {
                    enqueuePendingMessage(notificationSessionId, markCompletionEntry(visible, {
                        executionId: meta?.execution_id,
                    }));
                }
            } catch { /* best effort */ }
        };
    const completionToolOpts = {
        ...toolOpts,
        sessionId: callerSessionId,
        agent: sessionRef?.agent || null,
        callerSessionId: notificationSessionId || callerSessionId,
        routingSessionId: callerSessionId,
        clientHostPid: sessionRef?.clientHostPid,
        notifyFn,
        // Live shell-output tail → session liveness (~1 s cadence from the
        // shell tool's tail timer), surfaced to transcript consumers (desktop
        // running tool cards) via getSessionProgressSnapshot.
        onOutputTail: (tail) => {
            try { markSessionToolOutputTail(callerSessionId, tail); } catch { /* best effort */ }
        },
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
            if ((action === 'modify' || action === 'rewrite') && typeof decision?.name === 'string' && decision.name.trim()) {
                name = decision.name.trim();
            }
        } catch {
            // Hooks are policy extensions. A broken hook must not wedge the agent loop.
        }
    }
    // A hook may replace the tool name, so pass the final call through the
    // same eager/serial boundary again. This prevents a rename from bypassing
    // role scoping and also applies built-in web_fetch transport routing.
    {
        const finalCall = { name, arguments: args };
        routeWebFetchCall(finalCall);
        const denial = preDispatchDenyForSession(sessionRef, finalCall);
        if (denial !== null) return denial;
        name = finalCall.name;
        args = finalCall.arguments;
    }
    const afterToolHook = typeof executeOpts.afterToolHook === 'function'
        ? executeOpts.afterToolHook
        : sessionRef?.afterToolHook;
    const deferredPrep = prepareDeferredToolCallThrough(sessionRef, name, args);
    if (deferredPrep?.deny) return deferredPrep.deny;
    const __result = await runReadOnlyIoWithDeadline(name, executeOpts.signal || null, async (deadlineSignal) => {
    if (deadlineSignal !== executeOpts.signal) {
        executeOpts = { ...executeOpts, signal: deadlineSignal };
        completionToolOpts.signal = deadlineSignal;
    }
    return await (async () => {
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
        const mcpScopeId = sessionRef?.mcpScopeId || null;
        if (!isOnDeferredToolSurface(sessionRef, name) && !isRegisteredMcpTool(name, mcpScopeId)) {
            return formatUnknownBuiltinToolMessage(name, args, 'tool');
        }
        // 24h trace data shows ~24% of external MCP calls are cwd-sensitive
        // (bash / grep / read / list / glob etc.) but the worker session's
        // cwd was previously dropped here. Inject cwd only when the tool's
        // inputSchema declares the field — schemas without it would reject
        // an unknown argument.
        const needsCwdInjection = cwd
            && mcpToolHasField(name, 'cwd', mcpScopeId)
            && (args == null || args.cwd == null);
        const finalArgs = needsCwdInjection ? { ...(args || {}), cwd } : args;
        return executeMcpTool(name, finalArgs, {
            signal: executeOpts.signal || null,
            ownerKey: callerSessionId,
            scopeId: mcpScopeId,
        });
    }
    if (name === 'code_graph') {
        // cwd chain: args.cwd (caller-explicit) → session cwd → undefined (handler throws)
        const graphCwd = (typeof args?.cwd === 'string' && args.cwd.trim()) ? args.cwd.trim() : cwd;
        return executeCodeGraphToolLazy(name, args, graphCwd, executeOpts.signal || null, toolOpts);
    }
    if (isInternalTool(name)) {
        // callerSessionId propagates into server.mjs dispatchTool so that
        // dispatchAiWrapped can detect and reject recursive calls from a
        // hidden-role session (recall/search → self).
        return executeInternalTool(name, args, {
            callerSessionId,
            callerCwd: cwd,
            setCallerCwd: async (nextCwd) => {
                const applyForCaller = sessionRef?._applyResolvedCwdForCaller;
                if (typeof applyForCaller === 'function') {
                    return await applyForCaller(nextCwd);
                }
                if (sessionRef && typeof nextCwd === 'string') sessionRef.cwd = nextCwd;
                return nextCwd;
            },
            clientHostPid: sessionRef?.clientHostPid,
            signal: executeOpts.signal,
            routingSessionId: callerSessionId,
            turnId: Number(sessionRef?.usageMetricsTurnId) || 0,
            notifyFn,
            toolApprovalHook,
            toolCallId: executeOpts.toolCallId || null,
            invocationSource: 'model-tool',
        });
    }
    if (name === 'shell') {
        return executeBuiltinTool(name, args, cwd, completionToolOpts);
    }
    if (name === 'apply_patch') {
        const patchArgs = typeof args === 'string' ? { patch: args } : { ...(args || {}) };
        return executePatchTool(name, patchArgs, cwd, {
            sessionId: callerSessionId,
            toolCallId: executeOpts.toolCallId || null,
        });
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
    });
    if (typeof afterToolHook === 'function') {
        try {
            // Tool outcome metadata is runtime-internal. Hooks receive the same
            // model-visible result value they received before transient
            // envelopes existed, never the envelope object itself.
            const {
                result: __res,
                newMessages: __nm,
                explicitSuccess: __explicitSuccess,
                explicitFailure: __explicitFailure,
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
            if (__nm.length || __explicitSuccess || __explicitFailure) {
                return makeToolEnvelope(__overridden, __nm, {
                    explicitSuccess: __explicitSuccess,
                    explicitFailure: __explicitFailure,
                });
            }
            return __overridden;
        } catch {
            // PostToolUse hooks are best-effort; never let one break the tool result.
        }
    }
    return __result;
}
