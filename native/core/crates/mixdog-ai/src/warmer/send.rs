//! One warm on a provider (`providers/anthropic-cache-warm.mjs` `sendAnthropicCacheWarm`): the
//! account gate, then the provider's single POST of its built body, then the stream. No retry,
//! fallback, re-send, wait or account rotation. The request is bounded by the providers' own
//! watchdogs: the first-byte deadline from the start until the usage arrives, then the SSE idle
//! deadline between chunks. A refusal reaches the shared rate-limit and roster state; every exit
//! drops the stream.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures::future::BoxFuture;
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, TransportFault};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::chain::{WarmRequest, WarmTarget};
use super::gate::GateTarget;
use super::stream::{WarmFailure, WarmUsage, read_cache_warm_stream};
use crate::transport::link::{BodyStream, HttpResponse};

pub use mixdog_core_api::domain::cache_warm::{Deadlines, WarmContext};

/// What the gate is asked about a warm of `request` on `target`: the roster account that holds the
/// entry, the provider, the model and the session asking.
pub fn gate_target(request: &dyn WarmRequest, target: &WarmTarget) -> GateTarget {
    GateTarget {
        provider: request.provider_name().to_owned(),
        account_id: target.account_id.clone(),
        model: request.model().to_owned(),
        session_id: request.session_id().to_owned(),
    }
}

/// The deadlines of the process: `PROVIDER_FIRST_BYTE_TIMEOUT_MS` and `PROVIDER_SSE_IDLE_TIMEOUT_MS`
/// as `stall-policy.mjs` resolves them from the environment `get` reads.
pub fn deadlines_from_env(get: impl Fn(&str) -> Option<String>) -> Deadlines {
    let (first_byte_ms, sse_idle_ms) = crate::providers::google::cache::policy::stall_deadlines_ms(get);
    Deadlines { first_byte: Duration::from_millis(first_byte_ms as u64), sse_idle: Duration::from_millis(sse_idle_ms as u64) }
}

/// The one POST of a warm: the provider's built request, sent plain. A status that is not a
/// success is the provider's error.
pub type Post<'a> = Box<dyn FnOnce() -> BoxFuture<'a, Result<HttpResponse, ProviderError>> + Send + 'a>;

/// `watchdog(controller)`: one abort deadline, re-armed by the stream.
struct Watchdog {
    state: Mutex<(Instant, Duration, &'static str)>,
}

impl Watchdog {
    fn arm(&self, limit: Duration, what: &'static str) {
        *self.state.lock().unwrap_or_else(PoisonError::into_inner) = (Instant::now(), limit, what);
    }

    fn deadline(&self) -> Instant {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.0 + state.1
    }

    /// `cache warm <what> timed out after <ms>ms`.
    fn expired_text(&self) -> String {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        format!("cache warm {} timed out after {}ms", state.2, state.1.as_millis())
    }
}

/// The body under the watchdog and the caller's cancel; what ended it is kept for the failure's
/// text.
struct Guarded {
    inner: Box<dyn BodyStream>,
    watchdog: Arc<Watchdog>,
    cancel: CancellationToken,
    ended: Arc<Mutex<Option<String>>>,
}

#[async_trait]
impl BodyStream for Guarded {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        let deadline = self.watchdog.deadline();
        let end = tokio::select! {
            biased;
            chunk = self.inner.next() => return chunk,
            () = tokio::time::sleep_until(deadline) => self.watchdog.expired_text(),
            () = self.cancel.cancelled() => ABORTED.to_owned(),
        };
        *self.ended.lock().unwrap_or_else(PoisonError::into_inner) = Some(end);
        Some(Err(TransportFault::Closed))
    }
}

/// An aborted `fetch` rejects with this (the signal's default reason).
const ABORTED: &str = "This operation was aborted";

fn failure_of(error: &ProviderError) -> WarmFailure {
    WarmFailure { message: error.message.clone(), error: Some(error.clone()), usage: None }
}

fn error_of(message: &str) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::Accepted);
    error.message = message.to_owned();
    error
}

/// One warm of `target`. `on_usage` hears the usage as it arrives, so a warm that fails or is
/// aborted after the provider accepted it is still accounted; `report` hears a failure to persist
/// the warm's refusal (the warm's own error is what the caller gets). A warm the gate skips sends
/// nothing.
pub async fn send_cache_warm(
    ctx: &WarmContext<'_>,
    cancel: &CancellationToken,
    post: Post<'_>,
    on_usage: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
) -> Result<WarmUsage, WarmFailure> {
    let WarmContext { gate, target, deadlines, report } = *ctx;
    if let Some(reason) = gate.block(target).await {
        return Err(WarmFailure::new(format!("cache warm skipped: {reason}")));
    }
    let watchdog = Arc::new(Watchdog { state: Mutex::new((Instant::now(), deadlines.first_byte, "first byte")) });
    let ended = Arc::new(Mutex::new(None));
    let (failure, error) = match run(&watchdog, &ended, cancel, deadlines, post, on_usage).await {
        Ok(usage) => return Ok(usage),
        Err(failed) => failed,
    };
    // The warm's own error is what the caller needs; a failure to persist the refusal is reported.
    if let Err(message) = gate.record_refusal(target, &error, cancel.is_cancelled()).await {
        report(&format!("[anthropic-cache-warm] refusal record failed: {message}"));
    }
    Err(failure)
}

type Failed = (WarmFailure, ProviderError);

async fn run(
    watchdog: &Arc<Watchdog>,
    ended: &Arc<Mutex<Option<String>>>,
    cancel: &CancellationToken,
    deadlines: Deadlines,
    post: Post<'_>,
    on_usage: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
) -> Result<WarmUsage, Failed> {
    let response = tokio::select! {
        biased;
        response = post() => response.map_err(|e| (failure_of(&e), e))?,
        () = tokio::time::sleep_until(watchdog.deadline()) => {
            let text = watchdog.expired_text();
            return Err((WarmFailure::new(text.clone()), error_of(&text)));
        }
        () = cancel.cancelled() => return Err((WarmFailure::new(ABORTED), error_of(ABORTED))),
    };
    let mut body = Guarded { inner: response.body, watchdog: watchdog.clone(), cancel: cancel.clone(), ended: ended.clone() };
    let rearm = watchdog.clone();
    let sse_idle = deadlines.sse_idle;
    let result = read_cache_warm_stream(&mut body, on_usage, &mut |reported| {
        if reported {
            rearm.arm(sse_idle, "stream");
        }
    })
    .await;
    result.map_err(|mut failure| {
        if let Some(text) = ended.lock().unwrap_or_else(PoisonError::into_inner).take() {
            failure.message = text;
        }
        let error = failure.error.clone().unwrap_or_else(|| error_of(&failure.message));
        (failure, error)
    })
}
