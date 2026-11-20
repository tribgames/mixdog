//! Terminal modes: the byte sequences that enter and restore the screen, mouse, paste and keyboard modes, exactly as the
//! Node TUI (`src/tui/index.jsx`, the extended-keys effect of `App.jsx`, the mouse-tracking restore of
//! `use-mouse-input.mjs`) wrote them. `tests/modes_twin.rs` holds every sequence to a recording of those sources.
//!
//! The order a session writes them in:
//!
//! 1. [`screen_entry_sequence`] before anything else (alternate screen, cleared, blinking bar cursor);
//! 2. [`ModeEnv::extended_keys_on`] together with raw mode, before the first read;
//! 3. [`background_sequence`] once the theme is known and [`BRACKETED_PASTE_ON`] while paste is wanted;
//! 4. [`ModeEnv::mouse_on`] once the session is ready;
//! 5. [`restore_sequence`] at the end, through [`TerminalModes::take_restore`] so that it is written once.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::input::{DISABLE_MODIFY_OTHER_KEYS, ENABLE_KITTY_KEYBOARD, ENABLE_MODIFY_OTHER_KEYS, POP_KITTY, supports_extended_keys_with};

/// Every mouse, paste and shift-escape mode off and the cursor shown. The trailing `ESC [ > 0 s` restores XTSHIFTESCAPE,
/// which [`ModeEnv::mouse_on`] may have opted into.
pub const TERMINAL_MODE_RESET: &str = "\x1b[?1006l\x1b[?1005l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[>0s\x1b[?25h";
/// [`TERMINAL_MODE_RESET`] with the cursor hidden.
pub const TERMINAL_MODE_RESET_HIDDEN_CURSOR: &str = "\x1b[?1006l\x1b[?1005l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[>0s\x1b[?25l";
/// OSC 111: the terminal's own background again.
pub const OSC_RESET_BACKGROUND: &str = "\x1b]111\x07";
/// DECSET 1007 on: the terminal turns the wheel into arrow keys on the alternate screen. Written at exit.
pub const ALT_SCROLL_RESTORE: &str = "\x1b[?1007h";
/// DECSET 1007 off, kept for the whole session: a wheel without mouse tracking is then a no-op, never prompt history.
pub const ALT_SCROLL_OFF: &str = "\x1b[?1007l";
/// DECSCUSR 5: a blinking bar, a thin caret behind the text.
pub const CURSOR_BLINKING_BAR: &str = "\x1b[5 q";
/// DECSCUSR 0: the terminal's own cursor shape.
pub const CURSOR_DEFAULT_SHAPE: &str = "\x1b[0 q";
/// Bracketed paste on (the Ink fork writes it while a paste handler is mounted).
pub const BRACKETED_PASTE_ON: &str = "\x1b[?2004h";
/// Mouse tracking with SGR coordinates (the pair the wheel zoom passthrough switches off and on again).
pub const MOUSE_TRACKING_BASE_ON: &str = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
/// The reverse of [`MOUSE_TRACKING_BASE_ON`].
pub const MOUSE_TRACKING_BASE_OFF: &str = "\x1b[?1006l\x1b[?1002l\x1b[?1000l";
/// XTSHIFTESCAPE on: terminals that support it forward shift+click and drag to the application.
pub const XTSHIFTESCAPE_ON: &str = "\x1b[>1s";

/// Wait before the mouse modes are written again after a zoom passthrough.
pub const MOUSE_RESTORE_DELAY: Duration = Duration::from_millis(700);
/// Wait before the next try when the restore write failed.
pub const MOUSE_RESTORE_RETRY_DELAY: Duration = Duration::from_millis(200);
/// Retries of a failed restore write (six writes in all).
pub const MOUSE_RESTORE_MAX_RETRIES: u8 = 5;

/// What the environment decides about the modes (which of them the terminal gets).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModeEnv {
    /// Whether the extended-keys gate ([`crate::supports_extended_keys`]) is open.
    pub extended_keys: bool,
    /// `WT_SESSION` is set: Windows Terminal keeps shift native, so XTSHIFTESCAPE is not requested.
    pub windows_terminal: bool,
    /// Mouse tracking is on unless `MIXDOG_TUI_MOUSE` says `0`, `false`, `no` or `off`.
    pub mouse: bool,
}

/// `0`, `false`, `no` or `off` in any case, with nothing around it.
pub(crate) fn is_off_word(raw: &str) -> bool {
    ["0", "false", "no", "off"].iter().any(|word| raw.eq_ignore_ascii_case(word))
}

/// The bytes that enter the alternate screen: modes reset with the cursor hidden, the screen switched, the reset again,
/// the screen cleared and the cursor homed, then the blinking bar cursor.
pub fn screen_entry_sequence() -> String {
    format!("{TERMINAL_MODE_RESET_HIDDEN_CURSOR}\x1b[?1049h{TERMINAL_MODE_RESET_HIDDEN_CURSOR}\x1b[2J\x1b[H{CURSOR_BLINKING_BAR}")
}

/// The bytes that leave everything the session turned on. The kitty pop and modifyOtherKeys off are written whether or
/// not they were enabled: both are no-ops then. They come before the alternate screen is left.
pub fn restore_sequence() -> String {
    format!(
        "{TERMINAL_MODE_RESET}{ALT_SCROLL_RESTORE}{CURSOR_DEFAULT_SHAPE}{POP_KITTY}{DISABLE_MODIFY_OTHER_KEYS}\x1b[?1049l{TERMINAL_MODE_RESET}{OSC_RESET_BACKGROUND}"
    )
}

/// What the hard-exit timer writes before it ends the process.
pub fn hard_exit_sequence() -> String {
    format!("{TERMINAL_MODE_RESET}{OSC_RESET_BACKGROUND}")
}

/// OSC 11 for a theme background `rgb(r,g,b)` (spaces allowed, each part clamped to 0-255); OSC 111 (the terminal's own
/// background) when the text is not in that form.
pub fn background_sequence(rgb: &str) -> String {
    match parse_rgb(rgb) {
        Some([r, g, b]) => format!("\x1b]11;rgb:{r:02x}{r:02x}/{g:02x}{g:02x}/{b:02x}{b:02x}\x07"),
        None => OSC_RESET_BACKGROUND.to_string(),
    }
}

fn parse_rgb(text: &str) -> Option<[u8; 3]> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace() && *c != '\u{feff}').collect();
    let inner = compact.strip_prefix("rgb(")?.strip_suffix(')')?;
    let mut parts = inner.split(',');
    let mut out = [0u8; 3];
    for slot in &mut out {
        let part = parts.next()?;
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        *slot = u8::try_from(part.parse::<u128>().unwrap_or(u128::MAX).min(255)).ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// The latch that makes the restore of the terminal happen once, whoever asks first (the end of the session, a signal,
/// a dead stdio, a panic, the hard-exit timer).
#[derive(Debug)]
pub struct TerminalModes {
    env: ModeEnv,
    restored: AtomicBool,
}

impl TerminalModes {
    pub fn new(env: ModeEnv) -> Arc<TerminalModes> {
        Arc::new(TerminalModes { env, restored: AtomicBool::new(false) })
    }

    pub fn env(&self) -> &ModeEnv {
        &self.env
    }

    /// Takes the restore: true for the first caller, false for every later one. The caller that gets true writes
    /// [`restore_sequence`].
    pub fn take_restore(&self) -> bool {
        !self.restored.swap(true, Ordering::SeqCst)
    }

    /// Whether the terminal has been restored (late timers and buffered events must not write modes then).
    pub fn is_restored(&self) -> bool {
        self.restored.load(Ordering::SeqCst)
    }
}

/// Puts mouse tracking back after the wheel zoom passthrough turned it off (Windows Terminal converts the wheel to arrow
/// keys, or zooms, only while tracking and alternate scroll are off). A state machine over explicit times: the owner
/// writes what it returns and calls [`MouseTrackingRestore::write_failed`] when a write failed.
#[derive(Debug)]
pub struct MouseTrackingRestore {
    modes: Arc<TerminalModes>,
    due: Option<Instant>,
    attempt: u8,
}

impl MouseTrackingRestore {
    pub fn new(modes: Arc<TerminalModes>) -> MouseTrackingRestore {
        MouseTrackingRestore { modes, due: None, attempt: 0 }
    }

    /// The bytes that switch tracking and alternate scroll off for a wheel zoom, and the restore scheduled
    /// [`MOUSE_RESTORE_DELAY`] after `now`; `None` once the terminal has been restored.
    pub fn passthrough(&mut self, now: Instant) -> Option<String> {
        if self.modes.is_restored() {
            self.cancel();
            return None;
        }
        self.schedule(now);
        Some(format!("{MOUSE_TRACKING_BASE_OFF}{ALT_SCROLL_OFF}"))
    }

    /// Schedules the restore [`MOUSE_RESTORE_DELAY`] after `now`, replacing a pending one.
    pub fn schedule(&mut self, now: Instant) {
        if self.modes.is_restored() {
            self.cancel();
            return;
        }
        self.attempt = 0;
        self.due = Some(now + MOUSE_RESTORE_DELAY);
    }

    /// The restore bytes when they are due at `now` (tracking and alternate scroll off, in that order), else `None`.
    pub fn poll(&mut self, now: Instant) -> Option<String> {
        let due = self.due?;
        if self.modes.is_restored() {
            self.cancel();
            return None;
        }
        if now < due {
            return None;
        }
        self.due = None;
        Some(format!("{MOUSE_TRACKING_BASE_ON}{ALT_SCROLL_OFF}"))
    }

    /// The restore write returned an error: another try [`MOUSE_RESTORE_RETRY_DELAY`] after `now`, up to
    /// [`MOUSE_RESTORE_MAX_RETRIES`] times.
    pub fn write_failed(&mut self, now: Instant) {
        if self.modes.is_restored() || self.due.is_some() || self.attempt >= MOUSE_RESTORE_MAX_RETRIES {
            return;
        }
        self.attempt += 1;
        self.due = Some(now + MOUSE_RESTORE_RETRY_DELAY);
    }

    /// When [`MouseTrackingRestore::poll`] next has something to give (to set a timer).
    pub fn next_due(&self) -> Option<Instant> {
        self.due
    }

    /// Drops a pending restore.
    pub fn cancel(&mut self) {
        self.due = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> ModeEnv {
        let vars: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        ModeEnv::from_vars(|name| vars.get(name).cloned())
    }

    #[test]
    fn the_entry_order() {
        assert_eq!(
            screen_entry_sequence(),
            "\x1b[?1006l\x1b[?1005l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[>0s\x1b[?25l\x1b[?1049h\x1b[?1006l\x1b[?1005l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[>0s\x1b[?25l\x1b[2J\x1b[H\x1b[5 q"
        );
    }

    #[test]
    fn the_restore_order_and_its_latch() {
        let restore = restore_sequence();
        assert!(restore.starts_with(TERMINAL_MODE_RESET));
        let at = |needle: &str| restore.find(needle).expect(needle);
        assert!(at("\x1b[?1007h") < at("\x1b[0 q"));
        assert!(at("\x1b[<u") < at("\x1b[>4;0m"));
        assert!(at("\x1b[>4;0m") < at("\x1b[?1049l"));
        assert!(restore.ends_with("\x1b]111\x07"));
        let modes = TerminalModes::new(env(&[]));
        assert!(!modes.is_restored());
        assert!(modes.take_restore());
        assert!(!modes.take_restore());
        assert!(modes.is_restored());
    }

    #[test]
    fn the_mouse_modes_follow_the_environment() {
        assert_eq!(env(&[]).mouse_on(), "\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007l\x1b[>1s");
        assert_eq!(env(&[("WT_SESSION", "x")]).mouse_on(), "\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007l");
        for off in ["0", "false", "No", "OFF"] {
            assert_eq!(env(&[("MIXDOG_TUI_MOUSE", off)]).mouse_on(), "", "{off}");
        }
        for on in ["", "1", "on", " 0", "off "] {
            assert!(env(&[("MIXDOG_TUI_MOUSE", on)]).mouse, "{on:?}");
        }
    }

    #[test]
    fn the_extended_keys_follow_the_gate() {
        assert_eq!(env(&[("WT_SESSION", "x")]).extended_keys_on(), "\x1b[>1u\x1b[>4;2m");
        assert_eq!(env(&[]).extended_keys_on(), "");
    }

    #[test]
    fn the_background() {
        assert_eq!(background_sequence("rgb(0, 128, 255)"), "\x1b]11;rgb:0000/8080/ffff\x07");
        assert_eq!(background_sequence("rgb(999,1,2)"), "\x1b]11;rgb:ffff/0101/0202\x07");
        for bad in ["", "#112233", "rgb(1,2)", "rgb(1,2,3,4)", "rgb(a,b,c)", "rgba(1,2,3)"] {
            assert_eq!(background_sequence(bad), "\x1b]111\x07", "{bad:?}");
        }
    }

    #[test]
    fn the_wheel_zoom_passthrough_restores_after_the_delay() {
        let modes = TerminalModes::new(env(&[]));
        let mut restore = MouseTrackingRestore::new(modes);
        let t0 = Instant::now();
        assert_eq!(restore.passthrough(t0).unwrap(), "\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?1007l");
        assert!(restore.poll(t0 + Duration::from_millis(699)).is_none());
        assert_eq!(restore.poll(t0 + Duration::from_millis(700)).unwrap(), "\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1007l");
        assert!(restore.poll(t0 + Duration::from_secs(5)).is_none());
    }

    #[test]
    fn a_second_passthrough_replaces_the_pending_restore() {
        let modes = TerminalModes::new(env(&[]));
        let mut restore = MouseTrackingRestore::new(modes);
        let t0 = Instant::now();
        restore.passthrough(t0);
        let t1 = t0 + Duration::from_millis(500);
        restore.passthrough(t1);
        assert!(restore.poll(t0 + Duration::from_millis(700)).is_none());
        assert!(restore.poll(t1 + MOUSE_RESTORE_DELAY).is_some());
    }

    #[test]
    fn a_failed_restore_write_is_retried_five_times() {
        let modes = TerminalModes::new(env(&[]));
        let mut restore = MouseTrackingRestore::new(modes);
        let mut now = Instant::now();
        restore.schedule(now);
        now += MOUSE_RESTORE_DELAY;
        assert!(restore.poll(now).is_some());
        for _ in 0..MOUSE_RESTORE_MAX_RETRIES {
            restore.write_failed(now);
            assert_eq!(restore.next_due(), Some(now + MOUSE_RESTORE_RETRY_DELAY));
            now += MOUSE_RESTORE_RETRY_DELAY;
            assert!(restore.poll(now).is_some());
        }
        restore.write_failed(now);
        assert!(restore.next_due().is_none());
    }

    #[test]
    fn nothing_is_written_after_the_terminal_was_restored() {
        let modes = TerminalModes::new(env(&[]));
        let mut restore = MouseTrackingRestore::new(modes.clone());
        let t0 = Instant::now();
        restore.passthrough(t0);
        assert!(modes.take_restore());
        assert!(restore.poll(t0 + Duration::from_secs(1)).is_none());
        assert!(restore.passthrough(t0 + Duration::from_secs(2)).is_none());
        assert!(restore.next_due().is_none());
    }
}

impl ModeEnv {
    /// The decisions of the environment `var` reads (`None` when a variable is not set).
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> ModeEnv {
        let mouse_raw = var("MIXDOG_TUI_MOUSE").filter(|value| !value.is_empty()).unwrap_or_else(|| "1".to_string());
        ModeEnv {
            extended_keys: supports_extended_keys_with(&var),
            windows_terminal: var("WT_SESSION").is_some_and(|value| !value.is_empty()),
            mouse: !is_off_word(&mouse_raw),
        }
    }

    /// [`ModeEnv::from_vars`] over the process environment.
    pub fn from_process() -> ModeEnv {
        ModeEnv::from_vars(|name| std::env::var(name).ok())
    }

    /// Mouse tracking, the alternate scroll off and, outside Windows Terminal, XTSHIFTESCAPE on; empty when
    /// `MIXDOG_TUI_MOUSE` turned mouse capture off. Written once the session is ready.
    pub fn mouse_on(&self) -> String {
        if !self.mouse {
            return String::new();
        }
        let shift = if self.windows_terminal { "" } else { XTSHIFTESCAPE_ON };
        format!("{MOUSE_TRACKING_BASE_ON}{ALT_SCROLL_OFF}{shift}")
    }

    /// Kitty keyboard flags and modifyOtherKeys, written at the moment raw mode turns on, before the first read; empty
    /// when the terminal is not on the allowlist.
    pub fn extended_keys_on(&self) -> String {
        if self.extended_keys { format!("{ENABLE_KITTY_KEYBOARD}{ENABLE_MODIFY_OTHER_KEYS}") } else { String::new() }
    }
}
