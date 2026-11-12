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
use mixdog_core_api::domain::provider::DocumentSource;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::Role;
use mixdog_protocol::ProviderId;
use serde_json::Value;
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

/// Text plus inline images of one content value. Images go only to a vision
/// model; every other media part becomes its fixed text form.
fn lowered_content(content: &Content, vision: bool) -> (String, Vec<ImageData>) {
    let parts = match content {
        Content::Text(text) => return (text.clone(), Vec::new()),
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
            ContentPart::Image(ImageSource::Url(url)) => text.push_str(&format!("[image: {url}]")),
            ContentPart::Image(_) => text.push_str(&omitted("image")),
            ContentPart::Document {
                source: DocumentSource::Text { data, .. },
                ..
            } => text.push_str(data),
            ContentPart::Document { .. } => text.push_str(&omitted("document")),
            ContentPart::File { .. } => text.push_str(&omitted("file")),
        }
    }
    (text, images)
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
    let (text, _) = lowered_content(&message.content, false);
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

fn chat_prompts(messages: &[Message], params: &ChatParams<'_>, vision: bool) -> Vec<ChatMessagePrompt> {
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
                let (text, images) = lowered_content(&message.content, vision);
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
                let (text, images) = lowered_content(&message.content, vision);
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
    prompts
}

/// The prompt a model router scores: the latest user/developer turn alone,
/// with no message id (the chat request that follows mints it).
pub fn router_prompt(messages: &[Message], vision: bool) -> Option<ChatMessagePrompt> {
    let message = messages
        .iter()
        .rev()
        .find(|m| matches!(m.role, Role::User | Role::Developer))?;
    let (text, images) = lowered_content(&message.content, vision);
    Some(ChatMessagePrompt {
        source: source::USER,
        prompt: text,
        images,
        ..ChatMessagePrompt::default()
    })
}

fn tool_definitions(request: &ModelRequest) -> Vec<ToolDefinition> {
    request
        .tools
        .iter()
        .map(|tool| ToolDefinition {
            name: tool.name.clone(),
            description: tool.description.clone(),
            json_schema_string: tool.input_schema.to_string(),
            strict: false,
        })
        .collect()
}

/// The `GetChatMessageRequest` for one turn.
pub fn build_chat_request(request: &ModelRequest, params: &ChatParams<'_>) -> ChatRequest {
    let all = &request.messages;
    let start = all.iter().take_while(|m| m.role == Role::System).count();
    let prompt = all[..start]
        .iter()
        .map(|m| lowered_content(&m.content, false).0)
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
    ChatRequest {
        metadata: params.metadata.clone(),
        prompt,
        chat_message_prompts: chat_prompts(&history, params, vision),
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
        tools: tool_definitions(request),
        disable_parallel_tool_calls: !params.row.is_some_and(|r| r.supports_parallel_tool_calls),
        tool_choice: Some(ToolChoice::Option("auto".to_owned())),
        system_prompt_cache_ephemeral: true,
        cascade_id: params.cascade_id.to_owned(),
        planner_mode: PLANNER_MODE_DEFAULT,
        chat_model_uid: params.chat_model_uid.to_owned(),
        execution_id: params.execution_id.to_owned(),
        model_assignment_jwt: params.assignment_jwt.map(str::to_owned),
    }
}
