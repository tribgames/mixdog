//! The provider catalog of the composition (WP-AI-CORE): `ModelsDevSource` and `CatalogService`
//! cold-started from disk without the network, refreshed on the core ticker at Node's cadence.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Instant;

use mixdog_ai::catalog::CatalogService;
use mixdog_ai::catalog::CatalogSnapshot;
use mixdog_ai::catalog::ModelSource;
use mixdog_ai::catalog::ModelsDevSource;
use mixdog_ai::catalog::REFRESH_AFTER;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::transport::link::ReqwestLink;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_rt::TaskClass;
use mixdog_rt::TimerHandle;
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum CatalogError {
    #[error("building the catalog HTTP client: {0}")]
    Http(reqwest::Error),
}

/// The catalog service and its refresh timer.
pub struct CatalogHost {
    service: Arc<CatalogService>,
    armed: Arc<Mutex<Option<TimerHandle>>>,
}

impl CatalogHost {
    pub fn service(&self) -> &Arc<CatalogService> {
        &self.service
    }

    /// Disarms the refresh timer; a refresh already running finishes.
    pub fn stop(&self) {
        if let Some(handle) = self.armed.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = handle.cancel();
        }
    }
}

/// `sources` are the model listings built from the full provider config (empty until the config
/// domain supplies it). The cold start reads no network; the first refresh runs after one
/// cadence, and a fresh models.dev cache fetches nothing inside it.
pub async fn build_catalog(
    tokens: &LaneTokens,
    data_dir: &Path,
    sources: Vec<ModelSource>,
) -> Result<CatalogHost, CatalogError> {
    let link = ReqwestLink::new(&KeepaliveSchedule::SPEC, false).map_err(CatalogError::Http)?;
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let metadata = ModelsDevSource::new(Arc::new(link), data_dir.to_path_buf(), io);
    let initial = read_snapshot(tokens, data_dir.join("catalogs").join("snapshot.json")).await;
    // The live-roster files the providers' listings persist (`provider-catalog-cache.mjs`), read now and after every refresh,
    // so a route's cached windows (`cachedRouteWindows`) are known from the first session.
    let service = Arc::new(CatalogService::cold_start(initial, sources, metadata).await.with_rosters(data_dir.to_path_buf(), io).await);
    let armed = Arc::new(Mutex::new(None));
    arm(service.clone(), armed.clone());
    Ok(CatalogHost { service, armed })
}

/// Node's refresh cadence: the models.dev cache window (`REFRESH_AFTER`, six hours).
fn arm(service: Arc<CatalogService>, armed: Arc<Mutex<Option<TimerHandle>>>) {
    let next = (service.clone(), armed.clone());
    let handle = mixdog_rt::ticker().register(Instant::now() + REFRESH_AFTER, move || {
        let (service, armed) = next;
        mixdog_rt::spawn("catalog.refresh", TaskClass::Work, async move {
            // `registry.mjs:679-683`: each provider whose listing failed is written to stderr; its previous models stay.
            for (provider, error) in service.refresh().await.failed {
                tracing::warn!("[provider:{provider:?}] catalog refresh failed: {error:?}");
            }
            arm(service, armed);
        });
    });
    *armed.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
}

/// The snapshot restored from disk; a missing or unparsable cache is the empty catalog.
#[allow(clippy::disallowed_methods, reason = "runs as an interactive-io lane job")]
async fn read_snapshot(tokens: &LaneTokens, path: PathBuf) -> CatalogSnapshot {
    let Ok(job) = tokens.interactive_io.submit(&CancellationToken::new(), move |_lane| std::fs::read(path)) else {
        return CatalogSnapshot::default();
    };
    job.await
        .ok()
        .and_then(Result::ok)
        .and_then(|bytes| CatalogSnapshot::from_json(&bytes))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use mixdog_ai::service::admin_route::resolve_route_context_state;
    use serde_json::{Value, json};

    use super::*;

    /// A data directory holding the roster file Node's OAuth listing left (recorded by
    /// `benchmarks/rust-core/recorders/oauth-model-cache`): the cold-started catalog already sizes routes as Node does.
    #[tokio::test]
    async fn the_composed_catalog_reads_the_roster_files_of_the_data_dir_at_start() {
        let node: Value = serde_json::from_str(include_str!("../../../fixtures/oauth-model-cache/node-oauth-model-cache.json")).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let path = dir.path().join("anthropic-oauth-models.json");
        let text = node["cold"]["cacheFile"].to_string();
        let job = tokens
            .durability_io
            .submit(&CancellationToken::new(), move |lane| {
                mixdog_statefile::write_file(lane, &path, text.as_bytes(), &mixdog_statefile::Opts::default()).map(drop).map_err(std::io::Error::other)
            })
            .unwrap();
        job.await.unwrap().unwrap();

        let host = build_catalog(&tokens, dir.path(), Vec::new()).await.unwrap();
        for entry in node["cold"]["routeStates"].as_array().unwrap() {
            let (provider, model) = (entry["route"]["provider"].as_str().unwrap(), entry["route"]["model"].as_str().unwrap());
            let meta = host.service().cached_windows(provider, model).map(|w| json!({ "contextWindow": w.context_window, "maxContextWindow": w.max_context_window }));
            let state = resolve_route_context_state(entry["route"].as_object().unwrap(), meta.as_ref());
            let expected = &entry["state"];
            assert_eq!(
                (state.context_percent, state.context_default_percent, state.selected_context_window),
                (expected["contextPercent"].as_f64(), expected["contextDefaultPercent"].as_f64(), expected["selectedContextWindow"].as_f64()),
                "{provider} {model}"
            );
        }
        host.stop();
    }
}