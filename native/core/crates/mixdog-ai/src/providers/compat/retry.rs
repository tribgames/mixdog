//! Retry rows of the OpenAI-compatible family, as data (PW §4.2
//! `openai-compat-retry-profile.mjs`). The verdict function is the shared
//! one; nothing here decides a retry.
//!
//! A profile's `maxAttempts`/`backoffMs` become the request row and the
//! midstream row alike: today one loop covers the request and the stream
//! (`withRetry` around both), so both phases spend the same budget. The
//! profile's `backoffMs[0]` is a duplicate nobody reads, so a ladder starts at
//! `backoffMs[1]` and `max_retries` is `maxAttempts - 1`. Session-level rows
//! (transport, connection) stay the shared ladders and `recovery` is off
//! (`COMPAT_RETRY_POLICY.recoveryCycles = false`).
//!
//! Not carried over, because each is a content or wall-clock timer (SPEC
//! §4.9): `maxFailedAttemptMs` (command-code), `firstByteRetries` (mimo) and
//! the first-byte windows.

use std::time::Duration;

use mixdog_core_api::domain::retry::{
    AdviceCombine, AdviceRule, Backoff, Jitter, JitterStage, RetryPolicy, RetryRow, RetrySchedule,
    StatusRules,
};

const fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

const fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

fn ladder(steps: &[u64]) -> Backoff {
    Backoff::Ladder(steps.iter().map(|n| ms(*n)).collect())
}

/// One schedule used for the request and midstream rows of a profile.
fn profiled(schedule: RetrySchedule, status: StatusRules, reasks: Option<u32>) -> RetryPolicy {
    let mut policy = RetryPolicy::codex_default();
    policy.request = RetryRow::single(schedule.clone());
    policy.midstream = RetryRow::single(schedule);
    policy.recovery = None;
    policy.status = StatusRules {
        retry_429: true,
        retry_529: true,
        ..status
    };
    policy.final_on_exhaust = true;
    policy.empty_response_reasks = reasks;
    policy
}

/// Advice waited in full up to `ceiling`; a longer wait is not served.
fn in_full_to(ceiling: Duration) -> AdviceRule {
    AdviceRule {
        ceiling: Some(ceiling),
        ..AdviceRule::honored_in_full()
    }
}

/// A provider without a profile (custom endpoints, gateways, local servers,
/// OpenRouter): the shared default, and a `Retry-After` beyond a minute
/// surfaces with its wait so the account pool can rotate and the notice can
/// name when to try again (`COMPAT_DEFAULT_MAX_RETRY_AFTER_MS`).
pub fn unprofiled() -> RetryPolicy {
    // Today's shared default: 5 attempts on `[250, 1000, 2000, 4000, 8000]`
    // ms with ±20 % jitter. The first value is never read (retry n reads
    // index n), so the retries wait 1, 2, 4 and 8 s. One loop covers the
    // request and the stream, so both rows are the same schedule.
    let schedule = RetrySchedule {
        max_retries: 4,
        backoff: ladder(&[1000, 2000, 4000, 8000]),
        jitter: Jitter::symmetric(0.2),
        advice: in_full_to(secs(60)),
    };
    let mut policy = RetryPolicy::codex_default();
    policy.request = RetryRow::single(schedule.clone());
    policy.midstream = RetryRow::single(schedule);
    policy
}

/// 15 sends, 2 s doubling to 30 s, ±20 %, one retry for a 429. Outside a 429
/// the advice is capped at 30 s and jittered by its own draw.
pub fn xai() -> RetryPolicy {
    profiled(
        RetrySchedule {
            max_retries: 14,
            backoff: ladder(&[2000, 4000, 8000, 16000, 30000]),
            jitter: Jitter::symmetric(0.2),
            advice: AdviceRule {
                clamp: Some(secs(30)),
                jitter: Jitter::symmetric(0.2),
                jitter_stage: JitterStage::Advice,
                raw_statuses: vec![429],
                ..AdviceRule::honored_in_full()
            },
        },
        StatusRules {
            terminal: vec![408, 409, 425],
            caps: vec![(429, 1)],
            ..StatusRules::default()
        },
        // Unbounded today; the request row's retry count bounds it.
        Some(14),
    )
}

/// 6 sends, 500 ms doubling to 8 s, ±10 %; advice beyond 10 s is not waited.
pub fn deepseek() -> RetryPolicy {
    profiled(
        RetrySchedule {
            max_retries: 5,
            backoff: ladder(&[500, 1000, 2000, 4000, 8000]),
            jitter: Jitter::symmetric(0.1),
            advice: in_full_to(secs(10)),
        },
        StatusRules {
            terminal: vec![408, 409, 425],
            ..StatusRules::default()
        },
        // Unbounded today; the request row's retry count bounds it.
        Some(5),
    )
}

/// 6 sends, 500 ms doubling, no jitter, advice beyond 60 s is not waited;
/// only 408, 429 and 5xx are transient, so 409 and 425 are terminal.
pub fn muse_code() -> RetryPolicy {
    profiled(
        RetrySchedule {
            max_retries: 5,
            backoff: ladder(&[500, 1000, 2000, 4000, 8000]),
            jitter: Jitter::NONE,
            advice: in_full_to(secs(60)),
        },
        StatusRules {
            terminal: vec![409, 425],
            ..StatusRules::default()
        },
        // A benign empty completion is re-asked at most twice.
        Some(2),
    )
}

/// 9 sends (2 s doubling to 30 s, ±10 %), at most 5 retries for a 429; 408,
/// 409, 501 and 505 are terminal; advice beyond 300 s is not waited.
pub fn mimo() -> RetryPolicy {
    profiled(
        RetrySchedule {
            max_retries: 8,
            backoff: ladder(&[2000, 4000, 8000, 16000, 30000]),
            jitter: Jitter::symmetric(0.1),
            advice: in_full_to(secs(300)),
        },
        StatusRules {
            terminal: vec![408, 409, 501, 505],
            caps: vec![(429, 5)],
            ..StatusRules::default()
        },
        None,
    )
}

/// 3 sends (400 ms, 800 ms) for exactly 500/502/503/504/520/521/522: every
/// 4xx, 429 included, and every other 5xx is terminal. Advice is a floor
/// under the step and a wait beyond 60 s is not served.
pub fn command_code() -> RetryPolicy {
    profiled(
        RetrySchedule {
            max_retries: 2,
            backoff: ladder(&[400, 800]),
            // The profile names no ratio, so the shared default applies.
            jitter: Jitter::symmetric(0.2),
            advice: AdviceRule {
                combine: AdviceCombine::Floor,
                ceiling: Some(secs(60)),
                ..AdviceRule::honored_in_full()
            },
        },
        StatusRules {
            retry_only: Some(vec![500, 502, 503, 504, 520, 521, 522]),
            ..StatusRules::default()
        },
        None,
    )
}
