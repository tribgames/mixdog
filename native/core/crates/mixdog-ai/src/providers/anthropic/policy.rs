//! The Anthropic rows of the one `RetryPolicy` (PW §4.2): request budget of the
//! Messages POST, the bounded mid-stream budget, and the Anthropic overload
//! rule. Session-level rows (transport, connection, recovery) are the shared
//! defaults.

use std::time::Duration;

use mixdog_core_api::domain::retry::AdviceRule;
use mixdog_core_api::domain::retry::Backoff;
use mixdog_core_api::domain::retry::Jitter;
use mixdog_core_api::domain::retry::JitterMode;
use mixdog_core_api::domain::retry::OverloadRule;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::retry::RetryRow;
use mixdog_core_api::domain::retry::RetrySchedule;
use mixdog_core_api::domain::retry::StatusRules;

/// Retries of the Messages POST (the SDK default of 10).
const REQUEST_RETRIES: u32 = 10;
/// Consecutive overloads after which the send hands over to the fallback model.
const MAX_CONSECUTIVE_OVERLOADS: u32 = 3;
/// Retries of a stream lost mid-body.
const MIDSTREAM_RETRIES: u32 = 3;

fn millis(steps: &[u64]) -> Vec<Duration> {
    steps.iter().map(|ms| Duration::from_millis(*ms)).collect()
}

/// `retry_429`: whether a 429 on the Messages POST is retried. An API key and
/// an enterprise subscription retry it; a Max/Pro subscription window does not.
pub(crate) fn retry_policy(retry_429: bool) -> RetryPolicy {
    let mut policy = RetryPolicy::codex_default();
    policy.request = RetryRow::single(RetrySchedule {
        max_retries: REQUEST_RETRIES,
        backoff: Backoff::Ladder(millis(&[500, 1000, 2000, 4000, 8000, 16000, 32000, 32000, 32000, 32000])),
        jitter: Jitter {
            ratio: 0.25,
            mode: JitterMode::Positive,
        },
        advice: AdviceRule::honored_in_full(),
    });
    policy.midstream = RetryRow::single(RetrySchedule {
        max_retries: MIDSTREAM_RETRIES,
        backoff: Backoff::Ladder(millis(&[250, 1000, 2000, 4000])),
        jitter: Jitter::symmetric(0.2),
        advice: AdviceRule::honored_in_full(),
    });
    policy.status = StatusRules {
        retry_429,
        retry_529: true,
        ..StatusRules::default()
    };
    policy.overload = OverloadRule {
        fallback_after: Some(MAX_CONSECUTIVE_OVERLOADS),
        fallback_model: None,
        stop_after_repeated: false,
    };
    policy.honor_should_retry_true = true;
    policy
}
