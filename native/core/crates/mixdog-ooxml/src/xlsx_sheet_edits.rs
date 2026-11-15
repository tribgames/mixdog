//! `portable/portable-xlsx-sheet-edits.mjs`: the cell, range, view and workbook-level edits the xlsx backend applies to one
//! worksheet. Every edit takes the sheet's current XML and answers the operation's result; the dispatcher in [`crate::xlsx`]
//! owns the loop. Values and arguments are the JSON of the operation, read with JavaScript's coercions.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_fsio::ReadProof;
use mixdog_js::{
    JsRegex, js_to_lowercase, js_trim, json_number, math, number_to_string, slice_utf16, string_to_number, to_number_of, value_to_string,
};
use mixdog_office_base::a1::{column_label, column_number, parse_cell_ref};
use serde_json::{Map, Value, json};

use crate::cells::{
    CellEntry, CellStyle, CellValue, Sheet, cell_records, cell_style_indexes, expand_range, set_cell_in_sheet, set_cell_styles_in_sheet,
    set_cells_in_sheet, shared_strings,
};
use crate::opc::{
    add_package_relationship, ensure_content_type_override, part_from_target, part_relationship_path, posix, provenance_citation,
    relationship_target_by_type,
};
use crate::sheet_page::{column_file_width, workbook_digit_width};
use crate::sheet_parts::{NoteRequest, excel_password_hash, write_worksheet_note};
use crate::sheet_styles::{apply_cell_style, style_has_number_format};
use crate::sheet_xml::{
    area_reference, compose_sheet_view, freeze_pane_xml, merged_cell_anchor, merged_ranges, parse_area_range, safe_workbook_table_name,
    sheet_view_parts, update_sheet_view, upsert_defined_name, upsert_worksheet_section, workbook_defined_name_fault, worksheet_section,
    write_column_visibility, write_column_widths, write_merged_ranges,
};
use crate::text_metrics::TextMeasurer;
use crate::xlsx_audit_support::{js_text, text_or_empty, text_or_empty_nullish, truthy};
use crate::xlsx_contract::normalize_xlsx_formula;
use crate::xlsx_operations::{
    MAX_STYLED_CELLS, TABLE_CONTENT_TYPE, WORKBOOK_PATH, WORKSHEET_CONTENT_TYPE, WORKSHEET_RELATIONSHIP, assert_worksheet_name, next_sheet_id,
    replace_first, table_style_info_xml,
};
use crate::xlsx_reference_shift::{ShiftRequest, copied_sheet_xml, copy_sheet_parts, inherited_rows, shift_worksheet_cells};
use crate::xml::{
    OFFICE_RELATIONSHIP_BASE, SPREADSHEET_MAIN, XML_HEADER, compiled, container_body, replace_across_runs, set_xml_attribute, tag_pattern,
    xml_attribute, xml_encode,
};
use crate::zipio::Package;

type Op = Map<String, Value>;

static ISO_DATE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(\d{4})-(\d{2})-(\d{2})$", ""));
static PLAIN_NUMBER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d+)?|\.\d+)$", ""));
static GROUPED_NUMBER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[+-]?[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$", ""));
static PANE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<pane\b[^>]*?(?:\/>|>[\s\S]*?<\/pane>)", ""));
static STATE_ATTRIBUTE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\s*\bstate="[^"]*""#, ""));
static SELF_CLOSING_END: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\/>$", ""));
static SHEET_SELF_CLOSING: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<sheet\b[^>]*\/>", "g"));
static HIDDEN_STATE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bstate="(?:hidden|veryHidden)""#, ""));
static ROW_NUMBER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"<row\b[^>]*\br="(\d+)"[^>]*?(?:\/>|>)"#, "g"));
static EMPTY_SHEET_DATA: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<sheetData\b([^>]*?)\/>", ""));
static HEIGHT_ATTRIBUTES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\s*\b(?:ht|customHeight)="[^"]*""#, "g"));
static TAG_END: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"(\/?>)$", ""));
static HIDDEN_ATTRIBUTE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\s*\bhidden="[^"]*""#, ""));
static LETTERS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[A-Za-z]+$", ""));
static LEADING_EQUALS_RUN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^=+", ""));
static TABLE_PARTS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<tableParts\b[^>]*?(?:\/>|>[\s\S]*?<\/tableParts>)", ""));
static TABLE_PART_OPEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<tablePart\b", "g"));
const SHEETS_CLOSE: &str = "</sheets>";

fn op_name(op: &Op) -> &str {
    op.get("op").and_then(Value::as_str).unwrap_or("")
}

/// `parseCellRef(op.cell).ref`: the reference as the operation names it.
fn cell_of(op: &Op) -> Result<String, String> {
    Ok(parse_cell_ref(&js_text(op.get("cell")))?.reference)
}

/// `Number(value) || fallback`.
fn number_or(value: Option<&Value>, fallback: f64) -> f64 {
    let number = to_number_of(value);
    if number.is_nan() || number == 0.0 { fallback } else { number }
}

/// `set_cell` / `set_formula`. The flag tells the dispatcher a formula landed, so the workbook is marked for a full
/// recalculation once all edits are in.
pub fn set_worksheet_cell(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op, sheets: &[Sheet]) -> Result<(Value, bool), String> {
    let formula = if op_name(op) == "set_formula" {
        let names: Vec<String> = sheets.iter().map(|entry| entry.name.clone()).collect();
        normalize_xlsx_formula(op.get("formula").unwrap_or(&Value::Null), "mixdog-ooxml", Some(names.as_slice()))?
    } else {
        String::new()
    };
    let cell = js_text(op.get("cell"));
    let anchored = merged_cell_anchor(xml, &cell)?;
    let value = op.get("value").unwrap_or(&Value::Null);
    if formula.is_empty() && typed_entry(value).is_some() {
        write_typed_cells(zip, sheet, xml, &[(parse_cell_ref(&cell)?.reference, value.clone())])?;
    } else {
        zip.set(&sheet.path, set_cell_in_sheet(xml, &cell, value, &formula)?);
    }
    let written = text_or_empty_nullish(op.get("formula"));
    let normalized = !formula.is_empty() && formula != written.strip_prefix('=').unwrap_or(&written);
    let mut result = Map::new();
    result.insert("op".to_owned(), op.get("op").cloned().unwrap_or(Value::Null));
    result.insert("changed".to_owned(), json!(true));
    result.insert("sheet".to_owned(), json!(sheet.name));
    result.insert("cell".to_owned(), json!(parse_cell_ref(&cell)?.reference));
    if normalized {
        result.insert("normalizedFormula".to_owned(), json!(format!("={formula}")));
    }
    if !anchored {
        result.insert(
            "warning".to_owned(),
            json!("Cell is inside a merged range but is not its top-left anchor; Excel hides the value."),
        );
    }
    Ok((Value::Object(result), !formula.is_empty()))
}

/// Days from 1970-01-01 of a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn month_length(year: i64, month: i64) -> i64 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Excel types "2026-09-30" as the date it names, so the same set_range through Microsoft Office left a date in the cell and
/// here a text: `=DATEVALUE(D5)` worked on one backend and read #VALUE! on the other, and a date column sorted and summed
/// differently depending on which one wrote it. The portable writer stores the serial the way Excel does, under yyyy-mm-dd
/// unless the cell already carries a number format of its own.
fn typed_date(value: &Value) -> Option<f64> {
    let Value::String(text) = value else { return None };
    let found = ISO_DATE.captures(js_trim(text))?;
    let part = |at: usize| found.get(at).and_then(|digits| digits.parse::<i64>().ok());
    let (year, month, day) = (part(1)?, part(2)?, part(3)?);
    if year < 1900 || !(1..=12).contains(&month) || day < 1 || day > month_length(year, month) {
        return None;
    }
    Some((days_from_civil(year, month, day) - days_from_civil(1899, 12, 30)) as f64)
}

/// A figure a text types as, with the format Excel gives it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TypedNumber {
    pub value: f64,
    pub number_format: Option<&'static str>,
}

/// `typedNumber(value)`: the figures Excel types from a text as it types an entry, and the format it gives each: "1" and
/// "-500000" plain, "1,234" under `#,##0` (`#,##0.00` with decimals), "15%" as 0.15 under `0%` (`0.00%` with decimals).
/// Through Microsoft Office they arrived as numbers and here as texts the audit then called numbers stored as text. Any
/// other text stays as written on both backends: "007", "1-2", "1e3", "(100)", "TRUE" (the Excel backend keeps Excel from
/// typing them).
pub fn typed_number(value: &Value) -> Option<TypedNumber> {
    let Value::String(source) = value else { return None };
    let text = js_trim(source);
    let percent = text.ends_with('%');
    let figure = if percent { &text[..text.len() - 1] } else { text };
    let grouped = GROUPED_NUMBER.is_match(figure);
    if !grouped && !PLAIN_NUMBER.is_match(figure) {
        return None;
    }
    let places = figure.split('.').nth(1).map_or(0, str::len);
    let plain = string_to_number(&figure.replace(',', ""));
    // 92.8 / 100 is 0.9279999999999999 in binary; Excel stores the 0.928 the text wrote.
    let number = if percent { string_to_number(&math::to_fixed(plain / 100.0, places + 2)) } else { plain };
    let decimals = places > 0;
    let number_format = if percent {
        Some(if decimals { "0.00%" } else { "0%" })
    } else if grouped {
        Some(if decimals { "#,##0.00" } else { "#,##0" })
    } else {
        None
    };
    Some(TypedNumber { value: number, number_format })
}

/// A text a cell takes as a value, with the format it takes under it: an ISO date, a figure, or none for a text.
fn typed_entry(value: &Value) -> Option<TypedNumber> {
    match typed_date(value) {
        Some(serial) => Some(TypedNumber { value: serial, number_format: Some("yyyy-mm-dd") }),
        None => typed_number(value),
    }
}

/// The entries written as the values they type as, with the formats they take; answers how many of them were dates.
fn write_typed_cells(zip: &mut Package, sheet: &Sheet, xml: &str, entries: &[(String, Value)]) -> Result<usize, String> {
    let mut formatted: Vec<(&str, &'static str)> = Vec::new();
    let mut dates = 0;
    let typed: Vec<Value> = entries
        .iter()
        .map(|(reference, value)| match typed_entry(value) {
            None => value.clone(),
            Some(entered) => {
                if entered.number_format == Some("yyyy-mm-dd") {
                    dates += 1;
                }
                if let Some(format) = entered.number_format {
                    formatted.push((reference.as_str(), format));
                }
                json_number(entered.value)
            }
        })
        .collect();
    let written: Vec<CellEntry<'_>> =
        entries.iter().zip(&typed).map(|((reference, _), value)| CellEntry { reference, value, formula: "" }).collect();
    let mut next = set_cells_in_sheet(xml, &written)?;
    if !formatted.is_empty() {
        let mut styles = zip.text("xl/styles.xml");
        if !styles.is_empty() {
            let references: Vec<&str> = formatted.iter().map(|(reference, _)| *reference).collect();
            let bases: HashMap<String, u64> = cell_style_indexes(&next, &references)?.into_iter().collect();
            let mut resolved: HashMap<(u64, &str), usize> = HashMap::new();
            let mut styled: Vec<(&str, String)> = Vec::new();
            for &(reference, number_format) in &formatted {
                let base = bases.get(reference).copied().unwrap_or(0);
                // The cell's own number format stands, as Excel keeps it under a typed entry.
                if style_has_number_format(&styles, base as f64) {
                    continue;
                }
                let index = match resolved.get(&(base, number_format)) {
                    Some(index) => *index,
                    None => {
                        let mut properties = Map::new();
                        properties.insert("numberFormat".to_owned(), json!(number_format));
                        let applied = apply_cell_style(&styles, base as f64, &properties)?;
                        styles = applied.xml;
                        resolved.insert((base, number_format), applied.index);
                        applied.index
                    }
                };
                styled.push((reference, index.to_string()));
            }
            zip.set("xl/styles.xml", styles);
            if !styled.is_empty() {
                let cells: Vec<CellStyle<'_>> = styled.iter().map(|(reference, style)| CellStyle { reference, style }).collect();
                next = set_cell_styles_in_sheet(&next, &cells)?;
            }
        }
    }
    zip.set(&sheet.path, next);
    Ok(dates)
}

/// `values[row]?.[column] ?? null`.
fn element_at(row: Option<&Value>, index: usize) -> Value {
    match row {
        Some(Value::Array(items)) => items.get(index).cloned().unwrap_or(Value::Null),
        Some(Value::String(text)) => {
            let unit: Vec<u16> = text.encode_utf16().skip(index).take(1).collect();
            if unit.is_empty() { Value::Null } else { Value::String(String::from_utf16_lossy(&unit)) }
        }
        _ => Value::Null,
    }
}

/// `setWorksheetRange(zip, sheet, xml, op)`.
pub fn set_worksheet_range(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op) -> Result<Value, String> {
    let area = expand_range(&js_text(op.get("range")))?;
    let values: &[Value] = match op.get("values") {
        Some(Value::Array(rows)) => rows,
        _ => &[],
    };
    let mut entries: Vec<(String, Value)> = Vec::new();
    let mut row = area.start_row;
    while row <= area.end_row {
        let mut column = area.start_col;
        while column <= area.end_col {
            let line = values.get((row - area.start_row) as usize);
            entries.push((format!("{}{}", column_label(column), number_to_string(row)), element_at(line, (column - area.start_col) as usize)));
            column += 1.0;
        }
        row += 1.0;
    }
    let dates = write_typed_cells(zip, sheet, xml, &entries)?;
    let mut result = Map::new();
    result.insert("op".to_owned(), op.get("op").cloned().unwrap_or(Value::Null));
    result.insert("changed".to_owned(), json!(true));
    result.insert("sheet".to_owned(), json!(sheet.name));
    if let Some(range) = op.get("range") {
        result.insert("range".to_owned(), range.clone());
    }
    if dates > 0 {
        result.insert("dates".to_owned(), json!(dates));
    }
    Ok(Value::Object(result))
}

/// `appendWorksheetRow(zip, sheet, xml, op)`: the appended row takes the last row's formatting (its cells' number formats,
/// fonts, fills and borders, its height) as an inserted row takes the row above's; written into bare cells, 1,200 arrived as
/// 1200 under a table of #,##0.
pub fn append_worksheet_row(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op) -> Result<Value, String> {
    let cells = cell_records(xml, &shared_strings(zip), None);
    let mut max_row = 0_u64;
    for cell in &cells {
        max_row = max_row.max(parse_cell_ref(&cell.reference)?.row);
    }
    let row = max_row + 1;
    let values: &[Value] = match op.get("values") {
        Some(Value::Array(values)) => values,
        Some(value) if truthy(Some(value)) => return Err("(intermediate value).map is not a function".to_owned()),
        _ => &[],
    };
    let entries: Vec<(String, Value)> =
        values.iter().enumerate().map(|(index, value)| (format!("{}{row}", column_label((index + 1) as f64)), value.clone())).collect();
    write_typed_cells(zip, sheet, &inherited_rows(xml, row as i64, 1)?, &entries)?;
    Ok(json!({ "op": op.get("op"), "changed": true, "sheet": sheet.name, "row": row }))
}

/// `clearWorksheetCell(zip, sheet, xml, op)`.
pub fn clear_worksheet_cell(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op) -> Result<Value, String> {
    let reference = cell_of(op)?;
    let pattern = compiled(&format!(r#"<c\b[^>]*\br="{reference}"[^>]*(?:(?<!\/)>[\s\S]*?</c>|/>)"#), "i");
    let changed = pattern.is_match(xml);
    if changed {
        zip.set(&sheet.path, replace_first(&pattern, xml, |_| String::new()));
    }
    Ok(json!({ "op": op.get("op"), "changed": changed, "sheet": sheet.name, "cell": reference }))
}

/// `replaceWorkbookText(zip, sheets, op)`: replace_text runs over every sheet and the shared-string table, not just the
/// addressed sheet.
pub fn replace_workbook_text(zip: &mut Package, sheets: &[Sheet], op: &Op) -> Result<Value, String> {
    let find = if truthy(op.get("find")) { js_text(op.get("find")) } else { String::new() };
    let replacement = text_or_empty_nullish(op.get("replace"));
    let mut count = 0;
    for candidate in sheets {
        let current = zip.text(&candidate.path);
        let replaced = replace_across_runs(&current, "t", &find, &replacement)?;
        if replaced.count > 0 {
            zip.set(&candidate.path, replaced.xml);
        }
        count += replaced.count;
    }
    let shared = zip.text("xl/sharedStrings.xml");
    if !shared.is_empty() {
        let replaced = replace_across_runs(&shared, "t", &find, &replacement)?;
        if replaced.count > 0 {
            zip.set("xl/sharedStrings.xml", replaced.xml);
        }
        count += replaced.count;
    }
    Ok(json!({ "op": op.get("op"), "changed": count > 0, "count": count }))
}

/// `setWorksheetStyle(zip, sheet, xml, op)`.
pub fn set_worksheet_style(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op) -> Result<Value, String> {
    let target = if truthy(op.get("range")) { op.get("range") } else { op.get("cell") };
    if !truthy(target) {
        return Err("set_style requires cell or range".to_owned());
    }
    let area = parse_area_range(&js_text(target))?;
    if area.start_row == 0.0 || area.start_col == 0.0 {
        return Err("set_style requires a bounded cell or range such as A1 or A1:D5".to_owned());
    }
    let covered = (area.end_row - area.start_row + 1.0) * (area.end_col - area.start_col + 1.0);
    if covered > MAX_STYLED_CELLS {
        return Err(format!("set_style covers {} cells; narrow the range to at most {}", number_to_string(covered), number_to_string(MAX_STYLED_CELLS)));
    }
    let mut styles = zip.text("xl/styles.xml");
    if styles.is_empty() {
        return Err("Workbook is missing xl/styles.xml".to_owned());
    }
    let mut references: Vec<String> = Vec::new();
    let mut row = area.start_row;
    while row <= area.end_row {
        let mut column = area.start_col;
        while column <= area.end_col {
            references.push(format!("{}{}", column_label(column), number_to_string(row)));
            column += 1.0;
        }
        row += 1.0;
    }
    let listed: Vec<&str> = references.iter().map(String::as_str).collect();
    let bases: HashMap<String, u64> = cell_style_indexes(xml, &listed)?.into_iter().collect();
    let properties = match op.get("properties") {
        Some(Value::Object(properties)) => properties.clone(),
        _ => Map::new(),
    };
    let mut resolved: HashMap<u64, usize> = HashMap::new();
    let mut styled: Vec<(&str, String)> = Vec::new();
    for reference in listed.iter().copied() {
        let base = bases.get(reference).copied().unwrap_or(0);
        let index = match resolved.get(&base) {
            Some(index) => *index,
            None => {
                let applied = apply_cell_style(&styles, base as f64, &properties)?;
                styles = applied.xml;
                resolved.insert(base, applied.index);
                applied.index
            }
        };
        styled.push((reference, index.to_string()));
    }
    zip.set("xl/styles.xml", styles);
    let cells: Vec<CellStyle<'_>> = styled.iter().map(|(reference, style)| CellStyle { reference, style }).collect();
    zip.set(&sheet.path, set_cell_styles_in_sheet(xml, &cells)?);
    Ok(json!({ "op": op.get("op"), "changed": covered > 0.0, "sheet": sheet.name, "cells": json_number(covered) }))
}

/// `mergeWorksheetCells(zip, sheet, xml, op)`: merge_cells / unmerge_cells.
pub fn merge_worksheet_cells(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op) -> Result<Value, String> {
    let area = parse_area_range(&text_or_empty(op.get("range")))?;
    if area.start_row == 0.0 || area.start_col == 0.0 {
        return Err(format!("{} requires a bounded range such as A1:D1", op_name(op)));
    }
    let reference = area_reference(&area);
    let current = merged_ranges(xml);
    let next: Vec<String> = if op_name(op) == "merge_cells" {
        current.iter().cloned().chain([reference.clone()]).collect()
    } else {
        current.iter().filter(|entry| **entry != reference).cloned().collect()
    };
    let distinct = |list: &[String]| list.iter().collect::<std::collections::HashSet<_>>().len();
    let changed = distinct(&next) != distinct(&current);
    zip.set(&sheet.path, write_merged_ranges(xml, &next));
    Ok(json!({ "op": op.get("op"), "changed": changed, "sheet": sheet.name, "range": reference }))
}

/// `freezeWorksheetPanes(zip, sheet, xml, op)`.
pub fn freeze_worksheet_panes(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op) -> Result<Value, String> {
    let pane = freeze_pane_xml(to_number_of(op.get("row")), to_number_of(op.get("column")));
    let before = PANE.find(xml).map_or("", |range| &xml[range]);
    let next = update_sheet_view(xml, |view| {
        let parts = sheet_view_parts(view)?;
        let stripped = replace_first(&PANE, &parts.body, |_| String::new());
        Ok(compose_sheet_view(&parts.attrs, &format!("{pane}{stripped}")))
    })?;
    zip.set(&sheet.path, next);
    let frozen_rows = math::max(0.0, number_or(op.get("row"), 0.0) - 1.0);
    let frozen_columns = math::max(0.0, number_or(op.get("column"), 0.0) - 1.0);
    let mut result = Map::new();
    result.insert("op".to_owned(), op.get("op").cloned().unwrap_or(Value::Null));
    result.insert("changed".to_owned(), json!(before != pane));
    result.insert("sheet".to_owned(), json!(sheet.name));
    result.insert("frozen".to_owned(), json!(!pane.is_empty()));
    result.insert("frozenRows".to_owned(), json_number(frozen_rows));
    result.insert("frozenColumns".to_owned(), json_number(frozen_columns));
    // row and column name the first cell that scrolls, as Excel freezes at the selected cell; a caller who meant "freeze row
    // 1" with row:1 froze nothing.
    if pane.is_empty() {
        result.insert(
            "note".to_owned(),
            json!("Nothing is frozen: row and column name the first row and column that scroll, so row:2 keeps row 1 in view."),
        );
    }
    Ok(Value::Object(result))
}

/// `setWorksheetView(zip, sheet, xml, op)`.
pub fn set_worksheet_view(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op) -> Result<Value, String> {
    let updated = update_sheet_view(xml, |view| {
        let parts = sheet_view_parts(view)?;
        let mut next = parts.attrs;
        if !matches!(op.get("showGridlines"), None | Some(Value::Null)) {
            next = set_xml_attribute(&next, "showGridLines", if op.get("showGridlines") == Some(&Value::Bool(true)) { "1" } else { "0" });
        }
        if !matches!(op.get("zoom"), None | Some(Value::Null)) {
            let zoom = math::min(400.0, math::max(10.0, math::round(number_or(op.get("zoom"), 100.0))));
            next = set_xml_attribute(&next, "zoomScale", &number_to_string(zoom));
            next = set_xml_attribute(&next, "zoomScaleNormal", &number_to_string(zoom));
        }
        Ok(compose_sheet_view(&next, &parts.body))
    })?;
    zip.set(&sheet.path, updated);
    Ok(json!({ "op": op.get("op"), "changed": true, "sheet": sheet.name }))
}

/// `shiftWorksheetRowsOrColumns(zip, sheet, xml, op, sheets)`: insert_rows / delete_rows / insert_columns / delete_columns:
/// Excel's insert and delete, references included.
pub fn shift_worksheet_rows_or_columns(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op, sheets: &[Sheet]) -> Result<Value, String> {
    let amount = math::max(1.0, number_or(op.get("count"), 1.0));
    let name = op_name(op);
    let rows = name.ends_with("rows");
    let from = math::max(1.0, number_or(op.get(if rows { "row" } else { "column" }), 1.0));
    let insert = name.starts_with("insert");
    let rewritten = shift_worksheet_cells(zip, sheets, sheet, xml, ShiftRequest { rows, from: from as i64, amount: amount as i64, insert, op: name })?;
    Ok(json!({
        "op": op.get("op"),
        "changed": true,
        "sheet": sheet.name,
        "from": json_number(from),
        "count": json_number(amount),
        "referenceAware": true,
        "referencesRewritten": rewritten,
    }))
}

/// `setWorksheetAutofilter(zip, sheet, xml, op)`.
pub fn set_worksheet_autofilter(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op) -> Result<Value, String> {
    let enabled = op.get("enabled") != Some(&Value::Bool(false));
    let next = if enabled {
        let reference = area_reference(&parse_area_range(&text_or_empty(op.get("range")))?);
        upsert_worksheet_section(xml, "autoFilter", &format!("<autoFilter ref=\"{reference}\"/>"))
    } else {
        upsert_worksheet_section(xml, "autoFilter", "")
    };
    zip.set(&sheet.path, next);
    Ok(json!({ "op": op.get("op"), "changed": true, "sheet": sheet.name, "enabled": enabled }))
}

/// `setWorksheetVisibility(zip, sheet, xml, op)`: rows and columns are hidden with visible: true/false, so the same word must
/// work on a sheet rather than costing a round trip.
pub fn set_worksheet_visibility(zip: &mut Package, sheet: &Sheet, op: &Op) -> Result<Value, String> {
    let requested = match (op.get("visibility"), op.get("visible")) {
        (Some(value), _) if !value.is_null() => value_to_string(value),
        (_, Some(Value::Bool(visible))) => (if *visible { "visible" } else { "hidden" }).to_owned(),
        _ => String::new(),
    };
    let visibility = js_to_lowercase(&requested);
    let state = match visibility.as_str() {
        "visible" => "visible",
        "hidden" => "hidden",
        "very_hidden" => "veryHidden",
        _ => return Err("set_sheet_visibility needs visibility: visible, hidden, or very_hidden (or visible: true/false)".to_owned()),
    };
    let workbook = zip.text(WORKBOOK_PATH);
    let pattern = compiled(&format!(r#"<sheet\b[^>]*\bname="{}"[^>]*\/>"#, tag_pattern(&xml_encode(&sheet.name))), "i");
    let Some(found) = pattern.find(&workbook) else {
        return Err(format!("Worksheet not found: {}", sheet.name));
    };
    if state != "visible" {
        let visible = SHEET_SELF_CLOSING.find_iter(&workbook).filter(|entry| !HIDDEN_STATE.is_match(&workbook[entry.clone()])).count();
        if visible <= 1 {
            return Err("A workbook must keep at least one visible worksheet".to_owned());
        }
    }
    let entry = &workbook[found.clone()];
    let bare = replace_first(&STATE_ATTRIBUTE, entry, |_| String::new());
    let attributes = if state == "visible" { bare } else { replace_first(&SELF_CLOSING_END, &bare, |_| format!(" state=\"{state}\"/>")) };
    zip.set(WORKBOOK_PATH, format!("{}{attributes}{}", &workbook[..found.start], &workbook[found.end..]));
    Ok(json!({ "op": op.get("op"), "changed": true, "sheet": sheet.name, "visibility": visibility }))
}

/// The opening tag of a row rewritten by `transform`; a row with no element yet gets one (in row order) when `create` is set,
/// since an empty row still carries its height or its hidden state.
fn rewrite_row_tag(xml: &str, row: f64, transform: &dyn Fn(&str) -> String, create: bool) -> Result<String, String> {
    let existing = compiled(&format!(r#"<row\b[^>]*\br="{}"[^>]*?(?:/>|>)"#, number_to_string(row)), "");
    if let Some(found) = existing.find(xml) {
        return Ok(format!("{}{}{}", &xml[..found.start], transform(&xml[found.clone()]), &xml[found.end..]));
    }
    if !create {
        return Ok(xml.to_owned());
    }
    let mut next = xml.to_owned();
    let later = ROW_NUMBER.captures_iter(&next).find(|found| string_to_number(found.get(1).unwrap_or("")) > row).map(|found| found.range().start);
    let mut anchor = later.or_else(|| next.find("</sheetData>"));
    if anchor.is_none() {
        // A sheet with no rows yet carries <sheetData/> (what add_sheet writes) and the row still has to go inside it.
        let Some(empty) = EMPTY_SHEET_DATA.captures(&next) else {
            return Err("Worksheet has no sheetData to write a row in".to_owned());
        };
        let range = empty.range();
        let opening = format!("<sheetData{}>", empty.get(1).unwrap_or(""));
        next = format!("{}{opening}</sheetData>{}", &next[..range.start], &next[range.end..]);
        anchor = Some(range.start + opening.len());
    }
    let anchor = anchor.unwrap_or(0);
    Ok(format!("{}{}{}", &next[..anchor], transform(&format!("<row r=\"{}\"/>", number_to_string(row))), &next[anchor..]))
}

fn row_or_column_start(op: &Op, rows: bool) -> f64 {
    if rows {
        return math::round(to_number_of(op.get("row")));
    }
    if let Some(Value::String(column)) = op.get("column")
        && LETTERS.is_match(js_trim(column))
    {
        return column_number(&js_trim(column).to_uppercase());
    }
    math::round(to_number_of(op.get("column")))
}

fn targets_of(start: f64, op: &Op) -> Vec<f64> {
    let count = math::max(1.0, math::round(number_or(op.get("count"), 1.0)));
    (0..count as u64).map(|index| start + index as f64).collect()
}

/// `setRowHeightOrColumnWidth(zip, sheet, xml, op)`: a report is laid out by its row heights and column widths: a merged title
/// band never grows to its wrapped lines in Excel or LibreOffice, so the title was cut at 15 pt, and a gutter column could not
/// be made narrow. Heights are points (Excel's 0-409), widths Excel's characters (0-255), the units the snapshot reports.
pub fn set_row_height_or_column_width<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    zip: &mut Package,
    sheet: &Sheet,
    xml: &str,
    op: &Op,
) -> Result<Value, String> {
    let rows = op_name(op) == "set_row_height";
    let start = row_or_column_start(op, rows);
    if !start.is_finite() || start < 1.0 {
        return Err(
            if rows { "set_row_height requires row (1-based)" } else { "set_column_width requires column (a letter such as D, or a 1-based number)" }
                .to_owned(),
        );
    }
    let size = to_number_of(op.get(if rows { "height" } else { "width" }));
    let limit = if rows { 409.0 } else { 255.0 };
    if !size.is_finite() || size < 0.0 || size > limit {
        return Err(
            if rows { "set_row_height requires height in points, 0-409" } else { "set_column_width requires width in characters, 0-255" }.to_owned(),
        );
    }
    let targets = targets_of(start, op);
    let mut next = xml.to_owned();
    if rows {
        let height = number_to_string(math::round(size * 100.0) / 100.0);
        for row in &targets {
            next = rewrite_row_tag(
                &next,
                *row,
                &|tag: &str| {
                    let stripped = HEIGHT_ATTRIBUTES.replace_all_with(tag, |_| String::new());
                    replace_first(&TAG_END, &stripped, |end| format!(" ht=\"{height}\" customHeight=\"1\"{end}"))
                },
                true,
            )?;
        }
    } else {
        let stored = column_file_width(size, workbook_digit_width(measurer, zip)?);
        let widths: Vec<(u32, f64)> = targets.iter().map(|column| (*column as u32, stored)).collect();
        next = write_column_widths(&next, &widths);
    }
    zip.set(&sheet.path, next);
    let mut result = Map::new();
    result.insert("op".to_owned(), op.get("op").cloned().unwrap_or(Value::Null));
    result.insert("changed".to_owned(), json!(true));
    result.insert("sheet".to_owned(), json!(sheet.name));
    result.insert(if rows { "rows" } else { "columns" }.to_owned(), Value::Array(targets.iter().map(|target| json_number(*target)).collect()));
    result.insert(if rows { "height" } else { "width" }.to_owned(), json_number(size));
    Ok(Value::Object(result))
}

/// `setRowOrColumnVisibility(zip, sheet, xml, op)`: hiding a row or a column is how a sheet withholds a working note or a
/// filtered record without deleting it; the snapshot reports the same state back as hiddenRows / hiddenColumns.
pub fn set_row_or_column_visibility(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op) -> Result<Value, String> {
    let Some(Value::Bool(visible)) = op.get("visible") else {
        return Err(format!("{} requires visible: true or false", op_name(op)));
    };
    let visible = *visible;
    let rows = op_name(op) == "set_row_visibility";
    let start = row_or_column_start(op, rows);
    if !start.is_finite() || start < 1.0 {
        return Err(if rows {
            "set_row_visibility requires row (1-based)"
        } else {
            "set_column_visibility requires column (a letter such as D, or a 1-based number)"
        }
        .to_owned());
    }
    let targets = targets_of(start, op);
    let mut next = xml.to_owned();
    if rows {
        for row in &targets {
            next = rewrite_row_tag(
                &next,
                *row,
                &|tag: &str| {
                    let stripped = replace_first(&HIDDEN_ATTRIBUTE, tag, |_| String::new());
                    if visible { stripped } else { replace_first(&TAG_END, &stripped, |end| format!(" hidden=\"1\"{end}")) }
                },
                // An empty row still hides, and Excel needs the element to record it.
                !visible,
            )?;
        }
    } else {
        let columns: Vec<u32> = targets.iter().map(|column| *column as u32).collect();
        next = write_column_visibility(&next, &columns, visible);
    }
    zip.set(&sheet.path, next);
    let mut result = Map::new();
    result.insert("op".to_owned(), op.get("op").cloned().unwrap_or(Value::Null));
    result.insert("changed".to_owned(), json!(true));
    result.insert("sheet".to_owned(), json!(sheet.name));
    result.insert("visible".to_owned(), json!(visible));
    if rows {
        result.insert("rows".to_owned(), Value::Array(targets.iter().map(|target| json_number(*target)).collect()));
    } else {
        result.insert("columns".to_owned(), Value::Array(targets.iter().map(|target| json!(column_label(*target))).collect()));
    }
    Ok(Value::Object(result))
}

/// `defineWorkbookName(zip, op)`: define_name / delete_name.
pub fn define_workbook_name(zip: &mut Package, op: &Op) -> Result<Value, String> {
    let name = js_trim(&text_or_empty(op.get("name"))).to_owned();
    if name.is_empty() {
        return Err(format!("{} requires name", op_name(op)));
    }
    let fault = if op_name(op) == "define_name" { workbook_defined_name_fault(&name) } else { String::new() };
    if !fault.is_empty() {
        return Err(format!("Excel refuses the defined name \"{name}\": {fault}."));
    }
    let workbook = zip.text(WORKBOOK_PATH);
    let matches = |item: &str| xml_attribute(item, "name") == name;
    if op_name(op) == "delete_name" {
        let next = upsert_defined_name(&workbook, None, matches);
        zip.set(WORKBOOK_PATH, next.clone());
        return Ok(json!({ "op": op.get("op"), "changed": next != workbook, "name": name }));
    }
    // The formula as the file stores it, without the = Excel's Name Manager shows and Names.Add takes: kept, the workbook was
    // one Excel refused to open at all.
    let refers_to = LEADING_EQUALS_RUN.replace_all_with(js_trim(&text_or_empty(op.get("refersTo"))), |_| String::new());
    if refers_to.is_empty() {
        return Err("define_name requires refersTo".to_owned());
    }
    let entry = format!("<definedName name=\"{}\">{}</definedName>", xml_encode(&name), xml_encode(&refers_to));
    zip.set(WORKBOOK_PATH, upsert_defined_name(&workbook, Some(&entry), matches));
    Ok(json!({ "op": op.get("op"), "changed": true, "name": name, "refersTo": format!("={refers_to}") }))
}

/// `addWorksheetNote(zip, sheet, xml, op)`: add_note / add_provenance.
pub fn add_worksheet_note(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op) -> Result<Value, String> {
    let provenance = op_name(op) == "add_provenance";
    let text = if provenance { provenance_citation(op.get("source").unwrap_or(&Value::Null)) } else { text_or_empty(op.get("text")) };
    if text.is_empty() {
        return Err(format!("{} requires {}", op_name(op), if provenance { "source" } else { "text" }));
    }
    let cell = js_text(op.get("cell"));
    let author = if truthy(op.get("author")) { js_text(op.get("author")) } else { "Mixdog".to_owned() };
    let written = write_worksheet_note(zip, sheet, xml, &NoteRequest { cell: &cell, text: &text, author: &author, append: provenance })?;
    zip.set(&sheet.path, written.worksheet);
    let mut result = Map::new();
    result.insert("op".to_owned(), op.get("op").cloned().unwrap_or(Value::Null));
    result.insert("changed".to_owned(), json!(written.changed));
    result.insert("sheet".to_owned(), json!(sheet.name));
    result.insert("cell".to_owned(), json!(parse_cell_ref(&cell)?.reference));
    if provenance {
        result.insert("citation".to_owned(), json!(text));
    }
    Ok(Value::Object(result))
}

/// `deleteWorksheetNote(zip, sheet, xml, op)`.
pub fn delete_worksheet_note(zip: &mut Package, sheet: &Sheet, op: &Op) -> Result<Value, String> {
    let reference = cell_of(op)?;
    let relationships = zip.text(&part_relationship_path(&sheet.path));
    let target = relationship_target_by_type(&relationships, "comments");
    if target.is_empty() {
        return Ok(json!({ "op": op.get("op"), "changed": false, "sheet": sheet.name, "cell": reference }));
    }
    let comments_part = part_from_target(&posix::dirname(&sheet.path), &target);
    let comments = zip.text(&comments_part);
    let pattern = compiled(&format!(r#"<comment\b[^>]*\bref="{reference}"[^>]*>[\s\S]*?<\/comment>"#), "");
    let changed = pattern.is_match(&comments);
    if changed {
        zip.set(&comments_part, replace_first(&pattern, &comments, |_| String::new()));
    }
    Ok(json!({ "op": op.get("op"), "changed": changed, "sheet": sheet.name, "cell": reference }))
}

/// `copyWorksheet(zip, sheet, xml, op, sheets)`: copy_sheet adds a workbook entry, so the dispatcher re-reads the sheet list.
pub fn copy_worksheet(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op, sheets: &[Sheet]) -> Result<Value, String> {
    let wanted = if truthy(op.get("name")) { js_text(op.get("name")) } else { format!("{} copy", sheet.name) };
    let label = assert_worksheet_name("copy_sheet", Some(&Value::String(slice_utf16(&wanted, 31))))?;
    if sheets.iter().any(|entry| js_to_lowercase(&entry.name) == js_to_lowercase(&label)) {
        return Err(format!("Worksheet already exists: {label}"));
    }
    let mut ordinal = 1_u64;
    while zip.file(&format!("xl/worksheets/sheet{ordinal}.xml")).is_some() {
        ordinal += 1;
    }
    let copy_part = format!("xl/worksheets/sheet{ordinal}.xml");
    // A table part belongs to the sheet that declares it, so the copy takes the cells without the tableParts entry or the
    // table relationships.
    let without_tables = replace_first(&TABLE_PARTS, xml, |_| String::new());
    zip.set(&copy_part, copied_sheet_xml(&without_tables, &sheet.name, &label)?);
    ensure_content_type_override(zip, &format!("/{copy_part}"), WORKSHEET_CONTENT_TYPE);
    let relationship_id =
        add_package_relationship(zip, "xl/_rels/workbook.xml.rels", WORKSHEET_RELATIONSHIP, &format!("worksheets/sheet{ordinal}.xml"), "");
    let workbook = zip.text(WORKBOOK_PATH);
    let entry = format!("<sheet name=\"{}\" sheetId=\"{}\" r:id=\"{relationship_id}\"/>", xml_encode(&label), next_sheet_id(&workbook));
    zip.set(WORKBOOK_PATH, workbook.replacen(SHEETS_CLOSE, &format!("{entry}{SHEETS_CLOSE}"), 1));
    copy_sheet_parts(zip, sheets, sheet, &Sheet { name: label.clone(), path: copy_part, rid: String::new(), visibility: "visible" })?;
    Ok(json!({ "op": op.get("op"), "changed": true, "sheet": label }))
}

/// `setWorksheetHyperlink(zip, sheet, xml, op)`.
pub fn set_worksheet_hyperlink(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op) -> Result<Value, String> {
    let reference = cell_of(op)?;
    let address = js_trim(&text_or_empty(op.get("address"))).to_owned();
    if address.is_empty() && !truthy(op.get("subAddress")) {
        return Err("set_hyperlink requires address or subAddress".to_owned());
    }
    let relationship_id = if address.is_empty() {
        String::new()
    } else {
        add_package_relationship(zip, &part_relationship_path(&sheet.path), &format!("{OFFICE_RELATIONSHIP_BASE}/hyperlink"), &address, "External")
    };
    let mut next = match op.get("text") {
        None | Some(Value::Null) => xml.to_owned(),
        Some(text) => set_cell_in_sheet(xml, &reference, text, "")?,
    };
    let previous = match worksheet_section(&next, "hyperlinks") {
        Some(range) => {
            let own = compiled(&format!(r#"<hyperlink\b[^>]*\bref="{reference}"[^>]*\/>"#), "");
            replace_first(&own, &container_body(&next[range], "hyperlinks"), |_| String::new())
        }
        None => String::new(),
    };
    let link = format!(
        "<hyperlink ref=\"{reference}\"{}{}{}/>",
        if relationship_id.is_empty() { String::new() } else { format!(" r:id=\"{relationship_id}\"") },
        if truthy(op.get("subAddress")) { format!(" location=\"{}\"", xml_encode(&js_text(op.get("subAddress")))) } else { String::new() },
        if truthy(op.get("screenTip")) { format!(" tooltip=\"{}\"", xml_encode(&js_text(op.get("screenTip")))) } else { String::new() },
    );
    next = upsert_worksheet_section(&next, "hyperlinks", &format!("<hyperlinks>{previous}{link}</hyperlinks>"));
    zip.set(&sheet.path, next);
    Ok(json!({ "op": op.get("op"), "changed": true, "sheet": sheet.name, "cell": reference, "address": address }))
}

/// `protectWorksheet(zip, sheet, xml, op)`: protect_sheet / unprotect_sheet.
pub fn protect_worksheet(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op) -> Value {
    let next = if op_name(op) == "unprotect_sheet" {
        upsert_worksheet_section(xml, "sheetProtection", "")
    } else {
        let allow = |key: &str, attribute: &str| {
            if op.get(key) == Some(&Value::Bool(true)) { format!(" {attribute}=\"0\"") } else { String::new() }
        };
        let password =
            if truthy(op.get("password")) { format!(" password=\"{}\"", excel_password_hash(&js_text(op.get("password")))) } else { String::new() };
        upsert_worksheet_section(
            xml,
            "sheetProtection",
            &format!(
                "<sheetProtection{password} sheet=\"1\" objects=\"1\" scenarios=\"1\"{}{}{}/>",
                allow("allowFormattingCells", "formatCells"),
                allow("allowSorting", "sort"),
                allow("allowFiltering", "autoFilter"),
            ),
        )
    };
    zip.set(&sheet.path, next);
    json!({ "op": op.get("op"), "changed": true, "sheet": sheet.name })
}

/// `addWorksheetTable(zip, sheet, xml, op)`.
pub fn add_worksheet_table(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Op) -> Result<Value, String> {
    let area = parse_area_range(&text_or_empty(op.get("range")))?;
    if area.start_row == 0.0 || area.start_col == 0.0 {
        return Err("add_table requires a bounded range such as A1:C10".to_owned());
    }
    let grid: HashMap<String, CellValue> =
        cell_records(xml, &shared_strings(zip), None).into_iter().map(|record| (record.reference, record.value)).collect();
    let mut names: Vec<String> = Vec::new();
    let mut next = xml.to_owned();
    let mut column = area.start_col;
    while column <= area.end_col {
        let reference = format!("{}{}", column_label(column), number_to_string(area.start_row));
        let raw = match grid.get(&reference) {
            Some(CellValue::Text(text)) => js_trim(text).to_owned(),
            Some(CellValue::Number(number)) => number_to_string(*number),
            Some(CellValue::Bool(flag)) => flag.to_string(),
            None => String::new(),
        };
        let mut name = if raw.is_empty() { format!("Column{}", number_to_string(column - area.start_col + 1.0)) } else { raw.clone() };
        while names.contains(&name) {
            name = format!("{name}_{}", names.len() + 1);
        }
        if raw.is_empty() {
            next = set_cell_in_sheet(&next, &reference, &Value::String(name.clone()), "")?;
        }
        names.push(name);
        column += 1.0;
    }
    let mut ordinal = 1_u64;
    while zip.file(&format!("xl/tables/table{ordinal}.xml")).is_some() {
        ordinal += 1;
    }
    let table_part = format!("xl/tables/table{ordinal}.xml");
    let reference = area_reference(&area);
    let wanted = if truthy(op.get("name")) { js_text(op.get("name")) } else { format!("Table{ordinal}") };
    let table_name = safe_workbook_table_name(&wanted);
    let columns: String =
        names.iter().enumerate().map(|(index, entry)| format!("<tableColumn id=\"{}\" name=\"{}\"/>", index + 1, xml_encode(entry))).collect();
    zip.set(
        &table_part,
        format!(
            "{XML_HEADER}<table xmlns=\"{SPREADSHEET_MAIN}\" id=\"{ordinal}\" name=\"{n}\" displayName=\"{n}\" ref=\"{reference}\" totalsRowShown=\"0\">\
<autoFilter ref=\"{reference}\"/><tableColumns count=\"{}\">{columns}</tableColumns>{}</table>",
            names.len(),
            table_style_info_xml(op.get("style")),
            n = xml_encode(&table_name),
        ),
    );
    ensure_content_type_override(zip, &format!("/{table_part}"), TABLE_CONTENT_TYPE);
    let relationship_id = add_package_relationship(
        zip,
        &part_relationship_path(&sheet.path),
        &format!("{OFFICE_RELATIONSHIP_BASE}/table"),
        &posix::relative(&posix::dirname(&sheet.path), &table_part),
        "",
    );
    let previous = worksheet_section(&next, "tableParts").map(|range| container_body(&next[range], "tableParts")).unwrap_or_default();
    let count = TABLE_PART_OPEN.find_iter(&previous).count() + 1;
    next = upsert_worksheet_section(
        &next,
        "tableParts",
        &format!("<tableParts count=\"{count}\">{previous}<tablePart r:id=\"{relationship_id}\"/></tableParts>"),
    );
    zip.set(&sheet.path, next);
    Ok(json!({ "op": op.get("op"), "changed": true, "sheet": sheet.name, "name": table_name, "columns": names.len() }))
}
