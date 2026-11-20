//! `portable/portable-sheet-audits.mjs`: what a workbook's own cells report about themselves: a column too narrow for what it
//! holds, a protected form nobody can type into, ink no reader can see, and a hardcoded value inside a row of formulas. Each
//! audit reads the sheet parts directly, so the package validation above it stays about package structure. A percentage
//! stored as a whole number is the shared formula audit's finding, reported once there for both backends. Each audit answers
//! the issues in the order and with the texts Node writes; the ones that measure text take the measurer whose faces decide
//! how wide a label is.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::LazyLock;

use mixdog_fsio::ReadProof;
use mixdog_js::{JsRegex, cut_utf16, js_trim, json_number, math, number_to_string, string_to_number, to_number_of, utf16_len, value_to_string};
use mixdog_office_base::a1::{column_label, column_number, parse_cell_ref};
use mixdog_office_base::values::truthy;
use serde_json::{Value, json};

use crate::cells::{Sheet, SheetCell, iterate_sheet_cells, iterate_sheet_rows, shared_strings};
use crate::opc::{part_relationship_path, relationship_targets_by_type};
use crate::sheet_page::{maximum_digit_width, text_characters, worksheet_geometry};
use crate::sheet_styles::resolve_cell_styles;
use crate::sheet_xml::{Area, HiddenAreas, cell_width_scale, formatted_number_width, hidden_sheet_areas, merged_ranges, parse_area_range, worksheet_section};
use crate::slide_shapes::first_group;
use crate::text_metrics::{TextMeasurer, contrast_ratio};
use crate::xml::{paragraph_texts, xml_attribute, xml_decode};
use crate::zipio::Package;

macro_rules! regex {
    ($source:expr, $flags:expr) => {
        LazyLock::new(|| JsRegex::new_static($source, $flags))
    };
}

static TYPE_ATTRIBUTE: LazyLock<JsRegex> = regex!(r#"\bt="([^"]+)""#, "");
static VALUE_TEXT: LazyLock<JsRegex> = regex!(r"<v(?:\s[^>]*)?>([\s\S]*?)<\/v>", "");
static VALUE_ANY: LazyLock<JsRegex> = regex!(r"<v(?:\s[^>]*)?>[\s\S]*?<\/v>", "");
static VALUE_PLAIN: LazyLock<JsRegex> = regex!(r"<v>([\s\S]*?)<\/v>", "");
static VALUE_OPEN: LazyLock<JsRegex> = regex!(r"<v>", "");
static STYLE_INDEX: LazyLock<JsRegex> = regex!(r#"\bs="(\d+)""#, "");
static DATA_VALIDATION_OPEN: LazyLock<JsRegex> = regex!(r"<dataValidation\b([^>]*)", "g");
static SHEET_PROTECTION: LazyLock<JsRegex> = regex!(r"<sheetProtection\b", "");
static NON_NUMERIC_TYPE: LazyLock<JsRegex> = regex!(r#"\bt="(?:s|inlineStr|str|b)""#, "");
static TEXT_TYPE: LazyLock<JsRegex> = regex!(r#"\bt="(?:s|inlineStr|str)""#, "");
static GENERAL_FORMAT: LazyLock<JsRegex> = regex!(r"^general$", "i");
static FORMULA_OPEN: LazyLock<JsRegex> = regex!(r"<f[\s>]", "");
static TABLE_PART: LazyLock<JsRegex> = regex!(r#"<tablePart\b[^>]*\br:id="([^"]+)""#, "g");
static TABLE_REF: LazyLock<JsRegex> = regex!(r#"<table\b[^>]*\bref="([^"]+)""#, "");

/// The findings one audit reports for a workbook at most.
const ISSUE_CAP: usize = 50;
const INK_ISSUE_CAP: usize = 20;

fn issue(severity: &str, code: &str, path: String, message: String, source: &str) -> Value {
    json!({ "severity": severity, "code": code, "path": path, "message": message, "source": source })
}

/// `Number(/\bs="(\d+)"/.exec(attributes)?.[1] ?? 0)`: the style index a cell names (0 for the workbook default).
fn style_index_of(attributes: &str) -> usize {
    first_group(&STYLE_INDEX, attributes).map_or(0, |digits| digits.parse::<usize>().unwrap_or(usize::MAX))
}

/// `styles[index]`.
fn style_at(styles: &[Value], index: usize) -> Option<&Value> {
    styles.get(index)
}

fn style_field<'a>(style: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    style.and_then(|style| style.get(name))
}

/// `cellText(cell, strings)`: the text a cell holds as text (a shared string, an inline string or a formula's string result).
fn cell_text(cell: &SheetCell<'_>, strings: &[String]) -> String {
    let cell_type = first_group(&TYPE_ATTRIBUTE, cell.attributes).unwrap_or_default();
    if cell_type == "inlineStr" {
        return paragraph_texts(cell.body, "t").join("");
    }
    let raw = xml_decode(&first_group(&VALUE_TEXT, cell.body).unwrap_or_default());
    if cell_type == "s" {
        let index = string_to_number(&raw);
        if index.is_finite() && index >= 0.0 && index.fract() == 0.0 && index < strings.len() as f64 {
            return strings[index as usize].clone();
        }
        return String::new();
    }
    if cell_type == "str" { raw } else { String::new() }
}

/// The 1-based row of a reference as the key the withheld rows are kept under.
fn row_withheld(withheld: &HiddenAreas, row: u64) -> bool {
    u32::try_from(row).is_ok_and(|row| withheld.rows.contains(&row))
}

fn column_withheld(withheld: &HiddenAreas, column: f64) -> bool {
    column >= 0.0 && column <= f64::from(u32::MAX) && withheld.columns.contains(&(column as u32))
}

/// Every cell of one A1 reference, capped at 512 rows by 64 columns.
fn add_reference_cells(entry_cells: &mut BTreeSet<String>, reference: &str) -> Result<(), String> {
    let mut parts = reference.split(':');
    let start = parts.next().unwrap_or("");
    let end = parts.next().filter(|end| !end.is_empty()).unwrap_or(start);
    let from = parse_cell_ref(start)?;
    let to = parse_cell_ref(end)?;
    let first_column = column_number(&from.col);
    let last_column = column_number(&to.col);
    for row_offset in 0..512_u64 {
        let Some(row) = from.row.checked_add(row_offset).filter(|row| *row <= to.row) else { break };
        let mut column = first_column;
        while column <= last_column && column - first_column < 64.0 {
            entry_cells.insert(format!("{}{row}", column_label(column)));
            column += 1.0;
        }
    }
    Ok(())
}

/// The cells the sheet's data validations ask the reader to fill in.
fn validation_entry_cells(xml: &str) -> Result<BTreeSet<String>, String> {
    let mut entry_cells = BTreeSet::new();
    for found in DATA_VALIDATION_OPEN.captures_iter(xml) {
        let sqref = xml_decode(&xml_attribute(found.get(1).unwrap_or(""), "sqref"));
        for reference in sqref.split(mixdog_js::is_js_space).filter(|reference| !reference.is_empty()) {
            add_reference_cells(&mut entry_cells, reference)?;
        }
    }
    Ok(entry_cells)
}

/// The entry cells whose style still locks them under sheet protection, in reading order (row by row): a text sort named B10
/// before B6.
fn locked_entry_cells(xml: &str, styles: &[Value], mut entry_cells: BTreeSet<String>) -> Result<Vec<String>, String> {
    for cell in iterate_sheet_cells(xml) {
        if cell.reference.is_empty() || !entry_cells.contains(cell.reference) {
            continue;
        }
        if style_field(style_at(styles, style_index_of(cell.attributes)), "locked") == Some(&Value::Bool(false)) {
            entry_cells.remove(cell.reference);
        }
    }
    let mut positions = Vec::new();
    for reference in &entry_cells {
        positions.push(parse_cell_ref(reference)?);
    }
    positions.sort_by(|left, right| left.row.cmp(&right.row).then(column_number(&left.col).total_cmp(&column_number(&right.col))));
    Ok(positions.into_iter().map(|cell| cell.reference).collect())
}

/// `total` counts every entry cell the validations ask for: "all" only when none of them was opened.
fn protected_input_issue(sheet: &Sheet, locked: &[String], total: usize) -> Value {
    let named = if total == 1 {
        "the entry cell".to_owned()
    } else if locked.len() == total {
        format!("all {total} entry cells")
    } else {
        format!("{} of {total} entry cells", locked.len())
    };
    issue(
        "warning",
        "protected_input_locked",
        format!("/sheet[{}]/cell[{}]", sheet.name, locked[0]),
        format!(
            "Sheet protection is on and {named} ({}{}) {} locked, so nobody can type the value the validation asks for. Run set_style with properties {{ locked: false }} on the entry range before protect_sheet.",
            locked.iter().take(4).cloned().collect::<Vec<_>>().join(", "),
            if locked.len() > 4 { ", \u{2026}" } else { "" },
            if locked.len() == 1 { "stays" } else { "stay" }
        ),
        "sheet-protection",
    )
}

/// `protectedInputIssues(zip, sheets)`: a protected sheet locks every cell unless one is marked unlocked, so a form whose
/// entry cells stay locked cannot be filled in at all: the dropdown is there, and Excel refuses the keystroke.
pub fn protected_input_issues(zip: &Package, sheets: &[Sheet]) -> Result<Vec<Value>, String> {
    let styles = resolve_cell_styles(&zip.text("xl/styles.xml"));
    let mut issues = Vec::new();
    for sheet in sheets {
        let xml = zip.text(&sheet.path);
        if xml.is_empty() || !SHEET_PROTECTION.is_match(&xml) {
            continue;
        }
        let entry_cells = validation_entry_cells(&xml)?;
        let total = entry_cells.len();
        if total == 0 {
            continue;
        }
        let locked = locked_entry_cells(&xml, &styles, entry_cells)?;
        if locked.is_empty() {
            continue;
        }
        issues.push(protected_input_issue(sheet, &locked, total));
        if issues.len() >= ISSUE_CAP {
            return Ok(issues);
        }
    }
    Ok(issues)
}

/// How a sheet lays out and styles what the fit audits measure.
struct Measure<'a> {
    xml: &'a str,
    geometry: crate::sheet_page::WorksheetGeometry,
    digit_width: f64,
    withheld: HiddenAreas,
    styles: &'a [Value],
    strings: &'a [String],
}

impl Measure<'_> {
    /// The characters each column holds inside Excel's 5 pixels of cell padding, in the default font's digit width, as the
    /// sheet lays the column out (an undeclared one at the sheet's default). Read as the stored number, a width Excel wrote
    /// (9.625 for 9 characters) lent its padding to the text and one the portable writer wrote bare did not.
    fn width(&self, column: f64) -> f64 {
        math::max(0.0, (self.geometry.column_points(column) / 0.75 - 5.0) / self.digit_width)
    }

    /// The measure `autofit_range` sizes columns by (`cellWidthScale`).
    fn size_scale(&self, style_index: usize) -> f64 {
        let size = to_number_of(style_field(style_at(self.styles, 0), "fontSize"));
        cell_width_scale(style_at(self.styles, style_index), if size.is_nan() || size == 0.0 { 11.0 } else { size }, style_index == 0)
    }
}

/// One cell cut on its column: the column answers once with the worst cell and how many it takes down.
#[derive(Debug, Clone, Default)]
struct Cut {
    reference: String,
    text: String,
    needed: f64,
    width: f64,
    general: bool,
    neighbour: String,
    count: usize,
}

/// `noteCutCell(byColumn, column, entry)`.
fn note_cut_cell(by_column: &mut BTreeMap<u64, Cut>, column: f64, entry: Cut) {
    let key = column as u64;
    match by_column.get_mut(&key) {
        None => {
            by_column.insert(key, Cut { count: 1, ..entry });
        }
        Some(found) => {
            found.count += 1;
            if entry.needed > found.needed {
                *found = Cut { count: found.count, ..entry };
            }
        }
    }
}

/// An A1 reference (`B2` or `B2:D9`) as the block of cells it covers; a range the sheet never wrote is no area at all.
fn reference_area(reference: &str) -> Result<Option<Area>, String> {
    if reference.split(':').next().unwrap_or("").is_empty() {
        return Ok(None);
    }
    parse_area_range(reference).map(Some)
}

fn merged_areas(xml: &str) -> Result<Vec<Area>, String> {
    let mut areas = Vec::new();
    for reference in merged_ranges(xml) {
        if let Some(area) = reference_area(&reference)? {
            areas.push(area);
        }
    }
    Ok(areas)
}

/// Whether a merge that continues past this column covers the cell.
fn inside_merged_area(merged: &[Area], column: f64, row: f64) -> bool {
    merged.iter().any(|area| area.start_col <= column && area.end_col > column && area.start_row <= row && area.end_row >= row)
}

/// The width a label may run across: its own column and the empty shown columns up to its next filled neighbour.
fn label_room(measure: &Measure<'_>, column: f64, neighbour_column: f64) -> f64 {
    let mut available = measure.width(column);
    let mut next = column + 1.0;
    while next < neighbour_column {
        if !column_withheld(&measure.withheld, next) {
            available += measure.width(next);
        }
        next += 1.0;
    }
    available
}

/// Numbers a column is too narrow to show: one narrow column cuts every value in it; reporting each cell would fill the
/// issue list with one fault and hide the rest.
fn narrow_number_columns(measure: &Measure<'_>) -> Result<BTreeMap<u64, Cut>, String> {
    let mut narrow_columns = BTreeMap::new();
    // A merged cell prints its number across the whole merge: a metric card's 27 pt "92.8%" over A:B was reported cut by
    // column A alone.
    let merges = merged_areas(measure.xml)?;
    for cell in iterate_sheet_cells(measure.xml) {
        if NON_NUMERIC_TYPE.is_match(cell.attributes) {
            continue;
        }
        let value = first_group(&VALUE_PLAIN, cell.body).map_or(f64::NAN, |raw| string_to_number(&raw));
        if !value.is_finite() || cell.reference.is_empty() {
            continue;
        }
        let position = parse_cell_ref(cell.reference)?;
        let column = column_number(&position.col);
        if column_withheld(&measure.withheld, column) || row_withheld(&measure.withheld, position.row) {
            continue;
        }
        let merge = merges.iter().find(|area| area.start_col == column && area.start_row == position.row as f64);
        let mut width = measure.width(column);
        if let Some(merge) = merge {
            let mut spanned = column + 1.0;
            while spanned <= merge.end_col {
                width += measure.width(spanned);
                spanned += 1.0;
            }
        }
        let style = first_group(&STYLE_INDEX, cell.attributes).and_then(|digits| digits.parse::<usize>().ok());
        let format = style
            .and_then(|index| style_field(style_at(measure.styles, index), "numberFormat"))
            .filter(|format| truthy(format))
            .map(value_to_string)
            .unwrap_or_default();
        // General never prints ###: Excel rounds the decimals to the column, so only an integer part wider than the column
        // changes what is read (into scientific notation). Measured whole, 0.5700000000000001 was a false cut.
        let general = format.is_empty() || GENERAL_FORMAT.is_match(&format);
        let integer_width = utf16_len(&number_to_string(value.abs().trunc())) + usize::from(value < 0.0);
        let printed = if general { integer_width } else { formatted_number_width(Some(&json_number(value)), &format) };
        let needed = printed as f64 * measure.size_scale(style.unwrap_or(0));
        if needed <= width + 0.5 {
            continue;
        }
        note_cut_cell(&mut narrow_columns, column, Cut { reference: cell.reference.to_owned(), needed, width, general, ..Cut::default() });
    }
    Ok(narrow_columns)
}

/// Labels cut at the column edge: text spills into an empty neighbour, but is cut as soon as the next cell holds something:
/// the reader sees half a label. The label runs until the first column to its right that holds something: the empty columns
/// before it lend their width, and a hidden column lends none, because the sheet gives it no room on the page.
fn cut_label_columns<P: ReadProof>(measurer: &TextMeasurer<'_, P>, measure: &Measure<'_>) -> Result<BTreeMap<u64, Cut>, String> {
    let merged = merged_areas(measure.xml)?;
    let mut cut_labels = BTreeMap::new();
    for row in iterate_sheet_rows(measure.xml) {
        let mut cells: Vec<(f64, SheetCell<'_>)> = Vec::new();
        for cell in iterate_sheet_cells(row.body).into_iter().filter(|cell| !cell.reference.is_empty()) {
            cells.push((column_number(&parse_cell_ref(cell.reference)?.col), cell));
        }
        cells.sort_by(|left, right| left.0.total_cmp(&right.0));
        for (index, (column, cell)) in cells.iter().enumerate() {
            if column_withheld(&measure.withheld, *column) {
                continue;
            }
            let text = js_trim(&cell_text(cell, measure.strings)).to_owned();
            if text.is_empty() {
                continue;
            }
            let neighbour = cells[index + 1..]
                .iter()
                .find(|(_, candidate)| !js_trim(&cell_text(candidate, measure.strings)).is_empty() || VALUE_ANY.is_match(candidate.body));
            let Some((neighbour_column, _)) = neighbour else { continue };
            let style_index = style_index_of(cell.attributes);
            if style_field(style_at(measure.styles, style_index), "wrapText") == Some(&Value::Bool(true)) {
                continue;
            }
            let row_number = parse_cell_ref(cell.reference)?.row;
            if row_withheld(&measure.withheld, row_number) || inside_merged_area(&merged, *column, row_number as f64) {
                continue;
            }
            let width = measure.width(*column);
            let available = label_room(measure, *column, *neighbour_column);
            // The measure autofit_range sizes a label column by.
            let style = style_at(measure.styles, style_index).filter(|style| truthy(style)).or_else(|| style_at(measure.styles, 0));
            let indent = to_number_of(style_field(style_at(measure.styles, style_index), "indent"));
            let needed = text_characters(measurer, &Value::String(text.clone()), style, measure.digit_width)? + if indent.is_nan() { 0.0 } else { indent };
            if needed <= available + 0.5 {
                continue;
            }
            let neighbour_reference = format!("{}{row_number}", column_label(*neighbour_column));
            note_cut_cell(
                &mut cut_labels,
                *column,
                Cut { reference: cell.reference.to_owned(), text, needed, width, neighbour: neighbour_reference, ..Cut::default() },
            );
        }
    }
    Ok(cut_labels)
}

/// A figure set on its column's right edge with a label set on the next column's left edge: two cells' padding between them,
/// so "38" and "\u{AE40}\u{C11C}\u{C5F0}" read as one cell. Counted per pair of columns over the rows that hold both; a label
/// column with an indent, or alignment of its own away from the figure, is clear of it.
const FIGURE_LABEL_ROWS: usize = 2;

fn figure_label_pairs(measure: &Measure<'_>) -> Result<BTreeMap<u64, Cut>, String> {
    let mut pairs: BTreeMap<u64, Cut> = BTreeMap::new();
    let alignment =
        |style: Option<&Value>| style_field(style, "horizontalAlignment").filter(|value| truthy(value)).map_or_else(|| "general".to_owned(), value_to_string);
    for row in iterate_sheet_rows(measure.xml) {
        // A Map keeps the first place of a column and the last cell written to it.
        let mut order: Vec<f64> = Vec::new();
        let mut cells: HashMap<u64, SheetCell<'_>> = HashMap::new();
        for cell in iterate_sheet_cells(row.body).into_iter().filter(|cell| !cell.reference.is_empty()) {
            let column = column_number(&parse_cell_ref(cell.reference)?.col);
            if cells.insert(column as u64, cell).is_none() {
                order.push(column);
            }
        }
        for column in order {
            let cell = cells[&(column as u64)];
            let Some(next) = cells.get(&(column as u64 + 1)) else { continue };
            if column_withheld(&measure.withheld, column) || column_withheld(&measure.withheld, column + 1.0) {
                continue;
            }
            if row_withheld(&measure.withheld, parse_cell_ref(cell.reference)?.row) {
                continue;
            }
            let style_of = |entry: &SheetCell<'_>| style_at(measure.styles, style_index_of(entry.attributes));
            let figure = !NON_NUMERIC_TYPE.is_match(cell.attributes) && VALUE_OPEN.is_match(cell.body);
            let figure_align = alignment(style_of(&cell));
            let label = TEXT_TYPE.is_match(next.attributes) && !js_trim(&cell_text(next, measure.strings)).is_empty();
            let label_style = style_of(next);
            let label_align = alignment(label_style);
            if !figure || !["general", "right"].contains(&figure_align.as_str()) {
                continue;
            }
            if !label || !["general", "left"].contains(&label_align.as_str()) || to_number_of(style_field(label_style, "indent")) > 0.0 {
                continue;
            }
            match pairs.get_mut(&(column as u64)) {
                Some(found) => found.count += 1,
                None => {
                    pairs.insert(column as u64, Cut { reference: next.reference.to_owned(), count: 1, ..Cut::default() });
                }
            }
        }
    }
    pairs.retain(|_, entry| entry.count >= FIGURE_LABEL_ROWS);
    Ok(pairs)
}

/// `columnFitIssues(zip, sheets)`: numbers a column cannot show, labels cut by a filled neighbour, and figures that read as
/// one cell with the label beside them.
pub fn column_fit_issues<P: ReadProof>(measurer: &TextMeasurer<'_, P>, zip: &Package, sheets: &[Sheet]) -> Result<Vec<Value>, String> {
    let strings = shared_strings(zip);
    let styles_xml = zip.text("xl/styles.xml");
    let styles = resolve_cell_styles(&styles_xml);
    let digit_width = maximum_digit_width(measurer, &styles_xml)?;
    let mut issues = Vec::new();
    for sheet in sheets {
        // Fit is about what a reader sees. A hidden sheet, row, or column shows nothing, so measuring it reports a defect
        // nobody can look at: and the fix round then widens a column the workbook deliberately withholds.
        if sheet.visibility != "visible" {
            continue;
        }
        let xml = zip.text(&sheet.path);
        if xml.is_empty() {
            continue;
        }
        let measure = Measure {
            xml: &xml,
            geometry: worksheet_geometry(&xml, digit_width),
            digit_width,
            withheld: hidden_sheet_areas(&xml),
            styles: &styles,
            strings: &strings,
        };
        for (column, entry) in narrow_number_columns(&measure)? {
            issues.push(issue(
                "warning",
                "column_too_narrow",
                format!("/sheet[{}]/cell[{}]", sheet.name, entry.reference),
                format!(
                    "Number needs about {} characters but column {} is {} wide; {}{} Run autofit_range.",
                    number_to_string(math::ceil(entry.needed)),
                    column_label(column as f64),
                    math::to_fixed(entry.width, 1),
                    if entry.general { "Excel prints it in scientific notation." } else { "Excel shows ###." },
                    if entry.count > 1 { format!(" {} cells in this column are cut.", entry.count) } else { String::new() }
                ),
                "number-format",
            ));
            if issues.len() >= ISSUE_CAP {
                return Ok(issues);
            }
        }
        for (column, entry) in cut_label_columns(measurer, &measure)? {
            let shown = if utf16_len(&entry.text) > 24 {
                let cut = cut_utf16(&entry.text, 24);
                format!("{}{}\u{2026}", cut.head, if cut.dangling_high.is_some() { "\u{FFFD}" } else { "" })
            } else {
                entry.text.clone()
            };
            issues.push(issue(
                "warning",
                "label_truncated",
                format!("/sheet[{}]/cell[{}]", sheet.name, entry.reference),
                format!(
                    "\"{shown}\" needs about {} characters but column {} is {} wide and {} has content, so the label is cut.{} Run autofit_range or widen the column.",
                    number_to_string(math::ceil(entry.needed)),
                    column_label(column as f64),
                    math::to_fixed(entry.width, 1),
                    entry.neighbour,
                    if entry.count > 1 { format!(" {} labels in this column are cut.", entry.count) } else { String::new() }
                ),
                "column-fit",
            ));
            if issues.len() >= ISSUE_CAP {
                return Ok(issues);
            }
        }
        for (column, entry) in figure_label_pairs(&measure)? {
            issues.push(issue(
                "info",
                "figure_label_adjacent",
                format!("/sheet[{}]/cell[{}]", sheet.name, entry.reference),
                format!(
                    "Column {}'s figures end on its right edge and column {}'s labels start on its left edge in {} rows, so the two read as one cell; set_style indent:1 on column {} (header too).",
                    column_label(column as f64),
                    column_label(column as f64 + 1.0),
                    entry.count,
                    column_label(column as f64 + 1.0)
                ),
                "column-fit",
            ));
            if issues.len() >= ISSUE_CAP {
                return Ok(issues);
            }
        }
    }
    Ok(issues)
}

/// `formulaConsistencyIssues(zip, sheets)`: a pasted result where a formula belongs stops recalculating, and the row goes on
/// looking right. Only a constant the row's formulas have already started is read that way: the first period of a projection
/// is the input every later period grows from, and calling that an interruption reports the ordinary shape of a plan as a
/// defect.
pub fn formula_consistency_issues(zip: &Package, sheets: &[Sheet]) -> Vec<Value> {
    let mut issues = Vec::new();
    for sheet in sheets {
        let xml = zip.text(&sheet.path);
        if xml.is_empty() {
            continue;
        }
        for row in iterate_sheet_rows(&xml) {
            let cells: Vec<(&str, bool, bool)> = iterate_sheet_cells(row.body)
                .into_iter()
                .map(|cell| {
                    let numeric = !NON_NUMERIC_TYPE.is_match(cell.attributes)
                        && first_group(&VALUE_PLAIN, cell.body).is_some_and(|raw| string_to_number(&raw).is_finite());
                    (cell.reference, FORMULA_OPEN.is_match(cell.body), numeric)
                })
                .collect();
            if cells.iter().filter(|cell| cell.1).count() < 3 {
                continue;
            }
            let mut started = false;
            for (reference, formula, numeric) in cells {
                if formula {
                    started = true;
                    continue;
                }
                if !started || !numeric || reference.is_empty() {
                    continue;
                }
                issues.push(issue(
                    "warning",
                    "formula_inconsistency",
                    format!("/sheet[{}]/cell[{reference}]", sheet.name),
                    "A hardcoded value interrupts a row of formulas; a lone edited cell mid-row is a common silent error.".to_owned(),
                    "formula-audit",
                ));
                if issues.len() >= ISSUE_CAP {
                    return issues;
                }
            }
        }
    }
    issues
}

/// The ranges Excel tables own: inside one, the table style paints the header and banding, so a cell there carries a fill this
/// scan cannot read from the cell itself.
fn table_ranges(zip: &Package, sheet: &Sheet, xml: &str) -> Result<Vec<Area>, String> {
    let Some(parts) = worksheet_section(xml, "tableParts").map(|range| &xml[range]) else { return Ok(Vec::new()) };
    let relations = zip.text(&part_relationship_path(&sheet.path));
    if relations.is_empty() {
        return Ok(Vec::new());
    }
    let targets = relationship_targets_by_type(&relations, &sheet.path, "table");
    let mut ranges = Vec::new();
    for found in TABLE_PART.captures_iter(parts) {
        let Some(part) = targets.get(found.get(1).unwrap_or("")) else { continue };
        let reference = first_group(&TABLE_REF, &zip.text(part)).unwrap_or_default();
        if let Some(area) = reference_area(&reference)? {
            ranges.push(area);
        }
    }
    Ok(ranges)
}

/// `cellInkIssues(zip, sheets)`: ink a reader cannot see: a header that keeps the body's dark colour on its dark fill, or text
/// so pale it disappears into the sheet. The readable minimum is the one the deck review applies: 4.5:1, or 3:1 for large or
/// bold type.
pub fn cell_ink_issues(zip: &Package, sheets: &[Sheet]) -> Result<Vec<Value>, String> {
    let strings = shared_strings(zip);
    let styles = resolve_cell_styles(&zip.text("xl/styles.xml"));
    let mut issues = Vec::new();
    for sheet in sheets {
        // Unreadable ink is what a reader sees; a withheld sheet, row, or column shows nobody anything.
        if sheet.visibility != "visible" {
            continue;
        }
        let xml = zip.text(&sheet.path);
        if xml.is_empty() {
            continue;
        }
        let withheld = hidden_sheet_areas(&xml);
        let tables = table_ranges(zip, sheet, &xml)?;
        for cell in iterate_sheet_cells(&xml) {
            let style_index = style_index_of(cell.attributes);
            let style = if style_index > 0 { style_at(&styles, style_index) } else { None };
            let Some(color) = style_field(style, "color").filter(|color| truthy(color)) else { continue };
            if cell.reference.is_empty() {
                continue;
            }
            let has_content = !js_trim(&cell_text(&cell, &strings)).is_empty() || VALUE_ANY.is_match(cell.body);
            if !has_content {
                continue;
            }
            let position = parse_cell_ref(cell.reference)?;
            let column = column_number(&position.col);
            if column_withheld(&withheld, column) || row_withheld(&withheld, position.row) {
                continue;
            }
            let row = position.row as f64;
            let in_table = tables.iter().any(|range| column >= range.start_col && column <= range.end_col && row >= range.start_row && row <= range.end_row);
            let fill = style_field(style, "fillColor").filter(|fill| truthy(fill)).map(value_to_string);
            if fill.is_none() && in_table {
                continue;
            }
            let font_size = to_number_of(style_field(style, "fontSize"));
            let size = if font_size.is_nan() || font_size == 0.0 { 11.0 } else { font_size };
            let bold = style_field(style, "bold") == Some(&Value::Bool(true));
            let minimum = if size >= 18.0 || (size >= 14.0 && bold) { 3.0 } else { 4.5 };
            let Some(ratio) = contrast_ratio(&value_to_string(color), fill.as_deref().unwrap_or("FFFFFF")) else { continue };
            if ratio >= minimum {
                continue;
            }
            issues.push(issue(
                "warning",
                "low_contrast",
                format!("/sheet[{}]/cell[{}]", sheet.name, cell.reference),
                format!(
                    "Cell text contrast is {}:1 against {}; {}:1 is the readable minimum at {}pt.",
                    math::to_fixed(ratio, 2),
                    match &fill {
                        Some(fill) => format!("its fill {fill}"),
                        None => "the sheet".to_owned(),
                    },
                    number_to_string(minimum),
                    number_to_string(math::round(size))
                ),
                "text-metrics",
            ));
            if issues.len() >= INK_ISSUE_CAP {
                return Ok(issues);
            }
        }
    }
    Ok(issues)
}
