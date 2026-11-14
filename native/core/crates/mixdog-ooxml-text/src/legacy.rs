//! Legacy Office files (`.doc`, `.xls`, `.ppt`: OLE compound documents) next to the OOXML packages the text extraction
//! reads: the signature, the fixed refusal the extraction answers with, and which package an attachment's labels say it
//! is (`legacy-office.mjs`).

/// The first eight bytes of every legacy Office (OLE compound) file.
pub const OLE_COMPOUND_MAGIC: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/// What the extraction answers for an OLE file, which often arrives renamed to `.docx`: "not a ZIP container" tells the
/// reader nothing it can act on, the format and the way out do.
pub const LEGACY_OFFICE_REFUSAL: &str = "this is a legacy Office file (.doc/.xls/.ppt), not an Office Open XML package — open it in Word, Excel, or PowerPoint and save a copy as .docx/.xlsx/.pptx, then read that copy";

/// `isLegacyOfficeBuffer`.
pub fn is_legacy_office_buffer(buffer: &[u8]) -> bool {
    buffer.starts_with(&OLE_COMPOUND_MAGIC)
}

/// `OOXML_MIME_BY_PACKAGE`: the MIME type of a package kind (`docx`, `xlsx`, `pptx`).
pub fn ooxml_mime_by_package(kind: &str) -> Option<&'static str> {
    match kind {
        "docx" => Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "xlsx" => Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
        "pptx" => Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
        _ => None,
    }
}

/// `String(mimeType || '').split(';', 1)[0].trim().toLowerCase()`.
fn media_type(mime_type: &str) -> String {
    mixdog_js::js_to_lowercase(mixdog_js::js_trim(mime_type.split(';').next().unwrap_or("")))
}

/// `path.extname(filename).slice(1).toLowerCase()` (the separators of the platform).
fn extension(filename: &str) -> String {
    let separators: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
    let base = filename.rsplit(separators).next().unwrap_or("");
    let ext = match base.rfind('.') {
        Some(0) | None => "",
        Some(1) if base == ".." => "",
        Some(at) => &base[at + 1..],
    };
    mixdog_js::js_to_lowercase(ext)
}

/// The package extension (`docx`/`xlsx`/`pptx`) an attachment labelled legacy Office (by MIME type or file extension)
/// converts to, else `""`.
pub fn legacy_office_label_package(mime_type: &str, filename: &str) -> &'static str {
    match media_type(mime_type).as_str() {
        "application/msword" => return "docx",
        "application/vnd.ms-excel" => return "xlsx",
        "application/vnd.ms-powerpoint" => return "pptx",
        _ => {}
    }
    match extension(filename).as_str() {
        "doc" => "docx",
        "xls" => "xlsx",
        "ppt" => "pptx",
        _ => "",
    }
}

/// The package an OLE file labelled as an OOXML Office file (renamed, or sent with the OOXML MIME type and no
/// extension) converts to, else `""`.
pub fn ooxml_label_package(mime_type: &str, filename: &str) -> &'static str {
    let mime = media_type(mime_type);
    for kind in ["docx", "xlsx", "pptx"] {
        if ooxml_mime_by_package(kind) == Some(mime.as_str()) {
            return kind;
        }
    }
    if mime == "application/vnd.ms-excel.sheet.macroenabled.12" {
        return "xlsx";
    }
    match extension(filename).as_str() {
        "docx" => "docx",
        "xlsx" | "xlsm" => "xlsx",
        "pptx" => "pptx",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_signature_is_the_first_eight_bytes() {
        let mut ole = OLE_COMPOUND_MAGIC.to_vec();
        ole.extend_from_slice(&[0; 8]);
        assert!(is_legacy_office_buffer(&ole));
        assert!(is_legacy_office_buffer(&OLE_COMPOUND_MAGIC));
        assert!(!is_legacy_office_buffer(&OLE_COMPOUND_MAGIC[..7]));
        assert!(!is_legacy_office_buffer(b"PK\x03\x04 not ole"));
    }

    #[test]
    fn a_legacy_label_names_the_package_by_mime_type_first_then_extension() {
        assert_eq!(legacy_office_label_package("application/msword; charset=x", "a.xls"), "docx");
        assert_eq!(legacy_office_label_package("", "Budget.XLS"), "xlsx");
        assert_eq!(legacy_office_label_package("application/octet-stream", "deck.ppt"), "pptx");
        assert_eq!(legacy_office_label_package("", "deck.pptx"), "");
        assert_eq!(legacy_office_label_package("", ".doc"), "");
    }

    #[test]
    fn an_ooxml_label_names_the_package_by_mime_type_first_then_extension() {
        let docx = ooxml_mime_by_package("docx").unwrap();
        assert_eq!(ooxml_label_package(&format!(" {docx} "), "x.bin"), "docx");
        assert_eq!(ooxml_label_package("application/vnd.ms-excel.sheet.macroEnabled.12", ""), "xlsx");
        assert_eq!(ooxml_label_package("", "a.xlsm"), "xlsx");
        assert_eq!(ooxml_label_package("", "a.pptx"), "pptx");
        assert_eq!(ooxml_label_package("text/plain", "a.txt"), "");
    }

    #[test]
    fn the_extension_is_node_extname() {
        assert_eq!(extension("a.b.C"), "c");
        assert_eq!(extension("dir.d/file"), "");
        assert_eq!(extension("a."), "");
        assert_eq!(extension(".."), "");
        assert_eq!(extension("..a"), "a");
    }
}
