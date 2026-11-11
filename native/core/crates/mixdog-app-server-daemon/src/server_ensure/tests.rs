//! `server-ensure` against a recorded host and core (LR §11.11).

use std::cell::RefCell;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use sha2::Digest;

use super::*;
use crate::control::api::ReplacementBuild;
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
    found: RefCell<Option<ServerCore>>,
    running: Vec<RunningWork>,
    boot: RefCell<Option<CoreReport>>,
    calls: RefCell<Vec<String>>,
    launched: RefCell<Option<Launch>>,
}

impl Access {
    fn new(found: Option<ServerCore>) -> Self {
        Self {
            found: RefCell::new(found),
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
        Ok(self.found.borrow().clone())
    }
    fn answers(&self, _: &ServerCore) -> bool {
        true
    }
    fn hold(&self, _: &ServerCore, on: bool) -> Result<(), EnsureError> {
        self.calls.borrow_mut().push(format!("hold:{on}"));
        Ok(())
    }
    fn stop_when_idle(&self, _: &ServerCore, reason: StopReason, _: Option<&ReplacementBuild>) -> Result<Option<DrainReport>, EnsureError> {
        self.calls.borrow_mut().push(format!("stop_when_idle:{reason:?}"));
        Ok(Some(DrainReport { drain_id: "d".into(), running: self.running.clone(), confirm_token: "ct".into() }))
    }
    fn stop_confirmed(&self, _: &ServerCore, _: StopReason, token: &str, _: Option<&ReplacementBuild>) -> Result<bool, EnsureError> {
        self.calls.borrow_mut().push(format!("stop_confirmed:{token}"));
        Ok(true)
    }
    fn wait_exit(&self, _: &ServerCore) -> Result<(), EnsureError> {
        self.calls.borrow_mut().push("wait_exit".into());
        Ok(())
    }
    fn terminate(&self, _: &ServerCore) -> Result<(), EnsureError> {
        self.calls.borrow_mut().push("terminate".into());
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

/// A host on which the run holding the install lock finishes while this run waits for it: its first pause is that other
/// run publishing the core it started and releasing the lock (`other_run_ends`).
struct LockWaiter<'a> {
    host: Host,
    other_run_ends: RefCell<Option<Box<dyn FnOnce() + 'a>>>,
}

impl EnsureHost for LockWaiter<'_> {
    fn home(&self) -> PathBuf {
        self.host.home()
    }
    fn uid(&self) -> u32 {
        self.host.uid()
    }
    fn hostname(&self) -> String {
        self.host.hostname()
    }
    fn process_alive(&self, pid: u32) -> bool {
        self.host.process_alive(pid)
    }
    fn process_images(&self) -> Option<Vec<ProcessImage>> {
        self.host.process_images()
    }
    fn now_ms(&self) -> u64 {
        self.host.now_ms()
    }
    fn pause(&self, _: Duration) {
        if let Some(other_run_ends) = self.other_run_ends.borrow_mut().take() {
            other_run_ends();
        }
    }
}

/// The discovery file a serving core of 1.4.6/b6 publishes, naming this test process (alive, its real start time) and a
/// control listener on `control_port`.
fn publish_core(paths: &RemotePaths, control_port: u16, instance_id: &str) -> String {
    publish(paths, std::process::id(), ("1.4.6", "b6", "serving"), control_port, instance_id)
}

/// The discovery file a core (`version`, `build`, `state`) publishes, naming the process `pid` (alive, its real start
/// time) and a control listener on `control_port`.
fn publish(paths: &RemotePaths, pid: u32, (version, build, state): (&str, &str, &str), control_port: u16, instance_id: &str) -> String {
    use crate::verdict::ProcessTable;
    let start_ms = crate::verdict::OsProcessTable.query(u64::from(pid)).unwrap().unwrap().identity.start_ms;
    let raw = serde_json::json!({
        "pid": pid,
        "endpoints": { "session": { "port": 1, "token": "bootstrap-test-token" }, "modelProxy": { "port": 2 } },
        "core": {
            "control": { "port": control_port },
            "state": state,
            "version": version,
            "build": build,
            "instanceId": instance_id,
            "processStartTime": start_ms.to_string(),
        },
    })
    .to_string();
    std::fs::create_dir_all(&paths.runtime_root).unwrap();
    std::fs::write(crate::discovery::path(&paths.runtime_root), &raw).unwrap();
    raw
}

/// The install lock of another run (a live pid, fresh) that has not published its core yet.
fn hold_install_lock(env: &Env) {
    let lock = env.paths().lock;
    let token = "0123456789abcdef01234567";
    std::fs::create_dir_all(lock.join(token)).unwrap();
    std::fs::write(
        lock.join(token).join("owner.json"),
        format!(r#"{{"token":"{token}","pid":77,"host":"h","purpose":"install","startedAt":{}}}"#, env.host().now_ms()),
    )
    .unwrap();
}

/// Node's daemon-bootstrap test (`scripts/daemon-bootstrap-test.mjs`): a client that meets a live owner before that owner
/// has published discovery waits for the publication and is served by it. Here the owner is the run holding the install
/// lock (a live pid, a fresh lock) whose core is not in discovery yet: this run waits on the lock with the shipped wait.
/// When the other run ends, a real core control listener is serving, its discovery file is published and the lock is
/// released; this run reads that file through the real `OsAccess`, gets the core's `GET /mgmt/status` answer over the
/// socket and attaches. Nothing is launched, held or stopped (a fake access would have to be asked).
#[test]
fn a_run_that_meets_a_live_install_before_its_core_is_published_waits_and_is_served_by_it() {
    let env = env();
    let paths = env.paths();
    hold_install_lock(&env);
    let fx = crate::lifecycle::testing::fixture();
    fx.lifecycle.set_serving().unwrap();
    let instance_id = fx.lifecycle.status().instance_id.clone();
    let serving = RefCell::new(None);
    let published = RefCell::new(String::new());
    let host = LockWaiter {
        host: env.host(),
        other_run_ends: RefCell::new(Some(Box::new(|| {
            let token = "bootstrap-test-token".to_owned();
            let legacy = crate::control::Legacy {
                pid: std::process::id(),
                version: "1.4.6".into(),
                instance_id: instance_id.clone(),
                build: "b6".into(),
                update_text: String::new(),
            };
            let server = crate::control::ControlServer::start(crate::control::ControlConfig { token, legacy }, std::sync::Arc::clone(&fx.lifecycle)).unwrap();
            *published.borrow_mut() = publish_core(&paths, server.port(), &instance_id);
            *serving.borrow_mut() = Some(server);
            std::fs::remove_dir_all(&paths.lock).unwrap();
        }))),
    };
    let access = super::os::OsAccess::new(&host);
    let mut waiting = args("1.4.6", "b6");
    waiting.lock_wait_ms = None;
    let report = run(&waiting, &host, &access, &env.exe).unwrap();
    assert!(host.other_run_ends.borrow().is_none(), "the run did not wait for the lock's holder");
    assert!(report.healthy && report.core_current && !report.started, "{report:?}");
    assert_eq!(report.daemon_json.as_deref(), Some(published.borrow().as_str()));
}

/// The same published record, but nothing answers on its control port (or another core does): the run reports the core
/// neither healthy nor current, as Node's `daemonSummary` without `/health`, and the desktop refuses it.
#[test]
fn a_published_core_that_does_not_answer_is_not_attached_as_healthy() {
    let env = env();
    let paths = env.paths();
    let closed = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
    publish_core(&paths, closed, "instance-1");
    let host = env.host();
    let access = super::os::OsAccess::new(&host);
    let report = run(&args("1.4.6", "b6"), &host, &access, &env.exe).unwrap();
    assert!(!report.healthy && !report.core_current && !report.started, "{report:?}");

    let fx = crate::lifecycle::testing::fixture();
    fx.lifecycle.set_serving().unwrap();
    let legacy = crate::control::Legacy { pid: 1, version: "1.4.6".into(), instance_id: "other".into(), build: "b6".into(), update_text: String::new() };
    let other = crate::control::ControlServer::start(
        crate::control::ControlConfig { token: "bootstrap-test-token".into(), legacy },
        std::sync::Arc::clone(&fx.lifecycle),
    )
    .unwrap();
    publish_core(&paths, other.port(), "not-the-answering-instance");
    let report = run(&args("1.4.6", "b6"), &host, &access, &env.exe).unwrap();
    assert!(!report.healthy && !report.core_current, "another core's answer proves nothing: {report:?}");
}

/// What a run met on the core's side: its result, the core's end of the connection and the run's clock, as they are
/// when the run has returned.
struct Served {
    result: Result<Report, EnsureError>,
    conn: std::net::TcpStream,
    watch: std::sync::Arc<super::idle::IdleWatch>,
}

/// A run of `args` through the real `OsAccess` against a published core (`published`: version, build, state) whose
/// process is `pid` and whose control listener is a real one. `answer` plays the core's side of the run's first
/// connection, whose request head (already read) starts with `request`, on the run's clock, which moves only when it
/// advances it; the core's state is a real lifecycle.
fn served_through(
    args: ProgramArgs,
    pid: u32,
    published: (&str, &str, &str),
    request: &str,
    answer: impl FnOnce(&mut std::net::TcpStream, &super::idle::IdleWatch, &std::sync::Arc<crate::lifecycle::Lifecycle>),
) -> Served {
    use std::io::Read;
    let env = env();
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let fx = crate::lifecycle::testing::fixture();
    fx.lifecycle.set_serving().unwrap();
    publish(&env.paths(), pid, published, listener.local_addr().unwrap().port(), &fx.lifecycle.status().instance_id);
    let watch = super::idle::IdleWatch::manual();
    let (done, result) = std::sync::mpsc::channel();
    let running = std::sync::Arc::clone(&watch);
    std::thread::spawn(move || {
        let host = env.host();
        let access = super::os::OsAccess::with_idle(&host, running);
        done.send(run(&args, &host, &access, &env.exe)).unwrap();
    });
    let (mut conn, _) = listener.accept().unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut byte = [0u8];
        conn.read_exact(&mut byte).unwrap();
        head.push(byte[0]);
    }
    assert!(head.starts_with(request.as_bytes()), "{}", String::from_utf8_lossy(&head));
    answer(&mut conn, &watch, &fx.lifecycle);
    // Bounds only a failing run (one that never gives up); a passing one has already answered. The connection stays
    // open until then, so the run cannot have seen its end instead of the limit.
    let result = result.recv_timeout(Duration::from_secs(60)).expect("the run is still waiting for the core");
    Served { result, conn, watch }
}

/// The core's whole answer to `GET /mgmt/status`, and to a command, which replies with the state after it.
fn status_answer(lifecycle: &crate::lifecycle::Lifecycle) -> String {
    let body = serde_json::to_string(&crate::control::api::StatusReply { status: (*lifecycle.status()).clone(), stalled_ms: 0 }).unwrap();
    format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
}

/// `answer` in two parts, each written just inside `limit` of inactivity, so the whole takes twice the limit. Before
/// each part the reader's read has timed out on the real clock: only the watch's clock may decide, so a machine that
/// stalls the core between the accept and a write changes nothing.
fn answer_in_two_parts(conn: &mut std::net::TcpStream, watch: &super::idle::IdleWatch, answer: &str, limit: Duration) {
    use std::io::Write;
    let (first, rest) = answer.split_at(answer.len() / 2);
    let just_inside = limit - Duration::from_millis(1);
    watch.wait_a_read_timeout();
    watch.advance(just_inside);
    conn.write_all(first.as_bytes()).unwrap();
    watch.wait_chunks(1);
    watch.wait_a_read_timeout();
    watch.advance(just_inside);
    conn.write_all(rest.as_bytes()).unwrap();
    conn.shutdown(std::net::Shutdown::Write).unwrap();
}

/// Giving up ends the read: by the time the run returns its reader has finished and the core sees its connection closed.
fn assert_given_up(served: &mut Served) {
    use std::io::Read;
    assert_eq!(served.watch.readers(), 0, "the request's reader outlived the run");
    // Bounds only a failing run, whose connection stays open. The rest of a request (its body) is read first.
    served.conn.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    match served.conn.read_to_end(&mut Vec::new()) {
        Ok(_) => {}
        Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted) => {}
        Err(e) => panic!("the request's connection is still open after the run: {e:?}"),
    }
}

/// A process standing in for a published core's, so that ending it ends nothing else: `sort`, hidden, reading its
/// stdin until that closes and then exiting 0 (a signalled one does not).
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the stand-in core is a real process")]
fn core_process() -> std::process::Child {
    #[cfg(windows)]
    let mut command = {
        let system = std::path::Path::new(&std::env::var_os("SystemRoot").unwrap()).join("System32");
        let mut command = std::process::Command::new(system.join("sort.exe"));
        // CREATE_NO_WINDOW
        std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
        command
    };
    #[cfg(unix)]
    let mut command = std::process::Command::new("sort");
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap()
}

/// Node's `daemonRequest` gives up after 1,500 ms without a byte: a core that accepts the probe and stays silent is not
/// attached as healthy, and no second core is started beside it.
#[test]
fn a_core_that_accepts_the_probe_and_stays_silent_is_not_healthy_after_the_idle_limit() {
    let mut served = served_through(args("1.4.6", "b6"), std::process::id(), ("1.4.6", "b6", "serving"), "GET /mgmt/status ", |_, watch, _| {
        watch.advance(super::idle::ANSWER_IDLE);
    });
    let report = served.result.as_ref().unwrap();
    assert!(!report.healthy && !report.core_current && !report.started, "{report:?}");
    assert_given_up(&mut served);
}

/// The limit is on inactivity, not on the whole answer: a core that answers in two parts, each just inside the limit,
/// is attached as healthy although the answer takes twice the limit.
#[test]
fn a_core_that_answers_slowly_within_the_idle_limit_is_attached() {
    let served = served_through(args("1.4.6", "b6"), std::process::id(), ("1.4.6", "b6", "serving"), "GET /mgmt/status ", |conn, watch, core| {
        answer_in_two_parts(conn, watch, &status_answer(core), super::idle::ANSWER_IDLE);
    });
    let report = served.result.unwrap();
    assert!(report.healthy && report.core_current && !report.started, "{report:?}");
}

/// Node's `stopDaemon` gives `/stop` 3,000 ms without a byte; a core silent that long is ended as one that did not
/// answer: SIGTERM, the grace, SIGKILL (`terminateProcess`). The run gives the request up, ends the core's process and
/// reports it stopped.
#[test]
fn a_core_that_accepts_the_stop_and_stays_silent_is_ended_by_signal_after_the_stop_limit() {
    let mut process = core_process();
    let pid = process.id();
    let mut served = served_through(cleanup_args(CleanupPhase::Stop), pid, ("1.4.6", "b6", "serving"), "POST /mgmt/stop ", |_, watch, _| {
        watch.advance(super::idle::STOP_IDLE);
    });
    let report = served.result.as_ref().unwrap();
    assert_eq!(report.cleanup.as_ref().unwrap().stopped, Some(Stopped { pid, stopped: true }));
    let status = process.try_wait().unwrap().expect("the silent core's process still runs after the run");
    assert!(!status.success(), "the silent core's process ended by itself, not by a signal: {status:?}");
    assert_given_up(&mut served);
}

/// The stop limit is on inactivity too, and longer than the probe's: a core that answers its stop in two parts, each
/// just inside 3,000 ms, is waited out and never signalled.
#[test]
fn a_core_that_answers_the_stop_slowly_within_the_stop_limit_is_waited_out_and_not_signalled() {
    let mut process = core_process();
    let pid = process.id();
    let mut stdin = process.stdin.take();
    let served = served_through(cleanup_args(CleanupPhase::Stop), pid, ("1.4.6", "b6", "serving"), "POST /mgmt/stop ", |conn, watch, core| {
        core.request_stop(crate::lifecycle::StopMode::WhenIdle, StopReason::UserStop, None).unwrap();
        answer_in_two_parts(conn, watch, &status_answer(core), super::idle::STOP_IDLE);
        // The core leaves once it has answered: its process ends by itself.
        drop(stdin.take());
    });
    let report = served.result.unwrap();
    assert_eq!(report.cleanup.unwrap().stopped, Some(Stopped { pid, stopped: true }));
    assert!(process.wait().unwrap().success(), "the core that answered its stop was signalled");
}

/// Hold is the first request of a replacement: a core silent on it has not shown that it answers, and Node never stops
/// a daemon that does not answer. The run fails; the core is neither stopped nor signalled, and nothing is launched.
#[test]
fn a_core_that_accepts_the_hold_and_stays_silent_fails_the_run_and_is_left_running() {
    let mut process = core_process();
    let mut served = served_through(args("1.4.6", "b6"), process.id(), ("1.4.5", "b5", "serving"), "POST /mgmt/hold ", |_, watch, _| {
        watch.advance(super::idle::ANSWER_IDLE);
    });
    let error = served.result.as_ref().unwrap_err();
    assert_eq!(error.code(), "core-control", "{error}");
    assert!(process.try_wait().unwrap().is_none(), "the core silent on hold was ended");
    assert_given_up(&mut served);
    drop(process.stdin.take());
    process.wait().unwrap();
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
