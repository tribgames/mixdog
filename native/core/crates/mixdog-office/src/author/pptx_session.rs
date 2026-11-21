use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};

use mixdog_office_author::html_browser::RunError;
use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

use super::StageHost;
use crate::session::registry::lock;
use crate::session::{Backend, DesignState, Mode, SessionHandle};

/// The prefix of a call's staging folder.
pub const STAGING_PREFIX: &str = ".mixdog-authoring-";

/// Why an author call ended without its result: the caller cancelled it (Node's `AbortError`), or it failed with a reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthorError {
    Abort(String),
    Failed(String),
}

impl AuthorError {
    pub fn message(&self) -> &str {
        match self {
            Self::Abort(message) | Self::Failed(message) => message,
        }
    }

    pub fn is_abort(&self) -> bool {
        matches!(self, Self::Abort(_))
    }
}

impl fmt::Display for AuthorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for AuthorError {}

impl From<String> for AuthorError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<&str> for AuthorError {
    fn from(message: &str) -> Self {
        Self::Failed(message.to_owned())
    }
}

impl From<RunError> for AuthorError {
    fn from(error: RunError) -> Self {
        match error {
            RunError::Cancelled => Self::Abort("Office authoring was cancelled".to_owned()),
            RunError::Failed(message) => Self::Failed(message),
        }
    }
}

/// `throwIfAuthoringCancelled(signal, result)`: the call's token cancelled, or a host answer that says it was.
pub fn throw_if_authoring_cancelled(signal: Option<&CancellationToken>, result: Option<&Value>) -> Result<(), AuthorError> {
    let answered = result.and_then(|result| result.get("cancelled")) == Some(&Value::Bool(true));
    if !signal.is_some_and(CancellationToken::is_cancelled) && !answered {
        return Ok(());
    }
    let reason = result.and_then(|result| result.get("error")).and_then(Value::as_str).filter(|reason| !reason.is_empty());
    Err(AuthorError::Abort(reason.unwrap_or("Office authoring was cancelled").to_owned()))
}

/// `releaseExistingSession(target, signal)`: re-authoring replaces the document, so a session still holding the previous
/// file has to let go first; nothing in it is worth saving because the source is the truth. Answers the released id.
pub async fn release_existing_session<H: StageHost>(host: &H, target: &str, signal: Option<&CancellationToken>) -> Result<Option<String>, AuthorError> {
    throw_if_authoring_cancelled(signal, None)?;
    let Some(existing) = host.session_for_document(target) else { return Ok(None) };
    // A close that fails is not an error here: the record is released below either way.
    let _ = host.close_session(&existing, signal).await;
    throw_if_authoring_cancelled(signal, None)?;
    host.release_session(&existing);
    let id = lock(&existing).id.clone();
    Ok(Some(id))
}

/// `reusableAuthoredSession(target, mode)`: the session whose hidden Microsoft Office process an author may keep. Only a
/// deck authored here, held in the background by a process this runtime started and nobody sees, is handed back, and only
/// when the call allows that backend (`auto` or `background`).
pub fn reusable_authored_session<H: StageHost>(host: &H, target: &str, mode: &str) -> Option<SessionHandle> {
    if !["auto", "background"].contains(&mode) {
        return None;
    }
    let existing = host.session_for_document(target)?;
    let reusable = {
        let session = lock(&existing);
        session.state.transaction().is_none()
            && session.authored.authored
            && session.backend == Backend::MicrosoftOfficeCom
            && session.format == "pptx"
            && session.mode == Mode::Background
            && session.com.ownership.as_deref() == Some("owned")
            && session.com.visible != Some(true)
    };
    reusable.then_some(existing)
}

/// `stagingTarget(target)`: the folder is made on the target's filesystem and the staged file is named like the target.
pub async fn staging_target<H: StageHost>(host: &H, target: &Path) -> Result<PathBuf, AuthorError> {
    let folder = target.parent().filter(|parent| !parent.as_os_str().is_empty()).map_or_else(|| PathBuf::from("."), Path::to_path_buf);
    let directory = host.make_directory(&folder, STAGING_PREFIX).await?;
    let name = target.file_name().map(std::ffi::OsStr::to_os_string).unwrap_or_default();
    Ok(directory.join(name))
}

/// `releaseStagingTarget(staging)`: only the call's own folder goes.
pub async fn release_staging_target<H: StageHost>(host: &H, staging: &Path) {
    if let Some(directory) = staging.parent() {
        host.remove_dir_all(directory).await;
    }
}

/// `swapAuthoredDocument(session, source, signal, { callOffice })`: the held process opens `source` in place of the document
/// it had. Answers whether the swap happened; a host that refused leaves the session as it was and the caller lands the file
/// the old way.
pub async fn swap_authored_document<F, Fut>(
    handle: &SessionHandle,
    source: &Path,
    signal: Option<&CancellationToken>,
    opened_at: &str,
    call_office: F,
) -> Result<bool, AuthorError>
where
    F: FnOnce(Value) -> Fut,
    Fut: Future<Output = Value>,
{
    throw_if_authoring_cancelled(signal, None)?;
    let request = {
        let session = lock(handle);
        json!({
            "action": "reload_document",
            "session": session.id,
            "format": session.format,
            "mode": session.mode.as_str(),
            "path": session.target,
            "source": source.to_string_lossy(),
        })
    };
    let result = call_office(request).await;
    let answered = result.get("ok") == Some(&Value::Bool(true));
    if !answered || result.get("cancelled") == Some(&Value::Bool(true)) {
        throw_if_authoring_cancelled(signal, Some(&result))?;
        return Ok(false);
    }
    adopt_swapped_document(handle, &result, opened_at);
    throw_if_authoring_cancelled(signal, None)?;
    Ok(true)
}

/// A different document stands behind the same session after a swap: every cached reading of the old one goes and the render
/// token stops matching until the new deck is rendered.
fn adopt_swapped_document(handle: &SessionHandle, answer: &Value, opened_at: &str) {
    let mut session = lock(handle);
    session.snapshot_version += 1;
    session.caches.snapshot = None;
    session.caches.render = None;
    session.design_state = DesignState::empty(session.design_state.requires_visual_review, true);
    if let Some(pid) = answer.get("appPid") {
        session.com.app_pid = Some(pid.clone());
    }
    if let Some(hwnd) = answer.get("windowHwnd") {
        session.com.window_hwnd = Some(hwnd.clone());
    }
    if let Some(id) = answer.get("documentId") {
        session.com.document_id = Some(id.clone());
    }
    if let Some(isolation) = answer.get("backgroundIsolation") {
        session.com.background_isolation = Some(isolation.clone());
    }
    session.opened_at = opened_at.to_owned();
}

/// `landStagedDeck(staging, target, signal)`: the staged file is copied over the target and removed. A staged file that is
/// not there (the host already moved it) or is the target itself has nothing to land.
pub async fn land_staged_deck<H: StageHost>(host: &H, staging: &Path, target: &Path, signal: Option<&CancellationToken>) -> Result<(), AuthorError> {
    throw_if_authoring_cancelled(signal, None)?;
    if staging == target || !host.exists(staging).await {
        return Ok(());
    }
    throw_if_authoring_cancelled(signal, None)?;
    host.copy_file(staging, target).await?;
    host.remove_file(staging).await;
    Ok(())
}
