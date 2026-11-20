//! What a Gemini `streamGenerateContent` body turns into: the end of a stream that carries no finish reason, calls
//! recovered from the answer text, the replay envelope, the typed failures and what each had already exposed, the
//! usage conventions of the three routes, and the progress kind of every chunk.

use std::collections::HashSet;
use std::time::Duration;

use mixdog_ai::providers::google::decode::DecodeDialect;
use mixdog_ai::providers::google::decode::GeminiDecoder;
use mixdog_ai::providers::google::decode::UsageStyle;
use mixdog_ai::providers::google::error::ErrorDialect;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StopReason;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireDecoder;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

fn decoder_with(usage: UsageStyle) -> GeminiDecoder {
    GeminiDecoder::new(DecodeDialect {
        owner: ProviderId::from("gemini"),
        envelope: false,
        usage,
        errors: ErrorDialect::gemini("Gemini REST streamGenerateContent"),
    })
}

fn decoder() -> GeminiDecoder {
    decoder_with(UsageStyle::Inclusive)
}

/// One SSE line carrying a chunk.
fn line(chunk: Value) -> String {
    format!("data: {chunk}\n\n")
}

fn candidate(parts: Value, finish: Option<&str>) -> Value {
    let mut candidate = json!({"content": {"role": "model", "parts": parts}});
    if let Some(finish) = finish {
        candidate["finishReason"] = json!(finish);
    }
    json!({"candidates": [candidate]})
}

/// Every chunk is its own read; the events decoded before a failure are kept, as the stream reader keeps them.
fn run(decoder: &mut GeminiDecoder, chunks: &[String]) -> (Vec<StreamEvent>, Option<ProviderError>) {
    let mut events = Vec::new();
    for chunk in chunks {
        match decoder.feed(chunk.as_bytes()) {
            Ok(more) => events.extend(more),
            Err(error) => return (events, Some(error)),
        }
    }
    match decoder.finish() {
        Ok(more) => {
            events.extend(more);
            (events, None)
        }
        Err(error) => (events, Some(error)),
    }
}

fn calls(events: &[StreamEvent]) -> Vec<ToolCall> {
    events.iter().filter_map(|e| if let StreamEvent::ToolCallDone(c) = e { Some(c.clone()) } else { None }).collect()
}

fn text(events: &[StreamEvent]) -> String {
    events.iter().filter_map(|e| if let StreamEvent::TextDelta(t) = e { Some(t.as_str()) } else { None }).collect()
}

fn stop(events: &[StreamEvent]) -> Option<Option<StopReason>> {
    events.iter().find_map(|e| if let StreamEvent::Completed { stop, .. } = e { Some(stop.clone()) } else { None })
}

fn replay_parts(events: &[StreamEvent]) -> Option<Value> {
    events.iter().find_map(|e| if let StreamEvent::ReasoningReplay(r) = e { Some(r.items["parts"].clone()) } else { None })
}

fn call_part(name: &str, args: Value) -> Value {
    json!({"functionCall": {"name": name, "args": args}})
}

#[test]
fn a_stream_of_whole_calls_without_a_finish_reason_is_a_tool_use_turn() {
    let wire = [line(candidate(json!([call_part("lookup", json!({"key": "a"})), call_part("lookup", json!({"key": "b"}))]), None))];
    let (events, error) = run(&mut decoder(), &wire);
    assert!(error.is_none(), "{error:?}");
    let done = calls(&events);
    assert_eq!(done.iter().map(|c| c.arguments.clone()).collect::<Vec<_>>(), [json!({"key": "a"}), json!({"key": "b"})]);
    assert!(done.iter().all(|c| !c.id.is_empty()), "a call the gateway did not name still gets an id");
    assert_ne!(done[0].id, done[1].id, "two calls of one turn never share an id");
    assert_eq!(stop(&events), Some(None), "a tool-use turn names no stop reason");
}

#[test]
fn a_call_the_server_names_keeps_its_id_and_an_unnamed_one_gets_the_same_id_for_the_same_call() {
    let named = json!({"functionCall": {"id": "srv-7", "name": "lookup", "args": {}}});
    let (events, _) = run(&mut decoder(), &[line(candidate(json!([named]), Some("STOP")))]);
    assert_eq!(calls(&events)[0].id, "srv-7");
    let mint = || {
        let (events, _) = run(&mut decoder(), &[line(candidate(json!([call_part("lookup", json!({"k": 1}))]), Some("STOP")))]);
        calls(&events)[0].id.clone()
    };
    assert_eq!(mint(), mint(), "the minted id is derived from the call, so a resend names it the same");
}

#[test]
fn an_unfinished_call_makes_a_stream_without_a_finish_reason_a_truncated_one() {
    let whole = call_part("lookup", json!({"key": "a"}));
    for unfinished in [
        json!({"functionCall": {"name": "lookup", "willContinue": true}}),
        json!({"functionCall": {"name": "lookup", "partialArgs": [{"jsonPath": "$.key"}]}}),
        json!({"functionCall": {"name": "lookup", "args": "not an object"}}),
        json!({"functionCall": {"args": {}}}),
    ] {
        let (_, error) = run(&mut decoder(), &[line(candidate(json!([whole.clone(), unfinished.clone()]), None))]);
        let error = error.unwrap_or_else(|| panic!("{unfinished}: the stream ended with a call still open"));
        assert_eq!(error.transport, Some(TransportFault::TruncatedStream), "{unfinished}");
    }
    // The same open call after a finish reason is a cut call, never a completed turn.
    let (_, error) = run(&mut decoder(), &[line(candidate(json!([json!({"functionCall": {"name": "lookup", "willContinue": true}})]), Some("STOP")))]);
    assert_eq!(error.expect("a cut call").transport, Some(TransportFault::TruncatedStream));
}

#[test]
fn a_stream_without_a_finish_reason_is_truncated_whatever_it_carried_but_calls() {
    let cases = [
        ("text", json!([{"text": "partial answer"}]), true),
        ("thoughts", json!([{"text": "thinking", "thought": true}]), false),
        ("empty candidate", json!([]), false),
    ];
    for (name, parts, text_exposed) in cases {
        let mut d = decoder();
        let (_, error) = run(&mut d, &[line(candidate(parts, None))]);
        let error = error.unwrap_or_else(|| panic!("{name}: no finish reason is a truncation"));
        assert_eq!(error.transport, Some(TransportFault::TruncatedStream), "{name}");
        assert_eq!(error.exposure.text_emitted, text_exposed, "{name}: what the caller already saw");
        assert!(!d.terminal_seen(), "{name}");
    }
    let (_, error) = run(&mut decoder(), &[]);
    assert_eq!(error.expect("an empty body").transport, Some(TransportFault::TruncatedStream));
}

#[test]
fn the_replay_envelope_keeps_every_part_in_order_with_its_signatures_and_binds_the_model() {
    let parts = json!([
        {"text": "plan", "thought": true, "thoughtSignature": "sig-1"},
        {"text": "answer", "thoughtSignature": "sig-2"},
        {"functionCall": {"name": "lookup", "args": {"key": "a"}}, "thoughtSignature": "sig-3"},
    ]);
    let wire = [line(candidate(json!([parts[0]]), None)), line(candidate(json!([parts[1], parts[2]]), Some("STOP")))];
    let (events, error) = run(&mut decoder().for_model("gemini-3-pro"), &wire);
    assert!(error.is_none(), "{error:?}");
    assert_eq!(replay_parts(&events), Some(parts), "the parts as the server sent them, in order, signatures included");
    let envelope = events.iter().find_map(|e| if let StreamEvent::ReasoningReplay(r) = e { Some(r.clone()) } else { None }).unwrap();
    assert_eq!(envelope.owner.as_str(), "gemini");
    assert_eq!(envelope.items["model"], "gemini-3-pro", "signed parts are replayed to the same model only");
    let (events, _) = run(&mut decoder(), &[line(candidate(json!([{"text": "x"}]), Some("STOP")))]);
    let envelope = events.iter().find_map(|e| if let StreamEvent::ReasoningReplay(r) = e { Some(r.clone()) } else { None }).unwrap();
    assert!(envelope.items.get("model").is_none(), "a decoder that does not know the request binds no model");
}

#[test]
fn a_call_written_into_the_text_is_hidden_held_until_a_clean_finish_and_released_once() {
    let leaked = "<invoke name=\"lookup\"><parameter name=\"key\">answer</parameter></invoke>";
    let (head, tail) = leaked.split_at(20);
    let wire = [
        line(candidate(json!([{"text": format!("Let me check. {head}")}]), None)),
        line(candidate(json!([{"text": tail}]), None)),
        line(candidate(json!([{"text": " Done."}]), Some("STOP"))),
    ];
    let known: HashSet<String> = ["lookup".to_owned()].into();
    let mut d = decoder().with_known_tools(known.clone());
    let mut before_finish = Vec::new();
    for chunk in &wire[..2] {
        before_finish.extend(d.feed(chunk.as_bytes()).unwrap());
    }
    assert!(calls(&before_finish).is_empty(), "nothing runs before the turn has ended cleanly");
    assert!(!text(&before_finish).contains("invoke"), "the markup is never shown: {:?}", text(&before_finish));
    let mut events = before_finish;
    events.extend(d.feed(wire[2].as_bytes()).unwrap());
    events.extend(d.finish().unwrap());
    assert_eq!(text(&events), "Let me check.  Done.");
    assert_eq!(calls(&events).len(), 1);
    assert_eq!((calls(&events)[0].name.as_str(), calls(&events)[0].arguments.clone()), ("lookup", json!({"key": "answer"})));
    assert!(replay_parts(&events).is_none(), "a call that is not a part of the response cannot be replayed");

    // A tool the request did not offer is text like any other.
    let (events, _) = run(&mut decoder().with_known_tools(["other".to_owned()].into()), &[line(candidate(json!([{"text": leaked}]), Some("STOP")))]);
    assert!(calls(&events).is_empty());

    // A failure after the guard held the call releases nothing.
    let failing = [line(candidate(json!([{"text": leaked}]), None)), line(json!({"error": {"code": 503, "status": "UNAVAILABLE", "message": "overloaded"}}))];
    let (events, error) = run(&mut decoder().with_known_tools(known), &failing);
    assert!(calls(&events).is_empty());
    assert!(!error.expect("the in-band error").exposure.tool_dispatched);
}

#[test]
fn a_call_recovered_from_text_without_deferral_is_dispatched_at_once_and_marks_the_failure_unsafe_to_resend() {
    let leaked = "<invoke name=\"lookup\"><parameter name=\"key\">answer</parameter></invoke>";
    let wire = [line(candidate(json!([{"text": leaked}]), None)), line(json!({"error": {"code": 500, "status": "INTERNAL", "message": "boom"}}))];
    let mut d = decoder().with_known_tools(["lookup".to_owned()].into()).with_deferred_calls(false);
    let (events, error) = run(&mut d, &wire);
    assert_eq!(calls(&events).len(), 1, "dispatched the moment it was recovered");
    assert!(error.expect("the in-band error").exposure.tool_dispatched);
}

#[test]
fn an_in_band_error_carries_its_status_retry_delay_and_what_the_stream_had_exposed() {
    let overloaded = json!({"error": {"code": 503, "status": "UNAVAILABLE", "message": "try later",
        "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "12s"}]}});
    let (_, before_text) = run(&mut decoder(), &[line(overloaded.clone())]);
    let before_text = before_text.expect("the error");
    assert_eq!(before_text.status, Some(503));
    assert_eq!(before_text.retry_after, Some(Duration::from_secs(12)));
    assert!(!before_text.exposure.text_emitted && !before_text.exposure.tool_dispatched, "safe to resend");

    let (events, after_stop) = run(&mut decoder(), &[line(candidate(json!([{"text": "Hel"}]), None)), line(overloaded)]);
    let after_stop = after_stop.expect("the error after output");
    assert_eq!(text(&events), "Hel");
    assert!(after_stop.exposure.text_emitted, "the caller already saw text: not safe to resend");
}

#[test]
fn a_last_line_without_a_newline_is_read_and_a_cut_one_is_a_truncated_stream() {
    let complete = line(candidate(json!([{"text": "ok"}]), Some("STOP"))).trim_end().to_owned();
    let (events, error) = run(&mut decoder(), &[complete.clone()]);
    assert!(error.is_none(), "{error:?}");
    assert_eq!(text(&events), "ok", "the unterminated tail is a payload like the others");

    let (_, error) = run(&mut decoder(), &[complete[..complete.len() - 9].to_owned()]);
    let error = error.expect("a payload cut inside its JSON");
    assert_eq!((error.transport.clone(), error.code.as_deref()), (Some(TransportFault::TruncatedStream), Some("malformed_stream")));
}

#[test]
fn each_finish_reason_ends_the_turn_the_way_its_kind_says() {
    let text_part = json!([{"text": "some text"}]);
    let call = json!([call_part("lookup", json!({}))]);
    // (finish reason, parts, error kind and code or None for a completed turn)
    let cases: [(&str, &Value, Option<(ErrorKind, &str)>); 14] = [
        ("SAFETY", &text_part, Some((ErrorKind::Policy, "safety"))),
        ("FINISH_REASON_BLOCKLIST", &text_part, Some((ErrorKind::Policy, "safety"))),
        ("PROHIBITED_CONTENT", &text_part, Some((ErrorKind::Policy, "safety"))),
        ("RECITATION", &text_part, Some((ErrorKind::Policy, "recitation"))),
        ("LANGUAGE", &text_part, Some((ErrorKind::Policy, "content_filter"))),
        ("MALFORMED_FUNCTION_CALL", &json!([]), Some((ErrorKind::Transient, "malformed_function_call"))),
        ("UNEXPECTED_TOOL_CALL", &json!([]), Some((ErrorKind::Transient, "unexpected_tool_call"))),
        ("TOO_MANY_TOOL_CALLS", &call, Some((ErrorKind::InvalidRequest, "too_many_tool_calls"))),
        ("MISSING_THOUGHT_SIGNATURE", &call, Some((ErrorKind::InvalidRequest, "missing_thought_signature"))),
        ("CONTINUATION", &text_part, Some((ErrorKind::Unknown, "continuation_unsupported"))),
        ("MAX_TOKENS", &json!([]), Some((ErrorKind::Unknown, "PROVIDER_INCOMPLETE"))),
        ("STOP", &text_part, None),
        ("MAX_TOKENS", &text_part, None),
        // Shown text prevents the re-ask, not the failure: `geminiIncompleteError` accepts no finish but `STOP`.
        ("MALFORMED_FUNCTION_CALL", &text_part, Some((ErrorKind::Unknown, "PROVIDER_INCOMPLETE"))),
    ];
    for (finish, parts, expected) in cases {
        let (events, error) = run(&mut decoder(), &[line(candidate(parts.clone(), Some(finish)))]);
        match expected {
            Some((kind, code)) => {
                let error = error.unwrap_or_else(|| panic!("{finish}: the turn should fail"));
                assert_eq!((error.kind, error.code.as_deref()), (kind, Some(code)), "{finish}");
                assert!(error.message.contains(finish.trim_start_matches("FINISH_REASON_")), "{finish}: {}", error.message);
            }
            None => assert!(error.is_none(), "{finish}: {error:?}"),
        }
        if finish == "MAX_TOKENS" && expected.is_none() {
            assert_eq!(stop(&events), Some(Some(StopReason::MaxTokens)), "an answer cut by the output limit is kept and says so");
        }
    }
    // An output cut after whole calls is a failed candidate (`geminiIncompleteError`), not a tool-use turn.
    let (events, error) = run(&mut decoder(), &[line(candidate(call.clone(), Some("MAX_TOKENS")))]);
    let error = error.expect("a cut candidate fails");
    assert_eq!((error.kind, error.code.as_deref()), (ErrorKind::Unknown, Some("PROVIDER_INCOMPLETE")));
    assert!(calls(&events).is_empty(), "a failed candidate releases none of its calls");
}

#[test]
fn a_blocked_prompt_ends_the_turn_as_a_policy_refusal_and_a_candidates_own_reason_outranks_it() {
    let blocked = json!({"promptFeedback": {"blockReason": "SAFETY"}});
    let (_, error) = run(&mut decoder(), &[line(blocked.clone())]);
    let error = error.expect("a blocked prompt");
    assert_eq!((error.kind, error.code.as_deref()), (ErrorKind::Policy, Some("safety")));
    let mut chunk = candidate(json!([{"text": "fine"}]), Some("STOP"));
    chunk["promptFeedback"] = blocked["promptFeedback"].clone();
    let (_, error) = run(&mut decoder(), &[line(chunk)]);
    assert!(error.is_none(), "{error:?}");
}

#[test]
fn usage_is_read_by_the_convention_of_the_route() {
    let meta = json!({"promptTokenCount": 20, "cachedContentTokenCount": 5, "candidatesTokenCount": 8,
        "thoughtsTokenCount": 3, "toolUsePromptTokenCount": 4});
    let usage = |style: UsageStyle, meta: &Value| {
        let mut chunk = candidate(json!([{"text": "x"}]), Some("STOP"));
        chunk["usageMetadata"] = meta.clone();
        let (events, error) = run(&mut decoder_with(style), &[line(chunk)]);
        assert!(error.is_none(), "{error:?}");
        events
            .iter()
            .find_map(|e| if let StreamEvent::Usage(u) = e { Some((u.input_tokens, u.output_tokens, u.cache_read_tokens, u.reasoning_tokens)) } else { None })
            .expect("usage")
    };
    // The prompt count holds the cached part and the tool-use prompt is added to it; output counts thoughts too.
    assert_eq!(usage(UsageStyle::Inclusive, &meta), (24, 11, 5, Some(3)));
    // Vertex books the input without what the cache served.
    assert_eq!(usage(UsageStyle::CacheExclusive, &meta), (19, 11, 5, Some(3)));
    // Antigravity adds the tool-use prompt to the input and reports the cache count as it is.
    assert_eq!(usage(UsageStyle::ToolUseAdded, &meta), (24, 11, 5, Some(3)));
    // No prompt count: the total less the output is the prompt; a cache count above the prompt is cut to it.
    let no_prompt = json!({"totalTokenCount": 30, "candidatesTokenCount": 8, "thoughtsTokenCount": 2, "cachedContentTokenCount": 50});
    assert_eq!(usage(UsageStyle::Inclusive, &no_prompt), (20, 10, 20, Some(2)));
}

#[test]
fn every_chunk_reports_one_progress_kind_for_all_its_parts() {
    let kinds = |parts: Value| -> Vec<Option<ProgressKind>> {
        let (events, _) = run(&mut decoder(), &[line(candidate(parts, None))]);
        events.iter().filter_map(|e| if let StreamEvent::ChunkProgress(k) = e { Some(*k) } else { None }).collect()
    };
    assert_eq!(kinds(json!([{"text": "hi"}])), [Some(ProgressKind::Text)]);
    assert_eq!(kinds(json!([{"text": "hmm", "thought": true}])), [Some(ProgressKind::Reasoning)]);
    assert_eq!(kinds(json!([call_part("lookup", json!({}))])), [Some(ProgressKind::Tool)]);
    assert_eq!(kinds(json!([{"text": "hmm", "thought": true}, {"text": "hi"}])), [Some(ProgressKind::Reasoning)], "thinking outranks text");
    assert_eq!(kinds(json!([{"text": "hmm", "thought": true}, call_part("lookup", json!({}))])), [Some(ProgressKind::Tool)], "a call outranks both");
    assert_eq!(kinds(json!([{"text": ""}])), [None], "an empty text is transport only");
    assert_eq!(kinds(json!([])), [None]);
}

#[test]
fn grounding_sources_are_reported_once_per_address() {
    let mut chunk = candidate(json!([{"text": "answer"}]), Some("STOP"));
    chunk["candidates"][0]["groundingMetadata"] = json!({"groundingChunks": [
        {"web": {"uri": "https://a.example/x", "title": "A"}},
        {"web": {"uri": "https://a.example/x", "title": "A again"}},
        {"web": {"uri": "https://b.example/y"}},
        {"web": {"title": "no address"}},
    ]});
    let (events, error) = run(&mut decoder(), &[line(chunk)]);
    assert!(error.is_none(), "{error:?}");
    let sources: Vec<(String, String)> = events
        .iter()
        .filter_map(|e| if let StreamEvent::Citation(c) = e { Some((c["url"].as_str().unwrap().to_owned(), c["title"].as_str().unwrap().to_owned())) } else { None })
        .collect();
    assert_eq!(sources, [("https://a.example/x".to_owned(), "A".to_owned()), ("https://b.example/y".to_owned(), "https://b.example/y".to_owned())]);
}

#[test]
fn keepalive_comments_pass_and_a_stream_end_marker_is_not_a_payload() {
    let wire = [": ping\n".to_owned(), line(candidate(json!([{"text": "ok"}]), Some("STOP"))), "data: [DONE]\n".to_owned()];
    let (events, error) = run(&mut decoder(), &wire);
    assert!(error.is_none(), "{error:?}");
    assert!(events.contains(&StreamEvent::ProviderKeepalive));
    assert_eq!(text(&events), "ok");
}

#[test]
fn only_the_policy_language_and_recitation_finish_reasons_have_a_refusal_code_under_any_wire_prefix() {
    use mixdog_ai::providers::google::decode::policy_finish_code;
    let refusals = [
        ("SAFETY", "safety"),
        ("BLOCKLIST", "safety"),
        ("PROHIBITED_CONTENT", "safety"),
        ("SPII", "safety"),
        ("IMAGE_SAFETY", "safety"),
        ("IMAGE_PROHIBITED_CONTENT", "safety"),
        ("ESCALATION", "safety"),
        ("PUP_LIMITED_DISABLED", "safety"),
        ("LANGUAGE", "content_filter"),
        ("RECITATION", "recitation"),
        ("IMAGE_RECITATION", "recitation"),
    ];
    for (reason, code) in refusals {
        // A finish reason, a prompt block reason and Vertex's prefixed spellings name the same thing.
        for spelled in [reason.to_owned(), format!("FINISH_REASON_{reason}"), format!("PROMPT_{reason}"), format!("BLOCK_REASON_{reason}")] {
            assert_eq!(policy_finish_code(&spelled), Some(code), "{spelled}");
        }
    }
    for reason in [
        "", "UNSPECIFIED", "STOP", "MAX_TOKENS", "MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "MALFORMED_RESPONSE", "TOO_MANY_TOOL_CALLS",
        "MISSING_THOUGHT_SIGNATURE", "CONTINUATION", "OTHER", "IMAGE_OTHER", "NO_IMAGE", "A_FUTURE_REASON", "safety",
    ] {
        assert_eq!(policy_finish_code(reason), None, "{reason:?}");
    }
}

#[test]
fn a_stream_that_finishes_on_a_refusal_reason_fails_as_a_policy_refusal_with_that_reasons_code_even_after_text() {
    for (reason, code) in [("SAFETY", "safety"), ("FINISH_REASON_RECITATION", "recitation"), ("LANGUAGE", "content_filter")] {
        let (events, error) = run(&mut decoder(), &[line(candidate(json!([{"text": "partial"}]), Some(reason)))]);
        let error = error.unwrap_or_else(|| panic!("{reason}: the turn is refused"));
        assert_eq!((error.kind, error.code.as_deref()), (ErrorKind::Policy, Some(code)), "{reason}");
        assert_eq!(text(&events), "partial", "{reason}: what was shown stays shown");
    }
}
