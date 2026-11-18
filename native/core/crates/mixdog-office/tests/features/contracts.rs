//! The operation contracts the batch applies before anything is written (`contracts/`), and the shape the digest gives every
//! answer (`digest/`), observed through `Engine::execute`.

use serde_json::{Value, json};

use crate::support::Harness;

const SET_CELL_HINT: &str = r#"Call office with {"action":"describe","format":"xlsx","backend":"mixdog-ooxml","operation":"set_cell"}."#;

fn created(office: &Harness, path: &str, operations: Value) -> String {
    let answer = office.call(json!({ "action": "create", "path": path, "mode": "portable", "operations": operations }));
    answer["session"].as_str().expect("session").to_owned()
}

/// The references of the cells the first sheet holds, from the snapshot (an unwritten cell is not in it).
fn written_refs(office: &Harness, session: &str) -> Vec<String> {
    let snapshot = office.call(json!({ "action": "snapshot", "session": session }));
    snapshot["document"]["sheets"][0]["cells"].as_array().expect("cells").iter().map(|cell| cell["ref"].as_str().expect("ref").to_owned()).collect()
}

fn batch_text(office: &Harness, session: &str, operations: Value) -> String {
    office.text_of(json!({ "action": "batch", "session": session, "operations": operations }), false)
}

#[test]
fn a_single_cell_written_as_a_range_is_taken_as_the_cell_and_a_wide_range_is_refused_with_what_to_use() {
    let office = Harness::new();
    let session = created(&office, "contract.xlsx", json!([{ "op": "set_cell", "cell": "A1", "value": "keep" }]));
    let accepted = office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "set_cell", "range": "D5", "value": 620 }] }));
    assert_eq!(accepted["ok"], true, "{accepted}");
    let leaf = office.call(json!({ "action": "get", "session": session, "target": "/sheet[Sheet1]/cell[D5]" }));
    assert_eq!(leaf["element"]["value"], 620);
    assert_eq!(
        batch_text(&office, &session, json!([{ "op": "set_cell", "range": "B2:E2", "value": 4 }])),
        format!("Error: XLSX operation \"set_cell\" at operation 1 writes one cell: pass cell instead of range. For B2:E2 use set_range (values) or set_style (formatting). {SET_CELL_HINT}")
    );
    assert!(!written_refs(&office, &session).contains(&"B2".to_owned()), "a refused batch wrote nothing");
}

#[test]
fn a_field_the_operation_does_not_take_is_named_and_the_fault_says_which_operation_of_the_batch_it_is() {
    let office = Harness::new();
    let session = created(&office, "fields.xlsx", json!([{ "op": "set_cell", "cell": "A1", "value": 1 }]));
    let text = batch_text(&office, &session, json!([{ "op": "set_cell", "cell": "A2", "value": 2 }, { "op": "set_cell", "cell": "A3", "value": 3, "frob": true }]));
    assert!(text.starts_with("Error: XLSX operation \"set_cell\" at operation 2 has unknown field(s): frob."), "{text}");
    assert!(text.ends_with(SET_CELL_HINT), "{text}");
    assert_eq!(written_refs(&office, &session), ["A1"], "the valid first operation was not applied either");
}

#[test]
fn an_operation_without_a_name_is_refused_by_its_place() {
    let office = Harness::new();
    let session = created(&office, "named.xlsx", json!([{ "op": "set_cell", "cell": "A1", "value": 1 }]));
    assert_eq!(batch_text(&office, &session, json!([{ "op": "set_cell", "cell": "A2", "value": 2 }, { "cell": "A3" }])), "Error: Office operation 2 requires op");
}

#[test]
fn every_answer_reports_how_long_it_took_and_a_written_file_is_named_as_an_artifact() {
    let office = Harness::new();
    let made = office.call(json!({ "action": "create", "path": "art.xlsx", "mode": "portable", "operations": [{ "op": "set_cell", "cell": "A1", "value": 1 }] }));
    assert!(made["metrics"]["durationMs"].as_f64().expect("a duration") >= 0.0, "{made}");
    let artifact = &made["artifacts"][0];
    assert_eq!((artifact["operation"].as_str(), artifact["format"].as_str()), (Some("create"), Some("xlsx")), "{made}");
    assert!(artifact["path"].as_str().expect("path").replace('\\', "/").ends_with("/art.xlsx"), "{made}");
    assert_eq!(made["outputCount"], 1);
    let session = made["session"].as_str().expect("session");
    let edited = office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "set_cell", "cell": "A2", "value": 2 }] }));
    assert_eq!(edited["artifacts"][0]["operation"], "edit", "{edited}");
    assert_eq!(edited["artifacts"][0]["path"], artifact["path"]);
    let read = office.call(json!({ "action": "snapshot", "session": session }));
    assert!(read.get("artifacts").is_none(), "a read produces no file: {read}");
    assert!(read["metrics"]["durationMs"].is_number());
}

#[test]
fn results_carry_what_each_operation_did_without_the_fields_it_left_empty() {
    let office = Harness::new();
    let session = created(&office, "results.xlsx", json!([{ "op": "set_cell", "cell": "A1", "value": 1 }]));
    let answer = office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "set_cell", "cell": "A2", "value": 2 }] }));
    let results = answer["batch"]["results"].as_array().or_else(|| answer["results"].as_array()).unwrap_or_else(|| panic!("{answer}"));
    assert_eq!(results.len(), 1);
    for (key, value) in results[0].as_object().expect("a result") {
        assert!(value != "", "{key} is empty and should have been left out");
    }
    assert_eq!(results[0]["op"], "set_cell");
}

#[test]
fn a_delimited_file_carries_no_design_in_any_answer() {
    let office = Harness::new();
    let made = office.call(json!({ "action": "create", "path": "plain.csv", "operations": [{ "op": "set_cell", "cell": "A1", "value": "x" }] }));
    assert!(made.get("design").is_none() && made["batch"].get("design").is_none(), "{made}");
    let session = made["session"].as_str().expect("session");
    let edited = office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "set_cell", "cell": "B1", "value": "y" }] }));
    assert!(edited.get("design").is_none(), "{edited}");
}
fn deck(office: &Harness) -> String {
    created(office, "contract.pptx", json!([{ "op": "add_slide" }, { "op": "add_textbox", "slide": 1, "text": "Hello deck", "left": 60, "top": 60, "width": 400, "height": 60, "fontSize": 24 }]))
}

fn describe_call(format: &str, operation: Option<&str>) -> String {
    let mut call = json!({ "action": "describe", "format": format, "backend": "mixdog-ooxml" });
    if let Some(operation) = operation {
        call["operation"] = json!(operation);
    }
    call.to_string()
}

#[test]
fn an_unknown_operation_is_refused_by_its_place_in_a_deck_and_in_a_document_alike() {
    let office = Harness::new();
    let slides = deck(&office);
    let words = created(&office, "contract.docx", json!([{ "op": "append_text", "text": "first" }]));
    for (session, format) in [(&slides, "pptx"), (&words, "docx")] {
        let text = batch_text(&office, session, json!([{ "op": "zzzzzz" }]));
        assert_eq!(text, format!("Error: Unknown {} operation \"zzzzzz\" at operation 1. Call office with {} to list operations.", format.to_uppercase(), describe_call(format, None)));
    }
}

#[test]
fn a_deck_operation_with_a_field_it_does_not_take_or_without_what_it_needs_is_refused_before_anything_is_written() {
    let office = Harness::new();
    let session = deck(&office);
    let hint = describe_call("pptx", Some("add_textbox"));
    let extra = batch_text(&office, &session, json!([{ "op": "add_textbox", "slide": 1, "text": "x", "frob": true }]));
    assert!(extra.starts_with("Error: PPTX operation \"add_textbox\" at operation 1 has unknown field(s): frob."), "{extra}");
    assert!(extra.ends_with(&format!("Call office with {hint}.")), "{extra}");
    let bare = batch_text(&office, &session, json!([{ "op": "add_textbox", "text": "no slide" }]));
    assert!(bare.starts_with("Error: PPTX operation \"add_textbox\" at operation 1 has invalid input ("), "{bare}");
    assert!(bare.contains("missing: slide"), "{bare}");
    let snapshot = office.call(json!({ "action": "snapshot", "session": session }));
    assert!(!snapshot.to_string().contains("no slide"), "a refused batch wrote nothing");
}

#[test]
fn a_verb_the_catalogue_knows_under_another_name_is_taken_for_the_operation_it_names() {
    let office = Harness::new();
    let session = created(&office, "alias.docx", json!([{ "op": "append_text", "text": "first" }]));
    let answer = office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "add_paragraph", "text": "through the alias" }] }));
    assert_eq!(answer["ok"], true, "{answer}");
    let snapshot = office.call(json!({ "action": "snapshot", "session": session }));
    assert!(snapshot.to_string().contains("through the alias"), "{snapshot}");
}

#[test]
fn a_word_snapshot_leaves_out_what_it_holds_none_of_and_does_not_repeat_the_body_as_a_part() {
    let office = Harness::new();
    let session = created(&office, "digest.docx", json!([{ "op": "append_text", "text": "Body text" }]));
    let snapshot = office.call(json!({ "action": "snapshot", "session": session }));
    let document = snapshot["document"].as_object().unwrap_or_else(|| panic!("{snapshot}"));
    for (key, value) in document {
        assert!(!value.as_array().is_some_and(Vec::is_empty), "{key} is an empty list and reads the same absent");
    }
    if let Some(parts) = document.get("parts").and_then(Value::as_array) {
        assert!(
            !parts.iter().any(|part| part["part"] == "word/document.xml" && part.as_object().is_some_and(|part| part.keys().all(|key| key == "part" || key == "text"))),
            "{parts:?}"
        );
    }
}

#[test]
fn a_deck_snapshot_says_a_slide_is_hidden_only_when_it_is_and_states_a_run_value_once() {
    let office = Harness::new();
    let session = deck(&office);
    let snapshot = office.call(json!({ "action": "snapshot", "session": session }));
    let slides = snapshot["document"]["slides"].as_array().unwrap_or_else(|| panic!("{snapshot}"));
    assert_eq!(slides.len(), 1);
    assert!(slides[0].get("hidden").is_none(), "a shown slide says so by omission: {}", slides[0]);
    for shape in slides[0]["shapes"].as_array().expect("shapes") {
        let Some(font) = shape.get("font") else { continue };
        for (list, key) in [("sizes", "size"), ("fonts", "name"), ("colors", "color")] {
            let Some(values) = shape.get(list).and_then(Value::as_array) else { continue };
            assert!(!(values.len() == 1 && values.first() == font.get(key)), "{list} repeats the {key} the font already states: {shape}");
        }
    }
}

#[test]
fn a_deck_edit_is_named_as_an_artifact_of_the_pptx_file() {
    let office = Harness::new();
    let session = deck(&office);
    let edited = office.call(json!({ "action": "batch", "session": session, "operations": [{ "op": "add_slide" }] }));
    let artifact = &edited["artifacts"][0];
    assert_eq!((artifact["operation"].as_str(), artifact["format"].as_str()), (Some("edit"), Some("pptx")), "{edited}");
    assert!(artifact["path"].as_str().expect("path").replace('\\', "/").ends_with("/contract.pptx"));
}