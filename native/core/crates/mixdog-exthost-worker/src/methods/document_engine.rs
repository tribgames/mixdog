use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_fsio::Unlaned;
use mixdog_office_base::write_note::NoWriteNote;
use mixdog_office_com::{OfficeCom, OfficeComConfig};
use mixdog_office_pdf::preview::{
    DocumentPreview, PagesOptions, PreviewError, PreviewOptions, RasterPages, SystemEngines, remove_tracked_preview_scratch_sync,
};
use mixdog_ooxml::soffice::Soffice;
use mixdog_rt::{CancellationToken, LaneToken, LaneTokens, MaintenanceIo};
use tokio::sync::OnceCell;

use super::document::{DocumentEngine, PagesRequest, PdfPreview, PreviewRequest, RenderedPage, RenderedPages};
use crate::error::CodedError;
use crate::registry::{BoxFuture, Registry};
use mixdog_fonts::install::{BoxFuture as FontFuture, Downloaded, FontDirs, FontHost, OfficeFonts, RegisterCommand};
use mixdog_fonts::provision::NOTO_FONTS;

/// The lanes of this process: the one set of executors [`super::pdf_render::lanes`] owns. The process installs its backend once,
/// so a second owner here made whichever of a PDF render and a document preview ran second fail with "backend already installed".
#[cfg(not(feature = "test-support"))]
fn lanes() -> Result<LaneTokens, CodedError> {
    super::pdf_render::lanes()
}

#[cfg(all(test, not(feature = "test-support")))]
mod tests {
    #[test]
    fn the_document_engine_and_the_pdf_tools_share_one_set_of_lanes() {
        super::lanes().expect("first boot");
        super::super::pdf_render::lanes().expect("the same lanes, not a second install");
        super::lanes().expect("and again");
    }
}

/// The lanes of a test process: the inline executors every test shares.
#[cfg(feature = "test-support")]
fn lanes() -> Result<LaneTokens, CodedError> {
    Ok(mixdog_rt::testing::tokens())
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
        // The process's one font scan: a second registry here held every system font's data twice.
        let registry = super::pdf_render::fonts(lanes, &CancellationToken::new()).await?;
        let data_dir = if cache_root.is_empty() { std::env::temp_dir() } else { PathBuf::from(cache_root) };
        let office = OfficeCom::new(OfficeComConfig::new(data_dir, lanes));
        let engines = Arc::new(SystemEngines::new(lanes, office));
        let renderer = Arc::new(RasterPages::new(lanes, registry, Arc::new(NoWriteNote)));
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
            let options = PreviewOptions { cache_root: request.cache_root, password: request.password.unwrap_or_default(), cancel: request.cancel };
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
            let options = PagesOptions { pages: request.pages, max_width: request.max_width, cache_root: request.cache_root, cancel: request.cancel };
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

    /// The Noto faces LibreOffice renders with, provisioned after an install as the Node worker did: the one provisioner of
    /// `mixdog_fonts::install` (the daemon runs the same), over this process's fetch and process spawn. A face that fails keeps
    /// its own result and nothing is thrown.
    fn prepare_fonts(&self) -> BoxFuture<()> {
        Box::pin(async {
            let Ok(tokens) = lanes() else { return };
            let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
            let dirs = FontDirs::for_host(&|name| std::env::var(name).ok(), Path::new(&home));
            let fonts = OfficeFonts::new(Arc::new(WorkerFontHost), tokens.durability_io, dirs, std::env::vars().collect());
            drop(fonts.prepare(&NOTO_FONTS).await);
        })
    }
}

/// The fetch and the process spawn the font provisioner runs on in a worker.
struct WorkerFontHost;

impl FontHost for WorkerFontHost {
    fn get(&self, url: &str) -> FontFuture<'_, Result<Downloaded, String>> {
        let url = url.to_owned();
        Box::pin(async move {
            let response = reqwest::Client::new().get(&url).send().await.map_err(|error| error.to_string())?;
            let status = response.status().as_u16();
            let body = if response.status().is_success() { response.bytes().await.map_err(|error| error.to_string())?.to_vec() } else { Vec::new() };
            Ok(Downloaded { status, body })
        })
    }

    fn run(&self, command: RegisterCommand) -> FontFuture<'_, ()> {
        Box::pin(async move {
            let mut child = tokio::process::Command::new(&command.program);
            child
                .args(&command.args)
                .current_dir(&command.cwd)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            if let Some(env) = &command.env {
                child.env_clear().envs(env);
            }
            #[cfg(windows)]
            child.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            if let Ok(mut child) = child.spawn() {
                // A child that outlives its budget is killed when the wait is dropped (`kill_on_drop`).
                drop(mixdog_rt::time::timeout(command.timeout, child.wait()).await);
            }
        })
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
