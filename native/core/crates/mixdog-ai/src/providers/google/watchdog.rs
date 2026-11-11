//! The content timers of the Gemini-wire stream (`createRestStreamWatchdogs`, `gemini-rest-stream/watchdogs.mjs`): the
//! first-byte window, armed when the headers arrived and cleared by the first decoded payload, and the idle window,
//! armed with it (or only after the first payload, `idleAfterFirstChunk`) and re-armed by every read that decoded a
//! payload. Whichever ends first fails the read with its phase. Kept out of the provider sources the conformance check
//! scans for timers, which it names as the exception.

use std::future::Future;
use std::time::Duration;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;
use tokio::time::Instant;

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
    first_byte: Option<Instant>,
    idle: Option<Instant>,
}

impl Watchdogs {
    /// Armed now (`createRestStreamWatchdogs` and the consumer's first `resetIdle`).
    pub(crate) fn arm(watch: StreamWatch) -> Self {
        let now = Instant::now();
        let idle = if watch.idle_after_first_chunk { None } else { watch.idle.map(|w| now + w) };
        Self { first_byte: Some(now + watch.first_byte), idle, watch }
    }

    /// A payload was decoded: the first-byte window ends (`clearFirstByte`).
    pub(crate) fn payload(&mut self) {
        self.first_byte = None;
    }

    /// A read decoded at least one payload: the idle window starts again (`resetIdle`).
    pub(crate) fn reset_idle(&mut self) {
        self.idle = self.watch.idle.map(|w| Instant::now() + w);
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
            Some((deadline, phase)) => tokio::time::timeout_at(deadline, read).await.map_err(|_| phase),
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
