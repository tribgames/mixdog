//! The media byte lane: route and path validation, encrypted bytes passed as sent, header neutralisation, credentials, per-desktop stream limits, timeouts, cancellation and backpressure.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use mixdog_relay::http1::{Handler, HandlerFuture, Limits, Request, ResponseWriter, UpgradeRequest, fail_request};
use mixdog_relay::legs::desktop::DesktopHandle;
use mixdog_relay::legs::hub::{Hub, HubConfig, LegSocket};
use mixdog_relay::legs::ingress::IngressPool;
use mixdog_relay::media::{MediaOptions, MediaProxy, media_response_headers};
use mixdog_relay::net::Server;
use mixdog_relay::rate_limit::RateLimiter;
use mixdog_relay::store::{DeviceStore, ProfileInput};
use mixdog_relay::ws::FlushCallback;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const DEVICE: &str = "6f1d3c2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f";
const SECRET: &str = "0123456789abcdef";
const ASSET: &str = "0123456789abcdef";
const SID: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// ---- the desktop leg stand-in ----

struct Fake {
    sent: Mutex<Vec<String>>,
}

impl Fake {
    fn lock(&self) -> MutexGuard<'_, Vec<String>> {
        self.sent.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Every JSON frame of one type sent to the desktop, in order.
    fn frames_of(&self, kind: &str) -> Vec<Value> {
        let texts: Vec<String> = self.lock().clone();
        texts
            .iter()
            .map(|text| mixdog_relay::js::parse(text).expect("a JSON frame"))
            .filter(|value| value.get("type").and_then(Value::as_str) == Some(kind))
            .collect()
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
        self.lock().push(String::from_utf8_lossy(&text).into_owned());
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

// ---- the rig ----

struct Route(Arc<MediaProxy>);

impl Handler for Route {
    fn request(&self, request: Request, mut response: ResponseWriter) -> HandlerFuture {
        let proxy = Arc::clone(&self.0);
        Box::pin(async move {
            if request.url.starts_with("/media/") {
                proxy.handle_request(request, response).await;
            } else {
                fail_request("media", "not a media route", &mut response);
            }
        })
    }

    fn upgrade(&self, _upgrade: UpgradeRequest) {}
}

struct Rig {
    fake: Arc<Fake>,
    handle: DesktopHandle,
    addr: SocketAddr,
    token: String,
    _server: Server,
    _dir: tempfile::TempDir,
}

fn wire(value: &Value) -> Bytes {
    Bytes::from(mixdog_relay::js::wire(value))
}

fn media_options() -> MediaOptions {
    MediaOptions::default()
}

// ---- the phone: a raw HTTP client ----

struct Reply {
    status: u16,
    head: String,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name).then(|| value.trim().to_owned())
        })
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

fn dechunk(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut rest = raw;
    while let Some(at) = rest.windows(2).position(|pair| pair == b"\r\n") {
        let Ok(size) = usize::from_str_radix(String::from_utf8_lossy(&rest[..at]).split(';').next().unwrap_or("").trim(), 16) else { break };
        let tail = &rest[at + 2..];
        if size == 0 || tail.len() < size {
            break;
        }
        out.extend_from_slice(&tail[..size]);
        rest = tail[size..].strip_prefix(b"\r\n").unwrap_or(&[]);
    }
    out
}

fn request_bytes(method: &str, target: &str, headers: &[(&str, &str)]) -> Vec<u8> {
    let mut head = format!("{method} {target} HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n");
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    head.into_bytes()
}

// ---- the media lane and the relay's origin ----

#[test]
fn desktop_media_metadata_cannot_make_the_relay_origin_serve_active_content() {
    let headers = media_response_headers(Some(&json!({
        "content-type": "image/svg+xml",
        "content-length": 12,
        "set-cookie": "session=stolen",
        "content-security-policy": "default-src *",
    })));
    let get = |name: &str| headers.iter().find(|(existing, _)| *existing == name).map(|(_, value)| value.as_str());
    assert_eq!(get("Content-Type"), Some("application/octet-stream"));
    assert_eq!(get("Content-Length"), Some("12"));
    assert_eq!(get("Set-Cookie"), None);
    assert_eq!(get("X-Content-Type-Options"), Some("nosniff"));
    assert_eq!(get("Content-Disposition"), Some("attachment"));
    assert_eq!(get("Content-Security-Policy"), Some("default-src 'none'; sandbox"));
    let passthrough = media_response_headers(Some(&json!({ "content-type": "video/mp4", "accept-ranges": "bytes" })));
    assert!(passthrough.contains(&("Content-Type", "video/mp4".to_owned())));
    assert!(passthrough.contains(&("Accept-Ranges", "bytes".to_owned())));
}

impl Rig {
    async fn send(&self, frame: Value) {
        self.handle.frame(wire(&frame), false).await;
    }

    /// The desktop answers a request with a head.
    async fn head(&self, id: &str, status: u16, headers: Value) {
        self.send(json!({ "type": "media-head", "id": id, "status": status, "headers": headers })).await;
    }

    async fn chunk(&self, id: &str, data: &[u8]) {
        self.send(json!({ "type": "media-chunk", "id": id, "data": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, data) })).await;
    }

    async fn end(&self, id: &str) {
        self.send(json!({ "type": "media-end", "id": id })).await;
    }

    /// The `n`th `media-request` the relay sent the desktop, once it has.
    async fn request_frame(&self, n: usize) -> Value {
        for _ in 0..500 {
            let frames = self.fake.frames_of("media-request");
            if frames.len() > n {
                return frames[n].clone();
            }
            mixdog_rt::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the relay never sent media-request number {n}");
    }

    /// Waits until the desktop has been sent `count` frames of a type.
    async fn frames(&self, kind: &str, count: usize) -> Vec<Value> {
        for _ in 0..500 {
            let frames = self.fake.frames_of(kind);
            if frames.len() >= count {
                return frames;
            }
            mixdog_rt::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the relay never sent {count} {kind} frame(s)");
    }

    fn path(&self, query: &str) -> String {
        format!("/media/{ASSET}?{query}token={}", self.token)
    }

    async fn get(&self, target: &str) -> Reply {
        call(self.addr, "GET", target, &[]).await
    }
}
async fn rig(options: MediaOptions, lane: bool, unauthorized_limit: usize) -> Rig {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let io = mixdog_rt::testing::tokens().durability_io;
    let store = DeviceStore::open(dir.path(), io).await.expect("the store opens");
    assert!(store.authenticate(DEVICE, SECRET).await);
    let registered = store.register_client(DEVICE, "bbbbbbbb", &ProfileInput::text("Pixel", "android", "chrome")).await.expect("a browser credential");
    let hub = Hub::new(store, HubConfig { max_frame_bytes: 32 * 1024 * 1024, ..HubConfig::default() }, IngressPool::new());
    let fake = Arc::new(Fake { sent: Mutex::new(Vec::new()) });
    let handle = hub.attach_desktop(DEVICE, fake.clone(), None);
    let limiter = Arc::new(Mutex::new(RateLimiter::new(unauthorized_limit, 60_000)));
    let proxy = MediaProxy::start(hub, limiter, options).expect("the media prefix is free");
    let server = Server::start(0, None, Arc::new(Route(proxy)), Limits::default()).await.expect("start the server");
    let addr = ([127, 0, 0, 1], server.port()).into();
    let rig = Rig { fake, handle, addr, token: registered.token, _server: server, _dir: dir };
    if lane {
        rig.send(json!({ "type": "desktop-lanes", "media": true })).await;
    }
    rig
}
/// Reads until the server closes the connection (every request asks for `Connection: close`).
async fn read_reply(stream: &mut TcpStream) -> Reply {
    let mut out = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    let _ = mixdog_rt::time::timeout(Duration::from_secs(10), async {
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(count) => out.extend_from_slice(&chunk[..count]),
            }
        }
    })
    .await;
    let split = out.windows(4).position(|window| window == b"\r\n\r\n").unwrap_or(out.len());
    let head = String::from_utf8_lossy(&out[..split]).into_owned();
    let body = out.get(split + 4..).unwrap_or(&[]).to_vec();
    let status = head.split(' ').nth(1).and_then(|code| code.parse().ok()).unwrap_or_else(|| panic!("no status in {head:?}"));
    let chunked = head.lines().any(|line| line.eq_ignore_ascii_case("Transfer-Encoding: chunked"));
    Reply { status, head, body: if chunked { dechunk(&body) } else { body } }
}
async fn call(addr: SocketAddr, method: &str, target: &str, headers: &[(&str, &str)]) -> Reply {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream.write_all(&request_bytes(method, target, headers)).await.expect("write the request");
    read_reply(&mut stream).await
}
/// A request that is not read yet, as a task.
fn pending_call(addr: SocketAddr, method: &'static str, target: String, headers: Vec<(&'static str, String)>) -> tokio::task::JoinHandle<Reply> {
    tokio::spawn(async move {
        let pairs: Vec<(&str, &str)> = headers.iter().map(|(name, value)| (*name, value.as_str())).collect();
        call(addr, method, &target, &pairs).await
    })
}
// ---- the media lane's streams ----

#[tokio::test]
async fn the_media_route_accepts_the_download_variant_and_still_refuses_unknown_ones() {
    let rig = rig(media_options(), true, 60).await;
    let bogus = rig.get(&rig.path("variant=bogus&")).await;
    assert_eq!((bogus.status, bogus.text().as_str()), (404, "Not found."));
    assert!(rig.fake.frames_of("media-request").is_empty());
    for (query, variant) in [("variant=download&", "download"), ("", "original"), ("variant=&", "original")] {
        let phone = pending_call(rig.addr, "GET", rig.path(query), Vec::new());
        let frame = rig.request_frame(rig.fake.frames_of("media-request").len()).await;
        assert_eq!(frame["variant"], variant);
        assert_eq!(frame["assetId"], ASSET);
        rig.end(frame["id"].as_str().expect("an id")).await;
        assert_eq!(phone.await.expect("the phone").status, 502);
    }
}
#[tokio::test]
async fn malformed_media_paths_answer_400_without_consulting_the_store() {
    let rig = rig(media_options(), true, 60).await;
    for target in ["/media/%", "/media/%ZZ", "/media/%E2%82"] {
        let reply = rig.get(target).await;
        assert_eq!(reply.status, 400, "{target}");
        assert_eq!(reply.text(), "Bad request.");
    }
    let reply = call(rig.addr, "POST", "/media/abc", &[]).await;
    assert_eq!(reply.status, 405);
    assert!(reply.body.is_empty());
}
#[tokio::test]
async fn a_malformed_media_path_answers_400_and_leaves_the_relay_serving() {
    let rig = rig(media_options(), true, 60).await;
    assert_eq!(rig.get("/media/%").await.status, 400);
    assert_eq!(rig.get("/media/%ZZ").await.status, 400);
    // The relay still answers: an unknown route under the lane is a plain 404 after a good credential.
    assert_eq!(rig.get(&format!("/media/nothex?token={}", rig.token)).await.status, 404);
}
#[tokio::test]
async fn encrypted_media_bytes_reach_the_phone_exactly_as_the_desktop_sent_them() {
    let rig = rig(media_options(), true, 60).await;
    let target = rig.path(&format!("variant=display&sid={SID}&enc=e2ee1&"));
    let phone = pending_call(rig.addr, "GET", target, vec![("Range", "bytes=65536-131071".to_owned())]);
    let frame = rig.request_frame(0).await;
    assert_eq!(frame["type"], "media-request");
    assert_eq!(frame["sid"], SID);
    assert_eq!(frame["enc"], "e2ee1");
    assert_eq!(frame["range"], "bytes=65536-131071");
    assert_eq!(frame["ifNoneMatch"], "");
    assert_eq!(frame["method"], "GET");
    assert_eq!(frame["variant"], "display");
    let id = frame["id"].as_str().expect("an id").to_owned();
    // Arbitrary bytes stand in for AES-GCM output: nothing may alter them.
    let ciphertext: Vec<u8> = (0..600u32).map(|index| ((index * 37 + 11) & 0xff) as u8).collect();
    rig.head(&id, 200, json!({ "Content-Type": "application/octet-stream" })).await;
    rig.chunk(&id, &ciphertext[..100]).await;
    rig.chunk(&id, &ciphertext[100..]).await;
    rig.end(&id).await;
    let reply = phone.await.expect("the phone");
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("Content-Type").as_deref(), Some("application/octet-stream"));
    assert_eq!(reply.body, ciphertext);
}
#[tokio::test]
async fn a_plaintext_era_request_is_forwarded_without_the_scheme_marker_so_the_desktop_can_refuse_it() {
    let rig = rig(media_options(), true, 60).await;
    let phone = pending_call(rig.addr, "GET", rig.path("variant=thumb&"), vec![("If-None-Match", "\"tag\"".to_owned())]);
    let frame = rig.request_frame(0).await;
    assert_eq!(frame["sid"], "");
    assert_eq!(frame["enc"], "");
    assert_eq!(frame["range"], "");
    assert_eq!(frame["ifNoneMatch"], "\"tag\"");
    rig.end(frame["id"].as_str().expect("an id")).await;
    phone.await.expect("the phone");
    let bad = rig.get(&rig.path("enc=%20%20&")).await;
    assert_eq!((bad.status, bad.text().as_str()), (400, "Bad request."));
    assert_eq!(rig.get(&rig.path(&format!("enc={}&", "x".repeat(17)))).await.status, 400);
    assert_eq!(rig.fake.frames_of("media-request").len(), 1);
}
#[tokio::test]
async fn a_malformed_session_label_is_refused_before_the_desktop_is_asked() {
    let rig = rig(media_options(), true, 60).await;
    let reply = rig.get(&rig.path("sid=short&")).await;
    assert_eq!((reply.status, reply.text().as_str()), (400, "Bad request."));
    assert!(rig.fake.frames_of("media-request").is_empty());
}
#[tokio::test]
async fn an_older_desktop_that_announced_media_false_is_answered_503_without_a_request() {
    let rig = rig(media_options(), false, 60).await;
    rig.send(json!({ "type": "desktop-lanes", "media": false })).await;
    let reply = rig.get(&rig.path(&format!("sid={SID}&"))).await;
    assert_eq!((reply.status, reply.text().as_str()), (503, "Desktop media lane unsupported."));
    assert!(rig.fake.frames_of("media-request").is_empty());
}
#[tokio::test]
async fn a_vanished_desktop_closes_half_written_media_responses() {
    let rig = rig(media_options(), true, 60).await;
    let waiting = pending_call(rig.addr, "GET", rig.path(""), Vec::new());
    let started = pending_call(rig.addr, "GET", rig.path(""), Vec::new());
    let first = rig.request_frame(0).await;
    let second = rig.request_frame(1).await;
    // Which phone is which is the order its connection arrived in: the request that got a head is the half written one, the
    // other has had no answer at all.
    assert_ne!(first["id"], second["id"]);
    let started_id = second["id"].as_str().expect("an id").to_owned();
    rig.head(&started_id, 200, json!({ "Content-Type": "video/mp4" })).await;
    rig.chunk(&started_id, b"partial").await;
    mixdog_rt::time::sleep(Duration::from_millis(50)).await;
    rig.handle.closed();
    let (a, b) = (waiting.await.expect("the first phone"), started.await.expect("the second phone"));
    let (unanswered, half) = if a.status == 503 { (a, b) } else { (b, a) };
    assert_eq!(unanswered.status, 503);
    assert_eq!(half.status, 200);
    assert_eq!(half.body, b"partial");
}
#[tokio::test]
async fn a_proxied_media_answer_is_neutralised_at_the_relay_origin() {
    let rig = rig(media_options(), true, 60).await;
    let phone = pending_call(rig.addr, "GET", format!("/media/6f1d3c2e-8a4b-4c5d-9e7f-0a1b2c3d4e5f?token={}", rig.token), Vec::new());
    let frame = rig.request_frame(0).await;
    let id = frame["id"].as_str().expect("an id").to_owned();
    // A compromised or buggy desktop answering with an active type and its own headers must not get either past this hop.
    rig.head(
        &id,
        200,
        json!({
            "content-type": "text/html; charset=utf-8",
            "content-length": 5,
            "set-cookie": "session=stolen",
            "content-security-policy": "default-src *",
        }),
    )
    .await;
    rig.chunk(&id, b"<h1>x").await;
    rig.end(&id).await;
    let reply = phone.await.expect("the phone");
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("Content-Type").as_deref(), Some("application/octet-stream"));
    assert_eq!(reply.header("Content-Disposition").as_deref(), Some("attachment"));
    assert_eq!(reply.header("X-Content-Type-Options").as_deref(), Some("nosniff"));
    assert_eq!(reply.header("Set-Cookie"), None);
    assert!(reply.header("Content-Security-Policy").is_some_and(|policy| policy.contains("default-src 'none'")));
    assert_eq!(reply.text(), "<h1>x");
}
// ---- the rest of the lane ----

#[tokio::test]
async fn a_caller_without_a_known_credential_is_refused_and_throttled() {
    let rig = rig(media_options(), true, 2).await;
    let anonymous = rig.get(&format!("/media/{ASSET}")).await;
    assert_eq!((anonymous.status, anonymous.text().as_str()), (401, "Unauthorized."));
    assert_eq!(rig.get(&format!("/media/{ASSET}?token=deadbeef")).await.status, 401);
    let throttled = rig.get(&format!("/media/{ASSET}")).await;
    assert_eq!((throttled.status, throttled.header("Retry-After").as_deref()), (429, Some("60")));
    assert!(rig.fake.frames_of("media-request").is_empty());
}
#[tokio::test]
async fn the_credential_may_ride_the_pairing_cookie() {
    let rig = rig(media_options(), true, 60).await;
    let cookie = format!("mixdog_token={}", rig.token);
    let phone = pending_call(rig.addr, "GET", format!("/media/{ASSET}"), vec![("Cookie", cookie)]);
    let frame = rig.request_frame(0).await;
    rig.end(frame["id"].as_str().expect("an id")).await;
    assert_eq!(phone.await.expect("the phone").status, 502);
}
#[tokio::test]
async fn the_health_probe_reports_the_lane_of_the_desktop_that_would_serve_the_bytes() {
    let silent = rig(media_options(), false, 60).await;
    let unsupported = silent.get(&format!("/media/healthz?token={}", silent.token)).await;
    assert_eq!((unsupported.status, unsupported.text().as_str()), (503, "{\"status\":\"unsupported\"}"));
    assert_eq!(unsupported.header("Content-Type").as_deref(), Some("application/json"));
    silent.send(json!({ "type": "desktop-lanes", "media": true })).await;
    let ok = silent.get(&format!("/media/healthz?token={}", silent.token)).await;
    assert_eq!((ok.status, ok.text().as_str()), (200, "{\"status\":\"ok\"}"));
    let head = call(silent.addr, "HEAD", &format!("/media/healthz?token={}", silent.token), &[]).await;
    assert_eq!(head.status, 200);
    assert_eq!(silent.get("/media/healthz").await.status, 401);
}
#[tokio::test]
async fn a_device_without_a_desktop_is_answered_offline() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let store = DeviceStore::open(dir.path(), mixdog_rt::testing::tokens().durability_io).await.expect("the store opens");
    assert!(store.authenticate(DEVICE, SECRET).await);
    let token = store.register_client(DEVICE, "bbbbbbbb", &ProfileInput::text("Pixel", "android", "chrome")).await.expect("a credential").token;
    let hub = Hub::new(store, HubConfig::default(), IngressPool::new());
    let proxy = MediaProxy::start(hub, Arc::new(Mutex::new(RateLimiter::new(60, 60_000))), media_options()).expect("the prefix is free");
    let server = Server::start(0, None, Arc::new(Route(proxy)), Limits::default()).await.expect("start the server");
    let addr: SocketAddr = ([127, 0, 0, 1], server.port()).into();
    let reply = call(addr, "GET", &format!("/media/{ASSET}?token={token}"), &[]).await;
    assert_eq!((reply.status, reply.text().as_str()), (503, "Desktop offline."));
    let health = call(addr, "GET", &format!("/media/healthz?token={token}"), &[]).await;
    assert_eq!((health.status, health.text().as_str()), (503, "{\"status\":\"unsupported\"}"));
}
#[tokio::test]
async fn a_desktop_holds_at_most_the_streams_the_lane_allows() {
    let rig = rig(MediaOptions { max_streams: 2, ..media_options() }, true, 60).await;
    let first = pending_call(rig.addr, "GET", rig.path(""), Vec::new());
    let second = pending_call(rig.addr, "GET", rig.path(""), Vec::new());
    let ids = [rig.request_frame(0).await["id"].clone(), rig.request_frame(1).await["id"].clone()];
    let refused = rig.get(&rig.path("")).await;
    assert_eq!((refused.status, refused.text().as_str()), (503, "Too many media streams."));
    assert_eq!(refused.header("Retry-After").as_deref(), Some("1"));
    assert_eq!(rig.fake.frames_of("media-request").len(), 2);
    // A stream that ends gives its place back.
    rig.end(ids[0].as_str().expect("an id")).await;
    let again = pending_call(rig.addr, "GET", rig.path(""), Vec::new());
    let frame = rig.request_frame(2).await;
    rig.end(frame["id"].as_str().expect("an id")).await;
    rig.end(ids[1].as_str().expect("an id")).await;
    for phone in [first, second, again] {
        assert_eq!(phone.await.expect("a phone").status, 502);
    }
}
#[tokio::test]
async fn a_desktop_that_never_answers_times_out_with_504_and_is_told_to_stop() {
    let rig = rig(MediaOptions { head_timeout: Duration::from_millis(200), ..media_options() }, true, 60).await;
    let phone = pending_call(rig.addr, "GET", rig.path(""), Vec::new());
    let frame = rig.request_frame(0).await;
    let reply = phone.await.expect("the phone");
    assert_eq!(reply.status, 504);
    let aborts = rig.frames("media-abort", 1).await;
    assert_eq!(aborts[0]["id"], frame["id"]);
    // A late frame finds nothing waiting and is ignored.
    rig.head(frame["id"].as_str().expect("an id"), 200, json!({})).await;
}
#[tokio::test]
async fn a_desktop_that_goes_quiet_mid_clip_ends_the_response_and_is_told_to_stop() {
    let rig = rig(MediaOptions { stall_timeout: Duration::from_millis(200), ..media_options() }, true, 60).await;
    let phone = pending_call(rig.addr, "GET", rig.path(""), Vec::new());
    let frame = rig.request_frame(0).await;
    let id = frame["id"].as_str().expect("an id").to_owned();
    rig.head(&id, 206, json!({ "Content-Range": "bytes 0-9/100" })).await;
    rig.chunk(&id, b"0123456789").await;
    let reply = phone.await.expect("the phone");
    assert_eq!(reply.status, 206);
    assert_eq!(reply.header("Content-Range").as_deref(), Some("bytes 0-9/100"));
    assert_eq!(reply.body, b"0123456789");
    assert_eq!(rig.frames("media-abort", 1).await[0]["id"], frame["id"]);
}
#[tokio::test]
async fn a_desktop_error_before_any_head_is_a_502_and_one_after_it_ends_the_body() {
    let rig = rig(media_options(), true, 60).await;
    let early = pending_call(rig.addr, "GET", rig.path(""), Vec::new());
    let frame = rig.request_frame(0).await;
    rig.send(json!({ "type": "media-error", "id": frame["id"] })).await;
    assert_eq!(early.await.expect("the phone").status, 502);
    let late = pending_call(rig.addr, "GET", rig.path(""), Vec::new());
    let frame = rig.request_frame(1).await;
    let id = frame["id"].as_str().expect("an id").to_owned();
    // A chunk before the head is ignored, a status that is no status is a 502, a second head changes nothing.
    rig.chunk(&id, b"ignored").await;
    rig.head(&id, 99, json!({})).await;
    rig.head(&id, 200, json!({})).await;
    rig.chunk(&id, b"kept").await;
    rig.send(json!({ "type": "media-error", "id": id })).await;
    let reply = late.await.expect("the phone");
    assert_eq!(reply.status, 502);
    assert_eq!(reply.body, b"kept");
}
#[tokio::test]
async fn a_head_request_is_forwarded_as_a_head_and_gets_no_body() {
    let rig = rig(media_options(), true, 60).await;
    let phone = pending_call(rig.addr, "HEAD", rig.path(""), Vec::new());
    let frame = rig.request_frame(0).await;
    assert_eq!(frame["method"], "HEAD");
    let id = frame["id"].as_str().expect("an id").to_owned();
    rig.head(&id, 200, json!({ "content-length": 4, "etag": "\"a\"" })).await;
    rig.end(&id).await;
    let reply = phone.await.expect("the phone");
    assert_eq!(reply.status, 200);
    assert_eq!(reply.header("Content-Length").as_deref(), Some("4"));
    assert_eq!(reply.header("ETag").as_deref(), Some("\"a\""));
    assert!(reply.body.is_empty());
}
#[tokio::test]
async fn a_phone_that_goes_away_mid_clip_tells_the_desktop_to_stop() {
    let rig = rig(media_options(), true, 60).await;
    let mut stream = TcpStream::connect(rig.addr).await.expect("connect");
    stream.write_all(&request_bytes("GET", &rig.path(""), &[])).await.expect("write the request");
    let frame = rig.request_frame(0).await;
    let id = frame["id"].as_str().expect("an id").to_owned();
    rig.head(&id, 200, json!({})).await;
    rig.chunk(&id, b"first").await;
    let mut seen = [0u8; 64];
    assert!(stream.read(&mut seen).await.expect("the head") > 0);
    drop(stream);
    // The http1 layer learns a phone is gone when a write to it fails, so the desktop keeps sending until the relay notices.
    for _ in 0..200 {
        if !rig.fake.frames_of("media-abort").is_empty() {
            break;
        }
        rig.chunk(&id, &[1u8; 16 * 1024]).await;
        mixdog_rt::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(rig.frames("media-abort", 1).await[0]["id"], frame["id"]);
}
#[tokio::test]
async fn a_response_that_fills_up_pauses_the_desktop_and_resumes_it_once_it_drains() {
    let rig = rig(MediaOptions { pause_bytes: 64 * 1024, ..media_options() }, true, 60).await;
    let mut stream = TcpStream::connect(rig.addr).await.expect("connect");
    stream.write_all(&request_bytes("GET", &rig.path(""), &[])).await.expect("write the request");
    let frame = rig.request_frame(0).await;
    let id = frame["id"].as_str().expect("an id").to_owned();
    rig.head(&id, 200, json!({})).await;
    // One chunk of more than the pause mark: it is still queued when the relay looks.
    rig.chunk(&id, &vec![7u8; 512 * 1024]).await;
    assert_eq!(rig.frames("media-pause", 1).await[0]["id"], frame["id"]);
    // The phone reads: the response drains and the desktop is let go on.
    let mut total = 0usize;
    let mut buffer = vec![0u8; 64 * 1024];
    while total < 512 * 1024 {
        let count = stream.read(&mut buffer).await.expect("read");
        assert!(count > 0, "the response ended early");
        total += count;
    }
    assert_eq!(rig.frames("media-resume", 1).await[0]["id"], frame["id"]);
    rig.end(&id).await;
}
#[tokio::test]
async fn a_response_that_stops_draining_is_cut_and_the_desktop_is_told_to_stop() {
    let rig = rig(MediaOptions { pause_bytes: 16 * 1024, kill_bytes: 256 * 1024, ..media_options() }, true, 60).await;
    let mut stream = TcpStream::connect(rig.addr).await.expect("connect");
    stream.write_all(&request_bytes("GET", &rig.path(""), &[])).await.expect("write the request");
    let frame = rig.request_frame(0).await;
    let id = frame["id"].as_str().expect("an id").to_owned();
    rig.head(&id, 200, json!({})).await;
    rig.chunk(&id, &vec![9u8; 1024 * 1024]).await;
    assert_eq!(rig.frames("media-abort", 1).await[0]["id"], frame["id"]);
    // The connection is destroyed: the phone never sees the whole body, and no pause was asked for a stream that was cut.
    let mut seen = Vec::new();
    let _ = mixdog_rt::time::timeout(Duration::from_secs(10), stream.read_to_end(&mut seen)).await;
    assert!(seen.len() < 1024 * 1024);
    assert!(rig.fake.frames_of("media-pause").is_empty());
}
