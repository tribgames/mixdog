//! The Anthropic send's outcome in the shape Node's `AnthropicProvider#send` returns it (`anthropic-turn-result.mjs`
//! over `anthropic-sse-turn/turn-outcome.mjs`), built from the core's stream events, and the callbacks the send made
//! (`onToolCall`, `onStreamDelta`), for the group-A Anthropic replays.
//!
//! Every field of Node's result is built from a core event here, or is one the set's manifest declares not compared
//! ([`CaseSet::excludes`]); [`assert_send`] compares the rest whole and in Node's key order.
#![allow(dead_code, reason = "each Anthropic set uses part of it")]

use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_testkit::Exact;
use serde_json::Value;

use crate::provider_case::CaseSet;
use crate::provider_case::Recorded;
use crate::provider_case::plain;

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
    let mut summary = None;
    let mut metadata = None;
    let mut natives = Vec::new();
    for event in events {
        match event {
            StreamEvent::TextDelta(text) => {
                content.push_str(text);
                deltas.push(Exact::String("text".into()));
            }
            StreamEvent::FinalContent(text) => content.clone_from(text),
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
            StreamEvent::ContentSummary { has_thinking, block_types } => summary = Some((*has_thinking, block_types.clone())),
            StreamEvent::ProviderMetadata(value) => metadata = Some(value.clone()),
            StreamEvent::ServerToolBlock(block) => natives.push(block.clone()),
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
    ];
    let (has_thinking, block_types) = summary.unwrap_or_else(|| panic!("the send summarised its blocks: {events:?}"));
    result.extend([
        entry("hasThinkingContent", Exact::Bool(has_thinking)),
        entry("contentBlockTypes", Exact::Array(block_types.into_iter().map(Exact::String).collect())),
        entry("thinkingBlocks", thinking.map_or(Exact::Undefined, |t| plain(&Value::Array(t)))),
        // A streamed turn returns its blocks as `assistantBlocks` (turn-outcome.mjs:156); a whole (non-streaming)
        // response only its native server-tool blocks (`normalizeAnthropicNonStreamingResponse`).
        entry(
            "assistantBlocks",
            if output {
                blocks.as_ref().map_or(Exact::Undefined, |b| plain(&Value::Array(b.clone())))
            } else if natives.is_empty() {
                Exact::Undefined
            } else {
                plain(&Value::Array(natives))
            },
        ),
    ]);
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
    if let Some(metadata) = &metadata {
        result.push(entry("providerMetadata", plain(metadata)));
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

/// The exclusion line of Node's per-read `onStreamDelta('transport')` calls.
const TRANSPORT_DELTAS: &str = "onStreamDelta('transport')";

/// The recorded `{result, toolCalls, streamDeltas, ...derived}` of `id` against the core's send, each property whole.
#[track_caller]
pub fn assert_send(set: &CaseSet, id: &str, recorded: &Recorded<'_>, got: &Send) {
    for (key, want) in recorded.entries() {
        let what = format!("{id}: {key}");
        match key {
            "result" => want.assert_eq(&what, &got.result),
            "toolCalls" => want.assert_eq(&what, &got.tool_calls),
            // Node's `onStreamDelta` kinds, less `transport` where the manifest declares it not compared.
            "streamDeltas" if set.excludes(TRANSPORT_DELTAS) => {
                want.assert_filtered(&what, TRANSPORT_DELTAS, &got.stream_deltas)
            }
            "streamDeltas" => want.assert_eq(&what, &got.stream_deltas),
            other => want.assert_eq(&what, &derived(other, &got.result, &got.tool_calls)),
        }
    }
}
