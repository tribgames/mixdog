//! Per-model context-window settings, one small file per model under
//! `<data>/local-provider/context/<sha256(id)>.json`. Agent sessions carry tool schemas and a
//! system prompt before any dialogue, so a smaller window cannot hold one turn.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const LOCAL_CONTEXT_MIN_TOKENS: i64 = 16_384;
pub const LOCAL_CONTEXT_DEFAULT_TOKENS: i64 = 32_768;

/// The registered-model facts the settings depend on.
pub struct ContextLimits<'a> {
    pub id: &'a str,
    pub context_window: i64,
    pub max_context_window: Option<i64>,
}

impl ContextLimits<'_> {
    fn maximum(&self) -> i64 {
        self.max_context_window.filter(|m| *m != 0).unwrap_or(self.context_window)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ContextError {
    #[error("Context size must be an integer from {LOCAL_CONTEXT_MIN_TOKENS} to {0} tokens.")]
    OutOfRange(i64),
    #[error("context settings: {0}")]
    Io(#[from] std::io::Error),
}

fn settings_path(id: &str, data_dir: &Path) -> PathBuf {
    let digest: String = Sha256::digest(id.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    data_dir.join("local-provider").join("context").join(format!("{digest}.json"))
}

pub fn validate_local_context(limits: &ContextLimits, value: Option<i64>) -> Result<Option<i64>, ContextError> {
    match value {
        Some(v) if !(LOCAL_CONTEXT_MIN_TOKENS..=limits.maximum()).contains(&v) => Err(ContextError::OutOfRange(limits.maximum())),
        other => Ok(other),
    }
}

pub fn local_context_settings(limits: &ContextLimits, data_dir: &Path) -> Result<Value, ContextError> {
    // Absent, corrupt or out-of-range settings fall back to the model default; an I/O failure
    // still surfaces.
    let configured = match fs::read(settings_path(limits.id, data_dir)) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.get("tokens").and_then(Value::as_i64))
            .and_then(|t| validate_local_context(limits, Some(t)).ok().flatten()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let maximum = limits.maximum();
    // Models registered under the old 512-token floor run at the agent minimum.
    let default = limits.context_window.max(LOCAL_CONTEXT_MIN_TOKENS.min(maximum));
    let effective = configured.unwrap_or(default);
    Ok(json!({
        "configuredContextWindow": configured,
        "defaultContextWindow": default,
        "minContextWindow": LOCAL_CONTEXT_MIN_TOKENS,
        "maxContextWindow": maximum,
        "contextWindow": effective,
        "runtimeContextWindow": effective,
    }))
}

/// Saves the window; `None` returns the model to its default.
pub fn save_local_context(limits: &ContextLimits, value: Option<i64>, data_dir: &Path) -> Result<(), ContextError> {
    validate_local_context(limits, value)?;
    let path = settings_path(limits.id, data_dir);
    fs::create_dir_all(path.parent().expect("settings path has a parent"))?;
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    fs::write(&tmp, serde_json::to_vec(&json!({"tokens": value})).expect("json serializes"))?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(window: i64, max: Option<i64>) -> ContextLimits<'static> {
        ContextLimits { id: "m/1", context_window: window, max_context_window: max }
    }

    #[test]
    fn settings_default_save_and_reset() {
        let dir = tempfile::tempdir().unwrap();
        let l = limits(512, Some(131_072));
        let initial = local_context_settings(&l, dir.path()).unwrap();
        assert_eq!((initial["configuredContextWindow"].clone(), initial["contextWindow"].clone()), (Value::Null, json!(16_384)));
        save_local_context(&l, Some(65_536), dir.path()).unwrap();
        assert_eq!(local_context_settings(&l, dir.path()).unwrap()["runtimeContextWindow"], 65_536);
        save_local_context(&l, None, dir.path()).unwrap();
        assert_eq!(local_context_settings(&l, dir.path()).unwrap()["configuredContextWindow"], Value::Null);
    }

    #[test]
    fn out_of_range_values_are_rejected_and_stale_files_fall_back() {
        let dir = tempfile::tempdir().unwrap();
        let l = limits(32_768, None);
        assert!(save_local_context(&l, Some(1000), dir.path()).is_err());
        assert!(save_local_context(&l, Some(32_769), dir.path()).is_err());
        save_local_context(&l, Some(32_768), dir.path()).unwrap();
        // The model's window shrank after saving: the stale value no longer applies.
        let smaller = limits(16_384, None);
        assert_eq!(local_context_settings(&smaller, dir.path()).unwrap()["configuredContextWindow"], Value::Null);
        fs::write(settings_path("m/1", dir.path()), b"{not json").unwrap();
        assert_eq!(local_context_settings(&l, dir.path()).unwrap()["contextWindow"], 32_768);
    }
}
