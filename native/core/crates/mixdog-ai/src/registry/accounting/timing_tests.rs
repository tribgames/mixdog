//! The first-output time a row records: the stream's time less the generation window, for providers whose window starts
//! with generation, and only when the window is a possible one.

use super::first_output_ms;

#[test]
fn a_timed_provider_records_when_its_first_output_came() {
    for provider in ["anthropic", "anthropic-oauth", "openai", "openai-oauth", "mixdog-local"] {
        assert_eq!(first_output_ms(provider, Some(400.0), 1_000.0), Some(600.0), "{provider}");
    }
}

#[test]
fn a_window_of_zero_or_the_whole_stream_is_inside_the_bound() {
    assert_eq!(first_output_ms("openai", Some(0.0), 1_000.0), Some(1_000.0), "no generation time: the output came at the end");
    assert_eq!(first_output_ms("openai", Some(1_000.0), 1_000.0), Some(0.0), "all of the stream was generation");
}

#[test]
fn a_window_outside_zero_to_the_stream_time_is_no_reading() {
    assert_eq!(first_output_ms("openai", Some(-1.0), 1_000.0), None, "negative");
    assert_eq!(first_output_ms("openai", Some(1_000.5), 1_000.0), None, "longer than the stream");
    assert_eq!(first_output_ms("openai", Some(f64::NAN), 1_000.0), None);
    assert_eq!(first_output_ms("openai", Some(f64::INFINITY), 1_000.0), None);
    assert_eq!(first_output_ms("openai", None, 1_000.0), None, "the provider reported no window");
}

#[test]
fn a_provider_that_may_reason_before_streaming_records_no_first_output() {
    for provider in ["google", "xai", "grok-oauth", "cursor-api", "devin-oauth"] {
        assert_eq!(first_output_ms(provider, Some(400.0), 1_000.0), None, "{provider}");
    }
}