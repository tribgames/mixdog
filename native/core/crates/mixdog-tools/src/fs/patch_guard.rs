//! The safety net around a patch write, as Node's `content-guard` / `rollback-state` /
//! `delete-quarantine` build it: bounded reads that refuse binary or oversized text, the pre-patch
//! snapshot of every touched path, the restore that undoes a failed batch, and the quarantine
//! rename that makes deleting an unsnapshotted file atomic. Every `std::fs` call here is the body
//! of a durability-lane job.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "every std::fs call in this module is the body of a durability-lane job (on_lane)"
)]

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_rt::LaneToken;

use super::common::*;

const MIB: u64 = 1024 * 1024;
/// A text file `apply_patch` may edit, rename and snapshot (`PATCH_EDIT_MAX_BYTES`).
pub(super) const EDIT_MAX_BYTES: u64 = 64 * MIB;
/// A file the snapshot reads for a delete (`PATCH_SNAPSHOT_MAX_BYTES`).
pub(super) const SNAPSHOT_MAX_BYTES: u64 = 8 * MIB;
/// Bytes one patch transaction's snapshots may hold together (`PATCH_EDIT_BUDGET_BYTES`).
const EDIT_BUDGET_BYTES: u64 = 2 * EDIT_MAX_BYTES;

/// Runs blocking work as a durability-lane job.
pub(super) async fn on_lane<R: Send + 'static>(ctx: &ToolContext, work: impl FnOnce() -> R + Send + 'static) -> Result<R, ToolError> {
    let job = ctx.io.durability.submit_wait(&ctx.cancel, move |_| work()).await.map_err(|_| cancelled())?;
    job.await.map_err(|_| cancelled())
}

/// `normalizeOutputPath`: on Windows backslashes become slashes and the drive letter is upper-case.
pub(super) fn normalize_output_path(path: &str) -> String {
    if !cfg!(windows) {
        return path.to_owned();
    }
    let mut text = path.replace('\\', "/");
    if text.as_bytes().get(1) == Some(&b':') && text.as_bytes()[0].is_ascii_lowercase() {
        text[..1].make_ascii_uppercase();
    }
    text
}

fn key(path: &Path) -> String {
    mixdog_scm::locks::path_key(path)
}

// ---- codec (Node `detectTextCodec`) ----

pub(super) struct Detected {
    pub encoding: Option<Encoding>,
    pub bom_len: usize,
    pub certain: bool,
}

/// A BOM is authoritative; a BOM-less file is classified by NUL-byte parity, which separates
/// UTF-16 text from UTF-8 text. `certain: false` means the bytes cannot be attributed to one codec.
pub(super) fn detect_text_codec(bytes: &[u8]) -> Detected {
    let undecidable = Detected { encoding: None, bom_len: 0, certain: false };
    match bytes {
        [0xFF, 0xFE, ..] => return Detected { encoding: Some(Encoding::Utf16Le), bom_len: 2, certain: true },
        [0xFE, 0xFF, ..] => return Detected { encoding: Some(Encoding::Utf16Be), bom_len: 2, certain: true },
        [0xEF, 0xBB, 0xBF, ..] => return Detected { encoding: Some(Encoding::Utf8), bom_len: 3, certain: true },
        _ => {}
    }
    let (mut nul_even, mut nul_odd) = (0usize, 0usize);
    for (i, b) in bytes.iter().enumerate() {
        if *b == 0 {
            if i % 2 == 0 {
                nul_even += 1;
            } else {
                nul_odd += 1;
            }
        }
    }
    if nul_even == 0 && nul_odd == 0 {
        return Detected { encoding: Some(Encoding::Utf8), bom_len: 0, certain: true };
    }
    if bytes.len() < 32 || bytes.len() % 2 != 0 {
        return undecidable;
    }
    let even_slots = bytes.len().div_ceil(2) as f64;
    let odd_slots = (bytes.len() / 2) as f64;
    if nul_even == 0 && nul_odd as f64 / odd_slots >= 0.5 {
        return Detected { encoding: Some(Encoding::Utf16Le), bom_len: 0, certain: true };
    }
    if nul_odd == 0 && nul_even as f64 / even_slots >= 0.5 {
        return Detected { encoding: Some(Encoding::Utf16Be), bom_len: 0, certain: true };
    }
    undecidable
}

/// Binary = NUL bytes the text codec cannot attribute.
fn looks_binary(content: &[u8]) -> bool {
    content.contains(&0) && !detect_text_codec(content).certain
}

/// Node `decodePatchTargetBuffer`: the text and the codec to write it back in. The `Err` reasons
/// are the ones `decode_message` words.
pub(super) fn decode_patch_target(bytes: &[u8]) -> Result<(String, Codec), String> {
    let detected = detect_text_codec(bytes);
    let Some(encoding) = detected.encoding.filter(|_| detected.certain) else { return Err("nul_without_utf16_bom".to_owned()) };
    let body = &bytes[detected.bom_len..];
    let codec = Codec { encoding, bom: detected.bom_len > 0 };
    let text = match encoding {
        Encoding::Utf8 => std::str::from_utf8(body).map_err(|e| format!("invalid_utf8@{}", e.valid_up_to()))?.to_owned(),
        Encoding::Utf16Le | Encoding::Utf16Be => {
            if body.len() % 2 != 0 {
                return Err("utf16 body has an odd trailing byte".to_owned());
            }
            let units: Vec<u16> = body
                .chunks_exact(2)
                .map(|p| if encoding == Encoding::Utf16Le { u16::from_le_bytes([p[0], p[1]]) } else { u16::from_be_bytes([p[0], p[1]]) })
                .collect();
            String::from_utf16_lossy(&units)
        }
    };
    Ok((text, codec))
}

// ---- bounded reads (Node `readBoundedFile`) ----

pub(super) struct Omitted {
    pub reason: &'static str,
    pub size: u64,
    pub stat_size: u64,
    pub limit: u64,
    pub modified: Option<SystemTime>,
}

pub(super) enum Bounded {
    Absent,
    Present { content: Vec<u8>, perms: fs::Permissions },
    Omitted(Omitted),
    Classified,
}

pub(super) enum ReadFail {
    NotRegular,
    Io(String),
}

fn io_code(error: &std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::PermissionDenied => "EACCES".to_owned(),
        std::io::ErrorKind::NotFound => "ENOENT".to_owned(),
        _ => error.to_string(),
    }
}

struct Budget {
    remaining: u64,
    total: u64,
}

fn bounded_read(path: &Path, max: u64, mut budget: Option<&mut Budget>, classify_only: bool, detect_binary: bool) -> Result<Bounded, ReadFail> {
    let absent = |e: &std::io::Error| matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory);
    let stat = match fs::metadata(path) {
        Ok(s) => s,
        Err(e) if absent(&e) => return Ok(Bounded::Absent),
        Err(e) => return Err(ReadFail::Io(io_code(&e))),
    };
    if !stat.is_file() {
        return Err(ReadFail::NotRegular);
    }
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if absent(&e) => return Ok(Bounded::Absent),
        Err(e) => return Err(ReadFail::Io(io_code(&e))),
    };
    let meta = file.metadata().map_err(|e| ReadFail::Io(io_code(&e)))?;
    if !meta.is_file() {
        return Err(ReadFail::NotRegular);
    }
    let omitted = |reason: &'static str, size: u64, budget_total: Option<u64>| {
        Bounded::Omitted(Omitted { reason, size, stat_size: meta.len(), limit: budget_total.unwrap_or(max), modified: meta.modified().ok() })
    };
    if meta.len() > max {
        return Ok(omitted("oversized", meta.len(), None));
    }
    if let Some(b) = budget.as_deref() {
        if !classify_only && meta.len() > b.remaining {
            return Ok(omitted("budget", meta.len(), Some(b.total)));
        }
    }
    let mut content = Vec::new();
    Read::take(&mut file, max + 1).read_to_end(&mut content).map_err(|e| ReadFail::Io(io_code(&e)))?;
    let total = content.len() as u64;
    if total > max {
        return Ok(omitted("oversized", total, None));
    }
    if detect_binary && looks_binary(&content) {
        return Ok(omitted("binary", total, None));
    }
    if classify_only {
        return Ok(Bounded::Classified);
    }
    if let Some(b) = budget.as_deref_mut() {
        if total > b.remaining {
            return Ok(omitted("budget", total, Some(b.total)));
        }
        b.remaining -= total;
    }
    Ok(Bounded::Present { content, perms: meta.permissions() })
}

/// "binary (N bytes)", "larger than 8 MiB (N bytes)".
fn describe_omitted(o: &Omitted) -> String {
    let bytes = format!("{} bytes", o.size);
    match o.reason {
        "binary" => format!("binary (NUL bytes without a decidable text encoding, {bytes})"),
        "budget" => format!("over the {} MiB per-patch snapshot budget ({bytes})", o.limit / MIB),
        _ => format!("larger than {} MiB ({bytes})", o.limit / MIB),
    }
}

/// Node `contentEditRefusalMessage`.
pub(super) fn refusal_message(display: &str, o: &Omitted) -> String {
    format!(
        "apply_patch: {display} is {} — refusing to edit or rename it, because its pre-patch bytes cannot be snapshotted for rollback. Replace or move it with a shell command instead.",
        describe_omitted(o)
    )
}

/// The bytes of a file a V4A section updates, read as Node's conversion reads them: bounded to the
/// edit limit, binary refused. `Ok(None)` is an absent file; the `Err` text is the parenthesised
/// reason of "V4A update target unreadable".
pub(super) async fn read_for_conversion(ctx: &ToolContext, abs: &AbsPath) -> Result<Result<Option<Vec<u8>>, String>, ToolError> {
    let path = abs.as_path().to_path_buf();
    let read = on_lane(ctx, move || bounded_read(&path, EDIT_MAX_BYTES, None, false, true)).await?;
    Ok(match read {
        Ok(Bounded::Absent) => Ok(None),
        Ok(Bounded::Present { content, .. }) => Ok(Some(content)),
        Ok(Bounded::Omitted(o)) => Err(refusal_message(&normalize_output_path(&abs.as_path().to_string_lossy()), &o)),
        Ok(Bounded::Classified) => Ok(None),
        Err(ReadFail::NotRegular) => Err("ENOTREGULAR".to_owned()),
        Err(ReadFail::Io(code)) => Err(code),
    })
}

/// The bytes of `abs` when it is a regular file within `max` (and, with `detect_binary`, text); else `None`.
pub(super) async fn read_present(ctx: &ToolContext, abs: &AbsPath, max: u64, detect_binary: bool) -> Result<Option<Vec<u8>>, ToolError> {
    let path = abs.as_path().to_path_buf();
    let read = on_lane(ctx, move || bounded_read(&path, max, None, false, detect_binary)).await?;
    Ok(match read {
        Ok(Bounded::Present { content, .. }) => Some(content),
        _ => None,
    })
}

/// Node `patchContentEditRefusal`: the refusal for editing `abs`, or `None` when it may proceed.
pub(super) async fn content_edit_refusal(ctx: &ToolContext, abs: &AbsPath, display: &str) -> Result<Option<String>, ToolError> {
    let path = abs.as_path().to_path_buf();
    let read = on_lane(ctx, move || bounded_read(&path, EDIT_MAX_BYTES, None, true, true)).await?;
    Ok(match read {
        Ok(Bounded::Omitted(o)) => Some(refusal_message(display, &o)),
        _ => None,
    })
}

// ---- snapshots (Node `rollback-state`) ----

pub(super) struct Snapshot {
    pub path: AbsPath,
    existed: bool,
    content: Option<Vec<u8>>,
    omitted: Option<Omitted>,
    perms: Option<fs::Permissions>,
}

impl Snapshot {
    /// The state the turn review keeps: absent, the bytes, or an explicit omitted marker.
    pub(super) fn review_content(&self) -> mixdog_core_api::turn_review::ReviewContent {
        use mixdog_core_api::turn_review::ReviewContent;
        if !self.existed {
            return ReviewContent::Absent;
        }
        match (&self.omitted, &self.content) {
            (Some(o), _) => ReviewContent::Omitted { size: o.size, reason: Some(o.reason.to_owned()) },
            (None, Some(bytes)) => ReviewContent::bytes(bytes.clone()),
            (None, None) => ReviewContent::Absent,
        }
    }

    pub(super) fn omitted(&self) -> Option<&Omitted> {
        self.omitted.as_ref()
    }
}

/// The pre-patch state of every path, or the `apply_patch: rollback snapshot target …` reason.
/// `delete_only` are the targets the patch only deletes: they keep the smaller snapshot limit.
pub(super) async fn capture(ctx: &ToolContext, paths: &[AbsPath], delete_only: &HashSet<String>) -> Result<Result<Vec<Snapshot>, String>, ToolError> {
    let jobs: Vec<(AbsPath, u64)> = paths
        .iter()
        .map(|p| (p.clone(), if delete_only.contains(&key(p.as_path())) { SNAPSHOT_MAX_BYTES } else { EDIT_MAX_BYTES }))
        .collect();
    on_lane(ctx, move || {
        let mut budget = Budget { remaining: EDIT_BUDGET_BYTES, total: EDIT_BUDGET_BYTES };
        let mut out = Vec::new();
        for (abs, max) in jobs {
            let shown = normalize_output_path(&abs.as_path().to_string_lossy());
            match bounded_read(abs.as_path(), max, Some(&mut budget), false, true) {
                Err(ReadFail::NotRegular) => return Err(format!("apply_patch: rollback snapshot target is not a regular file: {shown}")),
                Err(ReadFail::Io(code)) => return Err(format!("apply_patch: rollback snapshot target unreadable: {shown} ({code})")),
                Ok(Bounded::Absent) => out.push(Snapshot { path: abs, existed: false, content: None, omitted: None, perms: None }),
                Ok(Bounded::Omitted(o)) => out.push(Snapshot { path: abs, existed: true, content: None, omitted: Some(o), perms: None }),
                Ok(Bounded::Present { content, perms }) => out.push(Snapshot { path: abs, existed: true, content: Some(content), omitted: None, perms: Some(perms) }),
                Ok(Bounded::Classified) => {}
            }
        }
        Ok(out)
    })
    .await
}

/// An omitted snapshot holds no bytes, so it can only be confirmed untouched.
fn omitted_issue(snapshot: &Snapshot, o: &Omitted) -> Option<String> {
    let what = format!("pre-patch content was not captured ({})", describe_omitted(o));
    match fs::metadata(snapshot.path.as_path()) {
        Err(e) => Some(format!(
            "{what}; the file is {} and cannot be restored",
            if e.kind() == std::io::ErrorKind::NotFound { "missing".to_owned() } else { format!("unreadable ({})", io_code(&e)) }
        )),
        Ok(stat) if stat.is_file() && stat.len() == o.stat_size && stat.modified().ok() == o.modified => None,
        Ok(_) => Some(format!("{what}; the file changed and cannot be restored")),
    }
}

/// OS codes of `EPERM`, `ENOTSUP` and `EINVAL` as libuv reports them: a filesystem that refuses
/// fsync answers one of these and the restore stays best-effort there (`FSYNC_TOLERATED`).
#[cfg(windows)]
const FSYNC_TOLERATED: [i32; 3] = [5, 50, 87];
#[cfg(target_os = "linux")]
const FSYNC_TOLERATED: [i32; 3] = [1, 95, 22];
#[cfg(all(unix, not(target_os = "linux")))]
const FSYNC_TOLERATED: [i32; 3] = [1, 45, 22];

/// Any other fsync failure fails the restore.
fn fsync_outcome(result: std::io::Result<()>) -> std::io::Result<()> {
    match result {
        Err(e) if !e.raw_os_error().is_some_and(|code| FSYNC_TOLERATED.contains(&code)) => Err(e),
        _ => Ok(()),
    }
}

fn write_restored(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)?;
    file.write_all(content)?;
    fsync_outcome(file.sync_all())
}

/// Undoes the batch: every snapshotted path is written back (or removed when it did not exist).
/// Returns the `path — reason` rows of what could not be restored.
pub(super) async fn restore(ctx: &ToolContext, snapshots: Vec<Snapshot>) -> Result<(Vec<String>, Vec<Snapshot>), ToolError> {
    on_lane(ctx, move || {
        let mut errors = Vec::new();
        for s in &snapshots {
            let shown = normalize_output_path(&s.path.as_path().to_string_lossy());
            if let Some(o) = &s.omitted {
                if let Some(issue) = omitted_issue(s, o) {
                    errors.push(format!("{shown} — {issue}"));
                }
                continue;
            }
            let result = if s.existed {
                let parent_ok = s.path.as_path().parent().map_or(Ok(()), fs::create_dir_all);
                parent_ok
                    .and_then(|()| write_restored(s.path.as_path(), s.content.as_deref().unwrap_or_default()))
                    .and_then(|()| s.perms.clone().map_or(Ok(()), |p| fs::set_permissions(s.path.as_path(), p)))
            } else if s.path.as_path().exists() {
                fs::remove_file(s.path.as_path())
            } else {
                continue;
            };
            if let Err(e) = result {
                errors.push(format!("{shown} — {e}"));
            }
        }
        (errors, snapshots)
    })
    .await
}

// ---- delete quarantine (Node `delete-quarantine`) ----

struct Moved {
    path: AbsPath,
    shown: String,
    quarantine: PathBuf,
}

/// Deletes of files whose bytes are never snapshotted are renamed aside, not unlinked, so a failed
/// batch can rename them back; the owner unlinks the copies once everything else succeeded.
#[derive(Default)]
pub(super) struct Quarantine {
    moved: Vec<Moved>,
    omitted: HashSet<String>,
}

static QUARANTINE_SEQ: AtomicU64 = AtomicU64::new(0);

fn quarantine_path_for(path: &Path) -> std::io::Result<PathBuf> {
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let name: String = path.file_name().map(|n| n.to_string_lossy().chars().take(80).collect()).unwrap_or_default();
    for _ in 0..8 {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
        let token = nanos ^ (QUARANTINE_SEQ.fetch_add(1, Ordering::Relaxed) << 48) ^ u64::from(std::process::id());
        let candidate = dir.join(format!("{name}.mixdog-delete-{token:016x}"));
        match fs::symlink_metadata(&candidate) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(e) => return Err(e),
            Ok(_) => {}
        }
    }
    Err(std::io::Error::other("no free quarantine name"))
}

/// Renames back, newest first; returns the `path — reason` rows of what stayed.
fn restore_moved(items: &[Moved]) -> Vec<String> {
    let mut errors = Vec::new();
    for item in items.iter().rev() {
        let outcome = match fs::symlink_metadata(item.path.as_path()) {
            Ok(_) => Err("the path was re-created meanwhile".to_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::rename(&item.quarantine, item.path.as_path()).map_err(|e| io_code(&e)),
            Err(e) => Err(io_code(&e)),
        };
        if let Err(reason) = outcome {
            errors.push(format!(
                "{} — could not restore from quarantine ({reason}); original bytes kept at {}",
                item.shown,
                item.quarantine.display()
            ));
        }
    }
    errors
}

impl Quarantine {
    /// Paths whose snapshot is omitted (budget included) are deleted through the quarantine.
    pub(super) fn mark_omitted(&mut self, snapshots: &[Snapshot]) {
        for s in snapshots.iter().filter(|s| s.omitted.is_some()) {
            self.omitted.insert(key(s.path.as_path()));
        }
    }

    /// Whether deleting `abs` must go through the quarantine: its bytes are (or would be) omitted.
    pub(super) async fn needs(&self, ctx: &ToolContext, abs: &AbsPath) -> Result<bool, ToolError> {
        if self.omitted.contains(&key(abs.as_path())) {
            return Ok(true);
        }
        let path = abs.as_path().to_path_buf();
        let read = on_lane(ctx, move || bounded_read(&path, SNAPSHOT_MAX_BYTES, None, true, true)).await?;
        Ok(matches!(read, Ok(Bounded::Omitted(_))))
    }

    /// Moves every target aside, all or nothing. The `Err` text is the model-facing failure.
    pub(super) async fn move_aside(&mut self, ctx: &ToolContext, targets: Vec<(AbsPath, String)>) -> Result<Result<(), String>, ToolError> {
        let moved = on_lane(ctx, move || {
            let mut done: Vec<Moved> = Vec::new();
            for (abs, shown) in targets {
                let attempt = (|| -> Result<Moved, String> {
                    let stat = fs::symlink_metadata(abs.as_path()).map_err(|e| io_code(&e))?;
                    let kind = stat.file_type();
                    if !(kind.is_file() || kind.is_dir() || kind.is_symlink()) {
                        return Err(format!(
                            "apply_patch: cannot patch special file (FIFO / character / block device / socket): {}",
                            normalize_output_path(&shown)
                        ));
                    }
                    let quarantine = quarantine_path_for(abs.as_path()).map_err(|e| io_code(&e))?;
                    fs::rename(abs.as_path(), &quarantine).map_err(|e| io_code(&e))?;
                    Ok(Moved { path: abs.clone(), shown: normalize_output_path(&shown), quarantine })
                })();
                match attempt {
                    Ok(item) => done.push(item),
                    Err(reason) => {
                        let restore_errors = restore_moved(&done);
                        let rollback = if restore_errors.is_empty() { String::new() } else { format!("; rollback incomplete: {}", restore_errors.join("; ")) };
                        return Err(format!(
                            "apply_patch: Delete File {} failed — it could not be moved aside for an atomic delete ({reason}); the file was left in place{rollback}",
                            normalize_output_path(&shown)
                        ));
                    }
                }
            }
            Ok(done)
        })
        .await?;
        Ok(moved.map(|items| self.moved.extend(items)))
    }

    /// Undoes every move (batch failure); returns the rows of what could not be restored.
    pub(super) async fn rollback(&mut self, ctx: &ToolContext) -> Result<Vec<String>, ToolError> {
        let items = std::mem::take(&mut self.moved);
        if items.is_empty() {
            return Ok(Vec::new());
        }
        on_lane(ctx, move || restore_moved(&items)).await
    }

    /// Commit: unlinks the quarantine copies. Returns the `WARN` rows of those that stayed.
    pub(super) async fn commit(&mut self, ctx: &ToolContext) -> Result<Vec<String>, ToolError> {
        let items = std::mem::take(&mut self.moved);
        on_lane(ctx, move || {
            items
                .iter()
                .filter_map(|item| {
                    fs::remove_file(&item.quarantine).err().map(|e| {
                        format!(
                            "  WARN {} was deleted, but its quarantine copy could not be removed: {} ({})",
                            item.shown,
                            item.quarantine.display(),
                            io_code(&e)
                        )
                    })
                })
                .collect()
        })
        .await
    }
}
#[cfg(test)]
mod fsync_tests {
    use super::*;

    /// Only the codes a filesystem that refuses fsync answers are tolerated.
    #[test]
    fn only_the_unsupported_fsync_codes_are_tolerated() {
        for code in FSYNC_TOLERATED {
            assert!(fsync_outcome(Err(std::io::Error::from_raw_os_error(code))).is_ok());
        }
        #[cfg(windows)]
        let other = 1117;
        #[cfg(unix)]
        let other = libc::EIO;
        assert!(fsync_outcome(Err(std::io::Error::from_raw_os_error(other))).is_err());
        assert!(fsync_outcome(Ok(())).is_ok());
    }
}