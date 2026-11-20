//! How the compaction policy turns a session's settings into its numbers: the boundary, the trigger
//! (boundary minus a buffer, the buffer capped at a quarter of the boundary), the reserve, the target and
//! the budget a summary is asked to fit. Each table row names the rule it exercises.

use mixdog_agent::boundary::CompactPolicy;
use mixdog_agent::boundary::CompactSettings;

/// A delegated agent's session over `window` tokens with exact token counts.
fn agent(window: u64) -> CompactSettings {
    CompactSettings { auto: true, agent_owner: true, context_window: Some(window), token_calibration: 1.0, ..CompactSettings::default() }
}

fn main_session(window: u64) -> CompactSettings {
    CompactSettings { agent_owner: false, ..agent(window) }
}

fn policy(settings: &CompactSettings) -> CompactPolicy {
    CompactPolicy::resolve(settings).expect("a policy")
}

#[test]
fn there_is_no_policy_when_automatic_compaction_is_off_or_no_boundary_is_known() {
    assert!(CompactPolicy::resolve(&CompactSettings { auto: false, ..agent(100_000) }).is_none());
    assert!(CompactPolicy::resolve(&CompactSettings { auto: true, ..CompactSettings::default() }).is_none());
    assert!(
        CompactPolicy::resolve(&CompactSettings { context_window: Some(0), explicit_boundary: Some(0), auto_limit: Some(0), ..agent(0) }).is_none(),
        "zero is not a size"
    );
}

#[test]
fn the_boundary_is_the_explicit_one_capped_by_the_window_else_either_else_the_explicit_limit() {
    let rows: [(&str, Option<u64>, Option<u64>, Option<u64>, u64); 8] = [
        ("window alone", Some(100_000), None, None, 100_000),
        ("explicit below the window", Some(100_000), Some(60_000), None, 60_000),
        ("explicit above the window", Some(100_000), Some(150_000), None, 100_000),
        ("explicit equal to the window", Some(100_000), Some(100_000), None, 100_000),
        ("explicit without a window", None, Some(70_000), None, 70_000),
        ("window zero reads as none", Some(0), Some(70_000), None, 70_000),
        ("only an explicit limit", None, None, Some(50_000), 50_000),
        ("window beats the limit", Some(100_000), None, Some(50_000), 100_000),
    ];
    for (label, window, explicit, limit, want) in rows {
        let settings = CompactSettings { context_window: window, explicit_boundary: explicit, auto_limit: limit, ..agent(1) };
        assert_eq!(policy(&settings).boundary_tokens, want, "{label}");
    }
}

#[test]
fn the_trigger_is_the_boundary_minus_a_buffer_that_is_never_more_than_a_quarter_of_it() {
    // (label, buffer tokens, buffer ratio, expected trigger) over a 100,000-token boundary.
    let rows: [(&str, u64, f64, u64); 12] = [
        ("no buffer", 0, 0.0, 100_000),
        ("explicit tokens", 20_000, 0.0, 80_000),
        ("explicit tokens exactly at the cap", 25_000, 0.0, 75_000),
        ("explicit tokens one under the cap", 24_999, 0.0, 75_001),
        ("explicit tokens one over the cap", 25_001, 0.0, 75_000),
        ("explicit tokens far over the cap", 90_000, 0.0, 75_000),
        ("ratio", 0, 0.1, 90_000),
        ("ratio exactly at the cap", 0, 0.25, 75_000),
        ("ratio over the cap", 0, 0.26, 75_000),
        ("a negative ratio is no buffer", 0, -0.5, 100_000),
        ("tokens come before the ratio", 10_000, 0.2, 90_000),
        ("the buffer rounds down to whole tokens", 0, 0.123_456, 87_655),
    ];
    for (label, tokens, ratio, want) in rows {
        let settings = CompactSettings { buffer_tokens: tokens, buffer_ratio: ratio, ..agent(100_000) };
        assert_eq!(policy(&settings).trigger_tokens, want, "{label}");
    }
    // The cap follows a small boundary down: floor(10 / 4) = 2.
    assert_eq!(policy(&CompactSettings { buffer_tokens: 5, ..agent(10) }).trigger_tokens, 8);
    // A boundary of one token still triggers at one.
    assert_eq!(policy(&CompactSettings { buffer_tokens: 5, ..agent(1) }).trigger_tokens, 1);
}

#[test]
fn an_explicit_limit_below_the_boundary_is_the_trigger_whatever_the_buffer_says() {
    let with_limit = |limit: u64| CompactSettings { auto_limit: Some(limit), buffer_tokens: 20_000, ..agent(100_000) };
    assert_eq!(policy(&with_limit(60_000)).trigger_tokens, 60_000);
    assert_eq!(policy(&with_limit(99_999)).trigger_tokens, 99_999);
    assert_eq!(policy(&with_limit(100_000)).trigger_tokens, 80_000, "a limit that is not below the boundary is ignored");
    assert_eq!(policy(&with_limit(150_000)).trigger_tokens, 80_000);
    assert_eq!(policy(&CompactSettings { auto_limit: Some(0), ..with_limit(1) }).trigger_tokens, 80_000, "zero is no limit");
    // The same for a main session, which takes no margin over an explicit limit.
    assert_eq!(policy(&CompactSettings { agent_owner: false, target_tokens: Some(80_000), ..with_limit(60_000) }).trigger_tokens, 60_000);
}

#[test]
fn a_main_session_never_triggers_inside_the_target_it_just_compacted_to() {
    // Buffer 25,000 would trigger at 75,000, below a target of 80,000: the main session keeps a 1% gap over the target.
    let narrow = CompactSettings { buffer_tokens: 25_000, target_tokens: Some(80_000), ..main_session(100_000) };
    assert_eq!(policy(&narrow).trigger_tokens, 81_000);
    assert_eq!(policy(&CompactSettings { agent_owner: true, ..narrow.clone() }).trigger_tokens, 75_000, "a delegated agent keeps its established trigger");
    // The gap is 1% of the boundary, at most 1,024 tokens.
    let large = CompactSettings { buffer_tokens: 250_000, target_tokens: Some(900_000), ..main_session(1_000_000) };
    assert_eq!(policy(&large).trigger_tokens, 901_024);
    // Never above the boundary itself.
    let at_top = CompactSettings { buffer_tokens: 1, target_tokens: Some(100_000), ..main_session(100_000) };
    assert_eq!(policy(&at_top).trigger_tokens, 100_000);
}

#[test]
fn the_reserve_is_the_request_reserve_plus_the_operators_headroom_and_the_headroom_lowers_the_trigger() {
    let settings = CompactSettings { buffer_tokens: 20_000, request_reserve_tokens: 3_000, configured_reserve_tokens: 2_000, ..agent(100_000) };
    let p = policy(&settings);
    assert_eq!((p.reserve_tokens, p.request_reserve_tokens, p.configured_reserve_tokens), (5_000, 3_000, 2_000));
    assert_eq!(p.trigger_tokens, 78_000, "the headroom is taken off the trigger");
    assert!(!p.single_shot);
    // A reserve that fills the trigger leaves no room to compact twice.
    let at = policy(&CompactSettings { buffer_tokens: 20_000, request_reserve_tokens: 80_000, ..agent(100_000) });
    assert!(at.single_shot, "reserve equal to the trigger");
    let under = policy(&CompactSettings { buffer_tokens: 20_000, request_reserve_tokens: 79_999, ..agent(100_000) });
    assert!(!under.single_shot, "one token of room");
}

#[test]
fn the_target_is_a_quarter_of_the_boundary_but_never_under_the_floor_and_never_over_the_boundary() {
    let rows: [(&str, u64, Option<u64>, Option<f64>, Option<u64>, u64); 9] = [
        ("a quarter of the boundary", 100_000, None, None, None, 25_000),
        ("the floor holds a small boundary up", 10_000, None, None, None, 4_000),
        ("the floor never passes the boundary", 3_000, None, None, None, 3_000),
        ("explicit tokens", 100_000, Some(40_000), None, None, 40_000),
        ("explicit tokens over the boundary", 100_000, Some(500_000), None, None, 100_000),
        ("a ratio", 100_000, None, Some(0.5), None, 50_000),
        ("a ratio above one is a percent", 100_000, None, Some(40.0), None, 40_000),
        ("a ratio of zero is the default", 100_000, None, Some(0.0), None, 25_000),
        ("a larger floor wins over the share", 100_000, None, None, Some(30_000), 30_000),
    ];
    for (label, window, tokens, ratio, floor, want) in rows {
        let settings = CompactSettings { target_tokens: tokens, target_ratio: ratio, target_min_tokens: floor, ..agent(window) };
        assert_eq!(policy(&settings).target_tokens, want, "{label}");
    }
}

#[test]
fn the_summary_budget_is_the_target_in_raw_tokens_kept_clear_of_the_next_trigger() {
    let calibrated = |calibration: f64| CompactSettings { buffer_tokens: 20_000, token_calibration: calibration, ..agent(100_000) };
    assert_eq!(policy(&calibrated(1.0)).target_budget(), 25_000);
    assert_eq!(policy(&calibrated(1.25)).target_budget(), 20_000, "floor(25,000 / 1.25)");
    assert_eq!(policy(&calibrated(1.4)).target_budget(), 17_857);
    // The request reserve comes off the raw target and is added back for the budget.
    let reserved = CompactSettings { request_reserve_tokens: 3_000, ..calibrated(1.25) };
    assert_eq!(policy(&reserved).target_budget(), 20_000);
    // A target above the trigger is held one token under it.
    let high = CompactSettings { target_tokens: Some(90_000), ..calibrated(1.0) };
    assert_eq!(policy(&high).target_budget(), 79_999);
    // With no room for a second compaction the budget is just what the reserve leaves.
    let single = CompactSettings { request_reserve_tokens: 80_000, ..calibrated(1.0) };
    assert_eq!(policy(&single).target_budget(), 80_001);
}

#[test]
fn a_calibration_that_is_not_positive_reads_as_exact_counts() {
    for calibration in [0.0, -2.0] {
        let p = policy(&CompactSettings { token_calibration: calibration, ..agent(100_000) });
        assert_eq!(p.token_calibration, 1.0);
    }
    assert_eq!(policy(&CompactSettings { token_calibration: 1.5, ..agent(100_000) }).token_calibration, 1.5);
}
