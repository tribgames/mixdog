//! "Commit the selected files", assembled in a scratch index instead of the user's. The commit
//! is built from HEAD plus the work-tree content of the selected paths in a throwaway index
//! file outside the repository (`GIT_INDEX_FILE`), and the only write to the user's index
//! happens after the commit object exists and the branch has moved. In order:
//!
//! 1. resolve the selection against status, the index and the repository's own path list;
//! 2. `read-tree HEAD` and `add --all --force -- <selection>` into the scratch index;
//! 3. `pre-commit`, then the message hooks through `COMMIT_EDITMSG`, then message cleanup;
//! 4. `write-tree`, refuse a tree that carries paths outside the selection;
//! 5. `commit-tree`, then `update-ref HEAD <new> <old>` (compare-and-swap);
//! 6. `post-commit`, then `reset -- <paths>` on the user's index for the committed paths that
//!    still are what the commit was built from.
//!
//! Everything before step 5's `update-ref` touches only the scratch index and the object
//! database, so an interrupted run leaves the index, HEAD and every ref as they were: there is
//! nothing to journal. The index itself is only ever written by git (`reset`, under git's own
//! `index.lock`), never by this code.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use crate::engine::Repo;
use crate::error::ScmFailure;
use crate::git::RunOptions;
use crate::git::nul_records;
use crate::inspect::status::GitFileEntry;
use crate::repo::on_lane;

/// The hooks git runs for `commit -m`, in git's own order.
const COMMIT_HOOKS: [&str; 4] = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"];
const CLEANUP_MODES: [&str; 5] = ["strip", "whitespace", "verbatim", "scissors", "default"];

fn literal(path: &str) -> String {
    format!(":(literal){path}")
}

fn comparable(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if cfg!(windows) {
        normalized.to_lowercase()
    } else {
        normalized
    }
}

fn assert_commit_path(path: &str) -> Result<(), ScmFailure> {
    // Argument-injection guard on the caller's exact bytes: a pathspec may never read as an
    // option, an absolute or drive path, a traversal, or a NUL-spliced value.
    let drive = path.len() >= 3
        && path.as_bytes()[0].is_ascii_alphabetic()
        && path.as_bytes()[1] == b':'
        && matches!(path.as_bytes()[2], b'/' | b'\\');
    if path.starts_with('-')
        || path.contains('\0')
        || path.starts_with(['/', '\\'])
        || Path::new(path).is_absolute()
        || drive
        || path.split(['/', '\\']).any(|part| part == "..")
    {
        return Err(ScmFailure::invalid("paths", format!("a repository-relative path, not {path}")));
    }
    Ok(())
}

fn within_selection(prefixes: &[String], path: &str) -> bool {
    let value = comparable(path);
    prefixes
        .iter()
        .any(|prefix| value == *prefix || value.starts_with(&format!("{prefix}/")))
}

fn outside(prefixes: &[String], paths: impl IntoIterator<Item = String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| !within_selection(prefixes, path))
        .collect()
}

fn listed(paths: &[String]) -> String {
    paths.iter().take(10).cloned().collect::<Vec<_>>().join(", ")
}

/// The scratch directory, removed when the transaction ends however it ends.
struct Scratch(PathBuf);

impl Scratch {
    fn create(base: &Path) -> Result<Self, ScmFailure> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let path = base.join(format!(
            "commit-{}-{nanos}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path)?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl Repo {
    /// Every entry of the user's index: path → "<mode> <object> <stage>".
    async fn index_snapshot(&self) -> Result<HashMap<String, String>, ScmFailure> {
        let raw = self.run(&["ls-files", "--stage", "-z"]).await?;
        Ok(nul_records(&raw)
            .filter_map(|record| {
                let tab = record.find('\t')?;
                Some((record[tab + 1..].to_owned(), record[..tab].to_owned()))
            })
            .collect())
    }

    async fn in_index(&self, path: &str) -> Result<bool, ScmFailure> {
        let spec = literal(path);
        self.succeeds(&["ls-files", "--error-unmatch", "--", &spec]).await
    }

    async fn in_head(&self, path: &str) -> Result<bool, ScmFailure> {
        let spec = literal(path);
        let output = self
            .scm
            .git
            .outcome(
                &self.cancel,
                self.root()?,
                &["ls-tree", "-r", "--name-only", "HEAD", "--", &spec],
                &RunOptions::default(),
            )
            .await?;
        Ok(output.success() && !output.stdout_text().trim().is_empty())
    }

    fn inside_worktree(&self, path: &str) -> Result<bool, ScmFailure> {
        let root = self.root()?;
        let absolute = root.join(path);
        // Only the lexical shape: `..` was refused at the door.
        Ok(absolute.starts_with(root) && absolute.exists())
    }

    /// Commits `paths` with `message`; the result is git's one-line summary.
    pub async fn commit_paths(&self, message: &str, paths: &[String]) -> Result<String, ScmFailure> {
        if message.trim().is_empty() {
            return Err(ScmFailure::invalid("message", "a commit message"));
        }
        let requested: Vec<&String> = paths.iter().filter(|path| !path.is_empty()).collect();
        if requested.is_empty() {
            return Err(ScmFailure::invalid("paths", "at least one file to commit"));
        }
        for path in &requested {
            assert_commit_path(path)?;
        }
        let _scope = self.write_scope().await?;
        let specs = self.resolve_selection(&requested).await?;
        let mut addable = Vec::new();
        for spec in &specs {
            if self.inside_worktree(spec)? || self.in_head(spec).await? {
                addable.push(spec.clone());
            } else if !self.in_index(spec).await? {
                return Err(not_in_repository(&[spec.clone()]));
            }
        }
        self.commit_through_scratch_index(message, &specs, &addable).await
    }

    /// Lines the caller's input up against the repository's own path list instead of
    /// rewriting the string, and refuses what matches nothing or more than one entry.
    async fn resolve_selection(&self, requested: &[&String]) -> Result<Vec<String>, ScmFailure> {
        let scan = self
            .scm
            .inspector
            .scan(self.scm.lane, {
                self.touched();
                self.repo_ref()?
            })
            .await
            .map_err(crate::mutate::scm_error)?;
        let mut entries: HashMap<&str, &GitFileEntry> = HashMap::new();
        for file in &scan.json.files {
            entries.insert(&file.path, file);
            if let Some(old) = &file.old_path {
                entries.insert(old, file);
            }
        }
        let mut candidates: Option<Vec<String>> = None;
        let mut selected: Vec<(String, Option<&GitFileEntry>)> = Vec::new();
        let (mut unknown, mut ambiguous) = (Vec::new(), Vec::new());
        for raw in requested {
            let mut matched = String::new();
            if entries.contains_key(raw.as_str()) || self.in_index(raw).await? {
                matched = (*raw).clone();
            }
            if matched.is_empty() {
                if candidates.is_none() {
                    let mut all = self.ls_files(&[]).await?;
                    all.extend(entries.keys().map(|key| (*key).to_owned()));
                    candidates = Some(all);
                }
                let wanted = comparable(raw);
                let found: HashSet<&String> = candidates
                    .as_ref()
                    .into_iter()
                    .flatten()
                    .filter(|candidate| comparable(candidate) == wanted)
                    .collect();
                match found.len() {
                    0 => {}
                    1 => matched = found.into_iter().next().cloned().unwrap_or_default(),
                    _ => {
                        ambiguous.push((*raw).clone());
                        continue;
                    }
                }
            }
            if matched.is_empty() && self.inside_worktree(raw)? {
                matched = (*raw).clone();
            }
            if matched.is_empty() {
                unknown.push((*raw).clone());
                continue;
            }
            let entry = entries.get(matched.as_str()).copied();
            selected.push((matched, entry));
        }
        if !unknown.is_empty() {
            return Err(not_in_repository(&unknown));
        }
        if !ambiguous.is_empty() {
            return Err(ScmFailure::refused(
                "PATH_AMBIGUOUS",
                format!(
                    "More than one file matches {}. Select it again from Source Control.",
                    listed(&ambiguous)
                ),
            ));
        }
        let conflicted: Vec<String> = selected
            .iter()
            .filter_map(|(_, entry)| entry.filter(|e| e.conflicted).map(|e| e.path.clone()))
            .collect();
        if !conflicted.is_empty() {
            return Err(ScmFailure::refused(
                "PATH_CONFLICTED",
                format!("Resolve the conflict in {} before committing it.", listed(&conflicted)),
            ));
        }
        if !scan.json.operation.is_empty() {
            return Err(ScmFailure::refused(
                "OPERATION_IN_PROGRESS",
                format!(
                    "A {} is in progress. Continue or abort it before committing files.",
                    scan.json.operation
                ),
            ));
        }
        let mut specs: Vec<String> = Vec::new();
        for (path, entry) in selected {
            let primary = entry.map_or(path, |e| e.path.clone());
            if !specs.contains(&primary) {
                specs.push(primary);
            }
            // A rename is one change: both halves, whichever form was passed.
            if let Some(old) = entry.and_then(|e| e.old_path.clone()) {
                if !specs.contains(&old) {
                    specs.push(old);
                }
            }
        }
        Ok(specs)
    }

    async fn hook(
        &self,
        index_file: &Path,
        enabled: bool,
        name: &str,
        args: &[&str],
        advisory: bool,
    ) -> Result<(), ScmFailure> {
        if !enabled {
            return Ok(());
        }
        let mut argv = vec!["hook", "run", "--ignore-missing", name];
        if !args.is_empty() {
            argv.push("--");
            argv.extend(args);
        }
        let options = RunOptions {
            index_file: Some(index_file.to_path_buf()),
            protect_hook: true,
            ..RunOptions::default()
        };
        match self.scm.git.text(&self.cancel, self.root()?, &argv, &options).await {
            Ok(_) => Ok(()),
            // git ignores post-commit's exit status; every other hook is a veto.
            Err(_) if advisory => Ok(()),
            Err(ScmFailure::Command { text, .. }) => Err(ScmFailure::refused(
                "HOOK_REFUSED",
                if text.is_empty() {
                    format!("The {name} hook refused this commit.")
                } else {
                    format!("The {name} hook refused this commit:\n{text}")
                },
            )),
            Err(other) => Err(other),
        }
    }

    /// Which commit hooks this repository defines (`core.hooksPath` aware).
    async fn present_hooks(&self) -> Result<Vec<&'static str>, ScmFailure> {
        let dir = self
            .scm
            .git
            .outcome(&self.cancel, self.root()?, &["rev-parse", "--git-path", "hooks"], &RunOptions::default())
            .await?;
        let dir = dir.stdout_text();
        if dir.trim().is_empty() {
            return Ok(Vec::new());
        }
        let hooks_dir = self.root()?.join(dir.trim());
        on_lane(self.scm.lane, &self.cancel, move || {
            COMMIT_HOOKS
                .iter()
                .copied()
                .filter(|name| executable_hook(&hooks_dir.join(name)))
                .collect::<Vec<_>>()
        })
        .await
    }

    /// `commit.cleanup`, read the way git reads it: exit 1 is "not set", any other failure is
    /// a config git could not read, and an unknown mode is refused in git's own words.
    async fn cleanup_mode(&self) -> Result<String, ScmFailure> {
        let probe = self
            .scm
            .git
            .outcome(&self.cancel, self.root()?, &["config", "--get", "commit.cleanup"], &RunOptions::default())
            .await?;
        match probe.code {
            Some(1) => return Ok("default".into()),
            Some(0) => {}
            _ => {
                return Err(ScmFailure::git(format!(
                    "Could not read commit.cleanup: {}",
                    probe.stderr_text().trim()
                )));
            }
        }
        let mode = probe.stdout_text().trim().to_owned();
        if mode.is_empty() {
            return Ok("default".into());
        }
        if !CLEANUP_MODES.contains(&mode.as_str()) {
            return Err(ScmFailure::git(format!("fatal: Invalid cleanup mode {mode}")));
        }
        Ok(mode)
    }

    async fn clean_message(&self, mode: &str, raw: &str) -> Result<String, ScmFailure> {
        if mode == "verbatim" {
            return Ok(if raw.ends_with('\n') { raw.to_owned() } else { format!("{raw}\n") });
        }
        let args: &[&str] = if mode == "strip" {
            &["stripspace", "--strip-comments"]
        } else {
            &["stripspace"]
        };
        let options = RunOptions {
            input: Some(raw.as_bytes().to_vec()),
            ..RunOptions::default()
        };
        self.scm.git.text(&self.cancel, self.root()?, args, &options).await
    }

    async fn commit_through_scratch_index(
        &self,
        message: &str,
        specs: &[String],
        addable: &[String],
    ) -> Result<String, ScmFailure> {
        let root = self.root()?.to_path_buf();
        let git_dir = self.identity.git_dir.clone();
        // Config git validates before it runs anything is validated first too: an unusable
        // `commit.cleanup` must not cost a hook run.
        let cleanup = self.cleanup_mode().await?;
        // Before a hook runs and before HEAD moves: a lock found only at the refresh would
        // leave a commit on the branch whose repair could not run.
        let lock = git_dir.join("index.lock");
        match std::fs::symlink_metadata(&lock) {
            Ok(_) => {
                return Err(ScmFailure::refused(
                    "INDEX_LOCK_HELD",
                    format!(
                        "Another Git process is using this repository, or an earlier one was interrupted: \"{}\" already exists. Nothing was committed — wait for that process to finish, or, if no Git process is running, delete \"{}\" and commit again.",
                        lock.display(),
                        lock.display()
                    ),
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(ScmFailure::refused(
                    "INDEX_LOCK_UNKNOWN",
                    format!(
                        "Git's index lock \"{}\" could not be checked, so another Git process using this repository cannot be ruled out: {error}. Nothing was committed — restore access to that file, then commit again.",
                        lock.display()
                    ),
                ));
            }
        }
        let present = self.present_hooks().await?;
        // Only a repository that defines a hook running before the commit is watched for index
        // writes; without one, an entry that changes meanwhile belongs to somebody else.
        let watched = present.iter().any(|name| *name != "post-commit");
        let hooks = !present.is_empty();
        let head = {
            let found = self
                .scm
                .git
                .outcome(
                    &self.cancel,
                    &root,
                    &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
                    &RunOptions::default(),
                )
                .await?;
            found.success().then(|| found.stdout_text().trim().to_owned())
        };
        let prefixes: Vec<String> = specs.iter().map(|spec| comparable(spec)).collect();
        let index_before = self.index_snapshot().await?;
        let scratch = Scratch::create(self.scm.scratch_dir())?;
        let index_file = scratch.0.join("commit.index");
        let scratch_options = RunOptions {
            index_file: Some(index_file.clone()),
            ..RunOptions::default()
        };
        let git = &self.scm.git;
        let read_tree: Vec<&str> = match &head {
            Some(head) => vec!["read-tree", head.as_str()],
            None => vec!["read-tree", "--empty"],
        };
        git.text(&self.cancel, &root, &read_tree, &scratch_options).await?;
        if !addable.is_empty() {
            // `--all` so a deleted selection records its removal, `--force` so a deliberately
            // selected ignored file is not skipped.
            let specs_literal: Vec<String> = addable.iter().map(|path| literal(path)).collect();
            let mut args = vec!["add", "--all", "--force", "--"];
            args.extend(specs_literal.iter().map(String::as_str));
            git.text(&self.cancel, &root, &args, &scratch_options).await?;
        }
        self.hook(&index_file, hooks, "pre-commit", &[], false).await?;
        let edited = self.message_through_hooks(&index_file, hooks, message).await?;
        let cleaned = self.clean_message(&cleanup, &edited).await?;
        if watched {
            let after = self.index_snapshot().await?;
            let touched: Vec<String> = after
                .iter()
                .filter(|(path, entry)| index_before.get(*path) != Some(entry))
                .map(|(path, _)| path.clone())
                .chain(index_before.keys().filter(|path| !after.contains_key(*path)).cloned())
                .collect();
            let strays = outside(&prefixes, touched);
            if !strays.is_empty() {
                return Err(ScmFailure::refused(
                    "HOOK_TOUCHED_INDEX",
                    format!(
                        "A commit hook changed the staged entry for {}, which was not selected. Nothing was committed; review the index before retrying.",
                        listed(&strays)
                    ),
                ));
            }
        }
        if cleaned.trim().is_empty() {
            return Err(ScmFailure::invalid("message", "a commit message"));
        }
        let tree = git
            .text(&self.cancel, &root, &["write-tree"], &scratch_options)
            .await?
            .trim()
            .to_owned();
        let changed = self.committed_paths(head.as_deref(), &tree).await?;
        if changed.is_empty() {
            return Err(ScmFailure::refused(
                "NOTHING_TO_COMMIT",
                "Nothing to commit: the selected files already match the last commit. Refresh Source Control and try again.",
            ));
        }
        let strays = outside(&prefixes, changed.iter().cloned());
        if !strays.is_empty() {
            return Err(ScmFailure::refused(
                "HOOK_STAGED_OTHERS",
                format!(
                    "A commit hook staged {}, which was not selected. Nothing was committed.",
                    listed(&strays)
                ),
            ));
        }
        // `commit-tree` signs only when asked, so `commit.gpgsign` is read here; a malformed
        // value fails exactly as it fails for `git commit`.
        let signed = git
            .run(&self.cancel, &root, &["config", "--bool", "--default", "false", "--get", "commit.gpgsign"])
            .await?
            .trim()
            == "true";
        let mut commit_args = vec!["commit-tree", tree.as_str()];
        if signed {
            commit_args.push("-S");
        }
        if let Some(head) = &head {
            commit_args.extend(["-p", head.as_str()]);
        }
        let commit_options = RunOptions {
            index_file: Some(index_file.clone()),
            input: Some(cleaned.as_bytes().to_vec()),
            ..RunOptions::default()
        };
        let commit = git
            .text(&self.cancel, &root, &commit_args, &commit_options)
            .await?
            .trim()
            .to_owned();
        let subject = cleaned.lines().next().unwrap_or("").trim().to_owned();
        let reflog = format!(
            "commit{}: {subject}",
            if head.is_some() { "" } else { " (initial)" }
        );
        // The old value is a compare-and-swap: a commit that landed underneath aborts instead
        // of being overwritten, and the empty value demands that an unborn branch still be.
        let old = head.clone().unwrap_or_default();
        if let Err(failure) = git
            .text(
                &self.cancel,
                &root,
                &["update-ref", "-m", &reflog, "HEAD", &commit, &old],
                &RunOptions::default(),
            )
            .await
        {
            let now = git
                .outcome(
                    &self.cancel,
                    &root,
                    &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
                    &RunOptions::default(),
                )
                .await?;
            let current = now.success().then(|| now.stdout_text().trim().to_owned());
            if current != head {
                return Err(ScmFailure::refused(
                    "REF_MOVED",
                    "Another commit landed on this branch while this one was being prepared. Nothing was committed — refresh Source Control and commit again.",
                ));
            }
            return Err(failure);
        }
        self.hook(&index_file, hooks, "post-commit", &[], true).await?;
        self.refresh_committed_paths(&commit, &changed, &index_before).await?;
        let branch = git
            .outcome(&self.cancel, &root, &["symbolic-ref", "--short", "HEAD"], &RunOptions::default())
            .await?;
        let branch = branch.stdout_text().trim().to_owned();
        Ok(format!(
            "[{}{} {}] {subject}\n",
            if branch.is_empty() { "detached HEAD" } else { branch.as_str() },
            if head.is_some() { "" } else { " (root-commit)" },
            &commit[..commit.len().min(7)],
        ))
    }

    /// The message hooks git runs for `commit -m`, through the file git uses so a hook that
    /// rewrites `$1` is honoured.
    async fn message_through_hooks(
        &self,
        index_file: &Path,
        hooks: bool,
        message: &str,
    ) -> Result<String, ScmFailure> {
        if !hooks {
            return Ok(message.to_owned());
        }
        let path = self.identity.git_dir.join("COMMIT_EDITMSG");
        let text = if message.ends_with('\n') { message.to_owned() } else { format!("{message}\n") };
        let target = path.clone();
        on_lane(self.scm.lane, &self.cancel, move || std::fs::write(target, text)).await??;
        let file = path.to_string_lossy().into_owned();
        self.hook(index_file, hooks, "prepare-commit-msg", &[&file, "message"], false).await?;
        self.hook(index_file, hooks, "commit-msg", &[&file], false).await?;
        let read = path.clone();
        Ok(on_lane(self.scm.lane, &self.cancel, move || std::fs::read_to_string(read)).await??)
    }

    /// The paths a tree changes against HEAD: the commit's real reach.
    async fn committed_paths(&self, head: Option<&str>, tree: &str) -> Result<Vec<String>, ScmFailure> {
        let raw = match head {
            Some(head) => {
                let base = format!("{head}^{{tree}}");
                self.run(&["diff-tree", "-r", "--name-only", "-z", "--no-commit-id", &base, tree])
                    .await?
            }
            None => self.run(&["ls-tree", "-r", "--name-only", "-z", tree]).await?,
        };
        Ok(nul_records(&raw).map(str::to_owned).collect())
    }

    /// Moves the user's index entries of the committed paths to the new commit. A path is
    /// refreshed only while its entry still is what the commit was built from: anything staged
    /// underneath meanwhile is left alone and reported, because overwriting it would silently
    /// demote someone else's staged content to an unstaged change.
    async fn refresh_committed_paths(
        &self,
        commit: &str,
        changed: &[String],
        built_from: &HashMap<String, String>,
    ) -> Result<(), ScmFailure> {
        let current = self.index_snapshot().await?;
        let (moved, refreshable): (Vec<&String>, Vec<&String>) = changed.iter().partition(|path| {
            current.get(*path).map(String::as_str).unwrap_or("")
                != built_from.get(*path).map(String::as_str).unwrap_or("")
        });
        if !refreshable.is_empty() {
            let specs: Vec<String> = refreshable.iter().map(|path| literal(path)).collect();
            let mut args = vec!["reset", "--quiet", commit, "--"];
            args.extend(specs.iter().map(String::as_str));
            if let Err(failure) = self.run(&args).await {
                let short = &commit[..commit.len().min(7)];
                let paths: Vec<String> = refreshable.iter().take(10).map(|p| (*p).clone()).collect();
                let recovery: Vec<String> = paths.iter().map(|p| format!("\"{}\"", literal(p))).collect();
                return Err(ScmFailure::refused(
                    "INDEX_REFRESH_FAILED",
                    format!(
                        "Commit {short} was created, but the index entries for {} could not be refreshed: {failure}. Run \"git reset {short} -- {}\" to finish it{}",
                        paths.join(", "),
                        recovery.join(" "),
                        if refreshable.len() > 10 { ", then the remaining paths the same way." } else { "." }
                    ),
                ));
            }
        }
        if !moved.is_empty() {
            return Err(ScmFailure::refused(
                "STAGED_UNDERNEATH",
                format!(
                    "Commit {} was created. {} was staged again while it was being committed, so that entry was left exactly as it is — nothing staged has been overwritten. Refresh Source Control to see the current state.",
                    &commit[..commit.len().min(7)],
                    moved.iter().take(10).map(|p| p.as_str()).collect::<Vec<_>>().join(", ")
                ),
            ));
        }
        Ok(())
    }
}

fn not_in_repository(paths: &[String]) -> ScmFailure {
    ScmFailure::refused(
        "PATH_UNKNOWN",
        format!("Not in this repository: {}. Refresh Source Control and try again.", listed(paths)),
    )
}

/// git's own rule for "there is a hook here": the file must be executable, not merely present.
/// Windows has no executable bit, so there presence is the whole test.
fn executable_hook(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_is_a_prefix_match_on_path_components() {
        let prefixes = vec![comparable("src/a")];
        assert!(within_selection(&prefixes, "src/a"));
        assert!(within_selection(&prefixes, "src/a/b.txt"));
        assert!(!within_selection(&prefixes, "src/ab.txt"));
    }

    #[test]
    fn option_like_and_traversing_paths_are_refused() {
        for bad in ["-x", "../x", "a/../b", "/abs", "C:\\x", "a\0b"] {
            assert!(assert_commit_path(bad).is_err(), "{bad}");
        }
        assert!(assert_commit_path("src/ok.rs").is_ok());
    }
}
