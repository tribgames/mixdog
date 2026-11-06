//! `workspaceSees(targetCwd, viewerCwd)` (`shared/worktrees/workspace-visibility.mjs`): a
//! session working in one folder sees work done in another when the two overlap, or when they
//! belong to one repository (a checkout and its linked worktrees share one git common dir).
//! The repository is found as `findGitLayout` finds it (`git-head.mjs:layoutAbove`): walking up
//! to a `.git` directory, or a `gitdir:` file, whose git dir holds a `HEAD`.

use std::path::Path;
use std::path::PathBuf;

use async_trait::async_trait;
use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;

use super::shell_jobs::WorkspaceSight;
use super::user_cwd::node_resolve;
use super::worktree::worktree_state::is_within;
use super::worktree::worktree_state::same_path;
use mixdog_rt::LaneToken;

pub struct GitSight {
    io: MaintenanceIo,
}

impl GitSight {
    pub fn new(io: MaintenanceIo) -> Self {
        Self { io }
    }

    /// `job` as a maintenance-lane job; `None` when the lane refused or dropped it.
    async fn on_lane<R: Send + 'static>(&self, job: impl FnOnce(&InLane<MaintenanceIo>) -> R + Send + 'static) -> Option<R> {
        self.io.submit(&CancellationToken::new(), job).ok()?.await.ok()
    }
}

fn is_dir(lane: &InLane<MaintenanceIo>, path: &Path) -> bool {
    mixdog_statefile::metadata(lane, path).is_ok_and(|meta| meta.is_dir())
}

fn is_file(lane: &InLane<MaintenanceIo>, path: &Path) -> bool {
    mixdog_statefile::metadata(lane, path).is_ok_and(|meta| meta.is_file())
}

fn read_text(path: &Path) -> Option<String> {
    mixdog_statefile::read_content(path).ok().flatten().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// The first `gitdir: <path>` line (`/^gitdir:\s*(.+?)\s*$/m`).
fn gitdir_pointer(text: &str) -> Option<&str> {
    text.lines().find_map(|line| {
        let rest = mixdog_js::js_trim(line.strip_prefix("gitdir:")?);
        (!rest.is_empty()).then_some(rest)
    })
}

/// `path.resolve(base, target)`.
fn resolve_from(base: &Path, target: &str) -> String {
    node_resolve(&base.join(target).to_string_lossy())
}

/// The common git dir of the checkout containing `start` (`layoutAbove(start).commonDir`).
fn common_dir_above(lane: &InLane<MaintenanceIo>, start: &str) -> Option<String> {
    let mut dir = PathBuf::from(node_resolve(start));
    loop {
        let dot_git = dir.join(".git");
        let git_dir = if is_dir(lane, &dot_git) {
            Some(dot_git.to_string_lossy().into_owned())
        } else if is_file(lane, &dot_git) {
            read_text(&dot_git).and_then(|text| gitdir_pointer(&text).map(|pointer| resolve_from(&dir, pointer)))
        } else {
            None
        };
        if let Some(git_dir) = git_dir
            && is_file(lane, &Path::new(&git_dir).join("HEAD"))
        {
            let common = read_text(&Path::new(&git_dir).join("commondir")).map(|text| mixdog_js::js_trim(&text).to_owned());
            return Some(match common.filter(|common| !common.is_empty()) {
                Some(common) => resolve_from(Path::new(&git_dir), &common),
                None => git_dir,
            });
        }
        if !dir.pop() {
            return None;
        }
    }
}

#[async_trait]
impl WorkspaceSight for GitSight {
    async fn sees(&self, target: &str, viewer: &str) -> bool {
        if target.is_empty() || viewer.is_empty() {
            return false;
        }
        if is_within(target, viewer) || is_within(viewer, target) {
            return true;
        }
        let (target, viewer) = (target.to_owned(), viewer.to_owned());
        self.on_lane(move |lane| match (common_dir_above(lane, &target), common_dir_above(lane, &viewer)) {
            (Some(target), Some(viewer)) => same_path(&target, &viewer),
            _ => false,
        })
        .await
        .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkout(root: &Path, name: &str) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
        dir
    }

    /// `workspace-visibility.mjs`: overlapping folders see each other; two checkouts of one
    /// repository (a linked worktree's `gitdir:` pointer and its `commondir`) do too; unrelated
    /// repositories and empty folders do not.
    #[tokio::test]
    async fn folders_see_each_other_when_they_overlap_or_share_a_repository() {
        let temp = tempfile::tempdir().unwrap();
        let sight = GitSight::new(mixdog_rt::testing::tokens().maintenance_io);
        let main = checkout(temp.path(), "main");
        let other = checkout(temp.path(), "other");
        // A linked worktree: `.git` is a file naming a git dir under the main one's `worktrees`.
        let linked = temp.path().join("linked");
        let git_dir = main.join(".git").join("worktrees").join("linked");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/topic\n").unwrap();
        std::fs::write(git_dir.join("commondir"), "../..\n").unwrap();
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(linked.join(".git"), format!("gitdir: {}\n", git_dir.display())).unwrap();
        let inner = main.join("src");
        std::fs::create_dir_all(&inner).unwrap();

        let path = |p: &Path| p.to_string_lossy().into_owned();
        assert!(sight.sees(&path(&main), &path(&inner)).await, "a folder inside the other");
        assert!(sight.sees(&path(&inner), &path(&main)).await, "and the other way round");
        assert!(sight.sees(&path(&main), &path(&linked)).await, "a linked worktree of the repository");
        assert!(!sight.sees(&path(&main), &path(&other)).await, "another repository");
        assert!(!sight.sees(&path(&main), "").await, "no viewer folder");
    }
}
