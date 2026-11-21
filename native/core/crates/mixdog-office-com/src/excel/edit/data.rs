//! Data on a sheet: `add_table`, `sort_range`, `add_conditional_format`, `delete_conditional_formats`, `add_validation`,
//! `add_pivot_table` (`Excel-PivotField`), `set_autofilter`.

use std::sync::OnceLock;

use regex::Regex;

use crate::com::Error;
use crate::com::Result;
use crate::com::Value as Com;
use crate::excel::cells::bool_of;
use crate::excel::cells::count_of;
use crate::excel::cells::get_with;
use crate::excel::cells::items_of;
use crate::excel::cells::ps_of;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;
use crate::ps::pipeline_items;
use crate::ps::text;

use super::array_items;
use super::cached;
use super::com_text;
use super::equals_bool;
use super::flag;
use super::int_of_com;
use super::is_blank;
use super::is_match;
use super::present;
use super::prop;
use super::quiet;
use super::range_of;
use super::record_of;
use super::sheets::excel_sheet;
use super::string_of_com;
use super::text_of;

/// `Color-Value` as an Int32 argument.
fn color_of(hex: &str) -> Result<Com> {
    convert::color_value(hex).map(Com::I4).map_err(Error::host)
}

/// `add_table`: a table over the range, named and styled; `none` is the portable writer's word for a table with no built-in style
/// (compose_sheet paints the range itself), which clears the style.
pub(super) fn add_table(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let source = range_of(&sheet, &text_of(op, "range"))?;
    let table = sheet.member("ListObjects")?.call_member("Add", &[Com::I4(1), source, Com::Null, Com::I4(1)])?;
    if flag(op, "name") {
        table.set_member("Name", com_text(text_of(op, "name")))?;
    }
    if flag(op, "style") {
        let mut style = text_of(op, "style");
        if text::to_lower_invariant(&style) == "none" {
            style = String::new();
        }
        table.set_member("TableStyle", com_text(style))?;
    }
    Ok(record_of("add_table", true, vec![("name", Value::String(string_of_com(&table.member("Name")?)))]))
}

/// `sort_range`, with the key contract of the portable writer: a column letter, a header, or the range's first column.
pub(super) fn sort_range(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let target = range_of(&sheet, &text_of(op, "range"))?;
    let mut has_header = true;
    if present(op, "hasHeader") {
        has_header = flag(op, "hasHeader");
    }
    let (key_column, declared) = sort_key_column(&sheet, &target, op)?;
    if key_column < 1 || key_column > columns_of(&target)? {
        return Err(Error::host(format!("XLSX sort_range by \"{declared}\" is outside {}; name a column the range covers.", text_of(op, "range"))));
    }
    refuse_unsortable(&target, op, has_header)?;
    let descending = text::to_lower_invariant(&text_of(op, "order")).starts_with("desc");
    let sort_order = if descending { 2 } else { 1 };
    let header_flag = if has_header { 1 } else { 2 };
    let key_range = get_with(&target, "Columns", &[Com::I4(key_column)])?;
    target.call_member("Sort", &[key_range, Com::I4(sort_order), Com::Null, Com::Null, Com::I4(1), Com::Null, Com::I4(1), Com::I4(header_flag)])?;
    Ok(record_of("sort_range", true, vec![("range", Value::String(text_of(op, "range"))), ("order", Value::string(if descending { "desc" } else { "asc" }))]))
}

/// The 1-based key column within `target` and the key as the request declared it (`by`, else `column`): a column letter, a
/// header, or the first column when none is given or no header matches.
fn sort_key_column(sheet: &Com, target: &Com, op: &Value) -> Result<(i32, String)> {
    let mut key_column = 1;
    let mut declared = text_of(op, "by").trim().to_owned();
    if declared.is_empty() {
        declared = text_of(op, "column").trim().to_owned();
    }
    if !declared.is_empty() {
        if is_match(&declared, "^[A-Za-z]{1,3}$")? {
            let named = get_with(sheet, "Columns", &[com_text(declared.to_ascii_uppercase())])?;
            key_column = int_of_com(&named.member("Column")?)? - int_of_com(&target.member("Column")?)? + 1;
        } else {
            let mut index = 1;
            while index <= columns_of(target)? {
                let header = string_of_com(&get_with(target, "Cells", &[Com::I4(1), Com::I4(index)])?.member("Text")?);
                if convert::equals(&Value::String(header.trim().to_owned()), &Value::String(declared.clone())) {
                    key_column = index;
                    break;
                }
                index += 1;
            }
        }
    }
    Ok((key_column, declared))
}

/// The two refusals of the portable writer, so a sheet sorts the same way on either backend: a filtered row would keep its flag
/// while the values move under it, and a merged cell cannot travel with one row.
fn refuse_unsortable(target: &Com, op: &Value, has_header: bool) -> Result<()> {
    let first_data_row = if has_header { 2 } else { 1 };
    let mut withheld: Vec<i32> = Vec::new();
    let mut index = first_data_row;
    while index <= int_of_com(&target.member("Rows")?.member("Count")?)? {
        if bool_of(&get_with(&target, "Rows", &[Com::I4(index)])?.member("Hidden")?) {
            withheld.push(int_of_com(&get_with(&target, "Rows", &[Com::I4(index)])?.member("Row")?)?);
        }
        index += 1;
    }
    if !withheld.is_empty() {
        let named: Vec<String> = withheld.iter().take(5).map(i32::to_string).collect();
        return Err(Error::host(format!(
            "XLSX sort_range would move values under hidden row {}, leaving a different record withheld. Show them first with set_row_visibility visible: true, or sort a range without them.",
            named.join(", ")
        )));
    }
    if !equals_bool(&ps_of(&target.member("MergeCells")?), false) {
        return Err(Error::host(format!(
            "XLSX sort_range cannot move rows through a merged cell in {}; Excel refuses the same sort. Unmerge them first with unmerge_cells.",
            text_of(op, "range")
        )));
    }
    Ok(())
}

/// `[int]$range.Columns.Count`.
fn columns_of(range: &Com) -> Result<i32> {
    int_of_com(&range.member("Columns")?.member("Count")?)
}

/// `add_conditional_format`: the three kinds of the portable writer: a rule that picks cells, a scale that colours every cell by
/// its value, or a bar.
pub(super) fn add_conditional_format(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let target = range_of(&sheet, &text_of(op, "range"))?;
    let kind = text::to_lower_invariant(&text_of(op, "type"));
    if kind == "colorscale" {
        let points = if flag(op, "midColor") { 3 } else { 2 };
        let scale = target.member("FormatConditions")?.call_member("AddColorScale", &[Com::I4(points)])?;
        let colour = |criterion: i32, name: &str| -> Result<()> {
            let color = color_of(&text_of(op, name))?;
            get_with(&scale, "ColorScaleCriteria", &[Com::I4(criterion)])?.member("FormatColor")?.set_member("Color", color)
        };
        if flag(op, "minColor") {
            colour(1, "minColor")?;
        }
        if flag(op, "midColor") {
            colour(2, "midColor")?;
        }
        if flag(op, "maxColor") {
            colour(points, "maxColor")?;
        }
    } else if kind == "databar" {
        let bar = target.member("FormatConditions")?.call_member("AddDatabar", &[])?;
        let bar_color = if flag(op, "color") {
            text_of(op, "color")
        } else if flag(op, "fillColor") {
            text_of(op, "fillColor")
        } else {
            String::new()
        };
        if !bar_color.is_empty() {
            let color = color_of(&bar_color)?;
            bar.member("BarColor")?.set_member("Color", color)?;
        }
    } else {
        // The portable contract writes the rule the way the file stores it: no leading '=', references relative to the range's
        // top-left cell. Excel's FormatConditions.Add reads a formula without '=' as a text constant.
        let mut formula = text_of(op, "formula").trim().to_owned();
        if !formula.starts_with('=') {
            formula = format!("={formula}");
        }
        let rule = target.member("FormatConditions")?.call_member("Add", &[Com::I4(2), Com::Missing, com_text(formula)])?;
        if flag(op, "color") {
            let color = color_of(&text_of(op, "color"))?;
            rule.member("Font")?.set_member("Color", color)?;
        }
        if flag(op, "fillColor") {
            let color = color_of(&text_of(op, "fillColor"))?;
            rule.member("Interior")?.set_member("Color", color)?;
        }
    }
    // The kind is reported as the contract names it, so both backends answer with the same word.
    let reported = if flag(op, "type") { text_of(op, "type") } else { "expression".to_owned() };
    Ok(record_of("add_conditional_format", true, vec![("type", Value::String(reported))]))
}

/// `delete_conditional_formats`.
pub(super) fn delete_conditional_formats(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let target = range_of(&sheet, &text_of(op, "range"))?;
    let count = int_of_com(&target.member("FormatConditions")?.member("Count")?)?;
    target.member("FormatConditions")?.call_member("Delete", &[])?;
    Ok(record_of("delete_conditional_formats", count > 0, vec![("count", Value::Int(count))]))
}

fn quoted_list() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    cached(&PATTERN, r#"^"([^"]*)"$"#)
}

/// `add_validation`: a list unless the caller names another kind, and a second bound for the ranged kinds.
pub(super) fn add_validation(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    let target = range_of(&sheet, &text_of(op, "range"))?;
    target.member("Validation")?.call_member("Delete", &[])?;
    let validation_type = match text::to_lower_invariant(&text_of(op, "type")).as_str() {
        "whole" => 1,
        "decimal" => 2,
        "date" => 4,
        "time" => 5,
        "textlength" => 6,
        "custom" => 7,
        _ => 3,
    };
    let validation_operator = match text::to_lower_invariant(&text_of(op, "operator")).as_str() {
        "notbetween" => 2,
        "equal" => 3,
        "notequal" => 4,
        "greaterthan" => 5,
        "lessthan" => 6,
        "greaterthanorequal" => 7,
        "lessthanorequal" => 8,
        _ => 1,
    };
    // The contract names a list as the file holds it ("a,b,c" or $A$1:$A$9); Excel takes a literal list bare and a list of cells
    // as a formula. A custom rule is a formula too.
    let mut formula1 = text_of(op, "formula1").trim().to_owned();
    if validation_type == 3 {
        let choices = formula1.strip_prefix('=').unwrap_or(&formula1).to_owned();
        if let Some(captures) = quoted_list().captures(&choices) {
            formula1 = captures[1].to_owned();
        } else if !formula1.starts_with('=') && is_match(&choices, r"^(?:'[^']+'!|[A-Za-z_][\w.]*!)?\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$")? {
            formula1 = format!("={choices}");
        }
    } else if validation_type == 7 && !formula1.starts_with('=') {
        formula1 = format!("={formula1}");
    }
    let mut arguments = vec![Com::I4(validation_type), Com::I4(1), Com::I4(validation_operator), com_text(formula1)];
    if present(op, "formula2") && !text_of(op, "formula2").is_empty() {
        arguments.push(com_text(text_of(op, "formula2")));
    }
    target.member("Validation")?.call_member("Add", &arguments)?;
    if flag(op, "inputMessage") {
        target.member("Validation")?.set_member("InputMessage", com_text(text_of(op, "inputMessage")))?;
    }
    if flag(op, "errorMessage") {
        target.member("Validation")?.set_member("ErrorMessage", com_text(text_of(op, "errorMessage")))?;
    }
    Ok(record_of("add_validation", true, Vec::new()))
}

/// `Excel-PivotField`: the pivot's field of that name (any case).
fn pivot_field(pivot: &Com, name: &str) -> Result<Com> {
    let collection = pivot.call_member("PivotFields", &[])?;
    let mut available = Vec::new();
    let mut index = 1;
    while i64::from(index) <= count_of(&collection)? {
        let candidate = get_with(&collection, "Item", &[Com::I4(index)])?;
        let candidate_name = string_of_com(&candidate.member("Name")?);
        available.push(candidate_name.clone());
        if payload::names_equal(&candidate_name, name) {
            return Ok(candidate);
        }
        index += 1;
    }
    Err(Error::host(format!("Pivot field '{name}' not found; available fields: {}", available.join(", "))))
}

/// The fields of `$op.<key>` that name something: `@($op.key | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })`.
fn named_fields(op: &Value, key: &str) -> Vec<Value> {
    let value = prop(op, key);
    pipeline_items(&value).into_iter().filter(|field| !is_blank(&convert::to_ps_string(field))).collect()
}

/// `add_pivot_table`: captions in the language of the fields, as the portable writer sets them: a Korean Excel heads a sum with
/// its own word for it and its totals with its own, where a fixed English caption read "Sum of".
pub(super) fn add_pivot_table(book: &Com, op: &Value) -> Result<Value> {
    let source_sheet = excel_sheet(book, op)?;
    let destination_sheet = if flag(op, "destinationSheet") {
        get_with(&book.member("Worksheets")?, "Item", &[com_text(text_of(op, "destinationSheet"))])?
    } else {
        source_sheet.clone()
    };
    let caches = book.call_member("PivotCaches", &[])?;
    let source = range_of(&source_sheet, &text_of(op, "source"))?;
    let cache = caches.call_member("Create", &[Com::I4(1), source])?;
    let destination = range_of(&destination_sheet, &text_of(op, "destination"))?;
    let name = if flag(op, "name") {
        text_of(op, "name")
    } else {
        let count = int_of_com(&destination_sheet.call_member("PivotTables", &[])?.member("Count")?)?;
        format!("MixdogPivot{}", count + 1)
    };
    let pivot = cache.call_member("CreatePivotTable", &[destination, com_text(name)])?;
    for (key, orientation) in [("rows", 1), ("columns", 2)] {
        for field in array_items(&prop(op, key)) {
            let field_name = convert::to_ps_string(&field);
            if !is_blank(&field_name) {
                pivot_field(&pivot, &field_name)?.set_member("Orientation", Com::I4(orientation))?;
            }
        }
    }
    let mut field_names = Vec::new();
    for field in items_of(&pivot.call_member("PivotFields", &[])?)? {
        field_names.push(string_of_com(&field.member("Name")?));
    }
    let korean = is_match(&field_names.join(" "), "[\u{AC00}-\u{D7AF}]")?;
    let sum_caption = if korean { "\u{D569}\u{ACC4} : " } else { "Sum of " };
    for field in array_items(&prop(op, "values")) {
        let field_name = convert::to_ps_string(&field);
        if is_blank(&field_name) {
            continue;
        }
        let data_field = pivot_field(&pivot, &field_name)?;
        pivot.call_member("AddDataField", &[data_field, com_text(format!("{sum_caption}{field_name}")), Com::I4(-4157)])?;
    }
    if korean {
        quiet(|| pivot.set_member("GrandTotalName", com_text("\u{CD1D}\u{D569}\u{ACC4}")));
    }
    // The row header names its field, as the portable writer heads it, not Excel's "Row Labels".
    if let Some(first) = named_fields(op, "rows").first() {
        quiet(|| pivot.set_member("CompactLayoutRowHeader", com_text(convert::to_ps_string(first))));
    }
    // And the column header, as the portable writer heads it.
    if let Some(first) = named_fields(op, "columns").first() {
        quiet(|| pivot.set_member("CompactLayoutColumnHeader", com_text(convert::to_ps_string(first))));
    }
    Ok(record_of("add_pivot_table", true, vec![("name", Value::String(string_of_com(&pivot.member("Name")?)))]))
}

/// `set_autofilter`.
pub(super) fn set_autofilter(book: &Com, op: &Value) -> Result<Value> {
    let sheet = excel_sheet(book, op)?;
    if present(op, "enabled") && !flag(op, "enabled") {
        sheet.set_member("AutoFilterMode", Com::Bool(false))?;
    } else {
        range_of(&sheet, &text_of(op, "range"))?.call_member("AutoFilter", &[])?;
    }
    let enabled = if present(op, "enabled") { flag(op, "enabled") } else { true };
    Ok(record_of("set_autofilter", true, vec![("enabled", Value::Bool(enabled))]))
}
