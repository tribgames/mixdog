//! The retry rows of the three Google providers, as data (PW §4.2). The
//! shared verdict function reads them; nothing here retries.

use std::time::Duration;

use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::retry::AdviceCombine;
use mixdog_core_api::domain::retry::AdviceRule;
use mixdog_core_api::domain::retry::Backoff;
use mixdog_core_api::domain::retry::Jitter;
use mixdog_core_api::domain::retry::JitterMode;
use mixdog_core_api::domain::retry::JitterStage;
use mixdog_core_api::domain::retry::KindSchedule;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::retry::RetryRow;
use mixdog_core_api::domain::retry::RetrySchedule;

const fn secs(s: u64) -> Duration {
    Duration::from_secs(s)
}

fn ladder(steps: &[u64]) -> Backoff {
    Backoff::Ladder(steps.iter().copied().map(secs).collect())
}

/// Gemini API and Vertex AI (`gemini-retry-policy.mjs`): ten attempts opening
/// the request, then four attempts for a stream that dies after it opened.
/// A server wait over 300 s ends recovery on both.
pub fn gemini() -> RetryPolicy {
    let mut policy = RetryPolicy::codex_default();
    policy.request = RetryRow::single(RetrySchedule {
        max_retries: 9,
        backoff: ladder(&[5, 10, 20, 30]),
        jitter: Jitter::symmetric(0.3),
        advice: AdviceRule {
            combine: AdviceCombine::Floor,
            ceiling: Some(secs(300)),
            jitter: Jitter {
                ratio: 0.2,
                mode: JitterMode::Positive,
            },
            jitter_stage: JitterStage::Wait,
            ..AdviceRule::honored_in_full()
        },
    });
    policy.midstream = RetryRow::single(RetrySchedule {
        max_retries: 3,
        backoff: Backoff::Exponential { base: secs(1) },
        jitter: Jitter::NONE,
        advice: AdviceRule {
            ceiling: Some(secs(300)),
            ..AdviceRule::honored_in_full()
        },
    });
    // A status-only 499 (client closed the request) is retried.
    policy.status.retry_499 = true;
    policy.final_on_exhaust = true;
    policy
}

/// Antigravity (`antigravity-retry-policy.mjs`): one same-host ladder of three
/// retries at 1/2/4 s ±10 %, with a capacity schedule and a one-shot rate
/// limit schedule that each start the ladder afresh. Spent quota is never
/// retried; recovery cycles are off.
pub fn antigravity() -> RetryPolicy {
    let mut policy = RetryPolicy::codex_default();
    let steps = || ladder(&[1, 2, 4]);
    let row = RetrySchedule {
        max_retries: 3,
        backoff: steps(),
        jitter: Jitter::symmetric(0.1),
        advice: AdviceRule::honored_in_full(),
    };
    policy.request = RetryRow {
        schedule: row.clone(),
        by_kind: vec![
            KindSchedule {
                kind: ErrorKind::Overloaded,
                schedule: RetrySchedule {
                    advice: AdviceRule {
                        combine: AdviceCombine::Floor,
                        budget: Some(secs(60)),
                        ..AdviceRule::honored_in_full()
                    },
                    ..row.clone()
                },
                resets_base: true,
            },
            KindSchedule {
                kind: ErrorKind::RateLimited,
                schedule: RetrySchedule {
                    max_retries: 1,
                    backoff: ladder(&[1]),
                    jitter: Jitter::NONE,
                    advice: AdviceRule {
                        ceiling: Some(secs(60)),
                        ..AdviceRule::honored_in_full()
                    },
                },
                resets_base: true,
            },
        ],
    };
    // A stream that dies after it opened, and an empty answer, re-ask on the
    // same ladder.
    policy.midstream = RetryRow::single(row);
    policy.recovery = None;
    policy.status.retry_429 = false;
    policy.final_on_exhaust = true;
    policy
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_core_api::domain::conformance::check_retry_policy;

    #[test]
    fn rows_are_well_formed() {
        check_retry_policy(&gemini());
        check_retry_policy(&antigravity());
    }
}
