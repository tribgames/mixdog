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
use super::read_state::*;
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
            spec: spec(
                READ_SPEC,
                "Read files: line windows, several files at once, images, PDF and Office documents.",
                true,
                None,
            ),
            ext,
            images,
            state: None,
        }
    }
}

/// One requested window; `offset` is 0-based.
struct Entry {
    path: String,
    offset: u64,
    limit: u64,
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
        if let Some(state) = &self.state {
            state.ensure_scope(&scope_of(ctx)).await;
        }
        if public.single {
            let e = public.entries.remove(0);
            let top = Mode::Single { max_output: READ_MAX_OUTPUT_BYTES, raw: false, suppress: false };
            if has_glob_magic(&e.path) && !exists(ctx, &e.path).await {
                match self.survey(ctx, &e, SURVEY_BUDGET, true).await? {
                    Some(Survey::Many(results, capped)) => {
                        return Ok(ToolOutput { parts: survey_parts(&results, capped), ..ToolOutput::default() });
                    }
                    Some(Survey::One(one)) => {
                        let mode = Mode::Single { max_output: SURVEY_BUDGET, raw: false, suppress: false };
                        return self.single(ctx, &one, public.pages.as_deref(), mode).await;
                    }
                    None => {}
                }
            }
            return self.single(ctx, &e, public.pages.as_deref(), top).await;
        }
        let results = self.pipeline(ctx, public.entries, true, READ_MAX_OUTPUT_BYTES, true).await?;
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

/// What a glob that names nothing real expands to.
enum Survey {
    /// Several files: a batch of them, and whether more matched than the cap.
    Many(Vec<Resolved>, bool),
    /// One file: Node's one-element `path` array is a plain string, so it is read alone.
    One(Entry),
}

impl ReadTool {
    /// One top-level file read: the answer, and what it taught the session.
    async fn single(&self, ctx: &ToolContext, e: &Entry, pages: Option<&str>, mode: Mode) -> ToolOutcome {
        let body = self.read_one(ctx, e, pages, mode).await?;
        // An image read's empty, corrupt and over-cap answers are Node's `isError` results; in a
        // batch the same body marks only its own entry (`[error]`).
        if body.rich && body.failed() {
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

    /// `readGlobSurvey`: a magic path that names nothing becomes the batch of its newest matches.
    /// `None` when it matches nothing, so the raw pattern gets the single-read answer.
    async fn survey(&self, ctx: &ToolContext, e: &Entry, cap: usize, record: bool) -> Result<Option<Survey>, ToolError> {
        let (root, pattern) = split_glob(&e.path);
        let root = resolve_path(&ctx.cwd, &root)?;
        let (mut files, _) = glob_files(ctx, &root, &[pattern], false).await?;
        if files.is_empty() {
            return Ok(None);
        }
        files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let capped = files.len() > GLOB_SURVEY_FILES;
        files.truncate(GLOB_SURVEY_FILES);
        let mut entries: Vec<Entry> = files
            .into_iter()
            .map(|(p, _)| Entry { path: fwd(p.as_path()), offset: e.offset, limit: e.limit.min(GLOB_SURVEY_LINES) })
            .collect();
        if entries.len() == 1 {
            return Ok(Some(Survey::One(entries.remove(0))));
        }
        Ok(Some(Survey::Many(self.pipeline(ctx, entries, false, cap, record).await?, capped)))
    }

    /// The batch machinery (`executeBatchRead`): shape the entries, split the output budget over
    /// the distinct disk reads, read each, and cut every caller's window back out of its read.
    /// `object` entries come from the public form and are merged and coalesced; the survey's
    /// are read as they stand. `record` says whether what the reads saw reaches the session.
    fn pipeline<'a>(&'a self, ctx: &'a ToolContext, entries: Vec<Entry>, object: bool, cap: usize, record: bool) -> Pipeline<'a> {
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
            let mut bodies: Vec<Option<(CBody, Option<Observed>)>> = vec![None; firsts.len()];
            for at in order {
                let slot = &slots[firsts[at]];
                let (offset, limit) = slot.disk();
                let budget = allocated[at].max(256.0) as usize;
                let child = Entry { path: slot.entry.path.clone(), offset, limit };
                // An object batch holds what its reads saw until the windows are cut back out.
                let (body, seen) = self.child(ctx, &child, READ_MAX_OUTPUT_BYTES.min(budget), object, record).await?;
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
                    let body = match (&body, slot.slice) {
                        (CBody::Str(s), Some((offset, limit))) => CBody::Str(slice_read_body(s, offset, limit, 1)),
                        _ => body,
                    };
                    let path = if object { shown(&slots[firsts[producer]].entry.path) } else { shown(&slot.entry.path) };
                    Resolved { path, body, producer }
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
            if is_error_text(text) {
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
    async fn child(&self, ctx: &ToolContext, e: &Entry, max_output: usize, defer: bool, record: bool) -> Result<(CBody, Option<Observed>), ToolError> {
        if has_glob_magic(&e.path) && !exists(ctx, &e.path).await {
            // What a nested glob's reads saw is dropped by an object batch, as Node's is.
            match self.survey(ctx, e, max_output.min(SURVEY_BUDGET), record && !defer).await? {
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
                    let (body, seen) = self.child_read(ctx, &one, mode).await?;
                    if record && !defer {
                        self.record(ctx, seen.as_ref());
                    }
                    return Ok((body, None));
                }
                None => {}
            }
        }
        self.child_read(ctx, e, Mode::Child { max_output }).await
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
            return Ok(Body::text(format!("Error: {reason}: {raw}")));
        }
        let abs = resolve_path(&ctx.cwd, raw)?;
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
        let key_path = fwd(abs.as_path());
        let version = FileVersion::of(&stat);
        let scope = self.state.as_ref().map(|_| scope_of(ctx));
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
        }        let cache_key = version.map(|v| {
            format!(
                "read|{key_path}|{}|{}|{}|{}|{}|s|base:1|budget:{}",
                v.mtime_ms,
                v.ctime_ms.map_or_else(|| "-".to_owned(), |c| c.to_string()),
                v.size,
                e.offset,
                e.limit,
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
        // A batch child streams its window, as does any file over 128 KiB; a UTF-16 body is always
        // decoded whole and read buffered, with its total in the footer.
        let stream = !utf16 && (mode.force_stream() || stat.len > READ_STREAM_RANGE_MIN_BYTES);
        let (numbered, meta) = if stream {
            let (out, facts) = stream_window(&text, stat.len, e.offset, e.limit, mode.max_output());
            let ranges = if facts.first_emitted > 0 && facts.last_emitted > 0 {
                vec![LineRange { start: facts.first_emitted, end: Some(facts.last_emitted) }]
            } else {
                Vec::new()
            };
            (out, SnapshotMeta { ranges: Some(ranges), ..SnapshotMeta::new("read_stream_range") })
        } else {
            let (out, facts) = buffered_window(&text, e.offset, e.limit, &shown, mode.max_output());
            let full_view = e.offset == 0 && e.offset + e.limit >= facts.line_count && !facts.byte_capped;
            let ranges = if full_view {
                vec![LineRange::WHOLE]
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
        let tail = if stat.len > head_len && stat.len > 4096 { read_range(ctx, abs, shown, stat.len - 4096, 4096).await? } else { Vec::new() };
        let observe = |meta: SnapshotMeta| version.map(|v| Observed { path: key_path.clone(), version: v, meta });
        if head.contains(&0) || tail.contains(&0) {
            let preview = &head[..head.len().min(BINARY_PREVIEW_BYTES)];
            let meta = SnapshotMeta { ranges: Some(Vec::new()), ..SnapshotMeta::new("read_hex") };
            return Ok(Body { observed: observe(meta), ..Body::text(binary_preview(shown, preview, stat.len)) });
        }
        let mut c = Collector::new(stat.len, e.offset, e.limit, mode.max_output());
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
    /// First and last line number a streamed window emitted (1-based; 0 when none).
    first_emitted: u64,
    last_emitted: u64,
}

/// The buffered read of a window (`renderReadWindow`): numbered rows with the total in the footer,
/// cut by bytes (mid-row, as Node cuts) when they pass the output cap.
fn buffered_window(text: &str, offset: u64, limit: u64, shown: &str, max: usize) -> (String, WindowFacts) {
    let facts = |line_count, rendered, byte_capped| WindowFacts { line_count, rendered, byte_capped, first_emitted: 0, last_emitted: 0 };
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
    let end = (offset + limit).min(total);
    let sliced: &[&str] = if offset < end { &lines[offset as usize..end as usize] } else { &[] };
    if sliced.is_empty() && offset >= total {
        return (format!("(no lines in range; file has {total} lines)"), facts(total, 0, false));
    }
    let rendered = sliced
        .iter()
        .enumerate()
        .map(|(i, l)| render_read_line(offset + i as u64 + 1, l))
        .collect::<Vec<_>>()
        .join("\n");
    let (out, footer, shown_lines, capped) = if rendered.len() > max {
        let slice = byte_prefix(&rendered, max).to_owned();
        let shown_lines = slice.matches('\n').count() as u64;
        let emitted_end = offset + shown_lines;
        let next = (emitted_end < total).then_some(emitted_end + 1);
        (slice, window_marker("lines", offset + 1, emitted_end, Some(total), next, Some(max)), shown_lines, true)
    } else {
        let emitted_end = offset + sliced.len() as u64;
        let next = (emitted_end < total).then_some(emitted_end + 1);
        (rendered, window_marker("lines", offset + 1, emitted_end, Some(total), next, None), sliced.len() as u64, false)
    };
    (format!("{out}{}{footer}", if out.is_empty() { "" } else { "\n" }), facts(total, shown_lines, capped))
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
}

impl Collector {
    fn new(file_size: u64, offset: u64, limit: u64, max_output: usize) -> Self {
        Self {
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
            let next = if self.last_emitted == 0 { offset } else { self.last_emitted } + 1;
            let of_file = if self.file_size > 0 { format!("{} KB file", (self.file_size as f64 / 1024.0).round().max(1.0) as u64) } else { String::new() };
            out.push_str(&format!("\n\n{}", cap_marker(&format_cap_size(self.max_output), &of_file, Some(next), "")));
        } else if self.stopped_at_limit {
            let shown = self.collected.len() as u64;
            out.push_str(&format!(
                "{}{}",
                if out.is_empty() { "" } else { "\n" },
                window_marker("lines", offset + 1, offset + shown, None, Some(offset + shown + 1), None)
            ));
        } else if out.is_empty() && offset >= self.line_idx {
            out = format!("(no lines in range; file has {} lines)", self.line_idx);
        }
        (out, WindowFacts { line_count: 0, rendered: 0, byte_capped: false, first_emitted: self.first_emitted, last_emitted: self.last_emitted })
    }
}

/// The streamed read of a window of text already in memory.
fn stream_window(text: &str, file_size: u64, offset: u64, limit: u64, max_output: usize) -> (String, WindowFacts) {
    let mut lines = text.split('\n').collect::<Vec<_>>();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let mut c = Collector::new(file_size, offset, limit, max_output);
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
