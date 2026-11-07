//! The conversation compaction measures and summarizes: user and assistant
//! text (the memory-ingest projection) plus runtime conversation rows, cut in
//! chunks; for a summary, bounded and with one line per tool call.

use std::collections::HashMap;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::Role;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;

use super::fresh::FreshContext;
use super::fresh::split_fresh_source;
use super::ingest::IngestView;
use super::ingest::should_exclude_ingest_message;
use super::messages::is_compact_conversation_row;
use super::messages::latest_actual_user_instruction_index;
use super::messages::pending_task_notification_indexes;
use super::redact::redact_raw_secret_string;
use super::text_utils::content_text;
use crate::message::AgentMessage;
use crate::message::Source;

const HANDOFF_SOURCE_CHUNK_CHARS: usize = 1_600;
/// What the summary reads of runtime conversation rows and tool calls.
const SUMMARY_RUNTIME_ROW_CHARS: usize = 4_000;
const SUMMARY_TOOL_ARGS_CHARS: usize = 200;
const SUMMARY_TOOL_OUTCOME_CHARS: usize = 300;

/// The first text of a content (a string, or the first text part).
fn first_text(content: &Content) -> String {
    match content {
        Content::Text(text) => text.clone(),
        Content::Parts(parts) => parts
            .iter()
            .find_map(|p| match p {
                ContentPart::Text(t, _) => Some(t.clone()),
                _ => None,
            })
            .unwrap_or_default(),
    }
}

fn should_exclude(m: &AgentMessage) -> bool {
    let text = first_text(&m.message.content);
    let meta_source = match m.source {
        Some(Source::TaskNotification) => "task-notification",
        Some(Source::CompactSummary) => "compact-summary",
        Some(Source::ActiveTurnContinuation) => "compact-active-turn-continuation",
        Some(Source::CompactExecutionRecovery) => "compact-execution-recovery",
        _ => "",
    };
    should_exclude_ingest_message(&IngestView {
        role: m.role(),
        first_text: &text,
        meta_source,
        skill_body: m.source == Some(Source::Skill),
        has_tool_calls: !m.tool_calls().is_empty(),
    })
}

fn ingest_role(role: Role) -> Option<Role> {
    matches!(role, Role::User | Role::Assistant).then_some(role)
}

/// A cut at `end` that would split a surrogate pair moves back one unit.
fn code_point_end(units: &[u16], end: usize) -> usize {
    if end < units.len() && (0xd800..=0xdbff).contains(&units[end - 1]) { end - 1 } else { end }
}

pub(super) fn chunk(role: Role, content: &str) -> Vec<AgentMessage> {
    let units: Vec<u16> = content.encode_utf16().collect();
    let mut out = Vec::new();
    let mut offset = 0;
    while offset < units.len() {
        let end = code_point_end(&units, (offset + HANDOFF_SOURCE_CHUNK_CHARS).min(units.len()));
        let text = String::from_utf16_lossy(&units[offset..end]);
        out.push(if role == Role::User { AgentMessage::user(text) } else { AgentMessage::assistant(text, Vec::new()) });
        offset = end;
    }
    out
}

fn bounded(text: &str, limit: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= limit {
        return text.to_owned();
    }
    let end = code_point_end(&units, limit);
    format!("{}… [{} more chars]", String::from_utf16_lossy(&units[..end]), units.len() - end)
}

/// `text.replace(/\s+/g, ' ')`.
fn collapse_space(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

fn tool_call_line(name: &str, arguments: &serde_json::Value, result: Option<&AgentMessage>) -> String {
    let raw = match arguments {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => "{}".to_owned(),
        other => mixdog_js::json_stringify(other),
    };
    let args = bounded(&collapse_space(&raw), SUMMARY_TOOL_ARGS_CHARS);
    // Arguments arrive redacted; the outcome is redacted here, before any cut
    // can split a secret from its key.
    let outcome = js_trim(&redact_raw_secret_string(&result.map(|r| content_text(&r.message.content)).unwrap_or_default())).to_owned();
    // An ask_user or handoff_user result is the user's own answer: never cut.
    let shown = if matches!(name, "ask_user" | "handoff_user") {
        outcome
    } else {
        bounded(&collapse_space(&outcome), SUMMARY_TOOL_OUTCOME_CHARS)
    };
    let tail = match result {
        None => "(no result)".to_owned(),
        Some(_) if shown.is_empty() => "(empty result)".to_owned(),
        Some(_) => shown,
    };
    format!("[tool call] {name}({args}) → {tail}")
}

fn conversation_rows(messages: &[AgentMessage], summary: bool) -> Vec<AgentMessage> {
    let results: HashMap<&str, &AgentMessage> = messages
        .iter()
        .filter(|m| m.role() == Role::Tool)
        .filter_map(|m| m.tool_call_id().map(|id| (id, m)))
        .collect();
    let mut out = Vec::new();
    for m in messages {
        let content = js_trim(&content_text(&m.message.content)).to_owned();
        if is_compact_conversation_row(m) {
            // A notification can carry a background command's output: the
            // summary reads it redacted like a tool outcome.
            let text = if summary { bounded(&redact_raw_secret_string(&content), SUMMARY_RUNTIME_ROW_CHARS) } else { content };
            if !text.is_empty() {
                out.extend(chunk(Role::User, &text));
            }
            continue;
        }
        if let Some(role) = ingest_role(m.role())
            && !content.is_empty()
            && !should_exclude(m)
        {
            out.extend(chunk(role, &content));
        }
        if summary && m.role() == Role::Assistant && !m.tool_calls().is_empty() {
            let lines: Vec<String> = m
                .tool_calls()
                .iter()
                .map(|c| tool_call_line(&c.name, &c.arguments, results.get(c.id.as_str()).copied()))
                .collect();
            out.extend(chunk(Role::Assistant, &lines.join("\n")));
        }
    }
    out
}

/// The conversation compaction measures against its summary threshold, or
/// with `summary`, the input the summary is written from. The turn input (the
/// latest request and unanswered notifications) is never replaced by a summary.
pub async fn conversation_compaction_input(ctx: &FreshContext<'_>, messages: &[AgentMessage], summary: bool) -> Vec<AgentMessage> {
    let source = split_fresh_source(ctx, messages).await;
    let mut turn_input: Vec<usize> = pending_task_notification_indexes(&source.live);
    turn_input.extend(latest_actual_user_instruction_index(&source.live));
    let rest: Vec<AgentMessage> = source
        .live
        .iter()
        .enumerate()
        .filter(|(i, _)| !turn_input.contains(i))
        .map(|(_, m)| m.clone())
        .collect();
    let mut out: Vec<AgentMessage> = source.previous_summary.into_iter().collect();
    out.extend(conversation_rows(&rest, summary));
    out
}
