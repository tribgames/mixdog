//! The cache-warm send seam: a provider that can refresh its prompt cache with one tiny request
//! (`provider.sendCacheWarm`) offers it through [`ProviderAdapter::cache_warm`], so the warmer
//! reaches it through whatever wraps the registered adapter. The types a warm is gated, bounded and
//! reported by live here because the trait names them; the warmer (`mixdog-ai`) re-exports them.
//!
//! [`ProviderAdapter::cache_warm`]: super::provider::ProviderAdapter::cache_warm

use std::time::Duration;

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use super::provider::{ModelRequest, ProviderError};

/// What one warm reported, in the slots `updateTurnUsage` fills.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct WarmUsage {
    pub input: f64,
    pub output: f64,
    pub cached: f64,
    pub cache_write: f64,
    /// The 1-hour-TTL share of the writes, when the provider reported one.
    pub cache_write_1h: Option<f64>,
    /// `input + cached + cache write`, once a usage was reported.
    pub prompt_tokens: Option<f64>,
    /// A gateway's reported cost.
    pub cost_usd: Option<f64>,
}

/// A warm that ended in failure: the error's text, the provider's classified error when the wire
/// carried one (its status and type reach the lane and roster as a send's would) and the usage
/// reported before it.
#[derive(Clone, PartialEq, Debug)]
pub struct WarmFailure {
    pub message: String,
    pub error: Option<ProviderError>,
    pub usage: Option<WarmUsage>,
}

impl WarmFailure {
    pub fn new(message: impl Into<String>) -> Self {
        Self { message: message.into(), error: None, usage: None }
    }
}

/// What a warm goes to: the provider and roster account holding the entry (empty for a provider
/// without a roster), the model, and the session asking (for its quota-resume pause).
#[derive(Clone, PartialEq, Debug, Default)]
pub struct GateTarget {
    pub provider: String,
    pub account_id: String,
    pub model: String,
    pub session_id: String,
}

#[async_trait]
pub trait WarmGate: Send + Sync {
    /// `cacheWarmAccountBlock`: why a warm may not be sent now, or `None`.
    async fn block(&self, target: &GateTarget) -> Option<String>;
    /// `recordCacheWarmRefusal`: feeds a warm's refusal into the shared state a send's would
    /// reach. A warm the caller aborted is no refusal. An `Err` is a failure to persist it.
    async fn record_refusal(&self, target: &GateTarget, error: &ProviderError, aborted: bool) -> Result<(), String>;
}

/// `PROVIDER_FIRST_BYTE_TIMEOUT_MS` and `PROVIDER_SSE_IDLE_TIMEOUT_MS` as the stall policy
/// resolved them for the process.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Deadlines {
    pub first_byte: Duration,
    pub sse_idle: Duration,
}

impl Deadlines {
    /// The stall policy's defaults (no environment override).
    pub const DEFAULT: Self = Self { first_byte: Duration::from_millis(60_000), sse_idle: Duration::from_millis(120_000) };
}

/// What a warm is gated and bounded by.
#[derive(Clone, Copy)]
pub struct WarmContext<'a> {
    pub gate: &'a dyn WarmGate,
    pub target: &'a GateTarget,
    pub deadlines: Deadlines,
    /// Hears a failure to persist the warm's refusal.
    pub report: &'a (dyn Fn(&str) + Send + Sync),
}

/// `cacheWarmSend(request)`: the request a warm makes of the real one, the same messages, model,
/// tools and options with the output capped at one token (`maxOutputTokensOverride: 1`). Every
/// provider's warm is built through this, so no path can forget the cap.
pub fn cache_warm_request(request: &ModelRequest) -> ModelRequest {
    let mut warm = request.clone();
    warm.options.max_output_tokens_override = Some(1);
    warm
}

/// `provider.sendCacheWarm`: one POST of the request the provider would build, plain (no retry,
/// fallback or rotation), the stream cut once the usage is known. The account gate may skip it.
#[async_trait]
pub trait CacheWarmSend: Send + Sync {
    /// Warms with `request` (the real request; the provider caps it with [`cache_warm_request`]).
    /// `on_usage` hears the usage as it arrives, so a warm that fails after the provider accepted
    /// it is still accounted.
    async fn send_cache_warm(
        &self,
        request: &ModelRequest,
        ctx: &WarmContext<'_>,
        cancel: &CancellationToken,
        on_usage: &mut (dyn for<'u> FnMut(&'u WarmUsage) + Send),
    ) -> Result<WarmUsage, WarmFailure>;
}
