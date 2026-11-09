//! Fetch and cache of models.dev's `api.json`, as Node's
//! `createCatalogSource` does it (`model-catalog.mjs`):
//!
//! - `GET https://models.dev/api.json`, 10 s for the whole fetch;
//! - cached verbatim in `modelsdev-catalog.json` of the plugin data directory
//!   as `{"fetchedAt":<ms>,"data":<body>}\n`, written atomically under a lock
//!   and best-effort;
//! - a remote copy younger than 6 h is served as is; after a failed fetch the
//!   next try waits 60 s and the cached file (however old) is the fallback;
//! - a copy warmed from disk at boot is stale-ok and never counts as fetched,
//!   so the first refresh still goes to the network;
//! - a forced refresh ignores both windows; concurrent loads share one fetch.
//!
//! Nothing here runs on a read path: catalog reads load an `ArcSwap`
//! snapshot, and the layer is applied when the catalog refreshes.

use crate::transport::deadlines::abort_signal;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_rt::LaneToken;
use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::value::RawValue;
use tokio_util::sync::CancellationToken;

use super::modelsdev::ModelsDev;
use crate::oauth::CredentialIo;
use crate::transport::http::HttpSend;

pub const MODELS_DEV_URL: &str = "https://models.dev/api.json";
pub const MODELS_DEV_CACHE_FILE: &str = "modelsdev-catalog.json";
pub const REFRESH_AFTER: Duration = Duration::from_secs(6 * 60 * 60);
pub const RETRY_AFTER: Duration = Duration::from_secs(60);
const FETCH_DEADLINE: Duration = Duration::from_secs(10);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile<'a> {
    #[serde(default)]
    fetched_at: u64,
    #[serde(borrow)]
    data: &'a RawValue,
}

#[derive(Default)]
struct State {
    layer: Option<Arc<ModelsDev>>,
    cache_at: u64,
    fetched_remote: bool,
    retry_at: u64,
    flight: Option<Shared<BoxFuture<'static, ()>>>,
}

pub struct ModelsDevSource {
    http: Arc<dyn HttpSend>,
    url: String,
    path: PathBuf,
    io: CredentialIo,
    /// The overlay's document parser: models.dev's, or LiteLLM's.
    parse: fn(&[u8]) -> Option<ModelsDev>,
    label: &'static str,
    state: Mutex<State>,
}

pub const LITELLM_URL: &str =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
pub const LITELLM_CACHE_FILE: &str = "litellm-catalog.json";

impl ModelsDevSource {
    /// `data_dir` is the plugin data directory.
    pub fn new(http: Arc<dyn HttpSend>, data_dir: PathBuf, io: CredentialIo) -> Arc<Self> {
        Self::with_url(http, MODELS_DEV_URL.to_owned(), data_dir, io)
    }

    pub fn with_url(
        http: Arc<dyn HttpSend>,
        url: String,
        data_dir: PathBuf,
        io: CredentialIo,
    ) -> Arc<Self> {
        Arc::new(Self {
            http,
            url,
            path: data_dir.join(MODELS_DEV_CACHE_FILE),
            io,
            parse: ModelsDev::parse,
            label: "models.dev ",
            state: Mutex::new(State::default()),
        })
    }

    /// The LiteLLM price table, fetched and cached under the same rules
    /// (`litellm-catalog.json`, six hours, a one-minute retry after a failure).
    pub fn litellm(http: Arc<dyn HttpSend>, data_dir: PathBuf, io: CredentialIo) -> Arc<Self> {
        Arc::new(Self {
            http,
            url: LITELLM_URL.to_owned(),
            path: data_dir.join(LITELLM_CACHE_FILE),
            io,
            parse: ModelsDev::parse_litellm,
            label: "",
            state: Mutex::new(State::default()),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The Anthropic OAuth route's model cache, in the data directory this source caches in.
    pub(super) fn oauth_model_cache(&self) -> super::oauth_cache::OauthModelCache {
        let dir = self.path.parent().map(std::path::Path::to_path_buf).unwrap_or_default();
        super::oauth_cache::OauthModelCache::new(dir, self.io)
    }

    /// The resident layer; no I/O.
    pub fn current(&self) -> Option<Arc<ModelsDev>> {
        self.lock().layer.clone()
    }

    /// When the resident layer was fetched (`cacheAt`); 0 while cold.
    pub(super) fn cache_at(&self) -> u64 {
        self.lock().cache_at
    }

    /// Installs a layer as a fetch would have (tests).
    #[cfg(test)]
    pub(crate) fn set_layer(&self, layer: ModelsDev) {
        self.lock().layer = Some(Arc::new(layer));
    }

    pub fn retry_pending(&self) -> bool {
        self.lock().retry_at != 0
    }

    /// Reads and parses the cache file as a lane job; the parse of the whole
    /// document stays off the runtime threads.
    async fn read_disk(&self) -> Option<(Arc<ModelsDev>, u64)> {
        let path = self.path.clone();
        let parse = self.parse;
        let job = self
            .io
            .read
            .submit(&CancellationToken::new(), move |_| {
                let bytes = read_file(&path)?;
                let file: CacheFile<'_> = serde_json::from_slice(&bytes).ok()?;
                let layer = parse(file.data.get().as_bytes())?;
                Some((Arc::new(layer), file.fetched_at))
            })
            .ok()?;
        job.await.ok().flatten()
    }

    /// Boot: a stale-ok copy from disk; never replaces a layer a fetch
    /// already produced, and stays cold when no usable file exists.
    pub async fn warm_from_disk(&self) {
        if self.current().is_some() {
            return;
        }
        if let Some((layer, fetched_at)) = self.read_disk().await {
            let mut state = self.lock();
            if state.layer.is_none() {
                state.layer = Some(layer);
                state.cache_at = if fetched_at == 0 { now_ms() } else { fetched_at };
            }
        }
    }

    /// The layer to apply now: the resident one when it is fresh or a retry
    /// is pending, else the result of one shared fetch. Never fails: a failed
    /// fetch falls back to the disk copy, then to whatever is resident.
    pub async fn load(self: &Arc<Self>, force: bool) -> Option<Arc<ModelsDev>> {
        let flight = {
            let mut state = self.lock();
            let now = now_ms();
            let fresh = state.fetched_remote
                && state.layer.is_some()
                && now.saturating_sub(state.cache_at) < REFRESH_AFTER.as_millis() as u64;
            if !force && (fresh || now < state.retry_at) {
                return state.layer.clone();
            }
            state
                .flight
                .get_or_insert_with(|| {
                    let this = self.clone();
                    async move {
                        this.fetch_once().await;
                        this.lock().flight = None;
                    }
                    .boxed()
                    .shared()
                })
                .clone()
        };
        flight.await;
        self.current()
    }

    async fn fetch_once(&self) {
        match self.fetch().await {
            Ok((layer, body)) => {
                let fetched_at = now_ms();
                self.store_best_effort(fetched_at, body).await;
                let mut state = self.lock();
                state.layer = Some(layer);
                state.cache_at = fetched_at;
                state.fetched_remote = true;
                state.retry_at = 0;
            }
            Err(reason) => {
                tracing::warn!("[model-catalog] {}fetch failed: {reason}", self.label);
                let disk = self.read_disk().await;
                let mut state = self.lock();
                state.fetched_remote = false;
                state.retry_at = now_ms() + RETRY_AFTER.as_millis() as u64;
                if let Some((layer, fetched_at)) = disk {
                    state.layer = Some(layer);
                    state.cache_at = if fetched_at == 0 { now_ms() } else { fetched_at };
                }
            }
        }
    }

    async fn fetch(&self) -> Result<(Arc<ModelsDev>, Vec<u8>), String> {
        let request = WireRequest {
            transport: TransportKind::Http1,
            method: "GET".into(),
            url: self.url.clone(),
            headers: Vec::new(),
            body: Vec::new(),
        };
        // `AbortSignal.timeout(10_000)` over the whole exchange (`model-catalog.mjs:270`).
        let response = self.http.send(request, abort_signal(FETCH_DEADLINE)).await.map_err(|e| e.message)?;
        if !response.is_success() {
            return Err(format!("HTTP {}", response.status));
        }
        let body = response.read_all().await.map(|r| r.body).map_err(|e| e.message)?;
        // The parse of ~8 MB runs as a lane job.
        let parse = self.parse;
        let job = self
            .io
            .read
            .submit(&CancellationToken::new(), move |_| {
                parse(&body).map(|layer| (Arc::new(layer), body))
            })
            .map_err(|e| e.to_string())?;
        job.await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "not the catalog document".to_owned())
    }

    /// The body is stored verbatim: it already parsed.
    async fn store_best_effort(&self, fetched_at: u64, body: Vec<u8>) {
        let path = self.path.clone();
        let Ok(job) = self.io.write.submit(&CancellationToken::new(), move |lane| {
            let mut out = format!("{{\"fetchedAt\":{fetched_at},\"data\":").into_bytes();
            out.extend_from_slice(&body);
            out.extend_from_slice(b"}\n");
            let opts = mixdog_statefile::Opts { lock: true, fsync_dir: true, ..mixdog_statefile::Opts::default() };
            mixdog_statefile::write_file(lane, &path, &out, &opts).map(drop)
        }) else {
            return;
        };
        if let Ok(Err(error)) = job.await {
            tracing::debug!("[model-catalog] models.dev cache not written: {error}");
        }
    }
}


#[allow(clippy::disallowed_methods, reason = "the body of a lane job")]
pub(super) fn read_file(path: &std::path::Path) -> Option<Vec<u8>> {
    std::fs::read(path).ok()
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "fixture files are written and read directly")]
mod tests {
    use super::*;
    use crate::catalog::CatalogSnapshot;
    use crate::catalog::ModelSource;
    use mixdog_core_api::domain::provider::ModelListing;
    use mixdog_core_api::domain::provider::ModelRecord as ListedRecord;
    use crate::catalog::ModelTraits;
    use crate::catalog::CatalogTraits;
    use crate::catalog::ProviderCatalog;
    use crate::providers::compat::profile::Wire;
    use crate::transport::http::BodyStream;
    use crate::transport::http::HttpResponse;
    use async_trait::async_trait;
    use bytes::Bytes;
    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::provider::ErrorKind;
    use mixdog_core_api::domain::provider::ProviderError;
    use mixdog_core_api::domain::provider::TransportFault;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    const API: &str = r#"{"anthropic":{"npm":"@ai-sdk/anthropic","models":{"claude-x":{"modalities":{"output":["text"]}},"tts-x":{"modalities":{"output":["audio"]}}}}}"#;

    struct Body(Option<Bytes>);
    #[async_trait]
    impl BodyStream for Body {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            self.0.take().map(Ok)
        }
    }

    struct Fake {
        calls: AtomicUsize,
        body: Mutex<Option<&'static str>>,
    }
    #[async_trait]
    impl HttpSend for Fake {
        async fn send(
            &self,
            request: WireRequest,
            _exchange: crate::transport::Exchange,
        ) -> Result<HttpResponse, ProviderError> {
            assert_eq!(request.method, "GET");
            self.calls.fetch_add(1, Ordering::SeqCst);
            let Some(body) = *self.body.lock().unwrap() else {
                return Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent));
            };
            Ok(HttpResponse {
                status: 200,
                headers: Vec::new(),
                body: Box::new(Body(Some(Bytes::from_static(body.as_bytes())))),
            })
        }
    }

    struct Gateway;
    #[async_trait]
    impl ModelListing for Gateway {
        async fn list_models(&self) -> Result<Vec<ListedRecord>, ProviderError> {
            Ok(["claude-x", "tts-x"].map(ListedRecord::new).to_vec())
        }
    }

    fn gateway() -> ModelSource {
        ModelSource::new("gateway".into(), Arc::new(Gateway))
    }

    fn fixture(body: Option<&'static str>) -> (tempfile::TempDir, Arc<Fake>, Arc<ModelsDevSource>) {
        let tokens = mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let fake = Arc::new(Fake {
            calls: AtomicUsize::new(0),
            body: Mutex::new(body),
        });
        let source = ModelsDevSource::new(
            fake.clone(),
            dir.path().to_owned(),
            CredentialIo {
                read: tokens.interactive_io,
                write: tokens.durability_io,
            },
        );
        (dir, fake, source)
    }

    /// The fetch that outlives its timer is logged as the real Node loader logged it (`sites.modelsDev`): the signal's own text.
    #[tokio::test(start_paused = true)]
    async fn a_fetch_that_outlives_its_timer_reads_as_nodes() {
        use crate::transport::site_probe::{TimingOut, assert_transport, recorded};

        let tokens = mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let transport = TimingOut::new();
        let source = ModelsDevSource::new(
            transport.clone(),
            dir.path().to_owned(),
            CredentialIo { read: tokens.interactive_io, write: tokens.durability_io },
        );
        let reason = source.fetch().await.map(|_| ()).expect_err("never answers");
        assert_transport("modelsDev", &transport);
        let logged = recorded("modelsDev")["logged"][0].as_str().unwrap().to_owned();
        assert_eq!(logged, format!("[model-catalog] models.dev fetch failed: {reason}"));
    }

    fn cache_text(dir: &tempfile::TempDir) -> String {
        std::fs::read_to_string(dir.path().join(MODELS_DEV_CACHE_FILE)).unwrap()
    }

    #[tokio::test]
    async fn cold_start_with_a_cached_file_serves_metadata_without_the_network() {
        let (dir, fake, source) = fixture(None);
        std::fs::write(
            dir.path().join(MODELS_DEV_CACHE_FILE),
            format!("{{\"fetchedAt\":1,\"data\":{API}}}\n"),
        )
        .unwrap();
        let catalog = Arc::new(ProviderCatalog::new(CatalogSnapshot::default()));
        catalog.refresh(&[gateway()]).await;
        let traits = CatalogTraits::new(catalog.clone(), "gateway".into()).with_models_dev(source.clone());
        assert_eq!(traits.catalog_wire("claude-x"), None, "nothing warmed yet");
        source.warm_from_disk().await;
        assert_eq!(traits.catalog_wire("claude-x"), Some(Wire::Messages));
        assert!(
            catalog.snapshot().models_of(&"gateway".into()).iter().all(|r| r.npm.is_none()),
            "the layer is read beside the listing, never merged into it"
        );
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0);
        // A disk warm is stale-ok and does not count as fetched.
        *fake.body.lock().unwrap() = Some(API);
        source.load(false).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn refresh_fetches_caches_and_swaps_the_snapshot_atomically() {
        let (dir, fake, source) = fixture(Some(API));
        let catalog = Arc::new(ProviderCatalog::new(CatalogSnapshot::default()));
        let held = catalog.snapshot();
        let sources = vec![gateway()];
        catalog.refresh(&sources).await;
        source.load(false).await;
        // A reader that held the old snapshot is unaffected.
        assert!(held.models_of(&"gateway".into()).is_empty());
        let traits = CatalogTraits::new(catalog.clone(), "gateway".into()).with_models_dev(source.clone());
        assert_eq!(traits.catalog_wire("claude-x"), Some(Wire::Messages));
        assert!(!traits.outputs_text("tts-x"));
        // Cached verbatim in Node's shape.
        let text = cache_text(&dir);
        assert!(text.starts_with("{\"fetchedAt\":") && text.ends_with(&format!("\"data\":{API}}}\n")));
        // Younger than 6 h and fetched remotely: served without a fetch.
        source.load(false).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        // A forced refresh ignores the window.
        source.load(true).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn the_service_applies_the_cached_file_at_start_and_a_fresh_layer_on_refresh() {
        let (dir, fake, source) = fixture(Some(API));
        std::fs::write(
            dir.path().join(MODELS_DEV_CACHE_FILE),
            format!("{{\"fetchedAt\":1,\"data\":{API}}}\n"),
        )
        .unwrap();
        let sources = vec![gateway()];
        let service =
            super::super::CatalogService::cold_start(CatalogSnapshot::default(), sources, source).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0, "cold start never touches the network");
        let outcome = service.refresh().await;
        assert!(outcome.failed.is_empty());
        let traits = service.traits("gateway".into());
        assert_eq!(traits.catalog_wire("claude-x"), Some(Wire::Messages));
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1, "the disk copy was stale, so the refresh fetched");
    }

    #[tokio::test]
    async fn a_failed_fetch_falls_back_to_the_cached_file_and_waits_a_minute() {
        let (dir, fake, source) = fixture(None);
        std::fs::write(
            dir.path().join(MODELS_DEV_CACHE_FILE),
            format!("{{\"fetchedAt\":5,\"data\":{API}}}\n"),
        )
        .unwrap();
        let layer = source.load(false).await.expect("disk fallback");
        assert!(layer.find(&"anthropic".into(), "claude-x").is_some());
        assert!(source.retry_pending());
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        source.load(false).await;
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1, "no retry inside 60 s");
        assert!(source.load(true).await.is_some());
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2, "force ignores the retry window");
    }

    #[tokio::test]
    async fn concurrent_loads_share_one_fetch() {
        let (_dir, fake, source) = fixture(Some(API));
        let (a, b) = tokio::join!(source.load(false), source.load(false));
        assert!(a.is_some() && b.is_some());
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    }
}
