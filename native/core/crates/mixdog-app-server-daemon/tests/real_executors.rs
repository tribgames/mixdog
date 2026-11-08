//! The daemon boots the real executors (`boot_executors`, what `mixdogd serve` calls), not the inline test backend: lane
//! jobs run on their lane's threads, a blocked lane never holds the control runtime, and the stall monitor sees a wedged lane.
//! Own test binary: it installs the process-wide executors.

use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use mixdog_app_server_daemon::boot_executors;
use mixdog_app_server_daemon::lifecycle::CorePort;
use mixdog_app_server_daemon::lifecycle::DiscoveryState;
use mixdog_app_server_daemon::lifecycle::DrainNotice;
use mixdog_app_server_daemon::lifecycle::Exiter;
use mixdog_app_server_daemon::lifecycle::Lifecycle;
use mixdog_app_server_daemon::lifecycle::LifecycleConfig;
use mixdog_app_server_daemon::lifecycle::Ports;
use mixdog_app_server_daemon::lifecycle::Publication;
use mixdog_app_server_daemon::lifecycle::Running;
use mixdog_app_server_daemon::lifecycle::StallConfig;
use mixdog_app_server_daemon::lifecycle::StallMonitor;
use mixdog_app_server_daemon::lifecycle::StallReporter;
use mixdog_app_server_daemon::lifecycle::tokio_post;
use mixdog_rt::Backend;
use mixdog_rt::CancellationToken;
use mixdog_rt::LaneToken;
use mixdog_rt::LaneTokens;
use mixdog_rt::TaskClass;
use mixdog_rt::exec::Executors;

fn rt() -> &'static (Arc<Executors>, LaneTokens) {
    static BOOT: OnceLock<(Arc<Executors>, LaneTokens)> = OnceLock::new();
    BOOT.get_or_init(|| boot_executors().expect("the executors boot"))
}

fn block_on<F: std::future::Future>(fut: F) -> F::Output {
    rt().0.handle(TaskClass::Work).block_on(fut)
}

#[test]
fn a_blocked_lane_job_runs_off_the_caller_and_leaves_the_control_runtime_answering() {
    let tokens = rt().1;
    let caller = std::thread::current().id();
    let ran_on = block_on(tokens.durability_io.submit(&CancellationToken::new(), |_| std::thread::current().id()).expect("the lane takes the job"))
        .expect("the job ran");
    assert_ne!(ran_on, caller, "a lane job runs on a thread of its lane, not on the thread that submitted it");

    let (started, running) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let held = tokens
        .durability_io
        .submit(&CancellationToken::new(), move |_| {
            started.send(()).expect("the test waits for the start");
            released.recv().expect("the test releases the job");
        })
        .expect("the lane takes the holding job");
    running.recv().expect("the holding job started");
    let answered = block_on(mixdog_rt::spawn("control-probe", TaskClass::Control, async { 7 })).expect("the control task ran");
    assert_eq!(answered, 7, "RT-C runs a task while a durability job holds a lane thread");
    release.send(()).expect("the holding job still waits");
    block_on(held).expect("the holding job finished");
}

/// The ports of a lifecycle whose core records the lanes the stall monitor reports.
struct Probe(mpsc::Sender<(String, usize)>);

impl CorePort for Probe {
    fn drain_notice(&self, _: &DrainNotice) {}
    fn health(&self, _: u64) {}
    fn lane_health(&self, lane: &str, wedged: usize) {
        self.0.send((lane.to_owned(), wedged)).expect("the test listens");
    }
    fn cancel_running(&self, _: &[Running]) {}
    fn release_decision(&self, _: u32) {}
    fn final_barriers(&self) {}
    fn close_connections(&self) {}
    fn close_ext_host(&self) {}
    fn close_data_handles(&self) {}
}

impl Publication for Probe {
    fn publish(&self, _: &DiscoveryState) {}
    fn withdraw(&self) {}
}

impl Exiter for Probe {
    fn exit(&self, _: i32) {}
}

#[test]
fn the_stall_monitor_reports_a_lane_wedged_by_a_held_job() {
    let (executors, tokens) = rt();
    let (reported, wedged) = mpsc::channel();
    let probe = Arc::new(Probe(reported));
    let root = tempfile::tempdir().expect("a temp runtime root");
    let lifecycle = Lifecycle::new(
        LifecycleConfig { instance_id: "instance-1".into(), version: "1.4.6".into(), runtime_root: root.path().to_owned() },
        Ports { core: probe.clone(), discovery: probe.clone(), exiter: probe.clone() },
    );
    let reporter = StallReporter::new(probe, root.path().join("stall.jsonl")).watching_lanes(executors.clone());
    let _monitor = StallMonitor::spawn(
        StallConfig { interval: Duration::from_millis(5), report_after: Duration::from_secs(3600) },
        tokio_post(executors.handle(TaskClass::Work)),
        lifecycle,
        reporter,
    );

    let (started, running) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    // Its own lane: the other test holds a durability job on the shared executors, so this one is the only job on io-maintenance.
    let held = tokens
        .maintenance_io
        .submit(&CancellationToken::new(), move |_| {
            started.send(()).expect("the test waits for the start");
            released.recv().expect("the test releases the job");
        })
        .expect("the lane takes the holding job");
    running.recv().expect("the holding job started");
    // Past the lane's lease without waiting for it: the watchdog counts the stuck thread wedged.
    executors.sweep_leases(Instant::now() + Duration::from_secs(3600));

    let reported = wedged.iter().find(|(lane, _)| lane == "io-maintenance").expect("the monitor reports the lane");
    assert_eq!(reported, ("io-maintenance".to_owned(), 1));
    release.send(()).expect("the holding job still waits");
    block_on(held).expect("the holding job finished");
}
