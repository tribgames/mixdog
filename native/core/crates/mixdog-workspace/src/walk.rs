#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "blocking file bodies run only as lane jobs (lanes::run_fallible); the service never calls them on an async thread")]
//! Breadth-first project walks with nested `.gitignore` pruning (ports of
//! `workspaceFiles` in `workspace-search.ts` and `walkDirectories` in
//! `project-file-search.ts`). Both are blocking and run on the maintenance lane;
//! `stop` is polled between entries so a superseded walk ends early.

use std::collections::VecDeque;
use std::fs;
use std::path::Path;

use crate::glob::IgnoreRule;
use crate::glob::ignore_rules;
use crate::glob::ignored_path;
use crate::pathguard::canonical;

const TEXT_SKIPPED: &[&str] = &[
    ".git", ".hg", ".svn", ".mixdog", "node_modules", ".venv", "venv", "dist", "build", "out", "coverage", "target",
    "__pycache__",
];
pub const TEXT_MAX_FILES: usize = 20_000;
const TEXT_MAX_DEPTH: usize = 24;
pub const INDEX_MAX_ENTRIES: usize = 100_000;
const INDEX_PRUNED: &[&str] = &[".git", "node_modules"];

/// A folder's entries in the order the filesystem lists them, as Node's `readdir` and `opendir` give them (neither sorts):
/// the order of the walk is the order of the search results and of what a scan cap leaves out.
fn listed_entries(dir: &Path) -> Option<Vec<(String, fs::FileType)>> {
    let entries = fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|e| Some((e.file_name().to_string_lossy().into_owned(), e.file_type().ok()?)))
        .collect();
    Some(entries)
}

fn nested_rules(root: &Path, relative: &str, parent: &[IgnoreRule]) -> Vec<IgnoreRule> {
    match fs::read_to_string(root.join(relative).join(".gitignore")) {
        Ok(source) => {
            let nested = ignore_rules(&source, relative);
            if nested.is_empty() {
                parent.to_vec()
            } else {
                [parent, &nested].concat()
            }
        }
        Err(_) => parent.to_vec(),
    }
}

fn join(relative: &str, name: &str) -> String {
    if relative.is_empty() { name.to_owned() } else { format!("{relative}/{name}") }
}

/// Regular files for text search; symlinks are neither listed nor followed.
pub fn text_files(root: &Path, stop: &dyn Fn() -> bool) -> Vec<String> {
    let mut files = Vec::new();
    let mut queue: VecDeque<(String, usize, Vec<IgnoreRule>)> = VecDeque::from([(String::new(), 0, Vec::new())]);
    while let Some((relative, depth, parent)) = queue.pop_front() {
        if files.len() >= TEXT_MAX_FILES || stop() {
            break;
        }
        let rules = nested_rules(root, &relative, &parent);
        let Some(entries) = listed_entries(&root.join(&relative)) else { continue };
        for (name, kind) in entries {
            if files.len() >= TEXT_MAX_FILES {
                break;
            }
            let path = join(&relative, &name);
            if kind.is_dir() {
                if depth < TEXT_MAX_DEPTH && !TEXT_SKIPPED.contains(&name.as_str()) && !ignored_path(&path, true, &rules) {
                    queue.push_back((path, depth + 1, rules.clone()));
                }
            } else if kind.is_file() && !ignored_path(&path, false, &rules) {
                files.push(path);
            }
        }
    }
    files
}

/// A link is listed only when its canonical target lies inside the project (and
/// is not the project itself) and is not excluded as its own path would be.
fn link_allowed(root_real: &Path, root: &Path, path: &str, directory: bool, include_ignored: bool) -> bool {
    let Ok(target) = canonical(&root.join(path)) else { return false };
    let Ok(inside) = target.strip_prefix(root_real) else { return false };
    let segments: Vec<String> = inside.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if segments.is_empty() || segments.iter().any(|s| INDEX_PRUNED.contains(&s.as_str())) {
        return false;
    }
    if include_ignored {
        return true;
    }
    let mut rules = Vec::new();
    for depth in 0..segments.len() {
        let base = segments[..depth].join("/");
        match fs::read_to_string(root_real.join(&base).join(".gitignore")) {
            Ok(source) => rules.extend(ignore_rules(&source, &base)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
        let prefix = segments[..=depth].join("/");
        if ignored_path(&prefix, depth < segments.len() - 1 || directory, &rules) {
            return false;
        }
    }
    true
}

/// A folder the scan cap left unvisited, with the ignore rules it inherits.
#[derive(Clone)]
pub struct Pending {
    pub relative: String,
    pub rules: Vec<IgnoreRule>,
}

/// Breadth-first walk of `queue`, reporting each listed path (folders end in `/`) to `add`.
/// Stops after `max_entries` scanned entries and returns the folders left over: the
/// interrupted one first, so it is rescanned whole.
pub fn walk_directories(
    root: &Path,
    root_real: &Path,
    mut queue: VecDeque<Pending>,
    include_ignored: bool,
    max_entries: usize,
    stop: &dyn Fn() -> bool,
    add: &mut dyn FnMut(String),
) -> Vec<Pending> {
    let mut scanned = 0usize;
    while let Some(current) = queue.pop_front() {
        if scanned >= max_entries || stop() {
            queue.push_front(current);
            break;
        }
        let rules = if include_ignored { Vec::new() } else { nested_rules(root, &current.relative, &current.rules) };
        let Some(entries) = listed_entries(&root.join(&current.relative)) else { continue };
        let children_from = queue.len();
        let mut interrupted = false;
        for (name, kind) in entries {
            if scanned >= max_entries || stop() {
                interrupted = true;
                break;
            }
            scanned += 1;
            let path = join(&current.relative, &name);
            let (mut dir, mut file, mut linked) = (kind.is_dir(), kind.is_file(), false);
            if kind.is_symlink() {
                let target = fs::metadata(root.join(&path)).ok();
                dir = target.as_ref().is_some_and(|m| m.is_dir());
                file = target.as_ref().is_some_and(|m| m.is_file());
                if (dir || file) && !link_allowed(root_real, root, &path, dir, include_ignored) {
                    dir = false;
                    file = false;
                }
                linked = dir;
            }
            if dir {
                if !INDEX_PRUNED.contains(&name.as_str()) && !ignored_path(&path, true, &rules) {
                    add(format!("{path}/"));
                    if !linked {
                        queue.push_back(Pending { relative: path, rules: rules.clone() });
                    }
                }
            } else if file && !ignored_path(&path, false, &rules) {
                add(path);
            }
        }
        if interrupted {
            // The folder is rescanned whole later, which queues its children again.
            queue.truncate(children_from);
            queue.push_front(current);
            break;
        }
    }
    queue.into_iter().collect()
}

/// Every listed path of the project plus the folders the cap left unvisited.
pub fn index_paths(root: &Path, include_ignored: bool, max_entries: usize, stop: &dyn Fn() -> bool) -> (Vec<String>, Vec<Pending>) {
    let mut paths = Vec::new();
    let Ok(root_real) = canonical(root) else { return (paths, Vec::new()) };
    let start = VecDeque::from([Pending { relative: String::new(), rules: Vec::new() }]);
    let pending = walk_directories(root, &root_real, start, include_ignored, max_entries, stop, &mut |p| paths.push(p));
    (paths, pending)
}

/// The paths of the unvisited folders that match `keep`, walked without a cap, and whether the
/// walk finished. A walk `stop` ended early still returns what it found before it stopped (Node's
/// `searchBeyond` answers with the partial walk); nothing is kept after `stop` turns true.
pub fn matches_beyond(
    root: &Path,
    pending: &[Pending],
    include_ignored: bool,
    stop: &dyn Fn() -> bool,
    keep: &dyn Fn(&str) -> bool,
) -> (Vec<String>, bool) {
    let Ok(root_real) = canonical(root) else { return (Vec::new(), false) };
    let mut found = Vec::new();
    let left = walk_directories(root, &root_real, pending.iter().cloned().collect(), include_ignored, usize::MAX, stop, &mut |p| {
        if !stop() && keep(&p) {
            found.push(p);
        }
    });
    let finished = left.is_empty() && !stop();
    (found, finished)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn a_walk_stopped_midway_returns_what_it_found_before_and_is_not_finished() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path()).unwrap();
        for d in ["a", "b", "c"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
            std::fs::write(root.join(d).join("hit.txt"), "").unwrap();
        }
        let pending = [Pending { relative: String::new(), rules: Vec::new() }];
        let (all, finished) = matches_beyond(&root, &pending, false, &|| false, &|p| p.ends_with("hit.txt"));
        assert!((all.len(), finished) == (3, true), "{all:?}");

        // The deadline passes once the first match was kept: the later matches are not.
        let kept = Cell::new(0);
        let (partial, finished) = matches_beyond(&root, &pending, false, &|| kept.get() >= 1, &|p| {
            let hit = p.ends_with("hit.txt");
            if hit {
                kept.set(kept.get() + 1);
            }
            hit
        });
        assert_eq!(partial.len(), 1, "{partial:?}");
        assert!(!finished);
    }

    #[test]
    fn a_text_walk_lists_files_in_the_order_the_filesystem_does() {
        // The harness found `README.md` before `hello.txt` here (a byte sort) where Node's `readdir` gave `hello.txt` first (NTFS order).
        let dir = tempfile::tempdir().unwrap();
        for name in ["README.md", "hello.txt", "Zed.txt", "alpha.txt"] {
            fs::write(dir.path().join(name), "x").unwrap();
        }
        let expected: Vec<String> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(text_files(dir.path(), &|| false), expected);
    }
}