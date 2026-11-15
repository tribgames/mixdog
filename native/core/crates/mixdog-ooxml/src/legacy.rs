//! A legacy Office file (`.doc`, `.xls`, `.ppt`: an OLE compound document) is not a package, and it often arrives renamed
//! to `.docx`. Nothing is damaged about it, so the repair advice for a damaged package would send the caller after a file
//! that does not exist: it is told what the file is and the way forward. The signature is the one the text extraction
//! reads (`mixdog-ooxml-text`).

pub use mixdog_ooxml_text::legacy::{OLE_COMPOUND_MAGIC, is_legacy_office_buffer};

/// What opening a legacy Office file as a package answers.
pub fn legacy_office_error(path: &str) -> String {
    format!(
        "{path} is a legacy Office file (.doc/.xls/.ppt), not an Office Open XML package. Open it in Microsoft Office and save a copy as .docx/.xlsx/.pptx, then work on that copy."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_signature_is_the_first_eight_bytes_of_a_compound_file() {
        let mut file = OLE_COMPOUND_MAGIC.to_vec();
        file.extend_from_slice(b"rest");
        assert!(is_legacy_office_buffer(&file));
        assert!(!is_legacy_office_buffer(&OLE_COMPOUND_MAGIC[..7]));
        assert!(!is_legacy_office_buffer(b"PK\x03\x04"));
    }

    #[test]
    fn the_refusal_names_the_file_and_the_way_forward() {
        assert_eq!(
            legacy_office_error("C:\\work\\a.docx"),
            "C:\\work\\a.docx is a legacy Office file (.doc/.xls/.ppt), not an Office Open XML package. Open it in Microsoft Office and save a copy as .docx/.xlsx/.pptx, then work on that copy."
        );
    }
}
