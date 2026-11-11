#!/usr/bin/env node
// openai-compat-responses-boundaries.test.mjs (28 tests). Recorded: the effort-update fallback boundaries (`withEffortConfigurationFallback`
// over scripted attempt functions: never replayed after output reached the caller / visible progress / unsafe flags / cancellation / opt-out,
// replayed once before output, never a third time), the provider opt-out and per-request override, and the three end-to-end replays through
// the real OpenAI SDK client (scripted fetch: HTTP 400, response.failed after the ack, visible output, cancellation).
// The SDK header-merge tests (:277-:492) are recorded as the request head the real OpenAI SDK sends over a socket to the loopback endpoint
// (`requests[*]`: method, path, every header in arrival order, raw body); the Rust core builds headers directly, so a replay compares the head.
//   node benchmarks/rust-core/recorders/record-openai-compat-responses-boundaries.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-compat-responses-boundaries',
  net: true,
  entry: 'effort-configuration.mjs withEffortConfigurationFallback / effortConfigurationMode / prepareTurnEffortConfiguration, openai-compat-responses.mjs sendCompatResponses on a provider object (as the test builds it) with a scripted `client.responses.create` or the real `openai` SDK client (from the tree) whose fetch is the scripted endpoint; shared/stream-progress.mjs isVisibleStreamProgress.',
  compare: 'mixdog-ai providers::openai effort_retry.rs:22 and adapter.rs:756-761 (K1: tested for the OpenAI route, not the compat/custom Responses route), custom/reasoning.rs:149: feed each row\'s `input` (callbacks fired, flags, abort, replies) and compare `result` (attempts, received callbacks in order, thrown error identity flags, capability mode before/after) and `requests` in order.',
  replay: "Rust entry (pub, on o1): mixdog_ai::providers::compat::CompatAdapter (compat/adapter.rs:63) with CompatChatCodec (compat/chat/mod.rs:96) / CompatResponsesCodec (compat/responses.rs:75), body builder build_body (compat/chat/encode.rs:372), driven through mixdog_ai::broker ModelBroker::send (mixdog-ai/src/broker/send.rs:75) and ProviderAdapter::attempt (mixdog-core-api/src/domain/provider.rs:1079). The effort-update retry is mixdog_ai::providers::openai effort_retry (no pub item located for the compat route): work for the Rust side.",
});
// The declared header rule of lib/provider-case-recorder.mjs (the three SDK headers that carry the recording host are written as `<recording host <header name>>`) applies to every copy of a request the
// manifest names, including the request records a case result holds: the record is normalised when the endpoint receives it, whatever the case does with it afterwards.
{
  let scripted = null;
  Object.defineProperty(rec.net, 'reply', {
    configurable: true,
    get: () => scripted,
    set: (fn) => {
      scripted = fn && ((record, n) => {
        for (const pair of record.headers) if (/^x-stainless-(os|arch|runtime-version)$/i.test(pair[0])) pair[1] = `<recording host ${pair[0].toLowerCase()}>`;
        return fn(record, n);
      });
    },
  });
}
const tree = rec.tree;
// The SDK of the tree under test (not the recorder checkout's copy).
const { default: OpenAI } = await rec.load('node_modules/openai/index.mjs');
// The client as the product received it: the arguments it was constructed with are described once, raw (the wrapper above has already encoded them, and the encoded form would be encoded again).
const sdkClient = (options) => rec.describe(new OpenAI(options), { $instance: 'node_modules/openai/index.mjs.default', constructedWith: [options] });
const P = 'agent/orchestrator/providers/';
const { isVisibleStreamProgress } = await rec.P('shared/stream-progress.mjs');
const { effortConfigurationMode, prepareTurnEffortConfiguration, withEffortConfigurationFallback } = await rec.P(`${P}effort-configuration.mjs`);
const { sendCompatResponses } = await rec.P(`${P}openai-compat-responses.mjs`);
const SRC = 'src/runtime/agent/orchestrator/providers/openai-compat-responses-boundaries.test.mjs';
const MODEL = 'openai/gpt-6.1-sol';
const MODE = { protocol: 'openai-responses' };
const rejection = (extra = {}) => Object.assign(new Error('Unsupported input item type: configuration_update'), { status: 400, ...extra });
const attempt = async (promise) => {
  try {
    return { result: await promise };
  } catch (error) {
    return { error };
  }
};
const fb = (provider, opts, fn) => withEffortConfigurationFallback(provider, MODEL, opts, fn);
const mode = (provider) => effortConfigurationMode(provider, MODEL, MODE);

for (const callback of ['onStreamDelta', 'onTextDelta', 'onToolCall']) {
  await rec.run(`no-replay-after-${callback}-reaches-caller`, `${SRC}:18`, { callback }, async () => {
    const provider = `custom-output-${callback}`;
    const error = rejection();
    const received = [];
    const payload = callback === 'onStreamDelta' ? 'text' : { id: 'call-1', text: 'already delivered' };
    let attempts = 0;
    const out = await attempt(fb(provider, { [callback]: (value) => received.push(value) }, async (opts) => { attempts += 1; opts[callback](payload); throw error; }));
    return { ...out, errorIsTheOriginal: out.error === error, attempts, received, modeAfter: mode(provider) };
  });
}
for (const kind of ['transport', 'semantic', 'ack']) {
  await rec.run(`pre-output-rejection-after-${kind}-progress-replays`, `${SRC}:46`, { kind }, async () => {
    const provider = `custom-health-${kind}`;
    const received = [];
    let attempts = 0;
    const seenOpts = [];
    const out = await attempt(fb(provider, { effort: 'high', onStreamDelta: (...args) => received.push(args) }, async (opts) => {
      attempts += 1;
      if (attempts === 1) { opts.onStreamDelta(kind, { connected: true }); throw rejection(); }
      seenOpts.push({ effortConfigurationEnabled: opts.effortConfigurationEnabled, effort: opts.effort });
      opts.onStreamDelta('text');
      return { content: 'ok' };
    }));
    return { ...out, attempts, received, retryOpts: seenOpts, modeAfter: mode(provider) };
  });
}
for (const kind of ['reasoning', 'tool']) {
  await rec.run(`no-replay-after-visible-${kind}-progress`, `${SRC}:73`, { kind }, async () => {
    const provider = `custom-visible-${kind}`;
    const error = rejection();
    let attempts = 0;
    const out = await attempt(fb(provider, { onStreamDelta() {} }, async (opts) => { attempts += 1; opts.onStreamDelta(kind); throw error; }));
    return { ...out, errorIsTheOriginal: out.error === error, attempts, modeAfter: mode(provider), visible: isVisibleStreamProgress(kind) };
  });
}
for (const flag of ['liveTextEmitted', 'emittedToolCall', 'unsafeToRetry']) {
  await rec.run(`respects-${flag}-without-caller-callback`, `${SRC}:91`, { flag }, async () => {
    const provider = `custom-flag-${flag}`;
    const error = rejection({ [flag]: true });
    let attempts = 0;
    const out = await attempt(fb(provider, {}, async () => { attempts += 1; throw error; }));
    return { ...out, errorIsTheOriginal: out.error === error, attempts, modeAfter: mode(provider) };
  });
}
await rec.run('no-retry-or-memory-after-cancellation', `${SRC}:107`, {}, async () => {
  const provider = 'custom-update-cancelled';
  const controller = new AbortController();
  const error = rejection();
  let attempts = 0;
  const out = await attempt(fb(provider, { signal: controller.signal }, async () => { attempts += 1; controller.abort(); throw error; }));
  return { ...out, errorIsTheOriginal: out.error === error, attempts, modeAfter: mode(provider) };
});
await rec.run('explicitly-disabled-update-not-retried-or-remembered', `${SRC}:124`, {}, async () => {
  const provider = 'custom-update-disabled';
  const error = rejection();
  let attempts = 0;
  const out = await attempt(fb(provider, { effortConfigurationEnabled: false }, async () => { attempts += 1; throw error; }));
  return { ...out, errorIsTheOriginal: out.error === error, attempts, modeAfter: mode(provider) };
});
await rec.run('pre-output-rejection-retries-once-with-current-effort', `${SRC}:140`, {}, async () => {
  const provider = 'custom-update-safe-retry';
  const attempts = [];
  const received = [];
  const out = await attempt(fb(provider, { effort: 'high', onTextDelta: (text) => received.push(text) }, async (opts) => {
    attempts.push({ effort: opts.effort, effortConfigurationEnabled: opts.effortConfigurationEnabled, retryFlag: opts._effortConfigurationRetry });
    if (attempts.length === 1) throw rejection();
    opts.onTextDelta('ok');
    return { content: 'ok' };
  }));
  return { ...out, attempts, received, modeAfter: mode(provider) };
});
await rec.run('failed-replay-never-replayed-third-time', `${SRC}:162`, {}, async () => {
  let attempts = 0;
  const error = rejection();
  const out = await attempt(fb('custom-update-retry-fails', {}, async () => { attempts += 1; throw error; }));
  return { ...out, errorIsTheOriginal: out.error === error, attempts };
});

// ---- the provider object of the test (stub client or the real SDK client over a scripted fetch) ----
// The endpoint's answers are descriptors served by the loopback endpoint (every frame its own socket write); the provider's client is the real OpenAI SDK client
// (global fetch, redirected to the loopback endpoint by the recorder), so the request recorded is the head and body bytes that arrived at the socket.
const sse = (...events) => ({ status: 200, contentType: 'text/event-stream', chunks: events.map((event) => `data: ${JSON.stringify(event)}\n\n`) });
function fixture(suffix, { reply } = {}) {
  const requests = [];
  const row = { id: MODEL, reasoningLevels: ['low', 'medium', 'high'], customReasoning: { wireFormat: 'standard', wireValues: { high: 'H' } } };
  const completed = () => ({ type: 'response.completed', response: { id: `response-${requests.length}`, model: MODEL, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] } });
  rec.net.reply = (request) => {
    requests.push(request);
    return reply ? reply(requests.length, completed) : sse(completed());
  };
  const provider = { name: `custom-boundary-${suffix}`, config: { clientOptions: {} }, defaultHeaders: undefined, customConfig: MODE, nativePdf: false, getCachedModelInfo: () => row,
    client: sdkClient({ apiKey: 'test-only', baseURL: 'https://mixdog-test.invalid/v1', maxRetries: 0 }) };
  return { provider, requests };
}
function appendTurn(session, provider, effort) {
  session.effort = effort;
  const snapshot = prepareTurnEffortConfiguration(session, provider);
  session.messages.push({ role: 'user', content: effort, meta: { effortConfiguration: snapshot } });
  return { effort, effortConfiguration: snapshot, sessionId: 'boundary-session' };
}
const updatesOf = (body) => body.input.filter((item) => item.type === 'configuration_update');

await rec.run('provider-opt-out-with-old-update-history', `${SRC}:242`, {}, async () => {
  const { provider, requests } = fixture('provider-disabled');
  const session = { provider: provider.name, model: MODEL, messages: [] };
  for (const effort of ['low', 'high']) {
    await sendCompatResponses(provider, session.messages, MODEL, [], appendTurn(session, provider, effort));
    session.messages.push({ role: 'assistant', content: 'ok' });
  }
  const updatesBeforeOptOut = updatesOf(JSON.parse(requests.at(-1).body)).length;
  provider.config.effortConfigurationEnabled = false;
  const opts = appendTurn(session, provider, 'medium');
  const before = structuredClone(session.messages);
  await sendCompatResponses(provider, session.messages, MODEL, [], opts);
  return { updatesBeforeOptOut, modeAfterOptOut: opts.effortConfiguration.mode, request: requests.at(-1), messagesUnchanged: JSON.stringify(session.messages.slice(0, before.length)) === JSON.stringify(before), requests };
});
await rec.run('per-request-override-either-direction', `${SRC}:261`, {}, async () => {
  const { provider, requests } = fixture('request-override');
  const session = { provider: provider.name, model: MODEL, messages: [] };
  appendTurn(session, provider, 'low');
  session.messages.push({ role: 'assistant', content: 'ok' });
  const opts = appendTurn(session, provider, 'high');
  await sendCompatResponses(provider, session.messages, MODEL, [], { ...opts, effortConfigurationEnabled: false });
  const first = requests.at(-1);
  provider.config.effortConfigurationEnabled = false;
  await sendCompatResponses(provider, session.messages, MODEL, [], { ...opts, effortConfigurationEnabled: true });
  return { first, second: requests.at(-1) };
});

const REJECTION_TEXT = 'Unsupported input item type: configuration_update';
const rejected400 = () => ({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { message: REJECTION_TEXT, type: 'invalid_request_error' } }) });
const createdEvent = { type: 'response.created', response: { id: 'r-created', model: MODEL, status: 'in_progress' } };
const failedEvent = { type: 'response.failed', response: { id: 'r-failed', model: MODEL, status: 'failed', error: { status: 400, code: 'invalid_request_error', message: REJECTION_TEXT } } };
const textDeltaEvent = { type: 'response.output_text.delta', item_id: 'msg-partial', output_index: 0, content_index: 0, delta: 'partial' };
function updatedTurn(provider) {
  const session = { provider: provider.name, model: MODEL, messages: [] };
  appendTurn(session, provider, 'low');
  session.messages.push({ role: 'assistant', content: 'ok' });
  return { messages: session.messages, opts: appendTurn(session, provider, 'high') };
}
for (const [shape, reject] of [['http-400-before-stream-opens', rejected400], ['response-failed-after-created-ack', () => sse(createdEvent, failedEvent)]]) {
  await rec.run(`update-rejection-replays-once-through-stream:${shape}`, `${SRC}:409`, { shape }, async () => {
    const { provider, requests } = fixture(`e2e-retry-${shape}`, { reply: (attempt1, completed) => (attempt1 === 1 ? reject() : sse(completed())) });
    const { messages, opts } = updatedTurn(provider);
    const progress = [];
    const out = await attempt(sendCompatResponses(provider, messages, MODEL, [], { ...opts, onStreamDelta: (kind) => progress.push([requests.length, kind]) }));
    return { ...out, requests, progress, visibleBeforeReplay: progress.filter(([n, kind]) => n !== 2 && isVisibleStreamProgress(kind)), modeAfter: effortConfigurationMode(provider.name, MODEL, MODE) };
  });
}
await rec.run('visible-output-then-rejection-not-replayed', `${SRC}:434`, {}, async () => {
  const { provider, requests } = fixture('e2e-visible', { reply: () => sse(createdEvent, textDeltaEvent, failedEvent) });
  const { messages, opts } = updatedTurn(provider);
  const text = [];
  const out = await attempt(sendCompatResponses(provider, messages, MODEL, [], { ...opts, onTextDelta: (delta) => text.push(delta) }));
  return { ...out, requests, text, modeAfter: effortConfigurationMode(provider.name, MODEL, MODE) };
});
await rec.run('rejection-after-cancellation-not-replayed', `${SRC}:450`, {}, async () => {
  const controller = new AbortController();
  const { provider, requests } = fixture('e2e-cancelled', { reply: () => { controller.abort(); return rejected400(); } });
  const { messages, opts } = updatedTurn(provider);
  const out = await attempt(sendCompatResponses(provider, messages, MODEL, [], { ...opts, signal: controller.signal }));
  return { ...out, requests, modeAfter: effortConfigurationMode(provider.name, MODEL, MODE) };
});
// ---- SDK header merge, captured at the socket ----
const ROW = { id: MODEL, reasoningLevels: ['low', 'medium', 'high'], customReasoning: { wireFormat: 'standard', wireValues: { high: 'H' } } };
const completedEvent = { type: 'response.completed', response: { id: 'response-1', model: MODEL, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] } };
const wireFixture = (suffix, { defaultHeaders, clientOptions = {} } = {}) => ({
  name: `custom-boundary-${suffix}`,
  config: { clientOptions },
  defaultHeaders,
  customConfig: MODE,
  nativePdf: false,
  getCachedModelInfo: () => ROW,
  client: sdkClient({ apiKey: 'test-only', baseURL: 'https://mixdog-test.invalid/v1', maxRetries: 0, defaultHeaders, ...clientOptions }),
});
const answerOk = (net) => { net.reply = () => ({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(completedEvent)}\n\n` }); };
const hi = [{ role: 'user', content: 'hi' }];
const headerCase = (id, line, input, fn) => rec.run(id, `${SRC}:${line}`, input, async ({ net }) => { answerOk(net); return fn(); });

for (const format of ['record', 'Headers', 'pairs']) {
  const values = { 'Session-ID': 'caller-session', 'X-Client-Request-ID': 'caller-request', 'X-Test': 'kept' };
  const make = () => (format === 'Headers' ? new Headers(values) : format === 'pairs' ? Object.entries(values) : values);
  await headerCase(`sdk-merge-caller-session-headers-survive:${format}`, 277, { format, requestHeaders: make(), sessionId: 'generated' }, async () => {
    const provider = wireFixture(`headers-${format}`);
    const requestHeaders = make();
    const before = [...new Headers(requestHeaders)];
    const result = await sendCompatResponses(provider, hi, MODEL, [], { sessionId: 'generated', requestHeaders });
    return { result, callerHeadersBefore: before, callerHeadersAfter: [...new Headers(requestHeaders)] };
  });
}
for (const pairs of [false, true]) {
  const values = { 'Session-ID': null, 'X-Client-Request-ID': null };
  await headerCase(`sdk-merge-explicit-header-deletion:${pairs ? 'pairs' : 'record'}`, 297, { requestHeaders: pairs ? Object.entries(values) : values, sessionId: 'generated' }, async () => ({ result: await sendCompatResponses(wireFixture(`header-deletion-${pairs}`), hi, MODEL, [], { sessionId: 'generated', requestHeaders: pairs ? Object.entries(values) : values }) }));
}
await headerCase('sdk-default-session-headers-not-shadowed-by-generated', 310, { configured: { defaultHeaders: { 'Session-ID': 'configured-session' } }, overridden: { defaultHeaders: { 'Session-ID': 'unused' }, clientOptions: { defaultHeaders: new Headers({ 'X-Client-Request-ID': 'sdk-request' }) } }, sessionId: 'generated' }, async () => {
  const first = await sendCompatResponses(wireFixture('default-headers', { defaultHeaders: { 'Session-ID': 'configured-session' } }), hi, MODEL, [], { sessionId: 'generated' });
  const second = await sendCompatResponses(wireFixture('client-options-headers', { defaultHeaders: { 'Session-ID': 'unused' }, clientOptions: { defaultHeaders: new Headers({ 'X-Client-Request-ID': 'sdk-request' }) } }), hi, MODEL, [], { sessionId: 'generated' });
  return { first, second };
});
// The Node test also asserts that the headers option handed to `create` is the caller's own Headers object (JS identity, not observable on the wire: the one omission
// of this case); the head that arrives with the caller's header and no synthesized session header is recorded.
await headerCase('sessionless-requests-retain-original-header-input', 332, { requestHeaders: new Headers({ 'X-Test': 'kept' }) }, async () => {
  const requestHeaders = new Headers({ 'X-Test': 'kept' });
  return { result: await sendCompatResponses(wireFixture('no-session'), hi, MODEL, [], { requestHeaders }) };
});
for (const scope of ['request-record', 'request-pairs', 'provider-defaults', 'sdk-defaults']) {
  const values = () => ({ 'session-id': undefined, 'X-Client-Request-ID': undefined });
  await headerCase(`sdk-merge-undefined-identity-headers-do-not-suppress-generated:${scope}`, 341, { scope, values: values() }, async () => {
    const options = {};
    if (scope === 'provider-defaults') options.defaultHeaders = values();
    if (scope === 'sdk-defaults') options.clientOptions = { defaultHeaders: values() };
    const sendOpts = { sessionId: 'generated' };
    const callerValues = values();
    if (scope === 'request-record') sendOpts.requestHeaders = callerValues;
    if (scope === 'request-pairs') sendOpts.requestHeaders = Object.entries(callerValues);
    const result = await sendCompatResponses(wireFixture(`undefined-${scope}`, options), hi, MODEL, [], sendOpts);
    return { result, callerValuesAfter: callerValues };
  });
}
await headerCase('sdk-merge-empty-and-undefined-only-header-arrays', 357, { defaultHeaders: { 'Session-ID': [], 'X-Client-Request-ID': [undefined] }, requestHeaders: { 'session-id': [undefined], 'x-client-request-id': [] }, sessionId: 'generated' }, async () => {
  const requestHeaders = { 'session-id': [undefined], 'x-client-request-id': [] };
  const result = await sendCompatResponses(wireFixture('empty-header-arrays', { defaultHeaders: { 'Session-ID': [], 'X-Client-Request-ID': [undefined] } }), hi, MODEL, [], { sessionId: 'generated', requestHeaders });
  return { result, callerHeadersAfter: requestHeaders };
});
const AUTH_SESSION_HEADERS = () => ({ record: { 'Session-ID': 'caller-session', 'X-Client-Request-ID': null }, pairs: [['Session-ID', 'caller-session'], ['X-Client-Request-ID', null]], Headers: new Headers({ 'Session-ID': 'caller-session' }) });
for (const format of ['record', 'pairs', 'Headers']) {
  await headerCase(`sdk-merge-session-override-and-deletion-keep-auth-headers:${format}`, 474, { format, defaultHeaders: { 'api-key': 'gateway-key' }, requestHeaders: AUTH_SESSION_HEADERS()[format], sessionId: 'generated' }, async () => ({ result: await sendCompatResponses(wireFixture(`auth-${format}`, { defaultHeaders: { 'api-key': 'gateway-key' } }), hi, MODEL, [], { sessionId: 'generated', requestHeaders: AUTH_SESSION_HEADERS()[format] }) }));
}
await headerCase('session-header-merging-neither-synthesizes-nor-drops-authorization', 492, { requests: [{ requestHeaders: { 'Session-ID': null } }, { requestHeaders: { Authorization: 'Bearer caller', 'Session-ID': null } }], sessionId: 'generated' }, async () => {
  const plain = await sendCompatResponses(wireFixture('auth-not-synthesized'), hi, MODEL, [], { sessionId: 'generated', requestHeaders: { 'Session-ID': null } });
  const sdkResult = await sendCompatResponses(wireFixture('auth-caller-override'), hi, MODEL, [], { sessionId: 'generated', requestHeaders: { Authorization: 'Bearer caller', 'Session-ID': null } });
  return { plain, sdkResult };
});
await rec.finish();
