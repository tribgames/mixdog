//! The text operators of the hosts: `-match`, `-notmatch`, `-replace`, `-split`, `-like`, `-join`, `[regex]::Escape` and
//! `TrimEnd`.
//!
//! PowerShell runs `-match`, `-replace` and `-split` on .NET regular expressions, case-insensitively unless the operator
//! is the `-c` form, and `-like` on its wildcard language (`*`, `?`, `[a-c]`, backtick escape; case-insensitive). The
//! patterns of the hosts use no look-around and no back-reference, which the `regex` crate does not have; what differs in
//! the engines is handled here: the `$` anchor (which in .NET also matches before a final `\n`) and the replacement
//! language (`$1`, `${name}`, `$&`, `` $` ``, `$'`, `$+`, `$_`, `$$`).

use regex::Captures;
use regex::Regex;
use regex::RegexBuilder;

use super::Value;
use super::convert;

fn build(pattern: &str, case_sensitive: bool) -> Result<Regex, String> {
    build_from(pattern, pattern, case_sensitive)
}

/// Compiles `source`, the pattern as the `regex` crate reads it; a refusal names `shown`, the pattern as the host wrote it.
fn build_from(source: &str, shown: &str, case_sensitive: bool) -> Result<Regex, String> {
    RegexBuilder::new(source).case_insensitive(!case_sensitive).build().map_err(|error| invalid_pattern(shown, &error))
}

/// PowerShell's own text for a pattern .NET refuses.
fn invalid_pattern(pattern: &str, error: &regex::Error) -> String {
    let reason = match error {
        regex::Error::Syntax(text) => {
            let lower = text.to_lowercase();
            if lower.contains("unclosed group") {
                "Not enough )'s."
            } else if lower.contains("unopened group") {
                "Too many )'s."
            } else if lower.contains("unclosed character class") {
                "Unterminated [] set."
            } else if lower.contains("repetition operator missing expression") {
                "Quantifier {x,y} following nothing."
            } else {
                "Invalid pattern."
            }
        }
        _ => "Invalid pattern.",
    };
    format!("parsing \"{pattern}\" - {reason}")
}

/// .NET's `$` matches at the end of the text and before a final `\n`; the `regex` crate's only at the very end. The bare
/// `$` anchors of a pattern are rewritten to that rule (escaped dollars and dollars inside a character class stay).
fn dotnet_anchors(pattern: &str) -> String {
    let mut out = String::with_capacity(pattern.len() + 8);
    let mut in_class = false;
    let mut chars = pattern.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                out.push(c);
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push(c);
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            '$' if !in_class => out.push_str("(?:\\n?\\z)"),
            _ => out.push(c),
        }
    }
    out
}

/// `$text -match $pattern` (`case_sensitive` false) or `-cmatch`. .NET's ignore-case comparison treats the dotted capital
/// I (U+0130) as an `i`; the `regex` crate's does not, so in the case-insensitive form both sides read it as `i`.
pub fn is_match(text: &str, pattern: &str, case_sensitive: bool) -> Result<bool, String> {
    if case_sensitive {
        return Ok(build_from(&dotnet_anchors(pattern), pattern, true)?.is_match(text));
    }
    let folded_pattern = pattern.replace('\u{130}', "i");
    let folded_text = text.replace('\u{130}', "i");
    Ok(build_from(&dotnet_anchors(&folded_pattern), pattern, false)?.is_match(&folded_text))
}

/// `$text -notmatch $pattern`.
pub fn is_not_match(text: &str, pattern: &str, case_sensitive: bool) -> Result<bool, String> {
    Ok(!is_match(text, pattern, case_sensitive)?)
}

/// `$text -replace $pattern, $replacement` (`-creplace` when `case_sensitive`): every match is replaced, the
/// replacement read in the .NET substitution language.
pub fn replace(text: &str, pattern: &str, replacement: &str, case_sensitive: bool) -> Result<String, String> {
    // `-replace` refuses a pattern with its own text, not the `parsing "..."` text of `-match`.
    let regex = build(pattern, case_sensitive).map_err(|_| format!("The regular expression pattern {pattern} is not valid."))?;
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for captures in regex.captures_iter(text) {
        let whole = captures.get(0).expect("group 0 always matches");
        out.push_str(&text[last..whole.start()]);
        expand_replacement(replacement, &regex, &captures, text, &mut out);
        last = whole.end();
    }
    out.push_str(&text[last..]);
    Ok(out)
}

fn expand_replacement(template: &str, regex: &Regex, captures: &Captures<'_>, text: &str, out: &mut String) {
    let chars: Vec<char> = template.chars().collect();
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        at += 1;
        if c != '$' {
            out.push(c);
            continue;
        }
        match substitution(&chars, at, regex, captures, text, out) {
            Some(next) => at = next,
            None => out.push('$'),
        }
    }
}

/// The substitution after a `$` at `start`: the index to go on from, or `None` when the dollar is literal and what follows
/// is read again.
fn substitution(chars: &[char], start: usize, regex: &Regex, captures: &Captures<'_>, text: &str, out: &mut String) -> Option<usize> {
    let angled = start + 1 < chars.len() && chars[start] == '{';
    let cursor = if angled { start + 1 } else { start };
    match chars.get(cursor).copied()? {
        d if d.is_ascii_digit() => numbered_group(chars, cursor, angled, captures, out),
        w if angled && (w.is_alphanumeric() || w == '_') => named_group(chars, cursor, regex, captures, out),
        symbol if !angled => special_substitution(symbol, captures, text, out).then_some(cursor + 1),
        _ => None,
    }
}

fn numbered_group(chars: &[char], mut cursor: usize, angled: bool, captures: &Captures<'_>, out: &mut String) -> Option<usize> {
    let mut number: usize = 0;
    let mut overflow = false;
    while cursor < chars.len() && chars[cursor].is_ascii_digit() {
        match number.checked_mul(10).and_then(|n| n.checked_add(chars[cursor] as usize - '0' as usize)) {
            Some(n) => number = n,
            None => overflow = true,
        }
        cursor += 1;
    }
    let closed = !angled || (cursor < chars.len() && chars[cursor] == '}');
    if !closed || overflow || number >= captures.len() {
        return None;
    }
    if let Some(group) = captures.get(number) {
        out.push_str(group.as_str());
    }
    Some(if angled { cursor + 1 } else { cursor })
}

fn named_group(chars: &[char], mut cursor: usize, regex: &Regex, captures: &Captures<'_>, out: &mut String) -> Option<usize> {
    let mut name = String::new();
    while cursor < chars.len() && (chars[cursor].is_alphanumeric() || chars[cursor] == '_') {
        name.push(chars[cursor]);
        cursor += 1;
    }
    if cursor >= chars.len() || chars[cursor] != '}' {
        return None;
    }
    if let Some(found) = captures.name(&name) {
        out.push_str(found.as_str());
        return Some(cursor + 1);
    }
    regex.capture_names().flatten().any(|known| known == name).then_some(cursor + 1)
}

/// `$$`, `$&`, `` $` ``, `$'`, `$+` and `$_`; false for any other symbol.
fn special_substitution(symbol: char, captures: &Captures<'_>, text: &str, out: &mut String) -> bool {
    let whole = captures.get(0).expect("group 0 always matches");
    match symbol {
        '$' => out.push('$'),
        '&' => out.push_str(whole.as_str()),
        '`' => out.push_str(&text[..whole.start()]),
        '\'' => out.push_str(&text[whole.end()..]),
        '+' => {
            if let Some(group) = (0..captures.len()).rev().find_map(|index| captures.get(index)) {
                out.push_str(group.as_str());
            }
        }
        '_' => out.push_str(text),
        _ => return false,
    }
    true
}

/// `$text -split $pattern` (`-csplit` when `case_sensitive`): the pieces between matches, with the text of every capture
/// group of a match following the piece before it.
pub fn split(text: &str, pattern: &str, case_sensitive: bool) -> Result<Vec<String>, String> {
    let regex = build(pattern, case_sensitive)?;
    let mut pieces: Vec<String> = Vec::new();
    let mut last = 0;
    for captures in regex.captures_iter(text) {
        let whole = captures.get(0).expect("group 0 always matches");
        pieces.push(text[last..whole.start()].to_string());
        for index in 1..captures.len() {
            if let Some(group) = captures.get(index) {
                pieces.push(group.as_str().to_string());
            }
        }
        last = whole.end();
    }
    pieces.push(text[last..].to_string());
    Ok(pieces)
}

/// `$text -like $pattern`: the PowerShell wildcard language, case-insensitive, `*` and `?` matching any character
/// (a newline included).
pub fn like(text: &str, pattern: &str) -> bool {
    let mut expression = String::from("(?is)\\A");
    let chars: Vec<char> = pattern.chars().collect();
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        at += 1;
        match c {
            '*' => expression.push_str(".*"),
            '?' => expression.push('.'),
            '`' => {
                if at < chars.len() {
                    expression.push_str(&regex::escape(&chars[at].to_string()));
                    at += 1;
                } else {
                    expression.push_str(&regex::escape("`"));
                }
            }
            '[' => match wildcard_class(&chars, at) {
                Some((class, next)) => {
                    expression.push('[');
                    expression.push_str(&class);
                    expression.push(']');
                    at = next;
                }
                None => expression.push_str("\\["),
            },
            other => expression.push_str(&regex::escape(&other.to_string())),
        }
    }
    expression.push_str("\\z");
    match Regex::new(&expression) {
        Ok(regex) => regex.is_match(text),
        Err(_) => false,
    }
}

/// The members of a `[...]` wildcard class opening before `chars[at]`, as the `regex` crate reads them, and the index after
/// the closing `]`; `None` when the class is never closed.
fn wildcard_class(chars: &[char], at: usize) -> Option<(String, usize)> {
    let mut class = String::new();
    let mut cursor = at;
    while cursor < chars.len() {
        let member = chars[cursor];
        cursor += 1;
        if member == ']' && !class.is_empty() {
            return Some((class, cursor));
        }
        if member == '`' && cursor < chars.len() {
            class.push_str(&regex::escape(&chars[cursor].to_string()));
            cursor += 1;
        } else if member == '\\' || member == '[' || member == '^' || member == '&' || member == '~' {
            class.push('\\');
            class.push(member);
        } else {
            class.push(member);
        }
    }
    None
}
/// `[regex]::Escape($text)`: backslash before `\ * + ? | { [ ( ) ^ $ . #`, a space as `\ ` and the control characters
/// tab, line feed, carriage return and form feed as `\t \n \r \f`.
pub fn regex_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        match c {
            '\\' | '*' | '+' | '?' | '|' | '{' | '[' | '(' | ')' | '^' | '$' | '.' | '#' | ' ' => {
                out.push('\\');
                out.push(c);
            }
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{000C}' => out.push_str("\\f"),
            other => out.push(other),
        }
    }
    out
}

/// `$text.ToLowerInvariant()`: each character by its one-character lower-case form; a character whose lower case is longer
/// (the dotted capital I) stays.
pub fn to_lower_invariant(text: &str) -> String {
    text.chars()
        .map(|c| {
            let mut lower = c.to_lowercase();
            match (lower.next(), lower.next()) {
                (Some(single), None) => single,
                _ => c,
            }
        })
        .collect()
}

/// `$text.TrimStart($chars)`.
pub fn trim_start(text: &str, chars: &[char]) -> String {
    text.trim_start_matches(|c| chars.contains(&c)).to_string()
}

/// `$text.TrimEnd($chars)`.
pub fn trim_end(text: &str, chars: &[char]) -> String {
    text.trim_end_matches(|c| chars.contains(&c)).to_string()
}

/// `$text.TrimEnd("`r", "`a")`, the carriage return and bell the hosts strip from a cell text.
pub fn trim_end_cr_bel(text: &str) -> String {
    trim_end(text, &['\r', '\u{0007}'])
}

/// `$items -join $separator`: every element as `[string]` (`$null` is empty); an array element is its own elements joined
/// with a space, as PowerShell converts it.
pub fn join(items: &[Value], separator: &str) -> String {
    items.iter().map(convert::to_ps_string).collect::<Vec<String>>().join(separator)
}
