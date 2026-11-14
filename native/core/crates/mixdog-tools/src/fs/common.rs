//! Shared pieces of the file tools: path resolution and display,
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
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_protocol::JsonValue;
use mixdog_rt::LaneToken;

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

/// [`NOISE_DIRS`] as a walk's `Descent::bare`: each noise folder listed, never entered.
pub(crate) fn noise_bare() -> Vec<String> {
    NOISE_DIRS.iter().map(|n| (*n).to_owned()).collect()
}

/// The result's `meta` keys the run's trace row reads (Node's `resultTelemetry` and `localSearchTelemetry` objects of
/// the call, `agent-trace-format.mjs` `traceAgentTool`); never model text.
pub const RESULT_TELEMETRY_META: &str = "resultTelemetry";
pub const LOCAL_SEARCH_META: &str = "localSearchTelemetry";

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

/// The optional scope `key` of list, find or glob as Node's argument guard leaves it (arg-guard.mjs
/// `validateBuiltinArgs`): null and a blank string are absent (the cwd); an array is flattened one level with null and
/// blank entries dropped, and is absent when that left nothing of a non-empty array; any other value, an array included,
/// is refused with `refusal(<type>)`.
pub(crate) fn optional_path_arg<'a>(args: &'a JsonValue, key: &str, refusal: impl Fn(&str) -> String) -> Result<Option<&'a str>, ToolError> {
    let blank = |v: &JsonValue| v.is_null() || v.as_str().is_some_and(|s| mixdog_js::js_trim(s).is_empty());
    match args.get(key) {
        None | Some(JsonValue::Null) => Ok(None),
        Some(JsonValue::String(s)) => Ok((!mixdog_js::js_trim(s).is_empty()).then_some(s.as_str())),
        Some(JsonValue::Array(items))
            if !items.is_empty()
                && items.iter().flat_map(|item| item.as_array().map_or(std::slice::from_ref(item), Vec::as_slice)).all(blank) =>
        {
            Ok(None)
        }
        Some(other) => Err(invalid(key, "type", refusal(super::read_legacy::describe_type(other)))),
    }
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
        // The OS error by libuv's name, as Node's message starts with it; one the name table does not
        // know keeps the plain I/O text rather than claiming an unknown error.
        FsErrorKind::Io { .. } | FsErrorKind::AlreadyExists => {
            let os_code = if let FsErrorKind::Io { os_code } = &err.kind { *os_code } else { None };
            let text = match super::os_error::cause(&err.kind) {
                Some(cause) => format!("Error: {cause}: {shown}"),
                None => format!("Error: I/O failure on {shown}"),
            };
            fail(ToolErrorCode::Io { os_code }, text)
        }
        other => fail(
            ToolErrorCode::Io { os_code: None },
            format!("Error: {other:?} on {shown}"),
        ),
    }
}

/// [`fs_failure`]'s typed error for `err`, with Node's wording of the failed call as its text.
pub(crate) fn fs_failure_worded(err: &FsError, shown: &str, text: String) -> ToolError {
    ToolError { message_for_model: text, ..fs_failure(err, shown) }
}

/// Runs `fut` until it ends, the call is cancelled, or the deadline passes.
pub(crate) async fn guarded<F: Future>(
    ctx: &ToolContext,
    name: &str,
    fut: F,
) -> Result<F::Output, ToolError> {
    let deadline = async {
        match ctx.deadline {
            Some(at) => mixdog_rt::time::sleep_until(tokio::time::Instant::from_std(at)).await,
            None => std::future::pending().await,
        }
    };
    tokio::select! {
        out = fut => Ok(out),
        () = ctx.cancel.cancelled() => Err(cancelled()),
        () = deadline => Err(deadline_exceeded(name, false)),
    }
}

/// What a write tool holds for its whole read-modify-write: the shared per-path locks (the ones a
/// mutating git call holds on its work tree) and Node's cross-process advisory lock. The advisory
/// lock is released first.
#[must_use = "the paths stay locked while the guard lives"]
pub(crate) struct WriteLocks {
    _advisory: super::advisory::Advisory,
    _paths: PathLocks,
}

/// Node `withBuiltinPathLocks(lockPaths, () => withAdvisoryLocks(lockPaths, …))` of `apply_patch`.
/// Each target's real location joins the in-process set, the key `edit` holds, so two routes to
/// one file (a junction and its referent) queue here and never poll the advisory file.
pub(crate) async fn lock_patch_targets(ctx: &ToolContext, targets: &[AbsPath]) -> Result<WriteLocks, ToolError> {
    let mut keys: Vec<PathBuf> = targets.iter().map(|t| t.as_path().to_path_buf()).collect();
    for target in targets {
        keys.extend(real_target_on_lane(ctx, target.as_path()).await?);
    }
    let refs: Vec<&Path> = keys.iter().map(PathBuf::as_path).collect();
    let paths = lock_paths(&refs, &ctx.cancel).await.ok_or_else(cancelled)?;
    let given: Vec<&Path> = targets.iter().map(AbsPath::as_path).collect();
    let advisory = super::advisory::lock(ctx, &given).await?;
    if ctx.cancel.is_cancelled() {
        return Err(cancelled());
    }
    Ok(WriteLocks { _advisory: advisory, _paths: paths })
}

/// Node `realpathNearestExisting`: the nearest existing ancestor of `full` (itself included) and
/// its real path. `None` when nothing on the path exists or cannot be resolved.
#[allow(clippy::disallowed_methods, reason = "runs only as an interactive-lane job body (real_target_on_lane, resolve_write_target)")]
fn nearest_existing(full: &Path) -> Option<(&Path, PathBuf)> {
    let mut probe = full;
    while !probe.exists() {
        probe = probe.parent().filter(|p| *p != probe)?;
    }
    // Node's `realpathSync` has no `\\?\` prefix, and the lock key must read like the other tools'.
    Some((probe, mixdog_workspace::pathguard::canonical(probe).ok()?))
}

/// [`nearest_existing`] joined back to the missing tail: the target with its nearest existing
/// ancestor resolved through symlinks and junctions.
fn real_target(full: &Path) -> Option<PathBuf> {
    let (probe, real) = nearest_existing(full)?;
    Some(real.join(full.strip_prefix(probe).ok()?))
}

/// Node `guardWritePath`'s refusal of `p`, which it shows as `normalizeOutputPath` does.
fn write_path_refusal(p: &str) -> Option<String> {
    super::read_paths::write_guard(p).map(|reason| format!("Error: {reason}: {}", super::patch_guard::normalize_output_path(p)))
}

/// Node `guardRealTarget`: when a link lies on the way to the target's nearest existing ancestor
/// (the target itself when it exists), the real path it leads to meets `guardWritePath`; a special
/// file is refused.
#[allow(clippy::disallowed_methods, reason = "runs only as an interactive-lane job body (resolve_write_target)")]
fn guard_real_target(full: &Path) -> Option<String> {
    if let Some((probe, real)) = nearest_existing(full)
        // Node's `realpathSync` follows links only: a mapped drive's share is no link's target.
        && probe.ancestors().any(|p| std::fs::symlink_metadata(p).is_ok_and(|meta| meta.file_type().is_symlink()))
        && let Some(refusal) = write_path_refusal(&real.to_string_lossy())
    {
        return Some(format!("{refusal} (symlink target of {})", super::patch_guard::normalize_output_path(&probe.to_string_lossy())));
    }
    let special = std::fs::metadata(full).is_ok_and(|meta| mixdog_js::device_paths::is_special_file(&meta));
    special.then(|| {
        format!(
            "Error: cannot write special file (FIFO / character / block device / socket): {}",
            super::patch_guard::normalize_output_path(&full.to_string_lossy())
        )
    })
}

/// Node `resolveTargetPath` of the edit adapter: the spelling given (normalized) and its
/// resolution against the cwd each meet `guardWritePath`, then [`guard_real_target`], before
/// anything else touches the path. A blank spelling is the cwd.
pub(crate) async fn resolve_write_target(ctx: &ToolContext, raw: &str) -> Result<AbsPath, ToolError> {
    // A refusal, not malformed arguments: Node's `_isToolArgShapeFailure` does not count it.
    let refuse = |text: String| crate::orch::util::refused("write-path-guard", text);
    if let Some(text) = write_path_refusal(&super::normalize_input_path(raw)) {
        return Err(refuse(text));
    }
    let abs = if mixdog_js::js_trim(raw).is_empty() { ctx.cwd.clone() } else { resolve_path(&ctx.cwd, raw)? };
    if let Some(text) = write_path_refusal(&abs.as_path().to_string_lossy()) {
        return Err(refuse(text));
    }
    let full = abs.as_path().to_path_buf();
    let job = ctx.io.interactive.submit(&ctx.cancel, move |_| guard_real_target(&full)).map_err(|_| cancelled())?;
    match job.await.map_err(|_| cancelled())? {
        Some(text) => Err(refuse(text)),
        None => Ok(abs),
    }
}

/// [`real_target`] as a job on the interactive lane.
async fn real_target_on_lane(ctx: &ToolContext, full: &Path) -> Result<Option<PathBuf>, ToolError> {
    let target = full.to_path_buf();
    let job = ctx.io.interactive.submit(&ctx.cancel, move |_| real_target(&target)).map_err(|_| cancelled())?;
    job.await.map_err(|_| cancelled())
}

/// The locks `edit` takes: the target and where it really lives, so two routes to one file (a
/// symlink and its referent) serialize. Once held, the real location is resolved again; a target
/// that moved while the locks were awaited is refused, as in Node's `withEditTargetLock`.
pub(crate) async fn lock_edit_target(ctx: &ToolContext, target: &AbsPath) -> Result<WriteLocks, ToolError> {
    let unresolved = || invalid("file_path", "unresolvable", "Error: cannot resolve edit target for locking");
    let real = real_target_on_lane(ctx, target.as_path()).await?.ok_or_else(unresolved)?;
    let paths = lock_paths(&[target.as_path(), real.as_path()], &ctx.cancel).await.ok_or_else(cancelled)?;
    let advisory = super::advisory::lock(ctx, &[real.as_path()]).await?;
    if ctx.cancel.is_cancelled() {
        return Err(cancelled());
    }
    let locks = WriteLocks { _advisory: advisory, _paths: paths };
    if real_target_on_lane(ctx, target.as_path()).await?.as_deref() != Some(real.as_path()) {
        return Err(fail(
            ToolErrorCode::Stale { expected: real.display().to_string(), actual: "moved".to_owned() },
            "Error: edit target changed while acquiring its lock",
        ));
    }
    Ok(locks)
}

/// How a bounded pull ended.
pub(crate) enum PullEnd {
    Exhausted,
    Cancelled,
    Deadline,
    /// The pull's own timer passed first ([`pull_until`]).
    Timer,
}

/// [`pull_all`], ended also by `timer`.
pub(crate) async fn pull_until<T: Send>(
    ctx: &ToolContext,
    source: &mut dyn EventSource<T>,
    timer: impl Future<Output = ()>,
    mut sink: impl FnMut(T) -> bool,
) -> PullEnd {
    let mut timer = std::pin::pin!(timer);
    let end = loop {
        let next = tokio::select! {
            biased;
            next = guarded(ctx, "pull", source.next()) => next,
            () = &mut timer => break PullEnd::Timer,
        };
        match next {
            Ok(Some(item)) => {
                if !sink(item) {
                    break PullEnd::Exhausted;
                }
            }
            Ok(None) => break PullEnd::Exhausted,
            Err(e) if matches!(e.code, ToolErrorCode::Cancelled) => break PullEnd::Cancelled,
            Err(_) => break PullEnd::Deadline,
        }
    };
    let _ = guarded(ctx, "close", source.close()).await;
    end
}

/// Pulls `source` into `sink` until it ends, `sink` returns `false`, the call
/// is cancelled or the deadline passes, then closes it within the same
/// deadline and cancellation, as Node ends its search child. The source's
/// `close` says what has ended when it returns; one the deadline or the
/// cancellation cuts short is dropped, which stops its producer without
/// waiting for it.
pub(crate) async fn pull_all<T: Send>(
    ctx: &ToolContext,
    source: &mut dyn EventSource<T>,
    sink: impl FnMut(T) -> bool,
) -> PullEnd {
    pull_until(ctx, source, std::future::pending(), sink).await
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

/// Node `extractGlobBaseDirectory`: the directory written before the first wildcard (none when the
/// pattern starts in its first segment) and the rest of the pattern, without leading slashes.
pub(crate) fn extract_glob_base_directory(pattern: &str) -> (Option<String>, String) {
    let wild = pattern.find(['*', '?', '[', '{']).unwrap_or(pattern.len());
    let Some(sep) = pattern[..wild].rfind(['/', '\\']) else {
        return (None, pattern.to_owned());
    };
    let mut base = pattern[..sep].to_owned();
    if cfg!(windows) && base.len() == 2 && base.as_bytes()[0].is_ascii_alphabetic() && base.as_bytes()[1] == b':' {
        base.push('\\');
    }
    let rest = pattern[sep + 1..].trim_start_matches('/').to_owned();
    ((!base.is_empty()).then_some(base), rest)
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
            if codec.bom {
                out.extend_from_slice(&[0xFF, 0xFE]);
            }
            for u in text.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
        }
        Encoding::Utf16Be => {
            if codec.bom {
                out.extend_from_slice(&[0xFE, 0xFF]);
            }
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
