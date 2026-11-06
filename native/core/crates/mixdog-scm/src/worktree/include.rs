//! `.worktreeinclude` (optional, at the repository root): untracked local files a fresh managed
//! worktree starts with. One entry per line, `#` comments:
//!
//! ```text
//! copy <relpath>   copy the file or directory into the worktree
//! link <relpath>   link it (directory junction on Windows, symlink elsewhere)
//! <pattern>        a .gitignore-style pattern: every untracked path it matches that the
//!                  repository also git-ignores is copied. Explicit copy/link entries win.
//! ```
//!
//! No entry is ever a creation failure: a line whose path breaks the rules below (or a pattern
//! git cannot use) is skipped with `include-invalid:<line>`, and an entry or match that resolves
//! somewhere it must not (outside the repository, into `.git`, a Unity `Library` or project
//! link, through a link in the worktree) is skipped with `include-skipped:<path>`. Relative
//! paths only (no absolute, `..`, `.git` or `:`); an existing path in the checkout is never
//! overwritten. A link that cannot be made fails the creation clearly: it never degrades into a
//! (possibly huge) copy.
//!
//! The blocking file work here runs on the maintenance lane; git is asked through the engine.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;

use mixdog_protocol::DomainErrorDetail;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::git::RunOptions;
use crate::git::nul_records;
use crate::repo::hex;
use crate::repo::on_lane;
use crate::worktree::errors::WORKTREE_UNSUPPORTED_REPO;
use crate::worktree::manager::Worktrees;
use crate::worktree::measure::covered_by;
use crate::worktree::registry::WorktreeRecord;

pub const INCLUDE_FILE: &str = ".worktreeinclude";
const MAX_DIGEST_ENTRIES: usize = 100_000;
const MAX_PATTERN_MATCHES: usize = 2_000;
const CHECK_IGNORE_BATCH: usize = 200;
const UNITY_MARKER: &str = "ProjectSettings/ProjectVersion.txt";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IncludeEntry {
    Copy { rel: String, line: usize },
    Link { rel: String, line: usize },
    /// `pattern: None` is unusable (a NUL), warned.
    Pattern { pattern: Option<String>, line: usize },
    /// A copy/link line whose path breaks the rules: never followed, never a failure.
    Invalid { line: usize },
}

fn invalid(line: usize, reason: &str) -> ScmFailure {
    ScmFailure::coded(
        WORKTREE_UNSUPPORTED_REPO,
        DomainErrorDetail::WorktreeUnsupportedRepo {
            project_path: None,
            file: Some(INCLUDE_FILE.into()),
            line: Some(line as u64),
            rel: None,
            base_branch: None,
            branch: Some(reason.to_owned()),
        },
    )
}

fn key(rel: &str) -> String {
    if cfg!(windows) { rel.to_lowercase() } else { rel.to_owned() }
}

/// Normalized forward-slash relative path.
pub fn validate_include_path(value: &str, line: usize) -> Result<String, ScmFailure> {
    let text = value.trim();
    if text.is_empty() {
        return Err(invalid(line, "a path is required"));
    }
    if text.contains('\0') {
        return Err(invalid(line, "the path contains a NUL byte"));
    }
    let drive = text.len() >= 2 && text.as_bytes()[0].is_ascii_alphabetic() && text.as_bytes()[1] == b':';
    if Path::new(text).is_absolute() || drive || text.starts_with(['/', '\\']) {
        return Err(invalid(line, "absolute paths are not allowed"));
    }
    let parts: Vec<&str> = text.split(['/', '\\']).filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.is_empty() {
        return Err(invalid(line, "the path names the repository root"));
    }
    if parts.contains(&"..") {
        return Err(invalid(line, "\"..\" is not allowed"));
    }
    if parts.iter().any(|p| p.eq_ignore_ascii_case(".git")) {
        return Err(invalid(line, "\".git\" is not allowed"));
    }
    if parts.iter().any(|p| p.contains(':')) {
        return Err(invalid(line, "\":\" is not allowed"));
    }
    Ok(parts.join("/"))
}

/// Parses the include file text. Overlapping explicit entries are refused.
pub fn parse_include_entries(text: &str) -> Result<Vec<IncludeEntry>, ScmFailure> {
    let mut entries = Vec::new();
    for (index, raw) in text.lines().enumerate() {
        let line = raw.trim_start_matches('\u{feff}').trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let number = index + 1;
        let explicit = line
            .strip_prefix("copy")
            .map(|rest| (true, rest))
            .or_else(|| line.strip_prefix("link").map(|rest| (false, rest)))
            .filter(|(_, rest)| rest.starts_with(char::is_whitespace) && !rest.trim().is_empty());
        let Some((is_copy, rest)) = explicit else {
            entries.push(IncludeEntry::Pattern {
                pattern: (!line.contains('\0')).then(|| line.to_owned()),
                line: number,
            });
            continue;
        };
        match validate_include_path(rest, number) {
            Ok(rel) if is_copy => entries.push(IncludeEntry::Copy { rel, line: number }),
            Ok(rel) => entries.push(IncludeEntry::Link { rel, line: number }),
            Err(_) => entries.push(IncludeEntry::Invalid { line: number }),
        }
    }
    let explicit: Vec<(&String, usize)> = entries
        .iter()
        .filter_map(|e| match e {
            IncludeEntry::Copy { rel, line } | IncludeEntry::Link { rel, line } => Some((rel, *line)),
            _ => None,
        })
        .collect();
    for (rel, line) in &explicit {
        for (other, other_line) in &explicit {
            if line == other_line {
                continue;
            }
            let (a, b) = (key(rel), key(other));
            if a == b || b.starts_with(&format!("{a}/")) {
                return Err(invalid(*other_line, &format!("\"{other}\" overlaps \"{rel}\" (line {line})")));
            }
        }
    }
    Ok(entries)
}

/// One resolved include: where it comes from and what it costs.
#[derive(Clone, Debug)]
pub struct PlannedItem {
    pub link: bool,
    pub rel: String,
    pub source: PathBuf,
    pub directory: bool,
    pub bytes: u64,
}

#[derive(Clone, Debug, Default)]
pub struct IncludePlan {
    pub items: Vec<PlannedItem>,
    pub copy_bytes: u64,
    pub warnings: Vec<String>,
}

/// The ledger of one made resource, kept on the record so a rollback knows what this
/// transaction produced.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncludeItem {
    pub mode: String,
    pub rel: String,
    pub path: String,
    /// `pending` before the resource is made, `created` after.
    pub status: String,
    #[serde(default)]
    pub digest: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub link_type: Option<String>,
    #[serde(default)]
    pub dependency: bool,
}

fn is_unity_project(dir: &Path) -> bool {
    dir.join(UNITY_MARKER).is_file()
}

fn inside_unity_library(root: &Path, parts: &[&str]) -> bool {
    (0..parts.len()).any(|i| {
        parts[i].eq_ignore_ascii_case("library") && is_unity_project(&parts[..i].iter().fold(root.to_path_buf(), |p, s| p.join(s)))
    })
}

fn is_unity_library_dir(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("library"))
        && path.parent().is_some_and(is_unity_project)
}

fn tree_bytes(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if meta.file_type().is_symlink() {
        return 0;
    }
    if !meta.is_dir() {
        return meta.len();
    }
    if is_unity_library_dir(path) {
        return 0;
    }
    std::fs::read_dir(path)
        .map(|entries| entries.flatten().map(|e| tree_bytes(&e.path())).sum())
        .unwrap_or(0)
}

fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => path,
    }
}

fn plan_entry(root: &Path, rel: &str, link: bool, line: usize, items: &mut Vec<PlannedItem>, warnings: &mut Vec<String>) -> Result<u64, ScmFailure> {
    let source = rel.split('/').fold(root.to_path_buf(), |p, s| p.join(s));
    if std::fs::symlink_metadata(&source).is_err() {
        warnings.push(format!("include-missing:{rel}"));
        return Ok(0);
    }
    let real = strip_verbatim(std::fs::canonicalize(&source)?);
    if !real.starts_with(root) || real == root {
        return Err(invalid(line, &format!("\"{rel}\" resolves outside the repository")));
    }
    let rel_real = real.strip_prefix(root).unwrap_or(&real).to_string_lossy().replace('\\', "/");
    let real_parts: Vec<&str> = rel_real.split('/').collect();
    if real_parts.iter().any(|p| p.eq_ignore_ascii_case(".git")) {
        return Err(invalid(line, &format!("\"{rel}\" resolves into .git")));
    }
    let given: Vec<&str> = rel.split('/').collect();
    if inside_unity_library(root, &given) || inside_unity_library(root, &real_parts) {
        return Err(invalid(line, &format!("\"{rel}\" is a Unity Library folder, which is never copied or linked")));
    }
    let meta = std::fs::metadata(&real)?;
    if link && meta.is_dir() && is_unity_project(&real) {
        return Err(invalid(line, &format!("\"{rel}\" is a Unity project; linking it would share its Library folder")));
    }
    let bytes = if link { 0 } else { tree_bytes(&real) };
    items.push(PlannedItem { link, rel: rel.to_owned(), source: real, directory: meta.is_dir(), bytes });
    Ok(bytes)
}

fn digest_type(meta: &std::fs::Metadata) -> char {
    if meta.file_type().is_symlink() { 'l' } else if meta.is_dir() { 'd' } else { 'f' }
}

/// Digest of a copied tree (relative path, type, size, mtime). `None` when the tree is gone or
/// too large to fingerprint.
fn tree_digest(path: &Path) -> Option<String> {
    let mut hash = Sha256::new();
    let mut count = 0usize;
    fn walk(current: &Path, rel: &str, hash: &mut Sha256, count: &mut usize) -> Option<()> {
        let meta = std::fs::symlink_metadata(current).ok()?;
        *count += 1;
        if *count > MAX_DIGEST_ENTRIES {
            return None;
        }
        let kind = digest_type(&meta);
        let (size, mtime) = if kind == 'f' {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis());
            (meta.len(), mtime)
        } else {
            (0, 0)
        };
        hash.update(format!("{rel}\0{kind}\0{size}\0{mtime}\n").as_bytes());
        if kind != 'd' {
            return Some(());
        }
        let mut names: Vec<String> = std::fs::read_dir(current).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        for name in names {
            let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            walk(&current.join(&name), &child, hash, count)?;
        }
        Some(())
    }
    walk(path, "", &mut hash, &mut count)?;
    Some(hex(&hash.finalize()))
}

fn assert_plain_parents(worktree: &Path, dest: &Path) -> Result<(), ()> {
    let Ok(relative) = dest.parent().unwrap_or(dest).strip_prefix(worktree) else {
        return Ok(());
    };
    let mut current = worktree.to_path_buf();
    for part in relative.components() {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Err(_) => return Ok(()),
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => return Err(()),
            Ok(_) => {}
        }
    }
    Ok(())
}

fn make_link(kind: &str, source: &Path, dest: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        match kind {
            "file" => std::os::windows::fs::symlink_file(source, dest),
            "hard" => std::fs::hard_link(source, dest),
            _ => junction(source, dest),
        }
    }
    #[cfg(unix)]
    {
        let _ = kind;
        std::os::unix::fs::symlink(source, dest)
    }
}

#[cfg(windows)]
fn junction(source: &Path, dest: &Path) -> std::io::Result<()> {
    let out = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(dest)
        .arg(source)
        .output()?;
    if out.status.success() { Ok(()) } else { Err(std::io::Error::other(String::from_utf8_lossy(&out.stdout).into_owned())) }
}

/// Makes one link of the item's kind; the kind made is returned. A link that cannot be made
/// fails clearly: it is never replaced by a copy.
fn link_item(item: &PlannedItem, dest: &Path) -> Result<&'static str, ScmFailure> {
    let attempts: &[&str] = if item.directory {
        &["directory"]
    } else if cfg!(windows) {
        &["file", "hard"]
    } else {
        &["file"]
    };
    let mut failures = Vec::new();
    for kind in attempts {
        match make_link(kind, &item.source, dest) {
            Ok(()) => return Ok(kind),
            Err(error) => failures.push(error.raw_os_error().map_or_else(|| error.to_string(), |c| c.to_string())),
        }
    }
    Err(ScmFailure::coded(
        WORKTREE_UNSUPPORTED_REPO,
        DomainErrorDetail::WorktreeUnsupportedRepo {
            project_path: None,
            file: Some(INCLUDE_FILE.into()),
            line: None,
            rel: Some(item.rel.clone()),
            base_branch: None,
            branch: Some(format!("could not link {} ({})", item.rel, failures.join(", "))),
        },
    ))
}

fn copy_tree(source: &Path, dest: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(source)?;
    if meta.is_dir() {
        if is_unity_library_dir(source) {
            return Ok(());
        }
        std::fs::create_dir(dest)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_tree(&entry.path(), &dest.join(entry.file_name()))?;
        }
        Ok(())
    } else if meta.file_type().is_symlink() {
        let target = std::fs::read_link(source)?;
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, dest)
        }
        #[cfg(windows)]
        {
            if source.is_dir() { std::os::windows::fs::symlink_dir(target, dest) } else { std::os::windows::fs::symlink_file(target, dest) }
        }
    } else {
        if dest.exists() {
            return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
        }
        std::fs::copy(source, dest).map(drop)
    }
}

/// Copies/links every planned item into `worktree`. `record` is told `pending` before each
/// resource is made and `created` after.
pub fn apply_includes(
    plan: &IncludePlan,
    worktree: &Path,
    record: &mut dyn FnMut(&IncludeItem) -> Result<(), ScmFailure>,
) -> Result<Vec<String>, ScmFailure> {
    let mut warnings = Vec::new();
    for item in &plan.items {
        let dest = item.rel.split('/').fold(worktree.to_path_buf(), |p, s| p.join(s));
        if std::fs::symlink_metadata(&dest).is_ok() {
            warnings.push(format!("include-exists:{}", item.rel));
            continue;
        }
        if assert_plain_parents(worktree, &dest).is_err() {
            warnings.push(format!("include-skipped:{}", item.rel));
            continue;
        }
        let mut ledger = IncludeItem {
            mode: if item.link { "link" } else { "copy" }.into(),
            rel: item.rel.clone(),
            path: dest.to_string_lossy().into_owned(),
            status: "pending".into(),
            digest: None,
            source: item.link.then(|| item.source.to_string_lossy().into_owned()),
            link_type: None,
            dependency: false,
        };
        record(&ledger)?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if item.link {
            ledger.link_type = Some(link_item(item, &dest)?.to_owned());
        } else {
            copy_tree(&item.source, &dest)?;
        }
        ledger.status = "created".into();
        if !item.link {
            ledger.digest = tree_digest(&dest);
        }
        record(&ledger)?;
    }
    Ok(warnings)
}

/// Removes the links this worktree made, never traversing their targets. Copies stay (they
/// live inside the checkout and go with it). Returns the links that could not be removed.
pub fn remove_include_links(items: &[IncludeItem]) -> Vec<String> {
    let mut remaining = Vec::new();
    for item in items.iter().filter(|i| i.mode == "link") {
        let path = Path::new(&item.path);
        let Ok(meta) = std::fs::symlink_metadata(path) else { continue };
        // A hard-linked file is a regular file: unlinking it drops only this name.
        if !meta.file_type().is_symlink() && !meta.is_file() && !is_junction(&meta) {
            continue;
        }
        let removed = std::fs::remove_file(path).or_else(|_| std::fs::remove_dir(path));
        if removed.is_err() {
            remaining.push(item.path.clone());
        }
    }
    remaining
}

#[cfg(windows)]
pub(crate) fn is_junction(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
pub(crate) fn is_junction(_: &std::fs::Metadata) -> bool {
    false
}

/// Puts back the links `remove_include_links` took away after a removal that did not go
/// through. A path that exists again is left alone; an earlier version's dependency link is
/// never put back.
pub fn restore_include_links(items: &[IncludeItem]) -> Vec<(String, String)> {
    let mut failures = Vec::new();
    for item in items {
        if item.mode != "link" || item.status != "created" || item.dependency {
            continue;
        }
        let Some(source) = &item.source else { continue };
        let path = Path::new(&item.path);
        if std::fs::symlink_metadata(path).is_ok() {
            continue;
        }
        if let Err(error) = make_link(item.link_type.as_deref().unwrap_or("directory"), Path::new(source), path) {
            failures.push((item.path.clone(), error.to_string()));
        }
    }
    failures
}

/// Copied include paths whose content changed since creation (or are unknown).
pub fn modified_include_copies(items: &[IncludeItem]) -> Vec<String> {
    items
        .iter()
        .filter(|item| item.mode == "copy" && std::fs::symlink_metadata(&item.path).is_ok())
        .filter(|item| item.status != "created" || item.digest.is_none() || tree_digest(Path::new(&item.path)) != item.digest)
        .map(|item| item.rel.clone())
        .collect()
}

/// The include items of a record's ledger.
pub fn ledger_of(record: &WorktreeRecord) -> Vec<IncludeItem> {
    record
        .extra
        .get("resources")
        .and_then(|r| r.get("includes"))
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default()
}

impl Worktrees {
    /// Applies the plan into `worktree`, persisting the record's ledger before and after every
    /// resource. Returns the apply warnings; the record carries the final ledger.
    pub(crate) async fn apply_includes_recorded(
        &self,
        record: &mut WorktreeRecord,
        plan: &IncludePlan,
        worktree: &Path,
        cancel: &CancellationToken,
    ) -> Result<Vec<String>, ScmFailure> {
        let registry = self.registry().clone();
        let mut working = record.clone();
        let plan = plan.clone();
        let worktree = worktree.to_path_buf();
        let (warnings, ledger, outcome) = on_lane(self.scm().lane, cancel, move || {
            let mut ledger: Vec<IncludeItem> = Vec::new();
            let outcome = apply_includes(&plan, &worktree, &mut |item| {
                match ledger.iter_mut().find(|known| known.rel == item.rel) {
                    Some(known) => *known = item.clone(),
                    None => ledger.push(item.clone()),
                }
                let mut resources = working.extra.get("resources").cloned().unwrap_or_else(|| serde_json::json!({}));
                resources["includes"] = serde_json::to_value(&ledger).unwrap_or(serde_json::Value::Null);
                working.extra.insert("resources".into(), resources);
                registry.put(working.clone())
            });
            match outcome {
                Ok(warnings) => (warnings, ledger, Ok(())),
                Err(failure) => (Vec::new(), ledger, Err(failure)),
            }
        })
        .await?;
        let mut resources = record.extra.get("resources").cloned().unwrap_or_else(|| serde_json::json!({}));
        resources["includes"] = serde_json::to_value(&ledger).unwrap_or(serde_json::Value::Null);
        record.extra.insert("resources".into(), resources);
        outcome?;
        Ok(warnings)
    }

    /// Lists a link Mixdog made in `entry_id`'s checkout (a dependency preparation, a snapshot's
    /// shared folder) on its record, so its removal unlinks it instead of refusing as an
    /// unrecorded link. Written before the link is made (`pending`), then `created` once it
    /// exists, as the include creation does. Works for every kind of worktree.
    pub async fn record_link(&self, entry_id: &str, rel: &str, source: &Path, status: &str, cancel: &CancellationToken) -> Result<IncludeItem, ScmFailure> {
        let record = self.record(cancel, entry_id).await?.ok_or_else(|| crate::worktree::errors::missing(Some(entry_id.to_owned()), None, None))?;
        let opened = self.scm().open(&crate::worktree::housekeeping::repo_cwd(&record), cancel).await?;
        let _lock = opened.lock_repository().await?;
        let mut current = self.record(cancel, entry_id).await?.ok_or_else(|| crate::worktree::errors::missing(Some(entry_id.to_owned()), None, None))?;
        let path = rel.split('/').filter(|part| !part.is_empty()).fold(PathBuf::from(&current.path), |p, part| p.join(part));
        let inside = mixdog_workspace::pathguard::is_within(Path::new(&current.path), &path)
            && !rel.split('/').any(|part| part == ".." || part == ".git" || part.contains(':'));
        if rel.is_empty() || !inside {
            return Err(crate::worktree::errors::path_unsafe(current.id.clone(), path.to_string_lossy().into_owned(), Some("outside-worktree")));
        }
        let item = IncludeItem {
            mode: "link".into(),
            rel: rel.to_owned(),
            path: path.to_string_lossy().into_owned(),
            status: status.to_owned(),
            digest: None,
            source: Some(source.to_string_lossy().into_owned()),
            link_type: Some("directory".into()),
            dependency: false,
        };
        let mut ledger = ledger_of(&current);
        match ledger.iter_mut().find(|known| known.path == item.path) {
            Some(known) => *known = item.clone(),
            None => ledger.push(item.clone()),
        }
        let mut resources = current.extra.get("resources").cloned().filter(serde_json::Value::is_object).unwrap_or_else(|| serde_json::json!({}));
        resources["includes"] = serde_json::to_value(&ledger).unwrap_or(serde_json::Value::Null);
        current.extra.insert("resources".into(), resources);
        self.put_record(cancel, current).await?;
        Ok(item)
    }

    /// Undoes a failed creation: the links it made, the checkout, the branch it created, the
    /// record. Best effort: what cannot be undone stays for the cleanup to retry.
    pub(crate) async fn rollback_creation(&self, record: &WorktreeRecord, repo_root: &Path, cancel: &CancellationToken) {
        let items = ledger_of(record);
        let _ = on_lane(self.scm().lane, cancel, move || remove_include_links(&items)).await;
        let git = &self.scm().git;
        let _ = git
            .outcome(cancel, repo_root, &["worktree", "unlock", &record.path], &RunOptions::default())
            .await;
        let _ = git
            .outcome(cancel, repo_root, &["worktree", "remove", "--force", &record.path], &RunOptions::default())
            .await;
        let _ = git.outcome(cancel, repo_root, &["worktree", "prune"], &RunOptions::default()).await;
        let created_branch = record.extra.get("existingBranch") != Some(&serde_json::Value::Bool(true));
        if let (Some(branch), true) = (&record.branch, created_branch) {
            let _ = git.outcome(cancel, repo_root, &["branch", "-D", "--", branch], &RunOptions::default()).await;
        }
        let id = record.id.clone();
        let registry = self.registry().clone();
        let _ = on_lane(self.scm().lane, cancel, move || registry.delete(&id)).await;
    }

    pub(crate) fn include_roots(&self, record: &WorktreeRecord) -> Vec<String> {
        ledger_of(record).into_iter().map(|i| i.rel).collect()
    }

    pub(crate) async fn modified_include_copies(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<Vec<String>, ScmFailure> {
        let items = ledger_of(record);
        if items.is_empty() {
            return Ok(Vec::new());
        }
        Ok(on_lane(self.scm().lane, cancel, move || modified_include_copies(&items)).await?)
    }

    /// The local env files of the main checkout a new worktree starts with, with nothing to
    /// configure: every untracked `.env` or `.env.*` regular file, git-ignored or not, at the
    /// root or nested (never inside `node_modules`). A git failure means none.
    pub async fn untracked_env_files(&self, root: &Path, cancel: &CancellationToken) -> Result<Vec<String>, ScmFailure> {
        let out = self
            .scm()
            .git
            .outcome(
                cancel,
                root,
                &[
                    "-c", "core.quotePath=false", "ls-files", "-z", "--others", "--",
                    ":(glob)**/.env", ":(glob)**/.env.*", ":(exclude,glob)**/node_modules/**",
                ],
                &RunOptions::read(),
            )
            .await?;
        if !out.success() {
            return Ok(Vec::new());
        }
        let listed: Vec<String> = nul_records(&out.stdout_text()).map(str::to_owned).collect();
        let base = root.to_path_buf();
        Ok(on_lane(self.scm().lane, cancel, move || {
            listed
                .into_iter()
                .filter(|rel| {
                    std::fs::symlink_metadata(rel.split('/').fold(base.clone(), |p, s| p.join(s))).is_ok_and(|m| m.is_file())
                })
                .collect()
        })
        .await?)
    }

    /// `paths` minus those a `!` pattern explicitly excludes, by gitignore order.
    async fn without_negated(&self, root: &Path, paths: Vec<String>, patterns: &[String], warnings: &mut Vec<String>, cancel: &CancellationToken) -> Result<Vec<String>, ScmFailure> {
        if paths.is_empty() || !patterns.iter().any(|p| p.starts_with('!')) {
            return Ok(paths);
        }
        let excludes: Vec<String> = patterns.iter().map(|p| format!("--exclude={p}")).collect();
        let literals: Vec<String> = paths.iter().map(|rel| format!(":(literal){rel}")).collect();
        let mut args = vec!["-c", "core.quotePath=false", "ls-files", "-z", "--others", "--ignored", "--exclude=*", "--exclude=!*/"];
        args.extend(excludes.iter().map(String::as_str));
        args.push("--");
        args.extend(literals.iter().map(String::as_str));
        let out = self.scm().git.outcome(cancel, root, &args, &RunOptions::read()).await?;
        if !out.success() {
            warnings.push("include-invalid:patterns".into());
            return Ok(Vec::new());
        }
        let selected: HashSet<String> = nul_records(&out.stdout_text()).map(str::to_owned).collect();
        Ok(paths.into_iter().filter(|rel| selected.contains(rel)).collect())
    }

    /// Untracked paths that match `patterns` (gitignore syntax, in order, so `!` negates) AND
    /// that the repository itself git-ignores; a fully matched directory is one entry.
    async fn ignored_pattern_matches(&self, root: &Path, patterns: &[String], warnings: &mut Vec<String>, cancel: &CancellationToken) -> Result<Vec<String>, ScmFailure> {
        let excludes: Vec<String> = patterns.iter().map(|p| format!("--exclude={p}")).collect();
        let git = &self.scm().git;
        let list = |extra: Vec<String>| {
            let excludes = excludes.clone();
            async move {
                let mut args: Vec<&str> = vec!["ls-files", "-z", "--others", "--ignored"];
                let head: Vec<String> = extra.iter().take_while(|a| *a != "--").cloned().collect();
                args.extend(head.iter().map(String::as_str));
                args.extend(excludes.iter().map(String::as_str));
                let tail: Vec<String> = extra.iter().skip_while(|a| *a != "--").cloned().collect();
                args.extend(tail.iter().map(String::as_str));
                let out = git.outcome(cancel, root, &args, &RunOptions::read()).await?;
                if !out.success() {
                    return Ok::<_, ScmFailure>(None);
                }
                Ok(Some(nul_records(&out.stdout_text()).map(str::to_owned).collect::<Vec<String>>()))
            }
        };
        let repo_ignored = |paths: Vec<String>| async move {
            let mut ignored = HashSet::new();
            for batch in paths.chunks(CHECK_IGNORE_BATCH) {
                let mut args = vec!["-c", "core.quotePath=false", "check-ignore", "--"];
                args.extend(batch.iter().map(String::as_str));
                let out = git.outcome(cancel, root, &args, &RunOptions::read()).await?;
                if out.code.is_none_or(|c| c > 1) {
                    return Ok::<_, ScmFailure>(None);
                }
                ignored.extend(out.stdout_text().lines().filter(|l| !l.is_empty()).map(str::to_owned));
            }
            Ok(Some(ignored))
        };
        let mut selected: Vec<String> = Vec::new();
        let Some(candidates) = list(vec!["--directory".into(), "--no-empty-directory".into()]).await? else {
            warnings.push("include-invalid:patterns".into());
            return Ok(Vec::new());
        };
        let Some(ignored) = repo_ignored(candidates.clone()).await? else {
            warnings.push("include-invalid:patterns".into());
            return Ok(Vec::new());
        };
        for path in candidates {
            if ignored.contains(&path) {
                selected.push(path);
                continue;
            }
            if !path.ends_with('/') {
                continue;
            }
            let Some(files) = list(vec!["--".into(), path.clone()]).await? else {
                warnings.push("include-invalid:patterns".into());
                return Ok(Vec::new());
            };
            let Some(inside) = repo_ignored(files.clone()).await? else {
                warnings.push("include-invalid:patterns".into());
                return Ok(Vec::new());
            };
            selected.extend(files.into_iter().filter(|f| inside.contains(f)));
            if selected.len() > MAX_PATTERN_MATCHES {
                break;
            }
        }
        if selected.len() > MAX_PATTERN_MATCHES {
            // A partial copy would be worse than none.
            warnings.push(format!("include-truncated:{}", selected.len()));
            return Ok(Vec::new());
        }
        Ok(selected.into_iter().map(|p| p.trim_end_matches(['/', '\\']).to_owned()).collect())
    }

    /// Resolves and validates every entry against the repository before anything is allocated.
    /// A missing source is skipped with a warning; `env_files` are copied like pattern matches.
    pub async fn plan_includes(
        &self,
        root: &Path,
        entries: &[IncludeEntry],
        env_files: Vec<String>,
        cancel: &CancellationToken,
    ) -> Result<IncludePlan, ScmFailure> {
        let root_real = strip_verbatim(std::fs::canonicalize(root)?);
        let mut warnings = Vec::new();
        let mut patterns: Vec<String> = Vec::new();
        let mut planned: Vec<(String, bool, usize, bool)> = Vec::new();
        for entry in entries {
            match entry {
                IncludeEntry::Copy { rel, line } => planned.push((rel.clone(), false, *line, false)),
                IncludeEntry::Link { rel, line } => planned.push((rel.clone(), true, *line, false)),
                IncludeEntry::Pattern { pattern: Some(p), .. } => patterns.push(p.clone()),
                IncludeEntry::Pattern { line, .. } | IncludeEntry::Invalid { line } => warnings.push(format!("include-invalid:{line}")),
            }
        }
        let explicit: Vec<String> = planned.iter().map(|(rel, ..)| key(rel)).collect();
        let matched = if patterns.is_empty() {
            Vec::new()
        } else {
            self.ignored_pattern_matches(&root_real, &patterns, &mut warnings, cancel).await?
        };
        let overlaps = |a: &str, b: &str| a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"));
        let kept = self.without_negated(&root_real, env_files, &patterns, &mut warnings, cancel).await?;
        let env: Vec<String> = kept
            .into_iter()
            .filter(|rel| !matched.iter().any(|m| overlaps(&key(rel), &key(m))))
            .collect();
        for path in matched.into_iter().chain(env) {
            match validate_include_path(&path, 0) {
                Ok(rel) if !explicit.iter().any(|e| overlaps(&key(&rel), e)) => planned.push((rel, false, 0, true)),
                Ok(_) => {}
                Err(_) => warnings.push(format!("include-skipped:{path}")),
            }
        }
        let lane = self.scm().lane;
        let base = root_real.clone();
        let (items, copy_bytes, extra) = on_lane(lane, cancel, move || {
            let (mut items, mut warnings, mut total) = (Vec::new(), Vec::new(), 0u64);
            for (rel, link, line, pattern) in planned {
                match plan_entry(&base, &rel, link, line, &mut items, &mut warnings) {
                    Ok(bytes) => total += bytes,
                    // A rule-breaking entry is skipped, never a failure; an I/O failure of an
                    // explicit entry still is one.
                    Err(failure) if pattern || failure.code() == Some(WORKTREE_UNSUPPORTED_REPO) => {
                        warnings.push(format!("include-skipped:{rel}"));
                    }
                    Err(failure) => return Err(failure),
                }
            }
            Ok((items, total, warnings))
        })
        .await??;
        warnings.extend(extra);
        Ok(IncludePlan { items, copy_bytes, warnings })
    }
}

/// Whether `path` (forward-slash, relative) is one of the include items or inside one.
pub fn covered_by_includes(roots: &[String], path: &str) -> bool {
    let target = key(path.replace('\\', "/").trim_end_matches('/'));
    roots.iter().any(|root| covered_by(&key(root), &target))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn include_lines_are_parsed_and_unsafe_paths_are_invalid_not_fatal() {
        let entries = parse_include_entries(
            "# comment\ncopy .env.local\nlink data/cache\ncopy ../outside\nbuild/**\n",
        )
        .unwrap();
        assert_eq!(entries[0], IncludeEntry::Copy { rel: ".env.local".into(), line: 2 });
        assert_eq!(entries[1], IncludeEntry::Link { rel: "data/cache".into(), line: 3 });
        assert_eq!(entries[2], IncludeEntry::Invalid { line: 4 });
        assert_eq!(entries[3], IncludeEntry::Pattern { pattern: Some("build/**".into()), line: 5 });
        assert!(parse_include_entries("copy a\ncopy a/b\n").is_err());
        for bad in ["/abs", "C:\\x", "a/../b", ".git/config", "a:b", ""] {
            assert!(validate_include_path(bad, 1).is_err(), "{bad}");
        }
    }

    #[test]
    fn copies_are_digested_and_a_changed_copy_is_reported() {
        let source = tempfile::tempdir().unwrap();
        let tree = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("f.txt"), "one").unwrap();
        let plan = IncludePlan {
            items: vec![PlannedItem { link: false, rel: "f.txt".into(), source: source.path().join("f.txt"), directory: false, bytes: 3 }],
            copy_bytes: 3,
            warnings: Vec::new(),
        };
        let mut ledger = Vec::new();
        apply_includes(&plan, tree.path(), &mut |item| {
            ledger.push(item.clone());
            Ok(())
        })
        .unwrap();
        let made: Vec<IncludeItem> = vec![ledger.last().unwrap().clone()];
        assert_eq!(made[0].status, "created");
        assert!(modified_include_copies(&made).is_empty());
        std::fs::write(tree.path().join("f.txt"), "changed!").unwrap();
        assert_eq!(modified_include_copies(&made), ["f.txt"]);
        // An existing path is never overwritten.
        let mut again = Vec::new();
        let warnings = apply_includes(&plan, tree.path(), &mut |i| { again.push(i.clone()); Ok(()) }).unwrap();
        assert_eq!(warnings, ["include-exists:f.txt"]);
    }

    #[test]
    fn coverage_follows_the_ledger_roots() {
        assert!(covered_by_includes(&[".env".into(), "cache".into()], "cache/x/y"));
        assert!(!covered_by_includes(&["cache".into()], "cache2"));
    }
}
