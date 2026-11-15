//! `documentFingerprint(path, format)` of `core/office-core.mjs`: what a document is, independent of when it was saved. The
//! journal compares it with the fingerprint recorded for a file, so it must equal Node's for files Node journaled.
//!
//! A csv, tsv or pdf is the SHA-256 of its bytes. A package is the SHA-256 over its file entries sorted by name (by UTF-16
//! code units), each as the name, a NUL, the content and a NUL, leaving out docProps/core.xml and docProps/app.xml (which
//! change on every save) and with the `documentId` of xl/workbook.xml blanked.

use std::path::Path;

use mixdog_fsio::ReadProof;
use mixdog_office_base::formats::is_ooxml_format;
use sha2::{Digest, Sha256};

use crate::xml::compiled;
use crate::zipio::Package;

const VOLATILE_PARTS: [&str; 2] = ["docProps/core.xml", "docProps/app.xml"];

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The fingerprint of a document's bytes. An error (jszip's reason) when a package cannot be opened as an archive.
pub fn document_fingerprint_bytes(buffer: &[u8], format: &str) -> Result<String, String> {
    let mut hash = Sha256::new();
    if !is_ooxml_format(format) {
        hash.update(buffer);
        return Ok(hex(&hash.finalize()));
    }
    let package = Package::load_unchecked(buffer)?;
    let mut names: Vec<String> = package
        .entries()
        .into_iter()
        .filter(|entry| !entry.dir && !VOLATILE_PARTS.contains(&entry.name.as_str()))
        .map(|entry| entry.name.clone())
        .collect();
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let document_id = compiled(r#"\bdocumentId="[^"]*""#, "g");
    for name in &names {
        hash.update(name.as_bytes());
        hash.update([0_u8]);
        let content = package.file(name).unwrap_or_default();
        if name == "xl/workbook.xml" {
            let text = String::from_utf8_lossy(content);
            hash.update(document_id.replace_all_with(&text, |_| "documentId=\"\"".to_owned()).as_bytes());
        } else {
            hash.update(content);
        }
        hash.update([0_u8]);
    }
    Ok(hex(&hash.finalize()))
}

/// `documentFingerprint(path, format)`: reads the file and fingerprints it. An error is the read's, worded as Node words
/// it, or the archive's.
pub fn document_fingerprint<P: ReadProof>(proof: &P, path: &Path, format: &str) -> Result<String, String> {
    let buffer = mixdog_fsio::read(proof, path).map_err(|error| crate::package::os_message(&error, "open", path))?;
    document_fingerprint_bytes(&buffer, format)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workbook(document_id: &str, core: &str) -> Vec<u8> {
        let mut package = Package::new();
        package.set("docProps/core.xml", core);
        package.set("docProps/app.xml", "<Properties/>");
        package.set("xl/workbook.xml", format!("<workbook><workbookPr documentId=\"{document_id}\"/></workbook>"));
        package.set("xl/worksheets/sheet1.xml", "<worksheet/>");
        package.generate().expect("generate")
    }

    #[test]
    fn what_changes_on_every_save_does_not_change_the_fingerprint() {
        let first = document_fingerprint_bytes(&workbook("{A}", "<core>one</core>"), "xlsx").unwrap();
        let second = document_fingerprint_bytes(&workbook("{B}", "<core>two</core>"), "xlsx").unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
    }

    #[test]
    fn a_change_to_a_part_changes_it() {
        let mut changed = Package::load(&workbook("{A}", "x")).expect("load");
        changed.set("xl/worksheets/sheet1.xml", "<worksheet><sheetData/></worksheet>");
        let before = document_fingerprint_bytes(&workbook("{A}", "x"), "xlsx").unwrap();
        let after = document_fingerprint_bytes(&changed.generate().expect("generate"), "xlsx").unwrap();
        assert_ne!(before, after);
    }

    #[test]
    fn the_digest_is_over_names_and_contents_separated_by_nul() {
        let mut package = Package::new();
        package.set("b.xml", "2");
        package.set("a.xml", "1");
        let bytes = package.generate().expect("generate");
        let mut expected = Sha256::new();
        expected.update(b"a.xml\x001\x00b.xml\x002\x00");
        assert_eq!(document_fingerprint_bytes(&bytes, "docx").unwrap(), hex(&expected.finalize()));
    }

    #[test]
    fn names_sort_by_utf16_units_not_by_code_points() {
        // U+FF5E is one UTF-16 unit above the surrogates (0xFF5E > 0xD83D), and a code point order puts U+1F600 after it.
        let mut package = Package::new();
        package.set("\u{1f600}.xml", "1");
        package.set("\u{ff5e}.xml", "2");
        let bytes = package.generate().expect("generate");
        let mut expected = Sha256::new();
        expected.update("\u{1f600}.xml".as_bytes());
        expected.update(b"\x001\x00");
        expected.update("\u{ff5e}.xml".as_bytes());
        expected.update(b"\x002\x00");
        assert_eq!(document_fingerprint_bytes(&bytes, "pptx").unwrap(), hex(&expected.finalize()));
    }

    #[test]
    fn a_flat_file_is_the_hash_of_its_bytes_and_a_broken_package_is_an_error() {
        let mut expected = Sha256::new();
        expected.update(b"a,b\n1,2\n");
        assert_eq!(document_fingerprint_bytes(b"a,b\n1,2\n", "csv").unwrap(), hex(&expected.finalize()));
        assert_eq!(document_fingerprint_bytes(b"not a zip, only text of some length", "docx").unwrap_err(), "Can't find end of central directory");
    }
}
