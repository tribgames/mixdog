//! The failure classes Node's tests assert for shell, patch and navigation results
//! (`fixtures/tools-untested/trace-classify.json`, `record-tools-untested.mjs`), replayed whole and in the recorded order.

use mixdog_trace::classify_tool_failure;
use serde_json::Value;

#[test]
fn failures_are_classified_as_node_classifies_them() {
    let doc: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/tools-untested/trace-classify.json")).unwrap();
    let mut failures = Vec::new();
    for case in doc["cases"].as_array().unwrap() {
        let got = classify_tool_failure(&case["text"], case["tool"].as_str().unwrap());
        if got != case["category"].as_str().unwrap() {
            failures.push(format!("{} ({}): Node {}, here {got}", case["text"], case["tool"], case["category"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
