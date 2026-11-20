//! `portable/xlsx-contract.mjs`: what an XLSX operation list must satisfy before either backend writes it. Cell and
//! range references and the validation rule are the ones of `mixdog_office_base` (`a1`, `xlsx_validation`), which this
//! module calls; what is here is the rest of the contract: fill-down of a formula over a range, the formula text an
//! engine can read (prefixed functions, quoted sheet names), the pivot and dropdown spellings, the conditional-format
//! kind and the checks of every operation. An operation is the JSON object a caller wrote; a check that Node does by
//! throwing is an `Err` with the same message.

use std::cell::RefCell;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_to_lowercase, js_trim, json_number, string_to_number, utf16_len, value_to_string};
use mixdog_office_base::a1::{
    XLSX_MAX_COLUMNS, XLSX_MAX_RANGE_CELLS, XLSX_MAX_ROWS, XlsxCell, XlsxRange, column_label, column_number, parse_xlsx_cell, parse_xlsx_range,
};
use mixdog_office_base::xlsx_validation::normalize_xlsx_validation;
use serde_json::{Map, Value};

use crate::sheet_xml::{quote_sheet_name, sheet_qualified_areas};
use crate::xlsx_audit_support::{escape_reg_exp, js_text, map_outside_string_literals, text_or_empty, text_or_empty_nullish, truthy};

macro_rules! regex {
    ($source:expr, $flags:expr) => {
        LazyLock::new(|| JsRegex::new_static($source, $flags))
    };
}

/// A structured reference (`Ops[처리량 (건)]`, `Ops[[#This Row],[월]]`, `[@월]`) names a table's column, never a cell, so
/// a fill leaves it as it is; the reference reader does not parse one, so it is held aside as a string while the rest
/// of the formula moves.
static STRUCTURED_REFERENCE: LazyLock<JsRegex> = regex!(r#"(?:[A-Za-z_\\À-￿][\w.À-￿]*)?\[(?:[^[\]"]|\[[^\]]*\])*\]"#, "g");
static HELD_REFERENCE: LazyLock<JsRegex> = regex!(r#""\u0000(\d+)\u0000""#, "g");

/// `parseXlsxCell(operation[field])`: a reference a caller left out or wrote as a falsy value is named as written.
fn cell_of(reference: Option<&Value>) -> Result<XlsxCell, String> {
    if truthy(reference) { parse_xlsx_cell(&js_text(reference)) } else { Err(format!("Invalid XLSX cell reference: {}", js_text(reference))) }
}

/// `parseXlsxRange(operation[field])` with the default cell limit.
fn range_of(reference: Option<&Value>) -> Result<XlsxRange, String> {
    if truthy(reference) { parse_xlsx_range(&js_text(reference), XLSX_MAX_RANGE_CELLS) } else { Err(format!("Invalid XLSX range: {}", js_text(reference))) }
}

/// What a fill writes into the cell `row_delta` rows and `column_delta` columns from the one it was written for, as
/// Excel's fill moves it: relative references move, `$`-pinned ones stay, a sheet-qualified one moves too (`=Data!B2`
/// filled down reads `=Data!B3`), a table's structured reference stays. `translate` is the engine's shared-formula move.
pub fn filled_formula(formula: &str, row_delta: i64, column_delta: i64, translate: &dyn Fn(&str, i64, i64) -> String) -> String {
    if row_delta == 0 && column_delta == 0 {
        return formula.to_owned();
    }
    let held: RefCell<Vec<String>> = RefCell::new(Vec::new());
    // Only outside string literals: "[x]" in a label is text, not a table.
    let masked = map_outside_string_literals(formula, |segment| {
        STRUCTURED_REFERENCE.replace_all_with(segment, |found| {
            let mut held = held.borrow_mut();
            held.push(found.get(0).unwrap_or_default().to_owned());
            format!("\"\u{0}{}\u{0}\"", held.len() - 1)
        })
    });
    let moved = translate(masked.strip_prefix('=').unwrap_or(&masked), row_delta, column_delta);
    let held = held.into_inner();
    let restored = HELD_REFERENCE.replace_all_with(&moved, |found| {
        let index = found.get(1).and_then(|digits| digits.parse::<usize>().ok());
        index.and_then(|index| held.get(index)).cloned().unwrap_or_else(|| "undefined".to_owned())
    });
    format!("={restored}")
}

/// `expandFilledFormulas(operations, translate)`: `set_formula` over a range. The formula is written for the range's
/// top-left cell and every other cell takes it as Excel's fill moves it, so a column of SUMIFS over the rows beside it
/// is one operation, not one per row.
pub fn expand_filled_formulas(operations: &[Value], translate: &dyn Fn(&str, i64, i64) -> String) -> Result<Vec<Value>, String> {
    let fills = |operation: &Value| operation.get("op").and_then(Value::as_str) == Some("set_formula") && operation.get("range").is_some();
    if !operations.iter().any(fills) {
        return Ok(operations.to_vec());
    }
    let mut expanded = Vec::new();
    for operation in operations {
        let Some(fields) = operation.as_object().filter(|_| fills(operation)) else {
            expanded.push(operation.clone());
            continue;
        };
        let rest: Map<String, Value> = fields.iter().filter(|(key, _)| key.as_str() != "range").map(|(key, value)| (key.clone(), value.clone())).collect();
        let area = range_of(fields.get("range"))?;
        let formula = text_or_empty_nullish(fields.get("formula"));
        for row in 0..area.rows {
            for column in 0..area.columns {
                let mut cell = rest.clone();
                cell.insert("cell".to_owned(), Value::String(format!("{}{}", column_label(f64::from(area.start.column + column)), area.start.row + row)));
                cell.insert("formula".to_owned(), Value::String(filled_formula(&formula, i64::from(row), i64::from(column), translate)));
                expanded.push(Value::Object(cell));
            }
        }
    }
    Ok(expanded)
}

/// What `parseXlsxAutofitRange` names: whole columns, whole rows or a block of cells.
#[derive(Debug, Clone, PartialEq)]
pub enum AutofitRange {
    Columns { start: f64, end: f64 },
    Rows { start: f64, end: f64 },
    Cells(XlsxRange),
}

static COLUMN_SPAN: LazyLock<JsRegex> = regex!(r"^([A-Z]+):([A-Z]+)$", "i");
static ROW_SPAN: LazyLock<JsRegex> = regex!(r"^([1-9]\d*):([1-9]\d*)$", "");

/// `parseXlsxAutofitRange(reference)`.
pub fn parse_xlsx_autofit_range(reference: &str) -> Result<AutofitRange, String> {
    let text = js_trim(reference);
    if let Some(columns) = COLUMN_SPAN.captures(text) {
        let start = column_number(columns.get(1).unwrap_or_default());
        let end = column_number(columns.get(2).unwrap_or_default());
        if start < 1.0 || end > f64::from(XLSX_MAX_COLUMNS) || start > end {
            return Err(format!("Invalid XLSX column range: {reference}"));
        }
        return Ok(AutofitRange::Columns { start, end });
    }
    if let Some(rows) = ROW_SPAN.captures(text) {
        let start = string_to_number(rows.get(1).unwrap_or_default());
        let end = string_to_number(rows.get(2).unwrap_or_default());
        if end > f64::from(XLSX_MAX_ROWS) || start > end {
            return Err(format!("Invalid XLSX row range: {reference}"));
        }
        return Ok(AutofitRange::Rows { start, end });
    }
    parse_xlsx_range(text, XLSX_MAX_RANGE_CELLS).map(AutofitRange::Cells)
}

fn array_of(value: Option<&Value>) -> Option<&Vec<Value>> {
    value.and_then(Value::as_array)
}

fn validate_range_matrix(operation: &Map<String, Value>, area: &XlsxRange) -> Result<(), String> {
    let Some(values) = array_of(operation.get("values")) else {
        return Err("XLSX set_range requires values as a row matrix".to_owned());
    };
    if values.len() != area.rows as usize {
        return Err(format!("XLSX set_range expected {} value row(s), received {}", area.rows, values.len()));
    }
    for (index, row) in values.iter().enumerate() {
        match row.as_array() {
            Some(row) if row.len() == area.columns as usize => {}
            other => {
                return Err(format!(
                    "XLSX set_range row {} expected {} value(s), received {}",
                    index + 1,
                    area.columns,
                    other.map_or_else(|| "a non-array".to_owned(), |row| row.len().to_string())
                ));
            }
        }
    }
    Ok(())
}

const PREFIXED_FUNCTIONS: &str = "TEXTJOIN|CONCAT|IFS|SWITCH|MAXIFS|MINIFS";
const SPILLING_FUNCTIONS: &str = "XLOOKUP|XMATCH|SORTBY|SORT|FILTER|UNIQUE|SEQUENCE|RANDARRAY";

/// Deliberately narrower than the audit's rule (`xlsx_sheet_hygiene`), which accepts every script's letters: quoting a
/// name Excel would also read bare (`'모델'!B8`) evaluates the same, while reporting one as unquoted would be a warning
/// nobody can resolve. A writer may over-quote; an audit may not.
static SHEET_IDENTIFIER: LazyLock<JsRegex> = regex!(r"^[A-Za-z_][A-Za-z0-9_.]*$", "");
static SPILLING: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(&format!(r"(?:^|[^A-Za-z0-9_.])({SPILLING_FUNCTIONS})\s*\("), "i"));
static PREFIXED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(&format!(r"(^|[^A-Za-z0-9_.])({PREFIXED_FUNCTIONS})\s*\("), "gi"));

/// `My Sheet!B5` evaluates to #VALUE!; Excel needs `'My Sheet'!B5`. Only names the workbook actually holds are quoted,
/// and never inside a string literal.
fn quote_sheet_references(text: &str, sheet_names: Option<&[String]>) -> String {
    let mut names: Vec<&String> = sheet_names.unwrap_or_default().iter().filter(|name| !name.is_empty() && !SHEET_IDENTIFIER.is_match(name)).collect();
    names.sort_by(|left, right| utf16_len(right).cmp(&utf16_len(left)));
    if names.is_empty() {
        return text.to_owned();
    }
    let patterns: Vec<(&String, JsRegex)> = names
        .into_iter()
        .filter_map(|name| JsRegex::new(&format!(r"(^|[^'A-Za-z0-9_.\]]){}!", escape_reg_exp(name)), "g").ok().map(|pattern| (name, pattern)))
        .collect();
    map_outside_string_literals(text, |segment| {
        let mut output = segment.to_owned();
        for (name, pattern) in &patterns {
            output = pattern.replace_all_with(&output, |found| format!("{}{}!", found.get(1).unwrap_or_default(), quote_sheet_name(name)));
        }
        output
    })
}

/// Without a sheet list (Excel sessions): a multi-word token written straight before `!` and a cell or range
/// (`Data 2024!A1:A5`) can only be a sheet name Excel would reject, so it is quoted. A token that starts with a cell
/// reference is left alone: `A1:C3 Sheet2!B2` is an intersection, not a name.
static UNQUOTED_MULTIWORD_SHEET: LazyLock<JsRegex> =
    regex!(r"(^|[^'A-Za-z0-9_.!\]])([A-Za-z0-9_.]+(?: +[A-Za-z0-9_.]+)+)!(?=\$?[A-Z]{1,3}\$?\d|\$?[A-Z]{1,3}:|\$?\d+:)", "gi");
static STARTS_WITH_CELL: LazyLock<JsRegex> = regex!(r"^[A-Z]{1,3}\d+(?:\s|$)", "i");

/// `quoteUnquotedSheetReferences(formula)`.
pub fn quote_unquoted_sheet_references(formula: &str) -> String {
    map_outside_string_literals(formula, |segment| {
        UNQUOTED_MULTIWORD_SHEET.replace_all_with(segment, |found| {
            let name = found.get(2).unwrap_or_default();
            if STARTS_WITH_CELL.is_match(name) {
                found.get(0).unwrap_or_default().to_owned()
            } else {
                format!("{}{}!", found.get(1).unwrap_or_default(), quote_sheet_name(name))
            }
        })
    })
}

/// `normalizeXlsxFormula(formula, { backend, sheetNames })`: the formula text written to the file, or the message Node
/// throws. The portable engine (`backend` `mixdog-ooxml`) refuses the spilling functions it cannot evaluate.
pub fn normalize_xlsx_formula(formula: &Value, backend: &str, sheet_names: Option<&[String]>) -> Result<String, String> {
    let written = text_or_empty_nullish(Some(formula));
    let text = written.strip_prefix('=').unwrap_or(&written);
    if text.is_empty() {
        return Err("XLSX formula must not be empty".to_owned());
    }
    if backend == "mixdog-ooxml"
        && let Some(spilling) = SPILLING.captures(text)
    {
        return Err(format!(
            "XLSX formula uses {}, which the portable recalculation engine cannot evaluate and would bake in as #NAME?; use INDEX/MATCH or precompute the values",
            spilling.get(1).unwrap_or_default().to_uppercase()
        ));
    }
    let prefixed =
        PREFIXED.replace_all_with(text, |found| format!("{}_xlfn.{}(", found.get(1).unwrap_or_default(), found.get(2).unwrap_or_default().to_uppercase()));
    Ok(quote_unquoted_sheet_references(&quote_sheet_references(&prefixed, sheet_names)))
}

static QUALIFIED_SOURCE: LazyLock<JsRegex> = regex!(r"^(?:'((?:[^']|'')+)'|([^'!]+))!(.+)$", "");

/// Excel names a pivot source the way it appears in its own dialog (`원자료!A1:D25`) while the operation carries the sheet
/// in a field of its own. The qualified form is split into those two fields instead of being refused as a range.
fn split_sheet_reference(text: &str) -> (String, String) {
    let raw = js_trim(text);
    match QUALIFIED_SOURCE.captures(raw) {
        Some(found) => {
            let sheet = found.get(1).or_else(|| found.get(2)).unwrap_or_default().replace("''", "'");
            (js_trim(&sheet).to_owned(), js_trim(found.get(3).unwrap_or_default()).to_owned())
        }
        None => (String::new(), raw.to_owned()),
    }
}

/// Both backends total a pivot value field (Excel's AddDataField uses xlSum); a caller who writes the field as an object
/// gets the field name read out of it rather than a stringified object in the error.
fn pivot_value_fields(values: &Value) -> Result<Vec<String>, String> {
    let entries: Vec<&Value> = match values {
        Value::Array(entries) => entries.iter().collect(),
        Value::Null => Vec::new(),
        single => vec![single],
    };
    let mut fields = Vec::new();
    for entry in entries {
        let field = match entry {
            Value::Object(_) | Value::Array(_) => {
                let named = |keys: [&str; 2], fallback: &str| -> String {
                    keys.iter().find_map(|key| entry.get(*key).filter(|value| !value.is_null())).map_or_else(|| fallback.to_owned(), value_to_string)
                };
                let field = js_trim(&named(["field", "name"], "")).to_owned();
                if field.is_empty() {
                    return Err("XLSX add_pivot_table values entries need a field name: values:[\"매출\"] or values:[{ field: \"매출\" }]".to_owned());
                }
                let aggregate = js_to_lowercase(js_trim(&named(["function", "aggregation"], "sum")));
                if aggregate != "sum" {
                    return Err(format!(
                        "XLSX add_pivot_table totals its value fields; \"{aggregate}\" is not available. Precompute that column in the source range instead."
                    ));
                }
                field
            }
            other => js_trim(&text_or_empty_nullish(Some(other))).to_owned(),
        };
        if !field.is_empty() {
            fields.push(field);
        }
    }
    Ok(fields)
}

fn normalize_pivot_fields(operation: &mut Map<String, Value>) -> Result<(), String> {
    for (field, owner) in [("source", "sheet"), ("destination", "destinationSheet")] {
        let Some(named) = operation.get(field).filter(|value| !value.is_null()) else {
            continue;
        };
        let (sheet, reference) = split_sheet_reference(&value_to_string(named));
        if sheet.is_empty() {
            continue;
        }
        let declared = js_trim(&text_or_empty_nullish(operation.get(owner))).to_owned();
        if !declared.is_empty() && declared != sheet {
            return Err(format!("XLSX add_pivot_table {field} names sheet \"{sheet}\" but {owner} is \"{declared}\"; name the sheet once."));
        }
        operation.insert(field.to_owned(), Value::String(reference));
        operation.insert(owner.to_owned(), Value::String(sheet));
    }
    if let Some(values) = operation.get("values").filter(|values| !values.is_null()) {
        let fields = pivot_value_fields(values)?;
        operation.insert("values".to_owned(), Value::Array(fields.into_iter().map(Value::String).collect()));
    }
    Ok(())
}

static CHOICE_RANGE: LazyLock<JsRegex> = regex!(r"^(?:'[^']+'!|[A-Za-z_][\w.]*!)?\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$", "");
static QUOTED_LIST: LazyLock<JsRegex> = regex!(r#"^"[^"]*"$"#, "");

/// `listValidationChoices(formula1)`: Excel holds a literal list quoted (`<formula1>"서울,부산"</formula1>`). Written
/// bare, the reader looks for a name spelled 서울,부산, finds none, and opens an empty dropdown, so the quotes the caller
/// left off are put back here. A range of choices and an already quoted list are written as they came.
pub fn list_validation_choices(formula1: &Value) -> String {
    let trimmed = js_trim(&text_or_empty_nullish(Some(formula1))).to_owned();
    let text = trimmed.strip_prefix('=').unwrap_or(&trimmed);
    if text.is_empty() || QUOTED_LIST.is_match(text) || CHOICE_RANGE.is_match(text) { text.to_owned() } else { format!("\"{text}\"") }
}

/// `conditionalFormatKind(operation)`: three ways a sheet marks its numbers, a rule that paints the cells it picks, a
/// scale that colours every cell by where its value sits, and a bar drawn in the cell. The first needs a formula and a
/// format; the other two carry their colours and take none, so the kind decides which fields are required.
pub fn conditional_format_kind(operation: &Value) -> Result<&'static str, String> {
    conditional_kind_of(operation.get("type"))
}

fn conditional_kind_of(declared: Option<&Value>) -> Result<&'static str, String> {
    let declared = js_trim(&text_or_empty_nullish(declared)).to_owned();
    if declared.is_empty() {
        return Ok("expression");
    }
    let key: String = js_to_lowercase(&declared).chars().filter(char::is_ascii_lowercase).collect();
    match key.as_str() {
        "expression" | "formula" | "cellis" => Ok("expression"),
        "colorscale" | "colourscale" | "scale" | "heatmap" => Ok("colorScale"),
        "databar" | "bar" => Ok("dataBar"),
        _ => Err(format!("XLSX add_conditional_format type must be expression, colorScale, or dataBar; received \"{declared}\".")),
    }
}

const CELL_OPERATIONS: [&str; 5] = ["set_cell", "set_formula", "clear_cell", "add_note", "delete_note"];
const RANGE_OPERATIONS: [&str; 6] = ["set_range", "set_style", "add_table", "add_chart", "add_conditional_format", "add_validation"];

/// `Number.isInteger(value)` of a field, its default where it is null or missing (`value ?? default`).
fn integer_or(value: Option<&Value>, default: f64) -> Option<f64> {
    match value {
        None | Some(Value::Null) => Some(default),
        Some(Value::Number(number)) => number.as_f64().filter(|number| number.is_finite() && number.fract() == 0.0),
        Some(_) => None,
    }
}

fn validate_freeze_panes(operation: &Map<String, Value>) -> Result<(), String> {
    let row = integer_or(operation.get("row"), 1.0);
    let column = integer_or(operation.get("column"), 0.0);
    let Some(row) = row.filter(|row| *row >= 0.0 && *row <= f64::from(XLSX_MAX_ROWS)) else {
        return Err(format!("XLSX freeze_panes row must be between 0 and {XLSX_MAX_ROWS}"));
    };
    let Some(column) = column.filter(|column| *column >= 0.0 && *column <= f64::from(XLSX_MAX_COLUMNS)) else {
        return Err(format!("XLSX freeze_panes column must be between 0 and {XLSX_MAX_COLUMNS}"));
    };
    // row:1 read as "freeze one row" came back as a batch that changed nothing; it names the first row that scrolls.
    if row <= 1.0 && column <= 1.0 {
        return Err("XLSX freeze_panes row and column name the first row and column that scroll, so this freezes nothing: row:2 keeps the header row (row 1) in view, column:2 keeps column A.".to_owned());
    }
    Ok(())
}

fn validate_sort_range(operation: &Map<String, Value>) -> Result<(), String> {
    if !truthy(operation.get("range")) {
        return Err("XLSX sort_range requires range".to_owned());
    }
    let order = js_to_lowercase(js_trim(&text_or_empty_nullish(operation.get("order"))));
    if !order.is_empty() && !["asc", "ascending", "desc", "descending"].contains(&order.as_str()) {
        return Err(format!("XLSX sort_range order must be asc or desc; received \"{}\".", js_text(operation.get("order"))));
    }
    range_of(operation.get("range")).map(|_| ())
}

fn validate_conditional_format(operation: &mut Map<String, Value>) -> Result<(), String> {
    let kind = conditional_kind_of(operation.get("type"))?;
    let has_formula = !js_trim(&text_or_empty_nullish(operation.get("formula"))).is_empty();
    if kind == "expression" && !has_formula {
        return Err("XLSX add_conditional_format needs formula for a rule that picks cells, or type: 'colorScale' / 'dataBar' to shade every cell in the range by its value.".to_owned());
    }
    if kind != "expression" && has_formula {
        return Err(format!(
            "XLSX add_conditional_format type: '{kind}' shades the range by value and takes no formula; drop formula, or use the default rule with it."
        ));
    }
    operation.insert("type".to_owned(), Value::String(kind.to_owned()));
    Ok(())
}

/// A chart's source may be several areas joined by commas, the way Excel's `Range("A7:A12,D7:D12")` reads them; each
/// one is a bounded range. The source may stand on another sheet (`'월별 계산'!A1:A7,'월별 계산'!D1:D7`), the way a summary
/// sheet charts the calculation behind it: one sheet for every area.
fn chart_source_areas(range: &str) -> Result<Vec<String>, String> {
    let areas = sheet_qualified_areas(range);
    let mut named: Vec<String> = Vec::new();
    for entry in &areas {
        let sheet = js_to_lowercase(&entry.sheet);
        if !named.contains(&sheet) {
            named.push(sheet);
        }
    }
    if named.len() > 1 {
        return Err(format!(
            "XLSX add_chart {range} names {}; a chart reads one sheet, so name it on every area or on none",
            if named.iter().any(String::is_empty) { "a sheet on some areas and none on others" } else { "more than one sheet" }
        ));
    }
    Ok(areas.into_iter().map(|entry| entry.area).collect())
}

/// A chart read by columns takes its categories down the first column and a series from every other column. Given a row
/// of periods (years across, one measure under them) it drew one category and a series per year: five bars in five
/// colours over a single label, with no legend to say which year is which. That shape is refused with the reading it
/// wanted named, before either backend draws it.
fn assert_chart_reads_its_data(operation: &Map<String, Value>, areas: &[XlsxRange]) -> Result<(), String> {
    let range = js_text(operation.get("range"));
    if js_to_lowercase(&text_or_empty(operation.get("plotBy"))) == "rows" {
        // plotBy:'rows' turns one block a quarter: its first row the categories, its first column the series names. Given
        // two areas joined by a comma, Excel drew a chart with no series while the portable writer refused them.
        if areas.len() != 1 || areas[0].rows < 2 || areas[0].columns < 2 {
            return Err(format!(
                "XLSX add_chart {range}: plotBy:'rows' requires one bounded range whose first row holds the categories and whose first column names each series"
            ));
        }
        return Ok(());
    }
    let rows = areas.iter().map(|part| part.rows).max().unwrap_or(0);
    let columns: u32 = areas.iter().map(|part| part.columns).sum();
    if rows == 2 && columns >= 4 {
        return Err(format!(
            "XLSX add_chart {range} reads as {} series of one value each over a single category; a row of periods across the top wants plotBy:'rows' (the first row the categories, each row under it a series)",
            columns - 1
        ));
    }
    Ok(())
}

fn validate_range_operation(operation: &Map<String, Value>, op: &str) -> Result<(), String> {
    let range = js_text(operation.get("range"));
    let parts = if op == "add_chart" { chart_source_areas(&range)? } else { vec![range] };
    let area = parse_xlsx_range(&parts[0], XLSX_MAX_RANGE_CELLS)?;
    let mut areas = vec![area.clone()];
    for part in &parts[1..] {
        areas.push(parse_xlsx_range(part, XLSX_MAX_RANGE_CELLS)?);
    }
    if op == "set_range" {
        validate_range_matrix(operation, &area)?;
    }
    if op == "add_chart" {
        assert_chart_reads_its_data(operation, &areas)?;
    }
    Ok(())
}

fn validate_span(op: &str, start: Option<&Value>, count: Option<&Value>, field: &str, limit: u32, unit: &str) -> Result<(), String> {
    let limit = f64::from(limit);
    let Some(start) = integer_or(start, f64::NAN).filter(|start| *start >= 1.0 && *start <= limit) else {
        return Err(format!("XLSX {op} {field} must be between 1 and {limit}"));
    };
    if !integer_or(count, 1.0).is_some_and(|count| count >= 1.0 && start + count - 1.0 <= limit) {
        return Err(format!("XLSX {op} count exceeds the worksheet {unit} limit"));
    }
    Ok(())
}

static COLUMN_LETTERS: LazyLock<JsRegex> = regex!(r"^[A-Za-z]{1,3}$", "");

/// `validateXlsxOperation(operation)`: checks one operation and settles its defaults in place (a validation's type and
/// operator, a conditional format's kind, a pivot's sheet fields, a column letter as its number), as the backends read
/// them afterwards.
fn validate_xlsx_operation(operation: &mut Value) -> Result<(), String> {
    let operation = match operation {
        Value::Object(operation) => operation,
        // An array is an object to JavaScript, one that names no operation and so has nothing to check.
        Value::Array(_) => return Ok(()),
        _ => return Err("XLSX operation must be an object".to_owned()),
    };
    let op = text_or_empty(operation.get("op"));
    let op = op.as_str();
    if CELL_OPERATIONS.contains(&op) {
        cell_of(operation.get("cell"))?;
    }
    if op == "freeze_panes" {
        validate_freeze_panes(operation)?;
    }
    if op == "sort_range" {
        validate_sort_range(operation)?;
    }
    if op == "add_conditional_format" {
        validate_conditional_format(operation)?;
    }
    if op == "add_pivot_table" {
        normalize_pivot_fields(operation)?;
    }
    // Both backends write the kind named here, so the default is settled once: a formula that names choices is a dropdown,
    // a formula that states a test is a custom rule. Writing B2>0 as a list would offer it as one entry.
    if op == "add_validation" {
        let rule = normalize_xlsx_validation(operation)?;
        operation.insert("type".to_owned(), Value::String(rule.kind.to_owned()));
        if let Some(operator) = rule.operator {
            operation.insert("operator".to_owned(), Value::String(operator.to_owned()));
        }
    }
    if op == "set_style" && truthy(operation.get("cell")) {
        cell_of(operation.get("cell"))?;
    }
    if truthy(operation.get("range")) && RANGE_OPERATIONS.contains(&op) {
        validate_range_operation(operation, op)?;
    } else if op == "set_range" {
        return Err("XLSX set_range requires range".to_owned());
    }
    if op == "autofit_range" {
        if !truthy(operation.get("range")) {
            return Err("XLSX autofit_range requires range".to_owned());
        }
        parse_xlsx_autofit_range(&js_text(operation.get("range")))?;
    }
    if op == "append_row" {
        let Some(values) = array_of(operation.get("values")) else {
            return Err("XLSX append_row requires values".to_owned());
        };
        if values.len() > XLSX_MAX_COLUMNS as usize {
            return Err(format!("XLSX append_row contains {} values; maximum is {XLSX_MAX_COLUMNS}", values.len()));
        }
    }
    if op == "insert_rows" || op == "delete_rows" {
        validate_span(op, operation.get("row"), operation.get("count"), "row", XLSX_MAX_ROWS, "row")?;
    }
    if op == "insert_columns" || op == "delete_columns" {
        // A letter, as set_column_width and set_column_visibility take it, becomes the number both backends shift by.
        let letters = operation.get("column").and_then(Value::as_str).map(|column| js_trim(column).to_owned());
        if let Some(letters) = letters.filter(|letters| COLUMN_LETTERS.is_match(letters)) {
            operation.insert("column".to_owned(), json_number(column_number(&letters.to_uppercase())));
        }
        validate_span(op, operation.get("column"), operation.get("count"), "column", XLSX_MAX_COLUMNS, "column")?;
    }
    if ["merge_cells", "unmerge_cells", "set_autofilter"].contains(&op) {
        if !truthy(operation.get("range")) {
            return Err(format!("XLSX {op} requires range"));
        }
        range_of(operation.get("range"))?;
    }
    Ok(())
}

/// `validateXlsxOperations(operations)`: every operation checked in order, the first failure is the answer.
pub fn validate_xlsx_operations(operations: &mut [Value]) -> Result<(), String> {
    for operation in operations {
        validate_xlsx_operation(operation)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn shift(formula: &str, rows: i64, columns: i64) -> String {
        format!("T({formula}|{rows}|{columns})")
    }

    #[test]
    fn a_fill_holds_structured_references_aside() {
        assert_eq!(filled_formula("=Ops[월]+B2+\"[x]\"", 1, 0, &shift), "=T(Ops[월]+B2+\"[x]\"|1|0)");
        let seen = RefCell::new(String::new());
        let spy = |formula: &str, _: i64, _: i64| {
            *seen.borrow_mut() = formula.to_owned();
            formula.to_owned()
        };
        filled_formula("=Ops[월]+\"[x]\"", 0, 2, &spy);
        assert_eq!(seen.into_inner(), "\"\u{0}0\u{0}\"+\"[x]\"");
    }

    #[test]
    fn a_fill_leaves_the_formula_where_nothing_moves() {
        assert_eq!(filled_formula("=A1", 0, 0, &shift), "=A1");
    }

    #[test]
    fn set_formula_over_a_range_is_one_operation_per_cell() {
        let operations = vec![json!({ "op": "set_formula", "range": "B2:C3", "formula": "=A1" }), json!({ "op": "set_cell", "cell": "A1" })];
        let expanded = expand_filled_formulas(&operations, &shift).expect("expands");
        assert_eq!(expanded.len(), 5);
        assert_eq!(expanded[3], json!({ "op": "set_formula", "cell": "C3", "formula": "=T(A1|1|1)" }));
        assert_eq!(expanded[4], operations[1]);
    }

    #[test]
    fn formulas_are_prefixed_and_their_sheet_names_quoted() {
        let names = vec!["월별 계산".to_owned(), "Plain".to_owned()];
        assert_eq!(
            normalize_xlsx_formula(&json!("=TEXTJOIN(\",\",1,월별 계산!A1)+Plain!B2"), "excel", Some(names.as_slice())),
            Ok("_xlfn.TEXTJOIN(\",\",1,'월별 계산'!A1)+Plain!B2".to_owned())
        );
        assert_eq!(quote_unquoted_sheet_references("=Data 2024!A1:A5"), "='Data 2024'!A1:A5");
        assert!(normalize_xlsx_formula(&json!("=xlookup(A1,B:B,C:C)"), "mixdog-ooxml", None).unwrap_err().contains("XLOOKUP"));
        assert_eq!(normalize_xlsx_formula(&json!("="), "", None), Err("XLSX formula must not be empty".to_owned()));
    }

    #[test]
    fn autofit_ranges_name_columns_rows_or_cells() {
        assert_eq!(parse_xlsx_autofit_range("a:c"), Ok(AutofitRange::Columns { start: 1.0, end: 3.0 }));
        assert_eq!(parse_xlsx_autofit_range("2:9"), Ok(AutofitRange::Rows { start: 2.0, end: 9.0 }));
        assert_eq!(parse_xlsx_autofit_range("c:a"), Err("Invalid XLSX column range: c:a".to_owned()));
        assert!(matches!(parse_xlsx_autofit_range("A1:B2"), Ok(AutofitRange::Cells(area)) if area.cells == 4));
    }

    #[test]
    fn validations_settle_their_defaults() {
        let mut operations = vec![
            json!({ "op": "add_validation", "range": "A1", "formula1": "서울,부산" }),
            json!({ "op": "add_conditional_format", "range": "A1:A4", "type": "Heat-Map" }),
            json!({ "op": "insert_columns", "column": "c" }),
            json!({ "op": "add_pivot_table", "source": "'원자료'!A1:D25", "values": [{ "field": "매출" }, "건수"] }),
        ];
        validate_xlsx_operations(&mut operations).expect("valid");
        assert_eq!(operations[0]["type"], "list");
        assert_eq!(operations[1]["type"], "colorScale");
        assert_eq!(operations[2]["column"], 3);
        assert_eq!(operations[3], json!({ "op": "add_pivot_table", "source": "A1:D25", "values": ["매출", "건수"], "sheet": "원자료" }));
    }

    #[test]
    fn operations_that_cannot_be_written_are_refused_with_the_message_of_node() {
        let refused = |operation: Value| validate_xlsx_operations(&mut [operation]).unwrap_err();
        assert_eq!(refused(json!({ "op": "set_cell" })), "Invalid XLSX cell reference: undefined");
        assert_eq!(refused(json!({ "op": "set_range" })), "XLSX set_range requires range");
        assert!(refused(json!({ "op": "freeze_panes" })).starts_with("XLSX freeze_panes row and column name"));
        assert_eq!(refused(json!({ "op": "insert_rows", "row": 0 })), "XLSX insert_rows row must be between 1 and 1048576");
        assert!(refused(json!({ "op": "add_chart", "range": "A1:D2" })).contains("reads as 3 series of one value each"));
        assert_eq!(refused(json!(5)), "XLSX operation must be an object");
        assert_eq!(refused(json!({ "op": "set_range", "range": "A1:B2", "values": [[1, 2]] })), "XLSX set_range expected 2 value row(s), received 1");
    }

    #[test]
    fn list_choices_are_quoted_when_written_bare() {
        assert_eq!(list_validation_choices(&json!("서울,부산")), "\"서울,부산\"");
        assert_eq!(list_validation_choices(&json!("=\"a,b\"")), "\"a,b\"");
        assert_eq!(list_validation_choices(&json!("Data!$A$1:$A$9")), "Data!$A$1:$A$9");
    }
}
