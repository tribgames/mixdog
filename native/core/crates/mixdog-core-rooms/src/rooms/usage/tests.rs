//! `room_usage_limit` against `fixtures/room-turn/golden.json`, recorded from the real Node
//! `roomUsageLimit` by `record-room-turn.mjs`.


use serde_json::{Value, json};

use super::room_usage_limit;

#[test]
fn answers_what_the_node_function_answered_for_each_recorded_case() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/room-turn/golden.json")).unwrap();
    let mut failures = Vec::new();
    for case in golden["usage"].as_array().unwrap() {
        let got = room_usage_limit(&case["done"], &case["route"]).map_or(Value::Null, |usage| {
            json!({ "kind": usage.kind, "provider": usage.provider, "model": usage.model, "resetAt": usage.reset_at })
        });
        if got != case["answer"] {
            failures.push(format!("{}: got {got}, Node {}", case["name"], case["answer"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
