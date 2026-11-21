#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the harness lays out an install, runs processes and waits on a pseudo-terminal")]
#![allow(dead_code, reason = "each test binary uses its own part of the support")]

pub mod baseline;
pub mod daemon;
pub mod provider;
pub mod pty;

use std::sync::{Mutex, MutexGuard, PoisonError};

use serde_json::{Value, json};

/// The environment variable that makes the test binary a terminal UI child; its value is [`child_spec`]'s JSON.
pub const CHILD_ENV: &str = "MIXDOG_TUI_PTY_CHILD";

/// What the child needs to start the terminal UI.
pub fn child_spec(cwd: &str, provider: &str, model: &str) -> String {
    json!({ "cwd": cwd, "provider": provider, "model": model }).to_string()
}

static GATE: Mutex<()> = Mutex::new(());

/// One pty test at a time in a binary: each starts a core and a terminal UI, and a timing must not share the machine with a
/// second run.
pub fn serial() -> MutexGuard<'static, ()> {
    GATE.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The standard base64 of `bytes` (what an OSC 52 payload is).
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, byte)| acc | (u32::from(*byte) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The text an OSC 52 clipboard sequence in `raw` carries (the last one), decoded.
pub fn last_osc52_text(raw: &[u8]) -> Option<String> {
    const HEAD: &[u8] = b"\x1b]52;c;";
    let at = raw.windows(HEAD.len()).rposition(|window| window == HEAD)? + HEAD.len();
    let end = raw[at..].iter().position(|byte| *byte == 0x07 || *byte == 0x1b)? + at;
    let mut bits = 0u32;
    let mut count = 0;
    let mut out = Vec::new();
    for byte in &raw[at..end] {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push(((bits >> count) & 0xff) as u8);
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_through_an_osc52_sequence() {
        assert_eq!(base64(b"hi"), "aGk=");
        assert_eq!(base64(b"row-65"), "cm93LTY1");
        let sequence = format!("junk\x1b]52;c;{}\x07tail", base64("가나😀".as_bytes()));
        assert_eq!(last_osc52_text(sequence.as_bytes()).as_deref(), Some("가나😀"));
        assert_eq!(last_osc52_text(b"no clipboard"), None);
    }
}

/// The body of the `tui_child` test of each test binary: nothing in a normal run, the terminal UI in the pseudo-terminal of a
/// parent. A failed run fails the child with the exit code's text.
pub fn run_child() {
    let Ok(raw) = std::env::var(CHILD_ENV) else { return };
    let spec: Value = serde_json::from_str(&raw).expect("the child's options are JSON");
    let text = |name: &str| spec[name].as_str().map(str::to_owned);
    let options = mixdog_tui::run::TuiOptions {
        cwd: text("cwd"),
        provider: text("provider"),
        model: text("model"),
        statusline: Some(mixdog_tui::footer::process::process_renderer()),
        ..Default::default()
    };
    let code = mixdog_tui::run::run_tui(options);
    if format!("{code:?}") != format!("{:?}", std::process::ExitCode::SUCCESS) {
        // The terminal UI writes its failure to the stderr log of the private runtime root while it owns the terminal; the
        // parent only sees the screen, so the log goes there.
        let root = std::env::var("MIXDOG_RUNTIME_ROOT").unwrap_or_default();
        let log = std::fs::read_to_string(std::path::Path::new(&root).join("mixdog-tui.stderr.log"))
            .unwrap_or_else(|error| format!("(no stderr log in {root:?}: {error})"));
        println!("--- the terminal UI's stderr log ---\n{log}");
    }
    assert_eq!(format!("{code:?}"), format!("{:?}", std::process::ExitCode::SUCCESS), "the terminal UI ended with a failure");
}
