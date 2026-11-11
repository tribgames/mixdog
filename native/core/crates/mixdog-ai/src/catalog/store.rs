use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use arc_swap::ArcSwap;
use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_protocol::ProviderId;
use serde::Deserialize;
use serde::Serialize;

use super::failures::CatalogFailureStore;
use super::record::ModelRecord;
use super::sources::ModelSource;

/// The catalog at one generation; also the content of `catalogs/snapshot.json`.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    /// 0 is the compiled-in catalog; each completed refresh adds one.
    pub generation: u64,
    pub models: BTreeMap<ProviderId, Vec<ModelRecord>>,
    /// How the last listing of each provider went. A provider never listed
    /// has no entry.
    #[serde(default)]
    pub status: BTreeMap<ProviderId, ProviderStatus>,
}

/// The outcome of a provider's latest listing (`catalogMissing` /
/// `catalogRetryAt` in the picker contract).
#[derive(Clone, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum ProviderStatus {
    Ok,
    /// The listing failed or timed out; the provider's previous models are
    /// kept. It is asked again by a non-forced refresh once `retry_at` (epoch
    /// ms) has passed.
    #[serde(rename_all = "camelCase")]
    Missing { retry_at: u64, message: String },
}

impl CatalogSnapshot {
    /// `catalogComplete`: every listed provider answered.
    pub fn complete(&self) -> bool {
        self.status.values().all(|s| *s == ProviderStatus::Ok)
    }

    /// `catalogMissing`: the providers whose last listing failed.
    pub fn missing(&self) -> Vec<&ProviderId> {
        self.status
            .iter()
            .filter(|(_, s)| matches!(s, ProviderStatus::Missing { .. }))
            .map(|(id, _)| id)
            .collect()
    }

    /// `catalogPartial`: some providers answered and some did not.
    pub fn partial(&self) -> bool {
        !self.complete() && self.status.values().any(|s| *s == ProviderStatus::Ok)
    }

    /// `catalogRetryAt`: when the first missing provider may be asked again;
    /// only a partial answer has one.
    pub fn retry_at(&self) -> Option<u64> {
        if !self.partial() {
            return None;
        }
        self.status
            .values()
            .filter_map(|s| match s {
                ProviderStatus::Missing { retry_at, .. } => Some(*retry_at),
                ProviderStatus::Ok => None,
            })
            .min()
    }

    pub fn models_of(&self, provider: &ProviderId) -> &[ModelRecord] {
        self.models.get(provider).map_or(&[], Vec::as_slice)
    }

    pub fn to_json(&self) -> serde_json::Result<Vec<u8>> {
        serde_json::to_vec(self)
    }

    /// A cache that does not parse is dropped, never migrated: the catalog is
    /// rebuildable.
    pub fn from_json(bytes: &[u8]) -> Option<Self> {
        serde_json::from_slice(bytes).ok()
    }
}

/// What one refresh did to each provider.
#[derive(Debug)]
pub struct RefreshOutcome {
    pub refreshed: Vec<ProviderId>,
    /// Providers whose listing failed; their previous models are kept.
    pub failed: Vec<(ProviderId, ProviderError)>,
}

/// A provider listing's deadline (`PROVIDER_CATALOG_TIMEOUT_MS`).
pub const LIST_DEADLINE: Duration = Duration::from_secs(4);
/// Backoff before a provider that failed is asked again by a non-forced
/// refresh (`PROVIDER_CATALOG_RETRY_MS`).
pub const RETRY_AFTER_MS: u64 = 30_000;

/// Which providers a refresh asks.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ask {
    /// Every provider (a forced refresh).
    All,
    /// Providers never listed, and failed ones whose backoff has passed. When
    /// no provider has answered, everyone, so a total failure stays
    /// immediately retryable.
    Due,
}

type Listing = Result<Vec<ModelRecord>, ProviderError>;

/// A listing operation (`startOp`): driven on its own task until it settles,
/// whatever its callers do.
#[derive(Clone)]
struct Flight {
    epoch: u64,
    serial: u64,
    /// A caller's deadline passed while it waited on this operation (`op.timedOut`).
    timed_out: Arc<std::sync::atomic::AtomicBool>,
    work: Shared<BoxFuture<'static, Listing>>,
}

/// The operation tables of `catalog-deadline.mjs`. An operation leaves both only
/// when its work settles, never when a caller gives up.
#[derive(Default)]
struct Flights {
    /// `pendingOps`: the latest operation started for each provider.
    latest: HashMap<ProviderId, Flight>,
    /// `runningOps`: every unsettled operation of each provider, of any epoch.
    running: HashMap<ProviderId, Vec<Flight>>,
}

impl Flights {
    /// The settlement cleanup (`catalog-deadline.mjs:87-92`).
    fn settle(&mut self, provider: &ProviderId, serial: u64) {
        if self.latest.get(provider).is_some_and(|f| f.serial == serial) {
            self.latest.remove(provider);
        }
        if let Some(running) = self.running.get_mut(provider) {
            running.retain(|f| f.serial != serial);
            if running.is_empty() {
                self.running.remove(provider);
            }
        }
    }

    /// `isStalled(name, kind)`: an unsettled operation overran a deadline.
    fn stalled(&self, provider: &ProviderId) -> bool {
        self.running.get(provider).is_some_and(|ops| ops.iter().any(|f| f.timed_out.load(Ordering::SeqCst)))
    }
}

fn timeout_error(message: String) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
    err.code = Some("ETIMEDOUT".to_owned());
    err.message = message;
    err
}

pub(super) fn deadline_error(provider: &ProviderId) -> ProviderError {
    timeout_error(format!("provider \"{provider}\" catalog list did not finish within {}ms", LIST_DEADLINE.as_millis()))
}

/// A caller that finds its own operation past a deadline (`catalog-deadline.mjs:149`).
fn pending_error(provider: &ProviderId) -> ProviderError {
    timeout_error(format!("provider \"{provider}\" catalog list is still pending after its deadline"))
}

/// A caller of a newer epoch that finds an older operation stalled (`catalog-deadline.mjs:142`).
fn stalled_error(provider: &ProviderId) -> ProviderError {
    timeout_error(format!("provider \"{provider}\" catalog list ignored its deadline and is still pending"))
}

struct Listed {
    epoch: u64,
    /// Each listing with the instant it ended (`now_ms`): a failure's backoff
    /// runs from there, not from when the whole refresh publishes.
    entries: Vec<(ProviderId, Listing, u64)>,
    /// For a listing of the whole catalog, its providers: the published snapshot holds only these, as Node's catalog
    /// is one entry per provider registered when its load began (`sharedProviderCatalog`).
    whole: Option<Vec<ProviderId>>,
}

pub struct ProviderCatalog {
    current: ArcSwap<CatalogSnapshot>,
    /// Bumped on an auth/account change: listings started before it are not
    /// joined and publish nothing.
    epoch: AtomicU64,
    /// Serializes the epoch check + publish of a refresh against
    /// `invalidate_accounts`, so a stale listing can never land after the
    /// snapshot was cleared.
    publish_lock: Mutex<()>,
    serial: AtomicU64,
    flights: Arc<Mutex<Flights>>,
    /// Why each provider's latest listing failed (`providerCatalogFailure`).
    failures: Arc<CatalogFailureStore>,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    /// Test-only seam: runs after a listing is spawned and before the caller polls its deadline, standing in for a
    /// caller descheduled there while another worker runs the listing.
    #[cfg(test)]
    after_spawn: Option<Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>>,
}

impl ProviderCatalog {
    pub fn new(initial: CatalogSnapshot) -> Self {
        Self {
            current: ArcSwap::from_pointee(initial),
            epoch: AtomicU64::new(0),
            publish_lock: Mutex::new(()),
            serial: AtomicU64::new(0),
            flights: Arc::default(),
            failures: Arc::new(CatalogFailureStore::default()),
            now_ms: Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as u64)
            }),
            #[cfg(test)]
            after_spawn: None,
        }
    }

    /// Replaces the wall clock that stamps `retry_at` (tests).
    pub fn with_clock(mut self, now_ms: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        self.set_clock(now_ms);
        self
    }

    /// [`with_clock`](Self::with_clock) in place.
    pub fn set_clock(&mut self, now_ms: Arc<dyn Fn() -> u64 + Send + Sync>) {
        self.now_ms = now_ms;
    }

    /// An auth/account change (`invalidateSharedProviderCatalog`): the rows
    /// listed under the previous account are dropped, so the next due refresh
    /// asks every provider, and listings still running for the old one are
    /// neither joined nor published. They keep running, and one that stalled
    /// still holds its provider (`bumpProviderCatalogGeneration` leaves the
    /// operation tables alone).
    pub fn invalidate_accounts(&self) {
        let _publishing = self.publish_lock.lock().unwrap_or_else(PoisonError::into_inner);
        self.epoch.fetch_add(1, Ordering::SeqCst);
        // The failures belonged to the previous account too (`clearProviderCatalogFailures`).
        self.failures.clear();
        self.current.rcu(|current| {
            Arc::new(CatalogSnapshot {
                generation: current.generation + 1,
                models: BTreeMap::new(),
                status: BTreeMap::new(),
            })
        });
    }

    /// One bounded, single-flight listing (`boundedProviderCatalogOp`). The
    /// caller waits at most the deadline; the operation runs on until it
    /// settles, and while it overran a deadline nobody asks the provider again.
    async fn list_bounded(&self, source: &ModelSource, epoch: u64) -> Listing {
        let provider = source.provider().clone();
        // The deadline's instant is fixed before the listing can start (Node arms it synchronously, `CD:123-124`, and
        // runs the provider a microtask later, `:73-74`): another worker may run the listing at once, and its own
        // timer must never be due before this one.
        let deadline = mixdog_rt::time::sleep(LIST_DEADLINE);
        let flight = {
            let mut flights = self.flights.lock().unwrap_or_else(PoisonError::into_inner);
            match flights.latest.get(&provider) {
                // `catalog-deadline.mjs:146-150`: fail fast instead of waiting out another deadline.
                Some(flight) if flight.epoch == epoch && flight.timed_out.load(Ordering::SeqCst) => {
                    return Err(pending_error(&provider));
                }
                Some(flight) if flight.epoch == epoch => flight.clone(),
                // Superseded (`:140-145`): a stalled operation of any epoch holds the provider.
                _ if flights.stalled(&provider) => return Err(stalled_error(&provider)),
                _ => {
                    let serial = self.serial.fetch_add(1, Ordering::SeqCst);
                    let (source, tables, settled) = (source.clone(), self.flights.clone(), provider.clone());
                    // The work leaves the tables inside its own future, so no caller sees its answer while it is
                    // still listed (`settled.then` cleanup runs before the callers' races in Node).
                    let work: Shared<BoxFuture<'static, Listing>> = async move {
                        let listing = source.list().await;
                        tables.lock().unwrap_or_else(PoisonError::into_inner).settle(&settled, serial);
                        listing
                    }
                    .boxed()
                    .shared();
                    let flight = Flight { epoch, serial, timed_out: Arc::default(), work: work.clone() };
                    flights.latest.insert(provider.clone(), flight.clone());
                    flights.running.entry(provider.clone()).or_default().push(flight.clone());
                    tokio::spawn(work.map(drop));
                    flight
                }
            }
        };
        #[cfg(test)]
        if let Some(hook) = &self.after_spawn {
            hook().await;
        }
        // On a tie with the listing's own timer the deadline wins; poll it first.
        tokio::select! {
            biased;
            () = deadline => {
                flight.timed_out.store(true, Ordering::SeqCst);
                Err(deadline_error(&provider))
            }
            listing = flight.work => listing,
        }
    }

    /// The failure store (`providerCatalogFailure`).
    pub fn failures(&self) -> &Arc<CatalogFailureStore> {
        &self.failures
    }

    /// One atomic load; never waits on a refresh.
    pub fn snapshot(&self) -> Arc<CatalogSnapshot> {
        self.current.load_full()
    }

    /// Lists every source concurrently and publishes one new snapshot. A
    /// failing source keeps its previous models. Runs off the read path.
    pub async fn refresh(&self, sources: &[ModelSource]) -> RefreshOutcome {
        self.refresh_asking(sources, Ask::All).await
    }

    /// [`refresh`](Self::refresh), asking only the providers `ask` selects.
    pub async fn refresh_asking(&self, sources: &[ModelSource], ask: Ask) -> RefreshOutcome {
        let listed = self.list_all(sources, ask).await;
        self.publish(listed)
    }

    /// [`refresh_asking`](Self::refresh_asking) of the whole catalog: `sources` are every provider it has, so the
    /// models and status of any other (one removed from the registry since) leave the published snapshot.
    pub async fn refresh_whole(&self, sources: &[ModelSource], ask: Ask) -> RefreshOutcome {
        let mut listed = self.list_all(sources, ask).await;
        listed.whole = Some(sources.iter().map(|s| s.provider().clone()).collect());
        self.publish(listed)
    }

    /// Lists the providers `ask` selects, concurrently. A provider not asked
    /// is absent from the result and keeps its models and status.
    async fn list_all(&self, sources: &[ModelSource], ask: Ask) -> Listed {
        let epoch = self.epoch.load(Ordering::SeqCst);
        let now = (self.now_ms)();
        let current = self.current.load();
        let nobody_answered = !sources
            .iter()
            .any(|s| current.status.get(s.provider()) == Some(&ProviderStatus::Ok));
        let asked: Vec<&ModelSource> = sources
            .iter()
            .filter(|s| match ask {
                Ask::All => true,
                Ask::Due => {
                    nobody_answered
                        || match current.status.get(s.provider()) {
                            None => true,
                            Some(ProviderStatus::Ok) => false,
                            Some(ProviderStatus::Missing { retry_at, .. }) => now >= *retry_at,
                        }
                }
            })
            .collect();
        let entries = futures::future::join_all(asked.iter().map(|s| async move {
            let listing = self.list_bounded(s, epoch).await;
            (s.provider().clone(), listing, (self.now_ms)())
        }))
        .await;
        Listed { epoch, entries, whole: None }
    }

    fn publish(&self, listed: Listed) -> RefreshOutcome {
        let mut outcome = RefreshOutcome {
            refreshed: Vec::new(),
            failed: Vec::new(),
        };
        let mut answers = Vec::new();
        for (provider, listing, ended_at) in listed.entries {
            match listing {
                // Kept in listing order, as Node's catalog keeps it: the picker's sort is not total (duplicate ids,
                // comparator ties), so its answer depends on that order.
                Ok(list) => {
                    answers.push((provider.clone(), list, ProviderStatus::Ok));
                    outcome.refreshed.push(provider);
                }
                Err(err) => {
                    let status = ProviderStatus::Missing { retry_at: ended_at + RETRY_AFTER_MS, message: err.message.clone() };
                    answers.push((provider.clone(), Vec::new(), status));
                    outcome.failed.push((provider, err));
                }
            }
        }
        // Concurrent refreshes each publish a complete snapshot; the later
        // generation number wins. A listing begun before an account change
        // describes the previous account and is not published.
        let _publishing = self.publish_lock.lock().unwrap_or_else(PoisonError::into_inner);
        if self.epoch.load(Ordering::SeqCst) != listed.epoch {
            return outcome;
        }
        // Only a listing of the current account is recorded (`callerGeneration === generation`).
        for provider in &outcome.refreshed {
            self.failures.recover(provider.as_str());
        }
        for (provider, error) in &outcome.failed {
            self.failures.record(provider.as_str(), error);
        }
        self.current.rcu(|current| {
            let mut models = current.models.clone();
            let mut status = current.status.clone();
            for (provider, list, state) in &answers {
                if *state == ProviderStatus::Ok {
                    models.insert(provider.clone(), list.clone());
                }
                status.insert(provider.clone(), state.clone());
            }
            if let Some(whole) = &listed.whole {
                models.retain(|provider, _| whole.contains(provider));
                status.retain(|provider, _| whole.contains(provider));
            }
            Arc::new(CatalogSnapshot {
                generation: current.generation + 1,
                models,
                status,
            })
        });
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::FullProviderConfig;
    use crate::catalog::ProviderEntry;
    use crate::catalog::SourceFactory;
    use crate::catalog::build_sources;
    use async_trait::async_trait;
    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::provider::ErrorKind;

    use mixdog_core_api::domain::provider::ModelListing;
    use mixdog_core_api::domain::provider::ModelRecord as ListedRecord;

    struct Keyed {
        key: Option<String>,
    }

    #[async_trait]
    impl ModelListing for Keyed {
        async fn list_models(&self) -> Result<Vec<ListedRecord>, ProviderError> {
            match &self.key {
                Some(_) => Ok(vec![ListedRecord::new("m")]),
                None => Err(ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent)),
            }
        }
    }

    struct Factory;
    impl SourceFactory for Factory {
        fn source(&self, entry: &ProviderEntry) -> Option<Arc<dyn ModelListing>> {
            Some(Arc::new(Keyed { key: entry.settings.get("apiKey")?.as_str().map(str::to_owned) }))
        }
    }

    #[tokio::test]
    async fn sources_are_built_from_the_full_config_secrets_included() {
        let config = FullProviderConfig {
            providers: vec![
                ProviderEntry {
                    id: "a".into(),
                    enabled: true,
                    settings: serde_json::json!({"apiKey": "sk-live"}),
                },
                ProviderEntry {
                    id: "off".into(),
                    enabled: false,
                    settings: serde_json::json!({"apiKey": "x"}),
                },
            ],
        };
        let sources = build_sources(&config, &Factory);
        assert_eq!(sources.len(), 1);
        let catalog = ProviderCatalog::new(CatalogSnapshot::default());
        let outcome = catalog.refresh(&sources).await;
        assert_eq!(outcome.refreshed, vec![ProviderId::from("a")]);
        assert_eq!(catalog.snapshot().models_of(&"a".into()).len(), 1);
        assert_eq!(catalog.snapshot().generation, 1);
    }

    /// Lists after `delay` (never, when `None`) and counts the calls.
    struct Slow {
        delay: Option<Duration>,
        calls: Arc<AtomicU64>,
    }

    #[async_trait]
    impl ModelListing for Slow {
        async fn list_models(&self) -> Result<Vec<ListedRecord>, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match self.delay {
                Some(delay) => mixdog_rt::time::sleep(delay).await,
                None => std::future::pending::<()>().await,
            }
            Ok(vec![ListedRecord::new("m")])
        }
    }

    fn slow(id: &str, delay: Option<Duration>) -> (ModelSource, Arc<AtomicU64>) {
        let calls = Arc::new(AtomicU64::new(0));
        (ModelSource::new(id.into(), Arc::new(Slow { delay, calls: calls.clone() })), calls)
    }

    /// Fails at once and counts the calls.
    struct Failing(Arc<AtomicU64>);

    #[async_trait]
    impl ModelListing for Failing {
        async fn list_models(&self) -> Result<Vec<ListedRecord>, ProviderError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
        }
    }

    fn failing(id: &str) -> (ModelSource, Arc<AtomicU64>) {
        let calls = Arc::new(AtomicU64::new(0));
        (ModelSource::new(id.into(), Arc::new(Failing(calls.clone()))), calls)
    }

    fn clocked(clock: &Arc<AtomicU64>) -> ProviderCatalog {
        let clock = clock.clone();
        ProviderCatalog::new(CatalogSnapshot::default()).with_clock(Arc::new(move || clock.load(Ordering::SeqCst)))
    }

    #[tokio::test(start_paused = true)]
    async fn a_provider_past_its_deadline_is_missing_with_a_backoff_and_keeps_its_models() {
        let clock = Arc::new(AtomicU64::new(1_000));
        let catalog = clocked(&clock);
        let (fast, _) = slow("fast", Some(Duration::from_millis(10)));
        let (hung, _) = slow("hung", None);
        let first = catalog.refresh(&[fast.clone(), hung.clone()]).await;
        assert_eq!(first.failed.len(), 1);
        let snap = catalog.snapshot();
        assert!(snap.partial() && !snap.complete());
        assert_eq!(snap.missing(), vec![&ProviderId::from("hung")]);
        assert_eq!(snap.retry_at(), Some(31_000));
        assert_eq!(snap.models_of(&"fast".into()).len(), 1);

        // A provider that answered once keeps its models through a failure.
        let kept = clocked(&clock);
        let (ok, _) = slow("hung", Some(Duration::from_millis(1)));
        kept.refresh(&[fast.clone(), ok]).await;
        kept.refresh(&[fast, hung]).await;
        assert_eq!(kept.snapshot().models_of(&"hung".into()).len(), 1);
        assert!(kept.snapshot().partial());
    }

    #[tokio::test(start_paused = true)]
    async fn a_due_refresh_waits_out_the_backoff_and_a_total_failure_is_retried_at_once() {
        let clock = Arc::new(AtomicU64::new(0));
        let catalog = clocked(&clock);
        let (good, good_calls) = slow("good", Some(Duration::from_millis(1)));
        let (bad, bad_calls) = failing("bad");
        let sources = [good, bad];
        catalog.refresh_asking(&sources, Ask::Due).await;
        assert_eq!((good_calls.load(Ordering::SeqCst), bad_calls.load(Ordering::SeqCst)), (1, 1));
        // Inside the backoff only nothing is due: the partial answer stands.
        clock.store(29_999, Ordering::SeqCst);
        catalog.refresh_asking(&sources, Ask::Due).await;
        assert_eq!((good_calls.load(Ordering::SeqCst), bad_calls.load(Ordering::SeqCst)), (1, 1));
        clock.store(30_000, Ordering::SeqCst);
        catalog.refresh_asking(&sources, Ask::Due).await;
        assert_eq!((good_calls.load(Ordering::SeqCst), bad_calls.load(Ordering::SeqCst)), (1, 2));
        // Forced asks everyone.
        catalog.refresh(&sources).await;
        assert_eq!(good_calls.load(Ordering::SeqCst), 2);

        let (only, only_calls) = failing("only");
        let total = clocked(&clock);
        total.refresh_asking(std::slice::from_ref(&only), Ask::Due).await;
        total.refresh_asking(std::slice::from_ref(&only), Ask::Due).await;
        assert_eq!(only_calls.load(Ordering::SeqCst), 2, "nobody answered: not held back");
        assert_eq!(total.snapshot().retry_at(), None, "a total failure has no retry time");
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_refreshes_share_one_listing_per_provider() {
        let clock = Arc::new(AtomicU64::new(0));
        let catalog = clocked(&clock);
        let (one, calls) = slow("one", Some(Duration::from_millis(100)));
        let sources = [one];
        futures::future::join(catalog.refresh(&sources), catalog.refresh(&sources)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(catalog.snapshot().complete());
    }

    /// Node's deadline timer is armed before the listing's own 4 s timer, so a listing that ends exactly at the deadline
    /// (a cold Claude OAuth warm against an unreachable registry) has missed it (`record-catalog-deadline-tie.mjs`).
    /// Three unforced reads, each against its own recorded point: the first, answered while the tied listing is still
    /// pending; one at once, while it still is; and one after it settled at the same instant. Each publishes Node's
    /// models and state at Node's time, asks the providers Node asked and leaves Node's operations pending.
    #[tokio::test(start_paused = true)]
    async fn a_listing_ending_exactly_at_the_deadline_reads_as_nodes_at_each_point() {
        let golden: serde_json::Value = serde_json::from_str(include_str!("../../../../fixtures/catalog-deadline-tie/golden.json")).unwrap();
        let now = golden["now"].as_u64().unwrap();
        // One virtual clock for the whole recording, as the recorder's.
        let start = tokio::time::Instant::now();
        let at = move || start.elapsed().as_millis() as u64;
        for scenario in golden["scenarios"].as_array().unwrap() {
            let name = scenario["name"].as_str().unwrap();
            let catalog = ProviderCatalog::new(CatalogSnapshot::default()).with_clock(Arc::new(move || now + at()));
            let (sources, calls): (Vec<_>, Vec<_>) = scenario["providers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| slow(p["name"].as_str().unwrap(), Some(Duration::from_millis(p["answersAfterMs"].as_u64().unwrap()))))
                .unzip();
            let mut codes = BTreeMap::new();
            for point in ["first", "whilePending", "afterSettle"] {
                if point == "afterSettle" {
                    // The tied listing's own timer, at the instant the deadline fired; its settlement leaves the table.
                    latest_work(&catalog, "tie").await.unwrap();
                    assert_eq!(pending_ops(&catalog).0, scenario["settledOps"], "{name}: operations once the listing settled");
                }
                read_as_recorded(&catalog, &sources, &calls, &mut codes, now, &at, &scenario[point], &format!("{name}: {point}")).await;
            }
            drain(&catalog, name).await;
        }
    }

    /// `record-catalog-deadline-tie.mjs` `crossEpoch`: a listing overruns its deadline, an account change opens a new
    /// epoch, and the new epoch's read fails on the still-unsettled operation ("ignored its deadline") without asking
    /// the provider; once that listing settles a read asks again. Each point against its own recording.
    #[tokio::test(start_paused = true)]
    async fn a_stalled_listing_holds_its_provider_across_an_account_change_as_nodes() {
        let golden: serde_json::Value = serde_json::from_str(include_str!("../../../../fixtures/catalog-deadline-tie/golden.json")).unwrap();
        let now = golden["now"].as_u64().unwrap();
        let scenario = &golden["crossEpoch"];
        let name = scenario["name"].as_str().unwrap();
        let start = tokio::time::Instant::now();
        let at = move || start.elapsed().as_millis() as u64;
        // The recorder's virtual clock runs on from the scenarios before this one.
        tokio::time::advance(Duration::from_millis(scenario["startedAt"].as_u64().unwrap())).await;
        let catalog = ProviderCatalog::new(CatalogSnapshot::default()).with_clock(Arc::new(move || now + at()));
        let (sources, calls): (Vec<_>, Vec<_>) = scenario["providers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| slow(p["name"].as_str().unwrap(), Some(Duration::from_millis(p["answersAfterMs"].as_u64().unwrap()))))
            .unzip();
        let mut codes = BTreeMap::new();
        for point in ["first", "afterAccountChange", "afterSettle"] {
            match point {
                "afterAccountChange" => catalog.invalidate_accounts(),
                "afterSettle" => {
                    // The old epoch's listing runs to its own timer; its settlement leaves both tables.
                    latest_work(&catalog, "stall").await.unwrap();
                    let (ops, stalled) = pending_ops(&catalog);
                    assert_eq!(ops, scenario["settledOps"], "{name}: operations once the listing settled");
                    assert_eq!(stalled, scenario["settledStalled"], "{name}: stalled operations once it settled");
                }
                _ => {}
            }
            read_as_recorded(&catalog, &sources, &calls, &mut codes, now, &at, &scenario[point], &format!("{name}: {point}")).await;
        }
        drain(&catalog, name).await;
    }

    /// A caller descheduled between starting the listing and polling its deadline, while the listing runs to its own
    /// 4 s timer (on another worker in production; here the seam yields to it and moves time on): the deadline was
    /// fixed when the caller came in, so the tie still reads as Node's first point, a missed deadline at 4000 ms.
    #[tokio::test(start_paused = true)]
    async fn a_caller_descheduled_after_starting_the_listing_still_misses_a_tied_deadline() {
        let golden: serde_json::Value = serde_json::from_str(include_str!("../../../../fixtures/catalog-deadline-tie/golden.json")).unwrap();
        let recorded = &golden["scenarios"][0]["first"];
        let start = tokio::time::Instant::now();
        let (tie, calls) = slow("tie", Some(LIST_DEADLINE));
        let mut catalog = ProviderCatalog::new(CatalogSnapshot::default());
        let (flights, started) = (catalog.flights.clone(), calls.clone());
        catalog.after_spawn = Some(Arc::new(move || {
            let (flights, started) = (flights.clone(), started.clone());
            async move {
                // The listing starts and arms its own timer,
                while started.load(Ordering::SeqCst) == 0 {
                    tokio::task::yield_now().await;
                }
                // then reaches it and settles before the caller runs again.
                tokio::time::advance(LIST_DEADLINE).await;
                while !flights.lock().unwrap().running.is_empty() {
                    tokio::task::yield_now().await;
                }
            }
            .boxed()
        }));
        let outcome = catalog.refresh_asking(std::slice::from_ref(&tie), Ask::Due).await;
        let failed: Vec<serde_json::Value> = outcome
            .failed
            .iter()
            .map(|(p, e)| serde_json::json!({ "name": p.as_str(), "models": [], "error": { "code": e.code, "message": e.message } }))
            .collect();
        let mut expected = recorded["entries"].clone();
        expected[0].as_object_mut().unwrap().remove("retryAt");
        assert_eq!(serde_json::Value::Array(failed), expected);
        assert_eq!(serde_json::json!(start.elapsed().as_millis() as u64), recorded["at"]);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// The latest operation's work for `provider`.
    fn latest_work(catalog: &ProviderCatalog, provider: &str) -> Shared<BoxFuture<'static, Listing>> {
        catalog.flights.lock().unwrap().latest[&ProviderId::from(provider)].work.clone()
    }

    /// `pendingProviderCatalogOps()` and `stalledProviderCatalogOps()`.
    fn pending_ops(catalog: &ProviderCatalog) -> (serde_json::Value, serde_json::Value) {
        let flights = catalog.flights.lock().unwrap();
        let names: Vec<&str> = flights.latest.keys().map(ProviderId::as_str).collect();
        let stalled: Vec<serde_json::Value> = flights
            .running
            .iter()
            .flat_map(|(p, ops)| ops.iter().filter(|f| f.timed_out.load(Ordering::SeqCst)).map(move |_| p))
            .map(|p| serde_json::json!({ "name": p.as_str(), "kind": "list" }))
            .collect();
        (serde_json::json!(names), serde_json::Value::Array(stalled))
    }

    /// One unforced read, compared with its recorded point: entries, provider calls, time, pending and stalled
    /// operations. `codes` keeps the latest listing's error code per provider: what Node's kept entry carries.
    #[allow(clippy::too_many_arguments)]
    async fn read_as_recorded(
        catalog: &ProviderCatalog,
        sources: &[ModelSource],
        calls: &[Arc<AtomicU64>],
        codes: &mut BTreeMap<ProviderId, Option<String>>,
        now: u64,
        at: &impl Fn() -> u64,
        recorded: &serde_json::Value,
        label: &str,
    ) {
        let outcome = catalog.refresh_asking(sources, Ask::Due).await;
        for (provider, error) in &outcome.failed {
            codes.insert(provider.clone(), error.code.clone());
        }
        let snapshot = catalog.snapshot();
        let entries: Vec<serde_json::Value> = sources
            .iter()
            .map(|s| {
                let provider = s.provider();
                let mut entry = serde_json::json!({
                    "name": provider.as_str(),
                    "models": snapshot.models_of(provider).iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
                });
                if let Some(ProviderStatus::Missing { retry_at, message }) = snapshot.status.get(provider) {
                    entry["error"] = serde_json::json!({ "code": codes[provider], "message": message });
                    entry["retryAt"] = serde_json::json!(retry_at - now);
                }
                entry
            })
            .collect();
        assert_eq!(serde_json::Value::Array(entries), recorded["entries"], "{label} entries");
        let asked: serde_json::Map<String, serde_json::Value> = sources
            .iter()
            .zip(calls)
            .map(|(s, c)| (s.provider().as_str().to_owned(), c.load(Ordering::SeqCst).into()))
            .collect();
        assert_eq!(serde_json::Value::Object(asked), recorded["calls"], "{label}: providers asked");
        assert_eq!(serde_json::json!(at()), recorded["at"], "{label}: time");
        let (names, stalled) = pending_ops(catalog);
        assert_eq!(names, recorded["pendingOps"], "{label}: operations pending");
        assert_eq!(stalled, recorded["stalled"], "{label}: operations stalled");
    }

    /// A listing the last read started runs to its end, as the recorder drives it; nothing pends afterwards.
    async fn drain(catalog: &ProviderCatalog, name: &str) {
        let left = catalog.flights.lock().unwrap().latest.values().map(|f| f.work.clone()).collect::<Vec<_>>();
        for work in left {
            let _ = work.await;
        }
        assert!(catalog.flights.lock().unwrap().running.is_empty(), "{name}: nothing pends at the end");
    }

    #[tokio::test(start_paused = true)]
    async fn a_listing_begun_before_an_account_change_is_not_published() {
        let clock = Arc::new(AtomicU64::new(0));
        let catalog = clocked(&clock);
        let (one, calls) = slow("one", Some(Duration::from_millis(100)));
        let sources = [one];
        let refresh = catalog.refresh(&sources);
        let change = async {
            mixdog_rt::time::sleep(Duration::from_millis(10)).await;
            catalog.invalidate_accounts();
        };
        futures::future::join(refresh, change).await;
        assert!(catalog.snapshot().models_of(&"one".into()).is_empty());
        assert!(catalog.snapshot().status.is_empty());
        catalog.refresh(&sources).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2, "the new epoch asks again");
        assert_eq!(catalog.snapshot().models_of(&"one".into()).len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failures_backoff_runs_from_when_it_failed_not_from_the_slowest_listing() {
        let start = tokio::time::Instant::now();
        let catalog = ProviderCatalog::new(CatalogSnapshot::default())
            .with_clock(Arc::new(move || 1_000 + start.elapsed().as_millis() as u64));
        let failing = ModelSource::new("a".into(), Arc::new(Keyed { key: None }));
        let (slow_ok, _) = slow("b", Some(Duration::from_secs(3)));
        catalog.refresh(&[failing, slow_ok]).await;
        match catalog.snapshot().status.get(&ProviderId::from("a")) {
            Some(ProviderStatus::Missing { retry_at, .. }) => assert_eq!(*retry_at, 1_000 + RETRY_AFTER_MS),
            other => panic!("a should be missing, got {other:?}"),
        }
    }

    #[test]
    #[allow(clippy::disallowed_methods, reason = "test: gives a real thread time to block on the held publish lock")]
    fn an_account_change_cannot_land_inside_a_publish() {
        let catalog = Arc::new(ProviderCatalog::new(CatalogSnapshot::default()));
        let publishing = catalog.publish_lock.lock().unwrap();
        let changer = {
            let catalog = catalog.clone();
            std::thread::spawn(move || catalog.invalidate_accounts())
        };
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(catalog.epoch.load(Ordering::SeqCst), 0, "the change waits for the publish to finish");
        drop(publishing);
        changer.join().unwrap();
        assert_eq!(catalog.epoch.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_source_keeps_previous_models_and_snapshot_round_trips() {
        let catalog = ProviderCatalog::new(CatalogSnapshot::default());
        let good = ModelSource::new("a".into(), Arc::new(Keyed { key: Some("k".into()) }));
        catalog.refresh(&[good]).await;
        let broken = ModelSource::new("a".into(), Arc::new(Keyed { key: None }));
        let outcome = catalog.refresh(&[broken]).await;
        assert_eq!(outcome.failed.len(), 1);
        let snap = catalog.snapshot();
        assert_eq!(snap.models_of(&"a".into()).len(), 1);
        let again = CatalogSnapshot::from_json(&snap.to_json().unwrap()).unwrap();
        assert_eq!(&again, &*snap);
        assert!(CatalogSnapshot::from_json(b"not json").is_none());
    }
}