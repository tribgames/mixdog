//! The PDF route's print half (`authoring/pdf-html-runner.mjs`): a Chromium-family browser lays an HTML document out
//! under its own `@page` rules and prints it. Before printing, the document is laid out at the printable width and
//! read for what print would silently cut or move (a block wider than the page, a picture that never loaded), so the
//! file lands only when it holds. Designed pages (`section.slide` on the sheet) are measured and gated as a deck
//! first and printed here one page per sheet.
//!
//! The readings run inside the page: `readPageRule`, `measurePrintLayout` and `headingTitles` below, and
//! `drawDataCharts` (`assets/page/pdf-html-charts.js`), all taken over from the Node functions as they were. This
//! module is what Node did around them: the printable area from the `@page` rule, the frame canvas of designed pages,
//! the print, the repair of outline titles a `<br>` broke, and the document properties.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_js::is_js_space;
use mixdog_js::js_to_lowercase;
use mixdog_js::math::round as js_round;
use mixdog_pdf::Dict;
use mixdog_pdf::Guard;
use mixdog_pdf::Obj;
use mixdog_pdf::Ref;
use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::write::DocumentProperties;
use mixdog_pdf::write::LoadOptions;
use mixdog_pdf::write::PdfDocument;
use mixdog_pdf::write::SaveOptions;
use mixdog_pdf::write::decode_text_string;
use mixdog_pdf::write::encode_text_string;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::html_browser::AuthorLanes;
use crate::html_browser::HtmlBrowser;
use crate::html_browser::LAYOUT_TIMEOUT;
use crate::html_browser::RunError;
use crate::html_browser::html_failure;
use crate::html_browser::run_in_browser;
use crate::measure_deck::Canvas;
use crate::measure_deck::file_url;
use crate::measure_deck::inject_icons;
use crate::page::Page;
use crate::page::PdfOptions;
use crate::page::Viewport;
use crate::page::WaitUntil;
use crate::page::page_function;

/// The page functions `headingTitles`, `readPageRule` and `measurePrintLayout`.
const PRINT_SCRIPT: &str = r###"
// Runs inside the page: every h1-h3 as the browser names it in the outline (its text with the line
// breaks dropped) and as a reader sees it (a <br> read as a space).
function headingTitles() {
  return [...document.querySelectorAll('h1, h2, h3')].map((heading) => ({
    raw: heading.textContent || '',
    shown: (heading.innerText || '').replace(/\s+/g, ' ').trim(),
  }));
}

// Runs inside the page: the unnamed @page rules that apply to print, later declarations winning.
function readPageRule() {
  const out = { size: '', margin: {} };
  const visit = (list) => {
    for (const rule of list) {
      if (rule instanceof CSSPageRule && !rule.selectorText) {
        const size = rule.style.getPropertyValue('size');
        if (size) out.size = size;
        for (const side of ['top', 'right', 'bottom', 'left']) {
          const value = rule.style.getPropertyValue(`margin-${side}`);
          if (value) out.margin[side] = value;
        }
      } else if (rule instanceof CSSMediaRule && window.matchMedia(rule.conditionText).matches) {
        visit(rule.cssRules);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      visit(sheet.cssRules);
    } catch {}
  }
  return out;
}

// Runs inside the page, laid out at the printable width under print media.
// Errors refuse the document; warnings ride on the result. Designed pages
// are measured on their canvas before printing, so only their pictures are read here.
function measurePrintLayout(area, frame) {
  const describe = (element) => {
    const id = element.id ? `#${element.id}` : '';
    const className = typeof element.className === 'string' ? element.className.trim() : '';
    const classes = className ? `.${className.split(/\s+/).join('.')}` : '';
    const text = (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `<${element.localName}${id}${classes}>${text ? ` "${text}"` : ''}`;
  };
  const px = (value) => Math.round(value);
  const findings = [];
  for (const image of document.images) {
    const src = image.getAttribute('src') || '';
    if (/^(?:https?:)?\/\//i.test(src)) {
      findings.push({
        code: 'remote_image',
        severity: 'error',
        element: describe(image),
        message: `${src} is a web address; save the picture beside the document or inline it as a data: URI.`,
      });
    } else if (!image.complete || image.naturalWidth === 0) {
      findings.push({
        code: 'image_missing',
        severity: 'error',
        element: describe(image),
        message: `${src || '(no src)'} did not load; the path resolves from the PDF's folder.`,
      });
    }
  }
  if (frame) return { findings };
  const clipped = (element) => {
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX !== 'visible') return true;
    }
    return false;
  };
  const outside = (box) => box.right > area.width + 1 || box.left < -1;
  const tall = new Set();
  for (const element of document.body.querySelectorAll('*')) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.position === 'fixed') continue;
    const box = element.getBoundingClientRect();
    if (!box.width && !box.height) continue;
    const parent = element.parentElement;
    if (
      outside(box) &&
      !clipped(element) &&
      !(parent && parent !== document.body && outside(parent.getBoundingClientRect()))
    ) {
      findings.push({
        code: 'overflow_x',
        severity: 'error',
        element: describe(element),
        message: `spans ${px(box.left)}–${px(box.right)} px of a ${px(area.width)} px printable width; print cuts what lies past the margin.`,
      });
    }
    const unbreakable =
      ['img', 'svg', 'canvas', 'video'].includes(element.localName) ||
      ['avoid', 'avoid-page'].includes(style.breakInside);
    if (unbreakable && box.height > area.height + 1) {
      let ancestor = element.parentElement;
      while (ancestor && !tall.has(ancestor)) ancestor = ancestor.parentElement;
      tall.add(element);
      if (!ancestor) {
        findings.push({
          code: 'unbreakable_too_tall',
          severity: 'warning',
          element: describe(element),
          message: `is ${px(box.height)} px tall and may not break, but a page holds ${px(area.height)} px; print splits it anyway. Shorten it or let it break.`,
        });
      }
    }
  }
  return { findings };
}
"###;

/// The page function `drawDataCharts()`: every `[data-chart]` element filled with its SVG.
const CHARTS_SCRIPT: &str = include_str!("../assets/page/pdf-html-charts.js");

/// CSS px per unit (96 px to the inch).
fn px_per_unit(unit: &str) -> Option<f64> {
    Some(match unit {
        "px" => 1.0,
        "in" => 96.0,
        "cm" => 96.0 / 2.54,
        "mm" => 96.0 / 25.4,
        "q" => 96.0 / 101.6,
        "pt" => 96.0 / 72.0,
        "pc" => 16.0,
        _ => return None,
    })
}

/// The named sheets in millimetres, portrait.
fn named_sheet_mm(name: &str) -> Option<(f64, f64)> {
    Some(match name {
        "a3" => (297.0, 420.0),
        "a4" => (210.0, 297.0),
        "a5" => (148.0, 210.0),
        "b4" => (250.0, 353.0),
        "b5" => (176.0, 250.0),
        "letter" => (215.9, 279.4),
        "legal" => (215.9, 355.6),
        "ledger" => (279.4, 431.8),
        _ => return None,
    })
}

/// `/^(-?\d*\.?\d+)([a-z]+)?$/i` on `token`: the number and the unit letters.
fn split_length(token: &str) -> Option<(&str, &str)> {
    let at = token.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-')).unwrap_or(token.len());
    let (number, unit) = token.split_at(at);
    if !unit.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let digits = number.strip_prefix('-').unwrap_or(number);
    let valid = match digits.split_once('.') {
        Some((whole, fraction)) => !fraction.is_empty() && fraction.bytes().all(|b| b.is_ascii_digit()) && whole.bytes().all(|b| b.is_ascii_digit()),
        None => !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()),
    };
    valid.then_some((number, unit))
}

fn length_px(token: &str, what: &str) -> Result<f64, String> {
    let token = token.trim_matches(is_js_space);
    let not_a_length = || format!("@page {what} \"{token}\" is not a length; write it in mm, cm, in, pt, or px.");
    let (number, unit) = split_length(token).ok_or_else(not_a_length)?;
    let value: f64 = number.parse().map_err(|_| not_a_length())?;
    let unit = js_to_lowercase(unit);
    let unit = if unit.is_empty() && value == 0.0 { "px".to_string() } else { unit };
    let per_unit = px_per_unit(&unit).ok_or_else(not_a_length)?;
    Ok(value * per_unit)
}

/// A sheet in CSS px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sheet {
    pub width: f64,
    pub height: f64,
}

/// The margins of the sheet in CSS px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Margins {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// The printable area: the sheet, its margins and what lies between them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PrintableArea {
    pub sheet: Sheet,
    pub margin: Margins,
    pub width: f64,
    pub height: f64,
}

/// The printable area in CSS px from the `@page` size and margins the document declared (`{ size, margin: { top,
/// right, bottom, left } }`, as `readPageRule` reads them).
pub fn printable_area(rule: &Value) -> Result<PrintableArea, String> {
    let size = rule["size"].as_str().unwrap_or_default();
    let lowered = js_to_lowercase(size);
    let tokens: Vec<&str> = lowered.split(is_js_space).filter(|token| !token.is_empty()).collect();
    if tokens.is_empty() || tokens[0] == "auto" {
        return Err("The document declares no @page size; open the stylesheet with `@page { size: A4; margin: 18mm }` (or letter, A5 landscape, 148mm 210mm)."
            .to_string());
    }
    let mut landscape = false;
    let mut lengths = Vec::new();
    let mut named = None;
    for token in &tokens {
        if *token == "landscape" {
            landscape = true;
        } else if *token == "portrait" {
            landscape = false;
        } else if let Some((width, height)) = named_sheet_mm(token) {
            named = Some((width * (96.0 / 25.4), height * (96.0 / 25.4)));
        } else {
            lengths.push(length_px(token, "size")?);
        }
    }
    let (mut width, mut height) = match named {
        Some(sheet) => sheet,
        None => match lengths.first() {
            Some(first) => (*first, lengths.get(1).copied().unwrap_or(*first)),
            None => return Err(format!("@page size \"{size}\" names no sheet.")),
        },
    };
    if !(width > 0.0 && height > 0.0) {
        return Err(format!("@page size \"{size}\" names no sheet."));
    }
    if named.is_some() && landscape {
        std::mem::swap(&mut width, &mut height);
    }
    let side = |name: &str| -> Result<f64, String> {
        match rule["margin"][name].as_str() {
            Some(value) if !value.is_empty() => length_px(value, &format!("margin-{name}")),
            _ => Ok(0.0),
        }
    };
    let margin = Margins { top: side("top")?, right: side("right")?, bottom: side("bottom")?, left: side("left")? };
    Ok(PrintableArea { sheet: Sheet { width, height }, margin, width: width - margin.left - margin.right, height: height - margin.top - margin.bottom })
}

/// The unnamed `@page` rules that apply to print, later declarations winning: `{ size, margin }`.
pub async fn read_page_rule(page: &Page) -> Result<Value, String> {
    page.evaluate(&page_function(PRINT_SCRIPT, "readPageRule"), &[]).await
}

/// The printable area of the page the browser has loaded.
pub async fn read_printable_area(page: &Page) -> Result<PrintableArea, String> {
    printable_area(&read_page_rule(page).await?)
}

/// The canvas of a PDF's designed pages (the deck contract): the sheet the document declares, printed full-bleed, in
/// CSS px at 96 to the inch. Runs on the page the measure has loaded.
pub async fn frame_canvas(page: &Page) -> Result<Canvas, String> {
    page.emulate_media_type("print").await?;
    let area = read_printable_area(page).await?;
    let margins = area.margin;
    if [margins.top, margins.right, margins.bottom, margins.left].iter().any(|margin| *margin > 0.5) {
        return Err("Designed pages print full-bleed: declare `@page { size: A4; margin: 0 }` and give each section.slide the whole sheet (width: 210mm; height: 297mm), with the margins inside it.".to_string());
    }
    // The viewport takes whole px; the working deck is sized from those same px so 1 px stays exactly 0.75 pt (A4's
    // 793.7 px rounded to 794 is 0.2 pt wider, and a 22 pt title stays 22 pt).
    let width = js_round(area.sheet.width);
    let height = js_round(area.sheet.height);
    Ok(Canvas { width: width as u32, height: height as u32, inch_width: width / 96.0, inch_height: height / 96.0 })
}

/// The viewport of the printable width: the sheet between its margins, in whole px.
pub fn printable_viewport(area: &PrintableArea, device_scale_factor: f64) -> Viewport {
    Viewport { width: js_round(area.width) as u32, height: js_round(area.height) as u32, device_scale_factor }
}

/// What `drawDataCharts` did: the charts drawn and the warnings of those it could not draw.
#[derive(Clone, Debug, PartialEq)]
pub struct Charts {
    pub drawn: u64,
    pub warnings: Vec<Value>,
}

/// Fills every `[data-chart]` element with its SVG, at the size print lays it out.
pub async fn draw_data_charts(page: &Page) -> Result<Charts, String> {
    let drawn = page.evaluate(&page_function(CHARTS_SCRIPT, "drawDataCharts"), &[]).await?;
    Ok(Charts { drawn: drawn["drawn"].as_u64().unwrap_or(0), warnings: drawn["warnings"].as_array().cloned().unwrap_or_default() })
}

/// Designed pages print one `section.slide` per sheet whatever the screen CSS does; speaker notes stay off the page.
const FRAME_PRINT_CSS: &str =
    "section.slide { break-after: page; break-inside: avoid; }\nsection.slide:last-of-type { break-after: auto; }\naside.notes { display: none !important; }";

/// The HTML as laid out, kept beside the PDF so relative `<img>` paths resolve and a re-author starts from it.
pub fn pdf_html_source_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_os_string();
    name.push(".mixdog-source.html");
    PathBuf::from(name)
}

/// A heading as the browser names it in the outline (its text with the line breaks dropped) and as a reader sees it
/// (a `<br>` read as a space).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Heading {
    pub raw: String,
    pub shown: String,
}

async fn heading_titles(page: &Page) -> Result<Vec<Heading>, String> {
    let read = page.evaluate(&page_function(PRINT_SCRIPT, "headingTitles"), &[]).await?;
    Ok(read
        .as_array()
        .map(|headings| {
            headings
                .iter()
                .map(|heading| Heading {
                    raw: heading["raw"].as_str().unwrap_or_default().to_string(),
                    shown: heading["shown"].as_str().unwrap_or_default().to_string(),
                })
                .collect()
        })
        .unwrap_or_default())
}

fn key_of(text: &str) -> String {
    text.chars().filter(|c| !is_js_space(*c)).collect()
}

/// The browser names a bookmark after its heading's text with the line breaks dropped, so a title set on two lines
/// reads without its space. Each such outline entry takes the heading as shown. Returns how many titles changed.
/// Entries are followed along `First` and `Next` through the references the browser writes them with.
pub fn repair_outline_titles(document: &mut PdfDocument, headings: &[Heading]) -> usize {
    let mut shown = HashMap::new();
    for heading in headings.iter().filter(|heading| !heading.shown.is_empty()) {
        shown.insert(key_of(&heading.raw), heading.shown.as_str());
    }
    let mut fixes: Vec<(Ref, String)> = Vec::new();
    {
        let store = document.store();
        let reference = |dict: &Dict, key: &str| -> Option<Ref> {
            match dict.get_raw(key)? {
                Obj::Ref(target) if store.dict(*target).is_some() => Some(*target),
                _ => None,
            }
        };
        let Some(catalog) = document.catalog_ref().and_then(|root| store.dict(root)) else { return 0 };
        let Some(outlines) = store.lookup(catalog, "Outlines").and_then(Obj::as_dict) else { return 0 };
        let mut stack: Vec<Ref> = reference(outlines, "First").into_iter().collect();
        let mut seen = HashSet::new();
        while let Some(start) = stack.pop() {
            let mut node = Some(start);
            while let Some(current) = node {
                if !seen.insert(current) {
                    break;
                }
                let Some(dict) = store.dict(current) else { break };
                let text = match dict.get_raw("Title") {
                    Some(Obj::Str(bytes)) => decode_text_string(bytes),
                    _ => String::new(),
                };
                if let Some(fixed) = shown.get(key_of(&text).as_str())
                    && *fixed != text
                {
                    fixes.push((current, (*fixed).to_string()));
                }
                if let Some(child) = reference(dict, "First") {
                    stack.push(child);
                }
                node = reference(dict, "Next");
            }
        }
    }
    let changed = fixes.len();
    for (node, title) in fixes {
        document.store_mut().modify_dict(node, |dict| dict.set("Title", Obj::Str(Arc::from(encode_text_string(&title)))));
    }
    changed
}

/// How a document is printed.
pub struct PrintOptions<'a> {
    /// Where the HTML is written before loading (beside the PDF, so relative `<img>` paths resolve).
    pub source_path: &'a Path,
    pub properties: DocumentProperties,
    /// Designed pages (`section.slide` on the sheet, already measured): one page per sheet, icons drawn.
    pub frame: bool,
    pub timeout: Duration,
    pub cancel: CancellationToken,
}

impl<'a> PrintOptions<'a> {
    /// The options of a plain document: no properties, the layout deadline and no cancellation.
    pub fn new(source_path: &'a Path) -> Self {
        Self { source_path, properties: DocumentProperties::default(), frame: false, timeout: LAYOUT_TIMEOUT, cancel: CancellationToken::new() }
    }
}

/// What the browser printed, before the PDF is read back.
struct Printed {
    area: PrintableArea,
    headings: Vec<Heading>,
    charts: u64,
    warnings: Vec<Value>,
    pdf: Vec<u8>,
}

/// The browser's work: `Err(findings)` is a layout the check refused.
async fn lay_out_and_print(browser: Arc<HtmlBrowser>, source_path: &Path, frame: bool) -> Result<Result<Printed, Vec<Value>>, String> {
    let page = browser.new_page().await?;
    page.emulate_media_type("print").await?;
    page.goto(&file_url(source_path)?, WaitUntil::Load).await?;
    let area = read_printable_area(&page).await?;
    if frame {
        // The names the icon set does not have are left as they are; the print route does not report them.
        inject_icons(&page).await?;
        page.add_style_tag(FRAME_PRINT_CSS).await?;
    }
    page.set_viewport(printable_viewport(&area, 1.0)).await?;
    page.evaluate_expression("document.fonts.ready.then(() => true)").await?;
    // Charts are drawn at the size print lays them out, before the layout is read for what print would cut.
    let charts = draw_data_charts(&page).await?;
    let measured =
        page.evaluate(&page_function(PRINT_SCRIPT, "measurePrintLayout"), &[json!({ "width": area.width, "height": area.height }), json!(frame)]).await?;
    let findings = measured["findings"].as_array().cloned().unwrap_or_default();
    let (errors, rest): (Vec<Value>, Vec<Value>) = findings.into_iter().partition(|finding| finding["severity"] == "error");
    if !errors.is_empty() {
        return Ok(Err(errors));
    }
    let headings = heading_titles(&page).await?;
    let options = PdfOptions { prefer_css_page_size: true, print_background: true, tagged: true, outline: true, ..PdfOptions::default() };
    let pdf = page.pdf(&options).await?;
    let mut warnings = charts.warnings;
    warnings.extend(rest);
    Ok(Ok(Printed { area, headings, charts: charts.drawn, warnings, pdf }))
}

/// `rm(path, { force: true })`: a file that is not there is not an error.
async fn remove_file(tokens: &LaneTokens, path: &Path) -> Result<(), String> {
    let target = path.to_path_buf();
    tokens
        .durability_io
        .submit_wait(&CancellationToken::new(), move |lane| match mixdog_fsio::remove_file(lane, &target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("{}: {error}", target.display())),
        })
        .await
        .map_err(|full| full.to_string())?
        .await
        .map_err(|dropped| dropped.to_string())?
}

fn load_options() -> LoadOptions {
    LoadOptions { ignore_encryption: false, filters: Arc::new(CodecFilters), guard: Guard::unbounded() }
}

/// Lays out and prints an HTML document to `output` (a staging file beside the target).
///
/// Answers `{ ok: true, output, bytes, pageCount, area, charts?, warnings, elapsedMs }`, or `{ ok: false, error }` when
/// the browser failed, or `{ ok: false, error, layout }` when the layout check refused the document; a cancellation
/// is the only error.
pub async fn print_html_pdf(
    endpoint: &dyn BrowserEndpoint,
    tokens: LaneTokens,
    html: &str,
    output: &Path,
    options: PrintOptions<'_>,
) -> Result<Value, RunError> {
    let PrintOptions { source_path, properties, frame, timeout, cancel } = options;
    let started_at = Instant::now();
    let lanes = AuthorLanes::new(tokens);
    lanes.write_file(source_path, html.as_bytes().to_vec()).await?;
    remove_file(&tokens, output).await?;
    let browser = match HtmlBrowser::launch(endpoint).await {
        Ok(browser) => browser,
        Err(message) => return Ok(html_failure(&message, started_at, None)),
    };
    let work = |browser: Arc<HtmlBrowser>| lay_out_and_print(browser, source_path, frame);
    let printed = match run_in_browser(browser, &cancel, timeout, work).await {
        Ok(Ok(printed)) => printed,
        Ok(Err(refused)) => {
            let mut extra = Map::new();
            extra.insert("layout".into(), Value::Array(refused));
            return Ok(html_failure("layout check refused the document", started_at, Some(extra)));
        }
        Err(RunError::Cancelled) => return Err(RunError::Cancelled),
        Err(RunError::Failed(message)) => return Ok(html_failure(&message, started_at, None)),
    };
    // Like Node, the printed file is read back as a PDF: one the browser wrote that cannot be read is a failure.
    let mut document = match PdfDocument::load(printed.pdf.clone(), &load_options()) {
        Ok(document) => document,
        Err(error) => return Ok(html_failure(&error.to_string(), started_at, None)),
    };
    let described = properties.title.is_some() || properties.author.is_some() || properties.subject.is_some() || properties.keywords.is_some();
    if described {
        document.apply_document_properties(&properties);
    }
    let repaired = repair_outline_titles(&mut document, &printed.headings) > 0;
    let bytes = if repaired || described { document.save(SaveOptions::default()) } else { printed.pdf };
    lanes.write_file(output, bytes.clone()).await?;
    let mut result = Map::new();
    result.insert("ok".into(), json!(true));
    result.insert("output".into(), json!(output.display().to_string()));
    result.insert("bytes".into(), json!(bytes.len()));
    result.insert("pageCount".into(), json!(document.page_count()));
    result.insert("area".into(), json!({ "width": js_round(printed.area.width), "height": js_round(printed.area.height) }));
    if printed.charts != 0 {
        result.insert("charts".into(), json!(printed.charts));
    }
    result.insert("warnings".into(), Value::Array(printed.warnings));
    result.insert("elapsedMs".into(), json!((started_at.elapsed().as_secs_f64() * 1000.0).round() as u64));
    Ok(Value::Object(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(size: &str, margin: &[(&str, &str)]) -> Value {
        let mut margins = Map::new();
        for (side, value) in margin {
            margins.insert((*side).to_string(), json!(value));
        }
        json!({ "size": size, "margin": margins })
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn a_named_sheet_is_its_millimetres_in_css_pixels() {
        let area = printable_area(&rule("A4", &[])).unwrap();
        assert!(close(area.sheet.width, 210.0 * 96.0 / 25.4) && close(area.sheet.height, 297.0 * 96.0 / 25.4));
        assert_eq!((area.margin.top, area.width), (0.0, area.sheet.width));
    }

    #[test]
    fn landscape_turns_a_named_sheet_and_the_margins_come_off_each_side() {
        let area = printable_area(&rule("a5 landscape", &[("top", "10mm"), ("right", "0.5in"), ("bottom", "10mm"), ("left", "12pt")])).unwrap();
        assert!(close(area.sheet.width, 210.0 * 96.0 / 25.4) && close(area.sheet.height, 148.0 * 96.0 / 25.4));
        assert!(close(area.width, area.sheet.width - 48.0 - 16.0));
        assert!(close(area.height, area.sheet.height - 2.0 * 10.0 * 96.0 / 25.4));
    }

    #[test]
    fn lengths_name_a_sheet_and_one_length_is_a_square() {
        let two = printable_area(&rule("148mm 210mm", &[])).unwrap();
        assert!(close(two.sheet.width, 148.0 * 96.0 / 25.4) && close(two.sheet.height, 210.0 * 96.0 / 25.4));
        let one = printable_area(&rule("600px", &[])).unwrap();
        assert_eq!((one.sheet.width, one.sheet.height), (600.0, 600.0));
        assert_eq!(printable_area(&rule("0 10px", &[])).unwrap_err(), "@page size \"0 10px\" names no sheet.");
    }

    #[test]
    fn a_missing_size_and_a_bad_length_are_refused_with_the_sentences_node_threw() {
        let missing =
            "The document declares no @page size; open the stylesheet with `@page { size: A4; margin: 18mm }` (or letter, A5 landscape, 148mm 210mm).";
        assert_eq!(printable_area(&rule("", &[])).unwrap_err(), missing);
        assert_eq!(printable_area(&rule("auto", &[])).unwrap_err(), missing);
        assert_eq!(printable_area(&rule("12 5mm", &[])).unwrap_err(), "@page size \"12\" is not a length; write it in mm, cm, in, pt, or px.");
        assert_eq!(printable_area(&rule("landscape", &[])).unwrap_err(), "@page size \"landscape\" names no sheet.");
        assert_eq!(
            printable_area(&rule("A4", &[("left", "2furlong")])).unwrap_err(),
            "@page margin-left \"2furlong\" is not a length; write it in mm, cm, in, pt, or px."
        );
    }

    #[test]
    fn a_zero_without_a_unit_is_a_length_and_the_number_forms_are_the_regular_expressions() {
        assert_eq!(length_px("0", "size").unwrap(), 0.0);
        assert!(close(length_px(".5in", "size").unwrap(), 48.0));
        assert!(close(length_px("-1.5MM", "size").unwrap(), -1.5 * 96.0 / 25.4));
        assert!(close(length_px("1q", "size").unwrap(), 96.0 / 101.6));
        assert!(length_px("5.mm", "size").is_err());
        assert!(length_px("1e3px", "size").is_err());
        assert!(length_px("--1px", "size").is_err());
        assert!(length_px("", "size").is_err());
    }

    #[test]
    fn the_source_is_kept_beside_the_pdf() {
        assert_eq!(pdf_html_source_path(Path::new("out/report.pdf")), PathBuf::from("out/report.pdf.mixdog-source.html"));
    }

    #[test]
    fn the_printable_viewport_is_whole_pixels() {
        let area = printable_area(&rule("A4", &[("left", "20mm"), ("right", "20mm"), ("top", "20mm"), ("bottom", "20mm")])).unwrap();
        let viewport = printable_viewport(&area, 2.0);
        assert_eq!((viewport.width, viewport.height, viewport.device_scale_factor), (643, 971, 2.0));
    }

    fn outline_document(titles: &[&str]) -> PdfDocument {
        let mut document = PdfDocument::create();
        document.add_page(100.0, 100.0).unwrap();
        let entries: Vec<_> = titles.iter().map(|title| mixdog_pdf::write::outline::OutlineEntry { title: (*title).to_string(), page_index: 0 }).collect();
        document.add_outline_entries(&entries).unwrap();
        document
    }

    #[test]
    fn a_title_the_browser_ran_together_takes_the_heading_as_shown() {
        let mut document = outline_document(&["틀로설계하고", "결론", "Other"]);
        let headings = [
            Heading { raw: "틀로\n설계하고".into(), shown: "틀로 설계하고".into() },
            Heading { raw: "결론".into(), shown: "결론".into() },
            Heading { raw: "empty".into(), shown: String::new() },
        ];
        assert_eq!(repair_outline_titles(&mut document, &headings), 1);
        let titles: Vec<String> = document.outline_items().into_iter().map(|item| item.title).collect();
        assert_eq!(titles, ["틀로 설계하고", "결론", "Other"]);
        assert_eq!(repair_outline_titles(&mut document, &headings), 0);
    }

    #[test]
    fn a_document_with_no_outline_has_nothing_to_repair() {
        let mut document = PdfDocument::create();
        document.add_page(100.0, 100.0).unwrap();
        assert_eq!(repair_outline_titles(&mut document, &[Heading { raw: "a".into(), shown: "a b".into() }]), 0);
    }

    #[test]
    fn the_page_scripts_hold_the_functions_the_print_calls() {
        for name in ["function headingTitles()", "function readPageRule()", "function measurePrintLayout(area, frame)"] {
            assert!(PRINT_SCRIPT.contains(name), "{name}");
        }
        assert!(CHARTS_SCRIPT.contains("function drawDataCharts()"));
        assert!(!PRINT_SCRIPT.contains("export ") && !CHARTS_SCRIPT.contains("export "));
    }
}
