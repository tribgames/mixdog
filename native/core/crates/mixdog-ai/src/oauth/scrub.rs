//! `scrubOAuthSecrets(text, secretValues)` (`providers/lib/oauth-token-utils.mjs`): the redaction every
//! provider error text and response excerpt passes before it leaves the process.
//!
//! A JSON object or array is redacted on its parsed form (so escaped key names cannot slip past a
//! pattern), numbers keep their source text, and an untouched body is returned as it came. Anything
//! else is redacted as text: JSON-like and form-encoded secret fields, bearer/JWT/Anthropic tokens
//! and the given values.
//!
//! One difference from Node that cannot be observed on a well-formed body: a lone surrogate escape
//! (`\ud800`) in a JSON string cannot be held by a Rust string and reads as U+FFFD.

use std::sync::LazyLock;

use regex::Regex;

const REDACTED: &str = "[REDACTED]";
const FIELD: &str = r"(?i-u:access_?token|refresh_?token|id_?token|client_?secret|code_?verifier|code_?challenge|device_?code|api_?key|token|key|secret|password|assertion)";
/// JavaScript's `\s`, as the body of a character class.
const SPACE: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

fn is_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

static SECRET_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("^{FIELD}$")).expect("constant pattern"));
/// `"field"\s*:\s*`, the start of a JSON-like secret field; its value is read by [`json_value_len`].
static JSON_FIELD: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r#""({FIELD})"[{SPACE}]*:[{SPACE}]*"#)).expect("constant pattern"));
static FORM_FIELD: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r#"(^|[^A-Za-z0-9_])({FIELD})=[^&"'{SPACE}]*"#)).expect("constant pattern"));
static BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u:Bearer) [A-Za-z0-9._-]+").expect("constant pattern"));
static SK_ANT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"sk-ant-[A-Za-z0-9._-]+").expect("constant pattern"));
static JWT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u:\b)eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?").expect("constant pattern"));

/// Redacts OAuth secrets from a body or message.
pub fn scrub_oauth_secrets(text: &str, secret_values: &[&str]) -> String {
    if let Some(json) = scrub_json(text, secret_values) {
        return json;
    }
    let text = replace_json_fields(text);
    let text = FORM_FIELD.replace_all(&text, |caps: &regex::Captures<'_>| format!("{}{}={REDACTED}", &caps[1], &caps[2]));
    scrub_token_text(&text, secret_values)
}

/// `scrubOAuthSecrets(text, secrets).slice(0, limit)`: the excerpt of a response body for a message.
pub fn scrubbed_prefix(text: &str, secret_values: &[&str], limit: usize) -> String {
    mixdog_js::slice_utf16(&scrub_oauth_secrets(text, secret_values), limit)
}

/// `scrubOAuthSecrets(text, secrets).trim().slice(0, limit)`.
pub fn scrubbed_excerpt(text: &str, secret_values: &[&str], limit: usize) -> String {
    mixdog_js::slice_utf16(mixdog_js::js_trim(&scrub_oauth_secrets(text, secret_values)), limit)
}

static MUSE_API_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r#""api_key"[{SPACE}]*:[{SPACE}]*"[^"]+""#)).expect("constant pattern"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("[{SPACE}]+")).expect("constant pattern"));

/// `scrubMuseSecrets` (`muse-code-oauth-tokens.mjs`): [`scrub_oauth_secrets`], then any `"api_key":"…"`.
pub fn scrub_muse_secrets(text: &str, secret_values: &[&str]) -> String {
    MUSE_API_KEY.replace_all(&scrub_oauth_secrets(text, secret_values), format!("\"api_key\":\"{REDACTED}\"").as_str()).into_owned()
}

/// `scrubMuseSecrets(text, secrets).slice(0, limit)`.
pub fn muse_prefix(text: &str, secret_values: &[&str], limit: usize) -> String {
    mixdog_js::slice_utf16(&scrub_muse_secrets(text, secret_values), limit)
}

/// `scrubMuseSecrets(text, secrets).trim().slice(0, limit)`.
pub fn muse_excerpt(text: &str, secret_values: &[&str], limit: usize) -> String {
    mixdog_js::slice_utf16(mixdog_js::js_trim(&scrub_muse_secrets(text, secret_values)), limit)
}

/// `oauthBodySummary`: a token endpoint's body for an error message, secrets redacted, whitespace
/// folded, shortened to 500.
pub fn oauth_body_summary(text: &str, secret_values: &[&str]) -> String {
    let folded = SPACES.replace_all(&scrub_oauth_secrets(text, secret_values), " ").into_owned();
    mixdog_js::slice_utf16(mixdog_js::js_trim(&folded), 500)
}

/// Bearer/JWT/Anthropic tokens and the given values, anywhere in `text`.
fn scrub_token_text(text: &str, secret_values: &[&str]) -> String {
    let text = BEARER.replace_all(text, format!("Bearer {REDACTED}").as_str());
    let text = SK_ANT.replace_all(&text, REDACTED);
    let scrubbed = JWT.replace_all(&text, REDACTED);
    // The values named, however the text encodes them (`carried`'s canonical view).
    super::carried::Matcher::of_secrets(secret_values).redact_str(&scrubbed)
}

/// `"field": value` with `value` a string (possibly cut off) or a bare non-numeric word, as one
/// `"field":"[REDACTED]"`.
fn replace_json_fields(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let (mut copied, mut search) = (0, 0);
    while let Some(found) = JSON_FIELD.captures_at(text, search) {
        let whole = found.get(0).expect("whole match");
        match json_value_len(&text[whole.end()..]) {
            Some(len) => {
                out.push_str(&text[copied..whole.start()]);
                out.push_str(&format!("\"{}\":\"{REDACTED}\"", &found[1]));
                copied = whole.end() + len;
                search = copied;
            }
            // The value is a number, a keyword or nothing: the search goes on one character later.
            None => search = whole.start() + text[whole.start()..].chars().next().map_or(1, char::len_utf8),
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// The length of the value at the start of `rest`: `"(?:[^"\\]|\\.)*"?`, else a run of non-delimiters
/// that does not begin as a number, `true`, `false` or `null`.
fn json_value_len(rest: &str) -> Option<usize> {
    let mut chars = rest.char_indices().peekable();
    if rest.starts_with('"') {
        chars.next();
        while let Some((at, c)) = chars.next() {
            match c {
                '"' => return Some(at + 1),
                '\\' => match chars.peek() {
                    // `.` does not match a line terminator: the string ends before the backslash.
                    Some(&(_, next)) if !matches!(next, '\n' | '\r' | '\u{2028}' | '\u{2029}') => {
                        chars.next();
                    }
                    _ => return Some(at),
                },
                _ => {}
            }
        }
        return Some(rest.len());
    }
    let lower = rest.to_ascii_lowercase();
    let digit_follows = |s: &str| s.as_bytes().first().is_some_and(u8::is_ascii_digit);
    if digit_follows(rest) || (rest.starts_with('-') && digit_follows(&rest[1..])) {
        return None;
    }
    for keyword in ["true", "false", "null"] {
        if lower.starts_with(keyword) && !rest[keyword.len()..].chars().next().is_some_and(is_word) {
            return None;
        }
    }
    let len = rest.find(|c: char| matches!(c, ',' | '}' | ']') || is_space(c)).unwrap_or(rest.len());
    (len > 0).then_some(len)
}

// -- the JSON path ---------------------------------------------------------------------

/// A parsed JSON value that keeps what `JSON.parse` + `JSON.stringify` keep: number source text, and
/// an object's property order (array-index keys first, ascending).
enum Node {
    Str(String),
    /// A number, as written.
    Raw(String),
    Lit(&'static str),
    Array(Vec<Node>),
    Object(Vec<(String, Node)>),
}

const DEPTH_LIMIT: usize = 1_000;

struct Parser<'a> {
    text: &'a str,
    at: usize,
}

impl Parser<'_> {
    fn space(&mut self) {
        while matches!(self.text.as_bytes().get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn eat(&mut self, expected: &str) -> bool {
        let found = self.text[self.at..].starts_with(expected);
        if found {
            self.at += expected.len();
        }
        found
    }

    fn value(&mut self, depth: usize) -> Option<Node> {
        if depth > DEPTH_LIMIT {
            return None;
        }
        self.space();
        let node = match *self.text.as_bytes().get(self.at)? {
            b'{' => {
                self.at += 1;
                let mut entries = Vec::new();
                self.space();
                if !self.eat("}") {
                    loop {
                        self.space();
                        let key = self.string()?;
                        self.space();
                        if !self.eat(":") {
                            return None;
                        }
                        entries.push((key, self.value(depth + 1)?));
                        self.space();
                        if self.eat("}") {
                            break;
                        }
                        if !self.eat(",") {
                            return None;
                        }
                    }
                }
                Node::Object(ordered(entries))
            }
            b'[' => {
                self.at += 1;
                let mut items = Vec::new();
                self.space();
                if !self.eat("]") {
                    loop {
                        items.push(self.value(depth + 1)?);
                        self.space();
                        if self.eat("]") {
                            break;
                        }
                        if !self.eat(",") {
                            return None;
                        }
                    }
                }
                Node::Array(items)
            }
            b'"' => Node::Str(self.string()?),
            b't' if self.eat("true") => Node::Lit("true"),
            b'f' if self.eat("false") => Node::Lit("false"),
            b'n' if self.eat("null") => Node::Lit("null"),
            _ => Node::Raw(self.number()?),
        };
        Some(node)
    }

    /// `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`
    fn number(&mut self) -> Option<String> {
        let bytes = self.text.as_bytes();
        let start = self.at;
        let digits = |at: &mut usize| {
            let from = *at;
            while bytes.get(*at).is_some_and(u8::is_ascii_digit) {
                *at += 1;
            }
            *at > from
        };
        let mut at = start;
        if bytes.get(at) == Some(&b'-') {
            at += 1;
        }
        if bytes.get(at) == Some(&b'0') {
            at += 1;
        } else if !digits(&mut at) {
            return None;
        }
        if bytes.get(at) == Some(&b'.') {
            at += 1;
            if !digits(&mut at) {
                return None;
            }
        }
        if matches!(bytes.get(at), Some(b'e' | b'E')) {
            at += 1;
            if matches!(bytes.get(at), Some(b'+' | b'-')) {
                at += 1;
            }
            if !digits(&mut at) {
                return None;
            }
        }
        self.at = at;
        Some(self.text[start..at].to_owned())
    }

    fn hex4(&mut self) -> Option<u32> {
        let digits = self.text.get(self.at..self.at + 4)?;
        let value = u32::from_str_radix(digits, 16).ok().filter(|_| digits.bytes().all(|b| b.is_ascii_hexdigit()))?;
        self.at += 4;
        Some(value)
    }

    fn string(&mut self) -> Option<String> {
        if !self.eat("\"") {
            return None;
        }
        let mut out = String::new();
        loop {
            let c = self.text[self.at..].chars().next()?;
            self.at += c.len_utf8();
            match c {
                '"' => return Some(out),
                c if (c as u32) < 0x20 => return None,
                '\\' => {
                    let escape = self.text[self.at..].chars().next()?;
                    self.at += escape.len_utf8();
                    match escape {
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        '/' => out.push('/'),
                        'b' => out.push('\u{8}'),
                        'f' => out.push('\u{C}'),
                        'n' => out.push('\n'),
                        'r' => out.push('\r'),
                        't' => out.push('\t'),
                        'u' => {
                            let unit = self.hex4()?;
                            let scalar = if (0xD800..0xDC00).contains(&unit) && self.text[self.at..].starts_with("\\u") {
                                let saved = self.at;
                                self.at += 2;
                                match self.hex4() {
                                    Some(low) if (0xDC00..0xE000).contains(&low) => char::from_u32(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)),
                                    _ => {
                                        self.at = saved;
                                        None
                                    }
                                }
                            } else {
                                char::from_u32(unit)
                            };
                            out.push(scalar.unwrap_or('\u{FFFD}'));
                        }
                        _ => return None,
                    }
                }
                c => out.push(c),
            }
        }
    }
}

fn is_array_index(key: &str) -> Option<u64> {
    if key.is_empty() || !key.bytes().all(|b| b.is_ascii_digit()) || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    key.parse::<u64>().ok().filter(|index| *index < u64::from(u32::MAX))
}
/// The properties of a JavaScript object built from `entries`: a repeated key keeps its first
/// position and its last value, and array-index keys come first in ascending order.
fn ordered(entries: Vec<(String, Node)>) -> Vec<(String, Node)> {
    let mut out: Vec<(String, Node)> = Vec::with_capacity(entries.len());
    for (key, value) in entries {
        match out.iter_mut().find(|(known, _)| *known == key) {
            Some(slot) => slot.1 = value,
            None => out.push((key, value)),
        }
    }
    let (mut indexed, rest): (Vec<_>, Vec<_>) = out.into_iter().partition(|(key, _)| is_array_index(key).is_some());
    indexed.sort_by_key(|(key, _)| is_array_index(key));
    indexed.into_iter().chain(rest).collect()
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write(out: &mut String, node: &Node) {
    match node {
        Node::Str(text) => write_string(out, text),
        Node::Raw(source) => out.push_str(source),
        Node::Lit(word) => out.push_str(word),
        Node::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(out, item);
            }
            out.push(']');
        }
        Node::Object(entries) => {
            out.push('{');
            for (i, (key, value)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write(out, value);
            }
            out.push('}');
        }
    }
}

/// `scrubJsonSecrets`: `None` when `text` is not a JSON object or array.
fn scrub_json(text: &str, secret_values: &[&str]) -> Option<String> {
    let mut parser = Parser { text, at: 0 };
    let parsed = parser.value(0)?;
    parser.space();
    if parser.at != text.len() || !matches!(parsed, Node::Array(_) | Node::Object(_)) {
        return None;
    }
    let mut changed = false;
    let scrubbed = walk(parsed, secret_values, &mut changed);
    if !changed {
        return Some(text.to_owned());
    }
    let mut out = String::new();
    write(&mut out, &scrubbed);
    Some(out)
}

fn scrub_string(value: String, secret_values: &[&str], changed: &mut bool) -> String {
    let scrubbed = scrub_oauth_secrets(&value, secret_values);
    if scrubbed != value {
        *changed = true;
    }
    scrubbed
}

fn walk(node: Node, secret_values: &[&str], changed: &mut bool) -> Node {
    match node {
        Node::Str(text) => Node::Str(scrub_string(text, secret_values, changed)),
        Node::Array(items) => Node::Array(items.into_iter().map(|item| walk(item, secret_values, changed)).collect()),
        Node::Object(entries) => Node::Object(ordered(
            entries
                .into_iter()
                .map(|(key, inner)| {
                    if SECRET_KEY.is_match(&key) && matches!(inner, Node::Str(_)) {
                        *changed = true;
                        (key, Node::Str(REDACTED.to_owned()))
                    } else {
                        (scrub_string(key, secret_values, changed), walk(inner, secret_values, changed))
                    }
                })
                .collect(),
        )),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    const GOLDEN: &str = include_str!("../../../../fixtures/oauth-scrub/golden.json");

    #[test]
    fn the_scrub_is_nodes_scrub_oauth_secrets() {
        let golden: Value = serde_json::from_str(GOLDEN).unwrap();
        let cases = golden["cases"].as_array().unwrap();
        assert!(cases.len() >= 60);
        for case in cases {
            let secrets: Vec<&str> = case["secrets"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            let got = scrub_oauth_secrets(case["text"].as_str().unwrap(), &secrets);
            assert_eq!(got, case["scrubbed"].as_str().unwrap(), "{}", case["text"]);
            let muse = scrub_muse_secrets(case["text"].as_str().unwrap(), &secrets);
            assert_eq!(muse, case["muse"].as_str().unwrap(), "muse: {}", case["text"]);
            let summary = oauth_body_summary(case["text"].as_str().unwrap(), &secrets);
            assert_eq!(summary, case["summary"].as_str().unwrap(), "summary: {}", case["text"]);
        }
    }
}
