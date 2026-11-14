//! `list`: a directory's entries (one level, or `depth` levels), paged, optional metadata columns (T §3.2).

use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::Descent;
use mixdog_core_api::domain::fs::DirEntry;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::FileStat;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::ReadRange;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;

use super::common::*;
use super::not_found::list_absent;
use super::not_found::missing_code;
use crate::orch::util::spec_from_def;

const LIST_SPEC: &str = include_str!("specs/list.json");
const DEFAULT_PAGE: u64 = 100;
const ABSOLUTE_CAP: usize = 50_000;
const LINE_COUNT_MAX_BYTES: u64 = 2 * 1024 * 1024;

pub struct ListTool {
    spec: ToolSpec,
}

impl ListTool {
    pub fn new() -> Self {
        Self {
            spec: spec_from_def(LIST_SPEC, true, &[]),
        }
    }
}

impl Default for ListTool {
    fn default() -> Self {
        Self::new()
    }
}

struct Row {
    name: String,
    kind: EntryKind,
    path: AbsPath,
    /// The row's `lstat`, read for a sort by size or time (and then reused by the `meta` columns).
    stat: Option<FileStat>,
}

fn type_name(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::File => "file",
        EntryKind::Dir => "dir",
        EntryKind::Symlink => "symlink",
        EntryKind::Special => "other",
    }
}

/// `LIST_WALK_TIMEOUT_MS`: how long a walk of the folder may run before the listing is cut and says so.
const WALK_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(20_000);

/// A listing's rows (named by their path under the listed folder), whether a cap cut it (`truncatedByCap`) and the
/// `[warning]` lines of the folders that could not be read.
struct Rows {
    rows: Vec<Row>,
    /// The entries the walk visited, before the type filter (`entriesVisited`).
    visited: usize,
    truncated: bool,
    warnings: Vec<String>,
}

/// JS `parseInt(value, 10)` of whatever it is given: it reads the text of the value (a number's, an array's elements joined)
/// up to its first character that is no digit; no digits is `NaN`, here `None`.
fn js_parse_int(value: &JsonValue) -> Option<i64> {
    match value {
        // A number's text is in exponent form past 21 digits and below 1e-6, where its first digit stands alone.
        JsonValue::Number(n) => n.as_f64().filter(|f| *f == 0.0 || (1e-6..1e21).contains(&f.abs())).map(|f| f.trunc() as i64),
        JsonValue::String(s) => {
            let text = s.trim_start();
            let (sign, digits) = match text.strip_prefix('-') {
                Some(rest) => (-1, rest),
                None => (1, text.strip_prefix('+').unwrap_or(text)),
            };
            let end = digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len());
            (end > 0).then(|| sign * digits[..end].parse::<i64>().unwrap_or(i64::MAX))
        }
        JsonValue::Array(items) => items.first().and_then(js_parse_int),
        _ => None,
    }
}

/// `Math.min(Math.max(parseInt(args.depth ?? fallback, 10) || fallback, 1), cap)`: no digits, or 0, is the fallback.
fn clamped_depth(args: &JsonValue, fallback: i64, cap: i64) -> usize {
    args.get("depth").and_then(js_parse_int).filter(|n| *n != 0).unwrap_or(fallback).clamp(1, cap) as usize
}

/// `NOISE_DIR_NAMES` as `walkDir` excludes them: a Windows name matches in any case.
fn is_noise(name: &str) -> bool {
    if cfg!(windows) {
        NOISE_DIRS.iter().any(|noise| noise.eq_ignore_ascii_case(name))
    } else {
        NOISE_DIRS.contains(&name)
    }
}

/// The entries `walkDir` visits in a folder: no dotted name unless `hidden`, no noise directory unless `include_noise`.
fn visible(entries: Vec<DirEntry>, hidden: bool, include_noise: bool) -> Vec<DirEntry> {
    entries
        .into_iter()
        .filter(|e| {
            let Some(name) = e.path.as_path().file_name().map(|n| n.to_string_lossy()) else { return false };
            (hidden || !name.starts_with('.')) && !(!include_noise && e.kind == EntryKind::Dir && is_noise(&name))
        })
        .collect()
}

/// `displayRelPath`: the entry's path under the listed folder, with forward slashes.
fn row_under(root: &std::path::Path, entry: DirEntry) -> Row {
    let name = fwd(entry.path.as_path().strip_prefix(root).unwrap_or(entry.path.as_path()));
    Row { name, kind: entry.kind, path: entry.path, stat: None }
}

/// `tryNativeDeepListRows`: a list below the first level asks the search server for every file and directory to `depth`
/// (`rg --files --directories --max-depth`, no ignore file honoured, a dotted name only with `hidden`, nothing inside a
/// noise directory, the directory itself listed), as a broad search: it takes its turn on the broad-search gate. `None`
/// when the request was refused or ran past its budget, or the inventory was cut at the row cap: Node's own walk then
/// answers.
async fn native_rows(ctx: &ToolContext, abs: &AbsPath, depth: usize, hidden: bool, include_noise: bool) -> Result<Option<Vec<Row>>, ToolError> {
    let root = abs.as_path().to_path_buf();
    let keep = |entry: &DirEntry| {
        let Ok(rel) = entry.path.as_path().strip_prefix(&root) else { return false };
        let parts: Vec<_> = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect();
        !parts.is_empty()
            && parts.len() <= depth
            && (hidden || parts.iter().all(|p| !p.starts_with('.')))
            && (include_noise || !parts[..parts.len() - 1].iter().any(|p| NOISE_DIRS.iter().any(|noise| *noise == &**p)))
    };
    let descent = Descent { max_depth: Some(depth), bare: if include_noise { Vec::new() } else { noise_bare() }, bare_dotted: !hidden };
    match super::search::broad_listing(ctx, abs, descent, keep, ABSOLUTE_CAP).await {
        Ok(walked) if walked.complete && !walked.capped => {
            Ok(Some(walked.entries.into_iter().map(|entry| row_under(abs.as_path(), entry)).collect()))
        }
        Err(e) if matches!(e.code, mixdog_core_api::domain::tool::ToolErrorCode::Cancelled) => Err(e),
        _ => Ok(None),
    }
}

/// `walkDir`'s code for a folder it could not read, as `directoryReadFailureLine` words it.
fn readdir_code(kind: &FsErrorKind) -> &'static str {
    match kind {
        FsErrorKind::NotFound => "ENOENT",
        FsErrorKind::NotADirectory => "ENOTDIR",
        FsErrorKind::PermissionDenied => "EACCES",
        _ => "UNKNOWN",
    }
}

/// The `type` argument of `list` and `find` (`['any', 'file', 'dir'].includes(args.type) ? args.type : 'any'`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum TypeFilter {
    Any,
    File,
    Dir,
}

impl TypeFilter {
    fn of(args: &JsonValue) -> Self {
        match arg_str(args, "type") {
            Some("file") => Self::File,
            Some("dir") => Self::Dir,
            _ => Self::Any,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Any => "any",
            Self::File => "file",
            Self::Dir => "dir",
        }
    }

    fn keeps(self, kind: EntryKind) -> bool {
        match self {
            Self::Any => true,
            Self::File => kind == EntryKind::File,
            Self::Dir => kind == EntryKind::Dir,
        }
    }
}

/// The `sort` argument (`['name', 'mtime', 'size'].includes(args.sort)`), else `fallback`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SortMode {
    Name,
    Mtime,
    Size,
}

impl SortMode {
    fn of(args: &JsonValue, fallback: Self) -> Self {
        match arg_str(args, "sort") {
            Some("name") => Self::Name,
            Some("mtime") => Self::Mtime,
            Some("size") => Self::Size,
            _ => fallback,
        }
    }
}

/// What `list` was asked to collect: the folder's walk and the rows kept of it.
struct Walk<'a> {
    raw: &'a str,
    depth: usize,
    hidden: bool,
    include_noise: bool,
    kind: TypeFilter,
}

/// `collectListRows`: the native inventory when it can serve a deep list, else a depth-first walk of the folder, cut at
/// 50,000 rows or 20 s.
async fn collect_rows(ctx: &ToolContext, abs: &AbsPath, walk: &Walk<'_>) -> Result<Rows, ToolError> {
    let Walk { raw, depth, hidden, include_noise, kind } = *walk;
    if depth > 1 {
        if let Some(found) = native_rows(ctx, abs, depth, hidden, include_noise).await? {
            let visited = found.len();
            let rows = found.into_iter().filter(|row| kind.keeps(row.kind)).collect();
            return Ok(Rows { rows, visited, truncated: false, warnings: Vec::new() });
        }
    }
    let started = mixdog_rt::time::Instant::now();
    let mut out = Rows { rows: Vec::new(), visited: 0, truncated: false, warnings: Vec::new() };
    let root = match guarded(ctx, "list", ctx.files.list_dir(ctx.io.interactive, abs.clone())).await? {
        Ok(entries) => entries,
        Err(e) => return Err(fs_failure(&e, raw)),
    };
    // One level of the walk per stack entry: its entries still to visit, each followed by what lies below it.
    let mut stack = vec![visible(root, hidden, include_noise).into_iter()];
    while let Some(level) = stack.last_mut() {
        let Some(entry) = level.next() else {
            stack.pop();
            continue;
        };
        if started.elapsed() > WALK_TIMEOUT {
            out.truncated = true;
            break;
        }
        out.visited += 1;
        let below = (entry.kind == EntryKind::Dir && stack.len() < depth).then(|| entry.path.clone());
        if kind.keeps(entry.kind) {
            out.rows.push(row_under(abs.as_path(), entry));
            if out.rows.len() >= ABSOLUTE_CAP {
                out.truncated = true;
                break;
            }
        }
        if let Some(dir) = below {
            match guarded(ctx, "list", ctx.files.list_dir(ctx.io.interactive, dir.clone())).await? {
                Ok(children) => stack.push(visible(children, hidden, include_noise).into_iter()),
                Err(e) => out.warnings.push(format!("[warning] readdir failed ({}): {}", readdir_code(&e.kind), fwd(dir.as_path()))),
            }
        }
    }
    Ok(out)
}

/// `YYYY-MM-DDTHH:MM:SSZ` of a system time (UTC, second precision).
fn iso_utc(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil-from-days (proleptic Gregorian).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

fn mode_octal(stat: &FileStat) -> &'static str {
    match (stat.kind, stat.readonly) {
        (EntryKind::Dir, false) => "777",
        (EntryKind::Dir, true) => "555",
        (_, false) => "666",
        (_, true) => "444",
    }
}

async fn line_count(ctx: &ToolContext, path: &AbsPath, len: u64) -> Option<u64> {
    if len > LINE_COUNT_MAX_BYTES {
        return None;
    }
    let bytes = ctx
        .files
        .read(ctx.io.interactive, path.clone(), ReadRange::default())
        .await
        .ok()?
        .bytes;
    if bytes.is_empty() {
        return Some(0);
    }
    let (text, _) = decode_text(&bytes).ok()?;
    let nl = text.bytes().filter(|b| *b == b'\n').count() as u64;
    Some(if text.ends_with('\n') { nl } else { nl + 1 })
}

async fn meta_suffix(ctx: &ToolContext, path: &AbsPath, known: Option<FileStat>) -> String {
    let stat = match known {
        Some(s) => s,
        None => match ctx.files.stat(ctx.io.interactive, path.clone()).await {
            Ok(s) => s,
            Err(_) => return "\t?\t?\t?".to_owned(),
        },
    };
    let mtime = stat.modified.map(iso_utc).unwrap_or_else(|| "?".to_owned());
    let lines = if stat.kind == EntryKind::File {
        line_count(ctx, path, stat.len).await.map(|n| format!("\t{n}")).unwrap_or_default()
    } else {
        String::new()
    };
    format!("\t{}\t{mtime}\t{}{lines}", stat.len, mode_octal(&stat))
}

/// The integer argument `key` of list as Node's guard leaves it (arg-guard.mjs `guardList`, `checkHeadLimit`,
/// `coerceIntegerString`): null is absent; a number must be a finite integer; a numeric string (`-?\d+(\.\d+)?`, trimmed,
/// integral) is its number; a negative value, a fraction and any other type are refused, with the guard's wording
/// (`head_limit` is worded `limit`, the name the model sees).
fn guarded_int(args: &JsonValue, key: &str) -> Result<Option<u64>, ToolError> {
    let Some(raw) = args.get(key).filter(|v| !v.is_null()) else { return Ok(None) };
    let coerced = match raw {
        JsonValue::String(s) => {
            let t = mixdog_js::js_trim(s);
            let unsigned = t.strip_prefix('-').unwrap_or(t);
            let (whole, fraction) = unsigned.split_once('.').map_or((unsigned, None), |(w, f)| (w, Some(f)));
            let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
            (digits(whole) && fraction.is_none_or(digits)).then(|| t.parse::<f64>().ok()).flatten().filter(|n| n.is_finite() && n.fract() == 0.0)
        }
        JsonValue::Number(n) => n.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0),
        _ => None,
    };
    let (field, name) = if key == "offset" { ("offset", "offset") } else { ("head_limit", "limit") };
    let Some(n) = coerced else {
        let got = super::read_legacy::describe_type(raw);
        return Err(invalid(
            field,
            "type",
            if key == "offset" {
                format!("Error: list arg \"offset\" must be a non-negative integer (got {got})")
            } else {
                format!("Error: list arg \"limit\" must be a finite integer (got {got})")
            },
        ));
    };
    if n < 0.0 {
        return Err(invalid(
            field,
            "range",
            if key == "offset" {
                "Error: list arg \"offset\" must be a non-negative integer (got number)".to_owned()
            } else {
                format!("Error: list arg \"{name}\" must be >= 0 (0 means no cap); got {}", mixdog_js::number_to_string(n))
            },
        ));
    }
    Ok(Some(n as u64))
}

#[async_trait]
impl Tool for ListTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        // `executeListTool`: the modes the schema does not show.
        match arg_str(&args, "mode") {
            Some("tree") => return tree_list(ctx, &args).await,
            Some("find") => return find_files(ctx, &args).await,
            _ => {}
        }
        // arg-guard.mjs (list): a `path` that is not a string is refused; a null or blank one is the cwd.
        let raw = super::common::optional_path_arg(&args, "path", |got| format!("Error: list arg \"path\" must be string (got {got})"))?
            .unwrap_or(".");
        let hidden = arg_bool(&args, "hidden");
        let meta = arg_bool(&args, "meta");
        let include_noise = arg_bool(&args, "include_noise");
        let kind = TypeFilter::of(&args);
        let sort = SortMode::of(&args, SortMode::Name);
        let offset = page_offset(&args)?;
        let limit = match head_limit(&args)? {
            Some(0) => 0,
            Some(n) => n.min(DEFAULT_PAGE) as usize,
            None => DEFAULT_PAGE as usize,
        };
        if !arg_str(&args, "name").is_some_and(|name| !name.is_empty()) && has_glob_magic(raw) {
            return find_files(ctx, &args).await;
        }
        let abs = resolve_path(&ctx.cwd, raw)?;
        let stat = match guarded(ctx, "list", ctx.files.stat(ctx.io.interactive, abs.clone())).await? {
            Ok(s) => s,
            Err(e) if missing_code(&e.kind).is_some() => {
                let code = missing_code(&e.kind).unwrap_or("ENOENT");
                return Ok(text_output(list_absent(ctx, &abs, raw, code).await));
            }
            Err(e) => return Err(fs_failure(&e, raw)),
        };
        if stat.kind != EntryKind::Dir {
            if stat.kind != EntryKind::File {
                return Err(fail(
                    mixdog_core_api::domain::tool::ToolErrorCode::Io { os_code: None },
                    format!("Error: not a directory — {}", fwd(abs.as_path())),
                ));
            }
            let suffix = if meta { meta_suffix(ctx, &abs, Some(stat)).await } else { String::new() };
            return Ok(text_output(format!("{}\tfile{suffix}", fwd(abs.as_path()))));
        }
        let depth = clamped_depth(&args, 1, 10);
        let walk = Walk { raw, depth, hidden, include_noise, kind };
        let Rows { mut rows, visited, truncated, warnings } = collect_rows(ctx, &abs, &walk).await?;
        // A sort by size or time reads every row's metadata first (`needsGlobalStat`).
        if sort != SortMode::Name {
            use futures::StreamExt as _;
            let paths: Vec<AbsPath> = rows.iter().map(|row| row.path.clone()).collect();
            let stats: Vec<Option<FileStat>> = guarded(
                ctx,
                "list",
                futures::stream::iter(paths.into_iter().map(|path| async move { ctx.files.stat(ctx.io.interactive, path).await.ok() }))
                    .buffered(64)
                    .collect(),
            )
            .await?;
            for (row, stat) in rows.iter_mut().zip(stats) {
                row.stat = stat;
            }
        }
        // `sortListRows`: by path in the locale's order, ties by code units; by size or time the larger first, ties by path.
        let size = |row: &Row| row.stat.as_ref().map_or(0, |s| s.len);
        let mtime = |row: &Row| row.stat.as_ref().and_then(|s| s.modified).and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
        rows.sort_by(|a, b| {
            let by_name = || mixdog_js::locale_compare(&a.name, &b.name).then_with(|| a.name.cmp(&b.name));
            match sort {
                SortMode::Name => by_name(),
                SortMode::Mtime => mtime(b).cmp(&mtime(a)).then_with(|| a.name.cmp(&b.name)),
                SortMode::Size => size(b).cmp(&size(a)).then_with(|| a.name.cmp(&b.name)),
            }
        });
        // Node's `recordDirectoryWalkTelemetry` (`list-tool.mjs:61`): the walk's entries after the hidden and noise
        // filters, up to the cap; the trace row's `payload.integrity`.
        let integrity = serde_json::json!({
            "kind": "directory-walk",
            "status": if !warnings.is_empty() { "partial" } else if visited == 0 { "empty" } else if rows.is_empty() { "filtered-empty" } else { "complete" },
            "entriesVisited": visited,
            "warnings": warnings.len(),
        });
        let text_output = |text: String| {
            let mut output = text_output(text);
            output.meta = Some(serde_json::json!({ RESULT_TELEMETRY_META: { "integrity": integrity } }));
            output
        };
        let total = rows.len();
        let windowed = rows.get(offset..).unwrap_or(&[]);
        let page = if limit == 0 { windowed } else { &windowed[..windowed.len().min(limit)] };
        let mut lines = Vec::with_capacity(page.len() + 1);
        for row in page {
            let mut line = format!("{}\t{}", row.name, type_name(row.kind));
            if meta {
                line.push_str(&meta_suffix(ctx, &row.path, row.stat.clone()).await);
            }
            lines.push(line);
        }
        if windowed.len() > page.len() {
            lines.push(window_marker(
                "entries",
                offset as u64 + 1,
                (offset + page.len()) as u64,
                Some(total as u64),
                Some((offset + page.len()) as u64),
                None,
            ));
        }
        if truncated {
            lines.push(cap_marker(
                &format!("{ABSOLUTE_CAP} rows or {}ms", WALK_TIMEOUT.as_millis()),
                "listing incomplete",
                None,
                "narrow the path or lower depth",
            ));
        }
        lines.extend(warnings);
        if lines.is_empty() {
            return Ok(text_output(empty_message(ctx, &abs, raw, offset, total, hidden, kind).await));
        }
        let text = lines.join("\n");
        if text.len() > locator_max_bytes() {
            let (kept, dropped) = cap_lines(&text, locator_max_bytes());
            let shown = lines.len() - dropped;
            let marker = cap_marker(
                &format_cap_size(locator_max_bytes()),
                &format!("{shown} rows shown"),
                Some((offset + shown) as u64),
                "",
            );
            return Ok(text_output(format!("{kept}\n{marker}")));
        }
        Ok(text_output(text))
    }
}

async fn empty_message(
    ctx: &ToolContext,
    abs: &AbsPath,
    raw: &str,
    offset: usize,
    total: usize,
    hidden: bool,
    kind: TypeFilter,
) -> String {
    if offset > 0 && total > 0 {
        return format!("(no entries after offset={offset}; total={total}) path={raw}");
    }
    if hidden && kind == TypeFilter::Any {
        return "(empty directory)".to_owned();
    }
    let mut filters = Vec::new();
    if kind != TypeFilter::Any {
        filters.push(format!("type={}", kind.name()));
    }
    if hidden {
        return format!("(no entries match filter) {} path={raw}", filters.join(", "));
    }
    let has_hidden = ctx
        .files
        .list_dir(ctx.io.interactive, abs.clone())
        .await
        .map(|es| {
            es.iter().any(|e| {
                e.path.as_path().file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))
            })
        })
        .unwrap_or(false);
    filters.push(
        if has_hidden { "hidden=false (dotfiles present — pass hidden:true to include)" } else { "hidden=false" }.to_owned(),
    );
    format!("(no entries match filter) {} path={raw}", filters.join(", "))
}

#[allow(dead_code)]
fn _assert_err(_: ToolError) {}

// ---- a glob-shaped path: Node's `list` answers it with its name search (`executeFindFilesTool`) ----

const FIND_ABSOLUTE_CAP: usize = 50_000;
const MAX_BRACE_VARIANTS: usize = 256;
const MAX_PATTERN_LENGTH: usize = 1024;
const MAX_REGEX_BODY_LENGTH: usize = 16_384;

/// Node `expandBraces`: the first innermost `{a,b}` expanded, recursively.
fn expand_braces(pattern: &str, out: &mut Vec<String>, prefix: &str) -> Result<(), String> {
    let open = pattern.char_indices().find(|&(i, c)| {
        c == '{' && pattern[i + 1..].find(['{', '}']).is_some_and(|j| pattern.as_bytes()[i + 1 + j] == b'}')
    });
    let Some((start, _)) = open else {
        if out.len() >= MAX_BRACE_VARIANTS {
            return Err(format!("glob brace expansion exceeds {MAX_BRACE_VARIANTS} variants"));
        }
        out.push(format!("{prefix}{pattern}"));
        return Ok(());
    };
    let end = start + 1 + pattern[start + 1..].find('}').unwrap_or(0);
    let (before, after) = (&pattern[..start], &pattern[end + 1..]);
    for part in pattern[start + 1..end].split(',') {
        expand_braces(after, out, &format!("{prefix}{before}{part}"))?;
    }
    Ok(())
}

/// Node `compileVariant`: `**/` any directories, `**` anything, `*` and `?` within a segment, `[...]` a class.
fn compile_variant(variant: &str) -> String {
    let chars: Vec<char> = variant.chars().collect();
    let mut body = String::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        match ch {
            '*' if chars.get(i + 1) == Some(&'*') && chars.get(i + 2) == Some(&'/') => {
                body.push_str("(?:.*/)?");
                i += 2;
            }
            '*' if chars.get(i + 1) == Some(&'*') => {
                body.push_str(".*");
                i += 1;
            }
            '*' => body.push_str("[^/]*"),
            '?' => body.push_str("[^/]"),
            '[' => {
                let mut j = i + 1;
                let negate = matches!(chars.get(j), Some('!' | '^'));
                if negate {
                    j += 1;
                }
                let inner_start = j;
                if chars.get(j) == Some(&']') {
                    j += 1;
                }
                while j < chars.len() && chars[j] != ']' {
                    j += 1;
                }
                if j < chars.len() && j > inner_start {
                    let inner: String = chars[inner_start..j]
                        .iter()
                        .map(|c| if matches!(c, '\\' | '[' | '&' | '~') { format!("\\{c}") } else { c.to_string() })
                        .collect();
                    body.push_str(&format!("[{}{inner}]", if negate { "^" } else { "" }));
                    i = j;
                } else {
                    body.push_str("\\[");
                }
            }
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '|' | ']' | '\\' => {
                body.push('\\');
                body.push(ch);
            }
            _ => body.push(ch),
        }
        i += 1;
    }
    body
}

/// Node `compileSimpleGlob`: a case-insensitive whole-subject regex, with its DoS caps.
fn compile_simple_glob(pattern: &str) -> Result<regex::Regex, String> {
    let pattern = if cfg!(windows) { pattern.replace('\\', "/") } else { pattern.to_owned() };
    let length = pattern.encode_utf16().count();
    if length > MAX_PATTERN_LENGTH {
        return Err(format!("glob pattern length {length} exceeds limit {MAX_PATTERN_LENGTH}"));
    }
    let mut variants = Vec::new();
    expand_braces(&pattern, &mut variants, "")?;
    let compiled: Vec<String> = variants.iter().map(|v| compile_variant(v)).collect();
    let body = if compiled.len() == 1 { compiled[0].clone() } else { format!("(?:{})", compiled.join("|")) };
    if body.len() > MAX_REGEX_BODY_LENGTH {
        return Err(format!("glob regex body length {} exceeds limit {MAX_REGEX_BODY_LENGTH}", body.len()));
    }
    regex::Regex::new(&format!("(?i)^{body}$")).map_err(|e| e.to_string())
}

/// Node `formatListSize`: `-` for a directory, else KB (at least 1) or MB.
fn format_list_size(kind: EntryKind, bytes: u64) -> String {
    if kind == EntryKind::Dir {
        return "-".to_owned();
    }
    if bytes >= 1024 * 1024 {
        return format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0));
    }
    format!("{}KB", ((bytes as f64 / 1024.0).round() as u64).max(1))
}

struct FoundRow {
    path: AbsPath,
    kind: EntryKind,
    size: u64,
    /// Milliseconds since the epoch; 0 when unknown.
    mtime: f64,
    known: bool,
}

/// Node `FIND_STAT_DEADLINE_MS`: how long one candidate's metadata is awaited.
const FIND_STAT_DEADLINE: std::time::Duration = std::time::Duration::from_millis(1_000);

const RELATIVE_WINDOW_MS: [(char, f64); 3] = [('m', 60_000.0), ('h', 3_600_000.0), ('d', 86_400_000.0)];

/// `parseModifiedTime`: a relative window (`90m`, `12h`, `7d`) back from now, or an ISO date/time; `None` when it is neither.
fn parse_modified_time(value: &JsonValue) -> Option<f64> {
    let text = value.as_str()?;
    let split = text.len().checked_sub(1).filter(|end| *end > 0 && text.is_char_boundary(*end));
    if let Some(split) = split {
        let (count, unit) = text.split_at(split);
        if count.bytes().all(|b| b.is_ascii_digit())
            && let Some((_, window)) = RELATIVE_WINDOW_MS.iter().find(|(u, _)| unit.starts_with(*u))
            && let Ok(n) = count.parse::<f64>()
        {
            return Some(chrono::Utc::now().timestamp_millis() as f64 - n * window);
        }
    }
    let time = mixdog_js::time::date_parse(text);
    (!time.is_nan()).then_some(time)
}

/// `invalidWindowError`.
fn invalid_window(field: &str, value: &JsonValue) -> ToolError {
    invalid(
        field,
        "window",
        format!(
            "Error: invalid {field} {}; expected an ISO date/time or a relative window like 90m / 12h / 7d",
            serde_json::to_string(value).unwrap_or_default()
        ),
    )
}

/// The `offset` argument: a non-negative integer, 0 when absent.
fn page_offset(args: &JsonValue) -> Result<usize, ToolError> {
    Ok(guarded_int(args, "offset")?.map_or(0, |n| n as usize))
}

/// The `head_limit` argument: `limit` is its short spelling, and `head_limit` wins when it is given (a null counts as not
/// given: `dropUndefinedArgs` removes it first).
fn head_limit(args: &JsonValue) -> Result<Option<u64>, ToolError> {
    let spelling = if args.get("head_limit").is_some_and(|v| !v.is_null()) { "head_limit" } else { "limit" };
    guarded_int(args, spelling)
}

/// `executeFindFilesTool`, which `list` answers with for `mode: "find"` and for a glob-shaped `path` with no `name`: an rg
/// inventory under the static base (`--files --directories --no-ignore`, the noise-tree excludes, `--iglob` of the rest),
/// filtered by the name (a glob when it holds a wildcard, else a case-insensitive substring), the type, the size and the
/// modified window, sorted (newest first unless `sort` says otherwise) and paged.
async fn find_files(ctx: &ToolContext, args: &JsonValue) -> ToolOutcome {
    let raw = super::common::optional_path_arg(args, "path", |got| format!("Error: list arg \"path\" must be string (got {got})"))?
        .unwrap_or(".");
    let mut input = raw.to_owned();
    let mut name_pattern = arg_str(args, "name").filter(|n| !n.is_empty()).map(str::to_owned);
    if name_pattern.is_none() && has_glob_magic(raw) {
        let (base, rest) = extract_glob_base_directory(raw);
        input = base.unwrap_or_else(|| ".".to_owned());
        name_pattern = Some(rest);
    }
    let name_pattern = name_pattern.map(|n| n.trim_start_matches('/').to_owned()).filter(|n| !n.is_empty());
    // A date that does not parse fails the call: a caller who passed a filter believes the listing is filtered.
    let window = |key: &str| -> Result<Option<f64>, ToolError> {
        let given = args.get(key).filter(|v| match v {
            JsonValue::Null | JsonValue::Bool(false) => false,
            JsonValue::String(s) => !s.is_empty(),
            JsonValue::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
            _ => true,
        });
        match given {
            None => Ok(None),
            Some(value) => parse_modified_time(value).map(Some).ok_or_else(|| invalid_window(key, value)),
        }
    };
    let (after, before) = (window("modified_after")?, window("modified_before")?);
    let kind = TypeFilter::of(args);
    let sort = SortMode::of(args, SortMode::Mtime);
    let number = |key: &str| args.get(key).and_then(JsonValue::as_f64);
    let min_size = number("min_size").filter(|n| *n > 0.0);
    let max_size = number("max_size").filter(|n| *n >= 0.0);
    let limit = head_limit(args)?.map_or(DEFAULT_PAGE as usize, |n| n as usize);
    let offset = page_offset(args)?;
    let (hidden, include_noise) = (arg_bool(args, "hidden"), arg_bool(args, "include_noise"));
    let depth = args.get("depth").filter(|v| !v.is_null()).map(|v| js_parse_int(v).filter(|n| *n != 0).unwrap_or(1).max(1) as usize);

    // The name as rg's `--iglob` and the matcher see it (`findNameMatcher`).
    let is_glob = name_pattern.as_deref().is_some_and(|n| n.contains(['*', '?', '[', ']', '{', '}']));
    let has_path = name_pattern.as_deref().is_some_and(|n| n.contains(['/', '\\']));
    let compiled = match name_pattern.as_deref().filter(|_| is_glob) {
        None => None,
        Some(pattern) => {
            let glob_error = |message: String| invalid("path", "glob", format!("Error: {message}"));
            let whole = compile_simple_glob(pattern).map_err(glob_error)?;
            let rest = pattern.strip_prefix("**/").map(compile_simple_glob).transpose().map_err(glob_error)?;
            Some((whole, rest))
        }
    };
    let lowered = name_pattern.as_deref().map(str::to_lowercase);
    let root = resolve_path(&ctx.cwd, &input)?;
    let stat = match guarded(ctx, "list", ctx.files.stat(ctx.io.interactive, root.clone())).await? {
        Ok(s) => s,
        Err(e) if missing_code(&e.kind).is_some() => {
            let code = missing_code(&e.kind).unwrap_or("ENOENT");
            return Ok(text_output(list_absent(ctx, &root, &input, code).await));
        }
        Err(e) => return Err(fs_failure(&e, &input)),
    };
    if stat.kind != EntryKind::Dir {
        return Err(fail(
            mixdog_core_api::domain::tool::ToolErrorCode::Io { os_code: None },
            format!("Error: not a directory — {}", fwd(root.as_path())),
        ));
    }
    let root_path = root.as_path().to_path_buf();
    // `parts` holds the path's components under the root; the name sees the last one, or the whole relative path when the
    // name holds a directory separator.
    let named = |parts: &[String]| {
        let subject = if has_path { parts.join("/") } else { parts.last().cloned().unwrap_or_default() };
        match (&compiled, &lowered) {
            (Some((whole, rest)), _) => whole.is_match(&subject) || rest.as_ref().is_some_and(|r| r.is_match(&subject)),
            (None, Some(fragment)) => subject.to_lowercase().contains(fragment.as_str()),
            (None, None) => true,
        }
    };
    let walked = super::search::walk_inventory(ctx, &root, |entry| {
        let Ok(rel) = entry.path.as_path().strip_prefix(&root_path) else { return false };
        let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        if parts.is_empty() || depth.is_some_and(|d| parts.len() > d) || !named(&parts) {
            return false;
        }
        // With no name rg has no glob to whitelist the entry, so a dotted one is skipped unless `hidden`.
        if name_pattern.is_none() && !hidden && parts[parts.len() - 1].starts_with('.') {
            return false;
        }
        // rg descends a directory its `--iglob` matches; one it does not match is skipped under a
        // noise directory (`!**/<noise>/**`) and, without `hidden`, when it is a dotted name.
        (1..parts.len()).all(|level| {
            let ancestor = &parts[..level];
            (name_pattern.is_some() && named(ancestor))
                || !((!include_noise && parts[..level - 1].iter().any(|p| NOISE_DIRS.contains(&p.as_str())))
                    || (!hidden && ancestor[level - 1].starts_with('.')))
        })
    }, FIND_ABSOLUTE_CAP)
    .await?;
    // Node `statPathsForMtime(candidates, …, 64, { deadlineMs: FIND_STAT_DEADLINE_MS })`: 64 stats at a time,
    // each bounded by the metadata deadline; one that fails or does not answer in time is listed with `-`, or left out when
    // a size, type or date filter needs its metadata.
    use futures::StreamExt as _;
    let stats: Vec<_> = guarded(
        ctx,
        "list",
        futures::stream::iter(walked.entries.into_iter().map(|entry| async move {
            let stat = mixdog_rt::time::timeout(FIND_STAT_DEADLINE, ctx.files.stat(ctx.io.interactive, entry.path.clone())).await;
            (entry, stat.ok().and_then(Result::ok))
        }))
        .buffered(64)
        .collect(),
    )
    .await?;
    let size_filtered = min_size.is_some() || max_size.is_some();
    let kind = if size_filtered && kind == TypeFilter::Any { TypeFilter::File } else { kind };
    let filters_need_stat = kind != TypeFilter::Any || size_filtered || after.is_some() || before.is_some();
    let mut rows = Vec::with_capacity(stats.len());
    let mut unstatted = 0usize;
    for (entry, stat) in stats {
        match stat {
            Some(s) => {
                let mtime = s.modified.and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
                let is_dir = s.kind == EntryKind::Dir;
                let is_file = s.kind == EntryKind::File;
                if (kind == TypeFilter::File && !is_file) || (kind == TypeFilter::Dir && !is_dir) {
                    continue;
                }
                if is_file && (min_size.is_some_and(|m| (s.len as f64) < m) || max_size.is_some_and(|m| (s.len as f64) > m)) {
                    continue;
                }
                if after.is_some_and(|a| mtime < a) || before.is_some_and(|b| mtime > b) {
                    continue;
                }
                rows.push(FoundRow { path: entry.path, kind: if is_dir { EntryKind::Dir } else { EntryKind::File }, size: s.len, mtime, known: true });
            }
            None => {
                unstatted += 1;
                if !filters_need_stat {
                    rows.push(FoundRow { path: entry.path, kind: EntryKind::File, size: 0, mtime: 0.0, known: false });
                }
            }
        }
    }
    let path_order = |a: &FoundRow, b: &FoundRow| fwd(a.path.as_path()).cmp(&fwd(b.path.as_path()));
    rows.sort_by(|a, b| match sort {
        SortMode::Name => mixdog_js::locale_compare(&fwd(a.path.as_path()), &fwd(b.path.as_path())).then_with(|| path_order(a, b)),
        SortMode::Size => b.size.cmp(&a.size).then_with(|| path_order(a, b)),
        SortMode::Mtime => b.mtime.total_cmp(&a.mtime).then_with(|| path_order(a, b)),
    });
    let total = rows.len();
    let windowed = rows.get(offset..).unwrap_or(&[]);
    let page = if limit == 0 { windowed } else { &windowed[..windowed.len().min(limit)] };
    let mut lines: Vec<String> = page
        .iter()
        .map(|row| {
            let shown = display_under(row.path.as_path(), &root_path);
            if !row.known {
                return format!("{shown}\t-\t-");
            }
            let mtime = if row.mtime == 0.0 {
                "-".to_owned()
            } else {
                let at = UNIX_EPOCH + std::time::Duration::from_millis(row.mtime as u64);
                iso_utc(at).trim_end_matches('Z').replacen('T', " ", 1)
            };
            format!("{shown}\t{}\t{mtime}", format_list_size(row.kind, row.size))
        })
        .collect();
    if windowed.len() > page.len() {
        let next = (offset + page.len()) as u64;
        lines.push(window_marker("entries", offset as u64 + 1, next, Some(total as u64), Some(next), None));
    }
    if walked.capped {
        lines.push(cap_marker(
            &format!("{FIND_ABSOLUTE_CAP} matches"),
            "walk cut, global sort inexact",
            None,
            "narrow the scope (path/name/modified_after)",
        ));
    }
    if !walked.complete {
        lines.push(
            "... walk INCOMPLETE (file enumeration timed out); matches are missing — narrow the scope (path/name/depth) and re-run"
                .to_owned(),
        );
    }
    if unstatted > 0 {
        lines.push(format!(
            "... {unstatted} path(s) had no metadata within 1000ms; {}",
            if filters_need_stat { "excluded because a size/type/date filter is active" } else { "listed with \"-\" for size/date" }
        ));
    }
    if lines.is_empty() {
        return Ok(text_output("(no matches)"));
    }
    Ok(text_output(lines.join("\n")))
}

/// `TREE_BRANCH_LINE_CAP`: the body rows a tree shows when its walk has no `head_limit` to stop at.
const TREE_BRANCH_LINE_CAP: usize = 500;

/// One level of a tree walk: its entries (directories first, then by name), the next to visit, and the prefix its rows carry.
struct TreeLevel {
    entries: Vec<DirEntry>,
    next: usize,
    prefix: String,
}

fn tree_level(mut entries: Vec<DirEntry>, prefix: String) -> TreeLevel {
    let name = |e: &DirEntry| e.path.as_path().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    entries.sort_by(|a, b| {
        let (ad, bd) = (a.kind == EntryKind::Dir, b.kind == EntryKind::Dir);
        bd.cmp(&ad).then_with(|| mixdog_js::locale_compare(&name(a), &name(b)))
    });
    TreeLevel { entries, next: 0, prefix }
}

/// `executeTreeTool`: `mode: "tree"`, the folder as indented branch lines, directories first, to `depth` (default 3, at most
/// 6), paged by `offset` and `head_limit` (default 200).
async fn tree_list(ctx: &ToolContext, args: &JsonValue) -> ToolOutcome {
    let raw = super::common::optional_path_arg(args, "path", |got| format!("Error: list arg \"path\" must be string (got {got})"))?
        .unwrap_or(".");
    let depth = clamped_depth(args, 3, 6);
    let (hidden, include_noise) = (arg_bool(args, "hidden"), arg_bool(args, "include_noise"));
    let limit = head_limit(args)?.unwrap_or(200);
    let offset = page_offset(args)?;
    let abs = resolve_path(&ctx.cwd, raw)?;
    let stat = match guarded(ctx, "list", ctx.files.stat(ctx.io.interactive, abs.clone())).await? {
        Ok(s) => s,
        Err(e) if missing_code(&e.kind).is_some() => {
            let code = missing_code(&e.kind).unwrap_or("ENOENT");
            return Ok(text_output(list_absent(ctx, &abs, raw, code).await));
        }
        Err(e) => return Err(fs_failure(&e, raw)),
    };
    if stat.kind != EntryKind::Dir {
        return Err(fail(
            mixdog_core_api::domain::tool::ToolErrorCode::Io { os_code: None },
            format!("Error: not a directory — {}", fwd(abs.as_path())),
        ));
    }
    let root = match guarded(ctx, "list", ctx.files.list_dir(ctx.io.interactive, abs.clone())).await? {
        Ok(entries) => entries,
        Err(e) => return Err(fs_failure(&e, raw)),
    };
    // The walk stops once the window and one more row are in (`treeGatherCap`); with `head_limit: 0` it runs to the end.
    let gather_cap = if limit > 0 { offset + limit as usize + 1 } else { offset + TREE_BRANCH_LINE_CAP + 1 };
    let mut body: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut stack = vec![tree_level(visible(root, hidden, include_noise), String::new())];
    while let Some(level) = stack.last_mut() {
        let Some(entry) = level.entries.get(level.next).cloned() else {
            stack.pop();
            continue;
        };
        let is_last = level.next + 1 == level.entries.len();
        level.next += 1;
        let prefix = level.prefix.clone();
        let is_dir = entry.kind == EntryKind::Dir;
        let name = entry.path.as_path().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        body.push(format!("{prefix}{}{name}{}", if is_last { "└── " } else { "├── " }, if is_dir { "/" } else { "" }));
        if limit != 0 && body.len() >= gather_cap {
            break;
        }
        if is_dir && stack.len() < depth {
            let child_prefix = format!("{prefix}{}", if is_last { "    " } else { "│   " });
            match guarded(ctx, "list", ctx.files.list_dir(ctx.io.interactive, entry.path.clone())).await? {
                Ok(children) => stack.push(tree_level(visible(children, hidden, include_noise), child_prefix)),
                Err(e) => warnings.push(format!("[warning] readdir failed ({}): {}", readdir_code(&e.kind), fwd(entry.path.as_path()))),
            }
        }
    }
    // `renderTreeOutput`: `head_limit: 0` is no cap.
    let windowed = body.get(offset..).unwrap_or(&[]);
    let branch_limit = if limit == 0 { windowed.len() } else { limit as usize };
    let shown = &windowed[..windowed.len().min(branch_limit)];
    let mut lines = vec![format!("{}/", fwd(abs.as_path()))];
    lines.extend(shown.iter().cloned());
    if windowed.len() > shown.len() {
        // The walk stops gathering at the cap, so a body that filled it has an unknown total: `N+` keeps the caller paging.
        let total = if body.len() >= gather_cap { format!("{}+", body.len()) } else { body.len().to_string() };
        let next = offset + shown.len();
        lines.push(format!("[entries {}-{next} of {total}; offset:{next} for more]", offset + 1));
    }
    lines.extend(warnings);
    let text = lines.join("\n");
    if text.len() > OUTPUT_MAX_BYTES {
        let kept = byte_prefix(&text, OUTPUT_MAX_BYTES);
        return Ok(text_output(format!("{kept}\n{}", cap_marker(&format_cap_size(OUTPUT_MAX_BYTES), "", None, "narrow path or lower depth"))));
    }
    Ok(text_output(text))
}
