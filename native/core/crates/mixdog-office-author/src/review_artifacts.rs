//! `authoring/pptx-review-artifacts.mjs`: what the author call and the standalone render hand back besides the
//! pages: the composition receipt (an authored deck read against the brief it was written to) and the contact sheet
//! written beside the deck. Author and standalone render expose the same review artifacts; QA uses the raw page
//! preview, so contact sheets never enter pixel-level page checks.
//!
//! The receipt itself (`pptx-receipt.mjs`, the rendered air of `quality/render-air.mjs`, the session snapshot it is
//! read from) belongs to the engine; [`Receipts`] is the seam through which this module asks for them.

use mixdog_fonts::registry::Registry;
use mixdog_fsio::WriteProof;
use mixdog_js::to_number_of;
use mixdog_office_base::values::truthy;
use mixdog_office_base::write_note::WriteNote;
use serde_json::{Map, Value};

use crate::contact_sheet::{ContactSheet, DEFAULT_WIDTH, write_contact_sheet};

/// Up to four slides arrive as page images the reader already sees in order; the sheet's pixels repeat them. The
/// file is written either way.
pub const CONTACT_SHEET_IMAGE_MIN_PAGES: usize = 4;

/// What a review reads of the session the deck belongs to.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct ReviewSession {
    /// A PDF of designed pages (`authoredFrame`): the receipt its working deck was read into at author time.
    pub authored_frame: bool,
    /// That receipt (`frameReceipt`).
    pub frame_receipt: Option<Value>,
    /// The deck was written by `author` (`authored === true`), so it has a brief to be read against.
    pub authored: bool,
}

/// The engine's receipt functions the review calls.
pub trait Receipts {
    /// `readCompositionReceipt`: the session's saved deck read against its brief (the snapshot with styles, then
    /// `compositionReceipt`); `None` when the snapshot cannot be taken.
    fn composition_receipt(&self) -> Option<Value>;
    /// `renderedAirByPage` of the page images, then `attachRenderedAir` onto the receipt; the receipt stays as it is
    /// when the air cannot be measured.
    fn attach_rendered_air(&self, receipt: &mut Value, images: &[Value]);
    /// `receiptForDelivery`: the receipt as the result carries it.
    fn for_delivery(&self, receipt: Value) -> Value;
}

/// `Number(value) || 0`.
fn count_of(value: Option<&Value>) -> f64 {
    let number = to_number_of(value);
    if number.is_nan() { 0.0 } else { number }
}

/// The receipt of the deck behind `preview`, or `None` when it has none.
///
/// The receipt reads an authored deck against the brief it was written to. A deck opened for editing has no brief, and
/// its pages are reviewed as edits, so its render carries the pages alone: a template's receipt ran to fifteen thousand
/// characters beside three page images. A PDF of designed pages keeps the receipt its working deck was read into at
/// author time (the PDF itself holds no shapes); each render reads its own copy against the printed pixels.
fn receipt_of(session: &ReviewSession, receipts: &dyn Receipts, preview: &Value, images: &[Value]) -> Option<Value> {
    let found = if session.authored_frame {
        session.frame_receipt.clone()
    } else if session.authored {
        receipts.composition_receipt()
    } else {
        None
    };
    let mut receipt = found.filter(truthy)?;
    receipts.attach_rendered_air(&mut receipt, images);
    // A render of some pages answers for those pages; the deck line still reads the whole sequence.
    let mut rendered: Vec<f64> = Vec::new();
    for image in images {
        let page = to_number_of(image.get("page"));
        if page > 0.0 && !rendered.contains(&page) {
            rendered.push(page);
        }
    }
    if !rendered.is_empty() && (rendered.len() as f64) < count_of(preview.get("pageCount")) {
        if let Some(slides) = receipt.get_mut("slides").and_then(Value::as_array_mut) {
            slides.retain(|slide| rendered.contains(&to_number_of(slide.get("slide"))));
        }
    }
    Some(receipts.for_delivery(receipt))
}

/// The preview with the review artifacts added: `receipt` where the deck has one, `contactSheet` (the sheet without its
/// pixels) where the deck has two pages or more, and the sheet as a last image (`page: 0`) past four slides. A sheet
/// that could not be made leaves the result without one.
pub fn pptx_review_artifacts<P: WriteProof>(
    proof: &P,
    registry: &Registry,
    note: &dyn WriteNote,
    session: &ReviewSession,
    receipts: &dyn Receipts,
    preview: &Value,
) -> Value {
    let mut result: Map<String, Value> = preview.as_object().cloned().unwrap_or_default();
    let images: Vec<Value> = match preview.get("_images") {
        Some(Value::Array(list)) => list.clone(),
        _ => Vec::new(),
    };
    result.insert("_images".to_owned(), Value::Array(images.clone()));
    if let Some(receipt) = receipt_of(session, receipts, preview, &images) {
        result.insert("receipt".to_owned(), receipt);
    }
    // A preview without a string `output` has nowhere to put the sheet (Node's `extname` throws and the sheet is skipped).
    if let Some(output) = preview.get("output").and_then(Value::as_str)
        && let Ok(Some(sheet)) = write_contact_sheet(proof, registry, note, &images, output, DEFAULT_WIDTH)
    {
        attach_sheet(&mut result, &sheet, preview, images.len());
    }
    Value::Object(result)
}

fn attach_sheet(result: &mut Map<String, Value>, sheet: &ContactSheet, preview: &Value, image_count: usize) {
    let meta = sheet.meta();
    result.insert("contactSheet".to_owned(), Value::Object(meta.clone()));
    let declared = count_of(preview.get("pageCount"));
    let pages = if declared == 0.0 { image_count as f64 } else { declared };
    if pages > CONTACT_SHEET_IMAGE_MIN_PAGES as f64 {
        let mut image = Map::new();
        image.insert("page".to_owned(), Value::from(0));
        image.extend(meta);
        image.insert("data".to_owned(), Value::String(sheet.data.clone()));
        if let Some(Value::Array(list)) = result.get_mut("_images") {
            list.push(Value::Object(image));
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;
    use mixdog_fsio::Unlaned;
    use mixdog_office_base::write_note::NoWriteNote;
    use mixdog_raster::Image;
    use serde_json::json;

    use super::*;

    /// Receipts that answer from fixed values and remember what they were asked.
    struct Fixed {
        composed: Option<Value>,
        asked: Mutex<Vec<&'static str>>,
    }

    impl Fixed {
        fn new(composed: Option<Value>) -> Self {
            Self { composed, asked: Mutex::new(Vec::new()) }
        }
    }

    impl Receipts for Fixed {
        fn composition_receipt(&self) -> Option<Value> {
            self.asked.lock().expect("lock").push("composition");
            self.composed.clone()
        }

        fn attach_rendered_air(&self, receipt: &mut Value, _images: &[Value]) {
            self.asked.lock().expect("lock").push("air");
            receipt["air"] = json!(true);
        }

        fn for_delivery(&self, mut receipt: Value) -> Value {
            self.asked.lock().expect("lock").push("delivery");
            receipt["delivered"] = json!(true);
            receipt
        }
    }

    fn page(number: u32) -> Value {
        let image = Image::from_raw(8, 6, 3, &[225; 8 * 6 * 3]).expect("raw image");
        json!({ "page": number, "data": STANDARD.encode(image.to_png().expect("png")), "mimeType": "image/png" })
    }

    fn preview(dir: &std::path::Path, count: u32, declared: Option<u32>) -> Value {
        let mut map = json!({ "output": dir.join(format!("deck-{count}.pdf")).display().to_string(), "_images": (1..=count).map(page).collect::<Vec<_>>() });
        if let Some(declared) = declared {
            map["pageCount"] = json!(declared);
        }
        map
    }

    fn registry() -> Registry {
        let face = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../mixdog-pdf/assets/standard_fonts/LiberationSans-Regular.ttf");
        let mut registry = Registry::new();
        registry.register_file(&Unlaned, &face, Some("Test Sans")).expect("the tracked face registers");
        registry
    }

    fn review(session: &ReviewSession, receipts: &Fixed, preview: &Value) -> Value {
        pptx_review_artifacts(&Unlaned, &registry(), &NoWriteNote, session, receipts, preview)
    }

    #[test]
    fn the_sheet_image_rides_along_only_past_four_slides_and_its_file_is_always_written() {
        let dir = tempfile::tempdir().expect("dir");
        let receipts = Fixed::new(None);
        let short = review(&ReviewSession::default(), &receipts, &preview(dir.path(), 3, Some(3)));
        let written = short["contactSheet"]["path"].as_str().expect("the sheet is written");
        assert!(mixdog_fsio::read(&Unlaned, written).is_ok(), "the sheet file is written");
        assert_eq!(short["_images"].as_array().expect("images").len(), 3, "three page images, no sheet image");
        let long = review(&ReviewSession::default(), &receipts, &preview(dir.path(), 6, Some(6)));
        let images = long["_images"].as_array().expect("images");
        assert_eq!(images.len(), 7, "six page images and the sheet");
        assert_eq!(images[6]["page"], json!(0));
        assert_eq!(images[6]["pages"], json!([1, 2, 3, 4, 5, 6]));
        assert!(images[6]["data"].as_str().is_some_and(|data| !data.is_empty()));
        assert!(long["contactSheet"].get("data").is_none(), "the result's sheet lists no pixels");
        assert!(long.get("receipt").is_none(), "a deck opened for editing carries no receipt");
        assert!(receipts.asked.lock().expect("lock").is_empty());
    }

    #[test]
    fn the_declared_page_count_decides_and_one_page_has_no_sheet() {
        let dir = tempfile::tempdir().expect("dir");
        let receipts = Fixed::new(None);
        let declared = review(&ReviewSession::default(), &receipts, &preview(dir.path(), 3, Some(8)));
        assert_eq!(declared["_images"].as_array().expect("images").len(), 4);
        let unnamed = review(&ReviewSession::default(), &receipts, &preview(dir.path(), 5, None));
        assert_eq!(unnamed["_images"].as_array().expect("images").len(), 6);
        let one = review(&ReviewSession::default(), &receipts, &preview(dir.path(), 1, Some(1)));
        assert!(one.get("contactSheet").is_none());
        assert_eq!(one["_images"].as_array().expect("images").len(), 1);
    }

    #[test]
    fn a_sheet_that_cannot_be_made_leaves_the_pages_alone() {
        let dir = tempfile::tempdir().expect("dir");
        let mut broken = preview(dir.path(), 3, Some(3));
        broken["_images"][1]["data"] = json!("AAAA");
        let result = review(&ReviewSession::default(), &Fixed::new(None), &broken);
        assert!(result.get("contactSheet").is_none());
        assert_eq!(result["_images"].as_array().expect("images").len(), 3);
    }

    #[test]
    fn a_preview_without_an_output_gets_no_sheet() {
        let dir = tempfile::tempdir().expect("dir");
        let mut nowhere = preview(dir.path(), 5, Some(5));
        nowhere.as_object_mut().expect("object").remove("output");
        let result = review(&ReviewSession::default(), &Fixed::new(None), &nowhere);
        assert!(result.get("contactSheet").is_none());
        assert_eq!(result["_images"].as_array().expect("images").len(), 5);
    }

    #[test]
    fn an_authored_deck_carries_its_receipt_for_the_pages_rendered() {
        let dir = tempfile::tempdir().expect("dir");
        let composed = json!({ "deck": "line", "slides": [{ "slide": 1 }, { "slide": 2 }, { "slide": 3 }, { "slide": 4 }] });
        let receipts = Fixed::new(Some(composed));
        let session = ReviewSession { authored: true, ..ReviewSession::default() };
        let mut partial = preview(dir.path(), 2, Some(4));
        partial["_images"][1]["page"] = json!(3);
        let result = review(&session, &receipts, &partial);
        assert_eq!(result["receipt"]["slides"], json!([{ "slide": 1 }, { "slide": 3 }]));
        assert_eq!(result["receipt"]["air"], json!(true));
        assert_eq!(result["receipt"]["delivered"], json!(true));
        assert_eq!(*receipts.asked.lock().expect("lock"), ["composition", "air", "delivery"]);
        let whole = review(&session, &receipts, &preview(dir.path(), 4, Some(4)));
        assert_eq!(whole["receipt"]["slides"].as_array().expect("slides").len(), 4);
    }

    #[test]
    fn a_designed_pdf_keeps_the_receipt_of_its_working_deck() {
        let dir = tempfile::tempdir().expect("dir");
        let receipts = Fixed::new(Some(json!({ "from": "snapshot" })));
        let framed = ReviewSession { authored_frame: true, frame_receipt: Some(json!({ "from": "frame" })), authored: true };
        let result = review(&framed, &receipts, &preview(dir.path(), 2, Some(2)));
        assert_eq!(result["receipt"]["from"], json!("frame"));
        assert!(!receipts.asked.lock().expect("lock").contains(&"composition"));
        let without = ReviewSession { authored_frame: true, frame_receipt: None, authored: true };
        assert!(review(&without, &receipts, &preview(dir.path(), 2, Some(2))).get("receipt").is_none());
        let unreadable = ReviewSession { authored: true, ..ReviewSession::default() };
        assert!(review(&unreadable, &Fixed::new(None), &preview(dir.path(), 2, Some(2))).get("receipt").is_none());
    }

    #[test]
    fn the_result_keeps_the_previews_keys_in_order_and_adds_its_own() {
        let dir = tempfile::tempdir().expect("dir");
        let mut extra = preview(dir.path(), 5, Some(5));
        extra["renderer"] = json!("x");
        let result = review(&ReviewSession::default(), &Fixed::new(None), &extra);
        let keys: Vec<&str> = result.as_object().expect("object").keys().map(String::as_str).collect();
        assert_eq!(keys, ["output", "_images", "pageCount", "renderer", "contactSheet"]);
    }
}
