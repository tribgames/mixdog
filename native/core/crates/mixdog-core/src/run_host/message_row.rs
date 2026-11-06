//! The stored Node-shaped row of a model message (FORMAT.md §5.2 `item.body`) and the agent's
//! typed message, both ways.
//!
//! Reading keeps the row it came from (`AgentMessage::stored`). Writing a message that has one
//! starts from that row and writes over it only what the run changed against what the row itself
//! parses to, so a message nobody touched is written back byte for byte, key order included, and
//! what the typed fields do not hold (timings, usage counters, a replay envelope's account, a
//! call's thought signature, an image reference's size) is never dropped. A message without a
//! stored row is written in Node's key order for its role.
//!
//! The typed fields: role, text/file/image-reference content (and a tool result's `{content}`
//! envelope), `toolCalls`, `toolCallId`, `isError`, `toolKind`, `stopReason`, `turnReminder`,
//! `cacheTier`, `providerReplay`, `providerMetadata`, `nativeToolSearch`, `thinkingBlocks`,
//! `assistantBlocks`, `uiDiff`, and from `meta`: `source` (a string `meta` is a bare source),
//! `attempt`, `submissionIds`, `transcript.messageId`, `effortConfiguration`.

use std::sync::Arc;

use mixdog_agent::effort::{EffortMode, EffortSnapshot};
use mixdog_agent::message::{AgentMessage, Source, ToolKind};
use mixdog_core_api::domain::provider::{
    BinarySource, CacheTier, Content, ContentPart, ImageSource, ProviderReplay, Role, StopReason, TextAttachment, ToolCall,
};
use mixdog_protocol::ProviderId;
use serde_json::{json, Map, Value};

type Row = Map<String, Value>;

const SOURCES: [(&str, Source); 27] = [
    ("steering", Source::Steering),
    ("task-notification", Source::TaskNotification),
    ("turn-limit", Source::TurnLimit),
    ("max-output-recovery", Source::MaxOutputRecovery),
    ("stream-cut-recovery", Source::StreamCutRecovery),
    ("refusal-recovery", Source::RefusalRecovery),
    ("content-filter-recovery", Source::ContentFilterRecovery),
    ("hook", Source::Hook),
    ("skill", Source::Skill),
    ("import", Source::Import),
    ("compact-summary", Source::CompactSummary),
    ("compact-context", Source::CompactContext),
    ("compact-active-turn-continuation", Source::ActiveTurnContinuation),
    ("compact-execution-recovery", Source::CompactExecutionRecovery),
    ("compact-skill-window", Source::CompactSkillWindow),
    ("compact-skill-reload", Source::CompactSkillReload),
    ("compact-skill-restore", Source::CompactSkillRestore),
    ("skill-context", Source::SkillContext),
    ("skill-selection", Source::SkillSelection),
    ("skill-update-notice", Source::SkillUpdateNotice),
    ("held-request", Source::HeldRequest),
    ("agent-room", Source::AgentRoom),
    ("compact-execution-text", Source::CompactExecutionText),
    ("goal-continuation", Source::GoalContinuation),
    ("goal-closeout", Source::GoalCloseout),
    ("schedule-result", Source::ScheduleResult),
    ("context-ack", Source::ContextAck),
];

fn source_of(name: &str) -> Option<Source> {
    SOURCES.iter().find(|(n, _)| *n == name).map(|(_, s)| *s)
}

fn source_name(source: Source) -> &'static str {
    SOURCES.iter().find(|(_, s)| *s == source).map_or("", |(n, _)| n)
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
        Role::Developer => "developer",
    }
}

fn role_of(name: &str) -> Option<Role> {
    Some(match name {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        "developer" => Role::Developer,
        _ => return None,
    })
}

/// Node's `stopReason` spelling.
fn stop_name(stop: &StopReason) -> String {
    match stop {
        StopReason::EndTurn => "end_turn".to_owned(),
        StopReason::ToolUse => "tool_use".to_owned(),
        StopReason::MaxTokens => "max_tokens".to_owned(),
        StopReason::StopSequence => "stop_sequence".to_owned(),
        StopReason::ContentFilter => "content_filter".to_owned(),
        StopReason::Refusal => "refusal".to_owned(),
        StopReason::ContinueTurn => "end_turn_false".to_owned(),
        StopReason::Other(value) => value.clone(),
    }
}

fn stop_of(name: &str) -> StopReason {
    match name {
        "end_turn" => StopReason::EndTurn,
        "tool_use" => StopReason::ToolUse,
        "max_tokens" => StopReason::MaxTokens,
        "stop_sequence" => StopReason::StopSequence,
        "content_filter" => StopReason::ContentFilter,
        "refusal" => StopReason::Refusal,
        "end_turn_false" => StopReason::ContinueTurn,
        other => StopReason::Other(other.to_owned()),
    }
}

fn kind_name(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::Normal => "normal",
        ToolKind::CacheHit => "cache-hit",
        ToolKind::Error => "error",
        ToolKind::Skipped => "skipped",
    }
}

fn kind_of(name: &str) -> Option<ToolKind> {
    Some(match name {
        "normal" => ToolKind::Normal,
        "cache-hit" => ToolKind::CacheHit,
        "error" => ToolKind::Error,
        "skipped" => ToolKind::Skipped,
        _ => return None,
    })
}

fn str_of<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

// ---- content ---------------------------------------------------------------------------------------

fn part_of(part: &Value) -> Result<ContentPart, String> {
    let text = |key: &str| str_of(part, key).map(str::to_owned);
    let kind = str_of(part, "type").unwrap_or_default();
    match kind {
        "text" => match text("text") {
            Some(body) => Ok(ContentPart::Text(body, part.get("attachmentReference").and_then(Value::as_object).cloned())),
            None => match text("attachmentRef") {
                Some(reference) => Ok(ContentPart::File {
                    source: BinarySource::AttachmentRef(reference),
                    mime_type: "text/plain".to_owned(),
                    filename: text("filename"),
                    text: Some(TextAttachment { kind: text("textKind") }),
                }),
                None => Err("a text part with neither text nor attachmentRef".to_owned()),
            },
        },
        "image" | "file" => {
            let mime_type = text("mimeType").or_else(|| text("mediaType")).unwrap_or_default();
            match (text("data"), text("attachmentRef"), text("url"), kind) {
                (Some(data), _, _, "image") => Ok(ContentPart::Image(ImageSource::Base64 { data, mime_type })),
                (None, None, Some(url), "image") => Ok(ContentPart::Image(ImageSource::Url(url))),
                (Some(data), _, _, _) => Ok(ContentPart::File { source: BinarySource::Base64(data), mime_type, filename: text("filename"), text: None }),
                (None, Some(reference), _, _) => Ok(ContentPart::File { source: BinarySource::AttachmentRef(reference), mime_type, filename: text("filename"), text: None }),
                _ => Err(format!("a {kind} part with no data, attachmentRef or url")),
            }
        }
        other => Err(format!("a content part of type {other:?}")),
    }
}

fn content_of(content: Option<&Value>) -> Result<Content, String> {
    match content {
        Some(Value::String(text)) => Ok(Content::Text(text.clone())),
        None | Some(Value::Null) => Ok(Content::Text(String::new())),
        Some(Value::Array(parts)) => Ok(Content::Parts(parts.iter().map(part_of).collect::<Result<_, _>>()?)),
        // A tool result's envelope: `{content: [parts]}`.
        Some(Value::Object(envelope)) if envelope.get("content").is_some_and(Value::is_array) => content_of(envelope.get("content")),
        Some(other) => Err(format!("content of shape {other}")),
    }
}

fn part_row(part: &ContentPart) -> Value {
    match part {
        ContentPart::Text(text, reference) => {
            let mut row = json!({ "type": "text", "text": text });
            if let Some(meta) = reference {
                row["attachmentReference"] = Value::Object(meta.clone());
            }
            row
        }
        ContentPart::Image(ImageSource::Base64 { data, mime_type }) => json!({ "type": "image", "data": data, "mimeType": mime_type }),
        ContentPart::Image(ImageSource::Url(url)) => json!({ "type": "image", "url": url }),
        ContentPart::Image(ImageSource::FileId(id)) => json!({ "type": "image", "fileId": id }),
        ContentPart::File { source, mime_type, filename, text } => {
            let mut row = Map::new();
            let image_ref = mime_type.starts_with("image/") && matches!(source, BinarySource::AttachmentRef(_));
            row.insert("type".into(), json!(if text.is_some() { "text" } else if image_ref { "image" } else { "file" }));
            match source {
                BinarySource::Base64(data) => row.insert("data".into(), json!(data)),
                BinarySource::AttachmentRef(reference) => row.insert("attachmentRef".into(), json!(reference)),
            };
            if text.is_none() && !mime_type.is_empty() {
                row.insert("mimeType".into(), json!(mime_type));
            }
            if let Some(name) = filename {
                row.insert("filename".into(), json!(name));
            }
            if let Some(kind) = text.as_ref().and_then(|t| t.kind.as_ref()) {
                row.insert("textKind".into(), json!(kind));
            }
            Value::Object(row)
        }
        ContentPart::Document { .. } => json!({ "type": "document" }),
    }
}

fn content_row(content: &Content) -> Value {
    match content {
        Content::Text(text) => json!(text),
        Content::Parts(parts) => Value::Array(parts.iter().map(part_row).collect()),
    }
}

// ---- the other typed fields ------------------------------------------------------------------------

fn tier_of(name: &str) -> Option<CacheTier> {
    match name {
        "tier3" => Some(CacheTier::Tier3),
        "env" => Some(CacheTier::Env),
        _ => None,
    }
}

fn tier_name(tier: CacheTier) -> &'static str {
    match tier {
        CacheTier::Tier3 => "tier3",
        CacheTier::Env => "env",
    }
}

fn mode_name(mode: EffortMode) -> &'static str {
    match mode {
        EffortMode::Responses => "responses",
        EffortMode::Anthropic => "anthropic",
    }
}

fn effort_value(e: &EffortSnapshot) -> Value {
    json!({ "version": 1, "provider": e.provider, "model": e.model, "mode": mode_name(e.mode), "initialEffort": e.initial_effort, "effort": e.effort })
}

fn calls_of(row: &Value) -> Result<Vec<ToolCall>, String> {
    row.get("toolCalls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|call| {
            Ok(ToolCall {
                id: str_of(call, "id").ok_or("a tool call without an id")?.to_owned(),
                name: str_of(call, "name").ok_or("a tool call without a name")?.to_owned(),
                arguments: call.get("arguments").cloned().unwrap_or(Value::Null),
                native_type: None,
            })
        })
        .collect()
}

fn call_rows(calls: &[ToolCall], base: Option<&Value>) -> Value {
    Value::Array(
        calls
            .iter()
            .map(|c| {
                let mut row = Map::new();
                // What the call carried beyond its three fields (a Gemini thought signature) stays.
                let stored = base.and_then(Value::as_array).and_then(|b| b.iter().find(|s| str_of(s, "id") == Some(c.id.as_str())));
                row.insert("id".into(), json!(c.id));
                row.insert("name".into(), json!(c.name));
                row.insert("arguments".into(), c.arguments.clone());
                for (key, value) in stored.and_then(Value::as_object).into_iter().flatten() {
                    if !row.contains_key(key) {
                        row.insert(key.clone(), value.clone());
                    }
                }
                Value::Object(row)
            })
            .collect(),
    )
}

/// The message a row holds, without keeping the row.
fn typed_of(row: &Value) -> Result<AgentMessage, String> {
    let role = role_of(str_of(row, "role").ok_or("a row without a role")?).ok_or_else(|| format!("a row of role {:?}", row["role"]))?;
    let mut message = AgentMessage::user_content(content_of(row.get("content"))?);
    message.message.role = role;
    message.message.tool_calls = calls_of(row)?;
    message.message.tool_call_id = str_of(row, "toolCallId").map(str::to_owned);
    message.message.is_error = row.get("isError").and_then(Value::as_bool) == Some(true);
    message.message.cache_tier = str_of(row, "cacheTier").and_then(tier_of);
    message.message.thinking_blocks = row.get("thinkingBlocks").cloned();
    message.message.assistant_blocks = row.get("assistantBlocks").cloned();
    message.message.native_tool_search = row.get("nativeToolSearch").cloned();
    message.message.turn_reminder = str_of(row, "turnReminder").map(str::to_owned);
    if let Some(replay) = row.get("providerReplay").filter(|r| r.is_object()) {
        message.message.push_replay(ProviderReplay { owner: ProviderId::from(str_of(replay, "provider").unwrap_or_default()), items: replay.get("items").cloned().unwrap_or(Value::Null) });
    }
    message.turn_reminder = message.message.turn_reminder.clone();
    message.stop_reason = str_of(row, "stopReason").map(stop_of);
    message.tool_kind = str_of(row, "toolKind").and_then(kind_of);
    message.provider_metadata = row.get("providerMetadata").cloned();
    message.ui_diff = str_of(row, "uiDiff").map(str::to_owned);
    match row.get("meta") {
        Some(Value::String(name)) => message.source = Some(source_of(name).ok_or_else(|| format!("meta source {name:?}"))?),
        Some(meta @ Value::Object(_)) => {
            if let Some(name) = str_of(meta, "source") {
                message.source = Some(source_of(name).ok_or_else(|| format!("meta.source {name:?}"))?);
            }
            message.attempt = meta.get("attempt").and_then(Value::as_u64).map(|n| n as u32);
            message.submission_ids = meta.get("submissionIds").and_then(Value::as_array).into_iter().flatten().filter_map(|v| v.as_str().map(str::to_owned)).collect();
            message.message_id = meta.pointer("/transcript/messageId").and_then(Value::as_str).map(str::to_owned);
            message.effort = meta.get("effortConfiguration").and_then(EffortSnapshot::from_value);
        }
        _ => {}
    }
    Ok(message)
}

/// The message a stored row holds, with the row kept for writing it back.
pub fn message_of(row: &Value) -> Result<AgentMessage, String> {
    let mut message = typed_of(row)?;
    message.stored = row.as_object().map(|r| Arc::new(r.clone()));
    Ok(message)
}

// ---- writing ---------------------------------------------------------------------------------------

fn set_or_remove(row: &mut Row, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            row.insert(key.to_owned(), value);
        }
        None => {
            row.shift_remove(key);
        }
    }
}

/// `meta` with the message's facts written over `base`.
fn meta_row(m: &AgentMessage, base: Option<&Value>) -> Option<Value> {
    let mut meta = match base {
        Some(Value::Object(o)) => o.clone(),
        _ => Map::new(),
    };
    set_or_remove(&mut meta, "source", m.source.map(|s| json!(source_name(s))));
    set_or_remove(&mut meta, "attempt", m.attempt.map(|n| json!(n)));
    set_or_remove(&mut meta, "submissionIds", (!m.submission_ids.is_empty()).then(|| json!(m.submission_ids)));
    if let Some(id) = &m.message_id {
        let mut transcript = meta.get("transcript").and_then(Value::as_object).cloned().unwrap_or_default();
        transcript.insert("messageId".into(), json!(id));
        meta.insert("transcript".into(), Value::Object(transcript));
    }
    set_or_remove(&mut meta, "effortConfiguration", m.effort.as_ref().map(effort_value));
    // A bare `hook` / `skill` source with nothing else is the string form.
    if base.is_none_or(Value::is_string) && meta.len() == 1 && matches!(m.source, Some(Source::Hook | Source::Skill)) {
        return Some(json!(source_name(m.source.unwrap_or(Source::Hook))));
    }
    (!meta.is_empty()).then_some(Value::Object(meta))
}

fn replay_value(m: &AgentMessage, base: Option<&Value>) -> Option<Value> {
    let replay = m.message.provider_replay().first()?;
    let mut row = Map::new();
    row.insert("version".into(), json!(1));
    row.insert("provider".into(), json!(replay.owner.to_string()));
    row.insert("items".into(), replay.items.clone());
    for (key, value) in base.and_then(Value::as_object).into_iter().flatten() {
        if !row.contains_key(key) {
            row.insert(key.clone(), value.clone());
        }
    }
    Some(Value::Object(row))
}

/// A message without a stored row, in Node's key order for its role.
fn fresh_row(m: &AgentMessage) -> Row {
    let mut row = Map::new();
    row.insert("role".into(), json!(role_name(m.message.role)));
    row.insert("content".into(), content_row(&m.message.content));
    if !m.message.tool_calls.is_empty() {
        row.insert("toolCalls".into(), call_rows(&m.message.tool_calls, None));
    }
    set_or_remove(&mut row, "toolCallId", m.message.tool_call_id.as_ref().map(|v| json!(v)));
    if m.message.is_error {
        row.insert("isError".into(), json!(true));
    }
    set_or_remove(&mut row, "cacheTier", m.message.cache_tier.map(|t| json!(tier_name(t))));
    set_or_remove(&mut row, "thinkingBlocks", m.message.thinking_blocks.clone());
    set_or_remove(&mut row, "assistantBlocks", m.message.assistant_blocks.clone());
    set_or_remove(&mut row, "providerReplay", replay_value(m, None));
    set_or_remove(&mut row, "providerMetadata", m.provider_metadata.clone());
    set_or_remove(&mut row, "nativeToolSearch", m.message.native_tool_search.clone());
    set_or_remove(&mut row, "turnReminder", m.message.turn_reminder.as_ref().filter(|t| !t.is_empty()).map(|v| json!(v)));
    set_or_remove(&mut row, "stopReason", m.stop_reason.as_ref().map(|s| json!(stop_name(s))));
    set_or_remove(&mut row, "toolKind", m.tool_kind.map(|k| json!(kind_name(k))));
    set_or_remove(&mut row, "uiDiff", m.ui_diff.as_ref().map(|v| json!(v)));
    set_or_remove(&mut row, "meta", meta_row(m, None));
    row
}

/// The row of `message`: its stored row with what the run changed written over it, or a fresh
/// row.
pub fn row_of(message: &AgentMessage) -> Value {
    let Some(base) = &message.stored else { return Value::Object(fresh_row(message)) };
    let base_value = Value::Object((**base).clone());
    let Ok(was) = typed_of(&base_value) else { return Value::Object(fresh_row(message)) };
    let (m, w) = (&message.message, &was.message);
    let mut row = (**base).clone();
    if m.role != w.role {
        row.insert("role".into(), json!(role_name(m.role)));
    }
    if m.content != w.content {
        let body = content_row(&m.content);
        match row.get_mut("content") {
            Some(Value::Object(envelope)) if envelope.get("content").is_some_and(Value::is_array) => {
                envelope.insert("content".into(), body);
            }
            _ => {
                row.insert("content".into(), body);
            }
        }
    }
    if m.tool_calls != w.tool_calls {
        set_or_remove(&mut row, "toolCalls", (!m.tool_calls.is_empty()).then(|| call_rows(&m.tool_calls, base.get("toolCalls"))));
    }
    if m.tool_call_id != w.tool_call_id {
        set_or_remove(&mut row, "toolCallId", m.tool_call_id.as_ref().map(|v| json!(v)));
    }
    if m.is_error != w.is_error {
        set_or_remove(&mut row, "isError", m.is_error.then(|| json!(true)));
    }
    if m.cache_tier != w.cache_tier {
        set_or_remove(&mut row, "cacheTier", m.cache_tier.map(|t| json!(tier_name(t))));
    }
    if m.thinking_blocks != w.thinking_blocks {
        set_or_remove(&mut row, "thinkingBlocks", m.thinking_blocks.clone());
    }
    if m.assistant_blocks != w.assistant_blocks {
        set_or_remove(&mut row, "assistantBlocks", m.assistant_blocks.clone());
    }
    if m.native_tool_search != w.native_tool_search {
        set_or_remove(&mut row, "nativeToolSearch", m.native_tool_search.clone());
    }
    if m.provider_replay() != w.provider_replay() {
        set_or_remove(&mut row, "providerReplay", replay_value(message, base.get("providerReplay")));
    }
    if m.turn_reminder != w.turn_reminder {
        set_or_remove(&mut row, "turnReminder", m.turn_reminder.as_ref().filter(|t| !t.is_empty()).map(|v| json!(v)));
    }
    if message.stop_reason != was.stop_reason {
        set_or_remove(&mut row, "stopReason", message.stop_reason.as_ref().map(|s| json!(stop_name(s))));
    }
    if message.tool_kind != was.tool_kind {
        set_or_remove(&mut row, "toolKind", message.tool_kind.map(|k| json!(kind_name(k))));
    }
    if message.provider_metadata != was.provider_metadata {
        set_or_remove(&mut row, "providerMetadata", message.provider_metadata.clone());
    }
    if message.ui_diff != was.ui_diff {
        set_or_remove(&mut row, "uiDiff", message.ui_diff.as_ref().map(|v| json!(v)));
    }
    if (message.source, message.attempt, &message.submission_ids, &message.message_id, &message.effort) != (was.source, was.attempt, &was.submission_ids, &was.message_id, &was.effort) {
        set_or_remove(&mut row, "meta", meta_row(message, base.get("meta")));
    }
    Value::Object(row)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;

    fn corpus() -> PathBuf {
        std::env::var_os("MIXDOG_MIGRATION_CORPUS")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Users\tempe\.mixdog\data\scratch\rust-core\migration-corpus"))
    }

    /// Session files of the real corpus (v145 and dev146): `sess_*.json`, not the archived,
    /// deleted or backup copies.
    fn sessions() -> Vec<PathBuf> {
        let mut out = Vec::new();
        for dir in ["v145", "dev146"] {
            let Ok(entries) = std::fs::read_dir(corpus().join(dir).join("sessions")) else { continue };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with("sess_") && name.ends_with(".json") && !name.contains(".log.") && !name.contains(".compaction") {
                    out.push(entry.path());
                }
            }
        }
        out.sort();
        out
    }

    fn rows_of(path: &Path) -> Option<(String, Vec<Value>)> {
        let text = std::fs::read_to_string(path).ok()?;
        let session: Value = serde_json::from_str(&text).ok()?;
        let rows = session.get("messages")?.as_array()?.clone();
        Some((text, rows))
    }

    #[test]
    fn rows_round_trip_through_the_message() {
        let mut call = AgentMessage::assistant("looking", vec![ToolCall { id: "c1".into(), name: "echo".into(), arguments: json!({"a": 1}), native_type: None }]);
        call.stop_reason = Some(StopReason::ToolUse);
        call.message_id = Some("msg_1".into());
        let result = AgentMessage::tool_text("c1", "echo:{}", ToolKind::Normal);
        let user = AgentMessage::user_content(Content::Parts(vec![ContentPart::Text("see".into(), None)]));
        for message in [call, result, user, AgentMessage::user("hi")] {
            let row = row_of(&message);
            let back = message_of(&row).expect("row");
            assert_eq!(row_of(&back), row);
            assert_eq!(back.message.role, message.message.role);
            assert_eq!(back.message.content, message.message.content);
            assert_eq!(back.message.tool_calls, message.message.tool_calls);
            assert_eq!(back.stop_reason, message.stop_reason);
        }
    }

    #[test]
    fn a_row_of_an_unknown_shape_is_an_error_not_a_dropped_message() {
        assert!(message_of(&json!({ "role": "narrator", "content": "x" })).is_err());
        assert!(message_of(&json!({ "role": "user", "content": [{ "type": "hologram" }] })).is_err());
    }

    /// A reference part keeps its object as Node stores it, through the row and into the wire
    /// message, whose lowering carries the text only.
    #[test]
    fn a_reference_parts_object_survives_the_row_and_stays_off_the_wire() {
        let golden: Value = serde_json::from_str(include_str!("golden/attachment_reference.json")).unwrap();
        let media = golden["pdf_pages"]["info"].as_object().unwrap().clone();
        let files = json!({ "kind": "files", "files": [{ "attachmentRef": "r", "name": "a.pdf", "mimeType": "application/pdf", "sizeBytes": 1, "path": "/p/a.pdf" }] }).as_object().unwrap().clone();
        for meta in [media, files] {
            let message = AgentMessage::user_content(Content::Parts(vec![ContentPart::Text("ref".into(), Some(meta.clone()))]));
            let row = row_of(&message);
            assert_eq!(row["content"][0]["attachmentReference"], Value::Object(meta.clone()));
            let back = message_of(&row).unwrap();
            assert_eq!(back.message.content, message.message.content);
            let Content::Parts(parts) = &back.wire().content else { panic!("parts") };
            assert_eq!(parts, &vec![ContentPart::Text("ref".into(), Some(meta))]);
        }
    }

    /// Every stored message of the real corpus sessions: Node's bytes, the message, Node's bytes.
    /// A message the run changed is rewritten over its row: the edit changes that key and nothing
    /// else.
    /// Run: `$env:MIXDOG_MIGRATION_CORPUS = "<corpus dir with v145/ and dev146/>"; cargo test -p mixdog-core --lib run_host::message_row -- --ignored --nocapture` (PowerShell; the variable's default is `C:\Users\tempe\.mixdog\data\scratch\rust-core\migration-corpus`).
    #[test]
    #[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
    fn the_migration_corpus_round_trips_byte_for_byte() {
        let (mut files, mut messages) = (0, 0);
        for path in sessions() {
            let Some((text, rows)) = rows_of(&path) else { continue };
            // The row bytes are Node's only where this serializer writes what JSON.stringify did.
            let session: Value = serde_json::from_str(&text).unwrap();
            let compact = serde_json::to_string(&session).unwrap();
            let pretty = serde_json::to_string_pretty(&session).unwrap();
            assert!(compact == text.trim_end() || pretty == text.trim_end(), "{}: the file is not in a form this serializer reproduces", path.display());
            files += 1;
            for row in rows {
                let message = message_of(&row).unwrap_or_else(|e| panic!("{}: {e}: {row}", path.display()));
                let back = row_of(&message);
                assert_eq!(serde_json::to_string(&back).unwrap(), serde_json::to_string(&row).unwrap(), "{}", path.display());
                let mut edited = message.clone();
                edited.message.content = Content::Text("edited".into());
                let rewritten = row_of(&edited);
                // A tool result in its `{content}` envelope keeps the envelope.
                let mut want = row.as_object().unwrap().clone();
                match want.get_mut("content") {
                    Some(Value::Object(envelope)) => {
                        envelope.insert("content".into(), json!("edited"));
                    }
                    _ => {
                        want.insert("content".into(), json!("edited"));
                    }
                }
                assert_eq!(rewritten, Value::Object(want), "{}", path.display());
                messages += 1;
            }
        }
        assert!(files > 0 && messages > 0, "no corpus at {}", corpus().display());
        eprintln!("round-tripped {messages} messages of {files} sessions");
    }

    /// The typed fields alone, without the stored row, rebuild every message of the corpus but
    /// for the keys with no typed home; the test names them, so a new one fails here.
    /// Run: `$env:MIXDOG_MIGRATION_CORPUS = "<corpus dir with v145/ and dev146/>"; cargo test -p mixdog-core --lib run_host::message_row -- --ignored --nocapture` (PowerShell; the variable's default is `C:\Users\tempe\.mixdog\data\scratch\rust-core\migration-corpus`).
    #[test]
    #[ignore = "release gate over the migration corpus (MIXDOG_MIGRATION_CORPUS)"]
    fn the_typed_fields_hold_everything_but_the_named_extras() {
        const EXTRAS: [&str; 10] = ["createdAt", "iterations", "toolCallsTotal", "usage", "emptyFinal", "hasThinkingContent", "contentBlockTypes", "ts", "toolTiming", "agentTaskIds"];
        let project = |row: &Value| -> Value {
            let mut row = row.as_object().unwrap().clone();
            for key in EXTRAS {
                row.shift_remove(key);
            }
            // An empty list of calls is the same as none.
            if row.get("toolCalls").is_some_and(|c| c.as_array().is_some_and(Vec::is_empty)) {
                row.shift_remove("toolCalls");
            }
            for call in row.get_mut("toolCalls").and_then(Value::as_array_mut).into_iter().flatten() {
                call.as_object_mut().unwrap().shift_remove("thoughtSignature");
            }
            if let Some(Value::Object(replay)) = row.get_mut("providerReplay") {
                replay.shift_remove("accountId");
                replay.shift_remove("requestContext");
            }
            if let Some(meta) = row.get_mut("meta") {
                if let Some(m) = meta.as_object() {
                    let mut kept = Map::new();
                    for key in ["source", "attempt", "submissionIds", "effortConfiguration"] {
                        if let Some(v) = m.get(key) {
                            kept.insert(key.into(), v.clone());
                        }
                    }
                    if let Some(id) = m.get("transcript").and_then(|t| t.get("messageId")) {
                        kept.insert("transcript".into(), json!({ "messageId": id }));
                    }
                    *meta = Value::Object(kept);
                }
            }
            // Content: a reference part's size and mime live in the store's facts.
            let strip = |parts: &mut Value| {
                for part in parts.as_array_mut().into_iter().flatten() {
                    if let Some(p) = part.as_object_mut() {
                        for key in ["sizeBytes", "mimeType", "width", "height"] {
                            p.shift_remove(key);
                        }
                    }
                }
            };
            if let Some(content) = row.get_mut("content") {
                if let Some(mut inner) = content.get("content").cloned() {
                    strip(&mut inner);
                    *content = inner;
                } else {
                    strip(content);
                }
            }
            Value::Object(row)
        };
        let mut messages = 0;
        for path in sessions() {
            let Some((_, rows)) = rows_of(&path) else { continue };
            for row in rows {
                let typed = typed_of(&row).unwrap();
                let fresh = Value::Object(fresh_row(&typed));
                let (mut want, mut got) = (project(&row), project(&fresh));
                for side in [&mut want, &mut got] {
                    if side.get("meta").is_some_and(|m| m.as_object().is_some_and(Map::is_empty)) {
                        side.as_object_mut().unwrap().shift_remove("meta");
                    }
                }
                assert_eq!(got, want, "{}: {row}", path.display());
                messages += 1;
            }
        }
        assert!(messages > 0);
    }
}
