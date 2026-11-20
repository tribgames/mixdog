//! The OpenAI Responses wire, per route: freeform tools as `custom` tools, the Codex identity block of the WebSocket
//! (handshake headers and frame metadata), the process settings that change a request, and what a cut stream says.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_ai::providers::openai::client_meta::codex_uuid_v7;
use mixdog_ai::providers::openai::client_meta::v7_stamp;
use mixdog_ai::providers::openai::codec::OpenAiCodec;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::ModelFacts;
use mixdog_ai::providers::openai::config::ModelFactsSource;
use mixdog_ai::providers::openai::config::OpenAiConfig;
use mixdog_ai::providers::openai::config::REPLAY_OWNER;
use mixdog_ai::providers::openai::config::WireContext;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::RequestThread;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::ToolExclusionSink;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::tool::Freeform;
use mixdog_protocol::ProviderId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

#[derive(Clone, Default)]
struct Ctx {
    now: u64,
    turn_state: Option<String>,
    settings: Vec<(String, String)>,
}

impl WireContext for Ctx {
    fn request_id(&self) -> String {
        "0".repeat(32)
    }
    fn now_unix_ms(&self) -> u64 {
        self.now
    }
    fn turn_state(&self, scope: &str, turn_id: &str) -> Option<String> {
        (scope == "scope-1" && turn_id == "turn-1").then(|| self.turn_state.clone()).flatten()
    }
    fn var(&self, name: &str) -> Option<String> {
        self.settings.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone())
    }
}

#[derive(Default)]
struct Facts {
    native_tool_search: bool,
    fast: bool,
}

impl ModelFactsSource for Facts {
    fn facts(&self, _model: &str) -> ModelFacts {
        ModelFacts { native_tool_search: Some(self.native_tool_search), fast_tier: self.fast, codex_fast_tier: self.fast, ..ModelFacts::default() }
    }
}

fn identity(installation: &str) -> CodexIdentity {
    CodexIdentity { installation_id: installation.into(), user_agent: "ua/1".into(), version: "0.166.0".into(), beta_features: "remote_compaction_v2".into() }
}

fn codex(transport: TransportKind, ctx: Ctx, facts: Facts) -> OpenAiCodec {
    OpenAiCodec::new(OpenAiConfig::codex(false, identity("inst-1"), Arc::new(facts), Arc::new(ctx)), transport)
}

fn api_key(transport: TransportKind, ctx: Ctx, facts: Facts) -> OpenAiCodec {
    OpenAiCodec::new(OpenAiConfig::api_key(false, Arc::new(facts), Arc::new(ctx)), transport)
}

fn user(text: &str) -> Message {
    Message::new(Role::User, Content::Text(text.into()))
}

fn request(model: &str, options: RequestOptions) -> ModelRequest {
    ModelRequest { model: model.into(), messages: vec![Message::new(Role::System, Content::Text("sys".into())), user("go")], tools: vec![], options }
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

fn body(codec: &OpenAiCodec, request: &ModelRequest) -> Value {
    serde_json::from_slice(&codec.encode(request).unwrap().body).unwrap()
}

// freeform (custom) tools

const GRAMMAR: &str = "start: line+\nline: /.+/";

fn lookup() -> ToolDefinition {
    ToolDefinition {
        name: "lookup".into(),
        description: "Read a value".into(),
        input_schema: json!({"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]}),
        defer_loading: false,
        freeform: None,
    }
}

fn freeform(name: &str, schema: Value, description: &str, grammar: Value) -> ToolDefinition {
    ToolDefinition {
        name: name.into(),
        description: "the tool's own description".into(),
        input_schema: schema,
        defer_loading: false,
        freeform: Some(Freeform { description: description.into(), grammar }),
    }
}

fn lark() -> Value {
    json!({"type": "grammar", "syntax": "lark", "definition": GRAMMAR})
}

type Reports = Arc<Mutex<Vec<(String, usize, String)>>>;

fn sent_tools(codec: &OpenAiCodec, tools: Vec<ToolDefinition>) -> (Vec<Value>, Vec<(String, usize, String)>) {
    let reports: Reports = Arc::default();
    let sink = reports.clone();
    let mut request = request("gpt-5", RequestOptions::default());
    request.tools = tools;
    request.options.on_tool_excluded = Some(ToolExclusionSink(Arc::new(move |r| sink.lock().unwrap().push((r.name, r.index, r.pointer)))));
    let body = body(codec, &request);
    let tools = body["tools"].as_array().cloned().unwrap_or_default();
    (tools, reports.lock().unwrap().clone())
}

#[test]
fn a_freeform_tool_goes_out_as_a_custom_tool_on_both_routes_with_its_own_description_and_grammar() {
    for (route, codec) in
        [("codex", codex(TransportKind::Http1, Ctx::default(), Facts::default())), ("api key", api_key(TransportKind::Http1, Ctx::default(), Facts::default()))]
    {
        let (tools, left_out) = sent_tools(&codec, vec![lookup(), freeform("apply_patch", json!({"type": "object"}), "Edit files with a patch", lark())]);
        assert!(left_out.is_empty(), "{route}");
        assert_eq!(tools.len(), 2, "{route}");
        assert_eq!(tools[0]["type"], "function", "{route}");
        assert_eq!(
            serde_json::to_string(&tools[1]).unwrap(),
            format!("{{\"type\":\"custom\",\"name\":\"apply_patch\",\"description\":\"Edit files with a patch\",\"format\":{}}}", lark()),
            "{route}: the keys in this order, the grammar as given"
        );
        // Without a description of its own the tool's description is used.
        let (tools, _) = sent_tools(&codec, vec![freeform("apply_patch", Value::Null, "", lark())]);
        assert_eq!(tools[0]["description"], "the tool's own description", "{route}");
    }
}

#[test]
fn a_freeform_tool_is_never_checked_against_the_json_schema_rule_nor_deferred() {
    for native in [false, true] {
        let codec = api_key(TransportKind::Http1, Ctx::default(), Facts { native_tool_search: native, ..Facts::default() });
        let mut deferred = freeform("apply_patch", json!("not a schema"), "patch", lark());
        deferred.defer_loading = true;
        let (tools, left_out) = sent_tools(&codec, vec![deferred]);
        assert!(left_out.is_empty(), "native={native}: a grammar needs no schema");
        assert_eq!(tools.iter().map(|t| t["type"].as_str().unwrap()).collect::<Vec<_>>(), ["custom"], "native={native}");
        assert!(tools[0].get("defer_loading").is_none(), "native={native}");
    }
}

#[test]
fn a_tool_whose_grammar_is_not_a_grammar_is_an_ordinary_function_and_checked_like_one() {
    let codec = codex(TransportKind::Http1, Ctx::default(), Facts::default());
    let regex = json!({"type": "regex", "definition": "a+"});
    let (tools, left_out) = sent_tools(&codec, vec![freeform("fine", json!({"type": "object", "properties": {}}), "x", regex.clone())]);
    assert_eq!((tools[0]["type"].as_str(), tools[0]["name"].as_str()), (Some("function"), Some("fine")));
    assert!(left_out.is_empty());
    let (tools, left_out) = sent_tools(&codec, vec![freeform("broken", json!({"type": "string"}), "x", regex)]);
    assert!(tools.is_empty(), "its schema is no object schema, so it is left out");
    assert_eq!(left_out.iter().map(|(n, i, _)| (n.as_str(), *i)).collect::<Vec<_>>(), [("broken", 0)]);
}

#[test]
fn a_deferred_tool_is_marked_only_where_the_route_searches_tools_natively() {
    let mut deferred = lookup();
    deferred.name = "later".into();
    deferred.defer_loading = true;
    let plain = api_key(TransportKind::Http1, Ctx::default(), Facts::default());
    let (tools, _) = sent_tools(&plain, vec![deferred.clone()]);
    assert!(tools[0].get("defer_loading").is_none(), "no native search: a plain function");
    // The Codex backend always searches natively; the public API only for models the catalog says do.
    let native = api_key(TransportKind::Http1, Ctx::default(), Facts { native_tool_search: true, ..Facts::default() });
    let (tools, _) = sent_tools(&native, vec![deferred]);
    assert_eq!(tools[0]["defer_loading"], true);
}

// Codex identity

const V7: &str = "0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b";

#[test]
fn an_id_that_is_already_a_v7_uuid_is_kept_and_any_other_is_mapped_to_one_deterministically() {
    assert_eq!(codex_uuid_v7(&format!("  {}  ", V7.to_uppercase())), V7, "trimmed and lower-cased");
    let mapped = codex_uuid_v7("my-session");
    assert_eq!(mapped, codex_uuid_v7("  MY-SESSION "), "the same session gives the same id");
    assert_ne!(mapped, codex_uuid_v7("my-session-2"));
    let b = mapped.as_bytes();
    assert_eq!(mapped.len(), 36);
    assert!(b[8] == b'-' && b[13] == b'-' && b[18] == b'-' && b[23] == b'-');
    assert_eq!(b[14], b'7', "version 7");
    assert!(matches!(b[19], b'8' | b'9' | b'a' | b'b'), "RFC 4122 variant");
    assert_eq!(v7_stamp(V7), Some(0x0190_a1b2_c3d4));
    assert!(v7_stamp(&mapped).is_some());
    assert_eq!(v7_stamp("not-an-id"), None);
}

fn socket(ctx: Ctx, facts: Facts) -> OpenAiCodec {
    codex(TransportKind::WebSocket, ctx, facts)
}

fn frame_metadata(codec: &OpenAiCodec, request: &ModelRequest, turn_state: Option<&str>) -> Map<String, Value> {
    let mut frame = Map::new();
    frame.insert("type".into(), "response.create".into());
    let framed = codec.ws_frame(request, frame, turn_state);
    framed["client_metadata"].as_object().unwrap().clone()
}

#[test]
fn the_socket_opens_as_a_prewarm_with_one_identity_block_and_no_turn() {
    let options = RequestOptions { session_id: Some("session-a".into()), ..RequestOptions::default() };
    let wire = socket(Ctx { now: 1_700_000_000_123, ..Ctx::default() }, Facts::default()).encode(&request("gpt-5.5", options)).unwrap();
    let h = &wire.headers;
    assert_eq!((wire.method.as_str(), wire.url.as_str()), ("GET", "wss://chatgpt.com/backend-api/codex/responses"));
    let session = codex_uuid_v7("session-a");
    assert_eq!(header(h, "session-id"), Some(session.as_str()));
    assert_eq!(header(h, "thread-id"), Some(session.as_str()), "with no thread of its own the thread is the session");
    assert_eq!(header(h, "x-client-request-id"), Some(session.as_str()), "on a socket the request id is the thread, not a random draw");
    assert_eq!(header(h, "x-codex-window-id"), Some(format!("{session}:0").as_str()));
    assert_eq!(header(h, "x-codex-routing-hint"), Some("model=gpt-5.5"));
    assert!(header(h, "x-codex-turn-state").is_none(), "a socket opens without turn state");
    assert_eq!(header(h, "originator"), Some("codex_cli_rs"));
    assert_eq!(header(h, "OpenAI-Beta"), Some("responses_websockets=2026-02-06"));
    let turn: Value = serde_json::from_str(header(h, "x-codex-turn-metadata").unwrap()).unwrap();
    assert_eq!((turn["request_kind"].as_str(), turn["turn_id"].as_str()), (Some("prewarm"), Some("")));
    assert!(turn.get("turn_trigger").is_none() && turn.get("turn_started_at_unix_ms").is_none(), "a prewarm has no turn");
    assert_eq!((turn["installation_id"].as_str(), turn["session_id"].as_str()), (Some("inst-1"), Some(session.as_str())));
}

#[test]
fn the_routing_hint_names_the_service_tier_the_body_asks_for() {
    let fast = RequestOptions { fast: true, ..RequestOptions::default() };
    let wire = socket(Ctx::default(), Facts { fast: true, ..Facts::default() }).encode(&request("gpt-5.5", fast.clone())).unwrap();
    assert_eq!(header(&wire.headers, "x-codex-routing-hint"), Some("model=gpt-5.5;tier=priority"));
    let wire = socket(Ctx::default(), Facts::default()).encode(&request("gpt-5.5", fast)).unwrap();
    assert_eq!(header(&wire.headers, "x-codex-routing-hint"), Some("model=gpt-5.5"), "a model without the tier is not routed by it");
}

#[test]
fn the_identity_is_taken_from_the_thread_then_the_cache_key_then_the_session_in_that_order() {
    let options = RequestOptions {
        session_id: Some("session-a".into()),
        prompt_cache_key: Some("cache-k".into()),
        thread: Some(RequestThread { id: "thread-t".into(), window: 4, turn: None, turn_started_at_ms: None }),
        ..RequestOptions::default()
    };
    let meta = frame_metadata(&socket(Ctx::default(), Facts::default()), &request("m", options.clone()), None);
    assert_eq!(meta["session_id"], codex_uuid_v7("session-a").as_str());
    assert_eq!(meta["thread_id"], codex_uuid_v7("thread-t").as_str());
    assert_eq!(meta["x-codex-window-id"], "thread-t:4");
    let no_thread = RequestOptions { thread: None, ..options.clone() };
    let meta = frame_metadata(&socket(Ctx::default(), Facts::default()), &request("m", no_thread), None);
    assert_eq!(meta["thread_id"], codex_uuid_v7("cache-k").as_str());
    let only_cache = RequestOptions { prompt_cache_key: Some("cache-k".into()), ..RequestOptions::default() };
    let meta = frame_metadata(&socket(Ctx::default(), Facts::default()), &request("m", only_cache), None);
    assert_eq!(meta["session_id"], codex_uuid_v7("cache-k").as_str(), "no session: the transport scope, then the cache key");
    let nothing = frame_metadata(&socket(Ctx::default(), Facts::default()), &request("m", RequestOptions::default()), None);
    assert_eq!(nothing["session_id"], codex_uuid_v7("mixdog-session").as_str());
}

#[test]
fn a_frames_client_metadata_carries_the_turn_its_start_and_the_turn_state_it_was_given() {
    let options = RequestOptions {
        session_id: Some("session_1700000000000_x".into()),
        thread: Some(RequestThread { id: "thread-t".into(), window: 0, turn: Some("turn-9".into()), turn_started_at_ms: None }),
        ..RequestOptions::default()
    };
    let codec = socket(Ctx { now: 5_000, ..Ctx::default() }, Facts::default());
    let meta = frame_metadata(&codec, &request("m", options.clone()), Some("state-token"));
    assert_eq!(
        meta.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "x-codex-installation-id",
            "session_id",
            "thread_id",
            "turn_id",
            "x-codex-window-id",
            "x-codex-turn-metadata",
            "x-codex-ws-stream-request-start-ms",
            "x-codex-turn-state"
        ]
    );
    assert_eq!(meta["x-codex-installation-id"], "inst-1");
    assert_eq!(meta["turn_id"], codex_uuid_v7("turn-9").as_str());
    assert_eq!(meta["x-codex-ws-stream-request-start-ms"], "5000", "the send time, as text");
    assert_eq!(meta["x-codex-turn-state"], "state-token");
    let turn: Value = serde_json::from_str(meta["x-codex-turn-metadata"].as_str().unwrap()).unwrap();
    assert_eq!((turn["request_kind"].as_str(), turn["turn_trigger"].as_str()), (Some("turn"), Some("user")));
    assert_eq!(turn["turn_started_at_unix_ms"], 1_700_000_000_000_u64, "a session id that embeds its start time says when the turn began");
    assert_eq!(turn["turn_id"], meta["turn_id"]);

    let without_state = frame_metadata(&codec, &request("m", options.clone()), None);
    assert!(!without_state.contains_key("x-codex-turn-state"));
    let started = RequestOptions { thread: Some(RequestThread { id: "t".into(), window: 0, turn: None, turn_started_at_ms: Some(42) }), ..options };
    let turn: Value = serde_json::from_str(frame_metadata(&codec, &request("m", started), None)["x-codex-turn-metadata"].as_str().unwrap()).unwrap();
    assert_eq!(turn["turn_started_at_unix_ms"], 42, "the turn's own start wins");
    let plain = RequestOptions { session_id: Some("plain".into()), ..RequestOptions::default() };
    let turn: Value = serde_json::from_str(frame_metadata(&codec, &request("m", plain), None)["x-codex-turn-metadata"].as_str().unwrap()).unwrap();
    assert_eq!(turn["turn_started_at_unix_ms"], 5000, "no embedded time: now");
}

#[test]
fn the_kind_of_a_request_is_named_or_inferred_from_its_session() {
    let kind = |session: &str, explicit: Option<&str>| -> (String, String) {
        let options = RequestOptions { session_id: Some(session.into()), request_kind: explicit.map(str::to_owned), ..RequestOptions::default() };
        let meta = frame_metadata(&socket(Ctx::default(), Facts::default()), &request("m", options), None);
        let turn: Value = serde_json::from_str(meta["x-codex-turn-metadata"].as_str().unwrap()).unwrap();
        (turn["request_kind"].as_str().unwrap().to_owned(), meta["turn_id"].as_str().unwrap().to_owned())
    };
    assert_eq!(kind("s1", None).0, "turn");
    assert_eq!(kind("s1:compact", None).0, "compaction");
    assert_eq!(kind("s1", Some("custom-kind")).0, "custom-kind");
    let (prewarm, turn_id) = kind("s1", Some("prewarm"));
    assert_eq!((prewarm.as_str(), turn_id.as_str()), ("prewarm", ""), "a prewarm frame has no turn");
}

#[test]
fn a_frames_own_client_metadata_is_kept_and_the_api_key_route_adds_none() {
    let mut frame = Map::new();
    frame.insert("type".into(), "response.create".into());
    frame.insert("client_metadata".into(), json!({"caller-key": "kept", "session_id": "overridden"}));
    let codec = socket(Ctx::default(), Facts::default());
    let framed = codec.ws_frame(&request("m", RequestOptions::default()), frame.clone(), None);
    assert_eq!(framed["client_metadata"]["caller-key"], "kept");
    assert_eq!(framed["client_metadata"]["session_id"], "overridden", "what the caller set wins over the derived value");
    let plain = api_key(TransportKind::WebSocket, Ctx::default(), Facts::default());
    assert_eq!(plain.ws_frame(&request("m", RequestOptions::default()), frame.clone(), None), frame, "the public API gets the frame as built");
    let wire = plain.encode(&request("m", RequestOptions::default())).unwrap();
    assert!(header(&wire.headers, "session-id").is_none() && header(&wire.headers, "x-codex-window-id").is_none());
    assert_eq!(header(&wire.headers, "x-client-request-id"), Some("0".repeat(32).as_str()));
}

// process settings

fn stateless(setting: Option<&str>) -> Ctx {
    Ctx { settings: setting.map(|v| ("MIXDOG_OAI_STATELESS_HTTP".to_owned(), v.to_owned())).into_iter().collect(), ..Ctx::default() }
}

fn http_headers(ctx: Ctx, options: RequestOptions) -> Vec<(String, String)> {
    codex(TransportKind::Http1, ctx, Facts::default()).encode(&request("gpt-5", options)).unwrap().headers
}

#[test]
fn the_http_request_anchors_the_conversation_on_the_cache_key_unless_stateless_http_is_set() {
    let options = RequestOptions { session_id: Some("session-a".into()), prompt_cache_key: Some("lane-1".into()), ..RequestOptions::default() };
    let on = http_headers(stateless(None), options.clone());
    let key = header(&on, "session-id").expect("anchored").to_owned();
    assert!(!key.is_empty());
    assert_eq!((header(&on, "session_id"), header(&on, "thread-id")), (Some(key.as_str()), Some(key.as_str())), "the three anchors carry the body's cache key");
    assert!(header(&on, "x-codex-window-id").is_none(), "the thread's window and metadata ride only the socket");
    assert_eq!(header(&on, "x-client-request-id"), Some("0".repeat(32).as_str()));
    assert_eq!(header(&on, "OpenAI-Beta"), Some("responses=experimental"));

    for spelling in ["1", "true", "YES", " on "] {
        let off = http_headers(stateless(Some(spelling)), options.clone());
        assert!(["session_id", "session-id", "thread-id"].iter().all(|h| header(&off, h).is_none()), "{spelling:?}: no anchors");
        assert!(header(&off, "x-client-request-id").is_some(), "{spelling:?}: the rest of the request is unchanged");
    }
    for spelling in ["0", "false", "", "maybe"] {
        let still = http_headers(stateless(Some(spelling)), options.clone());
        assert_eq!(header(&still, "session-id"), Some(key.as_str()), "{spelling:?}: only the documented spellings turn it on");
    }
}

#[test]
fn the_turn_state_token_rides_the_http_request_of_its_own_turn_only() {
    let ctx = Ctx { turn_state: Some("token-1".into()), ..Ctx::default() };
    let thread = |turn: &str| RequestOptions {
        transport_scope: Some("scope-1".into()),
        thread: Some(RequestThread { id: "t".into(), window: 0, turn: Some(turn.into()), turn_started_at_ms: None }),
        ..RequestOptions::default()
    };
    assert_eq!(header(&http_headers(ctx.clone(), thread("turn-1")), "x-codex-turn-state"), Some("token-1"));
    assert_eq!(header(&http_headers(ctx.clone(), thread("turn-2")), "x-codex-turn-state"), None, "another turn was issued no token");
    assert_eq!(header(&http_headers(ctx, RequestOptions::default()), "x-codex-turn-state"), None);
}

fn assistant_with_reasoning() -> Message {
    let mut message = Message::new(Role::Assistant, Content::Text("earlier answer".into()));
    message.push_replay(ProviderReplay {
        owner: ProviderId::from(REPLAY_OWNER),
        items: json!([
            {"type": "reasoning", "id": "rs_1", "encrypted_content": "ENC", "summary": []},
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "earlier answer"}]},
        ]),
    });
    message
}

#[test]
fn the_reasoning_replay_switch_stops_reasoning_items_going_back_and_keeps_the_rest_of_the_turn() {
    let mut request = request("gpt-5", RequestOptions::default());
    request.messages = vec![user("first"), assistant_with_reasoning(), user("second")];
    let types = |ctx: Ctx| -> Vec<String> {
        let body = body(&codex(TransportKind::Http1, ctx, Facts::default()), &request);
        body["input"].as_array().unwrap().iter().filter_map(|i| i["type"].as_str().map(str::to_owned)).collect()
    };
    let default = types(Ctx::default());
    assert!(default.contains(&"reasoning".to_owned()), "{default:?}");
    let disabled = types(Ctx { settings: vec![("MIXDOG_OAI_DISABLE_REASONING_REPLAY".into(), "1".into())], ..Ctx::default() });
    assert!(!disabled.contains(&"reasoning".to_owned()), "{disabled:?}");
    assert_eq!(disabled.len() + 1, default.len(), "only the reasoning item is gone");
    let spelled_off = types(Ctx { settings: vec![("MIXDOG_OAI_DISABLE_REASONING_REPLAY".into(), "no".into())], ..Ctx::default() });
    assert_eq!(spelled_off, default);
}

// a cut stream

#[test]
fn a_cut_responses_stream_names_its_route_and_transport() {
    let frames = [
        json!({"type": "response.output_item.added", "item": {"type": "function_call", "id": "fc1", "call_id": "c1", "name": "lookup"}}),
        json!({"type": "response.incomplete", "response": {"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "output": []}}),
    ];
    for (route, codec, label) in [
        ("api key http", api_key(TransportKind::Http1, Ctx::default(), Facts::default()), "OpenAI HTTP fallback"),
        ("api key ws", api_key(TransportKind::WebSocket, Ctx::default(), Facts::default()), "OpenAI WS"),
        ("codex http", codex(TransportKind::Http1, Ctx::default(), Facts::default()), "OpenAI OAuth HTTP fallback"),
        ("codex ws", codex(TransportKind::WebSocket, Ctx::default(), Facts::default()), "OpenAI OAuth WS"),
    ] {
        let mut decoder = codec_decoder(&codec);
        let mut message = None;
        for frame in &frames {
            let bytes = if codec.transport() == TransportKind::WebSocket { frame.to_string() } else { format!("data: {frame}\n\n") };
            if let Err(error) = decoder.feed(bytes.as_bytes()) {
                message = Some(error.message.clone());
            }
        }
        assert_eq!(message.expect("a cut stream"), format!("{label} response.incomplete (max_output_tokens) with tool call in flight"), "{route}");
    }
}

fn codec_decoder(codec: &OpenAiCodec) -> Box<dyn mixdog_core_api::domain::provider::WireDecoder> {
    codec.decoder(&request("gpt-5", RequestOptions::default()))
}
