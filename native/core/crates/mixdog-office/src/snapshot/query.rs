//! Searching a snapshot and addressing into it (`queryObject`, `findByDocumentPath`, `snapshotSelectionForTarget` of
//! `core/office-sessions.mjs`).
//!
//! A match answers where the text is, not with the whole field it sits in: a document body comes back as the text around
//! each hit, so a query costs a few lines instead of the page (or the entire PDF) that contains them. Positions and lengths
//! are in UTF-16 units, as the texts are measured in JavaScript.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_object_keys, js_to_lowercase, js_trim, json_number, string_to_number, utf16_len};
use serde_json::{Map, Value};

/// A value longer than this many units is answered as the excerpts around its hits.
const QUERY_VALUE_LIMIT: usize = 240;
/// How much text surrounds a hit in an excerpt.
const QUERY_EXCERPT_RADIUS: usize = 90;
/// The most matches a query answers with.
const QUERY_MATCH_LIMIT: usize = 100;
/// The most hits of one value that are quoted.
const QUOTED_HITS: usize = 3;
/// How far the occurrences of one value are counted.
const OCCURRENCE_LIMIT: usize = 1_000;

static CELL_TARGET: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^/sheet\[([^\]]+)]/cell\[([A-Z]+\d+)]$", "i"));
static RANGE_TARGET: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^/sheet\[([^\]]+)]/range\[([A-Z]+\d+:[A-Z]+\d+)]$", "i"));
static SLIDE_TARGET: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^/slide\[(\d+)]", ""));

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn text_of(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `haystack.indexOf(needle, from)` over UTF-16 units: an empty needle is found at `from` (at most the end).
fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(haystack.len()));
    }
    if from >= haystack.len() || needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|at| haystack[*at..*at + needle.len()] == *needle)
}

/// `queryMatchValue(value, query)`: the fields a match carries besides its place.
fn query_match_value(value: &str, query: &str) -> Map<String, Value> {
    let text = units(value);
    let mut answer = Map::new();
    if text.len() <= QUERY_VALUE_LIMIT {
        answer.insert("value".to_owned(), Value::String(value.to_owned()));
        return answer;
    }
    let haystack = units(&js_to_lowercase(value));
    let needle = units(query);
    let step = needle.len().max(1);
    let mut hits: Vec<usize> = Vec::new();
    let mut from = 0;
    while hits.len() < QUOTED_HITS {
        let Some(index) = index_of(&haystack, &needle, from) else { break };
        hits.push(index);
        from = index + step;
    }
    let mut occurrences = hits.len();
    let mut from = hits.last().copied().unwrap_or(0);
    while occurrences < OCCURRENCE_LIMIT {
        let Some(index) = index_of(&haystack, &needle, from + step) else { break };
        occurrences += 1;
        from = index;
    }
    let excerpt = hits
        .iter()
        .map(|index| {
            let start = index.saturating_sub(QUERY_EXCERPT_RADIUS);
            let end = (index + needle.len() + QUERY_EXCERPT_RADIUS).min(text.len());
            let slice = text_of(&text[start.min(end)..end]);
            format!("{}{}{}", if start > 0 { "…" } else { "" }, js_trim(&slice), if end < text.len() { "…" } else { "" })
        })
        .collect::<Vec<_>>()
        .join(" ⋯ ");
    answer.insert("value".to_owned(), Value::String(if excerpt.is_empty() { text_of(&text[..QUERY_VALUE_LIMIT]) } else { excerpt }));
    answer.insert("excerpt".to_owned(), Value::Bool(true));
    answer.insert("valueLength".to_owned(), Value::from(utf16_len(value)));
    if occurrences > hits.len() {
        answer.insert("occurrences".to_owned(), Value::from(occurrences));
    }
    answer
}

fn contains_query(value: &str, query: &str) -> bool {
    index_of(&units(&js_to_lowercase(value)), &units(query), 0).is_some()
}

/// `queryObject(value, query, path, matches)`: where in a document the lower-cased `query` occurs, case-insensitively, as
/// at most [`QUERY_MATCH_LIMIT`] matches (the limit is checked as each value is entered, so the one object being walked
/// when it is reached may add its remaining fields). A match names the logical path of the object that holds it (its own
/// `path` field) and, for a field of an object, the field.
pub fn query_object(value: &Value, query: &str, path: &str, matches: &mut Vec<Value>) {
    if matches.len() >= QUERY_MATCH_LIMIT {
        return;
    }
    match value {
        Value::String(text) => {
            if contains_query(text, query) {
                let mut found = Map::new();
                found.insert("path".to_owned(), Value::String(path.to_owned()));
                found.extend(query_match_value(text, query));
                matches.push(Value::Object(found));
            }
        }
        Value::Array(items) => {
            for (index, entry) in items.iter().enumerate() {
                query_object(entry, query, &format!("{path}[{index}]"), matches);
            }
        }
        Value::Object(map) => {
            let logical = map.get("path").and_then(Value::as_str).unwrap_or(path);
            for key in js_object_keys(map) {
                if key == "path" {
                    continue;
                }
                let entry = &map[key.as_str()];
                match entry {
                    Value::String(text) if contains_query(text, query) => {
                        let mut found = Map::new();
                        found.insert("path".to_owned(), Value::String(logical.to_owned()));
                        found.insert("field".to_owned(), Value::String(key.clone()));
                        found.extend(query_match_value(text, query));
                        matches.push(Value::Object(found));
                    }
                    _ => query_object(entry, query, &format!("{logical}.{key}"), matches),
                }
            }
        }
        _ => {}
    }
}

/// `findByDocumentPath(value, target)`: the first object (depth first, in document order) whose `path` is `target`.
pub fn find_by_document_path<'a>(value: &'a Value, target: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => {
            if map.get("path").and_then(Value::as_str) == Some(target) {
                return Some(value);
            }
            js_object_keys(map).into_iter().find_map(|key| find_by_document_path(&map[key.as_str()], target))
        }
        Value::Array(items) => items.iter().find_map(|entry| find_by_document_path(entry, target)),
        _ => None,
    }
}

/// `snapshotSelectionForTarget(format, target)`: the part of a document a target path names, as the selector a snapshot
/// takes (`{ sheet, range }` for a cell or range of a workbook or delimited file, `{ pages: [n] }` for a slide), or `{}`.
pub fn snapshot_selection_for_target(format: &str, target: &str) -> Value {
    let mut selection = Map::new();
    if matches!(format, "xlsx" | "csv" | "tsv") {
        if let Some(cell) = CELL_TARGET.captures(target) {
            let (sheet, reference) = (cell.get(1).unwrap_or(""), cell.get(2).unwrap_or(""));
            selection.insert("sheet".to_owned(), Value::String(sheet.to_owned()));
            selection.insert("range".to_owned(), Value::String(format!("{reference}:{reference}")));
            return Value::Object(selection);
        }
        if let Some(range) = RANGE_TARGET.captures(target) {
            selection.insert("sheet".to_owned(), Value::String(range.get(1).unwrap_or("").to_owned()));
            selection.insert("range".to_owned(), Value::String(range.get(2).unwrap_or("").to_owned()));
            return Value::Object(selection);
        }
    }
    if format == "pptx"
        && let Some(slide) = SLIDE_TARGET.captures(target)
    {
        selection.insert("pages".to_owned(), Value::Array(vec![json_number(string_to_number(slide.get(1).unwrap_or("")))]));
    }
    Value::Object(selection)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn query(value: &Value, text: &str) -> Vec<Value> {
        let mut matches = Vec::new();
        query_object(value, text, "$", &mut matches);
        matches
    }

    #[test]
    fn a_short_value_answers_whole_and_names_its_object_and_field() {
        let document = json!({ "paragraphs": [{ "path": "/body/p[1]", "text": "Quarterly Report", "style": "Title" }, { "path": "/body/p[2]", "text": "nothing" }] });
        assert_eq!(query(&document, "report"), [json!({ "path": "/body/p[1]", "field": "text", "value": "Quarterly Report" })]);
        assert_eq!(query(&json!(["a report", 3, null]), "report"), [json!({ "path": "$[0]", "value": "a report" })]);
        assert!(query(&document, "absent").is_empty());
    }

    #[test]
    fn a_long_value_answers_the_text_around_up_to_three_hits_and_counts_the_rest() {
        let filler = "x".repeat(200);
        let text = format!("{filler}needle{filler}needle{filler}needle{filler}needle{filler}needle");
        let matches = query(&json!({ "text": text }), "needle");
        assert_eq!(matches.len(), 1);
        let found = matches[0].as_object().expect("a match");
        assert_eq!(found["valueLength"], json!(utf16_len(&text)));
        assert_eq!((found["excerpt"].clone(), found["occurrences"].clone()), (json!(true), json!(5)));
        let value = found["value"].as_str().expect("text");
        assert_eq!(value.matches(" ⋯ ").count(), 2);
        assert!(value.starts_with('…') && value.ends_with('…'));
        assert!(value.chars().count() < 700);
    }

    #[test]
    fn at_most_a_hundred_matches_come_back() {
        let list = Value::Array((0..150).map(|index| json!(format!("hit {index}"))).collect());
        assert_eq!(query(&list, "hit").len(), 100);
    }

    #[test]
    fn a_document_path_is_found_depth_first() {
        let document = json!({ "sheets": [{ "path": "/sheet[A]", "cells": [{ "path": "/sheet[A]/cell[B2]", "value": 1 }] }] });
        assert_eq!(find_by_document_path(&document, "/sheet[A]/cell[B2]"), Some(&json!({ "path": "/sheet[A]/cell[B2]", "value": 1 })));
        assert!(find_by_document_path(&document, "/sheet[A]/cell[C3]").is_none());
        assert!(find_by_document_path(&json!(5), "/x").is_none());
    }

    #[test]
    fn a_target_names_the_part_a_snapshot_should_read() {
        assert_eq!(snapshot_selection_for_target("xlsx", "/sheet[Data]/cell[B2]"), json!({ "sheet": "Data", "range": "B2:B2" }));
        assert_eq!(snapshot_selection_for_target("csv", "/SHEET[x]/RANGE[a1:c3]"), json!({ "sheet": "x", "range": "a1:c3" }));
        assert_eq!(snapshot_selection_for_target("pptx", "/slide[3]/shape[2]"), json!({ "pages": [3] }));
        assert_eq!(snapshot_selection_for_target("docx", "/sheet[Data]/cell[B2]"), json!({}));
        assert_eq!(snapshot_selection_for_target("pptx", "/slides[3]"), json!({}));
    }
}
