//! The OpenAI retry policy as the product runs it: the request row (the initial POST) retries 4 times and the stream row
//! (a Responses stream, the WebSocket handshake and pre-output failures) 5 times on a 200 ms base doubling, server advice
//! replaces a step in full, and a connection failure waits on the 5/10/20/40/60 s ladder for 5 bounded attempts before
//! exhausting. The numbers are the documented ones of `providers/openai/policy.rs`, spelled out here.

use std::time::Duration;

use mixdog_ai::providers::openai::policy::{CONNECTION_RETRIES, retry_policy};
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_core_api::domain::conformance::check_retry_policy;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::retry::JitterSamples;
use mixdog_core_api::domain::retry::RetryClass;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::Verdict;

/// A draw of 0.5 puts a symmetric jitter on its centre: the bare step.
const MID: JitterSamples = JitterSamples { step: 0.5, advice: 0.5 };

fn ms(values: &[u64]) -> Vec<Duration> {
    values.iter().map(|v| Duration::from_millis(*v)).collect()
}

/// The wait of each retry in turn until the row gives up (at most `limit`).
fn waits(class: RetryClass, error: &ProviderError, limit: usize) -> (Vec<Duration>, Option<Verdict>) {
    let policy = retry_policy();
    let mut state = RetryState::new(class, "m");
    let mut out = Vec::new();
    for _ in 0..limit {
        let decision = StandardRetryDecider.verdict(error, &state, &policy, MID);
        match decision.verdict {
            Verdict::Retry { delay, .. } => out.push(delay),
            other => return (out, Some(other)),
        }
        state = decision.next;
    }
    (out, None)
}

fn server_error() -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
    err.status = Some(503);
    err
}

#[test]
fn the_value_passes_the_policy_conformance() {
    check_retry_policy(&retry_policy());
}

#[test]
fn the_request_row_retries_four_times_on_a_doubling_200_ms_step_then_gives_up() {
    let (waited, ended) = waits(RetryClass::Request, &server_error(), 20);
    assert_eq!(waited, ms(&[200, 400, 800, 1600]));
    assert_eq!(ended, Some(Verdict::Exhausted));
}

#[test]
fn the_stream_row_retries_five_times_on_the_same_steps_then_gives_up() {
    let (waited, ended) = waits(RetryClass::Midstream, &server_error(), 20);
    assert_eq!(waited, ms(&[200, 400, 800, 1600, 3200]));
    assert_eq!(ended, Some(Verdict::Exhausted));
}

#[test]
fn server_advice_replaces_the_step_in_full() {
    for kind in [ErrorKind::Transient, ErrorKind::Overloaded, ErrorKind::RateLimited] {
        for class in [RetryClass::Request, RetryClass::Midstream] {
            let mut err = ProviderError::new(kind, DeliveryState::Accepted);
            err.retry_after = Some(Duration::from_secs(90));
            let (waited, _) = waits(class, &err, 1);
            assert_eq!(waited, vec![Duration::from_secs(90)], "{kind:?} {class:?}");
        }
    }
}

#[test]
fn a_connect_failure_retries_bounded_ladder_then_exhausts() {
    let err = ProviderError::transport(TransportFault::Connect { os_code: None }, DeliveryState::NotSent);
    let (waited, ended) = waits(RetryClass::Connection, &err, 100);
    assert_eq!(ended, Some(Verdict::Exhausted), "connection retries are bounded");
    assert_eq!(waited.len(), CONNECTION_RETRIES as usize);
    assert_eq!(waited, ms(&[5_000, 10_000, 20_000, 40_000, 60_000]));
}
