//! What a snapshot call asks for and how a page answers with its way on (`core/pagination.mjs`): the per-format default
//! and maximum page sizes, the request a call (or the cursor it brings) makes, and the cursors a page hands back.
//!
//! A request is the plain object the readers take (`paged`, `offset`, `sheetOffset`, `limit`, the selector), kept as a
//! JSON map in Node's key order: the order is part of the key a cached snapshot is stored under.

use mixdog_js::{json_number, json_stringify, to_number, to_number_of, value_to_string};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value};

use super::cursor::{decode_cursor, encode_cursor};

/// A snapshot request (`createOfficeSnapshotRequest`'s answer).
pub type Request = Map<String, Value>;

/// The session facts a cursor is bound to.
#[derive(Clone, Copy, Debug)]
pub struct Position<'a> {
    pub id: &'a str,
    pub format: &'a str,
    /// `session.snapshotVersion || 0`.
    pub snapshot_version: u64,
}

/// `DEFAULT_LIMITS[format] || 200`.
fn default_limit(format: &str) -> f64 {
    match format {
        "docx" => 200.0,
        "xlsx" | "csv" | "tsv" => 2_000.0,
        "pptx" | "pdf" => 20.0,
        _ => 200.0,
    }
}

/// `MAX_LIMITS[format] || 2000`.
fn maximum_limit(format: &str) -> f64 {
    match format {
        "docx" => 2_000.0,
        "xlsx" | "csv" | "tsv" => 10_000.0,
        "pptx" | "pdf" => 100.0,
        _ => 2_000.0,
    }
}

/// `x || fallback` over a number: NaN and zero fall back.
fn or_number(value: f64, fallback: f64) -> f64 {
    if value.is_nan() || value == 0.0 { fallback } else { value }
}

/// `String(value || '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        Some(value) if truthy(value) => value_to_string(value),
        _ => String::new(),
    }
}

/// `normalizedPages(value)`: the positive whole page numbers of a list, each once, in order.
fn normalized_pages(value: Option<&Value>) -> Vec<f64> {
    let Some(Value::Array(items)) = value else { return Vec::new() };
    let mut pages: Vec<f64> = Vec::new();
    for item in items {
        let page = to_number(item);
        if page.is_finite() && page.fract() == 0.0 && page > 0.0 && !pages.contains(&page) {
            pages.push(page);
        }
    }
    pages
}

/// `selectorFromArgs(args)`: what a call selects, as the cursor carries it.
pub fn selector_from_args(args: &Value) -> Map<String, Value> {
    let mut selector = Map::new();
    selector.insert("sheet".to_owned(), Value::String(text_or_empty(args.get("sheet"))));
    selector.insert("range".to_owned(), Value::String(text_or_empty(args.get("range"))));
    selector.insert("target".to_owned(), Value::String(text_or_empty(args.get("target"))));
    selector.insert("pages".to_owned(), Value::Array(normalized_pages(args.get("pages")).into_iter().map(json_number).collect()));
    selector.insert("includeStyles".to_owned(), Value::Bool(args.get("includeStyles") == Some(&Value::Bool(true))));
    selector.insert("includeSelection".to_owned(), Value::Bool(args.get("includeSelection") == Some(&Value::Bool(true))));
    selector
}

/// `left.key === right.key` where `left` is a selector this module built (its text is always a string).
fn same_text(left: &Map<String, Value>, right: &Value, key: &str) -> bool {
    matches!((left.get(key), right.get(key)), (Some(Value::String(a)), Some(Value::String(b))) if a == b)
}

/// `sameSelector(left, right)`. `right` is the selector a cursor carried.
fn same_selector(left: &Map<String, Value>, right: &Value) -> bool {
    let same_flag = |key: &str| matches!((left.get(key), right.get(key)), (Some(Value::Bool(a)), Some(Value::Bool(b))) if a == b);
    same_text(left, right, "sheet")
        && same_text(left, right, "range")
        && same_text(left, right, "target")
        && same_flag("includeStyles")
        && same_flag("includeSelection")
        && right.get("pages").is_some_and(|pages| json_stringify(pages) == json_stringify(&left["pages"]))
}

fn has_supplied_selector(supplied: &Map<String, Value>) -> bool {
    let text = |key: &str| supplied.get(key).and_then(Value::as_str).is_some_and(|text| !text.is_empty());
    let flag = |key: &str| supplied.get(key) == Some(&Value::Bool(true));
    text("sheet")
        || text("range")
        || text("target")
        || supplied.get("pages").and_then(Value::as_array).is_some_and(|pages| !pages.is_empty())
        || flag("includeStyles")
        || flag("includeSelection")
}

/// `{ ...value }`: an object's own fields; a text or a list (a tampered cursor can carry either as its selector) spreads
/// its units or items under their indices; anything else spreads nothing.
fn spread(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(fields) => fields.clone(),
        Value::String(text) => text.encode_utf16().enumerate().map(|(at, unit)| (at.to_string(), Value::String(String::from_utf16_lossy(&[unit])))).collect(),
        Value::Array(items) => items.iter().enumerate().map(|(at, item)| (at.to_string(), item.clone())).collect(),
        _ => Map::new(),
    }
}

/// `createOfficeSnapshotRequest(session, args, { full })`: the request of a call. A `full` read asks for the whole
/// document. A cursor continues the walk it came from and is refused for another session, after any edit, or when the
/// call names a different selector.
pub fn create_office_snapshot_request(position: Position<'_>, args: &Value, full: bool) -> Result<Request, String> {
    let mut request = Request::new();
    if full {
        request.insert("full".to_owned(), Value::Bool(true));
        return Ok(request);
    }
    let format = position.format;
    let default = default_limit(format);
    let format_maximum = maximum_limit(format);
    let mut selector = Value::Object(selector_from_args(args));
    let mut offset = 0.0;
    let mut sheet_offset = 0.0;
    let mut limit = or_number(to_number_of(args.get("limit")), default).max(1.0);
    if let Some(supplied) = args.get("cursor").filter(|cursor| truthy(cursor)) {
        let cursor = decode_cursor(&value_to_string(supplied))?;
        let same_session = cursor.get("session").and_then(Value::as_str) == Some(position.id) && cursor.get("format").and_then(Value::as_str) == Some(format);
        if !same_session {
            return Err("Office snapshot cursor belongs to a different document session".to_owned());
        }
        // `Number(undefined)` is NaN, which equals no revision.
        if to_number_of(cursor.get("revision")) != position.snapshot_version as f64 {
            return Err("Office snapshot cursor is stale because the document changed".to_owned());
        }
        let supplied_selector = selector_from_args(args);
        let carried = match cursor.get("selector").filter(|carried| truthy(carried)) {
            Some(carried) => carried.clone(),
            None => Value::Object(selector_from_args(&Value::Null)),
        };
        if has_supplied_selector(&supplied_selector) && !same_selector(&supplied_selector, &carried) {
            return Err("Office snapshot cursor selector does not match this request".to_owned());
        }
        selector = carried;
        offset = or_number(to_number_of(cursor.get("offset")), 0.0);
        sheet_offset = or_number(to_number_of(cursor.get("sheetOffset")), 0.0).max(0.0);
        let from_args = to_number_of(args.get("limit"));
        let from_cursor = to_number_of(cursor.get("limit"));
        limit = or_number(from_args, or_number(from_cursor, default)).max(1.0);
    }
    let styled = selector.get("includeStyles").is_some_and(truthy);
    let maximum = if format == "xlsx" && styled { 500.0 } else { format_maximum };
    limit = limit.min(maximum);
    request.insert("paged".to_owned(), Value::Bool(true));
    request.insert("offset".to_owned(), json_number(offset));
    // Which worksheet the walk is on when the caller named none: a workbook is read sheet by sheet, and the next page
    // continues into the next sheet.
    request.insert("sheetOffset".to_owned(), json_number(sheet_offset));
    request.insert("limit".to_owned(), json_number(limit));
    for (key, value) in spread(&selector) {
        request.insert(key, value);
    }
    Ok(request)
}

/// `Number.isInteger(value)` of a JSON value that is a number.
fn whole_number(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    (number.is_finite() && number.fract() == 0.0).then_some(number)
}

/// `finalizeOfficeSnapshotPage(document, session, request)`: the page's own `nextOffset` and `nextSheetOffset` become the
/// cursor of this page, the cursor of the next one and `hasMore`. A workbook's next page may be the next sheet: the cells
/// of this one are done, but the caller has not seen the workbook yet.
pub fn finalize_office_snapshot_page(document: &mut Value, position: Position<'_>, request: &Request) {
    let Some(pagination) = document.get_mut("pagination").and_then(Value::as_object_mut) else { return };
    if request.get("full").is_some_and(truthy) {
        return;
    }
    let next_sheet_offset = whole_number(pagination.get("nextSheetOffset"));
    let next_offset = to_number_of(pagination.get("nextOffset"));
    let offset_present = !matches!(pagination.get("nextOffset"), None | Some(Value::Null));
    let has_more = (offset_present && next_offset.is_finite() && next_offset.fract() == 0.0 && next_offset >= 0.0) || next_sheet_offset.is_some();
    let selector = Value::Object(selector_from_args(&Value::Object(request.clone())));
    let limit = request.get("limit").cloned().unwrap_or(Value::Null);
    let cursor_for = |offset: f64, sheet_offset: f64| {
        let mut cursor = Map::new();
        cursor.insert("version".to_owned(), Value::from(1));
        cursor.insert("session".to_owned(), Value::String(position.id.to_owned()));
        cursor.insert("format".to_owned(), Value::String(position.format.to_owned()));
        cursor.insert("revision".to_owned(), Value::from(position.snapshot_version));
        cursor.insert("offset".to_owned(), json_number(offset));
        if sheet_offset != 0.0 && !sheet_offset.is_nan() {
            cursor.insert("sheetOffset".to_owned(), json_number(sheet_offset));
        }
        cursor.insert("limit".to_owned(), limit.clone());
        cursor.insert("selector".to_owned(), selector.clone());
        Value::String(encode_cursor(&Value::Object(cursor)))
    };
    let request_offset = to_number_of(request.get("offset"));
    let request_sheet_offset = to_number_of(request.get("sheetOffset"));
    // `request.sheetOffset || 0`.
    let sheet_here = or_number(request_sheet_offset, 0.0);
    let cursor = if request_offset > 0.0 || request_sheet_offset > 0.0 { cursor_for(request_offset, sheet_here) } else { Value::Null };
    pagination.insert("cursor".to_owned(), cursor);
    pagination.insert("nextCursor".to_owned(), Value::Null);
    if has_more {
        let next = match next_sheet_offset {
            Some(sheet) => cursor_for(0.0, sheet),
            None => cursor_for(next_offset, sheet_here),
        };
        pagination.insert("nextCursor".to_owned(), next);
    }
    pagination.insert("hasMore".to_owned(), Value::Bool(has_more));
    pagination.shift_remove("nextOffset");
    pagination.shift_remove("nextSheetOffset");
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn position(format: &str) -> Position<'_> {
        Position { id: "office_1", format, snapshot_version: 0 }
    }

    fn cursor_of(document: &Value, key: &str) -> Value {
        decode_cursor(document["pagination"][key].as_str().expect("a cursor")).expect("a readable cursor")
    }

    // Port of `styled XLSX cursors keep their selector and cap detailed pages at 500 cells`.
    #[test]
    fn styled_xlsx_cursors_keep_their_selector_and_cap_detailed_pages_at_500_cells() {
        let request = create_office_snapshot_request(position("xlsx"), &json!({ "includeStyles": true, "includeSelection": true, "limit": 10_000 }), false).expect("request");
        assert_eq!(request["limit"], json!(500));
        assert_eq!(request["includeSelection"], json!(true));
        let mut document = json!({ "pagination": { "nextOffset": 500 } });
        finalize_office_snapshot_page(&mut document, position("xlsx"), &request);
        let next = document["pagination"]["nextCursor"].clone();
        let continued = create_office_snapshot_request(position("xlsx"), &json!({ "cursor": next }), false).expect("continued");
        assert_eq!(continued["limit"], json!(500));
        assert_eq!(continued["includeStyles"], json!(true));
        assert_eq!(continued["includeSelection"], json!(true));
        assert_eq!(continued["offset"], json!(500));
    }

    #[test]
    fn page_sizes_default_and_cap_per_format() {
        for (format, default, maximum) in
            [("docx", 200, 2_000), ("xlsx", 2_000, 10_000), ("pptx", 20, 100), ("csv", 2_000, 10_000), ("tsv", 2_000, 10_000), ("pdf", 20, 100), ("odt", 200, 2_000)]
        {
            let plain = create_office_snapshot_request(position(format), &json!({}), false).expect("request");
            assert_eq!(plain["limit"], json!(default), "{format}");
            let capped = create_office_snapshot_request(position(format), &json!({ "limit": 1_000_000 }), false).expect("request");
            assert_eq!(capped["limit"], json!(maximum), "{format}");
        }
        let floor = create_office_snapshot_request(position("docx"), &json!({ "limit": -5 }), false).expect("request");
        assert_eq!(floor["limit"], json!(1));
        let full = create_office_snapshot_request(position("docx"), &json!({}), true).expect("full");
        assert_eq!(Value::Object(full), json!({ "full": true }));
    }

    #[test]
    fn a_request_keeps_the_key_order_the_cache_key_is_taken_over() {
        let request = create_office_snapshot_request(position("pptx"), &json!({ "pages": ["2", 2, 3, 0, 1.5, "x"], "sheet": 7 }), false).expect("request");
        assert_eq!(
            json_stringify(&Value::Object(request)),
            r#"{"paged":true,"offset":0,"sheetOffset":0,"limit":20,"sheet":"7","range":"","target":"","pages":[2,3],"includeStyles":false,"includeSelection":false}"#
        );
    }

    #[test]
    fn a_cursor_is_refused_for_another_session_a_stale_revision_or_a_changed_selector() {
        let request = create_office_snapshot_request(position("xlsx"), &json!({ "sheet": "Data", "limit": 50 }), false).expect("request");
        let mut document = json!({ "pagination": { "nextOffset": 50 } });
        finalize_office_snapshot_page(&mut document, position("xlsx"), &request);
        let cursor = document["pagination"]["nextCursor"].clone();
        let foreign = "Office snapshot cursor belongs to a different document session".to_owned();
        let other = Position { id: "office_2", format: "xlsx", snapshot_version: 0 };
        assert_eq!(create_office_snapshot_request(other, &json!({ "cursor": cursor }), false), Err(foreign.clone()));
        assert_eq!(create_office_snapshot_request(position("docx"), &json!({ "cursor": cursor }), false), Err(foreign));
        let edited = Position { id: "office_1", format: "xlsx", snapshot_version: 1 };
        assert_eq!(
            create_office_snapshot_request(edited, &json!({ "cursor": cursor }), false),
            Err("Office snapshot cursor is stale because the document changed".to_owned())
        );
        assert_eq!(
            create_office_snapshot_request(position("xlsx"), &json!({ "cursor": cursor, "sheet": "Other" }), false),
            Err("Office snapshot cursor selector does not match this request".to_owned())
        );
        assert_eq!(create_office_snapshot_request(position("xlsx"), &json!({ "cursor": "garbage" }), false), Err("Invalid Office snapshot cursor".to_owned()));
        let same = create_office_snapshot_request(position("xlsx"), &json!({ "cursor": cursor, "sheet": "Data", "limit": 10 }), false).expect("same selector");
        assert_eq!((same["offset"].clone(), same["limit"].clone(), same["sheet"].clone()), (json!(50), json!(10), json!("Data")));
    }

    // The cross-sheet case of `a paged workbook names every sheet and the cursor walks into the next one`.
    #[test]
    fn the_cursor_of_a_workbook_walks_into_the_next_sheet() {
        let first = create_office_snapshot_request(position("xlsx"), &json!({}), false).expect("request");
        let mut page = json!({ "pagination": { "unit": "populated-cell", "nextOffset": null, "nextSheetOffset": 1 } });
        finalize_office_snapshot_page(&mut page, position("xlsx"), &first);
        assert_eq!(page["pagination"]["hasMore"], json!(true));
        assert_eq!(page["pagination"]["cursor"], Value::Null);
        assert!(page["pagination"].get("nextOffset").is_none() && page["pagination"].get("nextSheetOffset").is_none());
        let next = cursor_of(&page, "nextCursor");
        assert_eq!((next["offset"].clone(), next["sheetOffset"].clone(), next["revision"].clone()), (json!(0), json!(1), json!(0)));
        let second = create_office_snapshot_request(position("xlsx"), &json!({ "cursor": page["pagination"]["nextCursor"] }), false).expect("second");
        assert_eq!((second["offset"].clone(), second["sheetOffset"].clone()), (json!(0), json!(1)));
        let mut last = json!({ "pagination": { "nextOffset": null } });
        finalize_office_snapshot_page(&mut last, position("xlsx"), &second);
        assert_eq!((last["pagination"]["hasMore"].clone(), last["pagination"]["nextCursor"].clone()), (json!(false), Value::Null));
        assert!(last["pagination"]["cursor"].is_string());
    }

    #[test]
    fn a_page_without_pagination_or_a_full_read_is_left_alone() {
        let mut plain = json!({ "format": "docx" });
        finalize_office_snapshot_page(&mut plain, position("docx"), &Request::new());
        assert_eq!(plain, json!({ "format": "docx" }));
        let mut full = json!({ "pagination": { "nextOffset": 3 } });
        finalize_office_snapshot_page(&mut full, position("docx"), json!({ "full": true }).as_object().expect("object"));
        assert_eq!(full, json!({ "pagination": { "nextOffset": 3 } }));
    }
}
