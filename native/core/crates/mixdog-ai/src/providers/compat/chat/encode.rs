//! `ModelRequest` → Chat Completions body (`openai-compat-wire.mjs
//! toOpenAIMessages`, `openai-compat-chat-send.mjs`).

use crate::providers::file_text::{FileKind, file_fallback_text, file_kind};use mixdog_core_api::domain::provider::{
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

#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
fn lower_part(part: &ContentPart, cache_control: bool) -> Result<Option<JsonValue>, ProviderError> {
    Ok(match part {
        ContentPart::Text(text, extra) => (!text.is_empty()).then(|| {
            let mut part = text_part(text);
            if cache_control
                && let Some(marker) = extra.as_ref().and_then(|m| m.get("cache_control")).filter(|v| v.is_object())
            {
                part["cache_control"] = marker.clone();
            }
            part
        }),
        // The media type is the one the image's bytes have (`prepare_images`, before the request is built).
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

#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
fn lower_parts(parts: &[ContentPart], cache_control: bool) -> Result<Vec<JsonValue>, ProviderError> {
    let mut out = Vec::with_capacity(parts.len());
    for part in parts {
        if let Some(lowered) = lower_part(part, cache_control)? {
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

/// User parts keep their media. Compatible system parts keep their block
/// boundaries when multipart or explicitly marked; other roles take text.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
fn content_value(role: Role, content: &Content, cache_control: bool) -> Result<JsonValue, ProviderError> {
    match content {
        Content::Text(text) => Ok(JsonValue::String(text.clone())),
        Content::Parts(parts) => {
            let mut lowered = lower_parts(parts, cache_control)?;
            if cache_control && role == Role::System {
                lowered.retain(|part| part["type"] == "text");
                if lowered.len() > 1 || lowered.iter().any(|part| part.get("cache_control").is_some()) {
                    return Ok(JsonValue::Array(lowered));
                }
            }
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
#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
fn split_tool_content(content: &Content, omit_file_ids: bool) -> Result<(String, Vec<JsonValue>), ProviderError> {
    match content {
        Content::Text(text) => Ok((text.clone(), Vec::new())),
        Content::Parts(parts) => {
            let mut lowered = Vec::with_capacity(parts.len());
            for part in parts {
                if omit_file_ids && matches!(part, ContentPart::Image(ImageSource::FileId(_))) {
                    continue;
                }
                if let Some(part) = lower_part(part, false)? {
                    lowered.push(part);
                }
            }
            let media: Vec<JsonValue> = lowered.iter().filter(|p| is_media(p)).cloned().collect();
            let text = joined_text(&lowered);
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

#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
fn lower_messages(
    dialect: &ChatDialect,
    owner: &ProviderId,
    messages: &[Message],
    cache_control: bool,
) -> Result<Vec<JsonValue>, ProviderError> {
    let ids = wire_tool_call_ids(messages);
    let wire_id = |id: &str| -> String { ids.get(id).cloned().unwrap_or_else(|| id.to_owned()) };
    let mut out: Vec<JsonValue> = Vec::with_capacity(messages.len());
    let mut pending_media: Vec<JsonValue> = Vec::new();
    for message in messages {
        if message.role == Role::Tool {
            // xAI's replay omits file-ID images from tool text; turning them
            // into placeholders would change an otherwise unchanged prefix.
            let (output, media) = split_tool_content(&message.content, owner.as_str() == "xai")?;
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
            let content = content_value(Role::Assistant, &message.content, false)?;
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
            msg.insert("content".into(), content_value(message.role, &message.content, cache_control)?);
        }
        if message.role == Role::Assistant {
            attach_reasoning(dialect, owner, message, &mut msg);
        }
        out.push(JsonValue::Object(msg));
    }
    if !pending_media.is_empty() {
        out.push(json!({"role": "user", "content": pending_media}));
    }
    let mut out = ensure_chat_tool_pairs(out);
    use crate::providers::tool_result_copies::{WireUse, receipts};
    let uses = out.iter().enumerate().flat_map(|(index, item)| {
        let calls = item["tool_calls"].as_array().into_iter().flatten().filter_map(move |call| {
            Some((index, call["id"].as_str()?, WireUse::Call))
        });
        let result = (|| {
            (item["role"] == "tool").then_some(())?;
            Some((index, item["tool_call_id"].as_str()?, WireUse::Result(item["content"].as_str())))
        })();
        calls.chain(result)
    });
    for (index, receipt) in receipts(messages, wire_id, uses) {
        out[index]["content"] = receipt.into();
    }
    Ok(out)
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
#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
pub fn build_body(
    profile: &CompatProfile,
    owner: &ProviderId,
    request: &ModelRequest,
    info: Option<&CompatModelInfo>,
    tools: &[ToolDefinition],
    cache_control: bool,
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
        JsonValue::Array(lower_messages(&profile.chat, owner, &request.messages, cache_control)?),
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
#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
pub fn system_texts(dialect: &ChatDialect, messages: &[Message]) -> Result<Vec<String>, ProviderError> {
    let mut texts = Vec::new();
    for message in messages.iter().filter(|m| role_name(m.role, dialect) == "system") {
        // A non-user role's content is always text.
        if let JsonValue::String(text) = content_value(message.role, &message.content, false)? {
            texts.push(text);
        }
    }
    Ok(texts)
}

#[cfg(test)]
mod tests {
    #[test]
    fn scoped_hits_cite_only_an_exact_earlier_body_in_the_payload() {
        use super::{CompatProfile, Content, Message, ProviderId, Role, lower_messages};
        use crate::providers::openai::input::{LowerExtras, LowerOptions, ToolSearchReplay, lower_from};
        use mixdog_core_api::domain::provider::{ScopedCacheSource, ToolCall};
        use serde_json::json;
        use sha2::{Digest, Sha256};

        let owner = ProviderId::from("deepseek");
        let body = "src/first.rs:12: parsed configuration\nsrc/second.rs:35: resolved the workspace";
        let pair = |id: &str, body: &str| {
            let mut assistant = Message::new(Role::Assistant, Content::Text(String::new()));
            assistant.tool_calls.push(ToolCall {
                id: id.to_owned(),
                name: "grep".into(),
                arguments: json!({"pattern": "configuration"}),
                native_type: None,
            });
            let mut result = Message::new(Role::Tool, Content::Text(body.to_owned()));
            result.tool_call_id = Some(id.to_owned());
            [assistant, result]
        };
        let [first_call, first_result] = pair("call_source", body);
        let [next_call, mut hit] = pair("call_hit", body);
        hit.scoped_cache_source = Some(ScopedCacheSource {
            call_id: "call_source".into(),
            body_sha256: format!("{:x}", Sha256::digest(body.as_bytes())),
        });
        let messages = [
            first_call,
            first_result,
            Message::new(Role::User, Content::Text("Check the result again.".into())),
            next_call,
            hit,
        ];
        let profile = CompatProfile::deepseek();
        let options = LowerOptions {
            replay_owner: ProviderId::from("openai-responses"),
            codex_parity: false,
            native_tool_search: false,
            custom_tools: false,
            replay_reasoning: false,
            tool_search_replay: ToolSearchReplay::Downgrade,
            phase: false,
            system_in_input: false,
        };
        let check = |messages: &[Message], start_index: usize, source: Option<&str>, output: &str| {
            let expected: Vec<_> = source.into_iter().map(|text| ("call_source", text))
                .chain([("call_hit", output)]).collect();
            let chat = lower_messages(&profile.chat, &owner, &messages[start_index..], false).unwrap();
            let responses = lower_from(messages, &options, &LowerExtras { start_index, ..LowerExtras::default() });
            for (wire, kind, id, content) in [
                (&chat, "role", "tool_call_id", "content"),
                (&responses, "type", "call_id", "output"),
            ] {
                let actual: Vec<_> = wire.iter()
                    .filter(|m| matches!(m[kind].as_str(), Some("tool" | "function_call_output")))
                    .map(|m| (m[id].as_str().unwrap(), m[content].as_str().unwrap())).collect();
                assert_eq!(actual, expected, "{kind}");
            }
        };
        check(&messages, 0, Some(body), "Same result as tool call call_source above.");
        // The context can be cut, or a provider can receive only a suffix.
        check(&messages, 3, None, body);
        let mut changed = messages.clone();
        changed[1].content = Content::Text("src/first.rs:13: changed evidence".into());
        check(&changed, 0, Some("src/first.rs:13: changed evidence"), body);
        let mut failed_source = messages.clone();
        failed_source[1].is_error = true;
        check(&failed_source, 0, Some(body), body);

        let excerpt = "src/first.rs:12: parsed configuration\nsrc/second.rs:35: resolved the";
        let mut edited = messages.clone();
        for index in [1, 4] {
            edited[index].content = Content::Text(excerpt.into());
        }
        check(&edited, 0, Some(excerpt), excerpt);

        let output_for_hit = |messages: &[Message]| {
            let chat = lower_messages(&profile.chat, &owner, messages, false).unwrap();
            let responses = lower_from(messages, &options, &LowerExtras::default());
            for (wire, id, content) in [
                (chat, "tool_call_id", "content"),
                (responses, "call_id", "output"),
            ] {
                let hit = wire.iter().find_map(|item| {
                    (item[id] == "call_hit").then(|| item[content].as_str()).flatten()
                });
                assert_eq!(hit, Some(body), "{id}");
            }
        };
        let mut duplicate_row = messages.to_vec();
        duplicate_row.insert(2, messages[1].clone());
        output_for_hit(&duplicate_row);
        let mut duplicate_call = messages.to_vec();
        let [repeated_call, repeated_result] = pair("call_source", body);
        duplicate_call.splice(2..2, [repeated_call, repeated_result]);
        output_for_hit(&duplicate_call);

        // The original is absent. A different call projects to the spelling
        // of that missing ID on both wires, and cannot stand in as its evidence.
        let [other_call, other_result] = pair("functions.read/0", body);
        let mut collision = messages;
        collision[0] = other_call;
        collision[1] = other_result;
        let stand_in = "functions_read_0_cf21bf139e";
        collision[4].scoped_cache_source.as_mut().unwrap().call_id = stand_in.into();
        check_wire_source_id(&collision, stand_in, &profile, &owner, &options);
        output_for_hit(&collision);
    }

    fn check_wire_source_id(
        messages: &[super::Message],
        id: &str,
        profile: &super::CompatProfile,
        owner: &super::ProviderId,
        options: &crate::providers::openai::input::LowerOptions,
    ) {
        let chat = super::lower_messages(&profile.chat, owner, messages, false).unwrap();
        let responses = crate::providers::openai::input::lower(messages, options);
        assert!(chat.iter().any(|item| item["tool_call_id"] == id));
        assert!(responses.iter().any(|item| item["type"] == "function_call_output" && item["call_id"] == id));
    }

    /// A tool result whose only content is an image given by file id has no image on this wire; what stands for it is
    /// kept in the result's text, so the model is told it was there (it used to vanish from the text altogether).
    #[test]
    fn a_file_id_image_in_a_tool_result_leaves_its_placeholder_in_the_text() {
        use mixdog_core_api::domain::provider::{Content, ContentPart, ImageSource};
        let (text, media) = super::split_tool_content(&Content::Parts(vec![
            ContentPart::Text("shot".into(), None),
            ContentPart::Image(ImageSource::FileId("file-9".into())),
        ]), false)
        .expect("lowers");
        assert!(media.is_empty());
        assert_eq!(text, "shot\n[unsupported image file_id for OpenAI Chat-compatible request: file-9]");
        let (only, _) = super::split_tool_content(&Content::Parts(vec![ContentPart::Image(ImageSource::FileId("file-9".into()))]), false).expect("lowers");
        assert_eq!(only, "[unsupported image file_id for OpenAI Chat-compatible request: file-9]");
    }

    #[cfg(node_twin)]
    use super::*;
    #[cfg(node_twin)]
    use crate::providers::listing_row::testing::fixture;
    #[cfg(node_twin)]
    use mixdog_core_api::domain::provider::ToolCall;

    #[cfg(node_twin)]
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

    #[cfg(node_twin)]
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
    #[cfg(node_twin)]
    #[test]
    fn multipart_content_lowers_as_nodes_to_openai_messages() {
        let golden = fixture("oracles/chat-parts-messages.json");
        let profile = CompatProfile::deepseek();
        let owner = ProviderId::from("deepseek");
        let mut checked = 0;
        for case in golden["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let messages: Vec<Message> = case["messages"].as_array().unwrap().iter().map(message).collect();
            let got = lower_messages(&profile.chat, &owner, &messages, false).unwrap();
            let mut node = case["node"].clone();
            if name == "empty-text-part" {
                // Node lowers an empty text part to its own JSON as text; a part with no text is dropped here.
                let junk = json!({"type": "text", "text": "{\"type\":\"text\",\"text\":\"\"}"});
                let parts = node[0]["content"].as_array_mut().unwrap();
                assert_eq!(parts.remove(0), junk);
            }
            if name == "tool-with-media" {
                // Node dropped a tool result's file-id image, which this wire cannot carry; the core never drops an image
                // silently: its placeholder stays in the result's text (`a_file_id_image_in_a_tool_result_leaves_its_placeholder_in_the_text`).
                let text = node[1]["content"].as_str().unwrap();
                assert_eq!(text, "alpha\nbeta\n--- notes.txt (text/plain, 10 bytes) ---\nhello file\n[file not sent inline: blob.bin (application/octet-stream, 4 bytes) — this type has no inline form; open it from disk with read]", "Node recorded something else");
                node[1]["content"] = json!(text.replacen("beta\n", "beta\n[unsupported image file_id for OpenAI Chat-compatible request: file-123]\n", 1));
            }
            assert_eq!(JsonValue::Array(got), node, "{name}");
            checked += 1;
        }
        assert_eq!(checked, 11);
    }
}


