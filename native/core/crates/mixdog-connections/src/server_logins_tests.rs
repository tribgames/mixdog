//! The server logins over scripted fakes: the server's core (a client whose replies the test scripts), the attached link, the
//! callback forward and the clock (paused). No ssh runs and no port is bound. They carry the cases of the desktop's
//! `ssh-ipc-server-logins.test.mjs`, except the ones that need the server's pushed `login:<flowId>` feed, which this PC's
//! client does not surface.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_app_server_client::api::{
    BlobRef, ClientError, FeedStamp, FoldStore, InitializeResponse, Json, JsonRpcErrorBody, RequestId, ResumeWindow, SectionEntry,
    ServerRequest, ServerRequestAnswer, StoreChange, ThreadFold, ThreadId, ThreadResumeResponse,
};
use mixdog_rt::DurabilityIo;
use serde_json::json;

use super::*;
use crate::paths::ConnectionsPaths;

const CALLBACK: &str = "https://auth.example/authorize?client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcb";
const MANUAL: &str = "https://auth.example/manual";
const CANCEL: &str = "account/cancelOAuthProviderLogin";

fn io() -> DurabilityIo {
    mixdog_rt::testing::tokens().durability_io
}

async fn settle() {
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
}

async fn advance(duration: Duration) {
    sleep(duration).await;
    settle().await;
}

// ----- the server's core -----------------------------------------------------------------------

enum Reply {
    Ok(Json),
    Rpc(&'static str),
    Lost,
    /// Never answers.
    Never,
}

#[derive(Default)]
struct StubStore {
    sections: Mutex<HashMap<(&'static str, Option<String>), Json>>,
}

impl FoldStore for StubStore {
    fn thread(&self, _thread_id: &str) -> Option<ThreadFold> {
        None
    }
    fn section(&self, section: SectionName, key: Option<&str>) -> Option<SectionEntry> {
        let value = self.sections.lock().unwrap().get(&(section.wire(), key.map(str::to_owned))).cloned()?;
        Some(SectionEntry { section, key: key.map(str::to_owned), revision: 1, value })
    }
    fn sections(&self, _section: SectionName) -> Vec<SectionEntry> {
        Vec::new()
    }
    fn app_feed(&self) -> Option<FeedStamp> {
        None
    }
    fn subscribe(&self) -> broadcast::Receiver<StoreChange> {
        broadcast::channel(1).1
    }
}

struct StubClient {
    store: Arc<StubStore>,
    handler: Mutex<Box<dyn Fn(&str, &Json) -> Reply + Send>>,
    calls: Mutex<Vec<(String, Json)>>,
}

impl StubClient {
    fn on(&self, handler: impl Fn(&str, &Json) -> Reply + Send + 'static) {
        *self.handler.lock().unwrap() = Box::new(handler);
    }

    fn calls_of(&self, method: &str) -> Vec<Json> {
        self.calls.lock().unwrap().iter().filter(|(name, _)| name == method).map(|(_, params)| params.clone()).collect()
    }
}

#[async_trait]
impl ProtocolClient for StubClient {
    fn store(&self) -> Arc<dyn FoldStore> {
        self.store.clone()
    }
    fn server(&self) -> InitializeResponse {
        unreachable!("the logins never read the initialize result")
    }
    fn status(&self) -> ConnectionStatus {
        ConnectionStatus::Ready { server_instance_id: "s".into() }
    }
    async fn call_raw(&self, method: &str, params: Json, _options: CallOptions) -> Result<Json, ClientError> {
        let reply = (self.handler.lock().unwrap())(method, &params);
        self.calls.lock().unwrap().push((method.to_owned(), params));
        match reply {
            Reply::Ok(value) => Ok(value),
            Reply::Rpc(message) => Err(ClientError::Rpc(JsonRpcErrorBody { code: -32000, data: None, message: message.to_owned() })),
            Reply::Lost => Err(ClientError::ConnectionLost),
            Reply::Never => std::future::pending().await,
        }
    }
    async fn notify(&self, _method: &str, _params: Json) -> Result<(), ClientError> {
        Ok(())
    }
    async fn resume_thread(&self, _thread_id: &ThreadId, _window: ResumeWindow) -> Result<ThreadResumeResponse, ClientError> {
        Err(ClientError::ClientClosed)
    }
    async fn unsubscribe_thread(&self, _thread_id: &ThreadId) -> Result<(), ClientError> {
        Err(ClientError::ClientClosed)
    }
    async fn subscribe_app(&self) -> Result<(), ClientError> {
        Ok(())
    }
    fn pending_server_requests(&self) -> Vec<ServerRequest> {
        Vec::new()
    }
    async fn respond(&self, _id: RequestId, _answer: ServerRequestAnswer) -> Result<(), ClientError> {
        Ok(())
    }
    async fn read_blob(&self, _blob: &BlobRef) -> Result<Vec<u8>, ClientError> {
        Err(ClientError::ClientClosed)
    }
    async fn put_blob(&self, _bytes: &[u8], _media_type: &str) -> Result<BlobRef, ClientError> {
        Err(ClientError::ClientClosed)
    }
    fn events(&self) -> broadcast::Receiver<mixdog_app_server_client::api::ClientEvent> {
        broadcast::channel(1).1
    }
    async fn close(&self) {}
}

fn pending_flow(url: &str) -> Json {
    json!({ "flowId": "f1", "provider": "openai-oauth", "state": "pending", "url": url, "manualUrl": MANUAL })
}

/// The server starts a login, reports it pending, completes it when asked and takes everything else.
fn serving(url: &'static str) -> impl Fn(&str, &Json) -> Reply + Send + 'static {
    move |method, _| match method {
        "account/beginOAuthProviderLogin" | "account/getOAuthProviderLoginStatus" => Reply::Ok(pending_flow(url)),
        "account/completeOAuthProviderLogin" => Reply::Ok(json!({ "flowId": "f1", "provider": "openai-oauth", "state": "complete" })),
        _ => Reply::Ok(json!({})),
    }
}

/// `serving`, except that the server does not take a cancel.
fn refusing_cancels(method: &str, _: &Json) -> Reply {
    match method {
        CANCEL => Reply::Lost,
        _ => Reply::Ok(pending_flow(CALLBACK)),
    }
}

/// A server that names each login after the provider asked for, and does not take a cancel.
fn naming_flows(method: &str, params: &Json) -> Reply {
    match method {
        "account/beginOAuthProviderLogin" => Reply::Ok(json!({ "flowId": params["providerId"], "state": "pending", "url": "https://auth.example/d" })),
        CANCEL => Reply::Lost,
        _ => Reply::Ok(json!({})),
    }
}

// ----- the attached link and the forward -------------------------------------------------------

struct FakeServer {
    login: Mutex<ModelLogin>,
    client: Arc<StubClient>,
    end: CancellationToken,
}

#[async_trait]
impl LoginServer for FakeServer {
    fn model_login(&self) -> ModelLogin {
        *self.login.lock().unwrap()
    }
    fn client(&self) -> Arc<dyn ProtocolClient> {
        self.client.clone()
    }
    fn busy_sessions(&self) -> Option<u32> {
        Some(2)
    }
    async fn ended(&self) {
        self.end.cancelled().await;
    }
}

struct FakeServers {
    attached: Mutex<HashMap<String, Arc<FakeServer>>>,
    attach: broadcast::Sender<String>,
}

impl LoginServers for FakeServers {
    fn attached(&self, id: &str) -> Option<Arc<dyn LoginServer>> {
        self.attached.lock().unwrap().get(id).map(|server| server.clone() as Arc<dyn LoginServer>)
    }
    fn on_attach(&self) -> broadcast::Receiver<String> {
        self.attach.subscribe()
    }
}

#[derive(Default)]
struct FakeForward {
    closes: AtomicUsize,
}

#[async_trait]
impl Forward for FakeForward {
    async fn close(&self) {
        self.closes.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct FakeForwarder {
    ports: Mutex<Vec<u16>>,
    forwards: Mutex<Vec<Arc<FakeForward>>>,
    refuse: AtomicBool,
}

#[async_trait]
impl CallbackForwarder for FakeForwarder {
    async fn open(&self, _host: &SshHostRecord, port: u16) -> Result<Arc<dyn Forward>, String> {
        if self.refuse.load(Ordering::SeqCst) {
            return Err(format!("Port {port} is in use on this PC."));
        }
        self.ports.lock().unwrap().push(port);
        let forward = Arc::new(FakeForward::default());
        self.forwards.lock().unwrap().push(forward.clone());
        Ok(forward)
    }
}

struct Rig {
    logins: ServerLogins,
    servers: Arc<FakeServers>,
    server: Arc<FakeServer>,
    client: Arc<StubClient>,
    forwarder: Arc<FakeForwarder>,
    _dir: tempfile::TempDir,
}

impl Rig {
    async fn new(login: ModelLogin) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let hosts = Arc::new(SshHostStore::load(&ConnectionsPaths::new(dir.path()), io()).await);
        let record = SshHostRecord { id: "h1".into(), name: "box".into(), target: "me@box".into(), last_connected_at: None, settings: None };
        hosts.save(record).await.unwrap();
        let client = Arc::new(StubClient {
            store: Arc::new(StubStore::default()),
            handler: Mutex::new(Box::new(serving(CALLBACK))),
            calls: Mutex::new(Vec::new()),
        });
        let server = Arc::new(FakeServer { login: Mutex::new(login), client: client.clone(), end: CancellationToken::new() });
        let servers = Arc::new(FakeServers {
            attached: Mutex::new(HashMap::from([("h1".to_owned(), server.clone())])),
            attach: broadcast::channel(8).0,
        });
        let forwarder = Arc::new(FakeForwarder::default());
        let logins = ServerLogins::with_parts(servers.clone(), hosts, forwarder.clone());
        Self { logins, servers, server, client, forwarder, _dir: dir }
    }

    /// The connection goes: nothing is attached.
    fn detach(&self) {
        self.servers.attached.lock().unwrap().clear();
    }

    /// The connection is attached again, and the attach is announced.
    fn attach(&self, server: &Arc<FakeServer>) {
        self.servers.attached.lock().unwrap().insert("h1".into(), server.clone());
        self.servers.attach.send("h1".into()).unwrap();
    }

    fn closes(&self) -> Vec<usize> {
        self.forwarder.forwards.lock().unwrap().iter().map(|forward| forward.closes.load(Ordering::SeqCst)).collect()
    }

    fn cancels(&self) -> usize {
        self.client.calls_of(CANCEL).len()
    }
}

fn message<T: std::fmt::Debug>(result: LoginResult<T>) -> String {
    result.unwrap_err().0
}

// ----- the callback port -----------------------------------------------------------------------

#[test]
fn the_callback_port_is_the_loopback_redirect_uri_port_of_the_authorization_url() {
    assert_eq!(callback_port_of(Some(CALLBACK)), Some(1455));
    let with = |redirect: &str| format!("https://auth.example/a?redirect_uri={redirect}");
    assert_eq!(callback_port_of(Some(&with("http%3A%2F%2F127.0.0.1%3A8080%2Fcb"))), Some(8080));
    assert_eq!(callback_port_of(Some(&with("http%3A%2F%2F%5B%3A%3A1%5D%3A1455%2Fcb"))), None);
    assert_eq!(callback_port_of(Some(&with("https%3A%2F%2Flocalhost%3A1455%2Fcb"))), None);
    assert_eq!(callback_port_of(Some(&with("http%3A%2F%2Fexample.com%3A1455%2Fcb"))), None);
    assert_eq!(callback_port_of(Some(&with("http%3A%2F%2Flocalhost%2Fcb"))), None);
    assert_eq!(callback_port_of(Some("https://auth.example/a")), None);
    assert_eq!(callback_port_of(Some("not a url")), None);
    assert_eq!(callback_port_of(None), None);
}

// ----- a subscription login --------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_login_runs_on_the_server_returns_the_address_to_open_and_forwards_the_callback_port_until_it_ends() {
    let rig = Rig::new(ModelLogin::Server).await;
    let flow = rig.logins.begin("h1", "openai-oauth").await.unwrap();
    assert_eq!(flow.flow_id, "f1");
    assert!(flow.forwarded);
    assert_eq!(flow.open_url.as_deref(), Some(CALLBACK));
    assert_eq!(flow.url.as_deref(), Some(CALLBACK));
    assert_eq!(*rig.forwarder.ports.lock().unwrap(), [1455]);
    // The server never opens a browser of its own.
    assert_eq!(
        rig.client.calls_of("account/beginOAuthProviderLogin"),
        [json!({ "providerId": "openai-oauth", "options": { "openBrowser": false } })]
    );
    // A pending status keeps the forward.
    let status = rig.logins.status("h1", "f1").await.unwrap();
    assert!(status.forwarded && status.state == SshServerLoginFlowState::Pending);
    assert_eq!(rig.closes(), [0]);
    // A status that ended it closes the forward.
    rig.client.on(|_, _| Reply::Ok(json!({ "flowId": "f1", "provider": "openai-oauth", "state": "failed", "error": "denied" })));
    let ended = rig.logins.status("h1", "f1").await.unwrap();
    assert_eq!((ended.state, ended.error.as_deref(), ended.forwarded), (SshServerLoginFlowState::Failed, Some("denied"), false));
    assert_eq!(rig.closes(), [1]);
}

#[tokio::test(start_paused = true)]
async fn an_ipv6_loopback_callback_is_not_forwarded_and_the_manual_page_opens() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.client.on(serving("https://auth.example/a?redirect_uri=http%3A%2F%2F%5B%3A%3A1%5D%3A1455%2Fcb"));
    let flow = rig.logins.begin("h1", "openai-oauth").await.unwrap();
    assert!(!flow.forwarded);
    assert!(rig.forwarder.ports.lock().unwrap().is_empty());
    assert_eq!(flow.open_url.as_deref(), Some(MANUAL));
}

#[tokio::test(start_paused = true)]
async fn without_the_forward_the_manual_page_opens_first_and_the_pasted_address_completes_the_login() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.forwarder.refuse.store(true, Ordering::SeqCst);
    let flow = rig.logins.begin("h1", "openai-oauth").await.unwrap();
    assert!(!flow.forwarded);
    assert_eq!(flow.open_url.as_deref(), Some(MANUAL));
    let done = rig.logins.complete("h1", "f1", "  http://localhost:1455/cb?code=abc  ").await.unwrap();
    assert_eq!(done.state, SshServerLoginFlowState::Complete);
    assert_eq!(
        rig.client.calls_of("account/completeOAuthProviderLogin"),
        [json!({ "flowId": "f1", "callbackUrl": "http://localhost:1455/cb?code=abc" })]
    );
}

#[tokio::test(start_paused = true)]
async fn the_pasted_address_completes_a_forwarded_login_and_closes_its_forward() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    let done = rig.logins.complete("h1", "f1", "http://localhost:1455/cb?code=abc").await.unwrap();
    assert!(!done.forwarded);
    assert_eq!(rig.closes(), [1]);
    assert_eq!(message(rig.logins.complete("h1", "f1", "").await), "redirectUrl must be a non-empty string.");
    for bad in ["   ", "http://x/\ncb"] {
        assert_eq!(message(rig.logins.complete("h1", "f1", bad).await), "The pasted address is not valid.");
    }
    let long = format!("http://localhost/{}", "a".repeat(MAX_URL_LENGTH));
    assert_eq!(message(rig.logins.complete("h1", "f1", &long).await), "The pasted address is not valid.");
}

#[tokio::test(start_paused = true)]
async fn a_plain_verification_url_carries_the_separate_device_code_and_the_manual_completion_flag() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.client.on(|_, _| {
        Reply::Ok(json!({ "flowId": "f1", "provider": "openai-oauth", "state": "pending", "url": "https://auth.example/device",
            "userCode": "ABCD-1234", "manualCodeSupported": false }))
    });
    let flow = rig.logins.begin("h1", "openai-oauth").await.unwrap();
    assert_eq!((flow.user_code.as_deref(), flow.manual_code_supported, flow.forwarded), (Some("ABCD-1234"), Some(false), false));
    assert_eq!(flow.open_url.as_deref(), Some("https://auth.example/device"));
    // A state the server does not know is a failure; a start without a flow id is refused.
    rig.client.on(|_, _| Reply::Ok(json!({ "flowId": "f2", "state": "weird" })));
    assert_eq!(rig.logins.begin("h1", "openai-oauth").await.unwrap().state, SshServerLoginFlowState::Failed);
    rig.client.on(|_, _| Reply::Ok(json!({ "state": "pending" })));
    assert_eq!(message(rig.logins.begin("h1", "openai-oauth").await), "The server did not start a login.");
}

#[tokio::test(start_paused = true)]
async fn cancel_the_time_cap_and_dispose_all_close_the_forward() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.logins.cancel("h1", "f1").await.unwrap();
    assert_eq!((rig.closes(), rig.cancels()), (vec![1], 1));
    // A cancel of a login this PC no longer holds still reaches the server, and closes nothing twice.
    rig.logins.cancel("h1", "f1").await.unwrap();
    assert_eq!((rig.closes(), rig.cancels()), (vec![1], 2));

    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    advance(MAX_FORWARD - Duration::from_secs(1)).await;
    assert_eq!(rig.closes(), [1, 0]);
    advance(Duration::from_secs(2)).await;
    assert_eq!(rig.closes(), [1, 1]);

    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.logins.dispose().await;
    assert_eq!(rig.closes(), [1, 1, 1]);
}

#[tokio::test(start_paused = true)]
async fn a_disconnect_closes_the_forward_cancels_the_login_on_the_server_and_tells_the_dialog() {
    let rig = Rig::new(ModelLogin::Server).await;
    let mut updates = rig.logins.updates();
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.server.end.cancel();
    settle().await;
    assert_eq!((rig.closes(), rig.cancels()), (vec![1], 1));
    let (host, flow) = updates.try_recv().unwrap();
    assert_eq!((host.as_str(), flow.flow_id.as_str(), flow.state, flow.forwarded), ("h1", "f1", SshServerLoginFlowState::Cancelled, false));
}

#[tokio::test(start_paused = true)]
async fn an_unforwarded_login_is_cancelled_on_a_reachable_server_too() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.forwarder.refuse.store(true, Ordering::SeqCst);
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.logins.dispose().await;
    assert_eq!(rig.cancels(), 1);
}

// ----- the cancels the server could not take ---------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_cancel_the_connection_could_not_carry_is_sent_once_it_is_attached_again() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.client.on(refusing_cancels);
    rig.server.end.cancel();
    settle().await;
    assert_eq!(rig.cancels(), 1);
    rig.client.on(serving(CALLBACK));
    rig.attach(&rig.server);
    settle().await;
    assert_eq!(rig.cancels(), 2);
    // Taken: the next attach sends nothing.
    rig.attach(&rig.server);
    settle().await;
    assert_eq!(rig.cancels(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_cancel_the_server_did_not_take_on_replay_stays_for_the_next_attach() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.client.on(refusing_cancels);
    rig.server.end.cancel();
    settle().await;
    rig.attach(&rig.server);
    settle().await;
    assert_eq!(rig.cancels(), 2);
    rig.client.on(serving(CALLBACK));
    rig.attach(&rig.server);
    settle().await;
    assert_eq!(rig.cancels(), 3);
}

#[tokio::test(start_paused = true)]
async fn the_dialogs_own_cancel_is_bounded_and_kept_when_the_server_does_not_answer() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.client.on(|method, _| if method == CANCEL { Reply::Never } else { Reply::Ok(json!({})) });
    // The call returns once the bound passes (the paused clock moves on by itself while everything waits).
    rig.logins.cancel("h1", "f1").await.unwrap();
    assert_eq!(rig.closes(), [1]);
    rig.client.on(serving(CALLBACK));
    rig.attach(&rig.server);
    settle().await;
    assert_eq!(rig.cancels(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_cancel_while_detached_is_queued_for_the_next_attach() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.detach();
    rig.logins.cancel("h1", "f1").await.unwrap();
    assert_eq!((rig.closes(), rig.cancels()), (vec![1], 0));
    rig.attach(&rig.server);
    settle().await;
    assert_eq!(rig.cancels(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_queued_cancel_expires_with_the_server_flow() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.client.on(refusing_cancels);
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.server.end.cancel();
    settle().await;
    advance(SERVER_FLOW_LIFETIME + Duration::from_secs(1)).await;
    rig.client.on(serving(CALLBACK));
    rig.attach(&rig.server);
    settle().await;
    assert_eq!(rig.cancels(), 1);
}

#[tokio::test(start_paused = true)]
async fn the_queued_cancels_are_capped_dropping_the_oldest() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.client.on(naming_flows);
    for index in 0..(MAX_QUEUED_CANCELS + 3) {
        rig.logins.begin("h1", &format!("p{index}")).await.unwrap();
    }
    rig.server.end.cancel();
    settle().await;
    let before = rig.cancels();
    rig.client.on(|_, _| Reply::Ok(json!({})));
    rig.attach(&rig.server);
    settle().await;
    let sent: Vec<Json> = rig.client.calls_of(CANCEL).split_off(before);
    assert_eq!(sent.len(), MAX_QUEUED_CANCELS);
    assert!(!sent.contains(&json!({ "flowId": "p0" })));
    assert!(sent.contains(&json!({ "flowId": format!("p{}", MAX_QUEUED_CANCELS + 2) })));
}

#[tokio::test(start_paused = true)]
async fn a_removed_server_and_a_disposed_service_drop_the_cancels_still_waiting() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.client.on(refusing_cancels);
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.server.end.cancel();
    settle().await;
    rig.logins.forget_host("h1");
    rig.client.on(serving(CALLBACK));
    rig.attach(&rig.server);
    settle().await;
    assert_eq!(rig.cancels(), 1);

    let rig = Rig::new(ModelLogin::Server).await;
    rig.client.on(refusing_cancels);
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.logins.dispose().await;
    rig.client.on(serving(CALLBACK));
    // A disposed service no longer follows the attaches at all.
    let _ = rig.servers.attach.send("h1".into());
    settle().await;
    assert_eq!(rig.cancels(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_cancel_still_in_flight_when_its_server_is_removed_is_not_queued_when_it_fails() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.client.on(|method, _| if method == CANCEL { Reply::Never } else { Reply::Ok(json!({})) });
    rig.server.end.cancel();
    settle().await;
    // The cancel waits on the server; the server is removed meanwhile, then the wait ends.
    rig.logins.forget_host("h1");
    advance(CANCEL_TIMEOUT + Duration::from_secs(1)).await;
    rig.client.on(serving(CALLBACK));
    rig.attach(&rig.server);
    settle().await;
    assert_eq!(rig.cancels(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_stale_queued_cancel_never_ends_a_newer_login_that_reuses_the_flow_id() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.client.on(refusing_cancels);
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.server.end.cancel();
    settle().await;
    // A new login with the same flow id owns it now, on the new attachment.
    let fresh = Arc::new(FakeServer { login: Mutex::new(ModelLogin::Server), client: rig.client.clone(), end: CancellationToken::new() });
    rig.servers.attached.lock().unwrap().insert("h1".into(), fresh.clone());
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.attach(&fresh);
    settle().await;
    assert_eq!(rig.cancels(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_rejected_status_closes_the_forward_and_tells_the_server_to_drop_the_login() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.logins.begin("h1", "openai-oauth").await.unwrap();
    rig.client.on(|method, _| if method == "account/getOAuthProviderLoginStatus" { Reply::Rpc("gone") } else { Reply::Ok(json!({})) });
    assert_eq!(message(rig.logins.status("h1", "f1").await), "gone");
    settle().await;
    assert_eq!((rig.closes(), rig.cancels()), (vec![1], 1));
}

// ----- what is reached -------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn only_a_server_attached_with_its_own_logins_is_reached() {
    let rig = Rig::new(ModelLogin::Pc).await;
    let pc = "box uses this PC's accounts. Switch it to server accounts to manage its logins.";
    assert_eq!(message(rig.logins.begin("h1", "openai-oauth").await), pc);
    assert_eq!(message(rig.logins.save_key("h1", "openai", "sk-x").await), pc);
    assert_eq!(message(rig.logins.logout("h1", "openai").await), pc);
    let listed = rig.logins.list("h1").await.unwrap();
    assert_eq!((listed.connected, listed.model_login, listed.busy_sessions, listed.providers), (true, Some(SshModelLogin::Pc), Some(2), None));
    assert!(rig.client.calls.lock().unwrap().is_empty());

    rig.detach();
    assert_eq!(message(rig.logins.begin("h1", "openai-oauth").await), "Connect to box to manage its logins.");
    let listed = rig.logins.list("h1").await.unwrap();
    assert_eq!((listed.connected, listed.model_login, listed.busy_sessions, listed.providers), (false, None, None, None));
    assert_eq!(message(rig.logins.list("nope").await), "This SSH server is no longer saved.");
    assert_eq!(message(rig.logins.list("").await), "id must be a non-empty string.");
}

#[tokio::test(start_paused = true)]
async fn the_servers_own_logins_are_listed_signed_in_first_with_the_account_and_the_credential_source() {
    let rig = Rig::new(ModelLogin::Server).await;
    {
        let mut sections = rig.client.store.sections.lock().unwrap();
        sections.insert(
            ("providerSetup", None),
            json!({
                "oauth": [
                    { "id": "anthropic-oauth", "name": "Claude", "authenticated": false },
                    { "id": "openai-oauth", "name": "ChatGPT", "authenticated": true },
                    { "name": "no id" }
                ],
                "api": [
                    { "id": "openai", "authenticated": false, "env": true, "stored": false, "credentialSource": "environment" },
                    { "id": "groq", "name": "Groq", "authenticated": true, "env": true, "stored": true,
                      "credentialSource": "private-file", "detail": "stored in private file" },
                    { "id": "custom-0", "name": "Mine", "authenticated": true, "custom": true, "apiKeyEnv": "MINE_KEY", "auth": "none" },
                    { "id": "xai", "authenticated": true, "credentialSource": "something-new" }
                ],
                "keychain": { "state": "locked", "message": "Unlock it", "kind": "x".repeat(41), "path": "/home/me/.mixdog" }
            }),
        );
        sections.insert(
            ("providerAccounts", Some("openai-oauth".into())),
            json!({ "selectedId": "b", "accounts": [{ "id": "a", "email": "a@x" }, { "id": "b", "identity": "me" }] }),
        );
    }
    let listed = rig.logins.list("h1").await.unwrap();
    assert_eq!(rig.client.calls_of("account/refreshProviderSetup"), [json!({ "force": true })]);
    let rows = listed.providers.unwrap();
    let ids: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
    assert_eq!(ids, ["openai-oauth", "groq", "custom-0", "xai", "anthropic-oauth", "openai"]);
    assert_eq!(rows[0].identity.as_deref(), Some("me"));
    assert_eq!(rows[0].name, "ChatGPT");
    assert_eq!(
        (rows[1].credential_source, rows[1].stored_in_private_file, rows[1].from_environment),
        (Some(SshCredentialSource::PrivateFile), Some(true), None)
    );
    assert_eq!((rows[2].from_environment, rows[2].custom, rows[2].keyless), (Some(true), Some(true), Some(true)));
    assert_eq!(rows[3].credential_source, None);
    assert_eq!(rows[3].name, "xai");
    assert_eq!((rows[5].credential_source, rows[5].from_environment), (Some(SshCredentialSource::Environment), Some(true)));
    // A field of the keychain issue that is not bounded plain text is left out; an issue without its message is not reported.
    let issue = listed.keychain.unwrap();
    assert_eq!((issue.state.as_str(), issue.kind, issue.path.as_deref()), ("locked", None, Some("/home/me/.mixdog")));
    rig.client.store.sections.lock().unwrap().get_mut(&("providerSetup", None)).unwrap()["keychain"] =
        json!({ "state": "locked", "message": "m".repeat(401) });
    assert_eq!(rig.logins.list("h1").await.unwrap().keychain, None);
}

#[tokio::test(start_paused = true)]
async fn keys_and_logouts_go_to_the_server_and_a_custom_provider_has_its_own_operations() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.logins.save_key("h1", "openai", "  sk-1  ").await.unwrap();
    assert_eq!(rig.client.calls_of("account/saveProviderApiKey"), [json!({ "providerId": "openai", "secret": "sk-1" })]);
    let custom = "custom-0123abcd-0123-4abc-8abc-0123456789ab";
    rig.logins.save_key("h1", custom, "sk-2").await.unwrap();
    assert_eq!(rig.client.calls_of("account/saveCustomProviderKey"), [json!({ "providerId": custom, "secret": "sk-2" })]);
    rig.logins.logout("h1", "openai-oauth").await.unwrap();
    assert_eq!(rig.client.calls_of("account/forgetProviderAuth"), [json!({ "providerId": "openai-oauth" })]);
    rig.logins.remove_custom("h1", custom).await.unwrap();
    assert_eq!(rig.client.calls_of("account/removeCustomProvider"), [json!({ "providerId": custom })]);
    // Only a custom provider is removed; ids and keys are checked before anything is sent.
    assert_eq!(message(rig.logins.remove_custom("h1", "openai").await), "The provider id is not valid.");
    assert_eq!(message(rig.logins.logout("h1", "-bad").await), "The provider id is not valid.");
    assert_eq!(message(rig.logins.logout("h1", "").await), "provider must be a non-empty string.");
    assert_eq!(message(rig.logins.save_key("h1", "openai", "").await), "key must be a non-empty string.");
    for bad in ["   ", "sk\n1"] {
        assert_eq!(message(rig.logins.save_key("h1", "openai", bad).await), "The API key is not valid.");
    }
    assert_eq!(message(rig.logins.save_key("h1", "openai", &"k".repeat(MAX_KEY_LENGTH + 1)).await), "The API key is not valid.");
    assert_eq!(rig.client.calls.lock().unwrap().len(), 4);
}

#[tokio::test(start_paused = true)]
async fn a_failed_key_save_shows_the_servers_words_without_the_key_in_either_spelling() {
    let rig = Rig::new(ModelLogin::Server).await;
    rig.client.on(|_, _| Reply::Rpc("bad key sk-12\"34\\5 / sk-12\\\"34\\\\5 refused"));
    let shown = message(rig.logins.save_key("h1", "openai", "sk-12\"34\\5").await);
    assert_eq!(shown, "bad key [redacted] / [redacted] refused");
    // The server's own refusal reaches the dialog as it is.
    rig.client.on(|_, _| Reply::Rpc("a keyless provider takes no key"));
    assert_eq!(message(rig.logins.save_key("h1", "openai", "sk-1").await), "a keyless provider takes no key");
}
