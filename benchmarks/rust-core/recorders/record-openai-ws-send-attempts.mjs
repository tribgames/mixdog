#!/usr/bin/env node
// openai-ws-send-attempts.test.mjs (19 tests): the real `createWsSendAttempts` (handshakeFailed / streamFailed / exhausted), the real
// `createWsSendContext` reconnect stage, `emitProviderRetryStage`, `retryReasonClass`, `safeRetryErrorCode` and `providerTimeoutError`. The
// retry sleep is the test's injected `sleepFn` (it records the requested ms and returns at once), the progress / stage / trace callbacks
// record every argument, and the clock is the virtual clock (`retryAt` is `Date.now()` of it plus the advised wait).
// The cases whose failure comes from the wire (:86 an HTTP 401 on the upgrade, :124/:142/:374 a dropped connection, :153 a rate-limited response.failed frame, :431 a 1009
// close on the retry) are ALSO recorded over a real loopback WebSocket (`ws-*` case ids): the real `sendViaWebSocket` connects to it, the server's scripted answers
// are the inputs, and the case is ONE ordered list (dial, upgrade request with every header, frames each way, closes, the retry sleeps the product requests, the
// stage/progress callbacks). The retry sleep is the product's own `_sleepFn` injection point (records the requested ms, returns at once: no real waiting).
// Not over a socket: :74/:97/:111 (the handshake retry classifier table and budget are driven with constructed errors: the handshake retry layer sleeps with its own
// real timers, openai-ws-send/handshake-retry), :165/:180/:214/:284/:297/:325/:354/:362 (pure formatting of an already-built error or stage: no transport call exists),
// :392/:417/:464/:478 (they need a prior stored response id / duplicate-item server text the loopback cannot reproduce without a full session: kept on the state machine).
//   node benchmarks/rust-core/recorders/record-openai-ws-send-attempts.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  // Every case without a socket: the Node test builds the failure by hand against `createWsSendAttempts` / the formatting helpers. Where the same behaviour is reachable over the wire it is
  // ALSO recorded as a `ws-*` case (the state-machine rows :74 :86 :97 :111 :124 :142 :153 :165 :214 :374 :392 :431). What remains has no same-input/output public Rust function:
  // looked in crates/** (mixdog-ai, mixdog-core-api domain/provider.rs, mixdog-agent) for retry_reason_class / safe_retry_error_code / emit_provider_retry_stage / provider_timeout_error /
  // reconnecting-stage builders: none is public; the retry stage is produced inside the broker retry loop.
  pure: { '*': 'RUST WORK: no public Rust function takes the same input/output (see the recorder header: the retry stage and its reason class exist only inside the broker retry loop); the wire `ws-*` cases are the replayable form' },
  set: 'provider-openai-ws-send-attempts',
  net: false,
  exclusions: ['NOT HELD (not reproducible at the wire): stream-stored-xai-anchor-carried-into-next-attempt (:464) - tried: two sends on one pool key with auth xai and store:true over the real sender; the second send dials a new socket instead of reusing the first (recorded in the attempt, no anchored entry exists when the retry starts) and its retry frame carries no previous_response_id, so the Node test state (an entry holding resp_1) is only reachable on a hand-built entry', 'NOT HELD (observable nowhere outside Node objects): token-refresh-timeout-classifies-as-auth (:345) - the classification of a token-refresh timeout error is read from the error object of the auth refresh (an HTTP exchange with the auth server outside this socket); exhausted-falls-back-to-first-error-or-unreachable-marker (:478) - the explicit unreachable marker is the return value of an internal accessor of a send that ended without any attempt, a state no send reaches', 'NOT HELD HERE, recorded at the wire in provider-openai-ws-stream: typed-timeouts-keep-their-own-wording (:325) - the wording of the typed first-byte / idle / first-output timeouts is the message of the error the send surfaces (cases prestream-watchdog-closes-silent-socket-first-byte-timeout, inter-chunk-stall-after-output-rejects-as-continuation, no-output-aborted-at-first-output-deadline, semantic-idle-applies-after-first-output)', 'reconnect-stage-names-failure-and-counts-down-advised-wait (:181) is the stage events of ws-rate-limited-response-failed-waits-advised-time and ws-long-advised-wait-announced-before-it-starts', 'result.error.props.transportTiming.*Ms and result.result.transportTiming.*Ms of the ws-* cases: performance.now() durations of the real clock, written as a marker (the keys stay)'],
  maskRow: (row) => {
    const walk = (value) => {
      if (!value || typeof value !== 'object') return;
      if (value.transportTiming && typeof value.transportTiming === 'object') for (const [k, v] of Object.entries(value.transportTiming)) if (/Ms$/.test(k) && typeof v === 'number') value.transportTiming[k] = '<ms, real clock>';
      for (const child of Object.values(value)) walk(child);
    };
    if (row.id?.startsWith('ws-')) walk(row.result);
  },
  entry: 'src/runtime/agent/orchestrator/providers/openai-ws-send-attempts.mjs createWsSendAttempts(opts) / openai-ws-send/send-context.mjs createWsSendContext(opts), provider-error-kind.mjs retryReasonClass / safeRetryErrorCode, retry-executor.mjs emitProviderRetryStage, stall-policy.mjs providerTimeoutError. The state-machine cases feed a scripted Error (own properties are the inputs) and read `attempts.state` and the error objects after each call; the `ws-*` cases run sendViaWebSocket over a real loopback WebSocket.',
  compare: 'mixdog-agent send.rs:541-664 (retry loop, advised wait, reasons), mixdog-ai retry decider.rs:55-57,172-185 and retry advice.rs, openai adapter.rs: feed each case\'s scripted errors / midState and compare `results`, `progress`, `sleeps`, `details`, `traces`, `stages` and the error fields. K1 gap G10 (exhaustion surfaces the first error, not the last) and G1 (xAI WS carry-forward) are OPEN in the core, so those cases are expected to differ.',
  replay: "Rust entry (pub, on o1): mixdog_ai::broker ModelBroker::send (broker/send.rs:75) with mixdog_ai::retry StandardRetryDecider (retry/decider.rs:35), retry::classify::kind_of (retry/classify.rs:142) and retry::advice::from_headers (retry/advice.rs:25). The helper createWsSendAttempts / createWsSendContext have no Rust item of that name: the behaviour is the broker's retry loop; the first-error-with-cause exhaustion is K1 G10, work for the Rust side.",
});
const P = 'agent/orchestrator/providers/';
const { createStreamSafetyStamps } = await rec.P(`${P}retry-classifier.mjs`);
const { createWsSendAttempts, MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT } = await rec.P(`${P}openai-ws-send-attempts.mjs`);
const { createWsSendContext } = await rec.P(`${P}openai-ws-send/send-context.mjs`);
const { retryReasonClass, safeRetryErrorCode } = await rec.P(`${P}provider-error-kind.mjs`);
const { providerTimeoutError } = await rec.P('agent/orchestrator/stall-policy.mjs');
const { emitProviderRetryStage } = await rec.P(`${P}retry-executor.mjs`);
const { sendViaWebSocket } = await rec.P(`${P}openai-oauth-ws.mjs`);
const world = await rec.wsWorld();
const SRC = 'src/runtime/agent/orchestrator/providers/openai-ws-send-attempts.test.mjs';

function harness(overrides = {}) {
  const progress = [];
  const details = [];
  const spanEvents = [];
  const sleeps = [];
  const sendSpan = { retryBackoffMs: 0, poolAcquireMs: 0, poolOwnerWaitMs: 0, emit(kind, target) { spanEvents.push([kind, target]); } };
  const attempts = createWsSendAttempts({
    externalSignal: null, sleepFn: async (ms) => { sleeps.push(ms); }, sendSpan,
    emitReconnectProgress: (p) => { progress.push({ attempt: p.attempt, max: p.max, classifier: p.classifier }); details.push(p); },
    safetyStamps: createStreamSafetyStamps(), handshakeErrorPolicy: null, retry429: true, stallRetryBudget: { allowStallRetry: () => true },
    trace: { poolKey: 'send-attempts-test', traceProvider: 'openai-oauth', useModel: 'gpt-5' }, auth: null, body: {}, ...overrides,
  });
  return { attempts, progress, details, spanEvents, sleeps, sendSpan };
}
const fakeEntry = (extra = {}) => ({ socket: { readyState: 3, close() {}, terminate() {} }, busy: true, lastResponseId: null, ...extra });
const midState = (extra = {}) => ({ attemptIndex: 0, sawResponseCreated: true, sawCompleted: false, emittedText: false, emittedToolCall: false, emittedReasoning: false, startedToolCall: false, ...extra });
const handshakeInfo = (attemptIndex) => ({ attemptIndex, handshakeStart: 0, handshakeRetries: 0, handshakeRetryClassifiers: [] });
const settle = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
const logs = (h) => ({ progress: h.progress, details: h.details, spanEvents: h.spanEvents, sleeps: h.sleeps });
const errorOf = (message, props) => ({ message, props });
const make = ({ message, props }) => Object.assign(new Error(message), props);
const LIMIT = MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT;

// ---- over a real loopback WebSocket ----
const completed = (id) => [{ type: 'response.created', response: { id, model: 'gpt-fixture' } }, { type: 'response.completed', response: { id, model: 'gpt-fixture', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } } }];
async function overSocket(plans, { refusals = [], poolKey, sendExtras = {}, body = { model: 'gpt-fixture', input: [{ type: 'message', role: 'user', content: 'hi' }] } }) {
  let connections = 0;
  world.reset({
    refuse: (_req, n) => refusals[n - 1],
    onFrame: (conn) => {
      const plan = plans[connections++];
      for (const frame of plan.frames) conn.send(frame);
      if (plan.close) (plan.close[0] === 1006 ? conn.terminate() : conn.close(plan.close[0], plan.close[1]));
    },
  });
  // The send's own backoff sleeps run on the virtual clock: every armed retry sleep is advanced to (a recorded step) until the send ends.
  const settled = sendViaWebSocket({
    auth: { type: 'xai', access_token: 'fixture-access-token' }, body, poolKey, cacheKey: 'send-attempts-ws', iteration: 0, useModel: 'gpt-fixture', traceProvider: 'xai', forceFresh: true,
    onStageChange: (stage, detail) => world.note({ event: 'stage', stage, detail }),
    onTextDelta: (chunk) => world.note({ event: 'text', chunk }),
    onStreamDelta: (kind) => world.note({ event: 'progress', kind }),
    ...sendExtras,
  }).then((result) => ({ result }), (error) => ({ error }));
  const outcome = await rec.clock.followRetries(settled);
  for (const conn of world.conns) conn.close(1000, 'recorder-end');
  await world.until((trace) => trace.every((e) => e.event !== 'open') || trace.filter((e) => e.event === 'closed').length >= trace.filter((e) => e.event === 'open').length, 'all sockets closed');
  return { ...outcome, events: world.trace.map((e) => ({ ...e })) };
}
await rec.run('ws-http-401-on-upgrade-surfaces-immediately', `${SRC}:86`, { refusals: [401] }, () => overSocket([], { refusals: [{ status: 401, headers: [['content-type', 'application/json']], body: '{"error":{"message":"unauthorized"}}' }], poolKey: 'sa-401' }));
await rec.run('ws-abnormal-close-before-output-retries-on-a-new-socket', `${SRC}:124`, { connections: ['frames: none, then the server drops the connection (1006)', 'completed'] }, () => overSocket([{ frames: [], close: [1006, ''] }, { frames: completed('resp_retry') }], { poolKey: 'sa-1006' }));
await rec.run('ws-cut-while-tool-input-streams-surfaces', `${SRC}:142`, { connections: ['created + function_call item added, then the drop (1006)'] }, () => overSocket([{ frames: [{ type: 'response.created', response: { id: 'resp_cut', model: 'gpt-fixture' } }, { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read' } }], close: [1006, ''] }], { poolKey: 'sa-cut' }));
await rec.run('ws-rate-limited-response-failed-waits-advised-time', `${SRC}:153`, { connections: ['response.failed rate_limit_exceeded "try again in 1.5s"', 'completed'] }, () => overSocket([{ frames: [{ type: 'response.failed', response: { id: 'resp_rl', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 1.5s.' } } }] }, { frames: completed('resp_after') }], { poolKey: 'sa-rl' }));
await rec.run('ws-relayed-text-then-drop-surfaces-without-replay', `${SRC}:374`, { connections: ['created + text delta, then the drop (1006)'] }, () => overSocket([{ frames: [{ type: 'response.created', response: { id: 'resp_t', model: 'gpt-fixture' } }, { type: 'response.output_text.delta', delta: 'half' }], close: [1006, ''] }], { poolKey: 'sa-text' }));
await rec.run('ws-server-1009-on-retry-surfaces-itself', `${SRC}:431`, { connections: ['drop (1006)', 'close 1009 message too big'] }, () => overSocket([{ frames: [], close: [1006, ''] }, { frames: [], close: [1009, 'too big'] }], { poolKey: 'sa-1009' }));
// ---- more state-machine cases over the socket (the Node tests build the failures by hand; the wire produces them) ----
await rec.run('ws-connection-reset-on-every-upgrade-spends-budget-then-surfaces-first-error', `${SRC}:111`, { refusals: 'every upgrade request: the server resets the connection', note: 'also covers :74 (a transient connect error spends the budget and retries)' }, () => overSocket([], { refusals: Array.from({ length: 12 }, () => ({ reset: true })), poolKey: 'sa-reset' }));
await rec.run('ws-policy-veto-503-on-upgrade-tagged-for-http-fallback', `${SRC}:97`, { refusals: [503], handshakeErrorPolicy: 'retry:false, httpFallback when classifier === http_503' }, () => overSocket([], { refusals: [{ status: 503, headers: [['content-type', 'application/json']], body: '{"error":{"message":"unavailable"}}' }], poolKey: 'sa-503', sendExtras: { handshakeErrorPolicy: ({ classifier }) => ({ retry: false, httpFallback: classifier === 'http_503' }) } }));
await rec.run('ws-long-advised-wait-announced-before-it-starts', `${SRC}:165`, { connections: ['response.failed rate_limit_exceeded "try again in 90s"', 'completed'] }, () => overSocket([{ frames: [{ type: 'response.failed', response: { id: 'resp_long', error: { code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 90s.' } } }] }, { frames: completed('resp_long_retry') }], { poolKey: 'sa-long' }));
await rec.run('ws-server-error-text-never-reaches-retry-stage', `${SRC}:214`, { connections: ['response.failed server_error with echoed prompt, token and account in the message', 'completed'] }, () => overSocket([{ frames: [{ type: 'response.failed', response: { id: 'resp_echo', error: { code: 'server_error', message: 'upstream echoed prompt "hi", token sk-LEAK-fixture and account acct-LEAK-fixture' } } }] }, { frames: completed('resp_echo_retry') }], { poolKey: 'sa-echo' }));
await rec.run('ws-duplicate-reasoning-rejection-strips-replay-once', `${SRC}:392`, { connections: ['response.failed: duplicate item rs_dup already exists', 'completed'], requestInput: 'a user message and a reasoning item rs_dup' }, () => overSocket([{ frames: [{ type: 'response.failed', response: { id: 'resp_dup', error: { code: 'invalid_request_error', message: 'Duplicate item found with id rs_dup. Reasoning item already exists.' } } }] }, { frames: completed('resp_dup_retry') }], { poolKey: 'sa-dup', body: { model: 'gpt-fixture', input: [{ type: 'message', role: 'user', content: 'hi' }, { type: 'reasoning', id: 'rs_dup', summary: [], encrypted_content: 'enc' }] } }));
// ---- the former constructed-failure cases, observed where a caller can observe them ----
// :74 a transient connect error spends the stream budget and retries: covered by ws-connection-reset-on-every-upgrade-spends-budget-then-surfaces-first-error (the upgrade is reset, the sender retries and surfaces the first error).
// :417 the budget is spent: the first error surfaces and the last attempt's error is its cause - the send's rejection as the caller gets it.
await rec.run('ws-stream-drops-on-every-connection-spend-budget-first-error-with-last-as-cause', `${SRC}:417`, { connections: 'every connection: created, then the server drops it (1006)', count: 12 }, () => overSocket(Array.from({ length: 12 }, () => ({ frames: [{ type: 'response.created', response: { id: 'resp_drop', model: 'gpt-fixture' } }], close: [1006, ''] })), { poolKey: 'sa-exhaust' }));
// :272 / :297 / :362 the retry stage carries a reason class and a code from a known list, never the text of the failure: one send per code, the stage events of each are in its events.
const failedWith = (code, message) => [{ type: 'response.failed', response: { id: 'resp_code', error: { code, message } } }];
await rec.run('ws-retry-stage-carries-known-codes-never-failure-text', `${SRC}:272`, { codes: ['rate_limit_exceeded', 'usage_limit_reached', 'server_is_overloaded', 'model_not_found', 'acct_private-123', 'user_12345', 'sk-abc', 'prompt words', 'INJECTED_CLASS text'], connections: 'response.failed with the code and a message that repeats it, then completed' }, async () => {
  const sends = [];
  for (const [i, code] of ['rate_limit_exceeded', 'usage_limit_reached', 'server_is_overloaded', 'model_not_found', 'acct_private-123', 'user_12345', 'sk-abc', 'prompt words', 'INJECTED_CLASS text'].entries()) {
    sends.push({ code, ...(await overSocket([{ frames: failedWith(code, `failure text ${code}`) }, { frames: completed(`resp_ok_${i}`) }], { poolKey: `sa-code-${i}` })) });
  }
  return { sends };
});
await rec.finish();
