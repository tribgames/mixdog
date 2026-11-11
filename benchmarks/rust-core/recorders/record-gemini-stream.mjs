#!/usr/bin/env node
// gemini-stream.test.mjs: the real `consumeGeminiRestStreamResponse` (+ `createGeminiTextLeakGuard`) over scripted SSE bodies. 14 cases
// are recorded (every case but the first-chunk window, a Node timer with no Rust counterpart: dec:138). The recorded `response`,
// `error` (code, status, retryAfterMs, details, unsafeToRetry, emittedToolCall, ...) and callbacks are what a Rust decoder must equal.
//   node benchmarks/rust-core/recorders/record-gemini-stream.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-gemini-stream',
  net: false,
  entry: 'src/runtime/agent/orchestrator/providers/gemini-stream.mjs consumeGeminiRestStreamResponse(new Response(<SSE text of the chunks>), options) and createGeminiTextLeakGuard. Not run: the first-chunk window case (gemini-stream.test.mjs:197, a wall-clock timer, dec:138 removes it) and any network send.',
  replay: 'mixdog-ai providers::google decode (decode.rs): feed `input.chunks` as the SSE data frames and compare `result.response` / `error` (typed code, status, flags) and `progress`/`text`/`dispatched` callbacks in order.',
});
const { consumeGeminiRestStreamResponse, createGeminiTextLeakGuard } = await rec.P('agent/orchestrator/providers/gemini-stream.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/gemini-stream.test.mjs';

const nativePart = { functionCall: { id: 'native-id', name: 'read', args: { path: 'fixture' } }, thoughtSignature: 'native-signature' };
const partialPart = { functionCall: { id: 'partial-id', name: 'read', args: { path: 'frag' }, willContinue: true } };
const frames = (chunks) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
const cand = (parts, extra = {}) => ({ candidates: [{ content: { role: 'model', parts }, ...extra }] });
// One case: the response (or the error) and what the callbacks saw.
const consume = async (chunks, options = {}, raw = null) => {
  const seen = { progress: [], text: [] };
  const out = {};
  try {
    out.response = await consumeGeminiRestStreamResponse(new Response(raw ?? frames(chunks)), {
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
const run = (id, line, chunks, fn, raw) => rec.run(id, `${SRC}:${line}`, { chunks, ...(raw ? { raw } : {}) }, fn ?? (() => consume(chunks, {}, raw)));

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
  await run(`leaked-call-${deferToolCalls ? 'held-back' : 'dispatched'}`, 118, chunks, async () => {
    const dispatched = [];
    const textLeakGuard = createGeminiTextLeakGuard({ knownToolNames: ['read'], onToolCall: (call) => dispatched.push(call), deferToolCalls });
    const out = await consume(chunks, { textLeakGuard });
    return { ...out, dispatched, leakedToolCalls: textLeakGuard.getLeakedToolCalls() };
  });
}
await run('ordered-parts-and-signatures', 140, [], () =>
  consume([{ text: 'answer' }, nativePart].map((part, index) => cand([part], index === 1 ? { finishReason: 'STOP' } : {}))));
const inBand = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota gone', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5s' }] } };
await run('in-band-error-before-text', 168, [inBand]);
await run('in-band-error-after-stop', 174, [cand([{ text: 'ok' }], { finishReason: 'STOP' }), inBand]);
await run('in-band-error-unterminated-tail', 185, [], undefined, `data: ${JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } })}`);
await rec.finish();
