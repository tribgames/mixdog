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
            Dialed::Refused(status, body) => Err(ConnectError::Rejected(
                Response::builder().status(status).body(Some(body.as_bytes().to_vec())).unwrap(),
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
    http: Arc<dyn HttpSend>,
    dial: Arc<ScriptedDial>,
    credentials: Arc<dyn CredentialSource>,
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
    let messages = ["a", "b", "c"].iter().zip([Role::User, Role::Assistant, Role::User]).map(|(text, role)| ChatMessage::new(role, Content::Text((*text).into()))).collect();
    let sent = Arc::new(ModelRequest {
        model: "gpt-fixture".into(),
        messages,
        tools: vec![],
        options: RequestOptions {
            transport_scope: Some("scope".into()),
            effort_projection: Some(mixdog_core_api::domain::provider::EffortProjection { initial_effort: "low".into(), updates: std::collections::BTreeMap::from([(2, "high".into())]) }),
            ..Default::default()
        },
    });
    let http = ScriptedHttp::with(vec![(400, vec![], vec![Bytes::from_static(br#"{"error":{"code":"invalid_value","param":"input[2].reasoning"}}"#)]), (200, vec![], sse("text"))]);
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
    let dial = ScriptedDial::with(vec![Dialed::Socket(vec![frame(
        r#"{"type":"error","status":400,"error":{"code":"context_length_exceeded","param":"input[0]"}}"#,
    )])]);
    let adapter = adapter(TransportKind::WebSocket, ScriptedHttp::with(vec![]), dial.clone(), Credentials::new("t", None));
    let result = collect(&adapter, request(None)).await;
    assert!(result.is_err(), "the failure is the stream's, not swallowed");
    assert_eq!(dial.sent.lock().unwrap().len(), 1, "nothing was replayed");
}

// ---- the recorded error cases, replayed whole (providers-intercepted) -----------------------------------------------

macro_rules! recorded {
    ($family:literal, $scenario:literal, $file:literal) => {
        serde_json::from_str::<serde_json::Value>(mixdog_testkit::fixture_text(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/providers-intercepted/",
            $family,
            "/",
            $scenario,
            "/",
            $file
        )))
        .unwrap()
    };
}

fn key_adapter(transport: TransportKind, http: Arc<ScriptedHttp>, dial: Arc<ScriptedDial>, credentials: Arc<Credentials>) -> OpenAiAdapter {
    key_adapter_in(Arc::new(SessionContext::new()), transport, http, dial, credentials)
}

fn key_adapter_in(context: Arc<SessionContext>, transport: TransportKind, http: Arc<dyn HttpSend>, dial: Arc<ScriptedDial>, credentials: Arc<dyn CredentialSource>) -> OpenAiAdapter {
    let config = OpenAiConfig::api_key(true, Arc::new(Facts), context.clone());
    OpenAiAdapter::new(
        ProviderId::from("openai"),
        OpenAiCodec::new(config, transport),
        AdapterLinks { http, dial, compress_lane: mixdog_rt::testing::tokens().cpu_bulk, credentials, context, listing: ListingLookup::new() },
    )
}

/// The turn requests of a recording, in the order Node sent them (the rest are token refreshes).
fn turns(exchange: &serde_json::Value) -> Vec<&serde_json::Value> {
    exchange["records"].as_array().unwrap().iter().filter(|r| r["path"].as_str().unwrap().ends_with("/responses")).collect()
}

fn assert_recorded_error(err: &ProviderError, result: &serde_json::Value) {
    let node = &result["error"];
    assert_eq!(err.message, node["message"].as_str().unwrap());
    assert_eq!(err.status.map(u64::from), node["status"].as_u64());
}

/// An HTTP error scenario: the served body at the recorded status, once per recorded turn; the key source reads the
/// same key again (the API-key routes) or the account renews it (OAuth).
async fn replay_http(oauth: bool, exchange: serde_json::Value, result: serde_json::Value) {
    let status = u16::try_from(result["error"]["status"].as_u64().unwrap()).unwrap();
    let turns = turns(&exchange);
    let http = ScriptedHttp::with(turns.iter().map(|t| (status, vec![], vec![Bytes::from(t["served"].as_str().unwrap().to_owned())])).collect());
    let adapter = if oauth {
        adapter(TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), Credentials::new("old", Some("new")))
    } else {
        key_adapter(TransportKind::Http1, http.clone(), ScriptedDial::with(vec![]), Credentials::new("fixture-key", None))
    };
    let err = adapter.attempt(request(None)).await.err().expect("the recorded rejection");
    assert_recorded_error(&err, &result);
    assert_eq!(http.seen.lock().unwrap().len(), turns.len(), "the requests Node sent");
}

#[tokio::test]
async fn the_recorded_direct_http_400_reads_as_nodes() {
    replay_http(false, recorded!("openai-responses-sse-direct", "error-400", "exchange.json"), recorded!("openai-responses-sse-direct", "error-400", "result.json")).await;
}

/// A 401 on the API-key route is sent once more with the key read again, which is the same key: Node's second request.
#[tokio::test]
async fn the_recorded_direct_http_401_is_resent_once_with_the_same_key() {
    replay_http(false, recorded!("openai-responses-sse-direct", "error-401", "exchange.json"), recorded!("openai-responses-sse-direct", "error-401", "result.json")).await;
}

#[tokio::test]
async fn the_recorded_oauth_http_400_reads_as_nodes() {
    replay_http(true, recorded!("openai-oauth-responses-sse", "error-400", "exchange.json"), recorded!("openai-oauth-responses-sse", "error-400", "result.json")).await;
}

#[tokio::test]
async fn the_recorded_oauth_http_401_reads_as_nodes() {
    replay_http(true, recorded!("openai-oauth-responses-sse", "error-401", "exchange.json"), recorded!("openai-oauth-responses-sse", "error-401", "result.json")).await;
}

/// The recorder's server refuses the upgrade with the status text `fixture handshake rejection` as the body
/// (`lib/intercept.mjs`, `cb(false, status, …)`); the direct route retries the upgrade once with the same key.
#[tokio::test]
async fn the_recorded_direct_handshake_401_reads_as_nodes() {
    let exchange = recorded!("openai-responses-ws", "error-http-handshake-401", "exchange.json");
    let result = recorded!("openai-responses-ws", "error-http-handshake-401", "result.json");
    let refused = exchange["records"].as_array().unwrap().len();
    let dial = ScriptedDial::with((0..refused).map(|_| Dialed::Refused(401, "fixture handshake rejection")).collect());
    let adapter = key_adapter(TransportKind::WebSocket, ScriptedHttp::with(vec![]), dial.clone(), Credentials::new("fixture-key", None));
    let err = adapter.attempt(request(None)).await.err().expect("the recorded refusal");
    assert_recorded_error(&err, &result);
    assert_eq!(dial.requests.lock().unwrap().len(), refused, "the upgrades Node sent");
}

/// The OAuth route's upgrade is refused 401, the adapter asks the real credential to renew, and the recorder's token
/// endpoint answers its refresh with 404 `no script` (no token): Node's error is the refresh failure, worded whole.
#[tokio::test]
async fn the_recorded_oauth_handshake_401_ends_in_the_refresh_failure_as_nodes_words_it() {
    use mixdog_ai::oauth::CredentialFile;
    use mixdog_ai::oauth::CredentialIo;
    use mixdog_ai::providers::openai::oauth::OpenAiOAuth;
    let exchange = recorded!("openai-oauth-responses-ws", "error-http-handshake-401", "exchange.json");
    let result = recorded!("openai-oauth-responses-ws", "error-http-handshake-401", "result.json");
    let records = exchange["records"].as_array().unwrap();
    let (upgrades, refreshes): (Vec<_>, Vec<_>) = records.iter().partition(|r| r["transport"] == "ws");
    let refresh = refreshes[0];
    assert_eq!(refreshes.len(), 1, "Node refreshed once");

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("openai-oauth.json");
    let tokens = serde_json::json!({ "access_token": "fixture-access-token", "refresh_token": "fixture-refresh-token", "expires_at": 4_102_444_800_000u64, "account_id": "acct-fixture" });
    tokio::fs::write(&path, tokens.to_string()).await.unwrap();
    let rt = mixdog_rt::testing::tokens();
    let file = CredentialFile::new(path, CredentialIo { read: rt.interactive_io, write: rt.durability_io });
    let token_endpoint = ScriptedHttp::with(vec![(404, vec![], vec![Bytes::from(refresh["served"].as_str().unwrap().to_owned())])]);
    let credentials = Arc::new(OpenAiOAuth::new(file, token_endpoint.clone()));
    let dial = ScriptedDial::with((0..upgrades.len()).map(|_| Dialed::Refused(401, "fixture handshake rejection")).collect());
    let adapter = adapter_in(Arc::new(SessionContext::new()), TransportKind::WebSocket, ScriptedHttp::with(vec![]), dial.clone(), credentials);
    let err = adapter.attempt(request(None)).await.err().expect("the recorded refresh failure");

    assert_recorded_error(&err, &result);
    assert_eq!(dial.requests.lock().unwrap().len(), upgrades.len(), "the upgrades Node sent");
    let sent = token_endpoint.seen.lock().unwrap();
    assert_eq!(sent.len(), 1, "the refresh Node sent");
    assert_eq!(sent[0].method, refresh["method"].as_str().unwrap());
    assert_eq!(sent[0].url, format!("{}{}", refresh["origin"].as_str().unwrap(), refresh["path"].as_str().unwrap()));
    assert_eq!(String::from_utf8_lossy(&sent[0].body), refresh["bodyText"].as_str().unwrap());
}

// ---- the initial-response window (stall-policy.mjs:98, provider-http-response-timeout) ------------------------------

/// A transport whose every turn request outlives its exchange's timer: it records the window the exchange gave and the
/// error text the link would give (the warm-up HEAD is answered empty and not recorded).
#[derive(Default)]
struct Stalling {
    seen: Mutex<Vec<(std::time::Duration, String)>>,
}

#[async_trait]
impl HttpSend for Stalling {
    async fn send(&self, request: WireRequest, exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        if request.method == "HEAD" {
            return Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(VecBody(VecDeque::new())) });
        }
        let expired = exchange.liveness.bound_head(std::future::pending::<()>()).await.expect_err("the request is never answered");
        let error = mixdog_ai::transport::link::deadline_error(expired, mixdog_core_api::domain::provider::DeliveryState::Ambiguous, exchange.surface);
        self.seen.lock().unwrap().push((expired.after, error.message.clone()));
        Err(error)
    }
}

/// Every recorded case: Node's request armed its timer for `armedForMs` and rejected with `error.message`, on the route and
/// under the settings the case names (`MIXDOG_PROVIDER_HTTP_RESPONSE_TIMEOUT_MS`, `STALL_TIMEOUT_S`; null is unset).
#[tokio::test(start_paused = true)]
async fn the_initial_response_window_is_nodes_for_every_recorded_setting() {
    let recording: serde_json::Value = serde_json::from_str(mixdog_testkit::fixture_text(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/provider-http-response-timeout/cases.json"
    )))
    .unwrap();
    let cases = recording["cases"].as_array().unwrap();
    assert!(cases.len() > 20, "the recording holds its cases");
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let input = &case["input"];
        let vars: Vec<(&'static str, String)> = [
            ("MIXDOG_PROVIDER_HTTP_RESPONSE_TIMEOUT_MS", &input["setting"]),
            ("STALL_TIMEOUT_S", &input["STALL_TIMEOUT_S"]),
        ]
        .into_iter()
        .filter_map(|(name, value)| value.as_str().map(|v| (name, v.to_owned())))
        .collect();
        let context = Arc::new(SessionContext::new().with_var(move |asked| vars.iter().find(|(name, _)| *name == asked).map(|(_, v)| v.clone())));
        let stalling = Arc::new(Stalling::default());
        let adapter = if input["route"] == "oauth" {
            adapter_in(context, TransportKind::Http1, stalling.clone(), ScriptedDial::with(vec![]), Credentials::new("t", None))
        } else {
            key_adapter_in(context, TransportKind::Http1, stalling.clone(), ScriptedDial::with(vec![]), Credentials::new("fixture-key", None))
        };
        let err = adapter.attempt(request(None)).await.err().unwrap_or_else(|| panic!("{id}: the request is never answered"));
        let result = &case["result"];
        let node_ms = result["armedForMs"].as_u64().unwrap();
        let seen = stalling.seen.lock().unwrap().clone();
        assert_eq!(seen.first().map(|(after, _)| after.as_millis() as u64), Some(node_ms), "{id}: the window the request got");
        assert_eq!(err.message, result["error"]["message"].as_str().unwrap(), "{id}");
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