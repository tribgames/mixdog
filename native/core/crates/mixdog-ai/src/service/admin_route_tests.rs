//! Node-recorded twin: `fixtures/ai/route-admin-twin.json`
//! (`benchmarks/rust-core/recorders/record-route-admin.mjs`).

use super::*;
use serde_json::json;

fn twin() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/ai-admin/route-admin-twin.json")).unwrap()
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
        let meta = (!case["meta"].is_null()).then(|| &case["meta"]);
        let cached = (!case["cached"].is_null()).then(|| &case["cached"]);
        let state = resolve_route_context_state(&obj(&case["route"]), window_meta_of(meta, cached));
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

fn known_of(case: &Value) -> Vec<String> {
    case["known"].as_array().unwrap().iter().map(|k| k.as_str().unwrap().to_owned()).collect()
}

#[test]
fn selections_match_node() {
    for (i, case) in twin()["selectionCases"].as_array().unwrap().iter().enumerate() {
        let got = outcome(required_model_selection(&case["input"]).map(Value::Object));
        assert_eq!(got, recorded(case), "selection case {i}: {}", case["input"]);
    }
}

#[test]
fn lead_persistence_matches_node() {
    for (i, case) in twin()["leadCases"].as_array().unwrap().iter().enumerate() {
        let known = known_of(case);
        let is_known = |p: &str, _: &Obj| known.iter().any(|k| k == js_trim(p));
        let mut config = obj(&case["config"]);
        let got = persist_adopted_model_settings(
            &mut config,
            &obj(&case["live"]),
            &obj(&case["route"]),
            case["keepMainModel"].as_bool(),
            &is_known,
        );
        let got = outcome(got.map(|lead| json!({ "lead": lead.unwrap_or(Value::Null), "config": config })));
        let want = recorded(case);
        let want = match want.get("value") {
            Some(v) => json!({ "value": { "lead": v["lead"], "config": v["config"] } }),
            None => want,
        };
        assert_eq!(got, want, "lead case {i}");
    }
}

#[test]
fn chain_entries_match_node() {
    for (i, case) in twin()["chainCases"].as_array().unwrap().iter().enumerate() {
        let known = known_of(case);
        let is_known = |p: &str, _: &Obj| known.iter().any(|k| k == js_trim(p));
        let meta = (!case["meta"].is_null()).then(|| &case["meta"]);
        let got = start_chain_entry(&obj(&case["config"]), &obj(&case["requested"]), &obj(&case["stored"]), &is_known)
            .map(|selected| {
                finish_chain_entry(selected, meta, window_meta_of(meta, None), |route| {
                    case["fastByProvider"][clean(route.get("provider")).as_str()].as_bool().unwrap_or(false)
                })
            });
        assert_eq!(outcome(got.map(Value::Object)), recorded(case), "chain case {i}");
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

/// `refreshRouteEffort`: the effort ladders come from `crate::effort` (not from the recording), Fast
/// from the recorded `fastCapableFor`; everything around them is `refresh_route_fields`.
#[test]
fn refresh_route_effort_matches_node() {
    for (i, case) in twin()["refreshCases"].as_array().unwrap().iter().enumerate() {
        // A refresh superseded by another route, or whose lease ended, leaves the route alone.
        if case["value"].is_null() {
            continue;
        }
        let route = obj(&case["route"]);
        let meta = (!case["meta"].is_null()).then(|| &case["meta"]);
        let live = route.get("provider").and_then(Value::as_str).unwrap_or("");
        let fast = |_: &str, _: &Value, _: Option<&str>, _: &Value| case["ladder"]["fast"].as_bool().unwrap();
        let got = refresh_route_fields(&obj(&case["config"]), &route, meta, live, &fast);
        assert_eq!(json!(got), case["after"], "refresh case {i}");
    }
}
