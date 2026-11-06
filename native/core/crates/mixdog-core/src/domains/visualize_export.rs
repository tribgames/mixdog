//! The `export` source of `transfer/beginRead`: a PNG or PDF of a visualize pane, rendered by
//! the desktop host into a temp file and handed to the asking device as its download.
//!
//! Node: `visualizeExport` (`apps/desktop/src/main/remote-visualize.ts:315-338`) validates the
//! tab command (`requiredVisualizeTabCommand`, format `png`/`pdf` only), asks the host to render
//! it (`hostRequest('visualizeExport')`, main's `exportForDevice`), then `registerExport`
//! (`file-downloads.ts:913-931`) accepts only a file inside a `mixdog-visualize-export-*` folder,
//! names it `sanitizedFileName(basename)` and types it by the format. The transfer opens the file
//! at once, so the one-device export id and its 10-minute redeem window of the two-step Node flow
//! have nothing left to guard; the export's folder is removed when the transfer ends.

#[allow(clippy::disallowed_types, reason = "the open file a transfer source hands over")]
use std::fs::File;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_rt::InLane;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneTokens;
use mixdog_workspace::error::Reason;
use mixdog_workspace::error::WsError;
use mixdog_workspace::error::WsResult;
use mixdog_workspace::transfer::SourceFile;
use mixdog_workspace::transfer::TransferSource;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::blob::lane_failure;
use super::blob::sanitized_file_name;
use super::support::on_lane;

/// What the host rendered: the export file's path.
pub struct RenderedExport {
    pub path: PathBuf,
}

/// The desktop host's render of a validated export command (main's `exportForDevice`): drawn
/// into a fresh `mixdog-visualize-export-*` temp folder without the save dialog.
#[async_trait]
pub trait ExportRenderer: Send + Sync {
    async fn render(&self, command: &Map<String, Value>, cancel: &CancellationToken) -> WsResult<RenderedExport>;
}

pub struct ExportSource {
    renderer: Arc<dyn ExportRenderer>,
    interactive: InteractiveIo,
}

impl ExportSource {
    pub fn new(renderer: Arc<dyn ExportRenderer>, tokens: &LaneTokens) -> Arc<Self> {
        Arc::new(Self { renderer, interactive: tokens.interactive_io })
    }
}

/// `EXPORT_FOLDER`: `/^mixdog-visualize-export-[A-Za-z0-9]+$/`.
fn export_folder(name: &str) -> bool {
    name.strip_prefix("mixdog-visualize-export-").is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// `missing`: an absent file reads as gone; anything else stays the I/O error it was.
fn missing(error: std::io::Error) -> WsError {
    match error.kind() {
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory => WsError::new(Reason::NotFound, "The file no longer exists."),
        _ => error.into(),
    }
}

/// `registerExport` and `openRegularFile` on the rendered file: its canonical path, inside an
/// export folder, a regular file, opened.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "runs on the interactive-io lane job (lane proof argument)")]
fn open_export(_lane: &InLane<InteractiveIo>, path: &Path) -> WsResult<(File, PathBuf)> {
    let canonical = std::fs::canonicalize(path).map_err(missing)?;
    let folder = canonical.parent().and_then(Path::file_name).and_then(|n| n.to_str()).unwrap_or_default();
    if !export_folder(folder) {
        return Err(WsError::new(Reason::NotAFile, "Only a visualize export can be offered this way."));
    }
    if !std::fs::metadata(&canonical).map_err(missing)?.is_file() {
        return Err(WsError::new(Reason::NotAFile, "Only files on this PC can be downloaded."));
    }
    let file = File::open(&canonical).map_err(missing)?;
    Ok((file, canonical))
}

#[async_trait]
impl TransferSource for ExportSource {
    fn kind(&self) -> &'static str {
        "export"
    }

    /// `source` is `{kind: "export", input: {sessionId, tabId, format, pane?}}`.
    async fn open(&self, source: &Value, cancel: &CancellationToken) -> WsResult<SourceFile> {
        let mut command = source.get("input").and_then(Value::as_object).cloned().unwrap_or_default();
        command.insert("action".into(), json!("export"));
        let valid = mixdog_exthost::required_tab_command(&Value::Object(command)).map_err(WsError::invalid)?;
        let format = valid.get("format").and_then(Value::as_str).unwrap_or_default();
        if format == "project" {
            return Err(WsError::invalid("export format is invalid."));
        }
        let rendered = self.renderer.render(&valid, cancel).await?;
        if rendered.path.as_os_str().is_empty() {
            return Err(WsError::new(Reason::Io, "The export did not produce a file."));
        }
        let path = rendered.path;
        let (file, canonical) =
            on_lane(self.interactive, cancel, move |lane| open_export(lane, &path)).await.map_err(lane_failure)??;
        let base = canonical.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mime_type = if format == "png" { "image/png" } else { "application/pdf" };
        // `dropExport`: the export's own temp folder goes when the transfer ends.
        let folder = canonical.parent().map(Path::to_path_buf);
        Ok(SourceFile { file, name: sanitized_file_name(&base), mime_type: mime_type.into(), cleanup: folder })
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests {
    use std::io::Read;
    use std::sync::Mutex;

    use super::*;

    struct Renderer {
        folder: PathBuf,
        name: &'static str,
        seen: Mutex<Vec<Map<String, Value>>>,
    }

    #[async_trait]
    impl ExportRenderer for Renderer {
        async fn render(&self, command: &Map<String, Value>, _: &CancellationToken) -> WsResult<RenderedExport> {
            self.seen.lock().unwrap().push(command.clone());
            std::fs::create_dir_all(&self.folder)?;
            let path = self.folder.join(self.name);
            std::fs::write(&path, b"PNG")?;
            Ok(RenderedExport { path })
        }
    }

    fn source(input: Value) -> Value {
        json!({ "kind": "export", "input": input })
    }

    /// `remote-visualize.ts` `visualizeExport` + `file-downloads.ts` `registerExport`.
    #[tokio::test]
    async fn a_rendered_export_is_offered_named_and_typed_by_its_format() {
        let tmp = tempfile::tempdir().unwrap();
        let renderer = Arc::new(Renderer {
            folder: tmp.path().join("mixdog-visualize-export-a1B2"),
            name: "-.chart v2.png",
            seen: Mutex::default(),
        });
        let export = ExportSource::new(renderer.clone(), &mixdog_rt::testing::tokens());
        let cancel = CancellationToken::new();
        let opened = export
            .open(&source(json!({ "sessionId": "sess_1", "tabId": "t1", "format": "png", "pane": 1, "extra": true })), &cancel)
            .await
            .unwrap();
        assert_eq!((opened.name.as_str(), opened.mime_type.as_str()), ("chart v2.png", "image/png"));
        let staged = opened.cleanup.clone().expect("the export folder is removed when the transfer ends");
        assert_eq!(staged, std::fs::canonicalize(tmp.path().join("mixdog-visualize-export-a1B2")).unwrap());
        let mut bytes = Vec::new();
        let mut file = opened.file;
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"PNG");
        // The host gets the validated command only.
        assert_eq!(
            renderer.seen.lock().unwrap()[0],
            json!({ "sessionId": "sess_1", "tabId": "t1", "action": "export", "format": "png", "pane": 1 })
                .as_object()
                .cloned()
                .unwrap()
        );

        let pdf = export.open(&source(json!({ "sessionId": "sess_1", "tabId": "t1", "format": "pdf" })), &cancel).await.unwrap();
        assert_eq!(pdf.mime_type, "application/pdf");

        let project = export.open(&source(json!({ "sessionId": "sess_1", "tabId": "t1", "format": "project" })), &cancel).await;
        assert_eq!(project.err().map(|e| e.reason), Some(Reason::InvalidParams));
        let bad = export.open(&source(json!({ "sessionId": "sess_1", "tabId": "t1", "format": "svg" })), &cancel).await;
        assert_eq!(bad.err().map(|e| e.reason), Some(Reason::InvalidParams));
    }

    /// `registerExport`: a file outside an export folder is never offered.
    #[tokio::test]
    async fn only_a_file_in_an_export_folder_is_offered() {
        let tmp = tempfile::tempdir().unwrap();
        let renderer = Arc::new(Renderer { folder: tmp.path().join("elsewhere"), name: "x.png", seen: Mutex::default() });
        let export = ExportSource::new(renderer, &mixdog_rt::testing::tokens());
        let refused = export
            .open(&source(json!({ "sessionId": "sess_1", "tabId": "t1", "format": "png" })), &CancellationToken::new())
            .await;
        let error = refused.err().expect("refused");
        assert_eq!(error.reason, Reason::NotAFile);
    }
}
