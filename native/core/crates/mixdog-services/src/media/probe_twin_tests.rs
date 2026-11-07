//! `fixtures/services/media-probes-twin.json` (`record-media-probes.mjs`): Node's OAuth credential
//! probes for the three OAuth lanes, the Image API key lookups and the key lanes' credentials,
//! over token documents of every shape, the account / path variable / legacy file order, the
//! Antigravity developer gate and remote mode. Every answer must equal Node's.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Value, json};

use super::accounts::AccountProbe;
use super::catalog_fetch::{Auth, CatalogHttp, FetchError, HttpFailure, HttpReply};
use super::probe::{AccountedProbe, AgentKeys, AgentSettings, FileAccountProbe, ProbeParts, ProviderAuth};

const GOLDEN: &str = include_str!("../../../../fixtures/services/media-probes-twin.json");

/// The environment and keychain as `getAgentApiKey` reads them: the provider's standard
/// variable, `MIXDOG_AGENT_<ID>_APIKEY`, then its aliases. The keychain holds nothing here.
struct Keys(Value);

impl Keys {
    fn lookup(&self, provider: &str) -> Option<String> {
        let standard = match provider {
            "openai" => Some("OPENAI_API_KEY"),
            "anthropic" => Some("ANTHROPIC_API_KEY"),
            "gemini" => Some("GEMINI_API_KEY"),
            "deepseek" => Some("DEEPSEEK_API_KEY"),
            "xai" => Some("XAI_API_KEY"),
            "openrouter" => Some("OPENROUTER_API_KEY"),
            _ => None,
        };
        let spaced: String = provider.split(|c: char| c == '.' || c.is_whitespace()).collect::<Vec<_>>().join("_").to_uppercase();
        let names = standard.map(str::to_owned).into_iter().chain([format!("MIXDOG_AGENT_{spaced}_APIKEY")]).chain((provider == "xai").then(|| "GROK_API_KEY".to_owned()));
        names.filter_map(|name| self.0[&name].as_str().filter(|v| !v.is_empty()).map(str::to_owned)).next()
    }
}

#[async_trait]
impl AgentKeys for Keys {
    async fn has(&self, provider: &str) -> bool {
        self.lookup(provider).is_some()
    }

    async fn get(&self, provider: &str) -> Option<String> {
        self.lookup(provider)
    }
}

struct Settings(Value);

impl AgentSettings for Settings {
    fn providers(&self) -> Value {
        self.0["agent"]["providers"].clone()
    }

    fn developer_enabled(&self, provider: &str) -> bool {
        provider == "antigravity-oauth" && self.0["agent"]["developer"]["antigravityOAuth"] == true
    }
}

struct Unused;

#[async_trait]
impl ProviderAuth for Unused {
    async fn oauth(&self, _: &str, _: Option<&Path>) -> Result<Auth, FetchError> {
        panic!("the credential probes never refresh a token")
    }

    async fn provider_rows(&self, _: &str, _: &Auth) -> Result<Value, FetchError> {
        panic!("the credential probes never fetch a catalog")
    }
}

#[async_trait]
impl CatalogHttp for Unused {
    async fn get(&self, _: &str, _: &[(String, String)], _: std::time::Duration) -> Result<HttpReply, HttpFailure> {
        panic!("the credential probes make no request")
    }
}

#[tokio::test]
async fn credentials_resolve_as_nodes_do() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let clock = golden["clock"].as_i64().unwrap();
    let data = scratch.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    for recorded in golden["scenarios"].as_array().unwrap() {
        let name = recorded["name"].as_str().unwrap();
        let own = scratch.path().join("s").join(name);
        std::fs::create_dir_all(&own).unwrap();
        let own_text = own.to_string_lossy().into_owned();
        for (rel, text) in recorded["files"].as_object().unwrap() {
            let path = own.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text.as_str().unwrap()).unwrap();
        }
        for (rel, text) in recorded["dataFiles"].as_object().unwrap() {
            std::fs::write(data.join(rel), text.as_str().unwrap()).unwrap();
        }
        let env: Value = Value::Object(recorded["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), json!(v.as_str().unwrap().replace("{s}", &own_text)))).collect());
        let env_for_keys = env.clone();
        let env_for_probe = env.clone();
        let probe = Arc::new(FileAccountProbe::new(ProbeParts {
            data_dir: data.clone(),
            lane: tokens.durability_io,
            now: Arc::new(move || clock),
            env: Arc::new(move |name| env_for_probe[name].as_str().map(str::to_owned)),
            keys: Arc::new(Keys(env_for_keys)),
            settings: Arc::new(Settings(recorded["config"].clone())),
            provider_auth: Arc::new(Unused),
            http: Arc::new(Unused),
            revision: Arc::new(String::new),
        }));
        let accounted = AccountedProbe(probe.clone());
        for call in recorded["calls"].as_array().unwrap() {
            let call = call.as_str().unwrap();
            let want = &recorded["results"][call];
            let got = if let Some(lane) = call.strip_prefix("oauth:") {
                let account: Option<PathBuf> = recorded["bound"][lane].as_str().map(|p| PathBuf::from(p.replace("{s}", &own_text)));
                json!(accounted.authenticated(lane, account.as_deref()).await)
            } else if let Some(lane) = call.strip_prefix("imageApiKey:") {
                json!(accounted.authenticated(lane, None).await)
            } else {
                let result = match call.strip_prefix("imageApiAuth:") {
                    Some(lane) => probe.image_api_auth(lane).await,
                    None => probe.api_key_auth(call).await,
                };
                match result {
                    Ok(auth) if call == "gemini" => json!({ "value": { "token": auth.token } }),
                    Ok(auth) => json!({ "value": { "baseURL": auth.base_url, "token": auth.token } }),
                    Err(error) => json!({ "error": { "message": error.message, "code": error.code, "status": error.status } }),
                }
            };
            assert_eq!(&got, want, "{name}: {call}");
        }
        for rel in recorded["dataFiles"].as_object().unwrap().keys() {
            std::fs::remove_file(data.join(rel)).unwrap();
        }
    }
}

/// The identity the provider layer's token stores answer for a signed-in account: the bearer and
/// the Grok `user_id` / Antigravity `project_id` of the token document.
struct DocAuth(Value);

#[async_trait]
impl ProviderAuth for DocAuth {
    async fn oauth(&self, _: &str, _: Option<&Path>) -> Result<Auth, FetchError> {
        let Some(doc) = self.0.as_object().and_then(|files| files.values().next()).and_then(|text| serde_json::from_str::<Value>(text.as_str().unwrap()).ok()) else {
            return Err(FetchError { message: "not signed in".to_owned(), code: None, status: None, timed_out: false });
        };
        Ok(Auth {
            token: doc["access_token"].as_str().unwrap_or_default().to_owned(),
            account_id: doc["user_id"].as_str().map(str::to_owned),
            project_id: doc["project_id"].as_str().map(str::to_owned),
            ..Auth::default()
        })
    }

    async fn provider_rows(&self, _: &str, _: &Auth) -> Result<Value, FetchError> {
        panic!("the key is decided before any catalog is fetched")
    }
}

/// The cache key names the file on disk (`studio-models-<key>.json`): a cache an earlier install
/// wrote is found only when the key is Node's, for every lane and account shape.
#[tokio::test]
async fn catalog_cache_keys_match_nodes() {
    use super::loader::CatalogSource;
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/services/media-catalog-keys-twin.json")).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().unwrap();
    for recorded in golden["scenarios"].as_array().unwrap() {
        let name = recorded["name"].as_str().unwrap();
        let env = Value::Object(recorded["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect());
        let (env_keys, env_probe) = (env.clone(), env);
        let probe = Arc::new(FileAccountProbe::new(ProbeParts {
            data_dir: data.path().to_owned(),
            lane: tokens.durability_io,
            now: Arc::new(|| 0),
            env: Arc::new(move |name| env_probe[name].as_str().map(str::to_owned)),
            keys: Arc::new(Keys(env_keys)),
            settings: Arc::new(Settings(recorded["config"].clone())),
            provider_auth: Arc::new(DocAuth(recorded["files"].clone())),
            http: Arc::new(Unused),
            revision: Arc::new(String::new),
        }));
        let got = probe.source_for(None).target(recorded["lane"].as_str().unwrap()).await;
        match (got, recorded.get("error")) {
            (Ok(target), None) => assert_eq!(json!([target.key]), recorded["keys"], "{name}"),
            (Err(failure), Some(want)) => {
                assert_eq!(json!(failure.code), want["code"], "{name}");
                assert_eq!(recorded["keys"], json!([]), "{name}: nothing was asked of the cache");
            }
            (got, want) => panic!("{name}: {got:?} vs recorded {want:?}"),
        }
    }
}

/// The account's Codex list, scripted: each call answers the next entry and is counted.
struct ListAuth {
    script: std::sync::Mutex<Vec<Value>>,
    calls: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl ProviderAuth for ListAuth {
    async fn oauth(&self, _: &str, _: Option<&Path>) -> Result<Auth, FetchError> {
        panic!("the subscription lane resolves no bearer for its key")
    }

    async fn provider_rows(&self, _: &str, _: &Auth) -> Result<Value, FetchError> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let next = self.script.lock().unwrap().remove(0);
        match next["error"].as_str() {
            Some(text) => Err(FetchError { message: text.to_owned(), code: None, status: None, timed_out: false }),
            None => Ok(next["rows"].clone()),
        }
    }
}

/// The ChatGPT-subscription lane keeps no catalog file of its own (its list has a cache of its
/// own): every load asks the provider, loads made together share one request, and a failure is
/// never answered from the past.
#[tokio::test]
async fn the_subscription_lane_is_never_cached_by_the_media_loader() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/services/media-catalog-keys-twin.json")).unwrap();
    let tokens = mixdog_rt::testing::tokens();
    let data = tempfile::tempdir().unwrap();
    let auth = Arc::new(ListAuth { script: std::sync::Mutex::default(), calls: std::sync::atomic::AtomicUsize::new(0) });
    let probe = Arc::new(FileAccountProbe::new(ProbeParts {
        data_dir: data.path().to_owned(),
        lane: tokens.durability_io,
        now: Arc::new(|| 0),
        env: Arc::new(|_| None),
        keys: Arc::new(Keys(json!({}))),
        settings: Arc::new(Settings(json!({}))),
        provider_auth: auth.clone(),
        http: Arc::new(Unused),
        revision: Arc::new(String::new),
    }));
    let loader = probe.loader_for(None);
    let outcome = |loader: Arc<super::loader::ModelLoader>| async move {
        match loader.load("openai-oauth").await {
            Ok(got) => json!({ "rows": got.rows, "warning": got.warning }),
            Err(error) => json!({ "error": { "code": error.code } }),
        }
    };
    for (index, recorded) in golden["openai"].as_array().unwrap().iter().enumerate() {
        let step = &recorded["step"];
        let mut got = Value::Null;
        match step["op"].as_str().unwrap() {
            "script" => *auth.script.lock().unwrap() = step["results"].as_array().unwrap().clone(),
            "load" => got = outcome(loader.clone()).await,
            _ => got = Value::Array(futures::future::join_all((0..step["count"].as_u64().unwrap()).map(|_| outcome(loader.clone()))).await),
        }
        // Node's errors carry a message too; the loader surfaces the code.
        let strip = |value: &Value| match value {
            Value::Array(items) => Value::Array(items.iter().map(|v| v.get("error").map_or(v.clone(), |e| json!({ "error": { "code": e["code"] } }))).collect()),
            single => single.get("error").map_or(single.clone(), |e| json!({ "error": { "code": e["code"] } })),
        };
        assert_eq!(got, strip(&recorded["result"]), "step {index}: {step}");
        assert_eq!(auth.calls.load(std::sync::atomic::Ordering::SeqCst), recorded["listCalls"].as_u64().unwrap() as usize, "step {index}: provider requests");
        assert_eq!(recorded["cacheAsked"], json!([]), "Node never touches a cache for this lane");
    }
}
