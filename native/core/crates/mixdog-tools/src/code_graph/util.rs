//! Small text helpers shared by the query modules.

use std::cmp::Ordering;

/// Collapse every whitespace run into one space and trim.
pub(super) fn one_line(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The first `n` characters.
pub(super) fn head_chars(value: &str, n: usize) -> &str {
    match value.char_indices().nth(n) {
        Some((i, _)) => &value[..i],
        None => value,
    }
}

/// Dictionary order of paths and names: case-insensitive first, lowercase before uppercase on
/// a tie.
pub(super) fn name_cmp(a: &str, b: &str) -> Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| b.cmp(a))
}

/// A list bounded for the model, with the truncation announced.
pub(super) fn cap_list(mut items: Vec<String>, cap: usize) -> Vec<String> {
    if items.len() > cap {
        let total = items.len();
        items.truncate(cap);
        items.push(format!("[truncated — showing first {cap} of {total}]"));
    }
    items
}

pub(super) fn is_ident_char(c: char, dollar: bool) -> bool {
    c.is_alphanumeric() || c == '_' || (dollar && c == '$')
}

/// Languages whose identifiers may contain `$`.
pub(super) fn lang_uses_dollar(lang: &str) -> bool {
    matches!(lang, "javascript" | "typescript" | "php")
}

/// Byte offsets of `symbol` in `text` as a whole identifier.
pub(super) fn identifier_occurrences(text: &str, symbol: &str, lang: Option<&str>) -> Vec<usize> {
    let dollar = lang.is_none_or(lang_uses_dollar);
    let mut out = Vec::new();
    if symbol.is_empty() {
        return out;
    }
    for (start, _) in text.match_indices(symbol) {
        let before_ok = text[..start]
            .chars()
            .next_back()
            .is_none_or(|c| !is_ident_char(c, dollar));
        let after_ok = text[start + symbol.len()..]
            .chars()
            .next()
            .is_none_or(|c| !is_ident_char(c, dollar));
        if before_ok && after_ok {
            out.push(start);
        }
    }
    out
}
