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
use mixdog_ai::registry::builder::BuilderEnv;
use mixdog_ai::registry::builder::DefaultProviderBuilder;
use mixdog_ai::registry::keys::ApiKeyStore;
use mixdog_ai::registry::keys::Environment;
use mixdog_ai::registry::keys::KeyConfig;
use mixdog_ai::registry::keys::MemoryVault;
use mixdog_ai::registry::keys::SecretVault;
use mixdog_ai::registry::keys::VaultError;
use mixdog_ai::transport::Exchange;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
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
    pc_over(available, credentials, &[], json!({}), |_, _| {}).await
}

/// [`pc`] with the process environment `env`, the stored Developer options `developer` (`agent.developer`), and `tweak`
/// over the builder's inputs and the plugin-data directory (where a sign-in leaves its credential file).
pub(super) async fn pc_over(
    available: Value,
    credentials: Arc<dyn CredentialProbe>,
    env: &[(&str, &str)],
    developer: Value,
    tweak: impl FnOnce(&mut BuilderEnv, &std::path::Path),
) -> Pc {
    let world = world(env, json!({}), Vec::new()).await;
    if developer.as_object().is_some_and(|options| !options.is_empty()) {
        world
            .services
            .config
            .update_agent(move |doc| {
                doc.insert("developer".into(), developer);
                Ok(())
            })
            .await
            .unwrap();
    }
    let mut env = builder_env(&world.services);
    tweak(&mut env, &world.services.plugin_data);
    let builder: Arc<dyn ProviderBuilder> = Arc::new(DefaultProviderBuilder::new(env));
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

/// `value` without the `mixdog-local` entry: the Rust registry never builds it (mixdog-ai registry/builder.rs:1286 —
/// it is built per turn from the managed runtime's endpoint), and enabling it fails the whole init
/// (registry/providers.rs:388) where Node registers `MixdogLocalProvider`. Declared in the manifest (24/28).
fn without_local(value: &Value) -> Value {
    let mut value = value.clone();
    value.as_object_mut().unwrap().shift_remove("mixdog-local").expect("Node's case names mixdog-local");
    value
}

/// The credential probe of a PC whose Developer options are `developer`: a dev-gated provider whose option is off always
/// reads `absent` (`oauthCredentialProbeState`, through `provider_available`, the gate the registry admits by); every
/// other credential is present (Node's recorder scripts the external store the same way).
struct GatedAuth(Value);

#[async_trait]
impl CredentialProbe for GatedAuth {
    async fn auth_state(&self, name: &str, _: &Map<String, Value>) -> Result<&'static str, String> {
        Ok(if mixdog_ai::service::admin_models::provider_available(name, false, &self.0) { "present" } else { "absent" })
    }
}

/// The sign-in the three dev-gated adapters need to be built, as a login leaves it (`antigravity-oauth.json` in the plugin data):
/// Node builds the class without one, the core's antigravity adapter reads its project from the stored sign-in.
fn sign_in(plugin_data: &std::path::Path) {
    std::fs::create_dir_all(plugin_data).unwrap();
    let signed_in = json!({ "access_token": "access", "refresh_token": "refresh", "expires_at": 4_102_444_800_000_u64, "project_id": "project", "tier_id": "free", "email": "me@example.test", "user_id": "u1" });
    std::fs::write(plugin_data.join("antigravity-oauth.json"), signed_in.to_string()).unwrap();
}

/// Case 24 under the stored Developer options `developer` (the recording's `developer`): this PC's advertisement of every
/// built-in family and custom protocol, but `mixdog-local`, compared whole with what Node advertised.
async fn families_are_advertised_as_their_adapters_declare(case: &str) {
    let node = observed(case);
    let developer = node["developer"].clone();
    let pc = pc_over(without_local(&node["available"]), Arc::new(GatedAuth(developer.clone())), &[], developer, |_, plugin_data| sign_in(plugin_data)).await;
    let mut want = node["advertised"].clone();
    want["providers"] = without_local(&want["providers"]);
    // Declared: Node's mimo-oauth and antigravity-oauth classes state a `firstResponseBudget` (`compatFirstResponseBudget`,
    // `antigravityFirstResponseBudget`); no adapter of the core implements `ProviderAdapter::first_response_budget` yet (the
    // agent watchdog's floor reads it too). Node's figures are asserted and taken off the compared answer.
    for id in ["mimo-oauth", "antigravity-oauth"] {
        if want["providers"][id]["enabled"] == true {
            let budget = want["providers"][id]["modelProxy"].as_object_mut().unwrap().shift_remove("firstResponseBudget");
            assert!(budget.is_some_and(|b| b["transportMs"].as_u64().unwrap() > 0 && b["semanticMs"].as_u64().unwrap() > 0), "{id}: Node states a budget");
        }
    }
    same(&pc.answer().await, &want, "advertised");
}

/// Case 24, every Developer option off: the three dev-gated providers are never admitted, whatever the config says.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_family_is_advertised_as_its_adapter_declares() {
    families_are_advertised_as_their_adapters_declare("all built-in provider families and custom protocols use the same PC catalog and send path").await;
}

/// Case 24, the three Developer options on: they are admitted and advertised as their adapters declare.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_developer_gated_families_are_advertised_when_their_options_are_on() {
    families_are_advertised_as_their_adapters_declare("all built-in provider families and custom protocols use the same PC catalog and send path, with the Developer options on").await;
}

/// The vault of a PC that keeps every account it is asked for.
#[derive(Default)]
struct ReadLog {
    inner: MemoryVault,
    reads: Mutex<Vec<String>>,
}

#[async_trait]
impl SecretVault for ReadLog {
    async fn get(&self, account: &str) -> Result<Option<String>, VaultError> {
        self.reads.lock().unwrap().push(account.to_owned());
        self.inner.get(account).await
    }
    async fn set(&self, account: &str, value: &str) -> Result<(), VaultError> {
        self.inner.set(account, value).await
    }
    async fn delete(&self, account: &str) -> Result<(), VaultError> {
        self.inner.delete(account).await
    }
}

/// The wire of a send that goes nowhere: each request's headers are kept and the exchange fails.
#[derive(Default)]
struct Wire(Mutex<Vec<Vec<(String, String)>>>);

#[async_trait]
impl HttpSend for Wire {
    async fn send(&self, request: p::WireRequest, _: Exchange) -> Result<HttpResponse, p::ProviderError> {
        self.0.lock().unwrap().push(request.headers);
        Err(p::ProviderError::new(p::ErrorKind::InvalidRequest, p::DeliveryState::NotSent))
    }
}

/// Case 12: with two providers enabled and a stored key for each, a send to `openai` reads the key of `openai` and no
/// other: the key is read when the request is made (`ApiKeyStore::resolve`, by the adapter's credential), never with the
/// config. Node's `result.content` (`openai:pc-openai-key`) is the key its provider received: here the bearer the
/// adapter put on the wire. `anthropicKeyInLastInit` (no key in the config the registry applied) is the absence of every
/// anthropic vault read after the registry was applied and a send went out.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_the_requested_providers_key_is_read_when_the_request_is_made() {
    let node = observed("only the requested provider's credential is read, on demand");
    let vault = Arc::new(ReadLog::default());
    let keys = ApiKeyStore::new(vault.clone(), Arc::new(Vars::default()), false);
    keys.save("openai", "pc-openai-key").await.unwrap();
    keys.save("anthropic", "pc-anthropic-key").await.unwrap();
    vault.reads.lock().unwrap().clear();
    let wire = Arc::new(Wire::default());
    let (to, store) = (wire.clone(), keys.clone());
    let pc = pc_over(json!({ "openai": { "enabled": true }, "anthropic": { "enabled": true } }), scripted("present"), &[("MIXDOG_OAI_TRANSPORT", "http-sse")], json!({}), move |env, _| {
        env.http = to;
        env.keys = store;
    })
    .await;
    let adapter = pc.config.adapter("openai").await.expect("the PC serves openai");
    let sent = p::ModelRequest { model: "gpt-5".into(), messages: vec![p::Message::new(p::Role::User, p::Content::Text("hi".into()))], tools: Vec::new(), options: p::RequestOptions::default() };
    assert!(adapter.attempt(Arc::new(sent)).await.is_err(), "the scripted wire refuses");
    let sent_headers = wire.0.lock().unwrap();
    let bearer = sent_headers.iter().flatten().find(|(name, _)| name.eq_ignore_ascii_case("authorization")).expect("the request is authorised").1.clone();
    assert_eq!(json!(format!("openai:{}", bearer.strip_prefix("Bearer ").expect("a bearer"))), node["result"]["content"]);
    // The keychain account of a provider's key is `agent.<provider>.apiKey`; Node's `readApiKey(name)` names the provider.
    let read: Vec<String> = vault.reads.lock().unwrap().iter().map(|account| account.strip_prefix("agent.").and_then(|a| a.strip_suffix(".apiKey")).unwrap_or(account).to_owned()).collect();
    assert_eq!(json!(read), node["keyReads"]);
    assert_eq!(node["anthropicKeyInLastInit"], json!({ "$exact": "undefined" }));
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

/// Case 28, the `openai` half; the `mixdog-local` half (`localTraits`) is left: see [`without_local`].
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_text_only_adapter_advertises_its_image_trait() {
    let node = observed("a text-only adapter's image trait is advertised, so a remote read sends it OCR text");
    let pc = pc(json!({ "openai": { "enabled": true } }), scripted("present")).await;
    let providers = pc.answer().await["providers"].clone();
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
