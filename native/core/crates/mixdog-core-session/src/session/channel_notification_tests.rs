//! A channel notification queued by `queue_channel_notification` reads back as Node's pending
//! queue holds it (`fixtures/channel-router/golden.json`, `record-channel-router.mjs`), over a
//! real session actor with a turn running so the entry stays queued.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde_json::Value;

use super::SessionDirectory;
use super::delivered::DeliveredCompletions;
use super::pending_read::PendingQueue;
use super::seams::RunOutcome;
use super::testing::Rig;
use crate::eventually_on;
use super::tests::start_thread;

#[tokio::test(start_paused = true)]
async fn a_channel_notification_queues_as_a_task_notification_with_channel_origin() {
    let gold: Value = serde_json::from_str(include_str!("../../../../fixtures/channel-router/golden.json")).unwrap();
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    rig.clock.0.store(gold["frozenNow"].as_u64().unwrap(), Ordering::SeqCst);
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    // The first notification starts a turn that never ends; the next stays queued.
    directory.queue_channel_notification(&handle.id, "running".into()).await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
    directory.queue_channel_notification(&handle.id, "first".into()).await;
    eventually_on!(&[&handle.cell.stepped], || (!handle.cell.queue.load().is_empty()).then_some(())).await;
    // Node's in-memory form is the first of its two copies; ids are opaque (24 random hex there).
    let mut want = gold["queue"]["entries"][0].clone();
    want["content"] = "first".into();
    want["text"] = "first".into();
    let reads = PendingQueue::new(directory.clone(), Arc::new(DeliveredCompletions::new(rig.clock.clone())));
    let got = reads.pending_messages(handle.id.as_str()).await;
    assert_eq!(got.len(), 1);
    want["id"] = got[0]["id"].clone();
    assert_eq!(got[0], want);
}

#[tokio::test(start_paused = true)]
async fn the_same_channel_text_twice_is_two_entries() {
    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    directory.queue_channel_notification(&handle.id, "running".into()).await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
    for _ in 0..2 {
        directory.queue_channel_notification(&handle.id, "same".into()).await;
    }
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queue.load().len() == 2).then_some(())).await;
}

/// `autoWakeCompletions: false` holds completions (`infrastructure.mjs:154`) but not a channel
/// submit: the notification starts its turn, and the warmer is told of that turn with its
/// provenance (`noteTurnForCacheWarm`, `ask-session.mjs:313`) and told it ended.
#[tokio::test(start_paused = true)]
async fn a_channel_notification_starts_a_turn_while_wakes_are_off_and_the_warmer_hears_of_it() {
    let rig = Rig::new();
    rig.set_script(super::tests::echo());
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let quiet = super::tests::start_with_session(&directory, serde_json::json!({ "autoWakeCompletions": false })).await;
    assert!(directory.queue_channel_notification(&quiet.id, "PR opened".into()).await);
    eventually_on!(&[&quiet.cell.stepped], || (super::tests::runs_started(&rig, &quiet.id) == 1).then_some(())).await;
    eventually_on!(&[&*rig.warms.ended_wake], || (rig.warms.ended.load(Ordering::SeqCst) == 1).then_some(())).await;
    let begun = rig.warms.begun.lock().unwrap().clone();
    assert_eq!(begun.len(), 1);
    assert_eq!(begun[0].0, quiet.id);
    assert_eq!(begun[0].1, serde_json::json!({ "promptSource": "task-notification", "promptOrigin": "channel" }));
    assert_eq!(begun[0].2, None, "a turn that is no retry reads no messages");
}
