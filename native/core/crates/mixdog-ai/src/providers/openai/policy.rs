//! The retry rows of `openai` and `openai-oauth` (PW §4.2) as one policy value.
//!
//! Node's numbers (`openai-retry-policy.mjs`, `openai-http-sse-request.mjs`,
//! `openai-ws-send-attempts/policy.mjs`): the initial POST retries 4 times and
//! a Responses stream (WebSocket handshake and pre-output failures) 5 times,
//! both on a 200 ms base doubling to 3.2 s with ±10 % jitter; server advice
//! replaces the step in full. Both providers also opt into the loop policy
//! `unboundedConnectionRetry`, so a connect failure keeps waiting on the
//! session ladder (its last step repeating) until the network returns.
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
    // `unboundedConnectionRetry`: the ladder of 5/10/20/40/60 s with its last
    // step repeating, never spent.
    let secs = Duration::from_secs;
    policy.connection = RetryRow::single(RetrySchedule {
        max_retries: u32::MAX,
        backoff: Backoff::Ladder(vec![secs(5), secs(10), secs(20), secs(40), secs(60)]),
        jitter: Jitter::symmetric(JITTER_RATIO),
        advice: AdviceRule::honored_in_full(),
    });
    // `retryPolicy.contentFilterRetryable` (openai-oauth.mjs:91, openai-ws.mjs:86).
    policy.content_filter_retryable = true;
    policy
}
