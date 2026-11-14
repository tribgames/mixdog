//! The PC end of the model proxy in production: the three seams of `ProxyRunner`
//! (`mixdog_core_domains::domains::ai_admin::model_proxy`) over the services the daemon already holds.
//! Node's PC runtime is `createModelProxyRuntime` + `execute` (`apps/desktop/src/main/model-proxy-host.ts`).
//!
//! - [`PcProviderConfig`] is `providerConfig` (host.ts `createModelProxyRuntime().providerConfig`, then
//!   `publicProviderConfig`): the providers config the daemon's other hosts read, applied to the registry,
//!   plus the live adapters and each credential's presence; it is also the runner's provider lookup
//!   (`runtime.provider`), so a call reaches only what this PC's config enables.
//! - [`PcQuotaProbe`] is `quotaUsable` (host.ts `quotaUsable`): one measurement per provider for 60 s, concurrent
//!   callers joining it, a failed one never kept; each model is judged against it. The measurement and the
//!   judgement are `run_host::quota_usage::{measure, serves}`, the same code as `providerQuotaUsable`.
//! - [`PcWireRouter`] is `resolveWireRoute` (host.ts `execute`): the adapter answers, the server says only
//!   `agent` and `legacy`.
//!
//! Not here: the per-host provider allow-list (`isProviderAllowed`) is a desktop setting of the connection
//! that relays the call; the typed `modelProxy/run` carries none (see the wiring notes).

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use mixdog_ai::accounts::CredentialState;
use mixdog_ai::registry::accounted::input_excludes_cache;
use mixdog_ai::registry::keys::ApiKeyStore;
use mixdog_ai::registry::keys::Environment;
use mixdog_ai::registry::keys::KeyConfig;
use mixdog_ai::registry::providers::NO_ENABLED_PROVIDERS;
use mixdog_ai::registry::providers::OAUTH_PROVIDER_NAMES;
use mixdog_ai::registry::providers::ProviderBuilder;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::model_proxy::public_provider_config;
use mixdog_app_protocol::v2::model_proxy as w;
use mixdog_core_api::domain::provider as p;
use mixdog_core_domains::domains::ai_admin::model_proxy::ProviderConfigSource;
use mixdog_core_domains::domains::ai_admin::model_proxy::ProviderLookup;
use mixdog_core_domains::domains::ai_admin::model_proxy::QuotaProbe;
use mixdog_core_domains::domains::ai_admin::model_proxy::WireRouter;
use serde_json::Map;
use serde_json::Value;

use super::quota_usage::Measured;
use super::quota_usage::QuotaReadings;

// -- quotaUsable ----------------------------------------------------------------------------------

/// `QUOTA_MEASUREMENT_TTL_MS` (host.ts): the usage cache's own live window.
const QUOTA_WINDOW_MS: i64 = 60_000;

/// `measureProviderQuota` and `quotaMeasurementServesModel`, the two modules host.ts injects.
#[async_trait]
pub trait QuotaMeasure: Send + Sync {
    async fn measure(&self, provider: &str) -> Result<Measured, String>;
    async fn serves(&self, provider: &str, measured: &Measured, model: &str, now: i64) -> Result<bool, String>;
}

/// The measurement over the usage service's readings (`quota_usage`).
pub struct UsageMeasure(pub Arc<dyn QuotaReadings>);

#[async_trait]
impl QuotaMeasure for UsageMeasure {
    async fn measure(&self, provider: &str) -> Result<Measured, String> {
        super::quota_usage::measure(&*self.0, provider).await
    }

    async fn serves(&self, provider: &str, measured: &Measured, model: &str, now: i64) -> Result<bool, String> {
        super::quota_usage::serves(&*self.0, provider, measured, model, now).await
    }
}

type Flight = Shared<BoxFuture<'static, Result<Arc<Measured>, String>>>;

struct Slot {
    at: i64,
    flight: Flight,
}

pub struct PcQuotaProbe {
    measure: Arc<dyn QuotaMeasure>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    slots: Mutex<HashMap<String, Slot>>,
}

impl PcQuotaProbe {
    pub fn new(measure: Arc<dyn QuotaMeasure>, now: Arc<dyn Fn() -> i64 + Send + Sync>) -> Self {
        Self { measure, now, slots: Mutex::new(HashMap::new()) }
    }
}

#[async_trait]
impl QuotaProbe for PcQuotaProbe {
    async fn usable(&self, provider: &str, model: &str) -> Result<bool, String> {
        // The window check, the join of the measurement in flight and the start of a new one happen under one
        // lock that ends before any await.
        let flight = {
            let mut slots = self.slots.lock().unwrap_or_else(PoisonError::into_inner);
            let now = (self.now)();
            match slots.get(provider).filter(|slot| now - slot.at < QUOTA_WINDOW_MS) {
                Some(slot) => slot.flight.clone(),
                None => {
                    let (measure, name) = (Arc::clone(&self.measure), provider.to_owned());
                    let flight: Flight = async move { measure.measure(&name).await.map(Arc::new) }.boxed().shared();
                    slots.insert(provider.to_owned(), Slot { at: now, flight: flight.clone() });
                    flight
                }
            }
        };
        match flight.clone().await {
            Ok(measured) => self.measure.serves(provider, &measured, model, (self.now)()).await,
            Err(message) => {
                // A failed measurement is not kept (`measurement.catch(() => delete)`).
                let mut slots = self.slots.lock().unwrap_or_else(PoisonError::into_inner);
                if slots.get(provider).is_some_and(|slot| slot.flight.ptr_eq(&flight)) {
                    slots.remove(provider);
                }
                Err(message)
            }
        }
    }
}

// -- resolveWireRoute -----------------------------------------------------------------------------

pub struct PcWireRouter;

fn unreadable(what: &str, value: &str) -> p::ProviderError {
    let mut error = p::ProviderError::new(p::ErrorKind::Unknown, p::DeliveryState::NotSent);
    error.message = format!("the adapter answered a wire route with an unknown {what} \"{value}\"");
    error
}

#[async_trait]
impl WireRouter for PcWireRouter {
    async fn route(&self, adapter: &dyn p::ProviderAdapter, model: &str, context: w::ProxyRouteContext) -> Result<Option<w::ProxyWireRoute>, p::ProviderError> {
        // `typeof provider.resolveWireRoute !== 'function'`: a single-wire adapter pins nothing.
        let Some(routing) = adapter.wire_routing() else { return Ok(None) };
        let context = p::WireRouteContext { agent: context.agent, legacy: context.legacy, ..p::WireRouteContext::default() };
        let Some(route) = routing.resolve_wire_route(model, &context).await? else { return Ok(None) };
        // `chat`, `responses`, ... and `pinned`, `family`, ... are the wire's own camelCase names.
        let wire = serde_json::from_value(Value::String(route.wire.clone())).map_err(|_| unreadable("wire", &route.wire))?;
        let source = serde_json::from_value(Value::String(route.source.clone())).map_err(|_| unreadable("source", &route.source))?;
        Ok(Some(w::ProxyWireRoute { wire, source, profile_id: route.profile_id }))
    }
}

// -- providerConfig -------------------------------------------------------------------------------

/// The registry the PC advertises: applied from the config, then read for its live adapters.
#[async_trait]
pub trait PcRegistry: Send + Sync {
    /// `initProviders(config)`; a registry with nothing enabled is a state of this PC, not a failure.
    async fn apply(&self, providers: &Map<String, Value>) -> Result<(), String>;
    /// `getAllProviders()`, in registration order.
    fn live(&self) -> Vec<(String, Arc<dyn p::ProviderAdapter>)>;
    /// `getProvider(name)`.
    async fn get(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>>;
}

#[async_trait]
impl PcRegistry for ProviderRegistry {
    async fn apply(&self, providers: &Map<String, Value>) -> Result<(), String> {
        match self.init_providers(providers).await {
            Err(error) if error.code != Some(NO_ENABLED_PROVIDERS) => Err(error.message),
            _ => Ok(()),
        }
    }

    fn live(&self) -> Vec<(String, Arc<dyn p::ProviderAdapter>)> {
        self.all()
    }

    async fn get(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
        ProviderRegistry::get(self, name).await
    }
}

/// `credentialState` (host.ts): `present`, `absent` or `unreadable`.
#[async_trait]
pub trait CredentialProbe: Send + Sync {
    async fn auth_state(&self, name: &str, entry: &Map<String, Value>) -> Result<&'static str, String>;
}

/// The credential probe over the registry's own key store and OAuth probe.
pub struct RegistryCredentials {
    pub builder: Arc<dyn ProviderBuilder>,
    pub keys: ApiKeyStore,
    pub env: Arc<dyn Environment>,
}

fn is_custom(entry: &Map<String, Value>) -> bool {
    entry.get("type").and_then(Value::as_str) == Some("custom")
}

/// `keyEnvironment`: a custom provider that names the variable its key lives in.
fn key_environment(entry: &Map<String, Value>) -> Option<&str> {
    let named = entry.get("apiKeyEnv").and_then(Value::as_str).filter(|name| !name.is_empty());
    named.filter(|_| is_custom(entry) && entry.get("auth").and_then(Value::as_str) != Some("none"))
}

#[async_trait]
impl CredentialProbe for RegistryCredentials {
    async fn auth_state(&self, name: &str, entry: &Map<String, Value>) -> Result<&'static str, String> {
        let present = |yes: bool| if yes { "present" } else { "absent" };
        if let Some(variable) = key_environment(entry) {
            return Ok(present(self.env.key_var(variable).is_some_and(|value| !value.is_empty())));
        }
        // `modelProxyCredentialProbe`.
        if name == "mixdog-local" || (is_custom(entry) && entry.get("auth").and_then(Value::as_str) == Some("none")) {
            return Ok("present");
        }
        if OAUTH_PROVIDER_NAMES.contains(&name) {
            return Ok(match self.builder.oauth_credential_state(name).await? {
                CredentialState::Present => "present",
                CredentialState::Absent => "absent",
                CredentialState::Unreadable => "unreadable",
            });
        }
        let config = KeyConfig {
            api_key: entry.get("apiKey").and_then(Value::as_str).map(str::to_owned),
            api_key_env: entry.get("apiKeyEnv").and_then(Value::as_str).map(str::to_owned),
        };
        self.keys.has_resolved(name, &config).await.map(present).map_err(|error| error.to_string())
    }
}

/// `consumesReadWindows = true` (cursor.mjs, `CursorProviderBase`).
fn consumes_read_windows(name: &str) -> bool {
    matches!(name, "cursor-oauth" | "cursor-api")
}

/// `takesImages = false` (mixdog-local.mjs): the text-only local runtime.
pub(super) fn takes_images(name: &str) -> bool {
    name != "mixdog-local"
}

/// What the live adapter declares for the server's stand-in (`providerConfig`'s `modelProxy` traits).
fn traits_of(name: &str, adapter: &dyn p::ProviderAdapter) -> Value {
    let mut traits = Map::new();
    traits.insert("inputExcludesCache".into(), Value::Bool(adapter.input_excludes_cache().unwrap_or_else(|| input_excludes_cache(name))));
    traits.insert("nativePdf".into(), Value::Bool(adapter.native_pdf()));
    if consumes_read_windows(name) {
        traits.insert("consumesReadWindows".into(), Value::Bool(true));
    }
    if !takes_images(name) {
        traits.insert("takesImages".into(), Value::Bool(false));
    }
    // `instance.firstResponseBudget?.()`: the adapter's own figure, asked for no model.
    if let Some(budget) = adapter.first_response_budget("", None).filter(|b| b.transport_ms > 0 && b.semantic_ms > 0) {
        traits.insert("firstResponseBudget".into(), serde_json::json!({ "transportMs": budget.transport_ms, "semanticMs": budget.semantic_ms }));
    }
    Value::Object(traits)
}

pub struct PcProviderConfig {
    /// The providers section of the live config (`config.agent().providers`), as every host reads it.
    providers: Arc<dyn Fn() -> Map<String, Value> + Send + Sync>,
    registry: Arc<dyn PcRegistry>,
    credentials: Arc<dyn CredentialProbe>,
}

impl PcProviderConfig {
    pub fn new(providers: Arc<dyn Fn() -> Map<String, Value> + Send + Sync>, registry: Arc<dyn PcRegistry>, credentials: Arc<dyn CredentialProbe>) -> Self {
        Self { providers, registry, credentials }
    }
}

#[async_trait]
impl ProviderConfigSource for PcProviderConfig {
    async fn public(&self) -> Result<(Vec<(String, w::ProxyProviderInfo)>, bool), String> {
        let available = (self.providers)();
        // The registry is loaded first, so a cold PC never answers "nothing enabled".
        self.registry.apply(&available).await?;
        let live = self.registry.live();
        let mut names: Vec<&String> = available.keys().collect();
        names.extend(live.iter().map(|(name, _)| name).filter(|name| !available.contains_key(*name)));
        let mut providers = Map::new();
        for name in names {
            let instance = live.iter().find(|(live_name, _)| live_name == name).map(|(_, adapter)| adapter);
            let configured = available.get(name).and_then(Value::as_object).cloned().unwrap_or_default();
            let auth_state = self.credentials.auth_state(name, &configured).await?;
            let configured_enabled = configured.get("enabled") == Some(&Value::Bool(true)) || configured.get("credentialProbeUnavailable") == Some(&Value::Bool(true));
            // Only the fields the public projection reads are carried: no key, URL or account leaves this map.
            let mut item = Map::new();
            for key in ["type", "name", "models", "modelOverrides"] {
                if let Some(value) = configured.get(key) {
                    item.insert(key.into(), value.clone());
                }
            }
            item.insert("enabled".into(), Value::Bool(configured_enabled && instance.is_some() && auth_state != "absent"));
            item.insert("authState".into(), auth_state.into());
            item.insert("modelProxy".into(), instance.map_or_else(|| Value::Object(Map::new()), |adapter| traits_of(name, adapter.as_ref())));
            providers.insert(name.clone(), Value::Object(item));
        }
        // Every provider is allowed here: the per-host allow-list belongs to the relaying connection.
        let public = public_provider_config(&Value::Object(providers), &|_| true);
        let list = public
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, info)| serde_json::from_value::<w::ProxyProviderInfo>(info.clone()).map(|info| (name.clone(), info)).map_err(|error| error.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((list, true))
    }
}

/// `runtime.provider(name)` (host.ts `createModelProxyRuntime`): a server reaches only a provider this PC's config
/// enables (or whose credential probe could not run) and whose credential is not absent, after the registry has
/// been applied from the config; a provider disabled or removed here is never reached, even while the registry
/// keeps its instance. A credential probe that fails reads as unavailable.
#[async_trait]
impl ProviderLookup for PcProviderConfig {
    async fn adapter(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
        let available = (self.providers)();
        let configured = available.get(name).and_then(Value::as_object).cloned().unwrap_or_default();
        let enabled = configured.get("enabled") == Some(&Value::Bool(true)) || configured.get("credentialProbeUnavailable") == Some(&Value::Bool(true));
        if !enabled || self.credentials.auth_state(name, &configured).await.ok()? == "absent" {
            return None;
        }
        self.registry.apply(&available).await.ok()?;
        self.registry.get(name).await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicI64;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use mixdog_ai::registry::keys::MemoryVault;
    use mixdog_core_api::domain::mock::MockAttempt;
    use mixdog_core_api::domain::mock::MockProvider;
    use serde_json::json;
    use tokio::sync::Notify;

    use super::*;

    const TWIN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/model-proxy-pc/model-proxy-pc-twin.json");

    fn twin() -> Value {
        serde_json::from_str(&TWIN).unwrap()
    }

    /// A provider that is the mock but for what the case sets.
    struct Fake {
        inner: MockProvider,
        native_pdf: bool,
        budget: Option<p::FirstResponseBudget>,
        routing: Option<Arc<Routing>>,
    }

    impl Fake {
        fn new(native_pdf: bool, budget: Option<p::FirstResponseBudget>, routing: Option<Arc<Routing>>) -> Arc<dyn p::ProviderAdapter> {
            Arc::new(Self { inner: MockProvider::new(Vec::<MockAttempt>::new()), native_pdf, budget, routing })
        }
    }

    #[async_trait]
    impl p::ProviderAdapter for Fake {
        fn release_send(&self, _group: &str) {}
        fn id(&self) -> &mixdog_protocol::ProviderId {
            self.inner.id()
        }
        fn codec(&self) -> &dyn p::WireCodec {
            self.inner.codec()
        }
        fn retry_policy(&self) -> &mixdog_core_api::domain::retry::RetryPolicy {
            self.inner.retry_policy()
        }
        fn keepalive(&self) -> &mixdog_core_api::domain::keepalive::KeepaliveSchedule {
            self.inner.keepalive()
        }
        async fn attempt(&self, request: Arc<p::ModelRequest>) -> Result<Box<dyn p::ModelStream>, p::ProviderError> {
            self.inner.attempt(request).await
        }
        fn wire_routing(&self) -> Option<&dyn p::WireRouting> {
            self.routing.as_deref().map(|routing| routing as &dyn p::WireRouting)
        }
        fn native_pdf(&self) -> bool {
            self.native_pdf
        }
        fn first_response_budget(&self, _: &str, _: Option<&mixdog_protocol::JsonValue>) -> Option<p::FirstResponseBudget> {
            self.budget
        }
    }

    struct Routing {
        answer: Result<Option<p::WireRoute>, String>,
        seen: Mutex<Vec<(String, p::WireRouteContext)>>,
    }

    #[async_trait]
    impl p::WireRouting for Routing {
        async fn resolve_wire_route(&self, model: &str, context: &p::WireRouteContext) -> Result<Option<p::WireRoute>, p::ProviderError> {
            self.seen.lock().unwrap().push((model.to_owned(), context.clone()));
            self.answer.clone().map_err(|message| {
                let mut error = p::ProviderError::new(p::ErrorKind::Unknown, p::DeliveryState::NotSent);
                error.message = message;
                error
            })
        }
    }

    struct Registry {
        apply: Result<(), String>,
        live: Vec<(String, Arc<dyn p::ProviderAdapter>)>,
    }

    #[async_trait]
    impl PcRegistry for Registry {
        async fn apply(&self, _: &Map<String, Value>) -> Result<(), String> {
            self.apply.clone()
        }
        fn live(&self) -> Vec<(String, Arc<dyn p::ProviderAdapter>)> {
            self.live.clone()
        }
        async fn get(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
            self.live.iter().find(|(live, _)| live == name).map(|(_, adapter)| adapter.clone())
        }
    }

    struct Builder(HashMap<String, String>);

    #[async_trait]
    impl ProviderBuilder for Builder {
        async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn p::ProviderAdapter>, String> {
            Err(format!("unknown enabled provider: {name}"))
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, name: &str) -> Result<bool, String> {
            Ok(self.0.get(name).is_some_and(|state| state == "present"))
        }
        async fn oauth_credential_state(&self, name: &str) -> Result<CredentialState, String> {
            Ok(match self.0.get(name).map(String::as_str) {
                Some("present") => CredentialState::Present,
                Some("unreadable") => CredentialState::Unreadable,
                _ => CredentialState::Absent,
            })
        }
    }

    struct Vars(HashSet<String>);

    impl Environment for Vars {
        fn var(&self, name: &str) -> Option<String> {
            self.0.contains(name).then(|| "value".to_owned())
        }
    }

    fn strings(value: &Value) -> Vec<String> {
        value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
    }

    /// The one function the accounting, the context metrics and this advertisement read equals each adapter
    /// class's own `static inputExcludesCache`.
    #[test]
    fn the_usage_convention_is_each_adapter_classes_own() {
        let twin = twin();
        let classes = twin["inputExcludesCache"].as_object().unwrap();
        assert!(classes.len() > 15);
        for (name, excludes) in classes {
            assert_eq!(input_excludes_cache(name), excludes.as_bool().unwrap(), "{name}");
        }
    }

    #[tokio::test]
    async fn the_advertised_providers_are_what_nodes_pc_runtime_answers() {
        let twin = twin();
        let cases = twin["providerConfigCases"].as_array().unwrap();
        assert!(cases.len() > 100);
        for case in cases {
            let live = case["live"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(name, state)| {
                    let budget = state["budget"].as_object().map(|b| p::FirstResponseBudget { transport_ms: b["transportMs"].as_i64().unwrap(), semantic_ms: b["semanticMs"].as_i64().unwrap() });
                    (name.clone(), Fake::new(state["nativePdf"].as_bool().unwrap(), budget, None))
                })
                .collect();
            let failure = case["failSync"].as_str().map(str::to_owned);
            let registry = Registry { apply: failure.map_or(Ok(()), Err), live };
            let oauth = case["oauth"].as_object().unwrap().iter().map(|(name, state)| (name.clone(), state.as_str().unwrap().to_owned())).collect();
            let env: Arc<dyn Environment> = Arc::new(Vars(strings(&case["env"]).into_iter().collect()));
            let keys = ApiKeyStore::new(Arc::new(MemoryVault::default()), Arc::new(Vars(HashSet::new())), false);
            for name in strings(&case["keysStored"]) {
                keys.save(&name, "stored").await.unwrap();
            }
            let credentials = RegistryCredentials { builder: Arc::new(Builder(oauth)), keys, env };
            let available = case["available"].as_object().unwrap().clone();
            let config = PcProviderConfig::new(Arc::new(move || available.clone()), Arc::new(registry), Arc::new(credentials));
            let got = config.public().await;
            match case.get("error") {
                Some(error) => assert_eq!(got.unwrap_err(), error["message"].as_str().unwrap(), "{case}"),
                None => {
                    let (providers, ready) = got.unwrap();
                    let expected = &case["value"];
                    assert_eq!(Some(ready), expected["ready"].as_bool(), "{case}");
                    // The answer is a JSON object whose key order Node keeps.
                    let answer = json!({ "providers": serde_json::to_value(w::ProxyAnswer::ProviderConfig { providers, ready: None }).unwrap()["providers"] });
                    assert_eq!(answer["providers"], expected["providers"], "{case}");
                    let order = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
                    assert_eq!(order(&answer["providers"]), order(&expected["providers"]), "{case}");
                }
            }
        }
    }

    #[tokio::test]
    async fn the_adapter_answers_a_wire_route_and_is_told_only_agent_and_legacy() {
        let twin = twin();
        for case in twin["wireRouteCases"].as_array().unwrap() {
            let kind = case["kind"].as_str().unwrap();
            let answer = match kind {
                "route" => Ok(Some(p::WireRoute {
                    wire: case["route"]["wire"].as_str().unwrap().into(),
                    source: case["route"]["source"].as_str().unwrap().into(),
                    profile_id: case["route"]["profileId"].as_str().unwrap().into(),
                })),
                "throws" => Err(case["error"]["message"].as_str().unwrap().to_owned()),
                _ => Ok(None),
            };
            let routing = (kind != "none").then(|| Arc::new(Routing { answer, seen: Mutex::default() }));
            let adapter = Fake::new(true, None, routing.clone());
            let context = w::ProxyRouteContext { agent: case["context"]["agent"] == json!(true), legacy: case["context"]["legacy"] == json!(true) };
            let model = case["model"].as_str().unwrap();
            let got = PcWireRouter.route(adapter.as_ref(), model, context).await;
            match case.get("error") {
                Some(error) => assert_eq!(got.unwrap_err().message, error["message"].as_str().unwrap(), "{case}"),
                None => {
                    let want = (!case["value"].is_null()).then(|| serde_json::from_value::<w::ProxyWireRoute>(case["value"].clone()).unwrap());
                    assert_eq!(got.unwrap(), want, "{case}");
                }
            }
            let asked = case["seen"].as_array().unwrap();
            let seen = routing.map(|routing| routing.seen.lock().unwrap().clone()).unwrap_or_default();
            let want: Vec<(String, p::WireRouteContext)> = asked
                .iter()
                .map(|call| (call["model"].as_str().unwrap().to_owned(), p::WireRouteContext { agent: call["context"]["agent"] == json!(true), legacy: call["context"]["legacy"] == json!(true), ..p::WireRouteContext::default() }))
                .collect();
            assert_eq!(seen, want, "{case}");
        }
    }

    /// Counts measurements; a gated one waits for the release; a failing one fails.
    struct Counting {
        measurements: AtomicUsize,
        fail: AtomicBool,
        gated: AtomicBool,
        release: Notify,
        /// Holds a permit once a measurement has begun.
        began: Notify,
    }

    #[async_trait]
    impl QuotaMeasure for Counting {
        async fn measure(&self, _: &str) -> Result<Measured, String> {
            self.measurements.fetch_add(1, Ordering::SeqCst);
            self.began.notify_one();
            if self.gated.load(Ordering::SeqCst) {
                self.release.notified().await;
            }
            if self.fail.load(Ordering::SeqCst) {
                return Err("usage fetch failed".into());
            }
            Ok(Measured::Single { use_credits: false, reading: Some(json!({ "servable": ["gpt-a"] })) })
        }

        async fn serves(&self, _: &str, measured: &Measured, model: &str, _: i64) -> Result<bool, String> {
            let Measured::Single { reading: Some(reading), .. } = measured else { panic!("not the counted measurement") };
            Ok(reading["servable"].as_array().unwrap().iter().any(|m| m == model))
        }
    }

    fn outcome(result: &Result<bool, String>) -> Value {
        match result {
            Ok(value) => json!(value),
            Err(message) => json!({ "error": message }),
        }
    }

    fn recorded(result: &Value) -> Value {
        result.get("error").map_or_else(|| result["value"].clone(), |error| json!({ "error": error["message"] }))
    }

    #[tokio::test]
    async fn one_measurement_serves_a_window_as_nodes_pc_runtime_shares_it() {
        let twin = twin();
        for scenario in twin["quotaScenarios"].as_array().unwrap() {
            let counting = Arc::new(Counting { measurements: AtomicUsize::new(0), fail: AtomicBool::new(false), gated: AtomicBool::new(false), release: Notify::new(), began: Notify::new() });
            let clock = Arc::new(AtomicI64::new(1_000));
            let probe = PcQuotaProbe::new(counting.clone(), Arc::new({
                let clock = clock.clone();
                move || clock.load(Ordering::SeqCst)
            }));
            for step in scenario["steps"].as_array().unwrap() {
                let at = |key: &str| step[key].as_str().unwrap_or("openai-oauth").to_owned();
                let got: Vec<Value> = match step["op"].as_str().unwrap() {
                    "clock" => {
                        clock.fetch_add(step["ms"].as_i64().unwrap(), Ordering::SeqCst);
                        Vec::new()
                    }
                    "fail" => {
                        counting.fail.store(step["on"].as_bool().unwrap(), Ordering::SeqCst);
                        Vec::new()
                    }
                    "ask" => vec![outcome(&probe.usable(&at("provider"), step["model"].as_str().unwrap()).await)],
                    "burst" => {
                        counting.gated.store(true, Ordering::SeqCst);
                        let provider = at("provider");
                        let asks = futures::future::join_all(step["models"].as_array().unwrap().iter().map(|model| probe.usable(&provider, model.as_str().unwrap())));
                        tokio::pin!(asks);
                        mixdog_core_session::session::testing::awaiting(|| "the burst to begin a measurement".to_owned(), async {
                            tokio::select! {
                                biased;
                                () = counting.began.notified() => counting.release.notify_one(),
                                _ = &mut asks => panic!("the burst ended before a measurement began"),
                            }
                        })
                        .await;
                        let results = mixdog_core_session::session::testing::awaiting(|| "the burst's asks to end once the measurement is released".to_owned(), asks).await;
                        counting.gated.store(false, Ordering::SeqCst);
                        results.iter().map(outcome).collect()
                    }
                    other => panic!("{other}"),
                };
                let want: Vec<Value> = step["results"].as_array().unwrap().iter().map(recorded).collect();
                assert_eq!(got, want, "{} / {step}", scenario["name"]);
                assert_eq!(counting.measurements.load(Ordering::SeqCst) as u64, step["measurements"].as_u64().unwrap(), "{} / {step}", scenario["name"]);
            }
        }
    }
}
