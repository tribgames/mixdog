//! `fillTemplateParts` of `portable/portable-opc.mjs`: the template tokens, `{{name}}`, of the text parts of a document
//! replaced across runs, with the particle a Korean template writes once after the token (`{{company}}은`) put right for the
//! value that lands there.

use mixdog_js::{js_object_keys, value_to_string};
use mixdog_office_base::korean_particles::korean_particle_replacements;
use serde_json::{Map, Value, json};

use crate::xml::{Replaced, TEMPLATE_TOKEN_SOURCE, compiled, paragraph_texts};
use crate::zipio::Package;

/// One token found in a text: as written (with its braces and inner spaces) and its name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateToken {
    pub raw: String,
    pub key: String,
}

/// `templateTokenMatches(text)`: every `{{name}}` in the text, in order.
pub fn template_token_matches(text: &str) -> Vec<TemplateToken> {
    compiled(TEMPLATE_TOKEN_SOURCE, "gu")
        .captures_iter(text)
        .map(|found| TemplateToken { raw: text[found.range()].to_owned(), key: found.get(1).unwrap_or("").to_owned() })
        .collect()
}

/// A text replacement over the runs of a part: `(xml, tag, find, replacement)`, [`crate::xml::replace_across_runs`] or a
/// walker of the format's own.
pub type Replace<'a> = &'a dyn Fn(&str, &str, &str, &str) -> Result<Replaced, String>;

/// The operation `fill_template` runs: the values by token name and whether a token left unfilled is an error.
#[derive(Debug, Clone, Copy)]
pub struct FillTemplate<'a> {
    pub tokens: &'a Value,
    pub strict: bool,
}

/// What `fill_template` reports.
#[derive(Debug, Clone, PartialEq)]
pub struct FillResult {
    pub changed: bool,
    /// How many times each token was filled, by name, in the order an object lists them.
    pub filled: Map<String, Value>,
    pub unfilled_tokens: Vec<String>,
    pub strict: bool,
}

impl FillResult {
    /// The result as the tool returns it: `{ op, changed, filled, unfilledTokens, strict }`.
    pub fn to_value(&self) -> Value {
        json!({
            "op": "fill_template",
            "changed": self.changed,
            "filled": self.filled,
            "unfilledTokens": self.unfilled_tokens,
            "strict": self.strict,
        })
    }
}

/// `Array.prototype.sort()` on strings: by UTF-16 code units.
fn sort_by_code_units(list: &mut [String]) {
    list.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

fn add_filled(filled: &mut Map<String, Value>, key: &str, count: usize) {
    let before = filled.get(key).and_then(Value::as_u64).unwrap_or(0);
    filled.insert(key.to_owned(), Value::from(before + count as u64));
}

/// `fillTemplateParts(zip, parts, tag, operation, { replace })`: fills the tokens of every part that is listed (a part that
/// is missing reads as empty). The tokens given are first tried with the Korean particle written after them, then plain.
/// An error when `tokens` is not an object, when `strict` and a token stays unfilled, and when nothing was filled while
/// tokens remain (the names given and the document's do not meet).
pub fn fill_template_parts(zip: &mut Package, parts: &[String], tag: &str, operation: &FillTemplate<'_>, replace: Replace<'_>) -> Result<FillResult, String> {
    let Value::Object(tokens) = operation.tokens else {
        return Err("fill_template requires tokens as an object".to_owned());
    };
    let mut filled = Map::new();
    let particles = korean_particle_replacements(operation.tokens);
    for part in parts {
        let mut xml = zip.text(part);
        let mut changed = false;
        // The token with the particle written after it first, so "{{company}}은" lands as 모아페이는.
        let text = if particles.is_empty() { String::new() } else { paragraph_texts(&xml, tag).join("") };
        for entry in &particles {
            if !text.contains(&entry.find) {
                continue;
            }
            let replaced = replace(&xml, tag, &entry.find, &entry.replace)?;
            if replaced.count == 0 {
                continue;
            }
            xml = replaced.xml;
            changed = true;
            add_filled(&mut filled, &entry.key, replaced.count);
        }
        // `new Map(matches.map((match) => [match.raw, match.key]))`: a repeated spelling keeps its first place.
        let mut variants: Vec<(String, String)> = Vec::new();
        for token in template_token_matches(&paragraph_texts(&xml, tag).join("")) {
            match variants.iter_mut().find(|(raw, _)| *raw == token.raw) {
                Some(known) => known.1 = token.key,
                None => variants.push((token.raw, token.key)),
            }
        }
        for (raw, key) in variants {
            let Some(value) = tokens.get(&key) else { continue };
            let replacement = if value.is_null() { String::new() } else { value_to_string(value) };
            let replaced = replace(&xml, tag, &raw, &replacement)?;
            if replaced.count == 0 {
                continue;
            }
            xml = replaced.xml;
            changed = true;
            add_filled(&mut filled, &key, replaced.count);
        }
        if changed {
            zip.set(part, xml);
        }
    }
    let mut remaining: Vec<String> = Vec::new();
    for part in parts {
        let xml = zip.text(part);
        for token in template_token_matches(&paragraph_texts(&xml, tag).join("")) {
            if !remaining.contains(&token.key) {
                remaining.push(token.key);
            }
        }
    }
    sort_by_code_units(&mut remaining);
    if operation.strict && !remaining.is_empty() {
        return Err(format!("Unfilled template tokens: {}", remaining.join(", ")));
    }
    // Nothing filled while placeholders remain means the supplied names and the document's do not meet; "no change" alone
    // would leave the caller guessing.
    if filled.is_empty() && !remaining.is_empty() {
        let carried: Vec<String> = remaining.iter().map(|key| format!("{{{{{key}}}}}")).collect();
        let named: Vec<&str> = js_object_keys(tokens).into_iter().map(String::as_str).collect();
        return Err(format!(
            "fill_template changed nothing: the document carries {} and tokens named {}",
            carried.join(", "),
            if named.is_empty() { "nothing".to_owned() } else { named.join(", ") }
        ));
    }
    let mut ordered = Map::new();
    for key in js_object_keys(&filled) {
        ordered.insert(key.clone(), filled[key].clone());
    }
    Ok(FillResult { changed: !ordered.is_empty(), filled: ordered, unfilled_tokens: remaining, strict: operation.strict })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xml::replace_across_runs;

    fn document(runs: &[&str]) -> Package {
        let body: String = runs.iter().map(|run| format!("<w:r><w:t>{run}</w:t></w:r>")).collect();
        let mut zip = Package::new();
        zip.set("word/document.xml", format!("<w:document><w:body><w:p>{body}</w:p></w:body></w:document>"));
        zip
    }

    fn fill(zip: &mut Package, tokens: &Value, strict: bool) -> Result<FillResult, String> {
        let parts = vec!["word/document.xml".to_owned()];
        fill_template_parts(zip, &parts, "w:t", &FillTemplate { tokens, strict }, &replace_across_runs)
    }

    #[test]
    fn tokens_are_found_in_the_script_of_the_document() {
        let found = template_token_matches("a {{ 계약명 }} b {{x.y-1}} {{ }} {{a b}}");
        assert_eq!(
            found,
            vec![TemplateToken { raw: "{{ 계약명 }}".into(), key: "계약명".into() }, TemplateToken { raw: "{{x.y-1}}".into(), key: "x.y-1".into() },]
        );
    }

    #[test]
    fn a_token_split_across_runs_is_filled_and_counted() {
        let mut zip = document(&["Dear {{na", "me}}, hi {{name}}"]);
        let result = fill(&mut zip, &json!({ "name": "Ann" }), false).unwrap();
        assert!(result.changed);
        assert_eq!(result.to_value(), json!({ "op": "fill_template", "changed": true, "filled": { "name": 2 }, "unfilledTokens": [], "strict": false }));
        assert_eq!(paragraph_texts(&zip.text("word/document.xml"), "w:t").join(""), "Dear Ann, hi Ann");
    }

    #[test]
    fn the_korean_particle_follows_the_value() {
        let mut zip = document(&["{{company}}은 {{city}}으로 "]);
        let result = fill(&mut zip, &json!({ "company": "모아페이", "city": "서울" }), false).unwrap();
        assert_eq!(paragraph_texts(&zip.text("word/document.xml"), "w:t").join(""), "모아페이는 서울로 ");
        assert_eq!(result.filled.len(), 2);
    }

    #[test]
    fn strict_and_unmatched_names_are_errors() {
        let mut zip = document(&["{{a}} and {{b}}"]);
        assert_eq!(fill(&mut zip, &json!({ "a": "1" }), true).unwrap_err(), "Unfilled template tokens: b");
        let mut zip = document(&["{{a}} and {{b}}"]);
        assert_eq!(
            fill(&mut zip, &json!({ "z": "1" }), false).unwrap_err(),
            "fill_template changed nothing: the document carries {{a}}, {{b}} and tokens named z"
        );
        let mut zip = document(&["{{a}}"]);
        assert_eq!(fill(&mut zip, &json!({}), false).unwrap_err(), "fill_template changed nothing: the document carries {{a}} and tokens named nothing");
        let mut zip = document(&["plain"]);
        let result = fill(&mut zip, &json!({}), false).unwrap();
        assert!(!result.changed);
        assert_eq!(fill(&mut zip, &json!([1]), false).unwrap_err(), "fill_template requires tokens as an object");
    }

    #[test]
    fn a_null_value_fills_with_nothing() {
        let mut zip = document(&["[{{a}}]"]);
        let result = fill(&mut zip, &json!({ "a": null }), false).unwrap();
        assert_eq!(result.filled["a"], json!(1));
        assert_eq!(paragraph_texts(&zip.text("word/document.xml"), "w:t").join(""), "[]");
    }
}
