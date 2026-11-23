//! The thought signatures of a Gemini request's history. Gemini refuses a tool loop whose active turn opens a model step
//! with an unsigned call, so a history that has no real signature gets the documented bypass token on the first call of
//! each step, in every turn alike; real signatures are sent back as recorded, and a recording another model made is not.

use mixdog_ai::providers::google::request::Dialect;
use mixdog_ai::providers::google::request::build_request;
use mixdog_ai::providers::google::traits::ModelTraits;
use mixdog_ai::providers::google::traits::ThinkingControl;
use mixdog_ai::providers::google::traits::is_gemini_family_model;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

const BYPASS: &str = "skip_thought_signature_validator";

struct ByName;

impl ModelTraits for ByName {
    fn is_gemini_family(&self, model: &str) -> bool {
        is_gemini_family_model(model)
    }
    fn thinking(&self, _: &str) -> ThinkingControl {
        ThinkingControl::Unspecified
    }
}

fn dialect() -> Dialect {
    Dialect {
        owner: ProviderId::from("gemini"),
        system_role: Some("system"),
        function_ids: true,
        family_gated: false,
        default_tool_mode: None,
        omit_ignored_sampling: false,
    }
}

fn text(role: Role, text: &str) -> Message {
    Message::new(role, Content::Text(text.into()))
}

/// A model step that called `names` (ids `{name}-id`), and the results that answered it.
fn step(names: &[&str]) -> Vec<Message> {
    let mut call = text(Role::Assistant, "");
    call.tool_calls = names.iter().map(|n| ToolCall { id: format!("{n}-id"), name: (*n).into(), arguments: json!({"n": 1}), native_type: None }).collect();
    let mut out = vec![call];
    for name in names {
        let mut result = text(Role::Tool, "ok");
        result.tool_call_id = Some(format!("{name}-id"));
        out.push(result);
    }
    out
}

fn contents(model: &str, messages: Vec<Message>) -> Vec<Value> {
    let request = ModelRequest { model: model.into(), messages, tools: vec![], options: RequestOptions::default() };
    build_request(&request, &dialect(), &ByName).unwrap()["contents"].as_array().unwrap().clone()
}

/// The signature of each model call, in order, `None` where the call carries none.
fn call_signatures(contents: &[Value]) -> Vec<(String, Option<String>)> {
    contents
        .iter()
        .filter(|c| c["role"] == "model")
        .flat_map(|c| c["parts"].as_array().unwrap().iter())
        .filter(|p| p.get("functionCall").is_some())
        .map(|p| (p["functionCall"]["name"].as_str().unwrap().to_owned(), p.get("thoughtSignature").and_then(Value::as_str).map(str::to_owned)))
        .collect()
}

fn sentinel(name: &str) -> (String, Option<String>) {
    (name.to_owned(), Some(BYPASS.to_owned()))
}

fn unsigned(name: &str) -> (String, Option<String>) {
    (name.to_owned(), None)
}

#[test]
fn the_first_unsigned_call_of_a_step_in_the_active_turn_gets_the_bypass_token_and_its_siblings_do_not() {
    let mut messages = vec![text(Role::User, "do it")];
    messages.extend(step(&["read", "grep"]));
    let signatures = call_signatures(&contents("gemini-3-pro", messages));
    assert_eq!(signatures, [sentinel("read"), unsigned("grep")]);
}

#[test]
fn every_step_of_a_sequential_tool_loop_is_signed() {
    let mut messages = vec![text(Role::User, "do it")];
    messages.extend(step(&["read"]));
    messages.extend(step(&["edit"]));
    let signatures = call_signatures(&contents("gemini-3-pro", messages));
    assert_eq!(signatures, [sentinel("read"), sentinel("edit")]);
}

/// A step is sent as the same bytes by every request that carries it: the turn that follows it does not take the token
/// back, which would rewrite a row the provider's prefix cache already holds.
#[test]
fn a_step_keeps_its_bytes_when_a_later_turn_follows_it() {
    let mut messages = vec![text(Role::User, "first")];
    messages.extend(step(&["old"]));
    let within = contents("gemini-3-pro", messages.clone());
    messages.push(text(Role::Assistant, "done"));
    messages.push(text(Role::User, "second"));
    let after = contents("gemini-3-pro", messages.clone());
    assert_eq!(after[..within.len()], within[..], "the next turn's request starts with the rows the last one sent");
    messages.extend(step(&["new"]));
    let later = contents("gemini-3-pro", messages);
    assert_eq!(later[..after.len()], after[..]);
    assert_eq!(call_signatures(&later), [sentinel("old"), sentinel("new")]);
}

#[test]
fn a_model_outside_the_gemini_family_behind_the_same_endpoint_gets_no_made_up_signature() {
    let mut messages = vec![text(Role::User, "do it")];
    messages.extend(step(&["read"]));
    assert_eq!(call_signatures(&contents("gpt-oss-120b", messages)), [unsigned("read")]);
}

#[test]
fn a_signature_the_model_really_gave_is_sent_back_and_one_another_model_gave_is_not() {
    let recorded = |model: &str, owner: &str| {
        let mut call = text(Role::Assistant, "");
        call.tool_calls = vec![ToolCall { id: "read-id".into(), name: "read".into(), arguments: json!({"n": 1}), native_type: None }];
        call.push_replay(ProviderReplay {
            owner: ProviderId::from(owner),
            items: json!({
                "model": model,
                "parts": [
                    {"text": "thinking", "thought": true, "thoughtSignature": "sig-thought"},
                    {"functionCall": {"name": "read", "args": {"n": 1}, "id": "read-id"}, "thoughtSignature": "sig-real"},
                ],
            }),
        });
        let mut result = text(Role::Tool, "ok");
        result.tool_call_id = Some("read-id".into());
        vec![text(Role::User, "do it"), call, result]
    };
    let own = contents("gemini-3-pro", recorded("gemini-3-pro", "gemini"));
    assert_eq!(call_signatures(&own), [("read".to_owned(), Some("sig-real".to_owned()))], "kept as recorded");
    assert_eq!(own[1]["parts"][0]["thoughtSignature"], "sig-thought");

    // The Gemini API binds a signature to its model: another Gemini model's recording is not replayed.
    let other_model = contents("gemini-3-pro", recorded("gemini-2.5-pro", "gemini"));
    assert_eq!(call_signatures(&other_model), [sentinel("read")]);
    assert!(other_model[1]["parts"].as_array().unwrap().iter().all(|p| p.get("thought").is_none()), "its thoughts are not replayed either");

    // A recording made by a model outside the family never reaches the request.
    let foreign = contents("gemini-3-pro", recorded("gpt-oss-120b", "gemini"));
    assert_eq!(call_signatures(&foreign), [sentinel("read")]);
}

#[test]
fn a_call_id_of_any_shape_is_paired_with_its_result() {
    let mut messages = vec![text(Role::User, "do it")];
    let mut call = text(Role::Assistant, "");
    call.tool_calls = vec![ToolCall { id: "weird id/42".into(), name: "read".into(), arguments: json!({}), native_type: None }];
    let mut result = text(Role::Tool, "ok");
    result.tool_call_id = Some("weird id/42".into());
    messages.extend([call, result]);
    let sent = contents("gemini-3-pro", messages);
    assert_eq!(sent[1]["parts"][0]["functionCall"]["id"], "weird id/42");
    assert_eq!(sent[2]["parts"][0]["functionResponse"], json!({"name": "read", "response": {"result": "ok"}, "id": "weird id/42"}));
}
