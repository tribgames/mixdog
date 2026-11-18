use serde_json::json;

use crate::support::{Doc, cell, count};

fn ledger() -> Doc {
    let doc = Doc::named("xlsx", "Plan");
    doc.apply(json!([
        { "op": "set_range", "sheet": "Plan", "range": "A1:B3", "values": [["Item", "Qty"], ["Tea", 3], ["Mug", 4]] },
        { "op": "set_formula", "sheet": "Plan", "cell": "B4", "formula": "=SUM(B2:B3)" }
    ]));
    doc
}

fn value(doc: &Doc, sheet: &str, reference: &str) -> serde_json::Value {
    cell(&doc.snapshot(), sheet, reference).map_or(serde_json::Value::Null, |entry| entry["value"].clone())
}

#[test]
fn a_blank_workbook_names_its_sheet_and_validates() {
    let doc = Doc::named("xlsx", "Plan");
    let names: Vec<String> = doc.snapshot()["sheets"].as_array().expect("sheets").iter().map(|s| s["name"].as_str().unwrap_or("").to_owned()).collect();
    assert_eq!(names, ["Plan"]);
    assert!(doc.part("xl/workbook.xml").contains("name=\"Plan\""));
    doc.assert_valid();
}

#[test]
fn cells_keep_their_types_and_a_formula_is_stored_with_its_text() {
    let doc = ledger();
    let snapshot = doc.snapshot();
    assert_eq!(cell(&snapshot, "Plan", "A2").expect("A2")["value"], json!("Tea"));
    assert_eq!(cell(&snapshot, "Plan", "B2").expect("B2")["value"], json!(3));
    assert_eq!(cell(&snapshot, "Plan", "B4").expect("B4")["formula"], json!("SUM(B2:B3)"));
    doc.apply(json!([{ "op": "set_cell", "sheet": "Plan", "cell": "B2", "value": 7 }, { "op": "set_cell", "sheet": "Plan", "cell": "C1", "value": true }]));
    assert_eq!(value(&doc, "Plan", "B2"), json!(7));
    assert_eq!(value(&doc, "Plan", "C1"), json!(true));
    doc.apply(json!([{ "op": "clear_cell", "sheet": "Plan", "cell": "B2" }]));
    assert!(matches!(value(&doc, "Plan", "B2"), serde_json::Value::Null | serde_json::Value::String(_)) && value(&doc, "Plan", "B2") != json!(7));
    doc.assert_valid();
}

#[test]
fn recalculating_fills_the_cached_value_of_a_formula() {
    let doc = ledger();
    assert_eq!(cell(&doc.snapshot(), "Plan", "B4").expect("B4")["cacheState"], json!("missing"));
    mixdog_ooxml::portable::recalculate_with_formula_engine(&mixdog_fsio::Unlaned, &mixdog_office_base::write_note::NoWriteNote, &doc.path).expect("a recalculation");
    let entry = cell(&doc.snapshot(), "Plan", "B4").expect("B4");
    assert_eq!(entry["cachedValue"], json!(7));
    assert_eq!(entry["formula"], json!("SUM(B2:B3)"));
    doc.assert_valid();
}

#[test]
fn appending_a_row_lands_under_the_last_used_row() {
    let doc = ledger();
    doc.apply(json!([{ "op": "append_row", "sheet": "Plan", "values": ["Gamma", 9] }]));
    assert_eq!(value(&doc, "Plan", "A5"), json!("Gamma"));
    assert_eq!(value(&doc, "Plan", "B5"), json!(9));
}

#[test]
fn sorting_a_range_orders_its_rows_by_the_column() {
    let doc = ledger();
    doc.apply(json!([{ "op": "sort_range", "sheet": "Plan", "range": "A1:B3", "by": "B", "order": "desc" }]));
    assert_eq!(value(&doc, "Plan", "A1"), json!("Item"), "the header row stays");
    assert_eq!((value(&doc, "Plan", "A2"), value(&doc, "Plan", "B2")), (json!("Mug"), json!(4)));
    assert_eq!((value(&doc, "Plan", "A3"), value(&doc, "Plan", "B3")), (json!("Tea"), json!(3)));
}

#[test]
fn inserting_and_deleting_rows_shift_cells_and_the_formulas_that_read_them() {
    let doc = ledger();
    doc.apply(json!([{ "op": "insert_rows", "sheet": "Plan", "row": 2, "count": 1 }]));
    assert_eq!(value(&doc, "Plan", "A3"), json!("Tea"));
    let total = cell(&doc.snapshot(), "Plan", "B5").expect("the total moved down");
    assert_eq!(total["formula"], json!("SUM(B3:B4)"));
    doc.apply(json!([{ "op": "delete_rows", "sheet": "Plan", "row": 2 }]));
    assert_eq!(cell(&doc.snapshot(), "Plan", "B4").expect("back at B4")["formula"], json!("SUM(B2:B3)"));
    doc.apply(json!([{ "op": "insert_columns", "sheet": "Plan", "column": 1 }]));
    assert_eq!(value(&doc, "Plan", "B2"), json!("Tea"));
    assert_eq!(cell(&doc.snapshot(), "Plan", "C4").expect("shifted right")["formula"], json!("SUM(C2:C3)"));
    doc.assert_valid();
}

#[test]
fn sheets_are_added_renamed_copied_and_deleted_and_formulas_follow_a_rename() {
    let doc = ledger();
    doc.apply(json!([
        { "op": "add_sheet", "name": "Summary" },
        { "op": "set_formula", "sheet": "Summary", "cell": "A1", "formula": "=Plan!B4" },
        { "op": "rename_sheet", "sheet": "Plan", "name": "Ledger" }
    ]));
    let snapshot = doc.snapshot();
    let names: Vec<&str> = snapshot["sheets"].as_array().expect("sheets").iter().map(|s| s["name"].as_str().unwrap_or("")).collect();
    assert_eq!(names, ["Ledger", "Summary"]);
    assert_eq!(cell(&snapshot, "Summary", "A1").expect("A1")["formula"], json!("Ledger!B4"));
    doc.assert_valid();
    doc.apply(json!([{ "op": "copy_sheet", "sheet": "Ledger" }]));
    assert_eq!(doc.snapshot()["sheets"].as_array().expect("sheets").len(), 3);
    doc.apply(json!([{ "op": "delete_sheet", "sheet": "Summary" }]));
    assert_eq!(doc.snapshot()["sheets"].as_array().expect("sheets").len(), 2);
    assert!(!doc.part("xl/workbook.xml").contains("name=\"Summary\""));
    doc.assert_valid();
}

#[test]
fn a_style_gives_a_cell_its_number_format_font_and_fill() {
    let doc = ledger();
    doc.apply(json!([{ "op": "set_style", "sheet": "Plan", "range": "B2:B3", "properties": { "numberFormat": "#,##0.00", "bold": true, "fillColor": "FFEEAA" } }]));
    let styles = doc.part("xl/styles.xml");
    assert!(styles.contains("formatCode=\"#,##0.00\""), "{styles}");
    assert!(styles.contains("FFEEAA"));
    let style = cell(&doc.snapshot(), "Plan", "B2").expect("B2")["style"].clone();
    assert_eq!((style["numberFormat"].clone(), style["bold"].clone()), (json!("#,##0.00"), json!(true)));
    doc.assert_valid();
}

#[test]
fn layout_operations_write_their_sheet_elements() {
    let doc = ledger();
    doc.apply(json!([
        { "op": "merge_cells", "sheet": "Plan", "range": "D1:E1" },
        { "op": "freeze_panes", "sheet": "Plan", "row": 2, "column": 1 },
        { "op": "set_column_width", "sheet": "Plan", "column": "A", "width": 20 },
        { "op": "set_row_height", "sheet": "Plan", "row": 1, "height": 30 },
        { "op": "set_autofilter", "sheet": "Plan", "range": "A1:B3" },
        { "op": "set_page_setup", "sheet": "Plan", "orientation": "landscape", "fitToPagesWide": 1 }
    ]));
    let sheet = doc.part("xl/worksheets/sheet1.xml");
    assert!(sheet.contains("<mergeCell ref=\"D1:E1\"/>"), "{sheet}");
    assert!(sheet.contains("<pane ") && sheet.contains("state=\"frozen\""), "{sheet}");
    assert!(sheet.contains("<col ") && sheet.contains("width=\"20") && sheet.contains("customWidth=\"1\""));
    assert!(sheet.contains("ht=\"30\"") && sheet.contains("<autoFilter ref=\"A1:B3\""));
    assert!(sheet.contains("orientation=\"landscape\"") && sheet.contains("fitToPage=\"1\"") && sheet.contains("fitToWidth=\"1\""));
    let sheet_entry = doc.snapshot()["sheets"][0].clone();
    assert_eq!(sheet_entry["mergedRanges"], json!(["D1:E1"]));
    assert_eq!(sheet_entry["freezePanes"]["frozen"], json!(true));
    doc.apply(json!([{ "op": "unmerge_cells", "sheet": "Plan", "range": "D1:E1" }]));
    assert!(!doc.part("xl/worksheets/sheet1.xml").contains("<mergeCell "));
    doc.assert_valid();
}

#[test]
fn visibility_names_protection_hyperlinks_validation_and_conditional_formats_are_recorded() {
    let doc = ledger();
    doc.apply(json!([
        { "op": "add_sheet", "name": "Checks" },
        { "op": "set_sheet_visibility", "sheet": "Checks", "visibility": "hidden" },
        { "op": "define_name", "name": "Tax", "refersTo": "=Plan!$B$4" },
        { "op": "protect_sheet", "sheet": "Plan" },
        { "op": "set_hyperlink", "sheet": "Plan", "cell": "A2", "address": "https://example.com/a?b=1&c=2", "text": "Example" },
        { "op": "add_validation", "sheet": "Plan", "range": "A2:A3", "formula1": "Tea,Mug" },
        { "op": "add_conditional_format", "sheet": "Plan", "range": "B2:B3", "formula": "=B2>3", "fillColor": "FFC7CE" },
        { "op": "set_row_visibility", "sheet": "Plan", "row": 3, "visible": false }
    ]));
    let workbook = doc.part("xl/workbook.xml");
    assert!(workbook.contains("state=\"hidden\"") && workbook.contains("<definedName name=\"Tax\"") && workbook.contains("Plan!$B$4"), "{workbook}");
    let sheet = doc.part("xl/worksheets/sheet1.xml");
    assert!(sheet.contains("<sheetProtection") && sheet.contains("<hyperlink ") && sheet.contains("<dataValidation ") && sheet.contains("<conditionalFormatting"));
    assert!(sheet.contains("hidden=\"1\""));
    assert!(doc.part("xl/worksheets/_rels/sheet1.xml.rels").contains("https://example.com/a?b=1&amp;c=2"));
    let entry = doc.snapshot()["sheets"][0].clone();
    assert_eq!(entry["hiddenRows"], json!([3]));
    assert_eq!(entry["validations"].as_array().expect("validations").len(), 1);
    assert_eq!(entry["conditionalFormats"].as_array().expect("formats").len(), 1);
    doc.apply(json!([{ "op": "delete_name", "name": "Tax" }, { "op": "unprotect_sheet", "sheet": "Plan" }]));
    assert!(!doc.part("xl/workbook.xml").contains("<definedName name=\"Tax\""));
    assert!(!doc.part("xl/worksheets/sheet1.xml").contains("<sheetProtection"));
    doc.assert_valid();
}

#[test]
fn a_chart_adds_its_part_drawing_and_relationships() {
    let doc = ledger();
    doc.apply(json!([{ "op": "add_chart", "sheet": "Plan", "chartType": "column", "range": "A1:B3", "title": "Quantities" }]));
    assert!(doc.has_part("xl/charts/chart1.xml"));
    assert!(doc.has_part("xl/drawings/drawing1.xml"));
    let chart = doc.part("xl/charts/chart1.xml");
    assert!(chart.contains("<c:barChart>") && chart.contains("Quantities") && chart.contains("Plan!$B$2:$B$3"), "{chart}");
    assert_eq!(count(&doc.part("xl/drawings/drawing1.xml"), "<c:chart "), 1);
    assert!(doc.part("[Content_Types].xml").contains("/xl/charts/chart1.xml"));
    doc.assert_valid();
}

#[test]
fn a_table_and_a_pivot_table_are_registered_with_the_sheet() {
    let doc = ledger();
    doc.apply(json!([
        { "op": "add_table", "sheet": "Plan", "range": "A1:B3", "name": "Stock" },
        { "op": "add_pivot_table", "sheet": "Plan", "source": "A1:B3", "rows": ["Item"], "values": ["Qty"], "cell": "H2" }
    ]));
    let entry = doc.snapshot()["sheets"][0].clone();
    assert_eq!(entry["tables"][0]["name"], json!("Stock"));
    assert_eq!(entry["pivots"].as_array().expect("pivots").len(), 1);
    doc.assert_valid();
}

#[test]
fn an_unknown_sheet_or_operation_is_refused_by_name() {
    let doc = ledger();
    let error = doc.try_apply(json!([{ "op": "frobnicate" }])).expect_err("unsupported");
    assert_eq!(error, "Portable XLSX backend does not support operation: frobnicate");
    assert!(doc.try_apply(json!([{ "op": "set_cell", "sheet": "Nowhere", "cell": "A1", "value": 1 }])).is_err());
}
