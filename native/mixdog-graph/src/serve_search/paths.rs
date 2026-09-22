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
        let rooted = wire_path(rooted).replace('\\', "/");
        let root = wire_path(root).replace('\\', "/");
        let rooted = rooted.as_bytes();
        let root = root.trim_end_matches('/').as_bytes();
        if rooted.eq_ignore_ascii_case(root) {
            return true;
        }
        if rooted.len() <= root.len() || !rooted[..root.len()].eq_ignore_ascii_case(root) {
            return false;
        }
        matches!(rooted[root.len()], b'\\' | b'/')
    }
    #[cfg(not(target_os = "windows"))]
    {
        rooted.starts_with(root)
    }
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
