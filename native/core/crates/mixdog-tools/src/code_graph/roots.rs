//! Which project root a call indexes: from its file anchors, its single `file` anchor or the
//! working directory itself — refusing unbounded or ambiguous trees.
#![allow(
    clippy::disallowed_methods,
    reason = "blocking filesystem reads; the whole call runs as one maintenance-lane job (CodeGraphTool::call)"
)]

use std::path::{Component, Path, PathBuf};

use super::args::Args;

/// A directory holding any of these is a project.
pub(super) const SENTINELS: [&str; 11] = [
    "package.json",
    ".git",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "setup.py",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "build.sbt",
    "Package.swift",
];

/// Discovered child projects a sentinel-free parent fans out over.
pub(super) const FEDERATION_CAP: usize = 8;

/// `input` against `base`, with `.`/`..` folded lexically.
pub(super) fn abs_from(base: &Path, input: &str) -> PathBuf {
    let joined = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        base.join(input)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn canonical_key(path: &Path) -> String {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = resolved.to_string_lossy().replace('\\', "/");
    let text = text.trim_start_matches("//?/").trim_end_matches('/').to_string();
    if cfg!(windows) { text.to_lowercase() } else { text }
}

/// Home and temp: an implicit ancestor walk never crosses them.
fn user_boundaries() -> Vec<String> {
    [dirs::home_dir(), Some(std::env::temp_dir())]
        .into_iter()
        .flatten()
        .map(|p| canonical_key(&p))
        .collect()
}

fn has_sentinel(dir: &Path) -> bool {
    SENTINELS.iter().any(|s| dir.join(s).exists())
}

pub(super) fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
}

/// The directory itself or its nearest ancestor holding a sentinel. `stop_at_user_boundary`
/// marks a guessed root: it yields nothing at home/temp instead of adopting a stray sentinel.
pub(super) fn find_dir_project_root(dir: &Path, stop_at_user_boundary: bool) -> Option<PathBuf> {
    let stops = if stop_at_user_boundary { user_boundaries() } else { Vec::new() };
    let mut current = abs_from(Path::new(""), &dir.to_string_lossy());
    loop {
        let parent = current.parent()?.to_path_buf();
        if stops.contains(&canonical_key(&current)) {
            return None;
        }
        if has_sentinel(&current) {
            return Some(current);
        }
        current = parent;
    }
}

pub(super) fn child_project_roots(dir: &Path, cap: usize) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut children: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .collect();
    children.sort();
    children
        .into_iter()
        .filter(|c| has_sentinel(c))
        .take(cap)
        .collect()
}

fn within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

fn is_wildcard(file: &str) -> bool {
    file.contains(['*', '?', '[', ']', '{', '}'])
}

fn basename(path: &Path) -> String {
    path.file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned())
}

fn file_project_root(file: &Path, stop: bool) -> Option<PathBuf> {
    find_dir_project_root(file.parent()?, stop)
}

/// Every anchor exists and resolves to one detectable project (or one containing the rest).
fn aggregate_project_root(args: &Args, base: &Path, stop: bool) -> Option<PathBuf> {
    if args.files.is_empty() || args.files_is_list_string {
        return None;
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    for file in &args.files {
        if is_wildcard(file) {
            return None;
        }
        let abs = abs_from(base, file);
        let meta = std::fs::metadata(&abs).ok()?;
        let root = if meta.is_dir() {
            find_dir_project_root(&abs, stop)
        } else {
            file_project_root(&abs, stop)
        }?;
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    match roots.len() {
        0 => None,
        1 => roots.pop(),
        _ => roots
            .iter()
            .find(|c| roots.iter().all(|r| within(c, r)))
            .cloned(),
    }
}

/// A sentinel-free cwd that holds no project and contains every anchor is its own root.
fn bounded_sentinel_free_root(args: &Args, base: &Path) -> Option<PathBuf> {
    if args.files.is_empty() {
        return None;
    }
    if is_filesystem_root(base) || dirs::home_dir().is_some_and(|h| abs_from(Path::new(""), &h.to_string_lossy()) == *base) {
        return None;
    }
    if !base.is_dir() || !child_project_roots(base, 2).is_empty() {
        return None;
    }
    for file in &args.files {
        if is_wildcard(file) {
            return None;
        }
        let abs = abs_from(base, file);
        if !abs.exists() || !within(base, &abs) {
            return None;
        }
    }
    Some(base.to_path_buf())
}

/// An exact file outside every project is its own directory's bounded root.
fn bounded_exact_file_root(abs_file: &Path) -> Option<PathBuf> {
    let dir = abs_file.parent()?.to_path_buf();
    if is_filesystem_root(&dir) || dirs::home_dir().is_some_and(|h| h == dir) || !dir.is_dir() {
        return None;
    }
    Some(dir)
}

fn bounded_exact_file_aggregate_root(args: &Args, base: &Path) -> Option<PathBuf> {
    if args.files.is_empty() || args.files_is_list_string {
        return None;
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    for file in &args.files {
        if is_wildcard(file) {
            return None;
        }
        let abs = abs_from(base, file);
        if !std::fs::metadata(&abs).ok()?.is_file() {
            return None;
        }
        let root = bounded_exact_file_root(&abs)?;
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    (roots.len() == 1).then(|| roots.remove(0))
}

/// A relative anchor that exists nowhere under cwd but in exactly one child project.
fn relocate_under_child_project(args: &Args, base: &Path) -> Option<(PathBuf, Args)> {
    if args.files.is_empty() {
        return None;
    }
    for file in &args.files {
        if is_wildcard(file) || Path::new(file).is_absolute() || abs_from(base, file).exists() {
            return None;
        }
    }
    let holders: Vec<PathBuf> = child_project_roots(base, 8)
        .into_iter()
        .filter(|root| root != base)
        .filter(|root| args.files.iter().all(|f| abs_from(root, f).is_file()))
        .collect();
    if holders.len() != 1 {
        return None;
    }
    let root = holders.into_iter().next()?;
    let mut next = args.clone();
    next.files = args
        .files
        .iter()
        .map(|f| abs_from(&root, f).to_string_lossy().into_owned())
        .collect();
    Some((root, next))
}

/// Aggregate anchors outside any project: the root they share, a bounded sentinel-free tree,
/// or the child project they relocate into.
pub(super) fn resolve_aggregate_anchor_root(
    name: &str,
    args: &Args,
    base: &Path,
    explicit: bool,
) -> Result<(PathBuf, Args), String> {
    let root = aggregate_project_root(args, base, !explicit)
        .or_else(|| bounded_sentinel_free_root(args, base))
        .or_else(|| bounded_exact_file_aggregate_root(args, base));
    let (effective, mut next) = match root {
        Some(root) => (root, args.clone()),
        None => match relocate_under_child_project(args, base) {
            Some(relocated) => relocated,
            None => {
                let candidates: Vec<String> = child_project_roots(base, 5)
                    .into_iter()
                    .filter(|r| r != base)
                    .map(|r| format!("\"{}\"", basename(&r)))
                    .collect();
                return Err(format!(
                    "{name}: cwd '{}' is not inside a project and aggregate file anchors do not all exist under exactly one detectable project root. Refusing to index an arbitrary tree.{}",
                    base.display(),
                    if candidates.is_empty() {
                        String::new()
                    } else {
                        format!(" Project roots under this cwd: {} — anchor the call inside one of them.", candidates.join(", "))
                    }
                ));
            }
        },
    };
    // Relative anchors keep meaning the caller's cwd after the re-root.
    next.files = next
        .files
        .iter()
        .map(|f| abs_from(base, f).to_string_lossy().into_owned())
        .collect();
    Ok((effective, next))
}

pub(super) enum FileAnchor {
    /// The call answers with this text.
    Error(String),
    /// Re-home the call to this root (`None` keeps the cwd).
    Root(Option<PathBuf>),
}

/// One `file` anchor: an error text when it does not exist, else the root it re-homes to.
pub(super) fn resolve_file_anchor_root(
    name: &str,
    file_arg: &str,
    base: &Path,
    explicit: bool,
) -> Result<FileAnchor, String> {
    let abs = abs_from(base, file_arg);
    if !abs.exists() {
        return Ok(FileAnchor::Error(format!(
            "Error: {name}: file not found: {file_arg}"
        )));
    }
    if within(base, &abs) || explicit {
        return Ok(FileAnchor::Root(None));
    }
    let root = if abs.is_dir() {
        find_dir_project_root(&abs, true)
    } else {
        file_project_root(&abs, true).or_else(|| bounded_exact_file_root(&abs))
    };
    match root {
        Some(root) => Ok(FileAnchor::Root(Some(root))),
        None => Err(format!(
            "find_symbol: file '{file_arg}' is outside cwd '{}' and has no detectable project root (no package.json/.git ancestor). Provide an explicit cwd.",
            base.display()
        )),
    }
}

/// No anchor and no explicit cwd: the enclosing project root, or the cwd when it is a bounded
/// sentinel-free tree. A filesystem root, home or a parent of several projects is refused.
pub(super) fn resolve_directory_root(name: &str, cwd: &Path) -> Result<PathBuf, String> {
    if let Some(root) = find_dir_project_root(cwd, true) {
        return Ok(root);
    }
    let children = child_project_roots(cwd, 32);
    let boundary_root = find_dir_project_root(cwd, false);
    let unbounded = is_filesystem_root(cwd)
        || dirs::home_dir().is_some_and(|h| abs_from(Path::new(""), &h.to_string_lossy()) == *cwd);
    if !unbounded && children.len() <= 1 {
        return Ok(cwd.to_path_buf());
    }
    let listed = children
        .iter()
        .take(5)
        .map(|r| format!("\"{}\"", basename(r)))
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "{name}: cwd '{}' is not inside a project (no {} at it or any ancestor){}. {}Refusing to index an arbitrary tree. Switch Project with the session tool (set-project), or pass an explicit 'cwd' (repo root) or a 'file' anchor.",
        cwd.display(),
        SENTINELS.join("/"),
        if children.len() > 1 {
            format!(" and holds {} separate project roots ({listed})", children.len())
        } else {
            String::new()
        },
        boundary_root
            .map(|b| format!(
                "The nearest sentinel is at '{}' (home/temp), which is never auto-adopted. ",
                b.display()
            ))
            .unwrap_or_default()
    ))
}
