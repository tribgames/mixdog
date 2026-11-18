//! The timer each lookup's exchange arms and the words its expiry reads as: a short probe under a timeout signal, a raw
//! fetch on the shared dispatcher with a long head wait, an update check under an abort.

use std::time::Duration;

use mixdog_ai::transport::ABORTED;
use mixdog_ai::transport::FETCH_FAILED;
use mixdog_ai::transport::Redirect;
use mixdog_ai::transport::SIGNAL_TIMED_OUT;
use mixdog_ai::transport::deadlines;

#[test]
fn the_vertex_metadata_probe_waits_one_second_and_a_miss_reads_as_the_timeout_signals_error() {
    let probe = deadlines::VERTEX_METADATA;
    assert_eq!(probe.liveness.head_deadline(), Some(Duration::from_secs(1)));
    assert_eq!(probe.surface.timeout_text(Duration::from_secs(1)).as_deref(), Some(SIGNAL_TIMED_OUT));
    assert_eq!(probe.redirect, Redirect::Follow);
}

#[test]
fn the_vertex_token_request_has_no_timer_of_its_own_only_the_dispatchers_and_a_miss_reads_as_fetch_failed() {
    let mint = deadlines::VERTEX_TOKEN;
    assert_eq!(mint.liveness.head_deadline(), Some(Duration::from_secs(600)), "the shared dispatcher's headers wait");
    assert_eq!(mint.surface.timeout_text(Duration::from_secs(600)).as_deref(), Some(FETCH_FAILED));
}

#[test]
fn an_update_check_gives_up_after_five_seconds_as_an_aborted_fetch() {
    let check = deadlines::UPDATE_CHECK;
    assert_eq!(check.liveness.head_deadline(), Some(Duration::from_secs(5)));
    assert_eq!(check.surface.timeout_text(Duration::from_secs(5)).as_deref(), Some(ABORTED));
}

#[test]
fn credential_requests_wait_thirty_seconds_and_a_catalog_read_ten() {
    for token in [deadlines::TOKEN_EXCHANGE, deadlines::TOKEN_OPENAI, deadlines::TOKEN_ANTHROPIC_REFRESH] {
        assert_eq!(token.liveness.head_deadline(), Some(Duration::from_secs(30)));
    }
    assert_eq!(deadlines::OPENAI_CATALOG.liveness.head_deadline(), Some(Duration::from_secs(10)));
    assert_eq!(deadlines::OPENAI_CATALOG.surface.timeout_text(Duration::from_secs(10)).as_deref(), Some(SIGNAL_TIMED_OUT));
    assert_eq!(deadlines::TOKEN_OPENAI.surface.timeout_text(Duration::from_secs(30)).as_deref(), Some(ABORTED));
    assert_eq!(deadlines::VOICE_INFERENCE.liveness.head_deadline(), None, "a local transcription is bounded by no timer");
}
