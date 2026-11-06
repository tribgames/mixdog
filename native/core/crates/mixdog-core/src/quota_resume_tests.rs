//! The quota-resume store against the Node recording (`fixtures/ai-admin/quota-resume-twin.json`):
//! every operation's answer, the notifications it raised and the exact bytes of the file
//! afterwards, over sequences from a clean directory and over files Node did not write itself.

use std::sync::{Arc, Mutex};

use mixdog_rt::CancellationToken;
use serde_json::{Value, json};

use crate::quota_resume::{Entry, QUOTA_RESUME_FILE, QuotaError, QuotaResumeStore, is_agent_only_session};

fn twin() -> Value {
    serde_json::from_str(include_str!("../../../fixtures/ai-admin/quota-resume-twin.json")).unwrap()
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

#[tokio::test]
async fn the_store_matches_node() {
    for case in twin()["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(QUOTA_RESUME_FILE);
        let mut last = case["preFile"].as_str().map(str::to_owned);
        if let Some(text) = &last {
            std::fs::write(&file, text).unwrap();
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
            if let Some(text) = step.get("file") {
                last = text.as_str().map(str::to_owned);
            }
            assert_eq!(std::fs::read_to_string(&file).ok(), last, "{label} file");
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
