//! `portable/portable-xlsx-range-layout.mjs`: laying out a range of cells that already exists. `sort_range` reorders its rows,
//! `autofit_range` measures the width each column prints. Both read the cell grid and write it back; neither adds a part to
//! the package. An operation is the JSON object the caller wrote (`{ op, range, by, order, hasHeader, minWidth, rows }`).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{LazyLock, OnceLock};

use icu_collator::CollatorBorrowed;
use icu_collator::options::{CollatorOptions, Strength};
use icu_locale_core::Locale;
use mixdog_fsio::ReadProof;
use mixdog_js::{JsRegex, js_sort_by, js_to_lowercase, js_trim, json_number, math, number_to_string, string_to_number, to_number_of};
use mixdog_office_base::a1::{column_label, column_number, parse_cell_ref};
use serde_json::{Map, Value, json};

use crate::cells::{
    CellEntry, CellRecord, CellStyle, CellValue, RangeBounds, Sheet, cell_records, cell_style_indexes, expand_range, iterate_sheet_cells,
    set_cell_styles_in_sheet, set_cells_in_sheet, shared_strings,
};
use crate::shared_formulas::expand_shared_formulas;
use crate::sheet_page::{column_file_width, maximum_digit_width, text_characters};
use crate::sheet_styles::resolve_cell_styles;
use crate::sheet_xml::{Area, cell_width_scale, formatted_number_width, hidden_sheet_areas, merged_ranges, parse_area_range, write_column_widths};
use crate::text_metrics::TextMeasurer;
use crate::xlsx_audit_support::{js_text, text_or_empty, truthy};
use crate::xlsx_reference_shift::sorted_formula;
use crate::zipio::Package;

macro_rules! regex {
    ($source:expr, $flags:expr) => {
        LazyLock::new(|| JsRegex::new_static($source, $flags))
    };
}

static COLUMN_LETTERS: LazyLock<JsRegex> = regex!(r"^[A-Za-z]{1,3}$", "");
static ARRAY_FORMULA: LazyLock<JsRegex> = regex!(r#"\bt="array""#, "");
static SHARED_FORMULA: LazyLock<JsRegex> = regex!(r#"\bt="shared""#, "");
static SHARED_INDEX: LazyLock<JsRegex> = regex!(r#"\bsi="([^"]+)""#, "");
static FORMULA_ATTRIBUTES: LazyLock<JsRegex> = regex!(r"<f\b([^>]*?)\/?>", "");

/// The area an operation names, the way Node reads a range (`String(range || '')`), refusing with the text Node prints.
fn named_area(range: Option<&Value>) -> Result<Area, String> {
    parse_area_range(&text_or_empty(range)).map_err(|error| if truthy(range) { error } else { format!("Unsupported range: {}", js_text(range)) })
}

fn named_bounds(range: Option<&Value>) -> Result<RangeBounds, String> {
    expand_range(&text_or_empty(range)).map_err(|error| if truthy(range) { error } else { format!("Invalid range: {}", js_text(range)) })
}

/// The cell at a column and a row, as the reference the sheet stores it by.
fn cell_at(row: f64, column: f64) -> String {
    format!("{}{}", column_label(column), number_to_string(row))
}

/// The sort key is named the way the caller already reads the sheet: a column letter, the header the column carries, or
/// nothing when the first column of the range is the key.
fn sort_key_column(op: &Map<String, Value>, area: &RangeBounds, header_value: impl Fn(f64) -> Option<String>) -> Result<f64, String> {
    let named = ["by", "column", "byColumn"].iter().find_map(|name| op.get(*name).filter(|value| !value.is_null()));
    let declared = named.map_or_else(String::new, |value| js_trim(&mixdog_js::value_to_string(value)).to_owned());
    if declared.is_empty() {
        return Ok(area.start_col);
    }
    let range = js_text(op.get("range"));
    if COLUMN_LETTERS.is_match(&declared) {
        let column = column_number(&declared.to_uppercase());
        if column < area.start_col || column > area.end_col {
            return Err(format!("XLSX sort_range by \"{declared}\" is outside {range}; name a column the range covers."));
        }
        return Ok(column);
    }
    let mut headers: Vec<String> = Vec::new();
    let mut column = area.start_col;
    while column <= area.end_col {
        let text = header_value(column).map_or_else(String::new, |value| js_trim(&value).to_owned());
        if !text.is_empty() {
            headers.push(format!("{} ({text})", column_label(column)));
        }
        if !text.is_empty() && text == declared {
            return Ok(column);
        }
        column += 1.0;
    }
    Err(format!(
        "XLSX sort_range by \"{declared}\" matches no column in {range}. Name a column letter or one of its headers: {}.",
        if headers.is_empty() { "(the range has no header row)".to_owned() } else { headers.join(", ") }
    ))
}

/// Excel orders numbers before text and leaves blanks last in both directions; text is compared the way the reader's
/// locale reads it, so 강릉 sorts before 광주 rather than by code point. `Intl.Collator(undefined, { numeric: true,
/// sensitivity: 'base' })`.
fn sort_collator() -> &'static CollatorBorrowed<'static> {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR.get_or_init(|| {
        let tag = mixdog_js::default_locale_tag();
        let locale = format!("{tag}-u-kn").parse::<Locale>().or_else(|_| "und-u-kn".parse::<Locale>()).expect("static locale");
        let mut options = CollatorOptions::default();
        options.strength = Some(Strength::Primary);
        CollatorBorrowed::try_new((&locale).into(), options).expect("compiled collation data")
    })
}

/// What a cell holds as the sort reads it: a number (a boolean counts as 1 or 0, as `Number(true)` does), or text.
fn sort_number(value: &CellValue) -> Option<f64> {
    match value {
        CellValue::Number(number) => Some(*number),
        CellValue::Bool(flag) => Some(f64::from(u8::from(*flag))),
        CellValue::Text(text) => Some(string_to_number(text)).filter(|number| number.is_finite() && !js_trim(text).is_empty()),
    }
}

fn is_blank(value: Option<&CellValue>) -> bool {
    match value {
        None => true,
        Some(CellValue::Text(text)) => text.is_empty(),
        Some(_) => false,
    }
}

fn compare_sort_values(left: Option<&CellValue>, right: Option<&CellValue>) -> f64 {
    match (is_blank(left), is_blank(right)) {
        (true, true) => return 0.0,
        (true, false) => return 1.0,
        (false, true) => return -1.0,
        (false, false) => {}
    }
    let (Some(left), Some(right)) = (left, right) else { return 0.0 };
    match (sort_number(left), sort_number(right)) {
        (Some(left), Some(right)) => left - right,
        (Some(_), None) => -1.0,
        (None, Some(_)) => 1.0,
        (None, None) => {
            let text = |value: &CellValue| match value {
                CellValue::Text(text) => text.clone(),
                other => mixdog_js::value_to_string(&other.to_json()),
            };
            f64::from(sort_collator().compare(&text(left), &text(right)) as i8)
        }
    }
}

/// The sorts Excel itself refuses, and the ones that would silently corrupt the sheet: a formula stored once for cells the sort
/// would split, hidden rows among the moved ones, and merged cells crossing them.
fn refuse_unsortable_range(xml: &str, area: &RangeBounds, first_row: f64) -> Result<(), String> {
    // A formula filled down is stored once for the whole run, and an array formula once for its block: moving one row of either
    // rewrites the others. Excel refuses to change part of an array.
    let in_body = |reference: &str| -> Result<bool, String> {
        let at = parse_cell_ref(reference)?;
        let column = column_number(&at.col);
        Ok(at.row as f64 >= first_row && at.row as f64 <= area.end_row && column >= area.start_col && column <= area.end_col)
    };
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, (Vec<String>, Vec<String>)> = HashMap::new();
    for cell in iterate_sheet_cells(xml) {
        let Some(found) = FORMULA_ATTRIBUTES.captures(cell.body) else { continue };
        let attributes = found.get(1).unwrap_or("");
        let inside = in_body(cell.reference)?;
        if ARRAY_FORMULA.is_match(attributes) && inside {
            return Err(format!(
                "XLSX sort_range cannot move the array formula at {}; Excel refuses to change part of an array. Sort a range without it.",
                cell.reference
            ));
        }
        let id = if SHARED_FORMULA.is_match(attributes) { SHARED_INDEX.captures(attributes).and_then(|found| found.get(1).map(str::to_owned)) } else { None };
        let Some(id) = id else { continue };
        if !groups.contains_key(&id) {
            order.push(id.clone());
        }
        let group = groups.entry(id).or_default();
        (if inside { &mut group.0 } else { &mut group.1 }).push(cell.reference.to_owned());
    }
    let split = order.iter().map(|id| &groups[id]).find(|group| !group.0.is_empty() && !group.1.is_empty());
    if let Some((inside, outside)) = split {
        return Err(format!(
            "XLSX sort_range would move part of a formula filled down as one, {} through {}. Sort the whole filled range, or write the formula into each row with set_formula first.",
            inside[0],
            outside[outside.len() - 1]
        ));
    }
    // A filtered sheet hides rows, not records: the flag stays on the row number while the values move under it, so a sort
    // would leave a different record hidden than the one the reader filtered away.
    let withheld: Vec<u32> = hidden_sheet_areas(xml).rows.into_iter().filter(|row| f64::from(*row) >= first_row && f64::from(*row) <= area.end_row).collect();
    if !withheld.is_empty() {
        let shown: Vec<String> = withheld.iter().take(5).map(u32::to_string).collect();
        return Err(format!(
            "XLSX sort_range would move values under hidden row{} {}, leaving a different record withheld. Show them first with set_row_visibility visible: true, or sort a range without them.",
            if withheld.len() > 1 { "s" } else { "" },
            shown.join(", ")
        ));
    }
    // Excel refuses the same case: a merged cell cannot travel with one row.
    let mut merges: Vec<String> = Vec::new();
    for range in merged_ranges(xml) {
        let merge = expand_range(&range)?;
        if merge.end_row >= first_row && merge.start_row <= area.end_row && merge.end_col >= area.start_col && merge.start_col <= area.end_col {
            merges.push(range);
        }
    }
    if !merges.is_empty() {
        let shown: Vec<&str> = merges.iter().take(5).map(String::as_str).collect();
        return Err(format!(
            "XLSX sort_range cannot move rows through the merged cell{} {}; Excel refuses the same sort. Unmerge them first with unmerge_cells.",
            if merges.len() > 1 { "s" } else { "" },
            shown.join(", ")
        ));
    }
    Ok(())
}

/// What a write of a formula carries as its value (the formula decides what the cell shows).
static NO_VALUE: Value = Value::Null;

/// A cell of the sorted body: what it holds, the formula it carries, the row it came from and its style.
#[derive(Clone)]
struct BodyCell {
    value: Option<CellValue>,
    formula: String,
    row: i64,
    style: u64,
}

/// `sortWorksheetRange(zip, sheet, xml, op)`: sorts the values of a range, refusing the cases Excel itself refuses. A formula
/// travels with its row as Excel moves it; one that cannot be moved refuses the sort.
pub fn sort_worksheet_range(zip: &mut Package, sheet: &Sheet, xml: &str, op: &Map<String, Value>) -> Result<Value, String> {
    let area = named_bounds(op.get("range"))?;
    let header = op.get("hasHeader") != Some(&Value::Bool(false));
    let first_row = area.start_row + if header { 1.0 } else { 0.0 };
    refuse_unsortable_range(xml, &area, first_row)?;
    // Each cell of a filled-down run holds its own formula once the run moves whole, as a plain formula Excel reads alike.
    let mut list = cell_records(xml, &shared_strings(zip), None);
    expand_shared_formulas(xml, &mut list)?;
    let records: HashMap<&str, &CellRecord> = list.iter().map(|cell| (cell.reference.as_str(), cell)).collect();
    let column = sort_key_column(op, &area, |col| {
        records.get(cell_at(area.start_row, col).as_str()).map(|record| match &record.value {
            CellValue::Text(text) => text.clone(),
            other => mixdog_js::value_to_string(&other.to_json()),
        })
    })?;
    let order = if truthy(op.get("order")) { js_text(op.get("order")) } else { "asc".to_owned() };
    let descending = js_to_lowercase(js_trim(&order)).starts_with("desc");
    let mut refs: Vec<Vec<String>> = Vec::new();
    let mut row = first_row;
    while row <= area.end_row {
        let mut line = Vec::new();
        let mut col = area.start_col;
        while col <= area.end_col {
            line.push(cell_at(row, col));
            col += 1.0;
        }
        refs.push(line);
        row += 1.0;
    }
    let flat: Vec<&str> = refs.iter().flatten().map(String::as_str).collect();
    let styles: HashMap<String, u64> = cell_style_indexes(xml, &flat)?.into_iter().collect();
    let mut body: Vec<Vec<BodyCell>> = Vec::with_capacity(refs.len());
    for line in &refs {
        let mut cells = Vec::with_capacity(line.len());
        for reference in line {
            let record = records.get(reference.as_str());
            cells.push(BodyCell {
                value: record.map(|record| record.value.clone()),
                formula: record.and_then(|record| record.formula.as_ref()).map(|info| info.formula.clone()).unwrap_or_default(),
                row: parse_cell_ref(reference)?.row as i64,
                style: styles.get(reference.as_str()).copied().unwrap_or(0),
            });
        }
        body.push(cells);
    }
    let key_index = (column - area.start_col) as usize;
    let mut sorted = body;
    js_sort_by(&mut sorted, |left, right| {
        compare_sort_values(left.get(key_index).and_then(|cell| cell.value.as_ref()), right.get(key_index).and_then(|cell| cell.value.as_ref()))
            * if descending { -1.0 } else { 1.0 }
    });
    let written = write_sorted_rows(xml, &sorted, &area, first_row)?;
    zip.set(&sheet.path, written.into_bytes());
    let mut result = Map::new();
    if let Some(name) = op.get("op") {
        result.insert("op".to_owned(), name.clone());
    }
    result.insert("changed".to_owned(), json!(true));
    result.insert("sheet".to_owned(), json!(sheet.name));
    if let Some(range) = op.get("range") {
        result.insert("range".to_owned(), range.clone());
    }
    result.insert("by".to_owned(), json!(column_label(column)));
    result.insert("order".to_owned(), json!(if descending { "desc" } else { "asc" }));
    result.insert("rows".to_owned(), json!(sorted.len()));
    Ok(Value::Object(result))
}

/// A formula travels with its row as Excel moves it ([`sorted_formula`]); one that cannot be moved refuses the sort.
fn write_sorted_rows(xml: &str, sorted: &[Vec<BodyCell>], area: &RangeBounds, first_row: f64) -> Result<String, String> {
    struct Placed<'a> {
        reference: String,
        cell: &'a BodyCell,
        formula: String,
    }
    let mut placed: Vec<Placed<'_>> = Vec::new();
    for (offset, cells) in sorted.iter().enumerate() {
        for (index, cell) in cells.iter().enumerate() {
            let reference = cell_at(first_row + offset as f64, area.start_col + index as f64);
            let formula = if cell.formula.is_empty() {
                String::new()
            } else {
                let parsed = parse_cell_ref(&reference)?;
                sorted_formula(&cell.formula, parsed.row as i64 - cell.row).map_err(|error| {
                    let origin = cell_at(cell.row as f64, column_number(&parsed.col));
                    format!("XLSX sort_range cannot move the formula in {origin} (={}): {}.", cell.formula, error.reason)
                })?
            };
            placed.push(Placed { reference, cell, formula });
        }
    }
    let values: Vec<Value> = placed.iter().map(|entry| entry.cell.value.as_ref().map_or(Value::Null, CellValue::to_json)).collect();
    let entries: Vec<CellEntry<'_>> = placed
        .iter()
        .zip(&values)
        .map(|(entry, value)| CellEntry {
            reference: &entry.reference,
            value: if entry.formula.is_empty() { value } else { &NO_VALUE },
            formula: &entry.formula,
        })
        .collect();
    let with_values = set_cells_in_sheet(xml, &entries)?;
    let digits: Vec<String> = placed.iter().map(|entry| entry.cell.style.to_string()).collect();
    let styles: Vec<CellStyle<'_>> = placed.iter().zip(&digits).map(|(entry, style)| CellStyle { reference: &entry.reference, style }).collect();
    set_cell_styles_in_sheet(&with_values, &styles)
}

/// The text a record shows: a formula's last result, or a literal's own value (`String(value ?? '')`).
fn shown_text(record: &CellRecord) -> String {
    let value = match &record.formula {
        Some(info) => info.cached_value.as_ref(),
        None => Some(&record.value),
    };
    value.map_or_else(String::new, |value| match value {
        CellValue::Text(text) => text.clone(),
        other => mixdog_js::value_to_string(&other.to_json()),
    })
}

/// A line of text alone in its row (a sheet title, an instruction under it) prints across the empty cells beside it, so a fit
/// over several columns does not size its column to it: a form's instruction under its title set column A four times the
/// width of the dates under it and split the table over two pages. A wrapped line keeps its column, as does a fit of that one
/// column.
fn spilling_text(records: &[CellRecord], area: &Area) -> Result<HashSet<String>, String> {
    if area.start_col == 0.0 || area.end_col <= area.start_col {
        return Ok(HashSet::new());
    }
    let mut filled: BTreeMap<u64, Vec<&CellRecord>> = BTreeMap::new();
    for record in records {
        // A formula prints its result whether or not the result is cached yet: a label beside a row of formulas not yet
        // calculated is a row label, not a line alone.
        let text = shown_text(record);
        if record.formula.is_none() && js_trim(&text).is_empty() {
            continue;
        }
        filled.entry(parse_cell_ref(&record.reference)?.row).or_default().push(record);
    }
    let mut spilling = HashSet::new();
    for cells in filled.values() {
        let [only] = cells.as_slice() else { continue };
        if only.formula.is_some() || only.style.as_ref().and_then(|style| style.get("wrapText")).is_some_and(|wrap| truthy(Some(wrap))) {
            continue;
        }
        let value = match &only.value {
            CellValue::Text(text) => text.clone(),
            other => mixdog_js::value_to_string(&other.to_json()),
        };
        if only.text_type || !string_to_number(&value).is_finite() {
            spilling.insert(only.reference.clone());
        }
    }
    Ok(spilling)
}

/// The widest printed text of each column in the area, skipping the cells a horizontal merge spans. A width counts characters
/// of the workbook's default size (`baseSize`), so a cell set larger takes proportionally more of it. Columns are kept in the
/// order they were first measured.
fn measured_column_widths<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    records: &[CellRecord],
    area: &Area,
    spans: &[Area],
    base_style: Option<&Value>,
    digit_width: f64,
) -> Result<Vec<(u32, f64)>, String> {
    let declared = to_number_of(base_style.and_then(|style| style.get("fontSize")));
    let base_size = if declared.is_nan() || declared == 0.0 { 11.0 } else { declared };
    let mut measured: Vec<(u32, f64)> = Vec::new();
    let mut place: HashMap<u32, usize> = HashMap::new();
    let spilling = spilling_text(records, area)?;
    for record in records {
        let parsed = parse_cell_ref(&record.reference)?;
        let column = column_number(&parsed.col);
        let row = parsed.row as f64;
        if area.start_col != 0.0 && (column < area.start_col || column > area.end_col) {
            continue;
        }
        if area.start_row != 0.0 && (row < area.start_row || row > area.end_row) {
            continue;
        }
        if spilling.contains(&record.reference) {
            continue;
        }
        if spans
            .iter()
            .any(|span| span.start_col != span.end_col && span.start_col <= column && column <= span.end_col && span.start_row <= row && row <= span.end_row)
        {
            continue;
        }
        let text = shown_text(record);
        let numeric = !record.text_type && !js_trim(&text).is_empty() && string_to_number(&text).is_finite();
        // An indent level holds about one character of the column before the text starts. A cell on the default style carries
        // no record style, and its face is the one the width counts in. A text is measured in its own face, as the fit audit
        // measures it; a figure counts the digits its format prints.
        let printed = if numeric {
            let format = text_or_empty(record.style.as_ref().and_then(|style| style.get("numberFormat")));
            formatted_number_width(Some(&json_number(string_to_number(&text))), &format) as f64 * cell_width_scale(record.style.as_ref(), base_size, false)
        } else {
            text_characters(measurer, &Value::String(text), record.style.as_ref().or(base_style), digit_width)?
        };
        let indent = to_number_of(record.style.as_ref().and_then(|style| style.get("indent")));
        let needed = printed + if indent.is_nan() || indent == 0.0 { 0.0 } else { indent };
        let key = column as u32;
        match place.get(&key) {
            Some(at) => measured[*at].1 = math::max(measured[*at].1, needed),
            None => {
                place.insert(key, measured.len());
                measured.push((key, math::max(0.0, needed)));
            }
        }
    }
    Ok(measured)
}

/// `autofitWorksheetRange(zip, sheet, xml, op)`: widths measured from what each cell prints, with the floor a composed sheet
/// asks for.
pub fn autofit_worksheet_range<P: ReadProof>(
    measurer: &TextMeasurer<'_, P>,
    zip: &mut Package,
    sheet: &Sheet,
    xml: &str,
    op: &Map<String, Value>,
) -> Result<Value, String> {
    let area = named_area(op.get("range"))?;
    let mut result = Map::new();
    if let Some(name) = op.get("op") {
        result.insert("op".to_owned(), name.clone());
    }
    result.insert("changed".to_owned(), json!(true));
    result.insert("sheet".to_owned(), json!(sheet.name));
    // A row fit names rows (1:12) and asks for their height. Measuring columns there rewrote every column width from its text,
    // which silently undid the widths a composed layout had just asked for.
    if op.get("rows") == Some(&Value::Bool(true)) && area.start_col == 0.0 {
        result.insert("rows".to_owned(), json!(true));
        result.insert("columns".to_owned(), json!(0));
        return Ok(Value::Object(result));
    }
    // Widths follow what the cell prints: a number carries its format's separators, decimals, and units, not the digits it
    // stores.
    let styles_xml = zip.text("xl/styles.xml");
    let cell_styles = resolve_cell_styles(&styles_xml);
    let records = cell_records(xml, &shared_strings(zip), Some(cell_styles.as_slice()));
    let spans = merged_ranges(xml).iter().map(|entry| parse_area_range(entry)).collect::<Result<Vec<_>, _>>()?;
    let digit_width = maximum_digit_width(measurer, &styles_xml)?;
    let mut measured = measured_column_widths(measurer, &records, &area, &spans, cell_styles.first(), digit_width)?;
    // Fit-to-page never enlarges a sheet, so a layout whose columns hold only their text prints as a small block in the
    // corner of the page. minWidth is the floor a composed sheet asks for: the columns still grow to their content, and every
    // column in the range, including the empty ones a merged band spans, reaches that floor so the block keeps its width.
    let minimum = to_number_of(op.get("minWidth"));
    let floor = if minimum > 0.0 { math::min(80.0, minimum) } else { 8.0 };
    if minimum > 0.0 && area.start_col != 0.0 && area.end_col - area.start_col < 64.0 {
        let mut column = area.start_col;
        while column <= area.end_col {
            if !measured.iter().any(|(known, _)| *known == column as u32) {
                measured.push((column as u32, 0.0));
            }
            column += 1.0;
        }
    }
    // Characters, stored with Excel's cell padding as set_column_width stores them.
    let widths: Vec<(u32, f64)> = measured
        .iter()
        .map(|(column, width)| (*column, column_file_width(math::min(80.0, math::max(floor, math::round((width + 2.0) * 10.0) / 10.0)), digit_width)))
        .collect();
    zip.set(&sheet.path, write_column_widths(xml, &widths).into_bytes());
    result.insert("columns".to_owned(), json!(widths.len()));
    Ok(Value::Object(result))
}
