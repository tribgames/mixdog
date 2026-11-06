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
use super::search::glob_files;

const READ_SPEC: &str = include_str!("specs/read.json");
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// Node's inline-view cap, the refusal when there is no resizer (`MAX_IMAGE_BYTES`).
const IMAGE_MAX_BYTES: usize = 3_750_000;
/// The hard API ceiling on an inline image's base64 length (`API_IMAGE_MAX_BASE64_SIZE`).
const IMAGE_MAX_BASE64: usize = 5 * 1024 * 1024;
const DEFAULT_LINES: u64 = 500;
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

struct Entry {
    path: String,
    offset: Option<u64>,
    limit: Option<u64>,
}

/// One entry's result: text, or text plus media parts.
#[derive(Default)]
struct Body {
    parts: Vec<ToolPart>,
    /// An image read's result (Node's structured { content }), which a batch keeps as blocks.
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
        self.first_text().starts_with("Error:")
    }
    fn absent(&self) -> bool {
        self.first_text().trim_start().starts_with("[path absent]")
    }
}

fn parse_entries(args: &JsonValue) -> Result<Vec<Entry>, ToolError> {
    let top_offset = arg_u64(args, "offset");
    let top_limit = arg_u64(args, "limit");
    let raw = args
        .get("file_path")
        .ok_or_else(|| invalid("file_path", "required", "Error: read requires file_path"))?;
    let mk = |path: &str, offset: Option<u64>, limit: Option<u64>| Entry {
        path: path.to_owned(),
        offset: offset.or(top_offset),
        limit: limit.or(top_limit),
    };
    Ok(match raw {
        JsonValue::String(s) => vec![mk(s, None, None)],
        JsonValue::Array(items) => items
            .iter()
            .filter_map(|v| match v {
                JsonValue::String(s) => Some(mk(s, None, None)),
                JsonValue::Object(o) => Some(mk(
                    o.get("file_path")?.as_str()?,
                    o.get("offset").and_then(JsonValue::as_u64),
                    o.get("limit").and_then(JsonValue::as_u64),
                )),
                _ => None,
            })
            .collect(),
        _ => return Err(invalid("file_path", "type", "Error: read requires file_path")),
    })
}

#[async_trait]
impl Tool for ReadTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let pages = arg_str(&args, "pages").map(str::to_owned);
        let mut entries = parse_entries(&args)?;
        let single = matches!(args.get("file_path"), Some(JsonValue::String(_)));
        if single && has_glob_magic(&entries[0].path) {
            let survey = self.glob_survey(ctx, &entries[0]).await?;
            entries = survey;
            return self.batch(ctx, entries, pages.as_deref(), true).await;
        }
        if single {
            let e = &entries[0];
            let body = self.read_one(ctx, e, pages.as_deref(), DEFAULT_LINES).await?;
            return Ok(ToolOutput {
                parts: body.parts,
                ..ToolOutput::default()
            });
        }
        self.batch(ctx, entries, pages.as_deref(), false).await
    }
}

impl ReadTool {
    async fn glob_survey(&self, ctx: &ToolContext, e: &Entry) -> Result<Vec<Entry>, ToolError> {
        let (root, pattern) = split_glob(&e.path);
        let root = resolve_path(&ctx.cwd, &root)?;
        let (mut files, _) = glob_files(ctx, &root, &[pattern], false).await?;
        files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        files.truncate(GLOB_SURVEY_FILES);
        Ok(files
            .into_iter()
            .map(|(p, _)| Entry {
                path: fwd(p.as_path()),
                offset: e.offset,
                limit: e.limit.or(Some(GLOB_SURVEY_LINES)),
            })
            .collect())
    }

    async fn batch(
        &self,
        ctx: &ToolContext,
        entries: Vec<Entry>,
        pages: Option<&str>,
        survey: bool,
    ) -> ToolOutcome {
        let mut results: Vec<(String, Body)> = Vec::new();
        for e in &entries {
            let default = if survey { GLOB_SURVEY_LINES } else { DEFAULT_LINES };
            let body = self.read_one(ctx, e, pages, default).await?;
            let shown = match resolve_path(&ctx.cwd, &e.path) {
                Ok(p) => display_path(p.as_path(), &ctx.cwd),
                Err(_) => e.path.clone(),
            };
            results.push((shown, body));
        }
        let failed = results.iter().filter(|(_, b)| b.failed()).count();
        let header = if failed > 0 {
            format!("read {} ({failed} failed)", results.len())
        } else {
            format!("read {}", results.len())
        };
        if results.iter().any(|(_, b)| b.rich) {
            return Ok(ToolOutput { parts: rich_batch(&header, &results), ..ToolOutput::default() });
        }
        let mut parts = Vec::new();
        let mut seen: Vec<(usize, String, String)> = Vec::new();
        let mut text = header;
        for (i, (path, body)) in results.iter().enumerate() {
            let status = if body.failed() {
                "error"
            } else if body.absent() {
                "absent"
            } else {
                "ok"
            };
            let first = body.first_text().to_owned();
            text.push_str("\n\n");
            if let Some((idx, _, _)) = seen.iter().find(|(_, p, b)| p == path && *b == first) {
                text.push_str(&format!(
                    "{path} [{status}] [= entry #{}, identical result omitted]",
                    idx + 1
                ));
                continue;
            }
            seen.push((i, path.clone(), first.clone()));
            text.push_str(&format!("{path} [{status}]\n{first}"));
            if body.parts.len() > 1 {
                parts.push(ToolPart::Text(std::mem::take(&mut text)));
                parts.extend(body.parts.iter().skip(1).cloned());
            }
        }
        if !text.is_empty() {
            parts.push(ToolPart::Text(text));
        }
        Ok(ToolOutput {
            parts,
            ..ToolOutput::default()
        })
    }

    async fn read_one(
        &self,
        ctx: &ToolContext,
        e: &Entry,
        pages: Option<&str>,
        default_lines: u64,
    ) -> Result<Body, ToolError> {
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
        Ok(Body::text(render_window(
            &text,
            e.offset.unwrap_or(0),
            e.limit.unwrap_or(default_lines),
            &shown,
        )))
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

/// `renderRichBatch`: a batch holding an image result stays structured. The header, then per
/// entry its path [status] line and its blocks as they are; an identical repeat collapses to a
/// reference.
fn rich_batch(header: &str, results: &[(String, Body)]) -> Vec<ToolPart> {
    let mut parts = vec![ToolPart::Text(header.to_owned())];
    let mut seen: Vec<(usize, &str, &str)> = Vec::new();
    for (i, (path, body)) in results.iter().enumerate() {
        let status = if body.failed() {
            "error"
        } else if body.absent() {
            "absent"
        } else {
            "ok"
        };
        let first = body.first_text();
        let entry_header = format!("{path} [{status}]");
        if let Some((idx, _, _)) = seen.iter().find(|(_, p, b)| *p == path && *b == first) {
            parts.push(ToolPart::Text(format!("{entry_header} [= entry #{}, identical result omitted]", idx + 1)));
            continue;
        }
        seen.push((i, path, first));
        parts.push(ToolPart::Text(entry_header));
        parts.extend(body.parts.iter().cloned());
    }
    parts
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

/// Renders lines `[offset, offset+limit)` (0-based offset) with run marker and footer.
fn render_window(text: &str, offset: u64, limit: u64, shown: &str) -> String {
    if text.is_empty() {
        return format!("<system-reminder>File exists but has empty contents: {}</system-reminder>",
            shown.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;"));
    }
    let mut lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let total = lines.len() as u64;
    if offset >= total {
        return format!("(no lines in range; file has {total} lines)");
    }
    let end = (offset + limit).min(total);
    let mut rows = Vec::new();
    let mut bytes = 0usize;
    let mut capped = false;
    for line in &lines[offset as usize..end as usize] {
        let row = clip_line(line);
        bytes += row.len() + 1;
        if bytes > OUTPUT_MAX_BYTES {
            capped = true;
            break;
        }
        rows.push(row);
    }
    if rows.is_empty() {
        // A single line over the cap: keep its prefix so the window is never empty.
        rows.push(byte_prefix(&clip_line(lines[offset as usize]), OUTPUT_MAX_BYTES).to_owned());
        capped = true;
    }
    let emitted_end = offset + rows.len() as u64;
    let next = (emitted_end < total).then_some(emitted_end);
    let footer = window_marker(
        "lines",
        offset + 1,
        emitted_end,
        Some(total),
        next,
        capped.then_some(OUTPUT_MAX_BYTES),
    );
    format!("[lines {}-{}]\n{}\n{footer}", offset + 1, emitted_end, rows.join("\n"))
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
