import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveRouteEffortState } from './session-lifecycle.mjs';

test('cold route metadata preserves persisted effort and enabled Fast mode', () => {
  assert.deepEqual(resolveRouteEffortState({
    provider: 'cursor-oauth',
    model: 'kimi-k3',
    effort: 'high',
    fast: true,
  }, {
    id: 'kimi-k3',
    provider: 'cursor-oauth',
  }), {
    effectiveEffort: 'high',
    fastCapable: true,
    metadataResolved: false,
  });
});

test('resolved route metadata remains authoritative for effort and Fast support', () => {
  assert.deepEqual(resolveRouteEffortState({
    provider: 'cursor-oauth',
    model: 'kimi-k3',
    effort: 'max',
    fast: true,
  }, {
    id: 'kimi-k3',
    provider: 'cursor-oauth',
    reasoningLevels: ['high'],
    fastCapable: false,
    fastEfforts: [],
  }), {
    effectiveEffort: 'high',
    fastCapable: false,
    metadataResolved: true,
  });
});

test('resolved Cursor parameter variants validate Fast for the selected effort', () => {
  assert.deepEqual(resolveRouteEffortState({
    provider: 'cursor-oauth',
    model: 'gpt-5.6-sol',
    effort: 'high',
    fast: true,
    modelParameters: { context: '272k' },
  }, {
    id: 'gpt-5.6-sol',
    provider: 'cursor-oauth',
    reasoningLevels: ['high', 'max'],
    fastCapable: true,
    fastEfforts: ['high'],
    parameterVariants: [
      { effort: 'high', fast: 'true', context: '272k' },
      { effort: 'max', fast: 'false', context: '272k' },
    ],
  }), {
    effectiveEffort: 'high',
    fastCapable: true,
    metadataResolved: true,
  });
});
