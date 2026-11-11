//! `list`: one directory level, paged, optional metadata columns (T §3.2).

use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::DirEntry;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::FileStat;
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
}

fn type_name(kind: EntryKind) -> &'static str {
    match kind {
        EntryKind::File => "file",
        EntryKind::Dir => "dir",
        EntryKind::Symlink => "symlink",
        EntryKind::Special => "other",
    }
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

#[async_trait]
impl Tool for ListTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        // arg-guard.mjs (list): a `path` that is not a string is refused; a null or blank one is the cwd.
        let raw = super::common::optional_path_arg(&args, "path", |got| format!("Error: list arg \"path\" must be string (got {got})"))?
            .unwrap_or(".");
        let hidden = arg_bool(&args, "hidden");
        let meta = arg_bool(&args, "meta");
        let offset = arg_u64(&args, "offset").unwrap_or(0) as usize;
        let limit = match arg_u64(&args, "limit") {
            Some(0) => 0,
            Some(n) => n.min(DEFAULT_PAGE) as usize,
            None => DEFAULT_PAGE as usize,
        };
        if has_glob_magic(raw) {
            return glob_path_list(ctx, raw, hidden, offset, limit).await;
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
        let entries: Vec<DirEntry> =
            match guarded(ctx, "list", ctx.files.list_dir(ctx.io.interactive, abs.clone())).await? {
                Ok(e) => e,
                Err(e) => return Err(fs_failure(&e, raw)),
            };
        let mut rows: Vec<Row> = entries
            .into_iter()
            .filter_map(|e| {
                let name = e.path.as_path().file_name()?.to_string_lossy().into_owned();
                Some(Row { name, kind: e.kind, path: e.path })
            })
            .filter(|r| hidden || !r.name.starts_with('.'))
            .filter(|r| !(r.kind == EntryKind::Dir && NOISE_DIRS.contains(&r.name.as_str())))
            .collect();
        rows.sort_by(|a, b| compare_names(&a.name, &b.name));
        rows.truncate(ABSOLUTE_CAP);
        let total = rows.len();
        let windowed = rows.get(offset..).unwrap_or(&[]);
        let page = if limit == 0 { windowed } else { &windowed[..windowed.len().min(limit)] };
        let mut lines = Vec::with_capacity(page.len() + 1);
        for row in page {
            let mut line = format!("{}\t{}", row.name, type_name(row.kind));
            if meta {
                line.push_str(&meta_suffix(ctx, &row.path, None).await);
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
        if lines.is_empty() {
            return Ok(text_output(empty_message(ctx, &abs, raw, offset, total, hidden).await));
        }
        let text = lines.join("\n");
        if text.len() > LOCATOR_MAX_BYTES {
            let (kept, dropped) = cap_lines(&text, LOCATOR_MAX_BYTES);
            let shown = lines.len() - dropped;
            let marker = cap_marker(
                &format_cap_size(LOCATOR_MAX_BYTES),
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
) -> String {
    if offset > 0 && total > 0 {
        return format!("(no entries after offset={offset}; total={total}) path={raw}");
    }
    if hidden {
        return "(empty directory)".to_owned();
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
    let note = if has_hidden {
        "hidden=false (dotfiles present — pass hidden:true to include)"
    } else {
        "hidden=false"
    };
    format!("(no entries match filter) {note} path={raw}")
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

struct GlobRow {
    path: AbsPath,
    kind: EntryKind,
    size: u64,
    /// Nanoseconds since the epoch; 0 when unknown.
    mtime: u128,
    known: bool,
}

/// Node `FIND_STAT_DEADLINE_MS`: how long one candidate's metadata is awaited.
const FIND_STAT_DEADLINE: std::time::Duration = std::time::Duration::from_millis(1_000);

/// The name search Node runs for a glob-shaped `list` path: an rg inventory under the static base
/// (`--files --directories --no-ignore`, the noise-tree excludes, `--iglob` of the rest), filtered by
/// the compiled glob, newest first.
async fn glob_path_list(ctx: &ToolContext, raw: &str, hidden: bool, offset: usize, limit: usize) -> ToolOutcome {
    let (base, name_pattern) = extract_glob_base_directory(raw);
    let input = base.unwrap_or_else(|| ".".to_owned());
    let has_path = name_pattern.contains(['/', '\\']);
    let compiled = compile_simple_glob(&name_pattern).and_then(|whole| {
        let rest = name_pattern.strip_prefix("**/").map(compile_simple_glob).transpose()?;
        Ok((whole, rest))
    });
    let (whole, root_optional) = match compiled {
        Ok(pair) => pair,
        Err(message) => return Err(invalid("path", "glob", format!("Error: {message}"))),
    };
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
    // `rel` holds the path's components under the root; the glob sees the last one, or the whole
    // relative path when the pattern names directories.
    let matches = |parts: &[String]| {
        let subject = if has_path { parts.join("/") } else { parts.last().cloned().unwrap_or_default() };
        whole.is_match(&subject) || root_optional.as_ref().is_some_and(|r| r.is_match(&subject))
    };
    let walked = super::search::walk_inventory(ctx, &root, |entry| {
        let Ok(rel) = entry.path.as_path().strip_prefix(&root_path) else { return false };
        let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        if parts.is_empty() || !matches(&parts) {
            return false;
        }
        // rg descends a directory its `--iglob` matches; one it does not match is skipped under a
        // noise directory (`!**/<noise>/**`) and, without `hidden`, when it is a dotted name.
        (1..parts.len()).all(|depth| {
            let ancestor = &parts[..depth];
            matches(ancestor)
                || !(parts[..depth - 1].iter().any(|p| NOISE_DIRS.contains(&p.as_str()))
                    || (!hidden && ancestor[depth - 1].starts_with('.')))
        })
    }, FIND_ABSOLUTE_CAP)
    .await?;
    // Node `statPathsForMtime(candidates, …, 64, { deadlineMs: FIND_STAT_DEADLINE_MS })`: 64 stats at a time,
    // each bounded by the metadata deadline; one that fails or does not answer in time is listed with `-`.
    use futures::StreamExt as _;
    let stats: Vec<_> = guarded(
        ctx,
        "list",
        futures::stream::iter(walked.entries.into_iter().map(|entry| async move {
            let stat = tokio::time::timeout(FIND_STAT_DEADLINE, ctx.files.stat(ctx.io.interactive, entry.path.clone())).await;
            (entry, stat.ok().and_then(Result::ok))
        }))
        .buffered(64)
        .collect(),
    )
    .await?;
    let mut rows = Vec::with_capacity(stats.len());
    let mut unstatted = 0usize;
    for (entry, stat) in stats {
        match stat {
            Some(s) => rows.push(GlobRow {
                path: entry.path,
                kind: if s.kind == EntryKind::Dir { EntryKind::Dir } else { EntryKind::File },
                size: s.len,
                mtime: s.modified.and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos()),
                known: true,
            }),
            None => {
                unstatted += 1;
                rows.push(GlobRow { path: entry.path, kind: EntryKind::File, size: 0, mtime: 0, known: false });
            }
        }
    }
    rows.sort_by(|a, b| b.mtime.cmp(&a.mtime).then_with(|| fwd(a.path.as_path()).cmp(&fwd(b.path.as_path()))));
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
            let mtime = if row.mtime == 0 {
                "-".to_owned()
            } else {
                let at = UNIX_EPOCH + std::time::Duration::from_nanos(row.mtime as u64);
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
        lines.push(format!("... {unstatted} path(s) had no metadata within 1000ms; listed with \"-\" for size/date"));
    }
    if lines.is_empty() {
        return Ok(text_output("(no matches)"));
    }
    Ok(text_output(lines.join("\n")))
}
