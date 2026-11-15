//! The `author` action of the office engine: a document written from a source the model sends, landed over its target once
//! the checks hold, opened as a session and read back for review (`authoring/pptx-author-action.mjs`,
//! `pdf-author-action.mjs`, `html-document-author.mjs`, `pptx-author-session.mjs`).
//!
//! - [`pptx`]: a `.pptx` target. The source is HTML (it opens with markup) or a pptxgenjs script; with neither, the deck is
//!   authored again from `<deck>.pptx.mixdog-source.html`. The deck is staged beside the target, the geometry, facts and plan
//!   gates read it, and only then does it land (a reusable hidden PowerPoint session swaps its document in place).
//! - [`pdf`]: a `.pdf` target from an HTML document printed by the shared browser; designed pages (one `section.slide` per
//!   sheet) go through the deck's frame first.
//! - [`html_document`]: a `.docx` or `.xlsx` target from an HTML document.
//! - [`pptx_session`]: the staging folder, the landing, the swap and the release of the session that held the target.
//!
//! What touches the machine (the files, the sessions, the browser runners, the audit, the render) is an [`AuthorHost`];
//! [`SystemAuthor`] is the one a process uses and a test supplies its own. The futures are driven by the caller and are not
//! required to be `Send`, as the render engine's are not.

pub mod html_document;
pub mod pdf;
pub mod pptx;
pub mod pptx_session;
mod system;

use std::future::Future;
use std::path::Path;

use mixdog_js::{js_to_lowercase, js_trim, value_to_string};
use mixdog_office_author::html_browser::RunError;
use mixdog_office_author::source_drift::{HtmlSource, edits_replaced_by_author};
use mixdog_office_base::values::truthy;
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value};

pub use self::pptx_session::AuthorError;
pub use self::system::SystemAuthor;
use crate::session::SessionHandle;
use crate::session::registry::lock;

/// What one call of the action carries beside its arguments: the folder relative paths are taken against and the call's
/// cancellation (`{ cwd, dataDir, signal }`; the data directory is the host's).
#[derive(Clone, Copy, Debug, Default)]
pub struct AuthorCall<'a> {
    pub cwd: &'a str,
    pub signal: Option<&'a CancellationToken>,
}

/// What staging, landing and the release of a session need: the files of the call and the registry's sessions.
pub trait StageHost {
    /// The file exists.
    fn exists(&self, path: &Path) -> impl Future<Output = bool>;
    fn read_text(&self, path: &Path) -> impl Future<Output = Result<String, String>>;
    /// `mkdir(parent, { recursive: true })` then `mkdtemp(join(parent, prefix))`: a new empty folder of the call's own.
    fn make_directory(&self, parent: &Path, prefix: &str) -> impl Future<Output = Result<std::path::PathBuf, String>>;
    fn copy_file(&self, from: &Path, to: &Path) -> impl Future<Output = Result<(), String>>;
    /// `rm(path, { force: true })`: a file that cannot be removed is left.
    fn remove_file(&self, path: &Path) -> impl Future<Output = ()>;
    /// `rm(path, { recursive: true, force: true })`: a folder that cannot be removed is left.
    fn remove_dir_all(&self, path: &Path) -> impl Future<Output = ()>;

    /// `officeSessionForDocument(target)`.
    fn session_for_document(&self, target: &str) -> Option<SessionHandle>;
    /// `releaseOfficeSession(session)`.
    fn release_session(&self, handle: &SessionHandle);
    /// `closeSession(session, { save: false, signal })`: the Microsoft Office document closed without saving.
    fn close_session(&self, handle: &SessionHandle, signal: Option<&CancellationToken>) -> impl Future<Output = Result<(), String>>;
}

/// What the author action needs of the machine and of the rest of the engine.
pub trait AuthorHost: StageHost {
    /// The call's write ledger (`noteOfficeWrite`): told of a file before it is written.
    fn note_write(&self, path: &Path);
    /// `new Date().toISOString()` of the host's clock.
    fn now_iso(&self) -> String;

    /// `callMicrosoftOffice(request, { signal })`: the host's answer as JSON, its failures in the same shape.
    fn office_call(&self, request: &Value, signal: Option<&CancellationToken>) -> impl Future<Output = Value>;
    /// `createAuthoredSession(args, cwd, dataDir, target)`.
    fn create_authored_session(&self, args: &Value, target: &str, signal: Option<&CancellationToken>) -> impl Future<Output = Result<SessionHandle, String>>;
    /// `registerHtmlPdfSession(args, dataDir, target, { targetExisted, receipt })`.
    fn register_html_pdf_session(&self, args: &Value, target: &str, target_existed: bool, receipt: Value) -> Result<SessionHandle, String>;
    /// `releaseOverwrittenSession(target, true)`.
    fn release_overwritten_session(&self, target: &str) -> impl Future<Output = Result<(), String>>;

    /// `snapshotPortableOoxml(path, 'pptx', {})`: the staged deck read with the portable reader whatever backend holds it.
    fn snapshot_deck(&self, path: &Path) -> impl Future<Output = Result<Value, String>>;
    /// `snapshotPdf(path, { maxChars: 100000, outline: false }).pages`: `{ index, text }` of each page.
    fn snapshot_pdf_pages(&self, path: &Path) -> impl Future<Output = Result<Vec<Value>, String>>;

    /// `runPptxAuthoringScript(script, output, { cwd })`: a pptxgenjs script run to `output`. Answers the run as Node's
    /// object (`ok`, `output`, `bytes`, `logs`, `kit`, `elapsedMs`, or `ok: false` with `error`, `logs`, `elapsedMs`); an
    /// `Err` says the script runtime is not available.
    fn run_pptx_script(&self, script: &str, output: &Path, cwd: &Path) -> impl Future<Output = Result<Value, String>>;
    /// `runPptxHtmlAuthoring(html, output, { target, signal, prepare })`; `frame` is a PDF's designed pages (the sheet is the
    /// canvas).
    fn run_pptx_html(&self, html: &str, output: &Path, target: &Path, signal: Option<&CancellationToken>, frame: bool) -> impl Future<Output = Result<Value, RunError>>;
    fn run_docx_html(&self, html: &str, output: &Path, target: &Path, signal: Option<&CancellationToken>) -> impl Future<Output = Result<Value, RunError>>;
    fn run_xlsx_html(&self, html: &str, output: &Path, target: &Path, signal: Option<&CancellationToken>) -> impl Future<Output = Result<Value, RunError>>;
    /// `printHtmlPdf(html, output, { sourcePath, properties, frame, signal })`.
    fn print_pdf(&self, html: &str, output: &Path, source_path: &Path, properties: &Value, frame: bool, signal: Option<&CancellationToken>) -> impl Future<Output = Result<Value, RunError>>;

    /// `inlineOfficeAudit(session, { exclude })`: `None` for a format with no package to measure.
    fn inline_audit(&self, handle: &SessionHandle, exclude: &[String]) -> impl Future<Output = Option<Value>>;
    /// `render(session, args, cwd)`.
    fn render(&self, handle: &SessionHandle, args: &Value, cwd: &Path) -> impl Future<Output = Result<Value, String>>;
    /// `readCompositionReceipt(session)`: `None` when the deck cannot be read.
    fn read_composition_receipt(&self, handle: &SessionHandle) -> impl Future<Output = Option<Value>>;
    /// `receiptForDelivery(receipt, session)`: the receipt as the result carries it, the session's memory of what it last sent
    /// updated.
    fn receipt_for_delivery(&self, handle: &SessionHandle, receipt: &Value) -> Value;
    /// `writeHtmlComparisons(target, htmlShots, renderedImages)`.
    fn write_html_comparisons(&self, target: &Path, html_shots: &Value, rendered_images: &[Value]) -> impl Future<Output = Result<Vec<Value>, String>>;
    /// `measureHtmlDrift(htmlShots, htmlText, renderedImages)`.
    fn measure_html_drift(&self, html_shots: &Value, html_text: &Value, rendered_images: &[Value]) -> impl Future<Output = Result<Value, String>>;
    /// The bytes of a file (a page image).
    fn read_bytes(&self, path: &Path) -> impl Future<Output = Result<Vec<u8>, String>>;
    fn write_bytes(&self, path: &Path, bytes: Vec<u8>) -> impl Future<Output = Result<(), String>>;
    /// The comparison image of one page of a Word or Excel document: the browser's picture on the left, the Office render on
    /// the right ([`html_document::comparison_sheet`], on the compute lane).
    fn compose_comparison(&self, left: Option<Vec<u8>>, right: Option<Vec<u8>>) -> impl Future<Output = Result<Vec<u8>, String>>;
}

/// `String(value || '')`.
pub(crate) fn text_of(value: Option<&Value>) -> String {
    value.filter(|value| truthy(value)).map(value_to_string).unwrap_or_default()
}

/// `String(args.path || args.output || '').trim()`.
pub(crate) fn requested_path(args: &Value) -> String {
    let path = text_of(args.get("path"));
    let chosen = if path.is_empty() { text_of(args.get("output")) } else { path };
    js_trim(&chosen).to_owned()
}

/// `String(args.script || '').trim()`.
pub(crate) fn script_of(args: &Value) -> String {
    js_trim(&text_of(args.get("script"))).to_owned()
}

/// The script the call sent, untrimmed (`String(args.script)`).
pub(crate) fn script_source(args: &Value) -> String {
    text_of(args.get("script"))
}

/// A flag the call names `false` / `true` (`args.audit === false`).
pub(crate) fn flag_is(args: &Value, name: &str, expected: bool) -> bool {
    args.get(name) == Some(&Value::Bool(expected))
}

/// The keys of `source` that are present, in the order given (`{ a: x.a, b: x.b }` with `undefined` left out by the JSON).
pub(crate) fn pick(source: &Value, keys: &[&str]) -> Map<String, Value> {
    let mut picked = Map::new();
    for key in keys {
        if let Some(value) = source.get(*key) {
            picked.insert((*key).to_owned(), value.clone());
        }
    }
    picked
}

/// The arguments a render is given from the call: `{ pages, maxWidth }`.
pub(crate) fn render_args(args: &Value) -> Value {
    Value::Object(pick(args, &["pages", "maxWidth"]))
}

/// HTML opens with markup (a doctype, a comment, an element); a pptxgenjs script never does (`/^\s*</`).
pub(crate) fn opens_with_markup(source: &str) -> bool {
    source.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}').starts_with('<')
}

/// `markAuthoredFromHtml(session, sourcePath)`: the session records the HTML its file was just built from and counts edits
/// from here.
pub(crate) fn mark_authored_from_html(handle: &SessionHandle, source_path: &str) {
    let mut session = lock(handle);
    let mut source = HtmlSource { source: session.authored.html_source.clone(), edits: session.authored.html_source_edits as f64 };
    source.mark_authored_from_html(source_path);
    session.authored.html_source = source.source;
    session.authored.html_source_edits = 0;
}

/// `editsReplacedByAuthor(session)`: what the previous session had edited past its HTML.
pub(crate) fn replaced_edits_of(held: Option<&SessionHandle>) -> Option<Value> {
    let source = held.map(|handle| {
        let session = lock(handle);
        HtmlSource { source: session.authored.html_source.clone(), edits: session.authored.html_source_edits as f64 }
    });
    edits_replaced_by_author(source.as_ref())
}

/// Which route a target takes (`authorAction`): by its extension, a PDF, a Word or Excel document from HTML, and anything else
/// a deck.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Pptx,
    Pdf,
    HtmlDocument,
}

impl Route {
    pub fn of(args: &Value) -> Self {
        let path = text_of(args.get("path"));
        let named = if path.is_empty() { text_of(args.get("output")) } else { path };
        let extension = match named.rfind('.') {
            Some(dot) if dot > named.rfind(['/', '\\']).map_or(0, |slash| slash + 1) => js_to_lowercase(&named[dot..]),
            _ => String::new(),
        };
        match extension.as_str() {
            ".pdf" => Self::Pdf,
            ".docx" | ".xlsx" => Self::HtmlDocument,
            _ => Self::Pptx,
        }
    }
}

/// The `author` action (`authorAction` of `core/office-sessionless-actions.mjs`): the write receipts of the document and the
/// sidecars kept beside it, then the route its extension names. Answers Node's result object; its `_images` are what the tool
/// layer attaches to the answer.
pub async fn author<H: AuthorHost>(host: &H, args: &Value, call: &AuthorCall<'_>) -> Result<Value, AuthorError> {
    let route = Route::of(args);
    // The authored document and the sidecars kept beside it; per-page images report themselves.
    for name in ["path", "output"] {
        let value = text_of(args.get(name));
        if js_trim(&value).is_empty() {
            continue;
        }
        let target = crate::session::working_copy::full_path(js_trim(&value), call.cwd)?;
        for path in [target.clone(), format!("{target}.mixdog-source.html"), format!("{target}.mixdog-html.pdf")] {
            host.note_write(Path::new(&path));
        }
    }
    match route {
        Route::Pdf => pdf::author_pdf(host, args, call).await,
        Route::HtmlDocument => html_document::author_html_document(host, args, call).await,
        Route::Pptx => pptx::author_pptx(host, args, call).await,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_extension_names_the_route() {
        assert_eq!(Route::of(&json!({ "path": "a/report.PDF" })), Route::Pdf);
        assert_eq!(Route::of(&json!({ "output": "report.docx" })), Route::HtmlDocument);
        assert_eq!(Route::of(&json!({ "path": "report.xlsx" })), Route::HtmlDocument);
        assert_eq!(Route::of(&json!({ "path": "deck.pptx" })), Route::Pptx);
        assert_eq!(Route::of(&json!({ "path": "dir.pdf/deck" })), Route::Pptx);
        assert_eq!(Route::of(&json!({})), Route::Pptx);
    }

    #[test]
    fn html_opens_with_markup_and_a_script_never_does() {
        assert!(opens_with_markup("  \n<!doctype html>"));
        assert!(opens_with_markup("<!-- BRIEF -->"));
        assert!(!opens_with_markup("const pptxgen = require('pptxgenjs');"));
        assert!(!opens_with_markup(""));
    }

    #[test]
    fn the_requested_path_is_the_path_then_the_output() {
        assert_eq!(requested_path(&json!({ "path": " a.pptx ", "output": "b.pptx" })), "a.pptx");
        assert_eq!(requested_path(&json!({ "output": "b.pptx" })), "b.pptx");
        assert_eq!(requested_path(&json!({ "path": "  " })), "");
        assert_eq!(script_of(&json!({ "script": "  <p>  " })), "<p>");
    }
}
