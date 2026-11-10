//! The catalog as the daemon composes it (`CatalogService::composed`): the LiteLLM table is a layer beside
//! models.dev, cached in `litellm-catalog.json`, fetched at the first refresh whatever the disk holds (a disk warm
//! does not count as fetched, `createCatalogSource`), then not again inside six hours, and a failed fetch keeps the
//! disk copy and waits a minute. The merge order of the layers is the lookup's, replayed against Node's recordings by
//! the lookup goldens and the model-list recordings (`model_list_node_tests`), which run on this composition.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, TransportFault, WireRequest};
use serde_json::Value;

use super::modelsdev_source::{LITELLM_URL, MODELS_DEV_URL, read_file};
use super::lookup::fixtures::{LITELLM, MODELS_DEV};
use super::{CatalogService, CatalogSnapshot, LITELLM_CACHE_FILE, MODELS_DEV_CACHE_FILE};
use crate::oauth::CredentialIo;
use crate::transport::http::{BodyStream, HttpResponse, HttpSend};

struct Body(Option<Bytes>);

#[async_trait]
impl BodyStream for Body {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(Ok)
    }
}

/// Serves the two tables by URL, or fails; remembers every URL asked.
struct Tables {
    asked: Mutex<Vec<String>>,
    failing: bool,
}

#[async_trait]
impl HttpSend for Tables {
    async fn send(&self, request: WireRequest, _: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        self.asked.lock().unwrap().push(request.url.clone());
        if self.failing {
            return Err(ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent));
        }
        let body = match request.url.as_str() {
            LITELLM_URL => LITELLM,
            MODELS_DEV_URL => MODELS_DEV,
            other => panic!("unexpected fetch of {other}"),
        };
        Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Body(Some(Bytes::from_static(body.as_bytes())))) })
    }
}

fn io() -> CredentialIo {
    let tokens = mixdog_rt::testing::tokens();
    CredentialIo { read: tokens.interactive_io, write: tokens.durability_io }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

async fn put(path: PathBuf, text: String) {
    io().write_job(move |lane| mixdog_statefile::write_file(lane, &path, text.as_bytes(), &mixdog_statefile::Opts::default()).map(drop).map_err(std::io::Error::other))
        .await
        .unwrap();
}

async fn get(path: PathBuf) -> Vec<u8> {
    io().read_job(move |_| Ok(read_file(&path))).await.unwrap().unwrap()
}

/// A composed service over a data directory holding fresh copies of both tables.
async fn composed(failing: bool) -> (tempfile::TempDir, Arc<Tables>, CatalogService) {
    let dir = tempfile::tempdir().unwrap();
    let at = now_ms();
    put(dir.path().join(LITELLM_CACHE_FILE), format!("{{\"fetchedAt\":{at},\"data\":{LITELLM}}}\n")).await;
    put(dir.path().join(MODELS_DEV_CACHE_FILE), format!("{{\"fetchedAt\":{at},\"data\":{MODELS_DEV}}}\n")).await;
    let http = Arc::new(Tables { asked: Mutex::new(Vec::new()), failing });
    let service = CatalogService::composed(CatalogSnapshot::default(), Vec::new(), http.clone(), dir.path().to_path_buf(), io()).await;
    (dir, http, service)
}

fn asked(http: &Tables) -> Vec<String> {
    let mut urls = http.asked.lock().unwrap().clone();
    urls.sort();
    urls
}

#[tokio::test]
async fn both_tables_are_warm_from_the_disk_and_fetched_once_at_the_first_refresh() {
    let (dir, http, service) = composed(false).await;
    assert!(service.warm_stamps().is_some(), "both tables are resident from the disk copies");
    assert!(asked(&http).is_empty(), "the cold start reads no network");

    let before = now_ms();
    service.refresh().await;
    // Fresh disk copies do not spare the fetch: Node counts a disk warm as not fetched.
    assert_eq!(asked(&http), [MODELS_DEV_URL, LITELLM_URL]);
    let file: Value = serde_json::from_slice(&get(dir.path().join(LITELLM_CACHE_FILE)).await).unwrap();
    assert!(file["fetchedAt"].as_u64().unwrap() >= before, "the cache file is rewritten with the fetch time");
    assert_eq!(file["data"], serde_json::from_str::<Value>(LITELLM).unwrap(), "the body is stored verbatim");

    service.refresh().await;
    assert_eq!(asked(&http).len(), 2, "no second fetch inside the six hours");
}

#[tokio::test]
async fn a_failed_fetch_keeps_the_disk_copies_and_is_not_retried_for_a_minute() {
    let (_dir, http, service) = composed(true).await;
    service.refresh().await;
    assert_eq!(asked(&http), [MODELS_DEV_URL, LITELLM_URL]);
    assert!(service.warm_stamps().is_some(), "the disk copies stay");
    service.refresh().await;
    assert_eq!(asked(&http).len(), 2, "the retry backoff holds");
}

/// `auditCachedModelPricing`: every cached roster route must have its rates in the resident tables; the unpriced ones are
/// reported once per table revision, not on every warm-up.
#[tokio::test]
async fn the_price_audit_reports_unpriced_roster_routes_once_per_table_revision() {
    let (dir, _http, service) = composed(false).await;
    let service = Arc::new(service);
    // An audit records the revision it judged whether or not it reported (`lastAuditedRevision = revision`), so a
    // roster that appears later under the same table stamps is not reported: this is checked on a service of its own.
    let (empty_dir, _http, empty) = composed(false).await;
    let empty = Arc::new(empty);
    assert_eq!(empty.audit_cached_pricing(), None, "no roster route, nothing to report");
    put(empty_dir.path().join("openai-oauth-models.json"), r#"{"models":[{"id":"zz-unpriced"}]}"#.to_owned()).await;
    assert_eq!(empty.audit_cached_pricing(), None, "the revision was already audited");

    put(dir.path().join("openai-oauth-models.json"), r#"{"models":[{"id":"zz-unpriced"}]}"#.to_owned()).await;
    assert_eq!(
        service.audit_cached_pricing().as_deref(),
        Some("[model-pricing] 1/1 catalog routes have no complete price: openai-oauth/zz-unpriced (inputCostPerM, outputCostPerM)")
    );
    assert_eq!(service.audit_cached_pricing(), None, "the same revision is not reported again");

    // A refresh moves the table stamps: the revision, so the report, follows.
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    service.refresh().await;
    assert!(service.audit_cached_pricing().is_some_and(|report| report.contains("openai-oauth/zz-unpriced")));
}

/// A model's wire ids are routes too (`pricingAuditRows`): each is judged, once.
#[tokio::test]
async fn the_audit_judges_the_picker_id_and_every_wire_id_once() {
    let (_dir, _http, service) = composed(false).await;
    let models = vec![serde_json::json!({ "id": "zz-a", "wire": { "low": "zz-a", "high": "zz-b" } })];
    let rows = service.audit_rows(&models, "openai-oauth");
    assert_eq!(rows.iter().map(|r| r.model.as_str()).collect::<Vec<_>>(), ["zz-a", "zz-b"]);
    assert!(rows.iter().all(|r| !r.priced() && r.provider == "openai-oauth" && r.missing_rates == ["inputCostPerM", "outputCostPerM"]));
}

/// Only `settle` of the startup refresh the readiness observed wakes the parked warm-ups (`provider-readiness.mjs:154-158`),
/// with nothing pending by then; the other refreshes wake nobody.
#[tokio::test]
async fn only_the_settled_startup_refresh_tells_the_registered_waker() {
    let (_dir, _http, service) = composed(true).await;
    let service = Arc::new(service);
    let woken = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (count, seen) = (woken.clone(), service.clone());
    service.on_refresh_settled(Arc::new(move || {
        assert!(!seen.refresh_in_flight(), "the wake finds nothing pending");
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }));
    service.refresh().await;
    service.refresh_matching("anything").await;
    service.refresh_due().await;
    service.refresh_providers().await;
    assert_eq!(woken.load(std::sync::atomic::Ordering::SeqCst), 0);
    service.mark_startup_refresh_pending(1);
    assert!(service.refresh_in_flight());
    service.settle_startup_refresh(1);
    assert_eq!(woken.load(std::sync::atomic::Ordering::SeqCst), 1);
}