//! The per-turn change-record file against Node's recording of it (`fixtures/turn-change-store`): the lines a run of
//! upserts and updates leaves in `changes/<hash>.jsonl`, the records a read answers, and a previous-format
//! `changes/<hash>.json` read as it is and migrated by the first write. Timestamps are the one normalised field (the
//! recording counts `Date.now`; a core stamps real time).
#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup: real directories")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use serde_json::json;

use super::disk::LaneDisk;
use super::ports::ReviewDisk;
use super::store::Store;

fn store_in(data: &Path) -> Store {
    let disk: Arc<dyn ReviewDisk> = Arc::new(LaneDisk::new(mixdog_rt::testing::tokens()));
    Store::new(disk, data)
}

fn changes_dir(data: &Path) -> PathBuf {
    data.join("turn-snapshots").join("changes")
}




async fn read_back(store: &Store, session: &str) -> Vec<Value> {
    store.load_turn_change_records(session).await.iter().map(|r| Value::Object((**r).clone())).collect()
}


fn big(checkpoint: &str, patch_bytes: usize, tag: &str) -> Value {
    json!({"checkpointId": checkpoint, "kind": "git", "root": "/work/repo", "files": [{"path": "big.txt", "patch": format!("{tag}{}", "x".repeat(patch_bytes))}]})
}

/// Superseded bytes are not rewritten away until they outgrow the live ones (and a floor): the third upsert of one
/// turn's 600 KB finds 1.2 MB dead against 600 KB live and compacts the file to one line; the fourth appends again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn superseded_bytes_are_compacted_once_they_outgrow_the_live_ones() {
    let data = tempfile::tempdir().unwrap();
    let store = store_in(data.path());
    let lines = |_: ()| {
        let dir = changes_dir(data.path());
        let name = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).find(|n| n.ends_with(".jsonl")).unwrap();
        std::fs::read_to_string(dir.join(name)).unwrap().lines().count()
    };
    for (n, expected) in [(0, 1), (1, 2), (2, 1), (3, 2)] {
        store.upsert_turn_change_record("compact", big("cp", 600 * 1024, &n.to_string()).as_object().unwrap()).await.unwrap();
        assert_eq!(lines(()), expected, "after upsert {n}");
    }
    let records = read_back(&store, "compact").await;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["revision"], 4);
    assert!(records[0]["files"][0]["patch"].as_str().unwrap().starts_with('3'));
}

/// A session past its 32 MB budget drops its oldest turns, in the line that stores the newest: `evict` names them, and a
/// reader of the file (the core after a restart, or Node) drops them too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upsert_over_the_budget_appends_its_evictions() {
    let data = tempfile::tempdir().unwrap();
    let store = store_in(data.path());
    for id in ["cp-1", "cp-2", "cp-3"] {
        store.upsert_turn_change_record("budget", big(id, 12 * 1024 * 1024, id).as_object().unwrap()).await.unwrap();
    }
    let ids = |records: Vec<Value>| records.iter().map(|r| r["checkpointId"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(ids(read_back(&store, "budget").await), ["cp-2", "cp-3"]);
    let file = std::fs::read_dir(changes_dir(data.path())).unwrap().next().unwrap().unwrap().path();
    let text = std::fs::read_to_string(file).unwrap();
    assert_eq!(text.lines().count(), 3, "the third upsert is an appended line");
    assert!(text.lines().last().unwrap().ends_with("\"evict\":[\"cp-1\"]}"));
    assert_eq!(ids(read_back(&store_in(data.path()), "budget").await), ["cp-2", "cp-3"]);
}

fn turn(checkpoint: &str) -> Value {
    json!({"checkpointId": checkpoint, "kind": "git", "root": "/work/repo", "files": [{"path": "a.txt"}]})
}

fn store_with_faults(data: &Path) -> (Store, Arc<LaneDisk>) {
    let disk = Arc::new(LaneDisk::new(mixdog_rt::testing::tokens()));
    (Store::new(disk.clone(), data), disk)
}

fn ids_of(records: &[Value]) -> Vec<String> {
    records.iter().map(|r| r["checkpointId"].as_str().unwrap().to_owned()).collect()
}

/// A session's lock is waited for as long as Node waits for it (`timeoutMs: 30_000` of `changesExclusive`).
#[test]
fn the_changes_lock_is_waited_for_as_long_as_node_waits() {
    assert_eq!(super::store::CHANGES_LOCK_WAIT, std::time::Duration::from_millis(30_000));
}

/// An upsert whose line the file does not show whole (a write cut short that reported success) fails, and the bytes it left
/// are cut away: the file is what it was, a later upsert lands cleanly, and no read ever applies the half line.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upsert_whose_line_the_file_does_not_show_whole_fails_and_leaves_nothing_of_it() {
    let data = tempfile::tempdir().unwrap();
    let (store, disk) = store_with_faults(data.path());
    let jsonl = || {
        let name = std::fs::read_dir(changes_dir(data.path())).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).find(|n| n.ends_with(".jsonl")).unwrap();
        changes_dir(data.path()).join(name)
    };
    store.upsert_turn_change_record("short", turn("one").as_object().unwrap()).await.unwrap();
    let before = std::fs::read(jsonl()).unwrap();
    disk.faults.short_append.store(true, std::sync::atomic::Ordering::SeqCst);
    let error = store.upsert_turn_change_record("short", turn("two").as_object().unwrap()).await.unwrap_err();
    assert!(error.to_string().contains("not written whole"), "{error}");
    assert_eq!(std::fs::read(jsonl()).unwrap(), before, "the half line is cut away");
    assert_eq!(ids_of(&read_back(&store, "short").await), ["one"], "the upsert is not stored");
    disk.faults.short_append.store(false, std::sync::atomic::Ordering::SeqCst);
    store.upsert_turn_change_record("short", turn("three").as_object().unwrap()).await.unwrap();
    assert_eq!(ids_of(&read_back(&store_in(data.path()), "short").await), ["one", "three"]);
}

const CHILD_DATA: &str = "MIXDOG_REVIEW_CHANGES_CHILD_DATA";

/// The child of the two-process test: one upsert of `MIXDOG_REVIEW_CHANGES_CHILD_TURN` into the parent's data directory, waiting
/// for the session's lock at most `MIXDOG_REVIEW_CHANGES_CHILD_WAIT_MS` when given; its outcome is printed as `upsert-result`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changes_child() {
    let Ok(data) = std::env::var(CHILD_DATA) else { return };
    let (store, disk) = store_with_faults(Path::new(&data));
    if let Ok(ms) = std::env::var("MIXDOG_REVIEW_CHANGES_CHILD_WAIT_MS") {
        *disk.faults.lock_wait_cap.lock().unwrap() = Some(std::time::Duration::from_millis(ms.parse().unwrap()));
    }
    let session = std::env::var("MIXDOG_REVIEW_CHANGES_CHILD_SESSION").unwrap();
    let checkpoint = std::env::var("MIXDOG_REVIEW_CHANGES_CHILD_TURN").unwrap();
    let outcome = match store.upsert_turn_change_record(&session, turn(&checkpoint).as_object().unwrap()).await {
        Ok(_) => "stored".to_owned(),
        Err(error) => format!("refused {error}"),
    };
    println!("upsert-result {outcome}");
}

/// One upsert by another process over `data`: its `upsert-result`. The child is killed at the deadline.
fn upsert_in_another_process(data: &Path, session: &str, checkpoint: &str, wait_ms: Option<&str>) -> String {
    const DEADLINE: std::time::Duration = std::time::Duration::from_secs(60);
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "turn_review::store_tests::changes_child", "--nocapture", "--test-threads=1"])
        .env(CHILD_DATA, data)
        .env("MIXDOG_REVIEW_CHANGES_CHILD_SESSION", session)
        .env("MIXDOG_REVIEW_CHANGES_CHILD_TURN", checkpoint)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(ms) = wait_ms {
        command.env("MIXDOG_REVIEW_CHANGES_CHILD_WAIT_MS", ms);
    }
    let running = command.spawn().unwrap();
    let pid = running.id();
    let (done, waited) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = done.send(running.wait_with_output());
    });
    let output = match waited.recv_timeout(DEADLINE) {
        Ok(output) => output.unwrap(),
        Err(_) => {
            let killed = std::process::Command::new(if cfg!(windows) { "taskkill" } else { "kill" })
                .args(if cfg!(windows) { vec!["/PID".to_owned(), pid.to_string(), "/T".into(), "/F".into()] } else { vec!["-9".to_owned(), pid.to_string()] })
                .output();
            panic!("timed out after {DEADLINE:?} awaiting the child test (pid {pid}, killed: {:?})", killed.map(|o| o.status));
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    // libtest prints the test's name and then, on the same line, what the test printed.
    stdout
        .lines()
        .find_map(|line| line.split_once("upsert-result ").map(|(_, result)| result.to_owned()))
        .unwrap_or_else(|| panic!("the child printed no upsert-result (status {:?}):\n{stdout}\n{}", output.status, String::from_utf8_lossy(&output.stderr)))
}


/// Two processes write one session's file under its lock and lose no record. This process stops inside its write, holding the lock, as a writer slow on its disk does; a real second process that tries the lock
/// then gives up and stores nothing (it would otherwise write at once, and this process's rewrite from what it read before would
/// take the record away); once this one is done, the same upsert of the second process lands beside the rest.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_processes_writing_one_sessions_file_lose_no_record() {
    use std::sync::Mutex;
    use std::sync::mpsc::channel;

    let session = "shared";
    let data = tempfile::tempdir().unwrap();
    store_in(data.path()).upsert_turn_change_record(session, turn("earlier").as_object().unwrap()).await.unwrap();
    let old = vec!["earlier".to_owned()];

    let (store, disk) = store_with_faults(data.path());
    let (inside, entered) = channel::<()>();
    let (go, released) = channel::<()>();
    let (inside, released) = (Mutex::new(inside), Mutex::new(released));
    *disk.faults.before_write.lock().unwrap() = Some(Arc::new(move || {
        inside.lock().unwrap().send(()).unwrap();
        released.lock().unwrap().recv().unwrap();
    }));
    let store = Arc::new(store);
    let first = tokio::spawn({
        let (store, session) = (store.clone(), session.to_owned());
        async move { store.upsert_turn_change_record(&session, turn("from-parent").as_object().unwrap()).await }
    });
    entered.recv_timeout(std::time::Duration::from_secs(60)).expect("this process's write stopped inside the lock");

    let refused = upsert_in_another_process(data.path(), session, "from-child", Some("300"));
    assert!(refused.starts_with("refused") && refused.contains("timeout"), "the other process took the lock this one holds: {refused}");

    go.send(()).unwrap();
    first.await.unwrap().unwrap();
    assert_eq!(upsert_in_another_process(data.path(), session, "from-child", None), "stored");
    let mut want: Vec<String> = old.into_iter().chain(["from-parent".to_owned(), "from-child".to_owned()]).collect();
    want.sort();
    let mut got = ids_of(&read_back(&store_in(data.path()), session).await);
    got.sort();
    assert_eq!(got, want);
}

fn jsonl_of(data: &Path) -> PathBuf {
    let name = std::fs::read_dir(changes_dir(data)).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).find(|n| n.ends_with(".jsonl")).unwrap();
    changes_dir(data).join(name)
}

/// An upsert appends its one line and never rewrites the file; a fresh store reads what the last one wrote.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upsert_appends_a_line_and_a_new_store_reads_what_the_last_one_wrote() {
    let data = tempfile::tempdir().unwrap();
    let store = store_in(data.path());
    store.upsert_turn_change_record("s", turn("cp-1").as_object().unwrap()).await.unwrap();
    let first = std::fs::read_to_string(jsonl_of(data.path())).unwrap();
    store.upsert_turn_change_record("s", turn("cp-2").as_object().unwrap()).await.unwrap();
    let second = std::fs::read_to_string(jsonl_of(data.path())).unwrap();
    assert_eq!(second.lines().count(), 2);
    assert!(second.starts_with(&first), "the first line is untouched");
    assert_eq!(store.count_turn_change_records("s").await, 2);
    assert_eq!(ids_of(&read_back(&store_in(data.path()), "s").await), ["cp-1", "cp-2"]);
}

/// The previous format's `.json` is read as it is, and the first write moves it into the `.jsonl` and removes it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_previous_format_file_is_read_and_migrated_by_the_first_write() {
    let data = tempfile::tempdir().unwrap();
    let probe = tempfile::tempdir().unwrap();
    let writer = store_in(probe.path());
    writer.upsert_turn_change_record("s", turn("old-1").as_object().unwrap()).await.unwrap();
    writer.upsert_turn_change_record("s", turn("old-2").as_object().unwrap()).await.unwrap();
    let document = writer.changes_document("s").await.unwrap();
    let hash = jsonl_of(probe.path()).file_stem().unwrap().to_string_lossy().into_owned();

    std::fs::create_dir_all(changes_dir(data.path())).unwrap();
    let legacy = changes_dir(data.path()).join(format!("{hash}.json"));
    std::fs::write(&legacy, document).unwrap();
    let store = store_in(data.path());
    assert_eq!(ids_of(&read_back(&store, "s").await), ["old-1", "old-2"]);
    assert_eq!(store.count_turn_change_records("s").await, 2);

    store.upsert_turn_change_record("s", turn("new").as_object().unwrap()).await.unwrap();
    assert!(!legacy.exists(), "the previous format's file is gone");
    assert_eq!(ids_of(&read_back(&store_in(data.path()), "s").await), ["old-1", "old-2", "new"]);
}

/// A line that does not parse (damage in the middle, a torn tail) is skipped; every other turn is still read.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_damaged_line_is_skipped_and_the_next_upsert_lands_after_it() {
    let data = tempfile::tempdir().unwrap();
    let store = store_in(data.path());
    store.upsert_turn_change_record("s", turn("cp-1").as_object().unwrap()).await.unwrap();
    store.upsert_turn_change_record("s", turn("cp-2").as_object().unwrap()).await.unwrap();
    let file = jsonl_of(data.path());
    let mut lines: Vec<String> = std::fs::read_to_string(&file).unwrap().lines().map(str::to_owned).collect();
    lines.insert(1, "{\"put\":{\"checkpointId\":\"cp-9\",\"fil".to_owned());
    std::fs::write(&file, format!("{}\n{{\"put\":", lines.join("\n"))).unwrap();

    let reader = store_in(data.path());
    assert_eq!(ids_of(&read_back(&reader, "s").await), ["cp-1", "cp-2"]);
    reader.upsert_turn_change_record("s", turn("cp-after").as_object().unwrap()).await.unwrap();
    assert_eq!(ids_of(&read_back(&reader, "s").await), ["cp-1", "cp-2", "cp-after"]);
}
