//! The compact marker: a call's usage becomes the last measured context.
#![allow(clippy::disallowed_methods)]

use mixdog_agent::boundary::ContextReading;

#[test]
fn a_calls_usage_becomes_the_last_measured_context() {
    let mut reading = ContextReading::default();
    let usage =
        mixdog_core_api::domain::provider::Usage { input_tokens: 100, cache_read_tokens: 40, cache_write_tokens: 10, output_tokens: 5, ..Default::default() };
    // An input that counts the cache is the footprint as it stands.
    reading.measure(&usage, false);
    assert_eq!(reading, ContextReading { tokens: Some(100), stale_after_compact: false });
    // An input that leaves the cache out (Anthropic's) has the reads and writes added back.
    reading.measure(&usage, true);
    assert_eq!(reading, ContextReading { tokens: Some(150), stale_after_compact: false });
    // A call with no prompt leaves the window unknown until the next measured call.
    reading.measure(&Default::default(), false);
    assert_eq!(reading, ContextReading { tokens: None, stale_after_compact: true });
    assert_eq!(reading.display_before(42), 42);
}
