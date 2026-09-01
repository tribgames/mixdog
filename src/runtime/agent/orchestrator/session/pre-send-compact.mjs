// Pre-send auto-compact pass, extracted verbatim from agent-loop.mjs (was
// loop.mjs). Runs the proactive/reactive compaction decision + execution
// before each provider.send. Threaded via a state bag so the loop keeps its
// mutable counters (iterations reset on compaction, usage accumulation, the
// reactive-overflow flag, providerState invalidation). Behavior identical to
// the inline block it replaced.
import {
    resolveWorkerCompactPolicy,
    compactionTelemetryPressureTokens,
    currentContextEstimateTokens,
    compactTargetBudget,
    shouldCompactForSession,
    rememberCompactTelemetry,
    recordContextUsageSnapshot,
    emitCompactEvent,
    resolveHandoffSummaryModel,
} from './loop/compact-policy.mjs';
import { runFreshContextCompact } from './loop/fresh-context.mjs';
import { estimateMessagesTokensSafe } from './loop/compact-debug.mjs';
import { messagesArrayChanged } from './loop/tool-helpers.mjs';
import { normalizeUsage, addUsage } from './loop/usage.mjs';
import { agentContextOverflowError } from './loop/context-overflow.mjs';
import { agentCompactFailedError } from './loop/context-overflow.mjs';
import { isContextOverflowError } from '../providers/retry-classifier.mjs';
import { traceAgentCompact, messagePrefixHash } from '../agent-trace.mjs';
import { invalidateProviderRequestToolsScope } from '../../../../session-runtime/provider-request-tools.mjs';
import { bumpUsageMetricsEpoch } from './manager.mjs';
import { resetReadStateAfterCompaction } from './read-dedup.mjs';
import {
    acknowledgePendingGoalReminder,
    markPendingGoalReminder,
    snapshotPendingGoalReminder,
} from '../../../../session-runtime/goal-reminder.mjs';

export async function runPreSendCompactPass(state) {
    const {
        provider, messages, model, requestTools, sessionRef, sessionId, cwd, opts, signal,
        loopUsageMetricsTurnId, loopUsageMetricsEpoch,
    } = state;
    let { iterations, lastUsage, firstTurnUsage, providerState, reactiveOverflowRetryPending } = state;
    let providerStateCleared = false;
    let compactChanged = false;
        const compactPolicy = resolveWorkerCompactPolicy(sessionRef, requestTools);
        if (compactPolicy?.auto) {
            // Snapshot pre-compact shape so compact_meta can record the actual
            // mutation (or no-op) for prefix-mutation forensics. Bytes are
            // a best-effort JSON.stringify length — close enough to the
            // payload we hand the provider for prefix-cache analysis.
            const beforeCount = messages.length;
            let messageTokensEst = estimateMessagesTokensSafe(messages);
            const reactivePending = reactiveOverflowRetryPending === true;
            let pressureTokens = compactionTelemetryPressureTokens(messageTokensEst, compactPolicy, {
                reactivePending,
                messages,
                sessionRef,
            });
            let shouldCompact = shouldCompactForSession(messageTokensEst, compactPolicy, {
                forceReactive: reactivePending,
                messages,
                sessionRef,
                pressureTokens,
            });
            // This is the exact canonical value used by the decision above.
            // Reactive overflow recovery floors it at the trigger so the gauge,
            // telemetry, and forced compact still describe the same event.
            const gaugeBeforeTokens = pressureTokens;
            // Gauge sync (user: 컴팩트될 때 컨텍스트 표기량이 달랐다). The host
            // refreshes its context readout on provider usage deltas and turn
            // end, so a tool batch that pushed the transcript over the trigger
            // fired compaction while the screen still showed headroom. Publish
            // the decision's OWN numerator here — before compaction mutates the
            // transcript — so the readout and the trigger describe one moment.
            if (typeof opts?.onContextPressure === 'function') {
                try {
                    opts.onContextPressure({
                        sessionId,
                        usedTokens: pressureTokens,
                        triggerTokens: compactPolicy.triggerTokens || compactPolicy.boundaryTokens || 0,
                        boundaryTokens: compactPolicy.boundaryTokens || 0,
                        willCompact: shouldCompact === true,
                    });
                } catch { /* best-effort display hook */ }
            }
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
                    beforeTokens: gaugeBeforeTokens,
                    afterTokens: gaugeBeforeTokens,
                    messageTokensEst,
                    pressureTokens,
                });
            } else {
                // Snapshot BEFORE mutating the live array below. Keeping this
                // inside the compact branch preserves the no-compact fast path
                // while ensuring compact_meta reports real savings and the true
                // input prefix rather than the replacement transcript.
                let beforeBytes = null;
                let beforePrefixHash = null;
                try { beforeBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8'); } catch { /* best-effort telemetry */ }
                try { beforePrefixHash = messagePrefixHash(messages); } catch { /* best-effort telemetry */ }
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
                    beforeTokens: gaugeBeforeTokens,
                    afterTokens: gaugeBeforeTokens,
                    messageTokensEst,
                    pressureTokens,
                    trigger: compactTrigger,
                });
                let compacted;
                let summaryChanged = false;
                let freshContextResult = null;
                let freshContextError = null;
                let inlineGoalReminder = null;
                try {
                    let compactInputMessages = messages;
                    try {
                        markPendingGoalReminder(sessionRef, 'compaction');
                        inlineGoalReminder = snapshotPendingGoalReminder(sessionRef);
                    } catch {
                        inlineGoalReminder = null;
                    }
                    {
                        try {
                            freshContextResult = await runFreshContextCompact({
                                sessionRef,
                                messages: compactInputMessages,
                                compactBudgetTokens,
                                compactPolicy,
                                sessionId,
                                signal,
                                provider,
                                model: resolveHandoffSummaryModel(sessionRef, { budgetTokens: compactBudgetTokens }) || model,
                                sendOpts: opts,
                                goalReminderText: inlineGoalReminder?.content || '',
                                activeTurn: true,
                            });
                            const freshMessages = Array.isArray(freshContextResult?.messages)
                                ? freshContextResult.messages
                                : null;
                            if (!freshMessages) throw new Error('fresh-context compact produced no messages');
                            compacted = freshMessages;
                            if (freshContextResult?.usage) {
                                lastUsage = addUsage(lastUsage, freshContextResult.usage);
                                if (!firstTurnUsage) firstTurnUsage = normalizeUsage(freshContextResult.usage);
                                if (sessionId && opts.onUsageDelta) {
                                    try {
                                        opts.onUsageDelta({
                                            sessionId,
                                            iterationIndex: iterations + 1,
                                            usageMetricsTurnId: loopUsageMetricsTurnId(),
                                            usageMetricsEpoch: loopUsageMetricsEpoch(),
                                            deltaInput: freshContextResult.usage.inputTokens || 0,
                                            deltaOutput: freshContextResult.usage.outputTokens || 0,
                                            deltaCachedRead: freshContextResult.usage.cachedTokens || 0,
                                            deltaCacheWrite: freshContextResult.usage.cacheWriteTokens || 0,
                                            source: 'fresh_context_compact',
                                            ts: Date.now(),
                                        });
                                    } catch { /* best-effort */ }
                                }
                            }
                        } catch (freshErr) {
                            freshContextError = freshErr;
                            try {
                                process.stderr.write(
                                    `[loop] fresh-context compact failed (sess=${sessionId || 'unknown'}): ` +
                                    `${freshErr?.message || freshErr}\n`,
                                );
                            } catch { /* best-effort */ }
                            throw freshErr;
                        }
                    }
                    summaryChanged = messagesArrayChanged(compactInputMessages, compacted);
                } catch (compactErr) {
                    if (inlineGoalReminder) {
                        try { acknowledgePendingGoalReminder(sessionRef, inlineGoalReminder.revision); }
                        catch { /* best-effort cleanup after failed compaction */ }
                    }
                    // A genuine cancellation/abort surfaced from the compact
                    // pipeline is NOT a context overflow. The fresh-context
                    // pipeline deliberately rethrows
                    // the original abort error unchanged so the session records a
                    // clean cancellation — and the manual/auto-clear runner
                    // (manager/compaction-runner.mjs) likewise never fabricates an
                    // AGENT_CONTEXT_OVERFLOW for an aborted compact. Mirror that
                    // here: preserve the real error (code/name/cause intact)
                    // instead of masking it as overflow. Detection is narrow on
                    // purpose — signal.aborted or a true AbortError — so the
                    // recall pipeline's SYNTHETIC "…aborted: memory … ; head
                    // preserved" failure (a real compact failure, message text
                    // aside) still escalates to overflow below.
                    if (signal?.aborted === true
                        || compactErr?.name === 'AbortError'
                        || compactErr?.code === 'ABORT_ERR'
                        || compactErr?.code === 'ABORT') {
                        try {
                            process.stderr.write(
                                `[loop] pre-send compact cancelled (sess=${sessionId || 'unknown'}): ` +
                                `${compactErr?.message || compactErr}\n`,
                            );
                        } catch { /* best-effort */ }
                        throw compactErr;
                    }
                    const compactFailMsg = compactErr && compactErr.message ? compactErr.message : String(compactErr);
                    const freshFailMsg = freshContextError?.message || null;
                    const compactFailCode = compactErr?.code
                        || (compactErr?.name === 'AgentContextOverflowError' ? 'AGENT_CONTEXT_OVERFLOW' : null)
                        || 'compact_failed';
                    rememberCompactTelemetry(sessionRef, compactPolicy, {
                        stage: 'overflow_failed',
                        beforeTokens: gaugeBeforeTokens,
                        afterTokens: gaugeBeforeTokens,
                        messageTokensEst,
                        pressureTokens,
                        trigger: compactTrigger,
                        freshContextError: freshFailMsg,
                        compactError: freshFailMsg || compactFailMsg,
                        durationMs: Date.now() - compactStartedAt,
                    });
                    traceAgentCompact({
                        sessionId,
                        iteration: iterations + 1,
                        stage: 'pre_send',
                        trigger: compactTrigger,
                        compact_changed: false,
                        input_prefix_hash: beforePrefixHash,
                        before_count: beforeCount,
                        after_count: messages.length,
                        before_bytes: beforeBytes,
                        after_bytes: beforeBytes,
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
                            freshContext: freshContextResult?.diagnostics || null,
                            freshContextError: freshFailMsg,
                        },
                    });
                    emitCompactEvent(opts, {
                        sessionId,
                        stage: 'pre_send',
                        trigger: compactTrigger,
                        status: 'failed',
                        beforeTokens: gaugeBeforeTokens,
                        afterTokens: gaugeBeforeTokens,
                        messageTokensEst,
                        beforeMessages: beforeCount,
                        afterMessages: messages.length,
                        pressureTokens,
                        triggerTokens: compactPolicy.triggerTokens,
                        boundaryTokens: compactPolicy.boundaryTokens,
                        targetBudgetTokens: compactBudgetTokens,
                        reserveTokens: compactPolicy.reserveTokens,
                        freshContext: true,
                        durationMs: Date.now() - compactStartedAt,
                        error: compactErr && compactErr.message ? compactErr.message : String(compactErr),
                    });
                    // Only a GENUINE provider context-overflow surfaced from the
                    // compact pipeline (e.g. the handoff-summary send itself
                    // overflowed the model window) deserves AGENT_CONTEXT_OVERFLOW.
                    // Every other compact-stage failure (dead memory runtime,
                    // Memory or handoff-summary failure) is a compact
                    // failure, not "latest turn cannot fit" — mislabeling it as
                    // overflow hides the real cause and misroutes downstream
                    // overflow handling. Surface an explicit compact-failed error.
                    const genuineOverflow = compactErr?.code === 'AGENT_CONTEXT_OVERFLOW'
                        || compactErr?.name === 'AgentContextOverflowError'
                        || isContextOverflowError(compactErr);
                    if (genuineOverflow) {
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
                    throw agentCompactFailedError({
                        stage: 'pre_send',
                        sessionId,
                        sessionRef,
                        model,
                    }, compactErr);
                }
                try { await opts.onStageChange?.('requesting'); } catch { /* best-effort */ }
                compactChanged = messagesArrayChanged(messages, compacted);
                if (compactChanged) {
                    messages.length = 0;
                    messages.push(...compacted);
                    if (inlineGoalReminder) {
                        try { acknowledgePendingGoalReminder(sessionRef, inlineGoalReminder.revision); }
                        catch { /* reminder is already present in the compacted transcript */ }
                    }
                    resetReadStateAfterCompaction(sessionId);
                    // This attempt's provider-tool scope was keyed to the old
                    // transcript shape. Invalidate it synchronously before any
                    // post-compact callback or subsequent async continuation.
                    invalidateProviderRequestToolsScope();
                    // The next provider send intentionally starts a new
                    // transcript shape. Keep this one-shot observability tag
                    // separate from an unexplained prefix mismatch.
                    opts.cacheBreakIntent = 'automatic_compaction';
                    // Compacting/pruning the transcript invalidates the
                    // server-side conversation anchor (xAI Responses / openai-oauth
                    // WS rely on previous_response_id which points at a
                    // now-mutated prefix). Drop providerState so the next send
                    // starts a fresh chain.
                    providerState = undefined;
                    providerStateCleared = true;
                    // Compaction shrank the transcript, so prior turns no
                    // longer pressure the window — reset the iteration counter
                    // so a steadily-compacting long task isn't killed by the
                    // cap, while a non-compacting tight loop still hits it.
                    iterations = 0;
                    // New loop epoch so persistIterationMetrics idempotency keys do not
                    // collide when iteration indices restart at 1 (incl. iter 1 → iter 1).
                    if (sessionRef) bumpUsageMetricsEpoch(sessionRef);
                }
                const afterMessageTokensEst = estimateMessagesTokensSafe(messages);
                // Same scale as gaugeBeforeTokens: compaction invalidated the
                // provider baseline, so the post-compact gauge number is the
                // calibrated transcript estimate plus the request reserve.
                const afterTokens = currentContextEstimateTokens(afterMessageTokensEst, compactPolicy);
                const compactDurationMs = Date.now() - compactStartedAt;
                rememberCompactTelemetry(sessionRef, compactPolicy, {
                    stage: 'pre_send',
                    beforeTokens: gaugeBeforeTokens,
                    afterTokens,
                    messageTokensEst,
                    pressureTokens,
                    compactChanged: compactChanged || summaryChanged,
                    freshContext: freshContextResult?.freshContext === true,
                    freshContextError: freshContextError?.message || null,
                    handoffSource: freshContextResult?.handoffSource || null,
                    compactError: null,
                    durationMs: compactDurationMs,
                });
                if (compactChanged || summaryChanged) {
                    recordContextUsageSnapshot(sessionRef, compactPolicy, {
                        messages,
                        usedTokens: afterTokens,
                        messageTokensEst: afterMessageTokensEst,
                        source: 'post_compact',
                    });
                }
                let afterBytes = null;
                try { afterBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8'); } catch { afterBytes = null; }
                traceAgentCompact({
                    sessionId,
                    iteration: iterations + 1,
                    stage: 'pre_send',
                    trigger: compactTrigger,
                    compact_changed: compactChanged || summaryChanged,
                    input_prefix_hash: beforePrefixHash,
                    before_count: beforeCount,
                    after_count: messages.length,
                    before_bytes: beforeBytes,
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
                        freshContext: freshContextResult?.diagnostics || null,
                    },
                });
                emitCompactEvent(opts, {
                    sessionId,
                    stage: 'pre_send',
                    trigger: compactTrigger,
                    status: compactChanged || summaryChanged ? 'compacted' : 'no_change',
                    beforeTokens: gaugeBeforeTokens,
                    afterTokens,
                    beforeMessages: beforeCount,
                    afterMessages: messages.length,
                    pressureTokens,
                    triggerTokens: compactPolicy.triggerTokens,
                    boundaryTokens: compactPolicy.boundaryTokens,
                    targetBudgetTokens: compactBudgetTokens,
                    reserveTokens: compactPolicy.reserveTokens,
                    changed: compactChanged || summaryChanged,
                    freshContext: freshContextResult?.freshContext === true,
                    handoffSource: freshContextResult?.handoffSource || null,
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
    return {
        iterations,
        lastUsage,
        firstTurnUsage,
        providerState,
        providerStateCleared,
        reactiveOverflowRetryPending,
        compactChanged,
    };
}
