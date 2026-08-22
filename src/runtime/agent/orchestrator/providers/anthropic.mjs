import { createRequire } from 'node:module';
import { getAgentApiKey } from '../../../shared/provider-api-key.mjs';
import { sanitizeToolPairs, sanitizeAnthropicContentPairs, foldUserTextIntoToolResultTail } from '../session/context-utils.mjs';
import {
    ANTHROPIC_RETRY_BACKOFF_MS,
    ANTHROPIC_RETRY_JITTER_RATIO,
    AnthropicFallbackTriggeredError,
    anthropicMaxAttempts,
    anthropicRequestTimeoutMs,
    classifyError,
    resolveStallRetryBudget,
    midstreamBackoffFor,
    sleepWithAbort,
    STREAM_STALL_RETRY_BUDGET_MS,
    withRetry,
    retryAfterMsFromError,
} from './retry-classifier.mjs';
import { readStreamOutcome } from './lib/stream-outcome.mjs';
import { traceAgentUsage } from '../agent-trace.mjs';
import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_NONSTREAM_TOTAL_TIMEOUT_MS,
    createTimeoutSignal,
    createPassthroughSignal,
} from '../stall-policy.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import {
    ANTHROPIC_MAX_MIDSTREAM_RETRIES,
    parseSSEStream,
    _classifyMidstreamError,
    stampAnthropicStreamOutcome,
} from './anthropic-sse.mjs';
import { buildAnthropicBetaHeaders, supportsAnthropicFastMode } from './anthropic-betas.mjs';
import { fastModeAvailable, noteFastModeCapacityError } from './anthropic-fast-mode.mjs';
import {
    applyAnthropicEffortToBody,
    effortValuesForModel,
    shouldIncludeEffortBeta,
} from './anthropic-effort.mjs';
import { normalizeContentForAnthropic } from './media-normalization.mjs';
import { enrichModels } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { makeModelCache } from './model-cache.mjs';
import { resolveAnthropicMaxTokens } from './anthropic-max-tokens.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { notifyCurrentAnthropicRateLimit } from './admission-scheduler.mjs';
import {
    ANTHROPIC_CACHE_TTL_STABLE as CACHE_TTL_STABLE,
    ANTHROPIC_CACHE_TTL_VOLATILE as CACHE_TTL_VOLATILE,
    applyAnthropicCacheMarkers,
    clampAnthropicThinkingBudget as clampThinkingBudgetTokens,
    deferredAnthropicTools as sharedDeferredAnthropicTools,
    requestAnthropicTools as sharedRequestAnthropicTools,
    normalizeAnthropicNonStreamingResponse,
    resolveAnthropicCacheTtls as resolveCacheTtls,
    resolveAnthropicMessageCacheSlots,
    sanitizeAnthropicInputSchema,
    toAnthropicToolChoice,
} from './lib/anthropic-request-utils.mjs';

import { loadAnthropic, _midstreamSleepWithAbort, buildSystemBlocks, MODELS, ANTHROPIC_VERSION, _normalizeAnthropicModel, _setApiKeyCatalogMirror, resolveMaxTokens, deferredAnthropicTools, requestAnthropicTools, toAnthropicMessages } from './anthropic-messages.mjs';
export { _test, _toAnthropicMessagesForTest } from './anthropic-messages.mjs';

export class AnthropicProvider {
    // Anthropic reports usage.input_tokens EXCLUDING cache_read/cache_creation
    // (those are separate fields), so the live context-window footprint must
    // add cache_read back. See providerInputExcludesCache() in registry.mjs.
    static inputExcludesCache = true;
    name = 'anthropic';
    client;
    config;
    apiKey;
    fastModeBetaHeaderLatched = false;
    constructor(config) {
        this.config = config || {};
        this.name = this.config.name || 'anthropic';
        this.apiKey = this.config.apiKey || (this.name === 'anthropic' ? process.env.ANTHROPIC_API_KEY : null);
        const betaHeaders = this.config.disableBetaHeaders ? null : buildAnthropicBetaHeaders();
        this.client = new (loadAnthropic())({
            apiKey: this.apiKey,
            ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
            defaultHeaders: { ...(betaHeaders ? { 'anthropic-beta': betaHeaders } : {}), ...(this.config.extraHeaders || {}) },
            maxRetries: 0,
        });
    }
    reloadApiKey() {
        try {
            const newKey = getAgentApiKey(this.name)
                || this.config.apiKey
                || (this.name === 'anthropic' ? process.env.ANTHROPIC_API_KEY : null);
            if (newKey) {
                this.config = { ...(this.config || {}), apiKey: newKey };
                this.apiKey = newKey;
                // Tool-search is a request capability, not an account
                // capability. Keep it off the client defaults and add it only
                // on turns that actually serialize defer_loading tools.
                const betaHeaders = this.config.disableBetaHeaders ? null : buildAnthropicBetaHeaders();
                this.client = new (loadAnthropic())({
                    apiKey: newKey,
                    ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
                    defaultHeaders: { ...(betaHeaders ? { 'anthropic-beta': betaHeaders } : {}), ...(this.config.extraHeaders || {}) },
                    maxRetries: 0,
                });
            }
        } catch { /* best effort */ }
    }
    async send(messages, model, tools, sendOpts) {
        // Defense-in-depth: enforce tool_use / tool_result pairing before
        // the Anthropic API call. Mirror of the OAuth path; loop.mjs only
        // runs sanitizeToolPairs when budget is exceeded, so an under-budget
        // dispatch with an aborted-mid-flight tool_use would otherwise hit
        // the provider as a hard 400 (`tool_use ids ... without tool_result`).
        messages = sanitizeToolPairs(messages);
        try {
            return await this._doSend(messages, model, tools, sendOpts);
        } catch (err) {
            const status = Number(err?.status || err?.httpStatus || err?.response?.status || 0);
            // Auth recovery re-issues the whole turn, so it is a REPLAY: a
            // typed 401 is re-sent once after reloading the key, unless the
            // failure already exposed output or dispatched a tool call.
            const replayPermitted = readStreamOutcome(err).replaySafe === true;
            if (status === 401 && replayPermitted) {
                process.stderr.write(`[provider] Auth error, re-reading provider authentication...\n`);
                this.reloadApiKey();
                return await this._doSend(messages, model, tools, sendOpts);
            }
            throw err;
        }
    }
    async _doSend(messages, model, tools, sendOpts) {
        if (!model) throw new Error(`[${this.name}] model is required — pass it from the caller preset`);
        const useModel = model;
        const maxTokens = resolveMaxTokens(useModel);
        const opts = sendOpts || {};
        const ttls = resolveCacheTtls(opts);

        const systemMsgs = messages.filter(m => m.role === 'system');
        const chatMsgs = messages.filter(m => m.role !== 'system');
        // BP1 baseRules + BP2 stableSystem at ttls.system; BP3 sessionMarker
        // (cacheTier:'tier3') at ttls.tier3 — each its own system content block.
        const systemBlocks = buildSystemBlocks(systemMsgs, ttls.system, ttls.tier3);

        // Message-tail cache budget (4-BP layout + ANTHROPIC_MSG_SLOTS) is
        // shared with anthropic-oauth — see resolveAnthropicMessageCacheSlots.
        const messageCacheSlots = resolveAnthropicMessageCacheSlots(systemBlocks, ttls);
        // Build → sanitize (once, inside toAnthropicMessages) → mark. Markers
        // are applied to the FINAL sanitized array by invariant, so block
        // drops / inserts / reorders performed by the sanitizer can never move
        // or delete a marked block. NEVER sanitize again after this.
        const anthropicMessages = applyAnthropicCacheMarkers(
            toAnthropicMessages(chatMsgs),
            messageCacheSlots,
        );

        const params = {
            model: useModel,
            max_tokens: maxTokens,
            system: systemBlocks.length ? systemBlocks : undefined,
            messages: anthropicMessages,
        };
        const requestTools = requestAnthropicTools(tools, chatMsgs, opts);
        if (requestTools.length) {
            // No cache_control on tools — the system BP covers tools via
            // Anthropic prefix semantics (order: tools → system → messages).
            params.tools = requestTools;
        }
        // tool_choice only when tools are actually present (Anthropic rejects
        // tool_choice without tools). 'none' rides the hard-cap final turn to
        // forbid tool USE while keeping the tools prefix stable for cache reuse.
        if (params.tools) {
            const toolChoice = toAnthropicToolChoice(opts.toolChoice);
            if (toolChoice) params.tool_choice = toolChoice;
        }
        const hasDeferredTools = Array.isArray(params.tools)
            && params.tools.some((tool) => tool?.defer_loading === true);
        // Known tool names for the shared parseSSEStream leaked-tool-call guard
        // (same guard fixes both Anthropic providers). Recovered leaked calls
        // are only synthesized when they name a tool actually offered here.
        const knownToolNames = new Set(
            (Array.isArray(params.tools) ? params.tools : [])
                .map((t) => (t && typeof t.name === 'string' ? t.name : null))
                .filter(Boolean),
        );
        applyAnthropicEffortToBody(params, {
            model: useModel,
            opts,
            maxTokens,
            clampThinkingBudgetTokens,
            logTag: this.name,
        });
        // Fast mode → speed: "fast" on models Anthropic marks as speed-capable.
        // Suppressed while the fast capacity pool is cooling down.
        if (opts.fast === true && supportsAnthropicFastMode(useModel) && fastModeAvailable()) {
            params.speed = 'fast';
            this.fastModeBetaHeaderLatched = true;
        }
        // NOTE: do NOT sanitize here. params.messages was already sanitized
        // once inside toAnthropicMessages and then had cache markers applied.
        // Re-sanitizing after marking could drop/reorder a marked block and
        // move the provider-visible cache breakpoint off the cached one — the
        // exact COLD-turn bug this change fixes. Order: build → sanitize
        // (once) → mark → send.
        params.stream = true;

        const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;
        const onTextReset = typeof opts.onTextReset === 'function' ? opts.onTextReset : null;

        // No absolute wall-clock cap on streaming generation: a stream still
        // emitting SSE deltas must not be killed by a fixed total-lifetime timer.
        // Mirrors the OAuth provider (Option A). Bounded instead by the
        // per-attempt first-byte/HTTP-response timeout, the SSE idle watchdog,
        // the agent stall watchdog, and externalSignal (client disconnect /
        // replaced-by-newer-request). totalSignal is a pure pass-through.
        const externalSignal = opts.signal || null;
        const totalTimeout = createPassthroughSignal(externalSignal);
        const totalSignal = totalTimeout.signal;

        const cleanupCancelHandler = (handler) => {
            if (!handler) return;
            try { totalSignal.removeEventListener('abort', handler); } catch {}
        };

        // Per-call headers override the client defaultHeaders, so the
        // constructor-level disableBetaHeaders opt-out must be honoured here
        // too — otherwise opencode-go's anthropic-compatible routing
        // (disableBetaHeaders:true) would still send beta strings that a
        // third-party endpoint may reject.
        const betaHeaders = this.config?.disableBetaHeaders
            ? null
            : {
                'anthropic-beta': buildAnthropicBetaHeaders({
                    fastMode: this.fastModeBetaHeaderLatched,
                    toolSearch: hasDeferredTools,
                    effort: shouldIncludeEffortBeta(useModel, opts),
                }),
            };

        const MAX_MIDSTREAM_RETRIES = ANTHROPIC_MAX_MIDSTREAM_RETRIES;
        let firstAttemptError = null;
        let firstAttemptClassifier = null;
        // Shared logical-send window: provider fallback and loop replay consume
        // the same recovery budget.
        const stallRetryBudget = resolveStallRetryBudget(opts);
        const requireTransportRecoveryBudget = (error, controller) => {
            if (stallRetryBudget.allowStallRetry()) return;
            try {
                process.stderr.write(
                    `[${this.name}] transport recovery budget exhausted (${STREAM_STALL_RETRY_BUDGET_MS}ms since first failure)\n`,
                );
            } catch {}
            try { controller?.abort?.(error); } catch {}
            throw error;
        };

        const buildReturnFromParse = (parseResult) => {
            const usageRaw = parseResult.usage?.raw || null;
            const input = parseResult.usage?.inputTokens || 0;
            const cacheRead = parseResult.usage?.cachedTokens || 0;
            const cacheWrite = parseResult.usage?.cacheWriteTokens || 0;
            const output = parseResult.usage?.outputTokens || 0;
            const promptTokens = parseResult.usage?.promptTokens ?? (input + cacheRead + cacheWrite);
            const liveModel = parseResult.model || useModel;

            if (usageRaw || input || output || cacheRead || cacheWrite) {
                traceAgentUsage({
                    sessionId: opts.sessionId || opts.session?.id || null,
                    iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
                    inputTokens: input,
                    outputTokens: output,
                    cachedTokens: cacheRead,
                    cacheWriteTokens: cacheWrite,
                    promptTokens,
                    model: liveModel,
                    modelDisplay: liveModel,
                    responseId: null,
                    rawUsage: usageRaw,
                    provider: this.name,
                    requestKind: opts.requestKind || null,
                    // Anthropic usage is additive at this inner transport
                    // boundary, even when OpenCode Go supplies the provider id.
                    inputTokensInclusive: false,
                });
            }

            return {
                content: parseResult.content || '',
                model: liveModel,
                toolCalls: parseResult.toolCalls,
                stopReason: parseResult.stopReason || null,
                hasThinkingContent: !!parseResult.hasThinkingContent,
                contentBlockTypes: Array.isArray(parseResult.contentBlockTypes)
                    ? parseResult.contentBlockTypes
                    : [],
                // Round-trip adaptive-thinking blocks (verbatim thinking +
                // signature) so the loop can store them and replay them before
                // tool_use on the next turn. Matches anthropic-oauth's return.
                thinkingBlocks: Array.isArray(parseResult.thinkingBlocks) && parseResult.thinkingBlocks.length
                    ? parseResult.thinkingBlocks
                    : undefined,
                // Ordered NATIVE server-tool blocks (server_tool_use +
                // *_tool_result) exist ONLY in this verbatim list — they are
                // never dispatched as client tool calls and cannot be rebuilt
                // from content/toolCalls/thinkingBlocks. Dropping them here
                // broke `pause_turn` continuations on the API-key path (the
                // OAuth provider returns the parse result as-is). Absent for
                // ordinary turns, so nothing else changes.
                assistantBlocks: Array.isArray(parseResult.assistantBlocks) && parseResult.assistantBlocks.length
                    ? parseResult.assistantBlocks
                    : undefined,
                usage: {
                    inputTokens: input,
                    outputTokens: output,
                    cachedTokens: cacheRead,
                    cacheWriteTokens: cacheWrite,
                    promptTokens,
                },
            };
        };

        // Core non-streaming re-issue shared by the exposed-text recovery
        // (onTextReset-gated) and the no-exposure stall fallback (trivially
        // safe — nothing was relayed or dispatched). Mirrors anthropic-oauth.
        const issueNonStreamingFallback = async (streamController, abortReason) => {
            try { streamController.abort?.(abortReason); } catch {}
            try { onStageChange?.('requesting', { transport: 'non-streaming-fallback' }); } catch {}
            const nonStreamingParams = { ...params, stream: false };
            const timeoutMs = Number(opts._nonStreamingTimeoutMs) > 0
                ? Number(opts._nonStreamingTimeoutMs)
                : PROVIDER_NONSTREAM_TOTAL_TIMEOUT_MS;
            const lifetime = createTimeoutSignal(
                totalSignal,
                timeoutMs,
                `${this.name} Anthropic non-streaming fallback`,
            );
            try {
                const message = await withRetry(
                    async ({ signal: attemptSignal }) => this.client.messages.create(nonStreamingParams, {
                        signal: attemptSignal,
                        ...(betaHeaders ? { headers: betaHeaders } : {}),
                    }),
                    {
                        signal: lifetime.signal,
                        maxAttempts: anthropicMaxAttempts(),
                        backoffMs: ANTHROPIC_RETRY_BACKOFF_MS,
                        retryJitterRatio: ANTHROPIC_RETRY_JITTER_RATIO,
                        retryJitterMode: 'positive',
                        perAttemptTimeoutMs: anthropicRequestTimeoutMs(),
                        perAttemptLabel: `${this.name} Anthropic non-streaming fallback`,
                        provider: 'anthropic',
                        model: useModel,
                        fallbackModel: opts._fallbackTriggered ? undefined : opts.fallbackModel,
                    },
                );
                return buildReturnFromParse(normalizeAnthropicNonStreamingResponse(message, useModel));
            } finally {
                lifetime.cleanup();
            }
        };

        const recoverNonStreaming = async (midState, streamingError, streamController) => {
            const exposedChars = Number(midState?.emittedTextChars) || 0;
            if (!onTextReset || exposedChars <= 0
                || midState.emittedToolCall || midState.partialToolCall || midState.emittedThinking) {
                try { streamingError.liveTextEmitted = true; streamingError.unsafeToRetry = true; } catch {}
                throw streamingError;
            }
            let resetAccepted = false;
            try {
                resetAccepted = await onTextReset({
                    chars: exposedChars,
                    reason: 'anthropic-streaming-fallback',
                }) === true;
            } catch {}
            if (!resetAccepted) {
                try { streamingError.liveTextEmitted = true; streamingError.unsafeToRetry = true; } catch {}
                throw streamingError;
            }
            requireTransportRecoveryBudget(streamingError, streamController);
            return issueNonStreamingFallback(streamController, streamingError);
        };

        try {
            for (let attemptIndex = 0; attemptIndex <= MAX_MIDSTREAM_RETRIES; attemptIndex++) {
                const streamController = createAbortController();
                let cancelHandler = null;

                if (totalSignal) {
                    if (totalSignal.aborted) {
                        const reason = totalSignal.reason;
                        throw reason instanceof Error
                            ? reason
                            : new Error('Anthropic request aborted');
                    }
                    cancelHandler = () => {
                        try { streamController.abort(totalSignal.reason); } catch {}
                    };
                    totalSignal.addEventListener('abort', cancelHandler, { once: true });
                }

                const midState = {
                    attemptIndex,
                    sawMessageStart: false,
                    sawCompleted: false,
                    emittedToolCall: false,
                    partialToolCall: false,
                    emittedThinking: false,
                    // Gateway live-text relay invariant: set by parseSSEStream
                    // once a non-empty text chunk has been forwarded. A later
                    // failure is non-retryable (rendered text cannot be
                    // withdrawn; a retry would concatenate attempts).
                    emittedText: false,
                    userAbort: false,
                    watchdogAbort: null,
                };

                let firstBytePoll = null;
                let firstByteTimeout = null;
                let response = null;

                try {
                    try { onStageChange?.('requesting'); } catch {}

                    response = await withRetry(
                        async ({ signal: attemptSignal }) => {
                            const res = await this.client.messages.create(params, {
                                signal: attemptSignal,
                                ...(betaHeaders ? { headers: betaHeaders } : {}),
                            }).asResponse();
                            if (!res.ok) {
                                const text = await res.text().catch(() => '');
                                const err = new Error(`Anthropic API ${res.status}: ${text.slice(0, 200)}`);
                                err.status = res.status;
                                err.httpStatus = res.status;
                                err.initialResponseError = true;
                                // Carry response headers so withRetry can honor a
                                // short Retry-After and upstream can read quota hints.
                                err.headers = res.headers;
                                err.response = { status: res.status, headers: res.headers };
                                // This is an initial-response 429, before SSE
                                // output/tool exposure, so the request-local
                                // withRetry loop may retry it with jitter.
                                if (res.status === 429) {
                                    const retryAfterMs = retryAfterMsFromError({ headers: res.headers, response: { headers: res.headers } });
                                    err.name = 'ProviderQuotaError';
                                    err.code = 'PROVIDER_QUOTA';
                                    err.retryAfterMs = retryAfterMs;
                                    err.providerQuota = true;
                                    err.quotaExceeded = true;
                                }
                                throw err;
                            }
                            if (!res.body) {
                                throw new Error('Anthropic streaming response has no body');
                            }
                            return res;
                        },
                        {
                            signal: totalSignal,
                            maxAttempts: anthropicMaxAttempts(),
                            backoffMs: ANTHROPIC_RETRY_BACKOFF_MS,
                            retryJitterRatio: ANTHROPIC_RETRY_JITTER_RATIO,
                            retryJitterMode: 'positive',
                            perAttemptTimeoutMs: anthropicRequestTimeoutMs(),
                            perAttemptLabel: `${this.name} Anthropic streaming response`,
                            provider: 'anthropic',
                            model: useModel,
                            fallbackModel: opts._fallbackTriggered ? undefined : opts.fallbackModel,
                            onRetry: ({ attempt, lastErr, delayMs, delayReason }) => {
                                // Long/unknown fast-pool window: replay at
                                // standard speed rather than waiting it out.
                                if (params?.speed === 'fast'
                                    && noteFastModeCapacityError(lastErr, { fast: true }) !== 'retry-fast') {
                                    delete params.speed;
                                }
                                const status = Number(lastErr?.httpStatus || lastErr?.status || lastErr?.response?.status || 0);
                                if (status === 429) notifyCurrentAnthropicRateLimit(lastErr);
                                const delayLabel = Number.isFinite(Number(delayMs))
                                    ? `, delay ${delayMs}ms${delayReason ? ` (${delayReason})` : ''}`
                                    : '';
                                process.stderr.write(
                                    `[${this.name}] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}${delayLabel}\n`,
                                );
                            },
                        },
                    );

                    try { onStageChange?.('streaming'); } catch {}

                    firstByteTimeout = createTimeoutSignal(
                        streamController.signal,
                        PROVIDER_FIRST_BYTE_TIMEOUT_MS,
                        'Anthropic SSE first byte',
                    );
                    firstByteTimeout.signal.addEventListener('abort', () => {
                        if (!midState.sawMessageStart) {
                            try { streamController.abort(firstByteTimeout.signal.reason); } catch {}
                        }
                    }, { once: true });

                    firstBytePoll = setInterval(() => {
                        if (midState.sawMessageStart) {
                            firstByteTimeout?.cleanup();
                            clearInterval(firstBytePoll);
                            firstBytePoll = null;
                        }
                    }, 25);

                    const parseResult = await parseSSEStream(
                        response,
                        streamController.signal,
                        (reason) => streamController.abort(reason),
                        onStreamDelta,
                        onToolCall,
                        midState,
                        onTextDelta,
                        knownToolNames,
                    );
                    try { streamController.abort?.('Anthropic SSE complete'); } catch {}

                    if (firstBytePoll) {
                        clearInterval(firstBytePoll);
                        firstBytePoll = null;
                    }
                    firstByteTimeout?.cleanup();

                    if (!midState.sawMessageStart
                        && !midState.userAbort
                        && !midState.watchdogAbort
                        && !parseResult.content
                        && !(parseResult.toolCalls && parseResult.toolCalls.length)
                        && !(parseResult.usage && parseResult.usage.inputTokens > 0)) {
                        const emptyErr = new Error(
                            'Anthropic SSE stream produced no message_start (empty/dropped stream — likely transient or rate-limited)',
                        );
                        emptyErr.code = 'EEMPTYSTREAM';
                        emptyErr.isEmptyStream = true;
                        throw emptyErr;
                    }

                    return buildReturnFromParse(parseResult);
                } catch (err) {
                    if (err instanceof AnthropicFallbackTriggeredError) {
                        process.stderr.write(`[${this.name}] ${err.message}\n`);
                        return this._doSend(messages, err.fallbackModel, tools, {
                            ...opts,
                            fallbackModel: undefined,
                            _fallbackTriggered: true,
                        });
                    }
                    // Canonical stream-outcome contract (same record as the
                    // OAuth SSE / WS / HTTP-SSE transports). The parser verdict
                    // wins over coarse midState flags; new wrapper-observed
                    // exposure is still merged. Aliases preserved.
                    let _outcome = null;
                    try {
                        _outcome = stampAnthropicStreamOutcome(err, midState, { provider: 'anthropic' });
                    } catch { /* stamping is best-effort */ }
                    // Acknowledged reset semantics let the owner tombstone this
                    // attempt before the full request is restarted non-streaming.
                    // Without that acknowledgement, recoverNonStreaming stamps
                    // the error unsafe and preserves the no-concatenation rule.
                    if (midState.emittedText) {
                        return await recoverNonStreaming(midState, err, streamController);
                    }
                    // Real exposure (dispatched tool, exposed thinking, or a
                    // parser-recorded started/complete call) is a replay
                    // boundary. The canonical merge above already recorded it
                    // AND wrote the compatibility aliases; writing coarse
                    // midState flags here would DOWNGRADE the parser's
                    // authoritative verdict that an incomplete, never
                    // dispatched tool input is still replay-safe.
                    if (_outcome?.replayUnsafe === true) {
                        try { streamController.abort?.(err); } catch {}
                        throw err;
                    }
                    // withRetry already exhausted the full request-level budget.
                    // Do not accidentally grant an additional SSE retry budget
                    // to an initial HTTP 429 that never produced a stream.
                    if (err?.initialResponseError) throw err;
                    if (err?.isEmptyStream && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                        firstAttemptError = err;
                        firstAttemptClassifier = 'empty_stream';
                        try { streamController.abort?.(err); } catch {}
                        try {
                            process.stderr.write(
                                `[${this.name}] empty stream (no message_start) — retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES}\n`,
                            );
                        } catch {}
                        await _midstreamSleepWithAbort(midstreamBackoffFor(attemptIndex + 1), totalSignal);
                        continue;
                    }
                    if (classifyError(err) === 'transient'
                        && !midState.sawMessageStart
                        && _outcome?.replayUnsafe !== true
                        && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                        firstAttemptError = err;
                        firstAttemptClassifier = err?.providerErrorType || 'sse_transient';
                        try { streamController.abort?.(err); } catch {}
                        try {
                            process.stderr.write(
                                `[${this.name}] transient SSE error — retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES} (${err?.providerErrorType || err?.message || 'unknown'})\n`,
                            );
                        } catch {}
                        await _midstreamSleepWithAbort(midstreamBackoffFor(attemptIndex + 1), totalSignal);
                        continue;
                    }
                    if ((err?.truncatedStream === true || err?.code === 'TRUNCATED_STREAM')
                        && classifyError(err) === 'transient'
                        && _outcome?.replayUnsafe !== true
                        && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                        firstAttemptError = err;
                        firstAttemptClassifier = 'truncated_stream';
                        try { streamController.abort?.(err); } catch {}
                        try {
                            process.stderr.write(
                                `[${this.name}] truncated stream — retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES}\n`,
                            );
                        } catch {}
                        await _midstreamSleepWithAbort(midstreamBackoffFor(attemptIndex + 1), totalSignal);
                        continue;
                    }
                    const classifier = _classifyMidstreamError(err, midState);
                    // Stall recovery (shared with anthropic-oauth,
                    // 2026-08-03): a stalled stream that exposed NOTHING is
                    // re-issued non-streaming instead of retrying the same
                    // streaming shape into the same idle window. Replay is
                    // trivially safe — nothing was relayed or dispatched.
                    if (classifier === 'stream_stalled'
                        && _outcome?.replayUnsafe !== true
                        && !midState.emittedText
                        && !midState.emittedToolCall
                        && !midState.partialToolCall
                        && !midState.emittedThinking) {
                        requireTransportRecoveryBudget(err, streamController);
                        try { process.stderr.write(`[${this.name}] stream stalled with no exposure — retrying non-streaming\n`); } catch {}
                        return await issueNonStreamingFallback(streamController, err);
                    }
                    if (classifier === 'stream_stalled') {
                        requireTransportRecoveryBudget(err, streamController);
                    }
                    if (classifier && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                        firstAttemptError = err;
                        firstAttemptClassifier = classifier;
                        const status = Number(err?.httpStatus || err?.status || 0);
                        let retryDelayMs = null;
                        if (status === 429) {
                            if (!err.headers && response?.headers) err.headers = response.headers;
                            if (!err.response && response) err.response = { status, headers: response.headers };
                            retryDelayMs = retryAfterMsFromError(err);
                            if (retryDelayMs != null) err.retryAfterMs = retryDelayMs;
                            notifyCurrentAnthropicRateLimit(err);
                        }
                        try { streamController.abort?.(err); } catch {}
                        try {
                            process.stderr.write(
                                `[${this.name}] mid-stream recovered: retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES} (cause: ${classifier})\n`,
                            );
                        } catch {}
                        await _midstreamSleepWithAbort(
                            retryDelayMs ?? midstreamBackoffFor(attemptIndex + 1),
                            totalSignal,
                        );
                        continue;
                    }
                    if (attemptIndex > 0 && firstAttemptError) {
                        try { err.midstreamRetries = attemptIndex; } catch {}
                        try { err.midstreamClassifier = firstAttemptClassifier; } catch {}
                        throw err;
                    }
                    throw err;
                } finally {
                    if (firstBytePoll) clearInterval(firstBytePoll);
                    firstByteTimeout?.cleanup();
                    cleanupCancelHandler(cancelHandler);
                }
            }
            throw firstAttemptError || new Error('Anthropic mid-stream retry: unreachable');
        } finally {
            totalTimeout.cleanup();
        }
    }
    async listModels() {
        const apiKey = this.apiKey || this.config?.apiKey || (this.name === 'anthropic' ? process.env.ANTHROPIC_API_KEY : null);
        if (!apiKey) return MODELS;
        try {
            const base = String(this.config?.baseURL || 'https://api.anthropic.com').replace(/\/+$/, '');
            const res = await fetch(`${base}/v1/models`, {
                signal: AbortSignal.timeout(10_000),
                method: 'GET',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': ANTHROPIC_VERSION,
                    ...(this.config?.extraHeaders || {}),
                },
                dispatcher: getLlmDispatcher(),
            });
            if (!res.ok) throw new Error(`list_models ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data?.data) ? data.data : [];
            const normalized = items
                .map((m) => _normalizeAnthropicModel(m, this.name))
                .filter(Boolean);
            const enriched = sanitizeModelList(await enrichModels(normalized), { provider: this.name });
            // Feed the resolver-visible mirror so API-key-only installs get
            // catalog outputTokens without depending on the OAuth disk cache.
            if (enriched.length) _setApiKeyCatalogMirror(enriched.slice());
            return enriched.length ? enriched : MODELS;
        }
        catch (err) {
            if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[${this.name}] listModels fetch failed (${err.message})\n`);
            return MODELS;
        }
    }
    async isAvailable() {
        // Availability probes must not spend tokens or depend on a live
        // network. Dispatch owns authentication validation and 401 reload.
        return !!(this.apiKey || this.config?.apiKey
            || (this.name === 'anthropic' && process.env.ANTHROPIC_API_KEY));
    }
}
