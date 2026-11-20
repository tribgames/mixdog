//! The Word HTML route, first half (`authoring/docx-html-measure.mjs` and the layout half of
//! `authoring/docx-html-runner.mjs`): the browser lays the document out at the printable width of its `@page` sheet
//! and the page function `extractDocxFlow` (`assets/page/docx-html-measure.js`, taken over as it was) reads it back as
//! Word's own flow: paragraphs with their runs, tables (data tables, and the flex or grid rows a layout draws, as
//! borderless tables), boxes (a filled or bordered block, as a one-cell table), lists, pictures, and the vertical
//! space between blocks as the browser measured it. The Word writer turns the flow into WordprocessingML.
//!
//! This module is what Node did around the page function: the viewport of the text column, the offline icons, the
//! data-charts, one photograph of each picture Word cannot draw as text (an SVG, a chart, a canvas), and the print of
//! the same HTML that the review holds the Word render against.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_office_base::write_note::WriteNote;
use mixdog_rt::CancellationToken;
use serde_json::Value;

use crate::html_browser::AuthorLanes;
use crate::html_browser::HtmlBrowser;
use crate::html_browser::LAYOUT_TIMEOUT;
use crate::html_browser::RunError;
use crate::html_browser::photograph_captures;
use crate::html_browser::run_in_browser;
use crate::measure_deck::file_url;
use crate::measure_deck::inject_icons;
use crate::page::Page;
use crate::page::PdfOptions;
use crate::page::WaitUntil;
use crate::page::page_function;
use crate::pdf_print::PrintableArea;
use crate::pdf_print::draw_data_charts;
use crate::pdf_print::printable_viewport;
use crate::pdf_print::read_printable_area;

/// The page function `extractDocxFlow()`.
const PAGE_SCRIPT: &str = include_str!("../assets/page/docx-html-measure.js");

/// The style that makes the body the page's text column: as wide as the sheet between its margins, from the top of
/// that column.
const COLUMN_CSS: &str = "html, body { margin: 0 !important; }";

/// Where the document's artifacts are written and how long the layout may take.
pub struct DocxMeasureOptions<'a> {
    /// Where the HTML is written before loading (beside the document, so relative `<img>` paths resolve).
    pub source_path: &'a Path,
    /// Where the browser's print of the HTML is written: the reference the review holds the Word render against.
    pub print_path: &'a Path,
    /// An empty folder the photographs of the pictures are written in.
    pub scratch: &'a Path,
    pub timeout: Duration,
    pub cancel: CancellationToken,
}

impl<'a> DocxMeasureOptions<'a> {
    /// The options of a plain document: the layout deadline and no cancellation.
    pub fn new(source_path: &'a Path, print_path: &'a Path, scratch: &'a Path) -> Self {
        Self { source_path, print_path, scratch, timeout: LAYOUT_TIMEOUT, cancel: CancellationToken::new() }
    }
}

/// What the browser drew.
#[derive(Clone, Debug, PartialEq)]
pub struct DocxLayout {
    /// The sheet and margins the document declared, in CSS px.
    pub area: PrintableArea,
    /// `{ blocks, header, footer, body, notes, captures }` as `extractDocxFlow` reads them.
    pub flow: Value,
    /// Capture number (as the flow counts them) to the photograph of its element.
    pub captures: BTreeMap<usize, PathBuf>,
    /// The warnings of the data-charts that could not be drawn.
    pub chart_warnings: Vec<Value>,
    pub title: String,
}

/// Reads the loaded document as Word's flow: the page function's answer.
pub async fn extract_docx_flow(page: &Page) -> Result<Value, String> {
    page.evaluate(&page_function(PAGE_SCRIPT, "extractDocxFlow"), &[]).await
}

/// Lays out the document the page has loaded (`source_path`) and reads it back. The page prints with the `print`
/// media afterwards, so it must not be used for anything that reads the screen layout once this has run.
pub async fn measure_docx_page(
    page: &Page,
    lanes: &AuthorLanes,
    note: &dyn WriteNote,
    source_path: &Path,
    print_path: &Path,
    scratch: &Path,
) -> Result<DocxLayout, String> {
    page.goto(&file_url(source_path)?, WaitUntil::Load).await?;
    let area = read_printable_area(page).await?;
    // The body is the page's text column: as wide as the sheet between its margins, from the top of that column.
    page.set_viewport(printable_viewport(&area, 2.0)).await?;
    page.add_style_tag(COLUMN_CSS).await?;
    inject_icons(page).await?;
    let charts = draw_data_charts(page).await?;
    page.evaluate_expression("document.fonts.ready.then(() => true)").await?;
    let flow = extract_docx_flow(page).await?;
    let count = flow["captures"].as_u64().unwrap_or(0) as usize;
    let captures = photograph_captures(page, lanes, note, "data-docx-capture", count, scratch).await?;
    // The reference the review holds the Word render against: the same HTML as print lays it out.
    page.emulate_media_type("print").await?;
    let printed = page.pdf(&PdfOptions { prefer_css_page_size: true, print_background: true, ..PdfOptions::default() }).await?;
    lanes.write_file(print_path, printed).await?;
    let title = page.title().await?;
    Ok(DocxLayout { area, flow, captures, chart_warnings: charts.warnings, title })
}

/// Lays an HTML document out in the shared render browser and reads it as Word's flow. The browser is leased for the
/// run and closed on every exit.
pub async fn measure_docx_html(
    endpoint: &dyn BrowserEndpoint,
    lanes: &AuthorLanes,
    note: &dyn WriteNote,
    html: &str,
    options: DocxMeasureOptions<'_>,
) -> Result<DocxLayout, RunError> {
    let DocxMeasureOptions { source_path, print_path, scratch, timeout, cancel } = options;
    lanes.write_file(source_path, html.as_bytes().to_vec()).await?;
    let browser = HtmlBrowser::launch(endpoint).await?;
    let work = |browser: std::sync::Arc<HtmlBrowser>| async move {
        let page = browser.new_page().await?;
        measure_docx_page(&page, lanes, note, source_path, print_path, scratch).await
    };
    run_in_browser(browser, &cancel, timeout, work).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_script_is_the_node_function() {
        assert!(PAGE_SCRIPT.contains("function extractDocxFlow() {"));
        assert!(PAGE_SCRIPT.contains("data-docx-capture"));
        assert!(!PAGE_SCRIPT.contains("export "));
    }

    #[test]
    fn the_body_is_the_text_column() {
        assert_eq!(COLUMN_CSS, "html, body { margin: 0 !important; }");
    }

    #[test]
    fn the_options_carry_the_layout_deadline() {
        let options = DocxMeasureOptions::new(Path::new("a.html"), Path::new("a.pdf"), Path::new("scratch"));
        assert_eq!(options.timeout, LAYOUT_TIMEOUT);
        assert!(!options.cancel.is_cancelled());
    }
}
