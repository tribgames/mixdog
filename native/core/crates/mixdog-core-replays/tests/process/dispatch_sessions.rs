//! `prepareAgentSession(spec)`'s stamping against `fixtures/dispatch-sessions/golden.json`
//! (`record-dispatch-sessions.mjs`, real Node `createSession` over a stub provider): every
//! recorded record field, absent where Node leaves it out, or the error Node threw.

use serde_json::{Map, Value};

use mixdog_core::run_host::dispatch_sessions::stamped_header;
use mixdog_core::run_host::agent_dispatch::PrepareSpec;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/dispatch-sessions/golden.json")).expect("golden.json")
}

fn text(spec: &Value, key: &str) -> Option<String> {
    spec.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// The dispatch's spec as the recorder handed it to Node (`agent-dispatch/session-prep.mjs`).
fn spec_of(case: &Value) -> PrepareSpec {
    let spec = &case["spec"];
    let context: Map<String, Value> =
        ["contextPercent", "contextTokens", "selectedContextWindow"].iter().filter_map(|key| spec.get(*key).map(|value| ((*key).to_owned(), value.clone()))).collect();
    PrepareSpec {
        agent: text(spec, "agent").expect("agent"),
        preset_name: text(spec, "presetName").unwrap_or_default(),
        preset: spec["preset"].clone(),
        runtime_spec: case.get("runtimeSpec").cloned().unwrap_or_else(|| Value::Object(Map::new())),
        context,
        permission: text(spec, "permission"),
        cwd: text(spec, "cwd"),
        source_type: text(spec, "sourceType"),
        source_name: text(spec, "sourceName"),
        task_type: text(spec, "taskType"),
        parent_session_id: text(spec, "parentSessionId"),
        owner_session_id: text(spec, "ownerSessionId"),
        skip_role_reminder: spec["skipRoleReminder"] == true,
        schema_allowed_tools: spec.get("schemaAllowedTools").and_then(Value::as_array).map(|tools| tools.iter().filter_map(Value::as_str).map(str::to_owned).collect()),
    }
}

#[test]
fn the_session_is_stamped_as_nodes_create_session_records_it() {
    let golden = golden();
    let keys: Vec<&str> = golden["stampedKeys"].as_array().expect("keys").iter().filter_map(Value::as_str).collect();
    let cases = golden["prepared"].as_array().expect("prepared");
    assert!(cases.iter().any(|case| case.get("error").is_some()) && cases.iter().any(|case| case.get("stamped").is_some()));
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let made = stamped_header(&spec_of(case), |provider| provider == "stub");
        if let Some(error) = case.get("error") {
            assert_eq!(made.err().as_deref(), error.as_str(), "{name}");
            continue;
        }
        let header = made.unwrap_or_else(|error| panic!("{name}: {error}"));
        for key in &keys {
            match &case["stamped"][key] {
                Value::String(absent) if absent == "<absent>" => assert!(!header.contains_key(*key), "{name}: {key} is absent in Node"),
                expected => assert_eq!(header.get(*key), Some(expected), "{name}: {key}"),
            }
        }
    }
}
