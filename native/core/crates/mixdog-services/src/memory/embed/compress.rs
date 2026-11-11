//! `embedding-model-cache-compression.mjs`: after the first successful load on Windows, the model
//! directory is compressed with transparent LZX (`compact.exe /exe:lzx`), once per provider.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use mixdog_rt::CpuBulk;

use crate::tidy::process::{Processes, RunOptions};

/// Runs `compact.exe` with these arguments; `Err` carries why it did not finish.
pub type Compact = Arc<dyn Fn(Vec<String>) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

const COMPACT_TIMEOUT: Duration = Duration::from_secs(120);

/// `embeddingModelCachePath`: the model's directory, refused when the id would leave the root.
pub fn model_cache_path(cache_dir: &Path, model_id: &str) -> Result<PathBuf, String> {
    let parts: Vec<&str> = model_id.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() || parts.iter().any(|part| *part == "." || *part == ".." || part.contains('\\')) {
        return Err(format!("Invalid embedding model id: {model_id}"));
    }
    let mut dir = cache_dir.to_path_buf();
    dir.extend(&parts);
    // An absolute or drive-prefixed part replaces the root on join; what remains must still be below it.
    if !dir.starts_with(cache_dir) || dir.components().skip(cache_dir.components().count()).any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("Embedding model cache escapes its root: {model_id}"));
    }
    Ok(dir)
}

/// `compressEmbeddingModelCache`: `Ok(None)` off Windows (nothing touched), `Ok(Some(dir))` once compressed.
pub async fn compress_model_cache(windows: bool, lane: CpuBulk, cache_dir: &Path, model_id: &str, compact: &Compact) -> Result<Option<PathBuf>, String> {
    if !windows {
        return Ok(None);
    }
    let dir = model_cache_path(cache_dir, model_id)?;
    let probe = dir.clone();
    #[allow(clippy::disallowed_methods, reason = "a lane-job body")]
    crate::lane::on_lane(lane, move || std::fs::metadata(&probe).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let shown = dir.display().to_string();
    compact(vec!["/c".into(), format!("/s:{shown}"), "/i".into(), "/q".into(), "/exe:lzx".into(), format!("{shown}{}*", std::path::MAIN_SEPARATOR)]).await?;
    Ok(Some(dir))
}

/// `compact.exe` under the shared process manager, with Node's two-minute limit.
pub fn compact_with(processes: Processes) -> Compact {
    Arc::new(move |args| {
        let processes = processes.clone();
        Box::pin(async move {
            let cwd = std::env::temp_dir();
            let result = processes.run("compact.exe", &args, RunOptions { timeout: COMPACT_TIMEOUT, ..RunOptions::new(&cwd) }).await;
            match (result.code, result.timed_out) {
                (_, true) => Err("compact.exe timed out".to_owned()),
                (0, _) => Ok(()),
                (code, _) if !result.error.is_empty() => Err(format!("{} (exit {code})", result.error)),
                (code, _) => Err(format!("compact.exe exited with {code}: {}", result.combined.trim())),
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[test]
    fn the_model_path_stays_below_the_cache_root() {
        let root = Path::new(if cfg!(windows) { r"C:\models" } else { "/models" });
        assert_eq!(model_cache_path(root, "onnx-community/harrier").unwrap(), root.join("onnx-community").join("harrier"));
        for id in ["../outside", "a/./b", "", "//", r"a\..\b"] {
            assert!(model_cache_path(root, id).unwrap_err().starts_with("Invalid embedding model id"), "{id}");
        }
        let absolute = if cfg!(windows) { "C:/elsewhere" } else { "a/../../x" };
        assert!(model_cache_path(root, absolute).is_err(), "{absolute}");
    }

    fn recording() -> (Compact, Arc<Mutex<Vec<Vec<String>>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        (Arc::new(move |args| {
            seen.lock().unwrap().push(args);
            Box::pin(async { Ok(()) })
        }), calls)
    }

    #[tokio::test]
    async fn windows_runs_lzx_once_and_other_platforms_touch_nothing() {
        let cache = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(cache.path().join("org").join("model")).unwrap();
        let lane = mixdog_rt::testing::tokens().cpu_bulk;
        let (compact, calls) = recording();
        let dir = compress_model_cache(true, lane, cache.path(), "org/model", &compact).await.unwrap().unwrap();
        let shown = dir.display().to_string();
        assert_eq!(*calls.lock().unwrap(), vec![vec!["/c".to_owned(), format!("/s:{shown}"), "/i".into(), "/q".into(), "/exe:lzx".into(), format!("{shown}{}*", std::path::MAIN_SEPARATOR)]]);
        assert_eq!(compress_model_cache(false, lane, Path::new("/nowhere"), "../x", &compact).await, Ok(None));
        assert!(compress_model_cache(true, lane, cache.path(), "org/missing", &compact).await.is_err(), "a missing directory is not compressed");
        assert_eq!(calls.lock().unwrap().len(), 1);
    }
}
