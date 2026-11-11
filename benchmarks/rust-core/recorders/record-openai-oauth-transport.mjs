#!/usr/bin/env node
// openai-oauth-transport.test.mjs (13 test bodies, 24 rows with the loops): the real OpenAI OAuth WebSocket send path
// (`sendViaWebSocket`, the real `_streamResponse` over a scripted socket that emits the recorded frames and closes 1006) and the real
// `OpenAIOAuthProvider.send` transport fallback (WS budget -> sticky HTTP, HTTP failure after fallback, handshake 404, application 404).
// The connection layer is scripted through the product's own injection points (`_acquireWithRetryFn`, `_sendFrameFn`, `_streamFn`,
// `_sleepFn`, `_sendViaWebSocketFn`, `_sendViaHttpSseFn`): the sockets, the HTTP transport and the sleeps are the scripted external side;
// every sleep the product asks for is recorded (delays), none waits. Credentials: `ensureAuth` returns a fixture token.
//   node benchmarks/rust-core/recorders/record-openai-oauth-transport.mjs --tree <exact export of b6f10295a>
import { EventEmitter } from 'node:events';
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-openai-oauth-transport',
  net: false,
  exclusions: ['result.transportTiming.*Ms: performance.now() durations of the real clock, written <ms, real clock> (the keys and the counts stay)'],
  entry: 'scripts/provider-toolcall/_shared.mjs re-exports: openai-oauth-ws.mjs sendViaWebSocket, openai-oauth.mjs OpenAIOAuthProvider.send (with ensureAuth stubbed to a fixture token and the _sendViaWebSocketFn/_sendViaHttpSseFn seams), openai-ws-stream.mjs _streamResponse (real), retry-classifier.mjs classifyError, MIXDOG_OAI_TRANSPORT=auto and the HTTP-fallback switches set as the test sets them. Not run: a real socket or HTTP request.',
  replay: 'mixdog-agent send.rs:573-640 (retractable replay on suppressed reasoning), mixdog-ai providers::openai adapter.rs:476-523,700-703, openai_ws_pool.rs:271,341 and retry decider: feed each row\'s scripted steps (`input`) and compare `result`/`error` fields, `fresh` (forceFresh per acquire), `progress`/`text` callbacks, acquire/WS/HTTP call counts, `delaysMs` and classification. NOTE: Node surfaces the HTTP failure as the current error (same object, previousTransportError kept) and sticks to HTTP for the session after fallback; K1 gaps-providers rows 5/44 describe where Rust differs.',
});
const P = 'agent/orchestrator/providers/';
const { sendViaWebSocket } = await rec.P(`${P}openai-oauth-ws.mjs`);
const { OpenAIOAuthProvider } = await rec.P(`${P}openai-oauth.mjs`);
const { _streamResponse } = await rec.P(`${P}openai-ws-stream.mjs`);
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
const streamEntry = () => {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.close = () => { socket.readyState = 3; };
  socket.terminate = socket.close;
  return { socket, ephemeral: true };
};
const closeAfterReasoning = (args, type) => {
  const pending = _streamResponse({ ...args, logSuppressedReasoningDeltas: false });
  const socket = args.entry.socket;
  for (const event of [{ type: 'response.created', response: { id: 'reasoning-response', model: prebuiltBody.model } }, { type, delta: 'hidden reasoning' }]) socket.emit('message', Buffer.from(JSON.stringify(event)));
  socket.close();
  socket.emit('close', 1006, Buffer.alloc(0));
  return pending;
};
// 	ransportTiming.*Ms are performance.now() durations (the real clock, not the virtual one): written as a marker, keys kept.
const maskTiming = (r) => (r && typeof r === 'object' && r.transportTiming ? { ...r, transportTiming: Object.fromEntries(Object.entries(r.transportTiming).map(([k, v]) => [k, /Ms$/.test(k) && typeof v === 'number' ? '<ms, real clock>' : v])) } : r);
const attempt = async (promise) => {
  try {
    return { result: maskTiming(await promise) };
  } catch (error) {
    return { error };
  }
};

for (const type of ['response.reasoning_text.delta', 'response.reasoning_summary_text.delta', 'response.reasoning.summary.delta']) {
  await rec.run(`suppressed-reasoning-permits-fresh-ws-retry:${type}`, `${SRC}:77`, { closeFrames: ['response.created', type], closeCode: 1006 }, () => withEnv(async () => {
    const fresh = [];
    const progress = [];
    const text = [];
    let streams = 0;
    const out = await attempt(sendViaWebSocket({
      auth: { access_token: 'fixture-token' }, body: prebuiltBody, useModel: prebuiltBody.model,
      onStreamDelta: (kind) => progress.push(kind), onTextDelta: (delta) => text.push(delta),
      _acquireWithRetryFn: async ({ forceFresh }) => { fresh.push(forceFresh); return { entry: streamEntry(), reused: false }; },
      _sendFrameFn: async () => {}, _streamFn: async (args) => {
        streams += 1;
        if (streams === 1) return closeAfterReasoning(args, type);
        args.state.sawCompleted = true;
        return { content: 'ws-recovered', toolCalls: [] };
      },
      _sleepFn: async () => {}, _sendSpanTraceFn: () => {}, _agentTraceFn: () => {},
    }));
    return { ...out, fresh, progress, text, streams };
  }));
}
await rec.run('reasoning-only-closes-exhaust-ws-budget-switch-to-http', `${SRC}:111`, { closeFrames: ['response.created', 'response.reasoning_summary_text.delta'], closeCode: 1006 }, () => withEnv(async () => {
  const provider = oauthProvider();
  let acquires = 0;
  let httpCalls = 0;
  const delays = [];
  const opts = {
    sessionId: 'oauth-reasoning-close-fallback', _prebuiltBody: prebuiltBody,
    _sendViaWebSocketFn: (args) => sendViaWebSocket({
      ...args,
      _acquireWithRetryFn: async () => { acquires += 1; return { entry: streamEntry(), reused: false }; },
      _sendFrameFn: async () => {}, _streamFn: (request) => closeAfterReasoning(request, 'response.reasoning_summary_text.delta'),
      _sleepFn: async (ms) => { delays.push(ms); }, _sendSpanTraceFn: () => {}, _agentTraceFn: () => {},
    }),
    _sendViaHttpSseFn: async () => { httpCalls += 1; return { content: 'http-recovered', toolCalls: [] }; },
  };
  const first = maskTiming(await provider.send([], prebuiltBody.model, [], opts));
  const afterFirst = { acquires, httpCalls };
  const second = maskTiming(await provider.send([], prebuiltBody.model, [], opts));
  return { first, afterFirst, second, afterSecond: { acquires, httpCalls }, delaysMs: delays, baseDelaysMs: [200, 400, 800, 1600, 3200] };
}));

for (const authRetry of [false, true]) {
  for (const [label, fields, classification] of [
    ['401', { httpStatus: 401 }, 'auth'], ['403', { httpStatus: 403 }, 'auth'], ['429', { httpStatus: 429, retryAfterMs: 15000 }, 'permanent'], ['503', { httpStatus: 503 }, 'transient'],
    ['unknown', {}, 'unknown'], ['cancelled', { name: 'AbortError' }, 'permanent'], ['visible text', { liveTextEmitted: true, unsafeToRetry: true }, 'permanent'], ['dispatched tool', { emittedToolCall: true, unsafeToRetry: true }, 'permanent'],
  ]) {
    await rec.run(`http-${label}-stays-current-failure-after-${authRetry ? 'auth-recovery-and-' : ''}ws-fallback`, `${SRC}:163`, { authRetry, httpErrorFields: fields, expectedClassification: classification }, () => withEnv(async () => {
      const provider = oauthProvider();
      const wsError = Object.assign(new Error('WS disconnected'), { wsCloseCode: 1006, code: 'ECONNRESET', retryClassifier: 'ws_1006', wsRetriesExhausted: true });
      const httpCause = new Error('current HTTP cause');
      const httpError = Object.assign(new Error('current HTTP failure', { cause: httpCause }), fields);
      let wsCalls = 0;
      let httpCalls = 0;
      let failHttp = true;
      const opts = {
        sessionId: `oauth-current-http-${authRetry}-${label}`, _prebuiltBody: prebuiltBody,
        _sendViaWebSocketFn: async () => {
          wsCalls += 1;
          if (authRetry && wsCalls === 1) throw Object.assign(new Error('expired auth'), { httpStatus: 401 });
          throw wsError;
        },
        _sendViaHttpSseFn: async () => { httpCalls += 1; if (failHttp) throw httpError; return { content: 'http-ok', toolCalls: [] }; },
      };
      const failed = await attempt(provider.send([], prebuiltBody.model, [], opts));
      const error = failed.error;
      const afterFailure = { wsCalls, httpCalls };
      failHttp = false;
      const next = await attempt(provider.send([], prebuiltBody.model, [], opts));
      return {
        error, isTheHttpError: error === httpError, causeIsTheHttpCause: error.cause === httpCause, previousTransportErrorIsTheWsError: error.previousTransportError === wsError,
        classification: classifyError(error), afterFailure, next, afterNext: { wsCalls, httpCalls },
      };
    }));
  }
}
const handshake404 = () => Object.assign(new Error('handshake 404'), { httpStatus: 404 });
await rec.run('handshake-404-falls-back-to-http-once', `${SRC}:211`, { handshakeStatus: 404 }, () => withEnv(async () => {
  const provider = oauthProvider();
  let acquires = 0;
  let httpCalls = 0;
  let catalogRefreshes = 0;
  provider._refreshModelCache = async () => { catalogRefreshes += 1; };
  const result = maskTiming(await provider.send([], 'gpt-5.6-sol', [], {
    sessionId: 'oauth-handshake-404', _prebuiltBody: prebuiltBody,
    _sendViaWebSocketFn: (args) => sendViaWebSocket({ ...args, _acquireWithRetryFn: async () => { acquires += 1; throw handshake404(); }, _sleepFn: async () => {}, _sendSpanTraceFn: () => {}, _agentTraceFn: () => {} }),
    _sendViaHttpSseFn: async () => { httpCalls += 1; return { content: 'http-ok', toolCalls: [] }; },
  }));
  return { result, acquires, httpCalls, catalogRefreshes };
}));
await rec.run('application-404-stays-model-error', `${SRC}:247`, { wsError: { message: 'model_not_found', httpStatus: 404 } }, () => withEnv(async () => {
  const provider = oauthProvider();
  let wsCalls = 0;
  let httpCalls = 0;
  let catalogRefreshes = 0;
  provider._refreshModelCache = async () => { catalogRefreshes += 1; };
  const out = await attempt(provider.send([], 'gpt-5.6-sol', [], {
    sessionId: 'oauth-application-404', _prebuiltBody: prebuiltBody,
    _sendViaWebSocketFn: async () => { wsCalls += 1; throw Object.assign(new Error('model_not_found'), { httpStatus: 404 }); },
    _sendViaHttpSseFn: async () => { httpCalls += 1; return { content: 'must-not-fallback', toolCalls: [] }; },
  }));
  return { ...out, wsCalls, httpCalls, catalogRefreshes };
}));
await rec.finish();
