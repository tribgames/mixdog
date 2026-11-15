//! Twin test `xlsx`: the recording of Node's xlsx design expansion (`native/core/fixtures/office-xlsx/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-xlsx.mjs`) against this crate. Every operation list is
//! compared value for value, and as the exact JSON text; an expansion Node refuses is refused with the same message.
//! Re-recording is `twin_live_xlsx` (ignored: it runs Node).

use mixdog_js::{json_number, json_stringify, to_number_of};
use mixdog_office_base::twin;
use mixdog_office_design::xlsx::{band_height, expand_xlsx_sheet, wrap_words};
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-xlsx")
}

fn cases<'a>(golden: &'a Value, section: &str) -> &'a [Value] {
    golden[section].as_array().unwrap_or_else(|| panic!("section {section}"))
}

/// Node's `{ value }` / `{ error }` of an attempt.
fn attempt(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({ "value": value }),
        Err(error) => json!({ "error": error }),
    }
}

/// The recorded `{ value }` or `{ error }` of a case.
fn recorded(case: &Value) -> Value {
    if case.get("error").is_some() { json!({ "error": case["error"] }) } else { json!({ "value": case["value"] }) }
}

/// The output equals the recording value for value, and as JSON text.
fn check(what: &str, case: &Value, actual: &Value) {
    let expected = recorded(case);
    let name = case["input"]["name"].as_str().unwrap_or("");
    let shown = json_stringify(&case["input"]["composition"]);
    let found = twin::differences(&expected, actual);
    assert!(found.is_empty(), "{what} {name} {shown}: {}", found.iter().take(8).cloned().collect::<Vec<_>>().join("; "));
    let (want, got) = (json_stringify(&expected), json_stringify(actual));
    let at = want.bytes().zip(got.bytes()).position(|(a, b)| a != b);
    assert!(want == got, "{what} {name} {shown}: the JSON text differs at byte {at:?} (recorded {} bytes, produced {})", want.len(), got.len());
}

fn replay_sheets(g: &Value) {
    for case in cases(g, "cases") {
        let input = &case["input"];
        let design = &g["designs"][input["design"].as_str().expect("design")];
        let composition = Some(&input["composition"]).filter(|composition| !composition.is_null());
        let result = expand_xlsx_sheet(&input["operation"], design, composition).map(Value::Array);
        check("sheet", case, &attempt(result));
    }
}

fn replay_text_helpers(g: &Value) {
    for case in cases(g, "bandHeights") {
        let input = &case["input"];
        let height = band_height(input["text"].as_str().expect("text"), to_number_of(Some(&input["size"])), to_number_of(Some(&input["canvas"])));
        check("band height", case, &attempt(Ok(json_number(height))));
    }
    for case in cases(g, "wrapWords") {
        let input = &case["input"];
        let wrapped = wrap_words(input["text"].as_str().expect("text"), to_number_of(Some(&input["size"])), to_number_of(Some(&input["canvas"])));
        check("wrapped words", case, &attempt(Ok(Value::String(wrapped))));
    }
}

fn every_output_equals_the_recording() {
    let g = golden();
    assert!(cases(&g, "cases").len() > 150, "the recording holds its corpus");
    replay_sheets(&g);
    replay_text_helpers(&g);
}

#[test]
fn every_recorded_output_is_equal() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-office-design --test twin_xlsx -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/design/xlsx)"]
fn twin_live_xlsx() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-xlsx.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
