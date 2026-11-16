//! The pooled WebSocket: delta frames on a reused socket, a fresh socket after
//! a failure, and the move to HTTP/SSE, over scripted seams.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::catalog::ListingLookup;
use mixdog_ai::providers::openai::adapter::AdapterLinks;
use mixdog_ai::providers::openai::adapter::Credential;
use mixdog_ai::providers::openai::adapter::CredentialSource;
use mixdog_ai::providers::openai::adapter::OpenAiAdapter;
use mixdog_ai::providers::openai::adapter::SessionContext;
use mixdog_ai::providers::openai::codec::OpenAiCodec;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::NoFacts;
use mixdog_ai::providers::openai::config::OpenAiConfig;
use mixdog_ai::providers::openai::switch::TransportMode;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_ai::transport::WsDial;
use mixdog_ai::transport::WsSocket;
use mixdog_ai::transport::ws::ConnectError;
use mixdog_ai::transport::ws::Message;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::keepalive::LinkLiveness;
use mixdog_core_api::domain::keepalive::TransportKeepalive;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message as ChatMessage;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::RequestThread;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use tokio_tungstenite::tungstenite::http::Response;

struct VecBody(VecDeque<Bytes>);

#[async_trait]
impl BodyStream for VecBody {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.pop_front().map(Ok)
    }
}

#[derive(Default)]
struct Http {
    seen: Mutex<Vec<WireRequest>>,
    /// The HEAD warm-ups, apart from the turns in seen.
    warmups: Mutex<Vec<WireRequest>>,
}

#[async_trait]
impl HttpSend for Http {
    async fn send(
        &self,
        request: WireRequest,
        _exchange: mixdog_ai::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        // A HEAD is the provider's connection warm-up, not a turn: answered empty and recorded apart.
        if request.method == "HEAD" {
            self.warmups.lock().unwrap().push(request);
            return Ok(HttpResponse { status: 200, headers: vec![], body: Box::new(VecBody(Default::default())) });
        }
        self.seen.lock().unwrap().push(request);
        let sse = format!("data: {}\n\n", answer_event("resp_http", "via http", "response.completed"));
        Ok(HttpResponse { status: 200, headers: vec![], body: Box::new(VecBody([Bytes::from(sse)].into())) })
    }
}

struct Alive;
impl TransportKeepalive for Alive {
    fn kind(&self) -> TransportKind {
        TransportKind::WebSocket
    }
    fn arm(&self, _: &KeepaliveSchedule) -> Result<(), TransportFault> {
        Ok(())
    }
    fn liveness(&self) -> LinkLiveness {
        LinkLiveness::Alive
    }
    fn may_start_response(&self) -> bool {
        true
    }
}

struct Socket {
    sent: Arc<Mutex<Vec<String>>>,
    frames: VecDeque<Result<Message, TransportFault>>,
}

#[async_trait]
impl WsSocket for Socket {
    async fn send(&self, message: Message) -> Result<(), TransportFault> {
        if let Message::Text(text) = message {
            self.sent.lock().unwrap().push(text.as_str().to_owned());
        }
        Ok(())
    }
    async fn recv(&mut self) -> Option<Result<Message, TransportFault>> {
        self.frames.pop_front()
    }
    fn link(&self) -> Arc<dyn TransportKeepalive> {
        Arc::new(Alive)
    }
}

enum Dialed {
    Socket(Vec<Result<Message, TransportFault>>),
    Rejected(u16),
    /// The upgrade is never answered.
    Stuck,
    /// The connection is reset before the upgrade is answered.
    Reset,
}

struct Dial {
    script: Mutex<VecDeque<Dialed>>,
    sent: Arc<Mutex<Vec<String>>>,
    headers: Mutex<Vec<tokio_tungstenite::tungstenite::http::HeaderMap>>,
    dials: Mutex<u32>,
    /// The dials begun so far, as an event a test can wait for.
    began: tokio::sync::watch::Sender<u32>,
}

impl Dial {
    fn with(script: Vec<Dialed>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script.into()),
            sent: Arc::default(),
            headers: Mutex::default(),
            dials: Mutex::new(0),
            began: tokio::sync::watch::channel(0).0,
        })
    }
}

#[async_trait]
impl WsDial for Dial {
    async fn dial(
        &self,
        request: tokio_tungstenite::tungstenite::handshake::client::Request,
    ) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError> {
        self.headers.lock().unwrap().push(request.headers().clone());
        *self.dials.lock().unwrap() += 1;
        self.began.send_modify(|n| *n += 1);
        let next = self.script.lock().unwrap().pop_front().expect("a scripted dial");
        match next {
            Dialed::Stuck => std::future::pending().await,
            Dialed::Reset => Err(ConnectError::Transport(TransportFault::Reset)),
            Dialed::Socket(frames) => Ok((
                Box::new(Socket { sent: self.sent.clone(), frames: frames.into() }),
                Response::builder().status(101).body(None).unwrap(),
            )),
            Dialed::Rejected(status) => {
                Err(ConnectError::Rejected(Response::builder().status(status).body(Some(b"{}".to_vec())).unwrap()))
            }
        }
    }
}

struct Creds;

#[async_trait]
impl CredentialSource for Creds {
    async fn current(&self) -> Result<Credential, ProviderError> {
        Ok(Credential { bearer: "tok".into(), account_id: Some("acct".into()) })
    }
    async fn after_rejection(&self, _: &Credential) -> Result<Option<Credential>, ProviderError> {
        Ok(None)
    }
}

fn adapter(codex: bool, http: Arc<Http>, dial: Arc<Dial>) -> OpenAiAdapter {
    // Every clock read advances, so accidental turn re-stamping cannot pass
    // merely because encoding and sending happened in the same millisecond.
    let clock = AtomicU64::new(1_790_000_000_000);
    let context = Arc::new(SessionContext::with_sources(move || clock.fetch_add(1, Ordering::Relaxed), || "request-id".into()));
    let config = if codex {
        let identity = CodexIdentity {
            installation_id: "i".into(),
            user_agent: "ua".into(),
            version: "1".into(),
            beta_features: "b".into(),
        };
        OpenAiConfig::codex(false, false, identity, Arc::new(NoFacts), context.clone())
    } else {
        OpenAiConfig::api_key(false, Arc::new(NoFacts), context.clone())
    };
    OpenAiAdapter::new(
        ProviderId::from(if codex { "openai-oauth" } else { "openai" }),
        OpenAiCodec::new(config, TransportKind::WebSocket),
        AdapterLinks { http, dial, compress_lane: mixdog_rt::testing::tokens().cpu_bulk, credentials: Arc::new(Creds), context, listing: ListingLookup::new() },
    )
}

fn say(role: Role, text: &str) -> ChatMessage {
    ChatMessage::new(role, Content::Text(text.into()))
}

fn request(messages: Vec<ChatMessage>) -> Arc<ModelRequest> {
    Arc::new(ModelRequest {
        model: "gpt-fixture".into(),
        messages,
        tools: vec![],
        options: RequestOptions {
            session_id: Some("session-1".into()),
            prompt_cache_key: Some("lane".into()),
            thread: Some(RequestThread {
                id: "thread".into(),
                window: 0,
                turn: Some("turn".into()),
                turn_started_at_ms: Some(1_789_999_000_000),
            }),
            ..Default::default()
        },
    })
}

fn answer_event(id: &str, text: &str, kind: &str) -> String {
    format!(
        r#"{{"type":"{kind}","response":{{"id":"{id}","model":"m","status":"completed","usage":{{"input_tokens":1,"output_tokens":1}},"output":[{{"type":"message","id":"msg_{id}","role":"assistant","content":[{{"type":"output_text","text":"{text}"}}]}}]}}}}"#
    )
}

/// The frames of one complete answer.
fn answer(id: &str, text: &str) -> Vec<Result<Message, TransportFault>> {
    [
        format!(r#"{{"type":"response.created","response":{{"id":"{id}","model":"m"}}}}"#),
        format!(r#"{{"type":"response.output_item.added","output_index":0,"item":{{"type":"message","id":"msg_{id}","role":"assistant","content":[]}}}}"#),
        format!(r#"{{"type":"response.output_text.delta","output_index":0,"item_id":"msg_{id}","delta":"{text}"}}"#),
        format!(r#"{{"type":"response.output_item.done","output_index":0,"item":{{"type":"message","id":"msg_{id}","role":"assistant","content":[{{"type":"output_text","text":"{text}"}}]}}}}"#),
        answer_event(id, text, "response.completed"),
    ]
    .into_iter()
    .map(|f| Ok(Message::text(f)))
    .collect()
}

async fn drain(adapter: &OpenAiAdapter, request: Arc<ModelRequest>) -> Result<(), ProviderError> {
    let mut stream = adapter.attempt(request).await?;
    while let Some(event) = stream.next().await {
        event?;
    }
    Ok(())
}

fn frames(dial: &Dial) -> Vec<Value> {
    dial.sent.lock().unwrap().iter().map(|f| serde_json::from_str(f).unwrap()).collect()
}

fn assert_same_request(first: &Value, retry: &Value) {
    let mut first = first.clone();
    let mut retry = retry.clone();
    if let Some(metadata) = first.get_mut("client_metadata").and_then(Value::as_object_mut) {
        let before = metadata.remove("x-codex-ws-stream-request-start-ms").unwrap();
        let after = retry["client_metadata"].as_object_mut().unwrap().remove("x-codex-ws-stream-request-start-ms").unwrap();
        assert!(after.as_str().unwrap().parse::<u64>().unwrap() > before.as_str().unwrap().parse::<u64>().unwrap(),
            "Node re-stamps the stream start on each attempt");
    }
    assert_eq!(first, retry, "same model, request and logical turn identity");
}

fn connection_limit() -> Result<Message, TransportFault> {
    Ok(Message::text(r#"{"type":"error","status":400,"error":{"code":"websocket_connection_limit_reached","type":"invalid_request_error","message":"connection retired"}}"#))
}

#[tokio::test]
async fn connection_limit_typed_400_legacy_verdict_retries_on_a_fresh_socket() {
    use mixdog_core_api::domain::retry::{JitterSamples, RetryClass, RetryDecider, RetryState, Verdict};

    let dial = Dial::with(vec![Dialed::Socket(vec![connection_limit()]), Dialed::Socket(answer("resp_new", "continued"))]);
    let adapter = adapter(true, Arc::default(), dial.clone());
    let request = request(vec![say(Role::User, "hi")]);
    // The pre-change path: a single exchange returns the decoder's error to
    // the agent's StandardRetryDecider, without provider-owned recovery.
    let mut stream = adapter.ws_attempt_once(request.clone()).await.unwrap();
    let error = stream.next().await.unwrap().unwrap_err();
    assert_eq!(error.status, Some(400));
    assert_eq!(error.kind, mixdog_core_api::domain::provider::ErrorKind::Transient);
    let decision = mixdog_ai::retry::StandardRetryDecider.verdict(
        &error,
        &RetryState::new(RetryClass::Midstream, request.model.clone()),
        adapter.retry_policy(),
        JitterSamples { step: 0.5, advice: 0.5 },
    );
    assert!(matches!(decision.verdict, Verdict::Retry { .. }), "typed 400 alone did not deny this retry");
    drop(stream);
    let mut retry = adapter.ws_attempt_once(request).await.unwrap();
    let mut text = String::new();
    while let Some(event) = retry.next().await {
        if let StreamEvent::TextDelta(delta) = event.unwrap() {
            text.push_str(&delta);
        }
    }
    assert_eq!(text, "continued");
    assert_eq!(*dial.dials.lock().unwrap(), 2);
    assert_eq!(frames(&dial)[1].get("previous_response_id"), None);
}

#[tokio::test(start_paused = true)]
async fn connection_limit_before_output_and_midstream_renews_inside_one_attempt() {
    for codex in [true, false] {
        for midstream in [false, true] {
            let mut retired = Vec::new();
            if midstream {
                retired.push(Ok(Message::text(r#"{"type":"response.created","response":{"id":"expired_response"}}"#)));
                retired.push(Ok(Message::text(r#"{"type":"codex.rate_limits"}"#)));
            }
            retired.push(if midstream {
                Ok(Message::text(r#"{"type":"error","status":400,"error":{"code":"invalid_request_error","type":"websocket_connection_limit_reached"}}"#))
            } else {
                connection_limit()
            });
            let dial = Dial::with(vec![Dialed::Socket(retired), Dialed::Socket(answer("resp_new", "continued"))]);
            let http = Arc::new(Http::default());
            let adapter = adapter(codex, http.clone(), dial.clone());
            // One caller attempt, as used by a fork: no caller retry or fallback
            // can hide an escaped error. The same is true at the agent boundary.
            let mut stream = adapter.attempt(request(vec![say(Role::User, "continue the task")])).await.unwrap();
            let mut text = String::new();
            let mut completed = 0;
            while let Some(event) = stream.next().await {
                match event.expect("connection retirement must not reach fallback") {
                    StreamEvent::TextDelta(delta) => text.push_str(&delta),
                    StreamEvent::Completed { .. } => completed += 1,
                    _ => {}
                }
            }
            assert_eq!(text, "continued");
            assert_eq!(completed, 1);
            assert_eq!(*dial.dials.lock().unwrap(), 2, "the retry opens a different connection");
            assert!(http.seen.lock().unwrap().is_empty(), "no transport fallback");
            let sent = frames(&dial);
            assert_eq!(sent.len(), 2);
            assert_same_request(&sent[0], &sent[1]);
            assert_eq!(sent[1].get("previous_response_id"), None);
        }
    }
}

#[tokio::test(start_paused = true)]
async fn connection_limit_between_tool_calls_replays_history_without_the_old_chain() {
    let call = serde_json::json!({
        "type": "function_call", "id": "fc_1", "call_id": "call_1",
        "name": "read", "arguments": "{}"
    });
    let mut retired: Vec<_> = [
        serde_json::json!({"type":"response.created","response":{"id":"resp_tools"}}),
        serde_json::json!({"type":"response.output_item.added","output_index":0,"item":call}),
        serde_json::json!({"type":"response.output_item.done","output_index":0,"item":call}),
        serde_json::json!({"type":"response.completed","response":{
            "id":"resp_tools","status":"completed","output":[call],
            "usage":{"input_tokens":1,"output_tokens":1}
        }}),
    ].into_iter().map(|event| Ok(Message::text(event.to_string()))).collect();
    retired.push(connection_limit());
    let dial = Dial::with(vec![Dialed::Socket(retired), Dialed::Socket(answer("resp_new", "used the result"))]);
    let http = Arc::new(Http::default());
    let adapter = adapter(true, http.clone(), dial.clone());
    drain(&adapter, request(vec![say(Role::User, "read then answer")])).await.unwrap();
    let mut assistant = say(Role::Assistant, "");
    assistant.tool_calls.push(mixdog_core_api::domain::provider::ToolCall {
        id: "call_1".into(), name: "read".into(), arguments: serde_json::json!({}), native_type: None,
    });
    let mut result = say(Role::Tool, "already executed");
    result.tool_call_id = Some("call_1".into());
    let history = request(vec![say(Role::User, "read then answer"), assistant, result]);
    drain(&adapter, history).await.expect("continue the same request, not a model fallback");
    assert_eq!(*dial.dials.lock().unwrap(), 2);
    assert!(http.seen.lock().unwrap().is_empty());
    let sent = frames(&dial);
    assert_eq!(sent.len(), 3);
    assert_eq!(sent[1]["previous_response_id"], "resp_tools", "the retired connection held the chain");
    assert_eq!(sent[2].get("previous_response_id"), None);
    let input = sent[2]["input"].as_array().unwrap();
    assert_eq!(input.len(), 3);
    assert_eq!(input[0]["content"][0]["text"], "read then answer");
    assert_eq!(input[1]["type"], "function_call");
    assert_eq!(input[1]["call_id"], "call_1");
    assert_eq!(input[1]["name"], "read");
    assert_eq!(input[1]["arguments"], "{}");
    assert_eq!(input[2]["type"], "function_call_output");
    assert_eq!(input[2]["call_id"], "call_1");
    assert_eq!(input[2]["output"], "already executed", "the completed tool result is replayed, not executed again");
    assert_eq!(sent[2]["model"], sent[1]["model"]);
}

#[tokio::test(start_paused = true)]
async fn connection_limit_in_a_fork_does_not_replace_the_leads_connection() {
    let mut lead_frames = answer("resp_lead", "first");
    lead_frames.extend(answer("resp_lead_next", "second"));
    let dial = Dial::with(vec![
        Dialed::Socket(lead_frames),
        Dialed::Socket(vec![connection_limit()]),
        Dialed::Socket(answer("resp_fork", "summary")),
    ]);
    let adapter = adapter(true, Arc::default(), dial.clone());
    drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap();
    let mut fork = (*request(vec![say(Role::User, "summarize")])).clone();
    fork.options.transport_scope = Some("session-1#compact:fork".into());
    drain(&adapter, Arc::new(fork)).await.unwrap();
    adapter.release_transport_scope("session-1#compact:fork");
    drain(&adapter, request(vec![say(Role::User, "hi"), say(Role::Assistant, "first"), say(Role::User, "more")])).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 3);
    let sent = frames(&dial);
    assert_same_request(&sent[1], &sent[2]);
    assert_eq!(sent[3]["previous_response_id"], "resp_lead", "the lead still owns its original chain");
}

#[tokio::test(start_paused = true)]
async fn websocket_retries_keep_turn_metadata_and_restamp_each_frame() {
    let dial = Dial::with(vec![
        Dialed::Reset,
        Dialed::Socket(vec![connection_limit()]),
        Dialed::Socket(vec![Err(TransportFault::Reset)]),
        Dialed::Rejected(404),
    ]);
    let http = Arc::new(Http::default());
    let adapter = adapter(true, http.clone(), dial.clone());
    drain(&adapter, request(vec![say(Role::User, "continue")])).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 4);
    let sent = frames(&dial);
    assert_eq!(sent.len(), 2);
    assert_same_request(&sent[0], &sent[1]);
    for frame in &sent {
        let turn: Value = serde_json::from_str(frame["client_metadata"]["x-codex-turn-metadata"].as_str().unwrap()).unwrap();
        assert_eq!(turn["turn_started_at_unix_ms"], 1_789_999_000_000u64, "the turn's start, not the encode/attempt clock");
    }
    let handshakes = dial.headers.lock().unwrap();
    for headers in handshakes.iter() {
        for name in ["session-id", "thread-id", "x-client-request-id", "x-codex-window-id", "x-codex-turn-metadata", "x-codex-routing-hint"] {
            assert_eq!(headers[name], handshakes[0][name], "handshake retries reuse {name}");
        }
        let turn: Value = serde_json::from_str(headers["x-codex-turn-metadata"].to_str().unwrap()).unwrap();
        assert!(turn.get("turn_started_at_unix_ms").is_none());
        assert!(!headers.contains_key("x-codex-ws-stream-request-start-ms"));
    }
    let posts = http.seen.lock().unwrap();
    assert_eq!(posts.len(), 1);
    let body: Value = serde_json::from_slice(&posts[0].body).unwrap();
    assert_eq!(body["model"], sent[0]["model"]);
    assert_eq!(body["input"], sent[0]["input"]);
    assert!(body.get("client_metadata").is_none(), "HTTP does not carry the WS identity block");
    assert!(posts[0].headers.iter().all(|(name, _)| !matches!(name.as_str(),
        "x-codex-turn-metadata" | "x-codex-ws-stream-request-start-ms")));
}

#[tokio::test(start_paused = true)]
async fn connection_limit_after_five_handshake_failures_surfaces_the_current_retirement() {
    let mut script: Vec<_> = (0..5).map(|_| Dialed::Rejected(503)).collect();
    script.push(Dialed::Socket(vec![connection_limit()]));
    let dial = Dial::with(script);
    let http = Arc::new(Http::default());
    let provider = adapter(true, http.clone(), dial.clone());
    let error = drain(&provider, request(vec![say(Role::User, "hi")])).await.unwrap_err();
    assert_eq!(*dial.dials.lock().unwrap(), 6);
    assert!(http.seen.lock().unwrap().is_empty(), "retirement is not a transport-switch reason");
    assert_eq!(error.status, Some(400), "no stale 503 for the route fallback to admit");
    assert_eq!(error.code.as_deref(), Some("websocket_connection_limit_reached"));
    assert!(error.message.contains("connection retired"), "the retirement's message, not the remembered handshake: {}", error.message);
    assert!(error.recovery_exhausted);
    assert_eq!(error.should_retry, Some(false));
}

#[tokio::test(start_paused = true)]
async fn connection_limit_recovery_is_bounded_and_preserves_other_failures() {
    let repeated = (0..6).map(|_| Dialed::Socket(vec![connection_limit()])).collect();
    let dial = Dial::with(repeated);
    let http = Arc::new(Http::default());
    let provider = adapter(true, http.clone(), dial.clone());
    let error = drain(&provider, request(vec![say(Role::User, "hi")])).await.unwrap_err();
    assert_eq!(error.code.as_deref(), Some("websocket_connection_limit_reached"));
    assert!(error.recovery_exhausted);
    assert_eq!(error.should_retry, Some(false), "the caller must not multiply the five retries");
    assert_eq!(*dial.dials.lock().unwrap(), 6);
    assert!(http.seen.lock().unwrap().is_empty());

    let quota = Ok(Message::text(r#"{"type":"error","status":429,"error":{"code":"usage_limit_reached"}}"#));
    let dial = Dial::with(vec![Dialed::Socket(vec![connection_limit()]), Dialed::Socket(vec![quota])]);
    let adapter = adapter(true, Arc::default(), dial.clone());
    let error = drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap_err();
    assert_eq!(error.code.as_deref(), Some("usage_limit_reached"), "the replacement's real failure must not be hidden by the retirement");
    assert_eq!(*dial.dials.lock().unwrap(), 2);
}

#[tokio::test(start_paused = true)]
async fn connection_limit_does_not_replay_exposed_output_or_match_message_text() {
    for prefix in [
        vec![r#"{"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","delta":"visible"}"#],
        vec![r#"{"type":"response.reasoning_summary_text.delta","delta":"thinking"}"#],
        vec![r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":""}}"#],
    ] {
        let mut events: Vec<_> = prefix.into_iter().map(|event| Ok(Message::text(event))).collect();
        events.push(connection_limit());
        let dial = Dial::with(vec![Dialed::Socket(events)]);
        let adapter = adapter(true, Arc::default(), dial.clone());
        let error = drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap_err();
        assert_eq!(error.code.as_deref(), Some("websocket_connection_limit_reached"));
        assert_eq!(*dial.dials.lock().unwrap(), 1, "Node's replay safety gate still applies");
    }
    let not_a_limit = Ok(Message::text(r#"{"type":"error","status":400,"error":{"code":"invalid_request_error","message":"websocket_connection_limit_reached"}}"#));
    let dial = Dial::with(vec![Dialed::Socket(vec![not_a_limit])]);
    let adapter = adapter(true, Arc::default(), dial.clone());
    let error = drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap_err();
    assert_eq!(error.code.as_deref(), Some("invalid_request_error"));
    assert_eq!(*dial.dials.lock().unwrap(), 1);
}

#[tokio::test]
async fn the_next_request_continues_on_the_same_socket_with_only_its_tail() {
    let mut script = answer("resp_1", "first");
    script.extend(answer("resp_2", "second"));
    let dial = Dial::with(vec![Dialed::Socket(script)]);
    let adapter = adapter(true, Arc::default(), dial.clone());
    drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap();
    let history = vec![say(Role::User, "hi"), say(Role::Assistant, "first"), say(Role::User, "more")];
    drain(&adapter, request(history)).await.unwrap();

    assert_eq!(*dial.dials.lock().unwrap(), 1, "one socket carries both");
    let sent = frames(&dial);
    assert_eq!(sent[0].get("previous_response_id"), None, "the first frame is full");
    assert_eq!(sent[1]["previous_response_id"], "resp_1");
    let tail = sent[1]["input"].as_array().unwrap();
    assert_eq!(tail.len(), 1, "only the new message: {tail:?}");
    assert_eq!(tail[0]["content"][0]["text"], "more");
    for frame in &sent {
        assert!(frame["client_metadata"]["session_id"].is_string(), "every frame carries the identity block");
    }
}

#[tokio::test]
async fn full_frames_only_when_the_mode_pins_them() {
    let mut script = answer("resp_1", "first");
    script.extend(answer("resp_2", "second"));
    let dial = Dial::with(vec![Dialed::Socket(script)]);
    let adapter = adapter(true, Arc::default(), dial.clone()).with_mode(TransportMode::WsFull);
    drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap();
    let history = vec![say(Role::User, "hi"), say(Role::Assistant, "first"), say(Role::User, "more")];
    drain(&adapter, request(history)).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 1, "the socket is still reused");
    assert_eq!(frames(&dial)[1].get("previous_response_id"), None);
}

#[tokio::test]
async fn a_failed_exchange_leaves_the_retry_a_fresh_socket_and_a_full_frame() {
    let mut first = answer("resp_1", "first");
    let mut cut = answer("resp_2", "second");
    cut.truncate(3);
    first.extend(cut);
    let dial = Dial::with(vec![Dialed::Socket(first), Dialed::Socket(answer("resp_3", "third"))]);
    let adapter = adapter(true, Arc::default(), dial.clone());
    drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap();
    let history = vec![say(Role::User, "hi"), say(Role::Assistant, "first"), say(Role::User, "more")];
    // The parked socket carries the delta and its response is cut: it is gone.
    assert!(drain(&adapter, request(history.clone())).await.is_err());
    // The retry opens a new socket and starts the chain over with a full frame.
    drain(&adapter, request(history)).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 2);
    let sent = frames(&dial);
    assert_eq!(sent[1]["previous_response_id"], "resp_1");
    assert_eq!(sent[2].get("previous_response_id"), None);
    assert_eq!(sent[2]["input"].as_array().unwrap().len(), 3);
}
// A socket goes back to the pool only through `Checkout::finish`, which `ResponsesStream::park` calls once the decoder
// has seen the terminal event. A response the consumer drops half way drops its `Checkout` with the socket still in it
// (`pool.rs` `Drop for Checkout`): the socket closes and the key is marked fresh, so the next request dials and sends
// a full frame, and no deflate context or half-read message is ever carried to it.
#[tokio::test]
async fn a_response_abandoned_mid_stream_never_returns_its_socket_to_the_pool() {
    let dial = Dial::with(vec![Dialed::Socket(answer("resp_1", "first")), Dialed::Socket(answer("resp_2", "second"))]);
    let adapter = adapter(true, Arc::default(), dial.clone());
    let mut stream = adapter.attempt(request(vec![say(Role::User, "hi")])).await.unwrap();
    stream.next().await.expect("an event").expect("not an error");
    drop(stream);
    let history = vec![say(Role::User, "hi"), say(Role::Assistant, "first"), say(Role::User, "more")];
    drain(&adapter, request(history)).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 2, "the next request dialled its own socket");
    assert_eq!(frames(&dial)[1].get("previous_response_id"), None, "and carried no anchor of the abandoned one");
}

#[tokio::test]
async fn a_refused_upgrade_moves_an_oauth_session_to_http_for_good()
 {
    let http = Arc::new(Http::default());
    let dial = Dial::with(vec![Dialed::Rejected(404)]);
    let adapter = adapter(true, http.clone(), dial.clone());
    drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap();
    drain(&adapter, request(vec![say(Role::User, "again")])).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 1, "the second request never dials");
    assert_eq!(http.seen.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_refused_upgrade_of_the_api_key_route_falls_back_for_that_request_only() {
    let http = Arc::new(Http::default());
    let dial = Dial::with(vec![Dialed::Rejected(403), Dialed::Socket(answer("resp_1", "ws again"))]);
    let adapter = adapter(false, http.clone(), dial.clone());
    drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap();
    drain(&adapter, request(vec![say(Role::User, "again")])).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 2, "the next request tries the socket again");
    assert_eq!(http.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn the_pinned_modes_do_not_fall_back() {
    let http = Arc::new(Http::default());
    let dial = Dial::with(vec![Dialed::Rejected(404)]);
    let adapter = adapter(true, http.clone(), dial.clone()).with_mode(TransportMode::WsDelta);
    let err = drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap_err();
    assert_eq!(err.status, Some(404));
    assert!(http.seen.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_spent_websocket_send_budget_switches_to_http_inside_the_send() {
    let http = Arc::new(Http::default());
    let mut script = Vec::new();
    for _ in 0..6 {
        script.push(Dialed::Socket(vec![Err(TransportFault::Reset)]));
    }
    let dial = Dial::with(script);
    let adapter = adapter(true, http.clone(), dial.clone());
    drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 6);
    assert_eq!(http.seen.lock().unwrap().len(), 1);
    // The session stays on HTTP/SSE.
    drain(&adapter, request(vec![say(Role::User, "again")])).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 6);
}

#[tokio::test]
async fn a_server_close_1009_keeps_the_session_on_http() {
    let http = Arc::new(Http::default());
    let dial = Dial::with(vec![Dialed::Socket(vec![Err(TransportFault::WsClose { code: Some(1009) })])]);
    let adapter = adapter(false, http.clone(), dial.clone());
    drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap();
    drain(&adapter, request(vec![say(Role::User, "again")])).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 1);
    assert_eq!(http.seen.lock().unwrap().len(), 2);
}

/// Node's acquires of one socket (`fixtures/provider-ws-connect`, recorded by `record-ws-connect.mjs`): which dials
/// began and when, and how the acquire ended, replayed through the adapter's real send path with only the dial scripted.
const WS_CONNECT: [(&str, mixdog_testkit::Fixture); 7] = [
    ("all-stuck", mixdog_testkit::fixture_const!("../../fixtures/provider-ws-connect/all-stuck.json")),
    ("all-stuck-oauth", mixdog_testkit::fixture_const!("../../fixtures/provider-ws-connect/all-stuck-oauth.json")),
    ("lone-leg-reset", mixdog_testkit::fixture_const!("../../fixtures/provider-ws-connect/lone-leg-reset.json")),
    ("reset-beside-a-stuck-leg", mixdog_testkit::fixture_const!("../../fixtures/provider-ws-connect/reset-beside-a-stuck-leg.json")),
    ("status-ends-the-race", mixdog_testkit::fixture_const!("../../fixtures/provider-ws-connect/status-ends-the-race.json")),
    ("stuck-then-open", mixdog_testkit::fixture_const!("../../fixtures/provider-ws-connect/stuck-then-open.json")),
    ("stuck-twice-then-open", mixdog_testkit::fixture_const!("../../fixtures/provider-ws-connect/stuck-twice-then-open.json")),
];

#[tokio::test(start_paused = true)]
async fn a_stuck_upgrade_is_hedged_and_an_acquire_ends_as_nodes_does() {
    for (id, text) in &WS_CONNECT {
        let node: Value = serde_json::from_str(text).unwrap();
        let mut script: Vec<Dialed> = node["script"]
            .as_array()
            .unwrap()
            .iter()
            .map(|action| match action.as_str().unwrap() {
                "stuck" => Dialed::Stuck,
                "reset" => Dialed::Reset,
                "open" => Dialed::Socket(answer("resp_1", "opened")),
                other => Dialed::Rejected(other.strip_prefix("status ").unwrap().parse().unwrap()),
            })
            .collect();
        // The recorded server leaves every connection it was not told about stuck.
        script.extend((script.len()..8).map(|_| Dialed::Stuck));
        let dial = Dial::with(script);
        let adapter = Arc::new(adapter(node["auth"] == "openai-oauth", Arc::default(), dial.clone()).with_mode(TransportMode::WsDelta));
        let events = node["events"].as_array().unwrap();
        let want = &node["outcome"];
        let ends_at = want["t"].as_u64().unwrap();
        // The acquire runs as a task of its own; its completion is read as an event (its future resolving). The clock moves
        // only by explicit advances, to the instants of Node's events in the order recorded (every event up to the end of
        // the acquire is walked: a dial began, a scripted upgrade answered) and to the end of the acquire; at each dial
        // event the dial Node made there is awaited as an event too.
        let (done_tx, mut done_rx) = tokio::sync::oneshot::channel();
        tokio::spawn({
            let adapter = adapter.clone();
            async move {
                let outcome = adapter.ws_attempt_once(request(vec![say(Role::User, "hi")])).await.map(|_| ());
                let _ = done_tx.send(outcome);
            }
        });
        let mut began = dial.began.subscribe();
        let mut now = 0;
        let mut want_dials = 0;
        for event in events {
            let at = event["t"].as_u64().unwrap();
            // What the recording holds after the acquire ended (the server seeing the connections close) is not the acquire's.
            if at > ends_at {
                break;
            }
            tokio::time::advance(std::time::Duration::from_millis(at - now)).await;
            now = at;
            if event["on"] == "dial" {
                want_dials += 1;
                assert_eq!(event["conn"].as_u64().unwrap(), u64::from(want_dials), "{id}: the dials are numbered in order");
            }
            // A lost wake-up shows as this wait running out its deadline (on the virtual clock) before the dial began.
            tokio::time::timeout(std::time::Duration::from_millis(1), began.wait_for(|n| *n >= want_dials))
                .await
                .unwrap_or_else(|_| panic!("{id}: the dial Node began by {at} ms never began"))
                .unwrap();
            assert_eq!(*dial.dials.lock().unwrap(), want_dials, "{id}: the dials begun by {at} ms");
            if at < ends_at {
                assert!(
                    matches!(done_rx.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)),
                    "{id}: the acquire had already completed at {at} ms, before Node's {ends_at} ms"
                );
            }
        }
        tokio::time::advance(std::time::Duration::from_millis(ends_at - now)).await;
        let outcome = tokio::time::timeout(std::time::Duration::from_millis(1), done_rx)
            .await
            .unwrap_or_else(|_| panic!("{id}: the acquire had not completed by its recorded end, {ends_at} ms: a stuck upgrade is never replaced"))
            .unwrap();
        assert_eq!(*dial.dials.lock().unwrap(), want_dials, "{id}: every dial of the acquire");
        match (outcome, want["ok"].as_bool().unwrap()) {
            (Ok(_), true) => {}
            (Err(error), false) => {
                if want["code"] == "EWSACQUIRETIMEOUT" {
                    assert_eq!(error.code.as_deref(), Some("EWSACQUIRETIMEOUT"), "{id}: the error's code");
                    assert_eq!(error.message, want["message"].as_str().unwrap(), "{id}: the acquire timeout's text");
                } else if want["code"] == "ECONNRESET" {
                    assert_eq!(error.code.as_deref(), Some("ECONNRESET"), "{id}: the reset's code");
                    assert_eq!(error.message, want["message"].as_str().unwrap(), "{id}: the reset's text");
                    assert_eq!(error.transport, Some(TransportFault::Reset), "{id}: a reset is a transport fault");
                } else {
                    assert_eq!(error.code, None, "{id}: only the acquire timeout and a reset carry a code");
                }
                assert_eq!(error.status.map(u64::from), want["httpStatus"].as_u64(), "{id}: the status of an answered upgrade");
            }
            (Ok(_), false) => panic!("{id}: Node failed with {want}, Rust opened"),
            (Err(error), true) => panic!("{id}: Node opened, Rust failed: {error:?}"),
        }
    }
}

#[allow(dead_code)]
fn unused(_: StreamEvent) {}

