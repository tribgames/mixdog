//! Keyword tables: `compileKeywords`, `scoreForKeyword` and `commonKeyword` of core.js.

use std::collections::HashMap;

use crate::languages::{Raw, RawObject};

/// `keyword -> (class name, relevance score)` of one mode.
pub(crate) type KeywordTable = HashMap<String, (String, f64)>;

/// Keywords that carry no default relevance.
const COMMON_KEYWORDS: [&str; 11] = ["of", "and", "for", "in", "not", "or", "if", "then", "parent", "list", "value"];

/// The class a bare list of keywords gets.
pub(crate) const DEFAULT_KEYWORD_CLASSNAME: &str = "keyword";

fn common_keyword(keyword: &str) -> bool {
    let lower = mixdog_js::js_to_lowercase(keyword);
    COMMON_KEYWORDS.contains(&lower.as_str())
}

/// A manual score always wins over the common-keyword rule.
fn score_for_keyword(keyword: &str, provided: Option<&str>) -> f64 {
    match provided {
        Some(text) if !text.is_empty() => mixdog_js::string_to_number(text),
        _ if common_keyword(keyword) => 0.0,
        _ => 1.0,
    }
}

fn compile_list<'a>(class_name: &str, list: impl Iterator<Item = &'a str>, case_insensitive: bool, table: &mut KeywordTable) {
    for keyword in list {
        let keyword = if case_insensitive { mixdog_js::js_to_lowercase(keyword) } else { keyword.to_string() };
        let mut pair = keyword.split('|');
        let word = pair.next().unwrap_or("");
        let score = score_for_keyword(word, pair.next());
        // `compiledKeywords["__proto__"] = [...]` sets the prototype of the table and adds no key.
        if word != "__proto__" {
            table.insert(word.to_string(), (class_name.to_string(), score));
        }
    }
}

/// `compileKeywords(raw, caseInsensitive, className)`: `raw` is a string of words, a list, or an object whose
/// keys are class names (the keys are walked in order, later ones overriding earlier ones).
pub(crate) fn compile_keywords(raw: &Raw, nodes: &[RawObject], case_insensitive: bool, class_name: &str, table: &mut KeywordTable) {
    match raw {
        Raw::Str(text) => compile_list(class_name, text.split(' '), case_insensitive, table),
        Raw::Arr(items) => {
            let words = items.iter().filter_map(|item| match item {
                Raw::Str(s) => Some(s.as_str()),
                _ => None,
            });
            compile_list(class_name, words, case_insensitive, table);
        }
        Raw::Obj(id) => {
            for (class, value) in &nodes[*id].fields {
                compile_keywords(value, nodes, case_insensitive, class, table);
            }
        }
        Raw::Null | Raw::Bool(_) | Raw::Num(_) | Raw::Re(_) | Raw::Cb(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table_of(raw: Raw, nodes: &[RawObject], ci: bool) -> KeywordTable {
        let mut table = KeywordTable::new();
        compile_keywords(&raw, nodes, ci, DEFAULT_KEYWORD_CLASSNAME, &mut table);
        table
    }

    #[test]
    fn a_string_is_a_list_of_keywords_with_scores() {
        let table = table_of(Raw::Str("for if when while|5 Foo".to_string()), &[], false);
        assert_eq!(table["for"], ("keyword".to_string(), 0.0));
        assert_eq!(table["if"].1, 0.0);
        assert_eq!(table["when"].1, 1.0);
        assert_eq!(table["while"].1, 5.0);
        assert_eq!(table["Foo"].1, 1.0);
    }

    #[test]
    fn case_insensitive_tables_lower_the_words() {
        let table = table_of(Raw::Str("Foo AND".to_string()), &[], true);
        assert!(table.contains_key("foo"));
        assert_eq!(table["and"].1, 0.0);
    }

    #[test]
    fn an_object_names_the_class_of_each_list_and_later_keys_win() {
        let node = RawObject {
            frozen: false,
            fields: vec![
                ("keyword".to_string(), Raw::Str("a b".to_string())),
                ("built_in".to_string(), Raw::Arr(vec![Raw::Str("b|3".to_string()), Raw::Str("c".to_string())])),
            ],
        };
        let table = table_of(Raw::Obj(0), &[node], false);
        assert_eq!(table["a"], ("keyword".to_string(), 1.0));
        assert_eq!(table["b"], ("built_in".to_string(), 3.0));
        assert_eq!(table["c"].0, "built_in");
    }

    #[test]
    fn a_proto_keyword_adds_nothing() {
        let table = table_of(Raw::Str("__proto__ x".to_string()), &[], false);
        assert_eq!(table.len(), 1);
    }
}
