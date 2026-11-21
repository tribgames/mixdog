//! Images are JSON objects: `data` (base64 PNG), `page` or `pages`, `width`, `height`, and the `pageImages` a contact sheet
//! was composed from.

use base64::Engine;
use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use mixdog_js::math::{max, round, to_fixed};
use mixdog_js::{js_to_lowercase, json_number, number_to_string, to_number, to_number_of};
use mixdog_raster::Image;
use mixdog_raster::canvas::{Bitmap, Canvas, ImageData};
use serde_json::{Map, Value, json};

use crate::aesthetics::review_rendered_office_aesthetics;
use crate::aesthetics_metrics::rounded;
use crate::issue::issue_with;
use crate::{field, field_of, is_truthy};

/// Where the body of a flowing page that is not the last one must at least reach, as a share of the body region.
const PAGE_BODY_END_MIN: f64 = 0.7;

/// Node's `Buffer.from(data, 'base64')`: characters outside the alphabet are skipped, both alphabets are read,
/// reading stops at the first `=`, and padding may be missing.
pub(crate) fn node_base64(data: &str) -> Vec<u8> {
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true).with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let mut cleaned: String = data
        .chars()
        .take_while(|c| *c != '=')
        .filter_map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' => Some(c),
            '-' => Some('+'),
            '_' => Some('/'),
            _ => None,
        })
        .collect();
    if cleaned.len() % 4 == 1 {
        cleaned.pop();
    }
    LENIENT.decode(&cleaned).unwrap_or_default()
}

/// `loadImage(Buffer.from(data, 'base64'))`: the decoded picture, or the decoder's sentence. Anything but text is
/// refused the way `Buffer.from` refuses it.
pub(crate) fn decode_image(data: &Value) -> Result<Image, String> {
    let Value::String(text) = data else {
        return Err("The \"string\" argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.".to_owned());
    };
    Image::decode(&node_base64(text)).map_err(|error| error.to_string())
}

/// A canvas of `width` x `height` filled white, with `image` drawn at the corner (stretched over the canvas when
/// `stretch`), read back as straight RGBA: the page as the review reads it, the transparent parts on paper.
pub(crate) fn paint_on_white(image: Option<&Image>, width: u32, height: u32, stretch: bool) -> Result<ImageData, String> {
    let mut canvas = Canvas::new(width, height).map_err(|error| error.to_string())?;
    canvas.set_fill_color("#ffffff");
    canvas.fill_rect(0.0, 0.0, width as f32, height as f32);
    if let Some(image) = image {
        let bitmap = Bitmap::from_image(image).map_err(|error| error.to_string())?;
        if stretch {
            canvas.draw_image_scaled(&bitmap, 0.0, 0.0, width as f32, height as f32);
        } else {
            canvas.draw_image(&bitmap, 0.0, 0.0);
        }
    }
    canvas.get_image_data(0, 0, width, height).map_err(|error| error.to_string())
}

/// The page numbers an image stands for: its `pages` (as numbers), else its `page`.
fn image_pages(image: &Value) -> Vec<f64> {
    match field(image, "pages") {
        Some(Value::Array(pages)) if !pages.is_empty() => pages.iter().map(to_number).collect(),
        _ => {
            let page = to_number_of(field(image, "page"));
            vec![if page.is_nan() { 0.0 } else { page }]
        }
    }
}

/// A contact sheet (a deck past twelve pages) carries the page images it was composed from; the review reads those
/// pages and never the sheet itself.
pub fn rendered_page_images(images: &[Value]) -> Vec<Value> {
    let mut output = Vec::new();
    for image in images {
        match field(image, "pageImages") {
            Some(Value::Array(pages)) if !pages.is_empty() => {
                for page in pages {
                    let mut copy = page.as_object().cloned().unwrap_or_default();
                    copy.insert("pages".to_owned(), json!([json_number(to_number_of(field(page, "page")))]));
                    output.push(Value::Object(copy));
                }
            }
            _ => output.push(image.clone()),
        }
    }
    output
}

/// One page's ink reading.
struct PageInk {
    page: f64,
    width: f64,
    height: f64,
    ink_coverage: f64,
    horizontal_span: f64,
    vertical_span: f64,
    body_vertical_span: f64,
    body_end: f64,
    lower_body_ink_ratio: f64,
    left_margin: f64,
    right_margin: f64,
}

impl PageInk {
    fn to_value(&self) -> Value {
        let mut map = Map::new();
        for (key, value) in [
            ("page", self.page),
            ("width", self.width),
            ("height", self.height),
            ("inkCoverage", self.ink_coverage),
            ("horizontalSpan", self.horizontal_span),
            ("verticalSpan", self.vertical_span),
            ("bodyVerticalSpan", self.body_vertical_span),
            ("bodyEnd", self.body_end),
            ("lowerBodyInkRatio", self.lower_body_ink_ratio),
            ("leftMargin", self.left_margin),
            ("rightMargin", self.right_margin),
        ] {
            map.insert(key.to_owned(), json_number(value));
        }
        Value::Object(map)
    }
}

fn rendered_page_metric(image: &Value) -> Result<Option<PageInk>, String> {
    let page_numbers = image_pages(image);
    let Some(data) = field(image, "data").filter(|data| is_truthy(Some(*data))) else {
        return Ok(None);
    };
    if page_numbers.len() != 1 {
        return Ok(None);
    }
    let loaded = decode_image(data)?;
    let (width, height) = (loaded.width(), loaded.height());
    let pixels = paint_on_white(Some(&loaded), width, height, false)?;
    let pixels = pixels.data();
    let (canvas_width, canvas_height) = (f64::from(width), f64::from(height));
    let step = max(1.0, ((canvas_width * canvas_height) / 1_000_000.0).sqrt().floor()) as usize;
    let step_size = step as f64;
    let (mut sampled, mut ink) = (0.0f64, 0.0f64);
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (canvas_width, canvas_height, -1.0f64, -1.0f64);
    let (mut body_ink, mut lower_body_ink) = (0.0f64, 0.0f64);
    let (mut body_min_y, mut body_max_y) = (canvas_height, -1.0f64);
    let body_top = canvas_height * 0.08;
    let body_bottom = canvas_height * 0.9;
    let lower_body_top = canvas_height * 0.52;
    for y in (0..height as usize).step_by(step) {
        for x in (0..width as usize).step_by(step) {
            let offset = (y * width as usize + x) * 4;
            sampled += 1.0;
            if pixels[offset] > 247 && pixels[offset + 1] > 247 && pixels[offset + 2] > 247 {
                continue;
            }
            ink += 1.0;
            let (fx, fy) = (x as f64, y as f64);
            min_x = min_x.min(fx);
            min_y = min_y.min(fy);
            max_x = max_x.max(fx);
            max_y = max_y.max(fy);
            if fy >= body_top && fy <= body_bottom {
                body_ink += 1.0;
                body_min_y = body_min_y.min(fy);
                body_max_y = body_max_y.max(fy);
                if fy >= lower_body_top {
                    lower_body_ink += 1.0;
                }
            }
        }
    }
    let any_ink = max_x >= min_x;
    let horizontal_span = if any_ink { (max_x - min_x + step_size) / canvas_width } else { 0.0 };
    let vertical_span = if any_ink { (max_y - min_y + step_size) / canvas_height } else { 0.0 };
    let left_margin = if any_ink { min_x / canvas_width } else { 1.0 };
    let right_margin = if any_ink { max(0.0, canvas_width - max_x - step_size) / canvas_width } else { 1.0 };
    let any_body = body_max_y >= body_min_y;
    let body_vertical_span = if any_body { (body_max_y - body_min_y + step_size) / (body_bottom - body_top) } else { 0.0 };
    let body_end = if any_body { (1.0f64).min((body_max_y + step_size - body_top) / (body_bottom - body_top)) } else { 0.0 };
    Ok(Some(PageInk {
        page: page_numbers[0],
        width: canvas_width,
        height: canvas_height,
        ink_coverage: if sampled != 0.0 { rounded(ink / sampled, 4) } else { 0.0 },
        horizontal_span: rounded(horizontal_span, 4),
        vertical_span: rounded(vertical_span, 4),
        body_vertical_span: rounded(body_vertical_span, 4),
        body_end: rounded(body_end, 4),
        lower_body_ink_ratio: if body_ink != 0.0 { rounded(lower_body_ink / body_ink, 4) } else { 0.0 },
        left_margin: rounded(left_margin, 4),
        right_margin: rounded(right_margin, 4),
    }))
}

/// `isSmallWorksheetDocument(document)`: a worksheet that fits a page at full scale is small, not scaled down: its
/// print reads at the size the author set, however little of the page it uses.
pub fn is_small_worksheet_document(document: &Value) -> bool {
    let Some(Value::Array(sheets)) = field(document, "sheets") else {
        return false;
    };
    let number_or = |value: Option<&Value>, fallback: f64| {
        let number = to_number_of(value);
        if number.is_nan() || number == 0.0 { fallback } else { number }
    };
    !sheets.is_empty()
        && sheets.iter().all(|sheet| {
            number_or(field(sheet, "rows"), 0.0) < 40.0
                && number_or(field(sheet, "columns"), 0.0) < 12.0
                && number_or(field_of(field(sheet, "pageSetup"), "zoom"), 100.0) >= 100.0
        })
}

/// The options of [`review_rendered_office_pages`].
#[derive(Clone, Debug)]
pub struct RenderedOptions {
    pub format: String,
    /// Page number to role: a string, or an object with `visualType`, `slideRole` or `role`.
    pub page_roles: Value,
    pub small_worksheet: bool,
    /// The length of the document; 0 reads it from the images.
    pub page_count: f64,
    pub designed_pages: bool,
    /// Page numbers that open with a deliberate forced break (CSS `break-before`, a Word page break or a
    /// `pageBreakBefore` paragraph); `None` when there is no authored source to read them from.
    pub forced_break_pages: Option<Vec<f64>>,
}

impl Default for RenderedOptions {
    fn default() -> Self {
        Self { format: String::new(), page_roles: json!({}), small_worksheet: false, page_count: 0.0, designed_pages: false, forced_break_pages: None }
    }
}

fn render_issue(code: &str, path: &str, message: &str, severity: &str) -> Value {
    issue_with(code, path, message, "render-review", severity)
}

/// A whole-number percentage as text (`Math.round(share * 100)`).
fn percent(share: f64) -> String {
    number_to_string(round(share * 100.0))
}

/// The faults one page's ink shows in a docx, xlsx or pdf review: a blank page stops the rest; a flowing page that is not the
/// last ends its body early when a block it may not split went to the next page; designed pages are left to the deck's review.
fn page_faults(metric: &PageInk, format: &str, options: &RenderedOptions, last_page: f64) -> Vec<Value> {
    let mut issues = Vec::new();
    let forced_breaks = options.forced_break_pages.as_deref();
    let forced = |page: f64| forced_breaks.is_some_and(|pages| pages.contains(&page));
    let path = format!("/page[{}]", number_to_string(metric.page));
    if metric.ink_coverage < 0.0015 {
        issues.push(render_issue("blank_page", &path, "Rendered page is effectively blank.", "warning"));
        return issues;
    }
    if format == "docx" && (metric.left_margin < 0.002 || metric.right_margin < 0.002) {
        issues.push(render_issue(
            "content_touches_page_edge",
            &path,
            "Rendered document content touches a horizontal page edge and may be clipped.",
            "warning",
        ));
    }
    let flowing = matches!(format, "docx" | "pdf") && !options.designed_pages;
    let ends_before_forced_break = forced(metric.page + 1.0);
    if flowing && metric.page > 1.0 && !ends_before_forced_break && metric.page < last_page && metric.body_end < PAGE_BODY_END_MIN {
        let empty = percent(1.0 - metric.body_end);
        let ignore = if forced_breaks.is_some() { "" } else { " If the next page opens with a deliberate forced break, ignore this." };
        issues.push(render_issue(
            "page_bottom_empty",
            &path,
            &format!(
                "The body stops {}% of the way down page {} and the next page goes on: {empty}% of its body region stands empty. A block kept whole (a table, a figure with its caption, a heading kept with the next block) usually moved on; let a long table break across the page, move a shorter block up, or tighten what comes before.{ignore}",
                percent(metric.body_end),
                number_to_string(metric.page),
            ),
            "warning",
        ));
        return issues;
    }
    let deliberate_short = ends_before_forced_break || (forced(metric.page) && metric.page >= last_page);
    if matches!(format, "docx" | "pdf")
        && metric.page > 1.0
        && !deliberate_short
        && ((metric.ink_coverage < 0.025 && metric.vertical_span < 0.22) || (metric.body_vertical_span < 0.34 && metric.lower_body_ink_ratio < 0.08))
    {
        issues.push(render_issue(
            "sparse_page",
            &path,
            &format!(
                "Rendered body spans {}% of the body region; inspect paragraph flow and intentional whitespace.",
                to_fixed(metric.body_vertical_span * 100.0, 1)
            ),
            "warning",
        ));
    }
    if format == "xlsx"
        && !options.small_worksheet
        && metric.ink_coverage < 0.095
        && ((metric.horizontal_span < 0.7 && metric.vertical_span < 0.5) || (metric.height > metric.width * 1.2 && metric.vertical_span < 0.3))
    {
        issues.push(render_issue("worksheet_print_too_small", &path, "Worksheet content is scaled into a small area of the rendered page.", "warning"));
    }
    issues
}

/// `{ ok, format, pages, aesthetics, issues }`; an image that cannot be decoded is an error.
pub fn review_rendered_office_pages(images: &[Value], options: &RenderedOptions) -> Result<Value, String> {
    let normalized = js_to_lowercase(&options.format);
    let page_images = rendered_page_images(images);
    let last_page =
        if options.page_count.is_nan() || options.page_count == 0.0 { page_images.iter().flat_map(image_pages).fold(0.0, max) } else { options.page_count };
    let mut pages = Vec::new();
    let mut issues = Vec::new();
    for image in &page_images {
        let Some(metric) = rendered_page_metric(image)? else { continue };
        pages.push(metric.to_value());
        if matches!(normalized.as_str(), "docx" | "xlsx" | "pdf") {
            issues.extend(page_faults(&metric, &normalized, options, last_page));
        }
    }
    let aesthetics = review_rendered_office_aesthetics(&page_images, &normalized, &options.page_roles)?;
    if let Some(Value::Array(found)) = aesthetics.get("issues") {
        issues.extend(found.iter().cloned());
    }
    Ok(json!({
        "ok": issues.is_empty(),
        "format": normalized,
        "pages": pages,
        "aesthetics": aesthetics,
        "issues": issues,
    }))
}

#[cfg(test)]
pub(crate) mod test_pages {
    use base64::Engine;
    use mixdog_raster::canvas::Canvas;
    use serde_json::{Value, json};

    /// Base64 of the PNG of a `width` x `height` canvas painted by `paint`.
    pub(crate) fn painted(width: u32, height: u32, paint: impl FnOnce(&mut Canvas)) -> String {
        let mut canvas = Canvas::new(width, height).expect("canvas");
        paint(&mut canvas);
        base64::engine::general_purpose::STANDARD.encode(canvas.to_png().expect("png"))
    }

    /// `context.fillStyle = colour; context.fillRect(x, y, w, h)`.
    pub(crate) fn rect(canvas: &mut Canvas, colour: &str, x: f32, y: f32, width: f32, height: f32) {
        assert!(canvas.set_fill_color(colour));
        canvas.fill_rect(x, y, width, height);
    }

    /// A page image of the review: the page number, its size and a PNG painted on white.
    pub(crate) fn page_image(page: u32, width: u32, height: u32, paint: impl FnOnce(&mut Canvas)) -> Value {
        let data = painted(width, height, |canvas| {
            rect(canvas, "#FFFFFF", 0.0, 0.0, width as f32, height as f32);
            paint(canvas);
        });
        json!({ "page": page, "width": width, "height": height, "mimeType": "image/png", "data": data })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::test_pages::{page_image, rect};
    use super::*;

    /// A 240 x 340 page whose text lines run from 10% of the height down to `end` of it, with a footer line at 95%.
    fn page(number: u32, end: f64) -> Value {
        page_image(number, 240, 340, |canvas| {
            let mut y = 34.0f64;
            while y < 340.0 * end {
                rect(canvas, "#111111", 24.0, y as f32, 190.0, 5.0);
                y += 12.0;
            }
            rect(canvas, "#111111", 180.0, 323.0, 30.0, 4.0);
        })
    }

    fn options(format: &str, page_count: f64, forced: Option<Vec<f64>>) -> RenderedOptions {
        RenderedOptions { format: format.to_owned(), page_count, forced_break_pages: forced, ..RenderedOptions::default() }
    }

    fn found(review: &Value, code: &str) -> Vec<(String, String)> {
        review["issues"]
            .as_array()
            .expect("issues")
            .iter()
            .filter(|entry| entry["code"] == code)
            .map(|entry| (entry["path"].as_str().expect("path").to_owned(), entry["severity"].as_str().expect("severity").to_owned()))
            .collect()
    }

    fn pair(path: &str) -> (String, String) {
        (path.to_owned(), "warning".to_owned())
    }

    #[test]
    fn a_page_that_is_not_the_last_stops_early_and_its_empty_foot_is_reported_the_footer_line_aside() {
        let images = [page(1, 0.88), page(2, 0.5), page(3, 0.88), page(4, 0.3)];
        let review = review_rendered_office_pages(&images, &options("docx", 4.0, Some(Vec::new()))).expect("review");
        assert_eq!(found(&review, "page_bottom_empty"), [pair("/page[2]")]);
        let metric = review["pages"].as_array().expect("pages").iter().find(|entry| entry["page"] == 2).expect("page 2");
        let end = metric["bodyEnd"].as_f64().expect("bodyEnd");
        assert!(end > 0.4 && end < 0.6, "{metric}");
    }

    #[test]
    fn the_last_page_may_end_anywhere_a_short_cover_page_is_exempt_and_designed_pages_are_not_flowed() {
        let two = [page(1, 0.88), page(2, 0.4)];
        assert!(found(&review_rendered_office_pages(&two, &options("pdf", 2.0, None)).expect("review"), "page_bottom_empty").is_empty());
        let cover = [page(1, 0.45), page(2, 0.88)];
        assert!(found(&review_rendered_office_pages(&cover, &options("docx", 2.0, None)).expect("review"), "page_bottom_empty").is_empty());
        let three = [page(1, 0.88), page(2, 0.5), page(3, 0.88)];
        let designed = RenderedOptions { designed_pages: true, ..options("pdf", 3.0, None) };
        assert!(found(&review_rendered_office_pages(&three, &designed).expect("review"), "page_bottom_empty").is_empty());
    }

    #[test]
    fn a_page_rendered_alone_is_held_against_the_document_length_not_the_images_it_came_with() {
        let review = review_rendered_office_pages(&[page(2, 0.5)], &options("docx", 3.0, Some(Vec::new()))).expect("review");
        assert_eq!(found(&review, "page_bottom_empty"), [pair("/page[2]")]);
    }

    #[test]
    fn a_short_chapter_page_before_a_forced_break_or_a_last_page_that_opens_one_is_not_sparse() {
        let pages = [page(1, 0.88), page(2, 0.2), page(3, 0.2)];
        let with_breaks = review_rendered_office_pages(&pages, &options("pdf", 3.0, Some(vec![2.0, 3.0]))).expect("review");
        assert!(found(&with_breaks, "sparse_page").is_empty());
        let without = review_rendered_office_pages(&pages, &options("pdf", 3.0, Some(Vec::new()))).expect("review");
        assert_eq!(found(&without, "sparse_page"), [pair("/page[3]")]);
    }

    #[test]
    fn a_page_before_a_deliberate_forced_break_is_exempt_and_without_break_data_the_warning_stands() {
        let pages = [page(1, 0.88), page(2, 0.5), page(3, 0.88)];
        let exempt = review_rendered_office_pages(&pages, &options("docx", 3.0, Some(vec![3.0]))).expect("review");
        assert!(found(&exempt, "page_bottom_empty").is_empty());
        let unknown = review_rendered_office_pages(&pages, &options("docx", 3.0, None)).expect("review");
        assert_eq!(found(&unknown, "page_bottom_empty"), [pair("/page[2]")]);
        let message = unknown["issues"][0]["message"].as_str().expect("message");
        assert!(message.ends_with("If the next page opens with a deliberate forced break, ignore this."), "{message}");
    }

    #[test]
    fn a_blank_page_and_a_page_touching_the_edge_are_reported() {
        let blank = page_image(1, 240, 340, |_| {});
        let edge = page_image(2, 240, 340, |canvas| rect(canvas, "#111111", 0.0, 40.0, 240.0, 200.0));
        let review = review_rendered_office_pages(&[blank, edge], &options("docx", 2.0, None)).expect("review");
        assert_eq!(found(&review, "blank_page"), [pair("/page[1]")]);
        assert_eq!(found(&review, "content_touches_page_edge"), [pair("/page[2]")]);
    }

    #[test]
    fn a_worksheet_scaled_into_a_corner_is_reported_unless_it_is_small() {
        let corner = page_image(1, 300, 400, |canvas| rect(canvas, "#222222", 10.0, 10.0, 90.0, 60.0));
        let review = review_rendered_office_pages(&[corner.clone()], &options("xlsx", 1.0, None)).expect("review");
        assert_eq!(found(&review, "worksheet_print_too_small"), [pair("/page[1]")]);
        let small = RenderedOptions { small_worksheet: true, ..options("xlsx", 1.0, None) };
        assert!(found(&review_rendered_office_pages(&[corner], &small).expect("review"), "worksheet_print_too_small").is_empty());
        assert!(is_small_worksheet_document(&json!({ "sheets": [{ "rows": 10, "columns": 4, "pageSetup": { "zoom": 100 } }] })));
        assert!(!is_small_worksheet_document(&json!({ "sheets": [{ "rows": 10, "columns": 4, "pageSetup": { "zoom": 80 } }] })));
        assert!(!is_small_worksheet_document(&json!({ "sheets": [{ "rows": 40, "columns": 4 }] })));
        assert!(!is_small_worksheet_document(&json!({ "sheets": [] })));
    }

    #[test]
    fn a_contact_sheet_is_read_as_the_pages_it_carries() {
        let sheet = json!({ "page": 1, "pages": [1, 2], "data": "x", "pageImages": [{ "page": 1, "data": "a" }, { "page": 2, "data": "b" }] });
        let plain = json!({ "page": 3, "data": "c" });
        let unfolded = rendered_page_images(&[sheet, plain.clone()]);
        assert_eq!(unfolded, [json!({ "page": 1, "data": "a", "pages": [1] }), json!({ "page": 2, "data": "b", "pages": [2] }), plain]);
    }

    #[test]
    fn data_that_is_not_an_image_fails_the_review() {
        let broken = json!({ "page": 1, "data": "not an image" });
        assert!(review_rendered_office_pages(&[broken], &options("docx", 1.0, None)).is_err());
        let absent = json!({ "page": 1 });
        let review = review_rendered_office_pages(&[absent], &options("docx", 1.0, None)).expect("review");
        assert_eq!(review["pages"], json!([]));
    }
}
