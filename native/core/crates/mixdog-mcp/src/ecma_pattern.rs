//! `pattern` and `patternProperties` as Ajv compiles them: `new RegExp(pattern, "u")`. Whether a pattern compiles is
//! V8's answer ([`mixdog_js::js_regex_error`], its own error text). Matching runs in jsonschema's engine (fancy-regex,
//! whose backtracking stops after a bounded number of steps, where V8's does not), on the pattern rewritten so every
//! construct whose meaning differs between the two means what it means in JavaScript: `\d`, `\w`, `\s` and their
//! negations are ASCII digits, ASCII word characters and the ECMAScript white space and line terminators; `\b` and
//! `\B` are ASCII word boundaries; `.` stops at every line terminator; `[^]` is any character and `[]` none; `\0` is
//! NUL and, in a class, `\b` is backspace. Class characters that are operators only to the engine (`[`, `&`, `~`) are
//! escaped. A pattern the engine still cannot compile fails the schema with the engine's text, where Ajv would compile
//! it.

/// The ECMAScript white space and line terminators (`\s`), as class items.
const SPACE: &str =
    r"\t\n\x0B\x0C\r \xA0\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";
const WORD: &str = "A-Za-z0-9_";
const BOUNDARY: &str = "(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))";
const NOT_BOUNDARY: &str =
    "(?:(?<=[A-Za-z0-9_])(?=[A-Za-z0-9_])|(?<![A-Za-z0-9_])(?![A-Za-z0-9_]))";

/// The class being read: its own items, and the negated escapes in it (`\D`, `\W`, `\S`), which the engine cannot
/// nest in a class and which join the class as alternatives.
struct Class {
    negated: bool,
    items: String,
    negations: Vec<String>,
}

impl Class {
    fn close(self) -> String {
        if self.negations.is_empty() {
            return format!("[{}{}]", if self.negated { "^" } else { "" }, self.items);
        }
        let mut union: Vec<String> = Vec::new();
        if !self.items.is_empty() {
            union.push(format!("[{}]", self.items));
        }
        union.extend(self.negations);
        let union = union.join("|");
        if self.negated {
            format!("(?!{union})(?s:.)")
        } else {
            format!("(?:{union})")
        }
    }
}

/// The names of `pattern`'s capturing groups, `None` for unnamed ones, in their order (`\k<name>` becomes the group's
/// number, which the engine reads).
fn group_names(chars: &[char]) -> Vec<Option<String>> {
    let mut names = Vec::new();
    let (mut i, mut in_class) = (0, false);
    while i < chars.len() {
        match chars[i] {
            '\\' => i += 1,
            '[' if !in_class => in_class = true,
            ']' if in_class => in_class = false,
            '(' if !in_class => {
                if chars.get(i + 1) != Some(&'?') {
                    names.push(None);
                } else if chars.get(i + 2) == Some(&'<')
                    && !matches!(chars.get(i + 3), Some('=' | '!'))
                {
                    let name: String = chars[i + 3..].iter().take_while(|&&c| c != '>').collect();
                    names.push(Some(name));
                }
            }
            _ => {}
        }
        i += 1;
    }
    names
}

/// `pattern` for jsonschema's engine, or V8's `SyntaxError` text when JavaScript does not compile it with the u flag.
pub(crate) fn for_engine(pattern: &str) -> Result<String, String> {
    if let Some(message) = mixdog_js::js_regex_error(pattern, "u") {
        return Err(message);
    }
    let chars: Vec<char> = pattern.chars().collect();
    let names = group_names(&chars);
    let mut out = String::with_capacity(pattern.len());
    let mut class: Option<Class> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        i += 1;
        match c {
            '\\' => {
                let Some(&next) = chars.get(i) else {
                    emit(&mut class, &mut out, "\\");
                    continue;
                };
                i += 1;
                let replaced = match (class.is_some(), next) {
                    (false, 'd') => "[0-9]".to_owned(),
                    (false, 'D') => "[^0-9]".to_owned(),
                    (false, 'w') => format!("[{WORD}]"),
                    (false, 'W') => format!("[^{WORD}]"),
                    (false, 's') => format!("[{SPACE}]"),
                    (false, 'S') => format!("[^{SPACE}]"),
                    (false, 'b') => BOUNDARY.to_owned(),
                    (false, 'B') => NOT_BOUNDARY.to_owned(),
                    (false, 'k') if chars.get(i) == Some(&'<') => {
                        let name: String =
                            chars[i + 1..].iter().take_while(|&&c| c != '>').collect();
                        i += name.chars().count() + 2;
                        let number = names
                            .iter()
                            .position(|n| n.as_deref() == Some(name.as_str()))
                            .map_or(0, |at| at + 1);
                        format!("(?:\\{number})")
                    }
                    (true, 'd') => "0-9".to_owned(),
                    (true, 'w') => WORD.to_owned(),
                    (true, 's') => SPACE.to_owned(),
                    (true, negated @ ('D' | 'W' | 'S')) => {
                        let set = match negated {
                            'D' => "0-9",
                            'W' => WORD,
                            _ => SPACE,
                        };
                        if let Some(class) = &mut class {
                            class.negations.push(format!("[^{set}]"));
                        }
                        continue;
                    }
                    (true, 'b') => r"\x08".to_owned(),
                    (_, '0') => r"\x00".to_owned(),
                    (_, other) => format!("\\{other}"),
                };
                emit(&mut class, &mut out, &replaced);
            }
            '[' if class.is_none() => {
                if chars.get(i) == Some(&']') {
                    out.push_str("(?!)");
                    i += 1;
                } else if chars.get(i) == Some(&'^') && chars.get(i + 1) == Some(&']') {
                    out.push_str("(?s:.)");
                    i += 2;
                } else {
                    let negated = chars.get(i) == Some(&'^');
                    i += usize::from(negated);
                    class = Some(Class {
                        negated,
                        items: String::new(),
                        negations: Vec::new(),
                    });
                }
            }
            ']' if class.is_some() => out.push_str(&class.take().expect("in a class").close()),
            '[' | '&' | '~' if class.is_some() => emit(&mut class, &mut out, &format!("\\{c}")),
            // A named group is a numbered one to the engine; its name was read above.
            '(' if class.is_none()
                && chars.get(i) == Some(&'?')
                && chars.get(i + 1) == Some(&'<')
                && !matches!(chars.get(i + 2), Some('=' | '!')) =>
            {
                let name_len = chars[i + 2..].iter().take_while(|&&c| c != '>').count();
                i += name_len + 3;
                out.push('(');
            }
            '.' if class.is_none() => out.push_str(r"[^\n\r\u{2028}\u{2029}]"),
            _ => emit(&mut class, &mut out, c.encode_utf8(&mut [0; 4])),
        }
    }
    Ok(out)
}

/// Adds `text` to the class being read, or to the pattern.
fn emit(class: &mut Option<Class>, out: &mut String, text: &str) {
    match class {
        Some(class) => class.items.push_str(text),
        None => out.push_str(text),
    }
}

#[cfg(test)]
mod tests {
    use super::for_engine;

    /// V8 refuses what the u flag forbids, with its own text; the rewrite gives each construct its JavaScript meaning.
    #[test]
    fn a_pattern_compiles_as_javascript_and_matches_as_javascript() {
        assert_eq!(
            for_engine("(").unwrap_err(),
            "Invalid regular expression: /(/u: Unterminated group"
        );
        assert!(for_engine(r"\-").is_err() && for_engine("(?i)a").is_err());
        // Through jsonschema, which checks and translates the rewritten pattern again before its engine runs it.
        let matches = |pattern: &str, text: &str| {
            let schema = serde_json::json!({"pattern": for_engine(pattern).unwrap()});
            jsonschema::options()
                .with_draft(jsonschema::Draft::Draft7)
                .build(&schema)
                .unwrap()
                .is_valid(&serde_json::json!(text))
        };
        assert!(
            matches(r"^(?<y>\d{4})-\k<y>$", "2024-2024")
                && !matches(r"^(?<y>\d{4})-\k<y>$", "2024-2025")
        );
        assert!(
            matches(r"^[\D]$", "a")
                && !matches(r"^[^\D]$", "a")
                && matches(r"^[^\D]$", "1")
                && matches(r"^[a\S]$", "b")
        );
        assert!(!matches(r"^\d$", "\u{0661}") && matches(r"^\d$", "1"));
        assert!(!matches(r"^\w$", "é") && matches(r"é\b", "éa") && !matches(r"é\b", "é "));
        assert!(
            !matches("^.$", "\u{2028}") && matches("^.$", "\u{1F600}") && matches("^[^]$", "\n")
        );
        assert!(
            matches(r"^\s$", "\u{FEFF}")
                && matches(r"^[\s]$", "\u{A0}")
                && matches(r"^[\d&]$", "&")
        );
    }
}
