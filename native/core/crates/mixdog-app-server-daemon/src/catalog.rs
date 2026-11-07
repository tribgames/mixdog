//! The provider catalog of the composition (WP-AI-CORE): `ModelsDevSource` and `CatalogService`
//! cold-started from disk without the network, refreshed on the core ticker at Node's cadence.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use mixdog_ai::catalog::CatalogService;
use mixdog_ai::catalog::CatalogSnapshot;
use mixdog_ai::catalog::ModelSource;
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
/// domain supplies it). The cold start reads no network; the first refresh runs at Node's boot
/// warm-up delay (`modelCatalogWarmupDelayMs`) and fetches both price tables whatever the disk
/// holds, then every six hours.
pub async fn build_catalog(
    tokens: &LaneTokens,
    data_dir: &Path,
    sources: Vec<ModelSource>,
) -> Result<CatalogHost, CatalogError> {
    let link = ReqwestLink::new(&KeepaliveSchedule::SPEC, false).map_err(CatalogError::Http)?;
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let initial = read_snapshot(tokens, data_dir.join("catalogs").join("snapshot.json")).await;
    let service = Arc::new(CatalogService::composed(initial, sources, Arc::new(link), data_dir.to_path_buf(), io).await);
    let armed = Arc::new(Mutex::new(None));
    if let Some(delay) = first_warm_delay(&|name| std::env::var(name).ok()) {
        arm(service.clone(), armed.clone(), delay);
    }
    Ok(CatalogHost { service, armed })
}

/// `warmup/catalog-warmup.mjs`: the first warm-up runs `modelCatalogWarmupDelayMs` after boot
/// (`MIXDOG_MODEL_CATALOG_WARMUP_DELAY_MS`, default 200, 0 to 60 000) unless
/// `MIXDOG_DISABLE_MODEL_CATALOG_WARMUP` turns the loop off.
fn first_warm_delay(env: &dyn Fn(&str) -> Option<String>) -> Option<Duration> {
    const DEFAULT_MS: f64 = 200.0;
    let disabled = env("MIXDOG_DISABLE_MODEL_CATALOG_WARMUP").is_some_and(|raw| matches!(mixdog_js::js_trim(&raw).to_lowercase().as_str(), "1" | "true" | "yes" | "on"));
    if disabled {
        return None;
    }
    // `envDelayMs`: unset or empty keeps the default; a non-number too; the rest is floored and clamped.
    let ms = match env("MIXDOG_MODEL_CATALOG_WARMUP_DELAY_MS").filter(|raw| !raw.is_empty()).map(|raw| mixdog_js::string_to_number(&raw)) {
        Some(n) if n.is_finite() => n.floor().clamp(0.0, 60_000.0),
        _ => DEFAULT_MS,
    };
    Some(Duration::from_millis(ms as u64))
}

/// One warm-up after `delay`, the next `REFRESH_AFTER` after it finishes (`CATALOG_REFRESH_DEFAULT_MS`: a failed
/// refresh waits for the regular cycle too).
fn arm(service: Arc<CatalogService>, armed: Arc<Mutex<Option<TimerHandle>>>, delay: Duration) {
    let next = (service.clone(), armed.clone());
    let handle = mixdog_rt::ticker().register(Instant::now() + delay, move || {
        let (service, armed) = next;
        mixdog_rt::spawn("catalog.refresh", TaskClass::Work, async move {
            // `registry.mjs:679-683`: each provider whose listing failed is written to stderr; its previous models stay.
            for (provider, error) in service.refresh().await.failed {
                tracing::warn!("[provider:{provider:?}] catalog refresh failed: {error:?}");
            }
            arm(service, armed, REFRESH_AFTER);
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

    fn delay(vars: &[(&str, &str)]) -> Option<Duration> {
        first_warm_delay(&|name| vars.iter().find(|(k, _)| *k == name).map(|(_, v)| (*v).to_owned()))
    }

    /// `runtime-tunables.mjs` `modelCatalogWarmupDelayMs` (`envDelayMs`) and `modelCatalogWarmupEnabled` (`envFlag`).
    #[test]
    fn the_first_warm_up_follows_nodes_delay_and_switch() {
        const DELAY: &str = "MIXDOG_MODEL_CATALOG_WARMUP_DELAY_MS";
        const OFF: &str = "MIXDOG_DISABLE_MODEL_CATALOG_WARMUP";
        assert_eq!(delay(&[]), Some(Duration::from_millis(200)));
        assert_eq!(delay(&[(DELAY, "")]), Some(Duration::from_millis(200)));
        assert_eq!(delay(&[(DELAY, "x")]), Some(Duration::from_millis(200)), "not a number keeps the default");
        assert_eq!(delay(&[(DELAY, "1500.9")]), Some(Duration::from_millis(1500)));
        assert_eq!(delay(&[(DELAY, "0")]), Some(Duration::ZERO));
        assert_eq!(delay(&[(DELAY, "-5")]), Some(Duration::ZERO));
        assert_eq!(delay(&[(DELAY, "999999")]), Some(Duration::from_millis(60_000)));
        assert_eq!(delay(&[(OFF, "1")]), None);
        assert_eq!(delay(&[(OFF, " TRUE ")]), None);
        assert_eq!(delay(&[(OFF, "0")]), Some(Duration::from_millis(200)));
        assert_eq!(delay(&[(OFF, "maybe")]), Some(Duration::from_millis(200)), "a typo keeps the loop on");
    }

    /// The roster file Node's OAuth listing left (recorded by `benchmarks/rust-core/recorders/oauth-model-cache`) in the
    /// data directory: the composed catalog sizes routes from it as Node does, the moment it exists (the catalog was
    /// built before the file, as when another process writes it).
    #[tokio::test]
    async fn the_composed_catalog_reads_the_roster_files_of_the_data_dir_on_every_call() {
        let node: Value = serde_json::from_str(include_str!("../../../fixtures/oauth-model-cache/node-oauth-model-cache.json")).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let host = build_catalog(&tokens, dir.path(), Vec::new()).await.unwrap();
        assert!(host.service().cached_windows("anthropic-oauth", "claude-opus-4-8").is_none(), "no file yet");

        let path = dir.path().join("anthropic-oauth-models.json");
        let text = node["cold"]["cacheFile"].to_string();
        let job = tokens
            .durability_io
            .submit(&CancellationToken::new(), move |lane| {
                mixdog_statefile::write_file(lane, &path, text.as_bytes(), &mixdog_statefile::Opts::default()).map(drop).map_err(std::io::Error::other)
            })
            .unwrap();
        job.await.unwrap().unwrap();

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