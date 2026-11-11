//! Node's recovery hints for a missing `list` / `grep` path (`search-path-diagnostics.mjs`
//! `buildNotFoundHint`, `finalizeReadFamilyEnoentTail`; `path-diagnostics.mjs` basename scans).

use std::collections::VecDeque;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::tool::ToolContext;

use super::patch_guard::normalize_output_path;
use super::read_paths;

const FIND_NUDGE: &str = "Locate with find on the basename before retrying.";
const ABSENT: &str =
    " Nothing same-named elsewhere in the project scan — treat the path as absent (create it if the task requires).";
const MULTI_PATH: &str = " To pass several paths, send an array (path[]), not a comma- or space-joined string.";
/// `BASENAME_SCAN_DEADLINE_MS`: a scan that runs out of time is inconclusive, not an absence.
const SCAN_DEADLINE: Duration = Duration::from_millis(750);
const SCAN_MAX_DIRS: usize = 6000;
const SCAN_SKIP_DIRS: [&str; 19] = [
    "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "coverage", ".next", ".nuxt", ".turbo", ".cache",
    "vendor", "target", ".venv", "venv", "__pycache__", ".idea", ".vscode",
];

/// The error code Node's stat reports for a missing path, when it is one.
pub(crate) fn missing_code(kind: &FsErrorKind) -> Option<&'static str> {
    match kind {
        FsErrorKind::NotFound => Some("ENOENT"),
        FsErrorKind::NotADirectory => Some("ENOTDIR"),
        _ => None,
    }
}

/// `readFamilyPathEnoentOrError` for a missing walk root: `[path absent] <stat message><hints>`.
pub(crate) async fn list_absent(ctx: &ToolContext, missing: &AbsPath, input: &str, code: &str) -> String {
    let what = if code == "ENOTDIR" { "not a directory" } else { "no such file or directory" };
    let message = format!("{code}: {what}, stat '{}'", missing.as_path().to_string_lossy());
    let hint = with_cwd_note(ctx, hint_body(ctx, missing, "List").await);
    format!("[path absent] {}{}", read_paths::normalize_error_message(&message, None), finalize_tail(hint, input))
}

/// `grepMissingPathResult`: `Error: path does not exist: <path> (<code>)<hints>`.
pub(crate) async fn grep_missing(ctx: &ToolContext, missing: &AbsPath, input: &str, code: &str) -> String {
    let mut hint = hint_body(ctx, missing, "Search").await;
    if hint.is_empty() {
        hint = suggest_indexed(ctx, missing).await;
    }
    let hint = with_cwd_note(ctx, hint);
    format!(
        "Error: path does not exist: {} ({code}){}",
        normalize_output_path(&missing.as_path().to_string_lossy()),
        finalize_tail(hint, input)
    )
}

/// `_suggestIndexedPaths`: when the scans concluded nothing, the first five rows of a `**/<basename>` glob (six
/// asked), its empty-result and `... [` lines dropped; nothing for an outside path or a basename with glob magic.
async fn suggest_indexed(ctx: &ToolContext, missing: &AbsPath) -> String {
    if outside_project(&ctx.cwd, missing) {
        return String::new();
    }
    let text = missing.as_path().to_string_lossy().replace('\\', "/");
    let base = text.rsplit('/').next().unwrap_or_default();
    if base.is_empty() || base.contains(['*', '?', '[', ']', '{', '}']) {
        return String::new();
    }
    let args = serde_json::json!({ "pattern": format!("**/{base}"), "limit": 6 });
    let Ok(output) = <super::search::GlobTool as mixdog_core_api::domain::tool::Tool>::call(&super::search::GlobTool::new(), ctx, args).await
    else {
        return String::new();
    };
    static NO_RESULT: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"^\(no (?:files found|entries\b)").expect("a fixed pattern"));
    let rows: String = output.parts.iter().filter_map(|p| if let mixdog_core_api::domain::tool::ToolPart::Text(t) = p { Some(t.as_str()) } else { None }).collect();
    let hits: Vec<&str> = rows
        .split('\n')
        .filter(|s| !s.is_empty() && !NO_RESULT.is_match(s) && !s.starts_with("... ["))
        .map(mixdog_js::js_trim)
        .filter(|s| !s.is_empty())
        .take(5)
        .collect();
    if hits.is_empty() {
        return String::new();
    }
    format!("\n[path not found here; same-named indexed file(s): {}]", hits.join(", "))
}

/// `appendNotFoundCwdNote`.
fn with_cwd_note(ctx: &ToolContext, hint: String) -> String {
    format!("{hint} (relative paths resolve from {})", normalize_output_path(&ctx.cwd.as_path().to_string_lossy()))
}

/// `finalizeReadFamilyEnoentTail`: the array hint for a joined-looking path, else the find nudge
/// unless the hint already concludes.
fn finalize_tail(hint: String, requested: &str) -> String {
    let trimmed = mixdog_js::js_trim(requested);
    let separator = |c: char| c == ',' || mixdog_js::is_js_space(c);
    if trimmed.contains(separator) && trimmed.split(separator).filter(|s| !s.is_empty()).count() >= 2 {
        return hint + MULTI_PATH;
    }
    if hint.contains(FIND_NUDGE) || hint.contains(ABSENT) {
        return hint;
    }
    let sep = if hint.is_empty() || hint.ends_with(char::is_whitespace) { "" } else { " " };
    format!("{hint}{sep}{FIND_NUDGE}")
}

/// A directory's entries in the order Node lists them; `None` when it cannot be read.
async fn listing(ctx: &ToolContext, dir: &AbsPath) -> Option<Vec<(String, EntryKind, AbsPath)>> {
    let entries = ctx.files.list_dir(ctx.io.interactive, dir.clone()).await.ok()?;
    let mut named: Vec<(String, EntryKind, AbsPath)> = entries
        .into_iter()
        .filter_map(|e| Some((e.path.as_path().file_name()?.to_string_lossy().into_owned(), e.kind, e.path)))
        .collect();
    named.sort_by_cached_key(|(name, ..)| read_paths::dir_order_key(name));
    Some(named)
}

/// `listSiblings`: the first `limit` entries not starting with a dot.
async fn siblings(ctx: &ToolContext, dir: &AbsPath, limit: usize) -> Vec<String> {
    listing(ctx, dir)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(name, ..)| name)
        .filter(|name| !name.starts_with('.'))
        .take(limit)
        .collect()
}

async fn is_dir(ctx: &ToolContext, path: &AbsPath) -> bool {
    ctx.files.stat(ctx.io.interactive, path.clone()).await.is_ok_and(|s| s.kind == EntryKind::Dir)
}

fn key(path: &AbsPath) -> String {
    let text = path.as_path().to_string_lossy().replace('\\', "/");
    if cfg!(windows) { text.to_lowercase() } else { text }
}

/// `path.relative(root, path)` of a path inside `root`, with forward slashes.
fn rel_under(root: &AbsPath, path: &AbsPath) -> String {
    path.as_path().strip_prefix(root.as_path()).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default()
}

struct Scan {
    hits: Vec<String>,
    exhaustive: bool,
}

/// `findFileByBasename` (`dirs` false) / `findDirectoryByBasename` (`dirs` true): a breadth-first
/// walk of the working directory for entries named like `missing` (any case), skipping dotted and
/// build directories. `exhaustive` when the walk covered the whole tree within its caps.
async fn scan_by_basename(ctx: &ToolContext, missing: &AbsPath, limit: usize, dirs: bool) -> Scan {
    let target = missing.as_path().file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if target.is_empty() {
        return Scan { hits: Vec::new(), exhaustive: false };
    }
    let root = ctx.cwd.clone();
    let stop = Instant::now() + SCAN_DEADLINE;
    let (mut queue, mut hits, mut scanned, mut expired) = (VecDeque::from([root.clone()]), Vec::new(), 0, false);
    while !queue.is_empty() && hits.len() < limit && scanned < SCAN_MAX_DIRS {
        if Instant::now() >= stop {
            expired = true;
            break;
        }
        let Some(dir) = queue.pop_front() else { break };
        scanned += 1;
        let Some(entries) = listing(ctx, &dir).await else { continue };
        for (name, kind, path) in entries {
            let skipped = name.starts_with('.') || SCAN_SKIP_DIRS.contains(&name.as_str());
            if dirs {
                if kind != EntryKind::Dir {
                    continue;
                }
                if name.to_lowercase() == target {
                    let rel = rel_under(&root, &path);
                    if !rel.is_empty() && !rel.starts_with("..") {
                        hits.push(rel);
                        if hits.len() >= limit {
                            break;
                        }
                    }
                }
                if !skipped {
                    queue.push_back(path);
                }
            } else if kind == EntryKind::Dir {
                if !skipped {
                    queue.push_back(path);
                }
            } else if kind == EntryKind::File && name.to_lowercase() == target && path != *missing {
                hits.push(rel_under(&root, &path));
                if hits.len() >= limit {
                    break;
                }
            }
        }
    }
    Scan { exhaustive: queue.is_empty() && !expired, hits }
}

/// `missingPathIsOutsideProject` for an absolute missing path.
fn outside_project(cwd: &AbsPath, missing: &AbsPath) -> bool {
    let (cwd, missing) = (key(cwd), key(missing));
    let cwd = cwd.trim_end_matches('/');
    !missing.starts_with(&format!("{cwd}/"))
}

/// `outsideProjectNotFoundHint`: what the nearest existing directory holds.
async fn outside_hint(ctx: &ToolContext, missing: &AbsPath, verb: &str) -> String {
    let mut dir = missing.as_path().parent().and_then(|p| AbsPath::new(p.to_path_buf()));
    let mut parent = None;
    for _ in 0..24 {
        let Some(candidate) = dir else { break };
        if is_dir(ctx, &candidate).await {
            parent = Some(candidate);
            break;
        }
        dir = candidate.as_path().parent().and_then(|p| AbsPath::new(p.to_path_buf()));
    }
    let Some(parent) = parent else {
        return " Not found, and no parent directory of it exists either.".to_owned();
    };
    let entries: Vec<String> = siblings(ctx, &parent, 12).await.into_iter().take(5).collect();
    let place = format!("\"{}\"", normalize_output_path(&parent.as_path().to_string_lossy()));
    if entries.is_empty() {
        return format!(" Not found; {place} exists but is empty — nothing under it to {}.", verb.to_lowercase());
    }
    let magic = if missing.as_path().to_string_lossy().contains(['*', '?', '[', ']', '{', '}']) {
        " The path carries a glob pattern; name one of those entries directly."
    } else {
        ""
    };
    format!(" Not found; the nearest existing directory {place} holds: {}.{magic}", quoted(&entries))
}

/// `nearestExistingParentRel`: the missing path's own segments joined under the working directory,
/// longest first; `.` when none is a directory there.
async fn nearest_parent_rel(ctx: &ToolContext, missing: &AbsPath) -> Option<String> {
    let text = missing.as_path().to_string_lossy().replace('\\', "/");
    let segments: Vec<&str> = text
        .split('/')
        .filter(|s| !s.is_empty() && *s != "." && *s != ".." && !(s.len() == 2 && s.ends_with(':') && s.as_bytes()[0].is_ascii_alphabetic()))
        .collect();
    for i in (1..segments.len()).rev() {
        let candidate = segments[..i].iter().fold(ctx.cwd.as_path().to_path_buf(), |path, s| path.join(s));
        if let Some(candidate) = AbsPath::new(candidate)
            && is_dir(ctx, &candidate).await
        {
            return Some(segments[..i].join("/"));
        }
    }
    is_dir(ctx, &ctx.cwd).await.then(|| ".".to_owned())
}

fn quoted(items: &[String]) -> String {
    items.iter().map(|i| format!("\"{}\"", normalize_output_path(i))).collect::<Vec<_>>().join(", ")
}

/// `buildNotFoundHintBody` for an absolute missing path (`verb`: "List" or "Search").
async fn hint_body(ctx: &ToolContext, missing: &AbsPath, verb: &str) -> String {
    if outside_project(&ctx.cwd, missing) {
        return outside_hint(ctx, missing, verb).await;
    }
    let elsewhere = scan_by_basename(ctx, missing, 3, false).await;
    if !elsewhere.hits.is_empty() {
        return format!(" Not found at this path; the same filename exists at: {}. {verb} that path directly.", quoted(&elsewhere.hits));
    }
    // `isDirectoryPathGuess`: a last segment with no glob magic and no extension names a directory.
    let base = missing.as_path().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    static EXTENSION: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"\.[a-zA-Z0-9]{1,12}$").expect("a fixed pattern"));
    let directory_guess = !base.is_empty() && !base.contains(['*', '?', '[', ']', '{', '}']) && !EXTENSION.is_match(&base);
    if !directory_guess {
        return if elsewhere.exhaustive { ABSENT.to_owned() } else { String::new() };
    }
    let dir_hits = scan_by_basename(ctx, missing, 5, true).await;
    if dir_hits.hits.len() > 1 {
        return format!(" Not found at this path; same-named directories exist at: {}. {verb} one of those paths directly.", quoted(&dir_hits.hits));
    }
    if dir_hits.hits.len() == 1 {
        return format!(" Not found at this path; the same directory name exists at: {}. {verb} that path directly.", quoted(&dir_hits.hits));
    }
    let absent = if elsewhere.exhaustive && dir_hits.exhaustive { ABSENT } else { "" };
    if let Some(parent_rel) = nearest_parent_rel(ctx, missing).await {
        let parent = if parent_rel == "." { Some(ctx.cwd.clone()) } else { AbsPath::new(ctx.cwd.as_path().join(&parent_rel)) };
        static NOISE: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\.(log|log\.\d+|tmp|bak)$").expect("a fixed pattern"));
        let names: Vec<String> = match parent {
            Some(parent) => siblings(ctx, &parent, 12).await.into_iter().filter(|n| !NOISE.is_match(n)).take(3).collect(),
            None => Vec::new(),
        };
        if !names.is_empty() {
            return format!(" Not found; under \"{}\" try: {}.{absent}", normalize_output_path(&parent_rel), quoted(&names));
        }
    }
    absent.to_owned()
}
