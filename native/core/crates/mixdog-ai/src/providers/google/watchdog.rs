//! The one content timer of the Gemini-wire stream: its first-byte watchdog (`createRestStreamWatchdogs`,
//! `gemini-rest-stream/watchdogs.mjs`), armed when the headers arrived and cleared by the first decoded payload. Kept
//! out of the provider sources the conformance check scans for timers, which it names as the exception.

use std::future::Future;
use std::time::Duration;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;

pub(crate) struct FirstByte {
    deadline: tokio::time::Instant,
    window: Duration,
    label: &'static str,
}

impl FirstByte {
    /// Armed now for `window`; `label` is the consumer's (`label`).
    pub(crate) fn arm(window: Duration, label: &'static str) -> Self {
        Self { deadline: tokio::time::Instant::now() + window, window, label }
    }

    /// `read` unless the window ends first (`None`).
    pub(crate) async fn read<T>(&self, read: impl Future<Output = T>) -> Option<T> {
        tokio::time::timeout_at(self.deadline, read).await.ok()
    }

    /// `geminiTimeoutError(`${label} first byte`, ms)` with `timeoutPhase: 'first-chunk'`.
    pub(crate) fn expired(&self, exposure: Exposure) -> ProviderError {
        let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
        err.code = Some("EGEMINITIMEOUT".into());
        err.message = format!("{} first byte timed out after {}ms", self.label, self.window.as_millis());
        err.timed_out = true;
        err.timeout_phase = Some(StreamTimeoutPhase::FirstChunk);
        err.exposure = exposure;
        err
    }
}
