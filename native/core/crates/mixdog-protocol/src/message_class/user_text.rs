//! The text a restored user bubble shows (`transcript-restore/user-text.mjs`
//! `createUserTextRestore().text`, with `tool-result-text.mjs` `toolResultText`): paste and
//! file chips, `[Image: …]` lines, offloaded prompt bodies within the per-part and per-load
//! byte caps, and the visualize feedback rewrite.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;
use mixdog_js::js_trim_end;
use mixdog_js::json_stringify;
use mixdog_js::number_to_string;
use mixdog_js::slice_utf16;
use mixdog_js::string_to_number;
use mixdog_js::utf16_len;
use serde_json::Value;

use super::js::collapse_spaces;
use super::js::or_str;
use super::js::re;
use super::js::split_lines;
use super::js::str_of;
use super::js::string;
use super::js::truthy;

/// A failed blob read, as Node's error `code` tells them apart.
pub enum ReadError {
    /// `ENOENT`: nothing was read.
    Missing,
    /// Invalid, tampered or unreadable: the read counts against the load's budget.
    Other,
}

/// The attachment store (`readAttachmentTextWithin`).
pub trait Blobs {
    /// The blob's UTF-8 text when it holds at most `max_bytes`, else `None`.
    fn text_within(&self, hex: &str, max_bytes: u64) -> Result<Option<String>, ReadError>;
}

const FEEDBACK_OPEN: &str = "<visualize_feedback>";
const FEEDBACK_MAX_BYTES: u64 = 128 * 1024;
const PASTED_TEXT_MAX_BYTES: u64 = 1024 * 1024;
/// Blob bytes one transcript load may read for paste line counts and offloaded prompts.
pub const PASTED_LINE_READ_BUDGET_BYTES: u64 = 4 * 1024 * 1024;
const TOOL_RESULT_PART_MAX_DEPTH: usize = 12;
const TOOL_RESULT_JSON_FALLBACK_MAX: usize = 480;

static IMAGE_METADATA_LINE: LazyLock<JsRegex> =
    LazyLock::new(|| re(r"\[Image(?::| source:) [^\]\r\n]+\]\s*$", ""));
static FEEDBACK_BLOCK: LazyLock<JsRegex> =
    LazyLock::new(|| re(r"<visualize_feedback>\n([\s\S]*?)\n?<\/visualize_feedback>", "g"));
static CHOICE_LINE: LazyLock<JsRegex> = LazyLock::new(|| {
    let quoted = r#"("(?:[^"\\]|\\.)*")"#;
    re(
        &format!(r"· group: (?:{quoted}|\(none\)) → choice: {quoted}(?: \({quoted}\))?$"),
        "",
    )
});
static TWEAK_CHANGE: LazyLock<JsRegex> = LazyLock::new(|| re(r"^ {4}(.+?) \([^)]*\): (.*) \(was (.*)\)$", ""));
static PIN_HEAD: LazyLock<JsRegex> = LazyLock::new(|| re(r"^pin (\d+) · (.*)$", ""));
static PASTED_LINES: LazyLock<JsRegex> = LazyLock::new(|| re(r"· (\d+) lines?$", ""));
static ATTACHMENT_REF: LazyLock<JsRegex> = LazyLock::new(|| re(r"^[a-f0-9]{64}$", ""));

/// `isAttachmentReference(value)`: the reference's hex.
fn attachment_ref(part: &Value) -> Option<String> {
    if !part.is_object() {
        return None;
    }
    let reference = or_str(part.get("attachmentRef"), "");
    ATTACHMENT_REF.is_match(&reference).then_some(reference)
}

/// `isMediaReferencePart(part)`.
fn is_media_reference_part(part: &Value) -> bool {
    str_of(part, "type") == Some("text")
        && truthy(part.get("attachmentReference"))
        && part.get("text").is_some_and(Value::is_string)
}

fn unquote(value: Option<&str>) -> String {
    match value.filter(|v| !v.is_empty()).map(serde_json::from_str::<Value>) {
        Some(Ok(parsed)) => string(Some(&parsed)),
        _ => String::new(),
    }
}

struct Pin {
    n: String,
    label: String,
    note: String,
}

/// `feedbackDisplay(body)`: the live bubble's lines for one feedback block.
fn feedback_display(body: &str) -> String {
    let mut pins: Vec<Pin> = Vec::new();
    let mut choices: Vec<(String, String, String)> = Vec::new();
    let mut pin: Option<usize> = None;
    let mut note = false;
    let mut in_choices = false;
    let mut tweak_sets: Vec<Vec<String>> = Vec::new();
    let mut tweaks: Option<usize> = None;
    for line in body.split('\n') {
        if line.starts_with("tweaks (") {
            pin = None;
            in_choices = false;
            tweak_sets.push(Vec::new());
            tweaks = Some(tweak_sets.len() - 1);
            continue;
        }
        if let Some(set) = tweaks {
            if let Some(change) = TWEAK_CHANGE.captures(line) {
                let part = |i| change.get(i).unwrap_or_default();
                tweak_sets[set].push(format!("{}: {} (was {})", part(1), part(2), part(3)));
            } else if line.starts_with("  - tab: ") {
                tweak_sets.push(Vec::new());
                tweaks = Some(tweak_sets.len() - 1);
            } else {
                tweaks = None;
            }
            if tweaks.is_some() {
                continue;
            }
        }
        if let Some(head) = PIN_HEAD.captures(line) {
            pins.push(Pin {
                n: head.get(1).unwrap_or_default().to_owned(),
                label: head.get(2).unwrap_or_default().to_owned(),
                note: String::new(),
            });
            pin = Some(pins.len() - 1);
            note = false;
            in_choices = false;
            continue;
        }
        if line == "choices:" {
            pin = None;
            in_choices = true;
            continue;
        }
        if let Some(at) = pin {
            if let Some(text) = line.strip_prefix("  note: ") {
                pins[at].note = text.to_owned();
                note = true;
                continue;
            }
            if note && let Some(text) = line.strip_prefix("    ") {
                pins[at].note.push('\n');
                pins[at].note.push_str(text);
                continue;
            }
        }
        note = false;
        if in_choices && let Some(choice) = CHOICE_LINE.captures(line) {
            choices.push((unquote(choice.get(1)), unquote(choice.get(2)), unquote(choice.get(3))));
        }
    }
    let mut lines: Vec<String> = pins
        .iter()
        .map(|p| format!("📌 {} · {} — {}", p.n, p.label, collapse_spaces(&p.note)))
        .collect();
    if !choices.is_empty() {
        let picks: Vec<String> = choices
            .iter()
            .map(|(group, choice, label)| {
                let prefix = if group.is_empty() { String::new() } else { format!("{group}: ") };
                format!("{prefix}{}", if label.is_empty() { choice } else { label })
            })
            .collect();
        lines.push(format!("☑ {}", picks.join(", ")));
    }
    let changed: Vec<String> = tweak_sets.iter().filter(|s| !s.is_empty()).map(|s| s.join(", ")).collect();
    if !changed.is_empty() {
        lines.push(format!("🎚 {}", changed.join("; ")));
    }
    lines.join("\n")
}

fn with_visualize_feedback_display(text: String) -> String {
    if !text.contains(FEEDBACK_OPEN) {
        return text;
    }
    FEEDBACK_BLOCK.replace_all_with(&text, |caps| feedback_display(caps.get(1).unwrap_or_default()))
}

// ── toolResultText ───────────────────────────────────────────────────────────

fn join_part_texts(parts: &[Value], depth: usize) -> String {
    parts
        .iter()
        .map(|part| tool_result_part_text(part, depth))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `toolResultText(content)`.
pub fn tool_result_text(content: Option<&Value>) -> String {
    let content = match content {
        None | Some(Value::Null) => return String::new(),
        Some(Value::String(text)) => return text.clone(),
        Some(Value::Array(parts)) => return join_part_texts(parts, 0),
        Some(content) => content,
    };
    if content.is_object() {
        match content.get("content") {
            Some(Value::Array(parts)) => {
                let nested = join_part_texts(parts, 0);
                if !nested.is_empty() {
                    return nested;
                }
            }
            Some(inner @ Value::Object(_)) => {
                let nested = tool_result_part_text(inner, 0);
                if !nested.is_empty() {
                    return nested;
                }
            }
            _ => {}
        }
        if let Some(Value::Array(parts)) = content.get("parts") {
            let nested = join_part_texts(parts, 0);
            if !nested.is_empty() {
                return nested;
            }
        }
        let from_part = tool_result_part_text(content, 0);
        if !from_part.is_empty() {
            return from_part;
        }
        if str_of(content, "type") == Some("tool_result") {
            return String::new();
        }
        if let Some(Value::String(text)) = content.get("text") {
            return text.clone();
        }
        if let Some(Value::String(text)) = content.get("content") {
            return text.clone();
        }
    }
    json_stringify(content)
}

fn compact_object_fallback(part: &Value) -> String {
    if str_of(part, "type") == Some("tool_result") {
        return String::new();
    }
    let json = json_stringify(part);
    if json.is_empty() || json == "{}" {
        return String::new();
    }
    if utf16_len(&json) <= TOOL_RESULT_JSON_FALLBACK_MAX {
        return json;
    }
    format!("{}…", slice_utf16(&json, TOOL_RESULT_JSON_FALLBACK_MAX - 1))
}

fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn tool_result_part_text(part: &Value, depth: usize) -> String {
    if part.is_null() || depth > TOOL_RESULT_PART_MAX_DEPTH {
        return String::new();
    }
    if let Value::String(text) = part {
        return text.clone();
    }
    let kind = str_of(part, "type");
    if matches!(kind, Some("image" | "input_image")) {
        let media = [part.get("mimeType"), part.get("mediaType"), part.get("source").and_then(|s| s.get("media_type"))]
            .into_iter()
            .find(|v| truthy(*v))
            .flatten();
        return format!("[image: {}]", or_str(media, "image"));
    }
    if kind == Some("tool_result") {
        return match part.get("content") {
            Some(Value::String(text)) => text.clone(),
            Some(Value::Array(inner)) => join_part_texts(inner, depth + 1),
            Some(inner @ Value::Object(_)) => tool_result_part_text(inner, depth + 1),
            _ => String::new(),
        };
    }
    if matches!(kind, Some("text" | "output_text" | "input_text")) {
        return string(part.get("text"));
    }
    match part {
        Value::Array(parts) => join_part_texts(parts, depth + 1),
        Value::Object(_) => {
            if let Some(Value::Array(parts)) = part.get("content") {
                let nested = join_part_texts(parts, depth + 1);
                if !nested.is_empty() {
                    return nested;
                }
            }
            if let Some(inner @ (Value::Array(_) | Value::Object(_))) = part.get("content") {
                let nested = tool_result_part_text(inner, depth + 1);
                if !nested.is_empty() {
                    return nested;
                }
            }
            if let Some(Value::Array(parts)) = part.get("parts") {
                let nested = join_part_texts(parts, depth + 1);
                if !nested.is_empty() {
                    return nested;
                }
            }
            for key in ["text", "output", "message"] {
                if let Some(text) = non_empty_string(part.get(key)) {
                    return text.to_owned();
                }
            }
            if let Some(Value::String(text)) = part.get("content") {
                return text.clone();
            }
            let source = part.get("source");
            if source.and_then(|s| str_of(s, "type")) == Some("base64") && truthy(source.and_then(|s| s.get("data"))) {
                let source = source.expect("checked");
                let media = [source.get("media_type"), source.get("mediaType")].into_iter().find(|v| truthy(*v)).flatten();
                return format!("[image: {}]", or_str(media, "base64"));
            }
            compact_object_fallback(part)
        }
        _ => String::new(),
    }
}

// ── The user bubble ──────────────────────────────────────────────────────────

enum Entry {
    Text(String),
    /// A stored plain-text prompt part (its hex), read only when the prompt has no other text.
    Offloaded(String),
}

/// One transcript load's user-text projection: the blob reads share one byte budget.
pub struct UserText<'a> {
    blobs: &'a dyn Blobs,
    remaining: u64,
}

impl<'a> UserText<'a> {
    pub fn new(blobs: &'a dyn Blobs) -> Self {
        Self {
            blobs,
            remaining: PASTED_LINE_READ_BUDGET_BYTES,
        }
    }

    /// `offloadedPromptText(part, budget)`.
    fn offloaded_prompt_text(&mut self, hex: &str) -> String {
        let allowance = PASTED_TEXT_MAX_BYTES.min(self.remaining);
        if allowance == 0 {
            return String::new();
        }
        match self.blobs.text_within(hex, allowance) {
            Ok(Some(text)) => {
                self.remaining -= text.len() as u64;
                text
            }
            Ok(None) | Err(ReadError::Missing) => String::new(),
            Err(ReadError::Other) => {
                self.remaining -= allowance;
                String::new()
            }
        }
    }

    /// `storedPasteLines(part, budget)`, formatted as Node prints the number.
    fn stored_paste_lines(&mut self, part: &Value, hex: &str) -> Option<String> {
        let filename = or_str(part.get("filename"), "");
        if let Some(named) = PASTED_LINES.captures(&filename) {
            return Some(number_to_string(string_to_number(named.get(1).unwrap_or_default())));
        }
        let allowance = PASTED_TEXT_MAX_BYTES.min(self.remaining);
        if allowance == 0 {
            return None;
        }
        match self.blobs.text_within(hex, allowance) {
            Ok(Some(read)) => {
                self.remaining -= read.len() as u64;
                let value = read.replace("\r\n", "\n").replace('\r', "\n");
                let value = value.trim_end_matches('\n');
                Some(if value.is_empty() { 0 } else { value.split('\n').count() }.to_string())
            }
            Ok(None) | Err(ReadError::Missing) => None,
            Err(ReadError::Other) => {
                self.remaining -= allowance;
                None
            }
        }
    }

    /// `storedTextToken(part, number, budget)`.
    fn stored_text_token(&mut self, part: &Value, hex: &str, number: usize) -> String {
        if str_of(part, "type") != Some("text") {
            return String::new();
        }
        match str_of(part, "textKind") {
            Some("paste") => match self.stored_paste_lines(part, hex) {
                Some(lines) => format!("[Pasted text #{number} +{lines} lines]"),
                None => format!("[Pasted text #{number}]"),
            },
            Some("file") => format!("[File #{number}: {}]", or_str(part.get("filename"), "attachment.txt")),
            _ => String::new(),
        }
    }

    /// `referencedFeedbackText(part)`: a stored text reference's body when it is a feedback block.
    fn referenced_feedback_text(&self, part: &Value, hex: &str) -> String {
        if str_of(part, "type") != Some("text") || truthy(part.get("textKind")) {
            return String::new();
        }
        match self.blobs.text_within(hex, FEEDBACK_MAX_BYTES) {
            Ok(Some(text)) if text.starts_with(FEEDBACK_OPEN) => text,
            _ => String::new(),
        }
    }

    /// `restoredUserParts(content, budget).texts`.
    fn parts(&mut self, content: &[Value]) -> Vec<String> {
        let mut texts: Vec<Entry> = Vec::new();
        let mut pending_metadata = String::new();
        let mut stored_texts = 0usize;
        let mut companion_text = false;
        for part in content {
            if is_media_reference_part(part) {
                continue;
            }
            let reference = attachment_ref(part);
            let token = match &reference {
                Some(hex) => self.stored_text_token(part, hex, stored_texts + 1),
                None => String::new(),
            };
            if !token.is_empty() {
                stored_texts += 1;
                texts.push(Entry::Text(token));
                pending_metadata.clear();
                continue;
            }
            if matches!(str_of(part, "type"), Some("image" | "input_image")) {
                if pending_metadata.is_empty() {
                    let media = [part.get("mimeType"), part.get("mediaType")].into_iter().find(|v| truthy(*v)).flatten();
                    texts.push(Entry::Text(format!("[Image: {}]", or_str(media, "image"))));
                }
                pending_metadata.clear();
                continue;
            }
            let text = match &reference {
                Some(hex) => self.referenced_feedback_text(part, hex),
                None => tool_result_text(Some(&Value::Array(vec![part.clone()]))),
            };
            let metadata = IMAGE_METADATA_LINE.is_match(&text);
            if !text.is_empty() {
                if !metadata {
                    companion_text = true;
                }
                texts.push(Entry::Text(text.clone()));
            } else if let Some(hex) = &reference
                && str_of(part, "type") == Some("text")
                && !truthy(part.get("textKind"))
            {
                texts.push(Entry::Offloaded(hex.clone()));
            }
            pending_metadata = if metadata {
                let last = split_lines(js_trim_end(&text)).pop().unwrap_or_default();
                js_trim(last).to_owned()
            } else {
                String::new()
            };
        }
        let mut resolved = Vec::new();
        for entry in texts {
            match entry {
                Entry::Text(text) => resolved.push(text),
                Entry::Offloaded(hex) if !companion_text => {
                    let text = self.offloaded_prompt_text(&hex);
                    if !text.is_empty() {
                        resolved.push(text);
                    }
                }
                Entry::Offloaded(_) => {}
            }
        }
        resolved
    }

    /// `createUserTextRestore().text(content)`.
    pub fn text(&mut self, content: Option<&Value>) -> String {
        match content {
            Some(Value::Array(parts)) => with_visualize_feedback_display(self.parts(parts).join("\n")),
            Some(Value::String(text)) => with_visualize_feedback_display(text.clone()),
            other => with_visualize_feedback_display(tool_result_text(other)),
        }
    }
}
