//! Read-only repository inspection (RL §10.2, DS §5). One inspector per repo
//! common dir; runs on io-maintenance without the repo lock; single-flighted
//! and cached by [`InspectorKey`]. Mutations live in `scm::mutate` and
//! revalidate only the object ids they were confirmed with, via
//! [`RepoInspector::resolve_refs`].

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_protocol::ThreadId;
use mixdog_protocol::TurnId;
use mixdog_rt::MaintenanceIo;

use super::common::AbsPath;

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct RepoRef {
    pub common_dir: AbsPath,
    /// `None` for a bare repository.
    pub work_tree: Option<AbsPath>,
}

/// Hex object id.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub struct ObjectId(pub String);

/// `(HEAD oid, index checksum, worktree status token)`.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct InspectorKey {
    pub head: Option<ObjectId>,
    pub index_checksum: Option<String>,
    pub worktree_token: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum ChangeKind {
    Unmodified,
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Ignored,
    Conflicted,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RepoOperation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Bisect,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Upstream {
    pub name: String,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StatusEntry {
    /// Work-tree relative, `/`-separated.
    pub path: String,
    pub orig_path: Option<String>,
    pub index: ChangeKind,
    pub worktree: ChangeKind,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct RepoStatus {
    pub key: InspectorKey,
    pub branch: Option<String>,
    pub head: Option<ObjectId>,
    pub upstream: Option<Upstream>,
    pub operation: Option<RepoOperation>,
    pub entries: Vec<StatusEntry>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ReviewScope {
    Turn {
        thread_id: ThreadId,
        turn_id: TurnId,
    },
    Session {
        thread_id: ThreadId,
    },
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReviewRequest {
    pub repo: RepoRef,
    pub scope: ReviewScope,
    /// Tree captured at the scope's start.
    pub base: ObjectId,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReviewFile {
    pub path: String,
    pub status: ChangeKind,
    pub adds: u64,
    pub dels: u64,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReviewSummary {
    pub key: InspectorKey,
    pub files: Vec<ReviewFile>,
    /// Untracked files past the review's untracked cap (256), not listed.
    pub omitted: u32,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ReviewPage {
    pub key: InspectorKey,
    pub patch: String,
    pub next_cursor: Option<String>,
}

/// A cached read: the value for the current key, or not computed yet.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Cached<T> {
    Ready(T),
    Pending { key: InspectorKey },
}

/// Watcher evidence for the repo (DS §4.3 `kind:"git"` and work-tree events).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RepoEvidence {
    GitDir,
    WorkTree,
    /// The OS dropped events; rescan.
    Overflow,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum ScmError {
    NotARepository,
    ObjectMissing { id: ObjectId },
    Corrupt { detail: String },
    Io { os_code: Option<i32> },
    /// A program the inspection needs could not be started (it is not installed).
    Unavailable { capability: String },
}

#[async_trait]
pub trait RepoInspector: Send + Sync {
    async fn key(&self, lane: MaintenanceIo, repo: RepoRef) -> Result<InspectorKey, ScmError>;
    /// Single-flighted per key; concurrent callers share one computation.
    async fn status(&self, lane: MaintenanceIo, repo: RepoRef)
    -> Result<Arc<RepoStatus>, ScmError>;
    async fn review_summary(
        &self,
        lane: MaintenanceIo,
        request: ReviewRequest,
    ) -> Result<Arc<ReviewSummary>, ScmError>;
    /// Cache read only (C1); `Pending` until the summary for `key` is computed.
    fn review_page(
        &self,
        key: &InspectorKey,
        path: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<Cached<ReviewPage>, ScmError>;
    /// Current object id of each ref (`None` = absent), for mutation CAS.
    async fn resolve_refs(
        &self,
        lane: MaintenanceIo,
        repo: RepoRef,
        refs: Vec<String>,
    ) -> Result<Vec<Option<ObjectId>>, ScmError>;
    /// Marks the cached key stale; the next read recomputes.
    fn evidence(&self, repo: &RepoRef, evidence: RepoEvidence);
}
