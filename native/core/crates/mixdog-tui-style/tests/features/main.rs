//! What the style crate decides: colour levels, the bytes written at each level, the 256-colour quantiser, the live theme,
//! the footer colour bridge, spinner phrases and duration labels.

use std::collections::BTreeMap;

use mixdog_tui_style::Key;
use mixdog_tui_style::bridge::{StatuslineColors, normalize_statusline_ansi, statusline_footer_identity_changed};
use mixdog_tui_style::color::{Style, Styler, rgb_to_ansi256};
use mixdog_tui_style::color_level::{ColorEnvironment, ink_colorize};
use mixdog_tui_style::figures;
use mixdog_tui_style::palette::THEME_ALIASES;
use mixdog_tui_style::spinner_verbs::{SPINNER_VERBS, mode_override_verb, spinner_verb_for, spinner_verb_in};
use mixdog_tui_style::theme::{
    Color, current_palette, get_theme_setting, get_theme_version, list_themes, osc_background_sequence, set_theme,
    terminal_background_sequence,
};
use mixdog_tui_style::time_format::{DurationOptions, format_duration, format_elapsed};
use serde_json::json;

fn env(vars: &[(&str, &str)], argv: &[&str], windows_release: Option<&str>, terminal: bool) -> ColorEnvironment {
    ColorEnvironment {
        vars: vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect::<BTreeMap<_, _>>(),
        argv: argv.iter().map(|a| (*a).to_owned()).collect(),
        windows_release: windows_release.map(str::to_owned),
        stream_is_terminal: terminal,
    }
}

// ---- the colour level ------------------------------------------------------------------------------------------------

#[test]
fn a_stream_that_is_not_a_terminal_gets_no_colour_unless_forced() {
    let vars = [("COLORTERM", "truecolor")];
    assert_eq!(env(&vars, &[], None, false).level(), 0);
    assert_eq!(env(&[("FORCE_COLOR", "2")], &[], None, false).level(), 2);
    assert_eq!(env(&[("FORCE_COLOR", "9")], &[], None, false).level(), 3, "a forced level is capped at truecolor");
}

#[test]
fn force_color_zero_or_false_switches_colour_off_even_on_a_capable_terminal() {
    for off in ["0", "false"] {
        assert_eq!(env(&[("FORCE_COLOR", off), ("COLORTERM", "truecolor")], &[], None, true).level(), 0);
    }
    assert_eq!(env(&[("FORCE_COLOR", "true")], &[], None, false).level(), 1);
}

#[test]
fn the_terminal_name_and_colorterm_pick_the_level() {
    assert_eq!(env(&[("COLORTERM", "truecolor")], &[], None, true).level(), 3);
    assert_eq!(env(&[("TERM", "xterm-256color")], &[], None, true).level(), 2);
    assert_eq!(env(&[("TERM", "xterm")], &[], None, true).level(), 1);
    assert_eq!(env(&[("TERM", "xterm-kitty")], &[], None, true).level(), 3);
    assert_eq!(env(&[("TERM", "dumb")], &[], None, true).level(), 0);
    assert_eq!(env(&[("TERM", "dumb"), ("FORCE_COLOR", "1")], &[], None, true).level(), 1);
    assert_eq!(env(&[], &[], None, true).level(), 0, "no hint at all means no colour");
}

#[test]
fn terminal_programs_declare_their_depth() {
    assert_eq!(env(&[("TERM_PROGRAM", "iTerm.app"), ("TERM_PROGRAM_VERSION", "3.4.1")], &[], None, true).level(), 3);
    assert_eq!(env(&[("TERM_PROGRAM", "iTerm.app"), ("TERM_PROGRAM_VERSION", "2.9")], &[], None, true).level(), 2);
    assert_eq!(env(&[("TERM_PROGRAM", "Apple_Terminal")], &[], None, true).level(), 2);
}

#[test]
fn windows_levels_follow_the_build_number() {
    assert_eq!(env(&[], &[], Some("10.0.14931"), true).level(), 3, "first build with truecolor");
    assert_eq!(env(&[], &[], Some("10.0.10586"), true).level(), 2, "first build with 256 colours");
    assert_eq!(env(&[], &[], Some("6.1.7601"), true).level(), 1);
}

#[test]
fn ci_vendors_decide_their_own_level() {
    assert_eq!(env(&[("CI", "1"), ("GITHUB_ACTIONS", "1")], &[], None, true).level(), 3);
    assert_eq!(env(&[("CI", "1"), ("TRAVIS", "1")], &[], None, true).level(), 1);
    assert_eq!(env(&[("CI", "1")], &[], None, true).level(), 0);
}

#[test]
fn colour_flags_apply_only_before_the_argument_terminator() {
    let vars = [("TERM", "xterm-256color")];
    assert_eq!(env(&vars, &["--no-color"], None, true).level(), 0);
    assert_eq!(env(&[], &["--color=256"], None, true).level(), 2);
    assert_eq!(env(&[], &["--color=16m"], None, true).level(), 3);
    assert_eq!(env(&vars, &["--", "--no-color"], None, true).level(), 2);
}

// ---- what is written at each level ---------------------------------------------------------------------------------------

#[test]
fn a_named_colour_is_written_as_its_sgr_pair_and_nothing_at_level_zero() {
    assert_eq!(ink_colorize("hi", "red", false, 0).as_deref(), Some("hi"));
    assert_eq!(ink_colorize("hi", "red", false, 1).as_deref(), Some("\x1b[31mhi\x1b[39m"));
    assert_eq!(ink_colorize("hi", "red", true, 1).as_deref(), Some("\x1b[41mhi\x1b[49m"));
    assert_eq!(ink_colorize("hi", "", false, 3).as_deref(), Some("hi"));
}

#[test]
fn a_hex_colour_is_downgraded_to_the_level_of_the_terminal() {
    assert_eq!(ink_colorize("hi", "#ff0000", false, 3).as_deref(), Some("\x1b[38;2;255;0;0mhi\x1b[39m"));
    assert_eq!(ink_colorize("hi", "#ff0000", false, 2).as_deref(), Some("\x1b[38;5;196mhi\x1b[39m"));
    assert_eq!(ink_colorize("hi", "#ff0000", false, 1).as_deref(), Some("\x1b[91mhi\x1b[39m"), "bright red of the 16 colours");
    assert_eq!(ink_colorize("hi", "#00ff00", true, 3).as_deref(), Some("\x1b[48;2;0;255;0mhi\x1b[49m"));
    assert_eq!(ink_colorize("hi", "#fff", false, 3).as_deref(), Some("\x1b[38;2;255;255;255mhi\x1b[39m"), "a short hex doubles its digits");
}

#[test]
fn a_colour_that_cannot_be_read_leaves_the_text_alone() {
    assert_eq!(ink_colorize("hi", "rgb(1,2", false, 3).as_deref(), Some("hi"));
    assert_eq!(ink_colorize("hi", "notacolor", false, 3).as_deref(), Some("hi"));
    assert_eq!(ink_colorize("hi", "rgb(1,2,3)", false, 3).as_deref(), Some("\x1b[38;2;1;2;3mhi\x1b[39m"));
    assert_eq!(ink_colorize("hi", "bold", true, 3), None, "a modifier has no background form");
}

// ---- the statusline styler and the quantiser -----------------------------------------------------------------------------

#[test]
fn the_quantiser_picks_the_nearest_cube_colour_or_grey() {
    assert_eq!(rgb_to_ansi256(0.0, 0.0, 0.0), 16);
    assert_eq!(rgb_to_ansi256(255.0, 255.0, 255.0), 231);
    assert_eq!(rgb_to_ansi256(255.0, 0.0, 0.0), 196);
    assert_eq!(rgb_to_ansi256(128.0, 128.0, 128.0), 244, "a mid grey lands on the grey ramp");
    assert_eq!(rgb_to_ansi256(f64::NAN, 0.0, 0.0), 16, "a value that is not a number counts as zero");
}

#[test]
fn the_styler_is_decided_by_no_color_force_color_and_the_terminal() {
    let decide = |vars: &'static [(&'static str, &'static str)], terminal: bool| {
        Styler::from_environment(&|name| vars.iter().find(|(k, _)| *k == name).map(|(_, v)| (*v).to_owned()), terminal)
    };
    assert!(decide(&[], true).enabled());
    assert!(!decide(&[], false).enabled());
    assert!(!decide(&[("NO_COLOR", "1"), ("FORCE_COLOR", "1")], true).enabled(), "NO_COLOR wins");
    assert!(decide(&[("NO_COLOR", "")], true).enabled(), "an empty NO_COLOR counts as unset");
    assert!(decide(&[("FORCE_COLOR", "1")], false).enabled());
    assert!(!decide(&[("FORCE_COLOR", "0")], false).enabled());
    assert!(!decide(&[("TERM_PROGRAM", "Apple_Terminal")], true).truecolor());
    assert!(decide(&[], true).truecolor());
}

#[test]
fn a_style_wraps_the_text_and_survives_a_reset_inside_it() {
    let styler = Styler::new(true, true);
    assert_eq!(styler.paint(Style::Bold, "x"), "\x1b[1mx\x1b[0m");
    assert_eq!(styler.paint(Style::Bold, "a\x1b[0mb"), "\x1b[1ma\x1b[0m\x1b[1mb\x1b[0m");
    assert_eq!(Styler::new(false, true).paint(Style::Bold, "x"), "x");
}

#[test]
fn rgb_is_truecolor_or_downsampled_to_256_colours() {
    assert_eq!(Styler::new(true, true).rgb_sgr(1.0, 2.0, 3.0, false), "\x1b[38;2;1;2;3m");
    assert_eq!(Styler::new(true, true).rgb_sgr(1.0, 2.0, 3.0, true), "\x1b[48;2;1;2;3m");
    assert_eq!(Styler::new(true, false).rgb_sgr(1.0, 2.0, 3.0, false), "\x1b[38;5;16m");
}

// ---- the live theme --------------------------------------------------------------------------------------------------------

#[test]
fn every_switch_bumps_the_version_even_to_the_same_theme() {
    let first = set_theme("basic");
    let before = get_theme_version();
    let again = set_theme("basic");
    assert_eq!(first.id, again.id);
    assert_eq!(get_theme_version(), before + 1);
}

#[test]
fn an_unknown_or_padded_id_resolves_and_an_alias_follows_its_target() {
    let default = set_theme("basic").id;
    assert_eq!(set_theme("no-such-theme").id, default, "an unknown id falls back to the default");
    assert_eq!(set_theme("  basic  ").id, default, "the id is trimmed");
    for (alias, target) in THEME_ALIASES {
        assert_eq!(set_theme(alias).id, target);
    }
}

#[test]
fn the_list_marks_exactly_the_live_theme_and_each_theme_has_its_own_palette() {
    let ids: Vec<&str> = list_themes().iter().map(|theme| theme.id).collect();
    assert!(ids.len() > 1);
    let mut seen = Vec::new();
    for id in ids {
        set_theme(id);
        let listed = list_themes();
        assert_eq!(listed.iter().filter(|theme| theme.current).count(), 1);
        assert_eq!(listed.iter().find(|theme| theme.current).map(|theme| theme.id), Some(id));
        assert_eq!(get_theme_setting(), id);
        seen.push(current_palette());
    }
    seen.dedup();
    assert!(seen.len() > 1, "switching themes changes the palette");
}

#[test]
fn a_colour_is_written_as_css_text() {
    assert_eq!(Color::Rgb(1, 2, 3).css(), "rgb(1,2,3)");
    assert_eq!(Color::Transparent.css(), "transparent");
}

#[test]
fn the_terminal_background_is_osc_11_for_a_colour_and_osc_111_otherwise() {
    assert_eq!(osc_background_sequence("rgb(1, 2, 3)"), "\x1b]11;rgb:0101/0202/0303\x07");
    assert_eq!(osc_background_sequence("rgb(255,0,300)"), "\x1b]11;rgb:ffff/0000/ffff\x07", "a channel is clamped to 255");
    assert_eq!(osc_background_sequence("transparent"), "\x1b]111\x07");
    assert_eq!(osc_background_sequence("rgb(1,2)"), "\x1b]111\x07");
    let mut palette = current_palette();
    palette.0[Key::Background as usize] = Color::Rgb(10, 20, 30);
    assert_eq!(terminal_background_sequence(&palette), "\x1b]11;rgb:0a0a/1414/1e1e\x07");
    palette.0[Key::Background as usize] = Color::Transparent;
    assert_eq!(terminal_background_sequence(&palette), "\x1b]111\x07");
}

#[test]
fn the_glyphs_are_the_ones_the_transcript_draws() {
    assert_eq!(figures::UP_ARROW, "\u{2191}");
    assert_eq!(figures::DOWN_ARROW, "\u{2193}");
    assert_eq!(figures::LEFT_ARROW, "\u{2190}");
    assert_eq!(figures::RIGHT_ARROW, "\u{2192}");
    assert_eq!(figures::BULLET_OPERATOR, "\u{00b7}");
    assert!(["\u{25cf}", "\u{23fa}"].contains(&figures::BLACK_CIRCLE));
}

// ---- the footer colour bridge -----------------------------------------------------------------------------------------------

fn colors() -> StatuslineColors {
    StatuslineColors {
        status: "\x1b[38;2;1;1;1m".into(),
        subtle: "\x1b[38;2;2;2;2m".into(),
        success: "\x1b[38;2;3;3;3m".into(),
        warning: "\x1b[38;2;4;4;4m".into(),
        error: "\x1b[38;2;5;5;5m".into(),
    }
}

#[test]
fn the_fixed_statusline_colours_are_rewritten_into_the_theme() {
    let theme = colors();
    let shown = normalize_statusline_ansi("\x1b[38;2;0;170;75mok\x1b[0m\n", &theme, None);
    assert_eq!(shown, format!("{}ok\x1b[0m", theme.success), "the canonical green is the success colour; the newline is dropped");
    let shown = normalize_statusline_ansi("\x1b[31mfail\x1b[0m", &theme, None);
    assert_eq!(shown, format!("{}fail\x1b[0m", theme.error));
}

#[test]
fn text_after_a_reset_goes_back_to_the_status_colour() {
    let theme = colors();
    let shown = normalize_statusline_ansi("x\x1b[0m y", &theme, None);
    assert_eq!(shown, format!("x\x1b[0m {}y", theme.status));
}

#[test]
fn the_footer_snaps_local_only_when_the_session_identity_changes() {
    let base = json!({ "sessionId": "s", "model": "m", "agentRevision": 1, "stats": { "turns": 2 } });
    assert!(!statusline_footer_identity_changed(None, Some(&base)));
    assert!(statusline_footer_identity_changed(Some(&base), None));
    assert!(!statusline_footer_identity_changed(Some(&base), Some(&base.clone())));
    let mut other = base.clone();
    other["model"] = json!("n");
    assert!(statusline_footer_identity_changed(Some(&other), Some(&base)));
    let mut churn = base.clone();
    churn["agentRevision"] = json!(9);
    assert!(!statusline_footer_identity_changed(Some(&churn), Some(&base)), "agent churn alone never snaps the footer");
    let mut reset = base.clone();
    reset["stats"] = json!({ "turns": 0 });
    assert!(statusline_footer_identity_changed(Some(&reset), Some(&base)), "stats falling back to zero snaps it");
}

// ---- spinner phrases and duration labels --------------------------------------------------------------------------------------

#[test]
fn a_turn_keeps_its_phrase_for_the_first_window_and_the_phrase_comes_from_the_pool() {
    let start = 1_700_000_000_000.0;
    let first = spinner_verb_for(start, start);
    assert!(SPINNER_VERBS.contains(&first));
    assert_eq!(spinner_verb_for(start, start + 29_000.0), first);
    assert_eq!(spinner_verb_for(0.0, 5.0), spinner_verb_for(0.0, 9_999_999.0), "an unknown start never rotates");
}

#[test]
fn a_phrase_never_holds_longer_than_four_windows() {
    let start = 1_700_000_000_000.0;
    let mut run = 1;
    let mut previous = spinner_verb_for(start, start);
    for window in 1..200 {
        let now = spinner_verb_for(start, start + f64::from(window) * 30_000.0);
        run = if now == previous { run + 1 } else { 1 };
        assert!(run <= 4, "held {run} windows at window {window}");
        previous = now;
    }
}

#[test]
fn a_callers_pool_is_used_and_an_empty_one_means_the_common_pool() {
    let start = 1_700_000_000_000.0;
    let pool = ["a", "b", "c"];
    assert!(pool.contains(&spinner_verb_in(start, start + 60_000.0, &pool).as_str()));
    assert_eq!(spinner_verb_in::<&str>(start, start, &[]), spinner_verb_for(start, start));
}

#[test]
fn state_modes_replace_the_phrase_but_reconnecting_is_authored_elsewhere() {
    assert_eq!(mode_override_verb("compacting"), Some("Compacting conversation"));
    assert_eq!(mode_override_verb("model-thinking"), Some("Model thinking"));
    assert_eq!(mode_override_verb("reconnecting"), None);
}

#[test]
fn elapsed_labels_are_empty_under_a_second_and_compact_above() {
    let plain = DurationOptions::default();
    assert_eq!(format_duration(999.0, plain), "");
    assert_eq!(format_duration(1_000.0, plain), "1s");
    assert_eq!(format_duration(3_600_000.0, plain), "1h 0m 0s");
    assert_eq!(format_duration(3_600_000.0, DurationOptions { hide_trailing_zeros: true, ..plain }), "1h");
    assert_eq!(format_duration(7_500_000.0, DurationOptions { most_significant_only: true, ..plain }), "2h");
    assert_eq!(format_duration(f64::NAN, plain), "");
    assert_eq!(format_elapsed(-5.0), "");
    assert_eq!(format_elapsed(f64::NAN), "");
    assert_eq!(format_elapsed(61_000.0), "1m 1s");
}
