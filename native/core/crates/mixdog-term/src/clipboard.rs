//! The OS clipboard (`src/tui/app/clipboard.mjs`): an OSC 52 sequence to the terminal and a native helper.
//!
//! OSC 52 is `ESC ] 52 ; c ; <base64> BEL`, wrapped in the tmux DCS passthrough when `TMUX` is set, skipped above 256 KiB
//! of text (a multi-hundred-KB tty write stalls the render loop), and skipped on native Windows unless `TMUX`,
//! `SSH_CONNECTION` or `SSH_TTY` is set: a large synchronous OSC 52 write under ConPTY backpressure froze Windows
//! Terminal during a selection copy, and `clip.exe` alone is the reliable local writer there.
//!
//! The native helper is Windows `clip.exe` (the text as UTF-16LE with no byte-order mark: `clip.exe` copies a leading
//! FF FE verbatim), macOS `pbcopy`, and on the other systems `wl-copy` under Wayland or `xclip -selection clipboard`.

use std::fmt;
use std::io::Write;
use std::sync::Arc;
use std::thread;

use base64::Engine as _;

use crate::os::{Env, HelperCommand, Outcome, Platform, Runner, SystemRunner, env_set, process_env};

/// OSC 52 is not written for more than this many bytes of text.
pub const OSC52_MAX_BYTES: usize = 256 * 1024;

const LINUX_CLIPBOARD_HINT: &str =
    "install wl-clipboard (Wayland) or xclip (X11), for example `sudo apt install wl-clipboard xclip`";

/// What a successful copy was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CopyOutcome {
    /// A native helper confirmed the write.
    Copied,
    /// Only OSC 52 was emitted; the terminal may ignore it, so it is unconfirmed.
    Terminal,
}

/// A clipboard failure, as the message Node's error carried.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClipboardError(pub String);

impl fmt::Display for ClipboardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ClipboardError {}

/// Neither Linux clipboard reader is installed.
pub fn no_clipboard_reader_error() -> ClipboardError {
    ClipboardError(format!("no clipboard reader is installed; {LINUX_CLIPBOARD_HINT}"))
}

/// A clipboard helper that is not installed, named with the package to add (on Linux); any other failure as it is.
fn helper_error(program: &str, platform: Platform, not_found: bool, message: String) -> ClipboardError {
    if not_found && platform == Platform::Linux {
        return ClipboardError(format!("{program} is not installed; {LINUX_CLIPBOARD_HINT}"));
    }
    ClipboardError(message)
}

/// The OSC 52 sequence that sets the clipboard to `text`.
pub fn osc52_clipboard_sequence(text: &str, tmux: bool) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    let raw = format!("\x1b]52;c;{b64}\x07");
    if !tmux {
        return raw;
    }
    format!("\x1bPtmux;{}\x1b\\", raw.replace('\x1b', "\x1b\x1b"))
}

/// Whether OSC 52 is left out: native Windows outside tmux and SSH.
pub fn should_skip_osc52(platform: Platform, env: Env<'_>) -> bool {
    if platform != Platform::Windows {
        return false;
    }
    if env_set(env, "TMUX") || env_set(env, "SSH_CONNECTION") || env_set(env, "SSH_TTY") {
        return false;
    }
    true
}

/// Write the OSC 52 sequence to `out`; `false` when it was skipped (policy, or more than [`OSC52_MAX_BYTES`]) or the
/// write failed.
pub fn write_osc52_clipboard(out: &mut dyn Write, text: &str, platform: Platform, env: Env<'_>) -> bool {
    if should_skip_osc52(platform, env) || text.len() > OSC52_MAX_BYTES {
        return false;
    }
    let sequence = osc52_clipboard_sequence(text, env_set(env, "TMUX"));
    out.write_all(sequence.as_bytes()).and_then(|()| out.flush()).is_ok()
}

/// The native helper that writes `text`: its program, argv and the bytes it reads on stdin.
pub fn native_clipboard_command(platform: Platform, env: Env<'_>, text: &str) -> HelperCommand {
    let mut command = match platform {
        Platform::Windows => HelperCommand::new("clip.exe", &[]),
        Platform::Macos => HelperCommand::new("pbcopy", &[]),
        // WAYLAND_DISPLAY is the variable a Wayland client connects by; a helper that is not installed fails as not
        // found, which the caller turns into the install hint.
        _ if env_set(env, "WAYLAND_DISPLAY") => HelperCommand::new("wl-copy", &[]),
        _ => HelperCommand::new("xclip", &["-selection", "clipboard"]),
    };
    command.stdin = Some(if platform == Platform::Windows {
        text.encode_utf16().flat_map(u16::to_le_bytes).collect()
    } else {
        text.as_bytes().to_vec()
    });
    command
}

/// Copy `text` to the clipboard: OSC 52 to `out` and the native helper. A successful OSC 52 answers
/// [`CopyOutcome::Terminal`] at once and the helper is started without being waited for, so the terminal never blocks on
/// process start-up; when OSC 52 was left out the helper is the only writer and its exit decides (`Copied` or the
/// error). `confirm` waits for the helper even after OSC 52, to tell which of the two happened.
pub fn copy_to_clipboard_with(
    out: &mut dyn Write,
    text: &str,
    confirm: bool,
    platform: Platform,
    env: Env<'_>,
    runner: Arc<dyn Runner>,
) -> Result<CopyOutcome, ClipboardError> {
    let wrote_osc52 = write_osc52_clipboard(out, text, platform, env);
    let command = native_clipboard_command(platform, env, text);
    if wrote_osc52 && !confirm {
        thread::spawn(move || {
            let _ = runner.run(&command);
        });
        return Ok(CopyOutcome::Terminal);
    }
    // A helper failure only matters when OSC 52 did not cover us.
    let failed = |error: ClipboardError| if wrote_osc52 { Ok(CopyOutcome::Terminal) } else { Err(error) };
    match runner.run(&command) {
        Outcome::Exited { code: Some(0), .. } => Ok(CopyOutcome::Copied),
        Outcome::Exited { code, .. } => {
            let code = code.map_or_else(|| "null".to_owned(), |code| code.to_string());
            failed(ClipboardError(format!("{} exited with code {code}", command.program)))
        }
        Outcome::NotFound => failed(helper_error(
            &command.program,
            platform,
            true,
            format!("spawn {} ENOENT", command.program),
        )),
        Outcome::SpawnFailed(message) => failed(helper_error(&command.program, platform, false, message)),
        Outcome::TimedOut | Outcome::Overflow => {
            failed(ClipboardError(format!("{} did not finish", command.program)))
        }
    }
}

/// [`copy_to_clipboard_with`] on this machine, writing OSC 52 to `out` (the terminal's output).
pub fn copy_to_clipboard(out: &mut dyn Write, text: &str, confirm: bool) -> Result<CopyOutcome, ClipboardError> {
    copy_to_clipboard_with(out, text, confirm, Platform::current(), &process_env, Arc::new(SystemRunner))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| (*v).to_owned())
    }

    #[test]
    fn the_sequence_is_wrapped_for_tmux() {
        assert_eq!(osc52_clipboard_sequence("hi", false), "\x1b]52;c;aGk=\x07");
        assert_eq!(osc52_clipboard_sequence("hi", true), "\x1bPtmux;\x1b\x1b]52;c;aGk=\x07\x1b\\");
        assert_eq!(osc52_clipboard_sequence("", false), "\x1b]52;c;\x07");
    }

    #[test]
    fn windows_skips_osc52_unless_remote() {
        assert!(should_skip_osc52(Platform::Windows, &env_of(&[])));
        assert!(should_skip_osc52(Platform::Windows, &env_of(&[("TMUX", "")])));
        assert!(!should_skip_osc52(Platform::Windows, &env_of(&[("TMUX", "x")])));
        assert!(!should_skip_osc52(Platform::Windows, &env_of(&[("SSH_TTY", "/dev/pts/0")])));
        assert!(!should_skip_osc52(Platform::Windows, &env_of(&[("SSH_CONNECTION", "a b c d")])));
        assert!(!should_skip_osc52(Platform::Linux, &env_of(&[])));
        assert!(!should_skip_osc52(Platform::Macos, &env_of(&[])));
    }

    #[test]
    fn osc52_is_skipped_above_the_size_limit() {
        let mut out = Vec::new();
        let big = "x".repeat(OSC52_MAX_BYTES + 1);
        assert!(!write_osc52_clipboard(&mut out, &big, Platform::Linux, &env_of(&[])));
        assert!(out.is_empty());
        let at_limit = "x".repeat(OSC52_MAX_BYTES);
        assert!(write_osc52_clipboard(&mut out, &at_limit, Platform::Linux, &env_of(&[])));
        assert!(!out.is_empty());
    }

    #[test]
    fn the_helper_of_each_platform_and_its_stdin() {
        let none = env_of(&[]);
        let windows = native_clipboard_command(Platform::Windows, &none, "a\u{1F600}");
        assert_eq!(windows.program, "clip.exe");
        assert_eq!(windows.stdin, Some(vec![0x61, 0x00, 0x3D, 0xD8, 0x00, 0xDE]));
        let mac = native_clipboard_command(Platform::Macos, &none, "é");
        assert_eq!((mac.program.as_str(), mac.stdin), ("pbcopy", Some("é".as_bytes().to_vec())));
        let wayland = native_clipboard_command(Platform::Linux, &env_of(&[("WAYLAND_DISPLAY", "wayland-0")]), "x");
        assert_eq!(wayland.program, "wl-copy");
        assert!(wayland.args.is_empty());
        let x11 = native_clipboard_command(Platform::Linux, &env_of(&[("WAYLAND_DISPLAY", "")]), "x");
        assert_eq!((x11.program.as_str(), x11.args), ("xclip", vec!["-selection".to_owned(), "clipboard".to_owned()]));
    }
}
