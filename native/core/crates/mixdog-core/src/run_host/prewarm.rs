//! The startup observations a prompt composition reads (`StartupObservations`): `git status`
//! per repository, `git check-ignore` per listed directory, and the POSIX login-shell tools probe,
//! each run through the process service, as Node's `prewarmGitStartupProbes` and
//! `prewarmShellToolsStartupState` do (1500 ms, `GIT_OPTIONAL_LOCKS=0`, the same argv). A probe that
//! fails leaves its entry out, which the composition renders as Node renders a failed probe.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_rt::{CancellationToken, InLane, InteractiveIo, LaneToken};
use mixdog_core_api::domain::process::{CommandSpec, EnvSpec, OutputMode, OutputStream, ProcessEvent, ProcessManager, ProcessOwner, SpawnRequest};
use mixdog_protocol::ProcessHandle;

use mixdog_core_prompt::prompt::probes::ProbeRequest;
use mixdog_core_prompt::prompt::probes::StartupObservations;
use mixdog_core_prompt::prompt::real_sources::SHELL_TOOL_STARTUP_NAMES;

const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
static NEXT: AtomicU64 = AtomicU64::new(0);

struct Captured {
    /// The exit code; `None` when the process was killed or could not run.
    code: Option<i32>,
    stdout: Vec<u8>,
    /// The output went past the cap (the process is killed then).
    overflow: bool,
}

/// Runs `program` to completion, `stdin` fed and closed, stdout read up to `max_bytes`. `None`:
/// the spawn failed or the time limit ended it.
async fn capture(
    processes: &dyn ProcessManager,
    program: &str,
    args: Vec<String>,
    cwd: &Path,
    env: EnvSpec,
    stdin: Option<Vec<u8>>,
    max_bytes: usize,
) -> Option<Captured> {
    let handle = ProcessHandle::from(format!("startup-probe-{}", NEXT.fetch_add(1, Ordering::Relaxed)));
    let request = SpawnRequest {
        handle: handle.clone(),
        command: CommandSpec::Argv { program: program.to_owned(), args },
        cwd: AbsPath::new(cwd.to_path_buf())?,
        env,
        pty: None,
        stdin_piped: stdin.is_some(),
        output: OutputMode::Separate,
        owner: ProcessOwner::Internal,
        time_limit: Some(PROBE_TIMEOUT),
    };
    processes.spawn(request).await.ok()?;
    let mut events = processes.subscribe(&handle, None).ok()?;
    if let Some(bytes) = stdin {
        processes.write_stdin(&handle, bytes).await.ok()?;
        processes.close_stdin(&handle).ok()?;
    }
    let mut out = Captured { code: None, stdout: Vec::new(), overflow: false };
    while let Some(event) = events.next().await {
        match event {
            ProcessEvent::Output { stream: OutputStream::Stdout, bytes, .. } => {
                out.stdout.extend_from_slice(&bytes);
                if out.stdout.len() > max_bytes && !out.overflow {
                    out.overflow = true;
                    let _ = processes.kill(&handle);
                }
            }
            ProcessEvent::Output { .. } => {}
            ProcessEvent::Exited { exit, .. } => {
                out.code = match (exit.status, exit.killed) {
                    (mixdog_core_api::domain::process::ExitStatus::Code(code), None) => Some(code),
                    _ => None,
                };
                break;
            }
        }
    }
    Some(out)
}

fn git_env() -> EnvSpec {
    EnvSpec { inherit: true, set: vec![("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned())], remove: Vec::new() }
}

/// `findRepositoryRoot`: the nearest ancestor holding `.git` (a directory, or a worktree's file).
/// `_probeRepositoryChangeState`.
async fn change_state(processes: &dyn ProcessManager, root: &Path) -> Option<String> {
    let args = ["--no-optional-locks", "-C", &root.to_string_lossy(), "status", "--porcelain=v1", "--untracked-files=normal"].map(str::to_owned).to_vec();
    let result = capture(processes, "git", args, root, git_env(), None, 64 * 1024).await?;
    // Porcelain output past the cap cannot be an empty (clean) listing.
    if result.overflow {
        return Some("changes present".to_owned());
    }
    (result.code == Some(0)).then(|| if String::from_utf8_lossy(&result.stdout).trim().is_empty() { "clean" } else { "changes present" }.to_owned())
}

/// `_probeGitIgnoredEntries`: exit 1 is "nothing ignored", not a failure.
async fn ignored_entries(processes: &dyn ProcessManager, directory: &Path, names: &[String]) -> HashSet<String> {
    let args = ["--no-optional-locks", "-C", &directory.to_string_lossy(), "check-ignore", "--stdin", "-z"].map(str::to_owned).to_vec();
    let input = names.iter().flat_map(|n| n.bytes().chain(std::iter::once(0))).collect::<Vec<u8>>();
    let Some(result) = capture(processes, "git", args, directory, git_env(), Some(input), 1024 * 1024).await else { return HashSet::new() };
    if result.overflow || !matches!(result.code, Some(0 | 1)) {
        return HashSet::new();
    }
    String::from_utf8_lossy(&result.stdout).split('\0').filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

/// `_posixStartupShell`, looked up in an io-interactive lane job.
#[allow(clippy::disallowed_methods, reason = "takes the lane's proof: it runs inside a lane job body")]
fn shell_candidate(_lane: &InLane<InteractiveIo>) -> Option<&'static str> {
    ["/bin/bash", "/usr/bin/bash", "/bin/sh"].into_iter().find(|candidate| Path::new(candidate).is_file())
}

/// `_probeShellToolsStartupStateAsync` on POSIX: `<shell> -lc 'command -v <names>'`, the line of what
/// was found. A non-zero exit (a name is missing) still answers; a spawn failure, timeout or
/// overflow does not.
async fn posix_shell_tools(io: &ToolIo, processes: &dyn ProcessManager, path_env: &str) -> String {
    let Ok(job) = io.interactive.submit(&CancellationToken::new(), shell_candidate) else { return String::new() };
    let Some(shell) = job.await.ok().flatten() else { return String::new() };
    let wanted = SHELL_TOOL_STARTUP_NAMES;
    let env = EnvSpec { inherit: true, set: vec![("PATH".to_owned(), path_env.to_owned())], remove: Vec::new() };
    let args = vec!["-lc".to_owned(), format!("command -v {}", wanted.join(" "))];
    let Some(result) = capture(processes, shell, args, Path::new("/"), env, None, 64 * 1024).await else { return String::new() };
    if result.overflow || result.code.is_none() {
        return String::new();
    }
    let stdout = String::from_utf8_lossy(&result.stdout);
    let found: HashSet<&str> = stdout.lines().filter_map(|line| line.trim().rsplit('/').next()).filter(|base| wanted.contains(base)).collect();
    let list = |present: bool| {
        let names: Vec<&str> = wanted.iter().copied().filter(|n| found.contains(n) == present).collect();
        if names.is_empty() { "(none)".to_owned() } else { names.join(" ") }
    };
    format!("- Shell tools at startup: {}; absent: {}.", list(true), list(false))
}

/// Runs the probes of a composition through the process service and records their answers.
pub struct StartupProbes {
    io: ToolIo,
    processes: Arc<dyn ProcessManager>,
    /// The shell-tools PATHs observed (the other answers are asked of the observations themselves).
    recorded: Mutex<HashSet<String>>,
}

impl StartupProbes {
    pub fn new(io: ToolIo, processes: Arc<dyn ProcessManager>) -> Self {
        Self { io, processes, recorded: Mutex::new(HashSet::new()) }
    }

    fn recorded(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.recorded.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The POSIX shell-tools line for `path_env`, observed once per PATH (Windows composes its
    /// line from the PATH itself).
    pub async fn ensure_shell_tools(&self, observed: &StartupObservations, path_env: &str) {
        if cfg!(windows) || !self.recorded().insert(format!("s:{path_env}")) {
            return;
        }
        let line = posix_shell_tools(&self.io, self.processes.as_ref(), path_env).await;
        observed.record_shell_tools(path_env, &line);
    }

    async fn run(&self, observed: &StartupObservations, request: &ProbeRequest, prewarm: bool) {
        match request {
            ProbeRequest::ChangeState { root } => {
                let state = change_state(self.processes.as_ref(), Path::new(root)).await;
                observed.record_change_state(root, state, prewarm);
            }
            ProbeRequest::Ignored { directory, names } => {
                let ignored = ignored_entries(self.processes.as_ref(), Path::new(directory), names).await;
                observed.record_ignored(directory, names.clone(), ignored, prewarm);
            }
        }
    }

    /// Records the answers of what a composition asked for and never had one: those are the cold
    /// first uses, which Node probes at once. The requests that refresh a recorded answer are
    /// returned for [`Self::refresh`]. `true` when anything was recorded.
    pub async fn settle(&self, observed: &StartupObservations, requests: Vec<ProbeRequest>) -> (bool, Vec<ProbeRequest>) {
        let (cold, refresh): (Vec<_>, Vec<_>) = requests.into_iter().partition(|r| !observed.answers(r));
        futures::future::join_all(cold.iter().map(|request| self.run(observed, request, true))).await;
        (!cold.is_empty(), refresh)
    }

    /// The background refreshes after a use: each serves the next session.
    pub async fn refresh(&self, observed: &StartupObservations, requests: Vec<ProbeRequest>) {
        futures::future::join_all(requests.iter().map(|request| self.run(observed, request, false))).await;
    }
}
/// The host facts of a composition (`HostFacts` without the borrows).
pub struct PromptFacts {
    pub plugin_root: std::path::PathBuf,
    pub data_dir: std::path::PathBuf,
    /// `os.homedir()`.
    pub home_dir: std::path::PathBuf,
    /// `process.env.PATH`.
    pub path_env: String,
    /// `readSection('agent').instructionFiles`.
    pub stored_instruction_files: Option<serde_json::Value>,
}

impl PromptFacts {
    /// The facts from the process: the home folder, PATH, and the instruction-files override.
    pub fn from_process(plugin_root: std::path::PathBuf, data_dir: std::path::PathBuf, stored_instruction_files: Option<serde_json::Value>) -> Self {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(std::path::PathBuf::from).unwrap_or_default();
        Self { plugin_root, data_dir, home_dir: home, path_env: std::env::var("PATH").unwrap_or_default(), stored_instruction_files }
    }

    /// `featureEnvOverride('MIXDOG_BOOT_INSTRUCTION_FILES') === false`.
    fn forced_off() -> bool {
        let raw = std::env::var("MIXDOG_BOOT_INSTRUCTION_FILES").unwrap_or_default().trim().to_lowercase();
        matches!(raw.as_str(), "0" | "false" | "no" | "off")
    }
}

/// A composition run inside an io-interactive lane job, given the host facts and the probes.
pub type ComposeJob<R> = Arc<dyn for<'a> Fn(&'a mixdog_rt::InLane<mixdog_rt::InteractiveIo>, mixdog_core_prompt::prompt::real_sources::HostFacts<'a>, &'a StartupObservations) -> R + Send + Sync>;

async fn in_lane<R: Send + 'static>(io: &ToolIo, facts: &Arc<PromptFacts>, observed: &Arc<StartupObservations>, job: &ComposeJob<R>) -> Result<R, String> {
    let (facts, observed, job) = (facts.clone(), observed.clone(), job.clone());
    let dropped = || "the prompt composition job was dropped".to_owned();
    io.interactive
        .submit(&mixdog_rt::CancellationToken::new(), move |lane| {
            let host = mixdog_core_prompt::prompt::real_sources::HostFacts {
                plugin_root: &facts.plugin_root,
                data_dir: &facts.data_dir,
                home_dir: &facts.home_dir,
                path_env: &facts.path_env,
                locale: &mixdog_js::default_locale_tag(),
                instruction_files_forced_off: PromptFacts::forced_off(),
                stored_instruction_files: facts.stored_instruction_files.as_ref(),
            };
            job(lane, host, &observed)
        })
        .map_err(|_| dropped())?
        .await
        .map_err(|_| dropped())
}

/// One composition: the shell-tools line first, then the composition; what it asked for and never
/// had is probed and recorded and the composition run again (Node's cold first use probes at once);
/// the refreshes of recorded answers run in the background afterwards.
pub async fn compose<R: Send + 'static>(
    io: &ToolIo,
    probes: &Arc<StartupProbes>,
    observed: &Arc<StartupObservations>,
    facts: Arc<PromptFacts>,
    job: ComposeJob<R>,
) -> Result<R, String> {
    probes.ensure_shell_tools(observed, &facts.path_env).await;
    let first = in_lane(io, &facts, observed, &job).await?;
    let (recorded, mut refresh) = probes.settle(observed, observed.take_requests()).await;
    let result = if recorded { in_lane(io, &facts, observed, &job).await? } else { first };
    for request in observed.take_requests() {
        if !refresh.contains(&request) {
            refresh.push(request);
        }
    }
    if !refresh.is_empty() {
        let (probes, observed) = (probes.clone(), observed.clone());
        drop(mixdog_rt::spawn("startup-probe-refresh", mixdog_rt::TaskClass::Work, async move { probes.refresh(&observed, refresh).await }));
    }
    Ok(result)
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup builds a real repository")]
mod tests {
    use std::process::Command;

    use mixdog_agent::env::Clock;
    use mixdog_core_api::domain::tool::ToolIo;

    use super::*;
    use crate::run_host::prompt_session::compose_session_prompt;
    use crate::run_host::prompt_session::PromptPaths;
    use crate::run_host::prompt_session::SessionPromptInput;

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            1_700_000_000_000
        }
    }

    /// A session in a repository the process never saw gets the repository's real git line on its
    /// first composition, not the failed-probe rendering.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[allow(clippy::disallowed_methods, reason = "a test builds a real repository")]
    async fn a_first_session_in_a_new_repository_gets_the_git_lines() {
        let repo = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(repo.path()).output().unwrap().status.success(), "git {args:?}");
        git(&["init", "-q"]);
        std::fs::write(repo.path().join("note.txt"), "x").unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
        let processes: Arc<dyn ProcessManager> = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
        let probes = Arc::new(StartupProbes::new(io, processes));
        let observed = Arc::new(StartupObservations::new(Arc::new(Fixed)));
        let data = tempfile::tempdir().unwrap();
        let facts = Arc::new(PromptFacts::from_process(data.path().to_path_buf(), data.path().to_path_buf(), None));
        let cwd = repo.path().to_string_lossy().into_owned();
        let job: ComposeJob<String> = Arc::new(move |lane, host, observed| {
            let sources = mixdog_core_prompt::prompt::real_sources::RealSources::new(lane, host, observed);
            let input = SessionPromptInput { session_id: "s1", provider: "anthropic", model: "claude", cwd: Some(&cwd), has_git_tool: true, ..Default::default() };
            let paths = PromptPaths { plugin_root: host.plugin_root, data_dir: host.data_dir };
            compose_session_prompt(&input, &paths, &sources).environment_tail
        });
        let tail = compose(&io, &probes, &observed, facts, job).await.unwrap();
        assert!(tail.contains("Git startup state:"), "{tail}");
        assert!(tail.contains("changes present"), "{tail}");
        assert!(!tail.contains("was not inside a git repository"), "{tail}");
    }
}