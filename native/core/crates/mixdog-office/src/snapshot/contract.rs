//! One snapshot contract for both backends (`core/snapshot-contract.mjs`). Microsoft Office and the portable reader
//! describe the same document, and design review, assurance and the agent itself all read these fields. Drift between
//! them stays invisible until a rule quietly stops firing, so a snapshot is checked against the fields every reader owes.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_to_lowercase, value_to_string};
use serde_json::{Map, Value};

static A1_REFERENCE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[A-Z]+\d+$", ""));
static TABLE_RANGE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+$", "i"));
static NOTE_CELL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\$?[A-Z]+\$?\d+$", "i"));

/// One place the snapshot breaks the contract.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Violation {
    pub path: String,
    pub message: String,
}

impl Violation {
    /// `{ path, message }`.
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("path".to_owned(), Value::String(self.path.clone()));
        map.insert("message".to_owned(), Value::String(self.message.clone()));
        Value::Object(map)
    }
}

fn push(violations: &mut Vec<Violation>, path: &str, message: impl Into<String>) {
    violations.push(Violation { path: path.to_owned(), message: message.into() });
}

/// A template literal's text of a property: `undefined` when it is absent.
fn shown(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `isCount(value)`: a non-negative whole number.
fn is_count(value: Option<&Value>) -> bool {
    value.and_then(Value::as_f64).is_some_and(|number| number.is_finite() && number.fract() == 0.0 && number >= 0.0)
}

/// `Number.isInteger(value)`.
fn is_integer(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|number| number.is_finite() && number.fract() == 0.0)
}

/// `typeof value === 'string' && value`.
fn non_empty_text(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| !text.is_empty())
}

fn is_bool(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(_)))
}

fn is_object(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_) | Value::Array(_)))
}

fn items(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}

fn check_pagination(pagination: Option<&Value>, violations: &mut Vec<Violation>) {
    let Some(pagination) = pagination.filter(|pagination| !pagination.is_null()) else { return };
    let at = "/pagination";
    if !non_empty_text(pagination.get("unit")) {
        push(violations, at, "pagination.unit must be a non-empty string");
    }
    for key in ["offset", "limit", "returned", "total"] {
        if !is_count(pagination.get(key)) {
            push(violations, at, format!("pagination.{key} must be a non-negative integer"));
        }
    }
    if !is_bool(pagination.get("hasMore")) {
        push(violations, at, "pagination.hasMore must be a boolean");
    }
    if !matches!(pagination.get("nextCursor"), Some(Value::Null | Value::String(_))) {
        push(violations, at, "pagination.nextCursor must be a string or null");
    }
    if is_count(pagination.get("returned")) && is_count(pagination.get("total")) {
        let (returned, total) = (pagination["returned"].as_f64().unwrap_or(0.0), pagination["total"].as_f64().unwrap_or(0.0));
        if returned > total {
            push(violations, at, format!("pagination.returned {} exceeds total {}", shown(pagination.get("returned")), shown(pagination.get("total"))));
        }
    }
    let advertises_more = non_empty_text(pagination.get("nextCursor"));
    if let Some(Value::Bool(has_more)) = pagination.get("hasMore")
        && *has_more != advertises_more
    {
        push(violations, at, "pagination.hasMore must agree with the presence of nextCursor");
    }
}

fn check_docx(document: &Value, violations: &mut Vec<Violation>) {
    for key in ["paragraphCount", "tableCount"] {
        if !is_count(document.get(key)) {
            push(violations, "/", format!("{key} must be a non-negative integer"));
        }
    }
    // The same edit is a revision or a plain rewrite depending on this flag, so both backends owe it rather than
    // leaving the caller to infer the state.
    if !is_bool(document.get("trackChanges")) {
        push(violations, "/", "trackChanges must be a boolean");
    }
    for paragraph in items(document.get("paragraphs")) {
        let index = paragraph.get("index");
        if is_integer(index).is_none_or(|number| number < 1.0) {
            push(violations, "/body", "every paragraph needs a positive integer index");
            continue;
        }
        let at = format!("/body/p[{}]", shown(index));
        if paragraph.get("path").and_then(Value::as_str) != Some(at.as_str()) {
            push(violations, &at, format!("paragraph path {} does not match its index", shown(paragraph.get("path"))));
        }
        if !matches!(paragraph.get("text"), Some(Value::String(_))) {
            push(violations, &at, "paragraph.text must be a string");
        }
        // Word resolves an unstyled paragraph to Normal and reports built-in styles under the UI language. Both
        // backends therefore owe a non-empty styleId, or a caller cannot carry a style from one backend to the other.
        if !non_empty_text(paragraph.get("style")) {
            push(violations, &at, "paragraph.style must be a non-empty style identifier");
        }
        if !is_bool(paragraph.get("inTable")) {
            push(violations, &at, "paragraph.inTable must be a boolean");
        }
    }
    for table in items(document.get("tables")) {
        let index = table.get("index");
        if is_integer(index).is_none_or(|number| number < 1.0) {
            push(violations, "/body", "every table needs a positive integer index");
            continue;
        }
        let at = format!("/body/tbl[{}]", shown(index));
        if table.get("path").and_then(Value::as_str) != Some(at.as_str()) {
            push(violations, &at, format!("table path {} does not match its index", shown(table.get("path"))));
        }
        if !matches!(table.get("rows"), Some(Value::Array(_))) {
            push(violations, &at, "table.rows must be an array");
        }
        if !non_empty_text(table.get("style")) {
            push(violations, &at, "table.style must be a non-empty style identifier");
        }
    }
}

fn check_sheet_cells(at: &str, cells: &[Value], violations: &mut Vec<Violation>) {
    for cell in cells {
        let reference = cell.get("ref").and_then(Value::as_str).filter(|reference| A1_REFERENCE.is_match(reference));
        let Some(reference) = reference else {
            push(violations, at, format!("cell ref {} is not an A1 reference", shown(cell.get("ref"))));
            continue;
        };
        let cell_path = format!("{at}/cell[{reference}]");
        if cell.get("path").and_then(Value::as_str) != Some(cell_path.as_str()) {
            push(violations, &cell_path, format!("cell path {} does not match its reference", shown(cell.get("path"))));
        }
        if cell.get("value").is_none() {
            push(violations, &cell_path, "cell must report a value key");
        }
        // Optional facets both readers publish in one shape.
        if let Some(style) = cell.get("style")
            && !matches!(style, Value::Object(_))
        {
            push(violations, &cell_path, "cell.style must be an object when present");
        }
        if cell.get("dataType").is_some_and(|data_type| data_type.as_str() != Some("text")) {
            push(violations, &cell_path, "cell.dataType must be 'text' when present");
        }
        if cell.get("note").is_some_and(|note| !note.is_string()) {
            push(violations, &cell_path, "cell.note must be a string when present");
        }
    }
}

fn check_xlsx(document: &Value, violations: &mut Vec<Violation>) {
    let sheets = items(document.get("sheets"));
    if sheets.is_empty() {
        push(violations, "/", "a workbook snapshot must report at least one sheet");
    }
    for sheet in sheets {
        let Some(name) = sheet.get("name").and_then(Value::as_str).filter(|name| !name.is_empty()) else {
            push(violations, "/", "every sheet needs a non-empty name");
            continue;
        };
        let at = format!("/sheet[{name}]");
        if sheet.get("path").and_then(Value::as_str) != Some(at.as_str()) {
            push(violations, &at, format!("sheet path {} does not match its name", shown(sheet.get("path"))));
        }
        // Whether Excel shows a sheet is the caller's decision to make, not a code to translate: both readers answer
        // with the word set_sheet_visibility takes.
        if sheet.get("visibility").is_some_and(|visibility| !matches!(visibility.as_str(), Some("visible" | "hidden" | "very_hidden"))) {
            push(violations, &at, "sheet.visibility must be visible, hidden, or very_hidden");
        }
        let Some(Value::Array(cells)) = sheet.get("cells") else { continue };
        check_sheet_cells(&at, cells, violations);
        for table in items(sheet.get("tables")) {
            let range = table.get("range").filter(|range| mixdog_office_base::values::truthy(range)).map(value_to_string).unwrap_or_default();
            if !matches!(table.get("name"), Some(Value::String(_))) || !TABLE_RANGE.is_match(&range) {
                push(violations, &format!("{at}/table"), "every table needs a name and an A1:B2 range");
            }
        }
        for note in items(sheet.get("notes")) {
            let cell_ok = note.get("cell").and_then(Value::as_str).is_some_and(|cell| NOTE_CELL.is_match(cell));
            if !cell_ok || !matches!(note.get("text"), Some(Value::String(_))) {
                push(violations, &format!("{at}/note"), "every note needs a cell reference and text");
            }
        }
        if let Some(panes) = sheet.get("freezePanes")
            && !panes.is_null()
            && (!is_object(Some(panes)) || !is_bool(panes.get("frozen")))
        {
            push(violations, &at, "freezePanes must be null or { frozen, splitRow, splitColumn }");
        }
    }
    if let Some(conventions) = document.get("conventions")
        && !conventions.is_null()
        && (!is_object(Some(conventions)) || !matches!(conventions.get("fonts"), Some(Value::Array(_))))
    {
        push(violations, "/conventions", "conventions must summarize fonts, numberFormats, and inputMarkers");
    }
}

fn check_pptx(document: &Value, violations: &mut Vec<Violation>) {
    if !is_count(document.get("slideCount")) {
        push(violations, "/", "slideCount must be a non-negative integer");
    }
    let mut previous_index = 0.0;
    for slide in items(document.get("slides")) {
        let Some(index) = is_integer(slide.get("index")).filter(|index| *index >= 1.0) else {
            push(violations, "/", "every slide needs a positive integer index");
            continue;
        };
        let at = format!("/slide[{}]", shown(slide.get("index")));
        if slide.get("path").and_then(Value::as_str) != Some(at.as_str()) {
            push(violations, &at, format!("slide path {} does not match its index", shown(slide.get("path"))));
        }
        if index <= previous_index {
            push(violations, &at, "slides must be reported in deck order");
        }
        previous_index = index;
        if !matches!(slide.get("notes"), Some(Value::String(_))) {
            push(violations, &at, "slide.notes must be a string");
        }
        match slide.get("background") {
            Some(background) if mixdog_office_base::values::truthy(background) && is_object(Some(background)) => {
                if !matches!(background.get("color"), Some(Value::String(_))) {
                    push(violations, &at, "slide.background.color must be a string");
                }
            }
            _ => push(violations, &at, "slide.background must be an object"),
        }
        for (position, shape) in items(slide.get("shapes")).iter().enumerate() {
            let shape_path = format!("{at}/shape[{}]", position + 1);
            if shape.get("index").and_then(Value::as_f64) != Some((position + 1) as f64) {
                push(violations, &shape_path, format!("shape.index {} does not match its position", shown(shape.get("index"))));
            }
            if shape.get("path").and_then(Value::as_str) != Some(shape_path.as_str()) {
                push(violations, &shape_path, format!("shape path {} does not match its position", shown(shape.get("path"))));
            }
            let typed = matches!(shape.get("type"), Some(Value::Number(_))) || non_empty_text(shape.get("type"));
            if !typed {
                push(violations, &shape_path, "shape.type must be a number or a non-empty string");
            }
            // A chart, table, or picture holds no text of its own: the model-facing digest leaves its null out, and
            // absent reads the same.
            if !matches!(shape.get("text"), None | Some(Value::Null | Value::String(_))) {
                push(violations, &shape_path, "shape.text must be a string, null, or absent");
            }
        }
    }
}

/// `officeSnapshotContractViolations(document, { format, paged })`: where a snapshot of a `format` session breaks the
/// contract; empty when it keeps it.
pub fn office_snapshot_contract_violations(document: &Value, format: &str, paged: bool) -> Vec<Violation> {
    let mut violations = Vec::new();
    if !is_object(Some(document)) {
        push(&mut violations, "/", "snapshot document must be an object");
        return violations;
    }
    let declared = js_to_lowercase(format);
    if !declared.is_empty() && document.get("format").and_then(Value::as_str) != Some(declared.as_str()) {
        push(&mut violations, "/", format!("document.format {} does not match the {declared} session", shown(document.get("format"))));
    }
    let pagination = document.get("pagination");
    if paged && matches!(pagination, None | Some(Value::Null)) {
        push(&mut violations, "/pagination", "a paged snapshot must report pagination");
    }
    check_pagination(pagination, &mut violations);
    match declared.as_str() {
        "docx" => check_docx(document, &mut violations),
        "xlsx" => check_xlsx(document, &mut violations),
        "pptx" => check_pptx(document, &mut violations),
        _ => {}
    }
    violations
}

/// `describeOfficeSnapshotViolations(violations)`: one `path: message` line each.
pub fn describe_office_snapshot_violations(violations: &[Violation]) -> String {
    violations.iter().map(|entry| format!("{}: {}", entry.path, entry.message)).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn messages(document: &Value, format: &str, paged: bool) -> Vec<String> {
        office_snapshot_contract_violations(document, format, paged).into_iter().map(|entry| format!("{}|{}", entry.path, entry.message)).collect()
    }

    #[test]
    fn a_conforming_workbook_snapshot_has_no_violations() {
        let document = json!({
            "format": "xlsx",
            "sheets": [{ "path": "/sheet[Data]", "name": "Data", "visibility": "visible", "cells": [
                { "path": "/sheet[Data]/cell[A1]", "ref": "A1", "value": "x", "dataType": "text", "style": {} }
            ], "tables": [{ "name": "T", "range": "A1:B2" }], "notes": [{ "cell": "A1", "text": "n" }], "freezePanes": null }],
            "conventions": { "fonts": [] },
            "pagination": { "unit": "populated-cell", "offset": 0, "limit": 10, "returned": 1, "total": 1, "hasMore": false, "nextCursor": null }
        });
        assert!(messages(&document, "xlsx", true).is_empty());
    }

    #[test]
    fn a_mismatching_workbook_is_described_item_by_item() {
        let document = json!({
            "format": "docx",
            "sheets": [
                { "name": "" },
                { "name": "S", "path": "/sheet[T]", "visibility": "gone", "cells": [{ "ref": "a1" }, { "ref": "B2", "path": "/x", "style": [], "dataType": "number", "note": 1 }] },
                { "name": "NoCells", "path": "/sheet[NoCells]", "freezePanes": 5 }
            ]
        });
        assert_eq!(
            messages(&document, "xlsx", false),
            [
                "/|document.format docx does not match the xlsx session",
                "/|every sheet needs a non-empty name",
                "/sheet[S]|sheet path /sheet[T] does not match its name",
                "/sheet[S]|sheet.visibility must be visible, hidden, or very_hidden",
                "/sheet[S]|cell ref a1 is not an A1 reference",
                "/sheet[S]/cell[B2]|cell path /x does not match its reference",
                "/sheet[S]/cell[B2]|cell must report a value key",
                "/sheet[S]/cell[B2]|cell.style must be an object when present",
                "/sheet[S]/cell[B2]|cell.dataType must be 'text' when present",
                "/sheet[S]/cell[B2]|cell.note must be a string when present",
            ]
        );
        assert_eq!(messages(&json!({ "format": "xlsx", "sheets": [] }), "xlsx", false), ["/|a workbook snapshot must report at least one sheet"]);
    }

    #[test]
    fn pagination_must_agree_with_itself() {
        let document = json!({ "format": "pdf", "pagination": { "unit": "", "offset": -1, "limit": 2.5, "returned": 5, "total": 3, "hasMore": true, "nextCursor": null } });
        assert_eq!(
            messages(&document, "pdf", true),
            [
                "/pagination|pagination.unit must be a non-empty string",
                "/pagination|pagination.offset must be a non-negative integer",
                "/pagination|pagination.limit must be a non-negative integer",
                "/pagination|pagination.returned 5 exceeds total 3",
                "/pagination|pagination.hasMore must agree with the presence of nextCursor",
            ]
        );
        assert_eq!(messages(&json!({ "format": "pdf" }), "pdf", true), ["/pagination|a paged snapshot must report pagination"]);
        assert_eq!(messages(&json!(null), "pdf", false), ["/|snapshot document must be an object"]);
    }

    #[test]
    fn document_paragraphs_and_tables_owe_their_paths_and_styles() {
        let document = json!({
            "format": "docx", "paragraphCount": 1, "tableCount": -1, "trackChanges": "yes",
            "paragraphs": [{ "index": 0 }, { "index": 2, "path": "/body/p[1]", "text": 3, "style": "", "inTable": 1 }],
            "tables": [{ "index": 1, "path": "/body/tbl[1]", "rows": {}, "style": "Grid" }, { "index": "x" }]
        });
        assert_eq!(
            messages(&document, "docx", false),
            [
                "/|tableCount must be a non-negative integer",
                "/|trackChanges must be a boolean",
                "/body|every paragraph needs a positive integer index",
                "/body/p[2]|paragraph path /body/p[1] does not match its index",
                "/body/p[2]|paragraph.text must be a string",
                "/body/p[2]|paragraph.style must be a non-empty style identifier",
                "/body/p[2]|paragraph.inTable must be a boolean",
                "/body/tbl[1]|table.rows must be an array",
                "/body|every table needs a positive integer index",
            ]
        );
    }

    #[test]
    fn deck_slides_and_shapes_owe_order_and_places() {
        let document = json!({
            "format": "pptx", "slideCount": 2,
            "slides": [
                { "index": 2, "path": "/slide[2]", "notes": "", "background": { "color": "FFFFFF" }, "shapes": [{ "index": 1, "path": "/slide[2]/shape[1]", "type": "text", "text": null }] },
                { "index": 1, "path": "/slide[1]", "notes": 5, "background": { "color": 1 }, "shapes": [{ "index": 2, "path": "/x", "type": "", "text": 4 }] },
                { "index": 3, "path": "/slide[3]", "notes": "", "shapes": [] }
            ]
        });
        assert_eq!(
            messages(&document, "pptx", false),
            [
                "/slide[1]|slides must be reported in deck order",
                "/slide[1]|slide.notes must be a string",
                "/slide[1]|slide.background.color must be a string",
                "/slide[1]/shape[1]|shape.index 2 does not match its position",
                "/slide[1]/shape[1]|shape path /x does not match its position",
                "/slide[1]/shape[1]|shape.type must be a number or a non-empty string",
                "/slide[1]/shape[1]|shape.text must be a string, null, or absent",
                "/slide[3]|slide.background must be an object",
            ]
        );
        assert_eq!(
            describe_office_snapshot_violations(&office_snapshot_contract_violations(&json!({ "format": "pptx" }), "pptx", false)),
            "/: slideCount must be a non-negative integer"
        );
    }
}
