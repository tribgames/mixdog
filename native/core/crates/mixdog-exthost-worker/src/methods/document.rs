//! The `document.*` methods (`src/ext-host/document.mjs`): previews of Office documents as PDF and as page images, and the
//! LibreOffice dependency (the latter in [`super::soffice`]).
//!
//! This is the handler layer: the project-entry path rules, the checks of a request's pages, width and password, the roots
//! the core approved for the call, and the pin of a thread that unlocked a document. The conversion of a document to a PDF and
//! the rasterising of its pages are a [`DocumentEngine`]; the build that links the office PDF backend registers it with
//! [`register_with`]; the worker registers [`super::document_engine::OfficeEngine`], the office PDF backend. A PDF previews in
//! place without the engine, and every refusal below is the same with any engine.
//!
//! Failures carry a stable `code` (the core maps it to the domain's coded error); the message stays the one Node showed.

use std::collections::HashSet;
use std::io;
use std::path::{MAIN_SEPARATOR, Path, PathBuf};
#[cfg(test)]
use std::sync::Once;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use mixdog_fsio::Unlaned;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::js_string;
use super::soffice::Soffice;
use crate::ctx::CallCtx;
use crate::error::CodedError;
use crate::pathguard;
use crate::registry::{BoxFuture, HandlerResult, Outcome, Registry};

/// A viewer asks for the pages it is about to show. The ceiling keeps one call bounded in time (each page is a rasterization)
/// and in payload, because a remote surface carries these images inside a single reply.
pub const MAX_PAGES_PER_CALL: usize = 4;
const MIN_PAGE_WIDTH: f64 = 320.0;
/// Wide enough for a 400% zoom on a high-DPI panel to stay crisp.
const MAX_PAGE_WIDTH: f64 = 2400.0;
const DEFAULT_PAGE_WIDTH: f64 = 1200.0;
/// An Office password is at most 255 characters ([MS-OFFCRYPTO] 2.3.4).
const MAX_PASSWORD_LENGTH: usize = 255;

/// The extensions a document converts from (`PREVIEW_FORMATS` of `document-preview.mjs`).
const PREVIEW_FORMATS: [&str; 14] = [
    "docx", "doc", "docm", "dotx", "rtf", "odt", "xlsx", "xls", "xlsm", "ods", "pptx", "ppt", "pptm", "odp",
];

/// The PDF a document previews as: the file, and the revision of the document it was made from.
#[derive(Clone, Debug, PartialEq)]
pub struct PdfPreview {
    pub path: String,
    pub format: String,
    pub mtime_ms: f64,
    pub size: u64,
    pub cached: bool,
}

/// One rasterised page.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderedPage {
    pub page: u64,
    pub width: u64,
    pub height: u64,
    pub mime: String,
    pub base64: String,
}

/// The pages a render produced and the page count of the PDF.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderedPages {
    pub page_count: u64,
    pub pages: Vec<RenderedPage>,
}

/// A conversion to PDF: `file` has a convertible extension and is inside the project. `password` is for this request only.
pub struct PreviewRequest {
    pub file: PathBuf,
    pub cache_root: String,
    pub password: Option<String>,
    pub cancel: CancellationToken,
}

/// A rasterising of `pages` (sorted, distinct, at most [`MAX_PAGES_PER_CALL`]) at `max_width` (320 to 2400).
pub struct PagesRequest {
    pub pdf: String,
    pub pages: Vec<u64>,
    pub max_width: u32,
    pub cache_root: String,
    pub cancel: CancellationToken,
}

/// What converts a document to PDF and rasterises PDF pages (`documentPreviewPdf`, `documentPreviewPages`).
pub trait DocumentEngine: Send + Sync {
    fn preview_pdf(&self, request: PreviewRequest) -> BoxFuture<Result<PdfPreview, CodedError>>;
    fn preview_pages(&self, request: PagesRequest) -> BoxFuture<Result<RenderedPages, CodedError>>;
    /// Brings the fonts LibreOffice renders with in; never fails the install that asks.
    fn prepare_fonts(&self) -> BoxFuture<()>;
}

/// An engine that links nothing: every call that needs one answers `OFFICE_PREVIEW_UNAVAILABLE` (the handler layer's tests).
#[cfg(test)]
struct MissingEngine;

#[cfg(test)]
impl MissingEngine {
    const REASON: &'static str = "document preview is off: the office PDF backend is not linked into this worker";

    fn unavailable() -> CodedError {
        static LOGGED: Once = Once::new();
        LOGGED.call_once(|| eprintln!("ext-host: error: {}", Self::REASON));
        CodedError::new("OFFICE_PREVIEW_UNAVAILABLE", Self::REASON)
    }
}

#[cfg(test)]
impl DocumentEngine for MissingEngine {
    fn preview_pdf(&self, _: PreviewRequest) -> BoxFuture<Result<PdfPreview, CodedError>> {
        Box::pin(async { Err(Self::unavailable()) })
    }

    fn preview_pages(&self, _: PagesRequest) -> BoxFuture<Result<RenderedPages, CodedError>> {
        Box::pin(async { Err(Self::unavailable()) })
    }

    fn prepare_fonts(&self) -> BoxFuture<()> {
        Box::pin(async {
            let _ = Self::unavailable();
        })
    }
}

pub(super) fn register(registry: &mut Registry) {
    register_with(registry, Arc::new(super::document_engine::OfficeEngine::new()));
    super::document_engine::register_exit(registry);
}

/// Serves the four `document.*` methods over `engine` (replacing the ones already registered).
pub fn register_with(registry: &mut Registry, engine: Arc<dyn DocumentEngine>) {
    register_over(registry, engine, Arc::new(Soffice::for_platform()));
}

fn register_over(registry: &mut Registry, engine: Arc<dyn DocumentEngine>, soffice: Arc<Soffice>) {
    let methods = Arc::new(Methods { engine, soffice, unlocked: Mutex::new(HashSet::new()) });
    let preview = methods.clone();
    registry.register("document.preview", move |ctx| {
        let methods = preview.clone();
        async move { methods.preview(ctx).await }
    });
    let pages = methods.clone();
    registry.register("document.previewPages", move |ctx| {
        let methods = pages.clone();
        async move { methods.preview_pages(ctx).await }
    });
    let status = methods.clone();
    registry.register("document.libreOfficeStatus", move |ctx| {
        let methods = status.clone();
        async move { methods.libre_office_status(ctx).await }
    });
    registry.register("document.installLibreOffice", move |_| {
        let methods = methods.clone();
        async move { methods.install_libre_office().await }
    });
}

struct Methods {
    engine: Arc<dyn DocumentEngine>,
    soffice: Arc<Soffice>,
    /// The threads that used a password: a document opened with one lives in this process's memory, so they stay on this worker
    /// for as long as it runs.
    unlocked: Mutex<HashSet<String>>,
}

impl Methods {
    fn is_unlocked(&self, thread: &str) -> bool {
        self.unlocked.lock().unwrap_or_else(PoisonError::into_inner).contains(thread)
    }

    async fn convert(&self, ctx: &CallCtx, root: &str, rel: &str, password: &str) -> Result<PdfPreview, CodedError> {
        assert_approved_root(ctx, root)?;
        let file = project_entry_path_in(root, rel)?;
        // A PDF needs no conversion: it is rasterized in place, so the editor can show it with the same page viewer as converted
        // documents.
        if has_pdf_extension(&file) {
            let (mtime_ms, size, is_file) = stat(&file)?;
            if !is_file {
                return Err(CodedError::new("not_a_file", "Not a file."));
            }
            return Ok(PdfPreview { path: file.to_string_lossy().into_owned(), format: "pdf".to_owned(), mtime_ms, size, cached: true });
        }
        if preview_format(&file).is_none() {
            return Err(CodedError::new("no_preview_for_type", "This file type has no built-in document preview."));
        }
        self.engine
            .preview_pdf(PreviewRequest {
                file,
                cache_root: text_param(ctx.params.get("cacheRoot")),
                password: (!password.is_empty()).then(|| password.to_owned()),
                cancel: ctx.cancel.clone(),
            })
            .await
    }

    async fn preview(&self, ctx: CallCtx) -> HandlerResult {
        let root = text_param(ctx.params.get("root"));
        let rel = text_param(ctx.params.get("rel"));
        let pdf = self.convert(&ctx, &root, &rel, "").await?;
        Ok(outcome(preview_value(&pdf), self.is_unlocked(&ctx.thread)))
    }

    async fn preview_pages(&self, ctx: CallCtx) -> HandlerResult {
        let root = text_param(ctx.params.get("root"));
        let rel = text_param(ctx.params.get("rel"));
        let options = match ctx.params.get("options") {
            Some(Value::Null) => return Err(CodedError::failed("Cannot read properties of null (reading 'pages')")),
            Some(options) => options.clone(),
            None => json!({}),
        };
        let pages = requested_pages(options.get("pages"))?;
        let max_width = requested_width(options.get("maxWidth"));
        let password = requested_password(options.get("password"))?;
        if !password.is_empty() {
            self.unlocked.lock().unwrap_or_else(PoisonError::into_inner).insert(ctx.thread.clone());
        }
        let cache_root = text_param(ctx.params.get("cacheRoot"));
        let mut pdf = self.convert(&ctx, &root, &rel, &password).await?;
        let render = |pdf: &PdfPreview| {
            self.engine.preview_pages(PagesRequest {
                pdf: pdf.path.clone(),
                pages: pages.clone(),
                max_width,
                cache_root: cache_root.clone(),
                cancel: ctx.cancel.clone(),
            })
        };
        let mut rendered = render(&pdf).await?;
        // The PDF is mutable: if it changed while rasterizing, the pixels may belong to either revision. Re-render once against
        // the new one and report that revision so the renderer's binding resets.
        let (mtime_ms, size, _) = stat(Path::new(&pdf.path))?;
        if mtime_ms != pdf.mtime_ms || size != pdf.size {
            pdf.mtime_ms = mtime_ms;
            pdf.size = size;
            rendered = render(&pdf).await?;
            let (mtime_ms, size, _) = stat(Path::new(&pdf.path))?;
            pdf.mtime_ms = mtime_ms;
            pdf.size = size;
        }
        let value = json!({
            "format": pdf.format,
            "mtimeMs": mixdog_js::json_number(pdf.mtime_ms),
            "size": pdf.size,
            "pageCount": rendered.page_count,
            "pages": rendered.pages.iter().map(|page| json!({
                "page": page.page,
                "width": page.width,
                "height": page.height,
                "mime": page.mime,
                "base64": page.base64,
            })).collect::<Vec<_>>(),
        });
        Ok(outcome(value, self.is_unlocked(&ctx.thread)))
    }

    /// Cached answer; `refresh` first re-probes so an install done outside Mixdog is seen.
    async fn libre_office_status(&self, ctx: CallCtx) -> HandlerResult {
        if ctx.params.get("refresh") == Some(&Value::Bool(true)) {
            self.soffice.refresh().await;
        }
        Ok(Outcome::value(self.soffice.status(false).await))
    }

    async fn install_libre_office(&self) -> HandlerResult {
        let status = self.soffice.install(self.engine.prepare_fonts()).await?;
        Ok(Outcome::value(status))
    }
}

fn outcome(value: Value, pin: bool) -> Outcome {
    if pin { Outcome::pinned(value) } else { Outcome::value(value) }
}

fn preview_value(pdf: &PdfPreview) -> Value {
    json!({
        "path": pdf.path,
        "format": pdf.format,
        "mtimeMs": mixdog_js::json_number(pdf.mtime_ms),
        "size": pdf.size,
        "cached": pdf.cached,
    })
}

/// `String(value || '')`.
fn text_param(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) if number.as_f64().is_some_and(|n| n == 0.0 || n.is_nan()) => String::new(),
        other => js_string(other),
    }
}

// ---- requests ---------------------------------------------------------------------------------

/// The pages of a request: `Math.trunc(Number(page))` of each, de-duplicated, the integers from 1 on; none is refused, as are
/// more than [`MAX_PAGES_PER_CALL`]. A missing list, or a value that is no list, is page 1.
fn requested_pages(value: Option<&Value>) -> Result<Vec<u64>, CodedError> {
    let mut pages: Vec<u64> = Vec::new();
    let mut take = |page: f64| {
        let page = page.trunc();
        if page.is_finite() && page >= 1.0 {
            let page = page as u64;
            if !pages.contains(&page) {
                pages.push(page);
            }
        }
    };
    match value {
        Some(Value::Array(items)) => items.iter().for_each(|item| take(mixdog_js::to_number(item))),
        _ => take(1.0),
    }
    if pages.is_empty() {
        return Err(CodedError::new("invalid_params", "A document preview needs at least one page."));
    }
    if pages.len() > MAX_PAGES_PER_CALL {
        return Err(CodedError::new(
            "invalid_params",
            format!("A document preview accepts at most {MAX_PAGES_PER_CALL} pages per request."),
        ));
    }
    pages.sort_unstable();
    Ok(pages)
}

/// The width of a request: 1200 unless it is a positive number, then clamped to 320 through 2400.
fn requested_width(value: Option<&Value>) -> u32 {
    let width = mixdog_js::to_number_of(value).trunc();
    if !width.is_finite() || width <= 0.0 {
        return DEFAULT_PAGE_WIDTH as u32;
    }
    width.clamp(MIN_PAGE_WIDTH, MAX_PAGE_WIDTH) as u32
}

/// The password of a request, handed to the conversion for this request only, never kept or echoed.
fn requested_password(value: Option<&Value>) -> Result<String, CodedError> {
    match value {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(text)) if text.encode_utf16().count() <= MAX_PASSWORD_LENGTH => Ok(text.clone()),
        Some(_) => Err(CodedError::new(
            "invalid_params",
            format!("A document password must be text of at most {MAX_PASSWORD_LENGTH} characters."),
        )),
    }
}

// ---- project-relative paths -------------------------------------------------------------------

/// What `fs.stat` or `fs.realpathSync` raises, with its Node code and message.
fn os_error(error: &io::Error, syscall: &str, path: &Path) -> CodedError {
    let (code, text) = match error.kind() {
        io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        _ => ("EIO", "i/o error"),
    };
    CodedError::new(code, format!("{code}: {text}, {syscall} '{}'", path.display()))
}

/// The modification time (JavaScript's `mtimeMs`), the size and whether it is a file.
fn stat(path: &Path) -> Result<(f64, u64, bool), CodedError> {
    let info = mixdog_fsio::metadata(&Unlaned, path).map_err(|error| os_error(&error, "stat", path))?;
    let mtime_ms = match info.modified().map(|time| time.duration_since(UNIX_EPOCH)) {
        Ok(Ok(after)) => after.as_secs_f64() * 1000.0,
        Ok(Err(before)) => -before.duration().as_secs_f64() * 1000.0,
        Err(_) => 0.0,
    };
    Ok((mtime_ms, info.len(), info.is_file()))
}

/// `realpathSync`: every link resolved, without the `\\?\` prefix.
fn real_path(path: &Path) -> Result<PathBuf, CodedError> {
    mixdog_fsio::canonicalize(&Unlaned, path)
        .map(|real| dunce::simplified(&real).to_path_buf())
        .map_err(|error| os_error(&error, "realpath", path))
}

fn exists(path: &Path) -> bool {
    mixdog_fsio::exists(&Unlaned, path).unwrap_or(false)
}

/// Node's `path.isAbsolute`: on Windows a rooted path without a drive counts.
fn is_absolute(path: &str) -> bool {
    Path::new(path).has_root()
}

fn is_within_root(root: &str, path: &str) -> bool {
    let prefix = if root.ends_with(MAIN_SEPARATOR) { root.to_owned() } else { format!("{root}{MAIN_SEPARATOR}") };
    path == root || path.starts_with(&prefix)
}

/// Case-folded on Windows, where paths compare without regard to case.
fn comparable(path: &Path) -> String {
    let text = path.to_string_lossy();
    if cfg!(windows) { text.to_lowercase() } else { text.into_owned() }
}

fn canonical_through_existing_ancestor(path: &Path) -> Result<PathBuf, CodedError> {
    let mut existing = path.to_path_buf();
    let mut missing = Vec::new();
    while !exists(&existing) {
        let Some(parent) = existing.parent().filter(|parent| !parent.as_os_str().is_empty()).map(Path::to_path_buf) else {
            break;
        };
        if let Some(name) = existing.file_name() {
            missing.push(name.to_owned());
        }
        existing = parent;
    }
    let mut full = real_path(&existing)?;
    for name in missing.into_iter().rev() {
        full.push(name);
    }
    Ok(pathguard::resolve(&full))
}

/// Traversal- and symlink-guarded absolute path for a project-relative entry.
fn project_entry_path_in(root: &str, rel: &str) -> Result<PathBuf, CodedError> {
    let absolute_root = pathguard::resolve(Path::new(root));
    let target = pathguard::resolve(&absolute_root.join(rel.replace('\\', "/")));
    if !is_within_root(&absolute_root.to_string_lossy(), &target.to_string_lossy()) {
        return Err(CodedError::new("path_outside_project", "Path is outside the project."));
    }
    let canonical_root = real_path(&absolute_root)?;
    let canonical_target = canonical_through_existing_ancestor(&target)?;
    if !is_within_root(&comparable(&canonical_root), &comparable(&canonical_target)) {
        return Err(CodedError::new("path_outside_project", "Path resolves outside the project."));
    }
    Ok(target)
}

/// The project root must be inside the paths the core approved for this call.
fn assert_approved_root(ctx: &CallCtx, root: &str) -> Result<(), CodedError> {
    if !is_absolute(root) {
        return Err(CodedError::new("path_not_approved", format!("project root must be absolute: {root}")));
    }
    let real = real_path(&pathguard::resolve(Path::new(root)))?;
    for approved in &ctx.paths {
        if pathguard::is_inside(&real_path(&pathguard::resolve(Path::new(approved)))?, &real) {
            return Ok(());
        }
    }
    Err(CodedError::new("path_not_approved", format!("path is not approved for this call: {root}")))
}

fn has_pdf_extension(file: &Path) -> bool {
    file.to_string_lossy().to_lowercase().ends_with(".pdf")
}

/// `documentPreviewFormat`: the convertible format of this filename, if any.
fn preview_format(file: &Path) -> Option<String> {
    let text = file.to_string_lossy();
    let name = text.rsplit(['\\', '/']).next().unwrap_or("");
    let dot = name.rfind('.')?;
    if dot + 1 == name.len() {
        return None;
    }
    let extension = name[dot + 1..].to_lowercase();
    PREVIEW_FORMATS.contains(&extension.as_str()).then_some(extension)
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "test setup builds fixture trees")]
mod tests {
    use super::*;

    fn pages(value: Value) -> Result<Vec<u64>, String> {
        requested_pages(Some(&value)).map_err(|e| e.message)
    }

    #[test]
    fn pages_are_truncated_deduplicated_and_sorted() {
        assert_eq!(pages(json!([2, 1, 2])), Ok(vec![1, 2]));
        assert_eq!(pages(json!([3.9, "2", true])), Ok(vec![1, 2, 3]));
        assert_eq!(requested_pages(None).unwrap(), vec![1]);
        assert_eq!(pages(json!("x")), Ok(vec![1]));
        assert_eq!(pages(json!([0, -1, "a", null, 0.5])), Err("A document preview needs at least one page.".to_owned()));
        assert_eq!(pages(json!([])), Err("A document preview needs at least one page.".to_owned()));
        assert_eq!(pages(json!([1, 2, 3, 4, 5])), Err("A document preview accepts at most 4 pages per request.".to_owned()));
        assert_eq!(pages(json!([4, 1, 1, 2, 3])), Ok(vec![1, 2, 3, 4]));
    }

    #[test]
    fn the_width_is_clamped_and_defaults_to_1200() {
        let width = |value: Value| requested_width(Some(&value));
        assert_eq!(requested_width(None), 1200);
        assert_eq!(width(json!(10)), 320);
        assert_eq!(width(json!(5000)), 2400);
        assert_eq!(width(json!(800.7)), 800);
        assert_eq!(width(json!(0)), 1200);
        assert_eq!(width(json!(-5)), 1200);
        assert_eq!(width(json!("640")), 640);
        assert_eq!(width(json!("wide")), 1200);
    }

    #[test]
    fn a_password_is_text_of_at_most_255_characters() {
        let long = "x".repeat(256);
        for bad in [json!(long), json!(5), json!(true), json!(["a"])] {
            let error = requested_password(Some(&bad)).unwrap_err();
            assert_eq!(
                (error.code.as_str(), error.message.as_str()),
                ("invalid_params", "A document password must be text of at most 255 characters.")
            );
        }
        assert_eq!(requested_password(None).unwrap(), "");
        assert_eq!(requested_password(Some(&Value::Null)).unwrap(), "");
        assert_eq!(requested_password(Some(&json!(""))).unwrap(), "");
        assert_eq!(requested_password(Some(&json!("x".repeat(255)))).unwrap().len(), 255);
        // 255 UTF-16 units, as JavaScript counts: an astral character is two.
        assert!(requested_password(Some(&json!("\u{1F600}".repeat(128)))).is_err());
    }

    #[test]
    fn the_convertible_formats_are_the_listed_extensions() {
        let format = |name: &str| preview_format(Path::new(name));
        assert_eq!(format("a/b.DOCX").as_deref(), Some("docx"));
        assert_eq!(format(r"a\b.odp").as_deref(), Some("odp"));
        assert_eq!(format("notes.txt"), None);
        assert_eq!(format("dir.docx/inner"), None);
        assert_eq!(format("trailing."), None);
        assert_eq!(format("docx"), None);
        assert_eq!(format(".docx").as_deref(), Some("docx"));
    }

    #[test]
    fn text_params_are_javascript_strings_or_empty() {
        assert_eq!(text_param(None), "");
        assert_eq!(text_param(Some(&json!(0))), "");
        assert_eq!(text_param(Some(&json!(5))), "5");
        assert_eq!(text_param(Some(&json!("a"))), "a");
    }

    #[test]
    fn an_entry_that_leaves_the_project_is_refused_with_its_message() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let error = project_entry_path_in(&root, "../escape.pdf").unwrap_err();
        assert_eq!((error.code.as_str(), error.message.as_str()), ("path_outside_project", "Path is outside the project."));
        let inside = project_entry_path_in(&root, "no-such-folder\\a.pdf").unwrap();
        assert!(inside.ends_with("a.pdf"));
        assert!(project_entry_path_in(&root, "").is_ok(), "the root itself is inside it");
    }

    #[test]
    fn an_absolute_entry_is_only_accepted_inside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let error = project_entry_path_in(&root, &outside.path().to_string_lossy()).unwrap_err();
        assert_eq!(error.code, "path_outside_project");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_project_is_refused_after_it_is_resolved() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("out")).unwrap();
        let error = project_entry_path_in(&dir.path().to_string_lossy(), "out/a.pdf").unwrap_err();
        assert_eq!((error.code.as_str(), error.message.as_str()), ("path_outside_project", "Path resolves outside the project."));
    }

    #[test]
    fn a_missing_root_reports_the_realpath_failure() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("no-such-root");
        let error = project_entry_path_in(&missing.to_string_lossy(), "a.pdf").unwrap_err();
        assert_eq!(error.code, "ENOENT");
        assert!(error.message.starts_with("ENOENT: no such file or directory, realpath '"));
    }

    #[test]
    fn a_stat_reports_the_revision_of_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.pdf");
        std::fs::write(&file, b"12345").unwrap();
        let (mtime_ms, size, is_file) = stat(&file).unwrap();
        assert!(mtime_ms > 0.0 && size == 5 && is_file);
        assert!(!stat(dir.path()).unwrap().2);
        assert_eq!(stat(&dir.path().join("none")).unwrap_err().code, "ENOENT");
    }

    // ---- the handlers over an engine that is scripted ----

    use crate::ctx::{CallLink, Message, Output};

    /// An engine that answers what a test scripts and records what it was asked.
    #[derive(Default)]
    struct Scripted {
        asked: Mutex<Vec<String>>,
        /// Rewrites this file during the first render, as a PDF that changes while it is rasterised does.
        touch_during_first_render: Mutex<Option<PathBuf>>,
        renders: Mutex<Vec<PagesRequest>>,
    }

    impl DocumentEngine for Arc<Scripted> {
        fn preview_pdf(&self, request: PreviewRequest) -> BoxFuture<Result<PdfPreview, CodedError>> {
            self.asked.lock().unwrap().push(format!("{}|{:?}|{}", request.file.display(), request.password, request.cache_root));
            let pdf = request.file.with_extension("pdf");
            Box::pin(async move {
                let (mtime_ms, size, _) = stat(&pdf)?;
                Ok(PdfPreview { path: pdf.to_string_lossy().into_owned(), format: "docx".to_owned(), mtime_ms, size, cached: false })
            })
        }

        fn preview_pages(&self, request: PagesRequest) -> BoxFuture<Result<RenderedPages, CodedError>> {
            let touch = self.touch_during_first_render.lock().unwrap().take();
            let pages = request.pages.clone();
            self.renders.lock().unwrap().push(request);
            Box::pin(async move {
                if let Some(file) = touch {
                    std::fs::write(file, b"a longer revision").unwrap();
                }
                Ok(RenderedPages {
                    page_count: 9,
                    pages: pages
                        .into_iter()
                        .map(|page| RenderedPage { page, width: 320, height: 200, mime: "image/png".to_owned(), base64: "AA==".to_owned() })
                        .collect(),
                })
            })
        }

        fn prepare_fonts(&self) -> BoxFuture<()> {
            Box::pin(async {})
        }
    }

    fn served(engine: &Arc<Scripted>) -> Registry {
        let mut registry = Registry::new();
        register_over(&mut registry, Arc::new(engine.clone()), Arc::new(Soffice::for_platform()));
        registry
    }

    async fn call(registry: &Registry, method: &str, params: Value, paths: &[&Path], thread: &str) -> Result<Outcome, CodedError> {
        let (out, _frames) = tokio::sync::mpsc::unbounded_channel::<Message>();
        let link = CallLink::new(1, Output(out), CancellationToken::new(), 1 << 20);
        let ctx = CallCtx::new(
            link,
            method.to_owned(),
            params,
            paths.iter().map(|path| path.to_string_lossy().into_owned()).collect(),
            thread.to_owned(),
            String::new(),
        );
        let handler = registry.handler(method).expect("the method is served");
        (*handler)(ctx).await
    }

    fn refused(outcome: Result<Outcome, CodedError>) -> (String, String) {
        let error = outcome.expect_err("a refusal");
        (error.code, error.message)
    }

    #[tokio::test]
    async fn a_pdf_previews_in_place_and_the_refusals_keep_their_codes() {
        let engine = Arc::new(Scripted::default());
        let registry = served(&engine);
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let base = root.path();
        std::fs::write(base.join("a.pdf"), b"%PDF").unwrap();
        std::fs::write(base.join("notes.txt"), b"plain").unwrap();
        std::fs::create_dir(base.join("folder.pdf")).unwrap();
        let root_text = base.to_string_lossy().into_owned();
        let params = |rel: &str| json!({"root": root_text, "rel": rel, "cacheRoot": "cache"});

        let preview = call(&registry, "document.preview", params("a.pdf"), &[base], "t").await.unwrap();
        assert!(!preview.pin);
        assert_eq!(preview.value["format"], "pdf");
        assert_eq!(preview.value["cached"], true);
        assert_eq!(preview.value["size"], 4);
        assert!(preview.value["path"].as_str().unwrap().ends_with("a.pdf"));
        assert!(preview.value["mtimeMs"].as_f64().unwrap() > 0.0);
        assert!(engine.asked.lock().unwrap().is_empty(), "a PDF needs no conversion");

        assert_eq!(
            refused(call(&registry, "document.preview", params("notes.txt"), &[base], "t").await),
            ("no_preview_for_type".to_owned(), "This file type has no built-in document preview.".to_owned())
        );
        assert_eq!(
            refused(call(&registry, "document.preview", params("../escape.pdf"), &[base], "t").await),
            ("path_outside_project".to_owned(), "Path is outside the project.".to_owned())
        );
        assert_eq!(
            refused(call(&registry, "document.preview", params("folder.pdf"), &[base], "t").await),
            ("not_a_file".to_owned(), "Not a file.".to_owned())
        );
        assert_eq!(
            refused(call(&registry, "document.preview", params("a.pdf"), &[outside.path()], "t").await),
            ("path_not_approved".to_owned(), format!("path is not approved for this call: {root_text}"))
        );
        assert_eq!(
            refused(call(&registry, "document.preview", json!({"root": "rel", "rel": "a.pdf"}), &[base], "t").await),
            ("path_not_approved".to_owned(), "project root must be absolute: rel".to_owned())
        );
        assert_eq!(refused(call(&registry, "document.preview", params("missing.pdf"), &[base], "t").await).0, "ENOENT");
        assert!(call(&registry, "document.preview", params("."), &[base], "t").await.is_err(), "a directory is no document");
    }

    #[tokio::test]
    async fn a_converted_document_goes_to_the_engine_with_its_cache_root_and_password() {
        let engine = Arc::new(Scripted::default());
        let registry = served(&engine);
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        std::fs::write(base.join("a.docx"), b"x").unwrap();
        std::fs::write(base.join("a.pdf"), b"%PDF").unwrap();
        let root_text = base.to_string_lossy().into_owned();
        let preview = call(&registry, "document.preview", json!({"root": root_text, "rel": "a.docx", "cacheRoot": "cache"}), &[base], "t")
            .await
            .unwrap();
        assert_eq!(preview.value["format"], "docx");
        assert_eq!(preview.value["cached"], false);
        let pages = call(
            &registry,
            "document.previewPages",
            json!({"root": root_text, "rel": "a.docx", "cacheRoot": "cache", "options": {"password": "pw"}}),
            &[base],
            "t",
        )
        .await
        .unwrap();
        assert!(pages.pin);
        let asked = engine.asked.lock().unwrap().clone();
        assert!(asked[0].ends_with("|None|cache"), "{}", asked[0]);
        assert!(asked[1].ends_with("|Some(\"pw\")|cache"), "{}", asked[1]);
    }

    #[tokio::test]
    async fn pages_are_sorted_deduplicated_and_the_width_is_clamped_before_the_engine_sees_them() {
        let engine = Arc::new(Scripted::default());
        let registry = served(&engine);
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        std::fs::write(base.join("a.pdf"), b"%PDF").unwrap();
        let root_text = base.to_string_lossy().into_owned();
        let pages = |options: Value| json!({"root": root_text, "rel": "a.pdf", "cacheRoot": "c", "options": options});

        let answer = call(&registry, "document.previewPages", pages(json!({"pages": [2, 1, 2], "maxWidth": 10})), &[base], "t").await.unwrap();
        assert_eq!(answer.value["pageCount"], 9);
        assert_eq!(answer.value["format"], "pdf");
        let numbers: Vec<_> = answer.value["pages"].as_array().unwrap().iter().map(|page| page["page"].clone()).collect();
        assert_eq!(numbers, vec![json!(1), json!(2)]);
        assert_eq!(answer.value["pages"][0]["mime"], "image/png");
        {
            let renders = engine.renders.lock().unwrap();
            assert_eq!((renders[0].pages.clone(), renders[0].max_width), (vec![1, 2], 320));
        }
        call(&registry, "document.previewPages", json!({"root": root_text, "rel": "a.pdf"}), &[base], "t").await.unwrap();
        {
            let renders = engine.renders.lock().unwrap();
            assert_eq!((renders[1].pages.clone(), renders[1].max_width), (vec![1], 1200));
        }

        let too_many = call(&registry, "document.previewPages", pages(json!({"pages": [1, 2, 3, 4, 5]})), &[base], "t").await;
        assert_eq!(refused(too_many), ("invalid_params".to_owned(), "A document preview accepts at most 4 pages per request.".to_owned()));
        let none = call(&registry, "document.previewPages", pages(json!({"pages": [0]})), &[base], "t").await;
        assert_eq!(refused(none), ("invalid_params".to_owned(), "A document preview needs at least one page.".to_owned()));
        let null = call(&registry, "document.previewPages", pages(Value::Null), &[base], "t").await;
        assert_eq!(refused(null).0, "failed");
        assert_eq!(engine.renders.lock().unwrap().len(), 2, "a refused request renders nothing");
    }

    #[tokio::test]
    async fn a_pdf_that_changes_while_it_is_rasterised_is_rendered_again_and_reports_the_new_revision() {
        let engine = Arc::new(Scripted::default());
        let registry = served(&engine);
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        std::fs::write(base.join("a.pdf"), b"%PDF").unwrap();
        *engine.touch_during_first_render.lock().unwrap() = Some(base.join("a.pdf"));
        let answer = call(&registry, "document.previewPages", json!({"root": base.to_string_lossy(), "rel": "a.pdf"}), &[base], "t")
            .await
            .unwrap();
        assert_eq!(engine.renders.lock().unwrap().len(), 2);
        assert_eq!(answer.value["size"], "a longer revision".len());
    }

    #[tokio::test]
    async fn a_thread_that_used_a_password_stays_pinned_and_others_do_not() {
        let engine = Arc::new(Scripted::default());
        let registry = served(&engine);
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        std::fs::write(base.join("a.pdf"), b"%PDF").unwrap();
        let root_text = base.to_string_lossy().into_owned();
        let params = |options: Value| json!({"root": root_text, "rel": "a.pdf", "options": options});
        assert!(!call(&registry, "document.previewPages", params(json!({})), &[base], "viewer").await.unwrap().pin);
        assert!(call(&registry, "document.previewPages", params(json!({"password": "secret"})), &[base], "viewer").await.unwrap().pin);
        assert!(call(&registry, "document.previewPages", params(json!({})), &[base], "viewer").await.unwrap().pin, "later requests stay pinned");
        assert!(call(&registry, "document.preview", json!({"root": root_text, "rel": "a.pdf"}), &[base], "viewer").await.unwrap().pin);
        assert!(!call(&registry, "document.previewPages", params(json!({})), &[base], "someone-else").await.unwrap().pin);
        let long = call(&registry, "document.previewPages", params(json!({"password": "x".repeat(256)})), &[base], "v2").await;
        assert_eq!(refused(long).0, "invalid_params");
        let wrong_type = call(&registry, "document.previewPages", params(json!({"password": 7})), &[base], "v3").await;
        assert_eq!(refused(wrong_type).0, "invalid_params");
        assert!(
            !call(&registry, "document.previewPages", params(json!({})), &[base], "v2").await.unwrap().pin,
            "a refused password does not pin"
        );
    }

    #[tokio::test]
    async fn without_an_engine_a_conversion_answers_unavailable_and_a_pdf_still_previews() {
        let mut registry = Registry::new();
        register_with(&mut registry, Arc::new(MissingEngine));
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        std::fs::write(base.join("a.pdf"), b"%PDF").unwrap();
        std::fs::write(base.join("a.docx"), b"x").unwrap();
        let root_text = base.to_string_lossy().into_owned();
        assert!(call(&registry, "document.preview", json!({"root": root_text, "rel": "a.pdf"}), &[base], "t").await.is_ok());
        let convert = call(&registry, "document.preview", json!({"root": root_text, "rel": "a.docx"}), &[base], "t").await;
        assert_eq!(refused(convert).0, "OFFICE_PREVIEW_UNAVAILABLE");
        let render = call(&registry, "document.previewPages", json!({"root": root_text, "rel": "a.pdf"}), &[base], "t").await;
        assert_eq!(refused(render).0, "OFFICE_PREVIEW_UNAVAILABLE");
        assert_eq!(
            registry.methods(),
            vec!["document.installLibreOffice", "document.libreOfficeStatus", "document.preview", "document.previewPages"]
        );
    }
}
