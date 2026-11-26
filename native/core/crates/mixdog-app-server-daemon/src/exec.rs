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
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_protocol::ThreadId;
use mixdog_rt::LaneTokens;
use mixdog_rt::TimerHandle;
use mixdog_spawn::LocalProcessManager;
use mixdog_spawn::survivors::ProcessSurvivors;
use mixdog_spawn::tasks::HostShellJobs;
use mixdog_spawn::tasks::ShellJobsState;
use mixdog_spawn::tasks::TaskPublisher;
use mixdog_spawn::tasks::TaskRegistry;
use mixdog_tools::exec::ExecConfig;
use mixdog_tools::exec::ExecRuntime;
use mixdog_tools::exec::ExtSyntax;
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
            .send(Finished { owner: owner.clone(), surface: surface.to_owned(), task_id: task_id.to_owned(), status: status.to_owned(), notification })
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

pub(crate) fn is_empty_strip(state: &ShellJobsState) -> bool {
    state.count == 0 && state.jobs.is_empty() && state.finished.is_empty()
}

impl TaskPublisher for StripPublisher {
    fn thread_updated(&self, thread: &str, state: &ShellJobsState) {
        self.threads.send_if_modified(|all| {
            if is_empty_strip(state) && !all.contains_key(thread) {
                return false;
            }
            if all.get(thread) == Some(state) {
                return false;
            }
            all.insert(thread.to_owned(), state.clone());
            true
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
    /// Drops a thread's snapshot from the strips, for a thread that no longer exists.
    pub forget_thread: ForgetThread,
    /// Drops a thread's snapshot from the strips only if it is still empty.
    pub(crate) prune_empty_thread: ForgetThread,
}

pub type ForgetThread = Arc<dyn Fn(&str) + Send + Sync>;

static FORGET_BY_RUNTIME: OnceLock<Mutex<Vec<(Weak<ExecRuntime>, Weak<dyn Fn(&str) + Send + Sync>)>>> = OnceLock::new();

fn register_forget_thread(runtime: &Arc<ExecRuntime>, forget_thread: &ForgetThread) {
    let entries = FORGET_BY_RUNTIME.get_or_init(|| Mutex::new(Vec::new()));
    let mut guard = entries.lock().unwrap_or_else(|e| e.into_inner());
    guard.retain(|(weak, forget)| weak.strong_count() > 0 && forget.strong_count() > 0);
    guard.push((Arc::downgrade(runtime), Arc::downgrade(forget_thread)));
}

/// Resolves the [`ForgetThread`] callback associated with `runtime` (registered by [`build_exec`]).
pub(crate) fn forget_thread_for(runtime: &Arc<ExecRuntime>) -> ForgetThread {
    let entries = FORGET_BY_RUNTIME.get_or_init(|| Mutex::new(Vec::new()));
    let found = {
        let mut guard = entries.lock().unwrap_or_else(|e| e.into_inner());
        guard.retain(|(weak, forget)| weak.strong_count() > 0 && forget.strong_count() > 0);
        guard.iter().find_map(|(weak, forget)| weak.upgrade().filter(|held| Arc::ptr_eq(held, runtime)).and_then(|_| forget.upgrade()))
    };
    found.unwrap_or_else(|| Arc::new(|_| {}))
}

pub struct Exec {
    pub runtime: Arc<ExecRuntime>,
    pub wakes: Arc<WakeHub>,
    pub configured_shell: Arc<ConfiguredShell>,
    /// Drops a thread's snapshot from the strips when its session is unloaded or deleted.
    pub forget_thread: ForgetThread,
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
        crate::shell_name::resolve_program(cfg!(windows), std::env::current_dir().ok().as_deref(), std::env::var_os("PATH").as_deref(), &|name| {
            std::env::var(name).ok()
        })
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
    let publisher = Arc::new(StripPublisher { threads, host, registry: OnceLock::new(), armed: Mutex::new(None) });
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
        script_syntax: Arc::new(ExtSyntax::new()),
        windows: cfg!(windows),
        // Node's default shell on Windows is PowerShell.
        powershell: cfg!(windows),
        warm_standby: true,
        wake: wakes.clone(),
        policy: Arc::new(NodeCommandPolicy),
        now_ms: Arc::new(now_ms),
    });
    let forget_thread: ForgetThread = {
        let publisher = publisher.clone();
        Arc::new(move |thread| {
            publisher.threads.send_if_modified(|all| all.remove(thread).is_some());
        })
    };
    register_forget_thread(&runtime, &forget_thread);
    let prune_empty_thread: ForgetThread = Arc::new(move |thread| {
        publisher.threads.send_if_modified(|all| {
            if all.get(thread).is_some_and(is_empty_strip) {
                all.remove(thread);
            }
            false
        });
    });
    (
        Exec { runtime, wakes, configured_shell, forget_thread: forget_thread.clone() },
        ExecEvents { finished, thread_strips, host_strip, forget_thread, prune_empty_thread },
    )
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
    use tokio_util::sync::CancellationToken;

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
        Rig { dir, processes, shell: ShellTool::new(exec.runtime.clone()) }
    }

    impl Rig {
        async fn run(&self, call: &str, command: &str) -> String {
            self.run_in(self.dir.path(), call, command).await
        }

        async fn run_in(&self, cwd: &Path, call: &str, command: &str) -> String {
            text(self.shell.call(&ctx(cwd, call, self.processes.clone()), serde_json::json!({"command": command})).await)
        }
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
}

#[cfg(test)]
mod forget_tests {
    use super::*;
    use mixdog_core_api::domain::mock::MockExtPool;

    #[tokio::test]
    async fn forget_thread_for_resolves_built_runtime_callback_and_drops_strip_entry() {
        let tokens = mixdog_rt::testing::tokens();
        let dir = tempfile::tempdir().unwrap();
        let processes = LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default());
        let configured = Arc::new(ConfiguredShell::default());
        let (exec, events) = build_exec(
            &tokens,
            dir.path(),
            dir.path().join("launchers"),
            "sh".into(),
            configured,
            SkillRuntime { platform: "win32".into(), interpreter: "node".into(), entry: "skill-entry.mjs".into(), electron: false },
            ExecHosts { ext_pool: Arc::new(MockExtPool::new(1)), processes },
        );

        let resolved = forget_thread_for(&exec.runtime);
        assert!(Arc::ptr_eq(&resolved, &exec.forget_thread));
        let weak_forget = Arc::downgrade(&exec.forget_thread);

        let (threads, thread_strips) = watch::channel(HashMap::new());
        let (host, _host_strip) = watch::channel(HostShellJobs::default());
        let publisher = Arc::new(StripPublisher { threads, host, registry: OnceLock::new(), armed: Mutex::new(None) });
        let mut non_empty = ShellJobsState::default();
        non_empty.count = 1;
        publisher.thread_updated("t-drop", &non_empty);
        assert!(thread_strips.borrow().contains_key("t-drop"));

        publisher.threads.send_if_modified(|all| all.remove("t-drop").is_some());
        assert!(!thread_strips.borrow().contains_key("t-drop"));
        drop(resolved);
        drop(events);
        drop(exec);
        assert!(weak_forget.upgrade().is_none(), "FORGET_BY_RUNTIME must not retain a strong reference after Exec and ExecEvents drop");
    }
}
