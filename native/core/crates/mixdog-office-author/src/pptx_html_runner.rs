//! The `author` action's HTML input (`authoring/pptx-html-runner.mjs`): lay the deck out in the shared render browser,
//! read it back, write native PowerPoint objects, and keep the browser's page images so the review can hold the PPTX
//! render against what the HTML intended.
//!
//! [`run_pptx_html_authoring`] measures (`measure_deck`), builds (`pptx_build`), normalises the written package
//! (`normalize`) and answers the run's result, with the text the browser drew at each item (`htmlText`) for the drift
//! read. [`measure_html_drift`] holds the PowerPoint render of a page against the browser's shot of it, item by item;
//! [`write_html_comparisons`] writes the two side by side. The brief an HTML deck opens with is read by
//! `brief::html_brief_script`.

use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_js::JsRegex;
use mixdog_js::json_number;
use mixdog_js::math::round as js_round;
use mixdog_js::to_number_of;
use mixdog_office_base::values::truthy;
use mixdog_office_base::write_note::WriteNote;
use mixdog_ooxml::package::open_package_bytes;
use mixdog_ooxml::package::package_buffer;
use mixdog_raster::Blend;
use mixdog_raster::Fit;
use mixdog_raster::Image;
use mixdog_raster::Overlay;
use mixdog_raster::Placement;
use mixdog_raster::ResizeOptions;
use mixdog_raster::composite;
use mixdog_raster::ops;
use mixdog_raster::svg::SvgFonts;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::html_browser::AuthorLanes;
use crate::html_browser::LAYOUT_TIMEOUT;
use crate::html_browser::RunError;
use crate::measure_deck::HTML_CANVAS;
use crate::measure_deck::MeasureOptions;
use crate::measure_deck::Prepare;
use crate::measure_deck::measure_html_deck;
use crate::normalize::normalize_package;
use crate::pptx_build::Pictures;
use crate::pptx_build::build_pptx_from_measure;
use crate::pptx_build::local_pictures;

/// How far (px of the HTML canvas) an item may move between the HTML and the render before it is reported.
pub const HTML_DRIFT_PX: f64 = 3.0;

/// The sentence a deck without pages is refused with.
const NO_SLIDE_SECTIONS: &str = "author html requires <section class=\"slide\"> pages; see the pptx skill html reference.";

/// Artifacts kept beside the deck: the HTML source and the browser's page images.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HtmlArtifacts {
    target: PathBuf,
}

/// `htmlArtifacts(target)`.
pub fn html_artifacts(target: &Path) -> HtmlArtifacts {
    HtmlArtifacts { target: target.to_path_buf() }
}

impl HtmlArtifacts {
    fn beside(&self, suffix: &str) -> PathBuf {
        let mut name = self.target.as_os_str().to_os_string();
        name.push(suffix);
        PathBuf::from(name)
    }

    /// `<deck>.mixdog-source.html`: the HTML as it was laid out.
    pub fn source(&self) -> PathBuf {
        self.beside(".mixdog-source.html")
    }

    /// `<deck>.mixdog-html-page-<n>.png`: the browser's picture of page `n` (1-based).
    pub fn shot(&self, page: usize) -> PathBuf {
        self.beside(&format!(".mixdog-html-page-{page}.png"))
    }

    /// `<deck>.mixdog-compare-page-<n>.png`: the HTML and the render of page `n` side by side.
    pub fn compare(&self, page: usize) -> PathBuf {
        self.beside(&format!(".mixdog-compare-page-{page}.png"))
    }
}

/// Whether the HTML is written as pages under the deck contract: one `<section class="slide">` per page.
pub fn has_slide_sections(html: &str) -> bool {
    JsRegex::new_static(r#"<section[^>]*class=["'][^"']*\bslide\b"#, "i").is_match(html)
}

/// How an HTML deck is authored.
pub struct RunOptions<'a> {
    /// The deck the artifacts are kept beside.
    pub target: &'a Path,
    pub timeout: Duration,
    pub cancel: CancellationToken,
    /// Names the canvas on the loaded page; the deck's 1920 x 1080 without it.
    pub prepare: Option<Prepare<'a>>,
}

impl<'a> RunOptions<'a> {
    /// The options of a plain deck: the layout deadline, no cancellation and the deck's own canvas.
    pub fn new(target: &'a Path) -> Self {
        Self { target, timeout: LAYOUT_TIMEOUT, cancel: CancellationToken::new(), prepare: None }
    }
}

fn elapsed_ms(started_at: Instant) -> Value {
    json!((started_at.elapsed().as_secs_f64() * 1000.0).round() as u64)
}

fn failure(message: &str, started_at: Instant) -> Value {
    json!({
        "ok": false,
        "error": { "message": message, "line": null, "excerpt": "" },
        "logs": [],
        "elapsedMs": elapsed_ms(started_at),
    })
}

/// `mkdir(dir, { recursive: true })`.
async fn make_dir(tokens: &LaneTokens, dir: &Path) -> Result<(), String> {
    let dir = dir.to_path_buf();
    tokens
        .durability_io
        .submit_wait(&CancellationToken::new(), move |lane| mixdog_fsio::create_dir_all(lane, &dir).map_err(|error| format!("{}: {error}", dir.display())))
        .await
        .map_err(|full| full.to_string())?
        .await
        .map_err(|dropped| dropped.to_string())?
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

async fn read_file(tokens: &LaneTokens, path: &Path) -> Result<Vec<u8>, String> {
    let target = path.to_path_buf();
    tokens
        .interactive_io
        .submit_wait(&CancellationToken::new(), move |lane| mixdog_fsio::read(lane, &target).map_err(|error| format!("{}: {error}", target.display())))
        .await
        .map_err(|full| full.to_string())?
        .await
        .map_err(|dropped| dropped.to_string())?
}

/// The files the measure's pictures name, read (a file that cannot be read is held as the reason, and refuses the
/// deck when its picture is reached).
async fn read_pictures(tokens: &LaneTokens, slides: &[Value]) -> Pictures {
    let mut pictures = Pictures::new();
    for src in local_pictures(slides) {
        let read = match url::Url::parse(&src).ok().and_then(|url| url.to_file_path().ok()) {
            Some(path) => read_file(tokens, &path).await,
            None => Err(format!("{src} is not a file URL")),
        };
        pictures.insert(src, read);
    }
    pictures
}

/// Where a text item's glyphs are on the HTML canvas: its lines' span across the box's content area, so a framed item is
/// read inside its own fill rather than as the whole frame.
fn label_of(kind: &str) -> Option<&'static str> {
    match kind {
        "image" => Some("picture"),
        "svg" => Some("svg"),
        "capture" => Some("decoration"),
        "rect" => Some("box"),
        _ => None,
    }
}

/// `name.length > 24 ? name.slice(0, 24) + '…' : name`.
fn shortened(name: &str) -> String {
    if mixdog_js::utf16_len(name) > 24 { format!("{}…", mixdog_js::slice_utf16(name, 24)) } else { name.to_owned() }
}

fn target_json(text: String, align: &str, bounds: [f64; 4], pad: f64, ink: Option<Value>) -> Value {
    let mut target = Map::new();
    target.insert("text".into(), Value::String(text));
    target.insert("align".into(), Value::String(align.to_owned()));
    for (key, value) in ["x", "y", "w", "h"].iter().zip(bounds) {
        target.insert((*key).into(), json_number(value));
    }
    target.insert("pad".into(), json_number(pad));
    if let Some(ink) = ink {
        target.insert("ink".into(), ink);
    }
    Value::Object(target)
}

fn number(value: &Value, key: &str) -> f64 {
    to_number_of(value.get(key))
}

fn is_true(value: &Value, key: &str) -> bool {
    value.get(key).is_some_and(truthy)
}

/// `item.lines[0]?.runs[0]?.style.color?.hex`.
fn first_ink(item: &Value) -> Option<Value> {
    item["lines"][0]["runs"][0]["style"]["color"].get("hex").filter(|hex| !hex.is_null()).cloned()
}

/// What a drift read looks for of one measured item, or `None` when the item is not read.
pub fn drift_target(item: &Value) -> Option<Value> {
    let kind = item["kind"].as_str().unwrap_or_default();
    if kind != "text" {
        // A picture, drawing, captured decoration or filled box is read by its whole painted extent; one the size of the
        // page has no surround to read against, and the browser draws no chart.
        let b = if kind == "capture" { &item["draw"] } else { &item["box"] };
        let label = label_of(kind)?;
        if !b.is_object() {
            return None;
        }
        let (w, h) = (number(b, "w"), number(b, "h"));
        if w < 8.0 || h < 8.0 || (w >= 1900.0 && h >= 1060.0) {
            return None;
        }
        if kind == "rect" && !is_true(item, "fill") && !is_true(item, "stroke") {
            return None;
        }
        let alt = item.get("alt").and_then(Value::as_str).filter(|alt| !alt.is_empty());
        let name = alt.map_or_else(|| label.to_owned(), |alt| format!("{label} {alt}"));
        // A box's outline is its most distinct colour (a white disc ringed in navy on white paper); else its fill.
        let fill = &item["fill"];
        let solid_fill = (fill.is_object() && number(fill, "a") > 0.9).then(|| fill["hex"].clone());
        let ink = if kind == "rect" {
            item["stroke"].get("hex").filter(|hex| truthy(hex)).cloned().or(solid_fill).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        return Some(target_json(shortened(&name), "box", [number(b, "x"), number(b, "y"), w, h], 3.0, Some(ink)));
    }
    // The glyph boxes of tight display type reach past the element into its neighbours; the element's own content box
    // bounds the read so a neighbour's ink is never taken for this item's.
    let lines = item["lines"].as_array().filter(|lines| !lines.is_empty())?;
    let glyph_top = number(&lines[0], "top");
    let glyph_bottom = number(&lines[lines.len() - 1], "bottom");
    let (b, inset) = (&item["box"], &item["inset"]);
    let box_top = number(b, "y") + number(inset, "t");
    let box_bottom = number(b, "y") + number(b, "h") - number(inset, "b");
    let clipped = glyph_bottom.min(box_bottom) > glyph_top.max(box_top);
    let top = if clipped { glyph_top.max(box_top) } else { glyph_top };
    let bottom = if clipped { glyph_bottom.min(box_bottom) } else { glyph_bottom };
    let words: Vec<String> = lines
        .iter()
        .map(|line| line["runs"].as_array().map_or(&[][..], Vec::as_slice).iter().map(|run| run["text"].as_str().unwrap_or_default()).collect::<String>())
        .collect();
    let x = number(b, "x") + number(inset, "l");
    let w = (number(b, "w") - number(inset, "l") - number(inset, "r")).max(1.0);
    let pad = if item["frame"].is_object() {
        0.0_f64.max(3.0_f64.min(number(inset, "l")).min(number(inset, "r")).min(number(inset, "t")).min(number(inset, "b")))
    } else {
        3.0
    };
    Some(target_json(shortened(&words.join(" ")), item["align"].as_str().unwrap_or_default(), [x, top, w, bottom - top], pad, first_ink(item)))
}

/// The drift targets of every slide: a text item's glyph span, or a drawn item's extent unless it stands over a chart
/// (the browser draws no chart, so a non-text item over one would read the PPTX bars as its own ink).
pub fn html_text_of(slides: &[Value]) -> Vec<Value> {
    slides
        .iter()
        .map(|slide| {
            let items = slide["items"].as_array().map_or(&[][..], Vec::as_slice);
            let charts: Vec<[f64; 4]> = items.iter().filter(|item| item["kind"] == "chart").map(|item| bounds_of(&item["box"])).collect();
            let over_chart = |b: [f64; 4]| charts.iter().any(|c| b[0] < c[0] + c[2] && c[0] < b[0] + b[2] && b[1] < c[1] + c[3] && c[1] < b[1] + b[3]);
            Value::Array(items.iter().filter_map(drift_target).filter(|target| target["align"] != "box" || !over_chart(bounds_of(target))).collect())
        })
        .collect()
}

fn bounds_of(value: &Value) -> [f64; 4] {
    [number(value, "x"), number(value, "y"), number(value, "w"), number(value, "h")]
}

/// The package the build wrote, normalised (`normalizeAuthoredPptx`): its bytes (the package is written again only when
/// a part changed) and the paragraphs removed. `output` names the file in the message of a package that cannot be read.
pub fn normalize_built_deck(bytes: Vec<u8>, output: &Path) -> Result<(Vec<u8>, usize), String> {
    let mut package = open_package_bytes(&bytes, &output.display().to_string())?;
    let result = normalize_package(&mut package)?;
    if result.changed_parts == 0 {
        return Ok((bytes, result.removed));
    }
    Ok((package_buffer(&package)?, result.removed))
}

/// Lays an HTML deck out in the shared render browser, writes it to `output` as native PowerPoint objects and keeps the
/// browser's page images beside `options.target`.
///
/// Answers `{ ok: true, output, bytes, logs, kit: 'html', slideCount, normalizedParagraphs, htmlShots, htmlText,
/// htmlSource, geometry, elapsedMs }`, or `{ ok: false, error: { message, line, excerpt }, logs, elapsedMs }` when the
/// browser or the build failed. A deck without `<section class="slide">` pages, a cancellation and a package that cannot
/// be normalised are the errors. `fonts` are the faces an SVG drawing's text is set in.
pub async fn run_pptx_html_authoring(
    endpoint: &dyn BrowserEndpoint,
    tokens: LaneTokens,
    fonts: &SvgFonts,
    note: &dyn WriteNote,
    html: &str,
    output: &Path,
    options: RunOptions<'_>,
) -> Result<Value, RunError> {
    if !has_slide_sections(html) {
        return Err(RunError::Failed(NO_SLIDE_SECTIONS.to_owned()));
    }
    let RunOptions { target, timeout, cancel, prepare } = options;
    let started_at = Instant::now();
    let artifacts = html_artifacts(target);
    let lanes = AuthorLanes::new(tokens);
    if let Some(parent) = output.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        make_dir(&tokens, parent).await?;
    }
    remove_file(&tokens, output).await?;
    let source = artifacts.source();
    let shots = |page: usize| artifacts.shot(page);
    let mut measuring = MeasureOptions::new(&source, &shots);
    measuring.timeout = timeout;
    measuring.cancel = cancel;
    measuring.prepare = prepare;
    let measured = match measure_html_deck(endpoint, &lanes, note, html, measuring).await {
        Ok(measured) => measured,
        Err(RunError::Cancelled) => return Err(RunError::Cancelled),
        Err(RunError::Failed(message)) => return Ok(failure(&message, started_at)),
    };
    let pictures = read_pictures(&tokens, &measured.slides).await;
    let (canvas, slides, fonts) = (measured.canvas, measured.slides.clone(), fonts.clone());
    let built = lanes.compute(move || build_pptx_from_measure(canvas, &slides, &fonts, &pictures)).await?;
    let bytes = match built {
        Ok(bytes) => bytes,
        Err(message) => return Ok(failure(&message, started_at)),
    };
    let path = output.to_path_buf();
    let (bytes, removed) = lanes.compute(move || normalize_built_deck(bytes, &path)).await??;
    // The deck is written once, built and normalised; the ledger is told before it is (Node's normaliser told it when it
    // rewrote the package).
    note.note_write(output);
    lanes.write_file(output, bytes.clone()).await?;
    let logs: Vec<Value> = measured.notes.iter().map(|text| json!({ "level": "warn", "text": text })).collect();
    Ok(json!({
        "ok": true,
        "output": output.display().to_string(),
        "bytes": bytes.len(),
        "logs": logs,
        "kit": "html",
        "slideCount": measured.slides.len(),
        "normalizedParagraphs": removed,
        "htmlShots": measured.shots.iter().map(|shot| shot.display().to_string()).collect::<Vec<_>>(),
        "htmlText": html_text_of(&measured.slides),
        "htmlSource": source.display().to_string(),
        "geometry": measured.geometry,
        "elapsedMs": elapsed_ms(started_at),
    }))
}

/// A page's pixels on the HTML canvas, four bytes each.
struct Pixels {
    data: Vec<u8>,
    width: i64,
    height: i64,
}

/// `canvasPixels`: the picture resized to the canvas (`fit: 'fill'`) with its alpha dropped.
async fn canvas_pixels(tokens: &LaneTokens, lanes: &AuthorLanes, path: &Path) -> Result<Pixels, String> {
    let bytes = read_file(tokens, path).await?;
    lanes
        .compute(move || -> Result<Pixels, String> {
            let image = Image::decode(&bytes).map_err(|error| error.to_string())?;
            let options = ResizeOptions { width: Some(HTML_CANVAS.width), height: Some(HTML_CANVAS.height), fit: Fit::Fill, ..ResizeOptions::default() };
            let flat = ops::resize(&image, &options).map_err(|error| error.to_string())?.remove_alpha();
            Ok(Pixels { data: flat.rgba().to_vec(), width: i64::from(flat.width()), height: i64::from(flat.height()) })
        })
        .await?
}

/// What a drift read looks at: its extent on the canvas, how it is aligned and the colour of its ink.
struct Region {
    align: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    pad: f64,
    text: String,
    ink: Option<[i64; 3]>,
}

impl Region {
    fn of(target: &Value) -> Self {
        // `parseInt(hex.slice(k, k + 2), 16)`: an ink that is not hex leaves the read without a known colour.
        let ink = target["ink"].as_str().and_then(|hex| {
            let part = |at: usize| hex.get(at..at + 2).and_then(|digits| i64::from_str_radix(digits, 16).ok());
            Some([part(0)?, part(2)?, part(4)?])
        });
        let pad = target.get("pad").filter(|pad| !pad.is_null()).map_or(3.0, |pad| to_number_of(Some(pad)));
        Self {
            align: target["align"].as_str().unwrap_or_default().to_owned(),
            x: number(target, "x"),
            y: number(target, "y"),
            w: number(target, "w"),
            h: number(target, "h"),
            pad,
            text: target["text"].as_str().unwrap_or_default().to_owned(),
            ink,
        }
    }
}

/// The ink bounds a read found: left, top, right and bottom pixel.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Ink {
    l: i64,
    t: i64,
    r: i64,
    b: i64,
}

/// The ink inside a region: pixels that differ from the colour most common on its border.
fn ink_bounds(image: &Pixels, region: &Region) -> Option<Ink> {
    let x0 = (region.x - region.pad).floor().max(0.0) as i64;
    let y0 = (region.y - region.pad).floor().max(0.0) as i64;
    let x1 = (image.width - 1).min((region.x + region.w + region.pad).ceil() as i64);
    let y1 = (image.height - 1).min((region.y + region.h + region.pad).ceil() as i64);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let at = |x: i64, y: i64| ((y * image.width + x) * 4) as usize;
    let rgb = |x: i64, y: i64| {
        let i = at(x, y);
        [i64::from(image.data[i]), i64::from(image.data[i + 1]), i64::from(image.data[i + 2])]
    };
    // The colours of the border in the order first met, with how often each stands there.
    let mut counts: Vec<([i64; 3], usize)> = Vec::new();
    let mut count = |x: i64, y: i64| {
        let colour = rgb(x, y);
        match counts.iter_mut().find(|(known, _)| *known == colour) {
            Some((_, seen)) => *seen += 1,
            None => counts.push((colour, 1)),
        }
    };
    for x in x0..=x1 {
        count(x, y0);
        count(x, y1);
    }
    for y in y0..=y1 {
        count(x0, y);
        count(x1, y);
    }
    // The most common colour; the first met when two are as common.
    let (bg, bg_count) = counts.iter().fold(None::<([i64; 3], usize)>, |best, entry| match best {
        Some(best) if best.1 >= entry.1 => Some(best),
        _ => Some(*entry),
    })?;
    // A drawn item on a surround that is not one colour (a band, a gradient, a picture) has no edge to read.
    let border = 2 * (x1 - x0 + 1) + 2 * (y1 - y0 + 1);
    let boxed = region.align == "box";
    if boxed && (bg_count as f64) / (border as f64) < 0.6 {
        return None;
    }
    let distance = |pixel: [i64; 3], to: [i64; 3]| (pixel[0] - to[0]).abs() + (pixel[1] - to[1]).abs() + (pixel[2] - to[2]).abs();
    // With the text colour known, ink is what stands nearer to it than half the background's distance, so a gradient or
    // picture behind the words is never read as ink; otherwise, what departs from the background.
    let ink_to_bg = region.ink.map_or(0, |ink| distance(bg, ink));
    // A box's fill may sit close to the page (a white panel on paper); its known colour still separates it.
    let known = region.ink.filter(|_| ink_to_bg > if boxed { 12 } else { 90 });
    // A drawn item's pale tints are its extent too, so its departure threshold is lower than a glyph's; not so low that
    // a neighbour's soft shadow reads as the item.
    let departure = if boxed { 60 } else { 90 };
    let is_ink = |pixel: [i64; 3]| match known {
        Some(ink) => (distance(pixel, ink) as f64) < ink_to_bg as f64 / 2.0,
        None => distance(pixel, bg) > departure,
    };
    let mut found: Option<Ink> = None;
    for y in y0..=y1 {
        for x in x0..=x1 {
            if is_ink(rgb(x, y)) {
                found = Some(match found {
                    None => Ink { l: x, t: y, r: x, b: y },
                    Some(ink) => Ink { l: ink.l.min(x), t: ink.t.min(y), r: ink.r.max(x), b: ink.b.max(y) },
                });
            }
        }
    }
    found
}

/// How far an edge pair moved along one axis: together is a move, apart is a resize; one edge alone is the reading of a
/// faint edge, not the item.
fn axis_drift(lo: f64, hi: f64) -> (f64, f64) {
    if lo.abs() <= 1.0 || hi.abs() <= 1.0 {
        return (0.0, 0.0);
    }
    if lo.signum() == hi.signum() { (lo.signum() * lo.abs().min(hi.abs()), 0.0) } else { (0.0, hi - lo) }
}

/// How a drawn item's ink bounds moved between two renders, or `None` when it stayed within the threshold.
fn box_drift(a: Ink, b: Ink, text: &str, threshold: f64) -> Option<Value> {
    let (move_x, grow_x) = axis_drift((b.l - a.l) as f64, (b.r - a.r) as f64);
    let (move_y, grow_y) = axis_drift((b.t - a.t) as f64, (b.b - a.b) as f64);
    if ![move_x, move_y, grow_x, grow_y].iter().any(|value| value.abs() > threshold) {
        return None;
    }
    let mut drift = Map::new();
    drift.insert("text".into(), json!(text));
    drift.insert("dx".into(), json_number(move_x));
    drift.insert("dy".into(), json_number(move_y));
    if grow_x != 0.0 {
        drift.insert("dw".into(), json_number(grow_x));
    }
    if grow_y != 0.0 {
        drift.insert("dh".into(), json_number(grow_y));
    }
    Some(Value::Object(drift))
}

fn largest_move(item: &Value) -> f64 {
    number(item, "dy").abs().max(number(item, "dx").abs())
}

/// `html_render_drift`: how far each item moved between the HTML and PowerPoint's render, in px of the HTML canvas:
/// vertically the mean of the top and bottom ink edges (a size change is not a move); horizontally the edge a text is
/// aligned to, or the mean of both edges for a picture, drawing, decoration or box. Only single-page render images can be
/// read.
///
/// `html_shots` are the paths of the run's `htmlShots`, `html_text` its `htmlText`, and `rendered_images` the render's
/// images (`{ page, pages?, path }`).
pub async fn measure_html_drift(tokens: LaneTokens, html_shots: &Value, html_text: &Value, rendered_images: &[Value], threshold: f64) -> Result<Value, String> {
    let lanes = AuthorLanes::new(tokens);
    let mut pages: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    for image in rendered_images {
        let covered: Vec<Value> = match image.get("pages").filter(|pages| truthy(pages)) {
            Some(Value::Array(list)) => list.clone(),
            Some(other) => vec![other.clone()],
            None => vec![image.get("page").cloned().unwrap_or(Value::Null)],
        };
        if covered.len() != 1 {
            skipped.extend(covered);
            continue;
        }
        let page = number(image, "page");
        let position = (page - 1.0) as usize;
        let targets = html_text.get(position).and_then(Value::as_array).filter(|targets| !targets.is_empty());
        let shot = html_shots.get(position).and_then(Value::as_str).filter(|shot| !shot.is_empty());
        let rendered = image.get("path").and_then(Value::as_str).filter(|path| !path.is_empty());
        let (Some(targets), Some(shot), Some(rendered)) = (targets, shot, rendered) else { continue };
        let html = canvas_pixels(&tokens, &lanes, Path::new(shot)).await?;
        let pptx = canvas_pixels(&tokens, &lanes, Path::new(rendered)).await?;
        let mut moved: Vec<Value> = Vec::new();
        for target in targets {
            let region = Region::of(target);
            let (Some(a), Some(b)) = (ink_bounds(&html, &region), ink_bounds(&pptx, &region)) else { continue };
            if region.align == "box" {
                if let Some(drift) = box_drift(a, b, &region.text, threshold) {
                    moved.push(drift);
                }
                continue;
            }
            let dy = js_round(((b.t - a.t) as f64 + (b.b - a.b) as f64) / 2.0);
            let dx = match region.align.as_str() {
                "center" => js_round(((b.l - a.l) as f64 + (b.r - a.r) as f64) / 2.0),
                "right" => (b.r - a.r) as f64,
                _ => (b.l - a.l) as f64,
            };
            if dy.abs() > threshold || dx.abs() > threshold {
                moved.push(json!({ "text": region.text, "dx": json_number(dx), "dy": json_number(dy) }));
            }
        }
        if !moved.is_empty() {
            // Largest move first; equal moves keep their order.
            moved.sort_by(|p, q| largest_move(q).partial_cmp(&largest_move(p)).unwrap_or(std::cmp::Ordering::Equal));
            pages.push(json!({ "page": image["page"], "items": moved }));
        }
    }
    let mut result = Map::new();
    result.insert("code".into(), json!("html_render_drift"));
    result.insert("threshold".into(), json_number(threshold));
    result.insert("unit".into(), json!("px on the 1920 × 1080 HTML canvas"));
    result.insert("pages".into(), Value::Array(pages));
    if !skipped.is_empty() {
        result.insert("unreadPages".into(), Value::Array(skipped));
    }
    Ok(Value::Object(result))
}

/// The size of one half of a comparison image.
const HALF_WIDTH: u32 = 960;
const HALF_HEIGHT: u32 = 540;
const GAP: u32 = 16;

/// The comparison image of one page: the HTML on the left, the render on the right, on grey.
fn comparison_image(html: &[u8], render: &[u8]) -> Result<Vec<u8>, String> {
    let half = |bytes: &[u8]| -> Result<Image, String> {
        let image = Image::decode(bytes).map_err(|error| error.to_string())?;
        ops::resize(&image, &ResizeOptions { width: Some(HALF_WIDTH), height: Some(HALF_HEIGHT), fit: Fit::Fill, ..ResizeOptions::default() }).map_err(|error| error.to_string())
    };
    let (left, right) = (half(html)?, half(render)?);
    let sheet = Image::create(HALF_WIDTH * 2 + GAP, HALF_HEIGHT, 3, [0x80, 0x80, 0x80, 255]).map_err(|error| error.to_string())?;
    let overlays = [
        Overlay { image: left, blend: Blend::Over, placement: Placement::At { left: 0, top: 0 } },
        Overlay { image: right, blend: Blend::Over, placement: Placement::At { left: i64::from(HALF_WIDTH + GAP), top: 0 } },
    ];
    composite(&sheet, &overlays).to_png().map_err(|error| error.to_string())
}

/// One image per page: the HTML the author wrote on the left, the PPTX PowerPoint drew on the right. Answers
/// `[{ page, path }]` for each single-page render image whose HTML shot exists.
pub async fn write_html_comparisons(tokens: LaneTokens, note: &dyn WriteNote, target: &Path, html_shots: &Value, rendered_images: &[Value]) -> Result<Vec<Value>, String> {
    let lanes = AuthorLanes::new(tokens);
    let artifacts = html_artifacts(target);
    let mut pairs = Vec::new();
    for image in rendered_images {
        // `(image.pages?.length || 1) !== 1`.
        let covered = image.get("pages").and_then(Value::as_array).map_or(0, Vec::len);
        if covered > 1 {
            continue;
        }
        let page = number(image, "page");
        let shot = html_shots.get((page - 1.0) as usize).and_then(Value::as_str).filter(|shot| !shot.is_empty());
        let rendered = image.get("path").and_then(Value::as_str).filter(|path| !path.is_empty());
        let (Some(shot), Some(rendered)) = (shot, rendered) else { continue };
        let html = read_file(&tokens, Path::new(shot)).await?;
        let render = read_file(&tokens, Path::new(rendered)).await?;
        let png = lanes.compute(move || comparison_image(&html, &render)).await??;
        let path = artifacts.compare(page as usize);
        note.note_write(&path);
        lanes.write_file(&path, png).await?;
        pairs.push(json!({ "page": image["page"], "path": path.display().to_string() }));
    }
    Ok(pairs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb_image(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 3]) -> Pixels {
        let mut data = Vec::new();
        for y in 0..height {
            for x in 0..width {
                let [r, g, b] = pixel(x, y);
                data.extend_from_slice(&[r, g, b, 255]);
            }
        }
        Pixels { data, width: i64::from(width), height: i64::from(height) }
    }

    fn region(align: &str, bounds: [f64; 4], ink: Option<&str>) -> Region {
        Region::of(&json!({ "text": "t", "align": align, "x": bounds[0], "y": bounds[1], "w": bounds[2], "h": bounds[3], "pad": 3, "ink": ink }))
    }

    #[test]
    fn the_artifacts_are_named_beside_the_deck() {
        let artifacts = html_artifacts(Path::new("/work/deck.pptx"));
        assert_eq!(artifacts.source(), PathBuf::from("/work/deck.pptx.mixdog-source.html"));
        assert_eq!(artifacts.shot(2), PathBuf::from("/work/deck.pptx.mixdog-html-page-2.png"));
        assert_eq!(artifacts.compare(3), PathBuf::from("/work/deck.pptx.mixdog-compare-page-3.png"));
    }

    #[test]
    fn a_deck_needs_section_slide_pages() {
        assert!(has_slide_sections("<section class=\"slide\"></section>"));
        assert!(has_slide_sections("<SECTION id=x class='cover slide dark'>"));
        assert!(!has_slide_sections("<section class=\"slides\"></section>"));
        assert!(!has_slide_sections("<div class=\"slide\"></div>"));
    }

    #[test]
    fn an_html_brief_comment_reads_as_the_script_brief() {
        let html = "<!doctype html><!-- BRIEF\nfacts: sample — illustrative numbers\nslide plan: 1 job: cover · move: know the deck · carriers: statement\n  · 2 job: evidence · move: see the gap · carriers: chart\n-->\n<section class=\"slide\"></section>";
        let brief = crate::brief::parse_authoring_brief(&crate::brief::html_brief_script(html));
        assert_eq!(brief["present"], json!(true));
        assert_eq!(brief["factsMode"], json!("sample"));
        let plan: Vec<(Value, Value)> = brief["plan"].as_array().expect("a plan").iter().map(|entry| (entry["slide"].clone(), entry["carriers"].clone())).collect();
        assert_eq!(plan, vec![(json!(1), json!(["statement"])), (json!(2), json!(["chart"]))]);
        assert_eq!(crate::brief::html_brief_script("<section class=\"slide\"></section>"), "");
    }

    #[test]
    fn a_text_item_is_read_by_its_glyph_span_inside_its_content_box() {
        let item = json!({
            "kind": "text",
            "box": { "x": 100, "y": 200, "w": 300, "h": 60 },
            "inset": { "l": 10, "r": 10, "t": 5, "b": 5 },
            "frame": { "kind": "rect" },
            "align": "left",
            "lines": [{ "top": 190, "bottom": 250, "runs": [{ "text": "A very long headline that goes past twenty-four", "style": { "color": { "hex": "112233", "a": 1 } } }] }],
        });
        let target = drift_target(&item).expect("a target");
        // The glyph box (190..250) reaches 10 px above the element, whose content box (205..255) bounds the read.
        assert_eq!(target, json!({ "text": "A very long headline tha…", "align": "left", "x": 110, "y": 205, "w": 280, "h": 45, "pad": 3, "ink": "112233" }));
        let plain = json!({ "kind": "text", "box": { "x": 0, "y": 0, "w": 50, "h": 20 }, "inset": { "l": 0, "r": 0, "t": 0, "b": 0 }, "frame": null, "align": "right", "lines": [{ "top": 0, "bottom": 20, "runs": [{ "text": "x", "style": { "color": { "hex": "000000", "a": 1 } } }] }] });
        assert_eq!(drift_target(&plain).expect("a target")["pad"], json!(3));
    }

    #[test]
    fn a_drawn_item_is_read_by_its_extent_unless_it_is_small_page_sized_or_unpainted() {
        let rect = |fill: Value, stroke: Value, w: u32| json!({ "kind": "rect", "box": { "x": 0, "y": 0, "w": w, "h": 100 }, "fill": fill, "stroke": stroke });
        let navy = json!({ "hex": "0F1F3F", "a": 1 });
        let ringed = drift_target(&rect(json!({ "hex": "FFFFFF", "a": 1 }), json!({ "hex": "0F1F3F", "a": 1, "w": 2 }), 100)).expect("a target");
        assert_eq!((ringed["align"].clone(), ringed["ink"].clone(), ringed["text"].clone()), (json!("box"), json!("0F1F3F"), json!("box")));
        assert_eq!(drift_target(&rect(navy.clone(), Value::Null, 100)).expect("a target")["ink"], json!("0F1F3F"));
        assert_eq!(drift_target(&rect(json!({ "hex": "0F1F3F", "a": 0.5 }), Value::Null, 100)).expect("a target")["ink"], Value::Null);
        assert_eq!(drift_target(&rect(Value::Null, Value::Null, 100)), None);
        assert_eq!(drift_target(&rect(navy.clone(), Value::Null, 4)), None);
        assert_eq!(drift_target(&json!({ "kind": "rect", "box": { "x": 0, "y": 0, "w": 1920, "h": 1080 }, "fill": navy })), None);
        let svg = drift_target(&json!({ "kind": "svg", "alt": "coins", "box": { "x": 1, "y": 2, "w": 64, "h": 64 } })).expect("a target");
        assert_eq!((svg["text"].clone(), svg["ink"].clone()), (json!("svg coins"), Value::Null));
        let capture = drift_target(&json!({ "kind": "capture", "box": { "x": 0, "y": 0, "w": 1, "h": 1 }, "draw": { "x": 5, "y": 6, "w": 50, "h": 40 } })).expect("a target");
        assert_eq!((capture["text"].clone(), capture["x"].clone()), (json!("decoration"), json!(5)));
        assert_eq!(drift_target(&json!({ "kind": "line", "seg": [0, 0, 1, 1] })), None);
        assert_eq!(drift_target(&json!({ "kind": "table", "box": { "x": 0, "y": 0, "w": 100, "h": 100 } })), None);
    }

    #[test]
    fn a_drawn_item_over_a_chart_is_not_read() {
        let slides = [json!({ "items": [
            { "kind": "chart", "box": { "x": 100, "y": 100, "w": 400, "h": 300 } },
            { "kind": "svg", "alt": "over", "box": { "x": 150, "y": 150, "w": 50, "h": 50 } },
            { "kind": "svg", "alt": "beside", "box": { "x": 600, "y": 150, "w": 50, "h": 50 } },
        ] })];
        let read = html_text_of(&slides);
        let names: Vec<&str> = read[0].as_array().expect("targets").iter().map(|target| target["text"].as_str().expect("text")).collect();
        assert_eq!(names, ["svg beside"]);
    }

    #[test]
    fn ink_is_what_stands_nearer_the_text_colour_than_half_the_background_distance() {
        // White paper, black ink at x 20..=29, y 12..=17.
        let image = rgb_image(60, 40, |x, y| if (20..30).contains(&x) && (12..18).contains(&y) { [0, 0, 0] } else { [255, 255, 255] });
        let found = ink_bounds(&image, &region("left", [10.0, 5.0, 40.0, 25.0], Some("000000"))).expect("ink");
        assert_eq!(found, Ink { l: 20, t: 12, r: 29, b: 17 });
        // Without a known colour, what departs from the background.
        assert_eq!(ink_bounds(&image, &region("left", [10.0, 5.0, 40.0, 25.0], None)), Some(found));
        // Blank paper has no ink.
        let blank = rgb_image(60, 40, |_, _| [255, 255, 255]);
        assert_eq!(ink_bounds(&blank, &region("left", [10.0, 5.0, 40.0, 25.0], None)), None);
    }

    #[test]
    fn a_drawn_item_on_a_surround_that_is_not_one_colour_has_no_edge_to_read() {
        let stripes = rgb_image(60, 40, |x, _| if x % 2 == 0 { [255, 255, 255] } else { [200, 200, 200] });
        assert_eq!(ink_bounds(&stripes, &region("box", [10.0, 5.0, 40.0, 25.0], Some("000000"))), None);
    }

    #[test]
    fn a_box_counts_only_when_both_of_its_edges_moved() {
        let a = Ink { l: 100, t: 100, r: 200, b: 160 };
        // Both horizontal edges 5 px right: a move.
        let moved = box_drift(a, Ink { l: 105, t: 100, r: 205, b: 160 }, "box", 3.0).expect("a drift");
        assert_eq!(moved, json!({ "text": "box", "dx": 5, "dy": 0 }));
        // Edges moving apart: a resize.
        let grown = box_drift(a, Ink { l: 96, t: 100, r: 204, b: 160 }, "box", 3.0).expect("a drift");
        assert_eq!(grown, json!({ "text": "box", "dx": 0, "dy": 0, "dw": 8 }));
        // One edge alone is the reading of a faint edge.
        assert_eq!(box_drift(a, Ink { l: 100, t: 100, r: 210, b: 160 }, "box", 3.0), None);
        // Within the threshold.
        assert_eq!(box_drift(a, Ink { l: 102, t: 100, r: 202, b: 160 }, "box", 3.0), None);
    }

    #[test]
    fn the_comparison_puts_the_html_left_and_the_render_right_on_grey() {
        let solid = |pixel: [u8; 4]| Image::create(96, 54, 4, pixel).expect("an image").to_png().expect("a png");
        let png = comparison_image(&solid([255, 0, 0, 255]), &solid([0, 0, 255, 255])).expect("a comparison");
        let sheet = Image::decode(&png).expect("a png");
        assert_eq!((sheet.width(), sheet.height()), (1936, 540));
        let at = |x: usize, y: usize| {
            let i = (y * 1936 + x) * 4;
            sheet.rgba()[i..i + 3].to_vec()
        };
        assert_eq!(at(10, 10), vec![255, 0, 0]);
        assert_eq!(at(968, 10), vec![128, 128, 128]);
        assert_eq!(at(1000, 10), vec![0, 0, 255]);
    }

    #[test]
    fn an_image_that_covers_more_than_a_page_is_unread_and_one_page_with_no_drift_leaves_the_pages_empty() {
        let tokens = mixdog_rt::testing::tokens();
        let images = [json!({ "page": 1, "pages": [1, 2], "path": "a.png" }), json!({ "page": 3, "path": "none.png" })];
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime");
        let report = runtime.block_on(measure_html_drift(tokens, &json!([]), &json!([]), &images, 3.0)).expect("a report");
        assert_eq!(report, json!({ "code": "html_render_drift", "threshold": 3, "unit": "px on the 1920 × 1080 HTML canvas", "pages": [], "unreadPages": [1, 2] }));
    }
}
