//! A desktop window's socket over the daemon's own serving path (`Running::serve_transport` over a real loopback listener, the
//! `Mixdog-Window` header on a real WebSocket handshake) reaches the core as main reached it: the same answers as a connection that
//! names no window, and a refusal only where the window method table lists a host-role method.
//!
//! The core behind the server is the mock thread directory with the real services these cases exercise (`WorkspaceService` for
//! `projectFs/*Local`, `ConfigService` over a real `Config` for `config/value/write`): the composed core needs a bundled PostgreSQL
//! runtime, so its tests are `#[ignore]`d. The window of a connection is mapped from its origin the way `server::window_scope_of` does.

#![allow(clippy::disallowed_methods, reason = "test setup: writes the files the cases read")]

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

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
use mixdog_core_api::CoreHandle;
use mixdog_core_api::CoreState;
use mixdog_core_api::DomainService;
use mixdog_core_api::FeedSource;
use mixdog_core_api::HostMediaSink;
use mixdog_core_api::OpIndex;
use mixdog_core_api::ServerRequestSink;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::call::WindowRole;
use mixdog_core_api::call::WindowScope;
use mixdog_core_api::handle::RequestGuard;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::FeedId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ServerRequestId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::mock::ControlCall;
use mixdog_core_api::mock::MockCore;
use mixdog_core_api::mock::MockLimits;
use mixdog_core_api::mock::MockStatePublisher;
use mixdog_core_api::mock::MockThread;
use mixdog_core_api::server_request::PendingServerRequest;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;
use mixdog_core_config::config::ConfigService;
use mixdog_core_config::config::NoEffects;
use mixdog_core_config::config::OutputStyles;
use mixdog_core_config::config::Settings;
use mixdog_core_config::config::SettingsEnv;
use mixdog_core_config::tool_modules::EffortJudgeState;
use mixdog_core_config::tool_modules::External;
use mixdog_core_config::tool_modules::ToolModules;
use mixdog_core_config::tool_modules::ToolModulesHost;
use mixdog_protocol::ConnectionKind;
use mixdog_protocol::Origin;
use serde_json::Value;
use serde_json::json;
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const TOKEN: &str = "window-origin-token";
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// How long a frame or a state the test waits for is waited for before it says it never came.
const WAIT: Duration = Duration::from_secs(10);

/// The runtime state the tool modules read: none of it matters to a config write.
struct NoHost(watch::Sender<u64>);

#[async_trait::async_trait]
impl ToolModulesHost for NoHost {
    async fn external(&self) -> External {
        External {
            embedding_info: Value::Null,
            onnx_supported: false,
            git_available: false,
            local_provider: Value::Null,
            installation_command_error: None,
            effort_judge: EffortJudgeState { available: false, installing: false, ready: false, last_error: Value::Null, info: Value::Null },
        }
    }

    fn changes(&self) -> watch::Receiver<u64> {
        self.0.subscribe()
    }

    async fn prepare_builtin_feature(&self, _name: &str, _engines: Option<&[String]>) -> Result<(), String> {
        Ok(())
    }

    async fn stop_local_provider_server(&self) {}

    async fn sync_local_provider_registry(&self, _enabled: bool) {}

    async fn shutdown_effort_judge(&self) {}

    fn invalidate_context_status_cache(&self) {}

    fn invalidate_pre_session_tool_surface(&self) {}
}

struct Core {
    mock: MockCore,
    workspace: Arc<mixdog_workspace::service::WorkspaceService>,
    config: ConfigService,
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
        if self.workspace.methods().contains(&method) {
            return Some(self.workspace.as_ref());
        }
        if self.config.methods().contains(&method) {
            return Some(&self.config);
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
        self.workspace.connection_closed(&connection);
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
        user_agent: "window-origin-test".to_owned(),
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
    dir: tempfile::TempDir,
    addr: SocketAddr,
    core: Arc<Core>,
    outgoing: Arc<Outgoing>,
}

impl Harness {
    async fn start() -> Self {
        let tokens = mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let publisher = Arc::new(MockStatePublisher::default());
        let (config, _) = Config::open(
            root.join("mixdog-config.json"),
            publisher.clone(),
            ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io },
        )
        .await
        .unwrap();
        let tool_modules = ToolModules::new(config.clone(), Arc::new(NoHost(watch::channel(0).0)), publisher, mixdog_rt::CancellationToken::new());
        let env: SettingsEnv = Arc::new(|_| None);
        let settings = Settings::new(config.clone(), Arc::new(NoEffects), env);
        let output_styles = OutputStyles::new(config.clone(), root.join("shipped").join("output-styles"), root.join("config"));
        let config = ConfigService::new(config, tool_modules, settings, output_styles);

        let (state, _) = mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &root.join("core.sqlite")).unwrap();
        let workspace = mixdog_workspace::service::WorkspaceService::new(mixdog_workspace::service::Deps {
            lanes: mixdog_workspace::lanes::Lanes {
                interactive: tokens.interactive_io,
                durability: tokens.durability_io,
                maintenance: tokens.maintenance_io,
                cpu_bulk: tokens.cpu_bulk,
            },
            feeds: Arc::new(mixdog_core_api::mock::MockScopedFeeds::new(MockLimits::default())),
            processes: Arc::new(mixdog_core_api::domain::mock::MockProcessManager::default()),
            tracked: Arc::new(mixdog_scm::tracked::GixTrackedFiles::new(tokens.maintenance_io)),
            state,
            recovery_dir: root.join("recovery"),
            user_data_dir: root.join("userData"),
            sources: Vec::new(),
            code_graph: None,
            turn_review: None,
            releases: mixdog_workspace::release::FolderReleases::new(),
        })
        .unwrap();

        let core = Arc::new(Core { mock: MockCore::new(&[], MockLimits::default()), workspace, config });
        let outgoing = Outgoing::new();
        let hub = ConnectionHub::new(Limits::default()).unwrap();
        let origins = hub.clone();
        let server = AppServer::new(core.clone(), outgoing.clone(), Arc::new(move |id| origins.origin_of(id)), server_config()).unwrap();
        let windows = hub.clone();
        server
            .set_window_of(Arc::new(move |id| windows.connection_origin(id).as_ref().and_then(window_scope_of)))
            .unwrap_or_else(|_| unreachable!("a server built a line above has no window source yet"));
        let listener = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), hub.clone(), BearerAuth::new(TOKEN), ListenerOrigin::Loopback).await.unwrap();
        let addr = listener.local_addr();
        let running = Running { server, hub, outgoing: outgoing.clone() };
        tokio::spawn(async move { running.serve_transport(listener).await });
        Self { dir, addr, core, outgoing }
    }

    /// A connection dialled with the given header lines, initialized with `capabilities` (the answer is returned beside it).
    async fn connect(&self, headers: &[(&str, &str)], capabilities: Value) -> (Client, Value) {
        let mut client = self.dial(headers).await;
        let initialized = client.initialize(capabilities).await;
        (client, initialized)
    }

    /// A connection dialled with the given header lines, not initialized yet.
    async fn dial(&self, headers: &[(&str, &str)]) -> Client {
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
        Client { socket, next: 1 }
    }

    /// A connection that names no window: the loopback client main's own lane was.
    async fn plain(&self) -> Client {
        let (client, initialized) = self.connect(&[], json!({})).await;
        assert!(initialized.get("result").is_some(), "{initialized}");
        assert!(initialized["result"]["connection"].get("window").is_none(), "{initialized}");
        client
    }

    /// The window `id` in its main role, ready.
    async fn window(&self, id: &str, capabilities: Value) -> Client {
        let (client, initialized) = self.connect(&[(WINDOW_HEADER, id)], capabilities).await;
        assert_eq!(initialized["result"]["connection"]["window"], json!(id), "{initialized}");
        client
    }

    fn file(&self, name: &str, content: &str) -> String {
        let path = self.dir.path().join("outside").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        path.to_string_lossy().into_owned()
    }
}

struct Client {
    socket: WebSocketStream<TcpStream>,
    next: u64,
}

impl Client {
    async fn send(&mut self, frame: Value) {
        self.socket.send(Message::Text(frame.to_string().into())).await.unwrap();
    }

    /// The next frame the server wrote for which `wanted` holds; the others are passed over.
    async fn frame_where(&mut self, wanted: impl Fn(&Value) -> bool) -> Value {
        let found = tokio::time::timeout(WAIT, async {
            loop {
                match self.socket.next().await.expect("the server ended the connection").expect("the socket failed") {
                    Message::Text(text) => {
                        let frame: Value = serde_json::from_str(&text.to_string()).unwrap();
                        if wanted(&frame) {
                            return frame;
                        }
                    }
                    Message::Close(_) => panic!("the server closed the connection"),
                    _ => {}
                }
            }
        })
        .await;
        found.expect("the server wrote no such frame")
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.send(json!({ "id": id, "method": method, "params": params })).await;
        self.frame_where(|frame| frame["id"] == json!(id) && frame.get("method").is_none()).await
    }

    async fn initialize(&mut self, capabilities: Value) -> Value {
        self.call("initialize", json!({ "clientInfo": { "name": "window-origin", "version": VERSION, "kind": "desktop" }, "capabilities": capabilities })).await
    }
}

/// What a call answered, apart from the frame's id.
fn answer(frame: &Value) -> (Option<&Value>, Option<&Value>) {
    (frame.get("result"), frame.get("error"))
}

fn denied(frame: &Value, method: &str) -> bool {
    frame["error"]["data"]["reason"] == json!("permissionDenied") && frame["error"]["data"]["method"] == json!(method)
}

async fn eventually<T>(what: &str, mut read: impl FnMut() -> Option<T>) -> T {
    let found = tokio::time::timeout(WAIT, async {
        loop {
            if let Some(found) = read() {
                return found;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    found.unwrap_or_else(|_| panic!("never came: {what}"))
}

/// Every absolute path main read answers a window the same: a file outside any project, a missing path, a directory.
#[tokio::test(flavor = "multi_thread")]
async fn a_window_reads_and_stats_any_absolute_path_as_main_does() {
    let harness = Harness::start().await;
    let file = harness.file("note.txt", "outside every project");
    let missing = harness.dir.path().join("outside").join("missing.txt").to_string_lossy().into_owned();
    let folder = harness.dir.path().join("outside").to_string_lossy().into_owned();
    let mut plain = harness.plain().await;
    let mut window = harness.window("w-1", json!({})).await;

    let read_plain = plain.call("projectFs/readLocal", json!({ "path": file })).await;
    let read_window = window.call("projectFs/readLocal", json!({ "path": file })).await;
    assert!(read_plain.get("result").is_some(), "main reads the file: {read_plain}");
    assert_eq!(answer(&read_window), answer(&read_plain));
    let gone_plain = plain.call("projectFs/readLocal", json!({ "path": missing })).await;
    let gone_window = window.call("projectFs/readLocal", json!({ "path": missing })).await;
    assert_eq!(answer(&gone_window), answer(&gone_plain), "a missing file");
    let paths = json!({ "paths": [file, missing, folder] });
    let stat_plain = plain.call("projectFs/statLocal", paths.clone()).await;
    let stat_window = window.call("projectFs/statLocal", paths).await;
    assert_eq!(stat_plain["result"].as_array().map(Vec::len), Some(3), "{stat_plain}");
    assert_eq!(answer(&stat_window), answer(&stat_plain));
}

/// `config/value/write` accepts a window for the desktop-only paths a paired phone is refused, as it accepts a connection with no window.
#[tokio::test(flavor = "multi_thread")]
async fn a_window_writes_any_desktop_config_path_as_main_does() {
    let harness = Harness::start().await;
    let mut plain = harness.plain().await;
    let mut window = harness.window("w-1", json!({})).await;
    let mut op = 0;
    for (path, value) in [("desktop.notificationVolume", json!(10)), ("desktop.sessionAutoDeleteDays", json!(0)), ("desktop.keepAwake", json!(false))] {
        op += 1;
        let by_plain = plain.call("config/value/write", json!({ "opId": format!("op-{op}"), "path": path, "value": value })).await;
        op += 1;
        let by_window = window.call("config/value/write", json!({ "opId": format!("op-{op}"), "path": path, "value": value })).await;
        assert!(by_plain.get("result").is_some(), "{path}: main's write: {by_plain}");
        assert_eq!(by_window["result"]["values"], by_plain["result"]["values"], "{path}: the window's write: {by_window}");
    }
    let stored: Value = serde_json::from_slice(&std::fs::read(harness.dir.path().join("mixdog-config.json")).unwrap()).unwrap();
    assert_eq!(stored["desktop"]["notificationVolume"], json!(10));
}

fn pending(id: &str, thread: &str) -> PendingServerRequest {
    let frame = json!({ "id": id, "method": "item/tool/requestApproval", "params": { "threadId": thread } });
    PendingServerRequest {
        id: ServerRequestId(id.to_owned()),
        method: Method("item/tool/requestApproval"),
        thread: ThreadId::from(thread),
        surface: ThreadId::from(thread),
        order: 1,
        frame: Bytes::from(frame.to_string()),
    }
}

fn decisions(thread: &MockThread) -> Vec<(String, Origin, Value)> {
    thread
        .control_calls()
        .into_iter()
        .filter_map(|call| match call {
            ControlCall::Decide(decision) => Some((decision.request.0, decision.origin, decision.result)),
            _ => None,
        })
        .collect()
}

/// A local window that asks for the approvals inbox is sent the approval of any thread, as main's renderer was, and its answer is the
/// decision; once the request is resolved a second answer decides nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_window_with_the_approvals_inbox_gets_any_threads_approval_and_answers_it_once() {
    let harness = Harness::start().await;
    let first = harness.core.mock.directory().insert(ThreadId::from("t-a"));
    let second = harness.core.mock.directory().insert(ThreadId::from("t-b"));
    let mut window = harness.window("w-1", json!({ "approvalsInbox": true })).await;

    harness.outgoing.publish(pending("ap1", "t-a"));
    harness.outgoing.publish(pending("ap2", "t-b"));
    for (id, thread) in [("ap1", "t-a"), ("ap2", "t-b")] {
        let delivered = window.frame_where(|frame| frame["id"] == json!(id) && frame["method"] == json!("item/tool/requestApproval")).await;
        assert_eq!(delivered["params"]["threadId"], json!(thread));
    }

    window.send(json!({ "id": "ap1", "result": { "approved": true } })).await;
    let decided = eventually("the decision of ap1", || Some(decisions(&first)).filter(|calls| !calls.is_empty())).await;
    assert_eq!(decided, vec![("ap1".to_owned(), Origin::Local, json!({ "approved": true }))]);
    assert_eq!(decisions(&second), Vec::new(), "the other thread decided nothing");

    harness.outgoing.resolved(&ServerRequestId("ap1".to_owned()), Bytes::from(json!({ "method": "serverRequest/resolved", "params": { "requestId": "ap1" } }).to_string()));
    window.frame_where(|frame| frame["method"] == json!("serverRequest/resolved")).await;
    window.send(json!({ "id": "ap1", "result": { "approved": true } })).await;
    // The server handles one connection's frames in order: the answer to this call is behind the second answer.
    window.call("thread/list", json!({})).await;
    assert_eq!(decisions(&first).len(), 1, "a resolved request is decided once");
}

/// The host-role methods the window table lists are refused to a window and nothing else is; the refusals latch nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_window_is_refused_the_host_role_methods_only() {
    let harness = Harness::start().await;
    let mut window = harness.window("w-1", json!({})).await;
    for method in [
        "host/claim",
        "host/state/set",
        "host/humanOnly/begin",
        "host/remoteTarget/set",
        "modelProxy/run",
        "migrate/profile/adopt",
        "migrate/profile/status",
        "dev/computer/run",
        "test/browserEngine/run",
        "process/spawn",
        "connections/endpoint",
        "projectFs/localPage/revokeOwner",
    ] {
        let refused = window.call(method, json!({})).await;
        assert!(denied(&refused, method), "{method}: {refused}");
    }
    // A method the renderer reached through main is open to the window: whatever it answers, it is not the table's refusal.
    let open = window.call("thread/list", json!({})).await;
    assert_ne!(open["error"]["data"]["reason"], json!("permissionDenied"), "{open}");

    // `initialize` that claims the host or the model proxy is refused and latches nothing: the window then initializes without it.
    // The claimant is dialled uninitialized: a second `initialize` is refused as already initialized, before any window rule.
    let mut claimant = harness.dial(&[(WINDOW_HEADER, "w-2")]).await;
    for capabilities in [json!({ "host": {} }), json!({ "modelProxy": true })] {
        let refused = claimant.initialize(capabilities).await;
        assert!(denied(&refused, "initialize"), "{refused}");
    }
    let initialized = claimant.initialize(json!({ "approvalsInbox": true })).await;
    assert_eq!(initialized["result"]["connection"]["window"], json!("w-2"), "{initialized}");

    // A connection that names no window initializes as the host as it does today.
    let (_, as_host) = harness.connect(&[], json!({ "host": {} })).await;
    assert!(as_host.get("result").is_some(), "{as_host}");
    assert!(as_host["result"]["connection"].get("window").is_none(), "{as_host}");
}

/// A server window is held to its own server connection: another `connectionId` is refused, its own and none are the window's.
#[tokio::test(flavor = "multi_thread")]
async fn a_server_window_asking_for_another_connection_is_refused() {
    let harness = Harness::start().await;
    let (mut server_window, initialized) = harness.connect(&[(WINDOW_HEADER, "w-1"), (WINDOW_ROLE_HEADER, "server:c-9")], json!({})).await;
    assert_eq!(initialized["result"]["connection"]["window"], json!("w-1"), "{initialized}");
    let other = server_window.call("thread/list", json!({ "connectionId": "c-8" })).await;
    assert_eq!(other["error"]["data"]["reason"], json!("permissionDenied"), "{other}");
    for params in [json!({ "connectionId": "c-9" }), json!({})] {
        let own = server_window.call("thread/list", params).await;
        assert_ne!(own["error"]["data"]["reason"], json!("permissionDenied"), "{own}");
    }
}
