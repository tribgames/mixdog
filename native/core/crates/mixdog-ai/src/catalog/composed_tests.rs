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
    assert_eq!(asked(&http), [LITELLM_URL, MODELS_DEV_URL]);
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
    assert_eq!(asked(&http), [LITELLM_URL, MODELS_DEV_URL]);
    assert!(service.warm_stamps().is_some(), "the disk copies stay");
    service.refresh().await;
    assert_eq!(asked(&http).len(), 2, "the retry backoff holds");
}
