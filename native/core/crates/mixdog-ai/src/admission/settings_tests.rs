//! The lane settings against Node's scheduler (`fixtures/provider-lane-settings/golden.json`,
//! `record-provider-lane-settings.mjs`): which lanes are adaptive and the queue bound the environment sets.

use mixdog_protocol::ProviderId;
use serde_json::Value;

use super::settings::{provider_lane_settings, queue_bound};
use super::LaneKey;

const GOLDEN: &str = include_str!("../../../../fixtures/provider-lane-settings/golden.json");

#[test]
fn the_adaptive_lanes_are_the_ones_node_cools_down() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let settings = provider_lane_settings(None);
    for row in golden["adaptive"].as_array().unwrap() {
        let provider = row["provider"].as_str().unwrap();
        let got = settings(&LaneKey::new(ProviderId::from(provider), "default"));
        assert_eq!(got.adaptive, row["adaptive"].as_bool().unwrap(), "{provider:?}");
        assert_eq!((got.concurrency, got.unattended_lease), (None, None), "normal traffic is not gated: {provider:?}");
    }
}

#[test]
fn the_queue_bound_is_the_one_node_refuses_at() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let rows = golden["queue"].as_array().unwrap();
    assert_eq!(rows.len(), 11);
    for row in rows {
        // "provider admission queue full for p:default (maximum N)".
        let refusal = row["refusal"].as_str().unwrap();
        let bound: usize = refusal.rsplit_once("(maximum ").unwrap().1.trim_end_matches(')').parse().unwrap();
        assert_eq!(queue_bound(row["env"].as_str()), bound, "{}", row["env"]);
        let key = LaneKey::new(ProviderId::from("openai"), "default");
        assert_eq!(provider_lane_settings(row["env"].as_str())(&key).max_queue, bound);
    }
}
