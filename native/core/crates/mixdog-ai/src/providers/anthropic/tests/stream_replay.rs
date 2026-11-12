//! The scripted Messages streams of `anthropic-stream.test.mjs` against `fixtures/provider-anthropic-stream` (recorded by
//! `benchmarks/rust-core/recorders/record-anthropic-stream.mjs` from `b6f10295a`): the real adapter sends the recorded
//! call to a stand-in endpoint that serves the SSE chunks Node's endpoint served. Every request is compared whole with
//! Node's, then the whole result (usage slots, stop reason, calls, thinking blocks, replay envelope), the dispatched
//! calls and the progress kinds in order.

use super::*;
use crate::providers::case_replay::Capture;
use crate::providers::case_replay::assert_same_requests;
use crate::providers::case_replay::cases;
use crate::providers::case_replay::without_undefined;
use crate::providers::wire_fixtures::Inputs;
use crate::providers::wire_fixtures::Recorded;
use crate::providers::wire_fixtures::assert_same_result;
use crate::providers::wire_fixtures::attempt;
use crate::providers::wire_fixtures::built_on;
use crate::providers::wire_fixtures::core_events;
use crate::providers::wire_fixtures::core_result;
use crate::providers::wire_fixtures::message;
use crate::providers::wire_fixtures::node_result;

#[tokio::test]
async fn every_recorded_stream_is_decoded_and_sent_as_node_does() {
    let set = cases(mixdog_testkit::fixture!("../../fixtures/provider-anthropic-stream/cases.json"));
    for case in set["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let capture = Capture::new(case);
        let make = &case["calls"][0]["args"];
        let recorded = Recorded { input: json!({"provider": "anthropic", "config": make[0], "clientVersion": "1.0.0"}), exchange: Value::Null, result: Value::Null };
        let (adapter, _dir) = built_on(&recorded, capture.clone(), Inputs::default()).await;
        let send = &case["calls"][1]["args"];
        let request = Arc::new(ModelRequest {
            model: send[1].as_str().unwrap().to_owned(),
            messages: send[0].as_array().unwrap().iter().map(message).collect(),
            tools: Vec::new(),
            options: RequestOptions::default(),
        });
        let events = attempt(adapter.as_ref(), request.clone()).await.unwrap_or_else(|e| panic!("{id}: {e:?}"));
        assert_same_requests(&capture, case);

        let node = &case["result"];
        let mut ok = without_undefined(&node["result"]);
        // Node returns the calls it dispatched through `onToolCall` as `toolCalls` as well; the core has the one event
        // (`ToolCallDone`), compared below as the dispatched calls and here as equal to the returned ones.
        if let Some(returned) = ok.as_object_mut().unwrap().shift_remove("toolCalls") {
            assert_eq!(returned, node["toolCalls"], "{id}: Node returns the calls it dispatched");
        }
        // `thinkingBlocks` is the thinking blocks of the replay envelope (the one the core keeps them in), in order.
        if let Some(blocks) = ok.as_object_mut().unwrap().shift_remove("thinkingBlocks") {
            let replay = ok["providerReplay"]["items"].as_array().unwrap();
            let thinking: Vec<Value> = replay.iter().filter(|b| matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking"))).cloned().collect();
            assert_eq!(blocks, Value::Array(thinking), "{id}: Node's thinking blocks are the replay's");
        }
        // `stopDetails` is a result field no Node code reads past the provider (the core has no such field): it is checked
        // against the `stop_details` and `category` the recorded stream carried, then left out of the comparison.
        if let Some(details) = ok.as_object_mut().unwrap().shift_remove("stopDetails") {
            let delta = case["input"]["events"].as_array().unwrap().iter().find(|e| e["delta"]["stop_details"].is_object()).unwrap();
            let mut carried = delta["delta"]["stop_details"].clone();
            carried["category"] = delta["delta"]["category"].clone();
            assert_eq!(details, carried, "{id}: Node's stop details are what the stream carried");
        }
        // The core's `input_tokens` is the whole prompt (Node's `promptTokens`); Node's `inputTokens` is the uncached part.
        let mut core = core_result(&events, &request.model);
        if let Some(usage) = core.pointer_mut("/ok/usage") {
            let prompt = usage["inputTokens"].as_u64().unwrap() - usage["cachedTokens"].as_u64().unwrap() - usage["cacheWriteTokens"].as_u64().unwrap();
            usage["inputTokens"] = json!(prompt);
        }
        let wanted = json!({"ok": ok, "dispatchedToolCalls": node["toolCalls"]});
        assert_same_result(&core, &node_result(&wanted), id);

        let shown = core_events(&events, &json!(["onToolCall", "onStreamDelta"]));
        let kinds: Vec<&str> = shown.iter().filter(|e| e["on"] == "streamDelta").map(|e| e["kind"].as_str().unwrap()).collect();
        let node_kinds: Vec<&str> = node["streamDeltas"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).filter(|k| *k != "transport").collect();
        assert_eq!(kinds, node_kinds, "{id}: the progress kinds");
        let calls: Vec<Value> = shown.iter().filter(|e| e["on"] == "toolCall").map(|e| json!({"id": e["id"], "name": e["name"], "arguments": e["arguments"]})).collect();
        assert_eq!(Value::Array(calls), node["toolCalls"], "{id}: the calls dispatched while streaming");
        let usage = &node["usageSlots"];
        if !usage.is_null() {
            let rust = events.iter().rev().find_map(|e| if let StreamEvent::Usage(u) = e { Some(u) } else { None }).unwrap();
            let slots = json!([rust.input_tokens - rust.cache_read_tokens - rust.cache_write_tokens, rust.output_tokens, rust.cache_read_tokens, rust.cache_write_tokens, rust.input_tokens]);
            assert_eq!(&slots, usage, "{id}: usage slots");
        }
    }
}
