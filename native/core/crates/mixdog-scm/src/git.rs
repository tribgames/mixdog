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

/// Diagnostic tail kept from a failed child.
const TAIL_BYTES: usize = 64_000;

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
    /// `GIT_ASKPASS` helper that records a credential request instead of answering it.
    pub askpass: Option<PathBuf>,
    /// Variables set on top of the pinned environment (a commit identity).
    pub extra_env: Vec<(String, String)>,
    pub read_limit: bool,
    /// The child is tree-killed and the run answers `TimedOut` after this long; it wins over
    /// `read_limit`'s.
    pub time_limit: Option<Duration>,
    pub input: Option<Vec<u8>>,
    pub max_output: Option<u64>,
}

impl RunOptions {
    pub fn read() -> Self {
        Self {
            read_limit: true,
            ..Self::default()
        }
    }
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
        if let Some(helper) = &options.askpass {
            spec.env_set
                .push(("GIT_ASKPASS".into(), helper.to_string_lossy().into_owned()));
            spec.env_set
                .push(("SSH_ASKPASS".into(), helper.to_string_lossy().into_owned()));
            spec.env_set.push((
                ASKPASS_MARK_ENV.into(),
                askpass_mark(helper).to_string_lossy().into_owned(),
            ));
        }
        spec.stdin = options.input.clone();
        spec.time_limit = options.time_limit.or(options.read_limit.then_some(GIT_READ_LIMIT));
        spec.max_output = options.max_output.unwrap_or(RUN_MAX_BYTES);
        let mut output = match self.start(spec.clone(), cancel).await {
            // `startGit`: the resolved binary is gone (an uninstalled or moved Git): once more
            // with a fresh resolution, where bare `git` would find whatever PATH holds now.
            Err(ScmFailure::Unavailable { capability }) if git_launch::forget_missing(&capability) => {
                self.start(spec, cancel).await?
            }
            other => other?,
        };
        output.stderr = scrub_credentials(&output.stderr_text()).into_bytes();
        Ok(output)
    }

    /// Runs `spec` with the program PATH's `git` resolves to and the environment its launcher
    /// would have built (`git-launch.mjs`), on top of the environment `spec` already asks for.
    async fn start(&self, mut spec: ExecSpec, cancel: &CancellationToken) -> Result<ExecOutput, ScmFailure> {
        if cfg!(windows) {
            let mut base = git_launch::process_env();
            base.retain(|(key, _)| !spec.env_remove.iter().any(|name| name.eq_ignore_ascii_case(key)));
            for (name, value) in &spec.env_set {
                match base.iter_mut().find(|(key, _)| key.eq_ignore_ascii_case(name)) {
                    Some(entry) => entry.1 = value.clone(),
                    None => base.push((name.clone(), value.clone())),
                }
            }
            let launch = on_lane(self.lane, cancel, move || git_launch::launch_for(&base)).await?;
            spec.program = launch.program;
            // Variables the caller set stay as the caller set them; the launcher's go first.
            let mut env = launch.env;
            env.retain(|(key, _)| !spec.env_set.iter().any(|(name, _)| name.eq_ignore_ascii_case(key)));
            env.append(&mut spec.env_set);
            spec.env_set = env;
        }
        self.exec.run(spec, cancel).await
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

    /// A command that talks to a remote. Credentials are never prompted for: git is given a
    /// helper that records that it was asked, so "authentication is required" is told by that
    /// fact and not by reading git's message.
    pub async fn remote(
        &self,
        cancel: &CancellationToken,
        cwd: &Path,
        args: &[&str],
    ) -> Result<String, ScmFailure> {
        let scratch = AskpassScratch::create()?;
        let options = RunOptions {
            askpass: Some(scratch.helper.clone()),
            ..RunOptions::default()
        };
        match self.text(cancel, cwd, args, &options).await {
            Err(ScmFailure::Command { .. }) if scratch.was_asked() => Err(ScmFailure::refused(
                CODE_AUTH_REQUIRED,
                AUTH_REQUIRED_TEXT,
            )),
            other => other,
        }
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
const ASKPASS_MARK_ENV: &str = "MIXDOG_ASKPASS_MARK";

fn askpass_mark(helper: &Path) -> PathBuf {
    helper.with_file_name("asked")
}

/// The askpass helper of one remote command and the marker it leaves when git asks for a
/// credential. Removed when the command ends.
struct AskpassScratch {
    dir: PathBuf,
    helper: PathBuf,
}

impl AskpassScratch {
    fn create() -> Result<Self, ScmFailure> {
        use std::sync::atomic::AtomicU64;
        use std::sync::atomic::Ordering;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mixdog-askpass-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir)?;
        let (name, body) = if cfg!(windows) {
            (
                "askpass.cmd",
                format!("@echo off\r\necho asked> \"%{ASKPASS_MARK_ENV}%\"\r\nexit /b 1\r\n"),
            )
        } else {
            (
                "askpass.sh",
                format!("#!/bin/sh\n: > \"${ASKPASS_MARK_ENV}\"\nexit 1\n"),
            )
        };
        let helper = dir.join(name);
        std::fs::write(&helper, body)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o755))?;
        }
        Ok(Self { dir, helper })
    }

    fn was_asked(&self) -> bool {
        askpass_mark(&self.helper).exists()
    }
}

impl Drop for AskpassScratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn failure_text(output: &ExecOutput, args: &[&str]) -> String {
    let stderr = output.stderr_text();
    let tail = if stderr.len() > TAIL_BYTES {
        let mut start = stderr.len() - TAIL_BYTES;
        while !stderr.is_char_boundary(start) {
            start += 1;
        }
        &stderr[start..]
    } else {
        &stderr[..]
    };
    let text = tail.trim();
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
