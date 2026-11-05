//! Node-recorded twin: `fixtures/ai-admin/model-list-twin.json`
//! (`benchmarks/rust-core/recorders/record-model-list.mjs`).
use super::*;
use serde_json::{Value, json};

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/ai-admin/model-list-twin.json")).unwrap()
}

fn web(name: &str, m: &Value) -> bool {
    name == "openai" || m.get("webSearch") == Some(&Value::Bool(true))
}

#[test]
fn availability_matches_node() {
    let twin = twin();
    let cases = &twin["availabilityCases"];
    for case in cases["env"].as_array().unwrap() {
        let env = case["env"].as_object().unwrap();
        let var = |k: &str| env.get(k).and_then(Value::as_str).map(str::to_owned);
        assert_eq!(model_proxy_client_mode(&var), case["clientMode"], "env {}", case["env"]);
    }
    for case in cases["gate"].as_array().unwrap() {
        let got = developer_option_for_provider(case["name"].as_str().unwrap());
        assert_eq!(got.map_or(Value::Null, Value::from), case["option"], "gate {}", case["name"]);
    }
    for case in cases["enabled"].as_array().unwrap() {
        let stored = case["stored"].get("value").cloned().unwrap_or(Value::Null);
        let id = case["id"].as_str().unwrap();
        assert_eq!(json!(developer_option_enabled(id, &stored)), case["value"], "enabled {id} {}", case["stored"]);
    }
    assert_eq!(
        provider_unavailable_message("cursor-oauth"),
        "Provider \"cursor-oauth\" is disabled: its Developer option was switched off before the request was sent."
    );
}

#[test]
fn sort_matches_node() {
    for (i, case) in twin()["sortCases"].as_array().unwrap().iter().enumerate() {
        let rows = case["rows"].as_array().unwrap();
        let mut sorted = rows.clone();
        sort_provider_models(&mut sorted, case["primary"].as_str().unwrap());
        // Rows may repeat; compare as the recorded input order mapped through the recorded indices.
        let want: Vec<Value> = case["order"].as_array().unwrap().iter().map(|ix| rows[ix.as_u64().unwrap() as usize].clone()).collect();
        assert_eq!(sorted, want, "sort case {i}");
    }
}

#[test]
fn selectable_matches_node() {
    for (i, case) in twin()["selectableCases"].as_array().unwrap().iter().enumerate() {
        assert_eq!(json!(is_selectable_llm_model(&case["model"])), case["value"], "selectable case {i}: {}", case["model"]);
    }
}

#[test]
fn cache_rows_match_node() {
    for (i, case) in twin()["rowCases"].as_array().unwrap().iter().enumerate() {
        let name = case["provider"].as_str().unwrap();
        let got = provider_model_cache_row(name, &case["model"], web(name, &case["model"]));
        assert_eq!(Value::Object(got), case["row"], "row case {i}: {}", case["model"]);
    }
}

#[test]
fn provider_rows_match_node() {
    for (i, case) in twin()["providerRowCases"].as_array().unwrap().iter().enumerate() {
        let rows = case["rows"].as_array().unwrap();
        let got = provider_rows(rows, case["provider"].as_str().unwrap_or(""));
        assert_eq!(Value::Array(got), case["value"], "providerRows case {i}");
    }
}

struct Oracle<'a>(&'a Value);

impl HydrationFacts for Oracle<'_> {
    fn fast_capable(&self, _: &str, _: &Value) -> bool {
        self.0["fastCapable"].as_bool().unwrap()
    }
    fn ultrafast_capable(&self, _: &str, _: &Value) -> bool {
        self.0["ultrafastCapable"].as_bool().unwrap()
    }
    fn effort_items(&self, _: &str, _: &Value) -> Value {
        self.0["effortItems"].clone()
    }
    fn effort_configuration_mode(&self, _: &str, _: &str, _: &Value) -> bool {
        self.0["modeTruthy"].as_bool().unwrap()
    }
    fn custom_auto_effort_capable(&self, _: &str, _: Option<&Value>, _: &Value) -> bool {
        self.0["customAuto"].as_bool().unwrap()
    }
    fn provider_config(&self, _: &str) -> Obj {
        self.0["providerConfig"].as_object().cloned().unwrap_or_default()
    }
}

#[test]
fn hydration_matches_node() {
    let twin = twin();
    assert_eq!(daybreak_option(), twin["options"]["daybreakOption"]);
    assert_eq!(openrouter_sort_option(), twin["options"]["openrouterOption"]);
    for (i, case) in twin["hydrateCases"].as_array().unwrap().iter().enumerate() {
        let config = case["config"].as_object().cloned().unwrap_or_default();
        let got = hydrate_provider_model_row(&config, &case["row"], &Oracle(&case["oracle"]));
        assert_eq!(got, case["value"], "hydrate case {i}: {}", case["row"]);
    }
}
