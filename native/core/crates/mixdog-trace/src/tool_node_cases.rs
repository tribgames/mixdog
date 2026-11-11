//! Node's `classifyToolFailure` calls of the k1 trace cases (`fixtures/trace-cases`, `record-trace-cases.mjs`): every
//! recorded call's class through [`classify_tool_failure`], whole.
#![allow(clippy::disallowed_methods, reason = "the replay reads its fixture with a blocking read")]

use std::path::Path;

use serde_json::Value;

use crate::classify_tool_failure;

#[test]
fn every_recorded_classification_is_nodes() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/trace-cases/golden.json");
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut failures = Vec::new();
    let mut compared = 0;
    for case in golden["cases"].as_array().unwrap() {
        for call in case["calls"].as_array().unwrap() {
            let got = classify_tool_failure(&call["text"], call["tool"].as_str().unwrap());
            if got != call["result"].as_str().unwrap() {
                failures.push(format!("{} / {:?} ({}): want {} got {got}", case["case"], call["text"], call["tool"], call["result"]));
            }
            compared += 1;
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(compared, 48);
}
