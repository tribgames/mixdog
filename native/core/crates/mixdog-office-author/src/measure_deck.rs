//! The HTML authoring path, first half: the shared render browser lays an HTML deck out (one `<section class="slide">`
//! per page on a 1920 x 1080 canvas) and this module reads back what the browser drew: boxes, fills, borders, shadows,
//! text with the line breaks the browser chose, tables, chart specs, inline SVG and pictures, plus one screenshot per
//! slide as the visual reference (`authoring/pptx-html-measure.mjs`). The deck builder turns the measurement into
//! native PowerPoint shapes.
//!
//! The reading runs inside the page (`assets/page/pptx-html-measure.js`, the Node functions taken over as they were);
//! this module is what Node did around it: the viewport, the offline icons, one slide at a time, the screenshots, the
//! geometry read and the photograph of every element whose paint PowerPoint has no form for.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::ext::BrowserEndpoint;
use mixdog_js::json_number;
use mixdog_js::math::round as js_round;
use mixdog_office_base::write_note::WriteNote;
use mixdog_raster::Image;
use mixdog_rt::CancellationToken;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::geometry;
use crate::html_browser::AuthorLanes;
use crate::html_browser::HtmlBrowser;
use crate::html_browser::LAYOUT_TIMEOUT;
use crate::html_browser::RunError;
use crate::html_browser::run_in_browser;
use crate::icons::icons;
use crate::page::Page;
use crate::page::ScreenshotOptions;
use crate::page::Viewport;
use crate::page::WaitUntil;
use crate::page::page_function;
use crate::page::Rect;

/// The deck canvas in CSS px and the page it lands on in inches; a PDF's designed pages pass their sheet instead.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Canvas {
    pub width: u32,
    pub height: u32,
    pub inch_width: f64,
    pub inch_height: f64,
}

/// The deck's own canvas.
pub const HTML_CANVAS: Canvas = Canvas { width: 1920, height: 1080, inch_width: 13.333, inch_height: 7.5 };

/// The density at which a decoration is photographed.
const CAPTURE_SCALE: f64 = 2.0;

/// The view box the offline icons are drawn in.
const ICON_VIEW_BOX: &str = "0 0 24 24";

/// The page functions `extractSlide`, `isolateCapture`, `showSlide` and `injectIcons`.
const PAGE_SCRIPT: &str = include_str!("../assets/page/pptx-html-measure.js");

/// What the route that runs on a loaded page may do to it before the slides are read: it returns the canvas the
/// slides are measured on.
pub type PrepareFuture<'a> = Pin<Box<dyn Future<Output = Result<Canvas, String>> + Send + 'a>>;
pub type Prepare<'a> = Box<dyn for<'p> FnOnce(&'p Page) -> PrepareFuture<'p> + Send + 'a>;

/// How a deck is measured.
pub struct MeasureOptions<'a> {
    /// Where the HTML is written before loading (beside the deck, so relative `<img>` paths resolve).
    pub source_path: &'a Path,
    /// Where the screenshot of page `n` (1-based) is written.
    pub shot_path: &'a (dyn Fn(usize) -> PathBuf + Send + Sync),
    pub timeout: Duration,
    pub cancel: CancellationToken,
    pub prepare: Option<Prepare<'a>>,
}

impl<'a> MeasureOptions<'a> {
    /// The options of a plain deck: the layout deadline, no cancellation and the deck's own canvas.
    pub fn new(source_path: &'a Path, shot_path: &'a (dyn Fn(usize) -> PathBuf + Send + Sync)) -> Self {
        Self { source_path, shot_path, timeout: LAYOUT_TIMEOUT, cancel: CancellationToken::new(), prepare: None }
    }
}

/// What the browser drew.
#[derive(Clone, Debug, PartialEq)]
pub struct Measured {
    pub canvas: Canvas,
    /// One `{ bg, items, notes }` per slide: its background, its items in paint order and its speaker notes.
    pub slides: Vec<Value>,
    pub shots: Vec<PathBuf>,
    pub notes: Vec<String>,
    /// `{ slide, findings }` for each slide with geometry findings.
    pub geometry: Vec<Value>,
}

fn viewport(canvas: Canvas, device_scale_factor: f64) -> Viewport {
    Viewport { width: canvas.width, height: canvas.height, device_scale_factor }
}

/// The page-function call `name(...args)` of the measure script.
async fn call(page: &Page, name: &str, args: &[Value]) -> Result<Value, String> {
    page.evaluate(&page_function(PAGE_SCRIPT, name), args).await
}

/// `<i data-icon="name" data-sw="1.75">` becomes the offline Lucide SVG, sized by the `<i>`'s CSS box and stroked in
/// its CSS colour. Returns the names the set does not have (those `<i>` stay as they are).
pub async fn inject_icons(page: &Page) -> Result<Vec<String>, String> {
    let missing = call(page, "injectIcons", &[icons().table(), json!(ICON_VIEW_BOX)]).await?;
    Ok(missing.as_array().map(|names| names.iter().map(|name| name.as_str().unwrap_or_default().to_string()).collect()).unwrap_or_default())
}

/// The error for icons the set does not have: each name, or the sentence that names the nearest icons.
pub fn unknown_icons_error(missing: &[String]) -> String {
    let hint: Vec<String> = missing.iter().map(|name| icons().markup(name).map_or_else(|message| message, |_| name.clone())).collect();
    format!("Unknown data-icon: {}", hint.join(" "))
}

/// What a photographed decoration became: its picture (base64) and where it is drawn on the canvas.
#[derive(Clone, Debug, PartialEq)]
pub struct Paint {
    pub png: String,
    pub draw: Value,
}

/// A photograph of one decoration at twice the canvas density, on a transparent page: nothing when nothing was
/// painted; the whole picture when the element covers the page edge to edge (no alpha channel, or none transparent);
/// otherwise the picture trimmed to what it painted (shadows, pseudo-elements and turned corners included), with the
/// canvas position and size of what is left, in CSS px.
pub fn paint_of_photograph(shot: &[u8], canvas: Canvas) -> Result<Option<Paint>, String> {
    let image = Image::decode(shot).map_err(|error| error.to_string())?;
    let channels = mixdog_raster::stats(&image);
    let alpha = if image.has_alpha() { channels.last() } else { None };
    if alpha.is_some_and(|alpha| alpha.max == 0) {
        return Ok(None);
    }
    if alpha.is_none_or(|alpha| alpha.min == 255) {
        return Ok(Some(Paint {
            png: STANDARD.encode(shot),
            draw: json!({ "x": 0, "y": 0, "w": canvas.width, "h": canvas.height }),
        }));
    }
    let trimmed = mixdog_raster::ops::trim(&image, 0.0).map_err(|error| error.to_string())?;
    let png = trimmed.image.to_png().map_err(|error| error.to_string())?;
    Ok(Some(Paint {
        png: STANDARD.encode(png),
        draw: json!({
            "x": json_number(f64::from(trimmed.left) / CAPTURE_SCALE),
            "y": json_number(f64::from(trimmed.top) / CAPTURE_SCALE),
            "w": json_number(f64::from(trimmed.image.width()) / CAPTURE_SCALE),
            "h": json_number(f64::from(trimmed.image.height()) / CAPTURE_SCALE),
        }),
    }))
}

/// A slide's items with each `capture` item given its photograph (`{ ...item, png, draw }`); a capture that painted
/// nothing is left out.
pub fn place_captures(items: Vec<Value>, drawn: &BTreeMap<String, Paint>) -> Vec<Value> {
    items
        .into_iter()
        .filter_map(|mut item| {
            if item["kind"] != "capture" {
                return Some(item);
            }
            let paint = drawn.get(item["id"].as_str().unwrap_or_default())?;
            let object = item.as_object_mut()?;
            object.insert("png".into(), json!(paint.png));
            object.insert("draw".into(), paint.draw.clone());
            Some(item)
        })
        .collect()
}

/// Each marked element photographed alone at twice the canvas density on a transparent page, trimmed to what it
/// painted: id to its paint.
async fn capture_rich_paint(
    page: &Page,
    lanes: &AuthorLanes,
    slide_box: Rect,
    ids: &[String],
    canvas: Canvas,
) -> Result<BTreeMap<String, Paint>, String> {
    let mut out = BTreeMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    page.set_viewport(viewport(canvas, CAPTURE_SCALE)).await?;
    let photographed = photograph_each(page, lanes, slide_box, ids, canvas, &mut out).await;
    let restored = async {
        call(page, "isolateCapture", &[Value::Null]).await?;
        page.set_viewport(viewport(canvas, 1.0)).await
    }
    .await;
    photographed?;
    restored?;
    Ok(out)
}

async fn photograph_each(
    page: &Page,
    lanes: &AuthorLanes,
    slide_box: Rect,
    ids: &[String],
    canvas: Canvas,
    out: &mut BTreeMap<String, Paint>,
) -> Result<(), String> {
    for id in ids {
        call(page, "isolateCapture", &[json!(id)]).await?;
        let clip = Rect { x: slide_box.x, y: slide_box.y, width: f64::from(canvas.width), height: f64::from(canvas.height) };
        let shot = page.screenshot(ScreenshotOptions { clip: Some(clip), omit_background: true }).await?;
        if let Some(paint) = lanes.compute(move || paint_of_photograph(&shot, canvas)).await?? {
            out.insert(id.clone(), paint);
        }
    }
    Ok(())
}

/// The sentence that refuses a slide whose box is not the canvas.
fn slide_size_error(number: usize, width: f64, height: f64, canvas: Canvas) -> String {
    format!(
        "slide {number} measures {}×{} px; every section.slide is exactly {}×{}.",
        number_text(js_round(width)),
        number_text(js_round(height)),
        canvas.width,
        canvas.height
    )
}

fn number_text(value: f64) -> String {
    mixdog_js::number_to_string(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32, pixel: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
        let mut bytes = Vec::new();
        for y in 0..height {
            for x in 0..width {
                bytes.extend_from_slice(&pixel(x, y));
            }
        }
        Image::from_raw(width, height, 4, &bytes).unwrap().to_png().unwrap()
    }

    fn canvas() -> Canvas {
        Canvas { width: 8, height: 6, inch_width: 1.0, inch_height: 1.0 }
    }

    #[test]
    fn a_photograph_with_nothing_painted_is_left_out() {
        assert_eq!(paint_of_photograph(&png(8, 6, |_, _| [0, 0, 0, 0]), canvas()).unwrap(), None);
    }

    #[test]
    fn a_photograph_the_element_covers_edge_to_edge_is_the_whole_picture() {
        let shot = png(8, 6, |_, _| [10, 20, 30, 255]);
        let paint = paint_of_photograph(&shot, canvas()).unwrap().unwrap();
        assert_eq!(paint.png, STANDARD.encode(&shot));
        assert_eq!(paint.draw, json!({ "x": 0, "y": 0, "w": 8, "h": 6 }));
    }

    #[test]
    fn a_photograph_is_trimmed_to_what_was_painted_and_placed_in_css_pixels() {
        // Painted pixels at 2..6 x 4..8 of a photograph taken at twice the canvas density.
        let shot = png(16, 12, |x, y| if (4..8).contains(&x) && (2..6).contains(&y) { [200, 10, 10, 255] } else { [0, 0, 0, 0] });
        let paint = paint_of_photograph(&shot, canvas()).unwrap().unwrap();
        assert_eq!(paint.draw, json!({ "x": 2, "y": 1, "w": 2, "h": 2 }));
        let trimmed = Image::decode(&STANDARD.decode(&paint.png).unwrap()).unwrap();
        assert_eq!((trimmed.width(), trimmed.height()), (4, 4));
    }

    #[test]
    fn a_capture_item_takes_its_photograph_and_one_that_painted_nothing_goes() {
        let items = vec![
            json!({ "kind": "rect", "box": { "x": 0 } }),
            json!({ "kind": "capture", "id": "0-0", "alt": "" }),
            json!({ "kind": "capture", "id": "0-1", "alt": "" }),
        ];
        let mut drawn = BTreeMap::new();
        drawn.insert("0-0".to_string(), Paint { png: "AAAA".into(), draw: json!({ "x": 1, "y": 2, "w": 3, "h": 4 }) });
        let placed = place_captures(items, &drawn);
        assert_eq!(placed.len(), 2);
        assert_eq!(placed[0]["kind"], json!("rect"));
        assert_eq!(placed[1]["png"], json!("AAAA"));
        assert_eq!(placed[1]["draw"], json!({ "x": 1, "y": 2, "w": 3, "h": 4 }));
        assert_eq!(placed[1].as_object().unwrap().keys().collect::<Vec<_>>(), ["kind", "id", "alt", "png", "draw"]);
    }

    #[test]
    fn the_deck_canvas_is_1920_by_1080() {
        assert_eq!((HTML_CANVAS.width, HTML_CANVAS.height), (1920, 1080));
        assert_eq!((HTML_CANVAS.inch_width, HTML_CANVAS.inch_height), (13.333, 7.5));
    }

    #[test]
    fn the_slide_size_refusal_names_what_was_measured() {
        assert_eq!(slide_size_error(2, 1280.0, 720.4, HTML_CANVAS), "slide 2 measures 1280×720 px; every section.slide is exactly 1920×1080.");
    }

    #[test]
    fn unknown_icons_are_named_with_their_nearest_icons() {
        let error = unknown_icons_error(&["arrow-rite".to_string()]);
        assert!(error.starts_with("Unknown data-icon: ICON('arrow-rite') is not in the icon set ("), "{error}");
        assert!(error.contains("Nearest: "), "{error}");
        let two = unknown_icons_error(&["zzzzqqqq".to_string(), "yyyyqqqq".to_string()]);
        assert_eq!(two.matches("is not in the icon set").count(), 2);
    }

    #[test]
    fn the_page_script_holds_the_four_functions_the_measure_calls() {
        for name in ["function extractSlide(index)", "function isolateCapture(id)", "function showSlide(index)", "function injectIcons(table, viewBox)"] {
            assert!(PAGE_SCRIPT.contains(name), "{name}");
        }
        assert!(!PAGE_SCRIPT.contains("export "));
    }


    #[test]
    fn a_path_becomes_a_file_url() {
        let url = file_url(&std::env::temp_dir().join("deck source.html")).unwrap();
        assert!(url.starts_with("file:///"), "{url}");
        assert!(url.ends_with("/deck%20source.html"), "{url}");
    }
}


/// The `file:` URL of `path` (`pathToFileURL`).
pub fn file_url(path: &Path) -> Result<String, String> {
    let absolute = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().map_err(|error| error.to_string())?.join(path) };
    url::Url::from_file_path(&absolute).map(|url| url.to_string()).map_err(|()| format!("{} is not a path a browser can open", absolute.display()))
}
/// Lays an HTML deck out in the shared render browser and measures it.
///
/// A deck without a `<section class="slide">`, a slide that is not exactly the canvas and an icon the set does not
/// have are refused with the sentences Node threw. The browser is leased for the run and closed on every exit.
pub async fn measure_html_deck(
    endpoint: &dyn BrowserEndpoint,
    lanes: &AuthorLanes,
    note: &dyn WriteNote,
    html: &str,
    options: MeasureOptions<'_>,
) -> Result<Measured, RunError> {
    let MeasureOptions { source_path, shot_path, timeout, cancel, prepare } = options;
    lanes.write_file(source_path, html.as_bytes().to_vec()).await?;
    let browser = HtmlBrowser::launch(endpoint).await?;
    let work = |browser: std::sync::Arc<HtmlBrowser>| async move {
        let page = browser.new_page().await?;
        page.set_viewport(viewport(HTML_CANVAS, 1.0)).await?;
        page.goto(&file_url(source_path)?, WaitUntil::Load).await?;
        let canvas = match prepare {
            Some(prepare) => prepare(&page).await?,
            None => HTML_CANVAS,
        };
        if canvas != HTML_CANVAS {
            page.set_viewport(viewport(canvas, 1.0)).await?;
        }
        let missing = inject_icons(&page).await?;
        if !missing.is_empty() {
            return Err(unknown_icons_error(&missing));
        }
        let count = page.count("section.slide").await?;
        if count == 0 {
            return Err(format!(
                "The HTML holds no <section class=\"slide\">; every page is one section.slide on a {}×{} canvas.",
                canvas.width, canvas.height
            ));
        }
        let (mut slides, mut shots, mut notes, mut geometry) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for index in 0..count {
            call(&page, "showSlide", &[json!(index)]).await?;
            page.evaluate_expression("document.fonts.ready.then(() => true)").await?;
            let elements = page.query_all("section.slide").await?;
            let element = elements.get(index).ok_or_else(|| "Cannot read properties of undefined (reading 'boundingBox')".to_string())?;
            let slide_box = element.bounding_box().await?.ok_or_else(|| "Cannot read properties of null (reading 'width')".to_string())?;
            if js_round(slide_box.width) != f64::from(canvas.width) || js_round(slide_box.height) != f64::from(canvas.height) {
                return Err(slide_size_error(index + 1, slide_box.width, slide_box.height, canvas));
            }
            let shot = shot_path(index + 1);
            note.note_write(&shot);
            lanes.write_file(&shot, element.screenshot(false).await?).await?;
            shots.push(shot);
            let measured = call(&page, "extractSlide", &[json!(index)]).await?;
            for line in measured["notes"].as_array().map(Vec::as_slice).unwrap_or_default() {
                notes.push(format!("slide {}: {}", index + 1, line.as_str().unwrap_or_default()));
            }
            let findings = geometry::read_geometry(&page, index).await?;
            geometry.extend(geometry::slide_findings(index + 1, findings));
            let ids: Vec<String> = measured["captures"].as_array().map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect()).unwrap_or_default();
            let drawn = capture_rich_paint(&page, lanes, slide_box, &ids, canvas).await?;
            let items = place_captures(measured["items"].as_array().cloned().unwrap_or_default(), &drawn);
            let mut slide = Map::new();
            slide.insert("bg".into(), measured["bg"].clone());
            slide.insert("items".into(), Value::Array(items));
            slide.insert("notes".into(), measured["speakerNotes"].clone());
            slides.push(Value::Object(slide));
        }
        Ok(Measured { canvas, slides, shots, notes, geometry })
    };
    run_in_browser(browser, &cancel, timeout, work).await
}
