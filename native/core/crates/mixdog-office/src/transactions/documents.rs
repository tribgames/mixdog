//! What a transaction says about a document: its fingerprint, the diff between two reads of it and the paths an operation
//! touches (`core/office-documents.mjs`).
//!
//! A document read is a JSON value whose objects carry a `path` (`/body/p[3]`, `/sheet[Data]/cell[B2]`, `/slide[2]/shape[1]`).
//! The diff indexes every object that names a path by its scalar fields, sorts the paths by UTF-16 code unit and reports each
//! one added, removed or changed, at most 500 of them.

use std::collections::HashMap;

use mixdog_js::{js_object_keys, json_stringify, number_to_string, to_number, value_to_string};
use mixdog_office_base::formats::is_tabular_format;
use mixdog_office_base::values::{sha256, truthy};
use serde_json::{Map, Value, json};

use crate::bounded::stable_json;

/// How many changes a diff lists before it says it is truncated.
pub const DIFF_LIMIT: usize = 500;

/// `documentSnapshotFingerprint(document)`: the SHA-256 of the document read with every object's keys sorted.
pub fn document_snapshot_fingerprint(document: &Value) -> String {
    sha256(stable_json(document))
}

/// `scalarState(value)`: the fields of an object that are neither its `path` nor an object or an array (a `null` is a scalar).
fn scalar_state(value: &Value) -> Value {
    let mut state = Map::new();
    let mut keep = |key: &str, item: &Value| {
        if key != "path" && !matches!(item, Value::Object(_) | Value::Array(_)) {
            state.insert(key.to_owned(), item.clone());
        }
    };
    match value {
        Value::Object(map) => {
            for key in js_object_keys(map) {
                keep(key, &map[key.as_str()]);
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                keep(&index.to_string(), item);
            }
        }
        _ => return value.clone(),
    }
    Value::Object(state)
}

/// `documentPathIndex(document)`: path to scalar state, in the order the paths were first met.
fn document_path_index(document: &Value) -> HashMap<String, Value> {
    fn visit(entries: &mut HashMap<String, Value>, value: &Value, fallback: &str) {
        if !matches!(value, Value::Object(_) | Value::Array(_)) {
            return;
        }
        let path = value.get("path").and_then(Value::as_str).unwrap_or(fallback);
        if !path.is_empty() {
            entries.insert(path.to_owned(), scalar_state(value));
        }
        match value {
            Value::Array(items) => {
                for item in items {
                    visit(entries, item, "");
                }
            }
            Value::Object(map) => {
                for key in js_object_keys(map) {
                    visit(entries, &map[key.as_str()], "");
                }
            }
            _ => {}
        }
    }
    let mut entries = HashMap::new();
    visit(&mut entries, document, "/");
    entries
}

/// `diffDocuments(before, after, limit)`: `{ summary: { added, removed, modified, total }, changes, truncated }`. A change is
/// `{ path, kind, before, after }` with the side that does not exist left out.
pub fn diff_documents(before: &Value, after: &Value, limit: usize) -> Value {
    let left = document_path_index(before);
    let right = document_path_index(after);
    let mut paths: Vec<&String> = left.keys().chain(right.keys()).collect();
    paths.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    paths.dedup();
    let (mut added, mut removed, mut modified) = (0_u64, 0_u64, 0_u64);
    let mut changes: Vec<Value> = Vec::new();
    for path in paths {
        let (before_value, after_value) = (left.get(path), right.get(path));
        let kind = match (before_value, after_value) {
            (None, _) => {
                added += 1;
                "added"
            }
            (_, None) => {
                removed += 1;
                "removed"
            }
            (Some(was), Some(is)) if json_stringify(was) != json_stringify(is) => {
                modified += 1;
                "modified"
            }
            _ => continue,
        };
        if changes.len() < limit {
            let mut change = Map::new();
            change.insert("path".to_owned(), Value::String(path.clone()));
            change.insert("kind".to_owned(), Value::String(kind.to_owned()));
            if let Some(was) = before_value {
                change.insert("before".to_owned(), was.clone());
            }
            if let Some(is) = after_value {
                change.insert("after".to_owned(), is.clone());
            }
            changes.push(Value::Object(change));
        }
    }
    let total = added + removed + modified;
    json!({
        "summary": { "added": added, "removed": removed, "modified": modified, "total": total },
        "changes": changes,
        "truncated": total > changes.len() as u64,
    })
}

/// `diffDocuments(before, after)` with the default limit.
pub fn diff(before: &Value, after: &Value) -> Value {
    diff_documents(before, after, DIFF_LIMIT)
}

fn field<'a>(operation: &'a Value, name: &str) -> Option<&'a Value> {
    operation.get(name).filter(|value| truthy(value))
}

/// `String(operation[name] || '')`.
fn text_of(value: Option<&Value>) -> String {
    value.filter(|value| truthy(value)).map(value_to_string).unwrap_or_default()
}

/// `Number(value)` written as a template literal writes it.
fn number_text(value: &Value) -> String {
    number_to_string(to_number(value))
}

/// `Number(operation.slide || result.slide)` and the like: the first truthy of two, as a number.
fn first_number(first: Option<&Value>, second: Option<&Value>) -> f64 {
    first.filter(|value| truthy(value)).or(second).map_or(f64::NAN, to_number)
}

/// A JavaScript number as a condition: neither zero nor NaN.
fn is_set(number: f64) -> bool {
    number != 0.0 && !number.is_nan()
}

/// `operationDocumentPaths(format, operation, result)`: the document paths one operation touches.
pub fn operation_document_paths(format: &str, operation: &Value, result: &Value) -> Vec<String> {
    let number = |name: &str| field(operation, name).map(number_text).unwrap_or_default();
    match format {
        "docx" => {
            if field(operation, "paragraph").is_some() {
                return vec![format!("/body/p[{}]", number("paragraph"))];
            }
            if field(operation, "table").is_some() && field(operation, "row").is_some() && field(operation, "col").is_some() {
                return vec![format!("/body/tbl[{}]/row[{}]/cell[{}]", number("table"), number("row"), number("col"))];
            }
            if field(operation, "table").is_some() && field(operation, "row").is_some() {
                return vec![format!("/body/tbl[{}]/row[{}]", number("table"), number("row"))];
            }
            if field(operation, "table").is_some() {
                return vec![format!("/body/tbl[{}]", number("table"))];
            }
            if field(operation, "comment").is_some() {
                return vec![format!("/body/comment[{}]", number("comment"))];
            }
            if field(operation, "revision").is_some() {
                return vec![format!("/body/revision[{}]", number("revision"))];
            }
            vec!["/body".to_owned()]
        }
        "xlsx" => workbook_paths(operation, result),
        _ if is_tabular_format(format) => workbook_paths(operation, result),
        "pptx" => {
            let slide = first_number(operation.get("slide"), result.get("slide"));
            let shape = operation.get("shape").map_or(f64::NAN, to_number);
            if is_set(slide) && is_set(shape) {
                return vec![format!("/slide[{}]/shape[{}]", number_to_string(slide), number_to_string(shape))];
            }
            if is_set(slide) {
                return vec![format!("/slide[{}]", number_to_string(slide))];
            }
            vec!["/".to_owned()]
        }
        "pdf" => {
            let pages: Vec<&Value> = match (operation.get("pages"), field(operation, "page")) {
                (Some(Value::Array(pages)), _) => pages.iter().collect(),
                (_, Some(page)) => vec![page],
                _ => Vec::new(),
            };
            if pages.is_empty() {
                return vec!["/".to_owned()];
            }
            pages.into_iter().map(|page| format!("/page[{}]", number_text(page))).collect()
        }
        _ => vec!["/".to_owned()],
    }
}

/// The paths of a sheet operation (a workbook, a csv or a tsv).
fn workbook_paths(operation: &Value, result: &Value) -> Vec<String> {
    let sheet = {
        let named = text_of(operation.get("sheet"));
        if named.is_empty() { text_of(result.get("sheet")) } else { named }
    };
    if !sheet.is_empty() {
        if let Some(cell) = field(operation, "cell") {
            return vec![format!("/sheet[{sheet}]/cell[{}]", value_to_string(cell).to_uppercase())];
        }
        if let Some(range) = field(operation, "range") {
            return vec![format!("/sheet[{sheet}]/range[{}]", value_to_string(range).to_uppercase())];
        }
        return vec![format!("/sheet[{sheet}]")];
    }
    if let Some(name) = field(operation, "name") {
        return vec![format!("/defined-name[{}]", value_to_string(name))];
    }
    vec!["/".to_owned()]
}

/// `operationChangeKind(operation)`: `removed`, `added` or `modified`.
pub fn operation_change_kind(operation: &Value) -> &'static str {
    let op = text_of(operation.get("op"));
    if ["delete_sheet", "delete_slide", "delete_shape", "remove_paragraph", "delete_pages"].contains(&op.as_str()) {
        return "removed";
    }
    if op.starts_with("add_") || op.starts_with("append_") || op.starts_with("insert_") || op == "duplicate_slide" {
        return "added";
    }
    "modified"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_diff_lists_added_removed_and_modified_paths_in_code_unit_order() {
        let before = json!({ "path": "/", "slides": [{ "path": "/slide[1]", "title": "A", "shapes": [{ "path": "/slide[1]/shape[1]", "text": "x" }] }] });
        let after = json!({ "path": "/", "slides": [
            { "path": "/slide[1]", "title": "A", "shapes": [{ "path": "/slide[1]/shape[1]", "text": "y" }] },
            { "path": "/slide[2]", "title": "B" }
        ] });
        let diff = diff_documents(&before, &after, 500);
        assert_eq!(diff["summary"], json!({ "added": 1, "removed": 0, "modified": 1, "total": 2 }));
        assert_eq!(diff["truncated"], json!(false));
        let paths: Vec<&str> = diff["changes"].as_array().expect("changes").iter().map(|change| change["path"].as_str().expect("path")).collect();
        assert_eq!(paths, ["/slide[1]/shape[1]", "/slide[2]"]);
        assert_eq!(diff["changes"][0]["before"], json!({ "text": "x" }));
        assert!(diff["changes"][1].get("before").is_none());
        assert_eq!(diff["changes"][1]["after"], json!({ "title": "B" }));
    }

    #[test]
    fn the_root_of_a_document_without_a_path_is_slash_and_nested_values_are_not_state() {
        let before = json!({ "name": "a", "rows": [1, 2] });
        let after = json!({ "name": "b", "rows": [1, 3] });
        let diff = diff_documents(&before, &after, 500);
        assert_eq!(diff["summary"]["modified"], json!(1));
        assert_eq!(diff["changes"][0]["path"], json!("/"));
        assert_eq!(diff["changes"][0]["before"], json!({ "name": "a" }));
    }

    #[test]
    fn a_diff_stops_listing_at_the_limit_and_says_so() {
        let many =
            |text: &str| json!({ "path": "/", "items": (0..5).map(|index| json!({ "path": format!("/p[{index}]"), "text": text })).collect::<Vec<_>>() });
        let diff = diff_documents(&many("a"), &many("b"), 3);
        assert_eq!(diff["summary"]["total"], json!(5));
        assert_eq!(diff["changes"].as_array().expect("changes").len(), 3);
        assert_eq!(diff["truncated"], json!(true));
    }

    #[test]
    fn an_operation_names_the_paths_it_touches_by_format() {
        let paths = |format: &str, operation: Value| operation_document_paths(format, &operation, &json!({}));
        assert_eq!(paths("docx", json!({ "paragraph": 3 })), ["/body/p[3]"]);
        assert_eq!(paths("docx", json!({ "table": 1, "row": 2, "col": 3 })), ["/body/tbl[1]/row[2]/cell[3]"]);
        assert_eq!(paths("docx", json!({ "table": 1, "row": 2 })), ["/body/tbl[1]/row[2]"]);
        assert_eq!(paths("docx", json!({ "op": "set_page" })), ["/body"]);
        assert_eq!(paths("xlsx", json!({ "sheet": "Data", "cell": "b2" })), ["/sheet[Data]/cell[B2]"]);
        assert_eq!(paths("csv", json!({ "sheet": "Data", "range": "a1:b2" })), ["/sheet[Data]/range[A1:B2]"]);
        assert_eq!(paths("xlsx", json!({ "name": "Rate" })), ["/defined-name[Rate]"]);
        assert_eq!(operation_document_paths("xlsx", &json!({}), &json!({ "sheet": "S" })), ["/sheet[S]"]);
        assert_eq!(paths("pptx", json!({ "slide": 2, "shape": 1 })), ["/slide[2]/shape[1]"]);
        assert_eq!(operation_document_paths("pptx", &json!({}), &json!({ "slide": 4 })), ["/slide[4]"]);
        assert_eq!(paths("pdf", json!({ "pages": [1, 3] })), ["/page[1]", "/page[3]"]);
        assert_eq!(paths("pdf", json!({ "page": 2 })), ["/page[2]"]);
        assert_eq!(paths("pdf", json!({})), ["/"]);
    }

    #[test]
    fn an_operation_is_classified_by_its_name() {
        let kind = |op: &str| operation_change_kind(&json!({ "op": op }));
        assert_eq!(kind("delete_slide"), "removed");
        assert_eq!(kind("add_table"), "added");
        assert_eq!(kind("append_text"), "added");
        assert_eq!(kind("duplicate_slide"), "added");
        assert_eq!(kind("set_cell"), "modified");
        assert_eq!(operation_change_kind(&json!({})), "modified");
    }

    #[test]
    fn the_fingerprint_does_not_depend_on_key_order() {
        assert_eq!(document_snapshot_fingerprint(&json!({ "a": 1, "b": [2] })), document_snapshot_fingerprint(&json!({ "b": [2], "a": 1 })));
    }
}
