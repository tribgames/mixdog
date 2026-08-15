import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { normalizedProviderModels } from '../main/desktop-support.ts';
import {
  readCachedModelCatalog,
  writeCachedModelCatalog,
} from './model-catalog-cache.ts';
import { usagePinEntries } from './SidebarUsage.tsx';
import {
  modelDisplayName,
  modelOptionDescription,
  ProviderIcon,
  providerDisplayName,
  providerDisplayRank,
} from './provider-display.tsx';
import { displayUsagePercent } from './usage-percent.ts';
import { routeSheetRows } from './route-editor-logic.ts';

test('desktop model catalog preserves complete picker metadata', () => {
  const [model] = normalizedProviderModels([{
    provider: 'grok-oauth',
    id: 'grok-4.6',
    display: 'Grok 4.6',
    contextWindow: 500_000,
    description: 'Frontier reasoning model.',
    effortOptions: [],
    defaultModelParameters: { context: '500k' },
    modelParameterOptions: [{
      id: 'context',
      label: 'Context',
      kind: 'enum',
      options: [{ value: '500k', label: '500K', contextWindow: 500_000 }],
    }],
    parameterVariants: [{ context: '500k', fast: 'false' }],
  }]);

  assert.equal(model.contextWindow, 500_000);
  assert.equal(model.description, 'Frontier reasoning model.');
  assert.deepEqual(model.defaultModelParameters, { context: '500k' });
  assert.equal(model.modelParameterOptions[0].options[0].contextWindow, 500_000);
  assert.deepEqual(model.parameterVariants, [{ context: '500k', fast: 'false' }]);
  assert.equal(modelOptionDescription(model), '500k Context · Frontier reasoning model.');
});

test('composer route sheet keeps model first and hides unused rows', () => {
  assert.deepEqual(routeSheetRows({ hasModel: false, effortCount: 3, fastVisible: true }), ['model']);
  assert.deepEqual(routeSheetRows({ hasModel: true, effortCount: 0, fastVisible: false }), ['model']);
  assert.deepEqual(routeSheetRows({ hasModel: true, effortCount: 2, fastVisible: true }), [
    'model',
    'effort',
    'speed',
  ]);
});

test('model picker uses provider descriptions without a dash placeholder', () => {
  const base = {
    provider: 'test',
    model: 'test-model',
    display: 'Test model',
    effortOptions: [],
    fastCapable: false,
    fastPreferred: false,
  };

  assert.equal(modelOptionDescription({ ...base, description: 'Provider description.' }), 'Provider description.');
  assert.equal(modelOptionDescription(base), '');
});

test('model catalog cache preserves Cursor tuning capabilities', () => {
  const values = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  };
  try {
    writeCachedModelCatalog([{
      provider: 'cursor-oauth',
      model: 'claude-opus-5',
      display: 'Opus 5',
      contextWindow: 1_000_000,
      description: 'Anthropic model.',
      supportsVision: true,
      effortOptions: [{ value: 'high', label: 'High' }],
      fastCapable: true,
      fastEfforts: ['high'],
      fastPreferred: true,
      defaultEffort: 'high',
      defaultFast: false,
      modelParameterOptions: [{
        id: 'thinking',
        label: 'Thinking',
        kind: 'boolean',
        options: [{ value: 'false', label: 'Off' }, { value: 'true', label: 'On' }],
      }, {
        id: 'context',
        label: 'Context',
        kind: 'enum',
        options: [{ value: '1m', label: '1M', contextWindow: 1_000_000 }],
      }],
      parameterVariants: [{ effort: 'high', fast: 'true', thinking: 'true', context: '1m' }],
      defaultModelParameters: { thinking: 'false', context: '1m' },
      savedModelParameters: { thinking: 'true', context: '1m' },
    }]);
    const [cached] = readCachedModelCatalog().models;
    assert.equal(cached.contextWindow, 1_000_000);
    assert.equal(cached.supportsVision, true);
    assert.deepEqual(cached.fastEfforts, ['high']);
    assert.equal(cached.defaultEffort, 'high');
    assert.equal(cached.modelParameterOptions.length, 2);
    assert.equal(cached.modelParameterOptions[1].options[0].contextWindow, 1_000_000);
    assert.deepEqual(cached.parameterVariants, [{
      effort: 'high', fast: 'true', thinking: 'true', context: '1m',
    }]);
    assert.deepEqual(cached.defaultModelParameters, { thinking: 'false', context: '1m' });
    assert.deepEqual(cached.savedModelParameters, { thinking: 'true', context: '1m' });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('Cursor and OpenCode use the canonical labels, order, and Cursor catalog names', () => {
  assert.equal(providerDisplayName('cursor-oauth'), 'Cursor OAuth');
  assert.ok(providerDisplayRank('cursor-oauth') < providerDisplayRank('opencode-go'));
  assert.equal(modelDisplayName('claude-sonnet-4', 'cursor-oauth', 'Sonnet 4'), 'Sonnet 4');
  assert.equal(modelOptionDescription({
    provider: 'cursor-oauth',
    model: 'gemini-3.7-flash',
    display: 'Gemini 3.7 Flash',
    contextWindow: 1_000_000,
    description: '**Gemini 3.7 Flash**<br />Google flash model · 1M context window',
    effortOptions: [],
    fastCapable: false,
    fastPreferred: false,
  }), '1M Context · Gemini 3.7 Flash · Google flash model');
  assert.match(renderToStaticMarkup(createElement(ProviderIcon, { provider: 'cursor-oauth' })), /data-provider-icon="cursor"/);
  assert.match(renderToStaticMarkup(createElement(ProviderIcon, { provider: 'opencode-go' })), /data-provider-icon="opencode"/);
});

test('Cursor usage never falls through to the Grok OAuth row', () => {
  const pins = usagePinEntries({
    rows: [{
      id: 'grok-oauth',
      label: 'Grok OAuth',
      group: 'oauth',
      authenticated: true,
      windows: [{ label: 'W', usedPct: 20 }],
    }, {
      id: 'cursor-oauth',
      label: 'Cursor OAuth',
      group: 'oauth',
      authenticated: true,
      windows: [{ label: 'Basic', usedPct: 0.0085 }, { label: 'API', usedPct: 0.118 }],
    }],
  });
  assert.equal(pins.find((pin) => pin.key === 'grok')?.percent, 20);
  assert.equal(pins.find((pin) => pin.key === 'cursor')?.percent, 0.0085);
  assert.equal(displayUsagePercent(pins.find((pin) => pin.key === 'cursor')?.percent), 1);
  assert.equal(displayUsagePercent(0.118), 1);
});
