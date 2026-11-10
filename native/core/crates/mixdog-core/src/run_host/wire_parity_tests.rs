//! Wire parity with Node (`b6f10295a`): the bytes the Rust core's production clients write, equal to the bytes Node's real
//! clients write. The scenarios (`benchmarks/terminal-bench-2.1/analysis/parity/scenarios.json`) and the session document
//! (the core's own system texts, tools and ids) are run through the production builder (`builder_env`, the real adapters
//! and codecs) and the real transports (`ReqwestLink`, `KeepaliveDialer`), pinned to a loopback TLS server
//! (`wire_loopback.rs`) that records what it receives: the upgrade request, every frame, every http request with its
//! headers in the order sent and its body. The expectation is Node's recording of the same scenarios
//! (`node-wire-capture.mjs` and `wire-server.mjs`, whose manifest this test verifies), never hand-written.
//!
//! `MIXDOG_WIRE_RUST_OUT=<file>` writes the recording of all four providers, which `wire-compare.mjs` lists against a
//! fresh Node recording.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use mixdog_agent::repair::ToolCallIds;
use mixdog_agent::response::{ModelResponse, ResponseBuilder};
use mixdog_ai::admission::{Admission, AdmissionRequest, LaneKey, LaneSettings};
use mixdog_ai::broker::{AttemptSink, ModelBroker, SendRequest};
use mixdog_ai::catalog::ModelRecord;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_core_api::domain::provider::{ProviderError, StreamEvent};
use mixdog_core_api::domain::retry::{Decision, JitterSamples, RetryDecider, RetryPolicy, RetryState, Verdict};
use mixdog_rt::CancellationToken;
use mixdog_ai::providers::openai::adapter::SessionContext;
use mixdog_ai::registry::builder::DefaultProviderBuilder;
use mixdog_ai::registry::providers::ProviderBuilder;
use mixdog_ai::transport::{KeepaliveDialer, KeepaliveSchedule, ReqwestLink};
use mixdog_core_api::domain::provider::{CacheTier, Content, Message, ModelRequest, RequestOptions, Role, ServiceTier, ToolDefinition};
use mixdog_protocol::ProviderId;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::builder_env::builder_env;
use super::fixture_fs;
use super::process::HostInfo;
use super::process_tests::world;
use mixdog_ai::transport::loopback::{Loopback, Script, RANDOM};

const SESSION: &str = include_str!("../../../../../../benchmarks/terminal-bench-2.1/analysis/parity/fixtures/session.json");
const SCENARIOS: &str = include_str!("../../../../../../benchmarks/terminal-bench-2.1/analysis/parity/scenarios.json");
const NODE: &str = include_str!("../../../../../../benchmarks/terminal-bench-2.1/analysis/parity/fixtures/node-recording.json");
const CAPTURE: &str = include_str!("../../../../../../benchmarks/terminal-bench-2.1/analysis/parity/node-wire-capture.mjs");
const SERVER: &str = include_str!("../../../../../../benchmarks/terminal-bench-2.1/analysis/parity/wire-server.mjs");

/// The Node commit the recording must have been made from.
const NODE_COMMIT: &str = "b6f10295a";

/// The fake credentials of `fake-credentials.mjs`.
const FAKE: &str = "fake-credential-not-a-secret";
const FAR: u64 = 4_102_444_800_000;

/// Every await of the recording runs under this deadline, and a miss names what was awaited.
const DEADLINE: Duration = Duration::from_secs(30);

async fn within<T>(what: impl std::fmt::Display, future: impl std::future::Future<Output = T>) -> T {
    match tokio::time::timeout(DEADLINE, future).await {
        Ok(value) => value,
        Err(_) => panic!("timed out after {} ms awaiting {what}", DEADLINE.as_millis()),
    }
}

fn text(value: &Value) -> String {
    value.as_str().expect("a string").to_owned()
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

// ---- the scenarios -------------------------------------------------------------------------------

/// A scenario message: a stored row in Node's shape (`{role, content, toolCalls, toolCallId, providerReplay}`, image
/// parts), read as the core reads its stored rows.
fn message(node: &Value) -> Message {
    super::message_row::message_of(node).unwrap_or_else(|e| panic!("a scenario message the store cannot read: {e}")).message
}

/// The request one scenario sends, as the core assembles it (`HostRunParts::request_parts`): the session's four system
/// messages (the third `Tier3`, the fourth `Env`), the session's tools, the thread's identity, the provider's cache key.
fn request(session: &Value, scenario: &Value, model: &str, stored: &StoredSession) -> ModelRequest {
    let system = session["system"].as_array().unwrap();
    assert_eq!(system.len(), 4, "base rules, stable context, session marker, environment");
    let mut messages: Vec<Message> = system
        .iter()
        .zip([None, None, Some(CacheTier::Tier3), Some(CacheTier::Env)])
        .map(|(body, tier)| {
            let mut message = Message::new(Role::System, Content::Text(text(body)));
            message.cache_tier = tier;
            message
        })
        .collect();
    messages.extend(scenario["messages"].as_array().unwrap().iter().map(message));
    let tools = session["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| ToolDefinition {
            name: text(&tool["name"]),
            description: text(&tool["description"]),
            input_schema: tool["inputSchema"].clone(),
            defer_loading: tool["deferLoading"] == true,
            freeform: None,
        })
        .collect();
    let thread = stored.thread.clone();
    let mut options = RequestOptions { session_id: Some(thread.clone()), ..RequestOptions::default() };
    if scenario["provider"] == "openai-oauth" {
        options.prompt_cache_key = Some("mixdog-codex".into());
        // The turn's effort and the session's fast flag (`buildRequestSendOptions` `effort: turnEffort`,
        // `fast: session.fast === true`).
        options.effort = scenario["sendOpts"]["effort"].as_str().map(str::to_owned);
        options.fast = scenario["sendOpts"]["fast"] == true;
        // The identity comes through the production assembly from the stored header, not from the fixture's thread id.
        super::assemble::apply_identity(&mut options, &thread.as_str().into(), &stored.header, Some(text(&scenario["turnId"]).as_str().into()));
    }
    ModelRequest { model: model.into(), messages, tools, options }
}

/// The session a scenario's turn runs in, as the store gives it back (its header read from the store's own text): the
/// session document's, a resumed session's stored identity (`identity.stored`), or a sub-agent's own session
/// (`identity.subAgent`), whose header is the one Node's `buildSessionRecord` made for it, read from Node's recording
/// (the identity it minted is the recording's input, as the stored header of a resumed session is).
struct StoredSession {
    thread: String,
    header: mixdog_store::schema::record::Header,
}

fn stored_session(session: &Value, scenario: &Value, node: &[Value]) -> StoredSession {
    let mut header = session["storedHeader"].as_object().unwrap().clone();
    let mut thread = text(&session["threadId"]);
    let identity = &scenario["identity"];
    if let Some(stored) = identity.get("stored") {
        header.insert("codexWireSessionId".into(), stored.clone());
    }
    if let Some(sub) = identity.get("subAgent") {
        let recorded = node.iter().find(|entry| entry["id"] == scenario["id"]).unwrap_or_else(|| panic!("{}: not in Node's recording", scenario["id"]));
        header.extend(recorded["storedHeader"].as_object().expect("the sub-agent's stored header in Node's recording").clone());
        thread = text(&sub["sessionId"]);
    }
    let header = serde_json::from_str(&serde_json::to_string(&header).unwrap()).unwrap();
    StoredSession { thread, header }
}

fn script_of(scenario: &Value) -> Script {
    let list = |key: &str| scenario[key].as_array().into_iter().flatten().cloned().collect::<VecDeque<Value>>();
    Script { dials: list("dials"), replies: list("ws"), http: list("http") }
}

/// The standard retry decider, its backoffs recorded as `sleep` events where they fall among the connections. The jitter
/// draw is the recorder's fixed `Math.random()` (0.5), so a jittered step is the step itself on both sides.
/// The recording's clock moves on by the backoff it records.
struct RecordedBackoff(Arc<Loopback>, Arc<AtomicU64>);

impl RetryDecider for RecordedBackoff {
    fn verdict(&self, error: &ProviderError, state: &RetryState, policy: &RetryPolicy, _: JitterSamples) -> Decision {
        let decision = StandardRetryDecider.verdict(error, state, policy, JitterSamples { step: 0.5, advice: 0.5 });
        if let Verdict::Retry { delay, .. } = &decision.verdict
            && !delay.is_zero()
        {
            let ms = delay.as_millis() as u64;
            self.0.push(json!({ "kind": "sleep", "ms": ms }));
            self.1.fetch_add(ms, Ordering::SeqCst);
        }
        decision
    }
}

/// The events of the attempt in progress, folded as the loop folds them; a retry starts over.
struct Folded(ResponseBuilder, String);

impl AttemptSink for Folded {
    fn event(&mut self, event: StreamEvent) {
        self.0.push(event);
    }
    fn discard(&mut self) {
        self.0 = ResponseBuilder::new(&self.1, ToolCallIds::new(&[]));
    }
}

/// The scenarios a run records: all, or the one `only` names with the ones of its conversation before it (the run of its
/// provider's scenarios back to the last `fresh` one), as `node-wire-capture.mjs --only` selects them.
fn selected<'a>(scenarios: &'a [Value], only: Option<&str>) -> &'a [Value] {
    let Some(only) = only else { return scenarios };
    let at = scenarios.iter().position(|s| s["id"] == only).unwrap_or_else(|| panic!("no scenario {only}"));
    let mut start = at;
    while start > 0 && scenarios[start]["fresh"] != true && scenarios[start - 1]["provider"] == scenarios[at]["provider"] {
        start -= 1;
    }
    &scenarios[start..=at]
}

/// Every scenario through the production adapters and transports; the recording per scenario, in Node's shape.
async fn record_all(only: Option<&str>, node: &[Value]) -> Vec<Value> {
    let session: Value = serde_json::from_str(SESSION).unwrap();
    let doc: Value = serde_json::from_str(SCENARIOS).unwrap();
    let now = doc["nowMs"].as_u64().unwrap();

    let model = "gpt-6.1-sol";
    let mut records = vec![ModelRecord::new(ProviderId::from("openai-oauth"), model)];
    // A scenario that names its own model has that row offer the `priority` service tier, as Node's catalog does.
    let mut tier_models: Vec<&str> = doc["scenarios"].as_array().unwrap().iter().filter_map(|s| s["model"].as_str()).collect();
    tier_models.dedup();
    for id in tier_models {
        let mut record = ModelRecord::new(ProviderId::from("openai-oauth"), id);
        record.picker.service_tiers = vec![ServiceTier { id: "priority".into(), name: "Fast".into(), description: String::new() }];
        records.push(record);
    }
    let mut w = world(&[("MIXDOG_DISABLE_LIVE_CLI_VERSIONS", "1")], json!({}), records).await;
    w.services.installation_id = text(&session["installationId"]);
    w.services.host = HostInfo::from_node(session["host"]["type"].as_str().unwrap(), session["host"]["release"].as_str().unwrap(), session["host"]["arch"].as_str().unwrap());
    let data = w.services.plugin_data.clone();
    let credentials = [
        ("anthropic-oauth-credentials.json", json!({ "claudeAiOauth": { "accessToken": FAKE, "refreshToken": FAKE, "expiresAt": FAR, "scopes": ["user:inference"] } })),
        ("openai-oauth.json", json!({ "access_token": FAKE, "refresh_token": FAKE, "account_id": "fake", "expires_at": FAR })),
        ("grok-oauth.json", json!({ "access_token": FAKE, "refresh_token": FAKE, "expires_at": FAR })),
    ];
    for (file, body) in credentials {
        fixture_fs::write(data.join(file), body.to_string());
    }

    // Every connect of the pinned link and dialer goes to the loopback server (`ReqwestLink::pinned`,
    // `KeepaliveDialer::pinned`), a token refresh too (the OpenAI credential refreshes over `env.http`): nothing leaves
    // the machine. `auth.openai.com` is the refresh's host.
    let hosts = ["chatgpt.com", "api.anthropic.com", "generativelanguage.googleapis.com", "cli-chat-proxy.grok.com", "auth.openai.com"];
    let server = Arc::new(Loopback::start(&hosts).await);
    let schedule = KeepaliveSchedule::SPEC;
    let link = Arc::new(ReqwestLink::pinned(&schedule, server.addr, server.tls.clone()));
    let mut env = builder_env(&w.services);
    env.http = link.clone();
    env.bidi = link;
    env.dial = Arc::new(KeepaliveDialer::pinned(schedule, server.addr, server.tls.clone()));
    // A scenario's environment is the settings its run reads (Node's process.env), set per scenario below.
    let settings: Arc<std::sync::Mutex<std::collections::HashMap<String, String>>> = Arc::default();
    let read = settings.clone();
    // The recording's clock: fixed, and moved on by exactly a recorded backoff, as Node's recorder moves its own.
    let clock = Arc::new(AtomicU64::new(now));
    let reading = clock.clone();
    env.openai_context = Arc::new(SessionContext::with_sources(move || reading.load(Ordering::SeqCst), || "0".repeat(32)).with_var(move |name| read.lock().unwrap().get(name).cloned()));
    let builder = DefaultProviderBuilder::new(env);
    let config = |provider: &str| if provider == "gemini" { json!({ "enabled": true, "apiKey": FAKE }) } else { json!({ "enabled": true }) };

    let mut out = Vec::new();
    let mut openai = None;
    // The latest send of the run and its reply: what a compaction scenario forks.
    let mut last_send: Option<(ModelRequest, ModelResponse)> = None;
    for scenario in selected(doc["scenarios"].as_array().unwrap(), only) {
        let id = text(&scenario["id"]);
        let provider = scenario["provider"].as_str().unwrap();
        let model = match provider {
            "openai-oauth" => scenario["model"].as_str().unwrap_or("gpt-6.1-sol"),
            "anthropic-oauth" => "claude-opus-5-5",
            "gemini" => "gemini-3.8-flash",
            _ => "grok-4.7",
        };
        if provider == "openai-oauth" && (scenario["fresh"] == true || openai.is_none()) {
            // Closing the previous conversation's sockets is the harness's doing: the recorder is paused until every one
            // of them has closed, so nothing of it is in the recording.
            server.pause(true);
            drop(openai.take());
            for conn in server.upgraded() {
                within(format_args!("the close of connection {conn}"), server.closed(conn, false)).await;
            }
            server.pause(false);
            openai = Some(builder.build(provider, &config(provider)).await.unwrap());
        }
        *settings.lock().unwrap() = scenario["env"].as_object().into_iter().flatten().map(|(k, v)| (k.clone(), text(v))).collect();
        server.begin(script_of(scenario));
        let adapter = if provider == "openai-oauth" { openai.clone().unwrap() } else { builder.build(provider, &config(provider)).await.unwrap() };
        let stored = stored_session(&session, scenario, node);
        let outcome = if scenario["compaction"] == true {
            // The compaction summary as the core's compaction sends it (`RequestFork`, the fork of the session's
            // latest request with its reply): here the previous scenario's send.
            let (saved, reply) = last_send.clone().unwrap_or_else(|| panic!("{id}: no send before the compaction to fork"));
            let fork = super::side_requests::RequestFork {
                thread: text(&session["threadId"]).as_str().into(),
                provider: adapter.clone(),
                request: saved,
                reply: Arc::new(std::sync::Mutex::new(Some(reply))),
            };
            match within(format_args!("the reply of {id}"), fork.send_fork()).await {
                Ok(_) => "ok",
                Err(_) => "error",
            }
        } else if scenario["registryRetry"] == true {
            // The send through the core's retrying driver (`ModelBroker::send`, the standard retry decider): Node's
            // provider retries inside `send` (`openai-ws-send-attempts/stream-failure.mjs`). A backoff the decider asks
            // for is recorded as Node's recorder records its sleeps.
            let broker = ModelBroker::new(Arc::new(Admission::new()), Arc::new(RecordedBackoff(server.clone(), clock.clone())));
            let lane = broker.admission().lane(&LaneKey { provider: ProviderId::from(provider), account: "default".into() }, LaneSettings::default());
            let send = SendRequest { request: Arc::new(request(&session, scenario, model, &stored)), lane, admission: AdmissionRequest::default() };
            let mut sink = Folded(ResponseBuilder::new(model, ToolCallIds::new(&[])), model.to_owned());
            // `disposeWhenHeld`: the send's transport scope is disposed once the server has written a held reply, while
            // the response is still running.
            let scope = send.request.options.transport_scope.clone().or_else(|| send.request.options.session_id.clone());
            let dispose = async {
                if scenario["disposeWhenHeld"] == true {
                    server.held().await;
                    adapter.release_transport_scope(scope.as_deref().expect("a disposed send has a scope"));
                }
            };
            let sent = async { broker.send(adapter.as_ref(), send, &mut sink, &CancellationToken::new()).await };
            match within(format_args!("the reply of {id}"), async { tokio::join!(sent, dispose).0 }).await {
                Ok(_) => "ok",
                Err(_) => "error",
            }
        } else {
            let sent = request(&session, scenario, model, &stored);
            // `abortWhenHeld`: the turn is cancelled (its stream let go of) once the server has written a held reply.
            let cancel_when_held = scenario["abortWhenHeld"] == true;
            within(format_args!("the reply of {id}"), async {
                match adapter.attempt(Arc::new(sent.clone())).await {
                    Ok(mut stream) => {
                        // The reply folded as the loop folds it, for a later compaction's fork.
                        let mut reply = ResponseBuilder::new(model, ToolCallIds::new(&[]));
                        loop {
                            let next = if cancel_when_held {
                                tokio::select! {
                                    biased;
                                    () = server.held() => {
                                        drop(stream);
                                        return "error";
                                    }
                                    next = stream.next() => next,
                                }
                            } else {
                                stream.next().await
                            };
                            match next {
                                None => break,
                                Some(Ok(event)) => reply.push(event),
                                Some(Err(_)) => return "error",
                            }
                        }
                        last_send = Some((sent, reply.finish()));
                        "ok"
                    }
                    Err(_) => "error",
                }
            })
            .await
        };
        let mut entry = json!({ "id": id, "provider": provider, "model": model, "outcome": outcome });
        if let Some(kind) = server.unanswered() {
            entry["outcome"] = json!("unanswered");
            entry["unanswered"] = json!(kind);
        }
        assert!(scenario["expectError"] == true || entry["outcome"] == "ok", "{id}: the send ended {}", entry["outcome"]);
        assert_eq!(server.script_left(), 0, "{id}: the script was not consumed");
        if scenario["awaitClose"] == "first" {
            // The scenario's first socket, muted, records its own end: the scenario lasts until it ended.
            let first = server.events().iter().find(|e| e["kind"] == "ws-upgrade").map(|e| e["conn"].as_u64().unwrap() as usize).expect("a scenario that awaits its first socket upgraded one");
            within(format_args!("{id}: the close of connection {first}"), server.closed(first, false)).await;
        } else if scenario["awaitClose"] == true {
            let conn = *server.upgraded().last().expect("a scenario that awaits a close upgraded a socket");
            within(format_args!("{id}: the close of connection {conn}"), server.closed(conn, true)).await;
        }
        if scenario["identity"].get("subAgent").is_some() {
            // The sub-agent's stored header is this run's input (see `stored_session`), listed as Node lists it.
            let keys = ["codexWireSessionId", "promptCacheKey", "owner", "parentSessionId"];
            entry["storedHeader"] = Value::Object(keys.iter().filter_map(|k| stored.header.get(*k).map(|v| ((*k).to_owned(), v.clone()))).collect());
        }
        entry["traffic"] = json!(server.events());
        out.push(entry);
    }
    if let Ok(path) = std::env::var("MIXDOG_WIRE_RUST_OUT") {
        fixture_fs::write(path, serde_json::to_string_pretty(&json!({ "scenarios": out })).unwrap());
    }
    out
}

// ---- the comparison ------------------------------------------------------------------------------

/// Where two texts first differ, with the text around it.
fn first_difference(node: &str, rust: &str) -> String {
    let at = node.bytes().zip(rust.bytes()).position(|(a, b)| a != b).unwrap_or(node.len().min(rust.len()));
    let around = |s: &str| s.get(at.saturating_sub(40)..(at + 80).min(s.len())).unwrap_or("").to_owned();
    format!("differ at byte {at} (node {} bytes, rust {} bytes)\n  node: {}\n  rust: {}", node.len(), rust.len(), around(node), around(rust))
}

/// Every difference between two recordings of the same thing, whole and in order: an object key or array element one
/// side lacks, a value that is not equal. Nothing is sorted, lower-cased or skipped: a header list is an array of pairs, so
/// its order, its duplicates and the case of its names are compared with the rest.
fn diff(path: &str, node: &Value, rust: &Value, out: &mut Vec<String>) {
    match (node, rust) {
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                match b.get(key) {
                    Some(other) => diff(&format!("{path}.{key}"), value, other, out),
                    None => out.push(format!("{path}.{key}: only in Node")),
                }
            }
            for key in b.keys().filter(|key| !a.contains_key(*key)) {
                out.push(format!("{path}.{key}: only in Rust"));
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                out.push(format!("{path}: {} entries in Node, {} in Rust", a.len(), b.len()));
            }
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                diff(&format!("{path}[{index}]"), x, y, out);
            }
        }
        (Value::String(a), Value::String(b)) if a != b => out.push(format!("{path}: {}", first_difference(a, b))),
        _ if node != rust => out.push(format!("{path}: {node} in Node, {rust} in Rust")),
        _ => {}
    }
}

/// The gzip bytes of a request body, where the content they carry is Node's: Node's zlib is Chromium's, whose deflate
/// hashes with ANZAC++ instead of zlib's rolling hash, so the same text compresses to other bytes than any other zlib
/// does (`content-length` follows them). The review of this branch decided that compressed bytes need not be equal, the
/// decoded text, the `Content-Encoding` and the fact of compression must; the user's decision on the compressor is
/// open. Each such event of Rust's takes Node's three compressor-made values once its own are shown consistent (its
/// `content-length` is its byte count) and its decoded text is Node's; everything else is compared as recorded.
fn with_nodes_gzip_bytes(node: &[Value], rust: &mut [Value]) {
    for (node, rust) in node.iter().zip(rust.iter_mut()) {
        let (Some(node), Some(rust)) = (node["traffic"].as_array(), rust["traffic"].as_array_mut()) else { continue };
        for (n, r) in node.iter().zip(rust.iter_mut()) {
            let gzip = |e: &Value| e["kind"] == "http" && e["body"]["encoding"] == "gzip";
            if !gzip(n) || !gzip(r) || n["body"]["text"] != r["body"]["text"] {
                continue;
            }
            let length_at = |e: &Value| e["headers"].as_array().unwrap().iter().position(|h| h[0] == "content-length");
            let (Some(at_n), Some(at_r)) = (length_at(n), length_at(r)) else { continue };
            assert_eq!(r["headers"][at_r][1], r["body"]["bytes"].to_string(), "Rust's content-length is not its gzip byte count");
            r["headers"][at_r][1] = n["headers"][at_n][1].clone();
            r["body"]["bytes"] = n["body"]["bytes"].clone();
            r["body"]["sha256"] = n["body"]["sha256"].clone();
        }
    }
}

/// The scenarios of `provider` in both recordings, compared whole: the same scenarios in the same order, then everything in each.
fn compare(node: &[Value], rust: &[Value], provider: &str) -> Vec<String> {
    let of = |list: &[Value]| list.iter().filter(|s| s["provider"] == provider).cloned().collect::<Vec<_>>();
    let (node, mut rust) = (of(node), of(rust));
    with_nodes_gzip_bytes(&node, &mut rust);
    let mut out = Vec::new();
    diff("scenarios", &Value::Array(node), &Value::Array(rust), &mut out);
    out
}

/// The manifest says what the Node recording is a function of; every part is checked against what is committed.
fn verify_manifest(node: &Value, only: Option<&str>) {
    let manifest = &node["manifest"];
    assert_eq!(manifest["only"].as_str(), only, "a recording of one scenario is compared only on a run of that scenario");
    assert_eq!(manifest["exact"], true, "the recording is Node's, exact");
    assert_eq!(manifest["nodeCommit"], NODE_COMMIT, "the recording was made from another Node commit");
    // Recorded under the desktop's runtime (Electron in node mode), with the tree's clients.
    assert_eq!(manifest["runtime"], json!({ "electron": "43.8.4", "node": "v24.22.1", "bundledUndici": "7.30.1" }), "the runtime the recording ran under");
    assert_eq!(manifest["clients"], json!({ "undici": "8.12.3", "ws": "8.22.0" }), "the clients the recording loaded");
    assert_eq!(manifest["sessionSha256"], sha256(SESSION.as_bytes()), "session.json changed since the recording");
    assert_eq!(manifest["scenariosSha256"], sha256(SCENARIOS.as_bytes()), "scenarios.json changed since the recording");
    assert_eq!(manifest["harness"]["node-wire-capture.mjs"], sha256(CAPTURE.as_bytes()), "node-wire-capture.mjs changed since the recording");
    assert_eq!(manifest["harness"]["wire-server.mjs"], sha256(SERVER.as_bytes()), "wire-server.mjs changed since the recording");
    assert_eq!(manifest["harness"].as_object().unwrap().len(), 2);
    assert_eq!(manifest["replaced"].as_array().unwrap().len(), 1, "only the websocket key is replaced");
    assert_eq!(manifest["replaced"][0]["header"], "Sec-WebSocket-Key");
    assert_eq!(manifest["replaced"][0]["value"], RANDOM);
}

/// Every difference between Node's recording and Rust's for the scenarios of `provider`. `MIXDOG_WIRE_ONLY=<scenario>`
/// runs that one scenario (with its conversation before it) against `MIXDOG_WIRE_NODE`, the recording
/// `node-wire-capture.mjs --only <scenario>` made of it.
async fn differences(provider: &str) -> Vec<String> {
    let only = std::env::var("MIXDOG_WIRE_ONLY").ok();
    let node: Value = match &only {
        Some(_) => {
            let file = std::env::var("MIXDOG_WIRE_NODE").expect("MIXDOG_WIRE_NODE names the recording of the one scenario");
            serde_json::from_str(&std::fs::read_to_string(file).expect("the recording of the one scenario")).unwrap()
        }
        None => serde_json::from_str(NODE).unwrap(),
    };
    verify_manifest(&node, only.as_deref());
    let rust = record_all(only.as_deref(), node["scenarios"].as_array().unwrap()).await;
    compare(node["scenarios"].as_array().unwrap(), &rust, provider)
}

#[tokio::test]
async fn every_openai_request_equals_nodes_recording() {
    let differences = differences("openai-oauth").await;
    assert!(differences.is_empty(), "{} differences from Node's recording:\n{}", differences.len(), differences.join("\n"));
}

#[tokio::test]
async fn every_anthropic_request_equals_nodes_recording() {
    let differences = differences("anthropic-oauth").await;
    assert!(differences.is_empty(), "{} differences from Node's recording:\n{}", differences.len(), differences.join("\n"));
}

#[tokio::test]
async fn every_gemini_request_equals_nodes_recording() {
    let differences = differences("gemini").await;
    assert!(differences.is_empty(), "{} differences from Node's recording:\n{}", differences.len(), differences.join("\n"));
}

fn upgrade_headers(list: &mut [Value]) -> &mut Vec<Value> {
    let event = list.iter_mut().flat_map(|s| s["traffic"].as_array_mut().unwrap().iter_mut()).find(|e| e["kind"] == "ws-upgrade").unwrap();
    event["headers"].as_array_mut().unwrap()
}

/// The comparator reports each way two recordings can differ that a looser one hides: a duplicated header, a reversed
/// header order, an extra scenario, a changed provider.
#[test]
fn the_comparator_reports_what_a_looser_one_hides() {
    let node: Value = serde_json::from_str(NODE).unwrap();
    let scenarios = node["scenarios"].as_array().unwrap().clone();
    assert!(compare(&scenarios, &scenarios, "openai-oauth").is_empty());
    let mutate = |change: &dyn Fn(&mut Vec<Value>)| {
        let mut other = scenarios.clone();
        change(&mut other);
        compare(&scenarios, &other, "openai-oauth")
    };
    let duplicate = mutate(&|list| {
        let headers = upgrade_headers(list);
        let first = headers[0].clone();
        headers.insert(1, first);
    });
    assert!(!duplicate.is_empty(), "a duplicated header goes unreported");
    let reversed = mutate(&|list| upgrade_headers(list).reverse());
    assert!(!reversed.is_empty(), "a reversed header order goes unreported");
    let extra = mutate(&|list| {
        let again = list.iter().find(|s| s["provider"] == "openai-oauth").unwrap().clone();
        list.push(again);
    });
    assert!(!extra.is_empty(), "an extra scenario goes unreported");
    let provider = mutate(&|list| list[0]["provider"] = json!("gemini"));
    assert!(!provider.is_empty(), "a changed provider goes unreported");
    // Of a gzip body only the compressor's bytes are Node's to give: its text, its encoding and its other headers are
    // compared.
    fn gzip_body(list: &mut [Value]) -> &mut Value {
        list.iter_mut().flat_map(|s| s["traffic"].as_array_mut().unwrap().iter_mut()).find(|e| e["body"]["encoding"] == "gzip").unwrap()
    }
    let anthropic = |change: &dyn Fn(&mut Vec<Value>)| {
        let mut other = scenarios.clone();
        change(&mut other);
        compare(&scenarios, &other, "anthropic-oauth")
    };
    assert!(anthropic(&|list| gzip_body(list)["body"]["sha256"] = json!("0")).is_empty(), "the compressor's bytes are compared");
    assert!(!anthropic(&|list| gzip_body(list)["body"]["text"] = json!("{}")).is_empty(), "a changed gzip text goes unreported");
    assert!(!anthropic(&|list| gzip_body(list)["body"]["encoding"] = json!(null)).is_empty(), "a body sent plain goes unreported");
}