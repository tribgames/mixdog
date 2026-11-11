//! Start latency of the `shell` tool on this machine: the time from the tool call to the process
//! start it reports (`ToolProgress::ProcessStarted`), for 1 call at a time and for 30 concurrent
//! trivial calls, then for 30 concurrent calls while both io-maintenance threads are held by jobs
//! that do not return (two long searches). Real executors, the real process manager, the
//! production shell configuration of the platform (PowerShell host with direct `.exe` spawns on
//! Windows), a data directory with skill launchers. A measurement for reports, never a test.
//!
//! `cargo run -p mixdog-tools --example shell_start_latency` (temp files under `TEMP`).
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "a measurement binary: it sets up and removes its own temp directory on the main thread"
)]

use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::mock::MockApprovalGate;
use mixdog_core_api::domain::mock::MockFileService;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::domain::tool::ProgressSink;
use mixdog_core_api::domain::tool::SurfaceKind;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_core_api::domain::tool::ToolProgress;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use mixdog_protocol::TurnId;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_rt::exec::RtConfig;
use mixdog_tools::exec::ExecConfig;
use mixdog_tools::exec::ExecRuntime;
use mixdog_tools::exec::FixedShell;
use mixdog_tools::exec::IoLanes;
use mixdog_tools::exec::OsPromptElevation;
use mixdog_tools::exec::ShellTool;
use mixdog_tools::exec::SkillRuntime;
use mixdog_tools::exec::WakeHub;
use tokio_util::sync::CancellationToken;

const CONCURRENT: usize = 30;
const SINGLE_RUNS: usize = 20;
const CONCURRENT_ROUNDS: usize = 5;
/// How long the held scenario waits for its calls to start.
const HELD_DEADLINE: Duration = Duration::from_secs(20);

struct NoPublisher;
impl mixdog_spawn::tasks::TaskPublisher for NoPublisher {
    fn thread_updated(&self, _: &str, _: &mixdog_spawn::tasks::ShellJobsState) {}
    fn host_updated(&self, _: &mixdog_spawn::tasks::HostShellJobs) {}
    fn schedule_expiry(&self, _: u64) {}
}

struct InlineSyntax;
#[async_trait::async_trait]
impl mixdog_tools::exec::ScriptSyntax for InlineSyntax {
    async fn compiles_as_commonjs(&self, _: &ThreadId, _: &str) -> Result<bool, mixdog_core_api::domain::ext::ExtError> {
        Ok(false)
    }
}

/// Keeps the instant the process start was reported.
#[derive(Default)]
struct StartSeen(OnceLock<Instant>);
impl ProgressSink for StartSeen {
    fn progress(&self, progress: ToolProgress) {
        if matches!(progress, ToolProgress::ProcessStarted(_)) {
            let _ = self.0.set(Instant::now());
        }
    }
}

struct Bench {
    shell: ShellTool,
    tokens: LaneTokens,
    processes: Arc<dyn ProcessManager>,
    cwd: AbsPath,
    next: std::sync::atomic::AtomicUsize,
}

impl Bench {
    /// One trivial call; `None` when it reported no process start.
    async fn call(&self) -> Option<Duration> {
        let n = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let seen = Arc::new(StartSeen::default());
        let ctx = ToolContext {
            call_id: ToolCallId::from(format!("b{n}").as_str()),
            thread_id: ThreadId::from(format!("bench-{}", n % CONCURRENT).as_str()),
            turn_id: TurnId::from("r"),
            tool: "shell".into(),
            cwd: self.cwd.clone(),
            surface: SurfaceKind::Lead,
            cancel: CancellationToken::new(),
            deadline: None,
            progress: seen.clone(),
            io: ToolIo {
                interactive: self.tokens.interactive_io,
                durability: self.tokens.durability_io,
                maintenance: self.tokens.maintenance_io,
            },
            approvals: Arc::new(MockApprovalGate::default()),
            files: Arc::new(MockFileService::default()),
            processes: self.processes.clone(),
            options: Default::default(),
            review: None,
        };
        let command = if cfg!(windows) { "cmd /d /c exit 0" } else { "true" };
        let called = Instant::now();
        let outcome = self.shell.call(&ctx, serde_json::json!({ "command": command })).await;
        if let Err(error) = &outcome {
            eprintln!("call {n} failed: {}", error.message_for_model);
        }
        seen.0.get().map(|started| started.duration_since(called))
    }

    async fn concurrent(&self, count: usize) -> Vec<Option<Duration>> {
        futures::future::join_all((0..count).map(|_| self.call())).await
    }
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn report(label: &str, samples: &[Option<Duration>]) {
    let mut started: Vec<Duration> = samples.iter().flatten().copied().collect();
    started.sort();
    let missing = samples.len() - started.len();
    if started.is_empty() {
        println!("{label}: no call started ({missing} of {})", samples.len());
        return;
    }
    let p50 = started[started.len() / 2];
    let p90 = started[(started.len() * 9 / 10).min(started.len() - 1)];
    let max = started[started.len() - 1];
    println!(
        "{label}: n={} p50={:.1} ms p90={:.1} ms max={:.1} ms{}",
        started.len(),
        ms(p50),
        ms(p90),
        ms(max),
        if missing > 0 { format!(" ({missing} never started)") } else { String::new() }
    );
}

fn main() {
    let (_executors, tokens) = mixdog_rt::exec::boot(RtConfig::detect()).expect("the executors");
    let root = std::env::temp_dir().join(format!("shell-start-latency-{}", std::process::id()));
    std::fs::create_dir_all(root.join("cwd")).expect("the bench directory");
    let windows = cfg!(windows);
    let runtime = ExecRuntime::new(ExecConfig {
        tasks: Arc::new(mixdog_spawn::tasks::TaskRegistry::new(Arc::new(NoPublisher), || 0)),
        lanes: IoLanes {
            interactive: tokens.interactive_io,
            durability: tokens.durability_io,
            maintenance: tokens.maintenance_io,
            spawn: tokens.spawn_io,
            pty: tokens.pty_io,
        },
        spill_dir: root.join("data").join("scratch").join("jobs"),
        data_dir: Some(root.join("data")),
        skill_launcher_dir: None,
        notifier: None,
        survivors: None,
        wake: WakeHub::new(),
        policy: Arc::new(mixdog_tools::policy::exec::NodeCommandPolicy),
        elevation: Arc::new(OsPromptElevation),
        oem: None,
        skill_runtime: Some(SkillRuntime {
            platform: if windows { "win32" } else { "linux" }.into(),
            interpreter: std::env::current_exe().unwrap().to_string_lossy().into_owned(),
            entry: "skill-entry.js".into(),
            electron: false,
        }),
        shell: Arc::new(FixedShell(if windows { "powershell.exe" } else { "/bin/sh" }.into())),
        script_syntax: Arc::new(InlineSyntax),
        windows,
        powershell: windows,
        now_ms: Arc::new(|| 0),
    });
    let bench = Bench {
        shell: ShellTool::new(runtime),
        tokens,
        processes: Arc::new(mixdog_spawn::LocalProcessManager::new(tokens.spawn_io, mixdog_spawn::ProcessConfig::default())),
        cwd: AbsPath::new(root.join("cwd")).unwrap(),
        next: Default::default(),
    };
    let driver = tokio::runtime::Builder::new_multi_thread().worker_threads(4).enable_all().build().unwrap();
    driver.block_on(async {
        // The first call writes the launchers and warms the caches.
        bench.call().await;
        let mut single = Vec::new();
        for _ in 0..SINGLE_RUNS {
            single.push(bench.call().await);
        }
        report("1 call", &single);
        let mut many = Vec::new();
        for _ in 0..CONCURRENT_ROUNDS {
            many.extend(bench.concurrent(CONCURRENT).await);
        }
        report(&format!("{CONCURRENT} concurrent calls"), &many);

        // Both io-maintenance threads held, as by two long searches.
        let mut releases = Vec::new();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        for _ in 0..2 {
            let (release, held) = std::sync::mpsc::channel::<()>();
            let started = started_tx.clone();
            tokens
                .maintenance_io
                .submit(&CancellationToken::new(), move |_| {
                    started.send(()).unwrap();
                    let _ = held.recv();
                })
                .expect("io-maintenance takes the holder");
            releases.push(release);
        }
        for _ in 0..2 {
            started_rx.recv_timeout(Duration::from_secs(60)).expect("both io-maintenance threads are held");
        }
        let calls = futures::future::join_all((0..CONCURRENT).map(|_| bench.call()));
        let held = tokio::time::timeout(HELD_DEADLINE, calls).await;
        match held {
            Ok(samples) => report(&format!("{CONCURRENT} concurrent calls, io-maintenance held"), &samples),
            Err(_) => println!(
                "{CONCURRENT} concurrent calls, io-maintenance held: not finished within {} s",
                HELD_DEADLINE.as_secs()
            ),
        }
        drop(releases);
    });
    let _ = std::fs::remove_dir_all(&root);
}
