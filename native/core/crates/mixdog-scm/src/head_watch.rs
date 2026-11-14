//! The HEAD watcher: one OS watch per git dir, shared by every session in that repository (`git-head.mjs`
//! `createGitHeadWatcher`). A `git switch`, a branch rename, a detach, a symbolic-ref change and an atomic HEAD replace
//! (`HEAD.lock` renamed over `HEAD`) done outside Mixdog (a terminal, the git agent tool, another application) all end in a
//! write of the git dir's `HEAD` file; a follower is told once per batch of such writes and reads the checkout again.
//!
//! Where the file watcher cannot start, the reason is logged once at error level and nothing follows HEAD.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;

use mixdog_workspace::watcher::ChangeKind;
use mixdog_workspace::watcher::ChangeSink;
use mixdog_workspace::watcher::FolderWatcher;
use tokio::sync::watch;

/// The id of a git dir's folder watch on the HEAD watcher's own `FolderWatcher`.
const WATCH_PREFIX: &str = "scm.head:";

/// One followed git dir: its watch's wake counter and how many followers hold it.
struct Followed {
    moved: watch::Sender<u64>,
    followers: usize,
}

/// The followed git dirs by their watch id. Shared with the folder watcher's sink.
#[derive(Default)]
struct Heads(Mutex<HashMap<String, Followed>>);

impl Heads {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Followed>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Wakes the followers of a git dir whose `HEAD` was written, or whose events were lost (every follower reads again).
struct HeadSink(Arc<Heads>);

impl ChangeSink for HeadSink {
    fn changed(&self, watch_id: &str, paths: Vec<String>, kind: ChangeKind) {
        let head = |path: &String| Path::new(path).file_name().is_some_and(|name| name.eq_ignore_ascii_case("HEAD"));
        if kind != ChangeKind::Overflow && !paths.iter().any(head) {
            return;
        }
        if let Some(followed) = self.0.lock().get(watch_id) {
            followed.moved.send_modify(|moves| *moves = moves.wrapping_add(1));
        }
    }
}

/// The HEAD watchers of the process.
pub struct HeadWatchers {
    heads: Arc<Heads>,
    folders: OnceLock<Option<Arc<FolderWatcher>>>,
}

impl HeadWatchers {
    fn new() -> Self {
        Self { heads: Arc::new(Heads::default()), folders: OnceLock::new() }
    }

    /// The one set of watchers every session shares.
    pub fn shared() -> &'static Self {
        static SHARED: OnceLock<HeadWatchers> = OnceLock::new();
        SHARED.get_or_init(Self::new)
    }

    fn folders(&self) -> Option<&Arc<FolderWatcher>> {
        self.folders
            .get_or_init(|| match FolderWatcher::new(Arc::new(HeadSink(self.heads.clone()))) {
                Ok(folders) => Some(Arc::new(folders)),
                Err(error) => {
                    tracing::error!("HEAD changes made outside the app are not followed: {}", error.message);
                    None
                }
            })
            .as_ref()
    }

    /// The git dir the checkout holding `cwd` keeps its own `HEAD` in (a linked worktree's or a submodule's own dir, not the
    /// common one): the nearest folder above `cwd`, itself included, whose `.git` (a folder, or a `gitdir:` file) leads to a git
    /// dir holding `HEAD` (`git-head.mjs` layoutAbove). Reads files: call it on a lane.
    #[allow(clippy::disallowed_methods, reason = "a stat and one tiny read per folder, called only inside the lane job that follows")]
    pub fn git_dir_of(cwd: &Path) -> Option<PathBuf> {
        cwd.ancestors().find_map(|folder| {
            let dot_git = folder.join(".git");
            let git_dir = if dot_git.is_dir() {
                dot_git
            } else {
                let text = std::fs::read_to_string(&dot_git).ok()?;
                mixdog_workspace::pathguard::lexical(&folder.join(text.trim().strip_prefix("gitdir:")?.trim()))
            };
            git_dir.join("HEAD").is_file().then_some(git_dir)
        })
    }

    /// Follows the HEAD of the checkout holding `cwd`, sharing the watch of every other follower of the same git dir; `None`
    /// outside a git checkout, or where the file watcher is not available. Reads files: call it on a lane.
    pub fn follow(&self, cwd: &Path) -> Option<HeadFollow> {
        let dir = Self::git_dir_of(cwd)?;
        let dir = mixdog_workspace::pathguard::canonical(&dir).unwrap_or(dir);
        let folders = self.folders()?;
        let id = format!("{WATCH_PREFIX}{}", dir.display());
        let mut heads = self.heads.lock();
        if let Some(followed) = heads.get_mut(&id) {
            followed.followers += 1;
            let moved = followed.moved.subscribe();
            return Some(HeadFollow { moved, id, heads: self.heads.clone(), folders: folders.clone() });
        }
        if let Err(error) = folders.watch(&id, &dir, false) {
            tracing::warn!(dir = %dir.display(), "the HEAD of a checkout is not followed: {}", error.message);
            return None;
        }
        let (moved, receiver) = watch::channel(0);
        heads.insert(id.clone(), Followed { moved, followers: 1 });
        Some(HeadFollow { moved: receiver, id, heads: self.heads.clone(), folders: folders.clone() })
    }
}

/// One follower of a git dir's HEAD. Dropped, it leaves the watch, which ends with its last follower.
pub struct HeadFollow {
    moved: watch::Receiver<u64>,
    id: String,
    heads: Arc<Heads>,
    folders: Arc<FolderWatcher>,
}

impl HeadFollow {
    /// Waits until HEAD changed since the last call (or since the follow began); `false` once the watch is gone.
    pub async fn moved(&mut self) -> bool {
        self.moved.changed().await.is_ok()
    }
}

impl Drop for HeadFollow {
    fn drop(&mut self) {
        let mut heads = self.heads.lock();
        let Some(followed) = heads.get_mut(&self.id) else {
            return;
        };
        followed.followers -= 1;
        if followed.followers == 0 {
            heads.remove(&self.id);
            self.folders.unwatch(&self.id);
        }
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests {
    use std::time::Duration;

    use super::*;

    /// A checkout folder whose HEAD names `branch`.
    fn checkout(branch: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".git/refs/heads")).unwrap();
        std::fs::write(dir.path().join(".git/HEAD"), format!("ref: refs/heads/{branch}\n")).unwrap();
        dir
    }

    /// What `git switch` does: the new HEAD is written to `HEAD.lock` and renamed over `HEAD`.
    fn switch(dir: &Path, text: &str) {
        std::fs::write(dir.join(".git/HEAD.lock"), text).unwrap();
        std::fs::rename(dir.join(".git/HEAD.lock"), dir.join(".git/HEAD")).unwrap();
    }

    async fn heard(follow: &mut HeadFollow) -> bool {
        mixdog_rt::time::timeout(Duration::from_secs(5), follow.moved()).await.unwrap_or(false)
    }

    #[test]
    fn a_folder_inside_a_checkout_and_a_linked_worktree_find_their_own_git_dir() {
        let main = checkout("main");
        let deep = main.path().join("src/a");
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(HeadWatchers::git_dir_of(&deep), Some(main.path().join(".git")));
        let linked = tempfile::tempdir().unwrap();
        let own = main.path().join(".git/worktrees/w");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(own.join("commondir"), "../..\n").unwrap();
        std::fs::write(own.join("HEAD"), "ref: refs/heads/w\n").unwrap();
        std::fs::write(linked.path().join(".git"), format!("gitdir: {}\n", own.display())).unwrap();
        let found = HeadWatchers::git_dir_of(linked.path()).expect("the linked checkout's git dir");
        assert_eq!(found, mixdog_workspace::pathguard::lexical(&own));
        // A submodule's `.git` file names its git dir under the superproject's, with no `commondir`: its own HEAD is followed,
        // not the superproject's.
        let module = main.path().join("vendor/lib");
        let module_git = main.path().join(".git/modules/lib");
        std::fs::create_dir_all(&module).unwrap();
        std::fs::create_dir_all(&module_git).unwrap();
        std::fs::write(module_git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(module.join(".git"), "gitdir: ../../.git/modules/lib\n").unwrap();
        assert_eq!(HeadWatchers::git_dir_of(&module), Some(mixdog_workspace::pathguard::lexical(&module_git)));
        // A `.git` folder with no HEAD is not a checkout: the search goes on upward.
        let stray = main.path().join("stray");
        std::fs::create_dir_all(stray.join(".git")).unwrap();
        assert_eq!(HeadWatchers::git_dir_of(&stray), Some(main.path().join(".git")));
    }

    #[tokio::test]
    async fn a_switch_done_outside_wakes_the_follower() {
        let dir = checkout("main");
        let watchers = HeadWatchers::new();
        let mut follow = watchers.follow(dir.path()).expect("followed");
        switch(dir.path(), "ref: refs/heads/topic\n");
        assert!(heard(&mut follow).await, "the atomic replace of HEAD is heard");
        std::fs::write(dir.path().join(".git/HEAD"), "0123456789012345678901234567890123456789\n").unwrap();
        assert!(heard(&mut follow).await, "a detach is heard");
    }

    #[tokio::test]
    async fn a_write_that_is_not_head_wakes_no_one() {
        let dir = checkout("main");
        let watchers = HeadWatchers::new();
        let mut follow = watchers.follow(dir.path()).expect("followed");
        std::fs::write(dir.path().join(".git/index"), "x").unwrap();
        assert!(!mixdog_rt::time::timeout(Duration::from_millis(800), follow.moved()).await.unwrap_or(false));
    }

    #[tokio::test]
    async fn sessions_of_one_repository_share_one_watch_that_ends_with_the_last() {
        let dir = checkout("main");
        let watchers = HeadWatchers::new();
        let mut first = watchers.follow(dir.path()).expect("first");
        let mut second = watchers.follow(&dir.path().join("sub")).expect("second");
        assert_eq!(watchers.heads.lock().len(), 1);
        assert_eq!(watchers.folders().unwrap().open_watches(), 1);
        switch(dir.path(), "ref: refs/heads/topic\n");
        assert!(heard(&mut first).await && heard(&mut second).await, "both followers hear it");
        drop(first);
        assert_eq!(watchers.folders().unwrap().open_watches(), 1, "the second still follows");
        drop(second);
        assert!(watchers.heads.lock().is_empty());
        assert_eq!(watchers.folders().unwrap().open_watches(), 0);
    }
}
