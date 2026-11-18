//! The terminal's extended-keys capability gate.
//!
//! The terminal is not queried. The kitty keyboard protocol and xterm modifyOtherKeys are enabled synchronously at the
//! moment raw mode turns on, gated by the allowlist below. Writing both enables unconditionally is safe: a terminal honors
//! whichever it implements (Windows Terminal has no kitty support but does honor modifyOtherKeys), and doing it before the
//! first key is read removes the round-trip race that made the first Ctrl+Enter submit instead of inserting a newline.

/// Push kitty flags = 1 (disambiguate escape codes).
pub const ENABLE_KITTY_KEYBOARD: &str = "\x1b[>1u";
/// xterm modifyOtherKeys level 2.
pub const ENABLE_MODIFY_OTHER_KEYS: &str = "\x1b[>4;2m";
/// Pop the kitty stack entry.
pub const POP_KITTY: &str = "\x1b[<u";
/// modifyOtherKeys off.
pub const DISABLE_MODIFY_OTHER_KEYS: &str = "\x1b[>4;0m";

/// Whether the terminal described by the environment is known to honor kitty and/or xterm modifyOtherKeys. The xterm.js
/// based integrated terminal of VS Code mishandles these sequences, so it is excluded first. `MIXDOG_TUI_EXTENDED_KEYS`
/// opts out (`0`, `false`, `no`, `off`) or overrides (`1`, `true`, `yes`, `on`), case-insensitively. `var` reads one
/// environment variable.
pub fn supports_extended_keys_with(var: impl Fn(&str) -> Option<String>) -> bool {
    let present = |name: &str| var(name).filter(|value| !value.is_empty());
    let raw = var("MIXDOG_TUI_EXTENDED_KEYS").unwrap_or_default();
    let raw = raw.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}').to_ascii_lowercase();
    if matches!(raw.as_str(), "0" | "false" | "no" | "off") {
        return false;
    }
    if matches!(raw.as_str(), "1" | "true" | "yes" | "on") {
        return true;
    }
    let term_program = var("TERM_PROGRAM");
    if term_program.as_deref() == Some("vscode") {
        return false;
    }
    if present("WT_SESSION").is_some() {
        return true; // Windows Terminal
    }
    if var("TERM").is_some_and(|term| term.contains("kitty")) {
        return true;
    }
    if present("KITTY_WINDOW_ID").is_some() {
        return true;
    }
    if matches!(term_program.as_deref(), Some("WezTerm" | "ghostty")) {
        return true;
    }
    if var("TERM").as_deref() == Some("xterm-ghostty") {
        return true;
    }
    if present("TMUX").is_some() {
        return true;
    }
    term_program.as_deref() == Some("iTerm.app")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn gate(pairs: &[(&str, &str)]) -> bool {
        let env: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        supports_extended_keys_with(|name| env.get(name).cloned())
    }

    #[test]
    fn the_byte_constants() {
        assert_eq!(ENABLE_KITTY_KEYBOARD, "\x1b[>1u");
        assert_eq!(ENABLE_MODIFY_OTHER_KEYS, "\x1b[>4;2m");
        assert_eq!(POP_KITTY, "\x1b[<u");
        assert_eq!(DISABLE_MODIFY_OTHER_KEYS, "\x1b[>4;0m");
    }

    #[test]
    fn unknown_terminals_are_off() {
        assert!(!gate(&[]));
        assert!(!gate(&[("TERM", "xterm-256color")]));
        assert!(!gate(&[("TERM_PROGRAM", "Apple_Terminal")]));
    }

    #[test]
    fn known_terminals_are_on() {
        assert!(gate(&[("WT_SESSION", "x")]));
        assert!(gate(&[("TERM", "xterm-kitty")]));
        assert!(gate(&[("KITTY_WINDOW_ID", "3")]));
        assert!(gate(&[("TERM_PROGRAM", "WezTerm")]));
        assert!(gate(&[("TERM_PROGRAM", "ghostty")]));
        assert!(gate(&[("TERM", "xterm-ghostty")]));
        assert!(gate(&[("TMUX", "/tmp/tmux-1000/default,1,0")]));
        assert!(gate(&[("TERM_PROGRAM", "iTerm.app")]));
    }

    #[test]
    fn empty_variables_count_as_unset() {
        assert!(!gate(&[("WT_SESSION", ""), ("TMUX", ""), ("KITTY_WINDOW_ID", "")]));
    }

    #[test]
    fn vscode_is_off_before_the_allowlist() {
        assert!(!gate(&[("TERM_PROGRAM", "vscode"), ("WT_SESSION", "x"), ("TMUX", "1")]));
    }

    #[test]
    fn the_override_wins_either_way() {
        for off in ["0", "false", "No", " OFF "] {
            assert!(!gate(&[("MIXDOG_TUI_EXTENDED_KEYS", off), ("WT_SESSION", "x")]), "{off:?}");
        }
        for on in ["1", "TRUE", "yes", "On"] {
            assert!(gate(&[("MIXDOG_TUI_EXTENDED_KEYS", on), ("TERM_PROGRAM", "vscode")]), "{on:?}");
        }
        assert!(gate(&[("MIXDOG_TUI_EXTENDED_KEYS", "maybe"), ("WT_SESSION", "x")]));
    }
}


/// [`supports_extended_keys_with`] over the process environment.
pub fn supports_extended_keys() -> bool {
    supports_extended_keys_with(|name| std::env::var(name).ok())
}
