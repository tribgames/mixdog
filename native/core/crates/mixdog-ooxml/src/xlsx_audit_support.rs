//! `portable/xlsx-audit-support.mjs`: the reading helpers every XLSX audit shares. How a snapshot cell is located, read
//! as a number or a boolean, recognised as a marked input, and how findings are collected under a per-code cap. A
//! cell is the JSON object both snapshot readers produce (`{ ref, path?, value, formula?, cachedValue?, style?, note?,
//! dataType? }`), read here with JavaScript's coercions: a field missing, null or empty is falsy, and `String(x)` of a
//! missing one is `undefined`.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_trim, string_to_number, to_number_of, value_to_string};
use mixdog_office_base::a1::{column_number, parse_cell_ref};
use serde_json::{Map, Value, json};

use crate::sheet_styles::is_general_number_format;
use crate::sheet_xml::{Area, parse_area_range};

/// `MAX_ISSUES_PER_CODE`: the findings of one code kept before the rest are only counted.
pub const MAX_ISSUES_PER_CODE: usize = 100;

static NUMERIC_TEXT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$", "i"));
static STRING_LITERAL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#""(?:[^"]|"")*""#, "g"));
static BLACK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:FF)?000000$", "i"));
static WHITE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:FF)?FFFFFF$", "i"));

/// JavaScript truthiness of a field that may be missing.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// `String(value)` of a field that may be missing (`undefined`).
pub fn js_text(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `String(value || '')`.
pub fn text_or_empty(value: Option<&Value>) -> String {
    if truthy(value) { js_text(value) } else { String::new() }
}

/// `String(value ?? '')`.
pub fn text_or_empty_nullish(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => value_to_string(value),
    }
}

/// An array field read as a list: a missing or non-array one is an empty list.
pub fn list(value: Option<&Value>) -> &[Value] {
    value.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// `escapeRegExp(text)`.
pub fn escape_reg_exp(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        if ".*+?^${}()|[]\\".contains(character) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

/// `sheetPath(sheet)`.
pub fn sheet_path(sheet: &Value) -> String {
    match sheet.get("path") {
        path if truthy(path) => js_text(path),
        _ => format!("/sheet[{}]", text_or_empty(sheet.get("name"))),
    }
}

/// `cellPath(sheet, cell)`.
pub fn cell_path(sheet: &Value, cell: &Value) -> String {
    match cell.get("path") {
        path if truthy(path) => js_text(path),
        _ => format!("{}/cell[{}]", sheet_path(sheet), text_or_empty(cell.get("ref"))),
    }
}

/// `formulaBody(formula)` of a formula text: string literals never carry references or operators, so they are blanked
/// (a quoted `"Sheet Name!"` or `"1.05"` cannot masquerade as one) and the leading `=` goes.
pub fn formula_body_of(formula: &str) -> String {
    let blanked = STRING_LITERAL.replace_all_with(formula, |_| "\"\"".to_owned());
    blanked.strip_prefix('=').map_or_else(|| blanked.clone(), str::to_owned)
}

/// `text.split(/("(?:[^"]|"")*")/)` mapped and joined again: `map` rewrites the text outside the string literals (the
/// even pieces of the split) and the literals stay as they were.
pub fn map_outside_string_literals(text: &str, mut map: impl FnMut(&str) -> String) -> String {
    let mut output = String::with_capacity(text.len());
    let mut last = 0;
    for found in STRING_LITERAL.find_iter(text) {
        output.push_str(&map(&text[last..found.start]));
        output.push_str(&text[found.clone()]);
        last = found.end;
    }
    output.push_str(&map(&text[last..]));
    output
}

/// `formulaBody(formula)` of a formula field (`String(formula || '')`).
pub fn formula_body(formula: Option<&Value>) -> String {
    formula_body_of(&text_or_empty(formula))
}

/// The value an audit reads: a formula's cached result (else its value), a constant's value.
fn reading_value(cell: &Value) -> Option<&Value> {
    if truthy(cell.get("formula")) {
        match cell.get("cachedValue") {
            Some(cached) if !cached.is_null() => Some(cached),
            _ => cell.get("value"),
        }
    } else {
        cell.get("value")
    }
}

/// `numericValue(cell)`: a finite number, or a string that reads as one.
pub fn numeric_value(cell: &Value) -> Option<f64> {
    match reading_value(cell) {
        Some(Value::Number(number)) => number.as_f64().filter(|number| number.is_finite()),
        Some(Value::String(text)) if NUMERIC_TEXT.is_match(js_trim(text)) => Some(string_to_number(js_trim(text))),
        _ => None,
    }
}

/// `isNumericCell(cell)`.
pub fn is_numeric_cell(cell: &Value) -> bool {
    numeric_value(cell).is_some()
}

/// `falseValue(cell)`.
pub fn false_value(cell: &Value) -> bool {
    match reading_value(cell) {
        Some(Value::Bool(flag)) => !*flag,
        Some(Value::String(text)) => js_trim(text).to_uppercase() == "FALSE",
        _ => false,
    }
}

/// Where a cell stands: its 1-based row and column.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Position {
    pub row: f64,
    pub column: f64,
}

/// `position(cell)`: `None` where the reference does not resolve.
pub fn position(cell: &Value) -> Option<Position> {
    let parsed = parse_cell_ref(&text_or_empty(cell.get("ref"))).ok()?;
    Some(Position { row: parsed.row as f64, column: column_number(&parsed.col) })
}

/// A cell with its coordinates.
#[derive(Debug, Clone, Copy)]
pub struct Located<'a> {
    pub cell: &'a Value,
    pub at: Position,
}

/// `locate(cells)`: the cells with a resolvable A1 reference, each paired with its coordinates.
pub fn locate(cells: &[Value]) -> Vec<Located<'_>> {
    cells.iter().filter_map(|cell| position(cell).map(|at| Located { cell, at })).collect()
}

/// `generalFormat(style)`.
pub fn general_format(style: Option<&Value>) -> bool {
    is_general_number_format(js_trim(&text_or_empty(style.and_then(|style| style.get("numberFormat")))))
}

fn object_style(style: Option<&Value>) -> Option<&Value> {
    style.filter(|style| style.is_object())
}

/// `isMarkedInputStyle(style)`: COM reports colours as BGR integers (black 0, no fill 16777215), the portable snapshot
/// as RRGGBB text and omits the default. Both read as marked when the cell carries a non-default font colour or a fill.
pub fn is_marked_input_style(style: Option<&Value>) -> bool {
    let Some(style) = object_style(style) else {
        return false;
    };
    let colored_font = match style.get("color") {
        Some(Value::Number(color)) => color.as_f64() != Some(0.0),
        color => truthy(color) && !BLACK.is_match(&js_text(color)),
    };
    let filled = match style.get("fillColor") {
        Some(Value::Number(fill)) => fill.as_f64() != Some(16_777_215.0),
        fill => truthy(fill) && !WHITE.is_match(&js_text(fill)),
    };
    colored_font || filled
}

/// `hasVisibleStyle(style)`: styling a reader can see: a colour, a fill, bold, or a chosen size. A workbook that went
/// through a recalculation engine carries a style record on every cell, so "has a style object" stopped separating a
/// designed sheet from a plain dump.
pub fn has_visible_style(style: Option<&Value>) -> bool {
    let Some(style) = object_style(style) else {
        return false;
    };
    if is_marked_input_style(Some(style)) {
        return true;
    }
    if ["bold", "italic", "underline"].iter().any(|key| style.get(*key) == Some(&Value::Bool(true))) {
        return true;
    }
    // A chosen number format is a formatting decision; the General one every recalculated cell carries is not.
    if !js_trim(&text_or_empty(style.get("numberFormat"))).is_empty() && !general_format(Some(style)) {
        return true;
    }
    let size = to_number_of(style.get("fontSize"));
    size.is_finite() && size > 0.0 && size != 11.0
}

/// A range as an area bounded by both rows and columns, or `None`: a malformed range, or a whole-row or whole-column
/// one, excludes nothing.
fn bounded_area(range: Option<&Value>) -> Option<Area> {
    let area = parse_area_range(&text_or_empty(range).replace('$', "")).ok()?;
    (area.start_row != 0.0 && area.start_col != 0.0).then_some(area)
}

/// An Excel table a sheet lists and the area its range names.
#[derive(Debug, Clone, Copy)]
pub struct TableArea<'a> {
    pub area: Area,
    pub table: &'a Value,
}

/// `tableAreas(sheet)`: the tables a sheet lists (`tables` `[{ range }]`) as areas; the body rows are records the table
/// sources, not assumptions.
pub fn table_areas(sheet: &Value) -> Vec<TableArea<'_>> {
    list(sheet.get("tables")).iter().filter_map(|table| bounded_area(table.get("range")).map(|area| TableArea { area, table })).collect()
}

/// `mergedAreas(sheet)`: merged blocks are display (a banner, a metric tile, a panel caption), never a column anyone
/// sums, so the grid rules do not apply inside them.
pub fn merged_areas(sheet: &Value) -> Vec<Area> {
    list(sheet.get("mergedRanges")).iter().filter_map(|range| bounded_area(Some(range))).collect()
}

/// `insideArea(areas, at)`.
pub fn inside_area(areas: &[Area], at: &Position) -> bool {
    areas.iter().any(|area| at.row >= area.start_row && at.row <= area.end_row && at.column >= area.start_col && at.column <= area.end_col)
}

/// `insideTableBody(areas, at)`: inside a table and below its header row.
pub fn inside_table_body(areas: &[Area], at: &Position) -> bool {
    areas.iter().any(|area| at.row > area.start_row && at.row <= area.end_row && at.column >= area.start_col && at.column <= area.end_col)
}

/// `notedRefs(sheet, cells)`: notes reach the audit two ways, a portable cell carries `note` and an Excel sheet lists
/// `notes` `[{ cell, text }]`. Either documents the cell.
pub fn noted_refs(sheet: &Value, cells: &[Value]) -> HashSet<String> {
    let mut refs = HashSet::new();
    for cell in cells {
        if truthy(cell.get("note")) {
            refs.insert(js_text(cell.get("ref")).to_uppercase());
        }
    }
    for note in list(sheet.get("notes")) {
        if truthy(note.get("cell")) {
            refs.insert(js_text(note.get("cell")).replace('$', "").to_uppercase());
        }
    }
    refs
}

/// One finding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub severity: &'static str,
    pub code: &'static str,
    pub path: String,
    pub message: String,
}

impl Issue {
    /// `{ severity, code, path, message }`.
    pub fn to_json(&self) -> Value {
        json!({ "severity": self.severity, "code": self.code, "path": self.path, "message": self.message })
    }
}

/// `IssueList`: findings under a per-code cap (`MAX_ISSUES_PER_CODE`); the ones past it are only counted.
#[derive(Debug, Default)]
pub struct IssueList {
    pub issues: Vec<Issue>,
    counts: HashMap<&'static str, usize>,
    pub omitted: usize,
}

impl IssueList {
    pub fn new() -> Self {
        Self::default()
    }

    /// `push(severity, code, path, message)`.
    pub fn push(&mut self, severity: &'static str, code: &'static str, path: impl Into<String>, message: impl Into<String>) {
        let count = self.counts.get(code).copied().unwrap_or(0);
        if count >= MAX_ISSUES_PER_CODE {
            self.omitted += 1;
            return;
        }
        self.counts.insert(code, count + 1);
        self.issues.push(Issue { severity, code, path: path.into(), message: message.into() });
    }

    /// `{ issues, omitted }`.
    pub fn to_json(&self) -> Value {
        let mut list = Map::new();
        list.insert("issues".to_owned(), Value::Array(self.issues.iter().map(Issue::to_json).collect()));
        list.insert("omitted".to_owned(), json!(self.omitted));
        Value::Object(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_formula_body_blanks_string_literals() {
        assert_eq!(formula_body_of(r#"=IF(A1="Sheet Name!","1.05","")"#), r#"IF(A1="","","")"#);
        assert_eq!(formula_body(None), "");
    }

    #[test]
    fn numeric_values_read_the_cache_of_a_formula() {
        let cell = json!({ "ref": "B2", "formula": "=A1", "cachedValue": "1.5e2", "value": 3 });
        assert_eq!(numeric_value(&cell), Some(150.0));
        assert_eq!(numeric_value(&json!({ "value": "12 " })), Some(12.0));
        assert_eq!(numeric_value(&json!({ "value": "x" })), None);
        assert!(false_value(&json!({ "value": " false " })));
    }

    #[test]
    fn marked_inputs_read_both_colour_shapes() {
        assert!(is_marked_input_style(Some(&json!({ "color": "FF0000FF" }))));
        assert!(!is_marked_input_style(Some(&json!({ "color": 0, "fillColor": 16_777_215 }))));
        assert!(is_marked_input_style(Some(&json!({ "fillColor": 255 }))));
        assert!(!has_visible_style(Some(&json!({ "numberFormat": "General", "fontSize": 11 }))));
        assert!(has_visible_style(Some(&json!({ "fontSize": 14 }))));
    }

    #[test]
    fn the_issue_list_caps_each_code() {
        let mut list = IssueList::new();
        for _ in 0..(MAX_ISSUES_PER_CODE + 3) {
            list.push("info", "a", "/p", "m");
        }
        list.push("info", "b", "/p", "m");
        assert_eq!((list.issues.len(), list.omitted), (MAX_ISSUES_PER_CODE + 1, 3));
    }
}
