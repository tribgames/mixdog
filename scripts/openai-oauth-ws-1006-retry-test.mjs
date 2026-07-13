// Regression: OpenAI OAuth WS abnormal-close recovery before visible output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIOAuthProvider } from '../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import { sendViaWebSocket } from '../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';

function close1006() {
    const err = new Error('WebSocket closed abnormally');
    err.wsCloseCode = 1006;
    return err;
}

function entry() {
    return { socket: { close() {} } };
}

function wsArgs(overrides = {}) {
    return {
        auth: { access_token: 'test-token' },
        body: { model: 'gpt-5.5', input: [{ role: 'user', content: 'retry me' }] },
        poolKey: 'openai-oauth-ws-1006-test',
        cacheKey: 'openai-oauth-ws-1006-test',
        useModel: 'gpt-5.5',
        _sendFrameFn: async () => {},
        _sleepFn: async () => {},
        ...overrides,
    };
}

test('pre-response 1006 opens a fresh WS and replays the same request', async () => {
    const acquires = [];
    const frames = [];
    let streams = 0;
    const result = await sendViaWebSocket(wsArgs({
        _acquireWithRetryFn: async (opts) => {
            acquires.push(opts.forceFresh);
            return { entry: entry(), reused: false };
        },
        _sendFrameFn: async (_entry, frame) => { frames.push(frame); },
        _streamFn: async () => {
            streams += 1;
            if (streams === 1) throw close1006();
            return { content: 'recovered', model: 'gpt-5.5', toolCalls: [], usage: {}, closeSocket: true };
        },
    }));

    assert.equal(result.content, 'recovered');
    assert.deepEqual(acquires, [false, true], 'retry must acquire a fresh socket');
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[1].input, frames[0].input, 'retry must replay the same input');
    assert.equal(result.__midstreamRetries, 1);
});

test('successful iteration emits one compact send-spans row', async () => {
    const rows = [];
    const result = await sendViaWebSocket(wsArgs({
        _sendSpanTraceFn: (row) => rows.push(row),
        _acquireWithRetryFn: async (opts) => {
            opts.onRetry?.({ classifier: 'timeout' });
            opts.onRetry?.({ classifier: 'timeout' });
            return { entry: entry(), reused: true };
        },
        _streamFn: async ({ state }) => {
            state.sendSpan.firstEventMs += 7;
            state.sendSpan.preResponseCreatedMs += 9;
            return { content: 'ok', model: 'gpt-5.5', toolCalls: [], usage: {}, closeSocket: true };
        },
    }));
    assert.equal(result.content, 'ok');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'send_spans');
    assert.equal(rows[0].payload.acquire_mode, 'reused');
    assert.equal(rows[0].payload.acquire_attempts, 1);
    assert.equal(rows[0].payload.handshake_retries, 2);
    assert.equal(rows[0].payload.first_event_ms, 7);
    assert.equal(rows[0].payload.pre_response_created_ms, 9);
    assert.equal('body' in rows[0].payload, false);
});

test('exhausted pre-response 1006 retries reach the HTTP/SSE fallback', async () => {
    const savedEnv = Object.fromEntries([
        'MIXDOG_OAI_TRANSPORT',
        'MIXDOG_OPENAI_HTTP_FALLBACK',
        'MIXDOG_OPENAI_OAUTH_WS_WARMUP',
        'MIXDOG_OPENAI_OAUTH_FAST_HTTP_FALLBACK',
        'MIXDOG_AGENT_TRACE_DISABLE',
    ].map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
        MIXDOG_OAI_TRANSPORT: 'auto',
        MIXDOG_OPENAI_HTTP_FALLBACK: '1',
        MIXDOG_OPENAI_OAUTH_WS_WARMUP: '0',
        MIXDOG_OPENAI_OAUTH_FAST_HTTP_FALLBACK: '0',
        MIXDOG_AGENT_TRACE_DISABLE: '1',
    });
    try {
        const provider = new OpenAIOAuthProvider({});
        provider.ensureAuth = async () => ({ access_token: 'test-token' });
        let streamAttempts = 0;
        let httpCalls = 0;
        const result = await provider.send([], 'gpt-5.5', [], {
            sessionId: 'openai-oauth-ws-1006-fallback-test',
            _prebuiltBody: { model: 'gpt-5.5', input: [], prompt_cache_key: 'openai-oauth-ws-1006-fallback-test' },
            _sendViaWebSocketFn: (args) => sendViaWebSocket({
                ...args,
                _acquireWithRetryFn: async () => ({ entry: entry(), reused: false }),
                _sendFrameFn: async () => {},
                _streamFn: async () => {
                    streamAttempts += 1;
                    throw close1006();
                },
                _sleepFn: async () => {},
            }),
            _sendViaHttpSseFn: async () => {
                httpCalls += 1;
                return { content: 'http-recovered', toolCalls: [], usage: {} };
            },
        });

        assert.equal(streamAttempts, 5, 'all bounded ws_1006 attempts must run before fallback');
        assert.equal(httpCalls, 1);
        assert.equal(result.content, 'http-recovered');
    } finally {
        for (const [name, value] of Object.entries(savedEnv)) {
            if (value == null) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('post-emission 1006 refuses replay after text or tool output', async () => {
    for (const emitted of ['emittedText', 'emittedToolCall']) {
        let acquires = 0;
        await assert.rejects(
            sendViaWebSocket(wsArgs({
                poolKey: `openai-oauth-ws-1006-${emitted}-test`,
                _acquireWithRetryFn: async () => {
                    acquires += 1;
                    return { entry: entry(), reused: false };
                },
                _streamFn: async ({ state }) => {
                    state[emitted] = true;
                    throw close1006();
                },
            })),
            (err) => err.wsCloseCode === 1006 && err.unsafeToRetry === true,
        );
        assert.equal(acquires, 1, `${emitted} must prevent a replay`);
    }
});
