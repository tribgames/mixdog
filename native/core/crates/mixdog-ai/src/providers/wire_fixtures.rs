//! The Node recordings of `fixtures/provider-wire` (`benchmarks/rust-core/recorders/record-provider-wire.mjs`): each
//! scenario's Node send arguments (`input.json`), the exchange the loopback hub recorded (`exchange.json`) and Node's
//! result (`result.json`), with the reading of Node's transcript messages into the neutral ones and the whole-result
//! comparison: every event a codec decodes is rendered in Node's result shape ([`core_result`]) and compared with
//! Node's whole result ([`node_result`]), which leaves out only the fields the manifest's exclusions name.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ItemKind;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::Phase;
use mixdog_core_api::domain::provider::WireRequest;
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

fn call_json(call: &ToolCall) -> Value {
    json!({ "id": call.id, "name": call.name, "arguments": call.arguments })
}

/// Node's whole recorded result (`ok` and the calls dispatched live), with only the fields the core has no counterpart
/// of left out, each declared in the manifest's exclusions (`fixtures/provider-wire/MANIFEST.json`):
/// - `assistantBlocks`: Anthropic's block list, which Node also returns as `providerReplay.items`
///   (turn-outcome.mjs:156-157): checked equal to it here, and the replay is compared;
/// - `requestServiceTier`: stamped on the result object by Node's accounting (usage-accounting.mjs:98); the core's
///   accounting keeps it in the ledger row, compared where the scenario is accounted;
/// - `usage.promptTokens`, `usage.totalTokens`: Node's sums of the compared counts (`raw` keeps the provider's own);
/// - `usage.serverToolUse`: Anthropic's copy of `raw.server_tool_use` (compared in `raw`), which no Node code reads;
/// - `stopReason: null` reads as no stop reason, and an absent `usage.cacheWriteTokens` as 0 (Node's readers use
///   `|| 0`).
pub(crate) fn node_result(result: &Value) -> Value {
    let mut ok = result.get("ok").unwrap_or_else(|| panic!("Node's send failed: {}", result["error"])).clone();
    let map = ok.as_object_mut().expect("ok");
    if let Some(blocks) = map.shift_remove("assistantBlocks") {
        assert_eq!(Some(&blocks), map.get("providerReplay").and_then(|r| r.get("items")), "Node returns its blocks twice");
    }
    map.shift_remove("requestServiceTier");
    if map.get("stopReason").is_some_and(Value::is_null) {
        map.shift_remove("stopReason");
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
/// events (`ItemStart`, `Progress`, `ChunkProgress`, notices, the deltas) are Node's stream callbacks, which its result
/// does not keep: [`core_events`] compares them with the callbacks Node made, in order.
pub(crate) fn core_result(events: &[StreamEvent], requested: &str) -> Value {
    core_result_at(events, &vec![START; events.len()], requested)
}

/// [`core_result`] of events each stamped with the virtual clock's time when the stream yielded it: the generation
/// window (Node `generationMs`) runs from the output's start ([`StreamEvent::OutputStarted`]) to the terminal event.
pub(crate) fn core_result_at(events: &[StreamEvent], at: &[i64], requested: &str) -> Value {
    assert_eq!(events.len(), at.len(), "one time per event");
    let mut output_at = None;
    let mut ok = Map::new();
    let mut content = String::new();
    let mut model = requested.to_owned();
    let mut replays = Vec::new();
    let mut citations = Vec::new();
    let mut searches = Vec::new();
    let mut natives = Vec::new();
    let mut dispatched = Vec::new();
    let mut completed = 0;
    for (event, at) in events.iter().zip(at) {
        match event {
            StreamEvent::OutputStarted => {
                assert!(output_at.is_none(), "one output start: {events:?}");
                output_at = Some(*at);
            }
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
                ok.insert("providerState".into(), state.to_json());
            }
            StreamEvent::ProviderMetadata(metadata) => {
                ok.insert("providerMetadata".into(), metadata.clone());
            }
            StreamEvent::ResponseId(id) => {
                ok.insert("responseId".into(), json!(id));
            }
            StreamEvent::ContentSummary { has_thinking, block_types } => {
                ok.insert("hasThinkingContent".into(), json!(has_thinking));
                ok.insert("contentBlockTypes".into(), json!(block_types));
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
                if let Some(started) = output_at {
                    ok.insert("generationMs".into(), json!(at - started));
                }
                if let Some(stop) = stop {
                    ok.insert("stopReason".into(), json!(stop_text(stop)));
                }
                if let Some(pricing) = pricing_model {
                    ok.insert("pricingModel".into(), json!(pricing));
                }
            }
            // Account pools and gateway reroutes are outside the provider-wire sends (registry::gateway_replay).
            StreamEvent::Refusal(_)
            | StreamEvent::AccountRouting(_)
            | StreamEvent::AccountStage(_)
            | StreamEvent::WireRerouted(_) => panic!("no recording has {event:?}"),
            StreamEvent::Notice { .. }
            | StreamEvent::ItemStart { .. }
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
    // A provider state's `updatedAt` is the wall clock when the state was taken (the recorder pins Node's `Date.now`
    // to its START, the core reads the system clock): compared for presence, declared in the manifest.
    let stamped = |value: &Value| {
        let mut value = value.clone();
        if let Some(states) = value.pointer_mut("/ok/providerState").and_then(Value::as_object_mut) {
            for state in states.values_mut().filter_map(Value::as_object_mut) {
                if let Some(at) = state.get_mut("updatedAt") {
                    assert!(at.is_u64(), "{name}: updatedAt is a time: {at}");
                    *at = json!("<wall clock>");
                }
            }
        }
        value
    };
    let (core, node) = (&stamped(core), &stamped(node));
    let mut out = Vec::new();
    differences("", core, node, &mut out);
    assert!(out.is_empty(), "{name}: the result differs from Node's\n{}", out.join("\n"));
}

fn stream_delta(kind: &str) -> Value {
    json!({ "on": "streamDelta", "kind": kind })
}

/// The callbacks Node made during the send (`result.json` `events`), as the core's events make them: the callbacks the
/// caller passed (`input.json` `callbacks`) and nothing else, in order. A text or reasoning delta also reports its kind
/// (`onStreamDelta('text')`) unless the stream announced its chunks ([`StreamEvent::progress_kinds`]); a chunk's kind is
/// `ChunkProgress` and a semantic step `Progress`; a dispatched call is `onToolCall`, a notice `onStageChange('notice')`.
pub(crate) fn core_events(events: &[StreamEvent], callbacks: &Value) -> Vec<Value> {
    let passed = |name: &str| callbacks.as_array().expect("callbacks").iter().any(|c| c == name);
    let mut out = Vec::new();
    let mut chunked = false;
    for event in events {
        match event {
            StreamEvent::ChunkProgress(kind) => {
                chunked = true;
                if let Some(kind) = kind {
                    out.push(stream_delta(kind.name()));
                }
            }
            StreamEvent::Progress(kind) => out.push(stream_delta(kind.name())),
            StreamEvent::ProviderKeepalive => out.push(stream_delta("keepalive")),
            StreamEvent::TextDelta(text) => {
                if passed("onTextDelta") {
                    out.push(json!({ "on": "textDelta", "text": text }));
                }
                if !chunked {
                    out.push(stream_delta("text"));
                }
            }
            StreamEvent::ReasoningDelta(text) => {
                if passed("onReasoningDelta") {
                    out.push(json!({ "on": "reasoningDelta", "text": text }));
                }
                if !chunked {
                    out.push(stream_delta("reasoning"));
                }
            }
            StreamEvent::ToolCallDone(call) => {
                out.push(json!({ "on": "toolCall", "id": call.id, "name": call.name, "arguments": call.arguments }));
            }
            // Node reports a started item only for a client tool call or a phased message (`reportStreamItemStart`,
            // send-callbacks.mjs:20, its callers); the opening of a plain text or reasoning block it does not.
            StreamEvent::ItemStart { kind, phase }
                if passed("onStreamItemStart") && (matches!(kind, ItemKind::Tool) || phase.is_some()) =>
            {
                let mut detail = json!({ "on": "itemStart", "kind": match kind {
                    ItemKind::Text => "text",
                    ItemKind::Reasoning => "reasoning",
                    ItemKind::Tool => "tool",
                } });
                if let Some(phase) = phase {
                    detail["phase"] = json!(match phase {
                        Phase::Commentary => "commentary",
                        Phase::FinalAnswer => "final_answer",
                    });
                }
                out.push(detail);
            }
            StreamEvent::Notice { message, warn } => {
                out.push(json!({ "on": "notice", "tone": if *warn { "warn" } else { "info" }, "message": message }));
            }
            _ => {}
        }
    }
    out
}

/// A callback sequence in the form both sides are compared in (declared in the manifest): `onStreamDelta('transport')`,
/// which Node raises per network read (its count follows the socket's chunking), is left out; and the kind a text or
/// reasoning delta reports, raised by Node right before or right after that delta depending on the path (Anthropic
/// relays it after the text, the compatible streams before), is one with its delta (`reported`).
fn canonical_events(events: &[Value]) -> Vec<Value> {
    let mut list: Vec<Value> = events.iter().filter(|e| !(e["on"] == "streamDelta" && e["kind"] == "transport")).cloned().collect();
    let mut i = 0;
    while i < list.len() {
        let kind = match list[i]["on"].as_str() {
            Some("textDelta") => "text",
            Some("reasoningDelta") => "reasoning",
            _ => {
                i += 1;
                continue;
            }
        };
        let reports = |e: &Value| e["on"] == "streamDelta" && e["kind"] == kind;
        if i > 0 && reports(&list[i - 1]) {
            list.remove(i - 1);
            i -= 1;
            list[i]["reported"] = json!(true);
        } else if i + 1 < list.len() && reports(&list[i + 1]) {
            list.remove(i + 1);
            list[i]["reported"] = json!(true);
        }
        i += 1;
    }
    list
}

/// The callbacks the core's events make equal Node's, in recorded order.
pub(crate) fn assert_same_events(events: &[StreamEvent], recorded: &Recorded, name: &str) {
    let core = canonical_events(&core_events(events, &recorded.input["callbacks"]));
    let node = canonical_events(recorded.result["events"].as_array().expect("events"));
    assert_eq!(Value::Array(core), Value::Array(node), "{name}: the stream callbacks differ from Node's");
}

/// Header values that cannot be equal, each declared in the manifest: their place in the head is compared, not their
/// value. `x-grok-req-id` is a `randomUUID()` per request.
const UNEQUAL_HEADERS: [&str; 1] = ["x-grok-req-id"];

/// The Node runtime the recorder ran under (the manifest's `nodeVersion`).
#[allow(clippy::disallowed_methods, reason = "test-only read of the checked-in manifest")]
fn recorder_node() -> String {
    let manifest: Value = serde_json::from_slice(&std::fs::read(root().join("MANIFEST.json")).expect("manifest")).expect("json");
    manifest["nodeVersion"].as_str().expect("nodeVersion").to_owned()
}

/// The SDK's `x-stainless-runtime-version` names the Node that runs the client: the recorder's on Node's side (checked
/// equal to the manifest's `nodeVersion`), the product's own runtime on the core's (`grok::SDK_RUNTIME_VERSION`, the
/// desktop's Electron); each is checked to be its runtime, declared in the manifest.
fn runtime_named(head: Vec<(String, String)>, runtime: &str, name: &str) -> Vec<(String, String)> {
    head.into_iter()
        .map(|(n, v)| {
            if n == "x-stainless-runtime-version" {
                assert_eq!(v, runtime, "{name}: the SDK names its runtime");
                return (n, "<the client's Node runtime>".to_owned());
            }
            (n, v)
        })
        .collect()
}

/// The recorder's normalization of a header (`lib/headers.mjs` `cleanHeaders`), applied to the core's head as to
/// Node's: a credential's value is its scheme word only, and a request id drawn per request is its shape.
fn clean_header(name: &str, value: &str) -> String {
    let lower = name.to_ascii_lowercase();
    let credential = matches!(
        lower.as_str(),
        "authorization" | "proxy-authorization" | "cookie" | "set-cookie" | "x-api-key" | "api-key" | "x-goog-api-key"
    ) || ["token", "secret", "password", "credential"].iter().any(|word| lower.contains(word));
    if credential {
        let scheme = ["Bearer", "Basic", "Digest", "Token"].into_iter().find(|scheme| {
            value.len() > scheme.len() + 1
                && value[..scheme.len()].eq_ignore_ascii_case(scheme)
                && value[scheme.len()..].starts_with(char::is_whitespace)
                && !value[scheme.len()..].trim_start().is_empty()
        });
        return match scheme {
            Some(_) => format!("{} <redacted>", &value[..value.find(char::is_whitespace).unwrap_or(0)]),
            None => "<redacted>".to_owned(),
        };
    }
    let random_id = ["request", "trace", "span", "correlation", "client"]
        .iter()
        .any(|word| lower.ends_with(&format!("{word}-id")) || lower.ends_with(&format!("{word}id")));
    let hex = |s: &str| s.chars().all(|c| c.is_ascii_hexdigit());
    if random_id && value.len() == 32 && hex(value) {
        return "<random:hex32>".to_owned();
    }
    let groups: Vec<&str> = value.split('-').collect();
    if random_id && groups.iter().map(|g| g.len()).eq([8, 4, 4, 4, 12]) && groups.iter().all(|g| hex(g)) {
        return "<random:uuid>".to_owned();
    }
    value.to_owned()
}

/// The head the core's transport writes for `wire` (`node_http::head`, as Node's `fetch` writes it) on the recorder's
/// loopback socket, an `http:` one (so `fetch` offers that scheme's encodings): every header in order, the name as the
/// hub records it (lower case), the value cleaned as the recorder cleans it.
fn sent_head(wire: &WireRequest) -> Vec<(String, String)> {
    let mut url = url::Url::parse(&wire.url).expect("url");
    url.set_scheme("http").expect("an http(s) url");
    let (head, _) = crate::transport::node_http::head(wire, &url, crate::transport::node_http::Writer::Fetch);
    let text: String = head.iter().map(|b| *b as char).collect();
    text.split("\r\n")
        .skip(1)
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (name, value) = line.split_once(": ").expect("a header line");
            (name.to_ascii_lowercase(), clean_header(name, value))
        })
        .collect()
}

fn recorded_head(record: &Value) -> Vec<(String, String)> {
    record["rawHeaderOrder"]
        .as_array()
        .expect("rawHeaderOrder")
        .iter()
        .map(|name| {
            let name = name.as_str().expect("name");
            (name.to_owned(), record["headers"][name].as_str().expect("a header value").to_owned())
        })
        .collect()
}

/// One request compared whole with Node's: the method, the URL, every header in order (only the values of
/// [`UNEQUAL_HEADERS`] aside), and the body's bytes (with `drawn`, the top-level body fields drawn per send, compared
/// for presence only).
pub(crate) fn assert_same_request(sent: &WireRequest, record: &Value, drawn: &[&str], name: &str) {
    assert_eq!(sent.method, record["method"].as_str().expect("method"), "{name}: method");
    assert_eq!(sent.url, format!("{}{}", record["origin"].as_str().expect("origin"), record["path"].as_str().expect("path")), "{name}: url");
    let unequal = |(n, v): (String, String)| if UNEQUAL_HEADERS.contains(&n.as_str()) { (n, "<not compared>".to_owned()) } else { (n, v) };
    let core: Vec<_> = runtime_named(sent_head(sent), crate::providers::grok::SDK_RUNTIME_VERSION, name).into_iter().map(unequal).collect();
    let node: Vec<_> = runtime_named(recorded_head(record), &recorder_node(), name).into_iter().map(unequal).collect();
    assert_eq!(core, node, "{name}: headers");
    let body = String::from_utf8(sent.body.clone()).expect("a text body");
    let node_body = record["bodyText"].as_str().unwrap_or_default();
    if drawn.is_empty() {
        assert_eq!(body, node_body, "{name}: body bytes");
    } else {
        let without = |text: &str| {
            let mut value: Value = serde_json::from_str(text).expect("a JSON body");
            for key in drawn {
                assert!(value.as_object_mut().expect("an object body").shift_remove(*key).is_some(), "{name}: the body has no {key}");
            }
            value
        };
        assert_eq!(without(&body), without(node_body), "{name}: body");
    }
}

/// The requests compared, declared in the manifest: the reads a provider makes beside its send (catalog listings,
/// client-version lookups, price tables: every `GET` of these recordings) are left out on both sides, the core's catalog
/// and client-version services making them outside the send.
fn sent_by_the_send(method: &str) -> bool {
    method != "GET"
}

/// Every request the core sent, compared whole and in order with the ones Node's send made.
pub(crate) fn assert_same_requests(sent: &[WireRequest], recorded: &Recorded, drawn: &[&str], name: &str) {
    let sent: Vec<&WireRequest> = sent.iter().filter(|r| sent_by_the_send(&r.method)).collect();
    let node: Vec<&Value> =
        recorded.exchange["records"].as_array().expect("records").iter().filter(|r| sent_by_the_send(r["method"].as_str().unwrap_or_default())).collect();
    assert_eq!(sent.len(), node.len(), "{name}: requests: core {:?}", sent.iter().map(|r| format!("{} {}", r.method, r.url)).collect::<Vec<_>>());
    for (i, (got, want)) in sent.iter().zip(node).enumerate() {
        assert_same_request(got, want, drawn, &format!("{name} #{i}"));
    }
}

/// The bearer a request carries is the token the last token grant before it answered (the recorder redacts credential
/// values: a minted token is checked against the grant's recorded answer instead).
pub(crate) fn assert_minted_bearer(sent: &[WireRequest], recorded: &Recorded, name: &str) {
    let node = recorded.exchange["records"].as_array().expect("records").iter().filter(|r| sent_by_the_send(r["method"].as_str().unwrap_or_default()));
    let mut minted: Option<String> = None;
    for (i, (request, record)) in sent.iter().filter(|r| sent_by_the_send(&r.method)).zip(node).enumerate() {
        let bearer = request.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case("authorization")).map(|(_, v)| v.clone());
        if request.url.ends_with("/token") {
            assert_eq!(bearer, None, "{name} #{i}: a token grant carries no bearer");
            let answer: Value = serde_json::from_str(record["served"].as_str().expect("served")).expect("a token answer");
            minted = Some(answer["access_token"].as_str().expect("access_token").to_owned());
            continue;
        }
        let token = minted.clone().unwrap_or_else(|| panic!("{name} #{i}: a request before any token grant"));
        assert_eq!(bearer, Some(format!("Bearer {token}")), "{name} #{i}: the bearer is the last minted token");
    }
}

/// The recorder's hub: each request is answered with the recorded answer to the first unanswered record of the same
/// method and URL (`served`), with the status the scenario's script gave it (200 unless `refuse` names the n-th such
/// request), and kept. (A held answer, whose connection's end is the point, is served by the product's own client over
/// a loopback socket instead: `google::vertex_claude_cancel_wire_tests`.)
///
/// The hub keeps the recorder's virtual clock: it stands at [`START`] and moves only where a timed answer (`timed`) steps
/// it, by each part's `advanceMs` as the client reads that part, as Node's endpoint stepped it.
pub(crate) struct Hub {
    records: Mutex<Vec<Option<Value>>>,
    refusals: Mutex<Vec<(String, u16, Vec<(String, String)>)>>,
    pub sent: Mutex<Vec<WireRequest>>,
    clock: Arc<std::sync::atomic::AtomicI64>,
}

/// The recorder's `START`: every wall-clock read of a scenario reads it until a timed answer steps the clock.
pub(crate) const START: i64 = 1_700_000_000_000;

impl Hub {
    pub fn new(recorded: &Recorded) -> Arc<Self> {
        Arc::new(Self {
            records: Mutex::new(recorded.exchange["records"].as_array().expect("records").iter().cloned().map(Some).collect()),
            refusals: Mutex::default(),
            sent: Mutex::default(),
            clock: Arc::new(std::sync::atomic::AtomicI64::new(START)),
        })
    }

    /// The virtual clock's time, in Unix milliseconds.
    pub fn now(&self) -> i64 {
        self.clock.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// A reader of the virtual clock, for the accounting's `now`.
    pub fn clock(&self) -> Arc<dyn Fn() -> i64 + Send + Sync> {
        let clock = Arc::clone(&self.clock);
        Arc::new(move || clock.load(std::sync::atomic::Ordering::SeqCst))
    }

    /// The first request whose path ends with `path_end` is answered with `status` and `headers` (the scenario's script).
    pub fn refuse_first(self: Arc<Self>, path_end: &str, status: u16, headers: Vec<(String, String)>) -> Arc<Self> {
        self.refusals.lock().unwrap().push((path_end.to_owned(), status, headers));
        self
    }

    pub fn sent(&self) -> Vec<WireRequest> {
        self.sent.lock().unwrap().clone()
    }
}

struct Served(Option<bytes::Bytes>);

#[async_trait::async_trait]
impl crate::transport::BodyStream for Served {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// A timed answer: each part read steps the virtual clock by its `advanceMs` first.
struct Timed {
    parts: std::collections::VecDeque<(i64, bytes::Bytes)>,
    clock: Arc<std::sync::atomic::AtomicI64>,
}

#[async_trait::async_trait]
impl crate::transport::BodyStream for Timed {
    async fn next(&mut self) -> Option<Result<bytes::Bytes, mixdog_core_api::domain::provider::TransportFault>> {
        let (advance, part) = self.parts.pop_front()?;
        self.clock.fetch_add(advance, std::sync::atomic::Ordering::SeqCst);
        Some(Ok(part))
    }
}

#[async_trait::async_trait]
impl crate::transport::HttpSend for Hub {
    async fn send(
        &self,
        request: WireRequest,
        _: crate::transport::Exchange,
    ) -> Result<crate::transport::HttpResponse, mixdog_core_api::domain::provider::ProviderError> {
        // The socket warm-up (`preconnect`, http-agent.mjs:496-527) is a raw `undici.request`, which the recorder's hub
        // (a `fetch` redirect) never sees: answered, and not one of the send's requests (declared in the manifest).
        if request.method == "HEAD" {
            return Ok(crate::transport::HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Served(None)) });
        }
        let record = {
            let mut records = self.records.lock().unwrap();
            let at = records
                .iter()
                .position(|r| {
                    r.as_ref().is_some_and(|r| {
                        r["method"] == request.method.as_str()
                            && request.url == format!("{}{}", r["origin"].as_str().unwrap_or_default(), r["path"].as_str().unwrap_or_default())
                    })
                })
                .unwrap_or_else(|| panic!("Node made no request {} {}", request.method, request.url));
            records[at].take().expect("record")
        };
        let path = record["path"].as_str().unwrap_or_default().to_owned();
        self.sent.lock().unwrap().push(request);
        let body = bytes::Bytes::from(record["served"].as_str().unwrap_or_default().to_owned());
        let (status, headers) = {
            let mut refusals = self.refusals.lock().unwrap();
            match refusals.iter().position(|(end, _, _)| path.ends_with(end.as_str())) {
                Some(at) => {
                    let (_, status, headers) = refusals.remove(at);
                    (status, headers)
                }
                None => (200, Vec::new()),
            }
        };
        if let Some(parts) = record["timed"].as_array() {
            let parts = parts
                .iter()
                .map(|p| (p["advanceMs"].as_i64().expect("advanceMs"), bytes::Bytes::from(p["body"].as_str().expect("body").to_owned())))
                .collect();
            return Ok(crate::transport::HttpResponse { status, headers, body: Box::new(Timed { parts, clock: Arc::clone(&self.clock) }) });
        }
        Ok(crate::transport::HttpResponse { status, headers, body: Box::new(Served(Some(body))) })
    }
}

/// What the recorder's provider read beside its configuration: the Anthropic catalog's capabilities, the Google model
/// traits, the OpenAI model facts, and the machine's Codex identity (declared in the manifest).
pub(crate) struct Inputs {
    pub caps: crate::providers::anthropic::CapsLookup,
    pub traits: Arc<dyn crate::providers::google::traits::ModelTraits>,
    pub facts: Arc<dyn crate::providers::openai::config::ModelFactsSource>,
    pub codex: crate::providers::openai::config::CodexIdentity,
}

impl Default for Inputs {
    fn default() -> Self {
        Self {
            caps: Arc::new(|_| None),
            traits: Arc::new(crate::providers::google::traits::CatalogGoogleTraits(Vec::new())),
            facts: Arc::new(crate::providers::openai::config::NoFacts),
            codex: crate::providers::openai::config::CodexIdentity {
                installation_id: String::new(),
                user_agent: String::new().into(),
                version: String::new().into(),
                beta_features: String::new(),
            },
        }
    }
}

struct ScenarioEnv(std::collections::HashMap<String, String>);

impl crate::registry::keys::Environment for ScenarioEnv {
    fn var(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

/// The provider the recorder built (`input.json` `provider`, `config`, `credential`), built by the production builder
/// (`DefaultProviderBuilder::build`) over the hub, in a data directory holding the recorded credential file and with the
/// recorder's environment (`MIXDOG_OAI_TRANSPORT=http`; gcloud's login named by `GOOGLE_APPLICATION_CREDENTIALS`).
pub(crate) async fn built(
    recorded: &Recorded,
    hub: Arc<Hub>,
    inputs: Inputs,
) -> (Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, tempfile::TempDir) {
    built_on(recorded, hub, inputs).await
}

/// [`built`] over any HTTP seam: the product's own client pinned to a loopback endpoint, where a replay needs the socket.
pub(crate) async fn built_on(
    recorded: &Recorded,
    hub: Arc<dyn crate::transport::HttpSend>,
    inputs: Inputs,
) -> (Arc<dyn mixdog_core_api::domain::provider::ProviderAdapter>, tempfile::TempDir) {
    use crate::registry::builder::BuilderEnv;
    use crate::registry::builder::DefaultProviderBuilder;
    use crate::registry::providers::ProviderBuilder;
    let dir = tempfile::tempdir().expect("tempdir");
    let input = &recorded.input;
    let mut env = std::collections::HashMap::from([("MIXDOG_OAI_TRANSPORT".to_owned(), "http".to_owned())]);
    if let Some(credential) = input.get("credential") {
        let path = dir.path().join(credential["file"].as_str().expect("file"));
        #[allow(clippy::disallowed_methods, reason = "test-only write of the recorded credential file")]
        std::fs::write(&path, serde_json::to_vec(&credential["document"]).expect("json")).expect("credential file");
        if credential["file"] == "adc.json" {
            env.insert("GOOGLE_APPLICATION_CREDENTIALS".to_owned(), path.display().to_string());
        }
    }
    let env: Arc<dyn crate::registry::keys::Environment> = Arc::new(ScenarioEnv(env));
    let tokens = mixdog_rt::testing::tokens();
    let io = crate::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let link = Arc::new(crate::transport::ReqwestLink::new(&crate::transport::KeepaliveSchedule::SPEC, false).expect("link"));
    let builder = DefaultProviderBuilder::new(BuilderEnv {
        http: hub,
        bidi: link,
        dial: Arc::new(crate::transport::KeepaliveDialer::new(crate::transport::KeepaliveSchedule::SPEC)),
        keys: crate::registry::keys::ApiKeyStore::new(Arc::new(crate::registry::keys::MemoryVault::default()), env.clone(), false),
        accounts: crate::accounts::AccountStore::new(dir.path().to_path_buf(), io.clone()),
        anthropic_caps: inputs.caps,
        google_traits: inputs.traits,
        openai_facts: inputs.facts,
        openai_context: Arc::new(crate::providers::openai::adapter::SessionContext::new()),
        codex_identity: inputs.codex,
        pace: Arc::new(crate::oauth::pace::FakePace::default()),
        gzip_lane: tokens.cpu_bulk,
        // The mixdog build the recorder's tree names (its `package.json` version).
        client_version: input["clientVersion"].as_str().expect("clientVersion").to_owned(),
        client_versions: None,
        grok_client_version: None,
        cursor_client_version: None,
        antigravity_client_version: "2.19.1".into(),
        listing: crate::catalog::ListingLookup::new(),
        env,
        home_dir: dir.path().to_path_buf(),
        io,
        gated_off: Arc::new(|_| false),
    });
    let provider = input["provider"].as_str().expect("provider");
    let name = provider.strip_suffix("-adc").or_else(|| provider.strip_suffix("-express")).unwrap_or(provider);
    let adapter = builder.build(name, &input["config"]).await.unwrap_or_else(|e| panic!("{provider}: {e}"));
    (adapter, dir)
}

/// Every event of one attempt, each with the hub's virtual time when the stream yielded it.
pub(crate) async fn timed_attempt(
    adapter: &dyn mixdog_core_api::domain::provider::ProviderAdapter,
    request: Arc<mixdog_core_api::domain::provider::ModelRequest>,
    hub: &Hub,
) -> Result<(Vec<StreamEvent>, Vec<i64>), mixdog_core_api::domain::provider::ProviderError> {
    let mut stream = adapter.attempt(request).await?;
    let (mut events, mut at) = (Vec::new(), Vec::new());
    while let Some(event) = stream.next().await {
        events.push(event?);
        at.push(hub.now());
    }
    Ok((events, at))
}

/// Every event of one attempt.
pub(crate) async fn attempt(
    adapter: &dyn mixdog_core_api::domain::provider::ProviderAdapter,
    request: Arc<mixdog_core_api::domain::provider::ModelRequest>,
) -> Result<Vec<StreamEvent>, mixdog_core_api::domain::provider::ProviderError> {
    let mut stream = adapter.attempt(request).await?;
    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        events.push(event?);
    }
    Ok(events)
}

/// Node's send arguments as the request the core's loop makes of them: the messages, the tools, and the options Node's
/// send read (`sessionId`, `effort`, `sourceType`).
pub(crate) fn request_of(recorded: &Recorded) -> mixdog_core_api::domain::provider::ModelRequest {
    let input = &recorded.input;
    let opts = &input["opts"];
    mixdog_core_api::domain::provider::ModelRequest {
        model: input["model"].as_str().expect("model").to_owned(),
        messages: input["messages"].as_array().expect("messages").iter().map(message).collect(),
        tools: tools(&input["tools"]),
        options: mixdog_core_api::domain::provider::RequestOptions {
            session_id: opts["sessionId"].as_str().map(str::to_owned),
            effort: opts["effort"].as_str().map(str::to_owned),
            source_type: opts["sourceType"].as_str().map(str::to_owned),
            ..Default::default()
        },
    }
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
