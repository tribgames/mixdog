//! The production decider against the P0 conformance checks.

use mixdog_ai::retry::StandardRetryDecider;
use mixdog_core_api::domain::conformance::check_retry_decider;
use mixdog_core_api::domain::conformance::check_retry_policy;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::retry::JitterSamples;
use mixdog_core_api::domain::retry::OverloadRule;
use mixdog_core_api::domain::retry::RetryClass;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::StatusRules;
use mixdog_core_api::domain::retry::Verdict;

const MID: JitterSamples = JitterSamples {
    step: 0.5,
    advice: 0.5,
};

#[test]
fn passes_the_p0_decider_conformance() {
    check_retry_policy(&RetryPolicy::codex_default());
    check_retry_decider(&StandardRetryDecider);
}

fn failure(kind: ErrorKind, status: Option<u16>) -> ProviderError {
    let mut err = ProviderError::new(kind, DeliveryState::Accepted);
    err.status = status;
    err
}

fn verdict(err: &ProviderError, policy: &RetryPolicy, state: &RetryState) -> Verdict {
    mixdog_core_api::domain::retry::RetryDecider::verdict(
        &StandardRetryDecider,
        err,
        state,
        policy,
        MID,
    )
    .verdict
}

fn request() -> RetryState {
    RetryState::new(RetryClass::Request, "m")
}

#[test]
fn terminal_and_edge_statuses_surface_even_when_transient() {
    let mut policy = RetryPolicy::codex_default();
    policy.status.terminal = vec![409];
    assert_eq!(
        verdict(&failure(ErrorKind::Transient, Some(525)), &policy, &request()),
        Verdict::Surface
    );
    assert_eq!(
        verdict(&failure(ErrorKind::Transient, Some(409)), &policy, &request()),
        Verdict::Surface
    );
    assert!(matches!(
        verdict(&failure(ErrorKind::Transient, Some(503)), &policy, &request()),
        Verdict::Retry { .. }
    ));
}

#[test]
fn retry_only_limits_statuses_but_not_transport_faults() {
    let mut policy = RetryPolicy::codex_default();
    policy.status = StatusRules {
        retry_only: Some(vec![500, 502, 503]),
        retry_429: true,
        retry_529: true,
        ..StatusRules::default()
    };
    assert_eq!(
        verdict(&failure(ErrorKind::RateLimited, Some(429)), &policy, &request()),
        Verdict::Surface
    );
    assert!(matches!(
        verdict(&failure(ErrorKind::Transient, Some(502)), &policy, &request()),
        Verdict::Retry { .. }
    ));
    assert!(matches!(
        verdict(&failure(ErrorKind::Transient, None), &policy, &request()),
        Verdict::Retry { .. }
    ));
}

#[test]
fn status_429_and_529_switches() {
    let mut policy = RetryPolicy::codex_default();
    policy.status.retry_429 = false;
    assert_eq!(
        verdict(&failure(ErrorKind::RateLimited, Some(429)), &policy, &request()),
        Verdict::Surface
    );
    policy.status.retry_429 = true;
    policy.status.retry_529 = false;
    assert_eq!(
        verdict(&failure(ErrorKind::Overloaded, Some(529)), &policy, &request()),
        Verdict::Surface
    );
}

#[test]
fn repeated_overload_falls_back_or_ends_the_send() {
    let mut policy = RetryPolicy::codex_default();
    policy.overload = OverloadRule {
        fallback_after: Some(3),
        fallback_model: Some("other".into()),
        stop_after_repeated: true,
    };
    let overloaded = failure(ErrorKind::Overloaded, Some(529));
    let decider = StandardRetryDecider;
    let mut state = request();
    for _ in 0..2 {
        let decision =
            mixdog_core_api::domain::retry::RetryDecider::verdict(&decider, &overloaded, &state, &policy, MID);
        assert!(matches!(decision.verdict, Verdict::Retry { .. }));
        state = decision.next;
    }
    assert_eq!(
        verdict(&overloaded, &policy, &state),
        Verdict::Fallback {
            model: "other".into()
        }
    );
    // The same model cannot be its own fallback: the send ends instead.
    policy.overload.fallback_model = Some("m".into());
    assert_eq!(verdict(&overloaded, &policy, &state), Verdict::Exhausted);
    policy.overload.stop_after_repeated = false;
    assert!(matches!(
        verdict(&overloaded, &policy, &state),
        Verdict::Retry { .. }
    ));
}

#[test]
fn should_retry_header_decides_only_where_the_policy_says() {
    let mut policy = RetryPolicy::codex_default();
    let mut refused = failure(ErrorKind::Transient, Some(500));
    refused.should_retry = Some(false);
    assert_eq!(verdict(&refused, &policy, &request()), Verdict::Surface);

    let mut forced = failure(ErrorKind::Unknown, Some(500));
    forced.should_retry = Some(true);
    assert_eq!(verdict(&forced, &policy, &request()), Verdict::Surface);
    policy.honor_should_retry_true = true;
    assert!(matches!(
        verdict(&forced, &policy, &request()),
        Verdict::Retry { .. }
    ));
}

#[test]
fn client_abort_499_retries_only_when_the_policy_allows() {
    let mut policy = RetryPolicy::codex_default();
    let abort = failure(ErrorKind::InvalidRequest, Some(499));
    assert_eq!(verdict(&abort, &policy, &request()), Verdict::Surface);
    policy.status.retry_499 = true;
    assert!(matches!(
        verdict(&abort, &policy, &request()),
        Verdict::Retry { .. }
    ));
}

#[test]
fn status_cap_bounds_retries_of_that_status_only() {
    use mixdog_core_api::domain::retry::RetryDecider;
    let mut policy = RetryPolicy::codex_default();
    policy.status.caps = vec![(429, 1)];
    let limited = failure(ErrorKind::RateLimited, Some(429));
    let server = failure(ErrorKind::Transient, Some(503));
    let first = StandardRetryDecider.verdict(&limited, &request(), &policy, MID);
    assert!(matches!(first.verdict, Verdict::Retry { .. }));
    assert_eq!(first.next.count(None).retries, 1, "the row's count advances too");
    // A server error in between is not capped, and does not use the cap.
    let between = StandardRetryDecider.verdict(&server, &first.next, &policy, MID);
    assert!(matches!(between.verdict, Verdict::Retry { .. }));
    assert_eq!(
        verdict(&limited, &policy, &between.next),
        Verdict::Surface,
        "the second 429 stands"
    );
    assert!(matches!(
        verdict(&server, &policy, &between.next),
        Verdict::Retry { .. }
    ));
}

/// Consecutive 429s through the policy; how many were retried before one
/// surfaced.
fn retried_429s(policy: &RetryPolicy) -> usize {
    use mixdog_core_api::domain::retry::RetryDecider;
    let limited = failure(ErrorKind::RateLimited, Some(429));
    let mut state = request();
    for retried in 0..50 {
        let decision = StandardRetryDecider.verdict(&limited, &state, policy, MID);
        if !matches!(decision.verdict, Verdict::Retry { .. }) {
            return retried;
        }
        state = decision.next;
    }
    panic!("never surfaced");
}

#[test]
fn provider_profile_429_caps_hold() {
    use mixdog_ai::providers::compat::retry;
    assert_eq!(retried_429s(&retry::xai()), 1, "xai: one retry of a 429");
    assert_eq!(retried_429s(&retry::mimo()), 5, "mimo: five retries of a 429");
    // Without a cap the 429 runs to the row's own retry count.
    assert_eq!(retried_429s(&retry::deepseek()), 5);
}

#[test]
fn a_class_without_a_row_surfaces() {
    let mut policy = RetryPolicy::codex_default();
    policy.recovery = None;
    let state = RetryState::new(RetryClass::Recovery, "m");
    assert_eq!(
        verdict(&failure(ErrorKind::Transient, Some(503)), &policy, &state),
        Verdict::Surface
    );
}
