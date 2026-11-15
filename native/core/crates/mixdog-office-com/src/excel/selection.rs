//! `Snapshot-Selection` for a workbook: the range the user has selected in the workbook's window.

use crate::com::Obj;
use crate::com::Result;
use crate::com::Value as Com;
use crate::format::same_office_path;
use crate::ps::Value;

use super::cells::dimension_count;
use super::cells::ordered;
use super::cells::relative_address;
use super::cells::string_of;

fn unavailable(reason: &str) -> Value {
    ordered(vec![("available", Value::Bool(false)), ("reason", Value::string(reason))])
}

/// The `xlsx` branch of `Snapshot-Selection`.
pub(super) fn snapshot_selection(document: &Obj) -> Result<Value> {
    let document = Com::Dispatch(document.clone());
    let selection = document.member("Application")?.member("Selection")?;
    let sheet = selection.member("Parent")?;
    // A sheet that is not there is a null dispatch, which the dispatch layer answers as `Null`.
    if sheet.is_null() || !same_office_path(&string_of(&sheet.member("Parent")?.member("FullName")?), &string_of(&document.member("FullName")?)) {
        return Ok(unavailable("The active Excel selection belongs to another workbook."));
    }
    let address = string_of(&relative_address(&selection)?);
    let active_cell = string_of(&relative_address(&document.member("Application")?.member("ActiveCell")?)?);
    let target = format!("/sheet[{}]/range[{address}]", string_of(&sheet.member("Name")?));
    let key = format!("{}!{address}@{active_cell}", string_of(&sheet.member("Name")?));
    let sheet_name = string_of(&sheet.member("Name")?);
    let rows = dimension_count(&selection, "Rows")?;
    let columns = dimension_count(&selection, "Columns")?;
    Ok(ordered(vec![
        ("available", Value::Bool(true)),
        ("kind", Value::string("range")),
        ("target", Value::String(target)),
        ("key", Value::String(key)),
        ("sheet", Value::String(sheet_name)),
        ("address", Value::String(address)),
        ("activeCell", Value::String(active_cell)),
        ("rows", Value::Int(rows)),
        ("columns", Value::Int(columns)),
    ]))
}
