use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

use super::*;
use crate::channels::running::RunningWork;

#[derive(Default)]
struct MemStore {
    endpoints: Mutex<HashMap<String, Endpoint>>,
    secrets: Mutex<HashMap<String, String>>,
    deliveries: Mutex<HashMap<(String, String), String>>,
}

#[async_trait]
impl WebhookStore for MemStore {
    async fn load_endpoint(&self, name: &str) -> Result<Option<Endpoint>, String> {
        Ok(self.endpoints.lock().unwrap().get(name).cloned())
    }
    async fn read_secret(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self.secrets.lock().unwrap().get(name).cloned())
    }
    async fn claim_delivery(&self, endpoint: &str, id: &str, claim: Claim<'_>) -> Result<bool, String> {
        let mut rows = self.deliveries.lock().unwrap();
        let key = (endpoint.to_string(), id.to_string());
        if rows.contains_key(&key) {
            return Ok(false);
        }
        rows.insert(key, claim.status.to_string());
        Ok(true)
    }
    async fn update_delivery_status(&self, endpoint: &str, id: &str, status: &str, _e: Option<&str>) -> Result<(), String> {
        self.deliveries.lock().unwrap().insert((endpoint.into(), id.into()), status.into());
        Ok(())
    }
}

#[derive(Default)]
struct Dispatched(Mutex<Vec<(String, Value)>>);

#[async_trait]
impl WebhookDispatch for Dispatched {
    async fn handle(&self, name: &str, payload: Value, _h: &Headers, id: &str, _t: bool) -> Result<HttpReply, String> {
        self.0.lock().unwrap().push((name.into(), payload));
        Ok(HttpReply { status: 200, body: json!({"status":"accepted","id":id}) })
    }
}

fn sign(secret: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(body);
    let hex: String = mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256={hex}")
}

fn headers(pairs: &[(&str, &str)]) -> Headers {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

struct Fx {
    svc: WebhookService,
    store: Arc<MemStore>,
    dispatched: Arc<Dispatched>,
    work: RunningWork,
}

fn fx(config: WebhookConfig) -> Fx {
    let store = Arc::new(MemStore::default());
    store.endpoints.lock().unwrap().insert("hook".into(), Endpoint::default());
    store.secrets.lock().unwrap().insert("hook".into(), "s3".into());
    let dispatched = Arc::new(Dispatched::default());
    let work = RunningWork::new();
    let svc = WebhookService::new(store.clone(), dispatched.clone(), config, work.clone(), Arc::new(|| 0));
    Fx { svc, store, dispatched, work }
}

const JSON_CT: (&str, &str) = ("content-type", "application/json");

#[tokio::test]
async fn name_gate_runs_before_anything_else() {
    let f = fx(WebhookConfig::default());
    for (path, status, error) in [
        ("/webhook/..%2Fx", 404, "invalid endpoint name"),
        ("/webhook/", 404, "invalid endpoint name"),
        ("/webhook/nope", 404, "unknown endpoint"),
    ] {
        let reply = f.svc.handle_post(path, &headers(&[]), b"{}").await;
        assert_eq!((reply.status, reply.body), (status, json!({"error":error})), "{path}");
    }
    f.store.endpoints.lock().unwrap().insert("off".into(), Endpoint { enabled: Some(false), ..Default::default() });
    assert_eq!(f.svc.handle_post("/webhook/off", &headers(&[]), b"{}").await.body, json!({"error":"disabled endpoint"}));
}

#[tokio::test]
async fn signed_delivery_dispatches_once_and_dedups_replays() {
    let f = fx(WebhookConfig::default());
    let body = br#"{"a":1}"#;
    let h = headers(&[JSON_CT, ("x-hub-signature-256", &sign("s3", body)), ("x-github-delivery", "g1")]);
    let first = f.svc.handle_post("/webhook/hook?x=1", &h, body).await;
    assert_eq!(first.status, 200);
    assert_eq!(first.body["status"], "accepted");
    let replay = f.svc.handle_post("/webhook/hook", &h, body).await;
    assert_eq!(replay.status, 200);
    assert_eq!(replay.body["status"], "dedup");
    assert_eq!(f.dispatched.0.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn bad_or_missing_signature_is_403_and_unsigned_table_endpoint_401() {
    let f = fx(WebhookConfig::default());
    let body = b"{}";
    let missing = f.svc.handle_post("/webhook/hook", &headers(&[JSON_CT]), body).await;
    assert_eq!((missing.status, missing.body), (403, json!({"ok":false,"error":"missing signature"})));
    let bad = headers(&[JSON_CT, ("x-hub-signature-256", &sign("wrong", body))]);
    let reply = f.svc.handle_post("/webhook/hook", &bad, body).await;
    assert_eq!((reply.status, reply.body), (403, json!({"ok":false,"error":"invalid signature"})));
    f.store.secrets.lock().unwrap().clear();
    let unsigned = f.svc.handle_post("/webhook/hook", &headers(&[JSON_CT]), body).await;
    assert_eq!((unsigned.status, unsigned.body), (401, json!({"error":"webhook secret required for endpoint"})));
    assert!(f.dispatched.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn config_endpoint_accepts_unsigned_only_on_explicit_opt_in() {
    let mut config = WebhookConfig::default();
    config.endpoints.insert("cfg".into(), Endpoint::default());
    let f = fx(config.clone());
    let denied = f.svc.handle_post("/webhook/cfg", &headers(&[JSON_CT]), b"{}").await;
    assert_eq!(denied.status, 401);
    config.allow_unsigned_webhooks = true;
    f.svc.set_config(config);
    assert_eq!(f.svc.handle_post("/webhook/cfg", &headers(&[JSON_CT]), b"{}").await.status, 200);
}

#[tokio::test]
async fn parser_without_secret_fails_closed() {
    let mut config = WebhookConfig::default();
    config.endpoints.insert("cfg".into(), Endpoint { parser: Some("github".into()), allow_unsigned: Some(true), ..Default::default() });
    let f = fx(config);
    let reply = f.svc.handle_post("/webhook/cfg", &headers(&[JSON_CT]), b"{}").await;
    assert_eq!((reply.status, reply.body), (401, json!({"error":"webhook secret required for signed parser"})));
}

#[tokio::test]
async fn test_probe_needs_header_marker_and_secret_and_never_dispatches() {
    let f = fx(WebhookConfig::default());
    let body = br#"{"mixdogWebhookTest":true}"#;
    let sig = sign("s3", body);
    let ok = f.svc.handle_post("/webhook/hook", &headers(&[JSON_CT, ("x-hub-signature-256", &sig), ("x-mixdog-webhook-test", "1")]), body).await;
    assert_eq!((ok.status, ok.body), (200, json!({"status":"verified","test":true})));
    let header_only_body = b"{}";
    let sig2 = sign("s3", header_only_body);
    let mismatch = f
        .svc
        .handle_post("/webhook/hook", &headers(&[JSON_CT, ("x-hub-signature-256", &sig2), ("x-mixdog-webhook-test", "1")]), header_only_body)
        .await;
    assert_eq!((mismatch.status, mismatch.body), (400, json!({"error":"invalid test request"})));
    assert!(f.dispatched.0.lock().unwrap().is_empty());
    assert!(f.store.deliveries.lock().unwrap().is_empty());
}

#[tokio::test]
async fn content_type_json_and_self_comment_gates() {
    let f = fx(WebhookConfig::default());
    let body = b"a=b";
    let h = headers(&[("x-hub-signature-256", &sign("s3", body)), ("content-type", "text/plain")]);
    let reply = f.svc.handle_post("/webhook/hook", &h, body).await;
    assert_eq!(reply.status, 415);
    let failed = f.store.deliveries.lock().unwrap().values().cloned().collect::<Vec<_>>();
    assert_eq!(failed, vec!["failed".to_string()]);

    let own = br#"{"comment":{"body":"[mixdog reviewer] hi"}}"#;
    let h = headers(&[JSON_CT, ("x-hub-signature-256", &sign("s3", own)), ("x-github-event", "issue_comment")]);
    let reply = f.svc.handle_post("/webhook/hook", &h, own).await;
    assert_eq!((reply.status, reply.body["status"].clone()), (202, json!("self-comment-skip")));
    assert!(f.dispatched.0.lock().unwrap().is_empty());

    let broken = b"{not json";
    let h = headers(&[JSON_CT, ("x-hub-signature-256", &sign("s3", broken))]);
    let reply = f.svc.handle_post("/webhook/hook", &h, broken).await;
    assert_eq!((reply.status, reply.body), (400, json!({"error":"invalid JSON"})));
}

/// The virtual clock the replay sets before each case, as the recording's `virtualClock` places its cases.
struct CaseClock(std::sync::atomic::AtomicI64);

impl crate::scheduler::Clock for CaseClock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::from_timestamp_millis(self.0.load(std::sync::atomic::Ordering::SeqCst)).unwrap()
    }
}

/// The recorder's `handleWebhook` seam: keeps what reached it and answers `200 {status:"accepted",id}`.
#[derive(Default)]
struct Reached(Mutex<Vec<Value>>);

#[async_trait]
impl WebhookDispatch for Reached {
    async fn handle(&self, name: &str, payload: Value, _h: &Headers, id: &str, endpoint_in_table: bool) -> Result<HttpReply, String> {
        self.0.lock().unwrap().push(json!({"name": name, "payload": payload, "endpointInTable": endpoint_in_table}));
        Ok(HttpReply { status: 200, body: json!({"status":"accepted","id":id}) })
    }
}

/// Node's receiver answering bodies that are not valid UTF-8, recorded by `record-webhook-invalid-utf8.mjs`
/// (`fixtures/webhook-invalid-utf8`): each recorded request is sent as its bytes over TCP to the real listener with the
/// recorded config (a config endpoint, the global secret); per case the reply and what reached the dispatch (Node's
/// `handleWebhook`, the seam both sides answer `accepted` at) equal Node's, and so do the delivery rows the core's real
/// store persisted, every column with its stamps, case `i` run at the recording's virtual instant `start + i * step`.
#[tokio::test]
async fn bodies_with_invalid_utf8_are_answered_as_node_answers_them() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/webhook-invalid-utf8/golden.json")).unwrap();
    let config: WebhookConfig = serde_json::from_value(golden["config"].clone()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let (state, _) =
        mixdog_store::state::CoreState::open(tokens.sqlite_writer_thread, tokens.interactive_io, &dir.path().join("core.sqlite")).unwrap();
    let clock = Arc::new(CaseClock(std::sync::atomic::AtomicI64::new(0)));
    let rows = Arc::new(super::records::StateWebhookStore::new(state, clock.clone()));
    let dispatched = Arc::new(Reached::default());
    let service = Arc::new(WebhookService::new(rows.clone(), dispatched.clone(), config, RunningWork::new(), Arc::new(|| 0)));
    let listener = WebhookListener::start(service, 0).await.unwrap();
    let (start, step) = (golden["virtualClock"]["start"].as_i64().unwrap(), golden["virtualClock"]["step"].as_i64().unwrap());
    for (index, case) in golden["cases"].as_array().unwrap().iter().enumerate() {
        clock.0.store(start + index as i64 * step, std::sync::atomic::Ordering::SeqCst);
        let body: Vec<u8> = (0..case["request"]["bodyHex"].as_str().unwrap().len() / 2)
            .map(|i| u8::from_str_radix(&case["request"]["bodyHex"].as_str().unwrap()[2 * i..2 * i + 2], 16).unwrap())
            .collect();
        let mut head = format!("POST /webhook/hook HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {}\r\n", body.len());
        for (name, value) in case["request"]["headers"].as_object().unwrap() {
            head.push_str(&format!("{name}: {}\r\n", value.as_str().unwrap()));
        }
        head.push_str("\r\n");
        let before = dispatched.0.lock().unwrap().len();
        let (status, text) = exchange(listener.port(), &[head.as_bytes(), &body]).await;
        let reached = dispatched.0.lock().unwrap()[before..].to_vec();
        assert_eq!(
            json!({"name": case["name"], "reply": {"status": status, "body": serde_json::from_str::<Value>(&text).unwrap()}, "dispatched": reached}),
            json!({"name": case["name"], "reply": case["reply"], "dispatched": case["dispatched"]}),
        );
    }
    assert_eq!(Value::Array(rows.delivery_rows().await), golden["deliveries"]);
    listener.stop().await;
}

#[test]
fn transport_collector_joins_chunks_and_caps_the_wire_body() {
    // Chunks split inside a multi-byte character join byte for byte.
    let body = [0xe2, 0x82, 0xac, 0x00, 0xff];
    let mut c = BodyCollector::default();
    c.push(&body[..2]).unwrap();
    c.push(&body[2..]).unwrap();
    assert_eq!(c.finish(), Some(body.to_vec()));

    // Exactly the cap is accepted.
    let mut c = BodyCollector::default();
    c.push(&vec![b'a'; MAX_BODY_BYTES]).unwrap();
    assert_eq!(c.finish().map(|b| b.len()), Some(MAX_BODY_BYTES));

    // One byte past the cap, spread over small chunks: the 413 comes once, at the chunk that
    // crosses it, and nothing is buffered beyond the cap.
    let mut c = BodyCollector::default();
    let chunk = vec![b'a'; 1024 * 1024];
    for _ in 0..5 {
        c.push(&chunk).unwrap();
    }
    let reply = c.push(&[b'b']).unwrap_err();
    assert_eq!(reply.0.status, 413);
    assert_eq!(reply.0.body, json!({"error":"payload too large","limit":MAX_BODY_BYTES}));
    c.push(&chunk).unwrap(); // discarded, no second reply
    assert_eq!(c.finish(), None);
}

#[tokio::test]
async fn oversized_body_is_413_and_listener_counts_as_work() {
    let f = fx(WebhookConfig::default());
    let big = vec![b' '; MAX_BODY_BYTES + 1];
    let reply = f.svc.handle_post("/webhook/hook", &headers(&[JSON_CT]), &big).await;
    assert_eq!(reply.status, 413);
    assert!(f.work.is_idle());
    let listening = f.svc.listening();
    assert_eq!(f.work.count(), 1);
    drop(listening);
    assert!(f.work.is_idle());
}

/// Node's request parsing, recorded by `record-webhook-endpoint-name.mjs` (`fixtures/webhook-endpoint-name`): the
/// raw and decoded endpoint name of every recorded path, the strict name gate's answer for the paths it refuses
/// (`handle_post` with no store entry), and the body reader fed the recorded chunks: where the 413 comes, what it says,
/// and the bytes (length and sha256) it hands over; every recorded answer is compared whole (status, headers, body and
/// whether the request was destroyed), and the bodies cut short by an abort or a socket error get no answer at all.
#[tokio::test]
async fn request_parsing_answers_as_node_answers_it() {
    let golden: Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/webhook-endpoint-name/golden.json")).unwrap();
    assert_eq!(golden["maxBodyBytes"], MAX_BODY_BYTES);
    let f = fx(WebhookConfig::default());
    // `destroyed` is observed, not supplied: what a peer sees of the real listener after its answer
    // (a second request on the connection is not served) is compared with every recorded wire case,
    // and the connection closing after an answer is what Node's `req.destroy()` is.
    let listener = serve_on_loopback(&f).await;
    for case in golden["wire"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let parts: Vec<&str> = case["parts"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
        let sequential = case["sequential"].as_bool().unwrap_or(false);
        let fin = case["halfClose"].as_bool().unwrap_or(false) || case["server"] == "gate";
        let seen = peer_sees(listener.port(), &parts, sequential, fin).await;
        // The raw bytes the peer gets are compared whole: status line and header lines in order with their name case
        // and repeats, the body with its framing. Only the value of `Date` is a token, on both sides.
        let recorded: Vec<Value> = case["responses"].as_array().unwrap().iter().map(|r| json!({"status": r["status"], "head": r["head"], "body": r["body"], "raw": r["raw"]})).collect();
        let seen: Vec<Value> = seen.into_iter().map(|(status, head, body, raw)| json!({"status": status, "head": head, "body": body, "raw": raw})).collect();
        assert_eq!(seen, recorded, "{name}: what the peer sees");
        assert!(case["closed"].as_bool().unwrap(), "{name}: Node closes the connection");
        assert_eq!(case["settled"], 0, "{name}: nothing settles in Node");
        assert!(f.dispatched.0.lock().unwrap().is_empty(), "{name}: nothing reached the dispatch");
    }
    let gate_closes = peer_sees(listener.port(), &["POST /webhook/%zz HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\nGET / HTTP/1.1\r\nHost: x\r\n\r\n"], false, true).await.len() == 1;
    let overflow_closes = {
        let head = post("/webhook/hook", &[JSON_CT], "Transfer-Encoding: chunked\r\n");
        let head = String::from_utf8(head).unwrap();
        let body = format!("{:x}\r\n{}\r\n0\r\n\r\nGET / HTTP/1.1\r\nHost: x\r\n\r\n", MAX_BODY_BYTES + 1, "a".repeat(MAX_BODY_BYTES + 1));
        let seen = peer_sees(listener.port(), &[&head, &body], false, true).await;
        assert_eq!(seen[0].0, 413);
        seen.len() == 1
    };
    listener.stop().await;
    for case in golden["paths"].as_array().unwrap() {
        let url = case["url"].as_str().unwrap();
        assert_eq!(handler::raw_endpoint_name(url), case["parsed"]["rawName"].as_str().unwrap(), "rawName of {url}");
        assert_eq!(handler::parse_endpoint_name(url), case["parsed"]["name"].as_str().unwrap(), "name of {url}");
        if let Some(gate) = case.get("gate") {
            let Err(Rejection(refusal)) = f.svc.precheck(url).await else { panic!("gate of {url}: not refused") };
            assert_eq!(f.svc.handle_post(url, &headers(&[]), b"{}").await, refusal, "gate of {url}: handle_post");
            assert_answer(&format!("gate of {url}"), gate, Some((&refusal, gate_closes)));
        }
    }
    for case in golden["bodies"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut collector = BodyCollector::default();
        let mut reply = None;
        for (index, chunk) in case["chunks"].as_array().unwrap().iter().enumerate() {
            let bytes = match chunk["hex"].as_str() {
                Some(hex) => (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect(),
                None => vec![chunk["fill"].as_u64().unwrap() as u8; chunk["length"].as_u64().unwrap() as usize],
            };
            if let Err(Rejection(refusal)) = collector.push(&bytes) {
                reply = Some(refusal);
            }
            assert_eq!(reply.is_some(), case["answeredAfter"][index].as_bool().unwrap(), "{name}: answered after chunk {index}");
        }
        match (collector.finish(), case["received"].as_object()) {
            (None, None) => {}
            (Some(bytes), Some(recorded)) => {
                use sha2::Digest;
                let sha: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
                assert_eq!((bytes.len() as u64, sha.as_str()), (recorded["length"].as_u64().unwrap(), recorded["sha256"].as_str().unwrap()), "{name}");
            }
            (got, recorded) => panic!("{name}: got {:?} bytes, recorded {recorded:?}", got.map(|b| b.len())),
        }
        assert_answer(name, case, reply.as_ref().map(|r| (r, overflow_closes)));
    }
    for case in golden["cutBodies"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut collector = BodyCollector::default();
        let mut reply = None;
        for (index, chunk) in case["chunks"].as_array().unwrap().iter().enumerate() {
            let bytes = vec![chunk["fill"].as_u64().unwrap_or(0) as u8; chunk["length"].as_u64().unwrap_or(0) as usize];
            let bytes = chunk["hex"].as_str().map_or(bytes, |hex| (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect());
            if let Err(Rejection(refusal)) = collector.push(&bytes) {
                reply = Some(refusal);
            }
            assert_eq!(reply.is_some(), case["answeredAfter"][index].as_bool().unwrap(), "{name}: answered after chunk {index}");
        }
        // The cut ends the read; a collector that had not overflowed settles nothing (Node's promise stays pending).
        let outcome = collector.cut_short();
        let ours = json!({"settled": outcome.is_some(), "received": outcome.flatten().map_or(Value::Null, |b| json!({"length": b.len()}))});
        assert_eq!(ours, json!({"settled": case["settled"], "received": case["received"]}), "{name}: what the cut settled with");
        assert_answer(name, case, reply.as_ref().map(|r| (r, overflow_closes)));
    }
}

/// One recorded answer of Node's handler (`status`, `headers`, `body`, `destroyed`) against ours: `answer` is
/// the reply written and whether the request was dropped after it; None when nothing was written.
fn assert_answer(label: &str, recorded: &Value, answer: Option<(&HttpReply, bool)>) {
    let status = recorded["status"].as_u64().unwrap();
    match answer {
        None => {
            assert_eq!((status, &recorded["headers"], recorded["body"].as_str().unwrap(), recorded["destroyed"].as_bool().unwrap()), (0, &Value::Null, "", false), "{label}: recorded an answer, none written");
        }
        Some((reply, destroyed)) => {
            let body: Value = serde_json::from_str(recorded["body"].as_str().unwrap()).unwrap();
            assert_eq!(u64::from(reply.status), status, "{label}: status");
            assert_eq!(recorded["headers"], json!({ "Content-Type": HttpReply::CONTENT_TYPE }), "{label}: headers");
            assert_eq!(reply.body, body, "{label}: body");
            assert_eq!(destroyed, recorded["destroyed"].as_bool().unwrap(), "{label}: destroyed");
        }
    }
}

// ---- transport: the real listener over loopback ----

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn serve_on_loopback(f: &Fx) -> WebhookListener {
    let service = Arc::new(WebhookService::new(f.store.clone(), f.dispatched.clone(), WebhookConfig::default(), f.work.clone(), Arc::new(|| 0)));
    WebhookListener::start(service, 0).await.unwrap()
}

/// A reply the peer parsed: status, head (status line and header lines as sent, the `Date` value a token), decoded
/// body, and the whole raw reply (head and body with its framing).
type Parsed = (u16, String, String, String);

/// What the recorder replaces the value of `Date` by.
const DATE_TOKEN: &str = "<date>";

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/webhook-endpoint-name/golden.json")).unwrap()
}

/// A write on a socket, with the same deadline as a read: a peer that does not take its bytes fails the test by name.
async fn send(write: &mut (impl AsyncWriteExt + Unpin), bytes: &[u8], what: &str) {
    // A listener that has already answered and closed may refuse the rest; the reply is what is compared.
    let _ = within(&format!("the write of {what}"), write.write_all(bytes)).await;
}

async fn connect(port: u16) -> TcpStream {
    within("the loopback connection", TcpStream::connect(("127.0.0.1", port))).await.unwrap()
}

/// Waits `ms` of the paused clock.
async fn advance(ms: u64) {
    mixdog_rt::time::sleep(std::time::Duration::from_millis(ms)).await;
}

/// Every wait on a socket has this deadline and names what it waits for when it passes. It is longer than
/// every paused-clock bound a test waits for (the 25 s process bound), so it fires only on a real hang.
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(30);

async fn within<T>(waiting_for: &str, future: impl std::future::Future<Output = T>) -> T {
    mixdog_rt::time::timeout(DEADLINE, future).await.unwrap_or_else(|_| panic!("{waiting_for} did not arrive within {DEADLINE:?}"))
}

async fn read_response(stream: &mut (impl AsyncReadExt + Unpin), pending: &mut Vec<u8>) -> Option<(u16, String)> {
    read_response_typed(stream, pending, "a reply").await.map(|(status, _, body, _)| (status, body))
}

/// Writes `parts` (a `sequential` second part only after the first reply came) and returns every reply
/// the peer gets until the listener closes. `fin` half-closes the sending side after the writes, so a
/// listener that kept the connection alive ends it too.
async fn peer_sees(port: u16, parts: &[&str], sequential: bool, fin: bool) -> Vec<Parsed> {
    let (mut read, mut write) = connect(port).await.into_split();
    let (mut pending, mut seen) = (Vec::new(), Vec::new());
    let first = if sequential { 1 } else { parts.len() };
    for part in &parts[..first] {
        send(&mut write, part.as_bytes(), "a request").await;
    }
    if sequential {
        seen.extend(read_response_typed(&mut read, &mut pending, "the reply to the first request").await);
        send(&mut write, parts[1].as_bytes(), "the second request").await;
    }
    if fin {
        let _ = within("the half-close", write.shutdown()).await;
    }
    while let Some(reply) = read_response_typed(&mut read, &mut pending, "the listener closing the connection after its reply").await {
        seen.push(reply);
    }
    seen
}

/// One more read into `pending`; false when the peer closed.
async fn fill(stream: &mut (impl AsyncReadExt + Unpin), pending: &mut Vec<u8>, waiting_for: &str) -> bool {
    let mut chunk = [0u8; 8192];
    match within(waiting_for, stream.read(&mut chunk)).await {
        Ok(0) | Err(_) => false,
        Ok(n) => {
            pending.extend_from_slice(&chunk[..n]);
            true
        }
    }
}

/// One response off the stream, framed by `Transfer-Encoding: chunked` or its `Content-Length`; None
/// when the peer closed first. `waiting` names what the caller is waiting for.
async fn read_response_typed(stream: &mut (impl AsyncReadExt + Unpin), pending: &mut Vec<u8>, waiting: &str) -> Option<Parsed> {
    let head_end = loop {
        if let Some(at) = pending.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        if !fill(stream, pending, &format!("{waiting}: the response head")).await {
            return None;
        }
    };
    let head = String::from_utf8_lossy(&pending[..head_end]).into_owned();
    let status = head.split(' ').nth(1)?.parse().ok()?;
    // The framing is found through lower-cased names; the head that is returned keeps the names as sent.
    let mut headers = std::collections::BTreeMap::new();
    let mut lines = vec![head.lines().next().unwrap().to_owned()];
    for line in head.lines().skip(1) {
        let (name, value) = line.split_once(':').expect("a header line has a colon");
        headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
        lines.push(if name.eq_ignore_ascii_case("date") { format!("{name}: {DATE_TOKEN}") } else { line.to_owned() });
    }
    let head = lines.join("\r\n");
    let mut at = head_end + 4;
    let mut body = Vec::new();
    if headers.get("transfer-encoding").is_some_and(|v| v == "chunked") {
        loop {
            let line_end = loop {
                if let Some(p) = pending[at..].windows(2).position(|w| w == b"\r\n") {
                    break at + p;
                }
                if !fill(stream, pending, &format!("{waiting}: a chunk size line")).await {
                    return None;
                }
            };
            let size = usize::from_str_radix(std::str::from_utf8(&pending[at..line_end]).unwrap().trim(), 16).expect("a hex chunk size");
            while pending.len() < line_end + 2 + size + 2 {
                if !fill(stream, pending, &format!("{waiting}: a chunk of {size} bytes")).await {
                    return None;
                }
            }
            body.extend_from_slice(&pending[line_end + 2..line_end + 2 + size]);
            at = line_end + 2 + size + 2;
            if size == 0 {
                break;
            }
        }
    } else if let Some(length) = headers.get("content-length") {
        let length: usize = length.parse().unwrap();
        while pending.len() < at + length {
            if !fill(stream, pending, &format!("{waiting}: the response body")).await {
                return None;
            }
        }
        body.extend_from_slice(&pending[at..at + length]);
        at += length;
    } else {
        // No length and no chunking: the body is what comes before the connection ends.
        while fill(stream, pending, &format!("{waiting}: the connection ending after an unframed body")).await {}
        body.extend_from_slice(&pending[at..]);
        at = pending.len();
    }
    let raw = format!("{head}\r\n\r\n{}", String::from_utf8_lossy(&pending[head_end + 4..at]));
    pending.drain(..at);
    Some((status, head, String::from_utf8_lossy(&body).into_owned(), raw))
}
/// Sends `parts` one after the other and returns the first reply, None when the server closed
/// without one.
async fn try_exchange(port: u16, parts: &[&[u8]], half_close: bool) -> Option<(u16, String)> {
    let (mut read, mut write) = connect(port).await.into_split();
    let parts: Vec<Vec<u8>> = parts.iter().map(|p| p.to_vec()).collect();
    // The writer runs beside the reader: a reply may arrive while the sender is still sending,
    // and a server that closes on it must not take the reply down with a failed write.
    let writer = tokio::spawn(async move {
        for part in parts {
            if within("a write of the request", write.write_all(&part)).await.is_err() {
                return;
            }
        }
        if half_close {
            let _ = within("the half-close", write.shutdown()).await;
        }
        std::future::pending::<()>().await;
    });
    let reply = read_response(&mut read, &mut Vec::new()).await;
    writer.abort();
    reply
}

/// Sends `parts` one after the other and returns (status, body text) of the first reply.
async fn exchange(port: u16, parts: &[&[u8]]) -> (u16, String) {
    try_exchange(port, parts, false).await.expect("a reply")
}

// ---- hand-rolled-parser probes: each is a status Node's http server gives ----

/// A chunk that declares far more than the cap is judged frame by frame: the 413 arrives while
/// the sender is still inside the declared chunk, and an endless size line is refused.
#[tokio::test]
async fn a_huge_declared_chunk_is_capped_per_frame_and_an_endless_size_line_is_refused() {
    let f = fx(WebhookConfig::default());
    let listener = serve_on_loopback(&f).await;
    let head = post("/webhook/hook", &[JSON_CT], "Transfer-Encoding: chunked\r\n");
    let megabyte = vec![b' '; 1024 * 1024];
    let mut parts: Vec<&[u8]> = vec![&head, b"6400000\r\n"];
    parts.extend(std::iter::repeat_n(megabyte.as_slice(), MAX_BODY_BYTES / megabyte.len() + 1));
    let (status, text) = exchange(listener.port(), &parts).await;
    assert_eq!(status, 413, "{text}");

    let line = vec![b'1'; 64 * 1024];
    let (status, _) = exchange(listener.port(), &[&head, &line]).await;
    assert_eq!(status, 400);
    assert!(f.dispatched.0.lock().unwrap().is_empty());
    listener.stop().await;
}

#[tokio::test]
async fn malformed_body_framing_is_a_400_and_never_dispatches() {
    let f = fx(WebhookConfig::default());
    let listener = serve_on_loopback(&f).await;
    let signed = [JSON_CT, ("x-github-delivery", "m1")];
    let chunked = post("/webhook/hook", &signed, "Transfer-Encoding: chunked\r\n");
    // Junk where the chunk's CRLF belongs.
    assert_eq!(exchange(listener.port(), &[&chunked, b"2\r\n{}XX0\r\n\r\n"]).await.0, 400);
    // The last chunk never terminated, and the sender went away.
    let unterminated = try_exchange(listener.port(), &[&chunked, b"2\r\n{}\r\n0\r\n"], true).await;
    assert!(matches!(unterminated, Some((400, _)) | None), "{unterminated:?}");
    assert!(f.dispatched.0.lock().unwrap().is_empty());
    listener.stop().await;
}

/// A request framed both ways is the smuggling shape. Node's parser answers it 400; hyper takes
/// RFC 9112 §6.1's other permitted course (chunked wins, Content-Length is dropped) and closes
/// the connection after the reply. Either way the bytes behind the body are never a second
/// request, which is what this pins.
#[tokio::test]
async fn a_request_framed_both_ways_never_carries_a_second_request() {
    let f = fx(WebhookConfig::default());
    let listener = serve_on_loopback(&f).await;
    let both = post("/webhook/hook", &[JSON_CT, ("x-github-delivery", "m2")], "Transfer-Encoding: chunked\r\nContent-Length: 2\r\n");
    let behind = b"2\r\n{}\r\n0\r\n\r\nGET / HTTP/1.1\r\nHost: x\r\n\r\n";
    let mut stream = connect(listener.port()).await;
    send(&mut stream, &both, "the request framed both ways").await;
    send(&mut stream, behind, "the bytes behind it").await;
    let mut replies = Vec::new();
    within("the listener closing the connection", stream.read_to_end(&mut replies)).await.unwrap();
    let text = String::from_utf8(replies).unwrap();
    assert_eq!(text.matches("HTTP/1.1 ").count(), 1, "{text}");
    assert!(f.dispatched.0.lock().unwrap().is_empty());
    listener.stop().await;
}

#[tokio::test]
async fn headers_past_16_kib_get_431() {
    let f = fx(WebhookConfig::default());
    let listener = serve_on_loopback(&f).await;
    let big = "a".repeat(20 * 1024);
    let head = post("/webhook/hook", &[JSON_CT, ("x-big", big.as_str())], "Content-Length: 0\r\n");
    assert_eq!(exchange(listener.port(), &[&head]).await.0, 431);
    listener.stop().await;
}

/// Node's `maxHeadersCount` is 2000, bounded by the 16 KiB head: 103 small headers are served,
/// where hyper's own default of 100 would answer 431.
#[tokio::test]
async fn more_than_a_hundred_headers_under_the_size_limit_are_served() {
    let f = fx(WebhookConfig::default());
    let listener = serve_on_loopback(&f).await;
    let mut head = String::from("GET / HTTP/1.1\r\nHost: x\r\n");
    for i in 0..103 {
        head.push_str(&format!("x-h{i}: v\r\n"));
    }
    head.push_str("\r\n");
    assert_eq!(exchange(listener.port(), &[head.as_bytes()]).await.0, 200);
    listener.stop().await;
}

/// Node's `headersTimeout` and `requestTimeout`: a head that never completes and a body that does not arrive are each
/// answered with Node's recorded bare 408 and the connection ends. The recorded defaults are waited on the paused clock,
/// so the minutes cost no wall time.
#[tokio::test(start_paused = true)]
async fn a_request_that_does_not_arrive_in_time_gets_the_recorded_bare_408() {
    let timing = golden()["timing"].clone();
    assert_eq!(timing["defaults"]["headersTimeoutMs"], super::listener::HEADERS_TIMEOUT.as_millis() as u64);
    assert_eq!(timing["defaults"]["requestTimeoutMs"], super::listener::REQUEST_TIMEOUT.as_millis() as u64);
    let f = fx(WebhookConfig::default());
    let listener = serve_on_loopback(&f).await;
    for case in timing["timeouts"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut stream = connect(listener.port()).await;
        for part in case["parts"].as_array().unwrap() {
            send(&mut stream, part.as_str().unwrap().as_bytes(), name).await;
        }
        advance(timing["defaults"][case["after"].as_str().unwrap()].as_u64().unwrap()).await;
        let mut reply = Vec::new();
        within(&format!("{name}: the 408 and the end of the connection"), stream.read_to_end(&mut reply)).await.unwrap();
        let recorded: Vec<&str> = case["responses"].as_array().unwrap().iter().map(|r| r["raw"].as_str().unwrap()).collect();
        assert_eq!(vec![String::from_utf8_lossy(&reply).into_owned()], recorded, "{name}");
        assert!(case["closed"].as_bool().unwrap());
    }
    assert!(f.dispatched.0.lock().unwrap().is_empty());
    listener.stop().await;
}

/// Node closes a connection that sits idle between requests, after `keepAliveTimeout` plus `keepAliveTimeoutBuffer`
/// (the recorded server settings), though it announces only the first. One connection is asked again just before the
/// timeout and answers; the other, left alone, is closed at it.
#[tokio::test(start_paused = true)]
async fn an_idle_connection_is_closed_at_the_recorded_keep_alive_timeout() {
    let timing = golden()["timing"].clone();
    let keep = &timing["keepAlive"];
    assert!(keep["idleOpenJustBefore"].as_bool().unwrap() && keep["answeredJustBefore"].as_bool().unwrap() && keep["idleClosedJustAfter"].as_bool().unwrap());
    let closes_after = keep["closesAfterMs"].as_u64().unwrap();
    assert_eq!(closes_after, timing["defaults"]["keepAliveTimeoutMs"].as_u64().unwrap() + timing["defaults"]["keepAliveTimeoutBufferMs"].as_u64().unwrap());
    let f = fx(WebhookConfig::default());
    let listener = serve_on_loopback(&f).await;
    let request = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";
    let (mut again, mut idle) = (connect(listener.port()).await, connect(listener.port()).await);
    let (mut again_pending, mut idle_pending) = (Vec::new(), Vec::new());
    send(&mut again, request.as_bytes(), "the first request").await;
    send(&mut idle, request.as_bytes(), "the first request").await;
    assert_eq!(read_response(&mut again, &mut again_pending).await.unwrap().0, 200);
    assert_eq!(read_response(&mut idle, &mut idle_pending).await.unwrap().0, 200);
    advance(closes_after - 1).await;
    send(&mut again, request.as_bytes(), "the request just before the timeout").await;
    let answered = read_response_typed(&mut again, &mut again_pending, "the reply on a connection used just before the keep-alive timeout").await;
    assert_eq!(answered.map(|r| r.0), Some(200));
    advance(1).await;
    let closed = read_response_typed(&mut idle, &mut idle_pending, "the idle connection closing at the keep-alive timeout").await;
    assert_eq!(closed, None);
    listener.stop().await;
}

/// Node serves pipelined requests in order on one connection.
#[tokio::test]
async fn pipelined_requests_are_each_answered_in_order() {
    let f = fx(WebhookConfig::default());
    let listener = serve_on_loopback(&f).await;
    let mut stream = connect(listener.port()).await;
    send(&mut stream, b"GET / HTTP/1.1\r\nHost: x\r\n\r\nGET /nope HTTP/1.1\r\nHost: x\r\n\r\nGET / HTTP/1.1\r\nHost: x\r\n\r\n", "three pipelined requests").await;
    let mut pending = Vec::new();
    let mut replies = Vec::new();
    for _ in 0..3 {
        replies.push(read_response(&mut stream, &mut pending).await.expect("a reply per request"));
    }
    assert_eq!(replies, vec![(200, "OK".to_string()), (404, "Not Found".to_string()), (200, "OK".to_string())]);
    listener.stop().await;
}

fn post(path: &str, headers: &[(&str, &str)], framing: &str) -> Vec<u8> {
    let mut head = format!("POST {path} HTTP/1.1\r\nHost: x\r\n{framing}");
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    head.into_bytes()
}

#[tokio::test]
async fn the_listener_routes_gets_and_posts_and_walks_past_a_busy_port() {
    let f = fx(WebhookConfig::default());
    let busy = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let busy_port = busy.local_addr().unwrap().port();
    let service = Arc::new(WebhookService::new(f.store.clone(), f.dispatched.clone(), WebhookConfig::default(), f.work.clone(), Arc::new(|| 0)));
    let listener = WebhookListener::start(service, busy_port).await.unwrap();
    assert!((busy_port + 1..=busy_port + 7).contains(&listener.port()), "walked up from the busy port");
    assert_eq!(f.work.count(), 1, "a listening server is running work");

    assert_eq!(exchange(listener.port(), &[b"GET / HTTP/1.1\r\nHost: x\r\n\r\n"]).await, (200, "OK".into()));
    assert_eq!(exchange(listener.port(), &[b"GET /nope HTTP/1.1\r\n\r\n"]).await, (404, "Not Found".into()));
    assert_eq!(exchange(listener.port(), &[b"POST /elsewhere HTTP/1.1\r\n\r\n"]).await, (404, "Not Found".into()));

    listener.stop().await;
    assert!(f.work.is_idle());
    drop(busy);
}

#[tokio::test]
async fn a_signed_body_arrives_byte_exact_whether_sized_or_chunked() {
    let f = fx(WebhookConfig::default());
    let listener = serve_on_loopback(&f).await;
    let body = r#"{"a":"€"}"#.as_bytes();
    let sig = sign("s3", body);
    let signed = [JSON_CT, ("x-hub-signature-256", sig.as_str()), ("x-github-delivery", "t1")];

    // Content-Length, the body split across writes (and inside the multi-byte character).
    let length = format!("Content-Length: {}\r\n", body.len());
    let head = post("/webhook/hook", &signed, &length);
    let (status, text) = exchange(listener.port(), &[&head, &body[..7], &body[7..]]).await;
    assert_eq!(status, 200, "{text}");
    assert!(text.contains("accepted"));

    // Chunked, with another delivery id so it is not a replay.
    let other = [JSON_CT, ("x-hub-signature-256", sig.as_str()), ("x-github-delivery", "t2")];
    let head = post("/webhook/hook", &other, "Transfer-Encoding: chunked\r\n");
    let chunked = [b"4\r\n".as_slice(), &body[..4], b"\r\n", format!("{:x}\r\n", body.len() - 4).as_bytes(), &body[4..], b"\r\n0\r\n\r\n"].concat();
    let (status, text) = exchange(listener.port(), &[&head, &chunked]).await;
    assert_eq!(status, 200, "{text}");

    let seen = f.dispatched.0.lock().unwrap().clone();
    assert_eq!(seen, vec![("hook".to_string(), json!({"a": "€"})); 2]);
    listener.stop().await;
}

#[tokio::test]
async fn the_endpoint_gate_answers_before_any_body_is_read() {
    let f = fx(WebhookConfig::default());
    let listener = serve_on_loopback(&f).await;
    // A declared body that never comes: the 404 must not wait for it.
    let head = post("/webhook/nope", &[JSON_CT], "Content-Length: 1000\r\n");
    let (status, text) = exchange(listener.port(), &[&head]).await;
    assert_eq!((status, text.as_str()), (404, r#"{"error":"unknown endpoint"}"#));
    listener.stop().await;
}

#[tokio::test]
async fn a_body_past_the_cap_gets_413_at_the_crossing_chunk_and_never_dispatches() {
    let f = fx(WebhookConfig::default());
    let listener = serve_on_loopback(&f).await;
    let total = MAX_BODY_BYTES + 1;
    let head = post("/webhook/hook", &[JSON_CT], &format!("Content-Length: {total}\r\n"));
    let megabyte = vec![b' '; 1024 * 1024];
    let mut parts: Vec<&[u8]> = vec![&head];
    parts.extend(std::iter::repeat_n(megabyte.as_slice(), MAX_BODY_BYTES / megabyte.len()));
    parts.push(b" ");
    let (status, text) = exchange(listener.port(), &parts).await;
    assert_eq!(status, 413);
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), json!({"error":"payload too large","limit":MAX_BODY_BYTES}));
    assert!(f.dispatched.0.lock().unwrap().is_empty());
    assert!(f.store.deliveries.lock().unwrap().is_empty());
    listener.stop().await;
}

mod lifecycle_tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;
    use crate::webhooks::lifecycle::{HookTunnel, LocalPort, TunnelStarter, WebhookServer};

    struct Fake {
        closed: Arc<AtomicBool>,
    }
    impl HookTunnel for Fake {
        fn public_base(&self) -> String {
            "https://relay.example/hook/dev-1".into()
        }
        fn close(&mut self) {
            self.closed.store(true, Ordering::SeqCst);
        }
    }

    #[derive(Default)]
    struct Starter {
        mode: usize,
        starts: AtomicUsize,
        closed: Arc<AtomicBool>,
        port_seen: Mutex<Option<LocalPort>>,
    }
    #[async_trait]
    impl TunnelStarter for Starter {
        async fn start(&self, port: LocalPort) -> Result<Option<Box<dyn HookTunnel>>, String> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            *self.port_seen.lock().unwrap() = Some(port);
            match self.mode {
                0 => Ok(Some(Box::new(Fake { closed: self.closed.clone() }))),
                1 => Ok(None),
                _ => Err("boom".into()),
            }
        }
    }

    async fn server(starter: &Arc<Starter>) -> WebhookServer {
        let f = fx(WebhookConfig::default());
        let service = Arc::new(WebhookService::new(f.store.clone(), f.dispatched.clone(), WebhookConfig::default(), f.work.clone(), Arc::new(|| 0)));
        WebhookServer::new(service, starter.clone(), 0)
    }

    #[tokio::test]
    async fn the_tunnel_starts_once_the_listener_is_bound_and_closes_before_it_stops() {
        let starter = Arc::new(Starter::default());
        let mut server = server(&starter).await;
        server.start().await.unwrap();
        server.start().await.unwrap();
        assert_eq!(starter.starts.load(Ordering::SeqCst), 1);
        let port = server.port().unwrap();
        assert_eq!(starter.port_seen.lock().unwrap().as_ref().unwrap().get(), Some(port), "the tunnel reads the bound port");
        assert_eq!(server.url("gh"), "https://relay.example/hook/dev-1/webhook/gh");
        server.stop().await;
        assert!(starter.closed.load(Ordering::SeqCst));
        assert_eq!(starter.port_seen.lock().unwrap().as_ref().unwrap().get(), None, "a stopped server has no local port");
    }

    #[tokio::test]
    async fn a_disabled_or_failed_tunnel_leaves_the_local_url() {
        for mode in [1, 2] {
            let starter = Arc::new(Starter { mode, ..Default::default() });
            let mut server = server(&starter).await;
            server.start().await.unwrap();
            assert_eq!(server.url("gh"), format!("http://localhost:{}/webhook/gh", server.port().unwrap()));
            server.stop().await;
        }
    }
}

// ---- hang bounds ----

/// Tells the test the dispatch was reached, then never answers.
struct NeverAnswers(Arc<tokio::sync::Notify>);

#[async_trait]
impl WebhookDispatch for NeverAnswers {
    async fn handle(&self, _n: &str, _p: Value, _h: &Headers, _id: &str, _t: bool) -> Result<HttpReply, String> {
        self.0.notify_one();
        std::future::pending().await
    }
}

/// A dispatch that never answers ends at the deadline with a 504, and the claimed delivery is
/// closed as failed rather than left `received`.
#[tokio::test(start_paused = true)]
async fn a_stuck_dispatch_ends_at_the_deadline_with_a_504_and_a_failed_row() {
    let f = fx(WebhookConfig::default());
    let svc = WebhookService::new(f.store.clone(), Arc::new(NeverAnswers(Arc::default())), WebhookConfig::default(), f.work.clone(), Arc::new(|| 0));
    let body = br#"{"a":1}"#;
    let h = headers(&[JSON_CT, ("x-hub-signature-256", &sign("s3", body)), ("x-github-delivery", "g1")]);
    let reply = svc.process("hook", &h, body).await;
    assert_eq!((reply.status, reply.body), (504, json!({"error":"processing timeout"})));
    assert_eq!(f.store.deliveries.lock().unwrap().values().cloned().collect::<Vec<_>>(), vec!["failed".to_string()]);
}

/// After stop, a request still inside its handler is cut at the shutdown grace (5 s), not left to
/// run to the 25 s process bound: the client sees the connection close without a 504.
#[tokio::test(start_paused = true)]
async fn a_request_in_flight_is_cut_at_the_shutdown_grace() {
    let f = fx(WebhookConfig::default());
    let reached = Arc::new(tokio::sync::Notify::new());
    let service = Arc::new(WebhookService::new(f.store.clone(), Arc::new(NeverAnswers(reached.clone())), WebhookConfig::default(), f.work.clone(), Arc::new(|| 0)));
    let listener = WebhookListener::start(service, 0).await.unwrap();
    let port = listener.port();
    let body = br#"{"a":1}"#;
    let signature = sign("s3", body);
    let len = body.len().to_string();
    let mut request = post("/webhook/hook", &[JSON_CT, ("x-hub-signature-256", &signature), ("content-length", &len)], "");
    request.extend_from_slice(body);
    let reply = tokio::spawn(async move { try_exchange(port, &[&request], false).await });
    reached.notified().await;
    listener.stop().await;
    assert_eq!(reply.await.unwrap(), None, "the request ran to the 25 s bound instead of the grace");
}
