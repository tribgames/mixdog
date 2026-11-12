//! The scripted chunk lists of `openai-compat-chat-stream-tool-calls.test.mjs` against
//! `fixtures/provider-compat-chat-stream-tool-calls` (recorded by
//! `benchmarks/rust-core/recorders/record-compat-chat-stream-tool-calls.mjs` from `b6f10295a`): every chunk is fed to the
//! production `ChatDecoder` as the SSE event the transport hands it, and what the decoder produced is compared with what
//! Node's `consumeCompatChatCompletionStream` returned and dispatched. Differences of representation, each declared:
//! - Node returns the raw `finish_reason` as `stopReason`; the core types it (`tool_calls` is `ToolUse`, `length` is
//!   `MaxTokens`, `content_filter` is `ContentFilter`, a plain `stop` stays the wire's own text).
//! - Node's result `toolCalls` is the list the turn returns: the core emits it as `ReturnedCalls` when a recovered call
//!   is in it, else the list is the `ToolCallDone` events; the recorded list is compared whole with that, every case. A
//!   turn cut by `length` / `content_filter` has its list discarded by `normalizeCompatChatResponse` (the recorded
//!   `normalized` error), so the core returns none; the recorded raw tool-call objects are compared by id and name.
//! - `normalized` (`normalizeCompatChatResponse` over a cut turn, a `ProviderIncompleteError`) is a step after the
//!   collector that the core's decoder does not own: the cut turn is its `MaxTokens` / `ContentFilter` stop with no call
//!   dispatched, which is what is compared.
//! - The first case's own `parseToolCalls` hands Node's dispatcher raw tool-call objects, which it never dispatches; the
//!   core's decoder always parses the arguments, so that case compares the argument text the fragments joined to.
//! - A recovered call's id is minted from a random source on both sides (Node's recording holds the one its seeded source
//!   gave), so those ids are compared by their shape (`call_leaked_` and 16 hex digits), the rest of the call whole.
//! - A truncated stream's error is the transport fault `TruncatedStream` and its exposure flags; Node's message carries
//!   the provider label (`gateway `) the core's does not, and its `streamOutcome` / `partialToolCalls` are Node's own
//!   retry bookkeeping.

use std::collections::HashSet;

use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

use super::chat::ChatDecoder;
use super::profile::CompatProfile;
use super::profile::CredentialKind;
use crate::providers::case_replay::cases;
use crate::providers::case_replay::without_undefined;
use crate::providers::leak_golden::returned_of;

/// A call list with each minted recovered-call id reduced to its shape.
fn minted_ids_by_shape(mut calls: Value) -> Value {
    for call in calls.as_array_mut().unwrap() {
        let id = call["id"].as_str().unwrap().to_owned();
        if let Some(minted) = id.strip_prefix("call_leaked_") {
            assert!(minted.len() == 16 && minted.bytes().all(|b| b.is_ascii_hexdigit()), "a minted id: {id}");
            call["id"] = json!("call_leaked_<16 hex>");
        }
    }
    calls
}

fn typed_stop(finish: &str) -> StopReason {
    match finish {
        "tool_calls" => StopReason::ToolUse,
        "length" => StopReason::MaxTokens,
        "content_filter" => StopReason::ContentFilter,
        other => StopReason::Other(other.to_owned()),
    }
}

#[test]
fn every_recorded_chunk_list_is_decoded_and_dispatched_as_node_does() {
    let set = cases(mixdog_testkit::fixture!("../../fixtures/provider-compat-chat-stream-tool-calls/cases.json"));
    assert_eq!(set["cases"].as_array().unwrap().len(), 8);
    for case in set["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let known: HashSet<String> = case["input"]["knownToolNames"].as_array().into_iter().flatten().map(|n| n.as_str().unwrap().to_owned()).collect();
        let profile = CompatProfile::plain("gateway", "https://gateway.invalid/v1", CredentialKind::StaticKey { reauth_on_401: false });
        let mut decoder = ChatDecoder::new(profile, ProviderId::from("gateway")).with_known_tools(known);
        let mut events = Vec::new();
        let mut failure = None;
        for chunk in case["input"]["chunks"].as_array().unwrap() {
            match decoder.feed(format!("data: {chunk}\n\n").as_bytes()) {
                Ok(more) => events.extend(more),
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        if failure.is_none() {
            match decoder.finish() {
                Ok(more) => events.extend(more),
                Err(error) => failure = Some(error),
            }
        }
        let node = without_undefined(&case["result"]);
        let dispatched: Vec<Value> = events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(c) = e { Some(json!({"id": c.id, "name": c.name, "arguments": c.arguments})) } else { None }).collect();

        if let Some(node_error) = node.get("error") {
            let error = failure.unwrap_or_else(|| panic!("{id}: Node failed, the decoder succeeded"));
            assert_eq!(error.transport, Some(TransportFault::TruncatedStream), "{id}: {error:?}");
            assert_eq!(format!("gateway {}", error.message), node_error["message"], "{id}: message");
            assert_eq!(error.exposure.text_emitted, node_error["props"]["partialContent"].as_str().is_some_and(|t| !t.is_empty()), "{id}: text exposed");
            assert_eq!(error.exposure.tool_dispatched, node_error["props"]["emittedToolCall"], "{id}: a call dispatched");
            assert_eq!(minted_ids_by_shape(Value::Array(dispatched)), minted_ids_by_shape(node["dispatched"].clone()), "{id}: dispatched before the failure");
            continue;
        }
        assert!(failure.is_none(), "{id}: {failure:?}");
        let result = &node["result"];
        let stop = events.iter().find_map(|e| if let StreamEvent::Completed { stop, .. } = e { stop.clone() } else { None });
        assert_eq!(stop, Some(typed_stop(result["stopReason"].as_str().unwrap())), "{id}: the stop reason");
        let content: String = events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect();
        assert_eq!(content, result["content"], "{id}: the text");
        // Node's raw tool-call objects (a `parseToolCalls` that hands them on whole) are never dispatched or parsed.
        let raw_calls = result["toolCalls"].as_array().unwrap().iter().any(|c| c.get("function").is_some());
        if raw_calls {
            let joined: String = events.iter().filter_map(|e| if let StreamEvent::ToolCallArgsDelta { delta, .. } = e { Some(delta.as_str()) } else { None }).collect();
            assert_eq!(joined, node["arguments"], "{id}: the fragments joined verbatim");
        } else {
            assert_eq!(minted_ids_by_shape(Value::Array(dispatched)), minted_ids_by_shape(node["dispatched"].clone()), "{id}: the calls dispatched");
        }
        // The list the turn returns: `ReturnedCalls` when the core names one, else the calls it dispatched. A turn cut by
        // `length` / `content_filter` is rejected by Node's `normalizeCompatChatResponse` before its list is used.
        let returned: Vec<Value> = returned_of(&events).iter().map(|c| json!({"id": c.id, "name": c.name, "arguments": c.arguments})).collect();
        let wanted = if node.get("normalized").is_some() { json!([]) } else { result["toolCalls"].clone() };
        if raw_calls {
            let ids = |list: &[Value]| list.iter().map(|c| c["id"].clone()).collect::<Vec<_>>();
            let names = |list: &[Value]| list.iter().map(|c| c.get("function").map_or(c["name"].clone(), |f| f["name"].clone())).collect::<Vec<_>>();
            let wanted = wanted.as_array().unwrap();
            assert_eq!((ids(&returned), names(&returned)), (ids(wanted), names(wanted)), "{id}: the returned list");
        } else {
            assert_eq!(minted_ids_by_shape(Value::Array(returned)), minted_ids_by_shape(wanted), "{id}: the returned list");
        }
    }
}
