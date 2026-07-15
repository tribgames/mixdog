import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ANTHROPIC_RETRY_BACKOFF_MS,
    ANTHROPIC_RETRY_JITTER_RATIO,
    AnthropicFallbackTriggeredError,
    anthropicMaxAttempts,
    anthropicRequestTimeoutMs,
    classifyError,
    classifyMidstreamError,
    MAX_SAFE_TIMEOUT_MS,
    MIDSTREAM_RETRY_POLICY,
    withRetry,
} from '../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';
import { _midstreamSleepWithAbort, parseSSEStream } from '../src/runtime/agent/orchestrator/providers/anthropic-sse.mjs';
import { AnthropicProvider } from '../src/runtime/agent/orchestrator/providers/anthropic.mjs';
import { AnthropicOAuthProvider } from '../src/runtime/agent/orchestrator/providers/anthropic-oauth.mjs';

test('Anthropic transport classifier covers every 5xx, 529, and nested connection errno', () => {
    for (const status of [500, 501, 505, 529, 599]) {
        assert.equal(classifyError({ status }), 'transient');
    }
    assert.equal(classifyError({ code: 'EWRAPPED', cause: { code: 'EUNKNOWN', cause: { code: 'ECONNRESET' } } }), 'transient');
    assert.equal(classifyError({ name: 'APIConnectionError' }), 'transient');
    assert.equal(classifyError({ code: 'TRUNCATED_STREAM', partialToolCall: true }), 'permanent');
    assert.equal(classifyError({ code: 'TRUNCATED_STREAM', emittedThinking: true }), 'permanent');
    assert.equal(classifyError({ status: 403 }), 'auth');
    assert.equal(classifyError({ code: 'TRUNCATED_STREAM', status: 401 }), 'auth');
    assert.equal(classifyError(Object.assign(new Error('canceled'), {
        name: 'AbortError',
        cause: { code: 'ECONNRESET' },
    })), 'permanent');
    assert.equal(classifyError({ status: 418, cause: { code: 'ECONNRESET' } }), 'permanent');
    assert.equal(classifyError({ status: 409, cause: { code: 'EUNKNOWN' } }), 'transient');

    const sdkAbort = Object.assign(new Error('Request was aborted.'), {
        cause: { code: 'ECONNRESET' },
    });
    Object.defineProperty(sdkAbort, 'constructor', { value: { name: 'APIUserAbortError' } });
    assert.equal(sdkAbort.name, 'Error');
    assert.equal(classifyError(sdkAbort), 'permanent');
    assert.equal(classifyError({
        name: 'Error',
        type: 'api_user_abort_error',
        cause: { code: 'ECONNRESET' },
    }), 'permanent');
    assert.equal(classifyError({
        name: 'Error',
        message: 'Request was aborted.',
        cause: { code: 'ECONNRESET' },
    }), 'transient', 'abort-like message alone is not an SDK type marker');

    const cyclicA = { code: 'EWRAPPED' };
    const cyclicB = { code: 'EUNKNOWN', cause: cyclicA };
    cyclicA.cause = cyclicB;
    assert.equal(classifyError(cyclicA), 'unknown');
    cyclicB.code = 'ECONNRESET';
    assert.equal(classifyError(cyclicA), 'transient');
});

test('API-key Anthropic reloads typed 401 once while ordinary 403 is terminal', async () => {
    const provider401 = Object.create(AnthropicProvider.prototype);
    let attempts401 = 0;
    let reloads401 = 0;
    provider401._doSend = async () => {
        attempts401 += 1;
        if (attempts401 === 1) throw Object.assign(new Error('typed auth'), { status: 401 });
        return 'ok';
    };
    provider401.reloadApiKey = () => { reloads401 += 1; };
    assert.equal(await provider401.send([], 'claude', [], {}), 'ok');
    assert.equal(attempts401, 2);
    assert.equal(reloads401, 1);

    const provider403 = Object.create(AnthropicProvider.prototype);
    let attempts403 = 0;
    let reloads403 = 0;
    const forbidden = Object.assign(new Error('ordinary forbidden'), { status: 403 });
    provider403._doSend = async () => { attempts403 += 1; throw forbidden; };
    provider403.reloadApiKey = () => { reloads403 += 1; };
    await assert.rejects(provider403.send([], 'claude', [], {}), (err) => err === forbidden);
    assert.equal(attempts403, 1);
    assert.equal(reloads403, 0);

    for (const marker of ['partialToolCall', 'emittedThinking']) {
        const provider = Object.create(AnthropicProvider.prototype);
        let attempts = 0;
        let reloads = 0;
        const exposed401 = Object.assign(new Error(`401 after ${marker}`), {
            status: 401,
            [marker]: true,
        });
        provider._doSend = async () => { attempts += 1; throw exposed401; };
        provider.reloadApiKey = () => { reloads += 1; };
        await assert.rejects(provider.send([], 'claude', [], {}), (err) => err === exposed401);
        assert.equal(attempts, 1, `${marker} must prevent 401 replay`);
        assert.equal(reloads, 0, `${marker} must prevent key reload`);
    }
});

test('permanent quota 429 is not retried by the generic rate-limit path', async () => {
    let attempts = 0;
    const quota = new Error('request failed: insufficient_quota');
    await assert.rejects(withRetry(async () => {
        attempts += 1;
        throw quota;
    }, { maxAttempts: 3, backoffMs: [0], retryJitterRatio: 0 }), (err) => err === quota);
    assert.equal(attempts, 1);
    assert.equal(classifyError(quota), 'permanent');
});

test('structured and nested permanent quota codes are terminal; rate-limit codes retry', async () => {
    const terminalCases = [
        Object.assign(new Error('generic 429'), { status: 429, code: 'insufficient_quota' }),
        Object.assign(new Error('generic 429'), { status: 429, error: { code: 'quota_exceeded' } }),
        Object.assign(new Error('generic 429'), {
            status: 429,
            cause: { code: 'EWRAPPED', cause: { error: { code: 'resource_exhausted' } } },
        }),
    ];
    for (const quota of terminalCases) {
        let attempts = 0;
        await assert.rejects(withRetry(async () => {
            attempts += 1;
            throw quota;
        }, { maxAttempts: 2, backoffMs: [0], retryJitterRatio: 0 }), (err) => err === quota);
        assert.equal(attempts, 1);
    }

    for (const code of ['rate_limit_error', 'rate_limit_exceeded']) {
        let attempts = 0;
        const result = await withRetry(async () => {
            attempts += 1;
            if (attempts === 1) throw Object.assign(new Error('generic 429'), { status: 429, code });
            return 'recovered';
        }, { maxAttempts: 2, backoffMs: [0], retryJitterRatio: 0 });
        assert.equal(result, 'recovered');
        assert.equal(attempts, 2);
    }
});

test('partial tool/thinking markers veto every request retry path, including 429', async () => {
    for (const status of [429, 529]) {
        for (const marker of ['partialToolCall', 'emittedThinking']) {
            let attempts = 0;
            const exposed = Object.assign(new Error(`${status} after ${marker}`), {
                status,
                [marker]: true,
            });
            await assert.rejects(withRetry(async () => {
                attempts += 1;
                throw exposed;
            }, {
                maxAttempts: 4,
                backoffMs: [0],
                retryJitterRatio: 0,
                model: 'claude-opus-primary',
                fallbackModel: 'claude-sonnet-fallback',
            }), (err) => err === exposed);
            assert.equal(attempts, 1, `${status}/${marker} must not replay`);
        }
    }
});

test('optional fallback triggers on the third 529 and never when absent', async () => {
    let attempts = 0;
    await assert.rejects(withRetry(async () => {
        attempts += 1;
        throw Object.assign(new Error('busy'), { status: 529, httpStatus: 529 });
    }, {
        maxAttempts: 5,
        backoffMs: [0],
        retryJitterRatio: 0,
        model: 'claude-opus-primary',
        fallbackModel: 'claude-sonnet-fallback',
    }), (err) => (
        err instanceof AnthropicFallbackTriggeredError
        && err.originalModel === 'claude-opus-primary'
        && err.fallbackModel === 'claude-sonnet-fallback'
    ));
    assert.equal(attempts, 3);

    attempts = 0;
    await assert.rejects(withRetry(async () => {
        attempts += 1;
        throw Object.assign(new Error('overloaded without fallback'), { status: 529 });
    }, {
        maxAttempts: 4,
        backoffMs: [0],
        retryJitterRatio: 0,
        model: 'claude-opus-primary',
    }), /without fallback/);
    assert.equal(attempts, 4);
});

function successfulAnthropicResponse(content = 'fallback-ok') {
    const bytes = new TextEncoder().encode([
        { type: 'message_start', message: { model: 'claude-sonnet-fallback', usage: { input_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    let sent = false;
    return {
        ok: true,
        status: 200,
        headers: new Map(),
        body: { getReader: () => ({
            async read() {
                if (sent) return { done: true };
                sent = true;
                return { done: false, value: bytes };
            },
            async cancel() {},
            releaseLock() {},
        }) },
    };
}

test('OAuth and API-key providers switch to the opt-in fallback after three 529s', async () => {
    const priorRetries = process.env.CLAUDE_CODE_MAX_RETRIES;
    process.env.CLAUDE_CODE_MAX_RETRIES = '2';
    try {
        const oauth = Object.create(AnthropicOAuthProvider.prototype);
        oauth.credentials = { accessToken: 'fixture', expiresAt: Date.now() + 60_000 };
        oauth.config = {};
        oauth.fastModeBetaHeaderLatched = false;
        oauth.ensureAuth = async () => oauth.credentials;
        const oauthModels = [];
        const oauthSend = AnthropicOAuthProvider.prototype.send;
        oauth.send = function (messages, model, tools, opts) {
            oauthModels.push(model);
            return oauthSend.call(this, messages, model, tools, opts);
        };
        let oauthAttempts = 0;
        const oauthResult = await oauth.send([], 'claude-opus-primary', [], {
            fallbackModel: 'claude-sonnet-fallback',
            _doRequestFn: async () => {
                oauthAttempts += 1;
                const ok = oauthAttempts > 3;
                return {
                    response: {
                        status: ok ? 200 : 529,
                        ok,
                        headers: new Map([['retry-after', '0']]),
                        async text() { return ''; },
                    },
                    controller: { abort() {} },
                    cancelHandler: null,
                };
            },
            _parseSSEFn: async () => ({
                content: 'oauth-fallback-ok',
                model: 'claude-sonnet-fallback',
                usage: {},
            }),
        });
        assert.equal(oauthResult.content, 'oauth-fallback-ok');
        assert.equal(oauthAttempts, 4);
        assert.deepEqual(oauthModels, ['claude-opus-primary', 'claude-sonnet-fallback']);

        const direct = Object.create(AnthropicProvider.prototype);
        direct.name = 'anthropic';
        direct.config = {};
        direct.fastModeBetaHeaderLatched = false;
        const directModels = [];
        const directDoSend = AnthropicProvider.prototype._doSend;
        direct._doSend = function (messages, model, tools, opts) {
            directModels.push(model);
            return directDoSend.call(this, messages, model, tools, opts);
        };
        let directAttempts = 0;
        direct.client = { messages: { create() {
            directAttempts += 1;
            return { async asResponse() {
                if (directAttempts <= 3) {
                    return { ok: false, status: 529, headers: new Map([['retry-after', '0']]), async text() { return ''; } };
                }
                return successfulAnthropicResponse('direct-fallback-ok');
            } };
        } } };
        const directResult = await direct._doSend([], 'claude-opus-primary', [], {
            fallbackModel: 'claude-sonnet-fallback',
        });
        assert.equal(directResult.content, 'direct-fallback-ok');
        assert.equal(directAttempts, 4);
        assert.deepEqual(directModels, ['claude-opus-primary', 'claude-sonnet-fallback']);
    } finally {
        if (priorRetries == null) delete process.env.CLAUDE_CODE_MAX_RETRIES;
        else process.env.CLAUDE_CODE_MAX_RETRIES = priorRetries;
    }
});

test('Anthropic retry budget defaults to ten retries and is configurable/bounded', () => {
    const prior = process.env.CLAUDE_CODE_MAX_RETRIES;
    try {
        delete process.env.CLAUDE_CODE_MAX_RETRIES;
        assert.equal(anthropicMaxAttempts(), 11);
        process.env.CLAUDE_CODE_MAX_RETRIES = '2';
        assert.equal(anthropicMaxAttempts(), 3);
        process.env.CLAUDE_CODE_MAX_RETRIES = '9999';
        assert.equal(anthropicMaxAttempts(), 101);
    } finally {
        if (prior == null) delete process.env.CLAUDE_CODE_MAX_RETRIES;
        else process.env.CLAUDE_CODE_MAX_RETRIES = prior;
    }
});

test('Anthropic request timeout and exponential backoff match Claude Code defaults', async () => {
    const priorTimeout = process.env.API_TIMEOUT_MS;
    const priorRandom = Math.random;
    try {
        delete process.env.API_TIMEOUT_MS;
        assert.equal(anthropicRequestTimeoutMs(), 600_000);
        process.env.API_TIMEOUT_MS = '123456';
        assert.equal(anthropicRequestTimeoutMs(), 123456);

        Math.random = () => 0;
        const waits = [];
        let attempts = 0;
        await assert.rejects(withRetry(async () => {
            attempts += 1;
            throw Object.assign(new Error('overloaded'), { status: 529 });
        }, {
            maxAttempts: 4,
            backoffMs: ANTHROPIC_RETRY_BACKOFF_MS,
            retryJitterRatio: ANTHROPIC_RETRY_JITTER_RATIO,
            retryJitterMode: 'positive',
            sleepFn: async (ms) => { waits.push(ms); },
        }), /overloaded/);
        assert.equal(attempts, 4);
        assert.deepEqual(waits, [500, 1000, 2000]);
    } finally {
        Math.random = priorRandom;
        if (priorTimeout == null) delete process.env.API_TIMEOUT_MS;
        else process.env.API_TIMEOUT_MS = priorTimeout;
    }
});

test('x-should-retry false vetoes retry before status defaults', async () => {
    for (const status of [429, 529]) {
        let attempts = 0;
        const denied = Object.assign(new Error(`denied ${status}`), {
            status,
            headers: new Map([['x-should-retry', 'false'], ['retry-after', '0']]),
        });
        await assert.rejects(withRetry(async () => {
            attempts += 1;
            throw denied;
        }, {
            maxAttempts: 3,
            backoffMs: [0],
            retryJitterRatio: 0,
        }), (err) => err === denied);
        assert.equal(attempts, 1);
    }
});

test('Retry-After is not capped or jittered and remains abortable', async () => {
    const ac = new AbortController();
    let observed;
    let calls = 0;
    await assert.rejects(withRetry(async () => {
        calls++;
        const err = Object.assign(new Error('busy'), {
            status: 529,
            headers: new Map([['retry-after-ms', '123456']]),
        });
        throw err;
    }, {
        maxAttempts: 2,
        signal: ac.signal,
        maxRetryAfterMs: 1,
        retryJitterRatio: 1,
        onRetry: ({ delayMs }) => {
            observed = delayMs;
            ac.abort(new Error('test stop'));
        },
    }), /test stop/);
    assert.equal(calls, 1);
    assert.equal(observed, 123456);
});

test('oversized HTTP Retry-After is chunked without Node timeout clamping', async () => {
    const chunks = [];
    let attempts = 0;
    const result = await withRetry(async () => {
        attempts += 1;
        if (attempts === 1) {
            throw Object.assign(new Error('busy'), {
                status: 429,
                headers: new Map([['retry-after-ms', '2147483648']]),
            });
        }
        return 'ok';
    }, {
        maxAttempts: 2,
        retryJitterRatio: 1,
        sleepFn: async (ms) => { chunks.push(ms); },
    });
    assert.equal(result, 'ok');
    assert.deepEqual(chunks, [MAX_SAFE_TIMEOUT_MS, 1]);
});

test('oversized Anthropic SSE Retry-After sleep uses the same safe chunks', async () => {
    const chunks = [];
    await _midstreamSleepWithAbort(
        2_147_483_648,
        null,
        async (ms) => { chunks.push(ms); },
    );
    assert.deepEqual(chunks, [MAX_SAFE_TIMEOUT_MS, 1]);
});

test('SSE retries 429/5xx before output regardless of message_start, but not partial output', () => {
    const policy = { mode: 'sse', defaultRetries: 3, perClassifierGate: false };
    const clean = { attemptIndex: 0, sawCompleted: false, sawMessageStart: false };
    assert.equal(classifyMidstreamError({ status: 429 }, clean, policy), 'http_429');
    assert.equal(classifyMidstreamError({ status: 529 }, { ...clean, sawMessageStart: true }, policy), 'http_529');
    for (const exposed of ['emittedText', 'emittedToolCall', 'partialToolCall', 'emittedThinking']) {
        assert.equal(classifyMidstreamError({ status: 529 }, { ...clean, [exposed]: true }, policy), null);
    }
    assert.equal(MIDSTREAM_RETRY_POLICY.sse.defaultRetries, 3);
});

test('successful SSE parsing cancels and releases the reader', async () => {
    const encoded = new TextEncoder().encode(
        'event: message_start\ndata: {"type":"message_start","message":{"model":"claude","usage":{}}}\n\n'
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    let reads = 0;
    let cancels = 0;
    let releases = 0;
    const response = { body: { getReader: () => ({
        read: async () => reads++ === 0 ? { done: false, value: encoded } : { done: true },
        cancel: async () => { cancels++; },
        releaseLock: () => { releases++; },
    }) } };
    const state = {};
    await parseSSEStream(response, null, () => {}, null, null, state);
    assert.equal(state.sawCompleted, true);
    assert.equal(cancels, 1);
    assert.equal(releases, 1);
});

test('pre-aborted SSE still cancels and releases its acquired reader', async () => {
    const controller = new AbortController();
    const reason = new Error('already canceled');
    controller.abort(reason);
    let cancels = 0;
    let releases = 0;
    const response = { body: { getReader: () => ({
        read: async () => ({ done: true }),
        cancel: async () => { cancels += 1; },
        releaseLock: () => { releases += 1; },
    }) } };
    await assert.rejects(
        parseSSEStream(response, controller.signal, () => {}, null, null, {}),
        (err) => err === reason,
    );
    assert.equal(cancels, 1);
    assert.equal(releases, 1);
});
