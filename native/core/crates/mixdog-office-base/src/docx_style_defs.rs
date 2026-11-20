//! `docxStyleDefinitions` of `portable/portable-docx-operations.mjs`: the styles a `define_styles` operation asks for,
//! checked before anything is written. The contract engine of the office crate refuses a misspelt field with it, and
//! the docx engine reads the same entries to write them.

use mixdog_js::js_object_keys;
use serde_json::{Map, Value};

/// `DOCX_STYLE_FIELDS`: what one style takes in `define_styles`, its face, size, weight, ink and its paragraph's flow.
pub const DOCX_STYLE_FIELDS: [&str; 13] = [
    "name",
    "nameEastAsia",
    "size",
    "bold",
    "italic",
    "color",
    "alignment",
    "spacingBefore",
    "spacingAfter",
    "lineSpacing",
    "lineSpacingRule",
    "keepWithNext",
    "keepTogether",
];

/// `docxStyleDefinitions(op)`: the `(style name, fields)` entries in the order `Object.entries` lists them, or the
/// message Node throws, which lists every fault at once.
pub fn docx_style_definitions(op: &Map<String, Value>) -> Result<Vec<(&str, &Value)>, String> {
    let styles = match op.get("styles") {
        Some(Value::Object(styles)) if !styles.is_empty() => styles,
        _ => {
            return Err(format!(
                "define_styles needs styles: {{ \"<style name>\": {{ {} }} }}, e.g. {{ \"Heading 1\": {{ size: 15, bold: true }} }}",
                DOCX_STYLE_FIELDS.join(", ")
            ));
        }
    };
    let mut faults: Vec<String> = Vec::new();
    let mut entries: Vec<(&str, &Value)> = Vec::new();
    for style in js_object_keys(styles) {
        let fields = &styles[style];
        entries.push((style.as_str(), fields));
        let Value::Object(fields) = fields else {
            faults.push(format!("{style}: needs an object of fields"));
            continue;
        };
        let unknown: Vec<&str> = js_object_keys(fields).into_iter().map(String::as_str).filter(|field| !DOCX_STYLE_FIELDS.contains(field)).collect();
        if !unknown.is_empty() {
            faults.push(format!("{style}: unknown fields {}", unknown.join(", ")));
        }
    }
    if !faults.is_empty() {
        return Err(format!("define_styles: {}. Fields: {}.", faults.join("; "), DOCX_STYLE_FIELDS.join(", ")));
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn definitions(op: &Value) -> Result<Vec<String>, String> {
        docx_style_definitions(op.as_object().expect("object")).map(|entries| entries.into_iter().map(|(name, _)| name.to_owned()).collect())
    }

    #[test]
    fn valid_styles_come_back_in_object_order() {
        let op = json!({ "op": "define_styles", "styles": { "Title": { "size": 20 }, "Heading 1": { "size": 15, "bold": true } } });
        assert_eq!(definitions(&op), Ok(vec!["Title".to_owned(), "Heading 1".to_owned()]));
    }

    #[test]
    fn missing_styles_name_the_expected_shape() {
        for op in [json!({}), json!({ "styles": null }), json!({ "styles": [] }), json!({ "styles": {} }), json!({ "styles": "x" })] {
            let error = definitions(&op).expect_err("refused");
            assert!(error.starts_with("define_styles needs styles: { \"<style name>\": { name, nameEastAsia, size,"), "{error}");
            assert!(error.ends_with("e.g. { \"Heading 1\": { size: 15, bold: true } }"), "{error}");
        }
    }

    #[test]
    fn every_fault_is_listed_in_one_message() {
        let op = json!({ "styles": { "A": { "colour": "red", "font": "x" }, "B": 3, "C": { "bold": true }, "D": [] } });
        assert_eq!(
            definitions(&op),
            Err("define_styles: A: unknown fields colour, font; B: needs an object of fields; D: needs an object of fields. Fields: name, nameEastAsia, size, bold, italic, color, alignment, spacingBefore, spacingAfter, lineSpacing, lineSpacingRule, keepWithNext, keepTogether.".to_owned())
        );
    }
}
