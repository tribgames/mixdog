//! The boundary between a desktop window, the host's own connection and the core, over the daemon's serving path (`Running::serve_transport`
//! on a real loopback listener, the `Mixdog-Window` header on a real WebSocket handshake):
//! - the host-role methods and the test hooks the window table lists are refused to a main window and to a server window, and to
//!   no connection that names no window;
//! - a local window gets main's answers for the grant, page, config-write and file-read methods (nothing is refused to it that main is allowed);
//! - a server window is held to its own `connectionId`;
//! - `connections/endpoint` answers the host claimant only;
//! - a human-only hold declared over the host's connection pauses Computer Use (`computer` `act`) exactly as the human-only lock does,
//!   and ends with `host/humanOnly/end` or with the connection;
//! - a secret the person typed is in no frame the browser engine writes: not in a reply to the model, not in a call to the host.
//!
//! The core behind the server is the mock thread directory with the real services these cases exercise: the human-only service over the
//! real lock, the connection policy of `mixdog_connections`, and the real browser engine over its scripted host. The suite starts no
//! process and needs no bundled runtime.

use std::net::SocketAddr;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use futures::SinkExt;
use futures::StreamExt;
use mixdog_app_protocol::limits::Limits;
use mixdog_app_protocol::v1::CapabilityState;
use mixdog_app_protocol::v1::ServerCapabilities;
use mixdog_app_server::AppServer;
use mixdog_app_server::Outgoing;
use mixdog_app_server::ServerConfig;
use mixdog_app_server::VersionOrder;
use mixdog_app_server_daemon::server::Running;
use mixdog_app_server_transport::ConnectionHub;
use mixdog_app_server_transport::ConnectionOrigin;
use mixdog_app_server_transport::WindowRole as SocketRole;
use mixdog_app_server_transport::websocket::BearerAuth;
use mixdog_app_server_transport::websocket::ListenerOrigin;
use mixdog_app_server_transport::websocket::WINDOW_HEADER;
use mixdog_app_server_transport::websocket::WINDOW_ROLE_HEADER;
use mixdog_app_server_transport::websocket::WebSocketListener;
use mixdog_browser_engine::ApprovalPort;
use mixdog_browser_engine::BlobPort;
use mixdog_browser_engine::FilePort;
use mixdog_browser_engine::TakeoverPort;
use mixdog_browser_engine::actions::registry::is_action;
use mixdog_browser_engine::approval::classify::ActionPolicy;
use mixdog_browser_engine::fake::Expect;
use mixdog_browser_engine::fake::FakeHost;
use mixdog_browser_engine::fake::page_facts;
use mixdog_browser_engine::lane::mirror::Mirror;
use mixdog_browser_engine::queue::user_hold::UserHold;
use mixdog_browser_engine::runner::guard::SecretGuard;
use mixdog_browser_engine::runner::runner::BrowserEngine;
use mixdog_browser_engine::runner::runner::EnginePorts;
use mixdog_browser_engine::types::ApprovalAnswer;
use mixdog_browser_engine::types::BrowserApprovalPrompt;
use mixdog_browser_engine::types::FileFacts;
use mixdog_browser_engine::types::Remember;
use mixdog_browser_engine::types::TakeoverGuard;
use mixdog_browser_policy::url_policy::UrlPolicy;
use mixdog_connections::policy::require_host;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreHandle;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::CoreState;
use mixdog_core_api::DomainService;
use mixdog_core_api::FeedSource;
use mixdog_core_api::HostMediaSink;
use mixdog_core_api::OpIndex;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::call::WindowRole;
use mixdog_core_api::call::WindowScope;
use mixdog_core_api::domain::computer::ComputerAction;
use mixdog_core_api::domain::computer::ComputerBackend;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::computer::ComputerRequest;
use mixdog_core_api::domain::computer::ComputerStatus;
use mixdog_core_api::domain::computer::DesktopIdentity;
use mixdog_core_api::domain::computer::DisplayId;
use mixdog_core_api::domain::computer::DisplayInfo;
use mixdog_core_api::domain::computer::InputOutcome;
use mixdog_core_api::domain::computer::ScreenInput;
use mixdog_core_api::domain::media::MediaFrameSource;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::handle::RequestGuard;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId as CoreThreadId;
use mixdog_core_api::mock::MockCore;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::service::Admit;
use mixdog_core_session::session::secret_input::GatedComputerBackend;
use mixdog_core_session::session::secret_input::HumanOnlyLock;
use mixdog_core_session::session::secret_input::HumanOnlyService;
use mixdog_core_session::session::secret_input::SessionSecrets;
use mixdog_core_session::session::secret_input::TakeoverHold;
use mixdog_core_session::session::secret_input::TakeoverHolds;
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::Origin;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;
use serde_json::Value;
use serde_json::json;
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const TOKEN: &str = "boundary-token";
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// How long a frame or a state the test waits for is waited for before it says it never came.
const WAIT: Duration = Duration::from_secs(10);

/// The window methods table of the protocol: the host-role methods and the test hooks.
const WINDOW_METHODS: &str = include_str!("../../mixdog-app-protocol/src/boundary/window_methods.json");

/// No session holds a screen takeover: the lock is held by the host's declared holds only.
struct NoTakeovers;

impl TakeoverHolds for NoTakeovers {
    fn hold(&self, _: &CoreThreadId) -> TakeoverHold {
        TakeoverHold::default()
    }

    fn screen(&self) -> Option<String> {
        None
    }
}

/// `connections/endpoint` as the connections service admits it: the host claimant only (`mixdog_connections::policy`).
struct Endpoint;

#[async_trait]
impl DomainService for Endpoint {
    fn methods(&self) -> &'static [&'static str] {
        &["connections/endpoint"]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        require_host(&req.ctx, req.method.0)?;
        Ok(Reply::Value(json!({ "url": "ws://127.0.0.1:1", "token": "endpoint-token", "serverInstanceId": "instance-1" })))
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

struct Core {
    mock: MockCore,
    human_only: HumanOnlyService,
    endpoint: Endpoint,
}

impl CoreHandle for Core {
    fn threads(&self) -> &dyn ThreadDirectory {
        self.mock.threads()
    }

    fn app_feed(&self) -> Arc<dyn FeedSource> {
        self.mock.app_feed()
    }

    fn scoped_feed(&self, id: &FeedId) -> Option<Arc<dyn FeedSource>> {
        self.mock.scoped_feed(id)
    }

    fn ops(&self) -> &dyn OpIndex {
        self.mock.ops()
    }

    fn domain_for(&self, method: &str) -> Option<&dyn DomainService> {
        if self.human_only.methods().contains(&method) {
            return Some(&self.human_only);
        }
        if self.endpoint.methods().contains(&method) {
            return Some(&self.endpoint);
        }
        self.mock.domain_for(method)
    }

    fn host_media(&self) -> &dyn HostMediaSink {
        self.mock.host_media()
    }

    fn lifecycle(&self) -> watch::Receiver<CoreState> {
        self.mock.lifecycle()
    }

    fn connection_closed(&self, connection: ConnectionId) {
        self.mock.connection_closed(connection);
    }

    fn connection_opened(&self, connection: ConnectionId, origin: Origin, device: &str, kind: ConnectionKind) {
        self.mock.connection_opened(connection, origin, device, kind);
    }

    fn request_started(&self, method: &str, params: &Value) -> RequestGuard {
        self.mock.request_started(method, params)
    }
}

/// The window a connection's origin names, in the shape the core's calls carry (`server::window_scope_of`).
fn window_scope_of(origin: &ConnectionOrigin) -> Option<WindowScope> {
    let id = origin.window_id()?;
    let role = match origin.window_role()? {
        SocketRole::Main => WindowRole::Main,
        SocketRole::Server { connection_id } => WindowRole::Server { connection_id: connection_id.clone() },
    };
    Some(WindowScope { id: Arc::from(id), role })
}

fn server_config() -> ServerConfig {
    let available = || CapabilityState::Available;
    ServerConfig {
        user_agent: "boundary-test".to_owned(),
        platform_family: std::env::consts::FAMILY.to_owned(),
        platform_os: std::env::consts::OS.to_owned(),
        server_version: VERSION.to_owned(),
        server_build: "test".to_owned(),
        server_instance_id: "instance-1".to_owned(),
        defaults_separation: Default::default(),
        capabilities: ServerCapabilities {
            office: available(),
            js_skills: available(),
            browser: available(),
            computer: available(),
            voice: available(),
            remote: Default::default(),
            window_scope: 1,
        },
        native_push: Arc::new(|| false),
        limits: Limits::default(),
        version_gate: Arc::new(|_| VersionOrder::Equal),
    }
}

struct Harness {
    addr: SocketAddr,
    lock: Arc<HumanOnlyLock>,
}

impl Harness {
    async fn start() -> Self {
        let lock = Arc::new(HumanOnlyLock::new(Arc::new(NoTakeovers)));
        let core = Arc::new(Core { mock: MockCore::new(&[], MockLimits::default()), human_only: HumanOnlyService::new(lock.clone()), endpoint: Endpoint });
        let outgoing = Outgoing::new();
        let hub = ConnectionHub::new(Limits::default()).unwrap();
        let origins = hub.clone();
        let server = AppServer::new(core, outgoing.clone(), Arc::new(move |id| origins.origin_of(id)), server_config()).unwrap();
        let windows = hub.clone();
        server
            .set_window_of(Arc::new(move |id| windows.connection_origin(id).as_ref().and_then(window_scope_of)))
            .unwrap_or_else(|_| unreachable!("a server built a line above has no window source yet"));
        let listener = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), hub.clone(), BearerAuth::new(TOKEN), ListenerOrigin::Loopback).await.unwrap();
        let addr = listener.local_addr();
        let running = Running { server, hub, outgoing };
        tokio::spawn(async move { running.serve_transport(listener).await });
        Self { addr, lock }
    }

    /// A connection dialled with the given header lines, initialized with `capabilities`.
    async fn connect(&self, headers: &[(&str, &str)], capabilities: Value) -> (Client, Value) {
        let tcp = TcpStream::connect(self.addr).await.unwrap();
        let mut request = format!("ws://{}/rpc", self.addr).into_client_request().unwrap();
        request.headers_mut().insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
        for (name, value) in headers {
            request.headers_mut().append(
                tokio_tungstenite::tungstenite::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                value.parse().unwrap(),
            );
        }
        let (socket, _) = tokio_tungstenite::client_async(request, tcp).await.unwrap();
        let mut client = Client { socket, next: 1 };
        let initialized = client.call("initialize", json!({ "clientInfo": { "name": "boundary", "version": VERSION, "kind": "desktop" }, "capabilities": capabilities })).await;
        (client, initialized)
    }

    /// A connection that names no window and declares nothing: a client that is not the desktop.
    async fn plain(&self) -> Client {
        let (client, initialized) = self.connect(&[], json!({})).await;
        assert!(initialized.get("result").is_some(), "{initialized}");
        client
    }

    /// The window `id` in its main role.
    async fn main_window(&self, id: &str) -> Client {
        let (client, initialized) = self.connect(&[(WINDOW_HEADER, id)], json!({})).await;
        assert_eq!(initialized["result"]["connection"]["window"], json!(id), "{initialized}");
        client
    }

    /// The window `id`'s socket for the server connection `connection`.
    async fn server_window(&self, id: &str, connection: &str) -> Client {
        let role = format!("server:{connection}");
        let (client, initialized) = self.connect(&[(WINDOW_HEADER, id), (WINDOW_ROLE_HEADER, role.as_str())], json!({})).await;
        assert_eq!(initialized["result"]["connection"]["window"], json!(id), "{initialized}");
        client
    }

    /// The desktop's own connection: it declares the host and claims it.
    async fn host(&self) -> Client {
        let (mut client, initialized) = self.connect(&[], json!({ "host": {} })).await;
        assert!(initialized.get("result").is_some(), "{initialized}");
        let claimed = client.call("host/claim", json!({ "hostId": "h-1" })).await;
        assert!(claimed.get("result").is_some(), "{claimed}");
        client
    }

    /// Computer Use over the one lock this harness's human-only service holds, counting what reaches the helper.
    fn computer(&self) -> (GatedComputerBackend, Arc<Counting>) {
        let inner = Arc::new(Counting(AtomicUsize::new(0)));
        (GatedComputerBackend::new(inner.clone(), self.lock.clone()), inner)
    }
}

struct Client {
    socket: WebSocketStream<TcpStream>,
    next: u64,
}

impl Client {
    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.socket.send(Message::Text(json!({ "id": id, "method": method, "params": params }).to_string().into())).await.unwrap();
        let found = tokio::time::timeout(WAIT, async {
            loop {
                match self.socket.next().await.expect("the server ended the connection").expect("the socket failed") {
                    Message::Text(text) => {
                        let frame: Value = serde_json::from_str(&text.to_string()).unwrap();
                        if frame["id"] == json!(id) && frame.get("method").is_none() {
                            return frame;
                        }
                    }
                    Message::Close(_) => panic!("the server closed the connection"),
                    _ => {}
                }
            }
        })
        .await;
        found.expect("the server wrote no answer")
    }
}

/// What a call answered, apart from the frame's id.
fn answer(frame: &Value) -> (Option<&Value>, Option<&Value>) {
    (frame.get("result"), frame.get("error"))
}

fn denied(frame: &Value, method: &str) -> bool {
    frame["error"]["data"]["reason"] == json!("permissionDenied") && frame["error"]["data"]["method"] == json!(method)
}

fn window_methods() -> Vec<String> {
    let table: Value = serde_json::from_str(WINDOW_METHODS).expect("the window table is JSON");
    table["methods"].as_array().expect("the table lists methods").iter().map(|method| method.as_str().expect("a method name").to_owned()).collect()
}

/// A computer backend that counts what reaches it.
struct Counting(AtomicUsize);

#[async_trait]
impl ComputerBackend for Counting {
    async fn run(&self, _request: ComputerRequest, _cancel: CancellationToken) -> Result<Vec<ToolPart>, ComputerError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Vec::new())
    }

    fn inject(&self, _input: ScreenInput) -> Result<InputOutcome, ComputerError> {
        Err(ComputerError::Unavailable { reason: "test".into() })
    }

    fn release_input(&self) -> Result<u32, ComputerError> {
        Ok(0)
    }

    fn input_desktop(&self) -> Option<DesktopIdentity> {
        None
    }

    fn displays(&self) -> Result<Vec<DisplayInfo>, ComputerError> {
        Err(ComputerError::Unavailable { reason: "test".into() })
    }

    fn screen_source(&self, _display: DisplayId) -> Result<Box<dyn MediaFrameSource>, ComputerError> {
        Err(ComputerError::Unavailable { reason: "test".into() })
    }

    fn status(&self) -> ComputerStatus {
        ComputerStatus { active: false, observe_only: false, controller: None }
    }
}

fn request(action: ComputerAction) -> ComputerRequest {
    ComputerRequest { action, input: json!({ "action": action.wire_name() }) }
}

/// One `computer` `act` through the lock.
async fn act(gated: &GatedComputerBackend) -> Result<(), ComputerError> {
    gated.run(request(ComputerAction::Act), CancellationToken::new()).await.map(|_| ())
}

/// Whether the lock refused the call with its own code and Node's text.
fn blocked(result: &Result<(), ComputerError>) -> bool {
    matches!(result, Err(ComputerError::Failed { code, message })
        if code == "human_only_approval_pending" && message.starts_with("Computer Use is blocked while a human-only approval is pending"))
}

/// Every host-role method and test hook of the window table is refused to a main window and to a server window, and the refusal
/// reaches no service: the `host/humanOnly/begin` it lists held nothing.
#[tokio::test(flavor = "multi_thread")]
async fn the_host_role_methods_and_the_test_hooks_are_refused_to_every_window() {
    let harness = Harness::start().await;
    let listed = window_methods();
    for hook in ["dev/computer/run", "test/browserEngine/run"] {
        assert!(listed.iter().any(|method| method == hook), "{hook} is a method of the window table");
    }
    let mut main = harness.main_window("w-1").await;
    let mut server = harness.server_window("w-1", "c-9").await;
    for method in &listed {
        for (role, window) in [("main", &mut main), ("server", &mut server)] {
            let refused = window.call(method, json!({})).await;
            assert!(denied(&refused, method), "{method} to a {role} window: {refused}");
        }
    }
    let (gated, _) = harness.computer();
    assert!(act(&gated).await.is_ok(), "a refused `host/humanOnly/begin` held nothing");
}

/// The window's refusal is the window's alone: the same calls from a connection that names no window get another answer.
#[tokio::test(flavor = "multi_thread")]
async fn a_connection_that_names_no_window_is_not_given_the_window_refusal() {
    let harness = Harness::start().await;
    let mut window = harness.main_window("w-1").await;
    let mut plain = harness.plain().await;
    for method in ["host/state/set", "modelProxy/run", "process/spawn", "dev/computer/run", "test/browserEngine/run"] {
        let refused = window.call(method, json!({})).await;
        assert!(denied(&refused, method), "{method}: the window is refused: {refused}");
        let by_plain = plain.call(method, json!({})).await;
        assert_ne!(answer(&by_plain), answer(&refused), "{method}: a connection with no window was given the window's refusal: {by_plain}");
    }
}

/// The grant, page, config-write and file-read methods a window calls are answered as a connection that names no window answers
/// them: the window table refuses none of them (the refusals of grants, pages and config paths for windows are gone, as main's
/// renderer had none).
#[tokio::test(flavor = "multi_thread")]
async fn a_local_window_gets_mains_answers_for_grants_pages_config_writes_and_file_reads() {
    let harness = Harness::start().await;
    let listed = window_methods();
    let mut plain = harness.plain().await;
    let mut window = harness.main_window("w-1").await;
    let calls = [
        ("projectFs/grant/describe", json!({})),
        ("projectFs/grant/redeem", json!({})),
        ("projectFs/localPageUrl", json!({})),
        ("projectFs/localPage/origin", json!({})),
        ("projectFs/localPage/assetType", json!({})),
        ("transfer/redeemGrant", json!({})),
        ("transfer/grant/mint", json!({})),
        ("config/value/write", json!({ "opId": "op-1", "path": "desktop.notificationVolume", "value": 10 })),
        ("projectFs/readLocal", json!({ "path": "Z:\\no\\such\\file.txt" })),
        ("projectFs/statLocal", json!({ "paths": ["Z:\\no\\such\\file.txt"] })),
    ];
    for (method, params) in calls {
        assert!(!listed.iter().any(|listed| listed == method), "{method} is not a host-role method");
        let by_plain = plain.call(method, params.clone()).await;
        let by_window = window.call(method, params).await;
        assert!(!denied(&by_window, method), "{method}: the window is not refused: {by_window}");
        assert_eq!(answer(&by_window), answer(&by_plain), "{method}: the window's answer is main's");
    }
}

/// A server window is held to its own server connection: another `connectionId` is refused, its own and none are the window's.
#[tokio::test(flavor = "multi_thread")]
async fn a_server_window_is_limited_to_its_own_connection_id() {
    let harness = Harness::start().await;
    let mut server = harness.server_window("w-1", "c-9").await;
    let other = server.call("thread/list", json!({ "connectionId": "c-8" })).await;
    assert_eq!(other["error"]["data"]["reason"], json!("permissionDenied"), "{other}");
    for params in [json!({ "connectionId": "c-9" }), json!({})] {
        let own = server.call("thread/list", params).await;
        assert_ne!(own["error"]["data"]["reason"], json!("permissionDenied"), "{own}");
    }
    // A main window names any connection.
    let mut main = harness.main_window("w-2").await;
    let any = main.call("thread/list", json!({ "connectionId": "c-8" })).await;
    assert_ne!(any["error"]["data"]["reason"], json!("permissionDenied"), "{any}");
}

/// `connections/endpoint` hands the server's address and token to the host claimant only: not to a window, not to a connection that
/// declared the host but never claimed it, not to one that is neither.
#[tokio::test(flavor = "multi_thread")]
async fn connections_endpoint_answers_the_host_claimant_only() {
    let harness = Harness::start().await;
    let mut host = harness.host().await;
    let answered = host.call("connections/endpoint", json!({})).await;
    assert_eq!(answered["result"]["token"], json!("endpoint-token"), "{answered}");

    let mut main = harness.main_window("w-1").await;
    let mut server = harness.server_window("w-1", "c-9").await;
    let (mut declared, initialized) = harness.connect(&[], json!({ "host": {} })).await;
    assert!(initialized.get("result").is_some(), "{initialized}");
    let mut plain = harness.plain().await;
    for (who, client) in [("main window", &mut main), ("server window", &mut server), ("unclaimed host", &mut declared), ("plain", &mut plain)] {
        let refused = client.call("connections/endpoint", json!({})).await;
        assert!(denied(&refused, "connections/endpoint"), "{who}: {refused}");
        assert!(refused.get("result").is_none(), "{who} was handed the endpoint: {refused}");
    }
}

/// A hold the host declares over its connection for one of its human-only cards pauses `computer` `act` with the lock's text before
/// anything reaches the helper; `wait_for_user` still runs; nobody but the host ends the hold; `host/humanOnly/end` frees the screen.
#[tokio::test(flavor = "multi_thread")]
async fn computer_act_is_paused_while_a_human_only_card_is_up() {
    let harness = Harness::start().await;
    let (gated, inner) = harness.computer();
    assert!(act(&gated).await.is_ok(), "free before any card");
    assert_eq!(inner.0.load(Ordering::SeqCst), 1);

    let mut host = harness.host().await;
    let begun = host.call("host/humanOnly/begin", json!({ "label": "Allow all actions" })).await;
    let hold_id = begun["result"]["holdId"].as_str().unwrap_or_else(|| panic!("no hold: {begun}")).to_owned();

    let paused = act(&gated).await;
    assert!(blocked(&paused), "{paused:?}");
    assert!(matches!(&paused, Err(ComputerError::Failed { message, .. }) if message.ends_with("Allow all actions")), "{paused:?}");
    assert_eq!(inner.0.load(Ordering::SeqCst), 1, "nothing was sent to the helper while the card is up");
    gated.run(request(ComputerAction::WaitForUser), CancellationToken::new()).await.expect("wait_for_user sends nothing and is not held");
    assert_eq!(inner.0.load(Ordering::SeqCst), 2);

    // Neither a window nor another connection ends the hold: the first is refused, the second changes nothing.
    let mut window = harness.main_window("w-1").await;
    assert!(denied(&window.call("host/humanOnly/end", json!({ "holdId": hold_id })).await, "host/humanOnly/end"));
    let mut other = harness.plain().await;
    other.call("host/humanOnly/end", json!({ "holdId": hold_id })).await;
    assert!(blocked(&act(&gated).await), "the hold is the host's alone");

    let ended = host.call("host/humanOnly/end", json!({ "holdId": hold_id })).await;
    assert!(ended.get("result").is_some(), "{ended}");
    assert!(act(&gated).await.is_ok(), "the screen is free again");
    assert_eq!(inner.0.load(Ordering::SeqCst), 3);
}

/// A host that goes away leaves nothing held: the hold ends with its connection.
#[tokio::test(flavor = "multi_thread")]
async fn a_human_only_card_ends_with_the_connection_that_declared_it() {
    let harness = Harness::start().await;
    let (gated, _) = harness.computer();
    let mut host = harness.host().await;
    let begun = host.call("host/humanOnly/begin", json!({ "label": "Approve" })).await;
    assert!(begun["result"]["holdId"].is_string(), "{begun}");
    assert!(blocked(&act(&gated).await));
    drop(host);
    let freed = tokio::time::timeout(WAIT, async {
        loop {
            if act(&gated).await.is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(freed.is_ok(), "the hold outlived its connection");
}

/// The secret guard the core hands the engine: the session's secrets of the one registry the secret input fills.
struct Registry(Arc<SessionSecrets>);

impl SecretGuard for Registry {
    fn redact(&self, session_id: &str, text: &str) -> String {
        self.0.redact(session_id, text)
    }

    fn remember(&self, session_id: &str, secret: &str) {
        self.0.remember(session_id, secret);
    }
}

struct Allows;

#[async_trait]
impl ApprovalPort for Allows {
    async fn ask(&self, _prompt: BrowserApprovalPrompt) -> Result<ApprovalAnswer, ToolError> {
        Ok(ApprovalAnswer::Allow { remember: Remember::Once })
    }
}

struct FreeTakeover;

impl TakeoverPort for FreeTakeover {
    fn begin(&self, _session_id: &str) -> Result<TakeoverGuard, String> {
        Ok(TakeoverGuard::new(CancellationToken::new(), None))
    }
}

struct NoBlobs;

#[async_trait]
impl BlobPort for NoBlobs {
    async fn read(&self, _digest: &str) -> Result<Bytes, String> {
        Err("no blobs".to_owned())
    }
}

struct NoFiles;

#[async_trait]
impl FilePort for NoFiles {
    async fn stat(&self, _path: &Path) -> FileFacts {
        FileFacts::default()
    }

    async fn write_frame(&self, run_dir: &Path, _bytes: Bytes, _mime_type: &str) -> std::io::Result<PathBuf> {
        Ok(run_dir.to_path_buf())
    }
}

/// A secret the person typed (the registry holds it for the session) is in no frame of the browser engine: the page the host lists
/// carries it in its title, and neither the reply the model reads nor any call the engine made to the host repeats it.
#[tokio::test(flavor = "multi_thread")]
async fn a_typed_secret_is_in_no_frame_of_the_browser_engine() {
    let secret = "correct-horse-9-battery";
    let secrets = Arc::new(SessionSecrets::new());
    secrets.remember("s1", secret);

    let mut facts = page_facts("p1", 1);
    facts["title"] = json!(format!("Welcome {secret}"));
    let page = json!({ "pageId": "p1", "tabId": "v1", "sessionId": "s1", "background": false, "facts": facts });
    let host = Arc::new(FakeHost::scripted(vec![Expect::ok("host/browser/pages/list", json!({ "pages": [page], "activePageId": "p1" }))]));
    let engine = BrowserEngine::new(
        host.clone(),
        EnginePorts {
            mirror: Arc::new(Mirror::new()),
            hold: Arc::new(UserHold::new()),
            approvals: Arc::new(Allows),
            takeover: Arc::new(FreeTakeover),
            blobs: Arc::new(NoBlobs),
            files: Arc::new(NoFiles),
            secrets: Arc::new(Registry(secrets)),
            approval_policy: ActionPolicy::from_env(None, None, None, is_action),
            urls: UrlPolicy::default(),
            frame_dir: PathBuf::from("frames"),
        },
    );
    let input = serde_json::Map::new();
    let reply = engine.run(&ThreadId::from("s1"), "list_tabs", &input, &CancellationToken::new()).await.map_err(|failure| failure.error).expect("the tabs are listed");
    assert!(reply.text.contains("Welcome"), "the page is listed: {}", reply.text);
    assert!(!reply.text.contains(secret), "the reply repeats the secret: {}", reply.text);
    for call in host.calls().iter().chain(host.notifications().iter()) {
        assert!(!call.params.to_string().contains(secret), "{} carries the secret", call.method);
    }
    host.finish().expect("the one scripted call was made");
}
