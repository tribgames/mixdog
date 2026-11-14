//! Provider readiness, as Node's `createProviderReadiness`
//! (`session-runtime/provider-readiness.mjs`) runs it: provider initialization
//! is a single flight per normalized provider config, and its settled result
//! is kept, so a repeat call with the same config starts nothing. A change
//! that invalidates the caches clears the flights and supersedes any
//! initialization still running: that one never writes the registry, and its
//! callers are answered by a replay on the latest config (with the providers
//! the superseded request turned on). Keychain prewarming belongs to the
//! registry's key store, which the builder reads.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::OnceLock;
use std::sync::PoisonError;

use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use serde_json::Map;
use serde_json::Value;

use mixdog_protocol::ProviderId;

use super::service::CatalogService;
use crate::registry::providers::ProviderRegistry;
use crate::registry::providers::RegistryError;
use crate::registry::providers::config_signature;

type Flight = Shared<BoxFuture<'static, Result<(), RegistryError>>>;

#[derive(Default)]
struct Gate {
    flights: HashMap<String, Flight>,
    /// Advances whenever the flights are cleared.
    generation: u64,
    closed: bool,
    /// The runtime's own `config.providers`.
    providers: Map<String, Value>,
}

type Done = Shared<BoxFuture<'static, ()>>;

/// The 24 h catalog timer (`CATALOG_REFRESH_INTERVAL_MS`, registry.mjs:92).
pub const CATALOG_REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// One startup catalog refresh (`_startupCatalogRefreshPromise`): it belongs to the registry's catalog epoch it began in.
#[derive(Clone)]
struct Startup {
    epoch: u64,
    id: u64,
    done: Done,
}

/// The catalog refresh state. Node changes it in single synchronous steps: whatever a step checks still holds when it
/// acts. Here other threads run in between, so every change is decided from what is read in the same critical section
/// of this lock that makes it, and a task that acts later acts only while the identity it was made for still holds:
/// - a startup refresh is installed for the registry epoch read under the lock that installs it, so installs follow
///   the epoch forward and each epoch gets one refresh (`startup_refresh`);
/// - a timer fires only when, under the lock, it is still the armed one and its not-before boundary has passed, and
///   the full refresh starts in that same critical section (`arm_next_refresh`);
/// - the pending flag is owned by the id of the latest observed refresh, set in the critical section that observes
///   it, and cleared by one compare-and-set on that id (`observe_startup_refresh`, `CatalogService::settle_startup_refresh`).
#[derive(Default)]
struct Refreshes {
    startup: Option<Startup>,
    next_id: u64,
    /// `rt.startupProviderCatalogRefreshObserved`: the startup refresh this runtime attached its completion to.
    observed: Option<u64>,
    /// The completion handling of each observed refresh still running, by refresh id.
    completions: Vec<(u64, Done)>,
    /// `_catalogRefreshTimer`: the armed timer's id and task.
    timer: Option<(u64, tokio::task::JoinHandle<()>)>,
    next_timer: u64,
    /// `_catalogRefreshNotBefore`: no timer-driven full refresh before it.
    not_before: Option<tokio::time::Instant>,
    /// `_catalogRefreshPromise`: the full catalog refresh running now.
    full: Option<Done>,
    /// How many times the 24 h timer has fired.
    timer_fires: u64,
}

/// What else invalidateProviderCaches drops: the caches built over what the providers list (the cached
/// provider setup, the usage dashboard), which live above this crate.
pub trait CacheDrop: Send + Sync {
    fn drop_caches(&self);

    /// The drop a settled startup catalog refresh makes. Node tells its clients nothing then (no `provider-models-changed`
    /// hint): a client keeps the list it holds until its next read. By default the same drop.
    fn drop_caches_after_refresh(&self) {
        self.drop_caches();
    }
}

impl<F: Fn() + Send + Sync> CacheDrop for F {
    fn drop_caches(&self) {
        self()
    }
}

pub struct ProviderReadiness {
    registry: Arc<ProviderRegistry>,
    catalog: Arc<CatalogService>,
    gate: Mutex<Gate>,
    /// A late cell: bound once at compose, verified bound at startup (invalidation_bound).
    invalidation: OnceLock<Arc<dyn CacheDrop>>,
    /// `warmProviderModelCache({ loadSecrets: true })`, bound by the provider-models cache above this crate.
    rewarm: OnceLock<Arc<dyn Fn() + Send + Sync>>,
    refreshes: Mutex<Refreshes>,
    #[cfg(any(test, feature = "test-support"))]
    points: Mutex<HashMap<Point, Box<dyn FnOnce() + Send>>>,
}

/// The points where a thread of the refresh can be overtaken by another, at which a test runs the other side's steps
/// (`ProviderReadiness::at`). Absent from a normal build.
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Point {
    /// A startup refresh is asked for; the refresh state is not locked yet.
    StartupBeforeLock,
    /// An observed startup refresh completed; its completion has not settled the pending flag yet.
    CompletionBeforeSettle,
    /// The 24 h timer's sleep ended; it has not locked the refresh state yet.
    TimerBeforeLock,
}

#[cfg(any(test, feature = "test-support"))]
impl ProviderReadiness {
    /// Runs `steps` the next time the product reaches `point`, on the thread that reaches it, before that thread goes on.
    pub fn at(&self, point: Point, steps: impl FnOnce() + Send + 'static) {
        self.points.lock().unwrap_or_else(PoisonError::into_inner).insert(point, Box::new(steps));
    }

    fn reach(&self, point: Point) {
        let steps = self.points.lock().unwrap_or_else(PoisonError::into_inner).remove(&point);
        if let Some(steps) = steps {
            steps();
        }
    }
}

fn closing() -> RegistryError {
    RegistryError { message: "runtime is closing".into(), code: None }
}

/// The providers a request turned on that the runtime's config has off.
fn forced_providers(requested: &Map<String, Value>, base: &Map<String, Value>) -> Vec<String> {
    let enabled = |entry: Option<&Value>| entry.and_then(|e| e.get("enabled")) == Some(&Value::Bool(true));
    requested.iter().filter(|(name, entry)| enabled(Some(entry)) && !enabled(base.get(*name))).map(|(n, _)| n.clone()).collect()
}

impl ProviderReadiness {
    pub fn new(registry: Arc<ProviderRegistry>, catalog: Arc<CatalogService>) -> Arc<Self> {
        let revision = registry.clone();
        catalog.bind_revision(move || revision.catalog_revision());
        let providers = registry.clone();
        catalog.bind_providers(Arc::new(move |name| providers.route_provider(name)));
        let registered = registry.clone();
        catalog.bind_registered(move || {
            registered.all().into_iter().map(|(name, adapter)| (ProviderId::from(name.as_str()), adapter)).collect()
        });
        Arc::new(Self {
            registry,
            catalog,
            gate: Mutex::new(Gate::default()),
            invalidation: OnceLock::new(),
            rewarm: OnceLock::new(),
            refreshes: Mutex::default(),
            #[cfg(any(test, feature = "test-support"))]
            points: Mutex::default(),
        })
    }

    /// `reg.disableProvider(id)`: the immediate form of a stored decision that a provider is gone or off.
    pub fn disable_provider(&self, id: &str) {
        self.registry.disable(id);
    }

    fn refreshes(&self) -> MutexGuard<'_, Refreshes> {
        self.refreshes.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Binds the secrets-carrying re-warm a settled startup refresh starts; a second bind is refused.
    pub fn bind_rewarm(&self, rewarm: Arc<dyn Fn() + Send + Sync>) -> Result<(), Arc<dyn Fn() + Send + Sync>> {
        self.rewarm.set(rewarm)
    }

    /// `refreshProviderCatalogsOnStartup()` (registry.mjs:704-721): the refresh of the current catalog epoch, or a new
    /// one when the provider set changed since the last began (or none has). A new one arms the 24 h timer, asks every
    /// registered provider (each bounded by the listing deadline; a failure is logged and the rest go on) and moves the
    /// catalog revision when all have settled.
    fn startup_refresh(self: &Arc<Self>) -> Startup {
        #[cfg(any(test, feature = "test-support"))]
        self.reach(Point::StartupBeforeLock);
        self.startup_refresh_in(&mut self.refreshes())
    }

    /// [`Self::startup_refresh`] with the refresh state locked by the caller, which may act on the refresh it gets in
    /// the same critical section.
    fn startup_refresh_in(self: &Arc<Self>, refreshes: &mut Refreshes) -> Startup {
        // Read under the lock that installs, so no caller installs an epoch older than one installed before it.
        let epoch = self.registry.catalog_refresh_epoch();
        if let Some(startup) = refreshes.startup.as_ref().filter(|s| s.epoch == epoch) {
            return startup.clone();
        }
        self.arm_next_refresh(refreshes);
        refreshes.next_id += 1;
        // The providers registered now, read in the step that starts the refresh (registry.mjs:708).
        let sources = self.catalog.sources();
        let (catalog, registry) = (self.catalog.clone(), self.registry.clone());
        let task = mixdog_rt::spawn("catalog.startup-refresh", mixdog_rt::TaskClass::Work, async move {
            for (provider, error) in catalog.refresh_providers(&sources).await.failed {
                mixdog_rt::node_stderr!(
                    "[provider:{}] startup catalog refresh failed: {}",
                    provider.as_str(),
                    crate::oauth::carried::remembered().redact_str(&error.message)
                );
            }
            registry.bump_catalog_revision();
        });
        let done: Done = task.map(drop).boxed().shared();
        let startup = Startup { epoch, id: refreshes.next_id, done };
        refreshes.startup = Some(startup.clone());
        startup
    }

    /// `armNextCatalogRefresh()`: the full catalog refresh 24 h from now, replacing the one armed before.
    fn arm_next_refresh(self: &Arc<Self>, refreshes: &mut Refreshes) {
        if let Some((_, timer)) = refreshes.timer.take() {
            timer.abort();
        }
        refreshes.next_timer += 1;
        let id = refreshes.next_timer;
        let not_before = tokio::time::Instant::now() + CATALOG_REFRESH_INTERVAL;
        refreshes.not_before = Some(not_before);
        let this = Arc::downgrade(self);
        let task = mixdog_rt::spawn("catalog.refresh-timer", mixdog_rt::TaskClass::Work, async move {
            mixdog_rt::time::sleep_until(not_before).await;
            let Some(this) = this.upgrade() else { return };
            #[cfg(any(test, feature = "test-support"))]
            this.reach(Point::TimerBeforeLock);
            let mut refreshes = this.refreshes();
            // The abort of a replaced timer cannot stop one already past its sleep: only the armed timer fires, and only
            // past the boundary (`clearTimeout`, and `refreshCatalogs`' `Date.now() < _catalogRefreshNotBefore`).
            let armed = refreshes.timer.as_ref().is_some_and(|(armed, _)| *armed == id);
            if !armed || refreshes.not_before.is_some_and(|not_before| tokio::time::Instant::now() < not_before) {
                return;
            }
            // The timer that fired is no longer armed (`_catalogRefreshTimer = null`); the refresh arms the next.
            refreshes.timer = None;
            refreshes.timer_fires += 1;
            drop(this.start_full(&mut refreshes));
        });
        refreshes.timer = Some((id, task));
    }

    /// `refreshCatalogs()` past its boundary check (registry.mjs:738-774), as the timer and a forced refresh run it, with
    /// the refresh state locked: one at a time; it arms the next timer, refreshes the metadata tables and asks every
    /// registered provider, then moves the catalog revision.
    fn start_full(self: &Arc<Self>, refreshes: &mut Refreshes) -> Done {
        if let Some(full) = &refreshes.full {
            return full.clone();
        }
        self.arm_next_refresh(refreshes);
        // The providers registered now, read in the step that starts the refresh (registry.mjs:762).
        let sources = self.catalog.sources();
        let this = self.clone();
        let task = mixdog_rt::spawn("catalog.full-refresh", mixdog_rt::TaskClass::Work, async move {
            for (provider, error) in this.catalog.refresh_of(sources).await.failed {
                mixdog_rt::node_stderr!(
                    "[provider:{}] catalog refresh failed: {}",
                    provider.as_str(),
                    crate::oauth::carried::remembered().redact_str(&error.message)
                );
            }
            this.registry.bump_catalog_revision();
            this.refreshes().full = None;
        });
        let done: Done = task.map(drop).boxed().shared();
        refreshes.full = Some(done.clone());
        done
    }

    /// How many times the 24 h catalog timer has fired.
    pub fn catalog_timer_fires(&self) -> u64 {
        self.refreshes().timer_fires
    }

    /// What a non-forced catalog load waits for after its readiness call (`await reg().refreshProviderCatalogsOnStartup()`,
    /// catalog-load.mjs:70-72): the startup refresh of the current epoch, then the completion this runtime attached to it,
    /// which Node runs first because it was attached first.
    pub async fn join_startup_refresh(self: &Arc<Self>) {
        let startup = self.startup_refresh();
        startup.done.await;
        let completion = self.refreshes().completions.iter().find(|(id, _)| *id == startup.id).map(|(_, done)| done.clone());
        if let Some(completion) = completion {
            completion.await;
        }
    }

    /// Waits for every catalog refresh running now and the completion of each observed one (for callers that must see
    /// their end).
    pub async fn settle_refreshes(&self) {
        loop {
            let running: Vec<Done> = {
                let refreshes = self.refreshes();
                let mut running: Vec<Done> = refreshes.completions.iter().map(|(_, done)| done.clone()).collect();
                running.extend(refreshes.startup.iter().map(|s| s.done.clone()));
                running.extend(refreshes.full.clone());
                running.retain(|done| done.peek().is_none());
                running
            };
            if running.is_empty() {
                return;
            }
            futures::future::join_all(running).await;
        }
    }

    /// The readiness half of `ensureProvidersReady` after its initialization (provider-readiness.mjs:146-182): the startup
    /// refresh of the current epoch; one this runtime has not observed yet gets its completion handling. The pending
    /// flag is set until it settles; then, for the latest one only, the flag clears and the parked warm-ups are woken
    /// (`settle`); then, unless the runtime is closing, the model caches drop with the providers kept and the
    /// secrets-carrying re-warm starts.
    fn observe_startup_refresh(self: &Arc<Self>) {
        #[cfg(any(test, feature = "test-support"))]
        self.reach(Point::StartupBeforeLock);
        let mut refreshes = self.refreshes();
        // Chosen and observed in one critical section (Node's one synchronous step): a caller overtaken between the
        // two would observe a superseded refresh and hand it the pending flag of the newer one.
        let startup = self.startup_refresh_in(&mut refreshes);
        if refreshes.observed == Some(startup.id) {
            return;
        }
        refreshes.observed = Some(startup.id);
        // In the critical section that observes it: the flag's owner is the latest observed refresh.
        self.catalog.mark_startup_refresh_pending(startup.id);
        let (this, id) = (self.clone(), startup.id);
        let task = mixdog_rt::spawn("catalog.startup-refresh-completion", mixdog_rt::TaskClass::Work, async move {
            startup.done.await;
            #[cfg(any(test, feature = "test-support"))]
            this.reach(Point::CompletionBeforeSettle);
            // Settles only while this refresh still owns the flag (`isLatest()`).
            this.catalog.settle_startup_refresh(id);
            if !this.gate().closed {
                this.invalidate(true, true);
                if let Some(rewarm) = this.rewarm.get() {
                    rewarm();
                }
            }
            this.refreshes().completions.retain(|(held, _)| *held != id);
        });
        refreshes.completions.push((id, task.map(drop).boxed().shared()));
    }

    fn gate(&self) -> MutexGuard<'_, Gate> {
        self.gate.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The runtime's `config.providers`, the default of a ready call and the
    /// base a replay is built on.
    pub fn set_providers(&self, providers: Map<String, Value>) {
        self.gate().providers = providers;
    }

    /// The runtime is closing: every later call fails.
    pub fn close(&self) {
        self.gate().closed = true;
    }

    /// `ensureProvidersReady(providerConfig)`; `None` is the runtime's config. After the initialization, unless the
    /// runtime is closing, the startup catalog refresh of the current epoch is started or joined, and observed.
    pub async fn ensure_providers_ready(self: &Arc<Self>, providers: Option<Map<String, Value>>) -> Result<(), RegistryError> {
        let providers = providers.unwrap_or_else(|| self.gate().providers.clone());
        self.clone().init(providers).await?;
        if !self.gate().closed {
            self.observe_startup_refresh();
        }
        Ok(())
    }

    /// One keyed initialization: the settled flight of an equal config, or a new one.
    fn init(self: Arc<Self>, providers: Map<String, Value>) -> BoxFuture<'static, Result<(), RegistryError>> {
        Box::pin(async move {
            let key = config_signature(&Value::Object(providers.clone()));
            let flight = {
                let mut gate = self.gate();
                if gate.closed {
                    return Err(closing());
                }
                let generation = gate.generation;
                let forced = forced_providers(&providers, &gate.providers);
                gate.flights
                    .entry(key.clone())
                    .or_insert_with(|| self.clone().initialize(providers, generation, forced).shared())
                    .clone()
            };
            let result = flight.clone().await;
            if result.is_err() {
                let mut gate = self.gate();
                if gate.flights.get(&key).is_some_and(|held| held.ptr_eq(&flight)) {
                    gate.flights.remove(&key);
                }
            }
            result
        })
    }

    fn initialize(
        self: Arc<Self>,
        providers: Map<String, Value>,
        generation: u64,
        forced: Vec<String>,
    ) -> BoxFuture<'static, Result<(), RegistryError>> {
        Box::pin(async move {
            let (closed, current, mut latest) = {
                let gate = self.gate();
                (gate.closed, gate.generation, gate.providers.clone())
            };
            if closed {
                return Err(closing());
            }
            if generation == current {
                return self.registry.init_providers(&providers).await;
            }
            // Superseded: the latest config wins, with the providers this request turned on.
            for name in forced {
                let mut entry = match latest.shift_remove(&name) {
                    Some(Value::Object(entry)) => entry,
                    _ => Map::new(),
                };
                entry.insert("enabled".into(), Value::Bool(true));
                latest.insert(name, Value::Object(entry));
            }
            self.init(latest).await
        })
    }

    /// `invalidateProviderCaches`: the catalog's consumers start a new
    /// revision, and unless `preserve_init` the init flights are dropped and
    /// any running initialization is superseded.
    pub fn invalidate_provider_caches(&self, preserve_init: bool) {
        self.invalidate(preserve_init, false);
    }

    fn invalidate(&self, preserve_init: bool, after_refresh: bool) {
        self.registry.bump_catalog_revision();
        if !preserve_init {
            let mut gate = self.gate();
            gate.flights.clear();
            gate.generation += 1;
        }
        // Every caller drops the caches above the catalog too, so none can miss them.
        if let Some(hook) = self.invalidation.get() {
            if after_refresh {
                hook.drop_caches_after_refresh();
            } else {
                hook.drop_caches();
            }
        }
    }

    /// `catalogRevision(reg())`: moves when a provider registers or leaves and at every invalidation.
    pub fn catalog_revision(&self) -> u64 {
        self.registry.catalog_revision()
    }

    /// Binds `caches.providerModelsLoadSeq` to the catalog's route-meta lookups (see `CatalogService::bind_load_seq`).
    pub fn bind_load_seq(&self, seq: impl Fn() -> u64 + Send + Sync + 'static) {
        self.catalog.bind_load_seq(seq);
    }

    /// Binds what else an invalidation drops; a second bind is refused.
    pub fn bind_invalidation(&self, hook: Arc<dyn CacheDrop>) -> Result<(), Arc<dyn CacheDrop>> {
        self.invalidation.set(hook)
    }

    /// Whether the invalidation hook has been bound (the late cell startup verifies).
    pub fn invalidation_bound(&self) -> bool {
        self.invalidation.get().is_some()
    }

    /// `reinitProviders`: provider config or secrets changed. Everything keyed to the old ones is dropped and the
    /// registry is synced to the runtime's providers (`syncProviders(providerRecord(), { decisions })`): a registered
    /// provider whose config changed is rebuilt, one the stored `decisions` turned off (a deleted custom provider among
    /// them) is removed, and none is added. `decisions` is `None` when no stored section reads.
    pub async fn reinit_providers(&self, decisions: Option<Map<String, Value>>) -> Result<(), RegistryError> {
        self.invalidate_provider_caches(false);
        let record = {
            let gate = self.gate();
            if gate.closed {
                return Ok(());
            }
            gate.providers.clone()
        };
        self.registry.sync_providers(&record, decisions).await
    }

    /// A forced full catalog refresh (`refreshCatalogs({ force: true })`, which also arms the next 24 h one), then the
    /// model-derived caches drop while the initialized registry stays.
    pub async fn refresh_catalogs(self: &Arc<Self>) {
        let full = {
            let mut refreshes = self.refreshes();
            self.start_full(&mut refreshes)
        };
        full.await;
        if !self.gate().closed {
            self.invalidate_provider_caches(true);
        }
    }
}

const API_PROVIDER_IDS: [&str; 8] = ["openrouter", "openai", "anthropic", "gemini", "vertex-ai", "deepseek", "xai", "mixdog-local"];

const OAUTH_PROVIDER_IDS: [&str; 10] = [
    "openai-oauth",
    "anthropic-oauth",
    "grok-oauth",
    "muse-code-oauth",
    "command-code-oauth",
    "opencode-go-oauth",
    "mimo-oauth",
    "cursor-oauth",
    "devin-oauth",
    "antigravity-oauth",
];

/// `custom-` and a lowercase UUID.
fn is_custom_provider_id(id: &str) -> bool {
    let Some(uuid) = id.strip_prefix("custom-") else { return false };
    let groups: Vec<&str> = uuid.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && g.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}

/// `isKnownProvider(provider, config)`: a built-in API provider, `mixdog-local`,
/// an OAuth provider (a dev-gated one only while `available` says it is on),
/// or an enabled custom provider the config defines.
pub fn is_known_provider(provider: &str, config: &Value, available: &dyn Fn(&str) -> bool) -> bool {
    let id = mixdog_js::js_trim(provider);
    if id.is_empty() {
        return false;
    }
    if API_PROVIDER_IDS.contains(&id) || (OAUTH_PROVIDER_IDS.contains(&id) && available(id)) {
        return true;
    }
    let entry = config.get("providers").and_then(|p| p.get(id));
    is_custom_provider_id(id)
        && entry.is_some_and(|e| e.get("type").and_then(Value::as_str) == Some("custom"))
        && entry.and_then(|e| e.get("enabled")) != Some(&Value::Bool(false))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use async_trait::async_trait;
    use mixdog_core_api::domain::mock::MockProvider;
    use mixdog_core_api::domain::provider::ProviderAdapter;
    use serde_json::json;

    use super::*;
    use crate::catalog::CatalogSnapshot;
    use crate::catalog::ModelsDevSource;
    use crate::registry::providers::ProviderBuilder;
    use crate::transport::http::HttpResponse;
    use crate::transport::http::HttpSend;
    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::provider::ErrorKind;
    use mixdog_core_api::domain::provider::ProviderError;
    use mixdog_core_api::domain::provider::WireRequest;

    struct Offline;
    #[async_trait]
    impl HttpSend for Offline {
        async fn send(
            &self,
            _: WireRequest,
            _exchange: crate::transport::Exchange,
        ) -> Result<HttpResponse, ProviderError> {
            Err(ProviderError::new(
                ErrorKind::Transient,
                DeliveryState::NotSent,
            ))
        }
    }

    #[derive(Default)]
    struct Counting {
        builds: AtomicUsize,
        fail: Mutex<bool>,
    }
    #[async_trait]
    impl ProviderBuilder for Counting {
        async fn build(&self, _: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            self.builds.fetch_add(1, Ordering::SeqCst);
            if *self.fail.lock().unwrap() {
                return Err("boom".into());
            }
            Ok(Arc::new(MockProvider::new([])))
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
    }

    async fn readiness_over(builder: Arc<dyn ProviderBuilder>) -> Arc<ProviderReadiness> {
        let tokens = mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let io = crate::oauth::CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let metadata = ModelsDevSource::new(Arc::new(Offline), dir.path().to_path_buf(), io);
        let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), metadata).await);
        ProviderReadiness::new(Arc::new(ProviderRegistry::new(builder)), catalog)
    }

    async fn readiness() -> (Arc<ProviderReadiness>, Arc<Counting>) {
        let builder = Arc::new(Counting::default());
        (readiness_over(builder.clone()).await, builder)
    }

    /// A provider whose model listing fails with `message`.
    struct FailingListing(MockProvider, String);
    #[async_trait]
    impl mixdog_core_api::domain::provider::ModelListing for FailingListing {
        async fn list_models(&self) -> Result<Vec<mixdog_core_api::domain::provider::ModelRecord>, ProviderError> {
            let mut error = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
            error.message = self.1.clone();
            Err(error)
        }
    }
    #[async_trait]
    impl ProviderAdapter for FailingListing {
        fn release_send(&self, _group: &str) {}
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
        async fn attempt(
            &self,
            request: Arc<mixdog_core_api::domain::provider::ModelRequest>,
        ) -> Result<Box<dyn mixdog_core_api::domain::provider::ModelStream>, ProviderError> {
            self.0.attempt(request).await
        }
        fn models(&self) -> Option<&dyn mixdog_core_api::domain::provider::ModelListing> {
            Some(self)
        }
    }
    struct FailingBuilder(String);
    #[async_trait]
    impl ProviderBuilder for FailingBuilder {
        async fn build(&self, _: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            Ok(Arc::new(FailingListing(MockProvider::new([]), self.0.clone())))
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
    }

    /// The Node stderr lines written while `body` runs over a provider whose listing fails echoing `secret`, a credential
    /// the process carries.
    async fn refresh_lines(secret: &str, full: bool) -> Vec<String> {
        crate::oauth::carried::keep("config the-refresh-line-test", &[secret]);
        let ready = readiness_over(Arc::new(FailingBuilder(format!("listing refused: key {secret} rejected")))).await;
        let (lines, _capture) = mixdog_rt::node_log::capture();
        ready.ensure_providers_ready(Some(config(json!({"xai": {"enabled": true}})))).await.unwrap();
        if full {
            ready.refresh_catalogs().await;
        } else {
            ready.join_startup_refresh().await;
        }
        ready.settle_refreshes().await;
        let lines = lines.lock().unwrap().iter().map(|(_, _, line)| line.clone()).collect();
        lines
    }

    #[tokio::test]
    async fn the_startup_refresh_line_redacts_a_credential_the_listing_error_echoes() {
        let secret = "startup-line-key-5b1e90d4";
        let lines = refresh_lines(secret, false).await;
        let line = lines.iter().find(|l| l.starts_with("[provider:xai] startup catalog refresh failed: ")).unwrap_or_else(|| panic!("{lines:?}"));
        assert!(line.contains("[REDACTED]") && !line.contains(secret), "{line}");
    }

    #[tokio::test]
    async fn the_full_refresh_line_redacts_a_credential_the_listing_error_echoes() {
        let secret = "full-line-key-7c2d41a8";
        let lines = refresh_lines(secret, true).await;
        let line = lines.iter().find(|l| l.starts_with("[provider:xai] catalog refresh failed: ")).unwrap_or_else(|| panic!("{lines:?}"));
        assert!(line.contains("[REDACTED]") && !line.contains(secret), "{line}");
    }

    fn config(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[tokio::test]
    async fn an_equal_config_initializes_once_whatever_its_key_order() {
        let (ready, builder) = readiness().await;
        let a = config(json!({"anthropic": {"enabled": true, "k": 1, "j": 2}}));
        let b = config(json!({"anthropic": {"j": 2, "k": 1, "enabled": true}}));
        ready.ensure_providers_ready(Some(a)).await.unwrap();
        // The settled flight is kept.
        ready.ensure_providers_ready(Some(b)).await.unwrap();
        assert_eq!(builder.builds.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_failed_init_is_not_kept() {
        let (ready, builder) = readiness().await;
        *builder.fail.lock().unwrap() = true;
        let cfg = config(json!({"anthropic": {"enabled": true}}));
        let err = ready.ensure_providers_ready(Some(cfg.clone())).await.unwrap_err();
        assert!(err.message.contains("boom"));
        *builder.fail.lock().unwrap() = false;
        ready.ensure_providers_ready(Some(cfg)).await.unwrap();
        assert_eq!(builder.builds.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn invalidation_drops_the_flights_and_close_refuses() {
        let (ready, builder) = readiness().await;
        let cfg = config(json!({"anthropic": {"enabled": true}}));
        ready.ensure_providers_ready(Some(cfg.clone())).await.unwrap();
        ready.invalidate_provider_caches(true);
        ready.ensure_providers_ready(Some(cfg.clone())).await.unwrap();
        assert_eq!(builder.builds.load(Ordering::SeqCst), 1);
        // A rebuilt flight finds the provider already registered: no second build.
        ready.invalidate_provider_caches(false);
        ready.ensure_providers_ready(Some(cfg.clone())).await.unwrap();
        assert_eq!(builder.builds.load(Ordering::SeqCst), 1);
        ready.close();
        assert_eq!(ready.ensure_providers_ready(Some(cfg)).await.unwrap_err().message, "runtime is closing");
    }

    /// `reinitProviders` syncs the registry to the runtime's providers with the stored decisions
    /// (`syncProviders(providerRecord(), { decisions })`): a registered provider whose config changed is built again, a
    /// custom provider the decisions no longer hold (a deleted one) leaves, and one only the record turns on is not added.
    #[tokio::test]
    async fn a_reinit_rebuilds_an_edited_provider_and_removes_a_deleted_custom_one_without_adding() {
        let (ready, builder) = readiness().await;
        ready.set_providers(config(json!({
            "anthropic": {"enabled": true, "k": 1},
            "custom-0123abcd-0123-4567-89ab-0123456789ab": {"type": "custom", "enabled": true}
        })));
        ready.ensure_providers_ready(None).await.unwrap();
        assert_eq!(builder.builds.load(Ordering::SeqCst), 2);
        let before = ready.registry.generation("anthropic");
        assert!(before.is_some());
        // The custom provider was deleted (gone from the record and from the stored section), the other one was edited,
        // and a third is turned on in the record only.
        ready.set_providers(config(json!({"anthropic": {"enabled": true, "k": 2}, "xai": {"enabled": true}})));
        ready.reinit_providers(Some(config(json!({"anthropic": {"enabled": true}})))).await.unwrap();
        assert_eq!(builder.builds.load(Ordering::SeqCst), 3, "only the edited provider is built again");
        assert_ne!(ready.registry.generation("anthropic"), before, "the edited provider is a new registration");
        assert_eq!(ready.registry.names().into_iter().collect::<Vec<_>>(), ["anthropic"]);
    }

    #[tokio::test]
    async fn every_invalidation_drops_the_caches_above_the_catalog() {
        use std::sync::atomic::AtomicUsize;
        let (ready, _) = readiness().await;
        assert!(!ready.invalidation_bound());
        ready.invalidate_provider_caches(true); // unbound: nothing else to drop
        let dropped = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&dropped);
        assert!(ready.bind_invalidation(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })).is_ok());
        assert!(ready.invalidation_bound());
        ready.invalidate_provider_caches(true);
        ready.invalidate_provider_caches(false);
        assert_eq!(dropped.load(Ordering::SeqCst), 2, "both kinds of invalidation drop them");
        assert!(ready.bind_invalidation(Arc::new(|| {})).is_err(), "a second bind is refused");
    }

    #[test]
    fn forced_providers_are_those_the_request_turned_on() {
        let requested = config(json!({"a": {"enabled": true}, "b": {"enabled": true}, "c": {"enabled": false}}));
        let base = config(json!({"a": {"enabled": true}}));
        assert_eq!(forced_providers(&requested, &base), vec!["b".to_owned()]);
    }

    #[test]
    fn known_providers_follow_node() {
        let uuid = "custom-0123abcd-0123-4567-89ab-0123456789ab";
        let config = json!({"providers": {
            uuid: {"type": "custom", "enabled": true},
            "custom-ffffffff-ffff-ffff-ffff-ffffffffffff": {"type": "custom", "enabled": false},
            "custom-00000000-0000-0000-0000-000000000000": {"type": "api"}
        }});
        let on = |_: &str| true;
        let off = |_: &str| false;
        for id in ["openai", "xai", "vertex-ai", "mixdog-local", " anthropic ", "anthropic-oauth", "cursor-oauth", uuid] {
            assert!(is_known_provider(id, &config, &on), "{id}");
        }
        assert!(!is_known_provider("cursor-oauth", &config, &off));
        assert!(is_known_provider("openai", &config, &off));
        for id in ["", "  ", "nope", "custom-ffffffff-ffff-ffff-ffff-ffffffffffff", "custom-00000000-0000-0000-0000-000000000000", "custom-0123ABCD-0123-4567-89ab-0123456789ab"] {
            assert!(!is_known_provider(id, &config, &on), "{id}");
        }
    }
}
