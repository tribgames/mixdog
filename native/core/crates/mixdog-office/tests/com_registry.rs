//! The source-text test of `office-runtime-com.test.mjs` (`operation registry matches every COM implementation and rejects unknown
//! fields before dispatch`): the Microsoft Office host is a PowerShell script that only runs against an installed Office on Windows, so the
//! operations it implements can only be read from its text. The names `assets/office-com-host.ps1` (the crate `mixdog-office-com` embeds
//! it) implements between each format's markers are the capability table's operations for the `microsoft-office-com` backend that the runtime
//! does not turn into others first, and every operation the table lists for that backend names `op` first and the backend among its own.
//! The second half of the Node test (a misspelt field is refused with the name it should have been, a style key moves to `properties`
//! where the operation does not take it at the top, a geometry key moves out of `properties`) runs against `mixdog_office::contracts`.

use std::path::PathBuf;
use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_office::capabilities::capabilities;
use mixdog_office::contracts::assert_office_operation_contracts;
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken};
use serde_json::{Value, json};

const BACKEND: &str = "microsoft-office-com";

/// `(format, start marker, end marker)`: the section of the script that holds each format's operations.
const SECTIONS: [(&str, &str, &str); 3] = [
    ("docx", "function Apply-WordOperation", "function Excel-Sheet"),
    ("xlsx", "function Apply-ExcelOperation", "function Ppt-Slide"),
    ("pptx", "function Apply-PowerPointOperation", "function Apply-Operations"),
];

static OPERATION_NAME: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\s{4,8}'([a-z][a-z0-9_]*)'\s*\{", "gm"));

fn on_lane<R: Send + 'static>(job: impl FnOnce(&InLane<DurabilityIo>) -> R + Send + 'static) -> R {
    let lanes = mixdog_rt::testing::tokens();
    tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("runtime")
        .block_on(async { lanes.durability_io.submit(&CancellationToken::new(), job).expect("submit").await.expect("job") })
}

fn host_script() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../mixdog-office-com/assets/office-com-host.ps1");
    on_lane(move |lane| mixdog_fsio::read_to_string(lane, &path)).expect("the embedded Office COM host script")
}

/// The operation names of one section of the script, sorted.
fn implemented(source: &str, format: &str, start_marker: &str, end_marker: &str) -> Vec<String> {
    let start = source.find(start_marker).unwrap_or_else(|| panic!("{format}: no {start_marker:?}"));
    let after = start + start_marker.len();
    let end = after + source[after..].find(end_marker).unwrap_or_else(|| panic!("{format}: no {end_marker:?} after the start"));
    let mut names: Vec<String> = OPERATION_NAME.captures_iter(&source[start..end]).filter_map(|found| found.get(1).map(str::to_owned)).collect();
    names.sort();
    names
}

#[test]
fn the_capability_table_matches_every_com_implementation() {
    let source = host_script();
    let tables = capabilities();
    let expected = [("docx", 41, 43), ("xlsx", 46, 47), ("pptx", 46, 47)];
    for ((format, start, end), (_, native_count, described_count)) in SECTIONS.iter().zip(expected) {
        let found = implemented(&source, format, start, end);
        let mut described: Vec<&str> = tables.operations_for_backend(format, Some(BACKEND));
        described.sort_unstable();
        let native: Vec<&str> = described.iter().copied().filter(|operation| !tables.is_virtual(format, operation)).collect();
        assert_eq!(native, found, "{format} registry drifted from the COM backend");
        assert_eq!(found.len(), native_count, "{format}: the operations the host implements");
        assert_eq!(described.len(), described_count, "{format}: the operations the table lists for the backend (the runtime's own are virtual)");
        for operation in described {
            let targeted = tables.operation(format, operation).unwrap_or_else(|| panic!("{format}: {operation} is listed but has no entry"));
            assert_eq!(targeted.input.required.first().map(String::as_str), Some("op"), "{format} {operation}: the first required field");
            assert!(targeted.supported_backends.contains(&BACKEND), "{format} {operation}: the backend list");
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
