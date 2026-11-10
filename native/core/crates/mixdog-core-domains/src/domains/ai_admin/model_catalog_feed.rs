//! The `modelCatalog` section (`model/catalog/updated`): the `model/list` rows, pushed when they changed at a trigger Node's clients refreshed on.
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
//!
//! A load adopting its rows is not on this list (below): it moves what a reader gets, and no client is told.
//!
//! Node's signals, at `b6f10295a`, and what each does to the catalog a reader gets (none has a timer):
//! - the readiness invalidation: `invalidateProviderCaches` drops the caches synchronously (`provider-readiness.mjs:68-80`);
//!   `adoptCredentials` follows it with a warm load (`provider-auth/refresh.mjs:38-43`, `provider-models.mjs:194-`), and the next
//!   read starts one shared load (`provider-models.mjs:145-157`, readers `:189-190`) that every concurrent reader joins: Node
//!   coalesces concurrent reads into one load, not wakes;
//! - a config change that changes `providers`: every such mutation ends in `afterCredentialChange` (`refresh.mjs:48-51`, called at
//!   `login.mjs:66,77,83,88,104`), the config applied and then the invalidation above: the rows move at the invalidation;
//! - a config change that leaves `providers` alone: `setModelPreferences` of a built-in provider only reloads the config
//!   (`login.mjs:94-98`) and the rows are hydrated with the saved settings at read time (`provider-models.mjs:166,187,191`);
//! - a catalog load adopting its rows (`provider-models.mjs:107-124`): no signal at all.
//! The recording (`scenarios-model-catalog.json`) holds a case for each mutation: a hidden model, a provider saved and one removed
//! (the providers change that waits for its invalidation), a favorite (the config alone), each followed by Node's read, repeated
//! once to record the mutation that leaves the rows alone; and `model-catalog-background`, a forced load that adopts other rows
//! with no mutation, then a favorite.
//!
//! Node does not coalesce wakes: `invalidateProviderCaches` drops the caches synchronously
//! (`provider-readiness.mjs:68-80`), and the next read starts one shared load that every concurrent reader joins
//! (`provider-models.mjs:145-157`, readers `:189-190`). The feed reads the same way: a wake is a `Notify` permit, so wakes that
//! arrive while a read runs are one more read, and the rows themselves are the shared load. Rows equal to the published ones
//! publish nothing, so the reads one change wakes (the config, the invalidation, the load it starts) give one publication.
//!
//! A re-read that gives the rows already published publishes nothing, where Node's clients re-fetched after every resolved call: the
//! re-fetch showed nothing new there, and the revision makes that equivalent.
//!
//! Only Node's triggers publish. A client kept its cached catalog until the provider-change hint (`desktop-operations.ts:455-456`,
//! `remote-shim-dispatch.ts:276-279`) or a peer change or reconnection dropped it (`sidebar-reference-cache.ts:394-402,430`), so
//! the models a client saw moved at those points only. A catalog load that completes on its own with other rows (a warm-up, a
//! partial refill, a forced read) publishes nothing: the rows are published at the next trigger, which reads them whole. The
//! section's first value is therefore the first trigger's, not the first load's (`recorded` case `model-catalog-background`).

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
                // A change of the stored providers (a key, a provider saved or removed, a model hidden) is a mutation that ends in
                // an invalidation (Node: `afterCredentialChange` / `onCustomProviderRemoved`, `provider-auth/login.mjs:83-104`): the
                // registry follows the config after this tick, so a read now publishes rows Node never showed (a removed provider
                // still listed). Only a change that leaves the providers alone (the model preferences) has no invalidation to wait for.
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
