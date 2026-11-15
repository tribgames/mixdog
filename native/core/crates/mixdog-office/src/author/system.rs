//! [`SystemAuthor`]: the [`AuthorHost`] of a process. The files go through the lanes, the sessions through the engine's registry,
//! the documents are laid out by the shared render browser, measured by the inline audit and drawn by the render engine.
//!
//! A pptxgenjs script runs on the embedded JavaScript runtime of the extension host. Where that runtime is not part of the
//! build the route is off and says why: an HTML source is the one that always works.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_fonts::registry::Registry as FontRegistry;
use mixdog_fsio::WriteProof;
use mixdog_js::value_to_string;
use mixdog_office_author::html_browser::{AuthorLanes, RunError};
use mixdog_office_author::pdf_print::{PrintOptions, frame_canvas, print_html_pdf};
use mixdog_office_author::pptx_html_runner::{HTML_DRIFT_PX, RunOptions, measure_html_drift, run_pptx_html_authoring, write_html_comparisons};
use mixdog_office_author::docx_html_runner::{DocxRunOptions, run_docx_html_authoring};
use mixdog_office_author::xlsx_html_runner::{XlsxRunOptions, run_xlsx_html_authoring};
use mixdog_office_author::measure_deck::Prepare;
use mixdog_office_author::receipt::{DeliveredReceipt, PageRead, attach_rendered_air, composition_receipt, receipt_for_delivery};
use mixdog_office_author::review_artifacts::Receipts;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_design::library::iso_string;
use mixdog_office_pdf::adapter::{SnapshotOptions, snapshot_pdf};
use mixdog_office_quality::render_air::rendered_air_by_page;
use mixdog_ooxml::snapshot::snapshot_portable_ooxml;
use mixdog_pdf::write::DocumentProperties;
use mixdog_raster::svg::SvgFonts;
use mixdog_rt::{CancellationToken, InLane, LaneToken, LaneTokens};
use serde_json::{Value, json};

use super::html_document::comparison_sheet;
use super::{AuthorHost, StageHost};
use crate::inline_audit::inline_office_audit;
use crate::inspect::InspectContext;
use crate::render::{RenderEngine, render};
use crate::session::SessionHandle;
use crate::session::mode::OfficeHost;
use crate::session::open::{SessionCloser, SessionEnv};
use crate::session::registry::lock;
use crate::snapshot::{ComHost, snapshot};

/// A fresh folder name is made of the process, the clock and this count.
static FOLDERS: AtomicU64 = AtomicU64::new(0);

/// What a render of a deck reads of the session's receipt: the receipt read beforehand (the readers are asynchronous, the
/// render's seam is not) and the session's memory of what it last sent.
struct SessionReceipts<'a> {
    receipt: Option<Value>,
    deliveries: &'a Mutex<HashMap<String, DeliveredReceipt>>,
    id: String,
}

impl Receipts for SessionReceipts<'_> {
    fn composition_receipt(&self) -> Option<Value> {
        self.receipt.clone()
    }

    fn attach_rendered_air(&self, receipt: &mut Value, images: &[Value]) {
        let reads: Vec<(f64, PageRead)> = rendered_air_by_page(images).iter().map(|(page, read)| (*page, PageRead::from(read))).collect();
        attach_rendered_air(receipt, &reads);
    }

    fn for_delivery(&self, receipt: Value) -> Value {
        deliver(self.deliveries, &self.id, &receipt)
    }
}

fn deliver(deliveries: &Mutex<HashMap<String, DeliveredReceipt>>, id: &str, receipt: &Value) -> Value {
    let mut held = deliveries.lock().unwrap_or_else(PoisonError::into_inner);
    receipt_for_delivery(receipt, Some(held.entry(id.to_owned()).or_default()))
}

/// `applyDocumentProperties`' reading of `args.properties`: title, author, subject and keywords, each when present (`!= null`),
/// as `String(value)`.
fn document_properties(properties: &Value) -> DocumentProperties {
    let present = |key: &str| properties.get(key).filter(|value| !value.is_null());
    DocumentProperties {
        title: present("title").map(value_to_string),
        author: present("author").map(value_to_string),
        subject: present("subject").map(value_to_string),
        keywords: present("keywords").map(|keywords| match keywords {
            Value::Array(items) => items.iter().map(value_to_string).collect(),
            other => vec![value_to_string(other)],
        }),
    }
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

/// The author host of a process.
pub struct SystemAuthor<'a, P: WriteProof, H: OfficeHost + ComHost, C: SessionCloser, R: RenderEngine> {
    /// What open and create run with (the design library, the registry, the Office host, the data directory).
    pub env: SessionEnv<'a, P, H>,
    /// What the inline audit and the snapshots run with.
    pub inspect: &'a InspectContext<'a, P, H>,
    /// Draws the documents.
    pub render: &'a R,
    /// The finalize stage's close of a Microsoft Office session.
    pub closer: &'a C,
    /// The shared render browser.
    pub endpoint: &'a dyn BrowserEndpoint,
    pub lanes: LaneTokens,
    pub fonts: Arc<FontRegistry>,
    /// The faces an SVG drawing's text is set in.
    pub svg_fonts: &'a SvgFonts,
    /// The call's write ledger.
    pub note: Arc<dyn WriteNote>,
    /// What each session was last sent of its receipt.
    pub deliveries: Mutex<HashMap<String, DeliveredReceipt>>,
}

impl<P: WriteProof, H: OfficeHost + ComHost, C: SessionCloser, R: RenderEngine> SystemAuthor<'_, P, H, C, R> {
    /// The environment of a call: the same engine with the call's own cancellation.
    fn session_env<'e>(&'e self, signal: Option<&'e CancellationToken>) -> SessionEnv<'e, P, H> {
        SessionEnv {
            design: self.env.design,
            note: self.env.note,
            registry: self.env.registry,
            host: self.env.host,
            legacy: self.env.legacy,
            data_dir: self.env.data_dir,
            cwd: self.env.cwd,
            cancel: signal,
        }
    }
}

impl<P: WriteProof, H: OfficeHost + ComHost, C: SessionCloser, R: RenderEngine> StageHost for SystemAuthor<'_, P, H, C, R> {
    async fn exists(&self, path: &Path) -> bool {
        let path = path.to_path_buf();
        lane_job(self.lanes.interactive_io, move |lane| mixdog_fsio::exists(lane, &path).unwrap_or(false)).await.unwrap_or(false)
    }

    async fn read_text(&self, path: &Path) -> Result<String, String> {
        let path = path.to_path_buf();
        lane_job(self.lanes.interactive_io, move |lane| mixdog_fsio::read_to_string(lane, &path).map_err(|error| format!("{}: {error}", path.display()))).await?
    }

    async fn make_directory(&self, parent: &Path, prefix: &str) -> Result<PathBuf, String> {
        let (parent, prefix) = (parent.to_path_buf(), prefix.to_owned());
        lane_job(self.lanes.durability_io, move |lane| {
            mixdog_fsio::create_dir_all(lane, &parent).map_err(|error| format!("{}: {error}", parent.display()))?;
            loop {
                let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.subsec_nanos());
                let count = FOLDERS.fetch_add(1, Ordering::Relaxed);
                let path = parent.join(format!("{prefix}{:x}{nanos:x}{count:x}", std::process::id()));
                match mixdog_fsio::create_dir(lane, &path) {
                    Ok(()) => return Ok(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(format!("{}: {error}", path.display())),
                }
            }
        })
        .await?
    }

    async fn copy_file(&self, from: &Path, to: &Path) -> Result<(), String> {
        let (from, to) = (from.to_path_buf(), to.to_path_buf());
        lane_job(self.lanes.durability_io, move |lane| mixdog_fsio::copy(lane, &from, &to).map(drop).map_err(|error| format!("{}: {error}", to.display()))).await?
    }

    async fn remove_file(&self, path: &Path) {
        let path = path.to_path_buf();
        let _ = lane_job(self.lanes.durability_io, move |lane| mixdog_fsio::remove_file(lane, &path)).await;
    }

    async fn remove_dir_all(&self, path: &Path) {
        let path = path.to_path_buf();
        let _ = lane_job(self.lanes.durability_io, move |lane| mixdog_fsio::remove_dir_all(lane, &path)).await;
    }

    fn session_for_document(&self, target: &str) -> Option<SessionHandle> {
        self.env.registry.for_document(self.env.design.env, target)
    }

    fn release_session(&self, handle: &SessionHandle) {
        self.env.registry.release(self.env.design.env, handle);
    }

    async fn close_session(&self, handle: &SessionHandle, _signal: Option<&CancellationToken>) -> Result<(), String> {
        self.closer.close(handle).await
    }
}

impl<P: WriteProof, H: OfficeHost + ComHost, C: SessionCloser, R: RenderEngine> AuthorHost for SystemAuthor<'_, P, H, C, R> {
    fn note_write(&self, path: &Path) {
        self.note.note_write(path);
    }

    fn now_iso(&self) -> String {
        iso_string((self.env.design.env.now_ms)())
    }

    async fn office_call(&self, request: &Value, signal: Option<&CancellationToken>) -> Value {
        ComHost::call(self.env.host, request, signal, None).await
    }

    async fn create_authored_session(&self, args: &Value, target: &str, signal: Option<&CancellationToken>) -> Result<SessionHandle, String> {
        crate::session::create::create_authored_session(&self.session_env(signal), args, target).await
    }

    fn register_html_pdf_session(&self, args: &Value, target: &str, target_existed: bool, receipt: Value) -> Result<SessionHandle, String> {
        crate::session::create::register_html_pdf_session(&self.session_env(None), args, target, target_existed, receipt)
    }

    async fn release_overwritten_session(&self, target: &str) -> Result<(), String> {
        crate::session::create::release_overwritten_session(&self.session_env(None), self.closer, target, true).await
    }

    async fn snapshot_deck(&self, path: &Path) -> Result<Value, String> {
        let cx = &self.inspect.snapshot;
        snapshot_portable_ooxml(cx.proof, cx.measurer, path, "pptx", &json!({}))
    }

    async fn snapshot_pdf_pages(&self, path: &Path) -> Result<Vec<Value>, String> {
        let cx = &self.inspect.snapshot;
        let options = SnapshotOptions::from_json(&json!({ "maxChars": 100_000, "outline": false }));
        let read = snapshot_pdf(cx.proof, path, &options, cx.forms).map_err(|error| error.message)?;
        Ok(read.get("pages").and_then(Value::as_array).cloned().unwrap_or_default())
    }

    async fn run_pptx_script(&self, _script: &str, _output: &Path, _cwd: &Path) -> Result<Value, String> {
        Err("A pptxgenjs script cannot run: the script runtime is not part of this build. Author the deck as HTML slides (a source that opens with <) instead.".to_owned())
    }

    async fn run_pptx_html(&self, html: &str, output: &Path, target: &Path, signal: Option<&CancellationToken>, frame: bool) -> Result<Value, RunError> {
        let mut options = RunOptions::new(target);
        options.cancel = signal.cloned().unwrap_or_default();
        if frame {
            // A PDF's designed pages: the sheet the document declared is the canvas.
            let prepare: Prepare<'_> = Box::new(|page| Box::pin(frame_canvas(page)));
            options.prepare = Some(prepare);
        }
        run_pptx_html_authoring(self.endpoint, self.lanes, self.svg_fonts, self.note.as_ref(), html, output, options).await
    }

    async fn run_docx_html(&self, html: &str, output: &Path, target: &Path, signal: Option<&CancellationToken>) -> Result<Value, RunError> {
        let mut options = DocxRunOptions::new(target);
        options.cancel = signal.cloned().unwrap_or_default();
        run_docx_html_authoring(self.endpoint, self.lanes, Arc::clone(&self.fonts), Arc::clone(&self.note), html, output, options).await
    }

    async fn run_xlsx_html(&self, html: &str, output: &Path, target: &Path, signal: Option<&CancellationToken>) -> Result<Value, RunError> {
        let mut options = XlsxRunOptions::new(target);
        options.cancel = signal.cloned().unwrap_or_default();
        run_xlsx_html_authoring(self.endpoint, self.lanes, Arc::clone(&self.fonts), Arc::clone(&self.note), html, output, options).await
    }

    async fn print_pdf(&self, html: &str, output: &Path, source_path: &Path, properties: &Value, frame: bool, signal: Option<&CancellationToken>) -> Result<Value, RunError> {
        let mut options = PrintOptions::new(source_path);
        options.properties = document_properties(properties);
        options.frame = frame;
        options.cancel = signal.cloned().unwrap_or_default();
        print_html_pdf(self.endpoint, self.lanes, html, output, options).await
    }

    async fn inline_audit(&self, handle: &SessionHandle, exclude: &[String]) -> Option<Value> {
        inline_office_audit(self.inspect, handle, &[], exclude).await
    }

    async fn render(&self, handle: &SessionHandle, args: &Value, cwd: &Path) -> Result<Value, String> {
        let (authored, id) = {
            let session = lock(handle);
            (session.authored.authored && !session.authored.frame, session.id.clone())
        };
        let receipt = if authored { self.read_composition_receipt(handle).await } else { None };
        let receipts = SessionReceipts { receipt, deliveries: &self.deliveries, id };
        render(self.render, self.inspect.snapshot.proof, handle, args, cwd, &receipts).await
    }

    async fn read_composition_receipt(&self, handle: &SessionHandle) -> Option<Value> {
        let options = json!({ "includeStyles": true, "limit": 100, "maxChars": 100_000 });
        let current = snapshot(&self.inspect.snapshot, handle, &options, true).await.ok()?;
        let brief = lock(handle).authored.brief.clone();
        Some(composition_receipt(current.get("document").unwrap_or(&Value::Null), brief.as_ref()))
    }

    fn receipt_for_delivery(&self, handle: &SessionHandle, receipt: &Value) -> Value {
        deliver(&self.deliveries, &lock(handle).id, receipt)
    }

    async fn write_html_comparisons(&self, target: &Path, html_shots: &Value, rendered_images: &[Value]) -> Result<Vec<Value>, String> {
        write_html_comparisons(self.lanes, self.note.as_ref(), target, html_shots, rendered_images).await
    }

    async fn measure_html_drift(&self, html_shots: &Value, html_text: &Value, rendered_images: &[Value]) -> Result<Value, String> {
        measure_html_drift(self.lanes, html_shots, html_text, rendered_images, HTML_DRIFT_PX).await
    }

    async fn read_bytes(&self, path: &Path) -> Result<Vec<u8>, String> {
        let path = path.to_path_buf();
        lane_job(self.lanes.interactive_io, move |lane| mixdog_fsio::read(lane, &path).map_err(|error| format!("{}: {error}", path.display()))).await?
    }

    async fn write_bytes(&self, path: &Path, bytes: Vec<u8>) -> Result<(), String> {
        let path = path.to_path_buf();
        lane_job(self.lanes.durability_io, move |lane| mixdog_fsio::write(lane, &path, bytes).map_err(|error| format!("{}: {error}", path.display()))).await?
    }

    async fn compose_comparison(&self, left: Option<Vec<u8>>, right: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
        AuthorLanes::new(self.lanes).compute(move || comparison_sheet(left.as_deref(), right.as_deref())).await?
    }
}
