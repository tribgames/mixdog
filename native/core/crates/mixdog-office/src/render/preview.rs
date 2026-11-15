//! `core/office-render-preview.mjs`: a session's document exported to a PDF and drawn as page images, with the review token that
//! names those pixels, the whole-result cache and the page-by-page reuse of a deck.
//!
//! The result is Node's object, in its key order: `session`, `backend`, `output`, `format`, `renderer`, `pageCount`,
//! `visualCoverage`, `images` (without their pixels), `_images` (with them), `reviewToken`, `exportAvailable` and, for a deck
//! drawn page by page, `changedPages`, `reusedPages` and `pageIdentities`.

use std::collections::HashMap;
use std::path::Path;

use mixdog_js::{json_number, json_stringify, to_number_of, value_to_string};
use mixdog_office_base::data_dir::resolve_path;
use mixdog_office_base::values::{sha256, truthy};
use mixdog_office_quality::pipeline::resolve_office_render_output;
use mixdog_rt::CancellationToken;
use serde_json::{Map, Value, json};

use super::RenderEngine;
use super::page_cache::{PageSignature, complete_page_coverage, reusable_pptx_pages};
use crate::session::registry::lock;
use crate::session::{Backend, Mode, SessionHandle};

/// A deck draws at most this many explicit pages.
const MAX_DECK_PAGES: usize = 12;
const DEFAULT_MAX_WIDTH: f64 = 1400.0;
const ABORTED: &str = "This operation was aborted";

/// The facts of a session a render reads, taken once under the session's lock (the lock is never held across an engine call).
pub struct View {
    pub id: String,
    pub format: String,
    pub backend: Backend,
    pub mode: Mode,
    pub target: String,
    pub snapshot_version: u64,
    pub cancel: Option<CancellationToken>,
    /// `cacheable(session)`: owned and not on screen, so a render of an unchanged version is still true.
    pub cacheable: bool,
}

impl View {
    pub fn of(handle: &SessionHandle) -> Self {
        let session = lock(handle);
        Self {
            id: session.id.clone(),
            format: session.format.clone(),
            backend: session.backend,
            mode: session.mode,
            target: session.target.clone(),
            snapshot_version: session.snapshot_version,
            cancel: session.active_signal.clone(),
            cacheable: session.mode != Mode::Visible
                && session.mode != Mode::Attach
                && session.com.ownership.as_deref() == Some("owned")
                && session.com.visible != Some(true),
        }
    }

    /// `session.activeSignal?.throwIfAborted()`.
    pub fn throw_if_aborted(&self) -> Result<(), String> {
        if self.cancel.as_ref().is_some_and(CancellationToken::is_cancelled) { Err(ABORTED.to_owned()) } else { Ok(()) }
    }
}

/// What a call asked for, resolved.
struct Request {
    output: String,
    pages: Option<Vec<f64>>,
    max_width: f64,
}

impl Request {
    fn of(view: &View, args: &Value, cwd: &Path) -> Self {
        let output = match args.get("output").filter(|output| truthy(output)) {
            Some(output) => resolve_path(cwd, Path::new(&value_to_string(output))).to_string_lossy().into_owned(),
            None => default_render_output(&view.target),
        };
        let pages: Option<Vec<f64>> = args
            .get("pages")
            .and_then(Value::as_array)
            .filter(|pages| !pages.is_empty())
            .map(|pages| pages.iter().map(|page| to_number_of(Some(page))).collect());
        let width = to_number_of(args.get("maxWidth"));
        Self {
            output: resolve_office_render_output(&output),
            pages,
            max_width: if width.is_nan() || width == 0.0 { DEFAULT_MAX_WIDTH } else { width },
        }
    }

    fn pages_value(&self) -> Value {
        pages_value(self.pages.as_deref())
    }

    fn to_value(&self) -> Value {
        json!({ "output": self.output, "pages": self.pages_value(), "maxWidth": json_number(self.max_width) })
    }
}

fn pages_value(pages: Option<&[f64]>) -> Value {
    pages.map_or(Value::Null, |pages| Value::Array(pages.iter().map(|page| json_number(*page)).collect()))
}

/// `defaultRenderOutput(source)`: `<name>.mixdog-preview.pdf` beside the source.
pub fn default_render_output(source: &str) -> String {
    let path = Path::new(source);
    let name = format!("{}.mixdog-preview.pdf", path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default());
    match path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        Some(parent) => parent.join(name).to_string_lossy().into_owned(),
        None => name,
    }
}

/// How `renderOfficePreview` is asked.
#[derive(Clone, Copy, Debug, Default)]
pub struct PreviewOptions {
    /// Finalization may reuse the completed visual read even when its output path or resolution differed from the defaults;
    /// explicit requests still take precedence.
    pub reuse_latest: bool,
}

/// `cachedOfficePreview(session, args, cwd, { reuseLatest })`: the last render again when it still answers the call, `None`
/// when the document has changed or the call asks for something else.
pub async fn cached_office_preview<E: RenderEngine>(
    engine: &E,
    handle: &SessionHandle,
    args: &Value,
    cwd: &Path,
    reuse_latest: bool,
) -> Result<Option<Value>, String> {
    let view = View::of(handle);
    view.throw_if_aborted()?;
    let cache = lock(handle).caches.render.clone();
    let Some(cache) = cache else { return Ok(None) };
    if !view.cacheable
        || cache.get("target").and_then(Value::as_str) != Some(view.target.as_str())
        || cache.get("version").and_then(Value::as_u64) != Some(view.snapshot_version)
    {
        return Ok(None);
    }
    let wanted = Request::of(&view, args, cwd);
    let Some(previous) = cache.get("request").filter(|previous| !previous.is_null()) else { return Ok(None) };
    let present = |name: &str| args.get(name).is_some_and(|value| !value.is_null());
    if (!reuse_latest || args.get("output").is_some_and(truthy)) && previous.get("output").and_then(Value::as_str) != Some(wanted.output.as_str()) {
        return Ok(None);
    }
    if (!reuse_latest || present("maxWidth")) && previous.get("maxWidth").and_then(Value::as_f64) != Some(wanted.max_width) {
        return Ok(None);
    }
    if (!reuse_latest || present("pages")) && json_stringify(&wanted.pages_value()) != json_stringify(previous.get("pages").unwrap_or(&Value::Null)) {
        return Ok(None);
    }
    let result = cache.get("result").cloned().unwrap_or(Value::Null);
    if reuse_latest && result.get("visualCoverage").and_then(|coverage| coverage.get("complete")) != Some(&Value::Bool(true)) {
        return Ok(None);
    }
    let images = result.get("_images").and_then(Value::as_array).cloned().unwrap_or_default();
    if images.is_empty() || !images.iter().all(|image| image.get("data").is_some_and(truthy) && image.get("path").is_some_and(truthy)) {
        return Ok(None);
    }
    for image in &images {
        let path = image.get("path").map(value_to_string).unwrap_or_default();
        if !engine.exists(Path::new(&path)).await {
            return Ok(None);
        }
    }
    // A missing intermediate PDF does not invalidate persisted page images.
    let output = result.get("output").map(value_to_string).unwrap_or_default();
    let export_available = engine.exists(Path::new(&output)).await;
    let mut reused = result.as_object().cloned().unwrap_or_default();
    reused.insert("reused".to_owned(), Value::Bool(true));
    reused.insert("exportAvailable".to_owned(), Value::Bool(export_available));
    Ok(Some(Value::Object(reused)))
}

/// `rendererName(session)`: the engine that drew a session's pages. A PDF's rasteriser keeps the name Node reported for its own.
fn renderer_name(view: &View) -> Option<&'static str> {
    if view.format == "pdf" {
        return Some("pdfjs");
    }
    if view.backend != Backend::MicrosoftOfficeCom {
        return Some("LibreOffice");
    }
    match view.format.as_str() {
        "docx" => Some("Microsoft Word"),
        "xlsx" => Some("Microsoft Excel"),
        "pptx" => Some("Microsoft PowerPoint"),
        _ => None,
    }
}

/// `reviewToken(session, version, rendered)`: `session:version:sha256` over the target, the page count, the coverage and each
/// image's dimensions and data. Interactive sessions must refresh, but identical pixels still represent the same review; new
/// pixels invalidate approval even without a batch revision.
fn review_token(view: &View, version: u64, page_count: &Value, coverage: Option<&Value>, images: &[Value]) -> String {
    let mut head = Map::new();
    head.insert("target".to_owned(), Value::String(view.target.clone()));
    head.insert("pageCount".to_owned(), page_count.clone());
    if let Some(coverage) = coverage {
        head.insert("coverage".to_owned(), coverage.clone());
    }
    let mut text = json_stringify(&Value::Object(head));
    for image in images {
        let field = |name: &str| image.get(name).cloned().unwrap_or(Value::Null);
        text.push_str(&json_stringify(&json!([field("page"), field("pages"), field("width"), field("height")])));
        if let Some(data) = image.get("data").filter(|data| truthy(data)) {
            text.push_str(&value_to_string(data));
        }
    }
    format!("{}:{}:{}", view.id, version, sha256(text))
}

/// The page number of an image that is a whole number (`Number.isInteger(image.page)`).
fn integer_page(image: &Value) -> Option<usize> {
    image.get("page").and_then(Value::as_f64).filter(|page| page.fract() == 0.0 && *page >= 0.0).map(|page| page as usize)
}

/// What a deck drawn page by page keeps beside the rest.
struct ByPage<'a> {
    signatures: &'a [PageSignature],
    wanted: &'a [f64],
    missing: Vec<f64>,
}

/// `renderOfficePreview(session, args, cwd, { reuseLatest, exportPreview, rasterize })`.
///
/// The PDF is a full, current export; only rasterisation is incremental (a subset PDF would renumber fields and misrepresent the
/// saved document). A deck of a portable package draws only the slides whose signature changed. Approval is cleared before
/// work that can fail, rather than leaving an earlier render marked current after a failed refresh.
pub async fn render_office_preview<E: RenderEngine>(
    engine: &E,
    handle: &SessionHandle,
    args: &Value,
    cwd: &Path,
    options: PreviewOptions,
) -> Result<Value, String> {
    let view = View::of(handle);
    view.throw_if_aborted()?;
    if let Some(cached) = cached_office_preview(engine, handle, args, cwd, options.reuse_latest).await? {
        return Ok(cached);
    }
    let requested = Request::of(&view, args, cwd);
    // COM documents can contain unsaved edits; only the owned portable package is authoritative enough for cross-revision page reuse.
    let incremental = view.cacheable && view.format == "pptx" && view.backend == Backend::MixdogOoxml;
    let signatures: Option<Vec<PageSignature>> = if incremental { Some(engine.page_signatures(Path::new(&view.target)).await?) } else { None };
    let page_cache = lock(handle).caches.page_render.clone().filter(|cache| cache.get("target").and_then(Value::as_str) == Some(view.target.as_str()));
    let mut retained: HashMap<usize, Value> = match &signatures {
        Some(signatures) => reusable_pptx_pages(engine, page_cache.as_ref(), signatures, &requested.output, requested.max_width).await,
        None => HashMap::new(),
    };
    let wanted_pages: Option<Vec<f64>> =
        signatures.as_ref().map(|signatures| requested.pages.clone().unwrap_or_else(|| signatures.iter().map(|entry| entry.page as f64).collect()));
    if let (Some(wanted), Some(signatures)) = (&wanted_pages, &signatures)
        && (requested.pages.as_ref().is_some_and(|pages| pages.len() > MAX_DECK_PAGES)
            || wanted.iter().any(|page| !page.is_finite() || page.fract() != 0.0 || *page < 1.0 || *page > signatures.len() as f64))
    {
        return Err("render accepts at most 12 explicit pages, within the presentation range".to_owned());
    }
    let by_page = match (&signatures, &wanted_pages) {
        (Some(signatures), Some(wanted)) if wanted.len() <= MAX_DECK_PAGES => Some(ByPage {
            signatures,
            wanted,
            missing: wanted.iter().copied().filter(|page| !retained.contains_key(&(*page as usize))).collect(),
        }),
        _ => None,
    };
    let output_path = Path::new(&requested.output);
    if let Some(parent) = output_path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        engine.make_directory(parent).await?;
    }
    {
        let mut session = lock(handle);
        session.design_state.rendered_version = Value::Null;
        session.design_state.review_token = Some(Value::String(String::new()));
        session.caches.render = None;
        session.caches.page_render = None;
    }
    let export_key = format!("{}\0{}\0{}", view.target, view.snapshot_version, requested.output);
    let previous_key = lock(handle).caches.preview_export_key.clone();
    if !incremental || previous_key.as_deref() != Some(export_key.as_str()) || !engine.exists(output_path).await {
        lock(handle).caches.preview_export_key = None;
        engine.note().note_write(output_path);
        engine.export_document(&view, output_path).await?;
        if incremental {
            lock(handle).caches.preview_export_key = Some(export_key);
        }
    }
    let (page_count, rendered_images, coverage): (Value, Vec<Value>, Option<Value>) = if let Some(deck) = &by_page {
        let fresh = if deck.missing.is_empty() {
            json!({ "pageCount": deck.signatures.len(), "images": [] })
        } else {
            engine.rasterize(output_path, Some(deck.missing.as_slice()), requested.max_width, view.cancel.clone()).await?
        };
        if fresh.get("pageCount").and_then(Value::as_f64) != Some(deck.signatures.len() as f64) {
            return Err("Rendered page count differs from the current presentation".to_owned());
        }
        for image in fresh.get("images").and_then(Value::as_array).into_iter().flatten() {
            if let Some(page) = integer_page(image) {
                retained.insert(page, image.clone());
            }
        }
        if deck.wanted.iter().any(|page| !retained.get(&(*page as usize)).and_then(|image| image.get("data")).is_some_and(truthy)) {
            return Err("Renderer omitted requested presentation pages".to_owned());
        }
        let mut drawn: Vec<usize> = Vec::new();
        for page in deck.wanted {
            if !drawn.contains(&(*page as usize)) {
                drawn.push(*page as usize);
            }
        }
        let images: Vec<Value> = drawn.iter().filter_map(|page| retained.get(page).cloned()).collect();
        (json_number(deck.signatures.len() as f64), images, Some(complete_page_coverage(deck.signatures.len(), &drawn)))
    } else {
        let rendered = engine.rasterize(output_path, requested.pages.as_deref(), requested.max_width, view.cancel.clone()).await?;
        (
            rendered.get("pageCount").cloned().unwrap_or(Value::Null),
            rendered.get("images").and_then(Value::as_array).cloned().unwrap_or_default(),
            rendered.get("visualCoverage").cloned(),
        )
    };
    let version = lock(handle).snapshot_version;
    let token = review_token(&view, version, &page_count, coverage.as_ref(), &rendered_images);
    let mut result = Map::new();
    result.insert("session".to_owned(), Value::String(view.id.clone()));
    result.insert("backend".to_owned(), Value::String(view.backend.as_str().to_owned()));
    result.insert("output".to_owned(), Value::String(requested.output.clone()));
    result.insert("format".to_owned(), Value::String("pdf".to_owned()));
    if let Some(renderer) = renderer_name(&view) {
        result.insert("renderer".to_owned(), Value::String(renderer.to_owned()));
    }
    result.insert("pageCount".to_owned(), page_count.clone());
    if let Some(coverage) = &coverage {
        result.insert("visualCoverage".to_owned(), coverage.clone());
    }
    let plain: Vec<Value> = rendered_images
        .iter()
        .map(|image| {
            let mut fields = image.as_object().cloned().unwrap_or_default();
            fields.shift_remove("data");
            fields.shift_remove("pageImages");
            Value::Object(fields)
        })
        .collect();
    result.insert("images".to_owned(), Value::Array(plain));
    result.insert("_images".to_owned(), Value::Array(rendered_images.clone()));
    result.insert("reviewToken".to_owned(), Value::String(token.clone()));
    result.insert("exportAvailable".to_owned(), Value::Bool(true));
    if let Some(deck) = &by_page {
        let wanted_pages: Vec<usize> = deck.wanted.iter().map(|page| *page as usize).collect();
        result.insert("changedPages".to_owned(), pages_value(Some(deck.missing.as_slice())));
        let reused: Vec<f64> = deck.wanted.iter().copied().filter(|page| !deck.missing.contains(page)).collect();
        result.insert("reusedPages".to_owned(), pages_value(Some(reused.as_slice())));
        // The slides this render drew; the rest of the deck's identities answer nothing asked here.
        let identities: Vec<Value> = deck
            .signatures
            .iter()
            .filter(|entry| wanted_pages.contains(&entry.page))
            .map(|entry| json!({ "page": entry.page, "slideId": json_number(entry.slide_id) }))
            .collect();
        result.insert("pageIdentities".to_owned(), Value::Array(identities));
    }
    let result = Value::Object(result);
    {
        let mut session = lock(handle);
        session.design_state.rendered_version = json_number(version as f64);
        // The width the reviewed pages were drawn at: a later qa or finalize that cannot reuse the cached pages (a session that
        // is not owned) draws them again at that width, so the same pixels keep the same token instead of a 1400 px redraw
        // voiding a review taken at 1000.
        session.design_state.rendered_max_width = Some(json_number(requested.max_width));
        session.design_state.review_token = Some(Value::String(token));
        session.design_state.rendered_page_count = Some(page_count);
        session.design_state.rendered_coverage = coverage;
        if view.cacheable {
            session.caches.render = Some(json!({ "target": view.target, "version": version, "request": requested.to_value(), "result": result }));
        }
    }
    if let Some(signatures) = &signatures {
        for image in &rendered_images {
            if let Some(page) = integer_page(image) {
                retained.insert(page, image.clone());
            }
        }
        let pages: Vec<Value> = signatures
            .iter()
            .filter_map(|entry| {
                retained
                    .get(&entry.page)
                    .map(|image| json!({ "page": entry.page, "slideId": json_number(entry.slide_id), "signature": entry.signature, "image": image }))
            })
            .collect();
        lock(handle).caches.page_render =
            Some(json!({ "target": view.target, "output": requested.output, "maxWidth": json_number(requested.max_width), "pages": pages }));
    }
    Ok(result)
}
