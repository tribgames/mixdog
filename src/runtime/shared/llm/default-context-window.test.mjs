import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contextWindowRange, DEFAULT_CONTEXT_WINDOW_CEILING } from './default-context-window.mjs';

test('a window up to the ceiling is the default as a whole', () => {
  assert.deepEqual(contextWindowRange({ contextWindow: 200_000 }), { defaultWindow: 200_000, maxWindow: 200_000 });
  assert.deepEqual(contextWindowRange({ contextWindow: DEFAULT_CONTEXT_WINDOW_CEILING }), {
    defaultWindow: DEFAULT_CONTEXT_WINDOW_CEILING,
    maxWindow: DEFAULT_CONTEXT_WINDOW_CEILING,
  });
});

test('a larger window starts at the ceiling and stays selectable in full', () => {
  for (const window of [1_000_000, 1_048_576, 2_000_000]) {
    assert.deepEqual(contextWindowRange({ provider: 'anthropic-oauth', contextWindow: window }), {
      defaultWindow: DEFAULT_CONTEXT_WINDOW_CEILING,
      maxWindow: window,
    });
  }
});

test("a provider's own smaller default is kept", () => {
  assert.deepEqual(
    contextWindowRange({ provider: 'openai-oauth', contextWindow: 272_000, maxContextWindow: 872_000 }),
    {
      defaultWindow: 272_000,
      maxWindow: 872_000,
    }
  );
  // A default the provider sets above the ceiling is lowered like any other.
  assert.deepEqual(contextWindowRange({ contextWindow: 872_000, maxContextWindow: 1_000_000 }), {
    defaultWindow: DEFAULT_CONTEXT_WINDOW_CEILING,
    maxWindow: 1_000_000,
  });
});

test('a local model keeps the window its runtime allocated', () => {
  assert.deepEqual(contextWindowRange({ provider: 'mixdog-local', contextWindow: 1_000_000 }), {
    defaultWindow: 1_000_000,
    maxWindow: 1_000_000,
  });
});

test('a window within one picker stop of the ceiling is left whole', () => {
  assert.deepEqual(contextWindowRange({ contextWindow: 520_000 }), { defaultWindow: 520_000, maxWindow: 520_000 });
  assert.deepEqual(contextWindowRange({ contextWindow: 600_000 }), {
    defaultWindow: DEFAULT_CONTEXT_WINDOW_CEILING,
    maxWindow: 600_000,
  });
});

test('a row without a window to start from reports none', () => {
  assert.deepEqual(contextWindowRange({}), { defaultWindow: 0, maxWindow: 0 });
  assert.deepEqual(contextWindowRange({ contextWindow: 'x', maxContextWindow: 1_000_000 }), {
    defaultWindow: 0,
    maxWindow: 1_000_000,
  });
});
