//! Fast-mode capacity policy of the Anthropic providers (`anthropic-fast-mode.mjs`).
//!
//! `speed: "fast"` rides a separate capacity pool. When it is exhausted the request comes back 429
//! or 529: a short server window is waited out at fast speed (the cache prefix survives), a longer
//! one drops to standard speed for a cooldown, and an "overage billing unavailable" header is
//! terminal for the process. The state is process-wide because the pool is per account, not per
//! session ([`process`]); [`FastMode`] is the state itself, so a test owns its own.

use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::SystemTime;

/// A Retry-After under this bound is short enough that waiting keeps fast mode worthwhile.
pub const SHORT_RETRY_THRESHOLD_MS: f64 = 20_000.0;
/// Cooldown floor: without it a 1 s window would flip fast mode on and off every turn.
pub const MIN_COOLDOWN_MS: f64 = 600_000.0;
/// Applied when the server gives no window at all.
pub const DEFAULT_COOLDOWN_MS: f64 = 1_800_000.0;
/// The server-declared reason header of a rejection caused by missing overage billing.
pub const OVERAGE_DISABLED_HEADER: &str = "anthropic-ratelimit-unified-overage-disabled-reason";
/// Reasons that mean the wallet is empty for now, not that overage can never exist.
const TRANSIENT_OVERAGE_REASONS: [&str; 2] = ["org_level_disabled_until", "out_of_credits"];
/// A 400 from an account that cannot serve fast mode at all.
const NOT_ENABLED_TEXT: &str = "fast mode is not enabled";
const NOT_ENABLED_REASON: &str = "fast_mode_not_enabled";

/// What a failure on a fast request means for the caller (`noteFastModeCapacityError`'s result).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Capacity {
    /// Not a fast request or not a capacity status; nothing changed.
    Ignored,
    /// A short server window: keep fast mode and let the normal retry wait it out.
    RetryFast,
    /// A cooldown started: the next attempt drops `speed`.
    Downgrade,
    /// Overage is unavailable: fast mode is off for this process.
    Disabled,
}

impl Capacity {
    /// The decision as Node names it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ignored => "ignored",
            Self::RetryFast => "retry-fast",
            Self::Downgrade => "downgrade",
            Self::Disabled => "disabled",
        }
    }

    /// `fastModeDowngraded`: the caller must drop `speed` before replaying.
    pub fn downgraded(self) -> bool {
        matches!(self, Self::Downgrade | Self::Disabled)
    }
}

/// A failure seen on a fast request, as far as the policy reads it.
pub struct CapacityError<'a> {
    /// The HTTP status (`httpStatus || status || response.status`).
    pub status: u16,
    pub message: &'a str,
    pub headers: &'a [(String, String)],
    /// `err.retryAfterMs`, when the boundary stamped one.
    pub retry_after_ms: Option<f64>,
}

#[derive(Default)]
struct State {
    cooldown_until_ms: f64,
    disabled_reason: Option<String>,
}

/// The cooldown and the disabled reason.
pub struct FastMode {
    state: Mutex<State>,
}

static PROCESS: LazyLock<Arc<FastMode>> = LazyLock::new(|| Arc::new(FastMode::new()));

/// The process-wide state: one session finding the pool empty must not leave its siblings
/// hammering it. Every provider's config holds this one unless a test gives it its own.
pub fn process() -> &'static Arc<FastMode> {
    &PROCESS
}

/// `Date.now()`.
pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    super::errors::header(headers, name)
}

/// The server's window: an explicit `retryAfterMs`, else the Retry-After headers (the unified reset
/// header is deliberately not a window).
fn server_window_ms(error: &CapacityError<'_>) -> Option<f64> {
    error
        .retry_after_ms
        .filter(|ms| ms.is_finite() && *ms >= 0.0)
        .or_else(|| super::errors::retry_after_ms(error.headers))
}

impl FastMode {
    pub const fn new() -> Self {
        Self { state: Mutex::new(State { cooldown_until_ms: 0.0, disabled_reason: None }) }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `fastModeAvailable(now)`: a request may still ask for `speed: "fast"`.
    pub fn available(&self, now_ms: f64) -> bool {
        let state = self.state();
        state.disabled_reason.is_none() && now_ms >= state.cooldown_until_ms
    }

    /// `fastModeCooldownRemainingMs(now)`; infinite once disabled.
    pub fn cooldown_remaining_ms(&self, now_ms: f64) -> f64 {
        let state = self.state();
        if state.disabled_reason.is_some() {
            return f64::INFINITY;
        }
        (state.cooldown_until_ms - now_ms).max(0.0)
    }

    /// `fastModeDisabledReason()`.
    pub fn disabled_reason(&self) -> Option<String> {
        self.state().disabled_reason.clone()
    }

    /// `noteFastModeCapacityError(err, { fast, now })`: records a capacity failure of a fast
    /// request and says what the caller does about it.
    pub fn note_capacity_error(&self, error: &CapacityError<'_>, fast: bool, now_ms: f64) -> Capacity {
        if !fast {
            return Capacity::Ignored;
        }
        let mut state = self.state();
        if error.status == 400 && error.message.to_ascii_lowercase().contains(NOT_ENABLED_TEXT) {
            state.disabled_reason = Some(NOT_ENABLED_REASON.to_owned());
            return Capacity::Disabled;
        }
        if error.status != 429 && error.status != 529 {
            return Capacity::Ignored;
        }
        // The header's presence, even empty, is the signal.
        if let Some(reason) = header(error.headers, OVERAGE_DISABLED_HEADER) {
            if TRANSIENT_OVERAGE_REASONS.contains(&reason) {
                return Capacity::Downgrade;
            }
            state.disabled_reason = Some(if reason.is_empty() { "overage_unavailable".to_owned() } else { reason.to_owned() });
            return Capacity::Disabled;
        }
        let window = server_window_ms(error);
        if window.is_some_and(|ms| ms < SHORT_RETRY_THRESHOLD_MS) {
            return Capacity::RetryFast;
        }
        let cooldown = window.unwrap_or(DEFAULT_COOLDOWN_MS).max(MIN_COOLDOWN_MS);
        state.cooldown_until_ms = state.cooldown_until_ms.max(now_ms + cooldown);
        Capacity::Downgrade
    }

    /// `clearFastModeCooldown()`: the manual re-enable.
    pub fn clear(&self) {
        *self.state() = State::default();
    }
}

impl Default for FastMode {
    fn default() -> Self {
        Self::new()
    }
}
