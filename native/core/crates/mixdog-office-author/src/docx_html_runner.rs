//! The `author` action's Word input (`authoring/docx-html-runner.mjs`): lay the HTML out in the shared render browser at
//! the printable width of its `@page` sheet, read it back as Word's flow (`measure_docx`), photograph what Word cannot
//! draw as text (an SVG, a chart, a canvas), print the same HTML as the reference the review compares against, and write
//! the .docx (`docx_build`). The HTML source and the page images of the print are kept beside the document.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_fonts::registry::Registry;
use mixdog_js::math::round as js_round;
use mixdog_office_base::write_note::WriteNote;
use mixdog_office_pdf::RenderPagesOptions;
use mixdog_office_pdf::RenderedImage;
use mixdog_office_pdf::render_pdf_pages;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::docx_build::DocxPage;
use crate::docx_build::build_docx_from_flow;
use crate::docx_build::inline_pictures;
use crate::html_browser::AuthorLanes;
use crate::html_browser::LAYOUT_TIMEOUT;
use crate::html_browser::RunError;
use crate::html_browser::html_failure;
use crate::measure_docx::DocxLayout;
use crate::measure_docx::DocxMeasureOptions;
use crate::measure_docx::measure_docx_html;
use crate::pdf_print::PrintableArea;

/// CSS px to points.
const PX_TO_PT: f64 = 0.75;

/// The width the review's page images of the print are drawn to fit.
const COMPARE_WIDTH: f64 = 900.0;

/// Artifacts kept beside the document: its HTML and the browser's print of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DocxHtmlArtifacts {
    target: PathBuf,
}

/// `docxHtmlArtifacts(target)`.
pub fn docx_html_artifacts(target: &Path) -> DocxHtmlArtifacts {
    DocxHtmlArtifacts { target: target.to_path_buf() }
}

impl DocxHtmlArtifacts {
    fn beside(&self, suffix: &str) -> PathBuf {
        let mut name = self.target.as_os_str().to_os_string();
        name.push(suffix);
        PathBuf::from(name)
    }

    /// `<document>.mixdog-source.html`: the HTML as it was laid out.
    pub fn source(&self) -> PathBuf {
        self.beside(".mixdog-source.html")
    }

    /// `<document>.mixdog-html.pdf`: the browser's print of the HTML.
    pub fn print(&self) -> PathBuf {
        self.beside(".mixdog-html.pdf")
    }

    /// `<document>.mixdog-compare-page-<n>.png`: the HTML and the Word render of page `n` side by side.
    pub fn compare(&self, page: usize) -> PathBuf {
        self.beside(&format!(".mixdog-compare-page-{page}.png"))
    }
}

/// How a Word document is authored from HTML.
pub struct DocxRunOptions<'a> {
    /// The document the artifacts are kept beside.
    pub target: &'a Path,
    pub timeout: Duration,
    pub cancel: CancellationToken,
}

impl<'a> DocxRunOptions<'a> {
    /// The options of a plain document: the layout deadline and no cancellation.
    pub fn new(target: &'a Path) -> Self {
        Self { target, timeout: LAYOUT_TIMEOUT, cancel: CancellationToken::new() }
    }
}

/// `Math.round(value * PX_TO_PT * 100) / 100`: CSS px as points to two places.
fn points(value: f64) -> f64 {
    js_round(value * PX_TO_PT * 100.0) / 100.0
}

/// The Word page of the printable area the document declared.
pub fn page_of(area: &PrintableArea) -> DocxPage {
    DocxPage {
        width: points(area.sheet.width),
        height: points(area.sheet.height),
        top: points(area.margin.top),
        right: points(area.margin.right),
        bottom: points(area.margin.bottom),
        left: points(area.margin.left),
    }
}

/// `{ page, path }` of each image of the print's render (a contact sheet is reported at its first page).
fn html_pages(images: &[RenderedImage]) -> Vec<Value> {
    images
        .iter()
        .map(|image| match image {
            RenderedImage::Page(page) => json!({ "page": page.page, "path": page.path }),
            RenderedImage::Sheet(sheet) => json!({ "page": sheet.pages.first(), "path": sheet.path }),
        })
        .collect()
}

/// `{ level: 'warn', text }` of each note of the build and each warning of the data-charts.
fn logs_of(notes: &[String], chart_warnings: &[Value]) -> Vec<Value> {
    let notes = notes.iter().map(|note| json!({ "level": "warn", "text": note }));
    let warnings = chart_warnings.iter().map(|warning| {
        let mut log = Map::new();
        log.insert("level".into(), json!("warn"));
        if let Some(message) = warning.get("message") {
            log.insert("text".into(), message.clone());
        }
        Value::Object(log)
    });
    notes.chain(warnings).collect()
}

/// `mkdir(dirname(output), { recursive: true })` and `rm(output, { force: true })`.
async fn clear_output(tokens: &LaneTokens, output: &Path) -> Result<(), String> {
    let (parent, target) = (output.parent().filter(|parent| !parent.as_os_str().is_empty()).map(Path::to_path_buf), output.to_path_buf());
    tokens
        .durability_io
        .submit_wait(&CancellationToken::new(), move |lane| {
            if let Some(parent) = &parent {
                mixdog_fsio::create_dir_all(lane, parent).map_err(|error| format!("{}: {error}", parent.display()))?;
            }
            match mixdog_fsio::remove_file(lane, &target) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(format!("{}: {error}", target.display())),
            }
        })
        .await
        .map_err(|full| full.to_string())?
        .await
        .map_err(|dropped| dropped.to_string())?
}

/// Lays an HTML document out in the shared render browser, writes it to `output` as a native Word document and keeps the
/// HTML source and the browser's print of it beside `options.target`.
///
/// Answers `{ ok: true, output, bytes, kit: 'html', htmlSource, htmlPages, logs, elapsedMs }`, or `{ ok: false, error:
/// { message }, elapsedMs }` when the browser or the build failed; a cancellation is the only error. `registry` is the
/// font registry the page images of the print are drawn with; the ledger hears of each file the run writes.
pub async fn run_docx_html_authoring(
    endpoint: &dyn BrowserEndpoint,
    tokens: LaneTokens,
    registry: Arc<Registry>,
    note: Arc<dyn WriteNote>,
    html: &str,
    output: &Path,
    options: DocxRunOptions<'_>,
) -> Result<Value, RunError> {
    let DocxRunOptions { target, timeout, cancel } = options;
    let started_at = Instant::now();
    let artifacts = docx_html_artifacts(target);
    let lanes = AuthorLanes::new(tokens);
    clear_output(&tokens, output).await?;
    let (source, print) = (artifacts.source(), artifacts.print());
    let scratch = lanes.make_scratch_dir("mixdog-docx-captures-").await?;
    let measuring = DocxMeasureOptions { source_path: &source, print_path: &print, scratch: &scratch, timeout, cancel };
    let laid = measure_docx_html(endpoint, &lanes, &*note, html, measuring).await;
    let outcome = match laid {
        Ok(laid) => Ok(finish(tokens, &lanes, registry, note, output, &artifacts, &scratch, laid).await),
        Err(error) => Err(error),
    };
    lanes.remove_dir_all(&scratch).await;
    match outcome {
        Err(RunError::Cancelled) => Err(RunError::Cancelled),
        Err(RunError::Failed(message)) => Ok(html_failure(&message, started_at, None)),
        Ok(Err(message)) => Ok(html_failure(&message, started_at, None)),
        Ok(Ok(mut result)) => {
            result["elapsedMs"] = json!((started_at.elapsed().as_secs_f64() * 1000.0).round() as u64);
            Ok(result)
        }
    }
}

/// The half after the browser: the print's page images, the build and the write of the document.
async fn finish(
    tokens: LaneTokens,
    lanes: &AuthorLanes,
    registry: Arc<Registry>,
    note: Arc<dyn WriteNote>,
    output: &Path,
    artifacts: &DocxHtmlArtifacts,
    scratch: &Path,
    laid: DocxLayout,
) -> Result<Value, String> {
    // The images of the print are the reference the review compares against; a print that cannot be drawn leaves the
    // document without them rather than failing it.
    let printed = render_pdf_pages(tokens, Arc::clone(&registry), Arc::clone(&note), &artifacts.print(), RenderPagesOptions { max_width: COMPARE_WIDTH, ..RenderPagesOptions::default() }).await.ok();
    let mut inline = BTreeMap::new();
    for (index, picture) in inline_pictures(&laid.flow).into_iter().enumerate() {
        let path = scratch.join(format!("inline-{index}.{}", picture.extension));
        lanes.write_file(&path, picture.bytes).await?;
        inline.insert(picture.src, path);
    }
    let page = page_of(&laid.area);
    let (flow, captures, title) = (laid.flow, laid.captures, laid.title);
    let built = tokens
        .interactive_io
        .submit_wait(&CancellationToken::new(), move |lane| build_docx_from_flow(lane, &registry, &flow, &page, &captures, &inline, &title))
        .await
        .map_err(|full| full.to_string())?
        .await
        .map_err(|dropped| dropped.to_string())??;
    note.note_write(output);
    lanes.write_file(output, built.bytes.clone()).await?;
    Ok(json!({
        "ok": true,
        "output": output.display().to_string(),
        "bytes": built.bytes.len(),
        "kit": "html",
        "htmlSource": artifacts.source().display().to_string(),
        "htmlPages": html_pages(&printed.map(|printed| printed.images).unwrap_or_default()),
        "logs": logs_of(&built.notes, &laid.chart_warnings),
    }))
}

#[cfg(test)]
mod tests {
    use mixdog_office_pdf::render::PageImage;

    use super::*;
    use crate::pdf_print::Margins;
    use crate::pdf_print::Sheet;

    #[test]
    fn the_artifacts_sit_beside_the_document() {
        let artifacts = docx_html_artifacts(Path::new("out/report.docx"));
        assert_eq!(artifacts.source(), PathBuf::from("out/report.docx.mixdog-source.html"));
        assert_eq!(artifacts.print(), PathBuf::from("out/report.docx.mixdog-html.pdf"));
        assert_eq!(artifacts.compare(2), PathBuf::from("out/report.docx.mixdog-compare-page-2.png"));
    }

    #[test]
    fn the_word_page_is_the_sheet_in_points_to_two_places() {
        let area = PrintableArea { sheet: Sheet { width: 793.7007874, height: 1122.519685 }, margin: Margins { top: 75.59055118, right: 75.59055118, bottom: 75.59055118, left: 75.59055118 }, width: 642.5, height: 971.3 };
        assert_eq!(page_of(&area), DocxPage { width: 595.28, height: 841.89, top: 56.69, right: 56.69, bottom: 56.69, left: 56.69 });
    }

    #[test]
    fn the_logs_are_the_notes_then_the_chart_warnings() {
        let logs = logs_of(&["left out".to_owned()], &[json!({ "message": "no chart" }), json!({})]);
        assert_eq!(logs, vec![json!({ "level": "warn", "text": "left out" }), json!({ "level": "warn", "text": "no chart" }), json!({ "level": "warn" })]);
    }

    #[test]
    fn the_pages_of_the_print_are_listed_by_number_and_path() {
        let page = RenderedImage::Page(PageImage { page: 2, path: "a-page-2.png".into(), width: 1, height: 1, png: Vec::new() });
        assert_eq!(html_pages(&[page]), vec![json!({ "page": 2, "path": "a-page-2.png" })]);
        assert!(html_pages(&[]).is_empty());
    }

    #[test]
    fn the_options_carry_the_layout_deadline() {
        let options = DocxRunOptions::new(Path::new("a.docx"));
        assert_eq!(options.timeout, LAYOUT_TIMEOUT);
        assert!(!options.cancel.is_cancelled());
    }
}
