//! The provider model catalog request of a media lane (`catalog.mjs` `fetchMediaModelRows`,
//! `mediaCatalogTimeoutMs`) and the file cache the rows are kept in (`model-cache.mjs`
//! `makeModelCache` as `sourceCache` builds it). The HTTP transport is the [`CatalogHttp`] seam:
//! the caller's client refuses redirects and enforces [`media_catalog_timeout`].
//!
//! The Antigravity catalog is fetched by the provider layer (`fetchAvailableModels`), not here.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_js::to_number;
use mixdog_rt::{DurabilityIo, LaneToken};
use mixdog_statefile::{Opts, read_content, write_json};
use serde_json::{Value, json};

use super::catalog::{CatalogFailure, catalog_http_code, catalog_message, image_api_lane};
use super::loader::CatalogCache;
use crate::lane::on_lane;

const TTL_MS: f64 = 24.0 * 60.0 * 60_000.0;
const CACHE_VERSION: f64 = 1.0;

/// `mediaCatalogTimeoutMs(lane)`: gateway image catalogs can sit behind a slow edge (nano-gpt
/// answered after ~44 s), so they get the custom-provider discovery budget.
pub fn media_catalog_timeout(lane: &str) -> Duration {
    Duration::from_millis(if image_api_lane(lane) { 60_000 } else { 10_000 })
}

/// A lane's request credentials (`resolveXaiAuth`, `resolveGeminiKey`, `resolveImageApiAuth`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Auth {
    pub token: String,
    pub base_url: String,
    /// The Cloud project (Antigravity) or account (Grok OAuth) that identifies a rotating bearer.
    pub project_id: Option<String>,
    pub account_id: Option<String>,
}

pub struct HttpReply {
    pub status: u16,
    pub body: String,
}

/// A request that got no answer: `fetch failed`, or the `TimeoutError` of the lane's budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpFailure {
    pub message: String,
    pub timed_out: bool,
}

#[async_trait]
pub trait CatalogHttp: Send + Sync {
    /// One GET that must not follow a redirect (`redirect: 'error'`) and gives up after `timeout`.
    async fn get(&self, url: &str, headers: &[(String, String)], timeout: Duration) -> Result<HttpReply, HttpFailure>;
}

/// A catalog request's failure as Node's `Error` carried it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchError {
    pub message: String,
    pub code: Option<String>,
    pub status: Option<u16>,
    /// Node's `TimeoutError` (the budget ran out).
    pub timed_out: bool,
}

impl FetchError {
    fn plain(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: None, status: None, timed_out: false }
    }

    /// What the loader needs of it.
    pub fn failure(&self) -> CatalogFailure {
        CatalogFailure { code: self.code.clone(), timed_out: self.timed_out }
    }
}

/// `catalogHttpError(status, text)`.
fn http_error(status: u16, text: &str) -> FetchError {
    let code = catalog_http_code(status, text);
    FetchError { message: catalog_message(code).unwrap_or_default().to_owned(), code: Some(code.to_owned()), status: Some(status), timed_out: false }
}

/// `URLSearchParams` value encoding (`application/x-www-form-urlencoded`).
fn form_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'*' | b'-' | b'.' | b'_' | b'0'..=b'9' | b'A'..=b'Z' | b'a'..=b'z' => out.push(char::from(byte)),
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

async fn get_json(http: &dyn CatalogHttp, url: &str, headers: &[(String, String)], timeout: Duration) -> Result<Value, FetchError> {
    let reply = http.get(url, headers, timeout).await.map_err(|failure| FetchError { timed_out: failure.timed_out, ..FetchError::plain(failure.message) })?;
    if !(200..300).contains(&reply.status) {
        return Err(http_error(reply.status, &reply.body));
    }
    serde_json::from_str(&reply.body).map_err(|e| FetchError::plain(e.to_string()))
}

/// `fetchMediaModelRows({ lane, auth })` for every lane but Antigravity.
pub async fn fetch_media_model_rows(http: &dyn CatalogHttp, lane: &str, auth: &Auth) -> Result<Value, FetchError> {
    let timeout = media_catalog_timeout(lane);
    if lane == "gemini" {
        let headers = [("x-goog-api-key".to_owned(), auth.token.clone())];
        let mut items = Vec::new();
        let mut page_token = String::new();
        loop {
            let mut query = "pageSize=1000".to_owned();
            if !page_token.is_empty() {
                query.push_str(&format!("&pageToken={}", form_encode(&page_token)));
            }
            let data = get_json(http, &format!("https://generativelanguage.googleapis.com/v1beta/models?{query}"), &headers, timeout).await?;
            let Some(models) = data.get("models").and_then(Value::as_array) else {
                return Err(FetchError::plain("Invalid Gemini media catalog response"));
            };
            items.extend(models.iter().cloned());
            page_token = data.get("nextPageToken").and_then(Value::as_str).unwrap_or_default().to_owned();
            if page_token.is_empty() {
                return Ok(Value::Array(items));
            }
        }
    }
    let path = if image_api_lane(lane) { "images/models" } else { "models" };
    let headers = [("Authorization".to_owned(), format!("Bearer {}", auth.token))];
    let data = get_json(http, &format!("{}/{path}", auth.base_url), &headers, timeout).await?;
    match data.get("data") {
        Some(rows @ Value::Array(_)) => Ok(rows.clone()),
        _ => Err(FetchError::plain("Invalid media catalog response")),
    }
}

// ── the catalog file ──────────────────────────────────────────────────────

/// `sourceCache(key)`: `<data>/studio-models-<key>.json` = `{ version: 1, fetchedAt, models }`,
/// valid for 24 h (`stale` reads ignore the age, not the version).
pub struct FileCatalogCache {
    pub data_dir: PathBuf,
    pub lane: DurabilityIo,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl FileCatalogCache {
    fn path(&self, key: &str) -> PathBuf {
        self.data_dir.join(format!("studio-models-{key}.json"))
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

#[async_trait]
impl CatalogCache for FileCatalogCache {
    async fn load(&self, key: &str, stale: bool) -> Option<Vec<Value>> {
        let path = self.path(key);
        let bytes = on_lane(self.lane, move || read_content(&path)).await.ok()?.ok()??;
        let raw: Value = serde_json::from_slice(&bytes).ok()?;
        if raw.get("version").and_then(Value::as_f64) != Some(CACHE_VERSION) {
            return None;
        }
        let models = raw.get("models").and_then(Value::as_array)?;
        if !truthy(raw.get("fetchedAt")) {
            return None;
        }
        if !stale && (self.now)() as f64 - to_number(&raw["fetchedAt"]) > TTL_MS {
            return None;
        }
        Some(models.clone())
    }

    async fn save(&self, key: &str, rows: &[Value]) {
        let path = self.path(key);
        let record = json!({ "version": 1, "fetchedAt": (self.now)(), "models": rows });
        // Best-effort, as Node: a full disk never fails the lane.
        let queued = self.lane.submit_wait(&mixdog_rt::CancellationToken::new(), move |proof| write_json(proof, &path, &record, &Opts { lock: true, fsync_dir: true, ..Opts::default() })).await;
        if let Ok(job) = queued {
            let _ = job.await;
        }
    }
}
