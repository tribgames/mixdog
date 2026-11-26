//! Composed catalog table loading: a disk copy's age decides whether a refresh fetches. The merge order of the layers
//! is replayed by the lookup goldens and `model_list_node_tests`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::{DeliveryState, ErrorKind, ProviderError, WireRequest};
use serde_json::Value;

use super::modelsdev_source::{LITELLM_URL, MODELS_DEV_URL, read_file};
/// Two one-row tables in the published shapes: LiteLLM keyed by model, models.dev by provider.
const LITELLM: &str =
    r#"{"openai/gpt-x":{"max_input_tokens":128000,"max_output_tokens":4096,"mode":"chat","input_cost_per_token":0.0000025,"output_cost_per_token":0.00001}}"#;
const MODELS_DEV: &str = r#"{"openai":{"models":{"gpt-m":{"name":"GPT M","limit":{"context":200000,"output":8000},"cost":{"input":1.5,"output":6.0}}}}}"#;
use super::{CatalogService, CatalogSnapshot, LITELLM_CACHE_FILE, MODELS_DEV_CACHE_FILE, REFRESH_AFTER};
use crate::oauth::CredentialIo;
use crate::transport::http::{HttpResponse, HttpSend};
use crate::transport::testing::Once;

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
        Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Once(Some(Bytes::from_static(body.as_bytes())))) })
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
    io().write_job(move |lane| {
        mixdog_statefile::write_file(lane, &path, text.as_bytes(), &mixdog_statefile::Opts::default()).map(drop).map_err(std::io::Error::other)
    })
    .await
    .unwrap();
}

async fn get(path: PathBuf) -> Vec<u8> {
    io().read_job(move |_| Ok(read_file(&path))).await.unwrap().unwrap()
}

/// A composed service over a data directory holding copies of both tables stamped at `fetched_at` (or empty when `None`).
async fn composed_at(fetched_at: Option<u64>, failing: bool) -> (tempfile::TempDir, Arc<Tables>, CatalogService) {
    let dir = tempfile::tempdir().unwrap();
    if let Some(at) = fetched_at {
        put(dir.path().join(LITELLM_CACHE_FILE), format!("{{\"fetchedAt\":{at},\"data\":{LITELLM}}}\n")).await;
        put(dir.path().join(MODELS_DEV_CACHE_FILE), format!("{{\"fetchedAt\":{at},\"data\":{MODELS_DEV}}}\n")).await;
    }
    let http = Arc::new(Tables { asked: Mutex::new(Vec::new()), failing });
    let service = CatalogService::composed(CatalogSnapshot::default(), Vec::new(), http.clone(), dir.path().to_path_buf(), io()).await;
    (dir, http, service)
}

/// A composed service over a data directory holding fresh copies of both tables.
async fn composed(failing: bool) -> (tempfile::TempDir, Arc<Tables>, CatalogService) {
    composed_at(Some(now_ms()), failing).await
}

fn asked(http: &Tables) -> Vec<String> {
    let mut urls = http.asked.lock().unwrap().clone();
    urls.sort();
    urls
}

#[tokio::test]
async fn fresh_disk_copies_serve_without_fetching_while_stale_and_missing_refresh() {
    // Fresh (< 6 h) disk copies: warmed at boot, served with no download or rewrite on refresh.
    let fresh_at = now_ms().saturating_sub(60_000);
    let (dir, http, service) = composed_at(Some(fresh_at), false).await;
    assert!(service.warm_stamps().is_some(), "both tables are resident from the disk copies");
    assert!(asked(&http).is_empty(), "the cold start reads no network");
    service.refresh_metadata().await;
    service.refresh_due().await;
    service.refresh().await;
    assert!(asked(&http).is_empty(), "fresh disk copies make no catalog download");
    assert!(service.models_dev_models("openai").is_some_and(|m| m.contains_key("gpt-m")));
    let file: Value = serde_json::from_slice(&get(dir.path().join(LITELLM_CACHE_FILE)).await).unwrap();
    assert_eq!(file["fetchedAt"].as_u64(), Some(fresh_at), "the fresh cache file is not rewritten");

    // Stale (>= 6 h) disk copies: warmed at boot, refreshed once, then served from the new copy.
    let stale_at = now_ms().saturating_sub(REFRESH_AFTER.as_millis() as u64 + 1_000);
    let (dir, http, service) = composed_at(Some(stale_at), false).await;
    assert!(service.warm_stamps().is_some(), "stale disk copies still warm the cold start");
    assert!(asked(&http).is_empty(), "the cold start reads no network");
    let before = now_ms();
    service.refresh().await;
    assert_eq!(asked(&http), [MODELS_DEV_URL, LITELLM_URL]);
    let file: Value = serde_json::from_slice(&get(dir.path().join(LITELLM_CACHE_FILE)).await).unwrap();
    assert!(file["fetchedAt"].as_u64().unwrap() >= before, "the cache file is rewritten with the fetch time");
    assert_eq!(file["data"], serde_json::from_str::<Value>(LITELLM).unwrap(), "the body is stored verbatim");
    service.refresh().await;
    assert_eq!(asked(&http).len(), 2, "no second fetch inside the six hours");

    // Missing disk copies: cold at boot, fetched once on refresh.
    let (_dir, http, service) = composed_at(None, false).await;
    assert!(service.warm_stamps().is_none(), "missing disk copies leave the catalog cold");
    assert!(asked(&http).is_empty(), "the cold start reads no network");
    service.refresh().await;
    assert_eq!(asked(&http), [MODELS_DEV_URL, LITELLM_URL]);
    assert!(service.warm_stamps().is_some());
    service.refresh().await;
    assert_eq!(asked(&http).len(), 2, "no second fetch inside the six hours");
}

#[tokio::test]
async fn a_failed_fetch_keeps_the_disk_copies_and_is_not_retried_for_a_minute() {
    let (_dir, http, service) = composed_at(Some(1), true).await;
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
    let (dir, _http, service) = composed_at(Some(1), false).await;
    let service = Arc::new(service);
    // An audit records the revision it judged whether or not it reported (`lastAuditedRevision = revision`), so a
    // roster that appears later under the same table stamps is not reported: this is checked on a service of its own.
    let (empty_dir, _http, empty) = composed(false).await;
    let empty = Arc::new(empty);
    assert_eq!(empty.audit_cached_pricing(), None, "no roster route, nothing to report");
    // A roster is read from the file of the identity the listings noted, and only one fetched for it.
    let roster = |service: &CatalogService, dir: &std::path::Path| {
        service.roster_accounts.note(super::oauth_cache::Roster::Codex, Some("acct-1"));
        put(
            dir.join(super::oauth_cache::Roster::Codex.keyed_file("acct-1")),
            r#"{"account":"acct-1","provenance":"fetched","models":[{"id":"zz-unpriced"}]}"#.to_owned(),
        )
    };
    roster(&empty, empty_dir.path()).await;
    assert_eq!(empty.audit_cached_pricing(), None, "the revision was already audited");

    roster(&service, dir.path()).await;
    assert_eq!(
        service.audit_cached_pricing().as_deref(),
        Some("[model-pricing] 1/1 catalog routes have no complete price: openai-oauth/zz-unpriced (inputCostPerM, outputCostPerM)")
    );
    assert_eq!(service.audit_cached_pricing(), None, "the same revision is not reported again");

    // A refresh moves the table stamps: the revision, so the report, follows.
    mixdog_rt::time::sleep(std::time::Duration::from_millis(2)).await;
    service.refresh().await;
    assert!(service.audit_cached_pricing().is_some_and(|report| report.contains("openai-oauth/zz-unpriced")));
}

/// A forced full refresh asks the provider again, whatever fresh roster its disk cache holds; a due one is answered by it.
#[tokio::test]
async fn a_forced_refresh_asks_the_provider_past_its_fresh_saved_roster() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use mixdog_core_api::domain::provider::{ModelListing, ModelRecord};

    struct Fetch(Arc<AtomicUsize>);

    #[async_trait]
    impl ModelListing for Fetch {
        async fn list_models(&self) -> Result<Vec<ModelRecord>, ProviderError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(vec![ModelRecord::new("model-a")])
        }
    }

    let (dir, _http, service) = composed(false).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let cache = crate::catalog::OauthModelCache::new(dir.path().to_path_buf(), io());
    let source = crate::catalog::ModelSource::new(mixdog_protocol::ProviderId::from("mimo-oauth"), Arc::new(Fetch(calls.clone()))).with_oauth_cache(cache);
    source.list().await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1, "the roster is saved");
    service.set_sources(vec![source]);

    service.refresh().await;
    assert_eq!(calls.load(Ordering::SeqCst), 2, "a forced refresh does not serve the saved roster");
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
    service.refresh_providers(&service.sources()).await;
    assert_eq!(woken.load(std::sync::atomic::Ordering::SeqCst), 0);
    service.mark_startup_refresh_pending(1);
    assert!(service.refresh_in_flight());
    service.settle_startup_refresh(1);
    assert_eq!(woken.load(std::sync::atomic::Ordering::SeqCst), 1);
}
