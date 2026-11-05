//! A pattern with JavaScript semantics (`regress`): `\s` is the full ECMAScript white-space set
//! (including U+00A0, U+FEFF and the line separators), `\w`, `\d` and `\b` are ASCII without the
//! `u` flag, `.` stops at every line terminator. Offsets are byte offsets into the searched
//! `&str`.

use std::ops::Range;

use crate::regex_error::js_regex_error;

pub struct JsRegex(regress::Regex);

/// Whether the character at `at` is the target of a preceding backslash.
fn escaped_before(chars: &[char], at: usize) -> bool {
    chars[..at].iter().rev().take_while(|c| **c == '\\').count() % 2 == 1
}

/// Under the `v` flag the engine differs from V8 in two class forms, both written equivalently:
/// * it refuses two reserved double punctuators in a row that are not the same (`[&^]`) and
///   reads `&-` as a bad character, where V8 refuses only a doubled one; every such character
///   in a class is escaped (`[\&\^]`), except the `&&` operator;
/// * it refuses `\b` (backspace) as the end of a range (`[\b-a]`); it is written `\x08`.
fn v_class_forms(pattern: &str) -> std::borrow::Cow<'_, str> {
    const DOUBLE: &str = "&!#$%*+,.:;<=>?@^`~";
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut depth = 0usize;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\\' if i + 1 < chars.len() => {
                if depth > 0 && chars[i + 1] == 'b' {
                    out.push_str("\\x08");
                } else {
                    out.push('\\');
                    out.push(chars[i + 1]);
                }
                i += 2;
                continue;
            }
            '[' => depth += 1,
            ']' => depth = depth.saturating_sub(1),
            // The `&&` operator is the one doubled form V8 accepts; any other of these characters
            // is a plain character, and the escape keeps the engine from misreading it.
            // The `^` that negates a class is not a character.
            '^' if i > 0 && chars[i - 1] == '[' && !escaped_before(&chars, i - 1) => {}
            c if depth > 0 && DOUBLE.contains(c) => {
                if chars.get(i + 1) == Some(&c) {
                    out.push(c);
                    out.push(c);
                    i += 2;
                    continue;
                }
                out.push('\\');
            }
            _ => {}
        }
        out.push(c);
        i += 1;
    }
    if out == pattern { std::borrow::Cow::Borrowed(pattern) } else { std::borrow::Cow::Owned(out) }
}

/// Annex B: without the `u` flag, `\x` not followed by two hex digits is the letter `x`. The
/// engine rejects it inside a class, so it is written as the letter.
fn identity_hex_escapes(pattern: &str) -> std::borrow::Cow<'_, str> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut changed = false;
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            let hex = |k: usize| chars.get(k).is_some_and(char::is_ascii_hexdigit);
            if chars[i + 1] == 'x' && !(hex(i + 2) && hex(i + 3)) {
                out.push('x');
                changed = true;
            } else {
                out.push('\\');
                out.push(chars[i + 1]);
            }
            i += 2;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    if changed { std::borrow::Cow::Owned(out) } else { std::borrow::Cow::Borrowed(pattern) }
}

/// One match with its groups.
pub struct Caps<'t> {
    text: &'t str,
    found: regress::Match,
}

impl<'t> Caps<'t> {
    pub fn get(&self, group: usize) -> Option<&'t str> {
        self.found.group(group).map(|r| &self.text[r])
    }

    pub fn range(&self) -> Range<usize> {
        self.found.range()
    }
}

impl JsRegex {
    /// `new RegExp(pattern, flags)`. The error is the text of the `SyntaxError` V8 throws (see
    /// [`js_regex_error`]); a pattern V8 accepts but the engine cannot run says so.
    pub fn new(pattern: &str, flags: &str) -> Result<Self, String> {
        if let Some(message) = js_regex_error(pattern, flags) {
            return Err(message);
        }
        let source = if flags.contains('v') {
            v_class_forms(pattern)
        } else if flags.contains('u') {
            std::borrow::Cow::Borrowed(pattern)
        } else {
            identity_hex_escapes(pattern)
        };
        regress::Regex::with_flags(&source, flags).map(Self).map_err(|error| {
            format!("Invalid regular expression: /{pattern}/{flags}: unsupported by the regex engine ({error})")
        })
    }

    /// A pattern fixed in the source; panics on a bad one.
    pub fn new_static(pattern: &str, flags: &str) -> Self {
        Self::new(pattern, flags).expect("static pattern")
    }

    pub fn is_match(&self, text: &str) -> bool {
        self.0.find(text).is_some()
    }

    pub fn find(&self, text: &str) -> Option<Range<usize>> {
        self.0.find(text).map(|m| m.range())
    }

    pub fn find_iter<'a>(&'a self, text: &'a str) -> impl Iterator<Item = Range<usize>> + 'a {
        self.0.find_iter(text).map(|m| m.range())
    }

    pub fn captures<'t>(&self, text: &'t str) -> Option<Caps<'t>> {
        self.0.find(text).map(|found| Caps { text, found })
    }

    pub fn captures_iter<'a>(&'a self, text: &'a str) -> impl Iterator<Item = Caps<'a>> + 'a {
        self.0.find_iter(text).map(move |found| Caps { text, found })
    }

    /// `String.prototype.replace` with a global pattern and a replacer function.
    pub fn replace_all_with(&self, text: &str, with: impl Fn(&Caps) -> String) -> String {
        let mut out = String::new();
        let mut last = 0;
        for caps in self.captures_iter(text) {
            let whole = caps.range();
            out.push_str(&text[last..whole.start]);
            out.push_str(&with(&caps));
            last = whole.end;
        }
        out.push_str(&text[last..]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whitespace_boundaries_and_case_follow_javascript() {
        let re = JsRegex::new_static(r"\|\s*sh\b", "i");
        assert!(re.is_match("a |\u{a0}SH"));
        assert!(re.is_match("|\u{feff}sh"));
        assert!(!re.is_match("|\u{85}sh"));
        assert!(!re.is_match("| shx"));
        let all = JsRegex::new_static("a", "").replace_all_with("banana", |_| "o".into());
        assert_eq!(all, "bonono");
    }

    #[test]
    fn a_bad_pattern_reports_v8s_message() {
        assert_eq!(
            JsRegex::new("(", "").err().as_deref(),
            Some("Invalid regular expression: /(/: Unterminated group")
        );
    }
}

#[cfg(test)]
mod sweep {
    /// Patterns V8 accepts that the engine rejects, from the Node sweep (`MIXDOG_JS_REGEX_CORPUS`).
    #[test]
    #[allow(clippy::disallowed_methods, reason = "developer-run sweep reads a scratch file; no lane in a unit test")]
    fn engine_gaps_on_the_full_sweep() {
        let Ok(path) = std::env::var("MIXDOG_JS_REGEX_CORPUS") else {
            return;
        };
        let text = std::fs::read_to_string(path).expect("corpus");
        let mut gaps = std::collections::BTreeMap::<String, Vec<String>>::new();
        for line in text.lines() {
            let (pattern, flags, expected): (String, String, Option<String>) = serde_json::from_str(line).expect("row");
            if expected.is_some() {
                continue;
            }
            if let Err(message) = super::JsRegex::new(&pattern, &flags) {
                let reason = message.rsplit("engine (").next().unwrap_or("").to_owned();
                let bucket = gaps.entry(reason).or_default();
                if bucket.len() < 8 {
                    bucket.push(format!("/{pattern}/{flags}"));
                }
            }
        }
        let shown: Vec<String> = gaps.iter().map(|(reason, rows)| format!("{reason}: {rows:?}")).collect();
        assert!(shown.is_empty(), "{}", shown.join("\n"));
    }
}
