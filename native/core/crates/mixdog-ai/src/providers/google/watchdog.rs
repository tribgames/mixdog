//! The content timers of the Gemini-wire stream (`createRestStreamWatchdogs`, `gemini-rest-stream/watchdogs.mjs`), both
//! on the runtime's clock ([`mixdog_rt::Deadline`]):
//! - first chunk: `firstByteTimeoutMs` (the caller's, else `GEMINI_FIRST_BYTE_TIMEOUT_MS`, gemini-stream.mjs:24,493),
//!   armed when the headers arrived (watchdogs.mjs:31), ended for good by the first decoded payload (`clearFirstByte`,
//!   gemini-stream.mjs:529-532); `${label} first byte timed out after <ms>ms`, phase `first-chunk` (watchdogs.mjs:31-37).
//! - idle: `PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS` (stall-policy.mjs:149, off with `MIXDOG_ENABLE_STREAM_WATCHDOG`,
//!   stall-policy.mjs:116), armed with it unless `idleAfterFirstChunk` (gemini-stream.mjs:557) and re-armed by every read
//!   that decoded a payload, never by bytes that decode none (a keep-alive line, a partial line; gemini-stream.mjs:586-591);
//!   `${label} SSE idle timed out after <ms>ms`, phase `idle` (watchdogs.mjs:25-29,53-61).
//!
//! Both are `GeminiTimeoutError` `EGEMINITIMEOUT` (gemini-stream.mjs:30-35): transient; the retry stage names the first
//! chunk's `first_response_timeout` and the idle's `stalled` (provider-error-kind.mjs:769-781). The stream's end stops
//! both (`watchdogs.stop()`, gemini-stream.mjs:613). Whichever ends first fails the read with its phase.

use std::future::Future;
use std::time::Duration;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;
use mixdog_rt::Deadline;

/// The windows of one consumer: `firstByteTimeoutMs`, the semantic idle window (`PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS`;
/// `None` when `MIXDOG_ENABLE_STREAM_WATCHDOG` turns it off), whether idle waits for the first payload, and the label
/// the timeouts name.
#[derive(Clone, Copy, Debug)]
pub struct StreamWatch {
    pub first_byte: Duration,
    pub idle: Option<Duration>,
    pub idle_after_first_chunk: bool,
    pub label: &'static str,
}

pub(crate) struct Watchdogs {
    watch: StreamWatch,
    /// `None` once a payload arrived.
    first_byte: Option<Deadline>,
    idle: Option<Deadline>,
}

impl Watchdogs {
    /// Armed now (`createRestStreamWatchdogs` and the consumer's first `resetIdle`).
    pub(crate) fn arm(watch: StreamWatch) -> Self {
        let idle = if watch.idle_after_first_chunk { None } else { watch.idle.map(Deadline::after) };
        Self { first_byte: Some(Deadline::after(watch.first_byte)), idle, watch }
    }

    /// A payload was decoded: the first-byte window ends (`clearFirstByte`).
    pub(crate) fn payload(&mut self) {
        self.first_byte = None;
    }

    /// A read decoded at least one payload: the idle window starts again (`resetIdle`).
    pub(crate) fn reset_idle(&mut self) {
        self.idle = self.watch.idle.map(Deadline::after);
    }

    /// `read`, or the phase whose window ended first (the first byte's on a tie: its timer was armed first).
    pub(crate) async fn read<T>(&self, read: impl Future<Output = T>) -> Result<T, StreamTimeoutPhase> {
        let next = match (self.first_byte, self.idle) {
            (Some(first), Some(idle)) if idle < first => Some((idle, StreamTimeoutPhase::Idle)),
            (Some(first), _) => Some((first, StreamTimeoutPhase::FirstChunk)),
            (None, Some(idle)) => Some((idle, StreamTimeoutPhase::Idle)),
            (None, None) => None,
        };
        match next {
            Some((deadline, phase)) => deadline.bound(read).await.ok_or(phase),
            None => Ok(read.await),
        }
    }

    /// `geminiTimeoutError(`${label} first byte`, firstByteTimeoutMs)` or `geminiTimeoutError(`${label} SSE idle`,
    /// PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS)`, with its `timeoutPhase`.
    pub(crate) fn expired(&self, phase: StreamTimeoutPhase, exposure: Exposure) -> ProviderError {
        let (what, window) = match phase {
            StreamTimeoutPhase::FirstChunk => ("first byte", self.watch.first_byte),
            StreamTimeoutPhase::Idle => ("SSE idle", self.watch.idle.expect("an idle window")),
        };
        let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
        err.code = Some("EGEMINITIMEOUT".into());
        err.message = format!("{} {what} timed out after {}ms", self.watch.label, window.as_millis());
        err.timed_out = true;
        err.timeout_phase = Some(phase);
        err.exposure = exposure;
        err
    }
}
