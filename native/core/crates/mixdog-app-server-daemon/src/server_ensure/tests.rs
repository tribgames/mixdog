//! `server-ensure` against a recorded host and core (LR §11.11).

use std::cell::RefCell;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use sha2::Digest;

use super::*;
use crate::lifecycle::ActivityKind;
use crate::lifecycle::DiscoveryPhase;
use crate::lifecycle::RunningWork;
use crate::lifecycle::StopReason;

struct Host {
    home: PathBuf,
    images: Option<Vec<ProcessImage>>,
    alive: bool,
}

impl EnsureHost for Host {
    fn home(&self) -> PathBuf {
        self.home.clone()
    }
    fn uid(&self) -> u32 {
        1000
    }
    fn hostname(&self) -> String {
        "h".into()
    }
    fn process_alive(&self, _: u32) -> bool {
        self.alive
    }
    fn process_images(&self) -> Option<Vec<ProcessImage>> {
        self.images.clone()
    }
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
    }
    fn pause(&self, duration: Duration) {
        std::thread::sleep(duration.min(Duration::from_millis(5)));
    }
}

fn core(version: &str, build: &str, state: DiscoveryPhase) -> ServerCore {
    ServerCore {
        pid: 900,
        version: version.into(),
        build: build.into(),
        instance_id: "i".into(),
        state,
        process_start_time: "1".into(),
        control_port: 1,
        model_proxy: true,
        token: "tok".into(),
        raw: r#"{"pid":900}"#.into(),
    }
}

struct Access {
    found: Option<ServerCore>,
    running: Vec<RunningWork>,
    boot: RefCell<Option<CoreReport>>,
    calls: RefCell<Vec<String>>,
    launched: RefCell<Option<Launch>>,
}

impl Access {
    fn new(found: Option<ServerCore>) -> Self {
        Self {
            found,
            running: Vec::new(),
            boot: RefCell::new(Some(CoreReport::Reached(core("1.4.6", "b6", DiscoveryPhase::Serving)))),
            calls: RefCell::default(),
            launched: RefCell::default(),
        }
    }
    fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }
}

impl CoreAccess for Access {
    fn discovery(&self) -> Result<Option<ServerCore>, EnsureError> {
        Ok(self.found.clone())
    }
    fn hold(&self, _: &ServerCore, on: bool) -> Result<(), EnsureError> {
        self.calls.borrow_mut().push(format!("hold:{on}"));
        Ok(())
    }
    fn stop_when_idle(&self, _: &ServerCore, reason: StopReason) -> Result<DrainReport, EnsureError> {
        self.calls.borrow_mut().push(format!("stop_when_idle:{reason:?}"));
        Ok(DrainReport { drain_id: "d".into(), running: self.running.clone(), confirm_token: "ct".into() })
    }
    fn stop_confirmed(&self, _: &ServerCore, _: StopReason, token: &str) -> Result<(), EnsureError> {
        self.calls.borrow_mut().push(format!("stop_confirmed:{token}"));
        Ok(())
    }
    fn wait_exit(&self, _: &ServerCore) -> Result<(), EnsureError> {
        self.calls.borrow_mut().push("wait_exit".into());
        Ok(())
    }
    fn launch(&self, launch: &Launch) -> Result<(), EnsureError> {
        assert!(launch.exe.ends_with(BINARY_NAME));
        self.calls.borrow_mut().push("launch".into());
        *self.launched.borrow_mut() = Some(launch.clone());
        Ok(())
    }
    fn await_core(&self) -> Result<CoreReport, EnsureError> {
        self.boot.borrow_mut().take().ok_or(EnsureError::Core("no boot".into()))
    }
}

const BODY: &[u8] = b"mixdogd";

/// A server home and the running (uploaded) binary.
struct Env {
    home: tempfile::TempDir,
    exe: PathBuf,
}

fn env() -> Env {
    let home = tempfile::tempdir().unwrap();
    let exe = home.path().join("staged-mixdogd");
    std::fs::write(&exe, BODY).unwrap();
    Env { home, exe }
}

impl Env {
    fn host(&self) -> Host {
        Host { home: self.home.path().to_owned(), images: Some(Vec::new()), alive: true }
    }
    fn paths(&self) -> RemotePaths {
        RemotePaths::new(self.home.path())
    }
    fn run(&self, args: &ProgramArgs, access: &Access) -> Result<Report, EnsureError> {
        run(args, &self.host(), access, &self.exe)
    }
    fn versions(&self) -> Vec<String> {
        std::fs::read_dir(self.paths().versions)
            .map(|d| d.filter_map(Result::ok).map(|e| e.file_name().into_string().unwrap()).collect())
            .unwrap_or_default()
    }
}

fn args(version: &str, build: &str) -> ProgramArgs {
    ProgramArgs {
        mode: Mode::Ensure,
        install_id: format!("{version}-{build}"),
        version: version.into(),
        build: build.into(),
        upload: true,
        sha256: Some(crate::lifecycle::hex(&sha2::Sha256::digest(BODY))),
        confirm_token: None,
        model_login: None,
        phase: None,
        remove_user_data: false,
        lock_wait_ms: Some(50),
        lock_stale_ms: None,
    }
}

fn running(title: &str) -> Vec<RunningWork> {
    vec![RunningWork { kind: ActivityKind::Turn, thread_id: None, turn_id: None, title: title.into() }]
}

#[test]
fn an_older_desktop_is_refused_and_nothing_is_installed_or_stopped() {
    let env = env();
    let access = Access::new(Some(core("1.4.7", "x", DiscoveryPhase::Serving)));
    let error = env.run(&args("1.4.6", "b6"), &access).unwrap_err();
    assert_eq!(error.code(), "client-outdated");
    assert!(result_line(&Err(error)).starts_with("MIXDOG_ERROR client-outdated "));
    assert!(access.calls().is_empty());
    assert!(env.versions().is_empty());
}

#[test]
fn an_equal_core_is_attached_to_and_the_install_is_made_current() {
    let env = env();
    let access = Access::new(Some(core("1.4.6", "b6", DiscoveryPhase::Serving)));
    let report = env.run(&args("1.4.6", "b6"), &access).unwrap();
    assert!(report.installed && report.healthy && report.core_current && !report.started);
    assert_eq!(report.daemon_json.as_deref(), Some(r#"{"pid":900}"#));
    assert!(access.calls().is_empty());
    assert_eq!(env.versions(), ["1.4.6-b6"]);

    let other_build = Access::new(Some(core("1.4.6", "other", DiscoveryPhase::Serving)));
    let report = env.run(&args("1.4.6", "b6"), &other_build).unwrap();
    assert!(report.healthy && !report.core_current);
}

#[test]
fn a_newer_desktop_holds_retires_the_idle_core_and_starts_the_new_one() {
    let env = env();
    let access = Access::new(Some(core("1.4.5", "b5", DiscoveryPhase::Serving)));
    let report = env.run(&args("1.4.6", "b6"), &access).unwrap();
    assert!(report.started && report.installed && report.healthy && report.core_current);
    let replaced = report.replaced.unwrap();
    assert_eq!((replaced.pid, replaced.version.as_str(), replaced.graceful), (900, "1.4.5", true));
    assert_eq!(access.calls(), ["hold:true", "stop_when_idle:SshReplace", "wait_exit", "launch"]);
    assert_eq!(env.versions(), ["1.4.6-b6"]);
    let launch = access.launched.borrow().clone().unwrap();
    assert!(launch.env.contains(&("MIXDOG_MODEL_PROXY".to_owned(), "client".to_owned())));
    assert!(launch.env.iter().any(|(k, v)| k == "MIXDOG_RUNTIME_ROOT" && Path::new(v).ends_with("runtime")));
}

#[test]
fn a_busy_core_is_reported_with_its_work_and_only_a_confirmed_run_aborts_it() {
    let env = env();
    let mut access = Access::new(Some(core("1.4.5", "b5", DiscoveryPhase::Serving)));
    access.running = running("busy");
    let error = env.run(&args("1.4.6", "b6"), &access).unwrap_err();
    assert_eq!(error.code(), "daemon-busy-other-version");
    let lines = result_line(&Err(error));
    let (drain, message) = lines.split_once('\n').unwrap();
    assert_eq!(
        drain,
        r#"MIXDOG_DRAIN {"drainId":"d","running":[{"kind":"turn","threadId":null,"turnId":null,"title":"busy"}],"confirmToken":"ct"}"#
    );
    assert!(message.starts_with("MIXDOG_ERROR daemon-busy-other-version "));
    assert_eq!(access.calls(), ["hold:true", "stop_when_idle:SshReplace"], "no abort, no launch");

    // "Stop them": the confirmed run aborts under the token, waits for the exit, starts.
    let mut again = args("1.4.6", "b6");
    again.confirm_token = Some("ct".into());
    let report = env.run(&again, &access).unwrap();
    assert!(report.started);
    assert_eq!(
        &access.calls()[2..],
        ["hold:true", "stop_when_idle:SshReplace", "stop_confirmed:ct", "wait_exit", "launch"]
    );
}

#[test]
fn a_core_already_leaving_is_waited_out_even_at_the_same_version() {
    let env = env();
    let access = Access::new(Some(core("1.4.6", "b6", DiscoveryPhase::Draining)));
    env.run(&args("1.4.6", "b6"), &access).unwrap();
    assert_eq!(access.calls(), ["stop_when_idle:SshReplace", "wait_exit", "launch"]);
}

#[test]
fn no_core_or_a_1_4_5_daemon_means_install_and_start() {
    let env = env();
    let access = Access::new(None);
    let report = env.run(&args("1.4.6", "b6"), &access).unwrap();
    assert!(report.started && report.replaced.is_none());
    assert_eq!(access.calls(), ["launch"]);
    let line = result_line(&Ok(report));
    assert!(line.starts_with("MIXDOG_RESULT {") && line.contains(r#""started":true"#) && line.contains(r#""versionDir":"#));
}

#[test]
fn the_server_model_login_launches_without_the_model_proxy() {
    let env = env();
    let access = Access::new(None);
    let mut server = args("1.4.6", "b6");
    server.model_login = Some(ModelLogin::Server);
    env.run(&server, &access).unwrap();
    let launch = access.launched.borrow().clone().unwrap();
    assert!(!launch.env.iter().any(|(k, _)| k == "MIXDOG_MODEL_PROXY"));
    assert!(launch.env_remove.contains(&"MIXDOG_MODEL_PROXY".to_owned()), "an inherited proxy setting is dropped too");
}

#[test]
fn the_launched_core_does_not_inherit_the_launchers_system_proxy_decision() {
    let env = env();
    let access = Access::new(None);
    env.run(&args("1.4.6", "b6"), &access).unwrap();
    let launch = access.launched.borrow().clone().unwrap();
    assert!(launch.env_remove.contains(&"MIXDOG_SYSTEM_PROXY_HANDOFF".to_owned()));
    assert!(!launch.env.iter().any(|(k, _)| k == "MIXDOG_SYSTEM_PROXY_HANDOFF"));
}

#[test]
fn a_core_of_the_other_model_login_mode_is_replaced_even_at_the_same_version() {
    let env = env();
    let mut proxied = core("1.4.6", "b6", DiscoveryPhase::Serving);
    proxied.model_proxy = false;
    let access = Access::new(Some(proxied));
    let report = env.run(&args("1.4.6", "b6"), &access).unwrap();
    assert!(report.started && report.core_current);
    assert_eq!(report.replaced.unwrap().version, "1.4.6");
    let mut server = args("1.4.6", "b6");
    server.model_login = Some(ModelLogin::Server);
    server.mode = Mode::Probe;
    server.upload = false;
    let probed = env.run(&server, &Access::new(Some(core("1.4.6", "b6", DiscoveryPhase::Serving)))).unwrap();
    assert!(!probed.core_current, "a proxied core is not current for a server-login desktop");
}

#[test]
fn a_core_that_exits_while_booting_is_an_error_with_the_log_tail() {
    let env = env();
    let access = Access::new(None);
    *access.boot.borrow_mut() = Some(CoreReport::Exited { status: Some(3) });
    let error = env.run(&args("1.4.6", "b6"), &access).unwrap_err();
    assert_eq!(error.code(), "core-exited");
    assert!(result_line(&Err(error)).starts_with("MIXDOG_ERROR core-exited "));
}

#[test]
fn a_missing_install_without_upload_and_a_bad_checksum_fail_cleanly() {
    let env = env();
    let access = Access::new(None);
    let mut no_upload = args("1.4.6", "b6");
    no_upload.upload = false;
    assert_eq!(env.run(&no_upload, &access).unwrap_err().code(), "install-missing");
    let mut bad = args("1.4.6", "b6");
    bad.sha256 = Some("00".into());
    assert_eq!(env.run(&bad, &access).unwrap_err().code(), "checksum-mismatch");
    assert!(access.calls().is_empty());
}

#[test]
fn a_held_install_lock_is_reported_not_stolen() {
    let env = env();
    let paths = env.paths();
    let token = "0123456789abcdef01234567";
    std::fs::create_dir_all(paths.lock.join(token)).unwrap();
    let now = env.host().now_ms();
    std::fs::write(
        paths.lock.join(token).join("owner.json"),
        format!(r#"{{"token":"{token}","pid":77,"host":"h","purpose":"install","startedAt":{now}}}"#),
    )
    .unwrap();
    let access = Access::new(None);
    assert_eq!(env.run(&args("1.4.6", "b6"), &access).unwrap_err().code(), "install-locked");
    assert!(paths.lock.exists());

    // The same lock from a dead owner is taken over, and released after the run.
    let dead = Host { alive: false, ..env.host() };
    run(&args("1.4.6", "b6"), &dead, &access, &env.exe).unwrap();
    assert!(!paths.lock.exists());
}

#[test]
fn after_a_start_unused_older_installs_are_collected_but_running_ones_stay() {
    let env = env();
    let paths = env.paths();
    for old in ["1.4.4-x", "1.4.5-b5"] {
        std::fs::create_dir_all(paths.versions.join(old)).unwrap();
    }
    let busy = Host {
        images: Some(vec![ProcessImage { pid: 5, image: paths.versions.join("1.4.5-b5").join("mixdogd") }]),
        ..env.host()
    };
    let report = run(&args("1.4.6", "b6"), &busy, &Access::new(None), &env.exe).unwrap();
    let mut left = env.versions();
    left.sort();
    assert_eq!(left, ["1.4.5-b5", "1.4.6-b6"]);
    assert_eq!(report.gc_removed, ["versions/1.4.4-x"]);
}

#[test]
fn the_pre_versioned_layout_is_collected_unless_it_runs() {
    let env = env();
    let paths = env.paths();
    for old in ["1.2.3", "1.2.3-rc1", "1.0.0", "user-data", "12.x"] {
        std::fs::create_dir_all(paths.root.join(old)).unwrap();
    }
    let busy = Host {
        images: Some(vec![ProcessImage { pid: 5, image: paths.root.join("1.0.0").join("node") }]),
        ..env.host()
    };
    run(&args("1.4.6", "b6"), &busy, &Access::new(None), &env.exe).unwrap();
    let left: Vec<String> =
        std::fs::read_dir(&paths.root).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    for kept in ["1.0.0", "user-data", "12.x"] {
        assert!(left.contains(&kept.to_owned()), "{kept}");
    }
    for removed in ["1.2.3", "1.2.3-rc1"] {
        assert!(!left.contains(&removed.to_owned()), "{removed}");
    }
}

#[test]
fn probe_reports_the_install_and_the_core_without_writing() {
    let env = env();
    env.run(&args("1.4.6", "b6"), &Access::new(None)).unwrap();
    let mut probe = args("1.4.6", "b6");
    probe.mode = Mode::Probe;
    probe.upload = false;
    probe.sha256 = None;
    let report = env.run(&probe, &Access::new(Some(core("1.4.6", "b6", DiscoveryPhase::Serving)))).unwrap();
    assert!(report.installed && report.healthy && report.core_current && !report.started);
    let draining = env.run(&probe, &Access::new(Some(core("1.4.6", "b6", DiscoveryPhase::Draining)))).unwrap();
    assert!(!draining.healthy, "a core without an RPC listener is not serving");
    let missing = ProgramArgs { install_id: "1.4.7-x".into(), version: "1.4.7".into(), ..probe };
    let report = env.run(&missing, &Access::new(None)).unwrap();
    assert!(!report.installed && report.daemon_json.is_none());
}

fn cleanup_args(phase: CleanupPhase) -> ProgramArgs {
    ProgramArgs { mode: Mode::Cleanup, upload: false, sha256: None, phase: Some(phase), ..args("1.4.6", "b6") }
}

#[test]
fn cleanup_retires_the_core_removes_the_install_and_keeps_user_data() {
    let env = env();
    env.run(&args("1.4.6", "b6"), &Access::new(None)).unwrap();
    let paths = env.paths();
    std::fs::create_dir_all(&paths.user_data).unwrap();
    let access = Access::new(Some(core("1.4.6", "b6", DiscoveryPhase::Serving)));
    let report = env.run(&cleanup_args(CleanupPhase::Remove), &access).unwrap();
    let cleanup = report.cleanup.unwrap();
    assert_eq!(cleanup.stopped, Some(Stopped { pid: 900, stopped: true }));
    assert_eq!(cleanup.kept, ["user-data"]);
    assert!(cleanup.removed.contains(&"versions".to_owned()));
    assert_eq!(access.calls(), ["stop_when_idle:UserStop", "wait_exit"]);
    assert!(paths.user_data.exists() && !paths.versions.exists() && !paths.lock.exists());

    let mut all = cleanup_args(CleanupPhase::Remove);
    all.remove_user_data = true;
    env.run(&all, &Access::new(None)).unwrap();
    assert!(!paths.root.exists());
    // Nothing installed: nothing to do, and nothing created.
    let again = env.run(&cleanup_args(CleanupPhase::Stop), &Access::new(None)).unwrap();
    assert_eq!(again.cleanup, Some(CleanupResult::default()));
}

#[test]
fn the_stop_phase_retires_the_core_and_deletes_nothing() {
    let env = env();
    env.run(&args("1.4.6", "b6"), &Access::new(None)).unwrap();
    let access = Access::new(Some(core("1.4.6", "b6", DiscoveryPhase::Serving)));
    let report = env.run(&cleanup_args(CleanupPhase::Stop), &access).unwrap();
    assert!(report.cleanup.unwrap().removed.is_empty());
    assert!(env.paths().versions.exists());
}

#[test]
fn cleanup_of_a_busy_core_asks_and_a_process_it_cannot_prove_idle_blocks_removal() {
    let env = env();
    env.run(&args("1.4.6", "b6"), &Access::new(None)).unwrap();
    let mut access = Access::new(Some(core("1.4.6", "b6", DiscoveryPhase::Serving)));
    access.running = running("busy");
    let error = env.run(&cleanup_args(CleanupPhase::Remove), &access).unwrap_err();
    assert_eq!(error.code(), "daemon-busy-other-version");
    assert_eq!(access.calls(), ["stop_when_idle:UserStop"]);

    let paths = env.paths();
    let inside = Host {
        images: Some(vec![ProcessImage { pid: 5, image: paths.versions.join("1.4.6-b6").join(BINARY_NAME) }]),
        ..env.host()
    };
    let error = run(&cleanup_args(CleanupPhase::Remove), &inside, &Access::new(None), &env.exe).unwrap_err();
    assert_eq!(error.code(), "daemon-unproven");
    let blind = Host { images: None, ..env.host() };
    let error = run(&cleanup_args(CleanupPhase::Remove), &blind, &Access::new(None), &env.exe).unwrap_err();
    assert_eq!(error.code(), "daemon-unproven");
    assert!(paths.versions.exists(), "nothing was removed");
}
