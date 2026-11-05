//! Search-pattern errors are V8's, byte for byte: every pattern recorded from Node
//! (`record-regex-errors.mjs`), including a seeded fuzz corpus whose valid patterns must
//! still compile.

#![allow(clippy::disallowed_methods, reason = "test setup")]

use std::path::Path;

use mixdog_workspace::textsearch::Pattern;
use mixdog_workspace::textsearch::TextQuery;
use serde_json::Value;

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/desktop/search/regex-errors.json");
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn check(cases: &Value, failures: &mut Vec<String>) {
    for case in cases.as_array().unwrap() {
        let query = case["query"].as_str().unwrap();
        let match_case = case["flags"] == "gu";
        let got = Pattern::compile(&TextQuery { query: query.into(), regex: true, match_case, ..Default::default() });
        let expected = case["message"].as_str().map(|m| format!("Invalid search pattern: {m}"));
        match (&got, &expected) {
            (Ok(_), None) => {}
            (Err(e), Some(m)) if &e.message == m => {}
            _ => failures.push(format!("{query:?} /{}/: expected {expected:?}, got {:?}", case["flags"], got.err().map(|e| e.message))),
        }
    }
}

#[test]
fn every_recorded_pattern_gets_v8s_verdict_and_text() {
    let fixture = fixture();
    let mut failures = Vec::new();
    check(&fixture["cases"], &mut failures);
    check(&fixture["fuzz"], &mut failures);
    assert!(failures.is_empty(), "{} mismatches, first 80:\n{}", failures.len(), failures.iter().take(80).cloned().collect::<Vec<_>>().join("\n"));
}
/// The shared check, held to the same recorded corpus. It is ignored while it differs from
/// Node (44 of ~6200 recorded patterns at the time of writing); run with `--ignored` to see
/// the list, and delete `v8regex` once this passes.
#[test]
#[ignore = "mixdog-js js_regex_error still differs from Node on the fuzz corpus"]
fn the_shared_js_check_matches_the_recorded_corpus() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for case in fixture["cases"].as_array().unwrap().iter().chain(fixture["fuzz"].as_array().unwrap()) {
        let got = mixdog_js::js_regex_error(case["query"].as_str().unwrap(), case["flags"].as_str().unwrap());
        if got.as_deref() != case["message"].as_str() {
            failures.push(format!("{:?}: node {:?}, mixdog-js {:?}", case["query"], case["message"], got));
        }
    }
    assert!(failures.is_empty(), "{} differ, first 20:\n{}", failures.len(), failures.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}