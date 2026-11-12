//! The provider catalog of the composition (WP-AI-CORE): `ModelsDevSource` and `CatalogService`
//! cold-started from disk without the network, refreshed on the core ticker at Node's cadence.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;

use mixdog_ai::catalog::CatalogService;
use mixdog_ai::catalog::CatalogSnapshot;
use mixdog_ai::catalog::ModelSource;
use mixdog_ai::catalog::REFRESH_AFTER;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::transport::http::HttpSend;
use mixdog_ai::transport::link::ReqwestLink;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_domains::domains::ai_admin::model_warmup::WarmupGates;
use mixdog_core_domains::domains::ai_admin::model_warmup::WarmupMarks;

use crate::setup_host::TracedMarks;
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

/// The catalog service and its warm-up loop.
pub struct CatalogHost {
    service: Arc<CatalogService>,
    warmup: Arc<CatalogWarmup>,
}

impl CatalogHost {
    pub fn service(&self) -> &Arc<CatalogService> {
        &self.service
    }

    /// The warm-up loop: the composition binds its busy probe, and the sessions' busy-state changes wake it.
    pub fn warmup(&self) -> &Arc<CatalogWarmup> {
        &self.warmup
    }

    /// Disarms the warm-up timer; a refresh already running finishes.
    pub fn stop(&self) {
        self.warmup.stop();
    }
}

/// The catalog's HTTP client: the real one, for the daemon. A composition takes it as a port so a test hands in a fake and
/// never reaches a network.
pub fn production_http() -> Result<Arc<dyn HttpSend>, CatalogError> {
    Ok(Arc::new(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).map_err(CatalogError::Http)?))
}

/// `sources` are the model listings built from the full provider config (empty until the config
/// domain supplies it). The cold start reads no network; the first warm-up runs at Node's boot
/// delay (`modelCatalogWarmupDelayMs`) and fetches both price tables, through `http`, whatever the disk
/// holds, then every six hours.
pub async fn build_catalog(
    tokens: &LaneTokens,
    data_dir: &Path,
    sources: Vec<ModelSource>,
    http: Arc<dyn HttpSend>,
) -> Result<CatalogHost, CatalogError> {
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let initial = read_snapshot(tokens, data_dir.join("catalogs").join("snapshot.json")).await;
    let service = Arc::new(CatalogService::composed(initial, sources, http, data_dir.to_path_buf(), io).await);
    // Armed by the boot (`WarmupSchedulers::schedule_model_catalog_warmup`, `boot/session.mjs:124`).
    let warmup = CatalogWarmup::new(Arc::new(MetadataRefresh(service.clone())));
    Ok(CatalogHost { service, warmup })
}

/// Arms the first warm-up (`scheduleModelCatalogWarmup()`); switched off, the skip is marked. Its refresh is the metadata
/// tables' only (`warmCatalogsInBackground`): the providers' listings are the readiness' startup refresh and its 24 h
/// timer, so nothing waits on this one.
pub(crate) fn arm_first_warm(warmup: &Arc<CatalogWarmup>, env: &dyn Fn(&str) -> Option<String>) {
    match first_warm_delay(env) {
        Some(delay) => warmup.arm(delay),
        None => warmup.marks().profile("model-catalog:warm-skipped", Some(serde_json::json!({ "reason": "disabled" }))),
    }
}

/// `warmCatalogsInBackground()`: the warm-up's refresh.
#[async_trait::async_trait]
pub trait CatalogRefresh: Send + Sync {
    async fn warm(&self) -> Result<(), String>;
}

/// The catalog service's metadata tables, then the audit of the cached routes' prices. A table that fails to load keeps
/// its last rows and retries on its own schedule, so the refresh itself does not fail.
pub struct MetadataRefresh(pub Arc<CatalogService>);

#[async_trait::async_trait]
impl CatalogRefresh for MetadataRefresh {
    async fn warm(&self) -> Result<(), String> {
        self.0.refresh_metadata().await;
        self.0.audit_cached_pricing();
        Ok(())
    }
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

/// `timers.modelCatalogWarmupTimer`.
const SLOT: &str = "modelCatalogWarmupTimer";

#[derive(Default)]
struct WarmState {
    timer: Option<TimerHandle>,
    /// The warm-up found the runtime busy and waits for `wake` (`park`), not polling.
    parked: bool,
    closed: bool,
}

/// The model catalog warm-up loop (`warmup/catalog-warmup.mjs`, with `timer-arm.mjs`): one warm-up after the boot delay,
/// deferred while a turn runs or a session is being created and woken when that settles, then the next one `REFRESH_AFTER`
/// after it finishes (a failed refresh waits for the regular cycle too). A warm-up refreshes the LiteLLM and models.dev
/// tables and then audits the cached routes' prices (`warmCatalogsInBackground`); the providers' listings are not its.
pub struct CatalogWarmup {
    refresh: Arc<dyn CatalogRefresh>,
    /// The runtime's gates, which only exist once the session directory does; until then nothing is busy or closing.
    gates: OnceLock<Arc<dyn WarmupGates>>,
    state: Mutex<WarmState>,
}

impl CatalogWarmup {
    pub(crate) fn new(refresh: Arc<dyn CatalogRefresh>) -> Arc<Self> {
        Arc::new(Self { refresh, gates: OnceLock::new(), state: Mutex::new(WarmState::default()) })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, WarmState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Binds the runtime's gates (busy probe, close, marks).
    pub fn bind_gates(&self, gates: Arc<dyn WarmupGates>) {
        if self.gates.set(gates).is_err() {
            panic!("the catalog warm-up's gates are bound once");
        }
    }

    /// The bound gates' marks; a debug trace before they are bound.
    fn marks(&self) -> &dyn WarmupMarks {
        match self.gates.get() {
            Some(gates) => gates.as_ref(),
            None => &TracedMarks,
        }
    }

    fn closing(&self) -> bool {
        self.state().closed || self.gates.get().is_some_and(|gates| gates.closing())
    }

    /// `arm`: one pending timer, none once the runtime is closing.
    pub(crate) fn arm(self: &Arc<Self>, delay: Duration) {
        if self.closing() {
            return;
        }
        let mut state = self.state();
        if state.timer.is_some() {
            return;
        }
        let this = self.clone();
        state.timer = Some(mixdog_rt::ticker().register(Instant::now() + delay, move || this.on_timer()));
        drop(state);
        self.marks().armed(SLOT, delay);
    }

    /// `timers.modelCatalogWarmupTimer` is set.
    pub fn pending(&self) -> bool {
        self.state().timer.is_some()
    }

    fn on_timer(self: &Arc<Self>) {
        self.marks().running(SLOT, true);
        self.state().timer = None;
        if self.closing() {
            self.marks().running(SLOT, false);
            return;
        }
        {
            let mut state = self.state();
            // The check and the park are one step, so a wake cannot fall between them.
            if let Some(reason) = self.gates.get().and_then(|gates| gates.busy()) {
                state.parked = true;
                drop(state);
                self.marks().profile("model-catalog:warm-deferred", Some(serde_json::json!({ "reason": reason })));
                self.marks().running(SLOT, false);
                return;
            }
        }
        let this = self.clone();
        mixdog_rt::spawn("catalog.refresh", TaskClass::Work, async move {
            // A failed refresh waits for the regular cycle too.
            match this.refresh.warm().await {
                Ok(()) => this.marks().profile("model-catalog:warm-ready", None),
                Err(error) => this.marks().profile("model-catalog:warm-failed", Some(serde_json::json!({ "error": error }))),
            }
            this.arm(REFRESH_AFTER);
            this.marks().running(SLOT, false);
        });
    }

    /// `rt.wakeDeferredWarmups()`: the busy state changed (a turn started or ended, a session create settled); a parked
    /// warm-up re-checks once, on its own tick.
    pub fn wake(self: &Arc<Self>) {
        let parked = std::mem::take(&mut self.state().parked);
        if parked {
            self.arm(Duration::ZERO);
        }
    }

    fn stop(&self) {
        let mut state = self.state();
        state.closed = true;
        state.parked = false;
        if let Some(handle) = state.timer.take() {
            let _ = handle.cancel();
        }
    }
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
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use async_trait::async_trait;
    use mixdog_ai::service::admin_route::resolve_route_context_state;
    use mixdog_ai::transport::http::HttpResponse;
    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::provider::ErrorKind;
    use mixdog_core_api::domain::provider::ProviderError;
    use mixdog_core_api::domain::provider::WireRequest;
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
        let host = build_catalog(&tokens, dir.path(), Vec::new(), crate::compose_test_support::offline_http()).await.unwrap();
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

    /// An HTTP port that counts the fetches the warm-up makes and cannot connect.
    #[derive(Default)]
    struct Counting(AtomicUsize);

    #[async_trait]
    impl HttpSend for Counting {
        async fn send(&self, _: WireRequest, _: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
        }
    }

    async fn warmup_over(http: Arc<Counting>) -> (tempfile::TempDir, Arc<CatalogService>, Arc<CatalogWarmup>) {
        let dir = tempfile::tempdir().unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
        let service = Arc::new(CatalogService::composed(CatalogSnapshot::default(), Vec::new(), http, dir.path().to_path_buf(), io).await);
        let warmup = CatalogWarmup::new(Arc::new(MetadataRefresh(service.clone())));
        (dir, service, warmup)
    }

    /// A runtime that is never closing, busy as `busy` says.
    struct Busy(Arc<Mutex<Option<&'static str>>>);

    impl WarmupMarks for Busy {
        fn profile(&self, _: &str, _: Option<Value>) {}
    }

    impl WarmupGates for Busy {
        fn busy(&self) -> Option<&'static str> {
            *self.0.lock().unwrap()
        }
        fn closing(&self) -> bool {
            false
        }
        fn closed(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
            Box::pin(std::future::pending())
        }
    }

    async fn settle() {
        mixdog_rt::time::sleep(Duration::from_millis(1)).await;
    }

    /// `warmup/catalog-warmup.mjs` with `timer-arm.mjs`: a warm-up that finds a turn running or a session being created
    /// parks (no polling) and runs once when the busy state changes.
    #[tokio::test(start_paused = true)]
    async fn a_busy_runtime_parks_the_catalog_warm_up_until_it_is_woken() {
        let http = Arc::new(Counting::default());
        let (_dir, _service, warmup) = warmup_over(http.clone()).await;
        let busy = Arc::new(Mutex::new(Some("turn-active")));
        warmup.bind_gates(Arc::new(Busy(busy.clone())));
        warmup.arm(Duration::ZERO);
        settle().await;
        mixdog_rt::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(http.0.load(Ordering::SeqCst), 0, "deferred, not retried by polling");
        *busy.lock().unwrap() = None;
        warmup.wake();
        settle().await;
        assert_eq!(http.0.load(Ordering::SeqCst), 2, "the warm-up ran once: one fetch per price table");
        warmup.wake();
        settle().await;
        assert_eq!(http.0.load(Ordering::SeqCst), 2, "a wake with nothing parked starts nothing");
    }

    /// A listing that counts the times it is asked.
    struct CountedListing(Arc<AtomicUsize>);

    #[async_trait]
    impl mixdog_core_api::domain::provider::ModelListing for CountedListing {
        async fn list_models(&self) -> Result<Vec<mixdog_core_api::domain::provider::ModelRecord>, ProviderError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(Vec::new())
        }
    }

    /// `warmCatalogsInBackground` loads the price tables only: the providers' listings belong to the readiness' startup
    /// refresh and its 24 h timer, so a warm-up asks no provider.
    #[tokio::test(start_paused = true)]
    async fn the_catalog_warm_up_asks_no_provider() {
        let http = Arc::new(Counting::default());
        let (_dir, service, warmup) = warmup_over(http.clone()).await;
        let asked = Arc::new(AtomicUsize::new(0));
        service.set_sources(vec![mixdog_ai::catalog::ModelSource::new("p".into(), Arc::new(CountedListing(asked.clone())))]);
        warmup.arm(Duration::ZERO);
        settle().await;
        assert_eq!(http.0.load(Ordering::SeqCst), 2, "the warm-up ran: one fetch per price table");
        assert_eq!(asked.load(Ordering::SeqCst), 0, "no provider was asked");
        warmup.stop();
    }

    /// A stopped host starts no warm-up, a parked one included.
    #[tokio::test(start_paused = true)]
    async fn a_stopped_catalog_warm_up_does_not_run() {
        let http = Arc::new(Counting::default());
        let (_dir, _service, warmup) = warmup_over(http.clone()).await;
        warmup.bind_gates(Arc::new(Busy(Arc::new(Mutex::new(Some("session-create"))))));
        warmup.arm(Duration::ZERO);
        settle().await;
        warmup.stop();
        warmup.wake();
        warmup.arm(Duration::ZERO);
        settle().await;
        assert_eq!(http.0.load(Ordering::SeqCst), 0);
    }

}