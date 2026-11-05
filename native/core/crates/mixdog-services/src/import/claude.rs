//! Claude Code project transcript (`projects/<dir>/<session>.jsonl`) → raw import turns. The
//! active branch is followed from the last main-chain entry back through `parentUuid` (and
//! `logicalParentUuid` across a compaction), so replayed or abandoned branches never duplicate.
//! Kept: text blocks and `tool_use` as tool notes; images become an omission marker; a
//! compaction summary (as an assistant recap) only when the history it replaced is gone; a slash
//! command as `/name args` unless the app answered it locally; pasted text without the app's
//! paste envelope. Dropped: sidechains, meta entries, tool results, thinking, signatures and
//! Claude Code's own command-output/notification envelopes.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde_json::Value;

use super::turns::{
    IMAGE_OMITTED_TEXT, Part, RawTurn, Role, Stamp, WARNING_IMAGE_OMITTED, is_whole_element, string_or_null,
    title_from_text, utf16_len,
};

const ENVELOPE_TAGS: [&str; 10] = [
    "local-command-stdout",
    "local-command-stderr",
    "local-command-caveat",
    "task-notification",
    "system-reminder",
    "user-prompt-submit-hook",
    "bash-input",
    "bash-stdout",
    "bash-stderr",
    "create-pr-command",
];
const LOCAL_OUTPUT_TAGS: [&str; 2] = ["local-command-stdout", "local-command-stderr"];
const SLASH_TAGS: [&str; 4] = ["command-name", "command-message", "command-args", "skill-format"];
const PASTE_OPEN: &str = "<pasted_content id=\"";
const ENTRY_OVERHEAD_BYTES: usize = 64;

/// `^(?:\s*<(tag)>[\s\S]*?</\1>)+\s*$` for the slash-command tags. Each element's body ends at
/// some later close tag of its own kind, so every candidate close is tried.
fn slash_command_envelope(text: &str) -> bool {
    fn elements(rest: &str, seen_one: bool) -> bool {
        let trimmed = mixdog_js::js_trim_start(rest);
        if seen_one && trimmed.is_empty() {
            return true;
        }
        for tag in SLASH_TAGS {
            let Some(after_open) = trimmed.strip_prefix(&format!("<{tag}>")) else { continue };
            let close = format!("</{tag}>");
            let mut from = 0;
            while let Some(at) = after_open[from..].find(&close) {
                let end = from + at + close.len();
                if elements(&after_open[end..], true) {
                    return true;
                }
                from += at + 1;
            }
        }
        false
    }
    elements(text, false)
}

/// Text with the app's paste envelopes unwrapped the way the app displays it. Only a complete
/// envelope with a matching four-hex id is unwrapped; any other `<pasted_content…>` is the
/// user's own text and stays as typed.
pub fn unwrap_claude_pastes(text: &str) -> String {
    let mut pieces: Vec<&str> = Vec::new();
    let (mut cursor, mut search) = (0usize, 0usize);
    loop {
        let Some(found) = text[search..].find(PASTE_OPEN) else { break };
        let open = search + found;
        let id_start = open + PASTE_OPEN.len();
        let body_start = id_start + 7; // past `hhhh">\n`
        let id = text.get(id_start..id_start + 4).unwrap_or("");
        let id_ok = id.len() == 4 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !id_ok || text.get(id_start + 4..body_start) != Some("\">\n") {
            search = id_start;
            continue;
        }
        let close_tag = format!("\n</pasted_content id=\"{id}\">");
        // The line feed ending the open tag may also start the close tag (an empty paste).
        let Some(close_rel) = text[body_start - 1..].find(&close_tag) else { break };
        let close = body_start - 1 + close_rel;
        let before = &text[cursor..open];
        pieces.push(if cursor > 0 { mixdog_js::js_trim(before) } else { mixdog_js::js_trim_end(before) });
        pieces.push(&text[body_start..close.max(body_start)]);
        cursor = close + close_tag.len();
        search = cursor;
    }
    if pieces.is_empty() {
        return text.to_owned();
    }
    pieces.push(mixdog_js::js_trim_start(&text[cursor..]));
    let unwrapped: Vec<&str> = pieces
        .iter()
        .enumerate()
        .filter(|(i, piece)| i % 2 == 1 || !piece.is_empty())
        .map(|(_, p)| *p)
        .collect();
    let unwrapped = unwrapped.join("\n");
    if mixdog_js::js_trim(&unwrapped).is_empty() { text.to_owned() } else { unwrapped }
}

fn is_envelope_text(text: &str) -> bool {
    static RE: OnceLock<(mixdog_js::JsRegex, mixdog_js::JsRegex)> = OnceLock::new();
    let (interrupted, image) = RE.get_or_init(|| {
        (
            mixdog_js::JsRegex::new_static(r"^\[Request interrupted by user[^\]\n]*\]$", ""),
            // The text annotation that accompanies a pasted image block.
            mixdog_js::JsRegex::new_static(r"^\[Image\b[^\n]*\]$", ""),
        )
    });
    let trimmed = mixdog_js::js_trim(text);
    trimmed.is_empty()
        || is_whole_element(trimmed, &ENVELOPE_TAGS)
        || slash_command_envelope(trimmed)
        || interrupted.is_match(trimmed)
        || image.is_match(trimmed)
}

fn tag_value(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let Some(start) = text.find(&open).map(|i| i + open.len()) else { return String::new() };
    match text[start..].find(&format!("</{tag}>")) {
        Some(end) => mixdog_js::js_trim(&text[start..start + end]).to_owned(),
        None => String::new(),
    }
}

/// A slash-command envelope as Claude Code shows it (`/name args`), else `None`.
fn command_text(text: &str) -> Option<String> {
    let trimmed = mixdog_js::js_trim(text);
    if !slash_command_envelope(trimmed) {
        return None;
    }
    let name = {
        let n = tag_value(trimmed, "command-name");
        if n.is_empty() { tag_value(trimmed, "command-message") } else { n }
    };
    let name = name.strip_prefix('/').unwrap_or(&name).to_owned();
    if name.is_empty() {
        return None;
    }
    let args = tag_value(trimmed, "command-args");
    Some(if args.is_empty() { format!("/{name}") } else { format!("/{name} {args}") })
}

struct Entry {
    uuid: Option<String>,
    parent_uuid: Option<String>,
    logical_parent_uuid: Option<String>,
    main: bool,
    role: Option<Role>,
    parts: Option<Vec<Part>>,
    warnings: Vec<String>,
    at: Option<Stamp>,
    seq: usize,
    summary: bool,
    local_output: bool,
}

/// The main-chain message written last before file position `seq`.
fn preceding_main(entries: &[Entry], seq: usize) -> Option<usize> {
    (0..seq).rev().find(|i| entries[*i].main && entries[*i].uuid.is_some())
}

/// The active branch, root first: walked back from the last main-chain entry. A compaction
/// boundary links back to the history it replaced through its logical parent, or, when Claude
/// Code never wrote that message, to the last message before the boundary. `replaced` holds the
/// compaction summaries whose history the walk crossed into.
fn active_chain(entries: &[Entry]) -> (Vec<usize>, HashSet<usize>) {
    let main: Vec<usize> = (0..entries.len()).filter(|i| entries[*i].main).collect();
    let Some(&leaf) = main.last() else { return (main, HashSet::new()) };
    if entries[leaf].uuid.is_none() {
        return (main, HashSet::new());
    }
    let mut by_uuid: HashMap<&str, usize> = HashMap::new();
    for (i, e) in entries.iter().enumerate() {
        if let Some(u) = &e.uuid {
            by_uuid.insert(u, i);
        }
    }
    let (mut chain, mut seen, mut replaced) = (Vec::new(), HashSet::new(), HashSet::new());
    let mut summary: Option<usize> = None;
    let mut current = Some(leaf);
    while let Some(i) = current {
        let uuid = entries[i].uuid.clone();
        if !seen.insert(uuid) {
            break;
        }
        chain.push(i);
        if entries[i].summary {
            summary = Some(i);
        }
        let parent = entries[i].parent_uuid.as_deref().and_then(|p| by_uuid.get(p).copied());
        let logical = if parent.is_none() {
            entries[i]
                .logical_parent_uuid
                .as_deref()
                .and_then(|p| by_uuid.get(p).copied().or_else(|| preceding_main(entries, entries[i].seq)))
        } else {
            None
        };
        if logical.is_some() {
            if let Some(s) = summary.take() {
                replaced.insert(s);
            }
        }
        current = parent.or(logical);
    }
    chain.reverse();
    (chain.into_iter().filter(|i| entries[*i].main).collect(), replaced)
}

/// Kept parts of a message; a slash command is a `command` part, a local command's output marks
/// `local_output`.
fn entry_parts(role: Role, content: Option<&Value>, warnings: &mut Vec<String>, local_output: &mut bool) -> Vec<Part> {
    let blocks: Vec<Value> = match content {
        Some(Value::String(s)) => vec![serde_json::json!({"type": "text", "text": s})],
        Some(Value::Array(a)) => a.clone(),
        _ => return Vec::new(),
    };
    let mut parts = Vec::new();
    for block in &blocks {
        if !block.is_object() {
            continue;
        }
        match block.get("type").and_then(Value::as_str) {
            Some("text") if block.get("text").is_some_and(Value::is_string) => {
                let text = block["text"].as_str().unwrap_or("");
                if role == Role::User {
                    if let Some(command) = command_text(text) {
                        let mut part = Part::text(command);
                        part.command = true;
                        parts.push(part);
                    }
                    if is_whole_element(text, &LOCAL_OUTPUT_TAGS) {
                        *local_output = true;
                    }
                    if is_envelope_text(text) {
                        continue;
                    }
                    parts.push(Part::text(unwrap_claude_pastes(text)));
                } else {
                    parts.push(Part::text(text));
                }
            }
            Some("image") => {
                if !warnings.iter().any(|w| w == WARNING_IMAGE_OMITTED) {
                    warnings.push(WARNING_IMAGE_OMITTED.to_owned());
                }
                parts.push(Part::text(IMAGE_OMITTED_TEXT));
            }
            Some("tool_use") if role == Role::Assistant => {
                parts.push(Part::tool_note(block.get("name").and_then(Value::as_str).unwrap_or("")));
            }
            _ => {}
        }
    }
    parts
}

/// The title Claude Code's resume list shows from the records it appends to a transcript: the
/// last `custom-title`, else the last `ai-title`, then the last `summary`, then the last
/// `last-prompt`. A blank custom title ends the name tier without falling back to the AI title.
#[derive(Default)]
struct TitleScan {
    custom: Option<String>,
    ai: Option<String>,
    summary: Option<String>,
    last_prompt: Option<String>,
}

impl TitleScan {
    fn push(&mut self, record: &Value) {
        let text = |key: &str| record.get(key).and_then(Value::as_str).map(str::to_owned);
        match record.get("type").and_then(Value::as_str) {
            Some("custom-title") => self.custom = text("customTitle").or_else(|| self.custom.take()),
            Some("ai-title") => self.ai = text("aiTitle").or_else(|| self.ai.take()),
            Some("summary") => self.summary = text("summary").or_else(|| self.summary.take()),
            Some("last-prompt") => self.last_prompt = text("lastPrompt").or_else(|| self.last_prompt.take()),
            _ => {}
        }
    }

    fn title(&self) -> Option<String> {
        let name = self.custom.as_ref().or(self.ai.as_ref());
        name.and_then(|t| title_from_text(t))
            .or_else(|| self.summary.as_deref().and_then(title_from_text))
            .or_else(|| self.last_prompt.as_deref().and_then(title_from_text))
    }
}

fn skipped_entry(record: &Value) -> bool {
    // Claude Code flags its compaction summary transcript-only as well.
    if record.get("isCompactSummary") == Some(&Value::Bool(true)) {
        return false;
    }
    ["isMeta", "isVisibleInTranscriptOnly", "isApiErrorMessage"]
        .iter()
        .any(|k| record.get(*k) == Some(&Value::Bool(true)))
}

pub struct ClaudeResult {
    pub recognized: bool,
    pub foreign_session_id: Option<String>,
    pub cwd: Option<String>,
    pub internal_kind: Option<String>,
    pub raw_turns: Vec<RawTurn>,
    pub warnings: Vec<String>,
    pub stored_title: Option<String>,
}

/// Incremental reducer: `push` keeps a compact chain entry (uuid links plus the plain-text parts
/// of a main-chain message) and drops the record itself.
#[derive(Default)]
pub struct ClaudeReducer {
    entries: Vec<Entry>,
    title_scan: TitleScan,
    recognized: bool,
    foreign_session_id: Option<String>,
    cwd: Option<String>,
    sidechain_seen: bool,
    main_seen: bool,
    chars: usize,
    metadata_bytes: usize,
}

impl ClaudeReducer {
    pub fn chars(&self) -> usize {
        self.chars
    }
    pub fn entries(&self) -> usize {
        self.entries.len()
    }
    pub fn metadata_bytes(&self) -> usize {
        self.metadata_bytes
    }

    /// Cheap running check: messages seen so far are all sidechain (a verdict only at the end of
    /// the file).
    pub fn sidechain_only(&self) -> bool {
        self.sidechain_seen && !self.main_seen
    }

    /// Feeds a record for its stored title only (a transcript's tail window).
    pub fn push_title(&mut self, record: &Value) {
        self.title_scan.push(record);
    }

    pub fn push(&mut self, record: &Value) {
        self.title_scan.push(record);
        let message = matches!(record.get("type").and_then(Value::as_str), Some("user" | "assistant"));
        if message {
            self.recognized = true;
        }
        let main = message && record.get("isSidechain") != Some(&Value::Bool(true));
        if message {
            if main {
                self.main_seen = true;
            } else {
                self.sidechain_seen = true;
            }
        }
        if main {
            if self.foreign_session_id.is_none() {
                self.foreign_session_id = string_or_null(record.get("sessionId"));
            }
            if self.cwd.is_none() {
                self.cwd = string_or_null(record.get("cwd"));
            }
        }
        let text = |key: &str| record.get(key).and_then(Value::as_str).map(str::to_owned);
        let uuid = text("uuid");
        if !main && uuid.is_none() {
            return;
        }
        let mut entry = Entry {
            uuid,
            parent_uuid: text("parentUuid"),
            logical_parent_uuid: text("logicalParentUuid"),
            main,
            role: None,
            parts: None,
            warnings: Vec::new(),
            at: Stamp::from_json(record.get("timestamp")),
            seq: self.entries.len(),
            summary: false,
            local_output: false,
        };
        let len = |s: &Option<String>| s.as_deref().map_or(0, utf16_len);
        self.metadata_bytes += ENTRY_OVERHEAD_BYTES
            + len(&entry.uuid)
            + len(&entry.parent_uuid)
            + len(&entry.logical_parent_uuid)
            + entry.at.as_ref().map_or(0, Stamp::text_len);
        if main && !skipped_entry(record) {
            let body = record.get("message").filter(|m| m.is_object());
            let role = match body.and_then(|b| b.get("role")).and_then(Value::as_str) {
                Some("user") => Role::User,
                Some("assistant") => Role::Assistant,
                _ if record.get("type").and_then(Value::as_str) == Some("assistant") => Role::Assistant,
                _ => Role::User,
            };
            entry.role = Some(role);
            let mut parts = entry_parts(role, body.and_then(|b| b.get("content")), &mut entry.warnings, &mut entry.local_output);
            if record.get("isCompactSummary") == Some(&Value::Bool(true)) {
                entry.summary = true;
                for part in &mut parts {
                    part.summary = true;
                }
            }
            self.chars += parts.iter().map(|p| utf16_len(&p.text)).sum::<usize>();
            entry.parts = Some(parts);
        }
        self.entries.push(entry);
    }

    pub fn result(&self) -> ClaudeResult {
        let mut warnings: Vec<String> = Vec::new();
        let mut raw_turns = Vec::new();
        let (chain, replaced) = active_chain(&self.entries);
        for (index, &i) in chain.iter().enumerate() {
            let entry = &self.entries[i];
            let Some(parts) = entry.parts.as_ref().filter(|p| !p.is_empty()) else { continue };
            // The summary stands in for history only when that history is gone, and then as the
            // model's recap, never as something the user wrote.
            if entry.summary && replaced.contains(&i) {
                continue;
            }
            let role = if entry.summary { Role::Assistant } else { entry.role.unwrap_or(Role::User) };
            // A local command answered by the app itself is not part of the conversation.
            let local = parts.iter().any(|p| p.command)
                && chain[index + 1..]
                    .iter()
                    .map(|n| &self.entries[*n])
                    .find(|n| n.parts.as_ref().is_some_and(|p| !p.is_empty()) || n.local_output)
                    .is_some_and(|n| n.local_output);
            let parts: Vec<Part> = if local { parts.iter().filter(|p| !p.command).cloned().collect() } else { parts.clone() };
            if parts.is_empty() {
                continue;
            }
            raw_turns.push(RawTurn { role, parts, at: entry.at.clone() });
            for code in &entry.warnings {
                if !warnings.contains(code) {
                    warnings.push(code.clone());
                }
            }
        }
        ClaudeResult {
            recognized: self.recognized,
            foreign_session_id: self.foreign_session_id.clone(),
            cwd: self.cwd.clone(),
            // A transcript whose every message is a sidechain is a subagent's own.
            internal_kind: self.sidechain_only().then(|| "subagent".to_owned()),
            raw_turns,
            warnings,
            stored_title: self.title_scan.title(),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn rec(kind: &str, uuid: &str, parent: Option<&str>, content: Value) -> Value {
        json!({"type": kind, "uuid": uuid, "parentUuid": parent, "sessionId": "s1", "cwd": "/w",
               "timestamp": "2025-01-02T03:04:05Z", "message": {"role": kind, "content": content}})
    }

    fn texts(r: &ClaudeReducer) -> Vec<(Role, String)> {
        r.result().raw_turns.iter().map(|t| (t.role, t.parts.iter().map(|p| p.text.clone()).collect::<Vec<_>>().join("|"))).collect()
    }

    #[test]
    fn follows_the_active_branch_and_drops_abandoned_ones() {
        let mut r = ClaudeReducer::default();
        r.push(&rec("user", "a", None, json!("hello")));
        r.push(&rec("assistant", "b", Some("a"), json!([{"type": "text", "text": "old branch"}])));
        r.push(&rec("assistant", "c", Some("a"), json!([{"type": "text", "text": "new"}, {"type": "tool_use", "name": "Read"}])));
        assert_eq!(
            texts(&r),
            vec![(Role::User, "hello".into()), (Role::Assistant, "new|[ran tool: Read]".into())]
        );
        assert_eq!(r.result().foreign_session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn envelopes_are_dropped_and_slash_commands_kept() {
        let mut r = ClaudeReducer::default();
        r.push(&rec("user", "a", None, json!("<system-reminder>x</system-reminder>")));
        r.push(&rec(
            "user",
            "b",
            Some("a"),
            json!("<command-name>/model</command-name><command-args>opus</command-args>"),
        ));
        let turns = r.result().raw_turns;
        assert_eq!(turns.len(), 1);
        assert!(turns[0].parts[0].command && turns[0].parts[0].text == "/model opus");
    }

    #[test]
    fn local_command_answered_by_the_app_is_dropped() {
        let mut r = ClaudeReducer::default();
        r.push(&rec("user", "a", None, json!("<command-name>/cost</command-name>")));
        r.push(&rec("user", "b", Some("a"), json!("<local-command-stdout>$1</local-command-stdout>")));
        r.push(&rec("user", "c", Some("b"), json!("real question")));
        assert_eq!(texts(&r), vec![(Role::User, "real question".into())]);
    }

    #[test]
    fn sidechain_only_transcript_is_a_subagent() {
        let mut r = ClaudeReducer::default();
        let mut side = rec("user", "a", None, json!("x"));
        side["isSidechain"] = json!(true);
        r.push(&side);
        assert!(r.sidechain_only());
        assert_eq!(r.result().internal_kind.as_deref(), Some("subagent"));
    }

    #[test]
    fn stored_title_tiers() {
        let mut r = ClaudeReducer::default();
        r.push_title(&json!({"type": "last-prompt", "lastPrompt": "prompt"}));
        r.push_title(&json!({"type": "ai-title", "aiTitle": "ai"}));
        assert_eq!(r.result().stored_title.as_deref(), Some("ai"));
        r.push_title(&json!({"type": "custom-title", "customTitle": "  "}));
        assert_eq!(r.result().stored_title.as_deref(), Some("prompt"));
    }

    #[test]
    fn paste_envelopes_unwrap_only_when_complete_and_matching() {
        let wrapped = "see <pasted_content id=\"ab12\">\nBODY\n</pasted_content id=\"ab12\"> done";
        assert_eq!(unwrap_claude_pastes(wrapped), "see\nBODY\ndone");
        let bad = "<pasted_content id=\"ab12\">\nBODY\n</pasted_content id=\"ffff\">";
        assert_eq!(unwrap_claude_pastes(bad), bad);
    }

    #[test]
    fn slash_envelope_matches_whole_text_only() {
        assert!(slash_command_envelope("<command-name>/a</command-name>\n<command-args></command-args>"));
        assert!(!slash_command_envelope("<command-name>/a</command-name> trailing"));
        assert!(!slash_command_envelope(""));
    }
}
