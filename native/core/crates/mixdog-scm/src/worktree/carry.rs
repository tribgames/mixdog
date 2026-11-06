//! A project checkout's uncommitted changes and their move into a new managed worktree
//! (`create` runs it under the repository lock, before the include entries are copied).
//!
//! One scope everywhere: the whole repository checkout (a project in a subfolder included).
//! Detection, snapshot, apply and clear all cover every tracked and untracked path; only an
//! untracked session identity file (`<project>/.mixdog/project.id`) is left out. Ignored files
//! (dependencies, build output, env files) are never carried: they stay in the project folder.
//!
//! A snapshot is two trees taken through a temporary copy of the index, so the checkout is
//! never touched while it is read: `index` (what is staged) and `tree` (the working tree:
//! tracked changes, deletions and untracked files). The carry, in order:
//!   1. refuse what cannot move faithfully ([`Worktrees::assert_carryable`]);
//!   2. snapshot the project checkout and keep it at a named recovery ref
//!      (`refs/mixdog/carry/<id>-<time>`: a commit of the working tree whose first parent is
//!      HEAD and whose second parent is the commit of the index);
//!   3. write it into the fresh worktree and verify the worktree snapshots identically;
//!   4. re-snapshot the project checkout (unchanged since 2, else refuse), then clear it:
//!      `reset --hard` and delete exactly its untracked files; verify it is clean.
//! A failure restores the project checkout from the snapshot and reports `WORKTREE_DIRTY`
//! (`carry-failed`) with the kept ref. A success returns the ref too: the caller drops it once
//! the whole session move is committed, and restores from it if anything after the carry fails.
//!
//! Sessions are kept out by the caller (the project folder is held and must be quiet), but a
//! process outside Mixdog can still write between the final comparison and the clear; such a
//! write is not captured.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use mixdog_protocol::DirtyFiles;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::git::RunOptions;
use crate::git::nul_records;
use crate::repo::on_lane;
use crate::repo::operation_in_progress;
use crate::repo::operation_verb;
use crate::worktree::errors::DirtyDetail;
use crate::worktree::manager::Worktrees;

const IDENTITY_PATH: &str = ".mixdog/project.id";
const RECOVERY_REF_PREFIX: &str = "refs/mixdog/carry/";
/// Untracked files beyond these limits are refused rather than snapshotted.
const UNTRACKED_MAX_BYTES: u64 = 256 * 1024 * 1024;
const UNTRACKED_MAX_FILES: usize = 10_000;
const CHECK_ATTR_CHUNK: usize = 200;
/// `CE_INTENT_TO_ADD` in an index entry's flags (`git add -N`).
const INTENT_TO_ADD_FLAG: u64 = 0x2000_0000;
/// Recovery commits are Mixdog's own, independent of the user's identity config.
const COMMIT_ENV: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "Mixdog"),
    ("GIT_AUTHOR_EMAIL", "mixdog@localhost"),
    ("GIT_COMMITTER_NAME", "Mixdog"),
    ("GIT_COMMITTER_EMAIL", "mixdog@localhost"),
];

fn identity_path(project_subdir: &str) -> String {
    if project_subdir.is_empty() {
        IDENTITY_PATH.to_owned()
    } else {
        format!("{project_subdir}/{IDENTITY_PATH}")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatusRow {
    pub path: String,
    pub untracked: bool,
    pub unmerged: bool,
    pub submodule: bool,
}

/// `git status --porcelain=v2 -z` rows: path, untracked, unmerged, submodule.
pub fn parse_status_v2(raw: &str) -> Vec<StatusRow> {
    let mut rows = Vec::new();
    let mut fields = nul_records(raw);
    while let Some(field) = fields.next() {
        let kind = field.chars().next().unwrap_or(' ');
        if kind == '?' {
            rows.push(StatusRow { path: field[2..].to_owned(), untracked: true, unmerged: false, submodule: false });
            continue;
        }
        // Leading fields before the path: 1 → 8, 2 → 9 (then the original path), u → 10.
        let lead = match kind {
            '1' => 8,
            '2' => 9,
            'u' => 10,
            _ => continue,
        };
        let parts: Vec<&str> = field.split(' ').collect();
        rows.push(StatusRow {
            path: parts.iter().skip(lead).copied().collect::<Vec<_>>().join(" "),
            untracked: false,
            unmerged: kind == 'u',
            submodule: parts.get(2).is_some_and(|p| p.starts_with('S')),
        });
        if kind == '2' {
            fields.next();
        }
    }
    rows
}

/// One `git status` read of the checkout: the changed rows, their paths, the untracked (not
/// ignored) files (nested repositories end in `/`) and the untracked-and-not-ignored session
/// identity file's path, which is left out of every step.
#[derive(Clone, Debug, Default)]
pub struct Checkout {
    pub rows: Vec<StatusRow>,
    pub files: Vec<String>,
    pub untracked: Vec<String>,
    pub identity: Option<String>,
}

/// The state of one checkout as three trees.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snap {
    pub head: String,
    pub index: String,
    pub tree: String,
}

struct Hidden {
    skip_worktree: Vec<String>,
    assume_unchanged: Vec<String>,
    intent_to_add: Vec<String>,
    sparse: bool,
}

fn refusal(reason: &str, message: &str) -> DirtyDetail {
    DirtyDetail {
        reason: Some(reason.to_owned()),
        cause: Some(format!("{message} Leave the changes in the project folder instead, or fix this and retry.")),
        ..DirtyDetail::default()
    }
}

fn preview(paths: &[String]) -> Option<Vec<String>> {
    Some(paths.iter().take(50).cloned().collect())
}

/// Flags of every entry of `git ls-files --debug -z`: `path NUL stat… flags: <hex> LF <next path>`.
fn intent_to_add_paths(raw: &str) -> Vec<String> {
    let mut found = Vec::new();
    let segments: Vec<&str> = raw.split('\0').collect();
    let Some(first) = segments.first() else { return found };
    let mut path = (*first).to_owned();
    for segment in segments.iter().skip(1) {
        let Some(at) = segment.find("flags: ") else { break };
        let after = &segment[at + "flags: ".len()..];
        let Some(newline) = after.find('\n') else { break };
        let flags = u64::from_str_radix(after[..newline].trim(), 16).unwrap_or(0);
        if flags & INTENT_TO_ADD_FLAG != 0 {
            found.push(path.clone());
        }
        path = after[newline + 1..].to_owned();
    }
    found
}

static NEXT: AtomicU64 = AtomicU64::new(0);

fn temp_suffix() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("mixdog-carry-{}-{nanos}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed))
}

impl Worktrees {
    async fn gtext(&self, cwd: &Path, args: &[&str], options: &RunOptions, cancel: &CancellationToken) -> Result<String, ScmFailure> {
        self.scm().git.text(cancel, cwd, args, options).await
    }

    async fn inspect_checkout(&self, top: &Path, subdir: &str, cancel: &CancellationToken) -> Result<Checkout, ScmFailure> {
        let status = self
            .gtext(top, &["status", "--porcelain=v2", "-z", "--untracked-files=all"], &RunOptions::read(), cancel)
            .await?;
        let identity = identity_path(subdir);
        let all = parse_status_v2(&status);
        let rows: Vec<StatusRow> = all.iter().filter(|r| !(r.untracked && r.path == identity)).cloned().collect();
        Ok(Checkout {
            files: rows.iter().map(|r| r.path.clone()).collect(),
            untracked: rows.iter().filter(|r| r.untracked).map(|r| r.path.clone()).collect(),
            identity: (rows.len() < all.len()).then_some(identity),
            rows,
        })
    }

    /// Uncommitted paths of the whole checkout at `top`: staged, unstaged and untracked;
    /// ignored files and an untracked identity file excluded.
    pub async fn uncommitted_changes(&self, top: &Path, subdir: &str, cancel: &CancellationToken) -> Result<Vec<String>, ScmFailure> {
        Ok(self.inspect_checkout(top, subdir, cancel).await?.files)
    }

    async fn filtered_paths(&self, top: &Path, paths: &[String], cancel: &CancellationToken) -> Result<Vec<String>, ScmFailure> {
        let mut filtered = Vec::new();
        for chunk in paths.chunks(CHECK_ATTR_CHUNK) {
            let mut args = vec!["check-attr", "-z", "filter", "--"];
            args.extend(chunk.iter().map(String::as_str));
            let out = self.gtext(top, &args, &RunOptions::read(), cancel).await?;
            let fields: Vec<&str> = out.split('\0').collect();
            let mut at = 0;
            while at + 2 < fields.len() {
                if !matches!(fields[at + 2], "unspecified" | "unset") {
                    filtered.push(fields[at].to_owned());
                }
                at += 3;
            }
        }
        Ok(filtered)
    }

    /// Index entries git does not look at (their edits are invisible to status, so a carry
    /// would silently drop or leave them), intent-to-add entries, and sparse checkout.
    async fn hidden_index_entries(&self, top: &Path, cancel: &CancellationToken) -> Result<Hidden, ScmFailure> {
        let read = RunOptions::read();
        let (listed, debug) = tokio::try_join!(
            self.gtext(top, &["ls-files", "-v", "-z"], &read, cancel),
            self.gtext(top, &["ls-files", "--debug", "-z"], &read, cancel),
        )?;
        let sparse = self
            .scm()
            .git
            .outcome(cancel, top, &["config", "--type=bool", "--get", "core.sparseCheckout"], &read)
            .await?;
        let (mut skip_worktree, mut assume_unchanged) = (Vec::new(), Vec::new());
        for entry in nul_records(&listed) {
            let mut chars = entry.chars();
            let Some(tag) = chars.next() else { continue };
            let path = entry.get(2..).unwrap_or("").to_owned();
            if tag == 'S' || tag == 's' {
                skip_worktree.push(path);
            } else if tag.is_alphabetic() && tag != tag.to_ascii_uppercase() {
                assume_unchanged.push(path);
            }
        }
        Ok(Hidden {
            skip_worktree,
            assume_unchanged,
            intent_to_add: intent_to_add_paths(&debug),
            sparse: sparse.stdout_text().trim() == "true",
        })
    }

    /// `WORKTREE_DIRTY` (with a `reason`) when the checkout's changes cannot be carried
    /// faithfully. Resolves the status read the checks were made on.
    async fn check_carryable(&self, top: &Path, subdir: &str, cancel: &CancellationToken) -> Result<Checkout, ScmFailure> {
        let identity = self.scm().open(top, cancel).await?.identity;
        let hidden = self.hidden_index_entries(top, cancel).await?;
        let checkout = self.inspect_checkout(top, subdir, cancel).await?;
        if let Some(operation) = operation_in_progress(&identity.git_dir) {
            let verb = operation_verb(operation);
            let mut detail = refusal("operation-in-progress", &format!("A {verb} is in progress in the project folder; finish or abort it first."));
            detail.operation = Some(verb.to_owned());
            return Err(detail.failure());
        }
        if hidden.sparse {
            return Err(refusal("sparse-checkout", "The project folder uses a sparse checkout, which a carry cannot reproduce.").failure());
        }
        if !hidden.skip_worktree.is_empty() {
            let mut detail = refusal("skip-worktree", "Files marked skip-worktree have changes git does not see, so they cannot be carried.");
            detail.paths = preview(&hidden.skip_worktree);
            return Err(detail.failure());
        }
        if !hidden.assume_unchanged.is_empty() {
            let mut detail = refusal("assume-unchanged", "Files marked assume-unchanged have changes git does not see, so they cannot be carried.");
            detail.paths = preview(&hidden.assume_unchanged);
            return Err(detail.failure());
        }
        if checkout.rows.iter().any(|r| r.unmerged) {
            return Err(refusal("unmerged-paths", "The project folder has unresolved merge conflicts; resolve them first.").failure());
        }
        let submodules: Vec<String> = checkout.rows.iter().filter(|r| r.submodule).map(|r| r.path.clone()).collect();
        if !submodules.is_empty() {
            let mut detail = refusal("dirty-submodules", "Submodules with changes cannot be carried; commit or reset them first.");
            detail.paths = preview(&submodules);
            return Err(detail.failure());
        }
        if !hidden.intent_to_add.is_empty() {
            let mut detail = refusal(
                "intent-to-add",
                "Files added with \"git add -N\" (intent to add) cannot be carried; stage or unstage them first.",
            );
            detail.paths = preview(&hidden.intent_to_add);
            return Err(detail.failure());
        }
        let nested: Vec<String> = checkout.untracked.iter().filter(|p| p.ends_with('/')).cloned().collect();
        if !nested.is_empty() {
            let mut detail = refusal("nested-repository", "The project folder has untracked nested repositories, which cannot be carried.");
            detail.paths = preview(&nested);
            return Err(detail.failure());
        }
        if checkout.untracked.len() > UNTRACKED_MAX_FILES {
            let mut detail = refusal(
                "too-large",
                &format!(
                    "The project folder has {} untracked files (limit {UNTRACKED_MAX_FILES}); add generated output to .gitignore first.",
                    checkout.untracked.len()
                ),
            );
            detail.files = Some(DirtyFiles::Count(checkout.untracked.len() as u64));
            detail.max_files = Some(UNTRACKED_MAX_FILES as u64);
            return Err(detail.failure());
        }
        let (root, untracked) = (top.to_path_buf(), checkout.untracked.clone());
        let over = on_lane(self.scm().lane, cancel, move || {
            let mut bytes = 0u64;
            for rel in &untracked {
                bytes += std::fs::symlink_metadata(rel.split('/').fold(root.clone(), |p, s| p.join(s))).map_or(0, |m| m.len());
                if bytes > UNTRACKED_MAX_BYTES {
                    return true;
                }
            }
            false
        })
        .await?;
        if over {
            let mut detail = refusal(
                "too-large",
                &format!(
                    "The project folder's untracked files exceed {} MB; add large or generated files to .gitignore first.",
                    UNTRACKED_MAX_BYTES / 1_048_576
                ),
            );
            detail.max_bytes = Some(UNTRACKED_MAX_BYTES);
            return Err(detail.failure());
        }
        let filtered = self.filtered_paths(top, &checkout.files, cancel).await?;
        if !filtered.is_empty() {
            let mut detail = refusal("filtered-paths", "Changed files use a git filter (such as Git LFS), which a carry cannot reproduce exactly.");
            detail.paths = preview(&filtered);
            return Err(detail.failure());
        }
        Ok(checkout)
    }

    /// The checkout's uncommitted paths, or the refusal that says why they cannot be carried.
    pub async fn assert_carryable(&self, top: &Path, subdir: &str, cancel: &CancellationToken) -> Result<Vec<String>, ScmFailure> {
        Ok(self.check_carryable(top, subdir, cancel).await?.files)
    }

    async fn write_tree_with(&self, cwd: &Path, index: &Path, cancel: &CancellationToken) -> Result<String, ScmFailure> {
        let options = RunOptions { index_file: Some(index.to_path_buf()), ..RunOptions::default() };
        Ok(self.gtext(cwd, &["write-tree"], &options, cancel).await?.trim().to_owned())
    }

    /// `{head, index, tree}` of the checkout at `cwd`, read through temporary copies of its
    /// index: the live index is copied once, and two duplicates of that capture (one stays as
    /// staged, one takes `add --all`) are what git works on side by side.
    async fn checkout_snapshot(&self, cwd: &Path, identity: Option<&str>, cancel: &CancellationToken) -> Result<Snap, ScmFailure> {
        let paths = self
            .gtext(cwd, &["rev-parse", "--path-format=absolute", "HEAD^{commit}", "--git-path", "index"], &RunOptions::default(), cancel)
            .await?;
        let mut lines = paths.lines().map(str::trim);
        let head = lines.next().unwrap_or("").to_owned();
        let index_file = PathBuf::from(lines.next().unwrap_or(""));
        let base = format!("{}.{}", index_file.display(), temp_suffix());
        let (captured, staged, tree_index) = (
            PathBuf::from(format!("{base}-captured")),
            PathBuf::from(format!("{base}-staged")),
            PathBuf::from(format!("{base}-tree")),
        );
        let built = async {
            // The live index is read once; both working copies come from that capture.
            let (live, to) = (index_file.clone(), captured.clone());
            let copied = on_lane(self.scm().lane, cancel, move || if live.exists() { std::fs::copy(&live, &to).map(drop).map(|()| true) } else { Ok(false) }).await??;
            if !copied {
                let options = RunOptions { index_file: Some(captured.clone()), ..RunOptions::default() };
                self.gtext(cwd, &["read-tree", &head], &options, cancel).await?;
            }
            let (from, a, b) = (captured.clone(), staged.clone(), tree_index.clone());
            on_lane(self.scm().lane, cancel, move || std::fs::copy(&from, &a).and_then(|_| std::fs::copy(&from, &b)).map(drop)).await??;
            let exclude = identity.map(|path| format!(":(exclude,literal){path}"));
            let tree_options = RunOptions { index_file: Some(tree_index.clone()), ..RunOptions::default() };
            let mut add = vec!["add", "--all", "--", "."];
            if let Some(exclude) = &exclude {
                add.push(exclude);
            }
            let (index, tree) = tokio::try_join!(self.write_tree_with(cwd, &staged, cancel), async {
                self.gtext(cwd, &add, &tree_options, cancel).await?;
                self.write_tree_with(cwd, &tree_index, cancel).await
            })?;
            Ok::<_, ScmFailure>(Snap { head: head.clone(), index, tree })
        }
        .await;
        let leftovers = [captured, staged, tree_index];
        let _ = on_lane(self.scm().lane, cancel, move || {
            for file in leftovers {
                let _ = std::fs::remove_file(&file);
                let _ = std::fs::remove_file(format!("{}.lock", file.display()));
            }
        })
        .await;
        built
    }

    async fn keep_recovery_ref(&self, cwd: &Path, snap: &Snap, label: &str, cancel: &CancellationToken) -> Result<String, ScmFailure> {
        let options = RunOptions {
            extra_env: COMMIT_ENV.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect(),
            ..RunOptions::default()
        };
        let commit = |tree: String, parents: Vec<String>, message: String| {
            let options = options.clone();
            async move {
                let mut args: Vec<String> = vec!["commit-tree".into(), tree];
                for parent in parents {
                    args.extend(["-p".to_owned(), parent]);
                }
                args.extend(["-m".to_owned(), message]);
                let refs: Vec<&str> = args.iter().map(String::as_str).collect();
                Ok::<_, ScmFailure>(self.gtext(cwd, &refs, &options, cancel).await?.trim().to_owned())
            }
        };
        let index_commit = commit(snap.index.clone(), vec![snap.head.clone()], format!("mixdog: staged changes carried into worktree {label}")).await?;
        let state_commit = commit(
            snap.tree.clone(),
            vec![snap.head.clone(), index_commit],
            format!("mixdog: uncommitted changes (untracked included) carried into worktree {label}"),
        )
        .await?;
        let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
        let reference = format!("{RECOVERY_REF_PREFIX}{label}-{millis}");
        self.gtext(cwd, &["update-ref", "-m", &format!("mixdog: carry into worktree {label}"), &reference, &state_commit], &RunOptions::default(), cancel)
            .await?;
        Ok(reference)
    }

    /// Makes the checkout at `cwd` (index and files) exactly `snap`; HEAD stays.
    async fn write_snapshot(&self, cwd: &Path, snap: &Snap, reset: bool, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        let plain = RunOptions::default();
        if reset {
            self.gtext(cwd, &["read-tree", "--reset", "-u", &snap.tree], &plain, cancel).await?;
        } else {
            self.gtext(cwd, &["read-tree", "-u", "-m", &snap.head, &snap.tree], &plain, cancel).await?;
        }
        // The index now equals the working tree; moving it on to the staged state as a two-tree
        // switch (-i: files are already as wanted) keeps the stat data of every entry that
        // does not change.
        self.gtext(cwd, &["read-tree", "-m", "-i", &snap.tree, &snap.index], &plain, cancel).await?;
        Ok(())
    }

    /// Restores `snap` into the project checkout; `None` once it snapshots exactly as `snap`.
    async fn restore_snapshot(&self, top: &Path, identity: Option<&str>, snap: &Snap, cancel: &CancellationToken) -> Option<String> {
        let failure = self.write_snapshot(top, snap, true, cancel).await.err();
        // A clear that failed before changing anything needs no restore at all.
        if self.checkout_snapshot(top, identity, cancel).await.ok().as_ref() == Some(snap) {
            return None;
        }
        Some(failure.map_or_else(|| "the project folder does not match the snapshot after the restore".to_owned(), |f| f.to_string()))
    }

    /// Tracked files back to HEAD, then exactly `untracked` deleted (and the folders they leave empty).
    async fn clear_checkout(&self, top: &Path, untracked: &[String], cancel: &CancellationToken) -> Result<(), ScmFailure> {
        self.gtext(top, &["reset", "--hard", "--quiet", "HEAD"], &RunOptions::default(), cancel).await?;
        let (root, files) = (top.to_path_buf(), untracked.to_vec());
        on_lane(self.scm().lane, cancel, move || {
            let mut folders: Vec<PathBuf> = Vec::new();
            for rel in &files {
                let path = rel.split('/').fold(root.clone(), |p, s| p.join(s));
                let _ = std::fs::remove_file(&path);
                let mut dir = path.parent().map(Path::to_path_buf);
                while let Some(current) = dir {
                    if current.as_os_str().len() <= root.as_os_str().len() || !current.starts_with(&root) {
                        break;
                    }
                    if !folders.contains(&current) {
                        folders.push(current.clone());
                    }
                    dir = current.parent().map(Path::to_path_buf);
                }
            }
            folders.sort_by_key(|f| std::cmp::Reverse(f.as_os_str().len()));
            for dir in folders {
                let _ = std::fs::remove_dir(dir);
            }
        })
        .await?;
        Ok(())
    }

    fn recovery_hint(reference: &str) -> String {
        format!("\"git read-tree --reset -u {reference}\" then \"git read-tree {reference}^2\" (the staged state)")
    }

    /// Moves the uncommitted changes of the project checkout at `top` into the fresh worktree
    /// at `worktree_path` (a checkout of `base_commit`). Nothing to move resolves
    /// `(0, None)` without touching either. On success the recovery ref is kept for the caller.
    pub async fn carry_uncommitted_changes(
        &self,
        top: &Path,
        subdir: &str,
        worktree_path: &Path,
        base_commit: &str,
        label: &str,
        cancel: &CancellationToken,
    ) -> Result<(usize, Option<String>), ScmFailure> {
        // Checked again right before acting (the worktree took a while to create).
        let checkout = self.check_carryable(top, subdir, cancel).await?;
        if checkout.files.is_empty() {
            return Ok((0, None));
        }
        let identity = checkout.identity.clone();
        let snap = self.checkout_snapshot(top, identity.as_deref(), cancel).await?;
        if snap.head != base_commit {
            let mut detail = refusal("head-moved", "The project folder moved to another commit while the worktree was created.");
            detail.head = Some(snap.head.clone());
            detail.base_commit = Some(base_commit.to_owned());
            return Err(detail.failure());
        }
        // The recovery ref is written before anything in the project folder is touched.
        let reference = self.keep_recovery_ref(top, &snap, label, cancel).await?;
        let mut touched = false;
        let moved: Result<(), String> = async {
            self.write_snapshot(worktree_path, &snap, false, cancel).await.map_err(|e| e.to_string())?;
            if self.checkout_snapshot(worktree_path, identity.as_deref(), cancel).await.map_err(|e| e.to_string())? != snap {
                return Err("the worktree does not match the project folder after the changes were applied".into());
            }
            if self.checkout_snapshot(top, identity.as_deref(), cancel).await.map_err(|e| e.to_string())? != snap {
                return Err("the project folder changed while its changes were being moved".into());
            }
            touched = true;
            self.clear_checkout(top, &checkout.untracked, cancel).await.map_err(|e| e.to_string())?;
            let left = self.inspect_checkout(top, subdir, cancel).await.map_err(|e| e.to_string())?.files;
            if !left.is_empty() {
                return Err(format!("{} changed path(s) could not be cleared from the project folder", left.len()));
            }
            Ok(())
        }
        .await;
        if let Err(cause) = moved {
            let restore_error = if touched { self.restore_snapshot(top, identity.as_deref(), &snap, cancel).await } else { None };
            return Err(DirtyDetail {
                reason: Some("carry-failed".into()),
                recovery_ref: Some(reference),
                restored: Some(restore_error.is_none()),
                count: Some(checkout.files.len() as u64),
                cause: Some(cause),
                restore_error,
                ..DirtyDetail::default()
            }
            .failure());
        }
        Ok((checkout.files.len(), Some(reference)))
    }

    fn assert_recovery_ref(reference: &str) -> Result<(), ScmFailure> {
        if reference.starts_with(RECOVERY_REF_PREFIX) && !reference.contains("..") {
            Ok(())
        } else {
            Err(ScmFailure::invalid("recoveryRef", "a mixdog carry ref"))
        }
    }

    /// Puts the changes kept at `reference` back into the project checkout after a carry whose
    /// session move failed later. Only a checkout still clean and on the ref's base commit is
    /// restored (nothing there can be overwritten); otherwise `carry-restore-refused` and the
    /// ref stays.
    pub async fn restore_from_recovery_ref(&self, top: &Path, subdir: &str, reference: &str, cancel: &CancellationToken) -> Result<String, ScmFailure> {
        Self::assert_recovery_ref(reference)?;
        let rev = |spec: String| async move { Ok::<_, ScmFailure>(self.gtext(top, &["rev-parse", "--verify", &spec], &RunOptions::default(), cancel).await?.trim().to_owned()) };
        let snap = Snap {
            head: rev(format!("{reference}^1")).await?,
            index: rev(format!("{reference}^2^{{tree}}")).await?,
            tree: rev(format!("{reference}^{{tree}}")).await?,
        };
        let head = rev("HEAD^{commit}".into()).await?;
        let checkout = self.inspect_checkout(top, subdir, cancel).await?;
        if head != snap.head || !checkout.files.is_empty() {
            return Err(DirtyDetail {
                reason: Some("carry-restore-refused".into()),
                recovery_ref: Some(reference.to_owned()),
                count: Some(checkout.files.len() as u64),
                cause: Some(format!(
                    "The carried changes could not be put back: the project folder changed meanwhile. Recover them with {}.",
                    Self::recovery_hint(reference)
                )),
                ..DirtyDetail::default()
            }
            .failure());
        }
        if let Some(failure) = self.restore_snapshot(top, checkout.identity.as_deref(), &snap, cancel).await {
            return Err(DirtyDetail {
                reason: Some("carry-restore-failed".into()),
                recovery_ref: Some(reference.to_owned()),
                cause: Some(format!("The carried changes could not be put back ({failure}). Recover them with {}.", Self::recovery_hint(reference))),
                ..DirtyDetail::default()
            }
            .failure());
        }
        Ok(reference.to_owned())
    }

    /// Forgets a carry's recovery ref once the move it protected is committed.
    pub async fn drop_recovery_ref(&self, top: &Path, reference: &str, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        Self::assert_recovery_ref(reference)?;
        self.scm().git.outcome(cancel, top, &["update-ref", "-d", reference], &RunOptions::default()).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_v2_rows_know_untracked_unmerged_and_submodules() {
        let rows = parse_status_v2(
            "1 .M N... 100644 100644 100644 a b src/a b.txt\02 R. N... 100644 100644 100644 a b R100 new.txt\0old.txt\0u UU N... 100644 100644 100644 100644 a b c conflict.txt\01 .M S.M. 160000 160000 160000 a b sub\0? new.bin\0",
        );
        let paths: Vec<_> = rows.iter().map(|r| r.path.as_str()).collect();
        assert_eq!(paths, ["src/a b.txt", "new.txt", "conflict.txt", "sub", "new.bin"]);
        assert!(rows[2].unmerged && rows[3].submodule && rows[4].untracked);
    }

    #[test]
    fn intent_to_add_is_read_from_the_index_entry_flags() {
        let debug = "a.txt\0  ctime: 0:0\n  flags: 0\nb.txt\0  ctime: 0:0\n  flags: 20000000\n";
        assert_eq!(intent_to_add_paths(debug), ["b.txt"]);
    }
}
