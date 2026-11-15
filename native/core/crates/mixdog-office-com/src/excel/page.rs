//! `Snapshot-ExcelPage`: a read of one range of a sheet, by cells (with their formulas, and their styles when asked) or by
//! blocks of rows.
//!
//! The host's arithmetic decides the type each argument of a COM call goes out with, and a recorded call sequence shows
//! it: `[Math]::Floor` of a whole number is a Decimal, so the row of a cell is passed as a Decimal when the cursor sits on
//! a row boundary and as a Double otherwise, and the column of a partial row is passed as a Long.

use crate::com::Decimal;
use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;

use super::cells::column_letters;
use super::cells::dimension_count;
use super::cells::get_with;
use super::cells::int_of;
use super::cells::is_ps_null;
use super::cells::items_of;
use super::cells::matrix_item;
use super::cells::ordered;
use super::cells::payload_flag;
use super::cells::payload_text;
use super::cells::ps_of;
use super::cells::relative_address;
use super::cells::string_of;
use super::styles::cell_style;
use super::styles::default_style;
use super::validation::formula_lineage;

/// The cells of a page that are returned as cell entries rather than as row blocks, and the most a page holds.
const DETAILED_CELLS: i64 = 500;
const MAX_PAGE_CELLS: i32 = 10_000;

/// A whole number the host holds as a Decimal (`exact`) or a Double.
fn whole_arg(exact: bool, number: i64) -> Com {
    if exact { Com::Decimal(Decimal::from_i64(number)) } else { Com::R8(number as f64) }
}

/// `Snapshot-ExcelPage`.
pub(super) fn snapshot_excel_page(book: &Obj, payload: &Value) -> Result<Value> {
    let book = Com::Dispatch(book.clone());
    let mut sheet = book.member("ActiveSheet")?;
    if payload_flag(payload, "sheet") {
        sheet = get_with(&book.member("Worksheets")?, "Item", &[Com::Str(payload_text(payload, "sheet"))])?;
    }
    let mut base = sheet.member("UsedRange")?;
    if payload_flag(payload, "range") {
        base = get_with(&sheet, "Range", &[Com::Str(payload_text(payload, "range"))])?;
    }
    let row_count = dimension_count(&base, "Rows")?;
    let column_count = dimension_count(&base, "Columns")?;
    let columns = i64::from(column_count);
    let total = i64::from(row_count) * columns;
    let requested = convert::to_int64(&payload::property(payload, "offset")).map_err(Error::host)?;
    let offset_value = convert::max(&Value::Int(0), &Value::Long(requested)).map_err(Error::host)?;
    let mut offset = convert::to_int64(&offset_value).map_err(Error::host)?;
    let wanted = convert::to_int(&payload::property(payload, "limit")).map_err(Error::host)?;
    let limit = wanted.max(1).min(MAX_PAGE_CELLS);
    if offset > total {
        offset = total;
    }
    let mut remaining = i64::from(limit).min(total - offset);
    let mut cursor = offset;
    let detailed = payload_flag(payload, "includeStyles") || total <= DETAILED_CELLS;
    let mut cells: Vec<Value> = Vec::new();
    let mut row_blocks: Vec<Value> = Vec::new();
    let mut formula_entries: Vec<Value> = Vec::new();
    let mut populated: i64 = 0;
    while remaining > 0 {
        if columns == 0 {
            return Err(Error::host("Attempted to divide by zero."));
        }
        let row_offset = cursor / columns;
        let column_offset = (cursor % columns) as i32;
        let row_exact = column_offset == 0;
        let item = |row: Com, column: Com| get_with(&base.member("Cells")?, "Item", &[row, column]);
        let (take, range) = if column_offset == 0 && remaining >= columns {
            let take_rows = remaining / columns;
            let take_exact = remaining % columns == 0;
            let first = item(whole_arg(row_exact, row_offset + 1), Com::I4(1))?;
            let sum_exact = row_exact && take_exact;
            let last = item(whole_arg(sum_exact, row_offset + take_rows), Com::I4(column_count))?;
            (take_rows * columns, get_with(&sheet, "Range", &[first, last])?)
        } else {
            let take = remaining.min(columns - i64::from(column_offset));
            let first = item(whole_arg(row_exact, row_offset + 1), Com::I4(column_offset + 1))?;
            let last = item(whole_arg(row_exact, row_offset + 1), Com::I8(i64::from(column_offset) + take))?;
            (take, get_with(&sheet, "Range", &[first, last])?)
        };
        let values = range.member("Value2")?;
        let formulas = range.member("Formula")?;
        let range_rows = dimension_count(&range, "Rows")?;
        let range_columns = dimension_count(&range, "Columns")?;
        let range_start_row = int_of(&range.member("Row")?)?;
        let range_start_column = int_of(&range.member("Column")?)?;
        let mut block_values: Vec<Value> = Vec::new();
        let mut block_formulas: Vec<Value> = Vec::new();
        for r in 1..=range_rows {
            let mut line: Vec<Value> = Vec::new();
            for c in 1..=range_columns {
                let value = matrix_item(&values, r, c);
                let formula_value = string_of(&matrix_item(&formulas, r, c));
                let formula = if formula_value.starts_with('=') { Some(formula_value) } else { None };
                if !detailed {
                    line.push(ps_of(&value));
                }
                if is_ps_null(&value) && formula.is_none() {
                    continue;
                }
                populated += 1;
                let mut address = String::new();
                let mut absolute_row = 0;
                let mut absolute_column = 0;
                if detailed || formula.is_some() {
                    absolute_row = range_start_row + r - 1;
                    absolute_column = range_start_column + c - 1;
                    address = format!("{}{absolute_row}", column_letters(absolute_column));
                }
                let formula_text = formula.map_or(Value::Null, Value::String);
                if let Value::String(text) = &formula_text {
                    let path = format!("/sheet[{}]/cell[{address}]", string_of(&sheet.member("Name")?));
                    formula_entries.push(ordered(vec![
                        ("path", Value::String(path)),
                        ("ref", Value::String(address.clone())),
                        ("row", Value::Int(absolute_row)),
                        ("column", Value::Int(absolute_column)),
                        ("formula", Value::String(text.clone())),
                    ]));
                    if !detailed {
                        block_formulas.push(ordered(vec![
                            ("rowOffset", Value::Int(r - 1)),
                            ("columnOffset", Value::Int(c - 1)),
                            ("formula", Value::String(text.clone())),
                        ]));
                    }
                }
                if detailed {
                    let path = format!("/sheet[{}]/cell[{address}]", string_of(&sheet.member("Name")?));
                    let mut pairs = vec![
                        ("path", Value::String(path)),
                        ("ref", Value::String(address)),
                        ("value", ps_of(&value)),
                        ("formula", formula_text),
                    ];
                    if payload_flag(payload, "includeStyles") {
                        let cell = get_with(&range.member("Cells")?, "Item", &[Com::I4(r), Com::I4(c)])?;
                        pairs.push(("style", cell_style(&cell)?));
                    }
                    cells.push(ordered(pairs));
                }
            }
            if !detailed {
                block_values.push(Value::Array(line));
            }
        }
        if !detailed {
            row_blocks.push(ordered(vec![
                ("startRow", Value::Int(range_start_row)),
                ("startColumn", Value::Int(range_start_column)),
                ("rowCount", Value::Int(range_rows)),
                ("columnCount", Value::Int(range_columns)),
                ("values", Value::Array(block_values)),
                ("formulas", Value::Array(block_formulas)),
            ]));
        }
        cursor += take;
        remaining -= take;
    }
    let lineage = formula_lineage(&formula_entries, &string_of(&sheet.member("Name")?));
    let (cell_output, row_block_output) = if detailed { (cells, Vec::new()) } else { (Vec::new(), row_blocks) };
    let path = string_of(&book.member("FullName")?);
    let active_sheet = string_of(&book.member("ActiveSheet")?.member("Name")?);
    let sheet_count = dimension_count(&book, "Worksheets")?;
    let mut sheet_names = Vec::new();
    for worksheet in items_of(&book.member("Worksheets")?)? {
        sheet_names.push(Value::String(string_of(&worksheet.member("Name")?)));
    }
    let style = default_style(&book);
    let sheet_path = format!("/sheet[{}]", string_of(&sheet.member("Name")?));
    let sheet_name = string_of(&sheet.member("Name")?);
    let address = string_of(&relative_address(&base)?);
    let sheet_record = ordered(vec![
        ("path", Value::String(sheet_path)),
        ("name", Value::String(sheet_name)),
        ("rows", Value::Int(row_count)),
        ("columns", Value::Int(column_count)),
        ("address", Value::String(address)),
        ("cellCount", Value::Long(total)),
        ("representation", Value::string(if detailed { "cells" } else { "row-blocks" })),
        ("cells", Value::Array(cell_output)),
        ("rowBlocks", Value::Array(row_block_output)),
        ("lineageCount", Value::Int(lineage.len() as i32)),
        ("formulaLineage", Value::Array(lineage)),
        ("truncated", Value::Bool(cursor < total)),
    ]);
    let scope = format!("{}!{}", string_of(&sheet.member("Name")?), string_of(&relative_address(&base)?));
    let pagination = ordered(vec![
        ("unit", Value::string("cell")),
        ("scope", Value::String(scope)),
        ("offset", Value::Long(offset)),
        ("limit", Value::Int(limit)),
        ("returned", Value::Long(populated)),
        ("scanned", Value::Long(cursor - offset)),
        ("total", Value::Long(total)),
        ("nextOffset", if cursor < total { Value::Long(cursor) } else { Value::Null }),
    ]);
    Ok(ordered(vec![
        ("format", Value::string("xlsx")),
        ("path", Value::String(path)),
        ("activeSheet", Value::String(active_sheet)),
        ("sheetCount", Value::Int(sheet_count)),
        // A page reads one sheet; the names say which others the workbook holds, as the portable page does.
        ("sheetNames", Value::Array(sheet_names)),
        ("defaultStyle", style),
        ("sheets", Value::Array(vec![sheet_record])),
        ("pagination", pagination),
    ]))
}
