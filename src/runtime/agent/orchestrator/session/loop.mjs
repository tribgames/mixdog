import { classifyResultKind } from './result-classification.mjs';
import { executeMcpTool, isMcpTool, mcpToolHasField } from '../mcp/client.mjs';
import { canonicalizeBuiltinToolName, executeBuiltinTool, formatUnknownBuiltinToolMessage, isBuiltinTool, isExternalAdapterTool } from '../tools/builtin.mjs';
import { executeBashSessionTool } from '../tools/bash-session.mjs';
import { executePatchTool, takeApplyPatchUiDiff } from '../tools/patch.mjs';
import { executeInternalTool, isInternalTool } from '../internal-tools.mjs';
import { normalizeToolEnvelope, makeToolEnvelope } from './tool-envelope.mjs';
import { traceAgentLoop, traceAgentTool, traceAgentToolFailure, traceAgentCompact, estimateProviderPayloadBytes, messagePrefixHash, appendAgentTrace } from '../agent-trace.mjs';
import { resolveSessionMaxLoopIterations } from '../agent-runtime/agent-loop-policy.mjs';
import { isAgentOwner } from '../agent-owner.mjs';
import { markSessionToolCall, updateSessionStage, SessionClosedError, getSessionAbortSignal, enqueuePendingMessage, bumpUsageMetricsEpoch } from './manager.mjs';
import {
    recallFastTrackCompactMessages,
    pruneToolOutputs,
    pruneToolOutputsUnanchored,
    semanticCompactMessages,
    effectiveBudget as compactEffectiveBudget,
    DEFAULT_COMPACT_TYPE,
    drainSessionCycle1,
    countRawPendingRows,
} from './compact.mjs';
import { isContextOverflowError } from '../providers/retry-classifier.mjs';
import { stripSoftWarns } from '../tool-loop-guard.mjs';
import { maybeOffloadToolResult } from './tool-result-offload.mjs';
import { tryReadCached, setReadCached, invalidatePathForSession, markPostEdit, consumePostEditMark, clearReadDedupSession, extractTouchedPathsFromPatch, tryScopedToolCached, setScopedToolCached, clearScopedToolsForSession, clearScopedToolsForSessionPaths, invalidatePrefetchCache } from './read-dedup.mjs';
import { createScopedCacheOutcome } from './cache/scoped-cache-outcome.mjs';
import { modelVisibleToolCompletionMessage } from '../../../shared/tool-execution-contract.mjs';
import { createHash } from 'crypto';
import { isInvalidToolArgsMarker, formatInvalidToolArgsResult } from '../providers/openai-compat-stream.mjs';

import {
    _stripMcpPrefix,
    _isReadTool,
    _isMutationTool,
    _isScopedCacheableTool,
    _isShellTool,
    _intraTurnSig,
} from './loop/tool-classify.mjs';
import { preDispatchDenyForSession } from './loop/pre-dispatch-deny.mjs';
let codeGraphRuntimePromise = null;
async function executeCodeGraphToolLazy(name, args, cwd, signal = null, options = {}) {
    codeGraphRuntimePromise ??= import('../tools/code-graph.mjs');
    const mod = await codeGraphRuntimePromise;
    if (typeof mod.executeCodeGraphTool !== 'function') throw new Error('code_graph runtime is not available');
    return mod.executeCodeGraphTool(name, args, cwd, signal, options);
}

// classifyResultKind is imported from result-classification.mjs at the top of
// this file; import it from there directly rather than via this module.
import { compressToolResult, recordToolBatch } from '../tools/result-compression.mjs';


import { resolve as resolvePath, isAbsolute } from 'path';
import {
    estimateMessagesTokensSafe,
    compactDiagnosticError,
    compactByteLength,
    compactDebugLog,
} from './loop/compact-debug.mjs';
import { mergeSteeringEntries, steeringContentText } from './loop/steering.mjs';
import { agentContextOverflowError } from './loop/context-overflow.mjs';
import { positiveTokenInt } from './loop/env.mjs';
import { normalizeUsage, addUsage } from './loop/usage.mjs';
import { HIDDEN_AGENT_NAMES } from './loop/hidden-agents.mjs';
import {
    resolveWorkerCompactPolicy,
    compactionTelemetryPressureTokens,
    compactTargetBudget,
    shouldCompactForSession,
    countPrunedToolOutputs,
    rememberCompactTelemetry,
    emitCompactEvent,
    compactEventType,
} from './loop/compact-policy.mjs';
import {
    isEagerDispatchable,
    messagesArrayChanged,
    getToolKind,
    buildSkillsListResponse,
    viewSkill,
    normalizeHookUpdatedToolOutput,
    resolveToolResultAfterHook,
    parseNativeToolSearchPayload,
    extractBashSessionId,
    buildAgentBashSessionArgs,
    formatMissingToolApprovalUiDenial,
    resolvePreToolAskApproval,
    approvalGranted,
    approvalReason,
} from './loop/tool-helpers.mjs';
import {
    compactToolCallsForHistory,
    restoreToolCallBodyForId,
} from './loop/stored-tool-args.mjs';
import { repairTranscriptBeforeProviderSend } from './loop/transcript-repair.mjs';

// Facade re-exports: these symbols moved to split modules under ./loop/ but
// remain part of loop.mjs's public surface (imported by scripts/tests and other
// runtime modules). Re-export the already-imported local bindings so every
// existing import path keeps working (no duplicate module binding).
export {
    preDispatchDenyForSession,
    repairTranscriptBeforeProviderSend,
    normalizeHookUpdatedToolOutput,
    resolveToolResultAfterHook,
    buildAgentBashSessionArgs,
    formatMissingToolApprovalUiDenial,
    resolvePreToolAskApproval,
    approvalGranted,
    approvalReason,
};

// Hard iteration ceiling for every agent loop. Reset to 0 whenever the
// transcript is compacted (see the trim block below): a long task that keeps
// compacting can proceed past this count, while a tight NON-compacting loop
// still stops here and returns the accumulated transcript.
// Consecutive identical-AND-failing tool calls (same name+args, error result)
// tolerated across iterations before the loop refuses to re-execute and steers
// the model to change approach. Distinct from the hard iteration cap above:
// this catches tight deterministic-failure loops (e.g. a command that errors
// the same way every time) far earlier than 100 iterations.
const REPEAT_FAIL_LIMIT = 3;
async function runRecallFastTrackCompact({ sessionRef, messages, compactBudgetTokens, compactPolicy, sessionId, signal }) {
    if (!sessionId) throw new Error('recall-fasttrack requires a session id');
    const startedAt = Date.now();
    const diagnostics = {
        hydrateLimit: null,
        ingestMs: null,
        ingestSkipped: false,
        ingestError: null,
        initialDumpMs: null,
        initialDumpBytes: null,
        initialDumpChars: null,
        initialRawPending: null,
        cycle1Ms: null,
        cycle1Skipped: false,
        cycle1SkipReason: null,
        cycle1Passes: null,
        cycle1RawRemaining: null,
        cycle1TextBytes: null,
        cycle1Error: null,
        finalRecallBytes: null,
        finalRecallChars: null,
        totalMs: null,
    };
    const query = `session:${sessionId}:all-chunks`;
    const querySha = createHash('sha256').update(query).digest('hex').slice(0, 16);
    const callerCtx = {
        callerSessionId: sessionId || null,
        callerCwd: sessionRef?.cwd || undefined,
        routingSessionId: sessionId || null,
        clientHostPid: sessionRef?.clientHostPid,
        signal: signal || null,
    };
    const hydrateLimit = positiveTokenInt(sessionRef?.compaction?.recallIngestLimit)
        || Math.max(500, Math.min(5000, messages.length || 0));
    diagnostics.hydrateLimit = hydrateLimit;
    let t0 = Date.now();
    try {
        await executeInternalTool('memory', {
            action: 'ingest_session',
            sessionId,
            messages,
            cwd: sessionRef?.cwd,
            limit: hydrateLimit,
        }, callerCtx);
    } catch (err) {
        diagnostics.ingestSkipped = true;
        diagnostics.ingestError = compactDiagnosticError(err);
        try { process.stderr.write(`[loop] recall-fasttrack ingest skipped (sess=${sessionId || 'unknown'}): ${err?.message || err}\n`); } catch {}
    } finally {
        diagnostics.ingestMs = Date.now() - t0;
    }
    const dumpArgs = {
        action: 'dump_session_roots',
        sessionId,
        includeRaw: true,
        limit: positiveTokenInt(sessionRef?.compaction?.recallChunkLimit ?? sessionRef?.compaction?.recallLimit) || hydrateLimit,
    };
    const runTool = (name, args) => executeInternalTool(name, args, callerCtx);
    t0 = Date.now();
    let recallText = await executeInternalTool('memory', dumpArgs, callerCtx);
    diagnostics.initialDumpMs = Date.now() - t0;
    diagnostics.initialDumpChars = String(recallText || '').length;
    diagnostics.initialDumpBytes = compactByteLength(recallText);
    diagnostics.initialRawPending = countRawPendingRows(recallText);
    let cycle1Text = '';
    const hasRawRows = /(?:^|\n)# raw_pending\s+\d+\s+id=/i.test(String(recallText || ''));
    if (hasRawRows) {
        t0 = Date.now();
        try {
            // Drain this session's cycle1 in window×concurrency units until no
            // raw rows remain, so the injected root is fully chunked rather than
            // carrying the unprocessed transcript tail (single-pass left raw in).
            const drained = await drainSessionCycle1(runTool, {
                sessionId,
                dumpArgs,
                deadlineMs: positiveTokenInt(sessionRef?.compaction?.recallCycle1DeadlineMs) || 120_000,
                maxPasses: positiveTokenInt(sessionRef?.compaction?.recallCycle1MaxPasses) || 0,
                cycleArgs: {
                    min_batch: 1,
                    session_cap: 1,
                    batch_size: positiveTokenInt(sessionRef?.compaction?.recallCycle1BatchSize) || 100,
                    rows_per_session: positiveTokenInt(sessionRef?.compaction?.recallRowsPerSession) || 100,
                    window_size: positiveTokenInt(sessionRef?.compaction?.recallWindowSize) || 20,
                    concurrency: positiveTokenInt(sessionRef?.compaction?.recallConcurrency) || 5,
                },
            });
            recallText = drained.recallText;
            cycle1Text = drained.cycle1Text;
            diagnostics.cycle1Passes = drained.passes;
            diagnostics.cycle1RawRemaining = drained.rawRemaining;
            diagnostics.cycle1TextBytes = compactByteLength(cycle1Text);
            if (drained.rawRemaining > 0) {
                try { process.stderr.write(`[loop] recall-fasttrack drained passes=${drained.passes} rawRemaining=${drained.rawRemaining} (sess=${sessionId || 'unknown'})\n`); } catch {}
            }
        } catch (err) {
            diagnostics.cycle1Error = compactDiagnosticError(err);
            try { process.stderr.write(`[loop] recall-fasttrack cycle1 skipped (sess=${sessionId || 'unknown'}): ${err?.message || err}\n`); } catch {}
        } finally {
            diagnostics.cycle1Ms = Date.now() - t0;
        }
    } else {
        diagnostics.cycle1Skipped = true;
        diagnostics.cycle1SkipReason = 'session chunks already hydrated';
        diagnostics.cycle1Passes = 0;
        diagnostics.cycle1RawRemaining = 0;
        cycle1Text = 'cycle1: skipped (session chunks already hydrated)';
    }
    const combinedRecallText = [`session_id=${sessionId}`, cycle1Text, recallText].map(v => String(v || '').trim()).filter(Boolean).join('\n\n');
    diagnostics.finalRecallChars = combinedRecallText.length;
    diagnostics.finalRecallBytes = compactByteLength(combinedRecallText);
    const result = recallFastTrackCompactMessages(messages, compactBudgetTokens, {
        reserveTokens: compactPolicy.reserveTokens,
        force: true,
        recallText: combinedRecallText,
        query,
        querySha,
        allowEmptyRecall: true,
        tailTurns: compactPolicy.tailTurns,
        keepTokens: compactPolicy.keepTokens,
        preserveRecentTokens: compactPolicy.preserveRecentTokens,
    });
    diagnostics.totalMs = Date.now() - startedAt;
    if (result && typeof result === 'object') {
        result.diagnostics = {
            ...(result.diagnostics || {}),
            pipeline: diagnostics,
        };
    }
    compactDebugLog('recall-fasttrack pipeline', diagnostics);
    return result;
}
function _scopedCacheOutcomeForCall(sessionRef, toolCallId, toolName, callerSessionId, executeOpts = {}) {
    if (executeOpts.scopedCacheOutcome) {
        if (sessionRef && toolCallId) {
            if (!sessionRef._scopedCacheOutcomeByCallId) sessionRef._scopedCacheOutcomeByCallId = new Map();
            sessionRef._scopedCacheOutcomeByCallId.set(toolCallId, executeOpts.scopedCacheOutcome);
        }
        return executeOpts.scopedCacheOutcome;
    }
    if (!callerSessionId || !toolCallId || !_isScopedCacheableTool(toolName)) return null;
    const outcome = createScopedCacheOutcome();
    if (sessionRef) {
        if (!sessionRef._scopedCacheOutcomeByCallId) sessionRef._scopedCacheOutcomeByCallId = new Map();
        sessionRef._scopedCacheOutcomeByCallId.set(toolCallId, outcome);
    }
    return outcome;
}

async function executeTool(name, args, cwd, callerSessionId, sessionRef, executeOpts = {}) {
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
                if (visible) enqueuePendingMessage(notificationSessionId, visible);
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
        // persistent child process. getSessionAbortSignal is imported at top of
        // loop.mjs from manager.mjs; callerSessionId identifies the controller.
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
            const hookResult = await afterToolHook({
                name,
                args,
                cwd,
                sessionId: callerSessionId,
                toolCallId: executeOpts.toolCallId || null,
                result: __result,
            });
            // Envelope-aware hook override: a PostToolUse hook may override the
            // model-VISIBLE tool output (the envelope's `result` / stub), but it
            // must NEVER drop the `newMessages` channel. Split first, apply the
            // override to `result` only, then re-wrap so newMessages survive.
            const { result: __res, newMessages: __nm } = normalizeToolEnvelope(__result);
            const __overridden = resolveToolResultAfterHook(__res, hookResult);
            if (__nm.length) return makeToolEnvelope(__overridden, __nm);
            return __overridden;
        } catch {
            // PostToolUse hooks are best-effort; never let one break the tool result.
        }
    }
    return __result;
}
/**
 * Agent loop: send → tool_call → execute → re-send → repeat until text.
 * sendOpts may include:
 *   - `effort` (provider-specific)
 *   - `fast` (boolean)
 *   - `sessionId` — enables runtime liveness markers (optional)
 *   - `signal` — AbortSignal; checked at each iteration boundary and after each
 *                tool. When aborted, throws SessionClosedError so the ask
 *                wrapper can propagate a clean cancellation.
 *   - `onStageChange(stage)` / `onStreamDelta()` — forwarded to provider.send for heartbeats
 */
// Stop reasons that signal the turn was cut short mid-synthesis (token cap,
// provider pause). Empty content + one of these reasons means the worker
// was not done — re-prompt instead of accepting empty as final.
// Covers Anthropic (pause_turn, max_tokens), OpenAI (length), Gemini
// (MAX_TOKENS, OTHER), and case variants.
const INCOMPLETE_STOP_REASONS = new Set([
    'pause_turn', 'max_tokens', 'length', 'MAX_TOKENS', 'OTHER',
]);

export async function agentLoop(provider, messages, model, tools, onToolCall, cwd, sendOpts) {
    let iterations = 0;
    let toolCallsTotal = 0;
    let lastUsage;
    let firstTurnUsage;
    let response;
    let contractNudges = 0;
    let contextOverflowRetryUsed = false;
    // Set when the hard iteration-cap break below fires. Consumed at the final
    // return to tag terminationReason='iteration_cap' so a worker that exhausts
    // the loop without a final answer surfaces to Lead as an explicit error
    // instead of a silent empty "completed".
    let terminatedByCap = false;
    // Set when a provider context-overflow refusal triggers the in-turn
    // reactive compact retry below; consumed by the next pre-send compact pass
    // so its telemetry/events carry trigger:'reactive' (distinct from the
    // proactive pre-send pressure trigger). Cleared after that pass reads it.
    let reactiveOverflowRetryPending = false;
    const opts = sendOpts || {};
    const sessionId = opts.sessionId || null;
    const signal = opts.signal || null;
    const sessionAgent = opts.session?.agent;
    const forcedFirstTool = opts.forcedFirstTool ?? null;
    const forcedFirstToolDef = forcedFirstTool
        ? tools.find(tool => tool?.name === forcedFirstTool)
        : null;
    // Opaque providerState passthrough. The loop never inspects provider-native
    // payloads; the originating provider owns them. Stateful Responses
    // providers may use it for continuation anchors.
    let providerState = opts.providerState ?? undefined;
    const throwIfAborted = () => {
        if (signal?.aborted) {
            const reason = signal.reason instanceof Error ? signal.reason : null;
            // Preserve any structured abort reason (SessionClosedError,
            // StreamStalledAbortError, etc.). Fallback to SessionClosedError
            // when the reason is not an Error instance.
            if (reason) throw reason;
            throw new SessionClosedError(sessionId || 'unknown', 'agent loop aborted');
        }
    };
    const sessionRef = opts.session || null;
    const loopUsageMetricsEpoch = () => Number(sessionRef?.usageMetricsEpoch) || 0;
    const loopUsageMetricsTurnId = () => Number(sessionRef?.usageMetricsTurnId) || 0;
    // Sub-agent (worker/heavy-worker/reviewer/debugger/explore/…) sessions
    // drop mid-turn assistant preamble text outright. Only the final
    // <final-answer> reply is consumed by Lead, so any "Now let me…" prose
    // that precedes a tool call is pure noise — both for live surfacing AND
    // for the agent's own history (where it re-enters context as input
    // tokens on every later turn). Drop it at the runtime, no model-side rule:
    //   - streaming  : opts.onTextDelta suppressed (token-by-token preamble)
    //   - buffered   : opts.onAssistantText skipped (response.content below)
    //   - history    : tool-call turn content blanked before messages.push
    // Reasoning/thinking deltas, tool calls, and the final answer are kept.
    const suppressMidTurnText = isAgentOwner(sessionRef);
    if (suppressMidTurnText) opts.onTextDelta = undefined;
    const pushToolResultMessage = (message) => {
        messages.push(message);
        try { opts.onToolResult?.(message); } catch {}
    };
    const drainSteeringIntoMessages = (stage = 'mid-turn', options = {}) => {
        if (typeof opts.drainSteering !== 'function') return false;
        let steerMsgs = [];
        try { steerMsgs = opts.drainSteering(sessionId) || []; }
        catch { steerMsgs = []; }
        const merged = mergeSteeringEntries(steerMsgs);
        if (!merged) return false;
        if (typeof options.beforeAppend === 'function') {
            try { options.beforeAppend(); } catch { /* best-effort hook */ }
        }
        messages.push({ role: 'user', content: merged.content });
        try { opts.onSteerMessage?.(merged.text || steeringContentText(merged.content)); } catch {}
        if (sessionId) {
            try { process.stderr.write(`[steer] sess=${sessionId} injected ${stage} user message (merged=${merged.count} len=${String(merged.text || '').length})\n`); } catch {}
        }
        return true;
    };
    const pushIntermediateAssistantResponse = (resp) => {
        if (!resp) return false;
        const content = typeof resp.content === 'string' ? resp.content : (resp.content == null ? '' : String(resp.content));
        const reasoningContent = typeof resp.reasoningContent === 'string' && resp.reasoningContent
            ? resp.reasoningContent
            : '';
        const reasoningItems = Array.isArray(resp.reasoningItems) && resp.reasoningItems.length
            ? resp.reasoningItems
            : null;
        if (!content && !reasoningContent && !reasoningItems) return false;
        messages.push({
            role: 'assistant',
            content,
            ...(reasoningItems ? { reasoningItems } : {}),
            ...(reasoningContent ? { reasoningContent } : {}),
        });
        return true;
    };
    const maxLoopIterations = resolveSessionMaxLoopIterations(sessionRef);
    // Tracks consecutive assistant turns that ran exactly one read-only tool
    // call (missed parallelism). Not reset per-iteration — only by the
    // steering-hint fire below or by a turn that batches/edits.
    let _serialReadOnlyStreak = 0;
    // Tool execution must use the session cwd even when the caller omitted the
    // legacy positional cwd argument. Agent workers always carry their cwd on
    // sessionRef; falling through to pwd()/process.cwd() resolves relatives
    // against the host/plugin root instead of the worker workspace.
    cwd = cwd || sessionRef?.cwd || undefined;
    while (true) {
        throwIfAborted();
        if (iterations >= maxLoopIterations) {
            process.stderr.write(`[loop] hard iteration cap ${maxLoopIterations} reached (sess=${sessionId || 'unknown'}); stopping loop.\n`);
            terminatedByCap = true;
            break;
        }
        // Drain queued steering/prompts BEFORE the
        // pre-send compact check. The compact decision must see the exact
        // message set that the next provider.send would receive, including
        // tool results plus any queued user input/notifications.
        drainSteeringIntoMessages('pre-send');
        const compactPolicy = resolveWorkerCompactPolicy(sessionRef, tools);
        if (compactPolicy?.auto) {
            // Snapshot pre-compact shape so compact_meta can record the actual
            // mutation (or no-op) for prefix-mutation forensics. Bytes are
            // a best-effort JSON.stringify length — close enough to the
            // payload we hand the provider for prefix-cache analysis.
            const beforeCount = messages.length;
            // beforeBytes is only ever read inside the shouldCompact telemetry
            // branches below. Computing it eagerly serialized the ENTIRE message
            // array (Buffer.byteLength(JSON.stringify(messages))) on every loop
            // iteration — including the common no-compact path — which grows
            // linearly with transcript size and was a real per-iteration drag.
            // Defer it to a memoized lazy getter so the no-compact path pays
            // nothing and the compact path still gets an exact byte count once.
            let _beforeBytes;
            let _beforeBytesComputed = false;
            const getBeforeBytes = () => {
                if (_beforeBytesComputed) return _beforeBytes;
                _beforeBytesComputed = true;
                try { _beforeBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8'); } catch { _beforeBytes = null; }
                return _beforeBytes;
            };
            const messageTokensEst = estimateMessagesTokensSafe(messages);
            const reactivePending = reactiveOverflowRetryPending === true;
            const shouldCompact = shouldCompactForSession(messageTokensEst, compactPolicy, { forceReactive: reactivePending });
            const pressureTokens = compactionTelemetryPressureTokens(messageTokensEst, compactPolicy, { reactivePending });
            const compactBudgetTokens = shouldCompact
                ? (compactTargetBudget({ ...compactPolicy, pressureTokens }) || compactPolicy.boundaryTokens)
                : compactPolicy.boundaryTokens;
            if (!shouldCompact) {
                rememberCompactTelemetry(sessionRef, compactPolicy, {
                    stage: 'pre_send_check',
                    beforeTokens: messageTokensEst,
                    afterTokens: messageTokensEst,
                    pressureTokens,
                });
            } else {
                try { opts.onStageChange?.('compacting'); } catch { /* best-effort */ }
                const compactStartedAt = Date.now();
                // A pending reactive-overflow retry makes THIS compact pass the
                // recovery from a provider overflow refusal, not the proactive
                // pressure trigger. Tag the emitted events so telemetry can tell
                // them apart, then clear the one-shot flag.
                const compactTrigger = reactiveOverflowRetryPending ? 'reactive' : 'auto';
                reactiveOverflowRetryPending = false;
                // PreCompact: bridge to the standard hook bus before compaction
                // runs. session-property hook (manager/loop have no bus access).
                // { trigger } normalized to 'auto'|'manual'. Best-effort.
                {
                    const _preCompactHook = typeof opts.preCompactHook === 'function'
                        ? opts.preCompactHook
                        : sessionRef?.preCompactHook;
                    if (typeof _preCompactHook === 'function') {
                        try { await _preCompactHook({ sessionId, cwd, trigger: compactTrigger === 'manual' ? 'manual' : 'auto' }); }
                        catch { /* best-effort: PreCompact hook must never break compaction */ }
                    }
                }
                rememberCompactTelemetry(sessionRef, compactPolicy, {
                    stage: 'compacting',
                    beforeTokens: messageTokensEst,
                    afterTokens: messageTokensEst,
                    pressureTokens,
                    trigger: compactTrigger,
                });
                let compacted;
                let pruneCount = 0;
                let summaryChanged = false;
                let semanticCompactResult = null;
                let semanticCompactError = null;
                let recallFastTrackResult = null;
                let recallFastTrackError = null;
                try {
                    let compactInputMessages = messages;
                    if (compactPolicy.prune) {
                        const pruned = pruneToolOutputs(messages, compactPolicy.boundaryTokens, {
                            reserveTokens: compactPolicy.reserveTokens,
                        });
                        pruneCount = countPrunedToolOutputs(messages, pruned);
                        compactInputMessages = pruned;
                    }
                    if (compactPolicy.recallFastTrack) {
                        try {
                            recallFastTrackResult = await runRecallFastTrackCompact({
                                sessionRef,
                                messages: compactInputMessages,
                                compactBudgetTokens,
                                compactPolicy,
                                sessionId,
                                signal,
                            });
                            const recallMessages = Array.isArray(recallFastTrackResult?.messages)
                                ? recallFastTrackResult.messages
                                : null;
                            if (!recallMessages) throw new Error('recall-fasttrack compact produced no messages');
                            compacted = recallMessages;
                        } catch (recallErr) {
                            recallFastTrackError = recallErr;
                            try {
                                process.stderr.write(
                                    `[loop] recall-fasttrack compact failed (sess=${sessionId || 'unknown'}): ` +
                                    `${recallErr?.message || recallErr}\n`,
                                );
                            } catch { /* best-effort */ }
                            throw recallErr;
                        }
                    } else if (compactPolicy.semantic) {
                        try {
                            semanticCompactResult = await semanticCompactMessages(
                                provider,
                                compactInputMessages,
                                model,
                                compactBudgetTokens,
                                {
                                    reserveTokens: compactPolicy.reserveTokens,
                                    providerName: sessionRef.provider || provider?.name || null,
                                    sessionId,
                                    signal,
                                    sendOpts: opts,
                                    promptCacheKey: opts.promptCacheKey || null,
                                    providerCacheKey: opts.providerCacheKey || null,
                                    timeoutMs: compactPolicy.semanticTimeoutMs,
                                    tailTurns: compactPolicy.tailTurns,
                                    keepTokens: compactPolicy.keepTokens,
                                    preserveRecentTokens: compactPolicy.preserveRecentTokens,
                                    force: true,
                                },
                            );
                            const semanticMessages = Array.isArray(semanticCompactResult?.messages)
                                ? semanticCompactResult.messages
                                : null;
                            if (!semanticMessages) throw new Error('semantic compact produced no messages');
                            compacted = semanticMessages;
                            if (semanticCompactResult?.usage) {
                                lastUsage = addUsage(lastUsage, semanticCompactResult.usage);
                                if (!firstTurnUsage) firstTurnUsage = normalizeUsage(semanticCompactResult.usage);
                                if (sessionId && opts.onUsageDelta) {
                                    try {
                                        opts.onUsageDelta({
                                            sessionId,
                                            iterationIndex: iterations + 1,
                                            usageMetricsTurnId: loopUsageMetricsTurnId(),
                                            usageMetricsEpoch: loopUsageMetricsEpoch(),
                                            deltaInput: semanticCompactResult.usage.inputTokens || 0,
                                            deltaOutput: semanticCompactResult.usage.outputTokens || 0,
                                            deltaCachedRead: semanticCompactResult.usage.cachedTokens || 0,
                                            deltaCacheWrite: semanticCompactResult.usage.cacheWriteTokens || 0,
                                            source: 'semantic_compact',
                                            ts: Date.now(),
                                        });
                                    } catch { /* best-effort */ }
                                }
                            }
                        } catch (semanticErr) {
                            semanticCompactError = semanticErr;
                            try {
                                process.stderr.write(
                                    `[loop] semantic compact failed (sess=${sessionId || 'unknown'}): ` +
                                    `${semanticErr?.message || semanticErr}\n`,
                                );
                            } catch { /* best-effort */ }
                            throw semanticErr;
                        }
                    } else {
                        throw new Error(`compact type ${compactPolicy.compactType || compactPolicy.type || DEFAULT_COMPACT_TYPE} is unavailable for auto compact`);
                    }
                    summaryChanged = messagesArrayChanged(compactInputMessages, compacted);
                } catch (compactErr) {
                    // Anchor-independent prune safety net. When SEMANTIC compact
                    // throws (e.g. a degenerate single-turn transcript, or a
                    // summary that cannot fit), attempt one non-LLM prune that
                    // needs no user anchor: middle-truncate the oldest oversized
                    // tool_result bodies until the transcript fits the budget.
                    // If it shrinks the transcript we continue with that result
                    // instead of escalating to overflow. Structure/pairing is
                    // preserved (only string content shrinks) and the result is
                    // re-reconciled inside the helper.
                    //
                    // GATED to the non-recall path: a recall-fasttrack failure
                    // must NOT be silently recovered by this prune (that would
                    // change the type-2 path's contract by shipping a pruned
                    // transcript with no recall output). When recallFastTrackError
                    // is set the fallback is skipped and the original overflow
                    // escalation runs unchanged.
                    if (!recallFastTrackError) {
                        try {
                            // Accept only if the pruned transcript fits the SAME
                            // effective budget the prune targets (compactBudgetTokens
                            // minus the request reserve) — comparing against the raw
                            // compactBudgetTokens would accept a result with no
                            // reserve headroom and overflow on the very next send.
                            const acceptThreshold = compactEffectiveBudget(compactBudgetTokens, {
                                reserveTokens: compactPolicy.reserveTokens,
                            });
                            const salvaged = pruneToolOutputsUnanchored(messages, compactBudgetTokens, {
                                reserveTokens: compactPolicy.reserveTokens,
                            });
                            if (messagesArrayChanged(messages, salvaged)
                                && estimateMessagesTokensSafe(salvaged) <= acceptThreshold) {
                                compacted = salvaged;
                                pruneCount = countPrunedToolOutputs(messages, salvaged);
                                summaryChanged = true;
                            }
                        } catch { /* fall through to overflow escalation */ }
                    }
                    if (compacted !== undefined) {
                        try {
                            process.stderr.write(
                                `[loop] compact fallback prune recovered (sess=${sessionId || 'unknown'}): ` +
                                `${compactErr?.message || compactErr}\n`,
                            );
                        } catch { /* best-effort */ }
                    } else {
                    const compactFailMsg = compactErr && compactErr.message ? compactErr.message : String(compactErr);
                    const semanticFailMsg = semanticCompactError?.message || null;
                    const recallFailMsg = recallFastTrackError?.message || null;
                    const compactFailCode = compactErr?.code
                        || (compactErr?.name === 'AgentContextOverflowError' ? 'AGENT_CONTEXT_OVERFLOW' : null)
                        || 'compact_failed';
                    rememberCompactTelemetry(sessionRef, compactPolicy, {
                        stage: 'overflow_failed',
                        beforeTokens: messageTokensEst,
                        afterTokens: messageTokensEst,
                        pressureTokens,
                        trigger: compactTrigger,
                        semanticError: semanticFailMsg,
                        recallFastTrackError: recallFailMsg,
                        compactError: semanticFailMsg || recallFailMsg || compactFailMsg,
                        pruneCount,
                        durationMs: Date.now() - compactStartedAt,
                    });
                    traceAgentCompact({
                        sessionId,
                        iteration: iterations + 1,
                        stage: 'pre_send',
                        trigger: compactTrigger,
                        compact_type: compactPolicy.compactType || compactPolicy.type || DEFAULT_COMPACT_TYPE,
                        prune_count: pruneCount,
                        compact_changed: false,
                        input_prefix_hash: messagePrefixHash(messages),
                        before_count: beforeCount,
                        after_count: messages.length,
                        before_bytes: getBeforeBytes(),
                        after_bytes: getBeforeBytes(),
                        context_window: compactPolicy.contextWindow,
                        budget_tokens: compactPolicy.boundaryTokens,
                        boundary_tokens: compactPolicy.boundaryTokens,
                        target_budget_tokens: compactBudgetTokens,
                        reserve_tokens: compactPolicy.reserveTokens,
                        pressure_tokens: pressureTokens,
                        trigger_tokens: compactPolicy.triggerTokens,
                        message_tokens_est: messageTokensEst,
                        duration_ms: Date.now() - compactStartedAt,
                        provider: sessionRef.provider,
                        model: sessionRef.model || model,
                        error: compactFailMsg,
                        error_code: compactFailCode,
                        details: {
                            semantic: semanticCompactResult?.diagnostics || null,
                            recallFastTrack: recallFastTrackResult?.diagnostics || null,
                            semanticError: semanticFailMsg,
                            recallFastTrackError: recallFailMsg,
                        },
                    });
                    emitCompactEvent(opts, {
                        sessionId,
                        stage: 'pre_send',
                        trigger: compactTrigger,
                        status: 'failed',
                        compactType: compactEventType(compactPolicy),
                        beforeTokens: messageTokensEst,
                        afterTokens: messageTokensEst,
                        beforeMessages: beforeCount,
                        afterMessages: messages.length,
                        pressureTokens,
                        triggerTokens: compactPolicy.triggerTokens,
                        boundaryTokens: compactPolicy.boundaryTokens,
                        targetBudgetTokens: compactBudgetTokens,
                        reserveTokens: compactPolicy.reserveTokens,
                        semantic: compactPolicy.semantic === true,
                        recallFastTrack: compactPolicy.recallFastTrack === true,
                        pruneCount,
                        durationMs: Date.now() - compactStartedAt,
                        error: compactErr && compactErr.message ? compactErr.message : String(compactErr),
                    });
                    throw agentContextOverflowError({
                        stage: 'pre_send',
                        sessionId,
                        sessionRef,
                        model,
                        budgetTokens: compactBudgetTokens,
                        reserveTokens: compactPolicy.reserveTokens,
                        messageTokensEst,
                    }, compactErr);
                    }
                }
                try { opts.onStageChange?.('requesting'); } catch { /* best-effort */ }
                const compactChanged = messagesArrayChanged(messages, compacted);
                if (compactChanged) {
                    messages.length = 0;
                    messages.push(...compacted);
                    // Compacting/pruning the transcript invalidates the
                    // server-side conversation anchor (xAI Responses / openai-oauth
                    // WS rely on previous_response_id which points at a
                    // now-mutated prefix). Drop providerState so the next send
                    // starts a fresh chain.
                    providerState = undefined;
                    // Compaction shrank the transcript, so prior turns no
                    // longer pressure the window — reset the iteration counter
                    // so a steadily-compacting long task isn't killed by the
                    // cap, while a non-compacting tight loop still hits it.
                    iterations = 0;
                    // New loop epoch so persistIterationMetrics idempotency keys do not
                    // collide when iteration indices restart at 1 (incl. iter 1 → iter 1).
                    if (sessionRef) bumpUsageMetricsEpoch(sessionRef);
                }
                const afterTokens = estimateMessagesTokensSafe(messages);
                const compactDurationMs = Date.now() - compactStartedAt;
                rememberCompactTelemetry(sessionRef, compactPolicy, {
                    stage: 'pre_send',
                    beforeTokens: messageTokensEst,
                    afterTokens,
                    pressureTokens,
                    compactChanged,
                    semanticCompact: semanticCompactResult?.semantic === true,
                    semanticError: semanticCompactError?.message || null,
                    recallFastTrack: recallFastTrackResult?.recallFastTrack === true,
                    recallFastTrackError: recallFastTrackError?.message || null,
                    compactError: null,
                    pruneCount,
                    durationMs: compactDurationMs,
                });
                let afterBytes = null;
                try { afterBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8'); } catch { afterBytes = null; }
                traceAgentCompact({
                    sessionId,
                    iteration: iterations + 1,
                    stage: 'pre_send',
                    trigger: compactTrigger,
                    compact_type: compactPolicy.compactType || compactPolicy.type || DEFAULT_COMPACT_TYPE,
                    prune_count: pruneCount,
                    compact_changed: compactChanged || summaryChanged,
                    input_prefix_hash: messagePrefixHash(messages),
                    before_count: beforeCount,
                    after_count: messages.length,
                    before_bytes: getBeforeBytes(),
                    after_bytes: afterBytes,
                    context_window: compactPolicy.contextWindow,
                    budget_tokens: compactPolicy.boundaryTokens,
                    boundary_tokens: compactPolicy.boundaryTokens,
                    target_budget_tokens: compactBudgetTokens,
                    reserve_tokens: compactPolicy.reserveTokens,
                    pressure_tokens: pressureTokens,
                    trigger_tokens: compactPolicy.triggerTokens,
                    message_tokens_est: messageTokensEst,
                    duration_ms: compactDurationMs,
                    provider: sessionRef.provider,
                    model: sessionRef.model || model,
                    details: {
                        semantic: semanticCompactResult?.diagnostics || null,
                        recallFastTrack: recallFastTrackResult?.diagnostics || null,
                    },
                });
                emitCompactEvent(opts, {
                    sessionId,
                    stage: 'pre_send',
                    trigger: compactTrigger,
                    status: compactChanged || summaryChanged || pruneCount > 0 ? 'compacted' : 'no_change',
                    compactType: compactEventType(compactPolicy),
                    beforeTokens: messageTokensEst,
                    afterTokens,
                    beforeMessages: beforeCount,
                    afterMessages: messages.length,
                    pressureTokens,
                    triggerTokens: compactPolicy.triggerTokens,
                    boundaryTokens: compactPolicy.boundaryTokens,
                    targetBudgetTokens: compactBudgetTokens,
                    reserveTokens: compactPolicy.reserveTokens,
                    changed: compactChanged || summaryChanged,
                    semantic: semanticCompactResult?.semantic === true,
                    recallFastTrack: recallFastTrackResult?.recallFastTrack === true,
                    pruneCount,
                    durationMs: compactDurationMs,
                });
            }
            // PostCompact: bridge to the standard hook bus after compaction
            // completes. session-property hook; { trigger } 'auto'|'manual'.
            {
                const _postCompactHook = typeof opts.postCompactHook === 'function'
                    ? opts.postCompactHook
                    : sessionRef?.postCompactHook;
                if (typeof _postCompactHook === 'function') {
                    try { await _postCompactHook({ sessionId, cwd, trigger: compactTrigger === 'manual' ? 'manual' : 'auto' }); }
                    catch { /* best-effort: PostCompact hook must never break the loop */ }
                }
            }
        }
        const nextIteration = iterations + 1;
        opts.iteration = nextIteration;
        opts.providerState = providerState;
        if (forcedFirstTool && toolCallsTotal === 0) {
            opts.toolChoice = 'required';
        } else {
            delete opts.toolChoice;
        }
        const sendTools = forcedFirstToolDef && toolCallsTotal === 0 ? [forcedFirstToolDef] : tools;
        // Eager-dispatch queue: when the provider streams a tool-call event,
        // start read-only tools immediately so execution overlaps with the
        // remaining SSE parse. Writes and unknown tools wait until send()
        // returns and run serially in the call-order loop below.
        const pending = new Map();
        // Streaming-time intra-turn dedup. When the LLM emits two
        // tool_use blocks with identical (name, args) signatures in
        // sequence, the provider's onToolCall fires for both BEFORE
        // the iter for-body runs, so the batch-level pre-pass would be
        // too late to prevent the eager dispatch of the second one.
        // Track signatures of in-flight eager calls and skip starting a
        // second one for the same sig. The duplicate's executeTool is
        // never invoked; the for-body's pre-pass marks it as a duplicate
        // and emits a stub tool_result. The sig is NOT cleared when the
        // eager promise settles (see finally below): a streaming onToolCall
        // can deliver a same-turn identical call AFTER the first promise
        // settles but BEFORE the deferred cache set (:1256), and the static
        // pre-pass (:909) only runs after send() returns — so clearing the
        // sig on settle would let that second streaming eager call
        // re-execute. A fresh Map() is created per turn, so the sig set
        // resets at the turn boundary without leaking across iterations.
        const _eagerInFlightSigs = new Map();
        let _mutationEpoch = 0;
        const startEagerTool = (call) => {
            if (!call?.id || pending.has(call.id) || !isEagerDispatchable(call.name, tools)) return null;
            // Never eager-execute a call whose arguments failed to parse
            // (invalid-args marker). It has no usable arguments; the serial
            // body handles it via the invalid-args feedback path.
            if (isInvalidToolArgsMarker(call.arguments)) return null;
            const _sig = _intraTurnSig(call.name, call.arguments);
            if (_eagerInFlightSigs.has(_sig)) return null;
            // Repeat-failure guard also gates eager dispatch (reviewer-flagged):
            // streaming onToolCall / startEagerRun would otherwise re-run an
            // identical read-only call that already failed REPEAT_FAIL_LIMIT
            // times before the serial for-body guard runs. Returning null here
            // lets the serial body push the [repeat-failure-guard] stub.
            {
                const _rfg = sessionRef?._repeatFailGuard;
                if (_rfg && _rfg.sig === _sig && _rfg.count >= REPEAT_FAIL_LIMIT) return null;
            }
            const toolKind = getToolKind(call.name);
            // Shared pre-dispatch deny: identical predicate runs in the
            // serial path below. If any role/permission guard would reject
            // this call there, never start it eagerly here.
            if (preDispatchDenyForSession(sessionRef, call, toolKind) !== null) return null;
            const entry = { startedAt: Date.now(), endedAt: null, mutationEpoch: _mutationEpoch };
            _eagerInFlightSigs.set(_sig, call.id);
            entry.promise = (async () => {
                try {
                    return { ok: true, value: await executeTool(call.name, call.arguments, cwd, sessionId, sessionRef, { toolCallId: call.id, signal, notifyFn: opts.notifyFn, toolApprovalHook: opts.onToolApproval, iteration: nextIteration }) };
                } catch (error) {
                    return { ok: false, error };
                }
            })()
                .then((settled) => {
                    entry.endedAt = Date.now();
                    // EARLY UI-ONLY NOTIFY (completion-order, NOT history).
                    // The serial result-collection loop below `await`s each
                    // eager promise strictly in CALL order, so a fast call[1]
                    // that settles before a slow call[0] cannot surface its
                    // tool card completion until call[0] resolves. Fire
                    // onToolResult here — the instant THIS eager tool settles —
                    // so parallel cards complete independently in the order they
                    // actually finish.
                    //
                    // This message is NOT pushed into `messages`: provider
                    // history ordering stays exactly call-order. The serial loop
                    // still builds the REAL tool_result and pushes it via
                    // pushToolResultMessage (which fires onToolResult AGAIN for
                    // the same toolCallId in call order — the TUI dedupes by id,
                    // so the duplicate notify is harmless). __earlyNotify marks
                    // this as the pre-history, UI-only signal.
                    //
                    // Only genuinely-executed eager promises reach here:
                    // startEagerTool never creates an entry for dedup /
                    // repeat-failure-guard / pre-dispatch-deny / invalid-args
                    // calls (they return null above), so those `continue`-before-
                    // execution stub paths can never early-notify (contract #5).
                    try {
                        // UI-only: surface the model-VISIBLE result (envelope
                        // stub for envelope returns), never the envelope object
                        // or its injected newMessages body — no [object Object],
                        // no full skill body in the tool card.
                        const _earlyVisible = settled && settled.ok
                            ? normalizeToolEnvelope(settled.value).result
                            : null;
                        const _earlyContent = settled && settled.ok
                            ? (typeof _earlyVisible === 'string'
                                ? _earlyVisible
                                : (_earlyVisible == null ? '' : String(_earlyVisible)))
                            : `Error: ${settled && settled.error instanceof Error ? settled.error.message : String(settled && settled.error)}`;
                        opts.onToolResult?.({
                            role: 'tool',
                            toolCallId: call.id,
                            content: _earlyContent,
                            isError: !(settled && settled.ok),
                            __earlyNotify: true,
                        });
                    } catch { /* best-effort — UI notify must never break the eager path */ }
                    // Intentionally do NOT delete _sig here — see the block
                    // comment above. The sig must outlive promise settlement
                    // so a later same-turn streaming duplicate stays blocked
                    // at the _eagerInFlightSigs.has(_sig) guard until the turn
                    // boundary recreates the Map.
                    return settled;
                });
            pending.set(call.id, entry);
            return entry;
        };
        const startEagerRun = (calls, startIndex, dupSet) => {
            for (let j = startIndex; j < calls.length; j += 1) {
                const call = calls[j];
                if (!call?.id || !isEagerDispatchable(call.name, tools)) break;
                if (dupSet && dupSet.has(call.id)) continue;
                if (!startEagerTool(call) && !pending.has(call.id)) break;
            }
        };
        let _streamEagerBlocked = false;
        opts.onToolCall = (call) => {
            if (!isEagerDispatchable(call?.name, tools)) {
                _streamEagerBlocked = true;
                return;
            }
            if (_streamEagerBlocked) return;
            startEagerTool(call);
        };
        // Reattach separated tool results, then drop only truly dangling
        // assistant/orphan pairs before the provider sees the transcript.
        repairTranscriptBeforeProviderSend(messages, sessionId);
        // Strip soft-warn markers from prior tool results before the next
        // send. Marker bytes (Tool-budget(xN), Same-file reads(xN), etc.)
        // mutate every turn with dynamic counters, so leaving them in the
        // transcript breaks server-side prefix cache lookup on later turns.
        // The current turn's marker (if any) is appended AFTER this strip,
        // so the model still sees the self-correct hint on its own iteration.
        for (let _i = 0; _i < messages.length; _i++) {
            const _m = messages[_i];
            if (_m && _m.role === 'tool' && typeof _m.content === 'string' && _m.content.includes('⚠')) {
                const _stripped = stripSoftWarns(_m.content);
                if (_stripped !== _m.content) _m.content = _stripped;
            }
        }
        const sendStartedAt = Date.now();
        try {
            response = await provider.send(messages, model, sendTools.length ? sendTools : undefined, opts);
        } catch (sendErr) {
            // Partial-final recovery (owner-notify fix): the recurring "worker
            // finished but the task hung / no result delivered" case is a FINAL,
            // no-tool summary stream that wedges (ping-only) AFTER all real tool
            // work completed in earlier iterations. The provider attaches its
            // partial stream state to the StreamStalledError. When the stall
            // carries streamed assistant text, has NO pending tool_use, and did
            // NOT emit a tool call this iteration, accept the partial as a
            // successful terminal response (deliver the summary we have) instead
            // of throwing — which would strand/notify-as-failure a turn whose
            // work actually succeeded. A stall WITH a pending/emitted tool call
            // is NOT recoverable (a tool whose input never completed must never
            // look done) and falls through to the normal error path.
            if (
                sendErr?.streamStalled === true
                && sendErr.pendingToolUse !== true
                && sendErr.unsafeToRetry !== true
                && typeof sendErr.partialContent === 'string'
                && sendErr.partialContent.trim().length > 0
                && !(Array.isArray(sendErr.partialToolCalls) && sendErr.partialToolCalls.length > 0)
            ) {
                try {
                    process.stderr.write(
                        `[loop] final stream stalled with partial text (sess=${sessionId || 'unknown'} `
                        + `iter=${nextIteration} len=${sendErr.partialContent.length}); `
                        + `accepting as partial-final success\n`,
                    );
                } catch { /* best-effort */ }
                response = {
                    content: sendErr.partialContent,
                    model: sendErr.partialModel || model,
                    toolCalls: undefined,
                    usage: sendErr.partialUsage || undefined,
                    stopReason: sendErr.partialStopReason || 'end_turn',
                    hasThinkingContent: sendErr.partialHasThinking === true,
                    partialFinal: true,
                };
            } else
            // Partial tool-call recovery (agent-hang fix): a stream that stalls
            // AFTER fully-parsed tool calls were emitted used to lose the whole
            // turn — unsafeToRetry blocks the mid-stream replay (correct: a
            // replay would re-run side-effecting tools) and the old code threw,
            // discarding tool work that had ALREADY completed via eager dispatch.
            // But the parsed calls are complete (pendingToolUse false ⇒ no
            // half-streamed tool input), so instead of replaying the request we
            // accept the partial as a normal tool-call turn and fall through to
            // the standard execution path: eager-dispatched (read-only) calls
            // resolve from the pending map without re-running, side-effecting
            // calls were never started during streaming and execute exactly
            // once. providerState stays undefined so the next iteration resends
            // a full frame on a fresh stream.
            if (
                sendErr?.streamStalled === true
                && sendErr.pendingToolUse !== true
                && Array.isArray(sendErr.partialToolCalls)
                && sendErr.partialToolCalls.length > 0
            ) {
                try {
                    process.stderr.write(
                        `[loop] stream stalled after ${sendErr.partialToolCalls.length} complete tool call(s) `
                        + `(sess=${sessionId || 'unknown'} iter=${nextIteration}); `
                        + `recovering as tool-call turn instead of failing\n`,
                    );
                } catch { /* best-effort */ }
                try {
                    appendAgentTrace({
                        kind: 'stall_tool_recovery',
                        sessionId: sessionId || null,
                        iteration: nextIteration,
                        toolCalls: sendErr.partialToolCalls.length,
                        partialContentLen: typeof sendErr.partialContent === 'string' ? sendErr.partialContent.length : 0,
                    });
                } catch { /* best-effort */ }
                response = {
                    content: typeof sendErr.partialContent === 'string' ? sendErr.partialContent : '',
                    model: sendErr.partialModel || model,
                    toolCalls: sendErr.partialToolCalls.slice(),
                    usage: sendErr.partialUsage || undefined,
                    stopReason: 'tool_use',
                    hasThinkingContent: sendErr.partialHasThinking === true,
                    partialToolRecovery: true,
                };
            } else
            // Context-window-exceeded is a deterministic refusal from the API.
            // Recover context overflow reactively by compacting and retrying
            // in the same active turn. MixDog's proactive estimator can miss a
            // provider-specific overhead spike, so do one reactive retry by
            // marking the live session over-threshold and looping back through
            // the normal pre-send auto-compact path. If compaction/retry still
            // fails, surface the overflow normally.
            if (
                !isContextOverflowError(sendErr)
                || !(sessionRef && typeof sessionRef.contextWindow === 'number')
            ) {
                throw sendErr;
            }
            const compactPolicyForRetry = resolveWorkerCompactPolicy(sessionRef, sendTools.length ? sendTools : tools);
            if (!contextOverflowRetryUsed && compactPolicyForRetry?.auto) {
                contextOverflowRetryUsed = true;
                // Mark the next pre-send compact as REACTIVE (driven by a
                // provider overflow refusal) rather than the normal proactive
                // pressure trigger, so the compact event/telemetry the loop
                // emits on the retry is distinguishable downstream.
                reactiveOverflowRetryPending = true;
                opts.onToolCall = undefined;
                try {
                    process.stderr.write(
                        `[loop] context overflow on send (sess=${sessionId || 'unknown'} iter=${nextIteration}); ` +
                        `reactive compact retry messages=${messages.length}\n`,
                    );
                } catch { /* best-effort */ }
                continue;
            }
            try {
                process.stderr.write(
                    `[loop] context overflow on send (sess=${sessionId || 'unknown'} iter=${nextIteration}); ` +
                    `surfacing overflow after reactive compact retry messages=${messages.length}\n`,
                );
            } catch { /* best-effort */ }
            throw agentContextOverflowError({
                stage: 'send',
                sessionId,
                sessionRef,
                model,
                budgetTokens: sessionRef.contextWindow,
                reserveTokens: compactPolicyForRetry?.reserveTokens,
                messageTokensEst: estimateMessagesTokensSafe(messages),
            }, sendErr);
        }
        opts.onToolCall = undefined;
        contextOverflowRetryUsed = false;
        // Capture opaque state for the next turn (may be undefined — that's
        // the stateless contract for providers that don't use continuation).
        providerState = response?.providerState ?? undefined;
        iterations = nextIteration;
        // Payload byte estimate serializes the FULL messages+tools array —
        // only pay that cost when verbose loop tracing is actually enabled
        // (traceAgentLoop is a no-op otherwise).
        if (process.env.MIXDOG_AGENT_TRACE_VERBOSE === '1') {
            traceAgentLoop({
                sessionId,
                iteration: iterations,
                sendMs: Date.now() - sendStartedAt,
                messageCount: Array.isArray(messages) ? messages.length : 0,
                bodyBytesEst: estimateProviderPayloadBytes(messages, model, sendTools),
            });
        }
        // Accumulate usage across iterations — every billable slot, not just
        // input/output. Anthropic cache_read/cache_write typically stay 0 on
        // the first iteration and surge on later ones (warm prefix reuse),
        // so aggregating only the head would silently drop most of the
        // cache-side tokens.
        if (response.usage) {
            const hadUsage = !!lastUsage;
            lastUsage = addUsage(lastUsage, response.usage);
            if (!hadUsage) {
                // Snapshot the first turn separately so callers can show
                // iter1 vs final cache-hit ratios — first iter is the
                // warm-prefix signal, final iter is the steady-state
                // efficiency signal after tool-result accumulation.
                firstTurnUsage = { ...lastUsage };
            }
        }
        // Provider may have returned despite an abort (SDKs that don't honour
        // signal) — bail before processing any of its output.
        throwIfAborted();
        // P1 audit fix (Step4): a text-only turn truncated by the provider's
        // max-output limit (response.truncated, set by the provider layer
        // when stopReason==='length' AND content is non-empty) used to look
        // identical to a clean completion — the model's answer could be
        // silently cut mid-sentence with zero signal to the operator. Surface
        // it as a one-line stderr warning + trace event WITHOUT failing the
        // turn (the partial content is still usable and the loop's own
        // isIncompleteStop nudge below already re-prompts when content is
        // empty).
        if (response?.truncated === true) {
            try {
                process.stderr.write(
                    `[loop] provider output truncated at max-output limit (sess=${sessionId || 'unknown'} `
                    + `iter=${iterations} stopReason=${response.stopReason ?? response.stop_reason ?? 'length'} `
                    + `contentLen=${typeof response.content === 'string' ? response.content.length : 0}); `
                    + `answer may be cut off mid-sentence.\n`,
                );
            } catch { /* best-effort */ }
            try {
                appendAgentTrace({
                    sessionId,
                    iteration: iterations,
                    kind: 'output_truncated',
                    payload: {
                        stop_reason: response.stopReason ?? response.stop_reason ?? 'length',
                        content_len: typeof response.content === 'string' ? response.content.length : 0,
                        agent: sessionAgent || null,
                    },
                });
            } catch { /* best-effort */ }
        }
        // Incremental metric persistence (fix A): push per-iteration token delta
        // immediately so watchdog / agent type=list sees live totals mid-turn.
        if (sessionId && opts.onUsageDelta && response.usage) {
            try {
                opts.onUsageDelta({
                    sessionId,
                    iterationIndex: iterations,
                    usageMetricsTurnId: loopUsageMetricsTurnId(),
                    source: 'provider_send',
                    usageMetricsEpoch: loopUsageMetricsEpoch(),
                    deltaInput: response.usage.inputTokens || 0,
                    deltaOutput: response.usage.outputTokens || 0,
                    deltaPrompt: response.usage.promptTokens || 0,
                    // Cache delta carried alongside input/output so live metrics
                    // reflect the same token classes the terminal aggregate adds;
                    // additive — callers that ignore these fields keep working.
                    deltaCachedRead: response.usage.cachedTokens || 0,
                    deltaCacheWrite: response.usage.cacheWriteTokens || 0,
                    ts: Date.now(),
                });
            } catch { /* best-effort — never break the loop */ }
        }
        // No tool calls. For PUBLIC agents, the agent contract
        // (rules/agent/00-common.md) requires either a tool call or a
        // `<final-answer>` wrapped reply.
        // A text-only turn without those tags violates the contract (e.g.
        // Opus 4.6 emits 'Now I'll polish…' preamble before its first tool
        // call) and used to leave the session idle until the idle sweep
        // collected it. Re-prompt the worker with a contract reminder; cap
        // at 2 nudges so a model that never complies still terminates the
        // loop. Hidden roles (cycle1-agent / cycle2-agent / explorer /
        // scheduler-task / webhook-handler) are exempt:
        // their own role rules define a different output contract (pipe-
        // separated chunker output, structured pipe-format, etc.) and a
        // text-only terminal turn is the correct shape — nudging them
        // produces a contradictory user message that traps the model in a
        // tool-call-blocked vs contract-required oscillation.
        if (!response.toolCalls?.length) {
            // No tool calls. Decide between final-answer accept vs nudge.
            //   - has content + non-hidden role → valid final, break.
            //   - empty content + hidden role → contract allows text-only
            //     terminal turn, break.
            //   - empty content + non-hidden role → one soft nudge. Repeated
            //     reminders waste turns and fragment the working context, so
            //     the second empty turn is accepted as terminal.
            const hasContent = typeof response.content === 'string' && response.content.trim().length > 0;
            const isHidden = HIDDEN_AGENT_NAMES.has(sessionAgent);
            const stopReason = response.stopReason ?? response.stop_reason ?? null;
            const isIncompleteStop = stopReason && INCOMPLETE_STOP_REASONS.has(stopReason);
            // A user/schedule notification can arrive while provider.send() is
            // returning a terminal no-tool response. Drain once before accepting
            // it as final so the queued input is handled in the same active turn
            // instead of waiting for post-turn TUI drain. If the model already
            // produced assistant text, persist that as an intermediate assistant
            // message before appending the steered user message.
            if (drainSteeringIntoMessages('final-pre-send', {
                beforeAppend: () => pushIntermediateAssistantResponse(response),
            })) {
                continue;
            }
            if (!hasContent && !isHidden) {
                if (contractNudges >= 1) break;
                contractNudges += 1;
                let nudgeMsg;
                if (isIncompleteStop) {
                    nudgeMsg = `[mixdog-runtime] Previous turn ended mid-synthesis (stopReason=${stopReason}) with empty content. Continue — emit <final-answer>...</final-answer> with your synthesis so far, or call more tools to finish.`;
                } else {
                    nudgeMsg = '[mixdog-runtime] Your previous response was empty (no <final-answer> tag and no tool call). Either emit your final answer wrapped in <final-answer>...</final-answer> tags, or continue with tool calls. Do not return an empty turn.';
                }
                messages.push({ role: 'user', content: nudgeMsg });
                continue;
            }
            break;
        }
        const calls = response.toolCalls;
        toolCallsTotal += calls.length;
        // Surface any mid-turn assistant text (preamble that precedes a tool
        // call) to the UI. Providers that stream text via onTextDelta already
        // rendered it; providers that return the text only in response.content
        // (no deltas) would otherwise show nothing before the tool card. The
        // engine de-dups against already-streamed text, so emitting here is
        // safe for both paths. Sub-agent sessions suppress it entirely
        // (suppressMidTurnText) — Lead only consumes the final answer.
        if (!suppressMidTurnText && typeof response.content === 'string' && response.content.trim()) {
            try { opts.onAssistantText?.(response.content); } catch { /* best-effort */ }
        }
        // Per-turn batch shape — one row per assistant turn so trace
        // consumers can derive multi-tool adoption ratio without scanning
        // every assistant message body.
        recordToolBatch(sessionId, calls.length);
        await Promise.resolve(onToolCall?.(iterations, calls));
        // Append assistant message with tool calls. reasoningItems is the
        // OpenAI Responses API replay payload (encrypted_content blobs);
        // providers that ignore it just see an extra field and drop it,
        // openai-oauth.convertMessagesToResponsesInput emits matching
        // type:'reasoning' input items on the next turn to keep the openai-oauth
        // server-side cache prefix stable.
        const _assistantTurnMsg = {
            role: 'assistant',
            // Sub-agent tool-call turns carry only mid-turn preamble in
            // response.content (the real result rides the later final-answer
            // turn). Blank it so it never accumulates as input tokens.
            content: suppressMidTurnText ? '' : (response.content || ''),
            toolCalls: compactToolCallsForHistory(calls),
            ...(Array.isArray(response.reasoningItems) && response.reasoningItems.length
                ? { reasoningItems: response.reasoningItems }
                : {}),
            ...(typeof response.reasoningContent === 'string' && response.reasoningContent
                ? { reasoningContent: response.reasoningContent }
                : {}),
        };
        messages.push(_assistantTurnMsg);
        // Execute each tool and append results.
        //
        // Intra-turn duplicate suppression: when an LLM emits two tool_use
        // blocks with identical (name, args) inside the SAME assistant turn,
                // re-executing wastes tokens. Restricted to tools with
                // `readOnlyHint:true` (= isEagerDispatchable) — bash/apply_patch
                // may be intentional repeats with distinct side effects.
        // Pre-pass identifies duplicates BEFORE startEagerRun so eager
        // dispatch also skips them, not just the for-body.
        const _duplicateCallIds = new Set();
        const _dupFirstId = new Map();
        {
            const _firstIdBySig = new Map();
            for (const c of calls) {
                if (!c?.id) continue;
                if (!isEagerDispatchable(c.name, tools)) {
                    _firstIdBySig.clear();
                    continue;
                }
                const sig = _intraTurnSig(c.name, c.arguments);
                const first = _firstIdBySig.get(sig);
                if (first === undefined) {
                    _firstIdBySig.set(sig, c.id);
                } else {
                    _duplicateCallIds.add(c.id);
                    _dupFirstId.set(c.id, first);
                }
            }
        }
        // R15: per-turn scalar read-count Map. Lifetime = this turn's tool-call batch.
        // Declared between the duplicate-detection block and the for-loop so it resets
        // Per-batch buffer for the general `newMessages` tool-result channel.
        // A tool MAY return a `{ __toolEnvelope, result, newMessages }` envelope;
        // its newMessages (e.g. the Skill SKILL.md body as a role:'user' message)
        // are collected here across EVERY call in this assistant turn and flushed
        // ONCE, AFTER the batch's last tool_result is pushed — never interleaved
        // between two tool results of the same multi-tool turn (which would put a
        // user message between tool(A) and tool(B) and break provider pairing).
        const _batchNewMessages = [];
        for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
            const call = calls[callIndex];
            if (isBuiltinTool(call.name)) {
                call.name = canonicalizeBuiltinToolName(call.name);
            }
            if (_duplicateCallIds.has(call.id)) {
                const _firstId = _dupFirstId.get(call.id);
                const _stub = `[intra-turn-dedup] identical read-only \`${call.name}\` call was already executed in this same assistant turn as tool_use_id=${_firstId}. The first call's tool_result is in context immediately above; skipping re-execution to save tokens. If you needed a different slice of the file, narrow the next call (different path / offset / limit / pattern) so it has a distinct signature.`;
                pushToolResultMessage({
                    role: 'tool',
                    content: _stub,
                    toolCallId: call.id,
                });
                continue;
            }
            // Cross-iteration repeat-failure guard. Distinct from the
            // intra-turn dedup above (which spans ONE assistant turn and
            // resets every turn): when the model re-issues an IDENTICAL
            // (name,args) call that has already failed REPEAT_FAIL_LIMIT times
            // in a row across iterations, stop re-executing — the result will
            // not change, and each retry burns a full (often slow) LLM
            // round-trip until the hard iteration cap. Steer it to change
            // approach instead.
            const _repeatFailSig = _intraTurnSig(call.name, call.arguments);
            {
                const _rfg = sessionRef?._repeatFailGuard;
                if (_rfg && _rfg.sig === _repeatFailSig && _rfg.count >= REPEAT_FAIL_LIMIT) {
                    pushToolResultMessage({
                        role: 'tool',
                        content: `[repeat-failure-guard] This exact \`${call.name}\` call (identical arguments) has already failed ${_rfg.count} times in a row; not re-executing because the result will not change. Change approach: use different arguments, a different tool, or skip this step.`,
                        toolCallId: call.id,
                    });
                    continue;
                }
            }
            if (sessionId) markSessionToolCall(sessionId, call.name);
            let result;
            let toolStartedAt;
            let toolEndedAt;
            const toolKind = getToolKind(call.name);
            // Cross-turn read dedup: if the path's stat tuple (mtime/size/ino/dev)
            // is unchanged since a prior read in THIS session, return the cached
            // body instead of executing. Both scalar and array/object-array path
            // forms are cached — keyed by (abs, offset, limit, mode, n) per entry.
            //
            // Scoped-tool cache (grep/glob/list + graph lookups): same idea
            // but keyed by (toolName, canonical args) without per-file stat.
            // These tools scan many files so a single stat tuple cannot cover
            // them. The scoped cache registers dependency roots and write-class
            // tools evict entries whose root contains the touched path.
            let _readCacheHit = null;
            let _scopedCacheHit = null;
            let _executeOk = false;
            let _resultKind = 'normal';
            // Invalid-args guard (native convergence): the provider parser tags
            // a tool call whose arguments JSON could not be parsed with an
            // invalid-args marker instead of throwing or swallowing to {}.
            // Such a call must NOT execute — there are no usable arguments and
            // permission/cache checks are meaningless. Skip straight to the
            // error-feedback path so the model gets an is_error tool_result and
            // re-issues the call with valid JSON in the same turn.
            const _invalidArgs = isInvalidToolArgsMarker(call.arguments);
            if (_invalidArgs) {
                // no cache lookup for an un-parseable call
            } else if (sessionId && _isReadTool(call.name)) {
                _readCacheHit = tryReadCached({ sessionId, args: call.arguments, cwd });
            } else if (sessionId && _isScopedCacheableTool(call.name)) {
                _scopedCacheHit = tryScopedToolCached({ sessionId, toolName: _stripMcpPrefix(call.name), args: call.arguments, cwd });
            }
            try {
                if (_invalidArgs) {
                    toolStartedAt = Date.now();
                    toolEndedAt = toolStartedAt;
                    result = formatInvalidToolArgsResult(call);
                    _resultKind = 'error';
                    _executeOk = false;
                } else if (_readCacheHit !== null) {
                    toolStartedAt = Date.now();
                    toolEndedAt = toolStartedAt;
                    const _body = _readCacheHit.content;
                    // Return the cached body byte-for-byte instead of a
                    // human-readable cache marker. The marker made public
                    // agents treat a successful cached read as a
                    // meta instruction and repeat the same read loop.
                    result = _body;
                    _resultKind = 'cache-hit';
                    _executeOk = true;
                } else if (_scopedCacheHit !== null) {
                    toolStartedAt = Date.now();
                    toolEndedAt = toolStartedAt;
                    const _body = _scopedCacheHit.content;
                    result = _body;
                    _resultKind = 'scoped-cache-hit';
                    _executeOk = true;
                } else {
                // Fallback for providers that don't stream tool calls early:
                // execute a contiguous read-only run in parallel, but never
                // cross a write/bash/MCP boundary that may change state.
                if (isEagerDispatchable(call.name, tools)) {
                    startEagerRun(calls, callIndex, _duplicateCallIds);
                }
                let eager = pending.get(call.id);
                if (eager !== undefined && eager.mutationEpoch < _mutationEpoch) {
                    pending.delete(call.id);
                    eager = undefined;
                }
                if (eager !== undefined) {
                    toolStartedAt = eager.startedAt;
                    const settled = await eager.promise;
                    if (!settled.ok) throw settled.error;
                    result = settled.value;
                    toolEndedAt = eager.endedAt ?? Date.now();
                    const _eagerKind = classifyResultKind(result);
                    if (_eagerKind === 'error') {
                        _resultKind = 'error';
                        _executeOk = false;
                    } else {
                        _executeOk = true;
                    }
                } else {
                    toolStartedAt = Date.now();
                    // Runtime pre-dispatch deny. Schema profiles may hide
                    // tools for routing efficiency, but this remains the
                    // control-plane boundary for any tool_use that still
                    // reaches the loop. preDispatchDenyForSession is the SHARED helper
                    // used by both the eager dispatch path (startEagerTool)
                    // and this serial path — keeps the agent-owned control-
                    // plane reject and no-tool role guards consistent across
                    // both paths.
                    const _denyMsg = preDispatchDenyForSession(sessionRef, call, toolKind);
                    if (_denyMsg !== null) {
                        result = _denyMsg;
                        toolEndedAt = Date.now();
                        _resultKind = 'error';
                    } else {
                        result = await executeTool(call.name, call.arguments, cwd, sessionId, sessionRef, { toolCallId: call.id, signal, notifyFn: opts.notifyFn, toolApprovalHook: opts.onToolApproval, iteration: iterations });
                        toolEndedAt = Date.now();
                        // Boundary: tool-return string convention → structural kind.
                        // The only prefix check in this codebase; downstream layers
                        // operate on _resultKind.
                        if (classifyResultKind(result) === 'error') {
                            _resultKind = 'error';
                            _executeOk = false;
                        } else {
                            _executeOk = true;
                        }
                        // _resultKind stays 'normal' when tool returned a non-error string.
                    }
                }
                } // close: else branch of _readCacheHit check
            }
            catch (err) {
                if (toolStartedAt === undefined) toolStartedAt = Date.now();
                toolEndedAt = Date.now();
                result = `Error: ${err instanceof Error ? err.message : String(err)}`;
                _resultKind = 'error';
            }
            // CENTRAL ENVELOPE NORMALIZE (general newMessages channel).
            // executeTool (serial + eager) and cache/error paths above all
            // funnel into `result`. Split ONCE here: downstream post-processing
            // (classifyResultKind / maybeOffloadToolResult / compressToolResult /
            // traceAgentTool / cache writes / messages.push) sees ONLY the
            // model-visible `result`; the `newMessages` ride a per-batch buffer
            // flushed after the batch's last tool_result (never interleaved).
            {
                const _env = normalizeToolEnvelope(result);
                result = _env.result;
                if (_env.newMessages.length) _batchNewMessages.push(..._env.newMessages);
            }
            // Bounded-map cleanup: a scoped-cache outcome recorded for this call.id
            // (via _scopedCacheOutcomeForCall) is only ever consumed/deleted on the
            // success path below (_executeOk && _resultKind==='normal'). A failed or
            // errored call would otherwise leak its entry in
            // sessionRef._scopedCacheOutcomeByCallId forever — reclaim it here.
            if (sessionRef?._scopedCacheOutcomeByCallId && call?.id && (!_executeOk || _resultKind === 'error')) {
                sessionRef._scopedCacheOutcomeByCallId.delete(call.id);
            }
            // PostToolUseFailure: a tool that resolved to a failure (thrown-error
            // path -> `Error:` string, or an is_error result classified as
            // 'error') fires the optional session failure hook. Same shape as
            // afterToolHook; `result` carries the error text. Best-effort — a
            // hook error must never wedge the tool loop.
            if (!_executeOk || _resultKind === 'error') {
                const _afterToolFailureHook = typeof opts.afterToolFailureHook === 'function'
                    ? opts.afterToolFailureHook
                    : sessionRef?.afterToolFailureHook;
                if (typeof _afterToolFailureHook === 'function') {
                    try {
                        await _afterToolFailureHook({
                            name: call.name,
                            args: call.arguments,
                            cwd,
                            sessionId,
                            toolCallId: call.id,
                            result: typeof result === 'string' ? result : String(result ?? ''),
                        });
                    } catch { /* best-effort: PostToolUseFailure hook must never break the loop */ }
                }
            }
            // Update the cross-iteration repeat-failure guard with this call's
            // outcome: bump the consecutive-failure count for an identical
            // signature, or clear it the moment the same call succeeds.
            if (sessionRef) {
                const _failed = !_executeOk || _resultKind === 'error';
                if (_failed) {
                    sessionRef._repeatFailGuard = (sessionRef._repeatFailGuard?.sig === _repeatFailSig)
                        ? { sig: _repeatFailSig, count: sessionRef._repeatFailGuard.count + 1 }
                        : { sig: _repeatFailSig, count: 1 };
                } else if (sessionRef._repeatFailGuard?.sig === _repeatFailSig) {
                    sessionRef._repeatFailGuard = null;
                }
            }
            // A failed executed call keeps its FULL argument body in history so the
            // model can retry against the original (a large apply_patch `patch`
            // would otherwise be hidden behind a
            // `[mixdog compacted …]` placeholder). Restored IMMEDIATELY — not at end
            // of loop — so an abort or post-processing throw after this point cannot
            // leave a failed patch compacted. Cache-safe: _assistantTurnMsg is not
            // transmitted until the next provider.send. Early-continue paths (dedup /
            // repeat-failure-guard) never reach here and stay compacted.
            if ((!_executeOk || _resultKind === 'error') && call?.id) {
                restoreToolCallBodyForId(_assistantTurnMsg, calls, call.id);
            }
            // Cross-turn cache maintenance — gate on both _executeOk and _resultKind==='normal'.
            // _executeOk=false catches permission-blocked / catch-path / partial-fail results.
            // _resultKind==='normal' ensures cache-hit refs are never re-stored (structural,
            // no prefix sniffing).
            // NOTE: setReadCached / setScopedToolCached are deferred below (after
            // compressToolResult) so the cache holds the same content as conversation
            // history. Cache-hit refs point to a tool_use_id whose message body matches
            // exactly what's stored — no phantom full body.
            if (sessionId && _executeOk && _resultKind === 'normal') {
                const _toolBare = _stripMcpPrefix(call.name);
                if (_readCacheHit === null && _isReadTool(call.name)) {
                    // Post-patch advisory: handle BOTH scalar and array forms
                    // of args.path. The array form (path:[a,b,c] or
                    // path:[{path:a},{path:b}]) was a coverage gap in R1 —
                    // an LLM that patches X then reads [X,Y] should still see
                    // the advisory for X.
                    const _argsPath = call.arguments?.path;
                    const _pathList = [];
                    if (typeof _argsPath === 'string') {
                        _pathList.push(_argsPath);
                    } else if (typeof call.arguments?.file_path === 'string') {
                        _pathList.push(call.arguments.file_path);
                    } else if (Array.isArray(_argsPath)) {
                        for (const _item of _argsPath) {
                            if (typeof _item === 'string') _pathList.push(_item);
                            else if (_item && typeof _item === 'object') {
                                const _itemPath = typeof _item.path === 'string' ? _item.path : _item.file_path;
                                if (typeof _itemPath === 'string') _pathList.push(_itemPath);
                            }
                        }
                    }
                    const _marks = [];
                    for (const _p of _pathList) {
                        const _m = consumePostEditMark({ sessionId, path: _p, cwd });
                        if (_m) _marks.push({ path: _p, mark: _m });
                    }
                } else if (_toolBare === 'apply_patch') {
                    // apply_patch's args are a unified-diff text in `patch`
                    // (resolved against `base_path` or cwd). Parse the diff
                    // headers (`--- a/path` / `+++ b/path`) to extract the
                    // touched paths and invalidate / mark each one. Falls
                    // back to a full session clear only when no paths could
                    // be parsed (malformed diff or unknown format).
                    const _argsBase = call.arguments?.base_path;
                    const _patchBase = (typeof _argsBase === 'string' && _argsBase.length > 0)
                        ? (isAbsolute(_argsBase) ? _argsBase : resolvePath(cwd || process.cwd(), _argsBase))
                        : (cwd || process.cwd());
                    const _touched = extractTouchedPathsFromPatch(call.arguments?.patch);
                    if (_touched.length > 0) {
                        for (const _p of _touched) {
                            invalidatePathForSession(sessionId, _p, _patchBase);
                            markPostEdit({ sessionId, path: _p, cwd: _patchBase, toolName: 'apply_patch' });
                            // R20: cross-dispatch prefetch cache invalidation.
                            invalidatePrefetchCache(_p, _patchBase);
                        }
                    } else {
                        clearReadDedupSession(sessionId);
                        // R20: path unknown — can't target; no-op on prefetch cache
                        // (stat-validation at lookup time will naturally reject stale entries).
                    }
                    // Targeted scoped-cache invalidation: only evict entries whose
                    // dep paths intersect the touched set. Full wipe is the fallback
                    // when no paths were extracted (D).
                    if (_touched.length > 0) {
                        clearScopedToolsForSessionPaths(sessionId, _touched, _patchBase);
                    } else {
                        clearScopedToolsForSession(sessionId);
                    }
                }
            } // end _executeOk+_resultKind gate (scoped tool cache set)
            // E: mutation tools (apply_patch) must invalidate caches
            // even on returned-error/partial-fail — the file state is unknown after
            // an error exit, and some tools report failure as an Error: result string
            // rather than throwing.
            // This block runs unconditionally (not gated on _executeOk or _resultKind).
            if (sessionId && (!_executeOk || _resultKind === 'error') && _stripMcpPrefix(call.name) === 'apply_patch') {
                clearReadDedupSession(sessionId);
            }
            if (_isMutationTool(call.name)) {
                _mutationEpoch += 1;
            }
            // Bash always clears scoped cache UNCONDITIONALLY — a mutating bash
            // that throws or fails partway can still leave stale find_symbol / grep entries.
            // Must not be gated on _executeOk or _resultKind.
            if (sessionId && _isShellTool(call.name)) {
                clearScopedToolsForSession(sessionId);
            }
            // R17 compression pipeline — correct ordering (compress → cache → push):
            //   1. compressToolResult: lossless ANSI/dedup/separator passes.
            //   2. setReadCached / setScopedToolCached: cache stores the SAME result that
            //      goes into conversation history. Cache-hit refs point to the tool_use_id
            //      whose message body matches — no phantom full body.
            //   3. offload → hint → message push.
            // Offload FIRST — before compress. Large RAW output goes to a disk sidecar
            // + ~2K preview before any in-place shrink (lossless compress) can reduce
            // it below the offload threshold and pre-empt the sidecar. When offload
            // fires it replaces `result` with a short preview stub (<2K) referencing
            // the on-disk path; the later compress is a no-op on that stub. compress
            // then only touches output that stayed inline (<= threshold).
            // Per-tool post-processing backstop. The executeTool try/catch
            // above terminates BEFORE offload/compress/trim/hint/cache writes/
            // trace/messages.push, so a maybeOffloadToolResult rejection (or
            // any downstream throw) would otherwise leave the assistant
            // tool_use message with no matching tool result. Wrap the whole
            // post-processing window through messages.push() in a catch; on
            // failure push a synthetic Error: tool result for this call.id
            // and skip the cache writes for it.
            let _postProcessOk = true;
            let _nativeToolSearch = null;
            try {
                // Offload thresholds are keyed by BARE tool name
                // (INLINE_THRESHOLD_BY_TOOL: grep=20k, bash=30k, read=Infinity, ...),
                // so strip the MCP prefix exactly as the cache write below does.
                // Otherwise an mcp__..__grep name misses its 20k grep cap and
                // silently falls back to the 50k default — per-tool limits ignored.
                const _toolBare = _stripMcpPrefix(call.name);
                _nativeToolSearch = parseNativeToolSearchPayload(call.name, result);
                if (_nativeToolSearch?.summary) result = _nativeToolSearch.summary;
                result = await maybeOffloadToolResult(sessionId, call.id, _toolBare, result);
                result = compressToolResult(call.name, call.arguments, result, { sessionId, toolKind });
                traceAgentTool({
                    sessionId,
                    iteration: iterations,
                    toolName: call.name,
                    toolKind,
                    toolMs: toolEndedAt - toolStartedAt,
                    toolArgs: call.arguments,
                    agent: sessionRef?.agent || null,
                    model: sessionRef?.model || null,
                    resultKind: _resultKind,
                    resultText: result,
                    cwd,
                });
                // Cache stores run AFTER compress+trim+offload+hint AND after all other
                // post-processing (trace) so stored content == history content. Placing
                // the cache writes immediately before messages.push ensures ANY throw
                // earlier in post-processing skips the cache entirely — no stale or
                // partial result is ever cached. Cache-hit refs pointing to an offloaded
                // tool_use will show the offload stub; LLM can still recover the full
                // body via the disk path in that stub.
                if (sessionId && _executeOk && _resultKind === 'normal') {
                    if (_scopedCacheHit === null && _isScopedCacheableTool(call.name)) {
                        const _outcome = sessionRef?._scopedCacheOutcomeByCallId?.get(call.id);
                        setScopedToolCached({
                            sessionId,
                            toolName: _toolBare,
                            args: call.arguments,
                            cwd,
                            content: result,
                            toolUseId: call.id,
                            complete: _outcome ? _outcome.complete : true,
                        });
                        sessionRef?._scopedCacheOutcomeByCallId?.delete(call.id);
                    }
                    if (_readCacheHit === null && _isReadTool(call.name)) {
                        // Pass tool_use id so future cache-hits can reference the body's location in history.
                        setReadCached({ sessionId, args: call.arguments, cwd, content: result, toolUseId: call.id });
                    }
                }
                // UI-only: apply_patch stashes the standard unified diff keyed
                // by tool_use id (never in the model-visible result). Attach it
                // here as a side-channel field so the TUI's expanded (ctrl+o)
                // raw view renders a colored +/- diff. The provider lowering
                // (anthropic/openai/etc.) never reads `uiDiff`, so the model
                // sees only `content` (the compact summary) — no token bloat.
                const _applyPatchUiDiff = _stripMcpPrefix(call.name) === 'apply_patch'
                    ? takeApplyPatchUiDiff(call.id)
                    : null;
                pushToolResultMessage({
                    role: 'tool',
                    content: result,
                    toolCallId: call.id,
                    toolKind: _resultKind,
                    ...(_nativeToolSearch ? { nativeToolSearch: _nativeToolSearch } : {}),
                    ...(_applyPatchUiDiff ? { uiDiff: _applyPatchUiDiff } : {}),
                });
            } catch (postErr) {
                _postProcessOk = false;
                // Post-processing failed AFTER a successful exec: the result is
                // replaced with an error below, so preserve this call's full body
                // too for a clean retry (mirrors the failed-exec path above).
                if (call?.id) restoreToolCallBodyForId(_assistantTurnMsg, calls, call.id);
                const _postMsg = `Error: tool result post-processing failed for "${call.name}": ${postErr instanceof Error ? postErr.message : String(postErr)}`;
                traceAgentToolFailure({
                    sessionId,
                    iteration: iterations,
                    toolName: call.name,
                    toolKind,
                    toolMs: toolEndedAt && toolStartedAt ? toolEndedAt - toolStartedAt : null,
                    toolArgs: call.arguments,
                    agent: sessionRef?.agent || null,
                    model: sessionRef?.model || null,
                    cwd,
                    resultText: _postMsg,
                    resultKind: 'error',
                });
                // Always emit a matching tool result so the assistant
                // tool_use isn't orphaned. Cache writes are placed at the
                // end of the try block (immediately before messages.push),
                // so ANY throw in post-processing reaches this catch before
                // the cache is written — stale/partial results are never
                // cached. The next read on the same path/scope re-executes
                // naturally.
                pushToolResultMessage({
                    role: 'tool',
                    content: _postMsg,
                    toolCallId: call.id,
                    toolKind: 'error',
                });
            }
            // Soft-cancel after each tool: if close landed during execution,
            // discard the rest of the batch and skip the next provider.send.
            throwIfAborted();
        }
        // Flush the per-batch newMessages channel. All tool_results for this
        // assistant turn are now pushed; appending the injected role:'user'
        // messages here (AFTER the last tool_result, BEFORE the next provider
        // send) keeps provider pairing valid — no user message is interleaved
        // between tool(A) and tool(B). pre-send repairTranscriptBeforeProviderSend
        // normalizes any residual ordering. The injected messages carry their
        // own meta flag (e.g. meta:'skill') so compaction's latest-human-prompt
        // selection does not mistake them for the user's request.
        for (const _nm of _batchNewMessages) {
            if (!_nm || _nm.role !== 'user' || typeof _nm.content !== 'string' || !_nm.content) continue;
            messages.push({ role: 'user', content: _nm.content, ...(_nm.meta ? { meta: _nm.meta } : {}) });
        }
        // PostToolBatch: the full parallel batch of tool calls for this
        // assistant turn has resolved and all tool_results are pushed. Fire the
        // optional session hook before the next model call. No matcher event.
        // Block support: if the hook returns blocked===true, inject its reason
        // as a system-note user message for the next send (natural mechanism —
        // same channel the newMessages flush just used). Best-effort otherwise.
        {
            const _afterToolBatchHook = typeof opts.afterToolBatchHook === 'function'
                ? opts.afterToolBatchHook
                : sessionRef?.afterToolBatchHook;
            if (typeof _afterToolBatchHook === 'function' && calls.length > 0) {
                try {
                    const _batchDecision = await _afterToolBatchHook({
                        sessionId,
                        cwd,
                        toolCount: calls.length,
                    });
                    if (_batchDecision?.blocked === true) {
                        const _reason = String(_batchDecision.reason || 'PostToolBatch hook blocked continuation').trim();
                        if (_reason) {
                            messages.push({ role: 'user', content: `<system-reminder>\n${_reason}\n</system-reminder>`, meta: 'hook' });
                        }
                    }
                } catch { /* best-effort: PostToolBatch hook must never break the loop */ }
            }
        }
        // Missed-parallelism steering: 3+ consecutive turns of a single
        // read-only tool call suggest the model isn't batching independent
        // lookups. Nudge once, then reset (fires again after 3 more).
        if (calls.length === 1 && isEagerDispatchable(calls[0].name, tools)) {
            _serialReadOnlyStreak += 1;
            if (_serialReadOnlyStreak >= 3) {
                messages.push({ role: 'user', content: '<system-reminder>\nLast 3 turns each ran a single read-only tool. Batch independent lookups (read/grep/glob/code_graph) into ONE turn, or start editing if you have enough context.\n</system-reminder>', meta: 'hook' });
                _serialReadOnlyStreak = 0;
            }
        } else {
            _serialReadOnlyStreak = 0;
        }
        // Mid-turn steering is drained at the next loop's pre-send point,
        // AFTER any auto-compact pass. Draining here would put the steering
        // user turn after the fresh tool results before compaction runs; then
        // semantic/recall compaction would treat those fresh tool results as
        // prior history before the model sees them.
        // About to re-send with tool results — transition back to connecting for the next turn.
        if (sessionId) updateSessionStage(sessionId, 'connecting');
    }
    // Classify WHY the loop ended so agent-tool can promote an empty/abnormal
    // finish to an explicit Lead-facing error instead of a silent empty
    // "completed". Determine "has content" exactly the way the no-tool-call
    // branch above does (trimmed string content, or any reasoning content).
    const _finalHasContent = (typeof response?.content === 'string' && response.content.trim().length > 0)
        || (typeof response?.reasoningContent === 'string' && response.reasoningContent.trim().length > 0);
    const _finalStopReason = response?.stopReason ?? response?.stop_reason ?? null;
    const _finalIncompleteStop = _finalStopReason && INCOMPLETE_STOP_REASONS.has(_finalStopReason);
    const _finalIsHidden = HIDDEN_AGENT_NAMES.has(sessionAgent);
    let terminationReason;
    if (terminatedByCap) {
        // Real problem regardless of hidden/public: the loop never terminated
        // on its own contract.
        terminationReason = 'iteration_cap';
    } else if (!_finalHasContent && _finalIncompleteStop) {
        // Cut short mid-synthesis (token cap / provider pause). Real problem
        // for hidden agents too.
        terminationReason = 'truncated';
    } else if (!_finalHasContent && !_finalIsHidden) {
        // Empty terminal turn. Only public agents violate their contract by
        // finishing empty — hidden agents (explorer/cycle/…) legitimately emit
        // text-only/empty terminal turns per their own role contract, so leave
        // terminationReason undefined for them.
        terminationReason = 'empty';
    } else {
        terminationReason = undefined;
    }
    return {
        ...response,
        usage: lastUsage || response.usage,
        lastTurnUsage: response.usage,
        firstTurnUsage: firstTurnUsage || response.usage,
        iterations,
        toolCallsTotal,
        providerState,
        terminationReason,
        maxLoopIterations,
    };
}
