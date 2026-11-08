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
    use mixdog_protocol::ToolCallId;
    use mixdog_protocol::TurnId;
    use mixdog_tools::exec::ShellTool;
    use mixdog_tools::exec::TaskTool;
    use tokio_util::sync::CancellationToken;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::GetExitCodeProcess;
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;

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

    /// Whether the process `pid` is still running, asked of the operating system directly.
    fn alive(pid: u32) -> bool {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut code = 0u32;
            let known = GetExitCodeProcess(process, &mut code) != 0;
            CloseHandle(process);
            known && code == STILL_ACTIVE
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
        Rig { dir, processes, shell: ShellTool::new(exec.runtime.clone()), task: TaskTool::new(exec.runtime) }
    }

    impl Rig {
        async fn run(&self, call: &str, command: &str) -> String {
            text(self.shell.call(&ctx(self.dir.path(), call, self.processes.clone()), serde_json::json!({"command": command})).await)
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
        let command = want["cancelled"]["command"].as_str().unwrap();
        let before = chrono::Utc::now().timestamp_millis();
        let ran = rig.run("s1", command).await;
        let returned = chrono::Utc::now().timestamp_millis();
        assert_eq!(node_view(&ran, "task-s1"), want["cancelled"]["run"].as_str().unwrap());
        // `started` is the command's start, not the moment its survivors were observed: the recording's own rule.
        let started = ran.lines().find_map(|line| line.strip_prefix("started: ")).unwrap();
        let started = chrono::DateTime::parse_from_rfc3339(started).unwrap().timestamp_millis();
        assert!(want["timing"]["cancelled"]["startedAtCommandStart"].as_bool().unwrap());
        assert!((started - before) * 2 < returned - before, "started {started} is not near the call's start {before} (returned {returned})");
        let child = Rig::child_of(&ran);
        assert!(alive(child), "the child runs while it is tracked");
        let read = serde_json::json!({"action": "read", "task_id": "task-s1"});
        assert_eq!(node_view(&rig.task("r1", read.clone()).await, "task-s1"), want["cancelled"]["readRunning"].as_str().unwrap());
        let cancel = serde_json::json!({"action": "cancel", "task_id": "task-s1"});
        assert_eq!(node_view(&rig.task("c1", cancel.clone()).await, "task-s1"), want["cancelled"]["cancel"].as_str().unwrap());
        assert!(!alive(child), "the child is gone once the cancel reports");
        assert_eq!(node_view(&rig.task("c2", cancel).await, "task-s1"), want["cancelled"]["cancelAgain"].as_str().unwrap());
        assert_eq!(node_view(&rig.task("r2", read).await, "task-s1"), want["cancelled"]["read"].as_str().unwrap());
        let tail = serde_json::json!({"action": "read", "task_id": "task-s1", "output": "tail"});
        assert_eq!(node_view(&rig.task("r3", tail).await, "task-s1"), want["cancelled"]["tail"].as_str().unwrap());
    }

    /// A survivors task whose child ends on its own completes with Node's result body, and has nothing left to cancel.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_survivors_task_whose_child_ends_on_its_own_completes_as_nodes_does() {
        let want = golden();
        let rig = rig().await;
        let ran = rig.run("s1", want["natural"]["command"].as_str().unwrap()).await;
        assert_eq!(node_view(&ran, "task-s1"), want["natural"]["run"].as_str().unwrap());
        let child = Rig::child_of(&ran);
        assert!(alive(child));
        let read = serde_json::json!({"action": "read", "task_id": "task-s1"});
        assert_eq!(node_view(&rig.task("r1", read.clone()).await, "task-s1"), want["natural"]["readRunning"].as_str().unwrap());
        let wait = serde_json::json!({"action": "wait", "task_id": "task-s1", "timeout_ms": 30000});
        assert_eq!(node_view(&rig.task("w", wait).await, "task-s1"), want["natural"]["wait"].as_str().unwrap());
        assert!(!alive(child), "the task completed because its child ended");
        assert_eq!(node_view(&rig.task("r2", read).await, "task-s1"), want["natural"]["read"].as_str().unwrap());
        let tail = serde_json::json!({"action": "read", "task_id": "task-s1", "output": "tail"});
        assert_eq!(node_view(&rig.task("r3", tail).await, "task-s1"), want["natural"]["tail"].as_str().unwrap());
        let cancel = serde_json::json!({"action": "cancel", "task_id": "task-s1"});
        assert_eq!(node_view(&rig.task("c1", cancel).await, "task-s1"), want["natural"]["cancelAfterEnd"].as_str().unwrap());
    }
}