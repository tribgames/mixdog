//! The compact marker's numbers against the goldens recorded from Node
//! (`fixtures/agent/record-compact-marker.mjs`).
//! Fixture loading reads files synchronously; tests are not lane code.
#![allow(clippy::disallowed_methods)]

use mixdog_agent::boundary::ContextReading;
use mixdog_protocol::JsonValue;

#[test]
fn the_displayed_before_count_equals_nodes_compact_display_before_tokens() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/agent/compact_marker/cases.json");
    let golden: JsonValue = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = golden["before"].as_array().unwrap();
    // The recorded cases include a reading above and below the pass's own pressure, and a stale one.
    assert!(cases.iter().any(|c| c["before"] != c["fallback"]) && cases.iter().any(|c| c["before"] == c["fallback"]));
    for case in cases {
        let reading = ContextReading { tokens: case["lastContextTokens"].as_u64(), stale_after_compact: case["stale"].as_bool().unwrap() };
        assert_eq!(reading.display_before(case["fallback"].as_u64().unwrap()), case["before"].as_u64().unwrap(), "{case}");
    }
}

#[test]
fn a_calls_usage_becomes_the_last_measured_context() {
    let mut reading = ContextReading::default();
    let usage = mixdog_core_api::domain::provider::Usage { input_tokens: 100, cache_read_tokens: 40, cache_write_tokens: 10, output_tokens: 5, ..Default::default() };
    // A usage's input already counts the cache, so it is the footprint as it stands.
    reading.measure(&usage);
    assert_eq!(reading, ContextReading { tokens: Some(100), stale_after_compact: false });
    // A call with no prompt leaves the window unknown until the next measured call.
    reading.measure(&Default::default());
    assert_eq!(reading, ContextReading { tokens: None, stale_after_compact: true });
    assert_eq!(reading.display_before(42), 42);
}
