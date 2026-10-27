// Path semantics shared by every stage: prefix tests that survive
// Windows verbatim/UNC forms, wire encoding, and the relative form used
// for inventory and match output.
use super::*;

pub(super) fn path_has_segment(path: &Path, segment: &str) -> bool {
    path.components()
        .any(|component| component.as_os_str() == segment)
}

pub(super) fn normalized_operand(operand: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(operand).unwrap_or_else(|_| operand.to_path_buf());
    PathBuf::from(wire_path(&canonical))
}

pub(super) fn path_starts_with(rooted: &Path, root: &Path) -> bool {
    if rooted.starts_with(root) {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        let mut rooted = normalized_bytes(rooted, false);
        let root = normalized_bytes(root, true);
        for expected in root {
            if rooted.next() != Some(expected) {
                return false;
            }
        }
        // Component boundary: the remainder is empty or starts at a separator.
        matches!(rooted.next(), None | Some(b'/'))
    }
    #[cfg(not(target_os = "windows"))]
    {
        rooted.starts_with(root)
    }
}

/// Allocation-free Windows comparison form over the borrowed encoded bytes:
/// `\\?\UNC\` becomes `\\`, `\\?\` is dropped, `\` maps to `/` and ASCII is
/// lowercased (non-ASCII bytes compare exactly). `trim_trailing` drops
/// trailing separators so roots such as `C:\` compare as `C:`.
#[cfg(target_os = "windows")]
fn normalized_bytes(path: &Path, trim_trailing: bool) -> impl Iterator<Item = u8> + '_ {
    let mut bytes = path.as_os_str().as_encoded_bytes();
    let mut prefix: &'static [u8] = b"";
    if let Some(rest) = bytes.strip_prefix(br"\\?\UNC\") {
        prefix = br"\\";
        bytes = rest;
    } else if let Some(rest) = bytes.strip_prefix(br"\\?\") {
        bytes = rest;
    }
    if trim_trailing {
        while let [rest @ .., b'\\' | b'/'] = bytes {
            bytes = rest;
        }
    }
    prefix.iter().chain(bytes).map(|&b| match b {
        b'\\' => b'/',
        _ => b.to_ascii_lowercase(),
    })
}

pub(super) fn relative_inventory_path(file: &Path, root: &Path) -> Option<String> {
    if let Ok(relative) = file.strip_prefix(root) {
        return Some(relative.to_string_lossy().replace('\\', "/"));
    }
    #[cfg(windows)]
    {
        if !path_starts_with(file, root) {
            return None;
        }
        let file = wire_path(file).replace('\\', "/");
        let root = wire_path(root).replace('\\', "/");
        Some(
            file[root.trim_end_matches('/').len()..]
                .trim_start_matches('/')
                .to_string(),
        )
    }
    #[cfg(not(windows))]
    file.strip_prefix(root)
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

pub(super) fn is_filesystem_root(path: &Path) -> bool {
    path.has_root() && path.parent().is_none()
}

pub(super) fn wire_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    value.into_owned()
}

#[cfg(test)]
mod path_starts_with_tests {
    use super::*;

    fn p(s: &str) -> &Path {
        Path::new(s)
    }

    #[test]
    fn equal_ancestor_sibling_disjoint() {
        let sep = std::path::MAIN_SEPARATOR;
        let root = format!("{sep}proj{sep}src");
        let child = format!("{root}{sep}a{sep}b.rs");
        let sibling = format!("{root}x{sep}a.rs");
        let other = format!("{sep}other{sep}src");
        assert!(path_starts_with(p(&root), p(&root)));
        assert!(path_starts_with(p(&child), p(&root)));
        assert!(!path_starts_with(p(&root), p(&child)));
        assert!(!path_starts_with(p(&sibling), p(&root)));
        assert!(!path_starts_with(p(&other), p(&root)));
    }

    #[test]
    fn unicode_names() {
        let sep = std::path::MAIN_SEPARATOR;
        let root = format!("{sep}프로젝트{sep}소스");
        assert!(path_starts_with(
            p(&format!("{root}{sep}파일.rs")),
            p(&root)
        ));
        assert!(!path_starts_with(
            p(&format!("{root}2{sep}파일.rs")),
            p(&root)
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_case_and_separators() {
        assert!(path_starts_with(p(r"C:\Proj\Src\a.rs"), p("c:/proj/SRC")));
        assert!(path_starts_with(p("C:/Proj/src"), p(r"c:\PROJ\src\")));
        assert!(!path_starts_with(p(r"C:\Proj\Srcx\a.rs"), p("c:/proj/src")));
        assert!(!path_starts_with(p(r"C:\Proj"), p(r"C:\Proj\Src")));
        // Non-ASCII is compared exactly, not case-folded.
        assert!(path_starts_with(p(r"C:\Ü\a"), p(r"c:\Ü")));
        assert!(!path_starts_with(p(r"C:\Ü\a"), p(r"c:\ü")));
    }

    #[cfg(windows)]
    #[test]
    fn windows_verbatim_unc_roots_and_trailing() {
        assert!(path_starts_with(p(r"\\?\C:\Proj\a.rs"), p(r"c:\proj")));
        assert!(path_starts_with(p(r"C:\Proj\a.rs"), p(r"\\?\c:\PROJ")));
        assert!(path_starts_with(
            p(r"\\?\UNC\srv\share\d\a"),
            p(r"\\SRV\share")
        ));
        assert!(path_starts_with(
            p(r"\\srv\share\d"),
            p(r"\\?\UNC\srv\share\")
        ));
        assert!(!path_starts_with(
            p(r"\\srv\share2\d"),
            p(r"\\?\UNC\srv\share")
        ));
        assert!(path_starts_with(p(r"C:\a"), p(r"C:\")));
        assert!(path_starts_with(p(r"C:\"), p(r"C:\")));
        assert!(!path_starts_with(p(r"D:\a"), p(r"C:\")));
    }
}

pub(super) fn display_path(operand: &str, operand_path: &Path, file: &Path) -> String {
    let Some(rel) = relative_inventory_path(file, operand_path) else {
        return wire_path(file);
    };
    // An exact-file operand is its own empty relative path. No per-result
    // filesystem stat is needed to distinguish it from a directory operand.
    if rel.is_empty() {
        return operand.to_string();
    }
    let sep = if operand.contains('/') && !operand.contains('\\') {
        "/"
    } else {
        std::path::MAIN_SEPARATOR_STR
    };
    let rel = rel.replace(['/', '\\'], sep);
    let trimmed = operand.trim_end_matches(['/', '\\']);
    format!("{trimmed}{sep}{rel}")
}
