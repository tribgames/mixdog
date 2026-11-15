//! A Word document or workbook held to its brief, as an authored deck is: every figure its words show has a fact with a
//! source, and a fact cites where a reader can open it. Ported from `src/runtime/office/quality/document-brief.mjs`.
//! The brief is the deck's (`design.brief`, key: value lines) and the readings are the deck's own, over the document's
//! text instead of its slides.
//!
//! The brief parser and its readings live in `mixdog-office-author`, which itself uses this crate's issue record, so the
//! readings reach this module through [`BriefReadings`]; the author crate (or the caller that holds both) answers it.

use mixdog_office_base::values::truthy;
use serde_json::{Map, Value, json};

use crate::{field, template_text};

/// The brief parser and the two readings this module asks of the deck's authoring brief (`pptx-brief.mjs`).
pub trait BriefReadings {
    /// `htmlBriefScript(html)`: the script of the HTML BRIEF comment.
    fn html_brief_script(&self, html: &str) -> String;
    /// `parseAuthoringBrief(script)`: the brief record (its `present` flag says whether the script carried one).
    fn parse_authoring_brief(&self, script: &str) -> Value;
    /// `reviewFactCoverage(document, brief)`: figures the words show that no fact backs.
    fn review_fact_coverage(&self, document: &Value, brief: &Value) -> Vec<Value>;
    /// `reviewSourceGrounding(brief)`: facts whose source a reader cannot open.
    fn review_source_grounding(&self, brief: &Value) -> Vec<Value>;
}

/// `documentBrief(text)`: the brief a docx/xlsx call names in `design.brief` (the HTML BRIEF's key: value lines), or
/// `None`.
pub fn document_brief(readings: &dyn BriefReadings, text: &str) -> Option<Value> {
    let source = mixdog_js::js_trim(text);
    if source.is_empty() {
        return None;
    }
    let brief = readings.parse_authoring_brief(&readings.html_brief_script(&format!("<!-- BRIEF\n{source}\n-->")));
    field(&brief, "present").is_some_and(truthy).then_some(brief)
}

/// `{ text: value }` with the key left out when the value is absent (`undefined` is not written).
fn shape(text: Option<&Value>) -> Value {
    let mut map = Map::new();
    if let Some(text) = text {
        map.insert("text".into(), text.clone());
    }
    Value::Object(map)
}

fn items<'a>(value: Option<&'a Value>) -> &'a [Value] {
    match value {
        Some(Value::Array(list)) => list,
        _ => &[],
    }
}

/// The document read as the deck reader reads slides: one entry per page-like unit, its text as shapes. A Word body is
/// one unit (paragraphs and table cells); a workbook is one per sheet, and only its words: a cell holding a number is
/// the data a chart or table shows, not a figure quoted in prose, and the facts line cites where those came from.
fn text_units(format: &str, document: &Value) -> Vec<Value> {
    if format == "docx" {
        let paragraphs = items(field(document, "paragraphs")).iter().map(|paragraph| shape(field(paragraph, "text")));
        let cells = items(field(document, "tables")).iter().flat_map(|table| {
            items(field(table, "rows"))
                .iter()
                .flat_map(|row| items(field(row, "cells")).iter().map(|cell| shape(field(cell, "text"))))
        });
        let shapes: Vec<Value> = paragraphs.chain(cells).collect();
        return vec![json!({ "index": 1, "path": "/body", "shapes": shapes })];
    }
    items(field(document, "sheets"))
        .iter()
        .enumerate()
        .map(|(index, sheet)| {
            let shapes: Vec<Value> = items(field(sheet, "cells"))
                .iter()
                .filter_map(|cell| field(cell, "value").filter(|value| value.is_string()))
                .map(|value| shape(Some(value)))
                .collect();
            json!({
                "index": index + 1,
                "path": format!("/sheet[{}]", template_text(field(sheet, "name"))),
                "shapes": shapes,
            })
        })
        .collect()
}

/// `documentBriefIssues(format, document, brief)`: the brief's readings on a Word document or workbook: unfounded
/// figures, a missing facts line, loose sources. A PDF's figures are reviewed from the rendered page text by the PDF
/// pipeline.
pub fn document_brief_issues(readings: &dyn BriefReadings, format: &str, document: &Value, brief: Option<&Value>) -> Vec<Value> {
    let Some(brief) = brief.filter(|brief| field(brief, "present").is_some_and(truthy)) else { return Vec::new() };
    if format != "docx" && format != "xlsx" {
        return Vec::new();
    }
    let units = text_units(format, document);
    let paths: Vec<(String, String)> = units
        .iter()
        .map(|unit| (format!("/slide[{}]", template_text(field(unit, "index"))), template_text(field(unit, "path"))))
        .collect();
    let mut issues: Vec<Value> = readings
        .review_fact_coverage(&json!({ "slides": units }), brief)
        .into_iter()
        .map(|mut entry| {
            let unit_path = field(&entry, "path")
                .and_then(Value::as_str)
                .and_then(|path| paths.iter().find(|(slide, _)| slide == path))
                .map(|(_, unit_path)| unit_path.clone());
            if let (Some(unit_path), Some(map)) = (unit_path, entry.as_object_mut()) {
                map.insert("path".into(), Value::String(unit_path));
            }
            entry
        })
        .collect();
    issues.extend(readings.review_source_grounding(brief));
    issues
}
