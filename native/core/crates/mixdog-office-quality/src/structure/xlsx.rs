//! `assurance-structure-xlsx.mjs`: workbook structure review, the sheet layout, formulas, charts and print areas.

use std::collections::HashMap;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, math, number_to_string, slice_utf16, string_to_number, value_to_string};
use mixdog_office_base::a1::column_number;
use mixdog_ooxml::xlsx_audit_support::sheet_path;
use mixdog_ooxml::xlsx_formula_audit::{AuditOptions, audit_xlsx_formulas};
use serde_json::Value;

use super::{list, nested, num, num0, record, text, trimmed, warn};
use crate::{field, field_of, is_truthy, is_true, strict_equals, template_text};

/// How far a series may stop above the data before the gap reads as a deliberate window rather than as the row someone
/// forgot to include.
const CHART_SHORT_ROWS: f64 = 2.0;

static FORMULA_RANGE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\$?([A-Z]{1,3})\$?([1-9]\d*):\$?([A-Z]{1,3})\$?([1-9]\d*)", "i"));
static PRINT_AREA: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$", ""));
static TOTAL_ROW_LABEL: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:(?:grand\s+total|sub\s*total|total)\b|(?:합계|총계|소계)(?:\s|$))", "i"));
static TOTAL_LABEL_PREFIX: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^(?:grand\s+total|sub\s*total|total|합계|총계|소계)", "i"));
static FORMULA_ERROR: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^#(?:DIV\/0|VALUE|REF|NAME|N\/A|NUM|NULL|SPILL|CALC|FIELD)\??!?$", "i"));
static PLAIN_COLOR: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static("^(?:#?000000|auto)?$", "i"));

/// `String(value ?? '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(inner) => value_to_string(inner),
    }
}

/// `cellRow(ref)`: the row the reference ends in, 0 when it names none.
fn cell_row(reference: Option<&Value>) -> f64 {
    let plain = text(reference).replace('$', "");
    let digits = plain.len() - plain.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    let run = &plain[plain.len() - digits..];
    let row = run.trim_start_matches('0');
    if row.is_empty() { 0.0 } else { string_to_number(row) }
}

/// `cellColumn(ref)`: the column number of the letters a reference starts with, 0 when it has none.
fn cell_column(reference: Option<&Value>) -> f64 {
    let plain = text(reference);
    let rest = plain.strip_prefix('$').unwrap_or(&plain);
    let letters: String = rest.chars().take_while(char::is_ascii_alphabetic).take(3).collect();
    column_number(&letters)
}

struct Range {
    start_column: f64,
    start: f64,
    end_column: f64,
    end: f64,
}

fn formula_ranges(formula: &Value) -> Vec<Range> {
    FORMULA_RANGE
        .captures_iter(&text(Some(formula)))
        .map(|found| {
            let group = |at: usize| found.get(at).unwrap_or("");
            Range {
                start_column: column_number(group(1)),
                start: string_to_number(group(2)),
                end_column: column_number(group(3)),
                end: string_to_number(group(4)),
            }
        })
        .collect()
}

/// A number the sheet holds, whatever notation it wears; a note or a label under the table is text and is not data the
/// chart left out.
fn numeric_cell(cell: &Value) -> bool {
    let raw = js_trim(&text_or_empty(field(cell, "value"))).to_owned();
    if raw.is_empty() {
        return false;
    }
    let plain = raw.replace(',', "");
    let plain = plain.strip_suffix('%').unwrap_or(&plain);
    string_to_number(plain).is_finite()
}

struct PrintArea {
    start_column: f64,
    start_row: f64,
    end_column: f64,
    end_row: f64,
}

/// A print area is one or more A1 ranges; Excel prints each as its own page set.
fn print_areas(reference: Option<&Value>) -> Vec<PrintArea> {
    text(reference)
        .split(',')
        .filter_map(|part| {
            let found = PRINT_AREA.captures(js_trim(part))?;
            let group = |at: usize| found.get(at);
            let first = group(1).unwrap_or("");
            let first_row = group(2).unwrap_or("");
            Some(PrintArea {
                start_column: column_number(first),
                start_row: string_to_number(first_row),
                end_column: column_number(group(3).filter(|inner| !inner.is_empty()).unwrap_or(first)),
                end_row: string_to_number(group(4).filter(|inner| !inner.is_empty()).unwrap_or(first_row)),
            })
        })
        .collect()
}

/// The face a sheet's plain cells wear.
struct Face {
    font_name: Option<Value>,
    /// `Number(face.fontSize)`.
    font_size: f64,
}

/// The workbook's default where the reading states it, else the commonest face.
fn base_face(cells: &[&Value], defaults: Option<&Value>) -> Face {
    let default_name = field_of(defaults, "fontName");
    let default_size = field_of(defaults, "fontSize");
    if is_truthy(default_name) || is_truthy(default_size) {
        return Face { font_name: default_name.cloned(), font_size: num(default_size) };
    }
    let mut counts: Vec<(String, usize)> = Vec::new();
    for cell in cells {
        let style = field(cell, "style");
        let face = format!("{}\u{0}{}", text_or_empty(field_of(style, "fontName")), text_or_empty(field_of(style, "fontSize")));
        match counts.iter_mut().find(|entry| entry.0 == face) {
            Some(entry) => entry.1 += 1,
            None => counts.push((face, 1)),
        }
    }
    let mut best: Option<&(String, usize)> = None;
    for entry in &counts {
        if best.is_none_or(|known| entry.1 > known.1) {
            best = Some(entry);
        }
    }
    let face = best.map_or("\u{0}", |entry| entry.0.as_str());
    let (name, size) = face.split_once('\u{0}').unwrap_or((face, ""));
    Face {
        font_name: Some(Value::String(name.to_owned())),
        font_size: if size.is_empty() { f64::NAN } else { string_to_number(size) },
    }
}

/// A cell is styled by what it states beyond that face. The Office reader reports the workbook font on every cell,
/// which counted a sheet of plain data as styled and kept this check from ever firing there.
fn styled_cell(style: Option<&Value>, base: &Face) -> bool {
    let Some(map) = style.and_then(Value::as_object) else { return false };
    map.iter().any(|(key, value)| match key.as_str() {
        "fontName" => is_truthy(Some(value)) && !strict_equals(Some(value), base.font_name.as_ref()),
        "fontSize" => !value.is_null() && num(Some(value)) != base.font_size,
        "color" => !PLAIN_COLOR.is_match(&text_or_empty(Some(value))),
        _ => !value.is_null() && value != &Value::String(String::new()) && value != &Value::Bool(false),
    })
}

fn review_hierarchy(sheet: &Value, cells: &[&Value], issues: &mut Vec<Value>, defaults: Option<&Value>) {
    if cells.len() < 8 {
        return;
    }
    let base = base_face(cells, defaults);
    if cells.iter().any(|cell| styled_cell(field(cell, "style"), &base)) {
        return;
    }
    issues.push(warn(
        "worksheet_hierarchy_missing",
        Some(sheet_path(sheet)),
        "Data sheet has no styled title, header, table, or visual hierarchy.".into(),
    ));
}

/// The rows whose label says total, in the order the cells list them.
fn total_rows(cells: &[&Value]) -> Vec<f64> {
    let mut rows: Vec<f64> = Vec::new();
    for cell in cells {
        if !TOTAL_ROW_LABEL.is_match(&trimmed(field(cell, "value"))) {
            continue;
        }
        let row = cell_row(field(cell, "ref"));
        if row != 0.0 && !rows.contains(&row) {
            rows.push(row);
        }
    }
    rows
}

fn review_formula_errors(sheet: &Value, cells: &[&Value], issues: &mut Vec<Value>) {
    for cell in cells {
        if !FORMULA_ERROR.is_match(&trimmed(field(cell, "value"))) {
            continue;
        }
        let path = text(field(cell, "path"));
        let path = if path.is_empty() { format!("{}/cell[{}]", sheet_path(sheet), text(field(cell, "ref"))) } else { path };
        issues.push(record(
            "formula_error",
            Some(path),
            format!("Formula evaluates to {}.", template_text(field(cell, "value"))),
            "format-review",
            "error",
        ));
    }
}

/// The last data row the chart's columns hold past the rows it reads; 0 when the series reach the data or the columns
/// hold nothing more.
fn chart_last_missed_row(cells: &[&Value], ranges: &[Range], last_read: f64, totals: &[f64]) -> f64 {
    if ranges.is_empty() {
        return 0.0;
    }
    let first = ranges.iter().fold(f64::INFINITY, |least, range| math::min(least, range.start_column));
    let last = ranges.iter().fold(f64::NEG_INFINITY, |most, range| math::max(most, range.end_column));
    cells
        .iter()
        .filter_map(|cell| {
            let row = cell_row(field(cell, "ref"));
            let column = cell_column(field(cell, "ref"));
            (row > last_read && !totals.contains(&row) && column >= first && column <= last && numeric_cell(cell)).then_some(row)
        })
        .fold(0.0, f64::max)
}

fn review_chart_ranges(sheet: &Value, cells: &[&Value], totals: &[f64], issues: &mut Vec<Value>) {
    for chart in list(field(sheet, "charts")) {
        let chart_path = {
            let own = text(field(chart, "path"));
            if own.is_empty() { format!("{}/chart", sheet_path(sheet)) } else { own }
        };
        let formulas: Vec<&Value> = list(field(chart, "series"))
            .iter()
            .flat_map(|series| ["formula", "categoryFormula", "valueFormula"].map(|key| field(series, key)))
            .flatten()
            .filter(|formula| is_truthy(Some(*formula)))
            .collect();
        let per_formula: Vec<Vec<Range>> = formulas.iter().map(|formula| formula_ranges(formula)).collect();
        let included = totals.iter().find(|row| per_formula.iter().any(|ranges| ranges.iter().any(|range| **row >= range.start && **row <= range.end)));
        if let Some(row) = included {
            issues.push(warn(
                "chart_includes_total_row",
                Some(chart_path.clone()),
                format!("Chart source includes total or subtotal row {}; separate summary rows from comparison series.", number_to_string(*row)),
            ));
        }
        // The opposite error renders just as cleanly: a series that stops one row above the data draws a picture the
        // sheet does not support. A chart showing a deliberate window stops far short, and a total row is left out on
        // purpose, so only the last row or two count.
        let ranges: Vec<Range> = per_formula.into_iter().flatten().collect();
        let last_read = ranges.iter().map(|range| range.end).reduce(math::max).unwrap_or(0.0);
        let last_data = chart_last_missed_row(cells, &ranges, last_read, totals);
        if last_read != 0.0 && last_data != 0.0 && last_data - last_read <= CHART_SHORT_ROWS {
            issues.push(warn(
                "chart_stops_short_of_data",
                Some(chart_path),
                format!(
                    "Chart source stops at row {} while the columns it reads hold data through row {}; widen the series range.",
                    number_to_string(last_read),
                    number_to_string(last_data)
                ),
            ));
        }
    }
}

fn review_print_fit(sheet: &Value, page_setup: Option<&Value>, issues: &mut Vec<Value>) {
    let rows = num0(field(sheet, "rows"));
    let columns = num0(field(sheet, "columns"));
    if !(rows >= 40.0 || columns >= 12.0)
        || num(field_of(page_setup, "fitToPagesWide")) == 1.0
        || !(num(field_of(page_setup, "zoom")) > 100.0)
    {
        return;
    }
    issues.push(warn(
        "worksheet_print_fit_missing",
        Some(sheet_path(sheet)),
        "Large worksheet has no one-page-wide print fit and uses an enlarged print zoom.".into(),
    ));
}

struct Drawing<'a> {
    kind: &'static str,
    entry: &'a Value,
}

impl Drawing<'_> {
    fn anchor(&self) -> Option<&Value> {
        field(self.entry, "anchor")
    }

    fn at(&self, key: &str) -> f64 {
        num(field_of(self.anchor(), key))
    }

    fn span(&self) -> String {
        format!("{}:{}", template_text(field_of(self.anchor(), "from")), template_text(field_of(self.anchor(), "to")))
    }

    fn path(&self, sheet: &Value) -> String {
        let own = text(field(self.entry, "path"));
        if own.is_empty() { sheet_path(sheet) } else { own }
    }
}

fn sheet_drawings(sheet: &Value) -> Vec<Drawing<'_>> {
    let charts = list(field(sheet, "charts")).iter().map(|entry| Drawing { kind: "Chart", entry });
    let images = list(field(sheet, "images")).iter().map(|entry| Drawing { kind: "Picture", entry });
    charts.chain(images).filter(|item| item.at("endColumn") > 0.0).collect()
}

/// A chart or picture the print area leaves out is cut in half by the page break, and a sheet with no print area at all
/// paginates around it.
fn review_print_area(sheet: &Value, page_setup: Option<&Value>, drawings: &[Drawing<'_>], issues: &mut Vec<Value>) {
    let areas = print_areas(field_of(page_setup, "printArea"));
    for drawing in drawings.iter().take(3) {
        let inside = areas.iter().any(|area| {
            drawing.at("startColumn") >= area.start_column
                && drawing.at("startRow") >= area.start_row
                && drawing.at("endColumn") <= area.end_column
                && drawing.at("endRow") <= area.end_row
        });
        if inside {
            continue;
        }
        // A sheet fitted to one page wide exports whole with or without a print area; a declared print area that
        // leaves the drawing out cuts it.
        if areas.is_empty() && num(field_of(page_setup, "fitToPagesWide")) == 1.0 {
            continue;
        }
        let span = drawing.span();
        let message = if areas.is_empty() {
            format!(
                "{} spans {span} and the sheet declares no print area or one-page-wide fit, so an export may paginate through it.",
                drawing.kind
            )
        } else {
            format!(
                "{} spans {span}, past the print area {}; a print or PDF export cuts it.",
                drawing.kind,
                template_text(field_of(page_setup, "printArea"))
            )
        };
        issues.push(record(
            "drawing_outside_print_area",
            Some(drawing.path(sheet)),
            message,
            "format-review",
            if areas.is_empty() { "info" } else { "warning" },
        ));
    }
}

/// Two drawings on one cell block hide each other: a second chart anchored inside the first one's rows prints as one
/// chart drawn over another.
fn review_drawing_overlap(sheet: &Value, drawings: &[Drawing<'_>], issues: &mut Vec<Value>) {
    for first in 0..drawings.len() {
        for second in first + 1..drawings.len() {
            let (left, right) = (&drawings[first], &drawings[second]);
            let columns = math::min(left.at("endColumn"), right.at("endColumn")) - math::max(left.at("startColumn"), right.at("startColumn"));
            let rows = math::min(left.at("endRow"), right.at("endRow")) - math::max(left.at("startRow"), right.at("startRow"));
            if columns < 1.0 || rows < 1.0 {
                continue;
            }
            issues.push(record(
                "drawing_overlap",
                Some(right.path(sheet)),
                format!(
                    "{} spans {}, over the {} at {}; place it below or beside it.",
                    right.kind,
                    right.span(),
                    left.kind.to_lowercase(),
                    left.span()
                ),
                "format-review",
                "warning",
            ));
        }
    }
}

/// A chart or picture laid over filled cells hides them: the figures stay in the file while the page shows the drawing
/// on top of them.
fn review_drawing_cover(sheet: &Value, cells: &[&Value], drawings: &[Drawing<'_>], issues: &mut Vec<Value>) {
    // A formula shows its result whether or not the result is cached yet.
    let filled: Vec<&&Value> =
        cells.iter().filter(|cell| is_truthy(field(cell, "formula")) || !js_trim(&text_or_empty(field(cell, "value"))).is_empty()).collect();
    for drawing in drawings {
        let under: Vec<&&&Value> = filled
            .iter()
            .filter(|cell| {
                let row = cell_row(field(cell, "ref"));
                let column = cell_column(field(cell, "ref"));
                row >= drawing.at("startRow") && row <= drawing.at("endRow") && column >= drawing.at("startColumn") && column <= drawing.at("endColumn")
            })
            .collect();
        if under.is_empty() {
            continue;
        }
        let refs: Vec<String> = under.iter().take(3).map(|cell| text_or_empty(field(cell, "ref"))).collect();
        let shown = format!("{}{}", refs.join(", "), if under.len() > 3 { ", …" } else { "" });
        let plural = if under.len() == 1 { "" } else { "s" };
        let pronoun = if under.len() == 1 { "it" } else { "them" };
        issues.push(record(
            "drawing_covers_cells",
            Some(drawing.path(sheet)),
            format!(
                "{} spans {} over {} filled cell{plural} ({shown}) and hides {pronoun}; move it clear with set_drawing, or move the cells.",
                drawing.kind,
                drawing.span(),
                under.len()
            ),
            "format-review",
            "warning",
        ));
    }
}

fn is_figure(cell: Option<&Value>) -> bool {
    cell.is_some_and(|inner| {
        matches!(field(inner, "value"), Some(Value::Number(_))) && field(inner, "dataType") != Some(&Value::String("text".into()))
    })
}

/// `/sheet[name]/cell[ref]`, with the name or the reference `undefined` when the snapshot lacks it.
fn cell_location(sheet: &Value, reference: Option<&Value>) -> String {
    format!("/sheet[{}]/cell[{}]", template_text(field(sheet, "name")), template_text(reference))
}

/// A total row reads as a total only when it is set apart from the rows it sums: its label is bold (the report recipe
/// sets the whole row bold over a rule).
fn review_total_rows(sheet: &Value, cells: &[&Value], totals: &[f64], issues: &mut Vec<Value>) {
    for row in totals {
        let label = cells.iter().find(|cell| cell_row(field(cell, "ref")) == *row && TOTAL_LABEL_PREFIX.is_match(&trimmed(field(cell, "value"))));
        let Some(label) = label else { continue };
        if cells.iter().any(|cell| cell_row(field(cell, "ref")) == *row && is_true(nested(cell, "style", "bold"))) {
            continue;
        }
        issues.push(warn(
            "total_row_unmarked",
            Some(cell_location(sheet, field(label, "ref"))),
            format!(
                "The \"{}\" row is set like the rows it sums; set it bold with a rule above (set_style bold, borders.top).",
                js_trim(&template_text(field(label, "value")))
            ),
        ));
    }
}

/// `/^([A-Z]+)(\d+)$/` of a reference: its letters and its row number.
fn column_and_row(reference: &str) -> Option<(&str, f64)> {
    let letters = reference.len() - reference.trim_start_matches(|c: char| c.is_ascii_uppercase()).len();
    let (column, digits) = reference.split_at(letters);
    (letters > 0 && !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())).then(|| (column, string_to_number(digits)))
}

/// A column of figures stands on its right edge; a bold header over it set left (Excel's default for text) reads as
/// belonging to the column beside it.
fn review_header_alignment(sheet: &Value, cells: &[&Value], issues: &mut Vec<Value>) {
    let by_ref: HashMap<&str, &Value> = cells.iter().filter_map(|cell| field(cell, "ref").and_then(Value::as_str).map(|key| (key, *cell))).collect();
    for header in cells {
        let Some(label) = field(header, "value").and_then(Value::as_str).filter(|value| !js_trim(value).is_empty()) else { continue };
        if !is_true(nested(header, "style", "bold")) {
            continue;
        }
        let Some((column, row)) = field(header, "ref").and_then(Value::as_str).and_then(column_and_row) else { continue };
        let below: Vec<Option<&Value>> = [1.0, 2.0].map(|offset| by_ref.get(format!("{column}{}", number_to_string(row + offset)).as_str()).copied()).to_vec();
        if !below.iter().all(|cell| is_figure(*cell)) {
            continue;
        }
        let aligned = |cell: &Value| text_or_general(nested(cell, "style", "horizontalAlignment"));
        if below.iter().flatten().any(|cell| !matches!(aligned(*cell).as_str(), "general" | "right")) {
            continue;
        }
        let alignment = text_or_general(nested(header, "style", "horizontalAlignment"));
        if alignment == "right" {
            continue;
        }
        issues.push(warn(
            "header_alignment_mismatch",
            Some(cell_location(sheet, field(header, "ref"))),
            format!(
                "Header \"{}\" is set {} over a column of figures set right; align it right (set_style horizontalAlignment:'right').",
                slice_utf16(js_trim(label), 20),
                if alignment == "general" { "left" } else { alignment.as_str() }
            ),
        ));
    }
}

/// `value || 'general'`.
fn text_or_general(value: Option<&Value>) -> String {
    crate::text_or(value, "general")
}

/// `reviewXlsxStructure(document, auditProfile)`.
pub fn review_xlsx_structure(document: &Value, audit_profile: &str) -> Vec<Value> {
    let mut issues = Vec::new();
    let sheets = list(field(document, "sheets"));
    for sheet in sheets {
        let cells: Vec<&Value> = list(field(sheet, "cells")).iter().collect();
        let page_setup = field(sheet, "pageSetup").filter(|value| is_truthy(Some(*value)));
        let drawings = sheet_drawings(sheet);
        review_hierarchy(sheet, &cells, &mut issues, field(document, "defaultStyle"));
        review_formula_errors(sheet, &cells, &mut issues);
        let totals = total_rows(&cells);
        review_chart_ranges(sheet, &cells, &totals, &mut issues);
        review_total_rows(sheet, &cells, &totals, &mut issues);
        review_header_alignment(sheet, &cells, &mut issues);
        review_print_fit(sheet, page_setup, &mut issues);
        review_print_area(sheet, page_setup, &drawings, &mut issues);
        review_drawing_overlap(sheet, &drawings, &mut issues);
        review_drawing_cover(sheet, &cells, &drawings, &mut issues);
    }
    let options = AuditOptions { audit_profile, sheet_names: &[], defined_names: list(field(document, "definedNames")) };
    for finding in audit_xlsx_formulas(sheets, &options) {
        issues.push(record(finding.code, Some(finding.path.clone()), finding.message.clone(), "format-review", finding.severity));
    }
    issues
}
