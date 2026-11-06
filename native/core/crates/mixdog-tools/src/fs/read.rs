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
use super::read_batch::*;
use super::search::glob_files;

const READ_SPEC: &str = include_str!("specs/read.json");
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
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
}

impl ReadTool {
    pub fn new(ext: Option<Arc<dyn ExtPool>>, images: Option<Arc<dyn ImageResizer>>) -> Self {
        Self {
            spec: spec(
                READ_SPEC,
                "Read files: line windows, several files at once, images, PDF and Office documents.",
                true,
                None,
            ),
            ext,
            images,
        }
    }
}

/// One requested window; `offset` is 0-based.
struct Entry {
    path: String,
    offset: u64,
    limit: u64,
}

/// One entry's result: text, or text plus media parts.
#[derive(Default)]
struct Body {
    parts: Vec<ToolPart>,
    /// An image read's result (Node's structured `{ content }`), which a batch keeps as blocks.
    rich: bool,
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

/// How a window is read: alone, or as one child of a batch under its share of the output budget.
#[derive(Clone, Copy)]
enum Mode {
    Single,
    Child { max_output: usize },
}

/// The public arguments, normalized the way `normalizePublicReadTargets` does: every window is
/// explicit, with a 0-based offset.
struct Public {
    single: bool,
    entries: Vec<Entry>,
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
    let Some(raw) = args.get("file_path") else {
        return Err(invalid("file_path", "required", "Error: read requires \"path\" (or alias file_path)."));
    };
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
        entries.push(Entry { path: path.to_owned(), offset, limit });
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
    Ok(Public { single: !batch, entries, skipped, pages: arg_str(args, "pages").map(str::to_owned) })
}

#[async_trait]
impl Tool for ReadTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let mut public = parse_public(&args)?;
        for e in &mut public.entries {
            e.path = strip_line_coordinate(ctx, &e.path).await?;
        }
        if public.single {
            let e = &public.entries[0];
            if has_glob_magic(&e.path) && !exists(ctx, &e.path).await {
                if let Some((results, capped)) = self.survey(ctx, e, SURVEY_BUDGET).await? {
                    return Ok(ToolOutput { parts: survey_parts(&results, capped), ..ToolOutput::default() });
                }
            }
            let body = self.read_one(ctx, e, public.pages.as_deref(), Mode::Single).await?;
            // An image read's empty, corrupt and over-cap answers are Node's `isError` results; in a
            // batch the same body marks only its own entry (`[error]`).
            if body.rich && body.failed() {
                let reason = body.first_text().to_owned();
                return Err(fail(ToolErrorCode::Failed { reason: reason.clone() }, reason));
            }
            return Ok(ToolOutput { parts: body.parts, ..ToolOutput::default() });
        }
        let results = self.pipeline(ctx, public.entries, true, READ_MAX_OUTPUT_BYTES).await?;
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

async fn exists(ctx: &ToolContext, raw: &str) -> bool {
    let Ok(abs) = resolve_path(&ctx.cwd, raw) else { return false };
    ctx.files.stat(ctx.io.interactive, abs).await.is_ok()
}

/// `normaliseReadLineWindowArgs`' path half: `file.rs:12` / `file.rs#L12-20` names `file.rs` when
/// only that exists. The window itself is already explicit.
async fn strip_line_coordinate(ctx: &ToolContext, raw: &str) -> Result<String, ToolError> {
    static HASH: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static COLON: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let hash = HASH.get_or_init(|| regex::Regex::new(r"(?i)^(.+?)#L(\d+)(?:-L?(\d+))?(?:\b.*)?$").expect("a fixed pattern"));
    let colon = COLON.get_or_init(|| regex::Regex::new(r"^(.+):(\d+)(?:-(\d+))?(?::.*)?$").expect("a fixed pattern"));
    let text = raw.trim();
    let Some(m) = hash.captures(text).or_else(|| colon.captures(text)) else { return Ok(raw.to_owned()) };
    let positive = |s: &str| s.parse::<u64>().ok().filter(|n| *n > 0);
    let Some(line_no) = positive(&m[2]) else { return Ok(raw.to_owned()) };
    if m[1].is_empty() || exists(ctx, raw).await || !exists(ctx, &m[1]).await {
        return Ok(raw.to_owned());
    }
    if let Some(end) = m.get(3).and_then(|e| positive(e.as_str())).filter(|end| *end < line_no) {
        let text = format!(
            "Error: inverted range in path \"{raw}\" — end ({end}) precedes start ({line_no}); use file:{end}-{line_no} or remove the range"
        );
        return Err(invalid("file_path", "range", text));
    }
    Ok(m[1].to_owned())
}

type Pipeline<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Resolved>, ToolError>> + Send + 'a>>;

impl ReadTool {
    /// `readGlobSurvey`: a magic path that names nothing becomes the batch of its newest matches.
    /// `None` when it matches nothing, so the raw pattern gets the single-read answer.
    async fn survey(&self, ctx: &ToolContext, e: &Entry, cap: usize) -> Result<Option<(Vec<Resolved>, bool)>, ToolError> {
        let (root, pattern) = split_glob(&e.path);
        let root = resolve_path(&ctx.cwd, &root)?;
        let (mut files, _) = glob_files(ctx, &root, &[pattern], false).await?;
        if files.is_empty() {
            return Ok(None);
        }
        files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let capped = files.len() > GLOB_SURVEY_FILES;
        files.truncate(GLOB_SURVEY_FILES);
        let entries = files
            .into_iter()
            .map(|(p, _)| Entry { path: fwd(p.as_path()), offset: e.offset, limit: e.limit.min(GLOB_SURVEY_LINES) })
            .collect();
        Ok(Some((self.pipeline(ctx, entries, false, cap).await?, capped)))
    }

    /// The batch machinery (`executeBatchRead`): shape the entries, split the output budget over
    /// the distinct disk reads, read each, and cut every caller's window back out of its read.
    /// `object` entries come from the public form and are merged and coalesced; the survey's
    /// are read as they stand.
    fn pipeline<'a>(&'a self, ctx: &'a ToolContext, entries: Vec<Entry>, object: bool, cap: usize) -> Pipeline<'a> {
        Box::pin(async move {
            let key = |p: &str| match resolve_path(&ctx.cwd, p) {
                Ok(abs) => fwd(abs.as_path()),
                Err(_) => p.to_owned(),
            };
            let shown = |p: &str| match resolve_path(&ctx.cwd, p) {
                Ok(abs) => display_path(abs.as_path(), &ctx.cwd),
                Err(_) => p.to_owned(),
            };
            let wentries: Vec<WEntry> = entries.into_iter().map(|e| WEntry { path: e.path, offset: e.offset, limit: e.limit }).collect();
            let (slots, firsts, map) = if object {
                let slots = coalesce(merge_overlapping(wentries, &key), &key);
                let (firsts, map) = dedupe(&slots);
                (slots, firsts, map)
            } else {
                let slots: Vec<Slot> = wentries.into_iter().map(|entry| Slot { entry, union: None, slice: None }).collect();
                let mut seen: Vec<String> = Vec::new();
                let (mut firsts, mut map) = (Vec::new(), Vec::new());
                for (i, s) in slots.iter().enumerate() {
                    let k = format!("{}|{}|{}", key(&s.entry.path), s.entry.offset, s.entry.limit);
                    let at = seen.iter().position(|x| *x == k).unwrap_or_else(|| {
                        seen.push(k);
                        firsts.push(i);
                        firsts.len() - 1
                    });
                    map.push(at);
                }
                (slots, firsts, map)
            };
            // The budget is split over all the disk reads first; they then run in path, then
            // window, order.
            let header_paths: Vec<&str> = if object {
                firsts.iter().map(|i| slots[*i].entry.path.as_str()).collect()
            } else {
                slots.iter().map(|s| s.entry.path.as_str()).collect()
            };
            let mut needs = Vec::with_capacity(firsts.len());
            for i in &firsts {
                let slot = &slots[*i];
                let size = match resolve_path(&ctx.cwd, &slot.entry.path) {
                    Ok(abs) => match ctx.files.stat(ctx.io.interactive, abs).await {
                        Ok(st) if matches!(st.kind, EntryKind::File) => Some(st.len),
                        _ => None,
                    },
                    Err(_) => None,
                };
                needs.push(estimate_bytes(size, slot.disk().1));
            }
            let allocated = allocate_budgets(&needs, body_budget(&header_paths, cap));
            let mut order: Vec<usize> = (0..firsts.len()).collect();
            order.sort_by(|a, b| {
                let (x, y) = (&slots[firsts[*a]].entry, &slots[firsts[*b]].entry);
                x.path.cmp(&y.path).then(x.offset.cmp(&y.offset)).then(a.cmp(b))
            });
            let mut bodies: Vec<Option<CBody>> = vec![None; firsts.len()];
            for at in order {
                let slot = &slots[firsts[at]];
                let (offset, limit) = slot.disk();
                let budget = allocated[at].max(256.0) as usize;
                let child = Entry { path: slot.entry.path.clone(), offset, limit };
                bodies[at] = Some(self.child(ctx, &child, READ_MAX_OUTPUT_BYTES.min(budget)).await?);
            }
            Ok(slots
                .iter()
                .enumerate()
                .map(|(i, slot)| {
                    let producer = map[i];
                    let body = bodies[producer].clone().expect("every read ran");
                    let body = match (&body, slot.slice) {
                        (CBody::Str(s), Some((offset, limit))) => CBody::Str(slice_read_body(s, offset, limit, 1)),
                        _ => body,
                    };
                    let path = if object { shown(&slots[firsts[producer]].entry.path) } else { shown(&slot.entry.path) };
                    Resolved { path, body, producer }
                })
                .collect())
        })
    }

    /// One batch entry through the child `read`: a failure is pasted into the aggregate as that
    /// entry's text, never aborting the batch.
    async fn child(&self, ctx: &ToolContext, e: &Entry, max_output: usize) -> Result<CBody, ToolError> {
        if has_glob_magic(&e.path) && !exists(ctx, &e.path).await {
            if let Some((results, capped)) = self.survey(ctx, e, max_output.min(SURVEY_BUDGET)).await? {
                let mut text = render_text(&results);
                if capped {
                    text.push_str(&format!("\n{GLOB_CAP_NOTE}"));
                }
                return Ok(CBody::Str(text));
            }
        }
        match self.read_one(ctx, e, None, Mode::Child { max_output }).await {
            Ok(body) => {
                let plain = body.parts.len() == 1 && matches!(body.parts[0], ToolPart::Text(_));
                if body.rich || !plain {
                    let failed = body.failed();
                    Ok(CBody::Rich { parts: body.parts, failed })
                } else {
                    Ok(CBody::Str(body.first_text().to_owned()))
                }
            }
            Err(err) if matches!(err.code, ToolErrorCode::Cancelled | ToolErrorCode::DeadlineExceeded { .. }) => Err(err),
            Err(err) => Ok(CBody::Str(err.message_for_model)),
        }
    }

    async fn read_one(&self, ctx: &ToolContext, e: &Entry, pages: Option<&str>, mode: Mode) -> Result<Body, ToolError> {
        let raw = e.path.trim();
        if let Some(reason) = path_string_guard(raw) {
            return Ok(Body::text(format!("Error: {reason}: {raw}")));
        }
        let abs = resolve_path(&ctx.cwd, raw)?;
        let shown = display_path(abs.as_path(), &ctx.cwd);
        let stat = match guarded(ctx, "read", ctx.files.stat(ctx.io.interactive, abs.clone())).await? {
            Ok(s) => s,
            Err(err) if err.kind == FsErrorKind::NotFound || err.kind == FsErrorKind::NotADirectory => {
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
            return Err(fail(
                ToolErrorCode::TooLarge {
                    limit: MAX_FILE_BYTES,
                    actual: stat.len,
                },
                format!("Error: file size {} bytes exceeds {MAX_FILE_BYTES}-byte cap.", stat.len),
            ));
        }
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
        if let Some(method) = document_method(&bytes, raw) {
            return self.extract_document(ctx, method, &abs, pages).await;
        }
        let Ok((text, _)) = decode_text(&bytes) else {
            return Ok(Body::text(binary_preview(&shown, &bytes)));
        };
        // A batch child, and any file over 128 KiB, streams its window (no total in the footer).
        Ok(Body::text(match mode {
            Mode::Child { max_output } => stream_window(&text, stat.len, e.offset, e.limit, max_output),
            Mode::Single if stat.len > READ_STREAM_RANGE_MIN_BYTES => {
                rows_for_model(&stream_window(&text, stat.len, e.offset, e.limit, READ_MAX_OUTPUT_BYTES))
            }
            Mode::Single => rows_for_model(&buffered_window(&text, e.offset, e.limit, &shown, READ_MAX_OUTPUT_BYTES)),
        }))
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
        let cwd_note = format!(" (relative paths resolve from {})", fwd(ctx.cwd.as_path()));
        let head = format!("[path absent] ENOENT: no such file or directory, stat '{raw}'");
        if let Some(similar) = Self::similar_sibling(ctx, abs).await {
            let shown = display_path(similar.as_path(), &ctx.cwd);
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
        names.sort_by(|a, b| compare_names(&a.0, &b.0));
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
    let norm = raw.replace('/', "\\");
    if norm.starts_with("\\\\.\\") || norm.starts_with("\\\\?\\") {
        return Some("cannot read Windows device path (reserved name or raw-device namespace)");
    }
    if norm.starts_with("\\\\") {
        return Some("cannot read UNC / SMB path (network credential leak risk)");
    }
    None
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

fn binary_preview(shown: &str, bytes: &[u8]) -> String {
    let n = bytes.len();
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

/// The buffered read of a window (`renderReadWindow`): numbered rows with the total in the footer,
/// cut by bytes (mid-row, as Node cuts) when they pass the output cap.
fn buffered_window(text: &str, offset: u64, limit: u64, shown: &str, max: usize) -> String {
    if text.is_empty() {
        return format!(
            "<system-reminder>File exists but has empty contents: {}</system-reminder>",
            shown.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        );
    }
    let mut lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if let Some(first) = lines.first_mut() {
        *first = first.strip_prefix('\u{feff}').unwrap_or(first);
    }
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let total = lines.len() as u64;
    let end = (offset + limit).min(total);
    let sliced: &[&str] = if offset < end { &lines[offset as usize..end as usize] } else { &[] };
    if sliced.is_empty() && offset >= total {
        return format!("(no lines in range; file has {total} lines)");
    }
    let rendered = sliced
        .iter()
        .enumerate()
        .map(|(i, l)| render_read_line(offset + i as u64 + 1, l))
        .collect::<Vec<_>>()
        .join("\n");
    let (out, footer) = if rendered.len() > max {
        let slice = byte_prefix(&rendered, max).to_owned();
        let shown_lines = slice.matches('\n').count() as u64;
        let emitted_end = offset + shown_lines;
        let next = (emitted_end < total).then_some(emitted_end + 1);
        (slice, window_marker("lines", offset + 1, emitted_end, Some(total), next, Some(max)))
    } else {
        let emitted_end = offset + sliced.len() as u64;
        let next = (emitted_end < total).then_some(emitted_end + 1);
        (rendered, window_marker("lines", offset + 1, emitted_end, Some(total), next, None))
    };
    format!("{out}{}{footer}", if out.is_empty() { "" } else { "\n" })
}

/// The streamed read of a window (`createReadLineCollector`): rows until the limit or until the
/// body budget, with a footer that knows no total.
fn stream_window(text: &str, file_size: u64, offset: u64, limit: u64, max_output: usize) -> String {
    let body_bytes = (max_output - (max_output / 3).min(384)).max(1);
    let mut lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if let Some(first) = lines.first_mut() {
        *first = first.strip_prefix('\u{feff}').unwrap_or(first);
    }
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let total = lines.len() as u64;
    let mut collected: Vec<String> = Vec::new();
    let (mut bytes, mut last_emitted) = (0_usize, 0_u64);
    let (mut truncated, mut stopped_at_limit) = (false, false);
    for (idx, line) in lines.iter().enumerate().skip(offset as usize) {
        // A line is collected up to 50 KiB; the display clips it further.
        let line = if line.len() > READ_MAX_LINE_COLLECT_BYTES {
            String::from_utf8_lossy(&line.as_bytes()[..READ_MAX_LINE_COLLECT_BYTES]).into_owned()
        } else {
            (*line).to_owned()
        };
        let row = render_read_line(idx as u64 + 1, &line);
        bytes += row.len() + 1;
        if bytes > body_bytes {
            truncated = true;
            break;
        }
        collected.push(row);
        last_emitted = idx as u64 + 1;
        if collected.len() as u64 >= limit {
            stopped_at_limit = true;
            break;
        }
    }
    let mut out = collected.join("\n");
    if truncated {
        let next = if last_emitted == 0 { offset } else { last_emitted } + 1;
        let of_file = if file_size > 0 { format!("{} KB file", (file_size as f64 / 1024.0).round().max(1.0) as u64) } else { String::new() };
        out.push_str(&format!("\n\n{}", cap_marker(&format_cap_size(max_output), &of_file, Some(next), "")));
    } else if stopped_at_limit {
        let shown = collected.len() as u64;
        out.push_str(&format!(
            "{}{}",
            if out.is_empty() { "" } else { "\n" },
            window_marker("lines", offset + 1, offset + shown, None, Some(offset + shown + 1), None)
        ));
    } else if out.is_empty() && offset >= total {
        out = format!("(no lines in range; file has {total} lines)");
    }
    out
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
