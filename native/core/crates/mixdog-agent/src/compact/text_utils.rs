//! Text helpers the summary reads transcripts through: message text with a
//! marker per media part, JS-exact middle truncation, and bounded tool-call
//! lines with secrets redacted.

use mixdog_core_api::domain::provider::BinarySource;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DocumentSource;
use mixdog_js::js_trim;
use serde_json::Value as JsonValue;

use super::redact::is_sensitive_key;
use super::redact::redact_raw_secret_string;
use crate::message::AgentMessage;
use mixdog_core_api::domain::provider::Role;

const TOOL_ARG_STRING_MAX_CHARS: usize = 360;
const TOOL_ARG_ARRAY_MAX_ITEMS: usize = 8;
const TOOL_ARG_MAX_DEPTH: usize = 4;
const TOOL_CALL_ARGS_MAX_CHARS: usize = 260;
const TOOL_CALLS_MAX: usize = 4;

fn from_units(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// Middle-elided text of at most `max_chars` UTF-16 units (CRLF normalized).
pub fn truncate_middle(text: &str, max_chars: usize) -> String {
    let value = text.replace("\r\n", "\n");
    let units: Vec<u16> = value.encode_utf16().collect();
    if max_chars == 0 || units.is_empty() {
        return String::new();
    }
    if units.len() <= max_chars {
        return value;
    }
    if max_chars <= 8 {
        return from_units(&units[..max_chars]);
    }
    let head = (max_chars - 5).div_ceil(2);
    let tail = (max_chars - 5) / 2;
    format!("{} … {}", from_units(&units[..head]), from_units(&units[units.len() - tail..]))
}

/// `inlineFileKind(...) === 'pdf'`: the label says so, or the bytes start with `%PDF-`.
fn is_pdf(mime: &str, base64_data: &str) -> bool {
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    if js_trim(mime.split(';').next().unwrap_or("")) == "application/pdf" {
        return true;
    }
    let head: String = base64_data.chars().take(8).collect();
    head.chars().count() == 8
        && STANDARD.decode(head.trim_end_matches('=')).or_else(|_| STANDARD.decode(&head)).is_ok_and(|b| b.starts_with(b"%PDF-"))
        || base64_data.starts_with("JVBERi0")
}

fn media_marker(part: &ContentPart) -> String {
    // A part without a type label defaults to a PDF, as lowering does.
    let marker = |name: &str, mime: &str, data: &str| {
        let mime = if mime.is_empty() { "application/pdf".to_owned() } else { mime.to_lowercase() };
        if is_pdf(&mime, data) {
            format!("[PDF: {}]", if name.is_empty() { "document.pdf" } else { name })
        } else {
            format!("[file: {}]", if !name.is_empty() { name } else { &mime })
        }
    };
    match part {
        ContentPart::Text(_, _) => String::new(),
        ContentPart::Image(_) => "[image]".to_owned(),
        ContentPart::File { mime_type, filename, source, .. } => {
            let data = match source {
                BinarySource::Base64(data) => data.as_str(),
                _ => "",
            };
            marker(js_trim(filename.as_deref().unwrap_or("")), mime_type, data)
        }
        ContentPart::Document { source, title } => {
            let (mime, data) = match source {
                DocumentSource::Base64 { media_type, data } => (media_type.as_str(), data.as_str()),
                _ => ("application/pdf", ""),
            };
            marker(js_trim(title.as_deref().unwrap_or("")), mime, data)
        }
    }
}

/// `ATTACHMENT_TEXT_MAX_CHARS`: what the summarizer reads of one stored text attachment.
const ATTACHMENT_TEXT_MAX_CHARS: usize = 24_000;

/// A stored text attachment as the attachment store reads it for the summarizer.
pub enum StoredText {
    Text(String),
    /// The blob is permanently gone or corrupt.
    Gone,
}

fn is_text_reference(part: &ContentPart) -> bool {
    matches!(part, ContentPart::File { source: BinarySource::AttachmentRef(_), text: Some(_), .. })
}

/// `referencedText` over the summarizer's input: each stored text attachment becomes its text,
/// bounded, and a gone blob `[attachment unavailable]`. A transient read error fails the
/// compaction instead of shrinking it.
pub async fn with_referenced_text(
    seam: &dyn super::fresh::AttachmentSeam,
    mut messages: Vec<AgentMessage>,
) -> Result<Vec<AgentMessage>, crate::env::CompactError> {
    for message in &mut messages {
        let Content::Parts(parts) = &mut message.message.content else { continue };
        for part in parts.iter_mut().filter(|p| is_text_reference(p)) {
            let text = match seam.stored_text(part).await.map_err(crate::env::CompactError::Failed)? {
                Some(StoredText::Text(text)) => truncate_middle(&text, ATTACHMENT_TEXT_MAX_CHARS),
                Some(StoredText::Gone) => "[attachment unavailable]".to_owned(),
                None => continue,
            };
            *part = ContentPart::Text(text, None);
        }
    }
    Ok(messages)
}

/// A content as the summarizer reads it: text parts and a fixed marker per
/// media part, joined by newlines.
pub fn content_text(content: &Content) -> String {
    match content {
        Content::Text(text) => text.clone(),
        Content::Parts(parts) => parts
            .iter()
            .map(|part| match part {
                ContentPart::Text(text, _) => text.clone(),
                other => media_marker(other),
            })
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

pub fn extract_text(message: &AgentMessage) -> String {
    content_text(&message.message.content)
}

fn js_sorted_keys(map: &serde_json::Map<String, JsonValue>) -> Vec<&String> {
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort_by_key(|k| k.encode_utf16().collect::<Vec<u16>>());
    keys
}

fn normalize_arg_value(value: &JsonValue, key: &str, depth: usize) -> JsonValue {
    if is_sensitive_key(key) {
        return JsonValue::String("[redacted]".to_owned());
    }
    match value {
        JsonValue::String(s) => {
            JsonValue::String(truncate_middle(&redact_raw_secret_string(s), TOOL_ARG_STRING_MAX_CHARS))
        }
        JsonValue::Array(items) => {
            if depth >= TOOL_ARG_MAX_DEPTH {
                return JsonValue::String(format!("[array:{}]", items.len()));
            }
            let mut out: Vec<JsonValue> = items
                .iter()
                .take(TOOL_ARG_ARRAY_MAX_ITEMS)
                .enumerate()
                .map(|(i, item)| normalize_arg_value(item, &i.to_string(), depth + 1))
                .collect();
            if items.len() > TOOL_ARG_ARRAY_MAX_ITEMS {
                out.push(JsonValue::String(format!("+{} more", items.len() - TOOL_ARG_ARRAY_MAX_ITEMS)));
            }
            JsonValue::Array(out)
        }
        JsonValue::Object(map) => {
            if depth >= TOOL_ARG_MAX_DEPTH {
                return JsonValue::String("[object]".to_owned());
            }
            let mut out = serde_json::Map::new();
            for k in js_sorted_keys(map) {
                out.insert(k.clone(), normalize_arg_value(&map[k], k, depth + 1));
            }
            JsonValue::Object(out)
        }
        other => other.clone(),
    }
}

fn stable_arg_json(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => String::new(),
        JsonValue::String(s) => {
            let text = js_trim(s);
            if text.is_empty() {
                return String::new();
            }
            if text.starts_with(['[', '{'])
                && let Ok(parsed) = serde_json::from_str::<JsonValue>(text)
            {
                return mixdog_js::json_stringify(&normalize_arg_value(&parsed, "", 0));
            }
            truncate_middle(&redact_raw_secret_string(text), TOOL_ARG_STRING_MAX_CHARS)
        }
        other => mixdog_js::json_stringify(&normalize_arg_value(other, "", 0)),
    }
}

fn summarize_tool_call(name: &str, arguments: &JsonValue, max_arg_chars: usize) -> String {
    let args = if max_arg_chars == 0 {
        String::new()
    } else {
        let text = stable_arg_json(arguments);
        if text.is_empty() { text } else { truncate_middle(&text, max_arg_chars) }
    };
    if args.is_empty() { name.to_owned() } else { format!("{name}({args})") }
}

/// The argument budget of one transcript line of `per_message_chars`.
pub fn tool_call_arg_budget(per_message_chars: usize) -> usize {
    if per_message_chars == 0 {
        return 0;
    }
    TOOL_CALL_ARGS_MAX_CHARS.min(32.max(per_message_chars / 2))
}

pub fn tool_call_summary(message: &AgentMessage, max_arg_chars: usize) -> String {
    let calls = message.tool_calls();
    if calls.is_empty() {
        return String::new();
    }
    let mut lines: Vec<String> = calls
        .iter()
        .take(TOOL_CALLS_MAX)
        .map(|c| summarize_tool_call(if c.name.is_empty() { &c.id } else { &c.name }, &c.arguments, max_arg_chars))
        .collect();
    if calls.len() > TOOL_CALLS_MAX {
        lines.push(format!("+{} more", calls.len() - TOOL_CALLS_MAX));
    }
    format!(" tool_calls={}", lines.join(";"))
}

pub fn tool_result_id(message: &AgentMessage) -> String {
    match message.tool_call_id() {
        Some(id) if message.role() == Role::Tool && !id.is_empty() => format!(" tool_result={id}"),
        _ => String::new(),
    }
}

/// `text-utils-attachments.test.mjs`.
#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::ImageSource;

    use super::*;

    fn user(parts: Vec<ContentPart>) -> AgentMessage {
        let mut message = AgentMessage::user("");
        message.message.content = Content::Parts(parts);
        message
    }

    fn file(source: BinarySource, mime: &str, name: &str) -> ContentPart {
        ContentPart::File { source, mime_type: mime.into(), filename: Some(name.into()), text: None }
    }

    #[test]
    fn a_pdf_is_recognised_by_the_kind_rule_not_label_or_extension_alone() {
        use base64::Engine;
        let pdf = base64::engine::general_purpose::STANDARD.encode("%PDF-1.4\nrest");
        let marker = |part: ContentPart| extract_text(&user(vec![part]));
        assert_eq!(marker(file(BinarySource::Base64(pdf), "application/octet-stream", "report")), "[PDF: report]");
        assert_eq!(marker(file(BinarySource::AttachmentRef("e".repeat(64)), "application/pdf", "scan")), "[PDF: scan]");
        assert_eq!(marker(file(BinarySource::Base64("AAAA".into()), "application/zip", "trick.pdf")), "[file: trick.pdf]");
    }

    #[test]
    fn media_parts_are_marked_so_the_summarizer_knows_they_existed() {
        let text = extract_text(&user(vec![
            ContentPart::Text("compare these".into(), None),
            ContentPart::Image(ImageSource::Base64 { data: "AAAA".into(), mime_type: "image/png".into() }),
            file(BinarySource::AttachmentRef("b".repeat(64)), "application/pdf", "spec.pdf"),
            file(BinarySource::AttachmentRef("c".repeat(64)), "application/zip", "bundle.zip"),
            ContentPart::Document { source: DocumentSource::Base64 { media_type: "application/pdf".into(), data: "AAAA".into() }, title: Some("read.pdf".into()) },
        ]));
        assert_eq!(text, "compare these\n[image]\n[PDF: spec.pdf]\n[file: bundle.zip]\n[PDF: read.pdf]");
    }
}

