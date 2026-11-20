//! Kitty keyboard protocol decoding: `CSI codepoint ; modifiers [: eventType] [; text-as-codepoints] u`, and the legacy
//! special keys that carry an `:eventType` field (`CSI 1 ; 1:1 A`). The sequences xterm's modifyOtherKeys sends
//! (`CSI 27 ; mod ; key ~`) are not decoded here: the Ink fork delivers them as raw input and the prompt editor
//! recognises the ones it uses.
//!
//! See <https://sw.kovidgoyal.net/kitty/keyboard-protocol/>.

use super::keypress::{KeyEventType, Keypress, Scanner, digits_value, to_int32};

/// Kitty keyboard protocol flags (the bits of `CSI > flags u`).
pub mod flags {
    pub const DISAMBIGUATE_ESCAPE_CODES: u32 = 1;
    pub const REPORT_EVENT_TYPES: u32 = 2;
    pub const REPORT_ALTERNATE_KEYS: u32 = 4;
    pub const REPORT_ALL_KEYS_AS_ESCAPE_CODES: u32 = 8;
    pub const REPORT_ASSOCIATED_TEXT: u32 = 16;
}

/// Kitty modifier bits of the modifier parameter of a CSI u sequence. The wire value is the bits plus one.
pub mod modifiers {
    pub const SHIFT: i32 = 1;
    pub const ALT: i32 = 2;
    pub const CTRL: i32 = 4;
    pub const SUPER: i32 = 8;
    pub const HYPER: i32 = 16;
    pub const META: i32 = 32;
    pub const CAPS_LOCK: i32 = 64;
    pub const NUM_LOCK: i32 = 128;
}

/// The fields of a kitty CSI u match: codepoint, modifiers, event type and text, each as the digits the sequence carried.
pub(super) struct KittyKeyMatch<'a> {
    pub codepoint: &'a str,
    pub modifiers: Option<&'a str>,
    pub event_type: Option<&'a str>,
    pub text: Option<&'a str>,
}

/// `^\x1b\[(\d+)(?:;(\d+)(?::(\d+))?(?:;([\d:]+))?)?u$`
pub(super) fn match_kitty_key(s: &str) -> Option<KittyKeyMatch<'_>> {
    let mut sc = Scanner::new(s);
    if !sc.eat_str("\x1b[") {
        return None;
    }
    let codepoint = sc.digits()?;
    let mut out = KittyKeyMatch { codepoint, modifiers: None, event_type: None, text: None };
    if sc.eat(b';') {
        out.modifiers = Some(sc.digits()?);
        if sc.eat(b':') {
            out.event_type = Some(sc.digits()?);
        }
        if sc.eat(b';') {
            let start = sc.i;
            while matches!(sc.peek(), Some(b'0'..=b'9' | b':')) {
                sc.i += 1;
            }
            if sc.i == start {
                return None;
            }
            out.text = Some(sc.slice(start, sc.i));
        }
    }
    if sc.eat(b'u') && sc.at_end() { Some(out) } else { None }
}

/// `^\x1b\[(\d+);(\d+):(\d+)([A-Za-z~])$`
fn match_kitty_special(s: &str) -> Option<(&str, &str, &str, u8)> {
    let mut sc = Scanner::new(s);
    if !sc.eat_str("\x1b[") {
        return None;
    }
    let number = sc.digits()?;
    if !sc.eat(b';') {
        return None;
    }
    let modifiers = sc.digits()?;
    if !sc.eat(b':') {
        return None;
    }
    let event = sc.digits()?;
    let terminator = sc.peek()?;
    if !(terminator.is_ascii_alphabetic() || terminator == b'~') {
        return None;
    }
    sc.i += 1;
    if sc.at_end() { Some((number, modifiers, event, terminator)) } else { None }
}

/// Letter-terminated special key names (CSI 1 ; mods letter).
fn special_letter_key(terminator: u8) -> Option<&'static str> {
    Some(match terminator {
        b'A' => "up",
        b'B' => "down",
        b'C' => "right",
        b'D' => "left",
        b'E' => "clear",
        b'F' => "end",
        b'H' => "home",
        b'P' => "f1",
        b'Q' => "f2",
        b'R' => "f3",
        b'S' => "f4",
        _ => return None,
    })
}

/// Number-terminated special key names (CSI number ; mods ~).
fn special_number_key(number: f64) -> Option<&'static str> {
    Some(match number as i64 {
        _ if number.fract() != 0.0 || !number.is_finite() => return None,
        2 => "insert",
        3 => "delete",
        5 => "pageup",
        6 => "pagedown",
        7 => "home",
        8 => "end",
        11 => "f1",
        12 => "f2",
        13 => "f3",
        14 => "f4",
        15 => "f5",
        17 => "f6",
        18 => "f7",
        19 => "f8",
        20 => "f9",
        21 => "f10",
        23 => "f11",
        24 => "f12",
        _ => return None,
    })
}

/// Names of the codepoints 57409..=57454 (keypad, media, volume and modifier keys).
const PRIVATE_USE_NAMES: [&str; 46] = [
    "kpdecimal",
    "kpdivide",
    "kpmultiply",
    "kpsubtract",
    "kpadd",
    "kpenter",
    "kpequal",
    "kpseparator",
    "kpleft",
    "kpright",
    "kpup",
    "kpdown",
    "kppageup",
    "kppagedown",
    "kphome",
    "kpend",
    "kpinsert",
    "kpdelete",
    "kpbegin",
    "mediaplay",
    "mediapause",
    "mediaplaypause",
    "mediareverse",
    "mediastop",
    "mediafastforward",
    "mediarewind",
    "mediatracknext",
    "mediatrackprevious",
    "mediarecord",
    "lowervolume",
    "raisevolume",
    "mutevolume",
    "leftshift",
    "leftcontrol",
    "leftalt",
    "leftsuper",
    "lefthyper",
    "leftmeta",
    "rightshift",
    "rightcontrol",
    "rightalt",
    "rightsuper",
    "righthyper",
    "rightmeta",
    "isoLevel3Shift",
    "isoLevel5Shift",
];

/// Special codepoints to key names in the kitty protocol. 13 (return) and 32 (space) are handled before this lookup so
/// they can be marked printable.
fn codepoint_name(codepoint: u32) -> Option<String> {
    Some(match codepoint {
        27 => "escape".to_string(),
        9 => "tab".to_string(),
        127 | 8 => "backspace".to_string(),
        57358 => "capslock".to_string(),
        57359 => "scrolllock".to_string(),
        57360 => "numlock".to_string(),
        57361 => "printscreen".to_string(),
        57362 => "pause".to_string(),
        57363 => "menu".to_string(),
        57376..=57398 => format!("f{}", codepoint - 57376 + 13),
        57399..=57408 => format!("kp{}", codepoint - 57399),
        57409..=57454 => PRIVATE_USE_NAMES[(codepoint - 57409) as usize].to_string(),
        _ => return None,
    })
}

/// Valid Unicode codepoint range, excluding surrogates. NaN and infinities are never valid.
fn is_valid_codepoint(cp: f64) -> bool {
    (0.0..=1_114_111.0).contains(&cp) && !(55_296.0..=57_343.0).contains(&cp)
}

fn safe_from_code_point(cp: f64) -> String {
    if is_valid_codepoint(cp) { char::from_u32(cp as u32).map_or_else(|| "?".to_string(), |c| c.to_string()) } else { "?".to_string() }
}

fn resolve_event_type(value: f64) -> KeyEventType {
    if value == 3.0 {
        KeyEventType::Release
    } else if value == 2.0 {
        KeyEventType::Repeat
    } else {
        KeyEventType::Press
    }
}

/// `Math.max(0, parseInt(field) - 1)` as the integer the bit tests see.
fn modifier_bits(field: Option<&str>) -> i32 {
    field.map_or(0, |digits| to_int32((digits_value(digits) - 1.0).max(0.0)))
}

fn with_modifiers(bits: i32, event_type: KeyEventType, sequence: &str) -> Keypress {
    Keypress {
        ctrl: bits & modifiers::CTRL != 0,
        shift: bits & modifiers::SHIFT != 0,
        meta: bits & (modifiers::META | modifiers::ALT) != 0,
        sup: bits & modifiers::SUPER != 0,
        hyper: bits & modifiers::HYPER != 0,
        caps_lock: bits & modifiers::CAPS_LOCK != 0,
        num_lock: bits & modifiers::NUM_LOCK != 0,
        event_type: Some(event_type),
        sequence: sequence.to_string(),
        is_kitty: true,
        ..Keypress::default()
    }
}

/// A kitty CSI u key, or `None` when the sequence is not one or carries an invalid primary codepoint.
pub(super) fn parse_kitty_keypress(s: &str) -> Option<Keypress> {
    let m = match_kitty_key(s)?;
    let codepoint = digits_value(m.codepoint);
    let event_type = m.event_type.map_or(1.0, digits_value);
    // Bail on invalid primary codepoint.
    if !is_valid_codepoint(codepoint) {
        return None;
    }
    let cp = codepoint as u32;
    // Text-as-codepoints field: colon-separated Unicode codepoints.
    let mut text =
        m.text.map(|field| field.split(':').map(|part| safe_from_code_point(if part.is_empty() { f64::NAN } else { digits_value(part) })).collect::<String>());

    let (name, is_printable) = if cp == 32 {
        ("space".to_string(), true)
    } else if cp == 13 {
        ("return".to_string(), true)
    } else if let Some(name) = codepoint_name(cp) {
        (name, false)
    } else if (1..=26).contains(&cp) {
        // Ctrl+letter comes as codepoint 1-26.
        (char::from_u32(cp + 96).map_or_else(String::new, |c| c.to_string()), false)
    } else {
        (safe_from_code_point(codepoint).to_lowercase(), true)
    };

    // Default text to the character from the codepoint when the protocol did not provide it, so keys like space and return
    // produce their expected text input (' ' and '\r' respectively).
    if is_printable && text.as_deref().is_none_or(str::is_empty) {
        text = Some(safe_from_code_point(codepoint));
    }
    let mut key = with_modifiers(modifier_bits(m.modifiers), resolve_event_type(event_type), s);
    key.name = name;
    key.is_printable = is_printable;
    key.text = text;
    Some(key)
}

/// Kitty-enhanced legacy special keys (arrows, function keys): the legacy CSI format with an added `:eventType` field.
pub(super) fn parse_kitty_special_key(s: &str) -> Option<Keypress> {
    let (number, mods, event_type, terminator) = match_kitty_special(s)?;
    let name = if terminator == b'~' { special_number_key(digits_value(number)) } else { special_letter_key(terminator) }?;
    let bits = modifier_bits(Some(mods));
    let mut key = with_modifiers(bits, resolve_event_type(digits_value(event_type)), s);
    key.name = name.to_string();
    Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csi_u_letter_with_ctrl_and_release() {
        let k = parse_kitty_keypress("\x1b[97;5:3u").unwrap();
        assert_eq!(k.name, "a");
        assert!(k.ctrl && !k.shift && !k.meta);
        assert_eq!(k.event_type, Some(KeyEventType::Release));
        assert!(k.is_kitty && k.is_printable);
        assert_eq!(k.text.as_deref(), Some("a"));
    }

    #[test]
    fn return_and_space_are_printable() {
        let k = parse_kitty_keypress("\x1b[13u").unwrap();
        assert_eq!((k.name.as_str(), k.text.as_deref(), k.is_printable), ("return", Some("\r"), true));
        let k = parse_kitty_keypress("\x1b[32;2u").unwrap();
        assert_eq!((k.name.as_str(), k.text.as_deref(), k.shift), ("space", Some(" "), true));
    }

    #[test]
    fn explicit_text_field_replaces_the_default() {
        let k = parse_kitty_keypress("\x1b[97;1;65:66u").unwrap();
        assert_eq!(k.text.as_deref(), Some("AB"));
    }

    #[test]
    fn control_codepoints_map_to_letters() {
        let k = parse_kitty_keypress("\x1b[3u").unwrap();
        assert_eq!((k.name.as_str(), k.is_printable), ("c", false));
        assert_eq!(parse_kitty_keypress("\x1b[27u").unwrap().name, "escape");
        assert_eq!(parse_kitty_keypress("\x1b[127u").unwrap().name, "backspace");
        assert_eq!(parse_kitty_keypress("\x1b[57376u").unwrap().name, "f13");
        assert_eq!(parse_kitty_keypress("\x1b[57399u").unwrap().name, "kp0");
        assert_eq!(parse_kitty_keypress("\x1b[57454u").unwrap().name, "isoLevel5Shift");
    }

    #[test]
    fn invalid_codepoints_are_rejected() {
        assert!(parse_kitty_keypress("\x1b[1114112u").is_none());
        assert!(parse_kitty_keypress("\x1b[55296u").is_none());
        assert!(match_kitty_key("\x1b[1114112u").is_some());
    }

    #[test]
    fn special_keys_with_event_type() {
        let k = parse_kitty_special_key("\x1b[1;1:3A").unwrap();
        assert_eq!((k.name.as_str(), k.event_type), ("up", Some(KeyEventType::Release)));
        let k = parse_kitty_special_key("\x1b[3;5:1~").unwrap();
        assert_eq!((k.name.as_str(), k.ctrl), ("delete", true));
        assert!(parse_kitty_special_key("\x1b[99;1:1~").is_none());
        assert!(parse_kitty_special_key("\x1b[1;1:1Z").is_none());
    }

    #[test]
    fn modifier_bits_decode() {
        let k = parse_kitty_keypress("\x1b[97;256u").unwrap();
        assert!(k.ctrl && k.shift && k.meta && k.sup && k.hyper && k.caps_lock && k.num_lock);
    }

    #[test]
    fn near_misses_do_not_match() {
        assert!(match_kitty_key("\x1b[97;u").is_none());
        assert!(match_kitty_key("\x1b[97;5;u").is_none());
        assert!(match_kitty_key("\x1b[97u ").is_none());
        assert!(match_kitty_key("[97u").is_none());
    }
}
