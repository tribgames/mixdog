//! The launcher's crash capture against Node's (`tests/goldens/crash-capture.json`, recorded by
//! `tests/recorders/record-crash-capture.mjs` from `packages/protocol-client/src/launch/crash-capture`): the paths, a boot's
//! sidecar after every step of a script on a scripted clock, the launcher's log and the failure summary, and what retention
//! answers and leaves. Nothing here starts a process.
#![allow(
    clippy::disallowed_methods,
    clippy::disallowed_types,
    reason = "the test lays out folders and reads what the capture left on disk"
)]

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
/// `Date.UTC(2026, 10, 14, 3, 4, 5, 678)`.
const T0: i64 = 1_794_625_445_678;
/// `Date.UTC(2026, 10, 13, 12)`, in seconds: what the recorder's ages are counted back from.
const RETENTION_BASE_SECS: u64 = 1_794_571_200;

fn golden() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("tests/goldens/crash-capture.json")).expect("golden")
}

fn slash(text: &str) -> String {
    text.replace('\\', "/")
}

#[test]
fn the_capture_directory_is_the_one_node_names() {
    for case in golden()["paths"].as_array().unwrap() {
        let given = &case["given"];
        let (capture, data) = match given["dataDir"].as_str() {
            Some(data) => (slash(&capture_dir(Path::new(data)).to_string_lossy()), None),
            None => {
                let env = given["env"].as_object().unwrap().clone();
                let lookup = move |name: &str| env.get(name).and_then(Value::as_str).map(std::ffi::OsString::from);
                let data = data_dir_of(&lookup, None).expect("a data folder");
                (slash(&capture_dir(&data).to_string_lossy()), Some(slash(&data.to_string_lossy())))
            }
        };
        assert_eq!(json!(capture), case["captureDir"], "{given}");
        assert_eq!(data.map_or(Value::Null, Value::from), case["dataDir"], "{given}");
    }
}

/// `summarizeLog`: a long log as its length, head and tail.
fn summarize_log(log: &[String]) -> Value {
    if log.len() <= 12 {
        return json!(log);
    }
    json!({ "count": log.len(), "head": &log[..3], "tail": &log[log.len() - 2..] })
}

fn sidecar_of(capture: Option<&SpawnCapture>) -> Value {
    let Some(path) = capture.and_then(SpawnCapture::record_path) else { return Value::Null };
    std::fs::read(&path).ok().map_or(Value::Null, |bytes| serde_json::from_slice(&bytes).expect("sidecar json"))
}

fn files_of(dir: &Path) -> Value {
    let mut names: Vec<String> = std::fs::read_dir(dir).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    json!(names)
}

fn summary_value(capture: &SpawnCapture) -> Value {
    let summary = capture.summary();
    json!({
        "pid": summary.pid,
        "ready": summary.ready,
        "spawnedAt": summary.spawned_at,
        "exitedAt": summary.exited_at,
        "exitCode": summary.exit_code,
        "exitSignal": summary.exit_signal,
        "exitReason": summary.exit_reason,
        "uptimeMs": summary.uptime_ms,
        "error": summary.error,
        "stderrErrorLine": summary.stderr_error_line,
        "stderrLastLine": summary.stderr_last_line,
        "stderrPath": summary.stderr_path.and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned())),
    })
}

/// What the golden says a script did with the capture, replayed step by step.
fn replay_sidecars(script: &Value) {
    let name = script["name"].as_str().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let norm = |text: &str| slash(&text.replace(dir.path().to_string_lossy().as_ref(), "<dir>"));
    let clock = Arc::new(AtomicI64::new(T0));
    let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let mut capture: Option<SpawnCapture> = None;
    for (index, step) in script["steps"].as_array().unwrap().iter().enumerate() {
        let at = format!("{name} step {index} ({})", step["op"]);
        match step["op"].as_str().unwrap() {
            "begin" => {
                let mut options = CaptureOptions::new("core");
                let sink = log.clone();
                options.log = Arc::new(move |line| sink.lock().unwrap().push(line.to_owned()));
                options.dir = Some(dir.path().to_path_buf());
                options.launcher_pid = LAUNCHER_PID;
                let now = clock.clone();
                options.now = Arc::new(move || now.load(Ordering::SeqCst));
                options.prune = false;
                options.nonce = Arc::new(|| "c0de".to_owned());
                let begun = SpawnCapture::begin(options);
                assert_eq!(json!(begun.stem()), step["stem"], "{at}");
                capture = Some(begun);
            }
            "clock" => clock.store(step["ms"].as_i64().unwrap(), Ordering::SeqCst),
            "stderr" => {
                let capture_path = capture.as_ref().unwrap().capture_path();
                if let Some(path) = capture_path {
                    let text = step["text"].as_str().unwrap().repeat(step["repeat"].as_u64().unwrap_or(1) as usize);
                    let mut file = std::fs::OpenOptions::new().append(true).open(path).unwrap();
                    std::io::Write::write_all(&mut file, text.as_bytes()).unwrap();
                }
            }
            "track" => capture.as_ref().unwrap().track(Some(step["pid"].as_u64().unwrap() as u32), step["detached"].as_bool().unwrap(), None),
            "ready" => capture.as_ref().unwrap().note_ready(),
            "exit" => capture.as_ref().unwrap().note_exit(step["code"].as_i64(), step["signal"].as_str()),
            "spawnError" => capture.as_ref().unwrap().note_spawn_error(step["message"].as_str().unwrap()),
            "coreWrites" => {
                let path = capture.as_ref().unwrap().record_path().unwrap();
                let mut record = sidecar_of(capture.as_ref());
                for (key, value) in step["patch"].as_object().unwrap() {
                    record[key] = value.clone();
                }
                std::fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
            }
            "summary" => assert_eq!(summary_value(capture.as_ref().unwrap()), step["summary"], "{at}"),
            other => panic!("unknown step {other}"),
        }
        assert_eq!(sidecar_of(capture.as_ref()), step["record"], "{at}: the sidecar");
        assert_eq!(files_of(dir.path()), step["files"], "{at}: the files");
    }
    let lines: Vec<String> = log.lock().unwrap().iter().map(|line| norm(line)).collect();
    assert_eq!(summarize_log(&lines), script["log"], "{name}: the launcher's log");
}

#[test]
fn a_boots_sidecar_log_and_summary_are_what_node_records() {
    let golden = golden();
    let scripts = golden["sidecars"].as_array().unwrap();
    assert!(scripts.len() > 20);
    for script in scripts {
        replay_sidecars(script);
    }
}

fn lay_out(dir: &Path, case: &Value) {
    let stamp = |path: PathBuf, age_secs: u64| {
        let at = SystemTime::UNIX_EPOCH + Duration::from_secs(RETENTION_BASE_SECS - age_secs);
        std::fs::File::options().write(true).open(path).unwrap().set_modified(at).unwrap();
    };
    for boot in case["boots"].as_array().unwrap() {
        let stem = boot["stem"].as_str().unwrap();
        let age = boot["ageSec"].as_u64().unwrap();
        let raw = dir.join(format!("{stem}.err.log"));
        std::fs::write(&raw, vec![b'x'; boot["raw"].as_u64().unwrap() as usize]).unwrap();
        stamp(raw, age);
        if !boot["record"].is_null() {
            let sidecar = dir.join(format!("{stem}.json"));
            let text = match boot["record"].as_str() {
                Some(text) => text.to_owned(),
                None => boot["record"].to_string(),
            };
            std::fs::write(&sidecar, text).unwrap();
            stamp(sidecar, age);
        }
    }
    for extra in case["extras"].as_array().unwrap() {
        std::fs::write(dir.join(extra["name"].as_str().unwrap()), vec![b'e'; extra["bytes"].as_u64().unwrap() as usize]).unwrap();
    }
}

#[test]
fn retention_answers_and_leaves_what_node_does() {
    for case in golden()["retention"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        lay_out(dir.path(), case);
        let alive: Vec<u32> = case["alive"].as_array().unwrap().iter().map(|pid| pid.as_u64().unwrap() as u32).collect();
        let pruned = prune_crash_captures(dir.path(), &|pid| alive.contains(&pid));
        let expected = &case["result"];
        assert_eq!(
            json!({
                "removed": pruned.removed,
                "trimmed": pruned.trimmed,
                "keptBoots": pruned.kept_boots,
                "keptBytes": pruned.kept_bytes,
                "activeBoots": pruned.active_boots,
                "unknownBoots": pruned.unknown_boots,
            }),
            *expected,
            "{name}: the answer"
        );
        let mut names: Vec<String> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        let remaining: Vec<Value> = names
            .iter()
            .map(|file| {
                let path = dir.path().join(file);
                let head = std::fs::read(&path).ok().filter(|_| file.ends_with(".err.log")).map(|bytes| String::from_utf8_lossy(&bytes[..bytes.len().min(60)]).into_owned());
                let head = head.and_then(|text| text.split('\n').next().map(str::to_owned)).filter(|line| line.starts_with("[capture trimmed"));
                json!({ "name": file, "size": std::fs::metadata(&path).unwrap().len(), "head": head })
            })
            .collect();
        assert_eq!(json!(remaining), case["remaining"], "{name}: what is left");
    }
}
