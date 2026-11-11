//! Conformance of the OpenAI-compatible family against the recorded
//! fixtures (`fixtures/providers/openai-compat-chat`,
//! `fixtures/providers-intercepted/{mimo,command-code}-oauth`) and the
//! provider-neutral checks of `mixdog-core-api`.

use std::path::PathBuf;
use std::time::Duration;

use mixdog_core_api::domain::conformance::{check_retry_policy, check_wire_codec};
use mixdog_core_api::domain::provider::{
    CacheTier, Content, ContentPart, DeliveryState, ErrorKind, ErrorResponse, ImageSource, Message,
    ModelRequest, ProviderReplay, RequestOptions, Role, StopReason, StreamEvent, ToolCall,
    ToolDefinition, TransportFault, WireCodec,
};
use mixdog_core_api::domain::retry::{RetryClass, RetryDecider, RetryState, Verdict};
use mixdog_protocol::{JsonValue, ProviderId};
use serde_json::json;

use super::chat::{CompatChatCodec, CompatConfig};
use super::models::{ModelTable, parse_models};
use super::profile::{CompatProfile, CredentialKind};
use crate::retry::StandardRetryDecider;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

#[allow(clippy::disallowed_methods, reason = "test fixture read")]
fn read(path: &str) -> Vec<u8> {
    std::fs::read(fixtures().join(path)).unwrap_or_else(|e| panic!("fixture {path}: {e}"))
}

fn read_json(path: &str) -> JsonValue {
    serde_json::from_slice(&read(path)).unwrap_or_else(|e| panic!("fixture {path}: {e}"))
}

/// The wire fixture's request body, as the recorder saw it.
fn recorded_chat_body(records: &JsonValue, field: &str) -> JsonValue {
    let record = records
        .as_array()
        .and_then(|rs| {
            rs.iter()
                .rev()
                .find(|r| r["path"].as_str().is_some_and(|p| p.ends_with("/chat/completions")))
        })
        .expect("a chat completions record");
    serde_json::from_str(record[field].as_str().expect("request body text")).expect("body json")
}

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
        messages: vec![
            text_message(Role::System, "You are a fixture assistant."),
            text_message(Role::User, "Look up the answer."),
        ],
        tools: vec![lookup_tool()],
        options: RequestOptions::default(),
    }
}

fn followup_request(model: &str) -> ModelRequest {
    let mut request = base_request(model);
    let mut call = text_message(Role::Assistant, "");
    call.tool_calls = vec![ToolCall {
        id: "call_fx1".into(),
        name: "lookup".into(),
        arguments: json!({"key": "answer"}),
        native_type: None,
    }];
    let mut result = text_message(Role::Tool, "42");
    result.tool_call_id = Some("call_fx1".into());
    request.messages.extend([call, result]);
    request
}

fn plain_codec() -> CompatChatCodec {
    let profile = CompatProfile::plain(
        "groq",
        "https://api.groq.com/v1",
        CredentialKind::StaticKey {
            reauth_on_401: false,
        },
    );
    CompatChatCodec::new(profile, CompatConfig::default())
}

fn mimo_codec() -> CompatChatCodec {
    CompatChatCodec::new(
        CompatProfile::mimo_oauth(),
        CompatConfig {
            client_version: "1.4.5".into(),
            ..CompatConfig::default()
        },
    )
}

fn command_code_codec() -> CompatChatCodec {
    CompatChatCodec::new(CompatProfile::command_code_oauth(), CompatConfig::default())
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

fn usage_of(events: &[StreamEvent]) -> Option<(u64, u64)> {
    events.iter().find_map(|e| match e {
        StreamEvent::Usage(u) => Some((u.input_tokens, u.output_tokens)),
        _ => None,
    })
}

fn stop_of(events: &[StreamEvent]) -> StopReason {
    match events.last() {
        Some(StreamEvent::Completed { stop: Some(stop), .. }) => stop.clone(),
        other => panic!("the last event is the terminal one, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Chat Completions: recorded bodies and streams
// ---------------------------------------------------------------------------

#[test]
fn chat_requests_match_the_recorded_bodies() {
    let codec = plain_codec();
    for (case, request) in [
        ("text", base_request("fixture-model")),
        ("tool-call", base_request("fixture-model")),
        ("tool-result-followup", followup_request("fixture-model")),
    ] {
        let recorded = read_json(&format!("providers/openai-compat-chat/{case}/request.json"));
        let want = recorded_chat_body(&recorded["requests"], "bodyText");
        assert_eq!(body_of(&codec, &request), want, "{case}");
    }
    let wire = codec.encode(&base_request("fixture-model")).unwrap();
    assert_eq!(wire.method, "POST");
    assert_eq!(wire.url, "https://api.groq.com/v1/chat/completions");
}

#[test]
fn chat_streams_decode_to_the_recorded_results() {
    let codec = plain_codec();
    for case in ["text", "tool-result-followup"] {
        let sse = read(&format!("providers/openai-compat-chat/{case}/response.sse"));
        let result = read_json(&format!("providers/openai-compat-chat/{case}/result.json"));
        for split in [0, 7, sse.len() / 2, sse.len()] {
            let events = decode(&codec, &sse, split);
            assert_eq!(text_of(&events), result["ok"]["content"].as_str().unwrap(), "{case}");
            assert_eq!(usage_of(&events), Some((20, 8)), "{case}");
            assert_eq!(stop_of(&events), StopReason::Other("stop".to_owned()), "{case}");
            let raw = events.iter().find_map(|e| match e {
                StreamEvent::Usage(u) => u.raw.clone(),
                _ => None,
            });
            assert_eq!(raw.as_ref(), Some(&result["ok"]["usage"]["raw"]), "{case}");
        }
    }
    let sse = read("providers/openai-compat-chat/tool-call/response.sse");
    let result = read_json("providers/openai-compat-chat/tool-call/result.json");
    let events = decode(&codec, &sse, 100);
    let want = &result["ok"]["toolCalls"][0];
    assert_eq!(
        tool_calls_of(&events),
        [ToolCall {
            id: want["id"].as_str().unwrap().into(),
            name: want["name"].as_str().unwrap().into(),
            arguments: want["arguments"].clone(),
            native_type: None,
        }]
    );
    assert_eq!(stop_of(&events), StopReason::ToolUse);
    assert!(usage_of(&events).is_none(), "the recording carries no usage");
}

#[test]
fn chat_wire_codec_conformance_and_truncation() {
    let codec = plain_codec();
    let sse = String::from_utf8(read("providers/openai-compat-chat/text/response.sse")).unwrap();
    // The same body cut before the event that carries `finish_reason`.
    let cut = sse.find("\"finish_reason\":\"stop\"").expect("finish chunk");
    let truncated = &sse[..sse[..cut].rfind("data:").unwrap()];
    check_wire_codec(&codec, &base_request("m"), sse.as_bytes(), truncated.as_bytes(), 40);

    // The recorded cut: `finish_reason` arrived, the usage frame did not end.
    // Node completed this turn without usage; the rebuild reports a body that
    // ends inside an event as truncated (decisions.md:46), after the text.
    let recorded = read("providers/openai-compat-chat/truncated-no-done/response.sse");
    let result = read_json("providers/openai-compat-chat/truncated-no-done/result.json");
    let mut decoder = codec.decoder(&base_request("m"));
    let events = decoder.feed(&recorded).unwrap();
    assert_eq!(text_of(&events), result["ok"]["content"].as_str().unwrap());
    assert!(usage_of(&events).is_none());
    let err = decoder.finish().expect_err("a cut trailing event is not a success");
    assert_eq!(err.transport, Some(TransportFault::TruncatedStream));
    assert!(err.exposure.text_emitted);
}

#[test]
fn a_clean_end_after_finish_reason_completes_without_done() {
    let codec = plain_codec();
    let sse = String::from_utf8(read("providers/openai-compat-chat/text/response.sse")).unwrap();
    let without_done = sse.replace("data: [DONE]\n\n", "");
    let events = decode(&codec, without_done.as_bytes(), 10);
    assert_eq!(stop_of(&events), StopReason::Other("stop".to_owned()));
    assert_eq!(text_of(&events), "The result is 42.");
}

#[test]
fn recorded_401_is_a_deterministic_refusal() {
    let codec = plain_codec();
    let body = read("providers/openai-compat-chat/error-401/response.sse");
    let err = codec.classify(&ErrorResponse {
        status: Some(401),
        headers: vec![],
        body,
    });
    assert_eq!(err.status, Some(401));
    assert!(err.kind.is_deterministic(), "{:?}", err.kind);
    assert_eq!(err.delivery, DeliveryState::Accepted);
    let recorded = read_json("providers/openai-compat-chat/error-401/result.json");
    assert_eq!(err.message, recorded["error"]["message"].as_str().unwrap());
}

// ---------------------------------------------------------------------------
// Intercepted providers: MiMo and Command Code
// ---------------------------------------------------------------------------

fn result_of(provider: &str, case: &str) -> JsonValue {
    read_json(&format!("providers-intercepted/{provider}/{case}/result.json"))
}

fn chat_record(provider: &str, case: &str) -> JsonValue {
    let exchange = read_json(&format!("providers-intercepted/{provider}/{case}/exchange.json"));
    exchange["records"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["path"].as_str().is_some_and(|p| p.ends_with("/chat/completions")))
        .cloned()
        .expect("a chat record")
}

#[test]
fn mimo_requests_and_headers_match_the_recording() {
    let codec = mimo_codec();
    let rec = chat_record("mimo-oauth", "text");
    let wire = codec.encode(&base_request("mimo-fixture")).unwrap();
    let want: JsonValue = serde_json::from_str(rec["bodyText"].as_str().unwrap()).unwrap();
    assert_eq!(body_of(&codec, &base_request("mimo-fixture")), want);
    let key_order = |v: &JsonValue| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(key_order(&body_of(&codec, &base_request("mimo-fixture"))), key_order(&want), "recorded key order");
    assert_eq!(wire.url, format!("{}{}", rec["origin"].as_str().unwrap(), rec["path"].as_str().unwrap()));
    let header = |name: &str| {
        wire.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.clone())
    };
    for name in ["x-mimo-source", "user-agent", "accept", "content-type"] {
        assert_eq!(
            header(name).as_deref(),
            rec["headers"][name].as_str(),
            "header {name}"
        );
    }
    // Session affinity rides on the request when the session is known.
    let mut request = base_request("mimo-fixture");
    request.options.session_id = Some("s-1".into());
    let wire = codec.encode(&request).unwrap();
    assert!(wire.headers.contains(&("x-session-affinity".into(), "s-1".into())));
}

#[test]
fn command_code_requests_match_the_recording() {
    let codec = command_code_codec();
    let rec = chat_record("command-code-oauth", "text");
    let want: JsonValue = serde_json::from_str(rec["bodyText"].as_str().unwrap()).unwrap();
    assert_eq!(body_of(&codec, &base_request("cc-fixture")), want);
    let wire = codec.encode(&base_request("cc-fixture")).unwrap();
    assert_eq!(wire.url, format!("{}{}", rec["origin"].as_str().unwrap(), rec["path"].as_str().unwrap()));
}

#[test]
fn intercepted_streams_decode_to_the_recorded_results() {
    for (provider, codec) in [("mimo-oauth", mimo_codec()), ("command-code-oauth", command_code_codec())] {
        let text = chat_record(provider, "text")["served"].as_str().unwrap().to_owned();
        let events = decode(&codec, text.as_bytes(), 33);
        assert_eq!(text_of(&events), result_of(provider, "text")["ok"]["content"].as_str().unwrap());
        assert_eq!(usage_of(&events), Some((20, 8)), "{provider}");

        let tool = chat_record(provider, "tool-call")["served"].as_str().unwrap().to_owned();
        let events = decode(&codec, tool.as_bytes(), 61);
        let want = &result_of(provider, "tool-call")["ok"]["toolCalls"][0];
        assert_eq!(
            tool_calls_of(&events),
            [ToolCall {
                id: want["id"].as_str().unwrap().into(),
                name: want["name"].as_str().unwrap().into(),
                arguments: want["arguments"].clone(),
                native_type: None,
            }],
            "{provider}"
        );
    }
}

#[test]
fn intercepted_truncation_and_errors() {
    for (provider, codec) in [("mimo-oauth", mimo_codec()), ("command-code-oauth", command_code_codec())] {
        // The body ends after text and before any finish_reason.
        let cut = chat_record(provider, "truncated-eof")["served"].as_str().unwrap().to_owned();
        let mut decoder = codec.decoder(&base_request("m"));
        let events = decoder.feed(cut.as_bytes()).unwrap();
        assert_eq!(text_of(&events), "The result is 42.");
        let err = decoder.finish().expect_err("no terminal event");
        assert_eq!(err.transport, Some(TransportFault::TruncatedStream), "{provider}");
        assert!(err.exposure.text_emitted, "{provider}");

        for (case, status, kind) in [("error-400", 400, ErrorKind::InvalidRequest), ("error-401", 401, ErrorKind::Auth)] {
            let rec = chat_record(provider, case);
            let err = codec.classify(&ErrorResponse {
                status: Some(status),
                headers: vec![],
                body: rec["served"].as_str().unwrap().as_bytes().to_vec(),
            });
            assert_eq!(err.kind, kind, "{provider}/{case}");
            assert_eq!(err.status, Some(status));
            let recorded = read_json(&format!("providers-intercepted/{provider}/{case}/result.json"));
            assert_eq!(err.message, recorded["error"]["message"].as_str().unwrap(), "{provider}/{case}");
            // A key issued by a login cannot be refreshed: 401 means sign in again.
            assert_eq!(err.reauth_required, status == 401, "{provider}/{case}");
        }
    }
}

// ---------------------------------------------------------------------------
// Dialects
// ---------------------------------------------------------------------------

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
    foreign.messages[2].push_replay(ProviderReplay {
        owner: ProviderId::from("someone-else"),
        items: json!({"reasoningContent": "secret"}),
    });
    assert!(body_of(&codec, &foreign)["messages"][2].get("reasoning_content").is_none());
}

#[test]
fn effort_reaches_the_body_by_dialect_not_by_provider_name() {
    let with = |profile: CompatProfile, effort: &str, params: Option<JsonValue>, models: Vec<JsonValue>| {
        let table = std::sync::Arc::new(ModelTable::default());
        table.replace(parse_models(&JsonValue::Array(models)));
        let codec = CompatChatCodec::new(
            profile,
            CompatConfig {
                models: table,
                ..CompatConfig::default()
            },
        );
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

    let cc = with(
        CompatProfile::command_code_oauth(),
        "medium",
        None,
        vec![json!({"id":"m","reasoning_efforts":["low","high"]})],
    );
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
    assert_eq!(
        choose(CompatProfile::xai(), "lookup", None)["tool_choice"],
        json!({"type": "function", "function": {"name": "lookup"}})
    );
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
    let plain = CompatChatCodec::new(
        CompatProfile::plain("p", "http://localhost:8080/v1", CredentialKind::Keyless),
        CompatConfig::default(),
    );
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
            ContentPart::Image(ImageSource::Base64 {
                data: "AAAA".into(),
                mime_type: "image/png".into(),
            }),
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

    // An image inside a tool result follows the tool messages as a user turn.
    let mut request = followup_request("m");
    request.messages[3].content = Content::Parts(vec![ContentPart::Image(ImageSource::Url("https://x/y.png".into()))]);
    let body = body_of(&codec, &request);
    assert_eq!(body["messages"][3]["role"], "tool");
    assert_eq!(
        body["messages"][3]["content"],
        "[tool result included media content in the following user message]"
    );
    assert_eq!(
        body["messages"][4],
        json!({"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://x/y.png"}}]})
    );
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
        let sse = format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"hi\"}},\"finish_reason\":\"{reason}\"}}]}}\n\ndata: [DONE]\n\n"
        );
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
    let events = decoder.feed(sse.as_bytes()).unwrap();
    assert!(tool_calls_of(&events).is_empty());
    assert_eq!(stop_of(&events), StopReason::MaxTokens);
    assert!(decoder.exposure().tool_input_cut);
}

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
            [ToolCall {
                id: "call_harness_1".into(),
                name: "read".into(),
                arguments: json!({"path": "hello.txt"}),
                native_type: None,
            }],
            "split at {split}"
        );
        assert_eq!(stop_of(&events), StopReason::ToolUse);
    }
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

// ---------------------------------------------------------------------------
// Retry policy rows
// ---------------------------------------------------------------------------

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

fn verdict_for(
    profile: &CompatProfile,
    err: &mixdog_core_api::domain::provider::ProviderError,
    retries_done: u32,
) -> Verdict {
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
    for (profile, ceiling) in [
        (CompatProfile::deepseek(), 10),
        (CompatProfile::muse_code_oauth(), 60),
        (CompatProfile::mimo_oauth(), 300),
        (CompatProfile::openrouter(), 60),
    ] {
        let at = status_error(ErrorKind::RateLimited, 429, Some(ceiling));
        assert_eq!(
            retry_delay(&verdict_for(&profile, &at, 0)),
            Some(Duration::from_secs(ceiling)),
            "{} waits advice up to its ceiling in full",
            profile.id
        );
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
    request.messages = vec![
        text_message(Role::System, "rules"),
        text_message(Role::System, "stable"),
        core,
        env,
        text_message(Role::User, "hi"),
    ];
    assert_eq!(body_of(&codec, &request)["messages"], recorded);
}

// ---------------------------------------------------------------------------
// Responses wire against the recorded heads
// ---------------------------------------------------------------------------

mod responses_heads {
    use super::*;
    use crate::providers::compat::responses::CompatResponsesCodec;
    use mixdog_core_api::domain::keepalive::TransportKind;
    use mixdog_core_api::domain::provider::Phase;

    fn oracle(name: &str) -> serde_json::Map<String, JsonValue> {
        read_json(&format!("providers/oracles/{name}")).as_object().unwrap().clone()
    }

    fn calls(content: &str, calls: Vec<ToolCall>) -> Message {
        let mut m = text_message(Role::Assistant, content);
        m.tool_calls = calls;
        m
    }

    fn call(id: &str, name: &str, arguments: JsonValue) -> ToolCall {
        ToolCall { id: id.into(), name: name.into(), arguments, native_type: None }
    }

    fn result(id: &str, content: &str) -> Message {
        let mut m = text_message(Role::Tool, content);
        m.tool_call_id = Some(id.into());
        m
    }

    fn search(provider: &str) -> JsonValue {
        json!({"provider": provider, "openaiTools": [
            {"type": "function", "name": "x", "description": "d", "parameters": {"type": "object", "properties": {}}}]})
    }

    fn native_history() -> Vec<Message> {
        vec![
            text_message(Role::User, "go"),
            calls("", vec![
                call("ts1", "load_tool", json!({"names": ["x"]})),
                call("cu1", "apply_patch", json!({"patch": "P"})),
                call("fn1", "Read", json!({"path": "a"})),
            ]),
            result("ts1", "loaded"),
            result("cu1", "patched"),
            result("fn1", "file"),
            text_message(Role::User, "next"),
        ]
    }

    fn oauth_history() -> Vec<Message> {
        let mut working = text_message(Role::Assistant, "working");
        working.phase = Some(Phase::Commentary);
        let mut looking = calls("looking", vec![
            call("ts1", "load_tool", json!({"names": ["x"]})),
            call("cu1", "apply_patch", json!({"patch": "P"})),
            call("sk1", "Skill", json!({"name": "s"})),
        ]);
        looking.phase = Some(Phase::Commentary);
        let mut ts1 = result("ts1", "loaded");
        ts1.native_tool_search = Some(search("openai-oauth"));
        let mut sk1 = result("sk1", "skill");
        sk1.native_tool_search = Some(search("openai-oauth"));
        let mut f2 = calls("", vec![call("f2", "Read", json!({"path": "a"}))]);
        f2.push_replay(ProviderReplay {
            owner: ProviderId::from("openai-responses"),
            items: json!([{"type": "tool_search_call", "call_id": "ts9", "execution": "client", "arguments": {}}]),
        });
        vec![
            text_message(Role::System, "sys"), text_message(Role::User, "go"), working, looking, ts1,
            result("cu1", "patched"), sk1, f2, result("f2", "file"), text_message(Role::User, "next"),
        ]
    }

    fn server_search(owner: &ProviderId) -> Vec<Message> {
        let mut m = calls("done", vec![call("c1", "Read", json!({}))]);
        m.push_replay(ProviderReplay {
            owner: owner.clone(),
            items: json!([
                {"type": "reasoning", "id": "rs_1", "encrypted_content": "ENC", "summary": []},
                {"type": "tool_search_call", "id": "ts_srv", "call_id": null, "execution": "server", "arguments": {"query": "q"}},
                {"type": "tool_search_output", "id": "tso_srv", "call_id": null, "execution": "server", "tools": []},
                {"type": "function_call", "call_id": "c1", "name": "Read", "arguments": "{}"}
            ]),
        });
        vec![text_message(Role::User, "find tools"), m, result("c1", "ok"), text_message(Role::User, "next")]
    }

    fn tool_def(name: &str, description: &str, schema: JsonValue) -> ToolDefinition {
        ToolDefinition { name: name.into(), description: description.into(), input_schema: schema, defer_loading: false, freeform: None }
    }

    fn session_tools() -> Vec<ToolDefinition> {
        vec![
            tool_def("Read", "Read a file", json!({"type": "object", "properties": {"path": {"type": "string"}}})),
            tool_def("load_tool", "Load tools", json!({"type": "object", "properties": {"names": {"type": "array"}}})),
        ]
    }

    /// The body text a codec sends, without the socket frame's `type`.
    fn sent(codec: &CompatResponsesCodec, request: &ModelRequest) -> String {
        let wire = codec.encode(request).unwrap();
        let mut body: serde_json::Map<String, JsonValue> = serde_json::from_slice(&wire.body).unwrap();
        if wire.transport == TransportKind::WebSocket {
            assert_eq!(body.shift_remove("type"), Some(json!("response.create")));
        }
        serde_json::to_string(&body).unwrap()
    }

    fn request(model: &str, messages: Vec<Message>, tools: Vec<ToolDefinition>, key: Option<&str>) -> ModelRequest {
        let mut r = base_request(model);
        r.messages = messages;
        r.tools = tools;
        r.options.prompt_cache_key = key.map(str::to_owned);
        r
    }

    #[test]
    fn gateway_bodies_match_the_compat_heads() {
        let heads = oracle("openai-compat-responses-head-parity.json");
        for (name, profile, model) in [
            ("opencode-go", CompatProfile::opencode_go(), "gpt-5.5"),
        ] {
            let codec = CompatResponsesCodec::new(profile, CompatConfig::default(), TransportKind::Http1);
            let cases: [(&str, Vec<Message>); 3] = [
                ("native", native_history()),
                ("oauth", oauth_history()),
                ("server-replay", server_search(codec.owner())),
            ];
            for (label, history) in cases {
                let key = format!("compat/{name}/{model}/{label}");
                let mut expected = heads[&key].clone();
                if label == "server-replay" {
                    // A replayed server-executed search is never answered with a synthesized client output.
                    expected["input"].as_array_mut().unwrap().retain(|i| {
                        !(i["type"] == "tool_search_output" && i["execution"] == "client" && i["call_id"] == "ts_srv")
                    });
                }
                assert_eq!(
                    sent(&codec, &request(model, history, vec![], None)),
                    serde_json::to_string(&expected).unwrap(),
                    "{key}"
                );
            }
        }
    }

    fn muse_codec() -> CompatResponsesCodec {
        let profile = CompatProfile::muse_code_oauth();
        let config = CompatConfig { models: profile.model_table(), ..CompatConfig::default() };
        CompatResponsesCodec::new(profile, config, TransportKind::Http1)
    }

    fn muse_body(request: &ModelRequest) -> JsonValue {
        serde_json::from_slice(&muse_codec().encode(request).unwrap().body).unwrap()
    }

    #[test]
    fn muse_bytes_match_the_recorded_request() {
        let recorded = read_json("providers-intercepted/muse-code-oauth/text/exchange.json");
        let expected = recorded["records"][0]["bodyText"].as_str().unwrap();
        let wire = muse_codec().encode(&base_request("muse-fixture")).unwrap();
        assert_eq!(String::from_utf8(wire.body).unwrap(), expected);
        assert_eq!(wire.url, "https://api.meta.ai/v1/responses");
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
    fn xai_bodies_match_the_http_and_websocket_heads() {
        let heads = oracle("xai-tool-search-head-parity.json");
        let cache = "f0858c98-2db1-4764-9d18-e6e1ec2ea4c7";
        let http = CompatResponsesCodec::new(CompatProfile::xai(), CompatConfig::default(), TransportKind::Http1);
        let ws = CompatResponsesCodec::new(CompatProfile::xai(), CompatConfig::default(), TransportKind::WebSocket);
        // The oracle fixes the key it was recorded with; the codec derives its own from the
        // session, so that one value is swapped for the oracle's.
        let with_session = |history: Vec<Message>| {
            let mut r = request("grok-4", history, session_tools(), None);
            r.options.session_id = Some("sess-1".into());
            r
        };
        let derived = {
            let body: JsonValue = serde_json::from_slice(&http.encode(&with_session(native_history())).unwrap().body).unwrap();
            body["prompt_cache_key"].as_str().unwrap().to_owned()
        };
        for (label, history) in [("native/plain-tools", native_history()), ("oauth/plain-tools", oauth_history())] {
            for (transport, codec) in [("http", &http), ("ws", &ws)] {
                let name = format!("{transport}/{label}");
                assert_eq!(
                    sent(codec, &with_session(history.clone())).replace(&derived, cache),
                    serde_json::to_string(&heads[&name]).unwrap(),
                    "{name}"
                );
            }
        }
        // The socket frame leads with its type and carries no `stream`.
        let wire = ws.encode(&with_session(native_history())).unwrap();
        assert!(wire.url.starts_with("wss://api.x.ai/v1/responses"));
        assert!(String::from_utf8(wire.body).unwrap().starts_with("{\"type\":\"response.create\""));
    }

    /// Node's `resolveWireRoute` over every combination of the recorded
    /// dimensions: the family and legacy tiers included, none skipped.
    #[test]
    fn wire_routes_match_nodes_resolution_for_every_context() {
        use crate::providers::compat::profile::{CredentialKind, Wire};
        use crate::providers::compat::wire_route::{RouteSource, WireFacts, resolve_wire};
        let wire = |name: &str| match name {
            "chat" => Wire::Chat,
            "messages" => Wire::Messages,
            "responses" => Wire::Responses,
            "gemini" => Wire::Gemini,
            other => panic!("wire {other}"),
        };
        let wires = |value: &JsonValue| -> Vec<Wire> { value.as_array().unwrap().iter().map(|w| wire(w.as_str().unwrap())).collect() };
        let profile = |provider: &str| -> CompatProfile {
            let custom = |protocol: Wire, offered: &'static [Wire]| {
                let mut p = CompatProfile::plain("custom", "http://127.0.0.1/v1", CredentialKind::Keyless);
                p.default_wire = protocol;
                p.wires.offered = offered;
                p.wires.legacy = crate::providers::compat::profile::LegacyWire::Fixed(protocol);
                p
            };
            match provider {
                "openrouter" => CompatProfile::openrouter(),
                "opencode-go" => CompatProfile::opencode_go(),
                "command-code-oauth" => CompatProfile::command_code_oauth(),
                "deepseek" => CompatProfile::deepseek(),
                "custom-chat" => custom(Wire::Chat, &[Wire::Chat, Wire::Responses]),
                "custom-responses" => custom(Wire::Responses, &[Wire::Responses]),
                other => panic!("provider {other}"),
            }
        };
        let letter = |wire: Wire| match wire {
            Wire::Chat => 'c',
            Wire::Messages => 'm',
            Wire::Responses => 'r',
            Wire::Gemini => 'g',
        };
        let source = |source: RouteSource| match source {
            RouteSource::Pinned => 'p',
            RouteSource::Override => 'o',
            RouteSource::Catalog => 'c',
            RouteSource::Endpoints => 'e',
            RouteSource::Family => 'f',
            RouteSource::Default => 'd',
            RouteSource::Legacy => 'l',
            RouteSource::Unknown => 'u',
        };
        let golden = read_json("providers/oracles/wire-route.json");
        let mut checked = 0;
        for grid in golden["grids"].as_array().unwrap() {
            let dimensions = grid["dimensions"].as_object().unwrap();
            // Nested in key order, the last dimension varying fastest.
            let mut combos: Vec<Vec<(&str, &JsonValue)>> = vec![Vec::new()];
            for name in grid["order"].as_array().unwrap() {
                let (name, values) = (name.as_str().unwrap(), &dimensions[name.as_str().unwrap()]);
                combos = combos
                    .into_iter()
                    .flat_map(|prefix| {
                        values.as_array().unwrap().iter().map(move |v| {
                            let mut next = prefix.clone();
                            next.push((name, v));
                            next
                        })
                    })
                    .collect();
            }
            for row in grid["rows"].as_array().unwrap() {
                let (provider, model) = (row["provider"].as_str().unwrap(), row["model"].as_str().unwrap());
                let profile = profile(provider);
                let results: Vec<&str> = row["results"].as_str().unwrap().split(',').collect();
                assert_eq!(results.len(), combos.len(), "{provider} {model}");
                for (combo, expected) in combos.iter().zip(results) {
                    let get = |name: &str| combo.iter().find(|(n, _)| *n == name).map(|(_, v)| *v);
                    let endpoints = get("endpoints").filter(|v| !v.is_null()).map(&wires);
                    let exclude = get("exclude").map(&wires).unwrap_or_default();
                    let flag = |name: &str| get(name).and_then(JsonValue::as_bool).unwrap_or(false);
                    let facts = WireFacts {
                        model,
                        keep: get("keep").and_then(JsonValue::as_str).map(wire),
                        legacy: flag("legacy"),
                        override_wire: get("override").and_then(JsonValue::as_str).map(wire),
                        catalog_wire: get("catalogWire").and_then(JsonValue::as_str).map(wire),
                        endpoints: endpoints.as_deref(),
                        known: get("known").and_then(JsonValue::as_bool).unwrap_or(true),
                        agent: flag("agent"),
                        exclude: &exclude,
                    };
                    let got = resolve_wire(&profile, &facts)
                        .map_or("-".to_owned(), |r| format!("{}{}", letter(r.wire), source(r.source)));
                    assert_eq!(got, expected, "{provider} {model} {combo:?}");
                    checked += 1;
                }
            }
        }
        assert!(checked > 17_000, "{checked} contexts replayed");
    }

    struct MapEnv(std::collections::HashMap<String, String>);

    impl crate::registry::keys::Environment for MapEnv {
        fn var(&self, name: &str) -> Option<String> {
            self.0.get(name).cloned()
        }
    }

    /// Every scope, namespace and lane setting reaches the `prompt_cache_key`
    /// Node's `xaiResponsesCacheRouting` computes (null: the field is not sent).
    #[test]
    fn xai_cache_keys_match_nodes_routing_for_every_scope() {
        use crate::providers::compat::chat::EnvSource;
        let golden = read_json("providers/oracles/xai-cache-routing.json");
        let cases = golden["cases"].as_array().unwrap();
        // The unbounded lane counts seeds per codec, so cases sharing an environment share one.
        let mut codecs: std::collections::BTreeMap<String, CompatResponsesCodec> = Default::default();
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let env: std::collections::HashMap<String, String> = case["env"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned()))
                .collect();
            let signature = serde_json::to_string(&case["env"]).unwrap();
            let codec = codecs.entry(signature).or_insert_with(|| {
                let config = CompatConfig {
                    environment: Some(EnvSource(std::sync::Arc::new(MapEnv(env)))),
                    ..CompatConfig::default()
                };
                CompatResponsesCodec::new(CompatProfile::xai(), config, TransportKind::Http1)
            });
            let role = |r: &str| match r {
                "system" => Role::System,
                "developer" => Role::Developer,
                _ => Role::User,
            };
            let messages = case["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| text_message(role(m["role"].as_str().unwrap()), m["content"].as_str().unwrap()))
                .collect();
            let tools = case["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| tool_def(t["name"].as_str().unwrap(), t["description"].as_str().unwrap(), t["inputSchema"].clone()))
                .collect();
            let mut req = request(case["model"].as_str().unwrap(), messages, tools, None);
            let options = &case["options"];
            let text = |key: &str| options.get(key).map(|v| v.as_str().unwrap().to_owned());
            req.options.session_id = text("sessionId");
            req.options.prompt_cache_key = text("promptCacheKey");
            req.options.prompt_cache_scope = text("promptCacheScope");
            req.options.xai_responses_cache_scope = text("xaiResponsesCacheScope");
            let body: JsonValue = serde_json::from_slice(&codec.encode(&req).unwrap().body).unwrap();
            assert_eq!(body.get("prompt_cache_key").unwrap_or(&JsonValue::Null), &case["key"], "{name}");
        }
    }

    /// A socket turn that resumed an imported `previous_response_id` and whose
    /// response has no id keeps the resumed id as the slot's `responseId`
    /// (Node: `result.responseId || previousResponseId`); the HTTP turn does not.
    #[test]
    fn a_socket_turn_without_a_response_id_keeps_the_resumed_one() {
        let golden = oracle("xai-responses-continuation.json");
        let turn = &golden["websocketResumed"];
        let mut req = request("grok-4.5", vec![text_message(Role::User, "go")], Vec::new(), None);
        req.messages = (0..4).map(|_| text_message(Role::User, "m")).collect();
        req.options.provider_state = Some(serde_json::from_value(turn["priorState"].clone()).unwrap());
        let slot = |transport: TransportKind| -> JsonValue {
            let codec = CompatResponsesCodec::new(CompatProfile::xai(), CompatConfig::default(), transport);
            let frame = json!({"type": "response.completed", "response": {"status": "completed", "output": []}});
            let bytes = if transport == TransportKind::WebSocket { frame.to_string() } else { format!("data: {frame}\n\n") };
            let mut decoder = codec.decoder(&req);
            let mut events = decoder.feed(bytes.as_bytes()).unwrap();
            events.extend(decoder.finish().unwrap());
            let mut state = events
                .into_iter()
                .find_map(|e| match e {
                    StreamEvent::ProviderState(s) => Some(serde_json::to_value(s).unwrap()),
                    _ => None,
                })
                .expect("the turn reports its provider state");
            state["xaiResponses"]["updatedAt"] = turn["providerState"]["xaiResponses"]["updatedAt"].clone();
            state
        };
        assert_eq!(slot(TransportKind::WebSocket), turn["providerState"]);
        assert_eq!(slot(TransportKind::Http1)["xaiResponses"]["responseId"], JsonValue::Null);
    }

    #[test]
    fn effort_folds_onto_what_the_wire_takes_and_choices_are_placed() {
        let table = CompatProfile::xai().model_table();
        let codec = CompatResponsesCodec::new(
            CompatProfile::xai(),
            CompatConfig { models: table, ..CompatConfig::default() },
            TransportKind::Http1,
        );
        let body = |model: &str, effort: &str, choice: Option<&str>| -> JsonValue {
            let mut r = request(model, vec![text_message(Role::User, "hi")], session_tools(), None);
            r.options.effort = Some(effort.into());
            r.options.tool_choice = choice.map(str::to_owned);
            serde_json::from_slice(&codec.encode(&r).unwrap().body).unwrap()
        };
        assert_eq!(body("grok-4.3", "HIGH", None)["reasoning"], json!({"effort": "high"}));
        assert!(body("grok-4-fast", "high", None).get("reasoning").is_none());
        assert!(body("grok-4.3", "none", None).get("reasoning").is_none());
        // xAI's Responses send forces no choice (`applyCompatToolChoice(params, opts)` without a wire context,
        // openai-compat-xai-send.mjs:58; recorded in fixtures/provider-wire/hosted-search/grok-oauth).
        assert!(body("grok-4.3", "low", Some("Read")).get("tool_choice").is_none());
    }

    /// Golden recorded from Node's real xAI send path (`sendXaiResponses`) and
    /// `normalizeXaiResponsesWebSocket`: the `xaiResponses` slot is stateless
    /// (`store: false`, `previousResponseId: null`), carries the response id
    /// and the encrypted reasoning, tags no history owner, and the socket turn
    /// adds `transport`. Every other provider-state key is kept.
    #[test]
    fn xai_keeps_nodes_stateless_slot_across_turns() {
        let golden = oracle("xai-responses-continuation.json");
        let messages = |turn: &JsonValue| -> Vec<Message> {
            turn["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|m| {
                    let role = match m["role"].as_str().unwrap() {
                        "system" => Role::System,
                        "user" => Role::User,
                        "assistant" => Role::Assistant,
                        _ => Role::Tool,
                    };
                    let mut message = text_message(role, m["content"].as_str().unwrap());
                    for call in m["toolCalls"].as_array().into_iter().flatten() {
                        message.tool_calls.push(ToolCall {
                            id: call["id"].as_str().unwrap().into(),
                            name: call["name"].as_str().unwrap().into(),
                            arguments: call["arguments"].clone(),
                            native_type: None,
                        });
                    }
                    message.tool_call_id = m["toolCallId"].as_str().map(str::to_owned);
                    message
                })
                .collect()
        };
        let state = |value: &JsonValue| -> Option<mixdog_core_api::domain::provider::ProviderState> {
            (!value.is_null()).then(|| serde_json::from_value(value.clone()).unwrap())
        };
        // The slot a turn must leave behind, with the clock the codec reads left out.
        let produced = |codec: &CompatResponsesCodec, turn: &JsonValue, prior: &JsonValue| -> JsonValue {
            let mut req = request("grok-4.5", messages(turn), Vec::new(), None);
            req.options.provider_state = state(prior);
            let expected = &turn["providerState"]["xaiResponses"];
            let mut frames: Vec<JsonValue> = expected["encryptedReasoningItems"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| json!({"type": "response.output_item.done", "item": item}))
                .collect();
            frames.push(json!({"type": "response.completed", "response": {
                "id": expected["responseId"], "status": "completed",
                "output": expected["encryptedReasoningItems"],
            }}));
            let mut decoder = codec.decoder(&req);
            let mut events = Vec::new();
            for frame in frames {
                let bytes = if codec.transport() == TransportKind::WebSocket {
                    frame.to_string()
                } else {
                    format!("data: {frame}\n\n")
                };
                events.extend(decoder.feed(bytes.as_bytes()).unwrap());
            }
            events.extend(decoder.finish().unwrap());
            let mut out = events
                .into_iter()
                .find_map(|e| match e {
                    StreamEvent::ProviderState(s) => Some(serde_json::to_value(s).unwrap()),
                    _ => None,
                })
                .expect("the turn reports its provider state");
            out["xaiResponses"]["updatedAt"] = expected["updatedAt"].clone();
            out
        };

        let http = CompatResponsesCodec::new(CompatProfile::xai(), CompatConfig::default(), TransportKind::Http1);
        for name in ["turn1", "turn2", "imported"] {
            let turn = &golden[name];
            let prior = &turn["priorState"];
            let mut req = request("grok-4.5", messages(turn), Vec::new(), None);
            req.options.provider_state = state(prior);
            req.options.session_id = Some("s1".into());
            let body: JsonValue = serde_json::from_slice(&http.encode(&req).unwrap().body).unwrap();
            for field in ["input", "store", "include", "previous_response_id", "prompt_cache_key"] {
                assert_eq!(body.get(field), turn["request"].get(field), "{name}: request {field}");
            }
            assert_eq!(produced(&http, turn, prior), turn["providerState"], "{name}: slot");
        }

        let ws = CompatResponsesCodec::new(CompatProfile::xai(), CompatConfig::default(), TransportKind::WebSocket);
        let turn = &golden["websocket"];
        assert_eq!(produced(&ws, turn, &turn["priorState"]), turn["providerState"], "websocket: slot");
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

// ---------------------------------------------------------------------------
// Liveness: no content timer, half-open links end by keepalive (SPEC §4.9)
// ---------------------------------------------------------------------------

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
                    for pattern in &banned {
                        assert!(!text.contains(pattern.as_str()), "{} uses {pattern}", path.display());
                    }
                    scanned += 1;
                }
            }
        }
        assert!(scanned >= 10, "the scan saw the module tree ({scanned} files)");
    }

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
        async fn send(
            &self,
            request: WireRequest,
            _exchange: crate::transport::Exchange,
        ) -> Result<HttpResponse, ProviderError> {
            self.sent.lock().unwrap().push(request);
            Ok(HttpResponse {
                status: self.status,
                headers: vec![],
                body: Box::new(Chunks(self.chunks.clone().into_iter())),
            })
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

    struct Catalog(std::collections::HashMap<String, Option<String>>);

    impl crate::catalog::ModelTraits for Catalog {
        fn family(&self, _: &str) -> Option<String> {
            None
        }
        fn thinking(&self, _: &str) -> crate::catalog::Thinking {
            crate::catalog::Thinking::Unspecified
        }
        fn catalog_wire(&self, model: &str) -> Option<crate::providers::compat::profile::Wire> {
            crate::providers::compat::wire_route::wire_of_package(self.0.get(model)?.as_deref())
        }
    }

    use mixdog_core_api::domain::provider::WireRouteContext;

    async fn routed(adapter: &CompatAdapter, model: &str, ctx: &WireRouteContext) -> String {
        let routing = adapter.wire_routing().expect("a routed gateway");
        let route = routing.resolve_wire_route(model, ctx).await.unwrap();
        route.map_or("-".into(), |r| format!("{}{}", &r.wire[..1], &r.source[..1]))
    }

    /// A scripted answer for the roster / console config, whatever the URL.
    fn listing_adapter(case: &JsonValue, goldens: &JsonValue, http: Arc<Scripted>) -> CompatAdapter {
        let provider = case["provider"].as_str().unwrap();
        let (profile, base, key, headers): (CompatProfile, Option<&str>, &'static str, Vec<(String, String)>) = match provider {
            "xai" => (CompatProfile::xai(), Some("https://gateway.example/v1"), "fixture-list-key", vec![]),
            "deepseek" => (CompatProfile::deepseek(), Some("https://gateway.example/v1"), "fixture-list-key", vec![]),
            "openrouter" => (CompatProfile::openrouter(), Some("https://gateway.example/v1"), "fixture-list-key", vec![]),
            "mimo-oauth" => (CompatProfile::mimo_oauth(), None, "fixture-mimo-key", vec![]),
            "muse-code-oauth" => (CompatProfile::muse_code_oauth(), None, "fixture-muse-key", vec![]),
            "command-code-oauth" => (CompatProfile::command_code_oauth(), None, "fixture-command-key", vec![]),
            "opencode-go-oauth" => (CompatProfile::opencode_go(), None, "fixture-go-access", vec![("x-org-id".into(), "org-1".into())]),
            other => panic!("unknown provider {other}"),
        };
        let mut config = CompatConfig::for_profile(&profile);
        config.base_url = base.map(str::to_owned).or(config.base_url);
        config.extra_headers = headers;
        let lookup = crate::catalog::ListingLookup::with_models_dev(&json!({ "opencode-go": { "models": goldens["rosters"]["goModelsDev"] } }));
        CompatAdapter::new(CompatChatCodec::new(profile, config), http, Some(Arc::new(Key(key)))).with_listing_lookup(lookup)
    }

    /// The roster each scenario scripts.
    fn scripted_roster(case: &JsonValue, rosters: &JsonValue) -> (u16, JsonValue) {
        let r = |name: &str| rosters[name].clone();
        match (case["provider"].as_str().unwrap(), case["scenario"].as_str().unwrap()) {
            (_, "bare-array") => (200, JsonValue::Array(rosters["generic"].as_array().unwrap()[..4].to_vec())),
            (_, "refused") => (403, json!({ "error": { "message": "bad key fixture-list-key", "code": "invalid_api_key" } })),
            (_, "server-error") => (500, json!({ "error": "boom" })),
            (_, "unauthorized") => (401, json!({ "error": { "message": "no" } })),
            (_, "empty-roster") => (200, json!({ "data": [] })),
            // The golden file stores keys sorted; the console lists models in Node's row order.
            ("opencode-go-oauth", "config") => {
                let mut config = r("goConfig");
                let models = config["providers"]["opencode-go"]["models"].as_object().unwrap().clone();
                let ordered: serde_json::Map<String, JsonValue> =
                    case["rows"].as_array().unwrap().iter().filter_map(|row| models.get_key_value(row["id"].as_str()?)).map(|(k, v)| (k.clone(), v.clone())).collect();
                let mut all = ordered.clone();
                for (k, v) in &models {
                    all.entry(k.clone()).or_insert_with(|| v.clone());
                }
                config["providers"]["opencode-go"]["models"] = JsonValue::Object(all);
                (200, config)
            }
            ("opencode-go-oauth", "config-empty-models-dev") => (200, r("goEmpty")),
            ("opencode-go-oauth", "config-without-provider") => (200, json!({ "providers": {} })),
            ("mimo-oauth", _) => (200, json!({ "data": r("mimo") })),
            ("muse-code-oauth", _) => (200, json!({ "data": r("muse") })),
            ("command-code-oauth", _) => (200, json!({ "data": r("command") })),
            _ => (200, json!({ "data": r("generic") })),
        }
    }

    /// Every recorded listing scenario gives Node's rows (the fields a
    /// listed row carries; prices and capability flags are the catalog's) and
    /// asks the URL Node asked with the headers Node sent.
    #[tokio::test]
    async fn every_recorded_listing_gives_nodes_rows() {
        use mixdog_core_api::domain::provider::ModelListing;
        let golden = read_json("providers/oracles/compat-listing.json");
        let mut checked = 0;
        for case in golden["cases"].as_array().unwrap() {
            let what = format!("{} {}", case["provider"], case["scenario"]);
            let (status, body) = scripted_roster(case, &golden["rosters"]);
            let http = Arc::new(Scripted { status, chunks: vec![serde_json::to_vec(&body).unwrap()], sent: Mutex::new(Vec::new()) });
            let adapter = listing_adapter(case, &golden, http.clone());
            let result = adapter.list_models().await;

            let sent = http.sent.lock().unwrap();
            let want = &case["requests"][0];
            assert_eq!(sent[0].url, want["url"].as_str().unwrap(), "{what}");
            for (name, value) in want["headers"].as_object().unwrap() {
                let has = sent[0].headers.iter().any(|(k, v)| k.eq_ignore_ascii_case(name) && v == value.as_str().unwrap());
                assert!(has, "{what}: header {name}");
            }
            if case["error"].is_string() {
                let error = result.err().unwrap_or_else(|| panic!("{what}: Node failed with {}", case["error"]));
                if let Some(status) = case["status"].as_u64() {
                    assert_eq!(error.status, Some(status as u16), "{what}");
                }
                assert!(!error.message.contains("fixture-list-key"), "{what}: {}", error.message);
                continue;
            }
            let rows = result.unwrap_or_else(|e| panic!("{what}: {e:?}"));
            let expected = case["rows"].as_array().unwrap();
            let ids = |rows: &[JsonValue]| rows.iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
            let got: Vec<JsonValue> = rows
                .iter()
                .map(|r| {
                    json!({
                        "id": r.id,
                        "name": r.name,
                        "display": r.display_name,
                        "contextWindow": r.context_window.unwrap_or(0),
                        "outputTokens": r.max_output_tokens,
                        "created": r.created,
                        "mode": r.mode,
                        "aliasTarget": r.alias_target,
                        "reasoningLevels": r.reasoning_levels,
                        "reasoningOptions": r.picker.reasoning_options,
                        "supportsReasoning": r.supports_reasoning,
                    })
                })
                .collect();
            assert_eq!(ids(&got), ids(expected), "{what}: ids");
            // Only the console config states prices on the row itself; the rest come from the catalog.
            if case["provider"] == "opencode-go-oauth" {
                for (row, node) in rows.iter().zip(expected) {
                    let prices = [
                        ("inputCostPerM", row.input_cost_per_m),
                        ("outputCostPerM", row.output_cost_per_m),
                        ("cacheReadCostPerM", row.cache_read_cost_per_m),
                        ("cacheWriteCostPerM", row.cache_write_cost_per_m),
                    ];
                    for (key, got) in prices {
                        assert_eq!(got, node[key].as_f64(), "{what}: {} {key}", row.id);
                    }
                }
            }
            // The row `listCompatModels` stores (`provider._enrichedModels`), which `getCachedCompatModelInfo` answers
            // unchanged, is Node's row key for key. The other providers (mimo, muse, command-code, opencode-go) build
            // their rows in their own `listModels`, which the stored row does not follow yet.
            if ["xai", "deepseek", "openrouter"].contains(&case["provider"].as_str().unwrap()) {
                for (record, node) in rows.iter().zip(expected) {
                    let stored = crate::catalog::listed_row_of(&case["provider"].as_str().unwrap().into(), record.clone());
                    assert_eq!(stored.as_ref(), Some(node), "{what}: {} stored row", node["id"]);
                }
            }
            for (record, node) in rows.iter().zip(expected) {
                let row = format!("{what}: {}", node["id"]);
                assert_eq!(record.reasoning_content_field.as_deref(), node["reasoningContentField"].as_str(), "{row} reasoningContentField");
                assert_eq!(record.supports_prompt_caching, node["supportsPromptCaching"].as_bool(), "{row} supportsPromptCaching");
                // No compat row states the other listing facts.
                assert!(record.picker.tier.is_none() && !record.picker.latest && record.picker.description.is_none(), "{row}");
                assert!(record.provider_name.is_none() && !record.manual, "{row}");
            }
            for (got, node) in got.iter().zip(expected) {
                let field = |key: &str| node.get(key).filter(|v| !v.is_null()).cloned();
                let row = format!("{what}: {}", node["id"]);
                assert_eq!(got["name"].as_str().or(got["id"].as_str()), node["name"].as_str(), "{row} name");
                assert_eq!(got["display"].as_str(), node["display"].as_str(), "{row} display");
                // Node lists an unknown window as 0 or null by provider; both mean none.
                assert_eq!(got["contextWindow"].as_u64().unwrap_or(0), node["contextWindow"].as_u64().unwrap_or(0), "{row} contextWindow");
                assert_eq!(got["outputTokens"].as_u64(), node["outputTokens"].as_u64(), "{row} outputTokens");
                assert_eq!(got["created"].as_i64(), node["created"].as_i64(), "{row} created");
                assert_eq!(got["mode"].as_str(), node["mode"].as_str(), "{row} mode");
                assert_eq!(field("aliasTarget"), got["aliasTarget"].as_str().map(|s| json!(s)), "{row} aliasTarget");
                assert_eq!(got["reasoningLevels"], node.get("reasoningLevels").cloned().unwrap_or(json!([])), "{row} reasoningLevels");
                assert_eq!(got["reasoningOptions"], node.get("reasoningOptions").cloned().unwrap_or(json!([])), "{row} reasoningOptions");
                if let Some(flag) = got["supportsReasoning"].as_bool() {
                    assert_eq!(node["supportsReasoning"].as_bool(), Some(flag), "{row} supportsReasoning");
                }
            }
            checked += 1;
        }
        assert_eq!(checked, 12, "16 scenarios, 4 of them refusals");
    }

    /// OpenCode Go (catalog package narrows the offered wires) and Command
    /// Code (the roster's declared endpoints) answer as Node's glue does.
    #[tokio::test]
    async fn catalog_and_roster_inputs_route_as_nodes_adapters_do() {
        use crate::providers::compat::adapter::RouteInputs;
        use crate::providers::compat::profile::Wire;
        let golden = read_json("providers/oracles/wire-route.json");
        let http = Arc::new(Scripted { status: 200, chunks: Vec::new(), sent: Mutex::new(Vec::new()) });

        let go = &golden["openCodeGo"];
        let packages: std::collections::HashMap<String, Option<String>> = go["packages"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(id, npm)| (id.clone(), npm.as_str().map(str::to_owned)))
            .collect();
        let codec = CompatChatCodec::new(CompatProfile::opencode_go(), CompatConfig::default());
        let routing = |wires: std::collections::HashMap<String, Wire>| RouteInputs {
            model_wires: wires,
            catalog: Some(Arc::new(Catalog(packages.clone()))),
        };
        let mut checked = 0;
        for row in go["rows"].as_array().unwrap() {
            let model = row["model"].as_str().unwrap();
            let mut expected = row["results"].as_str().unwrap().split(',');
            let mut combos = Vec::new();
            for over in go["dimensions"]["override"].as_array().unwrap() {
                for agent in [false, true] {
                    for legacy in [false, true] {
                        combos.push((over.as_str(), agent, legacy));
                    }
                }
            }
            for (over, agent, legacy) in combos {
                let wires = over.map(|w| [(model.to_owned(), Wire::parse(w).unwrap())].into()).unwrap_or_default();
                let adapter = CompatAdapter::new(codec.clone(), http.clone(), Some(Arc::new(Key("k")))).with_routing(routing(wires));
                let ctx = WireRouteContext { agent, legacy, ..WireRouteContext::default() };
                let expected = expected.next().unwrap();
                // Node's two letters are wire and source initials; `family` and `default` share `f`/`d`.
                assert_eq!(routed(&adapter, model, &ctx).await, expected, "{model} {over:?} agent={agent} legacy={legacy}");
                checked += 1;
            }
        }
        assert_eq!(checked, 10 * 5 * 2 * 2);

        let cc = CompatChatCodec::new(CompatProfile::command_code_oauth(), CompatConfig::for_profile(&CompatProfile::command_code_oauth()));
        let adapter = CompatAdapter::new(cc.clone(), http, Some(Arc::new(Key("k"))));
        for case in golden["commandCode"].as_array().unwrap() {
            let model = case["model"].as_str().unwrap();
            cc.models().replace(parse_models(&json!({"data": [case["item"].clone()]})));
            let got = adapter
                .wire_routing()
                .unwrap()
                .resolve_wire_route(model, &WireRouteContext::default())
                .await
                .unwrap();
            let got = got.map(|r| r.wire);
            assert_eq!(got.as_deref(), case["wire"].as_str(), "{model} {}", case["declared"]);
        }
    }

    #[tokio::test]
    async fn a_stream_attempt_ends_with_one_terminal_and_the_key_rides_as_a_bearer() {
        let sse = read("providers/openai-compat-chat/text/response.sse");
        let (adapter, http) = adapter(200, vec![sse[..60].to_vec(), sse[60..].to_vec()]);
        check_provider_attempt(&adapter, Arc::new(base_request("m")), DeliveryState::Accepted).await;
        let sent = http.sent.lock().unwrap();
        assert!(sent[0].headers.contains(&("authorization".into(), "Bearer sk-test-key".into())));
    }

    #[tokio::test]
    async fn a_refusal_is_classified_once_and_never_echoes_the_key() {
        let body = br#"{"error":{"message":"Incorrect API key provided: sk-test-key","code":"invalid_api_key"}}"#.to_vec();
        let (adapter, _) = adapter(401, vec![body]);
        let err = adapter.attempt(Arc::new(base_request("m"))).await.err().expect("refused");
        assert_eq!((err.kind, err.status), (ErrorKind::Auth, Some(401)));
        assert!(!err.message.contains("sk-test-key"), "{}", err.message);
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
}

/// Recorded from Node's `withRetry` with a 503 on every call, a stubbed
/// sleep and `Math.random` pinned to 0, 0.5 and 1: 5 calls, and the waits
/// below (the default `[250, 1000, …]` schedule reads index n for retry n,
/// with the shared ±20 % jitter).
#[test]
fn the_unprofiled_default_equals_nodes_retry_loop() {
    let recorded: [(f64, [u64; 4]); 3] = [
        (0.0, [800, 1600, 3200, 6400]),
        (0.5, [1000, 2000, 4000, 8000]),
        (1.0, [1200, 2400, 4800, 9600]),
    ];
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

/// Which tools an OpenAI-compatible chat route sends and what it reports for the ones it leaves
/// out, against `fixtures/providers/compat-tool-exclusion/cases.json` (recorded by
/// `record-compat-tool-exclusion.mjs` from the real `OpenAICompatProvider.send`): a Gemini-family
/// model is held to Google's schema rule, any other model to the OpenAI one, and every report goes
/// to the request's sink under the rule's own label.
#[test]
fn a_gemini_model_behind_a_compat_route_is_held_to_googles_rule() {
    use std::sync::{Arc, Mutex};

    use mixdog_core_api::domain::provider::{ToolExclusionReport, ToolExclusionSink};

    let golden: JsonValue =
        serde_json::from_str(include_str!("../../../../../fixtures/providers/compat-tool-exclusion/cases.json")).expect("recorded cases");
    for case in golden["cases"].as_array().expect("cases") {
        let id = case["id"].as_str().expect("id");
        let seen = Arc::new(Mutex::new(Vec::<ToolExclusionReport>::new()));
        let into = Arc::clone(&seen);
        let mut request = base_request(case["model"].as_str().expect("model"));
        request.tools = case["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .map(|t| ToolDefinition {
                name: t["name"].as_str().expect("name").into(),
                description: t["description"].as_str().expect("description").into(),
                input_schema: t["inputSchema"].clone(),
                defer_loading: false,
                freeform: None,
            })
            .collect();
        request.options.on_tool_excluded = Some(ToolExclusionSink(Arc::new(move |report: ToolExclusionReport| {
            into.lock().unwrap().push(report);
        })));
        let body = body_of(&plain_codec(), &request);
        let sent: Vec<JsonValue> = body["tools"]
            .as_array()
            .map(|tools| {
                tools
                    .iter()
                    .map(|t| json!({"name": t["function"]["name"], "parameters": t["function"]["parameters"]}))
                    .collect()
            })
            .unwrap_or_default();
        assert_eq!(JsonValue::Array(sent), case["sentTools"], "{id}: tools sent");
        let reports = seen.lock().unwrap();
        let want = case["excluded"].as_array().expect("excluded");
        assert_eq!(reports.len(), want.len(), "{id}: reports {reports:?}");
        for (got, want) in reports.iter().zip(want) {
            assert_eq!(got.name, want["name"].as_str().unwrap(), "{id}");
            assert_eq!(got.index as u64, want["index"].as_u64().unwrap(), "{id}");
            assert_eq!(got.pointer, want["pointer"].as_str().unwrap(), "{id}");
            assert_eq!(got.reason, want["reason"].as_str().unwrap(), "{id}");
            assert_eq!(got.message, want["message"].as_str().unwrap(), "{id}");
        }
    }
}

/// Node's chat consumer reported these progress kinds for each chunk (`golden/stream_progress.json`); the Rust chat
/// decoder reports the same: a call's header and arguments chunks are `tool`, its dispatch at the finish is none.
#[test]
fn the_chat_decoder_reports_the_progress_kinds_node_s_consumer_does() {
    use crate::providers::progress_golden::{golden, node_names, rust_names};
    let mut decoder = plain_codec().decoder(&base_request("m"));
    for step in golden()["decoders"]["chat"].as_array().expect("chat") {
        let unit = format!("data: {}\n\n", step["wire"]);
        let events = decoder.feed(unit.as_bytes()).expect("feed");
        assert_eq!(rust_names(&events), node_names(&step["kinds"]), "{}", step["wire"]);
    }
}

/// The full text of a cut stream, with the label Node puts in front of it: `<provider>:responses` over HTTP/SSE and the
/// recorded `_wsErrLabel('xai')` over the socket (`golden/stream_progress.json`).
#[test]
fn a_cut_compat_responses_stream_says_what_node_says() {
    use crate::providers::compat::responses::CompatResponsesCodec;
    use mixdog_core_api::domain::keepalive::TransportKind;
    let golden = crate::providers::progress_golden::golden();
    let ws_label = golden["labels"]["xaiWs"].as_str().expect("label");
    for (transport, expected) in [
        (TransportKind::Http1, "xai:responses SSE stream truncated: incomplete (max_output_tokens) with tool call in flight".to_owned()),
        (TransportKind::WebSocket, format!("{ws_label} response.incomplete (max_output_tokens) with tool call in flight")),
    ] {
        let codec = CompatResponsesCodec::new(CompatProfile::xai(), CompatConfig::default(), transport);
        let mut decoder = codec.decoder(&base_request("grok-4.5"));
        let frames = [
            json!({"type": "response.output_item.added", "item": {"type": "function_call", "id": "fc1", "call_id": "c1", "name": "lookup"}}),
            json!({"type": "response.incomplete", "response": {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "output": []}}),
        ];
        let mut failure = None;
        for frame in frames {
            let bytes = if transport == TransportKind::WebSocket { frame.to_string() } else { format!("data: {frame}\n\n") };
            if let Err(error) = decoder.feed(bytes.as_bytes()) {
                failure = Some(error);
            }
        }
        assert_eq!(failure.expect("a cut stream").message, expected);
    }
}
