#!/usr/bin/env node
// gemini-stream.test.mjs: the real `consumeGeminiRestStreamResponse` (+ `createGeminiTextLeakGuard`) over scripted SSE bodies. every test
// is recorded; the first-chunk window runs the product timer on the virtual clock (the 25 ms step is an input and the clock trace is recorded). The input of every case is the scripted Response itself (status, headers, body bytes as delivered). The recorded `response`,
// `error` (code, status, retryAfterMs, details, unsafeToRetry, emittedToolCall, ...) and callbacks are what a Rust decoder must equal.
//   node benchmarks/rust-core/recorders/record-gemini-stream.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-gemini-stream',
  pure: {
    '*': 'mixdog-ai/src/providers/google/decode.rs:193 GeminiDecoder (pub, `pub mod decode` at providers/google/mod.rs:19; new :241 with a DecodeDialect, with_known_tools :276, feed/finish in `impl WireDecoder` :551): fed the recorded body chunks as delivered',
  },
  entry: 'src/runtime/agent/orchestrator/providers/gemini-stream.mjs consumeGeminiRestStreamResponse(response, options) and createGeminiTextLeakGuard (pure cases: the scripted response is the recorded status, headers and body chunks as delivered); gemini.mjs GeminiProvider.send against the loopback endpoint (the first-chunk window case, WIRE level). Not run: a live endpoint.',
  compare: 'PURE cases (see `levels`): feed `input.response.$response.bodyChunks` to the public GeminiDecoder (google/decode.rs:193) and compare `response` / `error` (typed code, status, flags) and the `progress` / `text` / `dispatched` callbacks in order. WIRE case first-chunk-window: serve a request that is accepted and never answered through the Rust Gemini send, advance a virtual clock as `clock` records, and compare the request as it arrived (10 requests: the retries) and the final `error` (code, timeoutPhase, message).',
  replay: "PURE: mixdog-ai/src/providers/google/decode.rs:193 GeminiDecoder (pub). WIRE: mixdog_ai::providers::google::GoogleAdapter (google/adapter.rs:53) via ModelBroker::send (mixdog-ai/src/broker/send.rs:75) against a loopback endpoint.",
});
const { consumeGeminiRestStreamResponse, createGeminiTextLeakGuard } = await rec.P('agent/orchestrator/providers/gemini-stream.mjs');
const { GeminiProvider } = await rec.P('agent/orchestrator/providers/gemini.mjs');
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
// The first-chunk window is a timer of the send, not of the decoder: WIRE level. The real GeminiProvider sends to the loopback endpoint, which accepts the request and never
// writes a byte (`hold`); the virtual clock moves to every timer the send arms (the first-chunk watchdog, then its retry sleeps) until the send ends.
await rec.run('first-chunk-window-follows-caller-and-names-phase', `${SRC}:197`, { endpoint: 'accepts the request, never writes a byte', clock: 'every armed timer in due order until the send ends' }, async () => {
  rec.net.reply = () => ({ status: 200, contentType: 'text/event-stream', chunks: [], hold: true });
  const provider = new GeminiProvider({ apiKey: 'fixture-key' });
  const settled = provider.send([{ role: 'user', content: 'hi' }], 'gemini-2.5-pro', [], {}).then((response) => ({ response }), (error) => ({ error }));
  return rec.clock.followRetries(settled, { sites: /./, what: 'gemini first-chunk window and retries' });
});
await rec.finish();
