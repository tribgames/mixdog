//! The config normalizer against what Node answers for the same inputs
//! (`benchmarks/rust-core/recorders/record-custom-config.mjs`): the normalized config or the exact refusal text.

use serde_json::Value;

use super::custom_config::normalize;

#[test]
fn every_input_normalizes_as_node_does() {
    let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/custom-config/golden.json")).unwrap();
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
