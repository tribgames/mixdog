//! The Codex identity block of the `openai-oauth` WebSocket: Node's own
//! functions run on fixed inputs (`oracles/openai-codex-metadata-golden.json`)
//! and the intercepted real exchange (`providers-intercepted/
//! openai-oauth-responses-ws`).

#![allow(clippy::disallowed_methods, reason = "test-only: reads recorded fixture files synchronously")]

use std::sync::Arc;

use mixdog_ai::providers::openai::codec::OpenAiCodec;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::ModelFacts;
use mixdog_ai::providers::openai::config::ModelFactsSource;
use mixdog_ai::providers::openai::config::OpenAiConfig;
use mixdog_ai::providers::openai::config::WireContext;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::RequestThread;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::WireCodec;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

struct Ctx {
    now: u64,
    turn_state: Option<String>,
}

impl WireContext for Ctx {
    fn request_id(&self) -> String {
        "0".repeat(32)
    }
    fn now_unix_ms(&self) -> u64 {
        self.now
    }
    fn turn_state(&self, _scope: &str, _turn_id: &str) -> Option<String> {
        self.turn_state.clone()
    }
}

struct Facts;
impl ModelFactsSource for Facts {
    fn facts(&self, _model: &str) -> ModelFacts {
        ModelFacts { fast_tier: true, codex_fast_tier: true, ..ModelFacts::default() }
    }
}

fn read(path: &str) -> Value {
    let path = format!("{}/../../fixtures/providers/{path}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn codec(installation: &str, now: u64, turn_state: Option<String>) -> OpenAiCodec {
    let identity = CodexIdentity {
        installation_id: installation.into(),
        user_agent: "ua".into(),
        version: "0.166.0".into(),
        beta_features: "remote_compaction_v2".into(),
    };
    OpenAiCodec::new(
        OpenAiConfig::codex(false, false, identity, Arc::new(Facts), Arc::new(Ctx { now, turn_state })),
        TransportKind::WebSocket,
    )
}

fn request(input: &Value) -> ModelRequest {
    let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_owned);
    ModelRequest {
        model: text("model").unwrap(),
        messages: vec![Message::new(Role::User, Content::Text("go".into()))],
        tools: vec![],
        options: RequestOptions {
            session_id: text("sessionId"),
            transport_scope: text("transportScope"),
            prompt_cache_key: text("cacheKey"),
            request_kind: text("requestKind"),
            fast: input.get("serviceTier").is_some(),
            thread: input.get("thread").filter(|t| !t.is_null()).map(|t| RequestThread {
                id: t["id"].as_str().unwrap().into(),
                window: t["window"].as_u64().unwrap(),
                turn: t["turn"].as_str().map(Into::into),
                turn_started_at_ms: None,
            }),
            ..Default::default()
        },
    }
}

#[test]
fn the_frame_and_handshake_identity_equal_node_s() {
    let golden = read("oracles/openai-codex-metadata-golden.json");
    let installation = golden["installationId"].as_str().unwrap();
    let now = golden["nowMs"].as_u64().unwrap();
    for scenario in golden["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let input = &scenario["input"];
        let codec = codec(installation, now, input["turnState"].as_str().map(str::to_owned));
        let request = request(input);

        let mut frame = Map::new();
        frame.insert("type".into(), "response.create".into());
        frame.insert("model".into(), request.model.clone().into());
        let framed = codec.ws_frame(&request, frame, input["turnState"].as_str());
        assert_eq!(
            serde_json::to_string(&framed["client_metadata"]).unwrap(),
            serde_json::to_string(&scenario["clientMetadata"]).unwrap(),
            "{name}: client_metadata"
        );

        let wire = codec.encode(&request).unwrap();
        let identity: Vec<(&str, &str)> = wire
            .headers
            .iter()
            .filter(|(k, _)| {
                ["session-id", "thread-id", "x-client-request-id", "x-codex-window-id", "x-codex-turn-metadata", "x-codex-routing-hint"]
                    .contains(&k.as_str())
            })
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let expected: Vec<(&str, &str)> =
            scenario["handshakeHeaders"].as_object().unwrap().iter().map(|(k, v)| (k.as_str(), v.as_str().unwrap())).collect();
        assert_eq!(identity, expected, "{name}: handshake headers");
        assert!(wire.headers.iter().all(|(k, _)| k != "x-codex-turn-state"), "{name}: a socket opens without turn state");
    }
}

#[test]
fn the_recorded_exchange_has_the_same_header_names_and_metadata_keys() {
    let recorded = read("../providers-intercepted/openai-oauth-responses-ws/tool-call/exchange.json");
    let socket = &recorded["records"][0];
    // The recorder normalizes the wall-clock values out of the frame text, which
    // leaves them quoted inside the nested JSON; only the keys are compared.
    let text = socket["frames"][0]["text"].as_str().unwrap().replace("\"<wallclock-ms>\"", "0");
    let frame: Value = serde_json::from_str(&text).unwrap();
    let codec = codec("b3bd341f-5e20-49cf-ae9b-ddf71b42fcee", 0, None);
    let request = request(&json!({"model": "gpt-fixture", "sessionId": "s", "cacheKey": "mixdog-codex"}));
    let mut mine = Map::new();
    mine.insert("type".into(), "response.create".into());
    let mine = codec.ws_frame(&request, mine, None);
    let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(keys(&mine["client_metadata"]), keys(&frame["client_metadata"]));
    let turn = |v: &Value| -> Vec<String> {
        let parsed: Value = serde_json::from_str(v["x-codex-turn-metadata"].as_str().unwrap()).unwrap();
        keys(&parsed)
    };
    assert_eq!(turn(&mine["client_metadata"]), turn(&frame["client_metadata"]));

    // The wire headers (credentials added by the adapter) name what Node's
    // handshake named, upgrade-protocol headers aside.
    let mut names: Vec<String> = codec.encode(&request).unwrap().headers.into_iter().map(|(k, _)| k.to_lowercase()).collect();
    names.extend(["authorization".to_owned(), "chatgpt-account-id".to_owned()]);
    names.sort();
    let mut recorded_names: Vec<String> = socket["headers"]
        .as_object()
        .unwrap()
        .keys()
        .filter(|k| !["connection", "host", "upgrade"].contains(&k.as_str()) && !k.starts_with("sec-"))
        .cloned()
        .collect();
    recorded_names.sort();
    assert_eq!(names, recorded_names);
}

