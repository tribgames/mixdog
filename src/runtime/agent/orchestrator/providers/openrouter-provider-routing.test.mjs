import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCompatProviderChatOptions } from './openai-compat-options.mjs';
import { openRouterProviderRouting } from './openrouter-provider-routing.mjs';
import { OpenRouterProvider } from './openrouter.mjs';

const chat = (providerName, modelParameters, extra = {}) =>
  applyCompatProviderChatOptions({ model: 'm' }, providerName, { modelParameters, ...extra }, {});

test('OpenRouter chat body carries provider.sort for each known sort', () => {
  for (const sort of ['price', 'throughput', 'latency']) {
    assert.deepEqual(chat('openrouter', { providerSort: sort }).provider, { sort });
  }
  assert.deepEqual(chat('openrouter', { providerSort: 'price' }, { effort: 'high' }).reasoning, {
    enabled: true,
    effort: 'high',
  });
});

test('Auto, unknown or missing providerSort sends no provider field', () => {
  for (const modelParameters of [{ providerSort: 'auto' }, { providerSort: 'cheapest' }, { providerSort: '' }, {}, undefined]) {
    assert.equal('provider' in chat('openrouter', modelParameters), false);
    assert.equal(openRouterProviderRouting({ modelParameters }), null);
  }
});

test('other providers never send provider.sort', () => {
  for (const name of ['xai', 'deepseek', 'opencode-go', 'openai']) {
    assert.equal('provider' in chat(name, { providerSort: 'price' }), false);
  }
});

test('OpenRouter Responses wire carries the same provider.sort', () => {
  const hook = new OpenRouterProvider({}).openai.config.responsesParamsHook;
  const run = (modelParameters) => {
    const params = { model: 'openai/gpt-5' };
    hook(params, { opts: { modelParameters } });
    return params;
  };
  assert.deepEqual(run({ providerSort: 'latency' }).provider, { sort: 'latency' });
  assert.equal('provider' in run({ providerSort: 'auto' }), false);
});
