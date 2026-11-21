//! The Excel editor: `Apply-ExcelOperation` of `office-com-host.ps1`, registered as the `xlsx` [`FormatEditor`].
//!
//! Every COM call is made in the order the script makes it, with the VARIANT type the recordings show (`Single` for a
//! width or a height, `Double` for a zoom, `VT_BOOL` False for "no page limit"), so a replay of a recorded call log matches.
//! A refusal is the host's own text; an operation answers the same record in the same key order as the script.

pub(crate) mod charts;
mod data;
mod drawings;
mod print;
mod sheets;
mod structure;
mod styles;
mod values;
mod view;

use std::sync::OnceLock;

use regex::Regex;

use crate::com::Error;
use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::format::EditContext;
use crate::format::FormatEditor;
use crate::office::Env;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;
use crate::ps::text;

use super::cells;

/// The editor of workbooks.
pub struct Editor;

/// The operations of `Apply-ExcelOperation`, in the order of the registry fixture.
const OPERATIONS: &[&str] = &[
    "add_chart",
    "add_conditional_format",
    "add_image",
    "add_note",
    "add_pivot_table",
    "add_provenance",
    "add_sheet",
    "add_table",
    "add_validation",
    "append_row",
    "autofit_range",
    "clear_cell",
    "copy_sheet",
    "define_name",
    "delete_columns",
    "delete_conditional_formats",
    "delete_drawing",
    "delete_name",
    "delete_note",
    "delete_rows",
    "delete_sheet",
    "freeze_panes",
    "insert_columns",
    "insert_rows",
    "merge_cells",
    "protect_sheet",
    "rename_sheet",
    "replace_text",
    "set_autofilter",
    "set_cell",
    "set_column_visibility",
    "set_column_width",
    "set_drawing",
    "set_formula",
    "set_header_footer",
    "set_hyperlink",
    "set_page_setup",
    "set_range",
    "set_row_height",
    "set_row_visibility",
    "set_sheet_view",
    "set_sheet_visibility",
    "set_style",
    "sort_range",
    "unmerge_cells",
    "unprotect_sheet",
];

impl FormatEditor for Editor {
    fn apply_operation(&self, context: &mut EditContext<'_>, document: &Obj, op: &Value, _live: bool, _allow_ui_activation: bool) -> Result<Option<Value>> {
        apply_excel_operation(&context.env, &Com::Dispatch(document.clone()), op).map(Some)
    }

    fn operation_names(&self) -> &'static [&'static str] {
        OPERATIONS
    }
}

/// `Apply-ExcelOperation`: the record of the operation, or the refusal.
fn apply_excel_operation(env: &Env<'_>, book: &Com, op: &Value) -> Result<Value> {
    let name = text::to_lower_invariant(&convert::to_ps_string(&prop(op, "op")));
    match name.as_str() {
        "replace_text" => values::replace_text(book, op),
        "set_cell" => values::set_cell(book, op),
        "set_formula" => values::set_formula(book, op),
        "set_range" => values::set_range(book, op),
        "append_row" => values::append_row(book, op),
        "add_sheet" => sheets::add_sheet(book, op),
        "copy_sheet" => sheets::copy_sheet(book, op),
        "clear_cell" => values::clear_cell(book, op),
        "add_note" => structure::add_note(book, op),
        "add_provenance" => structure::add_provenance(book, op),
        "delete_note" => structure::delete_note(book, op),
        "delete_sheet" => sheets::delete_sheet(book, op),
        "set_style" => styles::set_style(book, op),
        "add_image" => drawings::add_image(book, op),
        "rename_sheet" => sheets::rename_sheet(book, op),
        "set_drawing" => drawings::set_drawing(book, op),
        "delete_drawing" => drawings::delete_drawing(book, op),
        "add_table" => data::add_table(book, op),
        "add_chart" => charts::add_chart(env, book, op),
        "sort_range" => data::sort_range(book, op),
        "add_conditional_format" => data::add_conditional_format(book, op),
        "delete_conditional_formats" => data::delete_conditional_formats(book, op),
        "add_validation" => data::add_validation(book, op),
        "freeze_panes" => view::freeze_panes(env, book, op),
        "add_pivot_table" => data::add_pivot_table(book, op),
        "insert_rows" => structure::insert_rows(book, op),
        "delete_rows" => structure::delete_rows(book, op),
        "insert_columns" => structure::insert_columns(book, op),
        "delete_columns" => structure::delete_columns(book, op),
        "merge_cells" => styles::merge_cells(book, op),
        "unmerge_cells" => styles::unmerge_cells(book, op),
        "set_autofilter" => data::set_autofilter(book, op),
        "set_hyperlink" => structure::set_hyperlink(book, op),
        "define_name" => sheets::define_name(book, op),
        "delete_name" => sheets::delete_name(book, op),
        "protect_sheet" => sheets::protect_sheet(book, op),
        "unprotect_sheet" => sheets::unprotect_sheet(book, op),
        "autofit_range" => print::autofit_range(book, op),
        "set_page_setup" => print::set_page_setup(book, op),
        "set_sheet_view" => view::set_sheet_view(env, book, op),
        "set_header_footer" => print::set_header_footer(book, op),
        "set_sheet_visibility" => sheets::set_sheet_visibility(book, op),
        "set_row_visibility" => structure::set_row_visibility(book, op),
        "set_column_visibility" => structure::set_column_visibility(book, op),
        "set_row_height" => structure::set_row_height(book, op),
        "set_column_width" => structure::set_column_width(book, op),
        _ => Err(Error::host(format!("Unsupported XLSX operation: {}", convert::to_ps_string(&prop(op, "op"))))),
    }
}

// ---- the script's expressions over `$op`, and its casts -------------------------------------------------------------

/// `$op.name`.
fn prop(op: &Value, name: &str) -> Value {
    payload::property(op, name)
}

/// `$op.name` as a condition.
fn flag(op: &Value, name: &str) -> bool {
    convert::to_bool(&prop(op, name))
}

/// `$null -ne $op.name`.
fn present(op: &Value, name: &str) -> bool {
    !prop(op, name).is_null()
}

/// `[string]$op.name`.
fn text_of(op: &Value, name: &str) -> String {
    convert::to_ps_string(&prop(op, name))
}

/// `[int]$value`.
fn int_cast(value: &Value) -> Result<i32> {
    convert::to_int(value).map_err(Error::host)
}

/// `[double]$value`.
fn double_cast(value: &Value) -> Result<f64> {
    convert::to_double(value).map_err(Error::host)
}

/// `[single]$value`.
fn single_cast(value: &Value) -> Result<f32> {
    convert::to_single(value).map_err(Error::host)
}

/// `$value -eq $true` (`want` true) or `$value -eq $false`: PowerShell converts the right side to the type of the left.
fn equals_bool(value: &Value, want: bool) -> bool {
    match value {
        Value::Bool(flag) => *flag == want,
        Value::Int(n) => *n == i32::from(want),
        Value::Long(n) => *n == i64::from(want),
        Value::Double(n) => *n == if want { 1.0 } else { 0.0 },
        Value::Single(n) => *n == if want { 1.0 } else { 0.0 },
        Value::String(text) => text.eq_ignore_ascii_case(if want { "True" } else { "False" }),
        _ => false,
    }
}

/// `@($value)`: the elements of an array, or the one value (`$null` too) as the only element.
fn array_items(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.clone(),
        other => vec![other.clone()],
    }
}

/// `[string]::IsNullOrWhiteSpace`.
fn is_blank(text: &str) -> bool {
    text.trim().is_empty()
}

/// A text a COM call takes.
fn com_text(text: impl Into<String>) -> Com {
    Com::Str(text.into())
}

/// `try { ... } catch { }`.
fn quiet<T>(body: impl FnOnce() -> Result<T>) {
    let _ = body();
}

/// `$sheet.Range($address)`.
fn range_of(sheet: &Com, address: &str) -> Result<Com> {
    cells::get_with(sheet, "Range", &[com_text(address)])
}

/// `$range.Cells.Item($row, $column)`.
fn cell_at(range: &Com, row: i32, column: i32) -> Result<Com> {
    cells::get_with(&range.member("Cells")?, "Item", &[Com::I4(row), Com::I4(column)])
}

/// `[string]$com`.
fn string_of_com(value: &Com) -> String {
    cells::string_of(value)
}

/// `[int]$com`.
fn int_of_com(value: &Com) -> Result<i32> {
    cells::int_of(value)
}

/// `$text -match $pattern`.
fn is_match(subject: &str, pattern: &str) -> Result<bool> {
    text::is_match(subject, pattern, false).map_err(Error::host)
}

/// A pattern compiled once.
fn cached(slot: &'static OnceLock<Regex>, pattern: &'static str) -> &'static Regex {
    slot.get_or_init(|| Regex::new(pattern).expect("the pattern of the editor is valid"))
}

/// The record an operation answers: `[ordered]@{ op = ...; changed = ...; ... }`.
fn record_of(name: &str, changed: bool, more: Vec<(&str, Value)>) -> Value {
    let mut pairs = vec![("op", Value::string(name)), ("changed", Value::Bool(changed))];
    pairs.extend(more);
    cells::ordered(pairs)
}

/// `$first..$last` as the array of its numbers.
fn number_span(first: i32, last: i32) -> Value {
    Value::Array((first..=last).map(Value::Int).collect())
}

/// `if ($op.count) { [Math]::Max(1, [int]$op.count) } else { 1 }`.
fn span_count(op: &Value) -> Result<i32> {
    if flag(op, "count") { Ok(int_cast(&prop(op, "count"))?.max(1)) } else { Ok(1) }
}

/// `if ($op.count) { [int]$op.count } else { 1 }`.
fn repeat_count(op: &Value) -> Result<i32> {
    if flag(op, "count") { int_cast(&prop(op, "count")) } else { Ok(1) }
}

/// The last row or column of a span that starts at `first` and holds `count` of them (`$first + $count - 1`).
fn span_end(first: i32, count: i32) -> i32 {
    first.saturating_add(count).saturating_sub(1)
}
