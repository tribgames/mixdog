/**
 * Google Antigravity provider (Cloud Code Assist "unified gateway").
 *
 * One Google OAuth login exposes Gemini 3.x and Anthropic Claude behind a
 * single Gemini-shaped API. Message/tool conversion and SSE consumption are
 * reused from the API-key Gemini provider; only the transport differs:
 *
 *   - requests wrap the Gemini payload in { project, model, request, … }
 *   - responses nest it back under `response` (see unwrapChunk below)
 *   - the host is an IDE-internal daily/sandbox channel with a fallback chain
 *
 * Auth, endpoints, and headers live in antigravity-oauth-tokens.mjs.
 */
import { randomUUID, createHash } from 'crypto';
import { withRetry } from './retry-classifier.mjs';
import { traceAgentUsage } from '../agent-trace.mjs';
import {
    createPassthroughSignal,
    createTimeoutSignal,
} from '../stall-policy.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import {
    GEMINI_FIRST_BYTE_TIMEOUT_MS,
    createGeminiTextLeakGuard,
    consumeGeminiRestStreamResponse,
} from './gemini-stream.mjs';
import {
    toGeminiTools,
    toGeminiToolConfig,
    toGeminiContents,
    parseToolCalls,
    emitGeminiToolCalls,
    collectGeminiGroundingSources,
    parseGeminiTextPartMetadata,
} from './gemini-schema.mjs';
import {
    CONTENT_ENDPOINTS,
    ANTIGRAVITY_MODELS,
    DEFAULT_ANTIGRAVITY_MODEL,
    antigravityHeaders,
    ensureAccessToken,
    hasAntigravityOAuthCredentials,
    loadTokens,
    _scrubTokens,
} from './antigravity-oauth-tokens.mjs';

// Cloud Code Assist rejects a thinking part whose signature it cannot verify.
// Replaying our own transcript can therefore fail a turn that already
// succeeded, so signed thinking is re-stamped with the sentinel the backend
// accepts instead of being dropped (dropping breaks Claude's thinking order).
const THOUGHT_SIGNATURE_SENTINEL = 'skip_thought_signature_validator';
const CLAUDE_THINKING_BETA = 'interleaved-thinking-2025-05-14';
// Claude wire ids reject anything above this; Gemini accepts the discovered cap.
const CLAUDE_MAX_OUTPUT_TOKENS = 64000;

function isClaudeModel(model) {
    return /^claude-/i.test(String(model || ''));
}

function isGemini3Model(model) {
    return /^gemini-3/i.test(String(model || ''));
}

function antigravityError(res, text, endpoint) {
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    const detail = payload?.error || null;
    const message = detail?.message || text?.slice(0, 300) || '';
    const err = new Error(`Antigravity ${res.status} (${endpoint}): ${_scrubTokens(message)}`);
    err.status = res.status;
    err.httpStatus = res.status;
    err.headers = res.headers;
    err.initialResponseError = true;
    if (detail) {
        err.error = detail;
        err.data = payload;
        if (detail.status) err.geminiStatus = detail.status;
    }
    // Account verification is terminal and actionable: surface the URL Google
    // returns instead of a raw API body the user cannot act on.
    const validationUrl = /https:\/\/\S*(?:accounts|console)\.google\.com\/\S+/.exec(message || '');
    if (res.status === 403 && /VALIDATION_REQUIRED/i.test(text || '')) {
        err.message = `Antigravity requires account verification${validationUrl ? `: ${validationUrl[0]}` : ''}`;
        err.unsafeToRetry = true;
    }
    return err;
}

// Endpoint failover only makes sense when the HOST is the suspect. A
// deterministic 4xx — malformed request, revoked/expired auth, permission
// denial, unknown route — and a quota decision (429) are answers from the
// account or the request itself: replaying them across every alternate host
// repeats the identical rejection, hides the real error behind the last host's
// message, and can duplicate an accepted-but-throttled generation. Only 5xx and
// transport-level failures (status 0: DNS/connect/TLS/timeout) fail over.
function antigravityFailoverEligible(err) {
    if (err?.unsafeToRetry === true || err?.liveTextEmitted === true || err?.emittedToolCall === true) {
        return false;
    }
    const status = Number(err?.status || err?.httpStatus || 0);
    // Strictly 5xx or transport. status 0 means no HTTP response reached us at
    // all (DNS/connect/TLS/first-byte timeout) — the only genuine "this host is
    // the problem" evidence besides a server-side 5xx. ANY other answer,
    // including a 3xx redirect the host chose to return, is that host's real
    // reply and would be reproduced identically everywhere else.
    if (status >= 500) return true;
    return status === 0;
}

// A signed decimal derived from the first user turn, mirroring the real client.
function deriveSessionId(contents) {
    const first = contents.find((c) => c?.role === 'user');
    const text = first?.parts?.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') || '';
    if (!text.trim()) return `-${randomUUID()}`;
    const digest = createHash('sha256').update(text).digest();
    return `-${digest.readBigUInt64BE(0) % 9223372036854775807n}`;
}

// Re-stamp every thinking / signed part with the sentinel the gateway accepts.
function stampThoughtSignatures(contents) {
    for (const content of contents) {
        if (content?.role !== 'model' || !Array.isArray(content.parts)) continue;
        for (const part of content.parts) {
            if (!part || typeof part !== 'object') continue;
            if (part.thought === true || typeof part.thoughtSignature === 'string') {
                part.thoughtSignature = THOUGHT_SIGNATURE_SENTINEL;
            }
        }
    }
    return contents;
}

export class AntigravityOAuthProvider {
    // usageMetadata.promptTokenCount is the total, cached tokens included.
    static inputExcludesCache = false;
    name = 'antigravity-oauth';

    constructor(config = {}) {
        this.config = config || {};
        this._fetch = typeof config.fetchFn === 'function' ? config.fetchFn : fetch;
        this._preconnect = typeof config.preconnectFn === 'function' ? config.preconnectFn : preconnect;
        // AuthStorage equivalent: refreshes the token and resolves the project.
        // Injectable so wire-shape tests do not need a real credential store.
        this._ensureAuth = typeof config.ensureAuthFn === 'function' ? config.ensureAuthFn : ensureAccessToken;
        // Remember the endpoint that last answered so a session stops paying the
        // failover cost on every turn.
        this._lastGoodEndpoint = null;
        this._preconnect(CONTENT_ENDPOINTS[0]);
    }

    _endpointOrder() {
        const configured = String(this.config.baseURL || '').trim();
        if (configured) return [configured];
        const ordered = [...CONTENT_ENDPOINTS];
        if (this._lastGoodEndpoint && ordered.includes(this._lastGoodEndpoint)) {
            return [this._lastGoodEndpoint, ...ordered.filter((e) => e !== this._lastGoodEndpoint)];
        }
        return ordered;
    }

    _buildBody(messages, model, tools, opts) {
        const systemText = messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n\n');
        const chatMessages = messages.filter((m) => m.role !== 'system');
        const contents = stampThoughtSignatures(toGeminiContents(chatMessages, model));
        if (!contents.length) throw new Error('No messages to send');

        const functionTools = tools?.length ? [toGeminiTools(tools)] : [];
        const generationConfig = {};
        if (isClaudeModel(model)) generationConfig.maxOutputTokens = CLAUDE_MAX_OUTPUT_TOKENS;
        // Omitting thinkingConfig lets the gateway re-apply its per-model default
        // and bill thinking tokens silently, so it is always explicit.
        const thinkingBudget = Number(opts?.thinkingBudget);
        if (Number.isFinite(thinkingBudget) && thinkingBudget > 0) {
            generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget };
        } else if (isGemini3Model(model) || isClaudeModel(model)) {
            generationConfig.thinkingConfig = { includeThoughts: true };
        }

        const request = { contents };
        if (systemText) {
            // The real client tags the system instruction with role "user".
            request.systemInstruction = { role: 'user', parts: [{ text: systemText }] };
        }
        if (functionTools.length) {
            request.tools = functionTools;
            // VALIDATED is the client default and keeps Gemini 3 from leaking raw
            // planning JSON instead of emitting a tool call.
            request.toolConfig = toGeminiToolConfig(opts?.toolChoice)
                || { functionCallingConfig: { mode: 'VALIDATED' } };
        }
        if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
        request.sessionId = deriveSessionId(contents);

        return {
            project: this._projectId,
            model,
            request,
            requestType: 'agent',
            userAgent: 'antigravity',
            requestId: `agent-${randomUUID()}`,
        };
    }

    async send(messages, model, tools, sendOpts = {}) {
        const opts = sendOpts || {};
        const signal = opts.signal || null;
        const useModel = model || DEFAULT_ANTIGRAVITY_MODEL;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        if (signal?.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error ? reason : new Error('Antigravity request aborted');
        }

        const auth = await this._ensureAuth({ fetchFn: this._fetch });
        this._projectId = auth.projectId;
        const body = JSON.stringify(this._buildBody(messages, useModel, tools, opts));
        const headers = {
            Authorization: `Bearer ${auth.accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            ...antigravityHeaders(),
            ...(isClaudeModel(useModel) ? { 'anthropic-beta': CLAUDE_THINKING_BETA } : {}),
        };

        let textLeakGuard = null;
        const passthrough = createPassthroughSignal(signal);
        const endpoints = this._endpointOrder();
        let lastErr = null;
        let response = null;
        // One forced token refresh per send: a second 401 after a fresh token is
        // a real authorization failure, not a stale bearer.
        let refreshedAuth = false;
        try {
            for (let index = 0; index < endpoints.length; index += 1) {
                const endpoint = endpoints[index];
                const isLast = index === endpoints.length - 1;
                try {
                    response = await withRetry(
                        async ({ signal: attemptSignal }) => {
                            try { opts.onStageChange?.('requesting'); } catch { /* heartbeat */ }
                            const firstByte = createTimeoutSignal(
                                attemptSignal,
                                GEMINI_FIRST_BYTE_TIMEOUT_MS,
                                'Antigravity first byte',
                            );
                            let res;
                            try {
                                res = await this._fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
                                    method: 'POST',
                                    headers,
                                    body,
                                    signal: firstByte.signal,
                                    dispatcher: getLlmDispatcher(),
                                });
                            } finally {
                                firstByte.cleanup();
                            }
                            if (!res.ok) {
                                const text = await res.text().catch(() => '');
                                throw antigravityError(res, text, endpoint);
                            }
                            textLeakGuard = createGeminiTextLeakGuard({
                                knownToolNames: tools?.map((t) => t.name).filter(Boolean) ?? [],
                                onTextDelta,
                                onToolCall,
                                onStreamDelta,
                            });
                            return await consumeGeminiRestStreamResponse(res, {
                                signal: attemptSignal,
                                onStreamDelta,
                                onTextDelta,
                                textLeakGuard,
                                label: 'Antigravity streamGenerateContent',
                                // Cloud Code Assist nests the Gemini payload under
                                // `response`; in-band error events stay top level.
                                unwrapChunk: (chunk) => (chunk && typeof chunk === 'object' && chunk.response
                                    ? chunk.response
                                    : chunk),
                            });
                        },
                        {
                            signal: passthrough.signal,
                            // Only the final endpoint is worth backing off on. An
                            // earlier one that fails is more likely down than busy,
                            // so spend the attempt on the alternate host instead.
                            ...(isLast ? {} : { maxAttempts: 1 }),
                            onRetry: ({ attempt, lastErr: retryErr }) => {
                                try { opts.onStageChange?.('requesting'); } catch { /* heartbeat */ }
                                process.stderr.write(`[antigravity] retry ${attempt + 1} after ${retryErr?.message || 'transient error'}\n`);
                            },
                        },
                    );
                    this._lastGoodEndpoint = endpoint;
                    break;
                } catch (err) {
                    lastErr = err;
                    const status = Number(err?.status || err?.httpStatus || 0);
                    const emitted = err?.unsafeToRetry === true
                        || err?.liveTextEmitted === true
                        || err?.emittedToolCall === true;
                    // A typed 401 says THIS access token is no longer accepted —
                    // every host would reject it identically. Force one
                    // credential refresh and replay the same endpoint instead of
                    // failing over with the same dead token (and instead of
                    // surfacing a re-login prompt for a token that only needed a
                    // refresh). shouldRefresh() alone never covers this: a
                    // server-side revocation/rotation happens while the local
                    // expiry still looks valid.
                    if (status === 401 && !emitted && !refreshedAuth) {
                        refreshedAuth = true;
                        let refreshed = null;
                        try {
                            refreshed = await this._ensureAuth({ fetchFn: this._fetch, force: true });
                        } catch {
                            // Refresh itself failed (revoked / no refresh token):
                            // the original 401 is the actionable error.
                            throw err;
                        }
                        // refreshTokens() preserves project_id/email, so only the
                        // bearer changes; the already-serialized body stays valid.
                        this._projectId = refreshed.projectId;
                        headers.Authorization = `Bearer ${refreshed.accessToken}`;
                        textLeakGuard = null;
                        process.stderr.write('[antigravity] 401 — refreshed credentials and retrying once\n');
                        index -= 1;
                        continue;
                    }
                    // Anything already streamed to the user must not be replayed on
                    // another endpoint, and a terminal decision is not transport luck.
                    if (isLast || !antigravityFailoverEligible(err)) {
                        throw err;
                    }
                    process.stderr.write(`[antigravity] ${endpoint} failed (${err?.message || err}); trying next endpoint\n`);
                    textLeakGuard = null;
                }
            }
        } finally {
            passthrough.cleanup();
        }
        if (!response) throw lastErr || new Error('Antigravity returned no response');

        const candidate = response.candidates?.[0] || null;
        const responseParts = candidate?.content?.parts ?? [];
        const textParts = responseParts.filter((p) => p?.thought !== true && 'text' in p);
        const rawContent = textParts.map((p) => ('text' in p ? p.text : '')).join('');
        const providerMetadata = parseGeminiTextPartMetadata(responseParts);
        const content = textLeakGuard?.enabled
            ? textLeakGuard.scrubAssistantText(rawContent)
            : rawContent;
        const leakedToolCalls = textLeakGuard?.getLeakedToolCalls() ?? [];
        let nativeToolCalls = parseToolCalls(responseParts);
        if (textLeakGuard?.enabled) nativeToolCalls = textLeakGuard.filterNativeToolCalls(nativeToolCalls);
        let toolCalls = nativeToolCalls;
        if (leakedToolCalls.length) {
            toolCalls = toolCalls?.length ? [...toolCalls, ...leakedToolCalls] : leakedToolCalls;
        }
        const citations = collectGeminiGroundingSources(candidate);
        emitGeminiToolCalls(nativeToolCalls, onToolCall);

        const promptBlockReason = response.promptFeedback?.blockReason || null;
        const finishReason = candidate?.finishReason || (promptBlockReason ? `PROMPT_${promptBlockReason}` : null);
        const normalizedFinish = String(finishReason || '').replace(/^FINISH_REASON_/, '');
        if (finishReason && normalizedFinish !== 'STOP') {
            throw Object.assign(new Error(`Antigravity response incomplete: finishReason=${finishReason}`), {
                name: 'ProviderIncompleteError',
                code: 'PROVIDER_INCOMPLETE',
                providerIncomplete: true,
                finishReason,
                partialContent: content,
                partialToolCalls: toolCalls,
                providerMetadata,
                model: useModel,
                rawUsage: response.usageMetadata || null,
            });
        }

        const um = response.usageMetadata || null;
        let usage;
        if (um) {
            const inputTokens = um.promptTokenCount || um.prompt_token_count || 0;
            const cachedTokens = um.cachedContentTokenCount || um.cached_content_token_count || 0;
            const outputTokens = (um.candidatesTokenCount || um.candidates_token_count || 0)
                + (um.thoughtsTokenCount || um.thoughts_token_count || 0);
            usage = { inputTokens, outputTokens, cachedTokens, promptTokens: inputTokens };
            traceAgentUsage({
                sessionId: opts.sessionId || opts.session?.id || null,
                iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
                inputTokens,
                outputTokens,
                cachedTokens,
                cacheWriteTokens: 0,
                promptTokens: inputTokens,
                model: useModel,
                modelDisplay: useModel,
                rawUsage: um,
                provider: 'antigravity-oauth',
            });
        }

        return {
            content,
            model: useModel,
            toolCalls,
            citations: citations.length ? citations : undefined,
            providerMetadata,
            providerState: opts.providerState,
            usage,
        };
    }

    // The gateway publishes no public catalog endpoint, so the curated list in
    // the tokens module is the source of truth.
    async listModels() {
        return ANTIGRAVITY_MODELS;
    }

    async isAvailable() {
        try {
            if (!hasAntigravityOAuthCredentials()) return false;
            return Boolean(loadTokens()?.project_id);
        } catch {
            return false;
        }
    }
}

export {
    hasAntigravityOAuthCredentials,
    describeAntigravityOAuthCredentials,
    forgetAntigravityOAuthCredentials,
} from './antigravity-oauth-tokens.mjs';
export { beginOAuthLogin, loginOAuth } from './antigravity-oauth-login.mjs';