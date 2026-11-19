//! `list`: a directory's entries (one level, or `depth` levels), paged, optional metadata columns (T §3.2).

use std::cmp::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::Descent;
use mixdog_core_api::domain::fs::NameGuard;
use mixdog_core_api::domain::fs::DirEntry;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::LocatorStat;
use mixdog_core_api::domain::fs::ReadRange;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_rt::LaneToken;

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
    /// Read for a sort by size or time, and then reused by the `meta` columns.
    stat: Option<LocatorStat>,
    ordinal: usize,
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
    raw_path_ties: bool,
    /// The entries the noise filter removed from the folders the walk read.
    noise: usize,
}

/// JS `parseInt(value, 10)` of whatever it is given: it reads the text of the value (a number's, an array's elements joined)
/// up to its first character that is no digit; no digits is `NaN`, here `None`.
pub(super) fn js_parse_int(value: &JsonValue) -> Option<i64> {
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
    visible_counting(entries, hidden, include_noise, &mut 0)
}

/// [`visible`], adding to `noise` the entries only the noise filter removed (a hidden name the `hidden` filter drops
/// anyway is not one of them).
fn visible_counting(entries: Vec<DirEntry>, hidden: bool, include_noise: bool, noise: &mut usize) -> Vec<DirEntry> {
    entries
        .into_iter()
        .filter(|e| {
            let Some(name) = e.path.as_path().file_name().map(|n| n.to_string_lossy()) else { return false };
            if !hidden && name.starts_with('.') {
                return false;
            }
            let excluded = !include_noise && e.kind == EntryKind::Dir && is_noise(&name);
            *noise += usize::from(excluded);
            !excluded
        })
        .collect()
}

/// What `list` says of the entries its noise filter removed, so a folder holding only noise is not read as empty.
fn noise_note(noise: usize) -> String {
    format!("{noise} noise entries excluded (include_noise:true to show)")
}

/// `displayRelPath`: the entry's path under the listed folder, with forward slashes.
fn row_under(root: &std::path::Path, entry: DirEntry, ordinal: usize) -> Row {
    let name = fwd(entry.path.as_path().strip_prefix(root).unwrap_or(entry.path.as_path()));
    Row { name, kind: entry.kind, path: entry.path, stat: None, ordinal }
}

/// `tryNativeDeepListRows`: a list below the first level asks the search server for every file and directory to `depth`
/// (`rg --files --directories --max-depth`, no ignore file honoured, a dotted name only with `hidden`, nothing inside a
/// noise directory, the directory itself listed), as a broad search: it takes its turn on the broad-search gate. `None`
/// when the request was refused or ran past its budget, or the inventory was cut at the row cap: Node's own walk then
/// answers.
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
async fn native_rows(ctx: &ToolContext, abs: &AbsPath, walk: &Walk<'_>) -> Result<Option<Rows>, ToolError> {
    let Walk { depth, hidden, include_noise, kind, .. } = *walk;
    let root = abs.as_path();
    let keep = |entry: &DirEntry| {
        let Ok(rel) = entry.path.as_path().strip_prefix(root) else { return false };
        let mut parts = rel.components().map(|part| part.as_os_str().to_string_lossy());
        let Some(name) = parts.next_back() else { return false };
        (hidden || !name.starts_with('.'))
            && parts.enumerate().all(|(i, part)| {
                i + 1 < depth && (hidden || !part.starts_with('.')) && (include_noise || !NOISE_DIRS.contains(&part.as_ref()))
            })
    };
    let descent = Descent { max_depth: Some(depth), bare: if include_noise { Vec::new() } else { noise_bare() }, bare_dotted: !hidden, guard: None };
    match super::search::broad_listing(ctx, abs, descent, keep, ABSOLUTE_CAP).await {
        Ok(walked) if walked.complete && !walked.capped => {
            let visited = walked.entries.len();
            let rows = walked.entries.into_iter().filter(|entry| kind.keeps(entry.kind)).enumerate()
                .map(|(ordinal, entry)| row_under(root, entry, ordinal)).collect();
            Ok(Some(Rows { rows, visited, truncated: false, warnings: Vec::new(), raw_path_ties: false, noise: 0 }))
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
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
async fn collect_rows(ctx: &ToolContext, abs: &AbsPath, walk: &Walk<'_>) -> Result<Rows, ToolError> {
    let Walk { raw, depth, hidden, include_noise, kind } = *walk;
    if depth > 1 && let Some(found) = native_rows(ctx, abs, walk).await? {
        return Ok(found);
    }
    let started = mixdog_rt::time::Instant::now();
    let mut out = Rows { rows: Vec::new(), visited: 0, truncated: false, warnings: Vec::new(), raw_path_ties: false, noise: 0 };
    let (root, unsorted) = match guarded(ctx, "list", async {
        if depth == 1 {
            ctx.files.list_dir_for_ranking(ctx.io.interactive, abs.clone(), ABSOLUTE_CAP).await
        } else {
            ctx.files.list_dir(ctx.io.interactive, abs.clone()).await.map(|entries| (entries, false))
        }
    }).await? {
        Ok(listing) => listing,
        Err(e) => return Err(fs_failure(&e, raw)),
    };
    let mut root = visible_counting(root, hidden, include_noise, &mut out.noise);
    if unsorted {
        // Below the cap only a timeout can make the subset depend on readdir order.
        out.visited = root.iter().take_while(|_| started.elapsed() <= WALK_TIMEOUT).count();
        out.truncated = out.visited < root.len();
        if out.truncated {
            root.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        }
        out.raw_path_ties = true;
        out.rows = root.into_iter().take(out.visited).filter(|entry| kind.keeps(entry.kind)).enumerate()
            .map(|(ordinal, entry)| row_under(abs.as_path(), entry, ordinal)).collect();
        return Ok(out);
    }
    // One level of the walk per stack entry: its entries still to visit, each followed by what lies below it.
    let mut stack = vec![root.into_iter()];
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
            out.rows.push(row_under(abs.as_path(), entry, out.visited - 1));
            if out.rows.len() >= ABSOLUTE_CAP {
                out.truncated = true;
                break;
            }
        }
        if let Some(dir) = below {
            match guarded(ctx, "list", ctx.files.list_dir(ctx.io.interactive, dir.clone())).await? {
                Ok(children) => stack.push(visible_counting(children, hidden, include_noise, &mut out.noise).into_iter()),
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

/// The mode Node's native list-metadata server reports where the OS has no permission bits (`list_metadata_mode` of
/// serve_search/protocol.rs): 777 for a directory, else 444 with the read-only attribute and 666 without.
fn windows_mode_octal(stat: &LocatorStat) -> &'static str {
    match (stat.kind, stat.readonly) {
        (EntryKind::Dir, _) => "777",
        (_, true) => "444",
        (_, false) => "666",
    }
}

#[cfg(unix)]
#[allow(clippy::disallowed_methods, reason = "runs only as an interactive-lane job body (mode_octal)")]
fn unix_mode(path: &std::path::Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::symlink_metadata(path).ok().map(|meta| meta.permissions().mode())
}

#[cfg(not(unix))]
fn unix_mode(_: &std::path::Path) -> Option<u32> {
    None
}

/// `_metaModeOctal`: `mode & 0o7777` of the entry's own `lstat` in at least three octal digits. `?` is for a mode that
/// cannot be read: the whole `st_mode`, file type included, is tested, so a file of mode 000 is `000`.
async fn mode_octal(ctx: &ToolContext, path: &AbsPath, stat: &LocatorStat) -> String {
    if cfg!(windows) {
        return windows_mode_octal(stat).to_owned();
    }
    let full = path.as_path().to_path_buf();
    let Ok(job) = ctx.io.interactive.submit(&ctx.cancel, move |_| unix_mode(&full)) else { return "?".to_owned() };
    match job.await {
        Ok(Some(mode)) if mode > 0 => format!("{:03o}", mode & 0o7777),
        _ => "?".to_owned(),
    }
}

/// A row's metadata is the entry's own, a link's not its target's (Node `lstat`, `listMetadataForPaths`).
async fn row_stat(ctx: &ToolContext, path: &AbsPath) -> Option<LocatorStat> {
    ctx.files.lstat_for_locator(ctx.io.interactive, path.clone()).await.ok()
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Metadata {
    None,
    Stat,
    Full,
}

impl Metadata {
    fn of(args: &JsonValue) -> Self {
        if arg_bool(args, "meta") {
            Self::Full
        } else if arg_bool(args, "stat_only") {
            Self::Stat
        } else {
            Self::None
        }
    }
}

async fn meta_suffix(ctx: &ToolContext, path: &AbsPath, known: Option<LocatorStat>, meta: Metadata) -> String {
    if meta == Metadata::None {
        return String::new();
    }
    let stat = match known {
        Some(s) => s,
        None => match row_stat(ctx, path).await {
            Some(s) => s,
            None => return "\t?\t?\t?".to_owned(),
        },
    };
    let mtime = stat.modified.map(iso_utc).unwrap_or_else(|| "?".to_owned());
    let lines = if meta == Metadata::Full && stat.kind == EntryKind::File {
        line_count(ctx, path, stat.len).await.map(|n| format!("\t{n}")).unwrap_or_default()
    } else {
        String::new()
    };
    format!("\t{}\t{mtime}\t{}{lines}", stat.len, mode_octal(ctx, path, &stat).await)
}

/// The integer argument `key` of list as Node's guard leaves it (arg-guard.mjs `guardList`, `checkHeadLimit`,
/// `coerceIntegerString`): null is absent; a number must be a finite integer; a numeric string (`-?\d+(\.\d+)?`, trimmed,
/// integral) is its number; a negative value, a fraction and any other type are refused, with the guard's wording
/// (`head_limit` is worded `limit`, the name the model sees).
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
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
        super::search::with_broad_times(self.respond(ctx, args)).await
    }
}
impl ListTool {
    async fn respond(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
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
        let meta = Metadata::of(&args);
        let include_noise = arg_bool(&args, "include_noise");
        let kind = TypeFilter::of(&args);
        let sort = SortMode::of(&args, SortMode::Name);
        let offset = page_offset(&args)?;
        let page = env_default_limit("MIXDOG_LIST_DEFAULT_HEAD_LIMIT", DEFAULT_PAGE as usize);
        let limit = match head_limit(&args)? {
            Some(0) => 0,
            Some(n) => (n as usize).min(page),
            None => page,
        };
        if !arg_str(&args, "name").is_some_and(|name| !name.is_empty()) && has_glob_magic(raw) {
            return find_files(ctx, &args).await;
        }
        let abs = resolve_path(&ctx.cwd, raw)?;
        let stat = match guarded(ctx, "list", ctx.files.stat_for_locator(ctx.io.interactive, abs.clone())).await? {
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
            let suffix = meta_suffix(ctx, &abs, Some(stat), meta).await;
            return Ok(text_output(format!("{}\tfile{suffix}", fwd(abs.as_path()))));
        }
        let depth = clamped_depth(&args, 1, 10);
        let walk = Walk { raw, depth, hidden, include_noise, kind };
        let Rows { mut rows, visited, truncated, warnings, raw_path_ties, noise } = collect_rows(ctx, &abs, &walk).await?;
        // A sort by size or time reads every row's metadata first (`needsGlobalStat`).
        let mut missing_sort_stat = false;
        let mut cache_safe = meta == Metadata::None;
        if sort != SortMode::Name {
            cache_safe &= rows.iter().all(|row| row.kind != EntryKind::Symlink);
            use futures::StreamExt as _;
            missing_sort_stat = guarded(ctx, "list", async {
                let mut stats = futures::stream::FuturesUnordered::new();
                let mut missing = false;
                for row in &mut rows {
                    stats.push(async move {
                        row.stat = row_stat(ctx, &row.path).await;
                        row.stat.is_none()
                    });
                    if stats.len() == 64 {
                        missing |= stats.next().await.expect("64 pending stat requests");
                    }
                }
                while let Some(failed) = stats.next().await {
                    missing |= failed;
                }
                missing
            }).await?;
        }
        // Node's `recordDirectoryWalkTelemetry` (`list-tool.mjs:61`): the walk's entries after the hidden and noise
        // filters, up to the cap; the trace row's `payload.integrity`.
        let complete = !truncated && warnings.is_empty() && !missing_sort_stat;
        let integrity = serde_json::json!({
            "kind": "directory-walk",
            "status": if !complete { "partial" } else if visited == 0 { "empty" } else if rows.is_empty() { "filtered-empty" } else { "complete" },
            "entriesVisited": visited,
            "warnings": warnings.len(),
        });
        let text_output = |text: String, complete| {
            let mut output = text_output(text);
            output.meta = Some(serde_json::json!({
                "complete": complete,
                "cacheSafe": cache_safe,
                RESULT_TELEMETRY_META: { "integrity": integrity },
            }));
            output
        };
        let total = rows.len();
        // Size and time descend; name collation and then the original display-path tie-breaks are unchanged.
        let size = |row: &Row| row.stat.as_ref().map_or(0, |s| s.len);
        let mtime = |row: &Row| row.stat.as_ref().and_then(|s| s.modified).and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
        let page = ranked_page(&mut rows, offset, limit, |a, b| {
            match sort {
                SortMode::Name => mixdog_js::locale_compare(&a.name, &b.name),
                SortMode::Mtime => mtime(b).cmp(&mtime(a)),
                SortMode::Size => size(b).cmp(&size(a)),
            }.then_with(|| a.name.cmp(&b.name))
                .then_with(|| if raw_path_ties { a.path.cmp(&b.path) } else { Ordering::Equal })
                .then_with(|| a.ordinal.cmp(&b.ordinal))
        });
        let mut lines = Vec::with_capacity(page.len() + 1);
        for row in page {
            let mut line = format!("{}\t{}", row.name, type_name(row.kind));
            if meta != Metadata::None {
                line.push_str(&meta_suffix(ctx, &row.path, row.stat, meta).await);
            }
            lines.push(line);
        }
        if total.saturating_sub(offset) > page.len() {
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
            return Ok(text_output(empty_message(ctx, &abs, raw, offset, total, hidden, kind, noise).await, complete && meta == Metadata::None));
        }
        if noise > 0 {
            lines.push(noise_note(noise));
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
            return Ok(text_output(format!("{kept}\n{marker}"), false));
        }
        // Per-entry metadata may follow a symlink or fail without changing the listing.
        Ok(text_output(text, complete && meta == Metadata::None))
    }
}

#[allow(clippy::too_many_arguments, reason = "the listing's independent filters and counts")]
async fn empty_message(
    ctx: &ToolContext,
    abs: &AbsPath,
    raw: &str,
    offset: usize,
    total: usize,
    hidden: bool,
    kind: TypeFilter,
    noise: usize,
) -> String {
    if offset > 0 && total > 0 {
        return format!("(no entries after offset={offset}; total={total}) path={raw}");
    }
    if noise > 0 && total == 0 {
        return format!("(no entries shown) {} path={raw}", noise_note(noise));
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
    order_path: String,
    ordinal: usize,
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
fn relative_window(text: &str) -> Option<f64> {
    let split = text.len().checked_sub(1).filter(|end| *end > 0 && text.is_char_boundary(*end))?;
    let (count, unit) = text.split_at(split);
    if !count.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (_, window) = RELATIVE_WINDOW_MS.iter().find(|(u, _)| unit.starts_with(*u))?;
    Some(count.parse::<f64>().ok()? * window)
}

pub(super) fn uses_relative_time(args: &JsonValue) -> bool {
    ["modified_after", "modified_before"].iter().any(|key| arg_str(args, key).and_then(relative_window).is_some())
}

fn parse_modified_time(value: &JsonValue) -> Option<f64> {
    let text = value.as_str()?;
    if let Some(window) = relative_window(text) {
        return Some(chrono::Utc::now().timestamp_millis() as f64 - window);
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
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
fn page_offset(args: &JsonValue) -> Result<usize, ToolError> {
    Ok(guarded_int(args, "offset")?.map_or(0, |n| n as usize))
}

/// The `head_limit` argument: `limit` is its short spelling, and `head_limit` wins when it is given (a null counts as not
/// given: `dropUndefinedArgs` removes it first).
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
fn head_limit(args: &JsonValue) -> Result<Option<u64>, ToolError> {
    let spelling = if args.get("head_limit").is_some_and(|v| !v.is_null()) { "head_limit" } else { "limit" };
    guarded_int(args, spelling)
}

/// Partition both ends so a late page doesn't have to sort the prefix either.
/// Include the original ordinal in `compare` when two display paths can tie.
fn ranked_page<T>(rows: &mut [T], offset: usize, limit: usize, mut compare: impl FnMut(&T, &T) -> Ordering) -> &[T] {
    if offset >= rows.len() {
        return &[];
    }
    let end = if limit == 0 { rows.len() } else { offset.saturating_add(limit).min(rows.len()) };
    if end < rows.len() {
        rows.select_nth_unstable_by(end, &mut compare);
    }
    let rows = &mut rows[..end];
    if offset > 0 {
        rows.select_nth_unstable_by(offset, &mut compare);
    }
    let page = &mut rows[offset..];
    page.sort_unstable_by(compare);
    page
}

/// `executeFindFilesTool`, which `list` answers with for `mode: "find"` and for a glob-shaped `path` with no `name`: an rg
/// inventory under the static base (`--files --directories --no-ignore`, the noise-tree excludes, `--iglob` of the rest),
/// filtered by the name (a glob when it holds a wildcard, else a case-insensitive substring), the type, the size and the
/// modified window, sorted (newest first unless `sort` says otherwise) and paged.
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
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
    let stat = match guarded(ctx, "list", ctx.files.stat_for_locator(ctx.io.interactive, root.clone())).await? {
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
    // The same rule the `keep` below applies to each ancestor, handed to the walk as data: a folder it fails is not entered.
    // With no name no folder is named, so a folder inside a noise folder (unless `include_noise`), or a dotted one (without
    // `hidden`), fails; the noise folder itself is entered, as `keep` keeps its direct children.
    let guard = NameGuard {
        whole: compiled.as_ref().map(|(whole, _)| whole.as_str().to_owned()),
        rest: compiled.as_ref().and_then(|(_, rest)| rest.as_ref()).map(|rest| rest.as_str().to_owned()),
        fragment: if compiled.is_none() { lowered.clone() } else { None },
        path: has_path,
        noise: if include_noise { Vec::new() } else { NOISE_DIRS.iter().map(|n| (*n).to_owned()).collect() },
        dotted: !hidden,
    };
    let descent = Descent { max_depth: depth, guard: Some(guard), ..Descent::default() };
    let walked = super::search::walk_inventory(ctx, &root, descent, |entry| {
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
    let size_filtered = min_size.is_some() || max_size.is_some();
    let kind = if size_filtered && kind == TypeFilter::Any { TypeFilter::File } else { kind };
    let filters_need_stat = kind != TypeFilter::Any || size_filtered || after.is_some() || before.is_some();
    let (mut rows, unstatted, cache_safe) = guarded(ctx, "list", async {
        let mut stats = futures::stream::iter(walked.entries.into_iter().map(|entry| async move {
            let stat = mixdog_rt::time::timeout(FIND_STAT_DEADLINE, ctx.files.stat_for_locator(ctx.io.interactive, entry.path.clone())).await;
            (entry, stat.ok().and_then(Result::ok))
        }))
        .buffered(64);
        let mut rows = Vec::new();
        let mut unstatted = 0usize;
        let mut cache_safe = !uses_relative_time(args);
        while let Some((entry, stat)) = stats.next().await {
            // Filtering and ordering use stat, which follows even links that do not survive the final filter.
            cache_safe &= entry.kind != EntryKind::Symlink;
            let (kind, size, mtime, known) = if let Some(s) = stat {
                let mtime = s.modified.and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
                let is_dir = s.kind == EntryKind::Dir;
                let is_file = s.kind == EntryKind::File;
                if (kind == TypeFilter::File && !is_file) || (kind == TypeFilter::Dir && !is_dir)
                    || (is_file && (min_size.is_some_and(|m| (s.len as f64) < m) || max_size.is_some_and(|m| (s.len as f64) > m)))
                    || after.is_some_and(|a| mtime < a) || before.is_some_and(|b| mtime > b)
                {
                    continue;
                }
                (if is_dir { EntryKind::Dir } else { EntryKind::File }, s.len, mtime, true)
            } else {
                unstatted += 1;
                if filters_need_stat {
                    continue;
                }
                (EntryKind::File, 0, 0.0, false)
            };
            rows.push(FoundRow { order_path: fwd(entry.path.as_path()), ordinal: rows.len(), path: entry.path, kind, size, mtime, known });
        }
        (rows, unstatted, cache_safe)
    }).await?;
    let total = rows.len();
    let page = ranked_page(&mut rows, offset, limit, |a, b| {
        match sort {
            SortMode::Name => mixdog_js::locale_compare(&a.order_path, &b.order_path),
            SortMode::Size => b.size.cmp(&a.size),
            SortMode::Mtime => b.mtime.total_cmp(&a.mtime),
        }.then_with(|| a.order_path.cmp(&b.order_path)).then_with(|| a.ordinal.cmp(&b.ordinal))
    });
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
    if total.saturating_sub(offset) > page.len() {
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
    let complete = walked.complete && !walked.capped && unstatted == 0;
    let text = if lines.is_empty() { "(no matches)".to_owned() } else { lines.join("\n") };
    Ok(list_completion(text, complete, cache_safe))
}

fn list_completion(text: String, complete: bool, cache_safe: bool) -> ToolOutput {
    let mut output = text_output(text);
    output.meta = Some(serde_json::json!({ "complete": complete, "cacheSafe": cache_safe }));
    output
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
#[allow(clippy::result_large_err, reason = "preserve the canonical ToolError/FsError payload and exact filesystem-tool error contract without API boxing")]
async fn tree_list(ctx: &ToolContext, args: &JsonValue) -> ToolOutcome {
    let raw = super::common::optional_path_arg(args, "path", |got| format!("Error: list arg \"path\" must be string (got {got})"))?
        .unwrap_or(".");
    let depth = clamped_depth(args, 3, 6);
    let (hidden, include_noise) = (arg_bool(args, "hidden"), arg_bool(args, "include_noise"));
    let limit = head_limit(args)?.unwrap_or(env_default_limit("MIXDOG_LIST_DEFAULT_HEAD_LIMIT", 200) as u64);
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
    // The walk stops once the window and one more row are in (`treeGatherCap`); with `head_limit: 0` it runs to the end.
    let gather_cap = if limit > 0 { offset + limit as usize + 1 } else { offset + TREE_BRANCH_LINE_CAP + 1 };
    // The walk below the folder is a broad search: it takes its turn and is bounded as a deep list's inventory is.
    let walk = |_budget: u64| async {
        let root = match guarded(ctx, "list", ctx.files.list_dir(ctx.io.interactive, abs.clone())).await? {
            Ok(entries) => entries,
            Err(e) => return Err(fs_failure(&e, raw)),
        };
        let mut body: Vec<String> = Vec::new();
        let mut warnings: Vec<String> = Vec::new();
        let mut noise = 0usize;
        let mut stack = vec![tree_level(visible_counting(root, hidden, include_noise, &mut noise), String::new())];
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
                    Ok(children) => stack.push(tree_level(visible_counting(children, hidden, include_noise, &mut noise), child_prefix)),
                    Err(e) => warnings.push(format!("[warning] readdir failed ({}): {}", readdir_code(&e.kind), fwd(entry.path.as_path()))),
                }
            }
        }
        Ok((body, warnings, noise))
    };
    let (body, warnings, noise) = super::search::broad_tree(ctx, walk).await?;
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
    let complete = warnings.is_empty();
    if noise > 0 {
        lines.push(noise_note(noise));
    }
    lines.extend(warnings);
    let text = lines.join("\n");
    if text.len() > super::common::output_max_bytes() {
        let kept = byte_prefix(&text, super::common::output_max_bytes());
        return Ok(list_completion(format!("{kept}\n{}", cap_marker(&format_cap_size(super::common::output_max_bytes()), "", None, "narrow path or lower depth")), false, true));
    }
    Ok(list_completion(text, complete, true))
}
