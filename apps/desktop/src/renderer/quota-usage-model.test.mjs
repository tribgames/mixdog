import assert from 'node:assert/strict';
import test from 'node:test';
import { quotaPercent } from './quota-usage-model.ts';
import { displayUsagePercent } from './usage-percent.ts';

test('quota percentages round to whole numbers, and to a tenth under 1 %', () => {
  for (const [value, expected] of [
    [0, '0%'],
    [0.3, '0.3%'],
    [0.49, '0.5%'],
    [0.5, '0.5%'],
    [2, '2%'],
    [2.4, '2%'],
    [2.5, '3%'],
    [2.6, '3%'],
    [9.9, '10%'],
    [10.4, '10%'],
    [10.5, '11%'],
    [99.6, '100%'],
    [100, '100%'],
    ['2.6', '3%'],
  ]) {
    assert.equal(quotaPercent(value), expected, String(value));
  }
});

test('the quota body reads a meter value as the card, popover and rail read it', () => {
  for (const value of [0, 0.04, 0.3, 0.46, 0.96, 1, 4.46, 9.5, 10.4, 99.6, 100]) {
    assert.equal(quotaPercent(value), `${displayUsagePercent(value)}%`, String(value));
  }
});

test('unavailable quota percentages remain unavailable', () => {
  for (const value of [null, undefined, '', NaN, Infinity, 'invalid']) {
    assert.equal(quotaPercent(value), '—', String(value));
  }
});
