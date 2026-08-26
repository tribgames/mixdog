import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseModelRef,
  preferredModelEffort,
  preferredModelParameters,
  routeOption,
} from './model-route-utils.ts';

test('model route refs preserve effort, fast mode, and parameters', () => {
  assert.deepEqual(parseModelRef('openai/gpt-5@high+fast?temperature=1&style=brief'), {
    route: 'openai/gpt-5',
    effort: 'high',
    fast: true,
    modelParameters: { temperature: '1', style: 'brief' },
  });
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
      { id: 'style', label: 'Style', options: [
        { value: 'brief', label: 'Brief' },
        { value: 'detailed', label: 'Detailed' },
      ] },
      { id: 'temperature', label: 'Temperature', options: [
        { value: '1', label: '1' },
      ] },
    ],
  };
  assert.deepEqual(preferredModelParameters(model, { style: 'detailed' }), {
    style: 'detailed',
    temperature: '1',
  });
});

test('route options normalize capability records', () => {
  assert.deepEqual(routeOption({
    provider: 'openai',
    id: 'gpt-5',
    name: 'GPT-5',
    effortOptions: [{ value: 'high', label: 'High' }],
    fastCapable: true,
    savedFast: true,
  }), {
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
  });
});
