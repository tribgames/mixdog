//! The catalog as the daemon runs it: one handle owning the snapshot, the
//! model sources built from the full config, and the models.dev source. The
//! cold start serves the cached metadata without the network; every refresh
//! lists the sources and loads models.dev concurrently, then publishes one
//! snapshot with the metadata applied. Reads never refresh.

use std::path::PathBuf;
use std::sync::Arc;

use arc_swap::ArcSwap;

use super::ModelSource;
use super::ModelsDev;
use super::lookup::Lookup;
use super::rosters::RosterSnapshot;
use crate::oauth::CredentialIo;
use super::ModelsDevSource;
use super::ProviderCatalog;
use super::RefreshOutcome;
use super::store::Ask;
use super::store::CatalogSnapshot;

pub struct CatalogService {
    catalog: Arc<ProviderCatalog>,
    sources: Vec<ModelSource>,
    metadata: Arc<ModelsDevSource>,
    /// The live-roster files, swapped whole when the catalog refreshes.
    pub(super) rosters: ArcSwap<RosterSnapshot>,
    roster_dir: Option<(PathBuf, CredentialIo)>,
    /// The LiteLLM price table, the metadata lookup's base layer.
    litellm: Option<Arc<ModelsDevSource>>,
}

impl CatalogService {
    /// Cold start: `initial` is the snapshot restored from disk (or empty).
    /// The cached models.dev file, however old, is applied at once so
    /// `catalog_wire` and `outputs_text` carry data before the first refresh.
    pub async fn cold_start(
        initial: CatalogSnapshot,
        sources: Vec<ModelSource>,
        metadata: Arc<ModelsDevSource>,
    ) -> Self {
        let catalog = Arc::new(ProviderCatalog::new(initial));
        metadata.warm_from_disk().await;
        if let Some(layer) = metadata.current() {
            catalog.apply_metadata(&layer);
        }
        Self {
            catalog,
            sources,
            metadata,
            rosters: ArcSwap::from_pointee(RosterSnapshot::default()),
            roster_dir: None,
            litellm: None,
        }
    }

    /// Adds the LiteLLM price table (a [`ModelsDevSource::litellm`] source):
    /// its cached copy is warmed now, and every refresh loads it with models.dev.
    pub async fn with_litellm(mut self, source: Arc<ModelsDevSource>) -> Self {
        source.warm_from_disk().await;
        self.litellm = Some(source);
        self
    }

    /// Runs `read` over the resident overlay tables and rosters (what
    /// `getModelMetadataSync` reads); no I/O, never waits on a refresh.
    pub(super) fn with_lookup<R>(&self, read: impl FnOnce(&Lookup<'_>) -> R) -> R {
        static EMPTY: std::sync::LazyLock<serde_json::Value> = std::sync::LazyLock::new(|| serde_json::json!({}));
        let litellm = self.litellm.as_ref().and_then(|s| s.current());
        let models_dev = self.metadata.current();
        let rosters = self.rosters.load();
        read(&Lookup {
            litellm: litellm.as_deref().map_or(&EMPTY, ModelsDev::projected),
            models_dev: models_dev.as_deref().map_or(&EMPTY, ModelsDev::projected),
            rosters: &rosters,
        })
    }

    /// `(LiteLLM, models.dev)` fetch times, only when both tables are
    /// resident: the one place that decides a catalog is warm.
    pub(super) fn warm_stamps(&self) -> Option<(u64, u64)> {
        let litellm = self.litellm.as_ref().filter(|s| s.current().is_some())?;
        self.metadata.current()?;
        Some((litellm.cache_at(), self.metadata.cache_at()))
    }

    /// Reads the providers' live-roster files from `data_dir` now and again
    /// on every refresh, so `cached_windows` has data without touching disk.
    pub async fn with_rosters(mut self, data_dir: PathBuf, io: CredentialIo) -> Self {
        self.rosters.store(Arc::new(RosterSnapshot::load(&data_dir, &io).await));
        self.roster_dir = Some((data_dir, io));
        self
    }

    /// Re-reads the roster files (after a provider's listing persisted one).
    pub async fn reload_rosters(&self) {
        if let Some((dir, io)) = &self.roster_dir {
            self.rosters.store(Arc::new(RosterSnapshot::load(dir, io).await));
        }
    }

    /// The catalog readers hold (`CatalogTraits::new(service.catalog(), ..)`).
    pub fn catalog(&self) -> Arc<ProviderCatalog> {
        self.catalog.clone()
    }

    pub fn snapshot(&self) -> Arc<CatalogSnapshot> {
        self.catalog.snapshot()
    }

    /// One refresh: model listings and models.dev (fetched only when its
    /// cache is stale or a retry is due), published as one snapshot.
    pub async fn refresh(&self) -> RefreshOutcome {
        self.refresh_asking(Ask::All).await
    }

    /// A non-forced refresh: asks only the providers that are due (never
    /// listed, or failed with their backoff passed).
    pub async fn refresh_due(&self) -> RefreshOutcome {
        self.refresh_asking(Ask::Due).await
    }

    /// An auth/account change: the rows listed under the previous account are
    /// dropped (`invalidateSharedProviderCatalog`).
    pub fn invalidate_accounts(&self) {
        self.catalog.invalidate_accounts();
    }

    async fn refresh_asking(&self, ask: Ask) -> RefreshOutcome {
        let litellm = async {
            if let Some(source) = &self.litellm {
                source.load(false).await;
            }
        };
        let (outcome, ()) = futures::future::join(
            self.catalog.refresh_with_metadata_asking(&self.sources, &self.metadata, ask),
            litellm,
        )
        .await;
        self.reload_rosters().await;
        outcome
    }
}
