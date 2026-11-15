//! Opening, saving and creating a package on disk (`loadPackage`, `packageBuffer`, `savePackage` of
//! `portable/portable-opc.mjs`, `createPortableOoxmlDocument` of `portable/portable-package.mjs`). A write reports the
//! path to the call's [`WriteNote`] first, so the turn review can capture the file's prior state.

use std::io;
use std::path::Path;

use mixdog_fsio::{ReadProof, WriteProof};
use mixdog_js::js_to_lowercase;
use mixdog_js::uv_error::error_code;
use mixdog_office_base::write_note::WriteNote;

use crate::blank::{FILE_KIND_FAMILIES, blank_parts, kind_family, package_of};
use crate::legacy::{is_legacy_office_buffer, legacy_office_error};
use crate::zipio::Package;

/// libuv's description of the codes a read or write of a file meets (`uv_strerror`).
fn describe(code: &str) -> &'static str {
    match code {
        "ENOENT" => "no such file or directory",
        "EACCES" => "permission denied",
        "EPERM" => "operation not permitted",
        "EBUSY" => "resource busy or locked",
        "EMFILE" => "too many open files",
        "ENOTDIR" => "not a directory",
        "EISDIR" => "illegal operation on a directory",
        "EEXIST" => "file already exists",
        "ENOSPC" => "no space left on device",
        "EROFS" => "read-only file system",
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
pub(crate) fn os_message(error: &io::Error, syscall: &str, path: &Path) -> String {
    match error_code(error) {
        Some(code) => format!("{code}: {}, {syscall} '{}'", describe(code), path.display()),
        None => error.to_string(),
    }
}

/// `loadPackage(path)` over bytes already read: the package, or why it cannot be one. A legacy Office file (an OLE
/// compound document, often renamed to `.docx`) is told what it is; a damaged or truncated archive is told to ask for an
/// intact copy.
pub fn open_package_bytes(data: &[u8], path: &str) -> Result<Package, String> {
    match Package::load(data) {
        Ok(package) => Ok(package),
        Err(reason) => {
            if is_legacy_office_buffer(data) {
                return Err(legacy_office_error(path));
            }
            Err(format!(
                "{path} is not a readable Office package ({}). The file is damaged or incomplete: ask for an intact copy, or open it in Microsoft Office and save a fresh file.",
                reason.trim()
            ))
        }
    }
}

/// `loadPackage(path)`: reads the file and opens it as a package, checking every entry's checksum.
pub fn load_package<P: ReadProof>(proof: &P, path: &Path) -> Result<Package, String> {
    let data = mixdog_fsio::read(proof, path).map_err(|error| os_message(&error, "open", path))?;
    open_package_bytes(&data, &path.display().to_string())
}

/// `packageBuffer(zip)`: the archive shape Office accepts: deflated entries written with DOS attributes, the way the
/// applications themselves write a package.
pub fn package_buffer(package: &Package) -> Result<Vec<u8>, String> {
    package.generate()
}

/// `savePackage(zip, path)`: the package written to `path`, after the note of the write.
pub fn save_package<P: WriteProof>(proof: &P, note: &dyn WriteNote, package: &Package, path: &Path) -> Result<(), String> {
    let bytes = package_buffer(package)?;
    note.note_write(path);
    mixdog_fsio::write(proof, path, bytes).map_err(|error| os_message(&error, "open", path))
}

/// `portableCreateSupported(fileKind)`.
pub fn portable_create_supported(file_kind: &str) -> bool {
    kind_family(&js_to_lowercase(file_kind)).is_some()
}

/// What a new document is made from: its kind (`docx`, `xlsx`, `pptx` or the template kinds `dotx`, `xltx`, `potx`), its
/// title (`Untitled` when empty) and, for a workbook, the name of its first sheet (`Sheet1` when empty).
#[derive(Debug, Clone, Copy)]
pub struct CreateOptions<'a> {
    pub file_kind: &'a str,
    pub title: &'a str,
    pub sheet_name: &'a str,
}

/// What `createPortableOoxmlDocument` reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedDocument {
    pub path: String,
    pub format: &'static str,
    pub file_kind: String,
    pub parts: Vec<String>,
}

/// `createPortableOoxmlDocument(path, options)`: a blank document written to `path`.
pub fn create_portable_ooxml_document<P: WriteProof>(
    proof: &P,
    note: &dyn WriteNote,
    path: &Path,
    options: &CreateOptions<'_>,
) -> Result<CreatedDocument, String> {
    let kind = js_to_lowercase(options.file_kind);
    let Some(family) = kind_family(&kind) else {
        let supported: Vec<&str> = FILE_KIND_FAMILIES.iter().map(|(known, _)| *known).collect();
        return Err(format!(
            "Portable Office creation supports {}; .{} requires Microsoft Office",
            supported.join(", "),
            if kind.is_empty() { "unknown" } else { kind.as_str() }
        ));
    };
    let title = if options.title.is_empty() { "Untitled" } else { options.title };
    let parts = blank_parts(family, title, &kind, options.sheet_name).unwrap_or_default();
    save_package(proof, note, &package_of(&parts), path)?;
    Ok(CreatedDocument {
        path: path.display().to_string(),
        format: family,
        file_kind: kind,
        parts: parts.into_iter().map(|(name, _)| name).collect(),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use mixdog_fsio::Unlaned;

    use super::*;
    use crate::legacy::OLE_COMPOUND_MAGIC;

    struct Ledger(Mutex<Vec<String>>);

    impl WriteNote for Ledger {
        fn note_write(&self, path: &Path) {
            self.0.lock().expect("ledger").push(path.display().to_string());
        }
    }

    fn options(kind: &str) -> CreateOptions<'_> {
        CreateOptions { file_kind: kind, title: "", sheet_name: "" }
    }

    #[test]
    fn a_created_document_is_noted_written_and_reads_back_with_its_parts() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("memo.docx");
        let ledger = Ledger(Mutex::new(Vec::new()));
        let created = create_portable_ooxml_document(&Unlaned, &ledger, &path, &options("DOCX")).expect("create");
        assert_eq!((created.format, created.file_kind.as_str()), ("docx", "docx"));
        assert_eq!(created.parts.len(), 7);
        assert_eq!(*ledger.0.lock().expect("ledger"), [path.display().to_string()]);
        let loaded = load_package(&Unlaned, &path).expect("load");
        assert!(loaded.text("docProps/core.xml").contains("<dc:title>Untitled</dc:title>"));
        assert_eq!(loaded.names()[..3], ["[Content_Types].xml", "_rels/", "_rels/.rels"]);
        assert!(loaded.text("word/document.xml").contains("<w:body><w:p/>"));
    }

    #[test]
    fn a_kind_without_a_portable_form_says_what_is_supported() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("a.doc");
        let note = Ledger(Mutex::new(Vec::new()));
        assert_eq!(
            create_portable_ooxml_document(&Unlaned, &note, &path, &options("doc")).unwrap_err(),
            "Portable Office creation supports docx, dotx, xlsx, xltx, pptx, potx; .doc requires Microsoft Office"
        );
        assert_eq!(
            create_portable_ooxml_document(&Unlaned, &note, &path, &options("")).unwrap_err(),
            "Portable Office creation supports docx, dotx, xlsx, xltx, pptx, potx; .unknown requires Microsoft Office"
        );
        assert!(note.0.lock().expect("ledger").is_empty());
        assert!(portable_create_supported("XLTX"));
        assert!(!portable_create_supported("csv"));
    }

    #[test]
    fn an_old_binary_file_a_damaged_file_and_a_missing_file_each_say_what_they_are() {
        let dir = tempfile::tempdir().expect("dir");
        let legacy = dir.path().join("old.docx");
        let mut bytes = OLE_COMPOUND_MAGIC.to_vec();
        bytes.extend_from_slice(&[0; 64]);
        mixdog_fsio::write(&Unlaned, &legacy, bytes).expect("write");
        let error = load_package(&Unlaned, &legacy).unwrap_err();
        assert_eq!(error, legacy_office_error(&legacy.display().to_string()));
        let damaged = dir.path().join("bad.docx");
        mixdog_fsio::write(&Unlaned, &damaged, b"PK nothing here").expect("write");
        let error = load_package(&Unlaned, &damaged).unwrap_err();
        assert_eq!(
            error,
            format!(
                "{} is not a readable Office package (Can't find end of central directory). The file is damaged or incomplete: ask for an intact copy, or open it in Microsoft Office and save a fresh file.",
                damaged.display()
            )
        );
        let missing = dir.path().join("none.docx");
        let error = load_package(&Unlaned, &missing).unwrap_err();
        assert!(error.starts_with("ENOENT: no such file or directory, open '"), "{error}");
    }
}
