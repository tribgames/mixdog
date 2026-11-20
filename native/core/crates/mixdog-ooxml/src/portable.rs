//! The front of the portable OOXML engine: `portable/portable-ooxml.mjs`. One place to read a document, edit it with a
//! batch of operations, validate it, render it and convert a legacy file, over the dispatchers of the three formats.
//!
//! [`apply_portable_ooxml_batch`] loads the package, runs the operations on the format's dispatcher, sweeps the parts that
//! deleting a slide, a picture or a shape left unreachable, rebuilds a Word table of contents (it is usually written before the
//! sections it lists, so the save is the only moment it can list them) and saves. An operation that fails stops the batch and
//! nothing is saved. The other fronts of the Node module are the functions the formats' own modules hold, named here so a caller
//! has one import.

use std::path::Path;

use mixdog_fsio::WriteProof;
use mixdog_office_base::write_note::WriteNote;
use serde_json::Value;

use crate::docx::apply_docx;
use crate::docx_operations::refresh_docx_table_of_contents;
use crate::package::{load_package, save_package};
use crate::pptx::apply_pptx;
use crate::text_metrics::TextMeasurer;
use crate::xlsx::apply_xlsx;

pub use crate::opc::image_pixel_size;
pub use crate::package::{CreateOptions, CreatedDocument, create_portable_ooxml_document, portable_create_supported};
pub use crate::pptx_core::inspect_pptx_text_boxes;
pub use crate::pptx_package::clear_portable_presentation_slides;
pub use crate::snapshot::snapshot_portable_ooxml;
pub use crate::soffice::{ConvertError, RenderFormat, ScratchHooks, Soffice};
pub use crate::validation::{OrphanSweep, issues_portable_ooxml, remove_orphan_package_parts};
pub use crate::validation_package::{ValidateOptions, validate_portable_ooxml};
pub use crate::xlsx_recalculate::{recalculate_portable_workbook, recalculate_with_formula_engine};
pub use crate::xml::replace_across_runs;

/// The operations after which the package may hold parts nothing reaches.
const SWEEPING_OPERATIONS: [&str; 3] = ["delete_slide", "replace_image", "delete_shape"];

/// `applyPortableOoxmlBatch(path, format, operations)`: the operations applied to the document at `path` and the document saved,
/// answering what each operation reported.
pub fn apply_portable_ooxml_batch<P: WriteProof>(
    proof: &P,
    note: &dyn WriteNote,
    measurer: &TextMeasurer<'_, P>,
    path: &Path,
    format: &str,
    operations: &[Value],
) -> Result<Vec<Value>, String> {
    let mut zip = load_package(proof, path)?;
    let results = match format {
        "docx" => apply_docx(proof, measurer, &mut zip, operations)?,
        "xlsx" => apply_xlsx(proof, measurer, &mut zip, operations)?,
        _ => apply_pptx(proof, measurer, &mut zip, operations)?,
    };
    if operations.iter().any(|operation| operation.get("op").and_then(Value::as_str).is_some_and(|op| SWEEPING_OPERATIONS.contains(&op))) {
        // A package the sweep refuses (no relationship resolves to a part) is saved as it is: `.catch(() => ({ removed: [] }))`.
        let _ = remove_orphan_package_parts(&mut zip);
    }
    if format == "docx" {
        refresh_docx_table_of_contents(&mut zip);
    }
    save_package(proof, note, &zip, path)?;
    Ok(results)
}

#[cfg(test)]
mod tests {
    use mixdog_fonts::registry::Registry;
    use mixdog_fsio::Unlaned;
    use mixdog_office_base::write_note::NoWriteNote;
    use serde_json::json;

    use super::*;

    fn batch(path: &Path, format: &str, operations: &[Value]) -> Result<Vec<Value>, String> {
        let registry = Registry::new();
        let measurer = TextMeasurer::new(&Unlaned, &registry);
        apply_portable_ooxml_batch(&Unlaned, &NoWriteNote, &measurer, path, format, operations)
    }

    fn create(path: &Path, kind: &str) {
        create_portable_ooxml_document(&Unlaned, &NoWriteNote, path, &CreateOptions { file_kind: kind, title: "front", sheet_name: "" })
            .expect("a blank document");
    }

    #[test]
    fn a_batch_edits_each_format_and_saves_the_package() {
        let directory = tempfile::tempdir().expect("scratch folder");
        let word = directory.path().join("memo.docx");
        create(&word, "docx");
        let results = batch(&word, "docx", &[json!({ "op": "append_text", "text": "Quarterly memo" })]).expect("a docx batch");
        assert_eq!(results.len(), 1);
        let package = load_package(&Unlaned, &word).expect("the saved package");
        assert!(package.text("word/document.xml").contains("Quarterly memo"));
        let book = directory.path().join("book.xlsx");
        create(&book, "xlsx");
        assert_eq!(
            batch(&book, "xlsx", &[json!({ "op": "set_range", "sheet": "Sheet1", "range": "A1:B1", "values": [["a", 1]] })]).expect("an xlsx batch").len(),
            1
        );
        let deck = directory.path().join("deck.pptx");
        create(&deck, "pptx");
        assert_eq!(batch(&deck, "pptx", &[json!({ "op": "add_slide", "layout": "blank" })]).expect("a pptx batch").len(), 1);
    }

    #[test]
    fn a_failing_operation_stops_the_batch_and_leaves_the_file_as_it_was() {
        let directory = tempfile::tempdir().expect("scratch folder");
        let word = directory.path().join("memo.docx");
        create(&word, "docx");
        let before = mixdog_fsio::read(&Unlaned, &word).expect("the blank document");
        let error = batch(&word, "docx", &[json!({ "op": "append_text", "text": "kept?" }), json!({ "op": "no_such_operation" })]).expect_err("a refusal");
        assert_eq!(error, "Portable DOCX backend does not support operation: no_such_operation");
        assert_eq!(mixdog_fsio::read(&Unlaned, &word).expect("the file"), before);
    }
}
