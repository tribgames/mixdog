//! Single-sequence keypress decoding (the Ink fork's `parse-keypress.js`) and the `(input, key)` pair its `useInput` hook
//! hands a handler (`hooks/use-input.js`), plus the raw-byte discard rules of the prompt editor (`key-signals.mjs`).
//!
//! A key is named from one token: a kitty CSI u sequence, a kitty-enhanced special key, or the legacy forms (control
//! bytes, meta by ESC prefix, CSI/SS3 names with the xterm modifier parameter). Sequences nothing here names, such as
//! xterm modifyOtherKeys (`CSI 27 ; mod ; key ~`), keep an empty name and reach the handler as raw input.

use super::kitty;

/// Kitty event type of a key; only kitty-protocol keys carry one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyEventType {
    Press,
    Repeat,
    Release,
}

/// One decoded keypress, before it is turned into the `(input, key)` pair.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Keypress {
    pub name: String,
    pub ctrl: bool,
    pub meta: bool,
    pub shift: bool,
    pub sup: bool,
    pub hyper: bool,
    pub caps_lock: bool,
    pub num_lock: bool,
    pub event_type: Option<KeyEventType>,
    pub sequence: String,
    pub is_kitty: bool,
    pub is_printable: bool,
    pub text: Option<String>,
}

/// The flags a handler receives next to the input text: what `useInput` builds from a keypress.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyFlags {
    pub up_arrow: bool,
    pub down_arrow: bool,
    pub left_arrow: bool,
    pub right_arrow: bool,
    pub page_down: bool,
    pub page_up: bool,
    pub home: bool,
    pub end: bool,
    pub return_key: bool,
    pub escape: bool,
    pub ctrl: bool,
    pub shift: bool,
    pub tab: bool,
    pub backspace: bool,
    pub delete: bool,
    pub meta: bool,
    pub super_key: bool,
    pub hyper: bool,
    pub caps_lock: bool,
    pub num_lock: bool,
    pub event_type: Option<KeyEventType>,
}

/// A cursor over the ASCII structure of a sequence. Every pattern the decoder recognises is ASCII, so it works on bytes.
pub(super) struct Scanner<'a> {
    bytes: &'a [u8],
    pub i: usize,
}

impl<'a> Scanner<'a> {
    pub fn new(s: &'a str) -> Self {
        Self::from_bytes(s.as_bytes())
    }

    pub fn from_bytes(bytes: &'a [u8]) -> Self {
        Self { bytes, i: 0 }
    }

    pub fn peek(&self) -> Option<u8> {
        self.bytes.get(self.i).copied()
    }

    pub fn at_end(&self) -> bool {
        self.i >= self.bytes.len()
    }

    pub fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    pub fn eat_str(&mut self, prefix: &str) -> bool {
        if self.bytes[self.i..].starts_with(prefix.as_bytes()) {
            self.i += prefix.len();
            true
        } else {
            false
        }
    }

    /// One or more ASCII digits; nothing is consumed when there is none.
    pub fn digits(&mut self) -> Option<&'a str> {
        let start = self.i;
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.i += 1;
        }
        if self.i == start { None } else { Some(self.slice(start, self.i)) }
    }

    pub fn slice(&self, from: usize, to: usize) -> &'a str {
        std::str::from_utf8(&self.bytes[from..to]).unwrap_or("")
    }
}

/// `parseInt` of a run of ASCII digits, as the floating point number JavaScript makes of it.
pub(super) fn digits_value(digits: &str) -> f64 {
    digits.parse::<f64>().unwrap_or(f64::INFINITY)
}

/// JavaScript's `ToInt32`, which every bitwise operator applies to its operands.
pub(super) fn to_int32(n: f64) -> i32 {
    if !n.is_finite() {
        return 0;
    }
    let wrapped = n.trunc().rem_euclid(4_294_967_296.0);
    (wrapped as u64 as u32) as i32
}

/// The key a legacy escape-sequence code names (the part of the sequence after the leading ESCs, without parameters).
fn key_name(code: &str) -> Option<&'static str> {
    Some(match code {
        // xterm/gnome ESC O letter, vt220-style ESC [ letter
        "OP" | "[P" | "[11~" => "f1",
        "OQ" | "[Q" | "[12~" => "f2",
        "OR" | "[R" | "[13~" => "f3",
        "OS" | "[S" | "[14~" => "f4",
        // from Cygwin and used in libuv
        "[[A" => "f1",
        "[[B" => "f2",
        "[[C" => "f3",
        "[[D" => "f4",
        "[[E" => "f5",
        // common
        "[15~" => "f5",
        "[17~" => "f6",
        "[18~" => "f7",
        "[19~" => "f8",
        "[20~" => "f9",
        "[21~" => "f10",
        "[23~" => "f11",
        "[24~" => "f12",
        // xterm ESC [ letter, ESC O letter, rxvt lowercase
        "[A" | "OA" | "[a" | "Oa" => "up",
        "[B" | "OB" | "[b" | "Ob" => "down",
        "[C" | "OC" | "[c" | "Oc" => "right",
        "[D" | "OD" | "[d" | "Od" => "left",
        "[E" | "OE" | "[e" | "Oe" => "clear",
        "[F" | "OF" => "end",
        "[H" | "OH" => "home",
        // xterm/rxvt ESC [ number ~, putty, rxvt (and the shift and ctrl variants `$` and `^`)
        "[1~" | "[7~" | "[7$" | "[7^" => "home",
        "[2~" | "[2$" | "[2^" => "insert",
        "[3~" | "[3$" | "[3^" => "delete",
        "[4~" | "[8~" | "[8$" | "[8^" => "end",
        "[5~" | "[[5~" | "[5$" | "[5^" => "pageup",
        "[6~" | "[[6~" | "[6$" | "[6^" => "pagedown",
        // misc.
        "[Z" => "tab",
        _ => return None,
    })
}

/// Names `useInput` blanks out of the input text: every legacy key name plus backspace.
fn is_non_alphanumeric_key(name: &str) -> bool {
    matches!(
        name,
        "f1" | "f2"
            | "f3"
            | "f4"
            | "f5"
            | "f6"
            | "f7"
            | "f8"
            | "f9"
            | "f10"
            | "f11"
            | "f12"
            | "up"
            | "down"
            | "right"
            | "left"
            | "clear"
            | "end"
            | "home"
            | "insert"
            | "delete"
            | "pageup"
            | "pagedown"
            | "tab"
            | "backspace"
    )
}

fn is_shift_code(code: &str) -> bool {
    matches!(code, "[a" | "[b" | "[c" | "[d" | "[e" | "[2$" | "[3$" | "[5$" | "[6$" | "[7$" | "[8$" | "[Z")
}

fn is_ctrl_code(code: &str) -> bool {
    matches!(code, "Oa" | "Ob" | "Oc" | "Od" | "Oe" | "[2^" | "[3^" | "[5^" | "[6^" | "[7^" | "[8^")
}

/// The groups of the legacy function-key pattern
/// `^(?:\x1b+)(O|N|\[|\[\[)(?:(\d+)(?:;(\d+))?([~^$])|(?:1;)?(\d+)?([a-zA-Z]))` (not anchored at the end).
struct FnKeyMatch<'a> {
    intro: &'a str,
    number: Option<&'a str>,
    modifier_a: Option<&'a str>,
    final_a: Option<&'a str>,
    modifier_b: Option<&'a str>,
    letter: Option<&'a str>,
}

fn match_fn_key_tail<'a>(s: &'a str, from: usize, intro: &'a str) -> Option<FnKeyMatch<'a>> {
    // First alternative: number, optional `;modifier`, one of `~^$`.
    let mut sc = Scanner::new(s);
    sc.i = from;
    if let Some(number) = sc.digits() {
        let after_number = sc.i;
        let mut modifier = None;
        if sc.eat(b';') {
            modifier = sc.digits();
            if modifier.is_none() {
                sc.i = after_number;
            }
        }
        if matches!(sc.peek(), Some(b'~' | b'^' | b'$')) {
            let at = sc.i;
            return Some(FnKeyMatch { intro, number: Some(number), modifier_a: modifier, final_a: Some(sc.slice(at, at + 1)), modifier_b: None, letter: None });
        }
    }
    // Second alternative: optional `1;`, optional number, one letter.
    let mut starts = Vec::with_capacity(2);
    if s[from..].starts_with("1;") {
        starts.push(from + 2);
    }
    starts.push(from);
    for start in starts {
        let mut sc = Scanner::new(s);
        sc.i = start;
        let modifier = sc.digits();
        if sc.peek().is_some_and(|b| b.is_ascii_alphabetic()) {
            let at = sc.i;
            return Some(FnKeyMatch { intro, number: None, modifier_a: None, final_a: None, modifier_b: modifier, letter: Some(sc.slice(at, at + 1)) });
        }
    }
    None
}

fn match_fn_key(s: &str) -> Option<FnKeyMatch<'_>> {
    let escapes = s.bytes().take_while(|&b| b == 0x1b).count();
    if escapes == 0 {
        return None;
    }
    let rest = &s[escapes..];
    // The alternatives of the first group are tried in order: O, N, `[`, then `[[`.
    let mut intros: Vec<&str> = Vec::with_capacity(2);
    if rest.starts_with('O') {
        intros.push(&rest[..1]);
    }
    if rest.starts_with('N') {
        intros.push(&rest[..1]);
    }
    if rest.starts_with('[') {
        intros.push(&rest[..1]);
        if rest.starts_with("[[") {
            intros.push(&rest[..2]);
        }
    }
    intros.into_iter().find_map(|intro| match_fn_key_tail(s, escapes + intro.len(), intro))
}

fn is_ascii_alnum_unit(unit: u16) -> bool {
    u8::try_from(unit).is_ok_and(|b| b.is_ascii_alphanumeric())
}

/// Decode one token into a keypress. Never fails: an unnamed sequence keeps an empty name.
pub fn parse_keypress(s: &str) -> Keypress {
    // Try the kitty keyboard protocol parsers first.
    if let Some(key) = kitty::parse_kitty_keypress(s) {
        return key;
    }
    if let Some(key) = kitty::parse_kitty_special_key(s) {
        return key;
    }
    // A sequence of the kitty CSI u shape that was rejected (an invalid codepoint) gets a safe empty keypress instead of
    // falling through to the legacy parsing.
    if kitty::match_kitty_key(s).is_some() {
        return Keypress { sequence: s.to_string(), is_kitty: true, ..Keypress::default() };
    }

    let mut key = Keypress { sequence: s.to_string(), ..Keypress::default() };
    let units: Vec<u16> = s.encode_utf16().collect();
    let single = units.first().copied().filter(|_| units.len() == 1);

    if s == "\r" || s == "\x1b\r" {
        // carriage return (or meta+return on macOS)
        key.name = "return".to_string();
        key.meta = units.len() == 2;
    } else if s == "\n" {
        // enter, should have been called linefeed
        key.name = "enter".to_string();
    } else if s == "\t" {
        key.name = "tab".to_string();
    } else if s == "\x08" || s == "\x1b\x08" || s == "\x7f" || s == "\x1b\x7f" {
        // backspace or ctrl+h, backspace
        key.name = "backspace".to_string();
        key.meta = s.starts_with('\x1b');
    } else if s == "\x1b" || s == "\x1b\x1b" {
        // escape key
        key.name = "escape".to_string();
        key.meta = units.len() == 2;
    } else if s == " " || s == "\x1b " {
        key.name = "space".to_string();
        key.meta = units.len() == 2;
    } else if let Some(unit) = single.filter(|&u| u <= 0x1a) {
        // ctrl+letter
        key.name = char::from_u32(u32::from(unit) + 96).map_or_else(String::new, |c| c.to_string());
        key.ctrl = true;
    } else if single.is_some_and(|u| (0x30..=0x39).contains(&u)) {
        key.name = "number".to_string();
    } else if let Some(unit) = single.filter(|u| (0x61..=0x7a).contains(u)) {
        key.name = char::from(unit as u8).to_string();
    } else if let Some(unit) = single.filter(|u| (0x41..=0x5a).contains(u)) {
        key.name = char::from(unit as u8).to_ascii_lowercase().to_string();
        key.shift = true;
    } else if units.len() == 2 && units[0] == 0x1b && is_ascii_alnum_unit(units[1]) {
        // meta+character key
        let ch = char::from(units[1] as u8);
        key.name = ch.to_ascii_lowercase().to_string();
        key.meta = true;
        key.shift = ch.is_ascii_uppercase();
    } else if let Some(parts) = match_fn_key(s) {
        // ansi escape sequence
        let escapes_double = units.len() >= 2 && units[0] == 0x1b && units[1] == 0x1b;
        if escapes_double {
            key.meta = true;
        }
        // Reassemble the key code leaving out the leading ESCs, the modifier parameter and any meaningless "1;".
        let code: String = [parts.intro, parts.number.unwrap_or(""), parts.final_a.unwrap_or(""), parts.letter.unwrap_or("")].concat();
        let modifier_field = parts.modifier_a.or(parts.modifier_b);
        let modifier = to_int32(modifier_field.map_or(1.0, digits_value) - 1.0);
        key.ctrl = modifier & 4 != 0;
        key.meta = key.meta || modifier & 10 != 0;
        key.shift = modifier & 1 != 0;
        key.name = key_name(&code).unwrap_or("").to_string();
        key.shift = is_shift_code(&code) || key.shift;
        key.ctrl = is_ctrl_code(&code) || key.ctrl;
    }
    key
}

/// The `(input, key)` pair a handler receives for one key sequence.
pub fn decode_key(sequence: &str) -> (String, KeyFlags) {
    let keypress = parse_keypress(sequence);
    let mut key = key_flags(&keypress);
    let input = key_input(&keypress);
    if input.len() == 1 && input.as_bytes()[0].is_ascii_uppercase() {
        key.shift = true;
    }
    (input, key)
}

fn key_flags(keypress: &Keypress) -> KeyFlags {
    KeyFlags {
        up_arrow: keypress.name == "up",
        down_arrow: keypress.name == "down",
        left_arrow: keypress.name == "left",
        right_arrow: keypress.name == "right",
        page_down: keypress.name == "pagedown",
        page_up: keypress.name == "pageup",
        home: keypress.name == "home",
        end: keypress.name == "end",
        return_key: keypress.name == "return",
        escape: keypress.name == "escape",
        ctrl: keypress.ctrl,
        shift: keypress.shift,
        tab: keypress.name == "tab",
        backspace: keypress.name == "backspace",
        delete: keypress.name == "delete",
        meta: keypress.meta,
        super_key: keypress.sup,
        hyper: keypress.hyper,
        caps_lock: keypress.caps_lock,
        num_lock: keypress.num_lock,
        event_type: keypress.event_type,
    }
}

fn key_input(keypress: &Keypress) -> String {
    let mut input = if keypress.is_kitty {
        // The text-as-codepoints field of printable keys (needed when every key is reported as an escape code); not
        // printable text is suppressed, except that Ctrl+letter keeps its letter so `input == "c" && key.ctrl` still works.
        if keypress.is_printable {
            keypress.text.clone().unwrap_or_else(|| keypress.name.clone())
        } else if keypress.ctrl && keypress.name.encode_utf16().count() == 1 {
            keypress.name.clone()
        } else {
            String::new()
        }
    } else if keypress.ctrl {
        keypress.name.clone()
    } else {
        keypress.sequence.clone()
    };
    if !keypress.is_kitty && is_non_alphanumeric_key(&keypress.name) {
        input.clear();
    }
    // Strip the escape prefix of a broken or incomplete sequence nothing resolved (a flushed "ESC [").
    if let Some(stripped) = input.strip_prefix('\x1b') {
        input = stripped.to_string();
    }
    input
}

/// A terminal that volunteers a CSI private reply or a fragment of one (`ESC [ ? 7 u`, `[?1;0c`, with the ESC possibly
/// stripped) must never have it typed into the prompt. The required `?` after `[` keeps real kitty key events (no `?`)
/// out of it; the optional final byte also discards a partial fragment.
/// `^(?:\x1b)?\[\?[\d;]*[uc]?$`
pub fn is_csi_private_reply(raw: &str) -> bool {
    let body = raw.strip_prefix('\x1b').unwrap_or(raw);
    let Some(rest) = body.strip_prefix("[?") else {
        return false;
    };
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_digit() || c == ';');
    matches!(rest, "" | "u" | "c")
}

/// Ctrl+Space raw encodings (a lone NUL, or the kitty CSI-u form `ESC [ 32 ; 5 u`) are swallowed as a no-op so they never
/// fall into the prompt as garbage.
pub fn is_discarded_control_input(raw: &str) -> bool {
    raw == "\0" || raw.strip_prefix('\x1b').unwrap_or(raw) == "[32;5u"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(names: &[&str]) -> KeyFlags {
        let mut f = KeyFlags::default();
        for name in names {
            match *name {
                "up" => f.up_arrow = true,
                "down" => f.down_arrow = true,
                "left" => f.left_arrow = true,
                "right" => f.right_arrow = true,
                "return" => f.return_key = true,
                "escape" => f.escape = true,
                "ctrl" => f.ctrl = true,
                "shift" => f.shift = true,
                "tab" => f.tab = true,
                "backspace" => f.backspace = true,
                "delete" => f.delete = true,
                "meta" => f.meta = true,
                "home" => f.home = true,
                "end" => f.end = true,
                "pageup" => f.page_up = true,
                "pagedown" => f.page_down = true,
                other => panic!("unknown flag {other}"),
            }
        }
        f
    }

    fn decoded(seq: &str) -> (String, KeyFlags) {
        decode_key(seq)
    }

    #[test]
    fn printable_text_passes_through() {
        assert_eq!(decoded("a"), ("a".to_string(), flags(&[])));
        assert_eq!(decoded("A"), ("A".to_string(), flags(&["shift"])));
        assert_eq!(decoded("한"), ("한".to_string(), flags(&[])));
        assert_eq!(decoded("hello"), ("hello".to_string(), flags(&[])));
    }

    #[test]
    fn control_bytes() {
        assert_eq!(decoded("\r"), ("\r".to_string(), flags(&["return"])));
        assert_eq!(decoded("\x1b\r"), ("\r".to_string(), flags(&["return", "meta"])));
        assert_eq!(decoded("\t"), (String::new(), flags(&["tab"])));
        assert_eq!(decoded("\x03"), ("c".to_string(), flags(&["ctrl"])));
        assert_eq!(decoded("\x7f"), (String::new(), flags(&["backspace"])));
        assert_eq!(decoded("\x08"), (String::new(), flags(&["backspace"])));
        assert_eq!(decoded("\x1b"), (String::new(), flags(&["escape"])));
        assert_eq!(decoded("\n").1, flags(&[]));
        assert_eq!(decoded(" ").0, " ");
    }

    #[test]
    fn meta_letters() {
        assert_eq!(decoded("\x1bb"), ("b".to_string(), flags(&["meta"])));
        assert_eq!(decoded("\x1bB"), ("B".to_string(), flags(&["meta", "shift"])));
        assert_eq!(decoded("\x1b "), (" ".to_string(), flags(&["meta"])));
        assert_eq!(decoded("\x1b\x7f"), (String::new(), flags(&["backspace", "meta"])));
    }

    #[test]
    fn arrows_and_modifiers() {
        assert_eq!(decoded("\x1b[A"), (String::new(), flags(&["up"])));
        assert_eq!(decoded("\x1bOB"), (String::new(), flags(&["down"])));
        assert_eq!(decoded("\x1b[1;2C"), (String::new(), flags(&["right", "shift"])));
        assert_eq!(decoded("\x1b[1;5D"), (String::new(), flags(&["left", "ctrl"])));
        assert_eq!(decoded("\x1b[1;3A"), (String::new(), flags(&["up", "meta"])));
        assert_eq!(decoded("\x1b[1;6A"), (String::new(), flags(&["up", "ctrl", "shift"])));
        assert_eq!(decoded("\x1b[a"), (String::new(), flags(&["up", "shift"])));
        assert_eq!(decoded("\x1bOa"), (String::new(), flags(&["up", "ctrl"])));
        assert_eq!(decoded("\x1b[Z"), (String::new(), flags(&["tab", "shift"])));
    }

    #[test]
    fn navigation_keys_in_every_encoding() {
        for (seq, want) in [
            ("\x1b[H", "home"),
            ("\x1bOH", "home"),
            ("\x1b[1~", "home"),
            ("\x1b[7~", "home"),
            ("\x1b[F", "end"),
            ("\x1b[4~", "end"),
            ("\x1b[8~", "end"),
            ("\x1b[3~", "delete"),
            ("\x1b[5~", "pageup"),
            ("\x1b[[5~", "pageup"),
            ("\x1b[6~", "pagedown"),
        ] {
            assert_eq!(decoded(seq), (String::new(), flags(&[want])), "{seq:?}");
        }
        assert_eq!(decoded("\x1b[3;5~"), (String::new(), flags(&["delete", "ctrl"])));
        assert_eq!(decoded("\x1b[5$"), (String::new(), flags(&["pageup", "shift"])));
        assert_eq!(decoded("\x1b[5^"), (String::new(), flags(&["pageup", "ctrl"])));
    }

    #[test]
    fn function_keys_have_no_flags_and_no_input() {
        assert_eq!(parse_keypress("\x1bOP").name, "f1");
        assert_eq!(parse_keypress("\x1b[24~").name, "f12");
        assert_eq!(parse_keypress("\x1b[[E").name, "f5");
        assert_eq!(decoded("\x1b[15~").0, "");
    }

    #[test]
    fn double_escape_prefix_sets_meta() {
        let k = parse_keypress("\x1b\x1b[A");
        assert_eq!((k.name.as_str(), k.meta), ("up", true));
    }

    #[test]
    fn zero_modifier_parameter_sets_every_bit() {
        let k = parse_keypress("\x1b[1;0A");
        assert!(k.ctrl && k.meta && k.shift);
    }

    #[test]
    fn modify_other_keys_is_delivered_as_raw_input() {
        let (input, key) = decoded("\x1b[27;5;13~");
        assert_eq!(input, "[27;5;13~");
        assert_eq!(key, flags(&[]));
    }

    #[test]
    fn kitty_keys_use_text_and_keep_ctrl_letter() {
        let (input, key) = decoded("\x1b[97u");
        assert_eq!((input.as_str(), key.event_type), ("a", Some(KeyEventType::Press)));
        assert_eq!(decoded("\x1b[3;5u").0, "c");
        let (input, key) = decoded("\x1b[3;5u");
        assert_eq!((input.as_str(), key.ctrl), ("c", true));
        assert_eq!(decoded("\x1b[27u").0, "");
        let (_, key) = decoded("\x1b[97;1:3u");
        assert_eq!(key.event_type, Some(KeyEventType::Release));
        let (input, key) = decoded("\x1b[65;2u");
        assert_eq!((input.as_str(), key.shift), ("A", true));
        let (input, _) = decoded("\x1b[1114112u");
        assert_eq!(input, "");
    }

    #[test]
    fn an_unresolved_escape_loses_its_prefix() {
        assert_eq!(decoded("\x1b[").0, "[");
        assert_eq!(decoded("\x1b[M`!!").0, "[M`!!");
    }

    #[test]
    fn discard_rules() {
        assert!(is_csi_private_reply("\x1b[?1;0c"));
        assert!(is_csi_private_reply("[?7u"));
        assert!(is_csi_private_reply("[?"));
        assert!(is_csi_private_reply("\x1b[?62;"));
        assert!(!is_csi_private_reply("\x1b[97u"));
        assert!(!is_csi_private_reply("?7u"));
        assert!(!is_csi_private_reply("\x1b\x1b[?7u"));
        assert!(is_discarded_control_input("\0"));
        assert!(is_discarded_control_input("\x1b[32;5u"));
        assert!(is_discarded_control_input("[32;5u"));
        assert!(!is_discarded_control_input("\x1b[32;6u"));
    }
}
