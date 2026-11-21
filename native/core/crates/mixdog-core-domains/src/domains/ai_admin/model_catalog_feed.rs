//! The `modelCatalog` section (`model/catalog/updated`): the `model/list` rows, pushed when a trigger changes them.
//!
//! Triggers: the readiness' invalidation (the rows are loaded again; not the one a settled startup catalog refresh
//! makes, see [`FeedToldDrop`]) and a stored config change that leaves `providers` alone (the rows are read again
//! when they were loaded). A change of the stored providers waits for its invalidation. Rows equal to the published
//! ones publish nothing, and a catalog load that completes on its own publishes nothing: the rows go out at the
//! next trigger.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_core_api::state::StatePublisher;
use mixdog_protocol::SectionName;
use serde_json::Value;
use tokio::sync::Notify;
use tokio::sync::watch;

use super::model_list::ModelListService;
use crate::domains::ai_account::account::SectionPush;

/// The readiness' invalidation with the feed: `drop` drops the caches every invalidation drops, and the feed is told of each
/// invalidation but the one a settled startup catalog refresh makes.
pub struct FeedToldDrop {
    pub drop: Arc<dyn Fn() + Send + Sync>,
    pub feed: Arc<ModelCatalogFeed>,
}

impl mixdog_ai::catalog::CacheDrop for FeedToldDrop {
    fn drop_caches(&self) {
        (self.drop)();
        self.feed.invalidated();
    }

    fn drop_caches_after_refresh(&self) {
        (self.drop)();
    }
}

pub struct ModelCatalogFeed {
    models: Arc<ModelListService>,
    pushed: SectionPush,
    wake: Notify,
    /// The next wake is an invalidation: the rows are loaded again, not read from a loaded catalog only.
    reload: AtomicBool,
    /// The invalidations the feed was told of, so a test sees at once whether a mutation's invalidation reached it.
    invalidations: AtomicU64,
}

impl ModelCatalogFeed {
    pub fn new(models: Arc<ModelListService>, publisher: Arc<dyn StatePublisher>) -> Arc<Self> {
        Arc::new(Self { models, pushed: SectionPush::new(publisher), wake: Notify::new(), reload: AtomicBool::new(false), invalidations: AtomicU64::new(0) })
    }

    pub fn invalidations(&self) -> u64 {
        self.invalidations.load(Ordering::SeqCst)
    }

    /// The feed and its task: it follows the loaded config (`applied` of the provider sync: a stored change is read once the
    /// loaded config has it) and the first load of `models`, and the invalidations it is told of.
    pub fn start(models: Arc<ModelListService>, publisher: Arc<dyn StatePublisher>, mut config: watch::Receiver<u64>) -> Arc<Self> {
        let feed = Self::new(models, publisher);
        let task = feed.clone();
        drop(mixdog_rt::spawn("model-catalog-feed", mixdog_rt::TaskClass::Work, async move {
            let mut providers = task.models.config.agent().get("providers").cloned();
            loop {
                let mut stored = false;
                // Only Node's triggers wake it: a load finishing on its own (a warm-up, a partial refill) is not one.
                tokio::select! {
                    () = task.wake.notified() => {}
                    changed = config.changed() => if changed.is_err() { return } else { stored = true },
                }
                if stored {
                    let now = task.models.config.agent().get("providers").cloned();
                    if std::mem::replace(&mut providers, now.clone()) != now {
                        continue;
                    }
                }
                let reload = task.reload.swap(false, Ordering::SeqCst);
                task.refresh(reload).await;
            }
        }));
        feed
    }

    /// `invalidateProviderCaches` ran: the rows may have moved, and the catalog has to be loaded again to say.
    pub fn invalidated(&self) {
        self.invalidations.fetch_add(1, Ordering::SeqCst);
        self.reload.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }

    /// Publishes the rows unless they are the ones published last. Without `load`, only a loaded catalog is read: a config change
    /// does not by itself start a provider load. A read that fails keeps the last rows.
    pub async fn refresh(&self, load: bool) {
        if !load && !self.models.cache_loaded() {
            return;
        }
        match self.models.rows(false, false).await {
            Ok(rows) => self.pushed.push(SectionName::ModelCatalog, None, Value::Array(rows)),
            Err(error) => tracing::warn!(%error, "[model-catalog] the rows could not be read"),
        }
    }
}
