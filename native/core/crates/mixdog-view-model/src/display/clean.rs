//! `runtime/shared/clean.mjs`: the input normalizers every surface shares.

use mixdog_js::js_trim;
use mixdog_js::js_words;
use mixdog_js::value_to_string;
use serde_json::Value;

/// `clean(value)`: any value as a trimmed string; `null` and `undefined` (`None`) are empty.
pub fn clean(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_trim(&value_to_string(value)).to_owned(),
    }
}

/// `cleanString(value)`: only a string counts (trimmed); anything else is empty.
pub fn clean_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => js_trim(text).to_owned(),
        _ => String::new(),
    }
}

/// `oneLine(value)`: every whitespace run (newlines included) collapsed into one space, trimmed.
pub fn one_line(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_words(&value_to_string(value)).collect::<Vec<_>>().join(" "),
    }
}

/// `oneLine` of text.
pub fn one_line_text(text: &str) -> String {
    js_words(text).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn clean_trims_any_value_and_empties_null() {
        assert_eq!(clean(Some(&json!("  a b \n"))), "a b");
        assert_eq!(clean(Some(&json!(12))), "12");
        assert_eq!(clean(Some(&Value::Null)), "");
        assert_eq!(clean(None), "");
        assert_eq!(clean(Some(&json!(false))), "false");
    }

    #[test]
    fn clean_string_counts_strings_only() {
        assert_eq!(clean_string(Some(&json!(" x "))), "x");
        assert_eq!(clean_string(Some(&json!(5))), "");
        assert_eq!(clean_string(None), "");
    }

    #[test]
    fn one_line_collapses_whitespace_runs() {
        assert_eq!(one_line(Some(&json!("  a\n\n b\t c "))), "a b c");
        assert_eq!(one_line_text("\u{a0}x\u{2003}y"), "x y");
        assert_eq!(one_line(None), "");
    }
}
