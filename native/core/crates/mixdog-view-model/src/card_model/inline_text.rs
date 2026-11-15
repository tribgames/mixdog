//! Single-row text hygiene and the row budgets shared by every collapsed tool-card surface
//! (`shared/tool-card-model/inline-text.mjs`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;
use mixdog_js::json_number;
use mixdog_js::slice_utf16;
use mixdog_js::to_number_of;
use mixdog_js::utf16_len;
use mixdog_termtext::strip::strip_ansi;
use serde_json::Map;
use serde_json::Value;

pub const MIN_RESULT_LINE_CHARS: usize = 24;
/// Hard cap for the collapsed result detail row (the second line under the gutter), independent of the terminal width so a
/// wide terminal never lets a long line stretch the row; expanding still shows the full body.
pub const RESULT_LINE_HARD_MAX: usize = 80;
/// Hard cap for the parenthesized header arg summary.
pub const SUMMARY_MAX_CHARS: usize = 48;
pub const HEADER_FAILURE_STATUS_MAX: usize = 32;

/// `safeInlineText`: the text as one row; escapes, control bytes and whitespace runs become single spaces.
pub fn safe_inline_text(value: &str) -> String {
    let stripped = strip_ansi(value);
    let mut out = String::with_capacity(stripped.len());
    let mut in_space = false;
    for c in stripped.chars() {
        let spaced = c <= '\u{1f}' || c == '\u{7f}' || is_js_space(c);
        if spaced {
            if !in_space {
                out.push(' ');
            }
        } else {
            out.push(c);
        }
        in_space = spaced;
    }
    js_trim(&out).to_owned()
}

/// `clipPlain`: the text as one row, cut to `max_chars` UTF-16 units with an ellipsis.
pub fn clip_plain(text: &str, max_chars: usize) -> String {
    let value = safe_inline_text(text);
    let max = max_chars.max(1);
    if utf16_len(&value) <= max {
        return value;
    }
    format!("{}\u{2026}", slice_utf16(&value, max.saturating_sub(1)))
}

fn normalize_count(value: &Value) -> f64 {
    let n = to_number_of(Some(&if crate::tool_primitives::truthy(Some(value)) { value.clone() } else { Value::from(0) }));
    if n.is_finite() { n.floor().max(0.0) } else { 0.0 }
}

/// `normalizeCountMap`: every count a whole number of at least zero; an entry that is an object keeps its fields.
pub fn normalize_count_map(value: &Value) -> Value {
    let mut out = Map::new();
    let entries: Vec<(String, &Value)> = match value {
        Value::Object(map) => mixdog_js::js_object_keys(map).into_iter().map(|key| (key.clone(), &map[key])).collect(),
        Value::Array(items) => items.iter().enumerate().map(|(at, item)| (at.to_string(), item)).collect(),
        _ => Vec::new(),
    };
    for (key, raw) in entries {
        let truthy_object = matches!(raw, Value::Object(_) | Value::Array(_));
        if truthy_object {
            let mut copy = match raw {
                Value::Object(map) => map.clone(),
                Value::Array(items) => items.iter().enumerate().map(|(at, item)| (at.to_string(), item.clone())).collect(),
                _ => Map::new(),
            };
            let count = raw.get("count").map_or(0.0, |count| normalize_count(count));
            copy.insert("count".to_owned(), json_number(count));
            out.insert(key, Value::Object(copy));
        } else {
            out.insert(key, json_number(normalize_count(raw)));
        }
    }
    Value::Object(out)
}

static LINE_DELTA: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"(^|[\s([,{·])([+-]\s*\d+)(?=\s+Lines?\b)", "i"));

/// One piece of a detail row: plain text, or a `+N` / `-N` line-delta token (`delta` is its sign).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeltaPart {
    pub text: String,
    pub delta: Option<char>,
}

impl DeltaPart {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("text".to_owned(), Value::from(self.text.clone()));
        if let Some(sign) = self.delta {
            map.insert("delta".to_owned(), Value::from(sign.to_string()));
        }
        Value::Object(map)
    }
}

/// `splitLineDeltaTokens`: the `+N` / `-N` tokens in front of "Lines" ("+177 lines") split out, so each surface colours
/// them with the one grammar.
pub fn split_line_delta_tokens(text: &str) -> Vec<DeltaPart> {
    let plain = |text: &str| DeltaPart { text: text.to_owned(), delta: None };
    let mut parts = Vec::new();
    let mut last = 0;
    for found in LINE_DELTA.captures_iter(text) {
        let whole = found.range();
        let prefix = found.get(1).unwrap_or_default();
        let raw_token = found.get(2).unwrap_or_default();
        let token: String = raw_token.chars().filter(|c| !is_js_space(*c)).collect();
        let token_start = whole.start + prefix.len();
        if whole.start > last {
            parts.push(plain(&text[last..whole.start]));
        }
        if !prefix.is_empty() {
            parts.push(plain(prefix));
        }
        if !token.is_empty() {
            let delta = Some(if token.starts_with('+') { '+' } else { '-' });
            parts.push(DeltaPart { text: token, delta });
        }
        last = token_start + raw_token.len();
    }
    if last < text.len() {
        parts.push(plain(&text[last..]));
    }
    parts
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn rows_are_single_lines_without_escapes() {
        assert_eq!(safe_inline_text("\u{1b}[31ma\u{1b}[0m\r\n\tb\u{7}  c "), "a b c");
        assert_eq!(safe_inline_text(""), "");
    }

    #[test]
    fn clipping_counts_utf16_units() {
        assert_eq!(clip_plain("abcdef", 4), "abc\u{2026}");
        assert_eq!(clip_plain("abc", 4), "abc");
        assert_eq!(clip_plain("abc", 0), "\u{2026}");
    }

    #[test]
    fn count_maps_keep_object_entries() {
        let map = normalize_count_map(&json!({ "Read": 2.7, "Search": { "count": -1, "noun": "x" }, "Bad": "x" }));
        assert_eq!(map, json!({ "Read": 2, "Search": { "count": 0, "noun": "x" }, "Bad": 0 }));
    }

    #[test]
    fn line_deltas_are_split_out() {
        let parts = split_line_delta_tokens("Edited (+ 12 lines, -3 Lines)");
        let texts: Vec<_> = parts.iter().map(|part| (part.text.as_str(), part.delta)).collect();
        assert_eq!(
            texts,
            vec![
                ("Edited ", None),
                ("(", None),
                ("+12", Some('+')),
                (" lines,", None),
                (" ", None),
                ("-3", Some('-')),
                (" Lines)", None)
            ]
        );
    }
}
