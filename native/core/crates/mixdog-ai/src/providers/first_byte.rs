//! The first-byte windows of the providers that state a first-response budget, and the budget itself
//! (`stall-policy.mjs` `firstByteWindowMs` / `providerFirstResponseBudget` / `firstBytePolicyBudget`): the longest one send
//! may wait for its response headers and its first output across the provider's whole retry ladder, which the agent
//! watchdog's first-response deadlines are floored above.

use mixdog_core_api::domain::provider::FirstResponseBudget;
use mixdog_core_api::domain::retry::Jitter;

use crate::providers::google::cache::policy::resolve_timeout_ms;
use crate::providers::google::cache::policy::retry_jitter_ratio;
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
#[derive(Clone, PartialEq, Debug)]
pub struct FirstByteSettings {
    /// `PROVIDER_MAX_BEFORE_WARN_MS`: warn threshold less one 15 s tick (285 s at the defaults); no first-byte window is
    /// longer, so the provider times out before the watchdog warns.
    pub max_before_warn_ms: i64,
    /// `PROVIDER_FIRST_BYTE_TIMEOUT_MS`: the shared window of every provider that sets none of its own.
    pub provider_ms: i64,
    /// `GEMINI_FIRST_BYTE_TIMEOUT_MS`: the shared window (`PROVIDER_FIRST_BYTE_TIMEOUT_MS` unless its own variable is set), which
    /// an Antigravity model without a Gemini family keeps.
    pub gemini_ms: i64,
    /// The first-byte window of every Gemini route (the Gemini API, Antigravity Flash, Vertex AI): the long one,
    /// `MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS`, else 300 s held to the ceiling (285 s at the defaults), the same as Antigravity
    /// Pro's. A model that is slow to answer is waited for, not cut at the shared 60 s.
    pub gemini_long_ms: i64,
    /// `ANTIGRAVITY_FIRST_BYTE_TIMEOUT_MS`: the Pro-class window.
    pub antigravity_pro_ms: i64,
    /// `MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS`: sends of the same-host ladder.
    pub antigravity_attempts: u32,
    /// `MIXDOG_ANTIGRAVITY_RETRY_BACKOFF_MS`: index n is the wait before attempt n.
    pub antigravity_backoff_ms: Vec<i64>,
    /// `MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES`.
    pub antigravity_first_byte_retries: u32,
    /// `PROVIDER_RETRY_JITTER_RATIO` (`MIXDOG_PROVIDER_RETRY_JITTER_RATIO`, default 0.2, at most 1): the backoff jitter of
    /// every retry schedule that names no ratio of its own ([`Self::default_jitter`]).
    pub retry_jitter_ratio: f64,
    /// `PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS`: the idle window of an OpenAI-compatible stream; `None` when
    /// `MIXDOG_ENABLE_STREAM_WATCHDOG` turns the idle watchdog off.
    pub semantic_idle_ms: Option<i64>,
    /// `PROVIDER_FIRST_OUTPUT_TIMEOUT_MS`: how long an OpenAI-compatible stream may wait for its first output, never shorter
    /// than [`Self::semantic_idle_ms`]; `None` with the watchdog off.
    pub first_output_ms: Option<i64>,
    /// `PROVIDER_GENERATE_TOTAL_TIMEOUT_MS`: the one bound of a non-streaming request over its head and its body together
    /// (285 s at the defaults, never shorter than the shared first-byte window): a generation answers only when it is done.
    pub generate_total_ms: i64,
}

/// [`FirstByteSettings::process`]'s value once it has read the environment.
static AT_START: std::sync::Mutex<Option<FirstByteSettings>> = std::sync::Mutex::new(None);

impl Default for FirstByteSettings {
    fn default() -> Self {
        Self::from_env(|_| None)
    }
}

/// `VertexAIProvider.firstResponseBudget`: only a Flex route has one; Vertex never marks transport progress at the response
/// headers, so the transport deadline already covers the headers wait plus the first-chunk wait.
pub fn vertex_flex_budget() -> FirstResponseBudget {
    vertex_budget(VERTEX_FLEX_FIRST_CHUNK_MS, VERTEX_FLEX_FIRST_CHUNK_MS)
}

/// The head wait of a Vertex AI send that bounds none of its own: the transport bound of a model response (`MODEL_STREAM_FETCH`).
pub const VERTEX_HEAD_BOUND_MS: i64 = 600_000;

/// The budget of a Vertex AI send that waits up to `head_ms` for its head and `chunk_ms` for its first chunk: the head is not
/// marked, so the transport deadline covers both waits.
pub fn vertex_budget(head_ms: i64, chunk_ms: i64) -> FirstResponseBudget {
    let ms = head_ms + chunk_ms;
    FirstResponseBudget { transport_ms: ms, semantic_ms: ms }
}

/// A first-byte policy `{ timeoutMs, maxMs, retries }`: `timeout_ms` is the first attempt's window (headers, and again the
/// first chunk); each first-byte timeout doubles the next window up to `max_ms`, and `retries` caps how many of those
/// timeouts are retried. `None` leaves first-byte timeouts to the provider's ordinary ladder, every attempt on `timeout_ms`.
/// With the long window at the ceiling (the Gemini routes' default) the doubling has nowhere to go; it still widens a window
/// a user lowered with an environment variable.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FirstBytePolicy {
    pub timeout_ms: i64,
    pub max_ms: i64,
    pub retries: Option<u32>,
}

impl FirstBytePolicy {
    /// `firstByteWindowMs`: the window of an attempt after `timeouts` first-byte timeouts.
    pub(crate) fn window_ms(&self, timeouts: u32) -> i64 {
        match self.retries {
            None => self.timeout_ms,
            Some(_) => self.timeout_ms.saturating_mul(1_i64 << timeouts.min(40)).min(self.timeout_ms.max(self.max_ms)),
        }
    }
}

/// What an adapter that declares a first-byte window states to the watchdog: the window of each of the attempt's response phases,
/// never a sum. `transport_ms` is the head wait, `semantic_ms` the first-protocol-payload wait that follows the head (the same
/// window applied again); the watchdog counts each from the boundary that entered it, with a tick of slack above, and restarts
/// with every attempt, so nothing is added up over retries or back-offs. A window widened by the policy's retries is the widest
/// an attempt may wait.
pub fn attempt_budget(policy: &FirstBytePolicy) -> FirstResponseBudget {
    let window = policy.window_ms(policy.retries.unwrap_or(0));
    FirstResponseBudget { transport_ms: window, semantic_ms: window }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn jitter_of(raw: Option<&str>) -> f64 {
        retry_jitter_ratio(&|name| (name == "MIXDOG_PROVIDER_RETRY_JITTER_RATIO").then(|| raw.map(str::to_owned)).flatten())
    }

    #[test]
    fn the_retry_jitter_ratio_is_the_one_node_resolves() {
        // Unset or not a number is the 0.2 default; an empty string is `Number("")`, 0; the ratio is capped at 1.
        assert_eq!(jitter_of(None), 0.2);
        assert_eq!(jitter_of(Some("abc")), 0.2);
        assert_eq!(jitter_of(Some("-0.1")), 0.2);
        assert_eq!(jitter_of(Some("")), 0.0);
        assert_eq!(jitter_of(Some("0")), 0.0);
        assert_eq!(jitter_of(Some("0.45")), 0.45);
        assert_eq!(jitter_of(Some("7")), 1.0);
    }

    #[test]
    fn the_settings_carry_the_retry_jitter_ratio() {
        let settings = FirstByteSettings::from_env(|name| (name == "MIXDOG_PROVIDER_RETRY_JITTER_RATIO").then(|| "0.6".to_owned()));
        assert_eq!(settings.jitter(), Jitter::symmetric(0.6));
        assert_eq!(FirstByteSettings::from_env(|_| None).jitter(), Jitter::symmetric(0.2));
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
        let gemini_long = resolve_timeout_ms(&get, &["MIXDOG_GEMINI_FIRST_BYTE_TIMEOUT_MS"], 300_000.0, 30_000.0, max);
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
            gemini_long_ms: gemini_long as i64,
            antigravity_pro_ms: pro as i64,
            antigravity_attempts: int("MIXDOG_ANTIGRAVITY_RETRY_MAX_ATTEMPTS", DEFAULT_ANTIGRAVITY_ATTEMPTS, 1, 6),
            antigravity_backoff_ms: backoff,
            antigravity_first_byte_retries: int("MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES", 1, 0, 5),
            retry_jitter_ratio: retry_jitter_ratio(&get),
            semantic_idle_ms: crate::providers::google::cache::policy::semantic_idle_ms(&get).map(|ms| ms as i64),
            generate_total_ms: resolve_timeout_ms(&get, &["MIXDOG_PROVIDER_GENERATE_TOTAL_TIMEOUT_MS"], max, provider, max) as i64,
            first_output_ms: crate::providers::google::cache::policy::semantic_idle_ms(&get)
                .map(|idle| crate::providers::google::cache::policy::first_output_ms(&get, Some(idle)) as i64),
        }
    }

    /// The symmetric jitter of a schedule that states no ratio (`withRetry`'s `retryJitterRatio ?? PROVIDER_RETRY_JITTER_RATIO`),
    /// over the process environment as it was when it was first read.
    pub(crate) fn default_jitter() -> Jitter {
        Self::process().jitter()
    }

    /// The symmetric jitter of these settings' [`Self::retry_jitter_ratio`].
    pub(crate) fn jitter(&self) -> Jitter {
        Jitter::symmetric(self.retry_jitter_ratio)
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
            Some("gemini-flash") => self.gemini_policy(),
            _ => FirstBytePolicy { timeout_ms: self.gemini_ms, max_ms: self.gemini_ms, retries: None },
        }
    }

    /// The first-byte policy of every Gemini route that has one (the Gemini API, an Antigravity Flash model): the one long
    /// window, and Antigravity Pro's retry count (`antigravity-retry-policy.mjs:76`, `:96-124`): the first attempt and
    /// `MIXDOG_ANTIGRAVITY_FIRST_BYTE_RETRIES` (one) retry, headers and first-chunk timeouts counted together.
    pub fn gemini_policy(&self) -> FirstBytePolicy {
        let retries = Some(self.antigravity_first_byte_retries.min(self.antigravity_attempts - 1));
        FirstBytePolicy { timeout_ms: self.gemini_long_ms, max_ms: self.max_before_warn_ms, retries }
    }
}
