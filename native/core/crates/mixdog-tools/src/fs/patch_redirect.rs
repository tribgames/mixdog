//! Patch target redirection, Node's `read-redirects.mjs`: a header path that no longer exists is
//! re-pointed at the unique relocated file, so a patch written against a moved file still lands on
//! it. A hallucinated absolute prefix is peeled first (`findBySuffixStrip`), then the file's
//! basename is looked for under the patch root (`findFileByBasename`, one hit only).

use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;

use super::common::*;
use super::patch_hunk::Kind;
use super::patch_hunk::Section;

/// How long the basename scan may run (`BASENAME_SCAN_DEADLINE_MS`); hits found by then still count.
const BASENAME_SCAN_DEADLINE: Duration = Duration::from_millis(750);
/// Directories the scan reads at most (`maxDirs`).
const BASENAME_SCAN_MAX_DIRS: usize = 6000;
/// Segments peeled off a requested path at most (`findBySuffixStrip`'s `maxIterations`).
const SUFFIX_STRIP_MAX: usize = 12;
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "coverage", ".next", ".nuxt", ".turbo", ".cache", "vendor", "target",
    ".venv", "venv", "__pycache__", ".idea", ".vscode",
];

fn key(path: &Path) -> String {
    mixdog_scm::locks::path_key(path)
}

/// `path.relative(base, full)` when `full` lies inside `base` (the root itself gives an empty path).
pub(super) fn relative_inside(base: &Path, full: &Path) -> Option<PathBuf> {
    let (mut b, mut f) = (base.components(), full.components());
    loop {
        match (b.next(), f.next()) {
            (None, rest) => return Some(rest.into_iter().chain(f).collect()),
            (Some(x), Some(y)) if key(Path::new(x.as_os_str())) == key(Path::new(y.as_os_str())) => {}
            _ => return None,
        }
    }
}

/// Node `patchHeaderPathForResolved`: the header spelling of a resolved path.
fn header_path(base: &Path, full: &Path) -> String {
    match relative_inside(base, full) {
        Some(rel) if !rel.as_os_str().is_empty() => fwd(&rel),
        _ => full.to_string_lossy().into_owned(),
    }
}

async fn is_file(ctx: &ToolContext, path: &Path) -> Option<AbsPath> {
    let abs = AbsPath::new(path.to_path_buf())?;
    let stat = ctx.files.stat(ctx.io.interactive, abs.clone()).await.ok()?;
    (stat.kind == EntryKind::File).then_some(abs)
}

/// `findBySuffixStrip`: peels leading segments off the requested path and stats the tail under the
/// root; a tail of fewer than two segments never counts.
async fn suffix_strip(ctx: &ToolContext, base: &AbsPath, requested: &Path) -> Option<PathBuf> {
    let text = fwd(requested);
    let segments: Vec<&str> = text
        .split('/')
        .filter(|s| !s.is_empty() && *s != "." && *s != ".." && !(s.len() == 2 && s.as_bytes()[0].is_ascii_alphabetic() && s.as_bytes()[1] == b':'))
        .collect();
    let iterations = segments.len().saturating_sub(1).min(SUFFIX_STRIP_MAX);
    for i in 0..iterations {
        let tail = &segments[i..];
        if tail.len() < 2 {
            break;
        }
        let candidate = tail.iter().fold(base.as_path().to_path_buf(), |acc, part| acc.join(part));
        let abs = AbsPath::new(candidate.clone())?;
        if let Ok(stat) = ctx.files.stat(ctx.io.interactive, abs).await {
            if matches!(stat.kind, EntryKind::File | EntryKind::Dir) {
                return Some(tail.iter().collect());
            }
        }
    }
    None
}

/// `findFileByBasename` with `limit: 2`: a breadth-first scan, shallow hits first, of at most
/// 6000 directories within 750 ms, skipping hidden and vendor directories. What was found when
/// it stops still counts.
async fn basename_hits(ctx: &ToolContext, base: &AbsPath, requested: &Path) -> Result<Vec<PathBuf>, ToolError> {
    let Some(target) = requested.file_name().map(|n| n.to_string_lossy().to_lowercase()) else { return Ok(Vec::new()) };
    let stop = std::time::Instant::now() + BASENAME_SCAN_DEADLINE;
    let mut queue = std::collections::VecDeque::from([base.clone()]);
    let mut hits: Vec<PathBuf> = Vec::new();
    let mut scanned = 0usize;
    while hits.len() < 2 && scanned < BASENAME_SCAN_MAX_DIRS {
        let Some(dir) = queue.pop_front() else { break };
        if ctx.cancel.is_cancelled() {
            return Err(cancelled());
        }
        if std::time::Instant::now() >= stop {
            break;
        }
        scanned += 1;
        let Ok(entries) = ctx.files.list_dir(ctx.io.interactive, dir).await else { continue };
        for entry in entries {
            let path = entry.path.as_path();
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            match entry.kind {
                EntryKind::Dir => {
                    if !(name.starts_with('.') || SKIP_DIRS.contains(&name.as_str())) {
                        queue.push_back(entry.path.clone());
                    }
                }
                EntryKind::File if name.to_lowercase() == target && path != requested => {
                    hits.push(path.to_path_buf());
                    if hits.len() >= 2 {
                        break;
                    }
                }
                _ => {}
            }
        }
    }
    Ok(hits)
}
/// `uniqueExistingPatchTarget`: the one existing file the missing `requested` path most likely
/// meant. Only a path inside the patch root is ever relocated.
async fn unique_existing_target(ctx: &ToolContext, base: &AbsPath, requested: &AbsPath) -> Result<Option<AbsPath>, ToolError> {
    if relative_inside(base.as_path(), requested.as_path()).is_none() {
        return Ok(None);
    }
    if let Some(rel) = suffix_strip(ctx, base, requested.as_path()).await {
        if let Some(found) = is_file(ctx, &base.as_path().join(rel)).await {
            return Ok(Some(found));
        }
    }
    let hits = basename_hits(ctx, base, requested.as_path()).await?;
    match hits.as_slice() {
        [only] => Ok(is_file(ctx, only).await),
        _ => Ok(None),
    }
}

/// The header spelling of the one relocated twin of `requested` when that path is missing and has
/// exactly one candidate; `None` when it exists or no twin is found.
pub(super) async fn relocated_header(ctx: &ToolContext, base: &AbsPath, requested: &AbsPath) -> Result<Option<String>, ToolError> {
    if ctx.files.stat(ctx.io.interactive, requested.clone()).await.is_ok() {
        return Ok(None);
    }
    let Some(found) = unique_existing_target(ctx, base, requested).await? else { return Ok(None) };
    Ok((key(found.as_path()) != key(requested.as_path())).then(|| header_path(base.as_path(), found.as_path())))
}

/// Node `rewriteV4AReadRedirects`: every non-Add section whose file is missing and has one
/// relocated twin is rewritten to the twin's path.
pub(super) async fn redirect_sections(ctx: &ToolContext, base: &AbsPath, sections: Vec<Section>) -> Result<Vec<Section>, ToolError> {
    let mut out = Vec::with_capacity(sections.len());
    for mut section in sections {
        if section.kind != Kind::Add && !section.path.is_empty() {
            let requested = resolve_path(base, &section.path)?;
            if let Some(header) = relocated_header(ctx, base, &requested).await? {
                section.path = header;
            }
        }
        out.push(section);
    }
    Ok(out)
}