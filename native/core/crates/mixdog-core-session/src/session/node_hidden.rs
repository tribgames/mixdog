//! The hidden set the Node daemon kept (`<data>/session-hidden.json`, `{ version: 1, hidden: { id: stamp } }`),
//! imported once into the archive mark this core hides a session by (the header's `archivedAt`). The file is
//! kept as it is; a record beside it says the import ran, so a session the user lists again afterwards is not
//! hidden again at the next start.

use std::path::Path;
use std::path::PathBuf;

use mixdog_core_api::CoreError;
use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_store::fsio::Access;
use mixdog_store::fsio::publish_file_with;

const HIDDEN_FILE: &str = "session-hidden.json";
const IMPORTED_FILE: &str = "session-hidden.imported";

/// A session the Node daemon hid and the epoch-ms stamp it hid it at.
#[derive(Clone, Debug, PartialEq)]
pub struct HiddenSession {
    pub id: String,
    pub at_ms: Option<i64>,
}

/// The sessions of the Node hidden set not yet imported; empty when there is no file, it is unreadable, or the
/// import already ran. `apply` marks one session and the record of the import is written after every call
/// returned, so an interrupted import runs again.
pub async fn import_node_hidden<F, Fut>(data_dir: PathBuf, io: InteractiveIo, mut apply: F) -> Result<usize, CoreError>
where
    F: FnMut(HiddenSession) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let dir = data_dir.clone();
    let rows = mixdog_core_base::support::on_lane(io, &CancellationToken::new(), move |lane| unimported(lane, &dir)).await?;
    let Some(rows) = rows else { return Ok(0) };
    let count = rows.len();
    for row in rows {
        apply(row).await;
    }
    let record = data_dir.join(IMPORTED_FILE);
    let written = mixdog_core_base::support::on_lane(io, &CancellationToken::new(), move |_lane| publish_file_with(&record, b"1", Access::Inherit)).await?;
    if let Err(error) = written {
        eprintln!("[session-hidden] the import is not recorded and runs again at the next start: {error}");
    }
    Ok(count)
}

/// `None` when nothing is to be imported.
#[allow(clippy::disallowed_methods, reason = "runs inside an interactive-io lane job (lane proof argument)")]
fn unimported(_lane: &InLane<InteractiveIo>, data_dir: &Path) -> Option<Vec<HiddenSession>> {
    if data_dir.join(IMPORTED_FILE).exists() {
        return None;
    }
    let file = data_dir.join(HIDDEN_FILE);
    let bytes = match std::fs::read(&file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            eprintln!("[session-hidden] {} unreadable: {error}", file.display());
            return None;
        }
    };
    Some(parse_hidden(&String::from_utf8_lossy(&bytes)))
}

/// `parseJsonText(text)?.hidden`: an object of id to stamp; anything else holds nothing.
fn parse_hidden(text: &str) -> Vec<HiddenSession> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')) else { return Vec::new() };
    let Some(hidden) = value.get("hidden").and_then(serde_json::Value::as_object) else { return Vec::new() };
    hidden
        .iter()
        .map(|(id, at)| HiddenSession { id: id.clone(), at_ms: at.as_f64().filter(|at| *at > 0.0).map(|at| at as i64) })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hidden_object_is_read_and_anything_else_holds_nothing() {
        let rows = parse_hidden("\u{feff}{\"version\":1,\"hidden\":{\"sess_a\":1700000000000,\"sess_b\":\"x\"}}");
        assert_eq!(rows, vec![HiddenSession { id: "sess_a".into(), at_ms: Some(1_700_000_000_000) }, HiddenSession { id: "sess_b".into(), at_ms: None }]);
        assert!(parse_hidden("not json").is_empty());
        assert!(parse_hidden("{\"hidden\":[1]}").is_empty());
        assert!(parse_hidden("{}").is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[allow(clippy::disallowed_methods, reason = "test setup writes the file")]
    async fn the_import_runs_once_and_keeps_the_file() {
        let data = tempfile::tempdir().expect("data");
        let io = mixdog_rt::testing::tokens().interactive_io;
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let run = |seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>| {
            import_node_hidden(data.path().to_path_buf(), io, move |row| {
                let seen = seen.clone();
                async move { seen.lock().unwrap().push(row.id) }
            })
        };
        assert_eq!(run(seen.clone()).await.unwrap(), 0, "no file, nothing to import");
        std::fs::write(data.path().join(HIDDEN_FILE), "{\"version\":1,\"hidden\":{\"sess_a\":5}}").unwrap();
        assert_eq!(run(seen.clone()).await.unwrap(), 1);
        assert_eq!(run(seen.clone()).await.unwrap(), 0, "the second start imports nothing");
        assert_eq!(*seen.lock().unwrap(), vec!["sess_a".to_owned()]);
        assert!(data.path().join(HIDDEN_FILE).exists());
    }
}
