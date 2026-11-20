//! The launcher's crash capture of a core it starts: where captures live, the files and the JSON sidecar of one boot as the boot
//! goes (spawned, tracked, ready, exited, failed to start), what is mirrored into the launcher's log, the failure summary a launcher
//! shows, and what retention keeps. The clock is scripted and nothing here starts a process.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the test lays out folders and reads what the capture left on disk")]

use std::ffi::OsString;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;

use mixdog_launch::crash_capture::CaptureOptions;
use mixdog_launch::crash_capture::SpawnCapture;
use mixdog_launch::crash_capture::capture_dir;
use mixdog_launch::crash_capture::paths::data_dir_of;
use mixdog_launch::crash_capture::prune_crash_captures;
use serde_json::Value;
use serde_json::json;

const LAUNCHER_PID: u32 = 4242;
/// 2026-11-14T03:04:05.678Z.
const T0: i64 = 1_794_625_445_678;
const STEM: &str = "daemon-20261114-030405-4242-c0de";

/// One boot's capture in a throwaway folder, with a scripted clock and a log that collects what the launcher would print.
struct Boot {
    dir: tempfile::TempDir,
    clock: Arc<AtomicI64>,
    log: Arc<Mutex<Vec<String>>>,
    capture: SpawnCapture,
}

impl Boot {
    fn begin() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(AtomicI64::new(T0));
        let log: Arc<Mutex<Vec<String>>> = Arc::default();
        let mut options = CaptureOptions::new("core");
        let sink = log.clone();
        options.log = Arc::new(move |line| sink.lock().unwrap().push(line.to_owned()));
        options.dir = Some(dir.path().to_path_buf());
        options.launcher_pid = LAUNCHER_PID;
        let now = clock.clone();
        options.now = Arc::new(move || now.load(Ordering::SeqCst));
        options.prune = false;
        options.nonce = Arc::new(|| "c0de".to_owned());
        let capture = SpawnCapture::begin(options);
        Self { dir, clock, log, capture }
    }

    /// The clock is `ms` after the spawn.
    fn after(&self, ms: i64) {
        self.clock.store(T0 + ms, Ordering::SeqCst);
    }

    /// What the core writes to fd 2.
    fn stderr(&self, text: &str) {
        let path = self.capture.capture_path().expect("the capture file");
        let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    fn sidecar(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.capture.record_path().expect("a sidecar")).unwrap()).unwrap()
    }

    fn files(&self) -> Vec<String> {
        let mut names: Vec<String> =
            std::fs::read_dir(self.dir.path()).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    fn err_log(&self) -> String {
        self.dir.path().join(format!("{STEM}.err.log")).to_string_lossy().into_owned()
    }

    fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }

    /// The failure summary as JSON.
    fn summary(&self) -> Value {
        let summary = self.capture.summary();
        json!({
            "pid": summary.pid,
            "ready": summary.ready,
            "exitCode": summary.exit_code,
            "exitReason": summary.exit_reason,
            "uptimeMs": summary.uptime_ms,
            "error": summary.error,
            "stderrErrorLine": summary.stderr_error_line,
            "stderrLastLine": summary.stderr_last_line,
            "stderrPath": summary.stderr_path.and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned())),
        })
    }
}

#[test]
fn captures_live_in_the_daemon_crash_folder_of_the_data_folder() {
    assert_eq!(capture_dir(Path::new("data")), Path::new("data").join("daemon-crash"));
    let env =
        |vars: &'static [(&'static str, &'static str)]| move |name: &str| vars.iter().find(|(key, _)| *key == name).map(|(_, value)| OsString::from(*value));
    // The data folder: MIXDOG_DATA_DIR, else `data` under MIXDOG_HOME; an empty variable counts as not set.
    assert_eq!(data_dir_of(&env(&[("MIXDOG_DATA_DIR", "x")]), None), Some(PathBuf::from("x")));
    assert_eq!(data_dir_of(&env(&[("MIXDOG_HOME", "h")]), None), Some(Path::new("h").join("data")));
    assert_eq!(data_dir_of(&env(&[("MIXDOG_DATA_DIR", ""), ("MIXDOG_HOME", "h")]), None), Some(Path::new("h").join("data")));
    assert_eq!(data_dir_of(&env(&[("MIXDOG_DATA_DIR", "x"), ("MIXDOG_HOME", "h")]), None), Some(PathBuf::from("x")));
    assert_eq!(data_dir_of(&env(&[]), Some(PathBuf::from("home"))), Some(Path::new("home").join(".mixdog").join("data")));
    assert_eq!(data_dir_of(&env(&[]), None), None, "no variable and no home: nothing is kept");
}

#[test]
fn a_boot_that_serves_and_then_crashes_leaves_a_file_of_what_it_said_and_a_sidecar_of_its_life() {
    let boot = Boot::begin();
    assert_eq!(boot.capture.stem().as_deref(), Some(STEM));
    assert_eq!(boot.files(), [format!("{STEM}.err.log"), format!("{STEM}.json")]);
    let started = boot.sidecar();
    assert_eq!(
        started,
        json!({
            "kind": "mixdog-daemon-crash-capture", "launcher": "core", "launcherPid": 4242, "pid": null, "detached": null, "heapFlags": [],
            "stderrFile": format!("{STEM}.err.log"), "spawnedAt": "2026-11-14T03:04:05.678Z", "readyAt": null, "exitedAt": null, "ready": false,
            "exitCode": null, "exitSignal": null, "uptimeMs": null, "stderrBytes": 0, "error": null
        })
    );

    boot.stderr("boot line\nTypeError: boom\ntail line\n");
    boot.capture.track(Some(100), true, None);
    assert_eq!((boot.sidecar()["pid"].clone(), boot.sidecar()["detached"].clone()), (json!(100), json!(true)));
    boot.after(50);
    boot.capture.note_ready();
    assert_eq!((boot.sidecar()["ready"].clone(), boot.sidecar()["readyAt"].clone()), (json!(true), json!("2026-11-14T03:04:05.728Z")));
    boot.after(950);
    boot.capture.note_exit(Some(1), None);

    let ended = boot.sidecar();
    assert_eq!(
        (
            ended["exitedAt"].clone(),
            ended["exitCode"].clone(),
            ended["exitSignal"].clone(),
            ended["uptimeMs"].clone(),
            ended["stderrBytes"].clone(),
            ended["exitReason"].clone()
        ),
        (json!("2026-11-14T03:04:06.628Z"), json!(1), Value::Null, json!(950), json!(36), json!("exited with code 1"))
    );
    assert_eq!(
        boot.log(),
        [
            format!("daemon crash capture pid=100 file={}", boot.err_log()),
            "boot line".to_owned(),
            "TypeError: boom".to_owned(),
            "tail line".to_owned(),
            format!("daemon exit pid=100 code=1 signal=- ready=1 uptimeMs=950 stderrBytes=36 capture={}", boot.err_log()),
        ]
    );
    assert_eq!(boot.files(), [format!("{STEM}.err.log"), format!("{STEM}.json")], "a crash keeps its file");
    let summary = boot.summary();
    assert_eq!(
        (summary["pid"].clone(), summary["ready"].clone(), summary["exitReason"].clone(), summary["uptimeMs"].clone()),
        (json!(100), json!(true), json!("exited with code 1"), json!(950))
    );
    assert_eq!((summary["stderrErrorLine"].clone(), summary["stderrLastLine"].clone()), (json!("TypeError: boom"), json!("tail line")));
    assert_eq!(summary["stderrPath"], json!(format!("{STEM}.err.log")));
}

#[test]
fn an_exit_is_worded_by_how_it_happened() {
    let words = |code: Option<i64>, signal: Option<&str>| {
        let boot = Boot::begin();
        boot.capture.track(Some(103), true, None);
        boot.stderr("something was said\n");
        boot.after(30);
        boot.capture.note_exit(code, signal);
        (boot.sidecar()["exitReason"].clone(), boot.sidecar()["exitSignal"].clone())
    };
    assert_eq!(words(Some(0), None), (json!("exited normally (code 0)"), Value::Null));
    assert_eq!(words(Some(3), None), (json!("exited with code 3"), Value::Null));
    assert_eq!(words(None, Some("SIGKILL")), (json!("killed by signal SIGKILL"), json!("SIGKILL")));
    // Windows reports a process ended by its parent's job with this status.
    assert_eq!(
        words(Some(1_073_807_364), None).0,
        json!("terminated externally (DBG_TERMINATE_PROCESS 0x40010004: process-tree/job termination by its parent)")
    );
}

#[test]
fn a_contender_that_lost_the_claim_and_said_nothing_leaves_no_file_but_a_core_that_served_or_spoke_does() {
    let contender = Boot::begin();
    contender.capture.track(Some(101), true, None);
    contender.after(20);
    contender.capture.note_exit(Some(0), None);
    assert_eq!(contender.files(), Vec::<String>::new(), "nothing is kept for a clean exit of a boot that never served and said nothing");
    assert_eq!(
        contender.log(),
        [
            format!("daemon crash capture pid=101 file={}", contender.err_log()),
            "daemon exit pid=101 code=0 signal=- ready=0 uptimeMs=20 stderrBytes=0".to_owned()
        ]
    );
    assert_eq!(contender.summary()["stderrPath"], Value::Null);

    let served = Boot::begin();
    served.capture.track(Some(102), false, None);
    served.after(10);
    served.capture.note_ready();
    served.after(5000);
    served.capture.note_exit(Some(0), None);
    assert_eq!(served.files(), [format!("{STEM}.err.log"), format!("{STEM}.json")]);

    let spoke = Boot::begin();
    spoke.capture.track(Some(103), true, None);
    spoke.stderr("something was said\n");
    spoke.after(30);
    spoke.capture.note_exit(Some(0), None);
    assert_eq!(spoke.files(), [format!("{STEM}.err.log"), format!("{STEM}.json")]);
}

#[test]
fn a_core_that_cannot_be_started_is_recorded_as_a_failed_start_with_its_message_in_one_line() {
    let silent = Boot::begin();
    silent.after(5);
    silent.capture.note_spawn_error("spawn mixdogd ENOENT");
    assert_eq!(silent.files(), [format!("{STEM}.json")], "no bytes were written: no capture file");
    let record = silent.sidecar();
    assert_eq!(
        (record["error"].clone(), record["exitedAt"].clone(), record["pid"].clone(), record["exitCode"].clone()),
        (json!("spawn mixdogd ENOENT"), json!("2026-11-14T03:04:05.683Z"), Value::Null, Value::Null)
    );
    let summary = silent.summary();
    assert_eq!((summary["error"].clone(), summary["pid"].clone(), summary["stderrPath"].clone()), (json!("spawn mixdogd ENOENT"), Value::Null, Value::Null));

    let spoke = Boot::begin();
    spoke.stderr("the loader said this\n");
    spoke.after(5);
    spoke.capture.note_spawn_error("  spawn   mixdogd\n EACCES ");
    assert_eq!(spoke.files(), [format!("{STEM}.err.log"), format!("{STEM}.json")], "what it said is kept");
    let record = spoke.sidecar();
    assert_eq!((record["error"].clone(), record["stderrBytes"].clone()), (json!("spawn mixdogd EACCES"), json!(21)), "whitespace runs are one space");
}

#[test]
fn what_the_core_writes_about_its_own_exit_is_kept_and_its_reason_is_the_one_recorded() {
    let boot = Boot::begin();
    boot.capture.track(Some(107), true, None);
    boot.after(40);
    boot.capture.note_ready();
    let mut record = boot.sidecar();
    record["daemonExit"] = json!({ "reason": "shutdown: fatal boot error (exited with code 2)", "code": 2, "signal": null, "error": null, "at": "2026-11-14T03:04:06Z", "uptimeMs": 1000 });
    record["exitReason"] = json!("shutdown: fatal boot error (exited with code 2)");
    std::fs::write(boot.capture.record_path().unwrap(), serde_json::to_vec(&record).unwrap()).unwrap();
    boot.after(1000);
    boot.capture.note_exit(Some(2), None);
    let ended = boot.sidecar();
    assert_eq!(ended["daemonExit"], record["daemonExit"], "the core's own block survives the launcher's update");
    assert_eq!(
        (ended["exitReason"].clone(), ended["exitCode"].clone(), ended["exitedAt"].clone()),
        (json!("shutdown: fatal boot error (exited with code 2)"), json!(2), json!("2026-11-14T03:04:06.678Z"))
    );
}

#[test]
fn a_second_ready_or_exit_of_the_same_boot_changes_nothing() {
    let boot = Boot::begin();
    boot.capture.track(Some(108), true, None);
    boot.after(10);
    boot.capture.note_ready();
    boot.after(20);
    boot.capture.note_ready();
    boot.after(30);
    boot.capture.note_exit(Some(3), None);
    boot.after(40);
    boot.capture.note_exit(Some(4), None);
    let record = boot.sidecar();
    assert_eq!(
        (record["readyAt"].clone(), record["exitCode"].clone(), record["exitedAt"].clone()),
        (json!("2026-11-14T03:04:05.688Z"), json!(3), json!("2026-11-14T03:04:05.708Z"))
    );
}

#[test]
fn only_the_newest_part_of_a_long_stderr_is_mirrored_into_the_log_and_the_log_says_how_much_was_skipped() {
    let boot = Boot::begin();
    boot.capture.track(Some(109), true, None);
    boot.stderr(&"line-0000\n".repeat(2000));
    boot.after(40);
    boot.capture.note_ready();
    boot.stderr("after ready\n");
    boot.after(60);
    boot.capture.note_exit(Some(9), None);
    let log = boot.log();
    // 20000 bytes were written before ready; the log takes the last 16 KiB of them and says it skipped the 3616 before.
    assert_eq!(log[1], format!("daemon stderr: skipped 3616 earlier byte(s), full text in {}", boot.err_log()));
    assert_eq!(log.iter().filter(|line| line.starts_with("daemon stderr: skipped")).count(), 1);
    assert!(log.len() < 1700, "{} lines", log.len());
    assert_eq!(log[log.len() - 2], "after ready", "a line is mirrored once, at the next event");
    assert_eq!(log[log.len() - 1], format!("daemon exit pid=109 code=9 signal=- ready=1 uptimeMs=60 stderrBytes=20012 capture={}", boot.err_log()));
}

#[test]
fn a_failure_summary_names_the_first_error_line_and_the_last_line_of_what_the_core_said() {
    // (what fd 2 holds, the error line found, the last non-blank line).
    let cases: [(&str, Option<&str>, Option<&str>); 9] = [
        ("starting\nnon-fatal: ignored\nstill going\n", None, Some("still going")),
        ("starting\n  RangeError [ERR_OUT_OF_RANGE]: too far  \nlater\n", Some("RangeError [ERR_OUT_OF_RANGE]: too far"), Some("later")),
        ("Error\nlater\n", Some("Error"), Some("later")),
        ("boot\nFATAL ERROR: Reached heap limit\nlater\n", Some("FATAL ERROR: Reached heap limit"), Some("later")),
        ("boot\na fatal boot error occurred\nlater\n", Some("a fatal boot error occurred"), Some("later")),
        ("boot\nnonfatal event\ninfatal\n", None, Some("infatal")),
        ("first\r\n\r\n   \r\nlast line\r\n", None, Some("last line")),
        ("", None, None),
        ("boot\nTypeError: one\nTypeError: two\n", Some("TypeError: one"), Some("TypeError: two")),
    ];
    for (text, error_line, last_line) in cases {
        let boot = Boot::begin();
        boot.capture.track(Some(110), true, None);
        boot.stderr(text);
        let summary = boot.summary();
        assert_eq!((summary["stderrErrorLine"].clone(), summary["stderrLastLine"].clone()), (json!(error_line), json!(last_line)), "{text:?}");
        assert_eq!(summary["stderrPath"], json!(format!("{STEM}.err.log")), "{text:?}");
    }
}

/// A boot's files in `dir`: its capture of `raw` bytes and, unless `record` is `None`, its sidecar `record`, both written `age_secs` ago.
fn lay_out(dir: &Path, stem: &str, record: Option<&str>, raw: usize, age_secs: u64) {
    let stamp = |path: PathBuf| {
        let at = SystemTime::now() - Duration::from_secs(age_secs);
        std::fs::File::options().write(true).open(path).unwrap().set_modified(at).unwrap();
    };
    std::fs::write(dir.join(format!("{stem}.err.log")), vec![b'x'; raw]).unwrap();
    stamp(dir.join(format!("{stem}.err.log")));
    if let Some(record) = record {
        std::fs::write(dir.join(format!("{stem}.json")), record).unwrap();
        stamp(dir.join(format!("{stem}.json")));
    }
}

const EXITED: &str = r#"{"pid": 1, "exitedAt": "2026-11-13T00:00:00.000Z"}"#;

#[test]
fn completed_boots_share_a_two_mib_budget_counted_on_both_their_files_and_the_oldest_that_does_not_fit_is_removed_with_both() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    // Eight completed boots, each a capture of exactly 256 KiB (not over the trim limit) and a 50-byte sidecar: seven fit the
    // 2 MiB budget (7 x 262194 bytes), the eighth, the oldest, would make it 2097552 and goes, both files of it.
    for n in 1..=8u64 {
        lay_out(dir, &format!("daemon-20261113-00000{n}-1-00a{n}"), Some(EXITED), 256 * 1024, n * 10);
    }
    // A capture of a live core is outside the budget and is never touched, however old.
    lay_out(dir, "daemon-20261113-000009-7-00dd", Some(r#"{"pid": 7, "exitedAt": null}"#), 100, 9000);
    let pruned = prune_crash_captures(dir, &|pid| pid == 7);
    assert_eq!((pruned.kept_boots, pruned.removed, pruned.trimmed, pruned.active_boots, pruned.unknown_boots), (7, 2, 0, 1, 0));
    assert_eq!(pruned.kept_bytes, 7 * (256 * 1024 + 50));
    assert!(!dir.join("daemon-20261113-000008-1-00a8.err.log").exists() && !dir.join("daemon-20261113-000008-1-00a8.json").exists());
    assert!(dir.join("daemon-20261113-000007-1-00a7.err.log").exists() && dir.join("daemon-20261113-000009-7-00dd.err.log").exists());
}

#[test]
fn a_completed_capture_over_256_kib_is_trimmed_to_its_tail_under_a_line_that_says_what_was_dropped_before_it_is_weighed() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    // Three completed captures of 900 KiB: each is trimmed first, so together they are far under the budget and all stay.
    for n in 1..=3u64 {
        lay_out(dir, &format!("daemon-20261113-00000{n}-1-00b{n}"), Some(EXITED), 900 * 1024, n * 10);
    }
    let pruned = prune_crash_captures(dir, &|_| false);
    assert_eq!((pruned.kept_boots, pruned.removed, pruned.trimmed), (3, 0, 3));
    let kept = std::fs::read(dir.join("daemon-20261113-000001-1-00b1.err.log")).unwrap();
    let dropped = 900 * 1024 - 256 * 1024;
    let first_line = format!("[capture trimmed: dropped {dropped} earlier byte(s)]");
    assert!(kept.starts_with(first_line.as_bytes()));
    assert_eq!(kept.len(), first_line.len() + 1 + 256 * 1024);
    // A capture that is already a trimmed tail is not trimmed again.
    assert_eq!(prune_crash_captures(dir, &|_| false).trimmed, 0);
}

#[test]
fn the_newest_completed_boot_survives_even_when_it_alone_spends_the_whole_budget() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    // The newest boot's sidecar alone is 3 MiB (a capture is trimmed, a sidecar is not): over the budget, and kept, as it is the
    // crash to look at; the older boot no longer fits and is removed.
    let big = format!(r#"{{"pid": 1, "exitedAt": "2026-11-13T00:00:00.000Z", "pad": "{}"}}"#, "p".repeat(3 * 1024 * 1024));
    lay_out(dir, "daemon-20261113-000001-1-00aa", Some(&big), 100, 10);
    lay_out(dir, "daemon-20261113-000002-1-00bb", Some(EXITED), 100, 20);
    let pruned = prune_crash_captures(dir, &|_| false);
    assert_eq!((pruned.kept_boots, pruned.removed, pruned.trimmed), (1, 2, 0));
    assert!(dir.join("daemon-20261113-000001-1-00aa.json").exists());
    assert!(!dir.join("daemon-20261113-000002-1-00bb.json").exists() && !dir.join("daemon-20261113-000002-1-00bb.err.log").exists());
    // Nothing there, nothing to do.
    let empty = tempfile::tempdir().unwrap();
    assert_eq!(prune_crash_captures(empty.path(), &|_| false).kept_boots, 0);
}
