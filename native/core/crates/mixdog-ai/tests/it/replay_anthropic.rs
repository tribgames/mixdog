//! The Anthropic send's outcome in the shape Node's `AnthropicProvider#send` returns it (`anthropic-turn-result.mjs`
//! over `anthropic-sse-turn/turn-outcome.mjs`), built from the core's stream events, and the callbacks the send made
//! (`onToolCall`, `onStreamDelta`), for the group-A Anthropic replays.
//!
//! Every field of Node's result is either built from a core event here, or named in [`NO_CORE_FIELD`] with the reason
//! the core carries no counterpart; [`assert_send`] compares the rest whole and in Node's key order.
#![allow(dead_code, reason = "each Anthropic set uses part of it")]

use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_testkit::Exact;
use serde_json::Value;

use crate::provider_case::assert_exact;
use crate::provider_case::plain;

/// Node result fields the core's events carry no counterpart of. Each is an open core gap reported with the group.
/// - `stopDetails`: `message_delta.delta.stop_details` (+ `category`), returned by Node and read by no Node code
///   (`stopDetails` in src/: only message-events.mjs:8-27, turn-outcome.mjs:141, anthropic-turn-result.mjs:60,
///   anthropic-request-utils.mjs:546 write it);
/// - `hasThinkingContent`, `contentBlockTypes`: the block summary Node's empty-turn trace reads
///   (ask-turn-commit.mjs:65-66) and the fallback check (anthropic-message-threads.mjs:333); the core's events carry
///   the blocks (the replay envelope) but not the delta types.
pub const NO_CORE_FIELD: [&str; 3] = ["stopDetails", "hasThinkingContent", "contentBlockTypes"];

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

fn entry(key: &str, value: Exact) -> (String, Exact) {
    (key.to_owned(), value)
}

fn num(n: u64) -> Exact {
    Exact::Number(n as f64)
}

/// The outcome of one send: Node's `result`, the `onToolCall` calls and the `onStreamDelta` kinds, in order.
pub struct Send {
    pub result: Exact,
    pub tool_calls: Exact,
    pub stream_deltas: Exact,
}

/// The send's outcome from the core's events (one attempt, ending in `Completed`), `requested` the model asked for.
pub fn send(events: &[StreamEvent], requested: &str) -> Send {
    let mut content = String::new();
    let mut model = requested.to_owned();
    let mut calls = Vec::new();
    let mut deltas = Vec::new();
    let mut replay: Option<Value> = None;
    let mut usage = None;
    let mut stop = None;
    let mut output = false;
    for event in events {
        match event {
            StreamEvent::TextDelta(text) => {
                content.push_str(text);
                deltas.push(Exact::String("text".into()));
            }
            StreamEvent::ReasoningDelta(_) => deltas.push(Exact::String("reasoning".into())),
            StreamEvent::Progress(kind) => deltas.push(Exact::String(kind.name().into())),
            StreamEvent::ChunkProgress(Some(kind)) => deltas.push(Exact::String(kind.name().into())),
            StreamEvent::ProviderKeepalive => deltas.push(Exact::String("keepalive".into())),
            StreamEvent::ServedModel(served) => model.clone_from(served),
            StreamEvent::OutputStarted => output = true,
            StreamEvent::ToolCallDone(call) => calls.push(Exact::Object(vec![
                entry("id", Exact::String(call.id.clone())),
                entry("name", Exact::String(call.name.clone())),
                entry("arguments", plain(&call.arguments)),
            ])),
            StreamEvent::ReasoningReplay(envelope) => {
                assert!(replay.is_none(), "one replay envelope: {events:?}");
                replay = Some(envelope.items.clone());
            }
            StreamEvent::Usage(u) => usage = Some(u.clone()),
            StreamEvent::Completed { stop: s, .. } => stop = Some(s.clone()),
            _ => {}
        }
    }
    let stop = stop.unwrap_or_else(|| panic!("the send completed: {events:?}"));
    let usage = usage.unwrap_or_else(|| panic!("the send reported usage: {events:?}"));
    let blocks: Option<Vec<Value>> = replay.map(|items| items.as_array().expect("the replay's blocks").clone());
    let thinking: Option<Vec<Value>> = blocks
        .as_ref()
        .map(|b| b.iter().filter(|block| matches!(block["type"].as_str(), Some("thinking" | "redacted_thinking"))).cloned().collect::<Vec<_>>())
        .filter(|t| !t.is_empty());
    let mut result = vec![
        entry("content", Exact::String(content)),
        entry("model", Exact::String(model)),
        entry("toolCalls", if calls.is_empty() { Exact::Undefined } else { Exact::Array(calls.clone()) }),
        entry("stopReason", stop.as_ref().map_or(Exact::Undefined, |s| Exact::String(stop_text(s)))),
        entry("thinkingBlocks", thinking.map_or(Exact::Undefined, |t| plain(&Value::Array(t)))),
        entry("assistantBlocks", blocks.as_ref().map_or(Exact::Undefined, |b| plain(&Value::Array(b.clone())))),
    ];
    if let Some(blocks) = &blocks {
        result.push(entry(
            "providerReplay",
            Exact::Object(vec![
                entry("version", num(1)),
                entry("provider", Exact::String("anthropic".into())),
                entry("items", plain(&Value::Array(blocks.clone()))),
            ]),
        ));
    }
    if output {
        // The paused clock: the output starts and completes at the same instant.
        result.push(entry("generationMs", num(0)));
    }
    // The core's input is inclusive (fresh + cache read + cache write, Node's `promptTokens`); Node's `inputTokens`
    // is the fresh part.
    let fresh = usage.input_tokens - usage.cache_read_tokens - usage.cache_write_tokens;
    let mut slots = vec![
        entry("inputTokens", num(fresh)),
        entry("outputTokens", num(usage.output_tokens)),
        entry("cachedTokens", num(usage.cache_read_tokens)),
        entry("cacheWriteTokens", num(usage.cache_write_tokens)),
    ];
    if usage.cache_write_1h_tokens > 0 {
        slots.push(entry("cacheWrite1hTokens", num(usage.cache_write_1h_tokens)));
    }
    slots.push(entry("promptTokens", num(usage.input_tokens)));
    if let Some(raw) = &usage.raw {
        slots.push(entry("raw", plain(raw)));
    }
    result.push(entry("usage", Exact::Object(slots)));
    Send { result: Exact::Object(result), tool_calls: Exact::Array(calls), stream_deltas: Exact::Array(deltas) }
}

/// Node's result with the [`NO_CORE_FIELD`] keys taken out.
pub fn comparable(node: &Exact) -> Exact {
    match node {
        Exact::Object(entries) => Exact::Object(entries.iter().filter(|(k, _)| !NO_CORE_FIELD.contains(&k.as_str())).cloned().collect()),
        other => panic!("Node's result is an object: {other:?}"),
    }
}

/// Node's `onStreamDelta` kinds without `transport`, which Node raises once per network read of the body (its count
/// follows the socket's chunking; the core reports no network reads).
pub fn semantic_deltas(node: &Exact) -> Exact {
    Exact::Array(node.as_array().iter().filter(|k| k.as_str() != "transport").cloned().collect())
}

/// The recorder's derived keys (`usageSlots`, the invalid-args markers, `toolCallsIsUndefined`) from `result`.
pub fn derived(key: &str, result: &Exact, tool_calls: &Exact) -> Exact {
    let marker = |calls: &Exact| match calls {
        Exact::Array(list) => list.first().is_some_and(|c| c.get("arguments").try_get("__invalidToolArgs").is_some_and(|m| m == &Exact::Bool(true))),
        _ => false,
    };
    match key {
        "usageSlots" => {
            let usage = result.get("usage");
            Exact::Array(["inputTokens", "outputTokens", "cachedTokens", "cacheWriteTokens", "promptTokens"].iter().map(|k| usage.get(k).clone()).collect())
        }
        "resultMarker" => Exact::Bool(marker(result.get("toolCalls"))),
        "dispatchedMarker" => Exact::Bool(marker(tool_calls)),
        "toolCallsIsUndefined" => Exact::Bool(result.get("toolCalls") == &Exact::Undefined),
        other => panic!("a recorded key this replay does not build: {other}"),
    }
}

/// The recorded `{result, toolCalls, streamDeltas, ...derived}` of `id` against the core's send, whole.
#[track_caller]
pub fn assert_send(id: &str, recorded: &Exact, got: &Send) {
    for (key, want) in recorded.entries() {
        let what = format!("{id}: {key}");
        match key.as_str() {
            "result" => assert_exact(&what, &comparable(want), &got.result),
            "toolCalls" => assert_exact(&what, want, &got.tool_calls),
            "streamDeltas" => assert_exact(&what, &semantic_deltas(want), &got.stream_deltas),
            other => assert_exact(&what, want, &derived(other, &got.result, &got.tool_calls)),
        }
    }
}
