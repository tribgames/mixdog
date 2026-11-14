//! Repository facts read without a process (gix): identity, HEAD, ref ids, the index
//! checksum, and the state markers of an operation in progress. Everything here is blocking
//! and runs on the maintenance lane through [`on_lane`].

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::path::Path;
use std::path::PathBuf;

use mixdog_core_api::domain::repo::InspectorKey;
use mixdog_core_api::domain::repo::ObjectId;
use mixdog_core_api::domain::repo::RepoOperation;
use mixdog_rt::JobHandle;
use mixdog_rt::LaneToken;
use mixdog_rt::MaintenanceIo;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;

/// Where a repository lives. `common_dir` is shared by every linked work tree; `git_dir` is
/// this work tree's own (HEAD, index and operation markers).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct RepoIdentity {
    pub work_tree: Option<PathBuf>,
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
}

/// Runs `job` on the maintenance lane; the caller's cancellation drops it at dequeue.
pub async fn on_lane<R: Send + 'static>(
    lane: MaintenanceIo,
    cancel: &CancellationToken,
    job: impl FnOnce() -> R + Send + 'static,
) -> Result<R, ScmFailure> {
    admit(lane, cancel, job)?.await.map_err(|_| ScmFailure::Cancelled)
}

/// Queues `job` on the maintenance lane without waiting for it: a lane that refuses it answers `QueueFull` at once, so a
/// caller can change its own state only after the job that goes with the change is admitted. The caller's cancellation drops
/// it at dequeue.
pub fn admit<R: Send + 'static>(
    lane: MaintenanceIo,
    cancel: &CancellationToken,
    job: impl FnOnce() -> R + Send + 'static,
) -> Result<JobHandle<R>, ScmFailure> {
    lane.submit(cancel, move |_proof| job()).map_err(|full| ScmFailure::QueueFull {
        queue: full.lane.name().to_owned(),
    })
}

fn open(path: &Path) -> Result<gix::Repository, ScmFailure> {
    gix::discover(path).map_err(|_| ScmFailure::NotARepository)
}

/// The repository containing `cwd`.
pub fn discover(cwd: &Path) -> Result<RepoIdentity, ScmFailure> {
    let repo = open(cwd)?;
    Ok(RepoIdentity {
        work_tree: repo.workdir().map(Path::to_path_buf),
        git_dir: repo.git_dir().to_path_buf(),
        common_dir: repo.common_dir().to_path_buf(),
    })
}

/// HEAD's commit id; `None` on an unborn branch.
pub fn head_oid(identity: &RepoIdentity) -> Result<Option<ObjectId>, ScmFailure> {
    let repo = open(&identity.git_dir)?;
    Ok(repo
        .head_id()
        .ok()
        .map(|id| ObjectId(id.to_hex().to_string())))
}

/// The checksum that ends the index file (its content address), read without loading it.
pub fn index_checksum(identity: &RepoIdentity) -> Result<Option<String>, ScmFailure> {
    let path = identity.git_dir.join("index");
    let mut file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let hash_len = open(&identity.git_dir)?.object_hash().len_in_bytes() as i64;
    let size = file.metadata()?.len() as i64;
    if size < hash_len {
        return Ok(None);
    }
    file.seek(SeekFrom::End(-hash_len))?;
    let mut tail = vec![0u8; hash_len as usize];
    file.read_exact(&mut tail)?;
    Ok(Some(hex(&tail)))
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// `(HEAD oid, index checksum, worktree token)`. The token is the generation of the repo's
/// change evidence, so it moves exactly when the watcher saw the work tree change.
pub fn key(identity: &RepoIdentity, generation: u64) -> Result<InspectorKey, ScmFailure> {
    Ok(InspectorKey {
        head: head_oid(identity)?,
        index_checksum: index_checksum(identity)?,
        worktree_token: generation.to_string(),
    })
}

/// Current id of each ref (`None` = absent). `HEAD`, full ref names and `<rev>^{commit}` all
/// resolve.
pub fn resolve_refs(
    identity: &RepoIdentity,
    refs: &[String],
) -> Result<Vec<Option<ObjectId>>, ScmFailure> {
    let repo = open(&identity.git_dir)?;
    Ok(refs
        .iter()
        .map(|name| {
            repo.rev_parse_single(name.as_str())
                .ok()
                .map(|id| ObjectId(id.to_hex().to_string()))
        })
        .collect())
}

/// The operation in progress in this work tree, from git's own state markers.
pub fn operation_in_progress(git_dir: &Path) -> Option<RepoOperation> {
    let exists = |name: &str| git_dir.join(name).exists();
    if exists("rebase-merge") || exists("rebase-apply") {
        Some(RepoOperation::Rebase)
    } else if exists("MERGE_HEAD") {
        Some(RepoOperation::Merge)
    } else if exists("CHERRY_PICK_HEAD") {
        Some(RepoOperation::CherryPick)
    } else if exists("REVERT_HEAD") {
        Some(RepoOperation::Revert)
    } else if exists("BISECT_START") {
        Some(RepoOperation::Bisect)
    } else if exists("sequencer") {
        // A multi-commit pick between two commits has no CHERRY_PICK_HEAD; its todo list
        // names the verb.
        let todo = std::fs::read_to_string(git_dir.join("sequencer").join("todo")).unwrap_or_default();
        let first = todo
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with('#'))
            .unwrap_or("");
        if first.split_whitespace().next() == Some("revert") {
            Some(RepoOperation::Revert)
        } else {
            Some(RepoOperation::CherryPick)
        }
    } else {
        None
    }
}

/// git's own subcommand name for `operation`, for `continue` / `abort`.
pub fn operation_verb(operation: RepoOperation) -> &'static str {
    match operation {
        RepoOperation::Merge => "merge",
        RepoOperation::Rebase => "rebase",
        RepoOperation::CherryPick => "cherry-pick",
        RepoOperation::Revert => "revert",
        RepoOperation::Bisect => "bisect",
    }
}
