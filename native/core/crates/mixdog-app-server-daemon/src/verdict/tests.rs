#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test setup; the real holder process is the point"
)]

use std::collections::HashMap;
use std::collections::HashSet;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::io::Write;
use std::net::TcpListener;
use std::process::Child;
use std::process::ChildStdin;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use super::*;
use crate::barrier::BarrierRecord;
use crate::barrier::LockOwner;
use crate::ownership;

// ---------------------------------------------------------------------------
// Test support shared with the barrier and gate tests
// ---------------------------------------------------------------------------

/// Upper bound for one awaited child event, so a broken gate fails instead of hanging.
pub(crate) const EVENT_BOUND: Duration = Duration::from_secs(300);

#[derive(Default)]
pub(crate) struct FakeTable {
    running: HashMap<u64, ProcessInfo>,
    listening: HashSet<(u32, u16)>,
}

pub(crate) fn info(pid: u32, start_ms: u64) -> ProcessInfo {
    ProcessInfo {
        identity: ProcessIdentity { pid, start_ms },
        image: None,
        command_line: None,
    }
}

impl FakeTable {
    pub(crate) fn run(mut self, pid: u32, start_ms: u64) -> Self {
        self.running.insert(u64::from(pid), info(pid, start_ms));
        self
    }

    pub(crate) fn listen(mut self, pid: u32, port: u16) -> Self {
        self.listening.insert((pid, port));
        self
    }
}

impl ProcessTable for FakeTable {
    fn query(&self, pid: u64) -> io::Result<Option<ProcessInfo>> {
        Ok(self.running.get(&pid).cloned())
    }

    fn listens(&self, pid: u32, port: u16) -> io::Result<bool> {
        Ok(self.listening.contains(&(pid, port)))
    }
}

pub(crate) fn record() -> BarrierRecord {
    BarrierRecord {
        version: "1.4.6".into(),
        update_text: "Update Mixdog to continue".into(),
    }
}

pub(crate) struct TempData {
    pub(crate) root: tempfile::TempDir,
}

impl TempData {
    pub(crate) fn new() -> Self {
        Self {
            root: tempfile::tempdir().expect("tempdir"),
        }
    }

    pub(crate) fn data(&self) -> std::path::PathBuf {
        self.root.path().join("data")
    }

    pub(crate) fn runtime(&self) -> std::path::PathBuf {
        self.root.path().join("runtime")
    }

    pub(crate) fn gate(&self, procs: Box<dyn ProcessTable>) -> (Arc<CoreOwnership>, Gate) {
        let own = Arc::new(ownership::acquire(&self.data()).expect("acquire"));
        let gate = Gate::with_table(
            own.clone(),
            crate::discovery::path(&self.runtime()),
            record(),
            procs,
        )
        .expect("gate");
        (own, gate)
    }

    pub(crate) fn file(&self, name: &str) -> Option<Vec<u8>> {
        std::fs::read(self.data().join(name)).ok()
    }

    pub(crate) fn write(&self, name: &str, bytes: &[u8]) {
        std::fs::create_dir_all(self.data()).expect("data dir");
        std::fs::write(self.data().join(name), bytes).expect("write");
    }
}

/// A line marker a child test process prints, found anywhere in its stdout.
pub(crate) fn marker(text: &str) {
    let mut out = io::stdout().lock();
    writeln!(out, "\n@@{text}@@").expect("stdout");
    out.flush().expect("stdout");
}

/// This test binary re-executed as a child running one ignored entry test.
pub(crate) struct SelfChild {
    child: Child,
    stdin: Option<ChildStdin>,
    markers: mpsc::Receiver<String>,
}

impl SelfChild {
    pub(crate) fn spawn(test: &str, env: &[(&str, String)]) -> Self {
        let mut command = Command::new(std::env::current_exe().expect("test exe"));
        command
            .args([
                "--exact",
                test,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (key, value) in env {
            command.env(key, value);
        }
        let mut child = command.spawn().expect("spawn self");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().expect("stdout");
        let (tx, markers) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                for (index, part) in line.split("@@").enumerate() {
                    if index % 2 == 1 && tx.send(part.to_string()).is_err() {
                        return;
                    }
                }
            }
        });
        Self {
            child,
            stdin,
            markers,
        }
    }

    pub(crate) fn pid(&self) -> u32 {
        self.child.id()
    }

    /// The next marker; `None` once the child's stdout closed.
    pub(crate) fn next(&self) -> Option<String> {
        match self.markers.recv_timeout(EVENT_BOUND) {
            Ok(marker) => Some(marker),
            Err(mpsc::RecvTimeoutError::Disconnected) => None,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                panic!("child {} sent nothing within the bound", self.pid())
            }
        }
    }

    pub(crate) fn expect(&self, prefix: &str) -> String {
        let marker = self
            .next()
            .unwrap_or_else(|| panic!("child exited before {prefix}"));
        marker
            .strip_prefix(prefix)
            .unwrap_or_else(|| panic!("expected {prefix}, got {marker}"))
            .trim()
            .to_string()
    }

    /// The next marker within `bound`; `None` on timeout or once stdout closed.
    pub(crate) fn next_within(&self, bound: Duration) -> Option<String> {
        self.markers.recv_timeout(bound).ok()
    }

    pub(crate) fn send(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{line}").expect("child stdin");
        stdin.flush().expect("child stdin");
    }

    pub(crate) fn close_stdin(&mut self) {
        self.stdin = None;
    }

    pub(crate) fn wait(&mut self) -> std::process::ExitStatus {
        self.close_stdin();
        self.child.wait().expect("wait child")
    }
}

impl Drop for SelfChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Child entry: optionally owns a loopback LISTEN socket, then idles until stdin closes.
#[test]
#[ignore = "child process entry for other tests"]
fn idle_child() {
    if std::env::var_os("MIXDOG_OWN_IDLE_CHILD").is_none() {
        return;
    }
    let listener = std::env::var_os("MIXDOG_OWN_IDLE_LISTEN")
        .map(|_| TcpListener::bind("127.0.0.1:0").expect("bind"));
    if let Some(listener) = &listener {
        marker(&format!(
            "PORT {}",
            listener.local_addr().expect("addr").port()
        ));
    }
    marker("READY");
    let mut sink = Vec::new();
    let _ = io::stdin().read_to_end(&mut sink);
}

pub(crate) fn idle_child_process(listen: bool) -> (SelfChild, Option<u16>) {
    let mut env = vec![("MIXDOG_OWN_IDLE_CHILD", "1".to_string())];
    if listen {
        env.push(("MIXDOG_OWN_IDLE_LISTEN", "1".to_string()));
    }
    let child = SelfChild::spawn("verdict::tests::idle_child", &env);
    let port = listen.then(|| child.expect("PORT ").parse().expect("port"));
    child.expect("READY");
    (child, port)
}

// ---------------------------------------------------------------------------
// LR §3.1 decision table
// ---------------------------------------------------------------------------

fn owner(record: Option<&str>, discovery: Option<&str>, table: &FakeTable) -> Option<Verdict> {
    judge_owner(
        record.map(str::as_bytes),
        discovery.map(str::as_bytes),
        table,
        &[],
    )
    .unwrap()
}

fn claim(lock: ClaimLock, table: &FakeTable) -> ClaimJudgement {
    judge_claim(&lock, table, &[]).unwrap()
}

const P: u32 = 4242;

fn held(text: &str) -> ClaimLock {
    ClaimLock::Held(LockOwner::parse(text.as_bytes().to_vec()))
}

#[test]
fn barrier_present_is_clear() {
    assert_eq!(
        claim(ClaimLock::Barrier, &FakeTable::default()),
        ClaimJudgement::Barrier
    );
}

#[test]
fn absent_claim_lock_is_taken_before_the_owner_is_judged() {
    assert_eq!(
        claim(ClaimLock::Absent, &FakeTable::default()),
        ClaimJudgement::Free(Take::Absent)
    );
}

#[test]
fn record_names_dead_pid_is_clear() {
    let record = format!(r#"{{"pid":{P},"livenessPort":9000}}"#);
    assert_eq!(owner(Some(&record), None, &FakeTable::default()), None);
}

#[test]
fn record_owner_listening_on_its_liveness_port_must_exit() {
    let table = FakeTable::default().run(P, 1).listen(P, 9000);
    let record = format!(r#"{{"pid":{P},"livenessPort":9000}}"#);
    assert_eq!(
        owner(Some(&record), None, &table),
        Some(Verdict::WaitExit {
            process: info(P, 1),
            proven: true
        })
    );
}

#[test]
fn reused_pid_without_the_liveness_socket_is_clear() {
    let table = FakeTable::default().run(P, 1).listen(P, 9001);
    let record = format!(r#"{{"pid":{P},"livenessPort":9000}}"#);
    assert_eq!(owner(Some(&record), None, &table), None);
}

#[test]
fn record_without_liveness_port_naming_a_live_pid_is_undecidable() {
    let table = FakeTable::default().run(P, 1);
    let record = format!(r#"{{"pid":{P},"heartbeatAt":"x"}}"#);
    assert_eq!(
        owner(Some(&record), None, &table),
        Some(Verdict::Undecidable(info(P, 1)))
    );
}

#[test]
fn released_identity_is_not_an_owner() {
    let table = FakeTable::default().run(P, 1);
    let record = format!(r#"{{"pid":{P}}}"#);
    let verdict = judge_owner(
        Some(record.as_bytes()),
        None,
        &table,
        &[ProcessIdentity {
            pid: P,
            start_ms: 1,
        }],
    )
    .unwrap();
    assert_eq!(verdict, None);
}

#[test]
fn own_pid_is_never_a_prior_owner() {
    let own = std::process::id();
    let table = FakeTable::default().run(own, 1).listen(own, 9000);
    let record = format!(r#"{{"pid":{own},"livenessPort":9000}}"#);
    assert_eq!(owner(Some(&record), None, &table), None);
    let lock = held(&format!("{own} 0 mixdog-core:x"));
    assert!(matches!(
        claim(lock, &table),
        ClaimJudgement::Free(Take::DeadHolder(_))
    ));
}

#[test]
fn barrier_record_text_pid_defers_to_discovery() {
    let barrier_record = r#"{"kind":"mixdog-daemon","pid":"Update Mixdog to continue","protocol":2,"version":"1.4.6"}"#;
    let discovery =
        format!(r#"{{"pid":{P},"endpoints":{{"session":{{"port":9100,"token":"t"}}}}}}"#);
    let table = FakeTable::default().run(P, 1).listen(P, 9100);
    assert_eq!(
        owner(Some(barrier_record), Some(&discovery), &table),
        Some(Verdict::WaitExit {
            process: info(P, 1),
            proven: true
        })
    );

    let not_listening = FakeTable::default().run(P, 1);
    assert_eq!(
        owner(None, Some(&discovery), &not_listening),
        Some(Verdict::WaitExit {
            process: info(P, 1),
            proven: false
        })
    );

    assert_eq!(owner(None, Some(&discovery), &FakeTable::default()), None);
}

#[test]
fn a_core_discovery_is_never_a_prior_owner() {
    let discovery = format!(
        r#"{{"pid":{P},"endpoints":{{"session":{{"port":9100,"token":"t"}}}},"core":{{}}}}"#
    );
    let table = FakeTable::default().run(P, 1).listen(P, 9100);
    assert_eq!(owner(None, Some(&discovery), &table), None);
}

#[test]
fn claim_lock_held_by_its_live_writer_waits_for_a_change() {
    let table = FakeTable::default().run(P, 1_000);
    assert_eq!(
        claim(held(&format!("{P} 2000 abcdef")), &table),
        ClaimJudgement::Blocked(Verdict::WaitClaim(info(P, 1_000)))
    );
}

#[test]
fn claim_lock_naming_a_process_started_after_it_is_undecidable() {
    let table = FakeTable::default().run(P, 3_000);
    assert_eq!(
        claim(held(&format!("{P} 2000 abcdef")), &table),
        ClaimJudgement::Blocked(Verdict::Undecidable(info(P, 3_000)))
    );
}

#[test]
fn claim_lock_of_a_dead_holder_is_taken_by_reclaim() {
    let text = format!("{P} 2000 abcdef\n");
    assert_eq!(
        claim(held(&text), &FakeTable::default()),
        ClaimJudgement::Free(Take::DeadHolder(text.into_bytes()))
    );
}

#[test]
fn legacy_lock_directories() {
    let table = FakeTable::default();
    assert_eq!(
        claim(ClaimLock::Dir { empty: true }, &table),
        ClaimJudgement::Free(Take::EmptyDir)
    );
    assert_eq!(
        claim(ClaimLock::Dir { empty: false }, &table),
        ClaimJudgement::Blocked(Verdict::Unusable)
    );
}

// ---------------------------------------------------------------------------
// The OS tables and waits
// ---------------------------------------------------------------------------

#[test]
fn os_table_reports_this_process_and_its_listen_socket() {
    let me = OsProcessTable
        .query(u64::from(std::process::id()))
        .unwrap()
        .expect("own process");
    assert!(me.identity.start_ms > 0);
    assert!(me.image.is_some());
    assert_eq!(current_identity().unwrap(), me.identity);

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    assert!(OsProcessTable.listens(std::process::id(), port).unwrap());
    drop(listener);
    assert!(!OsProcessTable.listens(std::process::id(), port).unwrap());
    assert_eq!(
        OsProcessTable.query(4_294_967_296).unwrap(),
        None,
        "the barrier pid names no process"
    );
}

#[test]
fn exit_watch_confirms_exit_and_interrupt_wakes() {
    let (mut child, _) = idle_child_process(false);
    let process = OsProcessTable
        .query(u64::from(child.pid()))
        .unwrap()
        .expect("child runs");
    let exit = ExitWatch::open(process.identity)
        .unwrap()
        .expect("watchable");
    let interrupt = Interrupt::new().unwrap();
    interrupt.signal().unwrap();
    assert_eq!(
        wait::wait(&interrupt, None, Some(&exit)).unwrap(),
        Wake::Interrupted
    );
    child.close_stdin();
    assert_eq!(
        wait::wait(&interrupt, None, Some(&exit)).unwrap(),
        Wake::Exited
    );
    child.wait();
    assert_eq!(
        OsProcessTable
            .query(u64::from(process.identity.pid))
            .unwrap(),
        None
    );
    let stale = ProcessIdentity {
        pid: process.identity.pid,
        start_ms: process.identity.start_ms,
    };
    assert!(
        ExitWatch::open(stale).unwrap().is_none(),
        "an exited identity is never watched"
    );
}

#[test]
fn dir_watch_wakes_on_an_entry_change() {
    let temp = TempData::new();
    let own = ownership::acquire(&temp.data()).unwrap();
    let watch = DirWatch::arm(own.data_dir()).unwrap();
    temp.write("daemon-owner.json.claim.lock", b"1 2 3\n");
    assert_eq!(
        wait::wait(&Interrupt::new().unwrap(), Some(&watch), None).unwrap(),
        Wake::Changed
    );
}

// ---------------------------------------------------------------------------
// LR §11.6 pid reuse, on real processes
// ---------------------------------------------------------------------------

#[test]
fn gate_6_record_naming_a_live_unrelated_process_and_a_port_it_does_not_own_is_clear() {
    let (child, _) = idle_child_process(false);
    let foreign = TcpListener::bind("127.0.0.1:0").unwrap();
    let temp = TempData::new();
    let port = foreign.local_addr().unwrap().port();
    let record = format!(
        r#"{{"kind":"mixdog-daemon","pid":{},"livenessPort":{port}}}"#,
        child.pid()
    );
    temp.write("daemon-owner.json", record.as_bytes());
    let (own, mut gate) = temp.gate(Box::new(OsProcessTable));
    assert!(matches!(gate.step().unwrap(), GateStep::Clear));
    assert_eq!(
        temp.file("daemon-owner.json.claim.lock").unwrap(),
        crate::barrier::barrier_bytes(own.instance_id())
    );
}

#[test]
fn gate_6_record_without_liveness_port_is_undecidable_and_release_is_journaled() {
    let (child, _) = idle_child_process(false);
    let temp = TempData::new();
    temp.write(
        "daemon-owner.json",
        format!(r#"{{"kind":"mixdog-daemon","pid":{}}}"#, child.pid()).as_bytes(),
    );
    let (own, mut gate) = temp.gate(Box::new(OsProcessTable));
    let GateStep::Blocked(blocked) = gate.step().unwrap() else {
        panic!("expected blocked")
    };
    assert_eq!(
        (
            blocked.kind,
            blocked.process.identity.pid,
            blocked.releasable
        ),
        (BlockedKind::Undecidable, child.pid(), true)
    );
    assert!(
        blocked
            .process
            .command_line
            .as_deref()
            .is_some_and(|line| line.contains("idle_child"))
    );
    assert_eq!(blocked.describe()["kind"], "undecidable");
    assert!(matches!(
        gate.release(child.pid() + 1),
        Err(ReleaseError::NotBlockedOn(_))
    ));

    gate.release(child.pid()).unwrap();
    let journal =
        std::fs::read_to_string(temp.data().join(JOURNAL_DIR).join(JOURNAL_FILE)).unwrap();
    let entry: serde_json::Value = serde_json::from_str(journal.trim()).unwrap();
    assert_eq!(entry["decision"], "release");
    assert_eq!(entry["pid"], child.pid());
    assert_eq!(entry["instanceId"], own.instance_id());
    assert_eq!(entry["processStartMs"], blocked.process.identity.start_ms);

    assert!(matches!(gate.step().unwrap(), GateStep::Clear));
    assert_eq!(temp.file("daemon-owner.json").unwrap(), record().to_bytes());
}

#[test]
fn proven_owner_waits_for_its_os_exit_and_cannot_be_released() {
    let (mut child, port) = idle_child_process(true);
    let temp = TempData::new();
    let record = format!(
        r#"{{"kind":"mixdog-daemon","pid":{},"livenessPort":{}}}"#,
        child.pid(),
        port.unwrap()
    );
    temp.write("daemon-owner.json", record.as_bytes());
    let (_own, mut gate) = temp.gate(Box::new(OsProcessTable));
    let GateStep::Blocked(blocked) = gate.step().unwrap() else {
        panic!("expected blocked")
    };
    assert_eq!(
        (blocked.kind, blocked.releasable),
        (BlockedKind::WaitExit, false)
    );
    assert!(matches!(
        gate.release(child.pid()),
        Err(ReleaseError::NotReleasable(_))
    ));

    child.close_stdin();
    assert_eq!(
        blocked.wait(&Interrupt::new().unwrap()).unwrap(),
        Wake::Exited
    );
    child.wait();
    assert!(matches!(gate.step().unwrap(), GateStep::Clear));
}
