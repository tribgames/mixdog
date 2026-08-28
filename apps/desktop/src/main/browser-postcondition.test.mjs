import assert from 'node:assert/strict';
import test from 'node:test';

import {
  browserPostconditionMatches,
  describeBrowserPostcondition,
  normalizeBrowserPostcondition,
  normalizeBrowserSettleMs,
} from './browser-postcondition.ts';

test('browser postconditions normalize bounded waits and match text plus URL without replay policy', () => {
  const expected = normalizeBrowserPostcondition({
    text: 'Saved',
    textGone: 'Loading',
    url: '/complete',
    timeoutMs: 90_000,
  });
  assert.deepEqual(expected, {
    text: 'Saved',
    textGone: 'Loading',
    url: '/complete',
    timeoutMs: 20_000,
  });
  assert.equal(browserPostconditionMatches(expected, {
    text: 'Saved successfully',
    url: 'https://example.test/complete?locale=ko',
  }), true);
  assert.equal(browserPostconditionMatches(expected, {
    text: 'Loading — Saved successfully',
    url: 'https://example.test/complete',
  }), false);
  assert.equal(
    describeBrowserPostcondition(expected),
    'text "Saved" and textGone "Loading" and url "/complete"',
  );
});

test('browser postconditions reject empty contracts and bound explicit settle delays', () => {
  assert.equal(normalizeBrowserPostcondition(undefined), null);
  assert.throws(() => normalizeBrowserPostcondition({}), /requires text/);
  assert.throws(() => normalizeBrowserPostcondition({ text: 1 }), /must be a string/);
  assert.equal(normalizeBrowserSettleMs(-1), 0);
  assert.equal(normalizeBrowserSettleMs(20_000), 5_000);
  assert.throws(() => normalizeBrowserSettleMs(Number.NaN), /finite number/);
});
