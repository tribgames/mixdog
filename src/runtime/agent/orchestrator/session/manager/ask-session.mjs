// manager/ask-session.mjs
// The core ask pipeline extracted verbatim from manager.mjs: the per-session
// mutex-guarded turn loop (askSession) plus the abort-aware call wrapper
// (_api_call_with_interrupt). Behavior-preserving move — every runtime
// helper it used in manager.mjs is now imported from its split module.
import { createHash, randomUUID } from 'crypto';
import { getProvider } from '../../providers/registry.mjs';
import { readStreamOutcome } from '../../providers/lib/stream-outcome.mjs';
import { classifyError } from '../../providers/retry-classifier.mjs';
import { normalizeCompactType, DEFAULT_COMPACT_TYPE } from '../compact.mjs';
import { loadSession, saveSession, saveSessionAsync, saveSessionAsyncDeferred, readSessionLifecycleFromDisk } from '../store.mjs';
import { createAbortController } from '../../../../shared/abort-controller.mjs';
import { estimateJsonBytes } from '../../../../shared/json-metrics.mjs';
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
    refreshSessionBp3Environment,
    hasUserConversationMessage,
} from './prompt-utils.mjs';
import {
    _mergePendingMessageEntries,
    acknowledgePendingMessages,
    finalizePendingMessageDelivery,
    drainPendingMessages,
    hydratePendingMessages,
    recordPendingMessageDelivery,
    releasePendingMessages,
} from './pending-messages.mjs';
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
    _evictTerminalSessionRuntime,
} from './runtime-liveness.mjs';
import { SessionClosedError } from './session-errors.mjs';
import { acquireSessionLock } from './session-lock.mjs';
import { codexWireSendOpts, ensureCodexWireSessionId, mintUuidV7 } from './session-id.mjs';
import { _tryBridgeExplicitPrefetch } from './prefetch-bridge.mjs';
import {
    filterModelVisibleSessionMessages,
    persistCompactedOutgoingAfterAskFailure,
} from './message-sanitize.mjs';
import { createTurnInterruptionTracker } from './turn-interruption.mjs';
import {
    cancelPendingTurnCheckpoint,
    clearTurnCheckpoint,
    recoverTurnCheckpoint,
    turnMessagesForCheckpoint,
    writeTurnCheckpoint,
} from './turn-checkpoint.mjs';
import { _getAgentLoop } from './runtime-loaders.mjs';
import { getAgentRuntimeSync } from './agent-runtime-singleton.mjs';
import { recordProviderContextBaseline } from '../loop/compact-policy.mjs';
import { runAbortable, settleWithin, throwIfAborted } from '../../../../shared/abort-race.mjs';

export const DEFAULT_ASK_CLEANUP_SETTLE_MS = 2_000;

export async function settleAskCleanup(promise, { timeoutMs } = {}) {
    const configured = Number(process.env.MIXDOG_ASK_CLEANUP_SETTLE_MS);
    const budget = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs)
        : (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ASK_CLEANUP_SETTLE_MS);
    return await settleWithin(promise, budget);
}

export function persistedAssistantTranscriptMetadata(value, fallbackAt = Date.now()) {
    if (!value || typeof value !== 'object') return null;
    const candidateAt = Number(value.assistantAt);
    const assistantAt = Number.isFinite(candidateAt) && candidateAt > 0 ? candidateAt : fallbackAt;
    value.assistantAt = assistantAt;
    return {
        at: assistantAt,
        ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}),
        ...(typeof value.provider === 'string' && value.provider ? { provider: value.provider } : {}),
        ...(typeof value.agent === 'string' && value.agent ? { agent: value.agent } : {}),
    };
}

export function attachAssistantTranscriptCompletion(messages, completion, turnStartedAt = 0) {
    if (!Array.isArray(messages) || !completion || typeof completion !== 'object') return false;
    const elapsedMs = Math.max(0, Number(completion.elapsedMs || 0));
    const status = typeof completion.status === 'string' && completion.status
        ? completion.status
        : 'done';
    const verb = typeof completion.verb === 'string' && completion.verb
        ? completion.verb
        : 'Thought';
    let turnStart = -1;
    const expectedAt = Number(turnStartedAt || 0);
    if (expectedAt > 0) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (message?.role !== 'user') continue;
            if (Number(message?.meta?.transcript?.at || 0) !== expectedAt) continue;
            turnStart = index;
            break;
        }
    }
    for (let index = messages.length - 1; index > turnStart; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'assistant') continue;
        const content = message.content;
        const hasVisibleText = typeof content === 'string'
            ? Boolean(content.trim())
            : Array.isArray(content) && content.some((part) => {
                if (typeof part === 'string') return Boolean(part.trim());
                if (!part || typeof part !== 'object') return false;
                return Boolean(String(part.text || part.content || '').trim());
            });
        if (!hasVisibleText) continue;
        const meta = message.meta && typeof message.meta === 'object' ? message.meta : {};
        const transcript = meta.transcript && typeof meta.transcript === 'object'
            ? meta.transcript
            : {};
        messages[index] = {
            ...message,
            meta: {
                ...meta,
                transcript: {
                    ...transcript,
                    completion: { status, verb, elapsedMs },
                },
            },
        };
        return true;
    }
    return false;
}

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
    const _rawTranscriptMeta = askOpts?.transcriptMeta;
    const _transcriptMeta = _rawTranscriptMeta && typeof _rawTranscriptMeta === 'object'
        ? {
            ...(Number.isFinite(Number(_rawTranscriptMeta.at)) ? { at: Number(_rawTranscriptMeta.at) } : {}),
            ...(typeof _rawTranscriptMeta.model === 'string' && _rawTranscriptMeta.model ? { model: _rawTranscriptMeta.model } : {}),
            ...(typeof _rawTranscriptMeta.provider === 'string' && _rawTranscriptMeta.provider ? { provider: _rawTranscriptMeta.provider } : {}),
            ...(typeof _rawTranscriptMeta.agent === 'string' && _rawTranscriptMeta.agent ? { agent: _rawTranscriptMeta.agent } : {}),
        }
        : null;
    const _takeAssistantTranscriptMetadata = () => {
        const metadata = persistedAssistantTranscriptMetadata(_rawTranscriptMeta);
        if (_rawTranscriptMeta && typeof _rawTranscriptMeta === 'object') delete _rawTranscriptMeta.assistantAt;
        return metadata;
    };
    const _promptSrc = 'prompt';
    const _prefetchFiles = (explicitPrefetch?.files?.length) || 0;
    const _prefetchCallers = (explicitPrefetch?.callers?.length) || 0;
    const _prefetchRefs = (explicitPrefetch?.references?.length) || 0;
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] t0-ask-start sessionHash=${createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 8)} role=? iteration=0 promptSrc=${_promptSrc} prefetchFiles=${_prefetchFiles} callers=${_prefetchCallers} references=${_prefetchRefs}\n`);
    }
    const unlock = await acquireSessionLock(sessionId, askOpts?.signal);
    // Start crash-spool hydration without delaying the user turn. A completed
    // background hydration joins the id-deduped memory drain below.
    const takeoverHydration = hydratePendingMessages(sessionId);
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
    let _crashRecoveryChecked = false;
    try {
      // Turn loop (pendingMessages pattern): run the current prompt, then drain
      // any `agent type=send` messages that were queued while this turn was in
      // flight and run them — in order — as the next user turn(s). Because the
      // queued send always lands AFTER the in-flight prompt here, ordering is
      // preserved and the spawn/connecting startup race disappears.
      for (;;) {
        let _pwstTurnDrained = null;
        let _turnPendingEntries = [];
        // After the first turn, the next prompt comes from the drained queue.
        // (On the first iteration _pendingTail is empty and `prompt` is the
        // caller's original message.)
        if (_pendingTail.length > 0) {
            const pendingTurn = _pendingTail.shift();
            prompt = pendingTurn.content;
            _turnPendingEntries = pendingTurn.entries;
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
                    _turnPendingEntries = _preDrained;
                    context = null;
                    explicitPrefetch = null;
                }
            }
        }
        if (!hasModelVisiblePromptContent(prompt)) {
            void takeoverHydration.then((count) => {
                if (count <= 0) return;
                setImmediate(() => {
                    askSession(sessionId, '', null, onToolCall, cwdOverride, null, askOpts).catch(() => {});
                });
            });
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
        const _codexWireSessionId = ensureCodexWireSessionId(preSession);
        if (!_crashRecoveryChecked) {
            _crashRecoveryChecked = true;
            const recovery = recoverTurnCheckpoint(preSession);
            if (recovery.changed) {
                saveSession(preSession, {
                    sync: true,
                    expectedGeneration: preSession.generation,
                });
                if (recovery.turnToken) clearTurnCheckpoint(sessionId, recovery.turnToken);
            }
        }
        // A prior crash/partial-save during compaction may have pinned
        // compaction.lastStage='compacting'. This ask is starting fresh, so
        // recover the stale transient stage before the loop's pre-send compact
        // path runs (it will overwrite lastStage with real telemetry).
        normalizeStaleCompactingStage(preSession);
        // Split-brain re-adoption: another surface (e.g. desktop click-through
        // of a session still actively owned by this process) may have
        // resumed-and-detached this session, bumping the ON-DISK generation
        // while the conversation kept going here. Every save from this process
        // would then be silently dropped by _shouldDrop's ownership rule and
        // the on-disk transcript would freeze at the last landed save. A new
        // ask on a NON-closed session is an explicit ownership claim: adopt
        // the disk generation so this turn's commits land and heal the file.
        const diskLifecycle = readSessionLifecycleFromDisk(sessionId);
        if (diskLifecycle && diskLifecycle.closed !== true
            && diskLifecycle.generation > (typeof preSession.generation === 'number' ? preSession.generation : 0)) {
            preSession.generation = diskLifecycle.generation;
        }
        askGeneration = typeof preSession.generation === 'number' ? preSession.generation : 0;
        const runtime = _touchRuntime(sessionId);
        // Preserve any parent-abort link agent-dispatch established BEFORE we
        // swap in a fresh controller: replacing runtime.controller drops the
        // abort state, so an already/early-aborted parent signal (user ESC /
        // owner abort landing during setup) would be lost and provider
        // computation would run detached. Capture the linked signal, install the
        // fresh controller, then re-cascade it — aborting the new controller
        // immediately when the parent already fired, or re-arming the listener.
        const _linkedParentSignal = askOpts?.signal || runtime.parentAbortLink?.signal;
        // Fresh controller per ask — the previous ask's controller may have aborted.
        runtime.controller = createAbortController();
        const turnSignal = runtime.controller.signal;
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
        const _turnCheckpointToken = randomUUID();
        const _turnCheckpointStartedAt = Date.now();
        const _codexTurnId = _codexWireSessionId ? mintUuidV7(_turnCheckpointStartedAt) : null;
        const _TURN_CHECKPOINT_THROTTLE_MS = 150;
        let _turnCheckpointTimer = null;
        let _turnCheckpointStopped = false;
        let _turnCheckpointLastAt = 0;
        let _turnCheckpointWarned = false;
        const _flushTurnCheckpoint = () => {
            if (_turnCheckpointStopped || !_turnOutgoing || !cancelledUserTurnContent) return false;
            try {
                const written = writeTurnCheckpoint({
                    sessionId,
                    generation: askGeneration,
                    turnToken: _turnCheckpointToken,
                    startedAt: _turnCheckpointStartedAt,
                    currentUserContent: cancelledUserTurnContent,
                    turnMessages: turnMessagesForCheckpoint(_turnOutgoing, cancelledUserTurnContent),
                    interruption: _turnInterruption.snapshot(),
                }, {
                    // The turn's first checkpoint is the crash-durability
                    // anchor for the prompt and must land before the provider
                    // runs; every later streaming/tool-boundary flush moves to
                    // the async latest-wins lane so serialization+disk never
                    // stall the engine thread mid-stream.
                    sync: _turnCheckpointLastAt === 0,
                });
                if (written) _turnCheckpointLastAt = Date.now();
                return written;
            } catch (error) {
                if (!_turnCheckpointWarned) {
                    _turnCheckpointWarned = true;
                    try { process.stderr.write(`[turn-checkpoint] write failed session=${sessionId}: ${error?.message || error}\n`); } catch {}
                }
                return false;
            }
        };
        const _scheduleTurnCheckpoint = (immediate = false) => {
            if (_turnCheckpointStopped || !_turnOutgoing) return;
            if (immediate || Date.now() - _turnCheckpointLastAt >= _TURN_CHECKPOINT_THROTTLE_MS) {
                if (_turnCheckpointTimer) clearTimeout(_turnCheckpointTimer);
                _turnCheckpointTimer = null;
                _flushTurnCheckpoint();
                return;
            }
            if (_turnCheckpointTimer) return;
            const waitMs = Math.max(1, _TURN_CHECKPOINT_THROTTLE_MS - (Date.now() - _turnCheckpointLastAt));
            _turnCheckpointTimer = setTimeout(() => {
                _turnCheckpointTimer = null;
                _flushTurnCheckpoint();
            }, waitMs);
            _turnCheckpointTimer.unref?.();
        };
        const _stopTurnCheckpoint = () => {
            _turnCheckpointStopped = true;
            if (_turnCheckpointTimer) clearTimeout(_turnCheckpointTimer);
            _turnCheckpointTimer = null;
            cancelPendingTurnCheckpoint(sessionId);
        };
        let _interruptionSnapshot = null;
        const _prepareCloseSnapshot = (abortReason) => {
            if (_interruptionSnapshot) return _interruptionSnapshot;
            if (!activeSession) return null;
            _stopTurnCheckpoint();
            activeSession.liveTurnMessages = null;
            _turnInterruption.restoreTombstonedText();
            const finalized = _turnInterruption.finalize({
                turnOutgoing: _turnOutgoing || activeSession.messages,
                currentUserContent: cancelledUserTurnContent,
                abortReason,
            });
            activeSession.messages = finalized.messages;
            delete activeSession.activeTurnCheckpoint;
            if (!finalized.responsePreserved) {
                if (finalized.userTurnPreserved) {
                    // A non-user detach keeps the provisional prompt but makes
                    // the opaque provider continuation unsafe to reuse.
                    activeSession.providerState = undefined;
                }
            } else {
                activeSession.providerState = undefined;
            }
            activeSession.updatedAt = Date.now();
            activeSession.lastUsedAt = Date.now();
            runtime.session = activeSession;
            _interruptionSnapshot = finalized;
            return finalized;
        };
        // closeSession is synchronous and generation-first by design. Expose a
        // turn-local hook so it can canonicalize the in-flight transcript
        // before bumpSessionGeneration()/markSessionClosed() writes the disk
        // snapshot and invalidates the ordinary cancellation cleanup save.
        runtime.prepareCloseSnapshot = _prepareCloseSnapshot;
        try {
            const session = activeSession;
            const provider = getProvider(session.provider);
            // Register the live session object for synchronous close snapshots.
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
            const explicitPrefetchResult = await _tryBridgeExplicitPrefetch(session, explicitPrefetch, turnSignal);
            let _contextBlock = '';
            if (context) {
                _contextBlock += `# Additional context\n${_capCtx(context)}\n\n`;
            }
            if (explicitPrefetchResult) {
                _contextBlock += `# Prefetch\n${_capCtx(explicitPrefetchResult)}\n\n`;
            }
            const effectiveCwd = cwdOverride || session.cwd;
            if (session.sessionStartMetaInjected !== true
                && !hasUserConversationMessage(session.messages)) {
                refreshSessionBp3Environment(session, effectiveCwd);
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
            const _currentTimeBlock = buildCurrentTimeBlock(prompt);
            const _turnReminderBlock = _currentTimeBlock
                ? `<system-reminder>\n# Current Time\n${_currentTimeBlock}\n</system-reminder>`
                : '';
            const _baseUserTurnContent = prefixUserTurnContent(prompt, _contextBlock);
            const _userTurnContent = prefixSessionStartContent(_baseUserTurnContent, _turnReminderBlock);
            cancelledUserTurnContent = _userTurnContent;
            const outgoing = [...historyMessages, {
                role: 'user',
                content: _userTurnContent,
                ...(_transcriptMeta ? { meta: { transcript: _transcriptMeta } } : {}),
            }];
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
            session.activeTurnCheckpoint = {
                version: 1,
                turnToken: _turnCheckpointToken,
                startedAt: _turnCheckpointStartedAt,
            };
            // The sidecar lands synchronously before provider execution. Even
            // if the async canonical-session preflight save has not reached its
            // worker when the process is killed, recovery still has the prompt.
            _scheduleTurnCheckpoint(true);
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
                const _messagesBytes = estimateJsonBytes(historyMessages || []);
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
            const agentLoop = await runAbortable(turnSignal, () => _getAgentLoop());
            const _trackTextDelta = (chunk) => {
                _turnInterruption.recordTextDelta(chunk);
                _scheduleTurnCheckpoint();
                if (typeof askOpts?.onTextDelta === 'function') askOpts.onTextDelta(chunk);
            };
            const _trackTextReset = async (detail) => {
                // Replacement is opt-in and transactional: a delta-only
                // consumer cannot retract already exposed bytes, so absence,
                // false, or rejection must preserve the original partial and
                // force the provider's terminal no-replay behavior.
                if (typeof askOpts?.onTextReset !== 'function') return false;
                let acknowledged = false;
                try {
                    acknowledged = await askOpts.onTextReset(detail) === true;
                } catch {
                    return false;
                }
                if (!acknowledged) return false;
                _turnInterruption.tombstoneText(detail?.chars);
                _scheduleTurnCheckpoint(true);
                return true;
            };
            const _trackReasoningDelta = (chunk) => {
                _turnInterruption.recordReasoningDelta(chunk);
                _scheduleTurnCheckpoint();
                if (typeof askOpts?.onReasoningDelta === 'function') askOpts.onReasoningDelta(chunk);
            };
            const _trackAssistantText = (text) => {
                _turnInterruption.recordAssistantText(text);
                _scheduleTurnCheckpoint(true);
                if (typeof askOpts?.onAssistantText === 'function') askOpts.onAssistantText(text);
            };
            const _trackedOnToolCall = async (iteration, calls) => {
                _turnInterruption.recordToolCalls(calls);
                _scheduleTurnCheckpoint(true);
                if (typeof onToolCall === 'function') return await onToolCall(iteration, calls);
                return undefined;
            };
            const _trackToolResult = (message) => {
                _turnInterruption.recordToolResult(message);
                _scheduleTurnCheckpoint(true);
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
                    modelParameters: session.modelParameters || {},
                    selectedContextWindow: session.selectedContextWindow || session.contextWindow || null,
                    sessionId,
                    onTextDelta: _trackTextDelta,
                    onTextReset: _trackTextReset,
                    onReasoningDelta: _trackReasoningDelta,
                    onAssistantText: _trackAssistantText,
                    takeAssistantTranscriptMetadata: _takeAssistantTranscriptMetadata,
                    onAssistantMessageCommitted: () => {
                        _turnInterruption.markAssistantMessageCommitted();
                        _scheduleTurnCheckpoint(true);
                    },
                    onAssistantToolCallObserved: (call, detail) => {
                        _turnInterruption.recordToolCalls([call], detail);
                        _scheduleTurnCheckpoint(true);
                        try { askOpts?.onAssistantToolCallObserved?.(call, detail); } catch {}
                    },
                    onProviderSendStarted: () => {
                        _turnInterruption.markProviderSendStarted();
                        _scheduleTurnCheckpoint(true);
                        try { askOpts?.onProviderSendStarted?.(); } catch {}
                    },
                    onToolPhaseStarted: () => {
                        _turnInterruption.markToolPhaseStarted();
                        _scheduleTurnCheckpoint(true);
                        try { askOpts?.onToolPhaseStarted?.(); } catch {}
                    },
                    onToolPhaseCompleted: (detail) => {
                        try { askOpts?.onToolPhaseCompleted?.(detail); } catch {}
                    },
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
                    beforeToolExecution: typeof askOpts?.beforeToolExecution === 'function'
                        ? askOpts.beforeToolExecution
                        : undefined,
                    onCompactEvent: (event) => {
                        _scheduleTurnCheckpoint(true);
                        try { askOpts?.onCompactEvent?.(event); } catch {}
                    },
                    // Pre-send gauge sync. Defined only when a host listens so
                    // the loop never computes a display number nobody reads.
                    onContextPressure: typeof askOpts?.onContextPressure === 'function'
                        ? askOpts.onContextPressure
                        : undefined,
                    // Mid-chain queued prompt/notification
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
                        // Manager/pending-messages entries carry no
                        // mode/priority/slash metadata, so they stay OUT of the
                        // mid-chain (post-tool-batch) drain — that would bypass
                        // the queued-command filters. At the TERMINAL boundary
                        // they are exactly pending input: an `agent type=send`
                        // queued while
                        // the terminal sample was in flight must be folded into
                        // THIS turn before any stop hook runs, instead of losing
                        // its slot to a synthetic continuation prompt. The mutex
                        // is held for the whole ask, so this drain races nothing.
                        // Entries consumed here join _turnPendingEntries: their
                        // delivery/ack (and release on failure) rides this turn,
                        // and the post-loop drain can no longer see them.
                        if (drainOptions?.stage === 'terminal') {
                            const _pendingNow = drainPendingMessages(sessionId);
                            if (_pendingNow.length > 0) {
                                const _mergedNow = _mergePendingMessageEntries(_pendingNow);
                                if (_mergedNow?.content) {
                                    _turnPendingEntries.push(..._pendingNow);
                                    out.push(_mergedNow);
                                } else {
                                    releasePendingMessages(sessionId, _pendingNow);
                                }
                            }
                        }
                        return out;
                    },
                    onSteerMessage: (text, detail) => {
                        _scheduleTurnCheckpoint(true);
                        try { askOpts?.onSteerMessage?.(text, detail); } catch {}
                    },
                    notifyFn: typeof askOpts?.notifyFn === 'function' ? askOpts.notifyFn : undefined,
                    // Same projection compaction uses, so a session presents one
                    // identity on every request it makes.
                    ...(codexWireSendOpts(session, {
                        turnId: _codexTurnId,
                        startedAtMs: _turnCheckpointStartedAt,
                    }) || {}),
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
            throwIfAborted(turnSignal);
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
            _stopTurnCheckpoint();
            delete session.activeTurnCheckpoint;
            const _assistantTranscriptMeta = persistedAssistantTranscriptMetadata(_rawTranscriptMeta);
            if (result.content || result.reasoningContent) {
                // Max-output recovery returns the complete concatenated text to
                // callers/TUI, while outgoing already contains prior partial
                // assistant turns and their continuation prompts. Persist only
                // the terminal segment here so model history contains every byte
                // exactly once.
                const persistedAssistantContent = typeof result.historyContent === 'string'
                    ? result.historyContent
                    : (result.content || '');
                const _terminalStop = result?.stopReason ?? result?.stop_reason ?? null;
                session.messages.push({
                    role: 'assistant',
                    // Keep content as-is in memory (model-visible). Image bytes,
                    // if any, are swapped for a placeholder only at disk write
                    // time inside the session store (store.mjs _sessionForDisk).
                    content: persistedAssistantContent,
                    ...(_assistantTranscriptMeta ? { meta: { transcript: _assistantTranscriptMeta } } : {}),
                    ...(typeof result.reasoningContent === 'string' && result.reasoningContent
                        ? { reasoningContent: result.reasoningContent }
                        : {}),
                    ...(result.providerMetadata && typeof result.providerMetadata === 'object'
                        ? { providerMetadata: result.providerMetadata }
                        : {}),
                    // Keep terminal provider evidence for non-empty turns too.
                    // A safety classifier can emit narration and then refuse;
                    // omitting this metadata made that shape indistinguishable
                    // from an ordinary successful final response.
                    ...(_terminalStop ? { stopReason: _terminalStop } : {}),
                    ...(result?.terminationReason ? { terminationReason: result.terminationReason } : {}),
                    iterations: result?.iterations ?? null,
                    toolCallsTotal: result?.toolCallsTotal ?? null,
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
                    ...(_assistantTranscriptMeta ? { meta: { transcript: _assistantTranscriptMeta } } : {}),
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
            // The terminal assistant message is now canonical. A close racing
            // any later await should persist this committed session as-is,
            // never re-finalize the pre-terminal outgoing array.
            if (runtime.prepareCloseSnapshot === _prepareCloseSnapshot) {
                runtime.prepareCloseSnapshot = null;
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
                const { isInclusiveProvider, computeCostUsd } = await runAbortable(
                    turnSignal,
                    () => import('../../../../shared/llm/cost.mjs'),
                );
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
            // The provider accepted this queued turn: only now remove its
            // durable ids. A crash before here leaves them for at-least-once
            // replay; duplicate memory/spool copies share the same id.
            recordPendingMessageDelivery(session, _turnPendingEntries);
            _pwstTurnDrained = drainPendingMessages(sessionId);
            if (_pwstTurnDrained.length === 0) {
                const turnStartedAt = Number(_rawTranscriptMeta?.at || _askStartedAt);
                attachAssistantTranscriptCompletion(session.messages, {
                    status: 'done',
                    verb: _rawTranscriptMeta?.completionVerb,
                    elapsedMs: Date.now() - turnStartedAt,
                }, turnStartedAt);
            }
            let terminalRelayed = false;
            if (_pwstTurnDrained.length === 0 && typeof askOpts?.onTerminalResult === 'function') {
                terminalRelayed = true;
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
            // (for agent surfaces) relayed via onTerminalResult above. When
            // completion was relayed to the UI, yield before postMessage
            // structured-clones the full session. Queued follow-up turns retain
            // the original immediate-save ordering; they did not inject a
            // terminal card and may mutate this same session on the next loop.
            const saveTerminalSession = terminalRelayed
                ? saveSessionAsyncDeferred
                : saveSessionAsync;
            const terminalSave = saveTerminalSession(session, { expectedGeneration: askGeneration });
            terminalSave.then(
                () => clearTurnCheckpoint(sessionId, _turnCheckpointToken),
                () => {},
            );
            finalizePendingMessageDelivery(
                session,
                _turnPendingEntries,
                terminalSave,
                () => saveSessionAsync(session, { expectedGeneration: askGeneration }),
            ).catch((err) => {
                    try { process.stderr.write(`[session] terminal save failed: ${err?.message || err}\n`); } catch {}
            });
            _turnPendingEntries = [];
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
            _stopTurnCheckpoint();
            // Cancellation/error paths bypass the commit point above; drop the
            // live-turn alias so contextStatus() stops estimating from the
            // stale in-flight array once the turn unwinds.
            if (activeSession) {
                activeSession.liveTurnMessages = null;
                delete activeSession.activeTurnCheckpoint;
            }
            // Restore before ANY finalization path. In particular, cancellation
            // can race the acknowledged non-streaming restart and surface as a
            // SessionClosedError; its interruption snapshot must include the
            // one partial response that was already exposed.
            const restoredResetText = _turnInterruption.restoreTombstonedText();
            if (err instanceof SessionClosedError) {
                const currentRuntime = _getRuntimeEntry(sessionId);
                if (!currentRuntime?.closed) {
                    if (activeSession) {
                        const finalized = _prepareCloseSnapshot(err.reason);
                        if (currentRuntime?.prepareCloseSnapshot === _prepareCloseSnapshot) {
                            currentRuntime.prepareCloseSnapshot = null;
                        }
                        if (!finalized.responsePreserved) {
                            releasePendingMessages(sessionId, _turnPendingEntries);
                        } else {
                            recordPendingMessageDelivery(activeSession, _turnPendingEntries);
                        }
                        try {
                            const durableSave = saveSessionAsync(activeSession, { expectedGeneration: askGeneration });
                            const cleanup = finalized.responsePreserved
                                ? finalizePendingMessageDelivery(
                                    activeSession, _turnPendingEntries, durableSave,
                                    () => saveSessionAsync(activeSession, { expectedGeneration: askGeneration }),
                                )
                                : durableSave;
                            const cleanupResult = await settleAskCleanup(cleanup);
                            if (cleanupResult.settled) clearTurnCheckpoint(sessionId, _turnCheckpointToken);
                        } catch { /* cancellation cleanup is best-effort */ }
                        if (currentRuntime) currentRuntime.session = activeSession;
                    } else releasePendingMessages(sessionId, _turnPendingEntries);
                    markSessionCancelled(sessionId);
                } else releasePendingMessages(sessionId, _turnPendingEntries);
                // Cancellation is not an error; propagate silently so callers
                // can render it as "cancelled" rather than a red failure.
                throw err;
            }
            if (runtime.prepareCloseSnapshot === _prepareCloseSnapshot) {
                runtime.prepareCloseSnapshot = null;
            }
            // A reset acknowledgement removes the live partial before the
            // non-streaming request starts. If that restart fails, restore the
            // tombstone and persist the one exposed partial as interruption
            // history. Failed/absent acknowledgements never tombstoned it.
            // Provider-specific legacy flags are NOT consulted here: the
            // canonical stream-outcome contract answers "did the provider
            // produce output we must commit?" for every transport. Anthropic's
            // stall/truncation errors carry neither liveTextEmitted nor
            // unsafeToRetry — only partialContent/partialToolCalls — and used
            // to drop the streamed summary from history on that provider.
            const _providerOutcome = readStreamOutcome(err);
            const preserveProviderPartial = restoredResetText
                || _providerOutcome.observedOutput === true
                // Positive exposure evidence only: an error with no observed
                // output must not be mistaken for a turn that produced
                // provider output.
                || _providerOutcome.replayUnsafe === true
                || err?.unsafeToRetry === true;
            let _errorStateDurable = false;
            if (preserveProviderPartial && activeSession && _turnInterruption.hasResponseStarted()) {
                const finalized = _prepareCloseSnapshot('provider-error');
                if (finalized.responsePreserved) recordPendingMessageDelivery(activeSession, _turnPendingEntries);
                else releasePendingMessages(sessionId, _turnPendingEntries);
                try {
                    const durableSave = saveSessionAsync(activeSession, { expectedGeneration: askGeneration });
                    const cleanup = finalized.responsePreserved
                        ? finalizePendingMessageDelivery(
                            activeSession, _turnPendingEntries, durableSave,
                            () => saveSessionAsync(activeSession, { expectedGeneration: askGeneration }),
                        )
                        : durableSave;
                    _errorStateDurable = (await settleAskCleanup(cleanup)).settled;
                } catch { /* provider-failure history persistence is best-effort */ }
                const currentRuntime = _getRuntimeEntry(sessionId);
                if (currentRuntime) currentRuntime.session = activeSession;
            } else {
                const compactPersist = await settleAskCleanup(persistCompactedOutgoingAfterAskFailure({
                    sessionId,
                    activeSession,
                    askGeneration,
                    turnOutgoing: _turnOutgoing,
                    error: err,
                }));
                const promptPersisted = compactPersist.settled && compactPersist.value === true;
                if (promptPersisted) {
                    recordPendingMessageDelivery(activeSession, _turnPendingEntries);
                    try {
                        const durableSave = saveSessionAsync(activeSession, { expectedGeneration: askGeneration });
                        const cleanup = finalizePendingMessageDelivery(
                            activeSession, _turnPendingEntries, durableSave,
                            () => saveSessionAsync(activeSession, { expectedGeneration: askGeneration }),
                        );
                        _errorStateDurable = (await settleAskCleanup(cleanup)).settled;
                    } catch {}
                } else {
                    releasePendingMessages(sessionId, _turnPendingEntries);
                }
            }
            if (!_errorStateDurable && activeSession) {
                try {
                    _errorStateDurable = (await settleAskCleanup(
                        saveSessionAsync(activeSession, { expectedGeneration: askGeneration }),
                    )).settled;
                } catch { /* retain checkpoint when canonical persistence fails */ }
            }
            if (_errorStateDurable) clearTurnCheckpoint(sessionId, _turnCheckpointToken);
            // Durable failure identity: every surfaced (non-cancel) turn error
            // logs ONE structured line to stderr — the shard host mirrors it
            // into daemon.log — so post-hoc diagnosis never depends on the
            // renderer's ephemeral failure toast.
            try {
                const _status = Number(err?.httpStatus || err?.status || err?.response?.status || 0) || 0;
                const _parts = [
                    `session=${sessionId}`,
                    `name=${err?.name || 'Error'}`,
                    _status ? `status=${_status}` : null,
                    err?.code ? `code=${err.code}` : null,
                    err?.providerErrorType ? `type=${err.providerErrorType}` : null,
                    `kind=${classifyError(err)}`,
                    Number.isFinite(Number(err?.attempts)) ? `attempts=${err.attempts}` : null,
                    Number.isFinite(Number(err?.midstreamRetries)) ? `midstreamRetries=${err.midstreamRetries}` : null,
                    err?.midstreamClassifier ? `midstream=${err.midstreamClassifier}` : null,
                    err?.requestId ? `requestId=${err.requestId}` : null,
                    _providerOutcome.observedOutput === true ? 'observedOutput=1' : null,
                    _providerOutcome.replayUnsafe === true ? 'replayUnsafe=1' : null,
                    `msg=${JSON.stringify(String(err?.message || err).slice(0, 300))}`,
                ].filter(Boolean);
                process.stderr.write(`[ask-error] ${_parts.join(' ')}\n`);
            } catch { /* diagnostics must never mask the original failure */ }
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
                _pendingTail.push({ content: _mergedTail.content, entries: _drained });
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
        // Pick up cross-process sends that landed after takeover hydration.
        // This never delays completion; a non-empty sweep starts an empty
        // follow-up ask after the current session lock is released.
        setImmediate(() => {
            hydratePendingMessages(sessionId).then((count) => {
                if (count <= 0) return;
                askSession(sessionId, '', null, onToolCall, cwdOverride, null, askOpts).catch(() => {});
            }).catch(() => {});
        });
        return _result;
      }
    } finally {
        // A thrown setup/provider path must never leave a delayed checkpoint
        // writer alive after the turn lock is released.
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
        // Final-stage runtime diagnostics are useful only while the turn is
        // unwinding. Once its controller is detached, retaining the full entry
        // (and any accidental references hanging from it) for the host lifetime
        // turns one-shot agent traffic into an unbounded manager Map.
        _evictTerminalSessionRuntime(sessionId);
        unlock();
    }
}
