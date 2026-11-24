//! What a path adds to the root a call runs in. A path inside the root is allowed whatever form the root has (`C:\p`,
//! `\\?\C:\p`, `\\wsl$\d\p`, a mapped drive), compared in one folded form on both sides; a path outside it, or a link's
//! target outside it, is refused when it is a network share or a device. A name below the root is still judged
//! (device names, alternate streams, trailing dots).

use std::path::Path;

use super::read_paths;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Access {
    Read,
    Write,
}

/// The one comparable spelling of a path: `\\?\` and `\\?\UNC\` folded, separators `\`, no trailing separator, case folded
/// on Windows.
fn form(p: &str) -> String {
    let s = p.replace('/', "\\");
    let s = if let Some(rest) = s.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = s.strip_prefix("\\\\?\\")
        && rest.as_bytes().get(1) == Some(&b':')
    {
        rest.to_owned()
    } else {
        s
    };
    let s = s.trim_end_matches('\\').to_owned();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// The root's spelling for comparison.
pub(crate) fn roots_of(root: &Path) -> Vec<String> {
    vec![form(&root.to_string_lossy())]
}

/// The root's spellings for comparison, with its real path too (a mapped drive's real path is its share).
#[allow(clippy::disallowed_methods, reason = "runs only as an interactive-lane job body")]
pub(crate) fn lane_roots(root: &Path) -> Vec<String> {
    let mut roots = roots_of(root);
    if let Ok(real) = mixdog_workspace::pathguard::canonical(root) {
        let real = form(&real.to_string_lossy());
        if !roots.contains(&real) {
            roots.push(real);
        }
    }
    roots
}

/// What lies below the root in `p` (empty for the root itself); `None` when `p` is outside every root.
fn below(roots: &[String], p: &str) -> Option<String> {
    let folded = form(p);
    roots.iter().find_map(|root| {
        if folded == *root {
            return Some(String::new());
        }
        folded.strip_prefix(root.as_str()).and_then(|rest| rest.strip_prefix('\\')).map(str::to_owned)
    })
}

/// The part of `p` the guards judge: what it adds below a root, else all of it.
pub(crate) fn judged(roots: &[String], p: &str) -> String {
    below(roots, p).unwrap_or_else(|| p.to_owned())
}

pub(crate) fn inside(roots: &[String], p: &str) -> bool {
    below(roots, p).is_some()
}

/// The refusal a path string earns against `roots`.
pub(crate) fn judge(roots: &[String], p: &str, access: Access) -> Option<&'static str> {
    let guard = |s: &str| match access {
        Access::Read => read_paths::string_guard(s),
        Access::Write => read_paths::write_guard(s),
    };
    match below(roots, p) {
        None => guard(p),
        // What lies below the root is a relative path: `a:stream` there is a stream of `a`, never the drive `a:`.
        Some(added) if added.is_empty() => None,
        Some(added) => guard(&format!(".\\{added}")).or_else(|| guard(p).filter(|_| read_paths::is_blocked_device_path(p))),
    }
}

/// [`judge`] as the text a tool answers.
pub(crate) fn string_refusal(roots: &[String], p: &str, access: Access) -> Option<String> {
    judge(roots, p, access).map(|reason| format!("Error: {reason}: {}", super::patch_guard::normalize_output_path(p)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(root: &str, p: &str) -> bool {
        judge(&roots_of(Path::new(root)), p, Access::Read).is_some()
    }

    /// A project root of any form lets what is inside it through, and still judges the names inside.
    #[test]
    fn a_path_inside_the_root_is_allowed_whatever_form_the_root_has() {
        for (root, inner) in [
            ("\\\\?\\C:\\proj", "\\\\?\\C:\\proj\\src\\a.rs"),
            ("\\\\?\\C:\\proj", "C:\\proj\\src\\a.rs"),
            ("\\\\wsl$\\Ubuntu\\home\\p", "\\\\wsl$\\Ubuntu\\home\\p\\a.rs"),
            ("\\\\wsl.localhost\\Ubuntu\\home\\p", "//wsl.localhost/Ubuntu/home/p/a.rs"),
            ("\\\\server\\share\\proj", "\\\\?\\UNC\\server\\share\\proj\\a.rs"),
        ] {
            assert!(!refused(root, inner), "{root} / {inner}");
            assert!(!refused(root, root), "{root}");
        }
        for (root, inner) in [("\\\\?\\C:\\proj", "\\\\?\\C:\\proj\\src\\a.txt:stream"), ("\\\\wsl$\\Ubuntu\\home\\p", "\\\\wsl$\\Ubuntu\\home\\p\\NUL")] {
            assert!(refused(root, inner) == cfg!(windows), "{root} / {inner}");
        }
    }

    /// What leaves the root for a share or a device is refused.
    #[test]
    fn a_path_outside_the_root_for_a_share_or_device_is_refused() {
        for outside in ["\\\\host\\share\\x", "//host/share/x", "\\\\?\\D:\\x", "\\\\.\\PhysicalDrive0", "\\\\wsl$\\Other\\x"] {
            assert!(refused("\\\\wsl$\\Ubuntu\\home\\p", outside), "{outside}");
        }
        assert!(refused("C:\\proj", "\\\\host\\share\\x"));
        assert!(!refused("C:\\proj", "C:\\elsewhere\\x"));
    }
}
