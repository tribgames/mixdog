//! The wait for a launched core, run through `server-ensure` against a scripted core: what the user is told in each ending,
//! and that the install lock is free after each.

use std::cell::RefCell;
use std::path::PathBuf;

use sha2::Digest;

use super::*;
use crate::server_ensure::args::Mode;
use crate::server_ensure::host::ProcessImage;

const LOOK: Duration = Duration::from_secs(10);

/// A launched core seen once per look: `phases[look]` (the last one stays), an exit and a gone session at given looks.
struct Scripted {
    phases: Vec<DiscoveryPhase>,
    exit_at: Option<usize>,
    gone_at: Option<usize>,
    look: usize,
    /// The look this core was first watched at; its phases count from there (the clock of a run is shared by every core).
    origin: usize,
    /// The core runs through the model proxy (published once it serves).
    model_proxy: bool,
    pid: u32,
    instance: String,
}

impl Scripted {
    fn new(phases: &[DiscoveryPhase]) -> Self {
        Self { phases: phases.to_vec(), exit_at: None, gone_at: None, look: 0, origin: 0, model_proxy: true, pid: 900, instance: "i".into() }
    }
    fn instance(mut self, pid: u32, instance: &str) -> Self {
        self.pid = pid;
        self.instance = instance.into();
        self
    }
}

fn named(pid: u32, instance: &str, mut core: ServerCore) -> ServerCore {
    core.pid = pid;
    core.instance_id = instance.into();
    core.raw = format!(r#"{{"pid":{pid},"instanceId":"{instance}"}}"#);
    core
}

fn served_as(state: DiscoveryPhase, model_proxy: bool) -> ServerCore {
    ServerCore {
        pid: 900,
        version: "1.5.0".into(),
        build: "b".into(),
        instance_id: "i".into(),
        state,
        process_start_time: "1".into(),
        control_port: 1,
        model_proxy,
        token: "t".into(),
        raw: "{}".into(),
    }
}

impl BootWatch for Scripted {
    fn exited(&mut self) -> Result<Option<Option<i32>>, EnsureError> {
        Ok((self.exit_at == Some(self.look)).then_some(Some(1)))
    }
    fn core(&mut self) -> Result<Option<ServerCore>, EnsureError> {
        // The proxy endpoint is only published once serving.
        let state = self.phases[(self.look - self.origin).min(self.phases.len() - 1)];
        Ok(Some(named(self.pid, &self.instance, served_as(state, self.model_proxy && state == DiscoveryPhase::Serving))))
    }
    fn controller_gone(&mut self) -> bool {
        self.gone_at.is_some_and(|at| self.look >= at)
    }
    fn elapsed(&self) -> Duration {
        LOOK * u32::try_from(self.look).unwrap()
    }
    fn pause(&mut self) {
        self.look += 1;
    }
    fn log(&mut self) -> (String, String) {
        ("core.log".into(), "migrating the sessions".into())
    }
}

/// The access a run goes through: `found` is what discovery shows, `await_core` and `await_serving` are the real wait over
/// a script, and every other call is recorded.
struct Access {
    found: RefCell<Option<ServerCore>>,
    launch_script: RefCell<Option<Scripted>>,
    /// What each wait for a core of an earlier run observes, in order.
    adopt_scripts: RefCell<std::collections::VecDeque<Scripted>>,
    /// What discovery shows after each core waited for has exited, in order.
    after_exit: RefCell<std::collections::VecDeque<Option<ServerCore>>>,
    /// The looks gone by across every wait of the run: one clock, so one deadline.
    clock: std::cell::Cell<usize>,
    calls: RefCell<Vec<String>>,
    awaited: RefCell<Vec<(u32, String)>>,
    /// The work the core found by discovery is running (what its stop reports).
    running: Vec<crate::lifecycle::RunningWork>,
}

impl Access {
    fn launching(script: Scripted) -> Self {
        Self {
            found: RefCell::default(),
            launch_script: RefCell::new(Some(script)),
            adopt_scripts: RefCell::default(),
            after_exit: RefCell::default(),
            clock: std::cell::Cell::new(0),
            calls: RefCell::default(),
            awaited: RefCell::default(),
            running: Vec::new(),
        }
    }
    /// A core of an earlier run that discovery shows, and what the wait for it observes.
    fn meeting(found: ServerCore, script: Scripted) -> Self {
        Self::chain(found, vec![script], Vec::new())
    }
    /// The core `found`, then the instances that replace it: `scripts` are what each wait observes, `after_exit` what
    /// discovery names once the waited-for instance has exited.
    fn chain(found: ServerCore, scripts: Vec<Scripted>, after_exit: Vec<Option<ServerCore>>) -> Self {
        let access = Self::launching(Scripted::new(&[DiscoveryPhase::Serving]));
        *access.launch_script.borrow_mut() = None;
        *access.found.borrow_mut() = Some(found);
        access.adopt_scripts.borrow_mut().extend(scripts);
        access.after_exit.borrow_mut().extend(after_exit);
        access
    }
    fn call(&self, what: &str) {
        self.calls.borrow_mut().push(what.to_owned());
    }
}

impl CoreAccess for Access {
    fn discovery(&self) -> Result<Option<ServerCore>, EnsureError> {
        Ok(self.found.borrow().clone())
    }
    fn answers(&self, _: &ServerCore) -> bool {
        true
    }
    fn hold(&self, _: &ServerCore, _: bool) -> Result<(), EnsureError> {
        self.call("hold");
        Ok(())
    }
    fn stop_when_idle(&self, _: &ServerCore, _: StopReason, _: Option<&ReplacementBuild>) -> Result<Option<DrainReport>, EnsureError> {
        self.call("stop");
        Ok(Some(DrainReport { drain_id: "d".into(), running: self.running.clone(), confirm_token: "ct".into() }))
    }
    fn stop_confirmed(&self, _: &ServerCore, _: StopReason, _: &str, _: Option<&ReplacementBuild>) -> Result<bool, EnsureError> {
        self.call("stop_confirmed");
        Ok(true)
    }
    fn wait_exit(&self, _: &ServerCore) -> Result<(), EnsureError> {
        self.call("wait_exit");
        Ok(())
    }
    fn terminate(&self, _: &ServerCore) -> Result<(), EnsureError> {
        self.call("terminate");
        Ok(())
    }
    fn launch(&self, _: &Launch) -> Result<(), EnsureError> {
        self.call("launch");
        Ok(())
    }
    fn await_core(&self) -> Result<CoreReport, EnsureError> {
        wait_for_core(&mut self.launch_script.borrow_mut().take().unwrap(), READY_BOUND)
    }
    fn await_serving(&self, core: &ServerCore, _since: std::time::Instant) -> Result<CoreReport, EnsureError> {
        self.awaited.borrow_mut().push((core.pid, core.instance_id.clone()));
        let mut script = self.adopt_scripts.borrow_mut().pop_front().expect("a script for each wait");
        (script.look, script.origin) = (self.clock.get(), self.clock.get());
        let ended = wait_for_core(&mut script, READY_BOUND);
        self.clock.set(script.look);
        if matches!(ended, Ok(CoreReport::Exited { .. })) {
            *self.found.borrow_mut() = self.after_exit.borrow_mut().pop_front().expect("what discovery shows after the exit");
        }
        ended
    }
}

struct Host(PathBuf);

impl EnsureHost for Host {
    fn home(&self) -> PathBuf {
        self.0.clone()
    }
    fn uid(&self) -> u32 {
        1000
    }
    fn hostname(&self) -> String {
        "h".into()
    }
    fn process_alive(&self, _: u32) -> bool {
        true
    }
    fn process_images(&self) -> Option<Vec<ProcessImage>> {
        Some(Vec::new())
    }
    fn now_ms(&self) -> u64 {
        0
    }
    fn pause(&self, _: Duration) {}
}

/// One `server-ensure` ensure run that launches a core the script plays; returns what the desktop receives and whether the
/// install lock is free afterwards.
fn ensure_run(script: Scripted) -> (Result<super::super::report::Report, EnsureError>, bool) {
    ensure_with(&Access::launching(script), None)
}

fn ensure_with(access: &Access, model_login: Option<crate::server_ensure::args::ModelLogin>) -> (Result<super::super::report::Report, EnsureError>, bool) {
    ensure_confirmed(access, model_login, None)
}

fn ensure_confirmed(
    access: &Access,
    model_login: Option<crate::server_ensure::args::ModelLogin>,
    confirm_token: Option<String>,
) -> (Result<super::super::report::Report, EnsureError>, bool) {
    let home = tempfile::tempdir().unwrap();
    let exe = home.path().join("staged");
    std::fs::write(&exe, b"mixdogd").unwrap();
    let args = ProgramArgs {
        mode: Mode::Ensure,
        install_id: "1.5.0-b".into(),
        version: "1.5.0".into(),
        build: "b".into(),
        upload: true,
        sha256: Some(crate::lifecycle::hex(&sha2::Sha256::digest(b"mixdogd"))),
        confirm_token,
        model_login,
        phase: None,
        remove_user_data: false,
        lock_wait_ms: Some(50),
        lock_stale_ms: None,
        grace_ms: None,
    };
    let result = run(&args, &Host(home.path().to_owned()), access, &exe);
    let free = !RemotePaths::new(home.path()).lock.exists();
    (result, free)
}

#[test]
fn a_core_that_migrates_and_then_serves_is_the_ready_core() {
    let (result, free) = ensure_run(Scripted::new(&[DiscoveryPhase::Booting, DiscoveryPhase::Migrating, DiscoveryPhase::Migrating, DiscoveryPhase::Serving]));
    let report = result.unwrap();
    assert!(report.started && report.healthy, "the user sees a started, serving core");
    assert!(free);
}

#[test]
fn a_core_stuck_in_migration_ends_in_daemon_timeout_and_frees_the_lock() {
    let (result, free) = ensure_run(Scripted::new(&[DiscoveryPhase::Migrating]));
    let error = result.unwrap_err();
    assert_eq!(error.code(), "daemon-timeout");
    let line = result_line(&Err(error));
    assert!(line.starts_with("MIXDOG_ERROR daemon-timeout "), "{line}");
    assert!(line.contains("within 45 s") && line.contains("still migrating") && line.contains("migrating the sessions"), "{line}");
    assert!(free, "the install lock is released");
}

#[test]
fn the_session_going_away_ends_the_wait_and_frees_the_lock() {
    let mut script = Scripted::new(&[DiscoveryPhase::Migrating]);
    script.gone_at = Some(2);
    let (result, free) = ensure_run(script);
    assert_eq!(result.unwrap_err().code(), "controller-gone");
    assert!(free, "the install lock is released");
}

#[test]
fn a_core_that_exits_during_the_wait_is_reported_as_exited() {
    let mut script = Scripted::new(&[DiscoveryPhase::Migrating]);
    script.exit_at = Some(2);
    let (result, free) = ensure_run(script);
    let error = result.unwrap_err();
    assert_eq!(error.code(), "core-exited");
    assert!(error.to_string().contains("status 1"), "{error}");
    assert!(free);
}

/// A core of this install that an earlier run (one that ended in `daemon-timeout`) left migrating: this run waits for that
/// same instance and decides on what it publishes once serving. Nothing is stopped and nothing is launched.
fn reconnect_while_migrating(model_login: Option<crate::server_ensure::args::ModelLogin>, runs_through_proxy: bool) {
    let mut script = Scripted::new(&[DiscoveryPhase::Migrating, DiscoveryPhase::Migrating, DiscoveryPhase::Serving]);
    script.model_proxy = runs_through_proxy;
    let access = Access::meeting(served_as(DiscoveryPhase::Migrating, false), script);
    let (result, free) = ensure_with(&access, model_login);
    let report = result.unwrap();
    assert!(report.healthy && report.core_current && !report.started, "the migrating core is the current one once it serves");
    assert_eq!(*access.awaited.borrow(), [(900, "i".to_owned())], "the wait is on the same pid and instance");
    assert!(access.calls.borrow().is_empty(), "no stop, no launch: {:?}", access.calls.borrow());
    assert!(free);
}

#[test]
fn a_reconnect_while_the_core_still_migrates_waits_for_it_with_the_pcs_login() {
    reconnect_while_migrating(None, true);
}

#[test]
fn a_reconnect_while_the_core_still_migrates_waits_for_it_with_the_servers_login() {
    reconnect_while_migrating(Some(crate::server_ensure::args::ModelLogin::Server), false);
}

#[test]
fn a_reconnect_that_finds_the_migrating_core_stuck_times_out_and_stops_nothing() {
    let access = Access::meeting(served_as(DiscoveryPhase::Migrating, false), Scripted::new(&[DiscoveryPhase::Migrating]));
    let (result, free) = ensure_with(&access, None);
    assert_eq!(result.unwrap_err().code(), "daemon-timeout");
    assert!(access.calls.borrow().is_empty(), "the migrating core is not stopped: {:?}", access.calls.borrow());
    assert!(free);
}

#[test]
fn a_settled_core_of_the_other_login_mode_is_still_replaced() {
    let mut other = served_as(DiscoveryPhase::Serving, false);
    other.instance_id = "i".into();
    let access = Access::meeting(other, Scripted::new(&[DiscoveryPhase::Serving]));
    *access.launch_script.borrow_mut() = Some(Scripted::new(&[DiscoveryPhase::Serving]));
    let (result, _) = ensure_with(&access, None);
    let report = result.unwrap();
    assert!(report.started && report.replaced.is_some());
    assert_eq!(*access.calls.borrow(), ["hold", "stop", "wait_exit", "launch"]);
    assert!(access.awaited.borrow().is_empty(), "a serving core is decided on at once");
}

fn instance_b_migrating() -> ServerCore {
    named(901, "j", served_as(DiscoveryPhase::Migrating, false))
}

/// The instance A waited for exits (at look 1) and discovery then names a same-build instance B that is migrating too: B is
/// waited for as A was, and decided on once it serves.
fn replacement_migrates_then_serves(model_login: Option<crate::server_ensure::args::ModelLogin>, runs_through_proxy: bool) {
    let mut a = Scripted::new(&[DiscoveryPhase::Migrating]);
    a.exit_at = Some(1);
    let mut b = Scripted::new(&[DiscoveryPhase::Migrating, DiscoveryPhase::Migrating, DiscoveryPhase::Serving]).instance(901, "j");
    b.model_proxy = runs_through_proxy;
    let access = Access::chain(served_as(DiscoveryPhase::Migrating, false), vec![a, b], vec![Some(instance_b_migrating())]);
    let (result, free) = ensure_with(&access, model_login);
    let report = result.unwrap();
    assert!(report.healthy && report.core_current && !report.started);
    let raw = report.daemon_json.unwrap();
    assert!(raw.contains(r#""pid":901"#) && raw.contains(r#""instanceId":"j""#), "the report names B: {raw}");
    assert_eq!(*access.awaited.borrow(), [(900, "i".to_owned()), (901, "j".to_owned())]);
    assert!(access.calls.borrow().is_empty(), "no stop, no launch: {:?}", access.calls.borrow());
    assert!(free);
}

#[test]
fn a_replacement_instance_that_is_migrating_is_waited_for_too_with_the_pcs_login() {
    replacement_migrates_then_serves(None, true);
}

#[test]
fn a_replacement_instance_that_is_migrating_is_waited_for_too_with_the_servers_login() {
    replacement_migrates_then_serves(Some(crate::server_ensure::args::ModelLogin::Server), false);
}

#[test]
fn a_waited_for_core_that_vanishes_with_nothing_in_its_place_is_a_normal_launch() {
    let mut a = Scripted::new(&[DiscoveryPhase::Migrating]);
    a.exit_at = Some(1);
    let access = Access::chain(served_as(DiscoveryPhase::Migrating, false), vec![a], vec![None]);
    *access.launch_script.borrow_mut() = Some(Scripted::new(&[DiscoveryPhase::Serving]));
    let (result, _) = ensure_with(&access, None);
    let report = result.unwrap();
    assert!(report.started && report.healthy);
    assert_eq!(*access.calls.borrow(), ["launch"]);
    assert_eq!(*access.awaited.borrow(), [(900, "i".to_owned())]);
}

#[test]
fn a_replacement_instance_that_never_settles_times_out_at_the_one_deadline_and_nothing_is_stopped() {
    let mut a = Scripted::new(&[DiscoveryPhase::Migrating]);
    a.exit_at = Some(1);
    let b = Scripted::new(&[DiscoveryPhase::Migrating]).instance(901, "j");
    let access = Access::chain(served_as(DiscoveryPhase::Migrating, false), vec![a, b], vec![Some(instance_b_migrating())]);
    let (result, free) = ensure_with(&access, None);
    assert_eq!(result.unwrap_err().code(), "daemon-timeout");
    assert_eq!(access.clock.get(), 5, "45 s from the first wait (the looks are 10 s), not from B's");
    assert!(access.calls.borrow().is_empty(), "{:?}", access.calls.borrow());
    assert!(free);
}

/// The core an earlier run started: the same version, another build.
fn older_build() -> ServerCore {
    let mut core = served_as(DiscoveryPhase::Serving, true);
    core.build = "other-build".into();
    core
}

fn launches_the_intended_build(access: &Access) {
    *access.launch_script.borrow_mut() = Some(Scripted::new(&[DiscoveryPhase::Serving]));
}

#[test]
fn an_idle_core_of_the_same_version_and_another_build_is_replaced_and_the_requested_build_is_advertised() {
    let access = Access::chain(older_build(), Vec::new(), Vec::new());
    launches_the_intended_build(&access);
    let (result, free) = ensure_with(&access, None);
    let report = result.unwrap();
    assert!(report.started && report.replaced.is_some(), "the core of another build is not attached to");
    assert!(report.healthy && report.core_current, "the core now serving is the requested build in the requested mode");
    assert_eq!(*access.calls.borrow(), ["hold", "stop", "wait_exit", "launch"], "the ordinary verified replacement");
    assert!(free);
}

#[test]
fn a_busy_core_of_another_build_is_left_intact_until_the_user_confirms_that_instance() {
    use crate::lifecycle::{ActivityKind, RunningWork};
    let mut access = Access::chain(older_build(), Vec::new(), Vec::new());
    access.running = vec![RunningWork { kind: ActivityKind::Turn, thread_id: None, turn_id: None, title: "a turn".into() }];
    let (result, free) = ensure_with(&access, None);
    assert_eq!(result.unwrap_err().code(), "daemon-busy-other-version");
    assert_eq!(*access.calls.borrow(), ["hold", "stop"], "nothing was stopped or started");
    assert!(free);

    launches_the_intended_build(&access);
    let (result, _) = ensure_confirmed(&access, None, Some("ct".into()));
    assert!(result.unwrap().started);
    assert_eq!(access.calls.borrow()[2..], ["hold", "stop", "stop_confirmed", "wait_exit", "launch"]);
}

#[test]
fn a_core_of_the_requested_build_and_mode_is_still_attached_to_and_nothing_is_stopped() {
    let access = Access::chain(served_as(DiscoveryPhase::Serving, true), Vec::new(), Vec::new());
    let (result, _) = ensure_with(&access, None);
    let report = result.unwrap();
    assert!(!report.started && report.core_current);
    assert!(access.calls.borrow().is_empty());
}

#[cfg(unix)]
mod peer {
    use super::super::peer_closed;
    use std::os::fd::AsRawFd;

    fn pipe() -> (i32, i32) {
        let mut fds = [0; 2];
        // SAFETY: `fds` holds the two descriptors `pipe` fills in.
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        (fds[0], fds[1])
    }

    #[test]
    fn a_pipe_whose_reader_closed_is_a_closed_peer_and_one_with_a_reader_is_not() {
        let (read, write) = pipe();
        assert!(!peer_closed(write), "ordinary writability is not a lost controller");
        // SAFETY: the read end is ours and closed once.
        unsafe { libc::close(read) };
        assert!(peer_closed(write));
        // SAFETY: the write end is ours and closed once.
        unsafe { libc::close(write) };
    }

    #[test]
    fn a_regular_file_is_not_a_lost_controller() {
        let file = tempfile::tempfile().unwrap();
        assert!(!peer_closed(file.as_raw_fd()));
    }

    #[test]
    fn dev_null_is_not_a_lost_controller() {
        let null = std::fs::OpenOptions::new().write(true).open("/dev/null").unwrap();
        assert!(!peer_closed(null.as_raw_fd()));
    }
}
