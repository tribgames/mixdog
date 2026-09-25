// Latency statistics shared by the scripts/ CLIs and benches. Nearest-rank
// percentiles: p50 of an even-sized sample is the lower middle sample, never
// an interpolated value, so a reported number is always one the run actually
// produced. An empty sample reports null rather than a zero that would read
// as a real measurement.

// `p` is a percent (0-100); `sorted` must already be ascending.
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

// The nearest-rank p50 of an ascending sample.
export function median(sorted) {
  return percentile(sorted, 50);
}

// The finite number samples in ascending order, as a new array; anything
// else (NaN, Infinity, null, strings) is dropped, never coerced.
export function sortedFinite(values) {
  return values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
}

export function stats(nums) {
  const arr = sortedFinite(nums);
  if (arr.length === 0) return null;
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    n: arr.length,
    sum,
    avg: Math.round(sum / arr.length),
    p50: percentile(arr, 50),
    p90: percentile(arr, 90),
    p99: percentile(arr, 99),
    max: arr[arr.length - 1],
  };
}
