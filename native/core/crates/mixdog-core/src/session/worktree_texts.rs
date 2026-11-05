//! The `message` Node's typed worktree errors carry when thrown to a surface that shows the
//! runtime's own text (TUI, remote): the contract's per-code default
//! (`runtime/shared/worktrees/contract.mjs` `DEFAULT_ERROR_MESSAGES`). `mixdog-scm`'s
//! `failure_text` is the desktop's translation of the same failures and words several of them
//! differently, so the two are not interchangeable.

use mixdog_scm::error::ScmFailure;

/// What the turn-start gate throws for a session whose worktree folder is gone
/// (`worktree-intents.mjs` `prepareTurnWorkspace`); it replaces the default text of
/// `WORKTREE_MISSING` there and only there.
pub const RECOVERY_TURN_REFUSAL: &str =
    "The worktree for this session no longer exists; pick a branch or remove the worktree to continue.";

const DEFAULTS: [(&str, &str); 23] = [
    ("WORKTREE_BUSY_JOBS", "The session has running jobs; wait for them or stop them before changing its workspace."),
    ("WORKTREE_BRANCH_OCCUPIED", "The branch is checked out in another worktree."),
    (
        "WORKTREE_DEFAULT_BRANCH",
        "The repository's default branch can't be opened in a worktree: the project folder could not switch to it while the worktree exists. Check it out in the project folder, or create a new branch for the worktree.",
    ),
    ("WORKTREE_DISK_INSUFFICIENT", "Not enough free disk space to create the worktree."),
    ("WORKTREE_LARGE_REPO_CONFIRM", "The repository is large; confirm before creating a worktree."),
    ("WORKTREE_DIRTY", "The worktree has uncommitted changes."),
    (
        "WORKTREE_DIRTY_CHOICE",
        "The project folder has uncommitted changes; choose whether to leave them there or carry them into the worktree.",
    ),
    (
        "WORKTREE_FILE_RECOVERY",
        "Retained file recovery records block worktree removal, including force. Inspect and explicitly delete them first.",
    ),
    ("WORKTREE_UNMERGED", "The worktree branch has commits that are not merged."),
    ("WORKTREE_MISSING", "The managed worktree no longer exists."),
    ("WORKTREE_UNSUPPORTED_REPO", "This repository does not support managed worktrees."),
    ("WORKTREE_REVISION_CONFLICT", "The session workspace changed; reload and try again."),
    ("WORKTREE_NOT_IMPLEMENTED", "Worktree support is not implemented yet."),
    ("WORKTREE_CONFIRM_REQUIRED", "A merge requires explicit confirmation."),
    ("WORKTREE_TARGET_MISMATCH", "The project folder is not on the branch the merge was confirmed for."),
    ("WORKTREE_PROJECT_MISMATCH", "The retained worktree belongs to another project or repository."),
    ("WORKTREE_PARTIAL_TRANSITION", "The branch change failed part-way; the project folder stayed on the new branch."),
    ("WORKTREE_PROJECT_UNKNOWN", "Project is not available."),
    (
        "WORKTREE_REMOVAL_INCOMPLETE",
        "The worktree was only partly removed (a file or folder is still in use); remove it again to finish.",
    ),
    ("WORKTREE_PATH_UNSAFE", "The worktree folder is not a managed checkout of this repository; nothing was deleted."),
    ("MERGE_CONFLICT", "The merge would conflict."),
    ("MERGE_TARGET_DIRTY", "The merge target has uncommitted changes."),
    ("MERGE_FAILED", "The merge failed; the project folder is unchanged."),
];

/// Node's thrown `message`: the contract default of a coded failure, else the failure's own text
/// (a plain error is thrown with its message as is).
pub fn thrown_message(failure: &ScmFailure) -> String {
    match failure.code() {
        Some(code) => DEFAULTS.iter().find(|(known, _)| *known == code).map_or_else(|| code.to_owned(), |(_, text)| (*text).to_owned()),
        None => failure.to_string(),
    }
}
