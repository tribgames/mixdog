//! Relay-owned Web Push over the relay: the `/webpush/*` routes over real sockets and the desktop legs' frames over in-process sockets on the real hub. The push service is a recording `PushClient`.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use mixdog_relay::http1::{Handler, HandlerFuture, Limits, Request, ResponseWriter, UpgradeRequest};
use mixdog_relay::legs::desktop::DesktopHandle;
use mixdog_relay::legs::hub::{Hub, HubConfig, LegSocket};
use mixdog_relay::legs::ingress::IngressPool;
use mixdog_relay::legs::watchdog::HandshakeTiming;
use mixdog_relay::net::Server;
use mixdog_relay::rate_limit::RateLimiter;
use mixdog_relay::store::{DeviceStore, ProfileInput};
use mixdog_relay::web_push::WebPush;
use mixdog_relay::web_push::frames;
use mixdog_relay::web_push::http::WebPushEndpoint;
use mixdog_relay::web_push::registry::{Registry, SUBSCRIPTIONS_FILE};
use mixdog_relay::web_push::send::{PushClient, PushFuture, PushRequest};
use mixdog_relay::ws::FlushCallback;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const ENDPOINT: &str = "https://fcm.googleapis.com/fcm/send/subscription-1";
const SECRET: &str = "0123456789abcdef";
const PC_A: &str = "6f1d3c2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f";
const PC_B: &str = "7a2e4d3f-9b5c-4d6e-8f80-1b2c3d4e5f60";
const BROWSER_A: &str = "aaaaaaaa";
const BROWSER_B: &str = "bbbbbbbb";

fn sealed(tag: &str) -> Value {
    json!({
        "version": 1,
        "ephemeralPublicKey": format!("B{}", tag.repeat(86)),
        "nonce": "n".repeat(16),
        "ciphertext": tag.repeat(40),
    })
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ---- the push service ----

struct PushService {
    requests: Mutex<Vec<PushRequest>>,
    status: AtomicU16,
}

impl PushService {
    fn new() -> Arc<Self> {
        Arc::new(Self { requests: Mutex::new(Vec::new()), status: AtomicU16::new(201) })
    }

    fn respond(&self, status: u16) {
        self.status.store(status, Ordering::SeqCst);
    }

    fn posted(&self) -> Vec<PushRequest> {
        locked(&self.requests).clone()
    }
}

impl PushClient for PushService {
    fn post(&self, request: PushRequest) -> PushFuture<'_> {
        locked(&self.requests).push(request);
        let status = self.status.load(Ordering::SeqCst);
        Box::pin(async move { Ok(status) })
    }
}

// ---- a desktop leg over an in-process socket ----

struct Fake {
    sent: Mutex<Vec<String>>,
}

impl Fake {
    fn frames_of(&self, kind: &str) -> Vec<Value> {
        let parsed = locked(&self.sent).iter().filter_map(|text| mixdog_relay::js::parse(text).ok()).collect::<Vec<_>>();
        parsed.into_iter().filter(|frame| frame["type"] == kind).collect()
    }

    fn count(&self, kind: &str) -> usize {
        self.frames_of(kind).len()
    }
}

impl LegSocket for Fake {
    fn is_open(&self) -> bool {
        true
    }

    fn buffered_amount(&self) -> usize {
        0
    }

    fn send_text(&self, text: Bytes, on_flushed: Option<FlushCallback>) {
        locked(&self.sent).push(String::from_utf8_lossy(&text).into_owned());
        if let Some(callback) = on_flushed {
            callback(Ok(()));
        }
    }

    fn send_binary(&self, _data: Bytes, on_flushed: Option<FlushCallback>) {
        if let Some(callback) = on_flushed {
            callback(Ok(()));
        }
    }

    fn ping(&self) {}

    fn close(&self, _code: u16, _reason: &[u8]) {}

    fn terminate(&self) {}

    fn hold_uplink(&self, _hold: bool) {}

    fn read_held(&self) -> bool {
        false
    }
}

struct Leg {
    socket: Arc<Fake>,
    handle: DesktopHandle,
}

impl Leg {
    async fn send(&self, frame: &Value) {
        self.handle.frame(Bytes::from(mixdog_relay::js::wire(frame)), false).await;
    }

    /// What a current desktop says once it learns the relay delivers for it.
    async fn announce(&self, data_dir: &Path, device: &str) {
        self.send(&json!({ "type": "webpush-ready" })).await;
        assert!(Registry::open(data_dir).is_capable(device));
    }

    /// Waits (a bounded time) until `count` frames of `kind` have arrived, then returns them all.
    async fn frames(&self, kind: &str, count: usize) -> Vec<Value> {
        for _ in 0..300 {
            if self.socket.count(kind) >= count {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let found = self.socket.frames_of(kind);
        assert!(found.len() >= count, "no {kind} number {count}: {found:?}");
        found
    }
}

// ---- the relay ----

struct Route(Arc<WebPushEndpoint>);

impl Handler for Route {
    fn request(&self, request: Request, response: ResponseWriter) -> HandlerFuture {
        let endpoint = self.0.clone();
        Box::pin(async move { endpoint.handle(request, response).await })
    }

    fn upgrade(&self, _upgrade: UpgradeRequest) {}
}

struct Relay {
    hub: Arc<Hub>,
    server: Server,
    addr: SocketAddr,
    push: Arc<PushService>,
    token_a: String,
    token_b: String,
}

struct Options {
    /// The relay holds no Web Push identity.
    disabled: bool,
    unauthorized_limit: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self { disabled: false, unauthorized_limit: 1000 }
    }
}

async fn start(data_dir: &Path, options: Options) -> Relay {
    let io = mixdog_rt::testing::tokens().durability_io;
    let store = DeviceStore::open(data_dir, io).await.expect("the store opens");
    let config = HubConfig { handshake: HandshakeTiming { stall: Duration::from_secs(60), probe: Duration::from_millis(30) }, ..HubConfig::default() };
    let hub = Hub::new(store, config, IngressPool::new());
    let push = PushService::new();
    let web_push = (!options.disabled).then(|| Arc::new(WebPush::open(data_dir, push.clone()).expect("an identity")));
    if let Some(web_push) = &web_push {
        frames::register(&hub, web_push.clone()).expect("the frames register");
    }
    let limiter = Arc::new(Mutex::new(RateLimiter::new(options.unauthorized_limit, 60_000)));
    let endpoint = Arc::new(WebPushEndpoint::new(web_push, hub.clone(), limiter));
    let server = Server::start(0, None, Arc::new(Route(endpoint)), Limits::default()).await.unwrap();
    let addr = ([127, 0, 0, 1], server.port()).into();
    // One browser, paired with both PCs: one credential per PC.
    let mut tokens = Vec::new();
    for (device, browser) in [(PC_A, BROWSER_A), (PC_B, BROWSER_B)] {
        assert!(hub.store().authenticate(device, SECRET).await);
        let registered = hub.store().register_client(device, browser, &ProfileInput::text("Pixel", "android", "chrome")).await;
        tokens.push(registered.expect("a browser credential").token);
    }
    let token_b = tokens.pop().unwrap();
    let token_a = tokens.pop().unwrap();
    Relay { hub, server, addr, push, token_a, token_b }
}

impl Relay {
    fn leg(&self, device: &str) -> Leg {
        let socket = Arc::new(Fake { sent: Mutex::new(Vec::new()) });
        let handle = self.hub.attach_desktop(device, socket.clone(), None);
        Leg { socket, handle }
    }

    /// A PC that delivers through the relay: its leg, after it said so.
    async fn ready_leg(&self, data_dir: &Path, device: &str) -> Leg {
        let leg = self.leg(device);
        leg.announce(data_dir, device).await;
        leg
    }

    async fn call(&self, method: &str, path: &str, token: &str, body: Option<&Value>) -> Reply {
        self.request(method, path, &[("Origin", format!("http://127.0.0.1:{}", self.addr.port()))], token, body).await
    }

    async fn post(&self, path: &str, token: &str, body: &Value) -> Reply {
        self.call("POST", path, token, Some(body)).await
    }

    async fn request(&self, method: &str, path: &str, extra: &[(&str, String)], token: &str, body: Option<&Value>) -> Reply {
        let text = body.map(Value::to_string).unwrap_or_default();
        self.raw(method, path, extra, token, text.as_bytes()).await
    }

    async fn raw(&self, method: &str, path: &str, extra: &[(&str, String)], token: &str, body: &[u8]) -> Reply {
        let mut head = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: {}\r\n", self.addr.port(), body.len());
        head.push_str("Content-Type: application/json\r\nConnection: close\r\n");
        if !token.is_empty() {
            head.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        for (name, value) in extra {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        let mut stream = TcpStream::connect(self.addr).await.unwrap();
        stream.write_all(head.as_bytes()).await.unwrap();
        // A refusal can reset the connection while the body is still going out: the answer is read either way.
        drop(stream.write_all(body).await);
        let mut out = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match tokio::time::timeout(Duration::from_secs(3), stream.read(&mut chunk)).await {
                Ok(Ok(0) | Err(_)) | Err(_) => break,
                Ok(Ok(read)) => out.extend_from_slice(&chunk[..read]),
            }
        }
        Reply::parse(&out)
    }

    async fn finish(self) {
        self.server.terminate_connections();
    }
}

#[derive(Debug)]
struct Reply {
    /// 0 when the connection ended with no answer.
    status: u16,
    head: String,
    body: String,
}

impl Reply {
    fn parse(raw: &[u8]) -> Self {
        let text = String::from_utf8_lossy(raw).into_owned();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
        let status = head.split(' ').nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
        let chunked = head.lines().any(|line| line.eq_ignore_ascii_case("Transfer-Encoding: chunked"));
        let body = if chunked { dechunk(body) } else { body.to_owned() };
        Self { status, head: head.to_owned(), body }
    }

    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not json: {:?}", self.body))
    }

    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|line| {
            let (held, value) = line.split_once(':')?;
            held.eq_ignore_ascii_case(name).then(|| value.trim().to_owned())
        })
    }
}

fn dechunk(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some((size, tail)) = rest.split_once("\r\n") {
        let Ok(size) = usize::from_str_radix(size.split(';').next().unwrap_or("").trim(), 16) else { break };
        if size == 0 || tail.len() < size {
            break;
        }
        out.push_str(&tail[..size]);
        rest = tail[size..].strip_prefix("\r\n").unwrap_or("");
    }
    out
}

fn register_body(tag: &str) -> Value {
    json!({ "endpoint": ENDPOINT, "sealed": sealed(tag) })
}

fn payload(text: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text)
}

/// Every later write of the registry fails: its path becomes a directory. Returns what undoes it.
fn block_registry_writes(dir: &Path) -> impl FnOnce() + use<> {
    let path = dir.join(SUBSCRIPTIONS_FILE);
    mixdog_fsio::remove_file(&mixdog_fsio::Unlaned, &path).ok();
    mixdog_fsio::create_dir(&mixdog_fsio::Unlaned, &path).unwrap();
    move || mixdog_fsio::remove_dir_all(&mixdog_fsio::Unlaned, &path).unwrap()
}

// ---- the tests ----

#[tokio::test]
async fn the_web_app_reads_the_relay_key_the_same_one_after_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let relay = start(dir.path(), Options::default()).await;
    let response = relay.call("GET", "/webpush/key", "", None).await;
    assert_eq!(response.status, 200);
    assert_eq!(response.header("cache-control").as_deref(), Some("no-store"));
    let key = response.json()["publicKey"].as_str().unwrap().to_owned();
    assert_eq!(key.len(), 87);
    assert!(key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    assert_eq!(relay.call("HEAD", "/webpush/key", "", None).await.status, 200);
    assert_eq!(relay.call("POST", "/webpush/key", "", None).await.status, 405);
    relay.finish().await;

    let restarted = start(dir.path(), Options::default()).await;
    assert_eq!(restarted.call("GET", "/webpush/key", "", None).await.json()["publicKey"], json!(key));
    restarted.finish().await;
}

#[tokio::test]
async fn a_relay_without_an_identity_answers_404_to_the_whole_webpush_family() {
    let dir = tempfile::tempdir().unwrap();
    let relay = start(dir.path(), Options { disabled: true, ..Options::default() }).await;
    let token = relay.token_a.clone();
    for path in ["/webpush/key", "/webpush/register", "/webpush/unregister", "/webpush/status", "/webpush", "/webpush/other"] {
        assert_eq!(relay.post(path, &token, &register_body("a")).await.status, 404, "{path}");
        assert_eq!(relay.call("GET", path, &token, None).await.status, 404, "{path}");
    }
    // The PC is told nothing about Web Push either.
    let leg = relay.leg(PC_A);
    assert!(leg.socket.frames_of("relay-capabilities").iter().all(|frame| frame.get("webPush").is_none()));
    assert_eq!(leg.socket.count("webpush-subscriptions"), 0);
    relay.finish().await;
}

#[tokio::test]
async fn registration_without_a_valid_per_browser_credential_binds_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let relay = start(dir.path(), Options::default()).await;
    let token_a = relay.token_a.clone();
    let _leg_a = relay.ready_leg(dir.path(), PC_A).await;

    // No credential, a wrong credential, a cross-site page: nothing is bound.
    assert_eq!(relay.post("/webpush/register", "", &register_body("a")).await.status, 401);
    assert_eq!(relay.post("/webpush/register", &"f".repeat(64), &register_body("a")).await.status, 401);
    let cross_site = relay.request("POST", "/webpush/register", &[("Origin", "https://evil.example".to_owned())], &token_a, Some(&register_body("a"))).await;
    assert_eq!(cross_site.status, 403);
    // Neither is the pairing cookie a credential.
    let cookie = relay
        .request(
            "POST",
            "/webpush/register",
            &[("Origin", format!("http://127.0.0.1:{}", relay.addr.port())), ("Cookie", format!("mixdog_client={token_a}"))],
            "",
            Some(&register_body("a")),
        )
        .await;
    assert_eq!(cookie.status, 401);
    assert!(!Registry::open(dir.path()).has(PC_A, BROWSER_A, ENDPOINT));
    relay.finish().await;
}

#[tokio::test]
async fn each_pc_delivers_through_its_own_association_and_revocation_and_unregistration_end_it() {
    let dir = tempfile::tempdir().unwrap();
    let relay = start(dir.path(), Options::default()).await;
    let (token_a, token_b) = (relay.token_a.clone(), relay.token_b.clone());
    let leg_a = relay.ready_leg(dir.path(), PC_A).await;
    let leg_b = relay.ready_leg(dir.path(), PC_B).await;
    assert_eq!(leg_a.frames("relay-capabilities", 1).await[0]["webPush"], json!(1));
    assert_eq!(leg_a.frames("webpush-subscriptions", 1).await[0]["subscriptions"], json!([]));

    // The browser registers ONE subscription with BOTH PCs, each with its own credential.
    assert_eq!(relay.post("/webpush/register", &token_a, &register_body("a")).await.status, 200);
    assert_eq!(relay.post("/webpush/register", &token_b, &register_body("b")).await.status, 200);
    let set_a = leg_a.frames("webpush-subscriptions", 2).await[1]["subscriptions"].clone();
    let set_b = leg_b.frames("webpush-subscriptions", 2).await[1]["subscriptions"].clone();
    // Each PC sees only its own association, with the box sealed for it.
    assert_eq!(set_a, json!([{ "endpoint": ENDPOINT, "clientId": BROWSER_A, "sealed": sealed("a") }]));
    assert_eq!(set_b, json!([{ "endpoint": ENDPOINT, "clientId": BROWSER_B, "sealed": sealed("b") }]));
    let status = relay.post("/webpush/status", &token_a, &json!({ "endpoint": ENDPOINT })).await;
    assert_eq!(status.json(), json!({ "registered": true, "supported": true }));

    // Both PCs deliver; the relay signs and forwards ciphertext verbatim.
    let ciphertext = payload("ciphertext-from-a");
    leg_a.send(&json!({ "type": "webpush-send", "endpoint": ENDPOINT, "clientId": BROWSER_A, "payload": ciphertext })).await;
    assert_eq!(leg_a.frames("webpush-result", 1).await[0]["ok"], json!(true));
    leg_b.send(&json!({ "type": "webpush-send", "endpoint": ENDPOINT, "clientId": BROWSER_B, "payload": ciphertext })).await;
    assert_eq!(leg_b.frames("webpush-result", 1).await[0]["ok"], json!(true));
    let posted = relay.push.posted();
    assert_eq!(posted.len(), 2);
    assert_eq!(posted[0].endpoint, ENDPOINT);
    assert_eq!(posted[0].body, b"ciphertext-from-a");
    assert!(posted[0].headers.iter().any(|(name, value)| *name == "Content-Encoding" && value == "aes128gcm"));

    // A PC cannot borrow another PC's association.
    leg_a.send(&json!({ "type": "webpush-send", "endpoint": ENDPOINT, "clientId": BROWSER_B, "payload": ciphertext })).await;
    assert_eq!(leg_a.frames("webpush-result", 2).await[1]["error"], json!("unbound-subscription"));
    assert_eq!(relay.push.posted().len(), 2);

    // Revoking the browser on PC A removes only A's association, and A is told its new set.
    leg_a.send(&json!({ "type": "revoke-client", "requestId": "r1", "clientId": BROWSER_A })).await;
    assert_eq!(leg_a.frames("client-revoked", 1).await[0]["ok"], json!(true));
    assert_eq!(leg_a.frames("webpush-subscriptions", 3).await[2]["subscriptions"], json!([]));
    leg_a.send(&json!({ "type": "webpush-send", "endpoint": ENDPOINT, "clientId": BROWSER_A, "payload": ciphertext })).await;
    assert_eq!(leg_a.frames("webpush-result", 3).await[2]["error"], json!("unbound-subscription"));
    // The revoked credential cannot re-bind either.
    assert_eq!(relay.post("/webpush/register", &token_a, &register_body("a")).await.status, 401);
    leg_b.send(&json!({ "type": "webpush-send", "endpoint": ENDPOINT, "clientId": BROWSER_B, "payload": ciphertext })).await;
    assert_eq!(leg_b.frames("webpush-result", 2).await[1]["ok"], json!(true));
    assert_eq!(relay.push.posted().len(), 3);

    // Unregistering with PC B's credential removes B's association.
    let removed = relay.post("/webpush/unregister", &token_b, &json!({ "endpoint": ENDPOINT })).await;
    assert_eq!(removed.json(), json!({ "removed": true }));
    assert_eq!(leg_b.frames("webpush-subscriptions", 3).await[2]["subscriptions"], json!([]));
    relay.finish().await;
}

#[tokio::test]
async fn a_revoked_device_loses_its_associations_and_its_readiness() {
    let dir = tempfile::tempdir().unwrap();
    let relay = start(dir.path(), Options::default()).await;
    let token_a = relay.token_a.clone();
    let leg_a = relay.ready_leg(dir.path(), PC_A).await;
    assert_eq!(relay.post("/webpush/register", &token_a, &register_body("a")).await.status, 200);
    leg_a.frames("webpush-subscriptions", 2).await;
    leg_a.send(&json!({ "type": "revoke-device" })).await;
    assert_eq!(leg_a.frames("device-revoked", 1).await[0]["ok"], json!(true));
    let reloaded = Registry::open(dir.path());
    assert!(!reloaded.is_capable(PC_A));
    assert!(!reloaded.has(PC_A, BROWSER_A, ENDPOINT));
    relay.finish().await;
}

#[tokio::test]
async fn associations_are_persisted_and_a_retired_subscription_is_dropped_for_every_pc() {
    let dir = tempfile::tempdir().unwrap();
    let relay = start(dir.path(), Options::default()).await;
    let (token_a, token_b) = (relay.token_a.clone(), relay.token_b.clone());
    let leg_a = relay.ready_leg(dir.path(), PC_A).await;
    let leg_b = relay.ready_leg(dir.path(), PC_B).await;
    relay.post("/webpush/register", &token_a, &register_body("a")).await;
    relay.post("/webpush/register", &token_b, &register_body("b")).await;
    leg_a.frames("webpush-subscriptions", 2).await;
    leg_b.frames("webpush-subscriptions", 2).await;

    // Persisted beside devices.json: both associations are on disk.
    let saved =
        mixdog_relay::js::parse(&String::from_utf8(mixdog_fsio::read(&mixdog_fsio::Unlaned, dir.path().join(SUBSCRIPTIONS_FILE)).unwrap()).unwrap()).unwrap();
    assert_eq!(saved["subscriptions"][0]["associations"].as_array().unwrap().len(), 2);

    relay.push.respond(410);
    leg_a.send(&json!({ "type": "webpush-send", "endpoint": ENDPOINT, "clientId": BROWSER_A, "payload": payload("x") })).await;
    let result = leg_a.frames("webpush-result", 1).await[0].clone();
    assert_eq!(result["ok"], json!(false));
    assert_eq!(result["expired"], json!(true));
    assert_eq!(leg_a.frames("webpush-subscriptions", 3).await[2]["subscriptions"], json!([]));
    assert_eq!(leg_b.frames("webpush-subscriptions", 3).await[2]["subscriptions"], json!([]));
    relay.finish().await;
}

#[tokio::test]
async fn a_browser_registers_only_with_pcs_that_deliver_through_the_relay() {
    let dir = tempfile::tempdir().unwrap();
    let relay = start(dir.path(), Options::default()).await;
    let (token_a, token_b) = (relay.token_a.clone(), relay.token_b.clone());
    let _leg_a = relay.ready_leg(dir.path(), PC_A).await;
    // PC B is an older desktop: it never says `webpush-ready`.
    let leg_b = relay.leg(PC_B);
    let asked = relay.post("/webpush/status", &token_a, &json!({})).await;
    assert_eq!(asked.json(), json!({ "registered": false, "supported": true }));
    let asked = relay.post("/webpush/status", &token_b, &json!({})).await;
    assert_eq!(asked.json(), json!({ "registered": false, "supported": false }));
    let refused = relay.post("/webpush/register", &token_b, &register_body("b")).await;
    assert_eq!(refused.status, 409);
    assert_eq!(refused.json(), json!({ "error": "unsupported" }));
    assert_eq!(relay.post("/webpush/register", &token_a, &register_body("a")).await.status, 200);
    // Once B updates, it says so and the browser's next sync registers it.
    leg_b.announce(dir.path(), PC_B).await;
    assert_eq!(relay.post("/webpush/register", &token_b, &register_body("b")).await.status, 200);
    // Remembered across a restart: a browser registers while its PCs are offline.
    let reloaded = Registry::open(dir.path());
    assert!(reloaded.is_capable(PC_A));
    assert!(reloaded.is_capable(PC_B));
    relay.finish().await;
}

#[tokio::test]
async fn an_unregister_that_cannot_be_stored_is_refused_and_kept_never_resurrected() {
    let dir = tempfile::tempdir().unwrap();
    let relay = start(dir.path(), Options::default()).await;
    let token_a = relay.token_a.clone();
    let leg_a = relay.ready_leg(dir.path(), PC_A).await;
    assert_eq!(relay.post("/webpush/register", &token_a, &register_body("a")).await.status, 200);
    leg_a.frames("webpush-subscriptions", 2).await;

    let unblock = block_registry_writes(dir.path());
    let failed = relay.post("/webpush/unregister", &token_a, &json!({ "endpoint": ENDPOINT })).await;
    assert_eq!(failed.status, 503);
    assert_eq!(failed.header("retry-after").as_deref(), Some("30"));
    // Memory still agrees with what a restart would read: nothing changed, nothing announced.
    let status = relay.post("/webpush/status", &token_a, &json!({ "endpoint": ENDPOINT })).await;
    assert_eq!(status.json()["registered"], json!(true));
    assert_eq!(leg_a.socket.count("webpush-subscriptions"), 2);
    // A new box that cannot be stored is refused the same way, and the old one stays.
    assert_eq!(relay.post("/webpush/register", &token_a, &register_body("z")).await.status, 503);
    assert_eq!(leg_a.socket.count("webpush-subscriptions"), 2);
    unblock();

    let removed = relay.post("/webpush/unregister", &token_a, &json!({ "endpoint": ENDPOINT })).await;
    assert_eq!(removed.json(), json!({ "removed": true }));
    assert!(!Registry::open(dir.path()).has(PC_A, BROWSER_A, ENDPOINT));
    relay.finish().await;
}

#[tokio::test]
async fn re_stating_an_unchanged_registration_writes_and_announces_nothing_and_mutations_are_rate_limited() {
    let dir = tempfile::tempdir().unwrap();
    let relay = start(dir.path(), Options::default()).await;
    let (token_a, token_b) = (relay.token_a.clone(), relay.token_b.clone());
    let leg_a = relay.ready_leg(dir.path(), PC_A).await;
    let _leg_b = relay.ready_leg(dir.path(), PC_B).await;
    assert_eq!(relay.post("/webpush/register", &token_a, &register_body("a")).await.status, 200);
    leg_a.frames("webpush-subscriptions", 2).await;

    // Writes would fail now, so a re-register that wrote anything would answer 503.
    let unblock = block_registry_writes(dir.path());
    assert_eq!(relay.post("/webpush/register", &token_a, &register_body("a")).await.status, 200);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(leg_a.socket.count("webpush-subscriptions"), 2, "no republish for an unchanged association");
    unblock();

    // 2 mutations so far on A's credential; the rest of the window, then 429.
    let mut statuses = Vec::new();
    for _ in 0..20 {
        statuses.push(relay.post("/webpush/register", &token_a, &register_body("a")).await.status);
    }
    assert_eq!(statuses[..18], [200; 18]);
    assert_eq!(statuses[18..], [429, 429]);
    let limited = relay.post("/webpush/unregister", &token_a, &json!({ "endpoint": ENDPOINT })).await;
    assert_eq!(limited.status, 429);
    assert_eq!(limited.header("retry-after").as_deref(), Some("60"));
    // Another PC's credential, on the same browser, has its own budget.
    assert_eq!(relay.post("/webpush/register", &token_b, &register_body("b")).await.status, 200);
    relay.finish().await;
}

#[tokio::test]
async fn bodies_endpoints_and_methods_are_checked_before_anything_is_stored() {
    let dir = tempfile::tempdir().unwrap();
    let relay = start(dir.path(), Options::default()).await;
    let token = relay.token_a.clone();
    let _leg = relay.ready_leg(dir.path(), PC_A).await;
    let origin = [("Origin", format!("http://127.0.0.1:{}", relay.addr.port()))];
    // Not JSON, an endpoint off the push services, a missing or malformed box: 400.
    assert_eq!(relay.raw("POST", "/webpush/register", &origin, &token, b"{not json").await.status, 400);
    let elsewhere = json!({ "endpoint": "https://example.com/push", "sealed": sealed("a") });
    assert_eq!(relay.post("/webpush/register", &token, &elsewhere).await.status, 400);
    assert_eq!(relay.post("/webpush/register", &token, &json!({ "endpoint": ENDPOINT })).await.status, 400);
    assert_eq!(relay.post("/webpush/register", &token, &json!({ "endpoint": 7, "sealed": sealed("a") })).await.status, 400);
    assert_eq!(relay.post("/webpush/unregister", &token, &json!({})).await.status, 400);
    assert_eq!(relay.post("/webpush/status", &token, &json!({ "endpoint": "nope" })).await.status, 400);
    // No body at all is `{}`: status answers, the others refuse.
    assert_eq!(relay.raw("POST", "/webpush/status", &origin, &token, b"").await.json(), json!({ "registered": false, "supported": true }));
    assert_eq!(relay.raw("POST", "/webpush/register", &origin, &token, b"").await.status, 400);
    // A body over 4 KiB is not answered: the connection is dropped.
    let big = json!({ "endpoint": ENDPOINT, "sealed": sealed("a"), "pad": "x".repeat(5000) });
    assert_ne!(relay.post("/webpush/register", &token, &big).await.status, 200);
    // Methods and paths.
    assert_eq!(relay.call("GET", "/webpush/register", &token, None).await.status, 405);
    assert_eq!(relay.call("GET", "/webpush/elsewhere", &token, None).await.status, 404);
    assert_eq!(relay.call("GET", "/webpush", &token, None).await.status, 404);
    assert!(!Registry::open(dir.path()).has(PC_A, BROWSER_A, ENDPOINT));
    relay.finish().await;
}

#[tokio::test]
async fn unknown_credentials_are_throttled_per_address() {
    let dir = tempfile::tempdir().unwrap();
    let relay = start(dir.path(), Options { unauthorized_limit: 2, ..Options::default() }).await;
    for _ in 0..2 {
        assert_eq!(relay.post("/webpush/status", &"e".repeat(64), &json!({})).await.status, 401);
    }
    let throttled = relay.post("/webpush/status", &"e".repeat(64), &json!({})).await;
    assert_eq!(throttled.status, 429);
    assert_eq!(throttled.header("retry-after").as_deref(), Some("60"));
    relay.finish().await;
}

#[tokio::test]
async fn a_leg_that_sends_nothing_valid_is_answered_with_the_reason() {
    let dir = tempfile::tempdir().unwrap();
    let relay = start(dir.path(), Options::default()).await;
    let leg = relay.ready_leg(dir.path(), PC_A).await;
    leg.send(&json!({ "type": "webpush-send", "endpoint": ENDPOINT, "clientId": BROWSER_A })).await;
    let results = leg.frames("webpush-result", 1).await;
    assert_eq!(results[0]["error"], json!("invalid-message"));
    assert_eq!(results[0]["ok"], json!(false));
    assert_eq!(results[0]["endpoint"], json!(ENDPOINT));
    assert!(relay.push.posted().is_empty());
    relay.finish().await;
}
