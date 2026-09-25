use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use memchr::memchr;
use memchr::memrchr;
use sha2::{Digest, Sha256};

mod fs_atomic;
use fs_atomic::*;
mod patch_parse;
use patch_parse::*;
mod exact_edit;
use exact_edit::*;
mod hunks;
use hunks::*;

mod server;
use server::*;
#[cfg(test)]
mod tests;

#[derive(Debug)]
struct Entry {
    old_file: String,
    new_file: String,
    hunks: Vec<Hunk>,
}

#[derive(Debug)]
struct Hunk {
    old_start: usize,
    lines: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
struct Scan {
    line: usize,
    pos: usize,
}

#[derive(Clone, Copy)]
enum HunkTag {
    Context,
    Delete,
    Add,
}

#[derive(Clone)]
struct HunkLine {
    tag: HunkTag,
    body: Vec<u8>,
    has_newline: bool,
}

struct HunkOp {
    tag: HunkTag,
    body: Vec<u8>,
    new_has_newline: bool,
}

struct HunkParts {
    old: Vec<HunkLine>,
    new: Vec<HunkLine>,
    ops: Vec<HunkOp>,
}

struct SourceLine {
    start: usize,
    body_end: usize,
    end: usize,
    has_newline: bool,
}

#[derive(Clone, Copy, Debug)]
struct ApplyOptions {
    fuzz_factor: usize,
    reject_partial: bool,
}

impl Default for ApplyOptions {
    fn default() -> Self {
        Self {
            fuzz_factor: 2,
            reject_partial: true,
        }
    }
}

#[derive(Debug, Clone)]
struct FailedEntry {
    descriptor: String,
    reason: String,
}

#[derive(Debug)]
struct ApplyStats {
    files: usize,
    failed: Vec<FailedEntry>,
    read_ms: f64,
    apply_ms: f64,
    hash_ms: f64,
    write_ms: f64,
    total_ms: f64,
    content_hashes: Vec<String>,
}

struct AppliedFile {
    bytes: Vec<u8>,
    content_hash: String,
}

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// Contract marker embedded in the artifact. The JS side refuses to use a
/// binary that does not carry the contract its build requires, so a stale
/// installed engine falls back instead of corrupting bytes. `#[used]` keeps it
/// in EVERY artifact of this source, whatever the linker garbage-collects.
#[used]
#[no_mangle]
pub static MIXDOG_PATCH_ENGINE_CONTRACT: [u8; 30] = *b"mixdog-patch-engine-contract:3";

const ENGINE_CONTRACT_MARKER: &str = "mixdog-patch-engine-contract:3";

fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
    if bytes.starts_with(UTF8_BOM) {
        &bytes[UTF8_BOM.len()..]
    } else {
        bytes
    }
}

#[derive(Debug)]
struct ExactEditStats {
    replacements: usize,
    read_ms: f64,
    apply_ms: f64,
    write_ms: f64,
    total_ms: f64,
    content_hash: String,
}

impl ExactEditStats {
    /// The `OK` line both the `--edit` CLI and the server EDIT request print.
    fn ok_line(&self, tier: EditTier) -> String {
        format!(
            "OK\t{}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{}\t{}",
            self.replacements,
            self.read_ms,
            self.apply_ms,
            self.write_ms,
            self.total_ms,
            tier.label(),
            self.content_hash,
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EntryKind {
    Modify,
    Create,
    Delete,
}

struct FileSnapshot {
    len: u64,
    modified: Option<SystemTime>,
}

struct PlannedWrite {
    kind: EntryKind,
    path: PathBuf,
    original: Option<Vec<u8>>,
    next: Option<Vec<u8>>,
    snapshot: Option<FileSnapshot>,
    content_hash: Option<String>,
}

struct PlannedEntry {
    plan: PlannedWrite,
    read_ms: f64,
    apply_ms: f64,
    descriptor: String,
}

enum EntrySlot {
    Planned(PlannedEntry),
    Failed(FailedEntry),
}

// Task Manager groups its Processes rows by AppUserModelID, so a helper with no
// identity of its own lists itself beside the app that spawned it rather than
// inside it. Claim the desktop app's AUMID (electron-builder.yml `appId`); see
// mixdog-graph/src/main.rs for the full account. Cosmetic and best-effort.
#[cfg(windows)]
fn adopt_desktop_app_identity() {
    use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    let app_id: Vec<u16> = "io.mixdog.desktop\0".encode_utf16().collect();
    let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(app_id.as_ptr()) };
}

#[cfg(not(windows))]
fn adopt_desktop_app_identity() {}

fn main() {
    adopt_desktop_app_identity();
    if let Err(err) = run() {
        eprintln!("mixdog-patch: {err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut base = env::current_dir().map_err(|e| e.to_string())?;
    let mut dry_run = false;
    let mut timing_json = false;
    let mut server = false;
    let mut edit_path: Option<PathBuf> = None;
    let mut edit_old_len: Option<usize> = None;
    let mut edit_new_len: Option<usize> = None;
    let mut edit_replace_all = false;
    let mut opts = ApplyOptions::default();
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--base" => {
                let Some(next) = args.next() else {
                    return Err("--base requires a path".to_string());
                };
                base = PathBuf::from(next);
            }
            "--dry-run" => dry_run = true,
            "--timing-json" => timing_json = true,
            "--server" => server = true,
            "--edit" => {}
            "--path" => {
                let Some(next) = args.next() else {
                    return Err("--path requires a file".to_string());
                };
                edit_path = Some(PathBuf::from(next));
            }
            "--old-len" => {
                let Some(next) = args.next() else {
                    return Err("--old-len requires a byte length".to_string());
                };
                edit_old_len = Some(
                    next.parse::<usize>()
                        .map_err(|_| "--old-len must be a number".to_string())?,
                );
            }
            "--new-len" => {
                let Some(next) = args.next() else {
                    return Err("--new-len requires a byte length".to_string());
                };
                edit_new_len = Some(
                    next.parse::<usize>()
                        .map_err(|_| "--new-len must be a number".to_string())?,
                );
            }
            "--replace-all" => {
                let Some(next) = args.next() else {
                    return Err("--replace-all requires 0 or 1".to_string());
                };
                edit_replace_all = next == "1" || next.eq_ignore_ascii_case("true");
            }
            "--fuzz" => {
                let Some(next) = args.next() else {
                    return Err("--fuzz requires a non-negative integer".to_string());
                };
                opts.fuzz_factor = next
                    .parse::<usize>()
                    .map_err(|_| "--fuzz must be a non-negative integer".to_string())?;
            }
            "--reject-partial" => {
                let Some(next) = args.next() else {
                    return Err("--reject-partial requires 0 or 1".to_string());
                };
                opts.reject_partial = !(next == "0" || next.eq_ignore_ascii_case("false"));
            }
            "--help" | "-h" => {
                println!(
                    "usage: mixdog-patch [--base DIR] [--dry-run] [--timing-json] [--server] \
                     [--fuzz N] [--reject-partial 0|1] < patch.diff\n       \
                     mixdog-patch --edit --path FILE --old-len N --new-len N \
                     [--replace-all 0|1] [--dry-run] < old+new-bytes"
                );
                return Ok(());
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }

    if server {
        return run_server();
    }

    if let Some(path) = edit_path {
        let old_len = edit_old_len.ok_or_else(|| "--edit requires --old-len".to_string())?;
        let new_len = edit_new_len.ok_or_else(|| "--edit requires --new-len".to_string())?;
        let total = old_len
            .checked_add(new_len)
            .ok_or_else(|| "--edit payload length overflow".to_string())?;
        let mut payload = vec![0u8; total];
        io::stdin()
            .read_exact(&mut payload)
            .map_err(|e| format!("read edit payload: {e}"))?;
        let new_bytes = payload.split_off(old_len);
        let old_bytes = payload;
        let (stats, tier) = apply_invariant_safe_edit_to_path(
            &path,
            &old_bytes,
            &new_bytes,
            edit_replace_all,
            dry_run,
        )?;
        println!("{}", stats.ok_line(tier));
        return Ok(());
    }

    let mut patch = String::new();
    io::stdin()
        .read_to_string(&mut patch)
        .map_err(|e| format!("read stdin: {e}"))?;
    let stats = apply_patch_to_base(&base, &patch, dry_run, &opts)?;
    if timing_json {
        eprintln!(
            "{{\"files\":{},\"failed\":{},\"read_ms\":{:.3},\"apply_ms\":{:.3},\"hash_ms\":{:.3},\"write_ms\":{:.3},\"total_ms\":{:.3}}}",
            stats.files,
            stats.failed.len(),
            stats.read_ms,
            stats.apply_ms,
            stats.hash_ms,
            stats.write_ms,
            stats.total_ms,
        );
    }
    if stats.failed.is_empty() {
        println!("applied {}", stats.files);
    } else {
        println!("applied {} failed {}", stats.files, stats.failed.len());
        for fail in &stats.failed {
            eprintln!("mixdog-patch: skipped {}: {}", fail.descriptor, fail.reason);
        }
    }
    Ok(())
}

fn apply_patch_to_base(
    base: &Path,
    patch: &str,
    dry_run: bool,
    opts: &ApplyOptions,
) -> Result<ApplyStats, String> {
    let entries = parse_patch(patch)?;
    if entries.is_empty() {
        return Err("patch contained no file sections".to_string());
    }

    let total_start = Instant::now();
    let mut read_ms = 0.0f64;
    let mut apply_ms = 0.0f64;
    let mut write_ms = 0.0f64;

    let canonical_base = canonicalize_base(base)?;
    let slots = plan_entries(&canonical_base, entries, opts)?;

    if opts.reject_partial {
        if let Some(EntrySlot::Failed(f)) = slots.iter().find(|s| matches!(s, EntrySlot::Failed(_)))
        {
            return Err(format!("{}: {}", f.descriptor, f.reason));
        }
        let mut plans: Vec<PlannedWrite> = Vec::with_capacity(slots.len());
        for slot in slots {
            if let EntrySlot::Planned(p) = slot {
                read_ms += p.read_ms;
                apply_ms += p.apply_ms;
                plans.push(p.plan);
            }
        }
        if !dry_run {
            let mut applied_idx: Vec<usize> = Vec::new();
            for (idx, plan) in plans.iter().enumerate() {
                let t = Instant::now();
                if let Err(err) = persist_plan(plan, &canonical_base) {
                    let rollback_errors = rollback_applied(&plans, applied_idx);
                    return Err(format_rollback_failure(&err, &rollback_errors));
                }
                write_ms += t.elapsed().as_secs_f64() * 1000.0;
                applied_idx.push(idx);
            }
        }
        return Ok(ApplyStats {
            files: plans.len(),
            failed: Vec::new(),
            read_ms,
            apply_ms,
            hash_ms: 0.0,
            write_ms,
            total_ms: total_start.elapsed().as_secs_f64() * 1000.0,
            content_hashes: content_hashes(&plans),
        });
    }

    // Isolation mode: per-entry independent application, no rollback of prior success.
    let mut applied_plans: Vec<PlannedWrite> = Vec::new();
    let mut failed: Vec<FailedEntry> = Vec::new();
    for slot in slots {
        match slot {
            EntrySlot::Planned(planned) => {
                read_ms += planned.read_ms;
                apply_ms += planned.apply_ms;
                if dry_run {
                    applied_plans.push(planned.plan);
                    continue;
                }
                let t = Instant::now();
                match persist_plan(&planned.plan, &canonical_base) {
                    Ok(()) => {
                        write_ms += t.elapsed().as_secs_f64() * 1000.0;
                        applied_plans.push(planned.plan);
                    }
                    Err(err) => failed.push(FailedEntry {
                        descriptor: planned.descriptor,
                        reason: err,
                    }),
                }
            }
            EntrySlot::Failed(f) => failed.push(f),
        }
    }
    Ok(ApplyStats {
        files: applied_plans.len(),
        failed,
        read_ms,
        apply_ms,
        hash_ms: 0.0,
        write_ms,
        total_ms: total_start.elapsed().as_secs_f64() * 1000.0,
        content_hashes: content_hashes(&applied_plans),
    })
}

/// One content hash per written plan, `-` for a delete (which has none).
fn content_hashes(plans: &[PlannedWrite]) -> Vec<String> {
    plans
        .iter()
        .map(|plan| plan.content_hash.clone().unwrap_or_else(|| "-".to_string()))
        .collect()
}

/// Undo the entries already written by this batch, newest first, collecting
/// every restore that could not be performed. The failing entry itself is NOT
/// in `applied_idx`: `persist_plan` either wrote nothing or reports its own
/// leftovers in its error, so the two together describe the whole disk state.
fn rollback_applied(plans: &[PlannedWrite], applied_idx: Vec<usize>) -> Vec<String> {
    let mut errors = Vec::new();
    for done_idx in applied_idx.into_iter().rev() {
        if let Err(err) = rollback_plan(&plans[done_idx]) {
            errors.push(err);
        }
    }
    errors
}

/// A failed all-or-nothing batch rolls back the files already written. Any
/// path that could NOT be restored travels back with the error: the caller
/// must never be told "nothing was written" while a file is left mid-patch.
/// Bounded so a wide batch cannot produce an unbounded error line.
fn format_rollback_failure(err: &str, rollback_errors: &[String]) -> String {
    if rollback_errors.is_empty() {
        return err.to_string();
    }
    const MAX_REPORTED: usize = 5;
    let shown = rollback_errors
        .iter()
        .take(MAX_REPORTED)
        .cloned()
        .collect::<Vec<_>>()
        .join("; ");
    let extra = rollback_errors.len().saturating_sub(MAX_REPORTED);
    let more = if extra > 0 {
        format!(" (+{extra} more)")
    } else {
        String::new()
    };
    format!("{err}; rollback incomplete, these paths were left mid-patch: {shown}{more}")
}

fn plan_entries(
    canonical_base: &Path,
    entries: Vec<Entry>,
    opts: &ApplyOptions,
) -> Result<Vec<EntrySlot>, String> {
    let descriptors: Vec<String> = entries.iter().map(entry_descriptor).collect();
    let fuzz = opts.fuzz_factor;
    let plan_or_fail = move |base: &Path, entry: Entry, descriptor: String| {
        plan_entry(base, entry, fuzz, descriptor.clone())
            .map_err(|reason| FailedEntry { descriptor, reason })
    };

    let results: Vec<Result<PlannedEntry, FailedEntry>> = if entries.len() <= 1 {
        entries
            .into_iter()
            .enumerate()
            .map(|(i, entry)| plan_or_fail(canonical_base, entry, descriptors[i].clone()))
            .collect()
    } else {
        let mut handles = Vec::with_capacity(entries.len());
        for (i, entry) in entries.into_iter().enumerate() {
            let base_for_worker = canonical_base.to_path_buf();
            let descriptor = descriptors[i].clone();
            handles.push(thread::spawn(move || {
                plan_or_fail(&base_for_worker, entry, descriptor)
            }));
        }
        let mut out = Vec::with_capacity(handles.len());
        for handle in handles {
            out.push(
                handle
                    .join()
                    .map_err(|_| "patch planning worker panicked".to_string())?,
            );
        }
        out
    };

    // Duplicate-path detection over successfully planned entries. Case-insensitive on Windows.
    let mut seen: Vec<(String, usize)> = Vec::new();
    let mut slots: Vec<EntrySlot> = Vec::with_capacity(results.len());
    for (i, r) in results.into_iter().enumerate() {
        match r {
            Ok(planned) => {
                let key = duplicate_key(&planned.plan.path);
                if let Some((_, first)) = seen.iter().find(|(k, _)| k == &key) {
                    slots.push(EntrySlot::Failed(FailedEntry {
                        descriptor: descriptors[i].clone(),
                        reason: format!(
                            "duplicate target path: resolves to same file as entry #{} ({})",
                            first,
                            planned.plan.path.display()
                        ),
                    }));
                } else {
                    seen.push((key, i));
                    slots.push(EntrySlot::Planned(planned));
                }
            }
            Err(f) => slots.push(EntrySlot::Failed(f)),
        }
    }
    Ok(slots)
}

fn entry_descriptor(entry: &Entry) -> String {
    match classify_entry(entry) {
        EntryKind::Create => entry.new_file.clone(),
        EntryKind::Modify | EntryKind::Delete => entry.old_file.clone(),
    }
}

fn duplicate_key(path: &Path) -> String {
    let s = path.to_string_lossy().to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn canonicalize_base(base: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(base).map_err(|e| format!("canonicalize base {}: {e}", base.display()))
}

fn is_zero_length_delete_patch(entry: &Entry) -> bool {
    !entry.hunks.is_empty()
        && entry
            .hunks
            .iter()
            .all(|h| h.lines.iter().all(|line| line.starts_with('\\')))
}

fn plan_entry(
    base: &Path,
    entry: Entry,
    fuzz_factor: usize,
    descriptor: String,
) -> Result<PlannedEntry, String> {
    match classify_entry(&entry) {
        EntryKind::Modify => plan_modify(base, &entry, fuzz_factor, descriptor),
        EntryKind::Create => plan_create(base, &entry, descriptor),
        EntryKind::Delete => plan_delete(base, &entry, fuzz_factor, descriptor),
    }
}

fn plan_modify(
    base: &Path,
    entry: &Entry,
    fuzz_factor: usize,
    descriptor: String,
) -> Result<PlannedEntry, String> {
    if entry.hunks.is_empty() {
        return Err(format!("{} has no hunks", entry.old_file));
    }
    // Reject renames / path changes. A unified diff whose headers name
    // different paths (e.g. `--- a/foo` / `+++ b/bar`) is a rename and
    // mixdog patch does not support it. Without this guard the new_file
    // is ignored and the hunks are silently written back to old_file,
    // corrupting the wrong path. Compare the diff-prefix-stripped paths
    // so cosmetic `a/`/`b/` differences are not treated as renames.
    if strip_diff_prefix(&entry.old_file) != strip_diff_prefix(&entry.new_file) {
        return Err(format!(
            "rename/path change not supported: header maps {} -> {}; \
             mixdog patch only modifies a file in place (old and new paths must match)",
            entry.old_file, entry.new_file
        ));
    }
    let path = resolve_entry_path(base, &entry.old_file)?;
    let t = Instant::now();
    let metadata = fs::metadata(&path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let snapshot = snapshot_from_metadata(&metadata);
    let source = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let read_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    let applied = apply_exact_bytes(&source, entry, fuzz_factor)?;
    let apply_ms = t.elapsed().as_secs_f64() * 1000.0;
    Ok(PlannedEntry {
        plan: PlannedWrite {
            kind: EntryKind::Modify,
            path,
            original: Some(source),
            next: Some(applied.bytes),
            snapshot: Some(snapshot),
            content_hash: Some(applied.content_hash),
        },
        read_ms,
        apply_ms,
        descriptor,
    })
}

fn plan_create(base: &Path, entry: &Entry, descriptor: String) -> Result<PlannedEntry, String> {
    let path = resolve_entry_path(base, &entry.new_file)?;
    let t = Instant::now();
    let mut bytes = build_create_bytes(entry)?;
    let occupied = match fs::symlink_metadata(&path) {
        Ok(metadata) => Some(metadata),
        Err(err) if err.kind() == io::ErrorKind::NotFound => None,
        Err(err) => return Err(format!("stat Add File target {}: {err}", path.display())),
    };
    if let Some(metadata) = occupied {
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(format!(
                "Add File target is not a regular file: {}",
                path.display()
            ));
        }
        let snapshot = snapshot_from_metadata(&metadata);
        let source =
            fs::read(&path).map_err(|e| format!("read Add File target {}: {e}", path.display()))?;
        bytes = preserve_eol(&bytes, &source, &source);
        let content_hash = sha256_hex(&bytes);
        let elapsed_ms = t.elapsed().as_secs_f64() * 1000.0;
        return Ok(PlannedEntry {
            plan: PlannedWrite {
                kind: EntryKind::Modify,
                path,
                original: Some(source),
                next: Some(bytes),
                snapshot: Some(snapshot),
                content_hash: Some(content_hash),
            },
            read_ms: elapsed_ms,
            apply_ms: 0.0,
            descriptor,
        });
    }
    let apply_ms = t.elapsed().as_secs_f64() * 1000.0;
    let content_hash = sha256_hex(&bytes);
    Ok(PlannedEntry {
        plan: PlannedWrite {
            kind: EntryKind::Create,
            path,
            original: None,
            next: Some(bytes),
            snapshot: None,
            content_hash: Some(content_hash),
        },
        read_ms: 0.0,
        apply_ms,
        descriptor,
    })
}

fn plan_delete(
    base: &Path,
    entry: &Entry,
    fuzz_factor: usize,
    descriptor: String,
) -> Result<PlannedEntry, String> {
    let path = resolve_entry_path(base, &entry.old_file)?;
    let t = Instant::now();
    // Hunkless-delete preflight (mirrors patch.mjs:407-412): a delete entry
    // with zero hunks must only remove a file whose on-disk size is 0.
    // Stat first; refuse if it cannot be statted or size != 0, so a
    // non-empty file is never silently deleted by an empty-hunk patch.
    let metadata =
        fs::metadata(&path).map_err(|e| format!("stat {} for delete: {e}", path.display()))?;
    if entry.hunks.is_empty() && metadata.len() != 0 {
        return Err(format!(
            "refusing hunkless delete: {} is non-empty ({} byte(s) on disk); \
             a delete entry with zero hunks may only remove a 0-byte file",
            path.display(),
            metadata.len()
        ));
    }
    let snapshot = snapshot_from_metadata(&metadata);
    let source = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let read_ms = t.elapsed().as_secs_f64() * 1000.0;
    let t = Instant::now();
    if entry.hunks.is_empty() {
        if !source.is_empty() {
            return Err(format!(
                "delete patch has no hunks but {} is non-empty ({} byte(s))",
                path.display(),
                source.len()
            ));
        }
    } else if is_zero_length_delete_patch(entry) {
        if !source.is_empty() {
            return Err(format!(
                "delete patch leaves {} residual byte(s) in {}",
                source.len(),
                path.display()
            ));
        }
    } else {
        let applied = apply_exact_bytes(&source, entry, fuzz_factor)?;
        if !strip_utf8_bom(&applied.bytes).is_empty() {
            return Err(format!(
                "delete patch leaves {} residual byte(s) in {}",
                applied.bytes.len(),
                path.display()
            ));
        }
    }
    let apply_ms = t.elapsed().as_secs_f64() * 1000.0;
    Ok(PlannedEntry {
        plan: PlannedWrite {
            kind: EntryKind::Delete,
            path,
            original: Some(source),
            next: None,
            snapshot: Some(snapshot),
            content_hash: None,
        },
        read_ms,
        apply_ms,
        descriptor,
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn classify_entry(entry: &Entry) -> EntryKind {
    let old_is_null = is_dev_null(&entry.old_file);
    let new_is_null = is_dev_null(&entry.new_file);
    if old_is_null && !new_is_null {
        EntryKind::Create
    } else if !old_is_null && new_is_null {
        EntryKind::Delete
    } else {
        EntryKind::Modify
    }
}
