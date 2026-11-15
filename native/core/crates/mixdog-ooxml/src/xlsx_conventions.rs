//! `portable/xlsx-conventions.mjs`: what an existing workbook already does (its faces, its number formats by column,
//! and the colour or fill that marks an input), read from the styled cells of a snapshot so an edit can match the file
//! instead of the guideline. Both snapshot readers feed the same cell shape (`{ ref, value, formula?, style? }`).

use std::cmp::Ordering;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, locale_compare, value_to_string};
use mixdog_office_base::a1::column_number;
use serde_json::{Map, Value, json};

use crate::xlsx_audit_support::{is_marked_input_style, is_numeric_cell, js_text, list, text_or_empty, truthy};

const TOP_FONTS: usize = 5;
const TOP_FORMATS: usize = 8;
const TOP_MARKERS: usize = 3;
const SAMPLE_INPUTS: usize = 5;

static COLUMN_LETTERS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[A-Z]+", "i"));

/// One counted key: the value as the style carried it, how many cells, and the columns it stood in.
struct Tally {
    key: Value,
    count: usize,
    columns: Vec<String>,
}

/// A JavaScript `Map` keyed by style values (insertion order, same-value keys joined): a number and its text are two keys.
#[derive(Default)]
struct Tallies(Vec<Tally>);

impl Tallies {
    /// `tally(map, key, extra)`: a falsy key is not counted.
    fn tally(&mut self, key: Option<&Value>, extra: &str) {
        let Some(key) = key.filter(|key| truthy(Some(*key))) else {
            return;
        };
        let at = self.0.iter().position(|entry| same_key(&entry.key, key));
        let entry = match at {
            Some(at) => &mut self.0[at],
            None => {
                self.0.push(Tally { key: key.clone(), count: 0, columns: Vec::new() });
                self.0.last_mut().expect("just pushed")
            }
        };
        entry.count += 1;
        if !extra.is_empty() && !entry.columns.iter().any(|column| column == extra) {
            entry.columns.push(extra.to_owned());
        }
    }

    /// `ranked(map, limit, label)`: the most used first, ties in the order of their text.
    fn ranked(&self, limit: usize, label: &str) -> Value {
        let mut entries: Vec<&Tally> = self.0.iter().collect();
        entries.sort_by(|left, right| {
            right
                .count
                .cmp(&left.count)
                .then_with(|| locale_compare(&value_to_string(&left.key), &value_to_string(&right.key)))
        });
        Value::Array(
            entries
                .into_iter()
                .take(limit)
                .map(|entry| {
                    let mut row = Map::new();
                    row.insert(label.to_owned(), entry.key.clone());
                    row.insert("cells".to_owned(), json!(entry.count));
                    if !entry.columns.is_empty() {
                        let mut columns = entry.columns.clone();
                        columns.sort_by(|a, b| column_number(a).partial_cmp(&column_number(b)).unwrap_or(Ordering::Equal));
                        row.insert("columns".to_owned(), json!(columns));
                    }
                    Value::Object(row)
                })
                .collect(),
        )
    }
}

/// SameValueZero of two parsed JSON values.
fn same_key(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        _ => left == right,
    }
}

/// `summarizeXlsxConventions(document)`: the faces, formats and input markers a workbook uses, or `None` where it
/// carries no style at all.
pub fn summarize_xlsx_conventions(document: &Value) -> Option<Value> {
    let mut fonts = Tallies::default();
    let mut formats = Tallies::default();
    let mut input_colors = Tallies::default();
    let mut input_fills = Tallies::default();
    let mut marked_inputs: Vec<String> = Vec::new();
    let (mut styled, mut formulas, mut hardcodes) = (0_usize, 0_usize, 0_usize);
    for sheet in list(document.get("sheets")) {
        for cell in list(sheet.get("cells")) {
            let reference = cell.get("ref");
            if !truthy(reference) {
                continue;
            }
            let style = cell.get("style").filter(|style| style.is_object() || style.is_array());
            let text = js_text(reference);
            let column = COLUMN_LETTERS.find(&text).map(|found| text[found].to_uppercase()).unwrap_or_default();
            let has_formula = truthy(cell.get("formula"));
            if has_formula {
                formulas += 1;
            }
            if let Some(style) = style {
                styled += 1;
                fonts.tally(style.get("fontName"), "");
                formats.tally(style.get("numberFormat"), &column);
            }
            if !has_formula && is_numeric_cell(cell) {
                hardcodes += 1;
                if is_marked_input_style(style) {
                    marked_inputs.push(format!("{}!{}", js_text(sheet.get("name")), text));
                    let style = style.expect("a marked style is an object");
                    input_colors.tally(style.get("color"), "");
                    input_fills.tally(style.get("fillColor"), "");
                }
            }
        }
    }
    let default_font = text_or_empty(document.get("defaultStyle").and_then(|style| style.get("fontName")));
    if styled == 0 && default_font.is_empty() {
        return None;
    }
    let mut summary = Map::new();
    if !default_font.is_empty() {
        summary.insert("defaultFont".to_owned(), json!(default_font));
    }
    summary.insert("fonts".to_owned(), fonts.ranked(TOP_FONTS, "name"));
    summary.insert("numberFormats".to_owned(), formats.ranked(TOP_FORMATS, "format"));
    summary.insert(
        "inputMarkers".to_owned(),
        json!({ "fontColors": input_colors.ranked(TOP_MARKERS, "color"), "fills": input_fills.ranked(TOP_MARKERS, "color") }),
    );
    summary.insert(
        "cells".to_owned(),
        json!({ "styled": styled, "formulas": formulas, "hardcodes": hardcodes, "markedInputs": marked_inputs.len() }),
    );
    summary.insert(
        "sampleInputs".to_owned(),
        Value::Array(marked_inputs.iter().take(SAMPLE_INPUTS).map(|input| json!(input)).collect()),
    );
    Some(Value::Object(summary))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workbook_without_styles_has_no_conventions() {
        assert_eq!(summarize_xlsx_conventions(&json!({ "sheets": [{ "name": "A", "cells": [{ "ref": "A1", "value": 1 }] }] })), None);
    }

    #[test]
    fn faces_formats_and_input_markers_are_counted() {
        let document = json!({
            "defaultStyle": { "fontName": "Calibri" },
            "sheets": [{ "name": "Inputs", "cells": [
                { "ref": "B2", "value": 5, "style": { "fontName": "Arial", "numberFormat": "#,##0", "color": "0000FF" } },
                { "ref": "B3", "value": 6, "style": { "fontName": "Arial", "numberFormat": "#,##0", "color": "0000FF" } },
                { "ref": "C3", "formula": "=B3", "value": 6, "style": { "fontName": "Calibri", "numberFormat": "0.0%" } },
            ] }]
        });
        let summary = summarize_xlsx_conventions(&document).expect("styled");
        assert_eq!(summary["defaultFont"], "Calibri");
        assert_eq!(summary["fonts"][0], json!({ "name": "Arial", "cells": 2 }));
        assert_eq!(summary["numberFormats"][0], json!({ "format": "#,##0", "cells": 2, "columns": ["B"] }));
        assert_eq!(summary["cells"], json!({ "styled": 3, "formulas": 1, "hardcodes": 2, "markedInputs": 2 }));
        assert_eq!(summary["sampleInputs"], json!(["Inputs!B2", "Inputs!B3"]));
    }
}
