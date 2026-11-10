//! The Node recordings of `fixtures/provider-wire` (`benchmarks/rust-core/recorders/record-provider-wire.mjs`): each
//! scenario's Node send arguments (`input.json`), the exchange the loopback hub recorded (`exchange.json`) and Node's
//! result (`result.json`), with the reading of Node's transcript messages into the neutral ones and the whole-result
//! comparison: every event a codec decodes is rendered in Node's result shape ([`core_result`]) and compared with
//! Node's whole result ([`node_result`]), which leaves out only the fields the manifest's exclusions name.

use std::path::PathBuf;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::UsdTicks;
use mixdog_protocol::ProviderId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

pub(crate) struct Recorded {
    pub input: Value,
    pub exchange: Value,
    pub result: Value,
}

impl Recorded {
    /// The POSTs the provider made to `path_part`, in order (token grants and catalog reads excluded by the filter).
    pub fn posts(&self, path_part: &str) -> Vec<&Value> {
        self.exchange["records"]
            .as_array()
            .expect("records")
            .iter()
            .filter(|r| r["method"] == "POST" && r["path"].as_str().is_some_and(|p| p.contains(path_part)))
            .collect()
    }
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/provider-wire")
}

#[allow(clippy::disallowed_methods, reason = "test-only read of checked-in fixture files")]
pub(crate) fn load(group: &str, scenario: &str) -> Recorded {
    let dir = root().join(group).join(scenario);
    let read = |file: &str| -> Value {
        serde_json::from_slice(&std::fs::read(dir.join(file)).unwrap_or_else(|e| panic!("{group}/{scenario}/{file}: {e}")))
            .expect("json")
    };
    Recorded { input: read("input.json"), exchange: read("exchange.json"), result: read("result.json") }
}

/// The recorded scenario names of `group`, in directory order.
#[allow(clippy::disallowed_methods, reason = "test-only listing of checked-in fixture files")]
pub(crate) fn scenarios(group: &str) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root().join(group))
        .expect("group dir")
        .map(|entry| entry.expect("entry").file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// Node's provider name of a replay envelope as the Rust owner of the same provider.
fn owner_of(node: &str) -> ProviderId {
    ProviderId::from(match node {
        "antigravity" => "antigravity-oauth",
        other => other,
    })
}

/// The inverse of [`owner_of`]: the Rust owner of an envelope as Node's provider name.
fn node_tag(owner: &ProviderId) -> String {
    match owner.as_str() {
        "antigravity-oauth" => "antigravity".to_owned(),
        other => other.to_owned(),
    }
}

/// A Node transcript message (`{role, content, toolCalls, toolCallId, providerReplay}`) as the neutral message. A Gemini-shaped
/// replay (`items` a parts array, `requestContext.model`) becomes the Google codecs' envelope `{parts, model}`.
pub(crate) fn message(node: &Value) -> Message {
    let role = match node["role"].as_str().expect("role") {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        other => panic!("role {other}"),
    };
    let mut message = Message::new(role, Content::Text(node["content"].as_str().unwrap_or_default().to_owned()));
    message.tool_calls = node["toolCalls"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|call| ToolCall {
            id: call["id"].as_str().unwrap_or_default().to_owned(),
            name: call["name"].as_str().unwrap_or_default().to_owned(),
            arguments: call["arguments"].clone(),
            native_type: None,
        })
        .collect();
    message.tool_call_id = node["toolCallId"].as_str().map(str::to_owned);
    if let Some(replay) = node.get("providerReplay") {
        let mut items = json!({ "parts": replay["items"] });
        if let Some(model) = replay.pointer("/requestContext/model") {
            items["model"] = model.clone();
        }
        message.push_replay(ProviderReplay { owner: owner_of(replay["provider"].as_str().expect("provider")), items });
    }
    message
}

/// A replay envelope as Node's result carries it (`createProviderReplay`): the Google codecs' `{parts, model}` is
/// Node's parts list with the model under `requestContext` (the inverse of [`message`]).
fn node_replay(replay: &ProviderReplay) -> Value {
    let mut out = Map::new();
    out.insert("version".into(), json!(1));
    out.insert("provider".into(), json!(node_tag(&replay.owner)));
    match replay.items.get("parts") {
        Some(parts) => {
            out.insert("items".into(), parts.clone());
            if let Some(model) = replay.items.get("model") {
                out.insert("requestContext".into(), json!({ "model": model }));
            }
        }
        None => {
            out.insert("items".into(), replay.items.clone());
        }
    }
    Value::Object(out)
}

/// A stop reason as the provider spelled it (Node `stopReason`).
fn stop_text(stop: &StopReason) -> String {
    match stop {
        StopReason::EndTurn => "end_turn".into(),
        StopReason::ToolUse => "tool_use".into(),
        StopReason::MaxTokens => "max_tokens".into(),
        StopReason::StopSequence => "stop_sequence".into(),
        StopReason::ContentFilter => "content_filter".into(),
        StopReason::Refusal => "refusal".into(),
        StopReason::ContinueTurn => "end_turn_false".into(),
        StopReason::Other(value) => value.clone(),
    }
}

/// A provider state with each slot's `updatedAt` (the wall clock at the send's end) left out.
fn without_clock(mut state: Value) -> Value {
    for slot in state.as_object_mut().into_iter().flat_map(|m| m.values_mut()) {
        if let Some(slot) = slot.as_object_mut() {
            slot.shift_remove("updatedAt");
        }
    }
    state
}

fn call_json(call: &ToolCall) -> Value {
    json!({ "id": call.id, "name": call.name, "arguments": call.arguments })
}

/// Node's whole recorded result (`ok` and the calls dispatched live), with only the fields no core event carries left
/// out; each is one of the manifest's exclusions:
/// - `generationMs`: the answering stream's generation window, a wall-clock reading (as the ledger's `ttftMs`);
/// - `hasThinkingContent`, `contentBlockTypes`: Anthropic's stream summary for the empty-turn trace
///   (ask-turn-commit.mjs:65-66); the events compared carry the blocks themselves;
/// - `assistantBlocks`: Anthropic's block list, which Node also returns as `providerReplay.items`
///   (turn-outcome.mjs:156-157): checked equal to it here, and the replay is compared;
/// - `requestServiceTier`: stamped on the result by the accounting (`record`, usage-accounting.mjs:107), compared in
///   the ledger row;
/// - `responseId`: the Responses id, read by the ledger and the WebSocket chain, carried by no event of an HTTP send;
/// - `usage.promptTokens`, `usage.totalTokens`: sums of the compared counts (`raw` keeps the provider's own);
/// - `usage.serverToolUse`: Anthropic's copy of `raw.server_tool_use` (compared in `raw`), which no Node code reads;
/// - `providerState.<slot>.updatedAt`: the wall clock at the send's end, on both sides;
/// - `stopReason: null` reads as no stop reason, and an absent `usage.cacheWriteTokens` as 0 (Node's readers use
///   `|| 0`).
pub(crate) fn node_result(result: &Value) -> Value {
    let mut ok = result.get("ok").unwrap_or_else(|| panic!("Node's send failed: {}", result["error"])).clone();
    let map = ok.as_object_mut().expect("ok");
    if let Some(blocks) = map.shift_remove("assistantBlocks") {
        assert_eq!(Some(&blocks), map.get("providerReplay").and_then(|r| r.get("items")), "Node returns its blocks twice");
    }
    for key in ["generationMs", "hasThinkingContent", "contentBlockTypes", "requestServiceTier", "responseId"] {
        map.shift_remove(key);
    }
    if map.get("stopReason").is_some_and(Value::is_null) {
        map.shift_remove("stopReason");
    }
    if let Some(state) = map.shift_remove("providerState") {
        map.insert("providerState".into(), without_clock(state));
    }
    if let Some(usage) = map.get_mut("usage").and_then(Value::as_object_mut) {
        usage.shift_remove("promptTokens");
        usage.shift_remove("totalTokens");
        usage.shift_remove("serverToolUse");
        usage.entry("cacheWriteTokens").or_insert(json!(0));
    }
    json!({ "ok": ok, "dispatchedToolCalls": result["dispatchedToolCalls"] })
}

/// A codec's decoded events in Node's result shape, every event accounted for in order: the text (`FinalContent`
/// replaces it), the model (`ServedModel`, else `requested`), the stop reason, pricing model, usage, replay envelope,
/// provider state and metadata, the citations and search calls in the order they came, the returned and the live
/// calls. A provider-native block other than a search call is one of the replay's blocks (checked here); the live
/// progress events (`ItemStart`, `Progress`, `ChunkProgress`, the tool-call start and argument deltas, keepalives,
/// reasoning deltas) are Node's stream callbacks, which its result does not keep.
pub(crate) fn core_result(events: &[StreamEvent], requested: &str) -> Value {
    let mut ok = Map::new();
    let mut content = String::new();
    let mut model = requested.to_owned();
    let mut replays = Vec::new();
    let mut citations = Vec::new();
    let mut searches = Vec::new();
    let mut natives = Vec::new();
    let mut dispatched = Vec::new();
    let mut completed = 0;
    for event in events {
        match event {
            StreamEvent::TextDelta(text) => content.push_str(text),
            StreamEvent::FinalContent(text) => content.clone_from(text),
            StreamEvent::ServedModel(served) => model.clone_from(served),
            StreamEvent::ReasoningReplay(replay) => replays.push(node_replay(replay)),
            StreamEvent::Citation(citation) => citations.push(citation.clone()),
            StreamEvent::ServerToolBlock(block) if block["type"] == "web_search_call" => {
                let mut call = block.clone();
                call.as_object_mut().expect("block").shift_remove("type");
                searches.push(call);
            }
            StreamEvent::ServerToolBlock(block) => natives.push(block.clone()),
            StreamEvent::ToolCallDone(call) => dispatched.push(call_json(call)),
            StreamEvent::ReturnedCalls(calls) => {
                ok.insert("toolCalls".into(), Value::Array(calls.iter().map(call_json).collect()));
            }
            StreamEvent::ThinkingBlocks(blocks) => {
                ok.insert("thinkingBlocks".into(), blocks.clone());
            }
            StreamEvent::ProviderState(state) => {
                ok.insert("providerState".into(), without_clock(state.to_json()));
            }
            StreamEvent::ProviderMetadata(metadata) => {
                ok.insert("providerMetadata".into(), metadata.clone());
            }
            StreamEvent::Usage(usage) => {
                let mut out = Map::new();
                out.insert("inputTokens".into(), json!(usage.input_tokens));
                out.insert("outputTokens".into(), json!(usage.output_tokens));
                out.insert("cachedTokens".into(), json!(usage.cache_read_tokens));
                out.insert("cacheWriteTokens".into(), json!(usage.cache_write_tokens));
                if usage.cache_write_1h_tokens > 0 {
                    out.insert("cacheWrite1hTokens".into(), json!(usage.cache_write_1h_tokens));
                }
                if let Some(UsdTicks(ticks)) = usage.cost {
                    out.insert("costUsd".into(), json!(ticks as f64 / UsdTicks::PER_USD as f64));
                }
                if let Some(raw) = &usage.raw {
                    out.insert("raw".into(), raw.clone());
                }
                ok.insert("usage".into(), Value::Object(out));
            }
            StreamEvent::Completed { stop, pricing_model, .. } => {
                completed += 1;
                if let Some(stop) = stop {
                    ok.insert("stopReason".into(), json!(stop_text(stop)));
                }
                if let Some(pricing) = pricing_model {
                    ok.insert("pricingModel".into(), json!(pricing));
                }
            }
            StreamEvent::Refusal(_) | StreamEvent::Notice { .. } => panic!("no recording has {event:?}"),
            StreamEvent::ItemStart { .. }
            | StreamEvent::ToolCallStart { .. }
            | StreamEvent::ToolCallArgsDelta { .. }
            | StreamEvent::ReasoningDelta(_)
            | StreamEvent::ProviderKeepalive
            | StreamEvent::Progress(_)
            | StreamEvent::ChunkProgress(_) => {}
        }
    }
    assert_eq!(completed, 1, "one terminal event, last: {events:?}");
    assert!(matches!(events.last(), Some(StreamEvent::Completed { .. })), "the terminal event is last");
    assert!(replays.len() <= 1, "one replay envelope: {replays:?}");
    if let Some(replay) = replays.pop() {
        let items: Vec<Value> = replay["items"].as_array().cloned().unwrap_or_default();
        let native: Vec<Value> = items.into_iter().filter(|item| natives.contains(item)).collect();
        assert_eq!(native, natives, "the native blocks are the replay's, in order");
        ok.insert("providerReplay".into(), replay);
    } else {
        assert!(natives.is_empty(), "native blocks with no replay: {natives:?}");
    }
    ok.insert("content".into(), json!(content));
    ok.insert("model".into(), json!(model));
    if !citations.is_empty() {
        ok.insert("citations".into(), Value::Array(citations));
    }
    if !searches.is_empty() {
        ok.insert("webSearchCalls".into(), Value::Array(searches));
    }
    json!({ "ok": ok, "dispatchedToolCalls": dispatched })
}

/// The JSON pointers at which `core` and `node` differ, each with both values.
fn differences(path: &str, core: &Value, node: &Value, out: &mut Vec<String>) {
    match (core, node) {
        (Value::Object(a), Value::Object(b)) => {
            for key in a.keys().chain(b.keys().filter(|k| !a.contains_key(*k))) {
                let at = format!("{path}/{key}");
                match (a.get(key), b.get(key)) {
                    (Some(x), Some(y)) => differences(&at, x, y, out),
                    (x, y) => out.push(format!("{at}: core {x:?}, Node {y:?}")),
                }
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                differences(&format!("{path}/{i}"), x, y, out);
            }
        }
        (a, b) if a != b => out.push(format!("{path}: core {a}, Node {b}")),
        _ => {}
    }
}

/// The whole-result comparison of `name`: every difference is named by its JSON pointer.
pub(crate) fn assert_same_result(core: &Value, node: &Value, name: &str) {
    let mut out = Vec::new();
    differences("", core, node, &mut out);
    assert!(out.is_empty(), "{name}: the result differs from Node's\n{}", out.join("\n"));
}

pub(crate) fn tools(node: &Value) -> Vec<ToolDefinition> {
    node.as_array()
        .into_iter()
        .flatten()
        .map(|tool| ToolDefinition {
            name: tool["name"].as_str().expect("name").to_owned(),
            description: tool["description"].as_str().unwrap_or_default().to_owned(),
            input_schema: tool["inputSchema"].clone(),
            defer_loading: false,
            freeform: None,
        })
        .collect()
}
