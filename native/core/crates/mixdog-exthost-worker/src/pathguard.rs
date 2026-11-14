//! The approved-path guard (`approvedPath`, `realPath` and `isInside` of `src/ext-host/methods.mjs` and `path-scope.mjs`).

use std::io;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use crate::error::CodedError;

const NOT_APPROVED: &str = "path_not_approved";

/// Node's `path.resolve`: absolute against the process folder, separators and `.`/`..` settled lexically (a `..` at the root
/// stays at the root), without touching the disk.
pub fn resolve(path: &Path) -> PathBuf {
    let path = if path.as_os_str().is_empty() {
        Path::new(".")
    } else {
        path
    };
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

/// Case-folded on Windows, where paths compare without regard to case (Node's `path.relative` lower-cases both there).
fn comparable(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    } else {
        path.to_path_buf()
    }
}

/// Whether `target` is `root` or inside it. Leaving the root means the relative path is exactly `..`, starts with a `..`
/// component, or is absolute (another drive); a name that merely begins with two dots (`..notes.docx`) is an ordinary entry.
pub fn is_inside(root: &Path, target: &Path) -> bool {
    comparable(&resolve(target)).starts_with(comparable(&resolve(root)))
}

/// What `realpathSync` raises for a path that cannot be resolved, with its Node code.
fn node_error(error: &io::Error, path: &Path) -> CodedError {
    let (code, text) = match error.kind() {
        io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        _ => ("EIO", "i/o error"),
    };
    CodedError::new(
        code,
        format!("{code}: {text}, realpath '{}'", path.display()),
    )
}

/// A part of the path that is not there (and, on Windows, a file used as a folder, which the system reports as a missing path).
fn is_missing(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
        || (cfg!(windows) && error.kind() == io::ErrorKind::NotADirectory)
}

/// The path with every symlink and junction resolved, in `realpathSync.native`'s form (no `\\?\` prefix, 8.3 names spelled
/// out); a part that does not exist yet keeps its name. Any failure but a missing part is raised.
fn real_path(target: &Path) -> Result<PathBuf, CodedError> {
    match dunce::canonicalize(target) {
        Ok(real) => Ok(real),
        Err(error) if is_missing(&error) => match (target.parent(), target.file_name()) {
            (Some(parent), Some(name)) if parent != target && !parent.as_os_str().is_empty() => {
                Ok(real_path(parent)?.join(name))
            }
            _ => Err(node_error(&error, target)),
        },
        Err(error) => Err(node_error(&error, target)),
    }
}

/// JavaScript's `String.prototype.trim`: white space and the byte order mark.
fn trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// The path a call will touch, refused unless the approved paths cover it. It is normalized the way office authoring reads it
/// (trimmed, then resolved against `base`) and approved by its real path, so neither stray white space nor a symlink or
/// junction can lead outside the approved set. A relative `path` needs a `base`. Returns the resolved target, not the real path.
pub fn approved_path(approved: &[String], path: &str, base: &str) -> Result<PathBuf, CodedError> {
    let given = Path::new(trim(path));
    // Node's `isAbsolute`: on Windows a rooted path without a drive (`\x`) counts, a drive-relative one (`C:x`) does not.
    let rooted = given.has_root();
    if base.is_empty() && !rooted {
        return Err(CodedError::new(
            NOT_APPROVED,
            format!("path must be absolute: {path}"),
        ));
    }
    let target = if rooted {
        resolve(given)
    } else {
        resolve(&Path::new(base).join(given))
    };
    let real = real_path(&target)?;
    for root in approved {
        if is_inside(&real_path(&resolve(Path::new(root)))?, &real) {
            return Ok(target);
        }
    }
    Err(CodedError::new(
        NOT_APPROVED,
        format!("path is not approved for this call: {}", target.display()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        resolve(Path::new("scope-root"))
    }

    #[test]
    fn is_inside_settles_dot_dot_components_lexically() {
        let root = root();
        assert!(is_inside(&root, &root.join("a").join("..").join("b")));
        assert!(!is_inside(
            &root,
            &root.join("a").join("..").join("..").join("x")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_ignores_case_and_another_drive_is_outside() {
        let root = PathBuf::from(r"C:\Work\Project");
        assert!(is_inside(&root, Path::new(r"c:\work\PROJECT\File.docx")));
        assert!(!is_inside(&root, Path::new(r"D:\Work\Project\File.docx")));
        assert!(!is_inside(&root, Path::new(r"C:\Work\Project2")));
    }

    #[test]
    fn a_relative_path_without_a_base_names_itself_in_the_refusal() {
        let error = approved_path(&[], "  rel/x.docx ", "").unwrap_err();
        assert_eq!(error.code, "path_not_approved");
        assert_eq!(error.message, "path must be absolute:   rel/x.docx ");
    }

    #[test]
    fn javascript_trim_strips_the_byte_order_mark() {
        assert_eq!(trim("\u{feff} a b\n"), "a b");
    }
}
