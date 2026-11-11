#!/usr/bin/env node
// openai-oauth-transport.test.mjs (13 test bodies, 24 rows with the loops): the real OpenAI OAuth WebSocket send path
// (`sendViaWebSocket` over a real WebSocket) and the real
// `OpenAIOAuthProvider.send` transport fallback (WS budget -> sticky HTTP, HTTP failure after fallback, handshake 404, application 404).
// Over real transports: the WebSocket is a real loopback server (lib/ws-world.mjs: the provider's own ws client connects, only `tls.connect` is redirected) and the HTTP
// fallback is the recorder's loopback HTTP endpoint (the product's own fetch). Each case is ONE ordered list: dial, upgrade request (every header), frames each way,
// closes, HTTP requests and their answers, the retry sleeps the product asks for (its `_sleepFn` seam wrapper records the ms and returns at once: no real waiting).
// Not over a socket: the two `cancelled` cases of :163 (an AbortError needs the caller to abort while the server holds the answer; the endpoint answers
// synchronously) stay on the product's seams (`_sendViaWebSocketFn` / `_sendViaHttpSseFn`). `ensureAuth` returns a fixture token and `_refreshModelCache` is stubbed (a catalog fetch).
//   node benchmarks/rust-core/recorders/record-openai-oauth-transport.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-oauth-transport',
  maskRow: (row) => {
    for (const call of row.calls ?? []) for (const arg of call.args) {
      const state = arg?.state;
      if (state && typeof state === 'object' && 'sendStartedAt' in state) state.sendStartedAt = '<performance.now(), real clock>';
      if (state?.sendSpan && typeof state.sendSpan === 'object') for (const key of Object.keys(state.sendSpan)) if (typeof state.sendSpan[key] === 'number') state.sendSpan[key] = '<ms, real clock>';
    }
  },
  exclusions: ['calls[*].args[*].state.sendStartedAt and every number under calls[*].args[*].state.sendSpan: performance.now() readings of the real clock, written as a marker (the keys stay)', 'result.transportTiming.*Ms: performance.now() durations of the real clock, written <ms, real clock> (the keys and the counts stay)'],
  entry: 'scripts/provider-toolcall/_shared.mjs re-exports: openai-oauth-ws.mjs sendViaWebSocket, openai-oauth.mjs OpenAIOAuthProvider.send (with ensureAuth stubbed to a fixture token and the _sendViaWebSocketFn/_sendViaHttpSseFn seams), openai-ws-stream.mjs _streamResponse (real), retry-classifier.mjs classifyError, MIXDOG_OAI_TRANSPORT=auto and the HTTP-fallback switches set as the test sets them. Not run: a real socket or HTTP request.',
  compare: 'mixdog-agent send.rs:573-640 (retractable replay on suppressed reasoning), mixdog-ai providers::openai adapter.rs:476-523,700-703, openai_ws_pool.rs:271,341 and retry decider: feed each row\'s scripted steps (`input`) and compare `result`/`error` fields, `fresh` (forceFresh per acquire), `progress`/`text` callbacks, acquire/WS/HTTP call counts, `delaysMs` and classification. NOTE: Node surfaces the HTTP failure as the current error (same object, previousTransportError kept) and sticks to HTTP for the session after fallback; K1 gaps-providers rows 5/44 describe where Rust differs.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::openai::OpenAiAdapter (openai/adapter.rs:308) with OpenAiCodec (openai/codec.rs:36) and build_body (openai/profile.rs:497), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079); the socket pool is WsPool::checkout (openai/pool.rs:178).",
});
const P = 'agent/orchestrator/providers/';
const { sendViaWebSocket } = await rec.P(`${P}openai-oauth-ws.mjs`);
const { sendViaHttpSse } = await rec.P(`${P}openai-oauth-http-sse.mjs`);
const { OpenAIOAuthProvider } = await rec.P(`${P}openai-oauth.mjs`);
const { classifyError } = await rec.P(`${P}retry-classifier.mjs`);
const SRC = 'scripts/provider-toolcall/openai-oauth-transport.test.mjs';

const ENV = { MIXDOG_AGENT_TRACE_DISABLE: '1', MIXDOG_OAI_TRANSPORT: 'auto', MIXDOG_OPENAI_HTTP_FALLBACK: '1', MIXDOG_OPENAI_OAUTH_HTTP_FALLBACK: '1', MIXDOG_QUIET_PROVIDER_LOG: '1' };
const withEnv = async (fn) => {
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) (v == null ? delete process.env[k] : (process.env[k] = v));
  }
};
const oauthProvider = () => {
  const provider = new OpenAIOAuthProvider({});
  provider.ensureAuth = async () => ({ access_token: 'fixture-token' });
  return provider;
};
const prebuiltBody = Object.freeze({ model: 'gpt-5.6-sol', instructions: 'fixture', input: [], tools: [], stream: true });
// transportTiming.*Ms are performance.now() durations (the real clock, not the virtual one): written as a marker, keys kept.
const maskTiming = (r) => (r && typeof r === 'object' && r.transportTiming ? { ...r, transportTiming: Object.fromEntries(Object.entries(r.transportTiming).map(([k, v]) => [k, /Ms$/.test(k) && typeof v === 'number' ? '<ms, real clock>' : v])) } : r);
const attempt = async (promise) => {
  try {
    return { result: maskTiming(await promise) };
  } catch (error) {
    return { error };
  }
};

const world = await rec.wsWorld();
const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const created = (id) => ({ type: 'response.created', response: { id, model: prebuiltBody.model } });
const completed = (id, text) => [created(id), { type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: { id, model: prebuiltBody.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1, output_tokens: 1 } } }];
const reasoningClose = (type) => ({ frames: [created('reasoning-response'), { type, delta: 'hidden reasoning' }], close: [1006, ''] });
const dropAlways = { frames: [], close: [1006, ''] };
// Server scripts: `wsPlans` is one entry per connection (the last one repeats), `refusals` the upgrade refusals by attempt, `http` one answer per HTTP request.
function serve(net, { wsPlans = [dropAlways], refusals = [], http = [] }) {
  let connections = 0;
  world.reset({
    refuse: (_req, n) => refusals[n - 1],
    onFrame: (conn) => {
      const plan = wsPlans[Math.min(connections++, wsPlans.length - 1)];
      for (const frame of plan.frames) conn.send(frame);
      if (plan.close) (plan.close[0] === 1006 ? conn.terminate() : conn.close(plan.close[0], plan.close[1]));
    },
  });
  net.reply = (record, n) => {
    world.note({ event: 'http-request', n, method: record.method, path: record.path, headers: record.headers, body: record.body });
    const answer = (typeof http === 'function' ? http(record, n) : http[Math.min(n - 1, http.length - 1)]) ?? { status: 404, contentType: 'application/json', body: '{}' };
    world.note({ event: 'http-response', n, status: answer.status ?? 200, headers: answer.headers ?? [], body: answer.body });
    return answer;
  };
}
const sleeper = (delays) => async (ms) => { delays.push(ms); world.note({ event: 'sleep-requested', ms }); };
// The HTTP fallback's own retry sleep is its `_sleepFn` argument (the product passes none in production): the wrapper hands it the recording sleeper, like the WS wrapper.
const httpViaSleeper = (delays) => (args) => sendViaHttpSse({ ...args, _sleepFn: sleeper(delays) });
const wsViaSleeper = (delays) => (args) => sendViaWebSocket({ ...args, _sleepFn: sleeper(delays), _sendSpanTraceFn: () => {}, _agentTraceFn: () => {} });
const finish = async (out, delays) => {
  for (const conn of world.conns) conn.close(1000, 'recorder-end');
  await world.until((trace) => trace.filter((e) => e.event === 'closed').length >= trace.filter((e) => e.event === 'open').length, 'all sockets closed');
  return { ...out, delaysMs: delays, events: world.trace.map((e) => ({ ...e })) };
};

for (const type of ['response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.reasoning.summary.delta']) {
  await rec.run(`suppressed-reasoning-permits-fresh-ws-retry:${type}`, `${SRC}:77`, { connections: ['created + reasoning delta, then the drop (1006)', 'completed ws-recovered'] }, ({ net }) => withEnv(async () => {
    serve(net, { wsPlans: [reasoningClose(type), { frames: completed('resp_ok', 'ws-recovered') }] });
    const delays = [];
    const out = await attempt(sendViaWebSocket({
      auth: { access_token: 'fixture-token' }, body: prebuiltBody, useModel: prebuiltBody.model, poolKey: 'oauth-reasoning-retry', cacheKey: 'oauth-reasoning-retry', forceFresh: true,
      onStreamDelta: (kind) => world.note({ event: 'progress', kind }), onTextDelta: (delta) => world.note({ event: 'text', chunk: delta }),
      _sleepFn: sleeper(delays), _sendSpanTraceFn: () => {}, _agentTraceFn: () => {},
    }));
    return finish(out, delays);
  }));
}
await rec.run('reasoning-only-closes-exhaust-ws-budget-switch-to-http', `${SRC}:111`, { connections: 'every connection: created + reasoning summary delta, then the drop (1006)', http: 'completed http-recovered' }, ({ net }) => withEnv(async () => {
  serve(net, { wsPlans: [reasoningClose('response.reasoning_summary_text.delta')], http: [{ status: 200, body: sse(completed('resp_http', 'http-recovered')) }] });
  const provider = oauthProvider();
  const delays = [];
  const opts = { sessionId: 'oauth-reasoning-close-fallback', _prebuiltBody: prebuiltBody, _sendViaWebSocketFn: wsViaSleeper(delays), _sendViaHttpSseFn: httpViaSleeper(delays) };
  world.note({ event: 'send-start', n: 1 });
  const first = await attempt(provider.send([], prebuiltBody.model, [], opts));
  world.note({ event: 'send-result', n: 1, ok: !first.error });
  world.note({ event: 'send-start', n: 2 });
  const second = await attempt(provider.send([], prebuiltBody.model, [], opts));
  world.note({ event: 'send-result', n: 2, ok: !second.error });
  return finish({ first, second, baseDelaysMs: [200, 400, 800, 1600, 3200] }, delays);
}));

const httpAnswers = {
  '401': { status: 401, contentType: 'application/json', body: '{"error":{"message":"unauthorized"}}' },
  '403': { status: 403, contentType: 'application/json', body: '{"error":{"message":"forbidden"}}' },
  '429': { status: 429, contentType: 'application/json', headers: { 'retry-after': '15' }, body: '{"error":{"message":"rate limited"}}' },
  '503': { status: 503, contentType: 'application/json', body: '{"error":{"message":"unavailable"}}' },
  'empty-200': { status: 200, body: '' },
  'visible text': { status: 200, body: sse([created('resp_cut'), { type: 'response.output_text.delta', delta: 'visible' }]) },
  'dispatched tool': { status: 200, body: sse([created('resp_cut'), { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read' } }, { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{}' } }]) },
};
for (const authRetry of [false, true]) {
  for (const label of Object.keys(httpAnswers)) {
    await rec.run(`http-${label}-after-ws-fallback${authRetry ? '-and-auth-recovery' : ''}`, `${SRC}:163`, { authRetry, connections: [authRetry ? 'upgrade refused 401 first, then every connection dropped (1006)' : 'every connection dropped (1006)'], http: ['every HTTP request of send 1 answered with ' + label, 'send 2: completed http-ok'] }, ({ net }) => withEnv(async () => {
      let httpPhase = 'fail';
      serve(net, { refusals: authRetry ? [{ status: 401, headers: [['content-type', 'application/json']], body: '{"error":{"message":"expired auth"}}' }] : [], http: () => (httpPhase === 'fail' ? httpAnswers[label] : { status: 200, body: sse(completed('resp_http_ok', 'http-ok')) }) });
      const provider = oauthProvider();
      const delays = [];
      const opts = { sessionId: `oauth-current-http-${authRetry}-${label}`, _prebuiltBody: prebuiltBody, _sendViaWebSocketFn: wsViaSleeper(delays), _sendViaHttpSseFn: httpViaSleeper(delays) };
      world.note({ event: 'send-start', n: 1 });
      const failed = await attempt(provider.send([], prebuiltBody.model, [], opts));
      world.note({ event: 'send-result', n: 1, ok: !failed.error });
      httpPhase = 'ok';
      world.note({ event: 'send-start', n: 2 });
      const next = await attempt(provider.send([], prebuiltBody.model, [], opts));
      world.note({ event: 'send-result', n: 2, ok: !next.error });
      return finish({ failed, next }, delays);
    }));
  }
}
// The two cancelled cases stay on the seams: the abort comes from the caller, not from the wire.
for (const authRetry of [false, true]) {
  await rec.run(`http-cancelled-after-ws-fallback${authRetry ? '-and-auth-recovery' : ''}`, `${SRC}:163`, { authRetry, httpErrorFields: { name: 'AbortError' }, expectedClassification: 'permanent' }, () => withEnv(async () => {
    const provider = oauthProvider();
    const wsError = Object.assign(new Error('WS disconnected'), { wsCloseCode: 1006, code: 'ECONNRESET', retryClassifier: 'ws_1006', wsRetriesExhausted: true });
    const httpError = Object.assign(new Error('current HTTP failure'), { name: 'AbortError' });
    let wsCalls = 0;
    let httpCalls = 0;
    const opts = {
      sessionId: `oauth-current-http-${authRetry}-cancelled`, _prebuiltBody: prebuiltBody,
      _sendViaWebSocketFn: async () => { wsCalls += 1; if (authRetry && wsCalls === 1) throw Object.assign(new Error('expired auth'), { httpStatus: 401 }); throw wsError; },
      _sendViaHttpSseFn: async () => { httpCalls += 1; throw httpError; },
    };
    const failed = await attempt(provider.send([], prebuiltBody.model, [], opts));
    return { ...failed, classification: classifyError(failed.error), wsCalls, httpCalls };
  }));
}
await rec.run('handshake-404-falls-back-to-http-once', `${SRC}:211`, { connections: 'upgrade refused 404', http: 'completed http-ok' }, ({ net }) => withEnv(async () => {
  serve(net, { refusals: [{ status: 404, headers: [['content-type', 'application/json']], body: '{"error":{"message":"not found"}}' }], http: [{ status: 200, body: sse(completed('resp_http', 'http-ok')) }] });
  const provider = oauthProvider();
  let catalogRefreshes = 0;
  provider._refreshModelCache = async () => { catalogRefreshes += 1; };
  const delays = [];
  const result = await attempt(provider.send([], 'gpt-5.6-sol', [], { sessionId: 'oauth-handshake-404', _prebuiltBody: prebuiltBody, _sendViaWebSocketFn: wsViaSleeper(delays), _sendViaHttpSseFn: httpViaSleeper(delays) }));
  return finish({ ...result, catalogRefreshes }, delays);
}));
await rec.run('application-404-stays-model-error', `${SRC}:247`, { connections: ['an error frame: status 404 model_not_found'], http: 'must not be reached' }, ({ net }) => withEnv(async () => {
  serve(net, { wsPlans: [{ frames: [{ type: 'error', status: 404, error: { code: 'model_not_found', message: 'model_not_found' } }] }], http: [{ status: 200, body: sse(completed('resp_must_not', 'must-not-fallback')) }] });
  const provider = oauthProvider();
  let catalogRefreshes = 0;
  provider._refreshModelCache = async () => { catalogRefreshes += 1; };
  const delays = [];
  const out = await attempt(provider.send([], 'gpt-5.6-sol', [], { sessionId: 'oauth-application-404', _prebuiltBody: prebuiltBody, _sendViaWebSocketFn: wsViaSleeper(delays), _sendViaHttpSseFn: httpViaSleeper(delays) }));
  return finish({ ...out, catalogRefreshes }, delays);
}));
await rec.finish();
