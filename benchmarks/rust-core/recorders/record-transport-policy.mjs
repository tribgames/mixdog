#!/usr/bin/env node
// transport-policy.test.mjs (24 tests): the real OpenAI/Responses transport policy resolvers over scripted env maps, the WS frame builder
// and delta computation (`_computeDelta`, env set as the test sets it), the Codex turn-state capture/echo helpers, the stream-progress
// classifiers and the WebSocket pool (`acquireWebSocket` / `releaseWebSocket`) over a scripted socket opener (`_setOpenSocketForTest`: the
// scripted external side; the pool, its owner wait and reuse are the real code).
//   node benchmarks/rust-core/recorders/record-transport-policy.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-transport-policy',
  net: false,
  entry: 'openai-transport-policy.mjs resolveOpenAiTransportPolicy / resolveResponsesTransportPolicy / _normalizeTransportMode / _gateTransportMode, openai-ws-delta.mjs _computeDelta / _buildResponseCreateFrame, openai-codex-metadata.mjs _withCodexWsClientMetadata, openai-ws-stream.mjs _captureTurnStateFromEvent, gemini-stream.mjs geminiChunkProgressKind, shared/stream-progress.mjs isVisibleStreamProgress, openai-ws-pool.mjs acquireWebSocket / releaseWebSocket with _setOpenSocketForTest(opener) scripted. Not run: a real socket.',
  compare: 'mixdog-ai registry builder.rs:461-467 (transport mapping; K1 gaps G11: ws-full/ws-delta env pins), providers::openai delta.rs / client_meta.rs:108-147 / pool.rs:178-230, and mixdog-core stream-progress: feed `input` and compare `result` whole.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::openai::OpenAiAdapter (openai/adapter.rs:308) with OpenAiCodec (openai/codec.rs:36) and build_body (openai/profile.rs:497), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079); the socket pool is WsPool::checkout (openai/pool.rs:178). The mode selection is DefaultProviderBuilder::build (registry/builder.rs:1295).",
});
const P = 'agent/orchestrator/providers/';
const policy = await rec.P(`${P}openai-transport-policy.mjs`);
const { _computeDelta, _buildResponseCreateFrame } = await rec.P(`${P}openai-ws-delta.mjs`);
const { _withCodexWsClientMetadata } = await rec.P(`${P}openai-codex-metadata.mjs`);
const { _captureTurnStateFromEvent } = await rec.P(`${P}openai-ws-stream.mjs`);
const { geminiChunkProgressKind } = await rec.P(`${P}gemini-stream.mjs`);
const { isVisibleStreamProgress } = await rec.P('shared/stream-progress.mjs');
const { acquireWebSocket, releaseWebSocket, _clearWebSocketPoolForTest } = await rec.raw(`${P}openai-ws-pool.mjs`);
const { resolveOpenAiTransportPolicy, _normalizeTransportMode, resolveResponsesTransportPolicy, RESPONSES_TRANSPORT_CAPABILITIES, _gateTransportMode, FULL_RESPONSES_TRANSPORT_CAPS } = policy;
const SRC = 'scripts/provider-toolcall/transport-policy.test.mjs';
const run = (id, line, input, fn) => rec.run(id, `${SRC}:${line}`, input, fn);
const envs = [{}, { MIXDOG_OAI_TRANSPORT: 'ws-full' }, { MIXDOG_OAI_TRANSPORT: 'ws-delta' }, { MIXDOG_OAI_TRANSPORT: 'http-sse' }, { MIXDOG_OAI_TRANSPORT: 'quantum' }];

await run('policy-defaults-and-modes', 24, { envs }, () => envs.map((env) => ({ env, policy: resolveOpenAiTransportPolicy(env) })));
const frameBody = { model: 'gpt-5.5', input: [{ a: 1 }, { b: 2 }], stream: true, background: false, text: { verbosity: 'low' } };
await run('response-frame-omits-transport-fields', 60, { body: frameBody }, () => ({
  full: _buildResponseCreateFrame(frameBody, { omitTransportFields: true }),
  delta: _buildResponseCreateFrame(frameBody, { previousResponseId: 'resp_prev', inputOverride: [{ b: 2 }], omitTransportFields: true }),
}));
const aliases = ['WS_FULL', '  ws delta ', 'http/sse', 'sse', 'auto', 'official', '', 'bogus'];
await run('mode-token-aliases', 78, { aliases }, () => aliases.map((a) => [a, _normalizeTransportMode(a)]));
const withEnv = (value, fn) => {
  const prev = process.env.MIXDOG_OAI_TRANSPORT;
  try {
    process.env.MIXDOG_OAI_TRANSPORT = value;
    return fn();
  } finally {
    if (prev == null) delete process.env.MIXDOG_OAI_TRANSPORT;
    else process.env.MIXDOG_OAI_TRANSPORT = prev;
  }
};
await run('ws-delta-drives-computeDelta-delta-frame', 89, { env: 'ws-delta' }, () => withEnv('ws-delta', () => {
  const body = { model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: 'prev' }, { type: 'message', role: 'user', content: 'next' }] };
  const entry = { lastRequestSansInput: '{"model":"gpt-5.5"}', lastResponseId: 'resp_prev', lastRequestInput: [body.input[0]], lastResponseItems: [] };
  return { body, entry, delta: _computeDelta({ entry, body }) };
}));
await run('ws-full-forces-computeDelta-full', 117, { env: 'ws-full' }, () => withEnv('ws-full', () => {
  const body = { model: 'gpt-5.5', input: [{ type: 'message', role: 'user', content: 'hi' }] };
  const entry = { lastRequestSansInput: '{"model":"gpt-5.5"}', lastResponseId: 'resp_prev', lastRequestInput: body.input, lastResponseItems: [] };
  return { body, entry, delta: _computeDelta({ entry, body }) };
}));
await run('responses-policy-full-caps-equal-legacy', 148, { envs }, () => envs.map((env) => {
  const legacy = resolveOpenAiTransportPolicy(env);
  const shared = resolveResponsesTransportPolicy(env, RESPONSES_TRANSPORT_CAPABILITIES['openai-oauth']);
  return { env, legacy, shared, equal: shared.mode === legacy.mode && shared.transport === legacy.transport && shared.allowHttpFallback === legacy.allowHttpFallback && JSON.stringify(shared.delta) === JSON.stringify(legacy.delta) };
}));
await run('responses-policy-capabilities-table', 165, {}, () => ({ capabilities: RESPONSES_TRANSPORT_CAPABILITIES, full: FULL_RESPONSES_TRANSPORT_CAPS }));
await run('responses-policy-openai-direct-ws-delta', 165, { env: { MIXDOG_OAI_TRANSPORT: 'ws-delta' } }, () => ({ direct: resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'ws-delta' }, RESPONSES_TRANSPORT_CAPABILITIES.openai) }));
await run('responses-policy-xai', 172, {}, () => {
  const xai = RESPONSES_TRANSPORT_CAPABILITIES.xai;
  return {
    auto: resolveResponsesTransportPolicy({}, xai),
    explicitAuto: resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'auto' }, xai),
    wsDelta: resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'ws-delta' }, xai),
    wsFull: resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'ws-full' }, xai),
    httpSse: resolveResponsesTransportPolicy({ MIXDOG_OAI_TRANSPORT: 'http-sse' }, xai),
  };
});
await run('stream-progress-visible-ttft', 214, {}, () => ({
  visible: Object.fromEntries(['transport', 'semantic', 'text', 'reasoning', 'tool'].map((k) => [k, isVisibleStreamProgress(k)])),
  undefinedKind: isVisibleStreamProgress(undefined),
  gemini: [
    { usageMetadata: {} },
    { candidates: [{ content: { parts: [{ thought: true, text: 'thinking' }] } }] },
    { candidates: [{ content: { parts: [{ thought: true, thoughtSignature: 'opaque' }] } }] },
    { candidates: [{ content: { parts: [{ text: 'answer' }] } }] },
    { candidates: [{ content: { parts: [{ functionCall: { name: 'read' } }] } }] },
  ].map((chunk) => ({ chunk, kind: geminiChunkProgressKind(chunk) })),
}));
await run('gate-transport-mode-down-shifts', 248, {}, () => {
  const caps = { noDelta: { ws: true, http: true, delta: false }, httpOnly: { ws: false, http: true, delta: false }, wsOnly: { ws: true, http: false, delta: true } };
  const modes = ['auto', 'ws-full', 'ws-delta', 'http-sse'];
  return { caps, gated: Object.fromEntries(Object.entries({ ...caps, full: FULL_RESPONSES_TRANSPORT_CAPS }).map(([name, c]) => [name, modes.map((m) => [m, _gateTransportMode(m, c)])])) };
});
await run('turn-state-captured-once-never-synthesized', 272, {}, () => {
  const entry = {};
  const steps = [];
  for (const event of [{ type: 'response.created', headers: {} }, { type: 'response.created', headers: { 'x-codex-turn-state': 'tok-1' } }, { headers: { 'x-codex-turn-state': 'tok-2' } }]) {
    _captureTurnStateFromEvent(entry, event);
    steps.push({ event, turnState: entry.turnState });
  }
  return { steps };
});
await run('turn-state-nested-header-shapes', 285, {}, () => {
  const fromResponse = {};
  _captureTurnStateFromEvent(fromResponse, { response: { headers: { 'x-codex-turn-state': 'tok-r' } } });
  const fromMeta = {};
  _captureTurnStateFromEvent(fromMeta, { response: { metadata: { headers: { 'x-codex-turn-state': 'tok-m' } } } });
  return { fromResponse, fromMeta };
});
const sessionId = '019fc135-f07a-7880-8767-ec3b7be1de63';
const turnA = '019fc135-f07a-7880-8767-ec3b7be1de64';
const turnB = '019fc135-f07a-7880-8767-ec3b7be1de65';
await run('turn-state-echoed-within-turn-dropped-across', 294, { sessionId, turnA, turnB }, () => {
  const ctx = (turnId) => ({ sendOpts: { turnId, codexSessionId: sessionId, threadId: sessionId } });
  const entry = { turnState: 'tok-A' };
  const f1 = _withCodexWsClientMetadata({}, entry, true, ctx(turnA));
  const afterF1 = { ...entry };
  const f2 = _withCodexWsClientMetadata({}, entry, true, ctx(turnA));
  const f3 = _withCodexWsClientMetadata({}, entry, true, ctx(turnB));
  return { f1, afterF1, f2, f3, entryAfter: entry };
});
await run('turn-state-prewarm-seeds-logical-turn', 315, { sessionId, firstTurnId: turnA, nextTurnId: turnB }, () => {
  const poolKey = 'prewarm-turn-state-session';
  const entry = {};
  const send = (requestKind, turnId) => ({ poolKey, sendOpts: { requestKind, turnId, codexSessionId: sessionId, threadId: sessionId } });
  const prewarm = _withCodexWsClientMetadata({}, entry, true, send('prewarm', turnA));
  _captureTurnStateFromEvent(entry, { type: 'response.metadata', headers: { 'x-codex-turn-state': 'tok-prewarm' } });
  const firstTurn = _withCodexWsClientMetadata({}, entry, true, send('turn', turnA));
  const afterFirst = { ...entry };
  const nextTurn = _withCodexWsClientMetadata({}, entry, true, send('turn', turnB));
  return { prewarm, firstTurn, afterFirst, nextTurn, entryAfter: entry };
});
await run('turn-state-parity-disabled-untouched', 360, {}, () => {
  const entry = { turnState: 'tok-A' };
  const frame = { input: [] };
  const out = _withCodexWsClientMetadata(frame, entry, false, { sendOpts: { turnId: 'turn-A' } });
  return { out, isSameFrame: out === frame, entryAfter: entry };
});
await run('turn-state-never-enters-connection-handshake', 370, { server: 'the first connection\'s 101 response carries x-codex-turn-state: tok-shard-1; later connections carry none', steps: ['acquire (poolKey sess-turn-state-1)', 'release keep, server closes that socket', 'acquire again (replacement)', 'parallel acquire for the same session, 1 ms of virtual time', 'release replacement keep', 'acquire another session', 'release both without keep'] }, async () => {
  const world = await rec.wsWorld();
  world.reset({ upgradeHeaders: () => (world.count((e) => e.event === 'upgrade-request') === 1 ? [['x-codex-turn-state', 'tok-shard-1']] : []) });
  const upgrades = () => world.count((e) => e.event === 'upgrade-request');
  _clearWebSocketPoolForTest();
  const connection = (entry) => rec.describe(entry, { $connection: 'provider client socket: a real WebSocket to the loopback server' });
  try {
    const auth = { type: 'openai-oauth', access_token: 'fixture-access-token', account_id: 'acct-1' };
    const poolKey = 'sess-turn-state-1';
    const cacheKey = 'cache-turn-state-1';
    const first = await acquireWebSocket({ auth, poolKey, cacheKey });
    connection(first.entry);
    const firstState = { opened: upgrades(), turnState: first.entry.turnState };
    releaseWebSocket({ entry: first.entry, poolKey, keep: true });
    world.conns[0].close(1000, 'server-ends-first-socket');
    await world.until((x) => x.some((e) => e.event === 'closed'), 'first socket closed');
    const replacement = await acquireWebSocket({ auth, poolKey, cacheKey });
    connection(replacement.entry);
    const replacementState = { opened: upgrades(), turnState: replacement.entry.turnState };
    // A concurrent acquire for the same session waits for the live owner: after 1 ms of virtual time (every due timer run) it has not resolved.
    let parallelResolved = false;
    const parallelPromise = acquireWebSocket({ auth, poolKey, cacheKey }).then((value) => { parallelResolved = true; return value; });
    await rec.clock.advance(1, { what: 'owner wait' });
    const waiting = { resolved: parallelResolved, opened: upgrades() };
    releaseWebSocket({ entry: replacement.entry, poolKey, keep: true });
    const parallel = await parallelPromise;
    connection(parallel.entry);
    const reused = { sameEntry: parallel.entry === replacement.entry, opened: upgrades() };
    const other = await acquireWebSocket({ auth, poolKey: 'sess-turn-state-2', cacheKey });
    connection(other.entry);
    const otherState = { opened: upgrades() };
    releaseWebSocket({ entry: other.entry, poolKey: 'sess-turn-state-2', keep: false });
    releaseWebSocket({ entry: parallel.entry, poolKey, keep: false });
    await world.until((x) => x.filter((e) => e.event === 'closed').length >= 3, 'sockets closed after release');
    return { firstState, replacementState, waiting, reused, otherState, events: world.trace.map((e) => ({ ...e })) };
  } finally {
    _clearWebSocketPoolForTest();
  }
});
await rec.finish();
