//! Background keyboard input: key streams and text, as messages to the
//! window's focused control.

use super::super::native::{self, hwnd, wid};
use super::{belongs_to_top, bound, drops, is_chromium, refuse_dropped, send, with_release, Msg, MsgError, WinBackground};
use crate::platform::{window_id, Wid};
use windows::Win32::Foundation::LPARAM;
use windows::Win32::UI::Input::KeyboardAndMouse::MapVirtualKeyW;
use windows::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetGUIThreadInfo, GetParent, GUITHREADINFO};

const WM_KEYDOWN: u32 = 0x0100;
const WM_KEYUP: u32 = 0x0101;
const WM_CHAR: u32 = 0x0102;

pub(super) fn supports_keyboard_class(class: &str) -> bool {
    !(["ApplicationFrameWindow", "Windows.UI.Core.CoreWindow", "WinUIDesktopWin32WindowClass", "Microsoft.UI.Content.DesktopChildSiteBridge"]
        .iter()
        .any(|name| name.eq_ignore_ascii_case(class))
        || is_chromium(class))
}

/// Whether the window renders web content: a browser or Electron field cannot
/// be told apart through UIA from a contenteditable, so a replacing value write
/// is no stand-in for typing there (IsWebContentHost, MixWin32Keyboard.cs:301).
pub(super) fn is_web_content_host(window: Wid) -> bool {
    is_chromium(&native::class_name(window))
}

/// What the keyboard target decision reads of the desktop.
trait KeyboardWorld {
    fn is_window(&self, window: Wid) -> bool;
    fn belongs_to_top(&self, top: Wid, candidate: Wid) -> bool;
    fn class_name(&self, window: Wid) -> String;
    /// Each control of `top` holding keyboard focus on one of its GUI
    /// threads, with its depth below `top`.
    fn focus_candidates(&self, top: Wid) -> Vec<(Wid, u32)>;
}

struct Live;

impl KeyboardWorld for Live {
    fn is_window(&self, window: Wid) -> bool {
        native::is_window(window)
    }
    fn belongs_to_top(&self, top: Wid, candidate: Wid) -> bool {
        belongs_to_top(top, candidate)
    }
    fn class_name(&self, window: Wid) -> String {
        native::class_name(window)
    }

    /// FocusedKeyboardDescendant's candidate walk (MixWin32Keyboard.cs:325-345).
    fn focus_candidates(&self, top: Wid) -> Vec<(Wid, u32)> {
        struct Search {
            top: Wid,
            threads: Vec<u32>,
        }
        unsafe extern "system" fn visit(child: windows::Win32::Foundation::HWND, state: LPARAM) -> windows::core::BOOL {
            let search = &mut *(state.0 as *mut Search);
            if belongs_to_top(search.top, wid(child)) {
                search.threads.push(native::pid_thread(wid(child)).1);
            }
            windows::core::BOOL(1)
        }
        let mut search = Search {
            top,
            threads: vec![native::pid_thread(top).1],
        };
        // SAFETY: the callback runs only during this call.
        let _ = unsafe {
            EnumChildWindows(Some(hwnd(top)), Some(visit), LPARAM(&mut search as *mut Search as isize))
        };
        search.threads.sort_unstable();
        search.threads.dedup();
        let mut candidates = Vec::new();
        for thread in search.threads.into_iter().filter(|thread| *thread != 0) {
            let mut info = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            // SAFETY: info is initialised with its size.
            if unsafe { GetGUIThreadInfo(thread, &mut info) }.is_err() || !belongs_to_top(top, wid(info.hwndFocus)) {
                continue;
            }
            let focus = wid(info.hwndFocus);
            let (mut current, mut depth) = (focus, 0u32);
            while current != top && current != 0 && depth < 64 {
                current = wid(unsafe { GetParent(hwnd(current)) }.unwrap_or_default());
                depth += 1;
            }
            if current == top {
                candidates.push((focus, depth));
            }
        }
        candidates
    }
}

/// The deepest focused control; two different ones at that depth are
/// ambiguous (SelectDeepestKeyboardFocus, MixWin32Keyboard.cs:347-368).
fn select_deepest(top: Wid, candidates: Vec<(Wid, u32)>) -> Msg<Wid> {
    let (mut selected, mut selected_depth, mut ambiguous) = (top, 0u32, false);
    for (window, depth) in candidates {
        if depth < selected_depth {
            continue;
        }
        if depth > selected_depth {
            selected = window;
            selected_depth = depth;
            ambiguous = false;
        } else if selected != window {
            ambiguous = true;
        }
    }
    if ambiguous {
        return Err(MsgError::plain(
            "background_target_ambiguous|multiple focused child windows; use an exact native ref",
        ));
    }
    Ok(selected)
}

/// The control that takes the keys: the ref's exact child `preferred` when
/// given, else the focused one (KeyboardTarget, MixWin32Keyboard.cs:370-394).
fn keyboard_target_in(world: &dyn KeyboardWorld, top: Wid, preferred: Wid) -> Msg<Wid> {
    if !world.is_window(top) {
        return Err(MsgError::plain(
            "stale_target|background keyboard target is stale or invalid",
        ));
    }
    if preferred != 0 && !world.belongs_to_top(top, preferred) {
        return Err(MsgError::plain(
            "target_mismatch|background keyboard ref belongs to a different window",
        ));
    }
    // The addressed child owns keyboard delivery, not the outer host's toolkit.
    let focused = if preferred != 0 {
        preferred
    } else {
        select_deepest(top, world.focus_candidates(top))?
    };
    if !supports_keyboard_class(&world.class_name(focused)) {
        return Err(MsgError::plain("background_unsupported|focused renderer does not accept posted keyboard input; no input sent"));
    }
    // An inactive Tk window keeps its focus to itself; keys sent to its frame
    // are discarded without an error.
    if focused == top && world.class_name(top).starts_with("Tk") {
        return Err(MsgError::plain("background_unsupported|this Tk window has no focused control while inactive, so background keys would be discarded; use explicit foreground delivery; no input sent"));
    }
    Ok(focused)
}

pub(super) fn keyboard_target(top: Wid, preferred: Wid) -> Msg<Wid> {
    keyboard_target_in(&Live, top, preferred)
}

fn named_virtual_key(name: &str) -> Msg<u16> {
    let key = match name {
        "BACKSPACE" | "BS" => 0x08,
        "TAB" => 0x09,
        "ENTER" | "RETURN" => 0x0D,
        "ESC" | "ESCAPE" => 0x1B,
        "SPACE" => 0x20,
        "PGUP" | "PRIOR" => 0x21,
        "PGDN" | "NEXT" => 0x22,
        "END" => 0x23,
        "HOME" => 0x24,
        "LEFT" => 0x25,
        "UP" => 0x26,
        "RIGHT" => 0x27,
        "DOWN" => 0x28,
        "INSERT" | "INS" => 0x2D,
        "DELETE" | "DEL" => 0x2E,
        "PLUS" => 0xBB,
        "MINUS" => 0xBD,
        "SHIFT" => 0x10,
        "CTRL" | "CONTROL" => 0x11,
        "ALT" | "MENU" => 0x12,
        "CAPSLOCK" => 0x14,
        "NUMLOCK" => 0x90,
        "SCROLLLOCK" => 0x91,
        "LWIN" | "WIN" => 0x5B,
        "APPS" => 0x5D,
        "PRTSC" | "PRINTSCREEN" => 0x2C,
        "PAUSE" => 0x13,
        other => match other
            .strip_prefix('F')
            .and_then(|digits| digits.parse::<u16>().ok())
            .filter(|number| (1..=24).contains(number))
        {
            Some(number) => 0x6F + number,
            None => {
                return Err(MsgError::plain(format!(
                    "background_unsupported|background keyboard does not support key token {{{other}}}"
                )))
            }
        },
    };
    Ok(key)
}

#[derive(Debug, PartialEq)]
pub(super) enum Stroke {
    Char(char),
    Key(u16),
}

/// The whole stream is validated before any target is resolved or key sent.
pub(super) fn parse_keys(keys: &str) -> Msg<Vec<Stroke>> {
    let chars: Vec<char> = keys.chars().collect();
    let mut strokes = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let glyph = chars[index];
        if glyph == '\r' || glyph == '\n' {
            if glyph == '\r' && chars.get(index + 1) == Some(&'\n') {
                index += 1;
            }
            strokes.push(Stroke::Key(0x0D));
        } else if glyph == '{' {
            if chars[index..].starts_with(&['{', '{', '}']) {
                strokes.push(Stroke::Char('{'));
                index += 2;
            } else if chars[index..].starts_with(&['{', '}', '}']) {
                strokes.push(Stroke::Char('}'));
                index += 2;
            } else {
                let Some(length) = chars[index + 1..].iter().position(|c| *c == '}') else {
                    return Err(MsgError::plain("background_unsupported|unclosed background key token"));
                };
                let mut token: String = chars[index + 1..index + 1 + length].iter().collect::<String>().trim().to_uppercase();
                let mut repeat = 1;
                if let Some((name, count)) = token.rsplit_once(' ') {
                    if let Some(count) = count.parse::<u32>().ok().filter(|count| (1..=100).contains(count)) {
                        repeat = count;
                        token = name.to_string();
                    }
                }
                let key = named_virtual_key(&token)?;
                if key == 0x5B {
                    return Err(MsgError::plain("background_unsupported|the Windows key needs the real keyboard; use explicit foreground delivery"));
                }
                strokes.extend((0..repeat).map(|_| Stroke::Key(key)));
                index += length + 1;
            }
        } else if "^%+~()#".contains(glyph) {
            // A stream that is nothing but the symbol means the character itself.
            if chars.len() == 1 {
                strokes.push(Stroke::Char(glyph));
            } else {
                return Err(MsgError::plain("background_unsupported|background keyboard does not support SendKeys modifiers/groups; use explicit foreground delivery"));
            }
        } else {
            strokes.push(Stroke::Char(glyph));
        }
        index += 1;
    }
    Ok(strokes)
}

fn extended_virtual_key(vk: u16) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2D | 0x2E)
}

/// The character a physical press of these keys makes: a sent key never passes
/// the target's translate loop, and edit controls act on Enter, Tab,
/// Backspace, Escape and Space only through it.
fn translated_character(vk: u16) -> Option<usize> {
    match vk {
        0x08 => Some(0x08),
        0x09 => Some(0x09),
        0x0D => Some(0x0D),
        0x1B => Some(0x1B),
        0x20 => Some(0x20),
        _ => None,
    }
}

fn background_virtual_key(target: Wid, vk: u16) -> Result<(), String> {
    // SAFETY: a plain table lookup.
    let scan = unsafe { MapVirtualKeyW(vk as u32, windows::Win32::UI::Input::KeyboardAndMouse::MAP_VIRTUAL_KEY_TYPE(0)) } as isize;
    let state = 1 | (scan << 16) | if extended_virtual_key(vk) { 1 << 24 } else { 0 };
    let released = state | (0xC000_0000u32 as i32 as isize);
    // Tk derives the editing action from the key itself and repeats it for the
    // character, so it receives the key alone.
    let translated = if native::class_name(target).starts_with("Tk") {
        None
    } else {
        translated_character(vk)
    };
    let release = bound(target, move || {
        send(target, WM_KEYUP, vk as usize, released).map(|_| ())
    });
    with_release(
        || {
            send(target, WM_KEYDOWN, vk as usize, state)?;
            if let Some(character) = translated {
                send(target, WM_CHAR, character, state)?;
            }
            Ok(())
        },
        || Ok(()),
        &release,
    )
}

fn background_char(target: Wid, glyph: char) -> Msg {
    let mut units = [0u16; 2];
    for unit in glyph.encode_utf16(&mut units).iter() {
        send(target, WM_CHAR, *unit as usize, 1)?;
    }
    Ok(())
}

impl WinBackground {
    /// Keys for `preferred`, the ref's exact child; 0 is the focused control
    /// (BackgroundKeys, MixWin32Keyboard.cs:652-667).
    pub(super) fn send_keys_to(&self, window: Wid, preferred: Wid, keys: &str) -> Result<String, String> {
        let strokes = parse_keys(keys).map_err(|error| error.text)?;
        refuse_dropped(window, preferred, drops::Kind::Key)?;
        self.while_inactive(window, || {
            let target = keyboard_target(window, preferred).map_err(|error| error.text)?;
            for stroke in strokes {
                match stroke {
                    Stroke::Char(glyph) => background_char(target, glyph).map_err(|error| error.text)?,
                    Stroke::Key(vk) => background_virtual_key(target, vk)?,
                }
            }
            Ok(window_id(target))
        })
    }

    /// Text for `preferred`, the ref's exact child; 0 is the focused control
    /// (BackgroundText, MixWin32Keyboard.cs:491-505).
    pub(super) fn send_text_to(&self, window: Wid, preferred: Wid, text: &str) -> Result<String, String> {
        refuse_dropped(window, preferred, drops::Kind::Text)?;
        self.while_inactive(window, || {
            let target = keyboard_target(window, preferred).map_err(|error| error.text)?;
            for glyph in text.chars() {
                match glyph {
                    '\n' => background_virtual_key(target, 0x0D)?,
                    '\r' => {}
                    other => background_char(target, other).map_err(|error| error.text)?,
                }
            }
            Ok(window_id(target))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_streams_parse_before_any_delivery() {
        let strokes = parse_keys("ab{ENTER 2}{{}").unwrap();
        assert_eq!(
            strokes,
            vec![
                Stroke::Char('a'),
                Stroke::Char('b'),
                Stroke::Key(0x0D),
                Stroke::Key(0x0D),
                Stroke::Char('{'),
            ]
        );
        assert!(parse_keys("^c").is_err());
        assert!(parse_keys("{WIN}").is_err());
        assert!(parse_keys("{NOPE}").is_err());
        assert_eq!(parse_keys("+").unwrap(), vec![Stroke::Char('+')]);
    }

    struct Fake {
        windows: Vec<Wid>,
        foreign: Vec<Wid>,
        classes: Vec<(Wid, &'static str)>,
        focus: Vec<(Wid, u32)>,
    }

    impl KeyboardWorld for Fake {
        fn is_window(&self, window: Wid) -> bool {
            self.windows.contains(&window)
        }
        fn belongs_to_top(&self, _top: Wid, candidate: Wid) -> bool {
            self.windows.contains(&candidate) && !self.foreign.contains(&candidate)
        }
        fn class_name(&self, window: Wid) -> String {
            self.classes.iter().find(|(id, _)| *id == window).map_or("Edit", |(_, class)| class).to_string()
        }
        fn focus_candidates(&self, _top: Wid) -> Vec<(Wid, u32)> {
            self.focus.clone()
        }
    }

    fn world() -> Fake {
        Fake { windows: vec![1, 2, 3, 9], foreign: vec![9], classes: vec![], focus: vec![] }
    }

    fn code(result: Msg<Wid>) -> String {
        result.unwrap_err().text.split('|').next().unwrap().to_string()
    }

    #[test]
    fn keyboard_target_decisions() {
        let mut fake = world();
        // The ref's child wins over whatever has focus.
        fake.focus = vec![(2, 1)];
        assert_eq!(keyboard_target_in(&fake, 1, 3).unwrap(), 3);
        assert_eq!(keyboard_target_in(&fake, 1, 0).unwrap(), 2);
        // No focus anywhere: the top itself.
        fake.focus.clear();
        assert_eq!(keyboard_target_in(&fake, 1, 0).unwrap(), 1);
        // A child of another window, a stale top.
        assert_eq!(code(keyboard_target_in(&fake, 1, 9)), "target_mismatch");
        assert_eq!(code(keyboard_target_in(&fake, 7, 0)), "stale_target");
        // Two focused children at one depth are ambiguous; a deeper one wins.
        fake.focus = vec![(2, 1), (3, 1)];
        assert_eq!(code(keyboard_target_in(&fake, 1, 0)), "background_target_ambiguous");
        fake.focus = vec![(2, 1), (3, 2)];
        assert_eq!(keyboard_target_in(&fake, 1, 0).unwrap(), 3);
    }

    #[test]
    fn keyboard_target_class_checks() {
        let mut fake = world();
        fake.classes = vec![(2, "Chrome_RenderWidgetHostHWND"), (1, "TkTopLevel"), (3, "Edit")];
        assert_eq!(code(keyboard_target_in(&fake, 1, 2)), "background_unsupported");
        assert_eq!(keyboard_target_in(&fake, 1, 3).unwrap(), 3);
        // A Tk frame with nothing focused would swallow the keys.
        assert_eq!(code(keyboard_target_in(&fake, 1, 0)), "background_unsupported");
        assert_eq!(code(keyboard_target_in(&fake, 1, 1)), "background_unsupported");
    }
}
