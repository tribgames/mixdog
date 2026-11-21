use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, number_to_string, to_number_of};
use mixdog_office_base::a1::column_label;
use serde_json::Value;

use crate::sheet_xml::Area;
use crate::xlsx_audit_support::{
    IssueList, Located, Position, cell_path, escape_reg_exp, formula_body_of, general_format, inside_area, locate, merged_areas, numeric_value, position,
    sheet_path, table_areas, text_or_empty, truthy,
};

const LONG_SHEET_ROWS: f64 = 20.0;
const NUMERIC_COLUMN_MIN: usize = 3;
/// One column of a table holds one quantity, and its format is what the reader compares the rows by: where nearly every
/// row agrees, the odd one out is a cell that missed the format, not a decision about that row.
const FORMAT_MAJORITY: f64 = 0.75;

/// Excel quotes a sheet name in a reference only when it is not a plain identifier: a letter or underscore first, then
/// letters, digits, underscores and periods. Letters include Hangul and every other script, so `모델!B8` evaluates
/// unquoted and reporting it leaves a warning nobody can resolve.
static SHEET_IDENTIFIER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[\p{L}_][\p{L}\p{N}_.]*$", "u"));
static EXTERNAL_LINK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\[\d+\]|\[[^\]]*\.xls[xmb]?\]", "i"));
static NUMBER_TEXT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*%?$", ""));
static YEAR_TEXT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:19|20)\d{2}$", ""));
static THOUSANDS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"#,#|0,0", ""));
static QUOTED_PART: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#""[^"]*""#, "g"));
static ESCAPED_PART: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\\.", "g"));

fn external_link_reference(formula: &str) -> bool {
    EXTERNAL_LINK.is_match(&formula_body_of(formula))
}

/// `externalDefinedNames(definedNames)`: the defined names that refer to another workbook: `=Rate*B2` reads that file
/// as surely as `=[1]Rates!$A$1*B2` does.
pub fn external_defined_names(defined_names: &[Value]) -> Vec<String> {
    defined_names
        .iter()
        .filter(|entry| truthy(entry.get("name")) && external_link_reference(&text_or_empty(entry.get("refersTo"))))
        .map(|entry| text_or_empty(entry.get("name")))
        .collect()
}

/// The first external name a formula reads, as a whole name (not the tail of a longer one, a sheet prefix, or a function
/// call).
fn external_name_read(formula: &str, external_names: &[String]) -> String {
    if external_names.is_empty() {
        return String::new();
    }
    let text = formula_body_of(formula);
    external_names
        .iter()
        .find(|name| {
            let pattern = format!(r"(?:^|[^\p{{L}}\p{{N}}_.!'\]]){}(?![\p{{L}}\p{{N}}_.(!])", escape_reg_exp(name));
            JsRegex::new(&pattern, "iu").is_ok_and(|read| read.is_match(&text))
        })
        .cloned()
        .unwrap_or_default()
}

fn unquoted_sheet_references(formula: &str, sheet_names: &[String]) -> Vec<String> {
    let text = formula_body_of(formula);
    sheet_names
        .iter()
        .filter(|name| !name.is_empty() && !SHEET_IDENTIFIER.is_match(name))
        .filter(|name| {
            let pattern = format!(r"(?:^|[^'A-Za-z0-9_.\]]){}!", escape_reg_exp(name));
            JsRegex::new(&pattern, "").is_ok_and(|reference| reference.is_match(&text))
        })
        .cloned()
        .collect()
}

fn format_code(style: Option<&Value>) -> String {
    let code = text_or_empty(style.and_then(|style| style.get("numberFormat")));
    let without_quoted = QUOTED_PART.replace_all_with(&code, |_| String::new());
    ESCAPED_PART.replace_all_with(&without_quoted, |_| String::new())
}

fn percent_format(style: Option<&Value>) -> bool {
    format_code(style).contains('%')
}

fn thousands_format(style: Option<&Value>) -> bool {
    THOUSANDS.is_match(&format_code(style))
}

/// Text that reads as a number: a thousands-grouped or plain figure, with or without a percent sign. A four-digit year
/// is text on purpose.
fn numeric_text(cell: &Value) -> bool {
    if cell.get("dataType").and_then(Value::as_str) != Some("text") {
        return false;
    }
    let Some(text) = cell.get("value").and_then(Value::as_str) else {
        return false;
    };
    let text = js_trim(text);
    NUMBER_TEXT.is_match(text) && !YEAR_TEXT.is_match(text)
}

fn format_key(style: Option<&Value>) -> String {
    if general_format(style) { "General".to_owned() } else { js_trim(&text_or_empty(style.and_then(|style| style.get("numberFormat")))).to_owned() }
}

fn is_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

fn year_like(values: &[f64]) -> bool {
    values.iter().all(|value| is_integer(*value) && *value >= 1900.0 && *value <= 2100.0)
}

/// `n.toLocaleString('en-US')` of an integer: digit groups of three.
fn grouped(value: f64) -> String {
    let digits = number_to_string(value.abs());
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    if value < 0.0 { format!("-{grouped}") } else { grouped }
}

fn column_format_key(column: f64, format: &str) -> String {
    format!("{}|{format}", number_to_string(column))
}

fn numbers_by_column_format(cells: &[Value]) -> HashMap<String, Vec<f64>> {
    let mut by_column_format: HashMap<String, Vec<f64>> = HashMap::new();
    for cell in cells {
        if truthy(cell.get("formula")) {
            continue;
        }
        let (Some(value), Some(at)) = (numeric_value(cell), position(cell)) else {
            continue;
        };
        by_column_format.entry(column_format_key(at.column, &format_key(cell.get("style")))).or_default().push(value);
    }
    by_column_format
}

fn audit_formula_hygiene(list: &mut IssueList, cell: &Value, path: &str, sheet_names: &[String], external_names: &[String]) {
    let formula = text_or_empty(cell.get("formula"));
    for name in unquoted_sheet_references(&formula, sheet_names) {
        list.push(
            "warning",
            "unquoted_sheet_reference",
            path,
            format!("Formula references sheet \"{name}\" without quotes; Excel evaluates it as #VALUE! or #NAME?. Write '{name}'!."),
        );
    }
    if external_link_reference(&formula) {
        list.push(
            "warning",
            "external_link_reference",
            path,
            "Formula links to another workbook; only its cached value is available here, and recalculation would replace the link with #NAME?. Copy the value into a sourced input cell instead.",
        );
        return;
    }
    let name = external_name_read(&formula, external_names);
    if !name.is_empty() {
        list.push(
            "warning",
            "external_link_reference",
            path,
            format!(
                "Formula reads {name}, a defined name that links to another workbook; only its cached value is available here, and recalculation would replace the link with #NAME?. Copy the value into a sourced input cell and point the name or the formula at it."
            ),
        );
    }
}

/// `auditSheetHygiene(list, sheet, cells, sheetNames, externalNames)`.
pub fn audit_sheet_hygiene(list: &mut IssueList, sheet: &Value, cells: &[Value], sheet_names: &[String], external_names: &[String]) {
    let display = merged_areas(sheet);
    let by_column_format = numbers_by_column_format(cells);
    for cell in cells {
        let path = cell_path(sheet, cell);
        // A figure typed as text in a merged banner or metric tile is the label it was written as; only a grid cell has a
        // column to sum or sort.
        if numeric_text(cell) && !(!display.is_empty() && inside_area(&display, &position(cell).unwrap_or(Position { row: 0.0, column: 0.0 }))) {
            let text = cell.get("value").and_then(Value::as_str).map_or("", js_trim);
            list.push(
                "warning",
                "number_stored_as_text",
                path,
                format!("\"{text}\" is text, so it neither sums nor sorts as a number; store the number and give the column a format."),
            );
            continue;
        }
        if truthy(cell.get("formula")) {
            audit_formula_hygiene(list, cell, &path, sheet_names, external_names);
            continue;
        }
        let Some(value) = numeric_value(cell) else {
            continue;
        };
        let style = cell.get("style");
        if percent_format(style) && value.abs() >= 10.0 {
            list.push(
                "warning",
                "percentage_stored_as_whole",
                path.clone(),
                format!(
                    "Cell shows {shown}% × 100: a percentage is stored as a fraction (0.15 renders 15.0%), so {shown} renders {scaled}%.",
                    shown = number_to_string(value),
                    scaled = number_to_string(value * 100.0)
                ),
            );
        }
        if thousands_format(style) && is_integer(value) && (1900.0..=2100.0).contains(&value) {
            let beside =
                position(cell).and_then(|at| by_column_format.get(&column_format_key(at.column, &format_key(style)))).cloned().unwrap_or_else(|| vec![value]);
            if year_like(&beside) {
                list.push(
                    "warning",
                    "year_with_thousands_separator",
                    path,
                    format!(
                        "Year {year} renders as {shown} under a thousands-separator format; store years as text or format them 0.",
                        year = number_to_string(value),
                        shown = grouped(value)
                    ),
                );
            }
        }
    }
}

/// The body columns of a table that drift from the column's majority format, and the all-numeric ones left under General.
struct TableFormats {
    unformatted: Vec<String>,
    drifted: Vec<Drift>,
}

struct Drift {
    column: String,
    dominant: String,
    refs: Vec<String>,
}

/// Each all-numeric body column of a table: the ones whose format drifts from the column's majority, and the ones left
/// under General.
fn table_column_formats(located: &[Located<'_>], area: &Area) -> TableFormats {
    let mut formats = TableFormats { unformatted: Vec::new(), drifted: Vec::new() };
    let mut column = area.start_col;
    while column <= area.end_col {
        let current = column;
        column += 1.0;
        let body: Vec<&Located<'_>> =
            located.iter().filter(|entry| entry.at.column == current && entry.at.row > area.start_row && entry.at.row <= area.end_row).collect();
        let numbers: Vec<(&Located<'_>, f64)> = body
            .iter()
            .filter(|entry| entry.cell.get("dataType").and_then(Value::as_str) != Some("text"))
            .filter_map(|entry| numeric_value(entry.cell).map(|value| (*entry, value)))
            .collect();
        if numbers.len() < NUMERIC_COLUMN_MIN || numbers.len() < body.len() {
            continue;
        }
        let mut tally: Vec<(String, usize)> = Vec::new();
        for (entry, _) in &numbers {
            let key = format_key(entry.cell.get("style"));
            match tally.iter_mut().find(|(seen, _)| *seen == key) {
                Some((_, count)) => *count += 1,
                None => tally.push((key, 1)),
            }
        }
        if tally.len() > 1 {
            let (dominant, count) = tally
                .iter()
                .fold(None::<&(String, usize)>, |best, next| match best {
                    Some(best) if best.1 >= next.1 => Some(best),
                    _ => Some(next),
                })
                .cloned()
                .expect("a tally holds a format");
            if count as f64 / numbers.len() as f64 >= FORMAT_MAJORITY {
                formats.drifted.push(Drift {
                    column: column_label(current),
                    refs: numbers
                        .iter()
                        .filter(|(entry, _)| format_key(entry.cell.get("style")) != dominant)
                        .map(|(entry, _)| text_or_empty(entry.cell.get("ref")).to_uppercase())
                        .collect(),
                    dominant,
                });
            }
        }
        if !numbers.iter().all(|(entry, _)| general_format(entry.cell.get("style"))) {
            continue;
        }
        let values: Vec<f64> = numbers.iter().map(|(_, value)| *value).collect();
        if year_like(&values) {
            continue;
        }
        formats.unformatted.push(column_label(current));
    }
    formats
}

fn audit_unfrozen_header(list: &mut IssueList, sheet: &Value, located: &[Located<'_>]) {
    // The Office reader cuts a sheet to its first 500 cells but still names the sheet's last row.
    let read_last = located.iter().fold(f64::NEG_INFINITY, |last, entry| last.max(entry.at.row));
    let named_last = to_number_of(sheet.get("lastRow"));
    let last_row = if truthy(sheet.get("truncated")) && named_last > read_last { named_last } else { read_last };
    let header_row = located.iter().fold(f64::INFINITY, |first, entry| first.min(entry.at.row));
    let headers = located.iter().filter(|entry| entry.at.row == header_row && entry.cell.get("dataType").and_then(Value::as_str) == Some("text")).count();
    if last_row - header_row >= LONG_SHEET_ROWS && headers >= 2 {
        list.push(
            "info",
            "header_not_frozen",
            sheet_path(sheet),
            format!(
                "{} rows scroll under an unfrozen header row; freeze_panes row:{} keeps the headers in view.",
                number_to_string(last_row - header_row),
                number_to_string(header_row + 1.0)
            ),
        );
    }
}

/// `auditSheetLayout(list, sheet, cells)`.
pub fn audit_sheet_layout(list: &mut IssueList, sheet: &Value, cells: &[Value]) {
    let located = locate(cells);
    if located.is_empty() {
        return;
    }
    if let Some(freeze) = sheet.get("freezePanes").filter(|freeze| freeze.is_object())
        && freeze.get("frozen") == Some(&Value::Bool(false))
    {
        audit_unfrozen_header(list, sheet, &located);
    }
    for (index, table_area) in table_areas(sheet).iter().enumerate() {
        let formats = table_column_formats(&located, &table_area.area);
        let table_path = match table_area.table.get("path") {
            path if truthy(path) => text_or_empty(path),
            _ => format!("{}/table[{}]", sheet_path(sheet), index + 1),
        };
        let name = match table_area.table.get("name") {
            name if truthy(name) => text_or_empty(name),
            _ => "the table".to_owned(),
        };
        for drift in &formats.drifted {
            list.push(
                "warning",
                "number_format_inconsistent",
                table_path.clone(),
                format!(
                    "Column {} of {name} carries {} under a format its other rows do not use ({}); one column shows one quantity one way, or the same figure reads two ways down the page.",
                    drift.column,
                    drift.refs.iter().take(3).cloned().collect::<Vec<_>>().join(", "),
                    drift.dominant
                ),
            );
        }
        // One table, one finding: repeating it per column produced entries a reader cannot tell apart, since they all
        // carry the table's own path.
        if formats.unformatted.is_empty() {
            continue;
        }
        list.push(
            "info",
            "numeric_column_unformatted",
            table_path,
            format!(
                "Column{} {} of {name} hold numbers under the General format; an explicit format (#,##0, 0.0%, yyyy-mm-dd) aligns the figures and names their unit.",
                if formats.unformatted.len() > 1 { "s" } else { "" },
                formats.unformatted.join(", ")
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::xlsx_audit_support::list;
    use serde_json::json;

    fn issues(sheet: &Value, names: &[&str]) -> Vec<(String, String)> {
        let mut found = IssueList::new();
        let cells = list(sheet.get("cells"));
        let names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
        audit_sheet_hygiene(&mut found, sheet, cells, &names, &[]);
        found.issues.iter().map(|issue| (issue.code.to_owned(), issue.path.clone())).collect()
    }

    #[test]
    fn hygiene_reports_the_codes_of_node() {
        let sheet = json!({ "name": "Data", "cells": [
            { "ref": "A1", "dataType": "text", "value": "1,200" },
            { "ref": "B1", "formula": "=My Sheet!B2+[1]Rates!A1" },
            { "ref": "C1", "value": 15, "style": { "numberFormat": "0.0%" } },
            { "ref": "D1", "value": 2024, "style": { "numberFormat": "#,##0" } },
        ] });
        let found = issues(&sheet, &["My Sheet"]);
        let codes: Vec<&str> = found.iter().map(|(code, _)| code.as_str()).collect();
        assert_eq!(
            codes,
            ["number_stored_as_text", "unquoted_sheet_reference", "external_link_reference", "percentage_stored_as_whole", "year_with_thousands_separator"]
        );
        assert_eq!(found[0].1, "/sheet[Data]/cell[A1]");
    }

    #[test]
    fn a_year_beside_a_quantity_is_not_a_year() {
        let sheet = json!({ "name": "S", "cells": [
            { "ref": "A1", "value": 2096, "style": { "numberFormat": "#,##0" } },
            { "ref": "A2", "value": 40, "style": { "numberFormat": "#,##0" } },
        ] });
        assert!(issues(&sheet, &[]).is_empty());
    }

    #[test]
    fn external_names_and_grouping() {
        let names = external_defined_names(&[json!({ "name": "Rate", "refersTo": "=[1]Rates!$A$1" }), json!({ "name": "Local", "refersTo": "=Data!$A$1" })]);
        assert_eq!(names, ["Rate"]);
        assert_eq!(external_name_read("=Rate*B2", &names), "Rate");
        assert_eq!(external_name_read("=XRate*B2", &names), "");
        assert_eq!(grouped(2096.0), "2,096");
    }

    #[test]
    fn a_long_sheet_with_an_unfrozen_header_is_reported() {
        let mut cells = vec![json!({ "ref": "A1", "dataType": "text", "value": "a" }), json!({ "ref": "B1", "dataType": "text", "value": "b" })];
        cells.push(json!({ "ref": "A30", "value": 1 }));
        let sheet = json!({ "name": "Long", "freezePanes": { "frozen": false }, "cells": cells });
        let mut found = IssueList::new();
        audit_sheet_layout(&mut found, &sheet, list(sheet.get("cells")));
        assert_eq!(found.issues.len(), 1);
        assert!(found.issues[0].message.starts_with("29 rows scroll under an unfrozen header row; freeze_panes row:2"));
    }
}
