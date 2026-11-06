//! The Git ports: one Git child to completion over WP-SCM's runner ([`ScmGit`]), and the turn
//! worktree snapshots over the shadow repository ([`ScmWorktrees`]).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_scm::engine::Scm;
use mixdog_rt::LaneTokens;
use mixdog_scm::git::RunOptions;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::disk::LaneDisk;
use super::ports::GitOptions;
use super::ports::ReviewDisk;
use super::ports::GitRun;
use super::ports::OUTPUT_OVERFLOW;
use super::ports::ResumeScope;
use super::ports::ReviewGit;
use super::ports::ReviewWorktrees;
use super::ports::WorktreeBase;
use super::review_diff::Obj;
use super::service::Config;
use super::service::TurnReview;
use super::shadow::ShadowRepos;
use super::shadow::canonical_path;
use super::snapshot::ShadowSnapshot;

/// `COMMAND_MAX_BYTES`.
const COMMAND_MAX_BYTES: u64 = 8 * 1024 * 1024;

impl TurnReview {
    /// The process's turn review: the lane disk, the process's Git runner `scm`, and the shadow
    /// repositories under `<data>/turn-worktree-snapshots-v1`; `env` reads the process
    /// environment (`MIXDOG_TURN_SNAPSHOT`).
    pub fn over_scm(scm: Arc<Scm>, tokens: LaneTokens, data_dir: &Path, env: impl Fn(&str) -> Option<String>) -> Self {
        let disk: Arc<dyn ReviewDisk> = Arc::new(LaneDisk::new(tokens));
        let git: Arc<dyn ReviewGit> = Arc::new(ScmGit::new(scm));
        let shadow = Arc::new(ShadowRepos::new(data_dir.join("turn-worktree-snapshots-v1"), git.clone(), disk.clone()));
        let worktrees = Arc::new(ScmWorktrees::new(shadow));
        Self::new(Config::from_env(env), tokens.cpu_interactive, data_dir, disk, git, worktrees)
    }
}

/// `runGitOffThread` over the scm engine's git runner.
pub struct ScmGit {
    scm: Arc<Scm>,
}

impl ScmGit {
    pub fn new(scm: Arc<Scm>) -> Self {
        Self { scm }
    }
}

#[async_trait]
impl ReviewGit for ScmGit {
    async fn run_with(&self, cwd: &str, args: &[String], input: Vec<u8>, options: &GitOptions) -> Result<GitRun, String> {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let options = RunOptions {
            input: (!input.is_empty()).then_some(input),
            max_output: Some(options.max_bytes.unwrap_or(COMMAND_MAX_BYTES)),
            index_file: options.index_file.clone(),
            ..RunOptions::default()
        };
        let out = self.scm.git.outcome(&CancellationToken::new(), Path::new(cwd), &refs, &options).await.map_err(|e| match e {
            mixdog_scm::error::ScmFailure::OutputTooLarge { .. } => OUTPUT_OVERFLOW.to_owned(),
            other => other.to_string(),
        })?;
        Ok(GitRun { code: out.code.unwrap_or(-1), stdout: out.stdout, stderr: out.stderr })
    }
}

/// `createTurnWorktreeSnapshot` and its companions over the shadow repositories.
pub struct ScmWorktrees {
    shadow: Arc<ShadowRepos>,
}

impl ScmWorktrees {
    pub fn new(shadow: Arc<ShadowRepos>) -> Self {
        Self { shadow }
    }
}

fn scope_paths(scope: &ResumeScope) -> (&[String], &[Value]) {
    (&scope.paths, &scope.baseline_files)
}

#[async_trait]
impl ReviewWorktrees for ScmWorktrees {
    async fn create(&self, worktree: &str) -> Option<Arc<dyn WorktreeBase>> {
        Some(ShadowSnapshot::create(&self.shadow, worktree).await? as Arc<dyn WorktreeBase>)
    }

    async fn resume(&self, worktree: &str, baseline_tree: &str, scope: &ResumeScope) -> Option<Arc<dyn WorktreeBase>> {
        let (paths, files) = scope_paths(scope);
        Some(ShadowSnapshot::resume(&self.shadow, worktree, baseline_tree, paths, files).await? as Arc<dyn WorktreeBase>)
    }

    async fn resume_file_patch(&self, worktree: &str, baseline_tree: &str, scope: &ResumeScope, path: &str, old_path: &str, max_bytes: usize) -> Option<Obj> {
        let (paths, files) = scope_paths(scope);
        ShadowSnapshot::resume_file_patch(&self.shadow, worktree, baseline_tree, paths, files, path, old_path, max_bytes).await
    }

    async fn forget_root(&self, root: &str) -> (Vec<std::path::PathBuf>, Vec<std::path::PathBuf>) {
        self.shadow.forget_root(root).await
    }

    fn note_change(&self, paths: Option<&[String]>) {
        self.shadow.note_change(paths);
    }

    fn canonical_path(&self, path: &str) -> String {
        canonical_path(path)
    }
}