//! A failed save keeps the turn (`turn-durability.mjs`): the rows a failed barrier carried stay shown and are written
//! again with the next records; the next turn waits for them, and is refused while they cannot be written. The
//! recorded Node behaviour is replayed in `mixdog-core` (`run_host::turn_durability_replay`).

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::CoreError;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::ids::ItemId;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::Record;
use serde_json::json;

use super::RunOutcome;
use super::SessionDirectory;
use super::actor::TURN_NOT_DURABLE;
use super::run::ItemCommit;
use super::testing::Rig;
use super::testing::Script;
use super::tests::{idle, request, rows, start_thread, turn};

/// Each run answers `re: <prompt>`; the saves fail from its answer on while `failing` holds a cause.
fn failing_from_the_answer(failing: Arc<Mutex<Option<Arc<str>>>>, arm: Arc<Mutex<Option<Arc<str>>>>) -> Script {
    Arc::new(move |run| {
        let (failing, arm) = (failing.clone(), arm.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let armed = arm.lock().unwrap().take();
            if armed.is_some() {
                *failing.lock().unwrap() = armed;
            }
            let text = match &run.input.prompt {
                mixdog_protocol::PromptContent::Text(text) => text.clone(),
                mixdog_protocol::PromptContent::Parts(_) => String::new(),
            };
            let item = ItemCommit { iid: ItemId::from(format!("a-{}", run.turn)), role: Some("assistant".into()), model: true, visible: true, body: json!({ "text": format!("re: {text}") }), prompt: None };
            run.port.commit_item(item).await.expect("the answer is kept");
            RunOutcome::Completed(Default::default())
        })
    })
}

/// The `text` of every item row the store holds, in order.
fn stored(rig: &Rig, id: &mixdog_core_api::ids::ThreadId) -> Vec<String> {
    rig.store
        .records(id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Item(item) => match item.body {
                Slot::Inline(body) => Some(body.get("text").or_else(|| body.get("content")).and_then(|t| t.as_str()).unwrap_or_default().to_owned()),
                Slot::Blob(_) => None,
            },
            _ => None,
        })
        .collect()
}

/// An encoder that holds the encode of the item row whose text is `B` until `go`, telling `arrived` when it starts.
struct HeldEncode {
    arrived: Arc<tokio::sync::Notify>,
    go: Mutex<std::sync::mpsc::Receiver<()>>,
}

impl super::seams::RecordCodec for HeldEncode {
    fn encode(&self, lane: &mixdog_rt::InLane<mixdog_rt::CpuInteractive>, record: &Record) -> Result<super::seams::EncodedRecord, CoreError> {
        if let Record::Item(item) = record
            && let Slot::Inline(body) = &item.body
            && body.get("text").and_then(|text| text.as_str()) == Some("B")
        {
            self.arrived.notify_one();
            let _ = self.go.lock().unwrap().recv();
        }
        super::store::StoreCodec.encode(lane, record)
    }
}

/// A barrier fails while a later record of the turn is still encoding: that record is written with the held ones once the
/// disk takes writes, and the turn goes on (it was dropped as stale, and nothing ever passed it).
///
/// The test lanes run an encode inline on the actor, so B "still encoding" is the actor blocked in B's encode until the
/// barrier's failure is in its channel (the durability task runs on its own worker thread; hence three). The actor's loop
/// takes the durability message before the encode's result (`biased`), the order a pooled lane gives when the encode ends
/// late.
#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn a_record_still_encoding_when_a_barrier_fails_is_written_with_the_held_ones() {
    let rig = Rig::new();
    let (go_tx, go_rx) = std::sync::mpsc::channel();
    *super::testing::lock(&super::durability::FAILURE_SENT) = Some(go_tx);
    let arrived = Arc::new(tokio::sync::Notify::new());
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.codec = Arc::new(HeldEncode { arrived: arrived.clone(), go: Mutex::new(go_rx) });
    let (commit_tx, commit_rx) = std::sync::mpsc::channel();
    let commit_arrived = Arc::new(tokio::sync::Notify::new());
    let gate = Mutex::new(Some((commit_arrived.clone(), commit_rx)));
    let (failing, commit_gate) = (rig.store.failing.clone(), rig.store.commit_gate.clone());
    // Every hop between tasks goes through this test's own thread: a task woken by a thread that then blocks (the
    // barrier on the gate, the actor in B's encode) waits in that worker's slot, which no other worker takes.
    let send_b = Arc::new(tokio::sync::Notify::new());
    let b_go = send_b.clone();
    rig.set_script(Arc::new(move |run| {
        let (failing, commit_gate, gate) = (failing.clone(), commit_gate.clone(), gate.lock().unwrap().take());
        let send_b = b_go.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if let Some(gate) = gate {
                // The next barrier (A's) waits until the later record is encoding, then fails; B is sent once A is
                // handed, so the actor is not blocked in B's encode before it hands A.
                *commit_gate.lock().unwrap() = Some(gate);
                *failing.lock().unwrap() = Some("EIO: injected".into());
                let row = |iid: String, text: &str| ItemCommit { iid: ItemId::from(iid), role: Some("assistant".into()), model: true, visible: true, body: json!({ "text": text }), prompt: None };
                let (a, b) = tokio::join!(run.port.commit_item(row(format!("a-{}", run.turn), "A")), async {
                    send_b.notified().await;
                    run.port.commit_item(row(format!("b-{}", run.turn), "B")).await
                });
                a.expect("A is kept");
                b.expect("B is kept");
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    turn(&handle, "first task", "op-1").await;
    crate::session::testing::awaiting(|| "A's barrier".to_owned(), commit_arrived.notified()).await;
    send_b.notify_one();
    crate::session::testing::awaiting(|| "B to be encoding".to_owned(), arrived.notified()).await;
    commit_tx.send(()).expect("the barrier waits");
    crate::eventually_on!(&[&rig.notices.1], || rig.notices.0.lock().unwrap().iter().any(|notice| notice == "save-failed").then_some(())).await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.turn_busy()).then_some(())).await;

    *rig.store.failing.lock().unwrap() = None;
    turn(&handle, "second task", "op-2").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    let texts: Vec<String> = stored(&rig, &handle.id).into_iter().filter(|text| !text.is_empty()).collect();
    assert_eq!(texts, ["first task", "A", "B", "second task"]);
}

/// A completion arriving while a finished turn's records are unsaved wakes no turn while the disk refuses writes: every
/// ask waits for the previous turn (`awaitPreviousTurnDurable`), and its one fresh save failing refuses it.
#[tokio::test(start_paused = true)]
async fn a_completion_starts_no_turn_while_the_previous_turn_is_unsaved() {
    use mixdog_tools::exec::TaskNotifier;
    let rig = Rig::new();
    let arm: Arc<Mutex<Option<Arc<str>>>> = Arc::default();
    let reached: Arc<std::sync::atomic::AtomicUsize> = Arc::default();
    let answer = failing_from_the_answer(rig.store.failing.clone(), arm.clone());
    let counted = reached.clone();
    rig.set_script(Arc::new(move |run| {
        let (answer, counted) = (answer.clone(), counted.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            answer(run).await
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    *arm.lock().unwrap() = Some("EIO: injected".into());
    turn(&handle, "first task", "op-1").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    let failed = || rig.notices.0.lock().unwrap().iter().filter(|notice| *notice == "save-failed").count();
    let before = failed();

    directory.finished(&handle.id, "shell", "job-7", "completed", "Async shell task job-7 finished.".into()).await;
    crate::eventually_on!(&[&handle.cell.stepped, &rig.notices.1], || (failed() > before && idle(&handle) && !handle.turn_busy()).then_some(())).await;
    assert_eq!(reached.load(std::sync::atomic::Ordering::SeqCst), 1, "no turn reached the provider while the disk refuses writes");
}

/// A recovery at open that cannot read the model context leaves the crashed run open for the next open, instead of ending it
/// as interrupted with nothing of its draft.
#[tokio::test(start_paused = true)]
async fn a_recovery_that_cannot_read_the_context_leaves_the_run_for_the_next_open() {
    use mixdog_store::schema::record::RunPhase;
    let rig = Rig::new();
    let started = Arc::new(tokio::sync::Notify::new());
    let signal = started.clone();
    rig.set_script(Arc::new(move |run| {
        let signal = signal.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            signal.notify_one();
            // The process dies here: the run never ends.
            std::future::pending::<RunOutcome>().await
        })
    }));
    let first = SessionDirectory::new(rig.deps());
    let handle = start_thread(&first).await;
    turn(&handle, "first task", "op-1").await;
    crate::session::testing::awaiting(|| "the run's start".to_owned(), started.notified()).await;
    let ended = |rig: &Rig| rig.store.records(&handle.id).into_iter().filter(|(_, record)| matches!(record, Record::Run(run) if run.phase != RunPhase::Started)).count();

    rig.store.fail_context.store(true, std::sync::atomic::Ordering::SeqCst);
    let second = SessionDirectory::new(rig.deps());
    let reopened = second.open_handle(&handle.id, &mixdog_core_api::call::CallContext::internal("test")).await.expect("open");
    crate::eventually_on!(&[&reopened.cell.stepped], || reopened.recovered().then_some(())).await;
    assert_eq!(ended(&rig), 0, "the run is not ended");

    let third = SessionDirectory::new(rig.deps());
    let again = third.open_handle(&handle.id, &mixdog_core_api::call::CallContext::internal("test")).await.expect("open");
    crate::eventually_on!(&[&again.cell.stepped], || (again.recovered() && ended(&rig) == 1).then_some(())).await;
    assert_eq!(rig.runs.crashed.lock().unwrap().len(), 1, "recovered by the next open");
}

/// The `text` of every `draft` record the store holds for `id`, with whether it rewrites the whole draft.
fn draft_texts(rig: &Rig, id: &mixdog_core_api::ids::ThreadId) -> Vec<(bool, String)> {
    rig.store
        .records(id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Draft(draft) => match draft.body {
                Slot::Inline(body) => Some((body.get("reset") == Some(&json!(true)), body.get("text").and_then(|t| t.as_str()).unwrap_or_default().to_owned())),
                Slot::Blob(_) => None,
            },
            _ => None,
        })
        .collect()
}

/// A run's drafts are written redacted with the session's sensitive values: once a value is marked, the draft written
/// before is written again redacted (Node rewrites its checkpoint), and later drafts hold it redacted.
#[tokio::test(start_paused = true)]
async fn drafts_are_written_redacted_once_a_value_is_marked() {
    let rig = Rig::new();
    let go = Arc::new(tokio::sync::Notify::new());
    let resume = go.clone();
    rig.set_script(Arc::new(move |run| {
        let resume = resume.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            run.port.draft(json!({ "text": "the code is s3cret, " })).await.expect("drafted");
            resume.notified().await;
            run.port.draft(json!({ "text": "again s3cret." })).await.expect("drafted");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first task", "op-1").await;
    crate::eventually_on!(&[&rig.store.committed], || (!draft_texts(&rig, &handle.id).is_empty()).then_some(())).await;

    rig.sensitive.remember(handle.id.as_str(), &[json!({ "name": "browser", "arguments": { "action": "fill", "input": { "text": "s3cret", "sensitive": true } } })]);
    crate::eventually_on!(&[&rig.store.committed], || draft_texts(&rig, &handle.id).iter().any(|(reset, _)| *reset).then_some(())).await;
    go.notify_one();
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.turn_busy()).then_some(())).await;

    let drafts = draft_texts(&rig, &handle.id);
    let after: Vec<&(bool, String)> = drafts.iter().skip_while(|(reset, _)| !reset).collect();
    assert_eq!(after.len(), 2, "the rewrite and the later draft: {drafts:?}");
    assert!(after.iter().all(|(_, text)| !text.contains("s3cret")), "{drafts:?}");
    assert!(after[0].1.starts_with("the code is [redacted]"), "{drafts:?}");
}

#[tokio::test(start_paused = true)]
async fn a_failed_save_keeps_the_turn_and_holds_the_next_until_it_lands() {
    let rig = Rig::new();
    let arm: Arc<Mutex<Option<Arc<str>>>> = Arc::default();
    rig.set_script(failing_from_the_answer(rig.store.failing.clone(), arm.clone()));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    *arm.lock().unwrap() = Some("EIO: injected".into());
    turn(&handle, "first task", "op-1").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 2).then_some(())).await;
    let shown = rows(&handle);
    assert_eq!(shown.iter().map(|(_, text)| text.as_str()).collect::<Vec<_>>(), ["first task", "re: first task"], "the answer stays shown");
    assert!(!stored(&rig, &handle.id).contains(&"re: first task".to_owned()), "the answer is not on disk");

    // The next turn retries the save first; it still fails, so the turn is refused and nothing of it is kept.
    let refused = handle
        .request(request("turn/start", json!({ "threadId": handle.id, "opId": "op-2", "input": { "prompt": "second task" } }), "op-2"))
        .await
        .expect_err("refused while the previous turn is not saved");
    let CoreError::DomainError { code, message, .. } = &refused else { panic!("{refused:?}") };
    assert_eq!(code.as_deref(), Some(TURN_NOT_DURABLE));
    let message = message.as_deref().map(str::to_owned).unwrap_or_default();
    assert!(message.starts_with(&format!("Session {}: the previous turn is not saved to disk", handle.id.as_str())), "{message}");
    assert!(message.ends_with("(EIO: injected)"), "{message}");
    assert_eq!(rows(&handle), shown, "the refused turn shows nothing; the first stays");

    // Once the disk takes writes, the next turn saves the first one, then runs; each is on disk once.
    *rig.store.failing.lock().unwrap() = None;
    turn(&handle, "second task", "op-3").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && rows(&handle).len() == 4).then_some(())).await;
    let texts: Vec<String> = stored(&rig, &handle.id).into_iter().filter(|text| !text.is_empty()).collect();
    assert_eq!(texts, ["first task", "re: first task", "second task", "re: second task"]);
}
