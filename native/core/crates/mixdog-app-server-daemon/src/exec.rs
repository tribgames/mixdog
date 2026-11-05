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

use mixdog_protocol::ThreadId;
use mixdog_rt::LaneTokens;
use mixdog_rt::TimerHandle;
use mixdog_spawn::tasks::HostShellJobs;
use mixdog_spawn::tasks::ShellJobsState;
use mixdog_spawn::tasks::TaskPublisher;
use mixdog_spawn::tasks::TaskRegistry;
use mixdog_tools::exec::ExecConfig;
use mixdog_tools::exec::ExecRuntime;
use mixdog_tools::exec::IoLanes;
use mixdog_tools::exec::OsPromptElevation;
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
    pub task_id: String,
    pub status: String,
    pub notification: String,
}

/// The runtime's `TaskNotifier`: completions go into the channel the session directory drains.
struct ChannelNotifier(mpsc::Sender<Finished>);

#[async_trait::async_trait]
impl TaskNotifier for ChannelNotifier {
    async fn finished(&self, owner: &ThreadId, task_id: &str, status: &str, notification: String) {
        let _ = self
            .0
            .send(Finished {
                owner: owner.clone(),
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
/// `WakeHub::interrupt` on user input or a notification.
pub struct Exec {
    pub runtime: Arc<ExecRuntime>,
    pub wakes: Arc<WakeHub>,
}

/// `skill_launcher_dir` is the directory the skills owner ensured (`mixdog_mcp::launcher`);
/// `None` leaves model shells without launchers on PATH.
pub fn build_exec(
    tokens: &LaneTokens,
    data_dir: &Path,
    skill_launcher_dir: Option<PathBuf>,
    skill_runtime: Option<SkillRuntime>,
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
    let runtime = ExecRuntime::new(ExecConfig {
        tasks,
        lanes: IoLanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
        },
        spill_dir: data_dir.join("scratch").join("jobs"),
        data_dir: Some(data_dir.to_path_buf()),
        skill_launcher_dir,
        notifier: Some(Arc::new(ChannelNotifier(finished_tx))),
        // WP-PROC's SurvivorWatch is not wired yet; until it lands a finished command's survivors
        // are not tracked.
        survivors: None,
        elevation: Arc::new(OsPromptElevation),
        oem: host_oem(),
        skill_runtime,
        shell_path: crate::shell_name::resolve_program_current(),
        shell_name: crate::shell_name::resolve_current(),
        // The ext-host-backed `ScriptSyntax` (WP-TOOLS-EXEC) is not wired yet; without one a
        // script body containing `await` stays inline, as the trait documents.
        script_syntax: None,
        windows: cfg!(windows),
        // Node's default shell on Windows is PowerShell.
        powershell: cfg!(windows),
        wake: wakes.clone(),
        policy: Arc::new(NodeCommandPolicy),
        now_ms: Arc::new(now_ms),
    });
    (Exec { runtime, wakes }, ExecEvents { finished, thread_strips, host_strip })
}
