//! `ModelRequest` → Chat Completions body (`openai-compat-wire.mjs
//! toOpenAIMessages`, `openai-compat-chat-send.mjs`).

use crate::providers::file_text::{FileKind, file_fallback_text, file_kind};
use mixdog_core_api::domain::provider::{
    BinarySource, Content, ContentPart, DeliveryState, DocumentSource, ErrorKind, ImageSource,
    Message, ModelRequest, ProviderError, Role, ToolDefinition,
};
use mixdog_protocol::{JsonObject, JsonValue, ProviderId};
use serde_json::json;

use super::super::models::CompatModelInfo;
use super::super::pairing::{ensure_chat_tool_pairs, wire_tool_call_ids};
use super::super::profile::{ChatDialect, CompatProfile, ReasoningShape};
use super::{options, reasoning};

/// A request this endpoint cannot carry; nothing was sent.
fn unsendable(message: String) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    err.message = message;
    err
}

fn text_part(text: impl Into<String>) -> JsonValue {
    json!({"type": "text", "text": text.into()})
}

fn is_media(part: &JsonValue) -> bool {
    matches!(
        part.get("type").and_then(JsonValue::as_str),
        Some("image_url" | "file")
    )
}

fn label(filename: Option<&str>, fallback: &str) -> String {
    filename.filter(|n| !n.is_empty()).unwrap_or(fallback).to_owned()
}


/// A PDF is lowered to text before the request is built (this wire has no
/// document block); one that reaches the builder is a caller error.
fn pdf_not_prepared(label: &str) -> ProviderError {
    unsendable(format!(
        "{label}: this endpoint takes no PDF block; the PDF must be converted to text first"
    ))
}

fn lower_part(part: &ContentPart) -> Result<Option<JsonValue>, ProviderError> {
    Ok(match part {
        ContentPart::Text(text, _) => (!text.is_empty()).then(|| text_part(text)),
        ContentPart::Image(ImageSource::Base64 { data, mime_type, .. }) => Some(
            json!({"type": "image_url", "image_url": {"url": format!("data:{mime_type};base64,{data}")}}),
        ),
        ContentPart::Image(ImageSource::Url(url)) => {
            Some(json!({"type": "image_url", "image_url": {"url": url}}))
        }
        ContentPart::Image(ImageSource::FileId(id)) => Some(text_part(format!(
            "[unsupported image file_id for OpenAI Chat-compatible request: {id}]"
        ))),
        ContentPart::File {
            source,
            mime_type,
            filename,
            ..
        } => {
            let name = label(filename.as_deref(), mime_type);
            match source {
                BinarySource::Base64(data) if file_kind(mime_type, data, filename.as_deref()) == FileKind::Pdf => {
                    return Err(pdf_not_prepared(&name));
                }
                BinarySource::Base64(data) => Some(text_part(file_fallback_text(filename.as_deref(), mime_type, data))),
                BinarySource::AttachmentRef(_) => {
                    Some(text_part(format!("[attachment unavailable: {name}]")))
                }
            }
        }
        ContentPart::Document { source, title } => match source {
            DocumentSource::Base64 { media_type, data } => {
                let name = label(title.as_deref(), media_type);
                if file_kind(media_type, data, title.as_deref()) == FileKind::Pdf {
                    return Err(pdf_not_prepared(&name));
                }
                Some(text_part(file_fallback_text(title.as_deref(), media_type, data)))
            }
            DocumentSource::Text { media_type, data } => {
                let name = label(title.as_deref(), media_type.as_deref().unwrap_or("text"));
                Some(text_part(format!("--- {name} ---\n{data}")))
            }
            DocumentSource::Content(value) => Some(text_part(value.to_string())),
        },
    })
}

fn lower_parts(parts: &[ContentPart]) -> Result<Vec<JsonValue>, ProviderError> {
    let mut out = Vec::with_capacity(parts.len());
    for part in parts {
        if let Some(lowered) = lower_part(part)? {
            out.push(lowered);
        }
    }
    Ok(out)
}

fn joined_text(parts: &[JsonValue]) -> String {
    parts
        .iter()
        .filter_map(|p| p.get("text").and_then(JsonValue::as_str))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Message content: a string stays a string; a user's parts stay a list
/// (images and files ride in it); every other role takes the joined text.
fn content_value(role: Role, content: &Content) -> Result<JsonValue, ProviderError> {
    match content {
        Content::Text(text) => Ok(JsonValue::String(text.clone())),
        Content::Parts(parts) => {
            let lowered = lower_parts(parts)?;
            if role != Role::User {
                return Ok(JsonValue::String(joined_text(&lowered)));
            }
            Ok(if lowered.is_empty() {
                JsonValue::String(String::new())
            } else {
                JsonValue::Array(lowered)
            })
        }
    }
}

const TOOL_MEDIA_NOTE: &str = "[tool result included media content in the following user message]";

/// A tool result's text, and its media for the user message that follows the
/// run of tool messages (a tool message carries text only).
fn split_tool_content(content: &Content) -> Result<(String, Vec<JsonValue>), ProviderError> {
    match content {
        Content::Text(text) => Ok((text.clone(), Vec::new())),
        Content::Parts(parts) => {
            let lowered = lower_parts(parts)?;
            let media: Vec<JsonValue> = lowered.iter().filter(|p| is_media(p)).cloned().collect();
            // A tool result's text is each part's own text: an image given by file id
            // has none (the placeholder is for message content only).
            let texted: Vec<ContentPart> =
                parts.iter().filter(|p| !matches!(p, ContentPart::Image(ImageSource::FileId(_)))).cloned().collect();
            let text = joined_text(&lower_parts(&texted)?);
            if media.is_empty() {
                Ok((text, media))
            } else if text.is_empty() {
                Ok((TOOL_MEDIA_NOTE.to_owned(), media))
            } else {
                Ok((text, media))
            }
        }
    }
}

fn role_name(role: Role, dialect: &ChatDialect) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
        // The `developer` role is documented by some endpoints only; every
        // other chat endpoint knows `system`.
        Role::Developer if dialect.developer_role => "developer",
        Role::Developer => "system",
    }
}

fn attach_reasoning(
    dialect: &ChatDialect,
    owner: &ProviderId,
    source: &Message,
    msg: &mut JsonObject,
) {
    let Some(replayed) = source.replay_for(owner).filter_map(reasoning::replayed).last() else {
        if dialect.pad_tool_call_reasoning && !source.tool_calls.is_empty() {
            msg.insert("reasoning_content".into(), " ".into());
        }
        return;
    };
    match dialect.reasoning_shape {
        Some(shape) => {
            if !replayed.text.is_empty() {
                match shape {
                    ReasoningShape::SameKey => {
                        let key = if replayed.field == Some("reasoning") {
                            "reasoning"
                        } else {
                            "reasoning_content"
                        };
                        msg.insert(key.into(), replayed.text.into());
                    }
                    // reasoning_details replace the text when present.
                    ReasoningShape::Reasoning if replayed.details.is_none() => {
                        msg.insert("reasoning".into(), replayed.text.into());
                    }
                    ReasoningShape::ContentChunks if replayed.field == Some("content_chunks") => {
                        let content = msg.shift_remove("content").unwrap_or(JsonValue::Null);
                        msg.insert(
                            "content".into(),
                            reasoning::content_with_thinking_chunk(content, replayed.text),
                        );
                    }
                    ReasoningShape::Reasoning | ReasoningShape::ContentChunks | ReasoningShape::ReadOnly => {}
                }
            }
            if shape == ReasoningShape::Reasoning
                && let Some(details) = replayed.details
            {
                msg.insert("reasoning_details".into(), JsonValue::Array(details.clone()));
            }
        }
        None if dialect.pad_tool_call_reasoning => {
            if !replayed.text.is_empty() {
                msg.insert("reasoning_content".into(), replayed.text.into());
            } else if !source.tool_calls.is_empty() {
                msg.insert("reasoning_content".into(), " ".into());
            }
        }
        None if dialect.replay_reasoning => {
            msg.insert("reasoning_content".into(), replayed.text.into());
        }
        None => {}
    }
}

fn lower_messages(
    dialect: &ChatDialect,
    owner: &ProviderId,
    messages: &[Message],
) -> Result<Vec<JsonValue>, ProviderError> {
    let ids = wire_tool_call_ids(messages);
    let wire_id = |id: &str| -> String { ids.get(id).cloned().unwrap_or_else(|| id.to_owned()) };
    let mut out: Vec<JsonValue> = Vec::with_capacity(messages.len());
    let mut pending_media: Vec<JsonValue> = Vec::new();
    for message in messages {
        if message.role == Role::Tool {
            let (output, media) = split_tool_content(&message.content)?;
            out.push(json!({
                "role": "tool",
                "tool_call_id": wire_id(message.tool_call_id.as_deref().unwrap_or("")),
                "content": output,
            }));
            pending_media.extend(media);
            continue;
        }
        if !pending_media.is_empty() {
            out.push(json!({"role": "user", "content": std::mem::take(&mut pending_media)}));
        }
        let mut msg = JsonObject::new();
        msg.insert("role".into(), role_name(message.role, dialect).into());
        if message.role == Role::Assistant && !message.tool_calls.is_empty() {
            let content = content_value(Role::Assistant, &message.content)?;
            msg.insert(
                "content".into(),
                match content {
                    JsonValue::String(s) if s.is_empty() => JsonValue::Null,
                    other => other,
                },
            );
            let calls: Vec<JsonValue> = message
                .tool_calls
                .iter()
                .map(|call| {
                    json!({
                        "id": wire_id(&call.id),
                        "type": "function",
                        "function": {"name": call.name, "arguments": call.arguments.to_string()},
                    })
                })
                .collect();
            msg.insert("tool_calls".into(), JsonValue::Array(calls));
        } else {
            msg.insert("content".into(), content_value(message.role, &message.content)?);
        }
        if message.role == Role::Assistant {
            attach_reasoning(dialect, owner, message, &mut msg);
        }
        out.push(JsonValue::Object(msg));
    }
    if !pending_media.is_empty() {
        out.push(json!({"role": "user", "content": pending_media}));
    }
    Ok(ensure_chat_tool_pairs(out))
}

fn tools_value(tools: &[ToolDefinition]) -> JsonValue {
    JsonValue::Array(
        tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    },
                })
            })
            .collect(),
    )
}

/// The request body of one Chat Completions attempt.
pub fn build_body(
    profile: &CompatProfile,
    owner: &ProviderId,
    request: &ModelRequest,
    info: Option<&CompatModelInfo>,
    tools: &[ToolDefinition],
) -> Result<JsonObject, ProviderError> {
    let mut body = JsonObject::new();
    let model = if request.model.is_empty() {
        profile.default_model
    } else {
        request.model.as_str()
    };
    body.insert("model".into(), model.into());
    body.insert(
        "messages".into(),
        JsonValue::Array(lower_messages(&profile.chat, owner, &request.messages)?),
    );
    options::apply_max_tokens(&profile.chat, request, &mut body);
    if !tools.is_empty() {
        body.insert("tools".into(), tools_value(tools));
    }
    options::apply(&profile.chat, request, info, &mut body);
    body.insert("stream".into(), true.into());
    body.insert("stream_options".into(), json!({"include_usage": true}));
    Ok(body)
}

/// The text of every message this dialect sends as `system` (a `developer`
/// message counts unless the dialect keeps the role), as the lowering writes
/// it. The xAI Responses cache prefix is identified by these.
pub fn system_texts(dialect: &ChatDialect, messages: &[Message]) -> Result<Vec<String>, ProviderError> {
    let mut texts = Vec::new();
    for message in messages.iter().filter(|m| role_name(m.role, dialect) == "system") {
        // A non-user role's content is always text.
        if let JsonValue::String(text) = content_value(message.role, &message.content)? {
            texts.push(text);
        }
    }
    Ok(texts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::listing_row::testing::fixture;
    use mixdog_core_api::domain::provider::ToolCall;

    fn part(spec: &JsonValue) -> ContentPart {
        let text = |key: &str| spec[key].as_str().unwrap().to_owned();
        let b64 = |bytes: &[u8]| base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
        let file = |filename: String, mime: &str, data: String| ContentPart::File {
            source: BinarySource::Base64(data),
            mime_type: mime.to_owned(),
            filename: Some(filename),
            text: None,
        };
        match spec["kind"].as_str().unwrap() {
            "text" => ContentPart::Text(text("text"), None),
            "image_url" => ContentPart::Image(ImageSource::Url(text("url"))),
            "image_base64" => ContentPart::Image(ImageSource::Base64 { data: text("data"), mime_type: text("mime"), width: None, height: None }),
            "image_file_id" => ContentPart::Image(ImageSource::FileId(text("id"))),
            "file_text" => file(text("filename"), "text/plain", b64(spec["text"].as_str().unwrap().as_bytes())),
            "file_binary" => file(text("filename"), "application/octet-stream", b64(&[0, 1, 2, 255])),
            other => panic!("unknown part kind {other}"),
        }
    }

    fn message(spec: &JsonValue) -> Message {
        let role = match spec["role"].as_str().unwrap() {
            "system" => Role::System,
            "developer" => Role::Developer,
            "user" => Role::User,
            "assistant" => Role::Assistant,
            _ => Role::Tool,
        };
        let parts = spec["parts"].as_array().unwrap().iter().map(part).collect();
        let mut message = Message::new(role, Content::Parts(parts));
        message.tool_call_id = spec["toolCallId"].as_str().map(str::to_owned);
        message.tool_calls = spec["toolCalls"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| ToolCall {
                id: c["id"].as_str().unwrap().to_owned(),
                name: c["name"].as_str().unwrap().to_owned(),
                arguments: c["arguments"].clone(),
                native_type: None,
            })
            .collect();
        message
    }

    /// Multipart content of every role lowers to Node's Chat Completions
    /// messages: text joined by newlines outside user messages, media dropped
    /// from system/assistant text, a tool result's media moved to a user
    /// message, a non-text file named by `name (mime, N bytes)`.
    #[test]
    fn multipart_content_lowers_as_nodes_to_openai_messages() {
        let golden = fixture("oracles/chat-parts-messages.json");
        let profile = CompatProfile::deepseek();
        let owner = ProviderId::from("deepseek");
        let mut checked = 0;
        for case in golden["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let messages: Vec<Message> = case["messages"].as_array().unwrap().iter().map(message).collect();
            let got = lower_messages(&profile.chat, &owner, &messages).unwrap();
            let mut node = case["node"].clone();
            if name == "empty-text-part" {
                // Node lowers an empty text part to its own JSON as text; a part with no text is dropped here.
                let junk = json!({"type": "text", "text": "{\"type\":\"text\",\"text\":\"\"}"});
                let parts = node[0]["content"].as_array_mut().unwrap();
                assert_eq!(parts.remove(0), junk);
            }
            assert_eq!(JsonValue::Array(got), node, "{name}");
            checked += 1;
        }
        assert_eq!(checked, 11);
    }
}
