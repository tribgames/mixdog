//! libuv's wording of an OS failure, as Node's `err.message` carries it: `CODE: description,
//! syscall 'path'`.

use std::io;
use std::path::Path;

use mixdog_core_api::domain::fs::FsError;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::FsStep;

const UNKNOWN: (&str, &str) = ("UNKNOWN", "unknown error");

#[cfg(windows)]
fn by_code(code: i32) -> (&'static str, &'static str) {
    match code {
        2 | 3 | 15 | 53 | 123 | 161 => ("ENOENT", "no such file or directory"),
        4 => ("EMFILE", "too many open files"),
        5 | 1314 => ("EPERM", "operation not permitted"),
        19 => ("EROFS", "read-only file system"),
        32 => ("EBUSY", "resource busy or locked"),
        39 | 112 => ("ENOSPC", "no space left on device"),
        50 => ("ENOTSUP", "operation not supported on socket"),
        80 | 183 => ("EEXIST", "file already exists"),
        87 => ("EINVAL", "invalid argument"),
        145 => ("ENOTEMPTY", "directory not empty"),
        267 => ("ENOTDIR", "not a directory"),
        1 => ("EISDIR", "illegal operation on a directory"),
        _ => UNKNOWN,
    }
}

#[cfg(unix)]
fn by_code(code: i32) -> (&'static str, &'static str) {
    match code {
        libc::EPERM => ("EPERM", "operation not permitted"),
        libc::ENOENT => ("ENOENT", "no such file or directory"),
        libc::EIO => ("EIO", "i/o error"),
        libc::EACCES => ("EACCES", "permission denied"),
        libc::EBUSY => ("EBUSY", "resource busy or locked"),
        libc::EEXIST => ("EEXIST", "file already exists"),
        libc::ENOTDIR => ("ENOTDIR", "not a directory"),
        libc::EISDIR => ("EISDIR", "illegal operation on a directory"),
        libc::EINVAL => ("EINVAL", "invalid argument"),
        libc::EMFILE => ("EMFILE", "too many open files"),
        libc::ENOSPC => ("ENOSPC", "no space left on device"),
        libc::EROFS => ("EROFS", "read-only file system"),
        libc::ENOTEMPTY => ("ENOTEMPTY", "directory not empty"),
        libc::ENOTSUP => ("ENOTSUP", "operation not supported on socket"),
        _ => UNKNOWN,
    }
}

fn message((code, description): (&str, &str), syscall: &str, path: Option<&Path>) -> String {
    match path {
        Some(path) => format!("{code}: {description}, {syscall} '{}'", path.display()),
        None => format!("{code}: {description}, {syscall}"),
    }
}

/// `err.message` of a failed `syscall` on `path`; an error that is not an OS error keeps its text.
pub(super) fn io_message(error: &io::Error, syscall: &str, path: Option<&Path>) -> String {
    match error.raw_os_error() {
        Some(code) => message(by_code(code), syscall, path),
        None => error.to_string(),
    }
}

/// `err.message` of a failed write, from the step of Node's `atomicWrite` the file service reports:
/// `open '<tmp>'`, `write`, `fsync` or `rename '<tmp>' -> '<target>'`. A failure that names no step
/// reads as the rename of a temp file named like Node's (`<name>.mixdog-tmp-<8 hex>` beside the target).
pub(super) fn write_message(error: &FsError, target: &Path) -> String {
    let rename = |tmp: &Path, to: &Path| {
        let text = fs_message(error, "rename", tmp);
        // fs_message quotes one path; a rename names both.
        match text.strip_suffix('\'') {
            Some(head) => format!("{head}' -> '{}'", to.display()),
            None => text,
        }
    };
    match &error.step {
        Some(FsStep::Open { path }) => fs_message(error, "open", path.as_path()),
        Some(FsStep::Write) => message(kind_parts(&error.kind), "write", None),
        Some(FsStep::Fsync) => message(kind_parts(&error.kind), "fsync", None),
        Some(FsStep::Rename { from, to }) => rename(from.as_path(), to.as_path()),
        Some(FsStep::Unlink) => fs_message(error, "unlink", target),
        None => {
            let id = uuid::Uuid::new_v4().simple().to_string();
            let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            rename(&target.with_file_name(format!("{name}.mixdog-tmp-{}", &id[..8])), target)
        }
    }
}
/// `err.message` of a failed `readFileSync(target)`: the `open`, or for a directory (which opens)
/// the `read` that follows it, which names no path.
pub(super) fn read_message(error: &FsError, target: &Path) -> String {
    match error.kind {
        FsErrorKind::IsADirectory => message(kind_parts(&error.kind), "read", None),
        _ => fs_message(error, "open", target),
    }
}

/// The same for a file-service failure, which keeps only the kind of the OS error.
pub(super) fn fs_message(error: &FsError, syscall: &str, path: &Path) -> String {
    message(kind_parts(&error.kind), syscall, Some(path))
}

fn kind_parts(kind: &FsErrorKind) -> (&'static str, &'static str) {
    match kind {
        FsErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        FsErrorKind::PermissionDenied if cfg!(windows) => ("EPERM", "operation not permitted"),
        FsErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        FsErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        FsErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        FsErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        FsErrorKind::Io { os_code: Some(code) } => by_code(*code),
        _ => UNKNOWN,
    }
}
#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::common::AbsPath;

    use super::*;

    fn abs(path: &str) -> AbsPath {
        AbsPath::new(std::env::temp_dir().join(path)).unwrap()
    }

    fn failing(step: Option<FsStep>) -> FsError {
        let error = FsError::new(FsErrorKind::NotFound, None);
        match step {
            Some(step) => error.at(step),
            None => error,
        }
    }

    /// Each step of the write names what Node's message names, with the real temp path.
    #[test]
    fn a_write_failure_names_the_step_that_failed() {
        let target = abs("d/a.txt");
        let tmp = abs("d/a.txt.mixdog-tmp-0123abcd");
        let enoent = "ENOENT: no such file or directory";
        let open = failing(Some(FsStep::Open { path: tmp.clone() }));
        assert_eq!(write_message(&open, target.as_path()), format!("{enoent}, open '{}'", tmp.as_path().display()));
        assert_eq!(write_message(&failing(Some(FsStep::Write)), target.as_path()), format!("{enoent}, write"));
        assert_eq!(write_message(&failing(Some(FsStep::Fsync)), target.as_path()), format!("{enoent}, fsync"));
        let rename = failing(Some(FsStep::Rename { from: tmp.clone(), to: target.clone() }));
        assert_eq!(
            write_message(&rename, target.as_path()),
            format!("{enoent}, rename '{}' -> '{}'", tmp.as_path().display(), target.as_path().display())
        );
        let unlink = failing(Some(FsStep::Unlink));
        assert_eq!(write_message(&unlink, target.as_path()), format!("{enoent}, unlink '{}'", target.as_path().display()));
    }

    /// `readFileSync` of a missing file fails at `open '<path>'`; of a directory at `read`, which
    /// names no path.
    #[test]
    fn a_read_failure_names_the_open_or_for_a_directory_the_read() {
        let target = abs("d/a.txt");
        assert_eq!(read_message(&failing(None), target.as_path()), format!("ENOENT: no such file or directory, open '{}'", target.as_path().display()));
        let dir = FsError::new(FsErrorKind::IsADirectory, None);
        assert_eq!(read_message(&dir, target.as_path()), "EISDIR: illegal operation on a directory, read");
    }

    /// A failure with no step reads as the rename of a temp file named like Node's.
    #[test]
    fn a_failure_without_a_step_reads_as_the_rename_of_a_mixdog_temp_file() {
        let target = abs("w/dir/a.txt");
        let text = write_message(&failing(None), target.as_path());
        let prefix = format!("ENOENT: no such file or directory, rename '{}", target.as_path().with_file_name("a.txt.mixdog-tmp-").display());
        assert!(text.starts_with(&prefix), "{text}");
        let rest = &text[prefix.len()..];
        let tail = format!("' -> '{}'", target.as_path().display());
        assert_eq!(rest.len(), 8 + tail.len());
        assert!(rest[..8].bytes().all(|b| b.is_ascii_hexdigit()));
        assert!(rest.ends_with(&tail));
    }
}