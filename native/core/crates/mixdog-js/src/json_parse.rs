//! `JSON.parse(text)` over a [`serde_json::Value`], with V8's acceptance and values.
//!
//! What differs from `serde_json::from_str`, and matters for a file `JSON.stringify` wrote:
//! - a lone surrogate escape (`"\ud83d"`, what `JSON.stringify` writes for text cut inside a
//!   pair) is valid. A Rust `String` cannot hold one, so the parsed text carries it in-band
//!   behind a reserved escape character ESC = U+F0000: a lone surrogate is ESC and its four
//!   lowercase hex digits (`ESC d83d`), and a genuine ESC is doubled (`ESC ESC`). Decoding reads
//!   left to right and is exact for every parsed text, genuine private use characters included;
//!   [`crate::json_stringify_indent_parsed`] writes it back as `JSON.stringify` would. Text a
//!   program builds itself (not parsed) is written exactly when it holds no ESC; text that may
//!   hold one goes through [`crate::json_parsed_text`] first. The encoding is kept inside the
//!   parsed `String`s, so the rest of the code stays on `serde_json::Value`;
//! - nesting is unbounded (the parse keeps its own stack);
//! - every number is the double JavaScript reads: an integer past 2^53 is rounded, and one
//!   beyond the double range (`1e400`) is Infinity, which `JSON.stringify` writes as `null`, so
//!   it is `null` here;
//! - a duplicate key keeps its first position and takes the last value.

use serde_json::Map;
use serde_json::Number;
use serde_json::Value;

/// The escape character of the in-band encoding of parsed text.
const ESC: char = '\u{F0000}';

/// `text` as parsed text holds it: a genuine ESC doubled.
pub fn parsed_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    push_text(&mut out, text);
    out
}

fn push_text(out: &mut String, text: &str) {
    for c in text.chars() {
        push_char(out, c);
    }
}

fn push_char(out: &mut String, c: char) {
    out.push(c);
    if c == ESC {
        out.push(ESC);
    }
}

/// What follows an ESC in parsed text, at the start of `rest`: a genuine ESC (`Escaped`), or a
/// lone surrogate's four hex digits (`Surrogate`); anything else is not parsed text's.
pub(crate) enum Escape {
    Escaped,
    Surrogate(u32),
}

/// The escape at the start of `rest` (the text after an ESC) and its length in bytes.
pub(crate) fn escape_at(rest: &str) -> Option<(Escape, usize)> {
    if rest.starts_with(ESC) {
        return Some((Escape::Escaped, ESC.len_utf8()));
    }
    let digits = rest.as_bytes().get(..4)?;
    if !digits.iter().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let unit = u32::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()?;
    (0xD800..0xE000).contains(&unit).then_some((Escape::Surrogate(unit), 4))
}

/// The UTF-16 code units JavaScript holds for parsed text, a lone surrogate as its own unit: what
/// `length`, `slice` and `<` work on.
pub fn parsed_utf16(text: &str) -> Vec<u16> {
    let mut units = Vec::with_capacity(text.len());
    let mut at = 0;
    while let Some(c) = text[at..].chars().next() {
        at += c.len_utf8();
        if c == ESC {
            match escape_at(&text[at..]) {
                Some((Escape::Escaped, len)) => {
                    at += len;
                }
                Some((Escape::Surrogate(unit), len)) => {
                    at += len;
                    units.push(unit as u16);
                    continue;
                }
                None => {}
            }
        }
        let mut buf = [0u16; 2];
        units.extend_from_slice(c.encode_utf16(&mut buf));
    }
    units
}

/// Parsed text holding `units` (the inverse of [`parsed_utf16`]): a lone surrogate in-band.
pub fn parsed_from_utf16(units: &[u16]) -> String {
    let mut out = String::with_capacity(units.len());
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(c) => push_char(&mut out, c),
            Err(lone) => {
                out.push(ESC);
                out.push_str(&format!("{:04x}", lone.unpaired_surrogate()));
            }
        }
    }
    out
}

/// True for the ESC character.
pub(crate) fn is_esc(c: char) -> bool {
    c == ESC
}

/// Why `JSON.parse` rejects a text; `at` is the byte offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonSyntaxError {
    pub message: &'static str,
    pub at: usize,
}

impl std::fmt::Display for JsonSyntaxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at position {}", self.message, self.at)
    }
}

impl std::error::Error for JsonSyntaxError {}

enum Frame {
    Array(Vec<Value>),
    Object { map: Map<String, Value>, key: Option<String> },
}

struct Parser<'a> {
    bytes: &'a [u8],
    text: &'a str,
    at: usize,
}

fn number_value(double: f64) -> Value {
    if !double.is_finite() {
        return Value::Null;
    }
    if double.fract() == 0.0 && double.abs() < 9.2e18 {
        // `-0` is 0 as well: `JSON.stringify(-0)` is "0".
        return Value::Number(Number::from(double as i64));
    }
    Number::from_f64(double).map_or(Value::Null, Value::Number)
}

impl Parser<'_> {
    fn fail<T>(&self, message: &'static str) -> Result<T, JsonSyntaxError> {
        Err(JsonSyntaxError { message, at: self.at })
    }

    fn skip_space(&mut self) {
        while matches!(self.bytes.get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn literal(&mut self, word: &str, value: Value) -> Result<Value, JsonSyntaxError> {
        if self.bytes[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Ok(value)
        } else {
            self.fail("Unexpected token")
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> Result<Value, JsonSyntaxError> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek() {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return self.fail("No number after minus sign"),
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return self.fail("Unterminated fractional number");
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return self.fail("Exponent part is missing a number");
            }
        }
        let double = self.text[start..self.at].parse::<f64>().unwrap_or(f64::NAN);
        Ok(number_value(double))
    }

    fn hex4(&mut self) -> Result<u32, JsonSyntaxError> {
        let digits = self.bytes.get(self.at..self.at + 4);
        let Some(code) = digits
            .filter(|d| d.iter().all(u8::is_ascii_hexdigit))
            .and_then(|d| u32::from_str_radix(std::str::from_utf8(d).unwrap_or(""), 16).ok())
        else {
            return self.fail("Bad Unicode escape");
        };
        self.at += 4;
        Ok(code)
    }

    /// The string whose opening quote is at `self.at`.
    fn string(&mut self) -> Result<String, JsonSyntaxError> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let run = self.at;
            while self.peek().is_some_and(|b| b != b'"' && b != b'\\' && b >= 0x20) {
                self.at += 1;
            }
            push_text(&mut out, &self.text[run..self.at]);
            match self.peek() {
                None => return self.fail("Unterminated string"),
                Some(b'"') => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.at += 1;
                    let Some(escape) = self.peek() else { return self.fail("Unterminated string") };
                    self.at += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            self.push_unit(&mut out, unit)?;
                        }
                        _ => {
                            self.at -= 1;
                            return self.fail("Bad escaped character");
                        }
                    }
                }
                Some(_) => return self.fail("Bad control character in string literal"),
            }
        }
    }

    /// A `\uXXXX` unit: a high surrogate followed by an escaped low one is the pair's
    /// character; any other surrogate stands alone (`ESC` and its hex digits).
    fn push_unit(&mut self, out: &mut String, unit: u32) -> Result<(), JsonSyntaxError> {
        if (0xD800..0xDC00).contains(&unit) && self.bytes[self.at..].starts_with(b"\\u") {
            let resume = self.at;
            self.at += 2;
            let low = self.hex4()?;
            if (0xDC00..0xE000).contains(&low) {
                push_char(out, char::from_u32(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)).unwrap_or('\u{fffd}'));
                return Ok(());
            }
            self.at = resume;
        }
        match char::from_u32(unit) {
            Some(c) => push_char(out, c),
            None => {
                out.push(ESC);
                out.push_str(&format!("{unit:04x}"));
            }
        }
        Ok(())
    }
}

/// `JSON.parse(text)`.
pub fn parse(text: &str) -> Result<Value, JsonSyntaxError> {
    let mut p = Parser { bytes: text.as_bytes(), text, at: 0 };
    let mut stack: Vec<Frame> = Vec::new();
    p.skip_space();
    loop {
        // A value starts here.
        let mut value = match p.peek() {
            Some(b'{') => {
                p.at += 1;
                p.skip_space();
                if p.peek() == Some(b'}') {
                    p.at += 1;
                    Value::Object(Map::new())
                } else {
                    if p.peek() != Some(b'"') {
                        return p.fail("Expected property name or '}'");
                    }
                    let key = p.string()?;
                    p.skip_space();
                    if p.peek() != Some(b':') {
                        return p.fail("Expected ':' after property name");
                    }
                    p.at += 1;
                    p.skip_space();
                    stack.push(Frame::Object { map: Map::new(), key: Some(key) });
                    continue;
                }
            }
            Some(b'[') => {
                p.at += 1;
                p.skip_space();
                if p.peek() == Some(b']') {
                    p.at += 1;
                    Value::Array(Vec::new())
                } else {
                    stack.push(Frame::Array(Vec::new()));
                    continue;
                }
            }
            Some(b'"') => Value::String(p.string()?),
            Some(b'-' | b'0'..=b'9') => p.number()?,
            Some(b't') => p.literal("true", Value::Bool(true))?,
            Some(b'f') => p.literal("false", Value::Bool(false))?,
            Some(b'n') => p.literal("null", Value::Null)?,
            None => return p.fail("Unexpected end of JSON input"),
            Some(_) => return p.fail("Unexpected token"),
        };
        // `value` is complete: hand it to the enclosing container, closing finished ones.
        loop {
            let Some(frame) = stack.last_mut() else {
                p.skip_space();
                return if p.at == p.bytes.len() { Ok(value) } else { p.fail("Unexpected non-whitespace character after JSON") };
            };
            p.skip_space();
            let closer = match frame {
                Frame::Array(items) => {
                    items.push(value);
                    b']'
                }
                Frame::Object { map, key } => {
                    map.insert(key.take().unwrap_or_default(), value);
                    b'}'
                }
            };
            match p.peek() {
                Some(b',') => {
                    p.at += 1;
                    p.skip_space();
                    if let Some(Frame::Object { key, .. }) = stack.last_mut() {
                        if p.peek() != Some(b'"') {
                            return p.fail("Expected double-quoted property name");
                        }
                        let next = p.string()?;
                        p.skip_space();
                        if p.peek() != Some(b':') {
                            return p.fail("Expected ':' after property name");
                        }
                        p.at += 1;
                        p.skip_space();
                        *key = Some(next);
                    }
                    break;
                }
                Some(c) if c == closer => {
                    p.at += 1;
                    value = match stack.pop() {
                        Some(Frame::Array(items)) => Value::Array(items),
                        Some(Frame::Object { map, .. }) => Value::Object(map),
                        None => unreachable!("a frame was just filled"),
                    };
                }
                None => return p.fail("Unexpected end of JSON input"),
                Some(_) => return p.fail("Expected ',' or a closing bracket"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::stringify_indent_parsed;

    /// `[input, {ok: JSON.stringify(JSON.parse(input), null, 2)} | {err: true}]` written by Node
    /// (`testdata/json_parse.mjs`).
    const ROWS: &str = include_str!("../testdata/json_parse.json");

    #[test]
    fn parse_and_rewrite_match_node() {
        let rows: Vec<(String, Value)> = serde_json::from_str(ROWS).expect("fixture");
        assert!(rows.len() > 60);
        for (input, expected) in rows {
            match (parse(&input), expected.get("ok")) {
                (Ok(value), Some(text)) => {
                    assert_eq!(Value::String(stringify_indent_parsed(&value, 2)), *text, "{input:?}");
                }
                (Err(_), None) => {}
                (got, _) => panic!("{input:?}: Node says {expected}, got {got:?}"),
            }
        }
    }

    #[test]
    fn nesting_has_no_limit() {
        let depth = 20_000;
        let text = format!("{}1{}", "[".repeat(depth), "]".repeat(depth));
        let mut value = parse(&text).unwrap();
        let mut seen = 0;
        while let Value::Array(mut items) = value {
            seen += 1;
            value = items.pop().unwrap();
        }
        assert_eq!(seen, depth);
        assert_eq!(value, Value::from(1));
    }

    #[test]
    fn a_lone_surrogate_is_written_back_as_its_escape() {
        let value = parse(r#"{"a":"x\ud83d","b":"\ude00y"}"#).unwrap();
        assert_eq!(stringify_indent_parsed(&value, 0), r#"{"a":"x\ud83d","b":"\ude00y"}"#);
    }

    #[test]
    fn genuine_escape_characters_and_surrogates_stay_apart() {
        // Both spellings of one key are two properties; the genuine ESC survives untouched.
        let value = parse("{\"\\ud800\":1,\"\u{f0000}\":2,\"\u{f0000}d800\":3}").unwrap();
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert_eq!(stringify_indent_parsed(&value, 0), "{\"\\ud800\":1,\"\u{f0000}\":2,\"\u{f0000}d800\":3}");
    }

    #[test]
    fn built_text_without_the_escape_character_is_exact_and_other_text_goes_through_parsed_text() {
        let plain = Value::from("a\u{f0001}b\u{e000}");
        assert_eq!(stringify_indent_parsed(&plain, 0), "\"a\u{f0001}b\u{e000}\"");
        let with_esc = Value::from(parsed_text("x\u{f0000}d800"));
        assert_eq!(stringify_indent_parsed(&with_esc, 0), "\"x\u{f0000}d800\"");
    }
}
