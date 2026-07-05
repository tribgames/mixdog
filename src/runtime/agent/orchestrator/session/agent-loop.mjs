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
import { tryReadCached, setReadCached, invalidatePathForSession, markPostEdit, consumePostEditMark, clearReadDedupSession, extractTouchedPathsFromPatch, tryScopedToolCached, setScopedToolCached, clearScopedToolsForSession, clearScopedToolsForSessionPaths, invalidatePrefetchCache } from './read-dedup.mjs';
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
import { executeTool, _scopedCacheOutcomeForCall } from './loop/tool-exec.mjs';

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
import { classifyTerminationReason, INCOMPLETE_STOP_REASONS } from './loop/termination.mjs';
import { createSteeringLadder } from './loop/steering-ladder.mjs';
import { runPreSendCompactPass } from './pre-send-compact.mjs';
import { createEagerDispatcher } from './eager-dispatch.mjs';
import { sendWithRecovery } from './send-with-recovery.mjs';
import { processToolBatch } from './tool-batch.mjs';

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
export async function agentLoop(provider, messages, model, tools, onToolCall, cwd, sendOpts) {
    let iterations = 0;
    let toolCallsTotal = 0;
    let lastUsage;
    let firstTurnUsage;
    let response;
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
    // ---- Completion-first loop guards (worker runaway prevention) ----
    // Step 1 (escalation ladder) + the missed-parallelism / serial-rewording
    // steering hints live in the createSteeringLadder controller below; it owns
    // their cumulative counters and emits at most one hint per turn.
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
    // Completion-first steering ladder controller. Owns the (cumulative) level-1
    // fire count, the all-read-only / serial-single / same-file-grep streaks,
    // and the level-2 latch. Threaded via live getters so it reads the loop's
    // current `iterations` / `_editCount` on every call (no stale snapshots).
    const _steeringLadder = createSteeringLadder({
        sessionId,
        sessionAgent,
        tools,
        getIterations: () => iterations,
        getEditCount: () => _editCount,
        readOnlyRole: String(sessionRef?.permission || sessionRef?.toolPermission || '') === 'read',
        pushUserMessage: (msg) => messages.push(msg),
        pushSystemReminder: (text) => messages.push({ role: 'user', content: `<system-reminder>\n${text}\n</system-reminder>`, meta: 'hook' }),
    });
    // Tool execution must use the session cwd even when the caller omitted the
    // legacy positional cwd argument. Agent workers always carry their cwd on
    // sessionRef; falling through to pwd()/process.cwd() resolves relatives
    // against the host/plugin root instead of the worker workspace.
    cwd = cwd || sessionRef?.cwd || undefined;
    // Staged pre-cap warnings + one true hard stop. The ONLY count-based
    // forced termination is the hard cap at maxLoopIterations (default 200):
    // a genuine runaway guard. Before it, staged warnings fire at 50%/75%/90%
    // of the cap steering the model to converge — warnings only, nothing is
    // cut off early. Other runaway protection is behavior-based (steering
    // ladder hints, REPEAT_FAIL_LIMIT), never a lower iteration count.
    let _iterWarnStage = 0;
    const _iterWarnAt = [
        Math.floor(maxLoopIterations * 0.5),
        Math.floor(maxLoopIterations * 0.75),
        Math.floor(maxLoopIterations * 0.9),
    ];
    while (true) {
        throwIfAborted();
        if (iterations >= maxLoopIterations) {
            // Final-answer turn: instead of breaking mid-transcript (which
            // yields an empty final for locator-style agents that never got to
            // answer), give the model ONE tool-less text turn to wrap up, then
            // stop (empty sendTools + refusal stubs if tools are requested).
            if (_capFinalTurnUsed) {
                process.stderr.write(`[loop] hard iteration cap ${maxLoopIterations} reached (sess=${sessionId || 'unknown'}); stopping loop.\n`);
                terminatedByCap = true;
                // The granted final turn produced no text (model kept emitting
                // tool calls into refusal stubs, or thinking-only). Synthesize a
                // non-empty final so callers never see an empty response.
                if (response && !String(response.content || '').trim()) {
                    response.content = sessionAgent === 'explorer'
                        ? 'EXPLORATION_FAILED'
                        : '[iteration cap reached before final text]';
                    if (Array.isArray(response.toolCalls)) response.toolCalls = [];
                }
                break;
            }
            _capFinalTurnUsed = true;
            _capFinalToolsDisabled = true;
            messages.push({ role: 'user', content: '<system-reminder>\nIteration cap reached — tools disabled; answer with your best result from context.\n</system-reminder>', meta: 'hook' });
            process.stderr.write(`[loop] hard iteration cap ${maxLoopIterations} reached (sess=${sessionId || 'unknown'}); forcing final text turn.\n`);
        }
        if (_iterWarnStage < _iterWarnAt.length && iterations >= _iterWarnAt[_iterWarnStage]) {
            _iterWarnStage += 1;
            const warnAt = _iterWarnAt[_iterWarnStage - 1];
            const stageMsg = _iterWarnStage === 1
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
        // Drain queued steering/prompts BEFORE the
        // pre-send compact check. The compact decision must see the exact
        // message set that the next provider.send would receive, including
        // tool results plus any queued user input/notifications.
        drainSteeringIntoMessages('pre-send');
        ({
            iterations,
            lastUsage,
            firstTurnUsage,
            providerState,
            reactiveOverflowRetryPending,
        } = await runPreSendCompactPass({
            provider,
            messages,
            model,
            tools,
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
        }));
        const nextIteration = iterations + 1;
        opts.iteration = nextIteration;
        opts.providerState = providerState;
        if (forcedFirstTool && toolCallsTotal === 0) {
            opts.toolChoice = 'required';
        } else {
            delete opts.toolChoice;
        }
        // Hard-cap final turn: send NO tool definitions so the provider can
        // only emit text. Overrides the forced-first-tool path.
        const sendTools = _capFinalToolsDisabled
            ? []
            : (forcedFirstToolDef && toolCallsTotal === 0 ? [forcedFirstToolDef] : tools);
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
        opts.onToolCall = eager.onToolCall;
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
        const _sendResult = await sendWithRecovery({
            provider, messages, model, sendTools, tools, opts,
            sessionId, sessionRef, nextIteration, contextOverflowRetryUsed,
        });
        if (_sendResult.action === 'retry') {
            contextOverflowRetryUsed = true;
            reactiveOverflowRetryPending = true;
            continue;
        }
        response = _sendResult.response;
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
        // (rules/agent/00-core.md) requires either a tool call or a final
        // handoff text (fragments).
        // A text-only turn without those tags violates the contract (e.g.
        // Opus 4.6 emits 'Now I'll polish…' preamble before its first tool
        // call) and used to leave the session idle until the idle sweep
        // collected it. Re-prompt the worker with a contract reminder on each
        // empty turn (hard iteration cap bounds total turns). Hidden roles
        // (cycle1-agent / cycle2-agent / explorer /
        // scheduler-task / webhook-handler) are exempt:
        // their own role rules define a different output contract (pipe-
        // separated chunker output, structured pipe-format, etc.) and a
        // text-only terminal turn is the correct shape — nudging them
        // produces a contradictory user message that traps the model in a
        // tool-call-blocked vs contract-required oscillation.
        if (!response.toolCalls?.length) {
            // No tool calls. Decide between final-answer accept vs nudge.
            // Reviewer fix: a zero-tool turn (final-pre-send steering drain or
            // contract nudge `continue`) must not bridge the all-read-only
            // streak across non-tool turns — that would fire level-2 early on
            // a worker that paused to synthesize text mid-run.
            _steeringLadder.resetAllReadOnlyStreak();
            //   - has content + non-hidden role → valid final, break.
            //   - empty content + hidden role → contract allows text-only
            //     terminal turn, break.
            //   - empty content + non-hidden role → contract nudge, continue.
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
                    // Vary the nudge per attempt — a byte-identical repeat
                    // reinforces the empty-completion pattern it is trying to
                    // break (the request context stays effectively constant).
                    nudgeMsg = `[mixdog-runtime] Your previous response was empty (no handoff text and no tool call) — attempt ${_emptyNudgeStreak}/${EMPTY_NUDGE_MAX}. Either emit your final handoff text now, or continue with tool calls. Do not return an empty turn.`;
                }
                messages.push({ role: 'user', content: nudgeMsg });
                continue;
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
        const _assistantTurnMsg = {
            role: 'assistant',
            // Sub-agent tool-call turns carry only mid-turn preamble in
            // response.content (the real result rides the later final-answer
            // turn). Blank it so it never accumulates as input tokens.
            content: suppressMidTurnText ? '' : (response.content || ''),
            toolCalls: compactToolCallsForHistory(calls),
            // Anthropic adaptive thinking: prior-turn thinking blocks must be
            // returned verbatim (signature intact; empty thinking allowed) and
            // are REQUIRED back before tool_use blocks on tool-continuation
            // turns. Store them so toAnthropicMessages can build assistantBlocks
            // = [...thinking, tool_use...]. Other providers ignore this field.
            ...(Array.isArray(response.thinkingBlocks) && response.thinkingBlocks.length
                ? { thinkingBlocks: response.thinkingBlocks }
                : {}),
            ...(Array.isArray(response.reasoningItems) && response.reasoningItems.length
                ? { reasoningItems: response.reasoningItems }
                : {}),
            ...(typeof response.reasoningContent === 'string' && response.reasoningContent
                ? { reasoningContent: response.reasoningContent }
                : {}),
        };
        messages.push(_assistantTurnMsg);
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
        ({ dedupStubTotal: _dedupStubTotal, editCount: _editCount } = await processToolBatch({
            calls, messages, tools, cwd, sessionId, sessionRef, signal, opts,
            iterations, assistantTurnMsg: _assistantTurnMsg,
            pending: eager.pending, epoch: eager.epoch, startEagerRun: eager.startEagerRun,
            crossTurnCalls: _crossTurnCalls, crossTurnCap: _CROSS_TURN_CAP,
            dedupStubTotal: _dedupStubTotal, editCount: _editCount,
            sessionAgent, steeringLadder: _steeringLadder,
            pushToolResultMessage, throwIfAborted,
            repeatFailLimit: REPEAT_FAIL_LIMIT,
        }));
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
        firstTurnUsage: firstTurnUsage || response.usage,
        iterations,
        toolCallsTotal,
        providerState,
        terminationReason,
        maxLoopIterations,
    };
}
