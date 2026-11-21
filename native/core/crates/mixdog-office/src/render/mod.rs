//! The render action of the office engine (`render` of `core/office-actions-render.mjs` and what it calls): a session's document
//! exported to a PDF, drawn as page images and handed back with the review token that names those pixels.
//!
//! - [`preview`]: the export and the page images, the whole-result cache and the page-by-page reuse of a deck
//!   (`core/office-render-preview.mjs`).
//! - [`page_cache`]: the per-slide signatures that say which pages of a deck can be taken from the render before
//!   (`core/pptx-page-cache.mjs`).
//! - [`toc_pages`]: the page numbers of a Word contents field, read from the rendered layout (`core/docx-toc-pages.mjs`).
//!
//! What touches the machine (the files, LibreOffice, Microsoft Office, the page rasteriser) is a [`RenderEngine`]; [`SystemRender`]
//! is the one a process uses, and a test supplies its own. The functions are async only for those calls and, like the snapshot,
//! their futures are driven by the caller.

pub mod page_cache;
pub mod preview;
pub mod toc_pages;

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use mixdog_fonts::registry::Registry;
use mixdog_fsio::WriteProof;
use mixdog_js::{json_number, to_number, value_to_string};
use mixdog_office_author::review_artifacts::{Receipts, ReviewSession, pptx_review_artifacts};
use mixdog_office_base::values::truthy;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_com::{CallOptions, OfficeCom};
use mixdog_office_pdf::render::{RenderPagesOptions, render_pdf_pages};
use mixdog_ooxml::package::{load_package, save_package};
use mixdog_ooxml::soffice::{RenderFormat, Soffice};
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_ooxml::xlsx::apply_xlsx;
use mixdog_ooxml::xlsx_recalculate::recalculate_portable_workbook;
use mixdog_rt::{CancellationToken, InLane, LaneToken, LaneTokens};
use serde_json::{Map, Value, json};

use self::page_cache::{PageSignature, pptx_page_signatures};
use self::preview::{PreviewOptions, View, render_office_preview};
use self::toc_pages::number_docx_table_of_contents;
use crate::session::registry::lock;
use crate::session::{Backend, RecalculationCache, SessionHandle};

pub use self::preview::{cached_office_preview, default_render_output};

/// What Microsoft Office may take to render a document (`timeoutMs: 300_000` of the render call).
const OFFICE_RENDER_TIMEOUT: Duration = Duration::from_millis(300_000);

/// What a render needs of the machine.
pub trait RenderEngine {
    /// The call's write ledger: told of a file before it is written, so the turn review can capture its prior state.
    fn note(&self) -> &dyn WriteNote;
    /// The faces the page numbers and the contact sheet are set in.
    fn fonts(&self) -> &Registry;
    fn exists(&self, path: &Path) -> impl Future<Output = bool>;
    /// `mkdir(dir, { recursive: true })`.
    fn make_directory(&self, directory: &Path) -> impl Future<Output = Result<(), String>>;
    /// `pptxPageSignatures(path)`.
    fn page_signatures(&self, target: &Path) -> impl Future<Output = Result<Vec<PageSignature>, String>>;
    /// `exportDocument(session, output)`: the whole document as a PDF at `output` (a PDF is copied, Microsoft Office renders its
    /// own documents, LibreOffice the portable ones; a portable Word document is drawn twice so its contents field learns its
    /// page numbers from the PDF layout).
    fn export_document(&self, session: &View, output: &Path) -> impl Future<Output = Result<(), String>>;
    /// `renderPdfPages(output, { pages, maxWidth, signal })`: `{ pageCount, images, visualCoverage }` as Node returns it.
    fn rasterize(&self, output: &Path, pages: Option<&[f64]>, max_width: f64, cancel: Option<CancellationToken>)
    -> impl Future<Output = Result<Value, String>>;
    /// `recalculatePortableWorkbook(path, { force, signal })`.
    fn recalculate_workbook(&self, target: &Path, force: bool, cancel: Option<CancellationToken>) -> impl Future<Output = Result<Value, String>>;
    /// `applyPortableOoxmlBatch(path, 'xlsx', operations)`: the operations applied to the workbook and the package saved.
    fn refit_columns(&self, target: &Path, operations: &[Value]) -> impl Future<Output = Result<Vec<Value>, String>>;
}

/// `recalculateForReview(session, signal)`: a portable workbook is calculated before it is read or drawn, so the pixels show the
/// values the file holds and finalize's own recalculation finds nothing to change, so the review token the caller brings back is
/// still the current one. A recalculation can change the file without a batch: the pre-recalculation pixels are never
/// acknowledged, and a successfully calculated version is never recalculated again.
pub async fn recalculate_for_review<E: RenderEngine>(engine: &E, handle: &SessionHandle) -> Result<Option<Value>, String> {
    let (target, version, cancel) = {
        let session = lock(handle);
        if session.backend != Backend::MixdogOoxml || session.format != "xlsx" {
            return Ok(None);
        }
        if let Some(cache) = session.caches.recalculation.as_ref().filter(|cache| cache.version == session.snapshot_version) {
            return Ok(Some(cache.result.clone()));
        }
        (session.target.clone(), session.snapshot_version, session.active_signal.clone())
    };
    let mut result = engine.recalculate_workbook(Path::new(&target), version > 0, cancel).await?;
    let flag = |name: &str| result.get(name).is_some_and(truthy);
    if flag("recalculated") {
        repeat_column_fit(engine, handle, &target, &mut result).await;
        let mut session = lock(handle);
        session.caches.render = None;
        session.design_state.rendered_version = Value::Null;
        session.design_state.review_token = Some(Value::String(String::new()));
    }
    if !result.get("needed").is_some_and(truthy) || result.get("recalculated").is_some_and(truthy) {
        lock(handle).caches.recalculation = Some(RecalculationCache { version, result: result.clone() });
    }
    Ok(Some(result))
}

/// A width measured before the values existed fits an empty cell, so the computed column renders as ###: the fit the caller
/// already asked for is repeated now that the numbers are there, and its outcome joins the recalculation's result.
async fn repeat_column_fit<E: RenderEngine>(engine: &E, handle: &SessionHandle, target: &str, result: &mut Value) {
    let ranges = lock(handle).authored.autofit_ranges.clone();
    if ranges.is_empty() {
        return;
    }
    let operations: Vec<Value> = ranges
        .iter()
        .map(|entry| {
            let mut operation = Map::new();
            operation.insert("op".to_owned(), Value::String("autofit_range".to_owned()));
            if let Value::Object(fields) = entry {
                operation.extend(fields.clone());
            }
            Value::Object(operation)
        })
        .collect();
    let outcome = engine.refit_columns(Path::new(target), &operations).await;
    if let Some(fields) = result.as_object_mut() {
        match outcome {
            Ok(refit) => {
                let columns: f64 = refit.iter().map(|entry| entry.get("columns").filter(|columns| truthy(columns)).map_or(0.0, to_number)).sum();
                fields.insert("refittedColumns".to_owned(), json_number(columns));
            }
            Err(error) => {
                fields.insert("refitError".to_owned(), Value::String(error));
            }
        }
    }
}

/// `render(session, args, cwd)`: the workbook calculated, the document drawn, and for a deck (or a PDF of designed pages) the
/// receipt and the contact sheet beside the pages, so a standalone render reads as the author call does. `proof` writes the
/// sheet; `receipts` are the engine's receipt functions.
pub async fn render<E: RenderEngine, P: WriteProof>(
    engine: &E,
    proof: &P,
    handle: &SessionHandle,
    args: &Value,
    cwd: &Path,
    receipts: &dyn Receipts,
) -> Result<Value, String> {
    recalculate_for_review(engine, handle).await?;
    let preview = render_office_preview(engine, handle, args, cwd, PreviewOptions::default()).await?;
    let (reviewed, session) = {
        let session = lock(handle);
        (
            session.format == "pptx" || session.authored.frame,
            ReviewSession {
                authored_frame: session.authored.frame,
                frame_receipt: session.authored.frame_receipt.clone(),
                authored: session.authored.authored,
            },
        )
    };
    // A PDF of designed pages is reviewed as the deck it was measured as: receipt and contact sheet.
    if reviewed { Ok(pptx_review_artifacts(proof, engine.fonts(), engine.note(), &session, receipts, &preview)) } else { Ok(preview) }
}

/// Runs `work` on `lane` and waits for its answer.
async fn lane_job<L, R, F>(lane: L, work: F) -> Result<R, String>
where
    L: LaneToken,
    R: Send + 'static,
    F: FnOnce(&InLane<L>) -> R + Send + 'static,
{
    let cancel = CancellationToken::new();
    let handle = lane.submit_wait(&cancel, work).await.map_err(|error| error.to_string())?;
    handle.await.map_err(|error| error.to_string())
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

/// The engine of a process: files on the lanes, LibreOffice through the driver of `mixdog-ooxml`, Microsoft Office through COM and
/// the pages drawn by `mixdog-office-pdf`.
pub struct SystemRender {
    lanes: LaneTokens,
    office: OfficeCom,
    soffice: &'static Soffice,
    fonts: Arc<Registry>,
    note: Arc<dyn WriteNote>,
}

impl SystemRender {
    pub fn new(lanes: LaneTokens, office: OfficeCom, fonts: Arc<Registry>, note: Arc<dyn WriteNote>) -> Self {
        Self { lanes, office, soffice: Soffice::process(), fonts, note }
    }

    async fn draw_portable(&self, target: &Path, output: &Path, docx: bool) -> Result<(), String> {
        let soffice = self.soffice;
        let (source, destination) = (target.to_path_buf(), output.to_path_buf());
        lane_job(self.lanes.maintenance_io, move |lane| soffice.render(lane, &source, &destination, RenderFormat::Pdf, None).map(|_| ())).await??;
        if !docx {
            return Ok(());
        }
        // The contents field learns its page numbers from this layout; a changed cache is drawn once more.
        let note = Arc::clone(&self.note);
        let (source, layout) = (target.to_path_buf(), output.to_path_buf());
        let numbered = lane_job(self.lanes.maintenance_io, move |lane| number_docx_table_of_contents(lane, note.as_ref(), &source, &layout)).await??;
        if numbered {
            let (source, destination) = (target.to_path_buf(), output.to_path_buf());
            lane_job(self.lanes.maintenance_io, move |lane| soffice.render(lane, &source, &destination, RenderFormat::Pdf, None).map(|_| ())).await??;
        }
        Ok(())
    }
}

impl RenderEngine for SystemRender {
    fn note(&self) -> &dyn WriteNote {
        self.note.as_ref()
    }

    fn fonts(&self) -> &Registry {
        &self.fonts
    }

    async fn exists(&self, path: &Path) -> bool {
        let path = path.to_path_buf();
        lane_job(self.lanes.interactive_io, move |lane| mixdog_fsio::exists(lane, &path).unwrap_or(false)).await.unwrap_or(false)
    }

    async fn make_directory(&self, directory: &Path) -> Result<(), String> {
        let directory = directory.to_path_buf();
        lane_job(self.lanes.durability_io, move |lane| mixdog_fsio::create_dir_all(lane, &directory).map_err(|error| error.to_string())).await?
    }

    async fn page_signatures(&self, target: &Path) -> Result<Vec<PageSignature>, String> {
        let target = target.to_path_buf();
        lane_job(self.lanes.maintenance_io, move |lane| pptx_page_signatures(lane, &target)).await?
    }

    async fn export_document(&self, session: &View, output: &Path) -> Result<(), String> {
        let target = PathBuf::from(&session.target);
        if session.format == "pdf" {
            if output != target {
                let (from, to) = (target.clone(), output.to_path_buf());
                lane_job(self.lanes.durability_io, move |lane| mixdog_fsio::copy(lane, &from, &to).map(|_| ()).map_err(|error| error.to_string())).await??;
            }
            return Ok(());
        }
        if session.backend == Backend::MicrosoftOfficeCom {
            let request = json!({
                "action": "render",
                "session": session.id,
                "format": session.format,
                "mode": session.mode.as_str(),
                "path": session.target,
                "output": output.to_string_lossy(),
            });
            let options = CallOptions { timeout: OFFICE_RENDER_TIMEOUT, cancel: session.cancel.clone().unwrap_or_default() };
            let answer = self.office.call(&request, options).await.value;
            if !answer.get("ok").is_some_and(truthy) {
                return Err(answer.get("error").filter(|error| truthy(error)).map_or_else(|| "Microsoft Office render failed".to_owned(), value_to_string));
            }
            return Ok(());
        }
        self.draw_portable(&target, output, session.format == "docx").await
    }

    async fn rasterize(&self, output: &Path, pages: Option<&[f64]>, max_width: f64, cancel: Option<CancellationToken>) -> Result<Value, String> {
        let options = RenderPagesOptions { pages: pages.map(<[f64]>::to_vec), max_width, cancel, ..RenderPagesOptions::default() };
        render_pdf_pages(self.lanes, Arc::clone(&self.fonts), Arc::clone(&self.note), output, options)
            .await
            .map(|rendered| rendered.to_json())
            .map_err(|error| error.to_string())
    }

    async fn recalculate_workbook(&self, target: &Path, force: bool, cancel: Option<CancellationToken>) -> Result<Value, String> {
        let (soffice, note, target) = (self.soffice, Arc::clone(&self.note), target.to_path_buf());
        let follow = cancel.as_ref().map(CancelFlag::follow);
        let flag = follow.as_ref().map(|follow| Arc::clone(&follow.flag));
        let done =
            lane_job(self.lanes.maintenance_io, move |lane| recalculate_portable_workbook(lane, note.as_ref(), soffice, &target, force, flag.as_deref())).await;
        drop(follow);
        done?
    }

    async fn refit_columns(&self, target: &Path, operations: &[Value]) -> Result<Vec<Value>, String> {
        let (note, fonts, target, operations) = (Arc::clone(&self.note), Arc::clone(&self.fonts), target.to_path_buf(), operations.to_vec());
        lane_job(self.lanes.maintenance_io, move |lane| -> Result<Vec<Value>, String> {
            let measurer = TextMeasurer::new(lane, &fonts);
            let mut zip = load_package(lane, &target)?;
            let results = apply_xlsx(lane, &measurer, &mut zip, &operations)?;
            save_package(lane, note.as_ref(), &zip, &target)?;
            Ok(results)
        })
        .await?
    }
}
