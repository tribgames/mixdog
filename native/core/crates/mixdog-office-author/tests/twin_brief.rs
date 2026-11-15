//! Twin test `brief`: the recording of Node's authoring brief (`native/core/fixtures/office-brief/golden.json`,
//! written by `benchmarks/rust-core/recorders/record-office-brief.mjs`) against this crate. Every recorded header is
//! parsed and every recorded HTML comment read as a script, and every parsed brief is held against the recorded deck
//! snapshots (carrier review, plan gate, fact coverage, facts gate, source grounding). The exact JSON text of each
//! answer must equal the recorded one. Re-recording is `twin_live_brief` (ignored: it runs Node).

use mixdog_js::json_stringify;
use mixdog_office_author::brief::{
    FACTS_SAMPLE_DISCLOSURE, facts_gate, html_brief_script, is_showcase_brief, parse_authoring_brief, plan_gate, planned_carrier_gaps, review_brief_promises,
    review_fact_coverage, review_source_grounding,
};
use mixdog_office_base::twin;
use serde_json::{Value, json};

fn golden() -> Value {
    twin::load_golden("office-brief")
}

fn section<'a>(golden: &'a Value, name: &str) -> &'a [Value] {
    let cases = golden[name].as_array().unwrap_or_else(|| panic!("section {name}"));
    assert!(!cases.is_empty(), "section {name} is empty");
    cases
}

fn cut(text: &str) -> String {
    text.chars().take(500).collect()
}

/// The produced answer serialises to the recorded text.
fn same(what: &str, input: &Value, expected: &Value, actual: &Value, failures: &mut Vec<String>) {
    let (want, got) = (json_stringify(expected), json_stringify(actual));
    if want != got {
        failures.push(format!("{what} {}\n  recorded {}\n  produced {}", cut(&json_stringify(input)), cut(&want), cut(&got)));
    }
}

fn no_failures(what: &str, total: usize, failures: &[String]) {
    assert!(failures.is_empty(), "{what}: {} of {total} cases differ\n{}", failures.len(), failures.iter().take(3).cloned().collect::<Vec<_>>().join("\n"));
}

fn every_output_equals_the_recording() {
    let g = golden();
    assert_eq!(g["disclosure"].as_str(), Some(FACTS_SAMPLE_DISCLOSURE));

    let mut failures = Vec::new();
    for case in section(&g, "parse") {
        let script = case["input"].as_str().expect("script");
        same("parse", &case["input"], &case["output"], &parse_authoring_brief(script), &mut failures);
    }
    no_failures("parse", section(&g, "parse").len(), &failures);

    let mut failures = Vec::new();
    for case in section(&g, "html") {
        let html = case["input"].as_str().expect("html");
        same("html", &case["input"], &case["output"], &Value::String(html_brief_script(html)), &mut failures);
    }
    no_failures("html", section(&g, "html").len(), &failures);

    let mut failures = Vec::new();
    for case in section(&g, "review") {
        let (brief, document) = (&case["input"]["brief"], &case["input"]["document"]);
        let produced = json!({
            "gaps": planned_carrier_gaps(document, brief),
            "promises": review_brief_promises(document, brief),
            "planGate": plan_gate(document, brief),
            "coverage": review_fact_coverage(document, brief),
            "factsGate": facts_gate(document, brief),
            "grounding": review_source_grounding(brief),
            "showcase": is_showcase_brief(brief),
        });
        same("review", &case["input"], &case["output"], &produced, &mut failures);
    }
    no_failures("review", section(&g, "review").len(), &failures);
}

#[test]
fn every_output_equals_the_recorded_answer() {
    every_output_equals_the_recording();
}

/// Records again with Node and compares: `cargo test -p mixdog-office-author --test twin_brief -- --ignored`.
#[test]
#[ignore = "re-records through Node (src/runtime/office/authoring)"]
fn twin_live_brief() {
    let printed = twin::run_recorder("benchmarks/rust-core/recorders/record-office-brief.mjs", &twin::node_source_root());
    assert!(printed.contains("golden.json"), "the recorder did not finish: {printed}");
    every_output_equals_the_recording();
}
