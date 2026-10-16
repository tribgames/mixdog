import assert from 'node:assert/strict';
import test from 'node:test';
import {
  effortConfigurationMode,
  prepareTurnEffortConfiguration,
  stepEffortConfiguration,
} from './effort-configuration.mjs';
import { sendCompatResponses } from './openai-compat-responses.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';

const LEVELS = ['low', 'medium', 'high'];

function rowFor(id, levels = LEVELS) {
  return {
    id,
    reasoningLevels: levels,
    customReasoning: { wireFormat: 'standard', wireValues: { high: 'H' }, replay: false },
  };
}

// A compat provider whose Responses client records each request (body and
// headers); `reject(n)` makes the n-th call fail before any output.
function fixture(name, model, { protocol = 'openai-responses', levels, reject, config = {} } = {}) {
  const requests = [];
  const row = rowFor(model, levels);
  const provider = Object.assign(Object.create(OpenAICompatProvider.prototype), {
    name,
    config: { preconnect: false, ...config },
    customConfig: { protocol },
    nativePdf: false,
    getCachedModelInfo: (id) => (id === model ? row : null),
    client: {
      responses: {
        create: async (params, options) => {
          requests.push({ body: structuredClone(params), headers: options?.headers });
          const error = reject?.(requests.length);
          if (error) throw error;
          return (async function* () {
            yield {
              type: 'response.completed',
              response: {
                id: `resp-${requests.length}`,
                model: params.model,
                status: 'completed',
                output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
              },
            };
          })();
        },
      },
    },
  });
  return { provider, requests };
}

const SESSION = { sessionId: 'sess-1', promptCacheKey: 'mixdog-custom-g', providerCacheKey: 'mixdog-custom-g' };

function newSession(provider, model) {
  return { provider: provider.name, model, effort: 'low', messages: [{ role: 'system', content: 'Stable.' }] };
}

function appendTurn(session, provider, effort) {
  session.effort = effort;
  const snapshot = prepareTurnEffortConfiguration(session, provider);
  session.messages.push({
    role: 'user',
    content: `Question at ${effort}`,
    ...(snapshot ? { meta: { effortConfiguration: snapshot } } : {}),
  });
  return { ...SESSION, effort, effortConfiguration: snapshot };
}

const updatesOf = (body) => body.input.filter((item) => item.type === 'configuration_update');

test('a custom Responses route on GPT-6+ takes the mid-conversation update; other routes keep theirs', () => {
  const responses = { protocol: 'openai-responses' };
  for (const model of ['gpt-6-sol', 'gpt-6.1-sol', 'openai/gpt-6.1-sol', 'vendor/openai/gpt-7', 'OpenAI/GPT-6.2-luna'])
    assert.equal(effortConfigurationMode('custom-g', model, responses), 'responses', model);
  for (const model of ['openai/gpt-5.6-sol', 'gpt-5.5', 'openai/o4-mini', 'gpt-6-sol/other'])
    assert.equal(effortConfigurationMode('custom-g', model, responses), null, model);
  assert.equal(effortConfigurationMode('custom-g', 'openai/gpt-6.1-sol', { protocol: 'openai-chat' }), null);
  assert.equal(effortConfigurationMode('custom-g', 'openai/gpt-6.1-sol'), null);
  assert.equal(effortConfigurationMode('opencode-go', 'gpt-6.1-sol', responses), null);
  for (const opts of [
    { modelParameters: { mode: 'pro' } },
    { multiAgent: true },
    { thinkingBudgetTokens: 1024 },
    { effortConfigurationEnabled: false },
  ])
    assert.equal(effortConfigurationMode('custom-g', 'openai/gpt-6.1-sol', { ...responses, ...opts }), null);
});

test('a custom route turns to the update only on the Responses wire, GPT-6+, with declared levels', () => {
  const mode = (model, options) => {
    const { provider } = fixture('custom-g', model, options);
    return prepareTurnEffortConfiguration(newSession(provider, model), provider)?.mode ?? null;
  };
  assert.equal(mode('openai/gpt-6.1-sol'), 'responses');
  assert.equal(mode('openai/gpt-6.1-sol', { protocol: 'openai-chat' }), 'custom');
  assert.equal(mode('openai/gpt-5.6-sol'), 'custom');
  assert.equal(mode('openai/gpt-6.1-sol', { levels: [] }), null);
});

for (const model of ['gpt-6-sol', 'openai/gpt-6.1-sol']) {
  test(`custom ${model} pins the top-level effort and keeps the prefix and cache key across effort changes`, async () => {
    const { provider, requests } = fixture('custom-g', model);
    const session = newSession(provider, model);
    let previous;
    let expected = 0;
    let previousEffort = 'low';
    for (const effort of ['low', 'high', 'medium', 'medium', 'low']) {
      const opts = appendTurn(session, provider, effort);
      assert.equal(opts.effortConfiguration.mode, 'responses');
      await sendCompatResponses(provider, session.messages, model, [], opts);
      const { body, headers } = requests.at(-1);
      assert.deepEqual(body.reasoning, { effort: 'low' });
      if (effort !== previousEffort) expected += 1;
      const updates = updatesOf(body);
      assert.equal(updates.length, expected);
      // Updates carry the row's wire value, placed right before the user message.
      if (expected) {
        assert.equal(updates.at(-1).reasoning.effort, effort === 'high' ? 'H' : effort);
        if (effort !== previousEffort) assert.equal(body.input.at(-2).type, 'configuration_update');
      }
      assert.equal(body.prompt_cache_key, 'sess-1');
      assert.equal(headers['session-id'], 'sess-1');
      assert.equal(headers['x-client-request-id'], 'sess-1');
      if (previous) assert.deepEqual(body.input.slice(0, previous.input.length), previous.input);
      session.messages.push({ role: 'assistant', content: `Answer at ${effort}` });
      previous = body;
      previousEffort = effort;
    }
  });
}

test('a custom `none` level is sent as an update, not dropped for the stale effort', async () => {
  const model = 'openai/gpt-6.1-sol';
  const { provider, requests } = fixture('custom-g', model, { levels: ['none', 'low', 'high'] });
  const session = newSession(provider, model);
  await sendCompatResponses(provider, session.messages, model, [], appendTurn(session, provider, 'low'));
  session.messages.push({ role: 'assistant', content: 'Answer at low' });
  const opts = appendTurn(session, provider, 'none');
  assert.equal(opts.effortConfiguration?.effort, 'none');
  await sendCompatResponses(provider, session.messages, model, [], opts);
  const { body } = requests.at(-1);
  assert.deepEqual(body.reasoning, { effort: 'low' });
  assert.deepEqual(body.input.at(-2), { type: 'configuration_update', reasoning: { effort: 'none' } });
  assert.equal(stepEffortConfiguration(opts.effortConfiguration, provider.name, model, 'none')?.effort, 'none');
});

test('a custom step effort is sent after its whole tool batch', async () => {
  const model = 'openai/gpt-6.1-sol';
  const { provider, requests } = fixture('custom-g', model);
  const session = newSession(provider, model);
  const opts = appendTurn(session, provider, 'low');
  session.messages.push(
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'c1', name: 't', arguments: {} },
        { id: 'c2', name: 't', arguments: {} },
      ],
    },
    { role: 'tool', toolCallId: 'c1', content: 'one' },
    {
      role: 'tool',
      toolCallId: 'c2',
      content: 'two',
      meta: { effortConfiguration: stepEffortConfiguration(opts.effortConfiguration, provider.name, model, 'high') },
    }
  );
  await sendCompatResponses(provider, session.messages, model, [], opts);
  const step = requests.at(-1).body;
  assert.deepEqual(step.reasoning, { effort: 'low' });
  assert.deepEqual(step.input.at(-1), { type: 'configuration_update', reasoning: { effort: 'H' } });
  assert.deepEqual(
    step.input.slice(-3, -1).map((item) => item.call_id),
    ['c1', 'c2']
  );
  // The next turn at the step's effort adds no update; a later change goes before its message.
  session.messages.push({ role: 'assistant', content: 'done' });
  await sendCompatResponses(provider, session.messages, model, [], appendTurn(session, provider, 'high'));
  const next = requests.at(-1).body;
  assert.equal(updatesOf(next).length, 1);
  assert.deepEqual(next.input.slice(0, step.input.length), step.input);
});

test('a custom model rejecting the update is replayed once with the per-request effort', async () => {
  const model = 'openai/gpt-6.2-reject';
  const rejection = Object.assign(new Error('400 Unsupported input item type: configuration_update'), { status: 400 });
  const { provider, requests } = fixture('custom-g', model, { reject: (n) => (n === 2 ? rejection : null) });
  const session = newSession(provider, model);
  await sendCompatResponses(provider, session.messages, model, [], appendTurn(session, provider, 'low'));
  session.messages.push({ role: 'assistant', content: 'a' });
  const result = await sendCompatResponses(
    provider,
    session.messages,
    model,
    [],
    appendTurn(session, provider, 'high')
  );
  assert.equal(result.content, 'ok');
  assert.equal(requests.length, 3);
  assert.equal(updatesOf(requests[1].body).length, 1);
  const retry = requests[2].body;
  assert.equal(updatesOf(retry).length, 0);
  assert.deepEqual(retry.reasoning, { effort: 'H' });
  assert.equal(retry.prompt_cache_key, 'sess-1');
  assert.equal(effortConfigurationMode('custom-g', model, { protocol: 'openai-responses' }), null);
  // Later turns use the per-request effort route.
  const session2 = newSession(provider, model);
  assert.equal(appendTurn(session2, provider, 'low').effortConfiguration.mode, 'custom');
  // Other errors pass through without a replay.
  const other = fixture('custom-g', 'openai/gpt-6.3-other', {
    reject: () => Object.assign(new Error('400 bad tool schema'), { status: 400 }),
  });
  await assert.rejects(
    sendCompatResponses(other.provider, [{ role: 'user', content: 'hi' }], 'openai/gpt-6.3-other', [], SESSION),
    /bad tool schema/
  );
  assert.equal(other.requests.length, 1);
});

test('custom session identity: stable key and headers, caller headers win, hook runs last, none without a session', async () => {
  const model = 'openai/gpt-6.1-sol';
  const messages = [{ role: 'user', content: 'hi' }];
  const { provider, requests } = fixture('custom-g', model);
  await sendCompatResponses(provider, messages, model, [], { effort: 'low' });
  const plain = requests.at(-1);
  assert.equal(Object.hasOwn(plain.body, 'prompt_cache_key'), false);
  assert.equal(plain.headers, undefined);
  assert.deepEqual(plain.body.reasoning, { effort: 'low' });

  for (const opts of [
    { promptCacheKey: 'pk' },
    { providerCacheKey: 'pk' },
    { session: { promptCacheKey: 'pk' } },
    { sessionId: 'pk' },
  ]) {
    await sendCompatResponses(provider, messages, model, [], { effort: 'high', ...opts });
    assert.equal(requests.at(-1).body.prompt_cache_key, 'pk');
    assert.deepEqual(requests.at(-1).headers, { 'session-id': 'pk', 'x-client-request-id': 'pk' });
  }
  // The session wins over the provider-scoped key, except on a one-shot role.
  await sendCompatResponses(provider, messages, model, [], { ...SESSION, promptCacheScope: 'shared' });
  assert.equal(requests.at(-1).body.prompt_cache_key, 'mixdog-custom-g');
  const long = 'x'.repeat(100);
  await sendCompatResponses(provider, messages, model, [], { sessionId: long });
  assert.match(requests.at(-1).body.prompt_cache_key, /^pc_[0-9a-f]{32}$/);
  await sendCompatResponses(provider, messages, model, [], { sessionId: long, effort: 'medium' });
  assert.equal(requests.at(-1).body.prompt_cache_key, requests.at(-2).body.prompt_cache_key);

  await sendCompatResponses(provider, messages, model, [], { ...SESSION, requestHeaders: { 'session-id': 'caller' } });
  assert.deepEqual(requests.at(-1).headers, { 'session-id': 'caller', 'x-client-request-id': 'sess-1' });
  // A gateway route that opts into prompt_cache_key sends the key, not the session headers.
  const gateway = fixture('opencode-go', model, { config: { responsesPromptCacheKey: true } });
  await sendCompatResponses(gateway.provider, messages, model, [], SESSION);
  assert.equal(gateway.requests.at(-1).body.prompt_cache_key, 'sess-1');
  assert.equal(gateway.requests.at(-1).headers, undefined);

  const hooked = fixture('custom-g', model, {
    config: {
      responsesParamsHook(params) {
        params.prompt_cache_key = 'hook';
      },
    },
  });
  await sendCompatResponses(hooked.provider, messages, model, [], SESSION);
  assert.equal(hooked.requests[0].body.prompt_cache_key, 'hook');
});

test('pre-GPT-6 custom models and built-in gateways keep the per-request request shape', async () => {
  const model = 'openai/gpt-5.6-sol';
  const { provider, requests } = fixture('custom-g', model);
  const session = newSession(provider, model);
  await sendCompatResponses(provider, session.messages, model, [], appendTurn(session, provider, 'low'));
  session.messages.push({ role: 'assistant', content: 'a' });
  await sendCompatResponses(provider, session.messages, model, [], appendTurn(session, provider, 'high'));
  assert.deepEqual(requests[0].body.reasoning, { effort: 'low' });
  assert.deepEqual(requests[1].body.reasoning, { effort: 'H' });
  assert.equal(updatesOf(requests[1].body).length, 0);

  // A built-in gateway on this transport: no projection, no cache key, no session headers.
  const gateway = fixture('opencode-go', 'gpt-6.1-sol');
  const gatewaySession = newSession(provider, 'gpt-6.1-sol');
  const first = appendTurn(gatewaySession, provider, 'low');
  gatewaySession.messages.push({ role: 'assistant', content: 'a' });
  const second = appendTurn(gatewaySession, provider, 'high');
  await sendCompatResponses(gateway.provider, gatewaySession.messages, 'gpt-6.1-sol', [], { ...first, ...second });
  const body = gateway.requests[0].body;
  assert.equal(updatesOf(body).length, 0);
  assert.equal(Object.hasOwn(body, 'prompt_cache_key'), false);
  assert.equal(gateway.requests[0].headers, undefined);
});
