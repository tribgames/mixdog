import assert from 'node:assert/strict';
import test from 'node:test';

import { parseModelRef, preferredModelEffort, preferredModelParameters, routeOption } from './model-route-utils.ts';

test('model route refs preserve effort, fast mode, and parameters', () => {
  assert.deepEqual(parseModelRef('openai/gpt-5@high+fast?temperature=1&style=brief'), {
    route: 'openai/gpt-5',
    effort: 'high',
    fast: true,
    effortAuto: undefined,
    modelParameters: { temperature: '1', style: 'brief' },
  });
  assert.equal(parseModelRef('openai/gpt-5@high+fast+noauto?style=brief').effortAuto, false);
  assert.equal(routeOption({ id: 'gpt-5', provider: 'openai', savedEffortAuto: false }).savedEffortAuto, false);
  assert.equal('savedEffortAuto' in routeOption({ id: 'gpt-5', provider: 'openai' }), false);
});

test('preferred model effort follows saved, default, priority, then catalog order', () => {
  const model = (overrides = {}) => ({
    provider: 'openai',
    model: 'gpt-5',
    display: 'GPT-5',
    effortOptions: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ],
    fastCapable: false,
    ...overrides,
  });
  assert.equal(preferredModelEffort(model({ savedEffort: 'low', defaultEffort: 'high' })), 'low');
  assert.equal(preferredModelEffort(model({ defaultEffort: 'low' })), 'low');
  assert.equal(preferredModelEffort(model()), 'high');
  assert.equal(preferredModelEffort(undefined), undefined);
});

test('model parameters keep valid current values and fill catalog defaults', () => {
  const model = {
    provider: 'openai',
    model: 'gpt-5',
    display: 'GPT-5',
    effortOptions: [],
    fastCapable: false,
    defaultModelParameters: { style: 'brief' },
    modelParameterOptions: [
      {
        id: 'style',
        label: 'Style',
        options: [
          { value: 'brief', label: 'Brief' },
          { value: 'detailed', label: 'Detailed' },
        ],
      },
      { id: 'temperature', label: 'Temperature', options: [{ value: '1', label: '1' }] },
    ],
  };
  assert.deepEqual(preferredModelParameters(model, { style: 'detailed' }), {
    style: 'detailed',
    temperature: '1',
  });
});

test('route options normalize capability records', () => {
  assert.deepEqual(
    routeOption({
      provider: 'openai',
      id: 'gpt-5',
      name: 'GPT-5',
      effortOptions: [{ value: 'high', label: 'High' }],
      fastCapable: true,
      savedFast: true,
    }),
    {
      provider: 'openai',
      model: 'gpt-5',
      display: 'GPT-5',
      effortOptions: [{ value: 'high', label: 'High' }],
      fastCapable: true,
      fastPreferred: true,
      savedFast: true,
      modelParameterOptions: [],
      parameterVariants: [],
      defaultModelParameters: {},
      savedModelParameters: {},
    }
  );
});

test('routeOption preserves ACP runner, agent, and notApplicable fields for web-search rows', () => {
  const acp = routeOption({
    provider: 'acp-antigravity',
    id: 'gemini-3.8-flash',
    name: 'Antigravity · Gemini 3.8 Flash',
    display: 'Antigravity · Gemini 3.8 Flash',
    runner: 'acp',
    agent: 'antigravity',
    notApplicable: ['autoEffort', 'fast', 'fallbacks'],
    effortOptions: [{ value: 'high', label: 'High' }],
    defaultEffort: 'high',
    supportsWebSearch: true,
    webSearchCapable: true,
  });
  assert.equal(acp.runner, 'acp');
  assert.equal(acp.agent, 'antigravity');
  assert.deepEqual(acp.notApplicable, ['autoEffort', 'fast', 'fallbacks']);
  assert.equal(acp.provider, 'acp-antigravity');
  assert.equal(acp.model, 'gemini-3.8-flash');

  const hosted = routeOption({ provider: 'openai', id: 'gpt-5', name: 'GPT-5' });
  assert.equal('runner' in hosted, false);
  assert.equal('agent' in hosted, false);
  assert.equal('notApplicable' in hosted, false);
});
