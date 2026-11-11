//! `list`: one directory level, paged, optional metadata columns (T §3.2).

use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use mixdog_core_api::domain::common::AbsPath;
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
use crate::orch::util::spec_from_def;
use super::read::ReadTool;

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
        let raw = arg_str(&args, "path").unwrap_or(".");
        let hidden = arg_bool(&args, "hidden");
        let meta = arg_bool(&args, "meta");
        let offset = arg_u64(&args, "offset").unwrap_or(0) as usize;
        let limit = match arg_u64(&args, "limit") {
            Some(0) => 0,
            Some(n) => n.min(DEFAULT_PAGE) as usize,
            None => DEFAULT_PAGE as usize,
        };
        let abs = resolve_path(&ctx.cwd, raw)?;
        let stat = match guarded(ctx, "list", ctx.files.stat(ctx.io.interactive, abs.clone())).await? {
            Ok(s) => s,
            Err(e) if e.kind == FsErrorKind::NotFound || e.kind == FsErrorKind::NotADirectory => {
                return Ok(text_output(ReadTool::not_found(ctx, raw, &abs).await));
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
        // Node's `recordDirectoryWalkTelemetry` (`list-tool.mjs:61`): the walk's entries after the hidden and noise
        // filters, up to the cap; the trace row's `payload.integrity`.
        let integrity = serde_json::json!({
            "kind": "directory-walk",
            "status": if rows.is_empty() { "empty" } else { "complete" },
            "entriesVisited": rows.len(),
            "warnings": 0,
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
