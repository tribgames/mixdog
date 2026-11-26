//! Incremental `response.create` frames (`openai-ws-delta.mjs`): whether a warm
//! socket can send only the input tail with `previous_response_id`, and the
//! canonical frame builder. Pure functions over request bodies and the
//! snapshot of the previous exchange on the socket ([`Chain`]); the default
//! `refs` policy of `openai-transport-policy.mjs` (delta on, no turn-state
//! requirement) with every structural guard kept.

use serde_json::Map;
use serde_json::Value;

/// Fields a socket carries implicitly; never in a frame.
const TRANSPORT_ONLY: [&str; 2] = ["stream", "background"];

/// JS truthiness of a string field: set and non-empty.
fn text<'a>(item: &'a Value, key: &str) -> &'a str {
    item.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `_stableStringify`: arrays keep the key order of what is inside them, so a tool's `type`
/// stays before its `name`.
pub use mixdog_js::json_stringify_sorted_outside_arrays as stable_stringify;

/// `_sansInput`: the request without its input and chain anchor; `generate`
/// moves last.
pub fn sans_input(body: &Map<String, Value>) -> Map<String, Value> {
    let mut rest: Map<String, Value> =
        body.iter().filter(|(k, _)| !matches!(k.as_str(), "input" | "previous_response_id" | "generate")).map(|(k, v)| (k.clone(), v.clone())).collect();
    if let Some(generate) = body.get("generate") {
        rest.insert("generate".into(), generate.clone());
    }
    rest
}

/// `_normalizeArguments`: a call's arguments as comparable text.
fn normalize_arguments(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            let source = if trimmed.is_empty() { "{}" } else { trimmed };
            serde_json::from_str::<Value>(source).map_or_else(|_| trimmed.to_owned(), |parsed| stable_stringify(&parsed))
        }
        Some(other) => stable_stringify(other),
    }
}

fn normalize_part(part: &Value) -> Value {
    let Some(map) = part.as_object() else {
        return part.clone();
    };
    let kind = match text(part, "type") {
        "input_text" => "output_text",
        other => other,
    };
    if kind == "output_text" {
        let mut out = Map::new();
        out.insert("type".into(), kind.into());
        out.insert("text".into(), text(part, "text").into());
        return Value::Object(out);
    }
    Value::Object(map.clone())
}

fn normalized_parts_string(side: Option<&Value>) -> String {
    let normalized = match side {
        Some(Value::Array(parts)) => Value::Array(parts.iter().map(normalize_part).collect()),
        _ => Value::Array(Vec::new()),
    };
    stable_stringify(&normalized)
}

fn parts_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    normalized_parts_string(a) == normalized_parts_string(b)
}

fn stripped_object_string(item: &Value) -> String {
    let rest: Map<String, Value> = item
        .as_object()
        .map(|m| m.iter().filter(|(k, _)| !matches!(k.as_str(), "id" | "status")).map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default();
    stable_stringify(&Value::Object(rest))
}

fn input_type(item: &Value) -> &str {
    match text(item, "type") {
        "" if text(item, "role") == "assistant" => "message",
        other => other,
    }
}

/// `_logicalResponseItemMatch`: whether a request-input item is the response
/// item the previous response produced.
pub fn logical_item_match(input: &Value, response: &Value) -> bool {
    if !input.is_object() || !response.is_object() {
        return false;
    }
    let in_type = input_type(input);
    let out_type = text(response, "type");
    let (in_call, out_call) = (text(input, "call_id"), text(response, "call_id"));
    let (in_name, out_name) = (text(input, "name"), text(response, "name"));
    match out_type {
        "function_call" => {
            if in_type != "function_call" {
                return false;
            }
            if !in_call.is_empty() && !out_call.is_empty() {
                return in_call == out_call && in_name == out_name;
            }
            in_name == out_name && normalize_arguments(input.get("arguments")) == normalize_arguments(response.get("arguments"))
        }
        "tool_search_call" => {
            if in_type != "tool_search_call" {
                return false;
            }
            if !in_call.is_empty() && !out_call.is_empty() {
                return in_call == out_call;
            }
            normalize_arguments(input.get("arguments")) == normalize_arguments(response.get("arguments"))
        }
        "custom_tool_call" => {
            if in_type != "custom_tool_call" {
                return false;
            }
            if !in_call.is_empty() && !out_call.is_empty() {
                return in_call == out_call && in_name == out_name;
            }
            in_name == out_name && text(input, "input") == text(response, "input")
        }
        "message" => {
            let in_role = match text(input, "role") {
                "" if in_type == "message" => "assistant",
                role => role,
            };
            let out_role = match text(response, "role") {
                "" => "assistant",
                role => role,
            };
            in_type == "message" && in_role == out_role && parts_equal(input.get("content"), response.get("content"))
        }
        "reasoning" => {
            in_type == "reasoning"
                && (text(response, "id").is_empty() || text(input, "id") == text(response, "id"))
                && (text(response, "encrypted_content").is_empty() || text(input, "encrypted_content") == text(response, "encrypted_content"))
        }
        "web_search_call" => {
            let action = |item: &Value| stable_stringify(item.get("action").unwrap_or(&Value::Null));
            in_type == "web_search_call" && (text(response, "id").is_empty() || text(input, "id") == text(response, "id")) && action(input) == action(response)
        }
        _ => {
            if in_type != out_type {
                return false;
            }
            stripped_object_string(input) == stripped_object_string(response)
        }
    }
}

fn digest(text: &str) -> [u8; 32] {
    use sha2::Digest as _;
    sha2::Sha256::digest(text.as_bytes()).into()
}

/// One item of the request a socket last sent, as the next request is compared with it: what it hashes to, never its content.
/// A parked socket would otherwise hold a second copy of the whole conversation for as long as it stays open.
#[derive(Clone, Debug)]
struct Sent {
    /// SHA-256 of the item's canonical text: the next request extends this one when its items hash to the same, in order.
    exact: [u8; 32],
    /// The item's type and the hash of its compared shape, as a mismatch's diagnostics name the expected item.
    kind: String,
    shape: String,
}

impl Sent {
    fn of(item: &Value) -> Self {
        Self { exact: digest(&stable_stringify(item)), kind: diagnostic_type(Some(item)), shape: diagnostic_hash(Some(item)) }
    }

    fn is(&self, item: &Value) -> bool {
        digest(&stable_stringify(item)) == self.exact
    }
}

/// Compact matcher for one item the previous response produced: hashes and identifying keys, never raw content.
#[derive(Clone, Debug)]
struct ResponseItem {
    kind: String,
    shape: String,
    matcher: ResponseMatcher,
}

#[derive(Clone, Debug)]
enum ResponseMatcher {
    NonObject,
    FunctionCall { call_id: String, name: String, args_hash: [u8; 32] },
    ToolSearchCall { call_id: String, args_hash: [u8; 32] },
    CustomToolCall { call_id: String, name: String, input_hash: [u8; 32] },
    Message { role: String, content_hash: [u8; 32] },
    Reasoning { id: String, encrypted_content_hash: Option<[u8; 32]> },
    WebSearchCall { id: String, action_hash: [u8; 32] },
    Other { out_type: String, stripped_hash: [u8; 32] },
}

impl ResponseItem {
    fn of(response: &Value) -> Self {
        let kind = Some(text(response, "type")).filter(|t| !t.is_empty()).unwrap_or("unknown").to_owned();
        let shape = diagnostic_hash(Some(response));
        let matcher = if !response.is_object() {
            ResponseMatcher::NonObject
        } else {
            let out_type = text(response, "type");
            match out_type {
                "function_call" => ResponseMatcher::FunctionCall {
                    call_id: text(response, "call_id").to_owned(),
                    name: text(response, "name").to_owned(),
                    args_hash: digest(&normalize_arguments(response.get("arguments"))),
                },
                "tool_search_call" => ResponseMatcher::ToolSearchCall {
                    call_id: text(response, "call_id").to_owned(),
                    args_hash: digest(&normalize_arguments(response.get("arguments"))),
                },
                "custom_tool_call" => ResponseMatcher::CustomToolCall {
                    call_id: text(response, "call_id").to_owned(),
                    name: text(response, "name").to_owned(),
                    input_hash: digest(text(response, "input")),
                },
                "message" => {
                    let role = match text(response, "role") {
                        "" => "assistant",
                        r => r,
                    };
                    ResponseMatcher::Message { role: role.to_owned(), content_hash: digest(&normalized_parts_string(response.get("content"))) }
                }
                "reasoning" => {
                    let enc = text(response, "encrypted_content");
                    ResponseMatcher::Reasoning { id: text(response, "id").to_owned(), encrypted_content_hash: (!enc.is_empty()).then(|| digest(enc)) }
                }
                "web_search_call" => ResponseMatcher::WebSearchCall {
                    id: text(response, "id").to_owned(),
                    action_hash: digest(&stable_stringify(response.get("action").unwrap_or(&Value::Null))),
                },
                other => ResponseMatcher::Other { out_type: other.to_owned(), stripped_hash: digest(&stripped_object_string(response)) },
            }
        };
        Self { kind, shape, matcher }
    }

    fn matches(&self, input: &Value) -> bool {
        if !input.is_object() {
            return false;
        }
        let in_type = input_type(input);
        match &self.matcher {
            ResponseMatcher::NonObject => false,
            ResponseMatcher::FunctionCall { call_id, name, args_hash } => {
                if in_type != "function_call" {
                    return false;
                }
                let in_call = text(input, "call_id");
                let in_name = text(input, "name");
                if !in_call.is_empty() && !call_id.is_empty() {
                    return in_call == call_id && in_name == name;
                }
                in_name == name && digest(&normalize_arguments(input.get("arguments"))) == *args_hash
            }
            ResponseMatcher::ToolSearchCall { call_id, args_hash } => {
                if in_type != "tool_search_call" {
                    return false;
                }
                let in_call = text(input, "call_id");
                if !in_call.is_empty() && !call_id.is_empty() {
                    return in_call == call_id;
                }
                digest(&normalize_arguments(input.get("arguments"))) == *args_hash
            }
            ResponseMatcher::CustomToolCall { call_id, name, input_hash } => {
                if in_type != "custom_tool_call" {
                    return false;
                }
                let in_call = text(input, "call_id");
                let in_name = text(input, "name");
                if !in_call.is_empty() && !call_id.is_empty() {
                    return in_call == call_id && in_name == name;
                }
                in_name == name && digest(text(input, "input")) == *input_hash
            }
            ResponseMatcher::Message { role, content_hash } => {
                let in_role = match text(input, "role") {
                    "" if in_type == "message" => "assistant",
                    r => r,
                };
                in_type == "message" && in_role == role && digest(&normalized_parts_string(input.get("content"))) == *content_hash
            }
            ResponseMatcher::Reasoning { id, encrypted_content_hash } => {
                in_type == "reasoning"
                    && (id.is_empty() || text(input, "id") == id)
                    && encrypted_content_hash.is_none_or(|hash| digest(text(input, "encrypted_content")) == hash)
            }
            ResponseMatcher::WebSearchCall { id, action_hash } => {
                in_type == "web_search_call"
                    && (id.is_empty() || text(input, "id") == id)
                    && digest(&stable_stringify(input.get("action").unwrap_or(&Value::Null))) == *action_hash
            }
            ResponseMatcher::Other { out_type, stripped_hash } => in_type == out_type && digest(&stripped_object_string(input)) == *stripped_hash,
        }
    }
}

/// What the socket last exchanged: the anchor of the next request.
#[derive(Default, Clone, Debug)]
pub struct Chain {
    response_id: Option<String>,
    /// SHA-256 of the canonical text of the request without its input.
    sans_input: Option<[u8; 32]>,
    input: Option<Vec<Sent>>,
    response_items: Option<Vec<ResponseItem>>,
}

impl Chain {
    pub fn response_id(&self) -> Option<&str> {
        self.response_id.as_deref()
    }

    /// The socket's response is no longer a usable anchor.
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// A pool entry's chain fields as Node holds them (`lastResponseId`,
    /// `lastRequestSansInput`, `lastRequestInput`, `lastResponseItems`), for
    /// a replay that hands `compute` a recorded entry.
    #[cfg(feature = "test-support")]
    pub fn from_entry(response_id: Option<String>, sans_input: Option<String>, input: Option<Vec<Value>>, response_items: Option<Vec<Value>>) -> Self {
        Self {
            response_id,
            sans_input: sans_input.filter(|text| !text.is_empty()).map(|text| digest(&text)),
            input: input.map(|items| items.iter().map(Sent::of).collect()),
            response_items: response_items.map(|items| items.iter().map(ResponseItem::of).collect()),
        }
    }

    /// `_anchorResponseChain`: the request just sent and the response items it
    /// produced become the anchor of the next request.
    pub fn anchor(&mut self, response_id: &str, request: &Map<String, Value>, response_items: &[Value]) {
        self.response_id = Some(response_id.to_owned());
        self.sans_input = Some(digest(&stable_stringify(&Value::Object(sans_input(request)))));
        self.input = Some(request.get("input").and_then(Value::as_array).map(|items| items.iter().map(Sent::of).collect()).unwrap_or_default());
        self.response_items = Some(response_items.iter().map(ResponseItem::of).collect());
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Full,
    Delta,
}

pub struct Framed {
    pub mode: Mode,
    /// Why the frame is full (`full_default`, `no_anchor`,
    /// `no_input_snapshot`, `request_properties_changed`,
    /// `input_prefix_mismatch`, `response_output_mismatch:<type>`).
    pub reason: Option<String>,
    pub frame: Map<String, Value>,
    /// Response items left out of a delta's tail.
    pub stripped: usize,
    /// Where the request stopped extending the previous one
    /// (`requestInputMismatch`), for `input_prefix_mismatch`.
    pub input_mismatch: Option<InputMismatch>,
    /// The response item the request did not replay
    /// (`responseOutputMismatch`), for `response_output_mismatch:<type>`.
    pub output_mismatch: Option<OutputMismatch>,
}

/// `_requestInputMismatchDiagnostics`: types and content hashes, never content.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct InputMismatch {
    pub index: usize,
    pub previous_count: usize,
    pub current_count: usize,
    pub expected_type: String,
    pub expected_hash: String,
    pub actual_type: String,
    pub actual_hash: String,
}

/// `_responseOutputMismatchDiagnostics`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct OutputMismatch {
    pub expected_type: String,
    pub expected_hash: String,
    pub expected_response_item_count: usize,
    pub actual_type: String,
    pub actual_hash: String,
    pub actual_replayed_input_item_count: usize,
}

/// JS `String(v || '')` of a field.
fn js_string(item: &Value, key: &str) -> Value {
    Value::String(match item.get(key) {
        None | Some(Value::Null | Value::Bool(false)) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => String::new(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => stable_stringify(other),
    })
}

/// JS `v || null` of a field.
fn or_null(item: &Value, key: &str) -> Value {
    match item.get(key) {
        None | Some(Value::Null | Value::Bool(false)) => Value::Null,
        Some(Value::String(s)) if s.is_empty() => Value::Null,
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => Value::Null,
        Some(v) => v.clone(),
    }
}

/// `_normalizedResponseItemDiagnosticShape`: the fields `logical_item_match`
/// compares, per item type.
fn diagnostic_shape(item: Option<&Value>) -> Value {
    let Some(item) = item else { return Value::Null };
    let Some(map) = item.as_object() else { return item.clone() };
    let kind = input_type(item).to_owned();
    let mut out = Map::new();
    out.insert("type".into(), Value::String(kind.clone()));
    match kind.as_str() {
        "function_call" | "tool_search_call" => {
            out.insert("call_id".into(), js_string(item, "call_id"));
            if kind == "function_call" {
                out.insert("name".into(), js_string(item, "name"));
            }
            out.insert("arguments".into(), Value::String(normalize_arguments(item.get("arguments"))));
        }
        "custom_tool_call" => {
            out.insert("call_id".into(), js_string(item, "call_id"));
            out.insert("name".into(), js_string(item, "name"));
            out.insert("input".into(), js_string(item, "input"));
        }
        "message" => {
            let role = or_null(item, "role");
            out.insert("role".into(), if role.is_null() { "assistant".into() } else { role });
            let content = match item.get("content") {
                Some(Value::Array(parts)) => parts.iter().map(normalize_part).collect(),
                _ => Vec::new(),
            };
            out.insert("content".into(), Value::Array(content));
        }
        "reasoning" => {
            out.insert("id".into(), or_null(item, "id"));
            out.insert("encrypted_content".into(), or_null(item, "encrypted_content"));
        }
        "web_search_call" => {
            out.insert("id".into(), or_null(item, "id"));
            out.insert("action".into(), or_null(item, "action"));
        }
        _ => {
            for (k, v) in map {
                if !matches!(k.as_str(), "id" | "status") {
                    out.insert(k.clone(), v.clone());
                }
            }
        }
    }
    Value::Object(out)
}

fn diagnostic_hash(item: Option<&Value>) -> String {
    use sha2::Digest as _;
    let digest = sha2::Sha256::digest(stable_stringify(&diagnostic_shape(item)).as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// `_diagnosticItemType`.
fn diagnostic_type(item: Option<&Value>) -> String {
    match item {
        None => "missing".into(),
        Some(item) => match text(item, "type") {
            "" if text(item, "role") == "assistant" => "message".into(),
            "" => "unknown".into(),
            kind => kind.into(),
        },
    }
}

fn input_mismatch(current: &[Value], previous: &[Sent]) -> InputMismatch {
    let limit = current.len().min(previous.len());
    let index = (0..limit).find(|&i| !previous[i].is(&current[i])).unwrap_or(limit);
    let (expected, actual) = (previous.get(index), current.get(index));
    InputMismatch {
        index,
        previous_count: previous.len(),
        current_count: current.len(),
        expected_type: expected.map_or_else(|| diagnostic_type(None), |sent| sent.kind.clone()),
        expected_hash: expected.map_or_else(|| diagnostic_hash(None), |sent| sent.shape.clone()),
        actual_type: diagnostic_type(actual),
        actual_hash: diagnostic_hash(actual),
    }
}

/// `_buildResponseCreateFrame`: `type` first, the body's keys in place minus
/// the transport-only ones; a delta carries `previous_response_id` right
/// before the tail and drops an empty `instructions`.
pub fn response_create(body: &Map<String, Value>, previous_response_id: Option<&str>, input_override: Option<Vec<Value>>) -> Map<String, Value> {
    let mut frame = Map::new();
    frame.insert("type".into(), "response.create".into());
    let chained = previous_response_id.is_some() || input_override.is_some();
    for (key, value) in body {
        if TRANSPORT_ONLY.contains(&key.as_str()) {
            continue;
        }
        if !chained {
            frame.insert(key.clone(), value.clone());
            continue;
        }
        match key.as_str() {
            "instructions" => {
                if value.as_str().is_some_and(|s| !s.is_empty()) {
                    frame.insert(key.clone(), value.clone());
                }
            }
            "input" => {
                if let Some(id) = previous_response_id {
                    frame.insert("previous_response_id".into(), id.into());
                }
                let input = input_override.clone().map_or_else(|| value.clone(), Value::Array);
                frame.insert("input".into(), input);
            }
            _ => {
                frame.insert(key.clone(), value.clone());
            }
        }
    }
    if !frame.contains_key("input")
        && let Some(tail) = input_override
    {
        if let Some(id) = previous_response_id {
            frame.insert("previous_response_id".into(), id.into());
        }
        frame.insert("input".into(), Value::Array(tail));
    }
    frame
}

fn full(body: &Map<String, Value>, reason: &str) -> Framed {
    Framed {
        mode: Mode::Full,
        reason: Some(reason.to_owned()),
        frame: response_create(body, None, None),
        stripped: 0,
        input_mismatch: None,
        output_mismatch: None,
    }
}

/// `_stripRequestPrefix`: the request input after the previous request's
/// input, when it begins with all of it.
fn strip_request_prefix<'a>(current: &'a [Value], previous: &[Sent]) -> Option<&'a [Value]> {
    if current.len() < previous.len() {
        return None;
    }
    let same = current.iter().zip(previous).all(|(item, sent)| sent.is(item));
    same.then(|| &current[previous.len()..])
}

/// `_stripResponseItemsFromHead`: the tail after the previous response's own
/// items, which must all lead it in order; `Err` carries the mismatch reason
/// and its diagnostics.
#[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
fn strip_response_items<'a>(tail: &'a [Value], outputs: &[ResponseItem]) -> Result<&'a [Value], (String, OutputMismatch)> {
    let mut cursor = 0;
    for output in outputs {
        if cursor < tail.len() && output.matches(&tail[cursor]) {
            cursor += 1;
            continue;
        }
        let actual = tail.get(cursor);
        let actual_type = match actual.map(input_type) {
            Some(t) if !t.is_empty() => t.to_owned(),
            _ => "unknown".to_owned(),
        };
        let mismatch = OutputMismatch {
            expected_type: output.kind.clone(),
            expected_hash: output.shape.clone(),
            expected_response_item_count: outputs.len(),
            actual_type,
            actual_hash: diagnostic_hash(actual),
            actual_replayed_input_item_count: tail.len(),
        };
        return Err((format!("response_output_mismatch:{}", output.kind), mismatch));
    }
    Ok(&tail[cursor..])
}

/// The server no longer holds the response a delta frame continued (`previous_response_not_found`): the request has to go
/// again as a full frame.
pub fn chain_refused(error: &mixdog_core_api::domain::provider::ProviderError) -> bool {
    error.code.as_deref() == Some("previous_response_not_found")
}

/// `_computeDelta` under the resolved policy's delta switch (`delta.optIn`;
/// only `refs` exists): a delta only when the request extends the exact
/// previous request plus its response; otherwise a full frame with the
/// reason.
pub fn compute(delta: bool, chain: &Chain, body: &Map<String, Value>) -> Framed {
    compute_with(delta, true, chain, body)
}

/// [`compute`] for a provider that may refuse `instructions` beside `previous_response_id`
/// (`ResponsesProfile::instructions_with_previous_response`). The stored response does not hold them, so a request that has
/// them goes as a full frame there.
pub fn compute_with(delta: bool, instructions_with_previous_response: bool, chain: &Chain, body: &Map<String, Value>) -> Framed {
    if !delta {
        return full(body, "full_default");
    }
    if !instructions_with_previous_response && body.get("instructions").and_then(Value::as_str).is_some_and(|text| !text.is_empty()) {
        return full(body, "instructions_with_previous_response");
    }
    let (Some(sans), Some(response_id)) = (chain.sans_input, chain.response_id.as_deref().filter(|s| !s.is_empty())) else {
        return full(body, "no_anchor");
    };
    let Some(previous_input) = chain.input.as_deref() else {
        return full(body, "no_input_snapshot");
    };
    if digest(&stable_stringify(&Value::Object(sans_input(body)))) != sans {
        return full(body, "request_properties_changed");
    }
    let current = body.get("input").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let Some(after_previous) = strip_request_prefix(current, previous_input) else {
        return Framed { input_mismatch: Some(input_mismatch(current, previous_input)), ..full(body, "input_prefix_mismatch") };
    };
    let outputs = chain.response_items.as_deref().unwrap_or(&[]);
    match strip_response_items(after_previous, outputs) {
        Err((reason, mismatch)) => Framed { output_mismatch: Some(mismatch), ..full(body, &reason) },
        Ok(tail) => Framed {
            mode: Mode::Delta,
            reason: None,
            frame: response_create(body, Some(response_id), Some(tail.to_vec())),
            stripped: outputs.len(),
            input_mismatch: None,
            output_mismatch: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn chain_anchors_response_items_without_retaining_raw_payloads() {
        let large_text = "x".repeat(64 * 1024);
        let req1 = json!({
            "model": "gpt-5",
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}]
        });
        let resp_items = vec![
            json!({"type": "reasoning", "id": "rs_1", "encrypted_content": large_text}),
            json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": large_text}]}),
            json!({"type": "function_call", "call_id": "call_1", "name": "read", "arguments": format!("{{\"body\":\"{large_text}\"}}")}),
        ];
        let mut chain = Chain::default();
        chain.anchor("resp_1", req1.as_object().unwrap(), &resp_items);
        let debug = format!("{chain:?}");
        assert!(!debug.contains(&"x".repeat(256)), "Chain retained raw response item content");

        let req2 = json!({
            "model": "gpt-5",
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
                {"type": "reasoning", "id": "rs_1", "encrypted_content": large_text},
                {"type": "message", "role": "assistant", "content": [{"type": "input_text", "text": large_text}]},
                {"type": "function_call", "call_id": "call_1", "name": "read", "arguments": "{}"},
                {"type": "function_call_output", "call_id": "call_1", "output": "ok"}
            ]
        });
        let framed = compute(true, &chain, req2.as_object().unwrap());
        assert_eq!(framed.mode, Mode::Delta);
        assert_eq!(framed.stripped, 3);

        let mismatch_req = json!({
            "model": "gpt-5",
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
                {"type": "reasoning", "id": "rs_1", "encrypted_content": "wrong"}
            ]
        });
        let mismatch = compute(true, &chain, mismatch_req.as_object().unwrap());
        assert_eq!(mismatch.mode, Mode::Full);
        assert_eq!(mismatch.reason.as_deref(), Some("response_output_mismatch:reasoning"));
        let diag = mismatch.output_mismatch.expect("mismatch diagnostics");
        assert_eq!(diag.expected_hash, diagnostic_hash(Some(&resp_items[0])));
    }
}
