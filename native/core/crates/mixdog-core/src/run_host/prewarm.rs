//! The startup observations a prompt composition reads (`StartupObservations`): `git status`
//! per repository, `git check-ignore` per listed directory, and the POSIX login-shell tools probe,
//! each run through the process service, as Node's `prewarmGitStartupProbes` and
//! `prewarmShellToolsStartupState` do (1500 ms, `GIT_OPTIONAL_LOCKS=0`, the same argv). A probe that
//! fails leaves its entry out, which the composition renders as Node renders a failed probe.
//!
//! And the composition itself ([`compose`]): its source files are read on the io-interactive lane
//! into an owned snapshot, and the prompt is assembled from the snapshot on the cpu-interactive lane.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::process::{CommandSpec, EnvSpec, OutputMode, OutputStream, ProcessEvent, ProcessManager, ProcessOwner, SpawnRequest};
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_protocol::ProcessHandle;
use mixdog_rt::{CancellationToken, CpuInteractive, InLane, InteractiveIo, JobDropped, LaneToken, SubmitWaitError};

use super::prompt_session::PromptPaths;
use mixdog_core_prompt::prompt::probes::ProbeRequest;
use mixdog_core_prompt::prompt::probes::StartupObservations;
use mixdog_core_prompt::prompt::real_sources::HostFacts;
use mixdog_core_prompt::prompt::real_sources::RealSources;
use mixdog_core_prompt::prompt::real_sources::SHELL_TOOL_STARTUP_NAMES;
use mixdog_core_prompt::prompt::real_sources::SourceFacts;
use mixdog_core_prompt::prompt::real_sources::SourceWants;
use mixdog_core_prompt::prompt::source_files::FileReads;
use mixdog_core_prompt::prompt::source_files::FileSnapshot;

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
    let mut events = processes.subscribe_holding(&handle, None).ok()?;
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
/// overflow does not. `Err` is a shell lookup that did not run (cancelled, or the lane could not).
async fn posix_shell_tools(io: &ToolIo, processes: &dyn ProcessManager, path_env: &str, cancel: &CancellationToken) -> Result<String, String> {
    let lookup = |lane: &InLane<InteractiveIo>| shell_candidate(lane).map(str::to_owned);
    let Some(shell) = waited(io.interactive, cancel, "shell lookup", lookup).await? else { return Ok(String::new()) };
    let wanted = SHELL_TOOL_STARTUP_NAMES;
    let env = EnvSpec { inherit: true, set: vec![("PATH".to_owned(), path_env.to_owned())], remove: Vec::new() };
    let args = vec!["-lc".to_owned(), format!("command -v {}", wanted.join(" "))];
    let Some(result) = capture(processes, &shell, args, Path::new("/"), env, None, 64 * 1024).await else { return Ok(String::new()) };
    if result.overflow || result.code.is_none() {
        return Ok(String::new());
    }
    let stdout = String::from_utf8_lossy(&result.stdout);
    let found: HashSet<&str> = stdout.lines().filter_map(|line| line.trim().rsplit('/').next()).filter(|base| wanted.contains(base)).collect();
    let list = |present: bool| {
        let names: Vec<&str> = wanted.iter().copied().filter(|n| found.contains(n) == present).collect();
        if names.is_empty() { "(none)".to_owned() } else { names.join(" ") }
    };
    Ok(format!("- Shell tools at startup: {}; absent: {}.", list(true), list(false)))
}

/// Runs the probes of a composition through the process service and records their answers; holds
/// the lane a composition is assembled on.
pub struct StartupProbes {
    io: ToolIo,
    /// The lane [`compose`] assembles a prompt on.
    assembly: CpuInteractive,
    processes: Arc<dyn ProcessManager>,
    /// The shell-tools line of each PATH, looked up once (the other answers are asked of the observations
    /// themselves).
    shell_lookups: Mutex<HashMap<String, Arc<tokio::sync::OnceCell<String>>>>,
}

impl StartupProbes {
    pub fn new(io: ToolIo, assembly: CpuInteractive, processes: Arc<dyn ProcessManager>) -> Self {
        Self { io, assembly, processes, shell_lookups: Mutex::default() }
    }

    /// The POSIX shell-tools line for `path_env`, observed once per PATH (Windows composes its
    /// line from the PATH itself). Compositions that ask for the same PATH together share one lookup, and each
    /// records the line for the PATH it composes with: the observations hold one PATH's line at a time. A lookup
    /// that did not run, or a composition dropped while it looked, leaves it to the next one that asks; a
    /// composition waiting on another's lookup leaves on its own cancellation.
    pub async fn ensure_shell_tools(&self, observed: &StartupObservations, path_env: &str, cancel: &CancellationToken) -> Result<(), String> {
        if cfg!(windows) {
            return Ok(());
        }
        let lookup = self.shell_lookups.lock().unwrap_or_else(std::sync::PoisonError::into_inner).entry(path_env.to_owned()).or_default().clone();
        let line = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err("the prompt composition was cancelled".to_owned()),
            line = lookup.get_or_try_init(|| posix_shell_tools(&self.io, self.processes.as_ref(), path_env, cancel)) => line?,
        };
        observed.record_shell_tools(path_env, line);
        Ok(())
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
/// `os.homedir()`: the environment's home folder when it is set and not empty, else the account's (the passwd entry on
/// Unix, where HOME may be unset).
fn resolve_home(env: Option<std::ffi::OsString>, account: impl FnOnce() -> Option<std::path::PathBuf>) -> std::path::PathBuf {
    env.filter(|home| !home.is_empty()).map(std::path::PathBuf::from).or_else(account).unwrap_or_default()
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
        // `os.homedir()`: the environment's home folder, else (Unix, HOME unset) the account's passwd entry.
        let home = resolve_home(std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }), std::env::home_dir);
        Self { plugin_root, data_dir, home_dir: home, path_env: std::env::var("PATH").unwrap_or_default(), stored_instruction_files }
    }

    /// `featureEnvOverride('MIXDOG_BOOT_INSTRUCTION_FILES') === false`.
    fn forced_off() -> bool {
        let raw = std::env::var("MIXDOG_BOOT_INSTRUCTION_FILES").unwrap_or_default().trim().to_lowercase();
        matches!(raw.as_str(), "0" | "false" | "no" | "off")
    }

    fn host<'a>(&'a self, locale: &'a str) -> HostFacts<'a> {
        HostFacts {
            plugin_root: &self.plugin_root,
            data_dir: &self.data_dir,
            home_dir: &self.home_dir,
            path_env: &self.path_env,
            locale,
            instruction_files_forced_off: Self::forced_off(),
            stored_instruction_files: self.stored_instruction_files.as_ref(),
        }
    }
}

/// A composition's assembly from what was read: the paths (whose files are the snapshot) and the sources over it.
pub type Assemble<R> = Arc<dyn Fn(PromptPaths<'_>, &RealSources<'_>) -> R + Send + Sync>;

/// A composition: what it reads and how it is assembled from that.
pub struct ComposeJob<R> {
    /// The session's agent and folder, whose source files are read.
    pub wants: SourceWants,
    /// The composition's own reads besides the sources', through `paths.files` (a session prompt's are
    /// `prompt_session::read_session_prompt_files`).
    pub reads: Arc<dyn Fn(PromptPaths<'_>) + Send + Sync>,
    pub assemble: Assemble<R>,
}

/// What a composition read, owned: the files it can ask for and the facts only the lane gives.
struct Read {
    files: FileSnapshot,
    facts: SourceFacts,
}

/// Runs `job` on `lane` once the lane has room, under `cancel`. Each way it can fail is its own error:
/// cancelled, not admitted (the lane shut down or has no healthy worker), and admitted without a result.
// The future is declared `Send` here, where the job's type is concrete: callers behind `async_trait` cannot prove it
// for the higher-ranked job closure themselves.
fn waited<'a, L, R, F>(lane: L, cancel: &'a CancellationToken, stage: &'static str, job: F) -> impl std::future::Future<Output = Result<R, String>> + Send + 'a
where
    L: LaneToken,
    R: Send + 'static,
    F: FnOnce(&InLane<L>) -> R + Send + 'static,
{
    async move {
        let cancelled = || "the prompt composition was cancelled".to_owned();
        let name = L::KIND.name();
        let handle = lane.submit_wait(cancel, job).await.map_err(|error| match error {
            SubmitWaitError::Cancelled => cancelled(),
            SubmitWaitError::ShutDown(_) => format!("the prompt composition's {stage} was not admitted: lane {name} shut down"),
            SubmitWaitError::Wedged(_) => format!("the prompt composition's {stage} was not admitted: lane {name} has no healthy worker"),
            SubmitWaitError::Full(_) => format!("the prompt composition's {stage} was refused: lane {name} is full"),
        })?;
        handle.await.map_err(|dropped| match dropped {
            JobDropped::Cancelled => cancelled(),
            JobDropped::ShutDown => format!("the prompt composition's {stage} was admitted, but lane {name} shut down before it ran"),
            JobDropped::Wedged => format!("the prompt composition's {stage} was admitted, but lane {name} has no healthy worker to run it"),
            JobDropped::NotStarted => format!("the prompt composition's {stage} was admitted, but lane {name} could not start its thread"),
            JobDropped::Dropped => format!("the prompt composition's {stage} was admitted, but its result was lost"),
        })
    }
}

async fn read_sources<R>(
    io: &ToolIo,
    facts: &Arc<PromptFacts>,
    observed: &Arc<StartupObservations>,
    job: &ComposeJob<R>,
    cancel: &CancellationToken,
) -> Result<Read, String> {
    let (facts, observed, wants, reads) = (facts.clone(), observed.clone(), job.wants.clone(), job.reads.clone());
    waited(io.interactive, cancel, "source read", move |lane| {
        let locale = mixdog_js::default_locale_tag();
        let files = FileReads::new(lane);
        let source_facts = SourceFacts::read(lane, &files, facts.host(&locale), &observed, &wants);
        reads(PromptPaths { plugin_root: &facts.plugin_root, data_dir: &facts.data_dir, files: &files });
        Read { files: files.snapshot(), facts: source_facts }
    })
    .await
}

async fn assemble<R: Send + 'static>(
    probes: &StartupProbes,
    facts: &Arc<PromptFacts>,
    observed: &Arc<StartupObservations>,
    read: &Arc<Read>,
    assembly: &Assemble<R>,
    cancel: &CancellationToken,
) -> Result<R, String> {
    let (facts, observed, read, assembly) = (facts.clone(), observed.clone(), read.clone(), assembly.clone());
    waited(probes.assembly, cancel, "assembly", move |_lane| {
        let locale = mixdog_js::default_locale_tag();
        let sources = RealSources::new(&read.files, &read.facts, facts.host(&locale), &observed);
        let assembled = assembly(PromptPaths { plugin_root: &facts.plugin_root, data_dir: &facts.data_dir, files: &read.files }, &sources);
        match read.files.gap().or_else(|| read.facts.gap()) {
            Some(question) => Err(format!("the prompt composition asked {question}, which its source read did not cover")),
            None => Ok(assembled),
        }
    })
    .await?
}

/// One composition, every lane wait under `cancel`: the shell-tools line first, then the source files
/// are read on the io-interactive lane and the composition is assembled from them on the
/// cpu-interactive lane; what it asked for and never had is probed and recorded and it is assembled
/// again from the same reads (Node's cold first use probes at once); the refreshes of recorded
/// answers run in the background afterwards.
pub async fn compose<R: Send + 'static>(
    io: &ToolIo,
    probes: &Arc<StartupProbes>,
    observed: &Arc<StartupObservations>,
    facts: Arc<PromptFacts>,
    cancel: &CancellationToken,
    job: ComposeJob<R>,
) -> Result<R, String> {
    if job.wants.shell_tools {
        probes.ensure_shell_tools(observed, &facts.path_env, cancel).await?;
    }
    let read = Arc::new(read_sources(io, &facts, observed, &job, cancel).await?);
    let first = assemble(probes, &facts, observed, &read, &job.assemble, cancel).await?;
    let (recorded, mut refresh) = probes.settle(observed, observed.take_requests()).await;
    let result = if recorded { assemble(probes, &facts, observed, &read, &job.assemble, cancel).await? } else { first };
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
    use crate::run_host::prompt_session::PromptPaths;
    use crate::run_host::prompt_session::SessionPrompt;
    use crate::run_host::prompt_session::SessionPromptInput;
    use crate::run_host::prompt_session::compose_session_prompt;
    use crate::run_host::prompt_session::read_session_prompt_files;
    use crate::run_host::prompt_session::session_prompt_wants;
    use mixdog_core_prompt::prompt::source_files::LiveFiles;
    use mixdog_core_prompt::prompt::source_files::PromptFiles;

    struct Fixed;
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            1_700_000_000_000
        }
    }

    fn probes_for(tokens: &mixdog_rt::LaneTokens) -> (ToolIo, Arc<StartupProbes>) {
        let io = ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io };
        let processes: Arc<dyn ProcessManager> = Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default()));
        (io, Arc::new(StartupProbes::new(io, tokens.cpu_interactive, processes)))
    }

    /// A session prompt's composition for `cwd`, the environment tail of it.
    fn tail_input(cwd: &Option<String>, has_git_tool: bool) -> SessionPromptInput<'_> {
        SessionPromptInput { session_id: "s1", provider: "anthropic", model: "claude", cwd: cwd.as_deref(), has_git_tool, ..Default::default() }
    }

    fn tail_job(cwd: Option<String>, has_git_tool: bool) -> ComposeJob<String> {
        let (read_cwd, assemble_cwd) = (cwd.clone(), cwd.clone());
        ComposeJob {
            wants: session_prompt_wants(&tail_input(&cwd, has_git_tool)),
            reads: Arc::new(move |paths: PromptPaths<'_>| read_session_prompt_files(&tail_input(&read_cwd, has_git_tool), &paths)),
            assemble: Arc::new(move |paths: PromptPaths<'_>, sources: &RealSources<'_>| {
                compose_session_prompt(&tail_input(&assemble_cwd, has_git_tool), &paths, sources).environment_tail
            }),
        }
    }

    /// A composition whose assembly reads `asked`, after a read step that read `read` (each a file of the data folder).
    fn reading_job(read: Option<&'static str>, asked: &'static str) -> ComposeJob<Option<Vec<u8>>> {
        ComposeJob {
            wants: SourceWants::default(),
            reads: Arc::new(move |paths: PromptPaths<'_>| {
                if let Some(file) = read {
                    paths.files.read(&paths.data_dir.join(file));
                }
            }),
            assemble: Arc::new(move |paths: PromptPaths<'_>, _: &RealSources<'_>| paths.files.read(&paths.data_dir.join(asked))),
        }
    }

    fn composition_parts() -> (ToolIo, Arc<StartupProbes>, Arc<StartupObservations>, Arc<PromptFacts>, tempfile::TempDir) {
        let tokens = mixdog_rt::testing::tokens();
        let (io, probes) = probes_for(&tokens);
        let observed = Arc::new(StartupObservations::new(Arc::new(Fixed)));
        let data = tempfile::tempdir().unwrap();
        let facts = Arc::new(PromptFacts::from_process(data.path().to_path_buf(), data.path().to_path_buf(), None));
        (io, probes, observed, facts, data)
    }

    /// An assembly that asks for a file its read step did not read fails the composition, naming the file; one that asks
    /// for a file the read step found absent composes with it absent.
    #[tokio::test]
    async fn an_assembly_that_asks_for_an_unread_file_fails_naming_it() {
        let (io, probes, observed, facts, _data) = composition_parts();
        let cancel = CancellationToken::new();
        let error = compose(&io, &probes, &observed, facts.clone(), &cancel, reading_job(None, "ungathered.md")).await.unwrap_err();
        assert!(error.contains(&facts.data_dir.join("ungathered.md").display().to_string()), "{error}");
        let absent = compose(&io, &probes, &observed, facts, &cancel, reading_job(Some("absent.md"), "absent.md")).await.unwrap();
        assert_eq!(absent, None);
    }

    /// A composition that meets a full cpu-interactive lane waits for room and is assembled; it is not refused.
    #[tokio::test]
    async fn a_composition_at_a_full_compute_lane_waits_for_room() {
        let (io, probes, observed, facts, _data) = composition_parts();
        let held = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::CpuInteractive);
        let cancel = CancellationToken::new();
        let composing = compose(&io, &probes, &observed, facts, &cancel, tail_job(None, false));
        tokio::pin!(composing);
        tokio::select! {
            biased;
            done = &mut composing => panic!("the composition ended while its lane was full: {done:?}"),
            () = held.met_by_a_submit() => {}
        }
        drop(held);
        let tail = composing.await.unwrap();
        assert!(tail.contains("- Shell: "), "{tail}");
    }

    /// A composition cancelled while it waits for a full lane ends as cancelled.
    #[tokio::test]
    async fn a_composition_cancelled_while_it_waits_ends_cancelled() {
        let (io, probes, observed, facts, _data) = composition_parts();
        let held = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
        let cancel = CancellationToken::new();
        let composing = compose(&io, &probes, &observed, facts, &cancel, tail_job(None, false));
        tokio::pin!(composing);
        tokio::select! {
            biased;
            done = &mut composing => panic!("the composition ended while its lane was full: {done:?}"),
            () = held.met_by_a_submit() => {}
        }
        cancel.cancel();
        assert_eq!(composing.await.unwrap_err(), "the prompt composition was cancelled");
        drop(held);
    }

    fn write_world(root: &Path, files: &[(&str, &str)]) {
        for (path, text) in files {
            let target = root.join(path);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(target, text).unwrap();
        }
    }

    /// The composition reads its sources once and is assembled from what it read: over the shipped rules and a world
    /// with agents, a bot store, Mixy's folder, output styles and instruction files, the prompt of each kind of session
    /// is the one composed from the disk itself.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_prompt_assembled_from_its_reads_is_the_one_read_from_the_disk() {
        let world = tempfile::tempdir().unwrap();
        let (data, home, repo) = (world.path().join("data"), world.path().join("home"), world.path().join("repo"));
        write_world(
            &data,
            &[
                ("agents/helper/AGENT.md", "---\nname: helper\n---\nHelps with chores."),
                ("agents/helper/PERSONA.md", "Calm."),
                ("agents/reviewer.md", "Reviews changes."),
                ("bots/migration.json", "{\"version\":1,\"bots\":[\"helper\"]}"),
                ("bots/helper/AGENT.md", "Bot role."),
                ("bots/helper/agent.json", "{\"name\":\"Helper Bot\",\"description\":\"Helps out.\"}"),
                ("bots/helper/PERSONA.md", "Kind."),
                ("bots/mixy/AGENT.md", "Mixy's role."),
                ("bots/mixy/PERSONA.md", "Warm."),
                ("bots/mixy/agent.json", "{\"name\":\"Mixy\"}"),
                ("output-styles/custom.md", "---\nname: custom\n---\nBe custom."),
                ("output-styles/common.md", "Shared format."),
            ],
        );
        write_world(&home, &[(".codex/AGENTS.md", "Global agents."), (".claude/CLAUDE.md", "Global claude.")]);
        write_world(
            &repo,
            &[
                (".git/HEAD", "ref: refs/heads/main\n"),
                ("AGENTS.md", "Project agents."),
                ("CLAUDE.md", "Project claude."),
                ("src/lib.rs", ""),
                ("notes.txt", ""),
            ],
        );
        let plugin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../src");
        let facts = PromptFacts {
            plugin_root: plugin,
            data_dir: data,
            home_dir: home,
            path_env: std::env::var("PATH").unwrap_or_default(),
            stored_instruction_files: None,
        };
        let cwd = repo.to_string_lossy().into_owned();
        let config = serde_json::json!({ "instructionFiles": "all", "outputStyle": "custom", "agent": { "profile": { "title": "Boss" } } });
        let tokens = mixdog_rt::testing::tokens();
        let composed = tokens
            .interactive_io
            .submit(&CancellationToken::new(), move |lane| {
                let observed = StartupObservations::new(Arc::new(Fixed));
                let locale = mixdog_js::default_locale_tag();
                let host = facts.host(&locale);
                // (agent, owner is an agent, agent mode, a role without tools)
                let cases = [
                    (None, false, false, false),
                    (Some("helper"), false, true, false),
                    (Some("helper"), true, false, false),
                    (Some("lead"), false, true, false),
                    (Some("helper"), true, false, true),
                ];
                let no_tools: Vec<String> = Vec::new();
                let mut prompts: Vec<(SessionPrompt, SessionPrompt, String, String)> = Vec::new();
                for (agent, owner_is_agent, agent_mode, tool_free_role) in cases {
                    let input = SessionPromptInput {
                        session_id: "s1",
                        provider: "anthropic",
                        model: "claude-sonnet-4-5",
                        agent,
                        owner_is_agent,
                        agent_mode,
                        tool_free_role,
                        allow_tools: tool_free_role.then_some(no_tools.as_slice()),
                        has_git_tool: !tool_free_role,
                        cwd: Some(&cwd),
                        config: Some(&config),
                        ..Default::default()
                    };
                    let stamp = agent.filter(|_| !owner_is_agent).map(|agent| (agent.to_owned(), agent_mode));
                    let reads = FileReads::new(lane);
                    let wants = SourceWants { profile_revision: stamp.clone(), ..session_prompt_wants(&input) };
                    let source_facts = SourceFacts::read(lane, &reads, host, &observed, &wants);
                    read_session_prompt_files(&input, &PromptPaths { plugin_root: &facts.plugin_root, data_dir: &facts.data_dir, files: &reads });
                    let snapshot = reads.snapshot();
                    let over = |files: &dyn PromptFiles| {
                        let sources = RealSources::new(files, &source_facts, host, &observed);
                        let paths = PromptPaths { plugin_root: &facts.plugin_root, data_dir: &facts.data_dir, files };
                        let revision = stamp.as_ref().map(|(agent, mixy)| sources.agent_profile_revision(agent, *mixy)).unwrap_or_default();
                        (compose_session_prompt(&input, &paths, &sources), revision)
                    };
                    let (disk, disk_revision) = over(&LiveFiles);
                    let (read, read_revision) = over(&snapshot);
                    assert_eq!((snapshot.gap(), source_facts.gap()), (None, None), "case {agent:?} {owner_is_agent} {agent_mode} {tool_free_role}");
                    prompts.push((disk, read, disk_revision, read_revision));
                }
                prompts
            })
            .unwrap()
            .await
            .unwrap();
        for (disk, read, disk_revision, read_revision) in &composed {
            assert_eq!(disk, read);
            assert_eq!(disk_revision, read_revision);
        }
        let lead = composed[0].1.blocks.core.as_deref().unwrap_or_default();
        assert!(lead.contains("Project agents.") && lead.contains("Global claude."), "{lead}");
        assert!(composed[0].1.environment_tail.contains("on branch main"), "{}", composed[0].1.environment_tail);
        let bot = composed[1].1.blocks.core.as_deref().unwrap_or_default();
        assert!(bot.contains("You are Helper Bot. Your role: Helps out.") && bot.contains("Kind."), "{bot}");
        assert!(composed[3].1.blocks.core.as_deref().unwrap_or_default().contains("Warm."));
        assert_eq!(composed[4].1.environment_tail, "");
    }

    /// A composition that meets a full io-interactive lane waits for room and composes; it is not refused.
    #[tokio::test]
    async fn a_composition_at_a_full_lane_waits_for_room() {
        let tokens = mixdog_rt::testing::tokens();
        let (io, probes) = probes_for(&tokens);
        let observed = Arc::new(StartupObservations::new(Arc::new(Fixed)));
        let data = tempfile::tempdir().unwrap();
        let facts = Arc::new(PromptFacts::from_process(data.path().to_path_buf(), data.path().to_path_buf(), None));
        let held = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
        let cancel = CancellationToken::new();
        let composing = compose(&io, &probes, &observed, facts, &cancel, tail_job(None, false));
        tokio::pin!(composing);
        tokio::select! {
            biased;
            done = &mut composing => panic!("the composition ended while its lane was full: {done:?}"),
            () = held.met_by_a_submit() => {}
        }
        drop(held);
        let tail = composing.await.unwrap();
        assert!(tail.contains("- Shell: "), "{tail}");
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
        let (io, probes) = probes_for(&tokens);
        let observed = Arc::new(StartupObservations::new(Arc::new(Fixed)));
        let data = tempfile::tempdir().unwrap();
        let facts = Arc::new(PromptFacts::from_process(data.path().to_path_buf(), data.path().to_path_buf(), None));
        let cwd = repo.path().to_string_lossy().into_owned();
        let tail = compose(&io, &probes, &observed, facts, &CancellationToken::new(), tail_job(Some(cwd), true)).await.unwrap();
        assert!(tail.contains("Git startup state:"), "{tail}");
        assert!(tail.contains("changes present"), "{tail}");
        assert!(!tail.contains("was not inside a git repository"), "{tail}");
    }

    #[test]
    fn the_home_folder_is_the_environments_else_the_accounts() {
        let account = || Some(std::path::PathBuf::from("/home/account"));
        assert_eq!(resolve_home(Some("/home/env".into()), || unreachable!("HOME is set")), std::path::PathBuf::from("/home/env"));
        // os.homedir(): HOME unset or empty falls back to the account's passwd entry.
        assert_eq!(resolve_home(None, account), std::path::PathBuf::from("/home/account"));
        assert_eq!(resolve_home(Some("".into()), account), std::path::PathBuf::from("/home/account"));
        assert_eq!(resolve_home(None, || None), std::path::PathBuf::new());
    }
}
