//! What the side-question store keeps of a send and what a cache warm replays of it, against
//! `fixtures/warm-request/golden.json` (recorded from the real `sideQuestionRequestSnapshot` and
//! `cacheWarmSend`): the kept request has the messages BEFORE the tail reminder and the tools it
//! was sent with, and the warm is those messages plus the reminder of the moment, the tools (none
//! when empty) and the output capped at one token.
//! Fixture loading reads files synchronously; tests are not lane code.
#![allow(clippy::disallowed_methods)]

use mixdog_agent::env::TailReminder;
use mixdog_agent::tail_rules::RuleTailReminder;
use mixdog_agent::tail_rules::TailContext;
use mixdog_agent::tail_rules::TailLanguage;
use mixdog_agent::tail_rules::TailRole;
use mixdog_agent::with_tail_reminder;
use mixdog_agent::without_tail_reminder;
use mixdog_agent::wire_request;
use mixdog_core_api::domain::cache_warm::cache_warm_request;
use mixdog_core_api::domain::provider::{Content, Message, MessageSource, RequestOptions, Role, ToolDefinition};
use mixdog_protocol::JsonValue;

fn message(spec: &JsonValue) -> Message {
    let role = match spec["role"].as_str().unwrap() {
        "system" => Role::System,
        "assistant" => Role::Assistant,
        _ => Role::User,
    };
    Message::new(role, Content::Text(spec["content"].as_str().unwrap().to_owned()))
}

fn tool(name: &JsonValue) -> ToolDefinition {
    ToolDefinition {
        name: name.as_str().unwrap().to_owned(),
        description: "d".to_owned(),
        input_schema: serde_json::json!({"type": "object"}),
        defer_loading: false,
    }
}

fn text_of(message: &Message) -> String {
    match &message.content {
        Content::Text(text) => text.clone(),
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_kept_request_and_the_warm_are_the_ones_node_builds() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/warm-request/golden.json");
    let golden: JsonValue = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut reminders = 0;
    for case in golden["cases"].as_array().unwrap() {
        let model = case["model"].as_str().unwrap();
        let ctx = format!("{} {model} {} {} tools={}", case["provider"], case["role"], case["language"], case["tools"]);
        let role = match case["role"].as_str().unwrap() {
            "lead" => TailRole::Lead,
            "bot" => TailRole::Bot,
            _ => TailRole::Worker,
        };
        let language = match case["language"].as_str().unwrap() {
            "ko" => Some(TailLanguage { id: "ko".into(), name: "한국어".into() }),
            "en" => Some(TailLanguage { id: "en".into(), name: "English".into() }),
            _ => None,
        };
        let rules = RuleTailReminder { context: TailContext { provider: case["provider"].as_str().unwrap().to_owned(), language, role } };
        let messages: Vec<Message> = case["messages"].as_array().unwrap().iter().map(message).collect();
        let tools: Vec<ToolDefinition> = case["tools"].as_array().unwrap().iter().map(tool).collect();

        // What the loop sends carries the reminder; what the store keeps does not.
        let sent = wire_request(model, RequestOptions::default(), messages.clone(), rules.text(model).as_deref(), tools.clone());
        let kept = without_tail_reminder(&sent);
        assert_eq!(kept.messages, messages, "{ctx}: the kept messages are the ones before the reminder");
        assert_eq!(kept.messages.len(), case["saved"]["messages"].as_array().unwrap().len(), "{ctx}: kept count");
        assert_eq!(kept.tools.len(), case["saved"]["tools"].as_array().unwrap().len(), "{ctx}: kept tools");

        // The warm: the kept messages plus the reminder of its moment, the one-token cap.
        let warm = cache_warm_request(&with_tail_reminder(&kept, rules.text(model).as_deref()));
        let want = case["warm"]["messages"].as_array().unwrap();
        assert_eq!(warm.messages.len(), want.len(), "{ctx}: warm messages");
        for (got, want) in warm.messages.iter().zip(want) {
            assert_eq!(text_of(got), want["content"].as_str().unwrap(), "{ctx}: content");
            let source = (got.source == Some(MessageSource::TailReminder)).then_some("tail-reminder");
            assert_eq!(source, want["source"].as_str(), "{ctx}: source");
        }
        reminders += usize::from(want.len() > messages.len());
        assert_eq!(warm.model, case["warm"]["model"].as_str().unwrap(), "{ctx}: model");
        // Node sends `tools` as undefined when there are none: an empty list is the same request.
        assert_eq!(warm.tools.is_empty(), case["warm"]["tools"].is_null(), "{ctx}: tools");
        assert_eq!(warm.tools.len(), case["warm"]["tools"].as_array().map_or(0, Vec::len), "{ctx}: tool count");
        assert_eq!(warm.options.max_output_tokens_override, case["warm"]["maxOutputTokensOverride"].as_u64().map(|n| n as u32), "{ctx}: cap");
    }
    assert!(reminders > 0, "the golden covers a warm that gets a reminder");
}
