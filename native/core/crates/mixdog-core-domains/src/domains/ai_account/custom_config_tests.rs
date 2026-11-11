//! The config normalizer against what Node answers for the same inputs
//! (`benchmarks/rust-core/recorders/record-custom-config.mjs`): the normalized config or the exact refusal text.

use serde_json::Value;

use super::custom_config::normalize;
use super::custom_config::normalize_input;

/// A `requestBody` holding lone surrogates is measured as Node measures `JSON.stringify(requestBody)`, each lone unit as its
/// six-character escape (`native/core/fixtures/lone-surrogate-wire`, record-lone-surrogate-wire.mjs): the request text is read
/// as the frame decoder reads it (U+FFFD, and where each lone unit was), and the verdict is Node's for every body case.
#[test]
fn a_request_body_holding_lone_surrogates_is_measured_as_node_measures_it() {
    let text = mixdog_testkit::fixture!("../../fixtures/lone-surrogate-wire/golden.json");
    let golden: Value = serde_json::from_str(&mixdog_js::json_well_formed_str(text)).unwrap();
    let mut seen = 0;
    for case in golden["cases"].as_array().unwrap().iter().filter(|case| case["name"].as_str().unwrap().contains("-body-")) {
        let name = case["name"].as_str().unwrap();
        let request = case["coreText"].as_str().unwrap();
        let units = mixdog_js::json_lone_surrogates(request)
            .iter()
            .filter(|at| matches!(at, mixdog_js::LoneAt::Unit { pointer, .. } if pointer.starts_with("/input/requestBody/")))
            .count();
        let params: Value = serde_json::from_str(&mixdog_js::json_well_formed_str(request)).unwrap();
        let verdict = normalize_input(&params["input"], units).err();
        assert_eq!(verdict.as_deref(), case["node"]["error"].as_str(), "{name}");
        seen += 1;
    }
    assert_eq!(seen, 8);
}

#[test]
fn every_input_normalizes_as_node_does() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/custom-config/golden.json")).unwrap();
    let cases = golden.as_array().unwrap();
    assert!(cases.len() > 100);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        // A case given as raw request text keeps how its numbers were written (`1.0`).
        let input: Value = match case["inputText"].as_str() {
            Some(text) => serde_json::from_str(text).unwrap(),
            None => case["input"].clone(),
        };
        match (normalize(&input), case["error"].as_str()) {
            // As `JSON.stringify` writes it: a number written `1.0` is `1`.
            (Ok(config), None) => {
                let written: Value = serde_json::from_str(&mixdog_js::json_stringify(&config)).unwrap();
                assert_eq!(written, case["config"], "{name}");
            }
            (Err(message), Some(error)) => assert_eq!(message, error, "{name}"),
            (other, expected) => panic!("{name}: got {other:?}, Node {expected:?}"),
        }
    }
}
