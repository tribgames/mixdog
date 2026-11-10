//! The git front of [`Exec`]: the environment every git child runs with, credential
//! scrubbing of its diagnostics, and the four ways the engine reads an answer (stdout, exit
//! code kept, stdin supplied, NUL records).

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use mixdog_rt::MaintenanceIo;

use crate::error::ScmFailure;
use crate::error::scrub_credentials;
use crate::exec::Exec;
use crate::exec::ExecOutput;
use crate::exec::ExecSpec;
use crate::git_launch;
use crate::repo::on_lane;

/// Read-only git children that back UI reads are cut off here: such a read is shared by every
/// caller that asks meanwhile, so one wedged child would hold them all. Writes are unbounded.
pub const GIT_READ_LIMIT: Duration = Duration::from_secs(60);

/// Output a status scan may produce (about a million untracked paths) before it fails.
pub const STATUS_MAX_BYTES: u64 = 64 * 1024 * 1024;
/// Output of ordinary reads and writes.
const RUN_MAX_BYTES: u64 = 32_000_000;

#[derive(Clone, Default)]
pub struct RunOptions {
    /// The scratch index a command writes; unset commands use the repository's own, whatever
    /// the inherited environment says.
    pub index_file: Option<PathBuf>,
    /// Hooks are project-controlled code: they never see provider or cloud credentials.
    pub protect_hook: bool,
    /// Variables set on top of the pinned environment (a commit identity).
    pub extra_env: Vec<(String, String)>,
    pub read_limit: bool,
    /// The child is tree-killed and the run answers `TimedOut` after this long; it wins over
    /// `read_limit`'s.
    pub time_limit: Option<Duration>,
    pub input: Option<Vec<u8>>,
    pub max_output: Option<u64>,
    /// A dependency probe (Node's `cli-run.ts` `run`): the scrubbed child environment and nothing git-specific on top of it.
    pub bare_env: bool,
}

impl RunOptions {
    pub fn read() -> Self {
        Self {
            read_limit: true,
            ..Self::default()
        }
    }
}

/// The environment a git child would have: this process's, less what `spec` removes, with what
/// `spec` sets applied (`gitChildEnv(env)` takes exactly this as `env`).
pub(crate) fn child_base(spec: &ExecSpec, process: git_launch::Env) -> git_launch::Env {
    let mut base = process;
    base.retain(|(key, _)| !spec.env_remove.iter().any(|name| name.eq_ignore_ascii_case(key)));
    for (name, value) in &spec.env_set {
        match base.iter_mut().find(|(key, _)| key.eq_ignore_ascii_case(name)) {
            Some(entry) => entry.1 = value.clone(),
            None => base.push((name.clone(), value.clone())),
        }
    }
    base
}

/// Hands `spec` the launch: its program, and the launcher's variables as they came out of
/// `gitLaunchEnvironment` over the caller's environment, so they win over what the caller set
/// under the same name (Node transforms the caller's PATH, MSYSTEM and MSYS, it does not skip them).
pub(crate) fn apply_launch(spec: &mut ExecSpec, launch: git_launch::Launch) {
    spec.program = launch.program;
    for (name, value) in launch.env {
        spec.env_set.retain(|(set, _)| !set.eq_ignore_ascii_case(&name));
        spec.env_set.push((name, value));
    }
}

/// Runs `spec` as git: with the program PATH's `git` resolves to and the environment its launcher
/// would have built (`git-launch.mjs` `startGit`), and once more with a fresh resolution when the
/// resolved binary is gone (an uninstalled or moved Git, where bare `git` would find whatever PATH
/// holds now).
pub async fn start_git(exec: &Exec, lane: MaintenanceIo, spec: ExecSpec, cancel: &CancellationToken) -> Result<ExecOutput, ScmFailure> {
    match launch_once(exec, lane, spec.clone(), cancel).await {
        Err(ScmFailure::Unavailable { capability }) if git_launch::forget_missing(&capability) => launch_once(exec, lane, spec, cancel).await,
        other => other,
    }
}

async fn launch_once(exec: &Exec, lane: MaintenanceIo, mut spec: ExecSpec, cancel: &CancellationToken) -> Result<ExecOutput, ScmFailure> {
    if cfg!(windows) {
        let base = child_base(&spec, git_launch::process_env());
        // Git children started side by side are started in the order they were asked for (git-status.ts starts its reads in code order):
        // a resolved PATH is taken at once, and the first resolution of a PATH (a file-system read on the lane) is taken one at a time, in
        // the order callers arrive at the gate, so the lane's threads cannot reorder them.
        let launch = match git_launch::launch_if_resolved(&base) {
            Some(launch) => launch,
            None => {
                static FIRST_RESOLUTION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
                // The resolution belongs to the PATH, not to a repository: every caller needs the same answer, so those that queued
                // behind the first take it from the cache it filled instead of resolving again.
                let _turn = FIRST_RESOLUTION.lock().await;
                match git_launch::launch_if_resolved(&base) {
                    Some(launch) => launch,
                    None => on_lane(lane, cancel, move || git_launch::launch_for(&base)).await?,
                }
            }
        };
        apply_launch(&mut spec, launch);
    }
    exec.run(spec, cancel).await
}

#[derive(Clone)]
pub struct Git {
    exec: Arc<Exec>,
    lane: MaintenanceIo,
}

impl Git {
    pub fn new(exec: Arc<Exec>, lane: MaintenanceIo) -> Self {
        Self { exec, lane }
    }

    /// Resolves the git of this process's PATH before reads are started side by side, so each of them takes its launch at once and
    /// they start in the order they were asked for (the first resolution is a file-system read that would let a later one pass).
    pub async fn prepare(&self, cancel: &CancellationToken) -> Result<(), ScmFailure> {
        if cfg!(windows) {
            let base = child_base(&ExecSpec::new("git", Path::new(".")), git_launch::process_env());
            if git_launch::launch_if_resolved(&base).is_none() {
                on_lane(self.lane, cancel, move || git_launch::launch_for(&base)).await?;
            }
        }
        Ok(())
    }

    pub fn exec(&self) -> &Arc<Exec> {
        &self.exec
    }

    /// The raw outcome: the exit code is kept and a non-zero exit is not an error. A child
    /// that never ran is.
    pub async fn outcome(
        &self,
        cancel: &CancellationToken,
        cwd: &Path,
        args: &[&str],
        options: &RunOptions,
    ) -> Result<ExecOutput, ScmFailure> {
        let mut spec = ExecSpec::new("git", cwd);
        spec.args = args.iter().map(|arg| (*arg).to_owned()).collect();
        if !options.bare_env {
            spec.env_set = vec![
                ("GIT_TERMINAL_PROMPT".into(), "0".into()),
                ("GIT_EDITOR".into(), "true".into()),
                ("GIT_SEQUENCE_EDITOR".into(), "true".into()),
            ];
            match &options.index_file {
                Some(index) => spec
                    .env_set
                    .push(("GIT_INDEX_FILE".into(), index.to_string_lossy().into_owned())),
                None => spec.env_remove.push("GIT_INDEX_FILE".into()),
            }
            if options.protect_hook {
                spec.env_remove.extend(provider_secret_names());
            }
            spec.env_set.extend(options.extra_env.iter().cloned());
        }
        spec.stdin = options.input.clone();
        spec.time_limit = options.time_limit.or(options.read_limit.then_some(GIT_READ_LIMIT));
        spec.max_output = options.max_output.unwrap_or(RUN_MAX_BYTES);
        let mut output = start_git(&self.exec, self.lane, spec, cancel).await?;
        output.stderr = scrub_credentials(&output.stderr_text()).into_bytes();
        Ok(output)
    }

    /// stdout of a command that must exit 0; a failure carries the scrubbed stderr.
    pub async fn text(
        &self,
        cancel: &CancellationToken,
        cwd: &Path,
        args: &[&str],
        options: &RunOptions,
    ) -> Result<String, ScmFailure> {
        let output = self.outcome(cancel, cwd, args, options).await?;
        if output.success() {
            return Ok(output.stdout_text());
        }
        Err(ScmFailure::git(failure_text(&output, args)))
    }

    pub async fn run(
        &self,
        cancel: &CancellationToken,
        cwd: &Path,
        args: &[&str],
    ) -> Result<String, ScmFailure> {
        self.text(cancel, cwd, args, &RunOptions::default()).await
    }

    pub async fn read(
        &self,
        cancel: &CancellationToken,
        cwd: &Path,
        args: &[&str],
    ) -> Result<String, ScmFailure> {
        self.text(cancel, cwd, args, &RunOptions::read()).await
    }

    /// A command that talks to a remote, with a failure Node words for the person (`readableRemoteError`, git-mutations.ts:221).
    pub async fn remote(&self, cancel: &CancellationToken, cwd: &Path, args: &[&str]) -> Result<String, ScmFailure> {
        self.text(cancel, cwd, args, &RunOptions::default()).await.map_err(readable_remote_error)
    }
    /// `true` when the command exits 0.
    pub async fn succeeds(
        &self,
        cancel: &CancellationToken,
        cwd: &Path,
        args: &[&str],
    ) -> Result<bool, ScmFailure> {
        Ok(self
            .outcome(cancel, cwd, args, &RunOptions::default())
            .await?
            .success())
    }
}

pub const CODE_AUTH_REQUIRED: &str = "GIT_AUTH_REQUIRED";
pub const AUTH_REQUIRED_TEXT: &str =
    "Git authentication is required. Sign in with your Git credential helper and retry.";
/// Node's `readableRemoteError`: a failure whose text says authentication failed reads as one sentence, anything else keeps its text.
pub fn readable_remote_error(failure: ScmFailure) -> ScmFailure {
    let message = failure.to_string().to_lowercase();
    let asks_for_credentials = ["authentication failed", "could not read username", "terminal prompts disabled", "permission denied", "publickey"]
        .iter()
        .any(|phrase| message.contains(phrase));
    if asks_for_credentials { ScmFailure::refused(CODE_AUTH_REQUIRED, AUTH_REQUIRED_TEXT) } else { failure }
}
fn failure_text(output: &ExecOutput, args: &[&str]) -> String {
    let stderr = output.stderr_text();
    // runGit (git-runner.ts:149) tells the failure by the whole stderr, not a tail.
    let text = stderr.trim();
    if text.is_empty() {
        format!("Command failed: git {}", args.join(" "))
    } else {
        text.to_owned()
    }
}

/// NUL-terminated records of `text`.
pub fn nul_records(text: &str) -> impl Iterator<Item = &str> {
    text.split('\0').filter(|record| !record.is_empty())
}

/// Names of the inherited variables that hold provider or cloud credentials.
fn provider_secret_names() -> Vec<String> {
    const EXACT: &[&str] = &[
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI",
        "DATABASE_URL",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GITHUB_PAT",
        "STRIPE_SECRET_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "NPM_CONFIG__AUTH",
        "npm_config__auth",
    ];
    const SUFFIXES: &[&str] = &[
        "_SECRET_ACCESS_KEY",
        "_ACCESS_KEY",
        "_SESSION_TOKEN",
        "_AUTH_TOKEN",
        "_API_KEY",
        "_TOKEN",
        "_SECRET",
        "_PASSWORD",
        "_CREDENTIALS",
        "_PRIVATE_KEY",
        "_PAT",
    ];
    const PUBLIC_PREFIXES: &[&str] = &[
        "NEXT_PUBLIC_",
        "NUXT_PUBLIC_",
        "VITE_",
        "REACT_APP_",
        "VUE_APP_",
        "EXPO_PUBLIC_",
        "GATSBY_",
        "STORYBOOK_",
        "PUBLIC_",
    ];
    std::env::vars_os()
        .filter_map(|(name, _)| name.into_string().ok())
        .filter(|name| {
            EXACT.contains(&name.as_str())
                || (SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
                    && !PUBLIC_PREFIXES.iter().any(|prefix| name.starts_with(prefix)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TestProcesses;

    fn git() -> Git {
        Git::new(Arc::new(Exec::new(TestProcesses::shared())), mixdog_rt::testing::tokens().maintenance_io)
    }

    #[tokio::test]
    async fn exit_code_is_kept_and_stderr_is_scrubbed() {
        let dir = tempfile::tempdir().unwrap();
        let git = git();
        let cancel = CancellationToken::new();
        let outcome = git
            .outcome(
                &cancel,
                dir.path(),
                &["config", "--get", "mixdog.unset"],
                &RunOptions::default(),
            )
            .await
            .unwrap();
        // `config --get` answers 1 for "not set": a meaning, not a failure.
        assert_eq!(outcome.code, Some(1));
        let failed = git
            .run(&cancel, dir.path(), &["rev-parse", "--verify", "nope"])
            .await
            .unwrap_err();
        assert!(matches!(failed, ScmFailure::Command { .. }));
    }

    #[tokio::test]
    async fn missing_program_is_unavailable_by_spawn_kind() {
        let dir = tempfile::tempdir().unwrap();
        let error = Exec::new(TestProcesses::shared())
            .run(ExecSpec::new("mixdog-no-such-program", dir.path()), &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(matches!(error, ScmFailure::Unavailable { .. }));
    }
}
