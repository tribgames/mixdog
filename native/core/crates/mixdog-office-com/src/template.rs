//! The shared parts of `fill_template` (`Template-ValueMap`, `Template-Matches`, `Template-CountFilled`, `Template-Result` of
//! `office-com-host.ps1`): which `{{token}}` values an operation carries, which tokens a text holds, how many were filled,
//! and the answer with the tokens that are left.

use std::sync::OnceLock;

use regex::Regex;

use crate::com::Obj;
use crate::office::text_of;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::collate;
use crate::ps::collate::SortOptions;
use crate::ps::convert;
use crate::ps::payload;

/// One `{{ key }}` in a text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemplateMatch {
    /// The token as written, with its braces and spaces.
    pub raw: String,
    /// The name inside the braces.
    pub key: String,
}

fn token_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}").expect("the template token pattern is valid"))
}

/// `Template-ValueMap`: the operation's `tokens` as name and value, a later entry of the same name (ignoring case) replacing
/// an earlier one; the hashtable the script builds compares names that way.
pub fn template_value_map(op: &Value) -> Result<Vec<(String, Value)>, String> {
    let source = payload::property(op, "tokens");
    if source.is_null() {
        return Err("fill_template requires tokens as an object".to_owned());
    }
    let mut map: Vec<(String, Value)> = Vec::new();
    if let Value::Object(object) = &source {
        for (name, value) in &object.entries {
            match map.iter().position(|(known, _)| payload::names_equal(known, name)) {
                Some(at) => map[at].1 = value.clone(),
                None => map.push((name.clone(), value.clone())),
            }
        }
    }
    Ok(map)
}

/// The value of a token in a map from [`template_value_map`], by name ignoring case.
pub fn template_value<'a>(map: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    map.iter().find(|(name, _)| payload::names_equal(name, key)).map(|(_, value)| value)
}

/// `Template-Matches`: every `{{ key }}` of the text, in order.
pub fn template_matches(text: &str) -> Vec<TemplateMatch> {
    token_pattern()
        .captures_iter(text)
        .map(|found| TemplateMatch {
            raw: found.get(0).map_or_else(String::new, |whole| whole.as_str().to_owned()),
            key: found.get(1).map_or_else(String::new, |name| name.as_str().to_owned()),
        })
        .collect()
}

/// `Template-CountFilled`: `filled[key]` grows by `count` (names compare ignoring case, the first spelling stays).
pub fn template_count_filled(filled: &mut Vec<(String, i32)>, key: &str, count: i32) {
    match filled.iter().position(|(known, _)| payload::names_equal(known, key)) {
        Some(at) => filled[at].1 += count,
        None => filled.push((key.to_owned(), count)),
    }
}

/// `Template-Result`: the answer of a fill, with the tokens still in the `ranges` (each read once, as its `Text`) sorted the
/// way `Sort-Object` sorts; a strict fill with tokens left is refused instead.
pub fn template_result(op: &Value, filled: &[(String, i32)], ranges: &[Obj]) -> Result<Value, String> {
    let mut remaining: Vec<String> = Vec::new();
    for range in ranges {
        let text = text_of(&range.get("Text").map_err(|error| error.message().to_owned())?);
        for found in template_matches(&text) {
            if !remaining.contains(&found.key) {
                remaining.push(found.key);
            }
        }
    }
    let values: Vec<Value> = remaining.into_iter().map(Value::String).collect();
    let unfilled = collate::sort_values(&values, SortOptions::default());
    let strict = convert::to_bool(&payload::property(op, "strict"));
    if strict && !unfilled.is_empty() {
        let names: Vec<String> = unfilled.iter().map(convert::to_ps_string).collect();
        return Err(format!("Unfilled template tokens: {}", names.join(", ")));
    }
    let counts = Value::object(
        ObjectKind::Ordered,
        filled.iter().map(|(key, count)| (key.as_str(), Value::Int(*count))).collect(),
    );
    Ok(Value::object(
        ObjectKind::Ordered,
        vec![
            ("op", Value::string("fill_template")),
            ("changed", Value::Bool(!filled.is_empty())),
            ("filled", counts),
            ("unfilledTokens", crate::ps::unroll(unfilled)),
            ("strict", Value::Bool(strict)),
        ],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(text: &str) -> Value {
        payload::parse_payload(text).expect("a request")
    }

    #[test]
    fn tokens_are_found_with_their_spacing_and_name_characters() {
        let found = template_matches("Dear {{ name }}, {{a.b-c_1}} and {{ bad key }} {{x}}");
        let keys: Vec<&str> = found.iter().map(|found| found.key.as_str()).collect();
        assert_eq!(keys, ["name", "a.b-c_1", "x"]);
        assert_eq!(found[0].raw, "{{ name }}");
    }

    #[test]
    fn the_value_map_needs_tokens_and_ignores_the_case_of_a_name() {
        assert_eq!(template_value_map(&op("{}")).unwrap_err(), "fill_template requires tokens as an object");
        let map = template_value_map(&op("{\"tokens\":{\"Name\":\"a\",\"name\":\"b\",\"other\":1}}")).unwrap();
        assert_eq!(map.len(), 2);
        assert_eq!(template_value(&map, "NAME"), Some(&Value::string("b")));
    }

    #[test]
    fn a_count_adds_to_the_first_spelling_of_the_token() {
        let mut filled = Vec::new();
        template_count_filled(&mut filled, "Name", 2);
        template_count_filled(&mut filled, "name", 3);
        template_count_filled(&mut filled, "city", 1);
        assert_eq!(filled, [("Name".to_owned(), 5), ("city".to_owned(), 1)]);
    }

    #[test]
    fn a_result_without_ranges_lists_no_tokens_and_a_strict_one_has_nothing_to_refuse() {
        let result = template_result(&op("{\"strict\":true}"), &[("a".to_owned(), 1)], &[]).unwrap();
        assert_eq!(
            crate::ps::json::to_json(&result, 4),
            "{\"op\":\"fill_template\",\"changed\":true,\"filled\":{\"a\":1},\"unfilledTokens\":null,\"strict\":true}"
        );
    }
}
