//! Lock-free latency histogram (RL §13: poll time per task, queue wait and service per lane).
//!
//! Log-linear buckets over microseconds: values below 8 µs have one bucket each, every power of
//! two above is split in 8, so a reported quantile is within 12.5 % of the true value. Recording
//! is a handful of relaxed atomic adds and never allocates or locks.

use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering::Relaxed;
use std::time::Duration;

const SUB_BITS: u32 = 3;
const SUBS: u64 = 1 << SUB_BITS;
const BUCKETS: usize = 256;
/// Values at or above this clamp into the last bucket (about 4.7 hours); `max` stays exact.
const CLAMP_US: u64 = (1 << 34) - 1;

pub(crate) struct Histogram {
    buckets: [AtomicU64; BUCKETS],
    count: AtomicU64,
    sum_us: AtomicU64,
    max_us: AtomicU64,
}

/// Quantiles of a [`Histogram`] at one instant.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HistSummary {
    pub count: u64,
    pub sum: Duration,
    pub max: Duration,
    pub p50: Duration,
    pub p95: Duration,
    pub p99: Duration,
}

impl Histogram {
    pub(crate) fn new() -> Self {
        Self {
            buckets: std::array::from_fn(|_| AtomicU64::new(0)),
            count: AtomicU64::new(0),
            sum_us: AtomicU64::new(0),
            max_us: AtomicU64::new(0),
        }
    }

    pub(crate) fn record(&self, value: Duration) {
        let us = u64::try_from(value.as_micros()).unwrap_or(u64::MAX);
        self.buckets[bucket_of(us.min(CLAMP_US))].fetch_add(1, Relaxed);
        self.count.fetch_add(1, Relaxed);
        self.sum_us.fetch_add(us, Relaxed);
        self.max_us.fetch_max(us, Relaxed);
    }

    pub(crate) fn summary(&self) -> HistSummary {
        let counts: [u64; BUCKETS] = std::array::from_fn(|i| self.buckets[i].load(Relaxed));
        let count: u64 = counts.iter().sum();
        let max_us = self.max_us.load(Relaxed);
        let quantile = |q_per_mille: u64| {
            if count == 0 {
                return Duration::ZERO;
            }
            let rank = (count * q_per_mille).div_ceil(1000).max(1);
            let mut seen = 0;
            for (idx, n) in counts.iter().enumerate() {
                seen += n;
                if seen >= rank {
                    return Duration::from_micros(upper_bound_of(idx).min(max_us));
                }
            }
            Duration::from_micros(max_us)
        };
        HistSummary {
            count,
            sum: Duration::from_micros(self.sum_us.load(Relaxed)),
            max: Duration::from_micros(max_us),
            p50: quantile(500),
            p95: quantile(950),
            p99: quantile(990),
        }
    }
}

fn bucket_of(us: u64) -> usize {
    if us < SUBS {
        return us as usize;
    }
    let msb = 63 - us.leading_zeros();
    let sub = (us >> (msb - SUB_BITS)) & (SUBS - 1);
    ((msb - SUB_BITS + 1) as u64 * SUBS + sub) as usize
}

/// Largest value that lands in bucket `idx`.
fn upper_bound_of(idx: usize) -> u64 {
    let idx = idx as u64;
    if idx < SUBS {
        return idx;
    }
    let shift = idx / SUBS - 1;
    let sub = idx % SUBS;
    ((SUBS + sub + 1) << shift) - 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_bounds_are_contiguous_and_cover_the_clamp() {
        assert_eq!(bucket_of(CLAMP_US), BUCKETS - 1);
        for us in (0..5000u64).chain([1 << 20, (1 << 20) + 1, CLAMP_US]) {
            let idx = bucket_of(us);
            assert!(upper_bound_of(idx) >= us, "{us} above its bucket bound");
            if idx > 0 {
                assert!(upper_bound_of(idx - 1) < us, "{us} below its bucket start");
            }
        }
    }

    #[test]
    fn quantiles_track_the_distribution() {
        let hist = Histogram::new();
        for _ in 0..98 {
            hist.record(Duration::from_micros(100));
        }
        hist.record(Duration::from_millis(7));
        hist.record(Duration::from_millis(90));
        let s = hist.summary();
        assert_eq!(s.count, 100);
        assert_eq!(s.max, Duration::from_millis(90));
        assert!(s.p50 >= Duration::from_micros(100) && s.p50 <= Duration::from_micros(113));
        assert!(s.p99 >= Duration::from_millis(7) && s.p99 <= Duration::from_millis(8));
        assert_eq!(s.p95, s.p50);
    }

    #[test]
    fn empty_histogram_is_zero() {
        assert_eq!(Histogram::new().summary(), HistSummary::default());
    }
}
