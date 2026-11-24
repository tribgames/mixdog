#![allow(clippy::disallowed_methods, reason = "test setup on temp dirs")]

use super::*;

fn discovery(instance_id: &str, state: CoreState) -> Discovery {
    Discovery {
        pid: std::process::id(),
        endpoints: Endpoints { session: SessionEndpoint { port: 4100, token: "tok".into() }, model_proxy: None },
        core: CoreSection {
            version: "1.4.6".into(),
            build: "abc".into(),
            instance_id: instance_id.into(),
            process_start_time: "123".into(),
            state,
            blocked: None,
            drain: None,
            rpc: (state == CoreState::Serving).then_some(Port { port: 4200 }),
            ssh_rpc: (state == CoreState::Serving).then_some(Port { port: 4201 }),
            rebuild: None,
            control: Port { port: 4100 },
        },
    }
}

#[test]
fn published_shape_is_a_superset_1_4_5_readers_parse() {
    let root = tempfile::tempdir().unwrap();
    publish(root.path(), &discovery("inst-1", CoreState::Serving)).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path(root.path())).unwrap()).unwrap();
    assert_eq!(value["pid"], std::process::id());
    assert_eq!(value["endpoints"]["session"]["port"], 4100);
    assert_eq!(value["endpoints"]["session"]["token"], "tok");
    assert_eq!(value["core"]["state"], "serving");
    assert_eq!(value["core"]["instanceId"], "inst-1");
    assert_eq!(value["core"]["rpc"]["port"], 4200);
    assert_eq!(value["core"]["control"]["port"], 4100);
    assert!(value["core"].get("blocked").is_none());

    publish(root.path(), &discovery("inst-1", CoreState::Draining)).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path(root.path())).unwrap()).unwrap();
    assert!(value["core"].get("rpc").is_none(), "draining removes rpc");
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1, "no staging file left");
}

#[test]
fn withdraw_removes_only_this_instance() {
    let root = tempfile::tempdir().unwrap();
    publish(root.path(), &discovery("inst-1", CoreState::Booting)).unwrap();
    assert!(!withdraw(root.path(), "inst-2").unwrap());
    assert!(path(root.path()).is_file());
    assert!(withdraw(root.path(), "inst-1").unwrap());
    assert!(!path(root.path()).exists());
    assert!(!withdraw(root.path(), "inst-1").unwrap());
}

/// The OS error a reader holding the file makes the replace answer with (EPERM / ERROR_ACCESS_DENIED).
fn denied() -> io::Error {
    #[cfg(windows)]
    let code = 5;
    #[cfg(unix)]
    let code = libc::EPERM;
    io::Error::from_raw_os_error(code)
}

/// Node's retry decision for each raw OS error: `RETRY_CODES` (EPERM, EACCES, EBUSY, EEXIST) as libuv names the error
/// (`src/win/error.c` `uv_translate_sys_error` on Windows, the errno itself on POSIX). `Some(true)` is EPERM/EACCES.
#[cfg(windows)]
const RETRY_TABLE: &[(i32, Option<bool>)] = &[
    (5, Some(true)),     // ERROR_ACCESS_DENIED -> EPERM
    (1314, Some(true)),  // ERROR_PRIVILEGE_NOT_HELD -> EPERM
    (740, Some(true)),   // ERROR_ELEVATION_REQUIRED -> EACCES
    (1920, Some(true)),  // ERROR_CANT_ACCESS_FILE -> EACCES
    (10013, Some(true)), // WSAEACCES -> EACCES
    (32, Some(false)),   // ERROR_SHARING_VIOLATION -> EBUSY
    (33, Some(false)),   // ERROR_LOCK_VIOLATION -> EBUSY
    (231, Some(false)),  // ERROR_PIPE_BUSY -> EBUSY
    (183, Some(false)),  // ERROR_ALREADY_EXISTS -> EEXIST
    (80, Some(false)),   // ERROR_FILE_EXISTS -> EEXIST
    (170, None),         // ERROR_BUSY -> UNKNOWN: not retried
    (2, None),           // ERROR_FILE_NOT_FOUND -> ENOENT
    (3, None),           // ERROR_PATH_NOT_FOUND -> ENOENT
    (19, None),          // ERROR_WRITE_PROTECT -> EROFS
    (17, None),          // ERROR_NOT_SAME_DEVICE -> EXDEV
    (112, None),         // ERROR_DISK_FULL -> ENOSPC
];

#[cfg(unix)]
const RETRY_TABLE: &[(i32, Option<bool>)] = &[
    (libc::EPERM, Some(true)),
    (libc::EACCES, Some(true)),
    (libc::EBUSY, Some(false)),
    (libc::EEXIST, Some(false)),
    (libc::ENOENT, None),
    (libc::EROFS, None),
    (libc::EXDEV, None),
    (libc::ENOSPC, None),
    (libc::EAGAIN, None),
];

#[test]
fn only_the_os_errors_node_retries_are_retried() {
    for &(code, expected) in RETRY_TABLE {
        let class = sys::retry_class(code);
        assert_eq!(class, expected.map(|access| if access { Retry::Access } else { Retry::Other }), "OS error {code}");
    }
}

/// Node's `isReadOnlyFile` is `(mode & 0o200) === 0`: the owner's write bit alone.
#[cfg(unix)]
#[test]
fn a_destination_is_read_only_when_the_owner_cannot_write_it() {
    for (mode, read_only) in
        [(0o444, true), (0o400, true), (0o420, true), (0o402, true), (0o040, true), (0o200, false), (0o600, false), (0o644, false), (0o222, false)]
    {
        assert_eq!(sys::mode_is_read_only(mode), read_only, "mode {mode:o}");
    }
}

#[cfg(unix)]
#[test]
fn discovery_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("runtime");
    ensure_private_root(&runtime).unwrap();
    publish(&runtime, &discovery("inst-1", CoreState::Booting)).unwrap();
    assert_eq!(std::fs::metadata(path(&runtime)).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(&runtime).unwrap().permissions().mode() & 0o777, 0o700);
}

/// `readSessionDiscovery` drops a file whose pid is not alive: a file names a running core while its pid runs with the recorded
/// start time, and names nobody once the pid names no process or another one (a reused pid).
#[test]
fn a_file_names_a_running_core_only_while_its_process_runs() {
    let me = crate::verdict::current_identity().unwrap();
    assert!(names_running_core(me.pid, &me.start_ms.to_string()).unwrap());
    assert!(!names_running_core(me.pid, &(me.start_ms + 1).to_string()).unwrap(), "a reused pid");
    assert!(!names_running_core(0, "0").unwrap(), "no process");
}

fn running_discovery(instance_id: &str, state: CoreState) -> Discovery {
    let mut document = discovery(instance_id, state);
    let info = OsProcessTable.query(u64::from(document.pid)).unwrap().expect("this process runs");
    document.core.process_start_time = info.identity.start_ms.to_string();
    document
}

#[test]
fn a_pathless_rescan_event_requests_a_recheck_and_restores_discovery() {
    let root = tempfile::tempdir().unwrap();
    let document = running_discovery("inst-1", CoreState::Serving);
    publish(root.path(), &document).unwrap();
    std::fs::remove_file(path(root.path())).unwrap();
    let mut held = Held { document: Some(document), failing: false };
    let (events, inbox) = std::sync::mpsc::channel();
    // No OS watcher exists in this test: only the injected callback can request the recheck.
    signal_watch_event(root.path(), &events, Ok(notify::Event::new(notify::EventKind::Other)));
    assert!(matches!(inbox.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)));
    let rescan = notify::Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan);
    assert!(rescan.paths.is_empty());
    signal_watch_event(root.path(), &events, Ok(rescan));
    assert!(matches!(inbox.try_recv().unwrap(), WatchSignal::Changed));
    republish_if_changed(root.path(), &mut held);
    assert!(names_instance(&std::fs::read(path(root.path())).unwrap(), "inst-1"));
}

/// Replaces that fail `failures` times with `error`, then rename for real; the pauses it was asked to make are recorded, not slept.
struct Scripted {
    failures: std::cell::Cell<usize>,
    attempts: std::cell::Cell<usize>,
    pauses: std::cell::RefCell<Vec<std::time::Duration>>,
}
impl Scripted {
    fn new(failures: usize) -> Self {
        Self { failures: failures.into(), attempts: 0.into(), pauses: Default::default() }
    }

    fn replace(&self, error: fn() -> io::Error) -> impl Fn(&Path, &Path) -> io::Result<()> + '_ {
        move |from, to| {
            self.attempts.set(self.attempts.get() + 1);
            if self.failures.get() > 0 {
                self.failures.set(self.failures.get() - 1);
                return Err(error());
            }
            std::fs::rename(from, to)
        }
    }

    fn pause(&self) -> impl Fn(std::time::Duration) + '_ {
        |delay| self.pauses.borrow_mut().push(delay)
    }
}
#[test]
fn a_replace_a_reader_blocks_for_a_moment_is_retried_on_node_s_schedule_until_it_lands() {
    let root = tempfile::tempdir().unwrap();
    let script = Scripted::new(4);
    publish_with(root.path(), &discovery("inst-1", CoreState::Serving), &script.replace(denied), &script.pause()).unwrap();

    assert_eq!(script.attempts.get(), 5);
    let pauses = script.pauses.borrow();
    // Node: `backoffs[attempt] + random below min(50, max(1, backoffs[attempt]))`, backoffs 25, 50, 100, 200, ...
    for (pause, base) in pauses.iter().zip([25u64, 50, 100, 200]) {
        let ms = pause.as_millis() as u64;
        assert!((base..base + base.min(50)).contains(&ms), "{ms} ms after a backoff of {base}");
    }
    assert_eq!(pauses.len(), 4);
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path(root.path())).unwrap()).unwrap();
    assert_eq!(value["core"]["state"], "serving");
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1, "no staging file left");
}
#[test]
fn a_replace_that_keeps_failing_makes_every_attempt_of_the_schedule_then_reports_the_error() {
    let root = tempfile::tempdir().unwrap();
    let script = Scripted::new(usize::MAX);
    let error = publish_with(root.path(), &discovery("inst-1", CoreState::Serving), &script.replace(denied), &script.pause()).unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(script.attempts.get(), 24, "Node: one attempt more than the 23 backoffs");
    assert_eq!(script.pauses.borrow().len(), 23);
    assert!(!path(root.path()).exists());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0, "the staging file is removed");
}
#[test]
fn an_error_that_cannot_clear_is_not_retried() {
    let root = tempfile::tempdir().unwrap();
    let script = Scripted::new(usize::MAX);
    let missing = || io::Error::from(io::ErrorKind::NotFound);
    publish_with(root.path(), &discovery("inst-1", CoreState::Serving), &script.replace(missing), &script.pause()).unwrap_err();
    assert_eq!(script.attempts.get(), 1);
    assert!(script.pauses.borrow().is_empty());

    // Node's `isReadOnlyFile`: a refusal to replace a read-only file is not a sharing violation.
    let target = path(root.path());
    std::fs::write(&target, b"old").unwrap();
    let mut permissions = std::fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(&target, permissions).unwrap();
    let script = Scripted::new(usize::MAX);
    publish_with(root.path(), &discovery("inst-1", CoreState::Serving), &script.replace(denied), &script.pause()).unwrap_err();
    assert_eq!(script.attempts.get(), 1);
}
#[test]
fn runtime_root_is_named_as_1_4_5_names_it() {
    let root = runtime_root();
    if std::env::var_os("MIXDOG_RUNTIME_ROOT").is_none() {
        #[cfg(windows)]
        assert_eq!(root.file_name().unwrap(), "mixdog");
        #[cfg(unix)]
        assert!(root.file_name().unwrap().to_string_lossy().starts_with("mixdog-"));
    }
}
fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
#[test]
fn a_serving_core_publishes_a_deleted_discovery_file_again_and_a_second_client_attaches_to_its_pid() {
    let root = tempfile::tempdir().unwrap();
    let owned = OwnedDiscovery::start_with(root.path().to_path_buf(), std::time::Duration::from_millis(5));
    let document = running_discovery("inst-1", CoreState::Serving);
    owned.publish(&document).unwrap();

    // Deleted right after the core's own publish, and again after it came back.
    for _ in 0..2 {
        std::fs::remove_file(path(root.path())).unwrap();
        wait_until("the discovery file to come back", || path(root.path()).is_file());
        let back = mixdog_app_server_client::discovery::Discovery::read(&path(root.path())).unwrap();
        assert_eq!(back.pid, document.pid, "a second client attaches to the serving core");
        assert_eq!(back.core.instance_id, "inst-1");
        assert!(names_running_core(back.pid, &back.core.process_start_time).unwrap());
    }
}
// Acknowledged only after the watcher installed/rebound watches and completed its actual recheck.
fn await_recheck(owned: &OwnedDiscovery) {
    let (done, completion) = std::sync::mpsc::channel();
    owned.events.send(WatchSignal::Rechecked(done)).unwrap();
    completion.recv_timeout(std::time::Duration::from_secs(10)).expect("watcher recheck completion");
}
#[test]
fn a_deleted_runtime_root_and_parent_are_made_again_after_initial_recheck() {
    let outside = tempfile::tempdir().unwrap();
    let parent = outside.path().join("parent");
    let root = parent.join("runtime");
    ensure_private_root(&root).unwrap();
    let owned = OwnedDiscovery::start_with(root.clone(), std::time::Duration::from_millis(5));
    owned.publish(&running_discovery("inst-1", CoreState::Serving)).unwrap();
    await_recheck(&owned);
    {
        let _watcher_waits = owned.held.lock().unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }
    wait_until("root deletion recovery from filesystem event", || path(&root).is_file());
    await_recheck(&owned);
    {
        let _watcher_waits = owned.held.lock().unwrap();
        std::fs::remove_dir_all(&parent).unwrap();
        std::fs::create_dir(&parent).unwrap();
    }
    wait_until("parent replacement recovery from filesystem event", || path(&root).is_file());
    await_recheck(&owned);
    // Prove the recreated root itself is followed after reconnecting.
    std::fs::remove_file(path(&root)).unwrap();
    wait_until("reconnected root observes a later file deletion", || path(&root).is_file());
    assert!(names_instance(&std::fs::read(path(&root)).unwrap(), "inst-1"));
}
#[test]
fn migrating_is_kept_and_draining_stops_republication() {
    let root = tempfile::tempdir().unwrap();
    let owned = OwnedDiscovery::start_with(root.path().to_path_buf(), std::time::Duration::from_millis(5));
    owned.publish(&running_discovery("inst-1", CoreState::Migrating)).unwrap();
    std::fs::remove_file(path(root.path())).unwrap();
    wait_until("migrating discovery", || path(root.path()).is_file());
    owned.publish(&running_discovery("inst-1", CoreState::Draining)).unwrap();
    std::fs::remove_file(path(root.path())).unwrap();
    await_recheck(&owned);
    assert!(!path(root.path()).exists());
}
#[test]
fn a_released_core_does_not_put_its_file_back() {
    let root = tempfile::tempdir().unwrap();
    let owned = OwnedDiscovery::start_with(root.path().to_path_buf(), std::time::Duration::from_millis(5));
    owned.publish(&running_discovery("inst-1", CoreState::Serving)).unwrap();
    assert!(owned.release("inst-1").unwrap());
    await_recheck(&owned);
    assert!(!path(root.path()).exists());
}
/// Another writer's document, replaced as every writer of the file replaces it: written in place, the file is empty between
/// its truncation and its write, and a recheck that reads it then restores over the write.
fn overwrite(root: &Path, bytes: &[u8]) {
    let staging = root.join("foreign.tmp");
    std::fs::write(&staging, bytes).unwrap();
    std::fs::rename(&staging, path(root)).unwrap();
}
#[test]
fn overwritten_or_invalid_discovery_is_restored_but_same_pid_is_untouched() {
    let root = tempfile::tempdir().unwrap();
    let owned = OwnedDiscovery::start_with(root.path().to_path_buf(), std::time::Duration::from_millis(5));
    let document = running_discovery("owner", CoreState::Serving);
    owned.publish(&document).unwrap();
    for bytes in [b"{}".as_slice(), b"{broken", b"{\"pid\":0}", b"null"] {
        overwrite(root.path(), bytes);
        wait_until("overwritten discovery", || std::fs::read(path(root.path())).is_ok_and(|bytes| names_instance(&bytes, "owner")));
    }
    let bytes = format!("{{\"pid\":\"{}\",\"other\":\"\\ud800\"}}", document.pid);
    overwrite(root.path(), bytes.as_bytes());
    await_recheck(&owned);
    assert_eq!(std::fs::read_to_string(path(root.path())).unwrap(), bytes);
}
#[test]
fn a_blocked_contender_does_not_compete_with_the_owner_or_restore_a_deleted_file() {
    let root = tempfile::tempdir().unwrap();
    let owner = OwnedDiscovery::start_with(root.path().to_path_buf(), std::time::Duration::from_millis(5));
    let contender = OwnedDiscovery::start_with(root.path().to_path_buf(), std::time::Duration::from_millis(5));
    let real = running_discovery("owner", CoreState::Serving);
    owner.publish(&real).unwrap();
    let mut blocked = real.clone();
    blocked.pid += 1;
    blocked.core.instance_id = "blocked".into();
    blocked.core.state = CoreState::Blocked;
    contender.publish(&blocked).unwrap();
    wait_until("owner reclaim", || std::fs::read(path(root.path())).is_ok_and(|bytes| names_instance(&bytes, "owner")));
    std::fs::remove_file(path(root.path())).unwrap();
    wait_until("owner republish", || std::fs::read(path(root.path())).is_ok_and(|bytes| names_instance(&bytes, "owner")));
    owner.release("owner").unwrap();
    await_recheck(&owner);
    await_recheck(&contender);
    assert!(!path(root.path()).exists(), "blocked contender must not take the discovery file");
}
#[test]
fn dropping_the_watch_cannot_resurrect_discovery() {
    let root = tempfile::tempdir().unwrap();
    let owned = OwnedDiscovery::start_with(root.path().to_path_buf(), std::time::Duration::from_millis(5));
    owned.publish(&running_discovery("owner", CoreState::Serving)).unwrap();
    let events = owned.events.clone();
    drop(owned);
    std::fs::remove_file(path(root.path())).unwrap();
    let (done, completion) = std::sync::mpsc::channel();
    let _ = events.send(WatchSignal::Rechecked(done));
    assert_eq!(
        completion.recv_timeout(std::time::Duration::from_secs(10)),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected),
        "the watch ended at its stop without another recheck"
    );
    assert!(!path(root.path()).exists());
}
/// Invoked only by the isolated launcher integration below. This is a test
/// process publishing fake endpoints, not a daemon/core/profile.
#[test]
#[ignore = "private helper for ensure_core_reattaches_after_discovery_republication"]
fn discovery_owned_child() {
    let Some(root) = std::env::var_os("MIXDOG_DISCOVERY_TEST_ROOT") else { return };
    let root = PathBuf::from(root);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let owned = OwnedDiscovery::start(root.clone());
    let document = running_discovery("isolated-owned-child", CoreState::Serving);
    let mut published = false;
    while std::time::Instant::now() < deadline && !root.join("stop").exists() {
        if !published && root.join("start").exists() {
            owned.publish(&document).unwrap();
            published = true;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    owned.release(&document.core.instance_id).unwrap();
}
/// Opt-in root validation: the actual ensureCore function launches the fake
/// owned child through its injected launch port, then attaches again after
/// deleting/recovering daemon.json. Neither launchCore nor a real core is used.
#[test]
#[allow(clippy::disallowed_types, reason = "only owned, self-terminating test helpers; no product process")]
fn ensure_core_reattaches_after_discovery_republication() {
    use std::process::{Command, Stdio};
    let root = tempfile::tempdir().unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "discovery::tests::discovery_owned_child", "--ignored", "--nocapture"])
        .env("MIXDOG_DISCOVERY_TEST_ROOT", root.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().expect("owned test child");
    let expected_pid = child.id();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(4).unwrap();
    let script = r#"
import {pathToFileURL} from 'node:url';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
const {ensureCore}=await import(pathToFileURL(process.env.MIXDOG_DISCOVERY_TEST_ENSURE));
const root=process.env.MIXDOG_DISCOVERY_TEST_ROOT;
const file=join(root,'daemon.json');
let launches=0;
const readDiscovery=async()=>{try{const d=JSON.parse(await readFile(file,'utf8'));return {pid:d.pid,state:d.core.state,rpcPort:d.core.rpc?.port,blocked:d.core.blocked};}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const launch=async()=>{if(++launches!==1)throw Error('a second core was launched');await writeFile(join(root,'start'),'');return null;};
try {
 const first=await ensureCore({readDiscovery,launch,readyTimeoutMs:5000});
 await unlink(file);
 const deadline=Date.now()+5000;
 while(!(await readDiscovery())) {if(Date.now()>deadline)throw Error('discovery was not restored');await new Promise(r=>setTimeout(r,10));}
 const second=await ensureCore({readDiscovery,launch,readyTimeoutMs:2000});
 if(first.pid!==second.pid||first.pid!==Number(process.env.MIXDOG_DISCOVERY_TEST_PID)||launches!==1||second.state!=='serving')throw Error('same-PID attach failed');
 console.log(JSON.stringify({pid:second.pid,launches,state:second.state}));
} finally {await writeFile(join(root,'stop'),'');}
"#;
    let mut node = Command::new("node");
    node.args(["--input-type=module", "--eval", script])
        .env("MIXDOG_DISCOVERY_TEST_ROOT", root.path())
        .env("MIXDOG_DISCOVERY_TEST_PID", expected_pid.to_string())
        .env("MIXDOG_DISCOVERY_TEST_ENSURE", repo.join("packages/protocol-client/src/launch/ensure-core.mjs"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        node.creation_flags(0x08000000);
    }
    let result = node.output();
    // The helper returns on this marker, including a failed Node start. No process is killed.
    std::fs::write(root.path().join("stop"), b"").unwrap();
    let child_status = child.wait().unwrap();
    let output = result.expect("Node harness");
    assert!(child_status.success(), "owned helper failed");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let answer: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(answer["pid"], expected_pid);
    assert_eq!(answer["launches"], 1);
}
