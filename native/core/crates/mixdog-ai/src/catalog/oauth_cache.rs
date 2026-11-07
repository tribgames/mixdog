//! The Anthropic OAuth route's model cache: `anthropic-oauth-models.json` in the data directory, as Node's
//! `anthropic-model-resolve.mjs` keeps it through `makeModelCache` (`model-cache.mjs`), so a 1.4.5 data
//! directory's cache is reused and the request counts match.
//!
//! - File: `{ "version": 2, "fetchedAt": <ms>, "models": [<Node row>, ...] }`.
//! - Read (`loadSync()`, before the fetch of `listModels`): only a record of version 2 with a `fetchedAt` and a
//!   `models` array whose age is at most 24 h (`Date.now() - fetchedAt > ttl` is stale). A stale, damaged or
//!   other-version file is no cache; it is not used when the fetch fails either (the floor answers).
//! - Write (`_saveModelCache`, after every successful fetch, an empty listing included): `save(models)` with
//!   `fetchedAt: Date.now()`, atomically, under the file's lock, directory flushed, best effort.
//! - Not ported: `_refreshModelCache` (an internal forced refetch that skips the read; nothing in Rust asks for it)
//!   and the in-memory mirror (`_setInMemoryCatalog`), which the resident catalog replaces.
//!
//! The rows are Node's cache rows (the normalizer's fields beside the enrichment's), so the typed listing
//! record is written as such a row and read back from one; fields the record cannot hold (the pricing
//! provenance, guessed flags) are the catalog layers' to supply when the rows are read.

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::domain::provider::{ModelRecord, ReasoningOption};
use mixdog_rt::LaneToken;
use serde_json::{Map, Value, json};

use tokio_util::sync::CancellationToken;

use super::modelsdev_source::read_file;
use crate::oauth::CredentialIo;

pub const CACHE_FILE: &str = "anthropic-oauth-models.json";
/// `ANTHROPIC_MODEL_CACHE_SCHEMA_VERSION`.
const VERSION: i64 = 2;
/// `MODEL_CACHE_TTL_MS`.
const TTL_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

#[derive(Clone)]
pub struct OauthModelCache {
    dir: PathBuf,
    io: CredentialIo,
    now_ms: Clock,
}

impl OauthModelCache {
    pub fn new(dir: PathBuf, io: CredentialIo) -> Self {
        let now_ms: Clock = Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64));
        Self { dir, io, now_ms }
    }

    /// The same cache over another clock.
    pub fn with_clock(mut self, now_ms: Clock) -> Self {
        self.now_ms = now_ms;
        self
    }

    fn path(&self) -> PathBuf {
        self.dir.join(CACHE_FILE)
    }

    /// `loadSync()`: the cached rows when the file holds a fresh record of this version; none otherwise.
    pub async fn load(&self) -> Option<Vec<ModelRecord>> {
        let path = self.path();
        let job = self.io.read.submit(&CancellationToken::new(), move |_| read_file(&path)).ok()?;
        let bytes = job.await.ok()??;
        let record: Value = serde_json::from_slice(&bytes).ok()?;
        if record.get("version").and_then(Value::as_i64) != Some(VERSION) {
            return None;
        }
        let fetched_at = record.get("fetchedAt").and_then(Value::as_f64).filter(|at| *at != 0.0)?;
        let models = record.get("models").and_then(Value::as_array)?;
        if (self.now_ms)() as f64 - fetched_at > TTL_MS {
            return None;
        }
        Some(models.iter().filter_map(record_of_row).collect())
    }

    /// `save(models)`: best effort, as Node's (a failed write only costs the next call a fetch); the failure is logged.
    pub async fn save(&self, models: &[ModelRecord]) {
        let record = json!({ "version": VERSION, "fetchedAt": (self.now_ms)(), "models": models.iter().map(row_of_record).collect::<Vec<_>>() });
        let path = self.path();
        let opts = mixdog_statefile::Opts { lock: true, fsync_dir: true, ..mixdog_statefile::Opts::default() };
        let written = self
            .io
            .write_job(move |lane| mixdog_statefile::write_json(lane, &path, &record, &opts).map(drop).map_err(std::io::Error::other))
            .await;
        if let Err(error) = written {
            tracing::warn!(%error, "[anthropic-oauth] the model cache could not be written");
        }
    }
}
/// `_normalizeAnthropicModel`'s family token: `claude-<letters>` lower-cased, else `other`.
fn family_of(id: &str) -> String {
    let rest = id.get(..7).filter(|head| head.eq_ignore_ascii_case("claude-")).map(|_| &id[7..]);
    let letters: String = rest.unwrap_or_default().chars().take_while(char::is_ascii_alphabetic).collect();
    if letters.is_empty() { "other".to_owned() } else { letters.to_lowercase() }
}

/// The Node cache row of a listed record (`provider` is `anthropic`: `normalizeAndSaveCatalog` normalizes with
/// the default provider for both routes).
fn row_of_record(record: &ModelRecord) -> Value {
    let mut row = Map::new();
    row.insert("id".into(), json!(record.id));
    row.insert("display".into(), json!(record.display_name.clone().or_else(|| record.name.clone()).unwrap_or_else(|| record.id.clone())));
    row.insert("family".into(), json!(family_of(&record.id)));
    row.insert("provider".into(), json!("anthropic"));
    if let Some(v) = record.context_window {
        row.insert("contextWindow".into(), json!(v));
    }
    if let Some(v) = record.max_context_window {
        row.insert("maxContextWindow".into(), json!(v));
    }
    if let Some(v) = record.runtime_context_window {
        row.insert("runtimeContextWindow".into(), json!(v));
    }
    row.insert("outputTokens".into(), json!(record.max_output_tokens));
    if let Some(tier) = &record.picker.tier {
        row.insert("tier".into(), json!(tier));
    }
    row.insert("latest".into(), json!(record.picker.latest));
    if let Some(date) = &record.picker.release_date {
        row.insert("releaseDate".into(), json!(date));
    }
    if let Some(v) = record.supports_reasoning {
        row.insert("supportsReasoning".into(), json!(v));
    }
    if record.efforts_stated || !record.picker.reasoning_options.is_empty() {
        row.insert("reasoningOptions".into(), json!(record.picker.reasoning_options));
    }
    let mut thinking = Map::new();
    if let Some(v) = record.thinking_adaptive {
        thinking.insert("adaptive".into(), json!(v));
    }
    if let Some(v) = record.thinking_enabled {
        thinking.insert("enabled".into(), json!(v));
    }
    if !thinking.is_empty() {
        row.insert("thinkingTypes".into(), Value::Object(thinking));
    }
    for (key, value) in [
        ("inputCostPerM", record.input_cost_per_m),
        ("outputCostPerM", record.output_cost_per_m),
        ("cacheReadCostPerM", record.cache_read_cost_per_m),
        ("cacheWriteCostPerM", record.cache_write_cost_per_m),
    ] {
        if let Some(v) = value.filter(|v| v.is_finite()) {
            row.insert(key.into(), json!(v));
        }
    }
    if let Some(v) = record.supports_images {
        row.insert("supportsVision".into(), json!(v));
    }
    if let Some(v) = record.supports_prompt_caching {
        row.insert("supportsPromptCaching".into(), json!(v));
    }
    if let Some(v) = &record.mode {
        row.insert("mode".into(), json!(v));
    }
    if let Some(v) = record.created {
        row.insert("created".into(), json!(v));
    }
    if let Some(v) = &record.reasoning_content_field {
        row.insert("reasoningContentField".into(), json!(v));
    }
    Value::Object(row)
}

fn positive(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_f64).filter(|n| *n > 0.0).map(|n| n as u64)
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// The listed record of a Node cache row; a row with no id is no model.
fn record_of_row(row: &Value) -> Option<ModelRecord> {
    let id = row.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())?;
    let mut record = ModelRecord::new(id);
    record.display_name = row.get("display").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    record.name = row.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    record.context_window = positive(row.get("contextWindow"));
    record.max_context_window = positive(row.get("maxContextWindow"));
    record.runtime_context_window = positive(row.get("runtimeContextWindow"));
    record.max_output_tokens = positive(row.get("outputTokens"));
    record.input_cost_per_m = finite(row.get("inputCostPerM"));
    record.output_cost_per_m = finite(row.get("outputCostPerM"));
    record.cache_read_cost_per_m = finite(row.get("cacheReadCostPerM"));
    record.cache_write_cost_per_m = finite(row.get("cacheWriteCostPerM"));
    record.supports_images = row.get("supportsVision").and_then(Value::as_bool);
    record.supports_reasoning = row.get("supportsReasoning").and_then(Value::as_bool);
    record.supports_prompt_caching = row.get("supportsPromptCaching").and_then(Value::as_bool);
    if let Some(options) = row.get("reasoningOptions").and_then(Value::as_array) {
        record.efforts_stated = true;
        record.picker.reasoning_options = options.iter().filter_map(|o| serde_json::from_value::<ReasoningOption>(o.clone()).ok()).collect();
        record.reasoning_levels = record.picker.reasoning_options.iter().filter(|o| o.kind == "effort").flat_map(|o| o.values.iter().cloned()).collect();
    }
    record.picker.tier = row.get("tier").and_then(Value::as_str).map(str::to_owned);
    record.picker.latest = row.get("latest").and_then(Value::as_bool).unwrap_or(false);
    record.picker.release_date = row.get("releaseDate").and_then(Value::as_str).map(str::to_owned);
    let thinking = row.get("thinkingTypes");
    record.thinking_adaptive = thinking.and_then(|t| t.get("adaptive")).and_then(Value::as_bool);
    record.thinking_enabled = thinking.and_then(|t| t.get("enabled")).and_then(Value::as_bool);
    record.mode = row.get("mode").and_then(Value::as_str).map(str::to_owned);
    record.created = row.get("created").and_then(Value::as_i64);
    record.reasoning_content_field = row.get("reasoningContentField").and_then(Value::as_str).map(str::to_owned);
    Some(record)
}

#[cfg(test)]
#[path = "oauth_cache_tests.rs"]
mod tests;