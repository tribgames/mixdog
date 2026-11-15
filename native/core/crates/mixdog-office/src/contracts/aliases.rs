//! The rewrites the contract performs on the caller's behalf, in place on the operation object: field aliases, the
//! freeze-pane cell, an author's initials, a single cell named as a range, a table inside `compose_sheet`, and
//! geometry written under `properties`. Later stages (the writers, the backends) read the rewritten operation, so
//! these are mutations of the object and not a copy.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, js_words, json_number, value_to_string};
use mixdog_office_base::a1::column_number;
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value};

use super::describe_hint;
use crate::capabilities::{Signature, capabilities};

/// One cell, optionally sheet-qualified and absolute: `Sheet1!$B$4`, `'운영 자료'!C12`, `D5`.
static SINGLE_CELL_REFERENCE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:(?:'[^']+'|[^'!]+)!)?\$?[A-Za-z]{1,3}\$?\d{1,7}$", ""));
static FREEZE_CELL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\$?([A-Za-z]{1,3})\$?(\d{1,7})$", ""));
static COLUMN_LETTERS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[A-Za-z]{1,3}$", ""));

/// `String(value || '')`.
pub(super) fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        Some(inner) if truthy(inner) => value_to_string(inner),
        _ => String::new(),
    }
}

/// `FIELD_ALIASES[format][name]`: a caller names a field with the word the snapshot uses for it; where the reading and
/// writing names differ for the same thing, the operation takes both rather than charging a round trip for the
/// spelling.
pub(super) fn apply_field_aliases(format: &str, name: &str, operation: &mut Map<String, Value>) {
    let Some(aliases) = capabilities().field_aliases(format, name) else { return };
    for (alias, field) in aliases {
        if operation.contains_key(alias) && !operation.contains_key(field)
            && let Some(value) = operation.shift_remove(alias)
        {
            operation.insert(field.clone(), value);
        }
    }
}

/// `hoistFreezePaneCell`: `freeze_panes` counts rows and columns, while every other worksheet operation names a cell or
/// a column letter. Excel freezes at the selected cell, so `cell: 'B2'` is `row: 2, column: 2`, and a column letter is
/// its 1-based number.
pub(super) fn hoist_freeze_pane_cell(format: &str, name: &str, operation: &mut Map<String, Value>) {
    if format != "xlsx" || name != "freeze_panes" {
        return;
    }
    let cell = operation.get("cell").and_then(Value::as_str).and_then(|text| {
        let caps = FREEZE_CELL.captures(js_trim(text))?;
        Some((caps.get(1)?.to_owned(), caps.get(2)?.to_owned()))
    });
    if let Some((letters, digits)) = cell
        && !operation.contains_key("row")
        && !operation.contains_key("column")
    {
        operation.insert("column".to_owned(), json_number(column_number(&letters)));
        operation.insert("row".to_owned(), json_number(digits.parse::<f64>().unwrap_or(f64::NAN)));
        operation.shift_remove("cell");
    }
    let letters = match operation.get("column") {
        Some(Value::String(text)) if COLUMN_LETTERS.is_match(js_trim(text)) => Some(js_trim(text).to_owned()),
        _ => None,
    };
    if let Some(letters) = letters {
        operation.insert("column".to_owned(), json_number(column_number(&letters)));
    }
}

/// `authorInitials`: a comment written for a named author carries that author's initials, the mark Word and
/// PowerPoint draw beside it. A Hangul name takes its first syllable, as Korean Office does; a Latin one the first
/// letter of up to three words.
pub(super) fn author_initials(name: &str, operation: &mut Map<String, Value>) {
    if !matches!(name, "add_comment" | "add_comment_reply") || operation.contains_key("initials") {
        return;
    }
    let author = js_trim(&text_or_empty(operation.get("author"))).to_owned();
    if author.is_empty() {
        return;
    }
    let first_of = |word: &str| word.chars().next().map(String::from).unwrap_or_default();
    let initials = if author.chars().next().is_some_and(|letter| ('\u{ac00}'..='\u{d7af}').contains(&letter)) {
        js_words(&author).next().map(first_of).unwrap_or_default()
    } else {
        js_words(&author).take(3).map(|word| first_of(word).to_uppercase()).collect::<String>()
    };
    operation.insert("initials".to_owned(), Value::String(initials));
}

/// `singleCellRangeFault`: every other worksheet operation takes `range`, so a caller naming one cell that way is not
/// making a mistake worth a round trip, while a real range handed to a single-cell operation is one, and says which
/// operation writes it.
pub(super) fn single_cell_range_fault(
    format: &str,
    backend: &str,
    name: &str,
    operation: &mut Map<String, Value>,
    index: usize,
    allowed: &[String],
) -> Option<String> {
    // set_formula takes a range to fill; one cell named that way is still the cell it is.
    if format == "xlsx" && name == "set_formula" && !operation.contains_key("cell") {
        let range = match operation.get("range") {
            None | Some(Value::Null) => String::new(),
            Some(value) => value_to_string(value),
        };
        if SINGLE_CELL_REFERENCE.is_match(js_trim(&range))
            && let Some(value) = operation.shift_remove("range")
        {
            operation.insert("cell".to_owned(), value);
        }
        return None;
    }
    let has = |field: &str| allowed.iter().any(|entry| entry == field);
    if format != "xlsx" || !has("cell") || has("range") {
        return None;
    }
    if !operation.contains_key("range") || operation.contains_key("cell") {
        return None;
    }
    let range = operation.get("range").map(value_to_string).unwrap_or_default();
    if SINGLE_CELL_REFERENCE.is_match(js_trim(&range)) {
        if let Some(value) = operation.shift_remove("range") {
            operation.insert("cell".to_owned(), value);
        }
        return None;
    }
    Some(format!(
        "XLSX operation \"{name}\" at operation {} writes one cell: pass cell instead of range. For {range} use set_range (values) or set_style (formatting). {}",
        index + 1,
        describe_hint(format, backend, name)
    ))
}

/// `allowedOperationFields`: the fields an operation takes, in the order the message lists them. A stable-target
/// backend takes `slideId` and `shapeId` where the signature takes `slide` and `shape`.
pub(super) fn allowed_operation_fields(signature: &Signature, stable_targets: bool) -> Vec<String> {
    let mut allowed: Vec<String> = Vec::new();
    let named = ["op", "allowNoChange"].map(str::to_owned);
    for field in named
        .iter()
        .chain(&signature.required)
        .chain(&signature.optional)
        .chain(signature.one_of.iter().flatten())
    {
        if !allowed.contains(field) {
            allowed.push(field.clone());
        }
    }
    if stable_targets {
        for (field, stable) in [("slide", "slideId"), ("shape", "shapeId")] {
            if allowed.iter().any(|entry| entry == field) && !allowed.iter().any(|entry| entry == stable) {
                allowed.push(stable.to_owned());
            }
        }
    }
    allowed
}

/// `hoistComposeSheetTable`: a table is a table. `compose_document` takes one as `{ headers, rows }` and
/// `compose_sheet` takes those two at the top level; the caller who writes the document's shape here is writing a
/// sheet with a table in it, not a mistake.
pub(super) fn hoist_compose_sheet_table(format: &str, name: &str, operation: &mut Map<String, Value>) {
    if format != "xlsx" || name != "compose_sheet" {
        return;
    }
    let Some(Value::Object(table)) = operation.get("table") else { return };
    if operation.contains_key("headers") || operation.contains_key("rows") {
        return;
    }
    let headers = table.get("headers").filter(|value| value.is_array()).cloned();
    let rows = table.get("rows").filter(|value| value.is_array()).cloned();
    if headers.is_none() && rows.is_none() {
        return;
    }
    if let Some(headers) = headers {
        operation.insert("headers".to_owned(), headers);
    }
    if let Some(rows) = rows {
        operation.insert("rows".to_owned(), rows);
    }
    operation.shift_remove("table");
}

/// `hoistGeometryProperties`: geometry sits in `properties` for `add_shape` and at the top level for `add_image` in
/// the same format, our own inconsistency, so a caller who wrote the fields in the neighbouring operation's place is
/// taken at their word instead of paying a round trip to move them.
pub(super) fn hoist_geometry_properties(signature: &Signature, operation: &mut Map<String, Value>, allowed: &[String]) {
    if !signature.property_sets.is_empty() {
        return;
    }
    let Some(Value::Object(properties)) = operation.get("properties") else { return };
    if !properties.keys().all(|field| allowed.contains(field) && !operation.contains_key(field)) {
        return;
    }
    let properties = properties.clone();
    operation.shift_remove("properties");
    for (field, value) in properties {
        operation.insert(field, value);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn object(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            other => panic!("not an object: {other}"),
        }
    }

    fn text(map: &Map<String, Value>) -> String {
        mixdog_js::json_stringify(&Value::Object(map.clone()))
    }

    #[test]
    fn a_field_alias_reaches_its_field_only_when_that_is_unset() {
        let mut operation = object(json!({ "op": "set_formula", "cell": "B5", "value": "=SUM(B2:B4)" }));
        apply_field_aliases("xlsx", "set_formula", &mut operation);
        assert_eq!(text(&operation), r#"{"op":"set_formula","cell":"B5","formula":"=SUM(B2:B4)"}"#);
        let mut both = object(json!({ "op": "set_formula", "value": "a", "formula": "b" }));
        apply_field_aliases("xlsx", "set_formula", &mut both);
        assert_eq!(text(&both), r#"{"op":"set_formula","value":"a","formula":"b"}"#);
    }

    #[test]
    fn freeze_panes_takes_a_cell_or_a_column_letter() {
        let mut cell = object(json!({ "op": "freeze_panes", "cell": "$C3" }));
        hoist_freeze_pane_cell("xlsx", "freeze_panes", &mut cell);
        assert_eq!(text(&cell), r#"{"op":"freeze_panes","column":3,"row":3}"#);
        let mut letter = object(json!({ "op": "freeze_panes", "row": 2, "column": "C" }));
        hoist_freeze_pane_cell("xlsx", "freeze_panes", &mut letter);
        assert_eq!(text(&letter), r#"{"op":"freeze_panes","row":2,"column":3}"#);
        let mut named = object(json!({ "op": "freeze_panes", "cell": "B2", "row": 4 }));
        hoist_freeze_pane_cell("xlsx", "freeze_panes", &mut named);
        assert_eq!(text(&named), r#"{"op":"freeze_panes","cell":"B2","row":4}"#);
    }

    #[test]
    fn initials_follow_the_script_of_the_author() {
        let initials = |author: Value| {
            let mut comment = object(json!({ "op": "add_comment", "author": author }));
            author_initials("add_comment", &mut comment);
            comment.get("initials").cloned()
        };
        assert_eq!(initials(json!("검토자")), Some(json!("검")));
        assert_eq!(initials(json!("Jane van Doe")), Some(json!("JVD")));
        assert_eq!(initials(json!("a b c d")), Some(json!("ABC")));
        assert_eq!(initials(json!("  ")), None);
        let mut kept = object(json!({ "author": "검토자", "initials": "QA" }));
        author_initials("add_comment", &mut kept);
        assert_eq!(kept["initials"], "QA");
    }

    #[test]
    fn one_cell_named_as_a_range_becomes_the_cell() {
        let allowed = ["op", "cell", "value"].map(str::to_owned).to_vec();
        let mut operation = object(json!({ "op": "set_cell", "range": "'운영 자료'!D5", "value": 620 }));
        assert_eq!(single_cell_range_fault("xlsx", "mixdog-ooxml", "set_cell", &mut operation, 0, &allowed), None);
        assert_eq!(text(&operation), r#"{"op":"set_cell","value":620,"cell":"'운영 자료'!D5"}"#);
        let mut wide = object(json!({ "op": "set_cell", "range": "B2:E2", "value": 4 }));
        let fault = single_cell_range_fault("xlsx", "mixdog-ooxml", "set_cell", &mut wide, 2, &allowed).expect("fault");
        assert!(fault.starts_with("XLSX operation \"set_cell\" at operation 3 writes one cell: pass cell instead of range. For B2:E2 use set_range"));
        assert!(fault.ends_with(r#"Call office with {"action":"describe","format":"xlsx","backend":"mixdog-ooxml","operation":"set_cell"}."#));
    }

    #[test]
    fn a_table_in_compose_sheet_is_hoisted() {
        let mut operation = object(json!({ "op": "compose_sheet", "table": { "headers": ["a"], "rows": [[1]] } }));
        hoist_compose_sheet_table("xlsx", "compose_sheet", &mut operation);
        assert_eq!(text(&operation), r#"{"op":"compose_sheet","headers":["a"],"rows":[[1]]}"#);
        let mut other = object(json!({ "op": "compose_sheet", "table": { "x": 1 } }));
        hoist_compose_sheet_table("xlsx", "compose_sheet", &mut other);
        assert!(other.contains_key("table"));
    }

    #[test]
    fn geometry_under_properties_moves_up_when_the_operation_has_no_property_sets() {
        let signature = Signature { optional: vec!["left".to_owned(), "top".to_owned()], ..Signature::default() };
        let allowed = allowed_operation_fields(&signature, false);
        let mut operation = object(json!({ "op": "add_image", "properties": { "left": 1, "top": 2 } }));
        hoist_geometry_properties(&signature, &mut operation, &allowed);
        assert_eq!(text(&operation), r#"{"op":"add_image","left":1,"top":2}"#);
        let mut blocked = object(json!({ "op": "add_image", "left": 9, "properties": { "left": 1 } }));
        hoist_geometry_properties(&signature, &mut blocked, &allowed);
        assert!(blocked.contains_key("properties"));
    }

    #[test]
    fn stable_targets_add_the_id_spellings_after_the_signature() {
        let signature = Signature { required: vec!["slide".to_owned()], optional: vec!["text".to_owned()], ..Signature::default() };
        assert_eq!(allowed_operation_fields(&signature, false), ["op", "allowNoChange", "slide", "text"]);
        assert_eq!(allowed_operation_fields(&signature, true), ["op", "allowNoChange", "slide", "text", "slideId"]);
    }
}
