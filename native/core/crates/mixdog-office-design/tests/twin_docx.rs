//! Twin test `docx`: the recording of Node's docx design modules (`native/core/fixtures/office-docx/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-docx.mjs`) against this crate. Every operation list, every
//! counter of the shared state and every refusal is compared value for value, and as the exact JSON text. Re-recording
//! is `twin_live_docx` (ignored: it runs Node).

use mixdog_js::json_stringify;
use mixdog_office_base::twin;
use mixdog_office_design::docx::components::{CalloutOptions, add_docx_decision_callout, add_docx_metric_strip, add_docx_roadmap, add_docx_section_table};
use mixdog_office_design::docx::typography::{document_typography, has_hangul, is_serif_face, korean_design, pair_table_east_asia};
use mixdog_office_design::docx::{DocxState, expand_docx_document};
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-docx")
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
fn check(what: &str, input: &Value, expected: &Value, actual: &Value) {
    let found = twin::differences(expected, actual);
    let shown = json_stringify(input).chars().take(160).collect::<String>();
    assert!(found.is_empty(), "{what} {shown}: {}", found.iter().take(8).cloned().collect::<Vec<_>>().join("; "));
    let (want, got) = (json_stringify(expected), json_stringify(actual));
    let at = want.bytes().zip(got.bytes()).position(|(a, b)| a != b);
    assert!(want == got, "{what} {shown}: the JSON text differs at byte {at:?} (recorded {} bytes, produced {})", want.len(), got.len());
}

fn design<'a>(golden: &'a Value, name: &Value) -> &'a Value {
    let name = name.as_str().expect("design name");
    golden["designs"].get(name).or_else(|| golden["koreanDesigns"].get(name)).unwrap_or_else(|| panic!("design {name}"))
}

fn state_of(recorded: &Value) -> DocxState {
    DocxState { paragraph: recorded["paragraph"].as_u64().expect("paragraph"), table: recorded["table"].as_u64().expect("table") }
}

fn state_value(state: DocxState) -> Value {
    json!({ "paragraph": state.paragraph, "table": state.table })
}

fn replay_expand(g: &Value) {
    for case in cases(g, "expand") {
        let input = &case["input"];
        let operation = &g["operations"][input["operation"].as_str().expect("operation")];
        let composition = Some(&input["composition"]).filter(|plan| !plan.is_null());
        let mut state = state_of(&input["state"]);
        let result = expand_docx_document(operation, design(g, &input["design"]), &mut state, composition);
        check("expand", input, &recorded(case), &attempt(result.map(Value::Array)));
        check("expand state", input, &case["state"], &state_value(state));
    }
}

fn replay_callout(g: &Value) {
    for case in cases(g, "callout") {
        let input = &case["input"];
        let options = &input["options"];
        // A key left out takes the default; a null is a value that is neither a label nor a tone.
        let label = if options.get("label").is_some() { options["label"].as_str().unwrap_or("") } else { "" };
        let emphasis = if options.get("emphasis").is_some() { options["emphasis"].as_str().unwrap_or("") } else { "inverse" };
        let east_asia = options.get("eastAsia").filter(|face| !face.is_null()).cloned();
        let mut output = Vec::new();
        let mut state = DocxState { paragraph: 2, table: 1 };
        add_docx_decision_callout(&mut output, &mut state, input["text"].as_str().expect("text"), design(g, &input["design"]), &CalloutOptions { label, emphasis, east_asia });
        check("callout", input, &recorded(case), &attempt(Ok(Value::Array(output))));
        check("callout state", input, &case["state"], &state_value(state));
    }
}

fn replay_strip(g: &Value) {
    for case in cases(g, "strip") {
        let input = &case["input"];
        let metrics = &g["metrics"][input["metrics"].as_str().expect("metrics")];
        let mut output = Vec::new();
        let mut state = DocxState::default();
        let result = add_docx_metric_strip(&mut output, &mut state, metrics, design(g, &input["design"]));
        check("strip", input, &recorded(case), &attempt(result.map(|drew| json!({ "drew": drew, "operations": output }))));
        check("strip state", input, &case["state"], &state_value(state));
    }
}

fn replay_roadmap(g: &Value) {
    for case in cases(g, "roadmap") {
        let input = &case["input"];
        let mut output = Vec::new();
        let mut state = DocxState::default();
        let drew = add_docx_roadmap(&mut output, &mut state, &input["steps"], design(g, &input["design"]));
        check("roadmap", input, &recorded(case), &attempt(Ok(json!({ "drew": drew, "operations": output }))));
        check("roadmap state", input, &case["state"], &state_value(state));
    }
}

fn replay_section_table(g: &Value) {
    for case in cases(g, "sectionTable") {
        let input = &case["input"];
        let rows = input["values"].as_array().expect("rows");
        let mut output = Vec::new();
        let mut state = DocxState::default();
        let drew = add_docx_section_table(
            &mut output,
            &mut state,
            rows,
            design(g, &input["design"]),
            input["variant"].as_str().expect("variant"),
            input["style"].as_str().expect("style"),
        );
        check("section table", input, &recorded(case), &attempt(Ok(json!({ "drew": drew, "operations": output }))));
        check("section table state", input, &case["state"], &state_value(state));
    }
    // Called without a variant or a style: the plain table.
    for case in cases(g, "sectionTableDefaults") {
        let input = &case["input"];
        let mut output = Vec::new();
        let mut state = DocxState::default();
        let drew = add_docx_section_table(&mut output, &mut state, input["values"].as_array().expect("rows"), &g["designs"]["default"], "default", "");
        check("section table defaults", input, &recorded(case), &attempt(Ok(json!({ "drew": drew, "operations": output }))));
    }
}

fn replay_typography(g: &Value) {
    let faces = g["faces"].as_array().expect("faces");
    for case in cases(g, "documentTypography") {
        let input = &case["input"];
        let faces_of_design = if input["typography"].get("omitted").is_some() { None } else { Some(&input["typography"]) };
        let document = document_typography(&input["operation"], faces_of_design);
        let face = |role: &str| document.face(role).cloned().unwrap_or(Value::Null);
        let actual = json!({
            "eastAsia": document.east_asia().cloned().unwrap_or(Value::Null),
            "display": face("display"),
            "body": face("body"),
            "data": face("data"),
            "eastAsiaFor": faces.iter().map(|latin| document.east_asia_for(Some(latin)).unwrap_or(Value::Null)).collect::<Vec<_>>(),
        });
        check("document typography", input, &recorded(case), &attempt(Ok(actual)));
    }
    for case in cases(g, "koreanDesign") {
        let input = &case["input"];
        let actual = korean_design(design(g, &input["design"]), input["text"].as_str().expect("text"));
        check("korean design", input, &recorded(case), &attempt(Ok(actual)));
    }
    for case in cases(g, "pairTableEastAsia") {
        let input = &case["input"];
        let document = document_typography(&input["operation"], Some(&json!({ "display": "Cambria", "body": "Calibri", "data": "Arial" })));
        let mut output = input["output"].as_array().expect("output").clone();
        pair_table_east_asia(&mut output, &document);
        check("pair table east asia", input, &recorded(case), &attempt(Ok(Value::Array(output))));
    }
    for case in cases(&g["faceTests"], "serif") {
        let face = case["face"].as_str().expect("face");
        assert_eq!(is_serif_face(face), case["serif"].as_bool().expect("flag"), "serif face {face:?}");
    }
    for case in cases(&g["faceTests"], "hangul") {
        let text = case["text"].as_str().expect("text");
        assert_eq!(has_hangul(text), case["hangul"].as_bool().expect("flag"), "hangul in {text:?}");
    }
}

fn every_output_equals_the_recording() {
    let g = golden();
    replay_expand(&g);
    replay_callout(&g);
    replay_strip(&g);
    replay_roadmap(&g);
    replay_section_table(&g);
    replay_typography(&g);
}

#[test]
fn every_recorded_output_is_equal() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-office-design --test twin_docx -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/design/docx)"]
fn twin_live_docx() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-docx.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
