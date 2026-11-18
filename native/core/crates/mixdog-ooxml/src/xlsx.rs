//! `portable/portable-xlsx.mjs`: the xlsx batch dispatcher. Every operation the portable backend applies to a workbook goes
//! through [`apply_xlsx`], which keeps the sheet list current across the operations that change it, answers one result row per
//! operation and marks the workbook for a full recalculation when an operation could change what a formula would answer.

use mixdog_fsio::ReadProof;
use mixdog_js::js_to_lowercase;
use serde_json::{Map, Value};

use crate::cells::{Sheet, force_workbook_recalculation, workbook_sheets};
use crate::sheet_page::apply_worksheet_page_setup;
use crate::text_metrics::TextMeasurer;
use crate::xlsx_audit_support::{js_text, truthy};
use crate::xlsx_charts::add_worksheet_chart;
use crate::xlsx_drawings::{add_worksheet_image, delete_worksheet_drawing, set_worksheet_drawing};
use crate::xlsx_operations::{
    WORKBOOK_PATH, add_worksheet, add_worksheet_validation, apply_conditional_format, delete_worksheet, rename_worksheet,
    set_worksheet_header_footer,
};
use crate::xlsx_pivot_ops::add_worksheet_pivot_table;
use crate::xlsx_range_layout::{autofit_worksheet_range, sort_worksheet_range};
use crate::xlsx_sheet_edits::{
    add_worksheet_note, add_worksheet_table, append_worksheet_row, clear_worksheet_cell, copy_worksheet, define_workbook_name,
    delete_worksheet_note, freeze_worksheet_panes, merge_worksheet_cells, protect_worksheet, replace_workbook_text,
    set_row_height_or_column_width, set_row_or_column_visibility, set_worksheet_autofilter, set_worksheet_cell, set_worksheet_formulas,
    set_worksheet_hyperlink, set_worksheet_range, set_worksheet_style, set_worksheet_view, set_worksheet_visibility, shift_worksheet_rows_or_columns,
};
use crate::zipio::Package;

/// Every operation that can change what a formula would answer. Marking the workbook only when a formula was written left an
/// edited input with every dependent cell's old cached value in place: the file reopened with the numbers from before the
/// edit, and an error a guard had swallowed stayed swallowed. The mark is what tells a later read the values are stale.
const VALUE_OPERATIONS: [&str; 17] = [
    "set_cell",
    "set_formula",
    "set_range",
    "append_row",
    "clear_cell",
    "replace_text",
    "insert_rows",
    "delete_rows",
    "insert_columns",
    "delete_columns",
    "sort_range",
    "add_sheet",
    "delete_sheet",
    "rename_sheet",
    "copy_sheet",
    "define_name",
    "delete_name",
];

fn select_worksheet<'a>(sheets: &'a [Sheet], op: &Map<String, Value>) -> Result<&'a Sheet, String> {
    let selected = if truthy(op.get("sheet")) {
        let wanted = js_to_lowercase(&js_text(op.get("sheet")));
        sheets.iter().find(|entry| js_to_lowercase(&entry.name) == wanted)
    } else {
        sheets.first()
    };
    selected.ok_or_else(|| {
        format!("Worksheet not found: {}", if truthy(op.get("sheet")) { js_text(op.get("sheet")) } else { "(first sheet)".to_owned() })
    })
}

/// The operation's own row followed by what a sheet-management operation adds to it (`{ op, changed: true, ...extra }`).
fn management_row(op: &Map<String, Value>, extra: Value) -> Value {
    let mut row = Map::new();
    row.insert("op".to_owned(), op.get("op").cloned().unwrap_or(Value::Null));
    row.insert("changed".to_owned(), Value::Bool(true));
    if let Value::Object(fields) = extra {
        row.extend(fields);
    }
    Value::Object(row)
}

/// `applyXlsx(zip, operations)`: applies the operations in order to the workbook and answers one result per operation. The
/// first that fails ends the batch with its message; the package is then in whatever state the earlier operations left it, and
/// the caller discards it.
pub fn apply_xlsx<P: ReadProof>(proof: &P, measurer: &TextMeasurer<'_, P>, zip: &mut Package, operations: &[Value]) -> Result<Vec<Value>, String> {
    let mut sheets = workbook_sheets(zip);
    let mut results = Vec::with_capacity(operations.len());
    let mut recalculation_required = false;
    let mut next = 0;
    while next < operations.len() {
        let operation = &operations[next];
        next += 1;
        let empty = Map::new();
        let op = operation.as_object().unwrap_or(&empty);
        let name = op.get("op").and_then(Value::as_str).unwrap_or("");
        if VALUE_OPERATIONS.contains(&name) {
            recalculation_required = true;
        }
        if name == "add_sheet" {
            let created = add_worksheet(zip, op.get("name"))?;
            sheets = workbook_sheets(zip);
            results.push(management_row(op, serde_json::json!({ "sheet": created })));
            continue;
        }
        let sheet = select_worksheet(&sheets, op)?.clone();
        if name == "rename_sheet" || name == "delete_sheet" {
            let changed = if name == "rename_sheet" {
                rename_worksheet(zip, &sheet, op.get("name"), &sheets)?
            } else {
                delete_worksheet(zip, &sheets, &sheet)?
            };
            sheets = workbook_sheets(zip);
            results.push(management_row(op, changed));
            continue;
        }
        let xml = zip.text(&sheet.path);
        if name == "set_formula" {
            // The formulas that follow on the same sheet go in with this one, in one pass over the sheet.
            let same_sheet = |other: &Map<String, Value>| {
                other.get("op").and_then(Value::as_str) == Some("set_formula")
                    && select_worksheet(&sheets, other).is_ok_and(|selected| selected.path == sheet.path)
            };
            let run: Vec<&Map<String, Value>> = std::iter::once(op)
                .chain(operations[next..].iter().map_while(|following| following.as_object().filter(|fields| same_sheet(fields))))
                .collect();
            if let Some(written) = set_worksheet_formulas(zip, &sheet, &xml, &run, &sheets)? {
                next += run.len() - 1;
                recalculation_required = true;
                results.extend(written);
                continue;
            }
        }
        if name == "set_cell" || name == "set_formula" {
            let (result, recalculate) = set_worksheet_cell(zip, &sheet, &xml, op, &sheets)?;
            if recalculate {
                recalculation_required = true;
            }
            results.push(result);
            continue;
        }
        if name == "copy_sheet" {
            results.push(copy_worksheet(zip, &sheet, &xml, op, &sheets)?);
            sheets = workbook_sheets(zip);
            continue;
        }
        let whole = || Value::Object(op.clone());
        let result = match name {
            "set_range" => set_worksheet_range(zip, &sheet, &xml, op)?,
            "sort_range" => sort_worksheet_range(zip, &sheet, &xml, op)?,
            "append_row" => append_worksheet_row(zip, &sheet, &xml, op)?,
            "clear_cell" => clear_worksheet_cell(zip, &sheet, &xml, op)?,
            "replace_text" => replace_workbook_text(zip, &sheets, op)?,
            "set_style" => set_worksheet_style(zip, &sheet, &xml, op)?,
            "merge_cells" | "unmerge_cells" => merge_worksheet_cells(zip, &sheet, &xml, op)?,
            "freeze_panes" => freeze_worksheet_panes(zip, &sheet, &xml, op)?,
            "set_sheet_view" => set_worksheet_view(zip, &sheet, &xml, op)?,
            "autofit_range" => autofit_worksheet_range(measurer, zip, &sheet, &xml, op)?,
            "insert_rows" | "delete_rows" | "insert_columns" | "delete_columns" => {
                shift_worksheet_rows_or_columns(zip, &sheet, &xml, op, &sheets)?
            }
            "set_autofilter" => set_worksheet_autofilter(zip, &sheet, &xml, op)?,
            "set_sheet_visibility" => set_worksheet_visibility(zip, &sheet, op)?,
            // What a printed sheet says on every page (the confidentiality mark, the document number). Word and PowerPoint
            // could carry one and a workbook could not, so a printed pack lost its marking at the spreadsheet.
            "set_header_footer" => set_worksheet_header_footer(zip, &sheet, &xml, op)?,
            "set_row_visibility" | "set_column_visibility" => set_row_or_column_visibility(zip, &sheet, &xml, op)?,
            "set_row_height" | "set_column_width" => set_row_height_or_column_width(measurer, zip, &sheet, &xml, op)?,
            "define_name" | "delete_name" => define_workbook_name(zip, op)?,
            "add_note" | "add_provenance" => add_worksheet_note(zip, &sheet, &xml, op)?,
            "delete_note" => delete_worksheet_note(zip, &sheet, op)?,
            "add_image" => add_worksheet_image(proof, zip, &sheet, &xml, &whole())?,
            "set_hyperlink" => set_worksheet_hyperlink(zip, &sheet, &xml, op)?,
            "protect_sheet" | "unprotect_sheet" => protect_worksheet(zip, &sheet, &xml, op),
            "add_conditional_format" | "delete_conditional_formats" => apply_conditional_format(zip, &sheet, &xml, op)?,
            "add_validation" => add_worksheet_validation(zip, &sheet, &xml, op)?,
            "add_table" => add_worksheet_table(zip, &sheet, &xml, op)?,
            "add_pivot_table" => add_worksheet_pivot_table(measurer, zip, &sheet, &xml, op)?,
            "add_chart" => add_worksheet_chart(measurer, zip, &sheet, &xml, &whole(), &sheets)?,
            // A chart or picture the audit reports as overlapping or off the print area had no answer but a rebuilt workbook.
            "set_drawing" => set_worksheet_drawing(measurer, zip, &sheet, &xml, &whole())?,
            "delete_drawing" => delete_worksheet_drawing(zip, &sheet, &whole())?,
            "set_page_setup" => apply_worksheet_page_setup(measurer, zip, &sheets, &sheet, &xml, op)?,
            _ => return Err(format!("Portable XLSX backend does not support operation: {}", js_text(op.get("op")))),
        };
        results.push(result);
    }
    if recalculation_required {
        let workbook = force_workbook_recalculation(&zip.text(WORKBOOK_PATH));
        zip.set(WORKBOOK_PATH, workbook);
    }
    Ok(results)
}
