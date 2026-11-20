//! The HEAD watcher (`git-head.mjs` `createGitHeadWatcher`): each session's follower is told once per burst of writes that change
//! what its folder's checkout has checked out, and reads the checkout again. A `git switch`, a branch rename, a detach, a
//! symbolic-ref change and an atomic HEAD replace (`HEAD.lock` renamed over `HEAD`) done outside Mixdog (a terminal, the git agent
//! tool, another application) all end in a write of the git dir's `HEAD` file or of a ref file HEAD points through.
//!
//! What is followed, as `git-head.mjs` did:
//! - in a repository, `HEAD` and every symbolic ref it passes through (`holdChain`; a retargeted alias branch is heard), and the
//!   git dir itself, so a repository deleted and recreated at the same place is followed again (`dropRepo` and re-resolve);
//! - outside any repository, the `.git` of the folder and of every ancestor (`followDotGitsAbove`), so a `git init` or a clone
//!   around the folder is heard.
//!
//! A follower owns small non-recursive watches on the directories holding those files, each filtered to the names it reads; on an
//! event it resolves its folder again and wakes its receiver only when the answer (the repository, its branch or commit) differs,
//! or when the backend lost events. The watches ride their own 40 ms batch window (the old debounce), so a wake is as fast as it
//! was and no other watcher's timing changes.
//!
//! Where the file watcher cannot start, the reason is logged once at error level and nothing follows HEAD.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_workspace::watcher::ChangeKind;
use mixdog_workspace::watcher::ChangeSink;
use mixdog_workspace::watcher::FolderWatcher;
use tokio::sync::watch;

/// The prefix of a follower's folder watch ids on the HEAD watcher's own `FolderWatcher`.
const WATCH_PREFIX: &str = "scm.head:";

/// How long a burst of events is collected before a follower resolves again (`createGitHeadWatcher` `debounceMs`).
const HEAD_WINDOW_MS: u64 = 40;

/// How many symbolic refs HEAD is followed through (`MAX_SYMREF_DEPTH`).
const MAX_SYMREF_DEPTH: usize = 5;

/// Where a checkout keeps its files: the git dir holding its own `HEAD`, and the common dir holding the shared refs.
struct Layout {
    git_dir: PathBuf,
    common_dir: PathBuf,
}

/// What a checkout has checked out, with the git dir it was read from.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Answer {
    git_dir: PathBuf,
    branch: Option<String>,
    commit: Option<String>,
}

/// The directories a follower watches and the names in each that it reads.
type Watches = BTreeMap<PathBuf, BTreeSet<OsString>>;

/// One resolution of a folder: the checkout it lies in (`None` outside any repository) and the watches that follow it.
struct Resolution {
    answer: Option<Answer>,
    watches: Watches,
}

/// The nearest folder above `cwd`, itself included, whose `.git` (a folder, or a `gitdir:` file) leads to a git dir holding `HEAD`
/// (`git-head.mjs` layoutAbove): a linked worktree's or a submodule's own dir, not the common one.
#[allow(clippy::disallowed_methods, reason = "a stat and one tiny read per folder, called only inside the lane job or the watcher's own thread")]
fn layout_above(cwd: &Path) -> Option<Layout> {
    cwd.ancestors().find_map(|folder| {
        let dot_git = folder.join(".git");
        let git_dir = if dot_git.is_dir() {
            dot_git
        } else {
            let text = std::fs::read_to_string(&dot_git).ok()?;
            let target = text.lines().find_map(|line| line.strip_prefix("gitdir:"))?.trim();
            mixdog_workspace::pathguard::lexical(&folder.join(target))
        };
        if !git_dir.join("HEAD").is_file() {
            return None;
        }
        let common = std::fs::read_to_string(git_dir.join("commondir")).ok().map(|text| text.trim().to_owned()).filter(|text| !text.is_empty());
        let common_dir = common.map_or_else(|| git_dir.clone(), |common| mixdog_workspace::pathguard::lexical(&git_dir.join(common)));
        Some(Layout { git_dir, common_dir })
    })
}

#[allow(clippy::disallowed_methods, reason = "one tiny read, called only inside the lane job or the watcher's own thread")]
fn read_text(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|text| text.trim().to_owned())
}

/// The ref a `ref: <name>` line names.
fn symref(text: &str) -> Option<&str> {
    Some(text.strip_prefix("ref:")?.trim()).filter(|name| !name.is_empty())
}

fn is_object_id(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Where a ref's loose file lives: per-worktree refs in the git dir, the rest in the common dir.
fn ref_file(layout: &Layout, name: &str) -> PathBuf {
    let per_worktree = ["refs/bisect/", "refs/worktree/", "refs/rewritten/"].iter().any(|prefix| name.starts_with(prefix));
    (if per_worktree { &layout.git_dir } else { &layout.common_dir }).join(name)
}

/// What HEAD resolves to: the branch or the commit.
type Head = (Option<String>, Option<String>);

/// One read of HEAD, following its symbolic refs like git does (packed-refs never holds a symref): the branch and commit it
/// resolves to, and every file read along the chain. `None` for a missing or half-written HEAD, so the caller keeps its last
/// answer. A cycle or a chain over the depth limit leaves no branch.
fn read_head(layout: &Layout) -> (Option<Head>, Vec<PathBuf>) {
    let head_file = layout.git_dir.join("HEAD");
    let mut files = vec![head_file.clone()];
    let Some(text) = read_text(&head_file) else {
        return (None, files);
    };
    let Some(mut name) = symref(&text).map(str::to_owned) else {
        return (is_object_id(&text).then(|| (None, Some(text.to_ascii_lowercase()))), files);
    };
    let mut seen = BTreeSet::new();
    let mut resolved = None;
    for _ in 0..MAX_SYMREF_DEPTH {
        if !seen.insert(name.clone()) {
            break;
        }
        let file = ref_file(layout, &name);
        let next = read_text(&file).and_then(|text| symref(&text).map(str::to_owned));
        files.push(file);
        let Some(next) = next else {
            resolved = Some(name);
            break;
        };
        name = next;
    }
    let branch = resolved.and_then(|name| name.strip_prefix("refs/heads/").map(str::to_owned));
    (Some((branch, None)), files)
}

/// Adds the watch that hears `file` change: its folder filtered to its name, or, where that folder does not exist yet, the nearest
/// folder above that does, filtered to the name of the missing child.
#[allow(clippy::disallowed_methods, reason = "a stat per folder, called only inside the lane job or the watcher's own thread")]
fn watch_file(watches: &mut Watches, file: &Path) {
    let (Some(mut dir), Some(mut name)) = (file.parent(), file.file_name()) else {
        return;
    };
    while !dir.is_dir() {
        let (Some(parent), Some(child)) = (dir.parent(), dir.file_name()) else {
            return;
        };
        (dir, name) = (parent, child);
    }
    let dir = mixdog_workspace::pathguard::canonical(dir).unwrap_or_else(|_| dir.to_path_buf());
    watches.entry(dir).or_default().insert(name.to_owned());
}

/// The watch of one follower's directory: the follower it wakes and the names in the directory it cares about.
struct Tap {
    core: Arc<Core>,
    names: BTreeSet<OsString>,
}

/// The taps by watch id. Shared with the folder watcher's sink.
#[derive(Default)]
struct Heads(Mutex<HashMap<String, Tap>>);

impl Heads {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Tap>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Resolves the follower of a watch whose event names a file it reads, or whose events were lost (it reads again either way).
struct HeadSink(Arc<Heads>);

impl ChangeSink for HeadSink {
    fn changed(&self, watch_id: &str, paths: Vec<String>, kind: ChangeKind) {
        let lost = kind == ChangeKind::Overflow;
        let core = {
            let heads = self.0.lock();
            let Some(tap) = heads.get(watch_id) else {
                return;
            };
            let named = |path: &String| Path::new(path).file_name().is_some_and(|name| tap.names.iter().any(|read| read.eq_ignore_ascii_case(name)));
            if !lost && !paths.iter().any(named) {
                return;
            }
            tap.core.clone()
        };
        if core.sync(lost) {
            core.moved.send_modify(|moves| *moves = moves.wrapping_add(1));
        }
    }
}

/// What a follower holds: where it follows and what it last resolved.
struct Inner {
    closed: bool,
    answer: Option<Answer>,
    /// Its directory watches: the directory and the id of its watch on the folder watcher.
    watches: HashMap<PathBuf, String>,
}

/// One follower: a session's folder, the wake it sends and its watches.
struct Core {
    key: u64,
    cwd: PathBuf,
    moved: watch::Sender<u64>,
    heads: Arc<Heads>,
    folders: Arc<FolderWatcher>,
    inner: Mutex<Inner>,
}

/// The HEAD watchers of the process.
pub struct HeadWatchers {
    heads: Arc<Heads>,
    folders: OnceLock<Option<Arc<FolderWatcher>>>,
    followers: AtomicU64,
}

impl HeadWatchers {
    fn new() -> Self {
        Self { heads: Arc::new(Heads::default()), folders: OnceLock::new(), followers: AtomicU64::new(0) }
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

    /// Follows the HEAD of the checkout holding `cwd` (or, outside any checkout, a repository appearing around it); `None` where
    /// the file watcher is not available. The follower re-resolves by itself when the repository is deleted and recreated. Reads
    /// files: call it on a lane.
    pub fn follow(&self, cwd: &Path) -> Option<HeadFollow> {
        let folders = self.folders()?.clone();
        let (moved, receiver) = watch::channel(0);
        let core = Arc::new(Core {
            key: self.followers.fetch_add(1, Ordering::Relaxed),
            cwd: cwd.to_path_buf(),
            moved,
            heads: self.heads.clone(),
            folders,
            inner: Mutex::new(Inner { closed: false, answer: None, watches: HashMap::new() }),
        });
        core.sync(false);
        Some(HeadFollow { moved: receiver, core })
    }
}

/// One follower of a folder's checkout. Dropped, it releases its watches.
pub struct HeadFollow {
    moved: watch::Receiver<u64>,
    core: Arc<Core>,
}

impl HeadFollow {
    /// Waits until what the checkout has checked out changed since the last call (or since the follow began); `false` once the
    /// watch is gone.
    pub async fn moved(&mut self) -> bool {
        self.moved.changed().await.is_ok()
    }
}

impl Drop for HeadFollow {
    fn drop(&mut self) {
        let mut inner = self.core.inner.lock().unwrap_or_else(PoisonError::into_inner);
        inner.closed = true;
        for (_, id) in inner.watches.drain() {
            self.core.heads.lock().remove(&id);
            self.core.folders.unwatch(&id);
        }
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]
mod tests {
    use std::time::Duration;
    use std::time::Instant;

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

    fn git_dir_of(cwd: &Path) -> Option<PathBuf> {
        layout_above(cwd).map(|layout| layout.git_dir)
    }

    #[test]
    fn a_folder_inside_a_checkout_and_a_linked_worktree_find_their_own_git_dir() {
        let main = checkout("main");
        let deep = main.path().join("src/a");
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(git_dir_of(&deep), Some(main.path().join(".git")));
        let linked = tempfile::tempdir().unwrap();
        let own = main.path().join(".git/worktrees/w");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(own.join("commondir"), "../..\n").unwrap();
        std::fs::write(own.join("HEAD"), "ref: refs/heads/w\n").unwrap();
        std::fs::write(linked.path().join(".git"), format!("gitdir: {}\n", own.display())).unwrap();
        let found = layout_above(linked.path()).expect("the linked checkout's layout");
        assert_eq!(found.git_dir, mixdog_workspace::pathguard::lexical(&own));
        assert_eq!(found.common_dir, mixdog_workspace::pathguard::lexical(&main.path().join(".git")));
        // A submodule's `.git` file names its git dir under the superproject's, with no `commondir`: its own HEAD is followed,
        // not the superproject's.
        let module = main.path().join("vendor/lib");
        let module_git = main.path().join(".git/modules/lib");
        std::fs::create_dir_all(&module).unwrap();
        std::fs::create_dir_all(&module_git).unwrap();
        std::fs::write(module_git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(module.join(".git"), "gitdir: ../../.git/modules/lib\n").unwrap();
        assert_eq!(git_dir_of(&module), Some(mixdog_workspace::pathguard::lexical(&module_git)));
        // A `.git` folder with no HEAD is not a checkout: the search goes on upward.
        let stray = main.path().join("stray");
        std::fs::create_dir_all(stray.join(".git")).unwrap();
        assert_eq!(git_dir_of(&stray), Some(main.path().join(".git")));
    }

    #[test]
    fn head_is_followed_through_its_symbolic_refs_like_git_does() {
        let dir = checkout("alias");
        let layout = layout_above(dir.path()).unwrap();
        let heads = dir.path().join(".git/refs/heads");
        std::fs::write(heads.join("alias"), "ref: refs/heads/main\n").unwrap();
        let (head, files) = read_head(&layout);
        assert_eq!(head, Some((Some("main".to_owned()), None)), "an alias resolves to the branch it points at");
        assert_eq!(files, [dir.path().join(".git/HEAD"), heads.join("alias"), heads.join("main")]);
        // A cycle leaves no branch; a half-written HEAD leaves no answer; an object id is a detach.
        std::fs::write(heads.join("main"), "ref: refs/heads/alias\n").unwrap();
        assert_eq!(read_head(&layout).0, Some((None, None)));
        std::fs::write(dir.path().join(".git/HEAD"), "").unwrap();
        assert_eq!(read_head(&layout).0, None);
        std::fs::write(dir.path().join(".git/HEAD"), "ABCDEF0123456789ABCDEF0123456789ABCDEF01\n").unwrap();
        assert_eq!(read_head(&layout).0, Some((None, Some("abcdef0123456789abcdef0123456789abcdef01".to_owned()))));
    }

    async fn heard(follow: &mut HeadFollow) -> bool {
        mixdog_rt::time::timeout(Duration::from_secs(5), follow.moved()).await.unwrap_or(false)
    }
    async fn silent(follow: &mut HeadFollow) -> bool {
        !mixdog_rt::time::timeout(Duration::from_millis(800), follow.moved()).await.unwrap_or(false)
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
    async fn the_wake_comes_within_the_old_debounce_not_the_standard_batch() {
        let dir = checkout("main");
        let watchers = HeadWatchers::new();
        let mut follow = watchers.follow(dir.path()).expect("followed");
        let started = Instant::now();
        switch(dir.path(), "ref: refs/heads/topic\n");
        assert!(heard(&mut follow).await);
        assert!(started.elapsed() < Duration::from_millis(200), "{:?}", started.elapsed());
    }
    #[tokio::test]
    async fn a_write_that_is_not_head_wakes_no_one() {
        let dir = checkout("main");
        let watchers = HeadWatchers::new();
        let mut follow = watchers.follow(dir.path()).expect("followed");
        std::fs::write(dir.path().join(".git/index"), "x").unwrap();
        assert!(silent(&mut follow).await);
        // A commit on the checked-out branch rewrites its ref file: the answer is the same branch, nobody is woken.
        std::fs::write(dir.path().join(".git/refs/heads/main"), "0123456789012345678901234567890123456789\n").unwrap();
        assert!(silent(&mut follow).await);
    }
    #[tokio::test]
    async fn a_retargeted_alias_branch_is_heard() {
        let dir = checkout("alias");
        let alias = dir.path().join(".git/refs/heads/alias");
        std::fs::write(&alias, "ref: refs/heads/main\n").unwrap();
        let watchers = HeadWatchers::new();
        let mut follow = watchers.follow(dir.path()).expect("followed");
        std::fs::write(&alias, "ref: refs/heads/topic\n").unwrap();
        assert!(heard(&mut follow).await, "HEAD did not change, the symbolic ref it passes through did");
    }
    #[tokio::test]
    async fn a_repository_appearing_around_a_folder_that_had_none_is_heard() {
        let outer = tempfile::tempdir().unwrap();
        let inner = outer.path().join("work/pkg");
        std::fs::create_dir_all(&inner).unwrap();
        let watchers = HeadWatchers::new();
        let mut follow = watchers.follow(&inner).expect("followed");
        assert!(silent(&mut follow).await);
        // `git init` in an ancestor.
        std::fs::create_dir_all(outer.path().join("work/.git/refs/heads")).unwrap();
        std::fs::write(outer.path().join("work/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        assert!(heard(&mut follow).await, "a `.git` in an ancestor is heard");
        // The repository's own HEAD is followed from then on.
        switch(&outer.path().join("work"), "ref: refs/heads/topic\n");
        assert!(heard(&mut follow).await);
    }
    #[tokio::test]
    async fn a_repository_whose_head_vanishes_is_dropped_and_followed_again_when_it_is_back() {
        let dir = checkout("main");
        let watchers = HeadWatchers::new();
        let mut follow = watchers.follow(dir.path()).expect("followed");
        std::fs::remove_file(dir.path().join(".git/HEAD")).unwrap();
        assert!(heard(&mut follow).await, "the repository is gone");
        std::fs::write(dir.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        assert!(heard(&mut follow).await, "the repository is back");
        switch(dir.path(), "ref: refs/heads/topic\n");
        assert!(heard(&mut follow).await, "and followed again");
    }
    #[tokio::test]
    async fn sessions_of_one_repository_share_their_os_watches_that_end_with_the_last() {
        let dir = checkout("main");
        let watchers = HeadWatchers::new();
        let mut first = watchers.follow(dir.path()).expect("first");
        let mut second = watchers.follow(&dir.path().join("sub")).expect("second");
        // The git dir, the folder holding it and the folder of the branch's ref file.
        assert_eq!(watchers.folders().unwrap().open_watches(), 3);
        switch(dir.path(), "ref: refs/heads/topic\n");
        assert!(heard(&mut first).await && heard(&mut second).await, "both followers hear it");
        drop(first);
        assert_eq!(watchers.folders().unwrap().open_watches(), 3, "the second still follows");
        drop(second);
        assert!(watchers.heads.lock().is_empty());
        assert_eq!(watchers.folders().unwrap().open_watches(), 0);
    }
}

/// Resolves `cwd`: the checkout holding it and what it has checked out (`last` keeps the answer across a half-written HEAD), or, in
/// a folder outside any repository, the `.git` of the folder and of each ancestor (`followDotGitsAbove`), each ancestor also
/// filtered to the name of the ancestor below it, so one that is replaced or appears later is heard through its parent.
#[allow(clippy::disallowed_methods, reason = "a stat per ancestor, called only inside the lane job or the watcher's own thread")]
fn resolve(cwd: &Path, last: Option<&Answer>) -> Resolution {
    let mut watches = Watches::new();
    if let Some(layout) = layout_above(cwd) {
        let (head, files) = read_head(&layout);
        let kept = || last.filter(|last| last.git_dir == layout.git_dir).map(|last| (last.branch.clone(), last.commit.clone()));
        let (branch, commit) = head.or_else(kept).unwrap_or_default();
        for file in files.iter().chain([&layout.git_dir]) {
            watch_file(&mut watches, file);
        }
        return Resolution { answer: Some(Answer { git_dir: layout.git_dir, branch, commit }), watches };
    }
    let mut below: Option<&Path> = None;
    for folder in cwd.ancestors() {
        if folder.is_dir() {
            let key = mixdog_workspace::pathguard::canonical(folder).unwrap_or_else(|_| folder.to_path_buf());
            let names = watches.entry(key).or_default();
            names.insert(".git".into());
            names.extend(below.and_then(Path::file_name).map(ToOwned::to_owned));
            // A `.git` folder without HEAD is not a checkout yet: its HEAD appearing is heard.
            if folder.join(".git").is_dir() {
                watch_file(&mut watches, &folder.join(".git").join("HEAD"));
            }
        }
        below = Some(folder);
    }
    Resolution { answer: None, watches }
}
impl Core {
    /// Resolves the folder again and brings the watches to what it needs. `true` when the answer differs from the last one, or when
    /// `lost` (the backend lost events, so every follower reads again). Reads files, on the watcher's thread or a lane.
    fn sync(self: &Arc<Self>, lost: bool) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        if inner.closed {
            return false;
        }
        let mut resolution = resolve(&self.cwd, inner.answer.as_ref());
        // A watch started after the read may have missed a write in between: read once more, a bounded number of times.
        for _ in 0..2 {
            if !self.apply(&mut inner, &resolution.watches, resolution.answer.is_some()) {
                break;
            }
            resolution = resolve(&self.cwd, resolution.answer.as_ref());
        }
        let changed = lost || resolution.answer != inner.answer;
        inner.answer = resolution.answer;
        changed
    }

    /// Makes the watches `wanted`: the ones no longer needed are released, the new ones started, a kept one takes its new names.
    /// `true` when a watch was started.
    fn apply(self: &Arc<Self>, inner: &mut Inner, wanted: &Watches, in_repository: bool) -> bool {
        inner.watches.retain(|dir, id| {
            let kept = wanted.contains_key(dir);
            if !kept {
                self.heads.lock().remove(id);
                self.folders.unwatch(id);
            }
            kept
        });
        let mut started = false;
        for (dir, names) in wanted {
            if let Some(id) = inner.watches.get(dir) {
                if let Some(tap) = self.heads.lock().get_mut(id) {
                    tap.names.clone_from(names);
                }
                continue;
            }
            let id = format!("{WATCH_PREFIX}{}:{}", self.key, dir.display());
            // The tap is there before the watch, so no event finds the id unknown.
            self.heads.lock().insert(id.clone(), Tap { core: self.clone(), names: names.clone() });
            if let Err(error) = self.folders.watch_windowed(&id, dir, false, HEAD_WINDOW_MS) {
                self.heads.lock().remove(&id);
                if in_repository {
                    tracing::warn!(dir = %dir.display(), "the HEAD of a checkout is not followed: {}", error.message);
                }
                continue;
            }
            inner.watches.insert(dir.clone(), id);
            started = true;
        }
        started
    }
}
