//! The Context inspector's reading (`runtime-core/context-inspection.mjs`) and the readings kept for
//! entry previews (`context-status-inspection.mjs`): every transcript message, system-prompt section,
//! reminder, attachment, reasoning block and tool definition of the gauge's request as one priced
//! entry, the entries summed per category, and the text of one entry on request.

use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::PoisonError;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DocumentSource;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_js::JsRegex;
use mixdog_js::math::round;
use mixdog_js::token_estimate::estimate_tokens;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::StatusInput;
use super::num;
use super::status::Coverage;
use super::status::provider_coverage;
use super::status::section_bucket;
use super::status::section_heading;
use super::status::split_sections;
use super::status::strip_system_reminder;
use super::truthy;
use crate::compact::fresh::SUMMARY_PREFIX;
use crate::compact::tool_schema::RequestTools;
use crate::compact::tool_schema::ToolAnnotations;
use crate::compact::tool_schema::estimate_request_reserve_tokens;
use crate::compact::tool_schema::native_deferred;
use crate::compact::tool_schema::sha256_hex;
use crate::compact::tool_schema::tool_schema_bucket;
use crate::compact::tool_schema::tool_schema_signature;
use crate::message::AgentMessage;
use crate::project::classify_synthetic_user;
use crate::project::is_summary_message;
use crate::project::parse_task_notification;

const PREVIEW_LIMIT: usize = 32_000;
// A provider reading this far from the local estimate is not describing the same request.
const CALIBRATION_MIN: f64 = 0.25;
const CALIBRATION_MAX: f64 = 3.0;
/// How many readings stay resolvable for entry previews (`INSPECTION_SNAPSHOT_LIMIT`).
const SNAPSHOT_LIMIT: usize = 4;
const ATTACHMENT_LABEL_LIMIT: usize = 3;
const OPAQUE_FIELDS: [&str; 8] =
    ["signature", "thinkingSignature", "thoughtSignature", "thought_signature", "encrypted_content", "encryptedContent", "encrypted_reasoning", "encryptedReasoning"];
/// `CONTEXT_CATEGORIES` (`shared/context-inspection.mjs`).
const CATEGORIES: [(&str, &str); 11] = [
    ("system", "System messages"),
    ("user", "User messages"),
    ("assistant", "Assistant messages"),
    ("reasoning", "Reasoning tokens"),
    ("toolResults", "Tool results"),
    ("attachments", "Attachments"),
    ("tools", "System tools"),
    ("mcp", "MCP tools"),
    ("agents", "Custom agents"),
    ("memory", "Memory files"),
    ("skills", "Skills"),
];
/// Prompt-head manifests that arrive as XML blocks with no heading (`NAMED_PROMPT_BLOCKS`).
const NAMED_PROMPT_BLOCKS: [(&str, &str); 2] = [("available-deferred-tools", "Deferred tool list"), ("mcp-instructions", "MCP instructions")];

static RUNTIME_CONTROL_OPEN: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r#"^\s*<mixdog-runtime\s+kind="(?:runtime-control|compact-state|context-attachment)"[^>]*>"#, "i"));
static RUNTIME_CONTROL_CLOSE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"</mixdog-runtime>\s*$", "i"));
static LEADING_REMINDER: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*", "i"));
static TRAILING_REMINDER: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\s*<system-reminder>(?:(?!<\/?system-reminder>)[\s\S])*<\/system-reminder>\s*$", "i"));
static SKILL_BODY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^<skill>\n<name>([^<\n]+)<\/name>\n[\s\S]*\n<\/skill>$", ""));
static SKILL_ENTITY: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"&(amp|lt|gt|quot|apos);", "g"));
static CRLF: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\r\n?", "g"));
static CONTROL: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]", "g"));
static SPACES: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\s+", "g"));
// Node's `stripVTControlCharacters` pattern (v22).
static VT: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        concat!(
            r"[\u001B\u009B][\[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?",
            r"(?:\u0007|\u001B\u005C|\u009C))|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))"
        ),
        "g",
    )
});

// --- Text helpers ---------------------------------------------------------------

/// `terminalText(value)`.
fn terminal_text(value: &str) -> String {
    let stripped = VT.replace_all_with(value, |_| String::new());
    let lines = CRLF.replace_all_with(&stripped, |_| "\n".to_owned());
    CONTROL.replace_all_with(&lines, |_| String::new())
}

/// `label(value)`: one line of at most 120 UTF-16 units.
fn label(value: &str) -> String {
    let collapsed = SPACES.replace_all_with(&terminal_text(value), |_| " ".to_owned());
    mixdog_js::slice_utf16(mixdog_js::js_trim(&collapsed), 120)
}

/// `Number.prototype.toLocaleString()` (en-US) of an integer.
fn grouped(value: f64) -> String {
    let text = mixdog_js::number_to_string(value.abs());
    let (int, rest) = text.split_once('.').map_or((text.as_str(), String::new()), |(i, f)| (i, format!(".{f}")));
    let mut out = String::new();
    for (at, c) in int.chars().enumerate() {
        if at > 0 && (int.len() - at) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    format!("{}{out}{rest}", if value < 0.0 { "-" } else { "" })
}

/// `JSON.stringify(value, replacer, 2)` with opaque payloads and binary data left out (`previewJson`).
fn preview_json(value: &Value) -> String {
    fn redact(key: &str, value: &Value) -> Value {
        if OPAQUE_FIELDS.contains(&key) && value.is_string() {
            return json!("[Opaque data omitted]");
        }
        if value.get("type").and_then(Value::as_str) == Some("base64") {
            return json!("[Binary data omitted]");
        }
        match value {
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), redact(k, v))).collect()),
            Value::Array(items) => Value::Array(items.iter().enumerate().map(|(i, v)| redact(&i.to_string(), v)).collect()),
            other => other.clone(),
        }
    }
    mixdog_js::json_stringify_indent(&redact("", value), 2)
}

/// `previewJson(x)` interpolated into a template: `undefined` reads as such.
fn preview_json_or_undefined(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), preview_json)
}

/// `readableContent(content)`: readable fields only, never a whole message or replay envelope.
fn readable_content(content: Option<&Value>) -> String {
    let blocks: Vec<&Value> = match content {
        Some(Value::String(text)) => return text.clone(),
        Some(Value::Array(items)) => items.iter().collect(),
        Some(value) if truthy(Some(value)) => vec![value],
        _ => Vec::new(),
    };
    blocks
        .into_iter()
        .map(|block| {
            if let Value::String(text) = block {
                return text.clone();
            }
            let kind = block.get("type").and_then(Value::as_str);
            match kind {
                Some("image" | "image_url" | "input_image") => return "[Image omitted]".into(),
                Some("document" | "file" | "input_file") => return "[File omitted]".into(),
                Some("redacted_thinking") => return "[Opaque reasoning omitted]".into(),
                Some("tool_result") => return readable_content(block.get("content")),
                Some("tool_use" | "toolCall") => {
                    let name = block.get("name").filter(|n| truthy(Some(n))).map_or_else(|| "tool".to_owned(), mixdog_js::value_to_string);
                    let input = block.get("input").filter(|v| !v.is_null()).or_else(|| block.get("arguments"));
                    return format!("{name}\n{}", preview_json_or_undefined(input));
                }
                _ => {}
            }
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                return text.to_owned();
            }
            if let Some(text) = block.get("thinking").and_then(Value::as_str) {
                return text.to_owned();
            }
            if let Some(summary) = block.get("summary").filter(|s| s.is_array()) {
                return readable_content(Some(summary));
            }
            "[Non-text content omitted]".into()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `messagePreview(message)` of a stored row.
fn message_preview(row: &Value) -> String {
    let mut parts = vec![readable_content(row.get("content"))];
    if let Some(calls) = row.get("toolCalls").and_then(Value::as_array) {
        for call in calls {
            let name = call
                .get("name")
                .filter(|n| truthy(Some(n)))
                .or_else(|| call.pointer("/function/name").filter(|n| truthy(Some(n))))
                .map_or_else(|| "tool".to_owned(), mixdog_js::value_to_string);
            let arguments = call.get("arguments").filter(|v| !v.is_null()).or_else(|| call.pointer("/function/arguments"));
            parts.push(format!("{name}\n{}", preview_json_or_undefined(arguments)));
        }
    }
    parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n\n")
}

/// `skillMessageText(content)`.
fn skill_message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|block| match block {
                Value::String(text) => text.clone(),
                other => other.get("text").filter(|t| truthy(Some(t))).map(mixdog_js::value_to_string).unwrap_or_default(),
            })
            .collect(),
        _ => String::new(),
    }
}

/// `contextShares(weights, total)`: integer shares of `total` that sum to it.
fn context_shares(weights: &[f64], total: f64) -> Vec<f64> {
    let sum: f64 = weights.iter().sum();
    if sum == 0.0 {
        return vec![0.0; weights.len()];
    }
    let exact: Vec<f64> = weights.iter().map(|w| (w / sum) * total).collect();
    let mut shares: Vec<f64> = exact.iter().map(|e| e.floor()).collect();
    let mut remaining = total - shares.iter().sum::<f64>();
    let mut order: Vec<usize> = (0..exact.len()).collect();
    order.sort_by(|&a, &b| (exact[b] - shares[b]).partial_cmp(&(exact[a] - shares[a])).unwrap_or(std::cmp::Ordering::Equal));
    for index in order {
        let left = remaining;
        remaining -= 1.0;
        if left <= 0.0 {
            break;
        }
        shares[index] += 1.0;
    }
    shares
}

// --- Drafts -----------------------------------------------------------------------

/// What an entry's preview shows, kept until a reader opens it.
enum Preview {
    Text(String),
    Message(Value),
    Reasoning(Vec<Value>),
    Json(Value),
}

impl Preview {
    fn text(&self) -> String {
        match self {
            Self::Text(text) => text.clone(),
            Self::Message(row) => message_preview(row),
            Self::Reasoning(blocks) => readable_content(Some(&Value::Array(blocks.clone()))),
            Self::Json(value) => preview_json(value),
        }
    }
}

struct Draft {
    /// The entry as listed, in Node's key order; `tokens` and `estimatedTokens` are filled at the end.
    fields: Map<String, Value>,
    tokens: f64,
    estimated: f64,
    attachment: bool,
    message_index: Option<usize>,
    /// The tools an assistant turn called, with what each result cost (`results`).
    results: Option<Vec<(String, f64)>>,
    preview: Preview,
}

impl Draft {
    fn new(fields: Vec<(&str, Value)>, tokens: f64, message_index: Option<usize>, preview: Preview) -> Self {
        let mut map = Map::new();
        for (key, value) in fields {
            map.insert(key.to_owned(), value);
        }
        Self { fields: map, tokens, estimated: 0.0, attachment: false, message_index, results: None, preview }
    }

    fn id(&self) -> &str {
        self.fields.get("id").and_then(Value::as_str).unwrap_or_default()
    }

    fn entry(&self) -> Value {
        let mut out = self.fields.clone();
        out.insert("tokens".into(), num(self.tokens));
        out.insert("estimatedTokens".into(), num(self.estimated));
        Value::Object(out)
    }
}

/// One section of a system prompt or reminder.
struct Section {
    text: String,
    label: String,
    category: Option<&'static str>,
    group: Option<&'static str>,
}

impl Section {
    fn plain(text: String) -> Self {
        Self { text, label: String::new(), category: None, group: None }
    }
}

fn markdown_sections(text: &str) -> Vec<Section> {
    split_sections(text).into_iter().map(Section::plain).collect()
}

/// `promptSections(text)`: the named XML blocks carved out first, each as its own section.
fn prompt_sections(text: &str) -> Vec<Section> {
    let mut named = Vec::new();
    let mut rest = text.to_owned();
    for (tag, name) in NAMED_PROMPT_BLOCKS {
        let block = JsRegex::new_static(&format!(r"<{tag}>[\s\S]*?</{tag}>"), "gi");
        let found: Vec<String> = block.find_iter(&rest).map(|r| rest[r].to_owned()).collect();
        rest = block.replace_all_with(&rest, |_| String::new());
        named.extend(found.into_iter().map(|text| Section { text, label: name.to_owned(), category: None, group: None }));
    }
    let mut out = markdown_sections(&rest);
    out.extend(named);
    out
}

/// `reminderSections(text)`.
fn reminder_sections(text: &str) -> Vec<Section> {
    let opened = RUNTIME_CONTROL_OPEN.replace_all_with(text, |_| String::new());
    let closed = RUNTIME_CONTROL_CLOSE.replace_all_with(&opened, |_| String::new());
    markdown_sections(&strip_system_reminder(&closed))
}

/// `sectionDrafts(sections, index, tokens, reminder)`.
fn section_drafts(sections: Vec<Section>, index: usize, tokens: f64, reminder: bool, suffix: &str) -> Vec<Draft> {
    let weights: Vec<f64> = sections.iter().map(|s| estimate_tokens(&s.text) as f64).collect();
    let shares = context_shares(&weights, tokens);
    sections
        .into_iter()
        .enumerate()
        .map(|(at, section)| {
            let heading = section_heading(&section.text).filter(|h| !h.is_empty()).unwrap_or_else(|| if reminder { "System reminder" } else { "System prompt" }.to_owned());
            let skill_label = match mixdog_js::js_to_lowercase(mixdog_js::js_trim(&heading)).as_str() {
                "skills" => Some("Skill instructions"),
                "available-skills" => Some("Available skills"),
                _ => None,
            };
            let mut category = if section_bucket(&section.text) == "memory" { "memory" } else { "system" };
            if let Some(own) = section.category {
                category = own;
            }
            let group = section.group.unwrap_or(if reminder { "reminder" } else { "instruction" });
            let shown = if !section.label.is_empty() { section.label.as_str() } else { skill_label.unwrap_or(&heading) };
            Draft::new(
                vec![
                    ("id", json!(format!("message:{index}:section:{at}{suffix}"))),
                    ("category", json!(category)),
                    ("group", json!(group)),
                    ("label", json!(label(shown))),
                    ("tokens", Value::Null),
                    ("kind", json!("instruction")),
                ],
                shares[at],
                Some(index),
                Preview::Text(section.text),
            )
        })
        .collect()
}

/// One attachment of a message (`messageAttachmentBreakdown` items).
struct Attachment {
    kind: &'static str,
    label: String,
    tokens: f64,
}

fn attachments_of(message: &AgentMessage, input: &StatusInput<'_>) -> Vec<Attachment> {
    let mut items: Vec<Attachment> = input
        .signer
        .images
        .images(message)
        .iter()
        .map(|image| Attachment {
            kind: "image",
            label: match (image.width, image.height) {
                (Some(w), Some(h)) if w != 0.0 && h != 0.0 => format!("{}×{}", mixdog_js::number_to_string(w), mixdog_js::number_to_string(h)),
                _ => String::new(),
            },
            tokens: image.allowance() as f64,
        })
        .collect();
    if let Content::Parts(parts) = &message.message.content {
        for part in parts {
            let mime = match part {
                ContentPart::File { mime_type, text: None, .. } => mime_type.clone(),
                ContentPart::Document { source: DocumentSource::Base64 { media_type, .. }, .. } => media_type.clone(),
                ContentPart::Document { source: DocumentSource::Text { media_type, .. }, .. } => media_type.clone().unwrap_or_default(),
                ContentPart::Document { .. } => String::new(),
                _ => continue,
            };
            let tokens = input.meter.media.part(part).tokens as f64;
            items.push(Attachment { kind: "file", label: if mime.is_empty() { "file".into() } else { mime }, tokens });
        }
    }
    items
}

/// `attachmentDraft(attachments, index, identity)`.
fn attachment_draft(items: &[Attachment], index: usize, identity: Option<(&str, f64, &str)>) -> Option<Draft> {
    let tokens: f64 = items.iter().map(|i| i.tokens).sum();
    if tokens == 0.0 {
        return None;
    }
    let mut shown: Vec<String> = items.iter().take(ATTACHMENT_LABEL_LIMIT).map(|i| if i.label.is_empty() { i.kind.to_owned() } else { i.label.clone() }).collect();
    if items.len() > ATTACHMENT_LABEL_LIMIT {
        shown.push(format!("+{}", items.len() - ATTACHMENT_LABEL_LIMIT));
    }
    let preview = items
        .iter()
        .map(|i| [i.kind.to_owned(), i.label.clone(), format!("≈{}", grouped(i.tokens))].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" · "))
        .collect::<Vec<_>>()
        .join("\n");
    let (role, ordinal, name) = identity.unwrap_or(("", 0.0, ""));
    let mut fields = vec![
        ("id", json!(format!("message:{index}:attachment"))),
        ("category", json!("attachments")),
        ("group", json!(if role.is_empty() { "instruction" } else { role })),
        ("label", json!(label(&shown.join(" · ")))),
        ("tokens", Value::Null),
        ("kind", json!("attachment")),
    ];
    if !role.is_empty() {
        fields.push(("role", json!(role)));
    }
    if ordinal != 0.0 {
        fields.push(("ordinal", num(ordinal)));
    }
    if !name.is_empty() {
        fields.push(("name", json!(name)));
    }
    let mut draft = Draft::new(fields, tokens, Some(index), Preview::Text(preview));
    draft.attachment = true;
    Some(draft)
}

fn is_reasoning_block(block: &Value) -> bool {
    matches!(block.get("type").and_then(Value::as_str), Some("thinking" | "redacted_thinking" | "reasoning")) || block.get("thought") == Some(&Value::Bool(true))
}

/// The reasoning blocks of an assistant message (`messageReasoningBreakdown(message).blocks`): a replay envelope's
/// items replace the native block lists.
fn reasoning_blocks(message: &AgentMessage, input: &StatusInput<'_>, row: &Value) -> Vec<Value> {
    if message.role() != Role::Assistant {
        return Vec::new();
    }
    let reasoning = |items: Option<&Value>| -> Vec<Value> { items.and_then(Value::as_array).map(|list| list.iter().filter(|b| is_reasoning_block(b)).cloned().collect()).unwrap_or_default() };
    let mut blocks = reasoning(row.get("content"));
    if let Some(replay) = message.message.replay_for(input.meter.replay_owner).find(|r| r.items.is_array()) {
        blocks.extend(reasoning(Some(&replay.items)));
    } else {
        blocks.extend(reasoning(message.message.thinking_blocks.as_ref()));
        blocks.extend(reasoning(message.message.assistant_blocks.as_ref()));
        blocks.extend(reasoning(row.get("reasoningItems")));
        blocks.extend(reasoning(message.provider_metadata.as_ref().and_then(|m| m.pointer("/gemini/thoughtParts"))));
    }
    blocks
}

/// The row without its reasoning blocks (`reasoning.message`, as far as the preview reads it).
fn without_reasoning(row: &Value) -> Value {
    let mut row = row.clone();
    if let Some(Value::Array(items)) = row.get_mut("content") {
        items.retain(|b| !is_reasoning_block(b));
    }
    row
}

/// A message with other content (the meters read a message, so a split one is priced as itself).
fn with_content(message: &AgentMessage, content: Content) -> AgentMessage {
    let mut out = message.clone();
    out.message.content = content;
    out
}

/// `splitInjectedContext(message)`: the human part of a user message and the runtime context around it, at the
/// producer's own boundaries first, else at reminder envelopes on the edges of a string.
fn split_injected(message: &AgentMessage, row: &Value) -> Option<(AgentMessage, Value, String)> {
    if message.role() != Role::User {
        return None;
    }
    if let Some(context) = row.pointer("/meta/runtimeUserContext")
        && let (Some(prefix), Some(suffix)) = (context.get("prefix").and_then(Value::as_str), context.get("suffix").and_then(Value::as_str))
    {
        let injected = [prefix, suffix].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n");
        let stripped = match (&message.message.content, row.get("content")) {
            (Content::Text(text), Some(Value::String(_))) => {
                (mixdog_js::utf16_len(text) >= mixdog_js::utf16_len(prefix) + mixdog_js::utf16_len(suffix) && text.starts_with(prefix) && text.ends_with(suffix))
                    .then(|| {
                        let inner = text[prefix.len()..text.len() - suffix.len()].to_owned();
                        (Content::Text(inner.clone()), Value::String(inner))
                    })
            }
            (Content::Parts(parts), Some(Value::Array(items))) => {
                let is_text = |item: Option<&Value>, want: &str| item.is_some_and(|i| i.get("type").and_then(Value::as_str) == Some("text") && i.get("text").and_then(Value::as_str) == Some(want));
                let (head, tail) = (usize::from(!prefix.is_empty()), usize::from(!suffix.is_empty()));
                let fits = (prefix.is_empty() || is_text(items.first(), prefix)) && (suffix.is_empty() || is_text(items.last(), suffix)) && items.len() >= head + tail;
                (fits && parts.len() == items.len()).then(|| (Content::Parts(parts[head..parts.len() - tail].to_vec()), Value::Array(items[head..items.len() - tail].to_vec())))
            }
            _ => None,
        };
        if let Some((content, json)) = stripped {
            let mut row = row.clone();
            row["content"] = json;
            return Some((with_content(message, content), row, injected));
        }
    }
    let Some(Value::String(original)) = row.get("content") else { return None };
    let mut content = original.as_str();
    let mut injected = Vec::new();
    while let Some(found) = LEADING_REMINDER.find(content) {
        injected.push(&content[found.clone()]);
        content = &content[found.end..];
    }
    while let Some(found) = TRAILING_REMINDER.find(content) {
        injected.push(&content[found.clone()]);
        content = &content[..found.start];
    }
    if mixdog_js::js_trim(content).is_empty() || injected.is_empty() {
        return None;
    }
    let mut row = row.clone();
    row["content"] = json!(content);
    Some((with_content(message, Content::Text(content.to_owned())), row, injected.join("\n")))
}

/// `runtimeAuthored(message, text)`.
fn runtime_authored(message: &AgentMessage, text: &str) -> bool {
    if mixdog_js::js_trim(text).is_empty() {
        return false;
    }
    if RUNTIME_CONTROL_OPEN.is_match(text) || parse_task_notification(text).is_some() {
        return true;
    }
    classify_synthetic_user(&with_content(message, Content::Text(text.to_owned()))).is_some()
}

/// The skill a user message carries as its body (`latestSkillBodies([message])[0].name`).
fn skill_body_name(text: &str) -> Option<String> {
    let caps = SKILL_BODY.captures(mixdog_js::js_trim_start(text))?;
    let name = caps.get(1)?;
    Some(SKILL_ENTITY.replace_all_with(name, |c| {
        match c.get(1) {
            Some("amp") => "&",
            Some("lt") => "<",
            Some("gt") => ">",
            Some("quot") => "\"",
            _ => "'",
        }
        .to_owned()
    }))
}

/// `frameSections(message, text, reminder)`.
fn frame_sections(role: Role, text: &str, reminder: bool) -> Vec<Section> {
    if reminder {
        if let Some(name) = skill_body_name(text) {
            return vec![Section { text: text.to_owned(), label: format!("Skill: {name}"), category: Some("skills"), group: Some("loaded") }];
        }
        if parse_task_notification(text).is_some() {
            return vec![Section { text: text.to_owned(), label: "Task notification".into(), category: None, group: None }];
        }
        return reminder_sections(text);
    }
    if matches!(role, Role::System | Role::Developer) {
        return prompt_sections(text);
    }
    Vec::new()
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

/// `toolCallNames(messages)`: call id to tool name, from the turns that issued the calls.
fn tool_call_names(rows: &[Value]) -> std::collections::HashMap<String, String> {
    let mut names = std::collections::HashMap::new();
    for row in rows {
        if row.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        for call in row.get("toolCalls").and_then(Value::as_array).into_iter().flatten() {
            let name = call.get("name").filter(|n| truthy(Some(n))).or_else(|| call.pointer("/function/name").filter(|n| truthy(Some(n))));
            if let (Some(id), Some(name)) = (call.get("id").filter(|i| truthy(Some(i))), name) {
                names.insert(mixdog_js::value_to_string(id), mixdog_js::value_to_string(name));
            }
        }
        for block in row.get("content").and_then(Value::as_array).into_iter().flatten() {
            let kind = block.get("type").and_then(Value::as_str);
            if matches!(kind, Some("tool_use" | "toolCall"))
                && let (Some(id), Some(name)) = (block.get("id").filter(|i| truthy(Some(i))), block.get("name").filter(|n| truthy(Some(n))))
            {
                names.insert(mixdog_js::value_to_string(id), mixdog_js::value_to_string(name));
            }
        }
    }
    names
}

/// `messageDrafts(messages)`: the drafts of every transcript message, turns numbered per role and tool results per tool.
fn message_drafts(messages: &[AgentMessage], input: &StatusInput<'_>) -> Vec<Draft> {
    let rows: Vec<Value> = messages.iter().map(|m| input.signer.rows.row(m)).collect();
    let call_names = tool_call_names(&rows);
    let mut ordinals: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    let mut next_ordinal = |key: String| {
        let slot = ordinals.entry(key).or_insert(0.0);
        *slot += 1.0;
        *slot
    };
    let mut drafts: Vec<Draft> = Vec::new();
    let mut open_turn: Option<usize> = None;
    for (index, original) in messages.iter().enumerate() {
        let split = split_injected(original, &rows[index]);
        let (message, row) = match &split {
            Some((message, row, _)) => (message, row),
            None => (original, &rows[index]),
        };
        let injected = split.as_ref().map(|(_, _, injected)| injected.as_str()).unwrap_or_default();
        let attachments = attachments_of(message, input);
        let attachment_tokens: f64 = attachments.iter().map(|a| a.tokens).sum();
        let blocks = reasoning_blocks(message, input, row);
        let reasoning_tokens = input.meter.reasoning_tokens(message) as f64;
        let mut tokens = input.meter.message(original) as f64 - attachment_tokens - reasoning_tokens;
        if !injected.is_empty() {
            let body_weight = if mixdog_js::js_trim(&skill_message_text(row.get("content"))).is_empty() {
                0.0
            } else {
                input.meter.message(message) as f64 - attachment_tokens - reasoning_tokens
            };
            let shares = context_shares(&[estimate_tokens(injected) as f64, body_weight], tokens);
            drafts.extend(section_drafts(reminder_sections(injected), index, shares[0], true, ":injected"));
            tokens = shares[1];
        }
        if !blocks.is_empty() {
            drafts.push(Draft::new(
                vec![
                    ("id", json!(format!("reasoning:{index}"))),
                    ("category", json!("reasoning")),
                    ("group", json!("assistant")),
                    ("label", json!("Reasoning tokens")),
                    ("kind", json!("reasoning")),
                    ("tokens", Value::Null),
                ],
                reasoning_tokens,
                Some(index),
                Preview::Reasoning(blocks),
            ));
        }
        let text = skill_message_text(row.get("content"));
        let role = message.role();
        let summary = role == Role::User && (is_summary_message(message) || text.starts_with(SUMMARY_PREFIX));
        let reminder = role == Role::User && !summary && runtime_authored(message, &text);
        let sections = frame_sections(role, &text, reminder);
        if !sections.is_empty() {
            drafts.extend(section_drafts(sections, index, tokens, reminder, ""));
            drafts.extend(attachment_draft(&attachments, index, None));
            continue;
        }
        let role_text = role_name(role);
        if role == Role::Tool {
            let call_id = row.get("toolCallId").map(mixdog_js::value_to_string).unwrap_or_default();
            let fallback = row.get("name").filter(|n| truthy(Some(n))).map(mixdog_js::value_to_string);
            let tool_name = label(&call_names.get(&call_id).cloned().or(fallback).unwrap_or_else(|| "tool".into()));
            let ordinal = next_ordinal(format!("tool:{tool_name}"));
            drafts.push(Draft::new(
                vec![
                    ("id", json!(format!("message:{index}"))),
                    ("category", json!("toolResults")),
                    ("group", json!(tool_name)),
                    ("name", json!(tool_name)),
                    ("ordinal", num(ordinal)),
                    ("label", json!(label(&format!("{tool_name} · {}", mixdog_js::number_to_string(ordinal))))),
                    ("tokens", Value::Null),
                    ("kind", json!("toolResult")),
                ],
                tokens,
                Some(index),
                Preview::Message(row.clone()),
            ));
            if let Some(turn) = open_turn {
                drafts[turn].results.get_or_insert_with(Vec::new).push((tool_name.clone(), tokens));
            }
            drafts.extend(attachment_draft(&attachments, index, Some(("tool", ordinal, &tool_name))));
            continue;
        }
        open_turn = None;
        if !injected.is_empty() && mixdog_js::js_trim(&text).is_empty() && attachments.is_empty() {
            continue;
        }
        let group = if summary { "summary" } else { role_text };
        let ordinal = next_ordinal(group.to_owned());
        let name = row.get("name").filter(|n| truthy(Some(n))).map(mixdog_js::value_to_string).unwrap_or_default();
        let category = if group == "summary" || role == Role::Developer {
            "system"
        } else if matches!(role, Role::System | Role::User) {
            role_text
        } else {
            "assistant"
        };
        let ordinal_text = mixdog_js::number_to_string(ordinal);
        let shown = if name.is_empty() { format!("{role_text} · {ordinal_text}") } else { format!("{role_text} · {ordinal_text} · {name}") };
        let mut fields = vec![
            ("id", json!(format!("message:{index}"))),
            ("category", json!(category)),
            ("group", json!(group)),
            ("label", json!(label(&shown))),
            ("role", json!(role_text)),
            ("ordinal", num(ordinal)),
        ];
        if !name.is_empty() {
            fields.push(("name", json!(label(&name))));
        }
        fields.extend([("tokens", Value::Null), ("kind", json!("message"))]);
        let mut draft = Draft::new(fields, tokens, Some(index), Preview::Message(without_reasoning(row)));
        draft.results = Some(Vec::new());
        drafts.push(draft);
        let turn = drafts.len() - 1;
        drafts.extend(attachment_draft(&attachments, index, Some((role_text, ordinal, &if name.is_empty() { String::new() } else { label(&name) }))));
        if role == Role::Assistant {
            open_turn = Some(turn);
        }
    }
    // `finalizeToolResults`: a turn's working list is published as `toolResults` when it has any.
    for draft in &mut drafts {
        if let Some(results) = draft.results.take()
            && !results.is_empty()
        {
            let list = results.into_iter().map(|(name, tokens)| json!({ "name": name, "tokens": num(tokens) })).collect();
            draft.fields.insert("toolResults".into(), Value::Array(list));
        }
    }
    drafts
}

/// One tool of the request as the inspector meters it on its own.
enum Tool<'a> {
    Native(&'a Value),
    Defined(&'a ToolDefinition),
}

/// `toolDrafts(tools, deferredCatalogNames)`: one draft per tool definition, priced by its share of the schema tokens.
fn tool_drafts(tools: &RequestTools<'_>, deferred_catalog: &[String], annotations_of: &dyn Fn(&str) -> ToolAnnotations) -> (Vec<Draft>, f64, f64) {
    let list: Vec<Tool<'_>> = tools.native.iter().map(Tool::Native).chain(tools.defined.iter().map(Tool::Defined)).collect();
    let deferred = |tool: &Tool<'_>| match tool {
        Tool::Native(value) => native_deferred(value),
        Tool::Defined(definition) => definition.defer_loading,
    };
    let weights: Vec<f64> = list
        .iter()
        .map(|tool| {
            if deferred(tool) {
                return 0.0;
            }
            let alone = match tool {
                Tool::Native(value) => RequestTools { native: std::slice::from_ref(*value), defined: &[] },
                Tool::Defined(definition) => RequestTools { native: &[], defined: std::slice::from_ref(*definition) },
            };
            estimate_request_reserve_tokens(&alone) as f64
        })
        .collect();
    let schema_tokens = estimate_request_reserve_tokens(tools) as f64;
    let shares = context_shares(&weights, schema_tokens);
    let drafts = list
        .iter()
        .enumerate()
        .map(|(index, tool)| {
            let (name, annotations, preview, shown) = match tool {
                Tool::Native(value) => {
                    let name = value.get("name").filter(|n| truthy(Some(n))).map(mixdog_js::value_to_string).unwrap_or_default();
                    let shown = value.get("name").filter(|n| truthy(Some(n))).or_else(|| value.get("type").filter(|t| truthy(Some(t)))).map(mixdog_js::value_to_string);
                    (name, ToolAnnotations::of_native(value), (*value).clone(), shown)
                }
                Tool::Defined(definition) => {
                    let mut wire = json!({ "name": definition.name, "description": definition.description });
                    if !definition.input_schema.is_null() {
                        wire["input_schema"] = definition.input_schema.clone();
                    }
                    if definition.defer_loading {
                        wire["defer_loading"] = Value::Bool(true);
                    }
                    let shown = (!definition.name.is_empty()).then(|| definition.name.clone());
                    (definition.name.clone(), annotations_of(&definition.name), wire, shown)
                }
            };
            let bucket = tool_schema_bucket(mixdog_js::js_trim(&name), &annotations);
            let category = if matches!(bucket, "mcp" | "memory" | "skills") { bucket } else { "tools" };
            let state = if matches!(tool, Tool::Native(_)) {
                "native"
            } else if deferred(tool) {
                "deferred"
            } else if deferred_catalog.iter().any(|n| *n == name) {
                "loaded"
            } else {
                "active"
            };
            Draft::new(
                vec![
                    ("id", json!(format!("tool:{index}"))),
                    ("category", json!(category)),
                    ("group", json!(state)),
                    ("state", json!(state)),
                    ("label", json!(label(&shown.unwrap_or_else(|| format!("Tool {}", index + 1))))),
                    ("tokens", Value::Null),
                    ("kind", json!("tool")),
                ],
                shares[index],
                None,
                Preview::Json(preview),
            )
        })
        .collect();
    (drafts, schema_tokens, shares.iter().sum())
}

/// `calibrateDrafts(drafts, coverage)`: the drafts the provider's count covers redistributed to sum to it.
fn calibrate(drafts: &mut [Draft], coverage: Option<&Coverage>) -> Value {
    let raw_total: f64 = drafts.iter().map(|d| d.tokens).sum();
    for draft in drafts.iter_mut() {
        draft.estimated = draft.tokens;
    }
    let estimate = || json!({ "source": "estimate", "estimatedTokens": num(raw_total) });
    let Some(coverage) = coverage.filter(|c| c.tokens > 0.0) else { return estimate() };
    let count = coverage.count;
    let covered = |d: &Draft| d.message_index.is_none_or(|i| i < count);
    let fixed: f64 = drafts.iter().filter(|d| covered(d) && d.attachment).map(|d| d.tokens).sum();
    let scalable: Vec<usize> = (0..drafts.len()).filter(|&i| covered(&drafts[i]) && !drafts[i].attachment).collect();
    let scalable_raw: f64 = scalable.iter().map(|&i| drafts[i].tokens).sum();
    if scalable_raw <= 0.0 {
        return estimate();
    }
    let ratio = (coverage.tokens - fixed) / scalable_raw;
    if !(CALIBRATION_MIN..=CALIBRATION_MAX).contains(&ratio) {
        return json!({ "source": "estimate", "estimatedTokens": num(raw_total), "rejectedRatio": num(round(ratio * 1000.0) / 1000.0) });
    }
    let weights: Vec<f64> = scalable.iter().map(|&i| drafts[i].tokens).collect();
    let shares = context_shares(&weights, round(coverage.tokens) - fixed);
    for (at, &i) in scalable.iter().enumerate() {
        drafts[i].tokens = shares[at];
    }
    for draft in drafts.iter_mut() {
        if draft.message_index.is_some_and(|i| i >= count) && !draft.attachment {
            draft.tokens = round(draft.tokens * ratio);
        }
    }
    json!({
        "source": "provider",
        "measuredTokens": num(round(coverage.tokens)),
        "ratio": num(round(ratio * 1000.0) / 1000.0),
        "coveredMessages": count,
        "estimatedTokens": num(raw_total),
    })
}

/// One built reading: its drafts (with their previews) and the listing.
struct Reading {
    revision: String,
    coverage_key: String,
    drafts: Vec<Draft>,
    result: Value,
}

/// What one reading is built from besides the transcript and tools it lists.
struct BuildFacts<'a> {
    /// The status the gauge returned (its request overhead is read from it).
    status: &'a Value,
    /// The annotations of a defined tool, by name (its catalog bucket).
    annotations_of: &'a dyn Fn(&str) -> ToolAnnotations,
}

fn build(input: &StatusInput<'_>, facts: &BuildFacts<'_>, messages: &[AgentMessage], tools: &RequestTools<'_>, revision: String, coverage: Option<&Coverage>, coverage_key: String) -> Reading {
    let mut drafts = message_drafts(messages, input);
    let deferred_catalog: Vec<String> = ["deferredToolCatalog", "deferredLateToolCatalog"]
        .into_iter()
        .flat_map(|key| input.session.get(key).and_then(Value::as_array).cloned().unwrap_or_default())
        .map(|tool| mixdog_js::js_trim(&tool.get("name").filter(|n| truthy(Some(n))).map(mixdog_js::value_to_string).unwrap_or_default()).to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    let (tool_drafts, schema_tokens, shared) = tool_drafts(tools, &deferred_catalog, facts.annotations_of);
    drafts.extend(tool_drafts);
    let overhead = mixdog_js::to_number_of(facts.status.pointer("/request/requestOverheadTokens"));
    let framing = if overhead.is_nan() { 0.0 } else { overhead } + schema_tokens - shared;
    if framing > 0.0 {
        drafts.push(Draft::new(
            vec![
                ("id", json!("request:framing")),
                ("category", json!("tools")),
                ("group", json!("overhead")),
                ("label", json!("Request framing")),
                ("kind", json!("overhead")),
                ("tokens", Value::Null),
            ],
            framing,
            None,
            Preview::Text("Estimated request framing outside message content and individual tool definitions.".into()),
        ));
    }
    let calibration = calibrate(&mut drafts, coverage);
    let entries: Vec<Value> = drafts.iter().map(Draft::entry).collect();
    let categories: Vec<Value> = CATEGORIES
        .iter()
        .map(|(key, name)| {
            let children: Vec<&Draft> = drafts.iter().filter(|d| d.fields.get("category").and_then(Value::as_str) == Some(key)).collect();
            json!({
                "key": key,
                "label": name,
                "tokens": num(children.iter().map(|d| d.tokens).sum()),
                "estimatedTokens": num(children.iter().map(|d| d.estimated).sum()),
                "count": children.len(),
            })
        })
        .collect();
    let estimated: f64 = categories.iter().map(|c| c["tokens"].as_f64().unwrap_or(0.0)).sum();
    let result = json!({ "revision": revision, "categories": categories, "entries": entries, "calibration": calibration, "estimatedTokens": num(estimated) });
    Reading { revision, coverage_key, drafts, result }
}

/// `readContextInspection(built, options)`.
fn read(reading: &Reading, options: &Value) -> Value {
    let Some(entry_id) = options.get("entryId") else { return reading.result.clone() };
    let entry = reading.drafts.iter().find(|d| Some(d.id()) == entry_id.as_str());
    let preview = match entry {
        Some(entry) if options.get("revision").and_then(Value::as_str) == Some(reading.revision.as_str()) => {
            let text = terminal_text(&entry.preview.text());
            json!({ "id": entry.id(), "text": mixdog_js::slice_utf16(&text, PREVIEW_LIMIT), "truncated": mixdog_js::utf16_len(&text) > PREVIEW_LIMIT, "stale": false })
        }
        _ => json!({ "id": entry_id, "stale": true, "text": "", "truncated": false }),
    };
    let mut out = reading.result.clone();
    out["preview"] = preview;
    out
}

/// The last readings the inspector listed (`createInspectionSnapshots`): a preview is answered from the exact reading
/// its entry ids came from, and an unchanged transcript reuses the reading already built for it.
#[derive(Default)]
pub struct Inspections {
    /// Oldest first.
    readings: Mutex<Vec<Arc<Reading>>>,
}

impl Inspections {
    pub fn new() -> Self {
        Self::default()
    }

    /// `withInspection(status, messages, tools, options, session)`: `status` with its `inspection` when `options` asks
    /// for one. `annotations_of` names the annotations of a defined tool (its catalog bucket).
    pub fn attach(&self, mut status: Value, input: &StatusInput<'_>, annotations_of: &dyn Fn(&str) -> ToolAnnotations, options: Option<&Value>) -> Value {
        let Some(options) = options.filter(|o| o.get("inspect") == Some(&Value::Bool(true))) else { return status };
        let requested = if options.get("entryId").is_some() {
            options.get("revision").filter(|r| truthy(Some(r))).map(mixdog_js::value_to_string).unwrap_or_default()
        } else {
            String::new()
        };
        let mut readings = self.readings.lock().unwrap_or_else(PoisonError::into_inner);
        let mut reading = (!requested.is_empty()).then(|| readings.iter().find(|r| r.revision == requested).cloned()).flatten();
        if reading.is_none() {
            // A status of no conversation lists no messages and no tools.
            let live = truthy(input.session.get("id")) && input.active;
            let messages: &[AgentMessage] = if live { input.messages } else { &[] };
            let tools = if live { input.request_tools } else { RequestTools::default() };
            let identity = json!([status.get("sessionId"), status.get("provider"), status.get("model"), input.signer.exact(messages), tool_schema_signature(&tools)]);
            let revision = sha256_hex(mixdog_js::json_stringify(&identity).as_bytes());
            let coverage = provider_coverage(input.session, messages, input.signer);
            let key = coverage.as_ref().map_or_else(|| "none".to_owned(), |c| format!("{}:{}", c.count, mixdog_js::number_to_string(c.tokens)));
            let cached = readings.iter().find(|r| r.revision == revision && r.coverage_key == key).cloned();
            reading = Some(cached.unwrap_or_else(|| {
                let facts = BuildFacts { status: &status, annotations_of };
                Arc::new(build(input, &facts, messages, &tools, revision, coverage.as_ref(), key))
            }));
        }
        let reading = reading.expect("a reading");
        readings.retain(|r| r.revision != reading.revision);
        readings.push(reading.clone());
        while readings.len() > SNAPSHOT_LIMIT {
            readings.remove(0);
        }
        drop(readings);
        let inspection = read(&reading, options);
        if let Some(map) = status.as_object_mut() {
            map.insert("inspection".into(), inspection);
        }
        status
    }
}
