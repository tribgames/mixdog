//! The worker flows' decisions against the goldens recorded from Node
//! (`fixtures/agent/record-flows.mjs`). Fixture loading reads files synchronously; tests are not
//! lane code.
#![allow(clippy::disallowed_methods)]

use mixdog_agent::agent_tool::board::JobMeta;
use mixdog_agent::agent_tool::flow::preset::merge_prepared_meta;
use mixdog_agent::agent_tool::flow::preset::pending_spawn_meta;
use mixdog_agent::agent_tool::flow::preset::preset_descriptor;
use mixdog_agent::agent_tool::flow::preset::prepared_spawn_meta;
use mixdog_agent::agent_tool::flow::preset::resolve_agent_spawn_preset;
use mixdog_agent::agent_tool::scope::normalize_agent_name;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

fn fixture(name: &str) -> Value {
    let text = std::fs::read_to_string(format!("{}/../../fixtures/agent/flows/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// `configuredAgentRouteCandidates(config, agent)` with no store bots.
fn candidates(config: &Value, args: &Value) -> Vec<Value> {
    let agent = normalize_agent_name(args.get("agent").and_then(Value::as_str).unwrap_or_default());
    config.get("agents").and_then(|a| a.get(&agent)).cloned().into_iter().collect()
}

fn resolve(config: &Value, args: &Value) -> Result<(Value, Value), String> {
    let spec = resolve_agent_spawn_preset(config.as_object().unwrap(), args, &candidates(config, args))?;
    Ok((spec.preset_name, spec.preset))
}

/// A task meta as the card shows it: no null, no empty value.
fn public_meta(meta: &JobMeta) -> Value {
    let mut out = Map::new();
    let mut put = |key: &str, value: Option<&String>| {
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            out.insert(key.into(), json!(v));
        }
    };
    put("tag", meta.tag.as_ref());
    put("sessionId", meta.session_id.as_ref());
    put("agent", meta.agent.as_ref());
    put("preset", meta.preset.as_ref());
    put("provider", meta.provider.as_ref());
    put("model", meta.model.as_ref());
    put("effort", meta.effort.as_ref());
    if let Some(fast) = meta.fast {
        out.insert("fast".into(), json!(fast));
    }
    if meta.respawned {
        out.insert("respawned".into(), json!(true));
    }
    if meta.resumed {
        out.insert("resumed".into(), json!(true));
    }
    if meta.auto_effort_off {
        out.insert("autoEffort".into(), json!(false));
    }
    Value::Object(out)
}

fn public_value(meta: &Value) -> Value {
    Value::Object(meta.as_object().unwrap().iter().filter(|(_, v)| !v.is_null() && v.as_str() != Some("")).map(|(k, v)| (k.clone(), v.clone())).collect())
}

#[test]
fn the_route_a_spawn_resolves_to_equals_nodes() {
    let golden = fixture("preset.json");
    for case in golden["preset"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let got = match resolve(&case["config"], &case["args"]) {
            Ok((preset_name, preset)) => json!({ "value": { "presetName": preset_name, "preset": preset } }),
            Err(error) => json!({ "error": error }),
        };
        assert_eq!(got, case["result"], "{name}");
    }
}

fn meta_extras(extras: &Value) -> bool {
    extras.get("respawned") == Some(&Value::Bool(true))
}

#[test]
fn the_meta_a_spawn_carries_equals_nodes() {
    let golden = fixture("preset.json");
    for case in golden["metas"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let args = &case["args"];
        let config = &golden["preset"][0]["config"];
        let resolved = (args.get("model").is_none_or(|m| m.as_str().is_none_or(str::is_empty))
            || args.get("provider").is_none_or(|m| m.as_str().is_none_or(str::is_empty)))
        .then(|| resolve(config, args).ok().map(|(_, preset)| preset))
        .flatten();
        let got = pending_spawn_meta(args, resolved.as_ref(), meta_extras(&case["extras"]));
        assert_eq!(public_meta(&got), public_value(&case["meta"]), "{name}");
    }
    for case in golden["prepared"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let input = &case["in"];
        let s = |key: &str| input[key].as_str().unwrap_or_default();
        let respawned = meta_extras(&input["extras"]);
        let meta = prepared_spawn_meta(s("tag"), s("sessionId"), s("agent"), &input["preset"], &input["presetName"], respawned);
        assert_eq!(public_meta(&meta), public_value(&case["meta"]), "{name} meta");
        let descriptor = preset_descriptor(s("agent"), &input["preset"], &input["presetName"]);
        assert_eq!(Value::Object(descriptor), case["descriptor"], "{name} descriptor");
        let merged = merge_prepared_meta(&JobMeta { tag: Some(s("tag").into()), agent: Some(s("agent").into()), ..JobMeta::default() }, &meta);
        assert_eq!(public_meta(&merged), public_value(&case["merged"]["meta"]), "{name} merged");
    }
}
