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

test('the quiet cue reaches the byline only after two silent minutes and escalates at the warn point', () => {
  const since = 1_000;
  const quiet = { since, wait: 'tool', tool: 'shell', warnMs: 300_000 };
  assert.equal(buildSpinnerMeta({ quiet, now: since + 119_999 }).quietParts, null);
  assert.equal(buildSpinnerMeta({ quiet, now: since + 119_999 }).quietText, '');
  const early = buildSpinnerMeta({ quiet, now: since + 180_000 });
  assert.deepEqual(early.quietParts, { quietMs: 180_000, minutes: 3, wait: 'tool', tool: 'shell', escalated: false });
  assert.equal(early.quietText, 'quiet for 3m · running shell');
  assert.equal(buildSpinnerMeta({ quiet, now: since + 300_000 }).quietParts.escalated, true);
  // No warn point published: the cue never escalates.
  const noWarn = buildSpinnerMeta({ quiet: { since, wait: 'thinking' }, now: since + 600_000 });
  assert.equal(noWarn.quietParts.escalated, false);
  assert.equal(noWarn.quietText, 'quiet for 10m · model thinking');
  assert.equal(buildSpinnerMeta({ quiet: null, now: since + 600_000 }).quietParts, null);
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
