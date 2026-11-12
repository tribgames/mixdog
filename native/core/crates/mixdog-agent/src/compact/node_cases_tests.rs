//! Replays `fixtures/compact-node-cases/golden.json` (`benchmarks/rust-core/recorders/record-compact-node-cases.mjs`):
//! what Node's compaction helpers answered for the inputs of their unit tests (execution-tail :21,
//! observation-supersession, summary-mode :157, summary-prompt, summary-schema, text-utils, arg-schema-coerce).

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_protocol::ProviderId;
use serde_json::Value;

use super::estimate::MediaMeter;
use super::estimate::MessageMeter;
use super::estimate::PartMeter;
use super::observation::stale_observations;
use super::observation::supersede_observation;
use super::redact::redact_tool_call_secrets;
use super::settings::normalize_compaction;
use super::summary::fit_complete_compaction_prompt;
use super::summary_run::SummaryMode;
use super::summary_schema::repair_compact_summary;
use super::summary_schema::summary_is_schema_valid;
use crate::message::AgentMessage;
use crate::message::Source;
use crate::message::ToolKind;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/compact-node-cases/golden.json")).unwrap()
}

fn part_of(part: &Value) -> ContentPart {
    match part["type"].as_str() {
        Some("text") => ContentPart::Text(part["text"].as_str().unwrap().to_owned(), None),
        Some("image") => ContentPart::Image(ImageSource::Base64 {
            data: part["data"].as_str().unwrap_or_default().to_owned(),
            mime_type: part["mimeType"].as_str().unwrap_or_default().to_owned(),
            width: None,
            height: None,
        }),
        other => panic!("unsupported part {other:?}"),
    }
}

/// Node content: a string, an array of parts, or a tool result's `{content: [parts]}`; the last two are parts.
fn content_of(value: &Value) -> Content {
    match value {
        Value::String(text) => Content::Text(text.clone()),
        Value::Array(parts) => Content::Parts(parts.iter().map(part_of).collect()),
        Value::Object(wrapped) => Content::Parts(wrapped["content"].as_array().unwrap().iter().map(part_of).collect()),
        other => panic!("unsupported content {other:?}"),
    }
}

/// Rust content in the shape the Node input had (`{content: [...]}` stays wrapped).
fn node_content(content: &Content, input: &Value) -> Value {
    match content {
        Content::Text(text) => Value::String(text.clone()),
        Content::Parts(parts) => {
            let parts: Vec<Value> = parts
                .iter()
                .map(|part| match part {
                    ContentPart::Text(text, None) => serde_json::json!({"type": "text", "text": text}),
                    other => panic!("unexpected part in a superseded result: {other:?}"),
                })
                .collect();
            if input.is_object() { serde_json::json!({"content": parts}) } else { Value::Array(parts) }
        }
    }
}

fn message_of(row: &Value) -> AgentMessage {
    let content = content_of(&row["content"]);
    let mut message = match row["role"].as_str() {
        Some("user") => AgentMessage::user_content(content),
        Some("tool") => AgentMessage::tool_result(
            row["toolCallId"].as_str().unwrap(),
            content,
            if row["toolKind"] == "error" { ToolKind::Error } else { ToolKind::Normal },
        ),
        // A row without a role (summary-schema.test.mjs:21) is not a user turn either.
        Some("assistant") | None => {
            let calls = row["toolCalls"]
                .as_array()
                .map(|calls| {
                    calls
                        .iter()
                        .map(|c| ToolCall {
                            id: c["id"].as_str().unwrap().to_owned(),
                            name: c["name"].as_str().unwrap().to_owned(),
                            arguments: c["arguments"].clone(),
                            native_type: None,
                        })
                        .collect()
                })
                .unwrap_or_default();
            let mut m = AgentMessage::assistant(String::new(), calls);
            m.message.content = content;
            m
        }
        other => panic!("unsupported role {other:?}"),
    };
    if row["meta"]["source"] == "task-notification" {
        message.source = Some(Source::TaskNotification);
    }
    message
}

fn stale_flags(messages: &[AgentMessage]) -> Vec<bool> {
    let stale = stale_observations(messages);
    (0..messages.len()).map(|index| stale.contains_key(&index)).collect()
}

#[test]
fn tagged_completions_are_neither_instructions_nor_conversation_as_in_node() {
    for case in golden()["instruction"].as_array().unwrap() {
        let message = message_of(&case["message"]);
        assert_eq!(
            Value::Bool(crate::project::is_actual_user_instruction(&message)),
            case["actualUserInstruction"],
            "{case}"
        );
        // The ingest projection is replayed through the memory ingest (`mixdog-services` `ingest_shape_node_cases_tests.rs`).
    }
}

#[test]
fn stale_and_superseded_observations_equal_node() {
    for scenario in golden()["observation"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let rows = scenario["messages"].as_array().unwrap();
        let messages: Vec<AgentMessage> = rows.iter().map(message_of).collect();
        let flags: Vec<Value> = stale_flags(&messages).into_iter().map(Value::Bool).collect();
        assert_eq!(Value::Array(flags), scenario["stale"], "{name}");
        let stale = stale_observations(&messages);
        let mut superseded = Vec::new();
        for index in 0..messages.len() {
            let Some(found) = stale.get(&index) else { continue };
            let replaced = supersede_observation(&messages[index], found, scenario["origin"].as_str().unwrap());
            let content = node_content(&replaced.message.content, &rows[index]["content"]);
            let mut after = messages.clone();
            after[index] = replaced;
            let after: Vec<Value> = stale_flags(&after).into_iter().map(Value::Bool).collect();
            superseded.push(serde_json::json!({"index": index, "content": content, "after": after}));
        }
        assert_eq!(Value::Array(superseded), scenario["superseded"], "{name}");
    }
}

#[test]
fn the_summary_mode_normalizes_as_in_node() {
    for case in golden()["summaryMode"].as_array().unwrap() {
        let compaction = &case["compaction"];
        let mode = SummaryMode::normalize(compaction["summaryMode"].as_str(), compaction["useMaintainer"].as_bool());
        let name = match mode {
            SummaryMode::Smart => "smart",
            SummaryMode::Maintainer => "maintainer",
            SummaryMode::Session => "self",
        };
        assert_eq!(name, case["mode"], "{case}");
        let saved = (!compaction.is_null()).then_some(compaction);
        assert_eq!(normalize_compaction(saved)["summaryMode"], case["mode"], "{case}");
    }
}

struct TextOnly;
impl MediaMeter for TextOnly {
    fn part(&self, part: &ContentPart) -> PartMeter {
        panic!("media part in a text-only case: {part:?}")
    }
}

#[test]
fn the_summarizer_prompt_equals_node() {
    let golden = golden();
    let case = &golden["summaryPrompt"];
    let owner = ProviderId::from("golden");
    let meter = MessageMeter { media: &TextOnly, replay_owner: &owner };
    let head: Vec<AgentMessage> = case["head"].as_array().unwrap().iter().map(message_of).collect();
    let prompt = fit_complete_compaction_prompt(&meter, &head, None, case["target"].as_u64().unwrap());
    assert_eq!(prompt.as_deref(), case["prompt"].as_str());
}

#[test]
fn the_summary_schema_repair_equals_node() {
    for case in golden()["schemaCases"].as_array().unwrap() {
        let head: Vec<AgentMessage> = case["head"].as_array().unwrap().iter().map(message_of).collect();
        let repaired = repair_compact_summary(case["summary"].as_str().unwrap(), &head, &[]);
        assert_eq!(repaired, case["repaired"].as_str().unwrap());
        assert_eq!(Value::Bool(summary_is_schema_valid(&repaired)), case["schemaValid"]);
    }
}

#[test]
fn tool_call_secrets_are_redacted_as_in_node() {
    for case in golden()["redaction"].as_array().unwrap() {
        let input = AgentMessage::assistant(
            String::new(),
            vec![ToolCall { id: "call".into(), name: "read".into(), arguments: case["input"].clone(), native_type: None }],
        );
        let [redacted] = <[AgentMessage; 1]>::try_from(redact_tool_call_secrets(std::slice::from_ref(&input))).unwrap();
        assert_eq!(redacted.tool_calls()[0].arguments, case["output"], "{case}");
        // Node hands back the same message object when nothing changed; here that is an unchanged message.
        assert_eq!(Value::Bool(redacted == input), case["sameMessage"], "{case}");
    }
}

#[test]
fn arguments_are_coerced_to_the_schema_as_in_node() {
    // The session-tool cases go through the call executor (`tools_coerce_session_tests.rs`).
    for case in golden()["coerce"].as_array().unwrap().iter().filter(|c| !c["name"].as_str().unwrap().starts_with("session tool ")) {
        let mut args = case["args"].clone();
        crate::coerce::coerce_args_to_schema(&mut args, &case["schema"]);
        assert_eq!(args, case["coerced"], "{}", case["name"]);
    }
}
