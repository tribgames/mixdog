//! The typed refusals of managed worktrees. Each constructor is one code of the Node producers
//! (`src/runtime/shared/worktrees/*`) with the `DomainErrorDetail` variant the UI reads: the
//! fields are data, the English text of a refusal is the surface's.

use mixdog_protocol::DomainErrorDetail;
use mixdog_protocol::RemovalRemnant;

use crate::error::ScmFailure;

pub const WORKTREE_BUSY_JOBS: &str = "WORKTREE_BUSY_JOBS";
pub const WORKTREE_BRANCH_OCCUPIED: &str = "WORKTREE_BRANCH_OCCUPIED";
pub const WORKTREE_DIRTY: &str = "WORKTREE_DIRTY";
pub const WORKTREE_UNMERGED: &str = "WORKTREE_UNMERGED";
pub const WORKTREE_MISSING: &str = "WORKTREE_MISSING";
pub const WORKTREE_UNSUPPORTED_REPO: &str = "WORKTREE_UNSUPPORTED_REPO";
pub const WORKTREE_REVISION_CONFLICT: &str = "WORKTREE_REVISION_CONFLICT";
pub const WORKTREE_CONFIRM_REQUIRED: &str = "WORKTREE_CONFIRM_REQUIRED";
pub const WORKTREE_TARGET_MISMATCH: &str = "WORKTREE_TARGET_MISMATCH";
pub const WORKTREE_PROJECT_UNKNOWN: &str = "WORKTREE_PROJECT_UNKNOWN";
pub const WORKTREE_REMOVAL_INCOMPLETE: &str = "WORKTREE_REMOVAL_INCOMPLETE";
pub const WORKTREE_PATH_UNSAFE: &str = "WORKTREE_PATH_UNSAFE";
pub const WORKTREE_FILE_RECOVERY: &str = "WORKTREE_FILE_RECOVERY";
pub const WORKTREE_LARGE_REPO_CONFIRM: &str = "WORKTREE_LARGE_REPO_CONFIRM";
pub const WORKTREE_DISK_INSUFFICIENT: &str = "WORKTREE_DISK_INSUFFICIENT";
pub const MERGE_CONFLICT: &str = "MERGE_CONFLICT";
pub const MERGE_TARGET_DIRTY: &str = "MERGE_TARGET_DIRTY";
pub const MERGE_FAILED: &str = "MERGE_FAILED";

/// Why a workspace action was refused because something still uses an affected folder; the
/// surface shows the text of the reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefusalReason {
    WorkspaceRetained,
    WorkspaceLease,
    FolderInUse,
    FolderShellJobs,
    WorkspaceAdmissionUnreadable,
}

impl RefusalReason {
    pub const fn wire(self) -> &'static str {
        match self {
            Self::WorkspaceRetained => "workspace-retained",
            Self::WorkspaceLease => "workspace-lease",
            Self::FolderInUse => "folder-in-use",
            Self::FolderShellJobs => "folder-shell-jobs",
            Self::WorkspaceAdmissionUnreadable => "workspace-admission-unreadable",
        }
    }
}

fn none_busy(reason: &str) -> DomainErrorDetail {
    DomainErrorDetail::WorktreeBusyJobs {
        reason: reason.to_owned(),
        outcome: None,
        admission: None,
        sessions: None,
        entry_id: None,
        kept: None,
        workers: None,
        jobs: None,
        shell_jobs: None,
        starting: None,
        session_id: None,
    }
}

/// `MERGE_CONFLICT`: the merge would conflict in `files` (`details.files` as Node's).
pub fn merge_conflict(files: Vec<String>) -> ScmFailure {
    ScmFailure::coded(MERGE_CONFLICT, DomainErrorDetail::MergeConflict { files })
}

/// `WORKTREE_BUSY_JOBS` with the shared reason.
pub fn busy(reason: RefusalReason) -> ScmFailure {
    ScmFailure::coded(WORKTREE_BUSY_JOBS, none_busy(reason.wire()))
}

/// `workspace-admission-unreadable`; `outcome: "unknown"` when the request was posted and may
/// have landed, `admission` naming why the admission thread could not answer.
pub fn admission_unreadable(outcome: Option<&str>, admission: Option<&str>) -> ScmFailure {
    let mut detail = none_busy(RefusalReason::WorkspaceAdmissionUnreadable.wire());
    if let DomainErrorDetail::WorktreeBusyJobs { outcome: o, admission: a, .. } = &mut detail {
        *o = outcome.map(str::to_owned);
        *a = admission.map(str::to_owned);
    }
    ScmFailure::coded(WORKTREE_BUSY_JOBS, detail)
}

/// `WORKTREE_BUSY_JOBS` (`workspace-retained`) naming the sessions that retain the folder.
pub fn retained_by(sessions: Vec<String>) -> ScmFailure {
    let mut detail = none_busy(RefusalReason::WorkspaceRetained.wire());
    if let DomainErrorDetail::WorktreeBusyJobs { sessions: slot, .. } = &mut detail {
        *slot = Some(sessions);
    }
    ScmFailure::coded(WORKTREE_BUSY_JOBS, detail)
}

/// `WORKTREE_BUSY_JOBS` with a free reason and the fields it can carry.
pub fn busy_with(reason: &str, sessions: Option<Vec<String>>, entry_id: Option<String>, kept: Option<String>) -> ScmFailure {
    let mut detail = none_busy(reason);
    if let DomainErrorDetail::WorktreeBusyJobs {
        sessions: s,
        entry_id: e,
        kept: k,
        ..
    } = &mut detail
    {
        *s = sessions;
        *e = entry_id;
        *k = kept;
    }
    ScmFailure::coded(WORKTREE_BUSY_JOBS, detail)
}

/// A managed worktree still retains the branch (`delete-branch`).
pub fn branch_retained() -> ScmFailure {
    ScmFailure::coded(WORKTREE_BUSY_JOBS, none_busy("branch-retained"))
}

pub fn confirm_required() -> ScmFailure {
    ScmFailure::coded_plain(WORKTREE_CONFIRM_REQUIRED)
}

/// The project folder is not on the branch the action was confirmed for.
pub fn target_mismatch(target: Option<String>, current: Option<String>, expected: Option<String>, actual: Option<String>) -> ScmFailure {
    ScmFailure::coded(
        WORKTREE_TARGET_MISMATCH,
        DomainErrorDetail::WorktreeTargetMismatch {
            target,
            current,
            expected,
            actual,
        },
    )
}

pub fn unsupported_repo(project_path: Option<String>, reason_file: Option<String>) -> ScmFailure {
    ScmFailure::coded(
        WORKTREE_UNSUPPORTED_REPO,
        DomainErrorDetail::WorktreeUnsupportedRepo {
            project_path,
            file: reason_file,
            line: None,
            rel: None,
            base_branch: None,
            branch: None,
        },
    )
}

pub fn project_unknown(project_path: String, reason: &str) -> ScmFailure {
    ScmFailure::coded(
        WORKTREE_PROJECT_UNKNOWN,
        DomainErrorDetail::WorktreeProjectUnknown {
            project_path: Some(project_path),
            reason: Some(reason.to_owned()),
        },
    )
}

pub fn missing(entry_id: Option<String>, worktree_id: Option<String>, path: Option<String>) -> ScmFailure {
    ScmFailure::coded(
        WORKTREE_MISSING,
        DomainErrorDetail::WorktreeMissing {
            entry_id,
            worktree_id,
            path,
        },
    )
}

pub fn revision_conflict(entry_id: Option<String>) -> ScmFailure {
    ScmFailure::coded(
        WORKTREE_REVISION_CONFLICT,
        DomainErrorDetail::WorktreeRevisionConflict {
            entry_id,
            remaining: None,
            branch: None,
            tx_id: None,
            expected_revision: None,
            revision: None,
        },
    )
}

pub fn branch_occupied(branch: String, path: Option<String>, kind: Option<&str>, session_id: Option<String>) -> ScmFailure {
    ScmFailure::coded(
        WORKTREE_BRANCH_OCCUPIED,
        DomainErrorDetail::WorktreeBranchOccupied {
            branch,
            path,
            kind: kind.map(str::to_owned),
            session_id,
        },
    )
}

pub fn path_unsafe(entry_id: String, path: String, reason: Option<&str>) -> ScmFailure {
    ScmFailure::coded(
        WORKTREE_PATH_UNSAFE,
        DomainErrorDetail::WorktreePathUnsafe {
            entry_id,
            path,
            reason: reason.map(str::to_owned),
            links: None,
            count: None,
        },
    )
}

/// `WORKTREE_PATH_UNSAFE` with its own text (and the links an unrecorded-link refusal names).
pub fn path_unsafe_with(entry_id: String, path: String, reason: &str, message: String, links: Option<(Vec<String>, u64)>) -> ScmFailure {
    let (links, count) = links.map_or((None, None), |(links, count)| (Some(links), Some(count)));
    ScmFailure::coded_with_message(
        WORKTREE_PATH_UNSAFE,
        DomainErrorDetail::WorktreePathUnsafe { entry_id, path, reason: Some(reason.to_owned()), links, count },
        message,
    )
}

/// Retained file recovery records block a removal, force included.
pub fn file_recovery(entry_id: String, path: String, recovery_root: String) -> ScmFailure {
    ScmFailure::coded(WORKTREE_FILE_RECOVERY, DomainErrorDetail::WorktreeFileRecovery { entry_id, path, recovery_root })
}

/// `WORKTREE_BUSY_JOBS` (`folder-in-use`) with its own text.
pub fn busy_text(message: String) -> ScmFailure {
    let mut failure = busy(RefusalReason::FolderInUse);
    if let ScmFailure::Coded { message: slot, .. } = &mut failure {
        *slot = Some(message.into_boxed_str());
    }
    failure
}

/// The worktree (or project folder) has uncommitted work or an operation in progress.
pub fn dirty(entry_id: Option<String>, operation: Option<String>, count: Option<u64>, reason: Option<&str>) -> ScmFailure {
    ScmFailure::coded(
        WORKTREE_DIRTY,
        DomainErrorDetail::WorktreeDirty {
            reason: reason.map(str::to_owned),
            operation,
            count,
            files: None,
            paths: None,
            max_files: None,
            max_bytes: None,
            head: None,
            base_commit: None,
            recovery_ref: None,
            restored: None,
            cause: None,
            restore_error: None,
            entry_id,
            ignored: None,
        },
    )
}

/// `WORKTREE_DIRTY_CHOICE`: the pending changes to carry or leave (the first fifty paths).
pub fn dirty_choice(files: Vec<String>) -> ScmFailure {
    ScmFailure::coded(
        "WORKTREE_DIRTY_CHOICE",
        DomainErrorDetail::WorktreeDirtyChoice {
            count: files.len() as u64,
            paths: files.into_iter().take(50).collect(),
        },
    )
}

/// Every field a `WORKTREE_DIRTY` can carry; unset ones are left out of the detail.
#[derive(Default)]
pub struct DirtyDetail {
    pub reason: Option<String>,
    pub operation: Option<String>,
    pub count: Option<u64>,
    pub files: Option<mixdog_protocol::DirtyFiles>,
    pub paths: Option<Vec<String>>,
    pub max_files: Option<u64>,
    pub max_bytes: Option<u64>,
    pub head: Option<String>,
    pub base_commit: Option<String>,
    pub recovery_ref: Option<String>,
    pub restored: Option<bool>,
    /// The English text of a carry refusal, or the reason a carry failed.
    pub cause: Option<String>,
    pub restore_error: Option<String>,
    pub entry_id: Option<String>,
    pub ignored: Option<Vec<String>>,
}

impl DirtyDetail {
    pub fn failure(self) -> ScmFailure {
        ScmFailure::coded(
            WORKTREE_DIRTY,
            DomainErrorDetail::WorktreeDirty {
                reason: self.reason,
                operation: self.operation,
                count: self.count,
                files: self.files,
                paths: self.paths,
                max_files: self.max_files,
                max_bytes: self.max_bytes,
                head: self.head,
                base_commit: self.base_commit,
                recovery_ref: self.recovery_ref,
                restored: self.restored,
                cause: self.cause,
                restore_error: self.restore_error,
                entry_id: self.entry_id,
                ignored: self.ignored,
            },
        )
    }
}

/// The retained worktree belongs to another project than the one the caller guarded.
pub fn project_mismatch(worktree_id: String, worktree_project: String, project_path: String) -> ScmFailure {
    ScmFailure::coded(
        "WORKTREE_PROJECT_MISMATCH",
        DomainErrorDetail::WorktreeProjectMismatch {
            project_path,
            worktree_id: Some(worktree_id),
            worktree_project: Some(worktree_project),
            repo_common_dir: None,
        },
    )
}

/// Uncommitted work: the first fifty paths and the count.
pub fn dirty_files(entry_id: String, files: Vec<String>) -> ScmFailure {
    use mixdog_protocol::DirtyFiles;
    let count = files.len() as u64;
    ScmFailure::coded(
        WORKTREE_DIRTY,
        DomainErrorDetail::WorktreeDirty {
            reason: None,
            operation: None,
            count: Some(count),
            files: Some(DirtyFiles::Paths(files.into_iter().take(50).collect())),
            paths: None,
            max_files: None,
            max_bytes: None,
            head: None,
            base_commit: None,
            recovery_ref: None,
            restored: None,
            cause: None,
            restore_error: None,
            entry_id: Some(entry_id),
            ignored: None,
        },
    )
}

/// The project folder has uncommitted tracked changes (`reason: project-dirty`).
pub fn project_dirty(files: Vec<String>) -> ScmFailure {
    use mixdog_protocol::DirtyFiles;
    let count = files.len() as u64;
    ScmFailure::coded(
        WORKTREE_DIRTY,
        DomainErrorDetail::WorktreeDirty {
            reason: Some("project-dirty".into()),
            operation: None,
            count: Some(count),
            files: Some(DirtyFiles::Paths(files.into_iter().take(50).collect())),
            paths: None,
            max_files: None,
            max_bytes: None,
            head: None,
            base_commit: None,
            recovery_ref: None,
            restored: None,
            cause: None,
            restore_error: None,
            entry_id: None,
            ignored: None,
        },
    )
}

pub fn unmerged(entry_id: Option<String>, commit: Option<String>, branch: Option<String>, merge_target: Option<String>) -> ScmFailure {
    ScmFailure::coded(
        WORKTREE_UNMERGED,
        DomainErrorDetail::WorktreeUnmerged {
            commit,
            entry_id,
            branch,
            merge_target,
            commits: None,
        },
    )
}

pub fn removal_incomplete(entry_id: String, path: String, retryable: bool, remaining: Vec<RemovalRemnant>) -> ScmFailure {
    ScmFailure::coded(
        WORKTREE_REMOVAL_INCOMPLETE,
        DomainErrorDetail::WorktreeRemovalIncomplete {
            entry_id,
            path,
            retryable,
            remaining,
            reason: None,
            revision: None,
        },
    )
}

pub fn merge_failed(reason: &str, source: Option<String>, aborted: Option<bool>) -> ScmFailure {
    ScmFailure::coded(
        MERGE_FAILED,
        DomainErrorDetail::MergeFailed {
            reason: reason.to_owned(),
            source,
            aborted,
        },
    )
}

pub fn merge_target_dirty(operation: &str, files: Vec<String>, count: Option<u64>) -> ScmFailure {
    ScmFailure::coded(
        MERGE_TARGET_DIRTY,
        DomainErrorDetail::MergeTargetDirty {
            operation: operation.to_owned(),
            files,
            count,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_core_api::CoreError;

    #[test]
    fn a_refusal_reaches_the_seam_with_its_typed_detail() {
        let error: CoreError = target_mismatch(None, None, Some("main".into()), Some("dev".into())).into();
        match error {
            CoreError::DomainError { domain, code, detail, .. } => {
                assert_eq!(&*domain, "worktree");
                assert_eq!(code.as_deref(), Some(WORKTREE_TARGET_MISMATCH));
                assert_eq!(
                    detail.as_deref(),
                    Some(&DomainErrorDetail::WorktreeTargetMismatch {
                        target: None,
                        current: None,
                        expected: Some("main".into()),
                        actual: Some("dev".into()),
                    })
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn busy_reasons_carry_their_wire_names() {
        let error = retained_by(vec!["s1".into()]);
        match error.detail() {
            Some(DomainErrorDetail::WorktreeBusyJobs { reason, sessions, .. }) => {
                assert_eq!(reason, "workspace-retained");
                assert_eq!(sessions.as_deref(), Some(&["s1".to_owned()][..]));
            }
            other => panic!("{other:?}"),
        }
    }
}
