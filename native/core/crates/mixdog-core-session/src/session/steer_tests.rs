//! `turn/steer` against `fixtures/capability-refusals/golden.json`, recorded by `record-capability-refusals.mjs` from Node's
//! real `prioritizeQueued` (`session-flow/queue.mjs`): Node goes by queue membership alone, whether a turn runs or not — an entry
//! that is not queued answers a count of none, a queued one a count of one. The core answers the same whether the thread runs a
//! turn, runs none, or runs another than the one the caller expected: `queuedEntryNotFound` for a count of none, accepted for one.

use std::collections::HashSet;
use std::sync::Arc;

use mixdog_core_api::CoreError;
use mixdog_core_api::RunControl;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::TurnId;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::tests::eventually_on;
use super::tests::idle;
use super::tests::start_thread;
use super::tests::turn;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/capability-refusals/golden.json")).expect("golden.json")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_steer_goes_by_queue_membership_as_nodes_prioritize_does() {
    let golden = golden();
    let cases = golden["prioritize"].as_array().expect("prioritize");
    assert!(cases.iter().any(|case| case["busy"] == true) && cases.iter().any(|case| case["busy"] == false));
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let busy = case["busy"] == true;
        let rig = Rig::new();
        let release: Arc<tokio::sync::Notify> = Arc::default();
        let gate = release.clone();
        rig.set_script(Arc::new(move |run| {
            let gate = gate.clone();
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                gate.notified().await;
                RunOutcome::Completed(Default::default())
            })
        }));
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        let mut expected: Vec<Option<TurnId>> = vec![None, Some(TurnId::from("another-turn"))];
        if busy {
            turn(&handle, "work", "op-turn").await;
            eventually_on(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
            expected.push(handle.active_turn());
        }
        let selected = case["selectedId"].as_str().expect("selectedId");
        let queued: HashSet<String> = case["queued"].as_array().expect("queued").iter().map(|id| id.as_str().expect("id").to_owned()).collect();
        for expected in &expected {
            // The projection the actor publishes, set as the recorded queue holds it. The actor republishes its own (empty) queue on
            // every step it takes, so a step landing between the store and the call is run again; the recorded count is never retried.
            let mut got;
            let mut tries = 0;
            loop {
                handle.cell.queued.store(Arc::new(queued.clone()));
                got = handle.steer(expected.as_ref(), json!({ "queuedId": selected }), OpId::from("op-steer"));
                tries += 1;
                if tries >= 50 || !queued.contains(selected) || got.is_ok() {
                    break;
                }
                tokio::task::yield_now().await;
            }
            match case["reply"]["count"].as_u64() {
                Some(1) => assert_eq!(got.expect(name), json!({ "accepted": true, "queuedId": selected }), "{name}: busy={busy} expected={expected:?}"),
                Some(0) => match got {
                    Err(CoreError::QueuedEntryNotFound { queued_id, .. }) => assert_eq!(queued_id.as_str(), selected, "{name}"),
                    other => panic!("{name}: busy={busy} expected={expected:?}: {other:?}"),
                },
                other => panic!("{name}: recorded count {other:?}"),
            }
        }
        release.notify_one();
        eventually_on(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    }
}
