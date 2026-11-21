//! Read-only viewing for documents no browser can open by itself (`pdf/document-preview.mjs`).
//!
//! One LibreOffice pass converts a Word, Excel or PowerPoint document (or its OpenDocument and legacy form) to a PDF; without
//! LibreOffice Microsoft Office renders a private read-only copy through [`mixdog_office_com`].
//!
//! [`DocumentPreview::preview_pdf`] is `documentPreviewPdf`: the cached PDF of one document, converted when needed, with the
//! protection of the document read from its container before any engine starts (the coded errors below).
//! [`DocumentPreview::preview_pages`] is `documentPreviewPages`: pages of a converted PDF as base64 images.
//!
//! Every scratch directory this module creates holds document content: see [`remove_tracked_preview_scratch_sync`]. A document
//! opened with its password is never written to the cache, and nothing of it outlives the process.

mod cache;
mod convert;
mod pages;
mod scratch;

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_fonts::registry::Registry;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_com::{CallOptions, OfficeCom};
use mixdog_ooxml::soffice::{RenderFormat, Soffice};
use mixdog_rt::{CancellationToken, DurabilityIo, InLane, LaneToken, LaneTokens, MaintenanceIo};
use serde_json::{Value, json};

use crate::render::{RenderPagesOptions, RenderedImage, render_pdf_pages};

pub use cache::{DOCUMENT_CACHE_DIRECTORY, MAX_CACHED_DOCUMENTS, MAX_UNLOCKED_DOCUMENTS, PREVIEW_PDF_NAME};
pub use pages::{MAX_CACHED_PAGE_REVISIONS, MAX_MEMORY_PAGE_BYTES, MAX_MEMORY_PAGES, PAGE_CACHE_DIRECTORY};
pub use scratch::{remove_tracked_preview_scratch_sync, tracked_preview_scratch};

/// Marks the "no converter installed" failure; the desktop shows it in the UI language.
pub const OFFICE_PREVIEW_UNAVAILABLE: &str = "OFFICE_PREVIEW_UNAVAILABLE";
/// Marks a password-protected document that a password can open: the desktop asks for it.
pub const OFFICE_PREVIEW_PASSWORD_PROTECTED: &str = "OFFICE_PREVIEW_PASSWORD_PROTECTED";
/// The password given for a protected document does not open it.
pub const OFFICE_PREVIEW_WRONG_PASSWORD: &str = "OFFICE_PREVIEW_WRONG_PASSWORD";
/// A protected document no password route can preview (an encrypted .ppt, an unknown encryption).
pub const OFFICE_PREVIEW_PASSWORD_UNSUPPORTED: &str = "OFFICE_PREVIEW_PASSWORD_UNSUPPORTED";
/// A protected binary Word document only Microsoft Word can open with its password, and Word is not installed.
pub const OFFICE_PREVIEW_PASSWORD_NEEDS_OFFICE: &str = "OFFICE_PREVIEW_PASSWORD_NEEDS_OFFICE";
/// A protected document whose encrypted package fails its integrity check ([MS-OFFCRYPTO] 2.3.4.14), or whose integrity data
/// cannot be checked: it is never rendered, whatever the password.
pub const OFFICE_PREVIEW_PASSWORD_CORRUPT: &str = "OFFICE_PREVIEW_PASSWORD_CORRUPT";

/// The message of an `AbortError`.
const ABORTED: &str = "This operation was aborted";

/// What a Microsoft Office render may take (`OFFICE_PREVIEW_RENDER_TIMEOUT_MS`).
pub(crate) const OFFICE_RENDER_TIMEOUT: Duration = Duration::from_millis(300_000);

/// The first wait of a scratch removal that keeps failing (`SCRATCH_REMOVE_BACKOFF_MS`); it doubles each attempt.
const SCRATCH_REMOVE_BACKOFF: Duration = Duration::from_millis(250);

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A failed preview: a plain `Error`, one with a `code`, or the abort of the request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreviewError {
    code: Option<String>,
    message: String,
    aborted: bool,
}

impl PreviewError {
    /// `new Error(message)`.
    pub fn plain(message: impl Into<String>) -> Self {
        Self { code: None, message: message.into(), aborted: false }
    }

    /// A system error: `code` is its errno name (`ENOENT`).
    pub fn system(code: &str, message: impl Into<String>) -> Self {
        Self { code: Some(code.to_owned()), message: message.into(), aborted: false }
    }

    /// `codedError(message, code)`: the code is part of the message too.
    pub fn coded(message: &str, code: &str) -> Self {
        Self { code: Some(code.to_owned()), message: format!("{message} ({code})"), aborted: false }
    }

    /// `signal.throwIfAborted()`.
    pub fn aborted() -> Self {
        Self { code: None, message: ABORTED.to_owned(), aborted: true }
    }

    pub fn code(&self) -> Option<&str> {
        self.code.as_deref()
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    /// Whether the request was cancelled (an `AbortError`).
    pub fn is_aborted(&self) -> bool {
        self.aborted
    }
}

impl std::fmt::Display for PreviewError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// Runs `job` on `lane` and waits for its answer. The future is boxed here, where its `Send` is proved for any job: left as an
/// `async fn`, a caller that has to be `Send` cannot prove it through the higher-ranked job closures.
pub(crate) fn job<L, R, F>(lane: L, work: F) -> BoxFuture<'static, Result<R, PreviewError>>
where
    L: LaneToken,
    R: Send + 'static,
    F: FnOnce(&InLane<L>) -> R + Send + 'static,
{
    Box::pin(async move {
        let cancel = CancellationToken::new();
        let handle = lane.submit_wait(&cancel, work).await.map_err(|error| PreviewError::plain(error.to_string()))?;
        handle.await.map_err(|error| PreviewError::plain(error.to_string()))
    })
}

/// The text of a failed system call as Node words it (`ENOENT: no such file or directory, stat '<path>'`).
pub(crate) fn system_error(error: &io::Error, call: &str, path: &Path) -> PreviewError {
    let (code, text) = match error.kind() {
        io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        _ => return PreviewError::plain(error.to_string()),
    };
    PreviewError::system(code, format!("{code}: {text}, {call} '{}'", path.display()))
}

/// The convertible format for this filename, or `None` (`documentPreviewFormat`).
pub fn preview_format(path: &str) -> Option<&'static str> {
    const FORMATS: [&str; 14] = ["docx", "doc", "docm", "dotx", "rtf", "odt", "xlsx", "xls", "xlsm", "ods", "pptx", "ppt", "pptm", "odp"];
    let name = path.rsplit(['/', '\\']).next().unwrap_or("");
    let dot = name.rfind('.')?;
    if dot + 1 == name.len() {
        return None;
    }
    let extension = name[dot + 1..].to_lowercase();
    FORMATS.into_iter().find(|format| *format == extension)
}

/// The Office application family that opens each previewable extension.
pub(crate) fn office_family(format: &str) -> &'static str {
    match format {
        "docx" | "doc" | "docm" | "dotx" | "rtf" | "odt" => "docx",
        "xlsx" | "xls" | "xlsm" | "ods" => "xlsx",
        _ => "pptx",
    }
}

/// What Microsoft Office answered, and the end of its host when the answer came while the host was still ending (a cancel or a
/// timeout): the copy it holds open can be removed only after that.
pub struct OfficeAnswer {
    pub value: Value,
    pub host_exit: Option<BoxFuture<'static, ()>>,
}

/// The engines a conversion runs on. Each is one `engines` member of `documentPreviewPdf`.
pub trait PreviewEngines: Send + Sync {
    /// `libreOfficeAvailable()`.
    fn libre_office_available(&self) -> BoxFuture<'_, bool>;
    /// `renderLibreOffice(path, output, { signal })`: the PDF of `path` written at `output`; the error is its message.
    fn render_libre_office(&self, path: PathBuf, output: PathBuf, cancel: CancellationToken) -> BoxFuture<'_, Result<(), String>>;
    /// `detectOffice({ format })`: the host's answer, whose `applications` name what is installed.
    fn detect_office(&self, format: String) -> BoxFuture<'_, Value>;
    /// `callOffice(request, { signal, timeoutMs })`.
    fn call_office(&self, request: Value, timeout: Duration, cancel: CancellationToken) -> BoxFuture<'_, OfficeAnswer>;
    /// `removeDirectory(directory)`: the directory and everything in it; one that is not there is removed.
    fn remove_directory(&self, directory: PathBuf) -> BoxFuture<'_, io::Result<()>>;
    /// `removeBackoffMs`: the first wait before a removal that failed is tried again.
    fn remove_backoff(&self) -> Duration {
        SCRATCH_REMOVE_BACKOFF
    }
}

/// The engines of a process: LibreOffice through the driver of `mixdog-ooxml`, Microsoft Office through COM.
pub struct SystemEngines {
    lanes: LaneTokens,
    office: OfficeCom,
    soffice: &'static Soffice,
}

impl SystemEngines {
    pub fn new(lanes: LaneTokens, office: OfficeCom) -> Self {
        Self { lanes, office, soffice: Soffice::process() }
    }
}

/// Raises a flag when a token is cancelled, for a blocking engine that reads a flag; the watcher ends with the guard.
struct CancelFlag {
    flag: Arc<AtomicBool>,
    watcher: tokio::task::JoinHandle<()>,
}

impl CancelFlag {
    fn follow(cancel: &CancellationToken) -> Self {
        let flag = Arc::new(AtomicBool::new(cancel.is_cancelled()));
        let (raised, token) = (Arc::clone(&flag), cancel.clone());
        let watcher = tokio::spawn(async move {
            token.cancelled().await;
            raised.store(true, Ordering::SeqCst);
        });
        Self { flag, watcher }
    }
}

impl Drop for CancelFlag {
    fn drop(&mut self) {
        self.watcher.abort();
    }
}

impl PreviewEngines for SystemEngines {
    fn libre_office_available(&self) -> BoxFuture<'_, bool> {
        Box::pin(async move {
            let soffice = self.soffice;
            job(self.lanes.maintenance_io, move |_: &InLane<MaintenanceIo>| soffice.available()).await.unwrap_or(false)
        })
    }

    fn render_libre_office(&self, path: PathBuf, output: PathBuf, cancel: CancellationToken) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let follow = CancelFlag::follow(&cancel);
            // As in the password derivation: the watcher must be polled before a lane job holds this thread.
            tokio::task::yield_now().await;
            let flag = Arc::clone(&follow.flag);
            let soffice = self.soffice;
            let done = job(self.lanes.maintenance_io, move |lane: &InLane<MaintenanceIo>| {
                soffice.render(lane, &path, &output, RenderFormat::Pdf, Some(flag.as_ref())).map(|_| ())
            })
            .await;
            drop(follow);
            done.map_err(|error| error.to_string())?
        })
    }

    fn detect_office(&self, format: String) -> BoxFuture<'_, Value> {
        Box::pin(async move { self.office.detect(&format, "").await.value })
    }

    fn call_office(&self, request: Value, timeout: Duration, cancel: CancellationToken) -> BoxFuture<'_, OfficeAnswer> {
        Box::pin(async move {
            let reply = self.office.call(&request, CallOptions { timeout, cancel }).await;
            let host_exit = reply.host_exit.map(|exit| -> BoxFuture<'static, ()> { Box::pin(exit.wait()) });
            OfficeAnswer { value: reply.value, host_exit }
        })
    }

    fn remove_directory(&self, directory: PathBuf) -> BoxFuture<'_, io::Result<()>> {
        Box::pin(async move {
            let removed = job(self.lanes.durability_io, move |lane: &InLane<DurabilityIo>| match mixdog_fsio::remove_dir_all(lane, &directory) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
                _ => Ok(()),
            })
            .await;
            removed.unwrap_or_else(|error| Err(io::Error::other(error.to_string())))
        })
    }
}

/// What a rasteriser returns: the page count of the PDF and the images of the pages asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct RawPages {
    pub page_count: u64,
    pub images: Vec<RawImage>,
}

/// One rasterised page as the rasteriser reports it (`mimeType` is absent from some).
#[derive(Clone, Debug, PartialEq)]
pub struct RawImage {
    pub page: u64,
    pub width: u64,
    pub height: u64,
    pub mime_type: Option<String>,
    pub data: String,
}

/// `renderPages(path, { pages, maxWidth, signal })` of `documentPreviewPages`.
pub trait PageRenderer: Send + Sync {
    fn render_pages(&self, pdf: PathBuf, pages: Vec<u64>, max_width: u32, cancel: CancellationToken) -> BoxFuture<'_, Result<RawPages, PreviewError>>;
}

/// The page rasteriser of a process: [`render_pdf_pages`], whose images land beside their PDF as the cache directory expects.
pub struct RasterPages {
    lanes: LaneTokens,
    registry: Arc<Registry>,
    note: Arc<dyn WriteNote>,
}

impl RasterPages {
    pub fn new(lanes: LaneTokens, registry: Arc<Registry>, note: Arc<dyn WriteNote>) -> Self {
        Self { lanes, registry, note }
    }
}

impl PageRenderer for RasterPages {
    fn render_pages(&self, pdf: PathBuf, pages: Vec<u64>, max_width: u32, cancel: CancellationToken) -> BoxFuture<'_, Result<RawPages, PreviewError>> {
        Box::pin(async move {
            let options = RenderPagesOptions {
                pages: Some(pages.iter().map(|page| *page as f64).collect()),
                max_width: f64::from(max_width),
                cancel: Some(cancel.clone()),
                ..RenderPagesOptions::default()
            };
            let rendered = render_pdf_pages(self.lanes, Arc::clone(&self.registry), Arc::clone(&self.note), &pdf, options)
                .await
                .map_err(|error| if cancel.is_cancelled() { PreviewError::aborted() } else { PreviewError::plain(error.message) })?;
            let images = rendered
                .images
                .iter()
                .map(|image| match image {
                    RenderedImage::Page(page) => (page.page, page.width, page.height, &page.png),
                    RenderedImage::Sheet(sheet) => (sheet.pages[0], sheet.width, sheet.height, &sheet.png),
                })
                .map(|(page, width, height, png)| RawImage {
                    page: page as u64,
                    width: u64::from(width),
                    height: u64::from(height),
                    mime_type: Some("image/png".to_owned()),
                    data: STANDARD.encode(png),
                })
                .collect();
            Ok(RawPages { page_count: rendered.page_count as u64, images })
        })
    }
}

/// The PDF a document previews as: the file and the revision of the document it was made from.
#[derive(Clone, Debug, PartialEq)]
pub struct PdfPreview {
    pub path: PathBuf,
    pub format: String,
    pub mtime_ms: f64,
    pub size: u64,
    pub cached: bool,
}

impl PdfPreview {
    /// The result as Node returns it.
    pub fn to_json(&self) -> Value {
        json!({
            "path": self.path.to_string_lossy(),
            "format": self.format,
            "mtimeMs": mixdog_js::json_number(self.mtime_ms),
            "size": self.size,
            "cached": self.cached,
        })
    }
}

/// One rasterised page of a preview.
#[derive(Clone, Debug, PartialEq)]
pub struct PreviewPage {
    pub page: u64,
    pub width: u64,
    pub height: u64,
    pub mime: String,
    pub base64: String,
}

/// The pages of a preview and the page count of the PDF.
#[derive(Clone, Debug, PartialEq)]
pub struct PreviewPages {
    pub page_count: u64,
    pub pages: Vec<PreviewPage>,
}

impl PreviewPages {
    /// The result as Node returns it.
    pub fn to_json(&self) -> Value {
        json!({
            "pageCount": self.page_count,
            "pages": self.pages.iter().map(|page| json!({
                "page": page.page,
                "width": page.width,
                "height": page.height,
                "mime": page.mime,
                "base64": page.base64,
            })).collect::<Vec<_>>(),
        })
    }
}

/// How one conversion is asked for.
#[derive(Clone, Debug, Default)]
pub struct PreviewOptions {
    /// Where the preview caches live; empty is "storage unavailable".
    pub cache_root: String,
    /// Opens a protected document for this one request; it is handed to the opening step and nowhere else.
    pub password: String,
    pub cancel: CancellationToken,
}

/// How a page render is asked for.
#[derive(Clone, Debug)]
pub struct PagesOptions {
    /// The 1-based pages wanted; none is page 1.
    pub pages: Vec<u64>,
    pub max_width: u32,
    /// Where the page cache lives; empty keeps pages in memory only.
    pub cache_root: String,
    pub cancel: CancellationToken,
}

impl Default for PagesOptions {
    fn default() -> Self {
        Self { pages: vec![1], max_width: 1200, cache_root: String::new(), cancel: CancellationToken::new() }
    }
}

/// The state the previews of one process share: documents being converted, unlocked documents, pages in memory.
#[derive(Default)]
struct State {
    conversions: cache::Conversions,
    unlocked: cache::Unlocked,
    pages: pages::MemoryPages,
}

/// Document previews over a set of engines. Clones share their caches.
#[derive(Clone)]
pub struct DocumentPreview {
    lanes: LaneTokens,
    engines: Arc<dyn PreviewEngines>,
    renderer: Arc<dyn PageRenderer>,
    state: Arc<State>,
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl DocumentPreview {
    pub fn new(lanes: LaneTokens, engines: Arc<dyn PreviewEngines>, renderer: Arc<dyn PageRenderer>) -> Self {
        Self { lanes, engines, renderer, state: Arc::new(State::default()) }
    }

    /// `documentPreviewPdf(path, { cacheRoot, signal, engines, password })`: the cached PDF rendition of one document,
    /// converting it when needed.
    pub async fn preview_pdf(&self, path: &Path, options: PreviewOptions) -> Result<PdfPreview, PreviewError> {
        convert::preview_pdf(self, path, options).await
    }

    /// `documentPreviewPages(pdfPath, { pages, maxWidth, signal, cacheRoot, renderPages })`: rasterised pages of a converted
    /// document, for surfaces that cannot display a PDF. The answer carries the page count so the viewer can ask for the rest.
    pub async fn preview_pages(&self, pdf: &Path, options: PagesOptions) -> Result<PreviewPages, PreviewError> {
        pages::preview_pages(self, pdf, options).await
    }
}

impl std::error::Error for PreviewError {}
