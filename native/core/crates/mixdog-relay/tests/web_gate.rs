//! The static gate: each test runs a whole exchange over a connection against `StaticGate` on a renderer tree built in a temporary folder.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mixdog_fsio::Unlaned;
use mixdog_relay::http1::{ConnInfo, Handler, HandlerFuture, Lifecycle, Limits, Request, ResponseWriter, UpgradeRequest, serve_connection};
use mixdog_relay::rate_limit::RateLimiter;
use mixdog_relay::web::device_route::{DeviceRoute, parse_device_route};
use mixdog_relay::web::gate::{GateStore, PUBLIC_APP_ASSETS, StaticGate, share_target_shell};
use mixdog_relay::web::headers::{
    DEVICE_COOKIE_NAME, PAIRING_COOKIE_NAME, cookie_credential_allowed, device_cookie_headers, pairing_cookie_headers, request_cookie_token,
};
use mixdog_relay::web::preview::PREVIEW_FRAME_CSP;
use mixdog_relay::web::releases::{DeviceReport, RendererCatalog};
use mixdog_rt::InteractiveIo;
use mixdog_rt::time::timeout;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const DEVICE: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TOKEN: &str = "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0";
const NATIVE_APP: &str = "Mozilla/5.0 MixdogApp/1.0";

/// Headers of a fetch or subresource from the opaque-origin preview frame.
const FROM_PREVIEW_FRAME: [(&str, &str); 4] =
    [("Origin", "null"), ("Sec-Fetch-Site", "cross-site"), ("Sec-Fetch-Mode", "cors"), ("Sec-Fetch-Dest", "empty")];

fn write(path: &Path, bytes: impl AsRef<[u8]>) {
    mixdog_fsio::create_dir_all(&Unlaned, path.parent().unwrap()).unwrap();
    mixdog_fsio::write(&Unlaned, path, bytes).unwrap();
}

/// What the store of the relay knows: one paired token, the known devices and what they reported.
#[derive(Default)]
struct FakeStore {
    tokens: HashMap<String, String>,
    known: Vec<String>,
    versions: HashMap<String, DeviceReport>,
}

impl GateStore for FakeStore {
    fn device_id_for_client_token(&self, token: &str) -> Option<String> {
        self.tokens.get(token).cloned()
    }

    fn is_known(&self, device_id: &str) -> bool {
        self.known.iter().any(|known| known == device_id)
    }

    fn device_version(&self, device_id: &str) -> DeviceReport {
        self.versions.get(device_id).cloned().unwrap_or_default()
    }
}

struct GateHandler(Arc<StaticGate>);

impl Handler for GateHandler {
    fn request(&self, request: Request, response: ResponseWriter) -> HandlerFuture {
        let gate = self.0.clone();
        Box::pin(async move {
            let mut response = response;
            gate.serve(&request, &mut response).await;
        })
    }

    fn upgrade(&self, _upgrade: UpgradeRequest) {}
}

struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    fn cookies(&self) -> Vec<&str> {
        self.headers.iter().filter(|(key, _)| key.eq_ignore_ascii_case("set-cookie")).map(|(_, value)| value.as_str()).collect()
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

fn decode_chunked(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let line_end = data.windows(2).position(|pair| pair == b"\r\n").unwrap();
        let size = usize::from_str_radix(std::str::from_utf8(&data[..line_end]).unwrap(), 16).unwrap();
        data = &data[line_end + 2..];
        if size == 0 {
            return out;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
}

fn paired_store() -> FakeStore {
    FakeStore {
        tokens: HashMap::from([(TOKEN.to_owned(), DEVICE.to_owned())]),
        known: vec![DEVICE.to_owned()],
        versions: HashMap::new(),
    }
}

const MANIFEST: &str = r#"{"id":"/","name":"Mixdog","start_url":"/","scope":"/","share_target":{"action":"/share-target","method":"POST"}}"#;

/// A renderer tree with the shell, the manifest and one icon.
fn renderer(root: &Path) -> std::path::PathBuf {
    let dir = root.join("renderer");
    write(&dir.join("index.html"), "<!doctype html><title>Mixdog</title>");
    write(&dir.join("manifest.webmanifest"), MANIFEST);
    write(&dir.join("mixdog-192.png"), "png");
    dir
}

fn open_limiter() -> RateLimiter {
    RateLimiter::new(1000, 60_000)
}

// ---- the static gate ----

#[test]
fn device_routes_require_a_trailing_slash_before_they_can_resolve_relative_assets() {
    assert_eq!(parse_device_route("/nope"), None);
    let route = |redirect: bool, rest: &str| Some(DeviceRoute { device_id: DEVICE.to_owned(), redirect, rest: rest.to_owned() });
    assert_eq!(parse_device_route(&format!("/d/{DEVICE}")), route(true, "/index.html"));
    assert_eq!(parse_device_route(&format!("/d/{DEVICE}/")), route(false, "/index.html"));
    assert_eq!(parse_device_route(&format!("/d/{DEVICE}/boot.js")), route(false, "/boot.js"));
    // The id is a routing id; `.` of the rest does not match a line terminator.
    assert_eq!(parse_device_route("/d/NOT-A-ROUTING-ID/"), None);
    assert_eq!(parse_device_route("/d//x"), None);
    assert_eq!(parse_device_route(&format!("/d/{DEVICE}/a\nb")), None);
}

#[test]
fn installability_assets_are_the_only_pairing_gate_exemptions() {
    assert_eq!(PUBLIC_APP_ASSETS, ["/manifest.webmanifest", "/mixdog.svg", "/mixdog-logo-titanium.svg", "/mixdog-192.png", "/mixdog-512.png"]);
}

// ---- the preview frame ----

#[test]
fn relay_cookies_are_samesite_lax_host_only_and_the_pairing_token_is_httponly() {
    let pairing = regex::Regex::new(&format!("^{PAIRING_COOKIE_NAME}=[^;]+; Path=/; Max-Age=\\d+; HttpOnly; SameSite=Lax")).unwrap();
    for encrypted in [false, true] {
        let pairing_headers = pairing_cookie_headers(TOKEN, encrypted);
        let device_headers = device_cookie_headers("device-1", encrypted);
        for headers in [&pairing_headers, &device_headers] {
            let cookie = headers.get("Set-Cookie").unwrap();
            assert!(cookie.contains("; SameSite=Lax"), "{cookie}");
            assert!(!cookie.contains("SameSite=None") && !cookie.to_lowercase().contains("domain="), "{cookie}");
            assert_eq!(cookie.ends_with("; Secure"), encrypted, "{cookie}");
        }
        assert!(pairing.is_match(pairing_headers.get("Set-Cookie").unwrap()));
        assert!(device_headers.get("Set-Cookie").unwrap().starts_with(&format!("{DEVICE_COOKIE_NAME}=device-1;")));
    }
}

#[test]
fn no_relay_code_sets_a_cookie_except_through_the_cookie_builders() {
    fn walk(dir: &Path, found: &mut Vec<String>) {
        for entry in mixdog_fsio::read_dir(&Unlaned, dir).unwrap() {
            let path = entry.unwrap().path();
            if mixdog_fsio::is_dir(&Unlaned, &path) {
                walk(&path, found);
            } else if path.extension().is_some_and(|extension| extension == "rs")
                && mixdog_fsio::read_to_string(&Unlaned, &path).unwrap().split("#[cfg(test)]").next().unwrap_or_default().contains("\"Set-Cookie\"")
            {
                found.push(path.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut found = Vec::new();
    walk(&src, &mut found);
    let root = format!("{}/", src.to_string_lossy().replace('\\', "/"));
    let relative: Vec<&str> = found.iter().map(|path| path.strip_prefix(root.as_str()).unwrap_or(path)).collect();
    assert_eq!(relative, ["web/headers.rs"]);
}

fn request_headers(pairs: &[(&str, &str)]) -> mixdog_relay::http1::Headers {
    let mut headers = mixdog_relay::http1::Headers::default();
    for (name, value) in pairs {
        headers.add(&name.to_ascii_lowercase(), (*value).to_owned());
    }
    headers
}

#[test]
fn a_cookie_authenticates_only_same_origin_browser_initiated_or_top_level_navigation_requests() {
    let fetch_metadata = |site: &'static str, mode: &'static str, dest: &'static str| {
        [("Sec-Fetch-Site", site), ("Sec-Fetch-Mode", mode), ("Sec-Fetch-Dest", dest)]
    };
    let allowed: Vec<Vec<(&str, &str)>> = vec![
        vec![],
        fetch_metadata("same-origin", "cors", "empty").to_vec(),
        fetch_metadata("none", "navigate", "document").to_vec(),
        fetch_metadata("cross-site", "navigate", "document").to_vec(),
    ];
    for headers in &allowed {
        assert!(cookie_credential_allowed(&request_headers(headers)), "{headers:?}");
    }
    let refused: Vec<Vec<(&str, &str)>> = vec![
        FROM_PREVIEW_FRAME.to_vec(),
        vec![("Origin", "null")],
        fetch_metadata("cross-site", "no-cors", "image").to_vec(),
        // The frame navigating itself (a nested frame) to a relay URL.
        fetch_metadata("cross-site", "navigate", "iframe").to_vec(),
        fetch_metadata("same-site", "cors", "empty").to_vec(),
    ];
    for headers in &refused {
        assert!(!cookie_credential_allowed(&request_headers(headers)), "{headers:?}");
    }
    let cookie = format!("{PAIRING_COOKIE_NAME}={TOKEN}");
    assert_eq!(request_cookie_token(&request_headers(&[("Cookie", &cookie)])), TOKEN);
    let mut framed = FROM_PREVIEW_FRAME.to_vec();
    framed.push(("Cookie", &cookie));
    assert_eq!(request_cookie_token(&request_headers(&framed)), "");
}


fn io() -> InteractiveIo {
    mixdog_rt::testing::tokens().interactive_io
}
/// One request over its own connection, answered by `gate`.
async fn exchange(gate: &Arc<GateHandler>, method: &str, target: &str, headers: &[(&str, &str)]) -> Answer {
    let mut raw = format!("{method} {target} HTTP/1.1\r\nHost: relay\r\nConnection: close\r\nContent-Length: 0\r\n");
    for (name, value) in headers {
        raw.push_str(&format!("{name}: {value}\r\n"));
    }
    raw.push_str("\r\n");
    let (mut client, server) = tokio::io::duplex(64 * 1024);
    let served = tokio::spawn(serve_connection(
        server,
        ConnInfo { remote_address: Some("203.0.113.9".to_owned()), encrypted: false },
        gate.clone() as Arc<dyn Handler>,
        Limits::default(),
        Arc::new(Lifecycle::default()),
    ));
    client.write_all(raw.as_bytes()).await.unwrap();
    let mut data = Vec::new();
    timeout(Duration::from_secs(10), client.read_to_end(&mut data)).await.expect("the connection answers").unwrap();
    served.await.unwrap();
    let split = data.windows(4).position(|window| window == b"\r\n\r\n").expect("a head");
    let head = std::str::from_utf8(&data[..split]).unwrap();
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
    let mut answered = Vec::new();
    let mut chunked = false;
    for line in lines {
        let (name, value) = line.split_once(": ").unwrap();
        chunked |= name.eq_ignore_ascii_case("transfer-encoding");
        answered.push((name.to_owned(), value.to_owned()));
    }
    let body = &data[split + 4..];
    Answer { status, headers: answered, body: if chunked { decode_chunked(body) } else { body.to_vec() } }
}
fn gate_for(renderer: &Path, releases: &Path, store: FakeStore, limiter: RateLimiter) -> Arc<GateHandler> {
    let catalog = Arc::new(RendererCatalog::new(renderer, releases));
    Arc::new(GateHandler(Arc::new(StaticGate::new(io(), catalog, Arc::new(store), Arc::new(Mutex::new(limiter))))))
}
#[tokio::test]
async fn a_share_post_that_outran_the_worker_reopens_the_app_shell() {
    assert_eq!(share_target_shell(&format!("/d/{DEVICE}/share-target")), format!("/d/{DEVICE}/"));
    assert_eq!(share_target_shell("/share-target"), "/");
    assert_eq!(share_target_shell("/other"), "");
    assert_eq!(share_target_shell("/share-target?source=share#ignored"), "/");
    assert_eq!(share_target_shell("/%73hare-target"), "/");
    assert_eq!(share_target_shell("/d/aaaaaaaa/share-target"), "/d/aaaaaaaa/");
    assert_eq!(share_target_shell("/share-target%"), "");
    assert_eq!(share_target_shell("http://["), "");
    assert_eq!(share_target_shell(""), "");
    let gate = gate_for(Path::new(""), Path::new(""), FakeStore::default(), open_limiter());
    let answer = exchange(&gate, "POST", &format!("/d/{DEVICE}/share-target"), &[]).await;
    assert_eq!(answer.status, 303);
    assert_eq!(answer.header("Location"), Some(format!("/d/{DEVICE}/").as_str()));
}
#[tokio::test]
async fn the_preview_frame_is_public_sandboxed_cookie_free_and_frameable_only_by_self() {
    let gate = gate_for(Path::new(""), Path::new(""), FakeStore::default(), open_limiter());
    let answer = exchange(&gate, "GET", "/preview-frame", &[]).await;
    assert_eq!(answer.status, 200);
    let csp = answer.header("Content-Security-Policy").unwrap();
    assert_eq!(csp, PREVIEW_FRAME_CSP);
    assert!(csp.split("; ").any(|entry| entry == "sandbox allow-scripts allow-forms allow-modals"));
    // Opaque origin, no escape: never same-origin, top navigation or popups.
    for forbidden in ["allow-same-origin", "allow-top-navigation", "allow-popups"] {
        assert!(!csp.contains(forbidden), "{forbidden}");
    }
    let directives: HashMap<&str, Vec<&str>> = csp
        .split("; ")
        .map(|entry| {
            let mut words = entry.split(' ');
            (words.next().unwrap(), words.collect())
        })
        .collect();
    // Outside network over https only (no http:, ws:, '*' or 'self').
    assert_eq!(directives["default-src"], ["'none'"]);
    assert_eq!(directives["script-src"], ["'unsafe-inline'", "'unsafe-eval'", "blob:", "data:", "https:"]);
    assert_eq!(directives["style-src"], ["'unsafe-inline'", "data:", "https:"]);
    assert_eq!(directives["img-src"], ["data:", "blob:", "https:"]);
    assert_eq!(directives["font-src"], ["data:", "https:"]);
    assert_eq!(directives["media-src"], ["data:", "blob:", "https:"]);
    assert_eq!(directives["connect-src"], ["https:"]);
    assert_eq!(directives["frame-src"], ["https:"]);
    for locked in ["object-src", "base-uri", "form-action"] {
        assert_eq!(directives[locked], ["'none'"], "{locked}");
    }
    let outside = csp.replace("frame-ancestors 'self'", "");
    assert!(!outside.split([' ', ';']).any(|word| matches!(word, "http:" | "ws:" | "wss:" | "*" | "'self'")));
    assert_eq!(directives["frame-ancestors"], ["'self'"]);
    assert_eq!(answer.header("Referrer-Policy"), Some("no-referrer"));
    assert!(answer.cookies().is_empty());
    assert_eq!(answer.header("X-Frame-Options"), None);
    assert_eq!(answer.header("Cache-Control"), Some("public, max-age=300"));
    assert!(answer.header("Content-Type").unwrap().starts_with("text/html"));
    let body = answer.text();
    assert!(body.contains("event.source !== window.parent"));
    assert!(body.contains("mixdog-preview-document"));
    assert_eq!(answer.header("Content-Length"), Some(body.len().to_string().as_str()));
    let head = exchange(&gate, "HEAD", "/preview-frame", &[]).await;
    assert_eq!((head.status, head.body.len()), (200, 0));
    assert_eq!(head.header("Content-Length"), answer.header("Content-Length"));
}
#[tokio::test]
async fn healthz_is_public_and_other_writes_still_405() {
    let gate = gate_for(Path::new(""), Path::new(""), FakeStore::default(), open_limiter());
    let answer = exchange(&gate, "GET", "/healthz", &[]).await;
    assert_eq!(answer.status, 200);
    assert_eq!(answer.header("Content-Type"), Some("application/json"));
    assert_eq!(answer.text(), r#"{"status":"ok"}"#);
    assert_eq!(exchange(&gate, "PUT", "/healthz", &[]).await.status, 405);
    assert_eq!(exchange(&gate, "GET", "/%", &[]).await.status, 400);
}
#[tokio::test]
async fn without_a_renderer_directory_the_gate_answers_404_text_after_healthz() {
    let gate = gate_for(Path::new(""), Path::new(""), paired_store(), open_limiter());
    assert_eq!(exchange(&gate, "GET", "/healthz", &[]).await.status, 200);
    let answer = exchange(&gate, "GET", "/manifest.webmanifest", &[]).await;
    assert_eq!(answer.status, 404);
    assert_eq!(answer.text(), "Mixdog relay: no RENDERER_DIR configured; this relay only forwards WebSocket traffic.");
    assert_eq!(answer.header("Content-Type"), Some("text/plain; charset=utf-8"));
    // The credential check comes first: an unknown caller learns nothing of the configuration.
    assert_eq!(exchange(&gate, "GET", "/", &[]).await.status, 401);
}
#[tokio::test]
async fn a_caller_past_the_unauthorized_limiter_is_throttled() {
    let dir = tempfile::tempdir().unwrap();
    let gate = gate_for(&renderer(dir.path()), Path::new(""), paired_store(), RateLimiter::new(1, 60_000));
    assert_eq!(exchange(&gate, "GET", "/", &[]).await.status, 401);
    let throttled = exchange(&gate, "GET", "/", &[]).await;
    assert_eq!(throttled.status, 429);
    assert_eq!(throttled.header("Retry-After"), Some("60"));
    assert_eq!(throttled.text(), "Too many requests.");
}
#[tokio::test]
async fn the_static_gate_ignores_the_pairing_cookie_on_a_request_from_the_preview_frame() {
    let dir = tempfile::tempdir().unwrap();
    let gate = gate_for(&renderer(dir.path()), Path::new(""), paired_store(), open_limiter());
    let cookie = format!("{PAIRING_COOKIE_NAME}={TOKEN}");
    let mut framed = FROM_PREVIEW_FRAME.to_vec();
    framed.push(("Cookie", &cookie));
    assert_eq!(exchange(&gate, "GET", "/", &framed).await.status, 401);
    let app = [
        ("Cookie", cookie.as_str()),
        ("Sec-Fetch-Site", "same-origin"),
        ("Sec-Fetch-Mode", "cors"),
        ("Sec-Fetch-Dest", "empty"),
    ];
    assert_eq!(exchange(&gate, "GET", "/", &app).await.status, 200, "the app itself still authenticates by cookie");
}
// ---- the gate and the static routes ----

#[tokio::test]
async fn installability_assets_bypass_the_pairing_gate_and_the_app_shell_never_does() {
    let dir = tempfile::tempdir().unwrap();
    let gate = gate_for(&renderer(dir.path()), Path::new(""), FakeStore::default(), open_limiter());
    // Browsers fetch the manifest and its icons without cookies; a 401 there silently breaks "install app" into an icon-less
    // shortcut.
    assert_eq!(exchange(&gate, "GET", "/manifest.webmanifest", &[]).await.status, 200);
    assert_eq!(exchange(&gate, "GET", "/mixdog-192.png", &[]).await.status, 200);
    assert_eq!(exchange(&gate, "GET", "/", &[]).await.status, 401);
    assert_eq!(exchange(&gate, "GET", "/index.html", &[]).await.status, 401);
}
#[tokio::test]
async fn an_unknown_query_token_is_never_persisted_as_the_pairing_cookie() {
    let dir = tempfile::tempdir().unwrap();
    let gate = gate_for(&renderer(dir.path()), Path::new(""), paired_store(), open_limiter());
    // A public asset link carrying someone else's token would otherwise plant an HttpOnly session cookie the visitor can
    // neither see nor clear.
    let planted = exchange(&gate, "GET", &format!("/manifest.webmanifest?token={}", "f".repeat(64)), &[]).await;
    assert_eq!(planted.status, 200);
    assert!(planted.cookies().iter().all(|cookie| !cookie.contains(PAIRING_COOKIE_NAME)));
    let paired = exchange(&gate, "GET", &format!("/manifest.webmanifest?token={TOKEN}"), &[]).await;
    assert!(paired.cookies().iter().any(|cookie| cookie.starts_with(&format!("{PAIRING_COOKIE_NAME}={TOKEN}; "))));
    // The paired token opens the shell too, and a root asset request with the device cookie refreshes that cookie.
    assert_eq!(exchange(&gate, "GET", &format!("/?token={TOKEN}"), &[]).await.status, 200);
    let refreshed = exchange(&gate, "GET", "/mixdog-192.png", &[("Cookie", &format!("{DEVICE_COOKIE_NAME}={DEVICE}"))]).await;
    assert!(refreshed.cookies().iter().any(|cookie| cookie.starts_with(&format!("{DEVICE_COOKIE_NAME}={DEVICE}; "))));
    let both = exchange(&gate, "GET", &format!("/manifest.webmanifest?token={TOKEN}"), &[("Cookie", &format!("{DEVICE_COOKIE_NAME}={DEVICE}"))]).await;
    assert_eq!(both.cookies().len(), 2);
}
#[tokio::test]
async fn the_device_route_opens_the_shell_and_aims_its_manifest_back_at_that_route() {
    let dir = tempfile::tempdir().unwrap();
    let gate = gate_for(&renderer(dir.path()), Path::new(""), paired_store(), open_limiter());
    // A route naming a desktop this relay never registered reveals nothing.
    assert_eq!(exchange(&gate, "GET", "/d/cccccccc/", &[]).await.status, 401);
    // Nor does the bare app shell: it is for approved browsers only.
    assert_eq!(exchange(&gate, "GET", "/", &[]).await.status, 401);
    let bare = exchange(&gate, "GET", &format!("/d/{DEVICE}"), &[]).await;
    assert_eq!(bare.status, 301);
    assert_eq!(bare.header("Location"), Some(format!("/d/{DEVICE}/").as_str()));
    let shell = exchange(&gate, "GET", &format!("/d/{DEVICE}/"), &[]).await;
    assert_eq!(shell.status, 200);
    // The cookie carries the route across the root asset requests that follow.
    assert!(shell.cookies().iter().any(|cookie| cookie.starts_with(&format!("{DEVICE_COOKIE_NAME}={DEVICE};"))));
    let manifest_answer = exchange(&gate, "GET", &format!("/d/{DEVICE}/manifest.webmanifest"), &[]).await;
    assert_eq!(manifest_answer.status, 200);
    let manifest: Value = serde_json::from_slice(&manifest_answer.body).unwrap();
    // An install captures start_url, so it is what tells the installed app which desktop to ask for approval.
    let route = format!("/d/{DEVICE}/");
    for key in ["start_url", "scope", "id"] {
        assert_eq!(manifest[key], route.as_str(), "{key}");
    }
    // An installer drops a share_target action that falls outside the scope.
    assert_eq!(manifest["share_target"]["action"], format!("/d/{DEVICE}/share-target").as_str());
    assert_eq!(manifest["name"], "Mixdog");
    let etag = manifest_answer.header("ETag").unwrap().to_owned();
    let unchanged = exchange(&gate, "GET", &format!("/d/{DEVICE}/manifest.webmanifest"), &[("If-None-Match", &etag)]).await;
    assert_eq!(unchanged.status, 304);
    // Another path under the route resolves in the release of that device, with the device cookie; a miss is a bare 404.
    assert_eq!(exchange(&gate, "GET", &format!("/d/{DEVICE}/mixdog-192.png"), &[]).await.status, 200);
    assert_eq!(exchange(&gate, "GET", &format!("/d/{DEVICE}/missing.js"), &[]).await.status, 404);
}
#[tokio::test]
async fn a_share_post_reopens_the_shell_and_every_other_write_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let gate = gate_for(&renderer(dir.path()), Path::new(""), FakeStore::default(), open_limiter());
    let shared = exchange(&gate, "POST", &format!("/d/{DEVICE}/share-target"), &[]).await;
    assert_eq!(shared.status, 303);
    assert_eq!(shared.header("Location"), Some(format!("/d/{DEVICE}/").as_str()));
    assert_eq!(exchange(&gate, "POST", "/share-target", &[]).await.header("Location"), Some("/"));
    assert_eq!(exchange(&gate, "POST", "/index.html", &[]).await.status, 405);
    assert_eq!(exchange(&gate, "DELETE", "/share-target", &[]).await.status, 405);
}
// ---- the update page ----

#[tokio::test]
async fn only_unmatched_pcs_see_recovery_and_the_worker_can_still_update() {
    let dir = tempfile::tempdir().unwrap();
    let releases = dir.path().join("releases");
    let renderer_dir = renderer(dir.path());
    let entry = |id: &str, version: &str, hash: &str, legacy: bool| {
        serde_json::json!({ "id": id, "desktopVersion": version, "shellVersion": hash, "addedAt": 10, "legacy": legacy })
    };
    let hash = "a".repeat(64);
    let index = serde_json::json!({ "schemaVersion": 1, "releases": [entry("legacy", "", &hash, true), entry("r110", "1.1.0", "", false)] });
    write(&releases.join("index.json"), index.to_string());
    write(&releases.join("legacy").join("index.html"), "<!doctype html><title>Legacy</title>");
    write(&releases.join("legacy").join("boot.js"), "boot");
    write(&releases.join("r110").join("index.html"), "<!doctype html><title>Current</title>");
    for file in ["sw.js", "sw-shell.js", "sw-media.js", "ui-language.js", "boot.js"] {
        write(&renderer_dir.join(file), format!("// {file}"));
    }
    let mut store = paired_store();
    store.versions.insert(DEVICE.to_owned(), DeviceReport { app_version: "0.9.0".to_owned(), renderer_release: String::new() });
    let gate = gate_for(&renderer_dir, &releases, store, open_limiter());
    let route = format!("/d/{DEVICE}/");

    let page = exchange(&gate, "GET", &route, &[("User-Agent", NATIVE_APP)]).await;
    assert_eq!(page.status, 200);
    assert!(page.text().contains("data-current=\"0.9.0\""));
    assert!(page.text().contains("data-min=\"1.1.0\""));
    assert!(page.header("Content-Security-Policy").unwrap().starts_with("default-src 'none'"));
    // A deep link of the SPA fallback is the document too; HEAD answers the head only.
    assert!(exchange(&gate, "GET", &format!("{route}some/deep/link"), &[("User-Agent", NATIVE_APP)]).await.text().contains("data-min"));
    assert_eq!(exchange(&gate, "HEAD", &route, &[("User-Agent", NATIVE_APP)]).await.body.len(), 0);
    // Browsers and iframes do not receive native update advice; app assets cannot fall back.
    assert!(exchange(&gate, "GET", &route, &[("User-Agent", "Mozilla/5.0")]).await.text().contains("Web client unavailable"));
    assert_eq!(exchange(&gate, "GET", &format!("{route}boot.js"), &[("User-Agent", NATIVE_APP)]).await.status, 404);
    assert!(exchange(&gate, "GET", &route, &[("User-Agent", NATIVE_APP), ("Sec-Fetch-Dest", "iframe")]).await.text().contains("Web client unavailable"));
    assert!(exchange(&gate, "GET", &route, &[("User-Agent", NATIVE_APP), ("Sec-Fetch-Dest", "document")]).await.text().contains("data-min"));
    // A PC that reports a current version is served its own release.
    let mut current = paired_store();
    current.versions.insert(DEVICE.to_owned(), DeviceReport { app_version: "1.1.0".to_owned(), renderer_release: String::new() });
    let gate = gate_for(&renderer_dir, &releases, current, open_limiter());
    assert!(exchange(&gate, "GET", &route, &[("User-Agent", NATIVE_APP)]).await.text().contains("Current"));

    let mut adopted = paired_store();
    adopted.versions.insert(DEVICE.to_owned(), DeviceReport { app_version: "0.9.0".to_owned(), renderer_release: hash });
    let gate = gate_for(&renderer_dir, &releases, adopted, open_limiter());
    assert!(exchange(&gate, "GET", &route, &[("User-Agent", NATIVE_APP)]).await.text().contains("Legacy"));

    let mut upgraded = paired_store();
    upgraded.versions.insert(DEVICE.to_owned(), DeviceReport { app_version: "1.2.0".to_owned(), renderer_release: String::new() });
    let gate = gate_for(&renderer_dir, &releases, upgraded, open_limiter());
    for agent in [NATIVE_APP, "Mozilla/5.0"] {
        let unavailable = exchange(&gate, "GET", &route, &[("User-Agent", agent)]).await;
        assert_eq!(unavailable.status, 200, "the shipped worker ignores non-OK refreshes");
        assert_eq!(unavailable.header("Cache-Control"), Some("no-store"));
        assert!(unavailable.text().contains("Reload page"));
        assert!(!unavailable.text().contains("data-min"));
    }
    let cookie = format!("{DEVICE_COOKIE_NAME}={DEVICE}");
    for script in ["/sw.js", "/sw-shell.js", "/sw-media.js", "/ui-language.js"] {
        let reply = exchange(&gate, "GET", script, &[("Cookie", &cookie)]).await;
        assert_eq!(reply.status, 200);
        assert_eq!(reply.text(), format!("// {}", &script[1..]));
    }
}
