//! The shell/task runtime of the composition (WP-TOOLS-EXEC): `ExecConfig` and `ExecRuntime`
//! over the lane tokens, the data directory and the skill-launcher directory.
//!
//! Completions and strip states leave the runtime through bounded channels created here; the
//! session directory and the section publisher own the receivers (`ExecEvents`). Nothing is
//! dropped and there is no bind step.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::Weak;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crate::domain_seams::settings_effects::ConfiguredShell;
use mixdog_protocol::ThreadId;
use mixdog_rt::LaneTokens;
use mixdog_rt::TimerHandle;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::survivors::ProcessSurvivors;
use mixdog_spawn::tasks::HostShellJobs;
use mixdog_spawn::tasks::ShellJobsState;
use mixdog_spawn::tasks::TaskPublisher;
use mixdog_spawn::tasks::TaskRegistry;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_tools::exec::ExecConfig;
use mixdog_tools::exec::ExtSyntax;
use mixdog_tools::exec::ExecRuntime;
use mixdog_tools::exec::IoLanes;
use mixdog_tools::exec::OsPromptElevation;
use mixdog_tools::exec::ShellSource;
use mixdog_tools::exec::SkillRuntime;
use mixdog_tools::exec::TaskNotifier;
use mixdog_tools::exec::WakeHub;
use mixdog_tools::policy::exec::NodeCommandPolicy;
use tokio::sync::mpsc;
use tokio::sync::watch;

/// The WHATWG label of the system OEM code page, read once at start; None off Windows.
#[cfg(windows)]
fn host_oem() -> Option<&'static str> {
    mixdog_tools::exec::codepage::oem_label(mixdog_tools::exec::codepage::detect_oem_codepage())
}

#[cfg(not(windows))]
fn host_oem() -> Option<&'static str> {
    None
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// Bound of the completion channel. A full channel is backpressure: the completing job's task
/// waits in `send` until the session directory has drained room.
const FINISHED_CAPACITY: usize = 1024;

/// A detached job finished: the completion text for the owner thread's session.
#[derive(Debug)]
pub struct Finished {
    pub owner: ThreadId,
    pub surface: String,
    pub task_id: String,
    pub status: String,
    pub notification: String,
}

/// The runtime's `TaskNotifier`: completions go into the channel the session directory drains.
struct ChannelNotifier(mpsc::Sender<Finished>);

#[async_trait::async_trait]
impl TaskNotifier for ChannelNotifier {
    async fn finished(&self, owner: &ThreadId, surface: &str, task_id: &str, status: &str, notification: String) {
        let _ = self
            .0
            .send(Finished {
                owner: owner.clone(),
                surface: surface.to_owned(),
                task_id: task_id.to_owned(),
                status: status.to_owned(),
                notification,
            })
            .await;
    }
}

/// The registry's `TaskPublisher`. Strip states are full snapshots, so they ride `watch`
/// channels: latest wins by construction, no capacity and no ordering hazard. The finished-row
/// expiry is armed on the core ticker, as the publisher contract says.
struct StripPublisher {
    threads: watch::Sender<HashMap<String, ShellJobsState>>,
    host: watch::Sender<HostShellJobs>,
    registry: OnceLock<Weak<TaskRegistry>>,
    armed: Mutex<Option<TimerHandle>>,
}

impl TaskPublisher for StripPublisher {
    fn thread_updated(&self, thread: &str, state: &ShellJobsState) {
        self.threads.send_modify(|all| {
            all.insert(thread.to_owned(), state.clone());
        });
    }

    fn host_updated(&self, state: &HostShellJobs) {
        self.host.send_replace(state.clone());
    }

    fn schedule_expiry(&self, at_ms: u64) {
        let Some(registry) = self.registry.get().cloned() else { return };
        let at = Instant::now() + Duration::from_millis(at_ms.saturating_sub(now_ms()));
        let handle = mixdog_rt::ticker().register(at, move || {
            if let Some(registry) = registry.upgrade() {
                registry.expire_finished();
            }
        });
        let mut armed = self.armed.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(earlier) = armed.replace(handle) {
            let _ = earlier.cancel();
        }
    }
}

/// The receiving ends: the session directory drains `finished` into its owners' inboxes; the
/// section publisher watches the strips (`thread/shellJobs/updated` per owner, and the host
/// strip) and republishes whatever changed.
pub struct ExecEvents {
    pub finished: mpsc::Receiver<Finished>,
    pub thread_strips: watch::Receiver<HashMap<String, ShellJobsState>>,
    pub host_strip: watch::Receiver<HostShellJobs>,
}

/// The built runtime. `wakes` is the hub `SessionDeps::wakes` must share: the session calls
/// `WakeHub::interrupt` on user input or a notification. `configured_shell` is the one
/// `ConfiguredShell` every spawn reads: the settings effects (`DaemonSettingsEffects::new`) take
/// this same `Arc`, and the boot value from `config.shell` is `set` on it.
pub struct Exec {
    pub runtime: Arc<ExecRuntime>,
    pub wakes: Arc<WakeHub>,
    pub configured_shell: Arc<ConfiguredShell>,
}

impl ShellSource for ConfiguredShell {
    fn configured(&self) -> String {
        self.get()
    }

    fn kept_default(&self) -> Option<String> {
        ConfiguredShell::kept_default(self)
    }

    /// The one resolver (`shell_name::resolve_program`) over this process's directory, PATH and
    /// environment; the caller runs it in a lane job.
    fn resolve_default(&self) -> String {
        crate::shell_name::resolve_program(
            cfg!(windows),
            std::env::current_dir().ok().as_deref(),
            std::env::var_os("PATH").as_deref(),
            &|name| std::env::var(name).ok(),
        )
    }

    fn keep_default(&self, configured: &str, program: String) {
        ConfiguredShell::keep_default(self, configured, program);
    }
}

/// What the runtime reaches outside itself. `processes` is the manager the tools spawn through
/// (`ToolContext.processes`): the survivors of a finished command are looked up in the manager
/// that started it, so it is the same one.
pub struct ExecHosts {
    pub ext_pool: Arc<dyn ExtPool>,
    pub processes: LocalProcessManager,
}

/// `skill_launcher_dir` is the directory the skills owner ensured (`mixdog_mcp::launcher`);
/// `shell_path` the default shell, probed on a lane (`shell_name::resolve_program_current_on`);
/// `configured_shell` the one `ConfiguredShell` the settings effects write (its initial value is
/// the config's `shell.command` at boot), which every spawn reads (`getConfiguredShell()`).
pub fn build_exec(
    tokens: &LaneTokens,
    data_dir: &Path,
    skill_launcher_dir: PathBuf,
    shell_path: String,
    configured_shell: Arc<ConfiguredShell>,
    skill_runtime: SkillRuntime,
    hosts: ExecHosts,
) -> (Exec, ExecEvents) {
    let (finished_tx, finished) = mpsc::channel(FINISHED_CAPACITY);
    let (threads, thread_strips) = watch::channel(HashMap::new());
    let (host, host_strip) = watch::channel(HostShellJobs::default());
    let publisher = Arc::new(StripPublisher {
        threads,
        host,
        registry: OnceLock::new(),
        armed: Mutex::new(None),
    });
    let tasks = Arc::new(TaskRegistry::new(publisher.clone(), now_ms));
    let _ = publisher.registry.set(Arc::downgrade(&tasks));
    let wakes = WakeHub::new();
    // The boot probe is the first kept default program; a setting change drops it.
    configured_shell.keep_default(&configured_shell.get(), shell_path);
    let runtime = ExecRuntime::new(ExecConfig {
        tasks,
        lanes: IoLanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
        },
        spill_dir: data_dir.join("scratch").join("jobs"),
        data_dir: Some(data_dir.to_path_buf()),
        skill_launcher_dir: Some(skill_launcher_dir),
        notifier: Some(Arc::new(ChannelNotifier(finished_tx))),
        survivors: Some(Arc::new(ProcessSurvivors::new(hosts.processes))),
        elevation: Arc::new(OsPromptElevation),
        oem: host_oem(),
        skill_runtime: Some(skill_runtime),
        shell: configured_shell.clone(),
        script_syntax: Arc::new(ExtSyntax::new(hosts.ext_pool)),
        windows: cfg!(windows),
        // Node's default shell on Windows is PowerShell.
        powershell: cfg!(windows),
        warm_standby: true,
        wake: wakes.clone(),
        policy: Arc::new(NodeCommandPolicy),
        now_ms: Arc::new(now_ms),
    });
    (Exec { runtime, wakes, configured_shell }, ExecEvents { finished, thread_strips, host_strip })
}

// The recorded Node fixture is the Windows form of the commands.
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use mixdog_core_api::domain::common::AbsPath;
    use mixdog_core_api::domain::mock::MockApprovalGate;
    use mixdog_core_api::domain::mock::MockExtPool;
    use mixdog_core_api::domain::mock::MockFileService;
    use mixdog_core_api::domain::mock::MockProgress;
    use mixdog_core_api::domain::tool::*;
    use mixdog_protocol::ProcessHandle;
    use mixdog_protocol::ToolCallId;
    use mixdog_protocol::TurnId;
    use mixdog_tools::exec::ShellTool;
    use mixdog_tools::exec::TaskTool;
    use tokio_util::sync::CancellationToken;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::CreateEventW;
    use windows_sys::Win32::System::Threading::GetExitCodeProcess;
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
    use windows_sys::Win32::System::Threading::SetEvent;

    /// `STILL_ACTIVE` (minwinbase.h): the exit code of a process that has not ended.
    const STILL_ACTIVE: u32 = 259;

    /// What Node's agent sees through the life of a survivors task (`fixtures/shell-survivors/golden.json`, recorded
    /// from Node b6f10295a with a mixdog-spawn built from the same commit; see its MANIFEST.json). The task id,
    /// the timestamps and the child's pid are placeholders there.
    fn golden() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../fixtures/shell-survivors/golden.json")).unwrap()
    }

    fn node_view(text: &str, id: &str) -> String {
        let tail = if text.ends_with('\n') { "\n" } else { "" };
        let pid_free = text.lines().map(|line| if line.starts_with("CHILD=") { "CHILD=<PID>" } else { line }).collect::<Vec<_>>();
        pid_free
            .join("\n")
            .replace(id, "<TASK>")
            .lines()
            .map(|line| match line.split_once(": ") {
                Some((key @ ("started" | "finished"), _)) => format!("{key}: <TIME>"),
                _ => line.to_owned(),
            })
            .collect::<Vec<_>>()
            .join("\n")
            + tail
    }

    /// A named event the test owns. The fixture child (the recording's `<GATE>`) blocks on it before it does anything, so it
    /// cannot end, and its pid cannot be reused, until the test has opened its handle and sets the event.
    struct Gate {
        name: String,
        handle: windows_sys::Win32::Foundation::HANDLE,
    }

    impl Gate {
        fn new(tag: &str) -> Self {
            let name = format!("mixdog-survivor-gate-{}-{tag}", std::process::id());
            let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
            // Manual reset, not signalled.
            let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, wide.as_ptr()) };
            assert!(!handle.is_null(), "the gate could not be created: {}", std::io::Error::last_os_error());
            Self { name, handle }
        }

        /// The recorded command with this gate's name in place of the recording's placeholder.
        fn command(&self, template: &str) -> String {
            template.replace("<GATE>", &self.name)
        }

        /// What the agent saw, as the recording writes it: the gate's name is a placeholder there.
        fn view(&self, text: &str, id: &str) -> String {
            node_view(&text.replace(&self.name, "<GATE>"), id)
        }

        fn open(&self) {
            let set = unsafe { SetEvent(self.handle) };
            assert!(set != 0, "the gate could not be opened: {}", std::io::Error::last_os_error());
        }
    }

    impl Drop for Gate {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }

    /// An owned handle on the child the command printed. It is opened while the child is held at its gate, so it is
    /// certainly that process and a pid reused later cannot be mistaken for it. A failure to open or to query is a test error.
    struct Child(windows_sys::Win32::Foundation::HANDLE);

    impl Child {
        fn open(pid: u32) -> Self {
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            assert!(!handle.is_null(), "the child {pid} could not be opened: {}", std::io::Error::last_os_error());
            Self(handle)
        }

        fn running(&self) -> bool {
            let mut code = 0u32;
            let known = unsafe { GetExitCodeProcess(self.0, &mut code) } != 0;
            assert!(known, "the child's exit code could not be queried: {}", std::io::Error::last_os_error());
            code == STILL_ACTIVE
        }
    }

    impl Drop for Child {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
    fn ctx(dir: &Path, call: &str, processes: LocalProcessManager) -> ToolContext {
        let tokens = mixdog_rt::testing::tokens();
        ToolContext {
            call_id: ToolCallId::from(call),
            thread_id: ThreadId::from("t"),
            turn_id: TurnId::from("r"),
            tool: "shell".into(),
            cwd: AbsPath::new(dir).unwrap(),
            surface: SurfaceKind::Lead,
            cancel: CancellationToken::new(),
            deadline: None,
            progress: Arc::new(MockProgress::default()),
            io: ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io },
            approvals: Arc::new(MockApprovalGate::default()),
            files: Arc::new(MockFileService::default()),
            processes: Arc::new(processes),
            options: Default::default(),
            review: None,
        }
    }

    fn text(outcome: ToolOutcome) -> String {
        match outcome {
            Ok(out) => match &out.parts[0] {
                ToolPart::Text(t) => t.clone(),
                _ => panic!("not text"),
            },
            Err(e) => e.message_for_model,
        }
    }

    struct Rig {
        dir: tempfile::TempDir,
        processes: LocalProcessManager,
        runtime: Arc<ExecRuntime>,
        shell: ShellTool,
        task: TaskTool,
    }

    async fn rig() -> Rig {
        let tokens = mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let processes = LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default());
        let shell_path = crate::shell_name::resolve_program_current_on(tokens.interactive_io).await.unwrap();
        let (exec, _events) = build_exec(
            &tokens,
            dir.path(),
            dir.path().join("launchers"),
            shell_path,
            Arc::new(ConfiguredShell::default()),
            SkillRuntime { platform: "win32".into(), interpreter: "node".into(), entry: "skill-entry.mjs".into(), electron: false },
            ExecHosts { ext_pool: Arc::new(MockExtPool::new(1)), processes: processes.clone() },
        );
        Rig { dir, processes, runtime: exec.runtime.clone(), shell: ShellTool::new(exec.runtime.clone()), task: TaskTool::new(exec.runtime) }
    }

    impl Rig {
        async fn run(&self, call: &str, command: &str) -> String {
            self.run_in(self.dir.path(), call, command).await
        }

        async fn run_in(&self, cwd: &Path, call: &str, command: &str) -> String {
            text(self.shell.call(&ctx(cwd, call, self.processes.clone()), serde_json::json!({"command": command})).await)
        }

        /// The standby parked next, once it is.
        async fn parked(&self) -> ProcessHandle {
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                if let Some(handle) = self.runtime.parked_standby() {
                    return handle;
                }
                assert!(Instant::now() < deadline, "no standby was parked");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }

        async fn task(&self, call: &str, args: serde_json::Value) -> String {
            text(self.task.call(&ctx(self.dir.path(), call, self.processes.clone()), args).await)
        }

        /// The child the command printed (`CHILD=<pid>`), whose life is the test's own evidence.
        fn child_of(ran: &str) -> u32 {
            ran.lines().find_map(|line| line.strip_prefix("CHILD=")?.trim().parse().ok()).expect("the command printed its child")
        }
    }

    /// The daemon's runtime tracks what a finished command left running (Node's `probeShellDescendants` at the shell settle)
    /// and cancels it as Node does: every text the agent reads equals Node's recording, the task starts with the command,
    /// and the child the command printed is running while tracked and gone from the operating system after the cancel.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_cancelled_survivors_task_reads_as_nodes_and_its_child_is_gone() {
        let want = golden();
        let rig = rig().await;
        // The child waits at this gate, never opened: it can only end by the cancel.
        let gate = Gate::new("cancelled");
        let command = gate.command(want["cancelled"]["command"].as_str().unwrap());
        let before = chrono::Utc::now().timestamp_millis();
        let ran = rig.run("s1", &command).await;
        let returned = chrono::Utc::now().timestamp_millis();
        assert_eq!(gate.view(&ran, "task-s1"), want["cancelled"]["run"].as_str().unwrap());
        // `started` lies inside the call; that it is the command's start rather than the moment its survivors were observed
        // is asserted on a clock the test advances (mixdog-tools `a_survivors_task_starts_when_its_command_started`).
        let started = ran.lines().find_map(|line| line.strip_prefix("started: ")).unwrap();
        let started = chrono::DateTime::parse_from_rfc3339(started).unwrap().timestamp_millis();
        assert!(before <= started && started <= returned, "started {started} is outside the call ({before}..{returned})");
        let child = Child::open(Rig::child_of(&ran));
        assert!(child.running(), "the child runs while it is tracked");
        let read = serde_json::json!({"action": "read", "task_id": "task-s1"});
        assert_eq!(gate.view(&rig.task("r1", read.clone()).await, "task-s1"), want["cancelled"]["readRunning"].as_str().unwrap());
        let cancel = serde_json::json!({"action": "cancel", "task_id": "task-s1"});
        assert_eq!(gate.view(&rig.task("c1", cancel.clone()).await, "task-s1"), want["cancelled"]["cancel"].as_str().unwrap());
        // Checked as the call returns, without waiting: a cancel that reports success must already have ended the child.
        assert!(!child.running(), "the child is gone when the cancel reports");
        assert_eq!(gate.view(&rig.task("c2", cancel).await, "task-s1"), want["cancelled"]["cancelAgain"].as_str().unwrap());
        assert_eq!(gate.view(&rig.task("r2", read).await, "task-s1"), want["cancelled"]["read"].as_str().unwrap());
        let tail = serde_json::json!({"action": "read", "task_id": "task-s1", "output": "tail"});
        assert_eq!(gate.view(&rig.task("r3", tail).await, "task-s1"), want["cancelled"]["tail"].as_str().unwrap());
    }

    /// Every PowerShell command runs under Node's pwsh startup script (`fixtures/shell-pwsh-bootstrap/golden.json`,
    /// recorded from Node b6f10295a by `record-shell-pwsh-bootstrap.mjs`): a parse error reads `ParserError: <message>`
    /// in UTF-8, non-ASCII stdout and stderr arrive intact, and an error record keeps pwsh's own view.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn powershell_commands_read_as_nodes_through_its_startup_script() {
        let want: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/shell-pwsh-bootstrap/golden.json")).unwrap();
        assert_eq!(want["standbyArgs"][4], mixdog_tools::exec::POWERSHELL_BOOTSTRAP);
        let rig = rig().await;
        let mut wrong = Vec::new();
        for (i, case) in want["cases"].as_array().unwrap().iter().enumerate() {
            let ran = rig.run(&format!("p{i}"), case["input"]["command"].as_str().unwrap()).await;
            if ran != case["text"].as_str().unwrap() {
                wrong.push(format!("{}: {ran:?}", case["name"]));
            }
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    /// PowerShell commands run in the warm standby as in Node (`fixtures/shell-warm-standby/golden.json`, recorded from
    /// Node b6f10295a by `record-shell-warm-standby.mjs`): a command taken by the parked standby runs in its folder (one
    /// whose name needs the Base64 hand-off) for PowerShell and .NET with its session's TEMP, and the next command, in the
    /// next standby, does not see the global it set; a command from another folder (another environment) does not take
    /// the standby and runs cold. Whether each command ran in the parked standby is told, as Node's recording tells it, by
    /// the process id it prints last. Each standby runs one command, and shutdown ends the parked one.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[allow(clippy::disallowed_methods, reason = "the test makes its folders on the test thread")]
    async fn powershell_commands_run_in_the_warm_standby_as_nodes_do() {
        use mixdog_core_api::domain::process::ProcessEvent;
        use mixdog_core_api::domain::process::ProcessManager;
        let want: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/shell-warm-standby/golden.json")).unwrap();
        let rig = rig().await;
        let (a, b) = (rig.dir.path().join("ws-a it\u{2019}s"), rig.dir.path().join("ws-b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let mut temp = String::new();
        let mut used = Vec::new();
        let mut wrong = Vec::new();
        for (i, call) in want["calls"].as_array().unwrap().iter().enumerate() {
            let parked = if call["parked"].as_bool().unwrap() { Some(rig.parked().await) } else { None };
            let parked_pid = parked.as_ref().and_then(|h| rig.processes.list().into_iter().find(|p| &p.handle == h)).map(|p| p.pid);
            let dir = if call["ws"] == "A" { &a } else { &b };
            let ran = rig.run_in(dir, &format!("w{i}"), call["input"]["command"].as_str().unwrap()).await;
            let (body, pid) = ran.trim_end().rsplit_once("pid|").unwrap_or_else(|| panic!("call {i}: no pid line in {ran:?}"));
            let body = body.strip_suffix('\n').map(|b| b.strip_suffix('\r').unwrap_or(b)).unwrap();
            let taken = parked_pid == Some(pid.parse().unwrap());
            if i == 0 {
                temp = body.lines().find_map(|line| line.strip_prefix("cold|")).unwrap().split('|').nth(1).unwrap().to_owned();
            }
            let view = body
                .replace(&*a.to_string_lossy(), "<A>")
                .replace(&*b.to_string_lossy(), "<B>")
                .replace(&temp, "<TEMP>");
            if view != call["text"].as_str().unwrap() || taken != call["taken"].as_bool().unwrap() {
                wrong.push(format!("{i}: taken {taken} {view:?}"));
            }
            if taken {
                used.extend(parked);
            }
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
        assert!(used.len() >= 2 && used[0] != used[1], "each standby runs one command: {used:?}");
        let parked = rig.parked().await;
        let mut events = rig.processes.subscribe(&parked, Some(0)).unwrap();
        rig.runtime.drain_snapshots(&CancellationToken::new()).await;
        let ended = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                if let Some(ProcessEvent::Exited { .. }) | None = events.next().await {
                    return;
                }
            }
        });
        ended.await.expect("shutdown ended the parked standby");
        assert_eq!(rig.runtime.parked_standby(), None, "nothing is parked after shutdown");
    }

    /// The time from a shell call to its result for a PowerShell command that prints at once, as Node's warm standby is
    /// measured against it: a warm-up call, then 20 calls a few seconds apart (a model's pace, which lets a standby
    /// refill), their median printed. A measurement, run on request: `-- --ignored pwsh_call_latency --nocapture`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "a measurement, not a check"]
    async fn pwsh_call_latency() {
        let rig = rig().await;
        assert!(rig.run("warm", "Write-Output hi").await.contains("hi"));
        let mut times = Vec::new();
        for i in 0..20 {
            tokio::time::sleep(Duration::from_secs(3)).await;
            let start = std::time::Instant::now();
            let ran = rig.run(&format!("m{i}"), "Write-Output hi").await;
            times.push(start.elapsed().as_secs_f64() * 1000.0);
            assert!(ran.contains("hi"), "{ran}");
        }
        times.sort_by(f64::total_cmp);
        println!("pwsh call latency ms: median {:.0} (min {:.0}, max {:.0})", (times[9] + times[10]) / 2.0, times[0], times[19]);
    }

    /// A survivors task whose child ends on its own completes with Node's result body, and has nothing left to cancel.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_survivors_task_whose_child_ends_on_its_own_completes_as_nodes_does() {
        let want = golden();
        let rig = rig().await;
        // The child waits at this gate until the test holds its handle and the task has been read once, as in the recording.
        let gate = Gate::new("natural");
        let ran = rig.run("s1", &gate.command(want["natural"]["command"].as_str().unwrap())).await;
        assert_eq!(gate.view(&ran, "task-s1"), want["natural"]["run"].as_str().unwrap());
        let child = Child::open(Rig::child_of(&ran));
        assert!(child.running());
        let read = serde_json::json!({"action": "read", "task_id": "task-s1"});
        assert_eq!(gate.view(&rig.task("r1", read.clone()).await, "task-s1"), want["natural"]["readRunning"].as_str().unwrap());
        gate.open();
        let wait = serde_json::json!({"action": "wait", "task_id": "task-s1", "timeout_ms": 30000});
        assert_eq!(gate.view(&rig.task("w", wait).await, "task-s1"), want["natural"]["wait"].as_str().unwrap());
        // Checked as the wait returns, without waiting: the task completed because its child had ended.
        assert!(!child.running(), "the task completed while its child still runs");
        assert_eq!(gate.view(&rig.task("r2", read).await, "task-s1"), want["natural"]["read"].as_str().unwrap());
        let tail = serde_json::json!({"action": "read", "task_id": "task-s1", "output": "tail"});
        assert_eq!(gate.view(&rig.task("r3", tail).await, "task-s1"), want["natural"]["tail"].as_str().unwrap());
        let cancel = serde_json::json!({"action": "cancel", "task_id": "task-s1"});
        assert_eq!(gate.view(&rig.task("c1", cancel).await, "task-s1"), want["natural"]["cancelAfterEnd"].as_str().unwrap());
    }
}