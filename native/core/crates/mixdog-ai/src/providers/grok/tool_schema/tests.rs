//! The flatten against Node's own output: `fixtures/grok-tool-schema/node-recorded.json` holds, per input of `inputs.json`
//! (the Rust core's tool schemas, the Node core's, and synthetic unions covering each branch of the algorithm), what Node's
//! `normalizeGrokToolSchemas` (grok-tool-schema.mjs at b6f10295a) returned for it, recorded in one run under an exact
//! manifest.

use serde_json::Value;

use super::normalize_tool_schema;
use crate::providers::grok::fixture_manifest;

const INPUTS: &str = include_str!("../../../../../../fixtures/grok-tool-schema/inputs.json");
const RECORDED: &str = include_str!("../../../../../../fixtures/grok-tool-schema/node-recorded.json");
const MANIFEST: &str = include_str!("../../../../../../fixtures/grok-tool-schema/MANIFEST.json");

#[test]
fn every_input_flattens_to_what_node_returned_byte_for_byte() {
    fixture_manifest::verify(MANIFEST, &[("inputs.json", INPUTS), ("node-recorded.json", RECORDED)]);
    let inputs: Value = serde_json::from_str(INPUTS).unwrap();
    let recorded: Value = serde_json::from_str(RECORDED).unwrap();
    let (inputs, recorded) = (inputs["cases"].as_array().unwrap(), recorded["cases"].as_array().unwrap());
    assert_eq!(inputs.len(), recorded.len(), "the recording holds another number of cases than the inputs");
    for (input, node) in inputs.iter().zip(recorded) {
        assert_eq!((&input["source"], &input["name"]), (&node["source"], &node["name"]), "the recording is not of the inputs in order");
        let got = normalize_tool_schema(&input["input"]);
        assert_eq!(got.to_string(), node["expected"].to_string(), "{} ({})", node["name"], node["source"]);
    }
}

#[test]
fn a_body_has_each_tools_parameters_flattened_as_node_flattened_them() {
    let inputs: Value = serde_json::from_str(INPUTS).unwrap();
    let recorded: Value = serde_json::from_str(RECORDED).unwrap();
    // Node's flatten reads `inputSchema`; the encoded body carries the same schema as `parameters`.
    let rows: Vec<(&Value, &Value)> = inputs["cases"].as_array().unwrap().iter().zip(recorded["cases"].as_array().unwrap()).collect();
    let tools: Vec<Value> = rows.iter().map(|(input, _)| serde_json::json!({ "type": "function", "name": input["name"], "parameters": input["input"] })).collect();
    let mut flat = serde_json::json!({ "model": "m", "tools": tools });
    assert!(super::flatten_tools(&mut flat));
    for ((_, node), tool) in rows.iter().zip(flat["tools"].as_array().unwrap()) {
        assert_eq!(tool["parameters"].to_string(), node["expected"].to_string(), "{}", node["name"]);
    }
    assert_eq!(flat["model"], "m");
}