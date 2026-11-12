//! The first-byte windows of the providers that state a first-response budget, and the budget itself
//! (`stall-policy.mjs` `firstByteWindowMs` / `providerFirstResponseBudget` / `firstBytePolicyBudget`): the longest one send
//! may wait for its response headers and its first output across the provider's whole retry ladder, which the agent
//! watchdog's first-response deadlines are floored above.

use std::time::Duration;

use mixdog_core_api::domain::provider::FirstResponseBudget;
use mixdog_core_api::domain::retry::Backoff;
use mixdog_core_api::domain::retry::RetrySchedule;

use crate::providers::google::cache::policy::resolve_timeout_ms;
use crate::providers::google::cache::policy::stall_windows_ms;
use mixdog_js::js_trim;
use mixdog_js::string_to_number;

/// `VERTEX_FLEX_FIRST_CHUNK_TIMEOUT_MS` (`vertex-ai.mjs:114`): a Flex request queues server-side and may sit silent
/// this long before its first chunk.
pub const VERTEX_FLEX_FIRST_CHUNK_MS: i64 = 570_000;

/// `antigravity-retry-policy.mjs` `DEFAULT_RETRY_BACKOFF_MS`: index n is the wait before attempt n, the first a duplicate.
const DEFAULT_ANTIGRAVITY_BACKOFF_MS: [i64; 4] = [1000, 1000, 2000, 4000];
/// `ANTIGRAVITY_CAPACITY_RETRIES + 1`: the default attempts of the same-host ladder.
const DEFAULT_ANTIGRAVITY_ATTEMPTS: u32 = 4;

/// What Node reads from the environment for the first-response budgets (`stall-policy.mjs` `STALL_TIMEOUT_S`,
/// `MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS`; `gemini-stream.mjs` `MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS`;
/// `antigravity-retry-policy.mjs` `MIXDOG_ANTIGRAVITY_*`), read once, with Node's defaults and bounds.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct FirstByteSettings {
    /// `PROVIDER_MAX_BEFORE_WARN_MS`: warn threshold less one 15 s tick (285 s at the defaults); no first-byte window is
    /// longer, so the provider times out before the watchdog warns.
    pub max_before_warn_ms: i64,
    /// `PROVIDER_FIRST_BYTE_TIMEOUT_MS`: the shared window of every provider that sets none of its own.
    pub provider_ms: i64,
    /// `GEMINI_FIRST_BYTE_TIMEOUT_MS`: the shared window (`PROVIDER_FIRST_BYTE_TIMEOUT_MS` unless its own variable is set).
    pub gemini_ms: i64,
    /// `ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS`: the Pro-class window.
    pub antigravity_pro_ms: i64,
    /// `MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS`: sends of the same-host ladder.
    pub antigravity_attempts: u32,
    /// `MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS`: index n is the wait before attempt n.
    pub antigravity_backoff_ms: Vec<i64>,
    /// `MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES`.
    pub antigravity_first_byte_retries: u32,
}

/// [`FirstByteSettings::process`]'s value once it has read the environment.
static AT_START: std::sync::Mutex<Option<FirstByteSettings>> = std::sync::Mutex::new(None);

impl Default for FirstByteSettings {
    fn default() -> Self {
        Self::from_env(|_| None)
    }
}

impl FirstByteSettings {
    /// The process environment as it was when this was first asked: Node reads every one of these variables once, as its
    /// modules load (`stall-policy.mjs`, `gemini-stream.mjs`, `antigravity-retry-policy.mjs`), so a later change of the
    /// environment moves no budget.
    pub fn process() -> Self {
        Self::once(&AT_START, |name| std::env::var(name).ok())
    }

    /// The settings `cell` holds, read from `get` by the first caller only.
    pub(crate) fn once(cell: &std::sync::Mutex<Option<Self>>, get: impl Fn(&str) -> Option<String>) -> Self {
        cell.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get_or_insert_with(|| Self::from_env(get)).clone()
    }

    /// The environment is read again by the next [`Self::process`], as a new process reads it.
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) fn reset_process() {
        *AT_START.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Self {
        let (_, max) = stall_windows_ms(&get);
        let provider = resolve_timeout_ms(&get, &["MIXDOG_PROVIDER_FIRST_BYTE_TIMEOUT_MS"], 60_000.0, 30_000.0, max);
        let gemini = resolve_timeout_ms(&get, &["MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS"], provider, 30_000.0, max);
        let pro = resolve_timeout_ms(&get, &["MIXDOG_ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS"], 300_000.0, 30_000.0, max);
        // `envInt`: unset, blank or not an integer is the fallback; otherwise clamped.
        let int = |name: &str, fallback: u32, min: u32, max: u32| {
            let Some(raw) = get(name).filter(|raw| !js_trim(raw).is_empty()) else { return fallback };
            let n = string_to_number(&raw);
            if n.is_finite() && n.fract() == 0.0 { n.clamp(f64::from(min), f64::from(max)) as u32 } else { fallback }
        };
        // `envBackoffMs`: every comma-separated step a non-negative integer, else the default.
        let backoff = get("MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS")
            .map(|raw| js_trim(&raw).to_owned())
            .filter(|raw| !raw.is_empty())
            .and_then(|raw| {
                raw.split(',')
                    .map(|step| {
                        let n = string_to_number(js_trim(step));
                        (n.is_finite() && n.fract() == 0.0 && n >= 0.0).then_some(n as i64)
                    })
                    .collect::<Option<Vec<i64>>>()
            })
            .unwrap_or_else(|| DEFAULT_ANTIGRAVITY_BACKOFF_MS.to_vec());
        Self {
            max_before_warn_ms: max as i64,
            provider_ms: provider as i64,
            gemini_ms: gemini as i64,
            antigravity_pro_ms: pro as i64,
            antigravity_attempts: int("MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS", DEFAULT_ANTIGRAVITY_ATTEMPTS, 1, 6),
            antigravity_backoff_ms: backoff,
            antigravity_first_byte_retries: int("MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES", 1, 0, 5),
        }
    }

    /// A compat profile's first-byte policy as Node states it: the window never longer than `PROVIDER_MAX_BEFORE_WARN_MS`,
    /// which also caps each doubled retry window.
    pub fn compat(&self, policy: FirstBytePolicy) -> FirstBytePolicy {
        FirstBytePolicy { timeout_ms: policy.timeout_ms.min(self.max_before_warn_ms), max_ms: self.max_before_warn_ms, ..policy }
    }

    /// `antigravityFirstBytePolicy` for a catalog `family`.
    pub fn antigravity_policy(&self, family: Option<&str>) -> FirstBytePolicy {
        let retries = Some(self.antigravity_first_byte_retries.min(self.antigravity_attempts - 1));
        match family {
            Some("gemini-pro") => FirstBytePolicy { timeout_ms: self.antigravity_pro_ms, max_ms: self.max_before_warn_ms, retries },
            Some("gemini-flash") => FirstBytePolicy { timeout_ms: self.gemini_ms, max_ms: self.max_before_warn_ms, retries },
            _ => FirstBytePolicy { timeout_ms: self.gemini_ms, max_ms: self.gemini_ms, retries: None },
        }
    }

    /// `antigravityFirstResponseBudget`: `providerFirstResponseBudget` over the same-host ladder's attempts and backoff steps.
    pub fn antigravity_budget(&self, policy: &FirstBytePolicy) -> FirstResponseBudget {
        let (mut transport_ms, mut semantic_ms) = (0, 0);
        for attempt in 0..self.antigravity_attempts {
            let backoff = if attempt == 0 { 0 } else { self.antigravity_backoff_ms[(attempt as usize).min(self.antigravity_backoff_ms.len() - 1)] };
            let window = policy.window_ms(attempt.min(policy.retries.unwrap_or(0)));
            transport_ms += backoff + window;
            semantic_ms += backoff + 2 * window;
        }
        FirstResponseBudget { transport_ms, semantic_ms }
    }
}

/// `VertexAIProvider.firstResponseBudget`: only a Flex route has one; Vertex never marks transport progress at the response
/// headers, so the transport deadline already covers the headers wait plus the first-chunk wait.
pub fn vertex_flex_budget() -> FirstResponseBudget {
    let ms = 2 * VERTEX_FLEX_FIRST_CHUNK_MS;
    FirstResponseBudget { transport_ms: ms, semantic_ms: ms }
}

/// A first-byte policy `{ timeoutMs, maxMs, retries }`: `timeout_ms` is the first attempt's window (headers, and again the
/// first chunk); each first-byte timeout doubles the next window up to `max_ms`, and `retries` caps how many of those
/// timeouts are retried. `None` leaves first-byte timeouts to the provider's ordinary ladder, every attempt on `timeout_ms`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FirstBytePolicy {
    pub timeout_ms: i64,
    pub max_ms: i64,
    pub retries: Option<u32>,
}

impl FirstBytePolicy {
    /// `firstByteWindowMs`: the window of an attempt after `timeouts` first-byte timeouts.
    fn window_ms(&self, timeouts: u32) -> i64 {
        match self.retries {
            None => self.timeout_ms,
            Some(_) => self.timeout_ms.saturating_mul(1_i64 << timeouts.min(40)).min(self.timeout_ms.max(self.max_ms)),
        }
    }
}

/// The wait before attempt `attempt` (0-based; the first never waits) on the schedule's ladder.
fn backoff_ms(backoff: &Backoff, attempt: u32) -> i64 {
    if attempt == 0 {
        return 0;
    }
    let wait = match backoff {
        Backoff::Ladder(steps) => steps.get((attempt as usize).min(steps.len()).wrapping_sub(1)).copied().unwrap_or(Duration::ZERO),
        Backoff::Exponential { base } => base.saturating_mul(1_u32 << (attempt - 1).min(30)),
    };
    wait.as_millis() as i64
}

/// `firstBytePolicyBudget`: `providerFirstResponseBudget` over the schedule's attempts. Drops and 5xx share the ladder with
/// first-byte timeouts, so every attempt is budgeted a full window: the timeouts the policy retries come first, then the
/// later attempts sit at the widest window. `transport_ms` covers the header stage, `semantic_ms` headers plus first chunk.
pub fn first_byte_budget(policy: &FirstBytePolicy, schedule: &RetrySchedule) -> FirstResponseBudget {
    let (mut transport_ms, mut semantic_ms) = (0, 0);
    for attempt in 0..=schedule.max_retries {
        let backoff = backoff_ms(&schedule.backoff, attempt);
        let window = policy.window_ms(attempt.min(policy.retries.unwrap_or(0)));
        transport_ms += backoff + window;
        semantic_ms += backoff + 2 * window;
    }
    FirstResponseBudget { transport_ms, semantic_ms }
}
