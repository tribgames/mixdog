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

use crate::providers::first_byte::FirstByteSettings;

/// Retries of the Messages POST (the SDK default of 10).
const REQUEST_RETRIES: u32 = 10;
/// Consecutive overloads after which the send hands over to the fallback model.
const MAX_CONSECUTIVE_OVERLOADS: u32 = 3;
/// Retries of a stream lost mid-body.
const MIDSTREAM_RETRIES: u32 = 3;

/// `parseInt(raw, 10)` of a setting: the leading integer, `None` when there is none.
fn leading_integer(raw: &str) -> Option<i64> {
    let text = raw.trim_start();
    let sign = usize::from(text.starts_with(['+', '-']));
    let digits = text[sign..].bytes().take_while(u8::is_ascii_digit).count();
    text[..sign + digits].parse().ok()
}

/// `anthropicMaxAttempts`: `CLAUDE_CODE_MAX_RETRIES` retries of the Messages POST (10 unset or unreadable), held to 0..=100.
pub(crate) fn request_retries(get: impl Fn(&str) -> Option<String>) -> u32 {
    get("CLAUDE_CODE_MAX_RETRIES").as_deref().and_then(leading_integer).map_or(REQUEST_RETRIES, |n| n.clamp(0, 100) as u32)
}

/// `anthropicRequestTimeoutMs`: `API_TIMEOUT_MS` when it is a positive integer, else the SDK's ten minutes.
pub(crate) fn request_timeout_ms(get: impl Fn(&str) -> Option<String>) -> u64 {
    get("API_TIMEOUT_MS").as_deref().and_then(leading_integer).filter(|ms| *ms > 0).map_or(600_000, |ms| ms as u64)
}

fn millis(steps: &[u64]) -> Vec<Duration> {
    steps.iter().map(|ms| Duration::from_millis(*ms)).collect()
}

/// `retry_429`: whether a 429 on the Messages POST is retried. An API key and
/// an enterprise subscription retry it; a Max/Pro subscription window does not.
pub(crate) fn retry_policy(retry_429: bool) -> RetryPolicy {
    retry_policy_with(retry_429, FirstByteSettings::default_jitter())
}

/// [`retry_policy`] with `default_jitter` as the mid-stream ratio (the shared `MIXDOG_PROVIDER_RETRY_JITTER_RATIO`).
pub(crate) fn retry_policy_with(retry_429: bool, default_jitter: Jitter) -> RetryPolicy {
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
        // `midstreamBackoffFor` names no ratio: the shared default.
        jitter: default_jitter,
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
    // A cut stream that spent the mid-stream row is replayed by the loop (`anthropic-midstream-recovery.mjs` never marks it
    // `providerRecoveryExhausted`).
    policy.stream_cut_loop_replay = true;
    policy
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `CLAUDE_CODE_MAX_RETRIES` and `API_TIMEOUT_MS` are read as Node's `anthropicMaxAttempts` / `anthropicRequestTimeoutMs` do.
    #[test]
    fn the_retry_budget_and_request_timeout_follow_their_settings() {
        let set = |name: &'static str, value: &'static str| move |asked: &str| (asked == name).then(|| value.to_owned());
        assert_eq!(request_retries(|_| None), 10);
        assert_eq!(request_retries(set("CLAUDE_CODE_MAX_RETRIES", "3")), 3);
        assert_eq!(request_retries(set("CLAUDE_CODE_MAX_RETRIES", "500")), 100);
        assert_eq!(request_retries(set("CLAUDE_CODE_MAX_RETRIES", "-2")), 0);
        assert_eq!(request_retries(set("CLAUDE_CODE_MAX_RETRIES", "lots")), 10);
        assert_eq!(request_timeout_ms(|_| None), 600_000);
        assert_eq!(request_timeout_ms(set("API_TIMEOUT_MS", "45000")), 45_000);
        assert_eq!(request_timeout_ms(set("API_TIMEOUT_MS", "0")), 600_000);
    }

    #[test]
    fn the_midstream_row_takes_the_tuned_ratio_and_the_request_row_keeps_its_own() {
        let tuned = Jitter::symmetric(0.5);
        let policy = retry_policy_with(true, tuned);
        assert_eq!(policy.midstream.schedule.jitter, tuned);
        assert_eq!(policy.request.schedule.jitter, Jitter { ratio: 0.25, mode: JitterMode::Positive });
    }

    #[test]
    fn a_spent_stream_cut_goes_on_to_the_loop_transport_row_on_both_routes() {
        for retry_429 in [true, false] {
            assert!(retry_policy(retry_429).stream_cut_loop_replay);
        }
        assert!(!RetryPolicy::codex_default().stream_cut_loop_replay);
    }
}
