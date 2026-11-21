//! The launcher's process lifecycle ledger: the files a run leaves (an active marker per running process, an append-only ledger kept
//! to 64 KiB), what an end records, how markers of runs that never finished are found and reported, and how the identity of a
//! process is refined after the start. Time, the process table and the timers are scripted; nothing here starts a process.
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "the test lays out folders and files and reads what the ledger left on disk")]

use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_launch::lifecycle::LifecycleConfig;
use mixdog_launch::lifecycle::ProcessLifecycle;
use mixdog_launch::lifecycle::host::Host;
use mixdog_launch::lifecycle::identity::start_seconds;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// 2026-11-14T03:04:05.678Z.
const T0: i64 = 1_794_625_445_678;
const T0_ISO: &str = "2026-11-14T03:04:05.678Z";
const PARENT: u32 = 4242;
const DEAD: u32 = 2_147_483_000;
const LEGACY_DEAD: u32 = 2_147_482_999;
const MAX_BYTES: usize = 64 * 1024;

type Job = Box<dyn FnOnce() + Send>;

/// A machine whose clock, process table and timers the test scripts.
struct ScriptedHost {
    mono: AtomicU64,
    /// Pids that exist, besides this process.
    existing: Vec<u32>,
    /// What `identity_of` answers per pid, in turn; the last answer is the one that stays.
    identities: Mutex<HashMap<u32, VecDeque<Option<Value>>>>,
    jobs: Mutex<VecDeque<Job>>,
    delays: Mutex<Vec<Duration>>,
}

impl ScriptedHost {
    fn new(existing: &[u32], identities: &[(u32, Vec<Option<Value>>)]) -> Arc<Self> {
        Arc::new(Self {
            mono: AtomicU64::new(1_000_000),
            existing: existing.to_vec(),
            identities: Mutex::new(identities.iter().map(|(pid, answers)| (*pid, answers.iter().cloned().collect())).collect()),
            jobs: Mutex::new(VecDeque::new()),
            delays: Mutex::new(Vec::new()),
        })
    }

    /// A host where this process's identity is known from the start (no refinement is scheduled) and the parent's is another start time.
    fn settled(existing: &[u32]) -> Arc<Self> {
        Self::new(existing, &[(std::process::id(), vec![Some(start_seconds(1_700_000_000, "powershell"))]), (PARENT, vec![Some(start_seconds(7, "ps"))])])
    }

    /// Runs the scheduled jobs, in order, until none is left (a job may schedule another).
    fn run_jobs(&self) {
        loop {
            let next = self.jobs.lock().unwrap_or_else(PoisonError::into_inner).pop_front();
            match next {
                Some(job) => job(),
                None => return,
            }
        }
    }

    fn delays(&self) -> Vec<Duration> {
        self.delays.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }
}

impl Host for ScriptedHost {
    fn now_ms(&self) -> i64 {
        T0
    }

    fn monotonic_ns(&self) -> u128 {
        u128::from(self.mono.fetch_add(1, Ordering::SeqCst))
    }

    fn identity_of(&self, pid: u32) -> Option<Value> {
        let mut identities = self.identities.lock().unwrap_or_else(PoisonError::into_inner);
        let answers = identities.get_mut(&pid)?;
        if answers.len() > 1 { answers.pop_front().flatten() } else { answers.front().cloned().flatten() }
    }

    fn process_exists(&self, pid: u32) -> bool {
        pid == std::process::id() || self.existing.contains(&pid)
    }

    fn parent_pid(&self) -> Option<u32> {
        Some(PARENT)
    }

    fn cwd(&self) -> Option<String> {
        Some(current_dir())
    }

    fn memory(&self) -> Map<String, Value> {
        let mut counters = Map::new();
        counters.insert("rss".to_owned(), 1.into());
        counters
    }

    fn schedule(&self, delay: Duration, job: Job) {
        self.delays.lock().unwrap_or_else(PoisonError::into_inner).push(delay);
        self.jobs.lock().unwrap_or_else(PoisonError::into_inner).push_back(job);
    }
}

fn current_dir() -> String {
    std::env::current_dir().unwrap().to_string_lossy().into_owned()
}

fn begin(dir: &Path, host: &Arc<ScriptedHost>) -> ProcessLifecycle {
    ProcessLifecycle::begin(LifecycleConfig { directory: Some(dir.to_owned()), host: host.clone() })
}

fn read_lines(file: &Path) -> Option<Vec<Value>> {
    let text = std::fs::read_to_string(file).ok()?;
    Some(text.lines().filter(|line| !line.is_empty()).map(|line| serde_json::from_str(line).expect("a ledger line is JSON")).collect())
}

fn previous_of(run: &ProcessLifecycle) -> PathBuf {
    let mut name = run.ledger_path().unwrap().as_os_str().to_owned();
    name.push(".1");
    name.into()
}

/// What the ledger records, the retained generation first: `(pid, reason, exit code)` of each line that has a reason (a seed has none).
fn ledger(run: &ProcessLifecycle) -> Vec<(u64, String, Option<i64>)> {
    let lines = read_lines(&previous_of(run)).unwrap_or_default().into_iter().chain(read_lines(run.ledger_path().unwrap()).unwrap_or_default());
    lines
        .filter(|entry| entry.get("reason").is_some())
        .map(|entry| (entry["pid"].as_u64().unwrap(), entry["reason"].as_str().unwrap().to_owned(), entry["exitCode"].as_i64()))
        .collect()
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        std::fs::read_dir(dir).map(|entries| entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    names.sort();
    names
}

fn is_own_marker(name: &str) -> bool {
    name.starts_with(&format!("{}-", std::process::id())) && name.ends_with(".json")
}

fn seed_ledger_file(file: &Path, bytes: usize) {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let (head, tail) = ("{\"seed\":true,\"pad\":\"", "\"}\n");
    std::fs::write(file, format!("{head}{}{tail}", "p".repeat(bytes - head.len() - tail.len()))).unwrap();
}

/// A marker left by a run that never finished: of process `pid`, started at `identity`.
fn seed_marker(file: &Path, pid: u32, identity: &Value) {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let marker = json!({ "version": 1, "timestamp": "2026-01-01T00:00:00.000Z", "pid": pid, "ppid": 5, "token": "seed", "processIdentity": identity });
    std::fs::write(file, format!("{marker}\n")).unwrap();
}

#[test]
fn an_identity_the_os_does_not_give_is_asked_again_after_one_nine_and_twenty_seconds() {
    let temp = tempfile::tempdir().unwrap();
    let host = ScriptedHost::new(&[], &[(std::process::id(), vec![None, None, None, Some(start_seconds(1_700_000_000, "ps"))])]);
    let run = begin(&temp.path().join("diagnostics"), &host);
    host.run_jobs();
    assert_eq!(host.delays(), vec![Duration::from_millis(1000), Duration::from_millis(9000), Duration::from_millis(20_000)]);
    // The third attempt answered: the marker holds the OS's start time now.
    let marker: Value = serde_json::from_slice(&std::fs::read(run.marker_path().unwrap()).unwrap()).unwrap();
    assert_eq!(marker["processIdentity"], start_seconds(1_700_000_000, "ps"));
    assert!(run.finish("clean-shutdown", 0).recorded);
}

#[test]
fn an_identity_that_is_settled_at_the_start_is_never_asked_again() {
    let temp = tempfile::tempdir().unwrap();
    let host = ScriptedHost::settled(&[]);
    let run = begin(&temp.path().join("diagnostics"), &host);
    assert!(host.delays().is_empty());
    assert!(run.finish("clean-shutdown", 0).recorded);
}

#[test]
fn a_run_leaves_a_marker_and_a_start_line_and_ends_with_the_strongest_reason_it_met() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("diagnostics");
    let host = ScriptedHost::settled(&[]);
    let run = begin(&dir, &host);
    let me = u64::from(std::process::id());

    assert_eq!(names_in(&dir), ["process-lifecycle.active", "process-lifecycle.jsonl"]);
    let markers = names_in(run.marker_dir().unwrap());
    assert_eq!(markers.len(), 1);
    assert!(is_own_marker(&markers[0]), "{markers:?}");
    let marker: Value = serde_json::from_slice(&std::fs::read(run.marker_path().unwrap()).unwrap()).unwrap();
    assert_eq!(
        (marker["version"].clone(), marker["pid"].as_u64(), marker["ppid"].as_u64(), marker["timestamp"].as_str()),
        (json!(1), Some(me), Some(u64::from(PARENT)), Some(T0_ISO))
    );
    assert_eq!(marker["processIdentity"], start_seconds(1_700_000_000, "powershell"));
    assert!(marker["token"].as_str().is_some_and(|token| token.split_once('-').is_some_and(|(at, tick)| !at.is_empty() && !tick.is_empty())), "{marker}");

    let started = read_lines(run.ledger_path().unwrap()).unwrap();
    assert_eq!(started.len(), 1);
    assert_eq!(
        (
            started[0]["reason"].as_str(),
            started[0]["exitCode"].clone(),
            started[0]["pid"].as_u64(),
            started[0]["cwd"].as_str(),
            started[0]["memory"]["rss"].as_i64()
        ),
        (Some("process-start"), Value::Null, Some(me), Some(current_dir().as_str()), Some(1))
    );

    // A fatal error that was caught is recorded at once; the end then carries it rather than the clean shutdown that follows.
    assert!(run.record_catchable_fatal(7));
    let finished = run.finish("clean-shutdown", 0);
    assert!(finished.recorded);
    assert_eq!((finished.reason.as_str(), finished.exit_code), ("catchable-fatal-error", Some(7)));
    assert_eq!(
        ledger(&run),
        [(me, "process-start".to_owned(), None), (me, "catchable-fatal-error".to_owned(), Some(7)), (me, "catchable-fatal-error".to_owned(), Some(7))]
    );
    assert!(names_in(run.marker_dir().unwrap()).is_empty(), "the marker goes with the run");
    assert!(!run.is_active());
}

#[tokio::test(flavor = "current_thread")]
async fn an_end_records_the_reason_and_the_exit_code_the_run_earned() {
    let me = u64::from(std::process::id());
    let entry = |reason: &str, code: Option<i64>| (me, reason.to_owned(), code);
    let start = || entry("process-start", None);
    // (what happens, the ledger it leaves).
    let cases: Vec<(&str, Option<i32>, (&str, i32), bool, Vec<(u64, String, Option<i64>)>)> = vec![
        (
            "a fatal error then a clean end: the fatal is the end",
            Some(7),
            ("clean-shutdown", 0),
            false,
            vec![start(), entry("catchable-fatal-error", Some(7)), entry("catchable-fatal-error", Some(7))],
        ),
        (
            "a fatal error then a forced cleanup: the forced cleanup is stronger",
            Some(7),
            ("forced-cleanup", 9),
            false,
            vec![start(), entry("catchable-fatal-error", Some(7)), entry("forced-cleanup", Some(9))],
        ),
        ("a reason nobody knows is a clean shutdown with its code", None, ("bogus", 3), false, vec![start(), entry("clean-shutdown", Some(3))]),
        ("process-start is a reason an end may carry", None, ("process-start", 4), false, vec![start(), entry("process-start", Some(4))]),
        ("a clean end", None, ("clean-shutdown", 0), false, vec![start(), entry("clean-shutdown", Some(0))]),
        ("an end that waits for the ledger's lock", None, ("catchable-fatal-error", 2), true, vec![start(), entry("catchable-fatal-error", Some(2))]),
        (
            "a clean end that waits for the lock, after a fatal error",
            Some(5),
            ("clean-shutdown", 0),
            true,
            vec![start(), entry("catchable-fatal-error", Some(5)), entry("catchable-fatal-error", Some(5))],
        ),
    ];
    for (name, fatal, (reason, code), waits, expected) in cases {
        let temp = tempfile::tempdir().unwrap();
        let run = begin(&temp.path().join("diagnostics"), &ScriptedHost::settled(&[]));
        if let Some(fatal) = fatal {
            assert!(run.record_catchable_fatal(fatal), "{name}");
        }
        let finished = if waits { run.finish_async(reason, code).await } else { run.finish(reason, code) };
        assert!(finished.recorded, "{name}");
        assert_eq!(ledger(&run), expected, "{name}");
        assert!(names_in(run.marker_dir().unwrap()).is_empty(), "{name}: the marker is gone");
        assert!(!run.is_active(), "{name}");
    }
}

#[test]
fn once_a_run_is_over_a_second_end_and_a_late_fatal_error_are_refused() {
    let me = u64::from(std::process::id());
    let temp = tempfile::tempdir().unwrap();
    let run = begin(&temp.path().join("diagnostics"), &ScriptedHost::settled(&[]));
    assert!(run.finish("clean-shutdown", 0).recorded);
    assert!(!run.finish("forced-cleanup", 1).recorded);
    assert!(!run.record_catchable_fatal(1));
    assert_eq!(ledger(&run), [(me, "process-start".to_owned(), None), (me, "clean-shutdown".to_owned(), Some(0))]);
}

#[test]
fn a_start_reports_and_removes_the_markers_of_processes_that_are_gone_and_keeps_every_other_file() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("diagnostics");
    let active = dir.join("process-lifecycle.active");
    let me = std::process::id();
    let long_ago = start_seconds(1_700_000_000, "powershell");
    // A marker whose process is gone, one of this pid from an earlier run, one whose pid now names a process that started at another
    // time, the single-marker file an older layout used, and one whose process still runs with the start time it recorded.
    seed_marker(&active.join("dead-tok.json"), DEAD, &long_ago);
    seed_marker(&active.join("self-old.json"), me, &long_ago);
    seed_marker(&active.join("parent-reused.json"), PARENT, &start_seconds(1, "powershell"));
    seed_marker(&dir.join("process-lifecycle.active.json"), LEGACY_DEAD, &long_ago);
    seed_marker(&active.join("alive.json"), 5151, &start_seconds(9, "ps"));
    std::fs::write(active.join("junk.json"), "this is not json").unwrap();
    std::fs::write(active.join("notes.txt"), "not a marker either").unwrap();

    let host = ScriptedHost::new(
        &[PARENT, 5151],
        &[(me, vec![Some(long_ago.clone())]), (PARENT, vec![Some(start_seconds(7, "ps"))]), (5151, vec![Some(start_seconds(9, "ps"))])],
    );
    let run = begin(&dir, &host);
    // The start is recorded before any marker is reported; reporting is a job of its own.
    assert_eq!(ledger(&run), [(u64::from(me), "process-start".to_owned(), None)]);
    host.run_jobs();
    let while_running = names_in(&active);
    assert_eq!(while_running.iter().filter(|name| is_own_marker(name)).count(), 1);
    let kept: Vec<&str> = while_running.iter().map(String::as_str).filter(|name| !is_own_marker(name)).collect();
    assert_eq!(kept, ["alive.json", "junk.json", "notes.txt"], "only the markers of gone processes are removed");
    assert!(!dir.join("process-lifecycle.active.json").exists(), "the single-marker file is removed too");

    assert!(run.finish("clean-shutdown", 0).recorded);
    let mut entries = ledger(&run);
    assert_eq!(entries.remove(0), (u64::from(me), "process-start".to_owned(), None));
    entries.sort();
    let vanished = |pid: u32| (u64::from(pid), "prior-process-vanished".to_owned(), None);
    let mut expected = vec![vanished(DEAD), vanished(LEGACY_DEAD), vanished(PARENT), vanished(me), (u64::from(me), "clean-shutdown".to_owned(), Some(0))];
    expected.sort();
    assert_eq!(entries, expected);
    assert_eq!(names_in(&active), ["alive.json", "junk.json", "notes.txt"]);
}

#[test]
fn the_ledger_never_grows_past_its_cap_and_keeps_the_previous_generation_whole_or_empty() {
    // (what the folder holds before the run, the ledger's bytes, the retained generation's bytes, the markers of gone processes).
    let cases: [(&str, usize, Option<usize>, usize); 5] = [
        ("a ledger at the cap rotates into the retained generation", MAX_BYTES - 10, None, 0),
        ("a ledger with room is appended to", 1000, None, 0),
        ("a ledger already over the cap leaves an empty generation, not its bytes", MAX_BYTES + 5000, None, 0),
        ("a retained generation over the cap is emptied", 1000, Some(MAX_BYTES + 5000), 0),
        ("reports of gone processes into a nearly full ledger rotate it and are all kept", MAX_BYTES - 450, None, 2),
    ];
    for (name, ledger_bytes, previous_bytes, gone) in cases {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("diagnostics");
        seed_ledger_file(&dir.join("process-lifecycle.jsonl"), ledger_bytes);
        if let Some(bytes) = previous_bytes {
            seed_ledger_file(&dir.join("process-lifecycle.jsonl.1"), bytes);
        }
        if gone >= 1 {
            seed_marker(&dir.join("process-lifecycle.active").join("dead-0.json"), DEAD, &start_seconds(1_700_000_000, "powershell"));
        }
        if gone >= 2 {
            seed_marker(&dir.join("process-lifecycle.active.json"), LEGACY_DEAD, &start_seconds(1_700_000_000, "powershell"));
        }
        let host = ScriptedHost::settled(&[]);
        let run = begin(&dir, &host);
        host.run_jobs();
        run.record_catchable_fatal(1);
        assert!(run.finish("clean-shutdown", 0).recorded, "{name}");

        let size = |file: &Path| std::fs::metadata(file).ok().map(|meta| meta.len() as usize);
        assert!(size(run.ledger_path().unwrap()).unwrap() <= MAX_BYTES, "{name}: the ledger is within its cap");
        let seeds = |file: &Path| read_lines(file).unwrap_or_default().iter().filter(|entry| entry["seed"] == true).count();
        let (in_ledger, in_previous) = (seeds(run.ledger_path().unwrap()), seeds(&previous_of(&run)));
        let previous = size(&previous_of(&run));
        let reasons: Vec<String> = ledger(&run).into_iter().map(|(_, reason, _)| reason).collect();
        let expect = |reason: &str, count: usize| assert_eq!(reasons.iter().filter(|r| *r == reason).count(), count, "{name}: {reasons:?}");
        expect("process-start", 1);
        expect("catchable-fatal-error", 2);
        expect("prior-process-vanished", gone);
        assert_eq!(reasons[0], "process-start", "{name}: the start comes first");
        match ledger_bytes {
            n if n == MAX_BYTES - 10 || n == MAX_BYTES - 450 => {
                assert_eq!((in_ledger, in_previous), (0, 1), "{name}: the full ledger became the retained generation whole")
            }
            1000 if previous_bytes.is_none() => assert_eq!((in_ledger, in_previous, previous), (1, 0, None), "{name}"),
            1000 => assert_eq!((in_ledger, previous), (1, Some(0)), "{name}"),
            _ => assert_eq!((in_ledger, in_previous, previous), (0, 0, Some(0)), "{name}"),
        }
    }
}
