import { classifyResultKind } from './result-classification.mjs';
import { canonicalizeBuiltinToolName, executeBuiltinTool, isBuiltinTool } from '../tools/builtin.mjs';
import { takeApplyPatchUiDiff } from '../tools/patch.mjs';
import { executeInternalTool, isInternalTool } from '../internal-tools.mjs';
import { normalizeToolEnvelope } from './tool-envelope.mjs';
import { traceAgentLoop, traceAgentTool, traceAgentToolFailure, traceAgentCompact, estimateProviderPayloadBytes, messagePrefixHash, appendAgentTrace } from '../agent-trace.mjs';
import { resolveSessionMaxLoopIterations } from '../agent-runtime/agent-loop-policy.mjs';
import { isAgentOwner } from '../agent-owner.mjs';
import { markSessionToolCall, updateSessionStage, SessionClosedError, bumpUsageMetricsEpoch } from './manager.mjs';
import {
    pruneToolOutputs,
    pruneToolOutputsUnanchored,
    semanticCompactMessages,
    effectiveBudget as compactEffectiveBudget,
    DEFAULT_COMPACT_TYPE,
} from './compact.mjs';
import { isContextOverflowError } from '../providers/retry-classifier.mjs';
import { stripSoftWarns } from '../tool-loop-guard.mjs';
import { maybeOffloadToolResult } from './tool-result-offload.mjs';
import { tryReadCached, setReadCached, invalidatePathForSession, clearReadDedupSession, extractTouchedPathsFromPatch, tryScopedToolCached, setScopedToolCached, clearScopedToolsForSession, clearScopedToolsForSessionPaths, invalidatePrefetchCache } from './read-dedup.mjs';
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
import { runRecallFastTrackCompact } from './loop/recall-fasttrack.mjs';
import { executeTool, _scopedCacheOutcomeForCall, resolveLiveToolCwd } from './loop/tool-exec.mjs';

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
import {
    crossTurnSignature,
    crossTurnDedupStub,
    ITERATION_CAP_REFUSAL_STUB,
} from './loop/completion-guards.mjs';
import { STOP_HOOK_SOURCE, createToolFailureStopHook } from './loop/stop-hooks.mjs';
import { isEditProgressTool } from './loop/completion-guards.mjs';
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
    normalizeHookUpdatedToolOutput,
    resolveToolResultAfterHook,
    parseNativeToolSearchPayload,
    formatMissingToolApprovalUiDenial,
    resolvePreToolAskApproval,
    approvalGranted,
    approvalReason,
} from './loop/tool-helpers.mjs';
import {
    compactToolCallsForHistory,
    compactSettledToolCallBodies,
    restoreToolCallBodyForId,
} from './loop/stored-tool-args.mjs';
import { repairTranscriptBeforeProviderSend } from './loop/transcript-repair.mjs';
import {
    classifyTerminationReason,
    INCOMPLETE_STOP_REASONS,
    isOutputLimitStopReason,
    providerContinuationSignal,
} from './loop/termination.mjs';
import { runPreSendCompactPass } from './pre-send-compact.mjs';
import { createEagerDispatcher } from './eager-dispatch.mjs';
import { sendWithRecovery } from './send-with-recovery.mjs';
import { processToolBatch } from './tool-batch.mjs';
import { snapshotProviderRequestTools } from '../../../../session-runtime/tool-catalog.mjs';
import {
    providerNativeToolPrefixCount,
    runWithProviderRequestToolsScope,
} from '../../../../session-runtime/provider-request-tools.mjs';

// Facade re-exports: these symbols moved to split modules under ./loop/ but
// remain part of loop.mjs's public surface (imported by scripts/tests and other
// runtime modules). Re-export the already-imported local bindings so every
// existing import path keeps working (no duplicate module binding).
export {
    preDispatchDenyForSession,
    repairTranscriptBeforeProviderSend,
    normalizeHookUpdatedToolOutput,
    resolveToolResultAfterHook,
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
// Structured provider continuations (endTurn=false / pause_turn) are honored,
// but must not sustain an unbounded text-only loop: a lead session was
// observed burning a 30-minute agent budget (26K output tokens, zero tool
// calls) on back-to-back continuations. After this many continuations with no
// intervening tool batch, the current text is accepted as the final answer.
const PROVIDER_CONTINUATION_NO_TOOL_LIMIT = Math.max(1, Number(process.env.MIXDOG_PROVIDER_CONTINUATION_NO_TOOL_LIMIT) || 8);
// A provider max-output stop is not a completed assistant turn, even when it
// contains useful text. Preserve each partial in the provider transcript and
// grant at most three direct continuations before surfacing a hard truncation.
const MAX_OUTPUT_RECOVERY_LIMIT = 3;
const MAX_OUTPUT_EXHAUSTED_NOTICE = '[mixdog-runtime] Output remained truncated after 3 continuation attempts.';
// _scopedCacheOutcomeForCall and executeTool moved to ./loop/tool-exec.mjs
// (imported above).
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
export function attachAssistantTranscriptMetadata(message, opts = {}) {
    const transcript = typeof opts.takeAssistantTranscriptMetadata === 'function'
        ? opts.takeAssistantTranscriptMetadata()
        : null;
    if (!transcript) return message;
    const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
    return { ...message, meta: { ...meta, transcript } };
}

export async function agentLoop(provider, messages, model, tools, onToolCall, cwd, sendOpts) {
    let iterations = 0;
    let toolCallsTotal = 0;
    let lastUsage;
    let firstTurnUsage;
    let response;
    let lastSendTools = tools;
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
    let providerStateUpdated = false;
    let _providerStateCleared = false;
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
    // Sub-agent (worker/heavy-worker/reviewer/…) sessions
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
    // Deferred mutation-body compaction: bodies left verbatim by a previous
    // turn's push (deferBodies below) collapse to markers now — the model has
    // already seen them on that turn's follow-up send. Failed bodies stay
    // verbatim for retry.
    // Out-of-loop transcript mutations (post-turn/manual compaction in
    // manager/compaction-runner.mjs) run where no send opts exist; they park a
    // one-shot intent on the session so the FIRST send of the next turn tags
    // its expected cache break instead of an unexplained prefix mismatch.
    if (!opts.cacheBreakIntent && typeof sessionRef?.pendingCacheBreakIntent === 'string') {
        opts.cacheBreakIntent = sessionRef.pendingCacheBreakIntent;
        delete sessionRef.pendingCacheBreakIntent;
    }
    if (compactSettledToolCallBodies(messages) && !opts.cacheBreakIntent) {
        opts.cacheBreakIntent = 'deferred_body_compaction';
    }
    // ---- Turn stop hook ----------------------------------------------------
    // A no-tool assistant message is TERMINAL. Only a structured provider
    // follow-up signal (end_turn=false / pause_turn), pending input, tool
    // calls/results, or a stop hook that blocks with a continuation prompt keep
    // sampling alive. The single hook below is structural: after an unresolved
    // real tool failure it blocks the first terminal message ONCE, records the
    // continuation prompt, and then stays inactive for the rest of the turn.
    const _toolFailureStopHook = createToolFailureStopHook();
    const pushToolResultMessage = (message) => {
        messages.push(message);
        _toolFailureStopHook.observeToolResult(message);
        try { opts.onToolResult?.(message); } catch {}
    };
    const drainSteeringIntoMessages = (stage = 'mid-turn', options = {}) => {
        if (typeof opts.drainSteering !== 'function') return false;
        let steerMsgs = [];
        // The stage rides along so the host can scope which queues a drain may
        // consume (mid-turn tool-batch boundary vs the terminal pending-input
        // check that precedes the stop hooks).
        try { steerMsgs = opts.drainSteering(sessionId, { ...options, stage }) || []; }
        catch { steerMsgs = []; }
        const mergedMessages = [];
        for (const entry of Array.isArray(steerMsgs) ? steerMsgs : []) {
            const merged = mergeSteeringEntries([entry]);
            if (merged) mergedMessages.push(merged);
        }
        if (mergedMessages.length === 0) return false;
        if (typeof options.beforeAppend === 'function') {
            try { options.beforeAppend(); } catch { /* best-effort hook */ }
        }
        let totalCount = 0;
        let totalTextLen = 0;
        let maxQueueWaitMs = 0;
        for (const merged of mergedMessages) {
            const submissionIds = Array.isArray(merged.ids) ? merged.ids : [];
            const submittedAt = Number(merged.submittedAt);
            const injectedAt = Date.now();
            if (Number.isFinite(submittedAt) && submittedAt > 0) {
                maxQueueWaitMs = Math.max(maxQueueWaitMs, injectedAt - submittedAt);
            }
            // Tag steering-origin user messages so provider lowering keeps them
            // distinct from preceding tool results. Keep each queued command as
            // its own user turn instead of collapsing priority/mode buckets
            // together.
            messages.push({
                role: 'user',
                content: merged.content,
                meta: {
                    source: 'steering',
                    ...(submissionIds.length ? { submissionIds } : {}),
                },
            });
            const text = merged.text || steeringContentText(merged.content);
            totalCount += Number(merged.count) || 1;
            totalTextLen += String(text || '').length;
            try {
                opts.onSteerMessage?.(text, {
                    ids: submissionIds,
                    submittedAt: Number.isFinite(submittedAt) && submittedAt > 0 ? submittedAt : undefined,
                    injectedAt,
                    stage,
                    ...(Array.isArray(merged.images) && merged.images.length ? { images: merged.images } : {}),
                });
            } catch {}
        }
        if (sessionId) {
            try {
                process.stderr.write(
                    `[steer] sess=${sessionId} injected ${stage} user message(s)`
                    + ` (merged=${totalCount} len=${totalTextLen} waitMs=${Math.max(0, maxQueueWaitMs)})\n`,
                );
            } catch {}
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
        const thinkingBlocks = Array.isArray(resp.thinkingBlocks) && resp.thinkingBlocks.length
            ? resp.thinkingBlocks
            : null;
        const providerMetadata = resp.providerMetadata && typeof resp.providerMetadata === 'object'
            ? resp.providerMetadata
            : null;
        const stopReason = resp.stopReason ?? resp.stop_reason ?? null;
        const terminationReason = resp.terminationReason ?? null;
        // Anthropic native server-tool turns (web search / code execution /
        // native MCP) carry `server_tool_use` + `*_tool_result` blocks that
        // exist ONLY in this ordered verbatim list — they cannot be rebuilt
        // from content/thinkingBlocks/toolCalls, and dropping them breaks the
        // resumed turn (a result block is only valid right after its call
        // block). Attach them so Anthropic lowering replays the turn as-is.
        // Guarded on no client tool calls: this committer only handles
        // continuation/intermediate turns. A MIXED turn (native blocks +
        // client tool_use) is committed by the tool-call branch below, which
        // keeps both the compacted toolCalls and these blocks.
        const assistantBlocks = Array.isArray(resp.assistantBlocks)
            && resp.assistantBlocks.length
            && !resp.toolCalls?.length
            ? resp.assistantBlocks
            : null;
        // A native-only turn (server tool blocks, no flattened text) is real
        // assistant output and must stay committable — not treated as empty.
        if (!content && !reasoningContent && !reasoningItems && !thinkingBlocks && !assistantBlocks) return false;
        const message = attachAssistantTranscriptMetadata({
            role: 'assistant',
            content,
            // assistantBlocks already contains the thinking blocks verbatim in
            // stream order, so thinkingBlocks is redundant (and would be
            // double-counted by the context estimator) when it is present.
            ...(assistantBlocks ? { assistantBlocks } : {}),
            // Anthropic adaptive-thinking signatures must be replayed verbatim
            // before the continuation turn, just like tool-call trajectories.
            ...(thinkingBlocks && !assistantBlocks ? { thinkingBlocks } : {}),
            ...(reasoningItems ? { reasoningItems } : {}),
            ...(reasoningContent ? { reasoningContent } : {}),
            ...(providerMetadata ? { providerMetadata } : {}),
            ...(stopReason ? { stopReason } : {}),
            ...(terminationReason ? { terminationReason } : {}),
        }, opts);
        messages.push(message);
        try { opts.onAssistantMessageCommitted?.(message); } catch {}
        return true;
    };
    const maxLoopIterations = resolveSessionMaxLoopIterations(sessionRef);
    // ---- Completion-first loop guards (worker runaway prevention) ----
    // Behavior-steering hints (missed-parallelism, all-read-only, read-only
    // shell, level-2 "stop exploring") were removed: they nudged tool shape
    // instead of protecting resources. Only the staged iteration warnings, the
    // hard cap, and the cross-turn dedup stub remain.
    // _editCount counts any executed tool call whose def lacks readOnlyHint
    // (i.e. edit/progress: apply_patch, bash, MCP writes, skills, ...).
    let _editCount = 0;
    // Step 2: cross-turn identical read-only call dedup. Map keyed by
    // signature(name + stableStringify(args)) → { count, firstIteration }.
    // Populated only for SUCCESSFUL isEagerDispatchable (read-only) calls.
    // Bounded to 500 entries (drop-oldest / insertion order).
    const _crossTurnCalls = new Map();
    const _CROSS_TURN_CAP = 500;
    let _dedupStubTotal = 0;
    // Hard-cap final-answer turn: one tool-less wrap-up turn granted when the
    // hard iteration cap fires, so the session ends with text, not empty.
    let _capFinalTurnUsed = false;
    // True while the granted hard-cap final turn is active (no tool defs).
    let _capFinalToolsDisabled = false;
    // Consecutive empty-turn contract nudges. A model that answers the same
    // nudge with another empty turn is in a deterministic livelock (same
    // context in → same empty completion out); re-sending an identical nudge
    // 199× just burns the iteration budget (observed: sess_10400…9dfdc436,
    // 199 identical nudges to the 200-iteration cap). Cap the streak and end
    // the loop as an explicit empty termination instead.
    let _emptyNudgeStreak = 0;
    const EMPTY_NUDGE_MAX = 3;
    let _refusalRetryUsed = false;
    let _maxOutputRecoveryCount = 0;
    // Committed-but-unsealed text segments for the caller-facing aggregate:
    // max-output recovery parts plus (Lead/TUI only) text-only continuation
    // segments (provider pause_turn / terminal steering / stop hook). The
    // terminal response returns content = parts + terminal so the UI row that
    // accumulated every streamed segment is not overwritten down to only the
    // last segment; historyContent keeps persistence single-copy. Reset after
    // each executed tool batch — the UI seals its row at tool boundaries, so a
    // pre-tool part re-prepended at terminal would duplicate a sealed row.
    const _committedTextParts = [];
    // Count of structured provider continuation signals honored this turn
    // (endTurn === false / stopReason === 'pause_turn'). Diagnostic only; the
    // hard iteration cap remains the sole bound on how long a provider may
    // keep declaring "not done" inside one user turn.
    let _providerContinuationCount = 0;
    // Continuations since the last executed tool batch — bounds the text-only
    // continuation runaway (see PROVIDER_CONTINUATION_NO_TOOL_LIMIT).
    let _continuationsSinceToolBatch = 0;
    // Loop-level transport replays consumed since the last SUCCESSFUL send
    // (see send-with-recovery TRANSPORT_RETRY_MAX). Reference parity: codex
    // starts each sampling request at retries=0 (and resets on transport
    // fallback), cc's withRetry budget is per request, opencode schedules
    // retries per stream call. A per-ask budget instead let one early blip in
    // a long turn leave every later iteration with zero replays.
    let _transportRetriesUsed = 0;
    let _imageStripUsed = false;
    let _sendMessages = null;
    // Queued prompt/task notifications are attached after a
    // tool batch, before the continuation provider send. Normal batches drain
    // up to 'next'; a Sleep-like tool grants a 'later' flush.
    let _toolBatchJustCompleted = false;
    let _lastToolBatchEndedAt = 0;
    let _lastToolBatchHadSleep = false;
    const isSleepLikeToolCall = (call) => {
        const name = String(call?.name || call?.toolName || call?.function?.name || '').toLowerCase();
        return name === 'sleep' || name.endsWith('/sleep') || name.endsWith('.sleep');
    };
    // sessionRef.cwd is the live SSOT. The legacy positional cwd is only the
    // turn-start snapshot and becomes stale after an in-turn cwd tool call.
    cwd = resolveLiveToolCwd(cwd, sessionRef);
    // Staged pre-cap warnings + one true hard stop. The ONLY count-based
    // forced termination is the hard cap at maxLoopIterations (default 200):
    // a genuine runaway guard. Before it, staged warnings fire at 50%/75%/90%
    // of the cap steering the model to converge — warnings only, nothing is
    // cut off early. Other runaway protection is behavior-based (steering
    // ladder hints, REPEAT_FAIL_LIMIT), never a lower iteration count.
    let _iterWarnStage = 0;
    // Tiny-cap loops can't afford staged 50/75/90%
    // steers — the 50% stage lands on iteration 1 in every session, spamming
    // the normal batch→answer path. For caps < 10 emit ONE wrap-up warning at
    // the penultimate iteration instead; caps >= 10 keep staged behavior.
    const _singleWarn = maxLoopIterations < 10;
    const _iterWarnAt = _singleWarn
        ? [Math.max(1, maxLoopIterations - 1)]
        : [
            Math.floor(maxLoopIterations * 0.5),
            Math.floor(maxLoopIterations * 0.75),
            Math.floor(maxLoopIterations * 0.9),
        ];
    while (true) {
        // A cwd tool call updates sessionRef in place. Refresh before building
        // this iteration's eager dispatcher and cache keys so every following
        // tool family, including apply_patch, observes the new write root.
        cwd = resolveLiveToolCwd(cwd, sessionRef);
        const _iterT0 = Date.now();
        throwIfAborted();
        if (iterations >= maxLoopIterations) {
            // Final-answer turn: instead of breaking mid-transcript (which
            // yields an empty final for locator-style agents that never got to
            // answer), give the model ONE text-only turn to wrap up, then stop.
            // Tool DEFINITIONS stay in-request (stable cache prefix) but tool
            // USE is forbidden via tool_choice:'none'; any tool call a
            // toolChoice-ignoring provider still emits gets a refusal stub.
            if (_capFinalTurnUsed) {
                process.stderr.write(`[loop] hard iteration cap ${maxLoopIterations} reached (sess=${sessionId || 'unknown'}); stopping loop.\n`);
                terminatedByCap = true;
                // The granted final turn produced no text (model kept emitting
                // tool calls into refusal stubs, or thinking-only). Synthesize a
                // non-empty final so callers never see an empty response.
                if (response && !String(response.content || '').trim()) {
                    response.content = '[iteration cap reached before final text]';
                    if (Array.isArray(response.toolCalls)) response.toolCalls = [];
                }
                break;
            }
            _capFinalTurnUsed = true;
            _capFinalToolsDisabled = true;
            const finalTurnReminder = 'Iteration cap reached — tools disabled; answer with your best result from context.';
            messages.push({ role: 'user', content: `<system-reminder>\n${finalTurnReminder}\n</system-reminder>`, meta: 'hook' });
            process.stderr.write(`[loop] hard iteration cap ${maxLoopIterations} reached (sess=${sessionId || 'unknown'}); forcing final text turn.\n`);
        }
        if (_iterWarnStage < _iterWarnAt.length && iterations >= _iterWarnAt[_iterWarnStage]) {
            _iterWarnStage += 1;
            const warnAt = _iterWarnAt[_iterWarnStage - 1];
            const stageMsg = _singleWarn
                ? `Iteration budget nearly spent: ${warnAt} of ${maxLoopIterations} iterations used — answer NOW with the best anchors you already hold.`
                : _iterWarnStage === 1
                    ? `Iteration budget notice: ${warnAt} of ${maxLoopIterations} iterations used. Converge on a conclusion: prefer finishing the current objective over opening new exploration.`
                    : `Iteration budget warning (stage ${_iterWarnStage}): ${warnAt} of ${maxLoopIterations} iterations used — the loop hard-stops at ${maxLoopIterations}. Wrap up now: summarize progress, state what remains, and finish with your best current result.`;
            messages.push({ role: 'user', content: `<system-reminder>\n${stageMsg}\n</system-reminder>`, meta: 'hook' });
            process.stderr.write(`[loop] iteration warning stage ${_iterWarnStage} at ${iterations} (sess=${sessionId || 'unknown'}); continuing with steer.\n`);
            try {
                appendAgentTrace({
                    sessionId,
                    iteration: iterations,
                    kind: 'steer',
                    payload: { tag: 'iteration_warning', stage: _iterWarnStage, at: iterations, unit: maxLoopIterations },
                    agent: sessionAgent || null,
                });
            } catch { /* best-effort */ }
        }
        // Drain queued steering/prompts BEFORE the pre-send compact check, but
        // only immediately after a tool batch has completed: queued entries
        // are attached after tool results are appended and before the recursive
        // continuation, not on arbitrary non-tool continuations (empty nudges,
        // iteration-cap final text turns, etc.).
        if (_toolBatchJustCompleted) {
            drainSteeringIntoMessages('pre-send', {
                maxPriority: _lastToolBatchHadSleep ? 'later' : 'next',
            });
            _toolBatchJustCompleted = false;
            _lastToolBatchHadSleep = false;
        }
        const baseSendTools = _capFinalToolsDisabled
            ? tools
            : (forcedFirstToolDef && toolCallsTotal === 0 ? [forcedFirstToolDef] : tools);
        let sendTools;
        let requestToolScope;
        let compactChanged;
        do {
            // Provider-history normalization is part of the request boundary:
            // repair first, then take exactly one immutable tool snapshot for
            // pressure, send, recovery, and usage/baseline telemetry.
            const messagesBeforeTranscriptRepair = messages.slice();
            repairTranscriptBeforeProviderSend(messages, sessionId);
            if (!opts.cacheBreakIntent
                && (messages.length !== messagesBeforeTranscriptRepair.length
                    || messages.some((message, index) => message !== messagesBeforeTranscriptRepair[index]))) {
                opts.cacheBreakIntent = 'transcript_rebuild';
            }
            for (let _i = 0; _i < messages.length; _i++) {
                const _m = messages[_i];
                if (_m && _m.role === 'tool' && typeof _m.content === 'string' && _m.content.includes('⚠')) {
                    const _stripped = stripSoftWarns(_m.content);
                    if (_stripped !== _m.content) {
                        _m.content = _stripped;
                        if (!opts.cacheBreakIntent) opts.cacheBreakIntent = 'soft_warn_strip';
                    }
                }
            }
            sendTools = snapshotProviderRequestTools({
                provider: sessionRef?.provider || provider?.name,
                tools: baseSendTools,
                nativeTools: opts.nativeTools,
                messages,
                session: sessionRef,
            });
            requestToolScope = {
                session: sessionRef,
                provider: sessionRef?.provider || provider?.name,
                messages,
                requestTools: sendTools,
                nativePrefixCount: providerNativeToolPrefixCount(sendTools),
            };
            ({
                iterations,
                lastUsage,
                firstTurnUsage,
                providerState,
                providerStateCleared: _providerStateCleared,
                reactiveOverflowRetryPending,
                compactChanged,
            } = await runWithProviderRequestToolsScope(requestToolScope, () => runPreSendCompactPass({
                provider,
                messages,
                model,
                requestTools: sendTools,
                sessionRef,
                sessionId,
                cwd,
                opts,
                signal,
                iterations,
                lastUsage,
                firstTurnUsage,
                providerState,
                reactiveOverflowRetryPending,
                loopUsageMetricsTurnId,
                loopUsageMetricsEpoch,
            })));
            if (_providerStateCleared) providerStateUpdated = true;
            // A changed transcript ends this request attempt. Repair the new
            // history and establish one fresh post-compaction snapshot before
            // evaluating pressure again or sending.
        } while (compactChanged);
        const nextIteration = iterations + 1;
        opts.iteration = nextIteration;
        opts.providerState = providerState;
        if (_capFinalToolsDisabled) {
            // Hard-cap final turn: forbid tool USE (tool_choice:'none') instead
            // of stripping tool DEFINITIONS. Sending tools:[] changed the
            // tools→system→messages prefix chain, so Anthropic could no longer
            // prefix-match and re-prefilled the whole prompt (~10k, cache
            // read=0) on the final capped turn. Keeping the tools in-request
            // holds the prefix byte-stable; 'none' makes the model emit text
            // only. Overrides the forced-first-tool path below.
            opts.toolChoice = 'none';
        } else if (forcedFirstTool && toolCallsTotal === 0) {
            opts.toolChoice = 'required';
        } else {
            delete opts.toolChoice;
        }
        // The adapter must serialize this exact immutable list. Direct adapter
        // callers omit the flag and retain legacy live deferred resolution.
        opts.providerToolSnapshotAuthoritative = true;
        opts.providerNativeToolPrefixCount = requestToolScope.nativePrefixCount;
        lastSendTools = sendTools;
        // Eager-dispatch queue: when the provider streams a tool-call event,
        // start read-only tools immediately so execution overlaps with the
        // remaining SSE parse. Writes and unknown tools wait until send()
        // returns and run serially in the call-order loop below.
        // Eager-dispatch queue (see ./eager-dispatch.mjs): read-only tools
        // start the instant the provider streams a tool-call event; the
        // dispatcher owns pending, the intra-turn sig set, and the mutation
        // epoch, all fresh per turn.
        const eager = createEagerDispatcher({
            tools, cwd, sessionId, sessionRef, signal, opts,
            crossTurnCalls: _crossTurnCalls,
            getIterations: () => iterations,
            getNextIteration: () => nextIteration,
            repeatFailLimit: REPEAT_FAIL_LIMIT,
        });
        // Hard-cap final turn: forbid eager dispatch. Tools are still sent (to
        // hold the cache prefix) but tool_choice:'none' means Anthropic emits
        // no calls; a toolChoice-IGNORING provider could still stream calls,
        // and an attached onToolCall would eager-run read-only tools mid-stream
        // (real cost/UI/network side effects) whose results are then discarded
        // by the refusal-stub path. Leave it unset so nothing dispatches; opts
        // is reused across iterations but onToolCall is cleared to undefined
        // after send() below, so non-cap iterations are unaffected.
        opts.onToolCall = _capFinalToolsDisabled
            ? undefined
            : (call) => {
                try {
                    opts.onAssistantToolCallObserved?.(call, {
                        eagerStarted: false,
                    });
                } catch {}
                return eager.onToolCall(call);
            };
        const sendStartedAt = Date.now();
        const preSendMs = sendStartedAt - _iterT0;
        const toolResumeMs = _lastToolBatchEndedAt
            ? sendStartedAt - _lastToolBatchEndedAt
            : null;
        try { opts.onProviderSendStarted?.(); } catch {}
        const _sendResult = await runWithProviderRequestToolsScope(
            requestToolScope,
            () => sendWithRecovery({
                provider, messages: _sendMessages || messages, model, sendTools, tools: sendTools, opts,
                sessionId, sessionRef, nextIteration, contextOverflowRetryUsed,
                transportRetriesUsed: _transportRetriesUsed,
                imageStripUsed: _imageStripUsed, signal,
            }),
        );
        const _sendEndedAt = Date.now();
        if (_sendResult.action === 'retry') {
            // Keep opts.cacheBreakIntent: the failed send never consumed the
            // tag, and the reactive-compact retry that follows IS the tagged
            // transition — deleting it here made retry-side cache_break rows
            // log intentional_transition: null.
            contextOverflowRetryUsed = true;
            reactiveOverflowRetryPending = true;
            continue;
        }
        if (_sendResult.action === 'retry_transport') {
            _transportRetriesUsed += 1;
            continue;
        }
        if (_sendResult.action === 'retry_image_strip') {
            _transportRetriesUsed += 1;
            _imageStripUsed = true;
            if (Array.isArray(_sendResult.messages)) {
                messages.splice(0, messages.length, ..._sendResult.messages);
                _sendMessages = null;
            }
            continue;
        }
        response = _sendResult.response;
        opts.onToolCall = undefined;
        delete opts.cacheBreakIntent;
        contextOverflowRetryUsed = false;
        // A completed send ends the outage this budget was covering; the next
        // iteration is a fresh request and must get the full replay budget
        // again (mirrors contextOverflowRetryUsed above).
        _transportRetriesUsed = 0;
        _imageStripUsed = false;
        _sendMessages = null;
        // Capture opaque state for the next turn only when the provider
        // explicitly returned the field. Absence means "no update"; an own
        // property with null/undefined means "clear".
        if (response && Object.hasOwn(response, 'providerState')) {
            providerState = response.providerState;
            providerStateUpdated = true;
        }
        iterations = nextIteration;
        // Loop trace has two modes (both no-op on provider behavior):
        //   VERBOSE=1 → full row; pay the FULL messages+tools payload byte
        //               estimate (serializes the whole array).
        //   TIMING=1  → send-latency attribution only; skip the payload
        //               estimate so measuring send_ms does not itself add
        //               serialization cost during high-fanout bench runs.
        const _traceVerbose = process.env.MIXDOG_AGENT_TRACE_VERBOSE === '1';
        if (_traceVerbose || process.env.MIXDOG_AGENT_TRACE_TIMING === '1') {
            traceAgentLoop({
                sessionId,
                iteration: iterations,
                sendMs: Date.now() - sendStartedAt,
                preSendMs,
                toolResumeMs,
                messageCount: Array.isArray(messages) ? messages.length : 0,
                bodyBytesEst: _traceVerbose
                    ? estimateProviderPayloadBytes(messages, model, sendTools)
                    : undefined,
                agent: sessionAgent || null,
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
        // Keep a diagnostic for every provider-declared truncation. Eligible
        // no-tool text turns are recovered below rather than accepted as final.
        if (response?.truncated === true) {
            try {
                process.stderr.write(
                    `[loop] provider output truncated at max-output limit (sess=${sessionId || 'unknown'} `
                    + `iter=${iterations} stopReason=${response.stopReason ?? response.stop_reason ?? 'length'} `
                    + `contentLen=${typeof response.content === 'string' ? response.content.length : 0}); `
                    + `continuation recovery will be attempted when eligible.\n`,
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
                runWithProviderRequestToolsScope(requestToolScope, () => opts.onUsageDelta({
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
                    // Billing deltas include OAuth WS warmup. Context
                    // snapshots/baselines must describe only the main send.
                    contextInputTokens: response.usage.mainInputTokens ?? response.usage.inputTokens ?? 0,
                    contextOutputTokens: response.usage.mainOutputTokens ?? response.usage.outputTokens ?? 0,
                    contextPromptTokens: response.usage.mainPromptTokens ?? response.usage.promptTokens ?? 0,
                    contextCachedReadTokens: response.usage.mainCachedTokens ?? response.usage.cachedTokens ?? 0,
                    contextCacheWriteTokens: response.usage.mainCacheWriteTokens ?? response.usage.cacheWriteTokens ?? 0,
                    contextUsageAvailable: response.usage.mainUsageAvailable !== false,
                    sendTools,
                    ts: Date.now(),
                }));
            } catch { /* best-effort — never break the loop */ }
        }
        // No tool calls. For PUBLIC agents, the agent contract
        // (rules/agent/00-core.md) requires either a tool call or a final
        // handoff text (fragments).
        // A text-only turn without those tags violates the contract (e.g.
        // Opus 4.6 emits 'Now I'll polish…' preamble before its first tool
        // call) and used to leave the session idle until the idle sweep
        // collected it. Re-prompt the worker with a contract reminder on each
        // empty turn (hard iteration cap bounds total turns). Hidden roles are
        // exempt:
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
            //   - empty content + non-hidden role → contract nudge, continue.
            const hasContent = typeof response.content === 'string' && response.content.trim().length > 0;
            const isHidden = HIDDEN_AGENT_NAMES.has(sessionAgent);
            const stopReason = response.stopReason ?? response.stop_reason ?? null;
            const isIncompleteStop = stopReason && INCOMPLETE_STOP_REASONS.has(stopReason);
            const isOutputLimitStop = isOutputLimitStopReason(stopReason);
            if (hasContent && isOutputLimitStop) {
                _committedTextParts.push(response.content);
                if (_maxOutputRecoveryCount < MAX_OUTPUT_RECOVERY_LIMIT) {
                    // The partial assistant turn must be visible to the model so
                    // it can resume at the exact cutoff instead of reconstructing
                    // or repeating it. askSession persists this natural recovery
                    // chain; historyContent below prevents the aggregate returned
                    // to callers from being persisted a second time.
                    pushIntermediateAssistantResponse(response);
                    _maxOutputRecoveryCount += 1;
                    messages.push({
                        role: 'user',
                        content: 'Output token limit hit. Resume directly — no apology, no recap. Pick up exactly where the previous text stopped.',
                        meta: { source: 'max-output-recovery', attempt: _maxOutputRecoveryCount },
                    });
                    continue;
                }
                const terminalSegment = `${response.content}\n\n${MAX_OUTPUT_EXHAUSTED_NOTICE}`;
                response = {
                    ...response,
                    content: `${_committedTextParts.slice(0, -1).join('')}${terminalSegment}`,
                    historyContent: terminalSegment,
                    maxOutputRecoveryAttempts: _maxOutputRecoveryCount,
                };
                break;
            }
            if (stopReason === 'refusal') {
                if (_refusalRetryUsed) {
                    process.stderr.write(`[loop] safety-classifier refusal persisted after one context-changing retry (sess=${sessionId || 'unknown'}); ending loop as refusal termination.\n`);
                    break;
                }
                _refusalRetryUsed = true;
                // A provider may emit harmless narration before its safety
                // classifier terminates the turn. Preserve that partial turn
                // and its stop reason, but never mistake the non-empty text for
                // a successful completion.
                if (hasContent && pushIntermediateAssistantResponse(response)) {
                    if (!suppressMidTurnText) {
                        _committedTextParts.push(response.content);
                        try { opts.onAssistantText?.(response.content); } catch { /* best-effort */ }
                    }
                }
                messages.push({
                    role: 'user',
                    content: '[mixdog-runtime] The previous completion was refused by the provider safety classifier (stopReason=refusal). Do not repeat it. Complete your assigned output within policy by omitting or reframing disallowed content; if no compliant output is possible, briefly state the refusal.',
                    meta: { source: 'refusal-recovery', attempt: 1 },
                });
                continue;
            }
            // Structured provider continuation signal. The provider declared
            // the assistant turn unfinished, so this text is mid-turn output,
            // not a final answer: commit it EXACTLY ONCE to history/UI (single
            // pushIntermediateAssistantResponse → onAssistantMessageCommitted)
            // and immediately resume sampling in the same user turn. Output
            // limit stops keep the bounded max-output recovery ladder above and
            // refusals keep the bounded refusal retry; both own their own
            // continuation semantics. No lexical/progress-text heuristic.
            const continuationSignal = !isOutputLimitStop && stopReason !== 'refusal'
                ? providerContinuationSignal(response)
                : null;
            if (continuationSignal && _continuationsSinceToolBatch >= PROVIDER_CONTINUATION_NO_TOOL_LIMIT) {
                // Text-only continuation runaway: stop honoring the signal and
                // fall through to the terminal handling below, which accepts
                // the current content as the final answer (or ends the loop).
                process.stderr.write(`[loop] provider continuation cap ${PROVIDER_CONTINUATION_NO_TOOL_LIMIT} reached without tool calls (sess=${sessionId || 'unknown'}); accepting current text as final.\n`);
                try {
                    appendAgentTrace({
                        sessionId,
                        iteration: iterations,
                        kind: 'steer',
                        payload: { tag: 'provider_continuation_no_tool_cap', count: _continuationsSinceToolBatch },
                        agent: sessionAgent || null,
                    });
                } catch { /* best-effort */ }
            } else if (continuationSignal && pushIntermediateAssistantResponse(response)) {
                if (hasContent && !suppressMidTurnText) {
                    _committedTextParts.push(response.content);
                    try { opts.onAssistantText?.(response.content); } catch { /* best-effort */ }
                }
                _providerContinuationCount += 1;
                _continuationsSinceToolBatch += 1;
                _emptyNudgeStreak = 0;
                try {
                    appendAgentTrace({
                        sessionId,
                        iteration: iterations,
                        kind: 'provider_continuation',
                        payload: {
                            signal: continuationSignal,
                            stop_reason: stopReason,
                            count: _providerContinuationCount,
                            content_len: typeof response.content === 'string' ? response.content.length : 0,
                        },
                        agent: sessionAgent || null,
                    });
                } catch { /* best-effort */ }
                continue;
            }
            // A continuation signal with nothing committable (no text, no
            // reasoning) falls through to the bounded empty-turn handling
            // below: re-sending an unchanged transcript would livelock.
            if (!hasContent && !isHidden) {
                _emptyNudgeStreak += 1;
                if (_emptyNudgeStreak > EMPTY_NUDGE_MAX) {
                    // Livelock: identical nudges keep producing identical empty
                    // completions. Stop re-prompting; classifyTerminationReason
                    // tags this final empty response as 'empty' so the caller
                    // surfaces an explicit error instead of a silent finish.
                    process.stderr.write(`[loop] empty-turn nudge cap ${EMPTY_NUDGE_MAX} reached (sess=${sessionId || 'unknown'}); ending loop as empty termination.\n`);
                    break;
                }
                let nudgeMsg;
                if (isIncompleteStop) {
                    nudgeMsg = `[mixdog-runtime] Previous turn ended mid-synthesis (stopReason=${stopReason}) with empty content. Continue — emit your final handoff (fragments, file:line) with your synthesis so far, or call more tools to finish.`;
                } else {
                    nudgeMsg = `[mixdog-runtime] Your previous response was empty (no handoff text and no tool call) — attempt ${_emptyNudgeStreak}/${EMPTY_NUDGE_MAX}. Either emit your final handoff text now, or continue with tool calls. Do not return an empty turn.`;
                }
                messages.push({ role: 'user', content: nudgeMsg });
                continue;
            }
            // Pending-input rule: queued user input is
            // folded into needs_follow_up and evaluated BEFORE the stop hooks,
            // so real steering always wins over a synthetic continuation prompt.
            // Commit the terminal text first (beforeAppend), then resume.
            if (!_capFinalToolsDisabled && drainSteeringIntoMessages('terminal', {
                maxPriority: 'next',
                beforeAppend: () => {
                    if (pushIntermediateAssistantResponse(response) && hasContent && !suppressMidTurnText) {
                        _committedTextParts.push(response.content);
                    }
                },
            })) {
                _emptyNudgeStreak = 0;
                continue;
            }
            // This no-tool message ends the turn
            // unless a stop hook blocks it. The unresolved-tool-failure hook may
            // block exactly once — commit the assistant text, record the
            // structural continuation prompt, resume sampling. Skipped on the
            // hard-cap final turn (tool use is already forbidden) and for hidden
            // roles, whose own role rules define a text-only terminal contract.
            if (!_capFinalToolsDisabled && !isHidden) {
                const _hookPrompt = _toolFailureStopHook.takeContinuationPrompt();
                if (_hookPrompt) {
                    pushIntermediateAssistantResponse(response);
                    if (hasContent && !suppressMidTurnText) _committedTextParts.push(response.content);
                    messages.push({
                        role: 'user',
                        content: _hookPrompt,
                        meta: { source: STOP_HOOK_SOURCE, tool: _toolFailureStopHook.lastFailedTool || null },
                    });
                    try {
                        appendAgentTrace({
                            sessionId,
                            iteration: iterations,
                            kind: 'steer',
                            payload: { tag: 'tool_failure_stop_hook', tool: _toolFailureStopHook.lastFailedTool || null },
                            agent: sessionAgent || null,
                        });
                    } catch { /* best-effort */ }
                    continue;
                }
            }
            if (_committedTextParts.length > 0) {
                const terminalSegment = typeof response.content === 'string' ? response.content : '';
                response = {
                    ...response,
                    content: `${_committedTextParts.join('')}${terminalSegment}`,
                    historyContent: terminalSegment,
                    ...(_maxOutputRecoveryCount > 0
                        ? { maxOutputRecoveryAttempts: _maxOutputRecoveryCount }
                        : {}),
                };
            }
            break;
        }
        _emptyNudgeStreak = 0;
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
        const _assistantTurnMsg = attachAssistantTranscriptMetadata({
            role: 'assistant',
            createdAt: Date.now(),
            // Sub-agent tool-call turns carry only mid-turn preamble in
            // response.content (the real result rides the later final-answer
            // turn). Blank it so it never accumulates as input tokens.
            content: suppressMidTurnText ? '' : (response.content || ''),
            // deferBodies: mutation bodies (patch / old_string / ...) stay
            // verbatim through the send that answers this batch, then the
            // compactSettledToolCallBodies sweep below collapses them. This
            // keeps a model that patches twice in a row from ever seeing (and
            // copying) a compacted marker where its own last patch should be.
            toolCalls: compactToolCallsForHistory(calls, { deferBodies: true }),
            // MIXED Anthropic turn (native server tools + client tool_use):
            // the ordered `server_tool_use` / `*_tool_result` blocks exist ONLY
            // in this verbatim list and are order-bound (a result block is
            // valid only right after its call block), so they must ride the
            // tool-call history message too. toolCalls above stays authoritative
            // for execution/recovery/interruption; both Anthropic lowerers
            // prefer assistantBlocks verbatim (which already contains the
            // text/thinking/tool_use blocks), so nothing is emitted twice and
            // non-Anthropic providers simply ignore the field.
            ...(Array.isArray(response.assistantBlocks) && response.assistantBlocks.length
                ? { assistantBlocks: response.assistantBlocks }
                : {}),
            // Anthropic adaptive thinking: prior-turn thinking blocks must be
            // returned verbatim (signature intact; empty thinking allowed) and
            // are REQUIRED back before tool_use blocks on tool-continuation
            // turns. Store them so toAnthropicMessages can build assistantBlocks
            // = [...thinking, tool_use...]. Skipped when assistantBlocks is
            // present: those blocks already carry the thinking verbatim, and a
            // second copy would double-count in the context estimator.
            ...(Array.isArray(response.thinkingBlocks) && response.thinkingBlocks.length
                && !(Array.isArray(response.assistantBlocks) && response.assistantBlocks.length)
                ? { thinkingBlocks: response.thinkingBlocks }
                : {}),
            ...(Array.isArray(response.reasoningItems) && response.reasoningItems.length
                ? { reasoningItems: response.reasoningItems }
                : {}),
            ...(typeof response.reasoningContent === 'string' && response.reasoningContent
                ? { reasoningContent: response.reasoningContent }
                : {}),
            ...(response.providerMetadata && typeof response.providerMetadata === 'object'
                ? { providerMetadata: response.providerMetadata }
                : {}),
        }, opts);
        // Settle earlier deferred bodies before this turn's message lands:
        // every previous call already has its result row, so successful bodies
        // compact to markers while failed ones keep their full retry text.
        if (compactSettledToolCallBodies(messages) && !opts.cacheBreakIntent) {
            opts.cacheBreakIntent = 'deferred_body_compaction';
        }
        messages.push(_assistantTurnMsg);
        try { opts.onAssistantMessageCommitted?.(_assistantTurnMsg); } catch {}
        const _callsToExecute = calls;
        // Hard-cap final turn: tools are disabled but the model still emitted
        // tool calls. Do NOT execute them — push a refusal stub for each.
        if (_capFinalToolsDisabled) {
            for (const _c of calls) {
                pushToolResultMessage({
                    role: 'tool',
                    content: ITERATION_CAP_REFUSAL_STUB,
                    toolCallId: _c.id,
                    toolKind: 'error',
                });
            }
            if (sessionId) updateSessionStage(sessionId, 'connecting');
            continue;
        }
        try { opts.onToolPhaseStarted?.(); } catch {}
        const _toolsT0 = Date.now();
        ({ dedupStubTotal: _dedupStubTotal, editCount: _editCount } = await processToolBatch({
            calls: _callsToExecute, messages, tools, cwd, sessionId, sessionRef, signal, opts,
            iterations, assistantTurnMsg: _assistantTurnMsg,
            pending: eager.pending, epoch: eager.epoch, startEagerRun: eager.startEagerRun,
            crossTurnCalls: _crossTurnCalls, crossTurnCap: _CROSS_TURN_CAP,
            dedupStubTotal: _dedupStubTotal, editCount: _editCount,
            sessionAgent,
            pushToolResultMessage, throwIfAborted,
            repeatFailLimit: REPEAT_FAIL_LIMIT,
        }));
        // Settle the stop hook on the batch that actually executed.
        _toolFailureStopHook.endBatch(_callsToExecute);
        const _toolsEndedAt = Date.now();
        try {
            opts.onToolPhaseCompleted?.({
                iteration: nextIteration,
                calls: _callsToExecute.length,
                elapsedMs: _toolsEndedAt - _toolsT0,
            });
        } catch {}
        // Loop-phase timing (diagnostics): where non-model time goes per
        // iteration — presend (repair/compact/snapshot), send (provider
        // round-trip incl. streaming), tools (batch execution). Gated by the
        // same env as [turn-timing] so bench runs opt in via -AgentEnv.
        if (process.env.MIXDOG_TURN_TIMING === '1') {
            try {
                process.stderr.write(`[loop-timing] iter=${nextIteration} presend=${preSendMs}ms send=${_sendEndedAt - sendStartedAt}ms tools=${_toolsEndedAt - _toolsT0}ms calls=${_callsToExecute.length}\n`);
            } catch { /* diagnostics only */ }
        }
        _lastToolBatchEndedAt = _toolsEndedAt;
        _toolBatchJustCompleted = true;
        _continuationsSinceToolBatch = 0;
        // The UI sealed its streaming row at this tool boundary; earlier
        // committed parts must not re-prepend at terminal (duplicate rows).
        _committedTextParts.length = 0;
        _lastToolBatchHadSleep = _callsToExecute.some(isSleepLikeToolCall);
    }
    // Classify WHY the loop ended so agent-tool can promote an empty/abnormal
    // finish to an explicit Lead-facing error instead of a silent empty
    // "completed" (see classifyTerminationReason in ./loop/termination.mjs).
    const terminationReason = classifyTerminationReason(response, {
        terminatedByCap,
        sessionAgent,
    });
    return {
        ...response,
        usage: lastUsage || response.usage,
        lastTurnUsage: response.usage,
        lastSendTools,
        firstTurnUsage: firstTurnUsage || response.usage,
        iterations,
        toolCallsTotal,
        providerState,
        providerStateUpdated,
        terminationReason,
        maxLoopIterations,
        providerContinuations: _providerContinuationCount,
    };
}
