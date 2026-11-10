//! Mid-conversation effort updates against the Node recording
//! (`providers/anthropic-effort/cases.json`, recorded by
//! `benchmarks/rust-core/recorders/record-anthropic-effort.mjs` from Node's
//! own request builders): the gate decision, the lowered messages with their
//! control messages, and the beta.

use std::collections::BTreeMap;
use std::collections::HashSet;
use std::path::PathBuf;

use std::sync::Arc;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::EffortProjection;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

use super::AnthropicCodec;
use super::AnthropicConfig;
use super::Flavor;
use super::ModelCaps;
use super::effort_updates::BETA;
use super::effort_updates::Gate;
use super::effort_updates::enabled;
use super::effort_updates::lower_with_updates;
use super::effort_updates::model_key;
use super::lowering::LowerContext;

#[allow(clippy::disallowed_methods, reason = "test-only read of a checked-in fixture file")]
fn cases() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/providers/anthropic-effort/cases.json");
    let text = std::fs::read_to_string(path).expect("recorded cases");
    let document: Value = serde_json::from_str(&text).expect("json");
    document["cases"].as_array().expect("cases").clone()
}

pub(super) fn message_of(recorded: &Value) -> Message {
    let role = match recorded["role"].as_str().expect("role") {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        other => panic!("{other}"),
    };
    let mut message = Message::new(role, Content::Text(recorded["content"].as_str().expect("content").into()));
    for call in recorded["toolCalls"].as_array().into_iter().flatten() {
        message.tool_calls.push(ToolCall {
            id: call["id"].as_str().expect("id").into(),
            name: call["name"].as_str().expect("name").into(),
            arguments: call["arguments"].clone(),
            native_type: None,
        });
    }
    message.tool_call_id = recorded["toolCallId"].as_str().map(str::to_owned);
    message
}

/// Where each effort change lands, from the session snapshots carried by the
/// recorded messages (the session's job; reproduced here to drive the lowering).
fn updates_of(case: &Value) -> BTreeMap<usize, String> {
    let history = case["history"].as_array().expect("history");
    let snapshot = |m: &Value| m["meta"]["effortConfiguration"].clone();
    let marked: Vec<(usize, Value)> = history
        .iter()
        .enumerate()
        .filter(|(_, m)| matches!(m["role"].as_str(), Some("user" | "tool")) && !snapshot(m).is_null())
        .map(|(i, m)| (i, snapshot(m)))
        .collect();
    let seed = marked
        .first()
        .map(|(_, s)| s.clone())
        .unwrap_or_else(|| case["options"]["effortConfiguration"].clone());
    let mut current = seed["initialEffort"].as_str().expect("initial").to_owned();
    let mut updates = BTreeMap::new();
    for (index, value) in &marked {
        let effort = value["effort"].as_str().expect("effort");
        if effort != current {
            updates.insert(*index, effort.to_owned());
            current = effort.to_owned();
        }
    }
    if marked.is_empty() && seed["effort"].as_str() != Some(current.as_str()) {
        let last_user = history.iter().rposition(|m| m["role"] == "user").expect("a user message");
        updates.insert(last_user, seed["effort"].as_str().expect("effort").to_owned());
    }
    updates
}

fn gate_of(options: &Value) -> Gate {
    let official = |url: &str| url == "https://api.anthropic.com" || url.starts_with("https://api.anthropic.com/");
    Gate {
        official_url: options["baseURL"].as_str().is_none_or(official),
        manual_budget: options["thinkingBudgetTokens"].as_f64().is_some_and(|v| v > 0.0),
        enabled: options["effortConfigurationEnabled"] != json!(false),
        beta_headers: options["disableBetaHeaders"] != json!(true),
    }
}

fn without_cache_control(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.shift_remove("cache_control");
            map.values_mut().for_each(without_cache_control);
        }
        Value::Array(items) => items.iter_mut().for_each(without_cache_control),
        _ => {}
    }
}

#[test]
fn the_gate_matches_node_on_every_recorded_case() {
    let cases = cases();
    assert!(cases.len() >= 50);
    for case in cases.iter().filter(|c| c["noProjection"] != true) {
        let id = case["id"].as_str().expect("id");
        let on = enabled(
            case["route"].as_str().expect("route"),
            case["model"].as_str().expect("model"),
            &gate_of(&case["options"]),
        );
        assert_eq!(on, case["mode"] == "anthropic", "{id}");
        if let Some(expected) = case.get("expected") {
            assert_eq!(expected["midConversation"], on, "{id}: the beta is sent exactly when updates are on");
            if !on {
                assert!(expected["controlEfforts"].as_array().expect("controls").is_empty(), "{id}");
            }
        }
    }
}

#[test]
fn lowered_messages_equal_the_recorded_request_messages() {
    let owner = ProviderId::from("anthropic");
    let available: HashSet<String> = ["lookup".to_owned()].into();
    let mut checked = 0;
    for case in cases() {
        let id = case["id"].as_str().expect("id").to_owned();
        let Some(expected) = case
            .get("expected")
            .filter(|_| case["mode"] == "anthropic" && case["noProjection"] != true)
        else {
            continue;
        };
        let messages: Vec<Message> = case["history"].as_array().expect("history").iter().map(message_of).collect();
        let cx = LowerContext {
            owner: &owner,
            own_provider: case["route"].as_str().expect("route"),
            available_tools: &available,
        };
        let updates = updates_of(&case);
        let lowered = lower_with_updates(&messages, &updates, &cx);
        let mut actual = Value::Array(lowered.iter().map(|m| m.to_json()).collect());
        let mut recorded = expected["messages"].clone();
        without_cache_control(&mut actual);
        without_cache_control(&mut recorded);
        assert_eq!(actual, recorded, "{id}");
        let controls: Vec<&str> = lowered
            .iter()
            .filter_map(|m| m.output_config.as_ref())
            .map(|c| c["effort"].as_str().expect("effort"))
            .collect();
        let want: Vec<&str> = expected["controlEfforts"]
            .as_array()
            .expect("controls")
            .iter()
            .map(|e| e.as_str().expect("effort"))
            .collect();
        assert_eq!(controls, want, "{id}");
        checked += 1;
    }
    assert!(checked >= 30, "{checked} cases lowered");
}

/// The model's capabilities as the recorded body shows Node saw them (catalog
/// data, an input of the codec): adaptive thinking, effort levels, display.
pub(super) fn caps_of(body: &Value) -> Option<ModelCaps> {
    let adaptive = body["thinking"]["type"] == "adaptive";
    let effort = !body["output_config"].is_null();
    (adaptive || effort).then(|| ModelCaps {
        adaptive_thinking: adaptive,
        manual_thinking: false,
        ladder_stated: false,
        effort_levels: ["low", "medium", "high", "max"].map(str::to_owned).to_vec(),
        max_output_tokens: body["max_tokens"].as_u64().map(|v| v as u32),
        fast_mode: false,
        context_window: None,
        thinking_display_updates: body["thinking"]["display"] == "updates",
    })
}

pub(super) fn tool_of(recorded: &Value) -> ToolDefinition {
    ToolDefinition {
        name: recorded["name"].as_str().expect("name").into(),
        description: recorded["description"].as_str().expect("description").into(),
        input_schema: recorded["inputSchema"].clone(),
        defer_loading: recorded["deferLoading"] == true,
        freeform: None,
    }
}

/// The whole encode path on every recorded case (all of them, both routes):
/// the complete body Node built and the complete `anthropic-beta` header, with
/// the static headers of the route; a refusal Node recorded is a refusal here.
#[test]
fn encoding_matches_the_recorded_request_for_every_case() {
    let mut checked = 0;
    for case in cases() {
        let id = case["id"].as_str().expect("id").to_owned();
        let flavor = if case["route"] == "anthropic-oauth" { Flavor::OAuth } else { Flavor::ApiKey };
        let base_url = case["options"]["baseURL"].as_str().unwrap_or("https://api.anthropic.com").to_owned();
        let history = case["history"].as_array().expect("history");
        let projection = (case["noProjection"] != true).then(|| {
            let initial = history
                .iter()
                .find_map(|m| m["meta"]["effortConfiguration"]["initialEffort"].as_str())
                .or_else(|| case["options"]["effortConfiguration"]["initialEffort"].as_str())
                .expect("initial effort");
            EffortProjection { initial_effort: initial.into(), updates: updates_of(&case) }
        });
        let mut parameters = serde_json::Map::new();
        for key in ["thinkingBudgetTokens", "effortConfigurationEnabled"] {
            if !case["options"][key].is_null() {
                parameters.insert(key.to_owned(), case["options"][key].clone());
            }
        }
        let caps = match case.get("expected") {
            Some(expected) => caps_of(&expected["body"]),
            None => Some(ModelCaps { adaptive_thinking: true, ..ModelCaps::default() }),
        };
        let mut config = AnthropicConfig::new(Arc::new(move |_: &str| caps.clone()));
        config.base_url = base_url;
        config.disable_beta_headers = case["options"]["disableBetaHeaders"] == true;
        let codec = AnthropicCodec::new(flavor, config);
        let request = ModelRequest {
            model: case["model"].as_str().expect("model").into(),
            messages: history.iter().map(message_of).collect(),
            tools: case["tools"].as_array().expect("tools").iter().map(tool_of).collect(),
            options: RequestOptions {
                effort: Some("low".into()),
                effort_projection: projection,
                model_parameters: (!parameters.is_empty()).then(|| Value::Object(parameters)),
                ..RequestOptions::default()
            },
        };
        let encoded = codec.encode(&request);
        let Some(expected) = case.get("expected") else {
            assert!(encoded.is_err(), "{id}: Node refused this request: {}", case["error"]);
            checked += 1;
            continue;
        };
        let wire = encoded.unwrap_or_else(|e| panic!("{id}: {}", e.message));
        let body: Value = serde_json::from_slice(&wire.body).expect("json");
        assert_eq!(body, expected["body"], "{id}: body");
        let header = |name: &str| wire.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str());
        // `betaHeader` is the header Node sends; null means none is sent.
        assert_eq!(header("anthropic-beta"), expected["betaHeader"].as_str(), "{id}: anthropic-beta");
        assert_eq!(header("anthropic-version"), Some("2023-06-01"), "{id}");
        assert_eq!(header("content-type"), Some("application/json"), "{id}");
        assert_eq!(header("x-app").is_some(), flavor == Flavor::OAuth, "{id}");
        checked += 1;
    }
    assert_eq!(checked, cases().len());
    assert!(checked >= 57, "{checked}");
}

#[test]
fn the_beta_name_is_the_recorded_one() {
    let recorded = cases()
        .iter()
        .find_map(|c| c.get("expected").filter(|e| e["midConversation"] == true).cloned())
        .expect("a case with updates");
    assert!(recorded["betas"].as_array().expect("betas").iter().any(|b| b == BETA));
}

#[test]
fn model_keys_drop_dates_and_dots() {
    assert_eq!(model_key(" Claude-Sonnet-5.5 "), "claude-sonnet-5-5");
    assert_eq!(model_key("claude-sonnet-5-5-20260101"), "claude-sonnet-5-5");
    assert_eq!(model_key("claude-sonnet-5-5-2026-01-01"), "claude-sonnet-5-5");
}
