//! `glob`, `find` and `grep` over the file service's walk and text-search
//! streams, which run on the maintenance lane (T §3.3).

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
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
const GLOB_ACCUM_CAP: usize = 50_000;
const FIND_DEFAULT_LIMIT: usize = 25;
const FIND_UNLIMITED_CAP: usize = 1_000;
const GREP_DEFAULT_LIMIT: usize = 250;
const GREP_CONTENT_MATCH_CAP: usize = 300;
const GREP_AUTO_BEFORE: u64 = 8;
const GREP_AUTO_AFTER: u64 = 12;
const GREP_MAX_COLUMNS: usize = 500;

// ---------------------------------------------------------------------------
// shared walk helpers

/// Pulls a recursive walk of `root` into a list; `complete` is false when the
/// deadline passed first.
async fn walk_entries(
    ctx: &ToolContext,
    root: &AbsPath,
    respect_ignore: bool,
    keep: impl Fn(&DirEntry) -> bool,
) -> Result<(Vec<DirEntry>, bool), ToolError> {
    let mut walk = ctx.files.walk(
        ctx.io.maintenance,
        WalkRequest {
            root: root.clone(),
            recursive: true,
            include_hidden: true,
            respect_ignore,
            include_dirs: false,
        },
    );
    let mut out = Vec::new();
    let end = pull_all(ctx, walk.as_mut(), |item| {
        if let Ok(entry) = item {
            if entry.kind != EntryKind::Dir && keep(&entry) {
                out.push(entry);
            }
        }
        out.len() < GLOB_ACCUM_CAP
    })
    .await;
    match end {
        PullEnd::Cancelled => Err(cancelled()),
        PullEnd::Deadline => Ok((out, false)),
        PullEnd::Exhausted => Ok((out, true)),
    }
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
        p = p.trim_start_matches("./").trim_start_matches('/').to_owned();
        if p.ends_with('/') {
            p.push_str("**");
        }
        if !p.contains('/') {
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

async fn mtime_millis(ctx: &ToolContext, path: &AbsPath) -> u128 {
    match ctx.files.stat(ctx.io.interactive, path.clone()).await {
        Ok(s) => s
            .modified
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0),
        Err(_) => 0,
    }
}

/// Files under `root` matching any pattern, with their mtime (ms; 0 unknown).
/// `complete` is false when the walk hit the deadline.
pub(crate) async fn glob_files(
    ctx: &ToolContext,
    root: &AbsPath,
    patterns: &[String],
    include_noise: bool,
) -> Result<(Vec<(AbsPath, u128)>, bool), ToolError> {
    let (inc, exc, any_include) = compile_globs(patterns)?;
    let root_path = root.as_path().to_path_buf();
    let rel = |p: &Path| p.strip_prefix(&root_path).map(fwd).unwrap_or_else(|_| fwd(p));
    let (entries, complete) = walk_entries(ctx, root, !include_noise, |e| {
        if !include_noise && in_noise_dir(e.path.as_path(), &root_path) {
            return false;
        }
        let r = rel(e.path.as_path());
        (!any_include || inc.is_match(&r)) && !exc.is_match(&r)
    })
    .await?;
    let mut out = Vec::with_capacity(entries.len());
    for e in entries {
        if ctx.cancel.is_cancelled() {
            return Err(cancelled());
        }
        let m = mtime_millis(ctx, &e.path).await;
        out.push((e.path, m));
    }
    Ok((out, complete))
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
        let patterns = arg_strings(&args, "pattern");
        let raw = arg_str(&args, "path").unwrap_or(".");
        let natural = arg_str(&args, "sort") == Some("natural");
        let limit = match arg_u64(&args, "limit") {
            Some(0) => usize::MAX,
            Some(n) => n as usize,
            None => GLOB_DEFAULT_LIMIT,
        };
        let offset = arg_u64(&args, "offset").unwrap_or(0) as usize;
        let root = resolve_path(&ctx.cwd, raw)?;
        if let Some(missing) = require_dir(ctx, raw, &root).await? {
            return Ok(text_output(missing));
        }
        let (mut files, complete) =
            glob_files(ctx, &root, &patterns, arg_bool(&args, "include_noise")).await?;
        if natural {
            files.sort_by(|a, b| a.0.cmp(&b.0));
        } else {
            let key = |p: &AbsPath| {
                let s = fwd(p.as_path());
                if cfg!(windows) { s.to_lowercase() } else { s }
            };
            files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| key(&a.0).cmp(&key(&b.0))));
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
            text = if complete { "(no files found)" } else { "(no files found yet)" }.to_owned();
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
        let (entries, complete) = walk_entries(ctx, &root, false, |e| {
            include_noise || !in_noise_dir(e.path.as_path(), &root_path)
        })
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
    ) -> Result<(Vec<Hit>, bool, String, bool), ToolError> {
        let abs = resolve_path(&ctx.cwd, raw)?;
        let stat = match guarded(ctx, "grep", ctx.files.stat(ctx.io.interactive, abs.clone())).await? {
            Ok(s) => s,
            Err(e) if matches!(e.kind, FsErrorKind::NotFound | FsErrorKind::NotADirectory) => {
                let hint = ReadTool::not_found(ctx, raw, &abs).await;
                let hint = hint.trim_start_matches("[path absent] ENOENT: no such file or directory, stat ");
                return Ok((
                    Vec::new(),
                    true,
                    format!("Error: path does not exist: {} (ENOENT) {hint}", fwd(abs.as_path())),
                    false,
                ));
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
        let end = pull_all(ctx, stream.as_mut(), |item| {
            match item {
                Ok(SearchMatch { path, line, text, .. }) => {
                    if mode == Mode::Content && hits.len() >= 200_000 {
                        return false;
                    }
                    hits.push(Hit { path, line, text });
                }
                Err(_) => errors += 1,
            }
            true
        })
        .await;
        let complete = match end {
            PullEnd::Cancelled => return Err(cancelled()),
            PullEnd::Deadline => false,
            PullEnd::Exhausted => true,
        };
        Ok((hits, complete, String::new(), single_file))
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
        let pattern = if patterns.len() == 1 {
            patterns[0].clone()
        } else {
            patterns.iter().map(|p| format!("(?:{p})")).collect::<Vec<_>>().join("|")
        };
        let mode = match arg_str(&args, "mode") {
            Some("files") => Mode::Files,
            Some("count") => Mode::Count,
            _ => Mode::Content,
        };
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
        for raw in &roots {
            let (hits, ok, error, is_file) =
                self.run_one_root(ctx, raw, &args, &pattern, &globs, mode).await?;
            complete &= ok;
            single = is_file && roots.len() == 1;
            if !error.is_empty() {
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
            return Ok(text_output(errors.join("\n")));
        }
        all.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.line.cmp(&b.1.line)));
        all.dedup_by(|a, b| a.0 == b.0 && a.1.line == b.1.line);

        let body = match mode {
            Mode::Files => files_body(&all, offset, limit, complete),
            Mode::Count => count_body(&all, offset, limit, complete),
            Mode::Content => content_body(ctx, &all, offset, limit, before, after, single, complete).await?,
        };
        let mut text = body;
        for e in errors {
            text.push_str(&format!("\n{e}"));
        }
        if !complete {
            text.push_str("\n[warning] search timed out; partial results shown. Narrow path/glob/pattern for a complete result.");
        }
        let _ = (BTreeSet::<u8>::new(), ToolPart::Text(String::new()), ToolOutput::default());
        Ok(text_output(text))
    }
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
    complete: bool,
) -> Result<String, ToolError> {
    if all.is_empty() {
        return Ok(no_matches(complete));
    }
    let total = all.len();
    let window = all.get(offset..).unwrap_or(&[]);
    let hard = limit.min(GREP_CONTENT_MATCH_CAP);
    let page = &window[..window.len().min(hard)];
    let mut out = if before == 0 && after == 0 {
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
