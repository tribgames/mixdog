//! The `attachment` source of `transfer/beginRead`: a file of the conversation's messages,
//! read from the content-addressed store and staged as a temp file for the transfer.
//!
//! Node: `authorizeAttachment` (`apps/desktop/src/main/file-downloads.ts`) over
//! `readSessionAttachment` and `attachmentViewName` (`session-attachments.ts`). The desktop
//! serves an id only when THIS session's transcript names it; whether it does is the
//! `SessionAttachments` the session domain answers.

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_protocol::BlobDigest;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneTokens;
use mixdog_store::blobs::BlobError;
use mixdog_store::blobs::BlobStore;
use mixdog_workspace::error::Reason;
use mixdog_workspace::error::WsError;
use mixdog_workspace::error::WsResult;
use mixdog_workspace::transfer::SourceFile;
use mixdog_workspace::transfer::TransferSource;
use serde_json::Value;
use sha2::Digest as _;
use sha2::Sha256;
use tokio_util::sync::CancellationToken;

use crate::domains::support::is_js_space;
use crate::domains::support::on_lane;

/// `FILE_DOWNLOAD_MAX_BYTES` (`shared/file-downloads.ts`), inclusive.
const MAX_BYTES: usize = 256 * 1024 * 1024;

/// What a session's rows say about one attachment (`sessionAttachments`,
/// `transcript-file-links.ts`), as written on the row: the defaults and limits are applied here.
pub struct NamedAttachment {
    pub name: Option<String>,
    pub mime_type: Option<String>,
}

/// Whether the conversation of `session_id` names attachment `id`: the transcript window
/// first, then the session's whole stored history (`namedAttachment`).
#[async_trait]
pub trait SessionAttachments: Send + Sync {
    async fn named(&self, session_id: &str, id: &str) -> Option<NamedAttachment>;
}

pub struct AttachmentSource {
    store: BlobStore,
    sessions: Arc<dyn SessionAttachments>,
    interactive: InteractiveIo,
}

impl AttachmentSource {
    pub fn new(store: BlobStore, sessions: Arc<dyn SessionAttachments>, tokens: &LaneTokens) -> Arc<Self> {
        Arc::new(Self { store, sessions, interactive: tokens.interactive_io })
    }
}

/// `/^[a-f0-9]{64}$/`.
fn valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `requiredSessionId` (`desktop-state.ts`): trimmed, 1-256 units of `[A-Za-z0-9_-]`.
fn required_session_id(value: Option<&Value>) -> WsResult<&str> {
    let Some(text) = value.and_then(Value::as_str) else {
        return Err(WsError::invalid("session id must be a string."));
    };
    let id = mixdog_js::js_trim(text);
    let pattern = !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    // The pattern is ASCII, so the length in units is the byte length.
    if !pattern || id.len() > 256 {
        return Err(WsError::invalid("session id is invalid."));
    }
    Ok(id)
}

/// `sanitizedFileName(value)` (`ipc-validation.ts`).
pub(crate) fn sanitized_file_name(value: &str) -> String {
    let mut replaced = String::new();
    let mut in_run = false;
    for c in value.chars() {
        let bad = c <= '\u{1f}' || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*');
        if bad {
            if !in_run {
                replaced.push('-');
            }
        } else {
            replaced.push(c);
        }
        in_run = bad;
    }
    let trimmed = replaced
        .trim_start_matches(|c| is_js_space(c) || c == '.' || c == '-')
        .trim_end_matches(|c| is_js_space(c) || c == '.');
    let name = mixdog_js::slice_utf16(trimmed, 120);
    if name.is_empty() { "download".into() } else { name }
}

/// Node `path.extname` of a name without separators.
fn has_extension(name: &str) -> bool {
    name != ".." && name.rfind('.').is_some_and(|at| at > 0)
}

fn extension_of(mime_type: &str) -> &'static str {
    match mime_type.to_lowercase().as_str() {
        "image/png" => ".png",
        "image/jpeg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "application/pdf" => ".pdf",
        "text/plain" => ".txt",
        "text/markdown" => ".md",
        _ => "",
    }
}

/// `attachmentViewName(meta)`: a name that previews by its extension.
fn view_name(name: &str, mime_type: &str) -> String {
    let name = sanitized_file_name(name);
    if has_extension(&name) {
        name
    } else {
        format!("{name}{}", extension_of(mime_type))
    }
}

fn refused(reason: Reason, message: &str) -> WsError {
    WsError::new(reason, message)
}

fn lane_failure(error: CoreError) -> WsError {
    match error {
        CoreError::Cancelled { .. } => WsError::new(Reason::Cancelled, "The request was cancelled."),
        _ => WsError::new(Reason::Overloaded, "The host is busy."),
    }
}

/// The bytes of attachment `digest`, checked, in a new temp file opened for reading.
fn stage(store: &BlobStore, lane: &mixdog_rt::InLane<InteractiveIo>, digest: &BlobDigest, id: &str) -> WsResult<(File, PathBuf)> {
    let bytes = store.read(lane, digest).map_err(|error| match error {
        BlobError::Missing { .. } => refused(Reason::NotFound, "This attachment is no longer stored on the PC."),
        BlobError::Corrupt { .. } => refused(Reason::Changed, "The stored attachment failed its integrity check."),
        BlobError::ItemTooLarge { .. } => refused(Reason::TooLarge, "Files larger than 256 MB cannot be downloaded."),
        BlobError::Io(error) => WsError::new(Reason::Io, error.to_string()),
    })?;
    // The store is content-addressed: bytes that do not hash to the id are not it.
    let hash: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if hash != id {
        return Err(refused(Reason::Changed, "The stored attachment failed its integrity check."));
    }
    if bytes.len() > MAX_BYTES {
        return Err(refused(Reason::TooLarge, "Files larger than 256 MB cannot be downloaded."));
    }
    let path = std::env::temp_dir().join(format!("mixdog-download-{}", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&path).and_then(|mut file| file.write_all(&bytes).and_then(|()| file.sync_all()));
    let opened = written.and_then(|()| File::open(&path));
    match opened {
        Ok(file) => Ok((file, path)),
        Err(error) => {
            let _ = std::fs::remove_file(&path);
            Err(error.into())
        }
    }
}

#[async_trait]
impl TransferSource for AttachmentSource {
    fn kind(&self) -> &'static str {
        "attachment"
    }

    async fn open(&self, source: &Value, cancel: &CancellationToken) -> WsResult<SourceFile> {
        let session_id = required_session_id(source.get("sessionId"))?;
        // `requiredAttachmentId`: any non-string, or a string off the pattern, is one TypeError.
        let id = source
            .get("attachmentId")
            .and_then(Value::as_str)
            .filter(|id| valid_id(id))
            .ok_or_else(|| WsError::invalid("attachment id is invalid."))?;
        let Some(named) = self.sessions.named(session_id, id).await else {
            return Err(refused(Reason::NotLinked, "This conversation has no such attachment."));
        };
        // `sessionAttachments` defaults: `String(name || 'attachment').slice(0, 200)`, the type
        // `String(mimeType || 'application/octet-stream').slice(0, 100)`.
        let name = mixdog_js::slice_utf16(named.name.as_deref().filter(|n| !n.is_empty()).unwrap_or("attachment"), 200);
        let mime_type =
            mixdog_js::slice_utf16(named.mime_type.as_deref().filter(|m| !m.is_empty()).unwrap_or("application/octet-stream"), 100);
        let digest: BlobDigest = format!("sha256:{id}").parse().map_err(|_| WsError::invalid("attachment id is invalid."))?;
        let (store, wanted) = (self.store.clone(), id.to_owned());
        let (file, path) = on_lane(self.interactive, cancel, move |lane| stage(&store, lane, &digest, &wanted))
            .await
            .map_err(lane_failure)??;
        Ok(SourceFile { file, name: view_name(&name, &mime_type), mime_type, cleanup: Some(path) })
    }
}

#[cfg(test)]
mod tests;
