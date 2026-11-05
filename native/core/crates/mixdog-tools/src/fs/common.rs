//! Shared pieces of the file tools: spec loading, path resolution and display,
//! text decoding, output markers, cancellation/deadline guards.

use std::cmp::Ordering;
use std::future::Future;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use crate::git::path_locks::PathLocks;
use crate::git::path_locks::lock_paths;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::fs::FsError;
use mixdog_core_api::domain::fs::FsErrorKind;
use mixdog_core_api::domain::tool::ToolAnnotations;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolGroup;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;

/// Model-facing byte cap of one tool result.
pub(crate) const OUTPUT_MAX_BYTES: usize = 50 * 1024;
/// Model-facing byte cap of locator tools (find, glob, list).
pub(crate) const LOCATOR_MAX_BYTES: usize = 20 * 1024;
/// Model-facing byte cap of grep.
pub(crate) const GREP_MAX_BYTES: usize = 5 * 1024;

/// Directory names pruned unless `include_noise` is set.
pub(crate) const NOISE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".cache",
    ".parcel-cache",
    ".turbo",
    "venv",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".gradle",
];

/// Builds a [`ToolSpec`] from a published `tool-schemas` entry.
pub(crate) fn spec(
    raw: &str,
    description: &str,
    parallel_safe: bool,
    exclusive_group: Option<&str>,
) -> ToolSpec {
    let entry: JsonValue = serde_json::from_str(raw).expect("embedded tool spec is valid JSON");
    let ann = &entry["annotations"];
    let flag = |key: &str| ann.get(key).and_then(JsonValue::as_bool);
    ToolSpec {
        name: entry["name"].as_str().expect("spec name").to_owned(),
        aliases: Vec::new(),
        description: description.to_owned(),
        input_schema: entry["schema"].clone(),
        annotations: ToolAnnotations {
            title: ann.get("title").and_then(JsonValue::as_str).map(str::to_owned),
            read_only_hint: flag("readOnlyHint"),
            destructive_hint: flag("destructiveHint"),
            idempotent_hint: flag("idempotentHint"),
            open_world_hint: flag("openWorldHint"),
            compressible: flag("compressible"),
            compressible_lossless: flag("compressibleLossless"),
            agent_hidden: false,
        },
        parallel_safe,
        exclusive_with: exclusive_group
            .map(|g| vec![ToolGroup(g.to_owned())])
            .unwrap_or_default(),
    }
}

pub(crate) fn text_output(text: impl Into<String>) -> ToolOutput {
    ToolOutput {
        parts: vec![ToolPart::Text(text.into())],
        ..ToolOutput::default()
    }
}

/// An error whose model text is `message` (callers include the `Error: ` prefix).
pub(crate) fn fail(code: ToolErrorCode, message: impl Into<String>) -> ToolError {
    ToolError::new(code, message)
}

pub(crate) fn invalid(field: &str, reason: &str, message: impl Into<String>) -> ToolError {
    fail(
        ToolErrorCode::InvalidArgs {
            field: field.to_owned(),
            reason: reason.to_owned(),
        },
        message,
    )
}

pub(crate) fn cancelled() -> ToolError {
    fail(ToolErrorCode::Cancelled, "Error: tool call cancelled")
}

pub(crate) fn deadline_exceeded(name: &str, partial: bool) -> ToolError {
    fail(
        ToolErrorCode::DeadlineExceeded { partial },
        format!("Error: read-only I/O tool \"{name}\" timed out; narrow the scope and retry"),
    )
}

/// Maps a file-service failure to the typed error plus its model text.
pub(crate) fn fs_failure(err: &FsError, shown: &str) -> ToolError {
    match &err.kind {
        FsErrorKind::NotFound => fail(
            ToolErrorCode::NotFound {
                target: shown.to_owned(),
            },
            format!("Error: ENOENT: no such file or directory: {shown}"),
        ),
        FsErrorKind::PermissionDenied => fail(
            ToolErrorCode::PermissionDenied,
            format!("Error: EACCES: permission denied: {shown}"),
        ),
        FsErrorKind::OutcomeUnknown => {
            let mut e = fail(
                ToolErrorCode::OutcomeUnknown,
                format!("Error: {shown}: write outcome unknown; re-read before retrying"),
            );
            e.outcome_unknown = true;
            e
        }
        FsErrorKind::IsADirectory => fail(
            ToolErrorCode::Io { os_code: None },
            format!("Error: {shown} is a directory"),
        ),
        FsErrorKind::NotADirectory => fail(
            ToolErrorCode::Io { os_code: None },
            format!("Error: not a directory — {shown}"),
        ),
        FsErrorKind::Io { os_code } => fail(
            ToolErrorCode::Io { os_code: *os_code },
            format!("Error: I/O failure on {shown}"),
        ),
        other => fail(
            ToolErrorCode::Io { os_code: None },
            format!("Error: {other:?} on {shown}"),
        ),
    }
}

/// Runs `fut` until it ends, the call is cancelled, or the deadline passes.
pub(crate) async fn guarded<F: Future>(
    ctx: &ToolContext,
    name: &str,
    fut: F,
) -> Result<F::Output, ToolError> {
    let deadline = async {
        match ctx.deadline {
            Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await,
            None => std::future::pending().await,
        }
    };
    tokio::select! {
        out = fut => Ok(out),
        () = ctx.cancel.cancelled() => Err(cancelled()),
        () = deadline => Err(deadline_exceeded(name, false)),
    }
}

/// Takes the shared per-path locks (the ones a mutating git call holds on its work tree) for
/// every path a write tool changes, so concurrent sessions serialize on a path as in Node.
/// The guard must outlive the whole read-modify-write.
pub(crate) async fn lock_write_paths(ctx: &ToolContext, paths: &[&AbsPath]) -> Result<PathLocks, ToolError> {
    let raw: Vec<&Path> = paths.iter().map(|p| p.as_path()).collect();
    lock_paths(&raw, &ctx.cancel).await.ok_or_else(cancelled)
}

/// How a bounded pull ended.
pub(crate) enum PullEnd {
    Exhausted,
    Cancelled,
    Deadline,
}

/// Pulls `source` into `sink` until it ends, `sink` returns `false`, the call
/// is cancelled or the deadline passes. Dropping the source cancels it.
pub(crate) async fn pull_all<T: Send>(
    ctx: &ToolContext,
    source: &mut dyn EventSource<T>,
    mut sink: impl FnMut(T) -> bool,
) -> PullEnd {
    loop {
        let next = guarded(ctx, "pull", source.next()).await;
        match next {
            Ok(Some(item)) => {
                if !sink(item) {
                    return PullEnd::Exhausted;
                }
            }
            Ok(None) => return PullEnd::Exhausted,
            Err(e) if matches!(e.code, ToolErrorCode::Cancelled) => return PullEnd::Cancelled,
            Err(_) => return PullEnd::Deadline,
        }
    }
}

// ---- paths ----

/// Resolves a model-supplied path against the call's cwd, lexically.
pub(crate) fn resolve_path(cwd: &AbsPath, raw: &str) -> Result<AbsPath, ToolError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(invalid("path", "empty", "Error: path must not be empty"));
    }
    let joined = if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        cwd.as_path().join(trimmed)
    };
    let mut out = PathBuf::new();
    for comp in joined.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    AbsPath::new(out).ok_or_else(|| {
        invalid(
            "path",
            "not absolute",
            format!("Error: cannot resolve path {trimmed}"),
        )
    })
}

pub(crate) fn fwd(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Path shown to the model: relative to the cwd when inside it.
pub(crate) fn display_path(path: &Path, cwd: &AbsPath) -> String {
    match path.strip_prefix(cwd.as_path()) {
        Ok(rel) if !rel.as_os_str().is_empty() => fwd(rel),
        _ => fwd(path),
    }
}

/// Path relative to `root`; the absolute form when it escapes `root`.
pub(crate) fn display_under(path: &Path, root: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(rel) if !rel.as_os_str().is_empty() => fwd(rel),
        _ => fwd(path),
    }
}

pub(crate) fn has_glob_magic(s: &str) -> bool {
    s.contains(['*', '?', '[', '{'])
}

/// Directory entry order of `list`: case-insensitive, lowercase first on ties.
pub(crate) fn compare_names(a: &str, b: &str) -> Ordering {
    a.to_lowercase()
        .cmp(&b.to_lowercase())
        .then_with(|| b.cmp(a))
}

// ---- text ----

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) struct Codec {
    pub encoding: Encoding,
    pub bom: bool,
}

/// Strict decode: a BOM-declared UTF-16 body, or UTF-8 without NUL bytes.
/// `Err(reason)` is the typed `not_text` reason.
pub(crate) fn decode_text(bytes: &[u8]) -> Result<(String, Codec), String> {
    let utf16 = |body: &[u8], le: bool| -> Result<String, String> {
        if body.len() % 2 != 0 {
            return Err("utf16 body has an odd trailing byte".to_owned());
        }
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|p| {
                if le {
                    u16::from_le_bytes([p[0], p[1]])
                } else {
                    u16::from_be_bytes([p[0], p[1]])
                }
            })
            .collect();
        String::from_utf16(&units).map_err(|_| "invalid utf16".to_owned())
    };
    if let Some(body) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let codec = Codec {
            encoding: Encoding::Utf16Le,
            bom: true,
        };
        return utf16(body, true).map(|s| (s, codec));
    }
    if let Some(body) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let codec = Codec {
            encoding: Encoding::Utf16Be,
            bom: true,
        };
        return utf16(body, false).map(|s| (s, codec));
    }
    let (body, bom) = match bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        Some(rest) => (rest, true),
        None => (bytes, false),
    };
    if body.contains(&0) {
        return Err("nul_without_utf16_bom".to_owned());
    }
    match std::str::from_utf8(body) {
        Ok(s) => Ok((
            s.to_owned(),
            Codec {
                encoding: Encoding::Utf8,
                bom,
            },
        )),
        Err(e) => Err(format!("invalid_utf8@{}", e.valid_up_to())),
    }
}

pub(crate) fn encode_text(text: &str, codec: Codec) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 3);
    match codec.encoding {
        Encoding::Utf8 => {
            if codec.bom {
                out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            out.extend_from_slice(text.as_bytes());
        }
        Encoding::Utf16Le => {
            out.extend_from_slice(&[0xFF, 0xFE]);
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
        }
        Encoding::Utf16Be => {
            out.extend_from_slice(&[0xFE, 0xFF]);
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
        }
    }
    out
}

/// Longest prefix of `s` that fits in `max` bytes on a char boundary.
pub(crate) fn byte_prefix(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

// ---- markers ----

pub(crate) fn format_cap_size(bytes: usize) -> String {
    if bytes < 1024 {
        return format!("{bytes} bytes");
    }
    let kb = bytes as f64 / 1024.0;
    if kb.fract() == 0.0 {
        format!("{} KB", kb as u64)
    } else {
        format!("{kb:.1} KB")
    }
}

/// `[lines a-b of N; output capped at X; offset:K for more]`.
pub(crate) fn window_marker(
    unit: &str,
    from: u64,
    to: u64,
    total: Option<u64>,
    next_offset: Option<u64>,
    cap_bytes: Option<usize>,
) -> String {
    let of = total.map(|t| format!(" of {t}")).unwrap_or_default();
    let cap = cap_bytes
        .map(|c| format!("; output capped at {}", format_cap_size(c)))
        .unwrap_or_default();
    let more = next_offset
        .map(|n| format!("; offset:{n} for more"))
        .unwrap_or_default();
    format!("[{unit} {from}-{to}{of}{cap}{more}]")
}

/// `[output capped at X; shown; offset:N for more | narrow: ...]`.
pub(crate) fn cap_marker(
    limit: &str,
    shown: &str,
    next_offset: Option<u64>,
    narrow: &str,
) -> String {
    let mut parts = vec![format!("output capped at {limit}")];
    if !shown.is_empty() {
        parts.push(shown.to_owned());
    }
    if let Some(n) = next_offset {
        parts.push(format!("offset:{n} for more"));
    }
    if !narrow.is_empty() || next_offset.is_none() {
        let n = if narrow.is_empty() {
            "restrict the path, pattern or scope"
        } else {
            narrow
        };
        parts.push(format!("narrow: {n}"));
    }
    format!("[{}]", parts.join("; "))
}

/// Keeps whole lines of `text` within `max` bytes; the second value is the
/// number of lines dropped.
pub(crate) fn cap_lines(text: &str, max: usize) -> (String, usize) {
    if text.len() <= max {
        return (text.to_owned(), 0);
    }
    let mut kept = 0usize;
    let mut used = 0usize;
    let total = text.split('\n').count();
    for line in text.split('\n') {
        let add = line.len() + usize::from(kept > 0);
        if used + add > max {
            break;
        }
        used += add;
        kept += 1;
    }
    (
        text.split('\n').take(kept).collect::<Vec<_>>().join("\n"),
        total - kept,
    )
}

// ---- args ----

pub(crate) fn arg_str<'a>(args: &'a JsonValue, key: &str) -> Option<&'a str> {
    args.get(key).and_then(JsonValue::as_str)
}

pub(crate) fn arg_u64(args: &JsonValue, key: &str) -> Option<u64> {
    args.get(key).and_then(JsonValue::as_u64)
}

pub(crate) fn arg_bool(args: &JsonValue, key: &str) -> bool {
    args.get(key).and_then(JsonValue::as_bool).unwrap_or(false)
}

/// A string or array-of-strings argument.
pub(crate) fn arg_strings(args: &JsonValue, key: &str) -> Vec<String> {
    match args.get(key) {
        Some(JsonValue::String(s)) => vec![s.clone()],
        Some(JsonValue::Array(a)) => a
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}
