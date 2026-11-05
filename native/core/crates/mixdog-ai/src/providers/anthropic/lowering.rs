//! Lowering of the neutral transcript to Messages API messages: tool-call id
//! projection, assistant replay, tool results, folding of user text into the
//! trailing tool result, and the final tool-pair repair. Cache markers are
//! applied afterwards (see `body`), on the final array.

use std::collections::HashMap;
use std::collections::HashSet;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DocumentSource;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::MessageSource;
use mixdog_core_api::domain::provider::Role;
use mixdog_protocol::ProviderId;
use mixdog_protocol::tool_call_ids;
use mixdog_protocol::tool_call_ids::ANTHROPIC_IDS;
use serde_json::Value;
use serde_json::json;

const ERROR_RESULT_EMPTY_TEXT: &str =
    "[error result had no text; its attached content follows this block]";
const ERROR_RESULT_MEDIA_NOTE: &str =
    "[attached screenshot/media for this failed call follows this block]";
const MISSING_RESULT_TEXT: &str = "[tool_result missing — recovered by sanitizeAnthropicContentPairs]";

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum WireContent {
    Text(String),
    Blocks(Vec<Value>),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WireMessage {
    pub role: &'static str,
    pub content: WireContent,
    /// Set on an effort control message: an empty `system` turn carrying the
    /// `output_config` that takes effect from there.
    pub output_config: Option<Value>,
}

impl WireMessage {
    fn new(role: &'static str, content: WireContent) -> Self {
        Self {
            role,
            content,
            output_config: None,
        }
    }

    pub(crate) fn to_json(&self) -> Value {
        let content = match &self.content {
            WireContent::Text(text) => Value::String(text.clone()),
            WireContent::Blocks(blocks) => Value::Array(blocks.clone()),
        };
        let mut message = json!({ "role": self.role, "content": content });
        if let Some(output_config) = &self.output_config {
            message["output_config"] = output_config.clone();
        }
        message
    }

    fn user_blocks(&self) -> Option<&Vec<Value>> {
        match (&self.role, &self.content) {
            (&"user", WireContent::Blocks(blocks)) => Some(blocks),
            _ => None,
        }
    }

    fn user_blocks_mut(&mut self) -> Option<&mut Vec<Value>> {
        match (&self.role, &mut self.content) {
            (&"user", WireContent::Blocks(blocks)) => Some(blocks),
            _ => None,
        }
    }
}

fn is_blank(text: &str) -> bool {
    text.trim().is_empty()
}

fn block_type(block: &Value) -> Option<&str> {
    block.get("type").and_then(Value::as_str)
}

// ---------------------------------------------------------------------------
// Tool-call ids at the wire
// ---------------------------------------------------------------------------

/// id → wire id for every id Anthropic would refuse. A valid id passes
/// unchanged; a call and its result always map to the same stand-in.
fn wire_id_map(messages: &[Message]) -> HashMap<String, String> {
    let ids = messages.iter().flat_map(|message| -> Vec<&str> {
        match message.role {
            Role::Assistant => message.tool_calls.iter().map(|call| call.id.as_str()).collect(),
            Role::Tool => message.tool_call_id.as_deref().into_iter().collect(),
            _ => Vec::new(),
        }
    });
    tool_call_ids::wire_id_map(ids, ANTHROPIC_IDS)
}

// ---------------------------------------------------------------------------
// Content parts
// ---------------------------------------------------------------------------

fn data_url_parts(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (meta, data) = rest.split_once(',')?;
    let mime = meta.strip_suffix(";base64")?;
    Some((mime, data))
}

fn part_to_block(part: &ContentPart) -> Value {
    match part {
        ContentPart::Text(text) => json!({ "type": "text", "text": text }),
        ContentPart::Image(ImageSource::Base64 { data, mime_type }) => json!({
            "type": "image",
            "source": { "type": "base64", "media_type": mime_type, "data": data },
        }),
        ContentPart::Image(ImageSource::Url(url)) => match data_url_parts(url) {
            Some((mime, data)) => json!({
                "type": "image",
                "source": { "type": "base64", "media_type": mime, "data": data },
            }),
            None => json!({ "type": "image", "source": { "type": "url", "url": url } }),
        },
        ContentPart::Image(ImageSource::FileId(file_id)) => json!({
            "type": "image",
            "source": { "type": "file", "file_id": file_id },
        }),
        ContentPart::File {
            source,
            mime_type,
            filename,
        } => {
            use mixdog_core_api::domain::provider::BinarySource;
            match source {
                BinarySource::Base64(data) if mime_type == "application/pdf" => {
                    let mut block = json!({
                        "type": "document",
                        "source": { "type": "base64", "media_type": "application/pdf", "data": data },
                    });
                    if let Some(title) = filename {
                        block["title"] = Value::String(title.clone());
                    }
                    block
                }
                BinarySource::Base64(_) => json!({
                    "type": "text",
                    "text": format!("[file: {} ({mime_type})]", filename.as_deref().unwrap_or("unnamed")),
                }),
                BinarySource::AttachmentRef(reference) => json!({
                    "type": "text",
                    "text": format!("[attachment: {reference}]"),
                }),
            }
        }
        ContentPart::Document { source, title } => {
            let source = match source {
                DocumentSource::Base64 { media_type, data } => {
                    json!({ "type": "base64", "media_type": media_type, "data": data })
                }
                DocumentSource::Text { media_type, data } => json!({
                    "type": "text",
                    "media_type": media_type.as_deref().unwrap_or("text/plain"),
                    "data": data,
                }),
                DocumentSource::Content(content) => json!({ "type": "content", "content": content }),
            };
            let mut block = json!({ "type": "document", "source": source });
            if let Some(title) = title {
                block["title"] = Value::String(title.clone());
            }
            block
        }
    }
}

fn normalize_content(content: &Content) -> WireContent {
    match content {
        Content::Text(text) => WireContent::Text(text.clone()),
        Content::Parts(parts) => WireContent::Blocks(parts.iter().map(part_to_block).collect()),
    }
}

/// The text of an assistant message (parts joined).
fn assistant_text(content: &Content) -> String {
    match content {
        Content::Text(text) => text.clone(),
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect(),
    }
}

fn is_blank_content(content: &Content) -> bool {
    match content {
        Content::Text(text) => is_blank(text),
        Content::Parts(parts) => parts.is_empty(),
    }
}

fn wire_to_json(content: WireContent) -> Value {
    match content {
        WireContent::Text(text) => Value::String(text),
        WireContent::Blocks(blocks) => Value::Array(blocks),
    }
}

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

/// An `is_error` tool result may hold only text: media is hoisted out as
/// sibling blocks of the same user message.
fn split_error_content(content: WireContent) -> (WireContent, Vec<Value>) {
    let WireContent::Blocks(blocks) = content else {
        return (content, Vec::new());
    };
    let mut texts = Vec::new();
    let mut hoisted = Vec::new();
    for block in &blocks {
        match (block_type(block), block.get("text").and_then(Value::as_str)) {
            (Some("text"), Some(text)) => texts.push(text.to_owned()),
            _ if block.is_object() => hoisted.push(block.clone()),
            _ => {}
        }
    }
    if hoisted.is_empty() {
        return (WireContent::Blocks(blocks), hoisted);
    }
    let text = texts
        .iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let text = if text.is_empty() {
        ERROR_RESULT_EMPTY_TEXT.to_owned()
    } else {
        format!("{text}\n\n{ERROR_RESULT_MEDIA_NOTE}")
    };
    (
        WireContent::Blocks(vec![json!({ "type": "text", "text": text })]),
        hoisted,
    )
}

fn tool_references(message: &Message, own_provider: &str) -> Vec<String> {
    let Some(native) = &message.native_tool_search else {
        return Vec::new();
    };
    let provider = native
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let usable_provider = provider.is_empty()
        || provider == "anthropic"
        || provider == "anthropic-oauth"
        || provider == own_provider;
    if !usable_provider {
        return Vec::new();
    }
    native
        .get("toolReferences")
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(|n| n.trim().to_owned())
                .filter(|n| !n.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn tool_result_content(
    message: &Message,
    references: &[String],
    available: &HashSet<String>,
) -> WireContent {
    let usable: Vec<&String> = references.iter().filter(|n| available.contains(*n)).collect();
    if !usable.is_empty() {
        return WireContent::Blocks(
            usable
                .iter()
                .map(|name| json!({ "type": "tool_reference", "tool_name": name }))
                .collect(),
        );
    }
    let normalized = normalize_content(&message.content);
    if references.is_empty() {
        return normalized;
    }
    match normalized {
        WireContent::Text(text) if !is_blank(&text) => WireContent::Text(text),
        WireContent::Blocks(blocks) if !blocks.is_empty() => WireContent::Blocks(blocks),
        _ => WireContent::Blocks(vec![json!({
            "type": "text",
            "text": format!("[tool references dropped - no longer available: {}]", references.join(", ")),
        })]),
    }
}

// ---------------------------------------------------------------------------
// Folding of user text into the trailing tool result
// ---------------------------------------------------------------------------

/// `true` when the text was folded (the caller must not push the message).
fn fold_user_text_into_tool_result_tail(result: &mut [WireMessage], content: &WireContent) -> bool {
    let Some(last) = result.last_mut() else {
        return false;
    };
    let Some(blocks) = last.user_blocks_mut() else {
        return false;
    };
    let Some(tail) = blocks.last_mut() else {
        return false;
    };
    if block_type(tail) != Some("tool_result") {
        return false;
    }
    if let Some(inner) = tail.get("content").and_then(Value::as_array)
        && inner.iter().any(|b| block_type(b) == Some("tool_reference"))
    {
        return false;
    }
    let texts: Vec<String> = match content {
        WireContent::Text(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() { Vec::new() } else { vec![trimmed.to_owned()] }
        }
        WireContent::Blocks(parts) => {
            let mut texts = Vec::new();
            for part in parts {
                match (block_type(part), part.get("text").and_then(Value::as_str)) {
                    (Some("text"), Some(text)) => {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            texts.push(trimmed.to_owned());
                        }
                    }
                    _ => return false,
                }
            }
            texts
        }
    };
    if texts.is_empty() {
        return true;
    }
    let joined = texts.join("\n\n");
    match tail.get("content").cloned() {
        Some(Value::String(existing)) => {
            let next = if is_blank(&existing) { joined } else { format!("{existing}\n\n{joined}") };
            tail["content"] = Value::String(next);
            true
        }
        Some(Value::Array(mut inner)) => {
            let appended = match inner.last_mut() {
                Some(prev) if block_type(prev) == Some("text") && prev.get("text").is_some_and(Value::is_string) => {
                    let text = prev["text"].as_str().unwrap_or_default();
                    prev["text"] = Value::String(format!("{text}\n\n{joined}"));
                    true
                }
                _ => false,
            };
            if !appended {
                inner.push(json!({ "type": "text", "text": joined }));
            }
            tail["content"] = Value::Array(inner);
            true
        }
        _ => false,
    }
}

/// Sibling blocks of a user message that follows an already-sent tool-result
/// tail; blank text is dropped.
fn sibling_blocks(content: WireContent) -> Vec<Value> {
    let blocks = match content {
        WireContent::Text(text) => vec![json!({ "type": "text", "text": text })],
        WireContent::Blocks(blocks) => blocks,
    };
    blocks
        .into_iter()
        .filter(|b| {
            !(block_type(b) == Some("text")
                && b.get("text").and_then(Value::as_str).is_some_and(is_blank))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------

pub(crate) struct LowerContext<'a> {
    /// Owner of the replay envelopes this wire reads.
    pub owner: &'a ProviderId,
    /// The provider name used to recognise its own tool references.
    pub own_provider: &'a str,
    /// Names of the tools this request ships.
    pub available_tools: &'a HashSet<String>,
}

pub(crate) fn lower_messages(messages: &[Message], cx: &LowerContext<'_>) -> Vec<WireMessage> {
    let ids = wire_id_map(messages);
    let wire_id = |id: &str| ids.get(id).cloned().unwrap_or_else(|| id.to_owned());
    let mut result: Vec<WireMessage> = Vec::new();
    // Indices of tool-result user messages a request already carried.
    let mut sent: HashSet<usize> = HashSet::new();
    let mut after_dropped_final = false;
    for message in messages {
        if message.role == Role::System {
            continue;
        }
        let turn_boundary = after_dropped_final;
        after_dropped_final = false;
        if message.role == Role::Assistant
            && let Some(blocks) = assistant_blocks(message, cx, &wire_id)
        {
            result.push(WireMessage::new("assistant", WireContent::Blocks(blocks)));
            continue;
        }
        if message.role == Role::Tool {
            let references = tool_references(message, cx.own_provider);
            let content = tool_result_content(message, &references, cx.available_tools);
            let (content, hoisted) = if message.is_error {
                split_error_content(content)
            } else {
                (content, Vec::new())
            };
            let mut block = json!({
                "type": "tool_result",
                "tool_use_id": message.tool_call_id.as_deref().map(&wire_id).unwrap_or_default(),
                "content": wire_to_json(content),
            });
            if message.is_error {
                block["is_error"] = Value::Bool(true);
            }
            match result.last_mut().and_then(WireMessage::user_blocks_mut) {
                Some(blocks) => {
                    blocks.push(block);
                    blocks.extend(hoisted);
                }
                None => {
                    let mut blocks = vec![block];
                    blocks.extend(hoisted);
                    result.push(WireMessage::new("user", WireContent::Blocks(blocks)));
                }
            }
            if message.source == Some(MessageSource::StreamCutRecovery) {
                sent.insert(result.len() - 1);
            }
            continue;
        }
        let is_user = matches!(message.role, Role::User | Role::Developer);
        let steering = message.source == Some(MessageSource::Steering);
        // Text after a tool result a request already carried joins that user
        // message as sibling blocks: folding would rewrite a cached block.
        if is_user
            && !steering
            && let Some(tail) = result.len().checked_sub(1)
            && sent.contains(&tail)
        {
            let siblings = sibling_blocks(normalize_content(&message.content));
            if let Some(blocks) = result[tail].user_blocks_mut() {
                blocks.extend(siblings);
            }
            continue;
        }
        // Text right after a tool result belongs to it (steering keeps its
        // own turn so provenance survives).
        if is_user && !steering && !turn_boundary {
            let content = normalize_content(&message.content);
            if fold_user_text_into_tool_result_tail(&mut result, &content) {
                if message.source == Some(MessageSource::StreamCutRecovery) {
                    sent.insert(result.len() - 1);
                }
                continue;
            }
        }
        if message.role == Role::Assistant && is_blank_content(&message.content) {
            after_dropped_final = true;
            continue;
        }
        result.push(WireMessage::new(
            if message.role == Role::Assistant { "assistant" } else { "user" },
            normalize_content(&message.content),
        ));
    }
    sanitize_content_pairs(result)
}

/// The block list of an assistant turn that carries structure (replay,
/// ordered blocks, thinking blocks or tool calls); `None` for a plain one.
fn assistant_blocks(
    message: &Message,
    cx: &LowerContext<'_>,
    wire_id: &dyn Fn(&str) -> String,
) -> Option<Vec<Value>> {
    let mut replay: Vec<Value> = Vec::new();
    for envelope in message.replay_for(cx.owner) {
        match &envelope.items {
            Value::Array(items) => replay.extend(items.iter().cloned()),
            Value::Null => {}
            other => replay.push(other.clone()),
        }
    }
    let ordered = message.assistant_blocks.as_ref().and_then(Value::as_array);
    let thinking = message.thinking_blocks.as_ref().and_then(Value::as_array);
    if !replay.is_empty() {
        return Some(replay);
    }
    if let Some(blocks) = ordered
        && !blocks.is_empty()
    {
        return Some(blocks.clone());
    }
    if message.tool_calls.is_empty() && thinking.is_none_or(|t| t.is_empty()) {
        return None;
    }
    // Thinking blocks come back unmodified and ahead of the tool calls.
    let mut blocks: Vec<Value> = thinking
        .into_iter()
        .flatten()
        .filter(|b| b.is_object())
        .cloned()
        .collect();
    let text = assistant_text(&message.content);
    if !is_blank(&text) {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    for call in &message.tool_calls {
        blocks.push(json!({
            "type": "tool_use",
            "id": wire_id(&call.id),
            "name": call.name,
            "input": call.arguments,
        }));
    }
    Some(blocks)
}

// ---------------------------------------------------------------------------
// Tool-pair repair (final)
// ---------------------------------------------------------------------------

fn strip_orphan_tool_results(message: &mut WireMessage, allowed: &HashSet<String>) {
    let Some(blocks) = message.user_blocks_mut() else {
        return;
    };
    blocks.retain(|b| {
        if block_type(b) != Some("tool_result") {
            return true;
        }
        match b.get("tool_use_id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => !allowed.is_empty() && allowed.contains(id),
            _ => false,
        }
    });
}

fn tool_use_ids(message: &WireMessage) -> Vec<String> {
    match (&message.role, &message.content) {
        (&"assistant", WireContent::Blocks(blocks)) => blocks
            .iter()
            .filter(|b| block_type(b) == Some("tool_use"))
            .filter_map(|b| b.get("id").and_then(Value::as_str))
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

fn sanitize_content_pairs(messages: Vec<WireMessage>) -> Vec<WireMessage> {
    let mut work = messages;
    let mut out: Vec<WireMessage> = Vec::with_capacity(work.len());
    let mut pending: HashSet<String> = HashSet::new();
    for i in 0..work.len() {
        if let Some(had_results) = work[i]
            .user_blocks()
            .map(|blocks| blocks.iter().any(|b| block_type(b) == Some("tool_result")))
        {
            strip_orphan_tool_results(&mut work[i], &pending);
            if had_results {
                pending.clear();
            }
        }
        if work[i].role == "assistant"
            && let WireContent::Blocks(blocks) = &mut work[i].content
        {
            blocks.retain(|b| {
                !(block_type(b) == Some("tool_use")
                    && b.get("id").and_then(Value::as_str).is_none_or(str::is_empty))
            });
        }
        if work[i].user_blocks().is_some_and(Vec::is_empty) {
            continue;
        }
        let ids = tool_use_ids(&work[i]);
        let is_assistant_blocks =
            work[i].role == "assistant" && matches!(work[i].content, WireContent::Blocks(_));
        out.push(work[i].clone());
        if !is_assistant_blocks {
            continue;
        }
        pending = ids.iter().cloned().collect();
        if ids.is_empty() {
            continue;
        }
        let answered: HashSet<String> = match work.get_mut(i + 1) {
            Some(next) if next.user_blocks().is_some() => {
                strip_orphan_tool_results(next, &pending);
                next.user_blocks()
                    .into_iter()
                    .flatten()
                    .filter(|b| block_type(b) == Some("tool_result"))
                    .filter_map(|b| b.get("tool_use_id").and_then(Value::as_str))
                    .filter(|id| !id.is_empty())
                    .map(str::to_owned)
                    .collect()
            }
            _ => HashSet::new(),
        };
        let stubs: Vec<Value> = ids
            .iter()
            .filter(|id| !answered.contains(*id))
            .map(|id| {
                json!({
                    "type": "tool_result",
                    "tool_use_id": id,
                    "content": MISSING_RESULT_TEXT,
                    "is_error": true,
                })
            })
            .collect();
        match work.get_mut(i + 1) {
            Some(next) if next.user_blocks().is_some() => lead_with_tool_results(next, stubs),
            _ if !stubs.is_empty() => out.push(WireMessage::new("user", WireContent::Blocks(stubs))),
            _ => {}
        }
    }
    out
}

/// Tool results lead the user message that answers a tool use.
fn lead_with_tool_results(message: &mut WireMessage, stubs: Vec<Value>) {
    let Some(blocks) = message.user_blocks_mut() else {
        return;
    };
    let (results, others): (Vec<Value>, Vec<Value>) = std::mem::take(blocks)
        .into_iter()
        .partition(|b| block_type(b) == Some("tool_result"));
    blocks.extend(stubs);
    blocks.extend(results);
    blocks.extend(others);
}
