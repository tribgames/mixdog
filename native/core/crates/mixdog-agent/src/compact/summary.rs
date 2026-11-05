//! Handoff summarization: the prompts, the bounded prompt a batch is fitted
//! to, schema enforcement of the model's answer, and the summary message.

use mixdog_core_api::domain::provider::Role;
use mixdog_js::js_trim;
use mixdog_js::utf16_len;

use super::estimate::MessageMeter;
use super::execution_tail::MessageRows;
use super::fresh::compact_header;
use super::fresh::make_summary_message;
use super::summary_schema::minimal_schema_summary;
use super::summary_schema::repair_compact_summary;
use super::summary_schema::summary_is_schema_valid;
use super::summary_schema::truncate_summary_by_sections;
use super::text_utils::extract_text;
use super::text_utils::tool_call_arg_budget;
use super::text_utils::tool_call_summary;
use super::text_utils::tool_result_id;
use super::text_utils::truncate_middle;
use crate::message::AgentMessage;

pub const COMPACTION_SYSTEM_PROMPT: &str = "You are an anchored context summarization assistant for coding sessions.

Summarize only the conversation history you are given. The newest turns may be kept verbatim outside your summary, so focus on the older context that still matters for continuing the work.

If the prompt includes a <previous-summary> block, treat it as the current anchored summary. Update it with the new history by preserving still-true details, removing stale details, and merging in new facts.

Always follow the exact output structure requested by the user prompt. Keep every section, preserve exact file paths and identifiers when known, and prefer terse bullets over paragraphs.

Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.";

const SUMMARY_TEMPLATE: &str = "Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or \"(none)\"]

## Progress
### Done
- [completed work or \"(none)\"]

### In Progress
- [current work or \"(none)\"]

### Blocked
- [blockers or \"(none)\"]

## Key Decisions
- [decision and why, or \"(none)\"]

## Next Steps
- [ordered next actions or \"(none)\"]

## Critical Context
- [important technical facts, errors, open questions, or \"(none)\"]

## Relevant Files
- [file or directory path: why it matters, or \"(none)\"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Use the same language as the active user thread when it is clear.
- Record work as Done or In Progress only when a tool call and its result in the history show it (an agent spawn/send result, an edit, a command outcome). An assistant's stated intent with no matching tool call is not started: list it under Next Steps as \"announced, not started\".
- Attribute every decision, answer, and version/choice to its source: the user (message or ask_user answer), a named agent's report, or the assistant. Never credit an agent or the assistant with a user's answer.
- Do not mention the summary process or that context was compacted.";

/// The final user turn of a summary forked from the session's own cached
/// request: the conversation itself is the history.
pub fn forked_compaction_prompt() -> String {
    [
        "<compaction-request>",
        "Pause the task for this one response. No tools are available here: do not call any.",
        "Write the anchored handoff summary this work continues from. The latest user request and the recent tool calls and results are kept verbatim after it, so focus on the older context that still matters.",
        "If the conversation holds an earlier summary, update it: preserve still-true details, remove stale details, and merge in the new facts.",
        "Do not answer the conversation itself. Do not mention that you are summarizing, compacting, or merging context. Respond in the same language as the conversation.",
        "",
        SUMMARY_TEMPLATE,
        "</compaction-request>",
    ]
    .join("\n")
}

fn system_message(text: &str) -> AgentMessage {
    let mut m = AgentMessage::user(text);
    m.message.role = Role::System;
    m
}

fn role_label(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
        Role::Developer => "developer",
    }
}

fn transcript_line(m: &AgentMessage, index: usize, per_message_chars: usize) -> String {
    let label = format!(
        "{}{}{}",
        role_label(m.role()),
        tool_call_summary(m, tool_call_arg_budget(per_message_chars)),
        tool_result_id(m)
    );
    let text = truncate_middle(js_trim(&extract_text(m)), per_message_chars);
    if text.is_empty() { format!("{}. {label}", index + 1) } else { format!("{}. {label}:\n{text}", index + 1) }
}

/// The user prompt of one summary call over `head`, with an optional earlier
/// summary to update.
pub fn build_compaction_prompt(head: &[AgentMessage], previous_summary: Option<&str>) -> String {
    let mut lines: Vec<String> = vec![
        if previous_summary.is_some() {
            "Update the anchored summary below using the conversation history that follows. Preserve still-true details, remove stale details, and merge in the new facts."
        } else {
            "Create a new anchored summary from the conversation history below."
        }
        .to_owned(),
        SUMMARY_TEMPLATE.to_owned(),
    ];
    if let Some(previous) = previous_summary {
        lines.extend(["".to_owned(), "<previous-summary>".to_owned(), previous.to_owned(), "</previous-summary>".to_owned()]);
    }
    lines.extend(["".to_owned(), "<conversation-history>".to_owned()]);
    if head.is_empty() {
        lines.push("[No additional older messages before the preserved recent tail.]".to_owned());
    } else {
        lines.extend(head.iter().enumerate().map(|(i, m)| transcript_line(m, i, usize::MAX)));
    }
    lines.push("</conversation-history>".to_owned());
    lines.join("\n")
}

/// The complete prompt when it (with the system prompt) fits `target_tokens`.
pub fn fit_complete_compaction_prompt(
    meter: &MessageMeter<'_>,
    head: &[AgentMessage],
    previous_summary: Option<&str>,
    target_tokens: u64,
) -> Option<String> {
    let prompt = build_compaction_prompt(head, previous_summary);
    let messages = [system_message(COMPACTION_SYSTEM_PROMPT), AgentMessage::user(prompt.clone())];
    (meter.messages(&messages) <= target_tokens).then_some(prompt)
}

/// The text of a provider answer, trimmed.
pub fn extract_response_text(content: &str) -> String {
    js_trim(content).to_owned()
}

pub struct EnforcedSummary {
    pub summary: String,
    pub repaired: bool,
}

/// A non-empty answer missing any required section is repaired
/// deterministically so a broken answer is never injected as the summary.
pub fn enforce_compact_summary_schema(summary: &str, head: &[AgentMessage], tail: &[AgentMessage]) -> EnforcedSummary {
    let text = js_trim(summary);
    if text.is_empty() || summary_is_schema_valid(text) {
        return EnforcedSummary { summary: text.to_owned(), repaired: false };
    }
    EnforcedSummary { summary: repair_compact_summary(text, head, tail), repaired: true }
}

/// The largest `size` in `[lo, hi]` whose candidate fits (`build` grows with
/// `size`, so binary search finds the edge).
pub(super) fn largest_fitting<T>(
    mut lo: usize,
    mut hi: usize,
    build: impl Fn(usize) -> T,
    fits: impl Fn(&T) -> bool,
) -> Option<T> {
    let mut best = None;
    while lo <= hi {
        let mid = (lo + hi) / 2;
        let candidate = build(mid);
        if fits(&candidate) {
            best = Some(candidate);
            lo = mid + 1;
        } else {
            if mid == 0 {
                break;
            }
            hi = mid - 1;
        }
    }
    best
}

pub struct HandoffMeta<'a> {
    pub provider: Option<&'a str>,
    pub model: &'a str,
}

fn generated_handoff_message(header: &str, summary: &str, meta: &HandoffMeta<'_>) -> AgentMessage {
    let header = format!(
        "{header}\ngenerated_handoff=true provider={} model={}",
        meta.provider.filter(|p| !p.is_empty()).unwrap_or("unknown"),
        if meta.model.is_empty() { "unknown" } else { meta.model }
    );
    let body = js_trim(summary);
    let mut parts = vec![header];
    if !body.is_empty() {
        parts.push(body.to_owned());
    }
    make_summary_message(parts.join("\n\n"))
}

/// The structured summary shrunk into the remaining budget without dropping a
/// required section; `None` only when even the headings-only summary cannot fit.
pub fn fit_generated_handoff_message(
    meter: &MessageMeter<'_>,
    rows: &dyn MessageRows,
    old_history: &[AgentMessage],
    summary: &str,
    remaining_tokens: u64,
    meta: &HandoffMeta<'_>,
) -> Option<AgentMessage> {
    let text = js_trim(summary);
    let header = compact_header(rows, old_history);
    let minimal_body = if text.is_empty() { String::new() } else { minimal_schema_summary() };
    let minimal = generated_handoff_message(&header, &minimal_body, meta);
    if meter.message(&minimal) > remaining_tokens {
        return None;
    }
    if text.is_empty() {
        return Some(minimal);
    }
    let best = largest_fitting(
        0,
        utf16_len(text),
        |per_section| {
            let body = truncate_summary_by_sections(text, per_section);
            (generated_handoff_message(&header, &body, meta), body)
        },
        |(message, body)| meter.message(message) <= remaining_tokens && summary_is_schema_valid(body),
    );
    Some(best.map_or(minimal, |(message, _)| message))
}
