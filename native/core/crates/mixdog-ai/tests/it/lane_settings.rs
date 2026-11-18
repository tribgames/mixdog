//! The settings every provider admission lane opens with: no concurrency gate on normal traffic, a queue bound the
//! environment sets, and rate-limit cooldown only on Anthropic's lanes.

use mixdog_ai::admission::LaneKey;
use mixdog_ai::admission::provider_lane_settings;
use mixdog_ai::admission::queue_bound;
use mixdog_protocol::ProviderId;

fn lane(provider: &str) -> LaneKey {
    LaneKey::new(ProviderId::from(provider), "default")
}

#[test]
fn only_the_anthropic_lanes_cool_down_after_a_rate_limit() {
    let settings = provider_lane_settings(None);
    for provider in ["anthropic", "anthropic-oauth", "Anthropic"] {
        assert!(settings(&lane(provider)).adaptive, "{provider}");
    }
    for provider in ["openai", "openai-oauth", "google", "grok-oauth", "anthropic-proxy"] {
        assert!(!settings(&lane(provider)).adaptive, "{provider}");
    }
}

#[test]
fn normal_traffic_is_not_gated_by_a_concurrency_limit_or_an_unattended_lease() {
    let got = provider_lane_settings(None)(&lane("anthropic"));
    assert_eq!((got.concurrency, got.unattended_lease), (None, None));
}

#[test]
fn the_queue_bound_is_a_whole_number_from_one_up_and_defaults_to_1024() {
    assert_eq!(queue_bound(None), 1024);
    assert_eq!(queue_bound(Some("5")), 5);
    assert_eq!(queue_bound(Some(" 7 ")), 7, "white space around the number is ignored");
    assert_eq!(queue_bound(Some("5.9")), 5, "a fraction is floored");
    assert_eq!(queue_bound(Some("1e3")), 1000);
    for refused in ["0", "0.5", "-3", "", "abc", "NaN", "Infinity"] {
        assert_eq!(queue_bound(Some(refused)), 1024, "{refused:?}");
    }
}

#[test]
fn every_lane_gets_the_configured_queue_bound() {
    let settings = provider_lane_settings(Some("12"));
    assert_eq!(settings(&lane("openai")).max_queue, 12);
    assert_eq!(settings(&lane("anthropic-oauth")).max_queue, 12);
}
