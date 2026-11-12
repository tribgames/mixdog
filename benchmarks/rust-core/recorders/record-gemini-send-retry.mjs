#!/usr/bin/env node
// The Gemini API send's two retry ladders and its stream watchdogs, end to end (gemini.mjs GeminiProvider.send over runGeminiStreamAttempts,
// gemini-retry-policy.mjs, and consumeGeminiRestStreamResponse's watchdogs, gemini-rest-stream/watchdogs.mjs), one case per way an attempt
// fails: before the response opened (a refused connection, a failed TLS handshake, a 503, a 429 with server advice, a 400 that is never
// retried: the connection ladder, 10 attempts, jittered 5..30 s) and after it opened (the first-chunk window, the idle window after a
// payload, a socket reset after a payload, an in-band error event: the stream ladder, 4 attempts, 1/2/4 s, then the non-streaming re-issue;
// a reset after visible text is never re-issued). No Node test drives these whole: the recorder sends through the real provider to the
// loopback endpoint and runs the product's timers on the virtual clock - each watchdog window and each retry wait is one recorded clock
// step, taken once the product armed the timer.
//   node benchmarks/rust-core/recorders/record-gemini-send-retry.mjs --tree <exact export of b6f10295a>
import net from 'node:net';
import { startRecording } from './lib/provider-case-recorder.mjs';

// Node's own fetch, for the attempts that fail before reaching the endpoint (the recorder's redirect below sends every other one there).
const nodeFetch = globalThis.fetch;
const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-gemini-send-retry',
  entry: 'gemini.mjs GeminiProvider({ apiKey, preconnect: false }).send(history, model, [], { onStageChange, onTextDelta }) against the loopback endpoint (or, for a connection fault, a closed loopback port or a loopback listener that ends the TLS handshake); the retry stages it raises (`onStageChange`), the text it relays (`onTextDelta`) and the retry lines it writes to stderr (geminiRetryLogger, gemini.mjs:239) are recorded beside its result or error. Not run: a live endpoint.',
  compare: 'Serve each case\'s replies from a loopback endpoint to the Rust Gemini API send (GoogleAdapter under ModelBroker::send), take the recorded clock steps on the paused clock, and compare the requests as they arrived, the result or error, the stages and the stderr lines. A reply\'s `reset` (a socket reset once the product decoded the chunks before it) is the endpoint\'s own act, as is a connection fault of the case input (`fault`).',
  replay: 'Rust entry (pub): mixdog_ai::registry DefaultProviderBuilder::build("gemini") and mixdog_ai::broker::ModelBroker::send (broker/send.rs) with the GoogleAdapter (providers/google/adapter.rs) and its stream watchdogs (providers/google/watchdog.rs).',
});
// The semantic idle window is 120 s for this recording (read by stall-policy.mjs when it loads): under the endpoint's own
// 300 s request timeout (Node's http server), which would otherwise end a held response at the 300 s default window.
process.env.MIXDOG_PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS = '120000';
const { GeminiProvider } = await rec.P('agent/orchestrator/providers/gemini.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/gemini-retry-policy.mjs';
const HISTORY = [{ role: 'user', content: 'hi' }];
const MODEL = 'gemini-3-pro';
// The connection faults: a refused connection (a closed loopback port; nothing listens on port 1) and a failed TLS handshake (a loopback
// listener at a fixed port that resets the connection on the client's hello). Fixed ports: the error Node raises names them.
const CLOSED_PORT = 47652;
const TLS_PORT = 47651;
const tls = net.createServer((socket) => socket.once('data', () => socket.resetAndDestroy()));
await new Promise((resolve) => tls.listen(TLS_PORT, '127.0.0.1', resolve));
let fault = null;
let faulted = 0;
let notify = () => {};
const redirected = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (!fault) return redirected(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  const origin = fault === 'refused' ? `http://127.0.0.1:${CLOSED_PORT}` : `https://127.0.0.1:${TLS_PORT}`;
  faulted++;
  const attempt = nodeFetch(`${origin}${url.pathname}${url.search}`, init);
  attempt.catch(() => {}).finally(() => notify());
  return attempt;
};
// The endpoint's side of the connection a request arrived on (its remote port is the client's).
const serverSocket = (record) => process._getActiveHandles().find((h) => h instanceof net.Socket && h.remotePort === record.connectionPort && h._httpMessage);

// One send of `input`: `ladder` 'window' - every attempt's stream opened and timed out in its watchdog window (`windowMs`; `afterPayload`: the
// idle window after a payload, else the first-chunk window), each window and each stream retry wait one step; 'retries' - every retry wait
// one step, the clock moving to it once the attempt failed. A reply with `reset` is reset once the product decoded its chunks (the
// first-chunk window cleared, the idle window the only watchdog left). The stages and stderr lines the send raised are recorded beside
// its outcome, and so is the text it relayed (`onTextDelta`).
const WATCHDOG = /gemini-rest-stream[\\/]watchdogs\.mjs/;
const SLEEP = /at (async )?\S*[sS]leep\S* /;
const send = async ({ net: endpoint, clock }, input, reply) => {
  endpoint.reply = reply;
  fault = input.fault ?? null;
  notify = clock.notify;
  const provider = new GeminiProvider({ apiKey: 'fixture-key', preconnect: false });
  const stages = [];
  const text = [];
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  let settled = false;
  const outcome = provider
    .send(HISTORY, MODEL, [], { onStageChange: (stage, payload) => stages.push(payload === undefined ? { stage } : { stage, payload }), onTextDelta: (delta) => text.push(delta) })
    .then((result) => ({ result }), (error) => ({ error }))
    .finally(() => {
      settled = true;
      clock.notify();
    });
  const attempts = () => endpoint.records.length + faulted;
  const resets = (async () => {
    for (let k = 1; ; k++) {
      // The endpoint sets a record's reply right after the arrival is noted.
      const reply = () => endpoint.records[k - 1]?.reply;
      await clock.until(() => settled || (reply() !== undefined && (!reply().reset || clock.pendingFrom(WATCHDOG).length === 1)), `attempt ${k}: its chunks decoded`);
      if (settled) return;
      if (!reply().reset) continue;
      // The endpoint's own write of the chunks completes (its callback runs) before the connection is reset.
      await new Promise((resolve) => setImmediate(resolve));
      serverSocket(endpoint.records[k - 1]).resetAndDestroy();
    }
  })();
  try {
    if (input.ladder === 'retries') {
      await clock.followRetries(outcome, { sites: SLEEP, what: 'the retry ladders', causes: () => { const n = attempts(); return () => attempts() > n; } });
    } else {
      for (let k = 1; !settled; k++) {
        const watched = () => {
          const timers = clock.pendingFrom(WATCHDOG);
          return input.afterPayload ? timers.length === 1 && timers[0].due === Date.now() - rec.T0 + input.windowMs : timers.length === 2;
        };
        await clock.until(() => settled || (endpoint.records.length >= k && watched()), `attempt ${k}: its stream open and watched`);
        if (settled) break;
        await new Promise((resolve) => setImmediate(resolve));
        await clock.advance(input.windowMs, { what: `attempt ${k}: the watchdog window (${input.windowMs} ms)`, until: () => settled || clock.pendingFrom(SLEEP).length > 0 });
        if (settled) break;
        const [wait] = clock.pendingFrom(SLEEP);
        await clock.advance(wait.due - (Date.now() - rec.T0), { what: `attempt ${k}: the stream retry wait`, until: () => settled || endpoint.records.length > k });
      }
    }
    const done = await outcome;
    await resets;
    // A held response's close is part of its record; the send can settle before the endpoint sees a reset it made itself.
    await rec.own('the held responses\' connections closing', () => Promise.all(endpoint.records.filter((r) => r.reply?.hold).map((r) => r.whenClientClosed)));
    await new Promise((resolve) => setImmediate(resolve));
    return { ...done, stages, text, stderr };
  } finally {
    process.stderr.write = write;
    fault = null;
  }
};

const json = (status, error, headers) => ({ status, contentType: 'application/json', ...(headers ? { headers } : {}), body: JSON.stringify({ error }) });
const busy = json(503, { code: 503, message: 'busy', status: 'UNAVAILABLE' });
const frames = (chunks) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
const payload = (text) => frames([{ candidates: [{ content: { role: 'model', parts: [{ text }] } }] }]);
// The stream requests get `stream`; the one non-streaming re-issue a spent stream ladder makes (`_recoverGeminiNonStreaming`,
// gemini.mjs:349, POST :generateContent) is refused.
const streamOrBusy = (stream) => (request) => (request.path.includes(':streamGenerateContent') ? stream : busy);
const silent = { status: 200, contentType: 'text/event-stream', chunks: [], hold: true };
// A payload with no visible text (an empty text part): the stream stays replay-safe.
const quiet = { status: 200, contentType: 'text/event-stream', chunks: [payload('')], hold: true };
const cases = [
  ['first-chunk-timeouts-spend-the-stream-ladder', 60, { ladder: 'window', windowMs: 60000 }, streamOrBusy(silent)],
  ['idle-timeouts-spend-the-stream-ladder', 60, { ladder: 'window', windowMs: 120000, afterPayload: true, env: { MIXDOG_PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS: '120000' } }, streamOrBusy(quiet)],
  ['resets-after-a-quiet-payload-spend-the-stream-ladder', 60, { ladder: 'retries' }, streamOrBusy({ ...quiet, reset: true })],
  ['a-reset-after-shown-text-is-not-retried', 60, { ladder: 'retries' }, streamOrBusy({ status: 200, contentType: 'text/event-stream', chunks: [payload('partial answer')], hold: true, reset: true })],
  ['in-band-errors-spend-the-stream-ladder', 60, { ladder: 'retries' }, streamOrBusy({ status: 200, contentType: 'text/event-stream', chunks: [frames([{ error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } }])] })],
  ['refusals-spend-the-connection-ladder', 33, { ladder: 'retries' }, () => busy],
  ['rate-limits-with-advice-spend-the-connection-ladder', 33, { ladder: 'retries' }, () => json(429, { code: 429, message: 'slow down', status: 'RESOURCE_EXHAUSTED' }, { 'retry-after': '7' })],
  ['an-invalid-request-is-not-retried', 33, { ladder: 'retries' }, () => json(400, { code: 400, message: 'bad field', status: 'INVALID_ARGUMENT' })],
  ['refused-connections-spend-the-connection-ladder', 33, { ladder: 'retries', fault: 'refused' }, () => busy],
  ['tls-failures-spend-the-connection-ladder', 33, { ladder: 'retries', fault: 'tls' }, () => busy],
];
for (const [id, line, input, reply] of cases) {
  // Each case's environment as the provider reads it at send time; the idle window is read by stall-policy.mjs when it loads (set above).
  await rec.run(id, `${SRC}:${line}`, input, (ctx) => send(ctx, input, reply));
}
tls.close();
await rec.finish();
