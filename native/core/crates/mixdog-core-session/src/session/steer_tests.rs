//! `turn/steer` against `fixtures/capability-refusals/golden.json`, recorded by `record-capability-refusals.mjs` from Node's
//! real `prioritizeQueued` (`session-flow/queue.mjs`) and the batch its kicked drain takes (`dequeueQueueBatch`). Node goes by
//! queue membership alone, whether a turn runs or not, and whatever turn the caller named: an entry that is not queued answers a
//! count of none and changes nothing; a queued one moves to the front of the queue at priority `now`, answers a count of one and
//! kicks the drain, which takes the recorded batch (at once when idle, when the running turn settles otherwise).

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::CoreError;
use mixdog_core_api::RunControl;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::OpId;
use mixdog_core_api::ids::ThreadId;
use mixdog_core_api::ids::TurnId;
use mixdog_store::schema::record::QueueAction;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;
use super::seams::RunOutcome;
use super::state::Change;
use super::state::Display;
use super::state::SessionState;
use super::testing::Rig;
use super::testing::lock;
use super::tests::eventually_on;
use super::tests::idle;
use super::tests::turn;

fn golden() -> Value {
    serde_json::from_str(include_str!("../../../../fixtures/capability-refusals/golden.json")).expect("golden.json")
}

/// The queued entry as the store hands it over: the recorded content (`text <id>` unless the case names one) and the recorded
/// `skipSlashCommands` as JSON carries it (Node's `-0` is `0` and its `NaN` is `null` there, so those two reach the core as
/// the numbers and the null recorded; the core never sees a `-0` or a `NaN` from JSON or the store).
fn entry_of(case: &Value, id: &str) -> Value {
    let named = &case["entries"][id];
    let mut entry = json!({ "message": named.get("content").cloned().unwrap_or_else(|| json!(format!("text {id}"))), "enqueuedAt": 1, "priority": "next" });
    if let Some(skip) = named.get("skipSlashCommands") {
        entry["skipSlashCommands"] = skip.clone();
    }
    entry
}

fn enqueue(case: &Value, id: &str) -> Record {
    serde_json::from_value(json!({ "k": "queue", "qid": id, "action": "enqueue", "entry": { "inline": entry_of(case, id) } })).expect("queue record")
}

/// The queue as the live session holds it, in Node's `pendingAfterDrain` form.
fn live(handle: &super::handle::SessionHandle) -> Value {
    Value::Array(handle.cell.queue.load().iter().map(|queued| json!({ "id": queued.qid, "priority": queued.entry["priority"] })).collect())
}

/// The queue the durable log leaves, in Node's `pendingAfter` form: every queue record but the dequeues folded by the
/// session's own state.
fn pending(rig: &Rig, thread: &ThreadId) -> Value {
    let mut state = SessionState::new(10);
    for (ordinal, record) in rig.store.records(thread) {
        if matches!(&record, Record::Queue(queue) if queue.action == QueueAction::Dequeue) {
            continue;
        }
        state.apply(&Change::Record { record: Arc::new(record), display: Display::None }, Some(ordinal));
    }
    Value::Array(state.queue.iter().map(|queued| json!({ "id": queued.qid, "priority": queued.entry["priority"] })).collect())
}

fn dequeued(rig: &Rig, thread: &ThreadId) -> Value {
    Value::Array(
        rig.store
            .records(thread)
            .into_iter()
            .filter_map(|(_, record)| match record {
                Record::Queue(queue) if queue.action == QueueAction::Dequeue => Some(json!(queue.qid.as_str())),
                _ => None,
            })
            .collect(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_steer_prioritizes_as_nodes_prioritize_queued_does() {
    let golden = golden();
    let cases = golden["prioritize"].as_array().expect("prioritize");
    assert!(cases.iter().any(|case| case["busy"] == true) && cases.iter().any(|case| case["busy"] == false));
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let busy = case["busy"] == true;
        let mut turns: Vec<Option<&str>> = vec![None, Some("another-turn")];
        if busy {
            turns.push(Some("the-running-turn"));
        }
        for named in turns {
            let rig = Rig::new();
            let release: Arc<tokio::sync::Notify> = Arc::default();
            let started: Arc<Mutex<Vec<Value>>> = Arc::default();
            let entered: Arc<tokio::sync::Notify> = Arc::default();
            // `started` is changed by the script, not by an actor step, so it has a signal of its own.
            let started_changed: Arc<tokio::sync::Notify> = Arc::default();
            let (gate, seen, entry, changed) = (release.clone(), started.clone(), entered.clone(), started_changed.clone());
            rig.set_script(Arc::new(move |run| {
                let (gate, seen, entry, changed) = (gate.clone(), seen.clone(), entry.clone(), changed.clone());
                Box::pin(async move {
                    lock(&seen).push(serde_json::to_value(&run.input.prompt).expect("prompt"));
                    changed.notify_waiters();
                    run.port.input_durable().await.expect("input durable");
                    entry.notify_one();
                    gate.notified().await;
                    RunOutcome::Completed(Default::default())
                })
            }));
            // The thread is created, then loaded again by a second directory over the same log once the recorded queue is in it:
            // an idle thread holding queued prompts.
            let id = ThreadId::from("sess_prio");
            let creator = SessionDirectory::new(rig.deps());
            creator.create_with_id(id.clone(), json!({ "cwd": "/ws" }).as_object().cloned().expect("object"), json!({})).await.expect("create");
            rig.store.seed(&id, case["queued"].as_array().expect("queued").iter().map(|qid| enqueue(case, qid.as_str().expect("id"))).collect());
            let directory = SessionDirectory::new(rig.deps());
            let handle = directory.open_handle(&id, &CallContext::internal("test")).await.expect("open");
            let queued = case["queued"].as_array().expect("queued").len();
            eventually_on(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == queued).then_some(())).await;
            let mut running = None;
            if busy {
                turn(&handle, "work", "op-turn").await;
                eventually_on(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
                running = handle.active_turn();
                entered.notified().await;
            }
            let expected = named.map(|turn| if turn == "the-running-turn" { running.clone().expect("a running turn") } else { TurnId::from(turn) });
            let selected = case["selectedId"].as_str().expect("selectedId");
            let got = handle.steer(expected.as_ref(), json!({ "queuedId": selected }), OpId::from("op-steer"));
            let want_after = &case["pendingAfter"];
            let label = format!("{name}: busy={busy} turn={named:?}");
            match case["reply"]["count"].as_u64() {
                Some(0) => {
                    match got {
                        Err(CoreError::QueuedEntryNotFound { queued_id, .. }) => assert_eq!(queued_id.as_str(), selected, "{label}"),
                        other => panic!("{label}: {other:?}"),
                    }
                    assert_eq!(case["kicked"], 0, "{label}");
                    assert_eq!(&pending(&rig, &id), want_after, "{label}: nothing moved");
                    assert_eq!(dequeued(&rig, &id), json!([]), "{label}: no drain");
                }
                Some(1) => {
                    assert_eq!(got.expect(&label), json!({ "accepted": true, "queuedId": selected }), "{label}");
                    assert_eq!(case["kicked"], 1, "{label}");
                    let drained = case["drained"].clone();
                    // Idle, the kicked drain runs at once; busy, it is deferred to the turn's settling.
                    if busy {
                        eventually_on(&[&handle.cell.stepped], || (pending(&rig, &id) == *want_after).then_some(())).await;
                        assert_eq!(dequeued(&rig, &id), json!([]), "{label}: a busy thread defers the drain");
                        assert_eq!(*lock(&started), vec![json!("work")], "{label}");
                        release.notify_one();
                    }
                    eventually_on(&[&handle.cell.stepped], || (dequeued(&rig, &id) == drained).then_some(())).await;
                    if !busy {
                        assert_eq!(pending(&rig, &id), *want_after, "{label}: the order the drain found");
                    }
                    let taken = drained.as_array().expect("drained").iter().map(|qid| entry_of(case, qid.as_str().expect("id"))["message"].clone());
                    let mut runs = if busy { vec![json!("work")] } else { Vec::new() };
                    runs.extend(taken);
                    eventually_on(&[&handle.cell.stepped, &started_changed], || (*lock(&started) == runs).then_some(())).await;
                    release.notify_one();
                    // What the drain leaves queued: the recorded `pendingAfterDrain` (the slash commands it passes over).
                    eventually_on(&[&handle.cell.stepped], || (idle(&handle).then(|| live(&handle)) == Some(case["pendingAfterDrain"].clone())).then_some(())).await;
                }
                other => panic!("{label}: recorded count {other:?}"),
            }
            if busy && case["reply"]["count"] == 0 {
                release.notify_one();
            }
            eventually_on(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
        }
    }
}