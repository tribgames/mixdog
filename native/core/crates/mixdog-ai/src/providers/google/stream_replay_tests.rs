//! The scripted Gemini streams of `gemini-stream.test.mjs` against `fixtures/provider-gemini-stream` (recorded by
//! `benchmarks/rust-core/recorders/record-gemini-stream.mjs` from `b6f10295a`): every served body is fed, line by line as
//! the transport hands it, to the production `GeminiDecoder` (the one the Gemini adapter builds), and what it produced
//! is compared with Node's `consumeGeminiRestStreamResponse` result: the aggregated candidate (as the replay envelope's
//! parts and the finished calls), the progress kinds and text deltas in order, and the typed error with what the stream
//! had exposed. Differences of representation, each declared where it is handled:
//! - Node returns the aggregated response; the core returns events (the parts ride the replay envelope, the finish
//!   reason is the `Completed` stop: `STOP` and a call-only turn are no stop), so `candidates[0].index/role` are Node's
//!   own envelope and only `parts` and `finishReason` are compared.
//! - Node's error is an object with `props`; the core's is a typed `ProviderError`: the truncation is the transport fault
//!   `TruncatedStream`, the in-band error carries `status` and `retry_after`; `liveTextEmitted` / `emittedToolCall` are
//!   the exposure flags, `unsafeToRetry` is their disjunction. `resetAt` is Node's virtual clock plus the retry delay,
//!   the core reads its own clock, so it is not compared; `streamStalled`, `pendingToolUse` and `partialContent` are
//!   Node's retry bookkeeping: `partialContent` is checked against the text deltas, the others have no core field.
//! - The guard's own "tool" progress is not in the recording (the recorder did not hand the guard `onStreamDelta`), so the
//!   core's guard progress is left out of the progress list.
//! - A case that ran a leak guard records its options (`input.leakGuard`: the known tool names and `deferToolCalls`);
//!   the decoder is built from them, and the calls Node's guard dispatched (`dispatched`) are the decoder's `ToolCallDone`
//!   events before the error.
//! - Not replayed here: `first-chunk-window-follows-caller-and-names-phase` runs the transport's first-byte timer on a
//!   virtual clock, a timer the decoder does not own (the adapter's transport tests cover it).

use std::collections::HashSet;
use std::time::Duration;

use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

use super::decode::DecodeDialect;
use super::decode::GeminiDecoder;
use super::decode::UsageStyle;
use super::error::ErrorDialect;
use crate::providers::case_replay::cases;
use crate::providers::case_replay::without_undefined;

const WINDOW_CASE: &str = "first-chunk-window-follows-caller-and-names-phase";

fn progress_name(kind: Option<ProgressKind>) -> &'static str {
    match kind {
        None => "transport",
        Some(ProgressKind::Text) => "text",
        Some(ProgressKind::Reasoning) => "reasoning",
        Some(ProgressKind::Tool) => "tool",
        Some(other) => panic!("a progress kind Node's Gemini consumer never reports: {other:?}"),
    }
}

/// The body as the transport delivers it to the decoder: one line at a time, so what the decoder produced before an error
/// is kept (the decoder returns the events of one `feed` only when it succeeds).
fn decode(chunks: &[Value], leak_guard: Option<&Value>) -> (GeminiDecoder, Vec<StreamEvent>, Option<ProviderError>) {
    let mut decoder = GeminiDecoder::new(DecodeDialect {
        owner: ProviderId::from("gemini"),
        envelope: false,
        usage: UsageStyle::Inclusive,
        errors: ErrorDialect { capacity_by_status: false },
    });
    if let Some(guard) = leak_guard {
        let tools = guard["knownToolNames"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_owned()).collect::<HashSet<_>>();
        decoder = decoder.with_known_tools(tools).with_deferred_calls(guard["deferToolCalls"].as_bool().unwrap());
    }
    let mut events = Vec::new();
    for chunk in chunks {
        for line in chunk.as_str().unwrap().split_inclusive('\n') {
            match decoder.feed(line.as_bytes()) {
                Ok(more) => events.extend(more),
                Err(error) => return (decoder, events, Some(error)),
            }
        }
    }
    match decoder.finish() {
        Ok(more) => {
            events.extend(more);
            (decoder, events, None)
        }
        Err(error) => (decoder, events, Some(error)),
    }
}

#[test]
fn every_recorded_gemini_body_is_decoded_as_node_consumes_it() {
    let set = cases(mixdog_testkit::fixture!("../../fixtures/provider-gemini-stream/cases.json"));
    let mut replayed = 0;
    for case in set["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        if id == WINDOW_CASE {
            continue;
        }
        replayed += 1;
        let node = without_undefined(&case["result"]);
        let (decoder, events, error) = decode(case["input"]["served"]["chunks"].as_array().unwrap(), case["input"].get("leakGuard"));

        let progress: Vec<&str> = events.iter().filter_map(|e| if let StreamEvent::ChunkProgress(kind) = e { Some(progress_name(*kind)) } else { None }).collect();
        let node_progress: Vec<&str> = node["progress"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
        assert_eq!(progress, node_progress, "{id}: the progress kinds");
        let text: Vec<&str> = events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect();
        let node_text: Vec<&str> = node["text"].as_array().unwrap().iter().map(|t| t.as_str().unwrap()).collect();
        assert_eq!(text, node_text, "{id}: the text deltas");

        if node.get("leakedToolCalls").is_some() {
            let held: Vec<Value> = decoder.held_leaked_calls().iter().map(|c| json!({"id": c.id, "name": c.name, "arguments": c.arguments})).collect();
            assert_eq!(Value::Array(held), node["leakedToolCalls"], "{id}: the calls recovered from text");
            let dispatched: Vec<Value> = events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(c) = e { Some(json!({"id": c.id, "name": c.name, "arguments": c.arguments})) } else { None }).collect();
            assert_eq!(Value::Array(dispatched), node["dispatched"], "{id}: the calls dispatched");
        }

        match (node.get("response"), node.get("error")) {
            (Some(response), None) => {
                let error = error.map(|e| format!("{e:?}"));
                assert_eq!(error, None, "{id}: Node returned a response");
                let candidate = &response["candidates"][0];
                let replay = events.iter().find_map(|e| if let StreamEvent::ReasoningReplay(r) = e { Some(r) } else { None }).unwrap();
                assert_eq!(replay.items["parts"], candidate["content"]["parts"], "{id}: the aggregated parts");
                let calls: Vec<Value> = events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(c) = e { Some(json!({"name": c.name, "args": c.arguments})) } else { None }).collect();
                let wanted: Vec<Value> = candidate["content"]["parts"].as_array().unwrap().iter().filter(|p| p.get("functionCall").is_some()).map(|p| json!({"name": p["functionCall"]["name"], "args": p["functionCall"]["args"]})).collect();
                assert_eq!(calls, wanted, "{id}: the finished calls");
                let stop = events.iter().find_map(|e| if let StreamEvent::Completed { stop, .. } = e { Some(stop.clone()) } else { None }).unwrap();
                assert!(stop.is_none(), "{id}: STOP and a call-only turn have no stop reason; got {stop:?}");
                assert!(matches!(candidate.get("finishReason"), None | Some(Value::String(_))), "{id}");
            }
            (None, Some(node_error)) => {
                let error = error.unwrap_or_else(|| panic!("{id}: Node failed with {node_error}, the decoder succeeded"));
                let props = &node_error["props"];
                match node_error["name"].as_str().unwrap() {
                    "TruncatedStreamError" => assert_eq!(error.transport, Some(TransportFault::TruncatedStream), "{id}: {error:?}"),
                    "GeminiInBandError" => {
                        assert_eq!(error.status.map(u64::from), props["status"].as_u64(), "{id}: status");
                        assert_eq!(error.code.as_deref().map(str::to_ascii_lowercase), node_error["code"].as_str().map(str::to_owned), "{id}: code");
                        assert_eq!(error.retry_after, props["retryAfterMs"].as_u64().map(Duration::from_millis), "{id}: retry delay");
                    }
                    other => panic!("{id}: a Node error this replay does not know: {other}"),
                }
                assert_eq!(error.exposure.text_emitted, props["liveTextEmitted"].as_bool().unwrap_or(false), "{id}: text exposed");
                assert_eq!(error.exposure.tool_dispatched, props["emittedToolCall"].as_bool().unwrap_or(false), "{id}: call dispatched");
                let unsafe_to_retry = error.exposure.text_emitted || error.exposure.tool_dispatched;
                assert_eq!(unsafe_to_retry, props["unsafeToRetry"].as_bool().unwrap_or(false), "{id}: unsafe to retry");
                if let Some(partial) = props["partialContent"].as_str() {
                    assert_eq!(text.concat(), partial, "{id}: the partial content");
                }
            }
            _ => panic!("{id}: a recorded case with neither a response nor an error"),
        }
    }
    assert_eq!(replayed, 17, "every recorded case but the timer one");
}
