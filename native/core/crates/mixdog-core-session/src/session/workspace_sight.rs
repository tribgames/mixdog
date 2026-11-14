//! `workspaceSees(targetCwd, viewerCwd)` (`shared/worktrees/workspace-visibility.mjs`): a
//! session working in one folder sees work done in another when the two overlap, or when they
//! belong to one repository (a checkout and its linked worktrees share one git common dir).
//! The repository is found as `findGitLayout` finds it (`git-head.mjs:layoutAbove`): walking up
//! to a `.git` directory, or a `gitdir:` file, whose git dir holds a `HEAD`. Every comparison is
//! on canonical paths (`worktrees/paths.mjs`), which reads the file system, so it runs on the lane.

use std::path::MAIN_SEPARATOR;
use std::path::MAIN_SEPARATOR_STR;
use std::path::Path;
use std::path::PathBuf;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_rt::CancellationToken;
use mixdog_rt::InLane;
use mixdog_rt::MaintenanceIo;
use mixdog_workspace::pathguard::canonical_through_existing;

use super::shell_jobs::WorkspaceSight;
use super::user_cwd::node_resolve;

pub struct GitSight {
    io: MaintenanceIo,
}

impl GitSight {
    pub fn new(io: MaintenanceIo) -> Self {
        Self { io }
    }

    /// `job` as a maintenance-lane job. An `Err` means it did not run (the lane was full or
    /// wedged): Node's `catch { return false }` (`workspace-visibility.mjs`) covers a failed
    /// file read only, so an unrun check must not be answered "does not see".
    async fn on_lane<R: Send + 'static>(&self, job: impl FnOnce(&InLane<MaintenanceIo>) -> R + Send + 'static) -> Result<R, CoreError> {
        mixdog_core_base::support::on_lane(self.io, &CancellationToken::new(), job).await
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

/// `canonicalPath` (`paths.mjs`): `path.resolve` (`..` folded), then the real path of the nearest
/// existing ancestor with the rest appended, so a link and a short name lead to the same folder
/// whether or not the folder exists. A real path that cannot be read leaves the resolved one.
fn canonical_path(_lane: &InLane<MaintenanceIo>, value: &str) -> String {
    let full = node_resolve(value);
    canonical_through_existing(Path::new(&full)).map_or(full, |real| real.to_string_lossy().into_owned())
}

/// `pathKey`: the canonical path without trailing separators, folded to lower case on Windows.
fn path_key(lane: &InLane<MaintenanceIo>, value: &str) -> String {
    let canonical = canonical_path(lane, value);
    let trimmed = canonical.trim_end_matches(['\\', '/']);
    let path = if trimmed.is_empty() { MAIN_SEPARATOR_STR } else { trimmed };
    if cfg!(windows) { path.to_lowercase() } else { path.to_owned() }
}

/// `isWithin(parent, child)` on canonical paths: `child` is `parent` itself or lies inside it.
fn is_within(lane: &InLane<MaintenanceIo>, parent: &str, child: &str) -> bool {
    let base = path_key(lane, parent);
    let target = path_key(lane, child);
    let prefix = if base.ends_with(MAIN_SEPARATOR) { base.clone() } else { format!("{base}{MAIN_SEPARATOR}") };
    target == base || target.starts_with(&prefix)
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
            let common_dir = match common.filter(|common| !common.is_empty()) {
                Some(common) => resolve_from(Path::new(&git_dir), &common),
                None => git_dir,
            };
            return Some(canonical_path(lane, &common_dir));
        }
        if !dir.pop() {
            return None;
        }
    }
}

#[async_trait]
impl WorkspaceSight for GitSight {
    async fn sees(&self, target: &str, viewer: &str) -> Result<bool, CoreError> {
        if target.is_empty() || viewer.is_empty() {
            return Ok(false);
        }
        let (target, viewer) = (target.to_owned(), viewer.to_owned());
        self.on_lane(move |lane| {
            if is_within(lane, &target, &viewer) || is_within(lane, &viewer, &target) {
                return true;
            }
            match (common_dir_above(lane, &target), common_dir_above(lane, &viewer)) {
                (Some(target), Some(viewer)) => path_key(lane, &target) == path_key(lane, &viewer),
                _ => false,
            }
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use mixdog_rt::LaneToken;

    use super::*;
    use crate::session::worktree::worktree_tests::link_dir;

    /// Lays `text` at `path` (its directories made) the way the daemon writes: on the lane.
    async fn put(path: &Path, text: &str) {
        let (path, text) = (path.to_owned(), text.to_owned());
        let io = mixdog_rt::testing::tokens().maintenance_io;
        io.submit(&CancellationToken::new(), move |lane| mixdog_statefile::append_file(lane, &path, text.as_bytes()).unwrap()).unwrap().await.unwrap();
    }

    async fn make_dir(path: &Path) {
        let path = path.to_owned();
        let io = mixdog_rt::testing::tokens().maintenance_io;
        io.submit(&CancellationToken::new(), move |lane| mixdog_statefile::create_private_dir_all(lane, &path).unwrap()).unwrap().await.unwrap();
    }

    async fn checkout(root: &Path, name: &str) -> PathBuf {
        let dir = root.join(name);
        put(&dir.join(".git").join("HEAD"), "ref: refs/heads/main\n").await;
        dir
    }

    /// `workspace-visibility.mjs`: overlapping folders see each other; two checkouts of one
    /// repository (a linked worktree's `gitdir:` pointer and its `commondir`) do too; unrelated
    /// repositories and empty folders do not.
    #[tokio::test]
    async fn folders_see_each_other_when_they_overlap_or_share_a_repository() {
        let temp = tempfile::tempdir().unwrap();
        let sight = GitSight::new(mixdog_rt::testing::tokens().maintenance_io);
        let main = checkout(temp.path(), "main").await;
        let other = checkout(temp.path(), "other").await;
        // A linked worktree: `.git` is a file naming a git dir under the main one's `worktrees`.
        let linked = temp.path().join("linked");
        let git_dir = main.join(".git").join("worktrees").join("linked");
        put(&git_dir.join("HEAD"), "ref: refs/heads/topic\n").await;
        put(&git_dir.join("commondir"), "../..\n").await;
        put(&linked.join(".git"), &format!("gitdir: {}\n", git_dir.display())).await;
        let inner = main.join("src");
        make_dir(&inner).await;

        let path = |p: &Path| p.to_string_lossy().into_owned();
        assert!(sight.sees(&path(&main), &path(&inner)).await.unwrap(), "a folder inside the other");
        assert!(sight.sees(&path(&inner), &path(&main)).await.unwrap(), "and the other way round");
        assert!(sight.sees(&path(&main), &path(&linked)).await.unwrap(), "a linked worktree of the repository");
        assert!(!sight.sees(&path(&main), &path(&other)).await.unwrap(), "another repository");
        assert!(!sight.sees(&path(&main), "").await.unwrap(), "no viewer folder");
    }

    /// `workspaceSees` over spellings of one folder, with the answers Node gave for this tree
    /// (`workspace-visibility.mjs` run on it): `..` is folded before any comparison, so a path that
    /// climbs out of a folder is not inside it; a link, a case spelling and a trailing separator
    /// lead to the folder they name; a path below a folder that does not exist is judged through
    /// its nearest existing ancestor (`canonicalPath`, `paths.mjs`).
    #[tokio::test]
    async fn spellings_of_a_folder_are_judged_on_canonical_paths_as_node_does() {
        let temp = tempfile::tempdir().unwrap();
        let root = mixdog_workspace::pathguard::canonical(temp.path()).unwrap();
        let sight = GitSight::new(mixdog_rt::testing::tokens().maintenance_io);
        let main = checkout(&root, "main").await;
        checkout(&root, "other").await;
        let linked = root.join("linked");
        let git_dir = main.join(".git").join("worktrees").join("linked");
        put(&git_dir.join("HEAD"), "ref: refs/heads/topic\n").await;
        put(&git_dir.join("commondir"), "../..\n").await;
        put(&linked.join(".git"), &format!("gitdir: {}\n", git_dir.display())).await;
        make_dir(&main.join("src")).await;
        make_dir(&root.join("outside-review")).await;
        link_dir(&main, &root.join("alias"));
        link_dir(&linked, &root.join("linkedalias"));

        let root = root.to_string_lossy().into_owned();
        // Joined as written: `..` and a trailing separator stay in the string.
        let raw = |parts: &[&str]| std::iter::once(root.as_str()).chain(parts.iter().copied()).collect::<Vec<_>>().join(MAIN_SEPARATOR_STR);
        let cases = [
            ("a path that climbs out of the folder", raw(&["main", "..", "outside-review"]), raw(&["main"]), false),
            ("a viewer that climbs out of the folder", raw(&["main"]), raw(&["main", "..", "outside-review"]), false),
            ("a path that climbs and stays inside", raw(&["main", "src", "..", "src"]), raw(&["main"]), true),
            ("a path that climbs into another repository", raw(&["main", "..", "other"]), raw(&["main"]), false),
            ("a link to the folder", raw(&["alias"]), raw(&["main"]), true),
            ("below a link to the folder", raw(&["alias", "src"]), raw(&["main"]), true),
            ("a link to a linked worktree", raw(&["linkedalias"]), raw(&["main"]), true),
            ("a link to the folder, another repository", raw(&["alias"]), raw(&["other"]), false),
            ("a climb out of a link is lexical", raw(&["alias", "..", "outside-review"]), raw(&["main"]), false),
            ("another case of the folder", raw(&["MAIN", "src"]), raw(&["main"]), cfg!(windows)),
            ("another case of another repository", raw(&["OTHER"]), raw(&["main"]), false),
            ("below a folder that does not exist", raw(&["main", "gone", "deeper"]), raw(&["main"]), true),
            ("below a missing folder of a link", raw(&["alias", "gone"]), raw(&["main", "src"]), true),
            ("a climb out through a missing folder", raw(&["main", "gone", "..", "..", "outside-review"]), raw(&["main"]), false),
            ("a trailing separator", raw(&["main"]) + MAIN_SEPARATOR_STR, raw(&["main", "src"]), true),
            ("a linked worktree and the folder", raw(&["linked"]), raw(&["main", "src"]), true),
            ("a linked worktree and another repository", raw(&["linked"]), raw(&["other"]), false),
        ];
        for (name, target, viewer, want) in cases {
            assert_eq!(sight.sees(&target, &viewer).await.unwrap(), want, "{name}: {target} / {viewer}");
        }
    }
}
