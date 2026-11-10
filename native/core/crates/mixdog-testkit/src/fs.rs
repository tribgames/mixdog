//! Fixture file I/O. Each function panics naming the path when the operation fails.

use std::path::Path;
use std::path::PathBuf;

pub fn write(path: impl AsRef<Path>, contents: impl AsRef<[u8]>) {
    let path = path.as_ref();
    std::fs::write(path, contents).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

pub fn read(path: impl AsRef<Path>) -> Vec<u8> {
    let path = path.as_ref();
    std::fs::read(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

pub fn read_string(path: impl AsRef<Path>) -> String {
    let path = path.as_ref();
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

pub fn create_dir(path: impl AsRef<Path>) {
    let path = path.as_ref();
    std::fs::create_dir(path).unwrap_or_else(|e| panic!("create_dir {}: {e}", path.display()));
}

pub fn create_dir_all(path: impl AsRef<Path>) {
    let path = path.as_ref();
    std::fs::create_dir_all(path).unwrap_or_else(|e| panic!("create_dir_all {}: {e}", path.display()));
}

pub fn remove_file(path: impl AsRef<Path>) {
    let path = path.as_ref();
    std::fs::remove_file(path).unwrap_or_else(|e| panic!("remove_file {}: {e}", path.display()));
}

pub fn remove_dir_all(path: impl AsRef<Path>) {
    let path = path.as_ref();
    std::fs::remove_dir_all(path).unwrap_or_else(|e| panic!("remove_dir_all {}: {e}", path.display()));
}

pub fn exists(path: impl AsRef<Path>) -> bool {
    path.as_ref().exists()
}

pub fn is_dir(path: impl AsRef<Path>) -> bool {
    path.as_ref().is_dir()
}

pub fn canonical(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    std::fs::canonicalize(path).unwrap_or_else(|e| panic!("canonicalize {}: {e}", path.display()))
}

/// The names in a directory, sorted.
pub fn entry_names(dir: impl AsRef<Path>) -> Vec<std::ffi::OsString> {
    let dir = dir.as_ref();
    let mut names: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display()))
        .map(|entry| entry.unwrap_or_else(|e| panic!("read_dir {}: {e}", dir.display())).file_name())
        .collect();
    names.sort();
    names
}

/// Every file under `dir` as (path relative to `dir` with `/` separators, bytes), sorted.
pub fn tree(dir: impl AsRef<Path>) -> Vec<(String, Vec<u8>)> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        for name in entry_names(dir) {
            let path = dir.join(name);
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let relative = path.strip_prefix(root).expect("under root").to_string_lossy().replace('\\', "/");
                out.push((relative, read(&path)));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir.as_ref(), dir.as_ref(), &mut out);
    out
}

pub fn is_readonly(path: impl AsRef<Path>) -> bool {
    let path = path.as_ref();
    std::fs::metadata(path).unwrap_or_else(|e| panic!("metadata {}: {e}", path.display())).permissions().readonly()
}

pub fn set_readonly(path: impl AsRef<Path>, readonly: bool) {
    let path = path.as_ref();
    let mut permissions =
        std::fs::metadata(path).unwrap_or_else(|e| panic!("metadata {}: {e}", path.display())).permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = permissions.mode();
        permissions.set_mode(if readonly { mode & !0o222 } else { mode | 0o200 });
    }
    #[cfg(windows)]
    permissions.set_readonly(readonly);
    std::fs::set_permissions(path, permissions).unwrap_or_else(|e| panic!("set_permissions {}: {e}", path.display()));
}

#[cfg(unix)]
pub fn symlink_file(original: impl AsRef<Path>, link: impl AsRef<Path>) {
    std::os::unix::fs::symlink(original.as_ref(), link.as_ref()).expect("symlink");
}

#[cfg(windows)]
pub fn symlink_file(original: impl AsRef<Path>, link: impl AsRef<Path>) {
    std::os::windows::fs::symlink_file(original.as_ref(), link.as_ref()).expect("symlink");
}
