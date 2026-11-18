//! Fast-mode capacity policy: a short server window is waited out at fast speed, a longer or absent one drops to
//! standard speed for a cooldown, and a billing refusal switches fast mode off for good.

use mixdog_ai::providers::anthropic::fast_mode::Capacity;
use mixdog_ai::providers::anthropic::fast_mode::CapacityError;
use mixdog_ai::providers::anthropic::fast_mode::FastMode;

const NOW: f64 = 1_000_000.0;
const OVERAGE: &str = "anthropic-ratelimit-unified-overage-disabled-reason";

fn failure<'a>(status: u16, message: &'a str, headers: &'a [(String, String)], retry_after_ms: Option<f64>) -> CapacityError<'a> {
    CapacityError { status, message, headers, retry_after_ms }
}

#[test]
fn a_request_that_was_not_fast_changes_nothing() {
    let policy = FastMode::new();
    assert_eq!(policy.note_capacity_error(&failure(429, "", &[], None), false, NOW), Capacity::Ignored);
    assert!(policy.available(NOW));
}

#[test]
fn only_capacity_statuses_start_a_cooldown() {
    let policy = FastMode::new();
    assert_eq!(policy.note_capacity_error(&failure(500, "boom", &[], None), true, NOW), Capacity::Ignored);
    assert!(policy.available(NOW));
}

#[test]
fn a_server_window_under_twenty_seconds_is_waited_out_at_fast_speed() {
    let policy = FastMode::new();
    let decision = policy.note_capacity_error(&failure(429, "", &[], Some(19_999.0)), true, NOW);
    assert_eq!(decision, Capacity::RetryFast);
    assert!(!decision.downgraded());
    assert!(policy.available(NOW), "no cooldown was started");
}

#[test]
fn a_longer_window_drops_to_standard_speed_for_at_least_ten_minutes() {
    let policy = FastMode::new();
    let decision = policy.note_capacity_error(&failure(429, "", &[], Some(20_000.0)), true, NOW);
    assert_eq!(decision, Capacity::Downgrade);
    assert!(decision.downgraded());
    assert_eq!(policy.cooldown_remaining_ms(NOW), 600_000.0, "a short window is stretched to the ten-minute floor");
    assert!(!policy.available(NOW + 599_999.0));
    assert!(policy.available(NOW + 600_000.0));
}

#[test]
fn a_window_longer_than_the_floor_is_honoured_and_a_missing_one_costs_thirty_minutes() {
    let long = FastMode::new();
    long.note_capacity_error(&failure(529, "", &[], Some(900_000.0)), true, NOW);
    assert_eq!(long.cooldown_remaining_ms(NOW), 900_000.0);
    let none = FastMode::new();
    none.note_capacity_error(&failure(429, "", &[], None), true, NOW);
    assert_eq!(none.cooldown_remaining_ms(NOW), 1_800_000.0);
}

#[test]
fn a_retry_after_header_is_the_window_when_no_explicit_one_is_given() {
    let headers = [("retry-after".to_owned(), "5".to_owned())];
    let policy = FastMode::new();
    assert_eq!(policy.note_capacity_error(&failure(429, "", &headers, None), true, NOW), Capacity::RetryFast);
}

#[test]
fn a_billing_refusal_turns_fast_mode_off_for_the_process_with_the_servers_reason() {
    let policy = FastMode::new();
    let headers = [(OVERAGE.to_owned(), "org_level_disabled".to_owned())];
    let decision = policy.note_capacity_error(&failure(429, "", &headers, Some(1.0)), true, NOW);
    assert_eq!(decision, Capacity::Disabled);
    assert!(decision.downgraded());
    assert_eq!(policy.disabled_reason().as_deref(), Some("org_level_disabled"));
    assert!(!policy.available(NOW + 1e12));
    assert!(policy.cooldown_remaining_ms(NOW).is_infinite());
    policy.clear();
    assert!(policy.available(NOW) && policy.disabled_reason().is_none(), "the manual re-enable lifts it");
}

#[test]
fn an_empty_wallet_reason_is_a_cooldown_not_a_permanent_switch_off() {
    for reason in ["out_of_credits", "org_level_disabled_until"] {
        let policy = FastMode::new();
        let headers = [(OVERAGE.to_owned(), reason.to_owned())];
        assert_eq!(policy.note_capacity_error(&failure(429, "", &headers, None), true, NOW), Capacity::Downgrade, "{reason}");
        assert!(policy.disabled_reason().is_none());
    }
}

#[test]
fn a_blank_reason_header_still_disables_and_a_not_enabled_account_is_named() {
    let policy = FastMode::new();
    let headers = [(OVERAGE.to_owned(), String::new())];
    assert_eq!(policy.note_capacity_error(&failure(429, "", &headers, None), true, NOW), Capacity::Disabled);
    assert_eq!(policy.disabled_reason().as_deref(), Some("overage_unavailable"));

    let account = FastMode::new();
    let decision = account.note_capacity_error(&failure(400, "Fast mode is not enabled for this organization", &[], None), true, NOW);
    assert_eq!(decision, Capacity::Disabled);
    assert_eq!(account.disabled_reason().as_deref(), Some("fast_mode_not_enabled"));
}
