//! Conformance of the OpenAI-compatible family against the recorded
//! fixtures (`fixtures/providers/openai-compat-chat`,
//! `fixtures/providers-intercepted/{mimo,command-code}-oauth`) and the
//! provider-neutral checks of `mixdog-core-api`.

use std::path::PathBuf;
use std::time::Duration;

use mixdog_core_api::domain::conformance::check_retry_policy;
use mixdog_core_api::domain::provider::{
    CacheTier, Content, ContentPart, DeliveryState, ErrorKind, ImageSource, Message, ModelRequest, ProviderReplay, RequestOptions, Role, StopReason,
    StreamEvent, ToolCall, ToolDefinition, WireCodec,
};
use mixdog_core_api::domain::retry::{RetryClass, RetryDecider, RetryState, Verdict};
use mixdog_protocol::{JsonValue, ProviderId};
use serde_json::json;

use super::chat::{CompatChatCodec, CompatConfig};
use super::models::{ModelTable, parse_models};
use super::profile::{CompatProfile, CredentialKind};
use crate::retry::StandardRetryDecider;

fn lookup_tool() -> ToolDefinition {
    ToolDefinition {
        name: "lookup".into(),
        description: "Read a value".into(),
        input_schema: json!({
            "type": "object",
            "properties": {"key": {"type": "string"}},
            "required": ["key"],
        }),
        defer_loading: false,
        freeform: None,
    }
}

fn text_message(role: Role, text: &str) -> Message {
    Message::new(role, Content::Text(text.into()))
}

fn base_request(model: &str) -> ModelRequest {
    ModelRequest {
        model: model.into(),
        messages: vec![text_message(Role::System, "You are a fixture assistant."), text_message(Role::User, "Look up the answer.")],
        tools: vec![lookup_tool()],
        options: RequestOptions::default(),
    }
}

fn followup_request(model: &str) -> ModelRequest {
    let mut request = base_request(model);
    let mut call = text_message(Role::Assistant, "");
    call.tool_calls = vec![ToolCall { id: "call_fx1".into(), name: "lookup".into(), arguments: json!({"key": "answer"}), native_type: None }];
    let mut result = text_message(Role::Tool, "42");
    result.tool_call_id = Some("call_fx1".into());
    request.messages.extend([call, result]);
    request
}

fn plain_codec() -> CompatChatCodec {
    let profile = CompatProfile::plain("groq", "https://api.groq.com/v1", CredentialKind::StaticKey { reauth_on_401: false });
    CompatChatCodec::new(profile, CompatConfig::default())
}

fn body_of(codec: &CompatChatCodec, request: &ModelRequest) -> JsonValue {
    let wire = codec.encode(request).expect("encodes");
    serde_json::from_slice(&wire.body).expect("json body")
}

/// Feeds `bytes` in two units split at `split` and finishes the body.
fn decode(codec: &CompatChatCodec, bytes: &[u8], split: usize) -> Vec<StreamEvent> {
    let mut decoder = codec.decoder(&base_request("m"));
    let (head, tail) = bytes.split_at(split.min(bytes.len()));
    let mut events = decoder.feed(head).expect("feed head");
    events.extend(decoder.feed(tail).expect("feed tail"));
    events.extend(decoder.finish().expect("finish"));
    events
}

fn text_of(events: &[StreamEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::TextDelta(t) => Some(t.as_str()),
            _ => None,
        })
        .collect()
}

fn tool_calls_of(events: &[StreamEvent]) -> Vec<ToolCall> {
    events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::ToolCallDone(c) => Some(c.clone()),
            _ => None,
        })
        .collect()
}

fn stop_of(events: &[StreamEvent]) -> StopReason {
    match events.last() {
        Some(StreamEvent::Completed { stop: Some(stop), .. }) => stop.clone(),
        other => panic!("the last event is the terminal one, got {other:?}"),
    }
}

// Dialects

#[test]
fn reasoning_text_is_kept_and_replayed_under_the_key_it_arrived_on() {
    let owner = ProviderId::from("deepseek");
    let codec = CompatChatCodec::new(CompatProfile::deepseek(), CompatConfig::default());
    let sse = "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think \"}}]}\n\n\
               data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hard\",\"content\":\"ok\"}}]}\n\n\
               data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
               data: [DONE]\n\n";
    let events = decode(&codec, sse.as_bytes(), 20);
    let replay: Vec<&ProviderReplay> = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::ReasoningReplay(r) => Some(r),
            _ => None,
        })
        .collect();
    assert_eq!(replay.len(), 1);
    assert_eq!(replay[0].owner, owner);
    assert_eq!(replay[0].items["reasoningContent"], "think hard");

    // The next request echoes it on the assistant turn that produced it.
    let mut request = followup_request("deepseek-v4-pro");
    request.messages[2].push_replay(replay[0].clone());
    let body = body_of(&codec, &request);
    assert_eq!(body["messages"][2]["reasoning_content"], "think hard");
    // Another provider's envelope is never replayed.
    let mut foreign = followup_request("m");
    foreign.messages[2].push_replay(ProviderReplay { owner: ProviderId::from("someone-else"), items: json!({"reasoningContent": "secret"}) });
    assert!(body_of(&codec, &foreign)["messages"][2].get("reasoning_content").is_none());
}

#[test]
fn effort_reaches_the_body_by_dialect_not_by_provider_name() {
    let with = |profile: CompatProfile, effort: &str, params: Option<JsonValue>, models: Vec<JsonValue>| {
        let table = std::sync::Arc::new(ModelTable::default());
        table.replace(parse_models(&JsonValue::Array(models)));
        let codec = CompatChatCodec::new(profile, CompatConfig { models: table, ..CompatConfig::default() });
        let mut request = base_request("m");
        request.options.effort = Some(effort.into());
        request.options.model_parameters = params;
        body_of(&codec, &request)
    };
    let xai = with(CompatProfile::xai(), "HIGH", None, vec![]);
    assert_eq!(xai["reasoning_effort"], "high");
    // A model the listing says takes no effort is left without it.
    let none_listed = with(CompatProfile::xai(), "high", None, vec![json!({"id":"m","reasoning_efforts":["none"]})]);
    assert!(none_listed.get("reasoning_effort").is_none());

    let ds = with(CompatProfile::deepseek(), "ultra", None, vec![]);
    assert_eq!((&ds["thinking"]["type"], &ds["reasoning_effort"]), (&json!("enabled"), &json!("max")));
    let ds_off = with(CompatProfile::deepseek(), "none", None, vec![]);
    assert_eq!(ds_off["thinking"]["type"], "disabled");
    assert!(ds_off.get("reasoning_effort").is_none());

    let or = with(CompatProfile::openrouter(), "medium", Some(json!({"providerSort": "latency"})), vec![]);
    assert_eq!(or["reasoning"], json!({"enabled": true, "effort": "medium"}));
    assert_eq!(or["provider"], json!({"sort": "latency"}));
    let or_off = with(CompatProfile::openrouter(), "none", Some(json!({"providerSort": "auto"})), vec![]);
    assert_eq!(or_off["reasoning"], json!({"enabled": false}));
    assert!(or_off.get("provider").is_none());

    let mimo = with(CompatProfile::mimo_oauth(), "xhigh", None, vec![json!({"id":"m","max_output_tokens":4000})]);
    assert_eq!(mimo["thinking"]["type"], "enabled");
    assert_eq!(mimo["reasoning_effort"], "high");
    assert_eq!(mimo["max_completion_tokens"], 4000, "bounded by the model's own ceiling");

    let cc = with(CompatProfile::command_code_oauth(), "medium", None, vec![json!({"id":"m","reasoning_efforts":["low","high"]})]);
    assert_eq!(cc["reasoning_effort"], "high", "folded onto the declared levels");
    let cc_basic = with(CompatProfile::command_code_oauth(), "medium", None, vec![]);
    assert_eq!(cc_basic["reasoning_effort"], "medium");
}

#[test]
fn tool_choice_is_sent_only_where_documented() {
    let choose = |profile: CompatProfile, choice: &str, effort: Option<&str>| {
        let codec = CompatChatCodec::new(profile, CompatConfig::default());
        let mut request = base_request("m");
        request.options.tool_choice = Some(choice.into());
        request.options.effort = effort.map(str::to_owned);
        body_of(&codec, &request)
    };
    assert_eq!(choose(CompatProfile::xai(), "required", None)["tool_choice"], "required");
    assert_eq!(choose(CompatProfile::xai(), "lookup", None)["tool_choice"], json!({"type": "function", "function": {"name": "lookup"}}));
    assert_eq!(choose(CompatProfile::xai(), "none", None)["tool_choice"], "none");
    // DeepSeek takes a forced choice only with thinking explicitly disabled.
    assert!(choose(CompatProfile::deepseek(), "required", None).get("tool_choice").is_none());
    assert!(choose(CompatProfile::deepseek(), "required", Some("high")).get("tool_choice").is_none());
    assert_eq!(choose(CompatProfile::deepseek(), "required", Some("none"))["tool_choice"], "required");
    // MiMo documents `auto` only: none drops the tools, nothing is forced.
    let mimo_none = choose(CompatProfile::mimo_oauth(), "none", None);
    assert!(mimo_none.get("tools").is_none() && mimo_none.get("tool_choice").is_none());
    assert!(choose(CompatProfile::mimo_oauth(), "required", None).get("tool_choice").is_none());
    // A plain endpoint knows `none` only.
    let plain = CompatChatCodec::new(CompatProfile::plain("p", "http://localhost:8080/v1", CredentialKind::Keyless), CompatConfig::default());
    let mut request = base_request("m");
    request.options.tool_choice = Some("required".into());
    assert!(body_of(&plain, &request).get("tool_choice").is_none());
}

#[test]
fn media_and_tool_results_lower_to_chat_content() {
    let codec = plain_codec();
    let mut request = base_request("m");
    let mut user = Message::new(
        Role::User,
        Content::Parts(vec![
            ContentPart::Text("look".into(), None),
            ContentPart::Image(ImageSource::Base64 { data: "AAAA".into(), mime_type: "image/png".into(), width: None, height: None }),
        ]),
    );
    user.source = None;
    request.messages = vec![user];
    let body = body_of(&codec, &request);
    assert_eq!(
        body["messages"][0]["content"],
        json!([
            {"type": "text", "text": "look"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        ])
    );
}

#[test]
fn an_image_inside_a_tool_result_follows_the_tool_messages_as_a_user_turn() {
    let codec = plain_codec();
    let mut request = followup_request("m");
    request.messages[3].content = Content::Parts(vec![ContentPart::Image(ImageSource::Url("https://x/y.png".into()))]);
    let body = body_of(&codec, &request);
    assert_eq!(body["messages"][3]["role"], "tool");
    assert_eq!(body["messages"][3]["content"], "[tool result included media content in the following user message]");
    assert_eq!(body["messages"][4], json!({"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://x/y.png"}}]}));
}

#[test]
fn an_unanswered_tool_call_is_stubbed_and_a_bad_id_is_projected() {
    let codec = plain_codec();
    let mut request = followup_request("m");
    request.messages.pop();
    request.messages[2].tool_calls[0].id = "toolu/odd id".into();
    let body = body_of(&codec, &request);
    let id = body["messages"][2]["tool_calls"][0]["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("toolu_odd_id_"), "{id}");
    assert_eq!(body["messages"][3]["tool_call_id"], id.as_str());
    assert_eq!(body["messages"][3]["content"], "Cancelled");
}

#[test]
fn an_empty_completion_completes_and_the_policy_bounds_the_re_asks() {
    let sse = "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    let events = decode(&plain_codec(), sse.as_bytes(), 5);
    assert_eq!(stop_of(&events), StopReason::Other("stop".to_owned()));
    // Muse asks at most twice; xai and deepseek are bounded by their request row.
    let reasks = |p: CompatProfile| p.retry_policy().empty_response_reasks;
    assert_eq!(reasks(CompatProfile::muse_code_oauth()), Some(2));
    assert_eq!(reasks(CompatProfile::xai()), Some(14));
    assert_eq!(reasks(CompatProfile::deepseek()), Some(5));
    assert_eq!(reasks(CompatProfile::mimo_oauth()), None);
    assert_eq!(reasks(CompatProfile::command_code_oauth()), None);
}

#[test]
fn billed_cost_is_read_from_the_dialect_field() {
    let usage = "data: {\"choices\":[{\"delta\":{\"content\":\"x\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"cost\":0.0014608,\"cost_in_usd_ticks\":7}}\n\ndata: [DONE]\n\n";
    let cost = |profile: CompatProfile| {
        let codec = CompatChatCodec::new(profile, CompatConfig::default());
        decode(&codec, usage.as_bytes(), 9).iter().find_map(|e| match e {
            StreamEvent::Usage(u) => Some(u.cost),
            _ => None,
        })
    };
    use mixdog_core_api::domain::provider::UsdTicks;
    assert_eq!(cost(CompatProfile::openrouter()), Some(Some(UsdTicks(14_608_000))));
    assert_eq!(cost(CompatProfile::xai()), Some(Some(UsdTicks(7))));
    assert_eq!(cost(CompatProfile::deepseek()), Some(None));
}

#[test]
fn a_gateway_failure_in_the_stream_is_typed() {
    let codec = plain_codec();
    for (reason, status) in [("network_error", None), ("error", Some(502))] {
        let sse = format!("data: {{\"choices\":[{{\"delta\":{{\"content\":\"hi\"}},\"finish_reason\":\"{reason}\"}}]}}\n\ndata: [DONE]\n\n");
        let mut decoder = codec.decoder(&base_request("m"));
        // The text decoded before the failure in the same chunk is delivered first; the failure ends the stream.
        let first = decoder.feed(sse.as_bytes()).expect(reason);
        assert!(first.iter().any(|e| matches!(e, StreamEvent::TextDelta(_))), "{reason}");
        let err = decoder.finish().expect_err(reason);
        assert_eq!(err.kind, ErrorKind::Transient, "{reason}");
        assert_eq!(err.status, status, "{reason}");
        assert!(err.exposure.text_emitted);
    }
    // An error payload inside the stream goes through the one classifier.
    let sse = "data: {\"error\":{\"code\":\"rate_limit_exceeded\",\"message\":\"slow\"}}\n\n";
    let mut decoder = codec.decoder(&base_request("m"));
    let err = decoder.feed(sse.as_bytes()).expect_err("in-band error");
    assert_eq!(err.kind, ErrorKind::RateLimited);
    // xAI re-asks an in-band invalid request.
    let xai = CompatChatCodec::new(CompatProfile::xai(), CompatConfig::default());
    let sse = "data: {\"error\":{\"code\":\"invalid_request\",\"message\":\"x\"}}\n\n";
    let err = xai.decoder(&base_request("m")).feed(sse.as_bytes()).expect_err("in-band error");
    assert_eq!(err.kind, ErrorKind::Transient);
}

#[test]
fn a_cut_or_filtered_turn_never_dispatches_its_tool_calls() {
    let codec = plain_codec();
    let sse = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"k\"}}]}}]}\n\n\
               data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n";
    let mut decoder = codec.decoder(&base_request("m"));
    // `normalizeCompatChatResponse` fails the turn; the call (its cut arguments ride as the invalid-arguments marker) is
    // held by the error and never dispatched.
    decoder.feed(sse.as_bytes()).unwrap();
    let err = decoder.finish().expect_err("a cut turn that holds a call fails");
    assert_eq!((err.kind, err.code.as_deref()), (ErrorKind::Unknown, Some("PROVIDER_INCOMPLETE")));
    assert_eq!(err.partial_tool_calls.len(), 1);
    assert_eq!(err.partial_tool_calls[0].name, "lookup");
    assert_eq!(err.partial_tool_calls[0].arguments["__rawArguments"], "{\"k");
    assert!(!err.exposure.tool_dispatched);
}

/// A provider that omits the call's id: the call gets a minted one, so its result reaches the model.
#[test]
fn a_streamed_tool_call_without_an_id_gets_one() {
    let codec = plain_codec();
    let sse = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}

data: [DONE]

";
    let events = decode(&codec, sse.as_bytes(), 5);
    let calls = tool_calls_of(&events);
    assert_eq!(calls.len(), 1);
    assert!(calls[0].id.starts_with("call_") && calls[0].id.len() > 5, "{}", calls[0].id);
    let started = events.iter().find_map(|e| match e {
        StreamEvent::ToolCallStart { id, .. } => Some(id.clone()),
        _ => None,
    });
    assert_eq!(started.as_deref(), Some(calls[0].id.as_str()));
}

#[test]
fn malformed_tool_arguments_ride_as_data_after_a_finish() {
    let codec = plain_codec();
    let sse = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"k\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
    let events = decode(&codec, sse.as_bytes(), 3);
    let calls = tool_calls_of(&events);
    assert_eq!(calls[0].arguments["__invalidToolArgs"], true);
    assert_eq!(calls[0].arguments["__rawArguments"], "{\"k");
    // The text the model reads is V8's (`JSON.parse('{"k')` on Node v22.20.0), not the Rust parser's.
    assert_eq!(calls[0].arguments["__parseError"], "Unterminated string in JSON at position 3 (line 1 column 4)");
}

#[test]
fn a_malformed_frame_reads_as_nodes_malformed_stream_error() {
    // `malformedCompatStreamError(label, SyntaxError)` over the SDK's `JSON.parse` of the frame (Node v22.20.0).
    let codec = plain_codec();
    let mut decoder = codec.decoder(&base_request("m"));
    let events = decoder
        .feed(b"data: {\"choices\":[{\"delta\":{\"content\":\"good \"}}]}\n\ndata: {not json at all\n\n")
        .expect("the events before the frame come first");
    assert_eq!(text_of(&events), "good ");
    let err = decoder.feed(b"").expect_err("the stored failure");
    assert_eq!(err.code.as_deref(), Some("malformed_stream"));
    assert_eq!(err.message, "groq malformed stream frame: Expected property name or '}' in JSON at position 1 (line 1 column 2)");
    assert!(err.exposure.text_emitted);
}

#[test]
fn calls_sharing_an_id_are_dispatched_once_and_returned_both() {
    // `emitCompatToolCallOnce` dispatches one call per id; the turn still returns the parsed list whole
    // (`settleCompatStream`), and the loop's id resolver renames the second.
    let codec = plain_codec();
    let call = |index: u32, key: &str| json!({"index": index, "id": "c", "type": "function", "function": {"name": "lookup", "arguments": json!({"key": key}).to_string()}});
    let chunk = json!({"choices": [{"delta": {"tool_calls": [call(0, "a"), call(1, "b")]}, "finish_reason": "tool_calls"}]});
    let events = decode(&codec, format!("data: {chunk}\n\ndata: [DONE]\n\n").as_bytes(), 7);
    let dispatched = tool_calls_of(&events);
    assert_eq!(dispatched.len(), 1);
    assert_eq!(dispatched[0].arguments, json!({"key": "a"}));
    let returned = events
        .iter()
        .find_map(|e| match e {
            StreamEvent::ReturnedCalls(calls) => Some(calls.clone()),
            _ => None,
        })
        .expect("the returned list");
    let returned: Vec<(String, JsonValue)> = returned.into_iter().map(|c| (c.id, c.arguments)).collect();
    assert_eq!(returned, [("c".to_owned(), json!({"key": "a"})), ("c".to_owned(), json!({"key": "b"}))]);
}

// Retry policy rows

fn profiles() -> Vec<CompatProfile> {
    vec![
        CompatProfile::xai(),
        CompatProfile::deepseek(),
        CompatProfile::openrouter(),
        CompatProfile::mimo_oauth(),
        CompatProfile::muse_code_oauth(),
        CompatProfile::command_code_oauth(),
        CompatProfile::opencode_go(),
    ]
}

#[test]
fn every_profile_has_a_valid_policy_without_recovery_cycles() {
    for profile in profiles() {
        let policy = profile.retry_policy();
        check_retry_policy(&policy);
        let profiled = policy.final_on_exhaust;
        assert_eq!(policy.recovery.is_none(), profiled, "{}: recovery cycles are off for profiled providers", profile.id);
    }
}

fn status_error(kind: ErrorKind, status: u16, advice: Option<u64>) -> mixdog_core_api::domain::provider::ProviderError {
    let mut err = mixdog_core_api::domain::provider::ProviderError::new(kind, DeliveryState::Accepted);
    err.status = Some(status);
    err.retry_after = advice.map(Duration::from_secs);
    err
}

fn verdict_for(profile: &CompatProfile, err: &mixdog_core_api::domain::provider::ProviderError, retries_done: u32) -> Verdict {
    let policy = profile.retry_policy();
    let decider = StandardRetryDecider;
    let samples = mixdog_core_api::domain::retry::JitterSamples { step: 0.5, advice: 0.5 };
    let mut state = RetryState::new(RetryClass::Request, "m");
    for _ in 0..retries_done {
        let decision = decider.verdict(err, &state, &policy, samples);
        assert!(matches!(decision.verdict, Verdict::Retry { .. }), "driving retries");
        state = decision.next;
    }
    decider.verdict(err, &state, &policy, samples).verdict
}

fn retry_delay(verdict: &Verdict) -> Option<Duration> {
    match verdict {
        Verdict::Retry { delay, .. } => Some(*delay),
        _ => None,
    }
}

#[test]
fn profile_numbers_drive_the_one_verdict() {
    let transient = status_error(ErrorKind::Transient, 503, None);
    // xai: 15 sends = 14 retries, 2 s first step.
    let xai = CompatProfile::xai();
    assert_eq!(retry_delay(&verdict_for(&xai, &transient, 0)), Some(Duration::from_secs(2)));
    assert_eq!(retry_delay(&verdict_for(&xai, &transient, 5)), Some(Duration::from_secs(30)));
    assert_eq!(retry_delay(&verdict_for(&xai, &transient, 13)), Some(Duration::from_secs(30)));
    assert_eq!(verdict_for(&xai, &transient, 14), Verdict::Exhausted);
    // xai's terminal statuses surface at once.
    assert_eq!(verdict_for(&xai, &status_error(ErrorKind::Transient, 409, None), 0), Verdict::Surface);

    // command-code retries exactly 500/502/503/504/520/521/522, 3 sends.
    let cc = CompatProfile::command_code_oauth();
    assert!(retry_delay(&verdict_for(&cc, &status_error(ErrorKind::Transient, 502, None), 0)).is_some());
    assert_eq!(verdict_for(&cc, &status_error(ErrorKind::RateLimited, 429, None), 0), Verdict::Surface);
    assert_eq!(verdict_for(&cc, &status_error(ErrorKind::Transient, 501, None), 0), Verdict::Surface);
    assert_eq!(verdict_for(&cc, &status_error(ErrorKind::Transient, 502, None), 2), Verdict::Exhausted);

    // Retry-After ceilings: deepseek 10 s, muse 60 s, mimo 300 s, unprofiled 60 s.
    for (profile, ceiling) in
        [(CompatProfile::deepseek(), 10), (CompatProfile::muse_code_oauth(), 60), (CompatProfile::mimo_oauth(), 300), (CompatProfile::openrouter(), 60)]
    {
        let at = status_error(ErrorKind::RateLimited, 429, Some(ceiling));
        assert_eq!(retry_delay(&verdict_for(&profile, &at, 0)), Some(Duration::from_secs(ceiling)), "{} waits advice up to its ceiling in full", profile.id);
        let over = status_error(ErrorKind::RateLimited, 429, Some(ceiling + 1));
        assert_eq!(verdict_for(&profile, &over, 0), Verdict::Exhausted, "{}", profile.id);
    }
}

#[test]
fn seeded_model_facts_fill_what_the_listing_lacks() {
    // The legacy Grok generation rejects effort; the listing does not say so.
    let xai = CompatProfile::xai();
    let codec = CompatChatCodec::new(xai.clone(), CompatConfig::for_profile(&xai));
    let mut request = base_request("grok-4-fast");
    request.options.effort = Some("high".into());
    assert!(body_of(&codec, &request).get("reasoning_effort").is_none());
    request.model = "grok-4.3".into();
    assert_eq!(body_of(&codec, &request)["reasoning_effort"], "high");

    // A model whose catalog entry emits no text is not a chat model; the
    // listing's own statement still wins over the catalog.
    let table = CompatProfile::mimo_oauth().model_table();
    table.replace(parse_models(&json!([
        {"id": "voice-x"}, {"id": "chat-x"}, {"id": "listed", "modalities": {"output": ["text"]}},
    ])));
    table.fill_output_modalities(|id| match id {
        "voice-x" => Some(vec!["audio".into()]),
        "chat-x" => Some(vec!["text".into(), "audio".into()]),
        "listed" => Some(vec!["audio".into()]),
        _ => None,
    });
    let ids: Vec<String> = table.chat_models().iter().map(|m| m.id.clone()).collect();
    assert_eq!(ids, ["chat-x", "listed"]);
    // Seeds cover only models with no catalog entry, and only ids Node's
    // `-tts` / `-asr` rule also matches.
    for seed in CompatProfile::mimo_oauth().seed_models.iter().filter(|s| s.mode == Some("audio")) {
        assert!(seed.id.contains("-tts") || seed.id.contains("-asr"), "{}", seed.id);
    }

    // MiMo speech models are not chat models; the listing's own kind wins.
    let mimo = CompatProfile::mimo_oauth();
    let table = mimo.model_table();
    table.replace(parse_models(&json!([
        {"id": "mimo-v2.6-pro"}, {"id": "mimo-v2.5-tts"}, {"id": "mimo-v2-asr", "type": "chat"},
    ])));
    let chat: Vec<String> = table.chat_models().iter().map(|m| m.id.clone()).collect();
    assert_eq!(chat, ["mimo-v2-asr", "mimo-v2.6-pro"]);
}

#[test]
fn tiered_system_messages_go_out_as_node_sends_them() {
    // Recorded from Node: `toOpenAIMessages(seedSessionMessages(…), 'openrouter',
    // {cacheControl: true})` yields plain string system content and no
    // `cache_control`: nothing in Node sets a marker on an internal message part
    // (only the Anthropic builders write markers, on their own output).
    let recorded = json!([
        {"role":"system","content":"rules"},{"role":"system","content":"stable"},
        {"role":"system","content":"core"},{"role":"system","content":"env"},
        {"role":"user","content":"hi"}
    ]);
    let or = CompatProfile::openrouter();
    let codec = CompatChatCodec::new(or.clone(), CompatConfig::for_profile(&or));
    let mut request = base_request("m");
    let mut core = text_message(Role::System, "core");
    core.cache_tier = Some(CacheTier::Tier3);
    let mut env = text_message(Role::System, "env");
    env.cache_tier = Some(CacheTier::Env);
    request.messages = vec![text_message(Role::System, "rules"), text_message(Role::System, "stable"), core, env, text_message(Role::User, "hi")];
    assert_eq!(body_of(&codec, &request)["messages"], recorded);
}

// Responses wire against the recorded heads

mod responses_heads {
    use super::*;
    use crate::providers::compat::responses::CompatResponsesCodec;
    use mixdog_core_api::domain::keepalive::TransportKind;

    fn muse_codec() -> CompatResponsesCodec {
        let profile = CompatProfile::muse_code_oauth();
        let config = CompatConfig { models: profile.model_table(), ..CompatConfig::default() };
        CompatResponsesCodec::new(profile, config, TransportKind::Http1)
    }

    fn muse_body(request: &ModelRequest) -> JsonValue {
        serde_json::from_slice(&muse_codec().encode(request).unwrap().body).unwrap()
    }

    #[test]
    fn a_blank_explicit_cache_key_suppresses_caching_even_with_a_session() {
        let mut request = base_request("muse-spark-1.3");
        request.options.session_id = Some("s-1".into());
        request.options.prompt_cache_key = Some("  ".into());
        assert!(muse_body(&request).get("prompt_cache_key").is_none());
        request.options.prompt_cache_key = None;
        assert_eq!(muse_body(&request)["prompt_cache_key"], "s-1");
    }

    #[test]
    fn muse_shapes_the_per_turn_knobs_as_node_does() {
        let keys = |body: &JsonValue| body.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        let mut request = base_request("muse-spark-1.3");
        request.options.effort = Some(" MAX ".into());
        request.options.max_output_tokens_override = Some(500_000);
        request.options.parallel_tool_calls = Some(false);
        request.options.tool_choice = Some("required".into());
        request.options.session_id = Some("s-1".into());
        request.options.temperature = mixdog_core_api::domain::provider::Temperature::new(1.0);
        let body = muse_body(&request);
        // The 1.3 revisions accept `max`; the output bound is clamped to the model's; no
        // parallel_tool_calls or tool_choice; reasoning, sampling and the cache key close the body.
        assert_eq!(body["reasoning"], json!({"effort": "max", "summary": "auto"}));
        assert_eq!(body["max_output_tokens"], 131_072);
        assert_eq!(
            keys(&body),
            ["model", "input", "store", "include", "stream", "max_output_tokens", "tools", "instructions", "reasoning", "temperature", "prompt_cache_key"]
        );
        assert_eq!(body["temperature"], json!(1));
        assert_eq!(body["prompt_cache_key"], "s-1");

        // A five-level model folds `max` down to `xhigh`.
        request.model = "muse-spark-1.2".into();
        assert_eq!(muse_body(&request)["reasoning"], json!({"effort": "xhigh", "summary": "auto"}));
        // Forced off: effort none, and no encrypted replay is requested.
        request.options.effort = Some("off".into());
        let off = muse_body(&request);
        assert_eq!(off["reasoning"], json!({"effort": "none"}));
        assert!(off.get("include").is_none());
        // No effort: no reasoning at all.
        request.options.effort = None;
        assert!(muse_body(&request).get("reasoning").is_none());
    }

    #[test]
    fn replay_envelopes_belong_to_the_compat_owner() {
        let codec = CompatResponsesCodec::new(CompatProfile::xai(), CompatConfig::default(), TransportKind::Http1);
        let sse = "data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"reasoning\",\"id\":\"rs\",\"encrypted_content\":\"E\",\"summary\":[]}}\n\n\
                   data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"status\":\"completed\",\"output\":[{\"type\":\"reasoning\",\"id\":\"rs\",\"encrypted_content\":\"E\",\"summary\":[]}]}}\n\n";
        let mut decoder = codec.decoder(&base_request("m"));
        let mut events = decoder.feed(sse.as_bytes()).unwrap();
        events.extend(decoder.finish().unwrap());
        let owners: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::ReasoningReplay(r) => Some(r.owner.as_str().to_owned()),
                _ => None,
            })
            .collect();
        assert!(!owners.is_empty() && owners.iter().all(|o| o == "xai-responses"), "{owners:?}");
    }
}

// Liveness: no content timer, half-open links end by keepalive (SPEC §4.9)

mod liveness {
    use super::*;
    use crate::providers::compat::adapter::{ApiKeySource, CompatAdapter};
    use crate::transport::{BodyStream, HttpResponse, HttpSend};
    use async_trait::async_trait;
    use bytes::Bytes;
    use mixdog_core_api::domain::conformance::{check_keepalive_schedule, check_provider_attempt, check_transport_keepalive};
    use mixdog_core_api::domain::keepalive::{KeepaliveSchedule, TransportKind};
    use mixdog_core_api::domain::mock::MockKeepalive;
    use mixdog_core_api::domain::provider::{ProviderAdapter, ProviderError, WireRequest};
    use std::sync::{Arc, Mutex};

    struct Scripted {
        status: u16,
        chunks: Vec<Vec<u8>>,
        sent: Mutex<Vec<WireRequest>>,
    }

    struct Chunks(std::vec::IntoIter<Vec<u8>>);

    #[async_trait]
    impl BodyStream for Chunks {
        async fn next(&mut self) -> Option<Result<Bytes, mixdog_core_api::domain::provider::TransportFault>> {
            self.0.next().map(|c| Ok(Bytes::from(c)))
        }
    }

    #[async_trait]
    impl HttpSend for Scripted {
        async fn send(&self, request: WireRequest, _exchange: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
            self.sent.lock().unwrap().push(request);
            Ok(HttpResponse { status: self.status, headers: vec![], body: Box::new(Chunks(self.chunks.clone().into_iter())) })
        }
    }

    struct Key(&'static str);

    #[async_trait]
    impl ApiKeySource for Key {
        async fn key(&self) -> Result<String, ProviderError> {
            Ok(self.0.into())
        }
        async fn reload(&self) -> Result<String, ProviderError> {
            Ok(self.0.into())
        }
    }

    fn adapter(status: u16, chunks: Vec<Vec<u8>>) -> (CompatAdapter, Arc<Scripted>) {
        let http = Arc::new(Scripted { status, chunks, sent: Mutex::new(Vec::new()) });
        let profile = CompatProfile::deepseek();
        let codec = CompatChatCodec::new(profile, CompatConfig::default());
        (CompatAdapter::new(codec, http.clone(), Some(Arc::new(Key("sk-test-key")))), http)
    }

    #[tokio::test]
    async fn a_refusal_is_classified_once_and_never_echoes_the_key() {
        let body = br#"{"error":{"message":"Incorrect API key provided: sk-test-key","code":"invalid_api_key"}}"#.to_vec();
        let (adapter, _) = adapter(401, vec![body]);
        let err = adapter.attempt(Arc::new(base_request("m"))).await.err().expect("refused");
        assert_eq!((err.kind, err.status), (ErrorKind::Auth, Some(401)));
        assert!(!err.message.contains("sk-test-key"), "{}", err.message);
    }

    /// `recoverCompatNonStreaming` (openai-compat-chat-send.mjs:268): the same body with `stream: false` and no
    /// `stream_options`, the response's first choice the turn (its text whole, no delta), and the line Node writes once
    /// it answered. `canFallbackNonStreaming` gates it: only a failure that showed nothing and is transient.
    #[tokio::test]
    async fn a_spent_chat_send_is_reissued_without_streaming_as_node_does() {
        use mixdog_core_api::domain::provider::{StreamEvent, TransportFault};
        let answer = br#"{"id":"r1","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"whole"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}"#.to_vec();
        let (adapter, http) = adapter(200, vec![answer]);
        let streaming = adapter.codec().encode(&base_request("m")).unwrap();
        let mut stream = adapter.recover_spent(Arc::new(base_request("m"))).await.expect("the re-issue answers");
        let mut events = Vec::new();
        while let Some(event) = stream.next().await {
            events.push(event.expect("no failure"));
        }
        assert!(events.contains(&StreamEvent::FinalContent("whole".into())), "{events:?}");
        assert!(!events.iter().any(|e| matches!(e, StreamEvent::TextDelta(_))), "no text delta streams");
        assert!(matches!(events.last(), Some(StreamEvent::Completed { .. })), "{events:?}");
        let sent = http.sent.lock().unwrap();
        let (mut expected, sent_body): (JsonValue, JsonValue) =
            (serde_json::from_slice(&streaming.body).unwrap(), serde_json::from_slice(&sent[0].body).unwrap());
        assert_eq!(expected["stream"], true);
        expected["stream"] = json!(false);
        expected.as_object_mut().unwrap().remove("stream_options");
        assert_eq!(sent_body, expected);
        assert_eq!(sent[0].url, streaming.url);

        let cut = ProviderError::transport(TransportFault::TruncatedStream, DeliveryState::Accepted);
        assert!(adapter.recovers_spent(&base_request("m"), &cut));
        assert_eq!(adapter.recovery_line("m", &cut).as_deref(), Some("[deepseek] stream failed (unknown); recovered via non-streaming request"));
        let mut shown = cut.clone();
        shown.exposure.text_emitted = true;
        assert!(!adapter.recovers_spent(&base_request("m"), &shown), "shown text is the loop's retraction replay");
        let mut refused = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::Accepted);
        refused.status = Some(400);
        assert!(!adapter.recovers_spent(&base_request("m"), &refused));
    }

    fn go_listing(config: JsonValue, models_dev: JsonValue) -> CompatAdapter {
        let http = Arc::new(Scripted { status: 200, chunks: vec![serde_json::to_vec(&config).unwrap()], sent: Mutex::new(Vec::new()) });
        let profile = CompatProfile::opencode_go();
        let config = CompatConfig::for_profile(&profile);
        CompatAdapter::new(CompatChatCodec::new(profile, config), http, Some(Arc::new(Key("k"))))
            .with_listing_lookup(crate::catalog::ListingLookup::with_models_dev(&models_dev))
    }

    /// A console config that lists no models takes the models.dev rows of the same provider key, in the config's own
    /// model shape; a config without the provider's entry is unusable even when the catalog has rows.
    #[tokio::test]
    async fn an_empty_console_config_falls_back_to_the_catalog_rows_and_a_missing_provider_is_an_error() {
        use mixdog_core_api::domain::provider::ModelListing;
        let crate::providers::compat::profile::ListingShape::ConsoleConfig { provider_key, .. } = CompatProfile::opencode_go().listing.shape else {
            panic!("OpenCode Go reads the console config")
        };
        let dev = json!({ provider_key: {"models": {"dev-model": {"name": "Dev Model", "limit": {"context": 1000, "output": 100}}}} });
        let rows = go_listing(json!({"providers": {provider_key: {"models": {}}}}), dev.clone()).list_models().await.unwrap();
        assert_eq!(rows.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["dev-model"]);
        assert_eq!((rows[0].name.as_deref(), rows[0].context_window, rows[0].max_output_tokens), (Some("Dev Model"), Some(1000), Some(100)));

        let error = go_listing(json!({"providers": {}}), dev).list_models().await.unwrap_err();
        assert!(error.message.contains("has no OpenCode Go provider"), "{}", error.message);

        let none = json!({ provider_key: {"models": {}} });
        let error = go_listing(json!({"providers": {provider_key: {"models": {}}}}), none).list_models().await.unwrap_err();
        assert!(error.message.contains("lists no models") && error.message.contains("unavailable"), "{}", error.message);
    }

    /// `if (!choice) return null`: a response without a choice fails the re-issue.
    #[tokio::test]
    async fn a_reissue_without_a_choice_fails() {
        let (adapter, _) = adapter(200, vec![br#"{"choices":[]}"#.to_vec()]);
        assert!(adapter.recover_spent(Arc::new(base_request("m"))).await.is_err());
    }

    #[test]
    fn a_half_open_link_ends_as_a_keepalive_failure_within_the_schedule() {
        let (adapter, _) = adapter(200, vec![]);
        assert_eq!(adapter.keepalive(), &KeepaliveSchedule::SPEC);
        check_keepalive_schedule(adapter.keepalive());
        let link = MockKeepalive::new(TransportKind::Http1);
        check_transport_keepalive(&link, adapter.keepalive(), || link.go_half_open());
        // The schedule bounds how long such a link stays undetected.
        assert_eq!(adapter.keepalive().tcp_detection_bound(), std::time::Duration::from_secs(360));
    }

    /// No module of the family arms a content timer: the only clock it may
    /// read is the one that dates a `Retry-After` header or a reset field.
    #[test]
    #[allow(clippy::disallowed_methods, reason = "test fixture read")]
    fn no_content_timer_exists_in_the_family() {
        let banned = [
            ["tokio::time", "::timeout"].concat(),
            ["tokio::time", "::sleep"].concat(),
            ["time", "::timeout("].concat(),
            ["Instant", "::now"].concat(),
            ["Sleep", "Until"].concat(),
            ["set", "Timeout"].concat(),
        ];
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/providers/compat");
        let mut stack = vec![root];
        let mut scanned = 0;
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") && path.file_name().is_some_and(|n| n != "tests.rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    // The rule is for what ships: a module's inline test module (`#[cfg(test)] mod x {`, trailing) may drive the
                    // idle watchdog under a paused clock. A `#[cfg(test)] mod x;` declaration (mod.rs) does not end the scanned part.
                    let cut = text
                        .match_indices("\n#[cfg(test)]\nmod ")
                        .map(|(at, _)| at)
                        .find(|&at| text[at..].lines().nth(2).is_some_and(|line| line.trim_end().ends_with('{')))
                        .unwrap_or(text.len());
                    let mut text = text[..cut].to_owned();
                    // The one deadline the family arms is Node's WebSocket `handshakeTimeout` on xAI's socket
                    // (`openai-ws-pool.mjs:625`, `PROVIDER_WS_HANDSHAKE_TIMEOUT_MS` 30_000): it bounds the upgrade, before
                    // any content, and never decides when a response ends.
                    if path.file_name().is_some_and(|n| n == "xai_transport.rs") {
                        const HANDSHAKE: &str = "mixdog_rt::time::timeout(Duration::from_secs(30), self.0.dial.dial(handshake))";
                        assert_eq!(text.matches(HANDSHAKE).count(), 1, "{}: the handshake deadline, once", path.display());
                        text = text.replacen(HANDSHAKE, "", 1);
                    }
                    for pattern in &banned {
                        assert!(!text.contains(pattern.as_str()), "{} uses {pattern}", path.display());
                    }
                    scanned += 1;
                }
            }
        }
        assert!(scanned >= 10, "the scan saw the module tree ({scanned} files)");
    }
    #[tokio::test]
    async fn a_stream_attempt_ends_with_one_terminal_and_the_key_rides_as_a_bearer() {
        let sse = TEXT_SSE.as_bytes();
        let (adapter, http) = adapter(200, vec![sse[..60].to_vec(), sse[60..].to_vec()]);
        check_provider_attempt(&adapter, Arc::new(base_request("m")), DeliveryState::Accepted).await;
        let sent = http.sent.lock().unwrap();
        assert!(sent[0].headers.contains(&("authorization".into(), "Bearer sk-test-key".into())));
    }

    const TEXT_SSE: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"The result is 42.\"}}]}\n\n\
        data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

    /// A body that gives its first chunk and then stays silent, counting the bodies dropped.
    struct Silent {
        first: Option<Vec<u8>>,
        released: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Drop for Silent {
        fn drop(&mut self) {
            self.released.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[async_trait]
    impl BodyStream for Silent {
        async fn next(&mut self) -> Option<Result<Bytes, mixdog_core_api::domain::provider::TransportFault>> {
            match self.first.take() {
                Some(chunk) => Some(Ok(Bytes::from(chunk))),
                None => std::future::pending().await,
            }
        }
    }

    struct SilentHttp(Arc<std::sync::atomic::AtomicUsize>);

    #[async_trait]
    impl HttpSend for SilentHttp {
        async fn send(&self, _: WireRequest, _: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
            let first = b"data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n".to_vec();
            Ok(HttpResponse { status: 200, headers: vec![], body: Box::new(Silent { first: Some(first), released: self.0.clone() }) })
        }
    }

    fn silent_adapter() -> (CompatAdapter, Arc<std::sync::atomic::AtomicUsize>) {
        let released = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let codec = CompatChatCodec::new(CompatProfile::deepseek(), CompatConfig::default());
        (CompatAdapter::new(codec, Arc::new(SilentHttp(released.clone())), Some(Arc::new(Key("sk-test-key")))), released)
    }

    /// Cancelling is dropping the stream: the pending read and the body behind it are released at once.
    #[tokio::test]
    async fn dropping_a_stream_that_is_waiting_for_bytes_releases_its_body() {
        let (adapter, released) = silent_adapter();
        let mut stream = adapter.attempt(Arc::new(base_request("m"))).await.expect("attempt");
        let mut seen = Vec::new();
        while let Some(event) = stream.next().await {
            seen.push(event.expect("no failure"));
            if seen.iter().any(|e| matches!(e, mixdog_core_api::domain::provider::StreamEvent::TextDelta(_))) {
                break;
            }
        }
        assert_eq!(released.load(std::sync::atomic::Ordering::SeqCst), 0, "still open while the caller reads");
        let waiting = tokio::time::timeout(Duration::from_millis(50), stream.next()).await;
        assert!(waiting.is_err(), "the silent link has nothing to deliver");
        drop(stream);
        assert_eq!(released.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// The decoders and modules of the family arm no content timer (`no_content_timer_exists_in_the_family`); the one
    /// bound on a silent stream is the model-exchange driver's semantic idle window (300 s by default), which fails the
    /// read as a transient stream stall once output has started. Before the window the read just waits.
    #[tokio::test(start_paused = true)]
    async fn a_silent_stream_waits_for_the_idle_window_and_then_fails_as_a_transient_stall() {
        use mixdog_core_api::domain::provider::StreamEvent;
        let (adapter, _released) = silent_adapter();
        let mut stream = adapter.attempt(Arc::new(base_request("m"))).await.expect("attempt");
        let mut text = false;
        while !text {
            text = matches!(stream.next().await, Some(Ok(StreamEvent::TextDelta(_))));
        }
        let early = tokio::time::timeout(Duration::from_secs(200), stream.next()).await;
        assert!(early.is_err(), "inside the window the read waits");
        let stalled = tokio::time::timeout(Duration::from_secs(3600), stream.next()).await.expect("the window ends the wait");
        let error = stalled.expect("the stream reports its end").expect_err("a stall is a failure, not a clean end");
        assert_eq!((error.code.as_deref(), error.kind, error.timed_out), (Some("ESTREAMSTALL"), ErrorKind::Transient, true));
        assert!(error.message.contains("SSE idle stream timed out after 300000ms of inactivity"), "{}", error.message);
    }
}

/// Recorded from Node's `withRetry` with a 503 on every call, a stubbed
/// sleep and `Math.random` pinned to 0, 0.5 and 1: 5 calls, and the waits
/// below (the default `[250, 1000, …]` schedule reads index n for retry n,
/// with the shared ±20 % jitter).
#[test]
fn the_unprofiled_default_equals_nodes_retry_loop() {
    let recorded: [(f64, [u64; 4]); 3] = [(0.0, [800, 1600, 3200, 6400]), (0.5, [1000, 2000, 4000, 8000]), (1.0, [1200, 2400, 4800, 9600])];
    let policy = CompatProfile::openrouter().retry_policy();
    let err = status_error(ErrorKind::Transient, 503, None);
    for (random, delays) in recorded {
        let samples = mixdog_core_api::domain::retry::JitterSamples { step: random, advice: random };
        let mut state = RetryState::new(RetryClass::Request, "m");
        let mut waited = Vec::new();
        loop {
            let decision = StandardRetryDecider.verdict(&err, &state, &policy, samples);
            match decision.verdict {
                Verdict::Retry { delay, .. } => waited.push(delay.as_millis() as u64),
                _ => break,
            }
            state = decision.next;
        }
        assert_eq!(waited, delays, "Math.random = {random}");
    }
}

#[test]
fn per_status_caps_are_carried_as_data() {
    assert_eq!(CompatProfile::xai().retry_policy().status.caps, [(429, 1)]);
    assert_eq!(CompatProfile::mimo_oauth().retry_policy().status.caps, [(429, 5)]);
}

// Chat Completions: recorded bodies and streams

// Intercepted providers: MiMo and Command Code

/// The real-turn harness's provider (`lib/fake-provider.mjs`, `scenarios.mjs` `toolCall`): the
/// call's JSON arguments cut in half over two `index: 0` deltas, the second carrying no id or
/// name, then the finish chunk and a usage-only chunk. The tool gets the whole object, wherever
/// the body is cut.
#[test]
fn a_tool_call_streamed_in_two_argument_deltas_reaches_the_tool_whole() {
    let frame = |delta: JsonValue, finish: JsonValue| {
        let chunk = json!({
            "id": "chatcmpl-harness", "object": "chat.completion.chunk", "created": 1700000000, "model": "harness-model",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        });
        format!("data: {chunk}\n\n")
    };
    let arguments = json!({"path": "hello.txt"}).to_string();
    let (first, second) = arguments.split_at(arguments.len() / 2);
    let mut sse = String::new();
    sse.push_str(&frame(json!({"role": "assistant", "content": ""}), JsonValue::Null));
    sse.push_str(&frame(json!({"content": "I will read the file."}), JsonValue::Null));
    sse.push_str(&frame(
        json!({"tool_calls": [{"index": 0, "id": "call_harness_1", "type": "function", "function": {"name": "read", "arguments": first}}]}),
        JsonValue::Null,
    ));
    sse.push_str(&frame(json!({"tool_calls": [{"index": 0, "function": {"arguments": second}}]}), JsonValue::Null));
    sse.push_str(&frame(json!({}), json!("tool_calls")));
    let usage = json!({"id": "chatcmpl-harness", "object": "chat.completion.chunk", "model": "harness-model", "choices": [],
        "usage": {"prompt_tokens": 1200, "completion_tokens": 24, "total_tokens": 1224}});
    sse.push_str(&format!("data: {usage}\n\ndata: [DONE]\n\n"));

    let codec = plain_codec();
    for split in [0, sse.len() / 3, sse.len() / 2, sse.len()] {
        let events = decode(&codec, sse.as_bytes(), split);
        assert_eq!(
            tool_calls_of(&events),
            [ToolCall { id: "call_harness_1".into(), name: "read".into(), arguments: json!({"path": "hello.txt"}), native_type: None }],
            "split at {split}"
        );
        assert_eq!(stop_of(&events), StopReason::ToolUse);
    }
}
