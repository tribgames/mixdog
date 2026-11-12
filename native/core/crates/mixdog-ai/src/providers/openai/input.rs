//! Transcript lowering: internal messages to Responses `input` items.
//! A retained message has the same wire form in every later request, so the
//! lowering reads only the message itself (and the tool-call/result ids of
//! the same transcript), never request-level state.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;

use mixdog_core_api::domain::provider::BinarySource;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DocumentSource;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::Phase;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_protocol::ProviderId;
use mixdog_protocol::tool_call_ids;
use mixdog_protocol::tool_call_ids::OPENAI_RESPONSES_IDS;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::effort::EffortProjection;

/// Synthetic output for a call whose result never committed (cancel/abort).
const CANCELLED_OUTPUT: &str = "Cancelled";

/// What a replayed `tool_search` item becomes on a wire without the native
/// search tool.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ToolSearchReplay {
    /// A client call becomes the `load_tool` function call; outputs and
    /// server-executed pairs are dropped.
    Downgrade,
    /// Replayed exactly as the owner's response produced it.
    Verbatim,
}

/// How a transcript lowers to `input` items.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct LowerOptions {
    /// Whose replay envelopes this wire reads back; any other owner's are
    /// ignored.
    pub replay_owner: ProviderId,
    /// Explicit `type: "message"` and the metadata passthrough.
    pub codex_parity: bool,
    /// Native `tool_search` / custom items; off lowers every call to a
    /// plain function call.
    pub native_tool_search: bool,
    /// Calls recorded as `custom_tool_call` replay as that item type and are
    /// answered with `custom_tool_call_output`.
    pub custom_tools: bool,
    pub replay_reasoning: bool,
    pub tool_search_replay: ToolSearchReplay,
    /// Assistant `phase` tags travel on the wire.
    pub phase: bool,
    /// System messages stay in `input` as `role: "system"` items.
    pub system_in_input: bool,
}

/// Names the client-side search tool is declared under.
pub fn is_tool_search_name(name: &str) -> bool {
    name == "load_tool" || name == "tool_search"
}

pub fn content_text(content: &Content) -> String {
    match content {
        Content::Text(text) => text.clone(),
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|part| match part {
                ContentPart::Text(text, _) => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

// ---------------------------------------------------------------------------
// Tool-call ids at the wire
// ---------------------------------------------------------------------------

/// Stand-ins for the ids the Responses wire refuses; a valid id passes
/// unchanged and a call and its result always map to the same value.
fn wire_id_map(messages: &[Message]) -> HashMap<String, String> {
    let ids = messages.iter().flat_map(|message| -> Vec<&str> {
        match message.role {
            Role::Assistant => message.tool_calls.iter().map(|call| call.id.as_str()).collect(),
            Role::Tool => message.tool_call_id.as_deref().into_iter().collect(),
            _ => Vec::new(),
        }
    });
    tool_call_ids::wire_id_map(ids, OPENAI_RESPONSES_IDS)
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

fn text_part(assistant: bool, text: impl Into<String>) -> Value {
    json!({"type": if assistant { "output_text" } else { "input_text" }, "text": text.into()})
}

fn data_url(mime: &str, data: &str) -> String {
    format!("data:{mime};base64,{data}")
}

fn pdf_file_part(filename: Option<&str>, data: &str) -> Value {
    json!({
        "type": "input_file",
        "filename": filename.filter(|n| !n.is_empty()).unwrap_or("document.pdf"),
        "file_data": data_url("application/pdf", data),
    })
}

fn is_pdf(mime: &str) -> bool {
    mime.trim().eq_ignore_ascii_case("application/pdf")
}

fn normalize_part(part: &ContentPart, assistant: bool) -> Option<Value> {
    match part {
        ContentPart::Text(text, _) => (!text.is_empty()).then(|| text_part(assistant, text.as_str())),
        ContentPart::Image(ImageSource::Base64 { data, mime_type, .. }) => {
            Some(json!({"type": "input_image", "image_url": data_url(mime_type, data)}))
        }
        ContentPart::Image(ImageSource::Url(url)) => {
            Some(json!({"type": "input_image", "image_url": url}))
        }
        ContentPart::Image(ImageSource::FileId(id)) => {
            Some(json!({"type": "input_image", "file_id": id}))
        }
        ContentPart::File {
            source,
            mime_type,
            filename,
            ..
        } => Some(match source {
            BinarySource::Base64(data) if is_pdf(mime_type) => {
                pdf_file_part(filename.as_deref(), data)
            }
            BinarySource::Base64(_) => text_part(
                assistant,
                format!(
                    "[file: {} ({mime_type})]",
                    filename.as_deref().unwrap_or("unnamed")
                ),
            ),
            BinarySource::AttachmentRef(reference) => {
                text_part(assistant, format!("[attachment: {reference}]"))
            }
        }),
        ContentPart::Document { source, title } => Some(match source {
            DocumentSource::Base64 { media_type, data } if is_pdf(media_type) => {
                pdf_file_part(title.as_deref(), data)
            }
            DocumentSource::Base64 { media_type, .. } => text_part(
                assistant,
                format!(
                    "[document: {} ({media_type})]",
                    title.as_deref().unwrap_or("untitled")
                ),
            ),
            DocumentSource::Text { data, .. } => text_part(assistant, data.as_str()),
            DocumentSource::Content(value) => text_part(assistant, value.to_string()),
        }),
    }
}

pub(super) fn normalize_content(content: &Content, assistant: bool) -> Vec<Value> {
    match content {
        Content::Text(text) if text.is_empty() => Vec::new(),
        Content::Text(text) => vec![text_part(assistant, text.as_str())],
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|part| normalize_part(part, assistant))
            .collect(),
    }
}

/// A tool result is either plain text or, when it carries media, the ordered
/// `input_*` items the Responses wire accepts inside `output`.
fn tool_output(content: &Content) -> Value {
    let items = normalize_content(content, false);
    let has_media = items.iter().any(|item| {
        matches!(
            item.get("type").and_then(Value::as_str),
            Some("input_image" | "input_file")
        )
    });
    if has_media {
        Value::Array(items)
    } else {
        Value::String(content_text(content))
    }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

fn phase_str(phase: Phase) -> &'static str {
    match phase {
        Phase::Commentary => "commentary",
        Phase::FinalAnswer => "final_answer",
    }
}

fn wire_message(parity: bool, role: &str, content: Vec<Value>, phase: Option<Phase>) -> Value {
    let mut item = Map::new();
    if parity {
        item.insert("type".into(), json!("message"));
    }
    item.insert("role".into(), json!(role));
    item.insert("content".into(), Value::Array(content));
    if role == "assistant"
        && let Some(phase) = phase
    {
        item.insert("phase".into(), json!(phase_str(phase)));
    }
    if parity {
        item.insert(
            "internal_chat_message_metadata_passthrough".into(),
            json!({}),
        );
    }
    Value::Object(item)
}

fn item_type(item: &Value) -> &str {
    item.get("type").and_then(Value::as_str).unwrap_or("")
}

fn function_call_item(call: &ToolCall, call_id: &str) -> Value {
    let name = if call.name == "tool_search" {
        "load_tool"
    } else {
        call.name.as_str()
    };
    json!({
        "type": "function_call",
        "call_id": call_id,
        "name": name,
        "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".into()),
    })
}

/// The freeform input of a custom tool call recorded as structured arguments.
fn custom_tool_input(name: &str, arguments: &Value) -> String {
    if let Value::String(text) = arguments {
        return text.clone();
    }
    if name == "apply_patch"
        && let Some(patch) = arguments.get("patch").and_then(Value::as_str)
    {
        return patch.to_owned();
    }
    if let Some(input) = arguments.get("input").and_then(Value::as_str) {
        return input.to_owned();
    }
    if arguments.is_null() {
        return "{}".to_owned();
    }
    arguments.to_string()
}

fn tool_search_call_item(call_id: &str, arguments: &Value) -> Value {
    let arguments = if arguments.is_object() {
        arguments.clone()
    } else {
        json!({})
    };
    json!({
        "type": "tool_search_call",
        "call_id": call_id,
        "execution": "client",
        "arguments": arguments,
    })
}

/// A replayed `tool_search` item for a model that has no such tool: a client
/// call becomes the `load_tool` function call, anything else is dropped.
fn without_native_tool_search(item: Value) -> Option<Value> {
    match item_type(&item) {
        "tool_search_output" => None,
        "tool_search_call" => {
            if item.get("execution").and_then(Value::as_str) == Some("server") {
                return None;
            }
            let call_id = item.get("call_id").and_then(Value::as_str).filter(|c| !c.is_empty())?;
            let arguments = match item.get("arguments") {
                Some(Value::String(text)) => text.clone(),
                Some(other) => other.to_string(),
                None => "{}".to_owned(),
            };
            Some(json!({
                "type": "function_call",
                "call_id": call_id,
                "name": "load_tool",
                "arguments": arguments,
            }))
        }
        _ => Some(item),
    }
}

/// The `tool_search_output` a tool message carries from a native search of
/// the OpenAI family, or `None`.
fn native_search_output(message: &Message, call_id: &str) -> Option<Value> {
    let native = message.native_tool_search.as_ref()?;
    let source = native
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if !source.is_empty() && source != "openai" && source != "openai-oauth" {
        return None;
    }
    let tools = native.get("openaiTools")?.as_array()?;
    let tools: Vec<Value> = tools
        .iter()
        .map(|tool| {
            let mut tool = tool.clone();
            if tool.get("type").and_then(Value::as_str) == Some("function")
                && let Some(map) = tool.as_object_mut()
            {
                map.insert("strict".into(), json!(false));
            }
            tool
        })
        .collect();
    Some(json!({
        "type": "tool_search_output",
        "call_id": call_id,
        "status": "completed",
        "execution": "client",
        "tools": tools,
    }))
}

fn empty_search_output(call_id: &str) -> Value {
    json!({
        "type": "tool_search_output",
        "call_id": call_id,
        "status": "completed",
        "execution": "client",
        "tools": [],
    })
}

struct Lowering<'a> {
    opts: &'a LowerOptions,
    out: Vec<Value>,
    pending_media: Vec<Value>,
    pending_loads: Vec<Value>,
    /// Calls lowered as native search: call id to its arguments.
    search_calls: HashMap<String, Value>,
    /// Calls lowered as custom tool calls.
    custom_calls: HashSet<String>,
}

impl Lowering<'_> {
    fn flush_media(&mut self) {
        self.out.append(&mut self.pending_loads);
        if self.pending_media.is_empty() {
            return;
        }
        let media = std::mem::take(&mut self.pending_media);
        self.out
            .push(wire_message(self.opts.codex_parity, "user", media, None));
    }

    fn push_tool_result(&mut self, message: &Message, call_id: &str) {
        let output = tool_output(&message.content);
        if self.custom_calls.contains(call_id) {
            self.out.push(json!({
                "type": "custom_tool_call_output",
                "call_id": call_id,
                "output": output,
            }));
            return;
        }
        if let Some(arguments) = self.search_calls.get(call_id) {
            let item = native_search_output(message, call_id)
                .unwrap_or_else(|| empty_search_output(call_id));
            let no_tools = item
                .get("tools")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty);
            let named = arguments
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| !name.is_empty());
            self.out.push(item);
            // The search output has no text field; keep skill status and
            // failed loader results visible as a user message.
            if named || no_tools {
                self.pending_media.push(json!({
                    "type": "input_text",
                    "text": content_text(&message.content),
                }));
            }
            return;
        }
        let loaded: Vec<String> = if self.opts.native_tool_search {
            message
                .native_tool_search
                .as_ref()
                .and_then(|n| n.get("openaiTools"))
                .and_then(Value::as_array)
                .map(|tools| {
                    tools
                        .iter()
                        .filter_map(|t| t.get("name").and_then(Value::as_str))
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let load_output = if loaded.is_empty() {
            None
        } else {
            native_search_output(message, call_id)
        };
        let output = if !loaded.is_empty() && load_output.is_none() {
            Value::String(format!(
                "{}\nThis ordinary function result cannot register native tools. Use tool_search with names:{} to load their definitions.",
                content_text(&message.content),
                serde_json::to_string(&loaded).unwrap_or_default()
            ))
        } else {
            output
        };
        self.out.push(json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
        }));
        if let Some(mut load_output) = load_output {
            let load_call_id = format!("{call_id}_load");
            self.pending_loads
                .push(tool_search_call_item(&load_call_id, &json!({"names": loaded})));
            if let Some(map) = load_output.as_object_mut() {
                map.insert("call_id".into(), json!(load_call_id));
            }
            self.pending_loads.push(load_output);
        }
    }

    fn push_assistant_calls(&mut self, calls: &[ToolCall], wire: &dyn Fn(&str) -> String) {
        for call in calls {
            let call_id = wire(&call.id);
            let native_type = call.native_type.as_deref();
            if self.opts.native_tool_search && native_type == Some("tool_search_call") {
                let item = tool_search_call_item(&call_id, &call.arguments);
                self.search_calls
                    .insert(call_id, item.get("arguments").cloned().unwrap_or_default());
                self.out.push(item);
            } else if self.opts.custom_tools && native_type == Some("custom_tool_call") {
                self.out.push(json!({
                    "type": "custom_tool_call",
                    "call_id": call_id,
                    "name": call.name,
                    "input": custom_tool_input(&call.name, &call.arguments),
                }));
                if !call_id.is_empty() {
                    self.custom_calls.insert(call_id);
                }
            } else {
                self.out.push(function_call_item(call, &call_id));
            }
        }
    }

    /// A migrated or provider-owned ordered replay: the response's own items,
    /// in order. Returns whether it took over the message.
    fn push_ordered_replay(&mut self, items: &[Value]) -> bool {
        let kept: Vec<&Value> = items
            .iter()
            .filter(|item| self.opts.replay_reasoning || item_type(item) != "reasoning")
            .collect();
        if kept.is_empty() {
            return false;
        }
        for item in kept {
            let item = if self.opts.native_tool_search
                || self.opts.tool_search_replay == ToolSearchReplay::Verbatim
            {
                Some(item.clone())
            } else {
                without_native_tool_search(item.clone())
            };
            let Some(item) = item else { continue };
            if item_type(&item) == "custom_tool_call"
                && let Some(call_id) = item.get("call_id").and_then(Value::as_str).filter(|c| !c.is_empty())
            {
                self.custom_calls.insert(call_id.to_owned());
            }
            if item_type(&item) == "tool_search_call"
                && let Some(call_id) = item.get("call_id").and_then(Value::as_str)
            {
                self.search_calls.insert(
                    call_id.to_owned(),
                    item.get("arguments").cloned().unwrap_or_default(),
                );
            }
            self.out.push(item);
        }
        true
    }
}

fn replay_items(message: &Message, owner: &ProviderId) -> Vec<Value> {
    let mut items = Vec::new();
    for replay in message.replay_for(owner) {
        match &replay.items {
            Value::Array(list) => items.extend(list.iter().cloned()),
            Value::Null => {}
            other => items.push(other.clone()),
        }
    }
    items
}

/// Synthesizes the output of every client call that has none, right after the
/// call. Orphan outputs stay: a continuation carries only new results.
fn ensure_call_outputs(items: Vec<Value>) -> Vec<Value> {
    let is_server_search = |item: &Value| {
        matches!(item_type(item), "tool_search_call" | "tool_search_output")
            && (item.get("execution").and_then(Value::as_str) == Some("server")
                || item.get("call_id").is_some_and(Value::is_null))
    };
    let call_id = |item: &Value| -> Option<String> {
        if !matches!(
            item_type(item),
            "function_call" | "custom_tool_call" | "tool_search_call"
        ) || is_server_search(item)
        {
            return None;
        }
        item.get("call_id")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .or_else(|| item.get("id").and_then(Value::as_str).filter(|c| !c.is_empty()))
            .map(str::to_owned)
    };
    let mut answered: HashSet<String> = items
        .iter()
        .filter(|item| {
            matches!(
                item_type(item),
                "function_call_output" | "custom_tool_call_output" | "tool_search_output"
            ) && !is_server_search(item)
        })
        .filter_map(|item| {
            item.get("call_id")
                .and_then(Value::as_str)
                .filter(|c| !c.is_empty())
                .or_else(|| item.get("id").and_then(Value::as_str).filter(|c| !c.is_empty()))
                .map(str::to_owned)
        })
        .collect();
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let id = call_id(&item);
        let kind = item_type(&item).to_owned();
        out.push(item);
        if let Some(id) = id
            && answered.insert(id.clone())
        {
            out.push(match kind.as_str() {
                "custom_tool_call" => json!({
                    "type": "custom_tool_call_output",
                    "call_id": id,
                    "output": CANCELLED_OUTPUT,
                }),
                "tool_search_call" => empty_search_output(&id),
                _ => json!({
                    "type": "function_call_output",
                    "call_id": id,
                    "output": CANCELLED_OUTPUT,
                }),
            });
        }
    }
    out
}

/// Messages to Responses input items. System messages are lowered only when
/// `opts.system_in_input`; otherwise the caller carries them as instructions.
pub fn lower(messages: &[Message], opts: &LowerOptions) -> Vec<Value> {
    lower_from(messages, opts, &LowerExtras::default())
}

/// What a resumed or effort-configured conversation adds to the lowering.
#[derive(Clone, Default, Debug)]
pub struct LowerExtras {
    /// Messages before this index are already known to the server.
    pub start_index: usize,
    /// Encrypted reasoning from earlier turns, emitted before the message at
    /// its index (`messages.len()` = after the last one).
    pub reasoning_by_index: BTreeMap<usize, Vec<Value>>,
    pub effort: Option<EffortProjection>,
}

fn configuration_update(effort: &str) -> Value {
    json!({"type": "configuration_update", "reasoning": {"effort": effort}})
}

/// [`lower`] for a conversation that resumes at `extras.start_index`, with
/// carried reasoning and mid-conversation effort updates.
pub fn lower_from(messages: &[Message], opts: &LowerOptions, extras: &LowerExtras) -> Vec<Value> {
    let ids = wire_id_map(messages);
    let wire = |id: &str| ids.get(id).cloned().unwrap_or_else(|| id.to_owned());
    let mut lowering = Lowering {
        opts,
        out: Vec::new(),
        pending_media: Vec::new(),
        pending_loads: Vec::new(),
        search_calls: HashMap::new(),
        custom_calls: HashSet::new(),
    };
    // An update on a tool result applies after its whole batch; one on any
    // other message goes before it, and a message's own wins over a pending
    // batch update.
    let mut after_batch: Option<&str> = None;
    let update_at = |index: usize| extras.effort.as_ref().and_then(|e| e.updates.get(&index)).map(String::as_str);
    for (index, message) in messages.iter().enumerate().skip(extras.start_index) {
        match message.role {
            Role::System => {
                if opts.system_in_input {
                    lowering.flush_media();
                    lowering.out.push(wire_message(
                        opts.codex_parity,
                        "system",
                        normalize_content(&message.content, false),
                        None,
                    ));
                }
                continue;
            }
            Role::Tool => {
                if let Some(effort) = update_at(index) {
                    after_batch = Some(effort);
                }
                let call_id = wire(message.tool_call_id.as_deref().unwrap_or(""));
                lowering.push_tool_result(message, &call_id);
                continue;
            }
            _ => {}
        }
        lowering.flush_media();
        if let Some(effort) = update_at(index).or(after_batch.take()) {
            lowering.out.push(configuration_update(effort));
        }
        let assistant = message.role == Role::Assistant;
        let replays = if assistant {
            replay_items(message, &opts.replay_owner)
        } else {
            Vec::new()
        };
        // The one decision point (Node `orderedReplay?.length`): an owned
        // replay with anything left to send replaces the message and the
        // carried history alike; history reasoning is only for a message
        // with no owned replay.
        if assistant && lowering.push_ordered_replay(&replays) {
            continue;
        }
        if let Some(carried) = extras.reasoning_by_index.get(&index) {
            lowering.out.extend(carried.iter().cloned());
        }
        let content = normalize_content(&message.content, assistant);
        if assistant && !message.tool_calls.is_empty() {
            let has_content = match &message.content {
                Content::Text(text) => !text.is_empty(),
                Content::Parts(parts) => !parts.is_empty(),
            };
            if has_content {
                lowering.out.push(wire_message(
                    opts.codex_parity,
                    "assistant",
                    content,
                    message.phase.filter(|_| opts.phase),
                ));
            }
            lowering.push_assistant_calls(&message.tool_calls, &wire);
            continue;
        }
        let role = if assistant { "assistant" } else { "user" };
        lowering
            .out
            .push(wire_message(
                opts.codex_parity,
                role,
                content,
                message.phase.filter(|_| opts.phase),
            ));
    }
    lowering.flush_media();
    if let Some(carried) = extras.reasoning_by_index.get(&messages.len()) {
        lowering.out.extend(carried.iter().cloned());
    }
    if let Some(effort) = after_batch {
        lowering.out.push(configuration_update(effort));
    }
    ensure_call_outputs(lowering.out)
}
