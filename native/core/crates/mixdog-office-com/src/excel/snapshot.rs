//! `Snapshot-Excel`: the whole-workbook read, one entry per worksheet and the workbook's own record.

use std::collections::HashMap;

use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::ps::Object;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::collate::SortOptions;
use crate::ps::collate::sort_values;
use crate::ps::convert;
use crate::ps::payload;
use crate::ps::text;

use super::cells::attempt;
use super::cells::bool_of;
use super::cells::cell_value;
use super::cells::column_letters;
use super::cells::count_of;
use super::cells::dimension_count;
use super::cells::double_of;
use super::cells::drawing_anchor;
use super::cells::frozen_split;
use super::cells::get_with;
use super::cells::int_of;
use super::cells::is_ps_null;
use super::cells::items_of;
use super::cells::matrix_value;
use super::cells::min_int;
use super::cells::blocks_fitting;
use super::cells::ordered;
use super::cells::payload_flag;
use super::cells::payload_text;
use super::cells::ps_of;
use super::cells::relative_address;
use super::cells::string_of;
use super::styles::column_cell_styles;
use super::styles::default_style;
use super::validation::formula_lineage;
use super::validation::validation_blocks;

/// The most cells a sheet's page of the whole-workbook read holds, and the bounds of the walks that keep it cheap.
const PAGE_CELLS: i32 = 500;
const HIDDEN_ROW_SCAN: i32 = 500;
const HIDDEN_COLUMN_SCAN: i32 = 200;
const MERGE_SCAN_CELLS: i32 = 2000;
const VALUES_CELLS: i64 = 2000;

/// `Snapshot-Excel`.
pub(super) fn snapshot_excel(book: &Obj, payload: &Value) -> Result<Value> {
    let book = Com::Dispatch(book.clone());
    let mut sheets = Vec::new();
    let mut complete_cells = 0usize;
    for sheet in items_of(&book.member("Worksheets")?)? {
        let (entry, cell_count) = sheet_entry(&book, &sheet, payload)?;
        complete_cells += cell_count;
        sheets.push(entry);
    }
    let mut defined_names = Vec::new();
    let mut index = 1;
    while i64::from(index) <= count_of(&book.member("Names")?)? {
        let read = |index: i32| -> Result<Option<Value>> {
            let names = book.member("Names")?;
            let name = get_with(&names, "Item", &[Com::I4(index)])?;
            // Excel keeps hidden _xlfn./_xlpm. names of its own for the functions a file uses; the workbook never defined
            // them, and the portable reader does not list them.
            if !bool_of(&name.member("Visible")?)
                && text::is_match(&string_of(&name.member("Name")?), r"^_xl(fn|pm|ws)\.", false).unwrap_or(false)
            {
                return Ok(None);
            }
            Ok(Some(ordered(vec![
                ("path", Value::String(format!("/defined-name[{index}]"))),
                ("index", Value::Int(index)),
                ("name", Value::String(string_of(&name.member("Name")?))),
                ("nameLocal", Value::String(string_of(&name.member("NameLocal")?))),
                ("refersTo", Value::String(string_of(&name.member("RefersTo")?))),
                ("refersToLocal", Value::String(string_of(&name.member("RefersToLocal")?))),
                ("visible", Value::Bool(bool_of(&name.member("Visible")?))),
            ])))
        };
        if let Some(Some(entry)) = attempt(|| read(index)) {
            defined_names.push(entry);
        }
        index += 1;
    }
    // A paged request is always answered with a pagination block, so a caller can tell a whole snapshot from a silently
    // truncated one.
    let path = string_of(&book.member("FullName")?);
    let active_sheet = string_of(&book.member("ActiveSheet")?.member("Name")?);
    let style = default_style(&book);
    let defined_name_count = defined_names.len();
    let pagination = if payload_flag(payload, "paged") {
        let limit = convert::to_int(&payload::property(payload, "limit")).map_err(crate::com::Error::host)?.max(1);
        ordered(vec![
            ("unit", Value::string("cell")),
            ("scope", Value::string("workbook")),
            ("offset", Value::Int(0)),
            ("limit", Value::Int(limit)),
            ("returned", Value::Long(complete_cells as i64)),
            ("total", Value::Long(complete_cells as i64)),
            ("nextOffset", Value::Null),
        ])
    } else {
        Value::Null
    };
    Ok(ordered(vec![
        ("format", Value::string("xlsx")),
        ("path", Value::String(path)),
        ("activeSheet", Value::String(active_sheet)),
        ("defaultStyle", style),
        ("definedNameCount", Value::Int(defined_name_count as i32)),
        ("definedNames", Value::Array(defined_names)),
        ("sheets", Value::Array(sheets)),
        ("pagination", pagination),
    ]))
}

fn sheet_path(sheet: &Com) -> Result<String> {
    Ok(format!("/sheet[{}]", string_of(&sheet.member("Name")?)))
}

/// The hidden rows and columns of the used range, which the portable reader answers with the same two lists (so an edit
/// never lands in a hidden column on one backend and a visible one on the other).
fn hidden_lines(used: &Com) -> (Vec<Value>, Vec<Value>) {
    let mut rows = Vec::new();
    let mut columns = Vec::new();
    let _ = (|| -> Result<()> {
        // One question answers the common case: with no row or column of the range hidden, its visible cells are the
        // range itself in one area, and the walk (two calls a row and a column) is skipped. Excel answers
        // EntireRow.Hidden with False for a range whose rows are mixed, so that could not tell.
        let mut all_visible = false;
        let _ = attempt(|| {
            let visible = used.call_member("SpecialCells", &[Com::I4(12)])?;
            all_visible = int_of(&visible.member("Areas")?.member("Count")?)? == 1
                && payload::names_equal(&string_of(&get_with(&visible, "Address", &[])?), &string_of(&get_with(used, "Address", &[])?));
            Ok(())
        });
        if !all_visible && dimension_count(used, "Rows")? <= HIDDEN_ROW_SCAN {
            let first_row = int_of(&used.member("Row")?)?;
            let mut index = 1;
            while index <= dimension_count(used, "Rows")? {
                let line = get_with(&used.member("Rows")?, "Item", &[Com::I4(index)])?;
                if bool_of(&line.member("Hidden")?) {
                    rows.push(Value::Int(first_row + index - 1));
                }
                index += 1;
            }
        }
        if !all_visible && dimension_count(used, "Columns")? <= HIDDEN_COLUMN_SCAN {
            let first_column = int_of(&used.member("Column")?)?;
            let mut index = 1;
            while index <= dimension_count(used, "Columns")? {
                let line = get_with(&used.member("Columns")?, "Item", &[Com::I4(index)])?;
                if bool_of(&line.member("Hidden")?) {
                    columns.push(Value::String(column_letters(first_column + index - 1)));
                }
                index += 1;
            }
        }
        Ok(())
    })();
    (rows, columns)
}

/// What every printed page says in one place of the header or footer, in the same `&L`/`&C`/`&R` form the file stores.
fn print_slots(setup: &Com, kind: &str) -> Result<String> {
    let mut text = String::new();
    for (code, side) in [("L", "Left"), ("C", "Center"), ("R", "Right")] {
        let slot = string_of(&setup.member(&format!("{side}{kind}"))?);
        if !slot.is_empty() {
            text.push('&');
            text.push_str(code);
            text.push_str(&slot);
        }
    }
    Ok(text)
}

/// The page setup, read through one PageSetup object (each `$sheet.PageSetup` is a round trip through the printer driver).
fn page_setup_record(setup: &Com) -> Value {
    let raw = |name: &str| attempt(|| Ok(ps_of(&setup.member(name)?))).unwrap_or(Value::Null);
    let number = |name: &str| Value::Int(attempt(|| int_of(&setup.member(name)?)).unwrap_or(0));
    // Relative, as the portable reader reports it: the review parses A1:P30, and $A$1:$P$30 read as no print area at all.
    let print_area = attempt(|| Ok(string_of(&setup.member("PrintArea")?).replace('$', ""))).unwrap_or_default();
    ordered(vec![
        ("printArea", Value::String(print_area)),
        ("zoom", raw("Zoom")),
        ("fitToPagesWide", raw("FitToPagesWide")),
        ("fitToPagesTall", raw("FitToPagesTall")),
        ("orientation", number("Orientation")),
        ("paperSize", number("PaperSize")),
        ("header", Value::String(attempt(|| print_slots(setup, "Header")).unwrap_or_default())),
        ("footer", Value::String(attempt(|| print_slots(setup, "Footer")).unwrap_or_default())),
    ])
}

fn tables_of(sheet: &Com) -> Result<Vec<Value>> {
    let mut tables = Vec::new();
    let mut index = 1;
    while i64::from(index) <= count_of(&sheet.member("ListObjects")?)? {
        let table = get_with(&sheet.member("ListObjects")?, "Item", &[Com::I4(index)])?;
        tables.push(ordered(vec![
            ("path", Value::String(format!("{}/table[{index}]", sheet_path(sheet)?))),
            ("index", Value::Int(index)),
            ("name", Value::String(string_of(&table.member("Name")?))),
            ("range", Value::String(string_of(&relative_address(&table.member("Range")?)?))),
            ("style", Value::String(string_of(&table.member("TableStyle")?))),
        ]));
        index += 1;
    }
    Ok(tables)
}

fn chart_objects(sheet: &Com) -> Result<Com> {
    sheet.call_member("ChartObjects", &[])
}

fn series_of(chart: &Com) -> Vec<Value> {
    let mut series = Vec::new();
    let _ = (|| -> Result<()> {
        let mut index = 1;
        while i64::from(index) <= count_of(&chart.call_member("SeriesCollection", &[])?)? {
            let item = get_with(&chart.call_member("SeriesCollection", &[])?, "Item", &[Com::I4(index)])?;
            series.push(ordered(vec![
                ("index", Value::Int(index)),
                ("name", Value::String(string_of(&item.member("Name")?))),
                ("formula", Value::String(string_of(&item.member("Formula")?))),
            ]));
            index += 1;
        }
        Ok(())
    })();
    series
}

fn charts_of(sheet: &Com) -> Result<Vec<Value>> {
    let mut charts = Vec::new();
    let mut index = 1;
    while i64::from(index) <= count_of(&chart_objects(sheet)?)? {
        let chart_object = get_with(&chart_objects(sheet)?, "Item", &[Com::I4(index)])?;
        let chart = chart_object.member("Chart")?;
        let series = series_of(&chart);
        let path = format!("{}/chart[{index}]", sheet_path(sheet)?);
        let name = string_of(&chart_object.member("Name")?);
        let chart_type = int_of(&chart.member("ChartType")?)?;
        let title = if bool_of(&chart.member("HasTitle")?) { string_of(&chart.member("ChartTitle")?.member("Text")?) } else { String::new() };
        let left = double_of(&chart_object.member("Left")?)?;
        let top = double_of(&chart_object.member("Top")?)?;
        let width = double_of(&chart_object.member("Width")?)?;
        let height = double_of(&chart_object.member("Height")?)?;
        let anchor = drawing_anchor(&chart_object);
        charts.push(ordered(vec![
            ("path", Value::String(path)),
            ("index", Value::Int(index)),
            ("name", Value::String(name)),
            ("chartType", Value::Int(chart_type)),
            ("title", Value::String(title)),
            ("left", Value::Double(left)),
            ("top", Value::Double(top)),
            ("width", Value::Double(width)),
            ("height", Value::Double(height)),
            ("anchor", anchor),
            ("series", Value::Array(series)),
        ]));
        index += 1;
    }
    Ok(charts)
}

/// The pictures, placed on the grid as the portable reader places them: without them (and the charts' cells) the review's
/// print-area and overlap checks never ran on a workbook Excel had opened.
fn images_of(sheet: &Com) -> Result<Vec<Value>> {
    let mut images: Vec<Value> = Vec::new();
    for shape in items_of(&sheet.member("Shapes")?)? {
        let read = || -> Result<Option<Value>> {
            if int_of(&shape.member("Type")?)? != 13 {
                return Ok(None);
            }
            let number = images.len() as i32 + 1;
            let path = format!("{}/image[{number}]", sheet_path(sheet)?);
            let name = string_of(&shape.member("Name")?);
            let alt_text = string_of(&shape.member("AlternativeText")?);
            Ok(Some(ordered(vec![
                ("path", Value::String(path)),
                ("index", Value::Int(number)),
                ("name", Value::String(name)),
                ("altText", Value::String(alt_text)),
                ("anchor", drawing_anchor(&shape)),
            ])))
        };
        if let Some(Some(image)) = attempt(read) {
            images.push(image);
        }
    }
    Ok(images)
}

fn pivots_of(sheet: &Com) -> Result<Vec<Value>> {
    let mut pivots = Vec::new();
    let mut index = 1;
    while i64::from(index) <= count_of(&sheet.call_member("PivotTables", &[])?)? {
        let pivot = get_with(&sheet.call_member("PivotTables", &[])?, "Item", &[Com::I4(index)])?;
        pivots.push(ordered(vec![
            ("path", Value::String(format!("{}/pivot[{index}]", sheet_path(sheet)?))),
            ("index", Value::Int(index)),
            ("name", Value::String(string_of(&pivot.member("Name")?))),
            ("range", Value::String(string_of(&relative_address(&pivot.member("TableRange2")?)?))),
        ]));
        index += 1;
    }
    Ok(pivots)
}

fn validations_of(sheet: &Com, validations: &mut Vec<Value>) -> Result<()> {
    let cells = sheet.member("Cells")?;
    let validated = cells.call_member("SpecialCells", &[Com::I4(-4174)])?;
    let mut blocks = Vec::new();
    let mut area_index = 1;
    while i64::from(area_index) <= count_of(&validated.member("Areas")?)? {
        let area = get_with(&validated.member("Areas")?, "Item", &[Com::I4(area_index)])?;
        blocks.extend(validation_blocks(sheet, &area)?);
        area_index += 1;
    }
    for area in blocks {
        let index = validations.len() as i32 + 1;
        let validation = get_with(&area.member("Cells")?, "Item", &[Com::I4(1), Com::I4(1)])?.member("Validation")?;
        let path = format!("{}/validation[{index}]", sheet_path(sheet)?);
        let ranges = Value::Array(vec![Value::String(string_of(&relative_address(&area)?))]);
        let kind = int_of(&validation.member("Type")?)?;
        let alert_style = int_of(&validation.member("AlertStyle")?)?;
        let operator = int_of(&validation.member("Operator")?)?;
        let allow_blank = bool_of(&validation.member("IgnoreBlank")?);
        let in_cell_dropdown = bool_of(&validation.member("InCellDropdown")?);
        let show_input = bool_of(&validation.member("ShowInput")?);
        let show_error = bool_of(&validation.member("ShowError")?);
        let input_title = string_of(&validation.member("InputTitle")?);
        let input_message = string_of(&validation.member("InputMessage")?);
        let error_title = string_of(&validation.member("ErrorTitle")?);
        let error_message = string_of(&validation.member("ErrorMessage")?);
        let formula1 = attempt(|| Ok(string_of(&validation.member("Formula1")?))).unwrap_or_default();
        let formula2 = attempt(|| Ok(string_of(&validation.member("Formula2")?))).unwrap_or_default();
        validations.push(ordered(vec![
            ("path", Value::String(path)),
            ("index", Value::Int(index)),
            ("ranges", ranges),
            ("type", Value::Int(kind)),
            ("alertStyle", Value::Int(alert_style)),
            ("operator", Value::Int(operator)),
            ("allowBlank", Value::Bool(allow_blank)),
            ("inCellDropdown", Value::Bool(in_cell_dropdown)),
            ("showInputMessage", Value::Bool(show_input)),
            ("showErrorMessage", Value::Bool(show_error)),
            ("inputTitle", Value::String(input_title)),
            ("inputMessage", Value::String(input_message)),
            ("errorTitle", Value::String(error_title)),
            ("errorMessage", Value::String(error_message)),
            ("formula1", Value::String(formula1)),
            ("formula2", Value::String(formula2)),
        ]));
    }
    Ok(())
}

fn conditional_formats_of(sheet: &Com, used: &Com, payload: &Value, formats: &mut Vec<Value>) -> Result<()> {
    let mut condition_range = used.clone();
    if payload_flag(payload, "range") && payload::names_equal(&payload_text(payload, "sheet"), &string_of(&sheet.member("Name")?)) {
        condition_range = get_with(sheet, "Range", &[Com::Str(payload_text(payload, "range"))])?;
    }
    let mut index = 1;
    while i64::from(index) <= count_of(&condition_range.member("FormatConditions")?)? {
        let condition = get_with(&condition_range.member("FormatConditions")?, "Item", &[Com::I4(index)])?;
        let path = format!("{}/conditional-format[{index}]", sheet_path(sheet)?);
        let range = match attempt(|| Ok(string_of(&relative_address(&condition.member("AppliesTo")?)?))) {
            Some(range) => range,
            None => string_of(&relative_address(&condition_range)?),
        };
        let kind = attempt(|| int_of(&condition.member("Type")?)).unwrap_or(0);
        let operator = attempt(|| int_of(&condition.member("Operator")?)).unwrap_or(0);
        let formula1 = attempt(|| Ok(string_of(&condition.member("Formula1")?))).unwrap_or_default();
        let formula2 = attempt(|| Ok(string_of(&condition.member("Formula2")?))).unwrap_or_default();
        let priority = attempt(|| int_of(&condition.member("Priority")?)).unwrap_or(0);
        formats.push(ordered(vec![
            ("path", Value::String(path)),
            ("index", Value::Int(index)),
            ("range", Value::String(range)),
            ("type", Value::Int(kind)),
            ("operator", Value::Int(operator)),
            ("formula1", Value::String(formula1)),
            ("formula2", Value::String(formula2)),
            ("priority", Value::Int(priority)),
        ]));
        index += 1;
    }
    Ok(())
}

fn notes_of(sheet: &Com, notes: &mut Vec<Value>) -> Result<()> {
    let comment_cells = sheet.member("Cells")?.call_member("SpecialCells", &[Com::I4(-4144)])?;
    for cell in items_of(&comment_cells.member("Cells")?)? {
        let path = format!("{}/cell[{}]/note", sheet_path(sheet)?, string_of(&relative_address(&cell)?));
        let reference = string_of(&relative_address(&cell)?);
        let text = string_of(&cell.member("Comment")?.call_member("Text", &[])?);
        let author = string_of(&cell.member("Comment")?.member("Author")?);
        notes.push(ordered(vec![
            ("path", Value::String(path)),
            ("cell", Value::String(reference)),
            ("text", Value::String(text)),
            ("author", Value::String(author)),
        ]));
    }
    Ok(())
}

/// The merged ranges of the used range, found by a walk that costs two COM calls per cell (seconds on an ordinary sheet)
/// and is bounded at 2,000 cells. Almost every sheet has no merged cell at all: asking the whole range once answers that,
/// as False means no cell in it is merged; only a mixed answer or an all-merged range needs the walk.
fn merged_ranges_of(used: &Com) -> Result<Vec<Value>> {
    let mut merged: Vec<String> = Vec::new();
    let range_merge = attempt(|| used.member("MergeCells")).unwrap_or(Com::Empty);
    if is_ps_null(&range_merge) || bool_of(&range_merge) {
        let mut scanned = 0;
        let mut row = 1;
        while i64::from(row) <= count_of_dimension(used, "Rows")? && scanned < MERGE_SCAN_CELLS {
            let mut column = 1;
            while i64::from(column) <= count_of_dimension(used, "Columns")? && scanned < MERGE_SCAN_CELLS {
                scanned += 1;
                let _ = attempt(|| {
                    let cell = get_with(&used.member("Cells")?, "Item", &[Com::I4(row), Com::I4(column)])?;
                    if bool_of(&cell.member("MergeCells")?) {
                        let address = string_of(&relative_address(&cell.member("MergeArea")?)?);
                        if !merged.iter().any(|known| payload::names_equal(known, &address)) {
                            merged.push(address);
                        }
                    }
                    Ok(())
                });
                column += 1;
            }
            row += 1;
        }
    }
    let values: Vec<Value> = merged.into_iter().map(Value::String).collect();
    Ok(sort_values(&values, SortOptions::default()))
}

fn count_of_dimension(range: &Com, dimension: &str) -> Result<i64> {
    count_of(&range.member(dimension)?)
}

fn freeze_panes_of(book: &Com, sheet: &Com) -> Result<Value> {
    let active = string_of(&book.member("ActiveSheet")?.member("Name")?);
    if !payload::names_equal(&active, &string_of(&sheet.member("Name")?)) {
        return Ok(Value::Null);
    }
    Ok(attempt(|| {
        let window = get_with(&book.member("Windows")?, "Item", &[Com::I4(1)])?;
        let (row, column) = frozen_split(&window)?;
        Ok(ordered(vec![
            ("frozen", Value::Bool(bool_of(&window.member("FreezePanes")?))),
            ("splitRow", Value::Int(row)),
            ("splitColumn", Value::Int(column)),
        ]))
    })
    .unwrap_or(Value::Null))
}

fn auto_filter_of(sheet: &Com) -> Value {
    attempt(|| {
        if bool_of(&sheet.member("AutoFilterMode")?) && !sheet.member("AutoFilter")?.is_null() {
            let range = string_of(&relative_address(&sheet.member("AutoFilter")?.member("Range")?)?);
            return Ok(ordered(vec![("enabled", Value::Bool(true)), ("range", Value::String(range))]));
        }
        Ok(Value::Null)
    })
    .unwrap_or(Value::Null)
}

/// Named as the portable reader and protect_sheet name it. Excel does not say whether a password guards the sheet without
/// trying one, so password is the portable reader's alone.
fn protection_of(sheet: &Com) -> Result<Value> {
    let protected = bool_of(&sheet.member("ProtectContents")?);
    let mut record = Object::new(ObjectKind::Ordered);
    record.set("protected", Value::Bool(protected));
    if protected {
        let _ = attempt(|| {
            let allowed = sheet.member("Protection")?;
            record.set("allowFormattingCells", Value::Bool(bool_of(&allowed.member("AllowFormattingCells")?)));
            record.set("allowSorting", Value::Bool(bool_of(&allowed.member("AllowSorting")?)));
            record.set("allowFiltering", Value::Bool(bool_of(&allowed.member("AllowFiltering")?)));
            Ok(())
        });
    }
    Ok(Value::Object(record))
}

/// One worksheet's entry and how many cells its page holds.
fn sheet_entry(book: &Com, sheet: &Com, payload: &Value) -> Result<(Value, usize)> {
    let used = sheet.member("UsedRange")?;
    // Rows and columns the sheet withholds (a filter, an outline, a working column).
    let (hidden_rows, hidden_columns) = hidden_lines(&used);
    // One PageSetup for every setting below: each `$sheet.PageSetup` is a round trip through the printer driver.
    let setup = attempt(|| sheet.member("PageSetup")).unwrap_or(Com::Empty);
    let path = sheet_path(sheet)?;
    let name = string_of(&sheet.member("Name")?);
    let rows = dimension_count(&used, "Rows")?;
    let columns = dimension_count(&used, "Columns")?;
    // Excel answers with a code (-1 visible, 0 hidden, 2 very hidden); the portable reader with the word
    // set_sheet_visibility takes, so one workbook must read the same on both backends.
    let visibility = match int_of(&sheet.member("Visible")?)? {
        0 => "hidden",
        2 => "very_hidden",
        _ => "visible",
    };
    let mut entry = Object::new(ObjectKind::Ordered);
    entry.set("path", Value::String(path));
    entry.set("name", Value::String(name));
    entry.set("rows", Value::Int(rows));
    entry.set("columns", Value::Int(columns));
    entry.set("visibility", Value::string(visibility));
    entry.set("hiddenRows", Value::Array(hidden_rows));
    entry.set("hiddenColumns", Value::Array(hidden_columns));
    entry.set("pageSetup", page_setup_record(&setup));
    let tables = tables_of(sheet)?;
    let charts = charts_of(sheet)?;
    let images = images_of(sheet)?;
    let pivots = pivots_of(sheet)?;
    let mut validations = Vec::new();
    let _ = attempt(|| validations_of(sheet, &mut validations));
    let mut conditional_formats = Vec::new();
    let _ = attempt(|| conditional_formats_of(sheet, &used, payload, &mut conditional_formats));
    let mut notes = Vec::new();
    let _ = attempt(|| notes_of(sheet, &mut notes));
    let merged_ranges = merged_ranges_of(&used)?;
    let freeze_panes = freeze_panes_of(book, sheet)?;
    let auto_filter = auto_filter_of(sheet);
    let protection = protection_of(sheet)?;
    entry.set("tables", Value::Array(tables));
    entry.set("charts", Value::Array(charts));
    entry.set("images", Value::Array(images));
    entry.set("pivots", Value::Array(pivots));
    entry.set("validationCount", Value::Int(validations.len() as i32));
    entry.set("validations", Value::Array(validations));
    entry.set("conditionalFormatCount", Value::Int(conditional_formats.len() as i32));
    entry.set("conditionalFormats", Value::Array(conditional_formats));
    entry.set("noteCount", Value::Int(notes.len() as i32));
    entry.set("notes", Value::Array(notes));
    entry.set("mergedRanges", crate::ps::unroll(merged_ranges));
    entry.set("freezePanes", freeze_panes);
    entry.set("autoFilter", auto_filter);
    entry.set("protection", protection);
    // A sheet past 500 cells reads its first rows up to that many cells and says it was cut, as the portable reader pages
    // it: it had read none, and every review of cells (the header, the hierarchy, the formulas) passed a large sheet on
    // Excel unread.
    let columns_read = min_int(dimension_count(&used, "Columns")?, PAGE_CELLS)?;
    let rows_read = min_int(dimension_count(&used, "Rows")?, blocks_fitting(PAGE_CELLS, columns_read)?)?;
    let truncated = rows_read < dimension_count(&used, "Rows")? || columns_read < dimension_count(&used, "Columns")?;
    entry.set("truncated", Value::Bool(truncated));
    // Where the sheet's rows end, past the page the cells were read from.
    let last_row = int_of(&used.member("Row")?)? + dimension_count(&used, "Rows")? - 1;
    entry.set("lastRow", Value::Int(last_row));
    let cells = read_cells(sheet, &used, rows_read, columns_read)?;
    let cell_count = cells.len();
    let lineage_entries: Vec<Value> =
        cells.iter().filter(|cell| convert::to_bool(&payload::property(cell, "formula"))).cloned().collect();
    entry.set("cells", Value::Array(cells));
    let lineage = formula_lineage(&lineage_entries, &string_of(&sheet.member("Name")?));
    let lineage_count = lineage.len() as i32;
    entry.set("formulaLineage", Value::Array(lineage));
    entry.set("lineageCount", Value::Int(lineage_count));
    if payload_flag(payload, "sheet") && payload::names_equal(&payload_text(payload, "sheet"), &string_of(&sheet.member("Name")?)) {
        let mut range = used.clone();
        if payload_flag(payload, "range") {
            range = get_with(sheet, "Range", &[Com::Str(payload_text(payload, "range"))])?;
        }
        let rows = i64::from(dimension_count(&range, "Rows")?);
        if rows * i64::from(dimension_count(&range, "Columns")?) <= VALUES_CELLS {
            entry.set("values", cell_value(&range)?);
            entry.set("address", Value::String(string_of(&get_with(&range, "Address", &[])?)));
        }
    }
    Ok((Value::Object(entry), cell_count))
}

/// The cells of the page: its values and formulas come in one array each (asking every cell cost two calls even when it
/// was empty, and its address a third). Only a cell holding something is asked about its style, a column's block at a time.
/// A formula-looking string is confirmed with HasFormula.
fn read_cells(sheet: &Com, used: &Com, rows_read: i32, columns_read: i32) -> Result<Vec<Value>> {
    let sheet_name = string_of(&sheet.member("Name")?);
    let first_row = int_of(&used.member("Row")?)?;
    let first_column = int_of(&used.member("Column")?)?;
    let first = get_with(&used.member("Cells")?, "Item", &[Com::I4(1), Com::I4(1)])?;
    let page = get_with(&first, "Resize", &[Com::I4(rows_read), Com::I4(columns_read)])?;
    let page_values = page.member("Value2")?;
    let page_formulas = page.member("Formula")?;
    let mut cells: Vec<Object> = Vec::new();
    // The populated rows of each column, whose styles are read below a block at a time.
    let mut column_rows: Vec<(String, Vec<i32>)> = Vec::new();
    for r in 1..=rows_read {
        for c in 1..=columns_read {
            let value = matrix_value(&page_values, r, c);
            let written = string_of(&matrix_value(&page_formulas, r, c));
            if is_ps_null(&value) && !written.starts_with('=') {
                continue;
            }
            let formula = if written.starts_with('=') && bool_of(&get_with(&page.member("Cells")?, "Item", &[Com::I4(r), Com::I4(c)])?.member("HasFormula")?)
            {
                Value::String(written)
            } else {
                Value::Null
            };
            if is_ps_null(&value) && formula.is_null() {
                continue;
            }
            let letters = column_letters(first_column + c - 1);
            let row = first_row + r - 1;
            let address = format!("{letters}{row}");
            let mut cell = Object::new(ObjectKind::Ordered);
            cell.set("path", Value::String(format!("/sheet[{sheet_name}]/cell[{address}]")));
            cell.set("ref", Value::String(address));
            cell.set("value", ps_of(&value));
            cell.set("formula", formula);
            cell.set("style", Value::Null);
            cells.push(cell);
            match column_rows.iter().position(|(known, _)| payload::names_equal(known, &letters)) {
                Some(at) => column_rows[at].1.push(row),
                None => column_rows.push((letters, vec![row])),
            }
        }
    }
    let mut styles: HashMap<String, Value> = HashMap::new();
    for (letters, rows) in &column_rows {
        column_cell_styles(sheet, letters, rows, &mut styles, 0, rows.len() - 1)?;
    }
    for cell in &mut cells {
        let reference = convert::to_ps_string(&cell.get("ref").cloned().unwrap_or(Value::Null));
        cell.set("style", styles.get(&reference).cloned().unwrap_or(Value::Null));
    }
    Ok(cells.into_iter().map(Value::Object).collect())
}
