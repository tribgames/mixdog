//! `portable/portable-cells.mjs`: a worksheet read and edited as the XML it is. The sheets of a workbook, the shared
//! strings, the cells and rows of a sheet, the cached results of formulas, and the writes that put a value, a formula or a
//! style into a cell without disturbing its neighbours. The A1 helpers (`columnLabel`, `columnNumber`, `parseCellRef`) are
//! `mixdog_office_base::a1`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_to_lowercase, js_trim, math, number_to_string, string_to_number, value_to_string};
pub use mixdog_office_base::a1::{CellRef, column_label, column_number, parse_cell_ref};
use mixdog_office_base::values::truthy;
use serde_json::{Map, Value};

use crate::opc::{posix, relationship_map};
use crate::xml::{
    compiled, container_body, element_spans, paragraph_texts, set_xml_attribute, xml_decode, xml_encode,
};
use crate::zipio::Package;

/// How a workbook hides a sheet (`SHEET_VISIBILITY`): a sheet that is neither is `visible`.
fn visibility_of(state: &str) -> &'static str {
    match state {
        "hidden" => "hidden",
        "veryhidden" => "very_hidden",
        _ => "visible",
    }
}

/// A sheet of a workbook.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sheet {
    pub name: String,
    /// The package path of the worksheet part.
    pub path: String,
    pub rid: String,
    /// `visible`, `hidden` or `very_hidden`.
    pub visibility: &'static str,
}

static SHEET_TAG: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<sheet\b([^>]+?)\/?>", "g"));
static SHEET_NAME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bname="([^"]+)""#, ""));
static SHEET_RID: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\br:id="([^"]+)""#, ""));
static SHEET_STATE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bstate="([^"]+)""#, ""));

fn group_one(pattern: &JsRegex, text: &str) -> Option<String> {
    pattern.captures(text).and_then(|found| found.get(1).map(str::to_owned))
}

/// `workbookSheets(zip)`: the sheets of xl/workbook.xml in order, with the worksheet part each one points at. Excel hides
/// a sheet in the workbook, not in the sheet part: a reader that ignores the state reports withheld data as ordinary
/// content.
pub fn workbook_sheets(zip: &Package) -> Vec<Sheet> {
    let workbook = zip.text("xl/workbook.xml");
    let rels = relationship_map(&zip.text("xl/_rels/workbook.xml.rels"));
    let mut sheets = Vec::new();
    for found in SHEET_TAG.captures_iter(&workbook) {
        let attrs = found.get(1).unwrap_or("");
        let name = xml_decode(&group_one(&SHEET_NAME, attrs).unwrap_or_default());
        let rid = group_one(&SHEET_RID, attrs);
        let target = rid.as_deref().and_then(|rid| rels.get(rid)).unwrap_or("");
        if name.is_empty() || target.is_empty() {
            continue;
        }
        let path = match target.strip_prefix('/') {
            Some(rooted) => rooted.to_owned(),
            None => posix::normalize(&posix::join(&["xl", target])),
        };
        let state = js_to_lowercase(&group_one(&SHEET_STATE, attrs).unwrap_or_default());
        sheets.push(Sheet { name, path, rid: rid.unwrap_or_default(), visibility: visibility_of(&state) });
    }
    sheets
}

/// The value of a cell.
#[derive(Debug, Clone, PartialEq)]
pub enum CellValue {
    Text(String),
    Number(f64),
    Bool(bool),
}

impl CellValue {
    /// The JSON value the Node reader produced.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Text(text) => Value::String(text.clone()),
            Self::Number(number) => mixdog_js::json_number(*number),
            Self::Bool(flag) => Value::Bool(*flag),
        }
    }
}

static NUMERIC_CELL_LITERAL: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$", ""));

/// A stored numeric literal is the number it encodes; anything else (a date serial written as text, an unexpected token)
/// stays exactly as the file wrote it rather than being coerced into a number the sheet does not hold.
fn numeric_cell_value(raw: &str) -> CellValue {
    if NUMERIC_CELL_LITERAL.is_match(raw) { CellValue::Number(string_to_number(raw)) } else { CellValue::Text(raw.to_owned()) }
}

/// `strings[Number(raw)]`: the shared string a cell's index names, when it names one.
fn shared_string<'a>(strings: &'a [String], raw: &str) -> Option<&'a str> {
    let index = string_to_number(raw);
    if index.is_nan() || index < 0.0 || index.fract() != 0.0 || index >= strings.len() as f64 {
        return None;
    }
    strings.get(index as usize).map(String::as_str)
}

/// A boolean cell reads as Excel reports it, so a Checks tie-out shows true or false on both backends rather than `1` on
/// one of them. A number reads as a number for the same reason: Excel hands 1240 back as 1240, and a value compared
/// against a model's own arithmetic must not depend on which backend opened the workbook.
fn typed_cell_value(cell_type: &str, raw: &str, strings: &[String]) -> CellValue {
    if cell_type == "s" {
        return CellValue::Text(shared_string(strings, raw).unwrap_or(raw).to_owned());
    }
    if cell_type == "b" && !raw.is_empty() {
        return CellValue::Bool(raw == "1");
    }
    if cell_type.is_empty() || cell_type == "n" {
        return numeric_cell_value(raw);
    }
    CellValue::Text(raw.to_owned())
}

static SHARED_STRING_ITEM: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<si(?:\s[^>]*)?>([\s\S]*?)<\/si>", "g"));

/// `sharedStrings(zip)`: the text of each item of xl/sharedStrings.xml.
pub fn shared_strings(zip: &Package) -> Vec<String> {
    let xml = zip.text("xl/sharedStrings.xml");
    if xml.is_empty() {
        return Vec::new();
    }
    SHARED_STRING_ITEM.captures_iter(&xml).map(|found| paragraph_texts(found.get(1).unwrap_or(""), "t").join("")).collect()
}

/// The corners of a range of cells.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Bounds {
    start_row: u64,
    end_row: u64,
    start_col: f64,
    end_col: f64,
}

static RANGE_PARTS: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^([^:]+):([^:]+)$", ""));

/// `snapshotRangeBounds(reference)`: `None` when the text is not `A1:B2`; an error when a corner is not a cell.
fn snapshot_range_bounds(reference: &str) -> Result<Option<Bounds>, String> {
    let Some(found) = RANGE_PARTS.captures(js_trim(reference)) else { return Ok(None) };
    let start = parse_cell_ref(found.get(1).unwrap_or(""))?;
    let end = parse_cell_ref(found.get(2).unwrap_or(""))?;
    Ok(Some(Bounds {
        start_row: start.row,
        end_row: end.row,
        start_col: column_number(&start.col),
        end_col: column_number(&end.col),
    }))
}

fn cell_in_bounds(reference: &str, bounds: Option<&Bounds>) -> Result<bool, String> {
    let Some(bounds) = bounds else { return Ok(true) };
    let parsed = parse_cell_ref(reference)?;
    let column = column_number(&parsed.col);
    Ok(parsed.row >= bounds.start_row && parsed.row <= bounds.end_row && column >= bounds.start_col && column <= bounds.end_col)
}

/// A cell element of a sheet: its attributes, its reference and what lies inside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SheetCell<'a> {
    pub attributes: &'a str,
    pub reference: &'a str,
    pub body: &'a str,
}

// A body is read as "anything up to the first `</c>`" in the form `(?:[^<]|<(?!\/c>))*`, the text a lazy `[\s\S]*?` takes: the
// engine runs a lazy any-character loop to the end of the text before it tries the first stop, so every match of a sheet cost
// the length of the sheet (20,001 formula cells took minutes).
static SHEET_CELL: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r#"<c\b([^>]*?\br="([A-Z]+\d+)"[^>]*?)\/>|<c\b([^>]*\br="([A-Z]+\d+)"[^>]*)>((?:[^<]|<(?!\/c>))*)<\/c>"#, "g")
});

/// `iterateSheetCells(xml)`.
pub fn iterate_sheet_cells(xml: &str) -> Vec<SheetCell<'_>> {
    SHEET_CELL
        .captures_iter(xml)
        .map(|found| SheetCell {
            attributes: found.get(1).or_else(|| found.get(3)).unwrap_or(""),
            reference: found.get(2).or_else(|| found.get(4)).unwrap_or(""),
            body: found.get(5).unwrap_or(""),
        })
        .collect()
}

/// A row element of a sheet: its attributes and what lies inside it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SheetRow<'a> {
    pub attributes: &'a str,
    pub body: &'a str,
}

static SHEET_ROW: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"<row\b([^>]*?)\/>|<row\b([^>]*)>((?:[^<]|<(?!\/row>))*)<\/row>", "g"));

/// `iterateSheetRows(xml)`.
pub fn iterate_sheet_rows(xml: &str) -> Vec<SheetRow<'_>> {
    SHEET_ROW
        .captures_iter(xml)
        .map(|found| SheetRow { attributes: found.get(1).or_else(|| found.get(2)).unwrap_or(""), body: found.get(3).unwrap_or("") })
        .collect()
}

static FORMULA_OPEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<f\b([^>]*)>", ""));
static FORMULA_ANY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<f\b", ""));
static ARRAY_TYPE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bt="array""#, ""));
static REF_ATTRIBUTE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bref="([^"]+)""#, ""));
static VALUE_ELEMENT: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"<v(?:\s[^>]*)?>([\s\S]*?)<\/v>|<v(?:\s[^>]*)?\/>", ""));
static TYPE_ATTRIBUTE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bt="([^"]*)""#, ""));
static FORMULA_TEXT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<f(?:\s[^>]*)?>([\s\S]*?)<\/f>", ""));
static VALUE_TEXT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<v(?:\s[^>]*)?>([\s\S]*?)<\/v>", ""));
static VALUE_OPEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<v(?:\s[^>]*)?\/?>", ""));
static STYLE_ATTRIBUTE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bs="(\d+)""#, ""));
static TEXT_TYPE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bt="([^"]+)""#, ""));
static STR_TYPE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bt="str""#, ""));

/// A cached result of a formula, in the form [`write_cached_values`] stores: `kind` is empty for a number, `str`, `b` or
/// `e`; `text` is XML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedValue {
    pub kind: String,
    pub text: String,
}

/// `computedCellValues(xml, strings)`: the results a calculated sheet carries, by cell: each formula's, and the rest of an
/// array block's, whose formula stands in its first cell alone. A shared-string result is carried as text. The cells in
/// the order the sheet lists them.
pub fn computed_cell_values(xml: &str, strings: &[String]) -> Result<Vec<(String, CachedValue)>, String> {
    let cells = iterate_sheet_cells(xml);
    let mut blocks = Vec::new();
    for cell in &cells {
        let attributes = group_one(&FORMULA_OPEN, cell.body).unwrap_or_default();
        if !ARRAY_TYPE.is_match(&attributes) {
            continue;
        }
        if let Some(bounds) = snapshot_range_bounds(&group_one(&REF_ATTRIBUTE, &attributes).unwrap_or_default())? {
            blocks.push(bounds);
        }
    }
    let mut computed: Vec<(String, CachedValue)> = Vec::new();
    for cell in &cells {
        if !FORMULA_ANY.is_match(cell.body) {
            let mut inside = false;
            for bounds in &blocks {
                if cell_in_bounds(cell.reference, Some(bounds))? {
                    inside = true;
                    break;
                }
            }
            if !inside {
                continue;
            }
        }
        let Some(value) = VALUE_ELEMENT.captures(cell.body) else { continue };
        let cell_type = group_one(&TYPE_ATTRIBUTE, cell.attributes).unwrap_or_default();
        let text = value.get(1).unwrap_or("");
        let cached = if cell_type == "s" {
            CachedValue { kind: "str".to_owned(), text: xml_encode(shared_string(strings, text).unwrap_or("")) }
        } else {
            CachedValue { kind: if cell_type == "n" { String::new() } else { cell_type }, text: text.to_owned() }
        };
        match computed.iter_mut().find(|(known, _)| known == cell.reference) {
            Some(entry) => entry.1 = cached,
            None => computed.push((cell.reference.to_owned(), cached)),
        }
    }
    Ok(computed)
}

static CELL_ELEMENT: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)", "g"));
static CELL_REF: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\br="([A-Z]+\d+)""#, ""));
static FORMULA_ELEMENT: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"<f(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/f>)", ""));
static TYPE_WITH_SPACE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\st="[^"]*""#, "g"));
static TRAILING_SLASH: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\s*\/$", ""));

/// `writeCachedValues(xml, cached)`: how Excel stores a computed result: the cell keeps its formula and carries the value
/// beside it, typed the way the reader expects it back. Only the first cell of an array block holds the formula; the rest
/// of the block carries the value alone, which is how Excel writes them too.
pub fn write_cached_values(xml: &str, cached: &[(String, CachedValue)]) -> String {
    let by_ref: HashMap<&str, &CachedValue> = cached.iter().map(|(reference, value)| (reference.as_str(), value)).collect();
    CELL_ELEMENT.replace_all_with(xml, |found| {
        let whole = &xml[found.range()];
        let attributes = found.get(1).unwrap_or("");
        let Some(value) = group_one(&CELL_REF, attributes).and_then(|reference| by_ref.get(reference.as_str()).copied()) else {
            return whole.to_owned();
        };
        let body = found.get(2).unwrap_or("");
        let formula = FORMULA_ELEMENT.find(body).map(|range| body[range].to_owned()).unwrap_or_default();
        let without_type = TYPE_WITH_SPACE.replace_all_with(attributes, |_| String::new());
        let kept = match TRAILING_SLASH.find(&without_type) {
            Some(range) => format!("{}{}", &without_type[..range.start], &without_type[range.end..]),
            None => without_type,
        };
        let typed = if value.kind.is_empty() { String::new() } else { format!(" t=\"{}\"", value.kind) };
        format!("<c{kept}{typed}>{formula}<v>{}</v></c>", value.text)
    })
}

/// What a cell records about its formula.
#[derive(Debug, Clone, PartialEq)]
pub struct FormulaInfo {
    pub formula: String,
    /// The cached result; `None` when the file carries none.
    pub cached_value: Option<CellValue>,
    /// `present`, or `missing` for a workbook waiting for its first recalculation.
    pub cache_state: &'static str,
}

/// A cell as the snapshot reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct CellRecord {
    pub reference: String,
    pub value: CellValue,
    /// The flag that tells a reader that `'1,234'` is text Excel will not sum, rather than the number it looks like.
    pub text_type: bool,
    pub formula: Option<FormulaInfo>,
    pub style: Option<Value>,
}

impl CellRecord {
    /// The record as the Node reader returned it: `{ ref, value, dataType?, formula?, cachedValue?, cacheState?, style? }`.
    pub fn to_json(&self) -> Value {
        let mut record = Map::new();
        record.insert("ref".to_owned(), Value::from(self.reference.as_str()));
        record.insert("value".to_owned(), self.value.to_json());
        if self.text_type {
            record.insert("dataType".to_owned(), Value::from("text"));
        }
        if let Some(info) = &self.formula {
            record.insert("formula".to_owned(), Value::from(info.formula.as_str()));
            record.insert("cachedValue".to_owned(), info.cached_value.as_ref().map_or(Value::Null, CellValue::to_json));
            record.insert("cacheState".to_owned(), Value::from(info.cache_state));
        }
        if let Some(style) = &self.style {
            record.insert("style".to_owned(), style.clone());
        }
        Value::Object(record)
    }
}

fn cell_record(cell: &SheetCell<'_>, strings: &[String], styles: Option<&[Value]>) -> CellRecord {
    let attrs = cell.attributes;
    let body = cell.body;
    let cell_type = group_one(&TEXT_TYPE, attrs).unwrap_or_default();
    let formula = xml_decode(&group_one(&FORMULA_TEXT, body).unwrap_or_default());
    let mut raw = String::new();
    let value = if cell_type == "inlineStr" {
        CellValue::Text(paragraph_texts(body, "t").join(""))
    } else {
        raw = xml_decode(&group_one(&VALUE_TEXT, body).unwrap_or_default());
        typed_cell_value(&cell_type, &raw, strings)
    };
    // A cache is present when the file carries a <v> element at all: a formula whose result is the empty string
    // (IF(C7=0,"",...)) is written as <v></v> by Excel and LibreOffice alike, and that is a computed value, not a workbook
    // waiting for its first recalculation. Excel itself writes that empty result as a self-closing <v/>.
    let empty_string_cache = raw.is_empty() && cell_type == "str" && VALUE_OPEN.is_match(body);
    let cached_value = if raw.is_empty() {
        if empty_string_cache { Some(CellValue::Text(String::new())) } else { None }
    } else {
        Some(value.clone())
    };
    let cache_state = if raw.is_empty() && !empty_string_cache { "missing" } else { "present" };
    // Style index 0 is the workbook default; only an explicit style is reported.
    let style_index = group_one(&STYLE_ATTRIBUTE, attrs).and_then(|digits| digits.parse::<usize>().ok()).unwrap_or(0);
    let style = if style_index > 0 { styles.and_then(|list| list.get(style_index)).filter(|style| truthy(style)).cloned() } else { None };
    CellRecord {
        reference: cell.reference.to_owned(),
        value,
        text_type: matches!(cell_type.as_str(), "s" | "str" | "inlineStr"),
        formula: if formula.is_empty() { None } else { Some(FormulaInfo { formula, cached_value, cache_state }) },
        style,
    }
}

/// `cellRecords(xml, strings, { styles })`: every cell of a sheet.
pub fn cell_records(xml: &str, strings: &[String], styles: Option<&[Value]>) -> Vec<CellRecord> {
    iterate_sheet_cells(xml).iter().map(|cell| cell_record(cell, strings, styles)).collect()
}

/// The page of cells a paged read returns.
#[derive(Debug, Clone, PartialEq)]
pub struct CellPage {
    pub offset: f64,
    pub limit: f64,
    pub range: Option<String>,
}

impl CellPage {
    /// `Math.max(0, Number(offset) || 0)`, `Math.max(1, Number(limit) || 2000)`, and the range when one is named.
    pub fn new(offset: f64, limit: f64, range: Option<&str>) -> Self {
        let offset = if offset.is_nan() || offset == 0.0 { 0.0 } else { offset };
        let limit = if limit.is_nan() || limit == 0.0 { 2_000.0 } else { limit };
        Self { offset: math::max(0.0, offset), limit: math::max(1.0, limit), range: range.map(str::to_owned) }
    }
}

/// One page of cells and the totals of the sheet it was read from.
#[derive(Debug, Clone, PartialEq)]
pub struct PagedCells {
    pub records: Vec<CellRecord>,
    /// How many cells lie inside the range.
    pub total: usize,
    pub formula_count: usize,
    pub formula_cache_missing: usize,
}

/// `cellRecords(xml, strings, { paged: true, offset, limit, range, styles })`: the records from `offset` on, at most
/// `limit` of them, among the cells inside `range`; the totals count every cell in range.
pub fn paged_cell_records(xml: &str, strings: &[String], styles: Option<&[Value]>, page: &CellPage) -> Result<PagedCells, String> {
    let bounds = match &page.range {
        Some(range) => snapshot_range_bounds(range)?,
        None => None,
    };
    let mut records = Vec::new();
    let mut total = 0_usize;
    let mut formula_count = 0;
    let mut formula_cache_missing = 0;
    for cell in iterate_sheet_cells(xml) {
        if !cell_in_bounds(cell.reference, bounds.as_ref())? {
            continue;
        }
        let record = cell_record(&cell, strings, styles);
        if let Some(info) = &record.formula {
            formula_count += 1;
            if info.cache_state == "missing" {
                formula_cache_missing += 1;
            }
        }
        if total as f64 >= page.offset && (records.len() as f64) < page.limit {
            records.push(record);
        }
        total += 1;
    }
    Ok(PagedCells { records, total, formula_count, formula_cache_missing })
}

/// `sheetFormulaTotals(xml)`: formula totals for one sheet without materializing its cells. A snapshot that returns a
/// single page still has to state the workbook's calculation state truthfully, and that answer depends on every sheet.
/// Returns the number of formulas and the number whose cached result is missing.
pub fn sheet_formula_totals(xml: &str) -> (usize, usize) {
    let mut formula_count = 0;
    let mut formula_cache_missing = 0;
    for cell in iterate_sheet_cells(xml) {
        let formula = group_one(&FORMULA_TEXT, cell.body).unwrap_or_default();
        if formula.is_empty() {
            continue;
        }
        formula_count += 1;
        // The same reading as the cell record: an empty string result (IF(C6="","",...) on a blank entry row, t="str" with
        // <v></v>) is a computed value. Counted as missing here, every Excel-saved form with blank entry rows was reported
        // as a workbook never calculated.
        let cached = group_one(&VALUE_TEXT, cell.body).unwrap_or_default();
        let empty_string = cached.is_empty() && STR_TYPE.is_match(cell.attributes) && VALUE_OPEN.is_match(cell.body);
        if cached.is_empty() && !empty_string {
            formula_cache_missing += 1;
        }
    }
    (formula_count, formula_cache_missing)
}

/// `booleanXmlAttribute(attributes, name)`: whether the attribute is `1`, `true` or `on`.
pub fn boolean_xml_attribute(attributes: &str, name: &str) -> bool {
    let value = group_one(&compiled(&format!(r#"\b{name}="([^"]+)""#), "i"), attributes).unwrap_or_default();
    static TRUTHY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^(?:1|true|on)$", "i"));
    TRUTHY.is_match(&value)
}

/// How a workbook calculates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Calculation {
    pub mode: String,
    pub full_calc_on_load: bool,
    pub force_full_calc: bool,
}

static CALC_PR: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<calcPr\b([^>]*)\/?>", "i"));
static CALC_MODE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\bcalcMode="([^"]+)""#, "i"));

/// `workbookCalculation(xml)`: the calcPr of xl/workbook.xml.
pub fn workbook_calculation(xml: &str) -> Calculation {
    let attributes = group_one(&CALC_PR, xml).unwrap_or_default();
    Calculation {
        mode: group_one(&CALC_MODE, &attributes).unwrap_or_default(),
        full_calc_on_load: boolean_xml_attribute(&attributes, "fullCalcOnLoad"),
        force_full_calc: boolean_xml_attribute(&attributes, "forceFullCalc"),
    }
}

/// A cell a formula reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormulaReference {
    pub sheet: String,
    pub reference: String,
    /// `/sheet[name]/cell[A1]`.
    pub path: String,
}

static FORMULA_REFERENCE: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"(?:(?:'([^']+)'|([A-Za-z0-9_ .-]+))!)?\$?([A-Z]{1,3})\$?([1-9]\d*)", "g")
});

/// `formulaReferences(formula, currentSheet)`: the cells a formula names, each once (the sheet and cell compared without
/// regard to case), in the order they appear; a cell without a sheet is on `current_sheet`.
pub fn formula_references(formula: &str, current_sheet: &str) -> Vec<FormulaReference> {
    let mut references = Vec::new();
    let mut seen = HashSet::new();
    for found in FORMULA_REFERENCE.captures_iter(formula) {
        let sheet = found.get(1).filter(|text| !text.is_empty()).or_else(|| found.get(2).filter(|text| !text.is_empty())).unwrap_or(current_sheet);
        let reference = format!("{}{}", found.get(3).unwrap_or(""), found.get(4).unwrap_or(""));
        if !seen.insert(js_to_lowercase(&format!("{sheet}!{reference}"))) {
            continue;
        }
        references.push(FormulaReference { sheet: sheet.to_owned(), path: format!("/sheet[{sheet}]/cell[{reference}]"), reference });
    }
    references
}

/// What a write puts in a cell: the text of a value read as `String(value)` unless it is a finite number or a boolean.
fn cell_xml(reference: &str, value: &Value, formula: &str, style: Option<&str>) -> String {
    let styled = style.map_or_else(String::new, |style| format!(" s=\"{style}\""));
    if !formula.is_empty() {
        let normalized = formula.strip_prefix('=').unwrap_or(formula);
        return format!("<c r=\"{reference}\"{styled}><f>{}</f><v></v></c>", xml_encode(normalized));
    }
    match value {
        Value::Number(number) => format!("<c r=\"{reference}\"{styled}><v>{}</v></c>", number_to_string(number.as_f64().unwrap_or(f64::NAN))),
        Value::Bool(flag) => format!("<c r=\"{reference}\"{styled} t=\"b\"><v>{}</v></c>", u8::from(*flag)),
        other => {
            let text = if other.is_null() { String::new() } else { value_to_string(other) };
            let preserve = text.chars().next().is_some_and(mixdog_js::is_js_space) || text.chars().next_back().is_some_and(mixdog_js::is_js_space);
            format!(
                "<c r=\"{reference}\"{styled} t=\"inlineStr\"><is><t{}>{}</t></is></c>",
                if preserve { " xml:space=\"preserve\"" } else { "" },
                xml_encode(&text)
            )
        }
    }
}

/// The style index of the first cell element with this reference, as the digits written; empty when it carries none.
fn existing_cell_style(xml: &str, reference: &str) -> String {
    let pattern = compiled(&format!(r#"<c\b([^>]*\br="{reference}"[^>]*?)(?:\/>|>)"#), "i");
    match group_one(&pattern, xml) {
        Some(attributes) => group_one(&STYLE_ATTRIBUTE, &attributes).unwrap_or_default(),
        None => String::new(),
    }
}

/// `forceWorkbookRecalculation(xml)`: the workbook's calcPr set to calculate everything when it is opened.
pub fn force_workbook_recalculation(xml: &str) -> String {
    static CALC_PR_ANY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<calcPr\b", "i"));
    if CALC_PR_ANY.is_match(xml) {
        let Some(found) = CALC_PR.captures(xml) else { return xml.to_owned() };
        let range = found.range();
        let attributes = found.get(1).unwrap_or("");
        let attributes = match TRAILING_SPACE_SLASH.find(attributes) {
            Some(slash) => attributes[..slash.start].to_owned(),
            None => attributes.to_owned(),
        };
        let attributes = set_xml_attribute(&attributes, "calcMode", "auto");
        let attributes = set_xml_attribute(&attributes, "fullCalcOnLoad", "1");
        let attributes = set_xml_attribute(&attributes, "forceFullCalc", "1");
        return format!("{}<calcPr{attributes}/>{}", &xml[..range.start], &xml[range.end..]);
    }
    static WORKBOOK_CLOSE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"<\/workbook>", "i"));
    match WORKBOOK_CLOSE.find(xml) {
        Some(range) => format!(
            "{}<calcPr calcMode=\"auto\" fullCalcOnLoad=\"1\" forceFullCalc=\"1\"/></workbook>{}",
            &xml[..range.start],
            &xml[range.end..]
        ),
        None => xml.to_owned(),
    }
}

static TRAILING_SPACE_SLASH: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\/\s*$", ""));
static ROW_OPEN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^<row\b([^>]*?)(?:\/>|>)", ""));
static CELL_REF_ANY_CASE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\br="([A-Za-z]+\d+)""#, ""));
static ROW_INDEX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r#"\br="(\d+)""#, ""));
static SHEET_DATA: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"<sheetData(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/sheetData>)", ""));

/// The upper-cased reference an element's attributes carry (`r="a1"` reads as `A1`); empty when it carries none.
fn element_reference(attrs: &str) -> String {
    group_one(&CELL_REF_ANY_CASE, attrs).unwrap_or_default().to_uppercase()
}

/// `Number(digits)` of a row index, saturating where the digits exceed 64 bits.
fn row_index(attrs: &str) -> u64 {
    group_one(&ROW_INDEX, attrs).map_or(0, |digits| digits.parse::<u64>().unwrap_or(u64::MAX))
}

fn sheet_data_of(xml: &str) -> Result<std::ops::Range<usize>, String> {
    SHEET_DATA.find(xml).ok_or_else(|| "Worksheet is missing sheetData".to_owned())
}

/// `setRowCell`: the cell written into a row: in place of the one with its reference, else before the first cell of a
/// later column, else last.
fn set_row_cell(row_xml: &str, reference: &str, column: f64, cell: &str) -> Result<String, String> {
    let attrs = group_one(&ROW_OPEN, row_xml).unwrap_or_default();
    let body = container_body(row_xml, "row");
    let mut cells = Vec::new();
    for span in element_spans(&body, "c") {
        let span_reference = element_reference(&span.attrs);
        if !span_reference.is_empty() {
            cells.push((span, span_reference));
        }
    }
    if let Some((existing, _)) = cells.iter().find(|(_, span_reference)| span_reference == reference) {
        return Ok(format!("<row{attrs}>{}{cell}{}</row>", &body[..existing.start], &body[existing.end..]));
    }
    let mut position = body.len();
    for (span, span_reference) in &cells {
        if column_number(&parse_cell_ref(span_reference)?.col) > column {
            position = span.start;
            break;
        }
    }
    Ok(format!("<row{attrs}>{}{cell}{}</row>", &body[..position], &body[position..]))
}

/// `placeCellInSheet`: the cell written into the sheet, creating its row (in row order) when the sheet has none.
fn place_cell_in_sheet(xml: &str, reference: &str, cell: &str) -> Result<String, String> {
    let parsed = parse_cell_ref(reference)?;
    let column = column_number(&parsed.col);
    let data = sheet_data_of(xml)?;
    let inner = container_body(&xml[data.clone()], "sheetData");
    let rows: Vec<(crate::xml::Span, u64)> = element_spans(&inner, "row").into_iter().map(|span| {
        let index = row_index(&span.attrs);
        (span, index)
    }).collect();
    let next_inner = match rows.iter().find(|(_, index)| *index == parsed.row) {
        Some((existing, _)) => format!(
            "{}{}{}",
            &inner[..existing.start],
            set_row_cell(&existing.xml, &parsed.reference, column, cell)?,
            &inner[existing.end..]
        ),
        None => {
            let position = rows.iter().find(|(_, index)| *index > parsed.row).map_or(inner.len(), |(span, _)| span.start);
            format!("{}<row r=\"{}\">{cell}</row>{}", &inner[..position], parsed.row, &inner[position..])
        }
    };
    Ok(format!("{}<sheetData>{next_inner}</sheetData>{}", &xml[..data.start], &xml[data.end..]))
}

/// `setCellInSheet(xml, ref, value, formula)`: one cell written, keeping the style it already carries.
pub fn set_cell_in_sheet(xml: &str, reference: &str, value: &Value, formula: &str) -> Result<String, String> {
    let parsed = parse_cell_ref(reference)?;
    let style = existing_cell_style(xml, &parsed.reference);
    let style = if style.is_empty() { None } else { Some(style) };
    place_cell_in_sheet(xml, &parsed.reference, &cell_xml(&parsed.reference, value, formula, style.as_deref()))
}

/// A cell of a sheet held by the bulk writers: its attributes and its XML.
struct HeldCell {
    attrs: String,
    xml: String,
}

/// A row of a sheet held by the bulk writers.
struct HeldRow {
    attrs: String,
    cells: BTreeMap<u64, HeldCell>,
}

/// `readSheetRows(xml)`: the sheet as rows of cells, parsed once. Writing cell by cell means rebuilding the whole
/// worksheet string for each one, which turns a few thousand rows into minutes; a bulk write reads the sheet once and
/// serializes it once.
fn read_sheet_rows(xml: &str) -> Result<(std::ops::Range<usize>, BTreeMap<u64, HeldRow>), String> {
    let data = sheet_data_of(xml)?;
    let inner = container_body(&xml[data.clone()], "sheetData");
    let mut rows = BTreeMap::new();
    for span in element_spans(&inner, "row") {
        let index = row_index(&span.attrs);
        if index == 0 {
            continue;
        }
        let mut cells = BTreeMap::new();
        for cell in element_spans(&container_body(&span.xml, "row"), "c") {
            let reference = element_reference(&cell.attrs);
            if !reference.is_empty() {
                let column = column_number(&parse_cell_ref(&reference)?.col) as u64;
                cells.insert(column, HeldCell { attrs: cell.attrs, xml: cell.xml });
            }
        }
        rows.insert(index, HeldRow { attrs: span.attrs, cells });
    }
    Ok((data, rows))
}

fn write_sheet_rows(xml: &str, data: &std::ops::Range<usize>, rows: &BTreeMap<u64, HeldRow>) -> String {
    let mut body = String::new();
    for (index, row) in rows {
        let cells: String = row.cells.values().map(|cell| cell.xml.as_str()).collect();
        let attrs = if row.attrs.is_empty() { format!(" r=\"{index}\"") } else { row.attrs.clone() };
        body.push_str(&format!("<row{attrs}>{cells}</row>"));
    }
    format!("{}<sheetData>{body}</sheetData>{}", &xml[..data.start], &xml[data.end..])
}

/// A write of [`set_cells_in_sheet`].
#[derive(Debug, Clone, Copy)]
pub struct CellEntry<'a> {
    pub reference: &'a str,
    pub value: &'a Value,
    /// A formula (with or without the leading `=`); empty for a value.
    pub formula: &'a str,
}

/// `setCellsInSheet(xml, entries)`: many cells written in one pass. Each carries the style index the cell had when the
/// pass read it, written even when it is `0`; a cell written twice in one pass loses it the second time.
pub fn set_cells_in_sheet(xml: &str, entries: &[CellEntry<'_>]) -> Result<String, String> {
    if entries.is_empty() {
        return Ok(xml.to_owned());
    }
    let (data, mut rows) = read_sheet_rows(xml)?;
    for entry in entries {
        let parsed = parse_cell_ref(entry.reference)?;
        let column = column_number(&parsed.col) as u64;
        let row = rows.entry(parsed.row).or_insert_with(|| HeldRow { attrs: format!(" r=\"{}\"", parsed.row), cells: BTreeMap::new() });
        let style = row
            .cells
            .get(&column)
            .and_then(|cell| group_one(&STYLE_ATTRIBUTE, &cell.attrs))
            .and_then(|digits| digits.parse::<u64>().ok())
            .unwrap_or(0);
        row.cells.insert(column, HeldCell { attrs: String::new(), xml: cell_xml(&parsed.reference, entry.value, entry.formula, Some(&style.to_string())) });
    }
    Ok(write_sheet_rows(xml, &data, &rows))
}

#[cfg(test)]
thread_local! {
    /// How many held cells and written cells a test's thread looked at while placing formulas in rows.
    static ROW_PROBES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Formulas written in one pass over the sheet, each into its cell as a single write of it would: the style the cell already carries is
/// kept as written, a cell with none gets none, and every other part of the sheet (the rows and cells not written, a row's other
/// children such as its `extLst`) stays as it was. Only the rows that receive a formula are rebuilt.
pub fn set_formulas_in_sheet(xml: &str, entries: &[(String, String)]) -> Result<String, String> {
    let data = sheet_data_of(xml)?;
    let inner = container_body(&xml[data.clone()], "sheetData");
    // row number -> column -> (reference, formula); a cell written twice keeps the later formula.
    let mut wanted: BTreeMap<u64, BTreeMap<u64, (String, String)>> = BTreeMap::new();
    for (reference, formula) in entries {
        let parsed = parse_cell_ref(reference)?;
        wanted.entry(parsed.row).or_default().insert(column_number(&parsed.col) as u64, (parsed.reference, formula.clone()));
    }
    let mut body = String::with_capacity(inner.len());
    let mut taken = 0;
    for span in element_spans(&inner, "row") {
        let index = row_index(&span.attrs);
        // Rows that did not exist and come before this one are made in row order.
        while index != 0 && let Some(next) = wanted.keys().next().copied().filter(|next| *next < index) {
            let cells = wanted.remove(&next).unwrap_or_default();
            body.push_str(&inner[taken..span.start]);
            taken = span.start;
            body.push_str(&new_row(next, &cells));
        }
        body.push_str(&inner[taken..span.start]);
        taken = span.end;
        match wanted.remove(&index).filter(|_| index != 0) {
            Some(cells) => body.push_str(&rebuilt_row(&span, &cells)?),
            None => body.push_str(&span.xml),
        }
    }
    body.push_str(&inner[taken..]);
    for (index, cells) in wanted {
        body.push_str(&new_row(index, &cells));
    }
    Ok(format!("{}<sheetData>{body}</sheetData>{}", &xml[..data.start], &xml[data.end..]))
}

fn new_row(index: u64, cells: &BTreeMap<u64, (String, String)>) -> String {
    let cells: String = cells.values().map(|(reference, formula)| cell_xml(reference, &Value::Null, formula, None)).collect();
    format!("<row r=\"{index}\">{cells}</row>")
}

/// A row with the formulas written into it: a cell it holds is replaced in place (its style kept), a new one goes before the first
/// cell of a later column or after the last cell; nothing else of the row moves.
fn rebuilt_row(row: &crate::xml::Span, cells: &BTreeMap<u64, (String, String)>) -> Result<String, String> {
    let attrs = group_one(&ROW_OPEN, &row.xml).unwrap_or_default();
    let body = container_body(&row.xml, "row");
    let held: Vec<(crate::xml::Span, u64)> = element_spans(&body, "c")
        .into_iter()
        .filter_map(|span| {
            let reference = element_reference(&span.attrs);
            (!reference.is_empty()).then(|| parse_cell_ref(&reference).map(|parsed| (span, column_number(&parsed.col) as u64)))
        })
        .collect::<Result<_, _>>()?;
    // The held cells by column (the first of a column in the row's order), so each written cell finds its place in one lookup.
    let mut by_column: BTreeMap<u64, usize> = BTreeMap::new();
    for (at, (_, held_column)) in held.iter().enumerate() {
        #[cfg(test)]
        ROW_PROBES.with(|probes| probes.set(probes.get() + 1));
        by_column.entry(*held_column).or_insert(at);
    }
    // (where it goes, column, the cell, how much of the old text it replaces)
    let mut edits: Vec<(usize, u64, String, usize)> = Vec::new();
    for (column, (reference, formula)) in cells {
        #[cfg(test)]
        ROW_PROBES.with(|probes| probes.set(probes.get() + 1));
        match by_column.get(column) {
            Some(&at) => {
                let span = &held[at].0;
                let style = group_one(&STYLE_ATTRIBUTE, &span.attrs);
                edits.push((span.start, *column, cell_xml(reference, &Value::Null, formula, style.as_deref()), span.end - span.start));
            }
            None => {
                let later = by_column.range((std::ops::Bound::Excluded(*column), std::ops::Bound::Unbounded)).next();
                let at = later.map_or_else(|| held.last().map_or(0, |(span, _)| span.end), |(_, &held_at)| held[held_at].0.start);
                edits.push((at, *column, cell_xml(reference, &Value::Null, formula, None), 0));
            }
        }
    }
    edits.sort_by_key(|(at, column, ..)| (*at, *column));
    let (mut out, mut from) = (String::new(), 0);
    for (at, _, cell, replaced) in edits {
        out.push_str(&body[from..at]);
        out.push_str(&cell);
        from = at + replaced;
    }
    out.push_str(&body[from..]);
    Ok(format!("<row{attrs}>{out}</row>"))
}

/// A style to apply to a cell.
#[derive(Debug, Clone, Copy)]
pub struct CellStyle<'a> {
    pub reference: &'a str,
    /// The style index, as written into `s="..."`.
    pub style: &'a str,
}

/// `setCellStylesInSheet(xml, entries)`: a style index applied to many cells in one pass; a cell that does not exist yet is
/// created empty, the way a single styled write does.
pub fn set_cell_styles_in_sheet(xml: &str, entries: &[CellStyle<'_>]) -> Result<String, String> {
    if entries.is_empty() {
        return Ok(xml.to_owned());
    }
    let (data, mut rows) = read_sheet_rows(xml)?;
    for entry in entries {
        let parsed = parse_cell_ref(entry.reference)?;
        let column = column_number(&parsed.col) as u64;
        let row = rows.entry(parsed.row).or_insert_with(|| HeldRow { attrs: format!(" r=\"{}\"", parsed.row), cells: BTreeMap::new() });
        let held = match row.cells.get(&column) {
            Some(existing) => {
                let attrs = set_xml_attribute(&existing.attrs, "s", entry.style);
                let body = if existing.xml.ends_with("/>") { String::new() } else { container_body(&existing.xml, "c") };
                let xml = if body.is_empty() { format!("<c{attrs}/>") } else { format!("<c{attrs}>{body}</c>") };
                HeldCell { attrs, xml }
            }
            None => HeldCell {
                attrs: format!(" r=\"{}\" s=\"{}\"", parsed.reference, entry.style),
                xml: format!("<c r=\"{}\" s=\"{}\"/>", parsed.reference, entry.style),
            },
        };
        row.cells.insert(column, held);
    }
    Ok(write_sheet_rows(xml, &data, &rows))
}

/// `cellStyleIndexes(xml, refs)`: the style index each of these cells carries today (0 for none), read in one pass, by
/// reference in the order given.
pub fn cell_style_indexes(xml: &str, references: &[&str]) -> Result<Vec<(String, u64)>, String> {
    let (_, rows) = read_sheet_rows(xml)?;
    let mut indexes: Vec<(String, u64)> = Vec::new();
    for reference in references {
        let parsed = parse_cell_ref(reference)?;
        let attrs = rows.get(&parsed.row).and_then(|row| row.cells.get(&(column_number(&parsed.col) as u64))).map_or("", |cell| cell.attrs.as_str());
        let index = group_one(&STYLE_ATTRIBUTE, attrs).and_then(|digits| digits.parse::<u64>().ok()).unwrap_or(0);
        match indexes.iter_mut().find(|(known, _)| *known == parsed.reference) {
            Some(entry) => entry.1 = index,
            None => indexes.push((parsed.reference, index)),
        }
    }
    Ok(indexes)
}

/// The corners of a range, as numbers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RangeBounds {
    pub start_col: f64,
    pub start_row: f64,
    pub end_col: f64,
    pub end_row: f64,
}

/// `expandRange(range)`: One cell is a range too: Excel reads `A10` as `A10:A10`, and refusing it made a one-cell
/// set_range fail its batch.
pub fn expand_range(range: &str) -> Result<RangeBounds, String> {
    static SINGLE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^[A-Z]+\d+$", "i"));
    static SPAN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^([A-Z]+)(\d+):([A-Z]+)(\d+)$", "i"));
    let text = js_trim(range);
    let doubled = format!("{text}:{text}");
    let subject = if SINGLE.is_match(text) { doubled.as_str() } else { text };
    let Some(found) = SPAN.captures(subject) else { return Err(format!("Invalid range: {range}")) };
    Ok(RangeBounds {
        start_col: column_number(found.get(1).unwrap_or("")),
        start_row: string_to_number(found.get(2).unwrap_or("")),
        end_col: column_number(found.get(3).unwrap_or("")),
        end_row: string_to_number(found.get(4).unwrap_or("")),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const SHEET: &str = "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\"><v>12.5</v></c><c r=\"C1\" t=\"b\"><v>1</v></c></row><row r=\"3\"><c r=\"A3\" s=\"2\" t=\"str\"><f>IF(A1=\"\",\"\",A1)</f><v></v></c><c r=\"B3\"><f>B1*2</f></c><c r=\"C3\" t=\"inlineStr\"><is><t>in line</t></is></c></row></sheetData></worksheet>";

    fn strings() -> Vec<String> {
        vec!["Name".to_owned(), "Tom & Jerry".to_owned()]
    }

    /// A sheet whose rows hold more than cells: a row's `extLst`, a styled cell, a merge and a row of attributes.
    const BUSY: &str = "<worksheet><sheetData><row r=\"1\" spans=\"1:3\" ht=\"20\" customHeight=\"1\"><c r=\"A1\" s=\"4\"><v>1</v></c><c r=\"C1\"><v>3</v></c><extLst><ext uri=\"{x}\"><v/></ext></extLst></row><row r=\"2\"><c r=\"A2\"><v>2</v></c><extLst><ext uri=\"{y}\"/></extLst></row><row r=\"4\"><c r=\"B4\"><v>9</v></c></row></sheetData><mergeCells count=\"1\"><mergeCell ref=\"A1:B1\"/></mergeCells></worksheet>";

    #[test]
    fn a_run_of_formulas_leaves_what_it_does_not_write_and_equals_writing_them_one_by_one() {
        // An existing styled cell, a cell of an untouched row, a new cell before a later column, and rows that do not exist yet.
        let entries: Vec<(String, String)> = [("A1", "=B2+1"), ("B1", "=A1*2"), ("A3", "=A2"), ("B3", "=A3"), ("C5", "=B4")]
            .iter()
            .map(|(reference, formula)| ((*reference).to_owned(), (*formula).to_owned()))
            .collect();
        let together = set_formulas_in_sheet(BUSY, &entries).expect("one pass");
        let mut one_by_one = BUSY.to_owned();
        for (reference, formula) in &entries {
            one_by_one = set_cell_in_sheet(&one_by_one, reference, &Value::Null, formula).expect("one cell");
        }
        assert_eq!(together, one_by_one);
        // The row the formulas did not reach keeps its children, and the rows they did reach keep their attributes and extLst.
        assert!(together.contains("<row r=\"2\"><c r=\"A2\"><v>2</v></c><extLst><ext uri=\"{y}\"/></extLst></row>"), "{together}");
        assert!(together.contains("<row r=\"1\" spans=\"1:3\" ht=\"20\" customHeight=\"1\">"), "{together}");
        assert!(together.contains("<extLst><ext uri=\"{x}\"><v/></ext></extLst></row>"), "{together}");
        assert!(together.contains("<c r=\"A1\" s=\"4\"><f>B2+1</f>"), "the style of a written cell is kept: {together}");
    }

    fn column_letters(mut number: usize) -> String {
        let mut letters = String::new();
        while number > 0 {
            letters.insert(0, (b'A' + ((number - 1) % 26) as u8) as char);
            number = (number - 1) / 26;
        }
        letters
    }

    #[test]
    fn a_wide_range_written_into_an_existing_row_looks_at_each_cell_a_constant_number_of_times() {
        // 100 held cells in odd columns; formulas go into 200 columns, half of them held: every cell is looked at once to file it
        // and once to place, however wide the row is.
        let held: String = (0..100).map(|k| format!("<c r=\"{}1\"><v>{k}</v></c>", column_letters(2 * k + 1))).collect();
        let xml = format!("<worksheet><sheetData><row r=\"1\">{held}</row></sheetData></worksheet>");
        let entries: Vec<(String, String)> = (1..=200).map(|k| (format!("{}1", column_letters(k)), "=1".to_owned())).collect();
        ROW_PROBES.with(|probes| probes.set(0));
        let written = set_formulas_in_sheet(&xml, &entries).expect("one pass");
        let probes = ROW_PROBES.with(std::cell::Cell::get);
        assert!(probes <= 100 + 200, "{probes} looks at cells for 100 held and 200 written");
        let mut one_by_one = xml.clone();
        for (reference, formula) in &entries {
            one_by_one = set_cell_in_sheet(&one_by_one, reference, &Value::Null, formula).expect("one cell");
        }
        assert_eq!(written, one_by_one);
    }

    #[test]
    fn a_cell_added_to_a_row_goes_before_the_row_children_that_are_not_cells() {
        let written = set_formulas_in_sheet(BUSY, &[("D1".to_owned(), "=A1".to_owned())]).expect("one pass");
        assert!(written.contains("<c r=\"D1\"><f>A1</f><v></v></c><extLst>"), "{written}");
    }

    #[test]
    fn a_workbooks_sheets_come_with_their_part_and_visibility() {
        let mut zip = Package::new();
        zip.set(
            "xl/workbook.xml",
            "<workbook><sheets><sheet name=\"Data &amp; Co\" sheetId=\"1\" r:id=\"rId1\"/><sheet name=\"Hidden\" sheetId=\"2\" state=\"veryHidden\" r:id=\"rId2\"/><sheet name=\"Lost\" sheetId=\"3\" r:id=\"rId9\"/><sheet name=\"Abs\" sheetId=\"4\" state=\"Hidden\" r:id=\"rId3\"/></sheets></workbook>",
        );
        zip.set(
            "xl/_rels/workbook.xml.rels",
            "<Relationships><Relationship Id=\"rId1\" Type=\"t\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"t\" Target=\"worksheets/sheet2.xml\"/><Relationship Id=\"rId3\" Type=\"t\" Target=\"/xl/worksheets/sheet3.xml\"/></Relationships>",
        );
        let sheets = workbook_sheets(&zip);
        let summary: Vec<(&str, &str, &str)> = sheets.iter().map(|s| (s.name.as_str(), s.path.as_str(), s.visibility)).collect();
        assert_eq!(
            summary,
            [
                ("Data & Co", "xl/worksheets/sheet1.xml", "visible"),
                ("Hidden", "xl/worksheets/sheet2.xml", "very_hidden"),
                ("Abs", "xl/worksheets/sheet3.xml", "hidden"),
            ]
        );
    }

    #[test]
    fn shared_strings_join_their_runs() {
        let mut zip = Package::new();
        zip.set("xl/sharedStrings.xml", "<sst><si><t>Name</t></si><si><r><t>Tom </t></r><r><t>&amp; Jerry</t></r></si></sst>");
        assert_eq!(shared_strings(&zip), strings());
        assert!(shared_strings(&Package::new()).is_empty());
    }

    #[test]
    fn records_carry_type_formula_cache_and_style() {
        let styles = vec![Value::Null, Value::Null, json!({ "numFmt": "0.0" })];
        let records: Vec<Value> = cell_records(SHEET, &strings(), Some(&styles)).iter().map(CellRecord::to_json).collect();
        assert_eq!(
            records,
            [
                json!({ "ref": "A1", "value": "Name", "dataType": "text" }),
                json!({ "ref": "B1", "value": 12.5 }),
                json!({ "ref": "C1", "value": true }),
                json!({ "ref": "A3", "value": "", "dataType": "text", "formula": "IF(A1=\"\",\"\",A1)", "cachedValue": "", "cacheState": "present", "style": { "numFmt": "0.0" } }),
                json!({ "ref": "B3", "value": "", "formula": "B1*2", "cachedValue": null, "cacheState": "missing" }),
                json!({ "ref": "C3", "value": "in line", "dataType": "text" }),
            ]
        );
    }

    #[test]
    fn an_empty_string_result_is_a_computed_value() {
        let xml = "<sheetData><row r=\"1\"><c r=\"A1\" t=\"str\"><f>X</f><v/></c><c r=\"B1\"><f>Y</f></c></row></sheetData>";
        let records = cell_records(xml, &[], None);
        assert_eq!(records[0].formula.as_ref().map(|f| (f.cache_state, f.cached_value.clone())), Some(("present", Some(CellValue::Text(String::new())))));
        assert_eq!(records[1].formula.as_ref().map(|f| f.cache_state), Some("missing"));
        assert_eq!(sheet_formula_totals(xml), (2, 1));
    }

    #[test]
    fn values_read_as_excel_reports_them() {
        assert_eq!(typed_cell_value("", "1240", &[]), CellValue::Number(1240.0));
        assert_eq!(typed_cell_value("n", "-.5e1", &[]), CellValue::Number(-5.0));
        assert_eq!(typed_cell_value("", "45292 ", &[]), CellValue::Text("45292 ".into()));
        assert_eq!(typed_cell_value("b", "0", &[]), CellValue::Bool(false));
        assert_eq!(typed_cell_value("b", "", &[]), CellValue::Text(String::new()));
        assert_eq!(typed_cell_value("s", "9", &strings()), CellValue::Text("9".into()));
        assert_eq!(typed_cell_value("s", "", &strings()), CellValue::Text("Name".into()));
        assert_eq!(typed_cell_value("e", "#N/A", &[]), CellValue::Text("#N/A".into()));
    }

    #[test]
    fn a_page_reads_a_window_of_the_cells_in_range() {
        let page = CellPage::new(1.0, 2.0, None);
        let paged = paged_cell_records(SHEET, &strings(), None, &page).unwrap();
        assert_eq!(paged.records.iter().map(|r| r.reference.as_str()).collect::<Vec<_>>(), ["B1", "C1"]);
        assert_eq!((paged.total, paged.formula_count, paged.formula_cache_missing), (6, 2, 1));
        let ranged = paged_cell_records(SHEET, &strings(), None, &CellPage::new(f64::NAN, 0.0, Some("A3:B3"))).unwrap();
        assert_eq!(ranged.records.iter().map(|r| r.reference.as_str()).collect::<Vec<_>>(), ["A3", "B3"]);
        assert_eq!(ranged.total, 2);
        assert_eq!(CellPage::new(-3.0, 0.2, None), CellPage { offset: 0.0, limit: 1.0, range: None });
        assert_eq!(paged_cell_records(SHEET, &[], None, &CellPage::new(0.0, 5.0, Some("A3:A0"))).unwrap_err(), "Invalid cell reference: A0");
    }

    #[test]
    fn cached_results_are_read_and_written_back_beside_the_formula() {
        let xml = "<sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><f>X</f><v>1</v></c><c r=\"B1\"><f>Y</f><v>3</v></c><c r=\"C1\"><v>5</v></c><c r=\"D1\"/></row></sheetData>";
        let computed = computed_cell_values(xml, &strings()).unwrap();
        assert_eq!(
            computed,
            [
                ("A1".to_owned(), CachedValue { kind: "str".into(), text: "Tom &amp; Jerry".into() }),
                ("B1".to_owned(), CachedValue { kind: String::new(), text: "3".into() }),
            ]
        );
        let written = write_cached_values(xml, &[("B1".to_owned(), CachedValue { kind: "str".into(), text: "ok".into() }), ("D1".to_owned(), CachedValue { kind: "e".into(), text: "#N/A".into() })]);
        assert_eq!(
            written,
            "<sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><f>X</f><v>1</v></c><c r=\"B1\" t=\"str\"><f>Y</f><v>ok</v></c><c r=\"C1\"><v>5</v></c><c r=\"D1\" t=\"e\"><v>#N/A</v></c></row></sheetData>"
        );
    }

    #[test]
    fn an_array_block_carries_the_value_of_its_covered_cells() {
        let xml = "<sheetData><row r=\"1\"><c r=\"A1\"><f t=\"array\" ref=\"A1:A2\">SEQUENCE(2)</f><v>1</v></c></row><row r=\"2\"><c r=\"A2\"><v>2</v></c><c r=\"B2\"><v>9</v></c></row></sheetData>";
        let computed = computed_cell_values(xml, &[]).unwrap();
        assert_eq!(computed.iter().map(|(reference, _)| reference.as_str()).collect::<Vec<_>>(), ["A1", "A2"]);
    }

    #[test]
    fn calculation_flags_and_forcing_a_recalculation() {
        let workbook = "<workbook><calcPr calcMode=\"manual\" fullCalcOnLoad=\"true\"/></workbook>";
        assert_eq!(workbook_calculation(workbook), Calculation { mode: "manual".into(), full_calc_on_load: true, force_full_calc: false });
        assert_eq!(
            force_workbook_recalculation(workbook),
            "<workbook><calcPr calcMode=\"auto\" fullCalcOnLoad=\"1\" forceFullCalc=\"1\"/></workbook>"
        );
        assert_eq!(
            force_workbook_recalculation("<workbook></workbook>"),
            "<workbook><calcPr calcMode=\"auto\" fullCalcOnLoad=\"1\" forceFullCalc=\"1\"/></workbook>"
        );
        assert!(!boolean_xml_attribute(" a=\"0\"", "a"));
        assert!(boolean_xml_attribute(" a=\"ON\"", "a"));
    }

    #[test]
    fn formula_references_are_listed_once_with_their_sheet() {
        let found = formula_references("SUM($A$1:B2)+'Q1 Sales'!C3+Data!c3+'q1 sales'!C3+A1", "Main");
        let summary: Vec<(&str, &str, &str)> = found.iter().map(|f| (f.sheet.as_str(), f.reference.as_str(), f.path.as_str())).collect();
        assert_eq!(
            summary,
            [
                ("Main", "A1", "/sheet[Main]/cell[A1]"),
                ("Main", "B2", "/sheet[Main]/cell[B2]"),
                ("Q1 Sales", "C3", "/sheet[Q1 Sales]/cell[C3]"),
            ]
        );
    }

    #[test]
    fn a_cell_is_written_keeping_its_style_and_in_order() {
        let sheet = "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" s=\"4\"><v>1</v></c><c r=\"C1\"><v>3</v></c></row><row r=\"5\"><c r=\"A5\"><v>5</v></c></row></sheetData></worksheet>";
        let replaced = set_cell_in_sheet(sheet, "a1", &json!("x"), "").unwrap();
        assert!(replaced.contains("<c r=\"A1\" s=\"4\" t=\"inlineStr\"><is><t>x</t></is></c>"), "{replaced}");
        let inserted = set_cell_in_sheet(sheet, "B1", &json!(2.5), "").unwrap();
        assert!(inserted.contains("<c r=\"A1\" s=\"4\"><v>1</v></c><c r=\"B1\"><v>2.5</v></c><c r=\"C1\">"), "{inserted}");
        let new_row = set_cell_in_sheet(sheet, "A3", &json!(true), "").unwrap();
        assert!(new_row.contains("</row><row r=\"3\"><c r=\"A3\" t=\"b\"><v>1</v></c></row><row r=\"5\">"), "{new_row}");
        let formula = set_cell_in_sheet(sheet, "D9", &Value::Null, "=SUM(A1:A5)").unwrap();
        assert!(formula.ends_with("<row r=\"9\"><c r=\"D9\"><f>SUM(A1:A5)</f><v></v></c></row></sheetData></worksheet>"), "{formula}");
        let padded = set_cell_in_sheet(sheet, "B2", &json!(" a "), "").unwrap();
        assert!(padded.contains("<t xml:space=\"preserve\"> a </t>"), "{padded}");
        assert_eq!(set_cell_in_sheet("<worksheet/>", "A1", &json!(1), "").unwrap_err(), "Worksheet is missing sheetData");
        assert_eq!(set_cell_in_sheet(sheet, "A0", &json!(1), "").unwrap_err(), "Invalid cell reference: A0");
    }

    #[test]
    fn many_cells_are_written_in_one_pass_with_the_style_they_had() {
        let sheet = "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" s=\"4\"><v>1</v></c></row></sheetData></worksheet>";
        let one = json!(1);
        let two = json!("b");
        let written = set_cells_in_sheet(
            sheet,
            &[
                CellEntry { reference: "B2", value: &two, formula: "" },
                CellEntry { reference: "A1", value: &one, formula: "" },
                CellEntry { reference: "B1", value: &one, formula: "=A1" },
            ],
        )
        .unwrap();
        assert_eq!(
            written,
            "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" s=\"4\"><v>1</v></c><c r=\"B1\" s=\"0\"><f>A1</f><v></v></c></row><row r=\"2\"><c r=\"B2\" s=\"0\" t=\"inlineStr\"><is><t>b</t></is></c></row></sheetData></worksheet>"
        );
        assert_eq!(set_cells_in_sheet(sheet, &[]).unwrap(), sheet);
    }

    #[test]
    fn styles_are_applied_to_existing_and_new_cells() {
        let sheet = "<worksheet><sheetData><row r=\"1\" ht=\"20\"><c r=\"A1\"><v>1</v></c><c r=\"B1\" s=\"1\"/></row></sheetData></worksheet>";
        let styled = set_cell_styles_in_sheet(
            sheet,
            &[CellStyle { reference: "A1", style: "7" }, CellStyle { reference: "B1", style: "8" }, CellStyle { reference: "C3", style: "2" }],
        )
        .unwrap();
        assert_eq!(
            styled,
            "<worksheet><sheetData><row r=\"1\" ht=\"20\"><c r=\"A1\" s=\"7\"><v>1</v></c><c r=\"B1\" s=\"8\"/></row><row r=\"3\"><c r=\"C3\" s=\"2\"/></row></sheetData></worksheet>"
        );
        assert_eq!(cell_style_indexes(sheet, &["a1", "B1", "Z9"]).unwrap(), [("A1".to_owned(), 0), ("B1".to_owned(), 1), ("Z9".to_owned(), 0)]);
    }

    #[test]
    fn a_range_is_expanded_and_a_single_cell_is_one() {
        assert_eq!(
            expand_range(" b2:D5 ").unwrap(),
            RangeBounds { start_col: 2.0, start_row: 2.0, end_col: 4.0, end_row: 5.0 }
        );
        assert_eq!(expand_range("A10").unwrap(), RangeBounds { start_col: 1.0, start_row: 10.0, end_col: 1.0, end_row: 10.0 });
        assert_eq!(expand_range("A1:B").unwrap_err(), "Invalid range: A1:B");
    }

    #[test]
    fn cells_and_rows_are_iterated_in_order() {
        let cells = iterate_sheet_cells(SHEET);
        assert_eq!(cells.iter().map(|c| c.reference).collect::<Vec<_>>(), ["A1", "B1", "C1", "A3", "B3", "C3"]);
        assert_eq!(cells[1], SheetCell { attributes: " r=\"B1\"", reference: "B1", body: "<v>12.5</v>" });
        let rows = iterate_sheet_rows("<sheetData><row r=\"1\"/><row r=\"2\"><c r=\"A2\"/></row></sheetData>");
        assert_eq!(rows, [SheetRow { attributes: " r=\"1\"", body: "" }, SheetRow { attributes: " r=\"2\"", body: "<c r=\"A2\"/>" }]);
    }
}
