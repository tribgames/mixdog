//! `--screen-input`: the remote screen's input process (apps/desktop
//! remote-screen/screen-input-host.ts), which took over from the PowerShell
//! `MixdogScreenHost`. It injects the phone's input through the helper's own
//! checked `SendInput` transport and ownership receipt, and reports which
//! desktop takes input and whether an elevation prompt or the sign-in screen
//! is up.
//!
//! Line protocol, ASCII, one command per line on stdin:
//!   m <id> <x> <y>                       absolute move, desktop pixels
//!   b <id> <l|r|m> <0|1> [<x> <y>]       button up/down, optionally at a point
//!   w <id> <x> <y> <dx> <dy>             wheel at a point, wheel units (+ = down/right)
//!   k <id> <vk> <scan> <ext 0|1> <0|1>   key up/down
//!   t <id> <base64 utf-8>                literal text
//!   c <id>                               cursor position -> ok <id> <x> <y>
//!   q                                    release everything this process holds, exit
//! stdout: the first `desktop` line, then `ready <windows session id>`, then
//! `desktop <name|-> <consent 0|1> <logonui 0|1>` on change, and
//! `ok <id> ...` / `err <id> <code>` per command. End of stdin (the app died)
//! releases like `q`, so a crash never leaves a key or button down.
//!
//! Only the process that spawned it can command it: the protocol runs over
//! its own stdin/stdout pipes, and it opens no named pipe, socket or window.

/// The longest literal text one `t` command may carry, in UTF-16 units
/// (`MAX_REMOTE_SCREEN_TEXT`, shared/remote-webrtc.ts).
pub const MAX_TEXT: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// One command, as read off its line.
#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Move { x: i32, y: i32 },
    Button { button: Button, down: bool, at: Option<(i32, i32)> },
    Wheel { x: i32, y: i32, dx: i32, dy: i32 },
    Key { vk: u16, scan: u16, extended: bool, down: bool },
    Text(String),
    Cursor,
}

/// The id a reply names: the second field, or "0" when there is none.
pub fn id_of(line: &str) -> &str {
    line.split(' ').nth(1).unwrap_or("0")
}

fn protocol(reason: &str) -> String {
    format!("protocol_error: {reason}")
}

fn int(field: Option<&str>) -> Result<i32, String> {
    let text = field.ok_or_else(|| protocol("bad number"))?;
    // Int32.TryParse with a leading sign only: no spaces, no fractions.
    let digits = text.strip_prefix(['-', '+']).unwrap_or(text);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(protocol("bad number"));
    }
    text.parse::<i32>().map_err(|_| protocol("bad number"))
}

fn flag(field: Option<&str>) -> bool {
    field == Some("1")
}

/// Reads one command line (`MixdogScreenHost.Handle`).
pub fn parse(line: &str) -> Result<Command, String> {
    let fields: Vec<&str> = line.split(' ').collect();
    let at = |index: usize| fields.get(index).copied();
    match fields[0] {
        "m" => Ok(Command::Move { x: int(at(2))?, y: int(at(3))? }),
        "b" => {
            let button = match at(2) {
                Some("l") => Button::Left,
                Some("r") => Button::Right,
                Some("m") => Button::Middle,
                _ => return Err(protocol("bad button")),
            };
            let at = if fields.len() >= 6 { Some((int(at(4))?, int(at(5))?)) } else { None };
            Ok(Command::Button { button, down: flag(fields.get(3).copied()), at })
        }
        "w" => Ok(Command::Wheel { x: int(at(2))?, y: int(at(3))?, dx: int(at(4))?, dy: int(at(5))? }),
        "k" => {
            let (vk, scan) = (int(at(2))?, int(at(3))?);
            if !(0..=254).contains(&vk) || !(0..=255).contains(&scan) || (vk == 0 && scan == 0) {
                return Err(protocol("bad key"));
            }
            Ok(Command::Key { vk: vk as u16, scan: scan as u16, extended: flag(at(4)), down: flag(at(5)) })
        }
        "t" => {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(at(2).unwrap_or_default())
                .map_err(|_| protocol("bad text"))?;
            let text = String::from_utf8(bytes).map_err(|_| protocol("bad text"))?;
            if text.encode_utf16().count() > MAX_TEXT {
                return Err(protocol("text too long"));
            }
            Ok(Command::Text(text))
        }
        "c" => Ok(Command::Cursor),
        _ => Err(protocol("unknown command")),
    }
}

/// The code an error's text leads with, or `input_failed` when it leads with
/// none (`MixdogScreenHost.Code`).
pub fn code(error: &str) -> &str {
    match error.find(':') {
        Some(colon) if colon > 0 && error[..colon].bytes().all(|b| b == b'_' || b.is_ascii_lowercase()) => &error[..colon],
        _ => "input_failed",
    }
}

/// Whether a point lies on the virtual screen `(left, top, width, height)`.
pub fn on_screen(screen: (i32, i32, i32, i32), x: i32, y: i32) -> Result<(), String> {
    let (left, top, width, height) = screen;
    if width < 2 || height < 2 {
        return Err("display_unavailable: no virtual screen".into());
    }
    if x < left || y < top || x >= left + width || y >= top + height {
        return Err("out_of_bounds: point is outside the desktop".into());
    }
    Ok(())
}

/// The `desktop` line's body: the input desktop's name with only printable
/// ASCII kept (`-` when unreadable), then the consent and LogonUI flags.
pub fn desktop_state(name: Option<&str>, consent: bool, logon: bool) -> String {
    let clean: String = name.unwrap_or_default().chars().filter(|ch| *ch > ' ' && *ch < '\u{7f}').collect();
    let name = if clean.is_empty() { "-".to_string() } else { clean };
    format!("{name} {} {}", u8::from(consent), u8::from(logon))
}

/// The process's run: the exit code.
pub fn run() -> i32 {
    #[cfg(windows)]
    return crate::platform::screen_input();
    #[cfg(not(windows))]
    {
        eprintln!("mixdog-computer --screen-input: the remote screen's input runs only on Windows");
        2
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_command_reads_as_the_powershell_host_read_it() {
        assert_eq!(parse("m 1 -7 42"), Ok(Command::Move { x: -7, y: 42 }));
        assert_eq!(parse("b 2 l 1"), Ok(Command::Button { button: Button::Left, down: true, at: None }));
        assert_eq!(parse("b 3 r 0 1 2"), Ok(Command::Button { button: Button::Right, down: false, at: Some((1, 2)) }));
        assert_eq!(parse("w 4 0 0 0 -120"), Ok(Command::Wheel { x: 0, y: 0, dx: 0, dy: -120 }));
        assert_eq!(parse("k 5 65 30 1 0"), Ok(Command::Key { vk: 65, scan: 30, extended: true, down: false }));
        assert_eq!(parse("k 5 0 30 0 1"), Ok(Command::Key { vk: 0, scan: 30, extended: false, down: true }));
        // "a b\néllo", as formatScreenHostCommand encodes it.
        assert_eq!(parse("t 7 YSBiCsOpbGxv"), Ok(Command::Text("a b\néllo".into())));
        assert_eq!(parse("c 6"), Ok(Command::Cursor));
        assert_eq!(id_of("c 6"), "6");
        assert_eq!(id_of("q"), "0");
    }

    #[test]
    fn malformed_commands_are_protocol_errors() {
        for line in ["m 1 1.5 0", "m 1 1", "m 1 x 2", "m 1  2 3", "b 1 x 1", "k 1 255 0 0 1", "k 1 0 0 0 1", "k 1 1 256 0 1", "t 1 !!", "z 1"] {
            let error = parse(line).expect_err(line);
            assert!(error.starts_with("protocol_error: "), "{line}: {error}");
            assert_eq!(code(&error), "protocol_error");
        }
        let long = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode("x".repeat(MAX_TEXT + 1))
        };
        assert_eq!(parse(&format!("t 1 {long}")), Err("protocol_error: text too long".into()));
    }

    #[test]
    fn an_error_code_is_its_lowercase_lead_or_input_failed() {
        assert_eq!(code("out_of_bounds: point is outside the desktop"), "out_of_bounds");
        assert_eq!(code("input_cleanup_unconfirmed: x"), "input_cleanup_unconfirmed");
        assert_eq!(code("SendInput failed: 5"), "input_failed");
        assert_eq!(code("no code here"), "input_failed");
        assert_eq!(code(": empty"), "input_failed");
    }

    #[test]
    fn points_off_the_virtual_screen_are_refused() {
        let screen = (-1920, 0, 3840, 1080);
        assert!(on_screen(screen, -1920, 0).is_ok());
        assert!(on_screen(screen, 1919, 1079).is_ok());
        assert_eq!(on_screen(screen, 1920, 0), Err("out_of_bounds: point is outside the desktop".into()));
        assert_eq!(on_screen(screen, -1921, 5), Err("out_of_bounds: point is outside the desktop".into()));
        assert_eq!(on_screen((0, 0, 1, 1), 0, 0), Err("display_unavailable: no virtual screen".into()));
    }

    #[test]
    fn the_desktop_line_keeps_a_printable_name() {
        assert_eq!(desktop_state(Some("Default"), false, false), "Default 0 0");
        assert_eq!(desktop_state(Some("Win logon\u{1}"), true, true), "Winlogon 1 1");
        assert_eq!(desktop_state(None, false, true), "- 0 1");
        assert_eq!(desktop_state(Some(" "), false, false), "- 0 0");
    }
}
