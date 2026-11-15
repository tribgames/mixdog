//! Sliding-window rate limiter (`lib/rate-limit.mjs`): a timestamp log per key, an expiry sweep when the table is full, and
//! least-recently-used eviction at [`MAX_RATE_KEYS`], on the clock of `mixdog_rt` (`Date.now()`).

use std::collections::{BTreeMap, HashMap};
use std::time::UNIX_EPOCH;

pub const MAX_RATE_KEYS: usize = 10_000;

/// `Date.now()`: milliseconds since the Unix epoch on the replay's clock when one runs the process.
pub fn now_ms() -> i64 {
    mixdog_rt::wall_clock!().duration_since(UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

struct Bucket {
    /// Position in the use order: a Map's insertion order, which a hit moves to the end.
    seq: u64,
    stamps: Vec<i64>,
}

pub struct RateLimiter {
    limit: usize,
    window_ms: i64,
    max_keys: usize,
    next_seq: u64,
    hits: HashMap<String, Bucket>,
    order: BTreeMap<u64, String>,
}

impl RateLimiter {
    pub fn new(limit: usize, window_ms: i64) -> Self {
        Self::with_max_keys(limit, window_ms, MAX_RATE_KEYS)
    }

    pub fn with_max_keys(limit: usize, window_ms: i64, max_keys: usize) -> Self {
        Self { limit, window_ms, max_keys: max_keys.max(1), next_seq: 0, hits: HashMap::new(), order: BTreeMap::new() }
    }

    /// Records a hit for `key` and says whether it is within the limit. An empty key counts as `unknown`.
    pub fn allow(&mut self, key: &str) -> bool {
        self.allow_at(key, now_ms())
    }

    /// [`Self::allow`] at a given time.
    pub fn allow_at(&mut self, key: &str, now: i64) -> bool {
        let id = key_of(key);
        let cutoff = now - self.window_ms;
        let prior = self.take(id);
        if prior.is_none() && self.hits.len() >= self.max_keys {
            let existing: Vec<String> = self.order.values().cloned().collect();
            for name in existing {
                if let Some(bucket) = self.hits.get_mut(&name) {
                    bucket.stamps.retain(|stamp| *stamp > cutoff);
                    if bucket.stamps.is_empty() {
                        self.drop_key(&name);
                    }
                }
            }
            // An attacker can keep every key live: the cap is enforced after the sweep as an LRU, so bounded memory
            // outranks keeping an old bucket.
            while self.hits.len() >= self.max_keys {
                let Some(oldest) = self.order.values().next().cloned() else { break };
                self.drop_key(&oldest);
            }
        }
        let mut stamps = prior.unwrap_or_default();
        stamps.retain(|stamp| *stamp > cutoff);
        if stamps.len() >= self.limit {
            self.put(id, stamps);
            return false;
        }
        stamps.push(now);
        self.put(id, stamps);
        true
    }

    /// Milliseconds until `allow(key)` would admit again: 0 while the key is under its limit. A hit stops counting once a
    /// full window has passed, so the key is admitted again when the oldest of its last `limit` hits ages out.
    pub fn retry_after_ms(&self, key: &str) -> i64 {
        self.retry_after_ms_at(key, now_ms())
    }

    /// [`Self::retry_after_ms`] at a given time.
    pub fn retry_after_ms_at(&self, key: &str, now: i64) -> i64 {
        let Some(bucket) = self.hits.get(key_of(key)) else { return 0 };
        let stamps = &bucket.stamps;
        if stamps.len() < self.limit {
            return 0;
        }
        stamps.get(stamps.len() - self.limit).map_or(0, |oldest| (oldest + self.window_ms - now).max(0))
    }

    fn take(&mut self, id: &str) -> Option<Vec<i64>> {
        let bucket = self.hits.remove(id)?;
        self.order.remove(&bucket.seq);
        Some(bucket.stamps)
    }

    fn drop_key(&mut self, id: &str) {
        drop(self.take(id));
    }

    fn put(&mut self, id: &str, stamps: Vec<i64>) {
        let seq = self.next_seq;
        self.next_seq += 1;
        self.order.insert(seq, id.to_owned());
        self.hits.insert(id.to_owned(), Bucket { seq, stamps });
    }
}

/// `String(key || 'unknown')`.
fn key_of(key: &str) -> &str {
    if key.is_empty() { "unknown" } else { key }
}
