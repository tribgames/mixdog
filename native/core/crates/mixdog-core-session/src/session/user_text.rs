//! The text a user row shows for a stored prompt (today's `createUserTextRestore().text`,
//! `transcript-restore/user-text.mjs`, with `toolResultText` of `tool-result-text.mjs`): the
//! row's `displayText`, computed once when the record is written (the session at commit,
//! the migration for 1.4.5 history) and never re-derived from text afterwards.
//!
//! - A stored pasted or attached text shows as its chip token (`[Pasted text #n +N lines]`,
//!   `[File #n: name]`).
//! - An image part is drawn by the composer's `[Image: …]` metadata line before it, else by a
//!   line of its own.
//! - A `<visualize_feedback>` block shows as the pin, pick and tweak lines of the live bubble.
//! - Plain text the intake moved into the store is read back in place when it is the prompt's
//!   only real text, within the load's byte budget.

use std::sync::LazyLock;

pub use mixdog_js::js_trim;
use mixdog_js::JsRegex;
use mixdog_js::js_trim_end;
use mixdog_js::json_stringify;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use serde_json::Value;

const FEEDBACK_OPEN: &str = "<visualize_feedback>";
/// A larger referenced block is a long prompt or paste, never read as feedback.
const FEEDBACK_MAX_BYTES: usize = 128 * 1024;
const PASTED_TEXT_MAX_BYTES: usize = 1024 * 1024;
/// Blob bytes one projection may read for paste line counts and offloaded text.
pub const PASTED_LINE_READ_BUDGET_BYTES: usize = 4 * 1024 * 1024;
const TOOL_RESULT_PART_MAX_DEPTH: usize = 12;
const TOOL_RESULT_JSON_FALLBACK_MAX: usize = 480;

static IMAGE_METADATA_LINE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\[Image(?::| source:) [^\]\r\n]+\]\s*$", ""));
static FEEDBACK_BLOCK: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(r"<visualize_feedback>\n([\s\S]*?)\n?<\/visualize_feedback>", "g")
});
static CHOICE_LINE: LazyLock<JsRegex> = LazyLock::new(|| {
    let quoted = r#"("(?:[^"\\]|\\.)*")"#;
    JsRegex::new_static(
        &format!(r"· group: (?:{quoted}|\(none\)) → choice: {quoted}(?: \({quoted}\))?$"),
        "",
    )
});
static TWEAK_CHANGE: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^ {4}(.+?) \([^)]*\): (.*) \(was (.*)\)$", ""));
static PIN_HEAD: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^pin (\d+) · (.*)$", ""));
static PASTED_LINES: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"· (\d+) lines?$", ""));
static ATTACHMENT_REF: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"^[a-f0-9]{64}$", ""));
static WHITESPACE_RUN: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\s+", "g"));

/// Why a referenced blob could not be read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadFailure {
    /// The blob is gone: nothing was read.
    Missing,
    /// Invalid, tampered or unreadable: the read counts against the budget.
    Failed,
}

/// Reads a referenced blob's UTF-8 text (`readAttachmentTextWithin`): `Ok(None)` when the blob
/// holds more than `max_bytes`.
pub trait AttachmentText {
    fn read_within(&mut self, attachment_ref: &str, max_bytes: usize)
    -> Result<Option<String>, ReadFailure>;
}

/// No blob is readable: chips without a stored count show as `[Pasted text #n]` and offloaded
/// text stays out, as for a blob that is gone. A queued prompt's row is drawn so: the pastes the
/// `turn/start` intake stored show without their line count.
pub struct NoAttachments;

impl AttachmentText for NoAttachments {
    fn read_within(&mut self, _: &str, _: usize) -> Result<Option<String>, ReadFailure> {
        Err(ReadFailure::Missing)
    }
}

/// The display text of a stored user `content` (string or parts), trimmed: the user row's
/// `text`. `reader` and `budget` (bytes, `PASTED_LINE_READ_BUDGET_BYTES` per projection) bound
/// the blob reads.
pub fn user_display_text(
    content: &Value,
    reader: &mut dyn AttachmentText,
    budget: &mut usize,
) -> String {
    let text = match content {
        Value::Array(parts) => restored_user_parts(parts, reader, budget).join("\n"),
        Value::String(text) => text.clone(),
        other => tool_result_text(other),
    };
    js_trim(&with_visualize_feedback_display(&text)).to_owned()
}

fn str_field<'a>(part: &'a Value, key: &str) -> &'a str {
    part.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// `isAttachmentReference`.
fn is_attachment_reference(part: &Value) -> bool {
    part.is_object() && ATTACHMENT_REF.is_match(str_field(part, "attachmentRef"))
}

/// `isMediaReferencePart`: a model-facing reference text standing for a media part.
fn is_media_reference_part(part: &Value) -> bool {
    part.get("type").and_then(Value::as_str) == Some("text")
        && part.get("attachmentReference").is_some_and(truthy)
        && part.get("text").is_some_and(Value::is_string)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `a || b || c` over string fields.
fn first_nonempty<'a>(part: &'a Value, keys: &[&str], fallback: &'a str) -> &'a str {
    keys.iter()
        .map(|key| str_field(part, key))
        .find(|value| !value.is_empty())
        .unwrap_or(fallback)
}

enum Entry {
    Text(String),
    Offloaded(String),
}

fn restored_user_parts(
    content: &[Value],
    reader: &mut dyn AttachmentText,
    budget: &mut usize,
) -> Vec<String> {
    let mut texts: Vec<Entry> = Vec::new();
    let mut pending_metadata = String::new();
    let mut stored_texts = 0usize;
    let mut companion_text = false;
    for part in content {
        if is_media_reference_part(part) {
            continue;
        }
        let token = if is_attachment_reference(part) {
            stored_text_token(part, stored_texts + 1, reader, budget)
        } else {
            String::new()
        };
        if !token.is_empty() {
            stored_texts += 1;
            texts.push(Entry::Text(token));
            pending_metadata.clear();
            continue;
        }
        let kind = str_field(part, "type");
        if kind == "image" || kind == "input_image" {
            if pending_metadata.is_empty() {
                let mime = first_nonempty(part, &["mimeType", "mediaType"], "image");
                texts.push(Entry::Text(format!("[Image: {mime}]")));
            }
            pending_metadata.clear();
            continue;
        }
        let text = if is_attachment_reference(part) {
            referenced_feedback_text(part, reader)
        } else {
            tool_result_part_text(part, 0)
        };
        if !text.is_empty() {
            if !IMAGE_METADATA_LINE.is_match(&text) {
                companion_text = true;
            }
            texts.push(Entry::Text(text.clone()));
        } else if is_attachment_reference(part)
            && kind == "text"
            && !part.get("textKind").is_some_and(truthy)
        {
            texts.push(Entry::Offloaded(str_field(part, "attachmentRef").to_owned()));
        }
        pending_metadata = if IMAGE_METADATA_LINE.is_match(&text) {
            let end = js_trim_end(&text);
            let last = end.rsplit('\n').next().unwrap_or_default();
            js_trim(last.strip_suffix('\r').unwrap_or(last)).to_owned()
        } else {
            String::new()
        };
    }
    texts
        .into_iter()
        .filter_map(|entry| match entry {
            Entry::Text(text) => Some(text),
            Entry::Offloaded(_) if companion_text => None,
            Entry::Offloaded(reference) => {
                let text = offloaded_prompt_text(&reference, reader, budget);
                (!text.is_empty()).then_some(text)
            }
        })
        .collect()
}

/// `offloadedPromptText`.
fn offloaded_prompt_text(
    reference: &str,
    reader: &mut dyn AttachmentText,
    budget: &mut usize,
) -> String {
    let allowance = PASTED_TEXT_MAX_BYTES.min(*budget);
    if allowance == 0 {
        return String::new();
    }
    match reader.read_within(reference, allowance) {
        Ok(Some(text)) => {
            *budget = budget.saturating_sub(text.len());
            text
        }
        Ok(None) | Err(ReadFailure::Missing) => String::new(),
        Err(ReadFailure::Failed) => {
            *budget = budget.saturating_sub(allowance);
            String::new()
        }
    }
}

/// `storedPasteLines`: the visible line count, or `None` past the budget.
fn stored_paste_lines(
    part: &Value,
    reader: &mut dyn AttachmentText,
    budget: &mut usize,
) -> Option<usize> {
    if let Some(named) = PASTED_LINES.captures(str_field(part, "filename")) {
        return named.get(1).and_then(|n| n.parse().ok());
    }
    let allowance = PASTED_TEXT_MAX_BYTES.min(*budget);
    if allowance == 0 {
        return None;
    }
    match reader.read_within(str_field(part, "attachmentRef"), allowance) {
        Ok(Some(read)) => {
            *budget = budget.saturating_sub(read.len());
            let value = read.replace("\r\n", "\n").replace('\r', "\n");
            let value = value.trim_end_matches('\n');
            Some(if value.is_empty() { 0 } else { value.split('\n').count() })
        }
        Ok(None) | Err(ReadFailure::Missing) => None,
        Err(ReadFailure::Failed) => {
            *budget = budget.saturating_sub(allowance);
            None
        }
    }
}

/// `storedTextToken`.
fn stored_text_token(
    part: &Value,
    number: usize,
    reader: &mut dyn AttachmentText,
    budget: &mut usize,
) -> String {
    if str_field(part, "type") != "text" {
        return String::new();
    }
    match str_field(part, "textKind") {
        "paste" => match stored_paste_lines(part, reader, budget) {
            Some(lines) => format!("[Pasted text #{number} +{lines} lines]"),
            None => format!("[Pasted text #{number}]"),
        },
        "file" => format!(
            "[File #{number}: {}]",
            first_nonempty(part, &["filename"], "attachment.txt")
        ),
        _ => String::new(),
    }
}

/// `referencedFeedbackText`.
fn referenced_feedback_text(part: &Value, reader: &mut dyn AttachmentText) -> String {
    if str_field(part, "type") != "text" || part.get("textKind").is_some_and(truthy) {
        return String::new();
    }
    match reader.read_within(str_field(part, "attachmentRef"), FEEDBACK_MAX_BYTES) {
        Ok(Some(text)) if text.starts_with(FEEDBACK_OPEN) => text,
        _ => String::new(),
    }
}

/// `withVisualizeFeedbackDisplay`.
fn with_visualize_feedback_display(text: &str) -> String {
    if !text.contains(FEEDBACK_OPEN) {
        return text.to_owned();
    }
    FEEDBACK_BLOCK.replace_all_with(text, |caps| feedback_display(caps.get(1).unwrap_or_default()))
}

/// `String(JSON.parse(value))`, `''` for an absent or unparsable value.
fn unquote(value: Option<&str>) -> String {
    value
        .and_then(|v| serde_json::from_str::<Value>(v).ok())
        .map(|v| value_to_string(&v))
        .unwrap_or_default()
}

/// `feedbackDisplay`: the live bubble's lines for one feedback block body.
fn feedback_display(body: &str) -> String {
    struct Pin {
        n: String,
        label: String,
        note: String,
    }
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
                let group = |n| change.get(n).unwrap_or_default();
                tweak_sets[set].push(format!("{}: {} (was {})", group(1), group(2), group(3)));
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
        if let Some(index) = pin
            && let Some(rest) = line.strip_prefix("  note: ")
        {
            pins[index].note = rest.to_owned();
            note = true;
            continue;
        }
        if let Some(index) = pin
            && note
            && let Some(rest) = line.strip_prefix("    ")
        {
            pins[index].note.push('\n');
            pins[index].note.push_str(rest);
            continue;
        }
        note = false;
        if in_choices && let Some(choice) = CHOICE_LINE.captures(line) {
            choices.push((
                unquote(choice.get(1)),
                unquote(choice.get(2)),
                unquote(choice.get(3)),
            ));
        }
    }
    let mut lines: Vec<String> = pins
        .iter()
        .map(|p| format!("📌 {} · {} — {}", p.n, p.label, WHITESPACE_RUN.replace_all_with(&p.note, |_| " ".to_owned())))
        .collect();
    if !choices.is_empty() {
        let picks: Vec<String> = choices
            .iter()
            .map(|(group, choice, label)| {
                let group = if group.is_empty() { String::new() } else { format!("{group}: ") };
                let shown = if label.is_empty() { choice } else { label };
                format!("{group}{shown}")
            })
            .collect();
        lines.push(format!("☑ {}", picks.join(", ")));
    }
    let changed: Vec<String> = tweak_sets
        .iter()
        .filter(|set| !set.is_empty())
        .map(|set| set.join(", "))
        .collect();
    if !changed.is_empty() {
        lines.push(format!("🎚 {}", changed.join("; ")));
    }
    lines.join("\n")
}

/// `toolResultText`: content flattened to display text.
pub fn tool_result_text(content: &Value) -> String {
    match content {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Array(parts) => join_part_texts(parts, 0),
        Value::Object(map) => {
            match map.get("content") {
                Some(Value::Array(inner)) => {
                    let nested = join_part_texts(inner, 0);
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
            if let Some(Value::Array(parts)) = map.get("parts") {
                let nested = join_part_texts(parts, 0);
                if !nested.is_empty() {
                    return nested;
                }
            }
            let from_part = tool_result_part_text(content, 0);
            if !from_part.is_empty() {
                return from_part;
            }
            if str_field(content, "type") == "tool_result" {
                return String::new();
            }
            if let Some(Value::String(text)) = map.get("text") {
                return text.clone();
            }
            if let Some(Value::String(text)) = map.get("content") {
                return text.clone();
            }
            json_stringify(content)
        }
        other => json_stringify(other),
    }
}

fn join_part_texts(parts: &[Value], depth: usize) -> String {
    parts
        .iter()
        .map(|part| tool_result_part_text(part, depth))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn tool_result_part_text(part: &Value, depth: usize) -> String {
    if depth > TOOL_RESULT_PART_MAX_DEPTH {
        return String::new();
    }
    match part {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Array(parts) => join_part_texts(parts, depth + 1),
        Value::Object(map) => {
            let kind = str_field(part, "type");
            if kind == "image" || kind == "input_image" {
                let source = part.get("source").unwrap_or(&Value::Null);
                let mime = [str_field(part, "mimeType"), str_field(part, "mediaType"), str_field(source, "media_type")]
                    .into_iter()
                    .find(|v| !v.is_empty())
                    .unwrap_or("image");
                return format!("[image: {mime}]");
            }
            if kind == "tool_result" {
                return match map.get("content") {
                    Some(Value::String(inner)) => inner.clone(),
                    Some(Value::Array(inner)) => join_part_texts(inner, depth + 1),
                    Some(inner @ Value::Object(_)) => tool_result_part_text(inner, depth + 1),
                    _ => String::new(),
                };
            }
            if kind == "text" || kind == "output_text" || kind == "input_text" {
                return match map.get("text") {
                    Some(Value::String(text)) => text.clone(),
                    None | Some(Value::Null) => String::new(),
                    Some(other) => value_to_string(other),
                };
            }
            match map.get("content") {
                Some(Value::Array(inner)) => {
                    let nested = join_part_texts(inner, depth + 1);
                    if !nested.is_empty() {
                        return nested;
                    }
                }
                Some(inner @ Value::Object(_)) => {
                    let nested = tool_result_part_text(inner, depth + 1);
                    if !nested.is_empty() {
                        return nested;
                    }
                }
                _ => {}
            }
            if let Some(Value::Array(parts)) = map.get("parts") {
                let nested = join_part_texts(parts, depth + 1);
                if !nested.is_empty() {
                    return nested;
                }
            }
            for key in ["text", "output", "message"] {
                if let Some(Value::String(text)) = map.get(key)
                    && !text.is_empty()
                {
                    return text.clone();
                }
            }
            if let Some(Value::String(text)) = map.get("content") {
                return text.clone();
            }
            let source = part.get("source").unwrap_or(&Value::Null);
            if str_field(source, "type") == "base64" && source.get("data").is_some_and(truthy) {
                let mime = first_nonempty(source, &["media_type", "mediaType"], "base64");
                return format!("[image: {mime}]");
            }
            compact_object_fallback(part)
        }
        _ => String::new(),
    }
}

/// `compactToolResultObjectFallback`: the JSON, cut at 480 UTF-16 units.
fn compact_object_fallback(part: &Value) -> String {
    if str_field(part, "type") == "tool_result" {
        return String::new();
    }
    let json = json_stringify(part);
    if json == "{}" {
        return String::new();
    }
    if utf16_len(&json) <= TOOL_RESULT_JSON_FALLBACK_MAX {
        return json;
    }
    let mut cut = slice_utf16(&json, TOOL_RESULT_JSON_FALLBACK_MAX - 1);
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Blobs(Vec<(&'static str, &'static str)>);

    impl AttachmentText for Blobs {
        fn read_within(&mut self, r: &str, max: usize) -> Result<Option<String>, ReadFailure> {
            match self.0.iter().find(|(k, _)| *k == r) {
                Some((_, text)) if text.len() > max => Ok(None),
                Some((_, text)) => Ok(Some((*text).to_owned())),
                None => Err(ReadFailure::Missing),
            }
        }
    }

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn show(content: Value, blobs: Vec<(&'static str, &'static str)>) -> String {
        let mut budget = PASTED_LINE_READ_BUDGET_BYTES;
        user_display_text(&content, &mut Blobs(blobs), &mut budget)
    }

    #[test]
    fn chips_images_and_offloaded_text_follow_todays_rules() {
        let content = json!([
            { "type": "text", "text": "look at this  " },
            { "type": "text", "attachmentRef": A, "textKind": "paste", "filename": "paste · 3 lines" },
            { "type": "text", "attachmentRef": B, "textKind": "file", "filename": "notes.md" },
            { "type": "text", "text": "[Image: shot.png]" },
            { "type": "image", "mimeType": "image/png" },
            { "type": "image", "mediaType": "image/jpeg" },
            { "type": "text", "attachmentReference": true, "text": "model-only reference" },
        ]);
        assert_eq!(
            show(content, Vec::new()),
            "look at this  \n[Pasted text #1 +3 lines]\n[File #2: notes.md]\n[Image: shot.png]\n[Image: image/jpeg]"
        );
        // A paste without a stored count is read; a missing blob shows the bare chip.
        let counted = json!([{ "type": "text", "attachmentRef": A, "textKind": "paste" }]);
        assert_eq!(show(counted.clone(), vec![(A, "one\ntwo\r\n\n")]), "[Pasted text #1 +2 lines]");
        assert_eq!(show(counted, Vec::new()), "[Pasted text #1]");
        // Offloaded plain text is read back only when it is the prompt's only real text.
        let alone = json!([{ "type": "text", "attachmentRef": A }]);
        assert_eq!(show(alone, vec![(A, "the long prompt")]), "the long prompt");
        let beside = json!([{ "type": "text", "text": "hi" }, { "type": "text", "attachmentRef": A }]);
        assert_eq!(show(beside, vec![(A, "the long prompt")]), "hi");
    }

    #[test]
    fn feedback_blocks_show_the_live_lines() {
        let text = "before\n<visualize_feedback>\npin 1 · Header\n  note: make it\n    bigger\nchoices:\n  · group: \"Theme\" → choice: \"dark\" (\"Dark mode\")\ntweaks (tab):\n    gap (px): 8 (was 4)\n</visualize_feedback>";
        assert_eq!(
            show(json!(text), Vec::new()),
            "before\n📌 1 · Header — make it bigger\n☑ Theme: Dark mode\n🎚 gap: 8 (was 4)"
        );
    }
}
