import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OpenAIDirectProvider,
  directHandshakeError,
  directWsEntry,
} from './_shared.mjs';


// --- Helpers ---------------------------------------------------------------

test('OpenAI API-key request keeps public defaults without network under every transport mode', async (t) => {
    const priorTransport = process.env.MIXDOG_OAI_TRANSPORT;
    t.after(() => {
        if (priorTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = priorTransport;
    });
    const provider = new OpenAIDirectProvider({ apiKey: 'fixture-openai-key' });
    for (const mode of ['auto', 'ws-full', 'ws-delta', 'http-sse']) {
        process.env.MIXDOG_OAI_TRANSPORT = mode;
        const calls = [];
        let captured = null;
        const result = await provider.send(
            [{ role: 'user', content: 'fixture' }],
            'gpt-5.4',
            [],
            {
                sessionId: `direct-request-defaults-${mode}`,
                _fetchFn: async () => { throw new Error('global fetch seam must not run'); },
                _sendViaWebSocketFn: async (request) => {
                    calls.push('ws');
                    captured = request;
                    return { content: 'ws-ok', toolCalls: [] };
                },
                _sendViaHttpSseFn: async (request) => {
                    calls.push('http');
                    captured = request;
                    return { content: 'http-ok', toolCalls: [] };
                },
            },
        );
        assert.deepEqual(calls, mode === 'http-sse' ? ['http'] : ['ws'], mode);
        assert.equal(result.content, mode === 'http-sse' ? 'http-ok' : 'ws-ok');
        assert.equal(captured.auth.type, 'openai-direct');
        assert.equal(captured.auth.apiKey, 'fixture-openai-key');
        if (mode !== 'http-sse') assert.equal(captured.traceProvider, 'openai-direct');
        assert.equal(captured.body.store, true);
        assert.equal(captured.body.prompt_cache_retention, '24h');
        assert.equal(captured.body.stream, true);
    }
});

test('OpenAI API-key unsupported handshake 403/404/429 falls back once without nested WS retries', async (t) => {
    const priorTransport = process.env.MIXDOG_OAI_TRANSPORT;
    process.env.MIXDOG_OAI_TRANSPORT = 'auto';
    t.after(() => {
        if (priorTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = priorTransport;
    });
    for (const status of [403, 404, 429]) {
        const provider = new OpenAIDirectProvider({ apiKey: 'fixture-openai-key' });
        let acquires = 0;
        let httpCalls = 0;
        const result = await provider.send([], 'gpt-5.4', [], {
            _fetchFn: async () => { throw new Error('global fetch seam must not run'); },
            _webSocketTestSeams: {
                // Neither null nor an inverted caller policy may override the
                // direct provider's mandatory handshake policy.
                handshakeErrorPolicy: status === 403
                    ? null
                    : () => ({ retry: true, httpFallback: false }),
                _acquireWithRetryFn: async () => {
                    acquires += 1;
                    throw directHandshakeError(status);
                },
                _sleepFn: async () => {},
                _sendSpanTraceFn: () => {},
                _agentTraceFn: () => {},
            },
            _sendViaHttpSseFn: async () => {
                httpCalls += 1;
                return { content: `http-${status}`, toolCalls: [] };
            },
        });
        assert.equal(result.content, `http-${status}`);
        assert.equal(acquires, 1, `handshake ${status} must not retry WS`);
        assert.equal(httpCalls, 1, `handshake ${status} gets one HTTP fallback`);
    }
});

test('OpenAI API-key application 4xx never falls back, and only a safe pre-output 401 replays once', async (t) => {
    const priorTransport = process.env.MIXDOG_OAI_TRANSPORT;
    process.env.MIXDOG_OAI_TRANSPORT = 'auto';
    t.after(() => {
        if (priorTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = priorTransport;
    });
    // HTTP fallback stays denied for EVERY application 4xx and for any attempt
    // that already exposed output — reissuing those cannot recover and can
    // duplicate an accepted request.
    //
    // 401 is the one status whose cause can be local: the API key rotated after
    // this provider instance was built. When nothing has been exposed yet the
    // turn is still replayable, so the provider reloads the key and retries
    // ONCE over WS (never over HTTP), in-band stream-phase 401 included — the
    // phase is not the safety boundary, exposed output is. A 401 that already
    // relayed text or dispatched a tool, and a 401 with no fresh key to replay
    // with, both stay terminal on the first attempt.
    const cases = [
        ...[400, 402, 403, 404, 409, 418, 422, 429, 451, 499]
            .map((status) => ({ status, exposed: null, acquires: 1, streams: 1, reloads: 0 })),
        { status: 401, exposed: null, acquires: 2, streams: 2, reloads: 1 },
        { status: 401, exposed: null, reloadKey: null, acquires: 1, streams: 1, reloads: 1 },
        { status: 401, exposed: 'text', acquires: 1, streams: 1, reloads: 0 },
        { status: 401, exposed: 'tool', acquires: 1, streams: 1, reloads: 0 },
        { status: 500, exposed: 'text', acquires: 1, streams: 1, reloads: 0 },
        { status: 500, exposed: 'tool', acquires: 1, streams: 1, reloads: 0 },
    ];
    for (const {
        status,
        exposed,
        reloadKey = 'replacement-key',
        acquires: expectedAcquires,
        streams: expectedStreams,
        reloads: expectedReloads,
    } of cases) {
        const label = `application ${status}${exposed ? ` +${exposed}` : ''}${reloadKey ? '' : ' (no fresh key)'}`;
        const provider = new OpenAIDirectProvider({ apiKey: 'fixture-openai-key' });
        let acquires = 0;
        let streams = 0;
        let httpCalls = 0;
        let reloads = 0;
        let visibleTextDeltas = 0;
        let dispatchedToolCalls = 0;
        provider.reloadApiKey = () => {
            reloads += 1;
            return reloadKey;
        };
        await assert.rejects(provider.send([], 'gpt-5.4', [], {
            onTextDelta: () => { visibleTextDeltas += 1; },
            onToolCall: () => { dispatchedToolCalls += 1; },
            _fetchFn: async () => { throw new Error('global fetch seam must not run'); },
            _webSocketTestSeams: {
                _acquireWithRetryFn: async () => {
                    acquires += 1;
                    return { entry: directWsEntry(), reused: false };
                },
                _sendFrameFn: async () => {},
                _streamFn: async ({ state, onTextDelta, onToolCall }) => {
                    streams += 1;
                    if (exposed === 'text') {
                        onTextDelta?.('visible-once');
                        state.emittedText = true;
                    }
                    if (exposed === 'tool') {
                        onToolCall?.({ id: 'tool-once', name: 'read', arguments: {} });
                        state.emittedToolCall = true;
                    }
                    throw Object.assign(new Error(`application ${status} ${exposed || ''}`), { httpStatus: status });
                },
                _sleepFn: async () => {},
                _sendSpanTraceFn: () => {},
                _agentTraceFn: () => {},
            },
            _sendViaHttpSseFn: async () => {
                httpCalls += 1;
                throw new Error('application/visible output must not reach HTTP');
            },
        }), new RegExp(`application ${status}`));
        assert.equal(acquires, expectedAcquires, `${label}: WS acquires`);
        assert.equal(streams, expectedStreams, `${label}: WS stream attempts`);
        assert.equal(httpCalls, 0, `${label}: must never reach HTTP fallback`);
        assert.equal(reloads, expectedReloads, `${label}: credential reloads`);
        // Exposed output is relayed exactly once — a replayed attempt must never
        // concatenate a second copy onto what the client already saw.
        assert.equal(visibleTextDeltas, exposed === 'text' ? 1 : 0, `${label}: visible text deltas`);
        assert.equal(dispatchedToolCalls, exposed === 'tool' ? 1 : 0, `${label}: dispatched tool calls`);
    }
});
