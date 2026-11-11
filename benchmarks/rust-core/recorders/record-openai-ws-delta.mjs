#!/usr/bin/env node
// openai-ws-delta.test.mjs (13 tests): the real WS delta computation (`_computeDelta`), canonical frame builder, tool_search argument
// parser, mismatch diagnostics, cache observation helpers and `sendViaWebSocket`'s trace rows (over the product's injection points
// `_acquireWithRetryFn` / `_sendFrameFn` / `_streamFn`: the scripted socket side), with MIXDOG_OAI_TRANSPORT set as the test sets it.
//   node benchmarks/rust-core/recorders/record-openai-ws-delta.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-ws-delta',
  net: false,
  entry: 'openai-ws-delta.mjs _computeDelta / _buildResponseCreateFrame / _sansInput / _stableStringify, openai-oauth-ws.mjs parseToolSearchArgs / _cacheObservationForTest / _cacheContinuityResetReasonForTest / sendViaWebSocket (scripted _acquireWithRetryFn / _sendFrameFn / _streamFn; _agentTraceFn collects the trace rows), openai-compat-stream.mjs isInvalidToolArgsMarker. Not run: a real socket.',
  compare: 'mixdog-ai providers::openai delta.rs (:197-298) and decoder.rs:271-287; mixdog-trace builders.rs:765-781 (no production caller: K1 gaps G12): compare `result` whole (frame mode/reason/previous_response_id/input, hashes of the mismatch diagnostics, parsed tool_search args, cache observations). `traceRows` are the rows Node writes; Rust writes none today (diagnostic only).',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::openai::OpenAiAdapter (openai/adapter.rs:308) with OpenAiCodec (openai/codec.rs:36) and build_body (openai/profile.rs:494), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079); the socket pool is WsPool::checkout (openai/pool.rs:178).",
});
const P = 'agent/orchestrator/providers/';
const { isInvalidToolArgsMarker } = await rec.P(`${P}openai-compat-stream.mjs`);
const { _computeDelta, _buildResponseCreateFrame, _sansInput, _stableStringify } = await rec.P(`${P}openai-ws-delta.mjs`);
const { _cacheObservationForTest, _cacheContinuityResetReasonForTest, sendViaWebSocket, parseToolSearchArgs } = await rec.P(`${P}openai-oauth-ws.mjs`);
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

await rec.run('tool-search-malformed-args-marker', `${SRC}:21`, { args: '{"query": dispatchAiWrapped}' }, () => {
  const out = parseToolSearchArgs('{"query": dispatchAiWrapped}');
  return { out, isMarker: isInvalidToolArgsMarker(out) };
});
await rec.run('tool-search-valid-object-empty-preserved', `${SRC}:30`, {}, () => {
  const obj = { query: 'y' };
  return { valid: parseToolSearchArgs('{"query":"x"}'), objectPassthroughIsSame: parseToolSearchArgs(obj) === obj, empty: parseToolSearchArgs(''), whitespace: parseToolSearchArgs('   '), nul: parseToolSearchArgs(null), undef: parseToolSearchArgs(undefined) ?? null, emptyIsMarker: isInvalidToolArgsMarker(parseToolSearchArgs('')) };
});
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
await rec.run('message-mismatch-diagnostics-hash-content', `${SRC}:161`, {}, () => withEnv('ws-delta', () => {
  const prior = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prior' }] };
  const expected = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'provider secret' }] };
  const actual = { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'replayed secret' }] };
  const delta = _computeDelta({ entry: { lastRequestSansInput: '{"model":"gpt-5.5"}', lastResponseId: 'resp_prev', lastRequestInput: [prior], lastResponseItems: [expected] }, body: { model: 'gpt-5.5', input: [prior, actual] } });
  const traceSafe = JSON.stringify(delta.responseOutputMismatch);
  return { reason: delta.reason, mismatch: delta.responseOutputMismatch, leaks: ['provider secret', 'replayed secret'].map((s) => [s, traceSafe.includes(s)]) };
}));
await rec.run('diagnostic-hashes-normalize-equivalent-forms', `${SRC}:195`, {}, () => withEnv('ws-delta', () => {
  const prior = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prior' }] };
  const mismatch = (expected, actual) => _computeDelta({ entry: { lastRequestSansInput: '{"model":"gpt-5.5"}', lastResponseId: 'resp_prev', lastRequestInput: [prior], lastResponseItems: [expected] }, body: { model: 'gpt-5.5', input: [prior, actual] } }).responseOutputMismatch;
  const out = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  const inp = (text) => ({ type: 'message', role: 'assistant', content: [{ type: 'input_text', text }] });
  const messageExpected = mismatch(out('same sensitive message'), out('different message'));
  const messageActual = mismatch(out('different message'), inp('same sensitive message'));
  const fn = (argumentsValue) => mismatch({ type: 'function_call', call_id: 'call_same', name: 'tool', arguments: argumentsValue }, { type: 'function_call', call_id: 'call_different', name: 'tool', arguments: '{"ignored":"replayed-function-secret"}' });
  const a = fn('{"api_key":"function-secret","nested":{"z":2,"a":1}}');
  const b = fn('{"nested":{"a":1,"z":2},"api_key":"function-secret"}');
  return { messageExpected, messageActual, messageHashesEqual: messageExpected.response_output_mismatch_expected_hash === messageActual.response_output_mismatch_actual_hash, functionA: a, functionB: b, functionHashesEqual: a.response_output_mismatch_expected_hash === b.response_output_mismatch_expected_hash };
}));
await rec.run('mismatch-diagnostics-reach-trace-rows', `${SRC}:262`, { env: 'ws-delta' }, () => withEnv('ws-delta', async () => {
  const rows = [];
  const prior = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prior' }] };
  const cases = [
    { expected: { type: 'function_call', call_id: 'call_expected', name: 'tool', arguments: '{"api_key":"provider-function-secret","nested":{"z":2,"a":1}}' }, actual: { type: 'function_call', call_id: 'call_actual', name: 'tool', arguments: '{"nested":{"a":1,"z":2},"api_key":"replayed-function-secret"}' } },
    { expected: { type: 'custom_tool_call', call_id: 'custom_expected', name: 'apply_patch', input: 'provider-custom-input-secret' }, actual: { type: 'custom_tool_call', call_id: 'custom_actual', name: 'apply_patch', input: 'replayed-custom-input-secret' } },
  ];
  const sends = [];
  for (const { expected, actual } of cases) {
    const body = { model: 'gpt-5.5', input: [prior, actual] };
    const entry = { socket: { close() {} }, lastRequestSansInput: _stableStringify(_sansInput(body)), lastResponseId: 'resp_prev', lastRequestInput: [prior], lastResponseItems: [expected] };
    const expectedDiagnostics = _computeDelta({ entry, body }).responseOutputMismatch;
    const before = rows.length;
    await sendViaWebSocket({
      auth: { type: 'xai', access_token: 'test-token' }, body, poolKey: `mismatch-trace-${expected.type}`, cacheKey: 'mismatch-trace-test', iteration: 1, useModel: 'gpt-5.5', traceProvider: 'xai',
      _acquireWithRetryFn: async () => ({ entry, reused: false }), _sendFrameFn: async () => {},
      _streamFn: async () => ({ content: 'ok', model: 'gpt-5.5', toolCalls: [], usage: {}, responseId: 'resp_next', responseItems: [], closeSocket: true }),
      _agentTraceFn: (row) => rows.push(row),
    });
    const emitted = rows.slice(before);
    sends.push({ type: expected.type, expectedDiagnostics, emittedRows: emitted, emittedPayloadsEqualDiagnostics: emitted.map((row) => Object.keys(expectedDiagnostics).every((k) => row.payload[k] === expectedDiagnostics[k])) });
  }
  const traceText = JSON.stringify(rows);
  return { sends, rows, secretsInTrace: ['provider-function-secret', 'replayed-function-secret', 'provider-custom-input-secret', 'replayed-custom-input-secret'].map((s) => [s, traceText.includes(s)]) };
}));
await rec.run('native-tool-search-output-replays-canonically', `${SRC}:351`, { env: 'ws-delta' }, () => withEnv('ws-delta', () => {
  const baseTools = [{ type: 'tool_search', execution: 'client', description: 'load tools', parameters: { type: 'object', properties: {} } }];
  const output = { type: 'tool_search_output', call_id: 'call_load_1', status: 'completed', execution: 'client', tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }] };
  const body = { model: 'gpt-5.5', instructions: 'sys', tools: baseTools, prompt_cache_key: 'cache-key', input: [msg('user', 'load read'), { type: 'tool_search_call', call_id: 'call_load_1', execution: 'client', arguments: { names: ['read'] } }, output, msg('user', 'use read')] };
  const delta = _computeDelta({ entry: { lastRequestSansInput: _stableStringify(_sansInput(body)), lastResponseId: 'resp_prev', lastRequestInput: [body.input[0]], lastResponseItems: [body.input[1]] }, body });
  return { body, delta };
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
await rec.run('cache-observation-warm-zero-and-retreats', `${SRC}:455`, {}, () => {
  const obs = (cachedMax, usage, extra = {}) => _cacheObservationForTest({ entry: { promptCacheMaxCachedTokens: cachedMax }, result: { usage }, ...extra });
  const previousInput = [msg('user', 'old long transcript')];
  const rewrittenBody = { model: 'gpt-5.5', input: [msg('user', 'compact summary')] };
  return {
    zero: obs(47_616, { inputTokens: 59_000, promptTokens: 59_000, cachedTokens: 0 }),
    partial: obs(101_888, { inputTokens: 102_456, promptTokens: 102_456, cachedTokens: 60_928 }),
    healthy: obs(101_888, { inputTokens: 106_468, promptTokens: 106_468, cachedTokens: 103_424 }),
    compacted: obs(255_488, { inputTokens: 21_066, promptTokens: 21_066, cachedTokens: 8_704 }, { continuityResetReason: 'input_prefix_mismatch' }),
    continuityResetReason: _cacheContinuityResetReasonForTest({ mode: 'full', deltaReason: 'full_default', entry: { lastResponseId: 'resp_old', lastRequestSansInput: _stableStringify(_sansInput(rewrittenBody)), lastRequestInput: previousInput }, body: rewrittenBody }),
  };
});
await rec.finish();
