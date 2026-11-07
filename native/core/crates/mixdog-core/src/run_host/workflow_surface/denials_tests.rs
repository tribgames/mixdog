//! The feature gates and the live denials against the Node golden (`fixtures/workflow-surface/
//! surface.json`, `record-workflow-surface.mjs`).

use mixdog_core_config::tool_modules::with_grandfathered_builtins;
use serde_json::Value;

use super::FeatureFacts;
use super::feature_disallowed_tools;
use super::live_denied_tools;
use crate::run_host::workflow_surface::testing::profile_of;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../../fixtures/workflow-surface/surface.json")).expect("the golden is JSON")
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().expect("list").iter().map(|name| name.as_str().expect("name").to_owned()).collect()
}

#[test]
fn the_feature_gates_equal_nodes() {
    for case in golden()["features"].as_array().expect("features") {
        let name = case["name"].as_str().expect("name");
        let stored = mixdog_core_config::config::agent_routes::stored_file_of(&case["config"]);
        let config = with_grandfathered_builtins(stored["agent"].as_object().expect("config"));
        let facts = &case["facts"];
        let facts = FeatureFacts {
            browser: facts["browser"] == true,
            computer: facts["computer"] == true,
            terminal: facts["terminal"] == true,
            visualize: facts["visualize"] == true,
            git: facts["git"] == true,
        };
        let env = |var: &str| case["env"].get(var).and_then(Value::as_str).map(str::to_owned);
        let got = feature_disallowed_tools(&config, &facts, &env, profile_of(case["profile"].as_str().expect("profile")));
        assert_eq!(got, strings(&case["denied"]), "{name}");
    }
}

#[test]
fn the_live_denials_equal_nodes() {
    for case in golden()["denied"].as_array().expect("denied") {
        let name = case["name"].as_str().expect("name");
        let session = case["session"].as_object().expect("session");
        let features = strings(&case["features"]);
        let got = live_denied_tools(session, &case["workflow"], &features);
        if case["threw"] == true {
            // Where Node throws, the denial is a typed failure and no list at all.
            assert!(got.is_err(), "{name}");
        } else {
            assert_eq!(got.expect("Node answered"), strings(&case["tools"]), "{name}");
        }
    }
}
