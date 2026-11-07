//! The settings the process-wide provider admission lanes open with (`providers/admission-scheduler.mjs`
//! `ProviderAdmissionScheduler` / `createAdmissionLane`): no concurrency limit, a queue bound from
//! `MIXDOG_PROVIDER_ADMISSION_MAX_QUEUE` (default 1024), and rate-limit cooldown only on Anthropic's
//! lanes. One function, so a send and a cache warm (`AccountGate`) open the same lane the same way.

use std::sync::Arc;

use super::{LaneKey, LaneSettings};

/// `PROVIDER_ACCOUNT_MAX_QUEUE`.
const DEFAULT_QUEUE: usize = 1024;

/// `configuredQueueBound(undefined)`: the variable as a whole number of at least 1, else 1024.
pub fn queue_bound(configured: Option<&str>) -> usize {
    let Some(text) = configured else { return DEFAULT_QUEUE };
    let parsed = mixdog_js::string_to_number(text).floor();
    if parsed.is_finite() && parsed >= 1.0 { parsed as usize } else { DEFAULT_QUEUE }
}

/// `isAnthropicLane(key)`: the lane's provider, lower-cased, is Anthropic's API or OAuth one.
pub fn adaptive_lane(key: &LaneKey) -> bool {
    matches!(key.provider.as_str().to_lowercase().as_str(), "anthropic" | "anthropic-oauth")
}

/// The settings of the lane `key`. `max_queue` is `MIXDOG_PROVIDER_ADMISSION_MAX_QUEUE`, read once.
pub fn provider_lane_settings(max_queue: Option<&str>) -> Arc<dyn Fn(&LaneKey) -> LaneSettings + Send + Sync> {
    let max_queue = queue_bound(max_queue);
    Arc::new(move |key| LaneSettings { concurrency: None, max_queue, adaptive: adaptive_lane(key), unattended_lease: None })
}

/// The rule every lane opener uses: [`provider_lane_settings`] with the process environment, read once
/// (Node builds its scheduler once). A send, a cache warm, the model proxy and the hosted-search sender
/// open the same lane the same way.
pub fn process_lane_settings() -> &'static Arc<dyn Fn(&LaneKey) -> LaneSettings + Send + Sync> {
    static SETTINGS: std::sync::OnceLock<Arc<dyn Fn(&LaneKey) -> LaneSettings + Send + Sync>> = std::sync::OnceLock::new();
    SETTINGS.get_or_init(|| provider_lane_settings(std::env::var("MIXDOG_PROVIDER_ADMISSION_MAX_QUEUE").ok().as_deref()))
}