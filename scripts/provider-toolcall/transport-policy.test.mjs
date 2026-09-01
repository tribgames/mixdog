import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EventEmitter,
  readFileSync,
  _computeDelta,
  _buildResponseCreateFrame,
  _withCodexWsClientMetadata,
  _captureTurnStateFromEvent,
  geminiChunkProgressKind,
  isVisibleStreamProgress,
  resolveOpenAiTransportPolicy,
  _normalizeTransportMode,
  resolveResponsesTransportPolicy,
  RESPONSES_TRANSPORT_CAPABILITIES,
  _gateTransportMode,
  FULL_RESPONSES_TRANSPORT_CAPS,
  acquireWebSocket,
  releaseWebSocket,
  _clearWebSocketPoolForTest,
  _setOpenSocketForTest,
} from './_shared.mjs';


test('transport policy: default (no env) is auto WS-first / refs continuation ON / HTTP fallback ON', () => {
    const p = resolveOpenAiTransportPolicy({});
    assert.equal(p.mode, 'auto');
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, true);
    assert.deepEqual(p.delta, { force: false, refs: true, optIn: true });
});

test('transport policy: default ignores the legacy MIXDOG_OAI_WS_DELTA env', () => {
    // Legacy compatibility removed: delta is selected solely via ws-delta mode.
    assert.deepEqual(resolveOpenAiTransportPolicy({ MIXDOG_OAI_WS_DELTA: '1' }).delta, { force: false, refs: true, optIn: true });
    assert.deepEqual(resolveOpenAiTransportPolicy({ MIXDOG_OAI_WS_DELTA: 'force' }).delta, { force: false, refs: true, optIn: true });
    assert.deepEqual(resolveOpenAiTransportPolicy({ MIXDOG_OAI_WS_DELTA: 'refs' }).delta, { force: false, refs: true, optIn: true });
});

test('transport policy: ws-full forces full frames', () => {
    const p = resolveOpenAiTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'ws-full' });
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, false);
    assert.equal(p.delta.optIn, false);
});

test('transport policy: ws-delta selects refs-compatible delta (no turn-state demand)', () => {
    const p = resolveOpenAiTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'ws-delta' });
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, false);
    assert.deepEqual(p.delta, { force: false, refs: true, optIn: true });
});

test('transport policy: http-sse forces the HTTP transport with delta OFF', () => {
    const p = resolveOpenAiTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'http-sse' });
    assert.equal(p.transport, 'http');
    assert.equal(p.allowHttpFallback, false);
    assert.equal(p.delta.optIn, false);
});

test('transport policy: unknown MIXDOG_OAI_TRANSPORT falls back to default auto', () => {
    const p = resolveOpenAiTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'quantum' });
    assert.equal(p.mode, 'auto');
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, true);
});

test('response frame builder can omit transport-only stream/background for codex warmup parity', () => {
    const body = { model: 'gpt-5.5', input: [{ a: 1 }, { b: 2 }], stream: true, background: false, text: { verbosity: 'low' } };
    const full = _buildResponseCreateFrame(body, { omitTransportFields: true });
    assert.equal('stream' in full || 'background' in full, false);
    const d = _buildResponseCreateFrame(body, { previousResponseId: 'resp_prev', inputOverride: [{ b: 2 }], omitTransportFields: true });
    assert.deepEqual([d.previous_response_id, d.input, 'stream' in d], ['resp_prev', [{ b: 2 }], false]);
});

test('transport policy: mode token aliases normalize', () => {
    assert.equal(_normalizeTransportMode('WS_FULL'), 'ws-full');
    assert.equal(_normalizeTransportMode('  ws delta '), 'ws-delta');
    assert.equal(_normalizeTransportMode('http/sse'), 'http-sse');
    assert.equal(_normalizeTransportMode('sse'), 'http-sse');
    assert.equal(_normalizeTransportMode('auto'), 'auto');
    assert.equal(_normalizeTransportMode('official'), null);
    assert.equal(_normalizeTransportMode(''), null);
    assert.equal(_normalizeTransportMode('bogus'), null);
});

test('transport policy: ws-delta drives _computeDelta to emit a delta frame', () => {
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
            // no turnState — refs mode must still delta
        };
        const delta = _computeDelta({ entry, body });
        assert.equal(delta.mode, 'delta');
        assert.equal(delta.frame.previous_response_id, 'resp_prev');
        assert.deepEqual(delta.frame.input, [body.input[1]]);
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

test('transport policy: ws-full forces _computeDelta to full (delta OFF)', () => {
    const prevTransport = process.env.MIXDOG_OAI_TRANSPORT;
    try {
        process.env.MIXDOG_OAI_TRANSPORT = 'ws-full';
        const body = { model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: 'hi' }] };
        const delta = _computeDelta({
            entry: {
                lastRequestSansInput: '{"model":"gpt-5.5"}',
                lastResponseId: 'resp_prev',
                lastRequestInput: body.input,
                lastResponseItems: [],
            },
            body,
        });
        assert.equal(delta.mode, 'full');
        assert.equal(delta.reason, 'full_default');
        assert.equal(delta.frame.previous_response_id, undefined);
    } finally {
        if (prevTransport == null) delete process.env.MIXDOG_OAI_TRANSPORT;
        else process.env.MIXDOG_OAI_TRANSPORT = prevTransport;
    }
});

// === 10b. Shared Responses transport policy (capability gating) ============
// resolveResponsesTransportPolicy generalizes the OpenAI switch across every
// Responses backend. Full-capability providers (OpenAI OAuth/direct) resolve
// byte-identically to resolveOpenAiTransportPolicy; xAI/Grok also carry WS
// delta capability, so default/ws-delta drive the OFFICIAL xAI continuation
// (previous_response_id + incremental input) rather than collapsing to
// 'ws-full'.

test('responses transport policy: full caps === legacy OpenAI resolver (byte-identical)', () => {
    for (const env of [
        {},
        { MIXDOG_OAI_TRANSPORT: 'ws-delta' },
        { MIXDOG_OAI_TRANSPORT: 'ws-full' },
        { MIXDOG_OAI_TRANSPORT: 'http-sse' },
        { MIXDOG_OAI_TRANSPORT: 'quantum' },
    ]) {
        const legacy = resolveOpenAiTransportPolicy(env);
        const shared = resolveResponsesTransportPolicy(env, RESPONSES_TRANSPORT_CAPABILITIES['openai-oauth']);
        assert.equal(shared.mode, legacy.mode);
        assert.equal(shared.transport, legacy.transport);
        assert.equal(shared.allowHttpFallback, legacy.allowHttpFallback);
        assert.deepEqual(shared.delta, legacy.delta);
    }
});

test('responses transport policy: openai direct caps match oauth (both full)', () => {
    const env = { MIXDOG_OAI_TRANSPORT: 'ws-delta' };
    const direct = resolveResponsesTransportPolicy(env, RESPONSES_TRANSPORT_CAPABILITIES.openai);
    assert.equal(direct.transport, 'ws');
    assert.deepEqual(direct.delta, { force: false, refs: true, optIn: true });
});

test('responses transport policy: xai auto is WS-first with HTTP fallback', () => {
    const p = resolveResponsesTransportPolicy({}, RESPONSES_TRANSPORT_CAPABILITIES.xai);
    assert.equal(p.mode, 'auto');
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, true);
    assert.deepEqual(p.delta, { force: false, refs: true, optIn: true });
});

test('responses transport policy: explicit auto is WS-first with HTTP fallback', () => {
    const p = resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'auto' }, RESPONSES_TRANSPORT_CAPABILITIES.xai);
    assert.equal(p.mode, 'auto');
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, true);
    assert.deepEqual(p.delta, { force: false, refs: true, optIn: true });
});

test('responses transport policy: xai ws-delta drives official continuation (refs delta ON)', () => {
    const p = resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'ws-delta' }, RESPONSES_TRANSPORT_CAPABILITIES.xai);
    assert.equal(p.requestedMode, 'ws-delta');
    assert.equal(p.mode, 'ws-delta');
    assert.equal(p.transport, 'ws');
    assert.equal(p.allowHttpFallback, false);
    // Official xAI continuation: previous_response_id + incremental input, no
    // sticky turn-state — refs delta ON.
    assert.deepEqual(p.delta, { force: false, refs: true, optIn: true });
});

test('responses transport policy: xai ws-full → WS, http-sse → HTTP', () => {
    const wsFull = resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'ws-full' }, RESPONSES_TRANSPORT_CAPABILITIES.xai);
    assert.equal(wsFull.transport, 'ws');
    assert.equal(wsFull.allowHttpFallback, false);
    const http = resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'http-sse' }, RESPONSES_TRANSPORT_CAPABILITIES.xai);
    assert.equal(http.transport, 'http');
    assert.equal(http.allowHttpFallback, false);
});

test('stream progress excludes transport and response acknowledgements from visible TTFT', () => {
    assert.equal(isVisibleStreamProgress('transport'), false);
    assert.equal(isVisibleStreamProgress('semantic'), false);
    assert.equal(isVisibleStreamProgress('text'), true);
    assert.equal(isVisibleStreamProgress('reasoning'), true);
    assert.equal(isVisibleStreamProgress('tool'), true);
    assert.equal(isVisibleStreamProgress(undefined), false);
    assert.equal(geminiChunkProgressKind({ usageMetadata: {} }), 'transport');
    assert.equal(geminiChunkProgressKind({
        candidates: [{ content: { parts: [{ thought: true, text: 'thinking' }] } }],
    }), 'reasoning');
    assert.equal(geminiChunkProgressKind({
        candidates: [{ content: { parts: [{ thought: true, thoughtSignature: 'opaque' }] } }],
    }), 'transport');
    assert.equal(geminiChunkProgressKind({
        candidates: [{ content: { parts: [{ text: 'answer' }] } }],
    }), 'text');
    assert.equal(geminiChunkProgressKind({
        candidates: [{ content: { parts: [{ functionCall: { name: 'read' } }] } }],
    }), 'tool');

    const turnSource = readFileSync(
        new URL('../../src/session-runtime/session-turn-api.mjs', import.meta.url),
        'utf8',
    );
    const recoverySource = readFileSync(
        new URL('../../src/runtime/agent/orchestrator/session/send-with-recovery.mjs', import.meta.url),
        'utf8',
    );
    assert.match(turnSource, /if \(isVisibleStreamProgress\(args\[0\]\)\)/);
    assert.match(recoverySource, /!turnFirstDelta && isVisibleStreamProgress\(kind\)/);
});

test('responses transport policy: _gateTransportMode down-shifts per capability', () => {
    // delta unsupported → ws-delta collapses to ws-full; others pass through.
    const noDelta = { ws: true, http: true, delta: false };
    assert.equal(_gateTransportMode('auto', noDelta), 'ws-full');
    assert.equal(_gateTransportMode('ws-delta', noDelta), 'ws-full');
    assert.equal(_gateTransportMode('ws-full', noDelta), 'ws-full');
    assert.equal(_gateTransportMode('http-sse', noDelta), 'http-sse');
    // WS unsupported → WS modes prefer HTTP.
    const httpOnly = { ws: false, http: true, delta: false };
    assert.equal(_gateTransportMode('auto', httpOnly), 'http-sse');
    assert.equal(_gateTransportMode('ws-full', httpOnly), 'http-sse');
    assert.equal(_gateTransportMode('ws-delta', httpOnly), 'http-sse');
    // HTTP unsupported → http-sse prefers full-frame WS.
    const wsOnly = { ws: true, http: false, delta: true };
    assert.equal(_gateTransportMode('http-sse', wsOnly), 'ws-full');
    // full caps pass everything through unchanged.
    for (const m of ['auto', 'ws-full', 'ws-delta', 'http-sse']) {
        assert.equal(_gateTransportMode(m, FULL_RESPONSES_TRANSPORT_CAPS), m);
    }
});

// === 11. x-codex-turn-state parity =======================================
// Server-issued sticky-routing token, held per logical turn: captured once
// from response metadata, replayed unchanged in later request metadata within
// that turn, never fabricated, and dropped between turns.
test('codex turn-state: captures server response header once, never synthesizes', () => {
    const entry = {};
    // No header on the event → nothing captured (never fabricated).
    _captureTurnStateFromEvent(entry, { type: 'response.created', headers: {} });
    assert.equal(entry.turnState, undefined);
    // Server issues the token on a response header → captured.
    _captureTurnStateFromEvent(entry, { type: 'response.created', headers: { 'x-codex-turn-state': 'tok-1' } });
    assert.equal(entry.turnState, 'tok-1');
    // Write-once semantics: a later server token in the same turn does NOT overwrite.
    _captureTurnStateFromEvent(entry, { headers: { 'x-codex-turn-state': 'tok-2' } });
    assert.equal(entry.turnState, 'tok-1');
});

test('codex turn-state: captures from nested response/metadata header shapes', () => {
    const fromResponse = {};
    _captureTurnStateFromEvent(fromResponse, { response: { headers: { 'x-codex-turn-state': 'tok-r' } } });
    assert.equal(fromResponse.turnState, 'tok-r');
    const fromMeta = {};
    _captureTurnStateFromEvent(fromMeta, { response: { metadata: { headers: { 'x-codex-turn-state': 'tok-m' } } } });
    assert.equal(fromMeta.turnState, 'tok-m');
});

test('codex turn-state: echoed within a turn, dropped across turns, never fabricated', () => {
    const sessionId = '019fc135-f07a-7880-8767-ec3b7be1de63';
    const turnA = '019fc135-f07a-7880-8767-ec3b7be1de64';
    const turnB = '019fc135-f07a-7880-8767-ec3b7be1de65';
    const ctxA = { sendOpts: { turnId: turnA, codexSessionId: sessionId, threadId: sessionId } };
    // A server-captured token with unknown owner (handshake/prewarm capture).
    const entry = { turnState: 'tok-A' };
    const f1 = _withCodexWsClientMetadata({}, entry, true, ctxA);
    assert.equal(f1.client_metadata['x-codex-turn-state'], 'tok-A');
    // First use attributes the token to the turn now on the wire.
    assert.equal(entry.turnStateTurnId, turnA);
    // Subsequent request in the SAME turn replays the same token.
    const f2 = _withCodexWsClientMetadata({}, entry, true, ctxA);
    assert.equal(f2.client_metadata['x-codex-turn-state'], 'tok-A');
    // Next turn: the token must be dropped, never replayed or fabricated.
    const ctxB = { sendOpts: { turnId: turnB, codexSessionId: sessionId, threadId: sessionId } };
    const f3 = _withCodexWsClientMetadata({}, entry, true, ctxB);
    assert.equal('x-codex-turn-state' in f3.client_metadata, false);
    assert.equal(entry.turnState, null);
});

test('codex turn-state: a prewarm response can seed its logical turn', () => {
    const sessionId = '019fc135-f07a-7880-8767-ec3b7be1de63';
    const firstTurnId = '019fc135-f07a-7880-8767-ec3b7be1de64';
    const nextTurnId = '019fc135-f07a-7880-8767-ec3b7be1de65';
    const poolKey = 'prewarm-turn-state-session';
    const entry = {};
    const prewarm = _withCodexWsClientMetadata({}, entry, true, {
        poolKey,
        sendOpts: {
            requestKind: 'prewarm',
            turnId: firstTurnId,
            codexSessionId: sessionId,
            threadId: sessionId,
        },
    });
    assert.equal(prewarm.client_metadata['x-codex-turn-state'], undefined);
    _captureTurnStateFromEvent(entry, {
        type: 'response.metadata',
        headers: { 'x-codex-turn-state': 'tok-prewarm' },
    });
    const firstTurn = _withCodexWsClientMetadata({}, entry, true, {
        poolKey,
        sendOpts: {
            requestKind: 'turn',
            turnId: firstTurnId,
            codexSessionId: sessionId,
            threadId: sessionId,
        },
    });
    assert.equal(firstTurn.client_metadata['x-codex-turn-state'], 'tok-prewarm');
    assert.equal(entry.turnStateTurnId, firstTurnId);

    const nextTurn = _withCodexWsClientMetadata({}, entry, true, {
        poolKey,
        sendOpts: {
            requestKind: 'turn',
            turnId: nextTurnId,
            codexSessionId: sessionId,
            threadId: sessionId,
        },
    });
    assert.equal('x-codex-turn-state' in nextTurn.client_metadata, false);
    assert.equal(entry.turnState, null);
});

test('codex turn-state: parity disabled leaves the frame untouched (no metadata, no echo)', () => {
    const entry = { turnState: 'tok-A' };
    const frame = { input: [] };
    const out = _withCodexWsClientMetadata(frame, entry, false, { sendOpts: { turnId: 'turn-A' } });
    assert.equal(out, frame);
    assert.equal(out.client_metadata, undefined);
});

// A connection handshake has a different lifetime from a logical turn.
// Upgrade headers are ignored and every fresh socket opens without turn state.
test('codex turn-state: never enters a connection handshake', async () => {
    const fakeSocket = () => {
        const socket = new EventEmitter();
        socket.readyState = 1; // WebSocket.OPEN
        socket.close = () => {
            if (socket.readyState === 3) return;
            socket.readyState = 3;
            socket.emit('close');
        };
        socket.terminate = socket.close;
        socket.ref = () => {};
        socket.unref = () => {};
        return socket;
    };
    const openedWith = [];
    _clearWebSocketPoolForTest();
    _setOpenSocketForTest(async ({ turnState }) => {
        openedWith.push(turnState ?? null);
        // Even if an upgrade response exposes a token, connection acquisition
        // must ignore it; response metadata owns turn-state capture.
        return { socket: fakeSocket(), turnState: openedWith.length === 1 ? 'tok-shard-1' : null };
    });
    try {
        const auth = { type: 'openai-oauth', account_id: 'acct-1' };
        const poolKey = 'sess-turn-state-1';
        const cacheKey = 'cache-turn-state-1';

        const first = await acquireWebSocket({ auth, poolKey, cacheKey });
        assert.equal(openedWith[0], null);
        assert.equal(first.entry.turnState, null);

        // The socket dies while pooled; the next acquire prunes it and opens a
        // replacement.
        releaseWebSocket({ entry: first.entry, poolKey, keep: true });
        first.entry.socket.readyState = 3; // CLOSED

        const replacement = await acquireWebSocket({ auth, poolKey, cacheKey });
        assert.equal(openedWith[1], null);
        assert.equal(replacement.entry.turnState, null);

        // A concurrent acquire for the same session waits for the live owner
        // and then reuses it instead of opening a sibling connection.
        let parallelResolved = false;
        const parallelPromise = acquireWebSocket({ auth, poolKey, cacheKey }).then((value) => {
            parallelResolved = true;
            return value;
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(parallelResolved, false);
        assert.equal(openedWith.length, 2);
        releaseWebSocket({ entry: replacement.entry, poolKey, keep: true });
        const parallel = await parallelPromise;
        assert.equal(parallel.entry, replacement.entry);
        assert.equal(openedWith.length, 2);

        // A different session never inherits the pin.
        const other = await acquireWebSocket({ auth, poolKey: 'sess-turn-state-2', cacheKey });
        assert.equal(openedWith[2], null);

        releaseWebSocket({ entry: other.entry, poolKey: 'sess-turn-state-2', keep: false });
        releaseWebSocket({ entry: parallel.entry, poolKey, keep: false });
    } finally {
        _setOpenSocketForTest(null);
        _clearWebSocketPoolForTest();
    }
});
