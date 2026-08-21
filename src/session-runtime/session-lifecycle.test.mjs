import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeResolveRoute } from './config-helpers.mjs';
import { resolveRouteContextState, resolveRouteEffortState } from './session-lifecycle.mjs';
import { inheritanceContextFit } from './lifecycle-api.mjs';

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

test('context percentage uses a model default and ten-point steps', () => {
  assert.deepEqual(resolveRouteContextState({}, {
    contextWindow: 200_000,
    maxContextWindow: 1_000_000,
  }), {
    contextPercent: 20,
    contextDefaultPercent: 20,
    selectedContextWindow: 200_000,
  });
  assert.deepEqual(resolveRouteContextState({ contextPercent: 34 }, {
    contextWindow: 200_000,
    maxContextWindow: 1_000_000,
  }), {
    contextPercent: 30,
    contextDefaultPercent: 20,
    selectedContextWindow: 300_000,
  });
  assert.deepEqual(resolveRouteContextState({ contextPercent: null }, {
    contextWindow: 200_000,
    maxContextWindow: 1_000_000,
  }), {
    contextPercent: 20,
    contextDefaultPercent: 20,
    selectedContextWindow: 200_000,
  });
});

test('route config treats a cleared context percentage as model-default intent', () => {
  const resolveRoute = makeResolveRoute(() => 'cursor-oauth');
  assert.equal(resolveRoute({
    modelSettings: {
      'cursor-oauth/gpt-5.4': { contextPercent: null },
    },
  }, {
    provider: 'cursor-oauth',
    model: 'gpt-5.4',
  }).contextPercent, undefined);
});

test('session inheritance uses the selected model compaction boundary as its fit guard', () => {
  assert.deepEqual(inheritanceContextFit({
    usedTokens: 80_000,
    contextWindow: 200_000,
    compaction: {
      pressureTokens: 95_000,
      triggerTokens: 100_000,
    },
  }), {
    known: true,
    fits: true,
    used: 95_000,
    limit: 100_000,
  });
  assert.equal(inheritanceContextFit({
    compaction: {
      pressureTokens: 100_000,
      triggerTokens: 100_000,
    },
  }).fits, false);
});
