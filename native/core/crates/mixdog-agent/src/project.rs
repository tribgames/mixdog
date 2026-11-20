//! Wire-time envelope for synthetic user messages, and the classification of
//! user messages the compaction rules share.
//!
//! The runtime stores compaction summaries, continuation nudges, recovery
//! prompts, interruption markers, task notifications and injected context as
//! ordinary user rows so the next model step can consume them. On the wire
//! those rows are wrapped in a fixed tag the system rules declare as
//! runtime-authored, so the human's own prompt stays the only unwrapped user
//! voice. The stored transcript keeps the raw rows.

use std::sync::LazyLock;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::Role;
use regex::Regex;

use crate::message::AgentMessage;
use crate::message::Source;

pub const SUMMARY_PREFIX_ANCHOR: &str = "A previous model worked on this task and produced the compacted handoff summary below.";
pub const ACTIVE_TURN_CONTINUATION_ANCHOR: &str = "<active-turn-continuation>";
const TAG: &str = "mixdog-runtime";
const PROCESS_RESTART_MARKER: &str = "[Request interrupted by process restart]";
const PROCESS_RESTART_WIRE_TEXT: &str = "[mixdog-runtime] The app restarted mid-turn. Continue from where you left off.";

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static pattern")
}

static COMPACT_STATE_TEXT: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)^(?:A previous model worked on this task and produced the compacted handoff summary below\b|Re-attached after compaction\b)"));
static CONTEXT_ATTACHMENT_TEXT: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)^(?:Reference files:\s|<(?:skill|memory-context|mcp-instructions|available-deferred-tools)\b)"));
static RUNTIME_CONTROL_TEXT: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)^(?:Output token limit hit\.|\[mixdog-runtime\]|\[request interrupted\b|Async \S+ task \S+ \([^)]*\) finished\.)"));
static ENVELOPE_OPEN: LazyLock<Regex> = LazyLock::new(|| re(&format!(r"(?i)^\s*<{TAG}\b")));
static SUMMARY_HEADER: LazyLock<Regex> = LazyLock::new(|| re(r"\nmessages=\d+\s+(?:sha256=|compact_type=)"));
static REFERENCE_FILES: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^Reference files:\s*"));
static SYNTHETIC_CONTROL: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)^(?:\[mixdog-runtime\]|\[request interrupted(?: by user(?: for tool use)?| by process restart)?\])(?:\s|$)"));
static CONTROL_MARKER: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)^\[(?:truncated|request interrupted(?: by user(?: for tool use)?| by process restart)?)\]$"));
static BRACKETED_SHELL_STATUS: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?im)^\[status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled|error|timeout|done|success)\]"));
static ASYNC_HEADER: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^Async .+ finished\."));

/// A user message's text: string content, or the text blocks joined.
pub fn user_text(message: &AgentMessage) -> String {
    match &message.message.content {
        Content::Text(text) => text.clone(),
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|p| match p {
                ContentPart::Text(t, _) => Some(t.as_str()),
                _ => None,
            })
            .collect(),
    }
}

fn string_content(message: &AgentMessage) -> Option<&str> {
    match &message.message.content {
        Content::Text(text) => Some(text),
        Content::Parts(_) => None,
    }
}

fn is_imported(message: &AgentMessage) -> bool {
    message.source == Some(Source::Import)
}

// --- task notification envelopes ---

fn decode_field(value: &str) -> String {
    value.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

#[derive(Debug, PartialEq)]
pub struct TaskNotification {
    pub surface: String,
}

/// Parses only the outer fields of a `<task-notification>` envelope; a result
/// may itself contain tags, so its contents are never searched.
pub fn parse_task_notification(text: &str) -> Option<TaskNotification> {
    let value = mixdog_js::js_trim(text);
    let head = "<task-notification>\n";
    let tail = "\n</task-notification>";
    if !value.starts_with(head) || !value.ends_with(tail) {
        return None;
    }
    let mut fields_text = value[head.len()..value.len() - tail.len()].to_owned();
    if let Some(start) = fields_text.find("\n<result>\n") {
        let end = fields_text.rfind("\n</result>")?;
        if end < start {
            return None;
        }
        let after = end + "\n</result>".len();
        fields_text = format!("{}{}", &fields_text[..start], &fields_text[after..]);
    }
    static FIELD: LazyLock<Regex> = LazyLock::new(|| re(r"(?m)^<([\w-]+)>([^<]*)</([\w-]+)>$"));
    let mut task_id = None;
    let mut status = None;
    let mut summary = None;
    for cap in FIELD.captures_iter(&fields_text) {
        if cap[1] != cap[3] {
            continue;
        }
        let value = decode_field(&cap[2]);
        match &cap[1] {
            "task-id" => task_id = Some(value),
            "status" => status = Some(value),
            "summary" => summary = Some(value),
            _ => {}
        }
    }
    let (task_id, status, summary) = (task_id?, status?, summary?);
    if task_id.is_empty() || summary.is_empty() || !matches!(status.as_str(), "completed" | "failed" | "cancelled") {
        return None;
    }
    let surface = if summary.starts_with("Agent \"") {
        "agent".to_owned()
    } else if summary.starts_with("Shell task ") {
        "shell".to_owned()
    } else {
        static SURFACE: LazyLock<Regex> = LazyLock::new(|| re(r"^(\S+) task "));
        SURFACE.captures(&summary).map_or_else(|| "tool".to_owned(), |c| c[1].to_owned())
    };
    Some(TaskNotification { surface })
}

fn is_bracketed_shell_notification(text: &str) -> bool {
    let value = mixdog_js::js_trim(text);
    if value.is_empty() {
        return false;
    }
    if parse_task_notification(value).is_some_and(|n| n.surface == "shell") {
        return true;
    }
    static TASK_ID: LazyLock<Regex> = LazyLock::new(|| re(r"(?im)^\[task_id:\s*\S+\]"));
    TASK_ID.is_match(value) && BRACKETED_SHELL_STATUS.is_match(value)
}

pub fn is_internal_runtime_notification(text: &str) -> bool {
    let value = mixdog_js::js_trim(text);
    if value.is_empty() {
        return false;
    }
    if parse_task_notification(value).is_some() || is_bracketed_shell_notification(value) {
        return true;
    }
    static BACKGROUND: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^background task\b"));
    static TASK_ID: LazyLock<Regex> = LazyLock::new(|| re(r"(?im)^task_id:\s*\S+"));
    static STATUS: LazyLock<Regex> = LazyLock::new(|| re(r"(?im)^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)\b"));
    static DETAIL: LazyLock<Regex> = LazyLock::new(|| re(r"(?im)^(?:surface|operation|type|target|role|agent|preset|model|effort|fast|notification):\s*"));
    (BACKGROUND.is_match(value) && TASK_ID.is_match(value) && STATUS.is_match(value))
        || (TASK_ID.is_match(value) && STATUS.is_match(value) && DETAIL.is_match(value))
}

fn completion_wrapper_quoted_lines(text: &str) -> Option<Vec<String>> {
    let value = mixdog_js::js_trim(text);
    let split = value.find("\n\nResult:\n")?;
    let preamble = mixdog_js::js_trim(&value[..split]);
    if preamble.is_empty() || !ASYNC_HEADER.is_match(preamble) {
        return None;
    }
    let quoted: Vec<String> =
        value[split + "\n\nResult:\n".len()..].split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).filter(|l| !l.is_empty()).map(str::to_owned).collect();
    (!quoted.is_empty()).then_some(quoted)
}

pub fn is_model_visible_tool_completion_wrapper(text: &str) -> bool {
    let value = mixdog_js::js_trim(text);
    if value.is_empty() {
        return false;
    }
    if parse_task_notification(value).is_some() {
        return true;
    }
    let Some(lines) = completion_wrapper_quoted_lines(value) else {
        return false;
    };
    if !lines.iter().all(|l| l.starts_with("> ")) {
        return false;
    }
    let unquoted = lines.iter().map(|l| &l[2..]).collect::<Vec<_>>().join("\n");
    is_internal_runtime_notification(&unquoted)
}

pub fn is_control_marker(text: &str) -> bool {
    CONTROL_MARKER.is_match(mixdog_js::js_trim(text))
}

// --- user message kinds ---

/// Node distinguishes boundary removal from turn retention: only matching producer provenance
/// permits slicing a request, while `is_protected_context_user` also recognizes legacy envelope-only
/// rows. Leaving an unmarked row unsliced does not make it a retainable instruction.
pub(crate) fn strip_runtime_user_context(message: &AgentMessage) -> AgentMessage {
    let context = message
        .stored
        .as_ref()
        .filter(|_| message.role() == Role::User)
        .and_then(|row| row.get("meta"))
        .and_then(|meta| meta.get("runtimeUserContext"))
        .and_then(|context| Some((context.get("prefix")?.as_str()?, context.get("suffix")?.as_str()?)));
    let Some((prefix, suffix)) = context else { return message.clone() };
    let Some(content) = stripped_content(&message.message.content, prefix, suffix) else { return message.clone() };
    let mut out = message.clone();
    out.message.content = content;
    let mut row = crate::message_row::row_of(&out).as_object().expect("message row").clone();
    let meta = row.get_mut("meta").and_then(serde_json::Value::as_object_mut).expect("runtime context meta");
    meta.shift_remove("runtimeUserContext");
    meta.shift_remove("agentListing");
    if meta.is_empty() {
        row.shift_remove("meta");
    }
    out.stored = Some(std::sync::Arc::new(row));
    out
}

/// `stripRuntimeUserContext`'s content: `None` when the recorded boundaries no longer match.
pub(crate) fn stripped_content(content: &Content, prefix: &str, suffix: &str) -> Option<Content> {
    match content {
        Content::Text(text) => {
            let inner = text.strip_prefix(prefix)?;
            (text.len() >= prefix.len() + suffix.len()).then_some(())?;
            Some(Content::Text(inner.strip_suffix(suffix)?.to_owned()))
        }
        Content::Parts(parts) => {
            let is_text = |part: Option<&ContentPart>, want: &str| matches!(part, Some(ContentPart::Text(text, _)) if text == want);
            if (!prefix.is_empty() && !is_text(parts.first(), prefix)) || (!suffix.is_empty() && !is_text(parts.last(), suffix)) {
                return None;
            }
            let (head, tail) = (usize::from(!prefix.is_empty()), usize::from(!suffix.is_empty()));
            (parts.len() >= head + tail).then(|| Content::Parts(parts[head..parts.len() - tail].to_vec()))
        }
    }
}

pub fn is_summary_message(m: &AgentMessage) -> bool {
    m.role() == Role::User
        && !is_imported(m)
        && (m.source == Some(Source::CompactSummary) || string_content(m).is_some_and(|c| c.starts_with(SUMMARY_PREFIX_ANCHOR) && SUMMARY_HEADER.is_match(c)))
}

/// A non-imported user turn made only of `<system-reminder>` envelopes, including legacy rows
/// without provenance. Node classifies the shape, not the author's intent; only a leading prefix
/// protects such a row from the conversation-tail filter.
pub fn is_protected_context_user(m: &AgentMessage) -> bool {
    let Some(text) = string_content(m) else {
        return false;
    };
    if m.role() != Role::User || is_imported(m) {
        return false;
    }
    let mut content = mixdog_js::js_trim(text);
    // ASCII folding keeps byte offsets: the tags are ASCII, and a full Unicode lower-casing can change a
    // character's byte length, which would shift the index used to slice `content`.
    if !content.to_ascii_lowercase().starts_with("<system-reminder>") {
        return false;
    }
    let closing = "</system-reminder>";
    while content.to_ascii_lowercase().starts_with("<system-reminder>") {
        let Some(at) = content.to_ascii_lowercase().find(closing) else {
            return true;
        };
        content = mixdog_js::js_trim(&content[at + closing.len()..]);
    }
    content.is_empty()
}

pub fn is_injected_skill_body(m: &AgentMessage) -> bool {
    if m.role() != Role::User || is_imported(m) {
        return false;
    }
    m.source == Some(Source::Skill) || string_content(m).is_some_and(|c| mixdog_js::js_trim_start(c).starts_with("<skill>"))
}

fn is_synthetic_source(source: Option<Source>) -> bool {
    matches!(
        source,
        Some(
            Source::ScheduleResult
                | Source::TaskNotification
                | Source::GoalContinuation
                | Source::GoalCloseout
                | Source::CompactContext
                | Source::ActiveTurnContinuation
                | Source::CompactExecutionRecovery
                | Source::MaxOutputRecovery
                | Source::RefusalRecovery
                | Source::StreamCutRecovery
        )
    )
}

/// The human's own instruction, as opposed to summaries and runtime-injected
/// turns.
pub fn is_actual_user_instruction(m: &AgentMessage) -> bool {
    if m.role() != Role::User || is_summary_message(m) || is_protected_context_user(m) || is_injected_skill_body(m) {
        return false;
    }
    let text = user_text(m);
    if is_imported(m) {
        return !mixdog_js::js_trim(&text).is_empty();
    }
    let trimmed = mixdog_js::js_trim_start(&text);
    if REFERENCE_FILES.is_match(trimmed)
        || SYNTHETIC_CONTROL.is_match(trimmed)
        || is_internal_runtime_notification(&text)
        || is_model_visible_tool_completion_wrapper(&text)
        || is_synthetic_source(m.source)
    {
        return false;
    }
    !mixdog_js::js_trim(&text).is_empty() || matches!(&m.message.content, Content::Parts(p) if !p.is_empty())
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SyntheticKind {
    RuntimeControl,
    CompactState,
    ContextAttachment,
}

impl SyntheticKind {
    fn name(self) -> &'static str {
        match self {
            Self::RuntimeControl => "runtime-control",
            Self::CompactState => "compact-state",
            Self::ContextAttachment => "context-attachment",
        }
    }
}

/// `None` for a real user instruction (or nothing to wrap).
pub fn classify_synthetic_user(m: &AgentMessage) -> Option<SyntheticKind> {
    if m.role() != Role::User || is_imported(m) {
        return None;
    }
    let text = user_text(m);
    if mixdog_js::js_trim(&text).is_empty() {
        return None;
    }
    if ENVELOPE_OPEN.is_match(&text) || parse_task_notification(&text).is_some() {
        return None;
    }
    let trimmed = mixdog_js::js_trim_start(&text);
    let control_source = matches!(m.source, Some(Source::MaxOutputRecovery | Source::RefusalRecovery | Source::StreamCutRecovery | Source::TaskNotification));
    if control_source || RUNTIME_CONTROL_TEXT.is_match(trimmed) {
        return Some(SyntheticKind::RuntimeControl);
    }
    if is_actual_user_instruction(m) {
        return None;
    }
    if is_summary_message(m)
        || m.source == Some(Source::ActiveTurnContinuation)
        || text.contains(ACTIVE_TURN_CONTINUATION_ANCHOR)
        || COMPACT_STATE_TEXT.is_match(trimmed)
    {
        return Some(SyntheticKind::CompactState);
    }
    if is_injected_skill_body(m) || CONTEXT_ATTACHMENT_TEXT.is_match(trimmed) {
        return Some(SyntheticKind::ContextAttachment);
    }
    Some(SyntheticKind::RuntimeControl)
}

fn open_tag(kind: SyntheticKind) -> String {
    format!("<{TAG} kind=\"{}\">\n", kind.name())
}

fn close_tag() -> String {
    format!("\n</{TAG}>")
}

fn envelope_content(content: &Content, kind: SyntheticKind) -> Content {
    match content {
        Content::Text(text) => Content::Text(format!("{}{text}{}", open_tag(kind), close_tag())),
        Content::Parts(parts) => {
            let texts: Vec<usize> = parts.iter().enumerate().filter(|(_, p)| matches!(p, ContentPart::Text(_, _))).map(|(i, _)| i).collect();
            let (Some(&first), Some(&last)) = (texts.first(), texts.last()) else {
                return content.clone();
            };
            Content::Parts(
                parts
                    .iter()
                    .enumerate()
                    .map(|(i, part)| match part {
                        ContentPart::Text(t, _) if i == first || i == last => {
                            let open = if i == first { open_tag(kind) } else { String::new() };
                            let close = if i == last { close_tag() } else { String::new() };
                            ContentPart::Text(format!("{open}{t}{close}"), None)
                        }
                        other => other.clone(),
                    })
                    .collect(),
            )
        }
    }
}

/// The wire messages of a transcript: synthetic user rows wrapped, the rest
/// lowered unchanged.
pub fn project_for_wire(messages: &[AgentMessage]) -> Vec<Message> {
    messages
        .iter()
        .map(|m| {
            let mut wire = m.wire();
            if let Some(kind) = classify_synthetic_user(m) {
                let restart = mixdog_js::js_trim(&user_text(m)) == PROCESS_RESTART_MARKER;
                let restart_text;
                let source = if restart {
                    restart_text = Content::Text(PROCESS_RESTART_WIRE_TEXT.to_owned());
                    &restart_text
                } else {
                    &m.message.content
                };
                wire.content = envelope_content(source, kind);
            }
            wire
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wrapped(m: &AgentMessage) -> String {
        match project_for_wire(std::slice::from_ref(m)).remove(0).content {
            Content::Text(t) => t,
            Content::Parts(_) => String::new(),
        }
    }

    #[test]
    fn real_prompts_stay_bare_and_runtime_rows_are_wrapped() {
        assert_eq!(wrapped(&AgentMessage::user("fix the bug")), "fix the bug");
        assert_eq!(
            wrapped(&AgentMessage::user("[mixdog-runtime] Empty response (1/3).")),
            "<mixdog-runtime kind=\"runtime-control\">\n[mixdog-runtime] Empty response (1/3).\n</mixdog-runtime>"
        );
        assert!(wrapped(&AgentMessage::sourced(Source::CompactSummary, "x")).contains("kind=\"compact-state\""));
        assert!(wrapped(&AgentMessage::user("<skill>body</skill>")).contains("kind=\"context-attachment\""));
        // a steering message is the human's own voice
        assert_eq!(wrapped(&AgentMessage::sourced(Source::Steering, "also b")), "also b");
    }

    /// `İ` lower-cases to three bytes from two: the text after the envelope must be cut where the envelope ends, not one
    /// byte later (which lands inside `é`).
    #[test]
    fn a_reminder_envelope_is_cut_at_its_own_closing_tag_whatever_it_holds() {
        let only_reminders = AgentMessage::user("<system-reminder>İ</system-reminder>\n<SYSTEM-REMINDER>b</System-Reminder>");
        assert!(is_protected_context_user(&only_reminders));
        let with_prompt = AgentMessage::user("<system-reminder>İ</system-reminder>é prompt");
        assert!(!is_protected_context_user(&with_prompt));
    }

    #[test]
    fn restart_marker_names_the_restart_on_the_wire() {
        let text = wrapped(&AgentMessage::user(PROCESS_RESTART_MARKER));
        assert!(text.contains("The app restarted mid-turn. Continue from where you left off."));
    }
}
