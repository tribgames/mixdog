import assert from 'node:assert/strict';
import test from 'node:test';
import { median, percentile, sortedFinite, stats } from './trace-stats.mjs';

test('percentile picks the nearest rank of an ascending sample', () => {
  const sorted = [10, 20, 30, 40];
  assert.equal(percentile(sorted, 50), 20);
  assert.equal(percentile(sorted, 90), 40);
  assert.equal(percentile(sorted, 99), 40);
  assert.equal(percentile([5], 50), 5);
  assert.equal(percentile([], 50), null);
  // Rank 0 and below clamp to the first sample, never to undefined.
  assert.equal(percentile(sorted, 0), 10);
});

test('median is the nearest-rank p50: the lower middle sample, null when empty', () => {
  assert.equal(median([10, 20, 30, 40]), 20);
  assert.equal(median([10, 20, 30]), 20);
  assert.equal(median([7]), 7);
  assert.equal(median([]), null);
});

test('percentile is nearest-rank, not floor(n*p) index truncation', () => {
  // floor(n*p) indexing reports 20 for p50 of [10,20] and 20 for p95 of 1..20.
  assert.equal(percentile([10, 20], 50), 10);
  assert.equal(
    percentile(
      Array.from({ length: 20 }, (_, i) => i + 1),
      95
    ),
    19
  );
});

test('sortedFinite sorts a copy and drops non-finite entries without coercing them', () => {
  const input = [3, null, '2', Number.NaN, 1, undefined, Number.NEGATIVE_INFINITY];
  assert.deepEqual(sortedFinite(input), [1, 3]);
  assert.equal(input[0], 3);
});

test('stats summarizes finite samples and reports null for an empty set', () => {
  assert.deepEqual(stats([30, 10, 20]), { n: 3, sum: 60, avg: 20, p50: 20, p90: 30, p99: 30, max: 30 });
  assert.equal(stats([]), null);
  assert.equal(stats([Number.NaN, Number.POSITIVE_INFINITY]), null);
});

test('stats drops non-finite samples and leaves the caller array untouched', () => {
  const input = [3, Number.NaN, 1, Number.POSITIVE_INFINITY, 2];
  assert.deepEqual(stats(input), { n: 3, sum: 6, avg: 2, p50: 2, p90: 3, p99: 3, max: 3 });
  assert.deepEqual(input, [3, Number.NaN, 1, Number.POSITIVE_INFINITY, 2]);
});

test('stats rounds the average, matching the reported millisecond columns', () => {
  assert.equal(stats([1, 2]).avg, 2);
  assert.equal(stats([1, 1, 2]).avg, 1);
});
