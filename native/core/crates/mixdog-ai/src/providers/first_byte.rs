//! The first-byte windows of the providers that state a first-response budget, and the budget itself
//! (`stall-policy.mjs` `firstByteWindowMs` / `providerFirstResponseBudget` / `firstBytePolicyBudget`): the longest one send
//! may wait for its response headers and its first output across the provider's whole retry ladder, which the agent
//! watchdog's first-response deadlines are floored above.

use std::time::Duration;

use mixdog_core_api::domain::provider::FirstResponseBudget;
use mixdog_core_api::domain::retry::Backoff;
use mixdog_core_api::domain::retry::RetrySchedule;

/// `PROVIDER_MAX_BEFORE_WARN_MS` at the default stall thresholds (warn 300 s less one 15 s tick): no first-byte window
/// is longer, so the provider times out before the watchdog warns.
pub const PROVIDER_MAX_BEFORE_WARN_MS: i64 = 285_000;

/// `PROVIDER_FIRST_BYTE_TIMEOUT_MS` / `GEMINI_FIRST_BYTE_TIMEOUT_MS`: the shared window.
pub const SHARED_FIRST_BYTE_MS: i64 = 60_000;

/// A first-byte policy `{ timeoutMs, maxMs, retries }`: `timeout_ms` is the first attempt's window (headers, and again the
/// first chunk); each first-byte timeout doubles the next window up to `max_ms`, and `retries` caps how many of those
/// timeouts are retried. `None` leaves first-byte timeouts to the provider's ordinary ladder, every attempt on `timeout_ms`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FirstBytePolicy {
    pub timeout_ms: i64,
    pub max_ms: i64,
    pub retries: Option<u32>,
}

impl FirstBytePolicy {
    /// `firstByteWindowMs`: the window of an attempt after `timeouts` first-byte timeouts.
    fn window_ms(&self, timeouts: u32) -> i64 {
        match self.retries {
            None => self.timeout_ms,
            Some(_) => self.timeout_ms.saturating_mul(1_i64 << timeouts.min(40)).min(self.timeout_ms.max(self.max_ms)),
        }
    }
}

/// The wait before attempt `attempt` (0-based; the first never waits) on the schedule's ladder.
fn backoff_ms(backoff: &Backoff, attempt: u32) -> i64 {
    if attempt == 0 {
        return 0;
    }
    let wait = match backoff {
        Backoff::Ladder(steps) => steps.get((attempt as usize).min(steps.len()).wrapping_sub(1)).copied().unwrap_or(Duration::ZERO),
        Backoff::Exponential { base } => base.saturating_mul(1_u32 << (attempt - 1).min(30)),
    };
    wait.as_millis() as i64
}

/// `firstBytePolicyBudget`: `providerFirstResponseBudget` over the schedule's attempts. Drops and 5xx share the ladder with
/// first-byte timeouts, so every attempt is budgeted a full window: the timeouts the policy retries come first, then the
/// later attempts sit at the widest window. `transport_ms` covers the header stage, `semantic_ms` headers plus first chunk.
pub fn first_byte_budget(policy: &FirstBytePolicy, schedule: &RetrySchedule) -> FirstResponseBudget {
    let (mut transport_ms, mut semantic_ms) = (0, 0);
    for attempt in 0..=schedule.max_retries {
        let backoff = backoff_ms(&schedule.backoff, attempt);
        let window = policy.window_ms(attempt.min(policy.retries.unwrap_or(0)));
        transport_ms += backoff + window;
        semantic_ms += backoff + 2 * window;
    }
    FirstResponseBudget { transport_ms, semantic_ms }
}
