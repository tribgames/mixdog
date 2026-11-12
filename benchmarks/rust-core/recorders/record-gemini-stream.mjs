#!/usr/bin/env node
// gemini-stream.test.mjs: the real `consumeGeminiRestStreamResponse` (+ `createGeminiTextLeakGuard`) over scripted SSE bodies. every test
// is recorded; the first-chunk window runs the product timer on the virtual clock (the 25 ms step is an input and the clock trace is recorded). The input of every case is the scripted Response itself (status, headers, body bytes as delivered). The recorded `response`,
// `error` (code, status, retryAfterMs, details, unsafeToRetry, emittedToolCall, ...) and callbacks are what a Rust decoder must equal.
//   node benchmarks/rust-core/recorders/record-gemini-stream.mjs --tree <exact export of b6f10295a>
import net from 'node:net';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-gemini-stream',
  entry: 'src/runtime/agent/orchestrator/providers/gemini-stream.mjs consumeGeminiRestStreamResponse(response, options) and createGeminiTextLeakGuard, called as the Node test calls them, on a REAL fetch Response: the recorder POSTs to the streamGenerateContent URL and the loopback endpoint serves the scripted status, headers and body chunks (each chunk its own socket write) - the input of every case is that served script, and the request as it arrived is recorded. The first-chunk window case is the test\'s silent response (the endpoint accepts and never writes a byte) with firstByteTimeoutMs 25, and the virtual clock is advanced by exactly 25 ms (the recorded clock step). Not run: a live endpoint.',
  compare: 'Serve each case\'s `input.served.chunks` from a loopback endpoint to the Rust Gemini decoder path (the recorded request is `requests[0]`) and compare `response` / `error` (typed code, status, retryAfterMs, details, unsafeToRetry, emittedToolCall, timeoutPhase, message) and the `progress` / `text` / `dispatched` callbacks in order; for first-chunk-window-follows-caller-and-names-phase serve a response that never writes a byte and advance a virtual clock by the recorded 25 ms step.',
  exclusions: [
    '`response.candidates[].index` is not compared: the aggregation\'s own sort key (gemini-stream.mjs:159, :196); no reader of the aggregated response reads it (`[.?]index\\b` over gemini.mjs, gemini-response.mjs, antigravity-response.mjs, antigravity-stream.mjs, gemini-sdk-request.mjs finds none)',
    '`response.candidates[].content.role` is not compared: the aggregation writes it (gemini-stream.mjs:176) and the readers of the aggregated response read only `content.parts` (gemini-response.mjs:23, antigravity-response.mjs:53); mergeGeminiHops (gemini.mjs:133) copies it into a merged response read the same way',
  ],
  replay: "WIRE for every case (each row has `requests`): a loopback endpoint serving the recorded chunks to mixdog_ai::providers::google::GoogleAdapter (google/adapter.rs:53) through ModelBroker::send (mixdog-ai/src/broker/send.rs:75); the decoder under it is mixdog-ai/src/providers/google/decode.rs:160 GeminiDecoder (pub) but its input is a wire body, not a fetch Response, and the broker adds the retry layer the Node function does not have, so the comparison is made on the decoded events and the typed error of the first attempt.",
});
const { consumeGeminiRestStreamResponse, createGeminiTextLeakGuard } = await rec.P('agent/orchestrator/providers/gemini-stream.mjs');
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse';
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
// The input of a case is the served script: status, content type and the body chunks as written to the socket; the product function reads a real fetch Response of it.
const run = (id, line, chunks, fn, raw, leakGuard) => {
  const served = { status: 200, contentType: 'text/event-stream', chunks: [raw ?? frames(chunks)] };
  return rec.run(id, `${SRC}:${line}`, leakGuard ? { served, leakGuard } : { served }, async ({ net }) => {
    net.reply = () => served;
    const response = await fetch(GEMINI_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return (fn ?? consume)(response);
  });
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
  const leakGuard = { knownToolNames: ['read'], deferToolCalls };
  await run(`leaked-call-${deferToolCalls ? 'held-back' : 'dispatched'}`, 118, chunks, async (response) => {
    const dispatched = [];
    const textLeakGuard = createGeminiTextLeakGuard({ ...leakGuard, onToolCall: (call) => dispatched.push(call) });
    const out = await consume(response, { textLeakGuard });
    return { ...out, dispatched, leakedToolCalls: textLeakGuard.getLeakedToolCalls() };
  }, undefined, leakGuard);
}
await run('ordered-parts-and-signatures', 140, [{ text: 'answer' }, nativePart].map((part, index) => cand([part], index === 1 ? { finishReason: 'STOP' } : {})));
const inBand = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota gone', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5s' }] } };
await run('in-band-error-before-text', 168, [inBand]);
await run('in-band-error-after-stop', 174, [cand([{ text: 'ok' }], { finishReason: 'STOP' }), inBand]);
await run('in-band-error-unterminated-tail', 185, [], undefined, `data: ${JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } })}`);
// :197 - the test hands consumeGeminiRestStreamResponse a response that never produces a chunk and a 25 ms first-byte window: the endpoint accepts the request and never writes a body byte; the
// product timer runs on the virtual clock and the recorder advances it by exactly 25 ms once the timer is armed.
await rec.run('first-chunk-window-follows-caller-and-names-phase', `${SRC}:197`, { served: { status: 200, contentType: 'text/event-stream', chunks: [], hold: true }, options: { label: 'fixture', firstByteTimeoutMs: 25 }, advanceMs: 25 }, async ({ net, clock }) => {
  net.reply = () => ({ status: 200, contentType: 'text/event-stream', chunks: [], hold: true });
  const response = await fetch(GEMINI_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const pending = consumeGeminiRestStreamResponse(response, { label: 'fixture', firstByteTimeoutMs: 25 }).then((value) => ({ response: value }), (error) => ({ error }));
  const armed = () => clock.pendingFrom(/./).some((timer) => timer.due === Date.now() - rec.T0 + 25);
  await clock.advance(0, { until: armed, what: 'first-chunk window armed' });
  await clock.advance(25, { what: 'first-chunk window (25 ms)' });
  return pending;
});
// The idle phase of the same watchdogs (gemini-rest-stream/watchdogs.mjs:55-61, no test of its own): one payload with visible text, then the
// endpoint holds the response open and writes nothing more; the idle timer, re-armed by the payload, runs on the virtual clock and the
// recorder advances it by exactly PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS (300000 ms with the scrubbed environment) once it is re-armed.
const idleServed = { status: 200, contentType: 'text/event-stream', chunks: [frames([cand([{ text: 'partial' }])])], hold: true };
await rec.run('idle-window-after-a-payload-names-phase', 'src/runtime/agent/orchestrator/providers/gemini-rest-stream/watchdogs.mjs:55', { served: idleServed, options: { label: 'fixture' }, advanceMs: 300000 }, async ({ net, clock }) => {
  net.reply = () => idleServed;
  const response = await fetch(GEMINI_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const seen = { progress: [], text: [] };
  const pending = consumeGeminiRestStreamResponse(response, { label: 'fixture', onStreamDelta: (kind) => seen.progress.push(kind), onTextDelta: (delta) => seen.text.push(delta) }).then((value) => ({ response: value }), (error) => ({ error }));
  await clock.advance(0, { until: () => seen.progress.length === 1, what: 'the payload decoded and the idle window re-armed' });
  await clock.advance(300000, { what: 'idle window (300000 ms)' });
  return { ...(await pending), ...seen };
});
// What re-arms the idle window (gemini-stream.mjs:586-591): a read that decoded a payload, never bytes that decode none. One payload, then
// the endpoint holds the response open; after a first recorded step the endpoint writes a second chunk on the held response (`later`): a
// payload re-arms the window (it fires a full window after that payload), a keep-alive comment line does not (it fires a full window after
// the first). Each later chunk is written once the step before it was taken and the product has consumed it before the next step.
const serverSocket = (record) => process._getActiveHandles().find((h) => h instanceof net.Socket && h.remotePort === record.connectionPort && h._httpMessage);
const writeLater = (record, chunk) => new Promise((resolve, reject) => serverSocket(record)._httpMessage.write(chunk, (error) => (error ? reject(error) : resolve())));
for (const [id, second, rest, decoded] of [
  ['idle-window-rearmed-by-each-payload', frames([cand([{ text: 'two' }])]), 300000, 2],
  ['idle-window-not-rearmed-by-a-keepalive', ': keepalive\n\n', 100000, 1],
]) {
  const served = { status: 200, contentType: 'text/event-stream', chunks: [frames([cand([{ text: 'one' }])])], hold: true, later: [{ afterStep: 0, chunk: second }] };
  await rec.run(id, 'src/runtime/agent/orchestrator/providers/gemini-stream.mjs:591', { served, options: { label: 'fixture' } }, async ({ net, clock }) => {
    net.reply = () => served;
    const response = await fetch(GEMINI_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const seen = { progress: [], text: [] };
    const pending = consumeGeminiRestStreamResponse(response, { label: 'fixture', onStreamDelta: (kind) => seen.progress.push(kind), onTextDelta: (delta) => seen.text.push(delta) }).then((value) => ({ response: value }), (error) => ({ error }));
    await clock.until(() => seen.progress.length === 1, 'the first payload decoded and the idle window re-armed');
    await clock.advance(200000, { what: 'part of the idle window (200000 ms)' });
    await writeLater(net.records[0], second);
    // The product reads the written chunk: a payload is observed decoded; bytes that decode none are not observable, so two turns of the
    // event loop let the client take them up.
    if (decoded === 2) await clock.until(() => seen.progress.length === 2, 'the second payload decoded');
    else for (let i = 0; i < 2; i++) await new Promise((resolve) => setImmediate(resolve));
    await clock.advance(rest, { what: `the rest of the idle window (${rest} ms)` });
    return { ...(await pending), ...seen };
  });
}
await rec.finish();
