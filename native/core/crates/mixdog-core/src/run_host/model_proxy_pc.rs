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
            let configured_enabled =
                configured.get("enabled") == Some(&Value::Bool(true)) || configured.get("credentialProbeUnavailable") == Some(&Value::Bool(true));
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
            .map(|(name, info)| {
                serde_json::from_value::<w::ProxyProviderInfo>(info.clone()).map(|info| (name.clone(), info)).map_err(|error| error.to_string())
            })
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
mod tests {}

#[cfg(test)]
mod quota_window_tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::atomic::AtomicI64;
    use std::sync::atomic::Ordering;

    use super::*;

    /// Counts the measurements it is asked for per provider; the first one fails when `fail_first` is set. A model is served when
    /// its name is `served`.
    #[derive(Default)]
    struct Counting {
        measured: Mutex<Vec<String>>,
        fail_first: AtomicBool,
    }

    #[async_trait]
    impl QuotaMeasure for Counting {
        async fn measure(&self, provider: &str) -> Result<Measured, String> {
            self.measured.lock().unwrap().push(provider.to_owned());
            if self.fail_first.swap(false, Ordering::SeqCst) {
                return Err("usage unavailable".into());
            }
            Ok(Measured::None)
        }
        async fn serves(&self, _: &str, _: &Measured, model: &str, _: i64) -> Result<bool, String> {
            Ok(model == "served")
        }
    }

    fn probe(measure: &Arc<Counting>, clock: &Arc<AtomicI64>) -> PcQuotaProbe {
        let clock = clock.clone();
        PcQuotaProbe::new(measure.clone(), Arc::new(move || clock.load(Ordering::SeqCst)))
    }

    #[tokio::test]
    async fn a_providers_quota_is_measured_once_per_minute_and_every_model_is_judged_against_it() {
        let (measure, clock) = (Arc::new(Counting::default()), Arc::new(AtomicI64::new(1_000)));
        let probe = probe(&measure, &clock);
        assert_eq!(probe.usable("openai", "served").await, Ok(true));
        assert_eq!(probe.usable("openai", "other").await, Ok(false), "judged on the one measurement, never retained");
        clock.store(1_000 + QUOTA_WINDOW_MS - 1, Ordering::SeqCst);
        assert_eq!(probe.usable("openai", "served").await, Ok(true));
        assert_eq!(measure.measured.lock().unwrap().len(), 1, "one measurement inside the window");
        clock.store(1_000 + QUOTA_WINDOW_MS, Ordering::SeqCst);
        assert_eq!(probe.usable("openai", "served").await, Ok(true));
        assert_eq!(measure.measured.lock().unwrap().len(), 2, "a new one once the window has passed");
    }

    #[tokio::test]
    async fn each_provider_has_its_own_measurement() {
        let (measure, clock) = (Arc::new(Counting::default()), Arc::new(AtomicI64::new(0)));
        let probe = probe(&measure, &clock);
        probe.usable("openai", "served").await.unwrap();
        probe.usable("anthropic", "served").await.unwrap();
        probe.usable("openai", "served").await.unwrap();
        assert_eq!(*measure.measured.lock().unwrap(), vec!["openai".to_owned(), "anthropic".to_owned()]);
    }

    #[tokio::test]
    async fn two_runs_asking_at_once_share_the_measurement_in_flight() {
        let (measure, clock) = (Arc::new(Counting::default()), Arc::new(AtomicI64::new(0)));
        let probe = probe(&measure, &clock);
        let (a, b) = tokio::join!(probe.usable("openai", "served"), probe.usable("openai", "other"));
        assert_eq!((a, b), (Ok(true), Ok(false)));
        assert_eq!(measure.measured.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_failed_measurement_is_reported_and_not_kept() {
        let (measure, clock) = (Arc::new(Counting::default()), Arc::new(AtomicI64::new(0)));
        measure.fail_first.store(true, Ordering::SeqCst);
        let probe = probe(&measure, &clock);
        assert_eq!(probe.usable("openai", "served").await, Err("usage unavailable".to_owned()));
        assert_eq!(probe.usable("openai", "served").await, Ok(true), "the next ask measures again");
        assert_eq!(measure.measured.lock().unwrap().len(), 2);
    }
}
