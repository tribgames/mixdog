//! The OpenAI retry policy value against the numbers Node's own modules
//! export (`fixtures/providers/oracles/openai-retry-policy-golden.json`,
//! read from `openai-retry-policy.mjs` and the send paths by the recorder).

#![allow(clippy::disallowed_methods, reason = "test-only: reads a recorded fixture synchronously")]

use std::time::Duration;

use mixdog_ai::providers::openai::policy::retry_policy;
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
use serde_json::Value;

/// A draw of 0.5 puts a symmetric jitter on its centre: the bare step.
const MID: JitterSamples = JitterSamples { step: 0.5, advice: 0.5 };

fn golden() -> Value {
    let path = format!(
        "{}/../../fixtures/providers/oracles/openai-retry-policy-golden.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn millis(values: &Value) -> Vec<Duration> {
    values.as_array().unwrap().iter().map(|v| Duration::from_millis(v.as_u64().unwrap())).collect()
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
fn the_request_row_retries_as_the_http_loop_does() {
    let golden = golden();
    let (waited, ended) = waits(RetryClass::Request, &server_error(), 20);
    assert_eq!(waited, millis(&golden["requestWaitsMs"]));
    assert_eq!(waited.len() as u64, golden["requestMaxRetries"].as_u64().unwrap());
    assert_eq!(ended, Some(Verdict::Exhausted));
}

#[test]
fn the_stream_row_retries_as_the_ws_send_does() {
    let golden = golden();
    let (waited, ended) = waits(RetryClass::Midstream, &server_error(), 20);
    assert_eq!(waited, millis(&golden["midstreamWaitsMs"]));
    assert_eq!(waited.len() as u64, golden["midstreamRetries"].as_u64().unwrap());
    assert_eq!(ended, Some(Verdict::Exhausted));
    // The handshake shares the stream budget: attempts = retries + 1.
    assert_eq!(golden["handshakeMaxAttempts"].as_u64().unwrap(), waited.len() as u64 + 1);
}

#[test]
fn server_advice_replaces_the_step_in_full() {
    let golden = golden();
    for kind in golden["adviceRetryableKinds"].as_array().unwrap() {
        let kind = match kind.as_str().unwrap() {
            "overloaded" => ErrorKind::Overloaded,
            "rate_limited" => ErrorKind::RateLimited,
            _ => ErrorKind::Transient,
        };
        for class in [RetryClass::Request, RetryClass::Midstream] {
            let mut err = ProviderError::new(kind, DeliveryState::Accepted);
            err.retry_after = Some(Duration::from_secs(90));
            let (waited, _) = waits(class, &err, 1);
            assert_eq!(waited, vec![Duration::from_secs(90)], "{kind:?} {class:?}");
        }
    }
}

#[test]
fn a_connect_failure_waits_for_the_network_without_end() {
    let golden = golden();
    assert_eq!(golden["providerRetryPolicy"]["openaiOauth"]["unboundedConnectionRetry"], true);
    assert_eq!(golden["providerRetryPolicy"]["openai"]["unboundedConnectionRetry"], true);
    let ladder = millis(&golden["connectionLadderMs"]);
    let err = ProviderError::transport(TransportFault::Connect { os_code: None }, DeliveryState::NotSent);
    let (waited, ended) = waits(RetryClass::Connection, &err, 100);
    assert_eq!(ended, None, "never exhausted");
    assert_eq!(waited.len(), 100);
    for (n, wait) in waited.iter().enumerate() {
        assert_eq!(*wait, ladder[n.min(ladder.len() - 1)], "retry {}", n + 1);
    }
}
