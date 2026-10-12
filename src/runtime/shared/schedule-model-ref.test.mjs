import assert from 'node:assert/strict';
import test from 'node:test';
import { formatScheduleModelRef, modelRouteFields, parseScheduleModelRef } from './schedule-model-ref.mjs';

test('+noauto parses to autoEffort:false and formats back; absent means on', () => {
  for (const [ref, route] of [
    [
      'openai/gpt-5@high+fast+noauto?serviceTier=priority',
      { provider: 'openai', model: 'gpt-5', effort: 'high', fast: true, autoEffort: false, modelParameters: { serviceTier: 'priority' } },
    ],
    ['openai/gpt-5@high+noauto', { provider: 'openai', model: 'gpt-5', effort: 'high', autoEffort: false }],
    ['openai/gpt-5+noauto', { provider: 'openai', model: 'gpt-5', autoEffort: false }],
    ['openai/gpt-5@high+fast', { provider: 'openai', model: 'gpt-5', effort: 'high', fast: true }],
    ['openai/gpt-5', { provider: 'openai', model: 'gpt-5' }],
  ]) {
    assert.deepEqual(parseScheduleModelRef(ref), route, ref);
    assert.equal(formatScheduleModelRef(route), ref, ref);
  }
  assert.equal(formatScheduleModelRef({ provider: 'openai', model: 'gpt-5', autoEffort: true }), 'openai/gpt-5');
  assert.equal(parseScheduleModelRef('Main preset'), 'Main preset');
});

test('the run route fields carry only the Auto effort off state into the session', () => {
  assert.equal(modelRouteFields(parseScheduleModelRef('openai/gpt-5@high+noauto')).autoEffort, false);
  assert.equal(Object.hasOwn(modelRouteFields(parseScheduleModelRef('openai/gpt-5@high')), 'autoEffort'), false);
  assert.equal(modelRouteFields({ provider: 'p', model: 'm', autoEffort: false }).autoEffort, false);
});
