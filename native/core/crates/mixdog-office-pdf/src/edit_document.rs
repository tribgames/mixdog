//! The document under edit (`pdf/pdf-edit-document.mjs`): the guarded load, the pages of a call, the attachments as
//! the session lists them, the file a split or an extraction writes beside the document, and the quarter turns of a
//! page. The writing half itself (pages, attachments, bookmarks, the save) is `mixdog_pdf::write`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_fsio::WriteProof;
use mixdog_js::{js_to_lowercase, nodepath, to_number, value_to_string};
use mixdog_office_base::write_note::WriteNote;
use mixdog_pdf::codec_glue::CodecFilters;
use mixdog_pdf::write::{LoadOptions, PdfDocument, WriteError};
use mixdog_pdf::{Guard, Ref};
use serde_json::{Value, json};

use crate::document::AnalysisError;

/// What a caller is told about an encrypted file: the way to a copy this crate can open.
pub const PDF_ENCRYPTED_HINT: &str = "PDF is encrypted: write an unencrypted copy first with action:'secure' security:'decrypt' path password output:<copy.pdf>, then open that copy";

/// A failure of the writing half as the error of a call: the reader's exceptions keep their names.
pub fn edit_error(error: WriteError) -> AnalysisError {
    match error {
        WriteError::Pdf(error) => AnalysisError::from_pdf(&error),
        other => AnalysisError::plain(other.to_string()),
    }
}

fn load_options(ignore_encryption: bool) -> LoadOptions {
    LoadOptions {
        ignore_encryption,
        filters: Arc::new(CodecFilters),
        guard: Guard::unbounded(),
    }
}

/// `loadPdf(buffer, { allowEncrypted })`: an encrypted file is refused with the way to an unencrypted copy; reading
/// the page count and the page sizes of one still works, so an inspection may opt in and gets the structure with the
/// strings and streams left ciphered.
pub fn load_pdf(bytes: &[u8], allow_encrypted: bool) -> Result<PdfDocument, AnalysisError> {
    match PdfDocument::load(bytes.to_vec(), &load_options(false)) {
        Ok(document) => Ok(document),
        Err(WriteError::Encrypted) if allow_encrypted => {
            PdfDocument::load(bytes.to_vec(), &load_options(true)).map_err(edit_error)
        }
        Err(WriteError::Encrypted) => Err(AnalysisError::plain(PDF_ENCRYPTED_HINT)),
        Err(error) => Err(edit_error(error)),
    }
}

/// What JavaScript's `||` and `!` read as true.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}

/// `String(value)` of a property that may be absent (`undefined`).
pub(crate) fn js_string(value: Option<&Value>) -> String {
    value.map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `value != null`: neither `undefined` nor `null`.
pub(crate) fn present(value: Option<&Value>) -> bool {
    value.is_some_and(|value| !value.is_null())
}

/// `Math.round`: halves go up.
pub(crate) fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// A page the operation names: its object and its 0-based position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectedPage {
    pub page: Ref,
    pub index: usize,
}

/// `selectedPages(document, operation)`: `pages` when it is a non-empty array, else `page`, else every page; each is a
/// whole number inside the document.
pub fn selected_edit_pages(document: &PdfDocument, operation: &Value) -> Result<Vec<SelectedPage>, AnalysisError> {
    let refs = document.pages();
    let count = refs.len();
    let named: Vec<Value> = match operation.get("pages") {
        Some(Value::Array(pages)) if !pages.is_empty() => pages.clone(),
        _ => match operation.get("page") {
            Some(page) if truthy(page) => vec![page.clone()],
            _ => (1..=count).map(|page| json!(page)).collect(),
        },
    };
    named
        .iter()
        .map(|page| {
            let index = to_number(page) - 1.0;
            if index.fract() != 0.0 || !index.is_finite() || index < 0.0 || index >= count as f64 {
                return Err(AnalysisError::plain(format!("PDF page out of range: {}", value_to_string(page))));
            }
            let index = index as usize;
            Ok(SelectedPage { page: refs[index], index })
        })
        .collect()
}

/// `pdfAttachments(document)`: `{ path, index, name, description }` of each embedded file.
pub fn pdf_attachments(document: &PdfDocument) -> Vec<Value> {
    document
        .attachments()
        .into_iter()
        .map(|entry| {
            json!({
                "path": format!("/attachments[{}]", entry.index),
                "index": entry.index,
                "name": entry.name,
                "description": entry.description,
            })
        })
        .collect()
}

/// `resolve(dirname(path), target)`.
pub(crate) fn resolve_beside(path: &Path, target: &str) -> PathBuf {
    let directory = path.parent().map(|parent| parent.to_string_lossy().into_owned()).unwrap_or_default();
    let directory = if directory.is_empty() { ".".to_owned() } else { directory };
    PathBuf::from(nodepath::resolve_host(&[&directory, target]))
}

/// `writeSibling(path, target, bytes)`: the file `target` names (beside the document when it is relative), which must
/// not be the document itself. Its folder is made, the write is reported to the call's note before it happens, and the
/// absolute path comes back.
pub fn write_sibling<P: WriteProof>(
    proof: &P,
    note: &dyn WriteNote,
    path: &Path,
    target: &str,
    bytes: &[u8],
) -> Result<PathBuf, AnalysisError> {
    let output = resolve_beside(path, target);
    let document = nodepath::resolve_host(&[&path.to_string_lossy()]);
    if js_to_lowercase(&output.to_string_lossy()) == js_to_lowercase(&document) {
        return Err(AnalysisError::plain("output must differ from the document being edited"));
    }
    let io = |error: std::io::Error| AnalysisError::plain(error.to_string());
    if let Some(folder) = output.parent().filter(|folder| !folder.as_os_str().is_empty()) {
        mixdog_fsio::create_dir_all(proof, folder).map_err(io)?;
    }
    note.note_write(&output);
    mixdog_fsio::write(proof, &output, bytes).map_err(io)?;
    Ok(output)
}

/// `readFile(path)`: a file that is not there reads as Node's `ENOENT` says it.
pub(crate) fn read_file<P: mixdog_fsio::ReadProof>(proof: &P, path: &Path) -> Result<Vec<u8>, AnalysisError> {
    mixdog_fsio::read(proof, path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AnalysisError::plain(format!("ENOENT: no such file or directory, open '{}'", path.display()))
        } else {
            AnalysisError::plain(error.to_string())
        }
    })
}

/// `pageSpin(page)`: a page's own `Rotate` normalized to the quarter turns a viewer applies before anyone sees it.
pub fn page_spin(document: &PdfDocument, page: Ref) -> i64 {
    let angle = document.rotation(page).map_or(0.0, |angle| if angle.is_finite() { angle } else { 0.0 });
    let rounded = js_round(angle) as i64;
    ((rounded % 360) + 360) % 360
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_pages() -> PdfDocument {
        let mut document = PdfDocument::create_at(0);
        document.add_page(100.0, 200.0).expect("page");
        document.add_page(300.0, 400.0).expect("page");
        document
    }

    #[test]
    fn pages_come_from_pages_then_page_then_every_page() {
        let document = two_pages();
        let indexes = |operation: Value| -> Vec<usize> {
            selected_edit_pages(&document, &operation).expect("pages").iter().map(|page| page.index).collect()
        };
        assert_eq!(indexes(json!({})), [0, 1]);
        assert_eq!(indexes(json!({ "page": 2 })), [1]);
        assert_eq!(indexes(json!({ "pages": [2, 1, 2], "page": 1 })), [1, 0, 1]);
        assert_eq!(indexes(json!({ "pages": [], "page": 2 })), [1]);
        assert_eq!(indexes(json!({ "pages": ["1"] })), [0]);
    }

    #[test]
    fn a_page_outside_the_document_or_not_whole_is_named_in_the_error() {
        let document = two_pages();
        for (operation, named) in [
            (json!({ "page": 3 }), "3"),
            (json!({ "pages": [1, 0] }), "0"),
            (json!({ "pages": [1.5] }), "1.5"),
            (json!({ "pages": ["x"] }), "x"),
        ] {
            let error = selected_edit_pages(&document, &operation).expect_err("out of range");
            assert_eq!(error.message, format!("PDF page out of range: {named}"));
        }
    }

    #[test]
    fn page_spin_is_the_rotation_modulo_a_full_turn() {
        let mut document = two_pages();
        let pages = document.pages();
        assert_eq!(page_spin(&document, pages[0]), 0);
        document.set_rotation(pages[0], -90.0).expect("rotate");
        document.set_rotation(pages[1], 450.0).expect("rotate");
        assert_eq!(page_spin(&document, pages[0]), 270);
        assert_eq!(page_spin(&document, pages[1]), 90);
    }

    #[test]
    fn a_file_that_is_not_a_pdf_is_an_error_and_the_hint_names_the_way_to_a_copy() {
        assert!(PDF_ENCRYPTED_HINT.contains("security:'decrypt'"));
        assert!(load_pdf(b"not a pdf", false).is_err());
    }

    #[test]
    fn a_target_is_resolved_beside_the_document_and_never_is_the_document() {
        let resolved = resolve_beside(Path::new("work/a.pdf"), "out/b.pdf");
        assert!(resolved.ends_with(Path::new("work").join("out").join("b.pdf")));
        let error = write_sibling(
            &mixdog_fsio::Unlaned,
            &mixdog_office_base::write_note::NoWriteNote,
            Path::new("work/a.pdf"),
            "A.PDF",
            b"x",
        )
        .expect_err("same file");
        assert_eq!(error.message, "output must differ from the document being edited");
    }
}
