import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveRouteContextState } from './route-state.mjs';

// Default window 500k of a 1M maximum (the default ceiling).
const meta = { contextWindow: 1_000_000, maxContextWindow: 1_000_000 };
const noLookup = () => null;

test('an exact token window overrides the percent and reports its nearest stop', () => {
  assert.deepEqual(resolveRouteContextState({ contextTokens: 640_000, contextPercent: 100 }, meta, noLookup), {
    contextPercent: 60,
    contextDefaultPercent: 50,
    selectedContextWindow: 640_000,
    contextTokens: 640_000,
  });
  assert.deepEqual(resolveRouteContextState({ contextTokens: 123_456.6 }, meta, noLookup), {
    contextPercent: 10,
    contextDefaultPercent: 50,
    selectedContextWindow: 123_457,
    contextTokens: 123_457,
  });
});

test('an exact token window is clamped to 10%..100% of the largest window', () => {
  assert.deepEqual(resolveRouteContextState({ contextTokens: 5_000 }, meta, noLookup), {
    contextPercent: 10,
    contextDefaultPercent: 50,
    selectedContextWindow: 100_000,
    contextTokens: 100_000,
  });
  assert.deepEqual(resolveRouteContextState({ contextTokens: 4_000_000 }, meta, noLookup), {
    contextPercent: 100,
    contextDefaultPercent: 50,
    selectedContextWindow: 1_000_000,
    contextTokens: 1_000_000,
  });
  // 10% of an odd window rounds up.
  assert.equal(
    resolveRouteContextState({ contextTokens: 1 }, { contextWindow: 272_005 }, noLookup).selectedContextWindow,
    27_201
  );
});

test('an exact token window at the default window is the default', () => {
  const defaultState = resolveRouteContextState({}, meta, noLookup);
  assert.deepEqual(defaultState, { contextPercent: 50, contextDefaultPercent: 50, selectedContextWindow: 500_000 });
  assert.deepEqual(
    resolveRouteContextState({ contextTokens: 500_000, contextPercent: 100 }, meta, noLookup),
    defaultState
  );
});

test('without a valid token window the percent decides as before', () => {
  for (const contextTokens of [undefined, null, 0, -5, 'x']) {
    assert.deepEqual(resolveRouteContextState({ contextTokens, contextPercent: 70 }, meta, noLookup), {
      contextPercent: 70,
      contextDefaultPercent: 50,
      selectedContextWindow: 700_000,
    });
  }
});
