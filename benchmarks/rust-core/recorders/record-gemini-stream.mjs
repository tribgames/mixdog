#!/usr/bin/env node
// gemini-stream.test.mjs: the real `consumeGeminiRestStreamResponse` (+ `createGeminiTextLeakGuard`) over scripted SSE bodies. every test
// is recorded; the first-chunk window runs the product timer on the virtual clock (the 25 ms step is an input and the clock trace is recorded). The input of every case is the scripted Response itself (status, headers, body bytes as delivered). The recorded `response`,
// `error` (code, status, retryAfterMs, details, unsafeToRetry, emittedToolCall, ...) and callbacks are what a Rust decoder must equal.
//   node benchmarks/rust-core/recorders/record-gemini-stream.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-gemini-stream',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/gemini-stream.mjs consumeGeminiRestStreamResponse(new Response(<SSE text of the chunks>), options) and createGeminiTextLeakGuard. Not run: any network send.',
  compare: 'mixdog-ai providers::google decode (decode.rs): feed `input.response.$response.bodyChunks` as the response body and compare `result.response` / `error` (typed code, status, flags) and `progress`/`text`/`dispatched` callbacks in order.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::google::GoogleAdapter (google/adapter.rs:53), GoogleCodec (google/codec.rs:63) and build_request (google/request.rs:446), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079).",
});
const { consumeGeminiRestStreamResponse, createGeminiTextLeakGuard } = await rec.P('agent/orchestrator/providers/gemini-stream.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/gemini-stream.test.mjs';

const nativePart = { functionCall: { id: 'native-id', name: 'read', args: { path: 'fixture' } }, thoughtSignature: 'native-signature' };
const partialPart = { functionCall: { id: 'partial-id', name: 'read', args: { path: 'frag' }, willContinue: true } };
const frames = (chunks) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
const cand = (parts, extra = {}) => ({ candidates: [{ content: { role: 'model', parts }, ...extra }] });
// One case: the response (or the error) and what the callbacks saw.
const consume = async (response, options = {}) => {
  const seen = { progress: [], text: [] };
  const out = {};
  try {
    out.response = await consumeGeminiRestStreamResponse(response, {
      label: 'fixture',
      onStreamDelta: (kind) => seen.progress.push(kind),
      onTextDelta: (delta) => seen.text.push(delta),
      ...options,
    });
  } catch (error) {
    out.error = error;
  }
  return { ...out, ...seen };
};
// The input of a case is the scripted response itself: status, headers and the body bytes as delivered.
const run = (id, line, chunks, fn, raw) => {
  const response = rec.response([raw ?? frames(chunks)]);
  return rec.run(id, `${SRC}:${line}`, { response }, () => (fn ?? consume)(response));
};

await run('whole-call-without-finish', 28, [cand([nativePart])]);
const second = { functionCall: { name: 'read', args: { path: 'second' } } };
for (const [i, parts] of [[nativePart, partialPart], [partialPart, nativePart], [nativePart, { functionCall: { name: 'read', partialArgs: [{ jsonPath: '$.path', stringValue: 'f' }] } }]].entries()) {
  await run(`one-complete-one-unfinished-${i}`, 39, [cand(parts)]);
}
await run('several-complete-calls-without-finish', 55, [cand([nativePart, second])]);
for (const [label, chunks] of [
  ['text-only', [{ candidates: [{ content: { parts: [{ text: 'half an answer' }] } }] }]],
  ['thoughts-only', [{ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] }]],
  ['partial-functionCall', [{ candidates: [{ content: { parts: [partialPart] } }] }]],
  ['empty-candidate', [{ candidates: [{ content: { parts: [] } }] }]],
]) await run(`no-finish-${label}`, 69, chunks);
await run('native-tool-chunks-replayable', 77, [{ candidates: [{ content: { parts: [partialPart] } }] }]);
await run('visible-text-then-native-chunk', 94, [{ candidates: [{ content: { parts: [{ text: 'visible' }] } }] }, { candidates: [{ content: { parts: [partialPart] } }] }]);
for (const deferToolCalls of [true, false]) {
  const leaked = '<invoke name="read"><parameter name="path">a.txt</parameter></invoke>';
  const chunks = [{ candidates: [{ content: { parts: [{ text: leaked }] } }] }];
  await run(`leaked-call-${deferToolCalls ? 'held-back' : 'dispatched'}`, 118, chunks, async (response) => {
    const dispatched = [];
    const textLeakGuard = createGeminiTextLeakGuard({ knownToolNames: ['read'], onToolCall: (call) => dispatched.push(call), deferToolCalls });
    const out = await consume(response, { textLeakGuard });
    return { ...out, dispatched, leakedToolCalls: textLeakGuard.getLeakedToolCalls() };
  });
}
await run('ordered-parts-and-signatures', 140, [{ text: 'answer' }, nativePart].map((part, index) => cand([part], index === 1 ? { finishReason: 'STOP' } : {})));
const inBand = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota gone', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5s' }] } };
await run('in-band-error-before-text', 168, [inBand]);
await run('in-band-error-after-stop', 174, [cand([{ text: 'ok' }], { finishReason: 'STOP' }), inBand]);
await run('in-band-error-unterminated-tail', 185, [], undefined, `data: ${JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } })}`);
const silent = new Response(new ReadableStream({ start() {} }));
rec.describe(silent, { $response: { status: silent.status, statusText: silent.statusText, headers: [...silent.headers.entries()], bodyChunks: [], bodyNeverEnds: true } });
await rec.run('first-chunk-window-follows-caller-and-names-phase', `${SRC}:196`, { firstByteTimeoutMs: 25, label: 'fixture', response: silent, advanceMs: [25] }, async () => {
  const pending = consumeGeminiRestStreamResponse(silent, { label: 'fixture', firstByteTimeoutMs: 25 }).then((response) => ({ response }), (error) => ({ error }));
  await rec.clock.advance(25, { what: 'gemini first-chunk window' });
  return pending;
});
await rec.finish();
