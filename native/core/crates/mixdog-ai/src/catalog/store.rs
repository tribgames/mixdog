use std::collections::BTreeMap;
use std::sync::Arc;

use arc_swap::ArcSwap;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_protocol::ProviderId;
use serde::Deserialize;
use serde::Serialize;

use super::modelsdev::ModelsDev;
use super::modelsdev_source::ModelsDevSource;
use super::record::ModelRecord;
use super::sources::ModelSource;

/// The catalog at one generation; also the content of `catalogs/snapshot.json`.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    /// 0 is the compiled-in catalog; each completed refresh adds one.
    pub generation: u64,
    pub models: BTreeMap<ProviderId, Vec<ModelRecord>>,
}

impl CatalogSnapshot {
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

pub struct ProviderCatalog {
    current: ArcSwap<CatalogSnapshot>,
}

impl ProviderCatalog {
    pub fn new(initial: CatalogSnapshot) -> Self {
        Self {
            current: ArcSwap::from_pointee(initial),
        }
    }

    /// One atomic load; never waits on a refresh.
    pub fn snapshot(&self) -> Arc<CatalogSnapshot> {
        self.current.load_full()
    }

    /// Lists every source concurrently and publishes one new snapshot. A
    /// failing source keeps its previous models. Runs off the read path.
    pub async fn refresh(&self, sources: &[Arc<dyn ModelSource>]) -> RefreshOutcome {
        let listed = self.list_all(sources).await;
        self.publish(listed, None)
    }

    /// [`refresh`](Self::refresh), with the models.dev layer loaded
    /// concurrently with the listings and applied to the snapshot before it
    /// is published: the one place metadata meets the catalog, never a read.
    pub async fn refresh_with_metadata(
        &self,
        sources: &[Arc<dyn ModelSource>],
        metadata: &Arc<ModelsDevSource>,
    ) -> RefreshOutcome {
        let (layer, outcome) = futures::future::join(
            metadata.load(false),
            self.list_all(sources),
        )
        .await;
        self.publish(outcome, layer.as_deref())
    }

    /// Applies an already-resident layer (a cold start that warmed
    /// `modelsdev-catalog.json` from disk) in one atomic swap.
    pub fn apply_metadata(&self, layer: &ModelsDev) {
        self.current.rcu(|current| {
            let mut next = current.with_metadata(layer);
            next.generation = current.generation + 1;
            Arc::new(next)
        });
    }

    async fn list_all(
        &self,
        sources: &[Arc<dyn ModelSource>],
    ) -> Vec<(ProviderId, Result<Vec<ModelRecord>, ProviderError>)> {
        let listings = futures::future::join_all(sources.iter().map(|s| s.list())).await;
        sources
            .iter()
            .map(|s| s.provider().clone())
            .zip(listings)
            .collect()
    }

    fn publish(
        &self,
        listed: Vec<(ProviderId, Result<Vec<ModelRecord>, ProviderError>)>,
        layer: Option<&ModelsDev>,
    ) -> RefreshOutcome {
        let mut models = self.current.load().models.clone();
        let mut outcome = RefreshOutcome {
            refreshed: Vec::new(),
            failed: Vec::new(),
        };
        for (provider, listing) in listed {
            match listing {
                Ok(mut list) => {
                    list.sort_by(|a, b| a.id.cmp(&b.id));
                    models.insert(provider.clone(), list);
                    outcome.refreshed.push(provider);
                }
                Err(err) => outcome.failed.push((provider, err)),
            }
        }
        let built = CatalogSnapshot {
            generation: 0,
            models,
        };
        let models = match layer {
            Some(layer) => built.with_metadata(layer).models,
            None => built.models,
        };
        // Concurrent refreshes each publish a complete snapshot; the later
        // generation number wins.
        self.current.rcu(|current| {
            Arc::new(CatalogSnapshot {
                generation: current.generation + 1,
                models: models.clone(),
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

    struct Keyed {
        id: ProviderId,
        key: Option<String>,
    }

    #[async_trait]
    impl ModelSource for Keyed {
        fn provider(&self) -> &ProviderId {
            &self.id
        }
        async fn list(&self) -> Result<Vec<ModelRecord>, ProviderError> {
            match &self.key {
                Some(_) => Ok(vec![ModelRecord::new(self.id.clone(), "m")]),
                None => Err(ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent)),
            }
        }
    }

    struct Factory;
    impl SourceFactory for Factory {
        fn source(&self, entry: &ProviderEntry) -> Option<Arc<dyn ModelSource>> {
            Some(Arc::new(Keyed {
                id: entry.id.clone(),
                key: entry.settings.get("apiKey")?.as_str().map(str::to_owned),
            }))
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

    #[tokio::test]
    async fn failed_source_keeps_previous_models_and_snapshot_round_trips() {
        let catalog = ProviderCatalog::new(CatalogSnapshot::default());
        let good: Arc<dyn ModelSource> = Arc::new(Keyed {
            id: "a".into(),
            key: Some("k".into()),
        });
        catalog.refresh(&[good]).await;
        let broken: Arc<dyn ModelSource> = Arc::new(Keyed {
            id: "a".into(),
            key: None,
        });
        let outcome = catalog.refresh(&[broken]).await;
        assert_eq!(outcome.failed.len(), 1);
        let snap = catalog.snapshot();
        assert_eq!(snap.models_of(&"a".into()).len(), 1);
        let again = CatalogSnapshot::from_json(&snap.to_json().unwrap()).unwrap();
        assert_eq!(&again, &*snap);
        assert!(CatalogSnapshot::from_json(b"not json").is_none());
    }
}