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

fn scenarios() -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/turn-change-store/scenarios.json");
    serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).unwrap()
}

fn scenario(name: &str) -> Value {
    scenarios().into_iter().find(|s| s["name"] == name).unwrap_or_else(|| panic!("no recorded scenario {name}"))
}

fn changes_dir(data: &Path) -> PathBuf {
    data.join("turn-snapshots").join("changes")
}

fn zero_stamps(record: &mut Value) {
    for key in ["createdAt", "updatedAt"] {
        if let Some(slot) = record.get_mut(key) {
            *slot = json!(0);
        }
    }
}

/// The file's lines with their timestamps zeroed, in the key order they were written.
fn lines_of(text: &str) -> Vec<String> {
    text.split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| {
            let mut value: Value = serde_json::from_str(line).unwrap();
            match value.get_mut("records").and_then(Value::as_array_mut) {
                Some(records) => records.iter_mut().for_each(zero_stamps),
                None => zero_stamps(&mut value["put"]),
            }
            value.to_string()
        })
        .collect()
}

fn normalised(records: &[Value]) -> Vec<String> {
    records
        .iter()
        .cloned()
        .map(|mut record| {
            zero_stamps(&mut record);
            record.to_string()
        })
        .collect()
}

async fn read_back(store: &Store, session: &str) -> Vec<Value> {
    store.load_turn_change_records(session).await.iter().map(|r| Value::Object((**r).clone())).collect()
}

async fn run(store: &Store, session: &str, op: &Value) {
    match op["op"].as_str().unwrap() {
        "upsert" => {
            store.upsert_turn_change_record(session, op["next"].as_object().unwrap()).await.unwrap();
        }
        "update" => {
            let (path, state) = (op["path"].as_str().unwrap().to_owned(), op["state"].as_str().unwrap().to_owned());
            store
                .update_turn_change_record(session, op["checkpointId"].as_str().unwrap(), move |prior| {
                    let files = prior["files"].as_array().unwrap();
                    Some(
                        files
                            .iter()
                            .map(|file| {
                                let mut file = file.as_object().unwrap().clone();
                                if file["path"] == path.as_str() {
                                    file.insert("state".into(), Value::String(state.clone()));
                                }
                                file
                            })
                            .collect(),
                    )
                })
                .await
                .unwrap();
        }
        other => panic!("unknown op {other}"),
    }
}

async fn replay(store: &Store, data: &Path, scenario: &Value) {
    let session = scenario["sessionId"].as_str().unwrap();
    let hash = scenario["hash"].as_str().unwrap();
    let (jsonl, legacy) = (changes_dir(data).join(format!("{hash}.jsonl")), changes_dir(data).join(format!("{hash}.json")));
    let mut previous: Option<String> = None;
    for (n, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
        run(store, session, &step["op"]).await;
        let text = std::fs::read_to_string(&jsonl).unwrap_or_default();
        assert_eq!(lines_of(&text), lines_of(step["jsonl"].as_str().unwrap_or("")), "step {n}: the changes file");
        assert_eq!(legacy.exists(), step["json"].is_string(), "step {n}: the previous format's file");
        assert_eq!(normalised(&read_back(store, session).await), normalised(step["records"].as_array().unwrap()), "step {n}: the records a read answers");
        assert_eq!(store.count_turn_change_records(session).await as u64, step["count"].as_u64().unwrap(), "step {n}: the turn count");
        // The core's own bytes: a later write only adds to what an earlier one left.
        if let Some(previous) = &previous
            && text.lines().count() > previous.lines().count()
        {
            assert!(text.starts_with(previous.as_str()), "step {n}: a write rewrote the file");
        }
        previous = Some(text);
    }
}

/// An upsert appends its one line (never rewrites the file), and every line is Node's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upsert_appends_a_line_as_node_does() {
    let data = tempfile::tempdir().unwrap();
    replay(&store_in(data.path()), data.path(), &scenario("append")).await;
}

/// A fresh core reads the file a core (or Node) wrote: no cache to lean on.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_new_process_reads_what_the_last_one_wrote() {
    let scenario = scenario("append");
    let data = tempfile::tempdir().unwrap();
    replay(&store_in(data.path()), data.path(), &scenario).await;
    let last = scenario["steps"].as_array().unwrap().last().unwrap().clone();
    let fresh = store_in(data.path());
    assert_eq!(normalised(&read_back(&fresh, scenario["sessionId"].as_str().unwrap()).await), normalised(last["records"].as_array().unwrap()));
}

/// The previous format's `.json` is read as it is, and the first write migrates it into the `.jsonl` and removes it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_previous_format_file_is_read_and_migrated_as_node_does() {
    let scenario = scenario("legacy");
    let data = tempfile::tempdir().unwrap();
    let hash = scenario["hash"].as_str().unwrap();
    std::fs::create_dir_all(changes_dir(data.path())).unwrap();
    std::fs::write(changes_dir(data.path()).join(format!("{hash}.json")), scenario["before"]["json"].as_str().unwrap()).unwrap();
    let store = store_in(data.path());
    let session = scenario["sessionId"].as_str().unwrap();
    assert_eq!(normalised(&read_back(&store, session).await), normalised(scenario["before"]["records"].as_array().unwrap()));
    assert_eq!(store.count_turn_change_records(session).await as u64, scenario["before"]["count"].as_u64().unwrap());
    replay(&store, data.path(), &scenario).await;
}

/// A line that does not parse (damage in the middle, a torn tail) is skipped; every other turn is still read.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_damaged_line_is_skipped() {
    let scenario = scenario("append");
    let last = scenario["steps"].as_array().unwrap().last().unwrap();
    let intact = last["jsonl"].as_str().unwrap();
    let mut lines: Vec<&str> = intact.split('\n').collect();
    lines.insert(2, "{\"put\":{\"checkpointId\":\"cp-9\",\"fil");
    let damaged = format!("{}\n{{\"put\":", lines.join("\n"));
    let data = tempfile::tempdir().unwrap();
    let hash = scenario["hash"].as_str().unwrap();
    std::fs::create_dir_all(changes_dir(data.path())).unwrap();
    std::fs::write(changes_dir(data.path()).join(format!("{hash}.jsonl")), damaged).unwrap();
    let store = store_in(data.path());
    let session = scenario["sessionId"].as_str().unwrap();
    assert_eq!(normalised(&read_back(&store, session).await), normalised(last["records"].as_array().unwrap()));
    // The next upsert lands after the damage and is read back with the rest.
    let more = json!({"checkpointId": "cp-after", "kind": "git", "root": "/work/repo", "files": [{"path": "z.txt"}]});
    store.upsert_turn_change_record(session, more.as_object().unwrap()).await.unwrap();
    let ids: Vec<String> = read_back(&store, session).await.iter().map(|r| r["checkpointId"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids, ["cp-1", "cp-2", "cp-after"]);
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
