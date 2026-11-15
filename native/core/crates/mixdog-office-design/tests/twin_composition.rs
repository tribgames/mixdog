//! Twin test `composition`: the recording of Node's composition system, design system and native design
//! (`native/core/fixtures/office-composition/golden.json`, written by
//! `benchmarks/rust-core/recorders/record-office-composition.mjs`) against this crate. Every context, plan, review,
//! expansion, PDF design and native design is compared value for value, and as the exact JSON text; a request Node
//! refuses is refused with the same message. Re-recording is `twin_live_composition` (ignored: it runs Node).

use std::collections::HashMap;

use mixdog_js::{json_stringify, to_number_of};
use mixdog_office_base::twin;
use mixdog_office_base::values::truthy;
use mixdog_office_design::composition::{
    CompositionUsage, plan_office_composition, resolve_office_composition_context, review_office_composition_sequence, summarize_office_compositions,
};
use mixdog_office_design::design_system::{ExpandRequest, apply_pdf_design, expand_office_design_operations, resolve_office_design};
use mixdog_office_design::native_design::{native_design_receipt, native_office_design, uses_native_office_design};
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-composition")
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
fn check(what: &str, name: &str, expected: &Value, actual: &Value) {
    let found = twin::differences(expected, actual);
    assert!(found.is_empty(), "{what} {name}: {}", found.iter().take(8).cloned().collect::<Vec<_>>().join("; "));
    let (want, got) = (json_stringify(expected), json_stringify(actual));
    let at = want.bytes().zip(got.bytes()).position(|(a, b)| a != b);
    assert!(want == got, "{what} {name}: the JSON text differs at byte {at:?} (recorded {} bytes, produced {})", want.len(), got.len());
}

fn name_of(case: &Value) -> String {
    case["input"]["name"].as_str().unwrap_or("").to_owned()
}

fn some(value: &Value) -> Option<&Value> {
    Some(value).filter(|value| !value.is_null())
}

fn replay_contexts(g: &Value) {
    for case in cases(g, "contexts") {
        let input = &case["input"];
        let context = resolve_office_composition_context(input["format"].as_str().expect("format"), &input["input"], some(&input["recent"]));
        let actual = json!({ "purpose": context.purpose, "expressionMode": context.expression_mode, "recentCompositions": context.recent_compositions });
        check("context", &json_stringify(input), &json!({ "value": case["value"] }), &json!({ "value": actual }));
    }
}

fn replay_plans(g: &Value) {
    for case in cases(g, "plans") {
        let input = &case["input"];
        let design = &g["designs"][input["design"].as_str().expect("design")];
        let mut usage = CompositionUsage::new();
        let plan = plan_office_composition(input["format"].as_str().expect("format"), &input["operation"], design, &mut usage);
        let name = format!("{} {} on {}", input["format"], name_of(case), input["design"]);
        check("plan", &name, &recorded(case), &attempt(Ok(plan)));
        assert_eq!(usage.values().sum::<usize>(), 1, "plan {name}: one use is counted");
    }
}

fn replay_batches(g: &Value) {
    for case in cases(g, "batches") {
        let input = &case["input"];
        let (name, format) = (name_of(case), input["format"].as_str().expect("format"));
        let design = &g["designs"][input["design"].as_str().expect("design")];
        let mut usage = CompositionUsage::new();
        let plans: Vec<Value> = input["operations"].as_array().expect("operations").iter().map(|operation| plan_office_composition(format, operation, design, &mut usage)).collect();
        let wrapped: Vec<Value> = plans.iter().enumerate().map(|(index, plan)| if index % 2 == 1 { json!({ "op": "x", "composition": plan }) } else { plan.clone() }).collect();
        let (plans, wrapped) = (Value::Array(plans), Value::Array(wrapped));
        let recent = &input["recent"];
        let without_twin = Value::Array(recent.as_array().expect("recent")[1..].to_vec());
        let want = &case["value"];
        let counted: HashMap<String, usize> = want["usage"].as_array().expect("usage").iter().map(|pair| (pair[0].as_str().expect("id").to_owned(), pair[1].as_u64().expect("count") as usize)).collect();
        assert_eq!(usage, counted, "batch {name}: usage");
        let actual = json!({
            "plans": plans,
            "summary": summarize_office_compositions(format, Some(&plans)),
            "wrappedSummary": summarize_office_compositions(format, Some(&wrapped)),
            "emptySummary": summarize_office_compositions(format, Some(&json!([]))),
            "notAList": summarize_office_compositions(format, Some(&json!("x"))),
            "review": review_office_composition_sequence(format, Some(&plans), Some(recent), false),
            "reviewWrapped": review_office_composition_sequence(format, Some(&wrapped), Some(&without_twin), false),
            "reviewAllowed": review_office_composition_sequence(format, Some(&plans), Some(recent), true),
            "reviewNone": review_office_composition_sequence(format, Some(&json!([])), Some(recent), false),
            "reviewDefault": review_office_composition_sequence(format, None, None, false),
        });
        let mut expected = want.clone();
        expected.as_object_mut().expect("value").shift_remove("usage");
        check("batch", &name, &json!({ "value": expected }), &json!({ "value": actual }));
    }
}

fn replay_expansions(g: &Value) {
    for case in cases(g, "expands") {
        let request = &case["input"]["request"];
        let snapshot = request.get("snapshotVersion").filter(|version| truthy(version)).map_or(0.0, |version| to_number_of(Some(version)));
        let result = expand_office_design_operations(&ExpandRequest {
            format: request["format"].as_str().expect("format"),
            operations: request.get("operations").unwrap_or(&Value::Null),
            design: request.get("design").unwrap_or(&Value::Null),
            library: request.get("library"),
            created: request.get("created").is_some_and(truthy),
            snapshot_version: snapshot,
        });
        check("expansion", &name_of(case), &recorded(case), &attempt(result));
    }
}

fn replay_pdf_designs(g: &Value) {
    for case in cases(g, "pdfs") {
        let input = &case["input"];
        let blocks = input["blocks"].as_array().expect("blocks");
        let result = apply_pdf_design(blocks, &input["design"], some(&input["library"]));
        check("pdf design", &name_of(case), &recorded(case), &attempt(result));
    }
}

fn replay_native_designs(g: &Value) {
    for case in cases(g, "natives") {
        let input = &case["input"];
        let format = input["format"].as_str().expect("format");
        let operations = input["operations"].as_array().expect("operations");
        let shown = json_stringify(input);
        assert_eq!(uses_native_office_design(format, &input["request"], operations), case["uses"].as_bool().expect("uses"), "uses native {shown}");
        let built = native_office_design(format, &input["request"]).map(|design| json!({ "design": design, "receipt": native_design_receipt(&design) }));
        check("native design", &shown, &recorded(case), &attempt(built));
    }
}

fn replay_resolved_designs(g: &Value) {
    for case in cases(g, "resolves") {
        let input = &case["input"];
        let result = resolve_office_design(input["format"].as_str().expect("format"), &input["request"], some(&input["library"]));
        check("resolved design", &json_stringify(input), &recorded(case), &attempt(result));
    }
}

fn every_output_equals_the_recording() {
    let g = golden();
    assert!(cases(&g, "plans").len() > 200, "the recording holds its corpus");
    replay_contexts(&g);
    replay_plans(&g);
    replay_batches(&g);
    replay_expansions(&g);
    replay_pdf_designs(&g);
    replay_native_designs(&g);
    replay_resolved_designs(&g);
}

#[test]
fn every_recorded_output_is_equal() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-office-design --test twin_composition -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/design)"]
fn twin_live_composition() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-composition.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
