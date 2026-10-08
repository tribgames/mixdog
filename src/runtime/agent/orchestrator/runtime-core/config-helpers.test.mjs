import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLikelyRawModelId,
  makeResolveRoute,
  resolveAutoClearIdleMs,
  validateRequestedModelSelector,
} from './config-helpers.mjs';

const resolveRoute = makeResolveRoute(() => 'fallback');

test('model selectors accept rolling aliases without accepting prose or malformed IDs', () => {
  for (const model of [
    '~google/gemini-flash-latest',
    '~deepseek/deepseek-flash-latest',
    '~anthropic/claude-opus-latest',
    'google/gemini-3.8-flash',
    'openrouter/free',
    'vendor/model:free',
    'claude-sonnet-5-5',
  ]) {
    assert.equal(isLikelyRawModelId(model), true, model);
    assert.doesNotThrow(() => validateRequestedModelSelector({}, { provider: 'openrouter', model }));
  }
  for (const model of ['~', '~~google/model', '~ google/model', 'google/~model', 'Google: Gemini Flash Latest', 'model?x=1', 'x'.repeat(161)]) {
    assert.equal(isLikelyRawModelId(model), false, model);
    assert.throws(() => validateRequestedModelSelector({}, { model }), /Invalid model selector/);
  }
  assert.equal(isLikelyRawModelId(''), false);
  assert.equal(isLikelyRawModelId('   '), false);
});

test('named and default presets share explicit, saved, and preset setting precedence', () => {
  const preset = {
    id: 'main',
    name: 'Main preset',
    provider: 'demo',
    model: 'model',
    effort: 'high',
    fast: true,
    modelParameters: { context: '1m' },
    contextPercent: 80,
  };
  const config = { default: 'main', presets: [preset] };
  for (const request of [{}, { model: 'MAIN PRESET' }]) {
    assert.deepEqual(resolveRoute(config, request), {
      provider: 'demo',
      model: 'model',
      preset,
      effort: 'high',
      fast: true,
      modelParameters: { context: '1m' },
      contextPercent: 80,
    });
    const saved = {
      ...config,
      modelSettings: {
        'demo/model': { effort: 'low', fast: false, modelParameters: { context: '2m' }, contextPercent: 60 },
      },
    };
    assert.deepEqual(resolveRoute(saved, request), {
      provider: 'demo',
      model: 'model',
      preset,
      effort: 'low',
      fast: false,
      modelParameters: { context: '2m' },
      contextPercent: 60,
    });
    assert.deepEqual(
      resolveRoute(saved, { ...request, effort: 'medium', fast: true, modelParameters: {}, contextPercent: 40 }),
      {
        provider: 'demo',
        model: 'model',
        preset,
        effort: 'medium',
        fast: true,
        modelParameters: {},
        contextPercent: 40,
      }
    );
  }
});

test('raw selectors, explicit providers, and incomplete presets do not select a fallback preset', () => {
  const config = { default: 'main', presets: [{ id: 'main', provider: 'demo', model: 'model' }] };
  for (const [request, provider, model] of [
    [{ model: 'unknown' }, 'fallback', 'unknown'],
    [{ provider: 'explicit', model: 'main' }, 'explicit', 'main'],
    [{ provider: 'explicit' }, 'explicit', ''],
  ]) {
    const route = resolveRoute(config, request);
    assert.equal(route.provider, provider);
    assert.equal(route.model, model);
    assert.equal(route.preset, null);
  }
  assert.equal(resolveRoute({ default: 'main', presets: [{ id: 'main', provider: 'demo' }] }).preset, null);
});

test('provider idle window overrides the global auto-clear idleMs', () => {
  const config = { autoClear: { idleMs: 2 * 3600_000, providerIdleMs: { 'openai-oauth': 30 * 60_000 } } };
  assert.equal(resolveAutoClearIdleMs(config, 'openai-oauth'), 30 * 60_000);
  assert.equal(resolveAutoClearIdleMs(config, 'anthropic-oauth'), 2 * 3600_000);
  assert.equal(resolveAutoClearIdleMs({ autoClear: {} }, 'openai-oauth'), 30 * 60_000);
  assert.equal(resolveAutoClearIdleMs({ autoClear: { providerIdleMs: { default: 5 * 60_000 } } }, 'unknown'), 5 * 60_000);
});
