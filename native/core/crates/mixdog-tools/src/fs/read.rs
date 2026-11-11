//! `read`: line windows, binary preview, images, office/PDF through the
//! extension pool, batches and glob surveys (T §3.1).

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::ext::ImageResizeError;
use mixdog_core_api::domain::ext::ImageResizer;
use mixdog_core_api::domain::ext::ResizedImage;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::fs::ReadRange;
use mixdog_core_api::domain::fs::WalkRequest;
use mixdog_core_api::domain::tool::ImageData;
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
use super::read_batch::*;
use super::read_legacy;
use super::read_paths;
use super::read_state::*;
use super::search::GLOB_ACCUM_CAP;
use super::search::glob_files;

const READ_SPEC: &str = include_str!("specs/read.json");
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// A notebook text output longer than this (UTF-16 units) is named by a `jq` hint instead (`IPYNB_OUTPUT_MAX_CHARS`).
const IPYNB_OUTPUT_MAX_CHARS: usize = 10_000;
const IPYNB_RANGE_REFUSAL: &str = "Error: range args (offset/limit/line) are not supported for .ipynb extraction — cells are not line-addressable; rename to .json or call read on a converted file for line-level access";
/// Node's inline-view cap, the refusal when there is no resizer (`MAX_IMAGE_BYTES`).
const IMAGE_MAX_BYTES: usize = 3_750_000;
/// The hard API ceiling on an inline image's base64 length (`API_IMAGE_MAX_BASE64_SIZE`).
const IMAGE_MAX_BASE64: usize = 5 * 1024 * 1024;
const GUARD_DEFAULT_LIMIT: u64 = 500;
const MAX_WINDOW: i64 = 100_000;
const PUBLIC_BATCH_LIMIT: usize = 10;
/// A file over this many bytes is streamed, not buffered (`READ_STREAM_RANGE_MIN_BYTES`).
const READ_STREAM_RANGE_MIN_BYTES: u64 = 128 * 1024;
/// One line is collected up to this many bytes (`READ_MAX_LINE_COLLECT_BYTES`).
const READ_MAX_LINE_COLLECT_BYTES: usize = OUTPUT_MAX_BYTES;
const READ_MAX_OUTPUT_BYTES: usize = OUTPUT_MAX_BYTES;
/// A glob survey shares this many output bytes.
const SURVEY_BUDGET: usize = 10 * 1024;
/// A past-the-cap file is read this many bytes at a time.
const HUGE_CHUNK: u64 = 1024 * 1024;
const GLOB_SURVEY_LINES: u64 = 25;
const GLOB_SURVEY_FILES: usize = 10;
const MAX_RENDERED_LINE_CHARS: usize = 2_000;
const BINARY_PREVIEW_BYTES: usize = 256;
/// Fixed entry cap of the "same filename elsewhere" diagnostic scan.
const NEAR_SCAN_ENTRIES: usize = 20_000;

pub struct ReadTool {
    spec: ToolSpec,
    ext: Option<Arc<dyn ExtPool>>,
    /// The image resizer; `None` reads as Node without `sharp`.
    images: Option<Arc<dyn ImageResizer>>,
    /// What the session remembers of its reads; `None` is a read with no memory.
    state: Option<Arc<ReadState>>,
}

impl ReadTool {
    /// The read state this tool shares with `edit` and `apply_patch`, keyed by the call's thread.
    #[must_use]
    pub fn with_state(mut self, state: Arc<ReadState>) -> Self {
        self.state = Some(state);
        self
    }

    pub fn new(ext: Option<Arc<dyn ExtPool>>, images: Option<Arc<dyn ImageResizer>>) -> Self {
        Self {
            spec: spec_from_def(READ_SPEC, true, &[]),
            ext,
            images,
            state: None,
        }
    }
}

/// One requested window; `offset` is 0-based. `ranged` is Node's `hasRangeArgs` (the call named an
/// offset or a limit, so the answer carries a window footer and no smart elision), `full` its
/// `full:true`, and `base` the coordinate base of the continuation offsets the answer names:
/// 1 for the public `file_path` form, 0 for the executor's own `path`.
struct Entry {
    path: String,
    offset: u64,
    limit: u64,
    ranged: bool,
    full: bool,
    base: u64,
}

/// What a read saw of a file, for the session's read state: the identity it read and what that
/// read gives a later one to rely on.
#[derive(Clone, Debug)]
struct Observed {
    path: String,
    version: FileVersion,
    meta: SnapshotMeta,
}

/// One entry's result: text, or text plus media parts.
#[derive(Default)]
struct Body {
    parts: Vec<ToolPart>,
    /// An image read's result (Node's structured `{ content }`), which a batch keeps as blocks.
    rich: bool,
    /// An answer Node's caller takes for a failed call (the notebook extractor's `Error:` strings).
    error: bool,
    observed: Option<Observed>,
}

impl Body {
    fn text(s: impl Into<String>) -> Self {
        Self {
            parts: vec![ToolPart::Text(s.into())],
            ..Self::default()
        }
    }
    fn first_text(&self) -> &str {
        match self.parts.first() {
            Some(ToolPart::Text(t)) => t,
            _ => "",
        }
    }
    fn failed(&self) -> bool {
        is_error_text(self.first_text())
    }
}

/// How a window is read: alone (`raw` keeps its numbered rows, as a nested read does; `suppress`
/// never answers `[file unchanged]`), or as one child of a batch under its share of the output
/// budget.
#[derive(Clone, Copy)]
enum Mode {
    Single { max_output: usize, raw: bool, suppress: bool },
    Child { max_output: usize },
}

impl Mode {
    fn max_output(self) -> usize {
        match self {
            Self::Single { max_output, .. } | Self::Child { max_output } => max_output,
        }
    }
    fn suppress(self) -> bool {
        match self {
            Self::Single { suppress, .. } => suppress,
            Self::Child { .. } => true,
        }
    }
    fn raw(self) -> bool {
        matches!(self, Self::Single { raw: true, .. })
    }
    fn force_stream(self) -> bool {
        matches!(self, Self::Child { .. })
    }
}
/// The public arguments, normalized the way `normalizePublicReadTargets` does: every window is
/// explicit, with a 0-based offset.
struct Public {
    single: bool,
    entries: Vec<BEntry>,
    /// Distinct files past the per-call cap, named to the caller.
    skipped: Vec<String>,
    pages: Option<String>,
}

const WINDOW_RANGE_TEXT: &str = "offset must be an integer >= 1 and limit an integer from 1 to 100000";

/// A JSON number that is an integer (JS `Number.isInteger`).
fn as_int(v: &JsonValue) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.is_finite() && f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15).map(|f| f as i64))
}

/// `windowValue`/`limitValue`: the value, or the fallback when it is absent (or, for a limit, 0).
/// `None` is a value that is not an integer.
fn window_value(v: Option<&JsonValue>, fallback: i64, zero_is_unset: bool) -> Option<i64> {
    match v {
        None => Some(fallback),
        Some(v) => as_int(v).map(|n| if zero_is_unset && n == 0 { fallback } else { n }),
    }
}

fn valid_window(offset: Option<i64>, limit: Option<i64>) -> Option<(u64, u64)> {
    match (offset, limit) {
        (Some(o), Some(l)) if o >= 1 && (1..=MAX_WINDOW).contains(&l) => Some(((o - 1) as u64, l as u64)),
        _ => None,
    }
}

fn parse_public(args: &JsonValue) -> Result<Public, ToolError> {
    let bad = |field: &str, reason: &str, text: String| invalid(field, reason, format!("Error: {text}"));
    // `normalizePublicReadTargets`: the public form is `file_path`; the executor's own `path`
    // (see `read_legacy`) beside it is refused. A call without `file_path` never reaches here.
    let Some(raw) = args.get("file_path") else {
        return Err(invalid("file_path", "required", "Error: read requires \"path\" (or alias file_path)."));
    };
    if args.get("path").is_some() {
        return Err(bad("path", "both", "read accepts file_path or legacy path, not both".to_owned()));
    }
    let (targets, batch): (Vec<&JsonValue>, bool) = match raw {
        JsonValue::Array(items) => (items.iter().collect(), true),
        JsonValue::String(_) => (vec![raw], false),
        _ => return Err(bad("file_path", "type", "read arg \"file_path\" must be a path string or an array of targets".to_owned())),
    };
    if targets.is_empty() {
        return Err(bad("file_path", "empty", "read arg \"file_path\" must contain at least 1 target".to_owned()));
    }
    let range = || bad("offset", "range", format!("read {WINDOW_RANGE_TEXT}"));
    let default_offset = window_value(args.get("offset"), 1, false);
    let default_limit = window_value(args.get("limit"), GUARD_DEFAULT_LIMIT as i64, true);
    if valid_window(default_offset, default_limit).is_none() {
        return Err(range());
    }
    let mut entries = Vec::new();
    for (index, target) in targets.iter().enumerate() {
        let shape = || bad("file_path", "target", format!("read target {} must be a path string or {{file_path, offset?, limit?}}", index + 1));
        let (path, offset, limit) = match target {
            JsonValue::String(s) => (s.as_str(), None, None),
            JsonValue::Object(o) => {
                if o.keys().any(|k| !matches!(k.as_str(), "file_path" | "offset" | "limit")) {
                    return Err(shape());
                }
                match o.get("file_path").and_then(JsonValue::as_str) {
                    Some(p) => (p, o.get("offset"), o.get("limit")),
                    None => return Err(shape()),
                }
            }
            _ => return Err(shape()),
        };
        if path.trim().is_empty() {
            return Err(shape());
        }
        let offset = window_value(offset, default_offset.expect("validated"), false);
        let limit = window_value(limit, default_limit.expect("validated"), true);
        let Some((offset, limit)) = valid_window(offset, limit) else {
            return Err(bad("offset", "range", format!("read target {} {WINDOW_RANGE_TEXT}", index + 1)));
        };
        entries.push(BEntry { path: path.to_owned(), offset: Some(offset as f64), limit: Some(limit as f64), ..BEntry::default() });
    }
    // The cap counts distinct files, not windows; files past it are named to the caller.
    let mut kept: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for e in &entries {
        if kept.contains(&e.path) {
            continue;
        }
        if kept.len() < PUBLIC_BATCH_LIMIT {
            kept.push(e.path.clone());
        } else if !skipped.contains(&e.path) {
            skipped.push(e.path.clone());
        }
    }
    entries.retain(|e| kept.contains(&e.path));
    // `executeModeRead`: the single form keeps its `mode` and `n`; its window (always present here) then drops a
    // head/tail/summary glance, while count and hex still answer by their own tools.
    if !batch && let Some(e) = entries.first_mut() {
        e.mode = arg_str(args, "mode").map(str::to_owned);
        e.n = args.get("n").filter(|v| !v.is_null()).cloned();
    }
    Ok(Public { single: !batch, entries, skipped, pages: arg_str(args, "pages").map(str::to_owned) })
}

#[async_trait]
impl Tool for ReadTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        self.settle_wsl(ctx).await;
        let mut args = args;
        if let JsonValue::Object(map) = &mut args {
            self.split_joined_path_scopes(ctx, map).await?;
            read_legacy::prepare(map);
        }
        if args.get("file_path").is_none() {
            return self.call_legacy(ctx, args).await;
        }
        let mut public = parse_public(&args)?;
        for e in &mut public.entries {
            e.path = strip_line_coordinate(ctx, &e.path).await?;
        }
        if let Some(state) = &self.state {
            state.ensure_scope(&scope_of(ctx)).await;
        }
        if public.single {
            let e = public.entries.remove(0);
            return self.run_top(ctx, e, 1, public.pages.as_deref()).await;
        }
        let results = self.pipeline(ctx, public.entries, true, READ_MAX_OUTPUT_BYTES, true, 1).await?;
        if args.get("reject_partial") == Some(&JsonValue::Bool(true)) && is_rejected(&results) {
            return text_output(rejected(&results));
        }
        if results.iter().any(|r| matches!(r.body, CBody::Rich { .. })) {
            return Ok(ToolOutput { parts: render_rich(&results), ..ToolOutput::default() });
        }
        let mut text = render_text(&results);
        if !public.skipped.is_empty() {
            text.push_str(&format!(
                "\n[skipped {} more file(s) over the per-call limit: {} — read them in another call]",
                public.skipped.len(),
                public.skipped.join(", ")
            ));
        }
        Ok(ToolOutput { parts: vec![ToolPart::Text(rows_for_model(&text))], ..ToolOutput::default() })
    }
}

fn text_output(text: String) -> ToolOutcome {
    Ok(ToolOutput { parts: vec![ToolPart::Text(text)], ..ToolOutput::default() })
}

/// `normalizeInputPath`: trimmed, control characters dropped, `~` expanded, NFC.
fn normalize_input_path(p: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let mut out: String = mixdog_js::js_trim(p).chars().filter(|c| !matches!(*c, '\u{0}'..='\u{1f}' | '\u{7f}')).collect();
    if (out == "~" || out.starts_with("~/") || out.starts_with("~\\"))
        && let Some(home) = read_paths::home_dir()
    {
        out = format!("{home}{}", &out[1..]);
    }
    read_paths::host_spelling(&out, read_paths::Host::current()).nfc().collect()
}

/// `hasLineCoordinate`: the path names a `#L5` / `:5-7` coordinate.
fn has_line_coordinate(path: &str) -> bool {
    static COORD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    COORD.get_or_init(|| regex::Regex::new(r"(?i)(?:#L\d+|:\d+(?:-\d+)?(?::|$))").expect("a fixed pattern")).is_match(path)
}

/// `parseLineLimitArg`: a missing limit is the default, `0` is no limit.
fn limit_arg(v: Option<f64>, default: u64) -> u64 {
    match v {
        None => default,
        Some(n) if n == 0.0 => u64::MAX,
        Some(n) => (n.trunc().max(1.0)) as u64,
    }
}

/// The calls that name the executor's own `path`: Node's `guardRead`, then `executeReadToolBody`.
impl ReadTool {
    async fn call_legacy(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let kind = read_legacy::describe_type(&args);
        let JsonValue::Object(mut map) = args else {
            let text = if kind == "null" {
                "Error: read requires arguments object (got null)".to_owned()
            } else {
                format!("Error: read arguments must be an object (got {kind})")
            };
            return Err(invalid("args", "type", text));
        };
        read_legacy::guard_read(&mut map).map_err(|text| invalid("path", "guard", text))?;
        if let Some(state) = &self.state {
            state.ensure_scope(&scope_of(ctx)).await;
        }
        match map.get("path").cloned() {
            Some(JsonValue::String(raw)) => {
                let be = BEntry {
                    path: raw,
                    mode: map.get("mode").and_then(JsonValue::as_str).map(str::to_owned),
                    n: map.get("n").filter(|v| !v.is_null()).cloned(),
                    offset: map.get("offset").and_then(JsonValue::as_f64),
                    limit: map.get("limit").and_then(JsonValue::as_f64),
                    full: map.get("full").and_then(JsonValue::as_bool),
                    ..BEntry::default()
                };
                self.run_top(ctx, be, 0, map.get("pages").and_then(JsonValue::as_str)).await
            }
            Some(JsonValue::Array(items)) => self.legacy_batch(ctx, &map, &items).await,
            other => {
                let got = read_legacy::describe_type(&other.unwrap_or(JsonValue::Null));
                Err(invalid("path", "type", format!("Error: read arg \"path\" must be string, string[], or object[] (got {got})")))
            }
        }
    }

    /// `executeBatchRead` over a `path` array. Region objects (`batchEntriesFromArgs` /
    /// `objectBatchEntry`) carry their own options and are merged and coalesced; a string, or an
    /// object met after a string, takes the call's.
    async fn legacy_batch(&self, ctx: &ToolContext, map: &read_legacy::Obj, items: &[JsonValue]) -> ToolOutcome {
        let object = matches!(items.first(), Some(JsonValue::Object(_)));
        let mut entries = Vec::with_capacity(items.len());
        for item in items {
            let pick = |k: &str| -> Option<&JsonValue> {
                if object { item.get(k) } else { map.get(k) }.filter(|v| !v.is_null())
            };
            let (raw_path, alias) = match item {
                JsonValue::Object(o) => match (o.get("path").and_then(JsonValue::as_str), o.get("file_path").and_then(JsonValue::as_str)) {
                    (Some(p), _) => (p, false),
                    (None, Some(p)) => (p, !p.is_empty()),
                    (None, None) => ("", false),
                },
                JsonValue::String(s) if !object => (s.as_str(), false),
                _ => ("", false),
            };
            let mode = pick("mode").and_then(JsonValue::as_str).map(str::to_owned);
            let mut offset = pick("offset").and_then(JsonValue::as_f64);
            let mut limit = pick("limit").and_then(JsonValue::as_f64);
            // A per-entry `file_path` is 1-based, like the public form.
            if object && alias && let Some(o) = offset.filter(|o| o.is_finite() && *o > 0.0) {
                offset = Some(o.trunc() - 1.0);
            }
            let mut path = normalize_input_path(raw_path);
            if let Some((stripped, start, end)) = line_coordinate(ctx, &path).await? {
                if matches!(mode.as_deref(), None | Some("full")) && offset.is_none() {
                    offset = Some((start as f64 - 1.0).max(0.0));
                    if limit.is_none() {
                        limit = Some((end.unwrap_or(start) as f64 - start as f64 + 1.0).max(1.0));
                    }
                }
                path = stripped;
            }
            entries.push(BEntry {
                path,
                mode,
                n: pick("n").cloned(),
                offset,
                limit,
                full: pick("full").and_then(JsonValue::as_bool),
                ..BEntry::default()
            });
        }
        let results = self.pipeline(ctx, entries, object, READ_MAX_OUTPUT_BYTES, true, 0).await?;
        if map.get("reject_partial") == Some(&JsonValue::Bool(true)) && is_rejected(&results) {
            return text_output(rejected(&results));
        }
        if results.iter().any(|r| matches!(r.body, CBody::Rich { .. })) {
            return Ok(ToolOutput { parts: render_rich(&results), ..ToolOutput::default() });
        }
        text_output(rows_for_model(&render_text(&results)))
    }

    /// `isWSL`, once: the environment, else the kernel's `/proc/version`.
    async fn settle_wsl(&self, ctx: &ToolContext) {
        if read_paths::wsl_known() {
            return;
        }
        let version = if cfg!(target_os = "linux") {
            match AbsPath::new("/proc/version") {
                Some(path) => match ctx.files.read(ctx.io.interactive, path, ReadRange::default()).await {
                    Ok(b) => Some(String::from_utf8_lossy(&b.bytes).into_owned()),
                    Err(_) => None,
                },
                None => None,
            }
        } else {
            None
        };
        read_paths::set_wsl(version.as_deref());
    }
    /// `splitJoinedPathScopes`: one string that joins several existing paths with commas or
    /// whitespace is those paths, when every piece lies strictly inside the working directory.
    async fn split_joined_path_scopes(&self, ctx: &ToolContext, map: &mut read_legacy::Obj) -> Result<(), ToolError> {
        const LIMIT: usize = 10;
        let refuse = |text: String| invalid("path", "joined", text);
        let real = |path: std::path::PathBuf| async move {
            mixdog_workspace::lanes::run(ctx.io.interactive, &ctx.cancel, move || mixdog_workspace::pathguard::canonical(&path).ok())
                .await
                .ok()
                .flatten()
        };
        for key in ["path", "file_path"] {
            let Some(JsonValue::String(value)) = map.get(key) else { continue };
            let value = value.clone();
            if !value.trim().contains(|c: char| c == ',' || mixdog_js::is_js_space(c)) || exists(ctx, &normalize_input_path(&value)).await {
                continue;
            }
            let pieces: Vec<String> = value.split(|c: char| c == ',' || mixdog_js::is_js_space(c)).filter(|p| !p.is_empty()).map(str::to_owned).collect();
            if pieces.len() < 2 {
                continue;
            }
            let mut all_exist = true;
            for piece in &pieces {
                all_exist &= exists(ctx, &normalize_input_path(piece)).await;
            }
            if !all_exist {
                continue;
            }
            // Containment is judged on the real targets: a link that leaves the directory is outside.
            let root = real(ctx.cwd.as_path().to_path_buf()).await;
            let mut inside = true;
            for piece in &pieces {
                let piece = normalize_input_path(piece);
                let target = match (&root, piece.as_str()) {
                    (_, "." | "..") | (None, _) => None,
                    (Some(_), _) => match resolve_path(&ctx.cwd, &piece) {
                        Ok(abs) => real(abs.as_path().to_path_buf()).await,
                        Err(_) => None,
                    },
                };
                inside &= match (&root, target) {
                    (Some(root), Some(target)) => target != *root && mixdog_workspace::pathguard::is_within(root, &target),
                    _ => false,
                };
            }
            if !inside {
                return Err(refuse(format!(
                    "Error: read arg \"{key}\" joins several paths in one string, and one is \".\", \"..\", a parent of the working directory or outside it, so it is not split automatically. To pass several paths, send an array (path[]), not a comma- or space-joined string."
                )));
            }
            if pieces.len() > LIMIT {
                return Err(refuse(format!(
                    "Error: read arg \"{key}\" joins {} paths in one string ({} given, max {LIMIT}); split or pass the parent directory.",
                    pieces.len(),
                    pieces.len()
                )));
            }
            map.insert(key.to_owned(), JsonValue::Array(pieces.into_iter().map(JsonValue::String).collect()));
        }
        Ok(())
    }
    /// `executeHeadTool` / `executeTailTool` / `executeWcTool` / `executeSummaryTool` /
    /// `executeHexTool` over a file read whole: the numbered text a mode answers with.
    async fn glance_text(&self, ctx: &ToolContext, path: &str, mode: &str, n: Option<&JsonValue>, offset: Option<f64>, seen: &mut Option<Observed>) -> Result<String, ToolError> {
        if let Some(reason) = path_string_guard(path) {
            return Ok(format!("Error: {reason}: {}", super::patch_guard::normalize_output_path(path)));
        }
        let abs = resolve_path(&ctx.cwd, path)?;
        if let Some(reason) = path_string_guard(&fwd(abs.as_path())) {
            return Ok(format!("Error: {reason}: {}", fwd(abs.as_path())));
        }
        let shown = display_path(abs.as_path(), &ctx.cwd);
        let named = path.replace('\\', "/");
        let stat = match guarded(ctx, "read", ctx.files.stat(ctx.io.interactive, abs.clone())).await? {
            Ok(s) => s,
            Err(err) if err.kind == FsErrorKind::NotFound || err.kind == FsErrorKind::NotADirectory => {
                // The summary reader words the missing path relative to the working directory.
                return Ok(Self::glance_not_found(ctx, &abs, mode == "summary").await);
            }
            Err(err) => return Err(fs_failure(&err, &shown)),
        };
        match stat.kind {
            EntryKind::Dir => return Ok("Error: EISDIR: illegal operation on a directory, read".to_owned()),
            EntryKind::Special => {
                return Ok(format!("Error: cannot read special file (FIFO / character / block device / socket): {path}"));
            }
            _ => {}
        }
        let key_path = fwd(abs.as_path());
        let version = FileVersion::of(&stat);
        let mut observe = |meta: SnapshotMeta| {
            *seen = version.map(|v| Observed { path: key_path.clone(), version: v, meta });
        };
        if mode == "hex" {
            let count = read_legacy::mode_count(n, 256, 16, 8192) as u64;
            let from = offset.filter(|o| o.is_finite() && *o > 0.0).map_or(0, |o| o.trunc() as u64);
            let bytes = read_range(ctx, &abs, &shown, from, count).await?;
            observe(SnapshotMeta { ranges: Some(Vec::new()), ..SnapshotMeta::new("read_hex") });
            return Ok(read_legacy::hex_text(&named, &bytes, from, stat.len));
        }
        if stat.len > MAX_FILE_BYTES {
            return self.glance_large(ctx, &abs, &shown, &named, mode, n, stat.len, &mut observe).await;
        }
        let bytes = match guarded(ctx, "read", ctx.files.read(ctx.io.interactive, abs.clone(), ReadRange::default())).await? {
            Ok(b) => b.bytes,
            Err(err) => return Err(fs_failure(&err, &shown)),
        };
        let content = match decode_for_read(&bytes) {
            ReadText::Binary => return Ok(format!("Error: file appears to be binary (contains null bytes): {named}")),
            ReadText::Text { text, utf16: true } => text,
            ReadText::Text { utf16: false, .. } => {
                let body = bytes.strip_prefix(&[0xef, 0xbb, 0xbf][..]).unwrap_or(&bytes);
                match std::str::from_utf8(body) {
                    Ok(text) => text.to_owned(),
                    Err(_) => {
                        return Ok("Error: invalid UTF-8 in text file: The encoded data was not valid for encoding utf-8".to_owned());
                    }
                }
            }
        };
        let streamed = stat.len > READ_STREAM_RANGE_MIN_BYTES;
        let window = |rows: (String, Option<read_legacy::Seen>), source: &str, observe: &mut (dyn FnMut(SnapshotMeta) + Send)| {
            if let Some(s) = rows.1 {
                let ranges = if s.whole { vec![LineRange::WHOLE] } else { vec![LineRange { start: s.start, end: Some(s.end) }] };
                observe(SnapshotMeta { ranges: Some(ranges), content_hash: s.whole.then(|| hash_text(&content)), file_line_count: Some(s.total), ..SnapshotMeta::new(source) });
            }
            rows.0
        };
        Ok(match mode {
            "head" => window(read_legacy::head_rows(&content, read_legacy::mode_count(n, 20, 1, 2000) as usize), if streamed { "read_head_stream" } else { "read_head" }, &mut observe),
            "tail" => window(read_legacy::tail_rows(&content, read_legacy::mode_count(n, 20, 1, 2000) as usize), if streamed { "read_tail_window" } else { "read_tail" }, &mut observe),
            "count" => read_legacy::text_stats(&content, stat.len),
            _ => {
                observe(SnapshotMeta { ranges: Some(Vec::new()), ..SnapshotMeta::new("read_summary") });
                read_legacy::summary_text(&named, &content, stat.len, read_legacy::mode_count(n, 200, 1, 1000) as usize, &render_read_line)
            }
        })
    }

    /// The glance modes over a file past the buffered cap (`read-mode-tool.mjs`, `read-streaming.mjs`):
    /// head reads from the front, tail from a window at the end, count and summary by passes over the
    /// file; none holds the file. A UTF-16 file is refused.
    async fn glance_large(
        &self,
        ctx: &ToolContext,
        abs: &AbsPath,
        shown: &str,
        named: &str,
        mode: &str,
        n: Option<&JsonValue>,
        size: u64,
        observe: &mut (dyn FnMut(SnapshotMeta) + Send),
    ) -> Result<String, ToolError> {
        const CHUNK: u64 = 1024 * 1024;
        const TAIL_WINDOW_CAP: u64 = 4 * 1024 * 1024;
        let head = read_range(ctx, abs, shown, 0, size.min(64 * 1024)).await?;
        let tail = if size > head.len() as u64 && size > 4096 { read_range(ctx, abs, shown, size - 4096, 4096).await? } else { Vec::new() };
        let utf16 = utf16_bom(&head).is_some();
        if !utf16 && (head.contains(&0) || tail.contains(&0)) {
            return Ok(format!("Error: file appears to be binary (contains null bytes): {named}"));
        }
        if utf16 {
            return Ok(format!(
                "Error: UTF-16 file too large for this mode ({size} bytes exceeds {MAX_FILE_BYTES}-byte cap): {}",
                fwd(abs.as_path())
            ));
        }
        // The lines of the file, first to last, as `readline` gives them, until `visit` says stop.
        let count_lines = || async move {
            let (mut pos, mut lines, mut last) = (0_u64, 0_u64, None);
            while pos < size {
                let chunk = read_range(ctx, abs, shown, pos, CHUNK).await?;
                if chunk.is_empty() {
                    break;
                }
                pos += chunk.len() as u64;
                lines += chunk.iter().filter(|b| **b == b'\n').count() as u64;
                last = chunk.last().copied();
            }
            Ok::<u64, ToolError>(lines + u64::from(last.is_some_and(|b| b != b'\n')))
        };
        match mode {
            "head" => {
                let limit = read_legacy::mode_count(n, 20, 1, 2000) as usize;
                let (mut reader, mut lines, mut pos) = (read_legacy::LineReader::default(), Vec::new(), 0_u64);
                while pos < size && lines.len() < limit {
                    let chunk = read_range(ctx, abs, shown, pos, CHUNK).await?;
                    if chunk.is_empty() {
                        break;
                    }
                    pos += chunk.len() as u64;
                    reader.feed(&chunk, &mut lines, limit);
                }
                if lines.len() < limit {
                    reader.finish(&mut lines);
                }
                let rendered = lines
                    .iter()
                    .enumerate()
                    .map(|(i, l)| render_read_line(i as u64 + 1, if i == 0 { l.strip_prefix('\u{feff}').unwrap_or(l) } else { l }))
                    .collect::<Vec<_>>()
                    .join("\n");
                let out = read_legacy::cap_shell_output(&rendered);
                if out == rendered && !lines.is_empty() {
                    observe(SnapshotMeta { ranges: Some(vec![LineRange { start: 1, end: Some(lines.len() as u64) }]), ..SnapshotMeta::new("read_head_stream") });
                }
                Ok(out)
            }
            "tail" => {
                let target = read_legacy::mode_count(n, 20, 1, 2000) as usize;
                let mut window = size.min(4096.max(target as u64 * 256));
                let buf = loop {
                    let buf = read_range(ctx, abs, shown, size - window, window).await?;
                    let line_feeds = buf.iter().filter(|b| **b == b'\n').count();
                    if window >= size || line_feeds > target || window >= TAIL_WINDOW_CAP {
                        break buf;
                    }
                    window = size.min(TAIL_WINDOW_CAP).min(window * 2);
                };
                let (lines, _, capped) = read_legacy::large_tail_lines(&buf, size, target, TAIL_WINDOW_CAP);
                Ok(read_legacy::large_tail_text(&lines, capped, TAIL_WINDOW_CAP, &clip_line))
            }
            "count" => Ok(format!("lines\t{}\twords\t-\tbytes\t{size}\t(words skipped: file > cap)", count_lines().await?)),
            _ => {
                let limit = read_legacy::mode_count(n, 200, 1, 1000) as usize;
                let stats = format!("lines\t{}\twords\t-\tbytes\t{size}", count_lines().await?);
                observe(SnapshotMeta { ranges: Some(Vec::new()), ..SnapshotMeta::new("read_summary") });
                let (mut reader, mut symbols, mut pos, mut line_no) = (read_legacy::LineReader::default(), Vec::new(), 0_u64, 0_u64);
                'file: while pos < size {
                    let chunk = read_range(ctx, abs, shown, pos, CHUNK).await?;
                    if chunk.is_empty() {
                        break;
                    }
                    pos += chunk.len() as u64;
                    let mut lines = Vec::new();
                    reader.feed(&chunk, &mut lines, usize::MAX);
                    for line in lines {
                        line_no += 1;
                        let line = if line_no == 1 { line.strip_prefix('\u{feff}').unwrap_or(&line).to_owned() } else { line };
                        if let Some(row) = read_legacy::symbol_row(line_no, &line, &render_read_line) {
                            symbols.push(row);
                            if symbols.len() >= limit {
                                break 'file;
                            }
                        }
                    }
                }
                if symbols.len() < limit {
                    let mut last = Vec::new();
                    reader.finish(&mut last);
                    for line in last {
                        if let Some(row) = read_legacy::symbol_row(line_no + 1, &line, &render_read_line) {
                            symbols.push(row);
                        }
                    }
                }
                Ok(read_legacy::summary_render(named, &stats, symbols, limit))
            }
        }
    }
    /// `openTextPathForReadMeta`'s missing-file message: the stat error, a near name, the siblings.
    async fn glance_not_found(ctx: &ToolContext, abs: &AbsPath, relative: bool) -> String {
        let cwd = fwd(ctx.cwd.as_path());
        // The summary reader normalizes the message a second time, against the working directory.
        let first = read_paths::redact(&fwd(abs.as_path()), None);
        let named = |p: &str| if relative { read_paths::redact(p, Some(&cwd)) } else { p.to_owned() };
        let at = if relative && (first.starts_with('/') || first.as_bytes().get(1) == Some(&b':')) { read_paths::redact(&first, Some(&cwd)) } else { first };
        let hint = match Self::similar_sibling(ctx, abs).await {
            Some(similar) => format!(" Did you mean \"{}\"?", named(&fwd(similar.as_path()))),
            None => String::new(),
        };
        let mut siblings: Vec<String> = match abs.as_path().parent().and_then(|p| AbsPath::new(p.to_path_buf())) {
            Some(parent) => match ctx.files.list_dir(ctx.io.interactive, parent).await {
                Ok(entries) => entries
                    .iter()
                    .filter_map(|e| e.path.as_path().file_name().map(|n| n.to_string_lossy().into_owned()))
                    .filter(|n| !n.starts_with('.'))
                    .collect(),
                Err(_) => Vec::new(),
            },
            None => Vec::new(),
        };
        siblings.sort_by_key(|n| read_paths::dir_order_key(n));
        siblings.truncate(12);
        format!("Error: ENOENT: no such file or directory, stat '{at}'{hint} Siblings: [{}].", siblings.join(", "))
    }
}

/// A session's key in the read state: the call's thread id (Node's `sessionId`).
fn scope_of(ctx: &ToolContext) -> String {
    ctx.thread_id.to_string()
}

const GLOB_CAP_NOTE: &str = "[glob expansion capped at 10 files (newest first); narrow the pattern for the rest]";

/// The aggregate of a glob survey: the batch, then the cap note when more files matched.
fn survey_parts(results: &[Resolved], capped: bool) -> Vec<ToolPart> {
    if results.iter().any(|r| matches!(r.body, CBody::Rich { .. })) {
        let mut parts = render_rich(results);
        if capped {
            parts.push(ToolPart::Text(GLOB_CAP_NOTE.to_owned()));
        }
        return parts;
    }
    let mut text = render_text(results);
    if capped {
        text.push_str(&format!("\n{GLOB_CAP_NOTE}"));
    }
    vec![ToolPart::Text(rows_for_model(&text))]
}

/// len bytes of a file from offset.
async fn read_range(ctx: &ToolContext, abs: &AbsPath, shown: &str, offset: u64, len: u64) -> Result<Vec<u8>, ToolError> {
    match guarded(ctx, "read", ctx.files.read(ctx.io.interactive, abs.clone(), ReadRange { offset, max_len: Some(len) })).await? {
        Ok(b) => Ok(b.bytes),
        Err(err) => Err(fs_failure(&err, shown)),
    }
}

async fn exists(ctx: &ToolContext, raw: &str) -> bool {
    let Ok(abs) = resolve_path(&ctx.cwd, raw) else { return false };
    ctx.files.stat(ctx.io.interactive, abs).await.is_ok()
}

/// `normaliseReadLineWindowArgs`' path half: `file.rs:12` / `file.rs#L12-20` names `file.rs` when
/// only that exists. The window itself is already explicit.
async fn strip_line_coordinate(ctx: &ToolContext, raw: &str) -> Result<String, ToolError> {
    Ok(line_coordinate(ctx, raw).await?.map_or_else(|| raw.to_owned(), |c| c.0))
}

/// `resolveExistingPathLineCoordinate` / `normaliseReadLineWindowArgs`: `file.rs:12-20` names
/// `file.rs` and its lines (start, then the end when it is not before the start) when only
/// `file.rs` exists. An inverted range is refused.
async fn line_coordinate(ctx: &ToolContext, raw: &str) -> Result<Option<(String, u64, Option<u64>)>, ToolError> {
    static HASH: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static COLON: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let hash = HASH.get_or_init(|| regex::Regex::new(r"(?i)^(.+?)#L(\d+)(?:-L?(\d+))?(?:\b.*)?$").expect("a fixed pattern"));
    let colon = COLON.get_or_init(|| regex::Regex::new(r"^(.+):(\d+)(?:-(\d+))?(?::.*)?$").expect("a fixed pattern"));
    let text = raw.trim();
    let Some(m) = hash.captures(text).or_else(|| colon.captures(text)) else { return Ok(None) };
    let positive = |s: &str| s.parse::<u64>().ok().filter(|n| *n > 0);
    let Some(line_no) = positive(&m[2]) else { return Ok(None) };
    if m[1].is_empty() || exists(ctx, raw).await || !exists(ctx, &m[1]).await {
        return Ok(None);
    }
    let end = m.get(3).and_then(|e| positive(e.as_str()));
    if let Some(end) = end.filter(|end| *end < line_no) {
        let text = format!(
            "Error: inverted range in path \"{raw}\" — end ({end}) precedes start ({line_no}); use file:{end}-{line_no} or remove the range"
        );
        return Err(invalid("file_path", "range", text));
    }
    Ok(Some((m[1].to_owned(), line_no, end)))
}

type Pipeline<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Resolved>, ToolError>> + Send + 'a>>;

/// What a glob that names nothing real expands to.
enum Survey {
    /// Several files: a batch of them, and whether more matched than the cap.
    Many(Vec<Resolved>, bool),
    /// One file: Node's one-element `path` array is a plain string, so it is read alone.
    One(BEntry),
}

/// What a read makes of its request before any file is opened (`executeReadToolBody` after the
/// batch and survey shapes).
enum Plan {
    /// An answer that needs no file.
    Text(String),
    /// A glance mode over `path`.
    Glance { path: String, mode: String, n: Option<JsonValue>, offset: Option<f64> },
    /// A line window.
    Window(Entry),
}

impl ReadTool {
    /// One top-level file read: the answer, and what it taught the session.
    async fn single(&self, ctx: &ToolContext, e: &Entry, pages: Option<&str>, mode: Mode) -> ToolOutcome {
        let body = self.read_one(ctx, e, pages, mode).await?;
        // An image read's empty, corrupt and over-cap answers are Node's `isError` results; in a
        // batch the same body marks only its own entry (`[error]`).
        if body.error || (body.rich && body.failed()) {
            let reason = body.first_text().to_owned();
            return Err(fail(ToolErrorCode::Failed { reason: reason.clone() }, reason));
        }
        self.record(ctx, body.observed.as_ref());
        Ok(ToolOutput { parts: body.parts, ..ToolOutput::default() })
    }

    fn record(&self, ctx: &ToolContext, seen: Option<&Observed>) {
        if let (Some(state), Some(seen)) = (&self.state, seen) {
            state.record(Some(&scope_of(ctx)), &seen.path, Some(seen.version), seen.meta.clone());
        }
    }

    /// The URL refusal, the window-beats-mode rule, a `path:line` coordinate, and the glance modes.
    async fn plan(&self, ctx: &ToolContext, be: &BEntry) -> Result<Plan, ToolError> {
        static URL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        if URL.get_or_init(|| regex::Regex::new(r"(?i)^\s*https?://").expect("a fixed pattern")).is_match(&be.path) {
            return Ok(Plan::Text("Error: this is a URL; use web_fetch".to_owned()));
        }
        let path = normalize_input_path(&be.path);
        if path.is_empty() {
            return Ok(Plan::Text("Error: path is required.".to_owned()));
        }
        let mut mode = be.mode.as_deref();
        // A window (or a path:line coordinate) beats a glance mode that would read from a file end.
        if (be.offset.is_some() || be.limit.is_some() || has_line_coordinate(&path)) && matches!(mode, Some("head" | "tail" | "summary")) {
            mode = None;
        }
        let coordinate = line_coordinate(ctx, &path).await?;
        let (mut offset, mut limit) = (be.offset, be.limit);
        if let Some((_, start, end)) = &coordinate
            && matches!(mode, None | Some("full"))
            && offset.is_none()
        {
            offset = Some((*start as f64 - 1.0).max(0.0));
            if limit.is_none() {
                limit = Some((end.unwrap_or(*start) as f64 - *start as f64 + 1.0).max(1.0));
            }
        }
        let path = coordinate.map_or(path, |c| c.0);
        if let Some(mode @ ("head" | "tail" | "count" | "summary" | "hex")) = mode {
            return Ok(Plan::Glance { path, mode: mode.to_owned(), n: be.n.clone(), offset });
        }
        let full = be.full == Some(true);
        Ok(Plan::Window(Entry {
            path,
            offset: match offset {
                Some(n) if n.is_finite() && n > 0.0 => n.trunc() as u64,
                _ => 0,
            },
            limit: limit_arg(limit, if full { u64::MAX } else { 2000 }),
            ranged: offset.is_some() || limit.is_some(),
            full,
            base: 0,
        }))
    }

    /// One top-level read of `be`, or the survey of a glob that names no real file.
    async fn run_top(&self, ctx: &ToolContext, be: BEntry, base: u64, pages: Option<&str>) -> ToolOutcome {
        if has_glob_magic(&be.path) && !exists(ctx, &be.path).await {
            match self.survey(ctx, &be, base, SURVEY_BUDGET, true).await? {
                Some(Survey::Many(results, capped)) => {
                    return Ok(ToolOutput { parts: survey_parts(&results, capped), ..ToolOutput::default() });
                }
                Some(Survey::One(one)) => {
                    let mode = Mode::Single { max_output: SURVEY_BUDGET, raw: false, suppress: false };
                    return self.run_plan(ctx, &one, base, pages, mode).await;
                }
                None => {}
            }
        }
        let mode = Mode::Single { max_output: READ_MAX_OUTPUT_BYTES, raw: false, suppress: false };
        self.run_plan(ctx, &be, base, pages, mode).await
    }

    async fn run_plan(&self, ctx: &ToolContext, be: &BEntry, base: u64, pages: Option<&str>, mode: Mode) -> ToolOutcome {
        match self.plan(ctx, be).await? {
            Plan::Text(text) => text_output(text),
            Plan::Glance { path, mode, n, offset } => {
                let mut seen = None;
                let text = self.glance_text(ctx, &path, &mode, n.as_ref(), offset, &mut seen).await?;
                self.record(ctx, seen.as_ref());
                text_output(rows_for_model(&text))
            }
            Plan::Window(mut e) => {
                e.base = base;
                self.single(ctx, &e, pages, mode).await
            }
        }
    }

    /// `readGlobSurvey`: a magic path that names nothing becomes the batch of its newest matches,
    /// each read as the call asked (its mode, `n`, `full` and offset; the limit tightened).
    /// `None` when it matches nothing, so the raw pattern gets the single-read answer.
    async fn survey(&self, ctx: &ToolContext, be: &BEntry, base: u64, cap: usize, record: bool) -> Result<Option<Survey>, ToolError> {
        let (root, pattern) = split_glob(&be.path);
        let root = resolve_path(&ctx.cwd, &root)?;
        let (mut files, _, _) = glob_files(ctx, &root, &[pattern], false, Some(GLOB_ACCUM_CAP)).await?;
        if files.is_empty() {
            return Ok(None);
        }
        files.sort_by(|a, b| b.1.unwrap_or(0).cmp(&a.1.unwrap_or(0)).then_with(|| a.0.cmp(&b.0)));
        let capped = files.len() > GLOB_SURVEY_FILES;
        files.truncate(GLOB_SURVEY_FILES);
        let limit = match be.limit {
            Some(l) if l.is_finite() && l > 0.0 => l.trunc().min(GLOB_SURVEY_LINES as f64),
            _ => GLOB_SURVEY_LINES as f64,
        };
        let mut entries: Vec<BEntry> = files
            .into_iter()
            .map(|(p, _)| BEntry {
                path: fwd(p.as_path()),
                mode: be.mode.clone(),
                n: be.n.clone(),
                offset: be.offset,
                limit: Some(limit),
                full: be.full,
                ..BEntry::default()
            })
            .collect();
        if entries.len() == 1 {
            return Ok(Some(Survey::One(entries.remove(0))));
        }
        Ok(Some(Survey::Many(self.pipeline(ctx, entries, false, cap, record, base).await?, capped)))
    }

    /// The batch machinery (`executeBatchRead`): shape the entries, split the output budget over
    /// the distinct disk reads, read each, and cut every caller's window back out of its read.
    /// `object` entries (region objects, the public form) are merged and coalesced; a string batch
    /// is read as it stands. `record` says whether what the reads saw reaches the session.
    fn pipeline<'a>(&'a self, ctx: &'a ToolContext, entries: Vec<BEntry>, object: bool, cap: usize, record: bool, base: u64) -> Pipeline<'a> {
        Box::pin(async move {
            let key = |p: &str| match resolve_path(&ctx.cwd, p) {
                Ok(abs) => fwd(abs.as_path()),
                Err(_) => p.to_owned(),
            };
            let shown = |p: &str| match resolve_path(&ctx.cwd, p) {
                Ok(abs) => display_path(abs.as_path(), &ctx.cwd),
                Err(_) => p.to_owned(),
            };
            let (slots, firsts, map): (Vec<BEntry>, Vec<usize>, Vec<usize>) = if object {
                let slots = coalesce_object(merge_overlapping(entries, &key), &key);
                let (firsts, map) = dedupe(&slots);
                (slots, firsts, map)
            } else {
                let (firsts, map) = primary_reads(&entries, &key);
                (entries, firsts, map)
            };
            // The budget is split over all the disk reads first; they then run in path, then
            // window, order.
            let header_paths: Vec<&str> = if object {
                firsts.iter().map(|i| slots[*i].path.as_str()).collect()
            } else {
                slots.iter().map(|s| s.path.as_str()).collect()
            };
            let mut needs = Vec::with_capacity(firsts.len());
            for i in &firsts {
                let slot = &slots[*i];
                if slot.path.is_empty() {
                    needs.push(0.0);
                    continue;
                }
                let size = match resolve_path(&ctx.cwd, &slot.path) {
                    Ok(abs) => match ctx.files.stat(ctx.io.interactive, abs).await {
                        Ok(st) if matches!(st.kind, EntryKind::File) => Some(st.len),
                        _ => None,
                    },
                    Err(_) => None,
                };
                let limit = match slot.union {
                    Some((_, limit)) => limit,
                    None => slot.limit.filter(|l| l.is_finite() && *l > 0.0).map_or(0, |l| l.trunc() as u64),
                };
                needs.push(estimate_bytes(size, limit));
            }
            let allocated = allocate_budgets(&needs, body_budget(&header_paths, cap));
            let window_offset = |s: &BEntry| if s.is_full_mode() { s.line_window().0 } else { 0 };
            let mut order: Vec<usize> = (0..firsts.len()).collect();
            order.sort_by(|a, b| {
                let (x, y) = (&slots[firsts[*a]], &slots[firsts[*b]]);
                x.path.cmp(&y.path).then(window_offset(x).cmp(&window_offset(y))).then(a.cmp(b))
            });
            let mut bodies: Vec<Option<(CBody, Option<Observed>)>> = vec![None; firsts.len()];
            for at in order {
                let slot = &slots[firsts[at]];
                if slot.path.is_empty() {
                    bodies[at] = Some((CBody::Str("Error: path is required.".to_owned()), None));
                    continue;
                }
                let budget = allocated[at].max(256.0) as usize;
                // An object batch holds what its reads saw until the windows are cut back out.
                let (body, seen) = self.child(ctx, &slot.child(), base, READ_MAX_OUTPUT_BYTES.min(budget), object, record).await?;
                if !object && record {
                    self.record(ctx, seen.as_ref());
                }
                bodies[at] = Some((body, seen));
            }
            let resolved: Vec<Resolved> = slots
                .iter()
                .enumerate()
                .map(|(i, slot)| {
                    let producer = map[i];
                    let body = bodies[producer].clone().expect("every read ran").0;
                    let body = match &body {
                        CBody::Str(s) if object && slot.is_full_mode() && slot.needs_slice => {
                            let off = slot.orig_offset.map_or(0, |o| o.max(0.0) as u64);
                            let lim = match slot.orig_limit {
                                Some(l) if l == 0.0 => None,
                                Some(l) => Some(l.max(0.0) as u64),
                                None => Some(2000),
                            };
                            CBody::Str(slice_read_body(s, off, lim, base))
                        }
                        _ => body,
                    };
                    let source = if object { &slots[firsts[producer]] } else { slot };
                    let path = if source.path.is_empty() { "(missing-path)".to_owned() } else { shown(&source.path) };
                    Resolved {
                        path,
                        body,
                        producer,
                        mode: slot.mode.clone().unwrap_or_else(|| "full".to_owned()),
                        n: slot.n.as_ref().map(js_str),
                    }
                })
                .collect();
            if object && record {
                self.publish_batch(ctx, &resolved, &bodies);
            }
            Ok(resolved)
        })
    }

    /// `runBatchReadSnapshotPublication`: an object batch records, per file, the lines its callers
    /// were actually given; a read that gave no lines records what it saw by itself.
    fn publish_batch(&self, ctx: &ToolContext, resolved: &[Resolved], bodies: &[Option<(CBody, Option<Observed>)>]) {
        let mut corrections: Vec<(String, Vec<LineRange>)> = Vec::new();
        for r in resolved {
            let CBody::Str(text) = &r.body else { continue };
            if r.mode != "full" || is_error_text(text) {
                continue;
            }
            let Some((_, Some(seen))) = &bodies[r.producer] else { continue };
            let complete = seen.meta.ranges.clone().unwrap_or_else(|| vec![LineRange::WHOLE]);
            let given = intersect_ranges(&rendered_ranges(text), &complete);
            if given.is_empty() {
                continue;
            }
            match corrections.iter_mut().find(|(p, _)| *p == seen.path) {
                Some((_, ranges)) => ranges.extend(given),
                None => corrections.push((seen.path.clone(), given)),
            }
        }
        for (path, ranges) in &corrections {
            let producers: Vec<&Observed> = bodies
                .iter()
                .flatten()
                .filter_map(|(b, seen)| seen.as_ref().filter(|s| s.path == *path && matches!(b, CBody::Str(t) if !rendered_ranges(t).is_empty())))
                .collect();
            let Some(first) = producers.first() else { continue };
            if producers.iter().all(|s| same_version(&s.version, &first.version)) {
                let meta = SnapshotMeta {
                    ranges: Some(merge_ranges(ranges)),
                    replace_existing: true,
                    ..SnapshotMeta::new("read_batch_sliced")
                };
                if let Some(state) = &self.state {
                    state.record(Some(&scope_of(ctx)), path, Some(first.version), meta);
                }
            }
        }
        for (body, seen) in bodies.iter().flatten() {
            let rows = matches!(body, CBody::Str(t) if !rendered_ranges(t).is_empty());
            let error = matches!(body, CBody::Str(t) if is_error_text(t)) || matches!(body, CBody::Rich { failed: true, .. });
            if rows || error {
                continue;
            }
            if let Some(seen) = seen.as_ref().filter(|s| corrections.iter().all(|(p, _)| *p != s.path)) {
                self.record(ctx, Some(seen));
            }
        }
    }

    /// One batch entry through the child `read`: a failure is pasted into the aggregate as that
    /// entry's text, never aborting the batch. `defer` is an object batch, which records later.
    async fn child(&self, ctx: &ToolContext, be: &BEntry, base: u64, max_output: usize, defer: bool, record: bool) -> Result<(CBody, Option<Observed>), ToolError> {
        if has_glob_magic(&be.path) && !exists(ctx, &be.path).await {
            // What a nested glob's reads saw is dropped by an object batch, as Node's is.
            match self.survey(ctx, be, base, max_output.min(SURVEY_BUDGET), record && !defer).await? {
                Some(Survey::Many(results, capped)) => {
                    if results.iter().any(|r| matches!(r.body, CBody::Rich { .. })) {
                        return Ok((CBody::Rich { parts: survey_parts(&results, capped), failed: false }, None));
                    }
                    let mut text = render_text(&results);
                    if capped {
                        text.push_str(&format!("\n{GLOB_CAP_NOTE}"));
                    }
                    return Ok((CBody::Str(text), None));
                }
                Some(Survey::One(one)) => {
                    let mode = Mode::Single { max_output: max_output.min(SURVEY_BUDGET), raw: true, suppress: true };
                    let (body, seen) = self.child_plan(ctx, &one, base, mode).await?;
                    if record && !defer {
                        self.record(ctx, seen.as_ref());
                    }
                    return Ok((body, None));
                }
                None => {}
            }
        }
        self.child_plan(ctx, be, base, Mode::Child { max_output }).await
    }

    async fn child_plan(&self, ctx: &ToolContext, be: &BEntry, base: u64, mode: Mode) -> Result<(CBody, Option<Observed>), ToolError> {
        let pasted = |err: ToolError| match err.code {
            ToolErrorCode::Cancelled | ToolErrorCode::DeadlineExceeded { .. } => Err(err),
            _ => Ok((CBody::Str(err.message_for_model), None)),
        };
        let planned = match self.plan(ctx, be).await {
            Ok(planned) => planned,
            Err(err) => return pasted(err),
        };
        match planned {
            Plan::Text(text) => Ok((CBody::Str(text), None)),
            Plan::Glance { path, mode: glance, n, offset } => {
                // A glance mode records what it showed itself, in a batch as alone.
                let mut seen = None;
                let outcome = self.glance_text(ctx, &path, &glance, n.as_ref(), offset, &mut seen).await;
                self.record(ctx, seen.as_ref());
                match outcome {
                    Ok(text) => Ok((CBody::Str(text), None)),
                    Err(err) => pasted(err),
                }
            }
            Plan::Window(mut e) => {
                e.base = base;
                self.child_read(ctx, &e, mode).await
            }
        }
    }

    async fn child_read(&self, ctx: &ToolContext, e: &Entry, mode: Mode) -> Result<(CBody, Option<Observed>), ToolError> {
        match self.read_one(ctx, e, None, mode).await {
            Ok(body) => {
                let plain = body.parts.len() == 1 && matches!(body.parts[0], ToolPart::Text(_));
                let seen = body.observed.clone();
                if body.rich || !plain {
                    let failed = body.failed();
                    Ok((CBody::Rich { parts: body.parts, failed }, seen))
                } else {
                    Ok((CBody::Str(body.first_text().to_owned()), seen))
                }
            }
            Err(err) if matches!(err.code, ToolErrorCode::Cancelled | ToolErrorCode::DeadlineExceeded { .. }) => Err(err),
            Err(err) => Ok((CBody::Str(err.message_for_model), None)),
        }
    }

    async fn read_one(&self, ctx: &ToolContext, e: &Entry, pages: Option<&str>, mode: Mode) -> Result<Body, ToolError> {
        let raw = e.path.trim();
        if let Some(reason) = path_string_guard(raw) {
            return Ok(Body::text(format!("Error: {reason}: {}", super::patch_guard::normalize_output_path(raw))));
        }
        let abs = resolve_path(&ctx.cwd, raw)?;
        // The path as resolved against the working directory meets the same refusals.
        if let Some(reason) = path_string_guard(&fwd(abs.as_path())) {
            return Ok(Body::text(format!("Error: {reason}: {}", fwd(abs.as_path()))));
        }
        let shown = display_path(abs.as_path(), &ctx.cwd);
        let stat = match guarded(ctx, "read", ctx.files.stat(ctx.io.interactive, abs.clone())).await? {
            Ok(s) => s,
            Err(err) if err.kind == FsErrorKind::NotFound || err.kind == FsErrorKind::NotADirectory => {
                return Ok(Body::text(Self::not_found(ctx, raw, &abs).await));
            }
            // Windows refuses a wildcard in a name as an invalid name, where Node's stat says ENOENT.
            Err(err) if has_glob_magic(raw) && matches!(err.kind, FsErrorKind::Io { .. }) => {
                return Ok(Body::text(Self::not_found(ctx, raw, &abs).await));
            }
            Err(err) => return Err(fs_failure(&err, &shown)),
        };
        match stat.kind {
            EntryKind::Dir => return Ok(Body::text(self.directory_error(ctx, &abs, raw).await)),
            EntryKind::Special => {
                return Ok(Body::text(format!(
                    "Error: cannot read special file (FIFO / character / block device / socket): {shown}"
                )));
            }
            _ => {}
        }
        // A notebook goes to Node's extractor ahead of every cache (`readMediaFile`).
        if is_notebook(&stat, raw) {
            return self.notebook(ctx, e, &abs, stat.len, matches!(mode, Mode::Child { .. })).await;
        }
        let key_path = fwd(abs.as_path());
        let version = FileVersion::of(&stat);
        let scope =self.state.as_ref().map(|_| scope_of(ctx));
        let cacheable = stat.len <= CACHEABLE_BYTES;
        // A file this session has just edited, and read before the edit, is not sent again.
        if let (Some(state), Some(v), false, true) = (&self.state, version, mode.suppress(), cacheable) {
            if let Some(snap) = state.snapshot(scope.as_deref(), &key_path) {
                if is_mutation_source(&snap.source) && snap.body_delivered == Some(true) && same_version(&v, &snap.version) && covers_full_file(&snap) {
                    return Ok(Body::text(format!("[file unchanged: {shown}]")));
                }
            }
        }
        // Node answers an image before any size cap: by its extension, or for a path with none, by
        // its signature (a stored attachment).
        if matches!(stat.kind, EntryKind::File) {
            let by_extension = image_ext(raw);
            if by_extension.is_some() || (std::path::Path::new(raw).extension().is_none() && stat.len >= 5) {
                let bytes = match guarded(ctx, "read", ctx.files.read(ctx.io.interactive, abs.clone(), ReadRange::default())).await? {
                    Ok(b) => b.bytes,
                    Err(err) => return Err(fs_failure(&err, &shown)),
                };
                if let Some(format) = by_extension.or_else(|| sniffed_image(&bytes)) {
                    let display = if by_extension.is_some() { shown.as_str() } else { raw };
                    return self.image_body(ctx, display, bytes, format).await;
                }
            }
        }
        if stat.len > MAX_FILE_BYTES {
            return self.read_huge(ctx, e, &abs, &shown, &stat, version, mode).await;
        }
        let window_key = |v: u64| if e.ranged { v.to_string() } else { "d".to_owned() };
        let cache_key = version.map(|v| {
            format!(
                "read|{key_path}|{}|{}|{}|{}|{}|{}|base:{}|budget:{}",
                v.mtime_ms,
                v.ctime_ms.map_or_else(|| "-".to_owned(), |c| c.to_string()),
                v.size,
                window_key(e.offset),
                window_key(e.limit),
                if e.full { "f" } else { "s" },
                e.base,
                mode.max_output()
            )
        });
        let bytes = match guarded(
            ctx,
            "read",
            ctx.files
                .read(ctx.io.interactive, abs.clone(), ReadRange::default()),
        )
        .await?
        {
            Ok(b) => b.bytes,
            Err(err) => return Err(fs_failure(&err, &shown)),
        };
        // A cached answer is reused only while the bytes still hash as they did.
        if let (Some(state), Some(key), Some(v), true) = (&self.state, &cache_key, version, cacheable) {
            if let Some(hit) = state.cache_get(key) {
                if hit.prefix_hash == hash_bytes(&bytes) {
                    let session = state.snapshot(scope.as_deref(), &key_path);
                    let body_sent = session.as_ref().is_some_and(|s| {
                        same_version(&v, &s.version)
                            && (s.source.starts_with("read") || (is_mutation_source(&s.source) && s.body_delivered == Some(true)))
                            && covers_full_file(s)
                    });
                    let meta = hit.meta.clone().unwrap_or_else(|| SnapshotMeta::new("read_cached"));
                    let seen = Observed { path: key_path.clone(), version: v, meta };
                    if !is_error_text(&hit.value) && body_sent && !mode.suppress() {
                        return Ok(Body { observed: Some(seen), ..Body::text(format!("[file unchanged: {shown}]")) });
                    }
                    let text = if mode.raw() { hit.value } else { rows_for_model(&hit.value) };
                    return Ok(Body { observed: Some(seen), ..Body::text(text) });
                }
                state.invalidate(&[key_path.as_str()]);
            }
        }
        if let Some(method) = document_method(&bytes, raw) {
            let mut body = self.extract_document(ctx, method, &abs, pages).await?;
            if let Some(v) = version {
                if !body.failed() {
                    body.observed = Some(Observed { path: key_path.clone(), version: v, meta: SnapshotMeta { replace_existing: true, ..SnapshotMeta::new("read") } });
                }
            }
            return Ok(body);
        }
        let observe = |meta: SnapshotMeta| version.map(|v| Observed { path: key_path.clone(), version: v, meta });
        let cache = |out: &str, meta: &SnapshotMeta| {
            if let (Some(state), Some(key), true) = (&self.state, &cache_key, cacheable) {
                state.cache_set(key, out.to_owned(), &[key_path.as_str()], Some(meta.clone()), hash_bytes(&bytes));
            }
        };
        let text = match decode_for_read(&bytes) {
            ReadText::Binary => {
                let out = binary_preview(&shown, &bytes, bytes.len() as u64);
                let meta = SnapshotMeta { ranges: Some(Vec::new()), ..SnapshotMeta::new("read_hex") };
                cache(&out, &meta);
                return Ok(Body { observed: observe(meta), ..Body::text(out) });
            }
            ReadText::Text { text, utf16 } => (text, utf16),
        };
        let (text, utf16) = text;
        // A call with no window over the output cap is answered by the smart elision of the file's head and tail.
        if !utf16 && !e.ranged && !e.full && stat.len >= OUTPUT_MAX_BYTES as u64 {
            if let Some((out, ranges, total)) = smart_stream_summary(&text, stat.len) {
                let meta = SnapshotMeta { ranges: Some(ranges), file_line_count: Some(total), ..SnapshotMeta::new("read_smart_stream") };
                cache(&out, &meta);
                let out = if mode.raw() || matches!(mode, Mode::Child { .. }) { out } else { rows_for_model(&out) };
                return Ok(Body { observed: observe(meta), ..Body::text(out) });
            }
        }
        // A batch child streams its window, as does any file over 128 KiB; a UTF-16 body is always
        // decoded whole and read buffered, with its total in the footer.
        let stream = !utf16 && e.ranged && !e.full && (mode.force_stream() || stat.len > READ_STREAM_RANGE_MIN_BYTES);
        let (numbered, meta) = if stream {
            let (out, facts) = stream_window(&text, stat.len, e.offset, e.limit, mode.max_output(), e.base);
            let ranges = if facts.first_emitted > 0 && facts.last_emitted > 0 {
                vec![LineRange { start: facts.first_emitted, end: Some(facts.last_emitted) }]
            } else {
                Vec::new()
            };
            (out, SnapshotMeta { ranges: Some(ranges), ..SnapshotMeta::new("read_stream_range") })
        } else {
            let (out, facts) = buffered_window(&text, e, &shown, stat.len, mode.max_output());
            let full_view = e.offset == 0 && e.offset.saturating_add(e.limit) >= facts.line_count && !facts.byte_capped && !facts.elided;
            let ranges = if full_view {
                vec![LineRange::WHOLE]
            } else if facts.elided {
                facts.visible.clone()
            } else if facts.rendered > 0 {
                vec![LineRange { start: e.offset + 1, end: Some(facts.line_count.min(e.offset + facts.rendered)) }]
            } else {
                Vec::new()
            };
            let meta = SnapshotMeta {
                ranges: Some(ranges),
                content_hash: full_view.then(|| hash_text(&text)),
                file_line_count: Some(facts.line_count),
                ..SnapshotMeta::new("read")
            };
            (out, meta)
        };
        cache(&numbered, &meta);
        let out = if mode.raw() || matches!(mode, Mode::Child { .. }) { numbered } else { rows_for_model(&numbered) };
        Ok(Body { observed: observe(meta), ..Body::text(out) })
    }

    /// A file past the 10 MiB buffered cap, read with its window: a UTF-16 body is refused (it is
    /// decoded whole), a binary one previewed, any other streamed from disk a megabyte at a time.
    async fn read_huge(
        &self,
        ctx: &ToolContext,
        e: &Entry,
        abs: &AbsPath,
        shown: &str,
        stat: &mixdog_core_api::domain::fs::FileStat,
        version: Option<FileVersion>,
        mode: Mode,
    ) -> Result<Body, ToolError> {
        let key_path = fwd(abs.as_path());
        let head_len = stat.len.min(64 * 1024);
        let head = read_range(ctx, abs, shown, 0, head_len).await?;
        if utf16_bom(&head).is_some() {
            let text = format!(
                "Error: UTF-16 file size {} bytes exceeds {MAX_FILE_BYTES} bytes; utf16 ranged reads are bounded — convert to UTF-8 or narrow the range.",
                stat.len
            );
            return Err(fail(ToolErrorCode::TooLarge { limit: MAX_FILE_BYTES, actual: stat.len }, text));
        }
        if !e.ranged {
            return Ok(Body::text(format!("Error: file size {} bytes exceeds {MAX_FILE_BYTES}-byte cap.", stat.len)));
        }
        let tail = if stat.len > head_len && stat.len > 4096 { read_range(ctx, abs, shown, stat.len - 4096, 4096).await? } else { Vec::new() };
        let observe = |meta: SnapshotMeta| version.map(|v| Observed { path: key_path.clone(), version: v, meta });
        if head.contains(&0) || tail.contains(&0) {
            let preview = &head[..head.len().min(BINARY_PREVIEW_BYTES)];
            let meta = SnapshotMeta { ranges: Some(Vec::new()), ..SnapshotMeta::new("read_hex") };
            return Ok(Body { observed: observe(meta), ..Body::text(binary_preview(shown, preview, stat.len)) });
        }
        let mut c = Collector::new(stat.len, e.offset, e.limit, mode.max_output(), e.base);
        let (mut pos, mut pending, mut pending_len) = (0_u64, Vec::<u8>::new(), 0_usize);
        'file: while pos < stat.len && !c.done() {
            let chunk = read_range(ctx, abs, shown, pos, HUGE_CHUNK).await?;
            if chunk.is_empty() {
                break;
            }
            pos += chunk.len() as u64;
            for piece in chunk.split_inclusive(|b| *b == b'\n') {
                let ended = piece.last() == Some(&b'\n');
                let body = if ended { &piece[..piece.len() - 1] } else { piece };
                if !c.skipping() {
                    let room = READ_MAX_LINE_COLLECT_BYTES.saturating_sub(pending.len());
                    pending.extend_from_slice(&body[..body.len().min(room)]);
                }
                pending_len += body.len();
                if ended {
                    // A line over the collect cap keeps its first 50 KiB and no CR strip.
                    let keep = if pending_len > READ_MAX_LINE_COLLECT_BYTES { &pending[..] } else { pending.strip_suffix(b"\r").unwrap_or(&pending) };
                    c.push(keep);
                    pending.clear();
                    pending_len = 0;
                    if c.done() {
                        break 'file;
                    }
                }
            }
        }
        if pending_len > 0 && !c.done() {
            let keep = if pending_len > READ_MAX_LINE_COLLECT_BYTES { &pending[..] } else { pending.strip_suffix(b"\r").unwrap_or(&pending) };
            c.push(keep);
        }
        let (numbered, facts) = c.finish();
        let ranges = if facts.first_emitted > 0 {
            vec![LineRange { start: facts.first_emitted, end: Some(facts.last_emitted) }]
        } else {
            Vec::new()
        };
        let meta = SnapshotMeta { ranges: Some(ranges), ..SnapshotMeta::new("read") };
        let out = if mode.raw() || matches!(mode, Mode::Child { .. }) { numbered } else { rows_for_model(&numbered) };
        Ok(Body { observed: observe(meta), ..Body::text(out) })
    }

    async fn extract_document(
        &self,
        ctx: &ToolContext,
        method: &'static str,
        abs: &AbsPath,
        pages: Option<&str>,
    ) -> Result<Body, ToolError> {
        let Some(pool) = &self.ext else {
            return Err(fail(
                ToolErrorCode::Unavailable {
                    capability: method.to_owned(),
                    reason: "no extension host".to_owned(),
                },
                format!("Error: {method} is unavailable: no extension host"),
            ));
        };
        let call = ExtCall {
            thread: ctx.thread_id.clone(),
            method: method.to_owned(),
            params: serde_json::json!({ "path": fwd(abs.as_path()), "pages": pages }),
            paths: vec![abs.clone()],
        };
        let mut stream = match pool.call(call) {
            Ok(s) => s,
            Err(e) => return Ok(Body::text(ext_error_text(&e))),
        };
        loop {
            match guarded(ctx, "read", stream.next()).await? {
                Some(ExtFrame::Chunk(_)) => {}
                Some(ExtFrame::Done(Ok(v))) => {
                    return Ok(if method == "ooxml.text" {
                        Body::text(v.get("text").and_then(JsonValue::as_str).unwrap_or_default())
                    } else {
                        Body {
                            parts: vec![ToolPart::Json(v)],
                            ..Body::default()
                        }
                    });
                }
                Some(ExtFrame::Done(Err(e))) => return Ok(Body::text(ext_error_text(&e))),
                None => return Ok(Body::text("Error: extension call ended without a result")),
            }
        }
    }

    /// `extractIpynbText`: a read with a window is refused (cells are not line-addressable); one without renders the
    /// cells, markdown as written and code fenced with its text outputs, the text capped at the read's output budget.
    /// An image output is embedded after its cell when it can be resized, and stays a placeholder otherwise or in a
    /// batch (`text_only`). Every `Error:` answer is a failed call.
    async fn notebook(&self, ctx: &ToolContext, e: &Entry, abs: &AbsPath, size: u64, text_only: bool) -> Result<Body, ToolError> {
        let failed = |text: String| Ok(Body { error: true, ..Body::text(text) });
        if e.ranged {
            return failed(IPYNB_RANGE_REFUSAL.to_owned());
        }
        if size > MAX_FILE_BYTES {
            return failed(format!("Error: notebook too large (size: {size}B, cap: {MAX_FILE_BYTES}B) — use a cell range to narrow"));
        }
        let text = match ctx.files.read(ctx.io.interactive, abs.clone(), ReadRange::default()).await {
            Ok(read) => String::from_utf8_lossy(&read.bytes).into_owned(),
            Err(err) => return Err(fs_failure(&err, &display_path(abs.as_path(), &ctx.cwd))),
        };
        if let Some(message) = mixdog_js::v8_json_parse_error(&text) {
            return failed(format!("Error: ipynb parse failed — {message}"));
        }
        let notebook: JsonValue = serde_json::from_str(&text).unwrap_or(JsonValue::Null);
        let full_path = abs.as_path().to_string_lossy().into_owned();
        let property_of_null = |key: &str| format!("Error: ipynb parse failed — Cannot read properties of null (reading '{key}')");
        if notebook.is_null() {
            return failed(property_of_null("cells"));
        }
        let cells = notebook.get("cells").and_then(JsonValue::as_array).cloned().unwrap_or_default();
        // Blocks in notebook order: runs of rendered cells as one text, each embedded image after its cell.
        let mut blocks: Vec<ToolPart> = Vec::new();
        let mut texts: Vec<String> = Vec::new();
        let mut text_len = 0usize;
        let flush = |texts: &mut Vec<String>, blocks: &mut Vec<ToolPart>| {
            if !texts.is_empty() {
                blocks.push(ToolPart::Text(texts.join("\n\n")));
                texts.clear();
            }
        };
        for (index, cell) in cells.iter().enumerate() {
            if cell.is_null() {
                return failed(property_of_null("cell_type"));
            }
            match cell.get("cell_type").and_then(JsonValue::as_str) {
                Some("markdown") => {
                    let source = notebook_text(cell.get("source")).unwrap_or_default();
                    text_len += mixdog_js::utf16_len(&source);
                    texts.push(source);
                }
                Some("code") => {
                    let mut block = notebook_text(cell.get("source")).unwrap_or_default();
                    let mut images: Vec<(&'static str, String)> = Vec::new();
                    for out in cell.get("outputs").and_then(JsonValue::as_array).map(Vec::as_slice).unwrap_or_default() {
                        if out.is_null() {
                            return failed(property_of_null("data"));
                        }
                        let data = out.get("data").filter(|d| js_truthy(d));
                        let field = |key: &str| data.and_then(|d| d.get(key)).filter(|v| js_truthy(v));
                        if let Some(raw) = field("text/plain").or_else(|| out.get("text").filter(|v| js_truthy(v))) {
                            let text = notebook_text(Some(raw)).unwrap_or_default();
                            let length = mixdog_js::utf16_len(&text);
                            if raw.is_string() || raw.is_array() {
                                if length > IPYNB_OUTPUT_MAX_CHARS {
                                    block.push_str(&format!(
                                        "\n# Output: [large output omitted — {length} chars; inspect with: cat \"{full_path}\" | jq '.cells[{index}].outputs']"
                                    ));
                                    continue;
                                }
                            }
                            block.push_str(&format!("\n# Output:\n{text}"));
                        } else if let Some((mime, raw)) = field("image/png").map(|v| ("image/png", v)).or_else(|| field("image/jpeg").map(|v| ("image/jpeg", v))) {
                            images.push((mime, notebook_text(Some(raw)).unwrap_or_default()));
                            block.push_str(&format!("\n# Output: [image output — cell {index}]"));
                        }
                    }
                    let fenced = format!("```python\n{block}\n```");
                    text_len += mixdog_js::utf16_len(&fenced);
                    texts.push(fenced);
                    if !text_only && !images.is_empty() {
                        flush(&mut texts, &mut blocks);
                        for (mime, b64) in images {
                            blocks.extend(self.notebook_image(ctx, &format!("{full_path} [cell {index}]"), &b64, mime).await);
                        }
                    }
                }
                _ => {}
            }
        }
        flush(&mut texts, &mut blocks);
        if text_len > READ_MAX_OUTPUT_BYTES {
            blocks = cap_notebook_text(blocks, READ_MAX_OUTPUT_BYTES);
        }
        if blocks.is_empty() {
            return Ok(Body::text("(empty notebook)"));
        }
        if !blocks.iter().any(|b| matches!(b, ToolPart::Image { .. })) {
            let joined = blocks.iter().map(|b| if let ToolPart::Text(t) = b { t.as_str() } else { "" }).collect::<Vec<_>>().join("\n\n");
            return Ok(Body::text(if joined.is_empty() { "(empty notebook)".to_owned() } else { joined }));
        }
        Ok(Body { parts: blocks, rich: true, ..Body::default() })
    }

    /// `imageBlocksFromBuffer` (after Node's `Buffer.from(b64, 'base64')`) for a notebook image: its resize note and the resized image, or nothing when it
    /// cannot be resized (the cell keeps its placeholder).
    async fn notebook_image(&self, ctx: &ToolContext, source: &str, b64: &str, mime: &'static str) -> Vec<ToolPart> {
        let bytes = node_base64(b64);
        let Some(images) = &self.images else { return Vec::new() };
        if bytes.is_empty() {
            return Vec::new();
        }
        let format = mime.split('/').nth(1).unwrap_or("png");
        match guarded(ctx, "read", images.resize(&ctx.thread_id, &bytes, format)).await {
            Ok(Ok(Some(image))) => match base64::engine::general_purpose::STANDARD.decode(&image.data_base64) {
                Ok(data) => vec![
                    ToolPart::Text(image_metadata(&image, source)),
                    ToolPart::Image { mime: image.mime, data: ImageData::Bytes(data) },
                ],
                Err(_) => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    /// `readImageAsContent`: the resized image behind its metadata line; without a resizer, the
    /// original under the inline-view cap.
    async fn image_body(&self, ctx: &ToolContext, display: &str, bytes: Vec<u8>, mime: &'static str) -> Result<Body, ToolError> {
        let body = self.image_content(ctx, display, bytes, mime).await?;
        // Every answer of an image read, its refusals too, is a structured result to a batch.
        Ok(Body { rich: true, ..body })
    }

    async fn image_content(&self, ctx: &ToolContext, display: &str, bytes: Vec<u8>, mime: &'static str) -> Result<Body, ToolError> {
        if bytes.is_empty() {
            return Ok(Body::text(format!("Error: image \"{display}\" is empty (0 bytes).")));
        }
        let format = mime.split('/').nth(1).unwrap_or("png");
        let resized = match &self.images {
            Some(images) => guarded(ctx, "read", images.resize(&ctx.thread_id, &bytes, format)).await?,
            None => Ok(None),
        };
        match resized {
            Err(ImageResizeError::Invalid) => Ok(Body::text(format!("Error: image \"{display}\" is invalid or corrupt and was not attached."))),
            // The host failing is not sharp being absent: the image was never judged.
            Err(ImageResizeError::Host(e)) => Err(fail(
                ToolErrorCode::Unavailable { capability: "image resize".to_owned(), reason: format!("the extension host failed: {e:?}") },
                format!("Error: image \"{display}\" could not be resized: the extension host failed ({e:?})"),
            )),
            Ok(Some(image)) => {
                let Ok(data) = base64::engine::general_purpose::STANDARD.decode(&image.data_base64) else {
                    return Err(fail(
                        ToolErrorCode::Unavailable { capability: "image resize".to_owned(), reason: "the resizer returned invalid base64".to_owned() },
                        format!("Error: image \"{display}\" could not be resized: the resizer returned invalid base64"),
                    ));
                };
                Ok(Body {
                    parts: vec![
                        ToolPart::Text(image_metadata(&image, display)),
                        ToolPart::Image { mime: image.mime, data: ImageData::Bytes(data) },
                    ],
                    ..Body::default()
                })
            }
            Ok(None) => {
                if bytes.len() > IMAGE_MAX_BYTES {
                    return Ok(Body::text(format!(
                        "Error: image \"{display}\" is {} bytes, over the {IMAGE_MAX_BYTES}-byte inline-view cap (image resizing unavailable: install the optional \"sharp\" dependency to auto-downsample). Convert/resize before reading.",
                        bytes.len()
                    )));
                }
                let base64_len = bytes.len().div_ceil(3) * 4;
                if base64_len > IMAGE_MAX_BASE64 {
                    return Ok(Body::text(format!(
                        "Error: image \"{display}\" base64 size {base64_len} exceeds the {IMAGE_MAX_BASE64}-byte API limit (image resizing unavailable). Resize before reading."
                    )));
                }
                Ok(Body { parts: vec![ToolPart::Image { mime: mime.to_owned(), data: ImageData::Bytes(bytes) }], ..Body::default() })
            }
        }
    }
    async fn directory_error(&self, ctx: &ToolContext, abs: &AbsPath, raw: &str) -> String {
        let mut names: Vec<String> = match ctx.files.list_dir(ctx.io.interactive, abs.clone()).await {
            Ok(entries) => entries
                .iter()
                .map(|e| {
                    let n = e.path.as_path().file_name().map(|n| n.to_string_lossy().into_owned());
                    let n = n.unwrap_or_default();
                    if e.kind == EntryKind::Dir { format!("{n}/") } else { n }
                })
                .collect(),
            Err(_) => Vec::new(),
        };
        names.sort_by(|a, b| compare_names(a, b));
        names.truncate(20);
        let preview = if names.is_empty() {
            String::new()
        } else {
            format!(
                "\nentries:\n{}",
                names.iter().map(|n| format!("- {n}")).collect::<Vec<_>>().join("\n")
            )
        };
        format!("Error: Directory: {raw}. Use list/glob to inspect directories; read expects a file.{preview}")
    }

    /// The `[path absent]` answer: a typed not-found rendered with sibling and
    /// same-name hints computed from directory listings.
    pub(crate) async fn not_found(ctx: &ToolContext, raw: &str, abs: &AbsPath) -> String {
        let answer = Self::not_found_hint(ctx, abs).await;
        // A path that looks like several joined ones is not a basename to locate: the array hint wins
        // (`finalizeReadFamilyEnoentTail`).
        let trimmed = mixdog_js::js_trim(raw);
        let joined = trimmed.split(|c: char| c == ',' || mixdog_js::is_js_space(c)).filter(|s| !s.is_empty()).count() >= 2
            && trimmed.contains(|c: char| c == ',' || mixdog_js::is_js_space(c));
        if !joined {
            return answer;
        }
        let bare = answer.strip_suffix(&format!(" {FIND_NUDGE}")).unwrap_or(&answer);
        format!("{bare} To pass several paths, send an array (path[]), not a comma- or space-joined string.")
    }

    async fn not_found_hint(ctx: &ToolContext, abs: &AbsPath) -> String {
        let cwd_note = format!(" (relative paths resolve from {})", fwd(ctx.cwd.as_path()));
        let message = format!("ENOENT: no such file or directory, stat '{}'", abs.as_path().to_string_lossy());
        let head = format!("[path absent] {}", read_paths::normalize_error_message(&message, Some(&fwd(ctx.cwd.as_path()))));
        if let Some(similar) = Self::similar_sibling(ctx, abs).await {
            // `readNotFoundResponse`: the near name is the absolute path, not cwd-relative.
            let shown = super::patch_guard::normalize_output_path(&similar.as_path().to_string_lossy());
            return format!("{head} Did you mean \"{shown}\"?{cwd_note} {FIND_NUDGE}");
        }
        let target = abs
            .as_path()
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let (hits, exhaustive) = Self::same_name_elsewhere(ctx, &target, abs).await;
        if !hits.is_empty() {
            let list = hits
                .iter()
                .map(|p| format!("\"{}\"", display_path(p.as_path(), &ctx.cwd)))
                .collect::<Vec<_>>()
                .join(", ");
            return format!(
                "{head} Not found at this path; the same filename exists at: {list}. Read that path directly.{cwd_note} {FIND_NUDGE}"
            );
        }
        if exhaustive {
            return format!("{head}{ENOENT_ABSENT}{cwd_note}");
        }
        format!("{head}{cwd_note} {FIND_NUDGE}")
    }

    async fn similar_sibling(ctx: &ToolContext, abs: &AbsPath) -> Option<AbsPath> {
        let parent = AbsPath::new(abs.as_path().parent()?.to_path_buf())?;
        let entries = ctx.files.list_dir(ctx.io.interactive, parent).await.ok()?;
        let base = abs.as_path().file_name()?.to_string_lossy().into_owned();
        let stem = abs.as_path().file_stem()?.to_string_lossy().into_owned();
        let mut names: Vec<(String, AbsPath)> = entries
            .into_iter()
            .filter_map(|e| Some((e.path.as_path().file_name()?.to_string_lossy().into_owned(), e.path)))
            .filter(|(n, _)| *n != base)
            .collect();
        names.sort_by_key(|(n, _)| read_paths::dir_order_key(n));
        let same_stem = names.iter().find(|(n, _)| {
            Path::new(n).file_stem().map(|s| s.to_string_lossy() == stem).unwrap_or(false)
        });
        let case = names.iter().find(|(n, _)| n.to_lowercase() == base.to_lowercase());
        same_stem.or(case).map(|(_, p)| p.clone())
    }

    /// Up to three files with the same name under the cwd; `exhaustive` when
    /// the whole tree was scanned within the fixed entry cap.
    async fn same_name_elsewhere(
        ctx: &ToolContext,
        target: &str,
        missing: &AbsPath,
    ) -> (Vec<AbsPath>, bool) {
        let mut walk = ctx.files.walk(
            ctx.io.maintenance,
            WalkRequest {
                root: ctx.cwd.clone(),
                recursive: true,
                include_hidden: false,
                respect_ignore: true,
                include_dirs: false,
                prune: Vec::new(),
            },
        );
        let mut hits = Vec::new();
        let mut scanned = 0usize;
        let mut exhausted = true;
        let end = pull_all(ctx, walk.as_mut(), |item| {
            let Ok(entry) = item else { return true };
            scanned += 1;
            if scanned > NEAR_SCAN_ENTRIES {
                exhausted = false;
                return false;
            }
            let name = entry.path.as_path().file_name().map(|n| n.to_string_lossy().to_lowercase());
            if name.as_deref() == Some(target)
                && entry.path.as_path() != missing.as_path()
                && !in_noise_dir(entry.path.as_path(), ctx.cwd.as_path())
            {
                hits.push(entry.path);
            }
            hits.len() < 3
        })
        .await;
        let done = matches!(end, PullEnd::Exhausted) && exhausted && hits.len() < 3;
        hits.sort();
        (hits, done)
    }
}

use std::path::Path;

const FIND_NUDGE: &str = "Locate with find on the basename before retrying.";
const ENOENT_ABSENT: &str =
    " Nothing same-named elsewhere in the project scan — treat the path as absent (create it if the task requires).";

pub(crate) fn in_noise_dir(path: &Path, root: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    rel.components()
        .any(|c| NOISE_DIRS.contains(&c.as_os_str().to_string_lossy().as_ref()))
}

fn ext_error_text(e: &ExtError) -> String {
    match e {
        ExtError::Failed { message, .. } => format!("Error: {message}"),
        ExtError::Unavailable { reason } => format!("Error: document extraction unavailable: {reason}"),
        ExtError::Cancelled => "Error: document extraction cancelled".to_owned(),
        ExtError::Overloaded => "Error: document extraction is overloaded; retry shortly".to_owned(),
        ExtError::HostExited { .. } | ExtError::UnknownWorker => {
            "Error: document extraction worker exited; retry".to_owned()
        }
    }
}

/// UNC and raw-device namespaces are refused before any path resolution.
fn path_string_guard(raw: &str) -> Option<&'static str> {
    read_paths::string_guard(raw)
}

/// The image type of a path by its extension (`imageMimeForPath`).
fn image_ext(raw: &str) -> Option<&'static str> {
    match Path::new(raw).extension()?.to_string_lossy().to_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// The image type of a path with no extension, by its signature (`SNIFFED_IMAGE_TYPES`).
fn sniffed_image(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if head.starts_with(b"GIF8") {
        Some("image/gif")
    } else if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// `imageMetadataText`: the line that precedes a resized image.
fn image_metadata(image: &ResizedImage, source: &str) -> String {
    let (ow, oh, dw, dh) = (image.original_w, image.original_h, image.display_w, image.display_h);
    if ow == 0 || oh == 0 || dw == 0 || dh == 0 {
        return format!("[Image source: {source}]");
    }
    let mut parts = vec![format!("source: {source}"), format!("{ow}x{oh}")];
    if ow != dw || oh != dh {
        let scale = mixdog_js::math::to_fixed(f64::from(ow) / f64::from(dw), 2);
        parts.push(format!("displayed at {dw}x{dh}. Multiply coordinates by {scale} to map to the original image."));
    } else {
        parts.push(format!("displayed at {dw}x{dh}"));
    }
    format!("[Image: {}]", parts.join(", "))
}
/// `joinedNotebookText(value) || ''` as a template inserts it: an array joined with nothing (each element as
/// `String` gives it, null as empty), anything else as `String(value)`; a falsy result is none.
fn notebook_text(value: Option<&JsonValue>) -> Option<String> {
    let value = value.filter(|v| js_truthy(v))?;
    let text = match value {
        JsonValue::Array(items) => items
            .iter()
            .map(|item| match item {
                JsonValue::Null => String::new(),
                JsonValue::String(s) => s.clone(),
                other => mixdog_js::value_to_string(other),
            })
            .collect(),
        JsonValue::String(s) => s.clone(),
        other => mixdog_js::value_to_string(other),
    };
    (!text.is_empty()).then_some(text)
}

/// JavaScript truthiness of a parsed JSON value.
fn js_truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(flag) => *flag,
        JsonValue::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        JsonValue::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `capNotebookText`: text blocks kept until `max` UTF-16 units, the one that crosses it cut, then the cut marked;
/// image blocks pass uncounted.
fn cap_notebook_text(blocks: Vec<ToolPart>, max: usize) -> Vec<ToolPart> {
    let mut running = 0usize;
    let mut truncated = false;
    let mut capped = Vec::new();
    for block in blocks {
        let ToolPart::Text(text) = &block else {
            capped.push(block);
            continue;
        };
        if running >= max {
            truncated = true;
            continue;
        }
        let length = mixdog_js::utf16_len(text);
        if running + length > max {
            capped.push(ToolPart::Text(mixdog_js::slice_utf16(text, max - running)));
            running = max;
            truncated = true;
        } else {
            running += length;
            capped.push(block);
        }
    }
    if truncated {
        capped.push(ToolPart::Text(format!(
            "\n\n{}",
            cap_marker(&format_cap_size(max), "notebook cells cut", None, "grep the notebook for the cell text you need")
        )));
    }
    capped
}

/// A regular file named `.ipynb` (any case, as Node lowercases `extname`).
fn is_notebook(stat: &mixdog_core_api::domain::fs::FileStat, raw: &str) -> bool {
    stat.kind == EntryKind::File && Path::new(raw.trim()).extension().is_some_and(|x| x.eq_ignore_ascii_case("ipynb"))
}

/// The extension-pool method a file needs: PDF and OOXML by magic bytes, or by
/// the declared extension when the container itself is damaged.
fn document_method(bytes: &[u8], raw: &str) -> Option<&'static str> {
    let ext = Path::new(raw)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if bytes.starts_with(b"%PDF-") || ext == "pdf" {
        return Some("pdf.render");
    }
    let zip_office = bytes.starts_with(b"PK\x03\x04")
        && bytes.windows(19).take(8192).any(|w| w == b"[Content_Types].xml");
    if zip_office || matches!(ext.as_str(), "docx" | "pptx" | "xlsx" | "xlsm") {
        return Some("ooxml.text");
    }
    None
}

fn binary_preview(shown: &str, bytes: &[u8], size: u64) -> String {
    let n = size;
    let hex = bytes
        .iter()
        .take(BINARY_PREVIEW_BYTES)
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ");
    let hex = if hex.is_empty() { "(empty)".to_owned() } else { hex };
    format!(
        "{shown}\nbinary, {n} byte{}\n{hex}",
        if n == 1 { "" } else { "s" }
    )
}

fn clip_line(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= MAX_RENDERED_LINE_CHARS {
        return line.to_owned();
    }
    let head: String = chars[..1_500].iter().collect();
    let tail: String = chars[chars.len() - 300..].iter().collect();
    format!("{head} ... [line truncated: {} chars total] ... {tail}", chars.len())
}

/// `renderReadLine`: the row number, then the line clipped as the read display clips it.
fn render_read_line(number: u64, line: &str) -> String {
    format!("{number}→{}", clip_line(line))
}

/// What a rendered window says about the lines it holds.
struct WindowFacts {
    /// Lines in the file (buffered reads only).
    line_count: u64,
    /// Complete rows shown (buffered reads only).
    rendered: u64,
    byte_capped: bool,
    /// The middle of the file was elided (a call with no window over the smart cap).
    elided: bool,
    /// The rows an elided window kept, as line ranges.
    visible: Vec<LineRange>,
    /// First and last line number a streamed window emitted (1-based; 0 when none).
    first_emitted: u64,
    last_emitted: u64,
}

/// The buffered read of a window (`renderReadWindow`): numbered rows with the total in the footer,
/// cut by bytes (mid-row, as Node cuts) when they pass the output cap.
fn buffered_window(text: &str, e: &Entry, shown: &str, file_size: u64, max: usize) -> (String, WindowFacts) {
    let (offset, limit, base) = (e.offset, e.limit, e.base);
    let facts = |line_count, rendered, byte_capped| WindowFacts { line_count, rendered, byte_capped, elided: false, visible: Vec::new(), first_emitted: 0, last_emitted: 0 };
    if text.is_empty() {
        let reminder = format!(
            "<system-reminder>File exists but has empty contents: {}</system-reminder>",
            shown.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        );
        return (reminder, facts(0, 0, false));
    }
    let mut lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if let Some(first) = lines.first_mut() {
        *first = first.strip_prefix('\u{feff}').unwrap_or(first);
    }
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let total = lines.len() as u64;
    // A call with no window shows every line; a windowed one the `limit` lines from `offset`.
    let end = if e.ranged { offset.saturating_add(limit).min(total) } else { total };
    let sliced: &[&str] = if offset < end { &lines[offset as usize..end as usize] } else { &[] };
    if e.ranged && sliced.is_empty() && offset >= total {
        return (format!("(no lines in range; file has {total} lines)"), facts(total, 0, false));
    }
    let rendered = sliced
        .iter()
        .enumerate()
        .map(|(i, l)| if e.full { format!("{}→{l}", offset + i as u64 + 1) } else { render_read_line(offset + i as u64 + 1, l) })
        .collect::<Vec<_>>()
        .join("\n");
    if !e.ranged {
        // No footer. Only a call without `full` is elided in the middle; any is cut at the byte cap.
        if !e.full
            && let Some((elided, visible)) = smart_read_truncate(&rendered, total, file_size)
        {
            return (elided, WindowFacts { elided: true, visible, ..facts(total, 0, false) });
        }
        if rendered.len() > max {
            let slice = byte_prefix(&rendered, max);
            let shown_lines = slice.matches('\n').count() as u64;
            let of_file = if file_size > 0 { format!("{} KB file", ((file_size as f64 / 1024.0).round() as u64).max(1)) } else { String::new() };
            let note = if of_file.is_empty() { String::new() } else { format!("{shown_lines} of {total} lines shown ({of_file})") };
            let marker = cap_marker(&format_cap_size(max), &note, Some(offset + shown_lines + base), "");
            return (format!("{slice}\n\n{marker}"), facts(total, shown_lines, true));
        }
        return (rendered, facts(total, sliced.len() as u64, false));
    }
    let (out, footer, shown_lines, capped) = if rendered.len() > max {
        let slice = byte_prefix(&rendered, max).to_owned();
        let shown_lines = slice.matches('\n').count() as u64;
        let emitted_end = offset + shown_lines;
        let next = (emitted_end < total).then_some(emitted_end + base);
        (slice, window_marker("lines", offset + 1, emitted_end, Some(total), next, Some(max)), shown_lines, true)
    } else {
        let emitted_end = offset + sliced.len() as u64;
        let next = (emitted_end < total).then_some(emitted_end + base);
        (rendered, window_marker("lines", offset + 1, emitted_end, Some(total), next, None), sliced.len() as u64, false)
    };
    (format!("{out}{}{footer}", if out.is_empty() { "" } else { "\n" }), facts(total, shown_lines, capped))
}

/// `streamSmartReadSummary` over a text held whole: the first 1200 and last 400 rows around a
/// marker, shrunk by whole rows (a quarter at a time, the larger side first) until they fit the
/// output cap. `None` when no row needs eliding. Also the line ranges shown and the line count.
fn smart_stream_summary(text: &str, file_size: u64) -> Option<(String, Vec<LineRange>, u64)> {
    const HEAD: usize = 1200;
    const TAIL: usize = 400;
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let total = lines.len();
    let head_count = HEAD.min(total);
    let tail_start = head_count.max(total.saturating_sub(TAIL));
    if tail_start == head_count {
        return None;
    }
    let raw = |i: usize| {
        let line = lines[i].strip_suffix('\r').unwrap_or(lines[i]);
        if i == 0 { line.strip_prefix('\u{feff}').unwrap_or(line) } else { line }
    };
    let head_rows: Vec<String> = (0..head_count).map(|i| render_read_line(i as u64 + 1, raw(i))).collect();
    let tail_rows: Vec<String> = (tail_start..total).map(|i| render_read_line(i as u64 + 1, raw(i))).collect();
    let kb = ((file_size as f64 / 1024.0).round() as u64).max(1);
    let limit = if file_size > OUTPUT_MAX_BYTES as u64 { format_cap_size(OUTPUT_MAX_BYTES) } else { "2000 lines".to_owned() };
    let marker = cap_marker(&limit, &format!("{total} lines / {kb} KB"), None, "read located windows with {file_path, offset, limit}");
    let (mut head_take, mut tail_take) = (head_rows.len(), tail_rows.len());
    let out = loop {
        let out = format!("{}\n{marker}\n{}", head_rows[..head_take].join("\n"), tail_rows[tail_rows.len() - tail_take..].join("\n"));
        if out.len() <= OUTPUT_MAX_BYTES || (head_take <= 1 && tail_take <= 1) {
            break out;
        }
        if head_take >= tail_take && head_take > 1 {
            head_take = ((head_take as f64 * 0.75).floor() as usize).max(1);
        } else if tail_take > 1 {
            tail_take = ((tail_take as f64 * 0.75).floor() as usize).max(1);
        } else {
            break out;
        }
    };
    let mut shown = Vec::new();
    if head_take > 0 {
        shown.push(LineRange { start: 1, end: Some(head_take as u64) });
    }
    if tail_take > 0 {
        shown.push(LineRange { start: (total - tail_take) as u64 + 1, end: Some(total as u64) });
    }
    Some((out, merge_ranges(&shown), total as u64))
}
/// `smartReadTruncate`: a window with no bounds over 2000 lines (or 50 KB) keeps its first 1200
/// and last 400 rows around a marker naming the omitted ones.
fn smart_read_truncate(rendered: &str, total_lines: u64, file_bytes: u64) -> Option<(String, Vec<LineRange>)> {
    const MAX_LINES: u64 = 2000;
    const HEAD_LINES: usize = 1200;
    const TAIL_LINES: usize = 400;
    let over_bytes = file_bytes > OUTPUT_MAX_BYTES as u64;
    if !over_bytes && total_lines <= MAX_LINES {
        return None;
    }
    let rows: Vec<&str> = rendered.split('\n').collect();
    let head = HEAD_LINES.min(rows.len());
    let tail_start = head.max(rows.len().saturating_sub(TAIL_LINES));
    if tail_start == head {
        return None;
    }
    let kb = ((file_bytes as f64 / 1024.0).round() as u64).max(1);
    let limit = if over_bytes { format_cap_size(OUTPUT_MAX_BYTES) } else { format!("{MAX_LINES} lines") };
    let shown = format!("lines {}-{tail_start} of {total_lines} omitted ({kb} KB file)", head + 1);
    let marker = cap_marker(&limit, &shown, Some(head as u64 + 1), "");
    let kept = [LineRange { start: 1, end: Some(head as u64) }, LineRange { start: tail_start as u64 + 1, end: Some(rows.len() as u64) }];
    Some((format!("{}\n{marker}\n{}", rows[..head].join("\n"), rows[tail_start..].join("\n")), merge_ranges(&kept)))
}

/// The line collector of a streamed window (`createReadLineCollector`): rows until the limit or
/// until the body budget, with a footer that knows no total. Fed one line at a time, so a file
/// need not be held whole.
struct Collector {
    offset: u64,
    limit: u64,
    body_bytes: usize,
    max_output: usize,
    file_size: u64,
    line_idx: u64,
    collected: Vec<String>,
    bytes: usize,
    first_emitted: u64,
    last_emitted: u64,
    truncated: bool,
    stopped_at_limit: bool,
    /// The coordinate base of the continuation offset the footer names.
    base: u64,
}

impl Collector {
    fn new(file_size: u64, offset: u64, limit: u64, max_output: usize, base: u64) -> Self {
        Self {
            base,
            offset,
            limit,
            body_bytes: (max_output - (max_output / 3).min(384)).max(1),
            max_output,
            file_size,
            line_idx: 0,
            collected: Vec::new(),
            bytes: 0,
            first_emitted: 0,
            last_emitted: 0,
            truncated: false,
            stopped_at_limit: false,
        }
    }

    fn done(&self) -> bool {
        self.truncated || self.stopped_at_limit
    }

    /// Whether the next line is before the window and need not be kept.
    fn skipping(&self) -> bool {
        !self.done() && self.line_idx < self.offset
    }

    /// One line, without its newline. A line is collected up to 50 KiB; the display clips it further.
    fn push(&mut self, raw: &[u8]) {
        if self.done() {
            return;
        }
        if self.line_idx < self.offset {
            self.line_idx += 1;
            return;
        }
        let mut line = String::from_utf8_lossy(&raw[..raw.len().min(READ_MAX_LINE_COLLECT_BYTES)]).into_owned();
        if self.line_idx == 0 {
            if let Some(rest) = line.strip_prefix('\u{feff}') {
                line = rest.to_owned();
            }
        }
        let row = render_read_line(self.line_idx + 1, &line);
        self.bytes += row.len() + 1;
        if self.bytes > self.body_bytes {
            self.truncated = true;
            return;
        }
        self.collected.push(row);
        if self.first_emitted == 0 {
            self.first_emitted = self.line_idx + 1;
        }
        self.last_emitted = self.line_idx + 1;
        self.line_idx += 1;
        if self.collected.len() as u64 >= self.limit {
            self.stopped_at_limit = true;
        }
    }

    fn finish(self) -> (String, WindowFacts) {
        let offset = self.offset;
        let mut out = self.collected.join("\n");
        if self.truncated {
            let next = if self.last_emitted == 0 { offset } else { self.last_emitted } + self.base;
            let of_file = if self.file_size > 0 { format!("{} KB file", (self.file_size as f64 / 1024.0).round().max(1.0) as u64) } else { String::new() };
            out.push_str(&format!("\n\n{}", cap_marker(&format_cap_size(self.max_output), &of_file, Some(next), "")));
        } else if self.stopped_at_limit {
            let shown = self.collected.len() as u64;
            out.push_str(&format!(
                "{}{}",
                if out.is_empty() { "" } else { "\n" },
                window_marker("lines", offset + 1, offset + shown, None, Some(offset + shown + self.base), None)
            ));
        } else if out.is_empty() && offset >= self.line_idx {
            out = format!("(no lines in range; file has {} lines)", self.line_idx);
        }
        (out, WindowFacts { line_count: 0, rendered: 0, byte_capped: false, elided: false, visible: Vec::new(), first_emitted: self.first_emitted, last_emitted: self.last_emitted })
    }
}

/// The streamed read of a window of text already in memory.
fn stream_window(text: &str, file_size: u64, offset: u64, limit: u64, max_output: usize, base: u64) -> (String, WindowFacts) {
    let mut lines = text.split('\n').collect::<Vec<_>>();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let mut c = Collector::new(file_size, offset, limit, max_output, base);
    for line in lines {
        c.push(line.strip_suffix('\r').unwrap_or(line).as_bytes());
        if c.done() {
            break;
        }
    }
    c.finish()
}

/// The hash of a file's decoded text, as the read state keeps it (`None` for a binary file).
pub(super) fn content_hash_of(bytes: &[u8]) -> Option<String> {
    match decode_for_read(bytes) {
        ReadText::Text { text, .. } => Some(hash_text(&text)),
        ReadText::Binary => None,
    }
}

/// What `read` makes of a file's bytes.
enum ReadText {
    Binary,
    Text { text: String, utf16: bool },
}

/// `detectReadEncodingFromBuffer`: a UTF-16 byte-order mark and whether it is little-endian.
fn utf16_bom(bytes: &[u8]) -> Option<bool> {
    match bytes {
        [0xff, 0xfe, ..] => Some(true),
        [0xfe, 0xff, ..] => Some(false),
        _ => None,
    }
}

/// The binary test and the decode of a read (`isBinaryBuffer`, `decodeReadBuffer`): a UTF-16 BOM
/// is text; otherwise a NUL in the first 64 KiB (or in the last 4 KiB of a longer file) is binary;
/// text decodes as UTF-8, a stray byte becoming U+FFFD.
fn decode_for_read(bytes: &[u8]) -> ReadText {
    if let Some(little) = utf16_bom(bytes) {
        let body = &bytes[2..];
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|p| if little { u16::from_le_bytes([p[0], p[1]]) } else { u16::from_be_bytes([p[0], p[1]]) })
            .collect();
        return ReadText::Text { text: String::from_utf16_lossy(&units), utf16: true };
    }
    let head = bytes.len().min(64 * 1024);
    let binary = bytes[..head].contains(&0) || (bytes.len() > head && bytes.len() > 4096 && bytes[bytes.len() - 4096..].contains(&0));
    if binary {
        return ReadText::Binary;
    }
    ReadText::Text { text: String::from_utf8_lossy(bytes).into_owned(), utf16: false }
}
/// Splits a glob path into its literal directory prefix and the pattern.
fn split_glob(raw: &str) -> (String, String) {
    let norm = raw.replace('\\', "/");
    let parts: Vec<&str> = norm.split('/').collect();
    let first = parts.iter().position(|p| has_glob_magic(p)).unwrap_or(parts.len());
    let base = parts[..first].join("/");
    let pattern = parts[first..].join("/");
    (if base.is_empty() { ".".to_owned() } else { base }, pattern)
}

/// Node's `Buffer.from(text, 'base64')`: the standard and URL-safe alphabets, every other character (line breaks
/// included) skipped, decoding ended by the first `=`; a trailing lone sextet carries no byte. Node reads the string's
/// UTF-16 code units through their low byte (nbytes `Base64Decode` over `uint16_t`), so `Ł` (U+0141) counts as `A` and
/// `丽` (U+4E3D) as `=`; an astral character is a surrogate pair, whose high half (0xD8xx-0xDBxx) has a low byte of its
/// own, `=` for U+1F600's 0xD83D.
fn node_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for unit in text.encode_utf16() {
        let b = unit as u8;
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}
