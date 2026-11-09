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
        return Err(WsError::plain("Path is outside the project."));
    }
    let canonical_root = canonical(&root)?;
    let canonical_target = canonical_through_existing(&target)?;
    if !is_within(&canonical_root, &canonical_target) {
        return Err(WsError::plain("Path resolves outside the project."));
    }
    Ok(target)
}

/// Absolute path of a client-supplied absolute string (trusted local lanes).
pub fn absolute_local_path(value: &str) -> WsResult<PathBuf> {
    let text = value.trim();
    if text.is_empty() || text.len() > 16_384 || text.contains('\0') {
        return Err(WsError::invalid("path is invalid."));
    }
    let path = Path::new(text);
    if !path.is_absolute() {
        return Err(WsError::invalid("path must be absolute."));
    }
    Ok(lexical(path))
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
        assert_eq!(err.message, "Path is outside the project.");
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
}
