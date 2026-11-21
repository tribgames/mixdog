//! Provider readiness, as Node's `createProviderReadiness`
//! (`session-runtime/provider-readiness.mjs`) runs it: provider initialization
//! is a single flight per set of providers a request asks for, and its
//! settled result is kept, so a repeat call asking the same starts nothing. A
//! change of the runtime's providers, or one that invalidates the caches,
//! clears the flights and supersedes any initialization still running: that
//! one registers nothing built before the change, and the latest config
//! instead (with the providers its request asked for).
//!
//! For a provider the runtime's providers hold (the record, `set_providers`),
//! the record is the only config: the map a ready call is given never
//! replaces or rolls back a registered provider. The map says which
//! providers the request needs on, and for one the record does not hold (a
//! provider just saved, not yet loaded) it supplies the entry to build from;
//! such an entry only adds, and the record's replaces it once it holds one.
//!
//! What is newest is decided in one place, the gate. An initialization and a
//! reinit hand the registry no config, only the gate as its source (`Newest`):
//! the registry reads the config, the stored decisions and the gate's
//! generation under its apply permit, and registers and removes under the
//! gate's lock, in the one step that checks the generation has not moved and
//! the stored decisions are still the ones read.
//! The generation moves at every change of the runtime's providers and every
//! invalidation, a credential's included, so nothing built on an older read
//! is registered. An initialization also rebuilds a registered provider whose
//! config differs, so its caller returns with the registry on the newest
//! config in full. A flight runs as its own task: its progress, and the
//! registry's permit it holds, never wait for a caller to poll it.
//! Keychain prewarming belongs to the registry's key store, which the builder
//! reads.

use std::collections::HashMap;
use std::collections::HashSet;
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
use crate::registry::providers::Read;
use crate::registry::providers::RegistryError;
use crate::registry::providers::Source;

type Flight = Shared<BoxFuture<'static, Result<(), RegistryError>>>;

#[derive(Default)]
struct Gate {
    /// The initializations of this generation, by the providers each request's map enabled (sorted); `None` is the
    /// request with no map.
    flights: HashMap<Option<Vec<String>>, Flight>,
    /// Advances whenever the flights are cleared: at a change of `providers` and at an invalidation.
    generation: u64,
    closed: bool,
    /// The runtime's own `config.providers`: the one record the registry is built from.
    providers: Map<String, Value>,
}

impl Gate {
    /// A new generation: the flights of the old one answer for a config that is no longer the latest.
    fn supersede(&mut self) {
        self.flights.clear();
        self.generation += 1;
    }

    /// What an initialization applies now: the runtime's providers as they are, stamped with the generation. A
    /// request that came with a map (`asked`: the providers the map enables, each with the map's entry) adds only
    /// those when they are missing. One the runtime's providers hold is built from its entry there, turned on; one
    /// they do not hold is built from the map's entry (`Read::supplied`), which never replaces a registered provider.
    fn read_for(&self, asked: Option<&[(String, Value)]>) -> Read {
        let mut config = self.providers.clone();
        let mut supplied = HashSet::new();
        for (name, entry) in asked.unwrap_or_default() {
            match config.get_mut(name).and_then(Value::as_object_mut) {
                Some(held) => {
                    held.insert("enabled".into(), Value::Bool(true));
                }
                None => {
                    config.insert(name.clone(), entry.clone());
                    supplied.insert(name.clone());
                }
            }
        }
        let asked = asked.map(|asked| asked.iter().map(|(name, _)| name.clone()).collect());
        Read { stamp: self.generation, config, supplied, asked, decisions: None }
    }
}

/// The gate as the registry's source: `read` is what to apply of the gate as it is read; `decisions` reads the stored
/// decisions, always under the gate's lock.
struct Newest<'a, C, D> {
    gate: &'a Mutex<Gate>,
    read: C,
    decisions: D,
}

impl<C, D> Source for Newest<'_, C, D>
where
    C: Fn(&Gate) -> Read + Sync,
    D: Fn() -> Option<Map<String, Value>> + Sync,
{
    fn newest(&self) -> Read {
        let gate = self.gate.lock().unwrap_or_else(PoisonError::into_inner);
        Read { decisions: (self.decisions)(), ..(self.read)(&gate) }
    }

    /// One step under the gate's lock, which every move of the generation takes; the stored decisions are read
    /// again in it, so nothing is removed on decisions that are no longer the stored ones.
    fn settle_if_newest<R>(&self, read: &Read, settle: impl FnOnce() -> R) -> Option<R> {
        let gate = self.gate.lock().unwrap_or_else(PoisonError::into_inner);
        (gate.generation == read.stamp && (self.decisions)() == read.decisions).then(settle)
    }
}

type Done = Shared<BoxFuture<'static, ()>>;

/// One startup catalog refresh (`_startupCatalogRefreshPromise`): it belongs to the registry's catalog epoch it began in.
#[derive(Clone)]
struct Startup {
    epoch: u64,
    id: u64,
    done: Done,
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

fn closing() -> RegistryError {
    RegistryError { message: "runtime is closing".into(), code: None }
}

/// The providers a request's map enables, each with the map's entry, by name.
fn asked_providers(requested: &Map<String, Value>) -> Vec<(String, Value)> {
    let mut asked: Vec<(String, Value)> =
        requested.iter().filter(|(_, entry)| entry.get("enabled") == Some(&Value::Bool(true))).map(|(name, entry)| (name.clone(), entry.clone())).collect();
    asked.sort_by(|a, b| a.0.cmp(&b.0));
    asked
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
    groups.len() == 5 && groups.iter().zip([8, 4, 4, 4, 12]).all(|(g, n)| g.len() == n && g.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
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
    use crate::registry::providers::config_signature;
    use crate::transport::http::HttpResponse;
    use crate::transport::http::HttpSend;
    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::provider::ErrorKind;
    use mixdog_core_api::domain::provider::ProviderError;
    use mixdog_core_api::domain::provider::WireRequest;

    struct Offline;
    #[async_trait]
    impl HttpSend for Offline {
        async fn send(&self, _: WireRequest, _exchange: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
            Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
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

    fn config(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn the_asked_providers_are_those_the_map_enables_by_name() {
        let requested = config(json!({"b": {"enabled": true, "k": 1}, "a": {"enabled": true}, "c": {"enabled": false}}));
        assert_eq!(asked_providers(&requested), vec![("a".to_owned(), json!({"enabled": true})), ("b".to_owned(), json!({"enabled": true, "k": 1}))]);
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
        for id in [
            "",
            "  ",
            "nope",
            "custom-ffffffff-ffff-ffff-ffff-ffffffffffff",
            "custom-00000000-0000-0000-0000-000000000000",
            "custom-0123ABCD-0123-4567-89ab-0123456789ab",
        ] {
            assert!(!is_known_provider(id, &config, &on), "{id}");
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
        ready.reinit_providers(|| Some(config(json!({"anthropic": {"enabled": true}})))).await.unwrap();
        assert_eq!(builder.builds.load(Ordering::SeqCst), 3, "only the edited provider is built again");
        assert_ne!(ready.registry.generation("anthropic"), before, "the edited provider is a new registration");
        assert_eq!(ready.registry.names().into_iter().collect::<Vec<_>>(), ["anthropic"]);
    }
    /// Builds every provider, recording the config of each build; a build that begins while `fail` is set (its
    /// credential read) fails. The next key-id read once `held` is set waits for `release`, and so does the next build
    /// once `held_build` is set, after its credential read. Both run under the registry's apply permit, so the apply
    /// they belong to keeps the permit while it is held.
    #[derive(Default)]
    struct HeldKeyIds {
        held: std::sync::atomic::AtomicBool,
        held_build: std::sync::atomic::AtomicBool,
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
        built: Mutex<Vec<Value>>,
        fail: std::sync::atomic::AtomicBool,
    }
    #[async_trait]
    impl ProviderBuilder for HeldKeyIds {
        async fn build(&self, _: &str, config: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            let fail = self.fail.load(Ordering::SeqCst);
            if self.held_build.swap(false, Ordering::SeqCst) {
                self.entered.notify_one();
                self.release.notified().await;
            }
            if fail {
                return Err("boom".into());
            }
            self.built.lock().unwrap().push(config.clone());
            Ok(Arc::new(MockProvider::new([])))
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            if self.held.swap(false, Ordering::SeqCst) {
                self.entered.notify_one();
                self.release.notified().await;
            }
            Ok(Vec::new())
        }
        fn available(&self, _: &str) -> bool {
            true
        }
        async fn oauth_credentials_usable(&self, _: &str) -> Result<bool, String> {
            Ok(true)
        }
    }
    const CUSTOM: &str = "custom-0123abcd-0123-4567-89ab-0123456789ab";
    /// The runtime's providers at their `k`th edit: one custom provider and one built-in.
    fn record(k: u64) -> Map<String, Value> {
        config(json!({ CUSTOM: {"type": "custom", "enabled": true, "k": k}, "anthropic": {"enabled": true, "k": k} }))
    }
    /// What the registry holds: whether it is initialized, and the config signature each provider is registered under.
    #[derive(PartialEq, Debug)]
    struct Held {
        initialized: bool,
        custom: Option<String>,
        anthropic: Option<String>,
    }
    fn held(ready: &ProviderReadiness) -> Held {
        Held { initialized: ready.registry.initialized(), custom: ready.registry.signature(CUSTOM), anthropic: ready.registry.signature("anthropic") }
    }
    /// The registry initialized on the `k`th edit, both providers registered.
    fn on(k: u64) -> Held {
        let signature = |name: &str| Some(config_signature(&record(k)[name]));
        Held { initialized: true, custom: signature(CUSTOM), anthropic: signature("anthropic") }
    }
    type Returned = tokio::task::JoinHandle<(Result<(), RegistryError>, Held)>;
    /// A ready call in its own task, with what the registry holds in the step the call returns in.
    fn ensure(ready: &Arc<ProviderReadiness>) -> Returned {
        let ready = ready.clone();
        tokio::spawn(async move {
            let result = ready.ensure_providers_ready(None).await;
            (result, held(&ready))
        })
    }
    /// A reinit in its own task, likewise.
    fn reinit(ready: &Arc<ProviderReadiness>, decisions: impl Fn() -> Option<Map<String, Value>> + Send + Sync + 'static) -> Returned {
        let ready = ready.clone();
        tokio::spawn(async move {
            let result = ready.reinit_providers(decisions).await;
            (result, held(&ready))
        })
    }
    /// Lets the spawned calls run as far as they can.
    async fn run_others() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }
    /// The original overlap: an initialization a reinit overtakes while it runs registers nothing of the record it
    /// began with, and its caller returns with the registry ready on the newer one.
    #[tokio::test]
    async fn an_initialization_overtaken_by_a_reinit_returns_ready_on_the_newer_record() {
        let builder = Arc::new(HeldKeyIds { held: true.into(), ..HeldKeyIds::default() });
        let ready = readiness_over(builder.clone()).await;
        ready.set_providers(record(1));
        let older = ensure(&ready);
        builder.entered.notified().await;
        ready.set_providers(record(2));
        let newer = reinit(&ready, || Some(record(2)));
        run_others().await;
        assert!(!newer.is_finished(), "the reinit waits for the permit the initialization holds");
        builder.release.notify_one();
        let (result, at_return) = older.await.unwrap();
        result.unwrap();
        assert_eq!(at_return, on(2));
        newer.await.unwrap().0.unwrap();
        assert_eq!(held(&ready), on(2));
    }
    /// Interleaving 1: the initialization, already going on with the second record, is overtaken again by a third.
    /// What it registers is chosen as it settles, so the second record is never registered as the current one.
    #[tokio::test]
    async fn an_initialization_overtaken_twice_returns_ready_on_the_last_record() {
        let builder = Arc::new(HeldKeyIds { held: true.into(), ..HeldKeyIds::default() });
        let ready = readiness_over(builder.clone()).await;
        ready.set_providers(record(1));
        let older = ensure(&ready);
        builder.entered.notified().await;
        ready.set_providers(record(2));
        let second = reinit(&ready, || Some(record(2)));
        // It goes on with the second record and is held at that record's key-id read.
        builder.held.store(true, Ordering::SeqCst);
        builder.release.notify_one();
        builder.entered.notified().await;
        ready.set_providers(record(3));
        let third = reinit(&ready, || Some(record(3)));
        run_others().await;
        builder.release.notify_one();
        let (result, at_return) = older.await.unwrap();
        result.unwrap();
        assert_eq!(at_return, on(3));
        second.await.unwrap().0.unwrap();
        third.await.unwrap().0.unwrap();
        assert_eq!(held(&ready), on(3));
    }
    /// Interleaving 2, and the removal step: a reinit called while the stored decisions delete the custom provider
    /// builds while they are replaced by ones that hold it again, the reinit of that change not yet arrived. It reads
    /// the decisions in the step that removes, under the gate's lock, so the provider stays; the reinit that follows
    /// has nothing to restore.
    #[tokio::test]
    async fn a_reinit_removes_on_the_decisions_stored_in_the_step_that_removes() {
        let builder = Arc::new(HeldKeyIds::default());
        let ready = readiness_over(builder.clone()).await;
        ready.set_providers(record(1));
        ready.ensure_providers_ready(None).await.unwrap();
        let without_custom = config(json!({"anthropic": {"enabled": true}}));
        let stored = Arc::new(Mutex::new(Some(without_custom)));
        let read_outside_the_step = Arc::new(AtomicUsize::new(0));
        let decisions = {
            let (stored, ready, outside) = (stored.clone(), ready.clone(), read_outside_the_step.clone());
            move || {
                if ready.gate.try_lock().is_ok() {
                    outside.fetch_add(1, Ordering::SeqCst);
                }
                stored.lock().unwrap().clone()
            }
        };
        builder.held.store(true, Ordering::SeqCst);
        let older = reinit(&ready, decisions.clone());
        builder.entered.notified().await;
        *stored.lock().unwrap() = Some(record(1));
        builder.release.notify_one();
        let (result, at_return) = older.await.unwrap();
        result.unwrap();
        assert_eq!(at_return, on(1));
        ready.reinit_providers(decisions).await.unwrap();
        assert_eq!(held(&ready), on(1));
        assert_eq!(read_outside_the_step.load(Ordering::SeqCst), 0, "the decisions are read only under the gate's lock");
        // The decisions as they were when the first reinit was called do remove, once they are the stored ones.
        ready.reinit_providers(|| Some(config(json!({"anthropic": {"enabled": true}})))).await.unwrap();
        assert_eq!(held(&ready), Held { custom: None, ..on(1) });
    }
    /// Review point 1: an initialization whose build read a credential that fails is overtaken by a reinit that
    /// replaces the credential and leaves the runtime's providers as they are. The failed build is dropped and the
    /// provider is built again, so the caller returns with it registered; the reinit, which reads no stored decisions
    /// here, could not have added it.
    #[tokio::test]
    async fn an_initialization_overtaken_by_a_credential_change_alone_builds_again() {
        let builder = Arc::new(HeldKeyIds { fail: true.into(), held_build: true.into(), ..HeldKeyIds::default() });
        let ready = readiness_over(builder.clone()).await;
        ready.set_providers(record(1));
        let older = ensure(&ready);
        builder.entered.notified().await;
        builder.fail.store(false, Ordering::SeqCst);
        let newer = reinit(&ready, || None);
        run_others().await;
        builder.release.notify_one();
        let (result, at_return) = older.await.unwrap();
        result.unwrap();
        assert_eq!(at_return, on(1));
        newer.await.unwrap().0.unwrap();
        assert_eq!(held(&ready), on(1));
        assert!(ready.registry.init_errors().is_empty(), "nothing of the build on the old credential is kept");
    }
    /// A ready call given a map captured before the runtime's providers changed: the default call settles the newer
    /// record, the delayed call arrives with the older map, and the next default call follows. The older map is not
    /// built from, so the registered providers stay on the newer record throughout, and nothing is built again.
    #[tokio::test]
    async fn a_ready_call_with_an_older_map_does_not_put_a_registered_provider_back() {
        let builder = Arc::new(HeldKeyIds::default());
        let ready = readiness_over(builder.clone()).await;
        ready.set_providers(record(1));
        let captured = record(1);
        ready.set_providers(record(2));
        ready.ensure_providers_ready(None).await.unwrap();
        assert_eq!(held(&ready), on(2));
        ready.ensure_providers_ready(Some(captured)).await.unwrap();
        assert_eq!(held(&ready), on(2), "the delayed call returns with the newer record registered");
        ready.ensure_providers_ready(None).await.unwrap();
        assert_eq!(held(&ready), on(2));
        assert_eq!(builder.built.lock().unwrap().len(), 2, "each provider was built once, on the newer record");
    }
    /// A ready call's map only turns providers on: one it enables that the runtime's providers have off is built from
    /// the runtime's entry, and nothing else of the map is used.
    #[tokio::test]
    async fn a_ready_call_turns_a_provider_on_from_the_runtimes_entry() {
        let builder = Arc::new(HeldKeyIds::default());
        let ready = readiness_over(builder.clone()).await;
        let mut stored = record(1);
        stored.insert("xai".into(), json!({"enabled": false, "k": 1}));
        ready.set_providers(stored);
        let mut asked = record(0);
        asked.insert("xai".into(), json!({"enabled": true, "k": 0}));
        ready.ensure_providers_ready(Some(asked)).await.unwrap();
        assert_eq!(held(&ready), on(1));
        assert_eq!(ready.registry.signature("xai"), Some(config_signature(&json!({"enabled": true, "k": 1}))));
    }
    /// A provider just saved, which the runtime's providers do not hold yet, is built at once from the entry the
    /// ready call's map gives it. Registered, it is not replaced by another call's entry; once the runtime's
    /// providers hold it, theirs is its config.
    #[tokio::test]
    async fn a_ready_call_supplies_the_entry_of_a_provider_the_runtimes_providers_do_not_hold() {
        let builder = Arc::new(HeldKeyIds::default());
        let ready = readiness_over(builder.clone()).await;
        ready.set_providers(record(1));
        ready.ensure_providers_ready(None).await.unwrap();
        let with_xai = |k: u64| {
            let mut map = record(1);
            map.insert("xai".into(), json!({"enabled": true, "k": k}));
            map
        };
        let xai = |k: u64| Some(config_signature(&json!({"enabled": true, "k": k})));
        ready.ensure_providers_ready(Some(with_xai(1))).await.unwrap();
        assert_eq!(ready.registry.signature("xai"), xai(1), "built from the map's entry");
        assert_eq!(held(&ready), on(1));
        // Another flight (it asks for fewer providers), with another entry for the registered one.
        let mut other = with_xai(2);
        other.shift_remove(CUSTOM);
        ready.ensure_providers_ready(Some(other)).await.unwrap();
        assert_eq!(ready.registry.signature("xai"), xai(1), "a map's entry does not replace a registered provider");
        ready.set_providers(with_xai(3));
        ready.ensure_providers_ready(None).await.unwrap();
        assert_eq!(ready.registry.signature("xai"), xai(3), "the runtime's entry is its config once they hold it");
    }
    /// A ready call's map bounds what is added: a provider just removed, which the runtime's providers still enable,
    /// is not registered again by a call whose map no longer has it.
    #[tokio::test]
    async fn a_ready_call_does_not_register_a_missing_provider_its_map_leaves_out() {
        let builder = Arc::new(HeldKeyIds::default());
        let ready = readiness_over(builder.clone()).await;
        ready.set_providers(record(1));
        ready.ensure_providers_ready(None).await.unwrap();
        ready.disable_provider(CUSTOM);
        let mut without_custom = record(1);
        without_custom.shift_remove(CUSTOM);
        ready.ensure_providers_ready(Some(without_custom)).await.unwrap();
        assert_eq!(held(&ready), Held { custom: None, ..on(1) });
    }
    /// Review point: a provider is turned off and the removal settles; it is turned on again, and when the reinit of
    /// that decision returns it is registered for a route, with no ready call in between.
    #[tokio::test]
    async fn a_provider_turned_off_and_on_again_is_registered_when_the_second_reinit_returns() {
        let builder = Arc::new(HeldKeyIds::default());
        let ready = readiness_over(builder.clone()).await;
        ready.set_providers(record(1));
        ready.ensure_providers_ready(None).await.unwrap();
        let stored = |custom_on: bool| {
            let mut stored = record(1);
            stored[CUSTOM]["enabled"] = json!(custom_on);
            Some(stored)
        };
        ready.reinit_providers(|| stored(false)).await.unwrap();
        assert!(ready.registry.registered_for_route(CUSTOM).is_none(), "turned off");
        ready.reinit_providers(|| stored(true)).await.unwrap();
        assert!(ready.registry.registered_for_route(CUSTOM).is_some(), "turned on again");
        assert_eq!(held(&ready), on(1));
    }
    /// Review point 2: with a provider registered, an initialization that adds another is overtaken by an edit of
    /// the registered one. Its caller returns with both on the newest config, the registered one rebuilt; so does a
    /// ready call that begins after an edit no reinit has followed yet.
    #[tokio::test]
    async fn an_initialization_returns_with_a_registered_provider_on_the_newest_config() {
        let builder = Arc::new(HeldKeyIds::default());
        let ready = readiness_over(builder.clone()).await;
        let mut anthropic_only = record(1);
        anthropic_only.shift_remove(CUSTOM);
        ready.set_providers(anthropic_only);
        ready.ensure_providers_ready(None).await.unwrap();
        assert_eq!(held(&ready), Held { custom: None, ..on(1) });
        builder.held.store(true, Ordering::SeqCst);
        ready.set_providers(record(1));
        let older = ensure(&ready);
        builder.entered.notified().await;
        ready.set_providers(record(2));
        let newer = reinit(&ready, || Some(record(2)));
        run_others().await;
        builder.release.notify_one();
        let (result, at_return) = older.await.unwrap();
        result.unwrap();
        assert_eq!(at_return, on(2));
        newer.await.unwrap().0.unwrap();
        ready.set_providers(record(3));
        ready.ensure_providers_ready(None).await.unwrap();
        assert_eq!(held(&ready), on(3));
    }
    /// Review point 4: the only caller of a flight is cancelled while the flight reads key ids under the registry's
    /// permit. The flight goes on with no caller polling it and releases the permit, so a ready call that needs
    /// another flight is not held up.
    #[tokio::test]
    async fn a_flight_whose_caller_is_cancelled_runs_to_its_end() {
        let builder = Arc::new(HeldKeyIds { held: true.into(), ..HeldKeyIds::default() });
        let ready = readiness_over(builder.clone()).await;
        ready.set_providers(record(1));
        let only = ensure(&ready);
        builder.entered.notified().await;
        only.abort();
        assert!(only.await.unwrap_err().is_cancelled());
        builder.release.notify_one();
        run_others().await;
        assert_eq!(held(&ready), on(1), "the flight finished with no caller waiting for it");
        let mut another = record(1);
        another.insert("xai".into(), json!({"enabled": true}));
        ready.ensure_providers_ready(Some(another)).await.unwrap();
        assert!(ready.registry.registered("xai").is_some());
    }
    /// Interleaving 3: however many reinits arrive while an initialization runs, its caller waits on that one flight,
    /// which builds the record it began with and then the newest; no flight is started for the ones in between.
    #[tokio::test]
    async fn reinits_arriving_during_an_initialization_start_no_further_flights() {
        let builder = Arc::new(HeldKeyIds { held: true.into(), ..HeldKeyIds::default() });
        let ready = readiness_over(builder.clone()).await;
        ready.set_providers(record(1));
        let older = ensure(&ready);
        builder.entered.notified().await;
        let reinits: Vec<Returned> = (2..=9)
            .map(|k| {
                ready.set_providers(record(k));
                reinit(&ready, || None)
            })
            .collect();
        run_others().await;
        assert!(ready.gate().flights.is_empty(), "the superseded flight is dropped and none replaces it");
        builder.release.notify_one();
        let (result, at_return) = older.await.unwrap();
        result.unwrap();
        assert_eq!(at_return, on(9));
        for reinit in reinits {
            reinit.await.unwrap().0.unwrap();
        }
        assert_eq!(held(&ready), on(9));
        let built = |k: u64| [record(k)[CUSTOM].clone(), record(k)["anthropic"].clone()];
        assert_eq!(*builder.built.lock().unwrap(), [built(1), built(9)].concat(), "the record it began with, then the newest");
    }
    /// Interleaving 4: a reinit overtaken by a record whose application fails returns that failure, having changed
    /// nothing, and a later one that succeeds applies the newest record.
    #[tokio::test]
    async fn a_reinit_overtaken_by_a_record_that_fails_to_apply_returns_the_failure() {
        let builder = Arc::new(HeldKeyIds::default());
        let ready = readiness_over(builder.clone()).await;
        ready.set_providers(record(0));
        ready.ensure_providers_ready(None).await.unwrap();
        builder.held.store(true, Ordering::SeqCst);
        ready.set_providers(record(1));
        let older = reinit(&ready, || None);
        builder.entered.notified().await;
        ready.set_providers(record(2));
        builder.fail.store(true, Ordering::SeqCst);
        let newer = reinit(&ready, || None);
        run_others().await;
        builder.release.notify_one();
        let (result, at_return) = older.await.unwrap();
        assert!(result.unwrap_err().message.contains("boom"));
        assert_eq!(at_return, on(0), "a failed application changes nothing");
        assert!(newer.await.unwrap().0.is_err());
        assert_eq!(held(&ready), on(0));
        builder.fail.store(false, Ordering::SeqCst);
        ready.reinit_providers(|| None).await.unwrap();
        assert_eq!(held(&ready), on(2));
    }
    #[tokio::test]
    async fn every_invalidation_drops_the_caches_above_the_catalog() {
        use std::sync::atomic::AtomicUsize;
        let (ready, _) = readiness().await;
        assert!(!ready.invalidation_bound());
        ready.invalidate_provider_caches(true); // unbound: nothing else to drop
        let dropped = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&dropped);
        assert!(
            ready
                .bind_invalidation(Arc::new(move || {
                    counter.fetch_add(1, Ordering::SeqCst);
                }))
                .is_ok()
        );
        assert!(ready.invalidation_bound());
        ready.invalidate_provider_caches(true);
        ready.invalidate_provider_caches(false);
        assert_eq!(dropped.load(Ordering::SeqCst), 2, "both kinds of invalidation drop them");
        assert!(ready.bind_invalidation(Arc::new(|| {})).is_err(), "a second bind is refused");
    }
}

/// The 24 h catalog timer (`CATALOG_REFRESH_INTERVAL_MS`, registry.mjs:92).
pub const CATALOG_REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
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
impl ProviderReadiness {
    pub fn new(registry: Arc<ProviderRegistry>, catalog: Arc<CatalogService>) -> Arc<Self> {
        let revision = registry.clone();
        catalog.bind_revision(move || revision.catalog_revision());
        let providers = registry.clone();
        catalog.bind_providers(Arc::new(move |name| providers.route_provider(name)));
        let registered = registry.clone();
        catalog.bind_registered(move || registered.all().into_iter().map(|(name, adapter)| (ProviderId::from(name.as_str()), adapter)).collect());
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

    pub fn provider_registered(&self, id: &str) -> bool {
        self.registry.registered(id).is_some()
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

    /// The runtime's `config.providers`: the record every initialization and reinit builds the registry from. A change
    /// of them is a new generation.
    pub fn set_providers(&self, providers: Map<String, Value>) {
        let mut gate = self.gate();
        if gate.providers != providers {
            gate.providers = providers;
            gate.supersede();
        }
    }

    /// The runtime is closing: every later call fails.
    pub fn close(&self) {
        self.gate().closed = true;
    }

    /// `ensureProvidersReady(providerConfig)`: the registry initialized on the runtime's providers; `None` registers
    /// every provider they enable. A map says which providers the request needs: the ones it enables are the only
    /// missing ones registered. For a provider the runtime's providers hold, their entry is the config, whatever the
    /// map's says, so a map captured before they changed cannot put an older config back; for one they do not hold
    /// (a provider just saved, not yet loaded), the map's entry is, and it never replaces a registered provider.
    /// After the initialization, unless the runtime is closing, the startup catalog refresh of the current epoch is
    /// started or joined, and observed.
    pub async fn ensure_providers_ready(self: &Arc<Self>, providers: Option<Map<String, Value>>) -> Result<(), RegistryError> {
        self.init(providers).await?;
        if !self.gate().closed {
            self.observe_startup_refresh();
        }
        Ok(())
    }

    /// One keyed initialization: the flight of this generation that was asked for the same providers, or a new one.
    /// The key is the names alone: a request that names the same providers with other entries joins the flight, and
    /// the entries of the request that started it are the ones a provider the runtime's providers do not hold is
    /// built from.
    async fn init(self: &Arc<Self>, providers: Option<Map<String, Value>>) -> Result<(), RegistryError> {
        let (key, flight) = {
            let mut gate = self.gate();
            if gate.closed {
                return Err(closing());
            }
            let asked = providers.as_ref().map(asked_providers);
            let key: Option<Vec<String>> = asked.as_ref().map(|asked| asked.iter().map(|(name, _)| name.clone()).collect());
            let flight = gate.flights.entry(key.clone()).or_insert_with(|| self.start(asked)).clone();
            (key, flight)
        };
        let result = flight.clone().await;
        if result.is_err() {
            let mut gate = self.gate();
            if gate.flights.get(&key).is_some_and(|held| held.ptr_eq(&flight)) {
                gate.flights.remove(&key);
            }
        }
        result
    }

    /// Starts the flight of a request (`asked`: what its map enables, `None` for the runtime's providers) as its own
    /// task: it runs to its end, and releases the registry's permit, whether or not any caller still waits for it.
    fn start(self: &Arc<Self>, asked: Option<Vec<(String, Value)>>) -> Flight {
        let task = mixdog_rt::spawn("providers.init", mixdog_rt::TaskClass::Work, self.clone().initialize(asked));
        task.map(|joined| joined.unwrap_or_else(|error| Err(RegistryError { message: format!("provider initialization did not finish: {error}"), code: None })))
            .boxed()
            .shared()
    }

    /// The flight of a request. It ends when the registry is initialized on the runtime's providers with what the
    /// request asked for, as they are in the step the registry settles in (`Gate::read_for`), or with that
    /// initialization's error: a request superseded while it waits or builds registers the latest config in this same
    /// flight, and waits for no other.
    async fn initialize(self: Arc<Self>, asked: Option<Vec<(String, Value)>>) -> Result<(), RegistryError> {
        if self.gate().closed {
            return Err(closing());
        }
        let source = Newest { gate: &self.gate, read: |gate: &Gate| gate.read_for(asked.as_deref()), decisions: || None::<Map<String, Value>> };
        self.registry.init_providers_from(&source).await
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
            self.gate().supersede();
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

    /// The forced half of a catalog load in the model-proxy client mode: the PC's provider set read afresh and applied, even
    /// when readiness already settled on the old one. Nothing to do outside that mode.
    pub async fn reread_remote(&self) -> Result<(), RegistryError> {
        self.registry.reread_remote().await
    }

    /// `reinitProviders`: provider config or secrets changed. Everything keyed to the old ones is dropped and the
    /// registry is synced to the runtime's providers (`syncProviders(providerRecord(), { decisions })`): a registered
    /// provider whose config changed is rebuilt, one the stored `decisions` turned off (a deleted custom provider among
    /// them) is removed, and one they hold on that the runtime's providers enable is registered when it is missing, so
    /// a provider turned off and on again is back when the reinit of the second decision returns. One the decisions do
    /// not hold is not added. `decisions` reads the stored section, `None` when it does not read. It is never asked
    /// when the reinit is called: it is read under the gate's lock with the providers the sync builds, and again in
    /// the step that registers and removes, which settles only on decisions that are still the stored ones.
    pub async fn reinit_providers(&self, decisions: impl Fn() -> Option<Map<String, Value>> + Send + Sync) -> Result<(), RegistryError> {
        self.invalidate_provider_caches(false);
        if self.gate().closed {
            return Ok(());
        }
        let source = Newest { gate: &self.gate, read: |gate: &Gate| gate.read_for(None), decisions };
        self.registry.sync_providers_from(&source).await
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
