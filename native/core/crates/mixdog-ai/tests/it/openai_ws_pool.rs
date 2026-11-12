//! The pooled WebSocket: delta frames on a reused socket, a fresh socket after
//! a failure, and the move to HTTP/SSE, over scripted seams.

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

#[derive(Default)]
struct Dial {
    script: Mutex<VecDeque<Dialed>>,
    sent: Arc<Mutex<Vec<String>>>,
    dials: Mutex<u32>,
}

impl Dial {
    fn with(script: Vec<Dialed>) -> Arc<Self> {
        Arc::new(Self { script: Mutex::new(script.into()), ..Self::default() })
    }
}

#[async_trait]
impl WsDial for Dial {
    async fn dial(
        &self,
        _: tokio_tungstenite::tungstenite::handshake::client::Request,
    ) -> Result<(Box<dyn WsSocket>, Response<Option<Vec<u8>>>), ConnectError> {
        *self.dials.lock().unwrap() += 1;
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
    let context = Arc::new(SessionContext::new());
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

#[tokio::test]
async fn a_spent_websocket_budget_sends_the_sixth_attempt_over_http() {
    let http = Arc::new(Http::default());
    let mut script = Vec::new();
    for _ in 0..5 {
        script.push(Dialed::Socket(vec![Err(TransportFault::Reset)]));
    }
    let dial = Dial::with(script);
    let adapter = adapter(true, http.clone(), dial.clone());
    for n in 0..5 {
        assert!(drain(&adapter, request(vec![say(Role::User, "hi")])).await.is_err(), "attempt {n}");
    }
    drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 5);
    assert_eq!(http.seen.lock().unwrap().len(), 1);
    // The session stays on HTTP/SSE.
    drain(&adapter, request(vec![say(Role::User, "again")])).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 5);
}

#[tokio::test]
async fn a_server_close_1009_keeps_the_session_on_http() {
    let http = Arc::new(Http::default());
    let dial = Dial::with(vec![Dialed::Socket(vec![Err(TransportFault::WsClose { code: Some(1009) })])]);
    let adapter = adapter(false, http.clone(), dial.clone());
    assert!(drain(&adapter, request(vec![say(Role::User, "hi")])).await.is_err());
    drain(&adapter, request(vec![say(Role::User, "hi")])).await.unwrap();
    assert_eq!(*dial.dials.lock().unwrap(), 1);
    assert_eq!(http.seen.lock().unwrap().len(), 1);
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
        let adapter = adapter(node["auth"] == "openai-oauth", Arc::default(), dial.clone()).with_mode(TransportMode::WsDelta);
        let dials_node: Vec<u64> = node["events"].as_array().unwrap().iter().filter(|e| e["on"] == "dial").map(|e| e["t"].as_u64().unwrap()).collect();
        let want = &node["outcome"];
        let ends_at = want["t"].as_u64().unwrap();
        // The clock moves only to the instants Node's recording names (a dial began, the acquire ended); the acquire is polled
        // at each one, and the dials made by then are those Node had made.
        let mut instants: Vec<u64> = dials_node.iter().copied().chain([ends_at]).collect();
        instants.sort_unstable();
        instants.dedup();
        let mut acquire = Box::pin(adapter.attempt(request(vec![say(Role::User, "hi")])));
        let mut now = 0;
        let mut outcome = None;
        for at in instants {
            tokio::time::advance(std::time::Duration::from_millis(at - now)).await;
            now = at;
            let polled = futures::poll!(acquire.as_mut());
            assert_eq!(
                *dial.dials.lock().unwrap() as usize,
                dials_node.iter().filter(|t| **t <= at).count(),
                "{id}: the dials begun by {at} ms"
            );
            if let std::task::Poll::Ready(done) = polled {
                outcome = Some(done);
                break;
            }
        }
        let Some(outcome) = outcome else { panic!("{id}: the acquire had not ended by its recorded end, {ends_at} ms: a stuck upgrade is never replaced") };
        assert_eq!(now, ends_at, "{id}: when the acquire ended");
        match (outcome, want["ok"].as_bool().unwrap()) {
            (Ok(_), true) => {}
            (Err(error), false) => {
                if want["code"] == "EWSACQUIRETIMEOUT" {
                    assert_eq!(error.code.as_deref(), Some("EWSACQUIRETIMEOUT"), "{id}: the error's code");
                    assert_eq!(error.message, want["message"].as_str().unwrap(), "{id}: the acquire timeout's text");
                } else {
                    assert_eq!(error.code, None, "{id}: only the acquire timeout carries a code");
                }
                assert_eq!(error.status.map(u64::from), want["httpStatus"].as_u64(), "{id}: the status of an answered upgrade");
                if want["code"] == "ECONNRESET" {
                    assert_eq!(error.transport, Some(TransportFault::Reset), "{id}: a reset is a transport fault");
                }
            }
            (Ok(_), false) => panic!("{id}: Node failed with {want}, Rust opened"),
            (Err(error), true) => panic!("{id}: Node opened, Rust failed: {error:?}"),
        }
    }
}

#[allow(dead_code)]
fn unused(_: StreamEvent) {}

