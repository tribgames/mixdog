// Filesystem side of the engine: metadata snapshots, atomic replace/create
// writes with Windows retry, plan persistence/rollback and hashing.

use super::*;

pub(crate) fn snapshot_from_metadata(metadata: &fs::Metadata) -> FileSnapshot {
    FileSnapshot {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    }
}

/// Within-operation consistency check, NOT hostile-race hardening: entries are
/// read (and applied in memory, possibly on worker threads) during planning and
/// written later, so a file that changed in between — an editor save, a build
/// step, an earlier wave of the same request — would otherwise be overwritten
/// with bytes computed from stale content, and `plan.original` (the rollback
/// source) would no longer describe the file. Size+mtime is the cheapest check
/// that keeps both truthful.
pub(crate) fn snapshot_matches(path: &Path, snapshot: &FileSnapshot) -> Result<(), String> {
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

pub(crate) fn native_atomic_fsync_enabled() -> bool {
    match env::var("MIXDOG_NATIVE_ATOMIC_FSYNC") {
        Ok(value) => matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on" | "sync"
        ),
        Err(_) => false,
    }
}

#[cfg(windows)]
pub(crate) fn rename_atomic_replace(src: &Path, dst: &Path) -> io::Result<()> {
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
pub(crate) fn rename_atomic_replace(src: &Path, dst: &Path) -> io::Result<()> {
    fs::rename(src, dst)
}

#[cfg(windows)]
pub(crate) fn is_transient_windows_replace_error(err: &io::Error) -> bool {
    // ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION.
    // Antivirus/indexer/editor handles can hold the destination briefly.
    matches!(err.raw_os_error(), Some(5 | 32 | 33))
}

#[cfg(windows)]
pub(crate) fn rename_atomic_replace_with_retry(
    src: &Path,
    dst: &Path,
    original: Option<&FileSnapshot>,
) -> Result<(), String> {
    const BACKOFFS_MS: [u64; 8] = [25, 50, 100, 200, 400, 800, 1200, 1600];
    for attempt in 0..=BACKOFFS_MS.len() {
        if attempt > 0 {
            if let Some(snapshot) = original {
                snapshot_matches(dst, snapshot).map_err(|err| {
                    format!("target changed while retrying Windows atomic replace: {err}")
                })?;
            }
        }
        match rename_atomic_replace(src, dst) {
            Ok(()) => return Ok(()),
            Err(err) if is_transient_windows_replace_error(&err) && attempt < BACKOFFS_MS.len() => {
                thread::sleep(Duration::from_millis(BACKOFFS_MS[attempt]));
            }
            Err(err) => return Err(err.to_string()),
        }
    }
    unreachable!("bounded Windows atomic replace retry loop must return")
}

#[cfg(not(windows))]
pub(crate) fn rename_atomic_replace_with_retry(
    src: &Path,
    dst: &Path,
    _original: Option<&FileSnapshot>,
) -> Result<(), String> {
    rename_atomic_replace(src, dst).map_err(|err| err.to_string())
}

pub(crate) fn atomic_write_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
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
    let existing = fs::metadata(path).ok();
    let existing_permissions = existing.as_ref().map(|m| m.permissions());
    let original_snapshot = existing.as_ref().map(snapshot_from_metadata);

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
            rename_atomic_replace_with_retry(&tmp, path, original_snapshot.as_ref())
                .map_err(io::Error::other)
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

/// Creation IS the atomic step: `create_new` (O_CREAT|O_EXCL) fails with
/// AlreadyExists for an existing file, directory or symlink, so an Add File can
/// never overwrite or follow an existing entry, and rollback stays a plain
/// `remove_file`. A temp-file + hard-link dance buys nothing for those two
/// guarantees (and fails on filesystems without hard links).
pub(crate) fn atomic_write_create_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_create_new_with(
        path,
        bytes,
        |file, bytes| {
            file.write_all(bytes)?;
            if native_atomic_fsync_enabled() {
                file.sync_all()
            } else {
                Ok(())
            }
        },
        |path: &Path| fs::remove_file(path),
    )
}

/// `write` and `remove` are injected so the "persistence failed AND the
/// half-written file could not be removed" report is reachable in a test
/// without an adversarial filesystem. Production passes the real ones.
pub(crate) fn atomic_write_create_new_with(
    path: &Path,
    bytes: &[u8],
    write: impl FnOnce(&mut fs::File, &[u8]) -> io::Result<()>,
    remove: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<(), String> {
    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            return Err(format!("create target already exists: {}", path.display()));
        }
        Err(err) => return Err(format!("atomic create {}: {err}", path.display())),
    };
    if let Err(err) = write(&mut file, bytes) {
        drop(file);
        // The exclusive create already published the name, so a failed write
        // leaves a partial file. If the cleanup removal ALSO fails the caller
        // must hear it: reject_partial would otherwise imply nothing landed.
        if let Err(cleanup) = remove(path) {
            return Err(format!(
                "atomic create {}: {err}; cleanup incomplete: partial file left on disk ({})",
                path.display(),
                bounded_detail(&cleanup.to_string())
            ));
        }
        return Err(format!("atomic create {}: {err}", path.display()));
    }
    Ok(())
}

/// Error details ride a single tab-separated response line; keep them short.
pub(crate) fn bounded_detail(detail: &str) -> String {
    const MAX: usize = 160;
    let clean = detail.replace(['\r', '\n', '\t'], " ");
    match clean.char_indices().nth(MAX) {
        Some((idx, _)) => format!("{}…", &clean[..idx]),
        None => clean,
    }
}

pub(crate) fn persist_plan(plan: &PlannedWrite, canonical_base: &Path) -> Result<(), String> {
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
            // exclusive create below, so a create_dir_all that resolved through
            // a parent outside the base is refused before any bytes are written.
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

pub(crate) fn verify_parent_within_base(path: &Path, canonical_base: &Path) -> Result<(), String> {
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

/// Snapshot rollback: undo what this operation planned to write. A created
/// file is removed, a modified/deleted file is restored from the bytes read
/// before the write. No attempt is made to detect a hostile concurrent
/// replacement of the path (out of scope).
pub(crate) fn rollback_plan(plan: &PlannedWrite) -> Result<(), String> {
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

pub(crate) fn push_hashed(out: &mut Vec<u8>, hasher: &mut Sha256, bytes: &[u8]) {
    out.extend_from_slice(bytes);
    hasher.update(bytes);
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex_bytes(&digest)
}

pub(crate) fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
