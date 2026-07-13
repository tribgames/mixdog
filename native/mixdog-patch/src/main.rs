use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use memchr::memchr;
use sha2::{Digest, Sha256};

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

#[derive(Debug)]
struct ExactEditStats {
    replacements: usize,
    read_ms: f64,
    apply_ms: f64,
    write_ms: f64,
    total_ms: f64,
    content_hash: String,
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

fn main() {
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
        let (stats, tier) =
            apply_invariant_safe_edit_to_path(&path, &old_bytes, &new_bytes, edit_replace_all, dry_run)?;
        println!(
            "OK\t{}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{}\t{}",
            stats.replacements,
            stats.read_ms,
            stats.apply_ms,
            stats.write_ms,
            stats.total_ms,
            tier.label(),
            stats.content_hash,
        );
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
    let slots = plan_entries(base, entries, opts)?;

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
                    for done_idx in applied_idx.into_iter().rev() {
                        let _ = rollback_plan(&plans[done_idx]);
                    }
                    return Err(err);
                }
                write_ms += t.elapsed().as_secs_f64() * 1000.0;
                applied_idx.push(idx);
            }
        }
        let content_hashes = plans
            .iter()
            .map(|plan| plan.content_hash.clone().unwrap_or_else(|| "-".to_string()))
            .collect();
        return Ok(ApplyStats {
            files: plans.len(),
            failed: Vec::new(),
            read_ms,
            apply_ms,
            hash_ms: 0.0,
            write_ms,
            total_ms: total_start.elapsed().as_secs_f64() * 1000.0,
            content_hashes,
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
    let content_hashes = applied_plans
        .iter()
        .map(|plan| plan.content_hash.clone().unwrap_or_else(|| "-".to_string()))
        .collect();
    Ok(ApplyStats {
        files: applied_plans.len(),
        failed,
        read_ms,
        apply_ms,
        hash_ms: 0.0,
        write_ms,
        total_ms: total_start.elapsed().as_secs_f64() * 1000.0,
        content_hashes,
    })
}

fn plan_entries(
    base: &Path,
    entries: Vec<Entry>,
    opts: &ApplyOptions,
) -> Result<Vec<EntrySlot>, String> {
    let canonical_base = canonicalize_base(base)?;
    let descriptors: Vec<String> = entries.iter().map(entry_descriptor).collect();
    let fuzz = opts.fuzz_factor;

    let results: Vec<Result<PlannedEntry, FailedEntry>> = if entries.len() <= 1 {
        entries
            .into_iter()
            .enumerate()
            .map(|(i, entry)| {
                let descriptor = descriptors[i].clone();
                match plan_entry(&canonical_base, entry, fuzz, descriptor.clone()) {
                    Ok(p) => Ok(p),
                    Err(reason) => Err(FailedEntry { descriptor, reason }),
                }
            })
            .collect()
    } else {
        let mut handles = Vec::with_capacity(entries.len());
        for (i, entry) in entries.into_iter().enumerate() {
            let base_for_worker = canonical_base.clone();
            let descriptor = descriptors[i].clone();
            handles.push(thread::spawn(move || {
                let d = descriptor.clone();
                match plan_entry(&base_for_worker, entry, fuzz, descriptor) {
                    Ok(p) => Ok(p),
                    Err(reason) => Err(FailedEntry {
                        descriptor: d,
                        reason,
                    }),
                }
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
        EntryKind::Modify => {
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
            let metadata =
                fs::metadata(&path).map_err(|e| format!("stat {}: {e}", path.display()))?;
            let snapshot = snapshot_from_metadata(&metadata);
            let source = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
            let read_ms = t.elapsed().as_secs_f64() * 1000.0;
            let t = Instant::now();
            let applied = apply_exact_bytes(&source, &entry, fuzz_factor)?;
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
        EntryKind::Create => {
            let path = resolve_entry_path(base, &entry.new_file)?;
            if path.exists() {
                return Err(format!("create target already exists: {}", path.display()));
            }
            let t = Instant::now();
            let bytes = build_create_bytes(&entry)?;
            let content_hash = sha256_hex(&bytes);
            let apply_ms = t.elapsed().as_secs_f64() * 1000.0;
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
        EntryKind::Delete => {
            let path = resolve_entry_path(base, &entry.old_file)?;
            let t = Instant::now();
            // Hunkless-delete preflight (mirrors patch.mjs:407-412): a delete entry
            // with zero hunks must only remove a file whose on-disk size is 0.
            // Stat first; refuse if it cannot be statted or size != 0, so a
            // non-empty file is never silently deleted by an empty-hunk patch.
            let metadata = fs::metadata(&path)
                .map_err(|e| format!("stat {} for delete: {e}", path.display()))?;
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
            } else if is_zero_length_delete_patch(&entry) {
                if !source.is_empty() {
                    return Err(format!(
                        "delete patch leaves {} residual byte(s) in {}",
                        source.len(),
                        path.display()
                    ));
                }
            } else {
                let applied = apply_exact_bytes(&source, &entry, fuzz_factor)?;
                if !applied.bytes.is_empty() {
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
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn run_server() -> Result<(), String> {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut stdout = io::stdout().lock();
    // Idle self-exit watchdog. An orphaned server (parent force-killed without
    // closing our stdin — e.g. a surviving supervisor still holding the pipe's
    // write handle) would never see EOF and would live forever, so they pile up
    // across restarts. A side thread exits the whole process once no request has
    // arrived within the idle window; the JS layer transparently respawns on the
    // next request (getNativePatchServer detects `.exited`). Tunable via
    // MIXDOG_PATCH_SERVER_IDLE_MS (default 300000ms); set 0 to disable.
    let idle_ms: u64 = env::var("MIXDOG_PATCH_SERVER_IDLE_MS")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(300_000);
    let last_activity = Arc::new(AtomicU64::new(now_ms()));
    if idle_ms > 0 {
        let watch = Arc::clone(&last_activity);
        let step = Duration::from_millis(idle_ms.min(5_000).max(250));
        thread::spawn(move || loop {
            thread::sleep(step);
            if now_ms().saturating_sub(watch.load(Ordering::Relaxed)) >= idle_ms {
                std::process::exit(0);
            }
        });
    }
    loop {
        let mut header = String::new();
        let n = reader
            .read_line(&mut header)
            .map_err(|e| format!("server read header: {e}"))?;
        if n == 0 {
            break;
        }
        last_activity.store(now_ms(), Ordering::Relaxed);
        let header = header.trim_end_matches(['\r', '\n']);
        if header == "QUIT" {
            break;
        }
        if header == "PING" {
            writeln!(stdout, "OK\tPONG").map_err(|e| format!("server write ping response: {e}"))?;
            stdout
                .flush()
                .map_err(|e| format!("server flush ping response: {e}"))?;
            continue;
        }
        // EDIT protocol: invariant-safe char-indexed edit over the persistent
        // server. EDIT <path_len> <old_len> <new_len> <replace_all> <dry_run>
        // then path+old+new bytes on stdin. Reuses apply_invariant_safe_edit.
        {
            let parts: Vec<&str> = header.split_whitespace().collect();
            if parts.first() == Some(&"EDIT") {
                if parts.len() != 6 {
                    write_server_err(&mut stdout, "bad edit header")?;
                    continue;
                }
                let path_len = match parts[1].parse::<usize>() {
                    Ok(v) => v,
                    Err(_) => {
                        write_server_err(&mut stdout, "bad path length")?;
                        continue;
                    }
                };
                let old_len = match parts[2].parse::<usize>() {
                    Ok(v) => v,
                    Err(_) => {
                        write_server_err(&mut stdout, "bad old length")?;
                        continue;
                    }
                };
                let new_len = match parts[3].parse::<usize>() {
                    Ok(v) => v,
                    Err(_) => {
                        write_server_err(&mut stdout, "bad new length")?;
                        continue;
                    }
                };
                let replace_all = match parts[4] {
                    "0" => false,
                    "1" => true,
                    _ => {
                        write_server_err(&mut stdout, "bad replace_all value")?;
                        continue;
                    }
                };
                let dry_run = parts[5] == "1";
                let mut path_buf = vec![0u8; path_len];
                let mut old_buf = vec![0u8; old_len];
                let mut new_buf = vec![0u8; new_len];
                if let Err(err) = reader.read_exact(&mut path_buf) {
                    write_server_err(&mut stdout, &format!("read edit path: {err}"))?;
                    break;
                }
                if let Err(err) = reader.read_exact(&mut old_buf) {
                    write_server_err(&mut stdout, &format!("read edit old: {err}"))?;
                    break;
                }
                if let Err(err) = reader.read_exact(&mut new_buf) {
                    write_server_err(&mut stdout, &format!("read edit new: {err}"))?;
                    break;
                }
                let path = match String::from_utf8(path_buf) {
                    Ok(v) => v,
                    Err(_) => {
                        write_server_err(&mut stdout, "edit path is not UTF-8")?;
                        continue;
                    }
                };
                match apply_invariant_safe_edit_to_path(
                    Path::new(&path),
                    &old_buf,
                    &new_buf,
                    replace_all,
                    dry_run,
                ) {
                    Ok((stats, tier)) => {
                        writeln!(
                            stdout,
                            "OK\t{}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{}\t{}",
                            stats.replacements,
                            stats.read_ms,
                            stats.apply_ms,
                            stats.write_ms,
                            stats.total_ms,
                            tier.label(),
                            stats.content_hash
                        )
                        .map_err(|e| format!("server write edit response: {e}"))?;
                    }
                    Err(e) => {
                        write_server_err(&mut stdout, &e)?;
                    }
                }
                stdout
                    .flush()
                    .map_err(|e| format!("server flush edit response: {e}"))?;
                continue;
            }
        }
        let parts: Vec<&str> = header.split_whitespace().collect();
        // Protocol: APPLY base_len patch_len timing dry_run fuzz reject_partial
        if parts.len() != 7 || parts[0] != "APPLY" {
            write_server_err(&mut stdout, "bad header")?;
            continue;
        }
        let base_len = match parts[1].parse::<usize>() {
            Ok(v) => v,
            Err(_) => {
                write_server_err(&mut stdout, "bad base length")?;
                continue;
            }
        };
        let patch_len = match parts[2].parse::<usize>() {
            Ok(v) => v,
            Err(_) => {
                write_server_err(&mut stdout, "bad patch length")?;
                continue;
            }
        };
        let _timing = parts[3] == "1";
        let dry_run = parts[4] == "1";
        let fuzz_factor = match parts[5].parse::<usize>() {
            Ok(v) => v,
            Err(_) => {
                write_server_err(&mut stdout, "bad fuzz value")?;
                continue;
            }
        };
        let reject_partial = match parts[6] {
            "0" => false,
            "1" => true,
            _ => {
                write_server_err(&mut stdout, "bad reject_partial value")?;
                continue;
            }
        };
        let opts = ApplyOptions {
            fuzz_factor,
            reject_partial,
        };
        let mut base_buf = vec![0u8; base_len];
        let mut patch_buf = vec![0u8; patch_len];
        if let Err(err) = reader.read_exact(&mut base_buf) {
            write_server_err(&mut stdout, &format!("read base payload: {err}"))?;
            break;
        }
        if let Err(err) = reader.read_exact(&mut patch_buf) {
            write_server_err(&mut stdout, &format!("read patch payload: {err}"))?;
            break;
        }
        let base = match String::from_utf8(base_buf) {
            Ok(v) => v,
            Err(_) => {
                write_server_err(&mut stdout, "base path is not UTF-8")?;
                continue;
            }
        };
        let patch = match String::from_utf8(patch_buf) {
            Ok(v) => v,
            Err(_) => {
                write_server_err(&mut stdout, "patch is not UTF-8")?;
                continue;
            }
        };
        match apply_patch_to_base(Path::new(&base), &patch, dry_run, &opts) {
            Ok(stats) => {
                let content_hashes = stats.content_hashes.join(",");
                if stats.failed.is_empty() {
                    writeln!(
                        stdout,
                        "OK\t{}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{}",
                        stats.files,
                        stats.read_ms,
                        stats.apply_ms,
                        stats.write_ms,
                        stats.total_ms,
                        stats.hash_ms,
                        content_hashes
                    )
                    .map_err(|e| format!("server write response: {e}"))?;
                } else {
                    let mut payload = String::new();
                    for fail in &stats.failed {
                        if !payload.is_empty() {
                            payload.push('\n');
                        }
                        payload.push_str(&fail.descriptor.replace(['\t', '\n', '\r'], " "));
                        payload.push('\t');
                        payload.push_str(&fail.reason.replace(['\t', '\n', '\r'], " "));
                    }
                    let failures_hex = hex_bytes(payload.as_bytes());
                    writeln!(
                        stdout,
                        "OK_PARTIAL\t{}\t{}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{:.3}\t{}\t{}",
                        stats.files,
                        stats.failed.len(),
                        stats.read_ms,
                        stats.apply_ms,
                        stats.write_ms,
                        stats.total_ms,
                        stats.hash_ms,
                        content_hashes,
                        failures_hex
                    )
                    .map_err(|e| format!("server write response: {e}"))?;
                }
                stdout
                    .flush()
                    .map_err(|e| format!("server flush response: {e}"))?;
            }
            Err(err) => write_server_err(&mut stdout, &err)?,
        }
    }
    Ok(())
}

fn write_server_err(out: &mut dyn Write, msg: &str) -> Result<(), String> {
    let clean = msg.replace(['\r', '\n', '\t'], " ");
    writeln!(out, "ERR\t{clean}").map_err(|e| format!("server write error response: {e}"))?;
    out.flush()
        .map_err(|e| format!("server flush error response: {e}"))
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

fn snapshot_from_metadata(metadata: &fs::Metadata) -> FileSnapshot {
    FileSnapshot {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    }
}

fn snapshot_matches(path: &Path, snapshot: &FileSnapshot) -> Result<(), String> {
    let metadata =
        fs::metadata(path).map_err(|e| format!("stat {} before write: {e}", path.display()))?;
    if metadata.len() != snapshot.len {
        return Err(format!(
            "file modified since read (size drift): {}",
            path.display()
        ));
    }
    if let Some(want) = snapshot.modified {
        match metadata.modified() {
            Ok(got) if got == want => {}
            Ok(_) => {
                return Err(format!(
                    "file modified since read (mtime drift): {}",
                    path.display()
                ))
            }
            Err(e) => return Err(format!("stat mtime {} before write: {e}", path.display())),
        }
    }
    Ok(())
}

fn native_atomic_fsync_enabled() -> bool {
    match env::var("MIXDOG_NATIVE_ATOMIC_FSYNC") {
        Ok(value) => matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on" | "sync"
        ),
        Err(_) => false,
    }
}

#[cfg(windows)]
fn rename_atomic_replace(src: &Path, dst: &Path) -> io::Result<()> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x00000001;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x00000008;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            lp_existing_file_name: *const u16,
            lp_new_file_name: *const u16,
            dw_flags: u32,
        ) -> i32;
    }

    fn wide(path: &OsStr) -> Vec<u16> {
        let mut out: Vec<u16> = path.encode_wide().collect();
        out.push(0);
        out
    }

    let src_w = wide(src.as_os_str());
    let dst_w = wide(dst.as_os_str());
    let mut flags = MOVEFILE_REPLACE_EXISTING;
    if native_atomic_fsync_enabled() {
        flags |= MOVEFILE_WRITE_THROUGH;
    }
    let ok = unsafe { MoveFileExW(src_w.as_ptr(), dst_w.as_ptr(), flags) };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn rename_atomic_replace(src: &Path, dst: &Path) -> io::Result<()> {
    fs::rename(src, dst)
}

fn atomic_write_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("target");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let existing_permissions = fs::metadata(path).ok().map(|m| m.permissions());

    for attempt in 0..32u32 {
        let tmp = parent.join(format!(
            ".{file_name}.mixdog-tmp-{}-{nonce}-{attempt}",
            std::process::id()
        ));
        let result = (|| -> io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)?;
            file.write_all(bytes)?;
            if native_atomic_fsync_enabled() {
                file.sync_all()?;
            }
            drop(file);
            if let Some(perms) = &existing_permissions {
                let _ = fs::set_permissions(&tmp, perms.clone());
            }
            rename_atomic_replace(&tmp, path)
        })();
        match result {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                let _ = fs::remove_file(&tmp);
                return Err(format!("atomic write {}: {err}", path.display()));
            }
        }
    }
    Err(format!(
        "atomic write {}: unable to allocate temp file",
        path.display()
    ))
}

fn atomic_write_create_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        return Err(format!("create target already exists: {}", path.display()));
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("target");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    for attempt in 0..32u32 {
        let tmp = parent.join(format!(
            ".{file_name}.mixdog-new-{}-{nonce}-{attempt}",
            std::process::id()
        ));
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("atomic create {}: {err}", path.display())),
        };
        if let Err(err) = file.write_all(bytes) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("atomic create {}: {err}", path.display()));
        }
        if native_atomic_fsync_enabled() {
            if let Err(err) = file.sync_all() {
                let _ = fs::remove_file(&tmp);
                return Err(format!("atomic create {}: {err}", path.display()));
            }
        }
        drop(file);
        match fs::hard_link(&tmp, path) {
            Ok(()) => {
                let _ = fs::remove_file(&tmp);
                return Ok(());
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                let _ = fs::remove_file(&tmp);
                return Err(format!("create target already exists: {}", path.display()));
            }
            Err(err) => {
                let _ = fs::remove_file(&tmp);
                return Err(format!("atomic create {}: {err}", path.display()));
            }
        }
    }
    Err(format!(
        "atomic create {}: unable to allocate temp file",
        path.display()
    ))
}

fn persist_plan(plan: &PlannedWrite, canonical_base: &Path) -> Result<(), String> {
    if let Some(snapshot) = &plan.snapshot {
        snapshot_matches(&plan.path, snapshot)?;
    }
    match plan.kind {
        EntryKind::Modify => {
            // TOCTOU guard: between plan-time canonicalization and the write
            // here, an intermediate parent could have been swapped to a
            // symlink/junction pointing outside `canonical_base`. Re-validate
            // the FINAL parent directory immediately before the write.
            verify_parent_within_base(&plan.path, canonical_base)?;
            let bytes = plan
                .next
                .as_ref()
                .ok_or_else(|| "modify plan missing bytes".to_string())?;
            atomic_write_replace(&plan.path, bytes)
        }
        EntryKind::Create => {
            if let Some(parent) = plan.path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("create parent {}: {e}", parent.display()))?;
            }
            // TOCTOU guard: re-validate AFTER create_dir_all and BEFORE the
            // temp-write / hard_link / rename inside atomic_write_create_new.
            // Catches a symlink/junction swapped into an intermediate parent
            // between plan time and now (also catches a malicious dir created
            // by create_dir_all racing with a swap).
            verify_parent_within_base(&plan.path, canonical_base)?;
            let bytes = plan
                .next
                .as_ref()
                .ok_or_else(|| "create plan missing bytes".to_string())?;
            atomic_write_create_new(&plan.path, bytes)
        }
        EntryKind::Delete => {
            // TOCTOU guard: refuse to delete through a parent that now
            // resolves outside the canonical base.
            verify_parent_within_base(&plan.path, canonical_base)?;
            fs::remove_file(&plan.path).map_err(|e| format!("delete {}: {e}", plan.path.display()))
        }
    }
}

fn verify_parent_within_base(path: &Path, canonical_base: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("target {} has no parent directory", path.display()))?;
    let canonical_parent = fs::canonicalize(parent).map_err(|e| {
        format!(
            "canonicalize parent {} for write-time guard: {e}",
            parent.display()
        )
    })?;
    if !canonical_parent.starts_with(canonical_base) {
        return Err(format!(
            "write-time path escape: parent {} resolves to {} outside base {}",
            parent.display(),
            canonical_parent.display(),
            canonical_base.display()
        ));
    }
    Ok(())
}

fn rollback_plan(plan: &PlannedWrite) -> Result<(), String> {
    match plan.kind {
        EntryKind::Create => match fs::remove_file(&plan.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("rollback remove {}: {e}", plan.path.display())),
        },
        EntryKind::Modify | EntryKind::Delete => {
            let original = plan
                .original
                .as_ref()
                .ok_or_else(|| "rollback missing original bytes".to_string())?;
            atomic_write_replace(&plan.path, original).map_err(|e| format!("rollback {e}"))
        }
    }
}

fn push_hashed(out: &mut Vec<u8>, hasher: &mut Sha256, bytes: &[u8]) {
    out.extend_from_slice(bytes);
    hasher.update(bytes);
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex_bytes(&digest)
}

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn parse_patch(input: &str) -> Result<Vec<Entry>, String> {
    let normalized = input.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.lines().collect();
    let mut entries = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        if !lines[i].starts_with("--- ") {
            i += 1;
            continue;
        }
        let old_file = parse_file_header(lines[i], "--- ")?;
        i += 1;
        if i >= lines.len() || !lines[i].starts_with("+++ ") {
            return Err("file section missing +++ header".to_string());
        }
        let new_file = parse_file_header(lines[i], "+++ ")?;
        i += 1;

        let mut hunks = Vec::new();
        while i < lines.len() && !lines[i].starts_with("--- ") {
            if !lines[i].starts_with("@@ ") {
                i += 1;
                continue;
            }
            let (old_start, old_count, new_count) = parse_hunk_header(lines[i])?;
            i += 1;
            let mut hunk_lines = Vec::new();
            let mut old_remaining = old_count;
            let mut new_remaining = new_count;
            while i < lines.len() {
                let line = lines[i];
                // Only treat `@@ `/`--- `/`+++ ` as boundaries when the
                // declared hunk body is fully consumed. Otherwise a body
                // line like `--- x` (deletion of `-- x`) or `+++ x`
                // (addition of `++ x`) would be mis-read as a new file
                // header. The native path-escape guard in
                // `resolve_entry_path` enforces the realpath bound here.
                if old_remaining == 0 && new_remaining == 0 {
                    if line.starts_with("@@ ")
                        || line.starts_with("--- ")
                        || line.starts_with("+++ ")
                    {
                        break;
                    }
                }
                if line.starts_with('\\') {
                    hunk_lines.push(line.to_string());
                    i += 1;
                    continue;
                }
                if line.is_empty() {
                    return Err("malformed empty hunk line".to_string());
                }
                let tag = line.as_bytes()[0];
                if tag != b' ' && tag != b'-' && tag != b'+' {
                    return Err(format!("malformed hunk line: {line}"));
                }
                match tag {
                    b' ' => {
                        if old_remaining == 0 || new_remaining == 0 {
                            return Err(
                                "malformed patch: hunk body exceeds declared line counts"
                                    .to_string(),
                            );
                        }
                        old_remaining -= 1;
                        new_remaining -= 1;
                    }
                    b'-' => {
                        if old_remaining == 0 {
                            return Err(
                                "malformed patch: hunk body exceeds declared line counts"
                                    .to_string(),
                            );
                        }
                        old_remaining -= 1;
                    }
                    b'+' => {
                        if new_remaining == 0 {
                            return Err(
                                "malformed patch: hunk body exceeds declared line counts"
                                    .to_string(),
                            );
                        }
                        new_remaining -= 1;
                    }
                    _ => {}
                }
                hunk_lines.push(line.to_string());
                i += 1;
            }
            if old_remaining != 0 || new_remaining != 0 {
                return Err(
                    "malformed patch: incomplete hunk (EOF before declared line counts consumed)"
                        .to_string(),
                );
            }
            hunks.push(Hunk {
                old_start,
                lines: hunk_lines,
            });
        }
        entries.push(Entry {
            old_file,
            new_file,
            hunks,
        });
    }
    Ok(entries)
}

fn parse_file_header(line: &str, prefix: &str) -> Result<String, String> {
    let rest = line
        .strip_prefix(prefix)
        .ok_or_else(|| format!("bad file header: {line}"))?;
    // split() always yields at least one item, so next() is never None.
    let path = rest.split('\t').next().expect("split yields at least one item").trim();
    if path.is_empty() {
        return Err(format!("empty file header: {line}"));
    }
    Ok(path.to_string())
}

fn parse_hunk_header(line: &str) -> Result<(usize, usize, usize), String> {
    let mut parts = line.split_whitespace();
    if parts.next() != Some("@@") {
        return Err(format!("bad hunk header: {line}"));
    }
    let old = parts
        .next()
        .ok_or_else(|| format!("missing old range: {line}; use @@ -A,B +C,D @@ for native unified patches"))?;
    let old = old
        .strip_prefix('-')
        .ok_or_else(|| format!("bad old range: {line}; use @@ -A,B +C,D @@ for native unified patches"))?;
    let (old_start_str, old_count_str) = match old.split_once(',') {
        Some((s, c)) => (s, c),
        None => (old, "1"),
    };
    let old_start = old_start_str
        .parse::<usize>()
        .map_err(|_| format!("bad old start in hunk header: {line}; use @@ -A,B +C,D @@ for native unified patches"))?;
    let old_count = old_count_str
        .parse::<usize>()
        .map_err(|_| format!("bad old count in hunk header: {line}; use @@ -A,B +C,D @@ for native unified patches"))?;
    let new = parts
        .next()
        .ok_or_else(|| format!("missing new range: {line}; use @@ -A,B +C,D @@ for native unified patches"))?;
    let new = new
        .strip_prefix('+')
        .ok_or_else(|| format!("bad new range: {line}; use @@ -A,B +C,D @@ for native unified patches"))?;
    let (_, new_count_str) = match new.split_once(',') {
        Some((s, c)) => (s, c),
        None => (new, "1"),
    };
    let new_count = new_count_str
        .parse::<usize>()
        .map_err(|_| format!("bad new count in hunk header: {line}; use @@ -A,B +C,D @@ for native unified patches"))?;
    Ok((old_start, old_count, new_count))
}

fn is_dev_null(value: &str) -> bool {
    value == "/dev/null" || value == "dev/null"
}

fn strip_diff_prefix(value: &str) -> &str {
    value
        .strip_prefix("a/")
        .or_else(|| value.strip_prefix("b/"))
        .or_else(|| value.strip_prefix("./"))
        .unwrap_or(value)
}

fn resolve_entry_path(canonical_base: &Path, header: &str) -> Result<PathBuf, String> {
    let stripped = strip_diff_prefix(header);
    let rel = Path::new(stripped);
    if rel.is_absolute() {
        return Err(format!("absolute patch path rejected: {header}"));
    }
    if rel.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(format!("parent traversal rejected: {header}"));
    }
    let joined = canonical_base.join(rel);
    // Realpath guard: walk up to the nearest existing ancestor, canonicalize
    // it, and require it to stay inside the canonicalized base. This catches
    // symlinked subtrees that resolve outside the base directory even when
    // the header itself looks innocuous.
    let ancestor = nearest_existing_ancestor(&joined);
    let canonical_ancestor = fs::canonicalize(&ancestor).map_err(|e| {
        format!(
            "canonicalize ancestor {} for {header}: {e}",
            ancestor.display()
        )
    })?;
    if !canonical_ancestor.starts_with(canonical_base) {
        return Err(format!(
            "path escapes base directory: {header} resolves to {} outside {}",
            canonical_ancestor.display(),
            canonical_base.display()
        ));
    }
    Ok(joined)
}

fn nearest_existing_ancestor(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    loop {
        if current.exists() {
            return current;
        }
        match current.parent() {
            Some(p) if !p.as_os_str().is_empty() => current = p.to_path_buf(),
            _ => return current,
        }
    }
}

fn build_create_bytes(entry: &Entry) -> Result<Vec<u8>, String> {
    if entry.hunks.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for hunk in &entry.hunks {
        let parts = parse_hunk_parts(hunk)?;
        if !parts.old.is_empty() {
            return Err(format!(
                "create patch contains source lines in {}",
                entry.new_file
            ));
        }
        append_hunk_lines(&mut out, &parts.new, "\n");
    }
    Ok(out)
}

fn apply_exact_bytes(
    source: &[u8],
    entry: &Entry,
    fuzz_factor: usize,
) -> Result<AppliedFile, String> {
    if entry.hunks.is_empty() {
        return Err(format!("{} has no hunks", entry.old_file));
    }
    let mut cursor = 0usize;
    let mut out = Vec::with_capacity(
        source
            .len()
            .saturating_add(estimate_added_hunk_bytes(entry))
            .saturating_add(1024),
    );
    let mut hasher = Sha256::new();
    let mut line_scan = Scan { line: 0, pos: 0 };

    for hunk in &entry.hunks {
        let parts = parse_hunk_parts(hunk)?;
        let declared = apply_declared_hunk(source, hunk, &parts, cursor, &mut line_scan);
        let applied = match declared {
            Some(value) => value,
            None => {
                if fuzz_factor == 0 {
                    return Err(format!(
                        "hunk rejected in {} (exact-only, fuzz=0)",
                        entry.old_file
                    ));
                }
                apply_fuzzy_hunk(source, hunk, &parts, cursor, fuzz_factor)
                    .ok_or_else(|| format!("hunk rejected in {}", entry.old_file))?
            }
        };
        push_hashed(&mut out, &mut hasher, &source[cursor..applied.0]);
        push_hashed(&mut out, &mut hasher, &applied.2);
        cursor = applied.1;
    }

    push_hashed(&mut out, &mut hasher, &source[cursor..]);
    let digest = hasher.finalize();
    Ok(AppliedFile {
        bytes: out,
        content_hash: hex_bytes(&digest),
    })
}

// ---- invariant-safe char-indexed edit (--edit) ----
//
// Folds here are invariant-safe ONLY: each tier maps text to the SAME text in a
// different encoding (curly vs straight quote; CRLF vs LF). Heuristic-risky
// folds (dash, Unicode space, case, fullwidth, rstrip, indent-shift) are
// deliberately excluded so a match can never anchor onto a genuinely different
// region. NFC/NFD is a later stage gated behind the unicode-normalization dep.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum EditTier {
    Exact,
    Curly,
    Nfc,
    Crlf,
}

impl EditTier {
    fn label(self) -> &'static str {
        match self {
            EditTier::Exact => "exact",
            EditTier::Curly => "curly",
            EditTier::Nfc => "nfc",
            EditTier::Crlf => "crlf",
        }
    }
}

fn fold_char_curly(c: char) -> char {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
        other => other,
    }
}

// A normalized view of `s`: one entry per normalized char, paired with the
// ORIGINAL byte span [start, end) that char covers, so a match in normalized
// space maps back to a byte-exact slice of the source.
struct NormView {
    chars: Vec<char>,
    spans: Vec<(usize, usize)>,
}

fn build_norm_view(s: &str, tier: EditTier) -> NormView {
    let mut chars = Vec::new();
    let mut spans = Vec::new();
    let mut it = s.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        match tier {
            EditTier::Exact => {
                chars.push(c);
                spans.push((i, i + c.len_utf8()));
            }
            EditTier::Curly => {
                chars.push(fold_char_curly(c));
                spans.push((i, i + c.len_utf8()));
            }
            EditTier::Nfc => {
                // Canonical (NFD) decomposition: every decomposed char inherits
                // the ORIGINAL source char's byte span, so a normalized match
                // maps back to whole original chars. NFC vs NFD is invariant-safe
                // (same text, different composition).
                use unicode_normalization::char::decompose_canonical;
                let span = (i, i + c.len_utf8());
                decompose_canonical(c, |d| {
                    chars.push(d);
                    spans.push(span);
                });
            }
            EditTier::Crlf => {
                if c == '\r' {
                    if let Some(&(j, '\n')) = it.peek() {
                        it.next();
                        chars.push('\n');
                        spans.push((i, j + 1));
                        continue;
                    }
                }
                chars.push(c);
                spans.push((i, i + c.len_utf8()));
            }
        }
    }
    NormView { chars, spans }
}

fn norm_chars(s: &str, tier: EditTier) -> Vec<char> {
    build_norm_view(s, tier).chars
}

fn find_char_occurrences(hay: &[char], needle: &[char], replace_all: bool) -> Vec<usize> {
    let mut out = Vec::new();
    if needle.is_empty() || needle.len() > hay.len() {
        return out;
    }
    let mut i = 0usize;
    while i + needle.len() <= hay.len() {
        if hay[i..i + needle.len()] == *needle {
            out.push(i);
            if !replace_all && out.len() > 1 {
                return out;
            }
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

// Locate `old` in `source` through the invariant-safe tiers in order. Returns
// the matched tier and the byte spans to replace. Ambiguity within a tier
// (more than one match and not replace_all) is an error, mirroring the JS path.
// A match is safe only when it begins at the first decomposed unit of a source
// char and ends at the last unit of a source char. Without this an NFD needle
// could match starting in the middle of a decomposed source char and splice a
// byte span that cuts a character in half.
fn match_is_char_aligned(view: &NormView, m: usize, len: usize) -> bool {
    if len == 0 {
        return false;
    }
    let start_ok = m == 0 || view.spans[m].0 != view.spans[m - 1].0;
    let end_idx = m + len - 1;
    let end_ok =
        end_idx + 1 == view.chars.len() || view.spans[end_idx].1 != view.spans[end_idx + 1].1;
    start_ok && end_ok
}

// Count occurrences allowing OVERLAP (advance by 1), aligned to char
// boundaries. Used only for the ambiguity decision so native matches the JS
// editor, which treats an overlapping second hit (e.g. "aa" in "aaa") as a
// collision rather than a single match.
fn count_aligned_overlapping(view: &NormView, needle: &[char]) -> usize {
    if needle.is_empty() || needle.len() > view.chars.len() {
        return 0;
    }
    let mut n = 0usize;
    let mut i = 0usize;
    while i + needle.len() <= view.chars.len() {
        if view.chars[i..i + needle.len()] == *needle
            && match_is_char_aligned(view, i, needle.len())
        {
            n += 1;
            if n > 1 {
                return n;
            }
        }
        i += 1;
    }
    n
}

fn locate_invariant_safe_spans(
    source: &str,
    old: &str,
    replace_all: bool,
) -> Result<(EditTier, Vec<(usize, usize)>), String> {
    for tier in [
        EditTier::Exact,
        EditTier::Curly,
        EditTier::Nfc,
        EditTier::Crlf,
    ] {
        let view = build_norm_view(source, tier);
        let needle = norm_chars(old, tier);
        if needle.is_empty() {
            continue;
        }
        // Collect ALL occurrences, then keep only those aligned to original
        // character boundaries. Ambiguity is judged on aligned matches only.
        let matches: Vec<usize> = find_char_occurrences(&view.chars, &needle, true)
            .into_iter()
            .filter(|&m| match_is_char_aligned(&view, m, needle.len()))
            .collect();
        if matches.is_empty() {
            continue;
        }
        if !replace_all {
            // Overlap-aware ambiguity (matches the JS editor): a second match
            // starting one char later still counts as a collision.
            let overlap = count_aligned_overlapping(&view, &needle);
            if overlap > 1 {
                return Err(format!("old_string found {} times", overlap));
            }
        }
        let chosen: &[usize] = if replace_all { &matches } else { &matches[..1] };
        let spans = chosen
            .iter()
            .map(|&m| (view.spans[m].0, view.spans[m + needle.len() - 1].1))
            .collect();
        return Ok((tier, spans));
    }
    Err("old_string not found".to_string())
}

fn apply_invariant_safe_edit_to_path(
    path: &Path,
    old_bytes: &[u8],
    new_bytes: &[u8],
    replace_all: bool,
    dry_run: bool,
) -> Result<(ExactEditStats, EditTier), String> {
    let old = std::str::from_utf8(old_bytes)
        .map_err(|_| "old_string is not valid UTF-8".to_string())?;
    if old.is_empty() {
        return Err("old_string is empty".to_string());
    }
    let total_start = Instant::now();
    let t = Instant::now();
    let metadata = fs::metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
    let snapshot = snapshot_from_metadata(&metadata);
    let source_bytes = fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let read_ms = t.elapsed().as_secs_f64() * 1000.0;

    let source = std::str::from_utf8(&source_bytes)
        .map_err(|_| "source file is not valid UTF-8".to_string())?;

    let t = Instant::now();
    let (tier, mut spans) = locate_invariant_safe_spans(source, old, replace_all)?;
    if spans.is_empty() {
        return Err("old_string not found".to_string());
    }

    // code-10 size gate (JS parity): reject a large non-exact (fold) match
    // without replace_all — a 30+ line curly/NFC/CRLF match is too likely to
    // have anchored on the wrong block.
    if !replace_all && tier != EditTier::Exact {
        let lines = old.split('\n').count();
        if lines >= 30 {
            return Err(format!("old_string is {lines} lines (>= 30)."));
        }
    }

    // Pure-deletion newline absorption (JS parity): when new is empty and old
    // does not already end in a line terminator, extend each span over its own
    // trailing CRLF / LF / CR so the deleted line leaves no blank residue.
    if new_bytes.is_empty() && !old.ends_with('\n') && !old.ends_with('\r') {
        for span in spans.iter_mut() {
            let e = span.1;
            if source_bytes.get(e) == Some(&b'\r') && source_bytes.get(e + 1) == Some(&b'\n') {
                span.1 = e + 2;
            } else if source_bytes.get(e) == Some(&b'\n') || source_bytes.get(e) == Some(&b'\r') {
                span.1 = e + 1;
            }
        }
    }

    let mut out = Vec::with_capacity(source_bytes.len());
    let mut hasher = Sha256::new();
    let mut cursor = 0usize;
    for &(start, end) in &spans {
        push_hashed(&mut out, &mut hasher, &source_bytes[cursor..start]);
        // EOL preservation (JS parity): match the replacement's line endings to
        // the slice it replaces so a CRLF file is not silently degraded to LF.
        let new_eol = preserve_eol(new_bytes, &source_bytes[start..end], &source_bytes);
        push_hashed(&mut out, &mut hasher, &new_eol);
        cursor = end;
    }
    push_hashed(&mut out, &mut hasher, &source_bytes[cursor..]);
    let content_hash = hex_bytes(&hasher.finalize());
    let apply_ms = t.elapsed().as_secs_f64() * 1000.0;

    let mut write_ms = 0.0f64;
    if !dry_run {
        let t = Instant::now();
        snapshot_matches(path, &snapshot)?;
        atomic_write_replace(path, &out)?;
        write_ms = t.elapsed().as_secs_f64() * 1000.0;
    }
    Ok((
        ExactEditStats {
            replacements: spans.len(),
            read_ms,
            apply_ms,
            write_ms,
            total_ms: total_start.elapsed().as_secs_f64() * 1000.0,
            content_hash,
        },
        tier,
    ))
}

// Mirror replacementForOriginalSlice (edit-match-utils.mjs): adjust the new
// text's line endings to match the original slice being replaced, with the
// mixed-EOL guard so we never synthesise CRLF where the file uses bare LF.
fn preserve_eol(new_bytes: &[u8], slice: &[u8], file: &[u8]) -> Vec<u8> {
    let new_str = match std::str::from_utf8(new_bytes) {
        Ok(s) => s,
        Err(_) => return new_bytes.to_vec(),
    };
    let slice_str = String::from_utf8_lossy(slice);
    let has_crlf = slice_str.contains("\r\n");
    let has_lf = slice_str.contains('\n');
    if !has_crlf && !has_lf {
        // Single-line slice: only upgrade LF->CRLF when the WHOLE file is pure
        // CRLF (no bare LF); otherwise leave new untouched to avoid mixed-EOL.
        if !file.windows(2).any(|w| w == b"\r\n") {
            return new_bytes.to_vec();
        }
        for i in 0..file.len() {
            if file[i] == b'\n' && (i == 0 || file[i - 1] != b'\r') {
                return new_bytes.to_vec();
            }
        }
        return new_str.replace("\r\n", "\n").replace('\n', "\r\n").into_bytes();
    }
    let lf_replacement = new_str.replace("\r\n", "\n");
    let mut result = if has_crlf {
        lf_replacement.replace('\n', "\r\n")
    } else {
        lf_replacement
    };
    if slice_str.ends_with('\r') && !result.ends_with('\r') && !result.ends_with('\n') {
        result.push('\r');
    }
    result.into_bytes()
}

fn estimate_added_hunk_bytes(entry: &Entry) -> usize {
    let mut bytes = 0usize;
    for hunk in &entry.hunks {
        for line in &hunk.lines {
            if line.as_bytes().first() == Some(&b'+') {
                bytes = bytes
                    .saturating_add(line.len().saturating_sub(1))
                    .saturating_add(2);
            }
        }
    }
    bytes
}

fn parse_hunk_parts(hunk: &Hunk) -> Result<HunkParts, String> {
    let mut old: Vec<HunkLine> = Vec::new();
    let mut new: Vec<HunkLine> = Vec::new();
    let mut ops: Vec<HunkOp> = Vec::new();
    let mut last_op: Option<usize> = None;
    let mut last_old: Option<usize> = None;
    let mut last_new: Option<usize> = None;

    for raw in &hunk.lines {
        if raw.starts_with('\\') {
            let Some(idx) = last_op else {
                return Err("no-newline marker without previous hunk line".to_string());
            };
            match ops[idx].tag {
                HunkTag::Context => {
                    ops[idx].new_has_newline = false;
                    if let Some(i) = last_old {
                        old[i].has_newline = false;
                    }
                    if let Some(i) = last_new {
                        new[i].has_newline = false;
                    }
                }
                HunkTag::Delete => {
                    if let Some(i) = last_old {
                        old[i].has_newline = false;
                    }
                }
                HunkTag::Add => {
                    ops[idx].new_has_newline = false;
                    if let Some(i) = last_new {
                        new[i].has_newline = false;
                    }
                }
            }
            continue;
        }
        if raw.is_empty() {
            return Err("malformed empty hunk line".to_string());
        }
        let tag = raw.as_bytes()[0];
        let body = raw.as_bytes()[1..].to_vec();
        match tag {
            b' ' => {
                old.push(HunkLine {
                    tag: HunkTag::Context,
                    body: body.clone(),
                    has_newline: true,
                });
                new.push(HunkLine {
                    tag: HunkTag::Context,
                    body: body.clone(),
                    has_newline: true,
                });
                ops.push(HunkOp {
                    tag: HunkTag::Context,
                    body,
                    new_has_newline: true,
                });
                last_old = Some(old.len() - 1);
                last_new = Some(new.len() - 1);
                last_op = Some(ops.len() - 1);
            }
            b'-' => {
                old.push(HunkLine {
                    tag: HunkTag::Delete,
                    body: body.clone(),
                    has_newline: true,
                });
                ops.push(HunkOp {
                    tag: HunkTag::Delete,
                    body,
                    new_has_newline: true,
                });
                last_old = Some(old.len() - 1);
                last_op = Some(ops.len() - 1);
            }
            b'+' => {
                new.push(HunkLine {
                    tag: HunkTag::Add,
                    body: body.clone(),
                    has_newline: true,
                });
                ops.push(HunkOp {
                    tag: HunkTag::Add,
                    body,
                    new_has_newline: true,
                });
                last_new = Some(new.len() - 1);
                last_op = Some(ops.len() - 1);
            }
            _ => return Err("bad hunk tag".to_string()),
        }
    }
    Ok(HunkParts { old, new, ops })
}

fn append_hunk_lines(out: &mut Vec<u8>, lines: &[HunkLine], eol: &str) {
    for line in lines {
        out.extend_from_slice(&line.body);
        if line.has_newline {
            out.extend_from_slice(eol.as_bytes());
        }
    }
}

fn hunk_lines_to_bytes(lines: &[HunkLine], eol: &str) -> Vec<u8> {
    let mut out = Vec::new();
    append_hunk_lines(&mut out, lines, eol);
    out
}

/// When the source file's last line has no trailing newline, unified-diff hunks
/// still encode that line with the default `has_newline: true` unless a `\`
/// no-newline marker is present. Allow that single-line EOF mismatch for the
/// last old hunk line only.
fn hunk_old_lines_eof_relaxed(parts: &HunkParts) -> Vec<HunkLine> {
    if parts.old.is_empty() {
        return Vec::new();
    }
    let mut lines = parts.old.clone();
    let last = lines.len() - 1;
    lines[last].has_newline = false;
    lines
}

fn old_hunk_span_matches(parts: &HunkParts, span: &[u8]) -> Option<&'static str> {
    for eol in ["\n", "\r\n"] {
        if span == hunk_lines_to_bytes(&parts.old, eol).as_slice() {
            return Some(eol);
        }
    }
    let relaxed = hunk_old_lines_eof_relaxed(parts);
    for eol in ["\n", "\r\n"] {
        if span == hunk_lines_to_bytes(&relaxed, eol).as_slice() {
            return Some(eol);
        }
    }
    None
}

fn newline_flags_compatible(
    line: &SourceLine,
    expected: &HunkLine,
    is_last_old_in_hunk: bool,
    is_last_line_in_file: bool,
) -> bool {
    if expected.has_newline == line.has_newline {
        return true;
    }
    is_last_old_in_hunk
        && is_last_line_in_file
        && expected.has_newline
        && !line.has_newline
}

fn source_line_matches_eof_aware(
    source: &[u8],
    line: &SourceLine,
    expected: &HunkLine,
    is_last_old_in_hunk: bool,
    is_last_line_in_file: bool,
) -> bool {
    if source_line_matches(source, line, expected) {
        return true;
    }
    if !newline_flags_compatible(
        line,
        expected,
        is_last_old_in_hunk,
        is_last_line_in_file,
    ) {
        return false;
    }
    source[line.start..line.body_end] == expected.body
}

fn apply_declared_hunk(
    source: &[u8],
    hunk: &Hunk,
    parts: &HunkParts,
    cursor: usize,
    scan: &mut Scan,
) -> Option<(usize, usize, Vec<u8>)> {
    let mut local_scan = *scan;
    if parts.old.is_empty() {
        if parts.new.is_empty() {
            return None;
        }
        // Reject anchors past EOF: line_start_at clamps to source.len() for any
        // out-of-range target, which would silently accept an insert at the
        // wrong location. Insert-only hunks here use the unified-diff
        // convention `@@ -N,0 +M,K @@` where N is the old-file line AFTER
        // which lines are inserted (passed straight to line_start_at as a
        // 0-based "skip N newlines" count, unlike the delete/context branch
        // below which subtracts 1). Valid range is 0..=line_count:
        //   N = 0          -> insert at the very top
        //   N = line_count -> append at EOF (line_start_at returns source.len())
        // N == line_count + 1 has no line to anchor after; line_start_at would
        // silently clamp it to source.len() too, indistinguishable from the
        // legitimate append. Reject it explicitly.
        if hunk.old_start > count_source_lines(source) {
            return None;
        }
        let start_offset = line_start_at_cached(source, hunk.old_start, &mut local_scan)?;
        if start_offset < cursor {
            return None;
        }
        let eol = insertion_line_ending_at(source, start_offset);
        *scan = local_scan;
        return Some((
            start_offset,
            start_offset,
            hunk_lines_to_bytes(&parts.new, eol),
        ));
    }

    let start_line = hunk.old_start.saturating_sub(1);
    let start_offset = line_start_at_cached(source, start_line, &mut local_scan)?;
    let end_offset = line_start_at_cached(source, start_line + parts.old.len(), &mut local_scan)?;
    if start_offset < cursor || end_offset < start_offset {
        return None;
    }
    let span = &source[start_offset..end_offset];
    let Some(matched_eol) = old_hunk_span_matches(parts, span) else {
        return None;
    };
    *scan = local_scan;
    Some((
        start_offset,
        end_offset,
        hunk_lines_to_bytes(&parts.new, matched_eol),
    ))
}

fn apply_fuzzy_hunk(
    source: &[u8],
    hunk: &Hunk,
    parts: &HunkParts,
    cursor: usize,
    fuzz_factor: usize,
) -> Option<(usize, usize, Vec<u8>)> {
    if parts.old.is_empty() {
        return None;
    }
    let lines = split_source_lines(source);
    if parts.old.len() > lines.len() {
        return None;
    }
    let target_idx = hunk.old_start.saturating_sub(1);
    // best tuple: (fuzz, norm_count, distance, start_offset, end_offset, bytes)
    let mut best: Option<(usize, usize, usize, usize, usize, Vec<u8>)> = None;
    for idx in 0..=lines.len().saturating_sub(parts.old.len()) {
        let start_offset = lines[idx].start;
        if start_offset < cursor {
            continue;
        }
        let Some((fuzz, norm_count, new_bytes)) =
            evaluate_fuzzy_candidate(source, &lines, idx, parts, fuzz_factor)
        else {
            continue;
        };
        let distance = idx.abs_diff(target_idx);
        let end_offset = lines[idx + parts.old.len() - 1].end;
        // Ordering: lower fuzz first, THEN fewer normalization-only matches,
        // THEN smaller distance. This guarantees a block that anchored WITHOUT
        // normalization always beats one that needed it, regardless of how much
        // nearer the normalized block sits to the target line.
        let replace = match &best {
            None => true,
            Some((best_fuzz, best_norm, best_dist, _, _, _)) => {
                fuzz < *best_fuzz
                    || (fuzz == *best_fuzz && norm_count < *best_norm)
                    || (fuzz == *best_fuzz
                        && norm_count == *best_norm
                        && distance < *best_dist)
            }
        };
        if replace {
            best = Some((fuzz, norm_count, distance, start_offset, end_offset, new_bytes));
        }
    }
    best.map(|(_, _, _, start, end, bytes)| (start, end, bytes))
}

fn evaluate_fuzzy_candidate(
    source: &[u8],
    lines: &[SourceLine],
    idx: usize,
    parts: &HunkParts,
    fuzz_factor: usize,
) -> Option<(usize, usize, Vec<u8>)> {
    // Change band, computed from BOTH Add and Delete positions (not deletes
    // only). Context lines before the first change or after the last change are
    // the hunk's OUTER context and may drift under the fuzz factor (classic
    // `patch` fuzz). Any context line BETWEEN two changes is interior context:
    // it must match (modulo trailing whitespace), otherwise the hunk is binding
    // to a different block and we must reject rather than silently patch the
    // wrong location.
    //
    // Adds live in parts.ops (the in-order op sequence), not in parts.old, and
    // an Add sits BETWEEN two old lines rather than at an old index. To compare
    // it against old-context positions we use a doubled+shifted coordinate over
    // the old-index space: an old Context/Delete at old offset `o` maps to
    // 2*(o + 1), while an Add inserted at old cursor `k` (after k old lines were
    // consumed) maps to 2*k + 1, landing strictly between its neighboring old
    // lines. Tracking the min/max change position over Adds AND Deletes yields a
    // band that correctly flags interior context between two adds, or between an
    // add and a delete, which a delete-only band would miss.
    let mut first_change_pos: Option<usize> = None;
    let mut last_change_pos: Option<usize> = None;
    {
        let mut old_cursor = 0usize;
        for op in &parts.ops {
            match op.tag {
                HunkTag::Context => {
                    old_cursor += 1;
                }
                HunkTag::Delete => {
                    let pos = (old_cursor + 1) * 2;
                    first_change_pos = Some(first_change_pos.map_or(pos, |v| v.min(pos)));
                    last_change_pos = Some(last_change_pos.map_or(pos, |v| v.max(pos)));
                    old_cursor += 1;
                }
                HunkTag::Add => {
                    let pos = old_cursor * 2 + 1;
                    first_change_pos = Some(first_change_pos.map_or(pos, |v| v.min(pos)));
                    last_change_pos = Some(last_change_pos.map_or(pos, |v| v.max(pos)));
                }
            }
        }
    }

    let mut fuzz = 0usize;
    // Count of lines in this candidate that matched ONLY via the Unicode
    // normalization tier. Normalization is deterministic but lossy enough to
    // create extra collisions, so a block that needed it must never beat a
    // block that matched exactly/whitespace-only. Tracking the count lets the
    // best-candidate selector prefer non-normalized matches.
    let mut norm_count = 0usize;
    for (offset, expected) in parts.old.iter().enumerate() {
        let src = lines.get(idx + offset)?;
        let is_last_old_in_hunk = offset + 1 == parts.old.len();
        let is_last_line_in_file = idx + offset + 1 == lines.len();
        if source_line_matches_eof_aware(
            source,
            src,
            expected,
            is_last_old_in_hunk,
            is_last_line_in_file,
        ) {
            continue;
        }
        // Whitespace-only drift (leading OR trailing) is always tolerated and
        // costs no fuzz, for Context AND Delete lines alike. This mirrors
        // Codex apply_patch, which normalises whitespace (rstrip/strip) across
        // every context+delete line before comparing, so indentation reflow
        // never blocks a hunk. Content (non-whitespace) drift is unaffected:
        // it still falls through to the outer/interior fuzz-budget logic below
        // for Context, and to a hard reject for Delete.
        if fuzz_factor > 0
            && matches!(expected.tag, HunkTag::Context | HunkTag::Delete)
            && source_context_line_matches_fuzzy(
                source,
                src,
                expected,
                is_last_old_in_hunk,
                is_last_line_in_file,
            )
        {
            continue;
        }
        // Unicode-normalization tier: an ASCII-authored patch line that
        // differs from the source only by typographic dashes / quotes /
        // exotic spaces is treated as an exact match at ZERO fuzz cost. This
        // is a deterministic code-point normalization (not a heuristic
        // guess), so it is safe for interior context lines too — unlike the
        // outer-context-only content fuzz below. Mirrors Codex apply_patch's
        // final normalise() pass in seek_sequence.rs.
        if fuzz_factor > 0
            && matches!(expected.tag, HunkTag::Context | HunkTag::Delete)
            && source_context_line_matches_normalized(
                source,
                src,
                expected,
                is_last_old_in_hunk,
                is_last_line_in_file,
            )
        {
            norm_count += 1;
            continue;
        }
        match expected.tag {
            HunkTag::Context => {
                // Only outer (leading/trailing) context lines may differ in
                // content, and only within the fuzz budget. An interior context
                // mismatch means a different block — reject it rather than
                // counting it as tolerable fuzz.
                // Map this context line into the same doubled coordinate space
                // used for the change band: an old line at offset `offset` lives
                // at (offset + 1) * 2. It is interior iff it lies strictly
                // between the first and last change position.
                let ctx_pos = (offset + 1) * 2;
                let is_outer = match (first_change_pos, last_change_pos) {
                    (Some(f), Some(l)) => ctx_pos < f || ctx_pos > l,
                    // No changes at all (degenerate): there is no interior band,
                    // so all context is outer/anchor context.
                    _ => true,
                };
                if !is_outer {
                    return None;
                }
                fuzz += 1;
                if fuzz > fuzz_factor {
                    return None;
                }
            }
            // parts.old only ever carries Context/Delete lines; Add is
            // unreachable here but must be matched for exhaustiveness and is
            // treated as a non-match (return None) defensively.
            HunkTag::Delete | HunkTag::Add => return None,
        }
    }

    // idx is bound to 0..=lines.len()-parts.old.len() above, and parts.old is
    // non-empty, so lines[idx] is always in range.
    let anchor = &lines[idx];
    let fallback_eol = source_line_eol(source, anchor)
        .unwrap_or_else(|| insertion_line_ending_at(source, anchor.start));
    let mut new_bytes = Vec::new();
    let mut old_offset = 0usize;
    for op in &parts.ops {
        match op.tag {
            HunkTag::Context => {
                let src = lines.get(idx + old_offset)?;
                new_bytes.extend_from_slice(&source[src.start..src.end]);
                old_offset += 1;
            }
            HunkTag::Delete => {
                old_offset += 1;
            }
            HunkTag::Add => {
                new_bytes.extend_from_slice(&op.body);
                if op.new_has_newline {
                    new_bytes.extend_from_slice(fallback_eol.as_bytes());
                }
            }
        }
    }
    Some((fuzz, norm_count, new_bytes))
}

fn source_line_matches(source: &[u8], line: &SourceLine, expected: &HunkLine) -> bool {
    // Newline presence must match in both directions: a patch expecting a
    // trailing newline must not silently apply on top of an EOF line that has
    // none (and vice versa).
    if expected.has_newline != line.has_newline {
        return false;
    }
    source[line.start..line.body_end] == expected.body
}

fn trim_patch_ws(bytes: &[u8]) -> &[u8] {
    // Strip leading AND trailing horizontal whitespace, matching Codex's
    // strip-level context normalisation (not just the old trailing-only trim).
    let mut start = 0usize;
    let mut end = bytes.len();
    while start < end && matches!(bytes[start], b' ' | b'\t') {
        start += 1;
    }
    while end > start && matches!(bytes[end - 1], b' ' | b'\t') {
        end -= 1;
    }
    &bytes[start..end]
}

fn source_context_line_matches_fuzzy(
    source: &[u8],
    line: &SourceLine,
    expected: &HunkLine,
    is_last_old_in_hunk: bool,
    is_last_line_in_file: bool,
) -> bool {
    if !newline_flags_compatible(
        line,
        expected,
        is_last_old_in_hunk,
        is_last_line_in_file,
    ) {
        return false;
    }
    trim_patch_ws(&source[line.start..line.body_end]) == trim_patch_ws(&expected.body)
}

/// Map common typographic code-points to their ASCII equivalents, then trim.
/// Mirrors Codex apply_patch's `normalise()` (seek_sequence.rs) so an
/// ASCII-authored patch can still anchor against source containing curly
/// quotes, em/en dashes, NBSP and other exotic spaces.
fn normalize_typographic(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .map(|c| match c {
            // Various dash / hyphen code-points -> ASCII '-'
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => '-',
            // Fancy single quotes -> '\''
            '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
            // Fancy double quotes -> '"'
            '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
            // Non-breaking space and other odd spaces -> normal space
            '\u{00A0}' | '\u{2002}' | '\u{2003}' | '\u{2004}' | '\u{2005}' | '\u{2006}'
            | '\u{2007}' | '\u{2008}' | '\u{2009}' | '\u{200A}' | '\u{202F}' | '\u{205F}'
            | '\u{3000}' => ' ',
            other => other,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn source_context_line_matches_normalized(
    source: &[u8],
    line: &SourceLine,
    expected: &HunkLine,
    is_last_old_in_hunk: bool,
    is_last_line_in_file: bool,
) -> bool {
    if !newline_flags_compatible(
        line,
        expected,
        is_last_old_in_hunk,
        is_last_line_in_file,
    ) {
        return false;
    }
    // Guard against lossy UTF-8 decoding: normalize_typographic relies on
    // String::from_utf8_lossy, which collapses every invalid byte to U+FFFD.
    // Without this guard a patch line carrying U+FFFD (or one decoded to it)
    // could spuriously match arbitrary invalid source bytes. Only attempt a
    // normalized comparison when BOTH the source body and the expected body
    // are valid UTF-8; otherwise there is no normalized match.
    let src_body = &source[line.start..line.body_end];
    if std::str::from_utf8(src_body).is_err() || std::str::from_utf8(&expected.body).is_err() {
        return false;
    }
    normalize_typographic(src_body) == normalize_typographic(&expected.body)
}

fn source_line_eol<'a>(source: &'a [u8], line: &SourceLine) -> Option<&'a str> {
    if !line.has_newline {
        return None;
    }
    if line.body_end + 1 < line.end
        && source.get(line.body_end) == Some(&b'\r')
        && source.get(line.body_end + 1) == Some(&b'\n')
    {
        return Some("\r\n");
    }
    Some("\n")
}

fn split_source_lines(source: &[u8]) -> Vec<SourceLine> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    while start < source.len() {
        match memchr_lf(source, start) {
            Some(nl) => {
                let body_end = if nl > start && source[nl - 1] == b'\r' {
                    nl - 1
                } else {
                    nl
                };
                lines.push(SourceLine {
                    start,
                    body_end,
                    end: nl + 1,
                    has_newline: true,
                });
                start = nl + 1;
            }
            None => {
                lines.push(SourceLine {
                    start,
                    body_end: source.len(),
                    end: source.len(),
                    has_newline: false,
                });
                break;
            }
        }
    }
    lines
}

fn line_start_at_fresh(source: &[u8], target_line: usize) -> Option<usize> {
    let mut scan = Scan { line: 0, pos: 0 };
    line_start_at(source, target_line, &mut scan)
}

fn line_start_at_cached(source: &[u8], target_line: usize, scan: &mut Scan) -> Option<usize> {
    if target_line < scan.line {
        return line_start_at_fresh(source, target_line);
    }
    line_start_at(source, target_line, scan)
}

fn line_start_at(source: &[u8], target_line: usize, scan: &mut Scan) -> Option<usize> {
    if target_line < scan.line {
        return None;
    }
    while scan.line < target_line {
        match memchr_lf(source, scan.pos) {
            Some(nl) => {
                scan.pos = nl + 1;
                scan.line += 1;
            }
            None => {
                scan.line = target_line;
                scan.pos = source.len();
                return Some(source.len());
            }
        }
    }
    Some(scan.pos)
}

fn memchr_lf(source: &[u8], start: usize) -> Option<usize> {
    memchr(b'\n', source.get(start..)?).map(|idx| start + idx)
}

fn count_source_lines(source: &[u8]) -> usize {
    if source.is_empty() {
        return 0;
    }
    let mut n = 0usize;
    let mut pos = 0usize;
    while let Some(nl) = memchr_lf(source, pos) {
        n += 1;
        pos = nl + 1;
    }
    if pos < source.len() {
        n += 1;
    }
    n
}

fn insertion_line_ending_at(source: &[u8], byte_offset: usize) -> &'static str {
    if byte_offset >= 2 && source[byte_offset - 1] == b'\n' && source[byte_offset - 2] == b'\r' {
        return "\r\n";
    }
    if let Some(next_lf) = memchr_lf(source, byte_offset) {
        if next_lf > 0 && source[next_lf - 1] == b'\r' {
            return "\r\n";
        }
    }
    "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hunk(old_start: usize, lines: &[&str]) -> Hunk {
        Hunk {
            old_start,
            lines: lines.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    #[test]
    fn normalized_tier_matches_typographic_interior_context() {
        // Source whose INTERIOR context line carries an em-dash (U+2014), a
        // non-breaking space (U+00A0), and curly double quotes (U+201C/U+201D).
        // The patch is authored in plain ASCII. Without the Unicode-
        // normalization tier this interior context line would mismatch and the
        // hunk would be rejected (interior content drift is not tolerated by the
        // outer-context fuzz budget); with it, the hunk applies at zero fuzz.
        let source = "old first\nconfig\u{00A0}\u{2014} \u{201C}value\u{201D}\nold last\n";
        let entry = Entry {
            old_file: "f".to_string(),
            new_file: "f".to_string(),
            hunks: vec![hunk(
                1,
                &[
                    "-old first",
                    "+new first",
                    " config - \"value\"",
                    "-old last",
                    "+new last",
                ],
            )],
        };

        let applied = apply_exact_bytes(source.as_bytes(), &entry, 2)
            .expect("ASCII patch should apply against typographic source");

        // The context line is copied verbatim from the source (typography
        // preserved); only the surrounding delete/add lines change.
        let expected = "new first\nconfig\u{00A0}\u{2014} \u{201C}value\u{201D}\nnew last\n";
        assert_eq!(String::from_utf8_lossy(&applied.bytes), expected);
    }

    #[test]
    fn far_exact_block_beats_nearer_normalized_block() {
        // Two candidate blocks for the same single-line delete:
        //   idx 1: a NEAR typographic variant (em-dash + curly quotes) that
        //          only matches the ASCII patch after Unicode normalization.
        //   idx 5: a FAR exact ASCII match.
        // The hunk targets old_start=2 (target_idx=1), so the normalized block
        // sits at distance 0 and the exact block at distance 4. Before the
        // norm_count tiebreak, both scored fuzz 0 and the nearer normalized
        // block would have won (mis-anchoring onto typographic source). The fix
        // requires a block that matched WITHOUT normalization to always win,
        // regardless of distance.
        let source = concat!(
            "alpha\n",
            "config \u{2014} \u{201C}x\u{201D}\n", // idx 1: normalized-only, NEAR
            "beta\n",
            "gamma\n",
            "delta\n",
            "config - \"x\"\n", // idx 5: exact ASCII, FAR
            "omega\n",
        );
        let entry = Entry {
            old_file: "f".to_string(),
            new_file: "f".to_string(),
            hunks: vec![hunk(2, &["-config - \"x\"", "+config - \"y\""])],
        };

        let applied = apply_exact_bytes(source.as_bytes(), &entry, 2)
            .expect("hunk should apply via the far exact block");

        // The FAR exact block (idx 5) must be the one replaced; the NEAR
        // typographic line (idx 1) must remain byte-for-byte untouched.
        let expected = concat!(
            "alpha\n",
            "config \u{2014} \u{201C}x\u{201D}\n",
            "beta\n",
            "gamma\n",
            "delta\n",
            "config - \"y\"\n",
            "omega\n",
        );
        assert_eq!(String::from_utf8_lossy(&applied.bytes), expected);
    }

    #[test]
    fn append_after_eof_line_without_trailing_newline() {
        let source = b"line1\nline2-nonl";
        let entry = Entry {
            old_file: "f".to_string(),
            new_file: "f".to_string(),
            hunks: vec![hunk(2, &[" line2-nonl", "+line3"])],
        };

        let applied = apply_exact_bytes(source, &entry, 2)
            .expect("append after no-trailing-newline EOF line");
        assert_eq!(
            String::from_utf8_lossy(&applied.bytes),
            "line1\nline2-nonl\nline3\n"
        );
    }

    #[test]
    fn normalize_typographic_maps_dashes_quotes_spaces() {
        assert_eq!(
            normalize_typographic("\u{2014}a\u{00A0}b\u{2019}c\u{201D}".as_bytes()),
            "-a b'c\""
        );
    }

    #[test]
    fn edit2_exact_curly_crlf_tiers() {
        let (tier, spans) =
            locate_invariant_safe_spans("hello world", "world", false).unwrap();
        assert_eq!(tier, EditTier::Exact);
        assert_eq!(spans, vec![(6, 11)]);

        // Source carries curly double quotes; the needle uses straight quotes.
        let src = "say \u{201C}hi\u{201D} now";
        let (tier, spans) = locate_invariant_safe_spans(src, "\"hi\"", false).unwrap();
        assert_eq!(tier, EditTier::Curly);
        assert_eq!(&src[spans[0].0..spans[0].1], "\u{201C}hi\u{201D}");

        // Source uses CRLF; the needle uses LF.
        let src = "a\r\nb\r\nc";
        let (tier, spans) = locate_invariant_safe_spans(src, "a\nb", false).unwrap();
        assert_eq!(tier, EditTier::Crlf);
        assert_eq!(&src[spans[0].0..spans[0].1], "a\r\nb");
    }

    #[test]
    fn edit2_ambiguous_without_replace_all_errors() {
        let err = locate_invariant_safe_spans("x x x", "x", false).unwrap_err();
        assert!(err.contains("found"));
    }

    #[test]
    fn edit2_overlapping_ambiguity_rejected() {
        // "aa" overlaps at idx 0 and 1 in "aaa"; must be ambiguous like the JS editor.
        let err = locate_invariant_safe_spans("aaa", "aa", false).unwrap_err();
        assert!(err.contains("found"));
        // replace_all still applies a single non-overlapping replacement.
        let (_, spans) = locate_invariant_safe_spans("aaa", "aa", true).unwrap();
        assert_eq!(spans.len(), 1);
    }

    #[test]
    fn preserve_eol_matches_slice() {
        // multiline slice with CRLF: LF replacement upgraded to CRLF
        assert_eq!(preserve_eol(b"a\nb", b"x\r\ny", b"x\r\ny\r\n"), b"a\r\nb");
        // LF slice: untouched
        assert_eq!(preserve_eol(b"a\nb", b"x\ny", b"x\ny"), b"a\nb");
        // single-line slice in pure-CRLF file: LF -> CRLF
        assert_eq!(preserve_eol(b"a\nb", b"word", b"l1\r\nl2\r\n"), b"a\r\nb");
        // single-line slice in LF file: untouched (no mixed-EOL synthesis)
        assert_eq!(preserve_eol(b"a\nb", b"word", b"l1\nl2\n"), b"a\nb");
    }

    #[test]
    fn edit2_replace_all_collects_all() {
        let (tier, spans) = locate_invariant_safe_spans("x x x", "x", true).unwrap();
        assert_eq!(tier, EditTier::Exact);
        assert_eq!(spans.len(), 3);
    }

    #[test]
    fn edit2_nfc_matches_precomposed_vs_decomposed() {
        // Source has precomposed 'é' (U+00E9); needle uses decomposed e + U+0301.
        let src = "caf\u{00E9} bar";
        let needle = "caf\u{0065}\u{0301}";
        let (tier, spans) = locate_invariant_safe_spans(src, needle, false).unwrap();
        assert_eq!(tier, EditTier::Nfc);
        assert_eq!(&src[spans[0].0..spans[0].1], "caf\u{00E9}");
    }

    #[test]
    fn edit2_nfc_respects_char_boundary() {
        // The lone combining acute must NOT match by splitting the source 'é'.
        let src = "x\u{00E9}y";
        let res = locate_invariant_safe_spans(src, "\u{0301}", false);
        assert!(res.is_err());
    }
}
