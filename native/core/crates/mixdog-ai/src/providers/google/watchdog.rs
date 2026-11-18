//! How an expired phase of a Gemini-wire attempt reads. The deadlines themselves are the model-exchange driver's
//! ([`crate::transport::model_driver`]); this classifies what it reports (`createRestStreamWatchdogs`,
//! `gemini-rest-stream/watchdogs.mjs`, `gemini.mjs:795-807`, `antigravity-transport.mjs:220-253`) and does the retry bookkeeping:
//! - head and first payload: the first-byte window, `${label} first byte timed out after <ms>ms`, phases `headers` and
//!   `first-chunk`, counted against the send by the attempt's gate when the route has one.
//! - first output: a payload came and no output followed; the stream's silence is bounded by the first-output window and reads
//!   as the idle stall of a stream that never produced.
//! - idle: output began and the next did not come, `${label} SSE idle timed out after <ms>ms`, phase `idle`.
//! - recovery: the non-streaming fallback outlived its generation total.
//!
//! The streams are `GeminiTimeoutError` `EGEMINITIMEOUT` (gemini-stream.mjs:30-35): transient; the retry stage names the first
//! chunk's `first_response_timeout` and the idle's `stalled` (provider-error-kind.mjs:769-781).

use mixdog_core_api::domain::provider::AttemptPhase;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;

use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::domain::provider::PhaseWindows;
use mixdog_core_api::domain::provider::SendIdentity;

use crate::providers::head_wait::FirstByteGate;
use crate::transport::model_driver::Expiry;
use crate::transport::model_driver::ModelCall;

/// The driver call of a Gemini-wire stream under explicit windows (`first_byte` for the head and the first payload, `idle`
/// once output began), for the replays of recorded streams: no gate, so nothing is counted against a send.
pub fn stream_call(identity: &SendIdentity, first_byte: Duration, idle: Option<Duration>, label: &'static str) -> ModelCall {
    let windows = PhaseWindows { head: Some(first_byte), payload: Some(first_byte), idle, ..PhaseWindows::default() };
    ModelCall::new(identity, windows, Arc::new(move |expiry, delivery, exposure| expired(label, None, expiry, delivery, exposure)))
}

/// The failure of `expiry` for a route whose stream is labelled `label`; a first-byte expiry is counted by `gate` (once: the
/// driver calls this once per expiry).
pub(crate) fn expired(label: &str, gate: Option<&FirstByteGate>, expiry: Expiry, delivery: DeliveryState, exposure: Exposure) -> ProviderError {
    // The head wait is the gate's own timer (`createTimeoutSignal(.., '<label> first byte')`): its label, not the stream's.
    if let (AttemptPhase::Head, Some(gate)) = (expiry.phase, gate) {
        return gate.expired(StreamTimeoutPhase::Headers, delivery, exposure);
    }
    let ms = expiry.window.as_millis();
    let (code, what, phase) = match expiry.phase {
        AttemptPhase::Connect | AttemptPhase::Head => ("EPROVIDERTIMEOUT", "first byte", Some(StreamTimeoutPhase::Headers)),
        AttemptPhase::Payload => ("EGEMINITIMEOUT", "first byte", Some(StreamTimeoutPhase::FirstChunk)),
        AttemptPhase::FirstOutput => ("EGEMINITIMEOUT", "first output", Some(StreamTimeoutPhase::Idle)),
        AttemptPhase::Idle | AttemptPhase::Retired => ("EGEMINITIMEOUT", "SSE idle", Some(StreamTimeoutPhase::Idle)),
        AttemptPhase::Recovery => ("EPROVIDERTIMEOUT", "non-streaming fallback", None),
    };
    let mut err = ProviderError::new(ErrorKind::Transient, delivery);
    err.code = Some(code.into());
    err.message = format!("{label} {what} timed out after {ms}ms");
    err.timed_out = true;
    err.timeout_phase = phase;
    err.exposure = exposure;
    match gate {
        Some(gate) => gate.counted(err),
        None => err,
    }
}