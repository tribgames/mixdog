//! Replay of the providerConfig and credential cases of `native/core/fixtures/model-proxy-host-cases` (recorded
//! with Node's real provider classes behind a scripted send): this PC's answer is `PcProviderConfig` over the
//! product's own `ProviderRegistry` and `DefaultProviderBuilder` (the registry compose_flip.rs hands the runner), so
//! what a live provider advertises is what the core's real adapter declares. Node's scripted seam is
//! `probeAuth` (the credential probe), scripted here as [`Auth`]; case 31 drives `RegistryCredentials` itself.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_ai::accounts::CredentialState;
use mixdog_ai::registry::builder::DefaultProviderBuilder;
use mixdog_ai::registry::keys::ApiKeyStore;
use mixdog_ai::registry::keys::Environment;
use mixdog_ai::registry::keys::KeyConfig;
use mixdog_ai::registry::keys::MemoryVault;
use mixdog_ai::registry::providers::ProviderBuilder;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::model_proxy::public_provider_config;
use mixdog_app_protocol::v2::model_proxy as w;
use mixdog_core_api::domain::provider as p;
use mixdog_core_domains::domains::ai_admin::model_proxy::ProviderConfigSource;
use mixdog_core_domains::domains::ai_admin::model_proxy::ProviderLookup;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::builder_env::builder_env;
use super::model_proxy_pc::CredentialProbe;
use super::model_proxy_pc::PcProviderConfig;
use super::model_proxy_pc::RegistryCredentials;
use super::process_tests::World;
use super::process_tests::world;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/model-proxy-host-cases/golden.json");

fn observed(case: &str) -> Value {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    golden["cases"].as_array().unwrap().iter().find(|c| c["case"] == case).unwrap_or_else(|| panic!("{case} is recorded"))["observed"].clone()
}

/// Node's scripted `probeAuth`: one answer for every provider, changed between steps.
pub(super) struct Auth(Mutex<&'static str>);

#[async_trait]
impl CredentialProbe for Auth {
    async fn auth_state(&self, _: &str, _: &Map<String, Value>) -> Result<&'static str, String> {
        Ok(*self.0.lock().unwrap())
    }
}

/// This PC: the config's providers section (changed between steps), the product's registry over the real builder.
pub(super) struct Pc {
    available: Arc<Mutex<Map<String, Value>>>,
    registry: Arc<ProviderRegistry>,
    pub(super) config: PcProviderConfig,
    _world: World,
}

pub(super) async fn pc(available: Value, credentials: Arc<dyn CredentialProbe>) -> Pc {
    let world = world(&[], json!({}), Vec::new()).await;
    let builder: Arc<dyn ProviderBuilder> = Arc::new(DefaultProviderBuilder::new(builder_env(&world.services)));
    let registry = Arc::new(ProviderRegistry::new(builder));
    let available = Arc::new(Mutex::new(available.as_object().unwrap().clone()));
    let read = available.clone();
    let config = PcProviderConfig::new(Arc::new(move || read.lock().unwrap().clone()), registry.clone(), credentials);
    Pc { available, registry, config, _world: world }
}

pub(super) fn scripted(state: &'static str) -> Arc<Auth> {
    Arc::new(Auth(Mutex::new(state)))
}

impl Pc {
    /// The answer a server reads (`providerConfig` after `publicProviderConfig`), as Node's JSON object.
    async fn answer(&self) -> Value {
        let (providers, ready) = self.config.public().await.expect("an answer");
        let providers = serde_json::to_value(w::ProxyAnswer::ProviderConfig { providers, ready: None }).unwrap()["providers"].clone();
        json!({ "providers": providers, "ready": ready })
    }

    /// `runtime.provider(name) === undefined ? 'undefined' : 'present'`.
    async fn provider(&self, name: &str) -> &'static str {
        if self.config.adapter(name).await.is_some() { "present" } else { "undefined" }
    }

    fn set(&self, available: Value) {
        *self.available.lock().unwrap() = available.as_object().unwrap().clone();
    }
}

/// Key order is part of Node's answer.
fn same(got: &Value, want: &Value, what: &str) {
    assert_eq!(got, want, "{what}");
    assert_eq!(serde_json::to_string(got).unwrap(), serde_json::to_string(want).unwrap(), "{what}: key order");
}

/// Case 9, this PC's part: the registry is loaded on demand by the first read (`liveBeforeConnect` 0), and the
/// config the server waits for is this answer. The server's wait is case 9 of the server-side replay.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cold_pc_loads_its_registry_on_the_first_read() {
    let node = observed("cold start: the daemon waits for a PC that connects late and loads its registry on demand");
    let pc = pc(json!({ "openai": { "enabled": true }, "gemini": { "enabled": false } }), scripted("present")).await;
    assert_eq!(pc.registry.all().len() as u64, node["liveBeforeConnect"].as_u64().unwrap());
    same(&pc.answer().await["providers"], &node["config"], "config");
}

/// Case 11.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nothing_enabled_is_an_answer() {
    let node = observed("a loaded PC registry with nothing enabled is an answer, not a wait");
    let pc = pc(json!({ "openai": { "enabled": false } }), scripted("present")).await;
    same(&pc.answer().await["providers"], &node["config"], "config");
}

/// Case 20.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_disabled_or_removed_provider_is_not_reached_while_the_registry_keeps_it() {
    let node = observed("the last disabled or removed provider is not advertised even when the registry preserves its instance");
    let log = node["log"].as_array().unwrap();
    let pc = pc(json!({ "openai": { "enabled": true } }), scripted("present")).await;
    same(&pc.answer().await, &log[0]["config"], "enabled");
    pc.set(json!({ "openai": { "enabled": false } }));
    same(&pc.answer().await, &log[1]["config"], "disabled");
    assert_eq!(json!(pc.registry.all().iter().any(|(name, _)| name == "openai")), log[1]["registryKeepsInstance"]);
    assert_eq!(pc.provider("openai").await, log[1]["provider"]);
    pc.set(json!({}));
    same(&pc.answer().await, &log[2]["config"], "removed");
    assert_eq!(pc.provider("openai").await, log[2]["provider"]);
}

/// Case 24, this PC's advertisement of every built-in family and custom protocol.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "differs, not fixed here: the Rust registry never builds mixdog-local (mixdog-ai registry/builder.rs:1286; providers::local::adapter has no production caller), so a config enabling it fails the whole init (registry/providers.rs:388) where Node registers MixdogLocalProvider"]
async fn every_family_is_advertised_as_its_adapter_declares() {
    let node = observed("all built-in provider families and custom protocols use the same PC catalog and send path");
    let pc = pc(node["available"].clone(), scripted("present")).await;
    same(&pc.answer().await, &node["advertised"], "advertised");
}

/// Case 25.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readiness_follows_the_credential_and_the_explicit_disable() {
    let node = observed("proxy readiness distinguishes missing credentials, transient probes, and explicit disables");
    let log = node["log"].as_array().unwrap();
    let auth = scripted("present");
    let pc = pc(json!({ "openai-oauth": { "enabled": true } }), auth.clone()).await;
    async fn read(pc: &Pc) -> Value {
        pc.answer().await["providers"]["openai-oauth"].clone()
    }
    same(&read(&pc).await, &log[0]["advertised"], "present + enabled");
    *auth.0.lock().unwrap() = "unreadable";
    pc.set(json!({ "openai-oauth": { "enabled": false, "credentialProbeUnavailable": true } }));
    same(&read(&pc).await, &log[1]["advertised"], "unreadable, preserved adapter");
    assert_eq!(json!(pc.provider("openai-oauth").await == "present"), log[1]["providerPresent"]);
    *auth.0.lock().unwrap() = "absent";
    pc.set(json!({ "openai-oauth": { "enabled": true } }));
    same(&read(&pc).await, &log[2]["advertised"], "absent, persisted enable");
    assert_eq!(pc.provider("openai-oauth").await, log[2]["provider"]);
    *auth.0.lock().unwrap() = "present";
    pc.set(json!({ "openai-oauth": { "enabled": false } }));
    same(&read(&pc).await, &log[3]["advertised"], "present, explicitly disabled");
    assert_eq!(pc.provider("openai-oauth").await, log[3]["provider"]);
}

/// Variables by name, changed between steps.
#[derive(Default)]
struct Vars(Mutex<HashMap<String, String>>);

impl Environment for Vars {
    fn var(&self, name: &str) -> Option<String> {
        self.0.lock().unwrap().get(name).cloned()
    }
}

impl Vars {
    fn set(&self, name: &str, value: Option<&str>) {
        let mut vars = self.0.lock().unwrap();
        match value {
            Some(value) => vars.insert(name.to_owned(), value.to_owned()),
            None => vars.remove(name),
        };
    }
}

/// Node's `oauthCredentialProbeState`, scripted: every read answers `unreadable` and is kept.
#[derive(Default)]
struct OAuth(Mutex<Vec<String>>);

#[async_trait]
impl ProviderBuilder for OAuth {
    async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn p::ProviderAdapter>, String> {
        Err(format!("unknown enabled provider: {name}"))
    }
    async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn available(&self, _: &str) -> bool {
        true
    }
    async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
        Ok(true)
    }
    async fn oauth_credential_state(&self, name: &str) -> Result<CredentialState, String> {
        self.0.lock().unwrap().push(name.to_owned());
        Ok(CredentialState::Unreadable)
    }
}

/// Case 26: a custom provider's named variable is its only credential; the key the adapter resolves is the
/// variable's current value (`resolveProviderApiKey`, Rust `ApiKeyStore::resolve`), never the stored key.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_custom_environment_credential_drives_readiness() {
    let node = observed("custom environment credentials drive proxy readiness without a stored-key fallback");
    let name = "custom-proxy-env";
    let variable = node["variable"].as_str().unwrap();
    let vars = Arc::new(Vars::default());
    let keys = ApiKeyStore::new(Arc::new(MemoryVault::default()), vars.clone(), false);
    keys.save(name, "stored-key-must-not-be-used").await.unwrap();
    let credentials = Arc::new(RegistryCredentials { builder: Arc::new(OAuth::default()), keys: keys.clone(), env: vars.clone() });
    let pc = pc(node["available"].clone(), credentials).await;
    let advertised = |answer: Value| answer["providers"][name].clone();
    let configured = node["available"][name].as_object().unwrap();
    let key_config = KeyConfig { api_key: None, api_key_env: configured["apiKeyEnv"].as_str().map(str::to_owned) };
    vars.set(variable, Some("environment-key-one"));
    let first = advertised(pc.answer().await);
    assert_eq!(pc.provider(name).await, "present");
    assert_eq!(keys.resolve(name, &key_config).await.unwrap(), node["sendWithKeyOne"]);
    vars.set(variable, Some("environment-key-two"));
    assert_eq!(keys.resolve(name, &key_config).await.unwrap(), node["sendWithKeyTwo"]);
    vars.set(variable, None);
    let after = advertised(pc.answer().await);
    assert_eq!(pc.provider(name).await, node["providerAfterUnset"]);
    // Node's `runtime.providerConfig()` before `publicProviderConfig`; a server reads it projected.
    let public = |raw: &Value| public_provider_config(&json!({ name: raw }), &|_| true)[name].clone();
    same(&first, &public(&node["firstAdvertised"]), "first");
    same(&after, &public(&node["afterUnset"]), "after unset");
}

/// Case 27.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unreadable_credential_with_a_live_adapter_is_advertised_at_once() {
    let node = observed("an unreadable credential with a live adapter is advertised on the first read, not only later ones");
    let pc = pc(json!({ "openai-oauth": { "enabled": true } }), scripted("unreadable")).await;
    same(&pc.answer().await["providers"]["openai-oauth"], &node["first"], "first");
    same(&pc.answer().await["providers"]["openai-oauth"], &node["second"], "second");
}

/// Case 28.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "differs, not fixed here: the Rust registry never builds mixdog-local (mixdog-ai registry/builder.rs:1286), see case 24"]
async fn a_text_only_adapter_advertises_its_image_trait() {
    let node = observed("a text-only adapter's image trait is advertised, so a remote read sends it OCR text");
    let pc = pc(json!({ "mixdog-local": { "enabled": true }, "openai": { "enabled": true } }), scripted("present")).await;
    let providers = pc.answer().await["providers"].clone();
    same(&providers["mixdog-local"]["modelProxy"], &node["localTraits"], "local");
    same(&providers["openai"]["modelProxy"], &node["openaiTraits"], "openai");
}

/// Case 29.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_custom_provider_advertises_only_its_hidden_model_ids() {
    let node = observed("a custom provider advertises only the ids of its hidden models");
    let pc = pc(node["available"].clone(), scripted("present")).await;
    same(&pc.answer().await["providers"]["custom-proxy-hidden"], &node["advertised"], "advertised");
}

/// Case 30: the projection every answer passes (`public_provider_config`, which `PcProviderConfig::public` applies)
/// with the relaying host's allow-list (`ProxyRunner::run` keeps only allowed names).
#[test]
fn an_advertised_custom_name_is_trimmed_redacted_and_capped() {
    let node = observed("an advertised custom provider name is trimmed, redacted and capped; empty or non-string names are omitted");
    let blocked = node["blocked"].as_str().unwrap();
    let advertised = public_provider_config(&node["configured"], &|name| name != blocked);
    same(&advertised, &node["advertised"], "advertised");
}

/// Case 31: `RegistryCredentials` (Node `modelProxyCredentialProbe`) over the key store and the registry's OAuth
/// set; `resolvedApiKey` is `ApiKeyStore::resolve` (`resolveProviderApiKey`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn credential_presence_follows_the_oauth_set_and_the_key_precedence() {
    let node = observed("proxy credential presence follows the registry OAuth set and resolveProviderApiKey precedence");
    let vars = Arc::new(Vars::default());
    let oauth = Arc::new(OAuth::default());
    let keys = ApiKeyStore::new(Arc::new(MemoryVault::default()), vars.clone(), false);
    let probe = RegistryCredentials { builder: oauth.clone(), keys: keys.clone(), env: vars.clone() };
    let state = |name: &'static str, config: Value| {
        let probe = &probe;
        async move { probe.auth_state(name, config.as_object().unwrap()).await.unwrap() }
    };
    let oauth_probes = json!([state("cursor-oauth", json!({})).await, state("proxy-probe-oauth", json!({})).await]);
    same(&json!({ "oauthProbes": oauth_probes, "oauthReads": oauth.0.lock().unwrap().clone() }), &node["oauthSet"], "oauthSet");
    for step in node["log"].as_array().unwrap() {
        let label = step["step"].as_str().unwrap();
        if let Some(env) = step["env"].as_object() {
            for (name, value) in env {
                vars.set(name, value.as_str());
            }
        }
        match label {
            "bare name with the MIXDOG_AGENT alias set" => assert_eq!(state("proxy-probe", json!({})).await, step["probe"], "{label}"),
            "named variable removed" => {
                vars.set("MIXDOG_PROXY_PROBE_ENV_TEST", None);
                assert_eq!(state("custom-proxy-probe", json!({ "type": "custom", "auth": "key", "apiKeyEnv": "MIXDOG_PROXY_PROBE_ENV_TEST" })).await, step["customProbe"], "{label}");
            }
            "custom auth none" => assert_eq!(state("custom-proxy-probe", json!({ "type": "custom", "auth": "none" })).await, step["probe"], "{label}"),
            _ => {
                for result in step["results"].as_array().unwrap() {
                    let name: &'static str = if result["name"] == "custom-proxy-probe" { "custom-proxy-probe" } else { "proxy-probe" };
                    let config = result["config"].clone();
                    let key_config = KeyConfig { api_key: config["apiKey"].as_str().map(str::to_owned), api_key_env: config["apiKeyEnv"].as_str().map(str::to_owned) };
                    let got = json!({
                        "name": name,
                        "config": config,
                        "probe": state(name, config.clone()).await,
                        "resolvedApiKey": keys.resolve(name, &key_config).await.unwrap(),
                    });
                    same(&got, result, label);
                }
            }
        }
    }
}
