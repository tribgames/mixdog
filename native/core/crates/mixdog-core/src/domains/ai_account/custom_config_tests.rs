//! The config normalizer against what Node answers for the same inputs
//! (`fixtures/custom-config/record.mjs`): the normalized config or the exact refusal text.

use serde_json::Value;

use super::custom_config::normalize;

#[test]
fn every_input_normalizes_as_node_does() {
    let golden: Value = serde_json::from_str(include_str!("../../../fixtures/custom-config/golden.json")).unwrap();
    let cases = golden.as_array().unwrap();
    assert!(cases.len() > 100);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        match (normalize(&case["input"]), case["error"].as_str()) {
            (Ok(config), None) => assert_eq!(config, case["config"], "{name}"),
            (Err(message), Some(error)) => assert_eq!(message, error, "{name}"),
            (other, expected) => panic!("{name}: got {other:?}, Node {expected:?}"),
        }
    }
}
