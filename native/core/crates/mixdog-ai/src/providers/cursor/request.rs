//! Lowers a Mixdog transcript into one Cursor agent run request: the history
//! becomes content-addressed blobs (served back when the server asks for
//! them), the trailing user turn becomes the run's action, and the tool list
//! becomes the request context.

use std::collections::HashMap;
use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolDefinition;
use serde_json::Map;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;

use crate::providers::compat::schema::Rule;
use crate::providers::compat::schema::SchemaMemo;
use crate::providers::compat::schema::report_exclusion;
use crate::providers::flat_schema::merge_flat_schema_property;
use crate::providers::js_value::entries;
use crate::providers::js_value::js_ordered_map;
use crate::providers::js_value::truthy;

use super::schema::Action;
use super::schema::McpToolDefinition;
use super::schema::RequestContext;
use super::schema::RunRequest;
use super::schema::UserImage;
use super::schema::conversation_state;

pub const MAX_CONNECT_FRAME_BYTES: usize = 64 * 1024 * 1024;
const MAX_USER_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_CONVERSATION_BLOB_BYTES: usize = 128 * 1024 * 1024;
const MAX_CONVERSATION_BLOB_ENTRIES: usize = 512;
const MAX_INDIVIDUAL_BLOB_BYTES: usize = 32 * 1024 * 1024;

const MCP_INSTRUCTIONS: &str = "Do not use Cursor native tools; use only the tools provided by the mixdog MCP server, following their descriptions and declared input schemas. If a needed tool is not available, use the provided tool discovery mechanism rather than inventing a tool.";

fn too_large(what: &str, limit: usize) -> ProviderError {
    let mut error = ProviderError::new(ErrorKind::RequestTooLarge, DeliveryState::NotSent);
    error.code = Some("cursor_payload_too_large".to_owned());
    error.message = format!("Cursor {what} exceeds {limit} bytes");
    error
}

/// A version-4-shaped UUID derived from `seed`.
pub fn deterministic_uuid(seed: &str) -> String {
    let hex: String = Sha256::digest(seed.as_bytes()).iter().take(16).map(|b| format!("{b:02x}")).collect();
    let variant = (u8::from_str_radix(&hex[16..17], 16).expect("hex") & 3) | 8;
    format!("{}-{}-4{}-{variant:x}{}-{}", &hex[0..8], &hex[8..12], &hex[13..16], &hex[17..20], &hex[20..32])
}

/// The conversation a scope owns: stable across attempts and turns.
pub fn conversation_id(scope: &str) -> String {
    let key: String = Sha256::digest(format!("cursor-session:{scope}").as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>()[..20].to_owned();
    deterministic_uuid(&format!("cursor-conversation:{key}"))
}

pub use crate::providers::connect::random_uuid;

/// The blobs of one run, keyed by the lowercase hex of their sha256. Bounded
/// by entry count and bytes; the oldest entry is evicted first.
#[derive(Debug, Default, Clone)]
pub struct BlobStore {
    order: Vec<String>,
    blobs: HashMap<String, Vec<u8>>,
    bytes: usize,
    /// The entries the run's own request names, which the bounds do not evict.
    kept: std::collections::HashSet<String>,
}

impl BlobStore {
    pub fn get(&self, id: &[u8]) -> Option<&[u8]> {
        self.blobs.get(&hex(id)).map(Vec::as_slice)
    }

    pub fn len(&self) -> usize {
        self.blobs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.blobs.is_empty()
    }

    pub fn put(&mut self, id: &[u8], data: Vec<u8>) -> Result<(), ProviderError> {
        if data.len() > MAX_INDIVIDUAL_BLOB_BYTES {
            return Err(too_large("blob", MAX_INDIVIDUAL_BLOB_BYTES));
        }
        let key = hex(id);
        if let Some(old) = self.blobs.remove(&key) {
            self.bytes -= old.len();
            self.order.retain(|k| *k != key);
        }
        self.bytes += data.len();
        self.blobs.insert(key.clone(), data);
        self.order.push(key.clone());
        while self.order.len() > MAX_CONVERSATION_BLOB_ENTRIES || self.bytes > MAX_CONVERSATION_BLOB_BYTES {
            // What the run's own request names stays; of what the service stored, the oldest goes first.
            let Some(at) = self.order.iter().position(|k| *k != key && !self.kept.contains(k)) else { break };
            let oldest = self.order.remove(at);
            if let Some(old) = self.blobs.remove(&oldest) {
                self.bytes -= old.len();
            }
        }
        Ok(())
    }


    /// Stores `data` under its own digest and returns the id. It is part of what the run's request names: it is
    /// answered for as long as the run lives, and the bounds hold what the service stores besides.
    pub fn put_content(&mut self, data: Vec<u8>) -> Result<Vec<u8>, ProviderError> {
        let id = Sha256::digest(&data).to_vec();
        self.kept.insert(hex(&id));
        self.put(&id, data)?;
        Ok(id)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn json_str(text: &str) -> String {
    serde_json::to_string(text).expect("a string serializes")
}

// History entries (written with the key order the transcript blobs carry)

pub(super) fn text_of(content: &Content) -> String {
    match content {
        Content::Text(t) => t.to_string(),
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|p| match p {
                ContentPart::Text(t, _) if !t.is_empty() => Some(t.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

/// A base64 image as `(data URL, mime type)`; other sources have no bytes
/// to send.
fn data_url_image(part: &ContentPart) -> Option<(String, String, &str)> {
    match part {
        ContentPart::Image(ImageSource::Base64 { data, mime_type, .. }) => Some((format!("data:{mime_type};base64,{data}"), mime_type.clone(), data.as_str())),
        _ => None,
    }
}

fn root_content(content: &Content) -> Vec<String> {
    match content {
        Content::Text(t) if t.is_empty() => Vec::new(),
        Content::Text(t) => vec![format!("{{\"type\":\"text\",\"text\":{}}}", json_str(t))],
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|p| match p {
                ContentPart::Text(t, _) if !t.is_empty() => Some(format!("{{\"type\":\"text\",\"text\":{}}}", json_str(t))),
                other => {
                    data_url_image(other).map(|(url, mime, _)| format!("{{\"type\":\"image\",\"image\":{},\"mediaType\":{}}}", json_str(&url), json_str(&mime)))
                }
            })
            .collect(),
    }
}

fn user_images(content: &Content) -> Result<Vec<UserImage>, ProviderError> {
    let Content::Parts(parts) = content else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for part in parts {
        let Some((_, mime, data)) = data_url_image(part) else {
            continue;
        };
        let bytes = STANDARD.decode(data).unwrap_or_default();
        if bytes.len() > MAX_USER_IMAGE_BYTES {
            return Err(too_large("image", MAX_USER_IMAGE_BYTES));
        }
        out.push(UserImage { uuid: random_uuid(), mime_type: mime, data: bytes });
    }
    Ok(out)
}

fn tool_result_entry(message: &Message, tool_names: &HashMap<String, String>) -> String {
    let id = message.tool_call_id.clone().unwrap_or_default();
    let text = text_of(&message.content);
    let media: Vec<String> = match &message.content {
        Content::Parts(parts) => parts.iter().filter_map(|p| data_url_image(p).map(|(_, mime, _)| format!("[{mime} image]"))).collect(),
        Content::Text(_) => Vec::new(),
    };
    let result = std::iter::once(text).chain(media).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
    let name = tool_names.get(&id).cloned().unwrap_or_default();
    let error = if message.is_error { ",\"isError\":true" } else { "" };
    format!(
        "{{\"role\":\"tool\",\"id\":{id_json},\"content\":[{{\"type\":\"tool-result\",\"toolName\":{},\"toolCallId\":{id_json},\"result\":{}{error}}}]}}",
        json_str(&name),
        json_str(&result),
        id_json = json_str(&id),
    )
}

/// What the transcript lowers to.
#[derive(Clone)]
pub struct ParsedMessages {
    pub systems: Vec<String>,
    /// History entries as the JSON text of their blobs.
    pub history: Vec<String>,
    pub user_text: String,
    pub user_images: Vec<UserImage>,
}

pub fn parse_messages(messages: &[Message]) -> Result<ParsedMessages, ProviderError> {
    let mut systems = Vec::new();
    let mut history: Vec<String> = Vec::new();
    let mut tool_names: HashMap<String, String> = HashMap::new();
    // The last entry, kept structured while it may become the active turn.
    let mut last_user: Option<(usize, String, Vec<UserImage>)> = None;
    // A file is the text it lowers to on every wire (`toCursorMessages` over `toOpenAIMessages`).
    let messages = crate::providers::own_call_ids::own_call_ids(messages);
    for message in crate::providers::file_text::files_as_text(&messages).iter() {
        match message.role {
            Role::System | Role::Developer => {
                let text = text_of(&message.content);
                if !text.is_empty() {
                    systems.push(text);
                }
            }
            Role::Tool => {
                history.push(tool_result_entry(message, &tool_names));
                last_user = None;
            }
            Role::Assistant => {
                let mut content = root_content(&message.content);
                for call in &message.tool_calls {
                    tool_names.insert(call.id.clone(), call.name.clone());
                    content.push(format!(
                        "{{\"type\":\"tool-call\",\"toolCallId\":{},\"toolName\":{},\"args\":{}}}",
                        json_str(&call.id),
                        json_str(&call.name),
                        call.arguments
                    ));
                }
                if !content.is_empty() {
                    history.push(format!("{{\"role\":\"assistant\",\"content\":[{}]}}", content.join(",")));
                }
                last_user = None;
            }
            Role::User => {
                let text = text_of(&message.content);
                history.push(format!("{{\"role\":\"user\",\"content\":[{}],\"text\":{}}}", root_content(&message.content).join(","), json_str(&text)));
                last_user = Some((history.len() - 1, text, user_images(&message.content)?));
            }
        }
    }
    // A trailing user turn is the active request, not history.
    let (user_text, user_images) = match last_user {
        Some((index, text, images)) if index + 1 == history.len() => {
            history.pop();
            (text, images)
        }
        _ => (String::new(), Vec::new()),
    };
    Ok(ParsedMessages { systems, history, user_text, user_images })
}

// Tool definitions

const SCHEMA_ANNOTATIONS: [&str; 9] = ["$comment", "$id", "$schema", "default", "deprecated", "examples", "readOnly", "title", "writeOnly"];

fn slim_schema(value: &Value, depth: usize) -> Value {
    if depth > 12 {
        return value.clone();
    }
    let Some(map) = value.as_object() else {
        return value.clone();
    };
    let mut out = Map::new();
    for (key, child) in map {
        if SCHEMA_ANNOTATIONS.contains(&key.as_str())
            || (key == "additionalProperties" && child == &Value::Bool(true))
            || (key == "required" && child.as_array().is_some_and(Vec::is_empty))
        {
            continue;
        }
        let value = match (key.as_str(), child) {
            ("properties" | "patternProperties" | "$defs" | "definitions" | "dependentSchemas", Value::Object(entries)) => {
                Value::Object(entries.iter().map(|(name, schema)| (name.clone(), slim_schema(schema, depth + 2))).collect())
            }
            ("prefixItems" | "anyOf" | "oneOf" | "allOf", Value::Array(items)) => {
                Value::Array(items.iter().map(|schema| slim_schema(schema, depth + 2)).collect())
            }
            (
                "items" | "additionalProperties" | "propertyNames" | "contains" | "not" | "if" | "then" | "else" | "unevaluatedItems" | "unevaluatedProperties",
                _,
            ) => slim_schema(child, depth + 1),
            _ => child.clone(),
        };
        out.insert(key.clone(), value);
    }
    Value::Object(out)
}

/// A top-level `oneOf`/`anyOf`/`allOf` has no flat form on the wire: its
/// branches' properties merge into one object schema.
fn flatten_top_level_compound(schema: Value) -> Value {
    let Value::Object(mut root) = schema else {
        return schema;
    };
    let mut branches = Vec::new();
    for key in ["oneOf", "anyOf", "allOf"] {
        if let Some(Value::Array(items)) = root.shift_remove(key) {
            branches.extend(items);
        }
    }
    if branches.is_empty() {
        return Value::Object(root);
    }
    let mut properties = match root.shift_remove("properties") {
        Some(Value::Object(p)) => p,
        _ => Map::new(),
    };
    for branch in branches {
        for (name, property) in entries(branch.get("properties").filter(|p| truthy(p)).unwrap_or(&Value::Null)) {
            // `mergeFlatSchemaProperty`: enums union, nested properties merge, only properties
            // required by both sides stay required.
            let merged = merge_flat_schema_property(properties.get(&name), &property);
            properties.insert(name, merged);
        }
    }
    root.insert("type".to_owned(), Value::String("object".to_owned()));
    root.insert("properties".to_owned(), Value::Object(js_ordered_map(properties)));
    Value::Object(root)
}

pub fn prepare_tool(tool: &ToolDefinition) -> McpToolDefinition {
    let schema = if tool.input_schema.is_object() {
        flatten_top_level_compound(slim_schema(&tool.input_schema, 0))
    } else {
        serde_json::json!({"type": "object", "properties": {}})
    };
    McpToolDefinition { name: tool.name.clone(), description: tool.description.clone(), input_schema: schema, provider_identifier: "mixdog".to_owned() }
}

/// The tools a request offers: none for `tool_choice: none`. Every `parameters` must first be a
/// valid 2020-12 object schema, as on any OpenAI-rule route (`cursor.mjs`: `acceptedWireTools(..,
/// 'openai', onToolExcluded, '[cursor] tool')`): a draft-07 one is lowered, a broken one left out and
/// reported. The check runs whatever the tool choice, as in Node.
pub fn selected_tools(request: &ModelRequest) -> Vec<McpToolDefinition> {
    static SCHEMAS: LazyLock<SchemaMemo> = LazyLock::new(SchemaMemo::default);
    let accepted = SCHEMAS.accepted_wire_tools(&request.tools, Rule::OpenAi, "[cursor] tool", &mut |excluded| report_exclusion(&request.options, excluded));
    // `selectToolsForChoice`: `none` offers nothing; a named tool (Node's object form
    // `{ name }` / `{ type: 'function', function: { name } }`, which `RequestOptions.tool_choice`
    // carries as the bare name) narrows the offer to the tools of that name, none when there is no
    // such tool; the keyword choices leave it whole.
    let named = match request.options.tool_choice.as_deref() {
        Some("none") => return Vec::new(),
        Some("" | "auto" | "required" | "any") | None => None,
        Some(name) => Some(name),
    };
    accepted.iter().filter(|t| named.is_none_or(|name| t.name == name)).filter(|t| !t.name.is_empty()).map(prepare_tool).collect()
}

/// The offered tools as text of the run's rule, one JSON object a line in the order offered. The service gives the model
/// one call that takes a server, a tool name and arguments, and none of the definitions sent beside it: the rule is
/// where the model reads each tool's name and the schema of its arguments.
fn tool_manifest(tools: &[McpToolDefinition]) -> String {
    let mut lines = vec![
        "<mixdog-tools>".to_owned(),
        "The tools of the mixdog MCP server, one per line as {name, description, inputSchema}. Call a tool by its exact name, with arguments that match its inputSchema.".to_owned(),
    ];
    lines.extend(
        tools.iter().map(|tool| serde_json::json!({"name": tool.name, "description": tool.description, "inputSchema": tool.input_schema}).to_string()),
    );
    lines.push("</mixdog-tools>".to_owned());
    lines.join("\n")
}

pub fn request_context(tools: &[McpToolDefinition], cloud_rule: Option<&str>) -> RequestContext {
    let rule = match (cloud_rule, tools.is_empty()) {
        (rule, true) => rule.map(str::to_owned),
        (Some(rule), false) => Some(format!("{rule}\n\n{}", tool_manifest(tools))),
        (None, false) => Some(tool_manifest(tools)),
    };
    RequestContext {
        tools: tools.to_vec(),
        mcp_instructions: if tools.is_empty() { Vec::new() } else { vec![("mixdog".to_owned(), MCP_INSTRUCTIONS.to_owned())] },
        cloud_rule: rule,
    }
}

/// The model the run asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelSelection {
    pub model_id: String,
    pub parameters: Vec<(String, String)>,
    pub max_mode: bool,
    /// The catalog model a pinned suffix id (`<base>-high`) bills as.
    pub pricing_model: Option<String>,
}

pub struct RunBuild {
    /// The framed bytes are `frame::encode(&message, 0)`.
    pub message: Vec<u8>,
    pub blobs: BlobStore,
    pub tools: Vec<McpToolDefinition>,
    pub cloud_rule: Option<String>,
}

/// What a request asks a run for, read from it once per attempt: the lowered transcript, the tools offered (their
/// exclusions reported) and the rules.
#[derive(Clone)]
pub struct Prepared {
    pub parsed: ParsedMessages,
    pub tools: Vec<McpToolDefinition>,
    pub cloud_rule: Option<String>,
    /// The transcript's turns as the service records turns, for a request that goes on with the open one.
    turns: Vec<TurnRecord>,
}

/// One turn as the service records it: the user's message, then a step per assistant text and per tool call, the
/// call carrying its result.
#[derive(Clone)]
struct TurnRecord {
    /// What the user said.
    said: String,
    steps: Vec<Vec<u8>>,
}

/// The step of `call` made as a call of the `mixdog` MCP server, with `result` when the transcript holds it.
fn tool_step(call: &mixdog_core_api::domain::provider::ToolCall, result: Option<&Message>) -> Vec<u8> {
    use crate::providers::connect::pb::Writer;
    let mut args = Writer::new();
    args.string(1, &format!("mixdog-{}", call.name));
    // Arguments that are no object (a tool that takes one free text) are the one argument `input`.
    let whole = [("input".to_owned(), call.arguments.clone())];
    let named: Vec<(&String, &serde_json::Value)> = match call.arguments.as_object() {
        Some(object) => object.iter().collect(),
        None if call.arguments.is_null() => Vec::new(),
        None => whole.iter().map(|(key, value)| (key, value)).collect(),
    };
    for (key, value) in named {
        let mut entry = Writer::new();
        entry.string(1, key);
        entry.bytes(2, &super::schema::encode_json_value(value));
        args.message(2, entry);
    }
    args.string(3, &call.id);
    args.string(4, "mixdog");
    args.string(5, &call.name);
    args.string(9, "mixdog");
    let mut mcp = Writer::new();
    mcp.message(1, args);
    if let Some(result) = result {
        mcp.message(2, super::answer::mcp_result(result));
    }
    let mut tool = Writer::new();
    tool.message(15, mcp);
    tool.string(57, &call.id);
    let mut step = Writer::new();
    step.message(2, tool);
    step.finish()
}

fn turn_records(messages: &[Message]) -> Vec<TurnRecord> {
    use crate::providers::connect::pb::Writer;
    let messages = crate::providers::own_call_ids::own_call_ids(messages);
    let messages = crate::providers::file_text::files_as_text(&messages);
    let mut turns: Vec<TurnRecord> = Vec::new();
    for message in messages.iter() {
        match message.role {
            Role::User => turns.push(TurnRecord { said: text_of(&message.content), steps: Vec::new() }),
            Role::Assistant => {
                // What the assistant did before anything the user said (a transcript compacted down to its tail)
                // has no turn to stand in: it is the steps of a turn that says nothing, so its calls and their
                // results are still named.
                if turns.is_empty() {
                    turns.push(TurnRecord { said: String::new(), steps: Vec::new() });
                }
                let turn = turns.last_mut().expect("just ensured");
                let text = text_of(&message.content);
                if !text.is_empty() {
                    let mut said = Writer::new();
                    said.string(1, &text);
                    let mut step = Writer::new();
                    step.message(1, said);
                    turn.steps.push(step.finish());
                }
                for call in &message.tool_calls {
                    let result = messages.iter().find(|m| m.role == Role::Tool && m.tool_call_id.as_deref() == Some(call.id.as_str()));
                    turn.steps.push(tool_step(call, result));
                }
            }
            _ => {}
        }
    }
    turns
}

pub fn prepare(request: &ModelRequest) -> Result<Prepared, ProviderError> {
    let parsed = parse_messages(&request.messages)?;
    if parsed.user_text.is_empty() && parsed.user_images.is_empty() && parsed.history.is_empty() {
        let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
        error.message = "No user message found".to_owned();
        return Err(error);
    }
    let tools = selected_tools(request);
    let cloud_rule = (!parsed.systems.is_empty()).then(|| parsed.systems.join("\n\n"));
    let turns = turn_records(&request.messages);
    Ok(Prepared { parsed, tools, cloud_rule, turns })
}

/// Builds the run request of one attempt.
pub fn build_run(request: &ModelRequest, selection: &ModelSelection, conversation_id: &str, message_id: &str) -> Result<RunBuild, ProviderError> {
    build_prepared(prepare(request)?, selection, conversation_id, message_id)
}

/// The run request that asks for `prepared`.
pub fn build_prepared(prepared: Prepared, selection: &ModelSelection, conversation_id: &str, message_id: &str) -> Result<RunBuild, ProviderError> {
    let Prepared { parsed, tools, cloud_rule, turns } = prepared;
    let context = request_context(&tools, cloud_rule.as_deref());
    let mut blobs = BlobStore::default();
    let mut ids = Vec::new();
    for entry in &parsed.history {
        ids.push(blobs.put_content(entry.clone().into_bytes())?);
    }
    // A transcript that ends in tool results has no user message to ask with, and the service takes none that is
    // empty without recording it as a turn. It goes on with the open turn instead: the state names the transcript's
    // turns, the open one last with its steps and their results, and the action resumes it.
    let resumes = parsed.user_text.is_empty() && parsed.user_images.is_empty();
    let conversation_state = if resumes {
        let mut state = crate::providers::connect::pb::Writer::new();
        for id in &ids {
            state.bytes(1, id);
        }
        // A turn's message id is of this conversation, of what was said and of the first thing done about it (and of
        // the nth time both were the same), so it is the same id on every request that still holds the turn: another
        // turn that says the same does not take it over when the turns before are compacted away.
        let mut times: HashMap<Vec<u8>, usize> = HashMap::new();
        for turn in &turns {
            let mut keyed = Sha256::new();
            keyed.update((turn.said.len() as u64).to_be_bytes());
            keyed.update(turn.said.as_bytes());
            keyed.update(turn.steps.first().map_or(&[][..], Vec::as_slice));
            let digest = keyed.finalize().to_vec();
            let nth = times.entry(digest.clone()).or_default();
            *nth += 1;
            let mut user = crate::providers::connect::pb::Writer::new();
            user.string(1, &turn.said);
            user.string(2, &deterministic_uuid(&format!("cursor-turn:{conversation_id}:{}:{nth}", hex(&digest))));
            let mut agent = crate::providers::connect::pb::Writer::new();
            agent.bytes(1, &blobs.put_content(user.finish())?);
            for step in &turn.steps {
                agent.bytes(2, &blobs.put_content(step.clone())?);
            }
            let mut record = crate::providers::connect::pb::Writer::new();
            record.message(1, agent);
            state.bytes(8, &blobs.put_content(record.finish())?);
        }
        state.finish()
    } else {
        conversation_state(&ids)
    };
    let action = if resumes {
        Action::Resume { context }
    } else {
        Action::UserMessage { text: parsed.user_text, message_id: message_id.to_owned(), images: parsed.user_images, context }
    };
    let message = RunRequest {
        conversation_state,
        action,
        conversation_id: conversation_id.to_owned(),
        model_id: if matches!(selection.model_id.to_ascii_lowercase().as_str(), "auto" | "default") {
            "default".to_owned()
        } else {
            selection.model_id.clone()
        },
        max_mode: selection.max_mode,
        parameters: selection.parameters.clone(),
    }
    .encode();
    if message.len() > MAX_CONNECT_FRAME_BYTES {
        return Err(too_large("frame", MAX_CONNECT_FRAME_BYTES));
    }
    Ok(RunBuild { message, blobs, tools, cloud_rule })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_id_matches_the_product_derivation() {
        assert_eq!(conversation_id("thread-1"), "61c5169d-cd7d-48a5-9ddf-e5cb62e464dd");
    }

    /// A transcript that ends in tool results sends no user message: it resumes the open turn, which the state names
    /// with its user message and its steps, each tool step an MCP call carrying its result.
    #[test]
    fn a_transcript_ending_in_tool_results_resumes_its_open_turn() {
        use crate::providers::connect::pb::Reader;

        let mut call = Message::new(Role::Assistant, Content::Text(String::new().into()));
        call.tool_calls =
            vec![mixdog_core_api::domain::provider::ToolCall { id: "call-1".into(), name: "lookup".into(), arguments: serde_json::json!({}), native_type: None }];
        let mut result = Message::new(Role::Tool, Content::Text("42".into()));
        result.tool_call_id = Some("call-1".into());
        let request = ModelRequest {
            model: "m".into(),
            messages: vec![Message::new(Role::User, Content::Text("look it up".into())), call, result],
            tools: Vec::new(),
            options: Default::default(),
        };
        let selection = ModelSelection { model_id: "m".into(), parameters: Vec::new(), max_mode: false, pricing_model: None };
        let built = build_run(&request, &selection, "conversation", "message-1").unwrap();
        let field = |bytes: &[u8], wanted: u32| {
            let mut reader = Reader::new(bytes);
            std::iter::from_fn(|| reader.next_field().unwrap()).find(|(n, _)| *n == wanted).map(|(_, v)| v.bytes().to_vec())
        };
        let run = field(&built.message, 1).expect("run request");
        let action = field(&run, 2).expect("action");
        assert!(field(&action, 1).is_none(), "no user message, empty or not");
        assert!(field(&action, 2).is_some(), "the open turn is resumed");
        let state = field(&run, 1).expect("state");
        let mut reader = Reader::new(&state);
        let entries: Vec<u32> = std::iter::from_fn(|| reader.next_field().unwrap()).map(|(n, _)| n).collect();
        assert_eq!(entries, [1, 1, 1, 8], "the transcript's three entries, then its one turn");
        let turn = built.blobs.get(&field(&state, 8).expect("the turn")).expect("the turn's record").to_vec();
        let agent = field(&turn, 1).expect("an agent turn");
        let said = built.blobs.get(&field(&agent, 1).expect("the user's message")).expect("its record").to_vec();
        assert_eq!(field(&said, 1).as_deref(), Some(b"look it up".as_slice()));
        let step = built.blobs.get(&field(&agent, 2).expect("the step")).expect("its record").to_vec();
        let mcp = field(&field(&step, 2).expect("a tool call"), 15).expect("an MCP call");
        assert_eq!(field(&field(&mcp, 1).expect("args"), 3).as_deref(), Some(b"call-1".as_slice()));
        let text = [1, 1, 1, 1].iter().fold(field(&mcp, 2).expect("its result"), |bytes, n| field(&bytes, *n).expect("the result's text"));
        assert_eq!(text, b"42");
        assert_eq!(built.blobs.len(), 6, "the transcript, the user's message, the step and the turn");

        // A transcript that ends in what the user said asks with it, and names no turns.
        let mut asked = request.clone();
        asked.messages.push(Message::new(Role::User, Content::Text("and double it".into())));
        let built = build_run(&asked, &selection, "conversation", "message-1").unwrap();
        let run = field(&built.message, 1).expect("run request");
        let user = field(&field(&field(&run, 2).expect("action"), 1).expect("a user message action"), 1).expect("user message");
        assert_eq!((field(&user, 1).as_deref(), field(&user, 2).as_deref()), (Some(b"and double it".as_slice()), Some(b"message-1".as_slice())));
        assert!(field(&field(&run, 1).expect("state"), 8).is_none());
    }

    /// The state a resumed request names is answered whole for the life of its run, however many steps it has, and a
    /// rebuilt step says what the run was told when the call was answered on it: the images of a result that is only
    /// images, a text held to the bound of a result's text, arguments that are no object as the one argument they
    /// are, and what the assistant did before anything the user said. A turn's message id is of the conversation and
    /// of what was said, not of the turn's place in the transcript.
    #[test]
    fn a_rebuilt_state_holds_every_step_as_the_run_was_told_it() {
        use crate::providers::connect::pb::Reader;
        use mixdog_core_api::domain::provider::ToolCall;

        let all = |bytes: &[u8], wanted: u32| {
            let mut reader = Reader::new(bytes);
            std::iter::from_fn(|| reader.next_field().unwrap()).filter(|(n, _)| *n == wanted).map(|(_, v)| v.bytes().to_vec()).collect::<Vec<_>>()
        };
        let first = |bytes: &[u8], path: &[u32]| path.iter().fold(bytes.to_vec(), |bytes, n| all(&bytes, *n).into_iter().next().expect("the field"));
        let call = |id: &str, arguments: serde_json::Value| ToolCall { id: id.into(), name: "lookup".into(), arguments, native_type: None };
        let made = |calls: Vec<ToolCall>| {
            let mut made = Message::new(Role::Assistant, Content::Text(String::new().into()));
            made.tool_calls = calls;
            made
        };
        let result = |id: &str, content: Content| {
            let mut result = Message::new(Role::Tool, content);
            result.tool_call_id = Some(id.into());
            result
        };
        let image = ContentPart::Image(ImageSource::Base64 { data: STANDARD.encode(b"png bytes"), mime_type: "image/png".into(), width: None, height: None });
        let said = |text: &str| Message::new(Role::User, Content::Text(text.to_owned().into()));
        let selection = ModelSelection { model_id: "m".into(), parameters: Vec::new(), max_mode: false, pricing_model: None };
        let build = |messages: Vec<Message>, conversation: &str| {
            let request = ModelRequest { model: "m".into(), messages, tools: Vec::new(), options: Default::default() };
            build_run(&request, &selection, conversation, "message-1").unwrap()
        };
        // The turns of a built request: each its user message and its steps.
        let turns = |built: &RunBuild| {
            let state = first(&built.message, &[1, 1]);
            let blob = |id: &Vec<u8>| built.blobs.get(id).expect("every blob the state names is held").to_vec();
            all(&state, 1).iter().for_each(|id| drop(blob(id)));
            all(&state, 8)
                .iter()
                .map(|id| {
                    let agent = first(&blob(id), &[1]);
                    (blob(&first(&agent, &[1])), all(&agent, 2).iter().map(blob).collect::<Vec<_>>())
                })
                .collect::<Vec<_>>()
        };

        let long = "x".repeat(600 * 1024);
        let mut messages = vec![made(vec![call("early", serde_json::json!({}))]), result("early", Content::Text("before the user".into())), said("go")];
        messages.push(made(vec![call("seen", serde_json::json!({})), call("long", serde_json::json!({})), call("free", serde_json::json!("free text"))]));
        messages.extend([result("seen", Content::Parts(vec![image])), result("long", Content::Text(long.into())), result("free", Content::Text("ok".into()))]);
        let built = build(messages, "conversation");
        let of = turns(&built);
        assert_eq!(of.len(), 2, "what came before the user, and the user's turn");
        assert_eq!((all(&of[0].0, 1).concat(), of[0].1.len()), (Vec::new(), 1), "a turn that says nothing holds the early call");
        let steps = &of[1].1;
        let shown = first(&steps[0], &[2, 15, 2, 1]);
        assert_eq!(first(all(&shown, 1).last().expect("an item"), &[2, 1]), b"png bytes", "the image the result held");
        assert!(first(&steps[1], &[2, 15, 2, 1, 1, 1, 1]).len() <= 512 * 1024, "the text bound of a result");
        let argument = first(&steps[2], &[2, 15, 1, 2]);
        assert_eq!(first(&argument, &[1]), b"input");

        // More steps than the store keeps of what the service stores: all are held.
        let mut many = vec![said("go")];
        for n in 0..600 {
            let id = format!("call-{n}");
            many.push(made(vec![call(&id, serde_json::json!({"n": n}))]));
            many.push(result(&id, Content::Text(format!("result {n}").into())));
        }
        assert_eq!(turns(&build(many, "conversation"))[0].1.len(), 600);

        // The same turn has the same id with and without the turn before it, and another id in another conversation.
        let id_of = |messages: Vec<Message>, conversation: &str| first(&turns(&build(messages, conversation)).last().expect("a turn").0, &[2]);
        let tail = || vec![said("look"), made(vec![call("c", serde_json::json!({}))]), result("c", Content::Text("1".into()))];
        let whole: Vec<Message> = [said("earlier"), Message::new(Role::Assistant, Content::Text("yes".into()))].into_iter().chain(tail()).collect();
        assert_eq!(id_of(whole, "conversation"), id_of(tail(), "conversation"));
        assert_ne!(id_of(tail(), "conversation"), id_of(tail(), "another"));
        // Two turns that say the same: the later one keeps its own id when the earlier one is compacted away.
        let again = |call_id: &str, answer: &str| vec![said("look"), made(vec![call(call_id, serde_json::json!({}))]), result(call_id, Content::Text(answer.into()))];
        let both: Vec<Message> = again("c1", "1").into_iter().chain(again("c2", "2")).collect();
        assert_eq!(id_of(both, "conversation"), id_of(again("c2", "2"), "conversation"));
        assert_ne!(id_of(again("c1", "1"), "conversation"), id_of(again("c2", "2"), "conversation"));
    }

    #[test]
    fn blob_store_evicts_oldest_first() {
        let mut store = BlobStore::default();
        // What the service stores on the run is bounded, the oldest going first.
        for i in 0..(MAX_CONVERSATION_BLOB_ENTRIES + 2) {
            let data = format!("blob-{i}").into_bytes();
            store.put(&Sha256::digest(&data), data).unwrap();
        }
        assert_eq!(store.len(), MAX_CONVERSATION_BLOB_ENTRIES);
        let first = Sha256::digest(b"blob-0");
        assert!(store.get(&first).is_none());
        let last = Sha256::digest(format!("blob-{}", MAX_CONVERSATION_BLOB_ENTRIES + 1).as_bytes());
        assert!(store.get(&last).is_some());
    }

    #[test]
    fn slim_schema_drops_annotations_and_trivia() {
        let slim = slim_schema(
            &serde_json::json!({"title":"t","type":"object","additionalProperties":true,"required":[],"properties":{"a":{"default":1,"type":"string"}}}),
            0,
        );
        assert_eq!(slim, serde_json::json!({"type":"object","properties":{"a":{"type":"string"}}}));
    }

    /// The definitions sent beside a run are not what its model reads. Every tool offered, the bridge's two among them,
    /// is stated in the run's rule with its name and the schema of its arguments, after the system text that lists the
    /// deferred tools, in the order offered; a request that asks and one that resumes state the same.
    #[test]
    fn the_rule_states_every_offered_tool_with_its_schema() {
        use crate::providers::connect::pb::Reader;
        use serde_json::json;

        let tool = |name: &str, properties: serde_json::Value| ToolDefinition {
            name: name.into(),
            description: format!("{name} does."),
            input_schema: json!({"type": "object", "properties": properties}),
            defer_loading: false,
            freeform: None,
        };
        let tools = vec![
            tool("read", json!({"file_path": {"type": "string"}})),
            tool("todo", json!({"op": {"type": "string", "enum": ["set", "view"]}})),
            tool("load_tool", json!({"names": {"type": "array", "items": {"type": "string"}}})),
            tool("call_tool", json!({"name": {"type": "string"}, "arguments": {"type": "object"}})),
        ];
        let system = "rules\n\n---\n\n<available-deferred-tools>\n- git: Git.\n</available-deferred-tools>\n\n<tool-bridge>\nRun one with call_tool {name, arguments}.\n</tool-bridge>";
        let mut messages = vec![Message::new(Role::System, Content::Text(system.into())), Message::new(Role::User, Content::Text("review".into()))];
        let selection = ModelSelection { model_id: "m".into(), parameters: Vec::new(), max_mode: false, pricing_model: None };
        let field = |bytes: &[u8], wanted: u32| {
            let mut reader = Reader::new(bytes);
            std::iter::from_fn(|| reader.next_field().unwrap()).find(|(n, _)| *n == wanted).map(|(_, v)| v.bytes().to_vec())
        };
        // The rule of the request's context: `action` is 1 for a request that asks, 2 for one that resumes.
        let rule_of = |messages: &[Message], action: u32| {
            let request = ModelRequest { model: "m".into(), messages: messages.to_vec(), tools: tools.clone(), options: Default::default() };
            let built = build_run(&request, &selection, "conversation", "message-1").unwrap();
            let run = field(&built.message, 1).expect("run request");
            let inner = field(&field(&run, 2).expect("action"), action).expect("the action's kind");
            let context = field(&inner, 2).expect("request context");
            (String::from_utf8(field(&context, 16).expect("the rule")).unwrap(), built.tools)
        };
        let (rule, offered) = rule_of(&messages, 1);
        let stated = rule.strip_prefix(system).expect("the system text first").strip_prefix("\n\n<mixdog-tools>\n").expect("then the tools");
        let lines: Vec<serde_json::Value> =
            stated.strip_suffix("\n</mixdog-tools>").expect("closed").lines().skip(1).map(|line| serde_json::from_str(line).expect("one tool a line")).collect();
        assert_eq!(offered.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["read", "todo", "load_tool", "call_tool"]);
        assert_eq!(lines.len(), offered.len());
        for (line, tool) in lines.iter().zip(&offered) {
            assert_eq!(line, &json!({"name": tool.name, "description": tool.description, "inputSchema": tool.input_schema}));
        }

        let mut call = Message::new(Role::Assistant, Content::Text(String::new().into()));
        call.tool_calls = vec![mixdog_core_api::domain::provider::ToolCall { id: "call-1".into(), name: "todo".into(), arguments: json!({"op": "view"}), native_type: None }];
        let mut result = Message::new(Role::Tool, Content::Text("empty".into()));
        result.tool_call_id = Some("call-1".into());
        messages.extend([call, result]);
        assert_eq!(rule_of(&messages, 2).0, rule, "a resumed turn is told the same");
    }

    #[test]
    fn request_context_keeps_property_names_and_literal_enum_values() {
        let tool = ToolDefinition {
            name: "lookup".into(),
            description: "Read a record".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "title": {"type": "string", "title": "Display title"},
                    "default": {"type": ["object", "null"], "enum": [{"default": 1, "required": []}, null]}
                },
                "required": ["title"]
            }),
            defer_loading: false,
            freeform: None,
        };
        let request = ModelRequest { model: "auto".into(), messages: Vec::new(), tools: vec![tool], options: Default::default() };
        let context = request_context(&selected_tools(&request), None);
        assert_eq!(context.tools[0].name, "lookup");
        assert_eq!(context.tools[0].description, "Read a record");
        assert_eq!(
            context.tools[0].input_schema,
            serde_json::json!({
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "default": {"type": ["object", "null"], "enum": [{"default": 1, "required": []}, null]}
                },
                "required": ["title"]
            })
        );
    }
}
