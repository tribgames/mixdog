//! The quota-resume store against the Node recording (`fixtures/ai-admin/quota-resume-twin.json`):
//! every operation's answer, the notifications it raised and the exact bytes of the file
//! afterwards, over sequences from a clean directory and over files Node did not write itself.

use std::sync::{Arc, Mutex};

use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

use crate::support::on_lane;
use crate::quota_resume::{Entry, QUOTA_RESUME_FILE, QuotaError, QuotaResumeStore, is_agent_only_session};

fn twin() -> Value {
    serde_json::from_str(mixdog_testkit::fixture!("../../fixtures/ai-admin/quota-resume-twin.json")).unwrap()
}

fn generation(args: &Value) -> Option<u64> {
    args.get("generation").and_then(Value::as_u64)
}

fn answer(result: Result<Value, QuotaError>) -> Value {
    match result {
        Ok(value) => json!({ "value": value }),
        Err(QuotaError::Type(message)) => json!({ "error": format!("TypeError: {message}") }),
        Err(other) => panic!("{other}"),
    }
}

async fn run(store: &QuotaResumeStore, op: &str, args: &Value) -> Result<Value, QuotaError> {
    let id = args["sessionId"].as_str().unwrap_or_default();
    let text = |key: &str| args[key].as_str().unwrap_or_default().to_owned();
    let entry = |e: Option<Entry>| e.map_or(Value::Null, |e| e.to_value());
    Ok(match op {
        "schedule" => store.schedule(args).await?.to_value(),
        "cancel" => json!(store.cancel(id, generation(args)).await?),
        "defer" => entry(store.defer(id, generation(args), args).await?),
        "cancelAll" => json!(store.cancel_all().await?),
        "noteGoal" => json!(store.note_suspended_goal(id, &text("turnKey"), &text("goalId")).await?),
        "forgetGoal" => json!(store.forget_suspended_goal(id).await?),
        "goal" => json!(store.suspended_goal(id, &text("turnKey"))),
        "rekey" => json!(store.rekey_turn(id, &text("from"), &text("to")).await?),
        "entry" => entry(store.entry(id)),
        "list" => Value::Array(store.list().iter().map(Entry::to_value).collect()),
        "public" => store.entry(id).map_or(Value::Null, |e| e.public()),
        "restart" => {
            store.reload().await?;
            Value::Null
        }
        other => panic!("{other}"),
    })
}

/// Recorded cases per test: each opens its own store file.
const CASE_CHUNK: usize = 10;

mixdog_rt::replay_chunks!(STORE_TESTS, #[tokio::test] async the_store_chunk; [
    the_store_matches_node_00 = 0,
    the_store_matches_node_01 = 1,
    the_store_matches_node_02 = 2,
    the_store_matches_node_03 = 3,
    the_store_matches_node_04 = 4,
    the_store_matches_node_05 = 5,
    the_store_matches_node_06 = 6,
    the_store_matches_node_07 = 7,
    the_store_matches_node_08 = 8,
    the_store_matches_node_09 = 9,
    the_store_matches_node_10 = 10,
    the_store_matches_node_11 = 11,
    the_store_matches_node_12 = 12,
    the_store_matches_node_13 = 13,
    the_store_matches_node_14 = 14,
    the_store_matches_node_15 = 15,
    the_store_matches_node_16 = 16,
    the_store_matches_node_17 = 17,
    the_store_matches_node_18 = 18,
    the_store_matches_node_19 = 19,
    the_store_matches_node_20 = 20,
    the_store_matches_node_21 = 21,
]);

#[test]
fn every_recorded_case_has_its_store_test() {
    mixdog_rt::testing::assert_chunks_registered(STORE_TESTS, twin()["cases"].as_array().unwrap().len(), CASE_CHUNK);
}

async fn the_store_chunk(chunk: usize) {
    let twin = twin();
    let cases = twin["cases"].as_array().unwrap();
    for case in &cases[mixdog_rt::testing::chunk_range(cases.len(), chunk, CASE_CHUNK)] {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(QUOTA_RESUME_FILE);
        let mut last = case["preFile"].as_str().map(str::to_owned);
        if let Some(text) = &last {
            let (path, bytes) = (file.clone(), text.clone().into_bytes());
            on_lane(mixdog_rt::testing::tokens().durability_io, &CancellationToken::new(), move |lane| {
                mixdog_statefile::append_file(lane, &path, &bytes)
            })
            .await
            .unwrap()
            .unwrap();
        }
        let store = QuotaResumeStore::open(dir.path(), mixdog_rt::testing::tokens().durability_io, CancellationToken::new()).await.unwrap();
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let _subscription = store.subscribe({
            let events = events.clone();
            move |id| events.lock().unwrap().push(id.map_or(Value::Null, Value::from))
        });
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let op = step["op"].as_str().unwrap();
            events.lock().unwrap().clear();
            let got = answer(run(&store, op, &step["args"]).await);
            let want = match step.get("error") {
                Some(error) => json!({ "error": error }),
                None => json!({ "value": step["value"] }),
            };
            let label = format!("{name}, step {i}: {op} {}", step["args"]);
            assert_eq!(got, want, "{label}");
            assert_eq!(Value::Array(events.lock().unwrap().clone()), step["events"], "{label} notifications");
            if op == "entry" {
                // The warm gate pauses a session exactly when Node's `quotaResumeEntry` is truthy.
                let id = step["args"]["sessionId"].as_str().unwrap_or_default();
                assert_eq!(mixdog_ai::warmer::gate::QuotaResumes::paused(&store, id), !step["value"].is_null(), "{label} paused");
            }
            if let Some(text) = step.get("file") {
                last = text.as_str().map(str::to_owned);
            }
            let path = file.clone();
            let on_disk = on_lane(mixdog_rt::testing::tokens().durability_io, &CancellationToken::new(), move |_| mixdog_statefile::read_content(&path))
                .await
                .unwrap()
                .unwrap()
                .map(|bytes| String::from_utf8(bytes).unwrap());
            assert_eq!(on_disk, last, "{label} file");
        }
    }
}

/// Node commits and notifies in one synchronous step, so the listeners hear of change A before
/// change B can commit. Here the changes are issued from many tasks at once: the notifications
/// must come in commit (generation) order, and a listener that reads the store while it is told
/// must see the state of the change it is told about.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_changes_notify_in_commit_order_and_each_listener_sees_its_own_state() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(QuotaResumeStore::open(dir.path(), mixdog_rt::testing::tokens().durability_io, CancellationToken::new()).await.unwrap());
    let heard = Arc::new(Mutex::new(Vec::<(String, Option<u64>)>::new()));
    let _subscription = store.subscribe({
        let (store, heard) = (store.clone(), heard.clone());
        move |id| {
            let id = id.expect("a schedule names its session").to_owned();
            let generation = store.entry(&id).map(|e| e.generation);
            heard.lock().unwrap().push((id, generation));
        }
    });
    let tasks: Vec<_> = (0..32)
        .map(|i| {
            let store = store.clone();
            tokio::spawn(async move {
                store.schedule(&json!({ "sessionId": format!("sess_{i}"), "turnKey": "turn:t", "provider": "p", "resetAt": 1 })).await.unwrap()
            })
        })
        .collect();
    let mut committed = Vec::new();
    for task in tasks {
        committed.push(task.await.unwrap());
    }
    let heard = heard.lock().unwrap().clone();
    assert_eq!(heard.len(), 32);
    let generations: Vec<u64> = heard.iter().map(|(_, g)| g.expect("the entry is there when it is announced")).collect();
    assert!(generations.windows(2).all(|w| w[0] < w[1]), "commit order: {generations:?}");
    for (id, generation) in &heard {
        let own = committed.iter().find(|e| e.session_id == *id).unwrap();
        assert_eq!(*generation, Some(own.generation), "{id} saw another change's state");
    }
}

#[test]
fn agent_children_never_own_a_resume() {
    for case in twin()["agentOnly"].as_array().unwrap() {
        assert_eq!(is_agent_only_session(&case["session"]), case["agentOnly"] == json!(true), "{}", case["session"]);
    }
}
