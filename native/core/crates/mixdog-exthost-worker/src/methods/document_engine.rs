//! The document engine of a worker process: `documentPreviewPdf` and `documentPreviewPages` of `pdf/document-preview.mjs` over
//! `mixdog_office_pdf::preview`, for the handler layer in [`super::document`].
//!
//! The process boots the executors the preview runs its file, compute and child-process work on the first time a call needs
//! them, and builds the preview (the system fonts scanned once, Microsoft Office through its transport) on that first call, so a
//! worker that is only asked about a PDF or the LibreOffice status starts as fast as before. The scratch a preview leaves
//! (a private copy of a document, a decrypted package, an unlocked PDF) is removed as the worker leaves.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_fonts::discovery::{HostEnv, scan};
use mixdog_fsio::Unlaned;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_office_com::{OfficeCom, OfficeComConfig};
use mixdog_office_pdf::preview::{
    DocumentPreview, PagesOptions, PreviewError, PreviewOptions, RasterPages, SystemEngines, remove_tracked_preview_scratch_sync,
};
use mixdog_ooxml::soffice::Soffice;
use mixdog_rt::{CancellationToken, InLane, LaneToken, LaneTokens, MaintenanceIo};
use tokio::sync::OnceCell;

use super::document::{DocumentEngine, PagesRequest, PdfPreview, PreviewRequest, RenderedPage, RenderedPages};
use crate::error::CodedError;
use crate::registry::{BoxFuture, Registry};

/// The lanes of this process: production executors started once, kept for the life of the process.
#[cfg(not(feature = "test-support"))]
fn lanes() -> Result<LaneTokens, CodedError> {
    use std::sync::OnceLock;
    static LANES: OnceLock<Result<(Arc<mixdog_rt::exec::Executors>, LaneTokens), String>> = OnceLock::new();
    LANES
        .get_or_init(|| mixdog_rt::exec::boot(mixdog_rt::exec::RtConfig::detect()).map_err(|error| error.to_string()))
        .as_ref()
        .map(|(_, tokens)| *tokens)
        .map_err(|error| CodedError::failed(error.clone()))
}

/// The lanes of a test process: the inline executors every test shares.
#[cfg(feature = "test-support")]
fn lanes() -> Result<LaneTokens, CodedError> {
    Ok(mixdog_rt::testing::tokens())
}

/// The system's fonts, scanned on a lane of their own.
async fn system_fonts(lanes: LaneTokens) -> Result<mixdog_fonts::registry::Registry, CodedError> {
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    let env = HostEnv::current(&|name| std::env::var(name).ok(), Path::new(&home));
    let cancel = CancellationToken::new();
    let handle = lanes
        .maintenance_io
        .submit_wait(&cancel, move |lane: &InLane<MaintenanceIo>| scan(lane, &env).registry)
        .await
        .map_err(|error| CodedError::failed(error.to_string()))?;
    handle.await.map_err(|error| CodedError::failed(error.to_string()))
}

/// What a preview error answers: its code when it has one, the cancellation of the call when it is an abort.
fn answer(error: PreviewError) -> CodedError {
    if error.is_aborted() {
        return CodedError::cancelled();
    }
    match error.code() {
        Some(code) => CodedError::new(code, error.message()),
        None => CodedError::failed(error.message()),
    }
}

/// The engine the build registers: one preview per process, made on first use.
pub(super) struct OfficeEngine {
    preview: Arc<OnceCell<DocumentPreview>>,
}

impl OfficeEngine {
    pub(super) fn new() -> Self {
        Self { preview: Arc::new(OnceCell::new()) }
    }
}

/// The preview of this process. Microsoft Office's transport keeps its scripts under the cache root of the first call (the
/// root is the install's, the same on every call), the temporary directory when the call has none.
async fn preview_of(cell: &OnceCell<DocumentPreview>, cache_root: &str) -> Result<DocumentPreview, CodedError> {
    cell.get_or_try_init(|| async {
        let lanes = lanes()?;
        let registry = system_fonts(lanes).await?;
        let data_dir = if cache_root.is_empty() { std::env::temp_dir() } else { PathBuf::from(cache_root) };
        let office = OfficeCom::new(OfficeComConfig::new(data_dir, lanes));
        let engines = Arc::new(SystemEngines::new(lanes, office));
        let renderer = Arc::new(RasterPages::new(lanes, Arc::new(registry), Arc::new(NoWriteNote)));
        Ok(DocumentPreview::new(lanes, engines, renderer))
    })
    .await
    .cloned()
}

impl DocumentEngine for OfficeEngine {
    fn preview_pdf(&self, request: PreviewRequest) -> BoxFuture<Result<PdfPreview, CodedError>> {
        let cell = Arc::clone(&self.preview);
        Box::pin(async move {
            let preview = preview_of(&cell, &request.cache_root).await?;
            let options = PreviewOptions {
                cache_root: request.cache_root,
                password: request.password.unwrap_or_default(),
                cancel: request.cancel,
            };
            let made = preview.preview_pdf(&request.file, options).await.map_err(answer)?;
            Ok(PdfPreview {
                path: made.path.to_string_lossy().into_owned(),
                format: made.format,
                mtime_ms: made.mtime_ms,
                size: made.size,
                cached: made.cached,
            })
        })
    }

    fn preview_pages(&self, request: PagesRequest) -> BoxFuture<Result<RenderedPages, CodedError>> {
        let cell = Arc::clone(&self.preview);
        Box::pin(async move {
            let preview = preview_of(&cell, &request.cache_root).await?;
            let options = PagesOptions {
                pages: request.pages,
                max_width: request.max_width,
                cache_root: request.cache_root,
                cancel: request.cancel,
            };
            let rendered = preview.preview_pages(Path::new(&request.pdf), options).await.map_err(answer)?;
            Ok(RenderedPages {
                page_count: rendered.page_count,
                pages: rendered
                    .pages
                    .into_iter()
                    .map(|page| RenderedPage { page: page.page, width: page.width, height: page.height, mime: page.mime, base64: page.base64 })
                    .collect(),
            })
        })
    }

    /// The Noto faces LibreOffice renders with are provisioned by the daemon's font provisioner, which this worker cannot reach
    /// (see `nr-office-pdf-preview` in the pending wire): until it is moved into a crate the worker links, an install here
    /// leaves them to the next time the daemon prepares the office fonts.
    fn prepare_fonts(&self) -> BoxFuture<()> {
        Box::pin(async {})
    }
}

/// The scratch of every preview this process made and the private LibreOffice profile are removed as the worker leaves.
pub(super) fn register_exit(registry: &mut Registry) {
    registry.on_exit(|| async {
        remove_tracked_preview_scratch_sync(&Unlaned);
        Soffice::process().shutdown(&Unlaned);
    });
}

/// The lane `submit_wait` is called through is a lane token.
const _: fn() = || {
    fn lane<L: LaneToken>() {}
    lane::<MaintenanceIo>();
};
