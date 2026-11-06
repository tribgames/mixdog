//! libuv's wording of an OS failure, as Node's `err.message` carries it: `CODE: description,
//! syscall 'path'`.

use std::io;
use std::path::Path;

use mixdog_core_api::domain::fs::FsError;
use mixdog_core_api::domain::fs::FsErrorKind;

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

/// The same for a file-service failure, which keeps only the kind of the OS error.
pub(super) fn fs_message(error: &FsError, syscall: &str, path: &Path) -> String {
    let parts = match &error.kind {
        FsErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        FsErrorKind::PermissionDenied if cfg!(windows) => ("EPERM", "operation not permitted"),
        FsErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        FsErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        FsErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        FsErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        FsErrorKind::Io { os_code: Some(code) } => by_code(*code),
        _ => UNKNOWN,
    };
    message(parts, syscall, Some(path))
}