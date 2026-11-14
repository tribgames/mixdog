//! The terminal modes against what the Node TUI writes (tests/goldens/modes.json, recorded by tests/recorders/record-modes.mjs
//! from src/tui/index.jsx, theme.mjs, keyboard-protocol.mjs, app/use-terminal-chrome.mjs, app/use-mouse-input.mjs and the
//! Ink fork): the fixed sequences, the mouse and extended-keys bytes of every recorded environment combination, the
//! theme background and the tracking restore after the ctrl+wheel zoom passthrough.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use mixdog_term::modes::{
    ALT_SCROLL_RESTORE, BRACKETED_PASTE_ON, ModeEnv, MouseTrackingRestore, OSC_RESET_BACKGROUND, TERMINAL_MODE_RESET,
    TERMINAL_MODE_RESET_HIDDEN_CURSOR, TerminalModes, background_sequence, hard_exit_sequence, restore_sequence,
    screen_entry_sequence,
};
use serde_json::Value;

const GOLDEN: &str = include_str!("goldens/modes.json");

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("modes.json")
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_else(|| panic!("{key} is not a string"))
}

#[test]
fn the_fixed_sequences_are_the_recorded_ones() {
    let golden = golden();
    let fixed = &golden["fixed"];
    assert_eq!(TERMINAL_MODE_RESET, text(fixed, "resetShown"));
    assert_eq!(TERMINAL_MODE_RESET_HIDDEN_CURSOR, text(fixed, "resetHidden"));
    assert_eq!(OSC_RESET_BACKGROUND, text(fixed, "oscResetBackground"));
    assert_eq!(ALT_SCROLL_RESTORE, text(fixed, "altScrollRestore"));
    assert_eq!(BRACKETED_PASTE_ON, text(fixed, "bracketedPasteOn"));
    assert_eq!(screen_entry_sequence(), text(fixed, "entry"));
    assert_eq!(restore_sequence(), text(fixed, "restore"));
    assert_eq!(hard_exit_sequence(), text(fixed, "hardExit"));
}

#[test]
fn every_recorded_environment_gets_the_recorded_bytes() {
    let golden = golden();
    let combos = golden["combos"].as_array().expect("combos");
    assert!(combos.len() > 100, "{} combinations", combos.len());
    for combo in combos {
        let env: HashMap<String, String> = combo["env"]
            .as_object()
            .expect("env")
            .iter()
            .map(|(name, value)| (name.clone(), value.as_str().expect("env value").to_string()))
            .collect();
        let modes = ModeEnv::from_vars(|name| env.get(name).cloned());
        let label = format!("{env:?}");
        assert_eq!(modes.extended_keys, combo["extendedKeys"].as_bool().expect("extendedKeys"), "{label}");
        assert_eq!(modes.extended_keys_on(), text(combo, "extendedKeysOn"), "{label}");
        assert_eq!(modes.mouse, combo["mouse"].as_bool().expect("mouse"), "{label}");
        assert_eq!(modes.mouse_on(), text(combo, "mouseOn"), "{label}");
    }
}

#[test]
fn the_theme_background_is_the_recorded_osc() {
    let golden = golden();
    for case in golden["background"].as_array().expect("background") {
        assert_eq!(background_sequence(text(case, "input")), text(case, "out"), "{:?}", case["input"]);
    }
}

#[test]
fn the_tracking_restore_after_the_wheel_zoom_is_the_recorded_one() {
    let golden = golden();
    let mouse = &golden["mouse"];
    let delay = Duration::from_millis(mouse["delayMs"].as_u64().expect("delayMs"));
    let retry = Duration::from_millis(mouse["retryMs"].as_u64().expect("retryMs"));
    let retries = mouse["maxRetries"].as_u64().expect("maxRetries");

    let modes = TerminalModes::new(ModeEnv::from_vars(|_| None));
    let mut restore = MouseTrackingRestore::new(modes);
    let start = Instant::now();
    assert_eq!(restore.passthrough(start).as_deref(), Some(text(mouse, "passthrough")));
    assert!(restore.poll(start + delay - Duration::from_millis(1)).is_none());
    let mut now = start + delay;
    assert_eq!(restore.poll(now).as_deref(), Some(text(mouse, "restore")));
    for attempt in 0..retries {
        restore.write_failed(now);
        now += retry;
        assert!(restore.poll(now).is_some(), "retry {attempt}");
    }
    restore.write_failed(now);
    assert!(restore.poll(now + retry).is_none(), "no retry past the limit");
}
