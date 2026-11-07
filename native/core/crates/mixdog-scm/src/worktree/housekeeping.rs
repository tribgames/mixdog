//! The folder-level checks and clean-ups a removal rests on (Node `manager.mjs` helpers and
//! `file-recovery.mjs`): git's own registration of a checkout, retained editor-recovery stores,
//! links the ledger does not know, and the recursive delete. The sync functions are bodies of
//! lane jobs; the `Worktrees` methods run them there.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use mixdog_protocol::RemovalRemnant;
use sha2::Digest;
use sha2::Sha256;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::locks::path_key;
use crate::repo::on_lane;
use crate::worktree::errors;
use crate::worktree::include;
use crate::worktree::manager::GitWorktree;
use crate::worktree::manager::Worktrees;
use crate::worktree::registry::WorktreeRecord;

/// Entries a folder-only removal checks for unrecorded directory links.
const LINK_SCAN_LIMIT: usize = 250_000;
const REMOVE_RETRIES: u32 = 6;
const REMOVE_RETRY_DELAY: Duration = Duration::from_millis(150);
const EDITOR_RECOVERY: &str = "editor-recovery";

/// A directory git can run in for this record's repository.
pub(crate) fn repo_cwd(record: &WorktreeRecord) -> PathBuf {
    let project = PathBuf::from(&record.project_path);
    if project.exists() { project } else { PathBuf::from(&record.repo_common_dir) }
}

/// True only when `path` definitely does not exist; an unreadable location is not "gone".
pub(crate) fn is_gone(path: &Path) -> bool {
    match std::fs::symlink_metadata(path) {
        Ok(_) => false,
        Err(error) => matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory),
    }
}

/// A linked-worktree admin dir with the checkout its `gitdir` points at.
#[derive(Clone, Debug)]
pub(crate) struct AdminRegistration {
    pub admin: PathBuf,
    pub worktree_path: PathBuf,
}

/// The repository's `<common dir>/worktrees/<name>` admin dirs; unreadable ones are skipped.
pub(crate) fn admin_registrations(common_dir: &Path) -> Vec<AdminRegistration> {
    let root = common_dir.join("worktrees");
    let Ok(names) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut out = Vec::new();
    for name in names.filter_map(|e| e.ok()) {
        let admin = name.path();
        let Ok(text) = std::fs::read_to_string(admin.join("gitdir")) else { continue };
        let gitdir = text.lines().next().unwrap_or("").trim().to_owned();
        if gitdir.is_empty() {
            continue;
        }
        let worktree_path = Path::new(&gitdir).parent().map(Path::to_path_buf).unwrap_or_default();
        out.push(AdminRegistration { admin, worktree_path });
    }
    out
}

/// Drops the git admin dir of a registration whose checkout is definitely gone. A `locked`
/// registration stays unless `allow_locked`.
pub(crate) fn prune_registration(common_dir: &Path, worktree_path: &Path, allow_locked: bool) -> bool {
    if !is_gone(worktree_path) {
        return false;
    }
    let mut pruned = false;
    for registration in admin_registrations(common_dir) {
        if path_key(&registration.worktree_path) != path_key(worktree_path) {
            continue;
        }
        if !allow_locked && !is_gone(&registration.admin.join("locked")) {
            continue;
        }
        if std::fs::remove_dir_all(&registration.admin).is_ok() {
            pruned = true;
        }
    }
    pruned
}

/// Recursive delete with the retries a busy Windows folder needs. The error text, if it stays.
pub(crate) fn remove_tree(path: &Path) -> Option<String> {
    let mut last = None;
    for attempt in 0..=REMOVE_RETRIES {
        match std::fs::remove_dir_all(path) {
            Ok(()) => return None,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
            Err(error) => last = Some(error.to_string()),
        }
        if attempt < REMOVE_RETRIES {
            std::thread::sleep(REMOVE_RETRY_DELAY);
        }
    }
    last
}

/// After the last worktree of a repository is gone, its empty store folder goes (rmdir only,
/// so another checkout or owner lease keeps it).
pub(crate) fn prune_empty_root(root: &Path) {
    for dir in [root.join(".owners"), root.to_path_buf()] {
        let _ = std::fs::remove_dir(dir);
    }
}

fn resolved_text(path: &Path) -> String {
    path.components().collect::<PathBuf>().to_string_lossy().into_owned()
}

/// What the file host does under [`Worktrees::with_recovery_store`]; write and restore need a
/// ready checkout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecoveryAction {
    Write,
    Restore,
    Inspect,
    Discard,
}

struct Scope {
    root: PathBuf,
    directory: PathBuf,
}

/// The record's editor-recovery store descriptors, validated; `None` when one is malformed.
fn recovery_scopes(record: &WorktreeRecord) -> Option<Vec<Scope>> {
    let Some(stores) = record.extra.get("editorRecoveryStores") else { return Some(Vec::new()) };
    let list = stores.as_array().filter(|list| list.len() <= 64)?;
    let checkout = PathBuf::from(&record.path);
    let mut scopes = Vec::new();
    for item in list {
        let root = PathBuf::from(item.get("root")?.as_str()?);
        let directory = PathBuf::from(item.get("directory")?.as_str()?);
        let digest: String = Sha256::digest(resolved_text(&root).as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        let valid = root.is_absolute()
            && directory.is_absolute()
            && mixdog_workspace::pathguard::is_within(&checkout, &root)
            && directory.parent().and_then(Path::file_name).is_some_and(|n| n == EDITOR_RECOVERY)
            && directory.file_name().is_some_and(|n| *n == *digest);
        if !valid {
            return None;
        }
        scopes.push(Scope { root, directory });
    }
    Some(scopes)
}

/// A store is empty when every existing ancestor is a plain directory and nothing is in it;
/// anything unreadable or unknown is retained.
fn store_is_empty(scope: &Scope) -> bool {
    let Some(parent) = scope.directory.parent() else { return false };
    let chain = [parent.parent(), Some(parent), Some(scope.directory.as_path())];
    for directory in chain.into_iter().flatten() {
        match std::fs::symlink_metadata(directory) {
            Ok(info) => {
                let real = mixdog_workspace::pathguard::canonical(directory).ok();
                if !info.is_dir() || info.file_type().is_symlink() || real.as_deref().map(resolved_text) != Some(resolved_text(directory)) {
                    return false;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
    }
    match std::fs::read_dir(&scope.directory) {
        Ok(mut entries) => entries.next().is_none(),
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// The first retained store's root, `Err(path)` of the record when its descriptors are malformed.
fn retained_store(record: &WorktreeRecord) -> Option<String> {
    match recovery_scopes(record) {
        None => Some(record.path.clone()),
        Some(scopes) => scopes.iter().find(|scope| !store_is_empty(scope)).map(|scope| scope.root.to_string_lossy().into_owned()),
    }
}

fn links_to_directory(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(info) => info.is_dir(),
        // Dangling: nothing to descend into.
        Err(error) => !matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory),
    }
}

/// The directory links in the checkout that the ledger does not know, or why it cannot tell.
fn unrecorded_links(record: &WorktreeRecord) -> Result<Vec<String>, (&'static str, String)> {
    let recorded: std::collections::HashSet<String> =
        include::ledger_of(record).iter().filter(|item| item.mode == "link").map(|item| path_key(Path::new(&item.path))).collect();
    let base = PathBuf::from(&record.path);
    let mut found = Vec::new();
    let mut pending = vec![base.clone()];
    let mut scanned = 0usize;
    while let Some(dir) = pending.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err((
                    "unreadable",
                    format!("The worktree folder could not be checked for links ({error}); nothing was deleted."),
                ));
            }
        };
        for entry in entries.filter_map(|e| e.ok()) {
            scanned += 1;
            mixdog_rt::job_progress();
            if scanned > LINK_SCAN_LIMIT {
                return Err((
                    "too-many-entries",
                    format!("The worktree folder has more than {LINK_SCAN_LIMIT} entries to check for links; nothing was deleted."),
                ));
            }
            if entry.file_name().to_string_lossy().eq_ignore_ascii_case(".git") {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            // A junction is a link here too (a reparse point), so it is never descended.
            let link = meta.file_type().is_symlink() || include::is_junction(&meta);
            if link {
                if !recorded.contains(&path_key(&path)) && links_to_directory(&path) {
                    let rel = path.strip_prefix(&base).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                    found.push(rel);
                }
            } else if meta.is_dir() {
                pending.push(path);
            }
        }
    }
    Ok(found)
}

impl Worktrees {
    /// git's registration of the record's checkout, if any.
    pub(crate) async fn registration_for(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<Option<GitWorktree>, ScmFailure> {
        let wanted = path_key(Path::new(&record.path));
        Ok(self
            .list_git_worktrees(&repo_cwd(record), cancel)
            .await?
            .into_iter()
            .find(|row| path_key(Path::new(&row.path)) == wanted))
    }

    pub(crate) async fn prune_registration(&self, record: &WorktreeRecord, allow_locked: bool, cancel: &CancellationToken) -> Result<bool, ScmFailure> {
        let (common, path) = (PathBuf::from(&record.repo_common_dir), PathBuf::from(&record.path));
        on_lane(self.scm().lane, cancel, move || prune_registration(&common, &path, allow_locked)).await
    }

    pub(crate) async fn remove_tree(&self, path: &Path, cancel: &CancellationToken) -> Result<Option<String>, ScmFailure> {
        let path = path.to_path_buf();
        on_lane(self.scm().lane, cancel, move || remove_tree(&path)).await
    }

    pub(crate) async fn prune_empty_repo_root(&self, repo_common_dir: &str, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let key = path_key(Path::new(repo_common_dir));
        if self.all_records(cancel).await?.iter().any(|r| path_key(Path::new(&r.repo_common_dir)) == key) {
            return Ok(());
        }
        let root = crate::worktree::names::managed_root(self.data_dir(), Path::new(repo_common_dir));
        on_lane(self.scm().lane, cancel, move || prune_empty_root(&root)).await
    }

    /// File-host seam (Node `withWorktreeRecoveryStore`): records the host-owned journal scope
    /// on the worktree containing `root` before the journal is prepared, and holds the
    /// repository lock every removal takes through `run`. The descriptor survives daemon exit
    /// and startup reconcile. A root outside any managed checkout runs as an ordinary project,
    /// unless it lies in the managed store itself (a checkout that vanished).
    pub async fn with_recovery_store<T, F, Fut>(&self, root: &Path, directory: &Path, action: RecoveryAction, run: F, cancel: &CancellationToken) -> Result<T, ScmFailure>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, ScmFailure>>,
    {
        let contained = self.all_records(cancel).await?.into_iter().find(|r| mixdog_workspace::pathguard::is_within(Path::new(&r.path), root));
        let Some(entry) = contained else {
            let (store, wanted) = (self.data_dir().join(crate::worktree::registry::STORE_DIR), root.to_path_buf());
            let inside = on_lane(self.scm().lane, cancel, move || {
                let canonical = mixdog_workspace::pathguard::canonical(&store).ok();
                [Some(store), canonical].into_iter().flatten().any(|s| mixdog_workspace::pathguard::is_within(&s, &wanted))
            })
            .await?;
            if inside {
                return Err(errors::missing(None, None, Some(root.to_string_lossy().into_owned())));
            }
            return run().await;
        };
        let opened = self.scm().open(&repo_cwd(&entry), cancel).await?;
        let _lock = opened.lock_repository().await?;
        let needs_ready = matches!(action, RecoveryAction::Write | RecoveryAction::Restore);
        let Some(mut record) = self.record(cancel, &entry.id).await?.filter(|r| !(needs_ready && r.state != "ready")) else {
            return Err(errors::missing(Some(entry.id.clone()), None, None));
        };
        let descriptor = serde_json::json!({ "root": root, "directory": directory });
        let mut probe = record.clone();
        probe.extra.insert("editorRecoveryStores".into(), serde_json::json!([descriptor]));
        let unusable = || errors::file_recovery(record.id.clone(), record.path.clone(), record.path.clone());
        if recovery_scopes(&probe).is_none() {
            return Err(unusable());
        }
        let Some(scopes) = recovery_scopes(&record) else { return Err(unusable()) };
        let known = scopes.iter().any(|s| s.root == root && s.directory == directory);
        if !known {
            let mut stores = record.extra.get("editorRecoveryStores").and_then(|v| v.as_array().cloned()).unwrap_or_default();
            if stores.len() >= 64 {
                // Only descriptors of verifiably empty or missing stores may be pruned.
                let probe = record.clone();
                let kept = on_lane(self.scm().lane, cancel, move || {
                    recovery_scopes(&probe)
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|s| !store_is_empty(s))
                        .map(|s| serde_json::json!({ "root": s.root, "directory": s.directory }))
                        .collect::<Vec<_>>()
                })
                .await?;
                stores = kept;
                if stores.len() >= 64 {
                    return Err(unusable());
                }
            }
            stores.push(descriptor);
            record.extra.insert("editorRecoveryStores".into(), serde_json::Value::Array(stores));
            self.put_record(cancel, record).await?;
        }
        run().await
    }

    /// `WORKTREE_FILE_RECOVERY` while retained editor-recovery records exist (force does not matter).
    pub async fn assert_recovery_stores_clear(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        if record.extra.get("editorRecoveryStores").is_none_or(|v| v.as_array().is_some_and(Vec::is_empty)) {
            return Ok(());
        }
        let probe = record.clone();
        match on_lane(self.scm().lane, cancel, move || retained_store(&probe)).await? {
            Some(root) => Err(errors::file_recovery(record.id.clone(), record.path.clone(), root)),
            None => Ok(()),
        }
    }

    /// Refuses a checkout holding a directory link the ledger did not make: `git worktree
    /// remove` can descend through one on Windows and delete its target's files.
    pub(crate) async fn assert_no_unrecorded_links(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let probe = record.clone();
        let scan = on_lane(self.scm().lane, cancel, move || unrecorded_links(&probe)).await?;
        match scan {
            Err((reason, message)) => Err(errors::path_unsafe_with(record.id.clone(), record.path.clone(), reason, message, None)),
            Ok(found) if found.is_empty() => Ok(()),
            Ok(found) => {
                let shown: Vec<String> = found.iter().take(10).cloned().collect();
                let message = format!(
                    "The worktree contains linked folders it did not create ({}{}). Removing the folder could delete their targets: remove those links (not their targets) first; nothing was deleted.",
                    shown.join(", "),
                    if found.len() > 10 { ", …" } else { "" }
                );
                let count = found.len() as u64;
                Err(errors::path_unsafe_with(
                    record.id.clone(),
                    record.path.clone(),
                    "unrecorded-links",
                    message,
                    Some((found.into_iter().take(50).collect(), count)),
                ))
            }
        }
    }
}

/// `{kind, path?, error?}` as the records keep what a removal left behind.
pub(crate) fn remnant(kind: &str, path: Option<&str>, error: Option<&str>) -> RemovalRemnant {
    RemovalRemnant { kind: kind.into(), path: path.map(str::to_owned), name: None, error: error.map(str::to_owned) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prune_drops_only_the_admin_dir_of_a_gone_unlocked_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let common = dir.path().join("common");
        let gone = dir.path().join("gone");
        let admin = common.join("worktrees").join("a");
        std::fs::create_dir_all(&admin).unwrap();
        std::fs::write(admin.join("gitdir"), format!("{}\n", gone.join(".git").display())).unwrap();
        std::fs::write(admin.join("locked"), "").unwrap();
        assert!(!prune_registration(&common, &gone, false), "locked stays");
        assert!(prune_registration(&common, &gone, true));
        assert!(!admin.exists());
        std::fs::create_dir_all(&gone).unwrap();
        assert!(!prune_registration(&common, &gone, true), "an existing checkout is never pruned");
    }

    #[test]
    fn an_unrecorded_directory_link_is_found_and_a_recorded_one_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let checkout = dir.path().join("co");
        let target = dir.path().join("target");
        std::fs::create_dir_all(checkout.join("sub")).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        let link = checkout.join("sub").join("deps");
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(&target, &link).is_ok() || std::process::Command::new("cmd").args(["/c", "mklink", "/J"]).arg(&link).arg(&target).output().is_ok_and(|o| o.status.success());
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&target, &link).is_ok();
        assert!(made);
        let mut record = crate::worktree::retention::test_record(&checkout);
        assert_eq!(unrecorded_links(&record).unwrap(), ["sub/deps"]);
        record.extra.insert(
            "resources".into(),
            serde_json::json!({ "includes": [{ "rel": "sub/deps", "path": link.to_string_lossy(), "mode": "link", "status": "created" }] }),
        );
        assert!(unrecorded_links(&record).unwrap().is_empty());
        assert!(std::fs::read_dir(&target).unwrap().next().is_none());
    }

    #[test]
    fn a_store_with_any_entry_is_retained_and_a_missing_one_is_clear() {
        let dir = tempfile::tempdir().unwrap();
        let checkout = dir.path().join("co");
        let root = checkout.join("proj");
        let digest: String = Sha256::digest(resolved_text(&root).as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
        let store = dir.path().join("data").join(EDITOR_RECOVERY).join(digest);
        let mut record = crate::worktree::retention::test_record(&checkout);
        record.extra.insert("editorRecoveryStores".into(), serde_json::json!([{ "root": root, "directory": store }]));
        assert_eq!(retained_store(&record), None);
        std::fs::create_dir_all(&store).unwrap();
        assert_eq!(retained_store(&record), None, "an empty store is clear");
        std::fs::write(store.join("journal"), "x").unwrap();
        assert!(retained_store(&record).is_some());
        record.extra.insert("editorRecoveryStores".into(), serde_json::json!([{ "root": root, "directory": dir.path() }]));
        assert_eq!(retained_store(&record), Some(record.path.clone()), "a malformed descriptor retains");
    }
}
