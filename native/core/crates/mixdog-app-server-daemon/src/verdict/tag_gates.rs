//! LR §11 gates 1–5 and 7 against the real 1.4.5 tag (69fe41b05), on temp
//! data dirs only. The core child pauses at the `barrier::Step`s named in
//! `MIXDOG_OWN_CORE_PAUSE` (a test-only hook), so a test can suspend or kill
//! it, or start 1.4.5 contenders, at an exact step.
//!
//! Ignored by default: run with `--ignored` and `MIXDOG_TAG_TREE` naming a
//! `git archive 69fe41b05` extraction with its `node_modules`
//! (`fixtures/lifecycle/tag.json` `extract`). `MIXDOG_TAG_GATE_REPS` sets the
//! gate 3 repetitions (LR: 200). Every 1.4.5 process gets the temp data dir,
//! home and runtime root, so the live daemon and data dir are never touched.
//! Waits here only bound a failing test or let 1.4.5 processes settle; no
//! verdict depends on them.

#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "test setup; the real 1.4.5 processes are the point"
)]

use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Output;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use mixdog_core_api::domain::ownership::Ownership;

use super::tests::LaneGate;
use super::tests::SelfChild;
use super::tests::TempData;
use super::tests::marker;
use super::tests::record;
use super::*;
use crate::barrier::CLAIM_LOCK_FILE;
use crate::barrier::barrier_bytes;
use crate::ownership;
use crate::ownership::AcquireError;

const SETTLE: Duration = Duration::from_secs(120);

fn tag_tree() -> PathBuf {
    let tree = PathBuf::from(
        std::env::var_os("MIXDOG_TAG_TREE").expect("MIXDOG_TAG_TREE names the 1.4.5 tag tree"),
    );
    assert!(tree.join("src/standalone/daemon.mjs").is_file() && tree.join("node_modules").is_dir());
    tree
}

/// `node` with the 1.4.5 environment confined to `temp`.
fn node(temp: &TempData) -> Command {
    let tree = tag_tree();
    let home = temp.root.path().join("home");
    std::fs::create_dir_all(&home).expect("home");
    let mut command = Command::new("node");
    command
        .current_dir(&tree)
        .env("TAG_TREE", &tree)
        .env("MIXDOG_DATA_DIR", temp.data())
        .env("MIXDOG_HOME", &home)
        .env("MIXDOG_RUNTIME_ROOT", temp.runtime())
        .env("MIXDOG_DAEMON_SKIP_MEMORY", "1")
        .env("MIXDOG_DISABLE_MCP", "1")
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .stdin(Stdio::null());
    command
}

fn daemon(temp: &TempData) -> Command {
    let mut command = node(temp);
    command.arg(tag_tree().join("src/standalone/daemon.mjs"));
    command
}

/// Runs `js` from a file: with `-e`, the script would land in
/// `process.execArgv`, which `spawnDaemonCandidate` passes to every daemon it
/// forks, so each candidate re-ran the script instead of `daemon.mjs`.
fn script(temp: &TempData, js: &str) -> Output {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let file = temp.data().with_file_name(format!("script-{n}.mjs"));
    std::fs::write(&file, js).expect("script");
    node(temp).arg(&file).output().expect("node")
}

fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &child.id().to_string()])
        .output();
    let _ = child.kill();
    let _ = child.wait();
}

fn wait_bounded(child: &mut Child, bound: Duration) -> Option<std::process::ExitStatus> {
    let until = Instant::now() + bound;
    while Instant::now() < until {
        if let Some(status) = child.try_wait().expect("try_wait") {
            return Some(status);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

/// The core: OS lock, then the gate until clear (holding the data dir).
fn serving_core(temp: &TempData) -> (Arc<CoreOwnership>, LaneGate) {
    let own = Arc::new(ownership::acquire(&temp.data()).expect("acquire"));
    let mut gate = LaneGate::from(
        Gate::new(
            own.clone(),
            crate::discovery::path(&temp.runtime()),
            record(),
        )
        .expect("gate"),
    );
    assert!(matches!(gate.step().expect("step"), GateStep::Clear));
    (own, gate)
}

fn has_barrier(temp: &TempData) -> bool {
    temp.file(CLAIM_LOCK_FILE)
        .is_some_and(|b| ClaimLock::parse(b) == ClaimLock::Barrier)
}

fn bytes(temp: &TempData) -> (Vec<u8>, Vec<u8>) {
    (
        temp.file(CLAIM_LOCK_FILE).expect("B"),
        temp.file(barrier::RECORD_FILE).expect("record"),
    )
}

// ---------------------------------------------------------------------------
// §11.1 barrier unit
// ---------------------------------------------------------------------------

const UNIT_JS: &str = r#"
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync, rmSync, existsSync } from 'node:fs';
const m = await import(pathToFileURL(join(process.env.TAG_TREE, 'src/runtime/shared/singleton-owner.mjs')).href);
const rec = join(process.env.MIXDOG_DATA_DIR, 'daemon-owner.json');
const before = readFileSync(rec);
const o = {};
o.claim = m.claimSingletonOwner(rec, { kind: 'mixdog-daemon', isStale: () => true }).owned;
o.refresh = m.refreshSingletonOwner(rec, { pid: process.pid, kind: 'mixdog-daemon' }).status;
o.refreshAsync = (await m.refreshSingletonOwnerAsync(rec, { pid: process.pid, kind: 'mixdog-daemon' })).status;
o.handoff = m.handoffSingletonOwner(rec, process.pid, { kind: 'mixdog-daemon' }).owned;
o.release = m.releaseSingletonOwner(rec);
o.recordUnchanged = readFileSync(rec).equals(before);
rmSync(rec);
o.claimWithoutRecord = m.claimSingletonOwner(rec, { kind: 'mixdog-daemon', isStale: () => true }).owned;
o.recordWritten = existsSync(rec);
console.log(JSON.stringify(o));
"#;

#[test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag)"]
fn gate_1_tag_modules_honour_the_installed_barrier() {
    let temp = TempData::new();
    let (own, _gate) = serving_core(&temp);
    let (barrier, _) = bytes(&temp);
    let out = script(&temp, UNIT_JS);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let observed: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    assert_eq!(
        observed,
        serde_json::json!({
            "claim": false, "refresh": "busy", "refreshAsync": "busy", "handoff": false, "release": false,
            "recordUnchanged": true, "claimWithoutRecord": false, "recordWritten": false,
        })
    );
    assert_eq!(temp.file(CLAIM_LOCK_FILE).unwrap(), barrier);
    assert_eq!(own.revalidate(), Ok(()));
}

// ---------------------------------------------------------------------------
// §11.2 real daemon start against the barrier
// ---------------------------------------------------------------------------

fn daemon_start_exits_for_attach(temp: &TempData) {
    let before = bytes(temp);
    let mut child = daemon(temp)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("daemon");
    let status = wait_bounded(&mut child, SETTLE);
    let Some(status) = status else {
        kill_tree(&mut child);
        panic!("the 1.4.5 daemon kept running against the barrier");
    };
    let output = child.wait_with_output().expect("output");
    let log = std::fs::read_to_string(temp.data().join("daemon.log")).unwrap_or_default();
    let text = format!(
        "{log}{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(status.code(), Some(0), "{text}");
    assert!(
        text.contains(&record().update_text),
        "exit reason carries the barrier text:\n{text}"
    );
    assert_eq!(bytes(temp), before, "record and B unchanged");
}

#[test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag)"]
fn gate_2_real_daemon_start_exits_with_and_without_a_serving_core() {
    let temp = TempData::new();
    let (own, gate) = serving_core(&temp);
    daemon_start_exits_for_attach(&temp);
    assert_eq!(own.revalidate(), Ok(()));
    drop(gate);
    drop(own);
    daemon_start_exits_for_attach(&temp);
}

// ---------------------------------------------------------------------------
// Core child process (gates 3 and 4)
// ---------------------------------------------------------------------------

/// The pid `R` names, or `-`.
fn record_pid(data: &Path) -> String {
    std::fs::read(data.join(RECORD_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v.get("pid").and_then(serde_json::Value::as_u64))
        .map_or_else(|| "-".to_string(), |pid| pid.to_string())
}

/// Child entry: one core on `MIXDOG_OWN_CORE_DATA`. Reports `LOCKED_OUT`,
/// each `BLOCKED <kind> <pid> HELD <pid R named when this core first held B>`,
/// then `SERVING`; answers `REVALIDATE` lines. At each step named in
/// `MIXDOG_OWN_CORE_PAUSE` (comma-separated, first time only) it reports
/// `AT <step>` and waits for a `GO` line.
#[test]
#[ignore = "child process entry for the tag gates"]
fn core_child() {
    let Some(data) = std::env::var_os("MIXDOG_OWN_CORE_DATA") else {
        return;
    };
    let data_path = PathBuf::from(&data);
    let first_held = std::rc::Rc::new(std::cell::RefCell::new(None::<String>));
    let sink = first_held.clone();
    let steps = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
    let step_sink = steps.clone();
    let pauses: Vec<String> = std::env::var("MIXDOG_OWN_CORE_PAUSE")
        .map(|list| list.split(',').map(str::to_string).collect())
        .unwrap_or_default();
    let mut paused = std::collections::HashSet::new();
    let _hook = crate::barrier::tests::set_hook(move |step| {
        if step == Step::Held && sink.borrow().is_none() {
            *sink.borrow_mut() = Some(record_pid(&data_path));
        }
        let name = format!("{step:?}");
        step_sink.borrow_mut().push(name.clone());
        if pauses.contains(&name) && paused.insert(name.clone()) {
            marker(&format!("AT {name}"));
            let mut line = String::new();
            while std::io::stdin().read_line(&mut line).unwrap_or(0) > 0 && line.trim() != "GO" {
                line.clear();
            }
        }
    });
    let runtime = PathBuf::from(std::env::var_os("MIXDOG_OWN_CORE_RUNTIME").expect("runtime"));
    let own = match ownership::acquire(Path::new(&data)) {
        Ok(own) => Arc::new(own),
        Err(AcquireError::AlreadyOwned) => return marker("LOCKED_OUT"),
        Err(error) => panic!("{error:?}"),
    };
    let mut gate = LaneGate::from(
        Gate::new(own.clone(), crate::discovery::path(&runtime), record()).expect("gate"),
    );
    let interrupt = Interrupt::new().expect("interrupt");
    loop {
        let step = gate.step().unwrap_or_else(|error| {
            let entries: Vec<String> = std::fs::read_dir(&data)
                .map(|dir| {
                    dir.map_while(Result::ok)
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default();
            panic!(
                "step: {error:?} after steps {:?}; data dir {entries:?}",
                steps.borrow()
            )
        });
        match step {
            GateStep::Clear => break,
            GateStep::Blocked(blocked) => {
                marker(&format!(
                    "BLOCKED {:?} {} HELD {}",
                    blocked.kind,
                    blocked.process.identity.pid,
                    first_held.borrow().as_deref().unwrap_or("never")
                ));
                blocked.wait(&interrupt).expect("wait");
            }
        }
    }
    marker("SERVING");
    for line in std::io::BufRead::lines(std::io::stdin().lock()).map_while(Result::ok) {
        if line == "REVALIDATE" {
            marker(&format!("REVALIDATE {:?}", own.revalidate()));
        }
    }
}

fn core_process(temp: &TempData) -> SelfChild {
    core_process_paused(temp, "")
}

/// A core child that pauses at each step in `pauses` (`Step` names, comma-separated).
fn core_process_paused(temp: &TempData, pauses: &str) -> SelfChild {
    SelfChild::spawn(
        "verdict::tag_gates::core_child",
        &[
            ("MIXDOG_OWN_CORE_DATA", temp.data().display().to_string()),
            (
                "MIXDOG_OWN_CORE_RUNTIME",
                temp.runtime().display().to_string(),
            ),
            ("MIXDOG_OWN_CORE_PAUSE", pauses.to_string()),
        ],
    )
}

/// Reads `core`'s markers until `SERVING`, then checks the barrier. A
/// `BLOCKED` marker may only name `daemon`; with `kill`, a `WaitExit` on it
/// kills it (its OS exit unblocks the core), else it must exit by itself.
fn serves_after(core: &SelfChild, temp: &TempData, daemon: Option<&mut Child>, kill: bool) {
    let mut daemon = daemon;
    loop {
        let marker = core
            .next()
            .unwrap_or_else(|| panic!("the core exited before serving:\n{}", core.output()));
        if marker == "SERVING" {
            break;
        }
        let rest = marker
            .strip_prefix("BLOCKED ")
            .unwrap_or_else(|| panic!("unexpected core marker {marker}"));
        let mut parts = rest.split_whitespace();
        let kind = parts.next().expect("kind");
        let pid: u32 = parts.next().expect("pid").parse().expect("pid");
        let child = daemon
            .as_deref_mut()
            .unwrap_or_else(|| panic!("blocked with no live 1.4.5 daemon: {marker}"));
        assert_eq!(pid, child.id(), "blocked on another process: {marker}");
        if kill && kind == "WaitExit" {
            kill_tree(child);
        }
    }
    assert!(has_barrier(temp), "serving without the barrier");
    if let Some(child) = daemon {
        assert!(
            child.try_wait().expect("try_wait").is_some(),
            "a 1.4.5 daemon runs beside a serving core"
        );
    }
}

// ---------------------------------------------------------------------------
// §11.3 simultaneous starts
// ---------------------------------------------------------------------------

/// A data dir a dead 1.4.5 daemon left behind.
fn tag_dir(temp: &TempData) {
    let mut dead = Command::new("node").args(["-e", ""]).spawn().expect("node");
    let pid = dead.id();
    dead.wait().expect("wait");
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    temp.write(
        barrier::RECORD_FILE,
        format!(
            r#"{{"kind":"mixdog-daemon","pid":{pid},"claimedAt":"2026-01-01T00:00:00.000Z","protocol":1,"revision":3,"version":"1.4.5","heartbeatAt":"2026-01-01T00:00:00.000Z","livenessPort":{port}}}"#
        )
        .as_bytes(),
    );
}

/// The lock-holding core's last state once it stops changing for `quiet`.
fn settled_core(
    cores: &[SelfChild],
    states: &mut [Option<String>],
    quiet: Duration,
    until: Instant,
) {
    loop {
        let mut changed = false;
        for (core, state) in cores.iter().zip(states.iter_mut()) {
            while let Some(marker) = core.next_within(Duration::from_millis(1)) {
                *state = Some(marker);
                changed = true;
            }
        }
        if !changed && states.iter().all(Option::is_some) {
            std::thread::sleep(quiet);
            if cores
                .iter()
                .all(|core| core.next_within(Duration::from_millis(1)).is_none())
            {
                return;
            }
        }
        assert!(Instant::now() < until, "cores did not settle: {states:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn simultaneous(prepare: fn(&TempData)) {
    let reps: usize = std::env::var("MIXDOG_TAG_GATE_REPS")
        .ok()
        .map_or(200, |n| n.parse().expect("reps"));
    let mut daemon_won = 0;
    let mut late_claims = Vec::new();
    for rep in 0..reps {
        let temp = TempData::new();
        std::fs::create_dir_all(temp.data()).unwrap();
        prepare(&temp);
        let mut daemons = Vec::new();
        let mut cores = Vec::new();
        for _ in 0..10 {
            cores.push(core_process(&temp));
            daemons.push(
                daemon(&temp)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("daemon"),
            );
        }
        let until = Instant::now() + SETTLE;
        // Losing 1.4.5 daemons exit 0; at most one may keep serving.
        let mut live = Vec::new();
        loop {
            live.clear();
            for daemon in &mut daemons {
                match daemon.try_wait().expect("try_wait") {
                    Some(status) => {
                        assert_eq!(status.code(), Some(0), "rep {rep}: a 1.4.5 daemon failed")
                    }
                    None => live.push(daemon.id()),
                }
            }
            if live.len() <= 1 {
                break;
            }
            assert!(
                Instant::now() < until,
                "rep {rep}: {} 1.4.5 daemons still running",
                live.len()
            );
            std::thread::sleep(Duration::from_millis(100));
        }
        let mut states = vec![None; cores.len()];
        settled_core(&cores, &mut states, Duration::from_secs(2), until);
        let owners: Vec<&String> = states
            .iter()
            .flatten()
            .filter(|s| *s != "LOCKED_OUT")
            .collect();
        assert_eq!(
            owners.len(),
            1,
            "rep {rep}: exactly one core holds the OS lock: {states:?}"
        );
        // Who serves comes from the lock-holding core's verdict, not from which
        // daemons happen to be alive: a loser may still be on its way to exit 0.
        let diagnostics = |daemons: &mut Vec<Child>| {
            let live: Vec<u32> = daemons
                .iter_mut()
                .filter_map(|d| d.try_wait().unwrap().is_none().then(|| d.id()))
                .collect();
            let file = |name| {
                temp.file(name)
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
            };
            format!(
                "cores {states:?}; live daemons {live:?}; B {:?}; record {:?}",
                file(CLAIM_LOCK_FILE),
                file(barrier::RECORD_FILE)
            )
        };
        if owners[0] == "SERVING" {
            assert!(
                has_barrier(&temp),
                "rep {rep}: {}",
                diagnostics(&mut daemons)
            );
            // Every 1.4.5 daemon honours the barrier and exits 0.
            for daemon in &mut daemons {
                let pid = daemon.id();
                match wait_bounded(daemon, until.saturating_duration_since(Instant::now())) {
                    Some(status) => assert_eq!(status.code(), Some(0), "rep {rep}: daemon {pid}"),
                    None => {
                        let state = diagnostics(&mut daemons);
                        panic!("rep {rep}: 1.4.5 daemon {pid} runs beside a serving core: {state}")
                    }
                }
            }
        } else if let Some(rest) = owners[0].strip_prefix("BLOCKED WaitExit ") {
            let state = diagnostics(&mut daemons);
            let (pid, held) = rest.split_once(" HELD ").expect("HELD");
            // LR §11.3: no 1.4.5 claim lands after a core first held B, so the
            // daemon that serves is the one R named then (1.4.5 writes R only
            // under B). Recorded, not asserted here, so one run lists every such
            // rep; the rest of the rep is still checked.
            // "never": the core judged that daemon live without ever taking B.
            if held != pid && held != "never" {
                late_claims.push((rep, held.to_string()));
            }
            let pid: u32 = pid.parse().expect("pid");
            for daemon in &mut daemons {
                let live = daemon.try_wait().unwrap().is_none();
                if daemon.id() == pid {
                    assert!(
                        live,
                        "rep {rep}: the core waits on an exited daemon: {state}"
                    );
                } else {
                    assert!(
                        wait_bounded(daemon, until.saturating_duration_since(Instant::now()))
                            .is_some_and(|s| s.code() == Some(0)),
                        "rep {rep}: a second 1.4.5 daemon serves: {state}"
                    );
                }
            }
            assert!(
                !has_barrier(&temp),
                "rep {rep}: no barrier while a 1.4.5 daemon serves: {state}"
            );
            eprintln!("rep {rep}: 1.4.5 daemon {pid} served; {state}");
            daemon_won += 1;
        } else {
            panic!(
                "rep {rep}: unexpected core state: {}",
                diagnostics(&mut daemons)
            );
        }
        for daemon in &mut daemons {
            kill_tree(daemon);
        }
        drop(cores);
    }
    eprintln!("simultaneous starts: {reps} reps, a 1.4.5 daemon served in {daemon_won}");
    assert!(
        late_claims.is_empty(),
        "a 1.4.5 claim landed after the core first held B (rep, pid R named then): {late_claims:?}"
    );
}

#[test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag)"]
fn gate_3a_simultaneous_starts_on_a_fresh_dir() {
    simultaneous(|_| {});
}

#[test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag)"]
fn gate_3b_simultaneous_starts_on_a_1_4_5_dir() {
    simultaneous(tag_dir);
}

// ---------------------------------------------------------------------------
// §11.4 stale-heartbeat reclaim while the core is suspended
// ---------------------------------------------------------------------------

#[cfg(windows)]
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtSuspendProcess(process: windows_sys::Win32::Foundation::HANDLE) -> i32;
    fn NtResumeProcess(process: windows_sys::Win32::Foundation::HANDLE) -> i32;
}

fn suspend(pid: u32, on: bool) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::OpenProcess;
        use windows_sys::Win32::System::Threading::PROCESS_SUSPEND_RESUME;
        let handle = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
        assert!(!handle.is_null(), "OpenProcess");
        let status = if on {
            NtSuspendProcess(handle)
        } else {
            NtResumeProcess(handle)
        };
        CloseHandle(handle);
        assert!(status >= 0, "NtSuspend/ResumeProcess: NTSTATUS {status:#x}");
    }
    #[cfg(unix)]
    unsafe {
        assert_eq!(
            libc::kill(pid as i32, if on { libc::SIGSTOP } else { libc::SIGCONT }),
            0
        );
    }
}

const ENSURE_JS: &str = r#"
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const m = await import(pathToFileURL(join(process.env.TAG_TREE, 'src/standalone/session-client.mjs')).href);
try { await m.ensureDaemon({ attempts: 3, readyTimeoutMs: 60000 }); console.log('RESOLVED'); }
catch (e) { console.log('REJECTED ' + e.message); }
process.exit(0);
"#;

#[test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag); suspends the core for 61 s"]
fn gate_4_contenders_against_a_suspended_core_all_exit() {
    let temp = TempData::new();
    let mut core = core_process(&temp);
    assert_eq!(core.expect("SERVING"), "");
    let before = bytes(&temp);
    suspend(core.pid(), true);
    std::thread::sleep(Duration::from_secs(61));
    // C1: daemon starts; C5: the launcher's ensureDaemon.
    let mut starts: Vec<Child> = (0..3)
        .map(|_| {
            daemon(&temp)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("daemon")
        })
        .collect();
    let ensure = script(&temp, ENSURE_JS);
    for start in &mut starts {
        let status = wait_bounded(start, SETTLE);
        if status.is_none() {
            kill_tree(start);
        }
        assert_eq!(
            status.and_then(|s| s.code()),
            Some(0),
            "C1 exits 0 for attach"
        );
    }
    let said = String::from_utf8_lossy(&ensure.stdout);
    assert!(
        said.starts_with("REJECTED") && said.contains(&record().update_text),
        "C5: {said}"
    );
    assert_eq!(bytes(&temp), before);
    suspend(core.pid(), false);
    core.send("REVALIDATE");
    assert_eq!(core.expect("REVALIDATE "), "Ok(())");
}

// ---------------------------------------------------------------------------
// §11.5 prior owner: blocked until the OS confirms the 1.4.5 daemon's exit
// ---------------------------------------------------------------------------

/// `R` while it names `pid`.
fn owner_record(temp: &TempData, pid: u32) -> Option<serde_json::Value> {
    temp.file(barrier::RECORD_FILE)
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .filter(|v| v["pid"] == pid)
}

/// Settles until the real 1.4.5 daemon `child` published its record and owns
/// the liveness socket that record names; its pid.
fn await_published(temp: &TempData, child: &mut Child) -> u32 {
    let pid = child.id();
    let until = Instant::now() + SETTLE;
    loop {
        let port = owner_record(temp, pid).and_then(|v| v["livenessPort"].as_u64());
        if let Some(port) = port
            && OsProcessTable.listens(pid, port as u16).unwrap()
        {
            return pid;
        }
        if Instant::now() >= until {
            kill_tree(child);
            panic!("1.4.5 daemon never published");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag)"]
fn gate_5_live_1_4_5_heartbeat_is_never_starved_by_booting_cores() {
    let temp = TempData::new();
    // The default 60 s lease: the daemon refreshes every 10 s under B and
    // fences itself after 40 s without a refresh. (A shorter lease fences an
    // undisturbed daemon on a loaded host: its own lock waits exceed it.)
    let mut tag_daemon = daemon(&temp)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("daemon");
    let pid = await_published(&temp, &mut tag_daemon);
    let own = Arc::new(ownership::acquire(&temp.data()).expect("acquire"));
    let mut gate = LaneGate::from(
        Gate::new(own, crate::discovery::path(&temp.runtime()), record()).expect("gate"),
    );
    // Core boots back to back for longer than the fence period: each takes B,
    // judges the owner and gives B back.
    let until = Instant::now() + Duration::from_secs(45);
    let mut boots = 0;
    while Instant::now() < until {
        let GateStep::Blocked(blocked) = gate.step().unwrap() else {
            panic!("a live 1.4.5 owner must block")
        };
        // WaitClaim: the boot found the daemon itself holding B mid-refresh.
        assert!(
            matches!(blocked.kind, BlockedKind::WaitExit | BlockedKind::WaitClaim)
                && blocked.process.identity.pid == pid,
            "{blocked:?}"
        );
        boots += 1;
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        tag_daemon.try_wait().unwrap().is_none(),
        "the 1.4.5 owner exited during {boots} boots"
    );
    // A fenced daemon stops refreshing: the heartbeat must still advance.
    let before = owner_record(&temp, pid).expect("R names the daemon")["heartbeatAt"].clone();
    std::thread::sleep(Duration::from_secs(12));
    let after = owner_record(&temp, pid).expect("R still names the daemon")["heartbeatAt"].clone();
    assert_ne!(before, after, "heartbeat refreshed after {boots} boots");
    assert!(!has_barrier(&temp));
    kill_tree(&mut tag_daemon);
}

#[test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag)"]
fn gate_5_live_1_4_5_daemon_blocks_until_its_os_exit() {
    let temp = TempData::new();
    let mut tag_daemon = daemon(&temp)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("daemon");
    let pid = await_published(&temp, &mut tag_daemon);

    let own = Arc::new(ownership::acquire(&temp.data()).expect("acquire"));
    let mut gate = LaneGate::from(
        Gate::new(
            own.clone(),
            crate::discovery::path(&temp.runtime()),
            record(),
        )
        .expect("gate"),
    );
    let GateStep::Blocked(blocked) = gate.step().unwrap() else {
        panic!("a live 1.4.5 owner must block")
    };
    assert_eq!(
        (
            blocked.kind,
            blocked.process.identity.pid,
            blocked.releasable
        ),
        (BlockedKind::WaitExit, pid, false)
    );
    assert!(matches!(
        gate.release(pid),
        Err(ReleaseError::NotReleasable(_))
    ));
    assert!(!has_barrier(&temp), "no barrier while it lives");

    let waiter = std::thread::spawn(move || blocked.wait(&Interrupt::new().unwrap()).unwrap());
    std::thread::sleep(Duration::from_secs(1));
    assert!(!waiter.is_finished(), "still blocked while the daemon runs");
    kill_tree(&mut tag_daemon);
    waiter.join().unwrap();
    // The barrier (and so migration) comes only after the OS reports the exit.
    assert!(
        OsProcessTable.query(u64::from(pid)).unwrap().is_none(),
        "woken by the OS exit"
    );
    assert!(!has_barrier(&temp));
    assert!(matches!(gate.step().unwrap(), GateStep::Clear));
    assert_eq!(
        temp.file(CLAIM_LOCK_FILE).unwrap(),
        barrier_bytes(own.instance_id())
    );
    assert_eq!(own.revalidate(), Ok(()));
}

// ---------------------------------------------------------------------------
// §11.7 the steps of LR §3.2: suspension, crash points, interleaved contenders
// ---------------------------------------------------------------------------

/// Longer than a 1.4.5 daemon's default fence (40 s without a refresh).
const SUSPEND: Duration = Duration::from_secs(50);

fn daemon_log(temp: &TempData) -> String {
    std::fs::read_to_string(temp.data().join("daemon.log")).unwrap_or_default()
}

/// A real 1.4.5 daemon started now: `Some(pid)` once it serves (its record
/// published and its liveness socket owned), `None` once it exited 0.
fn contender(temp: &TempData) -> (Child, Option<u32>) {
    let mut child = daemon(temp)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("daemon");
    let pid = child.id();
    let until = Instant::now() + SETTLE;
    loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            assert_eq!(status.code(), Some(0), "{}", daemon_log(temp));
            return (child, None);
        }
        let port = owner_record(temp, pid).and_then(|v| v["livenessPort"].as_u64());
        if let Some(port) = port
            && OsProcessTable.listens(pid, port as u16).unwrap()
        {
            return (child, Some(pid));
        }
        if Instant::now() >= until {
            kill_tree(&mut child);
            panic!("1.4.5 daemon neither served nor exited");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// A real 1.4.5 daemon claims while the core is paused at `inject`; the core
/// is then suspended at `at` for longer than the daemon's fence. `residual`:
/// the core holds `B` at `at`, the documented exposure, so the daemon fences.
fn suspended_after_a_claim_in_the_gap(inject: Step, at: Step, residual: bool) {
    let temp = TempData::new();
    let pauses = if inject == at {
        format!("{inject:?}")
    } else {
        format!("{inject:?},{at:?}")
    };
    let mut core = core_process_paused(&temp, &pauses);
    assert_eq!(core.expect(&format!("AT {inject:?}")), "");
    let (mut tag_daemon, pid) = contender(&temp);
    let pid = pid.expect("the 1.4.5 daemon claims while the core holds nothing");
    if inject != at {
        core.send("GO");
        assert_eq!(core.expect(&format!("AT {at:?}")), "");
    }
    let beat = owner_record(&temp, pid).expect("R names the daemon")["heartbeatAt"].clone();
    suspend(core.pid(), true);
    std::thread::sleep(SUSPEND);
    let fenced = daemon_log(&temp).contains("owner lease");
    let beat_after = owner_record(&temp, pid).map(|v| v["heartbeatAt"].clone());
    suspend(core.pid(), false);
    core.send("GO");
    if residual {
        assert!(fenced, "the residual window fences: {}", daemon_log(&temp));
        assert!(
            wait_bounded(&mut tag_daemon, SETTLE).is_some(),
            "the fenced daemon exits"
        );
        serves_after(&core, &temp, Some(&mut tag_daemon), false);
    } else {
        assert!(!fenced, "{}", daemon_log(&temp));
        assert!(
            tag_daemon.try_wait().unwrap().is_none(),
            "the daemon serves on"
        );
        assert_ne!(beat_after, Some(beat), "its heartbeat kept refreshing");
        assert!(!has_barrier(&temp));
        serves_after(&core, &temp, Some(&mut tag_daemon), true);
    }
    kill_tree(&mut tag_daemon);
}

#[test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag); suspends the core for 50 s"]
fn gate_7_claim_before_the_pre_link_read_then_suspended_is_not_fenced() {
    suspended_after_a_claim_in_the_gap(Step::Judged, Step::Judged, false);
}

#[test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag); suspends the core for 50 s"]
fn gate_7_claim_in_the_gap_suspended_before_the_link_is_not_fenced() {
    suspended_after_a_claim_in_the_gap(Step::Linking, Step::Linking, false);
}

#[test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag); suspends the core for 50 s"]
fn gate_7_residual_claim_in_the_gap_suspended_holding_b_fences() {
    suspended_after_a_claim_in_the_gap(Step::Linking, Step::Held, true);
}

#[test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag); suspends the core for 50 s"]
fn gate_7_residual_claim_in_the_gap_suspended_at_the_conflict_fences() {
    suspended_after_a_claim_in_the_gap(Step::Linking, Step::Conflict, true);
}

/// Every step of the `clear` path, in order.
const CLEAR_PATH: [Step; 6] = [
    Step::Judged,
    Step::Linking,
    Step::Held,
    Step::ClaimLockTaken,
    Step::RecordWritten,
    Step::BarrierInstalled,
];

/// The core is killed at `at` (after a 1.4.5 claim in the gap, with
/// `inject`); then optionally a real 1.4.5 daemon starts; then the next core
/// boots. Never two serving owners, and the next boot converges to a serving
/// core with the barrier.
fn killed_at(at: Step, inject: bool, contend: bool) {
    let temp = TempData::new();
    let pauses = if inject {
        format!("Linking,{at:?}")
    } else {
        format!("{at:?}")
    };
    let mut core = core_process_paused(&temp, &pauses);
    let mut live = None;
    if inject {
        assert_eq!(core.expect("AT Linking"), "");
        let (child, pid) = contender(&temp);
        assert!(pid.is_some(), "the injected daemon claims");
        live = Some(child);
        core.send("GO");
    }
    assert_eq!(core.expect(&format!("AT {at:?}")), "");
    drop(core);
    println!("killed at {at:?}");
    if contend {
        let (mut child, pid) = contender(&temp);
        if pid.is_some() {
            assert!(
                live.is_none(),
                "two 1.4.5 daemons serve after a kill at {at:?}"
            );
            live = Some(child);
        } else {
            child.wait().expect("wait");
        }
    }
    let next = core_process(&temp);
    serves_after(&next, &temp, live.as_mut(), true);
}

#[test]
fn a_core_killed_at_each_step_leaves_a_dir_the_next_boot_converges_on() {
    for at in CLEAR_PATH {
        killed_at(at, false, false);
    }
}

#[test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag)"]
fn gate_7_kill_at_each_step_then_a_1_4_5_contender_then_the_next_boot_converges() {
    for at in CLEAR_PATH {
        killed_at(at, false, true);
    }
    for at in [Step::Held, Step::Conflict] {
        killed_at(at, true, true);
    }
}

/// While the core is suspended at `at` holding `B`, real 1.4.5 daemon starts
/// all exit 0 and change neither `B` nor `R`; after resume the core serves.
#[test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag)"]
fn gate_7_contenders_interleaved_with_the_link_record_and_rename_exit() {
    for at in [
        Step::Held,
        Step::ClaimLockTaken,
        Step::RecordWritten,
        Step::BarrierInstalled,
    ] {
        let temp = TempData::new();
        let mut core = core_process_paused(&temp, &format!("{at:?}"));
        assert_eq!(core.expect(&format!("AT {at:?}")), "");
        suspend(core.pid(), true);
        let before = (temp.file(CLAIM_LOCK_FILE), temp.file(RECORD_FILE));
        for _ in 0..2 {
            let (mut child, pid) = contender(&temp);
            if pid.is_some() {
                kill_tree(&mut child);
                panic!("a 1.4.5 daemon claimed while the core held B at {at:?}");
            }
        }
        assert_eq!(
            (temp.file(CLAIM_LOCK_FILE), temp.file(RECORD_FILE)),
            before,
            "at {at:?}"
        );
        suspend(core.pid(), false);
        core.send("GO");
        serves_after(&core, &temp, None, true);
        core.send("REVALIDATE");
        assert_eq!(core.expect("REVALIDATE "), "Ok(())");
    }
}

// ---------------------------------------------------------------------------
// LR §3 startup against a real 1.4.5 claimant
// ---------------------------------------------------------------------------

/// Startup progress as a real 1.4.5 daemon sees it: when the block is published the daemon is
/// still alive and no barrier stands; the daemon is then killed, and startup must continue.
struct KillsOnBlock<'a> {
    temp: &'a TempData,
    daemon: Child,
    pid: u32,
    events: Vec<String>,
}

impl crate::startup::Publish for KillsOnBlock<'_> {
    fn blocked(&mut self, blocked: &Blocked) {
        assert_eq!(blocked.process.identity.pid, self.pid);
        assert!(self.daemon.try_wait().unwrap().is_none(), "the daemon was alive when published");
        assert!(!has_barrier(self.temp), "B was installed beside a live 1.4.5 owner");
        self.events.push("blocked".into());
        kill_tree(&mut self.daemon);
    }

    fn migrating(&mut self) {
        // The OS has confirmed the exit before the barrier, and so before this migration.
        assert!(OsProcessTable.query(u64::from(self.pid)).unwrap().is_none());
        assert!(has_barrier(self.temp), "the migration started before B stood");
        self.events.push("migrating".into());
    }
}

#[tokio::test]
#[ignore = "needs MIXDOG_TAG_TREE (real 1.4.5 tag)"]
async fn startup_is_blocked_by_a_real_1_4_5_claim_and_continues_once_it_exits() {
    let temp = TempData::new();
    let mut daemon = daemon(&temp).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("daemon");
    let pid = await_published(&temp, &mut daemon);
    let tokens = mixdog_rt::testing::tokens();
    let lanes = crate::startup::Lanes { durability: tokens.durability_io, maintenance: tokens.maintenance_io };
    let (_release, releases) = std::sync::mpsc::channel();
    let config = crate::startup::Startup {
        data_dir: temp.data(),
        discovery_path: crate::discovery::path(&temp.runtime()),
        record: record(),
        interrupt: Arc::new(Interrupt::new().unwrap()),
        releases,
    };
    let mut publish = KillsOnBlock { temp: &temp, daemon, pid, events: Vec::new() };
    let seen = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = seen.clone();
    let init_events = Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
    let init_seen = init_events.clone();
    let started = crate::startup::start(
        config,
        lanes,
        &mut publish,
        async move {
            init_seen.lock().unwrap().push("init");
            Ok(())
        },
        move || {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        },
    )
    .await
    .expect("startup continues after the 1.4.5 daemon exits");
    assert_eq!(publish.events, ["blocked", "migrating"]);
    assert_eq!(*init_events.lock().unwrap(), ["init"]);
    assert!(seen.load(std::sync::atomic::Ordering::SeqCst));
    assert_eq!(temp.file(CLAIM_LOCK_FILE).unwrap(), barrier_bytes(started.ownership().instance_id()));
    assert_eq!(started.ownership().revalidate(), Ok(()));
}