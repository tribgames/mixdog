//! `scrubOAuthSecrets(text, secretValues)` (`providers/lib/oauth-token-utils.mjs`): a refused
//! body or message with its OAuth secrets redacted before it is shown or logged.
//!
//! A JSON object or array is redacted on its parsed form (so an escaped key name such as
//! `client\u005fsecret` cannot slip past a pattern): secret fields lose their string value, every
//! decoded string (keys too) gets the full redaction again, numbers keep their exact source text,
//! and a body nothing was redacted in is returned as it came. Anything else is redacted by
//! pattern: secret fields as JSON-like and form-encoded text, bearer / JWT / Anthropic tokens and
//! the given values.
//!
//! Known limit: a lone surrogate escape (`\ud800`) decodes to U+FFFD, as a Rust string cannot
//! hold one.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use serde_json::{Map, Value};

const REDACTED: &str = "[REDACTED]";

// Fields whose string values are secrets, snake_case or camelCase. `code` is not one: it is
// also every API's error/status code.
const SECRET_FIELD: &str = "(?:access_?token|refresh_?token|id_?token|client_?secret|code_?verifier|code_?challenge|device_?code|api_?key|token|key|secret|password|assertion)";

static SECRET_KEY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(&format!("^{SECRET_FIELD}$"), "i"));
static JSON_SECRET: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(&format!(r#""({SECRET_FIELD})"\s*:\s*(?:"(?:[^"\\]|\\.)*"?|(?!-?\d|true\b|false\b|null\b)[^,}}\]\s]+)"#), "i")
});
static FORM_SECRET: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(&format!(r#"(^|[^A-Za-z0-9_])({SECRET_FIELD})=[^&\s"']*"#), "i"));
static BEARER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"Bearer [A-Za-z0-9._-]+", "i"));
static ANTHROPIC: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"sk-ant-[A-Za-z0-9._-]+", ""));
static JWT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]*)?", ""));

/// Bearer / JWT / Anthropic tokens and the given secret values, anywhere in `text`.
fn scrub_token_text(text: &str, secrets: &[&str]) -> String {
    let mut out = BEARER.replace_all_with(text, |_| format!("Bearer {REDACTED}"));
    out = ANTHROPIC.replace_all_with(&out, |_| REDACTED.to_owned());
    out = JWT.replace_all_with(&out, |_| REDACTED.to_owned());
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        out = out.replace(secret, REDACTED);
    }
    out
}

/// A parsed JSON value that keeps the source text of its numbers (`JSON.rawJSON`).
enum Node {
    Str(String),
    Raw(String),
    Literal(&'static str),
    Array(Vec<Node>),
    Object(Vec<(String, Node)>),
}

struct Reader<'a> {
    text: &'a str,
    at: usize,
}

impl Reader<'_> {
    fn skip_space(&mut self) {
        while matches!(self.text.as_bytes().get(self.at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn hex4(&mut self) -> u32 {
        let digits = &self.text[self.at..self.at + 4];
        self.at += 4;
        u32::from_str_radix(digits, 16).unwrap_or(0xFFFD)
    }

    fn string(&mut self) -> String {
        self.at += 1;
        let mut out = String::new();
        loop {
            let rest = &self.text[self.at..];
            let Some(c) = rest.chars().next() else { return out };
            self.at += c.len_utf8();
            match c {
                '"' => return out,
                '\\' => {
                    let escape = self.text.as_bytes()[self.at];
                    self.at += 1;
                    match escape {
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4();
                            let ch = if (0xD800..0xDC00).contains(&unit) && self.text[self.at..].starts_with("\\u") {
                                let save = self.at;
                                self.at += 2;
                                let low = self.hex4();
                                if (0xDC00..0xE000).contains(&low) {
                                    char::from_u32(0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00))
                                } else {
                                    self.at = save;
                                    None
                                }
                            } else {
                                char::from_u32(unit)
                            };
                            out.push(ch.unwrap_or('\u{FFFD}'));
                        }
                        other => out.push(other as char),
                    }
                }
                c => out.push(c),
            }
        }
    }

    /// One value of a text `JSON.parse` already accepted.
    fn value(&mut self) -> Node {
        self.skip_space();
        match self.text.as_bytes()[self.at] {
            b'"' => Node::Str(self.string()),
            b'{' => {
                self.at += 1;
                let mut entries: Vec<(String, Node)> = Vec::new();
                loop {
                    self.skip_space();
                    match self.text.as_bytes()[self.at] {
                        b'}' => {
                            self.at += 1;
                            return Node::Object(entries);
                        }
                        b',' => self.at += 1,
                        _ => {
                            let key = self.string();
                            self.skip_space();
                            self.at += 1; // ':'
                            let inner = self.value();
                            // A repeated key keeps its first place and takes the last value.
                            match entries.iter_mut().find(|(k, _)| *k == key) {
                                Some(slot) => slot.1 = inner,
                                None => entries.push((key, inner)),
                            }
                        }
                    }
                }
            }
            b'[' => {
                self.at += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_space();
                    match self.text.as_bytes()[self.at] {
                        b']' => {
                            self.at += 1;
                            return Node::Array(items);
                        }
                        b',' => self.at += 1,
                        _ => items.push(self.value()),
                    }
                }
            }
            b't' => {
                self.at += 4;
                Node::Literal("true")
            }
            b'f' => {
                self.at += 5;
                Node::Literal("false")
            }
            b'n' => {
                self.at += 4;
                Node::Literal("null")
            }
            _ => {
                let start = self.at;
                while matches!(self.text.as_bytes().get(self.at), Some(b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')) {
                    self.at += 1;
                }
                Node::Raw(self.text[start..self.at].to_owned())
            }
        }
    }
}

/// The entries in the order a JavaScript object enumerates them: integer-like keys ascending,
/// then the rest as inserted.
fn enumerated(entries: Vec<(String, Node)>) -> Vec<(String, Node)> {
    let keys: Map<String, Value> = entries.iter().map(|(key, _)| (key.clone(), Value::Null)).collect();
    let order: Vec<String> = mixdog_js::js_object_keys(&keys).into_iter().cloned().collect();
    let mut slots: Vec<Option<(String, Node)>> = entries.into_iter().map(Some).collect();
    order
        .iter()
        .filter_map(|key| slots.iter_mut().find(|slot| slot.as_ref().is_some_and(|(k, _)| k == key)).and_then(Option::take))
        .collect()
}

fn write(node: &Node, out: &mut String) {
    match node {
        Node::Str(text) => mixdog_js::json_quote(text, out),
        Node::Raw(raw) => out.push_str(raw),
        Node::Literal(text) => out.push_str(text),
        Node::Array(items) => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Node::Object(entries) => {
            out.push('{');
            let keys: Map<String, Value> = entries.iter().map(|(key, _)| (key.clone(), Value::Null)).collect();
            for (at, key) in mixdog_js::js_object_keys(&keys).into_iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                mixdog_js::json_quote(key, out);
                out.push(':');
                if let Some((_, inner)) = entries.iter().find(|(k, _)| k == key) {
                    write(inner, out);
                }
            }
            out.push('}');
        }
    }
}

/// Each decoded string (keys too) gets the full redaction: it may hold form-encoded fields, a
/// query string or JSON of its own.
fn scrub_string(value: &str, secrets: &[&str], changed: &mut bool) -> String {
    let scrubbed = scrub_oauth_secrets(value, secrets);
    if scrubbed != value {
        *changed = true;
    }
    scrubbed
}

fn walk(node: Node, secrets: &[&str], changed: &mut bool) -> Node {
    match node {
        Node::Str(text) => Node::Str(scrub_string(&text, secrets, changed)),
        Node::Array(items) => Node::Array(items.into_iter().map(|item| walk(item, secrets, changed)).collect()),
        Node::Object(entries) => {
            let mut out: Vec<(String, Node)> = Vec::new();
            for (key, inner) in enumerated(entries) {
                let (key, inner) = match inner {
                    Node::Str(_) if SECRET_KEY.is_match(&key) => {
                        *changed = true;
                        (key, Node::Str(REDACTED.to_owned()))
                    }
                    inner => (scrub_string(&key, secrets, changed), walk(inner, secrets, changed)),
                };
                match out.iter_mut().find(|(k, _)| *k == key) {
                    Some(slot) => slot.1 = inner,
                    None => out.push((key, inner)),
                }
            }
            Node::Object(out)
        }
        other => other,
    }
}

/// `scrubJsonSecrets`: `None` when `text` is not a JSON object or array.
fn scrub_json(text: &str, secrets: &[&str]) -> Option<String> {
    mixdog_js::json_parse(text).ok()?;
    let mut reader = Reader { text, at: 0 };
    let parsed = reader.value();
    if !matches!(parsed, Node::Object(_) | Node::Array(_)) {
        return None;
    }
    let mut changed = false;
    let scrubbed = walk(parsed, secrets, &mut changed);
    if !changed {
        return Some(text.to_owned());
    }
    let mut out = String::new();
    write(&scrubbed, &mut out);
    Some(out)
}

/// Redacts OAuth secrets from a body or message; numbers and status codes are kept.
pub fn scrub_oauth_secrets(text: &str, secrets: &[&str]) -> String {
    if let Some(json) = scrub_json(text, secrets) {
        return json;
    }
    let keyed = JSON_SECRET.replace_all_with(text, |caps| format!("\"{}\":\"{REDACTED}\"", caps.get(1).unwrap_or_default()));
    let formed = FORM_SECRET.replace_all_with(&keyed, |caps| format!("{}{}=[REDACTED]", caps.get(1).unwrap_or_default(), caps.get(2).unwrap_or_default()));
    scrub_token_text(&formed, secrets)
}
