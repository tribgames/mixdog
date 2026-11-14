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

fn now_ms() -> u64 {
    mixdog_rt::wall_clock!().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
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
            spawn: tokens.spawn_io,
            pty: tokens.pty_io,
        },
        spill_dir: data_dir.join("scratch").join("jobs"),
        data_dir: Some(data_dir.to_path_buf()),
        skill_launcher_dir: Some(skill_launcher_dir),
        notifier: Some(Arc::new(ChannelNotifier(finished_tx))),
        survivors: Some(Arc::new(ProcessSurvivors::new(hosts.processes))),
        elevation: Arc::new(OsPromptElevation),
        oem: mixdog_tools::exec::codepage::host_oem(),
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
        configured: Arc<ConfiguredShell>,
    }

    async fn rig() -> Rig {
        let tokens = mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let processes = LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default());
        let shell_path = crate::shell_name::resolve_program_current_on(tokens.interactive_io).await.unwrap();
        let configured = Arc::new(ConfiguredShell::default());
        let (exec, _events) = build_exec(
            &tokens,
            dir.path(),
            dir.path().join("launchers"),
            shell_path,
            Arc::clone(&configured),
            SkillRuntime { platform: "win32".into(), interpreter: "node".into(), entry: "skill-entry.mjs".into(), electron: false },
            ExecHosts { ext_pool: Arc::new(MockExtPool::new(1)), processes: processes.clone() },
        );
        Rig {
            dir,
            processes,
            runtime: exec.runtime.clone(),
            shell: ShellTool::new(exec.runtime.clone()),
            task: TaskTool::new(exec.runtime),
            configured,
        }
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
            mixdog_rt::time::timeout(Duration::from_secs(30), self.runtime.wait_parked_standby()).await.expect("no standby was parked")
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
            serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/shell-pwsh-bootstrap/golden.json")).unwrap();
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
    /// the standby and runs cold. Commands of 1 MiB, 1 MiB + 1 byte, one the hand-off prelude pushes past 1 MiB when it is
    /// taken and one of 5 MiB each run whole cold and warm, past the helper's 1 MiB input queue. A variable of this process's environment changed
    /// after a standby was parked reaches the next command, which does not take that standby. Whether each command ran
    /// in the parked standby is told, as Node's recording tells it, by the process id it prints last. Each standby runs
    /// one command, and shutdown ends the parked one.
    #[tokio::test(flavor = "multi_thread", worker_threads = 8)]
    async fn powershell_commands_run_in_the_warm_standby_as_nodes_do() {
        use mixdog_core_api::domain::process::ProcessEvent;
        use mixdog_core_api::domain::process::ProcessManager;
        let want: serde_json::Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/shell-warm-standby/golden.json")).unwrap();
        // Read by no other test; every standby is parked with this value, as in the recording.
        // SAFETY: no other thread of this test binary reads or writes MIXDOG_STANDBY_PROBE.
        unsafe { std::env::set_var("MIXDOG_STANDBY_PROBE", "parked") };
        let calls: Vec<(usize, serde_json::Value)> = want["calls"].as_array().unwrap().iter().cloned().enumerate().collect();
        // The recording runs every call in one runtime. Each run of sized commands (cold from folder A, cold from folder B,
        // then warm from B) starts there from a standby parked for B; here each run replays in a runtime of its own, beside
        // the others, after the two calls that bring it to that standby (1 runs cold from A and parks one for A, 4 misses it
        // from B and parks one for B). The last call changes this process's environment: it runs when all others are done.
        let sized: Vec<usize> = calls.iter().filter(|(_, call)| call["input"]["size"].is_u64()).map(|(i, _)| *i).collect();
        let (first, last) = (sized[0], calls.len() - 1);
        assert_eq!(sized, (first..last).collect::<Vec<_>>(), "the sized commands run together, before the last call");
        assert!(sized.chunks(3).all(|run| run.len() == 3 && ["A", "B", "B"].iter().zip(run).all(|(ws, i)| calls[*i].1["ws"] == *ws)));
        assert!(calls[1].1["ws"] == "A" && calls[1].1["parked"] == false && calls[4].1["ws"] == "B" && calls[4].1["taken"] == false);
        assert!(!calls[last].1["setAfterPark"].is_null());
        let runs: Vec<_> = sized
            .chunks(3)
            .map(|run| {
                let calls: Vec<(usize, serde_json::Value)> = [1, 4].iter().chain(run).map(|i| calls[*i].clone()).collect();
                tokio::spawn(async move {
                    let rig = rig().await;
                    let replayed = replay_standby(&rig, &calls).await;
                    rig.runtime.drain_snapshots(&CancellationToken::new()).await;
                    replayed
                })
            })
            .collect();
        let rig = rig().await;
        let (mut wrong, used) = replay_standby(&rig, &calls[..first]).await;
        assert!(used.len() >= 2 && used[0] != used[1], "each standby runs one command: {used:?}");
        for run in runs {
            wrong.extend(run.await.unwrap().0);
        }
        wrong.extend(replay_standby(&rig, &calls[last..]).await.0);
        assert!(wrong.is_empty(), "{wrong:#?}");
        let parked = rig.parked().await;
        let mut events = rig.processes.subscribe(&parked, Some(0)).unwrap();
        rig.runtime.drain_snapshots(&CancellationToken::new()).await;
        let ended = mixdog_rt::time::timeout(Duration::from_secs(30), async {
            loop {
                if let Some(ProcessEvent::Exited { .. }) | None = events.next().await {
                    return;
                }
            }
        });
        ended.await.expect("shutdown ended the parked standby");
        assert_eq!(rig.runtime.parked_standby(), None, "nothing is parked after shutdown");
    }

    /// Replays `calls` (index and recorded call) of the warm-standby recording on `rig`, in order: what differs from the
    /// recording, and the standbys that ran a command. Whether a command ran in the parked standby is told, as Node's
    /// recording tells it, by the process id it prints last.
    #[allow(clippy::disallowed_methods, reason = "the replay makes its folders on the test thread")]
    async fn replay_standby(rig: &Rig, calls: &[(usize, serde_json::Value)]) -> (Vec<String>, Vec<ProcessHandle>) {
        use mixdog_core_api::domain::process::ProcessManager;
        // The recorder's `sizedCommand`.
        let sized = |size: usize| {
            let head = "$null = $PSScriptRoot; $s = '";
            let tail = "'; Write-Output ('len|' + $s.Length); Write-Output \"pid|$PID\"";
            format!("{head}{}{tail}", "a".repeat(size - head.len() - tail.len()))
        };
        let (a, b) = (rig.dir.path().join("ws-a it\u{2019}s"), rig.dir.path().join("ws-b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let mut temp: Option<String> = None;
        let (mut wrong, mut used) = (Vec::new(), Vec::new());
        for (i, call) in calls {
            let parked = if call["parked"].as_bool().unwrap() { Some(rig.parked().await) } else { None };
            let parked_pid = parked.as_ref().and_then(|h| rig.processes.list().into_iter().find(|p| &p.handle == h)).map(|p| p.pid);
            if let Some(value) = call["setAfterPark"]["MIXDOG_STANDBY_PROBE"].as_str() {
                // SAFETY: as in the test.
                unsafe { std::env::set_var("MIXDOG_STANDBY_PROBE", value) };
            }
            let dir = if call["ws"] == "A" { &a } else { &b };
            let command = match call["input"]["size"].as_u64() {
                Some(size) => sized(size as usize),
                None => call["input"]["command"].as_str().unwrap().to_owned(),
            };
            let ran = rig.run_in(dir, &format!("w{i}"), &command).await;
            let (body, pid) = ran.trim_end().rsplit_once("pid|").unwrap_or_else(|| panic!("call {i}: no pid line in {ran:?}"));
            let body = body.strip_suffix('\n').map(|b| b.strip_suffix('\r').unwrap_or(b)).unwrap();
            let taken = parked_pid == Some(pid.parse().unwrap());
            // The session's TEMP, as the first call prints it.
            if let Some(cold) = body.lines().find_map(|line| line.strip_prefix("cold|")) {
                temp = Some(cold.split('|').nth(1).unwrap().to_owned());
            }
            let mut view = body.replace(&*a.to_string_lossy(), "<A>").replace(&*b.to_string_lossy(), "<B>");
            if let Some(temp) = &temp {
                view = view.replace(temp.as_str(), "<TEMP>");
            }
            if view != call["text"].as_str().unwrap() || taken != call["taken"].as_bool().unwrap() {
                wrong.push(format!("{i}: taken {taken} {view:?}"));
            }
            if taken {
                used.extend(parked);
            }
        }
        (wrong, used)
    }

    /// A shell that never reads the script it is fed is held and limited as in Node (`fixtures/shell-unread-stdin/golden.json`,
    /// recorded by `record-shell-unread-stdin.mjs` with the same stand-in, `testdata/unread_stdin_shell.rs`): the write of a
    /// 1 MiB command waits on the full pipe, and meanwhile a run limit ends the shell with the timeout's answer and the hold
    /// moves it to the background, each before the stand-in's 30 s are up. Node's warm standby was off; here the stand-in may
    /// be parked and taken, which feeds it the same way.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[allow(clippy::disallowed_methods, reason = "the test builds its stand-in shell on the test thread")]
    async fn a_shell_that_never_reads_its_input_is_held_and_limited_as_nodes() {
        use mixdog_core_api::domain::process::ProcessManager;
        let want: serde_json::Value = serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/shell-unread-stdin/golden.json")).unwrap();
        let rig = rig().await;
        let standin = rig.dir.path().join("standin").join("pwsh.exe");
        std::fs::create_dir_all(standin.parent().unwrap()).unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/testdata/unread_stdin_shell.rs");
        let built = std::process::Command::new("rustc").arg("-O").arg("-o").arg(&standin).arg(&source).status().unwrap();
        assert!(built.success(), "the stand-in shell did not build");
        rig.configured.set(&standin.to_string_lossy());
        // The recorder's `sizedCommand`.
        let sized = |size: usize| {
            let head = "$null = $PSScriptRoot; $s = '";
            let tail = "'; Write-Output ('len|' + $s.Length)";
            format!("{head}{}{tail}", "a".repeat(size - head.len() - tail.len()))
        };
        let life = Duration::from_millis(want["standinLifeMs"].as_u64().unwrap());
        let mut wrong = Vec::new();
        for (i, case) in want["cases"].as_array().unwrap().iter().enumerate() {
            let mut input = case["input"].clone();
            let size = input.as_object_mut().unwrap().remove("size").unwrap().as_u64().unwrap() as usize;
            input["command"] = serde_json::Value::String(sized(size));
            let call = format!("u{i}");
            let started = std::time::Instant::now();
            // An answer after the stand-in's life is wrong already, so the wait ends there.
            let ran = mixdog_rt::time::timeout(life, rig.shell.call(&ctx(rig.dir.path(), &call, rig.processes.clone()), input))
                .await
                .unwrap_or_else(|_| panic!("{}: no answer within the stand-in's {life:?}", case["name"]));
            let ran = text(ran);
            let answered = started.elapsed();
            let view: String = ran
                .replace(&format!("task-{call}"), "<TASK>")
                .lines()
                .map(|line| {
                    if line.starts_with("started: ") {
                        "started: <TIME>".to_owned()
                    } else if line.starts_with("logs: ") {
                        "logs: <LOGS>".to_owned()
                    } else {
                        line.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
                + if ran.ends_with('\n') { "\n" } else { "" };
            if view != case["text"].as_str().unwrap() || answered >= life {
                wrong.push(format!("{}: after {answered:?} {view:?}", case["name"]));
            }
        }
        for process in ProcessManager::list(&rig.processes) {
            let _ = ProcessManager::kill(&rig.processes, &process.handle);
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    /// The shell tool's command of `size` bytes: a PowerShell script that answers the length of its one long string.
    #[cfg(windows)]
    fn long_command(size: usize) -> (String, usize) {
        let head = "$null = $PSScriptRoot; $s = '";
        let tail = "'; Write-Output ('len|' + $s.Length)";
        let len = size - head.len() - tail.len();
        (format!("{head}{}{tail}", "a".repeat(len)), len)
    }

    /// A PowerShell command just over the 1 MiB input queue of the process helper (it goes in more than one piece, and the
    /// shell reads it whole) goes through the shell tool and answers its length. The 50 MiB case is `pwsh_50_mib_command`.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_command_just_over_the_input_queue_answers_its_length() {
        let rig = rig().await;
        let (command, len) = long_command(1024 * 1024 + 4096);
        let ran = rig.run("over", &command).await;
        assert!(ran.contains(&format!("len|{len}")), "{}", &ran[..ran.len().min(400)]);
    }

    /// A 50 MiB PowerShell command goes through the shell tool and answers its length; the call's duration and how far it
    /// raised this process's peak working set and peak committed memory (`K32GetProcessMemoryInfo`) over a warm-up call's
    /// are printed (`-- --nocapture`). It takes 53 s and 414 MiB, so it is run by the `pwsh-50-mib` profile only.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "the 50 MiB measurement: `nextest run --profile pwsh-50-mib --run-ignored only -p mixdog-app-server-daemon`"]
    async fn pwsh_50_mib_command() {
        #[repr(C)]
        #[derive(Default)]
        struct Counters {
            cb: u32,
            page_faults: u32,
            peak_working_set: usize,
            working_set: usize,
            quota_peak_paged: usize,
            quota_paged: usize,
            quota_peak_nonpaged: usize,
            quota_nonpaged: usize,
            pagefile: usize,
            peak_pagefile: usize,
        }
        unsafe extern "system" {
            fn GetCurrentProcess() -> isize;
            fn K32GetProcessMemoryInfo(process: isize, counters: *mut Counters, cb: u32) -> i32;
        }
        let peaks = || {
            let mut c = Counters { cb: std::mem::size_of::<Counters>() as u32, ..Counters::default() };
            // SAFETY: `c` is a PROCESS_MEMORY_COUNTERS of the size given; the pseudo-handle needs no closing.
            assert_ne!(unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) }, 0);
            (c.peak_working_set, c.peak_pagefile)
        };
        let rig = rig().await;
        assert!(rig.run("warm", "Write-Output hi").await.contains("hi"));
        let (command, len) = long_command(50 * 1024 * 1024);
        let (ws, commit) = peaks();
        let start = std::time::Instant::now();
        let ran = rig.run("big", &command).await;
        let took = start.elapsed();
        drop(command);
        let (ws_after, commit_after) = peaks();
        assert!(ran.contains(&format!("len|{len}")), "{}", &ran[..ran.len().min(400)]);
        let mib = |bytes: usize| bytes as f64 / 1048576.0;
        println!(
            "50 MiB command: {:.1} s; peak working set {:.0} -> {:.0} MiB (+{:.0}), peak commit {:.0} -> {:.0} MiB (+{:.0})",
            took.as_secs_f64(),
            mib(ws),
            mib(ws_after),
            mib(ws_after - ws),
            mib(commit),
            mib(commit_after),
            mib(commit_after - commit)
        );
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