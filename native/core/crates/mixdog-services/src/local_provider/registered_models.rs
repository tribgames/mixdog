//! The registry of Hugging Face models the user registered:
//! `<data>/local-provider/registered-models.json`, schema 1, at most 256 entries. A damaged
//! index never blocks the provider: its bytes are kept as `<file>.corrupt-<ts>`, the last good
//! copy (`<file>.bak`) is restored when there is one, else no model is registered. A newer
//! build's index is left in place (it reads as no models) and refuses writes.
//!
//! The index is read once, at construction, and answered from memory afterwards. Node
//! (`registered-models.mjs:65`) rereads the file on every lookup (`catalog.mjs:44`), which is only
//! observable if something else writes it. The writers in Node are `registerLocalModel`
//! (`hugging-face.mjs:201`), `forgetRegisteredLocalModel` (`model-maintenance.mjs:150`) and the
//! corrupt-index recovery inside the read; here those are `register`, `forget` and the load. The
//! core owns the data directory, so no other process writes the file; `reload()` rereads it.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use mixdog_rt::DurabilityIo;
use serde_json::{Value, json};

use super::assets::probe;
use crate::media::store::{read_state, write_atomic};

const MAX_REGISTRY_BYTES: u64 = 1024 * 1024;
const MAX_MODELS: usize = 256;

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("[local-provider] invalid registered model metadata")]
    InvalidModel,
    #[error("[local-provider] registered model URL does not match its pinned source")]
    UrlMismatch,
    #[error("[local-provider] registered model limit reached")]
    LimitReached,
    #[error("[local-provider] this model is already registered with another context size")]
    ContextConflict,
    #[error("[local-provider] registered model index schema {0} is newer than this build")]
    NewerSchema(i64),
    #[error("[local-provider] registered model index is too large")]
    TooLarge,
    #[error("[local-provider] registry: {0}")]
    Io(String),
}

/// `owner/name` of a Hugging Face model: `/^[\w.-]+\/[\w.-]+$/`, where `\w` is ASCII only.
pub fn is_repository_id(value: &str) -> bool {
    let valid = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    value.split_once('/').is_some_and(|(owner, name)| valid(owner) && valid(name) && !name.contains('/'))
}

/// Pinned download URL for one repository file at an exact revision.
pub fn hugging_face_file_url(repository: &str, revision: &str, remote_filename: &str) -> String {
    let encoded: Vec<String> = remote_filename.split('/').map(|p| urlencoding_component(p)).collect();
    format!("https://huggingface.co/{repository}/resolve/{revision}/{}", encoded.join("/"))
}

/// `encodeURIComponent`.
fn urlencoding_component(part: &str) -> String {
    let mut out = String::new();
    for b in part.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn hex(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn validate_model(entry: &Value) -> Result<(), RegistryError> {
    let text = |k: &str| entry.get(k).and_then(Value::as_str).unwrap_or("");
    let int = |k: &str| entry.get(k).and_then(Value::as_i64);
    let id = text("id");
    let id_ok = id.strip_prefix("hf-").is_some_and(|h| hex(h, 24));
    let remote = text("remoteFilename");
    let (size, window, vram, minimum) = (int("size"), int("contextWindow"), int("estimatedVramBytes"), int("minimumVramBytes"));
    let ok = id_ok
        && text("filename") == format!("{id}.gguf")
        && hex(text("sha256"), 64)
        && size.is_some_and(|s| s > 0)
        && window.is_some_and(|w| (512..=32768).contains(&w))
        && vram.is_some_and(|v| v >= size.unwrap_or(i64::MAX))
        && minimum == vram
        && hex(text("revision"), 40)
        && is_repository_id(text("repository"))
        && !remote.is_empty()
        && !remote.split('/').any(|p| p.is_empty() || p == "." || p == "..")
        && !remote.chars().any(|c| c == '\\' || (c as u32) < 0x20);
    if !ok {
        return Err(RegistryError::InvalidModel);
    }
    if text("url") != hugging_face_file_url(text("repository"), text("revision"), remote) {
        return Err(RegistryError::UrlMismatch);
    }
    Ok(())
}

fn parse_registry(value: &Value) -> Result<Vec<Value>, RegistryError> {
    if let Some(schema) = value.get("schema").and_then(Value::as_i64).filter(|s| *s > 1) {
        return Err(RegistryError::NewerSchema(schema));
    }
    let models = value.get("models").and_then(Value::as_array).filter(|m| m.len() <= MAX_MODELS);
    if value.get("schema").and_then(Value::as_i64) != Some(1) || models.is_none() {
        return Err(RegistryError::InvalidModel);
    }
    let models = models.expect("checked");
    models.iter().try_for_each(validate_model)?;
    let mut ids: Vec<&str> = models.iter().filter_map(|m| m.get("id").and_then(Value::as_str)).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != models.len() {
        return Err(RegistryError::InvalidModel);
    }
    Ok(models.clone())
}

fn read_blocking(path: &Path) -> Result<Vec<Value>, RegistryError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    if std::fs::metadata(path).map_err(|e| RegistryError::Io(e.to_string()))?.len() > MAX_REGISTRY_BYTES {
        return Err(RegistryError::TooLarge);
    }
    // A newer schema parses as "valid" for read_state so it is left in place, then reads as empty.
    let state = read_state(path, |v| parse_registry(v).is_ok() || v.get("schema").and_then(Value::as_i64).is_some_and(|s| s > 1)).map_err(|e| RegistryError::Io(e.to_string()))?;
    Ok(match state {
        Some(v) => parse_registry(&v).unwrap_or_default(),
        None => Vec::new(),
    })
}

fn write_blocking(path: &Path, models: &[Value]) -> Result<(), RegistryError> {
    // A newer build's index makes the write refuse instead of replacing it.
    if let Ok(bytes) = std::fs::read(path) {
        if let Some(schema) = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v.get("schema").and_then(Value::as_i64)).filter(|s| *s > 1) {
            return Err(RegistryError::NewerSchema(schema));
        }
    }
    let bytes = serde_json::to_vec(&json!({"schema": 1, "models": models})).map_err(|e| RegistryError::Io(e.to_string()))?;
    write_atomic(path, &bytes, true).map_err(|e| RegistryError::Io(e.to_string()))
}

fn register_blocking(path: &Path, entry: &Value) -> Result<(Value, Vec<Value>), RegistryError> {
    let mut models = read_blocking(path)?;
    let id = entry.get("id");
    if let Some(existing) = models.iter().find(|m| m.get("id") == id) {
        if existing.get("contextWindow") != entry.get("contextWindow") {
            return Err(RegistryError::ContextConflict);
        }
        return Ok((existing.clone(), models));
    }
    if models.len() >= MAX_MODELS {
        return Err(RegistryError::LimitReached);
    }
    models.push(entry.clone());
    write_blocking(path, &models)?;
    Ok((entry.clone(), models))
}

fn forget_blocking(path: &Path, model_id: &str) -> Result<Vec<Value>, RegistryError> {
    let models = read_blocking(path)?;
    if !models.iter().any(|m| m.get("id").and_then(Value::as_str) == Some(model_id)) {
        return Ok(models);
    }
    let kept: Vec<Value> = models.into_iter().filter(|m| m.get("id").and_then(Value::as_str) != Some(model_id)).collect();
    write_blocking(path, &kept)?;
    Ok(kept)
}

/// The registry. `list` answers from memory (loaded when the registry is built and replaced by
/// every write of this process); reads and writes of the index file run on the durability lane.
pub struct RegisteredModels {
    path: PathBuf,
    lane: DurabilityIo,
    models: Mutex<Vec<Value>>,
    /// One writer at a time: a write is a read-modify-write of the file.
    writes: tokio::sync::Mutex<()>,
}

impl RegisteredModels {
    /// Loads the index once, at construction (boot), before any async work depends on it.
    pub fn new(data_dir: &Path, lane: DurabilityIo) -> Self {
        let path = data_dir.join("local-provider").join("registered-models.json");
        let models = read_blocking(&path).unwrap_or_default();
        Self { path, lane, models: Mutex::new(models), writes: tokio::sync::Mutex::new(()) }
    }

    pub fn list(&self) -> Vec<Value> {
        self.models.lock().unwrap().clone()
    }

    /// Reads the index file again; an unreadable one keeps what is held.
    pub async fn reload(&self) {
        let _writer = self.writes.lock().await;
        let path = self.path.clone();
        if let Ok(models) = probe(self.lane, move || read_blocking(&path).unwrap_or_default()).await {
            *self.models.lock().unwrap() = models;
        }
    }

    /// Registers the model; an identical id is returned as is, with another context size it fails.
    pub async fn register(&self, entry: &Value) -> Result<Value, RegistryError> {
        validate_model(entry)?;
        let _writer = self.writes.lock().await;
        let (path, entry) = (self.path.clone(), entry.clone());
        let (out, models) = probe(self.lane, move || register_blocking(&path, &entry)).await.map_err(|e| RegistryError::Io(e.to_string()))??;
        *self.models.lock().unwrap() = models;
        Ok(out)
    }

    pub async fn forget(&self, model_id: &str) -> Result<(), RegistryError> {
        let _writer = self.writes.lock().await;
        let (path, id) = (self.path.clone(), model_id.to_owned());
        let models = probe(self.lane, move || forget_blocking(&path, &id)).await.map_err(|e| RegistryError::Io(e.to_string()))??;
        *self.models.lock().unwrap() = models;
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn model(n: u8, context: i64) -> Value {
        let id = format!("hf-{:024x}", n);
        let (repo, revision, file) = ("owner/name", "a".repeat(40), "dir/m q.gguf");
        json!({
            "id": id, "filename": format!("{id}.gguf"), "remoteFilename": file, "repository": repo, "revision": revision,
            "url": hugging_face_file_url(repo, &revision, file), "size": 100, "sha256": "b".repeat(64),
            "contextWindow": context, "estimatedVramBytes": 200, "minimumVramBytes": 200,
        })
    }

    #[test]
    fn repository_ids_and_urls_follow_the_pinned_rules() {
        assert!(is_repository_id("owner/na-me_1.x"));
        assert!(!is_repository_id("owner") && !is_repository_id("a/b/c") && !is_repository_id("a/ b"));
        assert_eq!(hugging_face_file_url("o/n", "rev", "d/a b.gguf"), "https://huggingface.co/o/n/resolve/rev/d/a%20b.gguf");
    }

    pub(crate) fn lane() -> DurabilityIo {
        mixdog_rt::testing::tokens().durability_io
    }

    #[tokio::test]
    async fn registration_validates_dedupes_and_forgets() {
        let dir = tempfile::tempdir().unwrap();
        let reg = RegisteredModels::new(dir.path(), lane());
        assert!(reg.list().is_empty());
        reg.register(&model(1, 16384)).await.unwrap();
        reg.register(&model(1, 16384)).await.unwrap();
        assert!(matches!(reg.register(&model(1, 32768)).await, Err(RegistryError::ContextConflict)));
        reg.register(&model(2, 16384)).await.unwrap();
        assert_eq!(reg.list().len(), 2);
        let mut bad = model(3, 16384);
        bad["url"] = json!("https://evil/x");
        assert!(matches!(reg.register(&bad).await, Err(RegistryError::UrlMismatch)));
        let mut traversal = model(3, 16384);
        traversal["remoteFilename"] = json!("../x.gguf");
        assert!(matches!(reg.register(&traversal).await, Err(RegistryError::InvalidModel)));
        reg.forget("hf-000000000000000000000001").await.unwrap();
        assert_eq!(reg.list().len(), 1);
        // A second registry over the same data directory sees what the first wrote.
        assert_eq!(RegisteredModels::new(dir.path(), lane()).list().len(), 1);
    }

    #[tokio::test]
    async fn a_damaged_index_is_recovered_and_a_newer_one_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let reg = RegisteredModels::new(dir.path(), lane());
        reg.register(&model(1, 16384)).await.unwrap();
        reg.register(&model(2, 16384)).await.unwrap();
        std::fs::write(&reg.path, b"\0\0").unwrap();
        reg.reload().await;
        assert_eq!(reg.list().len(), 1, "the backup is restored");
        std::fs::write(&reg.path, br#"{"schema":2,"models":[]}"#).unwrap();
        reg.reload().await;
        assert!(reg.list().is_empty());
        assert!(matches!(reg.register(&model(3, 16384)).await, Err(RegistryError::NewerSchema(2))));
        assert!(std::fs::read_to_string(&reg.path).unwrap().contains("\"schema\":2"));
    }
}
