//! OCR of a PDF's pages (`pdf/pdf-ocr.mjs`). A page is rendered at a `maxWidth` of 1200 to 3200 (2400 by default), and the
//! words that reach `minConfidence` (40 by default) are set with opacity 0 in one font (Helvetica when it covers them, else an
//! installed Unicode face, or the `fontPath` of the call).

pub mod engine;
pub mod install;
pub mod layer;
pub mod tsv;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_fonts::registry::Registry;
use mixdog_js::math::to_fixed;
use mixdog_js::{json_number, to_number, to_number_of, value_to_string};
use mixdog_office_base::values::truthy;
use mixdog_office_base::write_note::WriteNote;
use mixdog_pdf::Guard;
use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::embed::{DocumentFont, FontEnv, FontRequest, StandardFontName, embed_document_font};
use mixdog_pdf::write::{LoadOptions, PdfDocument, SaveOptions};
use mixdog_rt::{CancellationToken, InLane, LaneToken, LaneTokens};
use serde_json::{Map, Value, json};

use crate::analysis::{js_max, js_min};
use crate::contact_sheets::MAX_RENDER_IMAGES;
use crate::document::{AnalysisError, selected_pages};
use crate::edit_document::edit_error;
use crate::render::{RenderPagesOptions, RenderedImage, render_pdf_pages};

use engine::{AcquireOptions, Image, OcrEngine, OcrEngines, OcrError};
use layer::{RecognizedPage, Tally};
use tsv::ocr_text_lines;

const DEFAULT_MIN_CONFIDENCE: f64 = 40.0;
const DEFAULT_LANGUAGES: &str = "eng+kor";
const DEFAULT_MAX_WIDTH: f64 = 2400.0;
/// The width a read-only recognition renders a page to.
const READ_WIDTH: f64 = 2000.0;
const CANCELLED: &str = "PDF OCR was cancelled";

/// Puts `job` on `lane` and waits for it; a lane that cannot take it is the error.
pub(crate) async fn lane_job<L, R, F>(lane: L, cancel: &CancellationToken, job: F) -> Result<R, String>
where
    L: LaneToken,
    R: Send + 'static,
    F: FnOnce(&InLane<L>) -> R + Send + 'static,
{
    let handle = lane.submit_wait(cancel, job).await.map_err(|error| error.to_string())?;
    handle.await.map_err(|error| error.to_string())
}

/// What a call reads from the host.
#[derive(Clone)]
pub struct OcrContext {
    pub lanes: LaneTokens,
    /// The fonts the repainted page numbers of a render are set with.
    pub registry: Arc<Registry>,
    /// Hears of each image the render writes beside the PDF.
    pub note: Arc<dyn WriteNote>,
    pub engines: Arc<OcrEngines>,
    /// The data folder (`MIXDOG_DATA_DIR`): the program, its languages and a page's files live under `office/ocr`.
    pub data_dir: PathBuf,
}

impl OcrContext {
    /// A context over the engines of the process.
    pub fn new(lanes: LaneTokens, registry: Arc<Registry>, note: Arc<dyn WriteNote>, data_dir: impl Into<PathBuf>) -> Self {
        OcrContext { lanes, registry, note, engines: Arc::clone(engine::shared(lanes)), data_dir: data_dir.into() }
    }
}

/// `<dataDir>/office/ocr`.
pub fn ocr_root(data_dir: &Path) -> PathBuf {
    data_dir.join("office").join("ocr")
}

/// Where each language's recognition data is downloaded to and kept.
pub fn ocr_cache_path(data_dir: &Path) -> PathBuf {
    ocr_root(data_dir).join("languages")
}

/// `pdfOcrReadiness(dataDir)`: whether a scanned page can be read here and now. The program and each language's data are
/// downloaded on first use and kept: promising OCR of a Korean scan on a machine with no network and no cached `kor` data
/// fails in the middle of the task instead of before it.
pub async fn pdf_ocr_readiness(lanes: &LaneTokens, data_dir: &Path) -> Result<Value, AnalysisError> {
    let cache_path = ocr_cache_path(data_dir);
    let (engine_root, listed) = (ocr_root(data_dir).join("engine"), cache_path.clone());
    let cancel = CancellationToken::new();
    let (available, cached) = lane_job(lanes.durability_io, &cancel, move |lane| {
        let platform = install::platform_key();
        let available =
            install::engine_installed(lane, &engine_root, install::ENGINE_ASSETS, &platform) || install::asset_for(install::ENGINE_ASSETS, &platform).is_some();
        (available, install::cached_languages(lane, &listed))
    })
    .await
    .map_err(AnalysisError::plain)?;
    Ok(json!({
        "available": available,
        "backend": "tesseract",
        "cachedLanguages": cached,
        "cachePath": cache_path.to_string_lossy(),
        "note": "A language not listed is downloaded on first use; without network access only the cached ones work.",
    }))
}

/// The languages of a call: an array joined with `+`, else the text given, else `eng+kor`.
pub fn language_set(languages: Option<&Value>) -> String {
    match languages {
        Some(Value::Array(items)) => items.iter().map(value_to_string).collect::<Vec<_>>().join("+"),
        Some(value) if truthy(value) => value_to_string(value),
        _ => DEFAULT_LANGUAGES.to_owned(),
    }
}

fn ocr_error(error: OcrError) -> AnalysisError {
    AnalysisError::plain(error.message)
}

/// The shared engine for the languages of a call: it starts on its own, so a stalled first-use download or a
/// cancellation ends it at once.
async fn open_engine(context: &OcrContext, languages: &str, cancel: &Option<CancellationToken>) -> Result<OcrEngine, AnalysisError> {
    let mut options = AcquireOptions::new(languages, ocr_root(&context.data_dir));
    options.cache_path = ocr_cache_path(&context.data_dir);
    options.cancel = cancel.clone();
    context.engines.acquire(options).await.map_err(ocr_error)
}

fn is_cancelled(cancel: &Option<CancellationToken>) -> bool {
    cancel.as_ref().is_some_and(CancellationToken::is_cancelled)
}

/// What a page was read as, in the text the read tool shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageText {
    pub page: usize,
    pub text: String,
}

/// `recognizePdfPageTexts`: the recognised text of `pages` (1-based) of the PDF at `path`. Read-only: pages are rendered
/// in memory (2000 px, twelve at a time) and nothing is written next to the PDF or into it. Fails when the engine or its
/// language data is unavailable (no network on first use).
pub async fn recognize_pdf_page_texts(
    context: &OcrContext,
    path: &Path,
    pages: &[usize],
    languages: Option<&Value>,
    cancel: Option<CancellationToken>,
) -> Result<Vec<PageText>, AnalysisError> {
    let engine = open_engine(context, &language_set(languages), &cancel).await?;
    let result = read_pages(context, &engine, path, pages, &cancel).await;
    engine.release();
    result
}

async fn read_pages(
    context: &OcrContext,
    engine: &OcrEngine,
    path: &Path,
    pages: &[usize],
    cancel: &Option<CancellationToken>,
) -> Result<Vec<PageText>, AnalysisError> {
    let mut out = Vec::new();
    for batch in pages.chunks(MAX_RENDER_IMAGES) {
        if is_cancelled(cancel) {
            return Err(AnalysisError::plain(CANCELLED));
        }
        let options = RenderPagesOptions {
            pages: Some(batch.iter().map(|page| *page as f64).collect()),
            max_width: READ_WIDTH,
            cancel: cancel.clone(),
            write_images: false,
            ..RenderPagesOptions::default()
        };
        let rendered = render_pdf_pages(context.lanes, Arc::clone(&context.registry), Arc::clone(&context.note), path, options).await?;
        for image in rendered.images {
            if is_cancelled(cancel) {
                return Err(AnalysisError::plain(CANCELLED));
            }
            let RenderedImage::Page(page) = image else { continue };
            let recognized = engine.recognize(Image::Bytes(page.png), false, cancel.as_ref()).await.map_err(ocr_error)?;
            out.push(PageText { page: page.page, text: mixdog_js::js_trim(&recognized.text).to_owned() });
        }
    }
    Ok(out)
}

/// `minConfidence`: `Number(operation.minConfidence ?? 40)`.
fn min_confidence(operation: &Value) -> f64 {
    match operation.get("minConfidence") {
        None | Some(Value::Null) => DEFAULT_MIN_CONFIDENCE,
        Some(value) => to_number(value),
    }
}

/// The pages of the call: `pages` when it is a non-empty array, else `page`, else every page (`selectedPages`).
fn named_pages(operation: &Value) -> Option<Vec<f64>> {
    let pages = operation.get("pages").filter(|value| truthy(value));
    match pages {
        Some(Value::Array(items)) => Some(items.iter().map(to_number).collect()),
        Some(_) => None,
        None => operation.get("page").filter(|value| truthy(value)).map(|page| vec![to_number(page)]),
    }
}

fn load_document(bytes: &[u8]) -> Result<PdfDocument, AnalysisError> {
    let options = LoadOptions { ignore_encryption: false, filters: Arc::new(CodecFilters), guard: Guard::unbounded() };
    PdfDocument::load(bytes.to_vec(), &options).map_err(edit_error)
}

/// One font for all the recognised text: Helvetica when it covers it, an installed Unicode face otherwise. OCR noise can
/// contain glyphs no installed face has; keep the words a font does cover rather than failing the whole page.
async fn select_font(context: &OcrContext, operation: &Value, coverage: String) -> Result<DocumentFont, AnalysisError> {
    let asked = operation.get("fontPath").filter(|value| truthy(value)).map(value_to_string).unwrap_or_default();
    let cancel = CancellationToken::new();
    let lanes = context.lanes;
    let choose = move |font_path: String, text: String| {
        let cancel = cancel.clone();
        async move {
            lane_job(lanes.durability_io, &cancel, move |lane| {
                embed_document_font(lane, &FontEnv::host(), &FontRequest { font_path: &font_path, text: &text, standard: StandardFontName::Helvetica })
            })
            .await
        }
    };
    match choose(asked.clone(), coverage).await.map_err(AnalysisError::plain)? {
        Ok(font) => Ok(font),
        Err(error) if !asked.is_empty() => Err(AnalysisError::plain(error.to_string())),
        Err(_) => choose(String::new(), String::new()).await.map_err(AnalysisError::plain)?.map_err(|error| AnalysisError::plain(error.to_string())),
    }
}

/// The result of the operation, in Node's key order.
fn ocr_result(operation: &Value, pages: &[usize], languages: &str, text: String, tally: Tally, font: &DocumentFont) -> Value {
    let mut result = Map::new();
    if let Some(op) = operation.get("op") {
        result.insert("op".to_owned(), op.clone());
    }
    result.insert("changed".to_owned(), json!(tally.word_count > 0));
    result.insert("pages".to_owned(), json!(pages));
    result.insert("languages".to_owned(), json!(languages));
    result.insert("wordCount".to_owned(), json!(tally.word_count));
    if tally.skipped_words > 0 {
        result.insert("skippedWords".to_owned(), json!(tally.skipped_words));
        result.insert("skippedReason".to_owned(), json!("no installed font has glyphs for these words; pass fontPath to keep them"));
    }
    let average = if tally.word_count > 0 { to_fixed(tally.total_confidence / tally.word_count as f64, 2).parse::<f64>().unwrap_or(0.0) } else { 0.0 };
    result.insert("averageConfidence".to_owned(), json_number(average));
    result.insert("text".to_owned(), json!(text));
    result.insert("searchableTextLayer".to_owned(), json!(tally.word_count > 0));
    result.insert("fontEmbedded".to_owned(), json!(font.embedded));
    if !font.font_path.is_empty() {
        result.insert("fontPath".to_owned(), json!(font.font_path));
    }
    Value::Object(result)
}

/// Everything one call of the operation reads from.
struct Call<'a> {
    context: &'a OcrContext,
    engine: &'a OcrEngine,
    path: &'a Path,
    operation: &'a Value,
    languages: &'a str,
    cancel: &'a Option<CancellationToken>,
}

impl Call<'_> {
    /// Renders and recognises one page; the rendered image path is recorded on `temporary` for cleanup.
    async fn recognize_page(&self, page_number: usize, temporary: &mut Vec<PathBuf>) -> Result<RecognizedPage, AnalysisError> {
        let width = to_number_of(self.operation.get("maxWidth"));
        let width = if width.is_nan() || width == 0.0 { DEFAULT_MAX_WIDTH } else { width };
        let options = RenderPagesOptions {
            pages: Some(vec![page_number as f64]),
            max_width: js_max(1200.0, js_min(3200.0, width)),
            cancel: self.cancel.clone(),
            ..RenderPagesOptions::default()
        };
        let context = self.context;
        let rendered = render_pdf_pages(context.lanes, Arc::clone(&context.registry), Arc::clone(&context.note), self.path, options).await?;
        let Some(RenderedImage::Page(image)) = rendered.images.into_iter().next() else {
            return Err(AnalysisError::plain("PDF render returned no page image"));
        };
        temporary.push(PathBuf::from(&image.path));
        let recognized = self.engine.recognize(Image::Path(PathBuf::from(&image.path)), true, self.cancel.as_ref()).await.map_err(ocr_error)?;
        let lines = ocr_text_lines(&recognized.tsv, &recognized.text);
        Ok(RecognizedPage { page_number, image_width: f64::from(image.width), image_height: f64::from(image.height), lines, text: recognized.text })
    }

    async fn recognize_and_place(&self, document: &mut PdfDocument, pages: &[usize], temporary: &mut Vec<PathBuf>) -> Result<Value, AnalysisError> {
        let mut text = String::new();
        let mut recognized_pages = Vec::new();
        // Recognise every page first so one font can be chosen for all the text it produced.
        for page_number in pages {
            if is_cancelled(self.cancel) {
                return Err(AnalysisError::plain(CANCELLED));
            }
            let recognized = self.recognize_page(*page_number, temporary).await?;
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(&format!("--- Page {page_number} ---\n{}", recognized.text));
            recognized_pages.push(recognized);
        }
        let minimum = min_confidence(self.operation);
        let coverage = recognized_pages
            .iter()
            .flat_map(|entry| layer::kept_words(&entry.lines, minimum).map(|(_, _, word)| word.text.as_str()))
            .collect::<Vec<_>>()
            .join(" ");
        let chosen = select_font(self.context, self.operation, coverage).await?;
        let refs = document.pages();
        let mut tally = Tally::default();
        let mut planned = Vec::with_capacity(recognized_pages.len());
        for entry in &recognized_pages {
            let page = *refs.get(entry.page_number - 1).ok_or_else(|| AnalysisError::plain(format!("PDF page out of range: {}", entry.page_number)))?;
            let size = document.media_box(page).map_err(edit_error)?;
            let placements =
                layer::plan_page(entry, size.width, size.height, &chosen.font, minimum, &mut tally).map_err(|error| AnalysisError::plain(error.to_string()))?;
            planned.push((page, placements));
        }
        layer::draw_layer(document, &chosen.font, &planned).map_err(|error| AnalysisError::plain(error.to_string()))?;
        if tally.word_count > 0 {
            let saved = document.save(SaveOptions::default());
            let target = self.path.to_path_buf();
            let never = CancellationToken::new();
            lane_job(self.context.lanes.durability_io, &never, move |lane| mixdog_fsio::write(lane, &target, saved))
                .await
                .map_err(AnalysisError::plain)?
                .map_err(|error| AnalysisError::plain(error.to_string()))?;
        }
        Ok(ocr_result(self.operation, pages, self.languages, text, tally, &chosen))
    }
}

/// The `ocr` operation: gives the scanned pages of the PDF at `path` an invisible text layer, in place. `operation` holds
/// `pages` (or `page`), `languages` (`eng+kor`), `maxWidth`, `minConfidence` and `fontPath`.
pub async fn ocr_pdf(context: &OcrContext, path: &Path, operation: &Value, cancel: Option<CancellationToken>) -> Result<Value, AnalysisError> {
    let target = path.to_path_buf();
    let never = CancellationToken::new();
    let source = lane_job(context.lanes.interactive_io, &never, move |lane| mixdog_fsio::read(lane, &target))
        .await
        .map_err(AnalysisError::plain)?
        .map_err(|error| AnalysisError::plain(error.to_string()))?;
    let mut document = load_document(&source)?;
    let named = named_pages(operation);
    let pages = selected_pages(document.page_count() as i64, named.as_deref())?;
    let languages = language_set(operation.get("languages"));
    let engine = open_engine(context, &languages, &cancel).await?;
    let mut temporary = Vec::new();
    let call = Call { context, engine: &engine, path, operation, languages: &languages, cancel: &cancel };
    let result = call.recognize_and_place(&mut document, &pages, &mut temporary).await;
    engine.release();
    let cleanup = CancellationToken::new();
    let _ = lane_job(context.lanes.durability_io, &cleanup, move |lane| {
        for image in &temporary {
            let _ = mixdog_fsio::remove_file(lane, image);
        }
    })
    .await;
    result
}
