// manager/ask-session.mjs
// The core ask pipeline extracted verbatim from manager.mjs: the per-session
// mutex-guarded turn loop (askSession) plus the abort-aware call wrapper
// (_api_call_with_interrupt). Behavior-preserving move — every runtime
// helper it used in manager.mjs is now imported from its split module.
import { createHash } from 'crypto';
import { getProvider } from '../../providers/registry.mjs';
import { normalizeCompactType, DEFAULT_COMPACT_TYPE } from '../compact.mjs';
import { loadSession, saveSessionAsync } from '../store.mjs';
import { createAbortController } from '../../../../shared/abort-controller.mjs';
import { logLlmCall } from '../../../../shared/llm/usage-log.mjs';
import { appendAgentTrace } from '../../agent-trace.mjs';
import { recordStandaloneStatusTelemetry } from './status-telemetry.mjs';
import { normalizeStaleCompactingStage } from './compaction-runner.mjs';
import { resolveSessionContextMeta, positiveContextWindow } from './context-meta.mjs';
import {
    promptContentText,
    hasModelVisiblePromptContent,
    promptContentBytes,
    prefixUserTurnContent,
    prefixSessionStartContent,
    buildCurrentTimeBlock,
    buildSessionStartBlock,
    hasUserConversationMessage,
} from './prompt-utils.mjs';
import { _mergePendingMessageEntries, drainPendingMessages } from './pending-messages.mjs';
import { persistIterationMetrics, applyAskTerminalUsageTotals } from './usage-metrics.mjs';
import {
    updateSessionStage,
    linkParentSignalToSession,
    markSessionAskStart,
    markSessionStreamDelta,
    markSessionDone,
    markSessionEmptyFinal,
    markSessionError,
    markSessionCancelled,
    _touchRuntime,
    _unlinkParentAbortListener,
    _getRuntimeEntry,
} from './runtime-liveness.mjs';
import { SessionClosedError } from './session-errors.mjs';
import { acquireSessionLock } from './session-lock.mjs';
import { _tryBridgeExplicitPrefetch } from './prefetch-bridge.mjs';
import {
    filterModelVisibleSessionMessages,
    persistCompactedOutgoingAfterAskFailure,
} from './message-sanitize.mjs';
import { createTurnInterruptionTracker } from './turn-interruption.mjs';
import { _getAgentLoop } from './runtime-loaders.mjs';
import { getAgentRuntimeSync } from './agent-runtime-singleton.mjs';
import { recordProviderContextBaseline } from '../loop/compact-policy.mjs';

/**
 * Wrap an async call so that if the session's controller aborts mid-flight,
 * the wrapper settles with a SessionClosedError even if the underlying promise
 * hasn't returned yet. The original promise is kept alive with a detached
 * `.catch()` to prevent unhandled-rejection warnings once it eventually
 * settles. Callers still must check generation/closed after await returns
 * to handle providers that ignore the AbortSignal entirely.
 */
export async function _api_call_with_interrupt(sessionId, fn) {
    const entry = _touchRuntime(sessionId);
    if (!entry.controller) entry.controller = createAbortController();
    const signal = entry.controller.signal;
    const closedFromAbort = (phase) => {
        const reason = signal.reason;
        if (reason instanceof SessionClosedError) return reason;
        const detail = reason instanceof Error
            ? reason.message
            : (reason !== undefined && reason !== null && reason !== '' ? String(reason) : '');
        return new SessionClosedError(sessionId, detail ? `${phase}: ${detail}` : phase);
    };
    if (signal.aborted) throw closedFromAbort('aborted before call');
    const underlying = fn(signal);
    underlying.catch(() => {}); // prevent unhandled rejection if we race ahead
    let onAbort = null;
    const aborted = new Promise((_, reject) => {
        onAbort = () => reject(closedFromAbort('aborted during call'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([underlying, aborted]);
    } finally {
        // If the underlying promise settled first, the abort listener is
        // still attached. Remove it to avoid accumulating listeners across
        // many asks on the same session.
        if (onAbort && !signal.aborted) {
            try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
        }
    }
}

export async function askSession(sessionId, prompt, context, onToolCall, cwdOverride, explicitPrefetch, askOpts = {}) {
    const _askStartedAt = Date.now();
    const _promptSrc = 'prompt';
    const _prefetchFiles = (explicitPrefetch?.files?.length) || 0;
    const _prefetchCallers = (explicitPrefetch?.callers?.length) || 0;
    const _prefetchRefs = (explicitPrefetch?.references?.length) || 0;
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] t0-ask-start sessionHash=${createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 8)} role=? iteration=0 promptSrc=${_promptSrc} prefetchFiles=${_prefetchFiles} callers=${_prefetchCallers} references=${_prefetchRefs}\n`);
    }
    const unlock = await acquireSessionLock(sessionId);
    const _lockWaitedMs = Date.now() - _askStartedAt;
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] lock-acquired waitedMs=${_lockWaitedMs}\n`);
    }
    // The mutex is held for the WHOLE askSession call, including any follow-up
    // turns drained from the pending-message queue below — the single outer
    // try/finally releases it exactly once. _result holds the last turn's
    // return value (the queued tail turns supersede the original prompt's
    // result, mirroring how a live chat returns the latest turn).
    let _result;
    // Local FIFO of follow-up prompts drained from the pending-message queue
    // after each turn — keeps queued `agent type=send` messages in order.
    const _pendingTail = [];
    // Hoisted so the outer finally (which runs once after the whole turn loop)
    // can compare against the last turn's generation.
    let askGeneration = 0;
    try {
      // Turn loop (pendingMessages pattern): run the current prompt, then drain
      // any `agent type=send` messages that were queued while this turn was in
      // flight and run them — in order — as the next user turn(s). Because the
      // queued send always lands AFTER the in-flight prompt here, ordering is
      // preserved and the spawn/connecting startup race disappears.
      for (;;) {
        let _pwstTurnDrained = null;
        // After the first turn, the next prompt comes from the drained queue.
        // (On the first iteration _pendingTail is empty and `prompt` is the
        // caller's original message.)
        if (_pendingTail.length > 0) {
            prompt = _pendingTail.shift();
            // Queued follow-ups are plain user turns — no caller context /
            // prefetch is re-applied (those belonged to the original ask).
            context = null;
            explicitPrefetch = null;
        } else if (!hasModelVisiblePromptContent(prompt)) {
            // Idle resume: TUI kicks an empty ask() after execution completions
            // mirror model-visible bodies into session pending. Drain that queue
            // here so we never synthesize an empty user turn for the model.
            const _preDrained = drainPendingMessages(sessionId);
            if (_preDrained.length > 0) {
                const _mergedPre = _mergePendingMessageEntries(_preDrained);
                if (_mergedPre?.content) {
                    prompt = _mergedPre.content;
                    context = null;
                    explicitPrefetch = null;
                }
            }
        }
        if (!hasModelVisiblePromptContent(prompt)) {
            _unlinkParentAbortListener(_getRuntimeEntry(sessionId));
            return _result;
        }
        // ── Synchronous pre-await setup (must happen before any await so
        //    closeSession() can't interleave between load and registration) ──
        const preSession = loadSession(sessionId);
        if (!preSession) {
            throw new Error(`Session "${sessionId}" not found`);
        }
        if (preSession.closed === true) {
            throw new SessionClosedError(sessionId, 'session already closed');
        }
        // A prior crash/partial-save during compaction may have pinned
        // compaction.lastStage='compacting'. This ask is starting fresh, so
        // recover the stale transient stage before the loop's pre-send compact
        // path runs (it will overwrite lastStage with real telemetry).
        normalizeStaleCompactingStage(preSession);
        askGeneration = typeof preSession.generation === 'number' ? preSession.generation : 0;
        const runtime = _touchRuntime(sessionId);
        // Preserve any parent-abort link agent-dispatch established BEFORE we
        // swap in a fresh controller: replacing runtime.controller drops the
        // abort state, so an already/early-aborted parent signal (user ESC /
        // owner abort landing during setup) would be lost and provider
        // computation would run detached. Capture the linked signal, install the
        // fresh controller, then re-cascade it — aborting the new controller
        // immediately when the parent already fired, or re-arming the listener.
        const _linkedParentSignal = runtime.parentAbortLink?.signal;
        // Fresh controller per ask — the previous ask's controller may have aborted.
        runtime.controller = createAbortController();
        runtime.generation = askGeneration;
        runtime.closed = false;
        runtime.session = preSession;
        if (_linkedParentSignal instanceof AbortSignal) {
            linkParentSignalToSession(sessionId, _linkedParentSignal);
        }
        markSessionAskStart(sessionId);
        // Preprocessing is inside try so provider-not-available / trim failures
        // fall into the catch and mark the session as errored rather than
        // leaving stage='connecting' forever.
        let activeSession = preSession;
        let cancelledUserTurnContent = '';
        let _turnOutgoing = null;
        const _turnInterruption = createTurnInterruptionTracker();
        const _sessionStartMetaInjectedBeforeTurn = preSession.sessionStartMetaInjected === true;
        try {
            const session = activeSession;
            const provider = getProvider(session.provider);
            // Register the live session object into runtime so closeSession()
            // can read allBashSessionIds that loop.mjs appends mid-turn.
            runtime.session = session;
            if (!provider)
                throw new Error(`Provider "${session.provider}" not available`);
            const contextMeta = resolveSessionContextMeta(provider, session.model, session);
            session.contextWindow = contextMeta.contextWindow;
            session.rawContextWindow = contextMeta.rawContextWindow;
            session.effectiveContextWindowPercent = contextMeta.effectiveContextWindowPercent;
            session.autoCompactTokenLimit = contextMeta.autoCompactTokenLimit;
            session.compactBoundaryTokens = contextMeta.compactBoundaryTokens;
            session.compaction = {
                ...(session.compaction || {}),
                auto: session.compaction?.auto !== false,
                semantic: session.compaction?.semantic ?? 'auto',
                type: normalizeCompactType(session.compaction?.type ?? session.compaction?.compactType ?? session.compaction?.compact_type, DEFAULT_COMPACT_TYPE),
                compactType: normalizeCompactType(session.compaction?.type ?? session.compaction?.compactType ?? session.compaction?.compact_type, DEFAULT_COMPACT_TYPE),
                boundaryTokens: contextMeta.compactBoundaryTokens,
                bufferTokens: positiveContextWindow(session.compaction?.bufferTokens ?? session.compaction?.buffer) || session.compaction?.bufferTokens || null,
                keepTokens: positiveContextWindow(session.compaction?.keepTokens ?? session.compaction?.keep?.tokens) || session.compaction?.keepTokens || null,
                contextWindow: contextMeta.contextWindow,
                rawContextWindow: contextMeta.rawContextWindow,
                effectiveContextWindowPercent: contextMeta.effectiveContextWindowPercent,
                autoCompactTokenLimit: contextMeta.autoCompactTokenLimit,
            };
            // Cap caller-supplied / prefetched context so an oversized
            // payload can't blow the session token budget before the
            // first model call. 32 KB ~ 8k tokens at the 4 B/tok
            // working average; longer is silently truncated with a
            // visible marker so the model still sees the prefix and
            // a hint about the cut.
            const _CTX_CHAR_CAP = 32 * 1024;
            const _capCtx = (text) => {
                if (typeof text !== 'string') return '';
                if (text.length <= _CTX_CHAR_CAP) return text;
                return `${text.slice(0, _CTX_CHAR_CAP)}\n\n... [context truncated; original ${text.length} chars]`;
            };
            // Inline context + prefetch INTO the prompt as a single user turn,
            // marked with explicit section headers. The previous design pushed
            // context as separate user messages with pre-injected assistant
            // "Noted." acks; that conversational pattern taught some models a
            // low-effort rhythm and they responded with "Noted." / empty tags
            // even to the real task. Single-turn structure with a labelled
            // `# Task` block forces the model to treat the brief as the work
            // unit, not as another piece of context to ack.
            const explicitPrefetchResult = await _tryBridgeExplicitPrefetch(session, explicitPrefetch);
            let _contextBlock = '';
            if (context) {
                _contextBlock += `# Additional context\n${_capCtx(context)}\n\n`;
            }
            if (explicitPrefetchResult) {
                _contextBlock += `# Prefetch\n${_capCtx(explicitPrefetchResult)}\n\n`;
            }
            const historyMessages = filterModelVisibleSessionMessages(session.messages);
            const beforeCount = historyMessages.length + 1;
            const promptTextForMetrics = promptContentText(prompt);
            // Soft warning only; real size management (compaction primary,
            // byte-budget trim as safety net) lives in agentLoop. Selecting a
            // 25% pre-trim here would starve compaction's 50% threshold.
            const softBudget = Math.floor(session.contextWindow * 0.25);
            const promptTokenEstimate = promptTextForMetrics.length * 0.5; // conservative for CJK
            if (promptTokenEstimate > softBudget * 0.7) {
                process.stderr.write(`[session] Warning: prompt is very large (est. ${Math.round(promptTokenEstimate)} tokens vs ${softBudget} soft budget)\n`);
            }
            const effectiveCwd = cwdOverride || session.cwd;
            const shouldInjectSessionStart = session.sessionStartMetaInjected !== true
                && !hasUserConversationMessage(historyMessages);
            const _sessionStartBlock = shouldInjectSessionStart
                ? buildSessionStartBlock(session, effectiveCwd)
                : '';
            const _currentTimeBlock = buildCurrentTimeBlock(prompt);
            const _turnReminderBlock = _currentTimeBlock
                ? `<system-reminder>\n# Current Time\n${_currentTimeBlock}\n</system-reminder>`
                : '';
            const _turnPrefixBlock = [_sessionStartBlock, _turnReminderBlock].filter(Boolean).join('\n\n');
            const _baseUserTurnContent = prefixUserTurnContent(prompt, _contextBlock);
            const _userTurnContent = prefixSessionStartContent(_baseUserTurnContent, _turnPrefixBlock);
            if (shouldInjectSessionStart && _sessionStartBlock) {
                session.sessionStartMetaInjected = true;
            }
            cancelledUserTurnContent = _userTurnContent;
            const outgoing = [...historyMessages, { role: 'user', content: _userTurnContent }];
            _turnOutgoing = outgoing;
            // Expose the in-flight working transcript so contextStatus() can
            // estimate the LIVE context footprint mid-turn. agentLoop mutates
            // `outgoing` in place (user turn + tool calls/results + compaction),
            // so the statusline context gauge climbs as the turn accumulates
            // tool output instead of freezing at the pre-turn snapshot. Cleared
            // on turn commit (below) and in the ask finally.
            //
            // Also commit the user turn to the live session BEFORE the provider
            // call. Previously the prompt only reached session.messages after
            // agentLoop returned. If a worker/lead session was closed or aborted
            // before first response, closeSession() wrote a tombstone from the
            // still-system-only session and the handoff brief vanished forever
            // (agent row showed messages=2). Pre-committing makes cancellation,
            // close, and post-mortem files retain the exact user task; completion
            // below overwrites this provisional transcript with the fully mutated
            // outgoing history and appends the assistant result, so no duplicate
            // user turn is introduced.
            session.messages = filterModelVisibleSessionMessages(outgoing);
            session.liveTurnMessages = outgoing;
            saveSessionAsync(session, { expectedGeneration: askGeneration }).catch((err) => {
                try { process.stderr.write(`[session] preflight user-turn save failed: ${err?.message || err}\n`); } catch {}
            });
            // Per-turn injected-context trace row (complements kind:"usage").
            // Cheap byte-length accounting — no hashing, no payload bodies.
            // Honors the same MIXDOG_AGENT_TRACE_DISABLE gate as usage rows;
            // appendAgentTrace is a no-op when that env is set.
            try {
                const _ctxBytes = Buffer.byteLength(context || '', 'utf8');
                const _prefetchBytes = Buffer.byteLength(explicitPrefetchResult || '', 'utf8');
                const _promptBytes = promptContentBytes(prompt);
                const _userTurnBytes = promptContentBytes(_userTurnContent);
                const _messagesBytes = Buffer.byteLength(JSON.stringify(historyMessages || []), 'utf8');
                const _totalBytes = _userTurnBytes + _messagesBytes;
                appendAgentTrace({
                    kind: 'context',
                    sessionId,
                    model: session.model,
                    provider: session.provider,
                    totalBytes: _totalBytes,
                    breakdown: {
                        contextBytes: _ctxBytes,
                        prefetchBytes: _prefetchBytes,
                        promptBytes: _promptBytes,
                        userTurnBytes: _userTurnBytes,
                        messagesBytes: _messagesBytes,
                        messagesCount: historyMessages.length,
                    },
                });
            } catch { /* trace must never break the ask path */ }
            const agentLoop = await _getAgentLoop();
            const _trackTextDelta = (chunk) => {
                _turnInterruption.recordTextDelta(chunk);
                if (typeof askOpts?.onTextDelta === 'function') askOpts.onTextDelta(chunk);
            };
            const _trackReasoningDelta = (chunk) => {
                _turnInterruption.recordReasoningDelta(chunk);
                if (typeof askOpts?.onReasoningDelta === 'function') askOpts.onReasoningDelta(chunk);
            };
            const _trackAssistantText = (text) => {
                _turnInterruption.recordAssistantText(text);
                if (typeof askOpts?.onAssistantText === 'function') askOpts.onAssistantText(text);
            };
            const _trackedOnToolCall = async (iteration, calls) => {
                _turnInterruption.recordToolCalls(calls);
                if (typeof onToolCall === 'function') return await onToolCall(iteration, calls);
                return undefined;
            };
            const _trackToolResult = (message) => {
                _turnInterruption.recordToolResult(message);
                if (typeof askOpts?.onToolResult === 'function') askOpts.onToolResult(message);
            };
            const priorToolApprovalHook = session.toolApprovalHook;
            if (typeof askOpts?.onToolApproval === 'function') {
                session.toolApprovalHook = askOpts.onToolApproval;
            }
            let result;
            try {
            result = await _api_call_with_interrupt(sessionId, (signal) =>
                agentLoop(provider, outgoing, session.model, session.tools, _trackedOnToolCall, effectiveCwd, {
                    effort: session.effort || null,
                    fast: session.fast === true,
                    sessionId,
                    onTextDelta: _trackTextDelta,
                    onReasoningDelta: _trackReasoningDelta,
                    onAssistantText: _trackAssistantText,
                    onAssistantMessageCommitted: () => _turnInterruption.markAssistantMessageCommitted(),
                    onAssistantToolCallObserved: (call, detail) => _turnInterruption.recordToolCalls([call], detail),
                    onProviderSendStarted: () => _turnInterruption.markProviderSendStarted(),
                    onToolPhaseStarted: () => _turnInterruption.markToolPhaseStarted(),
                    onUsageDelta: (d) => {
                        persistIterationMetrics(d).catch(() => {});
                        // provider_send usage arrives before agentLoop appends
                        // the assistant response. Preserve the full actual
                        // input/cache/output count and mark this request
                        // boundary; compact pressure will skip that first
                        // assistant representation and estimate only later
                        // tool results/steering.
                        if (d?.source === 'provider_send') {
                            recordProviderContextBaseline(session, outgoing, {
                                mainUsageAvailable: d.contextUsageAvailable,
                                inputTokens: d.contextInputTokens ?? d.deltaInput,
                                outputTokens: d.contextOutputTokens ?? d.deltaOutput,
                                promptTokens: d.contextPromptTokens ?? d.deltaPrompt,
                                cachedTokens: d.contextCachedReadTokens ?? d.deltaCachedRead,
                                cacheWriteTokens: d.contextCacheWriteTokens ?? d.deltaCacheWrite,
                            }, { boundary: 'request', sendTools: d.sendTools });
                        }
                        try { askOpts?.onUsageDelta?.(d); } catch {}
                    },
                    onToolResult: _trackToolResult,
                    onToolApproval: typeof askOpts?.onToolApproval === 'function' ? askOpts.onToolApproval : undefined,
                    onCompactEvent: typeof askOpts?.onCompactEvent === 'function' ? askOpts.onCompactEvent : undefined,
                    // Claude Code parity: mid-chain queued prompt/notification
                    // drain is owned by agentLoop at provider-continuation
                    // boundaries (after a tool batch, before the next send).
                    // The post-loop _pendingTail drain below still handles
                    // items that arrive after the model would otherwise stop.
                    drainSteering: (sid, drainOptions = {}) => {
                        const out = [];
                        if (typeof askOpts?.drainSteering === 'function') {
                            try {
                                const drained = askOpts.drainSteering(sid || sessionId, drainOptions);
                                if (Array.isArray(drained)) out.push(...drained);
                            } catch { /* best-effort steering drain */ }
                        }
                        // Do NOT drain manager/pending-messages here: those
                        // entries have no mode/priority/slash metadata, so
                        // draining them mid-chain would bypass Claude Code's
                        // queued_command filters. They are consumed by the
                        // post-loop _pendingTail drain below.
                        return out;
                    },
                    onSteerMessage: typeof askOpts?.onSteerMessage === 'function' ? askOpts.onSteerMessage : undefined,
                    notifyFn: typeof askOpts?.notifyFn === 'function' ? askOpts.notifyFn : undefined,
                    promptCacheKey: session.promptCacheKey || sessionId,
                    // Provider-scoped cache key (mixdog-codex, mixdog-claude…).
                    // Distinct from sessionId — providers that pool sockets
                    // per-session (openai-oauth WS) use sessionId as the
                    // pool bucket and providerCacheKey as the server-side
                    // prompt-cache shard so parallel callers don't collide
                    // on a mid-turn socket while still sharing prefix cache.
                    providerCacheKey: session.promptCacheKey || null,
                    signal,
                    providerState: session.providerState ?? undefined,
                    session,
                    // Agent Runtime cache settings — merged last so session overrides
                    // don't get overridden by defaults. When session has no profile,
                    // providerCacheOpts is null and this spread is a no-op.
                    ...(session.providerCacheOpts || {}),
                    onStageChange: (stage, detail) => {
                        updateSessionStage(sessionId, stage);
                        try { askOpts?.onStageChange?.(stage, detail); } catch {}
                    },
                    onStreamDelta: (kind = 'semantic') => {
                        markSessionStreamDelta(sessionId, kind).catch(() => {});
                        // Raw transport is an internal health signal, not model
                        // progress. Preserve the public callback's historical
                        // semantic-only contract.
                        if (kind !== 'transport') {
                            try { askOpts?.onStreamDelta?.(kind); } catch {}
                        }
                    },
                }),
            );
            } finally {
                if (priorToolApprovalHook === undefined) {
                    delete session.toolApprovalHook;
                } else {
                    session.toolApprovalHook = priorToolApprovalHook;
                }
            }
            // Post-loop validation: if closeSession() landed while we were awaiting,
            // drop the save so the tombstone on disk isn't overwritten.
            const currentRuntime = _getRuntimeEntry(sessionId);
            if (currentRuntime?.closed || currentRuntime?.generation !== askGeneration) {
                const reason = currentRuntime?.closedReason;
                throw new SessionClosedError(sessionId, `closed during call (reason=${reason || 'unknown'})`, reason || null);
            }
            // Update and save. outgoing is mutated in place by agentLoop
            // (compaction + safety trim), so its length reflects post-loop state.
            const messagesDropped = Math.max(0, beforeCount - outgoing.length);
            session.messages = filterModelVisibleSessionMessages(outgoing);
            // Turn committed into session.messages; drop the live-turn alias so
            // contextStatus() reverts to the authoritative committed transcript.
            session.liveTurnMessages = null;
            if (result.content || result.reasoningContent) {
                // Max-output recovery returns the complete concatenated text to
                // callers/TUI, while outgoing already contains prior partial
                // assistant turns and their continuation prompts. Persist only
                // the terminal segment here so model history contains every byte
                // exactly once.
                const persistedAssistantContent = typeof result.historyContent === 'string'
                    ? result.historyContent
                    : (result.content || '');
                session.messages.push({
                    role: 'assistant',
                    // Keep content as-is in memory (model-visible). Image bytes,
                    // if any, are swapped for a placeholder only at disk write
                    // time inside the session store (store.mjs _sessionForDisk).
                    content: persistedAssistantContent,
                    ...(typeof result.reasoningContent === 'string' && result.reasoningContent
                        ? { reasoningContent: result.reasoningContent }
                        : {}),
                    ...(result.providerMetadata && typeof result.providerMetadata === 'object'
                        ? { providerMetadata: result.providerMetadata }
                        : {}),
                });
            } else {
                // Empty terminal turn: still persist a forensic record so
                // post-mortem inspection can distinguish "work landed but
                // synthesis missing" from "session never ran". Stop reason,
                // usage, iterations, and tool-call totals survive even when
                // the assistant produced no content/reasoning.
                const _emptyStop = result?.stopReason ?? result?.stop_reason ?? null;
                const _emptyUsage = result?.usage ? {
                    inputTokens: result.usage.inputTokens || 0,
                    outputTokens: result.usage.outputTokens || 0,
                    cachedTokens: result.usage.cachedTokens || 0,
                    cacheWriteTokens: result.usage.cacheWriteTokens || 0,
                } : null;
                // Provider content-block classification — distinguishes a
                // thinking-only stall (model emitted reasoning blocks but no
                // text/tool_use) from a true silent empty turn. Anthropic
                // providers (anthropic.mjs, anthropic-oauth.mjs) set these
                // fields on the result; other providers may omit them.
                const _emptyHasThinking = typeof result?.hasThinkingContent === 'boolean'
                    ? result.hasThinkingContent
                    : null;
                const _emptyBlockTypes = Array.isArray(result?.contentBlockTypes)
                    ? result.contentBlockTypes.slice()
                    : null;
                session.messages.push({
                    role: 'assistant',
                    content: '',
                    emptyFinal: true,
                    stopReason: _emptyStop,
                    iterations: result?.iterations ?? null,
                    toolCallsTotal: result?.toolCallsTotal ?? null,
                    usage: _emptyUsage,
                    ...(_emptyHasThinking !== null ? { hasThinkingContent: _emptyHasThinking } : {}),
                    ...(_emptyBlockTypes !== null ? { contentBlockTypes: _emptyBlockTypes } : {}),
                    ts: Date.now(),
                });
                try {
                    const _blockTypesStr = _emptyBlockTypes ? _emptyBlockTypes.join(',') || 'none' : 'unknown';
                    const _thinkingStr = _emptyHasThinking === null ? 'unknown' : String(_emptyHasThinking);
                    process.stderr.write(`[session] empty-final persisted sessionId=${sessionId} stopReason=${_emptyStop ?? 'unknown'} iterations=${result?.iterations ?? 0} toolCallsTotal=${result?.toolCallsTotal ?? 0} outTokens=${_emptyUsage?.outputTokens ?? 0} hasThinking=${_thinkingStr} blockTypes=${_blockTypesStr}\n`);
                } catch {}
            }
            session.updatedAt = Date.now();
            session.lastUsedAt = Date.now();
            applyAskTerminalUsageTotals(session, result, {
                skipTotalsIfIncremental: runtime?.usageMetricsTurnIncremental === true,
            });
            recordProviderContextBaseline(session, session.messages, result.lastTurnUsage || result.usage, {
                sendTools: result.lastSendTools,
            });
            // Agent Runtime cache stats — record hit/miss after every successful
            // ask so the registry reflects all agent traffic, not just
            // maintenance cycles. Guarded against any agent-runtime error so
            // metric recording never breaks the ask itself.
            let prefixHashForLog = null;
            const _agentRuntimeApi = getAgentRuntimeSync();
            if (session.profileId && result.usage && _agentRuntimeApi) {
                try {
                    const profile = _agentRuntimeApi.getProfile(session.profileId);
                    if (profile) {
                        // Collect every leading system-role message (BP1, BP2, ...)
                        // until the first non-system message so the registry hash
                        // captures the full ordered provider prefix, not just BP1.
                        const systemMsgs = [];
                        for (const m of session.messages) {
                            if (m?.role !== 'system') break;
                            systemMsgs.push(typeof m.content === 'string' ? m.content : '');
                        }
                        _agentRuntimeApi.recordCall(profile, session.provider, {
                            systemPrompt: systemMsgs,
                            tools: session.tools || [],
                            usage: result.usage,
                        });
                        const entry = _agentRuntimeApi.registry?.data?.profiles?.[session.profileId]?.[session.provider];
                        prefixHashForLog = entry?.prefixHash || null;
                    }
                } catch {}
            }
            // Append to the agent trace store with rich usage fields.
            if (result.usage) {
                const inputTokens = result.usage.inputTokens || 0;
                const outputTokens = result.usage.outputTokens || 0;
                const cacheReadTokens = result.usage.cachedTokens || 0;
                const cacheWriteTokens = result.usage.cacheWriteTokens || 0;
                // Unified total-prompt field. Anthropic = input+cache_read+cache_write
                // (additive); OpenAI OAuth/API/Gemini = input_tokens already includes the
                // cached portion (inclusive), so the fallback must not double-count.
                const { isInclusiveProvider, computeCostUsd } = await import('../../../../shared/llm/cost.mjs');
                const inclusive = isInclusiveProvider(session.provider);
                const promptTokens = typeof result.usage.promptTokens === 'number'
                    ? result.usage.promptTokens
                    : (inclusive
                        ? Math.max(inputTokens, cacheReadTokens + cacheWriteTokens)
                        : inputTokens + cacheReadTokens + cacheWriteTokens);
                let costUsd = result.usage.costUsd || 0;
                if (!costUsd) {
                    try {
                        costUsd = computeCostUsd({
                            model: session.model,
                            provider: session.provider,
                            inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                        });
                    } catch { /* best-effort */ }
                }
                logLlmCall({
                    ts: new Date().toISOString(),
                    sourceType: session.sourceType || 'lead',
                    sourceName: session.sourceName || session.agent || null,
                    preset: session.presetName || null,
                    model: session.model,
                    provider: session.provider,
                    duration: Date.now() - _askStartedAt,
                    profileId: session.profileId || null,
                    sessionId: session.id,
                    inputTokens,
                    outputTokens,
                    cacheReadTokens,
                    cacheWriteTokens,
                    promptTokens,
                    prefixHash: prefixHashForLog,
                    costUsd,
                });
                recordStandaloneStatusTelemetry(session, result, Date.now() - _askStartedAt);
            }
            // Persist opaque providerState for stateful providers. The update
            // bit distinguishes an adapter that emitted no state update from
            // an explicit clear caused by compaction/provider reset.
            if (result.providerStateUpdated === true
                && (result.providerState === undefined || result.providerState === null)) {
                delete session.providerState;
            } else if (result.providerStateUpdated === true || result.providerState !== undefined) {
                session.providerState = result.providerState;
            }
            const terminalResultPreview = {
                ...result,
                trimmed: messagesDropped > 0,
                messagesDropped,
            };
            _pwstTurnDrained = drainPendingMessages(sessionId);
            if (_pwstTurnDrained.length === 0 && typeof askOpts?.onTerminalResult === 'function') {
                try {
                    askOpts.onTerminalResult(terminalResultPreview, {
                        sessionId,
                        beforeSave: true,
                        durationMs: Date.now() - _askStartedAt,
                    });
                } catch { /* best-effort early completion relay */ }
            }
            // Auto-compact runs at the start of the next
            // query/provider send (agentLoop pre-send), not after the previous
            // answer. This lets queued follow-up prompts resume immediately;
            // if they need compaction, their own spinner shows compacting first.
            // Fire-and-forget terminal save. The result is already produced and
            // (for agent surfaces) relayed via onTerminalResult above, and
            // saveSessionAsync() has already published the in-memory snapshot via
            // setLiveSession(), so read-your-writes holds in-process without
            // awaiting disk. Never block the terminal unwind on the write — that
            // would strand the owning background task in `running` and suppress
            // its completion notification. A slow write finishes in the
            // background.
            saveSessionAsync(session, { expectedGeneration: askGeneration }).catch((err) => {
                try { process.stderr.write(`[session] terminal save failed: ${err?.message || err}\n`); } catch {}
            });
            activeSession = session;
            runtime.session = session;
            // Tag empty-synthesis BEFORE markSessionDone so the watchdog
            // (which inspects entry.emptyFinal first) classifies the
            // terminal state correctly even if it ticks during unwind.
            const isEmptyFinal = !result.content && !result.reasoningContent;
            if (isEmptyFinal) {
                markSessionEmptyFinal(sessionId);
            }
            markSessionDone(sessionId, { empty: isEmptyFinal });
            _result = terminalResultPreview;
        } catch (err) {
            // Cancellation/error paths bypass the commit point above; drop the
            // live-turn alias so contextStatus() stops estimating from the
            // stale in-flight array once the turn unwinds.
            if (activeSession) activeSession.liveTurnMessages = null;
            if (err instanceof SessionClosedError) {
                const currentRuntime = _getRuntimeEntry(sessionId);
                if (!currentRuntime?.closed) {
                    if (activeSession) {
                        const finalized = _turnInterruption.finalize({
                            turnOutgoing: _turnOutgoing || activeSession.messages,
                            currentUserContent: cancelledUserTurnContent,
                            abortReason: err.reason,
                        });
                        activeSession.messages = finalized.messages;
                        if (!finalized.responsePreserved) {
                            activeSession.sessionStartMetaInjected = _sessionStartMetaInjectedBeforeTurn;
                        } else {
                            // The opaque provider continuation now points at a
                            // request that ended mid-turn. Force full transcript
                            // replay on the next send instead of reusing it.
                            activeSession.providerState = undefined;
                        }
                        activeSession.updatedAt = Date.now();
                        activeSession.lastUsedAt = Date.now();
                        try {
                            await saveSessionAsync(activeSession, { expectedGeneration: askGeneration });
                        } catch { /* cancellation cleanup is best-effort */ }
                        if (currentRuntime) currentRuntime.session = activeSession;
                    }
                    markSessionCancelled(sessionId);
                }
                // Cancellation is not an error; propagate silently so callers
                // can render it as "cancelled" rather than a red failure.
                throw err;
            }
            await persistCompactedOutgoingAfterAskFailure({
                sessionId,
                activeSession,
                askGeneration,
                turnOutgoing: _turnOutgoing,
                error: err,
            });
            markSessionError(sessionId, err && err.message ? err.message : String(err));
            throw err;
        }
        // ── Turn complete. Drain the pending-message queue: any `agent type=send` that arrived while this
        //    turn was in flight runs next, in order, as a follow-up user turn.
        //    The mutex is still held, so a send racing this drain either landed
        //    before (picked up here) or enqueues for the next loop. When the
        //    queue is empty we return the latest turn's result. ──
        const _drained = (_pwstTurnDrained && _pwstTurnDrained.length > 0)
            ? _pwstTurnDrained
            : drainPendingMessages(sessionId);
        if (_drained.length > 0) {
            // Same merge rule as the mid-turn steering drain (loop.mjs) and
            // the TUI engine.mjs drain(): a single drain batch is joined with
            // "\n" and delivered as ONE follow-up turn, not N isolated turns.
            // Keeps every steering/follow-up path on identical
            // merge-then-deliver semantics. Anything that arrives AFTER this
            // drain enqueues for the next loop pass and is merged there.
            const _mergedTail = _mergePendingMessageEntries(_drained);
            if (_mergedTail?.content) {
                _pendingTail.push(_mergedTail.content);
                // Carry the just-committed in-memory session into the follow-up
                // turn so the queued tail sees the preceding assistant/tool
                // context. loadSession() would return this same live snapshot
                // (setLiveSession published it), so skip the disk round-trip.
                // NOTE: `session` (try-block const, :179) is out of scope here —
                // `activeSession` already holds the committed session.
                runtime.session = activeSession;
                continue;
            }
        }
        _unlinkParentAbortListener(_getRuntimeEntry(sessionId));
        return _result;
      }
    } finally {
        // Clear the controller only if it's still ours (closeSession may have
        // swapped it). Leave the rest of the runtime entry intact so agent type=list
        // can still surface the final stage (done/error/cancelling).
        const entry = _getRuntimeEntry(sessionId);
        if (entry && entry.generation === askGeneration) {
            _unlinkParentAbortListener(entry);
            entry.controller = null;
            // Detach the live session reference; ask is over.
            entry.session = null;
        }
        unlock();
    }
}
