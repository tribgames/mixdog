//! The engine shared by every front end (tools, panes, turn review, worktrees): one git
//! runner, one inspector, one set of per-repository write locks.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

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
    /// Where commit transactions build their scratch index; owned by this core, so a boot
    /// sweep can empty it without asking who is alive.
    scratch_dir: PathBuf,
    processes: Arc<dyn ProcessManager>,
    gh_program: Arc<dyn Fn() -> String + Send + Sync>,
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
        let git = Git::new(Arc::new(Exec::new(processes.clone())));
        let locks = RepoLocks::new();
        Arc::new(Self {
            inspector: Arc::new(GitInspector::new(git.clone(), scratch_dir.join("review"))),
            git,
            github: Arc::new(GhClient::new(runner, locks.clone())),
            snapshots: DiffSnapshots::new(),
            scratch_dir,
            locks,
            lane,
            processes,
            gh_program,
        })
    }

    pub fn scratch_dir(&self) -> &Path {
        &self.scratch_dir
    }

    /// Removes what a crashed commit left in the scratch directory. Called once at boot: one
    /// core owns the directory, so nothing in it is in use.
    pub async fn boot_sweep(&self, cancel: &CancellationToken) -> Result<usize, ScmFailure> {
        let dir = self.scratch_dir.clone();
        on_lane(self.lane, cancel, move || {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                return 0;
            };
            entries
                .flatten()
                .filter(|entry| {
                    // Restarts the lane lease per scratch folder removed.
                    mixdog_rt::job_progress();
                    std::fs::remove_dir_all(entry.path()).is_ok()
                })
                .count()
        })
        .await
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
