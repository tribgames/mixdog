//! Rows and columns (`insert_rows`, `delete_rows`, `insert_columns`, `delete_columns`, visibility, heights, widths), notes
//! (`add_note`, `add_provenance`, `delete_note`) and `set_hyperlink`.

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::excel::cells::get_with;
use crate::excel::cells::is_null_or_dbnull;
use crate::excel::cells::relative_address;
use crate::ps::Value;
use crate::ps::text;

use super::com_text;
use super::double_cast;
use super::flag;
use super::int_cast;
use super::int_of_com;
use super::is_blank;
use super::is_match;
use super::number_span;
use super::present;
use super::prop;
use super::range_of;
use super::record_of;
use super::repeat_count;
use super::sheets::excel_sheet;
use super::span_count;
use super::span_end;
use super::string_of_com;
use super::text_of;

/// `$range.Address($false, $false)` as text.
fn address_of(range: &Com) -> Result<String> {
    Ok(string_of_com(&relative_address(range)?))
}

/// `$null -ne $cell.Comment`.
fn has_comment(cell: &Com) -> Result<bool> {
    Ok(!is_null_or_dbnull(&cell.member("Comment")?))
}

/// `add_note`: a note already on the cell is replaced.
pub(super) fn add_note(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let cell = range_of(&sheet, &text_of(op, "cell"))?;
    if has_comment(&cell)? {
        cell.member("Comment")?.call_member("Delete", &[])?;
    }
    let comment = cell.call_member("AddComment", &[com_text(text_of(op, "text"))])?;
    Ok(record_of("add_note", true, vec![("cell", Value::String(address_of(&cell)?)), ("author", Value::String(string_of_com(&comment.member("Author")?)))]))
}

/// `Provenance-Text`: the citation of the operation.
fn provenance_text(op: &Value) -> Result<String> {
    let citation = text_of(op, "citation");
    if is_blank(&citation) {
        return Err(Error::host("add_provenance requires source with a document or label"));
    }
    Ok(citation)
}

/// `add_provenance`: the citation goes into the cell's note, after what the note already says.
pub(super) fn add_provenance(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let cell = range_of(&sheet, &text_of(op, "cell"))?;
    let citation = provenance_text(op)?;
    if has_comment(&cell)? {
        let existing = string_of_com(&cell.member("Comment")?.call_member("Text", &[])?);
        if text::is_not_match(&existing, &text::regex_escape(&citation), false).map_err(Error::host)? {
            cell.member("Comment")?.call_member("Text", &[com_text(format!("{existing}\n{citation}"))])?;
        }
    } else {
        cell.call_member("AddComment", &[com_text(citation.clone())])?;
    }
    let target = format!("/sheet[{}]/cell[{}]", string_of_com(&sheet.member("Name")?), address_of(&cell)?);
    Ok(record_of("add_provenance", true, vec![("target", Value::String(target)), ("citation", Value::String(citation))]))
}

/// `delete_note`.
pub(super) fn delete_note(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let cell = range_of(&sheet, &text_of(op, "cell"))?;
    let changed = has_comment(&cell)?;
    if changed {
        cell.member("Comment")?.call_member("Delete", &[])?;
    }
    Ok(record_of("delete_note", changed, vec![("cell", Value::String(address_of(&cell)?))]))
}

/// `$sheet.<collection>.Item([int]$op.<key>).<action>(<argument>)` repeated `count` times.
fn repeat_on_line(book: &Com, op: &Value, collection: &str, key: &str, action: &str, argument: Option<i32>, name: &str) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let count = repeat_count(op)?;
    for _ in 0..count.max(0) {
        let line = get_with(&sheet.member(collection)?, "Item", &[Com::I4(int_cast(&prop(op, key))?)])?;
        match argument {
            Some(argument) => line.call_member(action, &[Com::I4(argument)])?,
            None => line.call_member(action, &[])?,
        };
    }
    Ok(record_of(name, true, vec![(key, Value::Int(int_cast(&prop(op, key))?)), ("count", Value::Int(count)), ("referenceAware", Value::Bool(true))]))
}

/// `insert_rows`.
pub(super) fn insert_rows(book: &Com, op: &Value) -> Result<Value> {
    repeat_on_line(book, op, "Rows", "row", "Insert", Some(-4121), "insert_rows")
}

/// `delete_rows`.
pub(super) fn delete_rows(book: &Com, op: &Value) -> Result<Value> {
    repeat_on_line(book, op, "Rows", "row", "Delete", None, "delete_rows")
}

/// `insert_columns`.
pub(super) fn insert_columns(book: &Com, op: &Value) -> Result<Value> {
    repeat_on_line(book, op, "Columns", "column", "Insert", Some(-4161), "insert_columns")
}

/// `delete_columns`.
pub(super) fn delete_columns(book: &Com, op: &Value) -> Result<Value> {
    repeat_on_line(book, op, "Columns", "column", "Delete", None, "delete_columns")
}

/// A column named by a letter or a 1-based number: the same column either way.
fn column_number(sheet: &Com, column: &str) -> Result<i32> {
    if is_match(column, "^[A-Za-z]+$")? {
        let named = get_with(sheet, "Columns", &[com_text(column.to_ascii_uppercase())])?;
        return int_of_com(&named.member("Column")?);
    }
    int_cast(&Value::String(column.to_owned()))
}

/// `$sheet.Rows("first:last")`.
fn rows_span(sheet: &Com, first: i32, last: i32) -> Result<Com> {
    get_with(sheet, "Rows", &[com_text(format!("{first}:{last}"))])
}

/// `$sheet.Range($sheet.Cells.Item(1, $first), $sheet.Cells.Item(1, $last)).EntireColumn`.
fn columns_span(sheet: &Com, first: i32, last: i32) -> Result<Com> {
    let start = get_with(&sheet.member("Cells")?, "Item", &[Com::I4(1), Com::I4(first)])?;
    let end = get_with(&sheet.member("Cells")?, "Item", &[Com::I4(1), Com::I4(last)])?;
    get_with(sheet, "Range", &[start, end])?.member("EntireColumn")
}

/// `set_row_visibility`.
pub(super) fn set_row_visibility(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    if !present(op, "visible") {
        return Err(Error::host("set_row_visibility requires visible: true or false"));
    }
    let first = int_cast(&prop(op, "row"))?;
    if first < 1 {
        return Err(Error::host("set_row_visibility requires row (1-based)"));
    }
    let count = span_count(op)?;
    let last = span_end(first, count);
    let visible = flag(op, "visible");
    rows_span(&sheet, first, last)?.set_member("Hidden", Com::Bool(!visible))?;
    Ok(record_of(
        "set_row_visibility",
        true,
        vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?))), ("visible", Value::Bool(visible)), ("rows", number_span(first, last))],
    ))
}

/// `set_column_visibility`.
pub(super) fn set_column_visibility(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    if !present(op, "visible") {
        return Err(Error::host("set_column_visibility requires visible: true or false"));
    }
    let first = column_number(&sheet, &text_of(op, "column"))?;
    if first < 1 {
        return Err(Error::host("set_column_visibility requires column (a letter such as D, or a 1-based number)"));
    }
    let count = span_count(op)?;
    let last = span_end(first, count);
    let visible = flag(op, "visible");
    columns_span(&sheet, first, last)?.set_member("Hidden", Com::Bool(!visible))?;
    Ok(record_of(
        "set_column_visibility",
        true,
        vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?))), ("visible", Value::Bool(visible)), ("columns", number_span(first, last))],
    ))
}

/// `set_row_height`: a Single, as the column widths are set.
pub(super) fn set_row_height(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let first = int_cast(&prop(op, "row"))?;
    if first < 1 {
        return Err(Error::host("set_row_height requires row (1-based)"));
    }
    let height = double_cast(&prop(op, "height"))?;
    if !present(op, "height") || height < 0.0 || height > 409.0 {
        return Err(Error::host("set_row_height requires height in points, 0-409"));
    }
    let count = span_count(op)?;
    let last = span_end(first, count);
    rows_span(&sheet, first, last)?.set_member("RowHeight", Com::R4(height as f32))?;
    Ok(record_of(
        "set_row_height",
        true,
        vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?))), ("rows", number_span(first, last)), ("height", Value::Double(height))],
    ))
}

/// `set_column_width`: a Single, as `autofit_range` sets it.
pub(super) fn set_column_width(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let first = column_number(&sheet, &text_of(op, "column"))?;
    if first < 1 {
        return Err(Error::host("set_column_width requires column (a letter such as D, or a 1-based number)"));
    }
    let width = double_cast(&prop(op, "width"))?;
    if !present(op, "width") || width < 0.0 || width > 255.0 {
        return Err(Error::host("set_column_width requires width in characters, 0-255"));
    }
    let count = span_count(op)?;
    let last = span_end(first, count);
    columns_span(&sheet, first, last)?.set_member("ColumnWidth", Com::R4(width as f32))?;
    Ok(record_of(
        "set_column_width",
        true,
        vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?))), ("columns", number_span(first, last)), ("width", Value::Double(width))],
    ))
}

/// `set_hyperlink`: a link already on the cell is replaced.
pub(super) fn set_hyperlink(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let target = range_of(&sheet, &text_of(op, "cell"))?;
    super::quiet(|| target.member("Hyperlinks")?.call_member("Delete", &[]));
    let display = if present(op, "text") { text_of(op, "text") } else { string_of_com(&target.member("Text")?) };
    let link = sheet.member("Hyperlinks")?.call_member(
        "Add",
        &[target.clone(), com_text(text_of(op, "address")), com_text(text_of(op, "subAddress")), com_text(text_of(op, "screenTip")), com_text(display)],
    )?;
    Ok(record_of(
        "set_hyperlink",
        true,
        vec![("cell", Value::String(text_of(op, "cell"))), ("address", Value::String(string_of_com(&link.member("Address")?)))],
    ))
}
