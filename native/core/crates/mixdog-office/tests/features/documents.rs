//! Word, Excel and PowerPoint documents the crate's own writers make (portable mode: no Microsoft Office), read back through
//! snapshot, get and issues.

use serde_json::{Value, json};

use crate::support::{Harness, find};

fn created(office: &Harness, path: &str, operations: Value) -> String {
    let answer = office.call(json!({ "action": "create", "path": path, "mode": "portable", "operations": operations }));
    assert_eq!(answer["backend"], "mixdog-ooxml", "{answer}");
    assert_eq!(answer["batch"]["ok"], true, "{answer}");
    answer["session"].as_str().expect("session").to_owned()
}

fn cells_of(snapshot: &Value) -> Vec<Value> {
    snapshot["document"]["sheets"][0]["cells"].as_array().expect("cells").clone()
}

fn cell<'a>(cells: &'a [Value], reference: &str) -> &'a Value {
    cells.iter().find(|cell| cell["ref"] == reference).unwrap_or_else(|| panic!("no cell {reference}"))
}

#[test]
fn a_workbook_cell_is_typed_as_excel_types_an_entry_and_text_that_is_not_such_a_figure_stays_text() {
    let office = Harness::new();
    let session = created(
        &office,
        "types.xlsx",
        json!([
            { "op": "set_range", "range": "A1:D2", "values": [["허브", "물동량", "비율", "메모"], ["서울", 1240, 0.928, "9월 실측"]] },
            { "op": "set_cell", "cell": "A3", "value": "1,240" },
            { "op": "set_cell", "cell": "B3", "value": -18.5 },
            { "op": "set_cell", "cell": "A4", "value": "007" },
            { "op": "set_cell", "cell": "A5", "value": "1e3" },
            { "op": "set_cell", "cell": "A6", "value": "(100)" },
        ]),
    );
    let snapshot = office.call(json!({ "action": "snapshot", "session": session }));
    assert_eq!(snapshot["document"]["sheetNames"], json!(["Sheet1"]));
    let cells = cells_of(&snapshot);
    assert_eq!(cell(&cells, "A1")["value"], "허브");
    assert_eq!(cell(&cells, "A1")["dataType"], "text");
    assert_eq!(cell(&cells, "B2")["value"], 1240);
    assert_eq!(cell(&cells, "C2")["value"], 0.928);
    // typed_number: "1,234" is a figure Excel types as a number under #,##0, so both backends agree on it.
    assert_eq!(cell(&cells, "A3")["value"], 1240, "a grouped figure is typed as the number it names");
    assert_eq!(cell(&cells, "B3")["value"], -18.5);
    assert_eq!(cell(&cells, "A4")["value"], "007");
    assert_eq!(cell(&cells, "A4")["dataType"], "text", "leading zeros are kept");
    for (reference, written) in [("A5", "1e3"), ("A6", "(100)")] {
        assert_eq!(cell(&cells, reference)["value"], written);
        assert_eq!(cell(&cells, reference)["dataType"], "text", "{written} is not a figure Excel types, so it stays as written");
    }
}

#[test]
fn get_reads_the_element_it_names_a_sheet_or_a_cell() {
    let office = Harness::new();
    let session = created(&office, "get.xlsx", json!([{ "op": "set_range", "range": "A1:B2", "values": [["항목", "값"], ["매출", 5317.43]] }]));
    let sheet = office.call(json!({ "action": "get", "session": session, "target": "/sheet[Sheet1]" }));
    assert_eq!(sheet["element"]["name"], "Sheet1");
    assert_eq!(sheet["element"]["path"], "/sheet[Sheet1]");
    let leaf = office.call(json!({ "action": "get", "session": session, "target": "/sheet[Sheet1]/cell[B2]" }));
    assert_eq!(leaf["element"]["value"], 5317.43);
    assert_eq!(leaf["element"]["ref"], "B2");
}

#[test]
fn sheets_are_added_and_renamed_and_the_snapshot_lists_them_in_order() {
    let office = Harness::new();
    let session = created(&office, "sheets.xlsx", json!([{ "op": "set_cell", "cell": "A1", "value": 1 }]));
    office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "add_sheet", "name": "Summary" }, { "op": "rename_sheet", "sheet": "Sheet1", "name": "Data" }] }));
    let snapshot = office.call(json!({ "action": "snapshot", "session": session }));
    assert_eq!(snapshot["document"]["sheetNames"], json!(["Data", "Summary"]));
}

#[test]
fn a_formula_written_by_the_crate_has_no_cached_value_and_the_audit_says_so() {
    let office = Harness::new();
    let session = created(
        &office,
        "form.xlsx",
        json!([{ "op": "set_range", "range": "A1:B2", "values": [["a", "b"], [1, 2]] }, { "op": "set_formula", "cell": "C2", "formula": "=A2+B2" }]),
    );
    let answer = office.call(json!({ "action": "issues", "session": session }));
    let issues = answer["issues"].as_array().expect("issues");
    let missing = issues.iter().find(|issue| issue["code"] == "formula_cache_missing").unwrap_or_else(|| panic!("{answer}"));
    // One uncached formula is reported at its cell; several are one fact about the sheet (validation.rs).
    assert_eq!(missing["path"], "/sheet[Sheet1]/cell[C2]");
    assert!(missing.get("cells").is_none());
    let several = created(
        &office,
        "forms.xlsx",
        json!([{ "op": "set_range", "range": "A1:B2", "values": [["a", "b"], [1, 2]] }, { "op": "set_formula", "cell": "C2", "formula": "=A2+B2" }, { "op": "set_formula", "cell": "D2", "formula": "=A2*B2" }]),
    );
    let answer = office.call(json!({ "action": "issues", "session": several }));
    let missing =
        answer["issues"].as_array().expect("issues").iter().find(|issue| issue["code"] == "formula_cache_missing").unwrap_or_else(|| panic!("{answer}"));
    assert_eq!(missing["path"], "/sheet[Sheet1]");
    assert_eq!(missing["cells"], json!(["C2", "D2"]));
    assert_eq!(missing["cellCount"], 2);
}

#[test]
fn validate_answers_the_format_and_what_it_checked_for_a_workbook() {
    let office = Harness::new();
    let session = created(&office, "valid.xlsx", json!([{ "op": "set_cell", "cell": "A1", "value": "x" }]));
    let answer = office.call(json!({ "action": "validate", "session": session }));
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(answer["format"], "xlsx");
}

#[test]
fn a_word_document_lists_its_paragraphs_and_a_paragraph_can_be_replaced() {
    let office = Harness::new();
    let session = created(&office, "report.docx", json!([{ "op": "append_text", "text": "Old body" }, { "op": "append_text", "text": "Second paragraph" }]));
    let snapshot = office.call(json!({ "action": "snapshot", "session": session }));
    let texts: Vec<String> =
        find(&snapshot, "paragraphs").and_then(Value::as_array).expect("paragraphs").iter().filter_map(|p| p["text"].as_str().map(str::to_owned)).collect();
    assert!(texts.iter().any(|text| text == "Old body"), "{texts:?}");
    assert!(texts.iter().any(|text| text == "Second paragraph"), "{texts:?}");
    let index =
        find(&snapshot, "paragraphs").and_then(Value::as_array).expect("paragraphs").iter().position(|p| p["text"] == "Old body").expect("a position") + 1;
    let replaced =
        office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "set_paragraph_text", "paragraph": index, "text": "New body" }] }));
    assert_eq!(replaced["ok"], true, "{replaced}");
    let after = office.call(json!({ "action": "snapshot", "session": session }));
    let texts: Vec<&str> = find(&after, "paragraphs").and_then(Value::as_array).expect("paragraphs").iter().filter_map(|p| p["text"].as_str()).collect();
    assert!(texts.contains(&"New body") && !texts.contains(&"Old body"), "{texts:?}");
}

#[test]
fn a_deck_gets_slides_and_text_boxes_and_a_tiny_font_is_an_issue() {
    let office = Harness::new();
    let session = created(
        &office,
        "deck.pptx",
        json!([{ "op": "add_slide" }, { "op": "add_textbox", "slide": 1, "text": "Hello deck", "left": 60, "top": 60, "width": 400, "height": 60, "fontSize": 24 }]),
    );
    let snapshot = office.call(json!({ "action": "snapshot", "session": session }));
    assert!(snapshot.to_string().contains("Hello deck"), "{snapshot}");
    assert_eq!(find(&snapshot, "slides").and_then(Value::as_array).map(Vec::len), Some(1));
    let edited = office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "add_textbox", "slide": 1, "text": "Fine print", "left": 60, "top": 300, "width": 400, "height": 30, "fontSize": 5 }] }));
    assert_eq!(edited["ok"], true, "{edited}");
    let issues = office.call(json!({ "action": "issues", "session": session }));
    assert!(issues["issues"].as_array().expect("issues").iter().any(|issue| issue["code"] == "small_font"), "{issues}");
}

#[test]
fn a_slide_can_be_deleted_and_the_deck_keeps_the_rest() {
    let office = Harness::new();
    let session = created(
        &office,
        "two.pptx",
        json!([{ "op": "add_slide" }, { "op": "add_slide" }, { "op": "add_textbox", "slide": 2, "text": "Second slide text", "left": 60, "top": 60, "width": 400, "height": 60 }]),
    );
    let done = office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "delete_slide", "slide": 1 }] }));
    assert_eq!(done["ok"], true, "{done}");
    let snapshot = office.call(json!({ "action": "snapshot", "session": session }));
    assert_eq!(find(&snapshot, "slides").and_then(Value::as_array).map(Vec::len), Some(1));
    assert!(snapshot.to_string().contains("Second slide text"));
}

#[test]
fn an_operation_that_misses_a_required_field_or_does_not_exist_is_refused_and_changes_nothing() {
    let office = Harness::new();
    let session = created(&office, "refuse.xlsx", json!([{ "op": "set_cell", "cell": "A1", "value": "keep" }]));
    // contracts/checks.rs `required_input_fault`: "<FORMAT> operation "<name>" at operation <n> has invalid input (missing: <fields>). <hint>"
    let batch = |operations: Value| office.text_of(json!({ "action": "batch", "session": session, "operations": operations }), false);
    assert_eq!(
        batch(json!([{ "op": "set_cell" }])),
        "Error: XLSX operation \"set_cell\" at operation 1 has invalid input (missing: cell, value). Call office with {\"action\":\"describe\",\"format\":\"xlsx\",\"backend\":\"mixdog-ooxml\",\"operation\":\"set_cell\"}."
    );
    // contracts/mod.rs: "Unknown <FORMAT> operation "<name>" at operation <n>.<suggestions> Call office with <describe call> to list operations."
    let unknown = batch(json!([{ "op": "zzzzzz" }]));
    assert_eq!(
        unknown,
        "Error: Unknown XLSX operation \"zzzzzz\" at operation 1. Call office with {\"action\":\"describe\",\"format\":\"xlsx\",\"backend\":\"mixdog-ooxml\"} to list operations."
    );
    let cell = office.call(json!({ "action": "get", "session": session, "target": "/sheet[Sheet1]/cell[A1]" }));
    assert_eq!(cell["element"]["value"], "keep");
}
