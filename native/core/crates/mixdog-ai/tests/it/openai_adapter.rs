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
    async fn send(&self, request: WireRequest, exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
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
    /// An upgrade refused with `status` and this body.
    Refused(u16, &'static str),
}

struct ScriptedDial {
    script: Mutex<VecDeque<Dialed>>,
    sent: Arc<Mutex<Vec<Message>>>,
    requests: Mutex<Vec<Vec<(String, String)>>>,
}

impl ScriptedDial {
    fn with(script: Vec<Dialed>) -> Arc<Self> {
        Arc::new(Self { script: Mutex::new(script.into()), sent: Arc::default(), requests: Mutex::default() })
    }
}

#[async_trait]
impl WsDial for ScriptedDial {
    async fn dial(
        &self,
        request: tokio_tungstenite::tungstenite::handshake::client::Request,
    ) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError> {
        self.requests.lock().unwrap().push(request.headers().iter().map(|(k, v)| (k.as_str().to_owned(), v.to_str().unwrap().to_owned())).collect());
        match self.script.lock().unwrap().pop_front().expect("scripted dial") {
            Dialed::Socket(frames) => Ok((
                Box::new(ScriptSocket { sent: self.sent.clone(), frames: frames.into_iter().map(Ok).collect() }),
                Response::builder().status(101).body(None).unwrap(),
            )),
            Dialed::Rejected(status) => Err(ConnectError::Rejected(Response::builder().status(status).body(Some(b"{}".to_vec())).unwrap())),
            Dialed::Refused(status, body) => Err(ConnectError::Rejected(Response::builder().status(status).body(Some(body.as_bytes().to_vec())).unwrap())),
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
        Arc::new(Self { current: credential(current), refreshed: Mutex::new(refreshed.map(credential)), asked: Mutex::new(0) })
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

fn adapter(transport: TransportKind, http: Arc<ScriptedHttp>, dial: Arc<ScriptedDial>, credentials: Arc<Credentials>) -> OpenAiAdapter {
    adapter_in(Arc::new(SessionContext::new()), transport, http, dial, credentials)
}

fn adapter_in(
    context: Arc<SessionContext>,
    transport: TransportKind,
    http: Arc<dyn HttpSend>,
    dial: Arc<ScriptedDial>,
    credentials: Arc<dyn CredentialSource>,
) -> OpenAiAdapter {
    let identity = CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "1".into(), beta_features: "b".into() };
    let config = OpenAiConfig::codex(false, identity, Arc::new(Facts), context.clone());
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
            thread: turn.map(|t| RequestThread { id: "thread-1".into(), window: 2, turn: Some(t.into()), turn_started_at_ms: None }),
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
    let http = ScriptedHttp::with(vec![(401, vec![], vec![Bytes::from_static(br#"{"error":{"code":"invalid_api_key"}}"#)]), (200, vec![], sse("text"))]);
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

struct Refreshing(Arc<std::sync::atomic::AtomicUsize>);
impl ModelFactsSource for Refreshing {
    fn facts(&self, _: &str) -> ModelFacts {
        ModelFacts::default()
    }
    fn refresh<'a>(&'a self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
    }
}

/// `openai-oauth.mjs:323`: an unknown-model refusal reads the roster again and sends the same id once more; a second
/// refusal is the answer, and a refusal that is not about the model is not retried.
#[tokio::test]
async fn an_unknown_model_refusal_refreshes_the_roster_and_resends_the_same_id_once() {
    let refused = || (404, vec![], vec![Bytes::from_static(br#"{"error":{"code":"model_not_found","message":"The model gpt-fixture does not exist"}}"#)]);
    let build = |http: Arc<ScriptedHttp>| {
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let context = Arc::new(SessionContext::new());
        let identity = CodexIdentity { installation_id: "i".into(), user_agent: "ua".into(), version: "1".into(), beta_features: "b".into() };
        let config = OpenAiConfig::codex(false, identity, Arc::new(Refreshing(reads.clone())), context.clone());
        let adapter = OpenAiAdapter::new(
            ProviderId::from("openai-oauth"),
            OpenAiCodec::new(config, TransportKind::Http1),
            AdapterLinks {
                http,
                dial: ScriptedDial::with(vec![]),
                compress_lane: mixdog_rt::testing::tokens().cpu_bulk,
                credentials: Credentials::new("t", None),
                context,
                listing: ListingLookup::new(),
            },
        );
        (adapter, reads)
    };

    let http = ScriptedHttp::with(vec![refused(), (200, vec![], sse("text"))]);
    let (adapter, reads) = build(http.clone());
    collect(&adapter, request(None)).await.expect("the resend answers");
    let bodies: Vec<serde_json::Value> = http.seen.lock().unwrap().iter().map(|r| serde_json::from_slice(&r.body).unwrap()).collect();
    assert_eq!(reads.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0]["model"], "gpt-fixture");
    assert_eq!(bodies[1]["model"], "gpt-fixture", "the same id");

    let http = ScriptedHttp::with(vec![refused(), refused()]);
    let (adapter, reads) = build(http.clone());
    assert!(adapter.attempt(request(None)).await.is_err());
    assert_eq!((reads.load(std::sync::atomic::Ordering::SeqCst), http.seen.lock().unwrap().len()), (1, 2), "once, never more");
}

#[tokio::test]
async fn the_turn_state_token_replays_within_its_turn_only() {
    let issued = vec![("x-codex-turn-state".to_owned(), "tok-1".to_owned())];
    let http = ScriptedHttp::with(vec![(200, issued, sse("text")), (200, vec![], sse("text")), (200, vec![], sse("text"))]);
    let adapter = adapter(TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), Credentials::new("t", None));
    collect(&adapter, request(Some("turn-1"))).await.unwrap();
    collect(&adapter, request(Some("turn-1"))).await.unwrap();
    collect(&adapter, request(Some("turn-2"))).await.unwrap();
    let seen = http.seen.lock().unwrap();
    assert_eq!(header(&seen[0].headers, "x-codex-turn-state"), None);
    assert_eq!(header(&seen[1].headers, "x-codex-turn-state"), Some("tok-1"));
    assert_eq!(header(&seen[2].headers, "x-codex-turn-state"), None, "a new turn starts clean");
}

/// Node raises `requesting` before each HTTP/SSE request and names the attempt (`openai-http-sse-request.mjs:133`).
#[tokio::test]
async fn an_http_attempt_raises_requesting_and_names_its_attempt() {
    let http = ScriptedHttp::with(vec![(200, vec![], sse("text")), (200, vec![], sse("text"))]);
    let adapter = adapter(TransportKind::Http1, http, ScriptedDial::with(vec![]), Credentials::new("tok", None));
    let sent = request(None);
    collect(&adapter, sent.clone()).await.unwrap();
    collect(&adapter, sent.clone()).await.unwrap();
    let first = serde_json::json!({ "attempt": 1, "maxAttempts": 5, "retry": false });
    let second = serde_json::json!({ "attempt": 2, "maxAttempts": 5, "retry": true });
    assert_eq!(sent.options.send_identity.take_stages(), vec![("requesting", Some(first)), ("requesting", Some(second))]);
}

/// A request whose mid-conversation effort update the model rejects is sent again without it (`withEffortConfigurationFallback`
/// runs the whole send again, `effort-configuration.mjs:112`): the resend raises `requesting` as a first attempt.
#[tokio::test]
async fn an_http_resend_without_the_effort_update_raises_requesting_as_a_first_attempt() {
    let messages = ["a", "b", "c"]
        .iter()
        .zip([Role::User, Role::Assistant, Role::User])
        .map(|(text, role)| ChatMessage::new(role, Content::Text((*text).into())))
        .collect();
    let sent = Arc::new(ModelRequest {
        model: "gpt-fixture".into(),
        messages,
        tools: vec![],
        options: RequestOptions {
            transport_scope: Some("scope".into()),
            effort_projection: Some(mixdog_core_api::domain::provider::EffortProjection {
                initial_effort: "low".into(),
                updates: std::collections::BTreeMap::from([(2, "high".into())]),
            }),
            ..Default::default()
        },
    });
    let http = ScriptedHttp::with(vec![
        (400, vec![], vec![Bytes::from_static(br#"{"error":{"code":"invalid_value","param":"input[2].reasoning"}}"#)]),
        (200, vec![], sse("text")),
    ]);
    let adapter = adapter(TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), Credentials::new("tok", None));
    collect(&adapter, sent.clone()).await.unwrap();
    let bodies: Vec<serde_json::Value> = http.seen.lock().unwrap().iter().map(|r| serde_json::from_slice(&r.body).unwrap()).collect();
    assert_eq!(bodies[0]["input"][2]["type"], "configuration_update", "the first request carries the update");
    assert_eq!(bodies[1]["input"].as_array().unwrap().len(), bodies[0]["input"].as_array().unwrap().len() - 1, "the resend carries none");
    let first = serde_json::json!({ "attempt": 1, "maxAttempts": 5, "retry": false });
    assert_eq!(sent.options.send_identity.take_stages(), vec![("requesting", Some(first.clone())), ("requesting", Some(first))]);
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
        frame(
            r#"{"type":"response.completed","response":{"id":"resp_1","model":"m","status":"completed","usage":{"input_tokens":1,"output_tokens":1},"output":[{"type":"message","id":"msg_1","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}"#,
        ),
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

/// Node raises `requesting` before each WebSocket acquisition (`openai-oauth-ws.mjs:250`), the one that replays a refused
/// upgrade with the reloaded credential included (`dispatchWs(true)`, `openai-oauth.mjs:293`): item 4 of review 1122y.
#[tokio::test]
async fn each_ws_acquisition_raises_requesting_the_credential_resend_included() {
    let done = || frame(r#"{"type":"response.completed","response":{"id":"r","model":"m","status":"completed","output":[]}}"#);
    let dial = ScriptedDial::with(vec![Dialed::Rejected(401), Dialed::Socket(vec![done()])]);
    let adapter = adapter(TransportKind::WebSocket, ScriptedHttp::with(vec![]), dial, Credentials::new("old", Some("new")));
    let sent = request(None);
    collect(&adapter, sent.clone()).await.unwrap();
    assert_eq!(sent.options.send_identity.take_stages(), vec![("requesting", None), ("requesting", None)]);
}

/// The HTTP/SSE request re-sent with the reloaded credential is a new `postWithRetries` (`openai-oauth-dispatch.mjs:209`):
/// it raises `requesting` again, and its attempts count from the first.
#[tokio::test]
async fn an_http_resend_with_a_reloaded_credential_raises_requesting_as_a_first_attempt() {
    let http = ScriptedHttp::with(vec![(401, vec![], vec![Bytes::from_static(b"{}")]), (200, vec![], sse("text"))]);
    let adapter = adapter(TransportKind::Http1, http, ScriptedDial::with(vec![]), Credentials::new("old", Some("new")));
    let sent = request(None);
    collect(&adapter, sent.clone()).await.unwrap();
    let first = serde_json::json!({ "attempt": 1, "maxAttempts": 5, "retry": false });
    assert_eq!(sent.options.send_identity.take_stages(), vec![("requesting", Some(first.clone())), ("requesting", Some(first))]);
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
    let dial =
        ScriptedDial::with(vec![Dialed::Socket(vec![frame(r#"{"type":"error","status":400,"error":{"code":"context_length_exceeded","param":"input[0]"}}"#)])]);
    let adapter = adapter(TransportKind::WebSocket, ScriptedHttp::with(vec![]), dial.clone(), Credentials::new("t", None));
    let result = collect(&adapter, request(None)).await;
    assert!(result.is_err(), "the failure is the stream's, not swallowed");
    assert_eq!(dial.sent.lock().unwrap().len(), 1, "nothing was replayed");
}

fn key_adapter(transport: TransportKind, http: Arc<ScriptedHttp>, dial: Arc<ScriptedDial>, credentials: Arc<Credentials>) -> OpenAiAdapter {
    key_adapter_in(Arc::new(SessionContext::new()), transport, http, dial, credentials)
}

fn key_adapter_in(
    context: Arc<SessionContext>,
    transport: TransportKind,
    http: Arc<dyn HttpSend>,
    dial: Arc<ScriptedDial>,
    credentials: Arc<dyn CredentialSource>,
) -> OpenAiAdapter {
    let config = OpenAiConfig::api_key(true, Arc::new(Facts), context.clone());
    OpenAiAdapter::new(
        ProviderId::from("openai"),
        OpenAiCodec::new(config, transport),
        AdapterLinks { http, dial, compress_lane: mixdog_rt::testing::tokens().cpu_bulk, credentials, context, listing: ListingLookup::new() },
    )
}

// ---- the initial-response window (stall-policy.mjs:98, provider-http-response-timeout) ------------------------------

/// A transport whose every turn request is never answered (the warm-up HEAD is answered empty): the timer that ends it is the
/// driver's, installed on the request's attempt.
#[derive(Default)]
struct Stalling;

#[async_trait]
impl HttpSend for Stalling {
    async fn send(&self, request: WireRequest, _exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        if request.method == "HEAD" {
            return Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(VecBody(VecDeque::new())) });
        }
        std::future::pending().await
    }
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

// `foreignDispatcher()` (`http-agent.mjs:57`) is a global undici dispatcher somebody else installed (a `ProxyAgent`,
// a `MockAgent`): the warm-up steps aside for it. The core has no process-global dispatcher to find foreign, so it
// never does. A network proxy *setting* is not foreign in Node either (its own router carries it), and the warm-up
// then goes through the proxy leg: here the HEAD's connection is a CONNECT to the Codex origin at the proxy.
#[tokio::test]
async fn the_warm_up_goes_through_the_proxy_the_network_setting_names() {
    use mixdog_ai::netproxy::{EnvLookup, NetworkProxy, SystemProxy};
    use tokio::io::AsyncReadExt;
    struct NoEnv;
    impl EnvLookup for NoEnv {
        fn get(&self, _: &str) -> Option<String> {
            None
        }
    }
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = proxy.local_addr().unwrap();
    let (first_line, line) = tokio::sync::oneshot::channel::<String>();
    tokio::spawn(async move {
        let (mut stream, _) = proxy.accept().await.unwrap();
        let mut buf = [0u8; 512];
        let n = stream.read(&mut buf).await.unwrap();
        let _ = first_line.send(String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or_default().to_owned());
    });
    let policy = NetworkProxy::new(Arc::new(NoEnv), SystemProxy::default());
    policy.adopt(&serde_json::json!({ "mode": "manual", "url": format!("http://{addr}") }));
    let link = Arc::new(mixdog_ai::transport::ReqwestLink::routed(&KeepaliveSchedule::SPEC, false, policy));
    let now = Arc::new(std::sync::atomic::AtomicU64::new(1_000));
    let _adapter = adapter_in(clocked(&now, None), TransportKind::Http1, link, ScriptedDial::with(vec![]), Credentials::new("t", None));
    let line = mixdog_rt::time::timeout(std::time::Duration::from_secs(20), line).await.expect("the warm-up reached the proxy").unwrap();
    assert_eq!(line, "CONNECT chatgpt.com:443 HTTP/1.1");
}

// ---- the error cases of a turn, on both routes and both transports -----------------------------------------------------

const BAD_INPUT: &str = r#"{"error":{"message":"Invalid 'input': expected a string.","type":"invalid_request_error","param":"input","code":null}}"#;
const INVALID_KEY: &str = r#"{"error":{"message":"Incorrect API key provided.","type":"invalid_request_error","code":"invalid_api_key"}}"#;

/// A 400 says what the server said and is never resent, on the API-key route and the subscription route alike.
#[tokio::test]
async fn an_http_400_surfaces_the_servers_words_with_its_status_and_is_not_resent() {
    for oauth in [false, true] {
        let http = ScriptedHttp::with(vec![(400, vec![], vec![Bytes::from_static(BAD_INPUT.as_bytes())])]);
        let adapter = if oauth {
            adapter(TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), Credentials::new("old", Some("new")))
        } else {
            key_adapter(TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), Credentials::new("fixture-key", None))
        };
        let err = adapter.attempt(request(None)).await.err().expect("the request is refused");
        assert_eq!(err.status, Some(400), "oauth: {oauth}");
        assert!(err.message.contains("Invalid 'input': expected a string."), "oauth: {oauth}: {}", err.message);
        assert!(!err.reauth_required, "oauth: {oauth}");
        assert_eq!(http.seen.lock().unwrap().len(), 1, "oauth: {oauth}: a refusal of the request is not replayed");
    }
}

/// A 401 on the API-key route is sent once more with the key read again, which is the same key, and then ends the turn.
#[tokio::test]
async fn a_direct_http_401_is_resent_once_with_the_same_key() {
    let refused = || (401, vec![], vec![Bytes::from_static(INVALID_KEY.as_bytes())]);
    let http = ScriptedHttp::with(vec![refused(), refused()]);
    let adapter = key_adapter(TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), Credentials::new("fixture-key", None));
    let err = adapter.attempt(request(None)).await.err().expect("rejected twice");
    assert_eq!(err.status, Some(401));
    assert!(err.message.contains("Incorrect API key provided."), "{}", err.message);
    let seen = http.seen.lock().unwrap();
    assert_eq!(seen.len(), 2, "one resend, never more");
    for sent in seen.iter() {
        assert_eq!(header(&sent.headers, "authorization"), Some("Bearer fixture-key"));
    }
}

/// On the subscription route the 401 asks the account for a renewed credential and sends once more with it.
#[tokio::test]
async fn an_oauth_http_401_ends_the_turn_when_the_renewed_credential_is_refused_too() {
    let refused = || (401, vec![], vec![Bytes::from_static(INVALID_KEY.as_bytes())]);
    let http = ScriptedHttp::with(vec![refused(), refused()]);
    let credentials = Credentials::new("old", Some("new"));
    let adapter = adapter(TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), credentials.clone());
    let err = adapter.attempt(request(None)).await.err().expect("rejected twice");
    assert_eq!((err.status, err.reauth_required), (Some(401), true));
    let seen = http.seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!((header(&seen[0].headers, "authorization"), header(&seen[1].headers, "authorization")), (Some("Bearer old"), Some("Bearer new")));
    assert_eq!(*credentials.asked.lock().unwrap(), 1);
}

/// A refused upgrade (401) on the API-key route is dialled once more with the same key, then ends the turn with the status.
#[tokio::test]
async fn a_direct_handshake_401_is_retried_once_with_the_same_key() {
    let dial = ScriptedDial::with(vec![Dialed::Refused(401, "fixture handshake rejection"), Dialed::Refused(401, "fixture handshake rejection")]);
    let adapter = key_adapter(TransportKind::WebSocket, ScriptedHttp::with(vec![]), dial.clone(), Credentials::new("fixture-key", None));
    let err = adapter.attempt(request(None)).await.err().expect("the upgrade is refused");
    assert_eq!(err.status, Some(401));
    let upgrades = dial.requests.lock().unwrap();
    assert_eq!(upgrades.len(), 2, "one more upgrade, never more");
    for upgrade in upgrades.iter() {
        assert_eq!(header(upgrade, "authorization"), Some("Bearer fixture-key"));
    }
}

/// On the subscription route a refused upgrade asks the real credential to renew; when the token endpoint answers the refresh
/// with a refusal, the turn ends in the refresh failure, worded as the credential words it, after exactly one refresh.
#[tokio::test]
async fn an_oauth_handshake_401_ends_in_the_refresh_failure_when_the_token_endpoint_refuses() {
    use mixdog_ai::oauth::CredentialFile;
    use mixdog_ai::oauth::CredentialIo;
    use mixdog_ai::providers::openai::oauth::OpenAiOAuth;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("openai-oauth.json");
    let tokens = serde_json::json!({ "access_token": "fixture-access-token", "refresh_token": "fixture-refresh-token", "expires_at": 4_102_444_800_000u64, "account_id": "acct-fixture" });
    tokio::fs::write(&path, tokens.to_string()).await.unwrap();
    let rt = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(path, CredentialIo { read: rt.interactive_io, write: rt.durability_io });
    let token_endpoint = ScriptedHttp::with(vec![(404, vec![], vec![Bytes::from_static(b"no script")])]);
    let credentials = Arc::new(OpenAiOAuth::new(file, token_endpoint.clone()));
    let dial = ScriptedDial::with(vec![Dialed::Refused(401, "fixture handshake rejection"), Dialed::Refused(401, "fixture handshake rejection")]);
    let adapter = adapter_in(Arc::new(SessionContext::new()), TransportKind::WebSocket, ScriptedHttp::with(vec![]), dial, credentials);
    let err = adapter.attempt(request(None)).await.err().expect("the refresh fails");

    assert!(err.message.starts_with("OpenAI OAuth token refresh failed ("), "{}", err.message);
    assert!(err.message.ends_with("Re-authenticate via provider login."), "{}", err.message);
    let sent = token_endpoint.seen.lock().unwrap();
    assert_eq!(sent.len(), 1, "one refresh");
    assert_eq!((sent[0].method.as_str(), sent[0].url.as_str()), ("POST", "https://auth.openai.com/oauth/token"));
    let form: Vec<(String, String)> = url::form_urlencoded::parse(&sent[0].body).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    assert_eq!(form.iter().find(|(k, _)| k == "refresh_token").map(|(_, v)| v.as_str()), Some("fixture-refresh-token"));
}

/// A request whose head never comes ends at the window its settings give it (60 s unset, `MIXDOG_PROVIDER_HTTP_RESPONSE_TIMEOUT_MS`
/// otherwise), on both routes, with the initial-response wording.
#[tokio::test(start_paused = true)]
async fn the_initial_response_window_follows_the_setting_on_both_routes() {
    for (setting, window_ms) in [(None, 60_000_u64), (Some("30000"), 30_000), (Some("90000"), 90_000)] {
        for oauth in [false, true] {
            let vars: Vec<(&'static str, String)> = setting.map(|v| ("MIXDOG_PROVIDER_HTTP_RESPONSE_TIMEOUT_MS", v.to_owned())).into_iter().collect();
            let context = Arc::new(SessionContext::new().with_var(move |asked| vars.iter().find(|(name, _)| *name == asked).map(|(_, v)| v.clone())));
            let stalling = Arc::new(Stalling);
            let adapter = if oauth {
                adapter_in(context, TransportKind::Http1, stalling, ScriptedDial::with(vec![]), Credentials::new("t", None))
            } else {
                key_adapter_in(context, TransportKind::Http1, stalling, ScriptedDial::with(vec![]), Credentials::new("fixture-key", None))
            };
            let identity = mixdog_core_api::domain::provider::SendIdentity::default();
            let mut stalled = (*request(None)).clone();
            stalled.options.send_identity = identity.clone();
            let began = tokio::time::Instant::now();
            let err = adapter.attempt(Arc::new(stalled)).await.err().expect("the request is never answered");
            let case = format!("setting {setting:?}, oauth {oauth}");
            assert_eq!(began.elapsed().as_millis() as u64, window_ms, "{case}");
            assert_eq!(identity.attempt_context().window.as_millis() as u64, window_ms, "{case}: the window the request got");
            assert!(err.message.contains(&format!("initial response timed out after {window_ms}ms")), "{case}: {}", err.message);
        }
    }
}

// ---- the recorded error cases, replayed whole (providers-intercepted) -----------------------------------------------
