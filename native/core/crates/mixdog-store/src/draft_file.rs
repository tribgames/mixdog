//! An open run's draft beside its session's log: `draft-<rid>.jsonl` in the session directory, the place of the 1.4.5 turn
//! checkpoint (`turn-checkpoint.mjs`: a header file and a journal beside the session). One JSON body per line, appended while
//! the run streams; a value marked sensitive replaces the whole file with one redacted body (a published tmp renamed over it,
//! so a kill leaves the old file or the new one, never a mix); the file goes once the run's end record is durable. The log
//! never holds the draft, so nothing of a redacted draft outlives its rewrite. A torn last line (a kill mid-append) is not read.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "store file I/O runs only in lane jobs (lane proof arguments)")]

use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

use mixdog_rt::InLane;
use serde_json::Value;

use crate::fsio;
use crate::fsio::IoError;
use crate::fsio::IoLane;
use crate::fsio::IoOp;
use crate::fsio::WriteLane;
use crate::fsio::err;

const PREFIX: &str = "draft-";
const SUFFIX: &str = ".jsonl";

/// The draft file of run `rid` in session directory `dir`.
pub fn path(dir: &Path, rid: &str) -> PathBuf {
    dir.join(format!("{PREFIX}{rid}{SUFFIX}"))
}

/// The run id of a draft file's name.
pub fn rid_of(name: &str) -> Option<&str> {
    name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX).filter(|rid| !rid.is_empty())
}

/// The boundaries of a draft write, each reported before it is taken, with the run and the body (none at `Remove`).
/// Compiled for tests and the `test-support` feature only (the crash child is a test binary: it needs these hooks and nothing else).
#[cfg(any(test, feature = "test-support"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftStep {
    /// Before a body is appended. An error: the append fails, nothing written.
    Append,
    /// The body appended and flushed.
    Appended,
    /// Before the file is replaced. An error: the replace fails, the old file stays.
    Replace,
    /// The file replaced, durably.
    Replaced,
    /// Before the file is removed. An error: the removal fails.
    Remove,
}

#[cfg(any(test, feature = "test-support"))]
pub type DraftHook = fn(DraftStep, &str, Option<&Value>) -> std::io::Result<()>;

#[cfg(any(test, feature = "test-support"))]
static DRAFT_HOOK: std::sync::OnceLock<DraftHook> = std::sync::OnceLock::new();

/// Installs the draft hook for the life of the process; a second installation is a bug of the caller.
#[cfg(any(test, feature = "test-support"))]
pub fn set_draft_hook(hook: DraftHook) {
    assert!(DRAFT_HOOK.set(hook).is_ok(), "the draft hook is installed once");
}

#[allow(unused_variables)]
fn step(step_name: &'static str, rid: &str, body: Option<&Value>, path: &Path) -> Result<(), IoError> {
    #[cfg(any(test, feature = "test-support"))]
    if let Some(hook) = DRAFT_HOOK.get() {
        let step = match step_name {
            "append" => DraftStep::Append,
            "appended" => DraftStep::Appended,
            "replace" => DraftStep::Replace,
            "replaced" => DraftStep::Replaced,
            _ => DraftStep::Remove,
        };
        hook(step, rid, body).map_err(err(IoOp::Write, path))?;
    }
    Ok(())
}

/// Appends `body` to run `rid`'s draft, creating the file; durable when this returns.
pub fn append<L: WriteLane>(_lane: &InLane<L>, dir: &Path, rid: &str, body: &Value) -> Result<(), IoError> {
    let path = path(dir, rid);
    step("append", rid, Some(body), &path)?;
    let mut line = serde_json::to_vec(body).expect("a JSON value serializes");
    line.push(b'\n');
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(err(IoOp::Open, &path))?;
    file.write_all(&line).map_err(err(IoOp::Write, &path))?;
    fsio::sync_file(&file, &path)?;
    step("appended", rid, Some(body), &path)
}

/// Makes `body` the only body of run `rid`'s draft: the old file or the new one, whatever kills the process.
pub fn replace<L: WriteLane>(lane: &InLane<L>, dir: &Path, rid: &str, body: &Value) -> Result<(), IoError> {
    let path = path(dir, rid);
    step("replace", rid, Some(body), &path)?;
    let mut line = serde_json::to_vec(body).expect("a JSON value serializes");
    line.push(b'\n');
    fsio::publish_file(lane, &path, &line)?;
    step("replaced", rid, Some(body), &path)
}

/// Removes run `rid`'s draft; none is not an error.
pub fn remove<L: WriteLane>(_lane: &InLane<L>, dir: &Path, rid: &str) -> Result<(), IoError> {
    let path = path(dir, rid);
    step("remove", rid, None, &path)?;
    match std::fs::remove_file(&path) {
        Ok(()) => fsio::sync_dir(dir),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err(IoOp::Remove, &path)(e)),
    }
}

/// The run ids of the drafts in `dir`.
pub fn list<L: IoLane>(_lane: &InLane<L>, dir: &Path) -> Result<Vec<String>, IoError> {
    let mut rids = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(err(IoOp::List, dir))? {
        let name = entry.map_err(err(IoOp::List, dir))?.file_name().to_string_lossy().into_owned();
        if let Some(rid) = rid_of(&name) {
            rids.push(rid.to_owned());
        }
    }
    rids.sort();
    Ok(rids)
}

/// The bodies of run `rid`'s draft in order; none for no file. A last line without its newline (a kill mid-append) is left out.
pub fn read<L: IoLane>(_lane: &InLane<L>, dir: &Path, rid: &str) -> Result<Vec<Value>, IoError> {
    let path = path(dir, rid);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(err(IoOp::Read, &path)(e)),
    };
    let whole = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |at| at + 1);
    Ok(bytes[..whole].split(|b| *b == b'\n').filter(|line| !line.is_empty()).filter_map(|line| serde_json::from_slice(line).ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_torn_last_line_is_not_read_and_a_replace_leaves_one_body() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let job = move |lane: &InLane<mixdog_rt::DurabilityIo>| {
            append(lane, &root, "r1", &serde_json::json!({ "text": "a" })).unwrap();
            append(lane, &root, "r1", &serde_json::json!({ "text": "b" })).unwrap();
            let mut file = std::fs::OpenOptions::new().append(true).open(path(&root, "r1")).unwrap();
            file.write_all(b"{\"text\":\"c").unwrap();
            drop(file);
            assert_eq!(read(lane, &root, "r1").unwrap(), [serde_json::json!({ "text": "a" }), serde_json::json!({ "text": "b" })]);
            replace(lane, &root, "r1", &serde_json::json!({ "reset": true })).unwrap();
            assert_eq!(read(lane, &root, "r1").unwrap(), [serde_json::json!({ "reset": true })]);
            assert_eq!(list(lane, &root).unwrap(), ["r1"]);
            remove(lane, &root, "r1").unwrap();
            remove(lane, &root, "r1").unwrap();
            assert!(list(lane, &root).unwrap().is_empty());
        };
        use mixdog_rt::LaneToken;
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(async {
            mixdog_rt::testing::tokens().durability_io.submit(&mixdog_rt::CancellationToken::new(), job).expect("lane").await.expect("job ran");
        });
    }
}
