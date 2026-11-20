//! `renderPdfPages` (`pdf/pdf-render.mjs`): a PDF's pages as PNG images on the `mixdog-pdf` rasteriser.
//!
//! A page is drawn at `scale = clamp(maxWidth / pageWidth, 0.25 ..= maximumScale)` (two pixels a point for a preview,
//! three for a picture placed in a document) on a white field. At most twelve explicit pages are accepted; every page of
//! a longer document (none named) is composed into at most twelve labelled contact sheets instead
//! ([`crate::contact_sheets`]). The page numbers a Word or PowerPoint export leaves in the bottom band as glyphs the
//! rasteriser cannot shape are repainted in a family that covers Latin and Hangul. The images land beside the PDF as
//! `<stem>-page-N.png` and `<stem>-pages-A-B.png`, each reported as a write first, unless `write_images` is false (a
//! reader that must not write next to the user's file gets the images in memory only).
//!
//! Pages are rendered in parallel, one lane job each on the bulk compute lane, each on a document opened from the
//! same bytes (a document is not shared between threads); the page numbers are repainted and the sheets composed on a
//! read lane, the files written on the durability lane. A cancelled call stops between pages.

use std::path::Path;
use std::sync::{Arc, Once};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_fonts::registry::Registry;
use mixdog_fsio::ReadProof;
use mixdog_js::is_js_space;
use mixdog_js::math::hypot;
use mixdog_js::nodepath::normalize_host;
use mixdog_js::number_to_string;
use mixdog_office_base::write_note::WriteNote;
use mixdog_pdf::PdfError;
use mixdog_pdf::document::{Document, OpenOptions};
use mixdog_pdf::error::CancelCheck;
use mixdog_pdf::fontdraw::PageFonts;
use mixdog_pdf::oplist::gstate::transform;
use mixdog_pdf::render::{RenderOptions, render_page};
use mixdog_pdf::text;
use mixdog_raster::canvas::{Canvas, ImageData};
use mixdog_rt::{CancellationToken, CpuBulk, DurabilityIo, InLane, JobHandle, LaneToken, LaneTokens};
use serde_json::{Value, json};

use crate::analysis::{js_max, js_min};
use crate::contact_sheets::{self, MAX_RENDER_IMAGES, Thumbnail};
use crate::document::AnalysisError;

const CANCELLED: &str = "PDF rendering was cancelled";
const DEFAULT_MAX_WIDTH: f64 = 1400.0;
const DEFAULT_MAXIMUM_SCALE: f64 = 2.0;
const MINIMUM_SCALE: f64 = 0.25;
/// A thumbnail on a contact sheet may be much smaller than a page image.
const THUMBNAIL_MINIMUM_SCALE: f64 = 0.05;
const MIME_TYPE: &str = "image/png";

/// How a render is asked for (`renderPdfPages(path, { pages, maxWidth, maximumScale, signal, writeImages })`).
#[derive(Clone)]
pub struct RenderPagesOptions {
    /// The 1-based pages, in the order given and each once; `None` (or none named) is every page.
    pub pages: Option<Vec<f64>>,
    /// The width a page is drawn to fit (`maxWidth`, 1400 by default).
    pub max_width: f64,
    /// A preview stops at two pixels a point; a picture placed in a document (a Word chart) asks for three.
    pub maximum_scale: f64,
    pub cancel: Option<CancellationToken>,
    /// `writeImages: false` returns the images in memory only.
    pub write_images: bool,
}

impl Default for RenderPagesOptions {
    fn default() -> Self {
        RenderPagesOptions { pages: None, max_width: DEFAULT_MAX_WIDTH, maximum_scale: DEFAULT_MAXIMUM_SCALE, cancel: None, write_images: true }
    }
}

/// One page drawn as an image.
#[derive(Debug, Clone, PartialEq)]
pub struct PageImage {
    pub page: usize,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
}

/// A page a contact sheet was composed from: the render review reads these, never the sheet (its grey field, labels
/// and borders are not the document).
#[derive(Debug, Clone, PartialEq)]
pub struct SheetPage {
    pub page: usize,
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
}

/// One labelled grid image of a group of pages.
#[derive(Debug, Clone, PartialEq)]
pub struct ContactSheet {
    pub pages: Vec<usize>,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
    pub page_images: Vec<SheetPage>,
}

/// An image of a render: a page, or a contact sheet of several.
#[derive(Debug, Clone, PartialEq)]
pub enum RenderedImage {
    Page(PageImage),
    Sheet(ContactSheet),
}

impl RenderedImage {
    pub fn path(&self) -> &str {
        match self {
            RenderedImage::Page(page) => &page.path,
            RenderedImage::Sheet(sheet) => &sheet.path,
        }
    }

    pub fn png(&self) -> &[u8] {
        match self {
            RenderedImage::Page(page) => &page.png,
            RenderedImage::Sheet(sheet) => &sheet.png,
        }
    }

    /// The pages the image shows.
    fn shown(&self) -> Vec<usize> {
        match self {
            RenderedImage::Page(page) => vec![page.page],
            RenderedImage::Sheet(sheet) => sheet.pages.clone(),
        }
    }

    /// The image as Node's result lists it, its PNG in base64.
    pub fn to_json(&self) -> Value {
        self.json(true)
    }

    fn json(&self, inline_png: bool) -> Value {
        let mut entry = match self {
            RenderedImage::Page(page) => json!({
                "page": page.page,
                "path": page.path,
                "width": page.width,
                "height": page.height,
                "mimeType": MIME_TYPE,
            }),
            RenderedImage::Sheet(sheet) => json!({
                "page": sheet.pages[0],
                "pages": sheet.pages,
                "path": sheet.path,
                "width": sheet.width,
                "height": sheet.height,
                "mimeType": MIME_TYPE,
                "pageImages": sheet.page_images.iter().map(|page| json!({
                    "page": page.page,
                    "width": page.width,
                    "height": page.height,
                    "mimeType": MIME_TYPE,
                    "data": STANDARD.encode(&page.png),
                })).collect::<Vec<_>>(),
            }),
        };
        if inline_png {
            entry["data"] = Value::String(STANDARD.encode(self.png()));
        } else {
            entry["bytes"] = Value::from(self.png().len());
        }
        entry
    }
}

/// Which pages the images show and which they leave out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisualCoverage {
    pub reviewed_pages: Vec<usize>,
    pub total: usize,
    pub remaining_pages: Vec<usize>,
}

impl VisualCoverage {
    fn of(images: &[RenderedImage], total: usize) -> Self {
        let reviewed_pages: Vec<usize> = images.iter().flat_map(RenderedImage::shown).collect();
        let remaining_pages = (1..=total).filter(|page| !reviewed_pages.contains(page)).collect();
        VisualCoverage { reviewed_pages, total, remaining_pages }
    }

    pub fn complete(&self) -> bool {
        self.reviewed_pages.len() == self.total
    }

    pub fn to_json(&self) -> Value {
        json!({
            "reviewedPages": self.reviewed_pages,
            "reviewed": self.reviewed_pages.len(),
            "total": self.total,
            "complete": self.complete(),
            "remainingPages": self.remaining_pages,
        })
    }
}

/// What a render returns.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderedPages {
    pub page_count: usize,
    pub images: Vec<RenderedImage>,
    pub visual_coverage: VisualCoverage,
}

impl RenderedPages {
    /// The result as Node's `renderPdfPages` returns it.
    pub fn to_json(&self) -> Value {
        self.json(true)
    }

    /// Metadata for the worker protocol, which carries the top-level PNGs separately.
    pub fn streamed_json(&self) -> Value {
        self.json(false)
    }

    fn json(&self, inline_png: bool) -> Value {
        json!({
            "pageCount": self.page_count,
            "images": self.images.iter().map(|image| image.json(inline_png)).collect::<Vec<_>>(),
            "visualCoverage": self.visual_coverage.to_json(),
        })
    }
}

// ---- the pages of a call ---------------------------------------------------------------------------------------------

/// `requestedPages`: the pages of the call, each once, in the order given (every page when none are named). More than
/// twelve explicit pages are refused before any is checked; a page that is not a whole number inside the document is
/// named.
fn requested_pages(page_count: usize, pages: Option<&[f64]>) -> Result<Vec<usize>, AnalysisError> {
    let explicit = pages.filter(|pages| !pages.is_empty());
    let all: Vec<f64>;
    let selected = match explicit {
        Some(pages) => pages,
        None => {
            all = (1..=page_count).map(|page| page as f64).collect();
            &all
        }
    };
    let mut unique: Vec<f64> = Vec::with_capacity(selected.len());
    for page in selected {
        if !unique.iter().any(|seen| seen == page || (seen.is_nan() && page.is_nan())) {
            unique.push(*page);
        }
    }
    if explicit.is_some() && unique.len() > MAX_RENDER_IMAGES {
        return Err(AnalysisError::plain(format!("render accepts at most {MAX_RENDER_IMAGES} explicit pages per call")));
    }
    unique
        .into_iter()
        .map(|page| {
            if page.is_finite() && page.fract() == 0.0 && page >= 1.0 && page <= page_count as f64 {
                Ok(page as usize)
            } else {
                Err(AnalysisError::plain(format!("render page out of range: {} (document has {page_count})", number_to_string(page))))
            }
        })
        .collect()
}

/// `Number(targetWidth || 1400)`.
fn target_width_of(width: f64) -> f64 {
    if width == 0.0 || width.is_nan() { DEFAULT_MAX_WIDTH } else { width }
}

/// `Math.min(maximumScale, Math.max(minimumScale, width / pageWidth))`.
fn scale_of(target_width: f64, page_width: f64, minimum_scale: f64, maximum_scale: f64) -> f64 {
    js_min(maximum_scale, js_max(minimum_scale, target_width_of(target_width) / page_width))
}

// ---- the page-number repaint -----------------------------------------------------------------------------------------

/// The text of a page number as an export leaves it: `3 of 12`, `Page 3 / 12`, `페이지 3`, `3 페이지` (case of the Latin
/// words free, white space around and between the parts free).
fn is_page_number(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let (mut start, mut end) = (0, chars.len());
    while start < end && is_js_space(chars[start]) {
        start += 1;
    }
    while end > start && is_js_space(chars[end - 1]) {
        end -= 1;
    }
    let core = &chars[start..end];
    let digits = |at: &mut usize| {
        let from = *at;
        while core.get(*at).is_some_and(char::is_ascii_digit) {
            *at += 1;
        }
        *at > from
    };
    let spaces = |at: &mut usize| {
        while core.get(*at).is_some_and(|c| is_js_space(*c)) {
            *at += 1;
        }
    };
    let literal = |at: &mut usize, expected: &str| {
        let letters: Vec<char> = expected.chars().collect();
        let matched =
            core.len() >= *at + letters.len() && core[*at..*at + letters.len()].iter().zip(&letters).all(|(a, b)| a.to_lowercase().eq(b.to_lowercase()));
        if matched {
            *at += letters.len();
        }
        matched
    };
    // `page 3 of 12`, `3 / 12`
    let mut at = 0;
    if literal(&mut at, "page") {
        spaces(&mut at);
    }
    if digits(&mut at) {
        spaces(&mut at);
        if literal(&mut at, "of") || literal(&mut at, "/") {
            spaces(&mut at);
            if digits(&mut at) && at == core.len() {
                return true;
            }
        }
    }
    // `페이지 3`
    let mut at = 0;
    if literal(&mut at, "페이지") {
        spaces(&mut at);
        if digits(&mut at) && at == core.len() {
            return true;
        }
    }
    // `3 페이지`
    let mut at = 0;
    if digits(&mut at) {
        spaces(&mut at);
        if literal(&mut at, "페이지") && at == core.len() {
            return true;
        }
    }
    false
}

/// A page number to repaint: its text, where it stands on the canvas (the text item's transform under the viewport's)
/// and the advance of the run in pixels.
struct PageNumber {
    text: String,
    transform: [f64; 6],
    width: f64,
}

/// Text set on a canvas (the repainted page numbers, the labels of a sheet) needs a font; a canvas with none draws nothing
/// where Node's canvas, which finds a system font, would. The reason is reported once and the render goes on without it.
pub(crate) fn text_unavailable(reason: &str) {
    static REPORTED: Once = Once::new();
    REPORTED.call_once(|| tracing::error!("text cannot be set on a rendered page: {reason}; page numbers and sheet labels are left out"));
}

/// `Math.round`.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// Repaints the page numbers inside their own bounds: the field is filled with the colour at the left of the run, then
/// the text is set over it in Segoe UI or Malgun Gothic (whichever covers it), squeezed or stretched to the run's
/// advance, dark on a light field and light on a dark one. Every other element of the bottom band is left as drawn.
fn repaint_page_numbers<P: ReadProof>(proof: &P, registry: &Registry, canvas: &mut Canvas, numbers: &[PageNumber]) -> Result<(), String> {
    let (canvas_width, canvas_height) = (f64::from(canvas.width()), f64::from(canvas.height()));
    canvas.save();
    canvas.reset_transform();
    canvas.set_text_baseline("alphabetic");
    for number in numbers {
        let [_, _, c, d, x, baseline] = number.transform;
        let font_height = js_max(1.0, hypot(&[c, d]));
        let width = js_max(1.0, number.width);
        let top = js_max(0.0, (baseline - font_height * 0.95).floor());
        let bottom = js_min(canvas_height, (baseline + font_height * 0.3).ceil());
        let sample_x = js_min(canvas_width - 1.0, js_max(0.0, js_round(x - 3.0)));
        let sample_y = js_min(canvas_height - 1.0, top);
        let sample = canvas.get_image_data(sample_x as i32, sample_y as i32, 1, 1).map_err(|error| error.to_string())?;
        let (red, green, blue) = (sample.data()[0], sample.data()[1], sample.data()[2]);
        canvas.set_fill_color(&format!("rgb({red},{green},{blue})"));
        canvas.fill_rect(js_max(0.0, (x - 1.0).floor()) as f32, top as f32, (width + 2.0).ceil() as f32, js_max(1.0, bottom - top) as f32);
        let luminance = (f64::from(red) * 299.0 + f64::from(green) * 587.0 + f64::from(blue) * 114.0) / 1000.0;
        canvas.set_fill_color(if luminance > 128.0 { "rgb(23,23,23)" } else { "rgb(235,235,235)" });
        canvas.set_font(&format!("{}px \"Segoe UI\", \"Malgun Gothic\", sans-serif", number_to_string(font_height)));
        let measured = match canvas.measure_text(proof, registry, &number.text) {
            Ok(metrics) => js_max(1.0, metrics.width),
            Err(error) => {
                text_unavailable(&error.to_string());
                continue;
            }
        };
        canvas.save();
        canvas.translate(x as f32, baseline as f32);
        canvas.scale((width / measured) as f32, 1.0);
        let drawn = canvas.fill_text(proof, registry, &number.text, 0.0, 0.0, None);
        canvas.restore();
        if let Err(error) = drawn {
            text_unavailable(&error.to_string());
        }
    }
    canvas.restore();
    Ok(())
}

// ---- one page --------------------------------------------------------------------------------------------------------

/// A page drawn: finished, or waiting for its page numbers to be repainted.
enum Painted {
    Done(PageImageData),
    Numbers { width: u32, height: u32, rgba: Vec<u8>, numbers: Vec<PageNumber> },
}

/// A page as a PNG and its size.
struct PageImageData {
    width: u32,
    height: u32,
    png: Vec<u8>,
}

/// What a page job needs: the document's bytes and how to draw the page.
struct PageJob {
    bytes: Arc<[u8]>,
    page: usize,
    target_width: f64,
    minimum_scale: f64,
    maximum_scale: f64,
    cancel: CancellationToken,
}

fn cancel_check(token: &CancellationToken) -> CancelCheck {
    let token = token.clone();
    Arc::new(move || token.is_cancelled())
}

/// The options a document is opened with for rendering: no system fonts (the bundled standard fonts), errors ignored as
/// pdf.js's default does.
fn open_options(cancel: &CancellationToken) -> OpenOptions {
    OpenOptions { cancel: Some(cancel_check(cancel)), use_system_fonts: false, ..OpenOptions::default() }
}

/// A failure of the reader as the render reports it: the reader's message in a plain `Error` (Node's render worker
/// rethrows every failure as `new Error(message)`), the caller's cancellation as the call's own message.
fn reader(error: &PdfError) -> AnalysisError {
    AnalysisError::plain(AnalysisError::from_pdf_or_cancelled(error, CANCELLED).message)
}

/// `renderPdfPageDirect` up to the repaint: the page drawn on a white canvas at its scale, and the page numbers of
/// its bottom band.
fn paint_page(job: &PageJob) -> Result<Painted, AnalysisError> {
    if job.cancel.is_cancelled() {
        return Err(AnalysisError::plain(CANCELLED));
    }
    let document = Document::open(Arc::clone(&job.bytes), &open_options(&job.cancel)).map_err(|error| reader(&error))?;
    let page = document.page(job.page - 1).map_err(|error| reader(&error))?;
    let base = page.viewport(1.0);
    let scale = scale_of(job.target_width, base.width, job.minimum_scale, job.maximum_scale);
    let drawn_fonts = PageFonts::new(&document);
    let options = RenderOptions { scale, fonts: Some(&drawn_fonts), drawing: Some(&drawn_fonts) };
    let rendered = render_page(&document, &page, &options).map_err(|error| reader(&error))?;
    let (width, height) = (rendered.width(), rendered.height());
    let viewport = page.viewport(scale);
    let fonts = text::font_loader(&document);
    let content = page.text_content(&document, &fonts).map_err(|error| reader(&error))?;
    let numbers: Vec<PageNumber> = content
        .items
        .iter()
        .filter(|item| item.transform[5] < base.height * 0.12)
        .filter_map(|item| {
            let shown = item.text();
            is_page_number(&shown).then(|| PageNumber {
                text: shown,
                transform: transform(&viewport.transform, &item.transform),
                width: if item.width.is_nan() { 0.0 } else { item.width * scale },
            })
        })
        .collect();
    if numbers.is_empty() {
        let png = rendered.to_png().map_err(|error| reader(&error))?;
        return Ok(Painted::Done(PageImageData { width, height, png }));
    }
    let rgba = rendered.rgba().map_err(|error| reader(&error))?;
    Ok(Painted::Numbers { width, height, rgba, numbers })
}

/// The repaint of a page's numbers and its PNG, on a read lane (the text is set from the font registry).
fn repaint_page<P: ReadProof>(
    proof: &P,
    registry: &Registry,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    numbers: &[PageNumber],
) -> Result<PageImageData, AnalysisError> {
    let fail = AnalysisError::plain;
    let mut canvas = Canvas::new(width, height).map_err(|error| fail(error.to_string()))?;
    let pixels = ImageData::from_rgba(width, height, rgba).map_err(|error| fail(error.to_string()))?;
    canvas.put_image_data(&pixels, 0, 0, None);
    repaint_page_numbers(proof, registry, &mut canvas, numbers).map_err(fail)?;
    let png = canvas.to_png().map_err(|error| fail(error.to_string()))?;
    Ok(PageImageData { width, height, png })
}

// ---- the lanes -------------------------------------------------------------------------------------------------------

fn lane_error(cancel: &CancellationToken, message: String) -> AnalysisError {
    AnalysisError::plain(if cancel.is_cancelled() { CANCELLED.to_owned() } else { message })
}

/// Puts `job` on `lane`; the handle is awaited with [`finish`].
///
/// The future is boxed here, where its `Send` is proved for any job: left as an `async fn`, a caller that has to be `Send`
/// (the preview's page renderer) cannot prove it through the higher-ranked job closures.
fn submit<'a, L, R, F>(
    lane: L,
    cancel: &'a CancellationToken,
    job: F,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<JobHandle<R>, AnalysisError>> + Send + 'a>>
where
    L: LaneToken,
    R: Send + 'static,
    F: FnOnce(&InLane<L>) -> R + Send + 'static,
{
    Box::pin(async move { lane.submit_wait(cancel, job).await.map_err(|error| lane_error(cancel, error.to_string())) })
}

async fn finish<R>(cancel: &CancellationToken, handle: JobHandle<R>) -> Result<R, AnalysisError> {
    handle.await.map_err(|error| lane_error(cancel, error.to_string()))
}

/// The job of a page: drawn on the bulk compute lane.
async fn start_page(lanes: &LaneTokens, job: PageJob) -> Result<JobHandle<Result<Painted, AnalysisError>>, AnalysisError> {
    let cancel = job.cancel.clone();
    submit(lanes.cpu_bulk, &cancel, move |_: &InLane<CpuBulk>| paint_page(&job)).await
}

/// A started page, its numbers repainted when it has any.
async fn finish_page(
    lanes: &LaneTokens,
    registry: &Arc<Registry>,
    cancel: &CancellationToken,
    handle: JobHandle<Result<Painted, AnalysisError>>,
) -> Result<PageImageData, AnalysisError> {
    if cancel.is_cancelled() {
        return Err(AnalysisError::plain(CANCELLED));
    }
    match finish(cancel, handle).await?? {
        Painted::Done(image) => Ok(image),
        Painted::Numbers { width, height, rgba, numbers } => {
            let registry = Arc::clone(registry);
            let repaint = submit(lanes.interactive_io, cancel, move |lane| repaint_page(lane, &registry, width, height, rgba, &numbers)).await?;
            finish(cancel, repaint).await?
        }
    }
}

/// The images land beside the PDF, each reported as a write first.
async fn write_images(
    lanes: &LaneTokens,
    cancel: &CancellationToken,
    note: Arc<dyn WriteNote>,
    images: Vec<RenderedImage>,
) -> Result<Vec<RenderedImage>, AnalysisError> {
    let job = move |lane: &InLane<DurabilityIo>| {
        let mut failure = None;
        for image in &images {
            note.note_write(Path::new(image.path()));
            if let Err(error) = mixdog_fsio::write(lane, image.path(), image.png()) {
                failure = Some(AnalysisError::plain(format!("{}: {error}", image.path())));
                break;
            }
        }
        (images, failure)
    };
    let handle = submit(lanes.durability_io, cancel, job).await?;
    let (images, failure) = finish(cancel, handle).await?;
    match failure {
        Some(error) => Err(error),
        None => Ok(images),
    }
}

// ---- file names ------------------------------------------------------------------------------------------------------

/// `join(dirname(path), name)` for names built from the stem of the PDF (`basename(path, extname(path))`).
struct Beside {
    directory: String,
    stem: String,
}

impl Beside {
    fn of(path: &Path) -> Self {
        let directory = path.parent().map(|parent| parent.to_string_lossy().into_owned()).unwrap_or_default();
        let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        let stem = match name.rfind('.') {
            Some(dot) if dot > 0 => name[..dot].to_owned(),
            _ => name,
        };
        Beside { directory: if directory.is_empty() { ".".to_owned() } else { directory }, stem }
    }

    fn file(&self, suffix: &str) -> String {
        normalize_host(&format!("{}/{}{suffix}", self.directory, self.stem))
    }
}

// ---- the call --------------------------------------------------------------------------------------------------------

/// `renderPdfPages(path, options)`: see the module. `registry` is the font registry the repainted numbers and the
/// sheet labels are set with; `note` hears of each image before it is written.
pub async fn render_pdf_pages(
    lanes: LaneTokens,
    registry: Arc<Registry>,
    note: Arc<dyn WriteNote>,
    path: &Path,
    options: RenderPagesOptions,
) -> Result<RenderedPages, AnalysisError> {
    let cancel = options.cancel.clone().unwrap_or_default();
    if cancel.is_cancelled() {
        return Err(AnalysisError::plain(CANCELLED));
    }
    let target = path.to_path_buf();
    let read = submit(lanes.interactive_io, &cancel, move |lane| mixdog_fsio::read(lane, &target)).await?;
    let bytes: Arc<[u8]> = Arc::from(finish(&cancel, read).await?.map_err(|error| AnalysisError::plain(error.to_string()))?);
    let opened = Arc::clone(&bytes);
    let open_cancel = cancel.clone();
    let counted = submit(lanes.cpu_bulk, &cancel, move |_: &InLane<CpuBulk>| {
        Document::open(opened, &open_options(&open_cancel)).map(|document| document.num_pages()).map_err(|error| reader(&error))
    })
    .await?;
    let page_count = usize::try_from(finish(&cancel, counted).await??).unwrap_or(0);
    let selected = requested_pages(page_count, options.pages.as_deref())?;
    let beside = Beside::of(path);
    let job_of = |page: usize, target_width: f64, minimum_scale: f64| PageJob {
        bytes: Arc::clone(&bytes),
        page,
        target_width,
        minimum_scale,
        maximum_scale: options.maximum_scale,
        cancel: cancel.clone(),
    };
    let mut images = Vec::new();
    if selected.len() <= MAX_RENDER_IMAGES {
        let mut started = Vec::with_capacity(selected.len());
        for page in &selected {
            started.push((*page, start_page(&lanes, job_of(*page, options.max_width, MINIMUM_SCALE)).await?));
        }
        for (page, handle) in started {
            let drawn = finish_page(&lanes, &registry, &cancel, handle).await?;
            images.push(RenderedImage::Page(PageImage {
                page,
                path: beside.file(&format!("-page-{page}.png")),
                width: drawn.width,
                height: drawn.height,
                png: drawn.png,
            }));
        }
    } else {
        let width = contact_sheets::sheet_width(options.max_width);
        for group in contact_sheets::page_groups(&selected) {
            let grid = contact_sheets::grid(group.len(), width);
            let mut started = Vec::with_capacity(group.len());
            for page in &group {
                started.push((*page, start_page(&lanes, job_of(*page, f64::from(grid.cell_width), THUMBNAIL_MINIMUM_SCALE)).await?));
            }
            let mut drawn = Vec::with_capacity(group.len());
            for (page, handle) in started {
                drawn.push((page, finish_page(&lanes, &registry, &cancel, handle).await?));
            }
            let thumbnails: Vec<Thumbnail> = drawn.iter().map(|(page, image)| Thumbnail { page: *page, png: image.png.clone() }).collect();
            let sheet_registry = Arc::clone(&registry);
            let composing = submit(lanes.interactive_io, &cancel, move |lane| contact_sheets::compose(lane, &sheet_registry, &thumbnails, grid, width)).await?;
            let sheet = finish(&cancel, composing).await?.map_err(AnalysisError::plain)?;
            images.push(RenderedImage::Sheet(ContactSheet {
                path: beside.file(&format!("-pages-{}-{}.png", group[0], group[group.len() - 1])),
                pages: group,
                width: sheet.width,
                height: sheet.height,
                png: sheet.png,
                page_images: drawn.into_iter().map(|(page, image)| SheetPage { page, width: image.width, height: image.height, png: image.png }).collect(),
            }));
        }
    }
    if options.write_images {
        images = write_images(&lanes, &cancel, note, images).await?;
    }
    let visual_coverage = VisualCoverage::of(&images, page_count);
    Ok(RenderedPages { page_count, images, visual_coverage })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_numbers_in_every_form_the_exports_use() {
        for text in ["3 of 12", "Page 3 of 12", "page3of12", "PAGE 3 / 12", " 1/3 ", "페이지 3", "페이지3", "3 페이지", "3페이지 ", "Page 1 of 3"] {
            assert!(is_page_number(text), "{text:?}");
        }
    }

    #[test]
    fn other_bottom_band_text_is_left_alone() {
        for text in ["", "Page", "Page 3", "3", "of 12", "3 of", "Source: Acme 2024", "Page 3 of 12 draft", "페이지", "1 2 페이지", "3 of 12 of 4", "p. 3"]
        {
            assert!(!is_page_number(text), "{text:?}");
        }
    }

    #[test]
    fn explicit_pages_are_unique_in_order_and_at_most_twelve() {
        assert_eq!(requested_pages(5, None).unwrap(), [1, 2, 3, 4, 5]);
        assert_eq!(requested_pages(5, Some(&[])).unwrap(), [1, 2, 3, 4, 5]);
        assert_eq!(requested_pages(5, Some(&[3.0, 1.0, 3.0])).unwrap(), [3, 1]);
        let thirteen: Vec<f64> = (1..=13).map(f64::from).collect();
        assert_eq!(requested_pages(20, Some(&thirteen)).unwrap_err().message, "render accepts at most 12 explicit pages per call");
        let twelve: Vec<f64> = (1..=12).map(f64::from).collect();
        assert_eq!(requested_pages(20, Some(&twelve)).unwrap().len(), 12);
        assert_eq!(requested_pages(30, None).unwrap().len(), 30);
    }

    #[test]
    fn a_page_outside_the_document_is_named() {
        for (page, text) in [(0.0, "0"), (4.0, "4"), (1.5, "1.5"), (f64::NAN, "NaN"), (-2.0, "-2")] {
            let error = requested_pages(3, Some(&[page])).unwrap_err();
            assert_eq!(error.message, format!("render page out of range: {text} (document has 3)"));
        }
    }

    #[test]
    fn the_scale_is_the_width_over_the_page_between_the_bounds() {
        assert_eq!(scale_of(1400.0, 700.0, 0.25, 2.0), 2.0);
        assert_eq!(scale_of(1400.0, 700.0, 0.25, 3.0), 2.0);
        assert_eq!(scale_of(1400.0, 200.0, 0.25, 3.0), 3.0);
        assert_eq!(scale_of(100.0, 800.0, 0.25, 2.0), 0.25);
        assert_eq!(scale_of(10.0, 800.0, 0.05, 2.0), 0.05);
        assert_eq!(scale_of(0.0, 1400.0, 0.25, 2.0), 1.0);
        assert_eq!(scale_of(f64::NAN, 700.0, 0.25, 2.0), 2.0);
    }

    #[test]
    fn the_files_land_beside_the_pdf() {
        let beside = Beside::of(Path::new("work/deck.final.pdf"));
        assert_eq!(beside.file("-page-3.png"), normalize_host("work/deck.final-page-3.png"));
        assert_eq!(Beside::of(Path::new("deck.pdf")).file("-pages-1-2.png"), "deck-pages-1-2.png");
    }

    #[test]
    fn coverage_names_what_the_images_leave_out() {
        let page = |page| RenderedImage::Page(PageImage { page, path: String::new(), width: 1, height: 1, png: Vec::new() });
        let coverage = VisualCoverage::of(&[page(2), page(4)], 5);
        assert_eq!(coverage.reviewed_pages, [2, 4]);
        assert_eq!(coverage.remaining_pages, [1, 3, 5]);
        assert!(!coverage.complete());
        let json = coverage.to_json();
        assert_eq!(json["reviewed"], 2);
        assert_eq!(json["complete"], false);
        assert!(VisualCoverage::of(&[page(1), page(2)], 2).complete());
    }
}
