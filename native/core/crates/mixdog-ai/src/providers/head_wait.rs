//! The first-byte window of a request whose head has not come (`createTimeoutSignal(attemptSignal,
//! windowMs, '<label> first byte')` around the fetch, `gemini.mjs:795-807`, `antigravity-transport.mjs:220-253`;
//! `perAttemptTimeoutMs` of `openai-compat-chat-send.mjs:174-181`), and what the send's first-byte timeouts cost
//! (`noteAttemptFailure`, `antigravity-transport.mjs:285-297`; `withCompatRetryProfile`, `openai-compat-retry-profile.mjs`).
//!
//! The timeout is one `ProviderError` of the stream timeout rule, in its `Headers` phase: transient, so the provider's own
//! ladder retries it; a first-byte timeout past the policy's retries ends that ladder.

use std::time::Duration;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::SendIdentity;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;

use crate::providers::first_byte::FirstBytePolicy;

/// One attempt's first-byte window and the send it counts against.
#[derive(Clone, Debug)]
pub(crate) struct FirstByteGate {
    window: Duration,
    label: String,
    identity: SendIdentity,
    /// How many first-byte timeouts the policy retries (`None`: every one, on the provider's ordinary ladder).
    retries: Option<u32>,
}

impl FirstByteGate {
    /// The gate of the send's next attempt under `policy`: the window of an attempt after the timeouts the send has met.
    pub(crate) fn of(policy: &FirstBytePolicy, identity: &SendIdentity, label: impl Into<String>) -> Self {
        let window = policy.window_ms(identity.first_byte_timeouts().count);
        Self { window: Duration::from_millis(u64::try_from(window).unwrap_or(0)), label: label.into(), identity: identity.clone(), retries: policy.retries }
    }

    pub(crate) fn window(&self) -> Duration {
        self.window
    }

    /// The window ended in `phase` (`Headers`, or `FirstChunk` for the first payload): `providerTimeoutError(label,
    /// timeoutMs)`, counted against the send.
    pub(crate) fn expired(&self, phase: StreamTimeoutPhase, delivery: DeliveryState, exposure: Exposure) -> ProviderError {
        let mut err = ProviderError::new(ErrorKind::Transient, delivery);
        err.code = Some("EPROVIDERTIMEOUT".into());
        err.message = format!("{} first byte timed out after {}ms", self.label, self.window.as_millis());
        err.timed_out = true;
        err.timeout_phase = Some(phase);
        err.exposure = exposure;
        self.counted(err)
    }

    /// An attempt of the send failed with `err`: a first-byte timeout (headers or first chunk) is counted, and one past the
    /// policy's retries is final (`markProviderRecoveryExhausted(..., { terminal: true })`).
    pub(crate) fn counted(&self, mut err: ProviderError) -> ProviderError {
        if !err.timeout_phase.is_some_and(StreamTimeoutPhase::is_first_byte) {
            return err;
        }
        let met = self.identity.note_first_byte_timeout(u64::try_from(self.window.as_millis()).unwrap_or(u64::MAX));
        if self.retries.is_some_and(|retries| met.count > retries) {
            err.recovery_exhausted = true;
            err.recovery_terminal = true;
            err.should_retry = Some(false);
        }
        err
    }
}
