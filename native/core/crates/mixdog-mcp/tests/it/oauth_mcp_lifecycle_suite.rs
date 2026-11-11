//! The credential and listener lifecycle of the MCP connector sign-in, replayed against Node's.
//! `native/core/fixtures/oauth-mcp-lifecycle/golden.json` records, from the real Node client signing in to a scripted
//! loopback MCP + authorization server (`benchmarks/rust-core/recorders/record-oauth-mcp-lifecycle.mjs`), for each
//! case: the credential store before and after and the order of its writes, every request the servers saw, the
//! caller's outcome, the events of the listener's lifecycle and what a browser request gets at each point. The same
//! scripted server and the same actions are replayed here through the explicit sign-in flow.
//!
//! Compared exactly: the store (every entry) before and after, the write/delete order, the server-seen requests, the
//! outcome class, the pages, the lifecycle events in order and the sockets' ends. Equivalent representations that are
//! normalized (each stated where it happens):
//! - a switch that resolves hands its sign-in to the caller in Node, which stores it; the Rust flow commits it itself, so
//!   the store after such a case is compared with the resolved value instead of with the untouched store;
//! - the relative order of `listener.closeAllConnections` and the caller settling differs only by microtask order in Node
//!   (login vs switch) and is not asserted;
//! - a client-side socket's `close` event is observed by the test's own event loop; it is required to come after
//!   `listener.closeAllConnections`, not at a position relative to the caller settling.
//! The login deadline (Node's real timer) is fired by the test's controlled deadline at the point the recorder holds all
//! other progress at a gate, and the 1 s flush bound is fired by hand, as the recorder fires its virtual timer.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::io::ErrorKind;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginFlow;
use mixdog_core_api::domain::login::LoginInput;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_mcp::McpHub;
use mixdog_mcp::McpIo;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::config::InlineSecret;
use mixdog_mcp::config::StaticClient;
use mixdog_mcp::oauth::AccountMode;
use mixdog_mcp::oauth::OAuthEnv;
use mixdog_mcp::oauth::SecretStore;
use mixdog_mcp::oauth::callback::seam;
use mixdog_mcp::result::OutputPolicy;
use mixdog_secrets::SecretError;
use serde_json::Value;
use serde_json::json;
use sha1::Digest;
use sha1::Sha1;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::oauth_suite::form;
use super::oauth_suite::read_request;
use super::oauth_suite::respond;

const GOLDEN: &str = include_str!("../../../../fixtures/oauth-mcp-lifecycle/golden.json");
const SEED_TOKEN: &str = "fixture-token";
const MAIN_TOKEN: &str = "fixture-token-2";

/// The recorder's `memoryStore`: the values by account and the order of the writes and deletions.
#[derive(Default)]
struct Spy {
    values: Mutex<HashMap<String, String>>,
    ops: Mutex<Vec<&'static str>>,
}

#[async_trait::async_trait]
impl SecretStore for Spy {
    async fn get(&self, account: &str) -> Result<Option<String>, SecretError> {
        Ok(self.values.lock().unwrap().get(account).cloned())
    }
    async fn set(&self, account: &str, value: &str) -> Result<(), SecretError> {
        self.values.lock().unwrap().insert(account.to_owned(), value.to_owned());
        self.ops.lock().unwrap().push("set");
        Ok(())
    }
    async fn delete(&self, account: &str) -> Result<(), SecretError> {
        self.values.lock().unwrap().remove(account);
        self.ops.lock().unwrap().push("delete");
        Ok(())
    }
}

/// A request that waits for the test to release it; `arrived` and `closed` are the server's own signals (the request
/// reached it, its socket closed).
#[derive(Default)]
struct Hold {
    armed: AtomicBool,
    used: AtomicBool,
    arrived: Notify,
    closed: Notify,
    gate: Notify,
}

impl Hold {
    /// Waits at the gate; `false` when the client dropped the request instead.
    async fn wait(&self, stream: &mut TcpStream) -> bool {
        if !self.armed.load(Ordering::SeqCst) || self.used.swap(true, Ordering::SeqCst) {
            return true;
        }
        self.arrived.notify_one();
        let mut probe = [0u8; 1];
        tokio::select! {
            () = self.gate.notified() => true,
            _ = stream.read(&mut probe) => {
                self.closed.notify_one();
                false
            }
        }
    }
}

/// The MCP server that is also its authorization server, as the recorder's `fixture()`.
struct Fixture {
    base: String,
    seed: AtomicBool,
    script: Mutex<VecDeque<Value>>,
    log: Mutex<Vec<String>>,
    discovery: Hold,
    register: Hold,
    token: Hold,
    /// The hub's own background connect reached the server (it is not part of a case).
    connected: Notify,
}

impl Fixture {
    fn log(&self, line: String) {
        self.log.lock().unwrap().push(line);
    }
}

async fn serve(listener: TcpListener, fixture: Arc<Fixture>) {
    loop {
        let (mut stream, _) = listener.accept().await.unwrap();
        let fixture = Arc::clone(&fixture);
        tokio::spawn(async move {
            let (method, target, headers, body) = read_request(&mut stream).await;
            let path = target.split('?').next().unwrap().to_owned();
            let base = fixture.base.clone();
            let json_header = [("content-type", "application/json".to_owned())];
            if path.starts_with("/.well-known/oauth-protected-resource") {
                fixture.log(format!("{method} {path}"));
                if !fixture.discovery.wait(&mut stream).await {
                    return;
                }
                let doc = json!({"resource": format!("{base}/mcp"), "authorization_servers": [base]});
                respond(&mut stream, "200 OK", &json_header, &doc.to_string()).await;
            } else if path.starts_with("/.well-known/") {
                fixture.log(format!("{method} {path}"));
                let doc = json!({
                    "issuer": base,
                    "authorization_endpoint": format!("{base}/authorize"),
                    "token_endpoint": format!("{base}/token"),
                    "registration_endpoint": format!("{base}/register"),
                    "response_types_supported": ["code"],
                    "grant_types_supported": ["authorization_code", "refresh_token"],
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": ["none"],
                });
                respond(&mut stream, "200 OK", &json_header, &doc.to_string()).await;
            } else if path == "/register" {
                fixture.log("POST /register".to_owned());
                if !fixture.register.wait(&mut stream).await {
                    return;
                }
                let mut doc: Value = serde_json::from_str(&body).unwrap();
                doc["client_id"] = json!("fixture-client");
                respond(&mut stream, "201 Created", &json_header, &doc.to_string()).await;
            } else if path == "/token" {
                let form = form(&body);
                fixture.log(format!("POST /token {} client={}", form["grant_type"], form.get("client_id").map_or("null", String::as_str)));
                let entry = fixture.script.lock().unwrap().pop_front().unwrap_or_else(|| json!("ok"));
                if entry == "gate" && !fixture.token.wait(&mut stream).await {
                    return;
                }
                match &entry {
                    Value::String(kind) if kind == "network" => return,
                    Value::String(kind) if kind == "html" => {
                        return respond(&mut stream, "500 Internal Server Error", &[("content-type", "text/html".to_owned())], "<html>oops</html>").await;
                    }
                    Value::String(kind) if kind == "server_error" => {
                        return respond(&mut stream, "500 Internal Server Error", &json_header, &json!({"error": "server_error"}).to_string()).await;
                    }
                    Value::Object(object) => {
                        return respond(&mut stream, "400 Bad Request", &json_header, &json!({"error": object["error"]}).to_string()).await;
                    }
                    _ => {}
                }
                let seed = fixture.seed.load(Ordering::SeqCst);
                let grant = json!({
                    "access_token": if seed { SEED_TOKEN } else { MAIN_TOKEN },
                    "refresh_token": if seed { "fixture-refresh" } else { "fixture-refresh-2" },
                    "token_type": "Bearer",
                    "expires_in": 3600,
                });
                respond(&mut stream, "200 OK", &json_header, &grant.to_string()).await;
            } else if path == "/mcp" {
                let bearer = headers.get("authorization").and_then(|v| v.strip_prefix("Bearer ")).unwrap_or("-").to_owned();
                let shown = if bearer == SEED_TOKEN || bearer == MAIN_TOKEN || bearer == "-" { bearer.as_str() } else { "other" };
                fixture.log(format!("{method} /mcp bearer={shown}"));
                if method == "POST" {
                    fixture.connected.notify_one();
                }
                let accepted = if fixture.seed.load(Ordering::SeqCst) { SEED_TOKEN } else { MAIN_TOKEN };
                if bearer == accepted {
                    return respond(&mut stream, "405 Method Not Allowed", &[], "").await;
                }
                let hint = format!("Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource\"");
                respond(&mut stream, "401 Unauthorized", &[("www-authenticate", hint)], "").await;
            } else {
                respond(&mut stream, "404 Not Found", &[], "").await;
            }
        });
    }
}

/// One raw request and everything the listener answers; `Err` when it does not accept.
async fn exchange(port: u16, request: &str) -> Result<Vec<u8>, ErrorKind> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(|error| error.kind())?;
    stream.write_all(request.as_bytes()).await.map_err(|error| error.kind())?;
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.map_err(|error| error.kind())?;
    Ok(answer)
}

/// The recorder's `page()`: the status line and a digest of the body, or how the connection ended.
fn page(got: Result<Vec<u8>, ErrorKind>) -> Value {
    match got {
        Err(ErrorKind::ConnectionRefused) => json!({"connection": "ECONNREFUSED"}),
        Err(kind) => panic!("unexpected {kind:?}"),
        Ok(bytes) if bytes.is_empty() => json!({"connection": "closed without an answer"}),
        Ok(bytes) => {
            let split = bytes.windows(4).position(|w| w == b"\r\n\r\n").expect("a complete head");
            let head = String::from_utf8(bytes[..split].to_vec()).unwrap();
            let digest: String = Sha1::digest(&bytes[split + 4..]).iter().map(|b| format!("{b:02x}")).collect();
            json!({"statusLine": head.lines().next().unwrap(), "bodySha1": &digest[..12]})
        }
    }
}

#[derive(Clone)]
struct Callback {
    host: String,
    port: u16,
    path: String,
    state: String,
}

impl Callback {
    fn request(&self, target: &str) -> String {
        format!("GET {target} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\n\r\n", self.host, self.port)
    }

    fn good(&self) -> String {
        self.request(&format!("{}?code=fixture-code&state={}", self.path, self.state))
    }

    async fn probe(&self, target: &str) -> Value {
        page(exchange(self.port, &self.request(target)).await)
    }
}

fn callback_of(url: &str) -> Callback {
    let authorize = url::Url::parse(url).unwrap();
    let query: HashMap<String, String> = authorize.query_pairs().into_owned().collect();
    let redirect = url::Url::parse(&query["redirect_uri"]).unwrap();
    Callback {
        host: redirect.host_str().unwrap().to_owned(),
        port: redirect.port().unwrap(),
        path: redirect.path().to_owned(),
        state: query["state"].clone(),
    }
}

/// The recorder's `snapshot()`: every stored entry, the revision and the ports normalized.
fn snapshot(spy: &Spy, origin: &str, ports: &[u16]) -> Value {
    let values = spy.values.lock().unwrap();
    let mut keys: Vec<&String> = values.keys().collect();
    keys.sort();
    let mut out = serde_json::Map::new();
    for (index, key) in keys.into_iter().enumerate() {
        let mut doc: Value = serde_json::from_str(&values[key]).unwrap();
        if doc.get("revision").is_some() {
            doc["revision"] = json!("<revision>");
        }
        let mut text = doc.to_string().replace(origin, "<origin>");
        for port in ports {
            text = text.replace(&format!("127.0.0.1:{port}"), "127.0.0.1:<callback>");
        }
        out.insert(format!("entry{}", index + 1), serde_json::from_str(&text).unwrap());
    }
    Value::Object(out)
}

struct Seen {
    callback: Option<Callback>,
    held: Option<JoinHandle<Result<Vec<u8>, ErrorKind>>>,
    denied: Option<Value>,
}

struct Sockets(Vec<(&'static str, JoinHandle<String>)>);

/// A request to the MCP endpoint with the stored access token, as the SDK client makes it: the whole answer.
async fn mcp_request(origin_port: u16, spy: &Spy) -> String {
    let token = spy
        .values
        .lock()
        .unwrap()
        .values()
        .next()
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .and_then(|doc| doc["tokens"]["access_token"].as_str().map(str::to_owned));
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let request = format!("GET /mcp HTTP/1.1\r\nHost: 127.0.0.1:{origin_port}\r\n{auth}Connection: close\r\n\r\n");
    String::from_utf8_lossy(&exchange(origin_port, &request).await.unwrap()).into_owned()
}

async fn status_of(origin_port: u16, spy: &Spy) -> u16 {
    mcp_request(origin_port, spy).await.split(' ').nth(1).unwrap().parse().unwrap()
}

/// The `WWW-Authenticate` challenge the MCP server answers an unauthorized request with.
async fn challenge_of(origin_port: u16, spy: &Spy) -> String {
    let answer = mcp_request(origin_port, spy).await;
    answer
        .lines()
        .find_map(|line| line.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("www-authenticate")).map(|(_, v)| v.trim().to_owned()))
        .unwrap_or_default()
}

fn events_now() -> Vec<String> {
    seam::EVENTS.lock().unwrap().iter().map(|e| (*e).to_owned()).collect()
}

/// The events in the order Node's recorder lists them, with the two normalizations the module states.
fn lifecycle(events: &[String]) -> Vec<String> {
    let mut out: Vec<String> = events.iter().filter(|e| !e.ends_with("-socket-closed")).cloned().collect();
    for index in 1..out.len() {
        if out[index - 1] == "caller-settled" && out[index] == "listener.closeAllConnections" {
            out.swap(index - 1, index);
        }
    }
    out
}

struct Stage {
    hub: Arc<McpHub>,
    fixture: Arc<Fixture>,
    spy: Arc<Spy>,
    origin_port: u16,
    name: &'static str,
    _dir: tempfile::TempDir,
    _server: JoinHandle<()>,
}

async fn stage(client: &str) -> Stage {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin_port = listener.local_addr().unwrap().port();
    let fixture = Arc::new(Fixture {
        base: format!("http://127.0.0.1:{origin_port}"),
        seed: AtomicBool::new(true),
        script: Mutex::new(VecDeque::new()),
        log: Mutex::new(Vec::new()),
        discovery: Hold::default(),
        register: Hold::default(),
        token: Hold::default(),
        connected: Notify::new(),
    });
    fixture.token.armed.store(true, Ordering::SeqCst);
    let server = tokio::spawn(serve(listener, Arc::clone(&fixture)));
    let spy = Arc::new(Spy::default());
    let tokens = mixdog_rt::testing::tokens();
    let io = McpIo { spawn: tokens.spawn_io, durability: tokens.durability_io };
    let dir = tempfile::tempdir().unwrap();
    let hub = McpHub::new(io, dir.path().join("artifacts"), OutputPolicy::default());
    hub.set_oauth_env(OAuthEnv { store: Arc::clone(&spy) as Arc<dyn SecretStore>, plugin_data: dir.path().to_path_buf(), io: io.durability });
    let name = "Fixture";
    let mut config = McpServerConfig::from_entry(name, &json!({"url": format!("http://127.0.0.1:{origin_port}/mcp")}), &Default::default()).unwrap();
    if client == "static" {
        config.oauth.as_mut().unwrap().client = Some(StaticClient {
            client_id: "static-client".to_owned(),
            secret_account: "scoped-client-secret".to_owned(),
            inline_secret: Some(InlineSecret("static-secret".to_owned())),
            scopes: Vec::new(),
            auth_params: BTreeMap::new(),
        });
    }
    hub.apply(vec![config]);
    tokio::time::timeout(Duration::from_secs(30), fixture.connected.notified()).await.expect("the hub connected");
    Stage { hub, fixture, spy, origin_port, name, _dir: dir, _server: server }
}

/// What a case watches while the flow runs: the browser step (the callback delivered as the case says), and the state
/// that ended it.
struct Run {
    session: Arc<dyn LoginSession>,
    seen: Arc<tokio::sync::watch::Sender<Seen>>,
    settled: Arc<AtomicBool>,
    ended: tokio::sync::oneshot::Receiver<LoginState>,
}

fn run_flow(session: Box<dyn LoginSession>, browser: &'static str) -> Run {
    let session: Arc<dyn LoginSession> = Arc::from(session);
    let (seen, _) = tokio::sync::watch::channel(Seen { callback: None, held: None, denied: None });
    let seen = Arc::new(seen);
    let settled = Arc::new(AtomicBool::new(false));
    let (done, ended) = tokio::sync::oneshot::channel();
    let (driver, seen_in, settled_in) = (Arc::clone(&session), Arc::clone(&seen), Arc::clone(&settled));
    tokio::spawn(async move {
        loop {
            match driver.next().await {
                Some(LoginState::Authorize { url, .. }) => {
                    let callback = callback_of(&url);
                    seam::event("browser-opened");
                    let (held, denied) = match browser {
                        "code" => (Some(tokio::spawn({ let (port, request) = (callback.port, callback.good()); async move { exchange(port, &request).await } })), None),
                        "empty-code" => {
                            let request = callback.request(&format!("{}?code=&state={}", callback.path, callback.state));
                            let port = callback.port;
                            (Some(tokio::spawn(async move { exchange(port, &request).await })), None)
                        }
                        "denied" => {
                            let request = callback.request(&format!("{}?error=access_denied&state={}", callback.path, callback.state));
                            (None, Some(page(exchange(callback.port, &request).await)))
                        }
                        _ => (None, None),
                    };
                    seen_in.send_modify(|s| {
                        s.callback = Some(callback);
                        s.held = held;
                        s.denied = denied;
                    });
                }
                Some(state) if state.is_terminal() => {
                    seam::event("caller-settled");
                    settled_in.store(true, Ordering::SeqCst);
                    let _ = done.send(state);
                    return;
                }
                Some(_) => {}
                None => {
                    let _ = done.send(driver.state());
                    return;
                }
            }
        }
    });
    Run { session, seen, settled, ended }
}

async fn authorized(run: &Run) -> Callback {
    let mut rx = run.seen.subscribe();
    let ready = rx.wait_for(|s| s.callback.is_some()).await.unwrap();
    ready.callback.clone().unwrap()
}

fn open_sockets(port: u16, partial: bool) -> Sockets {
    let mut out = Vec::new();
    for kind in ["idle", "partial"] {
        if kind == "partial" && !partial {
            continue;
        }
        out.push((
            kind,
            tokio::spawn(async move {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                if kind == "partial" {
                    stream.write_all(b"GET /oauth/callback?code=fix").await.unwrap();
                }
                let mut rest = Vec::new();
                let closed = match stream.read_to_end(&mut rest).await {
                    Ok(_) => "closed".to_owned(),
                    Err(error) if error.kind() == ErrorKind::ConnectionReset => "error ECONNRESET".to_owned(),
                    Err(error) => format!("error {:?}", error.kind()),
                };
                seam::event(if kind == "idle" { "idle-socket-closed" } else { "partial-socket-closed" });
                closed
            }),
        ));
    }
    Sockets(out)
}

fn arm(spec: &Value) {
    seam::HOLD_NEXT_PAGE.store(!spec["hook"].is_null(), Ordering::SeqCst);
}

async fn seed(stage: &Stage, client: &str) -> u16 {
    stage.fixture.seed.store(true, Ordering::SeqCst);
    stage.fixture.script.lock().unwrap().push_back(json!("ok"));
    let challenge = challenge_of(stage.origin_port, &stage.spy).await;
    let flow = stage.hub.login_flow(stage.name, AccountMode::Connect).unwrap().with_challenge(Some(&challenge));
    let run = run_flow(flow.start().await.unwrap(), "code");
    let callback = authorized(&run).await;
    let end = tokio::time::timeout(Duration::from_secs(30), run.ended).await.unwrap().unwrap();
    assert!(matches!(end, LoginState::Done { .. }), "{client}: the seed sign-in ended with {end:?}");
    callback.port
}

/// The cases by the prefix of their title: each group is its own test (the seams are process-wide, so a test replays its
/// cases one after the other, holding `crate::oauth_seams` against the other tests of the process) and `every_case_belongs_to_a_group` keeps the groups equal to the whole recording.
const GROUPS: [&[&str]; 8] = [
    &["exchange invalid_client", "exchange unauthorized_client"],
    &["exchange invalid_grant"],
    &["exchange invalid_scope", "exchange network"],
    &["refresh invalid_"],
    &["refresh unauthorized_client", "refresh network", "refresh server_error", "refresh unknown_code", "refresh html_500"],
    &["denied before", "empty code", "sockets", "flush bound", "successful switch"],
    &["cancel while"],
    &["timeout while"],
];

async fn replay_group(group: usize) {
    let _seams = crate::oauth_seams().await;
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let mut failures = Vec::new();
    let mut replayed = 0;
    for case in golden["cases"].as_array().unwrap() {
        let title = case["title"].as_str().unwrap();
        if !GROUPS[group].iter().any(|prefix| title.starts_with(prefix)) {
            continue;
        }
        replayed += 1;
        let outcome = match tokio::time::timeout(Duration::from_secs(40), tokio::spawn(replay(case.clone()))).await {
            Ok(joined) => joined,
            Err(_) => {
                failures.push(format!("{title}: hung"));
                continue;
            }
        };
        if let Err(error) = outcome {
            let message = error.into_panic();
            let text = message.downcast_ref::<String>().cloned().or_else(|| message.downcast_ref::<&str>().map(|s| (*s).to_owned())).unwrap_or_default();
            failures.push(format!("{title}: {text}"));
        }
    }
    assert!(replayed > 0);
    assert!(failures.is_empty(), "{} of {replayed} cases differ from Node:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn every_case_belongs_to_a_group() {
    mixdog_rt::testing::assert_chunks_registered(GROUP_TESTS, GROUPS.len(), 1);
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let title = case["title"].as_str().unwrap();
        let owners = GROUPS.iter().filter(|group| group.iter().any(|prefix| title.starts_with(prefix))).count();
        assert_eq!(owners, 1, "{title} belongs to {owners} groups");
    }
}

mixdog_rt::replay_chunks!(GROUP_TESTS, #[tokio::test(flavor = "multi_thread")] async replay_group; [
    exchange_invalid_client_equals_nodes = 0,
    exchange_invalid_grant_equals_nodes = 1,
    exchange_other_errors_equal_nodes = 2,
    refresh_refused_equals_nodes = 3,
    refresh_falling_through_equals_nodes = 4,
    denial_sockets_and_flush_equal_nodes = 5,
    cancel_equals_nodes = 6,
    timeout_equals_nodes = 7,
]);
async fn replay(case: Value) {
    seam::take_control();
    let title = case["title"].as_str().unwrap().to_owned();
    let spec = &case["spec"];
    let client = spec["client"].as_str().unwrap();
    let switch = spec["mode"] == "switch";
    let stage = stage(client).await;
    let mut ports = Vec::new();
    if spec["seed"] == true {
        ports.push(seed(&stage, client).await);
        stage.spy.ops.lock().unwrap().clear();
    }
    let origin = stage.fixture.base.clone();
    assert_eq!(snapshot(&stage.spy, &origin, &ports), case["storeBefore"], "{title}: the store before");

    // ---- the case ----
    stage.fixture.seed.store(false, Ordering::SeqCst);
    *stage.fixture.script.lock().unwrap() = spec["script"].as_array().unwrap().iter().cloned().collect();
    stage.fixture.log.lock().unwrap().clear();
    for (name, hold) in [("discovery", &stage.fixture.discovery), ("register", &stage.fixture.register)] {
        hold.armed.store(spec["hold"] == name, Ordering::SeqCst);
    }
    seam::EVENTS.lock().unwrap().clear();
    let seen_held = seam::PAGE_HELD.count();
    let reads_before = seam::READS.count();
    let connections_before = seam::CONNECTIONS.count();
    arm(spec);

    let browser: &'static str = match spec["browser"].as_str().unwrap() {
        "code" => "code",
        "empty-code" => "empty-code",
        "denied" => "denied",
        _ => "wait",
    };
    let flow = if switch {
        stage.hub.oauth(stage.name).unwrap().login_flow_beside(stage.name, AccountMode::Switch)
    } else {
        let challenge = challenge_of(stage.origin_port, &stage.spy).await;
        stage.hub.login_flow(stage.name, AccountMode::Connect).unwrap().with_challenge(Some(&challenge))
    };
    let run = run_flow(flow.start().await.unwrap(), browser);

    // The point the case acts at, from the server's and the client's own signals.
    let at = spec["at"].as_str();
    let mut callback: Option<Callback> = None;
    let mut sockets = Sockets(Vec::new());
    if spec["sockets"] == true {
        let cb = authorized(&run).await;
        sockets = open_sockets(cb.port, true);
        let wanted = 2 + usize::from(browser == "code");
        seam::CONNECTIONS.after(connections_before + wanted - 1).await;
        // The half-sent request has reached the listener, so that destroying the connection is a plain close.
        seam::READS.after(reads_before + usize::from(browser == "code")).await;
        callback = Some(cb);
    }
    match at {
        Some("waiting") => callback = Some(authorized(&run).await),
        Some("exchange") => stage.fixture.token.arrived.notified().await,
        Some("discovery") => stage.fixture.discovery.arrived.notified().await,
        Some("register") => stage.fixture.register.arrived.notified().await,
        _ => {}
    }
    let gated_target = || Callback {
        host: "127.0.0.1".to_owned(),
        port: seam::LISTENER_PORT.load(Ordering::SeqCst),
        path: "/oauth/callback".to_owned(),
        state: "unknown".to_owned(),
    };
    let mut notes = serde_json::Map::new();
    if matches!(at, Some("discovery" | "register")) {
        callback = Some(gated_target());
        if case.get("atGate").is_some() {
            notes.insert("atGate".to_owned(), callback.as_ref().unwrap().probe(&format!("{}?code=fixture-code&state={}", "/oauth/callback", "unknown")).await);
        }
    }

    if (!spec["virtualFlush"].is_null() || !spec["hook"].is_null()) && matches!(at, None | Some("flush")) {
        // The page's end is held back: requests land between the outcome and the close of the listener.
        seam::PAGE_HELD.after(seen_held).await;
        let cb = authorized(&run).await;
        if case.get("duringFlush").is_some() {
            notes.insert(
                "duringFlush".to_owned(),
                json!([
                    cb.probe(&format!("/oauth/callback?code=fixture-code&state={}", cb.state)).await,
                    cb.probe("/wrong").await
                ]),
            );
        }
        if case.get("callerSettledDuringFlush").is_some() {
            notes.insert("callerSettledDuringFlush".to_owned(), json!(run.settled.load(Ordering::SeqCst)));
        }
        if spec["virtualFlush"] == "tick" {
            seam::CLOCK.advance(1000);
        } else {
            seam::PAGE_RELEASE.fire();
        }
    }
    let url_of = |cb: &Callback| format!("http://{}:{}{}?code=fixture-code&state={}", cb.host, cb.port, cb.path, cb.state);
    match spec["action"].as_str() {
        Some("cancel") => {
            seam::event("abort-requested");
            run.session.cancel();
        }
        Some("timeout") => seam::DEADLINE.fire(),
        Some("paste") => {
            seam::event("paste");
            run.session.provide(LoginInput::AuthorizationCode(url_of(callback.as_ref().expect("a callback to paste")))).await.unwrap();
        }
        _ => {}
    }
    // A cancel during a delayed failure page: the caller settles first, the page ends afterwards.
    if spec["action"] == "cancel" && !spec["hook"].is_null() && at == Some("exchange") {
        seam::PAGE_HELD.after(seen_held).await;
        while !run.settled.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
        seam::PAGE_RELEASE.fire();
    }

    let mut ended = tokio::time::timeout(Duration::from_secs(30), run.ended).await.expect("the flow ended").unwrap();
    let settled_without_release = run.settled.load(Ordering::SeqCst);
    // The main-line retry of the request that started the sign-in, as the SDK client makes it.
    let mut outcome_status = None;
    if !switch && matches!(ended, LoginState::Done { .. }) {
        outcome_status = Some(status_of(stage.origin_port, &stage.spy).await);
    }
    // The gate is released only now: the case observes what happened without it.
    let held_hold = match at {
        Some("exchange") => Some(&stage.fixture.token),
        Some("discovery") => Some(&stage.fixture.discovery),
        Some("register") => Some(&stage.fixture.register),
        _ => None,
    };
    let server_saw_close = match held_hold {
        Some(hold) => json!(tokio::time::timeout(Duration::from_secs(3), hold.closed.notified()).await.is_ok()),
        None => Value::Null,
    };
    // What the listener did while the case ran; releasing a page the case leaves held must not add to it. With
    // sockets open, their ends (which follow the listener destroying them) are the signal that it is over.
    let mut lifecycle_events = events_now();
    for hold in [&stage.fixture.token, &stage.fixture.discovery, &stage.fixture.register] {
        hold.gate.notify_one();
    }
    seam::PAGE_RELEASE.fire();
    let mut socket_results = Vec::new();
    for (kind, handle) in sockets.0 {
        let closed = tokio::time::timeout(Duration::from_secs(10), handle).await.expect("the socket ended").unwrap();
        socket_results.push(json!({"kind": kind, "closed": closed}));
    }
    if !socket_results.is_empty() {
        lifecycle_events = events_now();
    }
    let held_answer = {
        let held = run.seen.send_replace(Seen { callback: None, held: None, denied: None });
        let denied = held.denied;
        (held.held, denied)
    };
    let held_page = match held_answer.0 {
        Some(handle) => page(tokio::time::timeout(Duration::from_secs(5), handle).await.expect("the held page ended").unwrap()),
        None => Value::Null,
    };
    let denied_page = held_answer.1.unwrap_or(Value::Null);
    let target = callback.clone().unwrap_or_else(gated_target);
    let afterwards = target.probe(&format!("{}?code=fixture-code&state={}", target.path, target.state)).await;
    if let Some(cb) = &callback {
        if !ports.contains(&cb.port) {
            ports.push(cb.port);
        }
    }
    ports.push(seam::LISTENER_PORT.load(Ordering::SeqCst));

    // ---- compare ----
    let events = events_now();
    if let Some(close) = events.iter().position(|e| e == "listener.closeAllConnections") {
        for (index, event) in events.iter().enumerate() {
            assert!(!event.ends_with("-socket-closed") || index > close, "{title}: a socket closed before the listener destroyed it: {events:?}");
        }
    }
    assert_eq!(lifecycle(&lifecycle_events), lifecycle(&case["events"].as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_owned()).collect::<Vec<_>>()), "{title}: listener lifecycle");
    assert_eq!(json!(stage.fixture.log.lock().unwrap().clone()), case["requests"], "{title}: requests the servers saw");
    assert_eq!(json!(settled_without_release), case["settledWithoutRelease"], "{title}: settled before the gate was released");
    assert_eq!(server_saw_close, case["serverSawClose"], "{title}: the server saw its socket close");
    assert_eq!(held_page, case["heldPage"], "{title}: the held page");
    assert_eq!(denied_page, case["deniedPage"], "{title}: the denied page");
    assert_eq!(json!(socket_results), case["sockets"], "{title}: sockets");
    assert_eq!(afterwards, case["afterwards"], "{title}: a late request");
    for key in ["atGate", "duringFlush", "callerSettledDuringFlush"] {
        assert_eq!(notes.get(key), case.get(key), "{title}: {key}");
    }

    // The caller's outcome and the store.
    let outcome = &case["outcome"];
    let resolved = outcome["kind"] == "resolved";
    match outcome["kind"].as_str().unwrap() {
        "response" => {
            assert!(matches!(ended, LoginState::Done { .. }), "{title}: Node signed in, got {ended:?}");
            assert_eq!(outcome_status, Some(u16::try_from(outcome["status"].as_u64().unwrap()).unwrap()), "{title}: the retried request");
        }
        "resolved" => assert!(matches!(ended, LoginState::Done { .. }), "{title}: Node's switch resolved, got {ended:?}"),
        kind => {
            let generic = match &mut ended {
                LoginState::Cancelled | LoginState::Failed(LoginFailure::Expired) => true,
                LoginState::Failed(LoginFailure::Failed { code, message }) => code == "loginFailed" && message == outcome["message"].as_str().unwrap(),
                _ => false,
            };
            assert!(generic, "{title}: Node's {kind}: {}; got {ended:?}", outcome["message"]);
        }
    }
    assert_eq!(json!(matches!(ended, LoginState::Done { .. })), json!(outcome["kind"] == "response" || resolved), "{title}: sign-in completed");
    let after = snapshot(&stage.spy, &origin, &ports);
    // Node's switch stores nothing itself; the recording commits its resolved sign-in (`commitMcpOAuthSwitch`) and
    // keeps the store and writes at that boundary apart. Rust commits as the flow ends, so what is compared is the
    // whole result: the complete store and the full sequence of writes, the commit's included.
    if resolved {
        let boundary = &case["commitBoundary"];
        assert_eq!(boundary["store"], case["storeBefore"], "{title}: a switch stores nothing before its commit");
        assert_eq!(boundary["ops"], json!([]), "{title}: a switch writes nothing before its commit");
    } else {
        assert!(case["commitBoundary"].is_null(), "{title}: only a resolved switch has a commit");
    }
    assert_eq!(after, case["storeAfter"], "{title}: the store after");
    assert_eq!(json!(stage.spy.ops.lock().unwrap().clone()), case["storeOps"], "{title}: the order of the store's writes");
    if resolved {
        let entry = &after["entry1"];
        assert_eq!(entry["tokens"]["access_token"], outcome["accessToken"], "{title}: switch tokens");
        assert_eq!(entry["tokens"]["refresh_token"], outcome["refreshToken"], "{title}: switch tokens");
        assert_eq!(entry["clientInformation"], serde_json::from_str::<Value>(outcome["clientInformation"].as_str().unwrap()).unwrap(), "{title}: switch client");
        assert_eq!(entry.get("identity").cloned().unwrap_or(Value::Null), outcome["identity"], "{title}: switch identity");
    }    stage.hub.close_all().await;
}
