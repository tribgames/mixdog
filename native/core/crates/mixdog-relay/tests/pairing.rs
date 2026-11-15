//! Browser registration, the approval handoff and the pair-code routes: the cases of `lib/relay-pairing.test.mjs`, and the claim and
//! registration cases of `apps/relay/security.test.mjs` that need no full relay. The pool of claims is exercised on an explicit clock;
//! the routes run over real sockets against the http1 layer with a hub whose desktop leg is a recording stand-in.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use mixdog_relay::http1::{Handler, HandlerFuture, Limits, Request, ResponseWriter, UpgradeRequest};
use mixdog_relay::legs::desktop::DesktopHandle;
use mixdog_relay::legs::hub::{Hub, HubConfig, LegSocket};
use mixdog_relay::legs::ingress::IngressPool;
use mixdog_relay::legs::watchdog::HandshakeTiming;
use mixdog_relay::net::Server;
use mixdog_relay::pairing::Pairing;
use mixdog_relay::pairing::claims::{
    APPROVED_CLAIM_RETAIN_MS, CLAIM_TTL_MS, Claim, ClaimStatus, Claims, EXPIRED_CLAIM_RETAIN_MS, MAX_PENDING_CLAIMS,
    MAX_PENDING_CLAIMS_PER_DEVICE, MAX_PENDING_CLAIMS_PER_SOURCE,
};
use mixdog_relay::rate_limit::RateLimiter;
use mixdog_relay::store::{ClientProfile, DeviceStore};
use mixdog_relay::ws::FlushCallback;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const DEVICE: &str = "6f1d3c2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f";
const SECRET: &str = "0123456789abcdef";

// ---- the pool of claims, on an explicit clock ----

fn claim_record(status: ClaimStatus, token: &str, expires_at: i64) -> Claim {
    Claim {
        id: "c1".to_owned(),
        device_id: "dev".to_owned(),
        client_id: "bbbbbbbb".to_owned(),
        public_key: "k".repeat(87),
        profile: ClientProfile { name: "Web app".to_owned(), platform: String::new(), browser: String::new() },
        source: "127.0.0.1".to_owned(),
        status,
        token: token.to_owned(),
        sealed: json!({ "box": "opaque" }),
        expires_at,
    }
}

#[test]
fn pending_claim_pool_bounds_are_the_ones_the_http_handler_enforces() {
    assert_eq!(MAX_PENDING_CLAIMS, 64);
    assert_eq!(MAX_PENDING_CLAIMS_PER_DEVICE, 8);
    assert_eq!(MAX_PENDING_CLAIMS_PER_SOURCE, 8);
    assert_eq!(CLAIM_TTL_MS, 300_000);
}

#[test]
fn claim_get_for_an_id_this_relay_does_not_hold_is_unknown_not_expired_or_404() {
    assert_eq!(Claims::new().poll("missing"), json!({ "status": "unknown" }));
}

#[test]
fn an_approved_claim_can_be_read_again_until_its_retention_ends_then_it_is_unknown() {
    let token = "a".repeat(64);
    let expires_at = 1_000_000 + APPROVED_CLAIM_RETAIN_MS;
    let mut claims = Claims::new();
    claims.insert(claim_record(ClaimStatus::Approved, &token, expires_at));
    let approved = json!({ "status": "approved", "clientId": "bbbbbbbb", "token": token, "sealed": { "box": "opaque" } });
    claims.sweep(1_000_000);
    assert_eq!(claims.poll("c1"), approved);
    claims.sweep(1_000_000);
    assert_eq!(claims.poll("c1"), approved, "a lost answer can be asked for again");
    // Another claim id is not this claim: no credential for a guess.
    assert_eq!(claims.poll("c2"), json!({ "status": "unknown" }));
    claims.sweep(expires_at + 1);
    assert_eq!(claims.poll("c1"), json!({ "status": "unknown" }));
    assert_eq!(claims.len(), 0);
}

#[test]
fn a_lapsed_pending_claim_answers_expired_for_a_while_then_unknown() {
    let expires_at = 1_000_000;
    let mut claims = Claims::new();
    claims.insert(claim_record(ClaimStatus::Pending, "", expires_at - 1));
    claims.sweep(expires_at);
    assert_eq!(claims.poll("c1"), json!({ "status": "expired" }));
    claims.sweep(expires_at);
    assert_eq!(claims.poll("c1"), json!({ "status": "expired" }));
    claims.sweep(expires_at + EXPIRED_CLAIM_RETAIN_MS + 10);
    assert_eq!(claims.poll("c1"), json!({ "status": "unknown" }));
}

// ---- the rig: a hub with a recording desktop leg behind the three routes ----

/// A desktop socket that records the text frames it is sent.
#[derive(Default)]
struct Leg {
    texts: Mutex<Vec<String>>,
    closed: AtomicBool,
}

impl Leg {
    fn frames_of(&self, kind: &str) -> Vec<Value> {
        let texts = self.texts.lock().unwrap().clone();
        texts
            .iter()
            .filter_map(|text| mixdog_relay::js::parse(text).ok())
            .filter(|frame| frame.get("type").and_then(Value::as_str) == Some(kind))
            .collect()
    }
}

impl LegSocket for Leg {
    fn is_open(&self) -> bool {
        !self.closed.load(Ordering::SeqCst)
    }

    fn buffered_amount(&self) -> usize {
        0
    }

    fn send_text(&self, text: Bytes, on_flushed: Option<FlushCallback>) {
        self.texts.lock().unwrap().push(String::from_utf8_lossy(&text).into_owned());
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

    fn close(&self, _code: u16, _reason: &[u8]) {
        self.closed.store(true, Ordering::SeqCst);
    }

    fn terminate(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    fn hold_uplink(&self, _hold: bool) {}

    fn read_held(&self) -> bool {
        false
    }
}

struct Routes(Arc<Pairing>);

impl Handler for Routes {
    fn request(&self, request: Request, response: ResponseWriter) -> HandlerFuture {
        let pairing = self.0.clone();
        Box::pin(async move {
            if request.url.starts_with("/pair-code/") {
                pairing.handle_pair_code(request, response).await;
            } else if request.url.starts_with("/client/register") {
                pairing.handle_registration(request, response).await;
            } else {
                pairing.handle_claim(request, response).await;
            }
        })
    }

    fn upgrade(&self, _upgrade: UpgradeRequest) {}
}

struct Rig {
    _dir: TempDir,
    hub: Arc<Hub>,
    server: Server,
    addr: SocketAddr,
    leg: Arc<Leg>,
    desktop: DesktopHandle,
}

/// A relay with one known desktop, connected unless `connected` is false.
async fn boot(connected: bool) -> Rig {
    let dir = TempDir::new().unwrap();
    let io = mixdog_rt::testing::tokens().durability_io;
    let store = DeviceStore::open(dir.path(), io).await.expect("the store opens");
    assert!(store.authenticate(DEVICE, SECRET).await);
    // A watchdog that never fires within a test.
    let config = HubConfig { handshake: HandshakeTiming { stall: Duration::from_secs(60), probe: Duration::from_millis(30) }, ..HubConfig::default() };
    let hub = Hub::new(store, config, IngressPool::new());
    let pairing = Pairing::new(hub.clone(), Arc::new(Mutex::new(RateLimiter::new(1000, 60_000))));
    pairing.register().expect("the frames are free");
    let leg = Arc::new(Leg::default());
    let desktop = hub.attach_desktop(DEVICE, leg.clone(), None);
    if !connected {
        // A socket reads as closed by the time its close event fires.
        leg.closed.store(true, Ordering::SeqCst);
        desktop.closed();
    }
    let server = Server::start(0, None, Arc::new(Routes(pairing)), Limits::default()).await.unwrap();
    let addr = ([127, 0, 0, 1], server.port()).into();
    Rig { _dir: dir, hub, server, addr, leg, desktop }
}

impl Rig {
    fn origin(&self) -> String {
        format!("http://{}", self.addr)
    }

    async fn frame(&self, frame: &Value) {
        self.desktop.frame(Bytes::from(frame.to_string()), false).await;
    }

    async fn finish(self) {
        self.server.terminate_connections();
        self.hub.shutdown();
    }
}

struct Reply {
    status: u16,
    head: String,
    body: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|_| panic!("not json: {:?}", self.body))
    }

    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim().to_owned())
        })
    }
}

/// One request, answered with the connection closed. `status` is 0 when the server closed the connection without an answer.
async fn call(addr: SocketAddr, method: &str, target: &str, headers: &[(&str, String)], body: &[u8]) -> Reply {
    let mut head = format!("{method} {target} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let mut stream = TcpStream::connect(addr).await.unwrap();
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let mut raw = Vec::new();
    let _ = mixdog_rt::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut raw)).await;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
    let status = head.split(' ').nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
    let chunked = head.lines().any(|line| line.eq_ignore_ascii_case("Transfer-Encoding: chunked"));
    Reply { status, head: head.to_owned(), body: if chunked { dechunk(body) } else { body.to_owned() } }
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

async fn post_json(rig: &Rig, target: &str, headers: &[(&str, String)], body: &Value) -> Reply {
    let mut all = vec![("Content-Type", "application/json".to_owned()), ("Origin", rig.origin())];
    all.extend(headers.iter().map(|(name, value)| (*name, value.clone())));
    call(rig.addr, "POST", target, &all, body.to_string().as_bytes()).await
}

async fn claim(rig: &Rig, body: &Value) -> Reply {
    post_json(rig, "/claim", &[], body).await
}

async fn poll(rig: &Rig, claim_id: &str) -> Value {
    let reply = call(rig.addr, "GET", &format!("/claim/{claim_id}"), &[], b"").await;
    assert_eq!(reply.status, 200);
    reply.json()
}

fn claim_body(client: &str, key: &str) -> Value {
    json!({ "deviceId": DEVICE, "clientId": client, "publicKey": key.repeat(87) })
}

fn is_token(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// ---- registration ----

#[tokio::test]
async fn client_registration_refuses_non_post_and_cross_origin_callers() {
    let rig = boot(true).await;
    let get = call(rig.addr, "GET", "/client/register", &[], b"").await;
    assert_eq!(get.status, 405);
    let cross = call(rig.addr, "POST", "/client/register", &[("Origin", "https://evil.example".to_owned())], b"{}").await;
    assert_eq!(cross.status, 403);
    rig.finish().await;
}

#[tokio::test]
async fn browser_registration_exchanges_the_pairing_token_for_an_individual_credential() {
    let rig = boot(true).await;
    assert!(rig.hub.store().set_client_token(DEVICE, "fedcba9876543210").await);
    let body = json!({ "clientId": "bbbbbbbb", "name": "Android \u{b7} Chrome", "platform": "Android", "browser": "Chrome" });
    let reply = post_json(&rig, "/client/register?token=fedcba9876543210", &[], &body).await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("Content-Type").as_deref(), Some("application/json"));
    assert_eq!(reply.header("Cache-Control").as_deref(), Some("no-store"));
    assert!(reply.header("Set-Cookie").is_some_and(|cookie| cookie.starts_with("mixdog_token=")), "the credential is persisted as the pairing cookie");
    let answer = reply.json();
    let token = answer["token"].as_str().expect("a token").to_owned();
    assert!(is_token(&token));
    let access = rig.hub.store().client_access_for_token(&token).expect("the credential works");
    assert_eq!((access.device_id.as_str(), access.client_id.as_deref()), (DEVICE, Some("bbbbbbbb")));
    // A browser holding its own credential refreshes its record and is told no new token.
    let again = post_json(&rig, "/client/register", &[("Authorization", format!("Bearer {token}"))], &body).await;
    assert_eq!(again.status, 200);
    assert_eq!(again.json(), json!({ "clientId": "bbbbbbbb" }));
    // Another browser's id on that credential is refused.
    let other = post_json(&rig, "/client/register", &[("Authorization", format!("Bearer {token}"))], &json!({ "clientId": "cccccccc" })).await;
    assert_eq!(other.status, 401);
    // An unknown token or a malformed id is refused too.
    let unknown = post_json(&rig, "/client/register?token=0000000000000000", &[], &body).await;
    assert_eq!(unknown.status, 401);
    let bad_id = post_json(&rig, "/client/register?token=fedcba9876543210", &[], &json!({ "clientId": "NOPE" })).await;
    assert_eq!(bad_id.status, 401);
    rig.finish().await;
}

#[tokio::test]
async fn an_oversize_registration_body_destroys_the_request_and_registers_nothing() {
    let rig = boot(true).await;
    assert!(rig.hub.store().set_client_token(DEVICE, "fedcba9876543210").await);
    let big = json!({ "clientId": "bbbbbbbb", "name": "x".repeat(9000) });
    let reply = post_json(&rig, "/client/register?token=fedcba9876543210", &[], &big).await;
    assert_ne!(reply.status, 200);
    assert!(rig.hub.store().list_clients(DEVICE, &|_| false).is_empty());
    rig.finish().await;
}

// ---- claims ----

#[tokio::test]
async fn an_approval_mints_the_credential_and_the_relay_only_routes_the_request() {
    let rig = boot(true).await;
    let key = "k".repeat(87);
    let started = claim(&rig, &json!({ "deviceId": DEVICE, "clientId": "bbbbbbbb", "publicKey": key, "name": "iPhone \u{b7} Web app" })).await;
    assert_eq!(started.status, 202);
    let claim_id = started.json()["claimId"].as_str().expect("a claim id").to_owned();
    let forwarded = rig.leg.frames_of("client-claim");
    assert_eq!(forwarded.len(), 1);
    let request = &forwarded[0];
    assert_eq!(request["claimId"], json!(claim_id));
    assert_eq!(request["clientId"], json!("bbbbbbbb"));
    assert_eq!(request["publicKey"], json!(key));
    assert_eq!(request["method"], json!("qr"));
    assert_eq!(request["name"], json!("iPhone \u{b7} Web app"));
    assert_eq!(request["platform"], json!(""));
    let expires_at = request["expiresAt"].as_i64().expect("an expiry");
    let now = mixdog_relay::rate_limit::now_ms();
    assert!(expires_at > now && expires_at <= now + CLAIM_TTL_MS);
    // Pending means pending: no credential exists before the desktop answers.
    assert_eq!(poll(&rig, &claim_id).await, json!({ "status": "pending" }));
    rig.frame(&json!({ "type": "claim-approve", "claimId": claim_id, "sealed": { "box": "opaque" } })).await;
    let answer = poll(&rig, &claim_id).await;
    assert_eq!(answer["status"], json!("approved"));
    let token = answer["token"].as_str().expect("a token").to_owned();
    assert!(is_token(&token));
    // The relay forwards the sealed material without a key to open it.
    assert_eq!(answer["sealed"], json!({ "box": "opaque" }));
    assert_eq!(rig.hub.store().device_id_for_client_token(&token).as_deref(), Some(DEVICE));
    // A lost answer can be asked for again, and only by the claim id.
    assert_eq!(poll(&rig, &claim_id).await, answer);
    // An id this relay never held (a restart) is unknown, not expired.
    assert_eq!(poll(&rig, "00000000-0000-4000-8000-000000000000").await, json!({ "status": "unknown" }));
    rig.finish().await;
}

#[tokio::test]
async fn registering_with_the_claim_credential_ends_the_re_read_window() {
    let rig = boot(true).await;
    let started = claim(&rig, &claim_body("bbbbbbbb", "k")).await;
    let claim_id = started.json()["claimId"].as_str().expect("a claim id").to_owned();
    let other = claim(&rig, &claim_body("cccccccc", "m")).await;
    let other_id = other.json()["claimId"].as_str().expect("a claim id").to_owned();
    rig.frame(&json!({ "type": "claim-approve", "claimId": claim_id })).await;
    let answer = poll(&rig, &claim_id).await;
    let token = answer["token"].as_str().expect("a token").to_owned();
    assert_eq!(answer["sealed"], Value::Null);
    let registered = post_json(&rig, "/client/register", &[("Authorization", format!("Bearer {token}"))], &json!({ "clientId": "bbbbbbbb" })).await;
    assert_eq!(registered.status, 200);
    assert_eq!(poll(&rig, &claim_id).await, json!({ "status": "unknown" }));
    // The other claim is untouched.
    assert_eq!(poll(&rig, &other_id).await, json!({ "status": "pending" }));
    rig.finish().await;
}

#[tokio::test]
async fn a_denial_and_an_answer_from_another_desktop_are_told_apart() {
    let rig = boot(true).await;
    let started = claim(&rig, &claim_body("bbbbbbbb", "k")).await;
    let claim_id = started.json()["claimId"].as_str().expect("a claim id").to_owned();
    // A frame with no claim id, or for a claim this desktop was not asked, changes nothing.
    rig.frame(&json!({ "type": "claim-approve" })).await;
    rig.frame(&json!({ "type": "claim-deny", "claimId": 7 })).await;
    assert_eq!(poll(&rig, &claim_id).await, json!({ "status": "pending" }));
    rig.frame(&json!({ "type": "claim-deny", "claimId": claim_id })).await;
    assert_eq!(poll(&rig, &claim_id).await, json!({ "status": "denied" }));
    // A denied claim is not approved afterwards.
    rig.frame(&json!({ "type": "claim-approve", "claimId": claim_id })).await;
    assert_eq!(poll(&rig, &claim_id).await, json!({ "status": "denied" }));
    rig.finish().await;
}

#[tokio::test]
async fn a_reopened_request_resumes_instead_of_prompting_the_desktop_again() {
    let rig = boot(true).await;
    // A phone that reloads mid-approval re-sends the same request; the user is already looking at that prompt.
    let first = claim(&rig, &claim_body("bbbbbbbb", "k")).await;
    let again = claim(&rig, &claim_body("bbbbbbbb", "k")).await;
    assert_eq!((first.status, again.status), (202, 202));
    assert_eq!(again.json()["claimId"], first.json()["claimId"]);
    // A different container is a different request and does get its own.
    let other = claim(&rig, &claim_body("bbbbbbbb", "m")).await;
    assert_ne!(other.json()["claimId"], first.json()["claimId"]);
    assert_eq!(rig.leg.frames_of("client-claim").len(), 2);
    rig.finish().await;
}

#[tokio::test]
async fn a_claim_for_an_unknown_desktop_is_refused_and_never_reaches_a_leg() {
    let rig = boot(true).await;
    let unknown = json!({ "deviceId": "dddddddd", "clientId": "bbbbbbbb", "publicKey": "k".repeat(87) });
    assert_eq!(claim(&rig, &unknown).await.status, 404);
    // A claim with a malformed field is refused the same way, before any lookup.
    let malformed = json!({ "deviceId": "nope", "clientId": "nope", "publicKey": "x" });
    assert_eq!(claim(&rig, &malformed).await.status, 404);
    // Cross-origin callers cannot open a claim at all.
    let cross = call(rig.addr, "POST", "/claim", &[("Origin", "http://evil.example".to_owned())], unknown.to_string().as_bytes()).await;
    assert_eq!(cross.status, 403);
    assert!(rig.leg.frames_of("client-claim").is_empty());
    // Other methods and paths are 405.
    assert_eq!(call(rig.addr, "GET", "/claim", &[], b"").await.status, 405);
    rig.finish().await;
}

#[tokio::test]
async fn a_claim_for_a_desktop_that_is_offline_answers_503_offline() {
    let rig = boot(false).await;
    let reply = claim(&rig, &claim_body("bbbbbbbb", "k")).await;
    assert_eq!(reply.status, 503);
    assert_eq!(reply.json(), json!({ "status": "offline" }));
    rig.finish().await;
}

#[tokio::test]
async fn pending_claims_give_each_desktop_a_bounded_share_of_the_pool() {
    let rig = boot(true).await;
    for index in 0..MAX_PENDING_CLAIMS_PER_DEVICE {
        let key = format!("{index:02}");
        assert_eq!(claim(&rig, &json!({ "deviceId": DEVICE, "clientId": "bbbbbbbb", "publicKey": key.repeat(43) })).await.status, 202);
    }
    // One desktop (or one caller) filling the whole pool would lock every other install out of approval until the entries expire.
    let refused = claim(&rig, &json!({ "deviceId": DEVICE, "clientId": "bbbbbbbb", "publicKey": "90".repeat(43) })).await;
    assert_eq!(refused.status, 503);
    assert_eq!(refused.json(), json!({ "status": "busy" }));
    rig.finish().await;
}

// ---- pair codes ----

async fn issue_code(rig: &Rig) -> String {
    rig.frame(&json!({ "type": "pair-code-request", "lease": "lease-0001", "name": "Home PC" })).await;
    let issued = rig.leg.frames_of("pair-code-issued");
    let last = issued.last().expect("an answer");
    assert_eq!(last["ok"], json!(true));
    last["code"].as_str().expect("a code").to_owned()
}

#[tokio::test]
async fn a_registered_code_redeems_into_a_claim_the_desktop_sees_as_a_code_claim() {
    let rig = boot(true).await;
    let code = issue_code(&rig).await;
    let resolved = post_json(&rig, "/pair-code/resolve", &[], &json!({ "code": code })).await;
    assert_eq!(resolved.status, 200);
    let answer = resolved.json();
    assert_eq!(answer["deviceId"], json!(DEVICE));
    assert_eq!(answer["name"], json!("Home PC"));
    let ticket = answer["ticket"].as_str().expect("a ticket").to_owned();
    assert_eq!(rig.leg.frames_of("pair-code-used"), vec![json!({ "type": "pair-code-used", "lease": "lease-0001" })]);
    let mut body = claim_body("bbbbbbbb", "k");
    body["ticket"] = json!(ticket);
    assert_eq!(claim(&rig, &body).await.status, 202);
    assert_eq!(rig.leg.frames_of("client-claim")[0]["method"], json!("code"));
    // The ticket is spent: the same one cannot label another claim a code claim, but a client retrying says so.
    let mut again = claim_body("bbbbbbbb", "m");
    again["ticket"] = json!(ticket);
    again["retry"] = json!(true);
    assert_eq!(claim(&rig, &again).await.status, 202);
    assert_eq!(rig.leg.frames_of("client-claim")[1]["method"], json!("retry"));
    // The code was single use.
    let spent = post_json(&rig, "/pair-code/resolve", &[], &json!({ "code": code })).await;
    assert_eq!(spent.status, 404);
    assert_eq!(spent.json(), json!({ "status": "invalid-code" }));
    rig.finish().await;
}

#[tokio::test]
async fn wrong_guesses_are_limited_per_source_and_never_echo_the_code() {
    let rig = boot(true).await;
    let code = issue_code(&rig).await;
    let wrong = if code == "000000" { "000001" } else { "000000" };
    for _ in 0..5 {
        let reply = post_json(&rig, "/pair-code/resolve", &[], &json!({ "code": wrong })).await;
        assert_eq!(reply.status, 404);
        assert!(!reply.body.contains(&code));
    }
    // The source is locked out now, even for the right code.
    let limited = post_json(&rig, "/pair-code/resolve", &[], &json!({ "code": code })).await;
    assert_eq!(limited.status, 429);
    assert_eq!(limited.json(), json!({ "status": "rate-limited", "retryAfter": 60 }));
    assert_eq!(limited.header("Retry-After").as_deref(), Some("60"));
    rig.finish().await;
}

#[tokio::test]
async fn oversize_and_malformed_code_requests_are_refused_and_cross_origin_callers_too() {
    let rig = boot(true).await;
    let big = post_json(&rig, "/pair-code/resolve", &[], &json!({ "code": "1".repeat(2000) })).await;
    assert_eq!((big.status, big.json()), (400, json!({ "status": "bad-request" })));
    let malformed = call(rig.addr, "POST", "/pair-code/resolve", &[("Origin", rig.origin())], b"{nope").await;
    assert_eq!((malformed.status, malformed.json()), (400, json!({ "status": "bad-request" })));
    let cross = call(rig.addr, "POST", "/pair-code/resolve", &[("Origin", "https://evil.example".to_owned())], b"{}").await;
    assert_eq!(cross.status, 403);
    // An unknown route is a bare 404.
    assert_eq!(call(rig.addr, "GET", "/pair-code/nothing", &[], b"").await.status, 404);
    rig.finish().await;
}

#[tokio::test]
async fn the_phone_app_origin_may_call_and_is_answered_with_cors_headers() {
    let rig = boot(true).await;
    let preflight = call(rig.addr, "OPTIONS", "/pair-code/resolve", &[("Origin", "capacitor://localhost".to_owned())], b"").await;
    assert_eq!(preflight.status, 204);
    assert_eq!(preflight.header("Access-Control-Allow-Origin").as_deref(), Some("capacitor://localhost"));
    assert_eq!(preflight.header("Vary").as_deref(), Some("Origin"));
    assert_eq!(preflight.header("Access-Control-Allow-Headers").as_deref(), Some("Content-Type"));
    assert_eq!(preflight.header("Access-Control-Allow-Methods").as_deref(), Some("GET, POST"));
    assert_eq!(preflight.header("Access-Control-Max-Age").as_deref(), Some("600"));
    let called = call(rig.addr, "POST", "/pair-code/resolve", &[("Origin", "https://localhost".to_owned())], br#"{"code":"123456"}"#).await;
    assert_eq!(called.status, 404);
    assert_eq!(called.header("Access-Control-Allow-Origin").as_deref(), Some("https://localhost"));
    // No Origin at all is a native client.
    assert_eq!(call(rig.addr, "POST", "/pair-code/resolve", &[], br#"{"code":"123456"}"#).await.status, 404);
    rig.finish().await;
}

#[tokio::test]
async fn presence_and_support_report_known_desktops_only() {
    let rig = boot(true).await;
    let ghost = "dddddddd-0000-4000-8000-000000000000";
    let presence = post_json(&rig, "/pair-code/presence", &[], &json!({ "ids": [DEVICE, ghost, "nope", 7] })).await;
    assert_eq!(presence.status, 200);
    let mut online = serde_json::Map::new();
    online.insert(DEVICE.to_owned(), json!(true));
    assert_eq!(presence.json(), json!({ "online": online }));
    let support = call(rig.addr, "GET", &format!("/pair-code/support?deviceId={DEVICE}"), &[], b"").await;
    assert_eq!((support.status, support.json()), (200, json!({ "online": true, "pairV2": false })));
    let unknown = call(rig.addr, "GET", &format!("/pair-code/support?deviceId={ghost}"), &[], b"").await;
    assert_eq!((unknown.status, unknown.json()), (404, json!({ "status": "unknown" })));
    rig.leg.closed.store(true, Ordering::SeqCst);
    rig.desktop.closed();
    let offline = call(rig.addr, "GET", &format!("/pair-code/support?deviceId={DEVICE}"), &[], b"").await;
    assert_eq!(offline.json()["online"], json!(false));
    rig.finish().await;
}

#[tokio::test]
async fn a_code_dies_with_the_leg_that_published_it_and_can_be_withdrawn() {
    let rig = boot(true).await;
    let withdrawn = issue_code(&rig).await;
    rig.frame(&json!({ "type": "pair-code-clear" })).await;
    let reply = post_json(&rig, "/pair-code/resolve", &[], &json!({ "code": withdrawn })).await;
    assert_eq!(reply.status, 404);
    let closing = issue_code(&rig).await;
    rig.desktop.closed();
    let reply = post_json(&rig, "/pair-code/resolve", &[], &json!({ "code": closing })).await;
    assert_eq!(reply.status, 404);
    // A request that names no usable lease is answered not-ok.
    let refused = boot(true).await;
    refused.frame(&json!({ "type": "pair-code-request", "lease": "short" })).await;
    assert_eq!(refused.leg.frames_of("pair-code-issued"), vec![json!({ "type": "pair-code-issued", "lease": "short", "ok": false })]);
    refused.finish().await;
    rig.finish().await;
}
