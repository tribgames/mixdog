//! Codex CLI rollout (`rollout-*.jsonl`) → raw import turns. Kept: the first `session_meta`
//! (foreign id, cwd), user/assistant `message` items as text and tool calls as tool notes.
//! Dropped: developer/system messages, Codex's own wrapper user messages, tool outputs,
//! reasoning, event messages, token counts and turn context.

use serde_json::Value;

use super::turns::{
    IMAGE_OMITTED_TEXT, Part, RawTurn, Role, Stamp, WARNING_IMAGE_OMITTED, is_whole_element, string_or_null, utf16_len,
};

/// User-role envelopes Codex injects itself.
const ENVELOPE_TAGS: [&str; 8] = [
    "environment_context",
    "user_instructions",
    "turn_aborted",
    "recommended_plugins",
    "user_shell_command",
    "subagent_notification",
    "skills_instructions",
    "external_codex_apps_open_page",
];
const TOOL_CALL_TYPES: [&str; 3] = ["function_call", "custom_tool_call", "local_shell_call"];
/// Codex shows a user message after the last of these headings.
const USER_REQUEST_HEADING: &str = "## My request for Codex:";
const ENTRY_OVERHEAD_BYTES: usize = 64;

fn is_envelope_text(text: &str) -> bool {
    let trimmed = mixdog_js::js_trim(text);
    if trimmed.is_empty() {
        return true;
    }
    static RE: std::sync::OnceLock<(mixdog_js::JsRegex, mixdog_js::JsRegex)> = std::sync::OnceLock::new();
    let (agents, image) = RE.get_or_init(|| {
        (
            mixdog_js::JsRegex::new_static(r"^# AGENTS\.md instructions\b", ""),
            // The `<image name=…>` text part that wraps an input_image.
            mixdog_js::JsRegex::new_static(r"^<image\b[^>]*>$", ""),
        )
    });
    (agents.is_match(trimmed) && trimmed.contains("<INSTRUCTIONS>"))
        || is_whole_element(trimmed, &ENVELOPE_TAGS)
        || image.is_match(trimmed)
        || trimmed == "</image>"
}

fn user_display_text(text: &str) -> String {
    match text.rfind(USER_REQUEST_HEADING) {
        Some(at) => mixdog_js::js_trim(&text[at + USER_REQUEST_HEADING.len()..]).to_owned(),
        None => text.to_owned(),
    }
}

fn message_parts(payload: &Value, warnings: &mut Vec<String>) -> Vec<Part> {
    let role_is_user = payload.get("role").and_then(Value::as_str) == Some("user");
    let items: Vec<Value> = match payload.get("content") {
        Some(Value::String(s)) => vec![serde_json::json!({"type": "text", "text": s})],
        Some(Value::Array(a)) => a.clone(),
        _ => return Vec::new(),
    };
    let mut parts = Vec::new();
    for item in &items {
        if !item.is_object() {
            continue;
        }
        let kind = item.get("type").and_then(Value::as_str);
        if matches!(kind, Some("input_image" | "image")) {
            if !warnings.iter().any(|w| w == WARNING_IMAGE_OMITTED) {
                warnings.push(WARNING_IMAGE_OMITTED.to_owned());
            }
            parts.push(Part::text(IMAGE_OMITTED_TEXT));
            continue;
        }
        let Some(text) = item.get("text").and_then(Value::as_str) else { continue };
        if !role_is_user {
            parts.push(Part::text(text));
        } else if !is_envelope_text(text) {
            parts.push(Part::text(user_display_text(text)));
        }
    }
    parts
}

fn tool_name(payload: &Value) -> String {
    match payload.get("name").and_then(Value::as_str) {
        Some(name) if !mixdog_js::js_trim(name).is_empty() => name.to_owned(),
        _ if payload.get("type").and_then(Value::as_str) == Some("local_shell_call") => "local_shell".to_owned(),
        _ => String::new(),
    }
}

/// What kind of Codex-internal record a `session_meta` payload marks, else `None` for a
/// conversation the user had.
fn internal_kind(thread_source: Option<&str>, source: Option<&Value>) -> Option<String> {
    match thread_source {
        Some("subagent") => return Some("subagent".into()),
        Some("guardian_review") => return Some("guardianReview".into()),
        Some("memory_consolidation") => return Some("internal".into()),
        _ => {}
    }
    let source = source?.as_object()?;
    if let Some(sub) = source.get("subagent") {
        let guardian = sub.get("other").and_then(Value::as_str) == Some("guardian");
        return Some(if guardian { "guardianReview" } else { "subagent" }.into());
    }
    if let Some(internal) = source.get("internal") {
        return Some(if internal.as_str() == Some("guardian") { "guardianReview" } else { "internal" }.into());
    }
    None
}

pub struct CodexResult {
    pub recognized: bool,
    pub foreign_session_id: Option<String>,
    pub cwd: Option<String>,
    pub internal_kind: Option<String>,
    pub history_base: Option<Value>,
    pub raw_turns: Vec<RawTurn>,
    pub warnings: Vec<String>,
}

/// Incremental reducer: `push` keeps only the plain-text parts of one record.
#[derive(Default)]
pub struct CodexReducer {
    warnings: Vec<String>,
    raw_turns: Vec<RawTurn>,
    recognized: bool,
    foreign_session_id: Option<String>,
    cwd: Option<String>,
    internal_kind: Option<String>,
    history_base: Option<Value>,
    meta_seen: bool,
    chars: usize,
    metadata_bytes: usize,
}

impl CodexReducer {
    pub fn chars(&self) -> usize {
        self.chars
    }
    pub fn entries(&self) -> usize {
        self.raw_turns.len()
    }
    pub fn metadata_bytes(&self) -> usize {
        self.metadata_bytes
    }

    fn keep(&mut self, role: Role, parts: Vec<Part>, at: Option<Stamp>) {
        self.chars += parts.iter().map(|p| utf16_len(&p.text)).sum::<usize>();
        self.metadata_bytes += ENTRY_OVERHEAD_BYTES + at.as_ref().map_or(0, Stamp::text_len);
        self.raw_turns.push(RawTurn { role, parts, at });
    }

    /// `inherited` records come from a history base: its session metadata is not this thread's.
    pub fn push(&mut self, record: &Value, inherited: bool) {
        let Some(payload) = record.get("payload").filter(|p| p.is_object()) else { return };
        let kind = record.get("type").and_then(Value::as_str);
        if kind == Some("session_meta") {
            if inherited {
                return;
            }
            self.recognized = true;
            if !self.meta_seen {
                self.meta_seen = true;
                self.foreign_session_id = string_or_null(payload.get("id")).or_else(|| string_or_null(payload.get("session_id")));
                self.cwd = string_or_null(payload.get("cwd"));
                self.internal_kind = internal_kind(payload.get("thread_source").and_then(Value::as_str), payload.get("source"));
                if payload.get("history_base").is_some_and(Value::is_object) {
                    self.history_base = payload.get("history_base").cloned();
                }
            }
            return;
        }
        if kind != Some("response_item") {
            return;
        }
        self.recognized = true;
        let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
        let role = match payload.get("role").and_then(Value::as_str) {
            Some("user") => Some(Role::User),
            Some("assistant") => Some(Role::Assistant),
            _ => None,
        };
        let at = Stamp::from_json(record.get("timestamp"));
        if payload_type == "message" {
            if let Some(role) = role {
                let mut warnings = std::mem::take(&mut self.warnings);
                let parts = message_parts(payload, &mut warnings);
                self.warnings = warnings;
                if !parts.is_empty() {
                    self.keep(role, parts, at);
                }
            }
        } else if TOOL_CALL_TYPES.contains(&payload_type) {
            self.keep(Role::Assistant, vec![Part::tool_note(&tool_name(payload))], at);
        }
    }

    pub fn result(&self) -> CodexResult {
        CodexResult {
            recognized: self.recognized,
            foreign_session_id: self.foreign_session_id.clone(),
            cwd: self.cwd.clone(),
            internal_kind: self.internal_kind.clone(),
            history_base: self.history_base.clone(),
            raw_turns: self.raw_turns.clone(),
            warnings: self.warnings.clone(),
        }
    }
}

// ── bounded-prefix `session_meta` scan ───────────────────────────────────────

/// Index after the string starting at `i`, or `None` when the text ends inside it.
fn scan_string(text: &[u8], i: usize) -> Option<usize> {
    let mut j = i + 1;
    while j < text.len() {
        match text[j] {
            b'\\' => j += 1,
            b'"' => return Some(j + 1),
            _ => {}
        }
        j += 1;
    }
    None
}

/// Index after the JSON value starting at `i`, or `None` when the text ends inside it.
fn scan_value(text: &[u8], i: usize) -> Option<usize> {
    match text.get(i)? {
        b'"' => scan_string(text, i),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut j = i;
            while j < text.len() {
                match text[j] {
                    b'"' => j = scan_string(text, j)? - 1,
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Some(j + 1);
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            None
        }
        _ => {
            let end = text[i..]
                .iter()
                .position(|b| matches!(b, b',' | b'}' | b']') || b.is_ascii_whitespace())
                .map(|p| i + p)
                .unwrap_or(text.len());
            (end < text.len()).then_some(end)
        }
    }
}

type Fields = std::collections::HashMap<String, String>;

/// Complete top-level values (raw JSON text) of the record object and of its `payload` object
/// in a possibly cut-off line. Nested values are never inspected.
fn record_fields(text: &str) -> (Fields, Fields) {
    let bytes = text.as_bytes();
    let (mut top, mut payload) = (Fields::new(), Fields::new());
    fn walk(text: &str, bytes: &[u8], start: usize, target: &mut Fields, payload: Option<&mut Fields>) {
        let mut payload = payload;
        let mut j = start + 1;
        loop {
            while bytes.get(j).is_some_and(|b| *b == b',' || b.is_ascii_whitespace()) {
                j += 1;
            }
            if bytes.get(j) != Some(&b'"') {
                return;
            }
            let Some(key_end) = scan_string(bytes, j) else { return };
            let Ok(key) = serde_json::from_str::<String>(&text[j..key_end]) else { return };
            j = key_end;
            while bytes.get(j).is_some_and(u8::is_ascii_whitespace) {
                j += 1;
            }
            if bytes.get(j) != Some(&b':') {
                return;
            }
            j += 1;
            while bytes.get(j).is_some_and(u8::is_ascii_whitespace) {
                j += 1;
            }
            if key == "payload" && bytes.get(j) == Some(&b'{') {
                if let Some(p) = payload.take() {
                    return walk(text, bytes, j, p, None);
                }
            }
            let Some(end) = scan_value(bytes, j) else { return };
            target.insert(key, text[j..end].to_owned());
            j = end;
        }
    }
    if let Some(open) = text.find('{') {
        walk(text, bytes, open, &mut top, Some(&mut payload));
    }
    (top, payload)
}

fn json_or_null(raw: Option<&String>) -> Value {
    raw.and_then(|r| serde_json::from_str(r).ok()).unwrap_or(Value::Null)
}

pub struct TruncatedMeta {
    pub foreign_session_id: Option<String>,
    pub cwd: Option<String>,
    pub internal_kind: Option<String>,
}

/// id/cwd/internal kind of a `session_meta` first line cut off by a bounded prefix read, from
/// the payload fields that arrived whole. A marker that did not arrive whole leaves the record
/// unclassified.
pub fn codex_meta_from_truncated_line(line: &str) -> Option<TruncatedMeta> {
    let (top, payload) = record_fields(line);
    if json_or_null(top.get("type")).as_str() != Some("session_meta") {
        return None;
    }
    let field = |name: &str| string_or_null(Some(&json_or_null(payload.get(name))));
    let thread_source = field("thread_source");
    let source = json_or_null(payload.get("source"));
    Some(TruncatedMeta {
        foreign_session_id: field("id").or_else(|| field("session_id")),
        cwd: field("cwd"),
        internal_kind: internal_kind(thread_source.as_deref(), Some(&source)),
    })
}

/// Rollout id (UUID) a rollout file name ends with.
pub fn rollout_id_of(name: &str) -> Option<String> {
    static RE: std::sync::OnceLock<mixdog_js::JsRegex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        mixdog_js::JsRegex::new_static(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$", "i")
    });
    is_rollout_name(name).then(|| re.captures(name).and_then(|c| c.get(1).map(str::to_lowercase))).flatten()
}

pub const COMPRESSED_ROLLOUT_SUFFIX: &str = ".jsonl.zst";

/// A rollout name is, after dropping a `.zst` suffix, `rollout-` … `.jsonl` (case-sensitive).
pub fn is_rollout_name(name: &str) -> bool {
    let plain = if name.ends_with(COMPRESSED_ROLLOUT_SUFFIX) { &name[..name.len() - ".zst".len()] } else { name };
    plain.starts_with("rollout-") && plain.ends_with(".jsonl")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn msg(role: &str, text: &str) -> Value {
        json!({"type": "response_item", "timestamp": "2025-01-02T03:04:05Z",
               "payload": {"type": "message", "role": role, "content": [{"type": "input_text", "text": text}]}})
    }

    #[test]
    fn keeps_user_text_after_the_request_heading_and_drops_envelopes() {
        let mut r = CodexReducer::default();
        r.push(&json!({"type": "session_meta", "payload": {"id": "abc", "cwd": " /w "}}), false);
        r.push(&msg("user", "<environment_context>x</environment_context>"), false);
        r.push(&msg("user", "ide state\n## My request for Codex:\n fix it "), false);
        r.push(&msg("developer", "secret"), false);
        r.push(&json!({"type": "response_item", "payload": {"type": "local_shell_call"}}), false);
        let out = r.result();
        assert_eq!((out.foreign_session_id.as_deref(), out.cwd.as_deref()), (Some("abc"), Some("/w")));
        assert_eq!(out.raw_turns.len(), 2);
        assert_eq!(out.raw_turns[0].parts[0].text, "fix it");
        assert_eq!(out.raw_turns[1].parts[0].text, "[ran tool: local_shell]");
    }

    #[test]
    fn inherited_session_meta_is_not_this_threads() {
        let mut r = CodexReducer::default();
        r.push(&json!({"type": "session_meta", "payload": {"id": "base"}}), true);
        assert_eq!(r.result().foreign_session_id, None);
        assert!(!r.result().recognized);
    }

    #[test]
    fn internal_threads_are_marked() {
        let kind = |p: Value| {
            let mut r = CodexReducer::default();
            r.push(&json!({"type": "session_meta", "payload": p}), false);
            r.result().internal_kind
        };
        assert_eq!(kind(json!({"thread_source": "subagent"})).as_deref(), Some("subagent"));
        assert_eq!(kind(json!({"source": {"subagent": {"other": "guardian"}}})).as_deref(), Some("guardianReview"));
        assert_eq!(kind(json!({"source": {"internal": "x"}})).as_deref(), Some("internal"));
        assert_eq!(kind(json!({"source": "cli"})), None);
    }

    #[test]
    fn truncated_first_line_still_names_id_and_cwd() {
        let line = r#"{"timestamp":"t","type":"session_meta","payload":{"id":"i-1","cwd":"/p","source":{"subagent":"review"},"instructions":"long text that gets cu"#;
        let meta = codex_meta_from_truncated_line(line).unwrap();
        assert_eq!(meta.foreign_session_id.as_deref(), Some("i-1"));
        assert_eq!(meta.cwd.as_deref(), Some("/p"));
        assert_eq!(meta.internal_kind.as_deref(), Some("subagent"));
        assert!(codex_meta_from_truncated_line(r#"{"type":"event_msg","payload":{"id":"x"}}"#).is_none());
    }

    #[test]
    fn rollout_names() {
        let id = "0198a1b2-1111-2222-3333-444455556666";
        assert_eq!(rollout_id_of(&format!("rollout-2025-01-01T00-00-00-{id}.jsonl")).as_deref(), Some(id));
        assert_eq!(rollout_id_of(&format!("rollout-x-{id}.jsonl.zst")).as_deref(), Some(id));
        assert_eq!(rollout_id_of(&format!("other-{id}.jsonl")), None);
        assert!(!is_rollout_name("rollout-a.json"));
    }
}
