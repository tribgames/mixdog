//! The Excel HTML route, first half (`authoring/xlsx-html-measure.mjs` and the measuring half of
//! `authoring/xlsx-html-runner.mjs`): each `<section data-sheet="name">` is one worksheet the browser lays out, and the
//! page function `extractXlsxSheets` (`assets/page/xlsx-html-measure.js`, taken over as it was) reads it back as what
//! a grid can hold: every text (a title, a card's figure and label, a table cell) with its box, type, alignment and
//! value or formula; every filled or ruled box; charts and pictures by their boxes. The workbook builder turns the
//! distinct edges of those boxes into the sheet's columns and rows.
//!
//! This module is what Node did around the page function: the viewport, the offline icons, and the photograph of
//! each picture. The reference screenshots of the sheets (the charts drawn over their cells, the sheets cut at their
//! content) belong to the workbook route that holds them against the workbook.

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
use crate::page::Viewport;
use crate::page::WaitUntil;
use crate::page::page_function;

/// The page function `extractXlsxSheets()`.
const PAGE_SCRIPT: &str = include_str!("../assets/page/xlsx-html-measure.js");

/// The window the sheets are laid out in, at twice the density.
pub const SHEET_VIEWPORT: Viewport = Viewport { width: 1920, height: 1200, device_scale_factor: 2.0 };

/// What the browser drew.
#[derive(Clone, Debug, PartialEq)]
pub struct XlsxMeasure {
    /// `{ sheets, notes, captures }` as `extractXlsxSheets` reads them.
    pub measure: Value,
    /// Capture number (as the measure counts them) to the photograph of its element.
    pub captures: BTreeMap<usize, PathBuf>,
}

/// Reads the loaded document as worksheets: the page function's answer.
pub async fn extract_xlsx_sheets(page: &Page) -> Result<Value, String> {
    page.evaluate(&page_function(PAGE_SCRIPT, "extractXlsxSheets"), &[]).await
}

/// Loads `source_path` in the page, lays its sheets out and reads them back, then photographs each picture into
/// `scratch`.
pub async fn measure_xlsx_page(page: &Page, lanes: &AuthorLanes, note: &dyn WriteNote, source_path: &Path, scratch: &Path) -> Result<XlsxMeasure, String> {
    page.set_viewport(SHEET_VIEWPORT).await?;
    page.goto(&file_url(source_path)?, WaitUntil::Load).await?;
    inject_icons(page).await?;
    page.evaluate_expression("document.fonts.ready.then(() => true)").await?;
    let measure = extract_xlsx_sheets(page).await?;
    let count = measure["captures"].as_u64().unwrap_or(0) as usize;
    let captures = photograph_captures(page, lanes, note, "data-xlsx-capture", count, scratch).await?;
    Ok(XlsxMeasure { measure, captures })
}

/// Where the sheets' HTML is written and how long the layout may take.
pub struct XlsxMeasureOptions<'a> {
    /// Where the HTML is written before loading (beside the workbook, so relative `<img>` paths resolve).
    pub source_path: &'a Path,
    /// An empty folder the photographs of the pictures are written in.
    pub scratch: &'a Path,
    pub timeout: Duration,
    pub cancel: CancellationToken,
}

impl<'a> XlsxMeasureOptions<'a> {
    /// The options of a plain workbook: the layout deadline and no cancellation.
    pub fn new(source_path: &'a Path, scratch: &'a Path) -> Self {
        Self { source_path, scratch, timeout: LAYOUT_TIMEOUT, cancel: CancellationToken::new() }
    }
}

/// Lays an HTML workbook out in the shared render browser and reads its sheets. The browser is leased for the run and
/// closed on every exit.
pub async fn measure_xlsx_html(endpoint: &dyn BrowserEndpoint, lanes: &AuthorLanes, note: &dyn WriteNote, html: &str, options: XlsxMeasureOptions<'_>) -> Result<XlsxMeasure, RunError> {
    let XlsxMeasureOptions { source_path, scratch, timeout, cancel } = options;
    lanes.write_file(source_path, html.as_bytes().to_vec()).await?;
    let browser = HtmlBrowser::launch(endpoint).await?;
    let work = |browser: std::sync::Arc<HtmlBrowser>| async move {
        let page = browser.new_page().await?;
        measure_xlsx_page(&page, lanes, note, source_path, scratch).await
    };
    run_in_browser(browser, &cancel, timeout, work).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_script_is_the_node_function() {
        assert!(PAGE_SCRIPT.contains("function extractXlsxSheets() {"));
        assert!(PAGE_SCRIPT.contains("section[data-sheet]"));
        assert!(!PAGE_SCRIPT.contains("export "));
    }

    #[test]
    fn the_sheets_are_laid_out_in_a_1920_by_1200_window_at_twice_the_density() {
        assert_eq!((SHEET_VIEWPORT.width, SHEET_VIEWPORT.height, SHEET_VIEWPORT.device_scale_factor), (1920, 1200, 2.0));
    }

    #[test]
    fn the_options_carry_the_layout_deadline() {
        let options = XlsxMeasureOptions::new(Path::new("a.html"), Path::new("scratch"));
        assert_eq!(options.timeout, LAYOUT_TIMEOUT);
    }
}
