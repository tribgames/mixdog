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

/// `_stableStringify`: an object's keys sorted at every object level; arrays
/// and scalars as `JSON.stringify` writes them.
pub fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let parts: Vec<String> = keys
                .iter()
                .map(|k| format!("{}:{}", serde_json::to_string(k).expect("a string serializes"), stable_stringify(&map[*k])))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        other => serde_json::to_string(other).expect("a JSON value serializes"),
    }
}

/// `_sansInput`: the request without its input and chain anchor; `generate`
/// moves last.
pub fn sans_input(body: &Map<String, Value>) -> Map<String, Value> {
    let mut rest: Map<String, Value> = body
        .iter()
        .filter(|(k, _)| !matches!(k.as_str(), "input" | "previous_response_id" | "generate"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
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

fn parts_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    let normalized = |side: Option<&Value>| match side {
        Some(Value::Array(parts)) => Value::Array(parts.iter().map(normalize_part).collect()),
        _ => Value::Array(Vec::new()),
    };
    stable_stringify(&normalized(a)) == stable_stringify(&normalized(b))
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
                && (text(response, "encrypted_content").is_empty()
                    || text(input, "encrypted_content") == text(response, "encrypted_content"))
        }
        "web_search_call" => {
            let action = |item: &Value| stable_stringify(item.get("action").unwrap_or(&Value::Null));
            in_type == "web_search_call"
                && (text(response, "id").is_empty() || text(input, "id") == text(response, "id"))
                && action(input) == action(response)
        }
        _ => {
            if in_type != out_type {
                return false;
            }
            let stripped = |item: &Value| {
                let rest: Map<String, Value> = item
                    .as_object()
                    .map(|m| m.iter().filter(|(k, _)| !matches!(k.as_str(), "id" | "status")).map(|(k, v)| (k.clone(), v.clone())).collect())
                    .unwrap_or_default();
                stable_stringify(&Value::Object(rest))
            };
            stripped(input) == stripped(response)
        }
    }
}

/// What the socket last exchanged: the anchor of the next request.
#[derive(Default, Clone, Debug)]
pub struct Chain {
    response_id: Option<String>,
    sans_input: Option<String>,
    input: Option<Vec<Value>>,
    response_items: Option<Vec<Value>>,
}

impl Chain {
    pub fn response_id(&self) -> Option<&str> {
        self.response_id.as_deref()
    }

    /// The socket's response is no longer a usable anchor.
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    /// `_anchorResponseChain`: the request just sent and the response items it
    /// produced become the anchor of the next request.
    pub fn anchor(&mut self, response_id: &str, request: &Map<String, Value>, response_items: &[Value]) {
        self.response_id = Some(response_id.to_owned());
        self.sans_input = Some(stable_stringify(&Value::Object(sans_input(request))));
        self.input = Some(request.get("input").and_then(Value::as_array).cloned().unwrap_or_default());
        self.response_items = Some(response_items.to_vec());
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Full,
    Delta,
}

pub struct Framed {
    pub mode: Mode,
    /// Why the frame is full (`no_anchor`, `request_properties_changed`,
    /// `input_prefix_mismatch`, `response_output_mismatch:<type>`).
    pub reason: Option<String>,
    pub frame: Map<String, Value>,
    /// Response items left out of a delta's tail.
    pub stripped: usize,
}

/// `_buildResponseCreateFrame`: `type` first, the body's keys in place minus
/// the transport-only ones; a delta carries `previous_response_id` right
/// before the tail and drops an empty `instructions`.
pub fn response_create(
    body: &Map<String, Value>,
    previous_response_id: Option<&str>,
    input_override: Option<Vec<Value>>,
) -> Map<String, Value> {
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
    Framed { mode: Mode::Full, reason: Some(reason.to_owned()), frame: response_create(body, None, None), stripped: 0 }
}

/// `_stripRequestPrefix`: the request input after the previous request's
/// input, when it begins with all of it.
fn strip_request_prefix<'a>(current: &'a [Value], previous: &[Value]) -> Option<&'a [Value]> {
    if current.len() < previous.len() {
        return None;
    }
    let same = current.iter().zip(previous).all(|(a, b)| stable_stringify(a) == stable_stringify(b));
    same.then(|| &current[previous.len()..])
}

/// `_stripResponseItemsFromHead`: the tail after the previous response's own
/// items, which must all lead it in order; `Err` carries the mismatch reason.
fn strip_response_items<'a>(tail: &'a [Value], outputs: &[Value]) -> Result<&'a [Value], String> {
    let mut cursor = 0;
    for output in outputs {
        if cursor < tail.len() && logical_item_match(&tail[cursor], output) {
            cursor += 1;
            continue;
        }
        let kind = Some(text(output, "type")).filter(|t| !t.is_empty()).unwrap_or("unknown");
        return Err(format!("response_output_mismatch:{kind}"));
    }
    Ok(&tail[cursor..])
}

/// `_computeDelta` under the `refs` policy: a delta only when the request
/// extends the exact previous request plus its response; otherwise a full
/// frame with the reason.
pub fn compute(chain: &Chain, body: &Map<String, Value>) -> Framed {
    let (Some(sans), Some(response_id)) =
        (chain.sans_input.as_deref().filter(|s| !s.is_empty()), chain.response_id.as_deref().filter(|s| !s.is_empty()))
    else {
        return full(body, "no_anchor");
    };
    let Some(previous_input) = chain.input.as_deref() else {
        return full(body, "no_input_snapshot");
    };
    if stable_stringify(&Value::Object(sans_input(body))) != sans {
        return full(body, "request_properties_changed");
    }
    let current = body.get("input").and_then(Value::as_array).map_or(&[][..], Vec::as_slice);
    let Some(after_previous) = strip_request_prefix(current, previous_input) else {
        return full(body, "input_prefix_mismatch");
    };
    let outputs = chain.response_items.as_deref().unwrap_or(&[]);
    match strip_response_items(after_previous, outputs) {
        Err(reason) => full(body, &reason),
        Ok(tail) => Framed {
            mode: Mode::Delta,
            reason: None,
            frame: response_create(body, Some(response_id), Some(tail.to_vec())),
            stripped: outputs.len(),
        },
    }
}
