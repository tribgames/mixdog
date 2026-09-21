import assert from 'node:assert/strict';
import test from 'node:test';
import { makeResolveRoute } from './config-helpers.mjs';

const resolveRoute = makeResolveRoute(() => 'fallback');

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
