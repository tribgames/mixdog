// Pre-send auto-compact pass, extracted verbatim from agent-loop.mjs (was
// loop.mjs). Runs the proactive/reactive compaction decision + execution
// before each provider.send. Threaded via a state bag so the loop keeps its
// mutable counters (iterations reset on compaction, usage accumulation, the
// reactive-overflow flag, providerState invalidation). Behavior identical to
// the inline block it replaced.
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
    pruneToolOutputs,
    pruneToolOutputsUnanchored,
    semanticCompactMessages,
    effectiveBudget as compactEffectiveBudget,
    DEFAULT_COMPACT_TYPE,
} from './compact.mjs';
import { runRecallFastTrackCompact } from './loop/recall-fasttrack.mjs';
import { estimateMessagesTokensSafe } from './loop/compact-debug.mjs';
import { messagesArrayChanged } from './loop/tool-helpers.mjs';
import { normalizeUsage, addUsage } from './loop/usage.mjs';
import { agentContextOverflowError } from './loop/context-overflow.mjs';
import { traceAgentCompact, messagePrefixHash } from '../agent-trace.mjs';
import { bumpUsageMetricsEpoch } from './manager.mjs';

export async function runPreSendCompactPass(state) {
    const {
        provider, messages, model, tools, sessionRef, sessionId, cwd, opts, signal,
        loopUsageMetricsTurnId, loopUsageMetricsEpoch,
    } = state;
    let { iterations, lastUsage, firstTurnUsage, providerState, reactiveOverflowRetryPending } = state;
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
            // A pending reactive-overflow retry makes THIS compact pass the
            // recovery from a provider overflow refusal, not the proactive
            // pressure trigger. Tag the emitted events so telemetry can tell
            // them apart. Hoisted above the shouldCompact branch because the
            // PostCompact hook below fires on BOTH paths (fixes a
            // ReferenceError on the no-compact path).
            const compactTrigger = reactivePending ? 'reactive' : 'auto';
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
                try { await opts.onStageChange?.('compacting'); } catch { /* best-effort */ }
                const compactStartedAt = Date.now();
                // Clear the one-shot reactive-overflow flag now that this
                // compact pass is consuming it (compactTrigger already
                // captured it above).
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
                try { await opts.onStageChange?.('requesting'); } catch { /* best-effort */ }
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
    return { iterations, lastUsage, firstTurnUsage, providerState, reactiveOverflowRetryPending };
}
