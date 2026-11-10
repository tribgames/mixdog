//! The one `GhClient`: validated requests become `gh` invocations. gh owns auth (keyring), so
//! no token ever passes through this process. Writes to one remote repository are serialized
//! in one queue and never retried; a failed write says the remote state is unknown.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the std::fs calls here are bodies of lane jobs")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::error::GITHUB_DOMAIN;
use crate::error::ScmFailure;
use crate::error::scrub_credentials;
use crate::exec::Exec;
use crate::exec::ExecSpec;
use crate::gh::commands;
use crate::gh::commands::GhCommand;
use crate::gh::contract;
use crate::gh::contract::GithubRequest;
use crate::locks::RepoLocks;
use crate::locks::path_key;

/// A `gh` run limit, as before: a request that has not answered by then is killed.
const RUN_LIMIT: Duration = Duration::from_secs(120);
const MAX_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;
const DIAGNOSTIC_CHARS: usize = 12_000;

const WRITE_UNCERTAIN: &str = " The write was not retried. Check the remote state before trying again.";

/// What a `gh` child answered.
#[derive(Clone, Debug, Default)]
pub struct GhOutput {
    /// `None` when the child ended by a signal.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl GhOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    /// stdout and stderr together: `gh` prints its account line to either.
    pub fn combined(&self) -> String {
        format!("{}\n{}", self.stdout, self.stderr)
    }
}

/// Runs one `gh` command. A program that is not there is [`ScmFailure::Unavailable`]; a
/// non-zero exit is an answer, not an error. The production runner spawns through the process
/// manager; tests record the commands instead.
#[async_trait]
pub trait GhRunner: Send + Sync {
    async fn raw(&self, command: &GhCommand, cwd: &Path, cancel: &CancellationToken) -> Result<GhOutput, ScmFailure>;

    /// Looks for the program again (it may have been installed since).
    fn forget_program(&self) {}

    /// Whether the desktop's presence probe has anything to start (`resolveGh`, github-cli.ts): on Windows only a candidate file
    /// that exists is tried, so a machine with no `gh.exe` anywhere is "not installed" without a single start.
    fn probe_possible(&self) -> bool {
        true
    }
}

/// `ghPathCandidates` on Windows: every `PATH` folder's `gh.exe`, then Program Files' and the WinGet links folder's.
fn windows_gh_present() -> bool {
    let from_path = std::env::var("PATH")
        .unwrap_or_default()
        .split(';')
        .map(|dir| dir.replace('"', "").trim().to_owned())
        .filter(|dir| !dir.is_empty())
        .any(|dir| PathBuf::from(dir).join("gh.exe").exists());
    from_path || gh_candidates().iter().any(|path| path.exists())
}

/// stdout of a command that must exit 0; a failure carries `gh`'s bounded diagnostic, and a
/// failed write says its remote state is unknown.
pub async fn run_text(
    runner: &dyn GhRunner,
    command: &GhCommand,
    cwd: &Path,
    cancel: &CancellationToken,
) -> Result<String, ScmFailure> {
    let output = match runner.raw(command, cwd, cancel).await {
        Ok(output) => output,
        // client.mjs: the one text a missing `gh` has for every pull-request and API call.
        Err(ScmFailure::Unavailable { .. }) => {
            return Err(ScmFailure::Command {
                domain: GITHUB_DOMAIN,
                text: "GitHub CLI is not installed. Open Extensions → Plugin → Git & GitHub to install and connect it.".into(),
            });
        }
        Err(other) => return Err(other),
    };
    if output.success() {
        return Ok(output.stdout);
    }
    let detail = if output.stderr.is_empty() { &output.stdout } else { &output.stderr };
    let uncertain = if command.mutation { WRITE_UNCERTAIN } else { "" };
    Err(ScmFailure::Command {
        domain: GITHUB_DOMAIN,
        text: format!("{}{uncertain}", bounded(detail)),
    })
}

/// Where `gh` is: a known install location when one exists, else the one on `PATH`.
fn gh_candidates() -> Vec<PathBuf> {
    if cfg!(windows) {
        let program_files = std::env::var_os("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".into());
        let mut found = vec![PathBuf::from(program_files).join("GitHub CLI").join("gh.exe")];
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            found.push(PathBuf::from(local).join("Microsoft").join("WinGet").join("Links").join("gh.exe"));
        }
        found
    } else {
        ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
            .into_iter()
            .map(PathBuf::from)
            .collect()
    }
}

pub fn resolve_gh_program() -> String {
    gh_candidates()
        .into_iter()
        .find(|path| path.exists())
        .map_or_else(|| "gh".to_owned(), |path| path.to_string_lossy().into_owned())
}

pub struct ProcessGh {
    exec: Arc<Exec>,
    program: Mutex<Option<String>>,
    /// The program was given, not looked for.
    fixed: bool,
}

impl ProcessGh {
    pub fn new(exec: Arc<Exec>) -> Self {
        Self {
            exec,
            program: Mutex::new(None),
            fixed: false,
        }
    }

    /// A fixed program, for a recorded `gh` shim.
    pub fn with_program(exec: Arc<Exec>, program: impl Into<String>) -> Self {
        Self {
            exec,
            program: Mutex::new(Some(program.into())),
            fixed: true,
        }
    }

    pub fn program(&self) -> String {
        self.program
            .lock()
            .expect("gh program")
            .get_or_insert_with(resolve_gh_program)
            .clone()
    }

    /// Looks for `gh` again (it may have been installed since).
    pub fn refresh(&self) {
        *self.program.lock().expect("gh program") = None;
    }

    pub fn exec(&self) -> &Arc<Exec> {
        &self.exec
    }

    pub fn spec(&self, args: Vec<String>, hostname: Option<&str>, cwd: &Path, stdin: Option<Vec<u8>>) -> ExecSpec {
        let mut spec = ExecSpec::new(self.program(), cwd);
        spec.args = args;
        spec.env_set = vec![
            ("GH_PROMPT_DISABLED".into(), "1".into()),
            ("GH_NO_UPDATE_NOTIFIER".into(), "1".into()),
            ("GH_PAGER".into(), String::new()),
            ("PAGER".into(), String::new()),
            ("CLICOLOR".into(), "0".into()),
            ("NO_COLOR".into(), "1".into()),
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ];
        // `GH_HOST: command.hostname || env.GH_HOST || '` (github/client.mjs:41): always set, empty when nothing names a host.
        let host = hostname.map(str::to_owned).or_else(|| std::env::var("GH_HOST").ok()).filter(|host| !host.is_empty()).unwrap_or_default();
        spec.env_set.push(("GH_HOST".into(), host));
        spec.stdin = stdin;
        spec
    }
}

fn bounded(text: &str) -> String {
    scrub_credentials(&text.chars().take(DIAGNOSTIC_CHARS).collect::<String>())
}

#[async_trait]
impl GhRunner for ProcessGh {
    fn forget_program(&self) {
        self.refresh();
    }

    fn probe_possible(&self) -> bool {
        !cfg!(windows) || self.fixed || windows_gh_present()
    }

    async fn raw(&self, command: &GhCommand, cwd: &Path, cancel: &CancellationToken) -> Result<GhOutput, ScmFailure> {
        // The input is data, never a command, a flag or a local file name; stdin is always
        // closed so `gh` never waits on a prompt.
        let stdin = Some(command.input.clone().unwrap_or_default().into_bytes());
        let mut spec = if command.plain {
            let mut plain = ExecSpec::new(self.program(), cwd);
            plain.args = command.args.clone();
            plain.stdin = stdin;
            plain
        } else {
            self.spec(command.args.clone(), command.hostname.as_deref(), cwd, stdin)
        };
        spec.time_limit = Some(RUN_LIMIT);
        spec.max_output = MAX_OUTPUT_BYTES;
        let uncertain = if command.mutation { WRITE_UNCERTAIN } else { "" };
        match self.exec.run(spec, cancel).await {
            Ok(output) => Ok(GhOutput {
                code: output.code,
                stdout: output.stdout_text(),
                stderr: output.stderr_text(),
            }),
            Err(ScmFailure::Unavailable { .. }) => Err(ScmFailure::Unavailable {
                capability: "gh".into(),
            }),
            Err(ScmFailure::TimedOut { .. }) => Err(ScmFailure::Command {
                domain: GITHUB_DOMAIN,
                text: format!("GitHub CLI did not answer within {} seconds.{uncertain}", RUN_LIMIT.as_secs()),
            }),
            Err(ScmFailure::OutputTooLarge { .. }) => Err(ScmFailure::Command {
                domain: GITHUB_DOMAIN,
                text: format!("GitHub CLI output exceeded {MAX_OUTPUT_BYTES} bytes.{uncertain}"),
            }),
            Err(other) => Err(other),
        }
    }
}
pub struct GhClient {
    pub(crate) runner: Arc<dyn GhRunner>,
    locks: Arc<RepoLocks>,
    /// One FIFO queue per remote repository, nothing shared between keys.
    writes: mixdog_rt::KeyedGate,
}

impl GhClient {
    pub fn new(runner: Arc<dyn GhRunner>, locks: Arc<RepoLocks>) -> Self {
        Self {
            runner,
            locks,
            writes: mixdog_rt::KeyedGate::new(),
        }
    }

    /// The raw answer of `gh` with plain arguments: the exit code is the caller's to read.
    pub async fn output(
        &self,
        cwd: &Path,
        cancel: &CancellationToken,
        args: &[&str],
    ) -> Result<GhOutput, ScmFailure> {
        let mut command = GhCommand::read(args.iter().map(|arg| (*arg).to_owned()).collect(), None);
        command.json = false;
        command.plain = true;
        self.runner.raw(&command, cwd, cancel).await
    }

    /// Runs `gh` with plain arguments (pane operations).
    pub async fn run_args(
        &self,
        cwd: &Path,
        cancel: &CancellationToken,
        args: &[&str],
        mutation: bool,
    ) -> Result<String, ScmFailure> {
        let mut command = GhCommand::read(args.iter().map(|arg| (*arg).to_owned()).collect(), None);
        command.json = false;
        command.mutation = mutation;
        run_text(self.runner.as_ref(), &command, cwd, cancel).await
    }

    pub async fn execute(&self, input: &Value, cwd: &Path, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let mut request = contract::validate(input)?;
        if !cwd.is_absolute() || cwd.to_string_lossy().contains('\0') {
            return Err(ScmFailure::invalid("cwd", "an absolute project directory"));
        }
        let action = request.action();
        if matches!(action, "repo.create" | "repo.clone" | "repo.fork") && request.repo().is_none() {
            return Err(ScmFailure::invalid("repo", "an explicit owner/name"));
        }
        let hostname = request.hostname().to_owned();
        if !contract::is_repo_free(action) && request.repo().is_none() {
            // Every request is bound to a concrete repository before any write is sent.
            let mut probe = GhCommand::read(
                vec!["repo".into(), "view".into(), "--json".into(), "nameWithOwner".into()],
                Some(hostname.clone()),
            );
            probe.json = true;
            let raw = run_text(self.runner.as_ref(), &probe, cwd, cancel).await?;
            let value: Value = serde_json::from_str(&raw)
                .map_err(|_| ScmFailure::Command {
                    domain: GITHUB_DOMAIN,
                    text: "GitHub returned an unreadable response.".into(),
                })?;
            let name = value
                .get("nameWithOwner")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            contract::github_repository(&name)?;
            request.fields.insert("repo".into(), Value::String(name));
        }
        let mut destination: Option<PathBuf> = None;
        if action == "repo.clone" {
            let chosen = clone_destination(request.text("destination").unwrap_or(""))?;
            request
                .fields
                .insert("destination".into(), Value::String(chosen.to_string_lossy().into_owned()));
            destination = Some(chosen);
        }
        let command = commands::build(&request)?;
        let repo_name = request.repo().unwrap_or("").to_owned();
        let write_key = format!("{hostname}/{}", if repo_name.is_empty() { "@account" } else { &repo_name }).to_lowercase();
        let mutates = request.def.write;
        let _turn = if mutates {
            Some(self.writes.enter(&write_key, cancel).await.map_err(|_| ScmFailure::Cancelled)?)
        } else {
            None
        };
        let _repo_guard = if action == "pr.checkout" || action == "repo.clone" {
            // The key is the repository's common dir when `cwd` is in one, else the path itself.
            let key_dir = match &destination {
                Some(dest) => dest.clone(),
                None => crate::repo::discover(cwd).map(|id| id.common_dir).unwrap_or_else(|_| cwd.to_path_buf()),
            };
            Some(self.locks.acquire(&key_dir, None, cancel).await?)
        } else {
            None
        };
        if let Some(dest) = &destination {
            // Reserve the new directory atomically; an intervening creator wins. A failed
            // clone is left in place for recovery, never removed.
            std::fs::create_dir(dest)?;
        }
        let raw = run_text(self.runner.as_ref(), &command, cwd, cancel).await?;
        finish(&request, &command, &repo_name, &hostname, &raw)
    }
}

fn finish(
    request: &GithubRequest,
    command: &GhCommand,
    repo: &str,
    hostname: &str,
    raw: &str,
) -> Result<Value, ScmFailure> {
    let trimmed = raw.trim();
    let data: Value = if command.json && !trimmed.is_empty() {
        serde_json::from_str(trimmed).map_err(|_| ScmFailure::Command {
            domain: GITHUB_DOMAIN,
            text: if command.mutation {
                "The write completed, but its response was unreadable. Inspect remote state; do not replay the write.".into()
            } else {
                "GitHub returned an unreadable response.".into()
            },
        })?
    } else {
        Value::String(trimmed.to_owned())
    };
    if request.action() == "pr.merge" && data.get("merged") == Some(&Value::Bool(false)) {
        let message = data
            .get("message")
            .and_then(Value::as_str)
            .filter(|message| !message.is_empty())
            .unwrap_or("GitHub refused to merge this pull request.");
        return Err(ScmFailure::Command {
            domain: GITHUB_DOMAIN,
            text: message.to_owned(),
        });
    }
    let mut response = json!({ "action": request.action(), "repo": repo, "hostname": hostname, "data": data });
    if command.list {
        let items = match command.collection {
            Some(key) => response["data"].get(key).cloned(),
            None => Some(response["data"].clone()),
        };
        let Some(Value::Array(items)) = items else {
            return Err(ScmFailure::Command {
                domain: GITHUB_DOMAIN,
                text: "GitHub returned an invalid list.".into(),
            });
        };
        let has_more = items.len() as u64 == command.limit;
        // The REST issues list also contains pull requests; paging follows the unfiltered page.
        let shown: Vec<Value> = if request.action() == "issue.list" {
            items
                .into_iter()
                .filter(|item| item.get("pull_request").is_none_or(|v| v.is_null() || v == &Value::Bool(false)))
                .collect()
        } else {
            items
        };
        response["data"] = Value::Array(shown);
        response["page"] = json!(command.page);
        response["hasMore"] = json!(has_more);
    }
    Ok(response)
}

/// A clone destination must be an explicit, absolute, new directory.
fn clone_destination(value: &str) -> Result<PathBuf, ScmFailure> {
    let invalid = || ScmFailure::invalid("destination", "an explicit absolute new directory");
    let path = Path::new(value);
    let unsafe_chars = value.contains(['~', '$', '*', '?', '\0', '\r', '\n']);
    let device_prefix = value.starts_with("\\\\?") || value.starts_with("\\\\.");
    if !path.is_absolute() || unsafe_chars || device_prefix {
        return Err(invalid());
    }
    let home = crate::desktop::home_dir();
    if path.parent().is_none() || path_key(path) == path_key(&home) {
        return Err(ScmFailure::invalid("destination", "a folder that is not a filesystem root or the home directory"));
    }
    match std::fs::symlink_metadata(path) {
        Ok(_) => {
            return Err(ScmFailure::refused(
                "DESTINATION_EXISTS",
                "Clone destination already exists. Choose a new directory; existing files are never removed.",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let parent = path.parent().ok_or_else(invalid)?;
    std::fs::canonicalize(parent)?;
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn writes_to_one_repository_queue_and_others_do_not_wait() {
        let queue = Arc::new(mixdog_rt::KeyedGate::new());
        let cancel = CancellationToken::new();
        let first = queue.enter("h/a", &cancel).await.unwrap();
        let other = tokio::time::timeout(Duration::from_millis(200), queue.enter("h/b", &cancel)).await;
        assert!(other.is_ok(), "a different repository does not wait");
        let waiting = {
            let queue = queue.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move { queue.enter("h/a", &cancel).await.map(drop) })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!waiting.is_finished());
        drop(first);
        assert!(waiting.await.unwrap().is_ok());
        assert!(queue.busy_keys() <= 1);
    }

    #[test]
    fn clone_destinations_must_be_new_absolute_folders() {
        assert!(clone_destination("relative/dir").is_err());
        assert!(clone_destination("/tmp/$HOME/x").is_err());
        let dir = std::env::temp_dir().join(format!("mixdog-clone-{}", std::process::id()));
        assert!(clone_destination(&dir.to_string_lossy()).is_ok());
    }
}
