//! The operation registry test of `office-runtime-com.test.mjs` (`operation registry matches every COM implementation and rejects unknown
//! fields before dispatch`): the operations the Rust COM host serves for each format (`mixdog_office_com::drivers::Drivers`, the editors the
//! host runs on) are the capability table's operations for the `microsoft-office-com` backend that the runtime does not turn into others
//! first, and every operation the table lists for that backend names `op` first and the backend among its own.
//! The second half of the Node test (a misspelt field is refused with the name it should have been, a style key moves to `properties`
//! where the operation does not take it at the top, a geometry key moves out of `properties`) runs against `mixdog_office::contracts`.

use mixdog_office::capabilities::capabilities;
use mixdog_office::contracts::assert_office_operation_contracts;
use mixdog_office_com::drivers::Drivers;
use serde_json::{Value, json};

const BACKEND: &str = "microsoft-office-com";

/// The formats the host serves.
const FORMATS: [&str; 3] = ["docx", "xlsx", "pptx"];

/// The operation names the Rust host's editor of `format` serves, sorted.
fn implemented(format: &str) -> Vec<String> {
    let editor = Drivers::registered().editor(format).unwrap_or_else(|| panic!("{format}: the host has no editor"));
    let mut names: Vec<String> = editor.operation_names().iter().map(|name| (*name).to_owned()).collect();
    names.sort();
    names
}

#[test]
fn the_capability_table_matches_every_com_implementation() {
    let tables = capabilities();
    let expected = [("docx", 41, 43), ("xlsx", 46, 47), ("pptx", 46, 47)];
    for (format, (_, native_count, described_count)) in FORMATS.iter().zip(expected) {
        let found = implemented(format);
        let mut described: Vec<&str> = tables.operations_for_backend(format, Some(BACKEND));
        described.sort_unstable();
        let native: Vec<&str> = described.iter().copied().filter(|operation| !tables.is_virtual(format, operation)).collect();
        assert_eq!(native, found, "{format} registry drifted from the COM backend");
        assert_eq!(found.len(), native_count, "{format}: the operations the Rust host serves");
        assert_eq!(described.len(), described_count, "{format}: the operations the table lists for the backend (the runtime's own are virtual)");
        for operation in described {
            // `describeOfficeCapabilities({ format, backend, operation }).operation`, as the Node test reads it.
            let request = mixdog_office::describe::DescribeRequest { format, backend: BACKEND, target: "", operation };
            let described = mixdog_office::describe::describe_office_capabilities(&request).unwrap_or_else(|error| panic!("{format}: {operation}: {error}"));
            let targeted = &described["operation"];
            assert_eq!(targeted["input"]["required"][0], json!("op"), "{format} {operation}: the first required field");
            assert!(targeted["supportedBackends"].as_array().is_some_and(|list| list.contains(&json!(BACKEND))), "{format} {operation}: the backend list");
        }
    }
}

#[test]
fn a_misspelt_field_is_refused_with_the_name_it_should_have_been() {
    let mut operations = vec![json!({ "op": "compress", "alowNoChange": true })];
    let refusal = assert_office_operation_contracts("pdf", "mixdog-pdf", &mut operations).expect_err("a misspelt field is refused");
    assert!(refusal.contains("unknown field(s): alowNoChange"), "{refusal}");
    assert!(refusal.contains("alowNoChange→allowNoChange"), "{refusal}");
}

#[test]
fn a_style_key_moves_into_properties_and_a_geometry_key_out_of_them() {
    // The neighbouring operation's convention is taken at its word: the style key is applied where it belongs.
    let mut styled = vec![json!({ "op": "add_textbox", "slide": 1, "text": "Title", "bold": true, "fontSize": 20 })];
    assert_office_operation_contracts("pptx", "mixdog-ooxml", &mut styled).expect("accepted");
    assert_eq!(styled[0]["properties"], json!({ "bold": true }));
    assert_eq!(styled[0].get("bold"), None);
    // fontSize is a field the operation already takes, so it stays where it was written.
    assert_eq!(styled[0]["fontSize"], json!(20));
    let mut placed = vec![json!({ "op": "add_image", "slide": 1, "path": "map.png", "properties": { "left": 60, "top": 240, "width": 300, "height": 180 } })];
    assert_office_operation_contracts("pptx", "mixdog-ooxml", &mut placed).expect("accepted");
    assert_eq!(placed[0]["left"], json!(60));
    assert_eq!(placed[0].get("properties"), None);
}

#[test]
fn a_key_the_operation_does_not_declare_anywhere_is_still_refused() {
    let mut typo: Vec<Value> = vec![json!({ "op": "add_textbox", "slide": 1, "text": "Title", "boldish": true })];
    let refusal = assert_office_operation_contracts("pptx", "mixdog-ooxml", &mut typo).expect_err("a typo is never applied as a style");
    assert!(refusal.contains("unknown field(s): boldish"), "{refusal}");
}
