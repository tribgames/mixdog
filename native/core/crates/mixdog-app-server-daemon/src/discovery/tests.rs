#![allow(clippy::disallowed_methods, reason = "test setup on temp dirs")]

use super::*;

fn discovery(instance_id: &str, state: CoreState) -> Discovery {
    Discovery {
        pid: std::process::id(),
        endpoints: Endpoints {
            session: SessionEndpoint {
                port: 4100,
                token: "tok".into(),
            },
            model_proxy: None,
        },
        core: CoreSection {
            version: "1.4.6".into(),
            build: "abc".into(),
            instance_id: instance_id.into(),
            process_start_time: "123".into(),
            state,
            blocked: None,
            drain: None,
            rpc: (state == CoreState::Serving).then_some(Port { port: 4200 }),
            control: Port { port: 4100 },
        },
    }
}

#[test]
fn published_shape_is_a_superset_1_4_5_readers_parse() {
    let root = tempfile::tempdir().unwrap();
    publish(root.path(), &discovery("inst-1", CoreState::Serving)).unwrap();
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path(root.path())).unwrap()).unwrap();
    assert_eq!(value["pid"], std::process::id());
    assert_eq!(value["endpoints"]["session"]["port"], 4100);
    assert_eq!(value["endpoints"]["session"]["token"], "tok");
    assert_eq!(value["core"]["state"], "serving");
    assert_eq!(value["core"]["instanceId"], "inst-1");
    assert_eq!(value["core"]["rpc"]["port"], 4200);
    assert_eq!(value["core"]["control"]["port"], 4100);
    assert!(value["core"].get("blocked").is_none());

    publish(root.path(), &discovery("inst-1", CoreState::Draining)).unwrap();
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path(root.path())).unwrap()).unwrap();
    assert!(value["core"].get("rpc").is_none(), "draining removes rpc");
    assert_eq!(
        std::fs::read_dir(root.path()).unwrap().count(),
        1,
        "no staging file left"
    );
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
    (5, Some(true)),      // ERROR_ACCESS_DENIED -> EPERM
    (1314, Some(true)),   // ERROR_PRIVILEGE_NOT_HELD -> EPERM
    (740, Some(true)),    // ERROR_ELEVATION_REQUIRED -> EACCES
    (1920, Some(true)),   // ERROR_CANT_ACCESS_FILE -> EACCES
    (10013, Some(true)),  // WSAEACCES -> EACCES
    (32, Some(false)),    // ERROR_SHARING_VIOLATION -> EBUSY
    (33, Some(false)),    // ERROR_LOCK_VIOLATION -> EBUSY
    (231, Some(false)),   // ERROR_PIPE_BUSY -> EBUSY
    (183, Some(false)),   // ERROR_ALREADY_EXISTS -> EEXIST
    (80, Some(false)),    // ERROR_FILE_EXISTS -> EEXIST
    (170, None),          // ERROR_BUSY -> UNKNOWN: not retried
    (2, None),            // ERROR_FILE_NOT_FOUND -> ENOENT
    (3, None),            // ERROR_PATH_NOT_FOUND -> ENOENT
    (19, None),           // ERROR_WRITE_PROTECT -> EROFS
    (17, None),           // ERROR_NOT_SAME_DEVICE -> EXDEV
    (112, None),          // ERROR_DISK_FULL -> ENOSPC
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
        assert_eq!(
            class,
            expected.map(|access| if access { Retry::Access } else { Retry::Other }),
            "OS error {code}"
        );
    }
}

/// Node's `isReadOnlyFile` is `(mode & 0o200) === 0`: the owner's write bit alone.
#[cfg(unix)]
#[test]
fn a_destination_is_read_only_when_the_owner_cannot_write_it() {
    for (mode, read_only) in [
        (0o444, true),
        (0o400, true),
        (0o420, true),
        (0o402, true),
        (0o040, true),
        (0o200, false),
        (0o600, false),
        (0o644, false),
        (0o222, false),
    ] {
        assert_eq!(sys::mode_is_read_only(mode), read_only, "mode {mode:o}");
    }
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

#[cfg(unix)]
#[test]
fn discovery_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("runtime");
    ensure_private_root(&runtime).unwrap();
    publish(&runtime, &discovery("inst-1", CoreState::Booting)).unwrap();
    assert_eq!(
        std::fs::metadata(path(&runtime))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        std::fs::metadata(&runtime).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

#[test]
fn runtime_root_is_named_as_1_4_5_names_it() {
    let root = runtime_root().unwrap();
    if std::env::var_os("MIXDOG_RUNTIME_ROOT").is_none() {
        assert!(root.starts_with(node_tmpdir()));
        #[cfg(windows)]
        assert_eq!(root.file_name().unwrap(), "mixdog");
        #[cfg(unix)]
        assert!(
            root.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("mixdog-")
        );
    }
}
