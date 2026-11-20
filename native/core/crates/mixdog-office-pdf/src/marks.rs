//! Where a mark lands (`pdf/pdf-marks.mjs`): the display to user space mapping on rotated pages and the text-measured
//! target boxes that `highlight` and `add_link` draw on.
//!
//! `highlight` and `add_link` take a box in bottom-left points, or `find`, which measures every match on the selected
//! pages of the document as it stands in this batch (earlier operations included) so the boxes land on the real text.
//! Measuring means serializing the document; the measurement carries the bytes and the pages already measured, and
//! because marks do not move text, consecutive marks share one measurement (the adapter drops it at any other
//! operation). Saving here leaves the document as it is, so the batch continues on the same value: the reload Node did
//! after pdf-lib cached what it serialized has nothing to repair.

use std::collections::HashMap;

use mixdog_fsio::ReadProof;
use mixdog_js::{js_trim, json_number, to_number_of, value_to_string};
use mixdog_office_base::values::truthy;
use mixdog_pdf::write::{PdfDocument, SaveOptions};
use serde_json::{Map, Value};

use crate::analysis::layout::{LayoutOptions, PageLayout, PdfLayout, extract_pdf_text_layout};
use crate::analysis::round2;
use crate::document::{AnalysisError, PdfSource};
use crate::edit_document::{js_string, selected_edit_pages};
use crate::limits::MAX_PDF_ANALYSIS_PAGES;
use crate::search::{SearchOptions, find_pdf_text};

/// A mark's target in user space: the 0-based page, the box in bottom-left points, and the text it measured (a match;
/// a box given by number has none).
#[derive(Debug, Clone, PartialEq)]
pub struct MarkBox {
    pub index: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub text: Option<String>,
}

/// What a mark measured: the bytes of the document when it was measured and the layout of each page read from them.
#[derive(Debug, Default)]
pub struct Measure {
    bytes: Vec<u8>,
    pages: HashMap<usize, PageLayout>,
}

/// A point on the page as displayed (bottom-left origin, after the page's own rotation) back to the user space a
/// drawing operator writes in.
pub fn display_point_to_user(spin: i64, width: f64, height: f64, x: f64, y: f64) -> (f64, f64) {
    match spin {
        90 => (width - y, x),
        180 => (width - x, height - y),
        270 => (y, height - x),
        _ => (x, y),
    }
}

/// Display coordinates (top-left, page as shown) back to PDF user space through the inverse of pdf.js's page
/// transform; the four corners keep a rotated box honest. Returns `(x, y, width, height)`.
pub fn display_to_user(transform: &[f64; 6], x: f64, top: f64, width: f64, height: f64) -> (f64, f64, f64, f64) {
    let [a, b, c, d, e, f] = *transform;
    let det = a * d - b * c;
    let invert = |(px, py): (f64, f64)| ((d * (px - e) - c * (py - f)) / det, (-b * (px - e) + a * (py - f)) / det);
    let corners = [(x, top), (x + width, top), (x, top + height), (x + width, top + height)].map(invert);
    let low_x = corners.iter().map(|corner| corner.0).fold(f64::INFINITY, f64::min);
    let high_x = corners.iter().map(|corner| corner.0).fold(f64::NEG_INFINITY, f64::max);
    let low_y = corners.iter().map(|corner| corner.1).fold(f64::INFINITY, f64::min);
    let high_y = corners.iter().map(|corner| corner.1).fold(f64::NEG_INFINITY, f64::max);
    (low_x, low_y, high_x - low_x, high_y - low_y)
}

/// `targetBoxes(document, operation, measure)`: the boxes a mark draws on, and the measurement to hand to the next one.
pub fn target_boxes<P: ReadProof>(
    proof: &P,
    document: &PdfDocument,
    operation: &Value,
    measure: Option<Measure>,
) -> Result<(Vec<MarkBox>, Option<Measure>), AnalysisError> {
    let op = js_string(operation.get("op"));
    let find = operation.get("find").filter(|value| !value.is_null()).map(value_to_string).unwrap_or_default();
    let find = js_trim(&find).to_owned();
    if find.is_empty() {
        let [x, y, width, height] = ["x", "y", "width", "height"].map(|key| to_number_of(operation.get(key)));
        let named = operation.get("page").is_some_and(truthy);
        if !named || [x, y, width, height].iter().any(|value| !value.is_finite()) || width <= 0.0 || height <= 0.0 {
            return Err(AnalysisError::plain(format!("{op} needs find, or page with x, y, width, height in points")));
        }
        let page = selected_edit_pages(document, &serde_json::json!({ "page": operation["page"] }))?[0];
        return Ok((vec![MarkBox { index: page.index, x, y, width, height, text: None }], measure));
    }
    let selected = selected_edit_pages(document, operation)?;
    let mut next = match measure {
        Some(held) => held,
        None => Measure { bytes: document.save(SaveOptions::default()), pages: HashMap::new() },
    };
    let missing: Vec<usize> = selected.iter().map(|page| page.index + 1).filter(|page| !next.pages.contains_key(page)).collect();
    for chunk in missing.chunks(MAX_PDF_ANALYSIS_PAGES) {
        let options = LayoutOptions { pages: Some(chunk.iter().map(|page| *page as f64).collect()), max_items: 500_000, shapes: false, cancel: None };
        let layout = extract_pdf_text_layout(proof, PdfSource::Bytes(&next.bytes), &options)?;
        for page in layout.pages {
            next.pages.insert(page.page, page);
        }
    }
    let measured: Vec<PageLayout> = selected.iter().filter_map(|page| next.pages.get(&(page.index + 1)).cloned()).collect();
    let layout = PdfLayout { page_count: document.page_count() as i64, pages: measured, truncated: false };
    let options = SearchOptions {
        limit: 500,
        whole_word: operation.get("wholeWord") == Some(&Value::Bool(true)),
        regex: operation.get("regex") == Some(&Value::Bool(true)),
    };
    let found = find_pdf_text(&layout, &find, &options)?.matches;
    if found.is_empty() {
        let noun = if selected.len() > 1 { "pages" } else { "page" };
        let scope = if selected.len() == document.page_count() {
            "the document".to_owned()
        } else {
            let numbers: Vec<String> = selected.iter().map(|page| (page.index + 1).to_string()).collect();
            format!("{noun} {}", numbers.join(", "))
        };
        return Err(AnalysisError::plain(format!(
            "{op} found no text matching \"{find}\" in {scope}; check the snapshot text or pass page, x, y, width, height"
        )));
    }
    // A phrase that wraps comes back as one rect per line, and each is marked on its own; `first` selects a match, so
    // its lines stay together.
    let mut all: Vec<Vec<MarkBox>> = Vec::new();
    for hit in &found {
        let Some(page) = layout.pages.iter().find(|entry| entry.page == hit.page) else {
            continue;
        };
        let rects = match &hit.rects {
            Some(rects) if !rects.is_empty() => rects.clone(),
            _ => vec![hit.rect],
        };
        // The layout is measured on the page as displayed (rotation and crop box applied); inverting the page's
        // transform puts the box back into user space.
        all.push(
            rects
                .iter()
                .map(|part| {
                    let (x, y, width, height) = display_to_user(&page.transform, part.x, part.top, part.width, part.height);
                    MarkBox { index: hit.page - 1, x, y, width, height, text: Some(hit.text.clone()) }
                })
                .collect(),
        );
    }
    let take = if operation.get("first") == Some(&Value::Bool(true)) { 1 } else { all.len() };
    let boxes = all.into_iter().take(take).flatten().collect();
    Ok((boxes, Some(next)))
}

/// `reportBoxes(boxes)`: the first few boxes go back in bottom-left points so a caller can check a mark against the
/// snapshot without rendering; a long match list is a count.
pub fn report_boxes(boxes: &[MarkBox]) -> Value {
    Value::Array(
        boxes
            .iter()
            .take(20)
            .map(|mark| {
                let mut row = Map::new();
                row.insert("page".to_owned(), Value::from(mark.index as u64 + 1));
                row.insert("x".to_owned(), json_number(round2(mark.x)));
                row.insert("y".to_owned(), json_number(round2(mark.y)));
                row.insert("width".to_owned(), json_number(round2(mark.width)));
                row.insert("height".to_owned(), json_number(round2(mark.height)));
                if let Some(text) = mark.text.as_ref().filter(|text| !text.is_empty()) {
                    row.insert("text".to_owned(), Value::String(text.clone()));
                }
                Value::Object(row)
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_displayed_point_returns_to_user_space_at_every_quarter_turn() {
        assert_eq!(display_point_to_user(0, 200.0, 100.0, 10.0, 20.0), (10.0, 20.0));
        assert_eq!(display_point_to_user(90, 200.0, 100.0, 10.0, 20.0), (180.0, 10.0));
        assert_eq!(display_point_to_user(180, 200.0, 100.0, 10.0, 20.0), (190.0, 80.0));
        assert_eq!(display_point_to_user(270, 200.0, 100.0, 10.0, 20.0), (20.0, 90.0));
        assert_eq!(display_point_to_user(45, 200.0, 100.0, 10.0, 20.0), (10.0, 20.0));
    }

    #[test]
    fn the_page_transform_is_inverted_for_a_box_on_an_upright_and_a_turned_page() {
        // pdf.js's viewport of a 200 x 100 page: y flips about the page height.
        let upright = [1.0, 0.0, 0.0, -1.0, 0.0, 100.0];
        assert_eq!(display_to_user(&upright, 10.0, 20.0, 30.0, 10.0), (10.0, 70.0, 30.0, 10.0));
        // A page turned 90 degrees clockwise shows 100 wide and 200 high.
        let turned = [0.0, 1.0, 1.0, 0.0, 0.0, 0.0];
        let (x, y, width, height) = display_to_user(&turned, 10.0, 20.0, 30.0, 10.0);
        assert_eq!((x, y, width, height), (20.0, 10.0, 10.0, 30.0));
    }

    #[test]
    fn a_box_given_by_number_needs_a_page_and_a_size() {
        let mut document = PdfDocument::create_at(0);
        document.add_page(200.0, 100.0).expect("page");
        let proof = mixdog_fsio::Unlaned;
        let (boxes, held) =
            target_boxes(&proof, &document, &json!({ "op": "highlight", "page": 1, "x": 5, "y": 6, "width": 7, "height": 8 }), None).expect("a box");
        assert!(held.is_none());
        assert_eq!(boxes, vec![MarkBox { index: 0, x: 5.0, y: 6.0, width: 7.0, height: 8.0, text: None }]);
        for operation in [
            json!({ "op": "highlight", "x": 5, "y": 6, "width": 7, "height": 8 }),
            json!({ "op": "highlight", "page": 1, "x": 5, "y": 6, "width": 0, "height": 8 }),
            json!({ "op": "highlight", "page": 1, "x": "a", "y": 6, "width": 7, "height": 8 }),
        ] {
            let error = target_boxes(&proof, &document, &operation, None).expect_err("refused");
            assert_eq!(error.message, "highlight needs find, or page with x, y, width, height in points");
        }
        let error =
            target_boxes(&proof, &document, &json!({ "op": "add_link", "page": 4, "x": 5, "y": 6, "width": 7, "height": 8 }), None).expect_err("out of range");
        assert_eq!(error.message, "PDF page out of range: 4");
    }

    #[test]
    fn the_report_keeps_twenty_boxes_rounded_and_names_the_text() {
        let boxes: Vec<MarkBox> =
            (0..25).map(|at| MarkBox { index: at, x: 1.005, y: 2.0, width: 3.14159, height: 4.0, text: (at == 0).then(|| "word".to_owned()) }).collect();
        let report = report_boxes(&boxes);
        let rows = report.as_array().expect("rows");
        assert_eq!(rows.len(), 20);
        let number = |row: &Value, key: &str| row[key].as_f64().expect("a number");
        assert_eq!(number(&rows[0], "x"), 1.0);
        assert_eq!(number(&rows[0], "width"), 3.14);
        assert_eq!(rows[0]["page"], 1);
        assert_eq!(rows[0]["text"], "word");
        assert!(rows[1].get("text").is_none());
    }
}
