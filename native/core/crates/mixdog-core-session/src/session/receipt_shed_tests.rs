//! A session's completion receipts last as long as a producer can still deliver their execution again
//! (`completion_holders`), and no longer.

use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering::SeqCst;

use async_trait::async_trait;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::completion_receipts;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::DequeueReason;
use mixdog_store::schema::record::QueueAction;
use mixdog_store::schema::record::QueueRecord;
use mixdog_store::schema::record::Record;
use serde_json::json;

use super::SessionDirectory;
use super::completion_holders::HeldCompletions;
use super::completion_holders::Holding;
use super::testing::Rig;
use super::tests::{echo, idle, runs_started, start_thread};

/// The producers of a test: what they answer once they can (`None`: not yet, the question waits), and how often they
/// were asked.
struct Holds {
    answer: tokio::sync::watch::Sender<Option<Holding<Vec<String>>>>,
    asked: AtomicUsize,
}

impl Holds {
    fn new(answer: Option<Holding<Vec<String>>>) -> Arc<Self> {
        Arc::new(Self { answer: tokio::sync::watch::Sender::new(answer), asked: AtomicUsize::new(0) })
    }
}

#[async_trait]
impl HeldCompletions for Holds {
    async fn held(&self, _: &ThreadId) -> Holding<Vec<String>> {
        self.asked.fetch_add(1, SeqCst);
        let mut answer = self.answer.subscribe();
        answer.wait_for(Option::is_some).await.expect("the producers outlive the question").clone().expect("an answer")
    }
}

/// A session whose log carries the receipts of seventy delivered completions, opened with `holds` as its producers.
async fn opened_with_seventy(holds: &Arc<Holds>) -> (Rig, SessionDirectory, SessionDirectory, Arc<super::handle::SessionHandle>) {
    let first = Rig::new();
    let directory = SessionDirectory::new(first.deps());
    let id = start_thread(&directory).await.id.clone();
    let rig = Rig::new();
    rig.set_script(echo());
    for (_, record) in first.store.records(&id) {
        rig.store.append_record(&id, record);
    }
    for n in 0..70 {
        for record in delivered(&format!("task-{n}")) {
            rig.store.append_record(&id, record);
        }
    }
    let parts = rig.deps_parts(rig.store.clone());
    parts.completion_holders.bind(holds.clone()).expect("bound once");
    let restarted = SessionDirectory::new(Arc::new(parts));
    let context = mixdog_core_api::call::CallContext::internal("test");
    let opened = restarted.open_handle(&id, &context).await.expect("reopen");
    crate::eventually_on!(&[&opened.cell.stepped], || (opened.recovered() && idle(&opened)).then_some(())).await;
    (rig, directory, restarted, opened)
}

fn delivered(execution: &str) -> [Record; 2] {
    let qid: mixdog_store::schema::bounded::Id = completion_receipts::queue_id(execution, "").as_str().try_into().expect("a queue id");
    let entry =
        json!({ "message": format!("{execution} done"), "mode": "task-notification", "notificationKind": "completion_notification", "executionId": execution });
    [
        Record::Queue(QueueRecord { qid: qid.clone(), action: QueueAction::Enqueue, reason: None, op: None, entry: Some(Slot::Inline(entry)) }),
        Record::Queue(QueueRecord { qid, action: QueueAction::Dequeue, reason: Some(DequeueReason::Delivered), op: None, entry: None }),
    ]
}

/// The receipts each header change of the log lets go of, in order. A shed removes receipts and states none.
fn sheds(rig: &Rig, id: &ThreadId) -> Vec<Vec<String>> {
    rig.store
        .records(id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Meta(meta) => match meta.change {
                Slot::Inline(change) => {
                    assert!(!change.set.contains_key(completion_receipts::KEY), "no change states the receipts whole");
                    change.patch.get(completion_receipts::KEY).map(|removal| {
                        assert!(removal.set.is_empty() && removal.patch.is_empty(), "a removal and nothing else");
                        removal.unset.clone()
                    })
                }
                Slot::Blob(_) => None,
            },
            _ => None,
        })
        .collect()
}

fn enqueued(rig: &Rig, id: &ThreadId, execution: &str) -> usize {
    let qid = completion_receipts::queue_id(execution, "");
    let is = |record: &Record| matches!(record, Record::Queue(queue) if queue.action == QueueAction::Enqueue && queue.qid.as_str() == qid);
    rig.store.records(id).iter().filter(|(_, record)| is(record)).count()
}

/// A log that carries the receipts of seventy delivered completions is opened while its producers still hold one of them.
/// While they cannot list what they hold yet the question waits and nothing is shed, whatever the session writes
/// meanwhile. Once they can, one header change keeps that one receipt and the log's earlier records stand as they were;
/// the held execution delivered again is consumed, not queued or run; and an execution no producer holds, delivered
/// after all, is a new completion.
#[tokio::test(start_paused = true)]
async fn an_opened_session_keeps_the_receipt_a_producer_still_holds_and_sheds_the_rest_with_one_header_change() {
    let holds = Holds::new(None);
    let (rig, directory, restarted, opened) = opened_with_seventy(&holds).await;
    let id = opened.id.clone();
    let before = rig.store.records(&id);
    restarted.queue_completion_durably(&id, "agent", "task-3", "completed", "task-3 done".into()).await.expect("consumed by its receipt");
    assert_eq!(enqueued(&rig, &id, "task-3"), 1, "the held execution delivered again is not queued");
    assert!(sheds(&rig, &id).is_empty(), "producers that cannot list what they hold yet let go of nothing");
    assert_eq!(holds.asked.load(SeqCst), 1, "one question is out, and the record written meanwhile asked no second");

    holds.answer.send_replace(Some(Holding::Held(vec!["task-3".into()])));
    let kept = completion_receipts::queue_id("task-3", "");
    crate::eventually_on!(&[&opened.cell.stepped], || (!sheds(&rig, &id).is_empty()).then_some(())).await;
    let shed = sheds(&rig, &id);
    assert_eq!((shed.len(), shed[0].len(), shed[0].contains(&kept)), (1, 69, false), "one change lets go of the 69 nobody holds");
    let after = rig.store.records(&id);
    assert_eq!(after[..before.len()], before[..], "the log already written is not rewritten");
    crate::eventually_on!(&[&opened.cell.stepped], || (completion_receipts::count(&*opened.header_snapshot()) == 1).then_some(())).await;

    restarted.queue_completion_durably(&id, "agent", "task-3", "completed", "task-3 done".into()).await.expect("still consumed");
    assert_eq!(enqueued(&rig, &id, "task-3"), 1);
    assert_eq!(runs_started(&rig, &id), 0, "nothing ran a second time");
    restarted.queue_completion_durably(&id, "agent", "task-9", "completed", "task-9 done".into()).await.expect("queued");
    assert_eq!(enqueued(&rig, &id, "task-9"), 2, "an execution no producer holds is a new completion");
    directory.shutdown().await;
    restarted.shutdown().await;
}

/// Producers that never list what they hold in this process (its start could not settle what the last one left) are
/// asked once. The session goes on writing with seventy receipts, well past where it asks, and no record it accepts asks
/// again, nor does an answer that was not a listing: each question copied every receipt id and started a task, for an
/// answer that cannot change before the next start.
#[tokio::test(start_paused = true)]
async fn producers_that_cannot_list_in_this_process_are_not_asked_again_by_the_sessions_writes() {
    for answer in [Holding::Never, Holding::Later] {
        let holds = Holds::new(Some(answer.clone()));
        let (rig, directory, restarted, opened) = opened_with_seventy(&holds).await;
        let id = opened.id.clone();
        crate::eventually_on!(&[&opened.cell.stepped], || (holds.asked.load(SeqCst) == 1).then_some(())).await;
        for n in 0..5 {
            let task = format!("new-{n}");
            restarted.queue_completion_durably(&id, "agent", &task, "completed", format!("{task} done")).await.expect("queued");
        }
        assert_eq!(enqueued(&rig, &id, "new-4"), 1, "the session went on writing");
        crate::eventually_on!(&[&opened.cell.stepped], || idle(&opened).then_some(())).await;
        assert_eq!(holds.asked.load(SeqCst), 1, "{answer:?}: asked once");
        assert!(sheds(&rig, &id).is_empty(), "{answer:?}: nothing is let go of");
        directory.shutdown().await;
        restarted.shutdown().await;
    }
}
