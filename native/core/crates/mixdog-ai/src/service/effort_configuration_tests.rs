//! Node-recorded twin: `fixtures/ai-admin/effort-configuration-twin.json`
//! (`benchmarks/rust-core/recorders/record-effort-configuration.mjs`).
use super::*;
use serde_json::json;

fn twin() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/ai-admin/effort-configuration-twin.json")).unwrap()
}

#[test]
fn matches_node() {
    let unsupported = UnsupportedEfforts::default();
    for (i, case) in twin()["cases"].as_array().unwrap().iter().enumerate() {
        match case["kind"].as_str().unwrap() {
            "mode" => {
                if let Some(mark) = case["mark"].as_array() {
                    unsupported.mark(mark[0].as_str().unwrap(), &mark[1]);
                }
                let got = effort_configuration_mode(case["provider"].as_str().unwrap(), &case["model"], &case["opts"], &unsupported, &|_| None);
                assert_eq!(got.map_or(Value::Null, |m| json!(m.as_str())), case["value"], "case {i}: {} {} {}", case["provider"], case["model"], case["opts"]);
            }
            _ => {
                let got = custom_auto_effort_capable(case["provider"].as_str().unwrap(), case["protocol"].as_str().map(Value::from).as_ref(), &case["row"]);
                assert_eq!(json!(got), case["value"], "case {i}: {} {} {}", case["provider"], case["protocol"], case["row"]);
            }
        }
    }
}

#[test]
fn the_oauth_catalogs_own_answer_beats_the_version() {
    let none = UnsupportedEfforts::default();
    let model = json!("gpt-5.4");
    let mode = |declared: Option<bool>| effort_configuration_mode("openai-oauth", &model, &json!({}), &none, &move |id| {
        assert_eq!(id, "gpt-5.4");
        declared
    });
    assert_eq!(mode(Some(true)), Some(UpdateMode::Responses));
    assert_eq!(mode(Some(false)), None);
    assert_eq!(mode(None), None);
}
