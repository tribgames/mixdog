//! The environment facts the mouse code reads once at start: `MIXDOG_TUI_SELECTION_PAINT_MS`, the wheel tunables and whether
//! the terminal is Windows Terminal.

use mixdog_term::modes::ModeEnv;
use mixdog_term::selection::SELECTION_PAINT_INTERVAL_MS;

use crate::transcript::scroll::tuning::ScrollTuning;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MouseConfig {
    pub tuning: ScrollTuning,
    /// How often a moving selection repaints (`MIXDOG_TUI_SELECTION_PAINT_MS`, default 24).
    pub paint_interval_ms: u64,
    /// Windows Terminal (`WT_SESSION` set) forwards shift-modified buttons while painting its own native selection: every
    /// shift-modified button event is dropped so shift stays native, and an app-owned gesture ends with a full repaint that
    /// dismisses the native highlight.
    pub windows_terminal: bool,
    /// The bottom rows of the frame that are the statusline band.
    pub statusline_band_rows: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(pairs: &'static [(&'static str, &'static str)]) -> MouseConfig {
        MouseConfig::from_lookup(|name| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| (*v).to_owned()), 2)
    }

    #[test]
    fn the_paint_interval_is_a_positive_integer_or_the_default() {
        assert_eq!(config(&[]).paint_interval_ms, 24);
        assert_eq!(config(&[("MIXDOG_TUI_SELECTION_PAINT_MS", "40")]).paint_interval_ms, 40);
        assert_eq!(config(&[("MIXDOG_TUI_SELECTION_PAINT_MS", " 7.9 ")]).paint_interval_ms, 7);
        assert_eq!(config(&[("MIXDOG_TUI_SELECTION_PAINT_MS", "0")]).paint_interval_ms, 24);
        assert_eq!(config(&[("MIXDOG_TUI_SELECTION_PAINT_MS", "-5")]).paint_interval_ms, 24);
        assert_eq!(config(&[("MIXDOG_TUI_SELECTION_PAINT_MS", "fast")]).paint_interval_ms, 24);
    }

    #[test]
    fn windows_terminal_is_a_non_empty_wt_session() {
        assert!(config(&[("WT_SESSION", "abc")]).windows_terminal);
        assert!(!config(&[("WT_SESSION", "")]).windows_terminal);
        assert!(!config(&[]).windows_terminal);
    }
}


impl MouseConfig {
    /// The configuration `lookup` names (`None` for an unset variable).
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>, statusline_band_rows: usize) -> Self {
        let paint_interval_ms = lookup("MIXDOG_TUI_SELECTION_PAINT_MS")
            .map(|raw| mixdog_js::string_to_number(&raw).floor())
            .filter(|parsed| parsed.is_finite() && *parsed >= 1.0)
            .map_or(SELECTION_PAINT_INTERVAL_MS, |parsed| if parsed >= u64::MAX as f64 { u64::MAX } else { parsed as u64 });
        Self {
            tuning: ScrollTuning::from_lookup(&lookup),
            paint_interval_ms,
            windows_terminal: ModeEnv::from_vars(&lookup).windows_terminal,
            statusline_band_rows,
        }
    }

    /// The configuration of the process environment.
    pub fn from_env(statusline_band_rows: usize) -> Self {
        Self::from_lookup(|name| std::env::var(name).ok(), statusline_band_rows)
    }
}
