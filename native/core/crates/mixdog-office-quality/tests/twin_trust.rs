//! Twin test `trust`: the recording of Node's office trust analysis (`native/core/fixtures/office-trust/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-trust.mjs`) against this crate. Every recorded input is run
//! through the Rust function of the same name and the exact JSON text of the answer must equal the recorded one: the
//! prompt-injection reports of values, csv/tsv text and docx/pptx/xlsx packages, the combined reviews, the mutation
//! gate and its refusals, the document brief and its readings, and the native document design review. Re-recording is
//! `twin_live_trust` (ignored: it runs Node).

mod common;

use base64::Engine;
use common::Authoring;
use mixdog_fsio::Unlaned;
use mixdog_js::json_stringify;
use mixdog_office_base::twin;
use mixdog_office_quality::document_brief::{document_brief, document_brief_issues};
use mixdog_office_quality::document_design_review::review_native_document_design;
use mixdog_office_quality::trust::{
    analyze_office_file_prompt_injection, analyze_office_prompt_injection, assert_office_mutation_allowed,
    combine_office_trust_reviews,
};
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-trust")
}

fn section<'a>(golden: &'a Value, name: &str) -> &'a [Value] {
    golden[name].as_array().unwrap_or_else(|| panic!("section {name}"))
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn cut(text: &str) -> String {
    text.chars().take(600).collect()
}

/// Replays one section: the answer of `run` to each recorded input must serialise to the recorded text, or fail with
/// the recorded message. Both sides pass through the temp-directory normaliser.
fn replay(golden: &Value, name: &str, run: impl Fn(&Value) -> Result<Value, String>) {
    let cases = section(golden, name);
    assert!(!cases.is_empty(), "section {name} is empty");
    let mut failures = Vec::new();
    for case in cases {
        let (expected, actual) = match (case.get("error"), run(&case["input"])) {
            (Some(error), Err(message)) => (json_stringify(error), json_stringify(&Value::String(message))),
            (Some(error), Ok(value)) => (format!("error {}", json_stringify(error)), json_stringify(&value)),
            (None, Ok(value)) => (json_stringify(&twin::normalise(&case["output"])), json_stringify(&twin::normalise(&value))),
            (None, Err(message)) => (json_stringify(&case["output"]), format!("error {message}")),
        };
        if expected != actual {
            let input: String = json_stringify(&case["input"]).chars().take(300).collect();
            failures.push(format!("input {input}\n  recorded {}\n  produced {}", cut(&expected), cut(&actual)));
        }
    }
    assert!(
        failures.is_empty(),
        "{name}: {} of {} cases differ\n{}",
        failures.len(),
        cases.len(),
        failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n")
    );
}

fn every_output_equals_the_recording() {
    let g = golden();
    replay(&g, "structured", |input| {
        Ok(analyze_office_prompt_injection(&input["document"], text(input, "format"), text(input, "source")))
    });
    replay(&g, "files", |input| {
        let name = text(input, "name").expect("name");
        let dir = tempfile::tempdir().expect("temp dir");
        let path = if input.get("missing").is_some() {
            std::env::temp_dir().join("mixdog-trust-missing").join(name)
        } else {
            let path = dir.path().join(name);
            let bytes = match text(input, "base64") {
                Some(encoded) => base64::engine::general_purpose::STANDARD.decode(encoded).expect("base64"),
                None => text(input, "text").expect("text or base64").as_bytes().to_vec(),
            };
            std::fs::write(&path, bytes).expect("write input file");
            path
        };
        Ok(analyze_office_file_prompt_injection(&Unlaned, &path, text(input, "format")))
    });
    replay(&g, "combine", |input| Ok(combine_office_trust_reviews(input.as_array().expect("reviews"))));
    replay(&g, "gate", |input| {
        let acknowledged = input.get("acknowledged") == Some(&Value::Bool(true));
        assert_office_mutation_allowed(input.get("trust"), acknowledged).map(|()| json!({ "allowed": true }))
    });
    replay(&g, "brief", |input| Ok(document_brief(&Authoring, text(input, "text").unwrap_or("")).unwrap_or(Value::Null)));
    replay(&g, "briefIssues", |input| {
        let brief = document_brief(&Authoring, text(input, "text").unwrap_or(""));
        Ok(Value::Array(document_brief_issues(
            &Authoring,
            text(input, "format").unwrap_or(""),
            input.get("document").unwrap_or(&Value::Null),
            brief.as_ref(),
        )))
    });
}

/// The structure issues of each recorded review are handed back to the wrapper, which must answer the whole review.
fn the_design_review_equals_the_recording() {
    let g = golden();
    let cases = section(&g, "designReview");
    assert!(!cases.is_empty());
    for case in cases {
        let issues = case["output"]["issues"].as_array().cloned().unwrap_or_default();
        let produced = review_native_document_design(text(&case["input"], "format").unwrap_or(""), issues);
        assert_eq!(json_stringify(&case["output"]), json_stringify(&produced), "input {}", json_stringify(&case["input"]));
    }
}

#[test]
fn every_output_equals_the_recording_of_node() {
    every_output_equals_the_recording();
}

#[test]
fn the_document_design_review_equals_the_recording_of_node() {
    the_design_review_equals_the_recording();
}

#[test]
fn the_recording_covers_every_section_with_a_real_spread() {
    let g = golden();
    for (name, minimum) in [("structured", 250), ("files", 30), ("combine", 100), ("gate", 20), ("briefIssues", 250), ("designReview", 50)] {
        assert!(section(&g, name).len() >= minimum, "{name} has too few cases");
    }
    for wanted in ["none", "medium", "high"] {
        assert!(
            section(&g, "structured").iter().any(|entry| entry["output"]["risk"] == wanted),
            "no {wanted} report among the structured cases"
        );
    }
    let refused = section(&g, "gate").iter().filter(|entry| entry.get("error").is_some()).count();
    assert!(refused > 5 && refused < section(&g, "gate").len(), "the gate is neither always open nor always closed");
    assert!(section(&g, "files").iter().any(|entry| entry["output"]["complete"] == false), "no incomplete file review");
}

/// Records again with Node and compares: `cargo test -p mixdog-office-quality --test twin_trust -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/quality)"]
fn twin_live_trust() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-trust.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
    the_design_review_equals_the_recording();
}
