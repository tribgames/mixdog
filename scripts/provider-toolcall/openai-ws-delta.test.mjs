import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parse,
  isInvalidToolArgsMarker,
  _computeDelta,
  _buildResponseCreateFrame,
  _sansInput,
  _stableStringify,
  _cacheObservationForTest,
  _cacheContinuityResetReasonForTest,
  sendViaWebSocket,
  OpenAIOAuthProvider,
  parseToolSearchArgs,
  _warmupContinuityTraceForTest,
} from './_shared.mjs';


test('openai-oauth-ws (warmup continuity): warmup id anchors first real; first-3 misses counted', () => {
    const t = _warmupContinuityTraceForTest({
        warmupUsed: true, warmupResponseId: 'resp_w', priorEntryResponseId: 'resp_w',
        sentPrevResponseId: null, earlyCacheMisses: [false, 'warm_session_zero_cached_tokens', false, true],
    });
    assert.equal(t.warmup_chain_continuous, true);
    assert.equal(t.warmup_first_real_prev_id, 'resp_w');
    assert.deepEqual(t.early_cache_misses, [false, 'warm_session_zero_cached_tokens', false]);
    assert.equal(t.early_cache_miss_count, 1);
    assert.equal(_warmupContinuityTraceForTest({ warmupUsed: true, warmupResponseId: 'a', priorEntryResponseId: 'b' }).warmup_chain_continuous, false);
});

// WS tool_search_call.arguments parse policy (parseToolSearchArgs, module-scope
// export of openai-oauth-ws.mjs). Native convergence: malformed non-empty JSON
// becomes an invalid-args marker so the dispatch loop blocks execution and
// returns an is_error tool_result — NOT a silent {} that would dispatch
// tool_search with empty arguments. Empty/whitespace/object inputs keep their
// prior, correct behavior.
test('openai-oauth-ws (tool_search): malformed args string → invalid-args marker (not {})', () => {
    const out = parseToolSearchArgs('{"query": dispatchAiWrapped}');
    assert.equal(isInvalidToolArgsMarker(out), true);
    assert.equal(out.__invalidToolArgs, true);
    assert.equal(out.__rawArguments, '{"query": dispatchAiWrapped}');
    assert.equal(typeof out.__parseError, 'string');
    assert.ok(out.__parseError.length > 0);
});

test('openai-oauth-ws (tool_search): valid args / object / empty preserved', () => {
    // valid JSON string → parsed object
    assert.deepEqual(parseToolSearchArgs('{"query":"x"}'), { query: 'x' });
    // already an object → passthrough
    const obj = { query: 'y' };
    assert.equal(parseToolSearchArgs(obj), obj);
    // empty / whitespace / null / non-string → {} (no args, not a marker)
    assert.deepEqual(parseToolSearchArgs(''), {});
    assert.deepEqual(parseToolSearchArgs('   '), {});
    assert.deepEqual(parseToolSearchArgs(null), {});
    assert.deepEqual(parseToolSearchArgs(undefined), {});
    assert.equal(isInvalidToolArgsMarker(parseToolSearchArgs('')), false);
});

// === 9. OpenAI OAuth WS cache tracing ======================================

test('openai oauth ws delta: default delta safely falls back on request-property mismatch', () => {
    const body = { model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: 'hi' }] };
    const delta = _computeDelta({
        entry: {
            lastRequestSansInput: '{}',
            lastResponseId: 'resp_prev',
            lastRequestInput: body.input,
            lastResponseItems: [],
        },
        body,
    });
    assert.equal(delta.mode, 'full');
    assert.equal(delta.reason, 'request_properties_changed');
    assert.equal(delta.frame.previous_response_id, undefined);
});

test('openai oauth ws delta: ws-delta mode uses previous_response_id without turn-state, keeps safe fallback', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const body = {
            model: 'gpt-5.5',
            input: [
                { type: 'message', role: 'user', content: 'prev' },
                { type: 'message', role: 'user', content: 'next' },
            ],
        };
        const entry = {
            lastRequestSansInput: '{"model":"gpt-5.5"}',
            lastResponseId: 'resp_prev',
            lastRequestInput: [body.input[0]],
            lastResponseItems: [],
            // NOTE: no turnState — ws-delta (refs) mode must still emit a delta.
        };

        const refs = _computeDelta({ entry, body });
        assert.equal(refs.mode, 'delta');
        assert.equal(refs.frame.previous_response_id, 'resp_prev');
        assert.deepEqual(refs.frame.input, [body.input[1]]);

        // Safe fallback preserved: a changed request property breaks the prefix
        // and retreats to a full frame even in ws-delta mode.
        const changed = _computeDelta({ entry, body: { ...body, model: 'gpt-5.6' } });
        assert.equal(changed.mode, 'full');
        assert.equal(changed.reason, 'request_properties_changed');
        assert.equal(changed.frame.previous_response_id, undefined);

        const noAnchor = _computeDelta({ entry: { ...entry, lastResponseId: null }, body });
        assert.equal(noAnchor.mode, 'full');
        assert.equal(noAnchor.reason, 'no_anchor');
        assert.equal(noAnchor.frame.previous_response_id, undefined);

        const prefixMismatch = _computeDelta({
            entry: { ...entry, lastRequestInput: [{ type: 'message', role: 'user', content: 'other' }] },
            body,
        });
        assert.equal(prefixMismatch.mode, 'full');
        assert.equal(prefixMismatch.reason, 'input_prefix_mismatch');
        assert.equal(prefixMismatch.frame.previous_response_id, undefined);

        const responseMismatch = _computeDelta({
            entry: {
                ...entry,
                lastRequestInput: [body.input[0]],
                lastResponseItems: [{
                    type: 'function_call',
                    call_id: 'call_1',
                    name: 'tool',
                    arguments: '{"api_key":"provider-function-secret","nested":{"z":2,"a":1}}',
                }],
            },
            body: {
                ...body,
                input: [
                    body.input[0],
                    {
                        type: 'function_call',
                        call_id: 'call_other',
                        name: 'tool',
                        arguments: '{"nested":{"a":1,"z":2},"api_key":"replayed-function-secret"}',
                    },
                    body.input[1],
                ],
            },
        });
        assert.equal(responseMismatch.mode, 'full');
        assert.equal(responseMismatch.reason, 'response_output_mismatch:function_call');
        assert.equal(responseMismatch.frame.previous_response_id, undefined);
        const mismatch = responseMismatch.responseOutputMismatch;
        assert.deepEqual({
            expectedType: mismatch.response_output_mismatch_expected_type,
            actualType: mismatch.response_output_mismatch_actual_type,
            expectedCount: mismatch.response_output_mismatch_expected_response_item_count,
            actualCount: mismatch.response_output_mismatch_actual_replayed_input_item_count,
        }, {
            expectedType: 'function_call',
            actualType: 'function_call',
            expectedCount: 1,
            actualCount: 2,
        });
        assert.match(mismatch.response_output_mismatch_expected_hash, /^[a-f0-9]{64}$/);
        assert.match(mismatch.response_output_mismatch_actual_hash, /^[a-f0-9]{64}$/);
        const traceSafe = JSON.stringify(mismatch);
        assert.equal(traceSafe.includes('call_other'), false);
        assert.equal(traceSafe.includes('provider-function-secret'), false);
        assert.equal(traceSafe.includes('replayed-function-secret'), false);
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('openai oauth ws delta: message mismatch diagnostics hash normalized content without tracing it', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const prior = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prior' }] };
        const expected = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'provider secret' }] };
        const actual = { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'replayed secret' }] };
        const delta = _computeDelta({
            entry: {
                lastRequestSansInput: '{"model":"gpt-5.5"}',
                lastResponseId: 'resp_prev',
                lastRequestInput: [prior],
                lastResponseItems: [expected],
            },
            body: { model: 'gpt-5.5', input: [prior, actual] },
        });
        const mismatch = delta.responseOutputMismatch;
        assert.equal(delta.reason, 'response_output_mismatch:message');
        assert.equal(mismatch.response_output_mismatch_expected_type, 'message');
        assert.equal(mismatch.response_output_mismatch_actual_type, 'message');
        assert.notEqual(mismatch.response_output_mismatch_expected_hash, mismatch.response_output_mismatch_actual_hash);
        const traceSafe = JSON.stringify(mismatch);
        assert.equal(traceSafe.includes('provider secret'), false);
        assert.equal(traceSafe.includes('replayed secret'), false);
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('openai oauth ws delta: diagnostic hashes normalize equivalent message and function-call forms', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const prior = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prior' }] };
        const mismatch = (expected, actual) => _computeDelta({
            entry: {
                lastRequestSansInput: '{"model":"gpt-5.5"}',
                lastResponseId: 'resp_prev',
                lastRequestInput: [prior],
                lastResponseItems: [expected],
            },
            body: { model: 'gpt-5.5', input: [prior, actual] },
        }).responseOutputMismatch;
        const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'same sensitive message' }] };
        const messageExpected = mismatch(message, {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'different message' }],
        });
        const messageActual = mismatch({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'different message' }],
        }, {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'input_text', text: 'same sensitive message' }],
        });
        assert.equal(
            messageExpected.response_output_mismatch_expected_hash,
            messageActual.response_output_mismatch_actual_hash,
        );

        const functionExpected = (argumentsValue) => mismatch({
            type: 'function_call',
            call_id: 'call_same',
            name: 'tool',
            arguments: argumentsValue,
        }, {
            type: 'function_call',
            call_id: 'call_different',
            name: 'tool',
            arguments: '{"ignored":"replayed-function-secret"}',
        });
        assert.equal(
            functionExpected('{"api_key":"function-secret","nested":{"z":2,"a":1}}').response_output_mismatch_expected_hash,
            functionExpected('{"nested":{"a":1,"z":2},"api_key":"function-secret"}').response_output_mismatch_expected_hash,
        );
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('openai oauth ws delta: mismatch diagnostics reach transport and cache_break without sensitive values', async () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const rows = [];
        const prior = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prior' }] };
        const cases = [{
            expected: {
                type: 'function_call',
                call_id: 'call_expected',
                name: 'tool',
                arguments: '{"api_key":"provider-function-secret","nested":{"z":2,"a":1}}',
            },
            actual: {
                type: 'function_call',
                call_id: 'call_actual',
                name: 'tool',
                arguments: '{"nested":{"a":1,"z":2},"api_key":"replayed-function-secret"}',
            },
        }, {
            expected: {
                type: 'custom_tool_call',
                call_id: 'custom_expected',
                name: 'apply_patch',
                input: 'provider-custom-input-secret',
            },
            actual: {
                type: 'custom_tool_call',
                call_id: 'custom_actual',
                name: 'apply_patch',
                input: 'replayed-custom-input-secret',
            },
        }];
        for (const { expected, actual } of cases) {
            const body = { model: 'gpt-5.5', input: [prior, actual] };
            const entry = {
                socket: { close() {} },
                lastRequestSansInput: _stableStringify(_sansInput(body)),
                lastResponseId: 'resp_prev',
                lastRequestInput: [prior],
                lastResponseItems: [expected],
            };
            const expectedDiagnostics = _computeDelta({ entry, body }).responseOutputMismatch;
            await sendViaWebSocket({
                auth: { type: 'xai', access_token: 'test-token' },
                body,
                poolKey: `mismatch-trace-${expected.type}`,
                cacheKey: 'mismatch-trace-test',
                iteration: 1,
                useModel: 'gpt-5.5',
                traceProvider: 'xai',
                _acquireWithRetryFn: async () => ({ entry, reused: false }),
                _sendFrameFn: async () => {},
                _streamFn: async () => ({
                    content: 'ok',
                    model: 'gpt-5.5',
                    toolCalls: [],
                    usage: {},
                    responseId: 'resp_next',
                    responseItems: [],
                    closeSocket: true,
                }),
                _agentTraceFn: (row) => rows.push(row),
            });
            const emitted = rows.filter((row) => row.payload?.response_output_mismatch_expected_type === expected.type);
            assert.deepEqual(emitted.map((row) => row.kind).sort(), ['cache_break', 'transport']);
            for (const row of emitted) assert.deepEqual(
                Object.fromEntries(Object.keys(expectedDiagnostics).map((key) => [key, row.payload[key]])),
                expectedDiagnostics,
            );
        }
        const traceText = JSON.stringify(rows);
        for (const secret of [
            'provider-function-secret',
            'replayed-function-secret',
            'provider-custom-input-secret',
            'replayed-custom-input-secret',
        ]) assert.equal(traceText.includes(secret), false);
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('openai oauth ws delta: warmup generate:false does not force request_properties_changed', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const warmupBody = { model: 'gpt-5.5', generate: false, input: [] };
        const body = { model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: 'first real input' }] };
        const entry = {
            lastRequestSansInput: _stableStringify(_sansInput(warmupBody, { normalizeWarmupGenerate: true })),
            lastResponseId: 'resp_warm',
            lastRequestInput: [],
            lastResponseItems: [],
        };
        assert.equal(_sansInput(warmupBody, { normalizeWarmupGenerate: true }).generate, undefined);
        const delta = _computeDelta({ entry, body, traceProvider: 'openai-oauth' });
        assert.equal(delta.mode, 'delta');
        assert.equal(delta.frame.previous_response_id, 'resp_warm');
        assert.deepEqual(delta.frame.input, body.input);
        // Non-warmup generate difference still breaks the delta.
        const genEntry = {
            ...entry,
            lastRequestSansInput: _stableStringify(_sansInput(
                { ...warmupBody, generate: true },
                { normalizeWarmupGenerate: true },
            )),
        };
        const genChanged = _computeDelta({ entry: genEntry, body, traceProvider: 'openai-oauth' });
        assert.equal(genChanged.mode, 'full');
        assert.equal(genChanged.reason, 'request_properties_changed');
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('OpenAI OAuth startup prewarm sends no transcript and anchors the first real WS request', async () => {
    const savedEnv = Object.fromEntries([
        'MIXDOG_OAI_TRANSPORT',
        'MIXDOG_OPENAI_OAUTH_WS_WARMUP',
        'MIXDOG_AGENT_TRACE_DISABLE',
    ].map((name) => [name, process.env[name]]));
    Object.assign(process.env, {
        MIXDOG_OAI_TRANSPORT: 'ws-delta',
        MIXDOG_OPENAI_OAUTH_WS_WARMUP: '1',
        MIXDOG_AGENT_TRACE_DISABLE: '1',
    });
    try {
        const provider = new OpenAIOAuthProvider({});
        provider.ensureAuth = async () => ({ access_token: 'test-token' });
        const liveInput = [{
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'live-transcript-must-appear-once' }],
        }];
        const body = {
            model: 'gpt-5.5',
            instructions: 'base instructions',
            input: liveInput,
            tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
            stream: true,
            background: false,
            prompt_cache_key: 'prewarm-parity-test',
        };
        const frames = [];
        let streams = 0;
        const result = await provider.send([], 'gpt-5.5', [], {
            sessionId: 'prewarm-parity-test',
            _prebuiltBody: body,
            _sendViaWebSocketFn: (args) => sendViaWebSocket({
                ...args,
                _acquireWithRetryFn: async () => ({ entry: { socket: { close() {} } }, reused: false }),
                _sendFrameFn: async (_entry, frame) => frames.push(JSON.parse(JSON.stringify(frame))),
                _streamFn: async ({ state }) => {
                    streams += 1;
                    return state.warmup
                        ? {
                            content: '',
                            model: 'gpt-5.5',
                            toolCalls: [],
                            usage: { inputTokens: 10, outputTokens: 0, cachedTokens: 0, promptTokens: 10 },
                            responseId: 'warm-1',
                            responseItems: [],
                        }
                        : {
                            content: 'done',
                            model: 'gpt-5.5',
                            toolCalls: [],
                            usage: { inputTokens: 20, outputTokens: 1, cachedTokens: 10, promptTokens: 20 },
                            responseId: 'resp-1',
                            responseItems: [],
                            closeSocket: true,
                        };
                },
                _agentTraceFn: () => {},
                _sendSpanTraceFn: () => {},
            }),
        });

        assert.equal(streams, 2);
        assert.equal(frames.length, 2);
        const [warmup, followUp] = frames;
        assert.equal(warmup.type, 'response.create');
        assert.equal(warmup.generate, false);
        assert.deepEqual(warmup.input, []);
        assert.equal(warmup.instructions, body.instructions);
        assert.deepEqual(warmup.tools, body.tools);
        assert.equal(warmup.stream, true);
        assert.equal(warmup.background, false);
        assert.equal(JSON.stringify(warmup).includes('live-transcript-must-appear-once'), false);
        assert.equal(followUp.type, 'response.create');
        assert.equal(followUp.previous_response_id, 'warm-1');
        assert.deepEqual(followUp.input, liveInput);
        assert.equal(JSON.stringify(followUp).match(/live-transcript-must-appear-once/g)?.length, 1);
        assert.equal(result.usage.inputTokens, 30, 'warmup remains included in billable totals');
        assert.equal(result.usage.mainInputTokens, 20, 'main context snapshot remains separate');
    } finally {
        for (const [name, value] of Object.entries(savedEnv)) {
            if (value == null) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('OpenAI OAuth session prewarm materializes one prompt warmup with Codex identity', async () => {
    const previousWarmup = process.env.MIXDOG_OPENAI_OAUTH_WS_WARMUP;
    process.env.MIXDOG_OPENAI_OAUTH_WS_WARMUP = '1';
    try {
        const provider = new OpenAIOAuthProvider({});
        const session = {
            id: 'startup-prewarm-session',
            codexWireSessionId: '019fc135-f07a-7880-8767-ec3b7be1de63',
            model: 'gpt-5.6-sol',
            messages: [{ role: 'system', content: 'stable instructions' }],
            tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }],
            effort: 'xhigh',
            fast: false,
            modelParameters: {},
            promptCacheKey: 'mixdog-codex',
        };
        const sends = [];
        const startupPrewarmHandle = {
            entry: {},
            poolKey: session.id,
            cacheKey: session.codexWireSessionId,
        };
        const ready = await provider.prewarmWsTransportForSession({
            sessionId: session.id,
            session,
        }, {
            _send: async (messages, model, tools, sendOpts) => {
                sends.push({ messages, model, tools, sendOpts });
                return { startupPrewarm: true, startupPrewarmHandle };
            },
        });

        assert.equal(ready, true);
        assert.equal(sends.length, 1);
        assert.equal(sends[0].messages, session.messages);
        assert.equal(sends[0].tools, session.tools);
        assert.equal(sends[0].model, session.model);
        assert.equal(sends[0].sendOpts._startupPrewarmOnly, true);
        assert.equal(sends[0].sendOpts.requestKind, 'prewarm');
        assert.equal(sends[0].sendOpts.codexRequestKind, 'prewarm');
        assert.equal(sends[0].sendOpts.codexSessionId, session.codexWireSessionId);
        assert.equal(sends[0].sendOpts.codexThreadId, session.codexWireSessionId);
        assert.equal(provider._startupPrewarmReadyByPoolKey.get(session.id), startupPrewarmHandle);
    } finally {
        if (previousWarmup == null) delete process.env.MIXDOG_OPENAI_OAUTH_WS_WARMUP;
        else process.env.MIXDOG_OPENAI_OAUTH_WS_WARMUP = previousWarmup;
    }
});

test('OpenAI OAuth prompt prewarm upgrades an in-flight transport prewarm', async () => {
    const previousWarmup = process.env.MIXDOG_OPENAI_OAUTH_WS_WARMUP;
    process.env.MIXDOG_OPENAI_OAUTH_WS_WARMUP = '1';
    try {
        const provider = new OpenAIOAuthProvider({});
        provider.ensureAuth = async () => ({ accessToken: 'test-token' });
        let releaseAcquire;
        let signalAcquire;
        const acquireGate = new Promise((resolve) => { releaseAcquire = resolve; });
        const acquireStarted = new Promise((resolve) => { signalAcquire = resolve; });
        let acquireCount = 0;
        let sendCount = 0;
        const startupPrewarmHandle = {
            entry: {},
            poolKey: 'startup-prewarm-upgrade',
            cacheKey: '019fc135-f07a-7880-8767-ec3b7be1de63',
        };
        const seams = {
            _hasPooled: () => false,
            _warmVersion: async () => {},
            _acquire: async () => {
                acquireCount += 1;
                signalAcquire();
                await acquireGate;
                return { entry: {}, reused: false };
            },
            _release: () => {},
            _send: async () => {
                sendCount += 1;
                return { startupPrewarm: true, startupPrewarmHandle };
            },
        };
        const session = {
            id: 'startup-prewarm-upgrade',
            codexWireSessionId: '019fc135-f07a-7880-8767-ec3b7be1de63',
            model: 'gpt-5.6-sol',
            messages: [{ role: 'system', content: 'stable instructions' }],
            tools: [],
        };
        const transport = provider.prewarmWsTransportForSession({
            sessionId: session.id,
            model: session.model,
        }, seams);
        await acquireStarted;
        const prompt = provider.prewarmWsTransportForSession({
            sessionId: session.id,
            session,
        }, seams);
        releaseAcquire();

        assert.deepEqual(await Promise.all([transport, prompt]), [true, true]);
        assert.equal(acquireCount, 1);
        assert.equal(sendCount, 1);
    } finally {
        if (previousWarmup == null) delete process.env.MIXDOG_OPENAI_OAUTH_WS_WARMUP;
        else process.env.MIXDOG_OPENAI_OAUTH_WS_WARMUP = previousWarmup;
    }
});

test('openai oauth ws delta: native tool_search output replays with canonical fields', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
        const baseTools = [{
            type: 'tool_search',
            execution: 'client',
            description: 'load tools',
            parameters: { type: 'object', properties: {} },
        }];
        const output = {
            type: 'tool_search_output',
            call_id: 'call_load_1',
            status: 'completed',
            execution: 'client',
            tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }],
        };
        const body = {
            model: 'gpt-5.5',
            instructions: 'sys',
            tools: baseTools,
            prompt_cache_key: 'cache-key',
            input: [
                { type: 'message', role: 'user', content: 'load read' },
                { type: 'tool_search_call', call_id: 'call_load_1', execution: 'client', arguments: { names: ['read'] } },
                output,
                { type: 'message', role: 'user', content: 'use read' },
            ],
        };
        const delta = _computeDelta({
            entry: {
                lastRequestSansInput: _stableStringify(_sansInput(body)),
                lastResponseId: 'resp_prev',
                lastRequestInput: [body.input[0]],
                lastResponseItems: [body.input[1]],
            },
            body,
        });
        assert.equal(delta.mode, 'delta');
        assert.equal(delta.frame.prompt_cache_key, 'cache-key');
        assert.deepEqual(delta.frame.tools, baseTools);
        assert.equal(delta.frame.instructions, 'sys');
        assert.deepEqual(delta.frame.input, [output, body.input[3]]);
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('canonical frame: full-frame builder leads with type and preserves codex body key order', () => {
    const body = {
        model: 'gpt-5.5',
        instructions: 'sys',
        input: [{ type: 'message', role: 'user', content: 'hi' }],
        tool_choice: 'auto',
        parallel_tool_calls: true,
        reasoning: { effort: 'medium' },
        store: false,
        stream: true,
        include: ['reasoning.encrypted_content'],
        prompt_cache_key: 'k',
        text: { verbosity: 'low' },
    };
    const frame = _buildResponseCreateFrame(body);
    assert.deepEqual(Object.keys(frame), ['type', ...Object.keys(body)]);
    assert.equal(frame.type, 'response.create');
    // A full-frame build is byte-identical to the legacy spread form.
    assert.equal(JSON.stringify(frame), JSON.stringify({ type: 'response.create', ...body }));
    assert.equal(frame.previous_response_id, undefined);
});

test('canonical frame: delta insert keeps key order and chained instructions, overrides input', () => {
    const body = {
        model: 'gpt-5.5',
        instructions: 'sys',
        input: [{ a: 1 }, { b: 2 }],
        tool_choice: 'auto',
        text: { verbosity: 'low' },
    };
    const delta = _buildResponseCreateFrame(body, { previousResponseId: 'resp_prev', inputOverride: [{ b: 2 }] });
    assert.deepEqual(Object.keys(delta), ['type', 'model', 'instructions', 'previous_response_id', 'input', 'tool_choice', 'text']);
    assert.equal(delta.instructions, 'sys');
    assert.equal(delta.previous_response_id, 'resp_prev');
    assert.deepEqual(delta.input, [{ b: 2 }]);
    // Empty instructions is also dropped in delta mode (server resolves via prev id).
    const noInstr = _buildResponseCreateFrame({ ...body, instructions: '' }, { previousResponseId: 'resp_prev', inputOverride: [] });
    assert.deepEqual(Object.keys(noInstr), ['type', 'model', 'previous_response_id', 'input', 'tool_choice', 'text']);
});

test('openai oauth ws cache observation detects warm zero and partial retreats', () => {
    const zero = _cacheObservationForTest({
        entry: { promptCacheMaxCachedTokens: 47_616 },
        result: { usage: { inputTokens: 59_000, promptTokens: 59_000, cachedTokens: 0 } },
    });
    assert.equal(zero.actualMiss, true);
    assert.equal(zero.missReason, 'warm_session_zero_cached_tokens');
    assert.equal(zero.uncachedTokens, 59_000);

    const partial = _cacheObservationForTest({
        entry: { promptCacheMaxCachedTokens: 101_888 },
        result: { usage: { inputTokens: 102_456, promptTokens: 102_456, cachedTokens: 60_928 } },
    });
    assert.equal(partial.actualMiss, true);
    assert.equal(partial.missReason, 'warm_session_cached_tokens_dropped');
    assert.equal(partial.cachedTokens % 512, 0);

    const healthy = _cacheObservationForTest({
        entry: { promptCacheMaxCachedTokens: 101_888 },
        result: { usage: { inputTokens: 106_468, promptTokens: 106_468, cachedTokens: 103_424 } },
    });
    assert.equal(healthy.actualMiss, false);
    assert.equal(healthy.missReason, null);

    const compacted = _cacheObservationForTest({
        entry: { promptCacheMaxCachedTokens: 255_488 },
        result: { usage: { inputTokens: 21_066, promptTokens: 21_066, cachedTokens: 8_704 } },
        continuityResetReason: 'input_prefix_mismatch',
    });
    assert.equal(compacted.actualMiss, false, 'intentional prompt rewrite must reset the old high-water');
    assert.equal(compacted.wasWarm, false);

    const previousInput = [{ type: 'message', role: 'user', content: 'old long transcript' }];
    const rewrittenBody = { model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: 'compact summary' }] };
    assert.equal(_cacheContinuityResetReasonForTest({
        mode: 'full',
        deltaReason: 'full_default',
        entry: {
            lastResponseId: 'resp_old',
            lastRequestSansInput: _stableStringify(_sansInput(rewrittenBody)),
            lastRequestInput: previousInput,
        },
        body: rewrittenBody,
    }), 'input_prefix_mismatch', 'ws-full must detect prompt rewrites hidden by full_default');
});
