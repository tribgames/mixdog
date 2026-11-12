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
use crate::accounts::CredentialState;
use crate::catalog::AdapterRows;
use crate::catalog::CachedModelInfo;
use crate::catalog::ListedRows;
use crate::catalog::RouteProvider;
use mixdog_protocol::ProviderId;
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

    /// The adapter-owned `getCachedModelInfo` of the provider built under `name`, for a provider whose Node class has
    /// one; `None` for a class without it (`lookupModelMeta` then never asks it for a stored row).
    fn cached_model_info(&self, _name: &str) -> Option<Arc<dyn CachedModelInfo>> {
        None
    }

    /// Ids of a custom provider's additional keys (`customProviderKeyIds`). A roster that was read
    /// and cannot be used lists none (Node); `Err` only when the read never ran, which fails the
    /// build: an empty list would rebuild the provider without its additional keys.
    async fn custom_key_ids(&self, name: &str) -> Result<Vec<String>, String>;

    /// Whether a dev-gated provider is on (`providerAvailable`).
    fn available(&self, name: &str) -> bool;

    /// Whether an OAuth provider's stored credential reads as present. `Err` only when the check
    /// never ran: that is neither "present" nor "missing".
    async fn oauth_credentials_usable(&self, name: &str) -> Result<bool, String>;

    /// `oauthCredentialProbeState`: the credential as present, absent (a logout, or a dev-gated
    /// provider that is off) or unreadable (never a logout). The default reads the yes/no check;
    /// a builder that can tell an unreadable file from a missing one overrides it.
    async fn oauth_credential_state(&self, name: &str) -> Result<CredentialState, String> {
        Ok(if self.oauth_credentials_usable(name).await? { CredentialState::Present } else { CredentialState::Absent })
    }

    /// Until when an OAuth provider's present credential stays a sign-in (epoch ms), when that moment is finite and
    /// ahead (`observeOAuthCredentialExpiry`): the loaded config's `enabled` turns then with no file changing.
    async fn oauth_credential_expiry(&self, _name: &str) -> Option<f64> {
        None
    }

    /// The files the OAuth probes read (`[providerAccountsPath(), ...oauthCredentialFiles()]`): a change of any is a
    /// change of the loaded config.
    fn credential_inputs(&self) -> Vec<std::path::PathBuf> {
        Vec::new()
    }
}

struct Entry {
    adapter: Arc<dyn ProviderAdapter>,
    /// `None`: never matches, so the next sync rebuilds it.
    signature: Option<String>,
    /// Which registration this is: every `register` takes the next one.
    generation: u64,
}

#[derive(Default)]
struct State {
    providers: HashMap<String, Entry>,
    /// The last generation handed to an entry.
    generation: u64,
    init_errors: HashMap<String, String>,
    explicitly_disabled: HashSet<String>,
    catalog_revision: u64,
    /// `_lastAppliedSig`: the signature of the config the last successful `init_providers` applied; `None` once a
    /// provider has been removed since.
    last_applied: Option<String>,
    /// The catalog epoch: moves whenever an apply or a lazy registration changes the provider set (an instance
    /// registered, rebuilt or removed), which is when Node drops its memoized startup catalog refresh
    /// (`_startupCatalogRefreshPromise = null`, registry.mjs:440,458,479); `disable` keeps it, as `disableProvider` does.
    refresh_epoch: u64,
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
    /// Latches `true` at the first initialization that applied a config (`providersInitialized`).
    ready: tokio::sync::watch::Sender<bool>,
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

/// How a build that found no account words its reason (`AntigravityAuth::current`).
const NOT_SIGNED_IN: &str = "not signed in";

fn is_custom(name: &str, cfg: &Value) -> bool {
    cfg.get("type").and_then(Value::as_str) == Some("custom") && name.starts_with("custom-")
}

fn canonical(name: &str) -> &str {
    RETIRED_PROVIDER_ALIASES.iter().find(|(old, _)| *old == name).map_or(name, |(_, new)| new)
}

impl ProviderRegistry {
    pub fn new(builder: Arc<dyn ProviderBuilder>) -> Self {
        Self {
            builder,
            accounting: None,
            state: Mutex::new(State::default()),
            apply: tokio::sync::Semaphore::new(1),
            ready: tokio::sync::watch::channel(false).0,
        }
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
        *self.ready.borrow()
    }

    /// Resolves once an initialization by the owning runtime has first applied a config, at once
    /// when one already has; never starts one (`providersInitialized`).
    pub async fn wait_initialized(&self) {
        // The sender lives as long as `self`, so the wait ends only by the latch.
        let _ = self.ready.subscribe().wait_for(|ready| *ready).await;
    }

    /// Adds a custom provider's additional key ids to its entry (and so its
    /// reuse signature): a save that changes them rebuilds the provider.
    ///
    /// `Err` when a key-id read never ran: the apply then changes nothing.
    async fn with_custom_key_ids(&self, config: &Map<String, Value>) -> Result<Map<String, Value>, RegistryError> {
        let mut out = config.clone();
        for (name, cfg) in config {
            if !is_custom(name, cfg) || cfg.get("auth").and_then(Value::as_str) == Some("none") {
                continue;
            }
            let ids = self.builder.custom_key_ids(name).await.map_err(RegistryError::plain)?;
            if ids.is_empty() {
                continue;
            }
            let mut next = cfg.clone();
            if let Some(o) = next.as_object_mut() {
                o.insert(CUSTOM_KEY_IDS.into(), Value::Array(ids.into_iter().map(Value::String).collect()));
            }
            out.insert(name.clone(), next);
        }
        Ok(out)
    }

    /// Ensures the providers `config` enables are registered (additive). A
    /// registered one is left as it is. Errors with `NO_ENABLED_PROVIDERS`
    /// (Node's "all providers disabled" refusal) when no entry of the config is registered afterwards
    /// and no OAuth instance is preserved.
    pub async fn init_providers(&self, config: &Map<String, Value>) -> Result<(), RegistryError> {
        // `_initProvidersUnsynchronized`: an empty config never clears (or settles) the registry, whatever it
        // holds. Checked first: with providers registered the nothing-pending shortcut below would accept it.
        if config.is_empty() {
            return Err(RegistryError {
                message: "[provider] initProviders called with empty config — refusing to clear registry".into(),
                code: Some(NO_ENABLED_PROVIDERS),
            });
        }
        let plan = Plan { config: self.with_custom_key_ids(config).await?, rebuild: false, add: true, is_off: None };
        let applied = config_signature(&Value::Object(plan.config.clone()));
        let nothing_pending = !self.state().providers.is_empty() && self.pending(&plan).is_empty();
        if nothing_pending {
            self.refuse_if_nothing_left(&plan.config, &[]).await?;
            self.note_applied(applied);
            self.ready.send_replace(true);
            return Ok(());
        }
        self.apply_plan(plan).await?;
        self.note_applied(applied);
        // Only an initialization latches readiness (`initProviders`' tracked promise); the sync
        // of the record (`sync_providers`) does not.
        self.ready.send_replace(true);
        Ok(())
    }

    /// `if (_lastAppliedSig !== sig) _providerCatalogRevision += 1; _lastAppliedSig = sig` (`initProviders`, registry.mjs:312):
    /// an init of a config other than the last applied one moves the catalog revision even when it builds nothing.
    fn note_applied(&self, signature: String) {
        let mut state = self.state();
        if state.last_applied.as_deref() != Some(signature.as_str()) {
            state.catalog_revision += 1;
        }
        state.last_applied = Some(signature);
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
        let config = self.with_custom_key_ids(record).await?;
        self.apply_plan(Plan { config, rebuild: true, add: false, is_off }).await
    }

    /// The registered OAuth providers whose credential decides the guard of `refuse_if_nothing_left`;
    /// `None` when an entry of the config is registered, so there is nothing to refuse. A separate
    /// function so the registry lock is never part of the awaiting future.
    fn oauth_to_check(&self, config: &Map<String, Value>) -> Option<Vec<&'static str>> {
        let state = self.state();
        if config.iter().any(|(name, cfg)| self.enabled_for_init(name, cfg) && state.providers.contains_key(name)) {
            return None;
        }
        Some(OAUTH_PROVIDER_NAMES.iter().copied().filter(|name| state.providers.contains_key(*name)).collect())
    }

    /// An entry an init admits: enabled, available (a dev-gated provider is on) and not retired.
    fn enabled_for_init(&self, name: &str, cfg: &Value) -> bool {
        cfg.get("enabled").and_then(Value::as_bool) == Some(true)
            && self.builder.available(name)
            && !RETIRED_PROVIDER_ALIASES.iter().any(|(old, _)| *old == name)
    }

    /// The guard of `_initProvidersUnsynchronized`: no entry of the config is registered and no OAuth
    /// instance is preserved, so the init refuses rather than leave the registry dark. An OAuth
    /// instance not in the config is kept unless its credential reads absent (a logout); one the
    /// config switches off is kept only when that is a probe that could not read
    /// (`credentialProbeUnavailable`), never for an explicit opt-out.
    async fn refuse_if_nothing_left(&self, config: &Map<String, Value>, skipped: &[String]) -> Result<(), RegistryError> {
        let Some(registered_oauth) = self.oauth_to_check(config) else {
            return Ok(());
        };
        for name in registered_oauth {
            let opted_out = config.get(name).is_some_and(|cfg| {
                cfg.get("enabled").and_then(Value::as_bool) != Some(true)
                    && cfg.get("credentialProbeUnavailable").and_then(Value::as_bool) != Some(true)
            });
            if opted_out {
                continue;
            }
            let probe = self.builder.oauth_credential_state(name).await.unwrap_or(CredentialState::Unreadable);
            if probe != CredentialState::Absent {
                return Ok(());
            }
        }
        let tail = if skipped.is_empty() { String::new() } else { format!("; invalid custom providers skipped: {}", skipped.join("; ")) };
        Err(RegistryError {
            message: format!("[provider] all providers disabled in config — refusing to clear registry{tail}"),
            code: Some(NO_ENABLED_PROVIDERS),
        })
    }

    /// Entries of the plan that need a build: missing ones when it adds,
    /// changed ones when it rebuilds.
    fn pending(&self, plan: &Plan) -> Vec<(String, Value, Option<String>)> {
        let state = self.state();
        let mut out = Vec::new();
        for (name, cfg) in &plan.config {
            if !self.enabled_for_init(name, cfg) {
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
                    // reported, the rest of the registry builds. So is an account
                    // provider nobody signed in to: Node builds that one without its
                    // account (`antigravity-oauth.mjs` reads the tokens per request),
                    // while this adapter is bound to the account's project and has
                    // nothing to be built from. A later plan builds it once signed in.
                    if is_custom(&name, &cfg) || msg.starts_with(NOT_SIGNED_IN) {
                        built.push((name, Err(error)));
                    } else {
                        return Err(RegistryError::plain(error));
                    }
                }
            }
        }
        let skipped = self.settle(&plan, built);
        if plan.add {
            self.refuse_if_nothing_left(&plan.config, &skipped).await?;
        }
        Ok(())
    }

    /// Registers what a plan built and removes what it turned off, under the registry lock; returns
    /// the invalid custom providers it skipped. Sync, so the guard (not `Send`) is out of scope before
    /// the credential probe awaits: an explicit `drop` in an async fn does not end its liveness for the
    /// compiler's `Send` analysis.
    fn settle(&self, plan: &Plan, built: Vec<(String, Result<(Arc<dyn ProviderAdapter>, Option<String>), String>)>) -> Vec<String> {
        let mut skipped = Vec::new();
        let mut state = self.state();
        for (name, result) in built {
            match result {
                Ok((adapter, sig)) => Self::register(&mut state, &name, adapter, sig),
                Err(error) => {
                    Self::remove(&mut state, &name);
                    state.init_errors.insert(name, error.clone());
                    mixdog_rt::node_stderr!("{error} (provider skipped; fix its configuration)");
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
        skipped
    }

    fn register(state: &mut State, name: &str, adapter: Arc<dyn ProviderAdapter>, signature: Option<String>) {
        state.generation += 1;
        let generation = state.generation;
        state.providers.insert(name.to_owned(), Entry { adapter, signature, generation });
        state.explicitly_disabled.remove(name);
        state.init_errors.remove(name);
        state.catalog_revision += 1;
        state.refresh_epoch += 1;
    }

    /// Removes `name` as an apply does, which opens a new catalog epoch (`_startupCatalogRefreshPromise = null`).
    fn remove(state: &mut State, name: &str) -> bool {
        let had = Self::unregister(state, name);
        if had {
            state.refresh_epoch += 1;
        }
        had
    }

    /// Removes `name`, the catalog epoch kept.
    fn unregister(state: &mut State, name: &str) -> bool {
        state.init_errors.remove(name);
        let had = state.providers.remove(name).is_some();
        if had {
            state.catalog_revision += 1;
            // `disableProvider`: the live registry no longer reflects the last applied config.
            state.last_applied = None;
        }
        had
    }

    /// The instance registered under `name` right now, with no lazy
    /// registration (`registeredProvider`).
    pub fn registered(&self, name: &str) -> Option<Arc<dyn ProviderAdapter>> {
        self.state().providers.get(name).map(|e| Arc::clone(&e.adapter))
    }

    /// The registration of `name` that is live now. A holder of an earlier request compares it with
    /// [`generation_of`](Self::generation_of) taken at capture: a provider registered again (a sync
    /// that rebuilt it, a removal) differs, as `registeredProvider(name) !== captured` does.
    pub fn generation(&self, name: &str) -> Option<u64> {
        self.state().providers.get(name).map(|e| e.generation)
    }

    /// The registration `adapter` (an instance handed out by this registry) is live under, `None`
    /// when it is no longer registered.
    pub fn generation_of(&self, adapter: &Arc<dyn ProviderAdapter>) -> Option<u64> {
        self.state().providers.values().find(|e| Arc::ptr_eq(&e.adapter, adapter)).map(|e| e.generation)
    }

    /// `typeof registeredProvider(name)?.sendCacheWarm === 'function'`: the registered provider
    /// (through its accounting wrapper) has a cache-warm mode (`WarmRequest::has_warm_mode`).
    pub fn has_warm_mode(&self, name: &str) -> bool {
        self.registered(name).is_some_and(|adapter| adapter.cache_warm().is_some())
    }

    /// The provider for `requested` (`getProvider`): a retired id maps to its
    /// replacement; an OAuth provider whose credential reads as present and
    /// that no decision turned off is registered on the spot, under the
    /// signature of the empty config it is built from.
    ///
    /// `None` also covers a lookup that could not be answered (see [`try_get`](Self::try_get));
    /// callers that can report an error use that one.
    pub async fn get(&self, requested: &str) -> Option<Arc<dyn ProviderAdapter>> {
        self.try_get(requested).await.ok().flatten()
    }

    /// [`get`](Self::get), but `Err` when the credential check never ran: the provider is then
    /// neither registered nor reported missing.
    pub async fn try_get(&self, requested: &str) -> Result<Option<Arc<dyn ProviderAdapter>>, RegistryError> {
        let name = canonical(requested);
        if !self.builder.available(name) {
            return Ok(None);
        }
        if let Some(adapter) = self.registered(name) {
            return Ok(Some(adapter));
        }
        if !OAUTH_PROVIDER_NAMES.contains(&name) || self.state().explicitly_disabled.contains(name) {
            return Ok(None);
        }
        if !self.builder.oauth_credentials_usable(name).await.map_err(RegistryError::plain)? {
            return Ok(None);
        }
        let empty = Value::Object(Map::new());
        let Ok(built) = self.builder.build(name, &empty).await else { return Ok(None) };
        let adapter = self.accounted(name, built);
        // Both gates again after the await (Node): the credential may have been
        // removed, or the provider disabled, while the build was in flight. The
        // disable check and the registration share one lock, so a `disable`
        // cannot slip between them.
        if !self.builder.oauth_credentials_usable(name).await.map_err(RegistryError::plain)? {
            return Ok(None);
        }
        let mut state = self.state();
        if state.explicitly_disabled.contains(name) {
            return Ok(None);
        }
        if let Some(existing) = state.providers.get(name) {
            return Ok(Some(Arc::clone(&existing.adapter)));
        }
        Self::register(&mut state, name, Arc::clone(&adapter), Some(config_signature(&empty)));
        Ok(Some(adapter))
    }

    /// `closeProviderConnections(id, 'session-deleted')`: every registered provider drops the
    /// deleted session's connections and transport state.
    pub fn release_session(&self, session_id: &str) {
        let adapters: Vec<_> = self.state().providers.values().map(|e| Arc::clone(&e.adapter)).collect();
        for adapter in adapters {
            adapter.release_session(session_id);
        }
    }

    /// `getProvider(name)` as the route-meta memo reads it: the registered adapter's listing, and its stored-row
    /// capability when its class has one.
    pub fn route_provider(&self, name: &str) -> Option<RouteProvider> {
        if !self.builder.available(name) {
            return None;
        }
        let adapter = Arc::clone(&self.state().providers.get(name)?.adapter);
        let listing = adapter.models().is_some().then(|| {
            Arc::new(AdapterRows { provider: ProviderId::from(name), adapter: Arc::clone(&adapter) }) as Arc<dyn ListedRows>
        });
        Some(RouteProvider { cached: self.builder.cached_model_info(name), listing })
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
        // `disableProvider` keeps the startup catalog refresh of the epoch (registry.mjs:621-632): the next readiness call
        // joins it instead of starting one, and the refreshes after it no longer ask this provider.
        Self::unregister(&mut state, id)
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

    /// The catalog epoch: a startup catalog refresh belongs to the epoch it began in, and a new one is due once the
    /// provider set has changed since.
    pub fn catalog_refresh_epoch(&self) -> u64 {
        self.state().refresh_epoch
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
        async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
            Ok(vec!["k1".into()])
        }
        fn available(&self, name: &str) -> bool {
            name != "gated"
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
            Ok(*self.usable.lock().unwrap())
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
        assert_eq!(err.message, "[provider] all providers disabled in config — refusing to clear registry");
    }

    #[tokio::test]
    async fn a_builder_failure_names_the_provider() {
        let r = registry();
        let cfg = json!({"anthropic": {"enabled": true}});
        let err = r.init_providers(cfg.as_object().unwrap()).await.unwrap_err();
        assert_eq!(err.message, "[provider] Failed to init \"anthropic\": no adapter for anthropic in this test");
        assert_eq!(err.code, None);
    }

    /// An account provider nobody signed in to is left out and the others build (Node builds it without its account).
    struct OneUnsigned;

    #[async_trait]
    impl ProviderBuilder for OneUnsigned {
        async fn build(&self, name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            if name == "antigravity-oauth" {
                return Err("not signed in — run /login".into());
            }
            Ok(crate::registry::multiwire::tests::refusing(name, 400, "x"))
        }
        async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _name: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn an_account_provider_nobody_signed_in_to_is_left_out() {
        let r = ProviderRegistry::new(Arc::new(OneUnsigned));
        let cfg = json!({"anthropic": {"enabled": true}, "antigravity-oauth": {"enabled": true}});
        r.init_providers(cfg.as_object().unwrap()).await.unwrap();
        let state = r.state();
        assert!(state.providers.contains_key("anthropic"));
        assert!(!state.providers.contains_key("antigravity-oauth"));
        assert_eq!(state.init_errors["antigravity-oauth"], "[provider] Failed to init \"antigravity-oauth\": not signed in — run /login");
    }

    #[tokio::test]
    async fn an_invalid_custom_provider_is_isolated_and_reported() {
        let r = registry();
        let cfg = json!({"custom-1": {"enabled": true, "type": "custom", "auth": "none"}});
        let err = r.init_providers(cfg.as_object().unwrap()).await.unwrap_err();
        assert!(err.message.starts_with("[provider] all providers disabled in config — refusing to clear registry; invalid custom providers skipped: "));
        assert!(r.init_errors().contains_key("custom-1"));
    }

    /// A builder whose reads never run.
    struct Unrun;

    #[async_trait]
    impl ProviderBuilder for Unrun {
        async fn build(&self, name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            unreachable!("nothing is built from an unread roster: {name}")
        }
        async fn custom_key_ids(&self, name: &str) -> Result<Vec<String>, String> {
            Err(format!("The additional API keys of {name} could not be read: its lane did not run the call."))
        }
        fn available(&self, _name: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, name: &str) -> Result<bool, String> {
            Err(format!("The sign-in of {name} could not be read: its lane did not run the call."))
        }
    }

    /// A read that never ran fails the apply and the lookup: nothing is registered, and no
    /// provider is reported as missing or as an init error.
    #[tokio::test]
    async fn an_unrun_read_fails_the_build_and_registers_nothing() {
        let r = ProviderRegistry::new(Arc::new(Unrun));
        let cfg = json!({"custom-1": {"enabled": true, "type": "custom", "auth": "key"}});
        let err = r.init_providers(cfg.as_object().unwrap()).await.unwrap_err();
        assert!(err.message.contains("could not be read"), "{}", err.message);
        assert_eq!(err.code, None);
        assert!(r.sync_providers(cfg.as_object().unwrap(), None).await.is_err());
        assert!(r.names().is_empty());
        assert!(r.init_errors().is_empty());
        assert!(r.try_get("anthropic-oauth").await.err().unwrap().message.contains("could not be read"));
        assert!(r.get("anthropic-oauth").await.is_none());
        assert!(r.names().is_empty());
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
        async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _name: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
            Ok(true)
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
        fn release_send(&self, group: &str) {
            self.inner.release_send(group);
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
        async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _name: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
            Ok(false)
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

    /// Builds every name but the invalid custom one the golden's `invalid_custom` config names.
    struct Scripted;

    #[async_trait]
    impl ProviderBuilder for Scripted {
        async fn build(&self, name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            if name == "custom-bad" {
                return Err("unsupported protocol".into());
            }
            Ok(crate::registry::multiwire::tests::refusing(name, 400, "x"))
        }
        async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _name: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
            Ok(false)
        }
    }

    /// Builds every name; its OAuth credential reads as the file the recording used.
    struct Probing(CredentialState);

    #[async_trait]
    impl ProviderBuilder for Probing {
        async fn build(&self, name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            Ok(crate::registry::multiwire::tests::refusing(name, 400, "x"))
        }
        async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _name: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
            Ok(self.0 != CredentialState::Absent)
        }
        async fn oauth_credential_state(&self, _name: &str) -> Result<CredentialState, String> {
            Ok(self.0)
        }
    }

    /// An init whose config leaves nothing registered is refused with Node's text and code, unless a
    /// registered OAuth provider is preserved (`fixtures/provider-refusal/golden.json`, from the real
    /// `initProviders`): one the config does not name or whose probe could not read, while its
    /// credential is not a logout; an explicit opt-out is never preserved.
    #[tokio::test]
    async fn the_refusal_when_nothing_is_left_is_nodes() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/provider-refusal/golden.json")).expect("fixture");
        let config = |name: &str| golden["configs"][name].as_object().expect("config").clone();
        for scenario in golden["scenarios"].as_array().expect("scenarios") {
            let name = scenario["name"].as_str().expect("name");
            let probe = match scenario["probe"].as_str() {
                None | Some("present") => CredentialState::Present,
                Some("absent") => CredentialState::Absent,
                Some("unreadable") => CredentialState::Unreadable,
                Some(other) => panic!("{name}: probe {other}"),
            };
            let registry = ProviderRegistry::new(Arc::new(Probing(probe)));
            if scenario["registered"] == true {
                registry.init_providers(json!({"anthropic-oauth": {"enabled": true}}).as_object().unwrap()).await.expect("the live provider registers");
            }
            for step in scenario["steps"].as_array().expect("steps") {
                let result = registry.init_providers(&config(step["config"].as_str().expect("config"))).await;
                match (step["outcome"].as_str().expect("outcome"), result) {
                    ("ok", Ok(())) => {}
                    ("refused", Err(error)) => {
                        assert_eq!(json!(error.message), step["message"], "{name}: {step}");
                        assert_eq!(error.code, Some(NO_ENABLED_PROVIDERS), "{name}: {step}");
                    }
                    (outcome, result) => panic!("{name}: Node {outcome}, Rust {result:?}: {step}"),
                }
            }
        }
    }
    /// Whether `wait_initialized` has resolved, with no waiting: the task gets event-loop turns,
    /// not wall time.
    async fn resolved(task: &tokio::task::JoinHandle<()>) -> bool {
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }
        task.is_finished()
    }

    /// Node's `providersInitialized()` (`fixtures/provider-ready/golden.json`): the wait resolves at
    /// the first initialization that applied a config, a refused one leaves it pending, and a later
    /// refusal never unsettles it.
    #[tokio::test]
    async fn the_wait_resolves_at_the_first_applied_config_as_node_does() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/provider-ready/golden.json")).expect("fixture");
        for scenario in golden["scenarios"].as_array().expect("scenarios") {
            let name = scenario["name"].as_str().expect("name");
            let registry = Arc::new(ProviderRegistry::new(Arc::new(Scripted)));
            let probe = |registry: &Arc<ProviderRegistry>| {
                let registry = Arc::clone(registry);
                tokio::spawn(async move { registry.wait_initialized().await })
            };
            assert_eq!(resolved(&probe(&registry)).await, scenario["initial"], "{name}: before any step");
            let mut waiter = None;
            for step in scenario["steps"].as_array().expect("steps") {
                match step["op"].as_str().expect("op") {
                    "wait" => waiter = Some(probe(&registry)),
                    _ => {
                        let config = golden["configs"][step["config"].as_str().expect("config")].as_object().expect("config").clone();
                        let outcome = if registry.init_providers(&config).await.is_ok() { "ok" } else { "refused" };
                        assert_eq!(outcome, step["outcome"], "{name}: {step}");
                    }
                }
                assert_eq!(resolved(&probe(&registry)).await, step["ready"], "{name}: {step}");
                if let Some(waiter) = &waiter {
                    assert_eq!(resolved(waiter).await, step["waiter"], "{name}: {step}");
                }
            }
        }
    }

    /// Node latches only in `initProviders`: applying the record (which has no Node counterpart
    /// that latches) leaves the wait pending, and the first init after it resolves it.
    #[tokio::test]
    async fn applying_the_record_does_not_latch_readiness() {
        let r = Arc::new(ProviderRegistry::new(Arc::new(Scripted)));
        let cfg = json!({"custom-ok": {"enabled": true}});
        r.sync_providers(cfg.as_object().unwrap(), None).await.unwrap();
        let waiting = {
            let r = Arc::clone(&r);
            tokio::spawn(async move { r.wait_initialized().await })
        };
        assert!(!resolved(&waiting).await);
        r.init_providers(cfg.as_object().unwrap()).await.unwrap();
        assert!(resolved(&waiting).await);
    }

    /// A registration is told from the next one: a sync that rebuilds the provider, or a removal,
    /// leaves the instance a request was captured on without its generation.
    #[tokio::test]
    async fn a_replaced_provider_has_a_new_generation() {
        let r = ProviderRegistry::new(Arc::new(Scripted));
        let with = |n: u32| json!({"openai": {"enabled": true, "n": n}}).as_object().unwrap().clone();
        r.init_providers(&with(1)).await.unwrap();
        let first = r.registered("openai").unwrap();
        let held = r.generation_of(&first).expect("registered");
        assert_eq!(r.generation("openai"), Some(held));
        r.sync_providers(&with(1), None).await.unwrap();
        assert_eq!(r.generation("openai"), Some(held), "an unchanged config keeps the instance");
        r.sync_providers(&with(2), None).await.unwrap();
        assert_ne!(r.generation("openai"), Some(held));
        assert_eq!(r.generation_of(&first), None, "the replaced instance is no longer registered");
        let second = r.registered("openai").unwrap();
        assert_eq!(r.generation_of(&second), r.generation("openai"));
        assert!(r.disable("openai"));
        assert_eq!(r.generation("openai"), None);
    }

    /// A provider with a cache-warm mode: it never sends.
    struct Warming(Arc<dyn ProviderAdapter>);

    #[async_trait]
    impl mixdog_core_api::domain::cache_warm::CacheWarmSend for Warming {
        async fn send_cache_warm(
            &self,
            _: &mixdog_core_api::domain::provider::ModelRequest,
            _: &mixdog_core_api::domain::cache_warm::WarmContext<'_>,
            _: &tokio_util::sync::CancellationToken,
            _: &mut (dyn for<'u> FnMut(&'u mixdog_core_api::domain::cache_warm::WarmUsage) + Send),
        ) -> Result<mixdog_core_api::domain::cache_warm::WarmUsage, mixdog_core_api::domain::cache_warm::WarmFailure> {
            unreachable!("nothing is sent")
        }
    }

    #[async_trait]
    impl ProviderAdapter for Warming {
        fn release_send(&self, group: &str) {
            self.0.release_send(group);
        }
        fn id(&self) -> &mixdog_protocol::ProviderId {
            self.0.id()
        }
        fn codec(&self) -> &dyn mixdog_core_api::domain::provider::WireCodec {
            self.0.codec()
        }
        fn retry_policy(&self) -> &mixdog_core_api::domain::retry::RetryPolicy {
            self.0.retry_policy()
        }
        fn keepalive(&self) -> &mixdog_core_api::domain::keepalive::KeepaliveSchedule {
            self.0.keepalive()
        }
        fn cache_warm(&self) -> Option<&dyn mixdog_core_api::domain::cache_warm::CacheWarmSend> {
            Some(self)
        }
        async fn attempt(
            &self,
            request: Arc<mixdog_core_api::domain::provider::ModelRequest>,
        ) -> Result<Box<dyn mixdog_core_api::domain::provider::ModelStream>, mixdog_core_api::domain::provider::ProviderError> {
            self.0.attempt(request).await
        }
    }

    struct Warmers;

    #[async_trait]
    impl ProviderBuilder for Warmers {
        async fn build(&self, name: &str, _config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            let inner = crate::registry::multiwire::tests::refusing(name, 400, "x");
            Ok(if name == "anthropic" { Arc::new(Warming(inner)) } else { inner })
        }
        async fn custom_key_ids(&self, _name: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, _name: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _name: &str) -> Result<bool, String> {
            Ok(false)
        }
    }

    /// Only a provider with a cache-warm mode warms, behind the accounting wrapper too; an
    /// unregistered name does not.
    #[tokio::test]
    async fn only_a_provider_with_a_warm_mode_warms_through_the_wrapper() {
        let deps = crate::registry::accounted::AccountingDeps::new(Arc::new(NoPrice), Arc::new(|| None));
        let r = ProviderRegistry::new(Arc::new(Warmers)).with_accounting(deps);
        let cfg = json!({"anthropic": {"enabled": true}, "openai": {"enabled": true}});
        r.init_providers(cfg.as_object().unwrap()).await.unwrap();
        assert!(r.has_warm_mode("anthropic"));
        assert!(!r.has_warm_mode("openai"));
        assert!(!r.has_warm_mode("gemini"));
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