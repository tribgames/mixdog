//! The flatten against Node's own output: `node_recorded.json` holds, per tool schema, the input and what Node's
//! `normalizeGrokToolSchemas` (grok-tool-schema.mjs at b6f10295a) returned for it. The inputs are the Rust core's
//! tool schemas, the Node core's, and synthetic unions covering each branch of the algorithm.

use serde_json::Value;

use super::normalize_tool_schema;

#[test]
fn every_recorded_tool_schema_flattens_to_what_node_returned_byte_for_byte() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("node_recorded.json")).unwrap();
    assert!(cases.len() >= 60, "the recording covers every tool: {}", cases.len());
    let mut changed = 0;
    for case in &cases {
        let got = normalize_tool_schema(&case["input"]);
        assert_eq!(got.to_string(), case["expected"].to_string(), "{} ({})", case["name"], case["source"]);
        changed += usize::from(got != case["input"]);
    }
    assert!(changed >= 30, "the recording holds schemas the flatten changes: {changed}");
}

#[test]
fn a_body_without_unions_is_left_as_is_and_one_with_them_has_its_tool_parameters_flattened() {
    let plain = br#"{"tools":[{"type":"function","name":"a","parameters":{"type":"object"}}]}"#;
    assert_eq!(super::flatten_body(plain), None);
    let union = br#"{"model":"m","tools":[{"type":"function","name":"a","parameters":{"type":"object","properties":{"p":{"anyOf":[{"type":"string"},{"type":"array","items":{"type":"string"}}]}}}}]}"#;
    let flat: Value = serde_json::from_slice(&super::flatten_body(union).unwrap()).unwrap();
    assert_eq!(flat["tools"][0]["parameters"]["properties"]["p"], serde_json::json!({"type":"array","items":{"type":"string"},"description":"Pass one or more values as an array."}));
    assert_eq!(flat["model"], "m");
}
