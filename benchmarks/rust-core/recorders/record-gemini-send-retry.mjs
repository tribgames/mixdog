#!/usr/bin/env node
// The Gemini API send's two retry ladders and its stream watchdogs, end to end (gemini.mjs GeminiProvider.send over runGeminiStreamAttempts,
// gemini-retry-policy.mjs, and consumeGeminiRestStreamResponse's watchdogs, gemini-rest-stream/watchdogs.mjs): every attempt's stream
// opened (headers arrived) and then timed out in its first-chunk window, or in its idle window after a payload, until the stream ladder
// (4 attempts, 1/2/4 s) ran out; and every attempt refused (503) until the connection ladder (10 attempts, jittered 5..30 s) ran out. No Node
// test drives these whole: the recorder sends through the real provider to the loopback endpoint and runs the product's timers on the
// virtual clock - each watchdog window and each retry wait is one recorded clock step, taken once the product armed the timer.
//   node benchmarks/rust-core/recorders/record-gemini-send-retry.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-gemini-send-retry',
  entry: 'gemini.mjs GeminiProvider({ apiKey, preconnect: false }).send(history, model, [], { onStageChange }) against the loopback endpoint; the retry stages it raises (`onStageChange`) and the retry lines it writes to stderr (geminiRetryLogger, gemini.mjs:239) are recorded beside its result or error. Not run: a live endpoint.',
  compare: 'Serve each case\'s replies from a loopback endpoint to the Rust Gemini API send (GoogleAdapter under ModelBroker::send), take the recorded clock steps on the paused clock, and compare the requests as they arrived, the result or error, the stages and the stderr lines.',
  replay: 'Rust entry (pub): mixdog_ai::registry DefaultProviderBuilder::build("gemini") and mixdog_ai::broker::ModelBroker::send (broker/send.rs) with the GoogleAdapter (providers/google/adapter.rs) and its stream watchdogs (providers/google/watchdog.rs).',
});
// The semantic idle window is 120 s for this recording (read by stall-policy.mjs when it loads): under the endpoint's own
// 300 s request timeout (Node's http server), which would otherwise end a held response at the 300 s default window.
process.env.MIXDOG_PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS = '120000';
const { GeminiProvider } = await rec.P('agent/orchestrator/providers/gemini.mjs');
const SRC = 'src/runtime/agent/orchestrator/providers/gemini-retry-policy.mjs';
const HISTORY = [{ role: 'user', content: 'hi' }];
const MODEL = 'gemini-3-pro';
const WATCHDOG = /gemini-rest-stream[\\/]watchdogs\.mjs/;
const SLEEP = /at (async )?\S*[sS]leep\S* /;
const frames = (chunks) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');

// One send; `window` (ms) is the watchdog window each attempt's stream times out in, or null for attempts the endpoint refuses. The
// window is taken once the watchdog it ends is the only one left to fire first: `afterPayload` false - both timers armed (first
// byte, then idle); true - the first-byte timer cleared by the payload and the idle timer re-armed a full window ahead; then one
// turn of the event loop lets the consumer register its next read (the timer's firing fails that read). The stages and stderr lines
// the send raised are recorded beside its outcome.
const send = async ({ net, clock }, reply, window, afterPayload = false) => {
  net.reply = reply;
  const provider = new GeminiProvider({ apiKey: 'fixture-key', preconnect: false });
  const stages = [];
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  let settled = false;
  const outcome = provider
    .send(HISTORY, MODEL, [], { onStageChange: (stage, payload) => stages.push(payload === undefined ? { stage } : { stage, payload }) })
    .then((result) => ({ result }), (error) => ({ error }))
    .finally(() => {
      settled = true;
      clock.notify();
    });
  try {
    if (window === null) {
      await clock.followRetries(outcome, { sites: SLEEP, what: 'connection ladder', causes: () => { const n = net.records.length; return () => net.records.length > n; } });
    } else {
      for (let k = 1; !settled; k++) {
        const watched = () => {
          const timers = clock.pendingFrom(WATCHDOG);
          return afterPayload ? timers.length === 1 && timers[0].due === Date.now() - rec.T0 + window : timers.length === 2;
        };
        await clock.until(() => settled || (net.records.length >= k && watched()), `attempt ${k}: its stream open and watched`);
        if (settled) break;
        await new Promise((resolve) => setImmediate(resolve));
        await clock.advance(window, { what: `attempt ${k}: the watchdog window (${window} ms)`, until: () => settled || clock.pendingFrom(SLEEP).length > 0 });
        if (settled) break;
        const [wait] = clock.pendingFrom(SLEEP);
        await clock.advance(wait.due - (Date.now() - rec.T0), { what: `attempt ${k}: the stream retry wait`, until: () => settled || net.records.length > k });
      }
    }
    return { ...(await outcome), stages, stderr };
  } finally {
    process.stderr.write = write;
  }
};

const refused = { status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 503, message: 'busy', status: 'UNAVAILABLE' } }) };
// The stream requests get `stream`; the one non-streaming re-issue a spent stream ladder makes (`_recoverGeminiNonStreaming`,
// gemini.mjs:349, POST :generateContent) is refused.
const streamOr503 = (stream) => (request) => (request.path.includes(':streamGenerateContent') ? stream : refused);
const silent = { status: 200, contentType: 'text/event-stream', chunks: [], hold: true };
await rec.run('first-chunk-timeouts-spend-the-stream-ladder', `${SRC}:60`, { streamReply: silent, generateContentReply: refused, windowMs: 60000 }, (ctx) => send(ctx, streamOr503(silent), 60000));
// A payload with no visible text (an empty text part): the stream is still replay-safe, so the idle timeout re-asks on the stream ladder.
const quiet = { status: 200, contentType: 'text/event-stream', chunks: [frames([{ candidates: [{ content: { role: 'model', parts: [{ text: '' }] } }] }])], hold: true };
await rec.run('idle-timeouts-spend-the-stream-ladder', `${SRC}:60`, { env: { MIXDOG_PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS: '120000' }, streamReply: quiet, generateContentReply: refused, windowMs: 120000 }, (ctx) => send(ctx, streamOr503(quiet), 120000, true));
await rec.run('refusals-spend-the-connection-ladder', `${SRC}:33`, { reply: refused }, (ctx) => send(ctx, () => refused, null));
await rec.finish();
