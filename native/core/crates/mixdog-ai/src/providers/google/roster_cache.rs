//! The Antigravity roster file `antigravity-oauth-models.json`, shared with Node 1.4.5's data directory:
//! `{ "version": 2, "fetchedAt": <ms>, "models": [<normalized row>, ...] }`. Only a version-2 record with
//! `fetchedAt` and a `models` array is a roster; anything else reads as none.

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::WireIds;
use serde_json::Value;
use serde_json::json;

use crate::oauth::CredentialIo;

pub const CACHE_FILE: &str = "antigravity-oauth-models.json";
/// `ANTIGRAVITY_MODEL_CACHE_VERSION`.
const VERSION: i64 = 2;
/// `ANTIGRAVITY_MODEL_CACHE_TTL_MS`.
const TTL_MS: f64 = 6.0 * 60.0 * 60.0 * 1000.0;

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

#[derive(Clone)]
pub struct RosterCache {
    dir: PathBuf,
    io: CredentialIo,
    now_ms: Clock,
}

impl RosterCache {
    pub fn new(dir: PathBuf, io: CredentialIo) -> Self {
        let now_ms: Clock = Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64));
        Self { dir, io, now_ms }
    }

    pub fn with_clock(mut self, now_ms: Clock) -> Self {
        self.now_ms = now_ms;
        self
    }

    fn path(&self) -> PathBuf {
        self.dir.join(CACHE_FILE)
    }

    /// `loadSync({ allowStale })`: the stored roster, or none when the file is missing, unreadable, of another version
    /// or (unless `allow_stale`) older than the TTL.
    pub async fn load(&self, allow_stale: bool) -> Option<Vec<ModelRecord>> {
        let path = self.path();
        #[allow(clippy::disallowed_methods, reason = "the body of a lane job")]
        let bytes = self.io.read_job(move |_| Ok(std::fs::read(&path).ok())).await.ok()??;
        let record: Value = serde_json::from_slice(&bytes).ok()?;
        if record.get("version").and_then(Value::as_i64) != Some(VERSION) {
            return None;
        }
        let fetched_at = record.get("fetchedAt").and_then(Value::as_f64).filter(|at| *at != 0.0)?;
        let models = record.get("models").and_then(Value::as_array)?;
        if !allow_stale && (self.now_ms)() as f64 - fetched_at > TTL_MS {
            return None;
        }
        Some(models.iter().filter_map(record_of_row).collect())
    }

    /// `save(models)`: best effort (a failed write only costs the next call a fetch); the failure is logged.
    pub async fn save(&self, models: &[ModelRecord]) {
        let rows: Vec<Value> = models.iter().map(row_of_record).collect();
        let record = json!({ "version": VERSION, "fetchedAt": (self.now_ms)(), "models": rows });
        let path = self.path();
        let opts = mixdog_statefile::Opts { lock: true, fsync_dir: true, ..mixdog_statefile::Opts::default() };
        let written = self.io.write_job(move |lane| mixdog_statefile::write_json(lane, &path, &record, &opts).map(drop).map_err(std::io::Error::other)).await;
        if let Err(error) = written {
            tracing::warn!(%error, "[antigravity-oauth] the model cache could not be written");
        }
    }
}

fn row_of_record(record: &ModelRecord) -> Value {
    let display = record.display_name.as_deref().or(record.name.as_deref()).unwrap_or(&record.id);
    let name = record.name.as_deref().unwrap_or(display);
    let mut row = serde_json::Map::new();
    row.insert("id".into(), json!(record.id));
    row.insert("name".into(), json!(name));
    row.insert("display".into(), json!(display));
    row.insert("provider".into(), json!("antigravity-oauth"));
    if let Some(family) = record.family.as_deref().filter(|f| !f.is_empty()) {
        row.insert("family".into(), json!(family));
    }
    if let Some(window) = record.context_window {
        row.insert("contextWindow".into(), json!(window));
    }
    if let Some(max_output) = record.max_output_tokens {
        row.insert("maxOutputTokens".into(), json!(max_output));
    }
    row.insert("supportsVision".into(), json!(record.supports_images.unwrap_or(false)));
    row.insert("supportsReasoning".into(), json!(record.supports_reasoning.unwrap_or(false)));
    row.insert("supportsFunctionCalling".into(), json!(true));
    row.insert("reasoningLevels".into(), json!(record.reasoning_levels));
    let wire = match &record.wire {
        Some(WireIds::One(wire)) => json!(wire),
        Some(WireIds::Tiers(tiers)) => Value::Object(tiers.iter().map(|(e, w)| (e.clone(), json!(w))).collect()),
        None => json!(record.id),
    };
    row.insert("wire".into(), wire);
    Value::Object(row)
}

/// The record a stored row stands for: what `antigravity_rows` builds from the same row.
fn record_of_row(row: &Value) -> Option<ModelRecord> {
    let id = row.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())?;
    let text = |key: &str| row.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    let count = |key: &str| row.get(key).and_then(Value::as_f64).filter(|n| *n > 0.0).map(|n| n as u64);
    let mut record = ModelRecord::new(id);
    record.display_name = text("display");
    record.name = text("name").or_else(|| text("display"));
    record.family = text("family");
    record.context_window = count("contextWindow");
    record.max_output_tokens = count("maxOutputTokens");
    record.supports_reasoning = row.get("supportsReasoning").and_then(Value::as_bool);
    record.supports_images = row.get("supportsVision").and_then(Value::as_bool);
    record.reasoning_levels = row
        .get("reasoningLevels")
        .and_then(Value::as_array)
        .map(|levels| levels.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    record.wire = match row.get("wire") {
        Some(Value::String(wire)) => Some(WireIds::One(wire.clone())),
        Some(Value::Object(tiers)) => Some(WireIds::Tiers(tiers.iter().filter_map(|(level, wire)| Some((level.clone(), wire.as_str()?.to_owned()))).collect())),
        _ => None,
    };
    Some(record)
}
