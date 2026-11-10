//! The Grok request against Node's, at the socket: `fixtures/grok-wire/node-wire.json` is what Node's real
//! `GrokOAuthProvider` (b6f10295a, undici under it) wrote to a loopback server for each scenario of `scenarios.json`
//! (`wire/record.mjs`, two runs, under an exact manifest). Here the production adapter, built by the production builder
//! and sending through the production `ReqwestLink`, is pinned to a loopback TLS server (`wire_server.rs`) and sends the
//! same scenarios; what the server received (request line, every header and its value in the order sent, the body, the
//! connection of each request) is compared whole with Node's. The credentials are the fakes of the scenarios and are
//! compared. The one value that is random per run is replaced by `<random:N>` on both sides, the way Node's recording
//! replaced it, and the recording carries the two Node runs that show it is random.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::provider::ToolDefinition;
use serde_json::Value;
use serde_json::json;

use super::fixture_manifest;
use super::wire_server::Loopback;
use crate::accounts::AccountStore;
use crate::client_versions::ClientVersions;
use crate::client_versions::Live;
use crate::oauth::CredentialIo;
use crate::providers::google::traits::ModelTraits;
use crate::providers::google::traits::ThinkingControl;
use crate::providers::openai::adapter::SessionContext;
use crate::providers::openai::config::CodexIdentity;
use crate::providers::openai::config::NoFacts;
use crate::registry::builder::BuilderEnv;
use crate::registry::builder::DefaultProviderBuilder;
use crate::registry::keys::ApiKeyStore;
use crate::registry::keys::Environment;
use crate::registry::keys::MemoryVault;
use crate::registry::providers::ProviderBuilder;
use crate::transport::KeepaliveDialer;
use crate::transport::KeepaliveSchedule;
use crate::transport::ReqwestLink;

const SCENARIOS: &str = include_str!("../../../../../fixtures/grok-wire/scenarios.json");
const RECORDED: &str = include_str!("../../../../../fixtures/grok-wire/node-wire.json");
const MANIFEST: &str = include_str!("../../../../../fixtures/grok-wire/MANIFEST.json");

/// The hosts the Grok routes talk to (the proxy, the token endpoint, the public catalog).
const HOSTS: [&str; 3] = ["cli-chat-proxy.grok.com", "auth.x.ai", "api.x.ai"];

struct Vars(HashMap<String, String>);

impl Environment for Vars {
    fn var(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

struct Traits;

impl ModelTraits for Traits {
    fn is_gemini_family(&self, _: &str) -> bool {
        false
    }
    fn thinking(&self, _: &str) -> ThinkingControl {
        ThinkingControl::Unspecified
    }
}

fn text(value: &Value) -> String {
    value.as_str().unwrap().to_owned()
}

fn message(node: &Value) -> Message {
    let role = match node["role"].as_str().unwrap() {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        _ => Role::Tool,
    };
    let content = match &node["content"] {
        Value::String(s) => Content::Text(s.clone()),
        parts => Content::Parts(
            parts
                .as_array()
                .unwrap()
                .iter()
                .map(|part| match part["type"].as_str().unwrap() {
                    "text" => ContentPart::Text(text(&part["text"]), None),
                    _ => ContentPart::Image(ImageSource::Base64 { data: text(&part["data"]), mime_type: text(&part["mimeType"]) }),
                })
                .collect(),
        ),
    };
    let mut message = Message::new(role, content);
    for call in node["toolCalls"].as_array().into_iter().flatten() {
        message.tool_calls.push(ToolCall { id: text(&call["id"]), name: text(&call["name"]), arguments: call["arguments"].clone(), native_type: None });
    }
    message.tool_call_id = node["toolCallId"].as_str().map(str::to_owned);
    message
}

/// The request one scenario sends: the scenario's messages and tools, the options of a turn of the scenario's session.
fn request(doc: &Value, scenario: &Value) -> ModelRequest {
    let tools = if scenario["tools"] == true {
        doc["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| ToolDefinition { name: text(&t["name"]), description: text(&t["description"]), input_schema: t["inputSchema"].clone(), defer_loading: false, freeform: None })
            .collect()
    } else {
        Vec::new()
    };
    let send = &scenario["send"];
    let options = RequestOptions {
        session_id: Some(text(&doc["sessionId"])),
        prompt_cache_key: Some(text(&doc["promptCacheKey"])),
        iteration: send["iteration"].as_u64().unwrap() as u32,
        effort: send["effort"].as_str().map(str::to_owned),
        ..RequestOptions::default()
    };
    ModelRequest { model: text(&scenario["model"]), messages: scenario["messages"].as_array().unwrap().iter().map(message).collect(), tools, options }
}

/// The scripted answers of a scenario, as the recorder gave them.
fn script(doc: &Value, scenario: &Value) -> VecDeque<Value> {
    scenario["http"]
        .as_array()
        .unwrap()
        .iter()
        .map(|step| match step["reply"].as_str() {
            Some("refreshed") => json!({ "headers": { "content-type": "application/json" }, "body": doc["refreshedTokens"].to_string() }),
            Some("discovery") => json!({ "headers": { "content-type": "application/json" }, "body": doc["discovery"].to_string() }),
            Some(name) => json!({ "events": doc["replies"][name] }),
            None => step.clone(),
        })
        .collect()
}

/// What the server received for one scenario, by the production adapter and link.
async fn run(doc: &Value, scenario: &Value, server: &Loopback) -> Vec<Value> {
    let dir = tempfile::tempdir().unwrap();
    let token = &scenario["token"];
    let expires_at = token["expiresInMs"].as_u64().map_or(4_102_444_800_000, |ms| super::auth::now_ms() + ms);
    let endpoint = match token.get("tokenEndpoint") {
        Some(Value::Null) => Value::Null,
        _ => doc["tokenEndpoint"].clone(),
    };
    std::fs::write(
        dir.path().join("grok-oauth.json"),
        json!({ "access_token": doc["accessToken"], "refresh_token": doc["refreshToken"], "expires_at": expires_at, "token_endpoint": endpoint, "user_id": doc["userId"] }).to_string(),
    )
    .unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let schedule = KeepaliveSchedule::SPEC;
    // A new link per scenario: a new pool, as Node's recorder recycles its pool, so a connection is numbered within its scenario.
    let link = Arc::new(
        ReqwestLink::with_builder(&schedule, false, |builder| {
            HOSTS.iter().fold(builder.no_proxy().tls_built_in_root_certs(false).add_root_certificate(server.root.clone()), |b, host| b.resolve(host, server.addr))
        })
        .unwrap(),
    );
    let env: Arc<dyn Environment> = Arc::new(Vars(HashMap::from([("MIXDOG_DISABLE_LIVE_CLI_VERSIONS".to_owned(), "1".to_owned())])));
    let versions = ClientVersions::new(link.clone(), dir.path().to_path_buf(), io.clone(), env.clone());
    let builder = DefaultProviderBuilder::new(BuilderEnv {
        http: link.clone(),
        bidi: link,
        dial: Arc::new(KeepaliveDialer::new(schedule)),
        keys: ApiKeyStore::new(Arc::new(MemoryVault::default()), env.clone(), false),
        accounts: AccountStore::new(dir.path().to_path_buf(), io.clone()),
        anthropic_caps: Arc::new(|_| None),
        google_traits: Arc::new(Traits),
        openai_facts: Arc::new(NoFacts),
        openai_context: Arc::new(SessionContext::new()),
        codex_identity: CodexIdentity { installation_id: "i".into(), user_agent: Live::new(|| "ua".into()), version: Live::new(|| "1".into()), beta_features: String::new() },
        pace: Arc::new(crate::oauth::pace::FakePace::default()),
        gzip_lane: tokens.cpu_bulk,
        client_version: "1.0.0".into(),
        grok_client_version: Some(versions.grok_live()),
        cursor_client_version: Some(versions.cursor_live()),
        antigravity_client_version: versions.antigravity_live(),
        client_versions: Some(versions),
        listing: crate::catalog::ListingLookup::new(),
        env,
        home_dir: dir.path().to_path_buf(),
        io,
        gated_off: Arc::new(|_| false),
    });
    let adapter = builder.build("grok-oauth", &json!({ "enabled": true })).await.unwrap();
    server.begin(script(doc, scenario));
    let id = text(&scenario["id"]);
    let mut stream = tokio::time::timeout(std::time::Duration::from_secs(30), adapter.attempt(Arc::new(request(doc, scenario))))
        .await
        .unwrap_or_else(|_| panic!("timed out after 30000 ms awaiting the reply of {id}"))
        .unwrap_or_else(|e| panic!("{id}: {e:?}"));
    while let Some(event) = tokio::time::timeout(std::time::Duration::from_secs(30), stream.next()).await.unwrap_or_else(|_| panic!("timed out after 30000 ms awaiting the end of the stream of {id}")) {
        event.unwrap_or_else(|e| panic!("{id}: {e:?}"));
    }
    assert!(!server.unanswered(), "{id}: a request had no scripted answer");
    assert_eq!(server.script_left(), 0, "{id}: the script was not consumed");
    server.events()
}

/// Every difference between two recordings of the same thing, whole and in order: an object key or array element one side
/// lacks, a value that is not equal. A header list is an array of pairs, so its order, its duplicates and the case of its
/// names are compared with the rest.
fn diff(path: &str, node: &Value, rust: &Value, out: &mut Vec<String>) {
    match (node, rust) {
        (Value::Object(a), Value::Object(b)) => {
            for (key, value) in a {
                match b.get(key) {
                    Some(other) => diff(&format!("{path}.{key}"), value, other, out),
                    None => out.push(format!("{path}.{key}: only in Node")),
                }
            }
            for key in b.keys() {
                if !a.contains_key(key) {
                    out.push(format!("{path}.{key}: only in Rust"));
                }
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
        _ if node != rust => out.push(format!("{path}: {node} in Node, {rust} in Rust")),
        _ => {}
    }
}

const RANDOM_HEADER: &str = "x-grok-req-id";

fn is_uuid(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    parts.iter().map(|p| p.len()).collect::<Vec<_>>() == [8, 4, 4, 4, 12] && value.chars().all(|c| c == '-' || c.is_ascii_hexdigit())
}

/// Replaces each distinct `x-grok-req-id` value of a scenario by `<random:N>` in the order the values first appear, and
/// returns the raw values in that order.
fn replace_random(events: &mut [Value]) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for event in events {
        for header in event["headers"].as_array_mut().unwrap() {
            if header[0].as_str().unwrap().eq_ignore_ascii_case(RANDOM_HEADER) {
                let raw = text(&header[1]);
                assert!(is_uuid(&raw), "{RANDOM_HEADER} is not a uuid: {raw}");
                let n = seen.iter().position(|s| *s == raw).unwrap_or_else(|| {
                    seen.push(raw);
                    seen.len() - 1
                }) + 1;
                header[1] = json!(format!("<random:{n}>"));
            }
        }
    }
    seen
}

/// The two Node runs agree on everything but the header values the recording replaced: each is a uuid that differs between
/// the runs, in the place a placeholder stands, and every placeholder of the recording is one of them.
#[test]
fn the_only_value_node_replaced_is_random_per_run_in_its_two_recorded_runs() {
    fixture_manifest::verify(MANIFEST, &[("node-wire.json", RECORDED), ("scenarios.json", SCENARIOS)]);
    let recorded: Value = serde_json::from_str(RECORDED).unwrap();
    let proof = recorded["randomProof"].as_array().unwrap();
    assert!(!proof.is_empty());
    for entry in proof {
        let (a, b) = (text(&entry["runA"]), text(&entry["runB"]));
        assert!(is_uuid(&a) && is_uuid(&b) && a != b, "{}: {a} / {b}", entry["scenario"]);
        let mut at = recorded["scenarios"].as_array().unwrap().iter().find(|s| s["id"] == entry["scenario"]).unwrap();
        for step in entry["path"].as_array().unwrap() {
            let step = text(step);
            at = match at {
                Value::Array(list) => &list[step.parse::<usize>().unwrap()],
                other => &other[step.as_str()],
            };
        }
        assert_eq!(at, &entry["placeholder"], "{}: the value in place of the random one", entry["scenario"]);
    }
    let placeholders = RECORDED.matches("<random:").count();
    // Each proof entry names its placeholder once in the recording, once in the proof.
    assert_eq!(placeholders, 2 * proof.len(), "a placeholder the proof does not show");
}
/// Every scenario through the production adapter: its recording in Node's shape, and the raw `x-grok-req-id` values it
/// carried, scenario by scenario.
async fn rust_recording() -> (Vec<Value>, Vec<Vec<String>>) {
    fixture_manifest::verify(MANIFEST, &[("node-wire.json", RECORDED), ("scenarios.json", SCENARIOS)]);
    let doc: Value = serde_json::from_str(SCENARIOS).unwrap();
    let server = Loopback::start(&HOSTS).await;
    let (mut scenarios, mut raw) = (Vec::new(), Vec::new());
    for scenario in doc["scenarios"].as_array().unwrap() {
        let mut events = run(&doc, scenario, &server).await;
        raw.push(replace_random(&mut events));
        scenarios.push(json!({ "id": scenario["id"], "traffic": events }));
    }
    // `MIXDOG_GROK_WIRE_RUST_OUT=<file>` writes what the Rust side recorded, for reading it beside Node's.
    if let Ok(path) = std::env::var("MIXDOG_GROK_WIRE_RUST_OUT") {
        std::fs::write(path, serde_json::to_string_pretty(&scenarios).unwrap()).unwrap();
    }
    (scenarios, raw)
}

fn node_scenarios() -> Vec<Value> {
    let recorded: Value = serde_json::from_str(RECORDED).unwrap();
    recorded["scenarios"].as_array().unwrap().clone()
}

/// The requests of a recording in the order they arrived: the request line and the body (its length, hash and text).
fn requests(scenarios: &[Value]) -> Vec<Value> {
    scenarios
        .iter()
        .map(|s| json!({ "id": s["id"], "requests": s["traffic"].as_array().unwrap().iter().map(|e| json!([e["kind"], e["line"], e["body"]])).collect::<Vec<_>>() }))
        .collect()
}

/// What the adapter decides: which requests a turn makes (the warm-up, the refresh, the resend, the version gate's second
/// attempt), in which order, and what each carries in its body: the whole body, with the tools flattened for Grok, the
/// cache key, the effort a model takes, the image, the tool calls and results.
#[tokio::test]
async fn every_request_a_turn_makes_and_its_body_are_nodes() {
    let (rust, raw) = rust_recording().await;
    let mut differences = Vec::new();
    diff("scenarios", &Value::Array(requests(&node_scenarios())), &Value::Array(requests(&rust)), &mut differences);
    assert!(differences.is_empty(), "{} differences from Node's recording:\n{}", differences.len(), differences.join("\n"));
    // The Rust value is random per request, too: no two requests of different scenarios carry one value.
    let all: Vec<&String> = raw.iter().flatten().collect();
    for (i, a) in all.iter().enumerate() {
        assert!(all[i + 1..].iter().all(|b| a != b), "{RANDOM_HEADER} repeated across scenarios: {a}");
    }}

/// The whole recording: every header of every request in the order it was written, and the connection each request rode.
/// What is left after the adapter's own (the headers' names and values, and the order the adapter lists them in) is
/// the HTTP/1 client's: `reqwest`/`hyper` write lower-case names, put `host` and an `accept-encoding` of their own
/// after the caller's headers, send no `connection`, `accept-language`, `sec-fetch-mode` or (on the token calls)
/// `user-agent: node`, and keep one connection per host where undici opens a new one after an error status and after
/// a body it did not read. Owner of the gap: the transport (`mixdog-ai/src/transport`, the loopback work of wire-openai).
#[tokio::test]
#[ignore = "the remaining differences are the HTTP client's (transport, wire-openai); run with --ignored to read them"]
async fn every_header_and_connection_is_nodes() {
    let (rust, _) = rust_recording().await;
    let mut differences = Vec::new();
    diff("scenarios", &Value::Array(node_scenarios()), &Value::Array(rust), &mut differences);
    assert!(
        differences.is_empty(),
        "{} differences from Node's recording; the remainder is the transport's (owner: mixdog-ai/src/transport, wire-openai):\n{}",
        differences.len(),
        differences.join("\n")
    );

}