//! The OpenAI adapter over scripted HTTP and WebSocket seams.
//!
//! Not covered here: the retry after a model rejects a mid-conversation
//! effort update. A rejection can only be recorded with a live call, so it is
//! left to the K1 live smoke; the rule that decides it is unit-tested in
//! `openai_profiles.rs` (`without_effort_updates`), and the adapter's single
//! read of the request's effort projection waits for the P0-API domain type.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

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
use mixdog_ai::providers::openai::config::OpenAiConfig;
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
use mixdog_core_api::domain::provider::ErrorKind;
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
use tokio_tungstenite::tungstenite::http::Response;

// ---- scripted seams -------------------------------------------------------

struct VecBody(VecDeque<Bytes>);

#[async_trait]
impl BodyStream for VecBody {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.pop_front().map(Ok)
    }
}

type Scripted = (u16, Vec<(String, String)>, Vec<Bytes>);

#[derive(Default)]
struct ScriptedHttp {
    responses: Mutex<VecDeque<Scripted>>,
    seen: Mutex<Vec<WireRequest>>,
    /// Every HEAD warm-up with the exchange it was sent under; they are not turns, so seen leaves them out.
    warmups: Mutex<Vec<(WireRequest, mixdog_ai::transport::Exchange)>>,
    /// The warm-ups fail while this is set (a refused connection).
    warmup_fails: std::sync::atomic::AtomicBool,
}

impl ScriptedHttp {
    fn with(responses: Vec<Scripted>) -> Arc<Self> {
        Arc::new(Self { responses: Mutex::new(responses.into()), seen: Mutex::default(), warmups: Mutex::default(), warmup_fails: Default::default() })
    }
}

#[async_trait]
impl HttpSend for ScriptedHttp {
    async fn send(
        &self,
        request: WireRequest,
        exchange: mixdog_ai::transport::Exchange,
    ) -> Result<HttpResponse, ProviderError> {
        // A HEAD is the provider's connection warm-up, not a turn: answered empty, recorded apart and never scripted.
        if request.method == "HEAD" {
            self.warmups.lock().unwrap().push((request, exchange));
            if self.warmup_fails.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(ProviderError::transport(TransportFault::Closed, mixdog_core_api::domain::provider::DeliveryState::NotSent));
            }
            return Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(VecBody(VecDeque::new())) });
        }
        self.seen.lock().unwrap().push(request);
        let (status, headers, chunks) = self.responses.lock().unwrap().pop_front().expect("scripted response");
        Ok(HttpResponse { status, headers, body: Box::new(VecBody(chunks.into())) })
    }
}

struct NeverAlive;
impl TransportKeepalive for NeverAlive {
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

struct ScriptSocket {
    sent: Arc<Mutex<Vec<Message>>>,
    frames: VecDeque<Result<Message, TransportFault>>,
}

#[async_trait]
impl WsSocket for ScriptSocket {
    async fn send(&self, message: Message) -> Result<(), TransportFault> {
        self.sent.lock().unwrap().push(message);
        Ok(())
    }
    async fn recv(&mut self) -> Option<Result<Message, TransportFault>> {
        self.frames.pop_front()
    }
    fn link(&self) -> Arc<dyn TransportKeepalive> {
        Arc::new(NeverAlive)
    }
}

enum Dialed {
    Socket(Vec<Message>),
    Rejected(u16),
}

struct ScriptedDial {
    script: Mutex<VecDeque<Dialed>>,
    sent: Arc<Mutex<Vec<Message>>>,
    requests: Mutex<Vec<Vec<(String, String)>>>,
}

impl ScriptedDial {
    fn with(script: Vec<Dialed>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script.into()),
            sent: Arc::default(),
            requests: Mutex::default(),
        })
    }
}

#[async_trait]
impl WsDial for ScriptedDial {
    async fn dial(
        &self,
        request: tokio_tungstenite::tungstenite::handshake::client::Request,
    ) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError> {
        self.requests.lock().unwrap().push(
            request
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_owned(), v.to_str().unwrap().to_owned()))
                .collect(),
        );
        match self.script.lock().unwrap().pop_front().expect("scripted dial") {
            Dialed::Socket(frames) => Ok((
                Box::new(ScriptSocket {
                    sent: self.sent.clone(),
                    frames: frames.into_iter().map(Ok).collect(),
                }),
                Response::builder().status(101).body(None).unwrap(),
            )),
            Dialed::Rejected(status) => Err(ConnectError::Rejected(
                Response::builder().status(status).body(Some(b"{}".to_vec())).unwrap(),
            )),
        }
    }
}

struct Credentials {
    current: Credential,
    refreshed: Mutex<Option<Credential>>,
    asked: Mutex<u32>,
}

impl Credentials {
    fn new(current: &str, refreshed: Option<&str>) -> Arc<Self> {
        let credential = |b: &str| Credential { bearer: b.into(), account_id: Some("acct".into()) };
        Arc::new(Self {
            current: credential(current),
            refreshed: Mutex::new(refreshed.map(credential)),
            asked: Mutex::new(0),
        })
    }
}

#[async_trait]
impl CredentialSource for Credentials {
    async fn current(&self) -> Result<Credential, ProviderError> {
        Ok(self.current.clone())
    }
    async fn after_rejection(&self, _: &Credential) -> Result<Option<Credential>, ProviderError> {
        *self.asked.lock().unwrap() += 1;
        Ok(self.refreshed.lock().unwrap().take())
    }
}

struct Facts;
impl ModelFactsSource for Facts {
    fn facts(&self, _: &str) -> ModelFacts {
        ModelFacts::default()
    }
}

fn adapter(
    transport: TransportKind,
    http: Arc<ScriptedHttp>,
    dial: Arc<ScriptedDial>,
    credentials: Arc<Credentials>,
) -> OpenAiAdapter {
    adapter_in(Arc::new(SessionContext::new()), transport, http, dial, credentials)
}

fn adapter_in(
    context: Arc<SessionContext>,
    transport: TransportKind,
    http: Arc<ScriptedHttp>,
    dial: Arc<ScriptedDial>,
    credentials: Arc<Credentials>,
) -> OpenAiAdapter {
    let identity = CodexIdentity {
        installation_id: "i".into(),
        user_agent: "ua".into(),
        version: "1".into(),
        beta_features: "b".into(),
    };
    let config = OpenAiConfig::codex(false, false, identity, Arc::new(Facts), context.clone());
    OpenAiAdapter::new(
        ProviderId::from("openai-oauth"),
        OpenAiCodec::new(config, transport),
        AdapterLinks { http, dial, compress_lane: mixdog_rt::testing::tokens().cpu_bulk, credentials, context, listing: ListingLookup::new() },
    )
}

fn request(turn: Option<&str>) -> Arc<ModelRequest> {
    Arc::new(ModelRequest {
        model: "gpt-fixture".into(),
        messages: vec![ChatMessage::new(Role::User, Content::Text("hi".into()))],
        tools: vec![],
        options: RequestOptions {
            transport_scope: Some("scope".into()),
            thread: turn.map(|t| RequestThread {
                id: "thread-1".into(),
                window: 2,
                turn: Some(t.into()),
                turn_started_at_ms: None,
            }),
            ..Default::default()
        },
    })
}

/// A complete one-message answer, "The result is 42.", as SSE.
fn sse(_name: &str) -> Vec<Bytes> {
    let events = [
        r#"{"type":"response.created","response":{"id":"resp_fx","model":"gpt-fixture"}}"#,
        r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_fx","role":"assistant","content":[]}}"#,
        r#"{"type":"response.output_text.delta","output_index":0,"item_id":"msg_fx","delta":"The result "}"#,
        r#"{"type":"response.output_text.delta","output_index":0,"item_id":"msg_fx","delta":"is 42."}"#,
        r#"{"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_fx","role":"assistant","content":[{"type":"output_text","text":"The result is 42."}]}}"#,
        r#"{"type":"response.completed","response":{"id":"resp_fx","model":"gpt-fixture","status":"completed","usage":{"input_tokens":20,"output_tokens":8,"total_tokens":28},"output":[{"type":"message","id":"msg_fx","role":"assistant","content":[{"type":"output_text","text":"The result is 42."}]}]}}"#,
    ];
    let body: String = events
        .iter()
        .map(|e| {
            let kind = e.split('"').nth(3).unwrap();
            format!("event: {kind}\ndata: {e}\n\n")
        })
        .collect();
    vec![Bytes::from(body)]
}

async fn collect(adapter: &OpenAiAdapter, request: Arc<ModelRequest>) -> Result<Vec<StreamEvent>, ProviderError> {
    let mut stream = adapter.attempt(request).await?;
    let mut events = Vec::new();
    while let Some(event) = stream.next().await {
        events.push(event?);
    }
    Ok(events)
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
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

// ---- HTTP -------------------------------------------------------------------

#[tokio::test]
async fn http_attempt_sends_credentials_and_streams_the_answer() {
    let http = ScriptedHttp::with(vec![(200, vec![], sse("text"))]);
    let adapter = adapter(TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), Credentials::new("tok", None));
    let events = collect(&adapter, request(None)).await.unwrap();
    assert_eq!(text_of(&events), "The result is 42.");
    let seen = http.seen.lock().unwrap();
    assert_eq!(header(&seen[0].headers, "authorization"), Some("Bearer tok"));
    assert_eq!(header(&seen[0].headers, "chatgpt-account-id"), Some("acct"));
    assert_eq!(seen[0].headers[0].0, "Authorization", "the credential leads the headers");
}

#[tokio::test]
async fn a_401_reloads_the_credential_once_and_replays() {
    let http = ScriptedHttp::with(vec![
        (401, vec![], vec![Bytes::from_static(br#"{"error":{"code":"invalid_api_key"}}"#)]),
        (200, vec![], sse("text")),
    ]);
    let credentials = Credentials::new("old", Some("new"));
    let adapter = adapter(TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), credentials.clone());
    collect(&adapter, request(None)).await.unwrap();
    let seen = http.seen.lock().unwrap();
    assert_eq!(header(&seen[0].headers, "authorization"), Some("Bearer old"));
    assert_eq!(header(&seen[1].headers, "authorization"), Some("Bearer new"));
    assert_eq!(*credentials.asked.lock().unwrap(), 1);
}

#[tokio::test]
async fn a_401_that_survives_the_reload_asks_for_a_new_login() {
    let http = ScriptedHttp::with(vec![
        (401, vec![], vec![Bytes::from_static(br#"{"error":{"code":"invalid_api_key"}}"#)]),
        (401, vec![], vec![Bytes::from_static(br#"{"error":{"code":"invalid_api_key"}}"#)]),
    ]);
    let adapter = adapter(TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), Credentials::new("a", Some("b")));
    let err = adapter.attempt(request(None)).await.err().expect("rejected");
    assert_eq!(err.kind, ErrorKind::Auth);
    assert!(err.reauth_required);
    assert_eq!(http.seen.lock().unwrap().len(), 2, "one replay, never more");
}

#[tokio::test]
async fn the_turn_state_token_replays_within_its_turn_only() {
    let issued = vec![("x-codex-turn-state".to_owned(), "tok-1".to_owned())];
    let http = ScriptedHttp::with(vec![
        (200, issued, sse("text")),
        (200, vec![], sse("text")),
        (200, vec![], sse("text")),
    ]);
    let adapter = adapter(TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), Credentials::new("t", None));
    collect(&adapter, request(Some("turn-1"))).await.unwrap();
    collect(&adapter, request(Some("turn-1"))).await.unwrap();
    collect(&adapter, request(Some("turn-2"))).await.unwrap();
    let seen = http.seen.lock().unwrap();
    assert_eq!(header(&seen[0].headers, "x-codex-turn-state"), None);
    assert_eq!(header(&seen[1].headers, "x-codex-turn-state"), Some("tok-1"));
    assert_eq!(header(&seen[2].headers, "x-codex-turn-state"), None, "a new turn starts clean");
}

// ---- WebSocket --------------------------------------------------------------

fn frame(json: &str) -> Message {
    Message::text(json.to_owned())
}

#[tokio::test]
async fn ws_attempt_sends_one_create_frame_and_streams_frames() {
    let dial = ScriptedDial::with(vec![Dialed::Socket(vec![
        frame(r#"{"type":"response.created","response":{"id":"resp_1","model":"m"}}"#),
        frame(r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","content":[]}}"#),
        frame(r#"{"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","delta":"hello"}"#),
        frame(r#"{"type":"response.completed","response":{"id":"resp_1","model":"m","status":"completed","usage":{"input_tokens":1,"output_tokens":1},"output":[{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}"#),
    ])]);
    let adapter = adapter(TransportKind::WebSocket, ScriptedHttp::with(vec![]), dial.clone(), Credentials::new("tok", None));
    let events = collect(&adapter, request(None)).await.unwrap();
    assert_eq!(text_of(&events), "hello");
    let sent = dial.sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    let Message::Text(body) = &sent[0] else { panic!("text frame") };
    assert!(body.as_str().starts_with(r#"{"type":"response.create","model":"gpt-fixture""#));
    let handshake = dial.requests.lock().unwrap();
    assert_eq!(header(&handshake[0], "authorization"), Some("Bearer tok"));
    assert_eq!(header(&handshake[0], "chatgpt-account-id"), Some("acct"));
}

#[tokio::test]
async fn a_rejected_upgrade_reloads_the_credential_like_a_401_response() {
    let dial = ScriptedDial::with(vec![
        Dialed::Rejected(401),
        Dialed::Socket(vec![frame(r#"{"type":"response.completed","response":{"id":"r","model":"m","status":"completed","output":[]}}"#)]),
    ]);
    let adapter = adapter(TransportKind::WebSocket, ScriptedHttp::with(vec![]), dial.clone(), Credentials::new("old", Some("new")));
    collect(&adapter, request(None)).await.unwrap();
    let handshake = dial.requests.lock().unwrap();
    assert_eq!(header(&handshake[0], "authorization"), Some("Bearer old"));
    assert_eq!(header(&handshake[1], "authorization"), Some("Bearer new"));
}

#[tokio::test]
async fn an_error_frame_that_is_not_an_effort_rejection_reaches_the_decoder() {
    let dial = ScriptedDial::with(vec![Dialed::Socket(vec![frame(
        r#"{"type":"error","status":400,"error":{"code":"context_length_exceeded","param":"input[0]"}}"#,
    )])]);
    let adapter = adapter(TransportKind::WebSocket, ScriptedHttp::with(vec![]), dial.clone(), Credentials::new("t", None));
    let result = collect(&adapter, request(None)).await;
    assert!(result.is_err(), "the failure is the stream's, not swallowed");
    assert_eq!(dial.sent.lock().unwrap().len(), 1, "nothing was replayed");
}

// ---- the connection warm-up (shared/llm/http-agent.mjs:496-527, openai-oauth.mjs:106, :170) --------------------------

fn clocked(now: &Arc<std::sync::atomic::AtomicU64>, var: Option<(&'static str, &'static str)>) -> Arc<SessionContext> {
    let now = now.clone();
    let context = SessionContext::with_sources(move || now.load(std::sync::atomic::Ordering::SeqCst), || "id".to_owned());
    Arc::new(match var {
        Some((name, value)) => context.with_var(move |asked| (asked == name).then(|| value.to_owned())),
        None => context.with_var(|_| None),
    })
}

#[tokio::test]
async fn the_warm_up_is_one_fire_and_forget_head_to_the_codex_origin_under_the_ten_second_deadline() {
    let http = ScriptedHttp::with(vec![(200, vec![], sse("text"))]);
    let now = Arc::new(std::sync::atomic::AtomicU64::new(1_000));
    let adapter = adapter_in(clocked(&now, None), TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), Credentials::new("t", None));
    // Constructing the provider warms (`openai-oauth.mjs:106`); the request before any turn adds none inside the TTL.
    assert_eq!(http.warmups.lock().unwrap().len(), 1);
    collect(&adapter, request(None)).await.unwrap();
    let warmups = http.warmups.lock().unwrap();
    assert_eq!(warmups.len(), 1, "one warm-up per origin per TTL");
    let (head, exchange) = &warmups[0];
    assert_eq!((head.method.as_str(), head.url.as_str()), ("HEAD", "https://chatgpt.com/"));
    assert!(head.headers.is_empty() && head.body.is_empty(), "the provider adds no header and no body of its own");
    assert_eq!(*exchange, mixdog_ai::transport::deadlines::PRECONNECT, "10 s, no redirect followed");
    assert_eq!(http.seen.lock().unwrap().len(), 1, "the warm-up is not a turn");
}

/// Warm-ups after the constructor's, when the clock moves `after` ms past it and one turn runs there. The warm-up
/// stamp is per process (`_preconnectedAt`, a module Map), so each of these runs alone in its process under nextest.
async fn warmups_after(var: Option<(&'static str, &'static str)>, steps: &[u64], fail: bool) -> usize {
    let http = ScriptedHttp::with(steps.iter().map(|_| (200, vec![], sse("text"))).collect());
    http.warmup_fails.store(fail, std::sync::atomic::Ordering::SeqCst);
    let now = Arc::new(std::sync::atomic::AtomicU64::new(1_000));
    let adapter = adapter_in(clocked(&now, var), TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), Credentials::new("t", None));
    for after in steps {
        now.store(1_000 + after, std::sync::atomic::Ordering::SeqCst);
        collect(&adapter, request(None)).await.unwrap();
    }
    let count = http.warmups.lock().unwrap().len();
    count - 1
}

#[tokio::test]
async fn a_turn_inside_the_default_ttl_of_fifty_seconds_does_not_warm_again() {
    assert_eq!(warmups_after(None, &[49_999], false).await, 0);
}

#[tokio::test]
async fn a_turn_at_the_default_ttl_warms_again() {
    assert_eq!(warmups_after(None, &[50_000], false).await, 1);
}

#[tokio::test]
async fn a_short_keepalive_still_warms_every_five_seconds_at_most() {
    let short = Some(("MIXDOG_LLM_KEEPALIVE_MS", "1000"));
    assert_eq!(warmups_after(short, &[4_999], false).await, 0);
}

#[tokio::test]
async fn a_short_keepalive_floor_is_reached_at_five_seconds() {
    let short = Some(("MIXDOG_LLM_KEEPALIVE_MS", "1000"));
    assert_eq!(warmups_after(short, &[5_000], false).await, 1);
}

#[tokio::test]
async fn a_failed_warm_up_clears_the_stamp_so_the_next_turn_warms_again() {
    // Every warm-up fails: the constructor's, and then one before each of two turns 1 ms apart, well inside the TTL
    // (`http-agent.mjs:520-526` deletes the stamp on failure). Nothing reaches the caller: both turns succeed.
    assert_eq!(warmups_after(None, &[1, 2], true).await, 2);
}