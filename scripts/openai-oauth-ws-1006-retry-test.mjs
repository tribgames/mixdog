// Regression: OpenAI OAuth WS abnormal-close recovery before visible output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OpenAIOAuthProvider } from '../src/runtime/agent/orchestrator/providers/openai-oauth.mjs';
import { _acquireWithRetry, sendViaWebSocket } from '../src/runtime/agent/orchestrator/providers/openai-oauth-ws.mjs';
import { sendViaHttpSse } from '../src/runtime/agent/orchestrator/providers/openai-oauth-http-sse.mjs';
import {
    _clearWebSocketPoolForTest,
    _closeAllPooledSockets,
    _resetOpenSocketDrainForTest,
    _seedWebSocketEntryForTest,
    _setOpenSocketForTest,
    acquireWebSocket,
    releaseWebSocket,
    _sendFrame,
} from '../src/runtime/agent/orchestrator/providers/openai-ws-pool.mjs';

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

class PoolSocket extends EventEmitter {
    constructor() {
        super();
        this.readyState = 1;
        this._socket = { ref() {}, unref() {} };
    }
    close() { this.readyState = 3; }
    ping() { queueMicrotask(() => this.emit('pong')); }
}

function poolEntry(responseId) {
    return {
        socket: new PoolSocket(),
        busy: true,
        closing: false,
        ephemeral: false,
        lastResponseId: responseId,
    };
}

test('pool release/acquire preserves latest compatible chain and auth/cache boundaries', async (t) => {
    t.after(() => _clearWebSocketPoolForTest());
    const poolKey = 'reused-session-id';
    const authA = { account_id: 'account-a', access_token: 'token-a' };
    const authB = { account_id: 'account-b', access_token: 'token-b' };
    const oldest = _seedWebSocketEntryForTest({
        poolKey, auth: authA, cacheKey: 'cache-a', entry: poolEntry('resp-old'),
    });
    const latest = _seedWebSocketEntryForTest({
        poolKey, auth: authA, cacheKey: 'cache-a', entry: poolEntry('resp-latest'),
    });
    const otherAccount = _seedWebSocketEntryForTest({
        poolKey, auth: authB, cacheKey: 'cache-a', entry: poolEntry('resp-account-b'),
    });
    const otherCache = _seedWebSocketEntryForTest({
        poolKey, auth: authA, cacheKey: 'cache-b', entry: poolEntry('resp-cache-b'),
    });

    releaseWebSocket({ entry: oldest, poolKey, keep: true });
    releaseWebSocket({ entry: otherAccount, poolKey, keep: true });
    releaseWebSocket({ entry: otherCache, poolKey, keep: true });
    releaseWebSocket({ entry: latest, poolKey, keep: true });

    const first = await acquireWebSocket({
        auth: authA, poolKey, cacheKey: 'cache-a', forceFresh: false,
    });
    assert.equal(first.entry, latest, 'latest completed compatible chain wins');
    assert.equal(first.reused, true);
    assert.equal(latest.busy, true, 'acquire reserves the selected entry');

    const second = await acquireWebSocket({
        auth: authA, poolKey, cacheKey: 'cache-a', forceFresh: false,
    });
    assert.equal(second.entry, oldest, 'reserved latest entry cannot be acquired concurrently');
    assert.equal(second.entry.lastResponseId, 'resp-old');
    assert.notEqual(second.entry, otherAccount);
    assert.notEqual(second.entry, otherCache);
});

test('acquire timeout reconnects successfully with progress, not a terminal WS error', async () => {
    const oldWrite = process.stderr.write;
    const oldQuiet = process.env.MIXDOG_QUIET_PROVIDER_LOG;
    let stderr = '';
    let attempts = 0;
    const stages = [];
    try {
        delete process.env.MIXDOG_QUIET_PROVIDER_LOG;
        process.stderr.write = (chunk) => {
            stderr += String(chunk);
            return true;
        };
        const result = await sendViaWebSocket(wsArgs({
            onStageChange: (stage, detail) => stages.push({ stage, detail }),
            _acquireWithRetryFn: (opts) => _acquireWithRetry({
                ...opts,
                maxAttempts: 2,
                _sleepFn: async () => {},
                _acquire: async () => {
                    attempts += 1;
                    if (attempts === 1) {
                        throw Object.assign(new Error('OpenAI OAuth WS acquire timed out before open'), {
                            code: 'EWSACQUIRETIMEOUT',
                        });
                    }
                    return { entry: entry(), reused: false };
                },
            }),
            _streamFn: async () => ({
                content: 'recovered',
                model: 'gpt-5.5',
                toolCalls: [],
                usage: {},
                closeSocket: true,
            }),
        }));
        assert.equal(result.content, 'recovered');
        assert.equal(attempts, 2);
        assert.deepEqual(
            stages.filter(({ stage }) => stage === 'reconnecting'),
            [{ stage: 'reconnecting', detail: {
                attempt: 1,
                max: 1,
                classifier: 'acquire_timeout',
                message: 'Reconnecting... 1/1',
            } }],
        );
        assert.doesNotMatch(stderr, /Reconnecting/);
        assert.doesNotMatch(stderr, /acquire timed out|handshake failed|terminal/i);
    } finally {
        process.stderr.write = oldWrite;
        if (oldQuiet == null) delete process.env.MIXDOG_QUIET_PROVIDER_LOG;
        else process.env.MIXDOG_QUIET_PROVIDER_LOG = oldQuiet;
    }
});

for (const failure of ['callback error', 'callback timeout']) {
    test(`send ${failure} drops the socket and retries on a fresh one`, async () => {
        const acquires = [];
        const sockets = [];
        let acquireIndex = 0;
        const result = await sendViaWebSocket(wsArgs({
            _acquireWithRetryFn: async (opts) => {
                acquires.push(opts.forceFresh);
                const isFirst = acquireIndex++ === 0;
                const socket = {
                    readyState: 1,
                    terminated: false,
                    send(_payload, callback) {
                        if (!isFirst) queueMicrotask(() => callback());
                        else if (failure === 'callback error') {
                            queueMicrotask(() => callback(new Error('write failed')));
                        }
                    },
                    terminate() {
                        this.terminated = true;
                        this.readyState = 3;
                    },
                    close() {
                        this.readyState = 3;
                    },
                };
                sockets.push(socket);
                return { entry: { socket }, reused: false };
            },
            _sendFrameFn: (wsEntry, frame, span) => _sendFrame(wsEntry, frame, span, 10),
            _streamFn: async () => ({
                content: 'recovered',
                model: 'gpt-5.5',
                toolCalls: [],
                usage: {},
                closeSocket: true,
            }),
        }));

        assert.equal(result.content, 'recovered');
        assert.deepEqual(acquires, [false, true]);
        assert.equal(sockets[0].terminated, true);
        assert.notEqual(sockets[1], sockets[0]);
    });
}

test('pre-response 1006 opens a fresh WS and replays the same request', async () => {
    const acquires = [];
    const frames = [];
    const stages = [];
    let stderr = '';
    const oldWrite = process.stderr.write;
    let streams = 0;
    let result;
    try {
        process.stderr.write = (chunk) => {
            stderr += String(chunk);
            return true;
        };
        result = await sendViaWebSocket(wsArgs({
            onStageChange: (stage, detail) => stages.push({ stage, detail }),
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
    } finally {
        process.stderr.write = oldWrite;
    }

    assert.equal(result.content, 'recovered');
    assert.deepEqual(acquires, [false, true], 'retry must acquire a fresh socket');
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[1].input, frames[0].input, 'retry must replay the same input');
    assert.equal(result.__midstreamRetries, 1);
    assert.deepEqual(
        stages.filter(({ stage }) => stage === 'reconnecting'),
        [{ stage: 'reconnecting', detail: {
            attempt: 1,
            max: 5,
            classifier: 'ws_1006',
            message: 'Reconnecting... 1/5',
        } }],
    );
    assert.doesNotMatch(stderr, /mid-stream recovered|Reconnecting/);
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

test('normal handshake cannot return or reinsert a socket after pool drain', async () => {
    let finishOpen;
    const opened = new Promise((resolve) => { finishOpen = resolve; });
    const closes = [];
    const socket = new EventEmitter();
    socket.readyState = 1;
    socket.close = (code, reason) => closes.push([code, reason]);
    socket.on = socket.on.bind(socket);
    try {
        _setOpenSocketForTest(() => opened);
        const acquire = acquireWebSocket({
            auth: { type: 'openai-direct', apiKey: 'test-key' },
            poolKey: 'drain-race',
            cacheKey: 'drain-race',
            forceFresh: false,
            externalSignal: null,
        });
        _closeAllPooledSockets('test-drain');
        finishOpen({ socket, turnState: null });
        await assert.rejects(acquire, /WS pool drained/);
        assert.deepEqual(closes, [[1000, 'drain-complete']]);
    } finally {
        _clearWebSocketPoolForTest();
        _resetOpenSocketDrainForTest();
    }
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
        const sendOpts = {
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
        };
        const result = await provider.send([], 'gpt-5.5', [], sendOpts);
        const stickyResult = await provider.send([], 'gpt-5.5', [], sendOpts);

        assert.equal(streamAttempts, 6, 'five bounded retries must run before fallback');
        assert.equal(httpCalls, 2);
        assert.equal(result.content, 'http-recovered');
        assert.equal(stickyResult.content, 'http-recovered');
        assert.equal(provider._httpFallbackUntilByPoolKey.get(sendOpts.sessionId), Number.POSITIVE_INFINITY);
    } finally {
        for (const [name, value] of Object.entries(savedEnv)) {
            if (value == null) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('handshake 403 spends the shared retry budget without auth refresh, then disables WS for the session', async () => {
    const savedEnv = Object.fromEntries([
        'MIXDOG_OAI_TRANSPORT',
        'MIXDOG_OPENAI_HTTP_FALLBACK',
        'MIXDOG_OPENAI_OAUTH_WS_WARMUP',
        'MIXDOG_AGENT_TRACE_DISABLE',
    ].map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
        MIXDOG_OAI_TRANSPORT: 'auto',
        MIXDOG_OPENAI_HTTP_FALLBACK: '1',
        MIXDOG_OPENAI_OAUTH_WS_WARMUP: '0',
        MIXDOG_AGENT_TRACE_DISABLE: '1',
    });
    try {
        const provider = new OpenAIOAuthProvider({});
        let authRefreshes = 0;
        provider.ensureAuth = async ({ forceRefresh = false } = {}) => {
            if (forceRefresh) authRefreshes += 1;
            return { access_token: 'test-token' };
        };
        let acquires = 0;
        let httpCalls = 0;
        const sendOpts = {
            sessionId: 'openai-oauth-ws-403-fallback-test',
            _prebuiltBody: { model: 'gpt-5.5', input: [] },
            _sendViaWebSocketFn: (args) => sendViaWebSocket({
                ...args,
                _acquireWithRetryFn: async ({ forceFresh }) => {
                    assert.equal(forceFresh, acquires > 0);
                    acquires += 1;
                    throw Object.assign(new Error('Unexpected server response: 403'), { httpStatus: 403 });
                },
                _sleepFn: async () => {},
            }),
            _sendViaHttpSseFn: async () => {
                httpCalls += 1;
                return { content: 'http-recovered', toolCalls: [], usage: {} };
            },
        };

        assert.equal((await provider.send([], 'gpt-5.5', [], sendOpts)).content, 'http-recovered');
        assert.equal((await provider.send([], 'gpt-5.5', [], sendOpts)).content, 'http-recovered');
        assert.equal(acquires, 6);
        assert.equal(authRefreshes, 0);
        assert.equal(httpCalls, 2);
    } finally {
        for (const [name, value] of Object.entries(savedEnv)) {
            if (value == null) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('handshake 426 falls back immediately without retry or auth refresh', async () => {
    const provider = new OpenAIOAuthProvider({});
    let authRefreshes = 0;
    provider.ensureAuth = async ({ forceRefresh = false } = {}) => {
        if (forceRefresh) authRefreshes += 1;
        return { access_token: 'test-token' };
    };
    let wsCalls = 0;
    let httpCalls = 0;
    const result = await provider.send([], 'gpt-5.5', [], {
        sessionId: 'openai-oauth-ws-426-fallback-test',
        _prebuiltBody: { model: 'gpt-5.5', input: [] },
        _sendViaWebSocketFn: async () => {
            wsCalls += 1;
            throw Object.assign(new Error('Upgrade Required'), { httpStatus: 426 });
        },
        _sendViaHttpSseFn: async () => {
            httpCalls += 1;
            return { content: 'http-426', toolCalls: [], usage: {} };
        },
    });
    assert.equal(result.content, 'http-426');
    assert.equal(wsCalls, 1);
    assert.equal(httpCalls, 1);
    assert.equal(authRefreshes, 0);
});

for (const path of ['handshake', 'pre-output-stream']) {
    for (const terminalStatus of [401, 426]) {
        test(`mixed ${path} failure surfaces later ${terminalStatus} to provider recovery`, async () => {
            const provider = new OpenAIOAuthProvider({});
            let authRefreshes = 0;
            provider.ensureAuth = async ({ forceRefresh = false } = {}) => {
                if (forceRefresh) authRefreshes += 1;
                return { access_token: forceRefresh ? 'refreshed-token' : 'test-token' };
            };
            let wsDispatches = 0;
            let httpCalls = 0;
            const result = await provider.send([], 'gpt-5.5', [], {
                sessionId: `mixed-${path}-${terminalStatus}`,
                _prebuiltBody: { model: 'gpt-5.5', input: [] },
                _sendViaWebSocketFn: (args) => {
                    wsDispatches += 1;
                    if (wsDispatches > 1) {
                        return { content: 'ws-after-refresh', toolCalls: [], usage: {} };
                    }
                    let failures = 0;
                    return sendViaWebSocket({
                        ...args,
                        _acquireWithRetryFn: async () => {
                            if (path === 'handshake') {
                                failures += 1;
                                const status = failures === 1 ? 403 : terminalStatus;
                                throw Object.assign(new Error(`handshake ${status}`), { httpStatus: status });
                            }
                            return { entry: entry(), reused: false };
                        },
                        _sendFrameFn: async () => {},
                        _streamFn: async () => {
                            failures += 1;
                            if (failures === 1) throw close1006();
                            throw Object.assign(new Error(`stream ${terminalStatus}`), { httpStatus: terminalStatus });
                        },
                        _sleepFn: async () => {},
                    });
                },
                _sendViaHttpSseFn: async () => {
                    httpCalls += 1;
                    return { content: 'http-after-426', toolCalls: [], usage: {} };
                },
            });

            assert.equal(result.content, terminalStatus === 401 ? 'ws-after-refresh' : 'http-after-426');
            assert.equal(authRefreshes, terminalStatus === 401 ? 1 : 0);
            assert.equal(wsDispatches, terminalStatus === 401 ? 2 : 1);
            assert.equal(httpCalls, terminalStatus === 426 ? 1 : 0);
        });
    }
}

for (const fallbackOutcome of ['failure', 'abort']) {
    test(`WS remains disabled when sticky HTTP fallback ends in ${fallbackOutcome}`, async () => {
        const provider = new OpenAIOAuthProvider({});
        provider.ensureAuth = async () => ({ access_token: 'test-token' });
        const controller = new AbortController();
        let wsCalls = 0;
        let httpCalls = 0;
        const opts = {
            sessionId: `sticky-before-http-${fallbackOutcome}`,
            signal: controller.signal,
            _prebuiltBody: { model: 'gpt-5.5', input: [] },
            _sendViaWebSocketFn: async () => {
                wsCalls += 1;
                throw Object.assign(new Error('WS retries exhausted'), {
                    retryClassifier: 'reset',
                    wsRetriesExhausted: true,
                });
            },
            _sendViaHttpSseFn: async () => {
                httpCalls += 1;
                if (httpCalls === 1) {
                    const err = new Error(`fallback ${fallbackOutcome}`);
                    if (fallbackOutcome === 'abort') controller.abort(err);
                    throw err;
                }
                return { content: 'http-still-disabled', toolCalls: [], usage: {} };
            },
        };

        await assert.rejects(
            provider.send([], 'gpt-5.5', [], opts),
            fallbackOutcome === 'abort'
                ? (err) => err === controller.signal.reason && err.message === 'fallback abort'
                : /WS retries exhausted/,
        );
        assert.equal(
            provider._httpFallbackUntilByPoolKey.get(opts.sessionId),
            Number.POSITIVE_INFINITY,
        );
        if (fallbackOutcome === 'abort') opts.signal = null;
        assert.equal((await provider.send([], 'gpt-5.5', [], opts)).content, 'http-still-disabled');
        assert.equal(wsCalls, 1);
        assert.equal(httpCalls, 2);
    });
}

for (const fallbackPath of ['primary', 'auth-retry']) {
    for (const exposed of ['text', 'tool']) {
        test(`HTTP ${fallbackPath} fallback failure after ${exposed} overrides stale WS error`, async () => {
            const provider = new OpenAIOAuthProvider({});
            let refreshes = 0;
            provider.ensureAuth = async ({ forceRefresh = false } = {}) => {
                if (forceRefresh) refreshes += 1;
                return { access_token: forceRefresh ? 'refreshed-token' : 'test-token' };
            };
            let wsCalls = 0;
            const stale = Object.assign(new Error(`stale ${fallbackPath} WS failure`), {
                retryClassifier: 'reset',
                wsRetriesExhausted: true,
            });
            const exposedFailure = Object.assign(new Error(`HTTP fallback failed after ${exposed}`), {
                unsafeToRetry: true,
                ...(exposed === 'text'
                    ? { liveTextEmitted: true }
                    : { emittedToolCall: true }),
            });

            await assert.rejects(
                provider.send([], 'gpt-5.5', [], {
                    sessionId: `http-${fallbackPath}-${exposed}-failure`,
                    _prebuiltBody: { model: 'gpt-5.5', input: [] },
                    _sendViaWebSocketFn: async () => {
                        wsCalls += 1;
                        if (fallbackPath === 'auth-retry' && wsCalls === 1) {
                            throw Object.assign(new Error('refresh auth'), { httpStatus: 401 });
                        }
                        throw stale;
                    },
                    _sendViaHttpSseFn: async () => {
                        throw exposedFailure;
                    },
                }),
                (err) => err === exposedFailure
                    && err.unsafeToRetry === true
                    && (exposed === 'text'
                        ? err.liveTextEmitted === true
                        : err.emittedToolCall === true),
            );
            assert.equal(wsCalls, fallbackPath === 'auth-retry' ? 2 : 1);
            assert.equal(refreshes, fallbackPath === 'auth-retry' ? 1 : 0);
        });
    }
}

test('sticky HTTP fallback is isolated by session and expired entries are cleaned', async () => {
    const savedEnv = Object.fromEntries([
        'MIXDOG_OAI_TRANSPORT',
        'MIXDOG_OPENAI_HTTP_FALLBACK',
        'MIXDOG_OPENAI_OAUTH_WS_WARMUP',
        'MIXDOG_AGENT_TRACE_DISABLE',
    ].map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
        MIXDOG_OAI_TRANSPORT: 'auto',
        MIXDOG_OPENAI_HTTP_FALLBACK: '1',
        MIXDOG_OPENAI_OAUTH_WS_WARMUP: '0',
        MIXDOG_AGENT_TRACE_DISABLE: '1',
    });
    try {
        const provider = new OpenAIOAuthProvider({});
        provider.ensureAuth = async () => ({ access_token: 'test-token' });
        const wsCalls = [];
        const httpCalls = [];
        let sessionAFailed = false;
        const sendFor = (sessionId) => provider.send([], 'gpt-5.5', [], {
            sessionId,
            _prebuiltBody: { model: 'gpt-5.5', input: [], prompt_cache_key: sessionId },
            _sendViaWebSocketFn: async () => {
                wsCalls.push(sessionId);
                if (sessionId === 'sticky-session-a' && !sessionAFailed) {
                    sessionAFailed = true;
                    throw Object.assign(new Error('ws retries exhausted'), {
                        code: 'ECONNRESET',
                        retryClassifier: 'reset',
                        wsRetriesExhausted: true,
                    });
                }
                return { content: `ws-${sessionId}`, toolCalls: [], usage: {} };
            },
            _sendViaHttpSseFn: async () => {
                httpCalls.push(sessionId);
                return { content: `http-${sessionId}`, toolCalls: [], usage: {} };
            },
        });

        assert.equal((await sendFor('sticky-session-a')).content, 'http-sticky-session-a');
        assert.equal((await sendFor('sticky-session-b')).content, 'ws-sticky-session-b');
        assert.equal((await sendFor('sticky-session-a')).content, 'http-sticky-session-a');
        assert.deepEqual(wsCalls, ['sticky-session-a', 'sticky-session-b']);
        assert.deepEqual(httpCalls, ['sticky-session-a', 'sticky-session-a']);

        provider._httpFallbackUntilByPoolKey.set('sticky-session-a', Date.now() - 1);
        assert.equal((await sendFor('sticky-session-a')).content, 'ws-sticky-session-a');
        assert.equal(provider._httpFallbackUntilByPoolKey.has('sticky-session-a'), false);
    } finally {
        for (const [name, value] of Object.entries(savedEnv)) {
            if (value == null) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('close 1000 after tool dispatch refuses WS replay and HTTP fallback', async () => {
    const savedEnv = Object.fromEntries([
        'MIXDOG_OAI_TRANSPORT',
        'MIXDOG_OPENAI_HTTP_FALLBACK',
        'MIXDOG_OPENAI_OAUTH_WS_WARMUP',
        'MIXDOG_AGENT_TRACE_DISABLE',
    ].map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
        MIXDOG_OAI_TRANSPORT: 'auto',
        MIXDOG_OPENAI_HTTP_FALLBACK: '1',
        MIXDOG_OPENAI_OAUTH_WS_WARMUP: '0',
        MIXDOG_AGENT_TRACE_DISABLE: '1',
    });
    try {
        const provider = new OpenAIOAuthProvider({});
        provider.ensureAuth = async () => ({ access_token: 'test-token' });
        let acquires = 0;
        let httpCalls = 0;
        await assert.rejects(
            provider.send([], 'gpt-5.5', [], {
                sessionId: 'openai-oauth-ws-1000-tool-test',
                _prebuiltBody: { model: 'gpt-5.5', input: [], prompt_cache_key: 'openai-oauth-ws-1000-tool-test' },
                _sendViaWebSocketFn: (args) => sendViaWebSocket({
                    ...args,
                    _acquireWithRetryFn: async () => {
                        acquires += 1;
                        return { entry: entry(), reused: false };
                    },
                    _sendFrameFn: async () => {},
                    _streamFn: async ({ state }) => {
                        state.sawResponseCreated = true;
                        state.emittedToolCall = true;
                        throw Object.assign(new Error('WebSocket closed normally before completion'), {
                            wsCloseCode: 1000,
                        });
                    },
                }),
                _sendViaHttpSseFn: async () => {
                    httpCalls += 1;
                    return { content: 'unsafe fallback', toolCalls: [], usage: {} };
                },
            }),
            (err) => err.wsCloseCode === 1000
                && err.emittedToolCall === true
                && err.unsafeToRetry === true,
        );
        assert.equal(acquires, 1);
        assert.equal(httpCalls, 0);
    } finally {
        for (const [name, value] of Object.entries(savedEnv)) {
            if (value == null) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('post-tool unknown-model errors never refresh or recursively replay', async () => {
    for (const shape of [
        { httpStatus: 404, message: 'not found' },
        { message: 'model_not_found: unavailable model' },
    ]) {
        const provider = new OpenAIOAuthProvider({});
        provider.ensureAuth = async () => ({ access_token: 'test-token' });
        let wsCalls = 0;
        let refreshCalls = 0;
        provider._refreshModelCache = async () => {
            refreshCalls += 1;
            return [];
        };
        const unsafe = Object.assign(new Error(shape.message), shape, {
            emittedToolCall: true,
            unsafeToRetry: true,
        });
        await assert.rejects(
            provider.send([], 'gpt-5.5', [], {
                sessionId: `post-tool-model-${shape.httpStatus || 'message'}`,
                _prebuiltBody: { model: 'gpt-5.5', input: [] },
                _sendViaWebSocketFn: async () => {
                    wsCalls += 1;
                    throw unsafe;
                },
                _sendViaHttpSseFn: async () => {
                    throw new Error('unsafe HTTP fallback');
                },
            }),
            (err) => err === unsafe,
        );
        assert.equal(wsCalls, 1);
        assert.equal(refreshCalls, 0);
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

test('partial reasoning or tool generation refuses WS replay', async () => {
    for (const partial of ['emittedReasoning', 'startedToolCall']) {
        let acquires = 0;
        await assert.rejects(
            sendViaWebSocket(wsArgs({
                poolKey: `openai-oauth-ws-1006-${partial}-test`,
                _acquireWithRetryFn: async () => {
                    acquires += 1;
                    return { entry: entry(), reused: false };
                },
                _streamFn: async ({ state }) => {
                    state[partial] = true;
                    throw close1006();
                },
            })),
            (err) => err.wsCloseCode === 1006
                && err.unsafeToRetry === true
                && (partial === 'emittedReasoning'
                    ? err.partialReasoningEmitted === true
                    : err.partialToolCallStarted === true),
        );
        assert.equal(acquires, 1, `${partial} must prevent a replay`);
    }
});

test('HTTP request transport retries match Codex count/backoff and exclude 429', async () => {
    const delays = [];
    let calls = 0;
    await assert.rejects(
        sendViaHttpSse({
            auth: { access_token: 'test-token' },
            body: { model: 'gpt-5.5', input: [] },
            fetchFn: async () => {
                calls += 1;
                return new Response('busy', { status: 503 });
            },
            _sleepFn: async (ms) => { delays.push(ms); },
        }),
        /503/,
    );
    assert.equal(calls, 5, 'four retries plus the initial request');
    assert.equal(delays.length, 4);
    for (const [index, base] of [200, 400, 800, 1600].entries()) {
        assert.ok(delays[index] >= base * 0.9 && delays[index] <= base * 1.1);
    }

    calls = 0;
    await assert.rejects(
        sendViaHttpSse({
            auth: { access_token: 'test-token' },
            body: { model: 'gpt-5.5', input: [] },
            fetchFn: async () => {
                calls += 1;
                return new Response('limited', { status: 429 });
            },
            _sleepFn: async () => assert.fail('429 must not retry'),
        }),
        /429/,
    );
    assert.equal(calls, 1);
});
