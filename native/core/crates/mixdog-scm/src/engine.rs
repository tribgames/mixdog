//! The engine shared by every front end (tools, panes, turn review, worktrees): one git
//! runner, one inspector, one set of per-repository write locks.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;

use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::repo::RepoEvidence;
use mixdog_core_api::domain::repo::RepoInspector;
use mixdog_core_api::domain::repo::RepoRef;
use mixdog_rt::MaintenanceIo;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::exec::Exec;
use crate::gh::client::GhClient;
use crate::gh::client::GhRunner;
use crate::gh::client::ProcessGh;
use crate::gh::login::GithubLogin;
use crate::git::Git;
use crate::inspect::inspector::GitInspector;
use crate::inspect::inspector::repo_ref;
use crate::locks::RepoGuard;
use crate::locks::RepoLocks;
use crate::repo;
use crate::stage_select::DiffSnapshots;
use crate::repo::RepoIdentity;
use crate::repo::on_lane;

pub struct Scm {
    pub git: Git,
    pub inspector: Arc<GitInspector>,
    pub locks: Arc<RepoLocks>,
    pub lane: MaintenanceIo,
    pub github: Arc<GhClient>,
    /// Diffs that handed out change ids for `action:stage`.
    pub snapshots: Arc<DiffSnapshots>,
    /// Owned by this core: the review inspections' scratch.
    scratch_dir: PathBuf,
    /// Where commit transactions build their scratch index (the OS temp folder, as Node).
    commit_root: PathBuf,
    processes: Arc<dyn ProcessManager>,
    gh_program: Arc<dyn Fn() -> String + Send + Sync>,
    /// What the last probe of each CLI found (Node's `cachedGh` / `cachedGit`): the version, or none when absent.
    /// Only a refresh looks again.
    pub(crate) cli_probes: std::sync::Mutex<CliProbes>,
}

#[derive(Default)]
pub(crate) struct CliProbes {
    pub gh: Option<Option<String>>,
    pub git: Option<Option<String>>,
}

impl Scm {
    /// The production engine: git and `gh` are found on the machine and spawned through
    /// `processes`.
    pub fn new(processes: Arc<dyn ProcessManager>, lane: MaintenanceIo, scratch_dir: PathBuf) -> Arc<Self> {
        let exec = Arc::new(Exec::new(processes.clone()));
        let gh = Arc::new(ProcessGh::new(exec));
        let program = gh.clone();
        Self::with_gh(processes, lane, scratch_dir, gh, Arc::new(move || program.program()))
    }

    /// An engine whose `gh` is `runner` (a recorded shim in tests); `gh_program` names the
    /// program the PTY sign-in spawns.
    pub fn with_gh(
        processes: Arc<dyn ProcessManager>,
        lane: MaintenanceIo,
        scratch_dir: PathBuf,
        runner: Arc<dyn GhRunner>,
        gh_program: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Arc<Self> {
        let git = Git::new(Arc::new(Exec::new(processes.clone())), lane);
        let locks = RepoLocks::new();
        Arc::new(Self {
            inspector: Arc::new(GitInspector::new(git.clone(), scratch_dir.join("review"))),
            git,
            github: Arc::new(GhClient::new(runner, locks.clone())),
            snapshots: DiffSnapshots::new(),
            scratch_dir,
            commit_root: std::env::temp_dir(),
            locks,
            lane,
            processes,
            gh_program,
            cli_probes: Default::default(),
        })
    }

    pub fn scratch_dir(&self) -> &Path {
        &self.scratch_dir
    }

    /// The folder the per-commit scratch directories (`mixdog-commit-<pid>-<random>`) live in:
    /// the OS temp folder, shared with other processes (and other Mixdog cores), so only
    /// [`Self::sweep_commit_scratch`] may remove anything in it.
    pub fn commit_scratch_root(&self) -> &Path {
        &self.commit_root
    }

    /// Node's `sweepScratchIndexes`, run before each commit: removes the commit scratch
    /// directories of processes that are gone (a killed commit never ran its cleanup), and
    /// nothing else. Returns how many it removed.
    pub async fn sweep_commit_scratch(&self, cancel: &CancellationToken) -> Result<usize, ScmFailure> {
        let root = self.commit_root.clone();
        on_lane(self.lane, cancel, move || sweep_dead_commit_scratch(&root, SystemTime::now())).await
    }

    /// The GitHub sign-in flow (DS §5.4).
    pub fn github_login(&self) -> GithubLogin {
        GithubLogin::new(self.processes.clone(), self.github.clone(), self.gh_program.clone())
    }

    /// The repository containing `cwd`; [`ScmFailure::NotARepository`] outside one.
    pub async fn open(
        self: &Arc<Self>,
        cwd: &Path,
        cancel: &CancellationToken,
    ) -> Result<Repo, ScmFailure> {
        let start = cwd.to_path_buf();
        let identity = on_lane(self.lane, cancel, move || repo::discover(&start)).await??;
        Ok(Repo {
            scm: self.clone(),
            cwd: cwd.to_path_buf(),
            identity,
            cancel: cancel.clone(),
        })
    }

    /// The repository containing `cwd`, or `cwd` itself outside one: Node runs the call's git command in the folder it was given and
    /// the caller reads git's own failure, so a call that is a single git command must start that command (its process is observable).
    pub async fn open_or_in_place(self: &Arc<Self>, cwd: &Path, cancel: &CancellationToken) -> Result<Repo, ScmFailure> {
        match self.open(cwd, cancel).await {
            Err(ScmFailure::NotARepository) => {
                let place = cwd.to_path_buf();
                Ok(Repo {
                    scm: self.clone(),
                    cwd: place.clone(),
                    identity: RepoIdentity { work_tree: Some(place.clone()), git_dir: place.clone(), common_dir: place },
                    cancel: cancel.clone(),
                })
            }
            other => other,
        }
    }

    /// What `gitResetToCommit` / `gitCherryPickCommit` answer in a folder that is no repository: Node checks the reset mode, then
    /// asks git to resolve the commit (`checkedCommit`, git-mutations.ts), so the caller is told which commit could not be found,
    /// not that there is no repository. `mode` is `None` for a call that has none.
    pub async fn commit_lookup_outside_repository(
        self: &Arc<Self>,
        cwd: &Path,
        cancel: &CancellationToken,
        mode: Option<&str>,
        value: &str,
    ) -> ScmFailure {
        if mode.is_some_and(|mode| !matches!(mode, "soft" | "mixed" | "hard")) {
            return ScmFailure::invalid("mode", "`soft`, `mixed` or `hard`");
        }
        let place = cwd.to_path_buf();
        let stand_in = Repo {
            scm: self.clone(),
            cwd: place.clone(),
            identity: RepoIdentity { work_tree: Some(place.clone()), git_dir: place.clone(), common_dir: place },
            cancel: cancel.clone(),
        };
        match stand_in.checked_commit(value).await {
            Err(failure) => failure,
            Ok(_) => ScmFailure::NotARepository,
        }
    }
}

/// `SCRATCH_PREFIX` (`git-commit-transaction.ts`): a commit scratch directory is named for the
/// process that owns it from the moment it exists.
pub(crate) const COMMIT_SCRATCH_PREFIX: &str = "mixdog-commit-";
/// `SCRATCH_GRACE_MS`: how old an entry with no owner in its name must be to be removed.
const COMMIT_SCRATCH_GRACE: Duration = Duration::from_secs(60 * 60);

/// `Number.parseInt(name.split('-')[0], 10)` of the text after the prefix, kept when it is a
/// positive integer. A number too large for any pid is still the owner it names.
fn scratch_owner(after_prefix: &str) -> Option<u64> {
    let head = mixdog_js::js_trim_start(after_prefix.split('-').next().unwrap_or(""));
    let digits = head.strip_prefix('+').unwrap_or(head);
    let digits = &digits[..digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len())];
    if digits.is_empty() {
        return None;
    }
    let owner = digits.parse::<u64>().unwrap_or(u64::MAX);
    (owner > 0).then_some(owner)
}

/// Whether a process may still own a scratch directory. A pid no operating system hands out
/// owns nothing; otherwise death must be proven (the worktree ownership check: an unanswered
/// probe reads as alive).
fn scratch_owner_alive(owner: u64) -> bool {
    u32::try_from(owner).is_ok_and(|pid| crate::worktree::ownership::pid_alive_or_unknown(Some(pid)))
}

/// Removes, among `root`'s entries, the `mixdog-commit-*` ones whose owner is gone. A name with
/// a pid decides by liveness alone (no age override: a commit parked in a slow hook for a day
/// still owns its index); a name without one (an older build, a foreign copy) only ages out
/// after an hour. Every other entry is left alone.
pub(crate) fn sweep_dead_commit_scratch(root: &Path, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(root) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let Some(after) = name.to_str().and_then(|name| name.strip_prefix(COMMIT_SCRATCH_PREFIX)) else {
                return false;
            };
            let Ok(info) = std::fs::metadata(entry.path()) else {
                return false;
            };
            let orphaned = match scratch_owner(after) {
                Some(owner) => !scratch_owner_alive(owner),
                None => info
                    .modified()
                    .ok()
                    .and_then(|at| now.duration_since(at).ok())
                    .is_some_and(|age| age > COMMIT_SCRATCH_GRACE),
            };
            if !orphaned {
                return false;
            }
            // Restarts the lane lease per scratch folder removed.
            mixdog_rt::job_progress();
            let removed = if info.is_dir() { std::fs::remove_dir_all(entry.path()) } else { std::fs::remove_file(entry.path()) };
            removed.is_ok()
        })
        .count()
}

/// One repository as seen from a request: where the request ran and the caller's cancellation.
#[derive(Clone)]
pub struct Repo {
    pub scm: Arc<Scm>,
    pub cwd: PathBuf,
    pub identity: RepoIdentity,
    pub cancel: CancellationToken,
}

impl Repo {
    /// The work tree root; a bare repository has none and cannot be mutated here.
    pub fn root(&self) -> Result<&Path, ScmFailure> {
        self.identity
            .work_tree
            .as_deref()
            .ok_or(ScmFailure::NotARepository)
    }

    pub fn repo_ref(&self) -> Result<RepoRef, ScmFailure> {
        repo_ref(&self.identity)
    }

    pub async fn run(&self, args: &[&str]) -> Result<String, ScmFailure> {
        self.scm.git.run(&self.cancel, self.root()?, args).await
    }

    pub async fn read(&self, args: &[&str]) -> Result<String, ScmFailure> {
        self.scm.git.read(&self.cancel, self.root()?, args).await
    }

    pub async fn succeeds(&self, args: &[&str]) -> Result<bool, ScmFailure> {
        self.scm.git.succeeds(&self.cancel, self.root()?, args).await
    }

    /// The write lock of this work tree.
    pub async fn lock_work_tree(&self) -> Result<RepoGuard, ScmFailure> {
        let root = self.root()?.to_path_buf();
        self.scm
            .locks
            .acquire(&self.identity.common_dir, Some(&[root.as_path()]), &self.cancel)
            .await
    }

    /// The write lock of the whole repository (managed worktree mutations).
    pub async fn lock_repository(&self) -> Result<RepoGuard, ScmFailure> {
        self.scm
            .locks
            .acquire(&self.identity.common_dir, None, &self.cancel)
            .await
    }

    /// A write changed the repository: cached inspections are stale now, ahead of the watcher.
    pub fn touched(&self) {
        if let Ok(repo) = self.repo_ref() {
            self.scm.inspector.evidence(&repo, RepoEvidence::GitDir);
        }
    }
}
