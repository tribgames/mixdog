import assert from 'node:assert/strict';
import test from 'node:test';
import OpenAI from 'openai';
import { isVisibleStreamProgress } from '../../../shared/stream-progress.mjs';
import {
  effortConfigurationMode,
  prepareTurnEffortConfiguration,
  withEffortConfigurationFallback,
} from './effort-configuration.mjs';
import { sendCompatResponses } from './openai-compat-responses.mjs';

const MODEL = 'openai/gpt-6.1-sol';
const MODE = { protocol: 'openai-responses' };
const rejection = (extra = {}) =>
  Object.assign(new Error('Unsupported input item type: configuration_update'), { status: 400, ...extra });

for (const callback of ['onStreamDelta', 'onTextDelta', 'onToolCall']) {
  test(`effort update fallback never replays after ${callback} reaches the caller`, async () => {
    const provider = `custom-output-${callback}`;
    const error = rejection();
    const received = [];
    const payload = callback === 'onStreamDelta' ? 'text' : { id: 'call-1', text: 'already delivered' };
    let attempts = 0;
    await assert.rejects(
      withEffortConfigurationFallback(
        provider,
        MODEL,
        { [callback]: (value) => received.push(value) },
        async (opts) => {
          attempts += 1;
          opts[callback](payload);
          throw error;
        }
      ),
      (actual) => actual === error
    );
    assert.equal(attempts, 1);
    assert.deepEqual(received, [payload]);
    assert.equal(effortConfigurationMode(provider, MODEL, MODE), 'responses', 'do not poison the capability');
  });
}

for (const kind of ['transport', 'semantic', 'ack']) {
  test(`effort update fallback allows a pre-output rejection after ${kind} health progress`, async () => {
    const provider = `custom-health-${kind}`;
    const received = [];
    let attempts = 0;
    const result = await withEffortConfigurationFallback(
      provider,
      MODEL,
      { effort: 'high', onStreamDelta: (...args) => received.push(args) },
      async (opts) => {
        attempts += 1;
        if (attempts === 1) {
          opts.onStreamDelta(kind, { connected: true });
          throw rejection();
        }
        assert.equal(opts.effortConfigurationEnabled, false);
        assert.equal(opts.effort, 'high');
        opts.onStreamDelta('text');
        return { content: 'ok' };
      }
    );
    assert.equal(result.content, 'ok');
    assert.equal(attempts, 2);
    assert.deepEqual(received, [[kind, { connected: true }], ['text']]);
    assert.equal(effortConfigurationMode(provider, MODEL, MODE), null);
  });
}

for (const kind of ['reasoning', 'tool']) {
  test(`effort update fallback does not replay visible ${kind} progress`, async () => {
    const provider = `custom-visible-${kind}`;
    const error = rejection();
    let attempts = 0;
    await assert.rejects(
      withEffortConfigurationFallback(provider, MODEL, { onStreamDelta() {} }, async (opts) => {
        attempts += 1;
        opts.onStreamDelta(kind);
        throw error;
      }),
      (actual) => actual === error
    );
    assert.equal(attempts, 1);
    assert.equal(effortConfigurationMode(provider, MODEL, MODE), 'responses');
  });
}

for (const flag of ['liveTextEmitted', 'emittedToolCall', 'unsafeToRetry']) {
  test(`effort update fallback respects ${flag} without a caller callback`, async () => {
    const provider = `custom-flag-${flag}`;
    const error = rejection({ [flag]: true });
    let attempts = 0;
    await assert.rejects(
      withEffortConfigurationFallback(provider, MODEL, {}, async () => {
        attempts += 1;
        throw error;
      }),
      (actual) => actual === error
    );
    assert.equal(attempts, 1);
    assert.equal(effortConfigurationMode(provider, MODEL, MODE), 'responses');
  });
}

test('effort update fallback does not retry or remember a rejection after cancellation', async () => {
  const provider = 'custom-update-cancelled';
  const controller = new AbortController();
  const error = rejection();
  let attempts = 0;
  await assert.rejects(
    withEffortConfigurationFallback(provider, MODEL, { signal: controller.signal }, async () => {
      attempts += 1;
      controller.abort();
      throw error;
    }),
    (actual) => actual === error
  );
  assert.equal(attempts, 1);
  assert.equal(effortConfigurationMode(provider, MODEL, MODE), 'responses');
});

test('an explicitly disabled effort update is not retried or remembered as unsupported', async () => {
  const provider = 'custom-update-disabled';
  const error = rejection();
  let attempts = 0;
  await assert.rejects(
    withEffortConfigurationFallback(provider, MODEL, { effortConfigurationEnabled: false }, async () => {
      attempts += 1;
      throw error;
    }),
    (actual) => actual === error
  );
  assert.equal(attempts, 1);
  assert.equal(effortConfigurationMode(provider, MODEL, MODE), 'responses');
});

test('a pre-output effort update rejection still retries once with the current effort and callbacks', async () => {
  const provider = 'custom-update-safe-retry';
  const attempts = [];
  const received = [];
  const result = await withEffortConfigurationFallback(
    provider,
    MODEL,
    { effort: 'high', onTextDelta: (text) => received.push(text) },
    async (opts) => {
      attempts.push(opts);
      if (attempts.length === 1) throw rejection();
      opts.onTextDelta('ok');
      return { content: 'ok' };
    }
  );
  assert.deepEqual(result, { content: 'ok' });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].effort, 'high');
  assert.equal(attempts[1].effortConfigurationEnabled, false);
  assert.equal(attempts[1]._effortConfigurationRetry, true);
  assert.deepEqual(received, ['ok']);
  assert.equal(effortConfigurationMode(provider, MODEL, MODE), null);
});

test('a failed effort update replay is never replayed a third time', async () => {
  let attempts = 0;
  const error = rejection();
  await assert.rejects(
    withEffortConfigurationFallback('custom-update-retry-fails', MODEL, {}, async () => {
      attempts += 1;
      throw error;
    }),
    (actual) => actual === error
  );
  assert.equal(attempts, 2);
});

function fixture(suffix, { sdk = false, defaultHeaders, clientOptions = {}, reply } = {}) {
  const requests = [];
  const row = {
    id: MODEL,
    reasoningLevels: ['low', 'medium', 'high'],
    customReasoning: { wireFormat: 'standard', wireValues: { high: 'H' } },
  };
  const completed = () => ({
    type: 'response.completed',
    response: {
      id: `response-${requests.length}`,
      model: MODEL,
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
    },
  });
  const provider = {
    name: `custom-boundary-${suffix}`,
    config: { clientOptions },
    defaultHeaders,
    customConfig: MODE,
    nativePdf: false,
    getCachedModelInfo: () => row,
    client: {
      responses: {
        async create(body, options) {
          requests.push({ body: structuredClone(body), headers: options?.headers });
          return (async function* () {
            yield completed();
          })();
        },
      },
    },
  };
  if (sdk) {
    // Exercise the installed SDK's actual header merger, not new Headers(record):
    // record keys overwrite case-insensitively and null deletes defaults there.
    provider.client = new OpenAI({
      apiKey: 'test-only',
      baseURL: 'https://mixdog-test.invalid/v1',
      maxRetries: 0,
      defaultHeaders,
      ...clientOptions,
      fetch: async (_url, init) => {
        requests.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) });
        if (reply) return reply(requests.length, completed);
        return sse(completed());
      },
    });
  }
  return { provider, requests };
}

const sse = (...events) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

function appendTurn(session, provider, effort) {
  session.effort = effort;
  const snapshot = prepareTurnEffortConfiguration(session, provider);
  session.messages.push({ role: 'user', content: effort, meta: { effortConfiguration: snapshot } });
  return { effort, effortConfiguration: snapshot, sessionId: 'boundary-session' };
}

const updatesOf = (body) => body.input.filter((item) => item.type === 'configuration_update');

test('turn preparation and wire projection honor provider opt-out even with old update history', async () => {
  const { provider, requests } = fixture('provider-disabled');
  const session = { provider: provider.name, model: MODEL, messages: [] };
  for (const effort of ['low', 'high']) {
    await sendCompatResponses(provider, session.messages, MODEL, [], appendTurn(session, provider, effort));
    session.messages.push({ role: 'assistant', content: 'ok' });
  }
  assert.equal(updatesOf(requests.at(-1).body).length, 1);
  provider.config.effortConfigurationEnabled = false;
  const opts = appendTurn(session, provider, 'medium');
  assert.equal(opts.effortConfiguration.mode, 'custom');
  const before = structuredClone(session.messages);
  await sendCompatResponses(provider, session.messages, MODEL, [], opts);
  assert.deepEqual(requests.at(-1).body.reasoning, { effort: 'medium' });
  assert.deepEqual(updatesOf(requests.at(-1).body), []);
  assert.equal(requests.at(-1).body.prompt_cache_key, 'boundary-session');
  assert.deepEqual(session.messages, before, 'do not rewrite persisted effort history');
});

test('per-request effort configuration overrides the provider default in either direction', async () => {
  const { provider, requests } = fixture('request-override');
  const session = { provider: provider.name, model: MODEL, messages: [] };
  appendTurn(session, provider, 'low');
  session.messages.push({ role: 'assistant', content: 'ok' });
  const opts = appendTurn(session, provider, 'high');
  await sendCompatResponses(provider, session.messages, MODEL, [], { ...opts, effortConfigurationEnabled: false });
  assert.deepEqual(requests.at(-1).body.reasoning, { effort: 'H' });
  assert.deepEqual(updatesOf(requests.at(-1).body), []);
  provider.config.effortConfigurationEnabled = false;
  await sendCompatResponses(provider, session.messages, MODEL, [], { ...opts, effortConfigurationEnabled: true });
  assert.deepEqual(requests.at(-1).body.reasoning, { effort: 'low' });
  assert.equal(updatesOf(requests.at(-1).body).at(-1).reasoning.effort, 'H');
});

for (const format of ['record', 'Headers', 'pairs']) {
  test(`caller session headers survive the SDK merge (${format})`, async () => {
    const { provider, requests } = fixture(`headers-${format}`, { sdk: true });
    const values = { 'Session-ID': 'caller-session', 'X-Client-Request-ID': 'caller-request', 'X-Test': 'kept' };
    const requestHeaders =
      format === 'Headers' ? new Headers(values) : format === 'pairs' ? Object.entries(values) : values;
    const before = [...new Headers(requestHeaders)];
    await sendCompatResponses(provider, [{ role: 'user', content: 'hi' }], MODEL, [], {
      sessionId: 'generated',
      requestHeaders,
    });
    const wire = requests[0].headers;
    assert.equal(wire.get('session-id'), 'caller-session');
    assert.equal(wire.get('x-client-request-id'), 'caller-request');
    assert.equal(wire.get('x-test'), 'kept');
    assert.deepEqual([...new Headers(requestHeaders)], before);
    assert.equal(requests[0].body.prompt_cache_key, 'generated');
  });
}

for (const pairs of [false, true]) {
  test(`explicit header deletion survives the SDK merge (${pairs ? 'pairs' : 'record'})`, async () => {
    const { provider, requests } = fixture(`header-deletion-${pairs}`, { sdk: true });
    const values = { 'Session-ID': null, 'X-Client-Request-ID': null };
    const requestHeaders = pairs ? Object.entries(values) : values;
    await sendCompatResponses(provider, [{ role: 'user', content: 'hi' }], MODEL, [], {
      sessionId: 'generated',
      requestHeaders,
    });
    assert.equal(requests[0].headers.has('session-id'), false);
    assert.equal(requests[0].headers.has('x-client-request-id'), false);
  });
}

test('SDK default session headers are not shadowed by generated per-request values', async () => {
  const configured = fixture('default-headers', {
    sdk: true,
    defaultHeaders: { 'Session-ID': 'configured-session' },
  });
  await sendCompatResponses(configured.provider, [{ role: 'user', content: 'hi' }], MODEL, [], {
    sessionId: 'generated',
  });
  assert.equal(configured.requests[0].headers.get('session-id'), 'configured-session');
  assert.equal(configured.requests[0].headers.get('x-client-request-id'), 'generated');
  const overridden = fixture('client-options-headers', {
    sdk: true,
    defaultHeaders: { 'Session-ID': 'unused' },
    clientOptions: { defaultHeaders: new Headers({ 'X-Client-Request-ID': 'sdk-request' }) },
  });
  await sendCompatResponses(overridden.provider, [{ role: 'user', content: 'hi' }], MODEL, [], {
    sessionId: 'generated',
  });
  assert.equal(overridden.requests[0].headers.get('session-id'), 'generated');
  assert.equal(overridden.requests[0].headers.get('x-client-request-id'), 'sdk-request');
});

test('sessionless requests retain their original header input', async () => {
  const { provider, requests } = fixture('no-session');
  const requestHeaders = new Headers({ 'X-Test': 'kept' });
  await sendCompatResponses(provider, [{ role: 'user', content: 'hi' }], MODEL, [], { requestHeaders });
  assert.equal(requests[0].headers, requestHeaders);
  assert.equal(Object.hasOwn(requests[0].body, 'prompt_cache_key'), false);
});

for (const scope of ['request-record', 'request-pairs', 'provider-defaults', 'sdk-defaults']) {
  test(`undefined identity headers do not suppress generated values (${scope})`, async () => {
    const values = { 'session-id': undefined, 'X-Client-Request-ID': undefined };
    const options = { sdk: true };
    if (scope === 'provider-defaults') options.defaultHeaders = values;
    if (scope === 'sdk-defaults') options.clientOptions = { defaultHeaders: values };
    const { provider, requests } = fixture(`undefined-${scope}`, options);
    const sendOpts = { sessionId: 'generated' };
    if (scope === 'request-record') sendOpts.requestHeaders = values;
    if (scope === 'request-pairs') sendOpts.requestHeaders = Object.entries(values);
    await sendCompatResponses(provider, [{ role: 'user', content: 'hi' }], MODEL, [], sendOpts);
    assert.equal(requests[0].headers.get('session-id'), 'generated');
    assert.equal(requests[0].headers.get('x-client-request-id'), 'generated');
    assert.deepEqual(values, { 'session-id': undefined, 'X-Client-Request-ID': undefined });
  });
}

test('empty and undefined-only header arrays do not suppress generated identities', async () => {
  const { provider, requests } = fixture('empty-header-arrays', {
    sdk: true,
    defaultHeaders: { 'Session-ID': [], 'X-Client-Request-ID': [undefined] },
  });
  const requestHeaders = { 'session-id': [undefined], 'x-client-request-id': [] };
  await sendCompatResponses(provider, [{ role: 'user', content: 'hi' }], MODEL, [], {
    sessionId: 'generated',
    requestHeaders,
  });
  assert.equal(requests[0].headers.get('session-id'), 'generated');
  assert.equal(requests[0].headers.get('x-client-request-id'), 'generated');
  assert.deepEqual(requestHeaders, { 'session-id': [undefined], 'x-client-request-id': [] });
});

const REJECTION_TEXT = 'Unsupported input item type: configuration_update';
const rejected400 = () =>
  new Response(JSON.stringify({ error: { message: REJECTION_TEXT, type: 'invalid_request_error' } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
const createdEvent = { type: 'response.created', response: { id: 'r-created', model: MODEL, status: 'in_progress' } };
const failedEvent = {
  type: 'response.failed',
  response: {
    id: 'r-failed',
    model: MODEL,
    status: 'failed',
    error: { status: 400, code: 'invalid_request_error', message: REJECTION_TEXT },
  },
};
const textDeltaEvent = {
  type: 'response.output_text.delta',
  item_id: 'msg-partial',
  output_index: 0,
  content_index: 0,
  delta: 'partial',
};

// Two turns at different efforts, so the second request carries an update item.
function updatedTurn(provider) {
  const session = { provider: provider.name, model: MODEL, messages: [] };
  appendTurn(session, provider, 'low');
  session.messages.push({ role: 'assistant', content: 'ok' });
  return { messages: session.messages, opts: appendTurn(session, provider, 'high') };
}

const REJECTING_STREAMS = {
  'HTTP 400 before the stream opens': rejected400,
  'response.failed after the response.created ack': () => sse(createdEvent, failedEvent),
};
for (const [shape, reject] of Object.entries(REJECTING_STREAMS)) {
  test(`an effort update rejection replays once through the Responses stream (${shape})`, async () => {
    const { provider, requests } = fixture(`e2e-retry-${shape.split(' ')[0]}`, {
      sdk: true,
      reply: (attempt, completed) => (attempt === 1 ? reject() : sse(completed())),
    });
    const { messages, opts } = updatedTurn(provider);
    const progress = [];
    const result = await sendCompatResponses(provider, messages, MODEL, [], {
      ...opts,
      onStreamDelta: (kind) => progress.push([requests.length, kind]),
    });
    assert.equal(result.content, 'ok');
    assert.equal(requests.length, 2);
    assert.equal(updatesOf(requests[0].body).length, 1, 'the first request carried the update');
    assert.deepEqual(updatesOf(requests[1].body), [], 'the replay drops it');
    assert.deepEqual(requests[1].body.reasoning, { effort: 'H' }, 'the replay keeps the current effort');
    assert.equal(requests[1].body.prompt_cache_key, 'boundary-session');
    assert.ok(
      progress.every(([attempt, kind]) => attempt === 2 || !isVisibleStreamProgress(kind)),
      'no visible output before the replay'
    );
    assert.equal(effortConfigurationMode(provider.name, MODEL, MODE), null);
  });
}

test('a Responses stream that rejects the effort update after visible output is not replayed', async () => {
  const { provider, requests } = fixture('e2e-visible', {
    sdk: true,
    reply: () => sse(createdEvent, textDeltaEvent, failedEvent),
  });
  const { messages, opts } = updatedTurn(provider);
  const text = [];
  await assert.rejects(
    sendCompatResponses(provider, messages, MODEL, [], { ...opts, onTextDelta: (delta) => text.push(delta) }),
    (error) => error.message.includes(REJECTION_TEXT)
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(text, ['partial']);
  assert.equal(effortConfigurationMode(provider.name, MODEL, MODE), 'responses');
});

test('a Responses effort update rejection after cancellation is not replayed', async () => {
  const controller = new AbortController();
  const { provider, requests } = fixture('e2e-cancelled', {
    sdk: true,
    reply: () => {
      controller.abort();
      return rejected400();
    },
  });
  const { messages, opts } = updatedTurn(provider);
  await assert.rejects(sendCompatResponses(provider, messages, MODEL, [], { ...opts, signal: controller.signal }));
  assert.equal(requests.length, 1);
  assert.equal(effortConfigurationMode(provider.name, MODEL, MODE), 'responses');
});

const AUTH_SESSION_HEADERS = {
  record: { 'Session-ID': 'caller-session', 'X-Client-Request-ID': null },
  pairs: [
    ['Session-ID', 'caller-session'],
    ['X-Client-Request-ID', null],
  ],
  Headers: new Headers({ 'Session-ID': 'caller-session' }),
};
for (const [format, requestHeaders] of Object.entries(AUTH_SESSION_HEADERS)) {
  test(`session header override and deletion keep the SDK auth headers (${format})`, async () => {
    const { provider, requests } = fixture(`auth-${format}`, {
      sdk: true,
      defaultHeaders: { 'api-key': 'gateway-key' },
    });
    await sendCompatResponses(provider, [{ role: 'user', content: 'hi' }], MODEL, [], {
      sessionId: 'generated',
      requestHeaders,
    });
    const wire = requests[0].headers;
    assert.equal(wire.get('authorization'), 'Bearer test-only', 'exactly the SDK credential');
    assert.equal(wire.get('api-key'), 'gateway-key');
    assert.equal(wire.get('session-id'), 'caller-session');
    if (format === 'Headers') assert.equal(wire.get('x-client-request-id'), 'generated');
    else assert.equal(wire.has('x-client-request-id'), false);
  });
}

test('session header merging neither synthesizes nor drops Authorization', async () => {
  const plain = fixture('auth-not-synthesized');
  await sendCompatResponses(plain.provider, [{ role: 'user', content: 'hi' }], MODEL, [], {
    sessionId: 'generated',
    requestHeaders: { 'Session-ID': null },
  });
  const names = Object.keys(plain.requests[0].headers).map((name) => name.toLowerCase());
  assert.equal(names.includes('authorization'), false, 'the SDK alone owns the credential');
  const sdk = fixture('auth-caller-override', { sdk: true });
  await sendCompatResponses(sdk.provider, [{ role: 'user', content: 'hi' }], MODEL, [], {
    sessionId: 'generated',
    requestHeaders: { Authorization: 'Bearer caller', 'Session-ID': null },
  });
  const wire = sdk.requests[0].headers;
  assert.equal(wire.get('authorization'), 'Bearer caller');
  assert.equal(wire.has('session-id'), false);
  assert.equal(wire.get('x-client-request-id'), 'generated');
});
