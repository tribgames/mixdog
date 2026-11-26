//! The retry rows of `openai` and `openai-oauth` (PW §4.2) as one policy value.
//!
//! Node's numbers (`openai-retry-policy.mjs`, `openai-http-sse-request.mjs`,
//! `openai-ws-send-attempts/policy.mjs`): the initial POST retries 4 times and
//! a Responses stream (WebSocket handshake and pre-output failures) 5 times,
//! both on a 200 ms base doubling to 3.2 s with ±10 % jitter; server advice
//! replaces the step in full. Connection failures follow the bounded 5-step
//! session ladder (`5/10/20/40/60 s`) so unreachable endpoints fail cleanly
//! instead of looping forever.
//!
//! Two Node gates have no field in the frozen `RetryPolicy` and are not part
//! of this value: an overload or an untyped 429 retries only with server
//! advice, and the initial POST retries 5xx only while 408/429 go to the
//! stream budget. `contentFilterRetryable` is the agent loop's
//! content-filter recovery, not a provider row: the policy only states the
//! opt-in (`content_filter_retryable`).

use std::time::Duration;

use mixdog_core_api::domain::retry::AdviceRule;
use mixdog_core_api::domain::retry::Backoff;
use mixdog_core_api::domain::retry::Jitter;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::retry::RetryRow;
use mixdog_core_api::domain::retry::RetrySchedule;

/// `CODEX_REQUEST_MAX_RETRIES`.
pub(super) const REQUEST_RETRIES: u32 = 4;
/// `MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT`: the one stream budget.
const STREAM_RETRIES: u32 = 5;
/// Bounded connection retry count matching the 5-step ladder (`5/10/20/40/60 s`).
pub const CONNECTION_RETRIES: u32 = 5;
/// `CODEX_STREAM_BACKOFF_MS` is this base doubled.
const BACKOFF_BASE: Duration = Duration::from_millis(200);
/// `CODEX_RETRY_JITTER_RATIO`.
const JITTER_RATIO: f64 = 0.1;

fn exponential(max_retries: u32) -> RetryRow {
    RetryRow::single(RetrySchedule {
        max_retries,
        backoff: Backoff::Exponential { base: BACKOFF_BASE },
        jitter: Jitter::symmetric(JITTER_RATIO),
        advice: AdviceRule::honored_in_full(),
    })
}

pub fn retry_policy() -> RetryPolicy {
    let mut policy = RetryPolicy::codex_default();
    policy.request = exponential(REQUEST_RETRIES);
    policy.midstream = exponential(STREAM_RETRIES);
    let secs = Duration::from_secs;
    policy.connection = RetryRow::single(RetrySchedule {
        max_retries: CONNECTION_RETRIES,
        backoff: Backoff::Ladder(vec![secs(5), secs(10), secs(20), secs(40), secs(60)]),
        jitter: Jitter::symmetric(JITTER_RATIO),
        advice: AdviceRule::honored_in_full(),
    });
    // `retryPolicy.contentFilterRetryable` (openai-oauth.mjs:91, openai-ws.mjs:86).
    policy.content_filter_retryable = true;
    policy
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError};
    use mixdog_core_api::domain::retry::{JitterSamples, RetryClass, RetryDecider, RetryState, Verdict};

    use super::*;
    use crate::retry::StandardRetryDecider;

    #[test]
    fn connection_retries_are_bounded_to_the_ladder() {
        let policy = retry_policy();
        assert_eq!(policy.connection.schedule.max_retries, CONNECTION_RETRIES);
        assert_ne!(policy.connection.schedule.max_retries, u32::MAX);

        let error = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
        let mut state = RetryState::new(RetryClass::Connection, "gpt-5".to_owned());
        let samples = JitterSamples { step: 0.5, advice: 0.5 };
        for expected in 1..=CONNECTION_RETRIES {
            let decision = StandardRetryDecider.verdict(&error, &state, &policy, samples);
            assert!(matches!(decision.verdict, Verdict::Retry { .. }), "attempt {expected} should retry");
            state = decision.next;
        }
        let final_decision = StandardRetryDecider.verdict(&error, &state, &policy, samples);
        assert!(matches!(final_decision.verdict, Verdict::Exhausted), "connection retries must exhaust after {CONNECTION_RETRIES}");
    }
}
