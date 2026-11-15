//! The Excel digest: what a sheet entry says when it has nothing to report, a cell's style as what differs from the
//! workbook's own, and formula lineage as the cell and the cells it reads.

use mixdog_js::value_to_string;
use mixdog_office_base::values::truthy;
use serde_json::Value;

use super::common::{Object, entries, filtered, is_bool, is_number, is_str, remove, strict_equals};

/// A visible sheet says nothing.
fn quiet_sheet_entry(key: &str, value: &Value) -> bool {
    key == "visibility" && is_str(Some(value), "visible")
}

/// A page setup nobody set: no orientation, 100 % zoom, no fit-to-page.
fn quiet_page_setup_entry(key: &str, value: &Value) -> bool {
    match key {
        "orientation" => is_str(Some(value), ""),
        "zoom" => is_number(Some(value), 100.0),
        "fitToPage" => is_bool(Some(value), false),
        "fitToPagesWide" | "fitToPagesTall" => is_number(Some(value), 0.0),
        _ => false,
    }
}

/// The plain state of a cell style, not bold, not italic, not underlined, General.
fn plain_cell_style_entry(key: &str, value: &Value) -> bool {
    match key {
        "bold" | "italic" | "underline" => is_bool(Some(value), false),
        "numberFormat" => is_str(Some(value), "General"),
        _ => false,
    }
}

/// `/\/cell\[([^\]]+)\]$/.exec(text)?.[1]`: the reference inside the last `/cell[...]` that ends the path.
fn cell_of_path(text: &str) -> Option<&str> {
    let body = text.strip_suffix(']')?;
    body.match_indices("/cell[").map(|(at, marker)| &body[at + marker.len()..]).find(|rest| !rest.is_empty() && !rest.contains(']'))
}

fn lineage_entry(entry: &Value, sheet_name: Option<&Value>) -> Value {
    let from = entry.get("from");
    let text = match from {
        Some(from) if truthy(from) => value_to_string(from),
        _ => String::new(),
    };
    let precedents = match entry.get("precedents") {
        Some(Value::Array(items)) => items.iter().map(|precedent| precedent_of(precedent, sheet_name)).collect(),
        _ => Vec::new(),
    };
    let mut digest = Object::new();
    match cell_of_path(&text) {
        Some(cell) => {
            digest.insert("cell".to_owned(), Value::from(cell));
        }
        None => {
            if let Some(from) = from {
                digest.insert("cell".to_owned(), from.clone());
            }
        }
    }
    digest.insert("precedents".to_owned(), Value::Array(precedents));
    Value::Object(digest)
}

/// A precedent on another sheet names it; one on this sheet is its reference alone.
fn precedent_of(precedent: &Value, sheet_name: Option<&Value>) -> Value {
    let sheet = precedent.get("sheet");
    if let Some(sheet) = sheet.filter(|sheet| truthy(sheet) && !strict_equals(Some(*sheet), sheet_name)) {
        let reference = precedent.get("ref").map_or_else(|| "undefined".to_owned(), value_to_string);
        return Value::from(format!("{}!{reference}", value_to_string(sheet)));
    }
    match precedent.get("ref") {
        Some(reference) if !reference.is_null() => reference.clone(),
        _ => precedent.clone(),
    }
}

/// A cell's style names what differs from the workbook's own: the default face and size, and the plain state say
/// nothing a reader can use.
fn cell_digest(cell: &Value, defaults: Option<&Object>) -> Value {
    let Value::Object(map) = cell else { return cell.clone() };
    let mut digest = Object::new();
    for (key, value) in entries(map) {
        if key != "formula" && key != "style" {
            digest.insert(key.clone(), value.clone());
        }
    }
    if let Some(formula) = map.get("formula") {
        if !formula.is_null() && !is_str(Some(formula), "") {
            digest.insert("formula".to_owned(), formula.clone());
        }
    }
    if let Some(Value::Object(style)) = map.get("style") {
        let kept = filtered(style, |key, entry| {
            let default = defaults.and_then(|defaults| defaults.get(key));
            !default.is_some_and(|default| value_to_string(default) == value_to_string(entry)) && !plain_cell_style_entry(key, entry)
        });
        if !kept.is_empty() {
            digest.insert("style".to_owned(), Value::Object(kept));
        }
    }
    Value::Object(digest)
}

fn sheet_digest(sheet: &Value, defaults: Option<&Object>) -> Value {
    let Value::Object(map) = sheet else { return sheet.clone() };
    let mut digest = Object::new();
    for (key, entry) in entries(map) {
        let empty = entry.is_null() || matches!(entry, Value::Array(items) if items.is_empty());
        if empty || (key.ends_with("Count") && key != "cellCount" && is_number(Some(entry), 0.0)) || quiet_sheet_entry(key, entry) {
            continue;
        }
        digest.insert(key.clone(), entry.clone());
    }
    if let Some(Value::Object(protection)) = digest.get("protection") {
        if !protection.values().any(truthy) {
            remove(&mut digest, "protection");
        }
    }
    if digest.get("freezePanes").is_some_and(|panes| is_bool(panes.get("frozen"), false)) {
        remove(&mut digest, "freezePanes");
    }
    if let Some(Value::Object(setup)) = digest.get("pageSetup") {
        let setup = filtered(setup, |key, entry| {
            !is_str(Some(entry), "") && !is_bool(Some(entry), false) && !quiet_page_setup_entry(key, entry)
        });
        if setup.is_empty() {
            remove(&mut digest, "pageSetup");
        } else {
            digest.insert("pageSetup".to_owned(), Value::Object(setup));
        }
    }
    if let Some(Value::Array(cells)) = digest.get("cells") {
        let cells = cells.iter().map(|cell| cell_digest(cell, defaults)).collect();
        digest.insert("cells".to_owned(), Value::Array(cells));
    }
    // Lineage repeated each formula and every precedent's path beside the cell that already holds the formula: a model
    // reads the dependency as the cell and the cells it reads.
    if let Some(Value::Array(lineage)) = digest.get("formulaLineage") {
        let name = map.get("name");
        let lineage = lineage.iter().map(|entry| lineage_entry(entry, name)).collect();
        digest.insert("formulaLineage".to_owned(), Value::Array(lineage));
        remove(&mut digest, "lineageCount");
    }
    Value::Object(digest)
}

/// The workbook a model reads. A workbook with no defined names and no calculation settings said so as `definedNames:[]`,
/// `definedNameCount:0` and an all-empty `calculation`; absent reads the same.
pub fn xlsx_document_digest(document: &Value) -> Value {
    let Value::Object(map) = document else { return document.clone() };
    if !is_str(map.get("format"), "xlsx") {
        return document.clone();
    }
    let Some(Value::Array(sheets)) = map.get("sheets") else { return document.clone() };
    let defaults = map.get("defaultStyle").and_then(Value::as_object);
    let mut digest = map.clone();
    digest.insert("sheets".to_owned(), Value::Array(sheets.iter().map(|sheet| sheet_digest(sheet, defaults)).collect()));
    if matches!(digest.get("definedNames"), Some(Value::Array(names)) if names.is_empty()) {
        remove(&mut digest, "definedNames");
        if is_number(digest.get("definedNameCount"), 0.0) {
            remove(&mut digest, "definedNameCount");
        }
    }
    if matches!(digest.get("calculation"), Some(Value::Object(settings)) if settings.values().all(|value| !truthy(value))) {
        remove(&mut digest, "calculation");
    }
    Value::Object(digest)
}
