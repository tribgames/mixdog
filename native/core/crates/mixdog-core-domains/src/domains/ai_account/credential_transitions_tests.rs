//! The credential registry's state transitions, replayed from what the patched Node did through the same entry points
//! (`benchmarks/rust-core/recorders/record-credential-transitions.mjs`): the custom-provider connection test (a real send
//! over the production link, the transport guard included) and the Devin sign-in's code exchange, against an endpoint that
//! answers each request as the recorded one was answered. Every step's answer or thrown text and every request (origin,
//! method, path, authorization), in order, equal the recording; so do the connection warm-ups (`HEAD`), as a sequence of
//! their own (the manifest's exclusion: their place among the requests is a race); the Devin record is the stored file,
//! compared whole.

use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_ai::oauth::CredentialFile;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::oauth::PkceProvider;
use mixdog_ai::providers::devin::login::DevinLogin;
use mixdog_ai::transport::KeepaliveSchedule;
use mixdog_ai::transport::ReqwestLink;
use mixdog_ai::transport::redirect::Redirected;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::net::TcpListener;
use tokio::net::TcpStream;
use tokio::sync::watch;

use super::collaborators::CustomProviders;
use super::custom_admin_tests::world;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/credential-transitions/golden.json");
/// The verifier the recorder's sign-in sent with its code.
const SIGN_IN_VERIFIER: &str = "sign-in-verifier-0c3e";

/// What a request was: [origin, method, path, authorization], as the recording writes it.
type Seen = [Value; 4];

/// Answers each request as the recorded exchange with the same origin, method, path and authorization was answered (the
/// first not yet answered); a held stream sends its first chunk, then the rest once the exchange it waited for has been
/// answered whole. `arrived` and `answered` publish what came in and which recorded exchanges were answered whole.
struct Endpoint {
    addr: std::net::SocketAddr,
    arrived: watch::Receiver<Vec<Seen>>,
    script: Arc<Script>,
}

struct Script {
    exchanges: Vec<Value>,
    served: Vec<Value>,
    taken: Mutex<HashSet<usize>>,
    /// The warm-ups that came in, in order.
    warmed: Mutex<Vec<Seen>>,
    arrived: watch::Sender<Vec<Seen>>,
    answered: watch::Sender<HashSet<usize>>,
}

impl Endpoint {
    async fn start(exchanges: Vec<Value>, served: Vec<Value>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (arrived, arrived_rx) = watch::channel(Vec::new());
        let (answered, _) = watch::channel(HashSet::new());
        let script = Arc::new(Script { exchanges, served, taken: Mutex::new(HashSet::new()), warmed: Mutex::default(), arrived, answered });
        let kept = script.clone();
        tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                tokio::spawn(serve(socket, script.clone()));
            }
        });
        Self { addr, arrived: arrived_rx, script: kept }
    }

    fn base(&self) -> String {
        format!("http://{}/v1", self.addr)
    }

    /// Until a request equal to `seen` has come in.
    async fn until_arrived(&mut self, seen: &Seen) {
        within(&format!("the request {seen:?} to arrive"), self.arrived.wait_for(|all| all.contains(seen))).await.expect("the endpoint runs while the test does");
    }
}

/// How long a wait for the other side of the exchange may take before the replay fails.
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);

/// `wait`, which ends when what it waits for happens, or the replay fails naming `what`.
async fn within<T>(what: &str, wait: impl std::future::Future<Output = T>) -> T {
    match tokio::time::timeout(DEADLINE, wait).await {
        Ok(done) => done,
        Err(_) => panic!("the replay waited {DEADLINE:?} for {what}, which never happened"),
    }
}

/// The requests of one connection, in turn, until the client closes it: kept alive as the recorder's Node server kept it
/// (`keep-alive: timeout=5`, never closed by the endpoint).
async fn serve(mut socket: TcpStream, script: Arc<Script>) {
    let mut raw = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let head_end = loop {
            if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                break at + 4;
            }
            let n = socket.read(&mut buffer).await.unwrap_or(0);
            if n == 0 {
                return;
            }
            raw.extend_from_slice(&buffer[..n]);
        };
        let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
        let header = |name: &str| head.lines().find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_owned()));
        assert!(header("transfer-encoding").is_none(), "a request body of known length: {head}");
        let length: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
        while raw.len() < head_end + length {
            let n = socket.read(&mut buffer).await.unwrap();
            assert!(n > 0, "the request body ended early");
            raw.extend_from_slice(&buffer[..n]);
        }
        raw.drain(..head_end + length);
        let mut request_line = head.split_whitespace();
        let method = request_line.next().unwrap().to_owned();
        let path = request_line.next().unwrap().to_owned();
        let origin = header(mixdog_ai::transport::redirect::ORIGIN_HEADER).map_or(Value::Null, Value::String);
        let seen: Seen = [origin, json!(method), json!(path), json!(header("authorization").unwrap_or_default())];
        // The connection warm-up: answered empty as the recorder's endpoint did, kept apart from the requests (its position
        // among them is a race, the manifest's exclusion).
        if method == "HEAD" {
            script.warmed.lock().unwrap().push(seen);
            socket.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n").await.unwrap();
            continue;
        }
        script.arrived.send_modify(|all| all.push(seen.clone()));
        let index = {
            let mut taken = script.taken.lock().unwrap();
            let found = (0..script.exchanges.len())
                .find(|i| !taken.contains(i) && script.exchanges[*i].as_array().unwrap()[..4] == seen[..])
                .unwrap_or_else(|| panic!("a request the recording does not hold: {seen:?}"));
            taken.insert(found);
            found
        };
        let served = &script.served[script.exchanges[index][4].as_u64().unwrap() as usize];
        let status = served["status"].as_u64().unwrap();
        let reason = match status {
            200 => "OK",
            400 => "Bad Request",
            other => panic!("a status the endpoint does not word: {other}"),
        };
        let kind = served["contentType"].as_str().unwrap();
        match served["chunks"].as_array() {
            None => {
                let body = served["body"].as_str().unwrap();
                let reply = format!("HTTP/1.1 {status} {reason}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: keep-alive\r\nkeep-alive: timeout=5\r\n\r\n{body}", body.len());
                socket.write_all(reply.as_bytes()).await.unwrap();
            }
            Some(chunks) => {
                let chunk = |text: &str| format!("{:x}\r\n{text}\r\n", text.len());
                let first = format!("HTTP/1.1 {status} {reason}\r\ncontent-type: {kind}\r\ntransfer-encoding: chunked\r\nconnection: keep-alive\r\nkeep-alive: timeout=5\r\n\r\n{}", chunk(chunks[0].as_str().unwrap()));
                socket.write_all(first.as_bytes()).await.unwrap();
                socket.flush().await.unwrap();
                let held = served["heldUntil"].as_u64().unwrap() as usize;
                within(&format!("the recorded exchange {held} to be answered whole (the held stream of exchange {index})"), script.answered.subscribe().wait_for(|done| done.contains(&held))).await.expect("the endpoint runs while the test does");
                socket.write_all(format!("{}0\r\n\r\n", chunk(chunks[1].as_str().unwrap())).as_bytes()).await.unwrap();
            }
        }
        socket.flush().await.unwrap();
        script.answered.send_modify(|done| {
            done.insert(index);
        });
    }
}

/// The step's outcome as the recording writes it: [answer, thrown text].
fn outcome(result: Result<Value, super::failure::Failure>) -> (Value, Value) {
    match result {
        Ok(answer) => (answer, Value::Null),
        Err(failure) => (Value::Null, json!(failure.message())),
    }
}

async fn replay(name: &str) {
    mixdog_ai::oauth::carried::reset_registry();
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let scenario = &golden["scenarios"][name];
    let exchanges = scenario["exchanges"].as_array().unwrap().clone();
    let mut endpoint = Endpoint::start(exchanges.clone(), golden["served"].as_array().unwrap().clone()).await;
    let base = endpoint.base();
    // The recorder's setting (the manifest's `environment`): the warm-up gate does not lapse inside a scenario.
    let w = world(HashMap::from([("MIXDOG_LLM_KEEPALIVE_MS".to_owned(), "3600000".to_owned())])).await;
    let steps = scenario["steps"].as_array().unwrap();
    // The accounts of the scenario are saved before its first step, each reading its key out of `CT_KEY_<letter>`.
    let mut ids: HashMap<String, String> = HashMap::new();
    for step in steps {
        let who = step[0].as_str().unwrap();
        if who.len() == 1 && !ids.contains_key(who) {
            let input = json!({ "name": format!("account {who}"), "protocol": "openai-chat", "baseURL": base, "apiKeyEnv": variable(who) });
            let saved = w.admin.save(input, 0).await.unwrap();
            ids.insert(who.to_owned(), saved["id"].as_str().unwrap().to_owned());
        }
    }
    let probe = |who: &str, value: &str| -> Value {
        if who == "typed" {
            json!({ "schemaVersion": 2, "protocol": "openai-chat", "baseURL": base, "name": "unsaved", "apiKey": value })
        } else {
            json!({ "schemaVersion": 2, "protocol": "openai-chat", "baseURL": base, "id": ids[who], "name": format!("account {who}"), "apiKeyEnv": variable(who) })
        }
    };
    let mut at = 0;
    while at < steps.len() {
        let step = steps[at].as_array().unwrap();
        let (who, value) = (step[0].as_str().unwrap(), step[1].as_str().unwrap());
        if who == "devin sign-in" {
            let dir = tempfile::tempdir().unwrap();
            let tokens = mixdog_rt::testing::tokens();
            let path = dir.path().join("devin-oauth.json");
            let file = CredentialFile::new(path.clone(), CredentialIo { read: tokens.interactive_io, write: tokens.durability_io });
            let link = Redirected {
                inner: ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap(),
                addr: endpoint.addr,
                tap: Arc::new(|_, _| {}),
                returned: Arc::default(),
                fault_origin: Arc::default(),
                failed: Arc::new(|| {}),
            };
            // The recording ran the sign-in on a fixed clock: the record expires a year after it.
            let now = golden["devinSignInNow"].as_u64().unwrap();
            let login = DevinLogin::new(file, Arc::new(link)).with_clock(Arc::new(move || now));
            login.exchange_checked(value, SIGN_IN_VERIFIER, "http://127.0.0.1:59653/callback").await.expect("the code exchange succeeds");
            let stored: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            assert_eq!(stored, step[2], "{name}: the record the sign-in stored");
            at += 1;
            continue;
        }
        if who.len() == 1 {
            w.env.set(&variable(who), value);
        }
        // A step whose request answers only after the next step's has: the two run together, the next once this one's chat
        // request has come in (as the recorder ran them).
        let holds = exchanges.iter().any(|e| e[3] == format!("Bearer {value}") && golden["served"][e[4].as_u64().unwrap() as usize].get("heldUntil").is_some());
        if holds {
            let next = steps[at + 1].as_array().unwrap();
            let (next_who, next_value) = (next[0].as_str().unwrap(), next[1].as_str().unwrap());
            w.env.set(&variable(next_who), next_value);
            let first = w.admin.test(probe(who, value), 0);
            let started: Seen = [Value::Null, json!("POST"), json!("/v1/chat/completions"), json!(format!("Bearer {value}"))];
            let second = async {
                endpoint.until_arrived(&started).await;
                w.admin.test(probe(next_who, next_value), 0).await
            };
            let (first, second) = tokio::join!(first, second);
            for (step, result) in [(step, first), (next, second)] {
                let (answer, error) = outcome(result);
                assert_eq!([answer, error], step[2..4], "{name}: {} {}", step[0], step[1]);
            }
            at += 2;
            continue;
        }
        let (answer, error) = outcome(w.admin.test(probe(who, value), 0).await);
        assert_eq!([answer, error], step[2..4], "{name}: step {at}: {who} {value}");
        at += 1;
    }
    let arrived = endpoint.arrived.borrow().clone();
    let recorded: Vec<Seen> = exchanges.iter().map(|e| std::array::from_fn(|i| e[i].clone())).collect();
    assert_eq!(arrived.len(), recorded.len(), "{name}: the requests made");
    for (n, (got, want)) in arrived.iter().zip(&recorded).enumerate() {
        assert_eq!(got, want, "{name}: request {n}");
    }
    // The warm-ups: as many as the recording holds, in its order (their place among the requests is the manifest's exclusion).
    let warmed = endpoint.script.warmed.lock().unwrap().clone();
    let recorded_warmups: Vec<Seen> = scenario["warmups"].as_array().unwrap().iter().map(|e| std::array::from_fn(|i| e[i].clone())).collect();
    assert_eq!(warmed, recorded_warmups, "{name}: the connection warm-ups");
}

/// The variable account `who` reads its key out of.
fn variable(who: &str) -> String {
    format!("CT_KEY_{}", who.to_uppercase())
}

/// Finding 1 of reviews 1124m/n: account B's key rotates past the cap of retired values through A's origin and header; a
/// refusal quoting A's key and B's keys has A's (still configured) and B's last 4,096 redacted, B's oldest two not.
#[tokio::test]
async fn two_accounts_on_one_origin_replay_as_recorded() {
    replay("two-accounts-one-origin").await;
}

/// Keys seen only on requests, past their cap: the least recently carried go first.
#[tokio::test]
async fn keys_seen_only_on_requests_replay_as_recorded() {
    replay("keys-seen-only-on-requests").await;
}

/// A key read and sent after another account's response began streaming is redacted from the rest of that stream.
#[tokio::test]
async fn a_key_attached_after_a_stream_began_replays_as_recorded() {
    replay("attached-after-the-stream-began").await;
}

/// The token a sign-in's code exchange grants is redacted from the very next response, before any request carried it.
#[tokio::test]
async fn a_sign_in_token_is_scrubbed_at_once_as_recorded() {
    replay("sign-in-token-scrubbed-at-once").await;
}
