import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempDirSync } from '../../../../../../scripts/lib/scoped-temp.mjs';

process.env.MIXDOG_DATA_DIR = makeTempDirSync('context-meta');
const { resolveSessionContextMeta } = await import('./context-meta.mjs');

const providerWith = (name, info = null) => ({ name, getCachedModelInfo: () => info });

test('a live provider window decides for an id no code has seen', () => {
  const meta = resolveSessionContextMeta(
    providerWith('anthropic', { context_window: 2_000_000 }),
    'claude-nova-9',
    {},
    { wholeWindow: true }
  );
  assert.equal(meta.rawContextWindow, 2_000_000);
});

test('a cold catalog keeps the family fallback for current hosted families', () => {
  for (const [provider, model, window] of [
    ['anthropic', 'claude-opus-5-5', 1000000],
    ['openai', 'gpt-6.1-sol', 272000],
    ['xai', 'grok-4.5', 500000],
    ['gemini', 'gemini-3.8-flash', 1000000],
  ]) {
    const meta = resolveSessionContextMeta(providerWith(provider), model, {}, { wholeWindow: true });
    assert.equal(meta.rawContextWindow, window, `${provider}/${model}`);
  }
});

test('a window the session already recorded outranks the cold default', () => {
  const meta = resolveSessionContextMeta(
    providerWith('openai'),
    'gpt-9.2-sol',
    { contextWindow: 400000 },
    { wholeWindow: true }
  );
  assert.equal(meta.rawContextWindow, 400000);
});
