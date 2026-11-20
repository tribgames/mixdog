//! A failed save keeps the turn (`turn-durability.mjs`): the rows a failed barrier carried stay shown and are written
//! again with the next records; the next turn waits for them, and is refused while they cannot be written. The
//! recorded Node behaviour is replayed in `mixdog-core` (`run_host::turn_durability_replay`).

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_core_api::CoreError;
use mixdog_core_api::ThreadDirectory;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::ids::ItemId;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::Record;
use serde_json::json;

use super::RunOutcome;
use super::SessionDirectory;
use super::SessionHandle;
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
            let item = ItemCommit {
                iid: ItemId::from(format!("a-{}", run.turn)),
                role: Some("assistant".into()),
                model: true,
                visible: true,
                body: json!({ "text": format!("re: {text}") }),
                prompt: None,
            };
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

#[tokio::test(start_paused = true)]
async fn a_completion_receipt_ack_requires_the_terminal_result_to_be_durable() {
    let rig = Rig::new();
    let failing = rig.store.failing.clone();
    rig.set_script(Arc::new(move |run| {
        let failing = failing.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            *failing.lock().unwrap() = Some("EIO: terminal result".into());
            for (iid, role, body) in [
                (
                    "terminal-read",
                    "tool",
                    json!({
                        "role": "tool", "content": "finished output",
                        "toolMeta": { "code": "task-completion", "executionId": "shell-receipt", "status": "completed" }
                    }),
                ),
                ("kept-reply", "assistant", json!({ "role": "assistant", "text": "kept reply" })),
            ] {
                run.port
                    .commit_item(ItemCommit { iid: ItemId::from(iid), role: Some(role.into()), model: true, visible: true, body, prompt: None })
                    .await
                    .expect("the failed write is kept in memory");
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "work", "receipt-work").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.turn_busy() && rows(&handle).len() == 3).then_some(())).await;
    let notice = "<task-notification><task-id>shell-receipt</task-id><status>completed</status></task-notification>";
    let result = directory.queue_completion_durably(&handle.id, "shell", "shell-receipt", "completed", notice.into()).await;
    assert!(result.is_err(), "an unsaved receipt must not acknowledge durable consumption: {result:?}");
    assert_eq!(stored(&rig, &handle.id), ["work"], "neither the receipt nor unrelated held output reached disk");

    // Replay exactly the records that survived the failed save, without the old actor's memory.
    let replay = Rig::new();
    replay.set_script(super::tests::echo());
    for (_, record) in rig.store.records(&handle.id) {
        replay.store.append_record(&handle.id, record);
    }
    let restarted = SessionDirectory::new(replay.deps());
    let reopened = restarted.open_handle(&handle.id, &mixdog_core_api::call::CallContext::internal("test")).await.expect("reopen");
    crate::eventually_on!(&[&reopened.cell.stepped], || reopened.recovered().then_some(())).await;
    restarted.queue_completion_durably(&handle.id, "shell", "shell-receipt", "completed", notice.into()).await.expect("redelivery survives restart");
    crate::eventually_on!(&[&reopened.cell.stepped], || (idle(&reopened) && stored(&replay, &handle.id).iter().any(|text| text == notice)).then_some(())).await;

    // A fresh durable commit may acknowledge the original receipt, but must retain every
    // other held record and must not start a redundant turn.
    *rig.store.failing.lock().unwrap() = None;
    directory.queue_completion_durably(&handle.id, "shell", "shell-receipt", "completed", notice.into()).await.expect("receipt saved");
    assert_eq!(stored(&rig, &handle.id), ["work", "finished output", "kept reply"]);
    assert_eq!(super::tests::runs_started(&rig, &handle.id), 1);
    directory.shutdown().await;
    restarted.shutdown().await;
}

/// The item texts the store holds, empty ones left out.
fn texts(rig: &Rig, id: &mixdog_core_api::ids::ThreadId) -> Vec<String> {
    stored(rig, id).into_iter().filter(|text| !text.is_empty()).collect()
}

fn internal_title(handle: &SessionHandle, title: &str) -> mixdog_core_api::call::CoreRequest {
    mixdog_core_api::call::CoreRequest {
        method: mixdog_core_api::ids::Method("thread/header/patch"),
        params: json!({ "threadId": handle.id, "set": { "title": title }, "unset": [] }),
        op: None,
        ctx: mixdog_core_api::call::CallContext::internal("test"),
    }
}

/// A value marked after a failed save, while the ended turn's rows wait to be written and its draft file is kept to recover
/// them from, is taken out of that draft file too.
#[tokio::test(start_paused = true)]
async fn a_value_marked_while_a_failed_turn_is_held_is_redacted_from_its_draft() {
    const CODE: &str = "482913";
    let rig = Rig::new();
    let arm: Arc<Mutex<Option<Arc<str>>>> = Arc::default();
    let answer = failing_from_the_answer(rig.store.failing.clone(), arm.clone());
    rig.set_script(Arc::new(move |run| {
        let answer = answer.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            run.port.draft(json!({ "text": format!("the code is {CODE} and more\n") })).await.expect("drafted");
            answer(run).await
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    *arm.lock().unwrap() = Some("EIO: injected".into());
    turn(&handle, "first task", "op-1").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.turn_busy() && rows(&handle).len() == 2).then_some(())).await;
    let holds_code = || rig.store.draft_files(&handle.id).iter().any(|(_, bodies)| bodies.iter().any(|body| body.to_string().contains(CODE)));
    assert!(holds_code(), "the draft is kept while the turn is unsaved: {:?}", rig.store.draft_files(&handle.id));

    let fill = json!({ "name": "browser", "arguments": { "action": "fill", "input": { "sensitive": true, "text": CODE } } });
    assert!(rig.sensitive.remember(handle.id.as_str(), &[fill]));
    crate::eventually_on!(&[&rig.store.committed, &handle.cell.stepped], || (!holds_code()).then_some(())).await;
    assert!(!rig.store.draft_files(&handle.id).is_empty(), "the draft stays, redacted: {:?}", rig.store.draft_files(&handle.id));
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
/// A manual compaction whose save fails is answered with the failure (`commitCompaction` throws) and none of its records is
/// written later: the next write holds no replacement and no count.
#[tokio::test(start_paused = true)]
async fn a_manual_compaction_whose_save_fails_is_refused_and_never_written() {
    use super::run::Compaction;
    use mixdog_store::schema::record::HeaderChange;
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first", "op-1").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.turn_busy()).then_some(())).await;
    let snapshot = directory.model_context(&handle.id).read().await.expect("context").into_iter().map(|(iid, _)| iid).collect();
    let compaction = Compaction {
        replacement: vec![(ItemId::from("sum1".to_owned()), json!({ "role": "user", "content": "summary" }))],
        at: 5,
        dropped_count: 1,
        dropped: None,
    };
    let mut set = serde_json::Map::new();
    set.insert("compaction".into(), json!({ "compactCount": 1, "lastStage": "manual" }));
    let header: super::turn_ops::CompactionHeader = Box::new(move |_, _| HeaderChange { set, unset: Vec::new() });
    *rig.store.failing.lock().unwrap() = Some("EIO: injected".into());
    let refused = directory.commit_compaction(&handle.id, snapshot, compaction, Some(header)).await;
    assert!(refused.is_err(), "{refused:?}");
    *rig.store.failing.lock().unwrap() = None;
    handle.request(internal_title(&handle, "next")).await.expect("the next write lands");
    let records = rig.store.records(&handle.id);
    assert!(!records.iter().any(|(_, record)| matches!(record, Record::Compacted(_))), "the refused compaction is not written");
    assert!(rig.store.stored_header(&handle.id).expect("the header").get("compaction").is_none(), "nor its count");
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
                let row = |iid: String, text: &str| ItemCommit {
                    iid: ItemId::from(iid),
                    role: Some("assistant".into()),
                    model: true,
                    visible: true,
                    body: json!({ "text": text }),
                    prompt: None,
                };
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
    let ended = |rig: &Rig| {
        rig.store.records(&handle.id).into_iter().filter(|(_, record)| matches!(record, Record::Run(run) if run.phase != RunPhase::Started)).count()
    };

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
/// A log an earlier build wrote holds an open run's draft as `draft` records: the next open recovers the run from them, and
/// writes no draft of it again (its old records go with the log's redaction pass, not with a second rewrite here).
#[tokio::test(start_paused = true)]
async fn a_draft_the_log_holds_is_recovered_at_open() {
    use mixdog_store::schema::record::DraftRecord;
    use mixdog_store::schema::record::RunPhase;
    let rig = Rig::new();
    let started = Arc::new(tokio::sync::Notify::new());
    let signal = started.clone();
    rig.set_script(Arc::new(move |run| {
        let signal = signal.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            signal.notify_one();
            std::future::pending::<RunOutcome>().await
        })
    }));
    let first = SessionDirectory::new(rig.deps());
    let handle = start_thread(&first).await;
    turn(&handle, "first task", "op-1").await;
    crate::session::testing::awaiting(|| "the run's start".to_owned(), started.notified()).await;
    let rid = rig.store.records(&handle.id).into_iter().find_map(|(_, record)| match record {
        Record::Run(run) if run.phase == RunPhase::Started => Some(run.rid),
        _ => None,
    });
    let rid = rid.expect("the run started");
    rig.store.append_record(&handle.id, Record::Draft(DraftRecord { rid, body: Slot::Inline(json!({ "text": "streamed before" })) }));

    let second = SessionDirectory::new(rig.deps());
    let reopened = second.open_handle(&handle.id, &mixdog_core_api::call::CallContext::internal("test")).await.expect("open");
    crate::eventually_on!(&[&reopened.cell.stepped], || (reopened.recovered() && !rig.runs.crashed_drafts.lock().unwrap().is_empty()).then_some(())).await;
    assert_eq!(rig.runs.crashed_drafts.lock().unwrap()[0].text, "streamed before");
    assert!(rig.store.draft_files(&handle.id).is_empty(), "no draft file is written for it");
}
/// A turn's row `A`, then a room post `b0, b1` (a unit the session keeps whole), accepted in that order, fail in one write: `A`
/// is held (shown, the turn goes on) and the post kept (its request hears the failure). The turn's end is written with them
/// and fails too: every write fails until the test clears `rig.store.failing`. Returns once the thread is idle again.
async fn held_row_then_kept_post() -> (Rig, Arc<SessionDirectory>, Arc<SessionHandle>) {
    use super::room_log::RoomLog;
    use std::sync::atomic::Ordering::SeqCst;
    let rig = Rig::new();
    let (ready, go) = (Arc::new(tokio::sync::Notify::new()), Arc::new(tokio::sync::Notify::new()));
    let first = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let failing = rig.store.failing.clone();
    let (signal, proceed) = (ready.clone(), go.clone());
    rig.set_script(Arc::new(move |run| {
        let (signal, proceed, first, failing) = (signal.clone(), proceed.clone(), first.clone(), failing.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            if first.swap(false, SeqCst) {
                signal.notify_one();
                proceed.notified().await;
                let row = ItemCommit {
                    iid: ItemId::from(format!("a-{}", run.turn)),
                    role: Some("assistant".into()),
                    model: true,
                    visible: true,
                    body: json!({ "text": "A" }),
                    prompt: None,
                };
                run.port.commit_item(row).await.expect("A is kept");
                *failing.lock().unwrap() = Some("EIO: injected".into());
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = Arc::new(SessionDirectory::new(rig.deps()));
    let handle = start_thread(&directory).await;
    turn(&handle, "first task", "op-1").await;
    crate::session::testing::awaiting(|| "the run's start".to_owned(), ready.notified()).await;
    crate::eventually_on!(&[&handle.cell.stepped], || (handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    // A title change's write waits for the full durability lane while `A`, then the post, queue behind it at the store: the
    // next write takes them together. (On this current-thread runtime the store receives what the actor hands before the
    // test's next step, the store's task having been woken first.)
    let full = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::DurabilityIo);
    let title = {
        let handle = handle.clone();
        tokio::spawn(async move { handle.request(internal_title(&handle, "x")).await })
    };
    full.met_by_a_submit().await;
    let handed = || (handle.cell.handed.load(SeqCst), handle.cell.unacked.load(SeqCst));
    let title_records = crate::eventually_on!(&[&handle.cell.stepped], || {
        let (handed, unacked) = handed();
        (handed > 0 && handed == unacked).then_some(handed)
    })
    .await;
    go.notify_one();
    crate::eventually_on!(&[&handle.cell.stepped], || (handed() == (title_records + 1, title_records + 1)).then_some(())).await;
    let post = {
        let (directory, id) = (directory.clone(), handle.id.as_str().to_owned());
        tokio::spawn(async move {
            super::room_log::SessionRoomLog::new(directory)
                .append_rows(&id, ["b0", "b1"].map(|text| json!({ "role": "user", "content": text, "meta": { "transcript": { "messageId": text } } })).to_vec())
                .await
        })
    };
    // The post's rows (and the stamp after them) are handed whole, behind `A`.
    crate::eventually_on!(&[&handle.cell.stepped], || {
        let (handed, unacked) = handed();
        (handed >= title_records + 3 && handed == unacked).then_some(())
    })
    .await;
    // The write holding `A` and the post fails, rolled back.
    let is_a = |record: &Record| matches!(record, Record::Item(item) if matches!(&item.body, Slot::Inline(body) if body.get("text").and_then(|text| text.as_str()) == Some("A")));
    *super::testing::lock(&rig.store.fail_when) = Some((Box::new(is_a), false));
    drop(full);
    title.await.expect("the title task").expect("the title lands");
    assert!(post.await.expect("the post task").is_err(), "the post hears its write's failure");
    let failed = || rig.notices.0.lock().unwrap().iter().filter(|notice| *notice == "save-failed").count();
    crate::eventually_on!(&[&handle.cell.stepped, &rig.notices.1], || (failed() >= 2 && idle(&handle) && !handle.turn_busy()).then_some(())).await;
    assert_eq!(texts(&rig, &handle.id), ["first task"], "nothing of the failed writes is on disk");
    (rig, directory, handle)
}
/// A row held by the session and a unit it keeps whole, failed in one write and again with the next: once the disk takes
/// writes they land in the order they were accepted, each once, before the next turn.
#[tokio::test(start_paused = true)]
async fn a_held_turn_row_and_a_kept_post_land_in_accept_order() {
    let (rig, _directory, handle) = held_row_then_kept_post().await;
    *rig.store.failing.lock().unwrap() = None;
    turn(&handle, "second task", "op-2").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.turn_busy() && texts(&rig, &handle.id).contains(&"second task".to_owned()))
        .then_some(()))
    .await;
    assert_eq!(texts(&rig, &handle.id), ["first task", "A", "b0", "b1", "second task"]);
}
/// A closing thread writes what it holds and keeps in the order it was accepted.
#[tokio::test(start_paused = true)]
async fn a_closing_thread_writes_a_held_row_and_a_kept_post_in_accept_order() {
    let (rig, directory, handle) = held_row_then_kept_post().await;
    *rig.store.failing.lock().unwrap() = None;
    directory.shutdown().await;
    crate::eventually_on!(&[&rig.store.committed], || {
        let texts = texts(&rig, &handle.id);
        (texts.contains(&"A".to_owned()) && texts.contains(&"b1".to_owned())).then_some(())
    })
    .await;
    assert_eq!(texts(&rig, &handle.id), ["first task", "A", "b0", "b1"]);
}
/// A recovery at open whose save fails: the open ends (nothing waits for a save that cannot come), nothing of the recovery is
/// shown, and the run stays open for the next open, which recovers it.
#[tokio::test(start_paused = true)]
async fn a_recovery_whose_save_fails_opens_without_it_and_the_next_open_recovers() {
    use mixdog_store::schema::record::RunPhase;
    let rig = Rig::new();
    let committed = Arc::new(tokio::sync::Notify::new());
    let told = committed.clone();
    rig.set_script(Arc::new(move |run| {
        let told = told.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let call =
                json!({ "role": "assistant", "content": "Reading.", "toolCalls": [{ "id": "call_1", "name": "read", "arguments": { "path": "a.txt" } }] });
            let item = ItemCommit { iid: ItemId::from("itm_call"), role: Some("assistant".into()), model: true, visible: true, body: call, prompt: None };
            run.port.commit_item(item).await.expect("commit");
            told.notify_one();
            // The process dies here: the run never ends.
            std::future::pending::<RunOutcome>().await
        })
    }));
    let first = SessionDirectory::new(rig.deps());
    let handle = start_thread(&first).await;
    turn(&handle, "read a", "op-1").await;
    crate::session::testing::awaiting(|| "the tool call row to be durable".to_owned(), committed.notified()).await;
    let shown = |handle: &SessionHandle| format!("{:?}", handle.cell.view.load_full().items);
    // The log as stored, shown by an open whose recovery cannot run (the context unreadable).
    rig.store.fail_context.store(true, std::sync::atomic::Ordering::SeqCst);
    let reference = SessionDirectory::new(rig.deps());
    let as_stored = shown(&reference.open_handle(&handle.id, &mixdog_core_api::call::CallContext::internal("test")).await.expect("open"));
    rig.store.fail_context.store(false, std::sync::atomic::Ordering::SeqCst);
    let ended = |rig: &Rig| {
        rig.store.records(&handle.id).into_iter().filter(|(_, record)| matches!(record, Record::Run(run) if run.phase != RunPhase::Started)).count()
    };

    *rig.store.failing.lock().unwrap() = Some("EIO: injected".into());
    let second = SessionDirectory::new(rig.deps());
    let reopened = second.open_handle(&handle.id, &mixdog_core_api::call::CallContext::internal("test")).await.expect("the open ends");
    assert_eq!(shown(&reopened), as_stored, "nothing unsaved of the recovery is shown");
    // Nor is any of it kept to be written behind the next open's own recovery.
    crate::eventually_on!(&[&reopened.cell.stepped], || reopened.recovered().then_some(())).await;
    assert_eq!(ended(&rig), 0);

    *rig.store.failing.lock().unwrap() = None;
    let third = SessionDirectory::new(rig.deps());
    let again = third.open_handle(&handle.id, &mixdog_core_api::call::CallContext::internal("test")).await.expect("open");
    crate::eventually_on!(&[&again.cell.stepped], || (again.recovered() && ended(&rig) == 1).then_some(())).await;
    assert_eq!(rig.runs.crashed.lock().unwrap().len(), 2, "recovered again by the next open");
    assert_ne!(shown(&again), as_stored, "the recovery shows once it is saved");
}

/// Whether the warning stands for `session`: its last save event, raised and not since withdrawn.
fn warning_stands(rig: &Rig, session: &str) -> bool {
    super::testing::lock(&rig.notices.2).iter().rev().find(|(_, id)| id == session).is_some_and(|(event, _)| *event == "save-failed")
}

/// One batch fails, the next event's save (the next turn's start attempt) lands it, and the window remounts: the rows are on
/// disk once, the warning was raised for this session while they were unsaved and withdrawn when the write was acknowledged, so
/// a window that attaches afterwards reads none standing (the notice section holds only what was raised and not withdrawn).
#[tokio::test(start_paused = true)]
async fn the_next_events_save_lands_a_failed_batch_and_withdraws_its_warning() {
    let rig = Rig::new();
    let arm: Arc<Mutex<Option<Arc<str>>>> = Arc::default();
    rig.set_script(failing_from_the_answer(rig.store.failing.clone(), arm.clone()));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    *arm.lock().unwrap() = Some("EIO: injected".into());
    turn(&handle, "first task", "op-1").await;
    crate::eventually_on!(&[&handle.cell.stepped, &rig.notices.1], || (idle(&handle) && rows(&handle).len() == 2 && warning_stands(&rig, handle.id.as_str()))
        .then_some(()))
    .await;
    assert!(!stored(&rig, &handle.id).contains(&"re: first task".to_owned()), "the answer is not on disk yet");

    // The disk takes writes again; the next turn's start attempt saves what is held first.
    *rig.store.failing.lock().unwrap() = None;
    turn(&handle, "second task", "op-2").await;
    crate::eventually_on!(&[&handle.cell.stepped, &rig.notices.1], || (idle(&handle)
        && texts(&rig, &handle.id).len() == 4
        && !warning_stands(&rig, handle.id.as_str()))
    .then_some(()))
    .await;
    assert_eq!(texts(&rig, &handle.id), ["first task", "re: first task", "second task", "re: second task"], "each row is on disk once");

    // A remount reads the standing notice; the failed session's last event is now a withdrawal.
    assert_eq!(super::testing::lock(&rig.notices.2).last().map(|(event, id)| (*event, id.as_str())), Some(("save-resolved", handle.id.as_str())));
    assert_eq!(rows(&handle).len(), 4, "the rows are shown once");
}

/// One session's acknowledged write never withdraws another session's warning.
#[tokio::test(start_paused = true)]
async fn one_sessions_success_does_not_clear_anothers_warning() {
    let rig = Rig::new();
    let arm: Arc<Mutex<Option<Arc<str>>>> = Arc::default();
    rig.set_script(failing_from_the_answer(rig.store.failing.clone(), arm.clone()));
    let directory = SessionDirectory::new(rig.deps());
    let failed = start_thread(&directory).await;
    let reply = directory
        .request(request("thread/start", json!({ "opId": "op-start-healthy", "kind": "task", "projectPath": "/ws" }), "op-start-healthy"))
        .await
        .expect("start the healthy thread");
    let mixdog_core_api::Reply::Subscribe(opened) = reply else { panic!("thread/start subscribes") };
    let healthy_id = mixdog_core_api::ids::ThreadId::from(opened.result["thread"]["id"].as_str().expect("thread id"));
    let healthy = directory.handle(&healthy_id).expect("healthy thread is loaded");
    assert_ne!(failed.id, healthy.id);
    *arm.lock().unwrap() = Some("EIO: injected".into());
    turn(&failed, "first task", "op-1").await;
    crate::eventually_on!(&[&failed.cell.stepped, &rig.notices.1], || (idle(&failed) && rows(&failed).len() == 2 && warning_stands(&rig, failed.id.as_str()))
        .then_some(()))
    .await;
    *rig.store.failing.lock().unwrap() = None;
    turn(&healthy, "other task", "op-2").await;
    crate::eventually_on!(&[&healthy.cell.stepped], || (idle(&healthy) && texts(&rig, &healthy.id).len() == 2).then_some(())).await;
    assert!(warning_stands(&rig, failed.id.as_str()), "the session whose rows are unsaved keeps its warning");
    assert!(super::testing::lock(&rig.notices.2).iter().all(|(_, id)| id != healthy.id.as_str()), "the healthy session never raised one");
}

#[tokio::test(start_paused = true)]
async fn a_retained_approval_request_warns_until_the_next_save_acknowledges_it() {
    use mixdog_core_api::domain::approval::{ApprovalAsk, ApprovalGate, ApprovalKind};
    use mixdog_store::schema::record::ApprovalPhase;

    let rig = Rig::new();
    rig.set_script(Arc::new(|run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let _ = run
                .port
                .request(ApprovalAsk {
                    kind: ApprovalKind::Tool,
                    call_id: None,
                    tool: Some("shell".into()),
                    action_kind: None,
                    reason: None,
                    payload: json!({ "kind": "shell", "tool": "shell", "request": { "target": "make" } }),
                    remember: Vec::new(),
                    expires_after: None,
                })
                .await;
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    let requested = |record: &Record| matches!(record, Record::Approval(approval) if approval.phase == ApprovalPhase::Requested);
    *super::testing::lock(&rig.store.fail_when) = Some((Box::new(requested), false));
    turn(&handle, "approval job", "op-approval").await;
    crate::eventually_on!(&[&handle.cell.stepped, &rig.notices.1], || {
        (!handle.cell.approvals.load().is_empty() && warning_stands(&rig, handle.id.as_str())).then_some(())
    })
    .await;
    assert!(!rig.store.records(&handle.id).iter().any(|(_, record)| requested(record)), "the request is displayed but not stored");

    handle.request(internal_title(&handle, "next")).await.expect("the next save lands");
    crate::eventually_on!(&[&rig.notices.1], || (!warning_stands(&rig, handle.id.as_str())).then_some(())).await;
    assert_eq!(rig.store.records(&handle.id).iter().filter(|(_, record)| requested(record)).count(), 1);
}

#[derive(Clone, Default)]
struct Logged(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Logged {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A failed commit and the write that resolves it are in the diagnostic log, correlated by session and generation, naming the
/// units, the record kinds, the step, the outcome, the cause and the acknowledgement, and never a message body.
#[tokio::test(start_paused = true)]
async fn a_failed_commit_and_its_resolution_are_logged_without_bodies() {
    let log = Logged::default();
    let writer = log.clone();
    let _logging = tracing::subscriber::set_default(
        tracing_subscriber::fmt().with_ansi(false).with_max_level(tracing::Level::INFO).with_writer(move || writer.clone()).finish(),
    );
    let rig = Rig::new();
    let arm: Arc<Mutex<Option<Arc<str>>>> = Arc::default();
    rig.set_script(failing_from_the_answer(rig.store.failing.clone(), arm.clone()));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    *arm.lock().unwrap() = Some("EIO: injected (os error 5)".into());
    turn(&handle, "first task", "op-1").await;
    crate::eventually_on!(&[&handle.cell.stepped, &rig.notices.1], || (idle(&handle) && warning_stands(&rig, handle.id.as_str())).then_some(())).await;
    *rig.store.failing.lock().unwrap() = None;
    turn(&handle, "second task", "op-2").await;
    crate::eventually_on!(&[&handle.cell.stepped, &rig.notices.1], || (idle(&handle) && !warning_stands(&rig, handle.id.as_str())).then_some(())).await;
    let text = String::from_utf8(log.0.lock().unwrap().clone()).expect("utf-8 log");
    let failed = text.lines().find(|line| line.contains("a commit failed")).unwrap_or_else(|| panic!("no failure line: {text}"));
    for expected in [handle.id.as_str(), "generation=", "units=", "records=", "kinds=", "stage=", "outcome=\"not_applied\"", "EIO: injected (os error 5)"] {
        assert!(failed.contains(expected), "{expected} missing from {failed}");
    }
    assert!(text.contains("a commit was acknowledged while earlier records were unsaved"), "{text}");
    assert!(text.contains("the session's warning is withdrawn"), "{text}");
    assert!(!text.contains("first task") && !text.contains("second task"), "no message body in the log: {text}");
}
