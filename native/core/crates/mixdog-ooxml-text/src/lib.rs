//! Plain-text extraction from Office Open XML packages (`.docx`, `.pptx`, `.xlsx`, `.xlsm`), shared by the read tool and
//! the lowering of attached files: the output is byte for byte what Node's `attachments/office-extract.mjs` produced, so
//! no ZIP or XML library is used. Office files are ZIP containers holding XML parts; this crate reads the central
//! directory (stored and raw-deflate entries, every inflated size capped) and makes one tag-level pass over the document,
//! slide and sheet XML.
//!
//! The entries are [`extract_ooxml_text`] (a file: the text, or the `Error: ...` line the read tool shows),
//! [`extract_ooxml_text_from_buffer`] (the bytes and the file name, the same) and
//! [`try_extract_ooxml_text_from_buffer`] (`None` instead of an error text, with the caller's inflated-size limits);
//! [`media::office_text_for_file`] is the text of an attached file in a lowered request.

mod docx;
pub mod legacy;
pub mod media;
mod numfmt;
mod pptx;
mod scan;
mod xlsx;
mod zip;

use std::io;
use std::path::Path;

use mixdog_fsio::ReadProof;
use mixdog_js::js_to_lowercase;
use mixdog_js::uv_error::error_code;

/// Whole-container read cap. Office decks with embedded media can be large; the XML parts we extract are a tiny fraction,
/// but the container must be read to locate them. Beyond this the caller gets a clear refusal.
pub const OFFICE_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// The default `maxOutputBytes` of the entries.
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 100 * 1024;

/// The output cap of [`extract_ooxml_text`] and [`extract_ooxml_text_from_buffer`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExtractOptions {
    pub max_output_bytes: usize,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self { max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES }
    }
}

/// The limits of [`try_extract_ooxml_text_from_buffer`]: `maxOutputBytes`, and the inflated-size caps a caller lowers
/// below the built-in ones (`maxPartBytes`, `maxContainerBytes`; 0 keeps the built-in cap).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_output_bytes: usize,
    pub max_part_bytes: u64,
    pub max_container_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self { max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES, max_part_bytes: 0, max_container_bytes: 0 }
    }
}

/// Why an extraction failed.
pub(crate) enum Failure {
    /// A structural refusal (`OfficeFormatError`): shown as `Error: <message>`.
    Format(String),
    /// Any other failure: shown as `Error: office extraction failed — <message>`.
    Other(String),
}

/// `capOutput`: the text cut at `max_output_bytes` (on a UTF-8 boundary) and marked.
pub(crate) fn cap_output(text: &str, max_output_bytes: usize) -> String {
    if text.len() <= max_output_bytes {
        return text.to_owned();
    }
    // Drop the replacement characters a split multi-byte sequence leaves.
    let cut = String::from_utf8_lossy(&text.as_bytes()[..max_output_bytes]);
    let cut = cut.trim_end_matches('\u{fffd}');
    format!("{cut}\n... [office text truncated at {max_output_bytes} bytes]")
}

fn size_refusal(size: u64) -> Failure {
    Failure::Format(format!("office file is {size} bytes (max {OFFICE_MAX_BYTES}); extract the part you need with a shell unzip instead"))
}

/// `extractOoxmlCore`.
fn extract_core(buf: &[u8], filename: &str, limits: &Limits) -> Result<String, Failure> {
    // The last five UTF-16 units of the lower-cased name.
    let units: Vec<u16> = js_to_lowercase(filename).encode_utf16().collect();
    let mut ext = String::from_utf16_lossy(&units[units.len().saturating_sub(5)..]);
    if buf.len() as u64 > OFFICE_MAX_BYTES {
        return Err(size_refusal(buf.len() as u64));
    }
    // A legacy .doc/.xls/.ppt is an OLE compound file, not a ZIP package, and it often arrives renamed to .docx.
    if legacy::is_legacy_office_buffer(buf) {
        return Err(Failure::Format(legacy::LEGACY_OFFICE_REFUSAL.to_owned()));
    }
    let zip = zip::Zip::open(buf, limits)?;
    if !matches!(ext.as_str(), ".docx" | ".xlsx" | ".xlsm" | ".pptx") {
        if zip.has("word/document.xml") {
            ext = ".docx".to_owned();
        } else if zip.has("xl/workbook.xml") {
            ext = ".xlsx".to_owned();
        }
    }
    match ext.as_str() {
        ".docx" => docx::docx_text(&zip, limits.max_output_bytes),
        ".xlsx" | ".xlsm" => xlsx::workbook_text(&zip, limits.max_output_bytes),
        _ => pptx::presentation_text(&zip, limits.max_output_bytes),
    }
}

/// Buffer form of [`extract_ooxml_text`], shared by the read tool and provider lowering. Pure in (bytes, file name
/// extension, limit): the same bytes always yield the same text. The format comes from the file name's extension, else
/// from the package's own parts. Failures return `Error: ...`.
pub fn extract_ooxml_text_from_buffer(buf: &[u8], filename: &str, options: &ExtractOptions) -> String {
    let limits = Limits { max_output_bytes: options.max_output_bytes, ..Limits::default() };
    match extract_core(buf, filename, &limits) {
        Ok(text) => text,
        Err(Failure::Format(message)) => format!("Error: {message}"),
        Err(Failure::Other(message)) => format!("Error: office extraction failed — {message}"),
    }
}

/// The same extraction, but a file that cannot be read yields `None` instead of an `Error: ...` string, so provider
/// lowering never mistakes a document that happens to start with "Error:" for a failure (or the reverse).
pub fn try_extract_ooxml_text_from_buffer(buf: &[u8], filename: &str, limits: &Limits) -> Option<String> {
    extract_core(buf, filename, limits).ok()
}

/// libuv's description of the codes a read of a file meets (`uv_strerror`).
fn describe(code: &str) -> &'static str {
    match code {
        "ENOENT" => "no such file or directory",
        "EACCES" => "permission denied",
        "EPERM" => "operation not permitted",
        "EBUSY" => "resource busy or locked",
        "EMFILE" => "too many open files",
        "ENOTDIR" => "not a directory",
        "EISDIR" => "illegal operation on a directory",
        "EIO" => "i/o error",
        "EINVAL" => "invalid argument",
        "ELOOP" => "too many symbolic links encountered",
        "ENAMETOOLONG" => "name too long",
        "ENOMEM" => "not enough memory",
        "ENXIO" => "no such device or address",
        _ => "unknown error",
    }
}

/// `err.message` of a failed `syscall` on `path`: `CODE: description, syscall 'path'`.
fn os_message(error: &io::Error, syscall: &str, path: &Path) -> String {
    match error_code(error) {
        Some(code) => format!("{code}: {}, {syscall} '{}'", describe(code), path.display()),
        None => error.to_string(),
    }
}

/// Extracts plain text from a `.docx`, `.pptx` or `.xlsx`/`.xlsm` file. Always returns a flat string (batch-safe);
/// failures return an `Error: ...` string. The file is read with the caller's lane proof.
pub fn extract_ooxml_text<P: ReadProof>(proof: &P, path: &Path, options: &ExtractOptions) -> String {
    let failed = |message: String| format!("Error: office extraction failed — {message}");
    let metadata = match mixdog_fsio::metadata(proof, path) {
        Ok(metadata) => metadata,
        Err(error) => return failed(os_message(&error, "stat", path)),
    };
    if metadata.len() > OFFICE_MAX_BYTES {
        return match size_refusal(metadata.len()) {
            Failure::Format(message) | Failure::Other(message) => format!("Error: {message}"),
        };
    }
    if metadata.is_dir() {
        return failed("EISDIR: illegal operation on a directory, read".to_owned());
    }
    match mixdog_fsio::read(proof, path) {
        Ok(bytes) => extract_ooxml_text_from_buffer(&bytes, &path.to_string_lossy(), options),
        Err(error) => failed(os_message(&error, "open", path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cap_cuts_on_a_character_boundary_and_marks_the_cut() {
        assert_eq!(cap_output("abc", 3), "abc");
        assert_eq!(cap_output("abcd", 3), "abc\n... [office text truncated at 3 bytes]");
        // "가" is three bytes: a cut at four bytes leaves one byte of the second, which is dropped.
        assert_eq!(cap_output("가나", 4), "가\n... [office text truncated at 4 bytes]");
        assert_eq!(cap_output("가나", 2), "\n... [office text truncated at 2 bytes]");
    }

    #[test]
    fn anything_that_is_not_a_package_is_refused_with_the_line_the_read_tool_shows() {
        let options = ExtractOptions::default();
        assert_eq!(
            extract_ooxml_text_from_buffer(b"plain text, not a zip", "a.docx", &options),
            "Error: office extraction failed — not a ZIP container (no end-of-central-directory record)"
        );
        let mut ole = legacy::OLE_COMPOUND_MAGIC.to_vec();
        ole.extend_from_slice(&[0; 64]);
        assert_eq!(extract_ooxml_text_from_buffer(&ole, "old.docx", &options), format!("Error: {}", legacy::LEGACY_OFFICE_REFUSAL));
        assert_eq!(try_extract_ooxml_text_from_buffer(&ole, "old.docx", &Limits::default()), None);
        assert_eq!(try_extract_ooxml_text_from_buffer(b"", "a.docx", &Limits::default()), None);
    }

    #[test]
    fn a_container_past_fifty_mebibytes_is_refused_before_it_is_opened() {
        let big = vec![0u8; 50 * 1024 * 1024 + 1];
        assert_eq!(
            extract_ooxml_text_from_buffer(&big, "a.docx", &ExtractOptions::default()),
            "Error: office file is 52428801 bytes (max 52428800); extract the part you need with a shell unzip instead"
        );
        assert_eq!(try_extract_ooxml_text_from_buffer(&big, "a.docx", &Limits::default()), None);
        let at_the_cap = vec![0u8; 50 * 1024 * 1024];
        assert!(extract_ooxml_text_from_buffer(&at_the_cap, "a.docx", &ExtractOptions::default()).contains("not a ZIP container"));
    }

    #[test]
    fn a_file_that_cannot_be_read_is_the_error_line_with_the_operating_system_words() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.docx");
        let text = extract_ooxml_text(&mixdog_fsio::Unlaned, &missing, &ExtractOptions::default());
        assert_eq!(text, format!("Error: office extraction failed — ENOENT: no such file or directory, stat '{}'", missing.display()));
        let text = extract_ooxml_text(&mixdog_fsio::Unlaned, dir.path(), &ExtractOptions::default());
        assert_eq!(text, "Error: office extraction failed — EISDIR: illegal operation on a directory, read");
    }
}
