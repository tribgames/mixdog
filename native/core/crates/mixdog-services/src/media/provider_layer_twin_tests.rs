//! `fixtures/media-provider-layer/golden.json` (`record-media-provider-layer.mjs`): the request
//! Node's `fetchAvailableModels` sends and the rows or failure the media catalog gets from it,
//! and the originator the Codex image adapter presents under each environment override.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::registry::keys::{ApiKeyStore, Environment, SecretVault, VaultError};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::adapter_http::{JsonPost, PostReply};
use super::catalog_fetch::{Auth, HttpFailure};
use super::probe::AgentKeys;
use super::provider_layer::{CODEX_NOT_AUTHENTICATED, LateProbe, codex_row, PROBE_UNBOUND, CodexProviderSession, StoreKeys, antigravity_headers, antigravity_rows};

const GOLDEN: &str = include_str!("../../../../fixtures/media-provider-layer/golden.json");

/// One scripted answer; every request it receives is kept.
struct Script {
    answer: Result<(u16, String), HttpFailure>,
    seen: Mutex<Vec<(String, Vec<(String, String)>, String)>>,
}

#[async_trait]
impl JsonPost for Script {
    async fn post(&self, url: &str, headers: &[(String, String)], body: &Value, _: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        self.seen.lock().unwrap().push((url.to_owned(), headers.to_vec(), mixdog_js::json_stringify(body)));
        match &self.answer {
            Ok((status, text)) => Ok(PostReply { status: *status, headers: Vec::new(), body: text.clone() }),
            Err(failure) => Err(failure.clone()),
        }
    }

    async fn get(&self, _: &str, _: &[(String, String)], _: Duration, _: &CancellationToken) -> Result<PostReply, HttpFailure> {
        unreachable!("the catalog is a POST")
    }
}

/// What the golden's scripted `fetch` answered for the scenario `name`.
fn answer_of(name: &str, rows: &Value) -> Result<(u16, String), HttpFailure> {
    let ok = |value: Value| Ok((200, value.to_string()));
    match name {
        "rows with a project" | "rows without a project" => ok(rows.clone()),
        "an empty project is no project" => ok(json!({ "models": {} })),
        "models missing" => ok(json!({ "other": 1 })),
        "models is a list" => ok(json!({ "models": [1] })),
        "models is null" => ok(json!({ "models": null })),
        "401 with a body" => Ok((401, "invalid credentials".to_owned())),
        "403 with a long body (cut to 300)" => Ok((403, "x".repeat(500))),
        "500 with no body" => Ok((500, String::new())),
        "200 that is not JSON" => Ok((200, "oops".to_owned())),
        "200 with an empty body" => Ok((200, String::new())),
        "200 with a truncated body" => Ok((200, "{\"models\": {\"a\"".to_owned())),
        "401 whose body carries secrets" => Ok((401, r#"{"error":"invalid_token","access_token":"leaked","detail":"Bearer abc.def"}"#.to_owned())),
        "403 with a form body" => Ok((403, "refresh_token=r-secret&client_secret=cs denied".to_owned())),
        "the request itself fails" => Err(HttpFailure { message: "fetch failed".to_owned(), timed_out: false }),
        other => panic!("no scripted answer for {other}"),
    }
}

fn rows() -> Value {
    json!({
        "models": {
            "gemini-3.8-flash-high": { "displayName": "Gemini 3.8 Flash (High)", "maxTokens": 1048576, "supportsImages": true },
            "gemini-3.8-flash-low": { "displayName": "Gemini 3.8 Flash (Low)", "maxTokens": 1048576 },
            "chat_internal": { "maxTokens": 10 },
            "plain-string-row": "not an object",
            "with-own-id": { "id": "other", "displayName": "Own Id" },
        }
    })
}

#[tokio::test]
async fn the_antigravity_catalog_request_and_rows_are_nodes() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let version = golden["antigravityVersion"].as_str().unwrap();
    let scenarios = golden["antigravity"].as_array().unwrap();
    assert_eq!(scenarios.len(), 15);
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let script = Script { answer: answer_of(name, &rows()), seen: Mutex::default() };
        let auth = Auth {
            token: scenario["token"].as_str().unwrap().to_owned(),
            project_id: scenario["project"].as_str().map(str::to_owned),
            ..Auth::default()
        };
        let outcome = antigravity_rows(&script, version, &auth).await;
        let seen = script.seen.lock().unwrap();
        let sent = scenario["requests"].as_array().unwrap();
        assert_eq!(seen.len(), sent.len(), "{name}");
        let (url, headers, body) = &seen[0];
        assert_eq!(url, sent[0]["url"].as_str().unwrap(), "{name}");
        let wanted: Vec<(String, String)> = sent[0]["headers"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
        assert_eq!(headers, &wanted, "{name}: headers, in order");
        assert_eq!(body, sent[0]["body"].as_str().unwrap(), "{name}");
        match (&scenario["outcome"]["rows"], &scenario["outcome"]["error"]) {
            (rows, Value::Null) => assert_eq!(serde_json::to_string(&outcome.unwrap()).unwrap(), serde_json::to_string(rows).unwrap(), "{name}: rows, key order included"),
            (_, error) => assert_eq!(outcome.unwrap_err().message, error.as_str().unwrap(), "{name}"),
        }
    }
}

#[test]
fn the_antigravity_image_identity_is_nodes() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for row in golden["antigravitySession"].as_array().unwrap() {
        // The version is the client-versions component's (its own golden): the override trimmed, else the default.
        let version = row["override"].as_str().map_or(golden["antigravityVersion"].as_str().unwrap().to_owned(), |v| v.trim().to_owned());
        let wanted: Vec<(String, String)> = row["headers"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
        assert_eq!(antigravity_headers(&version), wanted, "{row}");
        assert_eq!(super::provider_layer::ANTIGRAVITY_GATEWAY, row["endpoint"].as_str().unwrap());
    }
}

#[test]
fn the_originator_follows_the_environment_as_codex_originator_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    for row in golden["codex"].as_array().unwrap() {
        let env = row["env"].clone();
        let originator = CodexProviderSession::originator_of(Arc::new(move |name| env[name].as_str().map(str::to_owned)));
        assert_eq!(originator.get(), row["originator"].as_str().unwrap(), "{}", row["env"]);
    }
}

#[test]
fn the_missing_login_text_is_nodes() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    assert_eq!(CODEX_NOT_AUTHENTICATED, golden["codexMissing"].as_str().unwrap());
}

const KEYS_GOLDEN: &str = include_str!("../../../../fixtures/agent-keys/golden.json");

/// The process environment of a scenario.
struct MapEnv(std::collections::HashMap<String, String>);

impl Environment for MapEnv {
    fn var(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

/// The keychain of a scenario.
struct MapVault(std::collections::HashMap<String, String>);

#[async_trait]
impl SecretVault for MapVault {
    async fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        Ok(self.0.get(account).cloned())
    }
    async fn set(&self, _: &str, _: &str) -> Result<(), VaultError> {
        unreachable!("the keys are only read")
    }
    async fn delete(&self, _: &str) -> Result<(), VaultError> {
        unreachable!("the keys are only read")
    }
}

fn strings(value: &Value) -> std::collections::HashMap<String, String> {
    value.as_object().into_iter().flatten().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect()
}

#[tokio::test]
async fn the_agent_keys_are_nodes_for_every_environment_and_keychain() {
    let golden: Value = serde_json::from_str(KEYS_GOLDEN).unwrap();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 13);
    for scenario in scenarios {
        let env = strings(&scenario["env"]);
        let remote = env.get("MIXDOG_MODEL_PROXY").is_some_and(|mode| mode == "client");
        let keys = StoreKeys(ApiKeyStore::new(Arc::new(MapVault(strings(&scenario["stored"]))), Arc::new(MapEnv(env)), remote));
        for answer in scenario["answers"].as_array().unwrap() {
            let provider = answer["provider"].as_str().unwrap();
            let name = &scenario["name"];
            assert_eq!(keys.has(provider).await, answer["has"].as_bool().unwrap(), "has {provider:?}: {name}");
            assert_eq!(keys.get(provider).await.as_deref(), answer["get"].as_str(), "get {provider:?}: {name}");
        }
    }
}

#[test]
fn the_settings_read_the_agent_providers_and_the_developer_gate() {
    use super::provider_layer::ConfigSettings;
    use super::probe::AgentSettings;
    let settings = ConfigSettings {
        agent: Arc::new(|| json!({ "providers": { "openai": { "enabled": true } } })),
        developer: Arc::new(|provider| provider != "antigravity-oauth"),
    };
    assert_eq!(settings.providers(), json!({ "openai": { "enabled": true } }));
    assert!(settings.developer_enabled("grok-oauth") && !settings.developer_enabled("antigravity-oauth"));
    // `readSection('agent')?.providers || {}`.
    for agent in [json!({}), json!({ "providers": null }), Value::Null] {
        let settings = ConfigSettings { agent: Arc::new(move || agent.clone()), developer: Arc::new(|_| true) };
        assert_eq!(settings.providers(), json!({}));
    }
}
/// The probe cell: read unbound it is an error naming the cause (never "no login" nor a skipped
/// check), and once bound every holder of the cell sees it.
#[tokio::test]
async fn the_late_probe_fails_loudly_until_it_is_bound() {
    use super::accounts::AccountProbe;
    use super::catalog::CatalogFailure;
    use super::lanes::CatalogRows;
    struct Probe(bool);
    #[async_trait]
    impl AccountProbe for Probe {
        async fn authenticated(&self, _: &str, _: Option<&std::path::Path>) -> bool {
            self.0
        }
        async fn models(&self, _: &str, _: Option<&std::path::Path>) -> Result<CatalogRows, CatalogFailure> {
            unreachable!("the cell test asks no catalog")
        }
    }
    let cell = LateProbe::default();
    let shared = cell.clone();
    assert_eq!(cell.bound().err().map(|error| error.message), Some(PROBE_UNBOUND.to_owned()));
    assert!(cell.bind(Arc::new(Probe(true))).is_ok());
    assert!(shared.bound().unwrap().authenticated("openai-oauth", None).await, "a clone made before the bind sees it");
    assert!(cell.bind(Arc::new(Probe(false))).is_err(), "a second bind is refused");
}
/// The Codex row carries the catalog's statements about the image tool under the keys the media
/// catalog reads: a boolean flag as `supportsImageGeneration`, the tools as bare type names whether the
/// catalog listed strings or `{ type }` records (`toolTypeNames`), and neither when it states none.
#[test]
fn a_codex_row_carries_the_image_tool_statements_of_the_catalog() {
    use mixdog_core_api::domain::provider::ModelRecord;
    let mut record = ModelRecord::new("gpt-5.5");
    record.name = Some("GPT 5.5".to_owned());
    record.display_name = Some("GPT 5.5".to_owned());
    record.raw = Some(json!({ "supports_image_generation": true, "supported_tools": ["web_search", { "type": "image_generation" }, ""] }));
    assert_eq!(
        codex_row(&record),
        json!({ "id": "gpt-5.5", "name": "GPT 5.5", "display": "GPT 5.5", "supportsImageGeneration": true, "supportedTools": ["web_search", "image_generation"] })
    );
    let mut bare = ModelRecord::new("gpt-5");
    bare.raw = Some(json!({ "supports_image_generation": "yes" }));
    assert_eq!(codex_row(&bare), json!({ "id": "gpt-5" }), "a non-boolean flag and no tool list state nothing");
}