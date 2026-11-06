//! The process-global provider set (`providers/registry.mjs`).
//!
//! One owner: the config of record. [`ProviderRegistry::init_providers`] is
//! the additive "ensure registered" request every runtime makes: it builds
//! the enabled providers that are missing and never rebuilds or removes a
//! registered one. [`ProviderRegistry::sync_providers`] applies the record:
//! a registered provider is rebuilt when its config signature changed and
//! removed only by a stored decision (`enabled: false`, or a deleted custom
//! provider). A credential that could not be read is never a decision.
//!
//! Which adapter a name constructs is the [`ProviderBuilder`]'s business (it
//! owns the HTTP client, credential stores and admission wrapper); the
//! registry owns the set, the signatures and the gates.

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderAdapter;
use serde_json::Map;

use super::accounted::{AccountedAdapter, AccountingDeps};
use serde_json::Value;

/// Error code of an init that has no enabled provider.
pub const NO_ENABLED_PROVIDERS: &str = "PROVIDERS_NONE_ENABLED";

/// A provider name that is injected from an on-disk credential probe instead
/// of the saved config; `get` registers one lazily once its credential reads
/// as present.
pub const OAUTH_PROVIDER_NAMES: [&str; 10] = [
    "anthropic-oauth",
    "openai-oauth",
    "grok-oauth",
    "muse-code-oauth",
    "command-code-oauth",
    "mimo-oauth",
    "cursor-oauth",
    "devin-oauth",
    "antigravity-oauth",
    "opencode-go-oauth",
];

/// Retired provider ids: a saved route or session naming one is served by its
/// replacement account.
const RETIRED_PROVIDER_ALIASES: [(&str, &str); 1] = [("opencode-go", "opencode-go-oauth")];

/// The key under which a custom provider's additional key ids join its entry.
pub const CUSTOM_KEY_IDS: &str = "customKeyIds";

#[derive(Clone, PartialEq, Eq, Debug, thiserror::Error)]
#[error("{message}")]
pub struct RegistryError {
    pub message: String,
    /// `Some(NO_ENABLED_PROVIDERS)` when the registry would stay empty.
    pub code: Option<&'static str>,
}

impl RegistryError {
    fn plain(message: String) -> Self {
        Self { message, code: None }
    }
}

/// Constructs the adapter a provider name stands for. Admission and account
/// rotation wrap sends above the adapter (broker, `AccountRotation`), so the
/// built adapter is the plain one.
#[async_trait]
pub trait ProviderBuilder: Send + Sync {
    /// The adapter for `name` built from `config` (which carries
    /// [`CUSTOM_KEY_IDS`] for a custom provider with additional keys). `Err`
    /// is the reason it cannot be built (`unknown enabled provider: <name>`
    /// for a name no family serves).
    async fn build(&self, name: &str, config: &Value) -> Result<Arc<dyn ProviderAdapter>, String>;

    /// Ids of a custom provider's additional keys (`customProviderKeyIds`).
    async fn custom_key_ids(&self, name: &str) -> Vec<String>;

    /// Whether a dev-gated provider is on (`providerAvailable`).
    fn available(&self, name: &str) -> bool;

    /// Whether an OAuth provider's stored credential reads as present.
    async fn oauth_credentials_usable(&self, name: &str) -> bool;
}

struct Entry {
    adapter: Arc<dyn ProviderAdapter>,
    /// `None`: never matches, so the next sync rebuilds it.
    signature: Option<String>,
}

#[derive(Default)]
struct State {
    providers: HashMap<String, Entry>,
    init_errors: HashMap<String, String>,
    explicitly_disabled: HashSet<String>,
    catalog_revision: u64,
    /// name -> signature whose catalog was fetched (or is being fetched).
    catalog_refreshed: HashMap<String, Option<String>>,
    initialized: bool,
}

/// What an apply does with the config it is given.
struct Plan {
    config: Map<String, Value>,
    rebuild: bool,
    add: bool,
    /// Names a stored decision turned off; `None` when no decision is known.
    is_off: Option<Box<dyn Fn(&str) -> bool + Send>>,
}

pub struct ProviderRegistry {
    builder: Arc<dyn ProviderBuilder>,
    /// Set: every provider this registry hands out sends through the usage ledger.
    accounting: Option<Arc<AccountingDeps>>,
    state: Mutex<State>,
    /// Every mutation runs under this lock, so two applies never interleave.
    apply: tokio::sync::Semaphore,
}

fn sort_keys_deep(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(sort_keys_deep).collect()),
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|k| (k.clone(), sort_keys_deep(&o[k]))).collect())
        }
        other => other.clone(),
    }
}

/// Deterministic structural signature of a provider config: equal configs give
/// the same string whatever their key order.
pub fn config_signature(cfg: &Value) -> String {
    sort_keys_deep(cfg).to_string()
}

fn is_custom(name: &str, cfg: &Value) -> bool {
    cfg.get("type").and_then(Value::as_str) == Some("custom") && name.starts_with("custom-")
}

fn canonical(name: &str) -> &str {
    RETIRED_PROVIDER_ALIASES.iter().find(|(old, _)| *old == name).map_or(name, |(_, new)| new)
}

impl ProviderRegistry {
    pub fn new(builder: Arc<dyn ProviderBuilder>) -> Self {
        Self { builder, accounting: None, state: Mutex::new(State::default()), apply: tokio::sync::Semaphore::new(1) }
    }

    /// Makes every provider built from here on an accounted one (`accountProviderSend`).
    pub fn with_accounting(mut self, accounting: AccountingDeps) -> Self {
        self.accounting = Some(Arc::new(accounting));
        self
    }

    fn accounted(&self, name: &str, adapter: Arc<dyn ProviderAdapter>) -> Arc<dyn ProviderAdapter> {
        match &self.accounting {
            Some(deps) => AccountedAdapter::wrap(adapter, name, Arc::clone(deps)),
            None => adapter,
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether a provider set has first applied.
    pub fn initialized(&self) -> bool {
        self.state().initialized
    }

    /// Adds a custom provider's additional key ids to its entry (and so its
    /// reuse signature): a save that changes them rebuilds the provider.
    async fn with_custom_key_ids(&self, config: &Map<String, Value>) -> Map<String, Value> {
        let mut out = config.clone();
        for (name, cfg) in config {
            if !is_custom(name, cfg) || cfg.get("auth").and_then(Value::as_str) == Some("none") {
                continue;
            }
            let ids = self.builder.custom_key_ids(name).await;
            if ids.is_empty() {
                continue;
            }
            let mut next = cfg.clone();
            if let Some(o) = next.as_object_mut() {
                o.insert(CUSTOM_KEY_IDS.into(), Value::Array(ids.into_iter().map(Value::String).collect()));
            }
            out.insert(name.clone(), next);
        }
        out
    }

    /// Ensures the providers `config` enables are registered (additive). A
    /// registered one is left as it is. Errors with `NO_ENABLED_PROVIDERS`
    /// when the registry is still empty afterwards.
    pub async fn init_providers(&self, config: &Map<String, Value>) -> Result<(), RegistryError> {
        let plan = Plan { config: self.with_custom_key_ids(config).await, rebuild: false, add: true, is_off: None };
        if !self.state().providers.is_empty() && self.pending(&plan).is_empty() {
            return Ok(());
        }
        self.apply_plan(plan).await
    }

    /// Applies the config of record: rebuilds every registered provider whose
    /// signature changed and removes those a stored decision turned off.
    /// `decisions` is the stored providers section (`None` when unreadable:
    /// nothing is removed). Never adds a provider, never fails for an empty set.
    pub async fn sync_providers(
        &self,
        record: &Map<String, Value>,
        decisions: Option<Map<String, Value>>,
    ) -> Result<(), RegistryError> {
        let is_off = decisions.map(|d| {
            Box::new(move |name: &str| {
                d.get(name).and_then(|v| v.get("enabled")).and_then(Value::as_bool) == Some(false)
                    || (name.starts_with("custom-") && !d.contains_key(name))
            }) as Box<dyn Fn(&str) -> bool + Send>
        });
        let config = self.with_custom_key_ids(record).await;
        self.apply_plan(Plan { config, rebuild: true, add: false, is_off }).await
    }

    /// Entries of the plan that need a build: missing ones when it adds,
    /// changed ones when it rebuilds.
    fn pending(&self, plan: &Plan) -> Vec<(String, Value, Option<String>)> {
        let state = self.state();
        let mut out = Vec::new();
        for (name, cfg) in &plan.config {
            if cfg.get("enabled").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            if !self.builder.available(name) || RETIRED_PROVIDER_ALIASES.iter().any(|(old, _)| old == name) {
                continue;
            }
            let sig = Some(config_signature(cfg));
            let wanted = match state.providers.get(name) {
                Some(entry) => plan.rebuild && (sig.is_none() || entry.signature != sig),
                None => plan.add,
            };
            if wanted {
                out.push((name.clone(), cfg.clone(), sig));
            }
        }
        out
    }

    async fn apply_plan(&self, plan: Plan) -> Result<(), RegistryError> {
        // The semaphore is never closed, so the permit is always granted.
        let _chain = self.apply.acquire().await;
        let mut built = Vec::new();
        for (name, cfg, sig) in self.pending(&plan) {
            match self.builder.build(&name, &cfg).await {
                Ok(adapter) => {
                    let adapter = self.accounted(&name, adapter);
                    built.push((name, Ok((adapter, sig))));
                }
                Err(msg) => {
                    let error = format!("[provider] Failed to init \"{name}\": {msg}");
                    // One invalid custom provider is isolated: skipped and
                    // reported, the rest of the registry builds.
                    if is_custom(&name, &cfg) {
                        built.push((name, Err(error)));
                    } else {
                        return Err(RegistryError::plain(error));
                    }
                }
            }
        }
        let mut skipped = Vec::new();
        let mut state = self.state();
        for (name, result) in built {
            match result {
                Ok((adapter, sig)) => Self::register(&mut state, &name, adapter, sig),
                Err(error) => {
                    Self::remove(&mut state, &name);
                    state.init_errors.insert(name, error.clone());
                    tracing::warn!("{error} (provider skipped; fix its configuration)");
                    skipped.push(error);
                }
            }
        }
        if let Some(is_off) = &plan.is_off {
            let names: Vec<String> = state.providers.keys().chain(state.init_errors.keys()).cloned().collect();
            for name in names {
                if is_off(&name) {
                    Self::remove(&mut state, &name);
                }
            }
            state.explicitly_disabled =
                OAUTH_PROVIDER_NAMES.iter().filter(|n| is_off(n)).map(|n| (*n).to_owned()).collect();
        }
        if plan.add && state.providers.is_empty() {
            let tail = if skipped.is_empty() {
                String::new()
            } else {
                format!("; invalid custom providers skipped: {}", skipped.join("; "))
            };
            return Err(RegistryError {
                message: format!("[provider] no provider is enabled{tail}"),
                code: Some(NO_ENABLED_PROVIDERS),
            });
        }
        if !state.providers.is_empty() {
            state.initialized = true;
        }
        Ok(())
    }

    fn register(state: &mut State, name: &str, adapter: Arc<dyn ProviderAdapter>, signature: Option<String>) {
        state.providers.insert(name.to_owned(), Entry { adapter, signature });
        state.explicitly_disabled.remove(name);
        state.init_errors.remove(name);
        state.catalog_revision += 1;
    }

    fn remove(state: &mut State, name: &str) -> bool {
        state.init_errors.remove(name);
        state.catalog_refreshed.remove(name);
        let had = state.providers.remove(name).is_some();
        if had {
            state.catalog_revision += 1;
        }
        had
    }

    /// The instance registered under `name` right now, with no lazy
    /// registration (`registeredProvider`).
    pub fn registered(&self, name: &str) -> Option<Arc<dyn ProviderAdapter>> {
        self.state().providers.get(name).map(|e| Arc::clone(&e.adapter))
    }

    /// The provider for `requested` (`getProvider`): a retired id maps to its
    /// replacement; an OAuth provider whose credential reads as present and
    /// that no decision turned off is registered on the spot, under the
    /// signature of the empty config it is built from.
    pub async fn get(&self, requested: &str) -> Option<Arc<dyn ProviderAdapter>> {
        let name = canonical(requested);
        if !self.builder.available(name) {
            return None;
        }
        if let Some(adapter) = self.registered(name) {
            return Some(adapter);
        }
        if !OAUTH_PROVIDER_NAMES.contains(&name) || self.state().explicitly_disabled.contains(name) {
            return None;
        }
        if !self.builder.oauth_credentials_usable(name).await {
            return None;
        }
        let empty = Value::Object(Map::new());
        let adapter = self.accounted(name, self.builder.build(name, &empty).await.ok()?);
        // Both gates again after the await (Node): the credential may have been
        // removed, or the provider disabled, while the build was in flight. The
        // disable check and the registration share one lock, so a `disable`
        // cannot slip between them.
        if !self.builder.oauth_credentials_usable(name).await {
            return None;
        }
        let mut state = self.state();
        if state.explicitly_disabled.contains(name) {
            return None;
        }
        if let Some(existing) = state.providers.get(name) {
            return Some(Arc::clone(&existing.adapter));
        }
        Self::register(&mut state, name, Arc::clone(&adapter), Some(config_signature(&empty)));
        Some(adapter)
    }

    /// `closeProviderConnections(id, 'session-deleted')`: every registered provider drops the
    /// deleted session's connections and transport state.
    pub fn release_session(&self, session_id: &str) {
        let adapters: Vec<_> = self.state().providers.values().map(|e| Arc::clone(&e.adapter)).collect();
        for adapter in adapters {
            adapter.release_session(session_id);
        }
    }

    /// Live instances minus dev-gated providers whose option is off.
    pub fn all(&self) -> Vec<(String, Arc<dyn ProviderAdapter>)> {
        let state = self.state();
        let mut out: Vec<_> = state
            .providers
            .iter()
            .filter(|(name, _)| self.builder.available(name))
            .map(|(name, e)| (name.clone(), Arc::clone(&e.adapter)))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// The immediate form of a stored "off" decision.
    pub fn disable(&self, name: &str) -> bool {
        let id = name.trim();
        if id.is_empty() {
            return false;
        }
        let mut state = self.state();
        state.explicitly_disabled.insert(id.to_owned());
        Self::remove(&mut state, id)
    }

    /// Custom providers whose config failed to build, by name.
    pub fn init_errors(&self) -> HashMap<String, String> {
        self.state().init_errors.clone()
    }

    pub fn catalog_revision(&self) -> u64 {
        self.state().catalog_revision
    }

    /// Bumps the revision after a catalog refresh landed.
    pub fn bump_catalog_revision(&self) {
        self.state().catalog_revision += 1;
    }

    /// Whether `name`'s catalog was already fetched for its current config;
    /// records that it is now (the caller fetches it).
    pub fn claim_catalog_refresh(&self, name: &str) -> bool {
        let mut state = self.state();
        let sig = state.providers.get(name).and_then(|e| e.signature.clone());
        if state.catalog_refreshed.get(name) == Some(&sig) {
            return false;
        }
        state.catalog_refreshed.insert(name.to_owned(), sig);
        true
    }

    /// Names of the registered providers, sorted.
    pub fn names(&self) -> BTreeSet<String> {
        self.state().providers.keys().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Fake {
        usable: Mutex<bool>,
    }

    #[async_trait]
    impl ProviderBuilder for Fake {
        async fn build(&self, name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            Err(format!("no adapter for {name} in this test"))
        }
        async fn custom_key_ids(&self, _name: &str) -> Vec<String> {
            vec!["k1".into()]
        }
        fn available(&self, name: &str) -> bool {
            name != "gated"
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> bool {
            *self.usable.lock().unwrap()
        }
    }

    fn registry() -> ProviderRegistry {
        ProviderRegistry::new(Arc::new(Fake { usable: Mutex::new(true) }))
    }

    #[test]
    fn signature_ignores_key_order() {
        let a = json!({"b": 1, "a": {"y": 2, "x": [{"q": 1, "p": 2}]}});
        let b = json!({"a": {"x": [{"p": 2, "q": 1}], "y": 2}, "b": 1});
        assert_eq!(config_signature(&a), config_signature(&b));
        assert_ne!(config_signature(&a), config_signature(&json!({"b": 2})));
    }

    #[tokio::test]
    async fn an_empty_registry_refuses_init_with_the_code() {
        let r = registry();
        let cfg = json!({"gated": {"enabled": true}, "off": {"enabled": false}});
        let err = r.init_providers(cfg.as_object().unwrap()).await.unwrap_err();
        assert_eq!(err.code, Some(NO_ENABLED_PROVIDERS));
        assert_eq!(err.message, "[provider] no provider is enabled");
    }

    #[tokio::test]
    async fn a_builder_failure_names_the_provider() {
        let r = registry();
        let cfg = json!({"anthropic": {"enabled": true}});
        let err = r.init_providers(cfg.as_object().unwrap()).await.unwrap_err();
        assert_eq!(err.message, "[provider] Failed to init \"anthropic\": no adapter for anthropic in this test");
        assert_eq!(err.code, None);
    }

    #[tokio::test]
    async fn an_invalid_custom_provider_is_isolated_and_reported() {
        let r = registry();
        let cfg = json!({"custom-1": {"enabled": true, "type": "custom", "auth": "none"}});
        let err = r.init_providers(cfg.as_object().unwrap()).await.unwrap_err();
        assert!(err.message.starts_with("[provider] no provider is enabled; invalid custom providers skipped: "));
        assert!(r.init_errors().contains_key("custom-1"));
    }

    /// Builds only when released, so a test can act while a build is awaited.
    struct Gated {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    #[async_trait]
    impl ProviderBuilder for Gated {
        async fn build(&self, _name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            self.entered.notify_one();
            self.release.notified().await;
            Ok(crate::registry::multiwire::tests::refusing("t", 400, "x"))
        }
        async fn custom_key_ids(&self, _name: &str) -> Vec<String> {
            Vec::new()
        }
        fn available(&self, _name: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> bool {
            true
        }
    }

    #[tokio::test]
    async fn a_disable_during_a_lazy_build_is_not_undone() {
        let gate = Arc::new(Gated { entered: tokio::sync::Notify::new(), release: tokio::sync::Notify::new() });
        let r = Arc::new(ProviderRegistry::new(gate.clone()));
        let lookup = tokio::spawn({
            let r = Arc::clone(&r);
            async move { r.get("anthropic-oauth").await.is_some() }
        });
        gate.entered.notified().await;
        r.disable("anthropic-oauth");
        gate.release.notify_one();
        assert!(!lookup.await.unwrap(), "a provider turned off mid-build is not handed out");
        assert!(r.registered("anthropic-oauth").is_none());
    }

    /// An adapter that notes each released session.
    struct Releasing {
        name: String,
        inner: Arc<dyn ProviderAdapter>,
        released: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl ProviderAdapter for Releasing {
        fn id(&self) -> &mixdog_protocol::ProviderId {
            self.inner.id()
        }
        fn codec(&self) -> &dyn mixdog_core_api::domain::provider::WireCodec {
            self.inner.codec()
        }
        fn retry_policy(&self) -> &mixdog_core_api::domain::retry::RetryPolicy {
            self.inner.retry_policy()
        }
        fn keepalive(&self) -> &mixdog_core_api::domain::keepalive::KeepaliveSchedule {
            self.inner.keepalive()
        }
        async fn attempt(
            &self,
            request: Arc<mixdog_core_api::domain::provider::ModelRequest>,
        ) -> Result<Box<dyn mixdog_core_api::domain::provider::ModelStream>, mixdog_core_api::domain::provider::ProviderError> {
            self.inner.attempt(request).await
        }
        fn release_session(&self, session_id: &str) {
            self.released.lock().unwrap().push(format!("{}:{session_id}", self.name));
        }
    }

    struct Releasers(Arc<Mutex<Vec<String>>>);

    #[async_trait]
    impl ProviderBuilder for Releasers {
        async fn build(&self, name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            let inner = crate::registry::multiwire::tests::refusing(name, 400, "x");
            Ok(Arc::new(Releasing { name: name.to_owned(), inner, released: self.0.clone() }))
        }
        async fn custom_key_ids(&self, _name: &str) -> Vec<String> {
            Vec::new()
        }
        fn available(&self, _name: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> bool {
            false
        }
    }

    struct NoPrice;

    impl crate::registry::accounting::UsagePricing for NoPrice {
        fn price_usage(&self, _: &crate::catalog::UsageArgs) -> crate::catalog::PricedUsage {
            unreachable!("nothing is sent")
        }
    }

    /// A deleted session's connections go from every registered provider, through the
    /// accounting wrapper.
    #[tokio::test]
    async fn a_released_session_reaches_every_registered_provider() {
        let released: Arc<Mutex<Vec<String>>> = Arc::default();
        let deps = crate::registry::accounted::AccountingDeps::new(Arc::new(NoPrice), Arc::new(|| None));
        let r = ProviderRegistry::new(Arc::new(Releasers(released.clone()))).with_accounting(deps);
        let cfg = json!({"anthropic": {"enabled": true}, "openai": {"enabled": true}});
        r.init_providers(cfg.as_object().unwrap()).await.unwrap();
        r.release_session("sess_gone");
        let mut seen = released.lock().unwrap().clone();
        seen.sort();
        assert_eq!(seen, ["anthropic:sess_gone", "openai:sess_gone"]);
    }

    #[tokio::test]
    async fn an_oauth_name_without_a_credential_or_after_a_decision_stays_absent() {
        let r = ProviderRegistry::new(Arc::new(Fake { usable: Mutex::new(false) }));
        assert!(r.get("anthropic-oauth").await.is_none());
        assert!(r.get("opencode-go").await.is_none());
        assert!(r.get("gated").await.is_none());
        assert!(!r.disable("  "));
    }
}