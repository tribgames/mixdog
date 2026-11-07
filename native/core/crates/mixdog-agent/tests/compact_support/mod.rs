//! Test support: Node transcript rows (as `fixtures/agent/compact/record.mjs`
//! writes them) converted into agent messages, and back.

#![allow(dead_code)]

use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::Source;
use mixdog_agent::message::ToolKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_protocol::ProviderId;
use serde_json::Value;

/// The recorded Node output `fixtures/agent/compact/golden/<name>.json`.
#[macro_export]
macro_rules! golden {
    ($name:literal) => {
        serde_json::from_str::<serde_json::Value>(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/agent/compact/golden/",
            $name,
            ".json"
        )))
        .expect("golden json")
    };
}

/// A session with no sensitive values: redaction changes nothing.
pub struct NoRedaction;
impl mixdog_agent::compact::dropped::Redactor for NoRedaction {
    fn redact(&self, rows: Vec<Value>) -> Vec<Value> {
        rows
    }
}

/// A session with no attachments: no blob is ever read.
pub struct NoBlobs;
impl mixdog_protocol::message_class::user_text::Blobs for NoBlobs {
    fn text_within(
        &self,
        hex: &str,
        _: u64,
    ) -> Result<Option<String>, mixdog_protocol::message_class::user_text::ReadError> {
        panic!("attachment read {hex} in a golden without attachments")
    }
}

#[async_trait::async_trait]
impl mixdog_agent::compact::blob_reads::BlobReads for NoBlobs {
    async fn read_with(&self, work: mixdog_agent::compact::blob_reads::StoreWork) -> Result<(), mixdog_agent::compact::blob_reads::StoreUnavailable> {
        work(self);
        Ok(())
    }
}

pub fn replay_owner() -> ProviderId {
    ProviderId::from("golden")
}

fn source_of(name: &str) -> Option<Source> {
    Some(match name {
        "steering" => Source::Steering,
        "task-notification" => Source::TaskNotification,
        "max-output-recovery" => Source::MaxOutputRecovery,
        "stream-cut-recovery" => Source::StreamCutRecovery,
        "refusal-recovery" => Source::RefusalRecovery,
        "hook" => Source::Hook,
        "skill" => Source::Skill,
        "import" => Source::Import,
        "compact-summary" => Source::CompactSummary,
        "compact-context" => Source::CompactContext,
        "compact-active-turn-continuation" => Source::ActiveTurnContinuation,
        "compact-execution-recovery" => Source::CompactExecutionRecovery,
        "compact-execution-text" => Source::CompactExecutionText,
        "goal-continuation" => Source::GoalContinuation,
        "goal-closeout" => Source::GoalCloseout,
        "schedule-result" => Source::ScheduleResult,
        "context-ack" => Source::ContextAck,
        other => panic!("unmapped meta.source {other:?}"),
    })
}

fn content_of(value: &Value) -> Content {
    match value {
        Value::String(text) => Content::Text(text.clone()),
        Value::Array(parts) => Content::Parts(
            parts
                .iter()
                .map(|part| match part["type"].as_str() {
                    Some("text") => ContentPart::Text(part["text"].as_str().unwrap_or_default().to_owned(), None),
                    other => panic!("unsupported content part {other:?}"),
                })
                .collect(),
        ),
        other => panic!("unsupported content {other:?}"),
    }
}

/// One Node transcript row as an agent message.
pub fn node_message(row: &Value) -> AgentMessage {
    let content = content_of(&row["content"]);
    let mut message = match row["role"].as_str().expect("role") {
        "user" => AgentMessage::user_content(content),
        "assistant" => {
            let calls = row["toolCalls"]
                .as_array()
                .map(|calls| {
                    calls
                        .iter()
                        .map(|c| ToolCall {
                            id: c["id"].as_str().unwrap_or_default().to_owned(),
                            name: c["name"].as_str().unwrap_or_default().to_owned(),
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
        "tool" => AgentMessage::tool_result(
            row["toolCallId"].as_str().unwrap_or_default(),
            content,
            match row["toolKind"].as_str() {
                Some("error") => ToolKind::Error,
                Some("cache-hit") => ToolKind::CacheHit,
                Some("skipped") => ToolKind::Skipped,
                _ => ToolKind::Normal,
            },
        ),
        "system" => {
            let mut m = AgentMessage::user_content(content);
            m.message.role = Role::System;
            m
        }
        other => panic!("unsupported role {other:?}"),
    };
    if row["role"] == "tool" && row.get("toolKind").is_none() {
        message.tool_kind = None;
    }
    if let Some(items) = row.get("providerReplay").and_then(|r| r.get("items")) {
        message.message.push_replay(ProviderReplay { owner: replay_owner(), items: items.clone() });
    }
    message.message.thinking_blocks = row.get("thinkingBlocks").cloned();
    message.message.assistant_blocks = row.get("assistantBlocks").cloned();
    message.message.native_tool_search = row.get("nativeToolSearch").cloned();
    message.source = row["meta"]["source"].as_str().and_then(source_of);
    message.message_id = row["meta"]["transcript"]["messageId"].as_str().map(str::to_owned);
    message
}

fn source_name(source: Source) -> &'static str {
    match source {
        Source::Steering => "steering",
        Source::TaskNotification => "task-notification",
        Source::MaxOutputRecovery => "max-output-recovery",
        Source::StreamCutRecovery => "stream-cut-recovery",
        Source::RefusalRecovery => "refusal-recovery",
        Source::Hook => "hook",
        Source::Skill => "skill",
        Source::Import => "import",
        Source::CompactSummary => "compact-summary",
        Source::CompactContext => "compact-context",
        Source::ActiveTurnContinuation => "compact-active-turn-continuation",
        Source::CompactExecutionRecovery => "compact-execution-recovery",
        Source::CompactExecutionText => "compact-execution-text",
        Source::GoalContinuation => "goal-continuation",
        Source::GoalCloseout => "goal-closeout",
        Source::ScheduleResult => "schedule-result",
        Source::ContextAck => "context-ack",
        other => panic!("unmapped source {other:?}"),
    }
}

fn content_row(content: &Content) -> Value {
    match content {
        Content::Text(text) => Value::String(text.clone()),
        Content::Parts(parts) => Value::Array(
            parts
                .iter()
                .map(|p| match p {
                    ContentPart::Text(t, _) => serde_json::json!({"type": "text", "text": t}),
                    other => panic!("unsupported part {other:?}"),
                })
                .collect(),
        ),
    }
}

/// The stored row Node wrote for a message, in its key order. Runtime
/// reminders put `meta` ahead of `content`.
pub fn node_row(m: &AgentMessage) -> Value {
    let mut row = serde_json::Map::new();
    let role = match m.role() {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
        Role::Developer => "developer",
    };
    row.insert("role".into(), role.into());
    let meta = m.source.map(|s| {
        let mut meta = serde_json::Map::new();
        meta.insert("source".into(), source_name(s).into());
        if matches!(s, Source::CompactExecutionRecovery | Source::ActiveTurnContinuation) {
            meta.insert("synthetic".into(), true.into());
        }
        Value::Object(meta)
    });
    let meta_first = m.source == Some(Source::CompactExecutionRecovery);
    if meta_first && let Some(meta) = meta.clone() {
        row.insert("meta".into(), meta);
    }
    row.insert("content".into(), content_row(&m.message.content));
    if !m.tool_calls().is_empty() {
        let calls = m
            .tool_calls()
            .iter()
            .map(|c| serde_json::json!({"id": c.id, "name": c.name, "arguments": c.arguments}))
            .collect();
        row.insert("toolCalls".into(), Value::Array(calls));
    }
    if let Some(id) = m.tool_call_id() {
        row.insert("toolCallId".into(), id.into());
    }
    if !meta_first && let Some(meta) = meta {
        row.insert("meta".into(), meta);
    }
    Value::Object(row)
}

pub struct Rows;
impl mixdog_agent::compact::execution_tail::MessageRows for Rows {
    fn row(&self, message: &AgentMessage) -> Value {
        node_row(message)
    }
}

/// Content-addressed artifacts as Node's preview computes them; nothing is written.
pub struct PreviewArchive {
    pub session: String,
}

impl PreviewArchive {
    fn artifact(&self, content: &str) -> mixdog_agent::offload::Artifact {
        use sha2::Digest;
        let sha256: String = sha2::Sha256::digest(content.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        mixdog_agent::offload::Artifact {
            display_path: format!("<DATA>/tool-results/{}/{sha256}.txt", self.session),
            lines: content.lines().count(),
            sha256,
        }
    }
}

#[async_trait::async_trait]
impl mixdog_agent::offload::ArtifactStore for PreviewArchive {
    async fn persist(&self, content: &str) -> Option<mixdog_agent::offload::Artifact> {
        Some(self.artifact(content))
    }
    async fn preview(&self, content: &str) -> Option<mixdog_agent::offload::Artifact> {
        Some(self.artifact(content))
    }
}
pub struct NoAttachments;
#[async_trait::async_trait]
impl mixdog_agent::compact::fresh::AttachmentSeam for NoAttachments {
    async fn reference_media(&self, message: &AgentMessage) -> AgentMessage {
        message.clone()
    }
    fn has_referencable_media(&self, _: &AgentMessage) -> bool {
        false
    }
    fn attachment_tokens(&self, _: &AgentMessage) -> u64 {
        0
    }
}
