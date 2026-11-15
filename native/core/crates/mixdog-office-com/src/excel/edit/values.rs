//! Values in cells: number formats (`Set-ExcelNumberFormat`), how a value is typed into a cell (`Excel-CellValue`,
//! `Excel-TextMayBecomeValue`, `Restore-ExcelText`, `Set-ExcelCellValue`) and `replace_text`, `set_cell`, `set_formula`,
//! `set_range`, `append_row`, `clear_cell`.

use std::sync::OnceLock;

use regex::Captures;
use regex::Regex;

use crate::com::Result;
use crate::com::SafeArray;
use crate::com::Value as Com;
use crate::excel::cells::bool_of;
use crate::excel::cells::get_with;
use crate::excel::cells::is_ps_null;
use crate::excel::numfmt::COLOR_KEYS;
use crate::excel::numfmt::color_names;
use crate::ps::Value;
use crate::ps::convert;

use super::cached;
use super::cell_at;
use super::com_text;
use super::array_items;
use super::int_of_com;
use super::is_match;
use super::prop;
use super::range_of;
use super::record_of;
use super::sheets::excel_sheet;
use super::text_of;

/// `$script:ExcelColorPattern`: a colour section of a number format, the 1-9 digit form `ColorN` in its second group.
const COLOR_PATTERN: &str = r"(?i)\[(Black|Blue|Cyan|Green|Magenta|Red|White|Yellow|Color(\d{1,2}))\]";

fn color_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    cached(&PATTERN, COLOR_PATTERN)
}

/// `Set-ExcelNumberFormat`: a format whose colours Excel refuses by their English names is written with the UI language's;
/// an install whose names are not known keeps the format without the colour rather than failing the batch.
pub(super) fn set_number_format(target: &Com, format: &str) -> Result<()> {
    match target.set_member("NumberFormat", com_text(format)) {
        Ok(()) => return Ok(()),
        Err(error) => {
            if !color_pattern().is_match(format) {
                return Err(error);
            }
        }
    }
    if let Some(names) = color_names(&target.member("Application")?) {
        let local = color_pattern()
            .replace_all(format, |captures: &Captures<'_>| {
                if let Some(number) = captures.get(2) {
                    return format!("[{}{}]", names.color, number.as_str());
                }
                let key = COLOR_KEYS.iter().find(|key| key.eq_ignore_ascii_case(&captures[1]));
                format!("[{}]", key.and_then(|key| names.name_of(key)).unwrap_or(""))
            })
            .into_owned();
        if target.set_member("NumberFormat", com_text(local)).is_ok() {
            return Ok(());
        }
    }
    target.set_member("NumberFormat", com_text(color_pattern().replace_all(format, "").into_owned()))
}

/// `Excel-CellValue`: a boolean stays one, every number is a Double, anything else its text; `$null` is nothing.
fn cell_value(value: &Value) -> Option<Com> {
    match value {
        Value::Null => None,
        Value::Bool(flag) => Some(Com::Bool(*flag)),
        Value::Int(n) => Some(Com::R8(f64::from(*n))),
        Value::Long(n) => Some(Com::R8(*n as f64)),
        Value::Double(n) => Some(Com::R8(*n)),
        Value::Single(n) => Some(Com::R8(f64::from(*n))),
        Value::Decimal(n) => Some(Com::R8(n.to_f64())),
        other => Some(Com::Str(convert::to_ps_string(other))),
    }
}

/// `Excel-TextMayBecomeValue`: a text Excel's typed entry may read as a value of its own (a date from "1-2", a number from
/// "007" or "1e3", a truth value, an error), where the portable writer keeps the text. The forms both backends type alike are
/// left to Excel: a formula, an ISO date, a plain or thousands-grouped number, a percentage.
fn text_may_become_value(entered: &str) -> Result<bool> {
    let trimmed = entered.trim();
    if trimmed.starts_with('=') {
        return Ok(false);
    }
    if is_match(trimmed, r"^\d{4}-\d{2}-\d{2}$")? {
        return Ok(false);
    }
    if is_match(trimmed, r"^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d+)?|\.\d+|[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?)%?$")? {
        return Ok(false);
    }
    Ok(is_match(trimmed, r"\d")?
        || is_match(trimmed, r"^(?:true|false)$")?
        || is_match(trimmed, r"^#(?:N/A|DIV/0!|VALUE!|REF!|NAME\?|NUM!|NULL!)$")?)
}

/// A 1 x 1 `object[,]` holding `value`: the binder then always sees the same type.
fn single_cell_array(value: Com) -> Com {
    Com::Array(SafeArray::zero_based(vec![vec![value]]).expect("one row of one cell is rectangular"))
}

/// `Restore-ExcelText`: the text back in a cell Excel typed as a value, marked as typed text (the apostrophe Excel keeps out of
/// the value) under the number format the cell had before, which the typed date or number had replaced.
fn restore_text(cell: &Com, entered: &str, format: &Com) -> Result<()> {
    if let Com::Str(_) = format {
        cell.set_member("NumberFormat", format.clone())?;
    }
    cell.set_member("Value2", single_cell_array(com_text(format!("'{entered}"))))
}

/// `$stored -is [string] -and $stored -ceq $text`.
fn holds_text(stored: &Com, entered: &str) -> bool {
    match stored {
        Com::Str(text) => convert::equals_case_sensitive(&Value::String(text.clone()), &Value::String(entered.to_owned())),
        _ => false,
    }
}

/// `Set-ExcelCellValue`: one cell through a 1 x 1 array; a text Excel typed as a value is put back as text.
pub(super) fn set_cell_value(cell: &Com, value: &Value) -> Result<()> {
    let Some(converted) = cell_value(value) else {
        cell.call_member("ClearContents", &[])?;
        return Ok(());
    };
    let guarded = match &converted {
        Com::Str(text) => text_may_become_value(text)?,
        _ => false,
    };
    let format = if guarded { Some(cell.member("NumberFormat")?) } else { None };
    cell.set_member("Value2", single_cell_array(converted.clone()))?;
    if let (true, Com::Str(entered), Some(format)) = (guarded, &converted, &format) {
        let stored = cell.member("Value2")?;
        if !holds_text(&stored, entered) {
            restore_text(cell, entered, format)?;
        }
    }
    Ok(())
}

/// `replace_text`.
pub(super) fn replace_text(book: &Com, op: &Value) -> Result<Value> {
    let mut changed = false;
    for sheet in super::cells::items_of(&book.member("Worksheets")?)? {
        let cells = sheet.member("Cells")?;
        let replaced = cells.call_member(
            "Replace",
            &[
                com_text(text_of(op, "find")),
                com_text(text_of(op, "replace")),
                Com::I4(2),
                Com::I4(1),
                Com::Bool(false),
                Com::Bool(false),
                Com::Bool(false),
                Com::Bool(false),
            ],
        )?;
        changed = bool_of(&replaced) || changed;
    }
    Ok(record_of("replace_text", changed, Vec::new()))
}

/// `set_cell`.
pub(super) fn set_cell(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let target = range_of(&sheet, &text_of(op, "cell"))?;
    set_cell_value(&target, &prop(op, "value"))?;
    Ok(record_of("set_cell", true, Vec::new()))
}

/// `set_formula`.
pub(super) fn set_formula(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let mut formula = text_of(op, "formula");
    if !formula.starts_with('=') {
        formula = format!("={formula}");
    }
    range_of(&sheet, &text_of(op, "cell"))?.set_member("Formula", com_text(formula))?;
    Ok(record_of("set_formula", true, Vec::new()))
}

/// A text of a block that Excel may type as a value, with the format its cell had before the block went in.
struct Guarded {
    row: i32,
    column: i32,
    text: String,
    format: Option<Com>,
}

/// `set_range`: a block that fills its range goes in as one array, each value typed as `Set-ExcelCellValue` types it; rows
/// of uneven length write only the cells they name.
pub(super) fn set_range(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let target = range_of(&sheet, &text_of(op, "range"))?;
    let rows = array_items(&prop(op, "values"));
    let row_count = rows.len();
    let column_count = if row_count > 0 { array_items(&rows[0]).len() } else { 0 };
    let mut even = row_count > 0
        && i64::try_from(row_count).unwrap_or(i64::MAX) == i64::from(int_of_com(&target.member("Rows")?.member("Count")?)?)
        && i64::try_from(column_count).unwrap_or(i64::MAX) == i64::from(int_of_com(&target.member("Columns")?.member("Count")?)?);
    let mut row = 1;
    while even && row < row_count {
        even = array_items(&rows[row]).len() == column_count;
        row += 1;
    }
    if even {
        return set_whole_block(&target, &rows, row_count, column_count);
    }
    for (r, line) in rows.iter().enumerate() {
        for (c, value) in array_items(line).iter().enumerate() {
            let cell = cell_at(&target, to_index(r + 1), to_index(c + 1))?;
            set_cell_value(&cell, value)?;
        }
    }
    Ok(record_of("set_range", true, Vec::new()))
}

fn to_index(position: usize) -> i32 {
    i32::try_from(position).unwrap_or(i32::MAX)
}

fn set_whole_block(target: &Com, rows: &[Value], row_count: usize, column_count: usize) -> Result<Value> {
    let mut matrix: Vec<Vec<Com>> = Vec::with_capacity(row_count);
    let mut guarded: Vec<Guarded> = Vec::new();
    for (r, row) in rows.iter().enumerate() {
        let line = array_items(row);
        let mut entries = Vec::with_capacity(column_count);
        for c in 0..column_count {
            let entered = line.get(c).and_then(cell_value);
            if let Some(Com::Str(text)) = &entered {
                if text_may_become_value(text)? {
                    guarded.push(Guarded { row: to_index(r + 1), column: to_index(c + 1), text: text.clone(), format: None });
                }
            }
            entries.push(entered.unwrap_or(Com::Empty));
        }
        matrix.push(entries);
    }
    // A text Excel may type as a value keeps the format its cell had, read before the block goes in: the block's one format
    // when its cells share it, each such cell's otherwise.
    let mut block_format = Com::Empty;
    if !guarded.is_empty() {
        block_format = target.member("NumberFormat")?;
        if !matches!(block_format, Com::Str(_)) {
            for entry in &mut guarded {
                entry.format = Some(cell_at(target, entry.row, entry.column)?.member("NumberFormat")?);
            }
        }
    }
    target.set_member("Value2", Com::Array(SafeArray::zero_based(matrix).expect("the rows of a block are of one length")))?;
    if !guarded.is_empty() {
        let stored = target.member("Value2")?;
        for entry in &guarded {
            let value = match &stored {
                Com::Array(array) => array.get(&[entry.row, entry.column]).cloned().unwrap_or(Com::Empty),
                other => other.clone(),
            };
            if holds_text(&value, &entry.text) {
                continue;
            }
            let format = if matches!(block_format, Com::Str(_)) { block_format.clone() } else { entry.format.clone().unwrap_or(Com::Empty) };
            let cell = cell_at(target, entry.row, entry.column)?;
            restore_text(&cell, &entry.text, &format)?;
        }
    }
    let cells = row_count * column_count;
    if cells > 500 {
        return Ok(record_of(
            "set_range",
            true,
            vec![("bulk", Value::Bool(true)), ("cells", Value::Int(i32::try_from(cells).unwrap_or(i32::MAX)))],
        ));
    }
    Ok(record_of("set_range", true, Vec::new()))
}

/// `append_row`: the new row takes the last row's formatting (number formats, fonts, fills, borders, height) as an inserted row
/// takes the row above's and the portable writer copies it; the copy has a destination, so the clipboard is left alone.
pub(super) fn append_row(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let used = sheet.member("UsedRange")?;
    let mut row = int_of_com(&used.member("Row")?)? + int_of_com(&used.member("Rows")?.member("Count")?)?;
    // An empty sheet reports A1 as its used range; the first row appended is row 1, as the portable writer puts it.
    if int_of_com(&used.member("Count")?)? == 1 && is_ps_null(&used.member("Value2")?) {
        row = int_of_com(&used.member("Row")?)?;
    }
    if row > 1 {
        let source = get_with(&sheet.member("Rows")?, "Item", &[Com::I4(row - 1)])?;
        let destination = get_with(&sheet.member("Rows")?, "Item", &[Com::I4(row)])?;
        source.call_member("Copy", &[destination])?;
        get_with(&sheet.member("Rows")?, "Item", &[Com::I4(row)])?.call_member("ClearContents", &[])?;
    }
    let values = array_items(&prop(op, "values"));
    for (c, value) in values.iter().enumerate() {
        let cell = get_with(&sheet.member("Cells")?, "Item", &[Com::I4(row), Com::I4(to_index(c + 1))])?;
        set_cell_value(&cell, value)?;
    }
    Ok(record_of("append_row", true, vec![("row", Value::Int(row))]))
}

/// `clear_cell`.
pub(super) fn clear_cell(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    range_of(&sheet, &text_of(op, "cell"))?.call_member("Clear", &[])?;
    Ok(record_of("clear_cell", true, Vec::new()))
}
