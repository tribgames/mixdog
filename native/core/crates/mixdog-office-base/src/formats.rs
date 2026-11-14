//! The format tables at the head of `core/office-core.mjs`: which file kinds are Office documents and what format each
//! belongs to, and the refusal text for a legacy binary file.

use mixdog_js::js_to_lowercase;

/// `FILE_KIND_TO_FORMAT`, in the order Node lists it.
pub const FILE_KIND_TO_FORMAT: [(&str, &str); 15] = [
    ("docx", "docx"),
    ("dotx", "docx"),
    ("docm", "docx"),
    ("dotm", "docx"),
    ("xlsx", "xlsx"),
    ("xltx", "xlsx"),
    ("xlsm", "xlsx"),
    ("xltm", "xlsx"),
    ("pptx", "pptx"),
    ("potx", "pptx"),
    ("pptm", "pptx"),
    ("potm", "pptx"),
    ("csv", "csv"),
    ("tsv", "tsv"),
    ("pdf", "pdf"),
];

/// `FORMATS`: the distinct values of [`FILE_KIND_TO_FORMAT`].
pub const FORMATS: [&str; 6] = ["docx", "xlsx", "pptx", "csv", "tsv", "pdf"];

/// `TABULAR_FORMATS`.
pub const TABULAR_FORMATS: [&str; 2] = ["csv", "tsv"];

/// `OOXML_FORMATS`.
pub const OOXML_FORMATS: [&str; 3] = ["docx", "xlsx", "pptx"];

pub fn is_tabular_format(format: &str) -> bool {
    TABULAR_FORMATS.contains(&format)
}

pub fn is_ooxml_format(format: &str) -> bool {
    OOXML_FORMATS.contains(&format)
}

/// The binary formats of Office 97-2003 are not packages: nothing here reads them directly. `open` converts one to its
/// package format through LibreOffice; every other entry point names that conversion.
const LEGACY_BINARY_FORMATS: [(&str, &str); 7] =
    [("doc", "docx"), ("dot", "dotx"), ("xls", "xlsx"), ("xlt", "xltx"), ("ppt", "pptx"), ("pot", "potx"), ("pps", "pptx")];

/// The format a file kind (lower case, no dot) belongs to.
pub fn format_of_kind(kind: &str) -> Option<&'static str> {
    FILE_KIND_TO_FORMAT.iter().find(|(known, _)| *known == kind).map(|(_, format)| *format)
}

fn unsupported_format_error(kind: &str) -> String {
    match LEGACY_BINARY_FORMATS.iter().find(|(legacy, _)| *legacy == kind) {
        Some((_, modern)) => format!(
            "Unsupported Office Use format: .{kind} is a legacy binary file, not an Office package. action:'open' converts it to .{modern} beside the original when LibreOffice is installed; otherwise save it as .{modern} in Microsoft Office first, then work on that file."
        ),
        None => format!("Unsupported Office Use format: .{}", if kind.is_empty() { "(none)" } else { kind }),
    }
}

/// `path.extname(path)` of the host's path flavour (Node's own algorithm: a leading dot alone is no extension).
fn extname(path: &str) -> &str {
    let bytes = path.as_bytes();
    let separator = |byte: u8| byte == b'/' || (cfg!(windows) && byte == b'\');
    let mut start = 0;
    if cfg!(windows) && bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        start = 2;
    }
    let mut start_dot: Option<usize> = None;
    let mut start_part = start;
    let mut end: Option<usize> = None;
    let mut matched_separator = true;
    // 0: no non-dot character met after the last dot; 1: the last dot is still the first of its run; -1: otherwise.
    let mut pre_dot_state = 0_i8;
    for index in (start..bytes.len()).rev() {
        let byte = bytes[index];
        if separator(byte) {
            if !matched_separator {
                start_part = index + 1;
                break;
            }
            continue;
        }
        if end.is_none() {
            matched_separator = false;
            end = Some(index + 1);
        }
        if byte == b'.' {
            if start_dot.is_none() {
                start_dot = Some(index);
            } else if pre_dot_state != 1 {
                pre_dot_state = 1;
            }
        } else if start_dot.is_some() {
            pre_dot_state = -1;
        }
    }
    match (start_dot, end) {
        (Some(dot), Some(end))
            if pre_dot_state != 0 && !(pre_dot_state == 1 && dot + 1 == end && dot == start_part + 1) =>
        {
            &path[dot..end]
        }
        _ => "",
    }
}

/// `legacyPackageKind(path)`: the package extension a legacy binary file converts to (`doc` becomes `docx`), or `""`
/// for any other file.
pub fn legacy_package_kind(path: &str) -> &'static str {
    let kind = js_to_lowercase(extname(path).get(1..).unwrap_or(""));
    LEGACY_BINARY_FORMATS.iter().find(|(legacy, _)| *legacy == kind).map_or("", |(_, modern)| *modern)
}

/// `normalizeOfficeFormat(value)`: a file kind or a format name to the format, or the refusal.
pub fn normalize_office_format(value: &str) -> Result<&'static str, String> {
    let kind = js_to_lowercase(value);
    format_of_kind(&kind).ok_or_else(|| unsupported_format_error(&kind))
}

/// `documentFileKind(path)`: the lower-case extension of a supported Office file.
pub fn document_file_kind(path: &str) -> Result<String, String> {
    let kind = js_to_lowercase(extname(path).get(1..).unwrap_or(""));
    if format_of_kind(&kind).is_none() {
        return Err(unsupported_format_error(&kind));
    }
    Ok(kind)
}

/// `documentFormat(path)`.
pub fn document_format(path: &str) -> Result<&'static str, String> {
    normalize_office_format(&document_file_kind(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_agree() {
        let mut distinct: Vec<&str> = Vec::new();
        for (_, format) in FILE_KIND_TO_FORMAT {
            if !distinct.contains(&format) {
                distinct.push(format);
            }
        }
        assert_eq!(distinct, FORMATS);
        assert!(is_tabular_format("csv") && !is_tabular_format("pdf"));
        assert!(is_ooxml_format("pptx") && !is_ooxml_format("pdf"));
    }

    #[test]
    fn formats_come_from_the_extension() {
        assert_eq!(document_format("a/b/report.DOCX"), Ok("docx"));
        assert_eq!(document_format("sheet.xltm"), Ok("xlsx"));
        assert_eq!(document_file_kind("deck.potm").as_deref(), Ok("potm"));
        assert_eq!(normalize_office_format("TSV"), Ok("tsv"));
    }

    #[test]
    fn legacy_binary_files_are_refused_with_the_conversion_named() {
        assert_eq!(
            document_format("old.doc").unwrap_err(),
            "Unsupported Office Use format: .doc is a legacy binary file, not an Office package. action:'open' converts it to .docx beside the original when LibreOffice is installed; otherwise save it as .docx in Microsoft Office first, then work on that file."
        );
        assert!(document_format("old.PPS").unwrap_err().contains("converts it to .pptx"));
        assert_eq!(legacy_package_kind("a/old.XLS"), "xlsx");
        assert_eq!(legacy_package_kind("new.xlsx"), "");
        assert_eq!(document_format("notes.txt").unwrap_err(), "Unsupported Office Use format: .txt");
        assert_eq!(document_format("README").unwrap_err(), "Unsupported Office Use format: .(none)");
        assert_eq!(normalize_office_format("").unwrap_err(), "Unsupported Office Use format: .(none)");
    }

    #[test]
    fn extname_follows_node() {
        assert_eq!(extname("a/b.txt"), ".txt");
        assert_eq!(extname("a.b/c"), "");
        assert_eq!(extname(".bashrc"), "");
        assert_eq!(extname("a."), ".");
        assert_eq!(extname("a.tar.gz"), ".gz");
        assert_eq!(extname(".."), "");
        assert_eq!(extname("..."), ".");
        assert_eq!(extname("a/.x.docx"), ".docx");
        assert_eq!(extname("dir/"), "");
        assert_eq!(extname("a.docx/"), ".docx");
    }
}
