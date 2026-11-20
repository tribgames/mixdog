//! The `author` action's Excel input (`authoring/xlsx-html-runner.mjs`): lay the HTML's `<section data-sheet>` pages out in
//! the shared render browser, read each back as a grid (`measure_xlsx`), photograph the pictures and each section for the
//! review, and write the .xlsx (`xlsx_build`). The HTML source and the browser's picture of each sheet are kept beside the
//! workbook.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_fonts::registry::Registry;
use mixdog_js::value_to_string;
use mixdog_office_base::write_note::WriteNote;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use serde_json::Value;
use serde_json::json;

use crate::html_browser::AuthorLanes;
use crate::html_browser::HtmlBrowser;
use crate::html_browser::LAYOUT_TIMEOUT;
use crate::html_browser::RunError;
use crate::html_browser::html_failure;
use crate::html_browser::run_in_browser;
use crate::measure_xlsx::measure_xlsx_page;
use crate::page::Page;
use crate::page::Rect;
use crate::page::ScreenshotOptions;
use crate::page::page_function;
use crate::pdf_print::draw_data_charts;
use crate::xlsx_build::build_xlsx_from_sheets;

/// Runs inside the page: a chart whose `data-range` names table cells by id (`{mh}:{m9},{wh}:{w9}`, each area one column from
/// its header down, the first the categories) takes the labels and values those cells show, so the reference draws the chart
/// the workbook will; a chart with values of its own, or a range not written that way, is left alone.
const FILL_RANGE_CHARTS: &str = r##"function fillRangeCharts() {
  for (const element of document.querySelectorAll('[data-chart][data-range]')) {
    let spec;
    try {
      spec = JSON.parse(element.dataset.chart);
    } catch {
      continue;
    }
    if (spec.values || spec.series) continue;
    const columns = element.dataset.range.split(',').map((area) => {
      const ids = [...area.matchAll(/\{([A-Za-z][\w-]*)\}/g)].map((match) => document.getElementById(match[1]));
      const [from, to] = ids;
      if (ids.length !== 2 || !from || !to || from.cellIndex === undefined) return null;
      const table = from.closest('table');
      if (!table || table !== to.closest('table') || from.cellIndex !== to.cellIndex) return null;
      const rows = [...table.rows].slice(from.parentElement.rowIndex, to.parentElement.rowIndex + 1);
      return rows.map((row) => (row.cells[from.cellIndex]?.innerText || '').trim());
    });
    if (columns.length < 2 || columns.some((column) => !column || column.length !== columns[0].length)) continue;
    const number = (text) => Number(String(text).replace(/[^\d.-]/g, '')) || 0;
    const [labels, ...values] = columns;
    element.dataset.chart = JSON.stringify({
      ...spec,
      labels: labels.slice(1),
      ...(values.length === 1
        ? { values: values[0].slice(1).map(number) }
        : { series: values.map((column) => ({ name: column[0], values: column.slice(1).map(number) })) }),
    });
  }
}"##;

/// Runs inside the page: each section as the browser drew it, cut at its content (a data sheet's section runs the window's
/// width): its position and size.
const SECTION_EXTENTS: &str = r##"function sectionExtents() {
  return [...document.querySelectorAll('section[data-sheet]')].map((section) => {
    const box = section.getBoundingClientRect();
    const cs = getComputedStyle(section);
    let right = box.left;
    let bottom = box.top;
    for (const el of section.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    return {
      x: box.left + window.scrollX,
      y: box.top + window.scrollY,
      width: Math.min(box.width, right - box.left + (parseFloat(cs.paddingRight) || 0)),
      height: Math.min(box.height, bottom - box.top + (parseFloat(cs.paddingBottom) || 0)),
    };
  });
}"##;

/// Artifacts kept beside the workbook: its HTML and the browser's picture of each sheet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct XlsxHtmlArtifacts {
    target: PathBuf,
}

/// `xlsxHtmlArtifacts(target)`.
pub fn xlsx_html_artifacts(target: &Path) -> XlsxHtmlArtifacts {
    XlsxHtmlArtifacts { target: target.to_path_buf() }
}

impl XlsxHtmlArtifacts {
    fn beside(&self, suffix: &str) -> PathBuf {
        let mut name = self.target.as_os_str().to_os_string();
        name.push(suffix);
        PathBuf::from(name)
    }

    /// `<workbook>.mixdog-source.html`: the HTML as it was laid out.
    pub fn source(&self) -> PathBuf {
        self.beside(".mixdog-source.html")
    }

    /// `<workbook>.mixdog-html-sheet-<n>.png`: the browser's picture of sheet `n` (counted from 1).
    pub fn shot(&self, sheet: usize) -> PathBuf {
        self.beside(&format!(".mixdog-html-sheet-{sheet}.png"))
    }

    /// `<workbook>.mixdog-compare-page-<n>.png`: the HTML and the Excel render of page `n` side by side.
    pub fn compare(&self, page: usize) -> PathBuf {
        self.beside(&format!(".mixdog-compare-page-{page}.png"))
    }
}

/// How an Excel workbook is authored from HTML.
pub struct XlsxRunOptions<'a> {
    /// The workbook the artifacts are kept beside.
    pub target: &'a Path,
    pub timeout: Duration,
    pub cancel: CancellationToken,
}

impl<'a> XlsxRunOptions<'a> {
    /// The options of a plain workbook: the layout deadline and no cancellation.
    pub fn new(target: &'a Path) -> Self {
        Self { target, timeout: LAYOUT_TIMEOUT, cancel: CancellationToken::new() }
    }
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

/// What the browser gave: the sheets as a grid, the pictures' files, the pictures of the sections and the page's title.
struct Laid {
    measure: Value,
    captures: BTreeMap<usize, PathBuf>,
    html_pages: Vec<Value>,
    title: String,
}

/// The sections' own extents as clips.
fn clips_of(extents: &Value) -> Vec<Rect> {
    let number = |extent: &Value, key: &str| extent.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    extents
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|extent| Rect { x: number(extent, "x"), y: number(extent, "y"), width: number(extent, "width"), height: number(extent, "height") })
        .collect()
}

/// The work inside the browser: the sheets measured, then the reference each is held against (its section as the browser
/// drew it, cut at its content, with its charts drawn; a chart over its cells from the text those cells show).
async fn lay_out(page: &Page, lanes: &AuthorLanes, note: &dyn WriteNote, artifacts: &XlsxHtmlArtifacts, scratch: &Path) -> Result<Laid, String> {
    let measured = measure_xlsx_page(page, lanes, note, &artifacts.source(), scratch).await?;
    page.evaluate(&page_function(FILL_RANGE_CHARTS, "fillRangeCharts"), &[]).await?;
    draw_data_charts(page).await?;
    let extents = page.evaluate(&page_function(SECTION_EXTENTS, "sectionExtents"), &[]).await?;
    let mut html_pages = Vec::new();
    for (index, clip) in clips_of(&extents).into_iter().enumerate() {
        let path = artifacts.shot(index + 1);
        note.note_write(&path);
        let png = page.screenshot(ScreenshotOptions { clip: Some(clip), omit_background: false }).await?;
        lanes.write_file(&path, png).await?;
        html_pages.push(json!({ "page": index + 1, "path": path.display().to_string() }));
    }
    Ok(Laid { measure: measured.measure, captures: measured.captures, html_pages, title: page.title().await? })
}

/// Lays an HTML workbook out in the shared render browser, writes it to `output` as a native Excel workbook and keeps the
/// HTML source and the browser's picture of each sheet beside `options.target`.
///
/// Answers `{ ok: true, output, bytes, htmlSource, htmlPages, logs, elapsedMs }`, or `{ ok: false, error: { message },
/// elapsedMs }` when the browser or the build failed; a cancellation is the only error. `registry` is the font registry the
/// workbook batch measures in; the ledger hears of each file the run writes.
pub async fn run_xlsx_html_authoring(
    endpoint: &dyn BrowserEndpoint,
    tokens: LaneTokens,
    registry: Arc<Registry>,
    note: Arc<dyn WriteNote>,
    html: &str,
    output: &Path,
    options: XlsxRunOptions<'_>,
) -> Result<Value, RunError> {
    let XlsxRunOptions { target, timeout, cancel } = options;
    let started_at = Instant::now();
    let artifacts = xlsx_html_artifacts(target);
    let lanes = AuthorLanes::new(tokens);
    clear_output(&tokens, output).await?;
    lanes.write_file(&artifacts.source(), html.as_bytes().to_vec()).await?;
    let scratch = lanes.make_scratch_dir("mixdog-xlsx-captures-").await?;
    let outcome = run(endpoint, tokens, &lanes, registry, &*note, output, &artifacts, &scratch, timeout, &cancel).await;
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

/// The browser half and the build: the outer error is the browser's (a failure or the cancellation), the inner the build's.
#[allow(clippy::too_many_arguments)]
async fn run(
    endpoint: &dyn BrowserEndpoint,
    tokens: LaneTokens,
    lanes: &AuthorLanes,
    registry: Arc<Registry>,
    note: &dyn WriteNote,
    output: &Path,
    artifacts: &XlsxHtmlArtifacts,
    scratch: &Path,
    timeout: Duration,
    cancel: &CancellationToken,
) -> Result<Result<Value, String>, RunError> {
    let browser = HtmlBrowser::launch(endpoint).await?;
    let work = |browser: Arc<HtmlBrowser>| async move {
        let page = browser.new_page().await?;
        lay_out(&page, lanes, note, artifacts, scratch).await
    };
    let laid = run_in_browser(browser, cancel, timeout, work).await?;
    Ok(write_workbook(tokens, lanes, registry, note, output, artifacts, laid).await)
}

/// The build and the write of the workbook.
async fn write_workbook(
    tokens: LaneTokens,
    lanes: &AuthorLanes,
    registry: Arc<Registry>,
    note: &dyn WriteNote,
    output: &Path,
    artifacts: &XlsxHtmlArtifacts,
    laid: Laid,
) -> Result<Value, String> {
    let Laid { measure, captures, html_pages, title } = laid;
    let (sheets, captured) = (measure.clone(), captures);
    let built = tokens
        .interactive_io
        .submit_wait(&CancellationToken::new(), move |lane| build_xlsx_from_sheets(lane, &registry, &sheets, &captured, &title))
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
        "htmlSource": artifacts.source().display().to_string(),
        "htmlPages": html_pages,
        "logs": logs_of(&measure, &built.notes),
    }))
}

/// `{ level: 'warn', text }` of each note of the measure and then each note of the build.
fn logs_of(measure: &Value, build_notes: &[String]) -> Vec<Value> {
    let measured = measure.get("notes").and_then(Value::as_array).map_or(&[][..], Vec::as_slice).iter().map(value_to_string);
    measured.chain(build_notes.iter().cloned()).map(|text| json!({ "level": "warn", "text": text })).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_artifacts_sit_beside_the_workbook() {
        let artifacts = xlsx_html_artifacts(Path::new("out/report.xlsx"));
        assert_eq!(artifacts.source(), PathBuf::from("out/report.xlsx.mixdog-source.html"));
        assert_eq!(artifacts.shot(2), PathBuf::from("out/report.xlsx.mixdog-html-sheet-2.png"));
        assert_eq!(artifacts.compare(1), PathBuf::from("out/report.xlsx.mixdog-compare-page-1.png"));
    }

    #[test]
    fn the_page_functions_are_the_node_ones() {
        assert!(FILL_RANGE_CHARTS.starts_with("function fillRangeCharts() {") && FILL_RANGE_CHARTS.contains("[data-chart][data-range]"));
        assert!(SECTION_EXTENTS.starts_with("function sectionExtents() {") && SECTION_EXTENTS.contains("section[data-sheet]"));
    }

    #[test]
    fn the_logs_are_the_measure_notes_then_the_build_notes() {
        let measure = json!({ "sheets": [], "notes": ["left out"] });
        let logs = logs_of(&measure, &["{x} names no element with that id; it was left as written".to_owned()]);
        assert_eq!(
            logs,
            vec![
                json!({ "level": "warn", "text": "left out" }),
                json!({ "level": "warn", "text": "{x} names no element with that id; it was left as written" })
            ]
        );
        assert!(logs_of(&json!({}), &[]).is_empty());
    }

    #[test]
    fn a_section_extent_is_a_clip() {
        let clips = clips_of(&json!([{ "x": 8, "y": 16.5, "width": 900, "height": 390 }]));
        assert_eq!(clips, vec![Rect { x: 8.0, y: 16.5, width: 900.0, height: 390.0 }]);
        assert!(clips_of(&json!(null)).is_empty());
    }

    #[test]
    fn the_options_carry_the_layout_deadline() {
        let options = XlsxRunOptions::new(Path::new("a.xlsx"));
        assert_eq!(options.timeout, LAYOUT_TIMEOUT);
        assert!(!options.cancel.is_cancelled());
    }
}
