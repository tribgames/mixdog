//! The block contracts of `pdf-writer.mjs`: what each block type takes, the faults a block list is refused with (all
//! of them together, before anything is drawn), the text a block carries (for the choice of the document's font) and
//! the JavaScript value rules the rest of the writer reads blocks with (`Number(block.size || 11)`, `block.x ?? margin`).

use mixdog_js::{js_object_keys, js_to_lowercase, json_stringify, to_number, value_to_string};
use serde_json::Value;

/// `FLOW_FIELDS`: what every block may place.
const FLOW_FIELDS: [&str; 6] = ["before", "after", "x", "width", "color", "align"];

/// The block types in the order the refusal names them (`Object.keys(BLOCK_FIELDS)`).
pub const BLOCK_KINDS: [&str; 15] =
    ["paragraph", "heading", "list", "table", "image", "pagebreak", "cover", "callout", "quote", "caption", "stats", "chart", "rule", "field", "fieldRow"];

type Definition = (Vec<&'static str>, Vec<&'static str>);

/// A block type's own fields: `(required, optional)`; the flow fields come with every type that lists them.
fn definition(kind: &str) -> Option<Definition> {
    let flow = |own: &[&'static str]| -> Vec<&'static str> { FLOW_FIELDS.iter().copied().chain(own.iter().copied()).collect() };
    Some(match kind {
        "paragraph" => (vec!["text"], flow(&["size", "lineHeight"])),
        "heading" => (vec!["text"], flow(&["size", "lineHeight", "level"])),
        "list" => (vec!["items"], flow(&["size", "lineHeight", "marker", "indent", "ordered"])),
        "table" => (
            vec!["rows"],
            flow(&[
                "headers",
                "columnWidths",
                "columnAlignments",
                "fontSize",
                "rowHeight",
                "headerFill",
                "headerColor",
                "zebraFill",
                "borderColor",
                "repeatHeader",
                "grid",
                "totalRow",
            ]),
        ),
        "image" => (vec!["path"], flow(&["height", "y"])),
        "pagebreak" => (vec![], vec![]),
        "cover" => (vec!["title"], flow(&["eyebrow", "subtitle", "meta", "size", "subtitleSize", "accent", "rule"])),
        "callout" => (vec!["text"], flow(&["label", "size", "lineHeight", "fill", "labelColor", "padding"])),
        "quote" => (vec!["text"], flow(&["attribution", "size", "lineHeight", "accent"])),
        "caption" => (vec!["text"], flow(&["size"])),
        "stats" => (vec!["items"], flow(&["size", "labelSize", "accent", "rule"])),
        "chart" => (vec!["categories", "values"], flow(&["chartType", "title", "unit", "highlight", "forecast", "height", "size", "accent"])),
        "rule" => (vec![], flow(&["thickness"])),
        "field" => (
            vec!["name"],
            flow(&["label", "fieldType", "height", "value", "options", "multiline", "maxLength", "fontSize", "labelSize", "required", "readOnly"]),
        ),
        "fieldRow" => (vec!["items"], flow(&["gutter", "height", "labelSize"])),
        _ => return None,
    })
}

// JavaScript values

/// JavaScript truthiness of a present value.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}

pub fn is_truthy(value: Option<&Value>) -> bool {
    value.is_some_and(truthy)
}

/// `Number(value || fallback)`.
pub fn num_or(value: Option<&Value>, fallback: f64) -> f64 {
    match value {
        Some(value) if truthy(value) => to_number(value),
        _ => fallback,
    }
}

/// `Number(value ?? fallback)`.
pub fn num_nn(value: Option<&Value>, fallback: f64) -> f64 {
    match value {
        None | Some(Value::Null) => fallback,
        Some(value) => to_number(value),
    }
}

/// `Number(value)` of a field that may be absent (NaN when it is).
pub fn num(value: Option<&Value>) -> f64 {
    value.map_or(f64::NAN, to_number)
}

/// `String(value ?? '')`.
pub fn text_of(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    }
}

/// `String(value)` of a field that may be absent (`"undefined"`).
pub fn string_of(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `String(value || fallback)`.
pub fn text_or(value: Option<&Value>, fallback: &str) -> String {
    match value {
        Some(value) if truthy(value) => value_to_string(value),
        _ => fallback.to_owned(),
    }
}

/// The items of a field that is an array (`Array.isArray(x) ? x : []`).
pub fn items_of(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn text_cell(value: &Value) -> String {
    text_of(Some(value))
}

// the block type

/// `blockType(block)`: the declared type in lower case (`paragraph` when none), `fieldrow` read as `fieldRow`.
pub fn block_type(block: &Value) -> String {
    let declared = js_to_lowercase(&text_or(block.get("type"), "paragraph"));
    if declared == "fieldrow" { "fieldRow".to_owned() } else { declared }
}

// the faults

/// `forecastEntries(block)`: the bars that are projections, as an index, a category, or a list of them.
pub fn forecast_entries(block: &Value) -> Vec<&Value> {
    match block.get("forecast") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.iter().collect(),
        Some(other) => vec![other],
    }
}

/// `forecastIndex(categories, entry)`: the bar an entry names, or -1.
pub fn forecast_index(categories: &[Value], entry: &Value) -> i64 {
    if let Value::Number(number) = entry {
        let at = number.as_f64().unwrap_or(f64::NAN);
        return if at.fract() == 0.0 && at >= 0.0 && at < categories.len() as f64 { at as i64 } else { -1 };
    }
    let wanted = value_to_string(entry);
    categories.iter().position(|category| text_of(Some(category)) == wanted).map_or(-1, |at| at as i64)
}

fn good_chart_values(values: &Value) -> bool {
    match values {
        Value::Array(items) => {
            !items.is_empty() && items.iter().all(|item| matches!(item, Value::Number(number) if number.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)))
        }
        _ => false,
    }
}

fn chart_shape_faults(block: &Value, at: &str) -> Vec<String> {
    let mut faults = Vec::new();
    let categories = block.get("categories");
    let values = block.get("values");
    if categories.is_some() && !matches!(categories, Some(Value::Array(_))) {
        faults.push(format!("PDF {at} (chart) categories must be an array of labels."));
    }
    if values.is_some_and(|values| !good_chart_values(values)) {
        faults.push(format!("PDF {at} (chart) values must be a non-empty array of numbers, zero or more."));
    } else if let (Some(Value::Array(categories)), Some(Value::Array(values))) = (categories, values) {
        if categories.len() != values.len() {
            faults.push(format!("PDF {at} (chart) has {} categories and {} values; give one value per category.", categories.len(), values.len()));
        }
    }
    if let Some(kind) = block.get("chartType") {
        if !matches!(js_to_lowercase(&value_to_string(kind)).as_str(), "bar" | "column") {
            faults.push(format!("PDF {at} (chart) chartType is bar (bars across) or column (bars upright)."));
        }
    }
    // A projection named wrong would be drawn as a counted figure without a word: every one must name a bar.
    if let (Some(_), Some(Value::Array(categories))) = (block.get("forecast"), categories) {
        let unknown: Vec<String> = forecast_entries(block).into_iter().filter(|entry| forecast_index(categories, entry) < 0).map(json_stringify).collect();
        if !unknown.is_empty() {
            faults.push(format!(
                "PDF {at} (chart) forecast names {}, not a category or its index; name the projected bars as categories names them.",
                unknown.join(", ")
            ));
        }
    }
    faults
}

fn good_stats_items(items: &Value) -> bool {
    match items {
        Value::Array(items) => items.iter().all(|item| matches!(item, Value::Object(map) if map.contains_key("value"))),
        _ => false,
    }
}

/// `blockShapeFaults(type, block, at)`: the shape each block type's list fields must have.
fn block_shape_faults(kind: &str, block: &Value, at: &str) -> Vec<String> {
    let mut faults = Vec::new();
    if kind == "table" && block.get("rows").is_some_and(|rows| !rows.is_array()) {
        faults.push(format!("PDF {at} (table) rows must be an array of row arrays."));
    }
    if kind == "list" && block.get("items").is_some_and(|items| !items.is_array()) {
        faults.push(format!("PDF {at} (list) items must be an array of strings."));
    }
    if kind == "stats" && block.get("items").is_some_and(|items| !good_stats_items(items)) {
        faults.push(format!("PDF {at} (stats) items must be an array of {{ value, label }} objects."));
    }
    if kind == "cover" && block.get("meta").is_some_and(|meta| !meta.is_array()) {
        faults.push(format!("PDF {at} (cover) meta must be an array of strings (one line each)."));
    }
    if kind == "chart" {
        faults.extend(chart_shape_faults(block, at));
    }
    faults
}

fn block_faults(block: &Value, index: usize) -> Vec<String> {
    let at = format!("block {}", index + 1);
    let Some(map) = block.as_object() else {
        return vec![format!("PDF {at} must be an object with type: {}.", BLOCK_KINDS.join(", "))];
    };
    if map.contains_key("kind") && !map.contains_key("type") {
        return vec![format!("PDF {at} names its block with kind; the field is type: {{ type: '{}' }}.", string_of(map.get("kind")))];
    }
    let kind = block_type(block);
    let Some((required, optional)) = definition(&kind) else {
        return vec![format!("PDF {at} has unknown type \"{kind}\". Use one of: {}.", BLOCK_KINDS.join(", "))];
    };
    let mut faults = Vec::new();
    let mut allowed: Vec<&str> = vec!["type"];
    for field in required.iter().chain(optional.iter()) {
        if !allowed.contains(field) {
            allowed.push(field);
        }
    }
    let unknown: Vec<&str> = js_object_keys(map).into_iter().map(String::as_str).filter(|field| !allowed.contains(field)).collect();
    if !unknown.is_empty() {
        faults.push(format!("PDF {at} ({kind}) has unknown field(s): {}. {kind} takes: {}.", unknown.join(", "), allowed.join(", ")));
    }
    let missing: Vec<&str> = required.iter().copied().filter(|field| !map.contains_key(*field)).collect();
    if !missing.is_empty() {
        faults.push(format!("PDF {at} ({kind}) is missing: {}.", missing.join(", ")));
    }
    faults.extend(block_shape_faults(&kind, block, &at));
    faults
}

/// `assertPdfBlocks(blocks)`: every block contract fault together.
pub fn assert_pdf_blocks(blocks: &[Value]) -> Result<(), String> {
    let faults: Vec<String> = blocks.iter().enumerate().flat_map(|(index, block)| block_faults(block, index)).collect();
    match faults.len() {
        0 => Ok(()),
        1 => Err(faults.into_iter().next().unwrap_or_default()),
        count => Err(format!("This PDF breaks {count} block contracts; fix them together. {}", faults.join(" "))),
    }
}

// the text of a block

/// `blockText(block)`: every string the block draws that the font must cover.
pub fn block_text(block: &Value) -> String {
    let kind = block_type(block);
    match kind.as_str() {
        "table" => {
            let mut parts: Vec<String> = items_of(block.get("headers")).iter().map(text_cell).collect();
            for row in items_of(block.get("rows")) {
                match row {
                    Value::Array(cells) => parts.extend(cells.iter().map(text_cell)),
                    other => parts.push(text_cell(other)),
                }
            }
            parts.join(" ")
        }
        "list" => items_of(block.get("items")).iter().map(text_cell).collect::<Vec<_>>().join(" "),
        "stats" => items_of(block.get("items"))
            .iter()
            .map(|item| format!("{} {}", text_of(item.get("value")), text_of(item.get("label"))))
            .collect::<Vec<_>>()
            .join(" "),
        "cover" => {
            let mut parts = vec![text_of(block.get("eyebrow")), text_of(block.get("title")), text_of(block.get("subtitle"))];
            parts.extend(items_of(block.get("meta")).iter().map(text_cell));
            parts.join(" ")
        }
        "callout" => format!("{} {}", text_of(block.get("label")), text_of(block.get("text"))),
        "quote" => format!("{} {}", text_of(block.get("text")), text_of(block.get("attribution"))),
        "chart" => {
            let mut parts = vec![text_of(block.get("title")), text_of(block.get("unit"))];
            parts.extend(items_of(block.get("categories")).iter().map(text_cell));
            parts.join(" ")
        }
        "image" | "pagebreak" | "rule" => String::new(),
        _ => text_of(block.get("text")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn refused(blocks: Value) -> String {
        assert_pdf_blocks(blocks.as_array().expect("blocks")).unwrap_err()
    }

    #[test]
    fn a_block_the_writer_cannot_read_is_refused_by_name() {
        assert_eq!(refused(json!([{ "kind": "table" }])), "PDF block 1 names its block with kind; the field is type: { type: 'table' }.");
        assert_eq!(refused(json!([{ "type": "pie" }])), format!("PDF block 1 has unknown type \"pie\". Use one of: {}.", BLOCK_KINDS.join(", ")));
        assert_eq!(refused(json!([5])), format!("PDF block 1 must be an object with type: {}.", BLOCK_KINDS.join(", ")));
        assert_eq!(refused(json!([{ "type": "table" }])), "PDF block 1 (table) is missing: rows.");
    }

    #[test]
    fn unknown_fields_are_listed_with_what_the_block_takes() {
        let message = refused(json!([{ "type": "caption", "text": "a", "colour": "red" }]));
        assert_eq!(message, "PDF block 1 (caption) has unknown field(s): colour. caption takes: type, text, before, after, x, width, color, align, size.");
    }

    #[test]
    fn several_faults_are_reported_together() {
        let message = refused(json!([{ "type": "list", "items": "a" }, { "type": "chart", "categories": ["a"], "values": [1, 2] }]));
        assert_eq!(
            message,
            "This PDF breaks 2 block contracts; fix them together. PDF block 1 (list) items must be an array of strings. PDF block 2 (chart) has 1 categories and 2 values; give one value per category."
        );
    }

    #[test]
    fn a_field_row_is_matched_without_regard_to_case() {
        assert_eq!(block_type(&json!({ "type": "FieldRow" })), "fieldRow");
        assert_eq!(block_type(&json!({})), "paragraph");
        assert!(assert_pdf_blocks(&[json!({ "type": "fieldrow", "items": [] })]).is_ok());
    }

    #[test]
    fn a_projection_must_name_a_bar() {
        let message = refused(json!([{ "type": "chart", "categories": ["Q1", "Q2"], "values": [1, 2], "forecast": ["Q3", 1, 5] }]));
        assert_eq!(message, "PDF block 1 (chart) forecast names \"Q3\", 5, not a category or its index; name the projected bars as categories names them.");
        assert_eq!(forecast_index(&[json!("Q1"), json!("Q2")], &json!("Q2")), 1);
        assert_eq!(forecast_index(&[json!("Q1")], &json!(1.5)), -1);
    }

    #[test]
    fn chart_values_are_numbers_zero_or_more() {
        let message = refused(json!([{ "type": "chart", "categories": ["a"], "values": [-1], "chartType": "pie" }]));
        assert_eq!(
            message,
            "This PDF breaks 2 block contracts; fix them together. PDF block 1 (chart) values must be a non-empty array of numbers, zero or more. PDF block 1 (chart) chartType is bar (bars across) or column (bars upright)."
        );
    }

    #[test]
    fn the_text_of_a_block_is_what_it_draws() {
        let table = json!({ "type": "table", "headers": ["A", "B"], "rows": [["1", 2], "x"] });
        assert_eq!(block_text(&table), "A B 1 2 x");
        assert_eq!(block_text(&json!({ "type": "stats", "items": [{ "value": "9", "label": "up" }] })), "9 up");
        assert_eq!(block_text(&json!({ "type": "callout", "text": "t" })), " t");
        assert_eq!(block_text(&json!({ "type": "image", "path": "p" })), "");
        assert_eq!(block_text(&json!({ "type": "cover", "title": "T", "meta": ["m"] })), " T  m");
    }

    #[test]
    fn javascript_value_rules() {
        assert_eq!(num_or(Some(&json!(0)), 11.0), 11.0);
        assert_eq!(num_or(Some(&json!("14")), 11.0), 14.0);
        assert_eq!(num_nn(Some(&json!(0)), 11.0), 0.0);
        assert_eq!(num_nn(Some(&Value::Null), 11.0), 11.0);
        assert!(num(None).is_nan());
        assert_eq!(text_of(Some(&Value::Null)), "");
        assert_eq!(text_of(Some(&json!(3))), "3");
    }
}
