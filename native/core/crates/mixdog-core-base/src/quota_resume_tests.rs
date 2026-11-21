//! The quota-resume store under concurrent changes.

use std::sync::{Arc, Mutex};

use mixdog_rt::CancellationToken;
use serde_json::json;

use crate::quota_resume::QuotaResumeStore;

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
