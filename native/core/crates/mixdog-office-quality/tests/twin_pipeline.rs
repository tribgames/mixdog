//! Twin test `pipeline`: the recording of Node's office quality pipeline (`native/core/fixtures/office-pipeline/
//! golden.json`, written by `benchmarks/rust-core/recorders/record-office-pipeline.mjs`) against this crate. Every
//! recorded input is run through the Rust function of the same name and the exact JSON text of the answer must equal
//! the recorded one: issue lists, polish plans, submission gates, release scores, page reviews, acceptance verdicts
//! and checklists. Re-recording is `twin_live_pipeline` (ignored: it runs Node).

use mixdog_js::json_stringify;
use mixdog_office_base::twin;
use mixdog_office_quality::checklist::evaluate_office_checklist;
use mixdog_office_quality::document_acceptance::{
    assess_document_acceptance, is_automated_ready, review_document_pages, review_status,
};
use mixdog_office_quality::issue::issue_with;
use mixdog_office_quality::pipeline::{
    build_office_polish_plan, evaluate_office_submission_gate, is_advisory_office_issue, normalize_office_review_issues,
    resolve_office_render_output,
};
use mixdog_office_quality::presentation_acceptance::assess_presentation_acceptance;
use mixdog_office_quality::score::score_office_release_quality;
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-pipeline")
}

fn section<'a>(golden: &'a Value, name: &str) -> &'a [Value] {
    golden[name].as_array().unwrap_or_else(|| panic!("section {name}"))
}

fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn list(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

/// Replays one section: the answer of `run` to each recorded input must serialise to the recorded text.
fn replay(golden: &Value, name: &str, run: impl Fn(&Value) -> Value) {
    let cases = section(golden, name);
    assert!(!cases.is_empty(), "section {name} is empty");
    let mut failures = Vec::new();
    for case in cases {
        let expected = json_stringify(&case["output"]);
        let actual = json_stringify(&run(&case["input"]));
        if expected != actual {
            let input: String = json_stringify(&case["input"]).chars().take(400).collect();
            failures.push(format!("input {input}\n  recorded {}\n  produced {}", cut(&expected), cut(&actual)));
        }
    }
    assert!(failures.is_empty(), "{name}: {} of {} cases differ\n{}", failures.len(), cases.len(), failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n"));
}

fn cut(text: &str) -> String {
    text.chars().take(600).collect()
}

fn every_output_equals_the_recording() {
    let g = golden();
    replay(&g, "advisory", |input| Value::Bool(is_advisory_office_issue(input)));
    replay(&g, "renderOutput", |input| {
        let path = input.as_str().expect("path");
        json!({ "path": path, "resolved": resolve_office_render_output(path) })
    });
    replay(&g, "normalize", |input| Value::Array(normalize_office_review_issues(&list(Some(input)))));
    replay(&g, "polish", |input| build_office_polish_plan(&text(input, "format"), &list(input.get("issues"))));
    replay(&g, "gate", |input| {
        evaluate_office_submission_gate(
            &list(input.get("issues")),
            input.get("persisted").unwrap_or(&Value::Null),
            input.get("visualCoverage").unwrap_or(&Value::Null),
        )
    });
    replay(&g, "issue", |input| {
        let parts: Vec<&str> = input.as_array().expect("arguments").iter().map(|part| part.as_str().expect("text")).collect();
        issue_with(parts[0], parts[1], parts[2], parts.get(3).copied().unwrap_or("format-review"), parts.get(4).copied().unwrap_or("warning"))
    });
    replay(&g, "score", score_office_release_quality);
    replay(&g, "documentReview", |input| {
        review_document_pages(&text(input, "format"), input.get("design").unwrap_or(&Value::Null), input.get("state").unwrap_or(&Value::Null))
            .unwrap_or(Value::Null)
    });
    replay(&g, "automatedReady", |input| Value::Bool(is_automated_ready(input.get("evidence").unwrap_or(&Value::Null))));
    replay(&g, "reviewStatus", |input| {
        let flags: Vec<bool> = input.as_array().expect("flags").iter().map(|flag| flag.as_bool().expect("flag")).collect();
        json!(review_status(flags[0], flags[1], flags[2]))
    });
    replay(&g, "documentAcceptance", |input| {
        assess_document_acceptance(input.get("evidence").unwrap_or(&Value::Null), input.get("visual"))
    });
    replay(&g, "presentationAcceptance", |input| {
        assess_presentation_acceptance(
            input.get("evidence").unwrap_or(&Value::Null),
            input.get("acknowledged").and_then(Value::as_bool).unwrap_or(false),
            input.get("critique"),
        )
    });
    replay(&g, "checklist", evaluate_office_checklist);
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

#[test]
fn the_recording_covers_every_section_with_a_real_spread() {
    let g = golden();
    for (name, minimum) in [("score", 500), ("documentReview", 500), ("checklist", 100), ("polish", 50), ("gate", 100)] {
        assert!(section(&g, name).len() >= minimum, "{name} has too few cases");
    }
    let blocked = section(&g, "gate").iter().filter(|case| case["output"]["ok"] == Value::Bool(false)).count();
    assert!(blocked > 10 && blocked < section(&g, "gate").len(), "the gates are neither all open nor all closed");
}

/// Records again with Node and compares: `cargo test -p mixdog-office-quality --test twin_pipeline -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/quality)"]
fn twin_live_pipeline() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-pipeline.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
