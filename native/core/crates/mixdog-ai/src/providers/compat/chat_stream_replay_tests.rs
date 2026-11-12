//! The scripted chunk lists of `openai-compat-chat-stream-tool-calls.test.mjs` against
//! `fixtures/provider-compat-chat-stream-tool-calls` (recorded by
//! `benchmarks/rust-core/recorders/record-compat-chat-stream-tool-calls.mjs` from `b6f10295a`): every chunk is fed to the
//! production `ChatDecoder` as the SSE event the transport hands it, and what the decoder produced is compared with what
//! Node's `consumeCompatChatCompletionStream` returned and dispatched. Differences of representation, each declared:
//! - Node returns the raw `finish_reason` as `stopReason`; the core types it (`tool_calls` is `ToolUse`, `length` is
//!   `MaxTokens`, `content_filter` is `ContentFilter`, a plain `stop` stays the wire's own text).
//! - Node's result `toolCalls` is the list the turn returns: the core emits it as `ReturnedCalls` when a recovered call
//!   is in it, else the list is the `ToolCallDone` events; the recorded list is compared whole with that.
//! - A turn cut by `length` (with calls) or `content_filter` is rejected by `normalizeCompatChatResponse`, a
//!   `ProviderIncompleteError` that holds the calls as `partialToolCalls`; the turn fails with it, nothing is dispatched,
//!   and Node's retry classification reads it as unknown (not retried). The core's decoder owns that step
//!   (`ChatDecoder::incomplete_failure`): its `ProviderError` (`PROVIDER_INCOMPLETE`, kind `Unknown`, no transport
//!   fault, Node's message whole, the provider's name first) holds the calls in `partial_tool_calls`, compared whole with the recorded `partialToolCalls`, with the
//!   collector's list and with the partial content. Not compared, unobservable to the caller: Node's error `name`,
//!   `providerIncomplete`, `finishReason`, `responseId` and `rawUsage` (the core keeps the usage as `partial_usage`), and
//!   `model` (`useModel`, the request's own model, which the core's `partial_model: None` means).
//! - The first case's own `parseToolCalls` hands Node's dispatcher raw tool-call objects without a top-level `name`,
//!   which `emitCompatToolCallOnce` skips: a state no turn reaches. It is recorded with the product's `parseToolCalls`
//!   instead (see the manifest), and its dispatched and returned lists are compared whole like every other case's.
//! - A recovered call's id is minted from a random source on both sides (Node's recording holds the one its seeded source
//!   gave), so those ids are compared by their shape (`call_leaked_` and 16 hex digits), the rest of the call whole.
//! - A truncated stream's error is the transport fault `TruncatedStream` and its exposure flags; Node's message (provider label
//!   first) is compared whole; its `streamOutcome` / `partialToolCalls` are Node's own
//!   retry bookkeeping.

use std::collections::HashSet;

use mixdog_core_api::domain::provider::ErrorKind;
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
            // The stream's end (`DecodedStream`): a failure that still owes events hands them out, then fails.
            match decoder.finish() {
                Ok(more) => {
                    let owes_failure = !more.is_empty() && !decoder.terminal_seen();
                    events.extend(more);
                    if owes_failure {
                        failure = Some(decoder.finish().expect_err("the stored failure"));
                    }
                }
                Err(error) => failure = Some(error),
            }
        }
        let node = without_undefined(&case["result"]);
        let dispatched: Vec<Value> = events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(c) = e { Some(json!({"id": c.id, "name": c.name, "arguments": c.arguments})) } else { None }).collect();

        if let Some(node_error) = node.get("error") {
            let error = failure.unwrap_or_else(|| panic!("{id}: Node failed, the decoder succeeded"));
            assert_eq!(error.transport, Some(TransportFault::TruncatedStream), "{id}: {error:?}");
            assert_eq!(error.message, node_error["message"], "{id}: message");
            assert_eq!(error.exposure.text_emitted, node_error["props"]["partialContent"].as_str().is_some_and(|t| !t.is_empty()), "{id}: text exposed");
            assert_eq!(error.exposure.tool_dispatched, node_error["props"]["emittedToolCall"], "{id}: a call dispatched");
            assert_eq!(minted_ids_by_shape(Value::Array(dispatched)), minted_ids_by_shape(node["dispatched"].clone()), "{id}: dispatched before the failure");
            continue;
        }
        if let Some(normalized) = node.get("normalized").filter(|n| !n.is_null()) {
            // `normalizeCompatChatResponse` over the cut turn: the turn fails with the error, which holds the calls.
            let error = failure.unwrap_or_else(|| panic!("{id}: Node's normalizer threw, the decoder succeeded"));
            assert_eq!((error.kind, error.code.as_deref(), &error.transport), (ErrorKind::Unknown, Some("PROVIDER_INCOMPLETE"), &None), "{id}: {error:?}");
            assert_eq!(error.message, normalized["message"], "{id}: message");
            assert_eq!(normalized["code"], "PROVIDER_INCOMPLETE", "{id}: Node's code");
            let held: Vec<Value> = error.partial_tool_calls.iter().map(|c| json!({"id": c.id, "name": c.name, "arguments": c.arguments})).collect();
            assert_eq!(minted_ids_by_shape(Value::Array(held.clone())), minted_ids_by_shape(normalized["props"]["partialToolCalls"].clone()), "{id}: the calls the error holds");
            assert_eq!(minted_ids_by_shape(Value::Array(held)), minted_ids_by_shape(node["result"]["toolCalls"].clone()), "{id}: the collector's list is what the error holds");
            let content: String = events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect();
            assert_eq!(content, normalized["props"]["partialContent"], "{id}: partial content");
            assert!(dispatched.is_empty() && node["dispatched"].as_array().unwrap().is_empty(), "{id}: no call dispatched");
            continue;
        }
        assert!(failure.is_none(), "{id}: {failure:?}");
        let result = &node["result"];
        let stop = events.iter().find_map(|e| if let StreamEvent::Completed { stop, .. } = e { stop.clone() } else { None });
        assert_eq!(stop, Some(typed_stop(result["stopReason"].as_str().unwrap())), "{id}: the stop reason");
        let content: String = events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect();
        assert_eq!(content, result["content"], "{id}: the text");
        let returned: Vec<Value> = returned_of(&events).iter().map(|c| json!({"id": c.id, "name": c.name, "arguments": c.arguments})).collect();
        assert_eq!(minted_ids_by_shape(Value::Array(dispatched)), minted_ids_by_shape(node["dispatched"].clone()), "{id}: the calls dispatched");
        assert_eq!(minted_ids_by_shape(Value::Array(returned)), minted_ids_by_shape(result["toolCalls"].clone()), "{id}: the returned list");
    }
}
