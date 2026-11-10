//! `glob`, `find` and `grep` over the file service's walk and text-search
//! streams, which run on the maintenance lane (T §3.3).

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;
use std::time::Instant;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use globset::Glob;
use globset::GlobBuilder;
use globset::GlobSet;
use globset::GlobSetBuilder;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::DirEntry;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::ReadRange;
use mixdog_core_api::domain::fs::SearchMatch;
use mixdog_core_api::domain::fs::SearchRequest;
use mixdog_core_api::domain::fs::WalkRequest;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;

use super::common::*;
use crate::orch::util::spec_from_def;
use super::read::ReadTool;
use super::read::in_noise_dir;

const GLOB_SPEC: &str = include_str!("specs/glob.json");
const FIND_SPEC: &str = include_str!("specs/find.json");
const GREP_SPEC: &str = include_str!("specs/grep.json");

const GLOB_DEFAULT_LIMIT: usize = 100;
pub(super) const GLOB_ACCUM_CAP: usize = 50_000;
const FIND_DEFAULT_LIMIT: usize = 25;
const FIND_UNLIMITED_CAP: usize = 1_000;
const GREP_DEFAULT_LIMIT: usize = 250;
const GREP_CONTENT_MATCH_CAP: usize = 300;
const GREP_AUTO_BEFORE: u64 = 8;
const GREP_AUTO_AFTER: u64 = 12;
const GREP_MAX_COLUMNS: usize = 500;

// ---------------------------------------------------------------------------
// shared walk helpers

/// Node `rootScanIgnoreGlobs`: a scan rooted at a POSIX filesystem root never enters the
/// kernel-virtual trees mounted there (procfs re-enumerates every pid, `/proc/kcore` reads as a
/// huge file). A scan rooted at or inside one of them, or anywhere else, keeps them.
pub(super) fn root_scan_prunes(root: &AbsPath, posix: bool) -> Vec<AbsPath> {
    if !posix || root.as_path().parent().is_some() {
        return Vec::new();
    }
    ["proc", "sys", "dev"].iter().filter_map(|name| AbsPath::new(root.as_path().join(name))).collect()
}

/// What a walk collected: the kept files, `complete` (false when the deadline passed first) and
/// `capped` (a kept file past the cap existed and was dropped).
pub(super) struct Walked {
    pub entries: Vec<DirEntry>,
    pub complete: bool,
    pub capped: bool,
}

/// Pulls a recursive walk of `root` into a list of at most `cap` kept files.
async fn walk_entries(
    ctx: &ToolContext,
    root: &AbsPath,
    respect_ignore: bool,
    keep: impl Fn(&DirEntry) -> bool,
    cap: Option<usize>,
) -> Result<Walked, ToolError> {
    walk_entries_pruned(ctx, root, respect_ignore, keep, root_scan_prunes(root, cfg!(not(windows))), cap).await
}

pub(super) async fn walk_entries_pruned(
    ctx: &ToolContext,
    root: &AbsPath,
    respect_ignore: bool,
    keep: impl Fn(&DirEntry) -> bool,
    prune: Vec<AbsPath>,
    cap: Option<usize>,
) -> Result<Walked, ToolError> {
    let request = WalkRequest { root: root.clone(), recursive: true, include_hidden: true, respect_ignore, include_dirs: false, prune };
    walk_kept(ctx, request, keep, cap).await
}

/// Files and directories under `root` (nothing ignored or hidden skipped; the kernel trees of a
/// filesystem root pruned), at most `cap` kept entries.
pub(super) async fn walk_inventory(
    ctx: &ToolContext,
    root: &AbsPath,
    keep: impl Fn(&DirEntry) -> bool,
    cap: usize,
) -> Result<Walked, ToolError> {
    let prune = root_scan_prunes(root, cfg!(not(windows)));
    let request = WalkRequest { root: root.clone(), recursive: true, include_hidden: true, respect_ignore: false, include_dirs: true, prune };
    walk_kept(ctx, request, keep, Some(cap)).await
}

async fn walk_kept(
    ctx: &ToolContext,
    request: WalkRequest,
    keep: impl Fn(&DirEntry) -> bool,
    cap: Option<usize>,
) -> Result<Walked, ToolError> {
    let include_dirs = request.include_dirs;
    let mut walk = ctx.files.walk(ctx.io.maintenance, request);
    let mut out = Vec::new();
    let mut capped = false;
    let end = pull_all(ctx, walk.as_mut(), |item| {
        if let Ok(entry) = item {
            if (include_dirs || entry.kind != EntryKind::Dir) && keep(&entry) {
                // Exactly `cap` files is a complete list; the next one is what was cut.
                if cap.is_some_and(|cap| out.len() >= cap) {
                    capped = true;
                    return false;
                }
                out.push(entry);
            }
        }
        true
    })
    .await;
    let complete = match end {
        PullEnd::Cancelled => return Err(cancelled()),
        PullEnd::Deadline => false,
        PullEnd::Exhausted => true,
    };
    Ok(Walked { entries: out, complete, capped })
}

/// Include/exclude sets for gitignore-style globs (`!` excludes).
fn compile_globs(patterns: &[String]) -> Result<(GlobSet, GlobSet, bool), ToolError> {
    let (mut inc, mut exc) = (GlobSetBuilder::new(), GlobSetBuilder::new());
    let mut any_include = false;
    for raw in patterns {
        let (neg, body) = match raw.strip_prefix('!') {
            Some(rest) => (true, rest),
            None => (false, raw.as_str()),
        };
        let mut p = body.trim().replace('\\', "/");
        // A leading `/` anchors the glob at the walk root, as rg reads it.
        let anchored = p.starts_with('/');
        p = p.trim_start_matches("./").trim_start_matches('/').to_owned();
        if p.ends_with('/') {
            p.push_str("**");
        }
        if !anchored && !p.contains('/') {
            p = format!("**/{p}");
        }
        let glob: Glob = GlobBuilder::new(&p)
            .literal_separator(true)
            .build()
            .map_err(|e| invalid("pattern", "glob", format!("Error: invalid glob {raw:?}: {e}")))?;
        if neg {
            exc.add(glob);
        } else {
            inc.add(glob);
            any_include = true;
        }
    }
    let build = |b: GlobSetBuilder| {
        b.build()
            .map_err(|e| invalid("pattern", "glob", format!("Error: invalid glob set: {e}")))
    };
    Ok((build(inc)?, build(exc)?, any_include))
}

/// The mtime in ms (0 when the file service has none); `None` when the stat failed.
async fn mtime_millis(ctx: &ToolContext, path: &AbsPath) -> Option<u128> {
    let stat = ctx.files.stat(ctx.io.interactive, path.clone()).await.ok()?;
    Some(stat.modified.and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis()))
}

/// Files under `root` matching any pattern, in walk order, with their mtime (ms; `None` when the
/// stat failed), at most `cap` of them. `complete` is false when the walk hit the deadline,
/// `capped` true when a match past the cap was dropped.
pub(crate) async fn glob_files(
    ctx: &ToolContext,
    root: &AbsPath,
    patterns: &[String],
    include_noise: bool,
    cap: Option<usize>,
) -> Result<(Vec<(AbsPath, Option<u128>)>, bool, bool), ToolError> {
    let (inc, exc, any_include) = compile_globs(patterns)?;
    let root_path = root.as_path().to_path_buf();
    let rel = |p: &Path| p.strip_prefix(&root_path).map(fwd).unwrap_or_else(|_| fwd(p));
    let walked = walk_entries(ctx, root, !include_noise, |e| {
        if !include_noise && in_noise_dir(e.path.as_path(), &root_path) {
            return false;
        }
        let r = rel(e.path.as_path());
        (!any_include || inc.is_match(&r)) && !exc.is_match(&r)
    }, cap)
    .await?;
    let mut out = Vec::with_capacity(walked.entries.len());
    for e in walked.entries {
        if ctx.cancel.is_cancelled() {
            return Err(cancelled());
        }
        let m = mtime_millis(ctx, &e.path).await;
        out.push((e.path, m));
    }
    Ok((out, walked.complete, walked.capped))
}

async fn require_dir(ctx: &ToolContext, raw: &str, abs: &AbsPath) -> Result<Option<String>, ToolError> {
    match guarded(ctx, "search", ctx.files.stat(ctx.io.interactive, abs.clone())).await? {
        Ok(_) => Ok(None),
        Err(e) if matches!(e.kind, FsErrorKind::NotFound | FsErrorKind::NotADirectory) => {
            let hint = ReadTool::not_found(ctx, raw, abs).await;
            let hint = hint.trim_start_matches("[path absent] ENOENT: no such file or directory, stat ");
            Ok(Some(format!(
                "Error: path does not exist: {} (ENOENT) {hint}",
                fwd(abs.as_path())
            )))
        }
        Err(e) => Err(fs_failure(&e, raw)),
    }
}

/// Node's `isAbsolute` of a glob pattern: on Windows a rooted `/x` counts too.
fn is_absolute_pattern(pattern: &str) -> bool {
    pattern.starts_with('/') || Path::new(pattern).is_absolute()
}

/// Node `isUncOrSmbPath`: a `\\` or `//` spelling, the device namespaces (`//./`, `//?/`) included.
fn is_unc_or_smb(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//")
}

/// Node `globUncRefusal`: the base path (as given, then resolved) and every absolute pattern, before any walk.
fn glob_unc_refusal(ctx: &ToolContext, raw: &str, patterns: &[String]) -> Option<String> {
    let refuse = |shown: &str| {
        format!(
            "Error: glob refuses UNC/SMB path {}; remote share access is blocked to prevent NTLM credential leaks",
            serde_json::to_string(&super::patch_guard::normalize_output_path(shown)).unwrap_or_default()
        )
    };
    if is_unc_or_smb(raw) {
        return Some(refuse(raw));
    }
    if let Ok(resolved) = resolve_path(&ctx.cwd, raw)
        && is_unc_or_smb(&resolved.as_path().to_string_lossy())
    {
        return Some(refuse(&resolved.as_path().to_string_lossy()));
    }
    patterns.iter().find(|p| is_absolute_pattern(p) && is_unc_or_smb(p)).map(|p| refuse(p))
}

/// The byte length of Node's `path.parse(raw).root` (win32 on Windows, posix elsewhere) of a `/`-spelled path:
/// a UNC share keeps its server and share, a device path its namespace, a drive its letter in either case.
pub(super) fn parse_root_len(raw: &str) -> usize {
    let b = raw.as_bytes();
    if !cfg!(windows) {
        return usize::from(b.first() == Some(&b'/'));
    }
    let sep = |i: usize| b.get(i) == Some(&b'/');
    if sep(0) {
        if b.len() == 1 || !sep(1) {
            return 1;
        }
        let mut j = 2;
        let mut last = j;
        while j < b.len() && !sep(j) {
            j += 1;
        }
        if j < b.len() && j != last {
            last = j;
            while j < b.len() && sep(j) {
                j += 1;
            }
            if j < b.len() && j != last {
                last = j;
                while j < b.len() && !sep(j) {
                    j += 1;
                }
                if j == b.len() {
                    return j;
                }
                if j != last {
                    return j + 1;
                }
            }
        }
        return 1;
    }
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return if sep(2) { 3 } else { 2 };
    }
    0
}

const EXPAND_DEADLINE: Duration = Duration::from_millis(1_500);
const EXPAND_CANDIDATE_CAP: usize = 200;

/// Node `segmentMatcher`: one path segment's matcher; `None` for `**` or an unclosed class or brace.
fn segment_matcher(segment: &str) -> Option<regex::Regex> {
    if segment.contains("**") {
        return None;
    }
    let mut source = String::new();
    let mut rest = segment;
    while let Some(ch) = rest.chars().next() {
        rest = &rest[ch.len_utf8()..];
        match ch {
            '*' => source.push_str("[^/]*"),
            '?' => source.push_str("[^/]"),
            '[' => {
                let end = rest.find(']')?;
                let inner: String = rest[..end]
                    .chars()
                    .map(|c| if matches!(c, '\\' | '[' | '&' | '~') { format!("\\{c}") } else { c.to_string() })
                    .collect();
                source.push_str(&format!("[{inner}]"));
                rest = &rest[end + 1..];
            }
            '{' => {
                let end = rest.find('}')?;
                let alternatives: Vec<String> = rest[..end].split(',').map(regex::escape).collect();
                source.push_str(&format!("(?:{})", alternatives.join("|")));
                rest = &rest[end + 1..];
            }
            other => source.push_str(&regex::escape(&other.to_string())),
        }
    }
    let flags = if cfg!(windows) { "(?i)" } else { "" };
    regex::Regex::new(&format!("{flags}^{source}$")).ok()
}

/// Node `expandAbsoluteGlob`: the pattern descended segment by segment (one listing per surviving
/// directory, at most 200 candidates, 1.5 s), its matches that are files or directories; `None`
/// when the pattern is not absolute, has no magic, or uses a construct this does not expand.
async fn expand_absolute_glob(ctx: &ToolContext, pattern: &str, limit: usize) -> Option<Vec<String>> {
    let raw = pattern.replace('\\', "/");
    if !is_absolute_pattern(&raw) || !has_glob_magic(&raw) {
        return None;
    }
    let stop = Instant::now() + EXPAND_DEADLINE;
    let root_len = parse_root_len(&raw);
    if root_len == 0 {
        return None;
    }
    let segments: Vec<&str> = raw[root_len..].split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return None;
    }
    let root = if cfg!(windows) { raw[..root_len].replace('/', "\\") } else { raw[..root_len].to_owned() };
    let mut current = vec![resolve_path(&ctx.cwd, &root).ok()?];
    for segment in segments {
        if Instant::now() >= stop {
            return None;
        }
        if !has_glob_magic(segment) {
            current = current.iter().filter_map(|dir| AbsPath::new(dir.as_path().join(segment))).collect();
            continue;
        }
        let matcher = segment_matcher(segment)?;
        let mut next = Vec::new();
        for dir in &current {
            if next.len() >= EXPAND_CANDIDATE_CAP || Instant::now() >= stop {
                break;
            }
            let Ok(entries) = ctx.files.list_dir(ctx.io.interactive, dir.clone()).await else { continue };
            for entry in entries {
                let Some(name) = entry.path.as_path().file_name() else { continue };
                if !matcher.is_match(&name.to_string_lossy()) {
                    continue;
                }
                next.push(entry.path);
                if next.len() >= EXPAND_CANDIDATE_CAP {
                    break;
                }
            }
        }
        current = next;
        if current.is_empty() {
            return Some(Vec::new());
        }
    }
    let mut found = Vec::new();
    for candidate in current {
        if found.len() >= limit || Instant::now() >= stop {
            break;
        }
        if let Ok(stat) = ctx.files.stat(ctx.io.interactive, candidate.clone()).await
            && matches!(stat.kind, EntryKind::File | EntryKind::Dir)
        {
            found.push(fwd(candidate.as_path()));
        }
    }
    Some(found)
}

/// Node `expandAbsoluteGlobs`: every absolute pattern expanded, deduplicated, in order.
async fn expand_absolute_globs(ctx: &ToolContext, patterns: &[String], limit: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for pattern in patterns {
        if out.len() >= limit {
            break;
        }
        for found in expand_absolute_glob(ctx, pattern, limit).await.unwrap_or_default() {
            if !out.contains(&found) {
                out.push(found);
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// glob

pub struct GlobTool {
    spec: ToolSpec,
}

impl GlobTool {
    pub fn new() -> Self {
        Self {
            spec: spec_from_def(GLOB_SPEC, true, &[]),
        }
    }
}

impl Default for GlobTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for GlobTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        // rg reads `/` only; Node turns a Windows `\` into one (`canonicalizeGlobSlashes`).
        let patterns: Vec<String> = arg_strings(&args, "pattern")
            .into_iter()
            .map(|p| if cfg!(windows) { p.replace('\\', "/") } else { p })
            .collect();
        let raw = arg_str(&args, "path").unwrap_or(".");
        let natural = arg_str(&args, "sort") == Some("natural");
        let limit = match arg_u64(&args, "limit") {
            Some(0) => usize::MAX,
            Some(n) => n as usize,
            None => GLOB_DEFAULT_LIMIT,
        };
        let offset = arg_u64(&args, "offset").unwrap_or(0) as usize;
        if let Some(text) = glob_unc_refusal(ctx, raw, &patterns) {
            return Err(fail(ToolErrorCode::Failed { reason: text.clone() }, text));
        }
        let root = resolve_path(&ctx.cwd, raw)?;
        // Node `buildGlobPatternGroups`: an absolute pattern is walked from its own static prefix,
        // anchored there; the others from `path`.
        let (absolute, relative): (Vec<String>, Vec<String>) =
            patterns.iter().cloned().partition(|p| is_absolute_pattern(p));
        let mut groups: Vec<(AbsPath, Vec<String>)> = Vec::new();
        if !relative.is_empty() || absolute.is_empty() {
            if let Some(missing) = require_dir(ctx, raw, &root).await? {
                return Ok(text_output(missing));
            }
            groups.push((root.clone(), relative));
        }
        for pattern in &absolute {
            let (base, rest) = extract_glob_base_directory(pattern);
            let group_root = match base {
                Some(base) => resolve_path(&ctx.cwd, &base)?,
                None => root.clone(),
            };
            let rest = format!("/{rest}");
            match groups.iter_mut().find(|(r, _)| *r == group_root) {
                Some((_, rels)) if rels.contains(&rest) => {}
                Some((_, rels)) => rels.push(rest),
                None => groups.push((group_root, vec![rest])),
            }
        }
        // A bounded page is ranked over every match, as Node's windowed top-K pass counts them all;
        // an unbounded listing keeps at most GLOB_ACCUM_CAP matches and says so (Node's full rg listing).
        let cap = (limit == usize::MAX).then_some(GLOB_ACCUM_CAP);
        let include_noise = arg_bool(&args, "include_noise");
        let (mut files, mut complete, mut capped) = (Vec::new(), true, false);
        let mut errors = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (group_root, rels) in &groups {
            if let Some(missing) = require_dir(ctx, &fwd(group_root.as_path()), group_root).await? {
                errors.push(missing.trim_start_matches("Error: ").to_owned());
                continue;
            }
            let (found, done, cut) = glob_files(ctx, group_root, rels, include_noise, cap).await?;
            complete &= done;
            capped |= cut;
            files.extend(found.into_iter().filter(|f| seen.insert(f.0.clone())));
        }
        if let Some(cap) = cap.filter(|cap| files.len() > *cap) {
            files.truncate(cap);
            capped = true;
        }
        if files.is_empty() && !errors.is_empty() {
            return Ok(text_output(format!("Error: {}", errors.join(" | "))));
        }
        if natural {
            files.sort_by(|a, b| a.0.cmp(&b.0));
        } else {
            let key = |p: &AbsPath| {
                let s = fwd(p.as_path());
                if cfg!(windows) { s.to_lowercase() } else { s }
            };
            // Newest first; a file whose stat failed cannot be ordered by time and keeps its walk
            // order after the rest (Node's mtime top-K, `serve_search/mtime.rs`).
            let (mut statted, unstatted): (Vec<_>, Vec<_>) = files.into_iter().partition(|f| f.1.is_some());
            statted.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| key(&a.0).cmp(&key(&b.0))));
            statted.extend(unstatted);
            files = statted;
        }
        let total = files.len();
        let windowed = files.get(offset..).unwrap_or(&[]);
        let page = &windowed[..windowed.len().min(limit)];
        let mut lines: Vec<String> =
            page.iter().map(|(p, _)| display_path(p.as_path(), &ctx.cwd)).collect();
        let remaining = windowed.len() - page.len();
        let mut text = lines.join("\n");
        if remaining > 0 {
            text.push_str(&format!(
                "\n{}",
                window_marker(
                    "entries",
                    offset as u64 + 1,
                    (offset + page.len()) as u64,
                    Some(total as u64),
                    Some((offset + page.len()) as u64),
                    None
                )
            ));
        }
        if lines.is_empty() {
            let shown_patterns = if patterns.len() == 1 {
                serde_json::to_string(&patterns[0])
            } else {
                serde_json::to_string(&patterns)
            }
            .unwrap_or_default();
            let base_label = fwd(Path::new(raw));
            if total > 0 && offset >= total {
                text = format!("(no entries after offset={offset}; total={total}) pattern={shown_patterns} path={base_label}");
            } else {
                // The walk never follows a directory link; an absolute pattern that found nothing is
                // expanded straight off the filesystem before the miss is declared (Node `directAbsoluteMatches`).
                if errors.is_empty() {
                    let want = if limit == usize::MAX { 50 } else { offset.saturating_add(limit) };
                    let direct = expand_absolute_globs(ctx, &patterns, want).await;
                    let shown: Vec<String> = direct.into_iter().skip(offset).take(limit).collect();
                    if !shown.is_empty() {
                        return Ok(text_output(shown.join("\n")));
                    }
                }
                let base = match ctx.files.stat(ctx.io.interactive, root.clone()).await {
                    Ok(s) if s.kind == EntryKind::Dir => "path exists (dir)",
                    Ok(_) => "path exists (file)",
                    Err(_) => "path does not exist (ENOENT)",
                };
                let empty = if complete { "(no files found)" } else { "(no files found yet)" };
                text = format!("{empty} pattern={shown_patterns} path={base_label}; {base_label}: {base}");
            }
        }
        if !errors.is_empty() {
            text.push_str(&format!("\n... [warning] {}", errors.join(" | ")));
        }
        if capped {
            text.push_str(&format!(
                "\n{}",
                cap_marker(&format!("{GLOB_ACCUM_CAP} matches"), "results incomplete", None, "narrow the pattern or path")
            ));
        }
        if !complete {
            text.push_str("\n[warning] search timed out; partial results shown. Narrow path/pattern for a complete result.");
        }
        if text.len() > LOCATOR_MAX_BYTES {
            let (kept, dropped) = cap_lines(&text, LOCATOR_MAX_BYTES);
            let shown = lines.len().saturating_sub(dropped);
            lines.clear();
            text = format!(
                "{kept}\n{}",
                cap_marker(
                    &format_cap_size(LOCATOR_MAX_BYTES),
                    &format!("{shown} entries shown"),
                    Some((offset + shown) as u64),
                    ""
                )
            );
        }
        Ok(text_output(text))
    }
}

// ---------------------------------------------------------------------------
// find

pub struct FindTool {
    spec: ToolSpec,
}

impl FindTool {
    pub fn new() -> Self {
        Self {
            spec: spec_from_def(FIND_SPEC, true, &[]),
        }
    }
}

impl Default for FindTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Case-insensitive subsequence score of one fragment against a path; `None`
/// when the fragment is not a subsequence.
fn fuzzy_score(token: &str, path: &str) -> Option<i64> {
    let hay: Vec<char> = path.chars().flat_map(char::to_lowercase).collect();
    let needle: Vec<char> = token.chars().flat_map(char::to_lowercase).collect();
    if needle.is_empty() {
        return Some(0);
    }
    let base_start = hay.iter().rposition(|c| *c == '/').map_or(0, |i| i + 1);
    let mut score = 0i64;
    let mut at = 0usize;
    let mut prev: Option<usize> = None;
    for n in &needle {
        let found = (at..hay.len()).find(|i| hay[*i] == *n)?;
        score += 16;
        if prev.is_some_and(|p| p + 1 == found) {
            score += 8;
        }
        if found == 0 || matches!(hay[found - 1], '/' | '.' | '_' | '-' | ' ') {
            score += 10;
        }
        if found >= base_start {
            score += 2;
        }
        score -= prev.map_or(0, |p| (found - p - 1).min(8) as i64);
        prev = Some(found);
        at = found + 1;
    }
    let hay_str: String = hay.iter().collect();
    let needle_str: String = needle.iter().collect();
    if hay_str[hay_str.char_indices().nth(base_start).map_or(0, |(i, _)| i)..].contains(&needle_str) {
        score += 30;
    }
    Some(score)
}

#[async_trait]
impl Tool for FindTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let query = arg_str(&args, "query").unwrap_or("").trim().to_owned();
        if query.is_empty() {
            return Err(invalid("query", "required", "Error: find requires query."));
        }
        let raw = arg_str(&args, "path").unwrap_or(".");
        let limit = match arg_u64(&args, "limit") {
            Some(0) => FIND_UNLIMITED_CAP,
            Some(n) => n as usize,
            None => FIND_DEFAULT_LIMIT,
        };
        let include_noise = arg_bool(&args, "include_noise");
        let root = resolve_path(&ctx.cwd, raw)?;
        if let Some(missing) = require_dir(ctx, raw, &root).await? {
            return Ok(text_output(missing));
        }
        let root_path = root.as_path().to_path_buf();
        // Every file is scored, as Node's native inventory ranks the whole scope.
        let Walked { entries, complete, .. } = walk_entries(ctx, &root, false, |e| {
            include_noise || !in_noise_dir(e.path.as_path(), &root_path)
        }, None)
        .await?;
        let tokens: Vec<&str> = query.split_whitespace().collect();
        let mut scored: Vec<(i64, String)> = entries
            .iter()
            .filter_map(|e| {
                let rel = display_under(e.path.as_path(), &root_path);
                let mut total = 0;
                for t in &tokens {
                    total += fuzzy_score(t, &rel)?;
                }
                Some((total, rel))
            })
            .collect();
        scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())).then_with(|| a.1.cmp(&b.1)));
        let more = scored.len() > limit;
        scored.truncate(limit);
        let mut lines: Vec<String> = scored.into_iter().map(|(_, p)| p).collect();
        if lines.is_empty() {
            lines.push(format!("(no fuzzy match for \"{query}\")"));
        } else if more {
            lines.push(format!("... (top {limit}; additional matches omitted)"));
        }
        if !complete {
            lines.push("... [search timed out; partial results shown]".to_owned());
        }
        let text = lines.join("\n");
        if text.len() > LOCATOR_MAX_BYTES {
            let (kept, dropped) = cap_lines(&text, LOCATOR_MAX_BYTES);
            let rows = lines.len().saturating_sub(dropped);
            let marker = cap_marker(
                &format_cap_size(LOCATOR_MAX_BYTES),
                &format!("{rows} match row(s) shown for query={query:?}"),
                None,
                "use a more specific query or add path",
            );
            return Ok(text_output(format!("{kept}\n{marker}")));
        }
        Ok(text_output(text))
    }
}

// ---------------------------------------------------------------------------
// grep

pub struct GrepTool {
    spec: ToolSpec,
}

impl GrepTool {
    pub fn new() -> Self {
        Self {
            spec: spec_from_def(GREP_SPEC, true, &[]),
        }
    }
}

impl Default for GrepTool {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Content,
    Files,
    Count,
}

struct Hit {
    path: AbsPath,
    line: u64,
    text: String,
}

fn escape_glob(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '{' | '}' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn clip_match_text(s: &str) -> String {
    if s.chars().count() <= GREP_MAX_COLUMNS {
        return s.to_owned();
    }
    let head: String = s.chars().take(GREP_MAX_COLUMNS).collect();
    format!("{head} [... omitted end of long line]")
}

/// Path prefix for grep results: the search path as given (`./` for the cwd).
fn grep_display_root(raw: &str, root: &AbsPath, cwd: &AbsPath) -> String {
    let given = raw.trim().replace('\\', "/");
    let under_cwd = Path::new(raw.trim()).is_absolute()
        .then(|| root.as_path().strip_prefix(cwd.as_path()).ok().map(fwd))
        .flatten();
    let shown = match under_cwd {
        Some(rel) if rel.is_empty() => ".".to_owned(),
        Some(rel) => rel,
        None => given,
    };
    shown.trim_end_matches('/').trim_start_matches("./").to_owned().replace("", "").pipe_dot()
}

trait PipeDot {
    fn pipe_dot(self) -> String;
}
impl PipeDot for String {
    fn pipe_dot(self) -> String {
        if self.is_empty() { ".".to_owned() } else { self }
    }
}

impl GrepTool {
    async fn run_one_root(
        &self,
        ctx: &ToolContext,
        raw: &str,
        args: &JsonValue,
        pattern: &str,
        globs: &[String],
        mode: Mode,
    ) -> Result<(Vec<Hit>, bool, String, bool, bool), ToolError> {
        let abs = resolve_path(&ctx.cwd, raw)?;
        let stat = match guarded(ctx, "grep", ctx.files.stat(ctx.io.interactive, abs.clone())).await? {
            Ok(s) => s,
            Err(e) if super::not_found::missing_code(&e.kind).is_some() => {
                let code = super::not_found::missing_code(&e.kind).unwrap_or("ENOENT");
                return Ok((Vec::new(), true, super::not_found::grep_missing(ctx, &abs, raw, code).await, false, false));
            }
            Err(e) => return Err(fs_failure(&e, raw)),
        };
        let include_noise = arg_bool(args, "include_noise");
        let single_file = stat.kind == EntryKind::File;
        let (root, mut include_globs) = if single_file {
            let parent = AbsPath::new(abs.as_path().parent().unwrap_or(abs.as_path()).to_path_buf())
                .unwrap_or_else(|| abs.clone());
            let name = abs.as_path().file_name().map(|n| escape_glob(&n.to_string_lossy()));
            (parent, name.into_iter().collect::<Vec<_>>())
        } else {
            (abs.clone(), Vec::new())
        };
        let mut exclude_globs = Vec::new();
        for g in globs {
            match g.strip_prefix('!') {
                Some(neg) => exclude_globs.push(neg.to_owned()),
                None => include_globs.push(g.clone()),
            }
        }
        if !include_noise {
            for n in NOISE_DIRS {
                // A noise directory the caller explicitly searches inside stays visible.
                let inside = abs.as_path().components().any(|c| c.as_os_str() == *n);
                if !inside {
                    exclude_globs.push(format!("**/{n}/**"));
                }
            }
        }
        let mut stream = ctx.files.search_text(
            ctx.io.maintenance,
            SearchRequest {
                root,
                pattern: pattern.to_owned(),
                regex: true,
                case_sensitive: true,
                include_globs,
                exclude_globs,
                include_hidden: true,
                respect_ignore: !include_noise,
            },
        );
        let mut hits = Vec::new();
        let mut errors = 0usize;
        let mut bad_pattern = None;
        let end = pull_all(ctx, stream.as_mut(), |item| {
            match item {
                Ok(SearchMatch { path, line, text, .. }) => {
                    if mode == Mode::Content && hits.len() >= 200_000 {
                        return false;
                    }
                    hits.push(Hit { path, line, text });
                }
                Err(e) => match e.kind {
                    FsErrorKind::InvalidPattern { message } => bad_pattern = Some(message),
                    _ => errors += 1,
                },
            }
            true
        })
        .await;
        let complete = match end {
            PullEnd::Cancelled => return Err(cancelled()),
            PullEnd::Deadline => false,
            PullEnd::Exhausted => true,
        };
        // The parser's own text, as Node relays the search server's refusal.
        if let Some(message) = bad_pattern {
            return Ok((Vec::new(), true, format!("Error: regex parse error: {message}"), single_file, true));
        }
        Ok((hits, complete, String::new(), single_file, false))
    }
}

/// One block of output: a merged window of a file around one or more matches.
struct Block {
    path: String,
    match_line: u64,
    start: u64,
    end: u64,
    rows: Vec<String>,
}

fn render_block(b: &Block) -> String {
    format!("# {}:{} [lines {}-{}]\n{}", b.path, b.match_line, b.start, b.end, b.rows.join("\n"))
}

#[async_trait]
impl Tool for GrepTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let patterns = arg_strings(&args, "pattern");
        if patterns.is_empty() || patterns.iter().all(|p| p.is_empty()) {
            return Err(invalid("pattern", "required", "Error: grep requires pattern."));
        }
        let mode = match arg_str(&args, "mode") {
            Some("files") => Mode::Files,
            Some("count") => Mode::Count,
            _ => Mode::Content,
        };
        // Node `runGrepPatternFanout`: several content patterns are independent greps, one section
        // each; a match line or block an earlier pattern showed is not repeated.
        if patterns.len() > 1 && mode == Mode::Content {
            let mut seen = std::collections::HashSet::new();
            let mut bodies = Vec::with_capacity(patterns.len());
            for pattern in &patterns {
                let body = self.search(ctx, &args, pattern, mode, true).await?;
                bodies.push(dedupe_fanout_match_lines(&body, &mut seen));
            }
            return Ok(text_output(fanout_sections(&patterns, &bodies)));
        }
        let pattern = if patterns.len() == 1 {
            patterns[0].clone()
        } else {
            patterns.iter().map(|p| format!("(?:{p})")).collect::<Vec<_>>().join("|")
        };
        Ok(text_output(self.search(ctx, &args, &pattern, mode, false).await?))
    }
}

impl GrepTool {
    /// One grep of `pattern`, rendered. `fanout`: a section of a several-pattern answer, whose
    /// bare match lines carry their file (Node's combined pass, `disableContentGrouping`).
    async fn search(&self, ctx: &ToolContext, args: &JsonValue, pattern: &str, mode: Mode, fanout: bool) -> Result<String, ToolError> {
        let args = args.clone();
        let limit = match arg_u64(&args, "limit") {
            Some(0) => usize::MAX,
            Some(n) => n as usize,
            None => GREP_DEFAULT_LIMIT,
        };
        let offset = arg_u64(&args, "offset").unwrap_or(0) as usize;
        let (before, after) = match arg_u64(&args, "context") {
            Some(c) => (c.min(200), c.min(200)),
            None if mode == Mode::Content => (GREP_AUTO_BEFORE, GREP_AUTO_AFTER),
            None => (0, 0),
        };
        let mut roots = arg_strings(&args, "path");
        if roots.is_empty() {
            roots.push(".".to_owned());
        }
        let globs = arg_strings(&args, "glob");

        let mut all: Vec<(String, Hit)> = Vec::new();
        let mut complete = true;
        let mut errors: Vec<String> = Vec::new();
        let mut single = false;
        let mut all_bad = true;
        for raw in &roots {
            let (hits, ok, error, is_file, bad) =
                self.run_one_root(ctx, raw, &args, &pattern, &globs, mode).await?;
            complete &= ok;
            single = is_file && roots.len() == 1;
            if !error.is_empty() {
                all_bad &= bad;
                errors.push(error);
                continue;
            }
            let abs = resolve_path(&ctx.cwd, raw)?;
            let prefix = grep_display_root(raw, &abs, &ctx.cwd);
            for h in hits {
                let label = if is_file {
                    display_path(h.path.as_path(), &ctx.cwd)
                } else {
                    format!("{prefix}/{}", display_under(h.path.as_path(), abs.as_path()))
                };
                all.push((label, h));
            }
        }
        if all.is_empty() && !errors.is_empty() {
            // A pattern the parser refused is a failed call, as Node's caller takes it; a missing path is a miss.
            // In a several-pattern answer it fails only its own section.
            if all_bad && !fanout {
                let text = errors.join("\n");
                return Err(fail(ToolErrorCode::Failed { reason: text.clone() }, text));
            }
            return Ok(errors.join("\n"));
        }
        all.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.line.cmp(&b.1.line)));
        all.dedup_by(|a, b| a.0 == b.0 && a.1.line == b.1.line);

        let body = match mode {
            Mode::Files => files_body(&all, offset, limit, complete),
            Mode::Count => count_body(&all, offset, limit, complete),
            Mode::Content => content_body(ctx, &all, offset, limit, before, after, single && !fanout, fanout, complete).await?,
        };
        let mut text = body;
        for e in errors {
            text.push_str(&format!("\n{e}"));
        }
        if !complete {
            text.push_str("\n[warning] search timed out; partial results shown. Narrow path/glob/pattern for a complete result.");
        }
        let _ = (BTreeSet::<u8>::new(), ToolPart::Text(String::new()), ToolOutput::default());
        Ok(text)
    }
}

static CONTEXT_HEADER: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r"^# (.+):(\d+) \[lines (\d+)-(\d+)\]$").expect("a fixed pattern"));
static MATCH_PREFIX: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r":(\d+):|-(\d+)-").expect("a fixed pattern"));

/// Node `splitGrepLinePrefix` of a match line: its path and line number when the first
/// `:N:`/`-N-` marker (past a drive letter) is a match marker.
fn match_line_key(line: &str) -> Option<String> {
    let from = if line.len() >= 2 && line.as_bytes()[0].is_ascii_alphabetic() && line.as_bytes()[1] == b':' { 2 } else { 0 };
    let marker = MATCH_PREFIX.captures(&line[from..])?;
    let end = from + marker.get(0)?.start();
    // Only a `:N:` marker is a match line; `-N-` is a context line.
    let number = marker.get(1)?.as_str().parse::<u64>().ok()?;
    (end > 0).then(|| format!("{}\0{number}", &line[..end]))
}

/// Node `dedupeFanoutMatchLines`: drops a numbered match line or a whole context block (keyed by
/// its header's path and match line) an earlier pattern's section already showed.
fn dedupe_fanout_match_lines(body: &str, seen: &mut std::collections::HashSet<String>) -> String {
    if body.starts_with("Error:") {
        return body.to_owned();
    }
    let lines: Vec<&str> = body.split('\n').collect();
    let mut out = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let header = CONTEXT_HEADER.captures(line).and_then(|c| {
            let n = |k: usize| c.get(k)?.as_str().parse::<u64>().ok();
            let (at, start, end) = (n(2)?, n(3)?, n(4)?);
            (start >= 1 && end >= start && (start..=end).contains(&at)).then(|| (format!("{}\0{at}", &c[1]), end - start + 1))
        });
        if let Some((key, rows)) = header {
            let duplicate = !seen.insert(key);
            if !duplicate {
                out.push(line);
            }
            for _ in 0..rows {
                if i + 1 >= lines.len() {
                    break;
                }
                i += 1;
                if !duplicate {
                    out.push(lines[i]);
                }
            }
            i += 1;
            continue;
        }
        if let Some(key) = match_line_key(line)
            && !seen.insert(key)
        {
            i += 1;
            continue;
        }
        out.push(line);
        i += 1;
    }
    out.join("\n")
}

/// Node `formatGrepFanoutSections` for patterns: `# grep pattern:"x"` sections; the patterns that
/// matched nothing named in one closing `(no matches) patterns=[…]` line (bare when all missed);
/// one missing path answered once.
fn fanout_sections(patterns: &[String], bodies: &[String]) -> String {
    const MISSING: &str = "Error: path does not exist:";
    if bodies.len() > 1 && bodies[0].starts_with(MISSING) && bodies.iter().all(|b| *b == bodies[0]) {
        return bodies[0].clone();
    }
    let mut parts = Vec::new();
    let (mut missed, mut partial_missed) = (Vec::new(), Vec::new());
    let mut i = 0;
    while i < patterns.len() {
        let body = &bodies[i];
        if body.starts_with(MISSING) {
            let mut grouped = vec![patterns[i].clone()];
            while i + 1 < patterns.len() && bodies[i + 1] == *body {
                i += 1;
                grouped.push(patterns[i].clone());
            }
            let label = if grouped.len() > 1 {
                format!("patterns:{}", serde_json::to_string(&grouped).unwrap_or_default())
            } else {
                format!("pattern:{}", serde_json::to_string(&grouped[0]).unwrap_or_default())
            };
            parts.push(format!("# grep {label}\n{body}"));
        } else if *body == no_matches(true) {
            missed.push(patterns[i].clone());
        } else if *body == no_matches(false) {
            partial_missed.push(patterns[i].clone());
        } else if !body.trim().is_empty() {
            parts.push(format!("# grep pattern:{}\n{body}", serde_json::to_string(&patterns[i]).unwrap_or_default()));
        }
        i += 1;
    }
    for (items, complete) in [(missed, true), (partial_missed, false)] {
        if items.is_empty() {
            continue;
        }
        let scope = if items.len() == patterns.len() {
            String::new()
        } else {
            format!(" patterns={}", serde_json::to_string(&items).unwrap_or_default())
        };
        parts.push(format!("{}{scope}", no_matches(complete)));
    }
    parts.join("\n\n")
}

fn paging_notice(shown: usize, total: usize, complete: bool, offset: usize, next: usize) -> String {
    if shown == 0 {
        return if complete {
            format!("[0 of {total} shown; offset:{offset} past end]")
        } else {
            format!("[0 shown, results partial; offset:{offset} beyond streamed window; narrow path/glob/pattern]")
        };
    }
    let count = if complete { format!("{shown} of {total} shown") } else { format!("{shown} shown, more exist") };
    format!("\n[{count}; offset:{next} for the rest]")
}

fn no_matches(complete: bool) -> String {
    format!("(no matches{})", if complete { "" } else { " in partial results" })
}

fn files_body(all: &[(String, Hit)], offset: usize, limit: usize, complete: bool) -> String {
    let files: Vec<&str> = all.iter().map(|(l, _)| l.as_str()).collect::<BTreeSet<_>>().into_iter().collect();
    page_lines(files.iter().map(|s| s.to_string()).collect(), offset, limit, complete, None)
}

fn count_body(all: &[(String, Hit)], offset: usize, limit: usize, complete: bool) -> String {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for (l, _) in all {
        *counts.entry(l.as_str()).or_default() += 1;
    }
    let total_matches: usize = counts.values().sum();
    let summary = format!(
        "\n[total {total_matches} match{} across {} file{}]",
        if total_matches == 1 { "" } else { "es" },
        counts.len(),
        if counts.len() == 1 { "" } else { "s" }
    );
    let lines = counts.iter().map(|(p, n)| format!("{p}:{n}")).collect();
    page_lines(lines, offset, limit, complete, Some(summary))
}

fn page_lines(lines: Vec<String>, offset: usize, limit: usize, complete: bool, summary: Option<String>) -> String {
    if lines.is_empty() {
        return no_matches(complete);
    }
    let total = lines.len();
    let window = lines.get(offset..).unwrap_or(&[]);
    let page = &window[..window.len().min(limit)];
    let mut text = page.join("\n");
    if page.is_empty() || window.len() > page.len() || !complete {
        text.push_str(&paging_notice(page.len(), total, complete, offset, offset + page.len()));
    }
    if let Some(s) = summary {
        text.push_str(&s);
    }
    let _ = BTreeMap::<u8, u8>::new();
    text
}

#[allow(clippy::too_many_arguments)]
async fn content_body(
    ctx: &ToolContext,
    all: &[(String, Hit)],
    offset: usize,
    limit: usize,
    before: u64,
    after: u64,
    single: bool,
    fanout: bool,
    complete: bool,
) -> Result<String, ToolError> {
    if all.is_empty() {
        return Ok(no_matches(complete));
    }
    let total = all.len();
    let window = all.get(offset..).unwrap_or(&[]);
    let hard = limit.min(GREP_CONTENT_MATCH_CAP);
    let page = &window[..window.len().min(hard)];
    let mut out = if before == 0 && after == 0 && fanout {
        page.iter().map(|(label, h)| format!("{label}:{}:{}", h.line, clip_match_text(&h.text))).collect::<Vec<_>>().join("\n")
    } else if before == 0 && after == 0 {
        bare_content(page, single)
    } else {
        context_blocks(ctx, page, before, after).await?
    };
    // Byte budget at a block boundary, continuing by offset.
    let mut shown = page.len();
    if out.len() > GREP_MAX_BYTES {
        let (kept, _) = cap_lines(&out, GREP_MAX_BYTES);
        let kept_matches = kept.lines().filter(|l| l.starts_with("# ") || l.starts_with("  ")).count().max(1);
        shown = if before == 0 && after == 0 { kept_matches.min(page.len()) } else { kept.lines().filter(|l| l.starts_with("# ")).count().max(1).min(page.len()) };
        out = format!(
            "{kept}\n{}",
            cap_marker(&format_cap_size(GREP_MAX_BYTES), &format!("{shown} of {total} matches shown"), Some((offset + shown) as u64), "")
        );
        return Ok(out);
    }
    if shown < window.len() || !complete {
        out.push_str(&paging_notice(shown, total, complete, offset, offset + shown));
    }
    Ok(out)
}

fn bare_content(page: &[(String, Hit)], single: bool) -> String {
    if single {
        return page.iter().map(|(_, h)| format!("{}:{}", h.line, clip_match_text(&h.text))).collect::<Vec<_>>().join("\n");
    }
    let mut groups: Vec<(&str, Vec<&Hit>)> = Vec::new();
    for (label, h) in page {
        match groups.last_mut() {
            Some((l, v)) if *l == label.as_str() => v.push(h),
            _ => groups.push((label.as_str(), vec![h])),
        }
    }
    let mut out = Vec::new();
    for (label, hits) in groups {
        out.push(if hits.len() == 1 { label.to_owned() } else { format!("{label} ({} hits)", hits.len()) });
        for h in hits {
            out.push(format!("  {}: {}", h.line, clip_match_text(&h.text)));
        }
    }
    out.join("\n")
}

async fn context_blocks(
    ctx: &ToolContext,
    page: &[(String, Hit)],
    before: u64,
    after: u64,
) -> Result<String, ToolError> {
    let mut files: BTreeMap<&str, Option<Vec<String>>> = BTreeMap::new();
    let mut blocks: Vec<Block> = Vec::new();
    for (label, hit) in page {
        if !files.contains_key(label.as_str()) {
            let lines = match guarded(
                ctx,
                "grep",
                ctx.files.read(ctx.io.interactive, hit.path.clone(), ReadRange::default()),
            )
            .await?
            {
                Ok(b) => decode_text(&b.bytes).ok().map(|(t, _)| {
                    let mut v: Vec<String> =
                        t.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_owned()).collect();
                    if v.last().is_some_and(String::is_empty) {
                        v.pop();
                    }
                    v
                }),
                Err(_) => None,
            };
            files.insert(label.as_str(), lines);
        }
        let Some(Some(lines)) = files.get(label.as_str()) else {
            // Unreadable as text: the match line alone.
            blocks.push(Block {
                path: label.clone(),
                match_line: hit.line,
                start: hit.line,
                end: hit.line,
                rows: vec![clip_match_text(&hit.text)],
            });
            continue;
        };
        let total = lines.len() as u64;
        let start = hit.line.saturating_sub(before).max(1);
        let end = (hit.line + after).min(total.max(hit.line));
        let rows_for = |s: u64, e: u64| -> Vec<String> {
            (s..=e).map(|n| clip_match_text(lines.get(n as usize - 1).map_or("", String::as_str))).collect()
        };
        match blocks.last_mut() {
            Some(prev) if prev.path == *label && start <= prev.end + 1 => {
                if end > prev.end {
                    prev.rows.extend(rows_for(prev.end + 1, end));
                    prev.end = end;
                }
            }
            _ => blocks.push(Block {
                path: label.clone(),
                match_line: hit.line,
                start,
                end,
                rows: rows_for(start, end),
            }),
        }
    }
    Ok(blocks.iter().map(render_block).collect::<Vec<_>>().join("\n"))
}

#[allow(dead_code)]
fn _unused(_: ToolError, _: ToolErrorCode) {}
