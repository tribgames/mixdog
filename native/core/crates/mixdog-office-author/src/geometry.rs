//! The geometry a page promises and the browser can prove, read before the deck lands (`pptx-html-geometry.mjs`).
//!
//! The reading itself runs inside the page (`assets/page/pptx-html-geometry.js`, the Node function taken over as it
//! was): declared relations (`data-on`, `data-inside`, `data-between`, `data-align`, `data-label`) are measured
//! exactly, and where nothing is declared the page is still read for the misses a declaration would have caught.
//! This module holds the tolerances and what the caller does with the findings.

use serde_json::Value;
use serde_json::json;

use crate::page::Page;
use crate::page::page_function;

/// How far a declared relation may be off, in px of the 1920 x 1080 canvas.
pub const GEOMETRY_TOLERANCE_PX: f64 = 2.0;

/// How far peer blocks may be off alignment and still be reported as a near miss, in px.
pub const NEAR_MISS_PX: f64 = 24.0;

/// The page function `readGeometry(index, tolerance, nearMiss)`.
const READ_GEOMETRY: &str = include_str!("../assets/page/pptx-html-geometry.js");

/// The findings of slide `index` (0-based), each `{ check, subject, target?, off, message }`.
pub async fn read_geometry(page: &Page, index: usize) -> Result<Vec<Value>, String> {
    let found = page
        .evaluate(
            &page_function(READ_GEOMETRY, "readGeometry"),
            &[json!(index), mixdog_js::json_number(GEOMETRY_TOLERANCE_PX), mixdog_js::json_number(NEAR_MISS_PX)],
        )
        .await?;
    Ok(found.as_array().cloned().unwrap_or_default())
}

/// A slide's entry in a deck's `geometry` list: `{ slide, findings }` with the 1-based page number, or nothing for a
/// slide with no finding.
pub fn slide_findings(slide: usize, findings: Vec<Value>) -> Option<Value> {
    (!findings.is_empty()).then(|| json!({ "slide": slide, "findings": findings }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tolerances_are_two_and_twenty_four_pixels() {
        assert_eq!(GEOMETRY_TOLERANCE_PX, 2.0);
        assert_eq!(NEAR_MISS_PX, 24.0);
    }

    #[test]
    fn the_page_function_is_the_node_function() {
        assert!(READ_GEOMETRY.starts_with("/** Runs inside the page: the geometry findings of slide `index`"));
        assert!(READ_GEOMETRY.contains("function readGeometry(index, tolerance, nearMiss) {"));
        assert!(!READ_GEOMETRY.contains("export "));
    }

    #[test]
    fn a_slide_without_findings_has_no_entry() {
        assert_eq!(slide_findings(3, Vec::new()), None);
        let finding = json!({ "check": "inside", "subject": "#a", "off": 17.3, "message": "#a reaches 17.3px outside #b" });
        let entry = slide_findings(2, vec![finding.clone()]).unwrap();
        assert_eq!(entry["slide"], json!(2));
        assert_eq!(entry["findings"], json!([finding]));
    }
}
