//! The pooled WebSocket: delta frames on a reused socket, a fresh socket after
//! a failure, and the move to HTTP/SSE, over scripted seams.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

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
use mixdog_ai::providers::openai::config::ModelFacts;
use mixdog_ai::providers::openai::config::ModelFactsSource;
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
    async fn send(&self, request: WireRequest, _exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
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
    /// After its frames the server stays silent (the link neither ends nor delivers) instead of ending.
    silent: bool,
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
        match self.frames.pop_front() {
            None if self.silent => std::future::pending().await,
            frame => frame,
        }
    }
    fn link(&self) -> Arc<dyn TransportKeepalive> {
        Arc::new(Alive)
    }
}

enum Dialed {
    Socket(Vec<Result<Message, TransportFault>>),
    /// The upgrade completes, the server sends these frames and then nothing, for ever.
    Silent(Vec<Result<Message, TransportFault>>),
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
    waits: Mutex<Vec<(u32, Duration)>>,
    now: AtomicU64,
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
            waits: Mutex::default(),
            now: AtomicU64::new(1_790_000_000_000),
            began: tokio::sync::watch::channel(0).0,
        })
    }
}

#[async_trait]
impl mixdog_ai::oauth::Pace for Dial {
    fn now_ms(&self) -> u64 {
        self.now.load(Ordering::Relaxed)
    }

    async fn wait(&self, duration: Duration) {
        self.waits.lock().unwrap().push((*self.dials.lock().unwrap(), duration));
        self.now.fetch_add(duration.as_millis() as u64, Ordering::Relaxed);
        mixdog_rt::time::sleep(duration).await;
    }

    fn draw(&self) -> f64 {
        0.5
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
            Dialed::Socket(frames) => {
                Ok((Box::new(Socket { sent: self.sent.clone(), frames: frames.into(), silent: false }), Response::builder().status(101).body(None).unwrap()))
            }
            Dialed::Silent(frames) => {
                Ok((Box::new(Socket { sent: self.sent.clone(), frames: frames.into(), silent: true }), Response::builder().status(101).body(None).unwrap()))
            }
            Dialed::Rejected(status) => Err(ConnectError::Rejected(Response::builder().status(status).body(Some(b"{}".to_vec())).unwrap())),
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
    adapter_with(codex, http, dial, Arc::new(NoFacts))
}

fn adapter_with(codex: bool, http: Arc<Http>, dial: Arc<Dial>, facts: Arc<dyn ModelFactsSource>) -> OpenAiAdapter {
    // Node's recorder advances the clock by each backoff, not by each clock read.
    let clock = dial.clone();
    let context = Arc::new(SessionContext::with_sources(move || clock.now.load(Ordering::Relaxed), || "request-id".into()).with_retry_pace(dial.clone()));
    let config = if codex {
        let identity = CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "1".into(), beta_features: "b".into() };
        OpenAiConfig::codex(false, identity, facts, context.clone())
    } else {
        OpenAiConfig::api_key(false, facts, context.clone())
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
            thread: Some(RequestThread { id: "thread".into(), window: 0, turn: Some("turn".into()), turn_started_at_ms: Some(1_789_999_000_000) }),
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
        assert!(
            after.as_str().unwrap().parse::<u64>().unwrap() > before.as_str().unwrap().parse::<u64>().unwrap(),
            "Node re-stamps the stream start on each attempt"
        );
    }
    assert_eq!(first, retry, "same model, request and logical turn identity");
}

fn connection_limit() -> Result<Message, TransportFault> {
    Ok(Message::text(
        r#"{"type":"error","status":400,"error":{"code":"websocket_connection_limit_reached","type":"invalid_request_error","message":"connection retired"}}"#,
    ))
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
    ]
    .into_iter()
    .map(|event| Ok(Message::text(event.to_string())))
    .collect();
    retired.push(connection_limit());
    let dial = Dial::with(vec![Dialed::Socket(retired), Dialed::Socket(answer("resp_new", "used the result"))]);
    let http = Arc::new(Http::default());
    let adapter = adapter(true, http.clone(), dial.clone());
    drain(&adapter, request(vec![say(Role::User, "read then answer")])).await.unwrap();
    let mut assistant = say(Role::Assistant, "");
    assistant.tool_calls.push(mixdog_core_api::domain::provider::ToolCall {
        id: "call_1".into(),
        name: "read".into(),
        arguments: serde_json::json!({}),
        native_type: None,
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
    let dial = Dial::with(vec![Dialed::Socket(lead_frames), Dialed::Socket(vec![connection_limit()]), Dialed::Socket(answer("resp_fork", "summary"))]);
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
    let dial =
        Dial::with(vec![Dialed::Reset, Dialed::Socket(vec![connection_limit()]), Dialed::Socket(vec![Err(TransportFault::Reset)]), Dialed::Rejected(404)]);
    let http = Arc::new(Http::default());
    let adapter = adapter(true, http.clone(), dial.clone());
    drain(&adapter, request(vec![say(Role::User, "continue")])).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 4);
    assert_eq!(
        *dial.waits.lock().unwrap(),
        vec![(1, Duration::from_millis(200)), (2, Duration::from_millis(400)), (3, Duration::from_millis(800)),],
        "handshake, retirement and stream loss share one backoff schedule; 404 switches immediately"
    );
    let sent = frames(&dial);
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0]["client_metadata"]["x-codex-ws-stream-request-start-ms"], "1790000000200");
    assert_eq!(sent[1]["client_metadata"]["x-codex-ws-stream-request-start-ms"], "1790000000600");
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
    assert!(posts[0].headers.iter().all(|(name, _)| !matches!(name.as_str(), "x-codex-turn-metadata" | "x-codex-ws-stream-request-start-ms")));
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
    assert_eq!(
        *dial.waits.lock().unwrap(),
        vec![
            (1, Duration::from_millis(200)),
            (2, Duration::from_millis(400)),
            (3, Duration::from_millis(800)),
            (4, Duration::from_millis(1600)),
            (5, Duration::from_millis(3200)),
        ],
        "one wait before each fresh acquire and none after exhaustion"
    );
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
        vec![
            r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":""}}"#,
        ],
    ] {
        let mut events: Vec<_> = prefix.into_iter().map(|event| Ok(Message::text(event))).collect();
        events.push(connection_limit());
        let dial = Dial::with(vec![Dialed::Socket(events)]);
        let adapter = adapter(true, Arc::default(), dial.clone());
        let error = drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap_err();
        assert_eq!(error.code.as_deref(), Some("websocket_connection_limit_reached"));
        assert_eq!(*dial.dials.lock().unwrap(), 1, "Node's replay safety gate still applies");
    }
    let not_a_limit =
        Ok(Message::text(r#"{"type":"error","status":400,"error":{"code":"invalid_request_error","message":"websocket_connection_limit_reached"}}"#));
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
async fn a_refused_upgrade_moves_an_oauth_session_to_http_for_good() {
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

// The unknown-model refresh over the whole stream outcome (`openai-oauth.mjs:317-326`)

/// A roster that counts its refreshes and offers `access_programs` once it has been read again: a request encoded from
/// the refreshed roster differs from one encoded before it.
#[derive(Default)]
struct Roster {
    refreshed: std::sync::atomic::AtomicU32,
}

impl Roster {
    fn refreshes(&self) -> u32 {
        self.refreshed.load(Ordering::SeqCst)
    }
}

impl ModelFactsSource for Roster {
    fn facts(&self, _model: &str) -> ModelFacts {
        ModelFacts { access_programs: (self.refreshes() > 0).then(|| serde_json::json!(["cyber-fresh"])), ..ModelFacts::default() }
    }

    fn refresh<'a>(&'a self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            self.refreshed.fetch_add(1, Ordering::SeqCst);
        })
    }
}

fn text_frame(frame: &str) -> Result<Message, TransportFault> {
    Ok(Message::text(frame))
}

const CREATED: &str = r#"{"type":"response.created","response":{"id":"resp_gone","model":"m"}}"#;
const RETIRED: &str =
    r#"{"type":"response.failed","response":{"id":"resp_gone","status":"failed","error":{"code":"model_not_found","message":"Model not found: gpt-fixture"}}}"#;

/// A socket that opens, accepts the response and then reports the model retired, after `output` frames.
fn retired_after(output: &[&str]) -> Dialed {
    let mut frames = vec![text_frame(CREATED)];
    frames.extend(output.iter().map(|f| text_frame(f)));
    frames.push(text_frame(RETIRED));
    Dialed::Socket(frames)
}

async fn answer_text(adapter: &OpenAiAdapter) -> Result<String, ProviderError> {
    let mut stream = adapter.attempt(request(vec![say(Role::User, "hi")])).await?;
    let mut text = String::new();
    while let Some(event) = stream.next().await {
        if let StreamEvent::TextDelta(delta) = event? {
            text.push_str(&delta);
        }
    }
    Ok(text)
}

#[tokio::test]
async fn a_model_not_found_inside_an_opened_stream_refreshes_the_roster_and_resends_once() {
    let roster = Arc::new(Roster::default());
    let http = Arc::new(Http::default());
    let dial = Dial::with(vec![retired_after(&[]), Dialed::Socket(answer("resp_ok", "fresh"))]);
    let adapter = adapter_with(true, http.clone(), dial.clone(), roster.clone());
    assert_eq!(answer_text(&adapter).await.unwrap(), "fresh");
    assert_eq!(roster.refreshes(), 1, "the roster was read again once");
    assert_eq!(*dial.dials.lock().unwrap(), 2, "one resend, on a socket of its own");
    assert!(http.seen.lock().unwrap().is_empty(), "no transport fallback");
    let sent = frames(&dial);
    assert_eq!(sent.len(), 2);
    assert!(sent[0].get("access_programs").is_none(), "the first request came from the old roster");
    assert_eq!(sent[1]["access_programs"], serde_json::json!(["cyber-fresh"]), "the resend is encoded anew from the refreshed roster");
}

/// `request` with `identity` as the send's identity, so its boundaries can be read.
fn observed(identity: &mixdog_core_api::domain::provider::SendIdentity) -> Arc<ModelRequest> {
    let mut built = (*request(vec![say(Role::User, "hi")])).clone();
    built.options.send_identity = identity.clone();
    Arc::new(built)
}

/// The attempts the send's boundaries name, in order of starting, and a lookup of what each saw.
fn attempts(identity: &mixdog_core_api::domain::provider::SendIdentity) -> (Vec<u64>, impl Fn(u64, mixdog_core_api::domain::provider::Boundary) -> bool) {
    use mixdog_core_api::domain::provider::Boundary;
    let log = identity.take_boundaries();
    let started = log.iter().filter(|(_, b)| *b == Boundary::AttemptStarted).map(|(id, ..)| *id).collect();
    (started, move |id, boundary| log.iter().any(|(i, b)| *i == id && *b == boundary))
}

/// A socket that takes the request and then says nothing is bounded per operation: each operation's first-payload window
/// counts from its own start (the earlier stall does not use it up), and the stall is the stream's (`ESTREAMSTALL`).
#[tokio::test(start_paused = true)]
async fn a_websocket_operation_is_bounded_per_operation() {
    let identity = mixdog_core_api::domain::provider::SendIdentity::default();
    let dial = Dial::with(vec![Dialed::Silent(vec![]), Dialed::Silent(vec![])]);
    let adapter = adapter(false, Arc::default(), dial);
    let mut windows = Vec::new();
    for _ in 0..2 {
        let began = tokio::time::Instant::now();
        let mut stream = adapter.ws_attempt_once(observed(&identity)).await.unwrap();
        let error = stream.next().await.unwrap().unwrap_err();
        assert_eq!(error.code.as_deref(), Some("ESTREAMSTALL"));
        assert!(error.timed_out);
        let ms = began.elapsed().as_millis();
        assert_eq!(error.message, format!("Responses WS stream timed out after {ms}ms of inactivity"), "expires at the window it names");
        windows.push(ms);
    }
    assert_eq!(windows[0], windows[1], "the second operation got a whole window of its own");
    let (started, seen) = attempts(&identity);
    assert_eq!(started.len(), 2);
    for id in &started {
        assert!(seen(*id, mixdog_core_api::domain::provider::Boundary::HeadReceived), "the socket took each request");
        assert!(!seen(*id, mixdog_core_api::domain::provider::Boundary::FirstProtocolPayload), "and answered nothing");
    }
}

/// The first-output window of a socket runs from the first payload: `response.created` and then silence expires a whole
/// first-output window after the payload, however long the payload took to come.
#[tokio::test(start_paused = true)]
async fn payload_then_silence_on_a_socket_expires_at_the_first_output_window() {
    let identity = mixdog_core_api::domain::provider::SendIdentity::default();
    let created = vec![Ok(Message::text(r#"{"type":"response.created","response":{"id":"resp_1","model":"m"}}"#))];
    let adapter = adapter(false, Arc::default(), Dial::with(vec![Dialed::Silent(created)]));
    let mut stream = adapter.ws_attempt_once(observed(&identity)).await.unwrap();
    let began = tokio::time::Instant::now();
    let error = loop {
        match stream.next().await.expect("the window ends the stream") {
            Ok(_) => continue,
            Err(error) => break error,
        }
    };
    let ms = began.elapsed().as_millis();
    assert_eq!(error.code.as_deref(), Some("ESTREAMSTALL"));
    assert_eq!(error.message, format!("Responses WS stream timed out after {ms}ms of inactivity"));
    assert!(ms > 300_000, "the first-output window, not the payload one or the idle one, ran from the payload");
}

/// Every exchange the adapter issues itself is an attempt of its own: the WebSocket-to-HTTP fallback is a new exchange with
/// a fresh clock, and the refused upgrade never reached a head.
#[tokio::test]
async fn a_fallback_exchange_is_an_attempt_of_its_own() {
    use mixdog_core_api::domain::provider::Boundary;

    let identity = mixdog_core_api::domain::provider::SendIdentity::default();
    let http = Arc::new(Http::default());
    let dial = Dial::with(vec![Dialed::Rejected(404)]);
    let adapter = adapter(true, http.clone(), dial);
    let mut stream = adapter.attempt(observed(&identity)).await.unwrap();
    while let Some(event) = stream.next().await {
        event.unwrap();
    }
    assert_eq!(http.seen.lock().unwrap().len(), 1);
    let (started, seen) = attempts(&identity);
    assert_eq!(started.len(), 2, "the socket attempt and the HTTP fallback");
    assert_ne!(started[0], started[1]);
    assert!(!seen(started[0], Boundary::HeadReceived), "the refused upgrade has no head");
    assert!(seen(started[1], Boundary::HeadReceived));
    assert!(seen(started[1], Boundary::FirstProtocolPayload), "the fallback's payload is its own");
    assert!(!seen(started[0], Boundary::FirstProtocolPayload));
}

/// The in-stream roster-refresh resume is an exchange of its own: the resend gets a fresh clock, and what the refused
/// stream saw stays with it.
#[tokio::test]
async fn the_refresh_resume_is_an_attempt_of_its_own() {
    use mixdog_core_api::domain::provider::Boundary;

    let identity = mixdog_core_api::domain::provider::SendIdentity::default();
    let dial = Dial::with(vec![retired_after(&[]), Dialed::Socket(answer("resp_ok", "fresh"))]);
    let adapter = adapter_with(true, Arc::new(Http::default()), dial, Arc::new(Roster::default()));
    let mut stream = adapter.attempt(observed(&identity)).await.unwrap();
    while let Some(event) = stream.next().await {
        event.unwrap();
    }
    let (started, seen) = attempts(&identity);
    assert_eq!(started.len(), 2, "the refused stream and the resend");
    assert_ne!(started[0], started[1]);
    for id in &started {
        assert!(seen(*id, Boundary::HeadReceived), "each socket took its request");
        assert!(seen(*id, Boundary::FirstProtocolPayload), "each stream's first payload");
    }
    assert!(seen(started[1], Boundary::FirstSemanticOutput) && !seen(started[0], Boundary::FirstSemanticOutput));
}

#[tokio::test]
async fn a_second_unknown_model_refusal_surfaces() {
    let roster = Arc::new(Roster::default());
    let dial = Dial::with(vec![retired_after(&[]), retired_after(&[])]);
    let adapter = adapter_with(true, Arc::new(Http::default()), dial.clone(), roster.clone());
    let error = answer_text(&adapter).await.unwrap_err();
    assert_eq!(error.message, "Model not found: gpt-fixture");
    assert_eq!(roster.refreshes(), 1, "one refresh per send");
    assert_eq!(*dial.dials.lock().unwrap(), 2);
}

/// One refresh over both paths: a refusal before the stream opens (an `error` frame first) spends it, so the refusal
/// inside the resent stream surfaces.
#[tokio::test]
async fn the_refresh_is_shared_by_the_refusal_before_the_stream_and_the_one_inside_it() {
    let roster = Arc::new(Roster::default());
    let before_open =
        Dialed::Socket(vec![text_frame(r#"{"type":"error","status":404,"error":{"code":"model_not_found","message":"Model not found: gpt-fixture"}}"#)]);
    let dial = Dial::with(vec![before_open, retired_after(&[])]);
    let adapter = adapter_with(true, Arc::new(Http::default()), dial.clone(), roster.clone());
    let error = answer_text(&adapter).await.unwrap_err();
    assert_eq!(error.message, "Model not found: gpt-fixture");
    assert_eq!(roster.refreshes(), 1);
    assert_eq!(*dial.dials.lock().unwrap(), 2);
}

#[tokio::test]
async fn exposed_output_blocks_the_unknown_model_recovery() {
    let text = [
        r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}"#,
        r#"{"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","delta":"partial"}"#,
    ];
    let reasoning = [
        r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}"#,
        r#"{"type":"response.reasoning_summary_text.delta","item_id":"rs_1","delta":"thinking"}"#,
    ];
    let tool = [
        r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":""}}"#,
        r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\"pa"}"#,
    ];
    let done_tool = [
        r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":"{}"}}"#,
        r#"{"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"read","arguments":"{}"}}"#,
    ];
    for (what, output) in [("text", &text[..]), ("reasoning", &reasoning[..]), ("a tool call begun", &tool[..]), ("a tool call run", &done_tool[..])] {
        let roster = Arc::new(Roster::default());
        let dial = Dial::with(vec![retired_after(output), Dialed::Socket(answer("resp_ok", "fresh"))]);
        let adapter = adapter_with(true, Arc::new(Http::default()), dial.clone(), roster.clone());
        let error = answer_text(&adapter).await.unwrap_err();
        assert_eq!(error.message, "Model not found: gpt-fixture", "{what}");
        assert_eq!(roster.refreshes(), 0, "{what}: nothing is refreshed once output was shown");
        assert_eq!(*dial.dials.lock().unwrap(), 1, "{what}: nothing is resent");
    }
}

/// An upgrade the endpoint refuses with 404 is the route not doing WebSocket: the HTTP fallback answers it (or, pinned
/// to the socket, the refusal surfaces); it is not a retired model and refreshes nothing.
#[tokio::test]
async fn a_handshake_404_is_not_taken_for_a_retired_model() {
    let roster = Arc::new(Roster::default());
    let http = Arc::new(Http::default());
    let dial = Dial::with(vec![Dialed::Rejected(404)]);
    let adapter = adapter_with(true, http.clone(), dial.clone(), roster.clone());
    drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap();
    assert_eq!(roster.refreshes(), 0);
    assert_eq!(*dial.dials.lock().unwrap(), 1);
    assert_eq!(http.seen.lock().unwrap().len(), 1);

    let roster = Arc::new(Roster::default());
    let dial = Dial::with(vec![Dialed::Rejected(404)]);
    let pinned = adapter_with(true, Arc::new(Http::default()), dial.clone(), roster.clone()).with_mode(TransportMode::WsDelta);
    let error = answer_text(&pinned).await.unwrap_err();
    assert_eq!(error.status, Some(404));
    assert_eq!(roster.refreshes(), 0);
    assert_eq!(*dial.dials.lock().unwrap(), 1, "no second dial for a refresh");
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

#[allow(dead_code)]
fn unused(_: StreamEvent) {}

/// One acquire of a socket against the scripted dials, on the paused clock: what it ended in, when, and how many dials it made. A
/// dial the script does not name never answers its upgrade.
async fn acquire(mut script: Vec<Dialed>) -> (Result<(), ProviderError>, std::time::Duration, u32) {
    script.extend((script.len()..8).map(|_| Dialed::Stuck));
    let dial = Dial::with(script);
    let adapter = adapter(false, Arc::default(), dial.clone()).with_mode(TransportMode::WsDelta);
    let began = tokio::time::Instant::now();
    let outcome = adapter.ws_attempt_once(request(vec![say(Role::User, "hi")])).await.map(|_| ());
    let waited = began.elapsed();
    let dials = *dial.dials.lock().unwrap();
    (outcome, waited, dials)
}

/// A stuck upgrade is not waited out: a new dial starts every 3 s while none has opened, the first to open wins.
#[tokio::test(start_paused = true)]
async fn a_stuck_upgrade_is_hedged_by_a_second_dial_three_seconds_later() {
    let (outcome, waited, dials) = acquire(vec![Dialed::Stuck, Dialed::Socket(answer("resp_1", "opened"))]).await;
    outcome.expect("the second dial opens");
    assert_eq!((waited, dials), (std::time::Duration::from_secs(3), 2));

    let (outcome, waited, dials) = acquire(vec![Dialed::Stuck, Dialed::Stuck, Dialed::Socket(answer("resp_1", "opened"))]).await;
    outcome.expect("the third dial opens");
    assert_eq!((waited, dials), (std::time::Duration::from_secs(6), 3));
}

/// With nothing ever opening the dials start at 0, 3, 6, 9 and 12 s (a sixth would start no sooner than the deadline) and
/// the acquire ends at 15 s with its own timeout.
#[tokio::test(start_paused = true)]
async fn an_acquire_that_never_opens_ends_at_fifteen_seconds_after_five_dials() {
    let (outcome, waited, dials) = acquire(vec![]).await;
    let error = outcome.expect_err("never opens");
    assert_eq!((waited, dials), (std::time::Duration::from_secs(15), 5));
    assert_eq!(error.code.as_deref(), Some("EWSACQUIRETIMEOUT"));
    assert!(error.message.ends_with("acquire timed out before open (15000ms)"), "{}", error.message);
    assert!(error.timed_out && error.transport == Some(TransportFault::Connect { os_code: None }), "{error:?}");
}

/// A reset ends the race only when no other dial is left connecting; an HTTP answer to the upgrade ends it at once.
#[tokio::test(start_paused = true)]
async fn a_reset_beside_a_stuck_dial_does_not_end_the_acquire_but_an_answered_upgrade_does() {
    let (outcome, waited, dials) = acquire(vec![Dialed::Stuck, Dialed::Reset]).await;
    let error = outcome.expect_err("nothing opens");
    assert_eq!((waited, dials), (std::time::Duration::from_secs(15), 5), "the first dial is still stuck when the second resets");
    assert_eq!(error.code.as_deref(), Some("EWSACQUIRETIMEOUT"));

    let (outcome, waited, dials) = acquire(vec![Dialed::Reset]).await;
    let error = outcome.expect_err("the lone dial resets");
    assert_eq!((waited, dials), (std::time::Duration::ZERO, 1), "a lone reset ends the race at once");
    assert_eq!(error.transport, Some(TransportFault::Reset));

    let (outcome, waited, dials) = acquire(vec![Dialed::Stuck, Dialed::Rejected(403)]).await;
    let error = outcome.expect_err("the server refuses the upgrade");
    assert_eq!((waited, dials, error.status), (std::time::Duration::from_secs(3), 2, Some(403)));
}
