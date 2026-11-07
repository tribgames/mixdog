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
    let hex: String = Sha256::digest(seed.as_bytes())
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect();
    let variant = (u8::from_str_radix(&hex[16..17], 16).expect("hex") & 3) | 8;
    format!(
        "{}-{}-4{}-{variant:x}{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[13..16],
        &hex[17..20],
        &hex[20..32]
    )
}

/// The conversation a scope owns: stable across attempts and turns.
pub fn conversation_id(scope: &str) -> String {
    let key: String = Sha256::digest(format!("cursor-session:{scope}").as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()[..20]
        .to_owned();
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
            if self.order.len() == 1 || self.order[0] == key {
                break;
            }
            let oldest = self.order.remove(0);
            if let Some(old) = self.blobs.remove(&oldest) {
                self.bytes -= old.len();
            }
        }
        Ok(())
    }

    /// Stores `data` under its own digest and returns the id.
    pub fn put_content(&mut self, data: Vec<u8>) -> Result<Vec<u8>, ProviderError> {
        let id = Sha256::digest(&data).to_vec();
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

// ---------------------------------------------------------------------------
// History entries (written with the key order the transcript blobs carry)
// ---------------------------------------------------------------------------

fn text_of(content: &Content) -> String {
    match content {
        Content::Text(t) => t.clone(),
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
        ContentPart::Image(ImageSource::Base64 { data, mime_type }) => {
            Some((format!("data:{mime_type};base64,{data}"), mime_type.clone(), data.as_str()))
        }
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
                ContentPart::Text(t, _) if !t.is_empty() => {
                    Some(format!("{{\"type\":\"text\",\"text\":{}}}", json_str(t)))
                }
                other => data_url_image(other).map(|(url, mime, _)| {
                    format!(
                        "{{\"type\":\"image\",\"image\":{},\"mediaType\":{}}}",
                        json_str(&url),
                        json_str(&mime)
                    )
                }),
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
        out.push(UserImage {
            uuid: random_uuid(),
            mime_type: mime,
            data: bytes,
        });
    }
    Ok(out)
}

fn tool_result_entry(message: &Message, tool_names: &HashMap<String, String>) -> String {
    let id = message.tool_call_id.clone().unwrap_or_default();
    let text = text_of(&message.content);
    let media: Vec<String> = match &message.content {
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|p| data_url_image(p).map(|(_, mime, _)| format!("[{mime} image]")))
            .collect(),
        Content::Text(_) => Vec::new(),
    };
    let result = std::iter::once(text)
        .chain(media)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
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
    for message in messages {
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
                history.push(format!(
                    "{{\"role\":\"user\",\"content\":[{}],\"text\":{}}}",
                    root_content(&message.content).join(","),
                    json_str(&text)
                ));
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
    Ok(ParsedMessages {
        systems,
        history,
        user_text,
        user_images,
    })
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const SCHEMA_ANNOTATIONS: [&str; 9] = [
    "$comment",
    "$id",
    "$schema",
    "default",
    "deprecated",
    "examples",
    "readOnly",
    "title",
    "writeOnly",
];

fn slim_schema(value: &Value, depth: usize) -> Value {
    if depth > 12 {
        return value.clone();
    }
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|v| slim_schema(v, depth + 1)).collect()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, child) in map {
                if SCHEMA_ANNOTATIONS.contains(&key.as_str()) {
                    continue;
                }
                if key == "additionalProperties" && child == &Value::Bool(true) {
                    continue;
                }
                if key == "required" && child.as_array().is_some_and(Vec::is_empty) {
                    continue;
                }
                out.insert(key.clone(), slim_schema(child, depth + 1));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
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
    McpToolDefinition {
        name: tool.name.clone(),
        description: tool.description.clone(),
        input_schema: schema,
        provider_identifier: "mixdog".to_owned(),
    }
}

/// The tools a request offers: none for `tool_choice: none`. Every `parameters` must first be a
/// valid 2020-12 object schema, as on any OpenAI-rule route (`cursor.mjs`: `acceptedWireTools(..,
/// 'openai', onToolExcluded, '[cursor] tool')`): a draft-07 one is lowered, a broken one left out and
/// reported. The check runs whatever the tool choice, as in Node.
pub fn selected_tools(request: &ModelRequest) -> Vec<McpToolDefinition> {
    static SCHEMAS: LazyLock<SchemaMemo> = LazyLock::new(SchemaMemo::default);
    let accepted = SCHEMAS.accepted_wire_tools(&request.tools, Rule::OpenAi, "[cursor] tool", &mut |excluded| {
        report_exclusion(&request.options, excluded)
    });
    // `selectToolsForChoice`: `none` offers nothing; a named tool (Node's object form
    // `{ name }` / `{ type: 'function', function: { name } }`, which `RequestOptions.tool_choice`
    // carries as the bare name) narrows the offer to the tools of that name, none when there is no
    // such tool; the keyword choices leave it whole.
    let named = match request.options.tool_choice.as_deref() {
        Some("none") => return Vec::new(),
        Some("" | "auto" | "required" | "any") | None => None,
        Some(name) => Some(name),
    };
    accepted
        .iter()
        .filter(|t| named.is_none_or(|name| t.name == name))
        .filter(|t| !t.name.is_empty())
        .map(prepare_tool)
        .collect()
}

pub fn request_context(tools: &[McpToolDefinition], cloud_rule: Option<&str>) -> RequestContext {
    RequestContext {
        tools: tools.to_vec(),
        mcp_instructions: if tools.is_empty() {
            Vec::new()
        } else {
            vec![("mixdog".to_owned(), MCP_INSTRUCTIONS.to_owned())]
        },
        cloud_rule: cloud_rule.map(str::to_owned),
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

/// Builds the run request of one attempt.
pub fn build_run(
    request: &ModelRequest,
    selection: &ModelSelection,
    conversation_id: &str,
    message_id: &str,
) -> Result<RunBuild, ProviderError> {
    let parsed = parse_messages(&request.messages)?;
    if parsed.user_text.is_empty() && parsed.user_images.is_empty() && parsed.history.is_empty() {
        let mut error = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
        error.message = "No user message found".to_owned();
        return Err(error);
    }
    let tools = selected_tools(request);
    let cloud_rule = (!parsed.systems.is_empty()).then(|| parsed.systems.join("\n\n"));
    let context = request_context(&tools, cloud_rule.as_deref());
    let mut blobs = BlobStore::default();
    let mut ids = Vec::new();
    for entry in &parsed.history {
        ids.push(blobs.put_content(entry.clone().into_bytes())?);
    }
    let action = if parsed.user_text.is_empty() && parsed.user_images.is_empty() {
        Action::Resume { context }
    } else {
        Action::UserMessage {
            text: parsed.user_text,
            message_id: message_id.to_owned(),
            images: parsed.user_images,
            context,
        }
    };
    let message = RunRequest {
        conversation_state: conversation_state(&ids),
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
    Ok(RunBuild {
        message,
        blobs,
        tools,
        cloud_rule,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_id_matches_the_product_derivation() {
        assert_eq!(conversation_id("thread-1"), "61c5169d-cd7d-48a5-9ddf-e5cb62e464dd");
    }

    #[test]
    fn blob_store_evicts_oldest_first() {
        let mut store = BlobStore::default();
        for i in 0..(MAX_CONVERSATION_BLOB_ENTRIES + 2) {
            store.put_content(format!("blob-{i}").into_bytes()).unwrap();
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

    /// Which tools a run offers for a tool choice against `fixtures/providers/cursor-tool-choice/cases.json`
    /// (recorded by `record-cursor-tool-choice.mjs` from the real `toCursorToolChoice`,
    /// `selectToolsForChoice` and `buildToolDefinitions`). `RequestOptions.tool_choice` carries the
    /// choice as one string: the keyword, or the tool name of Node's object form, which is read
    /// from the `tool_choice` Node itself puts in the body.
    #[test]
    fn a_named_tool_choice_narrows_the_offer_as_node_does() {
        use mixdog_core_api::domain::provider::RequestOptions;

        let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/providers/cursor-tool-choice/cases.json")).expect("recorded cases");
        for case in golden["cases"].as_array().expect("cases") {
            let id = case["id"].as_str().expect("id");
            let body = &case["bodyToolChoice"];
            let choice = body.as_str().or_else(|| body["function"]["name"].as_str()).map(str::to_owned);
            let request = ModelRequest {
                model: "auto".into(),
                messages: Vec::new(),
                tools: case["tools"]
                    .as_array()
                    .expect("tools")
                    .iter()
                    .map(|name| ToolDefinition {
                        name: name.as_str().expect("name").into(),
                        description: String::new(),
                        input_schema: serde_json::json!({"type": "object", "properties": {"key": {"type": "string"}}}),
                        defer_loading: false,
                        freeform: None,
                    })
                    .collect(),
                options: RequestOptions { tool_choice: choice, ..RequestOptions::default() },
            };
            let offered: Vec<String> = selected_tools(&request).into_iter().map(|t| t.name).collect();
            let want: Vec<String> = case["offered"].as_array().expect("offered").iter().map(|n| n.as_str().expect("name").to_owned()).collect();
            assert_eq!(offered, want, "{id}");
        }
    }

    /// The tools a run offers against `fixtures/providers/cursor-tools/cases.json` (recorded by
    /// `record-cursor-tools.mjs` from the real `acceptedWireTools`, `toOpenAITools`,
    /// `selectToolsForChoice` and `buildToolDefinitions`): the OpenAI rule first (a broken schema
    /// is left out and reported whatever the tool choice, a draft-07 one lowered), then slimming and
    /// the flat form of a compound root. The schema text is compared whole, key order included.
    #[test]
    fn the_tools_a_run_offers_are_the_ones_node_offers() {
        use std::sync::Arc;
        use std::sync::Mutex;

        use mixdog_core_api::domain::provider::RequestOptions;
        use mixdog_core_api::domain::provider::ToolExclusionReport;
        use mixdog_core_api::domain::provider::ToolExclusionSink;

        let golden: Value = serde_json::from_str(include_str!("../../../../../fixtures/providers/cursor-tools/cases.json")).expect("recorded cases");
        for case in golden["cases"].as_array().expect("cases") {
            let id = case["id"].as_str().expect("id");
            let seen = Arc::new(Mutex::new(Vec::<ToolExclusionReport>::new()));
            let into = Arc::clone(&seen);
            let request = ModelRequest {
                model: "auto".into(),
                messages: Vec::new(),
                tools: case["tools"]
                    .as_array()
                    .expect("tools")
                    .iter()
                    .map(|t| ToolDefinition {
                        name: t["name"].as_str().expect("name").into(),
                        description: t["description"].as_str().expect("description").into(),
                        input_schema: t["inputSchema"].clone(),
                        defer_loading: false,
                        freeform: None,
                    })
                    .collect(),
                options: RequestOptions {
                    tool_choice: case["toolChoice"].as_str().map(str::to_owned),
                    on_tool_excluded: Some(ToolExclusionSink(Arc::new(move |report: ToolExclusionReport| {
                        into.lock().unwrap().push(report);
                    }))),
                    ..RequestOptions::default()
                },
            };
            let offered = selected_tools(&request);
            let want = case["offered"].as_array().expect("offered");
            assert_eq!(offered.len(), want.len(), "{id}: {:?}", offered.iter().map(|t| &t.name).collect::<Vec<_>>());
            for (got, want) in offered.iter().zip(want) {
                assert_eq!(got.name, want["name"].as_str().unwrap(), "{id}");
                assert_eq!(got.description, want["description"].as_str().unwrap(), "{id}: {}", got.name);
                assert_eq!(got.input_schema.to_string(), want["inputSchemaJson"].as_str().unwrap(), "{id}: {}", got.name);
            }
            let reports = seen.lock().unwrap();
            let want = case["excluded"].as_array().expect("excluded");
            assert_eq!(reports.len(), want.len(), "{id}: {reports:?}");
            for (got, want) in reports.iter().zip(want) {
                assert_eq!(got.name, want["name"].as_str().unwrap(), "{id}");
                assert_eq!(got.index as u64, want["index"].as_u64().unwrap(), "{id}");
                assert_eq!(got.pointer, want["pointer"].as_str().unwrap(), "{id}");
                assert_eq!(got.reason, want["reason"].as_str().unwrap(), "{id}");
                assert_eq!(got.message, want["message"].as_str().unwrap(), "{id}");
            }
        }
    }
}
