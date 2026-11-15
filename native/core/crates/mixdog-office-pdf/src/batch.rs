//! `applyPdfBatch(path, operations, context)` as the tool layer calls it: the operations of a batch run in order on one
//! document held in memory, one save, the file rewritten in place. The dispatcher itself is
//! [`crate::adapter::apply_pdf_batch`]; this module is the set a call hands it: the content operations
//! ([`ContentOperations`], which carry the call's `context`, the OCR data folder and the cancellation) beside the
//! structure operations, and the form vocabulary the snapshot and the audit read a form through ([`PdfFormView`]).

use std::path::Path;

use mixdog_fsio::WriteProof;
use mixdog_office_base::write_note::WriteNote;
use mixdog_pdf::write::PdfDocument;
use serde_json::Value;

use crate::adapter::{FormView, OperationSet, apply_pdf_batch};
use crate::content_ops::ContentOperations;
use crate::document::AnalysisError;
use crate::forms::{PdfForm, minimum_field_size, rectangles_overlap};
use crate::structure::StructureOperations;

/// `applyPdfBatch(path, operations, context)`: the content operations and the structure operations of one batch.
pub fn apply_batch<P: WriteProof>(
    proof: &P,
    note: &dyn WriteNote,
    path: &Path,
    operations: &[Value],
    content: &ContentOperations,
) -> Result<Vec<Value>, AnalysisError> {
    let structure = StructureOperations;
    let sets: [&dyn OperationSet<P>; 2] = [content, &structure];
    apply_pdf_batch(proof, note, path, operations, &sets)
}

/// The form vocabulary of the session surface over the forms module: the fields of a document described, the smallest
/// box a person can hit or read for a field of a type, and whether two widgets cover each other.
#[derive(Debug, Clone, Copy, Default)]
pub struct PdfFormView;

/// `[x, y, width, height]` of a widget as the description lists it.
fn widget_box(widget: &Value) -> [f64; 4] {
    ["x", "y", "width", "height"].map(|key| widget.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN))
}

impl FormView for PdfFormView {
    /// `getForm().getFields().map(describeFormField)`: the form is read on a copy, because reading it makes the form
    /// of a document that has none.
    fn describe_fields(&self, document: &PdfDocument) -> Vec<Value> {
        let mut copy = document.clone();
        PdfForm::new().describe_fields(&mut copy).unwrap_or_default()
    }

    fn minimum_size(&self, field_type: &str) -> (f64, f64) {
        let [width, height] = minimum_field_size(field_type);
        (width, height)
    }

    fn rectangles_overlap(&self, left: &Value, right: &Value) -> bool {
        rectangles_overlap(widget_box(left), widget_box(right))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn two_widgets_overlap_when_they_share_area_and_a_box_missing_a_number_overlaps_nothing() {
        let view = PdfFormView;
        let a = json!({ "x": 0, "y": 0, "width": 10, "height": 10 });
        let b = json!({ "x": 5, "y": 5, "width": 10, "height": 10 });
        let c = json!({ "x": 10, "y": 0, "width": 10, "height": 10 });
        assert!(view.rectangles_overlap(&a, &b));
        assert!(!view.rectangles_overlap(&a, &c));
        assert!(!view.rectangles_overlap(&a, &json!({ "x": 5 })));
    }

    #[test]
    fn the_minimum_box_is_the_forms_own() {
        let view = PdfFormView;
        assert_eq!(view.minimum_size("checkbox"), (8.0 - 0.01, 8.0 - 0.01));
        assert_eq!(view.minimum_size("text"), (24.0 - 0.01, 12.0 - 0.01));
    }

    #[test]
    fn a_document_without_a_form_has_no_fields_and_is_left_without_one() {
        let mut document = PdfDocument::create_at(0);
        document.add_page(100.0, 100.0).expect("page");
        let before = document.store().len();
        assert!(PdfFormView.describe_fields(&document).is_empty());
        assert_eq!(document.store().len(), before);
    }
}
