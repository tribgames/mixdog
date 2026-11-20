//! Mouse reports: SGR (`CSI < button ; col ; row M|m`, mode 1006) and the legacy X10 form (`CSI M` and three bytes biased
//! by 32), as the Ink fork classifies them, and the SGR button-byte masks the gesture code reads.
//!
//! An SGR press, drag or release becomes a click report. A wheel report (button bit 0x40 with the direction in the low
//! bit) stays a key in the fork so the scroll path can route it; here it is the same report type with a wheel kind. An X10
//! wheel report is classified the same way; any other X10 report is not a mouse event for the fork and arrives as raw
//! key input.

use super::keypress::{Scanner, digits_value, to_int32};

/// Bit 2 (4) of the SGR button byte: shift held.
pub const MOUSE_SHIFT_MASK: i32 = 4;
/// Bit 3 (8): alt held.
pub const MOUSE_ALT_MASK: i32 = 8;
/// Bit 4 (16): ctrl held.
pub const MOUSE_CTRL_MASK: i32 = 16;
/// Bit 5 (32): the pointer moved with a button held (drag motion).
pub const MOUSE_MOTION_MASK: i32 = 32;
/// Bit 6 (64): wheel.
pub const MOUSE_WHEEL_MASK: i32 = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseKind {
    /// A button went down (`M` without the motion bit).
    Press,
    /// The pointer moved with a button held (`M` with the motion bit).
    Drag,
    /// A button went up (`m`).
    Release,
    WheelUp,
    WheelDown,
}

/// One decoded mouse report. `col` and `row` are the 0-based cell (the terminal counts from 1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MouseReport {
    pub kind: MouseKind,
    /// The raw button byte: the low two bits name the button, the rest are the modifier, motion and wheel bits.
    pub button: i32,
    pub col: i32,
    pub row: i32,
    pub shift: bool,
    pub alt: bool,
    pub ctrl: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum WheelDirection {
    Up,
    Down,
}

struct Sgr {
    button: i32,
    col: i32,
    row: i32,
    press: bool,
}

/// `^\x1b\[<(\d+);(\d+);(\d+)([Mm])$`
fn parse_sgr(s: &str) -> Option<Sgr> {
    let mut sc = Scanner::new(s);
    if !sc.eat_str("\x1b[<") {
        return None;
    }
    let button = sc.digits()?;
    if !sc.eat(b';') {
        return None;
    }
    let col = sc.digits()?;
    if !sc.eat(b';') {
        return None;
    }
    let row = sc.digits()?;
    let press = match sc.peek()? {
        b'M' => true,
        b'm' => false,
        _ => return None,
    };
    sc.i += 1;
    if !sc.at_end() {
        return None;
    }
    Some(Sgr { button: to_int32(digits_value(button)), col: to_int32(digits_value(col)), row: to_int32(digits_value(row)), press })
}

/// The button byte of an X10 report (`ESC [ M` and three bytes, six units in all).
fn x10_units(s: &str) -> Option<Vec<u16>> {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() == 6 && units[..3] == [0x1b, 0x5b, 0x4d] { Some(units) } else { None }
}

/// Wheel direction of a button byte: the wheel bit plus the direction bit, ignoring the modifier bits so modified wheel
/// events still classify.
fn wheel_of_button(button: i32) -> Option<WheelDirection> {
    match button & 0x43 {
        0x40 => Some(WheelDirection::Up),
        0x41 => Some(WheelDirection::Down),
        _ => None,
    }
}

/// Wheel direction of an SGR or X10 report sequence, or `None` when it is not a wheel report.
pub(super) fn wheel_direction(s: &str) -> Option<WheelDirection> {
    if let Some(sgr) = parse_sgr(s) {
        return wheel_of_button(sgr.button);
    }
    let units = x10_units(s)?;
    wheel_of_button(i32::from(units[3]) - 32)
}

/// An SGR click, drag or release (a wheel report is not one: it stays a key until routed), or `None`.
pub(super) fn click_report(s: &str) -> Option<MouseReport> {
    let sgr = parse_sgr(s)?;
    if sgr.button & MOUSE_WHEEL_MASK != 0 {
        return None;
    }
    let kind = if !sgr.press {
        MouseKind::Release
    } else if sgr.button & MOUSE_MOTION_MASK != 0 {
        MouseKind::Drag
    } else {
        MouseKind::Press
    };
    Some(report(kind, &sgr))
}

fn report(kind: MouseKind, sgr: &Sgr) -> MouseReport {
    MouseReport {
        kind,
        button: sgr.button,
        col: sgr.col.saturating_sub(1),
        row: sgr.row.saturating_sub(1),
        shift: sgr.button & MOUSE_SHIFT_MASK != 0,
        alt: sgr.button & MOUSE_ALT_MASK != 0,
        ctrl: sgr.button & MOUSE_CTRL_MASK != 0,
    }
}

/// The report of a wheel sequence `direction` was read from. An SGR report carries its modifiers; an X10 wheel report has
/// no modifier the scroll path reads (the fork takes the ctrl bit from the SGR form only), so none is set for it.
pub(super) fn wheel_report(s: &str, direction: WheelDirection) -> Option<MouseReport> {
    let kind = match direction {
        WheelDirection::Up => MouseKind::WheelUp,
        WheelDirection::Down => MouseKind::WheelDown,
    };
    if let Some(sgr) = parse_sgr(s) {
        return Some(report(kind, &sgr));
    }
    let units = x10_units(s)?;
    Some(MouseReport {
        kind,
        button: i32::from(units[3]) - 32,
        col: i32::from(units[4]) - 33,
        row: i32::from(units[5]) - 33,
        shift: false,
        alt: false,
        ctrl: false,
    })
}

/// The SGR report body `[<digits;digits;digits` and its final `M` or `m`, starting at the `[`; the end offset.
fn sgr_body_at(bytes: &[u8], at: usize) -> Option<usize> {
    if bytes.get(at) != Some(&b'[') {
        return None;
    }
    let mut sc = Scanner::from_bytes(bytes);
    sc.i = at;
    if !sc.eat_str("[<") {
        return None;
    }
    sc.digits()?;
    if !sc.eat(b';') {
        return None;
    }
    sc.digits()?;
    if !sc.eat(b';') {
        return None;
    }
    sc.digits()?;
    if !matches!(sc.peek(), Some(b'M' | b'm')) {
        return None;
    }
    Some(sc.i + 1)
}

/// SGR mouse-tracking sequences (wheel or click) must never be typed into the prompt. Matches with or without the leading
/// ESC (terminals and the fork may strip it): `CSI < ... M|m`, anywhere in the input, or the whole input as a fragment.
/// `(?:\x1b)?\[<\d+;\d+;\d+[Mm]` or `^\[?<\d+;\d+;\d+[Mm]?$`
pub fn is_mouse_report_sequence(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    if (0..bytes.len()).any(|at| sgr_body_at(bytes, at).is_some()) {
        return true;
    }
    let mut sc = Scanner::new(raw);
    sc.eat(b'[');
    if !sc.eat(b'<') {
        return false;
    }
    if sc.digits().is_none() || !sc.eat(b';') || sc.digits().is_none() || !sc.eat(b';') || sc.digits().is_none() {
        return false;
    }
    if matches!(sc.peek(), Some(b'M' | b'm')) {
        sc.i += 1;
    }
    sc.at_end()
}

/// Printable input: embedded SGR mouse sequences (partials that rode in with real text) and line breaks are removed.
pub fn printable_from_input(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut kept: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let body_at = match bytes[at] {
            0x1b => at + 1,
            b'[' => at,
            _ => {
                kept.push(bytes[at]);
                at += 1;
                continue;
            }
        };
        match sgr_body_at(bytes, body_at) {
            Some(end) => at = end,
            None => {
                kept.push(bytes[at]);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&kept).chars().filter(|c| !matches!(c, '\r' | '\n')).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sgr_press_drag_release() {
        let press = click_report("\x1b[<0;10;5M").unwrap();
        assert_eq!((press.kind, press.col, press.row, press.button), (MouseKind::Press, 9, 4, 0));
        let drag = click_report("\x1b[<32;11;5M").unwrap();
        assert_eq!(drag.kind, MouseKind::Drag);
        let release = click_report("\x1b[<0;11;5m").unwrap();
        assert_eq!(release.kind, MouseKind::Release);
        let right = click_report("\x1b[<2;1;1M").unwrap();
        assert_eq!((right.button & 3, right.col, right.row), (2, 0, 0));
    }

    #[test]
    fn modifier_bits() {
        let r = click_report("\x1b[<28;3;3M").unwrap();
        assert!(r.shift && r.alt && r.ctrl);
        assert_eq!(r.button & 3, 0);
        let r = click_report("\x1b[<4;3;3M").unwrap();
        assert!(r.shift && !r.alt && !r.ctrl);
    }

    #[test]
    fn wheel_is_not_a_click_but_a_wheel_report() {
        assert!(click_report("\x1b[<64;5;5M").is_none());
        let up = wheel_direction("\x1b[<64;5;5M").unwrap();
        assert!(up == WheelDirection::Up);
        let r = wheel_report("\x1b[<64;5;5M", up).unwrap();
        assert_eq!((r.kind, r.col, r.row, r.ctrl), (MouseKind::WheelUp, 4, 4, false));
        let down = wheel_direction("\x1b[<81;5;5M").unwrap();
        let r = wheel_report("\x1b[<81;5;5M", down).unwrap();
        assert_eq!((r.kind, r.ctrl), (MouseKind::WheelDown, true));
        // Horizontal wheel (66, 67) is neither.
        assert!(wheel_direction("\x1b[<66;5;5M").is_none());
        assert!(click_report("\x1b[<66;5;5M").is_none());
    }

    #[test]
    fn x10_wheel_only() {
        let up = "\x1b[M`!!";
        let direction = wheel_direction(up).unwrap();
        let r = wheel_report(up, direction).unwrap();
        assert_eq!((r.kind, r.col, r.row, r.ctrl), (MouseKind::WheelUp, 0, 0, false));
        assert!(wheel_direction("\x1b[M !!").is_none());
        assert!(wheel_direction("\x1b[M`!").is_none());
    }

    #[test]
    fn mouse_sequence_discard() {
        assert!(is_mouse_report_sequence("\x1b[<64;55;22M"));
        assert!(is_mouse_report_sequence("[<0;1;1m"));
        assert!(is_mouse_report_sequence("<0;1;1"));
        assert!(is_mouse_report_sequence("[<0;1;1"));
        assert!(is_mouse_report_sequence("ab[<0;1;1Mcd"));
        assert!(!is_mouse_report_sequence("[<0;1M"));
        assert!(!is_mouse_report_sequence("hello"));
        assert!(!is_mouse_report_sequence("[M`!!"));
    }

    #[test]
    fn printable_strips_mouse_and_line_breaks() {
        assert_eq!(printable_from_input("a\x1b[<0;1;1Mb[<1;2;3mc"), "abc");
        assert_eq!(printable_from_input("x\r\ny\n"), "xy");
        assert_eq!(printable_from_input("한\x1b[<0;1;1M글"), "한글");
        assert_eq!(printable_from_input("\x1b[<0;1M"), "\x1b[<0;1M");
    }
}
