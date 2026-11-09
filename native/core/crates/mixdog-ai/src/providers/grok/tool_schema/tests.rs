//! The flatten against Node's own output: `node_recorded.json` holds, per tool schema, the input and what Node's
//! `normalizeGrokToolSchemas` (grok-tool-schema.mjs at b6f10295a) returned for it. The inputs are the Rust core's
//! tool schemas, the Node core's, and synthetic unions covering each branch of the algorithm.

use serde_json::Value;

use super::normalize_tool_schema;

#[test]
fn every_recorded_tool_schema_flattens_to_what_node_returned_byte_for_byte() {
    let recording: Value = serde_json::from_str(include_str!("node_recorded.json")).unwrap();
    let manifest = &recording["manifest"];
    assert_eq!((manifest["node"].as_str(), manifest["exact"].as_bool()), (Some("b6f10295a"), Some(true)));
    let cases = recording["cases"].as_array().unwrap();
    let mut changed = 0;
    let mut names = Vec::new();
    for case in cases {
        let got = normalize_tool_schema(&case["input"]);
        assert_eq!(got.to_string(), case["expected"].to_string(), "{} ({})", case["name"], case["source"]);
        changed += usize::from(case["input"].to_string() != case["expected"].to_string());
        names.push(format!("{}:{}", case["source"].as_str().unwrap(), case["name"].as_str().unwrap()));
    }
    // The recorder wrote the manifest from the same run: the case list, count and changed count are exactly what Node saw.
    assert_eq!(names, manifest["names"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_owned()).collect::<Vec<_>>());
    assert_eq!(cases.len() as u64, manifest["count"].as_u64().unwrap());
    assert_eq!(changed, manifest["changed"].as_u64().unwrap() as usize);
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
