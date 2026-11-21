//! The `MIXDOG_TUI_SCROLL_*` tunables and the wheel acceleration step.
//!
//! Boolean variables default on: `0`/`false`/`off`/`no` (case-insensitive, trimmed) turn one off, an unrecognised value keeps
//! the default. Integer variables take the floor of the value read as a JavaScript number and must be at least one, else the
//! default stands.

/// Milliseconds a flood of wheel or edge-drag deltas coalesces into one scroll (`MIXDOG_TUI_SCROLL_COALESCE_MS`).
pub const DEFAULT_COALESCE_MS: u64 = 16;
/// Rows of one wheel notch (`MIXDOG_TUI_SCROLL_SPEED`).
pub const DEFAULT_STEP_ROWS: u64 = 3;
/// Idle gap after which the acceleration restarts (`MIXDOG_TUI_SCROLL_ACCEL_IDLE_MS`).
pub const DEFAULT_ACCEL_IDLE_MS: u64 = 150;

/// The scroll tunables, read once at start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScrollTuning {
    pub coalesce_ms: u64,
    pub step_rows: u64,
    /// `MIXDOG_TUI_SCROLL_ACCELERATION`; off gives the fixed-speed mode.
    pub accel_enabled: bool,
    /// `MIXDOG_TUI_SCROLL_SPEED_MAX`, never below the base step; defaults to three notches.
    pub step_max_rows: u64,
    pub accel_idle_ms: u64,
}

impl Default for ScrollTuning {
    fn default() -> Self {
        Self::from_lookup(|_| None)
    }
}

impl ScrollTuning {
    /// The tunables the process environment sets.
    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// The tunables `lookup` names (`None` for an unset variable).
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let integer = |name: &str, fallback: u64| lookup(name).and_then(|raw| positive_int(&raw)).unwrap_or(fallback);
        let step_rows = integer("MIXDOG_TUI_SCROLL_SPEED", DEFAULT_STEP_ROWS);
        Self {
            coalesce_ms: integer("MIXDOG_TUI_SCROLL_COALESCE_MS", DEFAULT_COALESCE_MS),
            step_rows,
            accel_enabled: lookup("MIXDOG_TUI_SCROLL_ACCELERATION").and_then(|raw| flag(&raw)).unwrap_or(true),
            step_max_rows: step_rows.max(integer("MIXDOG_TUI_SCROLL_SPEED_MAX", step_rows.saturating_mul(3))),
            accel_idle_ms: integer("MIXDOG_TUI_SCROLL_ACCEL_IDLE_MS", DEFAULT_ACCEL_IDLE_MS),
        }
    }
}

/// `envFlag`: `Some` for a recognised on or off spelling, `None` for an empty or unrecognised value.
fn flag(raw: &str) -> Option<bool> {
    match raw.trim().to_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "off" | "no" => Some(false),
        _ => None,
    }
}

/// `positiveInt`: the floor of `Number(raw)` when it is finite and at least one.
fn positive_int(raw: &str) -> Option<u64> {
    let parsed = mixdog_js::string_to_number(raw).floor();
    (parsed.is_finite() && parsed >= 1.0).then(|| if parsed >= u64::MAX as f64 { u64::MAX } else { parsed as u64 })
}

/// The acceleration state of the wheel: consecutive notches in one direction within the idle gap grow the step by the base
/// step up to the maximum; a direction change or an idle gap resets it to the base step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WheelAccel {
    direction: i32,
    at_ms: u64,
    step: u64,
}

impl WheelAccel {
    pub fn new(tuning: &ScrollTuning) -> Self {
        Self { direction: 0, at_ms: 0, step: tuning.step_rows }
    }

    /// The signed rows of a wheel notch at `now_ms`: `direction` is `1` for wheel up (toward older rows), `-1` for down.
    pub fn notch(&mut self, direction: i32, now_ms: u64, tuning: &ScrollTuning) -> i64 {
        if !tuning.accel_enabled || self.direction != direction || now_ms.saturating_sub(self.at_ms) > tuning.accel_idle_ms {
            self.step = tuning.step_rows;
        } else {
            self.step = tuning.step_max_rows.min(self.step.saturating_add(tuning.step_rows));
        }
        self.direction = direction;
        self.at_ms = now_ms;
        i64::from(direction) * self.step as i64
    }
}
