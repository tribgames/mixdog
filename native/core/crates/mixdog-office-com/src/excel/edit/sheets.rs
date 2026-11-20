//! Worksheets: finding one (`Excel-Sheet`), the names they may have (`Assert-WorksheetName`), `add_sheet`, `copy_sheet`,
//! `delete_sheet`, `rename_sheet`, `set_sheet_visibility`, `protect_sheet`, `unprotect_sheet`, `define_name`, `delete_name`.

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::excel::cells::get_with;
use crate::excel::cells::items_of;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::text;

use super::com_text;
use super::equals_bool;
use super::flag;
use super::is_match;
use super::present;
use super::prop;
use super::record_of;
use super::string_of_com;
use super::text_of;

/// `Excel-Sheet`: the worksheet the operation names, or the active one.
pub(super) fn excel_sheet(book: &Com, op: &Value) -> Result<Com> {
    if flag(op, "sheet") {
        let found = book.member("Worksheets").and_then(|sheets| get_with(&sheets, "Item", &[com_text(text_of(op, "sheet"))]));
        return match found {
            Ok(sheet) => Ok(sheet),
            Err(_) => {
                let mut names = Vec::new();
                for sheet in items_of(&book.member("Worksheets")?)? {
                    names.push(string_of_com(&sheet.member("Name")?));
                }
                Err(Error::host(format!(
                    "Worksheet not found: {}. Available sheets: {}. Add it with add_sheet or target an existing sheet.",
                    text_of(op, "sheet"),
                    names.join(", ")
                )))
            }
        };
    }
    book.member("ActiveSheet")
}

/// `Excel-Sheet` for a sheet named by a text (a chart source's sheet).
pub(super) fn sheet_named(book: &Com, name: &str) -> Result<Com> {
    excel_sheet(book, &Value::object(crate::ps::ObjectKind::Custom, vec![("sheet", Value::string(name))]))
}

/// `Assert-WorksheetName`: Excel refuses these itself, with a COM error nobody can act on.
fn assert_worksheet_name(operation: &str, name: &str) -> Result<String> {
    let label = name.trim().to_owned();
    if label.is_empty() {
        return Err(Error::host(format!("{operation} requires name")));
    }
    if label.encode_utf16().count() > 31 {
        return Err(Error::host("Worksheet names are limited to 31 characters"));
    }
    if let Some(forbidden) = label.chars().find(|c| matches!(c, ':' | '\\' | '/' | '?' | '*' | '[' | ']')) {
        return Err(Error::host(format!("Worksheet names cannot contain : \\ / ? * [ ] \u{2014} \"{label}\" has {forbidden}")));
    }
    if label.starts_with('\'') || label.ends_with('\'') {
        return Err(Error::host(format!("Worksheet names cannot start or end with an apostrophe: {label}")));
    }
    if is_match(&label, "^history$")? {
        return Err(Error::host("History is reserved by Excel and cannot name a worksheet"));
    }
    Ok(label)
}

/// `$book.Worksheets.Item($book.Worksheets.Count)`: the last worksheet.
fn last_sheet(book: &Com) -> Result<Com> {
    let sheets = book.member("Worksheets")?;
    let count = book.member("Worksheets")?.member("Count")?;
    get_with(&sheets, "Item", &[count])
}

/// `add_sheet`: Excel's `Add()` inserts before the active sheet; the portable writer appends, so a Report, Data, Calc, Checks
/// workbook keeps that order on both backends.
pub(super) fn add_sheet(book: &Com, op: &Value) -> Result<Value> {
    let name = assert_worksheet_name("add_sheet", &text_of(op, "name"))?;
    let sheets = book.member("Worksheets")?;
    let after = last_sheet(book)?;
    let sheet = sheets.call_member("Add", &[Com::Missing, after])?;
    sheet.set_member("Name", com_text(name))?;
    Ok(record_of("add_sheet", true, vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?)))]))
}

/// `copy_sheet`: `Missing`, not `$null`, is the `Before` argument.
pub(super) fn copy_sheet(book: &Com, op: &Value) -> Result<Value> {
    if flag(op, "name") {
        assert_worksheet_name("copy_sheet", &text_of(op, "name"))?;
    }
    let source = excel_sheet(book, op)?;
    let after = last_sheet(book)?;
    source.call_member("Copy", &[Com::Missing, after])?;
    let copy = last_sheet(book)?;
    if flag(op, "name") {
        copy.set_member("Name", com_text(text_of(op, "name")))?;
    }
    Ok(record_of("copy_sheet", true, vec![("sheet", Value::String(string_of_com(&copy.member("Name")?)))]))
}

/// `delete_sheet`.
pub(super) fn delete_sheet(book: &Com, op: &Value) -> Result<Value> {
    excel_sheet(book, op)?.call_member("Delete", &[])?;
    Ok(record_of("delete_sheet", true, Vec::new()))
}

/// `rename_sheet`.
pub(super) fn rename_sheet(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let name = assert_worksheet_name("rename_sheet", &text_of(op, "name"))?;
    sheet.set_member("Name", com_text(name))?;
    Ok(record_of("rename_sheet", true, vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?)))]))
}

/// `set_sheet_visibility`: rows and columns take `visible: true/false`; a sheet accepts the same word.
pub(super) fn set_sheet_visibility(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let visibility = if present(op, "visibility") {
        text::to_lower_invariant(&text_of(op, "visibility"))
    } else if present(op, "visible") {
        if convert::to_bool(&prop(op, "visible")) { "visible".to_owned() } else { "hidden".to_owned() }
    } else {
        String::new()
    };
    let state = match visibility.as_str() {
        "hidden" => 0,
        "very_hidden" | "veryhidden" => 2,
        "visible" => -1,
        _ => {
            return Err(Error::host("set_sheet_visibility needs visibility: visible, hidden, or very_hidden (or visible: true/false)"));
        }
    };
    sheet.set_member("Visible", Com::I4(state))?;
    Ok(record_of(
        "set_sheet_visibility",
        true,
        vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?))), ("visibility", Value::String(visibility))],
    ))
}

/// `protect_sheet`: what the sheet still allows is kept as the portable writer keeps it (formatCells, sort, autoFilter).
/// `Protect(Password, DrawingObjects, Contents, Scenarios, UserInterfaceOnly, AllowFormattingCells, AllowFormattingColumns,
/// AllowFormattingRows, AllowInsertingColumns, AllowInsertingRows, AllowInsertingHyperlinks, AllowDeletingColumns,
/// AllowDeletingRows, AllowSorting, AllowFiltering)`.
pub(super) fn protect_sheet(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let allowed = |name: &str| Com::Bool(equals_bool(&prop(op, name), true));
    let arguments = [
        com_text(text_of(op, "password")),
        Com::Bool(true),
        Com::Bool(true),
        Com::Bool(true),
        Com::Bool(false),
        allowed("allowFormattingCells"),
        Com::Bool(false),
        Com::Bool(false),
        Com::Bool(false),
        Com::Bool(false),
        Com::Bool(false),
        Com::Bool(false),
        Com::Bool(false),
        allowed("allowSorting"),
        allowed("allowFiltering"),
    ];
    sheet.call_member("Protect", &arguments)?;
    Ok(record_of("protect_sheet", true, vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?)))]))
}

/// `unprotect_sheet`.
pub(super) fn unprotect_sheet(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    sheet.call_member("Unprotect", &[com_text(text_of(op, "password"))])?;
    Ok(record_of("unprotect_sheet", true, vec![("sheet", Value::String(string_of_com(&sheet.member("Name")?)))]))
}

/// `define_name`: Excel answers a name it refuses with a COM error nobody can act on, and the portable writer would put it in a
/// workbook Excel then declines to open: the rule is the same on both backends.
pub(super) fn define_name(book: &Com, op: &Value) -> Result<Value> {
    let name = text_of(op, "name").trim().to_owned();
    if is_match(&name, r"\s")? {
        let suggestion = text::replace(&name, r"\s+", "_", false).map_err(Error::host)?;
        return Err(Error::host(format!("Excel refuses the defined name \"{name}\": it contains a space; use an underscore ({suggestion}).")));
    }
    if !is_match(&name, r"^[\p{L}_\\]")? {
        return Err(Error::host(format!("Excel refuses the defined name \"{name}\": it must start with a letter, underscore, or backslash.")));
    }
    if is_match(&name, r"[^\p{L}\p{N}_.\\]")? {
        return Err(Error::host(format!("Excel refuses the defined name \"{name}\": use letters, digits, underscores, or periods.")));
    }
    if is_match(&name, r"^(?i)([RC]|\$?[A-Z]{1,3}\$?\d{1,7})$")? {
        return Err(Error::host(format!("Excel refuses the defined name \"{name}\": Excel reads it as a cell reference, not a name.")));
    }
    let mut refers_to = text_of(op, "refersTo");
    if !refers_to.starts_with('=') {
        refers_to = format!("={refers_to}");
    }
    let defined = book.member("Names")?.call_member("Add", &[com_text(text_of(op, "name")), com_text(refers_to)])?;
    Ok(record_of(
        "define_name",
        true,
        vec![("name", Value::String(string_of_com(&defined.member("Name")?))), ("refersTo", Value::String(string_of_com(&defined.member("RefersTo")?)))],
    ))
}

/// `delete_name`.
pub(super) fn delete_name(book: &Com, op: &Value) -> Result<Value> {
    let names = book.member("Names")?;
    get_with(&names, "Item", &[com_text(text_of(op, "name"))])?.call_member("Delete", &[])?;
    Ok(record_of("delete_name", true, vec![("name", Value::String(text_of(op, "name")))]))
}
