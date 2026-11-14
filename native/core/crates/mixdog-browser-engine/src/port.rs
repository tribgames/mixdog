//! The engine's ports: the host lane ([`BrowserHost`], over [`HostWire`]), what the host pushes ([`EngineSink`]), and the
//! services the engine takes from the core around it (approvals, takeover, blobs, files, turn ends).
//!
//! `BrowserHost` has one typed async method per `host/browser/*` request. It is implemented once, for every [`HostWire`]: the
//! raw channel (`lane::host_lane` over `Arc<dyn HostChannel>`, and the fake host of the tests) only moves JSON, so the typing,
//! the error mapping and the wire names live here and nowhere else.

use std::path::Path;
use std::path::PathBuf;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_app_protocol::v2::browser_engine::*;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_protocol::ThreadId;
use mixdog_rt::CancellationToken;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::HostCallError;
use crate::types::ApprovalAnswer;
use crate::types::BrowserApprovalPrompt;
use crate::types::FileFacts;
use crate::types::TakeoverGuard;

/// The raw `host/browser/*` channel: a request by wire name with JSON params, answered with JSON or a [`HostCallError`].
#[async_trait]
pub trait HostWire: Send + Sync {
    /// A request that also ends, as `HostCallError::Cancelled`, when `cancel` fires.
    async fn call(&self, method: &'static str, params: Value, cancel: &CancellationToken) -> Result<Value, HostCallError>;

    /// A notification to the host (`host/browser/lease/release`).
    fn notify(&self, method: &'static str, params: Value) -> Result<(), HostCallError>;
}

async fn typed<W, P, R>(wire: &W, method: &'static str, params: P, cancel: &CancellationToken) -> Result<R, HostCallError>
where
    W: HostWire + ?Sized,
    P: Serialize + Send,
    R: DeserializeOwned,
{
    let params = serde_json::to_value(params).map_err(|error| HostCallError::Failed { message: format!("{method}: params do not serialize: {error}") })?;
    let answer = wire.call(method, params, cancel).await?;
    serde_json::from_value(answer).map_err(|error| HostCallError::Failed { message: format!("{method}: malformed answer: {error}") })
}

macro_rules! host_methods {
    ($($(#[$doc:meta])* $name:ident, $wire:literal, $params:ty, $result:ty;)*) => {
        /// The typed host lane. Every call is cancellable: a fired `cancel` abandons the request.
        #[async_trait]
        pub trait BrowserHost: Send + Sync {
            $($(#[$doc])* async fn $name(&self, params: $params, cancel: &CancellationToken) -> Result<$result, HostCallError>;)*

            /// `host/browser/lease/release`: the engine is done with a leased page.
            fn lease_release(&self, params: HostBrowserLeaseReleaseParams) -> Result<(), HostCallError>;
        }

        #[async_trait]
        impl<W: HostWire + ?Sized> BrowserHost for W {
            $(async fn $name(&self, params: $params, cancel: &CancellationToken) -> Result<$result, HostCallError> {
                typed(self, $wire, params, cancel).await
            })*

            fn lease_release(&self, params: HostBrowserLeaseReleaseParams) -> Result<(), HostCallError> {
                let params = serde_json::to_value(params)
                    .map_err(|error| HostCallError::Failed { message: format!("host/browser/lease/release: params do not serialize: {error}") })?;
                self.notify("host/browser/lease/release", params)
            }
        }

        /// Every request's wire name, in the order of the trait: the table the lane and the fake host check names against.
        pub const HOST_METHODS: &[&str] = &[$($wire),*];
    };
}

host_methods! {
    /// `host/browser/pages/resolve`: the page a session's command addresses (open, adopt or lease).
    pages_resolve, "host/browser/pages/resolve", HostBrowserPagesResolveParams, HostBrowserPagesResolveResult;
    pages_list, "host/browser/pages/list", HostBrowserPagesListParams, HostBrowserPagesListResult;
    pages_close, "host/browser/pages/close", HostBrowserPagesCloseParams, HostBrowserPagesCloseResult;
    pages_surface, "host/browser/pages/surface", HostBrowserPagesSurfaceParams, HostBrowserPagesSurfaceResult;
    page_navigate, "host/browser/page/navigate", HostBrowserPageNavigateParams, HostBrowserPageNavigateResult;
    page_stop, "host/browser/page/stop", HostBrowserPageStopParams, HostBrowserPageFactsResult;
    page_eval, "host/browser/page/eval", HostBrowserPageEvalParams, HostBrowserPageEvalResult;
    page_read, "host/browser/page/read", HostBrowserPageReadParams, HostBrowserPageReadResult;
    page_render_checkpoint, "host/browser/page/renderCheckpoint", HostBrowserPageRenderCheckpointParams, HostBrowserPageRenderCheckpointResult;
    page_dom_quiet, "host/browser/page/domQuiet", HostBrowserPageDomQuietParams, HostBrowserPageDomQuietResult;
    page_dialog_answer, "host/browser/page/dialog/answer", HostBrowserPageDialogAnswerParams, HostBrowserPageDialogAnswerResult;
    page_sync, "host/browser/page/sync", HostBrowserPageSyncParams, HostBrowserPageSyncResult;
    snapshot, "host/browser/snapshot", HostBrowserSnapshotParams, HostBrowserSnapshotResult;
    ref_call, "host/browser/ref/call", HostBrowserRefCallParams, HostBrowserRefCallResult;
    ref_mint, "host/browser/ref/mint", HostBrowserRefMintParams, HostBrowserRefMintResult;
    input_batch, "host/browser/input/batch", HostBrowserInputBatchParams, HostBrowserInputBatchResult;
    screenshot, "host/browser/screenshot", HostBrowserScreenshotParams, HostBrowserScreenshotResult;
    cdp_send, "host/browser/cdp/send", HostBrowserCdpSendParams, HostBrowserCdpSendResult;
    cookies, "host/browser/cookies", HostBrowserCookiesParams, HostBrowserCookiesResult;
    storage, "host/browser/storage", HostBrowserStorageParams, HostBrowserStorageResult;
    init_scripts, "host/browser/initScripts", HostBrowserInitScriptsParams, HostBrowserInitScriptsResult;
    intercept, "host/browser/intercept", HostBrowserInterceptParams, HostBrowserInterceptResult;
    performance, "host/browser/performance", HostBrowserPerformanceParams, HostBrowserPerformanceResult;
    emulation, "host/browser/emulation", HostBrowserEmulationParams, HostBrowserEmulationResult;
    downloads, "host/browser/downloads", HostBrowserDownloadsParams, HostBrowserDownloadsResult;
    upload, "host/browser/upload", HostBrowserUploadParams, HostBrowserUploadResult;
    /// `host/browser/upload/receiver`: the frame document an upload to a ref (or to the open chooser) would land in now.
    upload_receiver, "host/browser/upload/receiver", HostBrowserUploadReceiverParams, HostBrowserUploadReceiverResult;
    /// `host/browser/signIn`: the sign-in state the desktop keeps per page and per turn (the saved logins' automatic sign-in, the
    /// linked identity of a provider flow), asked about around a command.
    sign_in, "host/browser/signIn", HostBrowserSignInParams, HostBrowserSignInResult;
    /// `host/browser/turn`: a session's turn ended, or the session was released; the desktop drops what it remembered of them.
    turn, "host/browser/turn", HostBrowserTurnParams, HostBrowserTurnResult;
    /// `host/browser/credentials/fill`: a saved login written into the page by the desktop, which holds the vault.
    credentials_fill, "host/browser/credentials/fill", HostBrowserCredentialsFillParams, HostBrowserCredentialsFillResult;
}

/// What the host pushes, in the order its writer sent it (`host/browser/events`, `page/facts`, `userInput`). Synchronous:
/// an implementation records and returns, it never waits.
pub trait EngineSink: Send + Sync {
    fn events(&self, params: HostBrowserEventsParams);
    fn facts(&self, params: HostBrowserPageFactsParams);
    fn user_input(&self, params: HostBrowserUserInputParams);
    /// The host's claim ended: every page it held is gone.
    fn host_gone(&self);
}

/// Asks the person (or the standing rules behind the one core approval path) about a submit, post or upload.
#[async_trait]
pub trait ApprovalPort: Send + Sync {
    async fn ask(&self, prompt: BrowserApprovalPrompt) -> Result<ApprovalAnswer, ToolError>;
}

/// A person's takeover of a session's pages.
pub trait TakeoverPort: Send + Sync {
    fn begin(&self, session_id: &str) -> Result<TakeoverGuard, String>;
}

/// The core's blob store, by digest (a screenshot or download the host handed over by reference).
#[async_trait]
pub trait BlobPort: Send + Sync {
    async fn read(&self, digest: &str) -> Result<Bytes, String>;
}

/// The files the engine reads facts of (upload paths) and writes (screen frames of a run).
#[async_trait]
pub trait FilePort: Send + Sync {
    async fn stat(&self, path: &Path) -> FileFacts;
    /// Writes one frame beside the run: the file's name (its extension follows `mime_type`) and the pruning of old frames are the
    /// implementation's. A frame that cannot be written is an error, and the reply then keeps the picture inline.
    async fn write_frame(&self, run_dir: &Path, bytes: Bytes, mime_type: &str) -> std::io::Result<PathBuf>;
}

/// What the core tells the engine of a session's turns. The engine counts the turns itself: the turn a command belongs to is the
/// one after the last that ended.
pub trait TurnEvents: Send + Sync {
    /// The session's running turn settled. `aborted`: it ended badly, so the pages it opened for itself are released.
    fn turn_ended(&self, thread: &ThreadId, aborted: bool);
    /// The session's runtime ended: its turn is over and the pages it owned are released.
    fn session_ended(&self, thread: &ThreadId);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_wire_name_is_a_host_request_of_the_protocol() {
        for name in HOST_METHODS {
            assert!(name.starts_with("host/browser/"), "{name}");
        }
        let mut sorted: Vec<_> = HOST_METHODS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), HOST_METHODS.len(), "a wire name is listed twice");
    }
}
