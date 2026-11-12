//! The environment switches of the OpenAI wire, replayed from `fixtures/provider-env-switches` (Node's own sends with the
//! transport captured, one provider instance sent once per setting value, recorded by `record-provider-env-switches.mjs`):
//! `MIXDOG_OAI_STATELESS_HTTP` and `MIXDOG_OAI_DISABLE_REASONING_REPLAY` on the HTTP/SSE request (every header and the body
//! of each request compared whole), and `MIXDOG_OAI_TRANSPORT` on the WebSocket (the upgrade requests and the frames of
//! two turns of one session).

use std::sync::Arc;

use mixdog_ai::providers::openai::codec::OpenAiCodec;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::ModelFacts;
use mixdog_ai::providers::openai::config::ModelFactsSource;
use mixdog_ai::providers::openai::config::OpenAiConfig;
use mixdog_ai::providers::openai::config::REPLAY_OWNER;
use mixdog_ai::providers::openai::config::WireContext;
use mixdog_ai::providers::openai::scripted::Dialed;
use mixdog_ai::providers::openai::scripted::ScriptedDial;
use mixdog_ai::providers::openai::scripted::Wire;
use mixdog_ai::registry::builder::openai_mode;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_protocol::ProviderId;
use serde_json::Value;
use serde_json::json;

const RECORDING: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/provider-env-switches/cases.json");

fn case(id: &str) -> Value {
    let doc: Value = serde_json::from_str(&RECORDING).unwrap();
    doc["cases"].as_array().unwrap().iter().find(|c| c["id"] == id).unwrap().clone()
}

/// The request id is the recorder's draw; the codec's context supplies its own, and both are compared as one marker.
const RANDOM: &str = "<random:hex32>";

struct Ctx {
    name: &'static str,
    setting: Option<String>,
}

impl WireContext for Ctx {
    fn request_id(&self) -> String {
        "0".repeat(32)
    }
    fn now_unix_ms(&self) -> u64 {
        0
    }
    fn turn_state(&self, _scope: &str, _turn_id: &str) -> Option<String> {
        None
    }
    fn var(&self, name: &str) -> Option<String> {
        if name == self.name { self.setting.clone() } else { None }
    }
}

struct Facts;
impl ModelFactsSource for Facts {
    fn facts(&self, _model: &str) -> ModelFacts {
        ModelFacts::default()
    }
}

fn message(m: &Value) -> Message {
    let role = match m["role"].as_str().unwrap() {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        other => panic!("a recorded role: {other}"),
    };
    let mut message = Message::new(role, Content::Text(m["content"].as_str().unwrap().into()));
    if let Some(replay) = m.get("providerReplay") {
        assert_eq!(replay["provider"], REPLAY_OWNER);
        message.push_replay(ProviderReplay { owner: ProviderId::from(REPLAY_OWNER), items: replay["items"].clone() });
    }
    message
}

fn tool(t: &Value) -> ToolDefinition {
    ToolDefinition {
        name: t["name"].as_str().unwrap().into(),
        description: t["description"].as_str().unwrap().into(),
        input_schema: t["inputSchema"].clone(),
        defer_loading: false,
        freeform: None,
    }
}

/// The headers the Node HTTP client adds under the product's own, and the two the adapter sets from the credential after
/// the codec has encoded (the bearer and the account id): the manifest declares them not compared.
const NOT_COMPARED: [&str; 8] = ["host", "connection", "accept-language", "sec-fetch-mode", "accept-encoding", "content-length", "authorization", "chatgpt-account-id"];

fn header<'a>(request: &'a Value, name: &str) -> &'a str {
    for pair in request["headers"].as_array().unwrap() {
        if pair[0].as_str().unwrap().eq_ignore_ascii_case(name) {
            return pair[1].as_str().unwrap();
        }
    }
    panic!("the recorded request has no {name} header")
}

fn random_marked(name: &str, value: &str) -> String {
    if name.eq_ignore_ascii_case("x-client-request-id") {
        assert!(value == RANDOM || (value.len() == 32 && value.bytes().all(|b| b.is_ascii_hexdigit())), "a 32 hex digit request id");
        return RANDOM.into();
    }
    value.into()
}

/// Each POST of Node's recording against what the codec encodes for the same turn under the same setting.
fn replay_http(id: &str, name: &'static str) {
    let case = case(id);
    let input = &case["input"];
    let settings = input["settings"].as_array().unwrap();
    // The GET requests are the provider's background catalog refreshes; the manifest declares them not compared.
    let mut posts = Vec::new();
    for request in case["requests"].as_array().unwrap() {
        if request["method"] == "POST" {
            posts.push(request);
        }
    }
    assert_eq!(posts.len(), settings.len(), "one request per send");
    for (node, setting) in posts.iter().zip(settings) {
        let setting = setting.as_str().map(str::to_owned);
        let body: Value = serde_json::from_str(node["body"].as_str().unwrap()).unwrap();
        let identity = CodexIdentity {
            installation_id: "i".into(),
            user_agent: header(node, "User-Agent").into(),
            version: "0.166.0".into(),
            beta_features: "remote_compaction_v2".into(),
        };
        let codec = OpenAiCodec::new(
            OpenAiConfig::codex(false, false, identity, Arc::new(Facts), Arc::new(Ctx { name, setting: setting.clone() })),
            TransportKind::Http1,
        );
        let request = ModelRequest {
            model: input["model"].as_str().unwrap().into(),
            messages: input["messages"].as_array().unwrap().iter().map(message).collect(),
            tools: input["tools"].as_array().unwrap().iter().map(tool).collect(),
            options: RequestOptions {
                session_id: Some(input["sendOpts"]["sessionId"].as_str().unwrap().into()),
                prompt_cache_key: Some(body["prompt_cache_key"].as_str().unwrap().into()),
                ..Default::default()
            },
        };
        let wire = codec.encode(&request).unwrap();
        assert_eq!(wire.url, format!("{}{}", node["origin"].as_str().unwrap(), node["path"].as_str().unwrap()), "{id} {setting:?}: url");
        let mut sent = Vec::new();
        for (n, v) in &wire.headers {
            if !NOT_COMPARED.contains(&n.to_ascii_lowercase().as_str()) {
                sent.push((n.clone(), random_marked(n, v)));
            }
        }
        let mut recorded = Vec::new();
        for pair in node["headers"].as_array().unwrap() {
            let n = pair[0].as_str().unwrap();
            if !NOT_COMPARED.contains(&n.to_ascii_lowercase().as_str()) {
                recorded.push((n.to_owned(), random_marked(n, pair[1].as_str().unwrap())));
            }
        }
        assert_eq!(sent, recorded, "{id} {setting:?}: headers");
        assert_eq!(String::from_utf8(wire.body).unwrap(), node["body"].as_str().unwrap(), "{id} {setting:?}: body");
    }
}

#[test]
fn the_stateless_http_setting_changes_the_request_as_nodes_send_did() {
    replay_http("oai-stateless-http", "MIXDOG_OAI_STATELESS_HTTP");
}

#[test]
fn the_reasoning_replay_kill_switch_changes_the_request_as_nodes_send_did() {
    replay_http("oai-disable-reasoning-replay", "MIXDOG_OAI_DISABLE_REASONING_REPLAY");
}

/// The upgrade requests and request frames of the product, as the recording reads them: header names lower-cased, the
/// WebSocket client library's handshake headers left out (the manifest declares them not compared).
fn canon_upgrade(method: &str, target: &str, headers: Vec<(String, String)>) -> Value {
    const LIBRARY: [&str; 6] = ["sec-websocket-version", "sec-websocket-key", "sec-websocket-extensions", "connection", "upgrade", "host"];
    let mut kept = Vec::new();
    for (name, value) in headers {
        let name = name.to_lowercase();
        if !LIBRARY.contains(&name.as_str()) {
            let value = random_marked(&name, &value);
            kept.push(json!([name, value]));
        }
    }
    json!({"upgrade": {"method": method, "target": target, "headers": kept}})
}

#[tokio::test]
async fn the_transport_setting_picks_the_frames_nodes_send_wrote() {
    let case = case("oai-transport-ws");
    let sends = case["result"]["sends"].as_array().unwrap();
    let mut groups: Vec<Vec<Value>> = Vec::new();
    for event in case["result"]["events"].as_array().unwrap() {
        if event["event"] == "setting" {
            groups.push(Vec::new());
        } else if let Some(group) = groups.last_mut() {
            group.push(event.clone());
        }
    }
    assert_eq!(groups.len(), sends.len(), "one group of events per setting");
    for (n, (send, group)) in sends.iter().zip(&groups).enumerate() {
        let setting = send["setting"].as_str().map(str::to_owned);
        // What Node's server saw from the client, and what it answered (the script of the dial).
        let mut node = Vec::new();
        let mut answers = Vec::new();
        for event in group {
            match (event["event"].as_str().unwrap(), event["dir"].as_str()) {
                ("upgrade-request", _) => node.push(canon_upgrade(
                    event["method"].as_str().unwrap(),
                    event["target"].as_str().unwrap(),
                    event["headers"].as_array().unwrap().iter().map(|h| (h[0].as_str().unwrap().to_owned(), h[1].as_str().unwrap().to_owned())).collect(),
                )),
                ("frame", Some("client->server")) => node.push(json!({"frame": event["text"]})),
                ("frame", Some("server->client")) => answers.push(event["text"].as_str().unwrap().to_owned()),
                _ => {}
            }
        }
        // The frame's key is the lane the caller names plus the request hash the codec derives (`mixdog-openai-<hash>`).
        let first: Value = serde_json::from_str(node[1]["frame"].as_str().unwrap()).unwrap();
        let lane = first["prompt_cache_key"].as_str().unwrap().rsplit_once('-').unwrap().0;
        let options = RequestOptions {
            session_id: Some(format!("env-ws-{n}")),
            prompt_cache_key: Some(lane.into()),
            ..Default::default()
        };
        let input = &case["input"];
        let turn = |messages: Vec<Message>| {
            Arc::new(ModelRequest { model: input["model"].as_str().unwrap().into(), messages, tools: vec![], options: options.clone() })
        };
        let first_turn: Vec<Message> = input["first"].as_array().unwrap().iter().map(message).collect();
        let mut second_turn = first_turn.clone();
        second_turn.push(message(&send["reply"]));
        second_turn.push(message(&json!({"role": "user", "content": input["second"]["user"]})));

        let dial = ScriptedDial::with(vec![Dialed::Socket { frames: answers, close: (1000, "recorder-end".into()) }]);
        let adapter = mixdog_ai::providers::openai::scripted::adapter(dial.clone(), mixdog_rt::testing::tokens().cpu_bulk, openai_mode(setting.clone()));
        for request in [turn(first_turn), turn(second_turn)] {
            let mut stream = adapter.attempt(request).await.unwrap();
            while let Some(event) = stream.next().await {
                event.unwrap();
            }
        }
        let mut sent = Vec::new();
        for wire in dial.wire() {
            sent.push(match wire {
                Wire::Upgrade { method, target, headers } => canon_upgrade(&method, &target, headers),
                Wire::Frame(text) => json!({"frame": text}),
            });
        }
        assert_eq!(sent, node, "setting {setting:?}: what reached the server");
    }
}
