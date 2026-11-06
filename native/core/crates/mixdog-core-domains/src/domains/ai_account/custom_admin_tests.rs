//! The custom-provider admin against what Node does (`benchmarks/rust-core/recorders/record-custom-admin.mjs`): each
//! step's answer or refusal, the config after it, every stored secret and the key roster. And a
//! real connection test: `CustomProbes` sending to a scripted local endpoint, through the key pool.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::io::Write as _;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_ai::accounts::AccountStore;
use mixdog_ai::accounts::rotation::AccountRotation;
use mixdog_ai::accounts::rotation::UsageProbe;
use mixdog_ai::admission::Admission;
use mixdog_ai::broker::ModelBroker;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_ai::catalog::ListingLookup;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::oauth::pace::SystemPace;
use mixdog_ai::providers::google::traits::ModelTraits;
use mixdog_ai::providers::google::traits::ThinkingControl;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::NoFacts;
use mixdog_ai::providers::openai::adapter::SessionContext;
use mixdog_ai::registry::builder::BuilderEnv;
use mixdog_ai::registry::builder::DefaultProviderBuilder;
use mixdog_ai::registry::keys::ApiKeyStore;
use mixdog_ai::registry::keys::Environment;
use mixdog_ai::registry::keys::SecretVault;
use mixdog_ai::registry::keys::VaultError;
use mixdog_ai::transport::KeepaliveDialer;
use mixdog_ai::transport::KeepaliveSchedule;
use mixdog_ai::transport::ReqwestLink;
use mixdog_core_api::mock::MockStatePublisher;
use serde_json::Value;
use serde_json::json;
use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::net::TcpListener;

use super::collaborators::AuthRefresh;
use super::collaborators::CustomProviders;
use super::custom_admin::CustomAdmin;
use super::custom_admin::CustomHost;
use super::custom_admin::CustomSeams;
use mixdog_core_config::config::Config;
use mixdog_core_config::config::ConfigLanes;

const GOLDEN: &str = include_str!("../../../../../fixtures/custom-admin/golden.json");

#[derive(Default)]
struct TestVault {
    secrets: Mutex<BTreeMap<String, String>>,
    /// Accounts whose secret lives in the private fallback file.
    fallback: Mutex<Vec<String>>,
    /// Deleting an additional key's secret fails.
    refuse_extra_deletes: AtomicBool,
}

#[async_trait]
impl SecretVault for TestVault {
    async fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        Ok(self.secrets.lock().unwrap().get(account).cloned())
    }
    async fn set(&self, account: &str, value: &str) -> Result<(), VaultError> {
        self.secrets.lock().unwrap().insert(account.to_owned(), value.to_owned());
        Ok(())
    }
    async fn delete(&self, account: &str) -> Result<(), VaultError> {
        if self.refuse_extra_deletes.load(Ordering::SeqCst) && account.contains(".apiKey.") {
            return Err(VaultError("keychain is locked".into()));
        }
        self.secrets.lock().unwrap().remove(account);
        Ok(())
    }
    async fn is_fallback(&self, account: &str) -> bool {
        self.fallback.lock().unwrap().iter().any(|a| a == account)
    }
}

/// Plan usage is not measured for a custom provider's keys.
struct NoProbe;

#[async_trait]
impl UsageProbe for NoProbe {
    async fn measure(&self, _: &str, _: &str, _: bool) {}
}

struct TestEnv(HashMap<String, String>);

impl Environment for TestEnv {
    fn var(&self, name: &str) -> Option<String> {
        self.0.get(name).cloned()
    }
}

#[derive(Default)]
struct CountingRefresh(AtomicUsize);

impl AuthRefresh for CountingRefresh {
    fn after_credential_change(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
    fn adopt_credentials(&self) {}
    fn after_usage_auth_change(&self) {}
    fn release_admission_cooldowns(&self) {}
    fn account_selection_changed(&self) {}
}

struct Traits;

impl ModelTraits for Traits {
    fn is_gemini_family(&self, _: &str) -> bool {
        true
    }
    fn thinking(&self, _: &str) -> ThinkingControl {
        ThinkingControl::Unspecified
    }
}

pub(super) struct World {
    pub(super) admin: Arc<CustomAdmin>,
    config: Config,
    vault: Arc<TestVault>,
    accounts: AccountStore,
    refresh: Arc<CountingRefresh>,
    /// What the host wrote to its stderr.
    log: Arc<Mutex<Vec<String>>>,
    _dir: tempfile::TempDir,
}

pub(super) async fn world(env: HashMap<String, String>) -> World {
    let dir = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let io = || CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let path = dir.path().join("mixdog-config.json");
    let lanes = ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io };
    let (config, _) = Config::open(path, Arc::new(MockStatePublisher::default()), lanes).await.unwrap();
    config
        .update_agent(|doc| {
            doc.insert("providers".into(), json!({}));
            doc.insert("modelSettings".into(), json!({}));
            Ok(())
        })
        .await
        .unwrap();
    let vault = Arc::new(TestVault::default());
    let env: Arc<dyn Environment> = Arc::new(TestEnv(env));
    let keys = ApiKeyStore::new(vault.clone(), env.clone(), false);
    let accounts = AccountStore::new(dir.path().join("accounts"), io());
    let link = Arc::new(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).unwrap());
    let builder = Arc::new(DefaultProviderBuilder::new(BuilderEnv {
        http: link.clone(),
        bidi: link,
        dial: Arc::new(KeepaliveDialer::new(KeepaliveSchedule::SPEC)),
        keys: keys.clone(),
        accounts: accounts.clone(),
        anthropic_caps: Arc::new(|_| None),
        google_traits: Arc::new(Traits),
        openai_facts: Arc::new(NoFacts),
        openai_context: Arc::new(SessionContext::new()),
        codex_identity: CodexIdentity {
            installation_id: "i".into(),
            user_agent: "ua".into(),
            version: "1".into(),
            beta_features: String::new(),
        },
        pace: Arc::new(SystemPace),
        gzip_lane: tokens.cpu_bulk,
        client_version: "1.0.0".into(),
        grok_client_version: None,
        cursor_client_version: None,
        antigravity_client_version: "1.0.0".into(),
        listing: ListingLookup::new(),
        env: env.clone(),
        home_dir: dir.path().to_path_buf(),
        io: io(),
        gated_off: Arc::new(|_| false),
    }));
    let log = Arc::new(Mutex::new(Vec::new()));
    let seams = CustomSeams {
        broker: Arc::new(ModelBroker::new(Arc::new(Admission::new()), Arc::new(StandardRetryDecider))),
        rotation: AccountRotation::new(accounts.clone(), Arc::new(NoProbe), Arc::new(SystemPace)),
        log: {
            let log = log.clone();
            Arc::new(move |line: &str| log.lock().unwrap().push(line.to_owned()))
        },
    };
    let host = CustomHost::new(config.clone(), vault.clone(), keys, accounts.clone(), builder, env, seams);
    let refresh = Arc::new(CountingRefresh::default());
    World { admin: CustomAdmin::new(host, refresh.clone()), config, vault, accounts, refresh, log, _dir: dir }
}

/// `text` with each `$name` replaced by its bound id (`direction` in) or each id by its name.
fn substitute(value: &Value, names: &[(String, String)], direction_in: bool) -> Value {
    let mut text = value.to_string();
    for (name, real) in names {
        text = if direction_in { text.replace(&format!("${name}"), real) } else { text.replace(real.as_str(), &format!("${name}")) };
    }
    serde_json::from_str(&text).unwrap()
}

fn pick<'a>(value: &'a Value, path: &str) -> &'a Value {
    path.split('.').fold(value, |at, key| match key.parse::<usize>() {
        Ok(index) => &at[index],
        Err(_) => &at[key],
    })
}

#[tokio::test]
async fn every_step_does_what_node_does() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let env = golden["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())).collect();
    let w = world(env).await;
    let mut names: Vec<(String, String)> = Vec::new();
    let mut refreshes = 0;
    for (at, step) in golden["steps"].as_array().unwrap().iter().enumerate() {
        let label = format!("step {at}: {} ({})", step["note"].as_str().unwrap(), step["op"].as_str().unwrap());
        let args = substitute(&step["args"], &names, true);
        let result: Option<Result<Value, String>> = match step["op"].as_str().unwrap() {
            "config" => {
                let patch = args.as_object().unwrap().clone();
                w.config
                    .update_agent(move |doc| {
                        doc.extend(patch);
                        Ok(())
                    })
                    .await
                    .unwrap();
                None
            }
            "save" => Some(w.admin.save(args[0].clone()).await),
            "saveKey" => Some(w.admin.save_key(args[0].as_str().unwrap(), &args[1]).await),
            "updateModel" => {
                let patch = args.as_array().unwrap().get(2).cloned();
                Some(w.admin.update_model(args[0].as_str().unwrap(), args[1].as_str().unwrap(), patch).await)
            }
            "remove" => Some(w.admin.remove(args[0].as_str().unwrap()).await),
            other => panic!("{other}"),
        }
        .map(|r| r.map_err(|f| f.message().to_owned()));
        let (result, error) = match result {
            Some(Ok(value)) => (Some(value), None),
            Some(Err(message)) => (None, Some(message)),
            None => (None, None),
        };
        if let Some(bind) = step["bind"].as_object() {
            for (name, path) in bind {
                names.push((name.clone(), pick(result.as_ref().unwrap(), path.as_str().unwrap()).as_str().unwrap().to_owned()));
            }
        }
        refreshes += usize::from(result.is_some());
        let shown = |value: &Value| substitute(value, &names, false);
        assert_eq!(result.as_ref().map(shown).unwrap_or(Value::Null), step["result"], "{label}: result");
        assert_eq!(error.as_ref().map(|e| shown(&json!(e))).unwrap_or(Value::Null), step["error"], "{label}: error");
        assert_eq!(shown(&Value::Object(w.config.agent())), step["config"], "{label}: config");
        let secrets: serde_json::Map<String, Value> = w.vault.secrets.lock().unwrap().iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        assert_eq!(shown(&Value::Object(secrets)), step["secrets"], "{label}: secrets");
        let mut roster = serde_json::Map::new();
        for id in w.config.agent()["providers"].as_object().unwrap().keys() {
            roster.insert(id.clone(), json!(w.accounts.custom_key_ids(id).await.unwrap()));
        }
        assert_eq!(shown(&Value::Object(roster)), step["roster"], "{label}: roster");
    }
    assert_eq!(w.refresh.0.load(Ordering::SeqCst), refreshes, "the runtime refreshes once per change that succeeded");
}

/// What the scripted endpoint saw.
#[derive(Clone, Debug)]
pub(super) struct Seen {
    pub(super) path: String,
    pub(super) authorization: String,
    body: String,
}

/// An OpenAI-compatible endpoint on a loopback port: `/models` lists `m-a`; a chat request with
/// an `authorization` in `refused` is a quota refusal, any other streams `OK`.
pub(super) async fn endpoint(refused: Vec<String>, flaky: usize) -> (String, Arc<Mutex<Vec<Seen>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let failed = Arc::new(AtomicUsize::new(0));
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (refused, log, failed) = (refused.clone(), log.clone(), failed.clone());
            tokio::spawn(async move {
                let mut raw = Vec::new();
                let mut buffer = [0u8; 4096];
                let head_end = loop {
                    let n = socket.read(&mut buffer).await.unwrap();
                    raw.extend_from_slice(&buffer[..n]);
                    if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                        break at + 4;
                    }
                };
                let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
                let header = |name: &str| {
                    head.lines().find_map(|l| l.to_lowercase().strip_prefix(&format!("{name}:")).map(|v| v.trim().to_owned()))
                };
                let length: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
                while raw.len() < head_end + length {
                    let n = socket.read(&mut buffer).await.unwrap();
                    raw.extend_from_slice(&buffer[..n]);
                }
                let path = head.split_whitespace().nth(1).unwrap().trim_start_matches("/v1").to_owned();
                let authorization = head
                    .lines()
                    .find_map(|l| l.strip_prefix("authorization: ").or_else(|| l.strip_prefix("Authorization: ")))
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
                let body = String::from_utf8_lossy(&raw[head_end..]).to_string();
                log.lock().unwrap().push(Seen { path: path.clone(), authorization: authorization.clone(), body });
                let (status, kind, payload) = if path == "/models" {
                    ("200 OK", "application/json", json!({ "data": [{ "id": "m-a" }] }).to_string())
                } else if failed.fetch_add(1, Ordering::SeqCst) < flaky {
                    ("503 Service Unavailable", "application/json", json!({ "error": { "message": "overloaded", "type": "server_error" } }).to_string())
                } else if refused.contains(&authorization) {
                    (
                        "429 Too Many Requests",
                        "application/json",
                        json!({ "error": { "message": "You exceeded your current quota", "type": "insufficient_quota", "code": "insufficient_quota" } })
                            .to_string(),
                    )
                } else {
                    let chunk = |delta: Value, finish: Value| {
                        let usage = if finish.is_null() { Value::Null } else { json!({ "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4 }) };
                        format!("data: {}\n\n", json!({ "id": "c1", "model": "m-a", "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }], "usage": usage }))
                    };
                    let mut stream = chunk(json!({ "role": "assistant", "content": "OK" }), Value::Null);
                    stream.push_str(&chunk(json!({}), json!("stop")));
                    stream.push_str("data: [DONE]\n\n");
                    ("200 OK", "text/event-stream", stream)
                };
                let mut reply = Vec::new();
                write!(reply, "HTTP/1.1 {status}\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}", payload.len()).unwrap();
                let _ = socket.write_all(&reply).await;
            });
        }
    });
    (base, seen)
}

#[tokio::test]
async fn the_connection_test_sends_a_real_request_through_the_key_pool() {
    let (base, seen) = endpoint(vec!["Bearer sk-primary".into()], 0).await;
    let w = world(HashMap::new()).await;
    let input = json!({ "name": "Pool", "protocol": "openai-chat", "baseURL": base, "apiKey": "sk-primary", "extraApiKeys": [{ "apiKey": "sk-extra" }] });
    let saved = w.admin.save(input).await.unwrap();
    let id = saved["id"].as_str().unwrap();
    let key = saved["extraApiKeys"][0]["id"].as_str().unwrap().to_owned();
    let probe = json!({ "id": id, "schemaVersion": 2, "name": "Pool", "protocol": "openai-chat", "baseURL": base });
    let answer = w.admin.test(probe.clone()).await.unwrap();
    assert_eq!(answer, json!({ "ok": true, "key": { "id": key, "number": 2 } }));
    let seen = seen.lock().unwrap().clone();
    let chats: Vec<&Seen> = seen.iter().filter(|s| s.path == "/chat/completions").collect();
    assert_eq!(chats.iter().map(|s| s.authorization.as_str()).collect::<Vec<_>>(), ["Bearer sk-primary", "Bearer sk-extra"]);
    let body: Value = serde_json::from_str(&chats[1].body).unwrap();
    assert_eq!(body["model"], "m-a");
    assert_eq!(body["messages"][0]["content"], "Reply with OK.");
    assert!(body.to_string().contains("16"), "the test asks for 16 tokens: {body}");
    assert_eq!(seen.iter().filter(|s| s.path == "/models").count(), 1, "the first discovered model is tested");

    // A key nobody refuses answers as the primary: no key is named.
    let (open, _) = endpoint(Vec::new(), 0).await;
    let plain = w.admin.test(json!({ "name": "Plain", "protocol": "openai-chat", "baseURL": open, "apiKey": "sk-x" })).await.unwrap();
    assert_eq!(plain, json!({ "ok": true }));
}

#[tokio::test]
async fn a_send_every_key_is_refused_is_thrown_with_the_key_redacted() {
    let (base, _) = endpoint(vec!["Bearer sk-only-secret-key".into()], 0).await;
    let w = world(HashMap::new()).await;
    let failure = w
        .admin
        .test(json!({ "name": "Refused", "protocol": "openai-chat", "baseURL": base, "apiKey": "sk-only-secret-key" }))
        .await
        .unwrap_err();
    assert!(failure.message().contains("quota"), "{}", failure.message());
    assert!(!failure.message().contains("sk-only-secret-key"));
}

#[tokio::test]
async fn a_transient_failure_is_retried_as_every_send_is() {
    let (base, seen) = endpoint(Vec::new(), 1).await;
    let w = world(HashMap::new()).await;
    let answer = w.admin.test(json!({ "name": "Flaky", "protocol": "openai-chat", "baseURL": base, "apiKey": "sk-x" })).await.unwrap();
    assert_eq!(answer, json!({ "ok": true }));
    let chats = seen.lock().unwrap().iter().filter(|s| s.path == "/chat/completions").count();
    assert_eq!(chats, 2, "the 503 was retried by the shared send path");
}

#[tokio::test]
async fn every_key_refused_ends_with_the_last_refusal() {
    let (base, seen) = endpoint(vec!["Bearer sk-primary".into(), "Bearer sk-extra".into()], 0).await;
    let w = world(HashMap::new()).await;
    let saved = w
        .admin
        .save(json!({ "name": "Dry", "protocol": "openai-chat", "baseURL": base, "apiKey": "sk-primary", "extraApiKeys": [{ "apiKey": "sk-extra" }] }))
        .await
        .unwrap();
    let probe = json!({ "id": saved["id"], "schemaVersion": 2, "name": "Dry", "protocol": "openai-chat", "baseURL": base });
    let failure = w.admin.test(probe).await.unwrap_err();
    assert_eq!(failure.message(), "429 You exceeded your current quota");
    let keys: Vec<String> = seen.lock().unwrap().iter().filter(|s| s.path == "/chat/completions").map(|s| s.authorization.clone()).collect();
    assert_eq!(keys, ["Bearer sk-primary", "Bearer sk-extra"]);
}

#[tokio::test]
async fn a_key_kept_in_the_private_file_is_labelled_so() {
    let w = world(HashMap::new()).await;
    let saved = w.admin.save(json!({ "name": "Kept", "protocol": "openai-chat", "baseURL": "http://localhost:1/v1", "apiKey": "sk-a" })).await.unwrap();
    assert_eq!(saved["detail"], "stored in keychain");
    let id = saved["id"].as_str().unwrap();
    w.vault.fallback.lock().unwrap().push(format!("agent.{id}.apiKey"));
    let row = w.admin.save_key(id, &json!("sk-b")).await.unwrap();
    assert_eq!(row["detail"], "stored in private file");
}

#[tokio::test]
async fn a_removed_key_the_keychain_keeps_is_logged_and_the_save_holds() {
    let w = world(HashMap::new()).await;
    let base = "http://localhost:1/v1";
    let saved = w
        .admin
        .save(json!({ "name": "Log", "protocol": "openai-chat", "baseURL": base, "apiKey": "sk-a", "extraApiKeys": [{ "apiKey": "sk-b" }] }))
        .await
        .unwrap();
    let (id, key) = (saved["id"].as_str().unwrap(), saved["extraApiKeys"][0]["id"].as_str().unwrap().to_owned());
    w.vault.refuse_extra_deletes.store(true, Ordering::SeqCst);
    let row = w.admin.save(json!({ "id": id, "schemaVersion": 2, "name": "Log", "protocol": "openai-chat", "baseURL": base, "extraApiKeys": [] })).await.unwrap();
    assert!(row.get("extraApiKeys").is_none(), "the roster no longer lists the key");
    assert_eq!(
        w.log.lock().unwrap().clone(),
        [format!("[provider-admin] could not delete additional API key {key} of {id}: keychain is locked\n")]
    );
}