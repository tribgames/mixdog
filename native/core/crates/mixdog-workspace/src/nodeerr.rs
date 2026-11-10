//! Node's text for a failed system call, built from the OS error: `ENOENT: no such file or directory, open '<path>'`.
//! The phone shows these words (and the error's `code`), so an editor, file or preview path that fails on the file system
//! says what Node's `fs` said: libuv's name and description of the error, the call's name as Node's operation made it, and
//! the path (a second path after ` -> ` for rename and copy). One table, used by every such path.

use std::io;
use std::path::Path;

use crate::error::WsError;

/// libuv's name and description (`uv_err_name`, `uv_strerror`) of the error codes a file call meets.
const NAMES: &[(&str, &str)] = &[
    ("ENOENT", "no such file or directory"),
    ("EEXIST", "file already exists"),
    ("ENOTDIR", "not a directory"),
    ("EISDIR", "illegal operation on a directory"),
    ("EACCES", "permission denied"),
    ("EPERM", "operation not permitted"),
    ("ENOTEMPTY", "directory not empty"),
    ("EBUSY", "resource busy or locked"),
    ("EXDEV", "cross-device link not permitted"),
    ("EINVAL", "invalid argument"),
    ("ENOSPC", "no space left on device"),
    ("EMFILE", "too many open files"),
    ("ENAMETOOLONG", "name too long"),
    ("EROFS", "read-only file system"),
    ("ELOOP", "too many symbolic links encountered"),
    ("EIO", "i/o error"),
    ("ENOMEM", "not enough memory"),
    ("EAGAIN", "resource temporarily unavailable"),
    ("UNKNOWN", "unknown error"),
];

/// libuv's name for an OS error number (`uv_translate_sys_error` on Windows, the errno itself elsewhere).
fn name_of(raw: Option<i32>, kind: io::ErrorKind) -> &'static str {
    #[cfg(windows)]
    if let Some(code) = raw {
        return match code {
            2 | 3 | 15 | 18 | 53 | 67 | 123 | 161 | 206 | 1004 => "ENOENT",
            5 | 1314 => "EPERM",
            998 | 1920 => "EACCES",
            80 | 183 => "EEXIST",
            267 => "ENOTDIR",
            145 => "ENOTEMPTY",
            32 | 33 | 231 | 170 | 16 => "EBUSY",
            17 => "EXDEV",
            87 | 1 => "EINVAL",
            112 | 39 => "ENOSPC",
            4 => "EMFILE",
            111 => "ENAMETOOLONG",
            19 => "EROFS",
            1921 => "ELOOP",
            8 | 14 => "ENOMEM",
            _ => "UNKNOWN",
        };
    }
    #[cfg(unix)]
    if let Some(code) = raw {
        return match code {
            c if c == libc::ENOENT => "ENOENT",
            c if c == libc::EEXIST => "EEXIST",
            c if c == libc::ENOTDIR => "ENOTDIR",
            c if c == libc::EISDIR => "EISDIR",
            c if c == libc::EACCES => "EACCES",
            c if c == libc::EPERM => "EPERM",
            c if c == libc::ENOTEMPTY => "ENOTEMPTY",
            c if c == libc::EBUSY => "EBUSY",
            c if c == libc::EXDEV => "EXDEV",
            c if c == libc::EINVAL => "EINVAL",
            c if c == libc::ENOSPC => "ENOSPC",
            c if c == libc::EMFILE => "EMFILE",
            c if c == libc::ENAMETOOLONG => "ENAMETOOLONG",
            c if c == libc::EROFS => "EROFS",
            c if c == libc::ELOOP => "ELOOP",
            c if c == libc::EIO => "EIO",
            c if c == libc::ENOMEM => "ENOMEM",
            c if c == libc::EAGAIN => "EAGAIN",
            _ => "UNKNOWN",
        };
    }
    let _ = raw;
    match kind {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::AlreadyExists => "EEXIST",
        io::ErrorKind::PermissionDenied => "EACCES",
        _ => "UNKNOWN",
    }
}

fn description(name: &str) -> &'static str {
    NAMES.iter().find(|(known, _)| *known == name).map_or("unknown error", |(_, text)| text)
}

/// The static name libuv gives the error, as `Reason::Coded` carries it.
pub fn code_of(error: &io::Error) -> &'static str {
    let name = name_of(error.raw_os_error(), error.kind());
    NAMES.iter().find(|(known, _)| *known == name).map_or("UNKNOWN", |(known, _)| known)
}

/// `fs` error text without the paths: `ENOENT: no such file or directory, open`.
fn head(error: &io::Error, syscall: &str) -> (&'static str, String) {
    let name = code_of(error);
    (name, format!("{name}: {}, {syscall}", description(name)))
}

/// The failure of `syscall` on `path`, as Node's `fs` threw it.
pub fn io_error(error: &io::Error, syscall: &str, path: &Path) -> WsError {
    let (name, head) = head(error, syscall);
    WsError::coded(name, format!("{head} '{}'", path.display()))
}

/// The failure of a two-path call (`rename`, `copyfile`): `... rename 'a' -> 'b'`.
pub fn io_error2(error: &io::Error, syscall: &str, from: &Path, to: &Path) -> WsError {
    let (name, head) = head(error, syscall);
    WsError::coded(name, format!("{head} '{}' -> '{}'", from.display(), to.display()))
}

/// `result`'s error as `io_error` names it.
pub trait AtPath<T> {
    fn at(self, syscall: &str, path: &Path) -> Result<T, WsError>;
}

impl<T> AtPath<T> for io::Result<T> {
    fn at(self, syscall: &str, path: &Path) -> Result<T, WsError> {
        self.map_err(|error| io_error(&error, syscall, path))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn raw(code: i32) -> io::Error {
        io::Error::from_raw_os_error(code)
    }

    #[test]
    fn windows_codes_are_libuv_names() {
        let at = Path::new("C:\\a\\b");
        assert_eq!(io_error(&raw(2), "open", at).message, "ENOENT: no such file or directory, open 'C:\\a\\b'");
        assert_eq!(io_error(&raw(3), "scandir", at).message, "ENOENT: no such file or directory, scandir 'C:\\a\\b'");
        assert_eq!(io_error(&raw(267), "scandir", at).message, "ENOTDIR: not a directory, scandir 'C:\\a\\b'");
        assert_eq!(io_error(&raw(80), "open", at).message, "EEXIST: file already exists, open 'C:\\a\\b'");
        assert_eq!(io_error(&raw(5), "open", at).message, "EPERM: operation not permitted, open 'C:\\a\\b'");
        assert_eq!(io_error2(&raw(2), "rename", at, Path::new("D:\\c")).message, "ENOENT: no such file or directory, rename 'C:\\a\\b' -> 'D:\\c'");
    }
}