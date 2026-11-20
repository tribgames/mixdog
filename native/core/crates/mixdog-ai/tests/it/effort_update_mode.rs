//! Whether a route takes an effort change in the middle of a conversation (and on which wire), and whether a custom
//! route takes a per-request effort.

use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_ai::service::effort_configuration::UpdateMode;
use mixdog_ai::service::effort_configuration::custom_auto_effort_capable;
use mixdog_ai::service::effort_configuration::effort_configuration_mode;
use mixdog_ai::service::effort_configuration::model_key;
use serde_json::Value;
use serde_json::json;

fn mode(provider: &str, model: &str, opts: Value) -> Option<UpdateMode> {
    effort_configuration_mode(provider, &json!(model), &opts, &UnsupportedEfforts::default(), &|_| None)
}

#[test]
fn a_model_key_is_trimmed_lowercase_dashed_and_without_a_trailing_date() {
    assert_eq!(model_key(&json!(" Claude-Opus-4.8-20251001 ")), "claude-opus-4-8");
    assert_eq!(model_key(&json!("GPT-6.1-2026-01-02")), "gpt-6-1");
    assert_eq!(model_key(&json!("gpt-6-20260102x")), "gpt-6-20260102x", "only a trailing date goes");
    assert_eq!(model_key(&Value::Null), "");
    assert_eq!(model_key(&json!(0)), "");
}

#[test]
fn an_openai_model_of_the_sixth_generation_on_takes_updates_on_the_responses_wire() {
    for id in ["gpt-6", "gpt-6-astra", "gpt-6.1", "gpt-10", "gpt-60", "GPT-6-2026-03-01"] {
        assert_eq!(mode("openai", id, json!({})), Some(UpdateMode::Responses), "{id}");
        assert_eq!(mode("openai-oauth", id, json!({})), Some(UpdateMode::Responses), "{id}");
    }
    for id in ["gpt-5.5", "gpt-5", "gpt-6x", "o3", "gpt-mini", ""] {
        assert_eq!(mode("openai", id, json!({})), None, "{id}");
    }
}

#[test]
fn the_oauth_catalog_answer_for_a_model_decides_over_its_version_when_it_has_one() {
    let ask =
        |declared: Option<bool>| effort_configuration_mode("openai-oauth", &json!("gpt-6"), &json!({}), &UnsupportedEfforts::default(), &move |_| declared);
    assert_eq!(ask(Some(false)), None, "the catalog says no to a model the version would allow");
    assert_eq!(ask(Some(true)), Some(UpdateMode::Responses));
    assert_eq!(ask(None), Some(UpdateMode::Responses), "no answer: the version decides");
    let key =
        |declared: &dyn Fn(&str) -> Option<bool>| effort_configuration_mode("openai", &json!("gpt-5"), &json!({}), &UnsupportedEfforts::default(), declared);
    assert_eq!(key(&|_| Some(true)), None, "only the OAuth route asks the catalog");
}

#[test]
fn a_request_can_switch_the_updates_off_and_a_thinking_budget_leaves_no_room_for_them() {
    assert_eq!(mode("openai", "gpt-6", json!({"effortConfigurationEnabled": false})), None);
    assert_eq!(mode("openai", "gpt-6", json!({"effortConfigurationEnabled": true})), Some(UpdateMode::Responses));
    assert_eq!(mode("openai", "gpt-6", json!({"thinkingBudgetTokens": 1024})), None);
    assert_eq!(mode("openai", "gpt-6", json!({"thinkingBudgetTokens": "2048"})), None, "a numeric text counts");
    assert_eq!(mode("openai", "gpt-6", json!({"thinkingBudgetTokens": 0})), Some(UpdateMode::Responses));
    assert_eq!(mode("openai", "gpt-6", json!({"thinkingBudgetTokens": "many"})), Some(UpdateMode::Responses));
}

#[test]
fn a_model_that_refused_an_update_gets_none_for_the_rest_of_the_process() {
    let unsupported = UnsupportedEfforts::default();
    unsupported.mark("openai", &json!("gpt-6-2026-01-02"));
    let ask = |provider: &str, model: &str| effort_configuration_mode(provider, &json!(model), &json!({}), &unsupported, &|_| None);
    assert_eq!(ask("openai", "gpt-6"), None, "the mark is by the undated id");
    assert_eq!(ask("openai", "GPT-6"), None);
    assert_eq!(ask("openai", "gpt-6-astra"), Some(UpdateMode::Responses), "another model is unaffected");
    assert_eq!(ask("openai-oauth", "gpt-6"), Some(UpdateMode::Responses), "another provider is unaffected");
}

#[test]
fn only_the_standard_single_agent_mode_takes_updates() {
    assert_eq!(mode("openai", "gpt-6", json!({"reasoning": {"mode": "standard"}})), Some(UpdateMode::Responses));
    assert_eq!(mode("openai", "gpt-6", json!({"reasoning": {"mode": "deep"}})), None);
    assert_eq!(mode("openai", "gpt-6", json!({"modelParameters": {"reasoning_mode": "deep"}})), None);
    assert_eq!(mode("openai", "gpt-6", json!({"modelParameters": {"mode": "deep"}})), None);
    assert_eq!(
        mode("openai", "gpt-6", json!({"reasoning": {"mode": "standard"}, "modelParameters": {"mode": "deep"}})),
        Some(UpdateMode::Responses),
        "the reasoning option is read first"
    );
    assert_eq!(mode("openai", "gpt-6", json!({"multiAgent": true})), None);
    assert_eq!(mode("openai", "gpt-6", json!({"modelParameters": {"multi_agent": true}})), None);
    assert_eq!(mode("openai", "gpt-6", json!({"multiAgent": false, "modelParameters": {"multi_agent": false}})), Some(UpdateMode::Responses));
}

#[test]
fn a_claude_model_takes_updates_from_its_familys_first_checked_version() {
    for (id, on) in [
        ("claude-opus-4-8", false),
        ("claude-opus-5", true),
        ("claude-sonnet-5-4", false),
        ("claude-sonnet-5-5", true),
        ("claude-haiku-5-5", true),
        ("claude-fable-5", false),
        ("claude-fable-5-1", true),
        ("claude-mythos-5-1", true),
        ("claude-opus-5-20260101", true),
        ("claude-3-5-sonnet", false),
    ] {
        let expected = on.then_some(UpdateMode::Anthropic);
        assert_eq!(mode("anthropic", id, json!({})), expected, "{id}");
        assert_eq!(mode("anthropic-oauth", id, json!({})), expected, "{id}");
    }
}

#[test]
fn a_family_not_measured_yet_takes_updates_from_the_fifth_generation_only_on_the_subscription() {
    assert_eq!(mode("anthropic-oauth", "claude-zeta-5", json!({})), Some(UpdateMode::Anthropic));
    assert_eq!(mode("anthropic-oauth", "claude-zeta-4-9", json!({})), None);
    assert_eq!(mode("anthropic", "claude-zeta-5", json!({})), None);
}

#[test]
fn the_anthropic_wire_is_used_only_on_the_first_party_endpoint_with_its_beta_headers() {
    assert_eq!(mode("anthropic", "claude-opus-5", json!({"baseURL": "https://api.anthropic.com"})), Some(UpdateMode::Anthropic));
    assert_eq!(mode("anthropic", "claude-opus-5", json!({"baseURL": "https://api.anthropic.com/v1"})), Some(UpdateMode::Anthropic));
    assert_eq!(mode("anthropic", "claude-opus-5", json!({"baseURL": ""})), Some(UpdateMode::Anthropic), "no endpoint named is the first party's");
    assert_eq!(mode("anthropic", "claude-opus-5", json!({"baseURL": "https://proxy.example/anthropic"})), None);
    assert_eq!(mode("anthropic", "claude-opus-5", json!({"baseURL": "https://api.anthropic.com.evil.example"})), None);
    assert_eq!(mode("anthropic", "claude-opus-5", json!({"disableBetaHeaders": true})), None);
    assert_eq!(mode("anthropic", "claude-opus-5", json!({"disableBetaHeaders": false})), Some(UpdateMode::Anthropic));
    assert_eq!(mode("gemini", "claude-opus-5", json!({})), None, "no other provider takes the Claude wire");
    assert_eq!(mode("gemini", "gpt-6", json!({})), None);
}

#[test]
fn a_custom_route_on_the_responses_wire_serving_a_sixth_generation_model_takes_the_same_update() {
    let responses = json!({"protocol": "openai-responses"});
    assert_eq!(mode("custom-acme", "gpt-6", responses.clone()), Some(UpdateMode::Responses));
    assert_eq!(mode("custom-acme", "vendor/gpt-6-fast", responses.clone()), Some(UpdateMode::Responses), "the version is read from the last path segment");
    assert_eq!(mode("custom-acme", "vendor/gpt-5", responses), None);
    assert_eq!(mode("custom-acme", "gpt-6", json!({"protocol": "openai-chat"})), None);
    assert_eq!(mode("custom-acme", "gpt-6", json!({})), None);
    assert_eq!(mode("acme", "gpt-6", json!({"protocol": "openai-responses"})), None, "only a custom provider's name");
    assert_eq!(mode("custom-acme", "gpt-6", json!({"protocol": "openai-responses", "multiAgent": true})), None);
}

#[test]
fn a_custom_route_takes_a_per_request_effort_when_its_protocol_and_row_say_so() {
    let row = json!({"reasoningLevels": ["low", "high"]});
    let ask = |provider: &str, protocol: Option<&str>, row: &Value| custom_auto_effort_capable(provider, protocol.map(Value::from).as_ref(), row);
    assert!(ask("custom-acme", Some("openai-chat"), &row));
    assert!(ask("custom-acme", Some("openai-responses"), &row));
    assert!(ask("custom-acme", Some("openai-chat"), &json!({"reasoningOptions": [{"type": "effort", "values": ["medium"]}]})));
    assert!(!ask("custom-acme", Some("anthropic-messages"), &row), "a wire that has no effort field");
    assert!(!ask("custom-acme", None, &row));
    assert!(!ask("openai", Some("openai-chat"), &row), "not a custom provider");
    assert!(!ask("custom-acme", Some("openai-chat"), &json!({"reasoningLevels": []})), "an explicitly empty list");
    assert!(!ask("custom-acme", Some("openai-chat"), &json!({"id": "m"})), "a row declaring nothing");
}
