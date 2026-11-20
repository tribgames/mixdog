//! The `mediaAsset` source of `transfer/beginRead`. It authorizes and opens an asset exactly as
//! the desktop's download path does (`apps/desktop/src/main/file-downloads.ts`:
//! `authorizeMediaAsset` over `openRegularFile`): the asset's original is resolved from our own
//! index, the path must be absolute, local and a regular file, the open handle must prove it is
//! the file at that path, and a file over 256 MiB is refused. The name is the stored file name
//! as `sanitizedFileName` offers it, the type the asset's own MIME type (else the extension's).
//! `media-download-twin.json` holds Node's answer for every case.

// The transfer contract hands the workspace an open `File`; every open here runs as a durability-lane job.
#[allow(clippy::disallowed_types, reason = "SourceFile carries an std File; opened on a lane job")]
use std::fs::File;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_js::{js_trim, utf16_len};
use mixdog_workspace::error::{Reason, WsError, WsResult};
use mixdog_workspace::fsops::mime_type;
use mixdog_workspace::ident::{file_id, path_id};
use mixdog_workspace::pathguard::canonical;
use mixdog_workspace::transfer::{SourceFile, TransferSource};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::store::{Located, MediaStore};

/// Largest downloadable file, inclusive (`FILE_DOWNLOAD_MAX_BYTES`).
const MAX_BYTES: u64 = 256 * 1024 * 1024;

fn error(reason: Reason, message: &str) -> WsError {
    WsError::new(reason, message)
}

fn not_local() -> WsError {
    error(Reason::NotAFile, "Only files on this PC can be downloaded.")
}

fn missing(e: std::io::Error) -> WsError {
    match e.kind() {
        ErrorKind::NotFound | ErrorKind::NotADirectory => error(Reason::NotFound, "The file no longer exists."),
        _ => e.into(),
    }
}

/// `NETWORK_PATH`: a UNC or network path is never a local file.
fn is_network(path: &Path) -> bool {
    let text = path.to_string_lossy();
    let mut chars = text.chars();
    matches!((chars.next(), chars.next()), (Some('\\' | '/'), Some('\\' | '/')))
}

/// `requiredFileDownloadRequest`'s asset id: `requiredString` (trimmed, 1..=128 UTF-16 units,
/// text) then no NUL and `MEDIA_ASSET_ID`. The trimmed text is the id.
fn asset_id(source: &Value) -> WsResult<String> {
    let Some(text) = source.get("assetId").and_then(Value::as_str) else {
        return Err(WsError::invalid("asset id must be a string."));
    };
    let id = js_trim(text);
    let invalid = || WsError::invalid("asset id is invalid.");
    if id.is_empty() || utf16_len(id) > 128 || id.contains('\0') || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(invalid());
    }
    Ok(id.to_owned())
}

/// `authorizeMediaAsset` over the host's answer for the asset: `None` is Node's `null`.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs as a durability-lane job")]
fn open_entry(entry: Option<&Value>) -> WsResult<SourceFile> {
    let unavailable = || error(Reason::NotFound, "This media file is not available.");
    let entry = entry.filter(|e| e.get("available") != Some(&Value::Bool(false))).ok_or_else(unavailable)?;
    let path = PathBuf::from(entry.get("path").and_then(Value::as_str).ok_or_else(unavailable)?);
    if !path.is_absolute() {
        return Err(unavailable());
    }
    if is_network(&path) {
        return Err(not_local());
    }
    let real = canonical(&path).map_err(missing)?;
    if is_network(&real) {
        return Err(not_local());
    }
    if !std::fs::metadata(&real).map_err(missing)?.is_file() {
        return Err(not_local());
    }
    let file = File::open(&real).map_err(missing)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(not_local());
    }
    // The open handle must be the file at that path: a link swapped in between reaches nothing.
    if path_id(&real).ok() != Some(file_id(&file)?) {
        return Err(WsError::changed());
    }
    if meta.len() > MAX_BYTES {
        return Err(error(Reason::TooLarge, "Files larger than 256 MB cannot be downloaded."));
    }
    // The transfer layer sanitizes the name and owns the extension rule; this is the stored name and type.
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let mime = entry.get("mime").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or_else(|| mime_type(&real)).to_owned();
    Ok(SourceFile { file, name, mime_type: mime, cleanup: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_paths_are_not_local_files() {
        assert!(is_network(Path::new(r"\\host\share\a.png")));
        assert!(is_network(Path::new("//host/share/a.png")));
        assert!(!is_network(Path::new(r"C:\a\b.png")));
        assert!(!is_network(Path::new("/a/b.png")));
    }

    fn store(dir: &Path) -> Arc<MediaStore> {
        Arc::new(MediaStore::new(dir, mixdog_rt::testing::tokens().durability_io))
    }
    async fn saved(store: &Arc<MediaStore>, bytes: &'static [u8]) -> String {
        let value = store
            .run(move |s| s.save_asset("image", "gemini", "m", "p", serde_json::json!({}), "image/png", bytes, serde_json::Map::new()))
            .await
            .unwrap()
            .unwrap();
        value["id"].as_str().unwrap().to_owned()
    }
    #[tokio::test]
    async fn serves_an_asset_with_its_stored_name_and_mime_and_refuses_what_node_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let store = store(dir.path());
        let source = MediaAssetSource::new(store.clone());
        let cancel = CancellationToken::new();
        assert_eq!(source.kind(), "mediaAsset");

        let id = saved(&store, b"png-bytes").await;
        let opened = source.open(&serde_json::json!({"kind": "mediaAsset", "assetId": id}), &cancel).await.unwrap();
        assert_eq!(opened.mime_type, "image/png");
        assert_eq!(opened.name, format!("{id}.png"));
        assert_eq!(opened.file.metadata().unwrap().len(), 9);
        assert!(opened.cleanup.is_none());

        let unknown = source.open(&serde_json::json!({"assetId": "nope"}), &cancel).await.err().unwrap();
        assert_eq!((unknown.reason, unknown.message.as_str()), (Reason::NotFound, "This media file is not available."));

        let no_id = source.open(&serde_json::json!({"kind": "mediaAsset"}), &cancel).await.err().unwrap();
        assert_eq!((no_id.reason, no_id.message.as_str()), (Reason::InvalidParams, "asset id must be a string."));

        // The bytes are gone: the asset is not available any more.
        let path = store
            .run({
                let id = id.clone();
                move |s| s.asset_path(&id)
            })
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        std::fs::remove_file(path).unwrap();
        let gone = source.open(&serde_json::json!({"assetId": id}), &cancel).await.err().unwrap();
        assert_eq!((gone.reason, gone.message.as_str()), (Reason::NotFound, "This media file is not available."));

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let id = saved(&store, b"x").await;
        let err = source.open(&serde_json::json!({"assetId": id}), &cancelled).await.err().unwrap();
        assert_eq!(err.reason, Reason::Cancelled);
    }
}

pub struct MediaAssetSource {
    store: Arc<MediaStore>,
}
impl MediaAssetSource {
    pub fn new(store: Arc<MediaStore>) -> Self {
        Self { store }
    }
}
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs as a durability-lane job")]
fn open_asset(store: &MediaStore, id: &str) -> WsResult<SourceFile> {
    match store.locate_file(id).map_err(|e| WsError::new(Reason::Io, e.to_string()))? {
        Some(Located::Readable(entry)) => open_entry(Some(&entry)),
        // Node would open it; the guard refuses without touching it, with Node's own text for a non-regular file.
        Some(Located::Special(_)) => Err(not_local()),
        None => open_entry(None),
    }
}
#[async_trait::async_trait]
impl TransferSource for MediaAssetSource {
    fn kind(&self) -> &'static str {
        "mediaAsset"
    }

    async fn open(&self, source: &Value, cancel: &CancellationToken) -> WsResult<SourceFile> {
        let id = asset_id(source)?;
        let job = self.store.run(move |store| open_asset(store, &id));
        tokio::select! {
            biased;
            () = cancel.cancelled() => Err(error(Reason::Cancelled, "The request was cancelled.")),
            done = job => done.map_err(|e| WsError::new(Reason::Io, e.to_string()))?,
        }
    }
}
