import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeWebSearch } from './native-web-search.mjs';
import {
  normalizeWebSearchProviderId,
  webSearchProviderFamily,
  isDefaultWebSearchRouteConfig,
  isWebSearchCapableProvider,
} from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';

const primary = { provider: 'openai', model: 'first' };
const second = { provider: 'anthropic', model: 'second', effort: 'low' };
const third = { provider: 'gemini', model: 'third', modelParameters: { test: 'retained' } };

function searchWith(respond, selected = { ...primary, fallbacks: [second, third] }) {
  const calls = [];
  const config = { webSearchRoute: selected, providers: {} };
  const runtime = createNativeWebSearch({
    getRoute: () => primary,
    getWebSearchRoute: () => selected,
    setWebSearchRoute() {},
    getConfig: () => config,
    getSession: () => null,
    getReg: () => ({
      getProvider: (provider) => ({
        send: async (_messages, model, _tools, options) => {
          options.signal?.throwIfAborted();
          calls.push({ provider, model, effort: options.effort, parameters: options.modelParameters });
          return respond(provider, options);
        },
      }),
    }),
    ensureFullConfig: () => config,
    awaitKeychainPrewarm: async () => {},
    ensureProvidersReady: async () => {},
    ensureProviderEnabled: (value) => value,
    normalizeWebSearchProviderId,
    webSearchProviderFamily,
    isDefaultWebSearchRouteConfig,
    isWebSearchCapableProvider,
    webSearchCapableFor: () => true,
  });
  return { run: runtime.runNativeWebSearch, calls };
}

test('rejected providers advance once in configured order and preserve independent tuning', async () => {
  const { run, calls } = searchWith((provider) => {
    if (provider === 'openai') throw Object.assign(new Error('limited'), { status: 429 });
    if (provider === 'anthropic') throw Object.assign(new Error('overloaded'), { status: 503 });
    return { content: 'third succeeded', model: 'third' };
  });
  const result = await run({ query: 'test' });
  assert.deepEqual(
    calls.map((call) => call.provider),
    ['openai', 'anthropic', 'gemini']
  );
  assert.equal(calls[1].effort, 'low');
  assert.deepEqual(calls[2].parameters, third.modelParameters);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.content, 'third succeeded');
});

test('cancellation, denial, unknown outcome and partial output stop before another provider', async () => {
  for (const properties of [
    { status: 403 },
    { status: 401 },
    { status: 400 },
    {},
    { status: 429, partialContent: 'already produced' },
    { status: 503, toolCallsDispatched: 1 },
    { name: 'AbortError', status: 429 },
  ]) {
    const failure = Object.assign(new Error('stop'), properties);
    const { run, calls } = searchWith(() => {
      throw failure;
    });
    await assert.rejects(run({ query: 'test' }), (error) => error === failure);
    assert.equal(calls.length, 1);
  }
  const controller = new AbortController();
  const { run, calls } = searchWith(() => {
    controller.abort(new Error('user cancelled'));
    throw Object.assign(new Error('limited'), { status: 429 });
  });
  await assert.rejects(run({ query: 'test' }, { signal: controller.signal }));
  assert.equal(calls.length, 1);
});

test('duplicate canonical providers are rejected before any send', async () => {
  const { run, calls } = searchWith(() => ({ content: 'must not run' }), {
    ...primary,
    fallbacks: [{ provider: 'openai-api', model: 'other' }],
  });
  await assert.rejects(run({ query: 'test' }), /duplicate route provider/);
  assert.deepEqual(calls, []);
});
