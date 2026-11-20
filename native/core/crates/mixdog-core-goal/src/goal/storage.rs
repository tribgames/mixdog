//! `goal-storage.mjs`: one record file per session under `<dataDir>/goals/<sessionId>.json`,
//! `{ version: 1, goal }`, written atomically with the replaced version kept as `.bak`. A damaged
//! record never blocks the feature (it is set aside and the last good copy restored, else the
//! session has no Goal); one a newer build wrote reads as no Goal and is never replaced.
#![allow(
    clippy::disallowed_methods,
    reason = "every file call here runs inside a lane job (the InLane proof argument)"
)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use mixdog_js::js_trim;
use mixdog_rt::InLane;
use mixdog_statefile::{Invalid, LockOpts, Opts, WriteLane, parse_json_text, read_content, read_json, with_lock, write_json};
use serde_json::{Value, json};

use super::error::{GoalError, GoalResult};
use super::js::{Goal, string};
use super::state::{
    GOAL_FILE_VERSION, assert_session_id, completed_goal_expired, freeze_unobserved_segment, is_session_id,
    normalize_stored_goal, public_goal,
};

const LOCK_TIMEOUT: Duration = Duration::from_millis(2_000);
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// `goalsRoot`: `<dataDir>/goals`; an empty data dir is the working directory.
pub fn goals_root(data_dir: &str) -> PathBuf {
    let dir = js_trim(data_dir);
    if dir.is_empty() {
        std::env::current_dir().unwrap_or_default().join("goals")
    } else {
        Path::new(dir).join("goals")
    }
}

pub fn record_path(root: &Path, session_id: &str) -> PathBuf {
    root.join(format!("{session_id}.json"))
}

pub fn history_path(root: &Path, session_id: &str, goal_id: &str) -> GoalResult<PathBuf> {
    Ok(root.join("history").join(session_id).join(format!("{}.json", assert_session_id(goal_id)?)))
}

/// `reportGoalStorageError`.
pub fn report_storage_error(error: &GoalError) {
    tracing::warn!(code = "GOAL_STORAGE_ERROR", "{}", error.message);
}

/// `deleteStoredGoalFile`: whether the file is gone (a missing one is).
pub fn delete_stored_goal_file(root: &Path, session_id: &str) -> bool {
    match assert_session_id(session_id) {
        Ok(id) => mixdog_core_base::support::remove_file_forced(&record_path(root, &id)).is_ok(),
        Err(_) => false,
    }
}

/// The record file's generation (`goal-storage.mjs`'s `dev:ino:size:mtimeNs:ctimeNs`): an atomic
/// replacement may keep size and mtime, so file identity and change time are part of it. `None` is
/// a missing file, which never matches a cached copy or an observed generation.
pub fn file_stamp(path: &Path) -> std::io::Result<Option<String>> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match std::fs::metadata(path) {
            Ok(meta) => Ok(Some(format!(
                "{}:{}:{}:{}.{}:{}.{}",
                meta.dev(),
                meta.ino(),
                meta.len(),
                meta.mtime(),
                meta.mtime_nsec(),
                meta.ctime(),
                meta.ctime_nsec()
            ))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
    #[cfg(windows)]
    {
        windows_stamp(path)
    }
}

/// libuv's `fs__stat_handle` sources: the volume and 64-bit file index, `EndOfFile`, and the basic info's
/// `LastWriteTime` and `ChangeTime`.
#[cfg(windows)]
fn windows_stamp(path: &Path) -> std::io::Result<Option<String>> {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
    };
    let file = match mixdog_fsio::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(&mixdog_fsio::Unlaned, path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let handle = file.as_raw_handle();
    // SAFETY: `handle` stays open for the block; each call fills a zeroed out-struct of the size it is told.
    unsafe {
        let mut basic: FILE_BASIC_INFO = std::mem::zeroed();
        let mut index: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        let basic_read =
            GetFileInformationByHandleEx(handle, FileBasicInfo, std::ptr::from_mut(&mut basic).cast::<c_void>(), std::mem::size_of::<FILE_BASIC_INFO>() as u32);
        if basic_read == 0 || GetFileInformationByHandle(handle, &mut index) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Some(format!(
            "{}:{}:{}:{}:{}",
            index.dwVolumeSerialNumber,
            (u64::from(index.nFileIndexHigh) << 32) | u64::from(index.nFileIndexLow),
            (u64::from(index.nFileSizeHigh) << 32) | u64::from(index.nFileSizeLow),
            basic.LastWriteTime,
            basic.ChangeTime
        )))
    }
}

/// Deletes the record only if it still has the `observed` generation, under the record's lock: a
/// Goal committed (or any record put) after the caller's read is not unlinked. Whether it was.
pub fn delete_if_unchanged<L: WriteLane>(lane: &InLane<L>, root: &Path, session_id: &str, observed: &Option<String>) -> GoalResult<bool> {
    let id = assert_session_id(session_id)?;
    let path = record_path(root, &id);
    locked(lane, &path, || {
        let unchanged = observed.is_some() && file_stamp(&path).ok().flatten() == *observed;
        unchanged && delete_stored_goal_file(root, &id)
    })
}

/// The cleanup of an expired record read at `observed`: a failure is reported, never fatal.
fn remove_observed<L: WriteLane>(lane: &InLane<L>, root: &Path, session_id: &str, observed: &Option<String>) {
    if let Err(error) = delete_if_unchanged(lane, root, session_id, observed) {
        report_storage_error(&error);
    }
}

/// The record's generation before a read, for [`delete_if_unchanged`] after it.
fn observe(root: &Path, session_id: &str) -> Option<String> {
    let id = assert_session_id(session_id).ok()?;
    file_stamp(&record_path(root, &id)).ok().flatten()
}
fn safe_version(doc: &Value) -> Option<f64> {
    let version = doc.get("version")?.as_f64()?;
    (version.fract() == 0.0 && version.abs() <= MAX_SAFE).then_some(version)
}

/// The caller's validation of a record document (`goalRecordReadOptions.validate`).
fn validate(session_id: &str, at: f64) -> impl Fn(&Value) -> Result<(), Invalid> + '_ {
    move |doc| {
        if let Some(version) = safe_version(doc).filter(|v| *v > GOAL_FILE_VERSION as f64) {
            return Err(Invalid::Unsupported(format!(
                "Goal record version {} is newer than this build",
                mixdog_js::number_to_string(version)
            )));
        }
        let goal = doc.as_object().and_then(|d| d.get("goal"));
        let current = doc.get("version").and_then(Value::as_f64) == Some(GOAL_FILE_VERSION as f64);
        let (Some(goal), true) = (goal, current) else {
            return Err(Invalid::Damaged("unsupported or invalid Goal record".into()));
        };
        if !goal.is_null() && !goal.is_object() {
            return Err(Invalid::Damaged("invalid Goal value".into()));
        }
        normalize_stored_goal(goal, session_id, at).map(drop).map_err(|e| Invalid::Damaged(e.message))
    }
}

/// `readGoalRecordFile`: the record's goal, normalized by `normalize` (which owns the per-runtime
/// adoption of a first load); a missing, newer or unrecoverable record reads as no Goal.
pub fn read_record<L: WriteLane>(
    lane: &InLane<L>,
    path: &Path,
    session_id: &str,
    at: f64,
    normalize: &mut dyn FnMut(&Value) -> GoalResult<Option<Goal>>,
) -> GoalResult<Option<Goal>> {
    let opts = Opts { secret: true, ..Opts::default() };
    let check = validate(session_id, at);
    let doc = read_json(lane, path, Some(&check), &opts)?;
    match doc {
        None => Ok(None),
        Some(doc) => normalize(doc.get("goal").unwrap_or(&Value::Null)),
    }
}

/// `refuseNewerRecord`: a record from a newer build is not replaced. The caller holds the lock.
fn refuse_newer(path: &Path) -> GoalResult<()> {
    let Some(content) = read_content(path)? else { return Ok(()) };
    let Ok(parsed) = parse_json_text(&content) else { return Ok(()) };
    match safe_version(&parsed).filter(|v| *v > GOAL_FILE_VERSION as f64) {
        Some(version) => Err(GoalError::coded(
            "EGOALNEWERVERSION",
            format!(
                "Goal record {} was written by a newer build (version {} > {GOAL_FILE_VERSION}); update Mixdog to change this Goal",
                path.display(),
                mixdog_js::number_to_string(version)
            ),
        )),
        None => Ok(()),
    }
}

fn lock_opts() -> LockOpts {
    LockOpts { timeout: Some(LOCK_TIMEOUT), ..LockOpts::default() }
}

/// `storage.write`: the newer-build check and the durable write share one lock hold.
pub fn write_record<L: WriteLane>(lane: &InLane<L>, path: &Path, goal: Option<&Goal>) -> GoalResult<()> {
    let doc = json!({ "version": GOAL_FILE_VERSION, "goal": goal.map_or(Value::Null, |g| Value::Object(g.clone())) });
    let opts = Opts { secret: true, backup: true, lock: true, lock_timeout: Some(LOCK_TIMEOUT), ..Opts::default() };
    with_lock(lane, path, &lock_opts(), || {
        refuse_newer(path)?;
        write_json(lane, path, &doc, &opts).map(drop).map_err(|e| GoalError::new(e.to_string()))
    })??;
    Ok(())
}

/// `archiveFinishedGoal`'s write: no backup.
pub fn write_history<L: WriteLane>(lane: &InLane<L>, path: &Path, goal: &Goal) -> GoalResult<()> {
    let doc = json!({ "version": GOAL_FILE_VERSION, "goal": Value::Object(goal.clone()) });
    let opts = Opts { secret: true, lock: true, lock_timeout: Some(LOCK_TIMEOUT), ..Opts::default() };
    write_json(lane, path, &doc, &opts).map(drop).map_err(|e| GoalError::new(e.to_string()))
}

/// `with_lock` around `body` on the record's lock (`storage.mutate`).
pub fn locked<L: WriteLane, R>(lane: &InLane<L>, path: &Path, body: impl FnOnce() -> R) -> GoalResult<R> {
    Ok(with_lock(lane, path, &lock_opts(), body)?)
}

/// `readStoredGoalFile`: a runtime-less read; the open segment counts only up to `liveAt`.
fn read_stored_goal_file<L: WriteLane>(lane: &InLane<L>, root: &Path, session_id: &str, at: f64) -> Option<Goal> {
    let read = || -> GoalResult<Option<Goal>> {
        let id = assert_session_id(session_id)?;
        let mut normalize = |value: &Value| normalize_stored_goal(value, &id, at);
        let mut goal = read_record(lane, &record_path(root, &id), &id, at, &mut normalize)?;
        if let Some(goal) = goal.as_mut() {
            freeze_unobserved_segment(goal);
        }
        Ok(goal)
    };
    match read() {
        Ok(goal) => goal,
        Err(error) => {
            report_storage_error(&error);
            None
        }
    }
}

/// `readStoredGoalSnapshot`: the Goal a reader without a runtime sees (deleting an expired
/// completed one); an archived Goal reads as none.
pub fn read_stored_goal_snapshot<L: WriteLane>(
    lane: &InLane<L>,
    data_dir: &str,
    session_id: &str,
    at: f64,
    completed_ttl_ms: f64,
) -> Option<Goal> {
    stored_goal_snapshot_under(lane, &goals_root(data_dir), session_id, at, completed_ttl_ms)
}

/// [`read_stored_goal_snapshot`] under the Goals' `root`.
pub fn stored_goal_snapshot_under<L: WriteLane>(lane: &InLane<L>, root: &Path, session_id: &str, at: f64, completed_ttl_ms: f64) -> Option<Goal> {
    let root = root.to_path_buf();
    let observed = observe(&root, session_id);
    let stored = read_stored_goal_file(lane, &root, session_id, at);
    let goal = public_goal(stored.as_ref(), at);
    if completed_goal_expired(goal.as_ref(), at, completed_ttl_ms) {
        remove_observed(lane, &root, session_id, &observed);
        return None;
    }
    goal.filter(|g| !super::js::truthy(g.get("archivedAt")))
}

/// `listStoredActiveGoalSessionIds`: the sorted sessions whose Goal is active and not archived;
/// expired completed records are deleted on the way.
pub fn list_active_session_ids<L: WriteLane>(lane: &InLane<L>, data_dir: &str, at: f64, completed_ttl_ms: f64) -> Vec<String> {
    let root = goals_root(data_dir);
    let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut ids = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json") else { continue };
        if !is_session_id(id) {
            continue;
        }
        let observed = observe(&root, id);
        let stored = read_stored_goal_file(lane, &root, id, at);
        let goal = public_goal(stored.as_ref(), at);
        if completed_goal_expired(goal.as_ref(), at, completed_ttl_ms) {
            remove_observed(lane, &root, id, &observed);
            continue;
        }
        if let Some(goal) = goal
            && string(&goal, "status") == "active" && !super::js::truthy(goal.get("archivedAt")) {
            ids.push(id.to_owned());
        }
    }
    ids.sort();
    ids
}
