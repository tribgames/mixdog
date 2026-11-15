//! Static file serving against Node. `tests/fixtures/static-files.recording.json` holds what `lib/static-http.mjs` answered
//! on the fixture tree `tests/fixtures/static-files.tree.json` describes (recorded once by `tests/static_files_record.mjs`
//! against the Node module of commit 0bf8fe045). The tree is built here with the same bytes, so every status, header (in
//! Node's order and spelling), ETag and body digest must come back equal. The live gzip body is compared decoded: zlib's
//! and flate2's compressed bytes differ.
//!
//! The cases of `static-http.test.mjs` and the static cases of `security.test.mjs` follow, written against the same
//! functions.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use flate2::read::GzDecoder;
use mixdog_fsio::Unlaned;
use mixdog_relay::http1::{
    ConnInfo, Handler, HandlerFuture, Headers, Lifecycle, Limits, Request, ResponseWriter, UpgradeRequest, serve_connection,
};
use mixdog_relay::web::files::{
    StaticBody, StaticOptions, StaticRequest, StaticResolution, answer_static_file, mime_type, not_modified, resolve_static_target,
    send_device_manifest, send_static_file,
};
use mixdog_relay::web::headers::{
    ResponseHeaders, browser_security_headers, cookie_credential_allowed, device_cookie_headers, merge_cookie_headers,
    pairing_cookie_headers, parse_cookie_device, parse_cookie_token, request_cookie_token, security_headers_for_target,
};
use mixdog_relay::web::negotiate::{encoding_accepted, parse_accept_encoding, select_precompressed};
use mixdog_rt::InteractiveIo;
use mixdog_rt::time::timeout;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn io() -> InteractiveIo {
    mixdog_rt::testing::tokens().interactive_io
}

fn tree() -> Value {
    serde_json::from_str(include_str!("fixtures/static-files.tree.json")).unwrap()
}

fn recording() -> Value {
    serde_json::from_str(include_str!("fixtures/static-files.recording.json")).unwrap()
}

fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn write(path: &Path, bytes: impl AsRef<[u8]>) {
    mixdog_fsio::create_dir_all(&Unlaned, path.parent().unwrap()).unwrap();
    mixdog_fsio::write(&Unlaned, path, bytes).unwrap();
}

fn bytes_of(spec: &Value) -> Vec<u8> {
    let prefix = spec.get("prefix").and_then(Value::as_str).unwrap_or_default();
    let text = spec["text"].as_str().unwrap();
    let repeat = spec.get("repeat").and_then(Value::as_u64).unwrap_or(1);
    format!("{prefix}{}", text.repeat(usize::try_from(repeat).unwrap())).into_bytes()
}

/// The roots of the fixture tree, built in a temporary folder.
struct Fixture {
    dir: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        for (name, files) in tree()["roots"].as_object().unwrap() {
            for (path, spec) in files.as_object().unwrap() {
                write(&dir.path().join(name).join(path), bytes_of(spec));
            }
        }
        Self { dir }
    }

    fn root(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }
}

fn flat(headers: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for entry in headers.as_array().unwrap() {
        let name = entry[0].as_str().unwrap().to_owned();
        match &entry[1] {
            Value::Array(values) => out.extend(values.iter().map(|v| (name.clone(), v.as_str().unwrap().to_owned()))),
            value => out.push((name, value.as_str().unwrap().to_owned())),
        }
    }
    out
}

fn flat_of(headers: &ResponseHeaders) -> Vec<(String, String)> {
    headers.iter().flat_map(|(name, values)| values.iter().map(move |value| (name.to_owned(), value.clone()))).collect()
}

fn extra_of(spec: &Value) -> ResponseHeaders {
    let mut extra = ResponseHeaders::new();
    if let Some(fields) = spec.get("extra").and_then(Value::as_object) {
        for (name, value) in fields {
            match value {
                Value::Array(values) => extra.set_values(name, values.iter().map(|v| v.as_str().unwrap().to_owned()).collect()),
                value => extra.set(name, value.as_str().unwrap()),
            }
        }
    }
    extra
}

fn header_of(spec: &Value, name: &str) -> Option<String> {
    spec["headers"].get(name).and_then(Value::as_str).map(str::to_owned)
}

fn options_of(spec: &Value) -> StaticOptions {
    StaticOptions { vary_on_cookie: spec.get("varyOnCookie").and_then(Value::as_bool).unwrap_or(false) }
}

async fn answer(method: &str, accept: Option<&str>, if_none_match: Option<&str>, target: &Path) -> mixdog_relay::web::files::StaticAnswer {
    let request = StaticRequest { method, accept_encoding: accept, if_none_match };
    answer_static_file(&io(), &request, target, &ResponseHeaders::new(), StaticOptions::default()).await.unwrap()
}

// ---- the recording: heads ----

#[tokio::test]
async fn heads_equal_the_ones_node_wrote_on_the_fixture_tree() {
    let fixture = Fixture::new();
    let recorded = recording();
    for case in recorded["files"].as_array().unwrap() {
        let input = &case["input"];
        let name = input["name"].as_str().unwrap();
        let target = fixture.root(input["root"].as_str().unwrap()).join(input["file"].as_str().unwrap());
        let method = input.get("method").and_then(Value::as_str).unwrap_or("GET");
        let accept = header_of(input, "accept-encoding");
        let if_none_match = header_of(input, "if-none-match");
        let request = StaticRequest { method, accept_encoding: accept.as_deref(), if_none_match: if_none_match.as_deref() };
        let got = answer_static_file(&io(), &request, &target, &extra_of(input), options_of(input)).await.unwrap();
        assert_eq!(u64::from(got.status), case["status"].as_u64().unwrap(), "{name}: status");
        assert_eq!(flat_of(&got.headers), flat(&case["headers"]), "{name}: headers");
        let streamed = matches!(got.body, StaticBody::File { .. });
        assert_eq!(streamed, got.status == 200 && method != "HEAD", "{name}: body source");
    }
}

#[test]
fn the_helpers_return_what_node_returned() {
    let fixture = Fixture::new();
    let recorded = recording();
    for case in recorded["resolve"].as_array().unwrap() {
        let root = fixture.root(case["root"].as_str().unwrap());
        let pathname = case["pathname"].as_str().unwrap();
        let got = resolve_static_target(&root, pathname);
        let (status, target) = match got {
            StaticResolution::Found(path) => {
                let real_root = mixdog_fsio::canonicalize(&Unlaned, &root).unwrap();
                (200, path.strip_prefix(real_root).unwrap().to_string_lossy().replace('\\', "/"))
            }
            StaticResolution::Forbidden => (403, String::new()),
            StaticResolution::Missing => (404, String::new()),
        };
        assert_eq!(status, case["status"].as_u64().unwrap(), "{pathname}: status");
        assert_eq!(target, case["target"].as_str().unwrap(), "{pathname}: target");
    }
    for case in recorded["negotiation"].as_array().unwrap() {
        let root = fixture.root(case["root"].as_str().unwrap());
        let file = root.join(case["file"].as_str().unwrap());
        let accept = case["accept"].as_str().unwrap();
        let picked = select_precompressed(&Unlaned, &file, Some(accept))
            .map(|sibling| (sibling.path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/"), sibling.encoding.name()));
        let want = case["picked"].as_object().map(|p| (p["file"].as_str().unwrap().to_owned(), p["encoding"].as_str().unwrap().to_owned()));
        assert_eq!(picked.map(|(f, e)| (f, e.to_owned())), want, "{accept}");
    }
    for case in recorded["accepted"].as_array().unwrap() {
        let header = case["header"].as_str().unwrap();
        let encoding = case["encoding"].as_str().unwrap();
        assert_eq!(encoding_accepted(Some(header), encoding), case["accepted"].as_bool().unwrap(), "{header:?} {encoding}");
    }
}

#[test]
fn cookies_equal_the_ones_node_built_and_read() {
    let recorded = recording();
    let set_cookie = |headers: &ResponseHeaders| -> Value {
        if headers.is_empty() { serde_json::json!({}) } else { serde_json::json!({ "Set-Cookie": headers.get("Set-Cookie").unwrap() }) }
    };
    for case in recorded["cookies"].as_array().unwrap() {
        let token = case["token"].as_str().unwrap();
        let device = case["device"].as_str().unwrap();
        assert_eq!(set_cookie(&pairing_cookie_headers(token, false)), case["pairing"], "{token}");
        assert_eq!(set_cookie(&pairing_cookie_headers(token, true)), case["pairingSecure"], "{token}");
        assert_eq!(set_cookie(&device_cookie_headers(device, false)), case["device_"], "{device}");
        assert_eq!(set_cookie(&device_cookie_headers(device, true)), case["deviceSecure"], "{device}");
        let merged = merge_cookie_headers(&[&pairing_cookie_headers(token, false), &device_cookie_headers(device, true)]);
        let want = case["merged"].get("Set-Cookie").map(|value| value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect::<Vec<_>>());
        assert_eq!(want.is_some(), !merged.is_empty(), "{token} merged");
        if let Some(want) = want {
            assert_eq!(merged.values("Set-Cookie"), want.as_slice());
        }
    }
    for case in recorded["credentials"].as_array().unwrap() {
        if let Some(header) = case.get("header").and_then(Value::as_str) {
            assert_eq!(parse_cookie_token(Some(header)), case["token"].as_str().unwrap(), "{header:?}");
            assert_eq!(parse_cookie_device(Some(header)), case["device"].as_str().unwrap(), "{header:?}");
        } else {
            let mut headers = Headers::default();
            for (name, value) in case["headers"].as_object().unwrap() {
                headers.add(name, value.as_str().unwrap().to_owned());
            }
            assert_eq!(cookie_credential_allowed(&headers), case["allowed"].as_bool().unwrap(), "{:?}", case["headers"]);
        }
    }
    assert_eq!(parse_cookie_token(None), "");
}

#[test]
fn the_cookie_of_a_cross_site_request_never_authenticates() {
    let mut headers = Headers::default();
    headers.add("cookie", "mixdog_token=abcd".to_owned());
    assert_eq!(request_cookie_token(&headers), "abcd");
    headers.add("origin", "null".to_owned());
    assert_eq!(request_cookie_token(&headers), "");
}

// ---- the recording: whole exchanges over a connection ----

struct StaticHandler {
    io: InteractiveIo,
    roots: HashMap<String, PathBuf>,
    inputs: Vec<Value>,
}

impl Handler for StaticHandler {
    fn request(&self, request: Request, response: ResponseWriter) -> HandlerFuture {
        let (io, roots, inputs) = (self.io, self.roots.clone(), self.inputs.clone());
        Box::pin(async move {
            let mut response = response;
            let name = request.headers.get("x-case").unwrap().to_owned();
            let root = roots[request.headers.get("x-root").unwrap()].clone();
            let spec = inputs.iter().find(|spec| spec["name"] == name.as_str()).unwrap();
            let pathname = format!("/{}", spec["file"].as_str().unwrap());
            let StaticResolution::Found(target) = resolve_static_target(&root, &pathname) else { panic!("{pathname} resolves") };
            if let Some(device) = spec.get("device").and_then(Value::as_str) {
                assert!(send_device_manifest(&io, &request, &mut response, &target, device).await);
            } else {
                send_static_file(&io, &request, &mut response, &target, &extra_of(spec), options_of(spec)).await;
            }
        })
    }

    fn upgrade(&self, _upgrade: UpgradeRequest) {}
}

struct Answered {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
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

async fn exchange(handler: &Arc<StaticHandler>, case: &Value, method: &str) -> Answered {
    let mut raw = format!(
        "{method} /x HTTP/1.1\r\nHost: relay\r\nConnection: close\r\nx-case: {}\r\nx-root: {}\r\n",
        case["name"].as_str().unwrap(),
        case["root"].as_str().unwrap()
    );
    for (name, value) in case["headers"].as_object().unwrap() {
        raw.push_str(&format!("{name}: {}\r\n", value.as_str().unwrap()));
    }
    raw.push_str("\r\n");
    let (mut client, server) = tokio::io::duplex(64 * 1024);
    let served = tokio::spawn(serve_connection(
        server,
        ConnInfo { remote_address: None, encrypted: false },
        handler.clone() as Arc<dyn Handler>,
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
    let mut headers = Vec::new();
    let mut chunked = false;
    for line in lines {
        let (name, value) = line.split_once(": ").unwrap();
        match name.to_ascii_lowercase().as_str() {
            "date" | "connection" | "keep-alive" => {}
            "transfer-encoding" => chunked = true,
            _ => headers.push((name.to_owned(), value.to_owned())),
        }
    }
    let body = &data[split + 4..];
    Answered { status, headers, body: if chunked { decode_chunked(body) } else { body.to_vec() } }
}

fn check_body(name: &str, got: &Answered, want: &Value) {
    let body = match want["kind"].as_str().unwrap() {
        "live-gzip" => {
            let mut decoded = Vec::new();
            GzDecoder::new(got.body.as_slice()).read_to_end(&mut decoded).unwrap();
            decoded
        }
        _ => got.body.clone(),
    };
    assert_eq!(body.len() as u64, want["length"].as_u64().unwrap(), "{name}: body length");
    assert_eq!(sha(&body), want["sha256"].as_str().unwrap(), "{name}: body");
}

#[tokio::test]
async fn whole_exchanges_equal_the_ones_node_wrote() {
    let fixture = Fixture::new();
    let recorded = recording();
    let roots: HashMap<String, PathBuf> = ["site", "plain"].iter().map(|name| ((*name).to_owned(), fixture.root(name))).collect();
    let mut inputs: Vec<Value> = recorded["files"].as_array().unwrap().iter().map(|case| case["input"].clone()).collect();
    inputs.extend(recorded["manifests"].as_array().unwrap().iter().map(|case| case["input"].clone()));
    let handler = Arc::new(StaticHandler { io: io(), roots, inputs });
    for case in recorded["files"].as_array().unwrap().iter().chain(recorded["manifests"].as_array().unwrap()) {
        let input = &case["input"];
        let name = input["name"].as_str().unwrap();
        let method = input.get("method").and_then(Value::as_str).unwrap_or("GET");
        let got = exchange(&handler, input, method).await;
        assert_eq!(u64::from(got.status), case["status"].as_u64().unwrap(), "{name}: status");
        assert_eq!(got.headers, flat(&case["headers"]), "{name}: headers");
        check_body(name, &got, &case["body"]);
    }
}

// ---- static-http.test.mjs ----

#[tokio::test]
async fn conditional_assets_retain_security_and_cookies_and_distinguish_changed_representations() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("index.html");
    let original = "<p>asset content</p>".repeat(200);
    write(&target, &original);
    write(&dir.path().join("index.html.gz"), "gzip sibling");
    write(&dir.path().join("index.html.br"), "brotli sibling");
    let mut extra = ResponseHeaders::new();
    extra.set("Set-Cookie", "device=test; HttpOnly");
    let get = |accept: Option<&'static str>, tag: Option<String>, method: &'static str| {
        let (target, extra) = (target.clone(), extra.clone());
        async move {
            let request = StaticRequest { method, accept_encoding: accept, if_none_match: tag.as_deref() };
            answer_static_file(&io(), &request, &target, &extra, StaticOptions::default()).await.unwrap()
        }
    };
    let raw = get(None, None, "GET").await;
    let br = get(Some("br"), None, "GET").await;
    let gz = get(Some("gzip"), None, "GET").await;
    let tags: Vec<String> = [&raw, &br, &gz].iter().map(|a| a.headers.get("ETag").unwrap().to_owned()).collect();
    assert_eq!(tags.iter().collect::<std::collections::HashSet<_>>().len(), 3);
    for (accept, tag) in [(None, &tags[0]), (Some("br"), &tags[1]), (Some("gzip"), &tags[2])] {
        for method in ["GET", "HEAD"] {
            let unrelated = format!("\"unrelated\", {}", tag.replace("W/", ""));
            let cached = get(accept, Some(unrelated), method).await;
            assert_eq!(cached.status, 304);
            assert_eq!(cached.body, StaticBody::None);
            assert_eq!(cached.headers.get("Content-Length"), None);
            assert_eq!(cached.headers.get("Cache-Control"), Some("no-cache"));
            assert_eq!(cached.headers.get("Vary"), Some("Accept-Encoding"));
            assert_eq!(cached.headers.get("X-Content-Type-Options"), Some("nosniff"));
            assert_eq!(cached.headers.values("Set-Cookie"), ["device=test; HttpOnly"]);
        }
    }
    assert_eq!(get(None, Some("*".to_owned()), "GET").await.status, 304);
    assert_eq!(get(Some("br"), Some(tags[0].clone()), "GET").await.status, 200);
    write(&target, format!("{original}!"));
    let changed = get(None, Some(tags[0].clone()), "GET").await;
    assert_eq!(changed.status, 200);
    assert_ne!(changed.headers.get("ETag"), Some(tags[0].as_str()));
    write(&dir.path().join("index.html.br"), "brotli sibling, changed");
    assert_eq!(get(Some("br"), Some(tags[1].clone()), "GET").await.status, 200);
}

#[test]
fn weak_comparison_and_the_method_decide_not_modified() {
    assert!(not_modified("GET", Some("W/\"a\""), "\"a\""));
    assert!(not_modified("HEAD", Some("\"a\", \"b\""), "W/\"b\""));
    assert!(not_modified("GET", Some(" * "), "W/\"z\""));
    assert!(!not_modified("POST", Some("*"), "W/\"z\""));
    assert!(!not_modified("GET", None, "W/\"z\""));
    assert!(!not_modified("GET", Some("w/\"z\""), "W/\"z\""));
}

// ---- security.test.mjs ----

#[tokio::test]
async fn precompressed_siblings_are_negotiated_and_never_served_directly() {
    let dir = tempfile::tempdir().unwrap();
    let assets = dir.path().join("assets");
    let target = assets.join("index-AbCdEf123.css");
    write(&target, format!("body{{color:red}}{}", " ".repeat(2048)));
    write(&assets.join("index-AbCdEf123.css.br"), "brotli-body-placeholder");
    write(&assets.join("index-AbCdEf123.css.gz"), "gzip-body-placeholder");
    let length = |name: &str| mixdog_fsio::metadata(&Unlaned, assets.join(name)).unwrap().len().to_string();

    let brotli = answer("HEAD", Some("gzip, deflate, br"), None, &target).await;
    assert_eq!(brotli.headers.get("Content-Encoding"), Some("br"));
    assert_eq!(brotli.headers.get("Content-Length"), Some(length("index-AbCdEf123.css.br").as_str()));
    assert_eq!(brotli.headers.get("Vary"), Some("Accept-Encoding"));
    let gzip_only = answer("HEAD", Some("gzip"), None, &target).await;
    assert_eq!(gzip_only.headers.get("Content-Encoding"), Some("gzip"));
    assert_eq!(gzip_only.headers.get("Content-Length"), Some(length("index-AbCdEf123.css.gz").as_str()));
    let identity = answer("HEAD", Some(""), None, &target).await;
    assert_eq!(identity.headers.get("Content-Encoding"), None);
    assert_eq!(identity.headers.get("Content-Length"), Some(length("index-AbCdEf123.css").as_str()));

    // A raw build with nothing staged keeps the on-the-fly gzip, whose length is unknown until the stream ends.
    let plain = assets.join("plain-Zz9YyXx87.css");
    write(&plain, format!("body{{color:blue}}{}", " ".repeat(2048)));
    let live = answer("HEAD", Some("br, gzip"), None, &plain).await;
    assert_eq!(live.headers.get("Content-Encoding"), Some("gzip"));
    assert_eq!(live.headers.get("Content-Length"), None);

    assert_eq!(resolve_static_target(dir.path(), "/assets/index-AbCdEf123.css.br"), StaticResolution::Missing);
    assert_eq!(resolve_static_target(dir.path(), "/assets/index-AbCdEf123.css.gz"), StaticResolution::Missing);
    assert!(matches!(resolve_static_target(dir.path(), "/assets/index-AbCdEf123.css"), StaticResolution::Found(_)));
}

#[tokio::test]
async fn q0_is_honoured_on_staged_and_live_gzip() {
    let dir = tempfile::tempdir().unwrap();
    let assets = dir.path().join("assets");
    let staged = assets.join("index-Q0AbCdEf1.css");
    write(&staged, format!("body{{color:red}}{}", " ".repeat(2048)));
    write(&assets.join("index-Q0AbCdEf1.css.gz"), "gzip-body-placeholder");
    // No sibling beside this one on purpose: with a `.gz` present the refusal is honoured by sibling selection, which says
    // nothing about the live gzip a raw build actually runs on.
    let live = assets.join("live-Q0ZzYyXx9.css");
    write(&live, format!("body{{color:blue}}{}", " ".repeat(2048)));

    assert!(!encoding_accepted(Some("gzip;q=0"), "gzip"));
    assert!(encoding_accepted(Some("gzip;q=0.001"), "gzip"));
    assert!(!encoding_accepted(Some("*;q=0"), "gzip"));
    assert!(encoding_accepted(Some("*"), "br"));
    assert_eq!(parse_accept_encoding(Some("gzip;q=0.5, br")).get("gzip"), Some(&0.5));

    let encoding = |accept: &'static str, target: PathBuf| async move {
        answer("HEAD", Some(accept), None, &target).await.headers.get("Content-Encoding").map(str::to_owned)
    };
    assert_eq!(encoding("gzip;q=0", staged.clone()).await, None);
    assert_eq!(encoding("br;q=0, gzip;q=0", staged.clone()).await, None);
    assert_eq!(encoding("*;q=0", staged.clone()).await, None);
    assert_eq!(encoding("gzip;q=0.5", staged.clone()).await.as_deref(), Some("gzip"));

    assert!(select_precompressed(&Unlaned, &live, Some("br, gzip")).is_none());
    let compressed = answer("HEAD", Some("gzip"), None, &live).await;
    assert_eq!(compressed.headers.get("Content-Encoding"), Some("gzip"));
    assert_eq!(compressed.headers.get("Content-Length"), None);
    let refused = answer("HEAD", Some("gzip;q=0"), None, &live).await;
    assert_eq!(refused.headers.get("Content-Encoding"), None);
    let size = mixdog_fsio::metadata(&Unlaned, &live).unwrap().len().to_string();
    assert_eq!(refused.headers.get("Content-Length"), Some(size.as_str()));
    assert_eq!(encoding("*;q=0", live.clone()).await, None);
    assert_eq!(encoding("br;q=0, gzip;q=0", live.clone()).await, None);
    // br is only ever served from a staged sibling, so a br-only client on the live path gets identity.
    assert_eq!(encoding("br", live).await, None);
}

#[tokio::test]
async fn a_symlinked_sibling_is_never_negotiated() {
    let dir = tempfile::tempdir().unwrap();
    let assets = dir.path().join("assets");
    let target = assets.join("index-Sy0AbCdE1.css");
    write(&target, format!("body{{color:red}}{}", " ".repeat(2048)));
    write(&assets.join("index-Sy0AbCdE1.css.gz"), "gzip-body-placeholder");
    write(&dir.path().join("outside").join("secret.br"), "outside");
    if mixdog_fsio::symlink_file(&Unlaned, dir.path().join("outside").join("secret.br"), assets.join("index-Sy0AbCdE1.css.br")).is_err() {
        // The link is the test: a host that cannot create one (Windows without developer mode) has verified nothing here.
        eprintln!("SKIPPED: creating a file symlink is not permitted on this host");
        return;
    }
    assert!(select_precompressed(&Unlaned, &target, Some("br")).is_none());
    let picked = select_precompressed(&Unlaned, &target, Some("br, gzip")).unwrap();
    assert_eq!(picked.encoding.name(), "gzip");
    let headers = answer("HEAD", Some("br, gzip"), None, &target).await.headers;
    assert_eq!(headers.get("Content-Encoding"), Some("gzip"));
    let size = mixdog_fsio::metadata(&Unlaned, assets.join("index-Sy0AbCdE1.css.gz")).unwrap().len().to_string();
    assert_eq!(headers.get("Content-Length"), Some(size.as_str()));
}

#[tokio::test]
async fn static_responses_apply_browser_security_headers_without_changing_head_behaviour() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("index.html");
    write(&target, "<!doctype html><title>Mixdog</title>");
    let head = answer("HEAD", None, None, &target).await;
    assert_eq!(head.status, 200);
    assert_eq!(head.body, StaticBody::None);
    for (name, value) in browser_security_headers().iter() {
        assert_eq!(head.headers.get(name), Some(value[0].as_str()), "{name}");
    }
    let policy = head.headers.get("Content-Security-Policy").unwrap();
    assert!(policy.contains("frame-ancestors 'none'"));
    assert_eq!(policy.split("; ").find(|part| part.starts_with("script-src")), Some("script-src 'self'"));
    assert_eq!(head.headers.get("X-Frame-Options"), Some("DENY"));
    assert_eq!(head.headers.get("Referrer-Policy"), Some("no-referrer"));
    assert!(head.headers.get("Permissions-Policy").unwrap().contains("camera=(self)"));
    // The 304 and the GET carry them too.
    assert_eq!(answer("GET", None, None, &target).await.headers.get("X-Content-Type-Options"), Some("nosniff"));

    let hashed = dir.path().join("assets").join("index-AbCdEf123.js");
    write(&hashed, "export const ready = true;");
    assert_eq!(answer("HEAD", None, None, &hashed).await.headers.get("Cache-Control"), Some("public, max-age=31536000, immutable"));
    let plain = dir.path().join("style.css");
    write(&plain, "body{color:red}");
    assert_eq!(answer("HEAD", None, None, &plain).await.headers.get("Cache-Control"), Some("public, max-age=86400"));
    for name in ["boot.js", "ui-language.js", "sw-shell.js", "sw.js", "sw-media.js", "manifest.webmanifest"] {
        let file = dir.path().join(name);
        write(&file, "window.mixdogBoot = true;");
        assert_eq!(answer("HEAD", None, None, &file).await.headers.get("Cache-Control"), Some("no-cache"), "{name}");
    }
}

#[test]
fn the_mime_table_names_every_extension_and_falls_back_to_octet_stream() {
    for (extension, mime) in mixdog_relay::web::files::MIME_TYPES {
        assert_eq!(mime_type(Path::new(&format!("dir/file{extension}"))), mime);
        assert_eq!(mime_type(Path::new(&format!("dir/file{}", extension.to_uppercase()))), mime);
    }
    assert_eq!(mime_type(Path::new("file.bin")), "application/octet-stream");
    assert_eq!(mime_type(Path::new("file")), "application/octet-stream");
}

#[test]
fn pairing_and_device_cookies_keep_max_age_httponly_samesite_forms() {
    let token = "abcd";
    let device = "12345678-abcd-4321-abcd-1234567890ab";
    assert_eq!(pairing_cookie_headers(token, false).get("Set-Cookie"), Some("mixdog_token=abcd; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax"));
    assert_eq!(
        pairing_cookie_headers(token, true).get("Set-Cookie"),
        Some("mixdog_token=abcd; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure")
    );
    assert_eq!(
        device_cookie_headers(device, false).get("Set-Cookie"),
        Some(format!("mixdog_device={device}; Path=/; Max-Age=31536000; SameSite=Lax").as_str())
    );
    assert_eq!(
        device_cookie_headers(device, true).get("Set-Cookie"),
        Some(format!("mixdog_device={device}; Path=/; Max-Age=31536000; SameSite=Lax; Secure").as_str())
    );
    assert!(pairing_cookie_headers("", true).is_empty());
}

#[test]
fn the_exact_csp_hash_only_for_the_inlined_boot_script() {
    use base64::Engine as _;
    let dir = tempfile::tempdir().unwrap();
    let source = "window.mixdogBoot = true;";
    let target = dir.path().join("index.html");
    write(&dir.path().join("boot.js"), source);
    write(&target, format!("<!doctype html><script>{source}</script>"));
    let hash = base64::engine::general_purpose::STANDARD.encode(Sha256::digest(source.as_bytes()));
    let headers = security_headers_for_target(&Unlaned, &target);
    let script = headers.get("Content-Security-Policy").unwrap().split("; ").find(|part| part.starts_with("script-src")).unwrap().to_owned();
    assert_eq!(script, format!("script-src 'self' 'sha256-{hash}'"));

    // The document does not inline it, or the script differs: the self-only policy stays.
    write(&target, "<!doctype html><script src=\"/boot.js\"></script>");
    assert_eq!(security_headers_for_target(&Unlaned, &target), browser_security_headers());
    write(&target, "<!doctype html><script>window.other = 1;</script>");
    assert_eq!(security_headers_for_target(&Unlaned, &target), browser_security_headers());
    // Without a boot.js beside it nothing is granted; another file name is never granted.
    mixdog_fsio::remove_file(&Unlaned, dir.path().join("boot.js")).unwrap();
    write(&target, format!("<!doctype html><script>{source}</script>"));
    assert_eq!(security_headers_for_target(&Unlaned, &target), browser_security_headers());
    write(&dir.path().join("boot.js"), source);
    let other = dir.path().join("other.html");
    write(&other, format!("<!doctype html><script>{source}</script>"));
    assert_eq!(security_headers_for_target(&Unlaned, &other), browser_security_headers());
}

#[test]
fn static_target_resolution_rejects_symlink_escapes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("renderer");
    let outside = dir.path().join("outside");
    write(&root.join("index.html"), "inside");
    write(&outside.join("secret.txt"), "outside");
    assert!(matches!(resolve_static_target(&root, "/index.html"), StaticResolution::Found(_)));
    assert_eq!(resolve_static_target(&root, "/../outside/secret.txt"), StaticResolution::Forbidden);
    let linked = root.join("linked");
    // Node links a junction on Windows ('junction' needs no privilege), a directory symlink elsewhere.
    #[cfg(windows)]
    junction(&linked, &outside);
    #[cfg(not(windows))]
    mixdog_fsio::symlink_dir(&Unlaned, &outside, &linked).unwrap();
    assert_eq!(resolve_static_target(&root, "/linked/secret.txt"), StaticResolution::Forbidden);
}

/// A junction `link` -> `target`, as `symlinkSync(target, link, 'junction')` makes it.
#[cfg(windows)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: mklink is the one way to make a junction without a privilege")]
fn junction(link: &Path, target: &Path) {
    // `mklink` takes backslash paths only.
    let backslashed = |path: &Path| path.to_string_lossy().replace('/', "\\");
    let made = std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(backslashed(link)).arg(backslashed(target)).output().expect("mklink");
    assert!(made.status.success(), "mklink: {}", String::from_utf8_lossy(&made.stderr));
}
