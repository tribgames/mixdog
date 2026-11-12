#!/usr/bin/env node
// openai-ws-delta.test.mjs (13 tests): the real WS delta computation (`_computeDelta`), canonical frame builder, tool_search argument
// parser, mismatch diagnostics, cache observation helpers and `sendViaWebSocket`'s trace rows (the one transport case, :262, goes over a real loopback WebSocket), with MIXDOG_OAI_TRANSPORT set as the test sets it.
//   node benchmarks/rust-core/recorders/record-openai-ws-delta.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  pure: {
    'default-delta-*': 'mixdog-ai/src/providers/openai/delta.rs (`pub mod delta` at providers/openai/mod.rs:11): compute(&Chain, &body) -> Framed :284, response_create :207, sans_input :25, logical_item_match :84, Chain::anchor :180',
    'ws-delta-*': 'mixdog-ai/src/providers/openai/delta.rs (`pub mod delta` at providers/openai/mod.rs:11): compute(&Chain, &body) -> Framed :284, response_create :207, sans_input :25, logical_item_match :84, Chain::anchor :180',
    'canonical-*': 'mixdog-ai/src/providers/openai/delta.rs (`pub mod delta` at providers/openai/mod.rs:11): compute(&Chain, &body) -> Framed :284, response_create :207, sans_input :25, logical_item_match :84, Chain::anchor :180',
    'message-mismatch-diagnostics-hash-content': 'openai/delta.rs:84 logical_item_match (pub) decides the mismatch; the diagnostic content hashes are trace fields with no Rust counterpart (looked in openai/delta.rs: no hash fn)',
    'diagnostic-hashes-*': 'RUST WORK: diagnostic hashes of normalized request forms have no Rust counterpart (looked in openai/delta.rs and openai/cache_key.rs)',
    'tool-search-*': 'RUST WORK: no public Rust parser of the tool_search arguments (looked in openai/input.rs and openai/decoder.rs: the arguments are decoded inside ResponsesDecoder, not a public function)',
    'native-tool-search-*': 'RUST WORK: the canonical replay of a native tool-search output is part of the private input lowering (openai/input.rs), reached only through the codec encode (wire)',
    'cache-observation-*': 'RUST WORK: cache observation / continuity reset reasons are trace fields of the Node sender; no public Rust function (looked in openai/cache_key.rs, openai/continuation.rs)',
  },
  set: 'provider-openai-ws-delta',
  exclusions: ['result...results[].result.transportTiming.*Ms: measured with the real performance clock (declared mask); the other fields are compared'],
  // The send's own timing report (`transportTiming`, `*Ms` fields) is measured with the real performance clock: those numbers are replaced by a marker at this declared path only.
  maskRow: (row) => {
    const walk = (value) => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== 'object') return;
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'transportTiming' && inner && typeof inner === 'object') {
          for (const k of Object.keys(inner)) if (/Ms$/.test(k) && typeof inner[k] === 'number') inner[k] = '<ms, real clock>';
        } else walk(inner);
      }
    };
    walk(row.result);
  },
  net: false,
  entry: 'openai-ws-delta.mjs _computeDelta / _buildResponseCreateFrame / _sansInput / _stableStringify, openai-oauth-ws.mjs parseToolSearchArgs / _cacheObservationForTest / _cacheContinuityResetReasonForTest / sendViaWebSocket (over a real loopback WebSocket; _agentTraceFn collects the trace rows); Not run: the seams of the Node test (:316-318); the real acquire, send and stream run instead, openai-compat-stream.mjs isInvalidToolArgsMarker.',
  compare: 'mixdog-ai providers::openai delta.rs (:197-298) and decoder.rs:271-287; mixdog-trace builders.rs:765-781 (no production caller: K1 gaps G12): compare `result` whole (frame mode/reason/previous_response_id/input, hashes of the mismatch diagnostics, parsed tool_search args, cache observations). `traceRows` are the rows Node writes; Rust writes none today (diagnostic only).',
  replay: "PURE cases, per `levels`: mixdog-ai/src/providers/openai/delta.rs (`pub mod delta` at providers/openai/mod.rs:11): compute(&Chain, &body) -> Framed :284, response_create :207, sans_input :25, logical_item_match :84, Chain::anchor :180 (the delta chain and frame builders). WIRE case (mismatch-diagnostics-reach-trace-rows): the OpenAI WS send through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) against a loopback WebSocket. Cases marked RUST WORK have no public Rust function of the same input and output.",
});
const P = 'agent/orchestrator/providers/';
const { isInvalidToolArgsMarker } = await rec.P(`${P}openai-compat-stream.mjs`);
const { _computeDelta, _buildResponseCreateFrame, _sansInput, _stableStringify } = await rec.P(`${P}openai-ws-delta.mjs`);
const { _cacheObservationForTest, _cacheContinuityResetReasonForTest, sendViaWebSocket, parseToolSearchArgs } = await rec.P(`${P}openai-oauth-ws.mjs`);
const world = await rec.wsWorld();
const SRC = 'scripts/provider-toolcall/openai-ws-delta.test.mjs';
const withEnv = async (value, fn) => {
  const prev = process.env.MIXDOG_OAI_TRANSPORT;
  try {
    if (value == null) delete process.env.MIXDOG_OAI_TRANSPORT;
    else process.env.MIXDOG_OAI_TRANSPORT = value;
    return await fn();
  } finally {
    if (prev == null) delete process.env.MIXDOG_OAI_TRANSPORT;
    else process.env.MIXDOG_OAI_TRANSPORT = prev;
  }
};
const msg = (role, content) => ({ type: 'message', role, content });

await rec.run('default-delta-falls-back-on-request-property-mismatch', `${SRC}:44`, {}, () => withEnv(null, () => {
  const body = { model: 'gpt-5.5', input: [msg('user', 'hi')] };
  const entry = { lastRequestSansInput: '{}', lastResponseId: 'resp_prev', lastRequestInput: body.input, lastResponseItems: [] };
  return { body, entry, delta: _computeDelta({ entry, body }) };
}));
await rec.run('ws-delta-previous-response-id-safe-fallbacks', `${SRC}:60`, { env: 'ws-delta' }, () => withEnv('ws-delta', () => {
  const body = { model: 'gpt-5.5', input: [msg('user', 'prev'), msg('user', 'next')] };
  const entry = { lastRequestSansInput: '{"model":"gpt-5.5"}', lastResponseId: 'resp_prev', lastRequestInput: [body.input[0]], lastResponseItems: [] };
  const responseEntry = { ...entry, lastRequestInput: [body.input[0]], lastResponseItems: [{ type: 'function_call', call_id: 'call_1', name: 'tool', arguments: '{"api_key":"provider-function-secret","nested":{"z":2,"a":1}}' }] };
  const responseBody = { ...body, input: [body.input[0], { type: 'function_call', call_id: 'call_other', name: 'tool', arguments: '{"nested":{"a":1,"z":2},"api_key":"replayed-function-secret"}' }, body.input[1]] };
  const out = {
    refs: _computeDelta({ entry, body }),
    changed: _computeDelta({ entry, body: { ...body, model: 'gpt-5.6' } }),
    noAnchor: _computeDelta({ entry: { ...entry, lastResponseId: null }, body }),
    prefixMismatch: _computeDelta({ entry: { ...entry, lastRequestInput: [msg('user', 'other')] }, body }),
    responseMismatch: _computeDelta({ entry: responseEntry, body: responseBody }),
  };
  const traceSafe = JSON.stringify(out.responseMismatch.responseOutputMismatch);
  return { ...out, traceSafe: ['call_other', 'provider-function-secret', 'replayed-function-secret'].map((s) => [s, traceSafe.includes(s)]) };
}));
// Over a real WebSocket: send 1 learns the response (resp_prev + the expected output item); send 2 replays a different item, so the product itself
// builds the mismatch diagnostics and writes them to the trace rows. The trace sink (`_agentTraceFn`) is an output hook: its rows are events of the case.
await rec.run('mismatch-diagnostics-reach-trace-rows', `${SRC}:262`, { env: 'ws-delta', sends: 'two sendViaWebSocket calls per item type on one pool key, a real loopback WebSocket' }, () => withEnv('ws-delta', async () => {
  const prior = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prior' }] };
  const cases = [
    { expected: { type: 'function_call', call_id: 'call_expected', name: 'tool', arguments: '{"api_key":"provider-function-secret","nested":{"z":2,"a":1}}' }, actual: { type: 'function_call', call_id: 'call_actual', name: 'tool', arguments: '{"nested":{"a":1,"z":2},"api_key":"replayed-function-secret"}' } },
    { expected: { type: 'custom_tool_call', call_id: 'custom_expected', name: 'apply_patch', input: 'provider-custom-input-secret' }, actual: { type: 'custom_tool_call', call_id: 'custom_actual', name: 'apply_patch', input: 'replayed-custom-input-secret' } },
  ];
  const sends = [];
  for (const { expected, actual } of cases) {
    const answers = [
      [{ type: 'response.created', response: { id: 'resp_prev', model: 'gpt-5.5' } }, { type: 'response.completed', response: { id: 'resp_prev', model: 'gpt-5.5', output: [expected], usage: { input_tokens: 1, output_tokens: 1 } } }],
      [{ type: 'response.created', response: { id: 'resp_next', model: 'gpt-5.5' } }, { type: 'response.completed', response: { id: 'resp_next', model: 'gpt-5.5', output: [], usage: { input_tokens: 1, output_tokens: 1 } } }],
    ];
    world.reset({ onFrame: (conn, _frame, n) => { for (const frame of answers[n - 1]) conn.send(frame); } });
    const rows = [];
    const send = async (body, phase) => {
      world.note({ event: 'send-start', phase, type: expected.type });
      const out = await sendViaWebSocket({
        auth: { type: 'xai', access_token: 'test-token' }, body, poolKey: `mismatch-trace-${expected.type}`, cacheKey: 'mismatch-trace-test', iteration: 1, useModel: 'gpt-5.5', traceProvider: 'xai',
        _agentTraceFn: (row) => { rows.push(row); world.note({ event: 'trace-row', row }); },
      });
      world.note({ event: 'send-result', phase, content: out.content, responseId: out.responseId });
      return out;
    };
    await send({ model: 'gpt-5.5', input: [prior] }, 'learn');
    await send({ model: 'gpt-5.5', input: [prior, actual] }, 'replay-with-mismatch');
    sends.push({ type: expected.type, events: world.trace.map((e) => ({ ...e })) });
    for (const conn of world.conns) conn.close(1000, 'recorder-end');
    await world.until((trace) => trace.some((e) => e.event === 'closed'), 'socket closed');
  }
  const text = JSON.stringify(sends.map((s) => s.events.filter((e) => e.event === 'trace-row')));
  return { sends, secretsInTrace: ['provider-function-secret', 'replayed-function-secret', 'provider-custom-input-secret', 'replayed-custom-input-secret'].map((s) => [s, text.includes(s)]) };
}));
await rec.run('canonical-full-frame-key-order', `${SRC}:402`, {}, () => {
  const body = { model: 'gpt-5.5', instructions: 'sys', input: [msg('user', 'hi')], tool_choice: 'auto', parallel_tool_calls: true, reasoning: { effort: 'medium' }, store: false, stream: true, include: ['reasoning.encrypted_content'], prompt_cache_key: 'k', text: { verbosity: 'low' } };
  const frame = _buildResponseCreateFrame(body);
  return { body, frame, frameKeys: Object.keys(frame), frameJson: JSON.stringify(frame) };
});
await rec.run('canonical-delta-frame-key-order', `${SRC}:426`, {}, () => {
  const body = { model: 'gpt-5.5', instructions: 'sys', input: [{ a: 1 }, { b: 2 }], tool_choice: 'auto', text: { verbosity: 'low' } };
  const delta = _buildResponseCreateFrame(body, { previousResponseId: 'resp_prev', inputOverride: [{ b: 2 }] });
  const noInstr = _buildResponseCreateFrame({ ...body, instructions: '' }, { previousResponseId: 'resp_prev', inputOverride: [] });
  return { body, delta, deltaKeys: Object.keys(delta), noInstr, noInstrKeys: Object.keys(noInstr) };
});
// ---- the helper-level cases, observed where a caller can observe them: the frames the client writes, the events of the stream, and the trace rows of the send ----
// One exchange on a real loopback WebSocket: the sends of `steps` go through sendViaWebSocket on one pool key (xai auth), the server answers the n-th request frame with steps[n-1].answer; every frame,
// the callbacks and the trace rows the send writes (`_agentTraceFn`, an output hook) are events of the ordered list.
const created = (id) => ({ type: 'response.created', response: { id, model: 'gpt-5.5' } });
const done = (id, output, usage = { input_tokens: 1, output_tokens: 1 }) => ({ type: 'response.completed', response: { id, model: 'gpt-5.5', output, usage } });
async function exchange(key, steps) {
  world.reset({ onFrame: (conn, _frame, n) => { for (const frame of steps[n - 1].answer) conn.send(frame); } });
  const results = [];
  for (const step of steps) {
    world.note({ event: 'send-start', phase: step.phase });
    const out = await sendViaWebSocket({
      auth: { type: 'xai', access_token: 'test-token' }, body: step.body, poolKey: key, cacheKey: 'ws-delta-wire', iteration: 1, useModel: 'gpt-5.5', traceProvider: 'xai',
      onToolCall: (call) => world.note({ event: 'tool', call }),
      _agentTraceFn: (row) => world.note({ event: 'trace-row', row }),
    }).then((result) => ({ result }), (error) => ({ error }));
    world.note({ event: 'send-result', phase: step.phase });
    results.push({ phase: step.phase, ...out });
  }
  const events = world.trace.map((x) => ({ ...x }));
  for (const conn of world.conns) conn.close(1000, 'recorder-end');
  await world.until((trace) => trace.some((x) => x.event === 'closed'), 'socket closed');
  return { results, events };
}
const searchCall = (args) => ({ type: 'tool_search_call', id: 'ts_1', call_id: 'call_ts', execution: 'client', ...(args === undefined ? {} : { arguments: args }) });
const searchTurn = (key, args) => exchange(key, [{ phase: 'search', body: { model: 'gpt-5.5', input: [msg('user', 'load tools')] }, answer: [created('resp_ts'), { type: 'response.output_item.done', item: searchCall(args) }, done('resp_ts', [searchCall(args)])] }]);
await rec.run('tool-search-malformed-args-marker', `${SRC}:21`, { arguments: '{"query": dispatchAiWrapped}' }, () => searchTurn('ts-malformed', '{"query": dispatchAiWrapped}'));
await rec.run('tool-search-valid-object-empty-preserved', `${SRC}:30`, { arguments: ['{"query":"x"}', { query: 'y' }, '', '   ', null, 'absent'] }, async () => {
  const variants = { validString: '{"query":"x"}', object: { query: 'y' }, empty: '', whitespace: '   ', nul: null, absent: undefined };
  const out = {};
  for (const [name, args] of Object.entries(variants)) out[name] = await searchTurn(`ts-${name}`, args);
  return out;
});
const prior = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prior' }] };
const replayPair = (key, expected, actual) => exchange(key, [
  { phase: 'learn', body: { model: 'gpt-5.5', input: [prior] }, answer: [created('resp_prev'), done('resp_prev', [expected])] },
  { phase: 'replay-with-mismatch', body: { model: 'gpt-5.5', input: [prior, actual] }, answer: [created('resp_next'), done('resp_next', [])] },
]);
const out = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const inp = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'input_text', text }] });
await rec.run('message-mismatch-diagnostics-hash-content', `${SRC}:161`, { expected: 'provider secret (output_text)', actual: 'replayed secret (input_text)' }, async () => {
  const exchanged = await replayPair('diag-message', out('provider secret'), inp('replayed secret'));
  const text = JSON.stringify(exchanged.events.filter((e) => e.event === 'trace-row'));
  return { ...exchanged, leaks: ['provider secret', 'replayed secret'].map((s) => [s, text.includes(s)]) };
});
await rec.run('diagnostic-hashes-normalize-equivalent-forms', `${SRC}:195`, { pairs: ['message: expected output_text "same sensitive message" vs the same text replayed as input_text', 'function_call: arguments in two key orders'] }, async () => {
  const fn = (key, args) => replayPair(key, { type: 'function_call', call_id: 'call_same', name: 'tool', arguments: args }, { type: 'function_call', call_id: 'call_different', name: 'tool', arguments: '{"ignored":"replayed-function-secret"}' });
  return {
    messageExpected: await replayPair('norm-msg-a', out('same sensitive message'), out('different message')),
    messageActual: await replayPair('norm-msg-b', out('different message'), inp('same sensitive message')),
    functionA: await fn('norm-fn-a', '{"api_key":"function-secret","nested":{"z":2,"a":1}}'),
    functionB: await fn('norm-fn-b', '{"nested":{"a":1,"z":2},"api_key":"function-secret"}'),
  };
});
await rec.run('native-tool-search-output-replays-canonically', `${SRC}:351`, { env: 'ws-delta' }, () => withEnv('ws-delta', async () => {
  const tools = [{ type: 'tool_search', execution: 'client', description: 'load tools', parameters: { type: 'object', properties: {} } }];
  const call = { type: 'tool_search_call', call_id: 'call_load_1', execution: 'client', arguments: { names: ['read'] } };
  const output = { type: 'tool_search_output', call_id: 'call_load_1', status: 'completed', execution: 'client', tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }] };
  const base = { model: 'gpt-5.5', instructions: 'sys', tools, prompt_cache_key: 'cache-key' };
  return exchange('native-tool-search', [
    { phase: 'learn', body: { ...base, input: [msg('user', 'load read')] }, answer: [created('resp_prev'), done('resp_prev', [call])] },
    { phase: 'replay', body: { ...base, input: [msg('user', 'load read'), call, output, msg('user', 'use read')] }, answer: [created('resp_next'), done('resp_next', [])] },
  ]);
}));
await rec.run('cache-observation-warm-zero-and-retreats', `${SRC}:455`, { scenarios: ['zero', 'partial', 'healthy', 'compacted'] }, async () => {
  const usage = (input, cached) => ({ input_tokens: input, output_tokens: 1, input_tokens_details: { cached_tokens: cached } });
  const scenario = (key, maxCached, second, secondBody) => exchange(key, [
    { phase: 'learn', body: { model: 'gpt-5.5', input: [msg('user', 'old long transcript')] }, answer: [created('resp_a'), done('resp_a', [], usage(maxCached + 1000, maxCached))] },
    { phase: 'replay', body: secondBody ?? { model: 'gpt-5.5', input: [msg('user', 'old long transcript'), msg('user', 'next')] }, answer: [created('resp_b'), done('resp_b', [], usage(second.input, second.cached))] },
  ]);
  return {
    zero: await scenario('cache-zero', 47_616, { input: 59_000, cached: 0 }),
    partial: await scenario('cache-partial', 101_888, { input: 102_456, cached: 60_928 }),
    healthy: await scenario('cache-healthy', 101_888, { input: 106_468, cached: 103_424 }),
    compacted: await scenario('cache-compacted', 255_488, { input: 21_066, cached: 8_704 }, { model: 'gpt-5.5', input: [msg('user', 'compact summary')] }),
  };
});
await rec.finish();
