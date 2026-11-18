//! The Messages stream as the codec's decoder reads it: SSE framing, text, thinking and tool-use blocks, hosted
//! search blocks, usage, stop reasons, the server-side fallback block and errors in the middle of a stream.
//! Every test feeds a small stream written in the test and reads the events it yields.

use std::sync::Arc;

use mixdog_ai::providers::anthropic::AnthropicCodec;
use mixdog_ai::providers::anthropic::AnthropicConfig;
use mixdog_ai::providers::anthropic::Flavor;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use serde_json::Value;
use serde_json::json;

fn codec() -> AnthropicCodec {
    AnthropicCodec::new(Flavor::ApiKey, AnthropicConfig::new(Arc::new(|_: &str| None)))
}

fn request(tools: &[&str]) -> ModelRequest {
    ModelRequest {
        model: "claude-sonnet-4-6".into(),
        messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
        tools: tools
            .iter()
            .map(|name| ToolDefinition {
                name: (*name).into(),
                description: String::new(),
                input_schema: json!({ "type": "object", "properties": {} }),
                defer_loading: false,
                freeform: None,
            })
            .collect(),
        options: RequestOptions::default(),
    }
}

fn decoder() -> Box<dyn WireDecoder> {
    codec().decoder(&request(&[]))
}

fn unit(event: &Value) -> Vec<u8> {
    format!("event: {}\ndata: {event}\n\n", event["type"].as_str().expect("a typed event")).into_bytes()
}

fn start() -> Value {
    json!({ "type": "message_start", "message": { "model": "claude-sonnet-4-6", "usage": { "input_tokens": 10, "cache_read_input_tokens": 100 } } })
}

fn open(index: u64, block: Value) -> Value {
    json!({ "type": "content_block_start", "index": index, "content_block": block })
}

fn delta(index: u64, delta: Value) -> Value {
    json!({ "type": "content_block_delta", "index": index, "delta": delta })
}

fn stop_block(index: u64) -> Value {
    json!({ "type": "content_block_stop", "index": index })
}

fn end(reason: &str, output: u64) -> [Value; 2] {
    [json!({ "type": "message_delta", "delta": { "stop_reason": reason }, "usage": { "output_tokens": output } }), json!({ "type": "message_stop" })]
}

fn run(decoder: &mut dyn WireDecoder, events: &[Value]) -> Vec<StreamEvent> {
    let mut out = Vec::new();
    for event in events {
        out.extend(decoder.feed(&unit(event)).expect("the unit decodes"));
    }
    out
}

fn decode(events: &[Value]) -> Vec<StreamEvent> {
    run(decoder().as_mut(), events)
}

fn text_of(events: &[StreamEvent]) -> String {
    events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect()
}

fn usage_of(events: &[StreamEvent]) -> Usage {
    events.iter().rev().find_map(|e| if let StreamEvent::Usage(u) = e { Some(u.clone()) } else { None }).expect("a usage report")
}

fn stop_of(events: &[StreamEvent]) -> Option<StopReason> {
    events.iter().find_map(|e| if let StreamEvent::Completed { stop, .. } = e { Some(stop.clone()) } else { None }).expect("the turn completed")
}

fn replay_of(events: &[StreamEvent]) -> Value {
    events.iter().find_map(|e| if let StreamEvent::ReasoningReplay(r) = e { Some(r.items.clone()) } else { None }).expect("a replay of the turn's blocks")
}

fn calls_of(events: &[StreamEvent]) -> Vec<(String, String, Value)> {
    events
        .iter()
        .filter_map(|e| if let StreamEvent::ToolCallDone(c) = e { Some((c.id.clone(), c.name.clone(), c.arguments.clone())) } else { None })
        .collect()
}

fn text_turn(pieces: &[&str], reason: &str) -> Vec<Value> {
    let mut events = vec![start(), open(0, json!({ "type": "text", "text": "" }))];
    events.extend(pieces.iter().map(|p| delta(0, json!({ "type": "text_delta", "text": p }))));
    events.push(stop_block(0));
    events.extend(end(reason, 7));
    events
}

// ---------------------------------------------------------------------------
// Text, usage, stop reasons
// ---------------------------------------------------------------------------

#[test]
fn text_deltas_arrive_in_order_and_the_turn_completes_with_its_stop_reason() {
    let events = decode(&text_turn(&["Hel", "lo ", "there"], "end_turn"));
    assert_eq!(text_of(&events), "Hello there");
    assert_eq!(stop_of(&events), Some(StopReason::EndTurn));
    assert_eq!(replay_of(&events), json!([{ "type": "text", "text": "Hello there" }]));
    assert!(matches!(events.last(), Some(StreamEvent::Completed { .. })));
}

#[test]
fn every_stop_reason_the_wire_names_reads_as_its_own_and_an_unknown_one_is_kept_by_name() {
    for (wire, want) in [
        ("end_turn", StopReason::EndTurn),
        ("max_tokens", StopReason::MaxTokens),
        ("stop_sequence", StopReason::StopSequence),
        ("refusal", StopReason::Refusal),
        ("pause_turn", StopReason::Other("pause_turn".into())),
    ] {
        assert_eq!(stop_of(&decode(&text_turn(&["x"], wire))), Some(want), "{wire}");
    }
    let mut no_reason = vec![start()];
    no_reason.push(json!({ "type": "message_stop" }));
    assert_eq!(stop_of(&decode(&no_reason)), None, "an absent reason stays absent");
}

#[test]
fn usage_keeps_the_cache_out_of_the_input_and_a_later_report_replaces_only_what_it_names() {
    let events = decode(&[
        json!({ "type": "message_start", "message": { "model": "claude-sonnet-4-6", "usage": { "input_tokens": 10, "cache_read_input_tokens": 100, "cache_creation_input_tokens": 30, "cache_creation": { "ephemeral_1h_input_tokens": 20 } } } }),
        json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": 55 } }),
        json!({ "type": "message_stop" }),
    ]);
    let usage = usage_of(&events);
    assert_eq!(
        (usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens, usage.cache_write_1h_tokens),
        (10, 55, 100, 30, 20)
    );
    let zeroed = decode(&[
        start(),
        json!({ "type": "message_delta", "delta": {}, "usage": { "cache_read_input_tokens": 0, "output_tokens": 3 } }),
        json!({ "type": "message_stop" }),
    ]);
    let usage = usage_of(&zeroed);
    assert_eq!((usage.input_tokens, usage.cache_read_tokens, usage.output_tokens), (10, 0, 3), "an explicit zero replaces, an omitted field stays");
}

#[test]
fn a_gateways_reported_cost_rides_the_usage_and_a_negative_one_is_not_a_cost() {
    let cost = |value: Value| usage_of(&decode(&[start(), json!({ "type": "message_delta", "delta": {}, "usage": { "output_tokens": 1, "cost": value } }), json!({ "type": "message_stop" })])).cost;
    assert!(cost(json!(0.25)).is_some());
    assert!(cost(json!("0.25")).is_some());
    assert!(cost(json!(-1)).is_none());
    assert!(cost(json!("")).is_none());
    assert!(cost(Value::Null).is_none());
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

#[test]
fn the_same_stream_decodes_alike_whatever_the_chunking_line_endings_or_comments() {
    let bytes: Vec<u8> = text_turn(&["a", "b"], "end_turn").iter().flat_map(unit).collect();
    let whole = {
        let mut d = decoder();
        let mut out = d.feed(&bytes).unwrap();
        out.extend(d.feed(&[]).unwrap());
        out
    };
    let byte_by_byte = {
        let mut d = decoder();
        let mut out = Vec::new();
        for b in &bytes {
            out.extend(d.feed(std::slice::from_ref(b)).unwrap());
        }
        out
    };
    assert_eq!(format!("{whole:?}"), format!("{byte_by_byte:?}"));
    let crlf = String::from_utf8(bytes.clone()).unwrap().replace('\n', "\r\n");
    let commented = format!(": keep-alive\n\n{crlf}\n: trailing\n");
    let mut d = decoder();
    let events = d.feed(commented.as_bytes()).unwrap();
    assert_eq!(text_of(&events), "ab");
    assert!(d.terminal_seen());
}

#[test]
fn a_malformed_record_is_skipped_and_the_records_beside_it_still_run() {
    let mut bytes = unit(&start());
    bytes.extend_from_slice(b"event: content_block_delta\ndata: {not json\n\n");
    bytes.extend(unit(&open(0, json!({ "type": "text", "text": "" }))));
    bytes.extend(unit(&delta(0, json!({ "type": "text_delta", "text": "ok" }))));
    let mut d = decoder();
    assert_eq!(text_of(&d.feed(&bytes).unwrap()), "ok");
}

#[test]
fn a_ping_is_a_keepalive_and_nothing_else() {
    let events = decode(&[json!({ "type": "ping" })]);
    assert!(matches!(events.as_slice(), [StreamEvent::ProviderKeepalive]), "{events:?}");
}

// ---------------------------------------------------------------------------
// Tool use
// ---------------------------------------------------------------------------

#[test]
fn a_tool_call_is_dispatched_when_its_block_closes_with_the_input_assembled_from_its_fragments() {
    let events = decode(&[
        start(),
        open(0, json!({ "type": "tool_use", "id": "toolu_1", "name": "lookup", "input": {} })),
        delta(0, json!({ "type": "input_json_delta", "partial_json": "{\"key\":" })),
        delta(0, json!({ "type": "input_json_delta", "partial_json": "\"answer\"}" })),
        stop_block(0),
    ]);
    assert!(events.iter().any(|e| matches!(e, StreamEvent::ToolCallStart { id, name } if id == "toolu_1" && name == "lookup")));
    let args: String = events.iter().filter_map(|e| if let StreamEvent::ToolCallArgsDelta { delta, .. } = e { Some(delta.as_str()) } else { None }).collect();
    assert_eq!(args, "{\"key\":\"answer\"}");
    assert_eq!(calls_of(&events), [("toolu_1".to_owned(), "lookup".to_owned(), json!({ "key": "answer" }))]);
}

#[test]
fn a_tool_use_stop_ends_the_turn_once_every_call_input_is_complete_without_waiting_for_message_stop() {
    let mut d = decoder();
    let events = run(
        d.as_mut(),
        &[
            start(),
            open(0, json!({ "type": "tool_use", "id": "toolu_1", "name": "lookup", "input": {} })),
            stop_block(0),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" }, "usage": { "output_tokens": 4 } }),
        ],
    );
    assert!(d.terminal_seen());
    assert_eq!(stop_of(&events), Some(StopReason::ToolUse));
    assert_eq!(calls_of(&events).len(), 1);
    assert_eq!(calls_of(&events)[0].2, json!({}), "no input fragments is an empty input");
    assert_eq!(replay_of(&events), json!([{ "type": "tool_use", "id": "toolu_1", "name": "lookup", "input": {} }]));
}

#[test]
fn a_call_whose_input_is_not_json_is_still_a_call_carrying_the_parse_failure() {
    let events = decode(&[
        start(),
        open(0, json!({ "type": "tool_use", "id": "toolu_1", "name": "lookup", "input": {} })),
        delta(0, json!({ "type": "input_json_delta", "partial_json": "{\"key\": " })),
        stop_block(0),
    ]);
    let calls = calls_of(&events);
    assert_eq!(calls[0].2["__invalidToolArgs"], true);
    assert_eq!(calls[0].2["__rawArguments"], "{\"key\": ");
    assert!(calls[0].2["__parseError"].as_str().is_some_and(|e| !e.is_empty()));
    // A JSON value that is not an object is an empty input.
    let scalar = decode(&[
        start(),
        open(0, json!({ "type": "tool_use", "id": "toolu_2", "name": "lookup", "input": {} })),
        delta(0, json!({ "type": "input_json_delta", "partial_json": "42" })),
        stop_block(0),
    ]);
    assert_eq!(calls_of(&scalar)[0].2, json!({}));
}

#[test]
fn a_call_written_into_the_text_is_recovered_once_and_the_turn_then_replays_without_blocks() {
    let call = "<function_calls><invoke name=\"lookup\"><parameter name=\"key\">answer</parameter></invoke></function_calls>";
    let mut d = codec().decoder(&request(&["lookup"]));
    let events = run(d.as_mut(), &text_turn(&["Let me check. ", call], "end_turn"));
    let calls = calls_of(&events);
    assert_eq!(calls.len(), 1);
    assert_eq!((calls[0].1.as_str(), &calls[0].2), ("lookup", &json!({ "key": "answer" })));
    assert!(!text_of(&events).contains("invoke"), "the tags are not shown: {}", text_of(&events));
    assert!(text_of(&events).starts_with("Let me check."));
    // The recovered call has no content block: replaying the blocks would drop it.
    assert!(!events.iter().any(|e| matches!(e, StreamEvent::ReasoningReplay(_))));
    // A tool the request did not offer is text.
    let mut other = codec().decoder(&request(&["read"]));
    let events = run(other.as_mut(), &text_turn(&[call], "end_turn"));
    assert!(calls_of(&events).is_empty());
}

// ---------------------------------------------------------------------------
// Thinking
// ---------------------------------------------------------------------------

#[test]
fn thinking_streams_as_reasoning_and_replays_with_its_signature_ahead_of_the_text() {
    let mut events = vec![
        start(),
        open(0, json!({ "type": "thinking", "thinking": "" })),
        delta(0, json!({ "type": "thinking_delta", "thinking": "let me " })),
        delta(0, json!({ "type": "thinking_delta", "thinking": "see" })),
        delta(0, json!({ "type": "signature_delta", "signature": "sig-1" })),
        stop_block(0),
        open(1, json!({ "type": "redacted_thinking", "data": "opaque" })),
        stop_block(1),
        open(2, json!({ "type": "text", "text": "" })),
        delta(2, json!({ "type": "text_delta", "text": "done" })),
        stop_block(2),
    ];
    events.extend(end("end_turn", 9));
    let got = decode(&events);
    let reasoning: String = got.iter().filter_map(|e| if let StreamEvent::ReasoningDelta(t) = e { Some(t.as_str()) } else { None }).collect();
    assert_eq!(reasoning, "let me see");
    assert_eq!(
        replay_of(&got),
        json!([
            { "type": "thinking", "thinking": "let me see", "signature": "sig-1" },
            { "type": "redacted_thinking", "data": "opaque" },
            { "type": "text", "text": "done" },
        ])
    );
    let summary = got.iter().find_map(|e| if let StreamEvent::ContentSummary { has_thinking, block_types } = e { Some((*has_thinking, block_types.clone())) } else { None }).unwrap();
    assert!(summary.0);
    assert!(summary.1.iter().any(|t| t == "thinking_delta"));
}

#[test]
fn an_empty_text_block_between_two_thinking_blocks_does_not_let_them_merge_on_replay() {
    let mut events = vec![
        start(),
        open(0, json!({ "type": "thinking", "thinking": "" })),
        delta(0, json!({ "type": "signature_delta", "signature": "a" })),
        stop_block(0),
        open(1, json!({ "type": "text", "text": "" })),
        stop_block(1),
        open(2, json!({ "type": "thinking", "thinking": "" })),
        delta(2, json!({ "type": "signature_delta", "signature": "b" })),
        stop_block(2),
    ];
    events.extend(end("end_turn", 1));
    assert_eq!(replay_of(&decode(&events)), json!([{ "type": "thinking", "thinking": "", "signature": "a" }]));
}

// ---------------------------------------------------------------------------
// Hosted tools and citations
// ---------------------------------------------------------------------------

#[test]
fn a_hosted_search_call_and_its_result_are_reported_whole_and_replayed_in_order_with_the_citations() {
    let result = json!({ "type": "web_search_tool_result", "tool_use_id": "srvtoolu_1", "content": [{ "type": "web_search_result", "url": "https://example.com", "title": "Example" }] });
    let mut events = vec![
        start(),
        open(0, json!({ "type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {} })),
        delta(0, json!({ "type": "input_json_delta", "partial_json": "{\"query\":" })),
        delta(0, json!({ "type": "input_json_delta", "partial_json": "\"rust\"}" })),
        stop_block(0),
        open(1, result.clone()),
        stop_block(1),
        open(2, json!({ "type": "text", "text": "" })),
        delta(2, json!({ "type": "text_delta", "text": "It is a language." })),
        delta(2, json!({ "type": "citations_delta", "citation": { "type": "web_search_result_location", "url": "https://example.com" } })),
        stop_block(2),
    ];
    events.extend(end("end_turn", 20));
    let got = decode(&events);
    let blocks: Vec<&Value> = got.iter().filter_map(|e| if let StreamEvent::ServerToolBlock(b) = e { Some(b) } else { None }).collect();
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0], &json!({ "type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": { "query": "rust" } }));
    assert_eq!(blocks[1], &result);
    assert!(calls_of(&got).is_empty(), "a hosted call is not a call for the agent to run");
    let replay = replay_of(&got);
    let kinds: Vec<&str> = replay.as_array().unwrap().iter().map(|b| b["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["server_tool_use", "web_search_tool_result", "text"]);
    assert_eq!(replay[2]["citations"], json!([{ "type": "web_search_result_location", "url": "https://example.com" }]));
}

// ---------------------------------------------------------------------------
// Server-side fallback
// ---------------------------------------------------------------------------

#[test]
fn a_fallback_block_hands_the_turn_to_the_fallback_model_and_is_recorded() {
    let mut events = vec![
        start(),
        open(0, json!({ "type": "fallback", "from": "claude-opus-5", "to": { "model": " claude-sonnet-5 " }, "trigger": { "type": "refusal", "category": "cyber" } })),
        stop_block(0),
        open(1, json!({ "type": "text", "text": "" })),
        delta(1, json!({ "type": "text_delta", "text": "answered by the fallback" })),
        stop_block(1),
    ];
    events.extend(end("end_turn", 5));
    let got = decode(&events);
    assert!(got.iter().any(|e| matches!(e, StreamEvent::ServedModel(m) if m == "claude-sonnet-5")), "{got:?}");
    let meta = got.iter().find_map(|e| if let StreamEvent::ProviderMetadata(m) = e { Some(m.clone()) } else { None }).expect("the fallback is recorded");
    assert_eq!(
        meta,
        json!({ "anthropicFallbacks": [{ "trigger": "refusal", "originalModel": "claude-opus-5", "fallbackModel": "claude-sonnet-5", "category": "cyber" }] })
    );
    // A block that names no source or no target is no fallback.
    let none = decode(&[start(), open(0, json!({ "type": "fallback", "from": "claude-opus-5" })), stop_block(0), end("end_turn", 1)[1].clone()]);
    assert!(!none.iter().any(|e| matches!(e, StreamEvent::ProviderMetadata(_) | StreamEvent::ServedModel(_))));
}

#[test]
fn a_message_naming_another_model_than_the_requested_one_reports_the_served_model() {
    let served = decode(&[json!({ "type": "message_start", "message": { "model": "claude-haiku-5", "usage": { "input_tokens": 1 } } })]);
    assert!(served.iter().any(|e| matches!(e, StreamEvent::ServedModel(m) if m == "claude-haiku-5")));
    let same = decode(&[start()]);
    assert!(!same.iter().any(|e| matches!(e, StreamEvent::ServedModel(_))));
}

// ---------------------------------------------------------------------------
// Errors in the middle of a stream
// ---------------------------------------------------------------------------

fn error_event(kind: &str, message: &str) -> Value {
    json!({ "type": "error", "error": { "type": kind, "message": message } })
}

#[test]
fn an_error_event_ends_the_stream_with_a_typed_error_after_the_events_decoded_before_it() {
    let mut d = decoder();
    let mut bytes = unit(&start());
    bytes.extend(unit(&open(0, json!({ "type": "text", "text": "" }))));
    bytes.extend(unit(&delta(0, json!({ "type": "text_delta", "text": "partial" }))));
    bytes.extend(unit(&error_event("overloaded_error", "Overloaded")));
    // Whatever the chunking, the events of the unit come first and the error is the next call's.
    let events = d.feed(&bytes).expect("the events before the error are delivered");
    assert_eq!(text_of(&events), "partial");
    let err: ProviderError = d.feed(&[]).expect_err("then the error");
    assert_eq!(err.kind, ErrorKind::Overloaded);
    assert_eq!(err.status, Some(529));
    assert!(err.exposure.text_emitted, "the caller had seen text, so the turn cannot be replayed silently");
}

#[test]
fn an_error_event_before_any_output_is_returned_at_once_and_is_typed_by_its_wire_type() {
    for (wire, kind, status) in [
        ("rate_limit_error", ErrorKind::RateLimited, Some(429)),
        ("authentication_error", ErrorKind::Auth, Some(401)),
        ("invalid_request_error", ErrorKind::InvalidRequest, Some(400)),
        ("api_error", ErrorKind::Transient, Some(500)),
    ] {
        let err = decoder().feed(&unit(&error_event(wire, "boom"))).expect_err(wire);
        assert_eq!((err.kind, err.status), (kind, status), "{wire}");
        assert!(!err.exposure.text_emitted);
    }
}

#[test]
fn a_null_error_field_on_an_ordinary_event_is_not_an_error() {
    let mut event = delta(0, json!({ "type": "text_delta", "text": "x" }));
    event["error"] = Value::Null;
    let mut d = decoder();
    d.feed(&unit(&start())).unwrap();
    assert_eq!(text_of(&d.feed(&unit(&event)).expect("no error frame")), "x");
}

#[test]
fn a_stream_that_ends_without_message_stop_is_a_truncation_that_says_how_far_it_got() {
    let mut d = decoder();
    assert!(d.feed(&unit(&start())).is_ok());
    let err = d.finish().expect_err("no message_stop");
    assert_eq!(err.transport, Some(TransportFault::TruncatedStream));
    assert!(err.message.contains("message_start without message_stop"), "{}", err.message);
    let empty = decoder().finish().expect_err("nothing at all");
    assert!(empty.message.contains("before message_start"), "{}", empty.message);
    // Text already shown is part of the failure's exposure.
    let mut shown = decoder();
    shown.feed(&unit(&start())).unwrap();
    shown.feed(&unit(&delta(0, json!({ "type": "text_delta", "text": "hi" })))).unwrap();
    assert!(shown.finish().expect_err("cut").exposure.text_emitted);
}

#[test]
fn a_stop_while_a_tool_input_is_still_streaming_is_a_cut_that_names_the_input() {
    let mut d = decoder();
    let events = [
        start(),
        open(0, json!({ "type": "tool_use", "id": "toolu_1", "name": "lookup", "input": {} })),
        delta(0, json!({ "type": "input_json_delta", "partial_json": "{\"key\":" })),
    ];
    run(d.as_mut(), &events);
    assert!(d.exposure().tool_input_cut, "an input still streaming is a cut input whenever the stream ends");
    // The usage the same unit carried is delivered first; the cut is the next call's.
    assert!(d.feed(&unit(&end("tool_use", 3)[0])).is_ok());
    let err = d.feed(&[]).expect_err("the arguments can never complete");
    assert_eq!(err.transport, Some(TransportFault::TruncatedStream));
    assert!(err.exposure.tool_input_cut);
}

#[test]
fn nothing_is_decoded_after_the_turn_ended() {
    let mut d = decoder();
    run(d.as_mut(), &text_turn(&["a"], "end_turn"));
    assert!(d.terminal_seen());
    assert!(d.feed(&unit(&delta(0, json!({ "type": "text_delta", "text": "late" })))).unwrap().is_empty());
    assert!(d.finish().unwrap().is_empty());
}
