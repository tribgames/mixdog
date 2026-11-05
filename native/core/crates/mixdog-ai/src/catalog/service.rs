//! The catalog as the daemon runs it: one handle owning the snapshot, the
//! model sources built from the full config, and the models.dev source. The
//! cold start serves the cached metadata without the network; every refresh
//! lists the sources and loads models.dev concurrently, then publishes one
//! snapshot with the metadata applied. Reads never refresh.

use std::sync::Arc;

use super::ModelSource;
use super::ModelsDevSource;
use super::ProviderCatalog;
use super::RefreshOutcome;
use super::store::CatalogSnapshot;

pub struct CatalogService {
    catalog: Arc<ProviderCatalog>,
    sources: Vec<Arc<dyn ModelSource>>,
    metadata: Arc<ModelsDevSource>,
}

impl CatalogService {
    /// Cold start: `initial` is the snapshot restored from disk (or empty).
    /// The cached models.dev file, however old, is applied at once so
    /// `catalog_wire` and `outputs_text` carry data before the first refresh.
    pub async fn cold_start(
        initial: CatalogSnapshot,
        sources: Vec<Arc<dyn ModelSource>>,
        metadata: Arc<ModelsDevSource>,
    ) -> Self {
        let catalog = Arc::new(ProviderCatalog::new(initial));
        metadata.warm_from_disk().await;
        if let Some(layer) = metadata.current() {
            catalog.apply_metadata(&layer);
        }
        Self { catalog, sources, metadata }
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
        self.catalog.refresh_with_metadata(&self.sources, &self.metadata).await
    }
}
