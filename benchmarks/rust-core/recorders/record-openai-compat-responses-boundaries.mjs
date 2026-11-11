#!/usr/bin/env node
// openai-compat-responses-boundaries.test.mjs (28 tests). Recorded: the effort-update fallback boundaries (`withEffortConfigurationFallback`
// over scripted attempt functions: never replayed after output reached the caller / visible progress / unsafe flags / cancellation / opt-out,
// replayed once before output, never a third time), the provider opt-out and per-request override, and the three end-to-end replays through
// the real OpenAI SDK client (scripted fetch: HTTP 400, response.failed after the ack, visible output, cancellation).
// NOT recorded (the 8 SDK header-merge tests and the 2 header-deletion ones, :277-:492): they test the OpenAI SDK's own header merger
// (K1 gaps-providers row 37, GONE: the Rust core builds headers directly; no counterpart).
//   node benchmarks/rust-core/recorders/record-openai-compat-responses-boundaries.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-compat-responses-boundaries',
  net: false,
  entry: 'effort-configuration.mjs withEffortConfigurationFallback / effortConfigurationMode / prepareTurnEffortConfiguration, openai-compat-responses.mjs sendCompatResponses on a provider object (as the test builds it) with a scripted `client.responses.create` or the real `openai` SDK client (from the tree) whose fetch is the scripted endpoint; shared/stream-progress.mjs isVisibleStreamProgress. Not run: the SDK header-merge cases (see the header).',
  replay: 'mixdog-ai providers::openai effort_retry.rs:22 and adapter.rs:756-761 (K1: tested for the OpenAI route, not the compat/custom Responses route), custom/reasoning.rs:149: feed each row\'s `input` (callbacks fired, flags, abort, replies) and compare `result` (attempts, received callbacks in order, thrown error identity flags, capability mode before/after) and `requests` in order.',
});
const tree = rec.tree;
// The SDK of the tree under test (not the recorder checkout's copy).
const { default: OpenAI } = await rec.load('node_modules/openai/index.mjs');
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
  await rec.run(`no-replay-after-${callback}-reaches-caller`, `${SRC}:14`, { callback }, async () => {
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
const sse = (...events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
function fixture(suffix, { sdk = false, reply } = {}) {
  const requests = [];
  const row = { id: MODEL, reasoningLevels: ['low', 'medium', 'high'], customReasoning: { wireFormat: 'standard', wireValues: { high: 'H' } } };
  const completed = () => ({ type: 'response.completed', response: { id: `response-${requests.length}`, model: MODEL, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] } });
  const provider = { name: `custom-boundary-${suffix}`, config: { clientOptions: {} }, defaultHeaders: undefined, customConfig: MODE, nativePdf: false, getCachedModelInfo: () => row,
    client: { responses: { async create(body, options) { requests.push({ body: structuredClone(body), headers: options?.headers ?? null }); return (async function* () { yield completed(); })(); } } } };
  if (sdk) {
    provider.client = new OpenAI({ apiKey: 'test-only', baseURL: 'https://mixdog-test.invalid/v1', maxRetries: 0, fetch: async (_url, init) => {
      requests.push({ body: JSON.parse(init.body), headers: [...new Headers(init.headers)] });
      if (reply) return reply(requests.length, completed);
      return sse(completed());
    } });
  }
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
  const updatesBeforeOptOut = updatesOf(requests.at(-1).body).length;
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
const rejected400 = () => new Response(JSON.stringify({ error: { message: REJECTION_TEXT, type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } });
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
    const { provider, requests } = fixture(`e2e-retry-${shape}`, { sdk: true, reply: (attempt1, completed) => (attempt1 === 1 ? reject() : sse(completed())) });
    const { messages, opts } = updatedTurn(provider);
    const progress = [];
    const out = await attempt(sendCompatResponses(provider, messages, MODEL, [], { ...opts, onStreamDelta: (kind) => progress.push([requests.length, kind]) }));
    return { ...out, requests, progress, visibleBeforeReplay: progress.filter(([n, kind]) => n !== 2 && isVisibleStreamProgress(kind)), modeAfter: effortConfigurationMode(provider.name, MODEL, MODE) };
  });
}
await rec.run('visible-output-then-rejection-not-replayed', `${SRC}:432`, {}, async () => {
  const { provider, requests } = fixture('e2e-visible', { sdk: true, reply: () => sse(createdEvent, textDeltaEvent, failedEvent) });
  const { messages, opts } = updatedTurn(provider);
  const text = [];
  const out = await attempt(sendCompatResponses(provider, messages, MODEL, [], { ...opts, onTextDelta: (delta) => text.push(delta) }));
  return { ...out, requests, text, modeAfter: effortConfigurationMode(provider.name, MODEL, MODE) };
});
await rec.run('rejection-after-cancellation-not-replayed', `${SRC}:450`, {}, async () => {
  const controller = new AbortController();
  const { provider, requests } = fixture('e2e-cancelled', { sdk: true, reply: () => { controller.abort(); return rejected400(); } });
  const { messages, opts } = updatedTurn(provider);
  const out = await attempt(sendCompatResponses(provider, messages, MODEL, [], { ...opts, signal: controller.signal }));
  return { ...out, requests, modeAfter: effortConfigurationMode(provider.name, MODEL, MODE) };
});
await rec.finish();
