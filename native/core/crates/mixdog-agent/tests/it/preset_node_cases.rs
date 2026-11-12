//! Node's spawn-preset cases (`fixtures/spawn-preset-cases`, `record-spawn-preset-cases.mjs`): each config and args
//! through `resolve_agent_spawn_preset` with the route candidates Node read for the agent, the whole
//! `{presetName, preset}` against Node's.
#![allow(clippy::disallowed_methods)]

use mixdog_agent::agent_tool::flow::preset::resolve_agent_spawn_preset;
use serde_json::Value;
use serde_json::json;

#[test]
fn every_recorded_spawn_preset_case_is_nodes_whole_preset() {
    let path = format!("{}/../../fixtures/spawn-preset-cases/golden.json", env!("CARGO_MANIFEST_DIR"));
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().unwrap() {
        let candidates = case["candidates"].as_array().unwrap();
        let got = match resolve_agent_spawn_preset(case["config"].as_object().unwrap(), &case["args"], candidates) {
            Ok(spec) => json!({"presetName": spec.preset_name, "preset": spec.preset}),
            Err(error) => json!({"error": error}),
        };
        if got != case["recorded"] {
            failures.push(format!("{}:\n  want {}\n  got  {got}", case["case"], case["recorded"]));
        }
    }
    assert!(failures.is_empty(), "{} case(s) differ:\n{}", failures.len(), failures.join("\n"));
}
