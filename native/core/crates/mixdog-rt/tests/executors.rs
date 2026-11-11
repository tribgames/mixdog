//! Executor behaviour through the real tokens: one process-wide install, as in the daemon.
//! Each test that blocks a lane uses a lane of its own so tests can run in parallel.

use std::future::Future;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering::SeqCst;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use mixdog_rt::AlreadyInstalled;
use mixdog_rt::Backend;
use mixdog_rt::CancellationToken;
use mixdog_rt::JobDropped;
use mixdog_rt::LaneFull;
use mixdog_rt::LaneKind;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_rt::TaskClass;
use mixdog_rt::ThreadKind;
use mixdog_rt::ThreadToken;
use mixdog_rt::exec::Executors;
use mixdog_rt::exec::PoolParams;
use mixdog_rt::exec::Priority;
use mixdog_rt::exec::RtConfig;

fn rt() -> &'static (Arc<Executors>, LaneTokens) {
    static BOOT: OnceLock<(Arc<Executors>, LaneTokens)> = OnceLock::new();
    BOOT.get_or_init(|| {
        let mut config = RtConfig::for_cores(8);
        let small = PoolParams::fixed(2, 2);
        config.durability_io = small;
        config.maintenance_io = small;
        config.spawn_io = small;
        config.pty_max_live = 2;
        mixdog_rt::exec::boot(config).expect("boot")
    })
}

fn block_on<F: Future>(fut: F) -> F::Output {
    rt().0.handle(TaskClass::Work).block_on(fut)
}

/// A latch that holds lane jobs until the test opens it.
#[derive(Clone)]
struct Gate(Arc<(Mutex<bool>, Condvar)>);

impl Gate {
    fn new() -> Self {
        Self(Arc::new((Mutex::new(false), Condvar::new())))
    }

    fn wait(&self) {
        let (open, cv) = &*self.0;
        let mut open = open.lock().unwrap();
        while !*open {
            open = cv.wait(open).unwrap();
        }
    }

    fn open(&self) {
        *self.0.0.lock().unwrap() = true;
        self.0.1.notify_all();
    }
}

fn lane_snapshot(kind: LaneKind) -> mixdog_rt::exec::LaneSnapshot {
    rt().0
        .diagnostics()
        .lanes
        .into_iter()
        .find(|l| l.kind == kind)
        .unwrap()
}

/// Submits `n` jobs that report when they start and then wait for `gate`.
fn hold_lane<T: LaneToken>(
    token: T,
    n: usize,
    gate: &Gate,
) -> Vec<mixdog_rt::JobHandle<()>> {
    let (started_tx, started_rx) = mpsc::channel();
    let handles: Vec<_> = (0..n)
        .map(|_| {
            let gate = gate.clone();
            let started = started_tx.clone();
            token
                .submit(&CancellationToken::new(), move |_| {
                    started.send(()).unwrap();
                    gate.wait();
                })
                .expect("lane accepts the holding job")
        })
        .collect();
    for _ in 0..n {
        started_rx.recv().expect("holding job started");
    }
    handles
}

#[test]
fn job_runs_on_a_thread_of_its_own_lane() {
    let tokens = rt().1;
    let name = block_on(
        tokens
            .interactive_io
            .submit(&CancellationToken::new(), |_| {
                std::thread::current().name().map(String::from)
            })
            .ok()
            .unwrap(),
    )
    .unwrap();
    assert!(name.unwrap().starts_with("mixdog-io-interactive-"));
    let name = block_on(
        tokens
            .cpu_interactive
            .submit(&CancellationToken::new(), |_| {
                std::thread::current().name().map(String::from)
            })
            .ok()
            .unwrap(),
    )
    .unwrap();
    assert!(name.unwrap().starts_with("mixdog-cpu-interactive-"));
}

#[test]
fn cancelled_job_is_dropped_at_dequeue() {
    let tokens = rt().1;
    let gate = Gate::new();
    let holders = hold_lane(tokens.maintenance_io, 2, &gate);

    let ran = Arc::new(AtomicBool::new(false));
    let token = CancellationToken::new();
    let ran_in_job = ran.clone();
    let queued = tokens
        .maintenance_io
        .submit(&token, move |_| ran_in_job.store(true, SeqCst))
        .expect("queue has room");
    token.cancel();
    gate.open();

    assert_eq!(block_on(queued), Err(JobDropped));
    assert!(!ran.load(SeqCst), "a cancelled job must not run");
    for h in holders {
        block_on(h).unwrap();
    }
    assert!(lane_snapshot(LaneKind::MaintenanceIo).dropped_cancelled >= 1);
}

#[test]
fn full_queue_answers_lane_full_at_once() {
    let tokens = rt().1;
    let gate = Gate::new();
    let holders = hold_lane(tokens.spawn_io, 2, &gate);
    let queued: Vec<_> = (0..2)
        .map(|_| {
            tokens
                .spawn_io
                .submit(&CancellationToken::new(), |_| ())
                .expect("queue has room")
        })
        .collect();

    let refused = tokens.spawn_io.submit(&CancellationToken::new(), |_| ());
    assert_eq!(
        refused.err(),
        Some(LaneFull {
            lane: LaneKind::SpawnIo
        })
    );
    assert!(lane_snapshot(LaneKind::SpawnIo).rejected >= 1);

    gate.open();
    for h in holders {
        block_on(h).unwrap();
    }
    for h in queued {
        block_on(h).unwrap();
    }
}

#[test]
fn a_stalled_lane_does_not_delay_another() {
    let tokens = rt().1;
    let gate = Gate::new();
    let holders = hold_lane(tokens.durability_io, 2, &gate);

    let value = block_on(
        tokens
            .interactive_io
            .submit(&CancellationToken::new(), |_| 7)
            .ok()
            .unwrap(),
    );
    assert_eq!(value, Ok(7));

    gate.open();
    for h in holders {
        block_on(h).unwrap();
    }
}

#[test]
fn a_panicking_job_resolves_dropped_and_the_lane_keeps_serving() {
    let tokens = rt().1;
    let failed = block_on(
        tokens
            .cpu_bulk
            .submit(&CancellationToken::new(), |_| -> u32 { panic!("job panic") })
            .ok()
            .unwrap(),
    );
    assert_eq!(failed, Err(JobDropped));
    let after = block_on(
        tokens
            .cpu_bulk
            .submit(&CancellationToken::new(), |_| 5u32)
            .ok()
            .unwrap(),
    );
    assert_eq!(after, Ok(5));
    assert!(lane_snapshot(LaneKind::CpuBulk).panicked >= 1);
}

#[test]
fn pty_lane_gives_each_job_a_thread_up_to_the_cap() {
    let tokens = rt().1;
    let gate = Gate::new();
    let holders = hold_lane(tokens.pty_io, 2, &gate);
    assert_eq!(lane_snapshot(LaneKind::PtyIo).threads, 2);
    let refused = tokens.pty_io.submit(&CancellationToken::new(), |_| ());
    assert_eq!(
        refused.err(),
        Some(LaneFull {
            lane: LaneKind::PtyIo
        })
    );

    gate.open();
    for h in holders {
        block_on(h).unwrap();
    }
    // The handle resolves inside the job; the slot is released when its thread ends.
    while lane_snapshot(LaneKind::PtyIo).threads != 0 {
        std::thread::yield_now();
    }
    let name = block_on(
        tokens
            .pty_io
            .submit(&CancellationToken::new(), |_| {
                std::thread::current().name().map(String::from)
            })
            .ok()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(name.as_deref(), Some("mixdog-io-pty"));
}

#[test]
fn second_install_is_refused() {
    let _ = rt();
    let second = Arc::new(Executors::start(RtConfig::for_cores(2)).unwrap());
    assert_eq!(mixdog_rt::install(second).err(), Some(AlreadyInstalled));
}

#[test]
fn async_tasks_run_on_their_own_runtime() {
    let _ = rt();
    let name = |class: TaskClass| {
        block_on(mixdog_rt::spawn("rt-test-thread-name", class, async {
            std::thread::current().name().map(String::from)
        }))
        .unwrap()
        .unwrap()
    };
    assert!(name(TaskClass::Control).starts_with("mixdog-rt-c"));
    assert!(name(TaskClass::Work).starts_with("mixdog-rt-w"));
}

#[test]
fn polls_are_recorded_per_task_and_class() {
    let (executors, _) = rt();
    block_on(mixdog_rt::spawn("rt-test-quiet", TaskClass::Work, async {
        tokio::task::yield_now().await;
    }))
    .unwrap();
    let diag = executors.diagnostics();
    let quiet = diag
        .tasks
        .iter()
        .find(|t| t.task == "rt-test-quiet")
        .expect("task recorded");
    assert_eq!(quiet.class, TaskClass::Work);
    assert!(quiet.poll.count >= 2, "yield makes two polls");
    assert_eq!(quiet.over_bound, 0);
}

fn spin(duration: Duration) {
    let started = Instant::now();
    while started.elapsed() < duration {
        std::hint::spin_loop();
    }
}

#[test]
fn a_blocking_task_fails_the_gate_run() {
    let (executors, _) = rt();
    block_on(mixdog_rt::spawn(
        "rt-test-blocks-control",
        TaskClass::Control,
        async { spin(Duration::from_millis(15)) },
    ))
    .unwrap();
    block_on(mixdog_rt::spawn(
        "rt-test-blocks-work",
        TaskClass::Work,
        async { spin(Duration::from_millis(70)) },
    ))
    .unwrap();
    // 20 ms is under the RT-W bound and must not be flagged.
    block_on(mixdog_rt::spawn(
        "rt-test-within-bound",
        TaskClass::Work,
        async { spin(Duration::from_millis(20)) },
    ))
    .unwrap();

    let failure = executors.check_poll_bounds().unwrap_err();
    let tasks: Vec<_> = failure.violations.iter().map(|v| v.task).collect();
    assert!(tasks.contains(&"rt-test-blocks-control"));
    assert!(tasks.contains(&"rt-test-blocks-work"));
    assert!(!tasks.contains(&"rt-test-within-bound"));
    assert!(failure.to_string().contains("rt-test-blocks-control [RT-C]"));
}

#[test]
fn clean_run_passes_the_gate() {
    let executors = Executors::start(RtConfig::for_cores(2)).unwrap();
    executors.record_poll("fast", TaskClass::Control, Duration::from_millis(5));
    executors.record_poll("fast", TaskClass::Work, Duration::from_millis(50));
    assert!(executors.check_poll_bounds().is_ok());
    executors.record_poll("slow", TaskClass::Control, Duration::from_millis(6));
    assert_eq!(executors.check_poll_bounds().unwrap_err().total, 1);
}

#[test]
fn thread_tokens_register_and_set_priority() {
    let (executors, tokens) = rt();
    let level = tokens
        .control_thread
        .spawn_thread("rt-test-control", |_| os_level())
        .unwrap()
        .join()
        .unwrap();
    assert_eq!(level, expected_level(Priority::AboveNormal));
    let level = tokens
        .media_thread
        .spawn_thread("rt-test-media", |_| os_level())
        .unwrap()
        .join()
        .unwrap();
    assert_eq!(level, expected_level(Priority::BelowNormal));
    let diag = executors.diagnostics();
    let entered = |kind| {
        diag.threads_entered
            .iter()
            .find(|t| t.kind == kind)
            .unwrap()
            .entered
    };
    assert!(entered(ThreadKind::Control) >= 1);
    assert!(entered(ThreadKind::WebrtcMedia) >= 1);
    assert_eq!(diag.priority_failures, 0);
}

#[test]
fn executors_run_at_their_os_priority() {
    let tokens = rt().1;
    let none = CancellationToken::new();
    // Small lanes may be held by parallel tests; wait for room.
    fn on_lane(
        mut submit: impl FnMut() -> Result<mixdog_rt::JobHandle<i32>, LaneFull>,
    ) -> i32 {
        loop {
            match submit() {
                Ok(handle) => return block_on(handle).unwrap(),
                Err(_) => std::thread::yield_now(),
            }
        }
    }
    assert_eq!(
        on_lane(|| tokens.cpu_interactive.submit(&none, |_| os_level())),
        expected_level(Priority::AboveNormal)
    );
    assert_eq!(
        on_lane(|| tokens.cpu_bulk.submit(&none, |_| os_level())),
        expected_level(Priority::BelowNormal)
    );
    assert_eq!(
        on_lane(|| tokens.interactive_io.submit(&none, |_| os_level())),
        expected_level(Priority::Normal)
    );
    assert_eq!(
        on_lane(|| tokens.maintenance_io.submit(&none, |_| os_level())),
        expected_level(Priority::BelowNormal)
    );
    let task_level = |class| {
        block_on(mixdog_rt::spawn("rt-test-priority", class, async { os_level() })).unwrap()
    };
    assert_eq!(
        task_level(TaskClass::Control),
        expected_level(Priority::AboveNormal)
    );
    assert_eq!(task_level(TaskClass::Work), expected_level(Priority::Normal));
    assert_eq!(rt().0.diagnostics().priority_failures, 0);
}

#[cfg(windows)]
fn os_level() -> i32 {
    use windows_sys::Win32::System::Threading::GetCurrentThread;
    use windows_sys::Win32::System::Threading::GetThreadPriority;
    // SAFETY: reads the calling thread's priority through its pseudo handle.
    unsafe { GetThreadPriority(GetCurrentThread()) }
}

#[cfg(windows)]
fn expected_level(priority: Priority) -> i32 {
    match priority {
        Priority::AboveNormal => 1,
        Priority::Normal => 0,
        Priority::BelowNormal => -1,
    }
}

#[cfg(target_os = "linux")]
fn os_level() -> i32 {
    // SAFETY: reads the nice value of the calling thread.
    unsafe {
        let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
        libc::getpriority(libc::PRIO_PROCESS, tid)
    }
}

#[cfg(target_os = "linux")]
fn expected_level(priority: Priority) -> i32 {
    match priority {
        Priority::AboveNormal | Priority::Normal => 0,
        Priority::BelowNormal => 10,
    }
}

// macOS exposes no per-thread QoS read-back that is stable across releases; the priority
// tests compare constants there.
#[cfg(target_os = "macos")]
fn os_level() -> i32 {
    0
}

#[cfg(target_os = "macos")]
fn expected_level(_priority: Priority) -> i32 {
    0
}
