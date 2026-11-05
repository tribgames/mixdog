//! Node-recorded twin: `fixtures/ai/route-admin-twin.json`
//! (`benchmarks/rust-core/recorders/record-route-admin.mjs`).

use super::*;
use serde_json::json;

fn twin() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/ai-admin/route-admin-twin.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn obj(v: &Value) -> Obj {
    v.as_object().cloned().unwrap_or_default()
}

fn outcome<T: Into<Value>>(r: Result<T, String>) -> Value {
    match r {
        Ok(v) => json!({ "value": v.into() }),
        Err(e) => json!({ "error": e }),
    }
}

/// The `{value}` / `{error}` part of a recorded entry.
fn recorded(entry: &Value) -> Value {
    match entry.get("error") {
        Some(e) => json!({ "error": e }),
        None => json!({ "value": entry["value"] }),
    }
}

#[test]
fn resolve_and_save_match_node() {
    let twin = twin();
    for (i, case) in twin["resolveCases"].as_array().unwrap().iter().enumerate() {
        let known: Vec<String> = case["known"].as_array().unwrap().iter().map(|k| k.as_str().unwrap().to_owned()).collect();
        let is_known = |p: &str, _: &Obj| known.iter().any(|k| k == js_trim(p));
        let config = obj(&case["config"]);
        let got = outcome(resolve_route(&config, &obj(&case["request"]), &is_known).map(Value::Object));
        assert_eq!(got, case["resolve"], "resolve case {i}: {}", case["request"]);
        if let Some(save) = case.get("save") {
            let mut saved = config.clone();
            save_model_settings(&mut saved, &obj(&save["route"]), save["fastCapable"].as_bool().unwrap());
            assert_eq!(Value::Object(saved), save["config"], "save case {i}");
        }
    }
}

#[test]
fn workflow_routes_match_node() {
    let twin = twin();
    for (i, case) in twin["normalizeCases"].as_array().unwrap().iter().enumerate() {
        let got = outcome(
            normalize_workflow_route(&case["route"], &case["fallback"], case["strict"].as_bool().unwrap())
                .map(|v| v.unwrap_or(Value::Null)),
        );
        assert_eq!(got, case["normalize"], "normalize case {i}: {}", case["route"]);
        if let Some(up) = case.get("upsert") {
            let got = outcome(upsert_workflow_preset(&up["presets"], up["slot"].as_str().unwrap(), &case["route"]));
            assert_eq!(got, recorded(up), "upsert case {i}");
        }
    }
}

#[test]
fn context_state_matches_node() {
    let twin = twin();
    for (i, case) in twin["contextCases"].as_array().unwrap().iter().enumerate() {
        let state = resolve_route_context_state(&obj(&case["route"]), Some(&case["meta"]));
        let mut got = Obj::new();
        for (k, v) in [
            ("contextPercent", state.context_percent),
            ("contextDefaultPercent", state.context_default_percent),
            ("selectedContextWindow", state.selected_context_window),
            ("contextTokens", state.context_tokens),
        ] {
            if let Some(v) = v {
                got.insert(k.into(), jnum(v));
            }
        }
        assert_eq!(Value::Object(got), case["state"], "context case {i}: {} {}", case["route"], case["meta"]);
    }
}

#[test]
fn text_checks_match_node() {
    let twin = twin();
    for (i, case) in twin["textCases"].as_array().unwrap().iter().enumerate() {
        let input = case["input"].get("value");
        let got = match case["kind"].as_str().unwrap() {
            "effort" => outcome(normalize_effort_input(input).map(|e| e.map_or(Value::Null, Value::String))),
            "rawModelId" => json!({ "value": is_likely_raw_model_id(input) }),
            "selector" => {
                let mut request = Obj::new();
                if let Some(v) = input {
                    request.insert("model".into(), v.clone());
                }
                outcome(validate_requested_model_selector(&obj(&case["config"]), &request).map(|()| Value::Null))
            }
            other => panic!("{other}"),
        };
        assert_eq!(got, recorded(case), "text case {i}: {case}");
    }
}
