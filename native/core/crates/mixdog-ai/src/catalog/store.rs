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

/// The one listing in flight for a provider. Joined by callers of the same
/// account epoch; dropping the last handle cancels the work.
struct Flight {
    epoch: u64,
    serial: u64,
    work: Shared<BoxFuture<'static, Listing>>,
}

fn deadline_error(provider: &ProviderId) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent);
    err.code = Some("ETIMEDOUT".to_owned());
    err.message = format!(
        "provider \"{provider}\" catalog list did not finish within {}ms",
        LIST_DEADLINE.as_millis()
    );
    err
}

struct Listed {
    epoch: u64,
    /// Each listing with the instant it ended (`now_ms`): a failure's backoff
    /// runs from there, not from when the whole refresh publishes.
    entries: Vec<(ProviderId, Listing, u64)>,
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
    flights: Mutex<HashMap<ProviderId, Flight>>,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
}

impl ProviderCatalog {
    pub fn new(initial: CatalogSnapshot) -> Self {
        Self {
            current: ArcSwap::from_pointee(initial),
            epoch: AtomicU64::new(0),
            publish_lock: Mutex::new(()),
            serial: AtomicU64::new(0),
            flights: Mutex::new(HashMap::new()),
            now_ms: Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as u64)
            }),
        }
    }

    /// Replaces the wall clock that stamps `retry_at` (tests).
    pub fn with_clock(mut self, now_ms: Arc<dyn Fn() -> u64 + Send + Sync>) -> Self {
        self.now_ms = now_ms;
        self
    }

    /// An auth/account change (`invalidateSharedProviderCatalog`): the rows
    /// listed under the previous account are dropped, so the next due refresh
    /// asks every provider, and listings still running for the old one are
    /// neither joined nor published.
    pub fn invalidate_accounts(&self) {
        let _publishing = self.publish_lock.lock().unwrap_or_else(PoisonError::into_inner);
        self.epoch.fetch_add(1, Ordering::SeqCst);
        self.flights.lock().unwrap_or_else(PoisonError::into_inner).clear();
        self.current.rcu(|current| {
            Arc::new(CatalogSnapshot {
                generation: current.generation + 1,
                models: BTreeMap::new(),
                status: BTreeMap::new(),
            })
        });
    }

    /// One bounded, single-flight listing (`boundedProviderCatalogOp`). A
    /// listing that misses the deadline is dropped, which cancels it.
    async fn list_bounded(&self, source: &ModelSource, epoch: u64) -> Listing {
        let provider = source.provider().clone();
        let (serial, work) = {
            let mut flights = self.flights.lock().unwrap_or_else(PoisonError::into_inner);
            match flights.get(&provider) {
                Some(flight) if flight.epoch == epoch => (flight.serial, flight.work.clone()),
                _ => {
                    let serial = self.serial.fetch_add(1, Ordering::SeqCst);
                    let source = source.clone();
                    let work: Shared<BoxFuture<'static, Listing>> =
                        async move { source.list().await }.boxed().shared();
                    flights.insert(provider.clone(), Flight { epoch, serial, work: work.clone() });
                    (serial, work)
                }
            }
        };
        let outcome = tokio::time::timeout(LIST_DEADLINE, work).await;
        let mut flights = self.flights.lock().unwrap_or_else(PoisonError::into_inner);
        if flights.get(&provider).is_some_and(|f| f.serial == serial) {
            flights.remove(&provider);
        }
        match outcome {
            Ok(listing) => listing,
            Err(_) => Err(deadline_error(&provider)),
        }
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
        Listed { epoch, entries }
    }

    fn publish(&self, listed: Listed) -> RefreshOutcome {
        let mut outcome = RefreshOutcome {
            refreshed: Vec::new(),
            failed: Vec::new(),
        };
        let mut answers = Vec::new();
        for (provider, listing, ended_at) in listed.entries {
            match listing {
                Ok(mut list) => {
                    list.sort_by(|a, b| a.id.cmp(&b.id));
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
        self.current.rcu(|current| {
            let mut models = current.models.clone();
            let mut status = current.status.clone();
            for (provider, list, state) in &answers {
                if *state == ProviderStatus::Ok {
                    models.insert(provider.clone(), list.clone());
                }
                status.insert(provider.clone(), state.clone());
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
                Some(delay) => tokio::time::sleep(delay).await,
                None => std::future::pending::<()>().await,
            }
            Ok(vec![ListedRecord::new("m")])
        }
    }

    fn slow(id: &str, delay: Option<Duration>) -> (ModelSource, Arc<AtomicU64>) {
        let calls = Arc::new(AtomicU64::new(0));
        (ModelSource::new(id.into(), Arc::new(Slow { delay, calls: calls.clone() })), calls)
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
        let (now_ok, _) = slow("hung", Some(Duration::from_millis(1)));
        catalog.refresh(&[fast.clone(), now_ok]).await;
        let (hung_again, _) = slow("hung", None);
        catalog.refresh(&[fast, hung_again]).await;
        assert_eq!(catalog.snapshot().models_of(&"hung".into()).len(), 1);
        assert!(catalog.snapshot().partial());
    }

    #[tokio::test(start_paused = true)]
    async fn a_due_refresh_waits_out_the_backoff_and_a_total_failure_is_retried_at_once() {
        let clock = Arc::new(AtomicU64::new(0));
        let catalog = clocked(&clock);
        let (good, good_calls) = slow("good", Some(Duration::from_millis(1)));
        let (bad, bad_calls) = slow("bad", None);
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

        let (only, only_calls) = slow("only", None);
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

    #[tokio::test(start_paused = true)]
    async fn a_listing_begun_before_an_account_change_is_not_published() {
        let clock = Arc::new(AtomicU64::new(0));
        let catalog = clocked(&clock);
        let (one, calls) = slow("one", Some(Duration::from_millis(100)));
        let sources = [one];
        let refresh = catalog.refresh(&sources);
        let change = async {
            tokio::time::sleep(Duration::from_millis(10)).await;
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