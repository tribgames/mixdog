//! The `mediaAsset` source of `transfer/beginRead`. It authorizes and opens an asset exactly as
//! the desktop's download path does (`apps/desktop/src/main/file-downloads.ts`:
//! `authorizeMediaAsset` over `openRegularFile`): the asset's original is resolved from our own
//! index, the path must be absolute, local and a regular file, the open handle must prove it is
//! the file at that path, and a file over 256 MiB is refused. The name is the stored file name
//! as `sanitizedFileName` offers it, the type the asset's own MIME type (else the extension's).
//! `media-download-twin.json` holds Node's answer for every case.

use std::fs::File;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_js::{is_js_space, js_trim, slice_utf16, utf16_len};
use mixdog_workspace::error::{Reason, WsError, WsResult};
use mixdog_workspace::fsops::mime_type;
use mixdog_workspace::ident::{file_id, path_id};
use mixdog_workspace::pathguard::canonical;
use mixdog_workspace::transfer::{SourceFile, TransferSource};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::store::MediaStore;

/// Largest downloadable file, inclusive (`FILE_DOWNLOAD_MAX_BYTES`).
const MAX_BYTES: u64 = 256 * 1024 * 1024;

pub struct MediaAssetSource {
    store: Arc<MediaStore>,
}

impl MediaAssetSource {
    pub fn new(store: Arc<MediaStore>) -> Self {
        Self { store }
    }
}

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

/// `sanitizedFileName`: the name offered with the grant. Separators and reserved characters
/// become `-`, leading blanks, dots and dashes and trailing blanks and dots go, 120 UTF-16 units
/// at most, `download` when nothing is left.
fn sanitized_file_name(value: &str) -> String {
    let mut replaced = String::with_capacity(value.len());
    let mut in_run = false;
    for c in value.chars() {
        let reserved = c <= '\u{1f}' || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*');
        if reserved {
            if !in_run {
                replaced.push('-');
            }
        } else {
            replaced.push(c);
        }
        in_run = reserved;
    }
    let trimmed = replaced.trim_start_matches(|c| is_js_space(c) || c == '.' || c == '-').trim_end_matches(|c| is_js_space(c) || c == '.');
    let name = slice_utf16(trimmed, 120);
    if name.is_empty() { "download".to_owned() } else { name }
}

/// `localFileMimeTypeForPath`: the table is keyed by the text after the last dot of the last path
/// component, so `.png` is a PNG and `a.` has no type. Looked up through the workspace table.
fn mime_for_path(path: &Path) -> &'static str {
    let text = path.to_string_lossy();
    let name = text.rsplit(['\\', '/']).next().unwrap_or("");
    match name.rfind('.') {
        Some(dot) if dot + 1 < name.len() => mime_type(Path::new(&format!("x.{}", &name[dot + 1..]))),
        _ => "application/octet-stream",
    }
}

#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs as a durability-lane job")]
fn open_asset(store: &MediaStore, id: &str) -> WsResult<SourceFile> {
    let entry = store.resolve_file(id).map_err(|e| WsError::new(Reason::Io, e.to_string()))?;
    open_entry(entry.as_ref())
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
    let name = sanitized_file_name(&path.file_name().unwrap_or_default().to_string_lossy());
    let mime = entry.get("mime").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or_else(|| mime_for_path(&real)).to_owned();
    Ok(SourceFile { file, name, mime_type: mime, cleanup: None })
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
            () = cancel.cancelled() => Err(error(Reason::Cancelled, "The request was cancelled.")),
            done = job => done.map_err(|e| WsError::new(Reason::Io, e.to_string()))?,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let path = store.run({ let id = id.clone(); move |s| s.asset_path(&id) }).await.unwrap().unwrap().unwrap();
        std::fs::remove_file(path).unwrap();
        let gone = source.open(&serde_json::json!({"assetId": id}), &cancel).await.err().unwrap();
        assert_eq!((gone.reason, gone.message.as_str()), (Reason::NotFound, "This media file is not available."));

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let id = saved(&store, b"x").await;
        let err = source.open(&serde_json::json!({"assetId": id}), &cancelled).await.err().unwrap();
        assert_eq!(err.reason, Reason::Cancelled);
    }

    /// `fixtures/services/media-download-twin.json`
    /// (`benchmarks/rust-core/recorders/record-media-download.mjs`): Node's real download service
    /// over the same files. Every offer (name, type, size) and every refusal (kind and text) must
    /// match. `MIXDOG_FIXTURES_ROOT` overrides the fixture location.
    #[test]
    fn offers_and_refusals_match_the_recorded_node_download() {
        let root = std::env::var("MIXDOG_FIXTURES_ROOT").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures").to_owned());
        let twin: Value = serde_json::from_str(&std::fs::read_to_string(format!("{root}/services/media-download-twin.json")).unwrap()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_string_lossy().replace('\\', "/");
        for file in twin["files"].as_array().unwrap() {
            let (name, size) = (file["name"].as_str().unwrap(), file["size"].as_u64().unwrap());
            let f = File::create(dir.path().join(name)).unwrap();
            f.set_len(size).unwrap();
        }
        for folder in twin["folders"].as_array().unwrap() {
            std::fs::create_dir(dir.path().join(folder.as_str().unwrap())).unwrap();
        }
        let mut differences = Vec::new();
        for case in twin["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let mut source = serde_json::json!({"kind": "mediaAsset"});
            if let Some(id) = case.get("assetId") {
                source["assetId"] = id.clone();
            }
            let media = case["media"].clone();
            let media = (!media.is_null()).then(|| {
                let mut media = media;
                if let Some(path) = media.get("path").and_then(Value::as_str) {
                    media["path"] = Value::String(path.replace("{DIR}", &base));
                }
                media
            });
            let actual = asset_id(&source).and_then(|_| open_entry(media.as_ref()));
            let expected = &case["outcome"];
            let kind = |reason: &Reason| match reason {
                Reason::NotFound => "not-found",
                Reason::NotAFile => "not-a-file",
                Reason::TooLarge => "too-large",
                Reason::InvalidParams => "invalid",
                other => panic!("{name}: unexpected reason {other:?}"),
            };
            match (&actual, expected.get("ok"), expected.get("error")) {
                (Ok(got), Some(ok), _) => {
                    let size = got.file.metadata().unwrap().len();
                    if got.name != ok["name"].as_str().unwrap() || got.mime_type != ok["mime"].as_str().unwrap() || size != ok["size"].as_u64().unwrap() {
                        differences.push(format!("{name}: offered ({:?}, {:?}, {size}) but Node ({}, {}, {})", got.name, got.mime_type, ok["name"], ok["mime"], ok["size"]));
                    }
                }
                (Err(got), _, Some(error)) => {
                    if kind(&got.reason) != error["reason"].as_str().unwrap() || got.message != error["message"].as_str().unwrap() {
                        differences.push(format!("{name}: refused ({}, {:?}) but Node ({}, {})", kind(&got.reason), got.message, error["reason"], error["message"]));
                    }
                }
                (Ok(_), _, _) => differences.push(format!("{name}: offered, but Node refused with {expected}")),
                (Err(got), _, _) => differences.push(format!("{name}: refused with {:?}, but Node offered {expected}", got.message)),
            }
        }
        assert!(differences.is_empty(), "{} differences:\n{}", differences.len(), differences.join("\n"));
    }

    #[test]
    fn network_paths_are_not_local_files() {
        assert!(is_network(Path::new(r"\\host\share\a.png")));
        assert!(is_network(Path::new("//host/share/a.png")));
        assert!(!is_network(Path::new(r"C:\a\b.png")));
        assert!(!is_network(Path::new("/a/b.png")));
    }
}
