//! The engine of the Office tool: the entry point a process (the extension host's worker, the skill scripts that read documents)
//! calls with the arguments of one call (`executeOfficeTool` of `src/runtime/office/index.mjs`).
//!
//! [`Engine::execute`] answers the tool result of the call and the workspace files its write routes changed (`CallLedger`'s changes,
//! which the caller records in the turn review as the call's own). Sessions live in the engine as they lived in the worker process:
//! [`Engine::known_sessions`] and [`Engine::finish_call`] are the pin rule (a thread whose calls left a live session keeps its
//! worker), and [`Engine::shutdown`] drains every Microsoft Office session host when the process ends.
//!
//! What a process supplies (the lanes, the Office transport, the fonts, the shared browser, the design library's network and
//! template index, the schema validator and the batch's machine) is a [`Platform`]. A call runs as one job on the maintenance lane:
//! the lane proof the document code needs only exists inside a job, so the call's future is driven there, on a parker of its own
//! (the Office transport and the lanes wake it), and no nested runtime is started on that thread.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll, Wake, Waker};
use std::time::Instant;

use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_fonts::registry::Registry as FontRegistry;
use mixdog_fsio::OpenOptions;
use mixdog_js::value_to_string;
use mixdog_office_author::brief::{is_showcase_brief, review_brief_promises, review_fact_coverage, review_source_grounding};
use mixdog_office_author::receipt::{DeliveredReceipt, WIDE_CANVAS, slide_receipt};
use mixdog_office_base::data_dir::default_office_data_dir;
use mixdog_office_base::envelope::tool_result;
use mixdog_office_base::ledger::{CallLedger, FileChange};
use mixdog_office_base::values::truthy;
use mixdog_office_base::write_note::{NoWriteNote, WriteNote};
use mixdog_office_com::OfficeCom;
use mixdog_office_design::library::{Environment as DesignEnvironment, Fetch, TemplateIndexer};
use mixdog_office_pdf::batch::PdfFormView;
use mixdog_office_quality::design_review::AuthorReads;
use mixdog_ooxml::ooxml_validator::Environment as ValidatorEnvironment;
use mixdog_ooxml::soffice::Soffice;
use mixdog_ooxml::text_metrics::TextMeasurer;
use mixdog_pdf::embed::FontEnv;
use mixdog_raster::svg::SvgFonts;
use mixdog_rt::{CancellationToken, InLane, LaneToken, LaneTokens, MaintenanceIo};
use serde_json::{Value, json};

use crate::actions::{Host, Machine};
use crate::author::SystemAuthor;
use crate::batch::{BatchContext, BatchHost};
use crate::inspect::{InspectContext, ReviewSnapshots};
use crate::render::SystemRender;
use crate::session::create::CreateTools;
use crate::session::open::{SessionCloser, SessionEnv, SofficeConverter};
use crate::session::registry::{Registry, ThreadPins, lock};
use crate::session::SessionHandle;
use crate::snapshot::SnapshotContext;

/// What a process supplies to the engine.
pub trait Platform: Send + Sync + 'static {
    /// The machine of a batch: the PDF operation set, the Word chart as a picture and the brief readings.
    type Batch: BatchHost + Send + Sync;

    fn lanes(&self) -> LaneTokens;
    /// The Microsoft Office transport (its session hosts are this process's).
    fn office(&self) -> &OfficeCom;
    /// The faces text is measured and drawn in.
    fn fonts(&self) -> Arc<FontRegistry>;
    /// Where the PDF writer looks for a Unicode font.
    fn font_env(&self) -> &FontEnv;
    /// The faces an SVG drawing's text is set in.
    fn svg_fonts(&self) -> &SvgFonts;
    /// The shared render browser.
    fn endpoint(&self) -> &dyn BrowserEndpoint;
    /// The environment the design library reads (the folders, the clock).
    fn design_environment(&self) -> &DesignEnvironment;
    fn fetch(&self) -> &dyn Fetch;
    fn indexer(&self) -> &dyn TemplateIndexer<MaintenanceIo>;
    /// The environment the OOXML schema validator is looked up in.
    fn validator(&self) -> &ValidatorEnvironment;
    fn batch_host(&self) -> &Self::Batch;
}

/// What a deck's design review reads of the authoring side: the authoring crate's own readings.
pub struct AuthoringReads;

impl AuthorReads for AuthoringReads {
    fn slide_receipt(&self, slide: &Value) -> Value {
        slide_receipt(slide, WIDE_CANVAS)
    }

    fn is_showcase_brief(&self, brief: &Value) -> bool {
        is_showcase_brief(brief)
    }

    fn review_brief_promises(&self, document: &Value, brief: &Value) -> Vec<Value> {
        review_brief_promises(document, brief)
    }

    fn review_fact_coverage(&self, document: &Value, brief: &Value) -> Vec<Value> {
        review_fact_coverage(document, brief)
    }

    fn review_source_grounding(&self, brief: &Value) -> Vec<Value> {
        review_source_grounding(brief)
    }
}

/// The finalize stage's `closeSession(session, { save: false })` for the code that creates and authors: the session's Office document
/// closed, the session released and forgotten.
pub struct Closer<'a, H> {
    pub host: &'a H,
    pub registry: &'a Registry,
    pub env: &'a DesignEnvironment,
    pub reviews: &'a ReviewSnapshots,
}

impl<H: Host> SessionCloser for Closer<'_, H> {
    async fn close(&self, handle: &SessionHandle) -> Result<(), String> {
        let (id, signal) = {
            let session = lock(handle);
            (session.id.clone(), session.active_signal.clone())
        };
        crate::actions::finalize::session_save::close_session(self.host, self.registry, self.env, handle, false, signal.as_ref()).await?;
        self.reviews.forget(&id);
        Ok(())
    }
}

/// Wakes the thread that drives a call.
struct Parker(std::thread::Thread);

impl Wake for Parker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}

/// Drives `future` on this thread until it is done.
fn drive<F: Future>(future: F) -> F::Output {
    let mut future = pin!(future);
    let waker = Waker::from(Arc::new(Parker(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::park(),
        }
    }
}

/// `MIXDOG_OFFICE_TRACE`: one line per call (`<action>\t<ms>\t<path or session>`) so a slow run maps itself. `1` writes to stderr, any
/// other value names a file.
fn trace(lane: &InLane<MaintenanceIo>, args: &Value, started: Instant) {
    let Ok(target) = std::env::var("MIXDOG_OFFICE_TRACE") else { return };
    if target.is_empty() {
        return;
    }
    let text = |key: &str| args.get(key).filter(|value| truthy(value)).map(value_to_string);
    let line = format!("{}\t{}\t{}\n", text("action").unwrap_or_else(|| "?".to_owned()), (started.elapsed().as_secs_f64() * 1000.0).round(), text("path").or_else(|| text("session")).unwrap_or_default());
    if target == "1" {
        eprint!("[office-trace] {line}");
        return;
    }
    if let Ok(mut file) = OpenOptions::new().append(true).create(true).open(lane, &target) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// The engine of a process.
pub struct Engine<P: Platform> {
    platform: P,
    registry: Registry,
    reviews: ReviewSnapshots,
    /// What each session was last sent of its render receipt.
    deliveries: Mutex<HashMap<String, DeliveredReceipt>>,
    pins: Mutex<ThreadPins>,
}

impl<P: Platform> Engine<P> {
    pub fn new(platform: P) -> Arc<Self> {
        Arc::new(Self { platform, registry: Registry::new(), reviews: ReviewSnapshots::new(), deliveries: Mutex::default(), pins: Mutex::default() })
    }

    /// The ids of the open sessions before a call starts.
    pub fn known_sessions(&self) -> HashSet<String> {
        ThreadPins::known(&self.registry)
    }

    /// What a call leaves behind: the sessions it created join its thread's, the closed ones leave. Answers whether the thread is
    /// pinned now (its worker must stay alive between calls).
    pub fn finish_call(&self, thread: &str, known: &HashSet<String>) -> bool {
        self.pins.lock().unwrap_or_else(PoisonError::into_inner).finish_call(thread, known, &self.registry)
    }

    /// Whether a thread owns a live session.
    pub fn is_pinned(&self, thread: &str) -> bool {
        self.pins.lock().unwrap_or_else(PoisonError::into_inner).is_pinned(thread)
    }

    /// `closeOfficeSessions`: every session host of the Office transport gets its cleanup, and this returns once each has gone or
    /// its grace lapsed.
    pub async fn shutdown(&self) {
        self.platform.office().shutdown().await;
    }

    /// `executeOfficeTool(args, { cwd, dataDir, sessionId, signal })`: the tool result of one call, and the files its write routes
    /// changed. `ledger` is the call's write ledger when it belongs to a session's turn (its changes are returned for the turn
    /// review); without one nothing is recorded. An empty `cwd` is the process's folder, no `data_dir` the Office data folder.
    pub async fn execute(self: &Arc<Self>, args: Value, cwd: PathBuf, data_dir: Option<PathBuf>, ledger: Option<Arc<CallLedger>>, cancel: CancellationToken) -> (Value, Vec<FileChange>) {
        let failed = |message: String| (tool_result(&Value::String(format!("Error: {message}")), true, &[]), Vec::new());
        let cwd = if cwd.as_os_str().is_empty() {
            match std::env::current_dir() {
                Ok(folder) => folder,
                Err(error) => return failed(error.to_string()),
            }
        } else {
            cwd
        };
        let data_dir = match data_dir.filter(|folder| !folder.as_os_str().is_empty()) {
            Some(folder) => folder,
            None => match default_office_data_dir() {
                Ok(folder) => folder,
                Err(error) => return failed(error.to_string()),
            },
        };
        let (engine, runtime) = (Arc::clone(self), tokio::runtime::Handle::current());
        let (call_cancel, call_ledger) = (cancel.clone(), ledger.clone());
        let job = move |lane: &InLane<MaintenanceIo>| {
            let _entered = runtime.enter();
            let note: Arc<dyn WriteNote> = match call_ledger.clone() {
                Some(ledger) => ledger,
                None => Arc::new(NoWriteNote),
            };
            let result = engine.run_call(lane, &args, &cwd.to_string_lossy(), &data_dir, &note, &call_cancel, &runtime);
            let changes = call_ledger.map(|ledger| ledger.changes(lane)).unwrap_or_default();
            (result, changes)
        };
        let submitted = self.platform.lanes().maintenance_io.submit_wait(&cancel, job).await;
        match submitted {
            Ok(handle) => match handle.await {
                Ok(done) => done,
                Err(error) => failed(error.to_string()),
            },
            Err(_) if cancel.is_cancelled() => (
                tool_result(&json!({ "ok": false, "code": "cancelled", "message": "Office Use operation was cancelled", "detail": "Office Use operation was cancelled" }), true, &[]),
                Vec::new(),
            ),
            Err(error) => failed(error.to_string()),
        }
    }

    /// One call, on the lane thread: the contexts of the call built from the platform and the engine's sessions, and the call run.
    #[allow(clippy::too_many_arguments)]
    fn run_call(&self, lane: &InLane<MaintenanceIo>, args: &Value, cwd: &str, data_dir: &Path, note: &Arc<dyn WriteNote>, cancel: &CancellationToken, runtime: &tokio::runtime::Handle) -> Value {
        let started = Instant::now();
        let platform = &self.platform;
        let lanes = platform.lanes();
        let office = platform.office();
        let fonts = platform.fonts();
        let measurer = TextMeasurer::new(lane, &fonts);
        // The blocking engines (LibreOffice, the schema validator) read a flag; it rises with the call's cancellation.
        let abort = Arc::new(AtomicBool::new(cancel.is_cancelled()));
        let watcher = {
            let (flag, token) = (Arc::clone(&abort), cancel.clone());
            runtime.spawn(async move {
                token.cancelled().await;
                flag.store(true, Ordering::SeqCst);
            })
        };
        let inspect = InspectContext {
            snapshot: SnapshotContext { proof: lane, measurer: &measurer, forms: &PdfFormView, com: office },
            soffice: Soffice::process(),
            validator: platform.validator(),
            reviews: &self.reviews,
            abort: Some(Arc::clone(&abort)),
        };
        let design = mixdog_office_design::library::Context { lane, env: platform.design_environment(), fetch: platform.fetch(), indexer: platform.indexer() };
        let legacy = SofficeConverter { soffice: Soffice::process(), proof: lane, cancel: Some(&*abort) };
        let env = SessionEnv { design: &design, note: note.as_ref(), registry: &self.registry, host: office, legacy: &legacy, data_dir, cwd, cancel: None };
        let closer = Closer { host: office, registry: &self.registry, env: platform.design_environment(), reviews: &self.reviews };
        let render = SystemRender::new(lanes, office.clone(), Arc::clone(&fonts), Arc::clone(note));
        let held = std::mem::take(&mut *self.deliveries.lock().unwrap_or_else(PoisonError::into_inner));
        let author = SystemAuthor {
            env,
            inspect: &inspect,
            render: &render,
            closer: &closer,
            endpoint: platform.endpoint(),
            lanes,
            fonts: Arc::clone(&fonts),
            svg_fonts: platform.svg_fonts(),
            note: Arc::clone(note),
            deliveries: Mutex::new(held),
        };
        let batch = BatchContext { inspect: &inspect, note: note.as_ref(), registry: &self.registry, env: platform.design_environment(), host: platform.batch_host() };
        let tools = CreateTools { closer: &closer, fonts: platform.font_env(), svg_fonts: platform.svg_fonts() };
        let machine = Machine { author: &author, batch: &batch, tools: &tools, reads: &AuthoringReads };
        let result = drive(machine.run_office_tool(args, Some(cancel)));
        let remembered = std::mem::take(&mut *author.deliveries.lock().unwrap_or_else(PoisonError::into_inner));
        self.deliveries.lock().unwrap_or_else(PoisonError::into_inner).extend(remembered);
        watcher.abort();
        trace(lane, args, started);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pending once, after waking its own task.
    struct Yield(bool);

    impl Future for Yield {
        type Output = u32;

        fn poll(mut self: std::pin::Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<u32> {
            if self.0 {
                return Poll::Ready(7);
            }
            self.0 = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }

    #[test]
    fn a_call_waits_for_the_wake_of_what_it_awaits() {
        assert_eq!(drive(Yield(false)), 7);
        assert_eq!(drive(async { Yield(false).await + 1 }), 8);
    }
}
