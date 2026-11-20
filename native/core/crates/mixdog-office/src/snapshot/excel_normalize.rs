//! Excel's snapshot in the shape the portable reader gives (`core/excel-snapshot-normalize.mjs`): RRGGBB colours with
//! defaults omitted, text cells flagged, validations and conditional formats named as the file names them, and a chart's
//! series split into its three references, so the formula audit and the model see one shape from both readers.

use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, number_to_string, value_to_string};
use mixdog_office_base::values::truthy;
use mixdog_ooxml::sheet_styles::normalize_excel_cell_style;
use serde_json::{Map, Value};

/// Excel names a validation's kind by enumeration number.
const VALIDATION_TYPES: [&str; 8] = ["none", "whole", "decimal", "list", "date", "time", "textLength", "custom"];
/// Excel names an operator by enumeration number.
const OPERATORS: [&str; 9] = ["", "between", "notBetween", "equal", "notEqual", "greaterThan", "lessThan", "greaterThanOrEqual", "lessThanOrEqual"];

/// `EXCEL_CONDITION_TYPES[number]`.
fn condition_type(number: &str) -> Option<&'static str> {
    Some(match number {
        "1" => "cellIs",
        "2" => "expression",
        "3" => "colorScale",
        "4" => "dataBar",
        "5" => "top10",
        "6" => "iconSet",
        "8" => "uniqueValues",
        "9" => "containsText",
        "10" => "containsBlanks",
        "11" => "timePeriod",
        "12" => "aboveAverage",
        "13" => "notContainsBlanks",
        "16" => "containsErrors",
        "17" => "notContainsErrors",
        _ => return None,
    })
}

/// `EXCEL_CHART_KINDS[number]`.
fn chart_kind(number: &str) -> Option<&'static str> {
    Some(match number {
        "51" => "column",
        "52" => "stacked_column",
        "57" => "bar",
        "58" => "stacked_bar",
        "4" | "65" => "line",
        "1" => "area",
        "5" => "pie",
        "-4120" => "doughnut",
        "-4169" => "scatter",
        _ => return None,
    })
}

static SERIES_REFERENCE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"^'?[^'"]*'?!\$?[A-Z]"#, "i"));

/// `list[index]` of a JavaScript array looked up by a value: a whole number in range, or the text of one.
fn listed<'a>(list: &[&'a str], index: Option<&Value>) -> Option<&'a str> {
    let at = match index? {
        Value::Number(number) => {
            let number = number.as_f64()?;
            if number.fract() != 0.0 || number < 0.0 {
                return None;
            }
            number as usize
        }
        Value::String(text) => text.parse::<usize>().ok().filter(|parsed| parsed.to_string() == *text)?,
        _ => return None,
    };
    list.get(at).copied()
}

fn operator_name(index: Option<&Value>) -> String {
    listed(&OPERATORS, index).unwrap_or("").to_owned()
}

/// `withoutEquals(formula)`: `String(formula ?? '')` without one leading `=`.
fn without_equals(formula: Option<&Value>) -> String {
    let text = match formula {
        None | Some(Value::Null) => String::new(),
        Some(other) => value_to_string(other),
    };
    text.strip_prefix('=').map_or_else(|| text.clone(), str::to_owned)
}

fn numeric_type(entry: &Map<String, Value>) -> Option<&Value> {
    entry.get("type").filter(|kind| kind.is_number())
}

fn normalize_rules(sheet: &mut Map<String, Value>) {
    if let Some(Value::Array(validations)) = sheet.get_mut("validations") {
        for entry in validations.iter_mut() {
            let Value::Object(map) = entry else { continue };
            let Some(kind) = numeric_type(map).cloned() else { continue };
            let name = listed(&VALIDATION_TYPES, Some(&kind)).map_or_else(|| value_to_string(&kind), str::to_owned);
            let mut formula1 = without_equals(map.get("formula1"));
            let literal_list = name == "list" && !formula1.is_empty() && !map.get("formula1").is_some_and(|raw| value_to_string(raw).starts_with('='));
            if literal_list {
                formula1 = format!("\"{formula1}\"");
            }
            let operator = if name == "list" || name == "custom" { String::new() } else { operator_name(map.get("operator")) };
            let formula2 = without_equals(map.get("formula2"));
            map.insert("type".to_owned(), Value::String(name));
            map.insert("operator".to_owned(), Value::String(operator));
            map.insert("formula1".to_owned(), Value::String(formula1));
            map.insert("formula2".to_owned(), Value::String(formula2));
        }
    }
    if let Some(Value::Array(formats)) = sheet.get_mut("conditionalFormats") {
        for entry in formats.iter_mut() {
            let Value::Object(map) = entry else { continue };
            let Some(kind) = numeric_type(map).cloned() else { continue };
            let range = map.get("range").filter(|range| truthy(range)).map(value_to_string).unwrap_or_default();
            let (first, second) = (map.get("formula1").cloned(), map.get("formula2").cloned());
            // `{ range, formula1, formula2, ...rest }`.
            let mut rest = Map::new();
            for (key, value) in map.iter() {
                if !matches!(key.as_str(), "range" | "formula1" | "formula2") {
                    rest.insert(key.clone(), value.clone());
                }
            }
            let name = condition_type(&value_to_string(&kind)).map_or_else(|| value_to_string(&kind), str::to_owned);
            let ranges: Vec<Value> = range.split([' ', ',']).filter(|part| !part.is_empty()).map(|part| Value::String(part.to_owned())).collect();
            rest.insert("ranges".to_owned(), Value::Array(ranges));
            rest.insert("type".to_owned(), Value::String(name.clone()));
            let operator = if name == "cellIs" { operator_name(map.get("operator")) } else { String::new() };
            rest.insert("operator".to_owned(), Value::String(operator));
            let formulas = [first, second].into_iter().flatten().filter(truthy).map(|formula| Value::String(without_equals(Some(&formula)))).collect();
            rest.insert("formulas".to_owned(), Value::Array(formulas));
            *map = rest;
        }
    }
}

/// `seriesArguments(formula)`: the arguments of an `=SERIES(...)` formula, cut at the commas outside quotes and
/// parentheses (a quoted sheet name may hold one); `None` for any other formula.
fn series_arguments(formula: Option<&Value>) -> Option<Vec<String>> {
    let text = formula.filter(|formula| truthy(formula)).map(value_to_string).unwrap_or_default();
    let trimmed = js_trim(&text);
    let body = trimmed.strip_prefix('=').unwrap_or(trimmed);
    let head = body.get(..7)?;
    if !head.eq_ignore_ascii_case("SERIES(") || !body.ends_with(')') || body.len() < 8 {
        return None;
    }
    let inner = &body[7..body.len() - 1];
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth = 0_i64;
    let mut quoted = false;
    for character in inner.chars() {
        if character == '\'' || character == '"' {
            quoted = !quoted;
        } else if !quoted && character == '(' {
            depth += 1;
        } else if !quoted && character == ')' {
            depth -= 1;
        }
        if character == ',' && !quoted && depth == 0 {
            parts.push(js_trim(&current).to_owned());
            current.clear();
        } else {
            current.push(character);
        }
    }
    parts.push(js_trim(&current).to_owned());
    Some(parts)
}

/// `a === b` of two optional JSON values: numbers by value, text and flags by content, anything structured never equal.
fn strictly_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Null), Some(Value::Null)) => true,
        _ => false,
    }
}

fn normalize_series(series: &Value) -> Value {
    let Some(parts) = series_arguments(series.get("formula")) else { return series.clone() };
    let part = |at: usize| parts.get(at).cloned().unwrap_or_default();
    let name = part(0);
    let mut next = series.as_object().cloned().unwrap_or_default();
    next.insert("formula".to_owned(), Value::String(if SERIES_REFERENCE.is_match(&name) { name } else { String::new() }));
    next.insert("categoryFormula".to_owned(), Value::String(part(1)));
    next.insert("valueFormula".to_owned(), Value::String(part(2)));
    Value::Object(next)
}

fn normalize_charts(sheet: &mut Map<String, Value>) {
    let Some(Value::Array(charts)) = sheet.get_mut("charts") else { return };
    for chart in charts.iter_mut() {
        let Value::Object(next) = chart else { continue };
        if let Some(kind) =
            next.get("chartType").filter(|kind| kind.is_number()).and_then(|kind| kind.as_f64()).and_then(|kind| chart_kind(&number_to_string(kind)))
        {
            next.insert("chartType".to_owned(), Value::String(kind.to_owned()));
        }
        if let Some(Value::Array(series)) = next.get("series") {
            let normalized: Vec<Value> = series.iter().map(normalize_series).collect();
            let count = normalized.len();
            next.insert("series".to_owned(), Value::Array(normalized));
            next.insert("seriesCount".to_owned(), Value::from(count));
        }
        // The frame's place is the anchor's; the same four numbers beside it repeat it.
        let repeats = match next.get("anchor") {
            Some(anchor) if truthy(anchor) => ["left", "top", "width", "height"].iter().all(|key| strictly_equal(next.get(*key), anchor.get(*key))),
            _ => false,
        };
        if repeats {
            for key in ["left", "top", "width", "height"] {
                next.shift_remove(key);
            }
        }
    }
}

/// `normalizeExcelSnapshotStyles(document)`: the workbook an Excel session read, in the portable reader's shape.
pub fn normalize_excel_snapshot_styles(document: &mut Value) {
    let Some(Value::Array(sheets)) = document.get_mut("sheets") else { return };
    for sheet in sheets.iter_mut() {
        let Value::Object(sheet) = sheet else { continue };
        normalize_rules(sheet);
        normalize_charts(sheet);
        let Some(Value::Array(cells)) = sheet.get_mut("cells") else { continue };
        for cell in cells.iter_mut() {
            let Value::Object(cell) = cell else { continue };
            if let Some(style) = cell.get("style").filter(|style| truthy(style)).cloned() {
                cell.insert("style".to_owned(), normalize_excel_cell_style(&style));
            }
            let no_formula = !cell.get("formula").is_some_and(truthy);
            if no_formula && cell.get("value").and_then(Value::as_str).is_some_and(|text| !text.is_empty()) {
                cell.insert("dataType".to_owned(), Value::String("text".to_owned()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_js::json_stringify;
    use serde_json::json;

    use super::*;

    fn normalized(mut document: Value) -> String {
        normalize_excel_snapshot_styles(&mut document);
        json_stringify(&document)
    }

    #[test]
    fn validations_are_named_as_the_file_names_them() {
        let text = normalized(json!({ "sheets": [{ "validations": [
            { "ranges": ["B2"], "type": 3, "operator": 1, "formula1": "a,b", "formula2": null },
            { "type": 3, "formula1": "=$A$1:$A$3" },
            { "type": 1, "operator": 3, "formula1": "=1", "formula2": "=10" },
            { "type": 99, "formula1": 5 },
            { "type": "list", "formula1": "=keep" }
        ] }] }));
        assert_eq!(
            text,
            concat!(
                r#"{"sheets":[{"validations":["#,
                r#"{"ranges":["B2"],"type":"list","operator":"","formula1":"\"a,b\"","formula2":""},"#,
                r#"{"type":"list","formula1":"$A$1:$A$3","operator":"","formula2":""},"#,
                r#"{"type":"whole","operator":"equal","formula1":"1","formula2":"10"},"#,
                r#"{"type":"99","formula1":"5","operator":"","formula2":""},"#,
                r#"{"type":"list","formula1":"=keep"}]}]}"#
            )
        );
    }

    #[test]
    fn conditional_formats_split_their_ranges_and_formulas() {
        let text = normalized(json!({ "sheets": [{ "conditionalFormats": [
            { "range": "A1:A5, C1  D2", "type": 1, "operator": 5, "formula1": "=0.9", "priority": 1 },
            { "type": 2, "formula1": "=$A1>0", "formula2": 0, "range": "" }
        ] }] }));
        assert_eq!(
            text,
            concat!(
                r#"{"sheets":[{"conditionalFormats":["#,
                r#"{"type":"cellIs","operator":"greaterThan","priority":1,"ranges":["A1:A5","C1","D2"],"formulas":["0.9"]},"#,
                r#"{"type":"expression","ranges":[],"operator":"","formulas":["$A1>0"]}]}]}"#
            )
        );
    }

    #[test]
    fn a_series_formula_is_split_into_its_three_references() {
        assert_eq!(series_arguments(Some(&json!("=SERIES('Sales, Q1'!$B$1,Sales!$A$2:$A$5,Sales!$B$2:$B$5,1)"))).expect("series").len(), 4);
        assert_eq!(series_arguments(Some(&json!("=SUM(A1)"))), None);
        let text = normalized(json!({ "sheets": [{ "charts": [{
            "chartType": 51, "left": 1, "top": 2, "width": 3, "height": 4, "anchor": { "left": 1, "top": 2, "width": 3, "height": 4 },
            "series": [{ "formula": "=SERIES('Sales, Q1'!$B$1,Sales!$A$2:$A$5,Sales!$B$2:$B$5,1)" }, { "formula": "=SERIES(\"Name\",,Sales!$C$2:$C$5,2)" }, { "formula": "plain" }]
        }, { "chartType": -4169, "left": 1, "anchor": { "left": 9 } }, { "chartType": 77 }, 5] }] }));
        assert_eq!(
            text,
            concat!(
                r#"{"sheets":[{"charts":[{"chartType":"column","anchor":{"left":1,"top":2,"width":3,"height":4},"series":["#,
                r#"{"formula":"'Sales, Q1'!$B$1","categoryFormula":"Sales!$A$2:$A$5","valueFormula":"Sales!$B$2:$B$5"},"#,
                r#"{"formula":"","categoryFormula":"","valueFormula":"Sales!$C$2:$C$5"},{"formula":"plain"}],"seriesCount":3},"#,
                r#"{"chartType":"scatter","left":1,"anchor":{"left":9}},{"chartType":77},5]}]}"#
            )
        );
    }

    #[test]
    fn a_text_cell_is_flagged_and_a_formula_cell_is_not() {
        let text = normalized(json!({ "sheets": [{ "cells": [
            { "ref": "A1", "value": "text" }, { "ref": "A2", "value": "=1+1", "formula": "=1+1" }, { "ref": "A3", "value": "" }, { "ref": "A4", "value": 5 }, null
        ] }] }));
        assert_eq!(
            text,
            concat!(
                r#"{"sheets":[{"cells":[{"ref":"A1","value":"text","dataType":"text"},{"ref":"A2","value":"=1+1","formula":"=1+1"},"#,
                r#"{"ref":"A3","value":""},{"ref":"A4","value":5},null]}]}"#
            )
        );
        assert_eq!(normalized(json!({ "sheetCount": 0 })), r#"{"sheetCount":0}"#);
    }
}
