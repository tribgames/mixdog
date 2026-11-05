//! What a worktree holds that is not elsewhere yet: unmerged commits and dirty paths. "Merged"
//! is measured against the merge target's tip, else the base commit; commits are measured from
//! the checkout's HEAD (detached or not), so no branch name decides it.

use std::path::Path;
use std::path::PathBuf;

use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::git::RunOptions;
use crate::repo::on_lane;
use crate::worktree::manager::Worktrees;
use crate::worktree::merge::parse_status_entries;
use crate::worktree::registry::WorktreeRecord;

/// Paths a cleanup preview lists.
pub const DIRTY_CHOICE_PREVIEW: usize = 50;
const IDENTITY_FILE: &str = ".mixdog/project.id";

fn repo_cwd(record: &WorktreeRecord) -> PathBuf {
    PathBuf::from(&record.project_path)
}

impl Worktrees {
    pub(crate) async fn branch_commit(&self, cwd: &Path, branch: &str, cancel: &CancellationToken) -> Result<Option<String>, ScmFailure> {
        let spec = format!("refs/heads/{branch}^{{commit}}");
        let out = self
            .scm()
            .git
            .outcome(cancel, cwd, &["rev-parse", "--verify", "--quiet", &spec], &RunOptions::default())
            .await?;
        Ok(out.success().then(|| out.stdout_text().lines().next().unwrap_or("").trim().to_owned()))
    }

    /// The merge target's tip, else the base commit.
    async fn merge_reference(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<Option<String>, ScmFailure> {
        if let Some(target) = &record.merge_target {
            if let Some(tip) = self.branch_commit(&repo_cwd(record), target, cancel).await? {
                return Ok(Some(tip));
            }
        }
        Ok(record.base_commit.clone())
    }

    /// Unmerged commits of what the checkout has: its HEAD commit, or the branch tip when the
    /// folder is already gone. A snapshot has no branch, so nothing of it can be unmerged.
    pub async fn checkout_unmerged_count(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<u64, ScmFailure> {
        let Some(branch) = &record.branch else {
            return Ok(0);
        };
        let path = PathBuf::from(&record.path);
        let tip = if path.exists() {
            let head = self
                .scm()
                .git
                .outcome(cancel, &path, &["rev-parse", "--verify", "-q", "HEAD"], &RunOptions::read())
                .await?;
            if head.success() {
                Some(head.stdout_text().trim().to_owned())
            } else {
                self.branch_commit(&repo_cwd(record), branch, cancel).await?
            }
        } else {
            self.branch_commit(&repo_cwd(record), branch, cancel).await?
        };
        self.unmerged_commit_count(record, tip.as_deref(), cancel).await
    }

    /// Commits of `tip` the merge reference lacks; 0 when none, or when their changes are all in it.
    pub async fn unmerged_commit_count(&self, record: &WorktreeRecord, tip: Option<&str>, cancel: &CancellationToken) -> Result<u64, ScmFailure> {
        let Some(tip) = tip.filter(|tip| !tip.is_empty()) else {
            return Ok(0);
        };
        let cwd = repo_cwd(record);
        let Some(reference) = self.merge_reference(record, cancel).await? else {
            return Ok(0);
        };
        let counted = self.scm().git.run(cancel, &cwd, &["rev-list", "--count", tip, "--not", &reference]).await?;
        let count: u64 = counted.trim().parse().unwrap_or(0);
        if count == 0 || self.changes_contained_in(&cwd, tip, &reference, cancel).await? {
            return Ok(0);
        }
        Ok(count)
    }

    /// A squash, rebase or cherry-pick merge leaves the branch's commits unreachable from
    /// `reference` although their changes are there. Merged only when merging `tip` into
    /// `reference` would leave its tree exactly as it is; a branch's own unreachable merge
    /// commit is unmerged work, and anything git cannot decide counts as unmerged.
    async fn changes_contained_in(&self, cwd: &Path, tip: &str, reference: &str, cancel: &CancellationToken) -> Result<bool, ScmFailure> {
        let git = &self.scm().git;
        let merges = git
            .outcome(cancel, cwd, &["rev-list", "--count", "--merges", tip, "--not", reference], &RunOptions::read())
            .await?;
        if !merges.success() || merges.stdout_text().trim().parse::<u64>().unwrap_or(1) != 0 {
            return Ok(false);
        }
        let merged = git
            .outcome(cancel, cwd, &["merge-tree", "--write-tree", reference, tip], &RunOptions::default())
            .await?;
        if !merged.success() {
            return Ok(false);
        }
        let spec = format!("{reference}^{{tree}}");
        let target = git.outcome(cancel, cwd, &["rev-parse", &spec], &RunOptions::read()).await?;
        Ok(target.success()
            && merged.stdout_text().lines().next().unwrap_or("").trim() == target.stdout_text().lines().next().unwrap_or("").trim())
    }

    fn identity_path(record: &WorktreeRecord) -> String {
        match record.extra.get("projectSubdir").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            Some(sub) => format!("{sub}/{IDENTITY_FILE}"),
            None => IDENTITY_FILE.to_owned(),
        }
    }

    /// Uncommitted and untracked paths that are user work: not the session identity file and not
    /// an include copy.
    pub async fn dirty_paths(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<Vec<String>, ScmFailure> {
        let path = PathBuf::from(&record.path);
        if !path.exists() {
            return Ok(Vec::new());
        }
        let status = self
            .scm()
            .git
            .read(cancel, &path, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])
            .await?;
        let identity = Self::identity_path(record);
        let includes = self.include_roots(record);
        let mut paths: Vec<String> = parse_status_entries(&status)
            .into_iter()
            .map(|(_, path)| path)
            .filter(|path| *path != identity && !includes.iter().any(|root| covered_by(root, path)))
            .collect();
        paths.extend(self.modified_include_copies(record, cancel).await?);
        Ok(paths)
    }

    /// The checkout's own HEAD branch, read from the folder (a `git branch -m` or a switch
    /// inside it); a detached HEAD names the recorded branch.
    pub async fn checked_out_branch_of(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<Option<String>, ScmFailure> {
        if record.branch.is_none() || record.state != "ready" || record.extra.get("kind").is_some() {
            return Ok(record.branch.clone());
        }
        let path = PathBuf::from(&record.path);
        let lane = self.scm().lane;
        let probe = path.clone();
        let head = on_lane(lane, cancel, move || {
            let repo = gix::open(&probe).ok()?;
            let top = std::fs::canonicalize(repo.workdir()?).ok()?;
            let name = repo.head_name().ok()??;
            Some((top, name.shorten().to_string()))
        })
        .await?;
        let here = std::fs::canonicalize(&path).unwrap_or(path);
        Ok(match head {
            Some((top, branch)) if crate::locks::path_key(&top) == crate::locks::path_key(&here) => Some(branch),
            _ => record.branch.clone(),
        })
    }
}

/// Whether `path` is the include item `root` or inside it.
pub fn covered_by(root: &str, path: &str) -> bool {
    path == root || path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coverage_is_by_path_component() {
        assert!(covered_by(".env", ".env"));
        assert!(covered_by("config", "config/a.json"));
        assert!(!covered_by("config", "config2/a.json"));
    }
}
