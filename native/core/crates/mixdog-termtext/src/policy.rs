//! The display-width policy of `src/tui/display-width.mjs` (and the same policy of the Ink fork's
//! `display-width.js`).
//!
//! `string-width` counts East Asian Ambiguous glyphs as 1 cell. Windows Terminal draws two families of them 2 cells
//! wide, so text after them would overlap: enclosed alphanumerics U+2460 to U+24FF and arrows U+2194 to U+21FF.
//! With the policy on, a grapheme cluster that starts with one of those and that `string_width` measures as 1 adds
//! one cell. Nothing else is widened: not box drawing, not block elements, not the four basic arrows U+2190 to
//! U+2193 (the one-cell markers of the agent cards and history), not U+21BB (the one-cell quota-reset marker). With
//! the policy off the result is `string_width` unchanged.
//!
//! The policy is on by default on Windows or when `WT_SESSION` is set (Windows Terminal reached from another host);
//! `MIXDOG_TUI_AMBIGUOUS_WIDE` set to exactly `1` forces it on and to exactly `0` forces it off. It is resolved once
//! per process.

use std::sync::OnceLock;

use unicode_segmentation::UnicodeSegmentation;

use crate::width::{StringWidthOptions, string_width};

const OVERRIDE_VARIABLE: &str = "MIXDOG_TUI_AMBIGUOUS_WIDE";
const WINDOWS_TERMINAL_VARIABLE: &str = "WT_SESSION";

/// A code point the policy widens: U+2460 to U+24FF and U+2194 to U+21FF, except U+21BB.
fn is_problem_code_point(ch: char) -> bool {
    matches!(u32::from(ch), 0x2460..=0x24ff | 0x2194..=0x21ba | 0x21bc..=0x21ff)
}

/// The fast pre-check: the characters that can be widened at all, widened or not (U+21BB included).
fn may_contain_problem_glyph(text: &str) -> bool {
    text.chars().any(|c| matches!(u32::from(c), 0x2194..=0x21ff | 0x2460..=0x24ff))
}

/// The policy of an environment: the override wins, then Windows, then `WT_SESSION` being present and not empty.
fn resolve_policy(override_value: Option<&str>, windows: bool, wt_session: Option<&str>) -> bool {
    match override_value {
        Some("1") => true,
        Some("0") => false,
        _ => windows || wt_session.is_some_and(|value| !value.is_empty()),
    }
}

fn ambiguous_wide() -> bool {
    static POLICY: OnceLock<bool> = OnceLock::new();
    *POLICY.get_or_init(|| {
        let override_value = std::env::var(OVERRIDE_VARIABLE).ok();
        let wt_session = std::env::var(WINDOWS_TERMINAL_VARIABLE).ok();
        resolve_policy(override_value.as_deref(), cfg!(windows), wt_session.as_deref())
    })
}

/// `displayWidthWith(text, wide)`: the width of `text` with the policy given.
pub fn display_width_with(text: &str, wide: bool) -> usize {
    let base = string_width(text, StringWidthOptions::default());
    if !wide || !may_contain_problem_glyph(text) {
        return base;
    }
    // Per grapheme cluster: `↔\u{fe0f}` is one cluster and widens once, and only when the whole cluster still
    // measures 1 (a cluster the terminal already draws as 2 is not widened twice).
    let extra = text
        .graphemes(true)
        .filter(|segment| {
            segment.chars().next().is_some_and(is_problem_code_point)
                && string_width(segment, StringWidthOptions::default()) == 1
        })
        .count();
    base + extra
}

/// `displayWidth(text)`: the visible width under the policy of this process.
pub fn display_width(text: &str) -> usize {
    display_width_with(text, ambiguous_wide())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_override_wins_over_the_platform() {
        assert!(resolve_policy(Some("1"), false, None));
        assert!(!resolve_policy(Some("0"), true, Some("x")));
        assert!(resolve_policy(Some("yes"), true, None));
        assert!(!resolve_policy(Some("yes"), false, None));
        assert!(!resolve_policy(Some("true"), false, Some("")));
    }

    #[test]
    fn the_default_is_windows_or_a_windows_terminal_session() {
        assert!(resolve_policy(None, true, None));
        assert!(resolve_policy(None, false, Some("guid")));
        assert!(!resolve_policy(None, false, Some("")));
        assert!(!resolve_policy(None, false, None));
    }

    #[test]
    fn enclosed_alphanumerics_and_arrows_widen_when_on() {
        assert_eq!(display_width_with("①", true), 2);
        assert_eq!(display_width_with("①", false), 1);
        assert_eq!(display_width_with("⇒ ⇧", true), 5);
        assert_eq!(display_width_with("↔", true), 2);
        assert_eq!(display_width_with("⑩⑪", true), 4);
    }

    #[test]
    fn a_cluster_widens_once() {
        // U+2194 U+FE0F is an RGI emoji: string-width already gives it 2, so nothing is added.
        assert_eq!(display_width_with("\u{2194}\u{fe0f}", true), 2);
        // U+2194 U+FE0E is one cluster measured 1: widened once.
        assert_eq!(display_width_with("\u{2194}\u{fe0e}", true), 2);
    }

    #[test]
    fn markers_and_box_drawing_stay_one_cell() {
        for text in ["←", "↑", "→", "↓", "↻", "└", "│", "⎿", "─", "█", "←Spawn"] {
            assert_eq!(display_width_with(text, true), display_width_with(text, false), "{text}");
        }
        assert_eq!(display_width_with("↻ 12%", true), 5);
    }

    #[test]
    fn ansi_and_plain_text_are_unchanged() {
        assert_eq!(display_width_with("\x1b[31m①\x1b[0m", true), 2);
        assert_eq!(display_width_with("plain", true), 5);
        assert_eq!(display_width_with("日本", true), 4);
    }
}
