//! Lowers a Mixdog transcript, system prompt and tool list into one Devin
//! `GetChatMessageRequest` (Cascade request type).
//!
//! Wire roles: USER for user/developer turns, SYSTEM (the Cascade "bot"
//! channel) for assistant turns, TOOL for tool results. Leading system
//! messages become the request `prompt`.

use std::collections::HashMap;
use std::collections::HashSet;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::DocumentSource;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
use mixdog_protocol::ProviderId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use super::models::DEFAULT_MAX_OUTPUT_TOKENS;
use super::models::ModelRow;
use super::schema::ChatMessagePrompt;
use super::schema::ChatRequest;
use super::schema::ChatToolCall;
use super::schema::Configuration;
use super::schema::ImageData;
use super::schema::Metadata;
use super::schema::PLANNER_MODE_DEFAULT;
use super::schema::REQUEST_TYPE_CASCADE;
use super::schema::ToolChoice;
use super::schema::ToolDefinition;
use super::schema::source;
use crate::netproxy::decode_uri_component;
use crate::providers::compat::schema::{Problem, Rule, exclusion, lower_openapi_nullable, report_exclusion, wire_input_schema};

/// Replayed tool-call ids reach the backend serving the model; OpenAI-routed
/// models refuse ids over 40 characters or outside `[A-Za-z0-9_-]`.
pub const TOOL_CALL_ID_MAX_LENGTH: usize = 40;
/// Result text for a tool call whose result never committed.
pub const MISSING_TOOL_RESULT: &str = "No result provided";

// Completion knobs the native CLI sends with every Cascade turn.
const CLI_TOP_K: u64 = 40;
const CLI_TOP_P: f32 = 0.95;
const CLI_MAX_NEWLINES: u64 = 400;

/// Everything a request needs besides the transcript.
pub struct ChatParams<'a> {
    pub provider: &'a ProviderId,
    /// The catalog model id (replay identity).
    pub model: &'a str,
    /// The concrete wire uid (effort route or router assignment).
    pub chat_model_uid: &'a str,
    pub assignment_jwt: Option<&'a str>,
    pub row: Option<&'a ModelRow>,
    pub metadata: Metadata,
    pub cascade_id: &'a str,
    pub execution_id: &'a str,
}

/// The leading 128 bits of sha256(`seed`) in the 8-4-4-4-12 UUID layout.
pub fn deterministic_uuid(seed: &str) -> String {
    let digest = Sha256::digest(seed.as_bytes());
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// A foreign tool-call id on the Devin wire: unsupported characters to `_`,
/// capped.
pub fn normalize_tool_call_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(TOOL_CALL_ID_MAX_LENGTH)
        .collect()
}

fn duplicate_id(id: &str, index: usize) -> String {
    let suffix = format!("_dup{index}");
    if id.chars().count() + suffix.len() <= TOOL_CALL_ID_MAX_LENGTH {
        return format!("{id}{suffix}");
    }
    let keep = TOOL_CALL_ID_MAX_LENGTH.saturating_sub(suffix.len());
    format!("{}{suffix}", id.chars().take(keep).collect::<String>())
}

/// A link to a remote image has no bytes here to send, and the wire has no field for a link, so it is refused, not turned
/// into text. (An inline image reaches this encoder as a base64 part: the egress guard, `registry::egress`, makes
/// the part of a `data:` URL or a stored reference one.)
fn link_refused() -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    error.message = "This model cannot be given an image by its link; attach the image itself and send again.".to_owned();
    error
}

/// An image reached this encoder that its wire cannot carry. The egress guard (`registry::egress`) refuses such a request by
/// name before any encoder runs, so this ends a request that skipped it, unsent.
fn unprepared_image() -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    error.message = "Nothing was sent. An image in this request is not one this model can be given.".to_owned();
    error
}

/// [`lowered_content`] for a lowering that carries no image (a system prompt, an assistant turn); the egress guard has refused any
/// request whose route cannot take its images, so none arrives here.
fn plain_text(content: &Content) -> String {
    match lowered_content(content, false) {
        Ok((text, _)) => text,
        Err(_) => unreachable!("the egress guard refuses an image this wire cannot carry before the encoder runs"),
    }
}

/// Text plus inline images of one content value. Images go only to a vision
/// model, each as the image part the wire has (a base64 image; a link is
/// refused); every other media part becomes its fixed text form. An image the
/// model cannot be given is an error, never text.
fn lowered_content(content: &Content, vision: bool) -> Result<(String, Vec<ImageData>), ProviderError> {
    let parts = match content {
        Content::Text(text) => return Ok((text.clone(), Vec::new())),
        Content::Parts(parts) => parts,
    };
    let mut text = String::new();
    let mut images = Vec::new();
    let omitted = |label: &str| format!("[{label} omitted: local model is text-only]");
    for part in parts {
        match part {
            ContentPart::Text(t, _) => text.push_str(t),
            ContentPart::Image(ImageSource::Base64 { data, mime_type, .. }) if vision => {
                images.push(ImageData {
                    base64_data: data.clone(),
                    mime_type: mime_type.clone(),
                });
            }
            ContentPart::Image(ImageSource::Url(_) | ImageSource::FileId(_)) if vision => return Err(link_refused()),
            // Never turned into text, a link or a marker: an image this wire cannot carry (a model without vision, an image
            // that was not prepared) is not sent.
            ContentPart::Image(_) => return Err(unprepared_image()),
            ContentPart::Document {
                source: DocumentSource::Text { data, .. },
                ..
            } => text.push_str(data),
            ContentPart::Document { .. } | ContentPart::File { .. } => match crate::providers::file_text::file_part_text(part) {
                Some(file) => text.push_str(&file),
                None => text.push_str(&omitted("document")),
            },
        }
    }
    Ok((text, images))
}

/// The Devin replay item of an assistant turn (any model), if it has one.
fn replay_item<'a>(message: &'a Message, provider: &'a ProviderId) -> Option<&'a Value> {
    message
        .replay_for(provider)
        .filter_map(|r| r.items.as_array())
        .flatten()
        .find(|item| item.get("type").and_then(Value::as_str) == Some(super::decoder::REPLAY_ITEM_TYPE))
}

fn same_model_replay<'a>(message: &'a Message, provider: &'a ProviderId, model: &str) -> Option<&'a Value> {
    replay_item(message, provider).filter(|item| item.get("model").and_then(Value::as_str) == Some(model))
}

/// Tool-call ids as the wire carries them: a same-model turn keeps its ids
/// verbatim, any other turn's are normalized; a repeated id then gets a
/// `_dupN` suffix and the next unanswered result of that id follows it.
pub fn wire_tool_call_ids(messages: Vec<Message>, provider: &ProviderId, model: &str) -> Vec<Message> {
    let mut normalized: HashMap<String, String> = HashMap::new();
    let projected: Vec<Message> = messages
        .into_iter()
        .map(|mut message| {
            match message.role {
                Role::Tool => {
                    if let Some(id) = &message.tool_call_id
                        && let Some(wire) = normalized.get(id)
                    {
                        message.tool_call_id = Some(wire.clone());
                    }
                }
                Role::Assistant
                    if !message.tool_calls.is_empty() && same_model_replay(&message, provider, model).is_none() =>
                {
                    for call in &mut message.tool_calls {
                        let wire = normalize_tool_call_id(&call.id);
                        if wire != call.id {
                            normalized.insert(call.id.clone(), wire.clone());
                            call.id = wire;
                        }
                    }
                }
                _ => {}
            }
            message
        })
        .collect();

    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut pending: HashMap<String, Vec<Option<String>>> = HashMap::new();
    projected
        .into_iter()
        .map(|mut message| {
            match message.role {
                Role::Tool => {
                    let id = message.tool_call_id.clone().unwrap_or_default();
                    if let Some(queue) = pending.get_mut(&id)
                        && !queue.is_empty()
                    {
                        let replacement = queue.remove(0);
                        if queue.is_empty() {
                            pending.remove(&id);
                        }
                        if let Some(replacement) = replacement {
                            message.tool_call_id = Some(replacement);
                        }
                    }
                }
                Role::Assistant if !message.tool_calls.is_empty() => {
                    let mut touched: HashSet<String> = HashSet::new();
                    for call in &mut message.tool_calls {
                        let id = call.id.clone();
                        // A later turn re-emitting an id takes over its pending results.
                        if touched.insert(id.clone()) {
                            pending.remove(&id);
                        }
                        let previous = seen.get(&id).copied().unwrap_or(0);
                        let queue = pending.entry(id.clone()).or_default();
                        if previous == 0 {
                            seen.insert(id, 1);
                            queue.push(None);
                            continue;
                        }
                        let mut index = previous;
                        let mut replacement = duplicate_id(&id, index);
                        while seen.contains_key(&replacement) {
                            index += 1;
                            replacement = duplicate_id(&id, index);
                        }
                        seen.insert(id, index + 1);
                        seen.insert(replacement.clone(), 1);
                        queue.push(Some(replacement.clone()));
                        call.id = replacement;
                    }
                }
                _ => {}
            }
            message
        })
        .collect()
}

fn result_texts(content: &Content) -> Vec<String> {
    match content {
        Content::Text(t) => (!t.trim().is_empty()).then(|| t.clone()).into_iter().collect(),
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|p| match p {
                ContentPart::Text(t, _) if !t.trim().is_empty() => Some(t.clone()),
                _ => None,
            })
            .collect(),
    }
}

fn synthetic_result(call: &mixdog_core_api::domain::provider::ToolCall) -> Message {
    let mut message = Message::new(Role::Tool, Content::Text(MISSING_TOOL_RESULT.to_owned()));
    message.tool_call_id = Some(call.id.clone());
    message.is_error = true;
    message
}

/// Tool-call pairing on the wire transcript: every assistant tool call is
/// answered right after its turn by exactly one result. A result that arrives
/// later is pulled forward into that slot; a call with no result gets an
/// error result; a duplicate result is dropped. A result whose call is gone
/// (folded away by compaction) survives as a user note of its text, unless a
/// call window is still open, in which case it is dropped.
pub fn paired_transcript(messages: Vec<Message>) -> Vec<Message> {
    let mut results: HashMap<String, Vec<(usize, bool)>> = HashMap::new();
    let mut live_calls: HashSet<String> = HashSet::new();
    for (index, message) in messages.iter().enumerate() {
        match message.role {
            Role::Tool => results
                .entry(message.tool_call_id.clone().unwrap_or_default())
                .or_default()
                .push((index, false)),
            Role::Assistant => live_calls.extend(message.tool_calls.iter().map(|c| c.id.clone())),
            _ => {}
        }
    }
    let take = |results: &mut HashMap<String, Vec<(usize, bool)>>, id: &str, after: usize| -> Option<usize> {
        let entry = results
            .get_mut(id)?
            .iter_mut()
            .find(|(index, consumed)| !*consumed && *index > after)?;
        entry.1 = true;
        Some(entry.0)
    };

    let mut out: Vec<Message> = Vec::new();
    let mut resolved: HashSet<String> = HashSet::new();
    let mut pending: Vec<mixdog_core_api::domain::provider::ToolCall> = Vec::new();
    let mut pending_start = 0usize;
    let flush = |out: &mut Vec<Message>,
                     pending: &mut Vec<mixdog_core_api::domain::provider::ToolCall>,
                     resolved: &mut HashSet<String>,
                     results: &mut HashMap<String, Vec<(usize, bool)>>,
                     start: usize| {
        for call in pending.drain(..) {
            if resolved.contains(&call.id) {
                continue;
            }
            match take(results, &call.id, start) {
                Some(index) => out.push(messages[index].clone()),
                None => out.push(synthetic_result(&call)),
            }
            resolved.insert(call.id);
        }
    };

    for (index, message) in messages.iter().enumerate() {
        match message.role {
            Role::Assistant => {
                flush(&mut out, &mut pending, &mut resolved, &mut results, pending_start);
                out.push(message.clone());
                if !message.tool_calls.is_empty() {
                    pending = message.tool_calls.clone();
                    pending_start = index;
                }
            }
            Role::Tool => {
                let id = message.tool_call_id.clone().unwrap_or_default();
                if resolved.contains(&id) {
                    continue;
                }
                if pending.iter().any(|c| c.id == id) {
                    // Answered in place by the first result at or after the call.
                    resolved.insert(id.clone());
                    if let Some(entry) = results
                        .get_mut(&id)
                        .and_then(|v| v.iter_mut().find(|(i, consumed)| !*consumed && *i == index))
                    {
                        entry.1 = true;
                    }
                    pending.retain(|c| c.id != id);
                    out.push(message.clone());
                    continue;
                }
                if live_calls.contains(&id) {
                    continue;
                }
                if pending.iter().any(|c| !resolved.contains(&c.id)) {
                    continue;
                }
                let texts = result_texts(&message.content);
                if texts.is_empty() {
                    continue;
                }
                let error_attr = if message.is_error { " is-error=\"true\"" } else { "" };
                out.push(Message::new(
                    Role::User,
                    Content::Text(format!(
                        "<stale-tool-result tool=\"\" id=\"{id}\"{error_attr}>\n{}\n</stale-tool-result>",
                        texts.join("\n")
                    )),
                ));
            }
            _ => {
                flush(&mut out, &mut pending, &mut resolved, &mut results, pending_start);
                out.push(message.clone());
            }
        }
    }
    flush(&mut out, &mut pending, &mut resolved, &mut results, pending_start);
    out
}

fn assistant_prompt(
    message: &Message,
    params: &ChatParams<'_>,
    message_id: String,
) -> Option<ChatMessagePrompt> {
    let native = same_model_replay(message, params.provider, params.model);
    let text = plain_text(&message.content);
    let tool_calls: Vec<ChatToolCall> = message
        .tool_calls
        .iter()
        .map(|call| ChatToolCall {
            id: call.id.clone(),
            name: call.name.clone(),
            arguments_json: match &call.arguments {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            },
            ..ChatToolCall::default()
        })
        .collect();
    let field = |name: &str| {
        native
            .and_then(|item| item.get(name))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let thinking = field("thinking");
    let signature = field("signature");
    let signature_type = if signature.is_empty() {
        String::new()
    } else {
        field("signatureType")
    };
    if text.is_empty() && thinking.is_empty() && signature.is_empty() && tool_calls.is_empty() {
        return None;
    }
    let native_id = field("messageId");
    Some(ChatMessagePrompt {
        // Native assistant ids are the response's own message id.
        message_id: if native_id.is_empty() { message_id } else { native_id },
        source: source::SYSTEM,
        prompt: text,
        tool_calls,
        thinking,
        signature,
        signature_type,
        ..ChatMessagePrompt::default()
    })
}

fn chat_prompts(messages: &[Message], params: &ChatParams<'_>, vision: bool) -> Result<Vec<ChatMessagePrompt>, ProviderError> {
    let mut prompts = Vec::new();
    for (index, message) in messages.iter().enumerate() {
        let cascade = params.cascade_id;
        match message.role {
            Role::Assistant => {
                let id = deterministic_uuid(&format!("{cascade}\0{index}\0assistant"));
                if let Some(prompt) = assistant_prompt(message, params, id) {
                    prompts.push(prompt);
                }
            }
            Role::Tool => {
                let (text, images) = lowered_content(&message.content, vision)?;
                let call_id = message.tool_call_id.clone().unwrap_or_default();
                prompts.push(ChatMessagePrompt {
                    message_id: deterministic_uuid(&format!("{cascade}\0{index}\0tool\0{call_id}")),
                    source: source::TOOL,
                    tool_call_id: call_id,
                    tool_result_is_error: message.is_error,
                    prompt: text,
                    images,
                    ..ChatMessagePrompt::default()
                });
            }
            role => {
                let name = match role {
                    Role::System => "system",
                    Role::Developer => "developer",
                    _ => "user",
                };
                let (text, images) = lowered_content(&message.content, vision)?;
                prompts.push(ChatMessagePrompt {
                    message_id: deterministic_uuid(&format!("{cascade}\0{index}\0{name}")),
                    source: source::USER,
                    prompt: text,
                    images,
                    ..ChatMessagePrompt::default()
                });
            }
        }
    }
    Ok(prompts)
}

/// The prompt a model router scores: the latest user/developer turn alone,
/// with no message id (the chat request that follows mints it).
pub fn router_prompt(messages: &[Message], vision: bool) -> Result<Option<ChatMessagePrompt>, ProviderError> {
    let Some(message) = messages.iter().rev().find(|m| matches!(m.role, Role::User | Role::Developer)) else { return Ok(None) };
    let (text, images) = lowered_content(&message.content, vision)?;
    Ok(Some(ChatMessagePrompt {
        source: source::USER,
        prompt: text,
        images,
        ..ChatMessagePrompt::default()
    }))
}

fn gemini_model(id: &str) -> bool {
    let id = id.trim().rsplit('/').next().unwrap_or_default().to_ascii_lowercase();
    id.starts_with("gemini-") || id.starts_with("model_google_gemini_")
}

/// Cascade carries JSON text even on a Gemini assignment, but its Gemini
/// backend reads the restricted schema vocabulary rather than full JSON Schema.
fn gemini_parameters(schema: &Value) -> Result<Value, String> {
    fn lower(node: &Value, root: &Value, budget: &mut usize, depth: usize) -> Result<Value, String> {
        if depth > 64 || *budget == 0 {
            return Err("schema exceeds the Gemini projection limit".into());
        }
        *budget -= 1;
        let map = match node {
            Value::Bool(true) => return Ok(json!({})),
            Value::Bool(false) => return Ok(json!({"not": {}})),
            Value::Object(map) => map,
            _ => return Err("expected a schema object or boolean".into()),
        };
        let mut out = Map::new();
        let mut constraints = Map::new();
        let mut conjuncts = Vec::new();
        for (key, value) in map {
            let lowered = match key.as_str() {
                "$ref" => {
                    let target = value.as_str().and_then(|reference| reference.strip_prefix('#'))
                        .and_then(decode_uri_component)
                        .and_then(|pointer| root.pointer(&pointer))
                        .ok_or_else(|| "Gemini requires an inline schema or a local JSON-pointer reference".to_owned())?;
                    conjuncts.push(lower(target, root, budget, depth + 1)?);
                    continue;
                }
                "$id" if depth > 0 => return Err("Gemini cannot inline a nested schema resource".into()),
                "$dynamicRef" | "$recursiveRef" => return Err("Gemini cannot inline a dynamic reference".into()),
                "properties" => Value::Object(
                    value.as_object().into_iter().flatten()
                        .map(|(name, child)| Ok((name.clone(), lower(child, root, budget, depth + 1)?)))
                        .collect::<Result<_, String>>()?,
                ),
                "anyOf" | "oneOf" | "allOf" => {
                    if key == "anyOf"
                        && !map.contains_key("type")
                        && !map.contains_key("enum")
                        && !map.contains_key("const")
                        && let Some(branches) = value.as_array().filter(|branches| branches.len() == 2)
                        && let Some(null_at) = branches.iter().position(|branch| branch == &json!({"type": "null"}))
                    {
                        let other = lower(&branches[1 - null_at], root, budget, depth + 1)?;
                        if let Some(fields) = other.as_object().filter(|fields| {
                            fields.get("type").is_some_and(Value::is_string)
                                && ["enum", "not", "allOf", "anyOf", "oneOf"].iter().all(|key| !fields.contains_key(*key))
                                && fields.keys().all(|name| !map.contains_key(name))
                        }) {
                            out.extend(fields.clone());
                            out.insert("nullable".into(), Value::Bool(true));
                            continue;
                        }
                    }
                    let branches = value.as_array().into_iter().flatten()
                        .map(|child| lower(child, root, budget, depth + 1))
                        .collect::<Result<Vec<_>, _>>()?;
                    if key == "allOf" {
                        conjuncts.extend(branches);
                        continue;
                    }
                    Value::Array(branches)
                }
                "items" | "not" => lower(value, root, budget, depth + 1)?,
                "type" if value.is_array() || value.as_str() == Some("null") => {
                    let types: Vec<_> = value.as_array().map_or_else(|| vec![value], |types| types.iter().collect());
                    let nullable = types.iter().any(|kind| kind.as_str() == Some("null"));
                    let mut non_null = types.into_iter().filter(|kind| kind.as_str() != Some("null"));
                    if let Some(first) = non_null.next() {
                        let rest: Vec<_> = non_null.collect();
                        if rest.is_empty() {
                            out.insert("type".into(), first.clone());
                            if nullable {
                                out.insert("nullable".into(), Value::Bool(true));
                            }
                        } else {
                            let branches: Vec<_> = std::iter::once(first).chain(rest).map(|kind| {
                                if nullable { json!({"type": kind, "nullable": true}) } else { json!({"type": kind}) }
                            }).collect();
                            conjuncts.push(json!({"anyOf": branches}));
                        }
                    } else {
                        // A nullable typed schema minus that same non-null type
                        // accepts only null, without an untyped wildcard branch.
                        conjuncts.push(json!({"type": "string", "nullable": true, "not": {"type": "string"}}));
                    }
                    continue;
                }
                "enum" if value.as_array().is_some_and(|values| values.iter().all(Value::is_string)) => value.clone(),
                "const" if value.is_string() && !map.contains_key("enum") => {
                    out.insert("enum".into(), json!([value]));
                    continue;
                }
                "type" | "description" | "required" | "nullable" | "propertyOrdering" | "title" | "default" => value.clone(),
                "additionalProperties" if value == &Value::Bool(true) => continue,
                "$schema" | "$id" | "$defs" | "definitions" | "$comment" | "examples" | "deprecated" | "readOnly" | "writeOnly" => continue,
                _ => {
                    // Keep constraints the backend cannot enforce visible to the model.
                    constraints.insert(key.clone(), value.clone());
                    continue;
                }
            };
            out.insert(key.clone(), lowered);
        }
        if !constraints.is_empty() {
            let original = out.get("description").and_then(Value::as_str).unwrap_or_default();
            let separator = if original.is_empty() { "" } else { "\n" };
            let description = format!("{original}{separator}Schema hints (not enforced by this declaration): {}", Value::Object(constraints));
            out.insert("description".into(), Value::String(description));
        }
        if let Some(properties) = out.get("properties").and_then(Value::as_object).filter(|p| !p.is_empty())
            && !out.contains_key("propertyOrdering")
        {
            let order = json!(properties.keys().collect::<Vec<_>>());
            out.insert("propertyOrdering".into(), order);
        }
        if out.is_empty() && conjuncts.len() == 1 {
            return Ok(conjuncts.remove(0));
        }
        if !conjuncts.is_empty() {
            out.insert("allOf".into(), Value::Array(conjuncts));
        }
        Ok(Value::Object(out))
    }

    lower(schema, schema, &mut 1024, 0)
}

fn tool_definitions(request: &ModelRequest, params: &ChatParams<'_>) -> Vec<ToolDefinition> {
    let google = gemini_model(params.model) || gemini_model(params.chat_model_uid);
    request
        .tools
        .iter()
        .enumerate()
        .filter_map(|(index, tool)| {
            let source = "[devin] tool";
            let schema = if tool.input_schema.is_null() {
                json!({})
            } else {
                match wire_input_schema(&tool.input_schema, Rule::OpenAi) {
                    Ok(schema) => schema,
                    Err(problem) => {
                        report_exclusion(&request.options, exclusion(&tool.name, index, problem, source));
                        return None;
                    }
                }
            };
            let schema = if google {
                match gemini_parameters(&schema) {
                    Ok(schema) => schema,
                    Err(reason) => {
                        let problem = Problem { pointer: String::new(), reason };
                        report_exclusion(&request.options, exclusion(&tool.name, index, problem, source));
                        return None;
                    }
                }
            } else {
                let mut schema = schema;
                lower_openapi_nullable(&mut schema);
                schema
            };
            Some(ToolDefinition {
                name: tool.name.clone(),
                description: tool.description.clone(),
                json_schema_string: schema.to_string(),
                strict: false,
            })
        })
        .collect()
}

/// The `GetChatMessageRequest` for one turn.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
pub fn build_chat_request(request: &ModelRequest, params: &ChatParams<'_>) -> Result<ChatRequest, ProviderError> {
    let all = &request.messages;
    let start = all.iter().take_while(|m| m.role == Role::System).count();
    let prompt = all[..start]
        .iter()
        .map(|m| plain_text(&m.content))
        .filter(|t| !t.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let history = paired_transcript(wire_tool_call_ids(
        all[start..].to_vec(),
        params.provider,
        params.model,
    ));
    let vision = params.row.is_some_and(|r| r.supports_vision);
    let max_tokens = request
        .options
        .max_output_tokens_override
        .or(request.options.model_max_output_tokens)
        .map(u64::from)
        .filter(|n| *n > 0)
        .or(params.row.map(|r| r.max_output_tokens).filter(|n| *n > 0))
        .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS);
    Ok(ChatRequest {
        metadata: params.metadata.clone(),
        prompt,
        chat_message_prompts: chat_prompts(&history, params, vision)?,
        request_type: REQUEST_TYPE_CASCADE,
        configuration: Configuration {
            num_completions: 1,
            max_tokens,
            max_newlines: CLI_MAX_NEWLINES,
            temperature: 1.0,
            top_k: CLI_TOP_K,
            // The CLI sends topP as a float32 widened to double.
            top_p: f64::from(CLI_TOP_P),
            stop_patterns: Vec::new(),
        },
        tools: tool_definitions(request, params),
        disable_parallel_tool_calls: !params.row.is_some_and(|r| r.supports_parallel_tool_calls),
        tool_choice: Some(ToolChoice::Option("auto".to_owned())),
        system_prompt_cache_ephemeral: true,
        cascade_id: params.cascade_id.to_owned(),
        planner_mode: PLANNER_MODE_DEFAULT,
        chat_model_uid: params.chat_model_uid.to_owned(),
        execution_id: params.execution_id.to_owned(),
        model_assignment_jwt: params.assignment_jwt.map(str::to_owned),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gemini_assignment_gets_its_schema_in_the_encoded_tool_field() {
        use super::super::schema::fields;
        use mixdog_core_api::domain::provider::ToolDefinition as ModelTool;

        let schema = json!({
            "type": "object",
            "properties": {
                "limit": {"type": ["number", "null"], "description": "Maximum items"},
                "alias": {"type": "string", "nullable": true},
                "choice": {"anyOf": [{"type": "string", "enum": ["fast"]}, {"type": "null"}]},
                "mode": {"type": "string", "enum": ["fast", "slow"]},
                "replace_all": {"type": "boolean", "default": false},
                "minutes": {"type": "integer", "enum": [30, 60, 120, 240]}
            },
            "required": ["limit"],
            "additionalProperties": false
        });
        let request = ModelRequest {
            model: "adaptive".into(),
            messages: Vec::new(),
            tools: vec![ModelTool {
                name: "lookup".into(),
                description: "Read a record".into(),
                input_schema: schema.clone(),
                defer_loading: false,
                freeform: None,
            }],
            options: Default::default(),
        };
        for (uid, expected) in [
            ("MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW", json!({
                "type": "object",
                "properties": {
                    "limit": {"type": "number", "nullable": true, "description": "Maximum items"},
                    "alias": {"type": "string", "nullable": true},
                    "choice": {"anyOf": [{"type": "string", "enum": ["fast"]}, {"type": "string", "nullable": true, "not": {"type": "string"}}]},
                    "mode": {"type": "string", "enum": ["fast", "slow"]},
                    "replace_all": {"type": "boolean", "default": false},
                    "minutes": {"type": "integer", "description": "Schema hints (not enforced by this declaration): {\"enum\":[30,60,120,240]}"}
                },
                "required": ["limit"],
                "description": "Schema hints (not enforced by this declaration): {\"additionalProperties\":false}",
                "propertyOrdering": ["limit", "alias", "choice", "mode", "replace_all", "minutes"]
            })),
            ("MODEL_OPENAI_GPT_5", {
                let mut expected = schema;
                expected["properties"]["alias"] = json!({"type": ["string", "null"]});
                expected
            }),
        ] {
            let params = ChatParams {
                provider: &ProviderId::from("devin-oauth"),
                model: &request.model,
                chat_model_uid: uid,
                assignment_jwt: None,
                row: None,
                metadata: Metadata::default(),
                cascade_id: "cascade",
                execution_id: "execution",
            };
            let body = build_chat_request(&request, &params).unwrap().encode();
            let tool = fields(&body).unwrap().into_iter().find(|(tag, _, _)| *tag == 10).unwrap().1;
            let values = fields(&tool).unwrap();
            let field = |tag| values.iter().find(|(n, _, _)| *n == tag).unwrap().1.as_slice();
            assert_eq!(field(1), b"lookup");
            assert_eq!(field(2), b"Read a record");
            assert_eq!(serde_json::from_slice::<Value>(field(3)).unwrap(), expected);
        }
    }

    #[test]
    fn gemini_expands_a_fragment_before_interpreting_pointer_escapes() {
        let schema = json!({
            "type": "object",
            "$defs": {"a b/c~d": {"type": "string", "enum": ["ok"]}},
            "properties": {"value": {"$ref": "#%2F$defs%2Fa%20b%7E1c%7E0d"}}
        });
        let schema = wire_input_schema(&schema, Rule::OpenAi).unwrap();
        assert_eq!(gemini_parameters(&schema).unwrap(), json!({
            "type": "object",
            "properties": {"value": {"type": "string", "enum": ["ok"]}},
            "propertyOrdering": ["value"]
        }));
    }

    fn parts(parts: Vec<ContentPart>) -> Content {
        Content::Parts(parts)
    }

    #[test]
    fn a_prepared_image_goes_to_a_vision_model_as_the_image_part_the_wire_has() {
        let image = ImageSource::Base64 { data: "iVBORw0=".into(), mime_type: "image/png".into(), width: None, height: None };
        let (text, images) = lowered_content(&parts(vec![ContentPart::Text("a".into(), None), ContentPart::Image(image)]), true).unwrap();
        assert_eq!(text, "a");
        assert_eq!(images, vec![ImageData { base64_data: "iVBORw0=".into(), mime_type: "image/png".into() }]);
    }

    #[test]
    fn a_link_or_file_id_is_refused_for_a_vision_model_never_turned_into_text() {
        for source in [ImageSource::Url("https://example.com/a.png".into()), ImageSource::FileId("file-1".into())] {
            let error = lowered_content(&parts(vec![ContentPart::Image(source)]), true).unwrap_err();
            assert_eq!(error.message, "This model cannot be given an image by its link; attach the image itself and send again.");
            assert_eq!(error.delivery, DeliveryState::NotSent);
        }
    }

    #[test]
    fn an_image_a_model_cannot_be_given_ends_the_encoding_unsent_and_is_never_text() {
        for source in [ImageSource::FileId("f".into()), ImageSource::Url("https://example.com/a.png".into())] {
            let error = lowered_content(&parts(vec![ContentPart::Image(source)]), false).unwrap_err();
            assert_eq!(error.delivery, DeliveryState::NotSent);
            assert!(error.message.starts_with("Nothing was sent."), "{}", error.message);
        }
    }
}
