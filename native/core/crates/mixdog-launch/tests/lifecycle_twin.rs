//! The launcher's process lifecycle ledger against Node's (`tests/goldens/lifecycle.json`, recorded by
//! `tests/recorders/record-lifecycle.mjs` from `src/runtime/shared/process-lifecycle.mjs`): the files a scripted run leaves, with
//! pids, tokens, times and memory counters normalised the way the recorder normalises them. Time, the process table and the
//! timers are scripted; nothing here starts a process.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the test lays out folders, threads and files and reads what the ledger left on disk"
)]

use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use mixdog_launch::lifecycle::LifecycleConfig;
use mixdog_launch::lifecycle::ProcessLifecycle;
use mixdog_launch::lifecycle::host::Host;
use mixdog_launch::lifecycle::host::OsHost;
use mixdog_launch::lifecycle::identity::start_seconds;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// `Date.UTC(2026, 10, 14, 3, 4, 5, 678)`.
const T0: i64 = 1_794_625_445_678;
const PARENT: u32 = 4242;
const DEAD: u32 = 2_147_483_000;
const LEGACY_DEAD: u32 = 2_147_482_999;
const MAX_BYTES: usize = 64 * 1024;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("tests/goldens/lifecycle.json")).expect("golden")
}

type Job = Box<dyn FnOnce() + Send>;

/// A machine whose clock, process table and timers the test scripts.
struct ScriptedHost {
    mono: AtomicU64,
    /// Pids that exist, besides this process.
    existing: Vec<u32>,
    /// What `identity_of` answers per pid, in turn; the last answer is the one that stays.
    identities: Mutex<HashMap<u32, VecDeque<Option<Value>>>>,
    jobs: Mutex<VecDeque<(Duration, Job)>>,
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

    /// A host where this process's identity is known from the start: no upgrade is scheduled.
    fn settled(existing: &[u32]) -> Arc<Self> {
        let me = std::process::id();
        let mut identities = vec![(me, vec![Some(start_seconds(1_700_000_000, "powershell"))])];
        identities.push((PARENT, vec![Some(start_seconds(7, "ps"))]));
        Self::new(existing, &identities)
    }

    /// Runs the scheduled jobs, in order, until none is left (a job may schedule another).
    fn run_jobs(&self) {
        loop {
            let next = self.jobs.lock().unwrap_or_else(PoisonError::into_inner).pop_front();
            match next {
                Some((_, job)) => job(),
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
        self.jobs.lock().unwrap_or_else(PoisonError::into_inner).push_back((delay, job));
    }
}

fn current_dir() -> String {
    std::env::current_dir().unwrap().to_string_lossy().into_owned()
}

fn begin(dir: &Path, host: &Arc<ScriptedHost>) -> ProcessLifecycle {
    ProcessLifecycle::begin(LifecycleConfig { directory: Some(dir.to_owned()), host: host.clone() })
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The recorder's normalisation

fn label_of(pid: u64) -> String {
    match pid {
        pid if pid == u64::from(std::process::id()) => "self".to_owned(),
        pid if pid == u64::from(PARENT) => "parent".to_owned(),
        pid if pid == u64::from(DEAD) => "dead".to_owned(),
        pid if pid == u64::from(LEGACY_DEAD) => "legacy".to_owned(),
        pid => pid.to_string(),
    }
}

/// `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`.
fn is_iso(text: &str) -> bool {
    let shape = b"dddd-dd-ddTdd:dd:dd.dddZ";
    text.len() == shape.len() && text.bytes().zip(shape).all(|(byte, expected)| if *expected == b'd' { byte.is_ascii_digit() } else { byte == *expected })
}

fn kind_of(value: Option<&Value>) -> &'static str {
    match value {
        None => "absent",
        Some(Value::Null) => "null",
        Some(Value::Number(_)) => "number",
        Some(_) => "other",
    }
}

fn normalize_entry(entry: &Value) -> Value {
    let memory = match entry.get("memory") {
        None => "absent",
        Some(memory) if memory.get("rss").is_some_and(Value::is_number) => "rss",
        Some(_) => "empty",
    };
    let cwd = match entry.get("cwd").and_then(Value::as_str) {
        None => "absent".to_owned(),
        Some(cwd) if cwd == current_dir() => "<cwd>".to_owned(),
        Some(cwd) => cwd.to_owned(),
    };
    json!({
        "version": entry["version"],
        "timestamp": entry["timestamp"].as_str().is_some_and(is_iso),
        "pid": label_of(entry["pid"].as_u64().unwrap()),
        "ppid": kind_of(entry.get("ppid")),
        "reason": entry["reason"],
        "exitCode": entry["exitCode"],
        "memory": memory,
        "cwd": cwd,
    })
}

fn normalize_identity(identity: Option<&Value>) -> Value {
    let Some(identity) = identity.filter(|identity| !identity.is_null()) else { return json!("absent") };
    let method = match identity.get("method").and_then(Value::as_str) {
        None => "absent",
        Some("uptime") => "uptime",
        Some(_) => "os",
    };
    let value = identity.get("value").and_then(Value::as_i64).filter(|seconds| *seconds > 0).map_or("bad", |_| "seconds");
    json!({ "kind": identity["kind"], "method": method, "value": value })
}

fn read_lines(file: &Path) -> Option<Vec<Value>> {
    let text = std::fs::read_to_string(file).ok()?;
    Some(text.lines().filter(|line| !line.is_empty()).map(|line| serde_json::from_str(line).expect("a ledger line is JSON")).collect())
}

fn previous_of(run: &ProcessLifecycle) -> std::path::PathBuf {
    let mut name = run.ledger_path().unwrap().as_os_str().to_owned();
    name.push(".1");
    name.into()
}

/// The ledger as normalised entries: the retained generation first, then the current file; lines without a reason (a seed) left out.
fn ledger_entries(run: &ProcessLifecycle) -> Vec<Value> {
    let lines = read_lines(&previous_of(run)).unwrap_or_default().into_iter().chain(read_lines(run.ledger_path().unwrap()).unwrap_or_default());
    lines.filter(|entry| entry.get("reason").is_some()).map(|entry| normalize_entry(&entry)).collect()
}

fn marker_name(name: &str) -> String {
    if name.starts_with(&format!("{}-", std::process::id())) && name.ends_with(".json") { "self-<token>.json".to_owned() } else { name.to_owned() }
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir).map(|entries| entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    names.sort();
    names
}

fn marker_files(run: &ProcessLifecycle) -> Vec<String> {
    names_in(run.marker_dir().unwrap()).iter().map(|name| marker_name(name)).collect()
}

fn own_marker(run: &ProcessLifecycle) -> Value {
    let marker: Value = serde_json::from_slice(&std::fs::read(run.marker_path().unwrap()).unwrap()).unwrap();
    let token = marker["token"].as_str().unwrap();
    let token_shape = token.split_once('-').is_some_and(|(a, b)| [a, b].iter().all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase())));
    json!({
        "version": marker["version"],
        "timestamp": marker["timestamp"].as_str().is_some_and(is_iso),
        "pid": label_of(marker["pid"].as_u64().unwrap()),
        "ppid": kind_of(marker.get("ppid")),
        "token": token_shape,
        "processIdentity": normalize_identity(marker.get("processIdentity")),
    })
}

fn seed_ledger_file(file: &Path, bytes: usize) {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let (head, tail) = ("{\"seed\":true,\"pad\":\"", "\"}\n");
    std::fs::write(file, format!("{head}{}{tail}", "p".repeat(bytes - head.len() - tail.len()))).unwrap();
}

fn seed_marker(dir: &Path, spec: &Value) {
    let pid = match spec["pid"].as_str().unwrap() {
        "self" => std::process::id(),
        "parent" => PARENT,
        "dead" => DEAD,
        "legacy" => LEGACY_DEAD,
        other => panic!("a seed for {other}"),
    };
    let file = if spec["legacy"].as_bool() == Some(true) {
        dir.join("process-lifecycle.active.json")
    } else {
        dir.join("process-lifecycle.active").join(spec["file"].as_str().unwrap())
    };
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    if let Some(raw) = spec["raw"].as_str() {
        std::fs::write(&file, raw).unwrap();
        return;
    }
    let identity = if spec["identity"] == "own" { start_seconds(1, "powershell") } else { start_seconds(1_700_000_000, "powershell") };
    let marker = json!({ "version": 1, "timestamp": "2026-01-01T00:00:00.000Z", "pid": pid, "ppid": 5, "token": spec["token"], "processIdentity": identity });
    std::fs::write(&file, format!("{marker}\n")).unwrap();
}

fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "darwin"
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------

#[test]
fn a_run_leaves_the_files_and_the_identity_upgrade_node_leaves() {
    let golden = golden();
    let golden = &golden["run"];
    // Linux reads the start time from /proc at the start and has no estimate to upgrade: its recording is another shape.
    if golden["platform"] != platform() || cfg!(target_os = "linux") {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("diagnostics");
    let me = std::process::id();
    let host = ScriptedHost::new(&[], &[(me, vec![None, Some(start_seconds(1_700_000_000, "powershell"))])]);
    let run = begin(&dir, &host);
    let after_begin = json!({ "files": names_in(&dir), "markers": marker_files(&run), "marker": own_marker(&run), "ledger": ledger_entries(&run) });
    assert_eq!(after_begin, golden["afterBegin"]);
    // The estimate is replaced at the first attempt; there is no second.
    assert_eq!(host.delays(), vec![Duration::from_millis(1000)]);
    host.run_jobs();
    assert_eq!(json!({ "marker": own_marker(&run) }), golden["afterUpgrade"]);
    assert_eq!(host.delays(), vec![Duration::from_millis(1000)]);
    let fatal = run.record_catchable_fatal(7);
    let finish = run.finish("clean-shutdown", 0);
    let end = json!({ "files": names_in(&dir), "markers": marker_files(&run), "ledger": ledger_entries(&run) });
    assert_eq!((json!(fatal), json!(finish.recorded)), (golden["fatal"].clone(), golden["finish"].clone()));
    assert_eq!(end, golden["end"]);
}

#[test]
fn an_identity_the_os_does_not_give_is_asked_again_after_nine_and_twenty_seconds() {
    let temp = tempfile::tempdir().unwrap();
    let me = std::process::id();
    let host = ScriptedHost::new(&[], &[(me, vec![None, None, None, Some(start_seconds(1_700_000_000, "ps"))])]);
    let run = begin(&temp.path().join("diagnostics"), &host);
    host.run_jobs();
    assert_eq!(host.delays(), vec![Duration::from_millis(1000), Duration::from_millis(9000), Duration::from_millis(20_000)]);
    // The third attempt answered: the marker holds the OS's start time now.
    let marker: Value = serde_json::from_slice(&std::fs::read(run.marker_path().unwrap()).unwrap()).unwrap();
    assert_eq!(marker["processIdentity"], start_seconds(1_700_000_000, "ps"));
    assert!(run.finish("clean-shutdown", 0).recorded);
}

#[test]
fn a_run_whose_identity_is_known_at_the_start_schedules_nothing() {
    let temp = tempfile::tempdir().unwrap();
    let host = ScriptedHost::settled(&[]);
    let run = begin(&temp.path().join("diagnostics"), &host);
    assert!(host.delays().is_empty());
    assert!(run.finish("clean-shutdown", 0).recorded);
}

#[tokio::test(flavor = "current_thread")]
async fn the_reason_and_the_exit_code_an_end_carries_are_nodes() {
    let golden = golden();
    // (name, the fatal's exit code, the finish's reason and code, whether it is the async finish, whether to finish again after).
    let cases: [(&str, Option<i32>, (&str, i32), bool, bool); 7] = [
        ("fatal then clean", Some(7), ("clean-shutdown", 0), false, false),
        ("fatal then forced", Some(7), ("forced-cleanup", 9), false, false),
        ("unknown reason", None, ("bogus", 3), false, false),
        ("process-start as the reason", None, ("process-start", 4), false, false),
        ("clean", None, ("clean-shutdown", 0), false, true),
        ("async fatal", None, ("catchable-fatal-error", 2), true, false),
        ("async clean after fatal", Some(5), ("clean-shutdown", 0), true, false),
    ];
    let expected = golden["finish"].as_array().unwrap();
    assert_eq!(expected.len(), cases.len());
    for ((name, fatal, (reason, code), is_async, again), expected) in cases.iter().zip(expected) {
        let temp = tempfile::tempdir().unwrap();
        let host = ScriptedHost::settled(&[]);
        let run = begin(&temp.path().join("diagnostics"), &host);
        let mut result = Map::new();
        result.insert("name".to_owned(), json!(name));
        if let Some(fatal) = fatal {
            result.insert("fatal".to_owned(), json!(run.record_catchable_fatal(*fatal)));
        }
        let finished = if *is_async { run.finish_async(reason, *code).await } else { run.finish(reason, *code) };
        result.insert("finish".to_owned(), json!(finished.recorded));
        if *again {
            result.insert("finishAgain".to_owned(), json!(run.finish("forced-cleanup", 1).recorded));
            result.insert("fatalAfter".to_owned(), json!(run.record_catchable_fatal(1)));
        }
        result.insert("markers".to_owned(), json!(marker_files(&run)));
        result.insert("ledger".to_owned(), json!(ledger_entries(&run)));
        assert_eq!(Value::Object(result), *expected, "{name}");
        assert!(!run.is_active(), "{name}");
    }
}

#[test]
fn a_start_reaps_the_markers_of_processes_that_are_gone_and_only_those() {
    let golden = golden();
    let golden = &golden["stale"];
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("diagnostics");
    for spec in golden["seeds"].as_array().unwrap() {
        seed_marker(&dir, spec);
    }
    // The parent is alive with another start time than its marker says; the others are gone.
    let host = ScriptedHost::settled(&[PARENT]);
    let run = begin(&dir, &host);
    // The start is recorded before any marker is reported, and the reporting is a job of its own.
    assert_eq!(ledger_entries(&run).len(), 1);
    host.run_jobs();
    let while_running = marker_files(&run);
    let legacy_left = dir.join("process-lifecycle.active.json").exists();
    let finish = run.finish("clean-shutdown", 0);
    let entries = ledger_entries(&run);
    let first = entries[0].clone();
    let mut rest: Vec<Value> = entries[1..].to_vec();
    rest.sort_by_key(|entry| format!("{}:{}", entry["pid"].as_str().unwrap(), entry["reason"].as_str().unwrap()));
    assert_eq!(first, golden["first"]);
    assert_eq!(Value::Array(rest), golden["rest"]);
    assert_eq!(json!(while_running), golden["markersWhileRunning"]);
    assert_eq!(json!(legacy_left), golden["legacyLeft"]);
    assert_eq!(json!(finish.recorded), golden["finish"]);
    assert_eq!(json!(marker_files(&run)), golden["markersAfter"]);
}

#[test]
fn the_ledger_keeps_to_its_cap_whatever_it_started_with() {
    let golden = golden();
    // (name, the seeded ledger's bytes, the seeded retained generation's bytes, the markers seeded).
    let cases: [(&str, usize, Option<usize>, &[&str]); 5] = [
        ("ledger at the cap", MAX_BYTES - 10, None, &[]),
        ("ledger with room", 1000, None, &[]),
        ("ledger oversized", MAX_BYTES + 5000, None, &[]),
        ("retained generation oversized", 1000, Some(MAX_BYTES + 5000), &[]),
        ("vanished markers into a nearly full ledger", MAX_BYTES - 450, None, &["dead", "legacy"]),
    ];
    let expected = golden["cap"].as_array().unwrap();
    assert_eq!(expected.len(), cases.len());
    for ((name, ledger, previous, seeds), expected) in cases.iter().zip(expected) {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path().join("diagnostics");
        seed_ledger_file(&dir.join("process-lifecycle.jsonl"), *ledger);
        if let Some(previous) = previous {
            seed_ledger_file(&dir.join("process-lifecycle.jsonl.1"), *previous);
        }
        for (index, label) in seeds.iter().enumerate() {
            let spec = if *label == "legacy" {
                json!({ "legacy": true, "pid": "legacy", "token": "legacy", "identity": "dead" })
            } else {
                json!({ "file": format!("{label}-{index}.json"), "pid": label, "token": format!("t{index}"), "identity": "dead" })
            };
            seed_marker(&dir, &spec);
        }
        let host = ScriptedHost::settled(&[]);
        let run = begin(&dir, &host);
        host.run_jobs();
        run.record_catchable_fatal(1);
        assert!(run.finish("clean-shutdown", 0).recorded, "{name}");
        let entries = ledger_entries(&run);
        let size = |file: &Path| std::fs::metadata(file).ok().map(|meta| meta.len() as usize);
        let previous_state = match size(&previous_of(&run)) {
            None => json!(null),
            Some(0) => json!(0),
            Some(bytes) if bytes <= MAX_BYTES => json!("within"),
            Some(_) => json!("over"),
        };
        let seed_lines = |file: &Path| read_lines(file).unwrap_or_default().iter().filter(|entry| entry["seed"] == true).count();
        let mut reasons: Vec<String> = entries.iter().map(|entry| format!("{}:{}", entry["pid"].as_str().unwrap(), entry["reason"].as_str().unwrap())).collect();
        reasons.sort();
        let actual = json!({
            "name": name,
            "sizes": {
                "ledgerWithinCap": size(run.ledger_path().unwrap()).unwrap_or(0) <= MAX_BYTES,
                "previous": previous_state,
            },
            "seedInLedger": seed_lines(run.ledger_path().unwrap()),
            "seedInPrevious": seed_lines(&previous_of(&run)),
            "reasons": reasons,
            "first": entries[0]["reason"],
        });
        assert_eq!(actual, *expected, "{name}");
    }
}

/// Against the real clock, process table and parent lookup: the files of a run on this machine. Not run by default.
#[test]
#[ignore = "reads the operating system's process table and memory counters"]
fn live_lifecycle_run_on_the_operating_system() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().join("diagnostics");
    let run = ProcessLifecycle::begin(LifecycleConfig { directory: Some(dir.clone()), host: Arc::new(OsHost) });
    let marker: Value = serde_json::from_slice(&std::fs::read(run.marker_path().unwrap()).unwrap()).unwrap();
    assert_eq!(marker["pid"], std::process::id());
    assert!(marker["ppid"].is_number(), "the parent is known");
    assert!(marker["processIdentity"].is_object(), "the OS gives this process's identity");
    assert!(marker["processIdentity"]["method"] != "uptime", "and it is not an estimate");
    let started = read_lines(run.ledger_path().unwrap()).unwrap();
    assert_eq!(started.len(), 1);
    assert!(started[0]["memory"]["rss"].is_number(), "the OS gives the working set");
    assert!(run.finish("clean-shutdown", 0).recorded);
    assert!(!run.marker_path().unwrap().exists());
    assert_eq!(read_lines(run.ledger_path().unwrap()).unwrap().len(), 2);
}
