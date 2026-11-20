//! The OpenAI-compatible Chat Completions wire: how a stream of chunks becomes events (text, call fragments, usage,
//! finish reasons, failures in the middle), what is dispatched and what is withheld, how a request is lowered, and what
//! a cut Responses stream says on each compat transport.

use std::collections::HashSet;

use mixdog_ai::providers::compat::chat::ChatDecoder;
use mixdog_ai::providers::compat::chat::CompatChatCodec;
use mixdog_ai::providers::compat::chat::CompatConfig;
use mixdog_ai::providers::compat::profile::CompatProfile;
use mixdog_ai::providers::compat::profile::CredentialKind;
use mixdog_ai::providers::compat::responses::CompatResponsesCodec;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::BinarySource;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

fn profile() -> CompatProfile {
    CompatProfile::plain("gateway", "https://gateway.invalid/v1", CredentialKind::StaticKey { reauth_on_401: false })
}

fn decoder(known: &[&str]) -> ChatDecoder {
    ChatDecoder::new(profile(), ProviderId::from("gateway")).with_known_tools(known.iter().map(|n| (*n).to_owned()).collect::<HashSet<_>>())
}

fn chunk(delta: Value, finish: Option<&str>) -> String {
    let body = json!({"id": "c1", "model": "served-model", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]});
    format!("data: {body}\n\n")
}

fn call_delta(index: u64, id: Option<&str>, name: Option<&str>, arguments: &str) -> Value {
    let mut call = json!({"index": index, "function": {"arguments": arguments}});
    if let Some(id) = id {
        call["id"] = json!(id);
        call["type"] = json!("function");
    }
    if let Some(name) = name {
        call["function"]["name"] = json!(name);
    }
    json!({"tool_calls": [call]})
}

/// Each chunk is its own read; the events decoded before a failure are kept.
fn run(decoder: &mut ChatDecoder, wire: &[String]) -> (Vec<StreamEvent>, Option<ProviderError>) {
    let mut events = Vec::new();
    for unit in wire {
        match decoder.feed(unit.as_bytes()) {
            Ok(more) => events.extend(more),
            Err(error) => return (events, Some(error)),
        }
    }
    match decoder.finish() {
        Ok(more) => {
            events.extend(more);
            // A failure that still owed events hands them out first, then fails.
            if !decoder.terminal_seen() && !events.is_empty() {
                return (events, decoder.finish().err());
            }
            (events, None)
        }
        Err(error) => (events, Some(error)),
    }
}

fn dispatched(events: &[StreamEvent]) -> Vec<ToolCall> {
    events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(c) = e { Some(c.clone()) } else { None }).collect()
}

fn text(events: &[StreamEvent]) -> String {
    events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect()
}

fn stop(events: &[StreamEvent]) -> Option<StopReason> {
    events.iter().find_map(|e| if let StreamEvent::Completed { stop, .. } = e { stop.clone() } else { None })
}

const DONE: &str = "data: [DONE]\n\n";

#[test]
fn argument_fragments_are_appended_verbatim_and_the_call_runs_once_at_the_finish() {
    let wire = [
        chunk(call_delta(0, Some("call_1"), Some("lookup"), "{\"key\":"), None),
        chunk(call_delta(0, None, None, "\"answer\"}"), None),
        chunk(json!({}), Some("tool_calls")),
        DONE.to_owned(),
    ];
    let (events, error) = run(&mut decoder(&["lookup"]), &wire);
    assert!(error.is_none(), "{error:?}");
    let before_finish = events.iter().position(|e| matches!(e, StreamEvent::ToolCallDone(_))).unwrap();
    assert!(events[..before_finish].iter().any(|e| matches!(e, StreamEvent::ToolCallStart { name, .. } if name == "lookup")));
    assert_eq!(dispatched(&events), [ToolCall { id: "call_1".into(), name: "lookup".into(), arguments: json!({"key": "answer"}), native_type: None }]);
    assert_eq!(stop(&events), Some(StopReason::ToolUse));
}

#[test]
fn a_fragment_that_repeats_the_prefix_is_appended_not_merged_and_rides_as_invalid_arguments() {
    let wire = [
        chunk(call_delta(0, Some("call_1"), Some("lookup"), "{\"key\":\"a"), None),
        chunk(call_delta(0, None, None, "{\"key\":\"a\"}"), None),
        chunk(json!({}), Some("tool_calls")),
        DONE.to_owned(),
    ];
    let (events, error) = run(&mut decoder(&[]), &wire);
    assert!(error.is_none(), "{error:?}");
    let call = &dispatched(&events)[0];
    assert_eq!(call.arguments["__invalidToolArgs"], true, "complete but wrong: the model may re-issue the call");
    assert_eq!(call.arguments["__rawArguments"], "{\"key\":\"a{\"key\":\"a\"}", "the fragments exactly as they came");
    assert!(call.arguments["__parseError"].as_str().is_some_and(|m| !m.is_empty()));
}

#[test]
fn calls_are_told_apart_by_index_and_a_call_without_an_id_is_given_one() {
    let wire = [
        chunk(call_delta(0, Some("call_a"), Some("lookup"), "{}"), None),
        chunk(call_delta(1, None, Some("other"), "{\"x\":1}"), None),
        chunk(json!({}), Some("tool_calls")),
        DONE.to_owned(),
    ];
    let (events, error) = run(&mut decoder(&[]), &wire);
    assert!(error.is_none(), "{error:?}");
    let calls = dispatched(&events);
    assert_eq!(calls.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["lookup", "other"]);
    assert_eq!(calls[0].id, "call_a");
    assert!(calls[1].id.starts_with("call_") && calls[1].id.len() > "call_".len(), "the model is shown its result under an id: {}", calls[1].id);
}

#[test]
fn a_turn_cut_by_the_length_limit_with_calls_fails_with_the_calls_held_and_none_run() {
    let wire = [
        chunk(json!({"content": "Working"}), None),
        chunk(call_delta(0, Some("call_1"), Some("lookup"), "{\"key\":\"a\"}"), None),
        chunk(json!({}), Some("length")),
        format!("data: {}\n\n", json!({"choices": [], "usage": {"prompt_tokens": 9, "completion_tokens": 4}})),
        DONE.to_owned(),
    ];
    let (events, error) = run(&mut decoder(&["lookup"]), &wire);
    assert!(dispatched(&events).is_empty(), "nothing of a cut turn runs");
    let error = error.expect("the turn fails");
    assert_eq!((error.kind, error.code.as_deref(), error.transport.clone()), (ErrorKind::Unknown, Some("PROVIDER_INCOMPLETE"), None));
    assert_eq!(error.message, "gateway response incomplete: finish_reason=length");
    assert_eq!(error.partial_tool_calls.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["call_1"]);
    assert_eq!(error.partial_usage.as_ref().map(|u| (u.input_tokens, u.output_tokens)), Some((9, 4)), "what was spent is not lost");
    assert!(error.exposure.text_emitted);
    assert_eq!(text(&events), "Working");
}

#[test]
fn a_length_cut_without_calls_is_a_completed_turn_but_a_content_filter_always_fails() {
    let (events, error) = run(&mut decoder(&[]), &[chunk(json!({"content": "partial"}), Some("length")), DONE.to_owned()]);
    assert!(error.is_none(), "{error:?}");
    assert_eq!(stop(&events), Some(StopReason::MaxTokens));

    let (_, error) = run(&mut decoder(&[]), &[chunk(json!({"content": "x"}), Some("content_filter")), DONE.to_owned()]);
    let error = error.expect("a filtered turn fails even without calls");
    assert_eq!(error.code.as_deref(), Some("PROVIDER_INCOMPLETE"));
    assert_eq!(error.message, "gateway response incomplete: finish_reason=content_filter");
    assert!(error.partial_tool_calls.is_empty());
}

#[test]
fn finish_reasons_are_typed_and_a_plain_stop_keeps_the_wires_own_word() {
    for (finish, expected) in [
        ("stop", StopReason::Other("stop".into())),
        ("tool_calls", StopReason::ToolUse),
        ("function_call", StopReason::ToolUse),
        ("length", StopReason::MaxTokens),
        ("eos", StopReason::Other("eos".into())),
    ] {
        let (events, error) = run(&mut decoder(&[]), &[chunk(json!({"content": "x"}), Some(finish)), DONE.to_owned()]);
        assert!(error.is_none(), "{finish}: {error:?}");
        assert_eq!(stop(&events), Some(expected), "{finish}");
    }
}

#[test]
fn a_gateway_that_reports_a_failure_as_a_finish_reason_ends_in_a_truncated_stream_error() {
    let (_, error) = run(&mut decoder(&[]), &[chunk(json!({"content": "x"}), Some("network_error")), DONE.to_owned()]);
    let error = error.expect("network_error");
    assert_eq!(error.transport, Some(TransportFault::TruncatedStream));
    assert_eq!(error.message, "gateway SSE stream truncated: finish_reason=network_error");
    assert!(error.exposure.text_emitted);

    let (_, error) = run(&mut decoder(&[]), &[chunk(json!({}), Some("error")), DONE.to_owned()]);
    let error = error.expect("error");
    assert_eq!((error.status, error.code.as_deref()), (Some(502), Some("upstream_error")));
}

#[test]
fn a_stream_that_ends_without_a_finish_reason_or_inside_an_event_is_truncated() {
    let (events, error) = run(&mut decoder(&[]), &[chunk(json!({"content": "so far"}), None), DONE.to_owned()]);
    let error = error.expect("no finish_reason");
    assert_eq!(error.transport, Some(TransportFault::TruncatedStream));
    assert_eq!(error.message, "gateway SSE stream truncated: no finish_reason");
    assert_eq!(text(&events), "so far");
    assert!(error.exposure.text_emitted);

    // The finish arrived, then the usage frame was cut: not a success.
    let cut = format!("{}data: {{\"choices\":[],\"usage\":{{\"prompt_tok", chunk(json!({"content": "done"}), Some("stop")));
    let (_, error) = run(&mut decoder(&[]), &[cut]);
    assert_eq!(error.expect("cut usage frame").transport, Some(TransportFault::TruncatedStream));

    // A clean end after the finish needs no [DONE].
    let (events, error) = run(&mut decoder(&[]), &[chunk(json!({"content": "done"}), Some("stop"))]);
    assert!(error.is_none(), "{error:?}");
    assert_eq!(text(&events), "done");
}

#[test]
fn a_usage_only_frame_after_the_finish_is_reported_before_the_turn_completes() {
    let usage = json!({"choices": [], "usage": {"prompt_tokens": 120, "completion_tokens": 7, "prompt_tokens_details": {"cached_tokens": 100}}});
    let wire = [chunk(json!({"content": "hi"}), Some("stop")), format!("data: {usage}\n\n"), DONE.to_owned()];
    let (events, error) = run(&mut decoder(&[]), &wire);
    assert!(error.is_none(), "{error:?}");
    let at = |wanted: fn(&StreamEvent) -> bool| events.iter().position(wanted).unwrap();
    assert!(at(|e| matches!(e, StreamEvent::Usage(_))) < at(|e| matches!(e, StreamEvent::Completed { .. })));
    let Some(StreamEvent::Usage(u)) = events.iter().find(|e| matches!(e, StreamEvent::Usage(_))) else { unreachable!() };
    assert_eq!((u.input_tokens, u.output_tokens, u.cache_read_tokens), (120, 7, 100), "the cached part is inside the prompt count");
    assert_eq!(u.raw.as_ref(), Some(&usage["usage"]), "the provider's own figures ride along");
    assert!(events.contains(&StreamEvent::ServedModel("served-model".into())), "the model the chunks name is the one that answered");
}

#[test]
fn compatible_chat_reports_the_last_observed_usage_on_error_or_truncated_eof() {
    let usage = |read| format!("data: {}\n\n", json!({
        "model":"actually-served", "choices":[], "usage":{"prompt_tokens":80, "prompt_cache_hit_tokens":read}
    }));
    for tail in ["", "data: {\"error\":{\"message\":\"refused\"}}\n\n"] {
        let (_, err) = run(&mut decoder(&[]), &[usage(10), usage(40), tail.to_owned()]);
        let err = err.expect("no clean completion");
        let bill = err.partial_usage.clone().expect("the last report, not the sum");
        assert_eq!((bill.input_tokens, bill.cache_read_tokens), (80, 40));
        assert_eq!(err.partial_model.as_deref(), Some("actually-served"));
    }
}

#[test]
fn an_error_object_in_the_stream_and_an_unparsable_frame_end_it_with_a_typed_error() {
    let band = format!("data: {}\n\n", json!({"error": {"message": "rate limited", "code": 429, "type": "rate_limit"}}));
    let (events, error) = run(&mut decoder(&[]), &[chunk(json!({"content": "ab"}), None), band]);
    let error = error.expect("in-band error");
    assert_eq!(text(&events), "ab", "what arrived before it is delivered");
    assert!(error.exposure.text_emitted);

    let (_, error) = run(&mut decoder(&[]), &["data: {not json}\n\n".to_owned()]);
    let error = error.expect("malformed frame");
    assert_eq!((error.kind, error.code.as_deref()), (ErrorKind::Transient, Some("malformed_stream")));
    assert!(error.message.starts_with("gateway malformed stream frame: "), "{}", error.message);
}

#[test]
fn an_in_band_error_is_retried_when_the_server_failed_and_not_when_the_request_is_at_fault() {
    let fail = |error: Value| {
        let band = format!("data: {}\n\n", json!({ "error": error }));
        run(&mut decoder(&[]), &[band]).1.expect("in-band error")
    };
    let server = fail(json!({"message": "The server had an error while processing your request", "type": "server_error"}));
    assert!(!server.kind.is_deterministic(), "a server-side failure is resent: {:?}", server.kind);
    let fatal = fail(json!({"message": "Incorrect API key provided", "type": "invalid_request_error", "code": "invalid_api_key"}));
    assert!(fatal.kind.is_deterministic(), "a refusal of the key stays terminal: {:?}", fatal.kind);
}

#[test]
fn progress_is_reported_for_output_and_a_calls_dispatch_at_the_finish_is_not_progress() {
    let (events, _) = run(
        &mut decoder(&[]),
        &[
            chunk(json!({"role": "assistant", "content": ""}), None),
            chunk(json!({"content": "hi"}), None),
            chunk(call_delta(0, Some("call_1"), Some("lookup"), ""), None),
            chunk(call_delta(0, None, None, "{}"), None),
            chunk(json!({}), Some("tool_calls")),
            DONE.to_owned(),
        ],
    );
    assert_eq!(events.iter().filter(|e| matches!(e, StreamEvent::OutputStarted)).count(), 1, "the generation starts once");
    let tool_progress = events.iter().filter(|e| matches!(e, StreamEvent::Progress(ProgressKind::Tool))).count();
    assert_eq!(tool_progress, 2, "the header chunk and the arguments chunk");
    let done_at = events.iter().position(|e| matches!(e, StreamEvent::ToolCallDone(_))).unwrap();
    assert!(!matches!(events[done_at - 1], StreamEvent::Progress(_)), "dispatch at the finish reports nothing");
    // A comment line is a keepalive, not a payload.
    let mut d = decoder(&[]);
    assert_eq!(d.feed(b": keep-alive\n\n").unwrap(), [StreamEvent::ProviderKeepalive]);
    assert!(!d.payload_seen());
}

const LEAK: &str = "<invoke name=\"lookup\"><parameter name=\"key\">answer</parameter></invoke>";

#[test]
fn a_call_written_into_the_text_runs_only_when_the_turn_finishes_normally() {
    let wire = |finish: &str| [chunk(json!({"content": format!("Checking. {LEAK}")}), None), chunk(json!({}), Some(finish)), DONE.to_owned()];
    let (events, error) = run(&mut decoder(&["lookup"]), &wire("stop"));
    assert!(error.is_none(), "{error:?}");
    assert_eq!(text(&events).trim(), "Checking.", "the markup is not shown");
    let calls = dispatched(&events);
    assert_eq!((calls.len(), calls[0].name.as_str(), calls[0].arguments.clone()), (1, "lookup", json!({"key": "answer"})));
    assert!(calls[0].id.starts_with("call_leaked_") && calls[0].id.len() == "call_leaked_".len() + 16, "{}", calls[0].id);

    // The same text on a turn the limit cut: nothing runs and the error holds the call.
    let (events, error) = run(&mut decoder(&["lookup"]), &wire("length"));
    assert!(dispatched(&events).is_empty());
    let error = error.expect("the cut turn fails");
    assert_eq!(error.partial_tool_calls.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["lookup"]);

    // On a failing finish it neither runs nor is held.
    let (events, error) = run(&mut decoder(&["lookup"]), &wire("network_error"));
    assert!(dispatched(&events).is_empty());
    assert_eq!(error.expect("truncated").transport, Some(TransportFault::TruncatedStream));

    // A tool the request did not offer stays text.
    let (events, _) = run(&mut decoder(&["other"]), &wire("stop"));
    assert!(dispatched(&events).is_empty());
    assert!(text(&events).contains("invoke"));
}

#[test]
fn the_same_call_streamed_and_written_in_text_runs_once() {
    let wire = [
        chunk(json!({"content": LEAK}), None),
        chunk(call_delta(0, Some("call_1"), Some("lookup"), "{\"key\":\"answer\"}"), None),
        chunk(json!({}), Some("tool_calls")),
        DONE.to_owned(),
    ];
    let (events, error) = run(&mut decoder(&["lookup"]), &wire);
    assert!(error.is_none(), "{error:?}");
    assert_eq!(dispatched(&events).len(), 1);
}

#[test]
fn reasoning_text_is_kept_even_when_empty_and_absent_when_the_stream_had_none() {
    let deepseek = || ChatDecoder::new(CompatProfile::deepseek(), ProviderId::from("deepseek"));
    let reasoning_of = |events: &[StreamEvent]| -> Option<Value> {
        events.iter().find_map(|e| if let StreamEvent::ReasoningReplay(r) = e { Some(r.items["reasoningContent"].clone()) } else { None })
    };
    let with_empty = [chunk(json!({"reasoning_content": "", "content": "ok"}), None), chunk(json!({}), Some("stop")), DONE.to_owned()];
    let (events, error) = run(&mut deepseek(), &with_empty);
    assert!(error.is_none(), "{error:?}");
    assert_eq!(reasoning_of(&events), Some(json!("")), "the field was on the wire, so the next turn echoes it back empty");
    let without = [chunk(json!({"content": "ok"}), None), chunk(json!({}), Some("stop")), DONE.to_owned()];
    let (events, _) = run(&mut deepseek(), &without);
    assert_eq!(reasoning_of(&events), None, "no field, no replay envelope");
    let thinking = [chunk(json!({"reasoning_content": "hm"}), None), chunk(json!({"reasoning_content": "m", "content": "ok"}), Some("stop")), DONE.to_owned()];
    let (events, _) = run(&mut deepseek(), &thinking);
    assert_eq!(reasoning_of(&events), Some(json!("hmm")));
}

fn codec() -> CompatChatCodec {
    CompatChatCodec::new(profile(), CompatConfig::default())
}

fn request(messages: Vec<Message>, tools: Vec<ToolDefinition>) -> ModelRequest {
    ModelRequest { model: "m1".into(), messages, tools, options: RequestOptions::default() }
}

fn body(request: &ModelRequest) -> Value {
    serde_json::from_slice(&codec().encode(request).expect("encodes").body).expect("json")
}

fn text_message(role: Role, text: &str) -> Message {
    Message::new(role, Content::Text(text.into()))
}

fn parts(role: Role, parts: Vec<ContentPart>) -> Message {
    Message::new(role, Content::Parts(parts))
}

fn lookup() -> ToolDefinition {
    ToolDefinition {
        name: "lookup".into(),
        description: "Read a value".into(),
        input_schema: json!({"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}),
        defer_loading: false,
        freeform: None,
    }
}

#[test]
fn a_chat_request_streams_with_usage_and_offers_tools_as_functions() {
    let wire = codec().encode(&request(vec![text_message(Role::User, "hi")], vec![lookup()])).unwrap();
    assert_eq!((wire.method.as_str(), wire.url.as_str()), ("POST", "https://gateway.invalid/v1/chat/completions"));
    let sent: Value = serde_json::from_slice(&wire.body).unwrap();
    assert_eq!(sent["model"], "m1");
    assert_eq!((&sent["stream"], &sent["stream_options"]), (&json!(true), &json!({"include_usage": true})));
    assert_eq!(
        sent["tools"],
        json!([{"type": "function", "function": {"name": "lookup", "description": "Read a value", "parameters": lookup().input_schema}}])
    );
    assert!(body(&request(vec![text_message(Role::User, "hi")], vec![])).get("tools").is_none(), "no tools, no field");
}

#[test]
fn a_tool_round_trip_is_lowered_to_an_assistant_call_and_a_tool_message() {
    let mut call = text_message(Role::Assistant, "");
    call.tool_calls = vec![ToolCall { id: "call_fx1".into(), name: "lookup".into(), arguments: json!({"key": "answer"}), native_type: None }];
    let mut result = text_message(Role::Tool, "42");
    result.tool_call_id = Some("call_fx1".into());
    let sent = body(&request(vec![text_message(Role::System, "be brief"), text_message(Role::User, "q"), call, result], vec![lookup()]));
    assert_eq!(
        sent["messages"],
        json!([
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": "q"},
            {"role": "assistant", "content": null, "tool_calls": [
                {"id": "call_fx1", "type": "function", "function": {"name": "lookup", "arguments": "{\"key\":\"answer\"}"}}]},
            {"role": "tool", "tool_call_id": "call_fx1", "content": "42"},
        ])
    );
}

#[test]
fn multipart_content_is_lowered_per_role() {
    let image = || ContentPart::Image(ImageSource::Base64 { data: "QUJD".into(), mime_type: "image/png".into(), width: None, height: None });
    let note = |data: &str| ContentPart::File { source: BinarySource::Base64(data.into()), mime_type: "text/plain".into(), filename: Some("n.txt".into()), text: None };
    let sent = body(&request(
        vec![
            // Outside a user message the parts are joined by newlines and media is dropped.
            parts(Role::System, vec![ContentPart::Text("one".into(), None), image(), ContentPart::Text("two".into(), None)]),
            // A user's parts stay a list: media rides in it, an empty text part is dropped, a text file is shown as text.
            parts(Role::User, vec![ContentPart::Text("look".into(), None), ContentPart::Text(String::new(), None), image(), note("aGVsbG8=")]),
            parts(Role::Assistant, vec![ContentPart::Text("a".into(), None), ContentPart::Text("b".into(), None)]),
        ],
        vec![],
    ));
    let messages = sent["messages"].as_array().unwrap();
    assert_eq!(messages[0], json!({"role": "system", "content": "one\ntwo"}));
    assert_eq!(
        messages[1]["content"],
        json!([
            {"type": "text", "text": "look"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}},
            {"type": "text", "text": "--- n.txt (text/plain, 5 bytes) ---\nhello"},
        ])
    );
    assert_eq!(messages[2], json!({"role": "assistant", "content": "a\nb"}));
}

#[test]
fn the_media_of_a_tool_result_moves_to_the_user_message_that_follows_the_tool_messages() {
    let mut call = text_message(Role::Assistant, "");
    call.tool_calls = vec![ToolCall { id: "call_1".into(), name: "lookup".into(), arguments: json!({}), native_type: None }];
    let mut result = parts(Role::Tool, vec![ContentPart::Image(ImageSource::Url("https://x.example/a.png".into()))]);
    result.tool_call_id = Some("call_1".into());
    let sent = body(&request(vec![text_message(Role::User, "q"), call, result], vec![lookup()]));
    let tail = &sent["messages"].as_array().unwrap()[2..];
    assert_eq!(tail[0]["role"], "tool");
    assert_eq!(tail[0]["content"], "[tool result included media content in the following user message]");
    assert_eq!(tail[1], json!({"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://x.example/a.png"}}]}));
}

#[test]
fn a_replayed_reasoning_text_goes_back_only_to_the_provider_that_produced_it() {
    let deepseek = CompatChatCodec::new(CompatProfile::deepseek(), CompatConfig::default());
    let mut assistant = text_message(Role::Assistant, "answer");
    assistant.push_replay(ProviderReplay { owner: ProviderId::from("deepseek"), items: json!({"reasoningContent": "because"}) });
    let history = |assistant: Message| request(vec![text_message(Role::User, "q"), assistant, text_message(Role::User, "next")], vec![]);
    let sent: Value = serde_json::from_slice(&deepseek.encode(&history(assistant.clone())).unwrap().body).unwrap();
    assert_eq!(sent["messages"][1]["reasoning_content"], "because");
    let mut foreign = text_message(Role::Assistant, "answer");
    foreign.push_replay(ProviderReplay { owner: ProviderId::from("someone-else"), items: json!({"reasoningContent": "secret"}) });
    let sent: Value = serde_json::from_slice(&deepseek.encode(&history(foreign)).unwrap().body).unwrap();
    assert!(sent["messages"][1].get("reasoning_content").is_none());
}

fn rejection(codec: &CompatChatCodec, status: u16, body: Value) -> ProviderError {
    codec.classify(&ErrorResponse { status: Some(status), headers: vec![], body: body.to_string().into_bytes() })
}

#[test]
fn a_refused_key_is_an_auth_error_that_shows_the_providers_text_and_a_login_issued_key_asks_for_a_new_login() {
    let refusal = "Incorrect API key provided";
    let body = json!({"error": {"message": refusal, "type": "invalid_request_error", "code": "invalid_api_key"}});
    let hint = "open /providers in mixdog to sign in again";
    // (profile, a login issued the key, the words the user is shown around the provider's text)
    let routes: [(CompatProfile, bool, &str); 8] = [
        (profile(), false, "401 "),
        (CompatProfile::xai(), false, refusal),
        (CompatProfile::deepseek(), false, refusal),
        (CompatProfile::openrouter(), false, refusal),
        (CompatProfile::mimo_oauth(), true, "API key rejected (401)"),
        (CompatProfile::command_code_oauth(), true, "API key rejected (401)"),
        (CompatProfile::muse_code_oauth(), true, "Model API key rejected"),
        (CompatProfile::opencode_go(), true, "OpenCode sign-in expired (inference 401)"),
    ];
    for (route, login, words) in routes {
        let id = route.id;
        let refused = rejection(&CompatChatCodec::new(route, CompatConfig::default()), 401, body.clone());
        assert_eq!((refused.status, refused.kind), (Some(401), ErrorKind::Auth), "{id}");
        assert!(refused.kind.is_deterministic(), "{id}: a refused key is never retried");
        assert_eq!(refused.reauth_required, login, "{id}: only a key a login issued is replaced by signing in again");
        assert!(refused.message.contains(words), "{id}: {}", refused.message);
        assert_eq!(refused.message.contains(hint), login, "{id}: {}", refused.message);
        if id != "opencode-go-oauth" {
            assert!(refused.message.contains(refusal), "{id}: the provider's own words are kept: {}", refused.message);
        }
        let bad = rejection(&CompatChatCodec::new(CompatProfile::plain("p", "https://p.invalid/v1", CredentialKind::StaticKey { reauth_on_401: false }), CompatConfig::default()), 400, json!({"error": {"message": "bad field"}}));
        assert_eq!((bad.kind, bad.status, bad.reauth_required), (ErrorKind::InvalidRequest, Some(400), false));
    }
}

#[test]
fn a_401_whose_only_typed_evidence_is_the_generic_invalid_request_envelope_keeps_that_type_and_the_providers_text() {
    // The specific `code` outranks the envelope `type`; with no code the type is all there is, and it outranks the status.
    let refused = rejection(&codec(), 401, json!({"error": {"message": "Invalid API key", "type": "invalid_request_error"}}));
    assert_eq!((refused.status, refused.kind), (Some(401), ErrorKind::InvalidRequest));
    assert!(refused.kind.is_deterministic());
    assert_eq!(refused.message, "401 Invalid API key", "the user is shown the status and the provider's own text");
    // Without any typed word the status decides.
    assert_eq!(rejection(&codec(), 401, json!({"error": {"message": "nope"}})).kind, ErrorKind::Auth);
}

#[test]
fn a_cut_compat_responses_stream_names_its_provider_on_each_transport() {
    let frames = [
        json!({"type": "response.output_item.added", "item": {"type": "function_call", "id": "fc1", "call_id": "c1", "name": "lookup"}}),
        json!({"type": "response.incomplete", "response": {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "output": []}}),
    ];
    let request = request(vec![text_message(Role::User, "go")], vec![]);
    for (transport, expected) in [
        (TransportKind::Http1, "xai:responses SSE stream truncated: incomplete (max_output_tokens) with tool call in flight"),
        (TransportKind::WebSocket, "xAI WS response.incomplete (max_output_tokens) with tool call in flight"),
    ] {
        let codec = CompatResponsesCodec::new(CompatProfile::xai(), CompatConfig::default(), transport);
        let mut decoder = codec.decoder(&request);
        let mut failure = None;
        for frame in &frames {
            let bytes = if transport == TransportKind::WebSocket { frame.to_string() } else { format!("data: {frame}\n\n") };
            if let Err(error) = decoder.feed(bytes.as_bytes()) {
                failure = Some(error);
            }
        }
        assert_eq!(failure.expect("a cut stream").message, expected, "{transport:?}");
    }
}
