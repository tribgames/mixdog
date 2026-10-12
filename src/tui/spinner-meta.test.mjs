import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSpinnerMeta, spinnerThinkingLabel, spinnerThinkingParts } from './spinner-meta.mjs';

test('the TUI byline stays lowercase English', () => {
  assert.equal(spinnerThinkingLabel({ thinking: true, effort: 'High' }), 'thinking (high)');
  assert.equal(spinnerThinkingLabel({ thinking: true, effort: 'auto' }), 'thinking');
  assert.equal(spinnerThinkingLabel({ thinkingMs: 12_400 }), 'thought for 12s');
  assert.equal(spinnerThinkingLabel({ thinkingMs: 400 }), '');
  assert.equal(buildSpinnerMeta({ outputTokens: 340 }).tokensText, '340 tokens');
  assert.equal(buildSpinnerMeta({ outputTokens: 12_000 }).tokensText, '12k tokens');
});

test('structured parts carry kind and values for translating surfaces', () => {
  assert.deepEqual(spinnerThinkingParts({ thinking: true, effort: 'medium' }), { kind: 'thinking', effort: 'medium' });
  assert.deepEqual(spinnerThinkingParts({ thinking: true }), { kind: 'thinking', effort: '' });
  assert.deepEqual(spinnerThinkingParts({ thinkingMs: 3000 }), { kind: 'thought', seconds: 3 });
  assert.equal(spinnerThinkingParts({}), null);
  const meta = buildSpinnerMeta({ outputTokens: 340, thinking: true, effort: 'low' });
  assert.equal(meta.tokensCount, '340');
  assert.deepEqual(meta.thinkingParts, { kind: 'thinking', effort: 'low' });
  assert.equal(buildSpinnerMeta({}).tokensCount, '');
});
