//! The `modelCatalog` section (`model/catalog/updated`): the `model/list` rows, pushed whenever they change.
//!
//! Node pushed no catalog. A client that changed a provider (`PROVIDER_KEYS` in `sidebar-reference-cache.ts`: a key, a custom
//! provider, a model's visibility, the accounts, an install, the developer options) sent a `provider-models-changed` hint
//! (`desktop-operations.ts:455`), the relay forwarded it, and every other client dropped its cached model picker and read
//! `listProviderModels` again. The core publishes its own changes instead (`desktop-services.md` §3, `notifyProviderModelsChanged`
//! deleted), so the hint has no sender: the same re-read is a push of the rows when the rows differ from the last published ones.
//! What can move the rows is what Node's mutations ended in:
//! - `invalidateProviderCaches` (the readiness' invalidation, after every credential, provider or catalog change): the rows are
//!   read again, loading the catalog;
//! - a stored config change (`setModelPreferences` of a built-in provider only reloads the config, and the rows are hydrated with
//!   the saved settings at read time): the rows are read again when they were loaded;
//! - a load adopting its rows, which is the first value of the section.
//!
//! A re-read that gives the rows already published publishes nothing, where Node's clients re-fetched after every resolved call: the
//! re-fetch showed nothing new there, and the revision makes that equivalent. A catalog refresh that moves the rows without a
//! mutation reaches the clients here at once, where Node's reached them at their next read (U-SV1).

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use mixdog_core_api::state::StatePublisher;
use mixdog_protocol::SectionName;
use serde_json::Value;
use tokio::sync::Notify;
use tokio::sync::watch;

use super::model_list::ModelListService;
use crate::domains::ai_account::account::SectionPush;

const SETTLE: std::time::Duration = std::time::Duration::from_millis(50);

pub struct ModelCatalogFeed {
    models: Arc<ModelListService>,
    pushed: SectionPush,
    wake: Notify,
    /// The next wake is an invalidation: the rows are loaded again, not read from a loaded catalog only.
    reload: AtomicBool,
}

impl ModelCatalogFeed {
    pub fn new(models: Arc<ModelListService>, publisher: Arc<dyn StatePublisher>) -> Arc<Self> {
        Arc::new(Self { models, pushed: SectionPush::new(publisher), wake: Notify::new(), reload: AtomicBool::new(false) })
    }

    /// The feed and its task: it follows `config` and the loads of `models`, and the invalidations it is told of.
    pub fn start(models: Arc<ModelListService>, publisher: Arc<dyn StatePublisher>, mut config: watch::Receiver<u64>) -> Arc<Self> {
        let feed = Self::new(models, publisher);
        let filled = feed.models.filled();
        let task = feed.clone();
        drop(mixdog_rt::spawn("model-catalog-feed", mixdog_rt::TaskClass::Work, async move {
            // A catalog loaded before the feed started is the first value.
            task.refresh(false).await;
            loop {
                tokio::select! {
                    () = task.wake.notified() => {}
                    changed = config.changed() => if changed.is_err() { return },
                    () = filled.notified() => {}
                }
                // One change wakes several of these in a row (the stored config, the invalidation, the load it starts): read once.
                tokio::time::sleep(SETTLE).await;
                let reload = task.reload.swap(false, Ordering::SeqCst);
                task.refresh(reload).await;
            }
        }));
        feed
    }

    /// `invalidateProviderCaches` ran: the rows may have moved, and the catalog has to be loaded again to say.
    pub fn invalidated(&self) {
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
