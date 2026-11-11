//! `fixtures/services/media-usage-twin.json` (`record-media-usage.mjs`): Node's usage readers over
//! a matrix of provider answers. The object returned (key order included: the ledger row is built
//! from it) and what a failure carries must equal Node's.

use serde_json::Value;

use super::usage::{gemini_usage, image_api_usage, interactions_usage, reported_usage, responses_usage, xai_usage};

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/services/media-usage-twin.json");

/// The recorder writes `undefined` as this marker (JSON has none); every reader treats it as null.
fn input(case: &Value) -> Value {
    if case["input"] == "__undefined__" { Value::Null } else { case["input"].clone() }
}

fn check(golden: &Value, key: &str, read: fn(&Value) -> Option<Value>) {
    for case in golden[key].as_array().unwrap() {
        let got = read(&input(case)).unwrap_or(Value::Null);
        // Compact text compares key order too.
        assert_eq!(serde_json::to_string(&got).unwrap(), serde_json::to_string(&case["output"]).unwrap(), "{key}: {}", case["input"]);
    }
}

#[test]
fn usage_is_read_as_nodes_reads_it() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    check(&golden, "gemini", gemini_usage);
    check(&golden, "interactions", interactions_usage);
    check(&golden, "responses", responses_usage);
    check(&golden, "xai", xai_usage);
    check(&golden, "imageApi", image_api_usage);
}

#[test]
fn a_failure_carries_only_billable_usage() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    for case in golden["withReported"].as_array().unwrap() {
        let given = input(case);
        let got = reported_usage(if given.is_null() { None } else { Some(given.clone()) });
        match (&case["attached"], got) {
            (Value::String(marker), None) if marker == "__absent__" => {}
            (want, Some(got)) => assert_eq!(*want, got, "{given}"),
            (want, got) => panic!("{given}: want {want}, got {got:?}"),
        }
    }
}