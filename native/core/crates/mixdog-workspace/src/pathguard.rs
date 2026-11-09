#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! Traversal- and symlink-guarded project paths (port of `projectEntryPathIn`).

use std::io;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use crate::error::WsError;
use crate::error::WsResult;

/// Case-folded on Windows, where paths compare case-insensitively.
pub fn comparable(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

/// `path` is `root` or under it, component-wise.
pub fn is_within(root: &Path, path: &Path) -> bool {
    comparable(path).starts_with(comparable(root))
}

/// Resolves `.` and `..` without touching the disk.
pub fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `fs::canonicalize` without the Windows verbatim prefix.
pub fn canonical(path: &Path) -> io::Result<PathBuf> {
    let real = std::fs::canonicalize(path)?;
    Ok(strip_verbatim(real))
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if rest.as_bytes().get(1) == Some(&b':') {
            return PathBuf::from(rest);
        }
    }
    path
}

/// The canonical form of `path` through its nearest existing ancestor.
pub fn canonical_through_existing(path: &Path) -> io::Result<PathBuf> {
    let mut existing = path.to_path_buf();
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        let Some(parent) = existing.parent().map(Path::to_path_buf) else { break };
        let Some(name) = existing.file_name().map(|n| n.to_os_string()) else { break };
        missing.push(name);
        existing = parent;
    }
    let mut real = canonical(&existing)?;
    for name in missing.into_iter().rev() {
        real.push(name);
    }
    Ok(real)
}

/// Node's `path.resolve`: absolute against the process folder, separators and `.`/`..` settled
/// lexically (a `..` at the root stays at the root), without touching the disk.
pub fn resolve(path: &Path) -> PathBuf {
    let path = if path.as_os_str().is_empty() { Path::new(".") } else { path };
    let full = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = PathBuf::new();
    for component in full.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Node's `canonicalPath` (`src/runtime/shared/worktrees/paths.mjs`): `resolve`, then the real path of
/// the nearest existing ancestor with the missing tail kept; the resolved path itself when no ancestor
/// can be read.
pub fn canonical_path(path: &Path) -> PathBuf {
    let full = resolve(path);
    let mut head = full.as_path();
    while !head.exists() {
        match head.parent() {
            Some(parent) => head = parent,
            None => return full,
        }
    }
    let Ok(real) = canonical(head) else { return full };
    match full.strip_prefix(head) {
        Ok(rest) if !rest.as_os_str().is_empty() => real.join(rest),
        _ => real,
    }
}

/// Absolute path of a project-relative entry; neither `..` nor a link may
/// leave the project.
pub fn project_entry_path(root: &Path, rel: &str) -> WsResult<PathBuf> {
    if !root.is_absolute() {
        return Err(WsError::invalid("Project root must be absolute."));
    }
    let root = lexical(root);
    let rel = rel.replace('\\', "/");
    let target = lexical(&root.join(rel));
    if !is_within(&root, &target) {
        return Err(WsError::denied(OUTSIDE_PROJECT));
    }
    let canonical_root = canonical(&root)?;
    let canonical_target = canonical_through_existing(&target)?;
    if !is_within(&canonical_root, &canonical_target) {
        return Err(WsError::denied(RESOLVES_OUTSIDE_PROJECT));
    }
    Ok(target)
}

pub const OUTSIDE_PROJECT: &str = "Path is outside the project.";
pub const RESOLVES_OUTSIDE_PROJECT: &str = "Path resolves outside the project.";

/// The refusal of [`project_entry_path`] for a path beyond the project. Every caller gets the permission refusal; the phone's calls (which
/// ask for `nodeErrors`) are answered with Node's plain `Error` of the same text (service.rs `map_error`).
pub fn is_beyond_project(error: &WsError) -> bool {
    matches!(error.reason, crate::error::Reason::PermissionDenied) && (error.message == OUTSIDE_PROJECT || error.message == RESOLVES_OUTSIDE_PROJECT)
}

/// Node's `absoluteLocalPath` (local-files.ts): the string trimmed, shape-checked, required to be absolute by the host's
/// `path.isAbsolute` (on Windows that includes a rooted `\dir`, which `path.resolve` then puts on the working directory's drive), and
/// resolved by the host's `path.resolve`.
pub fn absolute_local_path(value: &str) -> WsResult<PathBuf> {
    let text = mixdog_js::js_trim(value);
    if text.is_empty() || mixdog_js::utf16_len(text) > 16_384 || text.contains('\0') {
        return Err(WsError::invalid("path is invalid."));
    }
    if !mixdog_js::nodepath::is_absolute_host(text) {
        return Err(WsError::invalid("path must be absolute."));
    }
    Ok(PathBuf::from(mixdog_js::nodepath::resolve_host(&[text])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outside_and_symlink_escape_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        std::fs::create_dir(root.join("in")).unwrap();
        assert_eq!(project_entry_path(&root, "in/new.txt").unwrap(), root.join("in").join("new.txt"));
        let err = project_entry_path(&root, "../escape.txt").unwrap_err();
        assert_eq!((err.reason.clone(), err.message.as_str()), (crate::error::Reason::PermissionDenied, "Path is outside the project."));
        let outside = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_dir(outside.path(), root.join("link")).is_err() {
            return;
        }
        let err = project_entry_path(&root, "link/x.txt").unwrap_err();
        assert_eq!(err.message, "Path resolves outside the project.");
    }

    fn answer(text: &str) -> Result<String, String> {
        absolute_local_path(text).map(|path| path.to_string_lossy().into_owned()).map_err(|error| error.message)
    }

    /// Node's `absoluteLocalPath` for each class of input on a Windows host (expected values from `path.win32` of Node 22 with the
    /// working directory on the drive `D:`; here the drive is the test's own).
    #[cfg(windows)]
    #[test]
    fn absolute_local_path_answers_each_class_as_node_does() {
        let drive: String = std::env::current_dir().unwrap().to_string_lossy().chars().take(2).collect();
        let on_drive = |rest: &str| Ok(format!("{drive}{rest}"));
        for (text, expected) in [
            ("relative/dir", Err("path must be absolute.".to_owned())),
            ("C:foo", Err("path must be absolute.".to_owned())),
            ("C:", Err("path must be absolute.".to_owned())),
            ("", Err("path is invalid.".to_owned())),
            ("   ", Err("path is invalid.".to_owned())),
            ("a\0b", Err("path is invalid.".to_owned())),
            ("/dir", on_drive("\\dir")),
            ("\\dir", on_drive("\\dir")),
            ("/dir/../x/", on_drive("\\x")),
            ("//server", on_drive("\\server")),
            ("/", on_drive("\\")),
            ("//server/share", Ok("\\\\server\\share\\".to_owned())),
            ("\\\\server\\share\\a\\..\\b\\", Ok("\\\\server\\share\\b".to_owned())),
            ("C:\\a\\b\\..\\c\\", Ok("C:\\a\\c".to_owned())),
            ("c:/A/B/", Ok("c:\\A\\B".to_owned())),
            ("C:\\a\\", Ok("C:\\a".to_owned())),
            ("C:\\", Ok("C:\\".to_owned())),
            ("C:\\..", Ok("C:\\".to_owned())),
            (" D:\\x ", Ok("D:\\x".to_owned())),
            ("\\\\?\\C:\\x\\y", Ok("\\\\?\\C:\\x\\y".to_owned())),
            ("\\\\.\\C:\\x", Ok("\\\\.\\C:\\x".to_owned())),
            ("\\\\?\\UNC\\srv\\sh\\a", Ok("\\\\?\\UNC\\srv\\sh\\a".to_owned())),
            ("//?/C:/x", Ok("\\\\?\\C:\\x".to_owned())),
            ("//tmp/Mixed/", Ok("\\\\tmp\\Mixed\\".to_owned())),
        ] {
            assert_eq!(answer(text), expected, "{text:?}");
        }
    }

    /// The same classes on a POSIX host (`path.posix` of Node 22).
    #[cfg(not(windows))]
    #[test]
    fn absolute_local_path_answers_each_class_as_node_does() {
        for (text, expected) in [
            ("relative/dir", Err("path must be absolute.")),
            ("C:foo", Err("path must be absolute.")),
            ("\\dir", Err("path must be absolute.")),
            ("C:\\a", Err("path must be absolute.")),
            ("", Err("path is invalid.")),
            ("/dir/../x/", Ok("/x")),
            ("//server/share", Ok("/server/share")),
            ("//tmp/Mixed/", Ok("/tmp/Mixed")),
            ("/", Ok("/")),
            ("//", Ok("/")),
        ] {
            assert_eq!(answer(text), expected.map(str::to_owned).map_err(str::to_owned), "{text:?}");
        }
    }
}
