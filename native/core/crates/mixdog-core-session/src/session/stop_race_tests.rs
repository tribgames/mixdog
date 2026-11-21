//! Oracle: Node's runs of both orders in `fixtures/phone-chat-core/phone-chat-core.json` ("output already produced: nothing to hand back", "own device named, prompt handed back").

use std::sync::Arc;

use mixdog_core_api::ThreadHandle as _;
use mixdog_core_api::ids::ItemId;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;

use super::SessionDirectory;
use super::handle::SessionHandle;
use super::seams::RunOutcome;
use super::testing::Rig;
use super::testing::awaiting;
use super::tests::idle;
use super::tests::rows;
use super::tests::start_thread;
use crate::eventually_on;

/// A run that streams `partial answer` when `emit` is signalled, then waits to be stopped.
async fn running(rig: &Rig, emit: &Arc<Notify>) -> (SessionDirectory, Arc<SessionHandle>) {
    let emit = emit.clone();
    rig.set_script(Arc::new(move |run| {
        let emit = emit.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            awaiting(|| "the test to let the output through".to_owned(), emit.notified()).await;
            let _ = run.port.delta(ItemId::from("a1".to_owned()), "partial answer".into()).await;
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    (directory, handle)
}

async fn start(handle: &SessionHandle) {
    handle
        .request(super::tests::request(
            "turn/start",
            json!({ "threadId": handle.id, "opId": "op-1", "input": { "prompt": "draft", "options": { "clientSubmissionId": "sub1" } } }),
            "op-1",
        ))
        .await
        .expect("started");
}

fn stop(handle: &Arc<SessionHandle>) -> tokio::task::JoinHandle<Value> {
    let handle = handle.clone();
    tokio::spawn(async move {
        let ctx = mixdog_core_api::call::CallContext::connection(
            mixdog_core_api::ids::ConnectionId(1),
            mixdog_protocol::Origin::Local,
            mixdog_rt::CancellationToken::new(),
        );
        handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: None, submission_id: None, ctx }).await.expect("stop")
    })
}

/// What a Stop answers: it aborted, and hands back `restore_text` with the ids of the submissions it restored.
fn stop_answered(reply: &Value, restore_text: &str, restored: &[&str]) {
    assert_eq!(reply["aborted"], true);
    assert_eq!(reply["restoreText"], restore_text);
    assert_eq!(reply["restoredSubmissionIds"], serde_json::json!(restored));
}

#[tokio::test]
async fn a_user_stopped_runtime_prompt_is_cancelled_and_never_runs_again() {
    let rig = Rig::new();
    let (count, mut counted) = tokio::sync::watch::channel(0usize);
    let rewinds: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let rewound = rewinds.clone();
    rig.set_script(Arc::new(move |run| {
        let (count, rewound) = (count.clone(), rewound.clone());
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            count.send_modify(|n| *n += 1);
            run.cancel.cancelled().await;
            let outcome = format!("{:?}", run.port.closing().prompt_rewound(run.input_item.clone()).await);
            rewound.lock().unwrap().push(outcome);
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    handle
        .request(super::tests::request(
            "turn/start",
            json!({ "threadId": handle.id, "opId": "op-1", "input": { "prompt": "greet the user", "options": { "clientSubmissionId": "sub-k", "kickoff": true } } }),
            "op-1",
        ))
        .await
        .expect("started");
    awaiting(|| "the runtime's turn to start".to_owned(), counted.wait_for(|n| *n == 1)).await.expect("count");
    let first = awaiting(|| "the Stop's reply".to_owned(), stop(&handle)).await.expect("stop task");
    let again = awaiting(|| "the repeated Stop's reply".to_owned(), stop(&handle)).await.expect("stop task");
    assert_eq!((first["restoreText"].clone(), first["restoredSubmissionIds"].clone()), (json!(""), json!([])), "nothing goes to a composer");
    assert_eq!(again["restoreText"], json!(""));
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    // The drain that follows the stopped turn's settlement decided and registered its next start (none).
    drained_after(&handle, "stop:settled:").await;
    assert_eq!(*counted.borrow(), 1, "the stopped kickoff never runs again");
    assert!(handle.cell.queued.load().is_empty(), "no replacement was enqueued");
    let header = rig.store.stored_header(&handle.id).expect("the stored header");
    let sid = mixdog_store::work_stops::stopped(&header, &mixdog_store::work_stops::submission("sub-k")).expect("the stopped submission is terminal on disk");
    assert_eq!(stop_records(&rig, &handle.id).len(), 1, "the repeated Stop joined the first: one record");
    assert!(mixdog_store::work_stops::owed(&header).is_empty(), "{sid}: its cancelled outcome is final");
    assert_eq!(*rewinds.lock().unwrap(), vec!["Ok(())".to_owned()], "the hidden provisional row is rewound once");
    let view = handle.cell.view.load_full();
    let ends = view.items.iter().filter(|item| matches!(item.as_ref(), mixdog_protocol::ThreadItem::TurnEnd { .. })).count();
    assert_eq!(ends, 1, "one cancelled outcome: {:?}", view.items);
    assert!(!view.items.iter().any(|item| matches!(item.as_ref(), mixdog_protocol::ThreadItem::UserMessage { .. })), "no user bubble: {:?}", view.items);
    let frames = rig.feeds.frames(handle.id.as_str());
    assert!(!frames.iter().any(|(_, method, _)| method == "thread/promptRestore"), "no composer return");
}

/// An inline pasted text is stored at intake (`materializePastedTexts`, attachments/store.mjs:466-499): the turn reads it by its
/// content reference, so its stored prompt row lists the attachment even when another device's Stop keeps the prompt
/// (remote-protocol-chat-abort.recorded.json `other-device-with-attachment`).
#[tokio::test]
async fn an_inline_pasted_text_is_stored_when_the_prompt_is_taken_in() {
    let rig = Rig::new();
    let (seen, mut got) = tokio::sync::watch::channel(None::<Value>);
    rig.set_script(Arc::new(move |run| {
        let seen = seen.clone();
        Box::pin(async move {
            seen.send_replace(Some(serde_json::to_value(&run.input).expect("input serializes")));
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    handle
        .request(super::tests::request(
            "turn/start",
            json!({ "threadId": handle.id, "opId": "op-1", "input": { "prompt": "with a paste", "options": { "pastedTexts": { "1": { "id": 1, "text": "a pasted block" } } } } }),
            "op-1",
        ))
        .await
        .expect("started");
    let input = awaiting(|| "the turn to run".to_owned(), got.wait_for(Option::is_some)).await.expect("input").clone().expect("input");
    let entry = &input["options"]["pastedTexts"]["1"];
    let reference = entry["attachmentRef"].as_str().expect("a stored reference").trim_start_matches("sha256:").to_owned();
    assert_eq!(reference, "fd434aeafe30cd343fc401e47a64f1fa60741e1fc8ae9e2e83063caf2cba2ea3", "Node's reference of the same text");
    // Node's `materializePastedTexts` keeps the reference in place of the text.
    assert_eq!((entry["sizeBytes"].clone(), entry["chars"].clone(), entry.get("text")), (json!(14), json!(14), None));
}

/// A stopped turn's activity stamp (`prepareCloseSnapshot`, ask-turn-state.mjs:256-257) is written before the record that reports the
/// turn finished (`turn/completed`), so a list read after that notification shows `activityAt` = `updatedAt` as Node's row does
/// (remote-protocol-chat-abort.recorded.json `running-keep-prompt`).
#[tokio::test]
async fn a_stopped_turns_activity_is_stamped_before_it_reports_finished() {
    use mixdog_store::schema::record::{Record, RunPhase};
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    start(&handle).await;
    awaiting(|| "the Stop's reply".to_owned(), stop(&handle)).await.expect("stop task");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let records = rig.store.records(&handle.id);
    let ended = records.iter().position(|(_, r)| matches!(r, Record::Run(run) if run.phase == RunPhase::Interrupted)).expect("run{interrupted}");
    let stamped = records
        .iter()
        .position(|(_, r)| matches!(r, Record::Meta(m) if matches!(&m.change, mixdog_store::schema::blob::Slot::Inline(c) if c.set.contains_key("lastUsedAt"))))
        .expect("the activity stamp");
    assert!(stamped < ended, "the stamp at {stamped} precedes the turn's end at {ended}");
}

/// An Agent stopping its own turn cancels the agent jobs it started (`abortSession`, `session-turns.mjs`); a Lead's Stop leaves delegated
/// work alone.
#[tokio::test]
async fn an_agents_stop_cancels_the_jobs_it_started_and_a_leads_does_not() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let agent = start_thread(&directory).await;
    let mut header = (**agent.cell.header.load()).clone();
    header.insert("visibility".into(), json!("agent-only"));
    agent.cell.header.store(Arc::new(header));
    let lead = start_thread(&directory).await;
    for handle in [&lead, &agent] {
        let ctx = mixdog_core_api::call::CallContext::connection(
            mixdog_core_api::ids::ConnectionId(1),
            mixdog_protocol::Origin::Local,
            mixdog_rt::CancellationToken::new(),
        );
        let _ = handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: None, submission_id: None, ctx }).await;
    }
    let aborted: Vec<String> = rig.signals.0.lock().unwrap().iter().filter(|signal| signal.starts_with("agent-abort:")).cloned().collect();
    assert_eq!(aborted, [format!("agent-abort:{}", agent.id.as_str())]);
}

// ───────────── the durable, identity-bound Stop ─────────────

use mixdog_core_api::CoreError;
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::Record;
use mixdog_store::schema::record::WorkStopPhase;
use mixdog_store::work_stops;
use std::sync::Mutex;
use std::sync::atomic::Ordering::SeqCst;

/// The actor's Stop ledger (`ControlCell::stop_ledger`).
fn ledger(handle: &SessionHandle) -> Vec<String> {
    handle.cell.stop_ledger.lock().unwrap().clone()
}

fn logged(handle: &SessionHandle, prefix: &str) -> bool {
    ledger(handle).iter().any(|event| event.starts_with(prefix))
}

/// Waits for the event `prefix` and then a queue drain pass after it: the pass decided and registered any next start, so what it
/// did not start it will not start for that event.
async fn drained_after(handle: &SessionHandle, prefix: &str) {
    eventually_on!(&[&handle.cell.stepped], || {
        let events = ledger(handle);
        let at = events.iter().position(|event| event.starts_with(prefix))?;
        events[at..].iter().any(|event| event == "drain:decided").then_some(())
    })
    .await;
}

/// The `work_stop{stopped}` bodies the store holds for `id`, with their Stop ids.
fn stop_records(rig: &Rig, id: &ThreadId) -> Vec<(String, Value)> {
    rig.store
        .records(id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::WorkStop(stop) if stop.phase == WorkStopPhase::Stopped => match stop.body {
                Some(Slot::Inline(body)) => Some((stop.sid.as_str().to_owned(), body)),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

fn settled_records(rig: &Rig, id: &ThreadId) -> Vec<String> {
    rig.store
        .records(id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::WorkStop(stop) if stop.phase == WorkStopPhase::Settled => Some(stop.sid.as_str().to_owned()),
            _ => None,
        })
        .collect()
}

fn text_of(input: &mixdog_app_protocol::v2::thread::TurnInput) -> String {
    match &input.prompt {
        mixdog_protocol::PromptContent::Text(text) => text.clone(),
        mixdog_protocol::PromptContent::Parts(_) => String::new(),
    }
}

fn stop_result(handle: &Arc<SessionHandle>) -> tokio::task::JoinHandle<Result<Value, CoreError>> {
    let handle = handle.clone();
    tokio::spawn(async move {
        let ctx = mixdog_core_api::call::CallContext::connection(
            mixdog_core_api::ids::ConnectionId(1),
            mixdog_protocol::Origin::Local,
            mixdog_rt::CancellationToken::new(),
        );
        handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: None, submission_id: None, ctx }).await
    })
}

/// The queue id `second` was queued under.
fn second_qid(rig: &Rig, id: &ThreadId) -> String {
    rig.store
        .records(id)
        .into_iter()
        .find_map(|(_, record)| match record {
            Record::Queue(queue) if queue.entry.as_ref().is_some_and(|entry| matches!(entry, Slot::Inline(entry) if entry.to_string().contains("second"))) => {
                Some(queue.qid.as_str().to_owned())
            }
            _ => None,
        })
        .expect("`second` was queued")
}

fn restores(rig: &Rig, handle: &SessionHandle) -> Vec<Value> {
    rig.feeds.frames(handle.id.as_str()).into_iter().filter(|(_, method, _)| method == "thread/promptRestore").map(|(_, _, value)| value).collect()
}

/// The Stop of connection `connection` (device `desktop-<connection>`).
fn stop_from(handle: &Arc<SessionHandle>, connection: u64) -> tokio::task::JoinHandle<Value> {
    let handle = handle.clone();
    tokio::spawn(async move {
        let ctx = mixdog_core_api::call::CallContext::connection(
            mixdog_core_api::ids::ConnectionId(connection),
            mixdog_protocol::Origin::Local,
            mixdog_rt::CancellationToken::new(),
        );
        handle.stop(mixdog_core_api::thread::Stop { turn: None, restore_prompt: None, submission_id: None, ctx }).await.expect("stop")
    })
}

/// The `thread/promptRestore` ids the feed carried.
fn restore_ids(rig: &Rig, handle: &SessionHandle) -> Vec<String> {
    fn ids(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                if let Some(id) = map.get("id").and_then(Value::as_str).filter(|id| id.starts_with("restore-")) {
                    out.push(id.to_owned());
                }
                map.values().for_each(|value| ids(value, out));
            }
            Value::Array(values) => values.iter().for_each(|value| ids(value, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    for value in restores(rig, handle) {
        ids(&value, &mut out);
    }
    out.dedup();
    out
}

/// The id of the hand-back a `work_stop{stopped}` body records: Node's `restore-<at>-<submission ids>` over the stored values.
fn recorded_restore_id(body: &Value) -> String {
    let ids: Vec<&str> = body["restore"]["ids"].as_array().expect("the restore's ids").iter().filter_map(Value::as_str).collect();
    format!("restore-{}-{}", body["restore"]["at"], ids.join(","))
}

/// A room member submission `id` of exchange `exchange` into `thread`, as the room daemon submits it.
async fn room_submit(directory: &SessionDirectory, thread: &ThreadId, prompt: &str, id: &str, exchange: &str) -> bool {
    let mut meta = serde_json::Map::new();
    meta.insert("roomExchange".into(), json!(exchange));
    directory.submit_chained_turn(thread, &json!(prompt), id, 0, &[], &meta, "").await.is_some()
}

/// A member stop that cannot be saved answers the storage failure, never success.
#[tokio::test(start_paused = true)]
async fn a_member_stop_that_cannot_be_saved_answers_the_storage_failure() {
    let rig = Rig::new();
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    *rig.store.failing.lock().unwrap() = Some("EIO: injected".into());
    let error = directory.stop_work(&handle.id, vec!["rsub_x".into()]).await.expect_err("never success");
    assert!(format!("{error:?}").contains(super::actor::STOP_NOT_SAVED), "{error:?}");
}

#[tokio::test]
async fn a_question_the_stop_ended_reads_the_aborts_error_on_its_card() {
    use mixdog_core_api::domain::approval::{ApprovalAsk, ApprovalGate as _, ApprovalKind};
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let call = json!({ "id": "c1", "name": "ask_user", "arguments": { "questions": [{ "question": "Add the file?" }] } });
            let commit = |iid: &str, role: &str, body: Value| super::run::ItemCommit {
                iid: ItemId::from(iid.to_owned()),
                role: Some(role.into()),
                model: true,
                visible: true,
                body,
                prompt: None,
            };
            run.port.commit_item(commit("a-1", "assistant", json!({ "text": "", "toolCalls": [call] }))).await.expect("call");
            let _ = run
                .port
                .request(ApprovalAsk {
                    kind: ApprovalKind::UserInput,
                    call_id: Some("c1".into()),
                    tool: Some("ask_user".into()),
                    action_kind: None,
                    reason: None,
                    payload: json!({ "questions": [{ "question": "Add the file?" }] }),
                    remember: Vec::new(),
                    expires_after: None,
                })
                .await;
            // The interruption closes the unanswered call as Node's finalizer does.
            run.port.closing().commit_item(commit("t-1", "tool", json!({ "toolCallId": "c1", "text": "Cancelled", "isError": true }))).await.expect("stub");
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    start(&handle).await;
    eventually_on!(&[&handle.cell.stepped], || directory.member_approval(&handle.id).map(drop)).await;
    awaiting(|| "the Stop's reply".to_owned(), stop(&handle)).await.expect("stop task");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    let view = handle.cell.view.load_full();
    let result = view.items.iter().find_map(|item| match item.as_ref() {
        mixdog_protocol::ThreadItem::ToolCall { run, meta, .. } => Some((run.result.clone(), run.is_error, meta.status)),
        _ => None,
    });
    let expected = format!("Error: Session \"{}\" closed: runtime abort (reason=user-cancel)", handle.id.as_str());
    // The card is ended by the Stop: `interrupted`, which the client finalizes as a cancelled card.
    assert_eq!(result, Some((Some(mixdog_protocol::MaybeBlob::Inline(expected)), Some(true), Some(mixdog_protocol::ItemStatus::Interrupted))));
}

/// Every run's prompt is noted as it reaches the provider (the script is the provider); a run of `first` waits for `gate`, any
/// other completes once its input is durable.
fn provider(seen: Arc<Mutex<Vec<String>>>, gate: Arc<Notify>) -> super::testing::Script {
    Arc::new(move |run| {
        let (seen, gate) = (seen.clone(), gate.clone());
        Box::pin(async move {
            let text = text_of(&run.input);
            seen.lock().unwrap().push(text.clone());
            if text == "first" {
                gate.notified().await;
            }
            if run.port.input_durable().await.is_err() {
                return RunOutcome::Interrupted;
            }
            RunOutcome::Completed(Default::default())
        })
    })
}

/// `first` ran; `second`, queued behind it, was dequeued by the drain and its start is reading its input row, the interactive io lane
/// held (`io`, which the caller drops to let the read finish).
async fn reading_second(rig: &Rig, seen: &Arc<Mutex<Vec<String>>>) -> (SessionDirectory, Arc<SessionHandle>, mixdog_rt::testing::HeldFull) {
    let gate = Arc::new(Notify::new());
    rig.set_script(provider(seen.clone(), gate.clone()));
    let (hold, start_hold) = tokio::sync::watch::channel(super::StartHold::Open);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.start_hold = start_hold;
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    assert_eq!(super::tests::turn(&handle, "first", "op-1").await["kind"], "started");
    assert_eq!(super::tests::turn(&handle, "second", "op-2").await["kind"], "queued");
    hold.send_replace(super::StartHold::Held);
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle)
        && !handle.cell.busy.load(SeqCst)
        && handle.cell.queued.load().len() == 1
        && handle.cell.unacked.load(SeqCst) == 0)
        .then_some(()))
    .await;
    let io = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
    hold.send_replace(super::StartHold::Open);
    io.met_by_a_submit().await;
    super::tests::caught_up(&handle).await;
    assert!(idle(&handle) && handle.cell.ui_busy.load(SeqCst), "the start of `second` is reading its input");
    (directory, handle, io)
}

/// A fresh process over the records `prefix` of `id` (nothing of the old actor's memory): opened, recovered and resumed, until the
/// resume's queue drain decided. Every run's prompt reaching its provider is noted in `seen`.
async fn reopened(prefix: Vec<Record>, id: &ThreadId, seen: &Arc<Mutex<Vec<String>>>) -> (Rig, SessionDirectory, Arc<SessionHandle>) {
    let replay = Rig::new();
    replay.set_script(provider(seen.clone(), Arc::new(Notify::new())));
    for record in prefix {
        replay.store.append_record(id, record);
    }
    let restarted = SessionDirectory::new(replay.deps());
    let handle = restarted.open_handle(id, &mixdog_core_api::call::CallContext::internal("test")).await.expect("reopen");
    eventually_on!(&[&handle.cell.stepped], || handle.recovered().then_some(())).await;
    handle.cell.deliver(super::control::Ctl::Resumed);
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.drain_passes.load(SeqCst) > 0).then_some(())).await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    (replay, restarted, handle)
}

#[tokio::test(start_paused = true)]
async fn a_stop_during_the_settlement_freezes_the_queued_completion_and_a_later_one_still_runs() {
    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    rig.set_script(provider(seen.clone(), Arc::new(Notify::new())));
    let release: Arc<Notify> = Arc::default();
    let settled: Arc<std::sync::atomic::AtomicUsize> = Arc::default();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.goals = Arc::new(super::tests::HeldSettle { goals: rig.goals.clone(), release: release.clone(), settled: settled.clone() });
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    super::tests::turn(&handle, "work", "op-1").await;
    // Reached: the turn ended and its settlement is held (no run, the turn still held).
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.turn_held.load(SeqCst) && settled.load(SeqCst) == 0).then_some(())).await;
    directory.queue_completion_durably(&handle.id, "shell", "job-a", "completed", "job-a finished.".into()).await.expect("A is queued durably");
    let a = rig.store.records(&handle.id).into_iter().find_map(|(_, record)| match record {
        Record::Queue(queue) if queue.qid.as_str().starts_with("completion_") => Some(queue.qid.as_str().to_owned()),
        _ => None,
    });
    let a = a.expect("A's queue id");
    let reply = awaiting(|| "the Stop's reply".to_owned(), stop(&handle)).await.expect("stop task");
    assert_eq!(reply["aborted"], json!(true), "{reply}");
    let frozen = ledger(&handle).into_iter().find(|event| event.starts_with("stop:frozen:")).expect("the Stop froze its targets");
    assert!(frozen.contains(&work_stops::queued(&a)), "{frozen}");
    assert!(logged(&handle, "stop:durable:"), "success follows the durable record: {:?}", ledger(&handle));
    directory.queue_completion_durably(&handle.id, "shell", "job-b", "completed", "job-b finished.".into()).await.expect("B is queued durably");
    assert!(seen.lock().unwrap().len() == 1, "B waits for the settlement: {:?}", seen.lock().unwrap());
    release.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (seen.lock().unwrap().len() == 2 && idle(&handle)).then_some(())).await;
    let passes = handle.cell.drain_passes.load(SeqCst);
    release.notify_one();
    // The drain after B's settlement decided: nothing more starts.
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && settled.load(SeqCst) == 2 && handle.cell.drain_passes.load(SeqCst) > passes).then_some(()))
        .await;
    let seen = seen.lock().unwrap().clone();
    assert!(seen[1].contains("job-b") && !seen[1].contains("job-a"), "B ran alone: {seen:?}");
    assert_eq!(seen.len(), 2, "A never ran: {seen:?}");
    let header = rig.store.stored_header(&handle.id).expect("header");
    assert!(mixdog_store::completion_receipts::contains(&header, &a), "A has its terminal receipt");
    assert!(work_stops::stopped(&header, &work_stops::queued(&a)).is_some());
    assert!(handle.cell.queued.load().is_empty());
}

/// A Stop during the settlement freezes the batch of the wake it cancels, and only that: with a `next` completion (A) and a `later`
/// channel message (C) queued, the impending wake is A's alone (`dequeueQueueBatch` takes one priority bucket), so C is not stopped
/// and runs as a wake of its own once the settlement finishes.
#[tokio::test(start_paused = true)]
async fn a_stop_during_the_settlement_leaves_a_notice_of_another_priority_queued() {
    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    rig.set_script(provider(seen.clone(), Arc::new(Notify::new())));
    let release: Arc<Notify> = Arc::default();
    let settled: Arc<std::sync::atomic::AtomicUsize> = Arc::default();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.goals = Arc::new(super::tests::HeldSettle { goals: rig.goals.clone(), release: release.clone(), settled: settled.clone() });
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    super::tests::turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.turn_held.load(SeqCst) && settled.load(SeqCst) == 0).then_some(())).await;
    directory.queue_completion_durably(&handle.id, "shell", "job-a", "completed", "job-a finished.".into()).await.expect("A is queued durably");
    let (durable, saved) = tokio::sync::oneshot::channel();
    let channel = super::actor::Inbox::TaskNotification {
        surface: "channel".into(),
        task_id: String::new(),
        status: "completed".into(),
        text: "a channel message".into(),
        origin: Some(super::completions::ORIGIN_CHANNEL),
        hop: 0,
        live: true,
        durable: Some(durable),
    };
    handle.inbox.send(channel).await.expect("the actor runs");
    saved.await.expect("answered").expect("C is queued durably");
    let queued = handle.cell.queue.load_full();
    let qid_of = |channel: bool| queued.iter().find(|q| super::completions::is_channel(&q.entry) == channel).map(|q| q.qid.clone()).expect("queued");
    let (a, c) = (qid_of(false), qid_of(true));
    let reply = awaiting(|| "the Stop's reply".to_owned(), stop(&handle)).await.expect("stop task");
    assert_eq!(reply["aborted"], json!(true), "{reply}");
    let frozen = ledger(&handle).into_iter().find(|event| event.starts_with("stop:frozen:")).expect("the Stop froze its targets");
    assert!(frozen.contains(&work_stops::queued(&a)), "{frozen}");
    assert!(!frozen.contains(&work_stops::queued(&c)), "the later notice is not the cancelled wake's: {frozen}");
    release.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (seen.lock().unwrap().len() == 2).then_some(())).await;
    release.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && settled.load(SeqCst) == 2).then_some(())).await;
    let seen = seen.lock().unwrap().clone();
    assert!(seen[1].contains("a channel message") && !seen[1].contains("job-a"), "C ran alone: {seen:?}");
    let header = rig.store.stored_header(&handle.id).expect("header");
    assert!(work_stops::stopped(&header, &work_stops::queued(&c)).is_none(), "C is not stopped");
    assert!(handle.cell.queued.load().is_empty());
}

/// The same with nothing queued for the wake when the Stop is taken: it freezes nothing and prohibits nothing; B, arriving after it,
/// runs once the settlement finishes.
#[tokio::test(start_paused = true)]
async fn a_stop_during_the_settlement_with_nothing_queued_prohibits_nothing() {
    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    rig.set_script(provider(seen.clone(), Arc::new(Notify::new())));
    let release: Arc<Notify> = Arc::default();
    let settled: Arc<std::sync::atomic::AtomicUsize> = Arc::default();
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.goals = Arc::new(super::tests::HeldSettle { goals: rig.goals.clone(), release: release.clone(), settled: settled.clone() });
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    super::tests::turn(&handle, "work", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.turn_held.load(SeqCst) && settled.load(SeqCst) == 0).then_some(())).await;
    let reply = awaiting(|| "the Stop's reply".to_owned(), stop(&handle)).await.expect("stop task");
    assert_eq!(reply["aborted"], json!(true), "{reply}");
    assert!(!logged(&handle, "stop:frozen:"), "nothing was frozen: {:?}", ledger(&handle));
    directory.queue_completion_durably(&handle.id, "shell", "job-b", "completed", "job-b finished.".into()).await.expect("B is queued durably");
    release.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (seen.lock().unwrap().len() == 2).then_some(())).await;
    assert!(seen.lock().unwrap()[1].contains("job-b"));
    release.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && settled.load(SeqCst) == 2).then_some(())).await;
    assert!(stop_records(&rig, &handle.id).is_empty());
}

/// A Stop while the run's end is parked behind a row whose facts are being read: the run is over, so the Stop aborts no finished
/// token and rewrites no outcome; it is the settlement's Stop (nothing queued for a wake: nothing frozen).
#[tokio::test(start_paused = true)]
async fn a_stop_while_the_runs_end_is_parked_aborts_no_finished_run() {
    use mixdog_store::schema::record::RunPhase;
    let rig = Rig::new();
    let emit = Arc::new(Notify::new());
    let go = emit.clone();
    rig.set_script(Arc::new(move |run| {
        let go = go.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            go.notified().await;
            let item = super::run::ItemCommit {
                iid: ItemId::from("a-1".to_owned()),
                role: Some("assistant".into()),
                model: true,
                visible: true,
                body: json!({ "text": "done" }),
                prompt: None,
            };
            let _queued = run.port.queue_item(item).await.expect("queued");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    start(&handle).await;
    let active = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    let io = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
    emit.notify_one();
    io.met_by_a_submit().await;
    eventually_on!(&[&handle.cell.stepped], || logged(&handle, "run:end-parked:").then_some(())).await;
    let reply = awaiting(|| "the Stop's reply".to_owned(), stop(&handle)).await.expect("stop task");
    assert_eq!(reply["aborted"], json!(true), "{reply}");
    assert!(!active.cancel.is_aborted(), "the finished run's token was not aborted");
    assert!(!logged(&handle, "stop:frozen:"), "{:?}", ledger(&handle));
    drop(io);
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;
    let ended: Vec<RunPhase> = rig
        .store
        .records(&handle.id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Run(run) if run.phase != RunPhase::Started => Some(run.phase),
            _ => None,
        })
        .collect();
    assert_eq!(ended, [RunPhase::Completed], "the finished turn's outcome is not rewritten");
}

/// The input read is held and the Stop's write is held: no success before the write is acknowledged; then the reply comes while
/// the read is still held. The late read finishes the cancellation (the prompt back at its composer) and never runs the model.
#[tokio::test(start_paused = true)]
async fn the_stop_answers_once_its_record_is_durable_while_the_input_read_is_still_held() {
    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let (_directory, handle, io) = reading_second(&rig, &seen).await;
    let qid = second_qid(&rig, &handle.id);
    let disk = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::DurabilityIo);
    let stopped = stop_result(&handle);
    // Reached: the actor froze the start and its record met the held disk.
    eventually_on!(&[&handle.cell.stepped], || logged(&handle, "stop:frozen:").then_some(())).await;
    disk.met_by_a_submit().await;
    super::tests::caught_up(&handle).await;
    assert!(!stopped.is_finished(), "no success before the record is acknowledged");
    assert!(!logged(&handle, "stop:durable:"));
    let frozen = ledger(&handle).into_iter().find(|event| event.starts_with("stop:frozen:")).expect("frozen");
    assert!(frozen.contains(&work_stops::queued(&qid)), "the projected dequeue removed it, the Stop still names it: {frozen}");
    drop(disk);
    let reply = awaiting(|| "the Stop's reply".to_owned(), stopped).await.expect("stop task").expect("the stop is saved");
    assert_eq!(reply["aborted"], json!(true), "{reply}");
    assert!(logged(&handle, "stop:durable:"));
    assert!(!logged(&handle, "start:stopped:") && handle.cell.ui_busy.load(SeqCst), "the input read is still held");
    drop(io);
    eventually_on!(&[&handle.cell.stepped], || logged(&handle, "start:stopped:").then_some(())).await;
    drained_after(&handle, "start:stopped:").await;
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    assert_eq!(*seen.lock().unwrap(), ["first"], "the stopped start never reached the provider");
    let (sid, body) = stop_records(&rig, &handle.id).pop().expect("the Stop's record");
    assert_eq!(body["disposition"], json!("handedBack"), "{body}");
    assert_eq!(restore_ids(&rig, &handle), [recorded_restore_id(&body)], "the prompt is offered to its composer under its record's id");
    // Nothing to rewind, offered: settled, with no acknowledgement awaited.
    assert_eq!(settled_records(&rig, &handle.id), [sid]);
    assert!(handle.cell.queued.load().is_empty());
}

#[tokio::test(start_paused = true)]
async fn exception_an_unsaved_stop_answers_the_storage_error_and_its_work_runs_after_a_restart() {
    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let gate = Arc::new(Notify::new());
    rig.set_script(provider(seen.clone(), gate.clone()));
    let (hold, start_hold) = tokio::sync::watch::channel(super::StartHold::Open);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.start_hold = start_hold;
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    super::tests::turn(&handle, "first", "op-1").await;
    super::tests::turn(&handle, "second", "op-2").await;
    hold.send_replace(super::StartHold::Held);
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle)
        && !handle.cell.busy.load(SeqCst)
        && handle.cell.queued.load().len() == 1
        && handle.cell.unacked.load(SeqCst) == 0)
        .then_some(()))
    .await;
    let saved = rig.store.records(&handle.id).into_iter().map(|(_, record)| record).collect::<Vec<_>>();
    *rig.store.failing.lock().unwrap() = Some("EIO: injected".into());
    let io = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
    hold.send_replace(super::StartHold::Open);
    io.met_by_a_submit().await;
    super::tests::caught_up(&handle).await;
    let failed = awaiting(|| "the Stop's reply".to_owned(), stop_result(&handle)).await.expect("stop task");
    let error = failed.expect_err("an unsaved Stop is never a success");
    assert!(format!("{error:?}").contains(super::actor::STOP_NOT_SAVED), "{error:?}");
    assert!(logged(&handle, "stop:failed:") && !logged(&handle, "stop:durable:"), "{:?}", ledger(&handle));
    drop(io);
    eventually_on!(&[&handle.cell.stepped], || logged(&handle, "start:stopped:").then_some(())).await;
    assert_eq!(*seen.lock().unwrap(), ["first"], "the cancellation stands in this process");
    assert_eq!(rig.store.records(&handle.id).len(), saved.len(), "nothing more reached the store");
    // The exception: the fresh process finds the durable enqueue and no Stop record, and the work runs.
    let replayed: Arc<Mutex<Vec<String>>> = Arc::default();
    let (_replay, _restarted, _reopened) = reopened(saved, &handle.id, &replayed).await;
    eventually_on!(&[&_reopened.cell.stepped], || (replayed.lock().unwrap().iter().any(|text| text == "second")).then_some(())).await;
}

#[tokio::test(start_paused = true)]
async fn every_crash_prefix_of_a_saved_stop_keeps_its_work_from_running() {
    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let (_directory, handle, io) = reading_second(&rig, &seen).await;
    let qid = second_qid(&rig, &handle.id);
    let before = rig.store.records(&handle.id).len();
    let reply = awaiting(|| "the Stop's reply".to_owned(), stop_result(&handle)).await.expect("stop task").expect("saved");
    assert_eq!(reply["aborted"], json!(true));
    // The reply came only after the complete disposition was on disk: the one record that carries it.
    let (sid, body) = stop_records(&rig, &handle.id).pop().expect("the Stop's record is durable before its success");
    assert_eq!(body["queues"], json!([qid]), "{body}");
    assert!(settled_records(&rig, &handle.id).is_empty(), "the outcome is still owed: the read is held");
    let log: Vec<Record> = rig.store.records(&handle.id).into_iter().map(|(_, record)| record).collect();
    // The lane hold is this thread's, which the fresh processes below run on too: the old process's read ends first.
    drop(io);
    eventually_on!(&[&handle.cell.stepped], || logged(&handle, "start:stopped:").then_some(())).await;
    assert!(!seen.lock().unwrap().iter().any(|text| text == "second"), "the old process never ran it either");
    for cut in before..=log.len() {
        let prefix = log[..cut].to_vec();
        let holds_stop = prefix.iter().any(|record| matches!(record, Record::WorkStop(stop) if stop.sid.as_str() == sid));
        let replayed: Arc<Mutex<Vec<String>>> = Arc::default();
        let (replay, restarted, reopened) = reopened(prefix, &handle.id, &replayed).await;
        let admitted = replayed.lock().unwrap().iter().filter(|text| *text == "second").count();
        if holds_stop {
            assert_eq!(admitted, 0, "prefix {cut}: a persisted Stop keeps its work from running");
            assert!(!ledger(&reopened).iter().any(|event| event.starts_with("run:admitted:")), "prefix {cut}: {:?}", ledger(&reopened));
            // Recovered, the hand-back is offered once more under its record's id, then settled.
            assert_eq!(restore_ids(&replay, &reopened), [recorded_restore_id(&body)], "prefix {cut}: the hand-back is offered once");
            eventually_on!(&[&reopened.cell.stepped], || (settled_records(&replay, &handle.id) == [sid.clone()]).then_some(())).await;
        }
        restarted.shutdown().await;
    }
}

/// The control: without a Stop, a queued prompt saved before a restart is recovered and runs on resume.
#[tokio::test(start_paused = true)]
async fn without_a_stop_a_saved_queued_prompt_runs_after_a_restart() {
    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let gate = Arc::new(Notify::new());
    rig.set_script(provider(seen.clone(), gate.clone()));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    super::tests::turn(&handle, "first", "op-1").await;
    assert_eq!(super::tests::turn(&handle, "second", "op-2").await["kind"], "queued");
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    let saved: Vec<Record> = rig.store.records(&handle.id).into_iter().map(|(_, record)| record).collect();
    let replayed: Arc<Mutex<Vec<String>>> = Arc::default();
    let (_replay, _restarted, reopened) = reopened(saved, &handle.id, &replayed).await;
    eventually_on!(&[&reopened.cell.stepped], || (replayed.lock().unwrap().iter().any(|text| text == "second")).then_some(())).await;
    gate.notify_one();
}

#[tokio::test(start_paused = true)]
async fn a_hand_back_through_the_state_is_offered_once_more_under_the_same_id_after_a_restart_and_settled() {
    let rig = Rig::new();
    let emit = Arc::new(Notify::new());
    let (_directory, handle) = running(&rig, &emit).await;
    start(&handle).await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    let reply = awaiting(|| "the other device's Stop".to_owned(), stop_from(&handle, 2)).await.expect("stop task");
    assert_eq!((reply["aborted"].clone(), reply["restoreText"].clone()), (json!(true), json!("")), "the canceller gets nothing: {reply}");
    // The run waits for its output signal before it sees the abort.
    emit.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    let (sid, body) = stop_records(&rig, &handle.id).pop().expect("the Stop's record");
    assert_eq!(body["restore"]["device"], json!("desktop-1"), "{body}");
    let id = recorded_restore_id(&body);
    assert_eq!(restore_ids(&rig, &handle), [id.clone()], "the live notification carries the record's id");
    assert!(id.ends_with("-sub1"), "Node's format, naming the submission: {id}");
    assert_eq!(settled_records(&rig, &handle.id), [sid.clone()], "rewound and offered: settled");
    assert!(!rows(&handle).contains(&("user", "draft".to_owned())), "the live close rewound the prompt");
    // A crash after the record, before the settlement: the log cut before `settled`.
    let log: Vec<Record> = rig.store.records(&handle.id).into_iter().map(|(_, record)| record).collect();
    let cut = log.iter().position(|record| matches!(record, Record::WorkStop(stop) if stop.phase == WorkStopPhase::Settled)).expect("the settlement");
    let replayed: Arc<Mutex<Vec<String>>> = Arc::default();
    let (replay, _restarted, recovered) = reopened(log[..cut].to_vec(), &handle.id, &replayed).await;
    assert_eq!(restore_ids(&replay, &recovered), [id.clone()], "offered once more under the same id: one insertion");
    let offered = recovered.cell.view.load_full();
    assert_eq!(offered.state.prompt_restore.as_ref().map(|restore| restore.id.clone()), Some(id), "a connecting composer reads it from the state");
    eventually_on!(&[&recovered.cell.stepped], || (settled_records(&replay, &handle.id) == [sid.clone()]).then_some(())).await;
    assert!(replayed.lock().unwrap().is_empty(), "the stopped prompt never runs");
    // A restart after the settlement offers nothing more.
    let replayed: Arc<Mutex<Vec<String>>> = Arc::default();
    let (after, _restarted, settled) = reopened(log, &handle.id, &replayed).await;
    assert!(restore_ids(&after, &settled).is_empty(), "a settled hand-back is not offered again");
}

#[tokio::test(start_paused = true)]
async fn a_crash_between_the_stops_save_and_its_cleanup_still_rewinds_the_prompt() {
    let rig = Rig::new();
    let emit = Arc::new(Notify::new());
    let (_directory, handle) = running(&rig, &emit).await;
    start(&handle).await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    let reply = awaiting(|| "the Stop's reply".to_owned(), stop_from(&handle, 1)).await.expect("stop task");
    assert_eq!(reply["restoreText"], json!("draft"), "{reply}");
    let log: Vec<Record> = rig.store.records(&handle.id).into_iter().map(|(_, record)| record).collect();
    let cut = log.iter().position(|record| matches!(record, Record::WorkStop(stop) if stop.phase == WorkStopPhase::Stopped)).expect("the Stop's record") + 1;
    let prefix = log[..cut].to_vec();
    assert!(!prefix.iter().any(|record| matches!(record, Record::Rewind(_))), "the crash came before the cleanup");
    let replayed: Arc<Mutex<Vec<String>>> = Arc::default();
    let (replay, _restarted, reopened) = reopened(prefix, &handle.id, &replayed).await;
    let sid = stop_records(&replay, &handle.id).pop().expect("the Stop").0;
    assert!(!rows(&reopened).contains(&("user", "draft".to_owned())), "the prompt left the transcript: {:?}", rows(&reopened));
    let context = replay.store.model_context(&handle.id);
    assert!(!context.iter().any(|(_, body)| body.to_string().contains("draft")), "the prompt left the model context: {context:?}");
    let reply_id = reply["restoreId"].as_str().expect("the reply names the hand-back's id").to_owned();
    assert_eq!(restore_ids(&replay, &reopened), [reply_id], "the recovered offer has the reply's id: one insertion");
    eventually_on!(&[&reopened.cell.stepped], || (settled_records(&replay, &handle.id) == [sid.clone()]).then_some(())).await;
    assert!(replayed.lock().unwrap().is_empty(), "nothing ran");
}

/// A room's user Stop of its exchange's submission Q, durably queued in a member session behind the member's unrelated held run,
/// with unrelated U queued too: the targeted stop answers once its record is durable, aborts nothing it does not own (the held
/// run goes on) and leaves U queued. After a restart Q never starts and U does.
#[tokio::test(start_paused = true)]
async fn a_room_stop_freezes_its_queued_member_prompt_and_unrelated_work_still_runs_after_a_restart() {
    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let gate = Arc::new(Notify::new());
    rig.set_script(provider(seen.clone(), gate.clone()));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    super::tests::turn(&handle, "first", "op-1").await;
    let held = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    assert_eq!(super::tests::turn(&handle, "U", "op-2").await["kind"], "queued");
    assert!(room_submit(&directory, &handle.id, "Q", "rsub_q", "exch_1").await, "the room prompt is accepted");
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 2 && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    let entry = rig.store.records(&handle.id).into_iter().find_map(|(_, record)| match record {
        Record::Queue(queue) => match queue.entry {
            Some(Slot::Inline(entry)) if entry.pointer("/options/clientSubmissionId") == Some(&json!("rsub_q")) => Some(entry),
            _ => None,
        },
        _ => None,
    });
    assert_eq!(entry.expect("Q is queued durably").pointer("/transcriptMeta/roomExchange"), Some(&json!("exch_1")), "its exchange rides the entry");
    directory.stop_work(&handle.id, vec!["rsub_q".into()]).await.expect("the member stop is saved");
    assert!(logged(&handle, "stop:durable:"), "answered after the durable record: {:?}", ledger(&handle));
    assert!(!held.cancel.is_aborted(), "the member's unrelated run is not aborted");
    assert_eq!(handle.cell.queued.load().len(), 1, "U stays queued");
    let header = rig.store.stored_header(&handle.id).expect("header");
    assert!(work_stops::stopped(&header, &work_stops::submission("rsub_q")).is_some(), "Q is terminal on disk");
    let saved: Vec<Record> = rig.store.records(&handle.id).into_iter().map(|(_, record)| record).collect();
    let replayed: Arc<Mutex<Vec<String>>> = Arc::default();
    let (_replay, _restarted, reopened) = reopened(saved, &handle.id, &replayed).await;
    // Fence: U ran and the drain after it decided its next start (none).
    eventually_on!(&[&reopened.cell.stepped], || (replayed.lock().unwrap().iter().any(|text| text == "U")
        && idle(&reopened)
        && reopened.cell.queued.load().is_empty())
    .then_some(()))
    .await;
    let passes = reopened.cell.drain_passes.load(SeqCst);
    super::tests::caught_up(&reopened).await;
    eventually_on!(&[&reopened.cell.stepped], || (reopened.cell.drain_passes.load(SeqCst) >= passes && idle(&reopened) && !reopened.cell.busy.load(SeqCst))
        .then_some(()))
    .await;
    assert!(!replayed.lock().unwrap().iter().any(|text| text == "Q"), "Q never starts: {:?}", replayed.lock().unwrap());
    gate.notify_one();
}

/// The room Stop lands before its member submission is admitted (the exchange registered it, the dispatch is held, the Stop is
/// saved, then the dispatch is released): the admission meets the terminal identity and cannot run it, now or after a restart.
#[tokio::test(start_paused = true)]
async fn a_room_stop_before_the_enqueue_keeps_the_late_admission_from_running() {
    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let gate = Arc::new(Notify::new());
    rig.set_script(provider(seen.clone(), gate.clone()));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    directory.stop_work(&handle.id, vec!["rsub_late".into()]).await.expect("the tombstone is saved");
    assert!(!room_submit(&directory, &handle.id, "late", "rsub_late", "exch_1").await, "the late admission is refused");
    super::tests::caught_up(&handle).await;
    assert!(idle(&handle) && handle.cell.queued.load().is_empty(), "nothing queued, nothing started");
    assert!(seen.lock().unwrap().is_empty());
    let saved: Vec<Record> = rig.store.records(&handle.id).into_iter().map(|(_, record)| record).collect();
    let replayed: Arc<Mutex<Vec<String>>> = Arc::default();
    let (_replay, restarted, reopened) = reopened(saved, &handle.id, &replayed).await;
    assert!(!room_submit(&restarted, &handle.id, "late", "rsub_late", "exch_1").await, "refused after a restart too");
    super::tests::caught_up(&reopened).await;
    assert!(replayed.lock().unwrap().is_empty());
}

/// The room Stop's seal latches Q in its member session before any storage: the member's held run ends and its drain decides
/// while Q's record is not written yet (its storage has not even begun), and Q does not start. The record then lands.
#[tokio::test(start_paused = true)]
async fn a_latched_room_submission_does_not_start_while_its_stop_is_not_saved_yet() {
    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let gate = Arc::new(Notify::new());
    rig.set_script(provider(seen.clone(), gate.clone()));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    super::tests::turn(&handle, "first", "op-1").await;
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    assert!(room_submit(&directory, &handle.id, "Q", "rsub_q", "exch_1").await);
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 1 && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    // The seal: synchronous, no storage.
    directory.latch_work(&handle.id, &["rsub_q".to_owned()]);
    let passes = handle.cell.drain_passes.load(SeqCst);
    gate.notify_one();
    // Fence: the held run ended and the drain after it decided its next start.
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.drain_passes.load(SeqCst) > passes && idle(&handle) && !handle.cell.busy.load(SeqCst))
        .then_some(()))
    .await;
    assert_eq!(*seen.lock().unwrap(), ["first"], "the latched submission did not start");
    assert!(stop_records(&rig, &handle.id).is_empty(), "nothing was saved yet");
    directory.stop_work(&handle.id, vec!["rsub_q".into()]).await.expect("saved");
    assert!(handle.cell.queued.load().is_empty(), "the record took its queue copy");
    assert_eq!(*seen.lock().unwrap(), ["first"]);
}

#[tokio::test(start_paused = true)]
async fn a_room_prompt_taken_at_a_boundary_is_stopped_with_the_run_that_took_it() {
    use super::run::DrainRequest;
    use super::run::DrainStage;
    use super::run::Priority;
    let rig = Rig::new();
    let (at_boundary, go) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let taken: Arc<Mutex<Vec<String>>> = Arc::default();
    // True while the run is processing the injected prompt.
    let continued = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let script: super::testing::Script = {
        let (at_boundary, go, taken, continued) = (at_boundary.clone(), go.clone(), taken.clone(), continued.clone());
        Arc::new(move |run| {
            let (at_boundary, go, taken, continued) = (at_boundary.clone(), go.clone(), taken.clone(), continued.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                at_boundary.notify_one();
                go.notified().await;
                let steers = run.port.take_steers(DrainRequest { stage: DrainStage::PreSend, max_priority: Priority::Next }).await.expect("take");
                taken.lock().unwrap().extend(steers.iter().flat_map(|steer| steer.queued_ids.iter().map(|id| id.as_str().to_owned())));
                // Processing the injected prompt until the run is stopped; it ends only then.
                run.cancel.cancelled().await;
                continued.store(false, SeqCst);
                RunOutcome::Interrupted
            })
        })
    };
    rig.set_script(script);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    handle
        .request(super::tests::request(
            "turn/start",
            json!({ "threadId": handle.id, "opId": "op-1", "input": { "prompt": "own", "options": { "clientSubmissionId": "sub-own" } } }),
            "op-1",
        ))
        .await
        .expect("started");
    awaiting(|| "the run at its boundary".to_owned(), at_boundary.notified()).await;
    let active = handle.cell.run.load_full().expect("the run");
    assert!(room_submit(&directory, &handle.id, "Q", "rsub_q", "exch_1").await);
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 1 && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    go.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (!taken.lock().unwrap().is_empty() && handle.cell.queued.load().is_empty()).then_some(())).await;
    directory.stop_work(&handle.id, vec!["rsub_q".into()]).await.expect("saved");
    assert!(active.cancel.is_aborted(), "success is reported only with the run that took the prompt stopped");
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;
    assert!(!continued.load(SeqCst), "the run stopped processing the prompt");
    let header = rig.store.stored_header(&handle.id).expect("header");
    assert!(work_stops::stopped(&header, &work_stops::submission("rsub_q")).is_some(), "the injected prompt is terminal");
    assert!(work_stops::stopped(&header, &work_stops::submission("sub-own")).is_none(), "the run's own submission is not made terminal");
}

/// Every run's prompt as it reaches the provider, with whether its token was already aborted then; a run of `first` waits for
/// `gate`, any other waits to be stopped.
fn noting_provider(seen: Arc<Mutex<Vec<(String, bool)>>>, gate: Arc<Notify>) -> super::testing::Script {
    Arc::new(move |run| {
        let (seen, gate) = (seen.clone(), gate.clone());
        Box::pin(async move {
            let text = text_of(&run.input);
            seen.lock().unwrap().push((text.clone(), run.cancel.is_cancelled()));
            if text == "first" {
                gate.notified().await;
                let _ = run.port.input_durable().await;
                return RunOutcome::Completed(Default::default());
            }
            run.cancel.cancelled().await;
            RunOutcome::Interrupted
        })
    })
}

#[tokio::test(start_paused = true)]
async fn a_seal_between_the_final_check_and_the_spawn_never_leaves_the_work_running() {
    for at in ["check", "gate"] {
        let rig = Rig::new();
        let seen: Arc<Mutex<Vec<(String, bool)>>> = Arc::default();
        let gate = Arc::new(Notify::new());
        rig.set_script(noting_provider(seen.clone(), gate.clone()));
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        super::tests::turn(&handle, "first", "op-1").await;
        eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
        assert!(room_submit(&directory, &handle.id, "Q", "rsub_q", "exch_1").await);
        eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 1 && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
        // The seal, landing at the start's fence `at` (on the actor's own step: exactly between the two points).
        let (latches, thread, sealed) = (handle.cell.stop_latches.clone(), handle.id.clone(), Arc::new(std::sync::atomic::AtomicBool::new(false)));
        let fired = sealed.clone();
        *handle.cell.start_fences.lock().unwrap() = Some(Arc::new(move |fence| {
            if fence == at && !fired.swap(true, SeqCst) {
                let abort = mixdog_agent::cancel::Abort::runtime_abort(thread.as_str(), mixdog_agent::cancel::USER_CANCEL);
                latches.latch(&thread, [work_stops::submission("rsub_q")], &abort);
            }
        }));
        gate.notify_one();
        eventually_on!(&[&handle.cell.stepped], || sealed.load(SeqCst).then_some(())).await;
        directory.stop_work(&handle.id, vec!["rsub_q".into()]).await.expect("saved");
        eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;
        let reached: Vec<(String, bool)> = seen.lock().unwrap().iter().filter(|(text, _)| text != "first").cloned().collect();
        match at {
            "check" => assert!(reached.is_empty(), "{at}: a latched start never runs: {reached:?}"),
            _ => assert!(reached.iter().all(|(_, aborted)| *aborted), "{at}: a started target is aborted before it runs: {reached:?}"),
        }
        let header = rig.store.stored_header(&handle.id).expect("header");
        assert!(work_stops::stopped(&header, &work_stops::submission("rsub_q")).is_some(), "{at}");
    }
}

/// The start gate's one lock: a start and a latch of the same identity racing on two threads always end in one of the two
/// allowed outcomes, never a registered start the latch did not see.
#[test]
fn a_start_racing_the_latch_is_refused_or_aborted() {
    let thread = ThreadId::from("sess_race".to_owned());
    for round in 0..2000 {
        let latches = Arc::new(super::control::StopLatches::default());
        let token = mixdog_rt::CancellationToken::new();
        let cancel = mixdog_agent::cancel::Cancel::from_token(&token);
        let turn = mixdog_core_api::ids::TurnId::from(format!("t{round}"));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let starter = {
            let (latches, thread, barrier, cancel, turn) = (latches.clone(), thread.clone(), barrier.clone(), cancel.clone(), turn.clone());
            std::thread::spawn(move || {
                barrier.wait();
                latches.begin(&thread, &turn, &[work_stops::submission("x")], &cancel)
            })
        };
        let latcher = {
            let (latches, thread, barrier) = (latches.clone(), thread.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                let abort = mixdog_agent::cancel::Abort::runtime_abort(thread.as_str(), mixdog_agent::cancel::USER_CANCEL);
                latches.latch(&thread, [work_stops::submission("x")], &abort)
            })
        };
        let started = starter.join().unwrap();
        let saw = latcher.join().unwrap();
        assert!(!started || (saw && cancel.is_aborted()), "round {round}: started {started}, latch saw it {saw}");
        assert!(started || !saw, "round {round}: a refused start is not running");
    }
}

/// A completion wake (queue identities, no submission) takes room submission X at a boundary; a targeted Stop of X aborts the
/// run, freezes X alone, and leaves the completion's identities non-terminal (no stopped mark).
#[tokio::test(start_paused = true)]
async fn a_targeted_stop_of_a_prompt_injected_into_a_completion_wake_freezes_only_that_prompt() {
    use super::run::DrainRequest;
    use super::run::DrainStage;
    use super::run::Priority;
    let rig = Rig::new();
    let (at_boundary, go) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let taken: Arc<Mutex<Vec<String>>> = Arc::default();
    let script: super::testing::Script = {
        let (at_boundary, go, taken) = (at_boundary.clone(), go.clone(), taken.clone());
        Arc::new(move |run| {
            let (at_boundary, go, taken) = (at_boundary.clone(), go.clone(), taken.clone());
            Box::pin(async move {
                let _ = run.port.input_durable().await;
                at_boundary.notify_one();
                go.notified().await;
                let steers = run.port.take_steers(DrainRequest { stage: DrainStage::PreSend, max_priority: Priority::Next }).await.expect("take");
                taken.lock().unwrap().extend(steers.iter().flat_map(|steer| steer.queued_ids.iter().map(|id| id.as_str().to_owned())));
                run.cancel.cancelled().await;
                RunOutcome::Interrupted
            })
        })
    };
    rig.set_script(script);
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    directory.queue_completion_durably(&handle.id, "shell", "job-c", "completed", "job-c finished.".into()).await.expect("queued");
    awaiting(|| "the completion wake at its boundary".to_owned(), at_boundary.notified()).await;
    let completion = rig.store.records(&handle.id).into_iter().find_map(|(_, record)| match record {
        Record::Queue(queue) if queue.qid.as_str().starts_with("completion_") => Some(queue.qid.as_str().to_owned()),
        _ => None,
    });
    let completion = completion.expect("the completion's queue id");
    assert!(room_submit(&directory, &handle.id, "X", "rsub_x", "exch_1").await);
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.queued.load().len() == 1 && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    go.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (!taken.lock().unwrap().is_empty() && handle.cell.queued.load().is_empty()).then_some(())).await;
    let active = handle.cell.run.load_full().expect("the wake");
    directory.stop_work(&handle.id, vec!["rsub_x".into()]).await.expect("saved");
    assert!(active.cancel.is_aborted(), "the run carrying X is aborted");
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;
    let header = rig.store.stored_header(&handle.id).expect("header");
    assert!(work_stops::stopped(&header, &work_stops::submission("rsub_x")).is_some(), "X is terminal");
    assert!(work_stops::stopped(&header, &work_stops::queued(&completion)).is_none(), "the completion's identity is not made terminal");
    let (_, body) = stop_records(&rig, &handle.id).pop().expect("the Stop's record");
    assert!(!body.to_string().contains(&completion), "the record names X's unit only: {body}");
}

/// A latch exists only until the durable record protects its identity: once the member's `work_stop` is acknowledged and
/// folded, the latch is released, and a redelivery of the submission is refused by the durable mark alone.
#[tokio::test(start_paused = true)]
async fn a_latch_is_released_once_its_record_folds_and_the_durable_mark_refuses_a_redelivery() {
    let rig = Rig::new();
    rig.set_script(provider(Arc::default(), Arc::new(Notify::new())));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    directory.latch_work(&handle.id, &["rsub_r".to_owned()]);
    assert_eq!(handle.cell.stop_latches.latched_count(&handle.id), 1);
    directory.stop_work(&handle.id, vec!["rsub_r".into()]).await.expect("saved");
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.stop_latches.latched_count(&handle.id) == 0).then_some(())).await;
    let header = rig.store.stored_header(&handle.id).expect("header");
    assert!(work_stops::stopped(&header, &work_stops::submission("rsub_r")).is_some(), "the durable mark took over");
    assert!(!room_submit(&directory, &handle.id, "R", "rsub_r", "exch_1").await, "the redelivery is refused by the durable mark");
    super::tests::caught_up(&handle).await;
    assert!(idle(&handle) && handle.cell.queued.load().is_empty());
}

/// Duplicate Stops of a completion wake and the same completion delivered again, before and after a reload, join one disposition:
/// one Stop record, no second run, no hand-back.
#[tokio::test(start_paused = true)]
async fn duplicate_stops_and_a_redelivered_completion_join_one_disposition() {
    let rig = Rig::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let noted = seen.clone();
    // The stopped run lingers until the test lets it end, so both Stops find it running.
    let linger = Arc::new(Notify::new());
    let end = linger.clone();
    rig.set_script(Arc::new(move |run| {
        let (noted, end) = (noted.clone(), end.clone());
        Box::pin(async move {
            noted.lock().unwrap().push(text_of(&run.input));
            run.cancel.cancelled().await;
            end.notified().await;
            RunOutcome::Interrupted
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    directory.queue_completion_durably(&handle.id, "shell", "job-1", "completed", "job-1 finished.".into()).await.expect("queued");
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    let first = awaiting(|| "the Stop's reply".to_owned(), stop(&handle)).await.expect("stop task");
    let again = awaiting(|| "the repeated Stop's reply".to_owned(), stop(&handle)).await.expect("stop task");
    assert_eq!((first["aborted"].clone(), again["aborted"].clone()), (json!(true), json!(true)));
    assert_eq!(ledger(&handle).iter().filter(|event| event.starts_with("stop:frozen:")).count(), 1, "the second Stop joined the first");
    linger.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.cell.busy.load(SeqCst)).then_some(())).await;
    directory.queue_completion_durably(&handle.id, "shell", "job-1", "completed", "job-1 finished.".into()).await.expect("the redelivery is consumed");
    drained_after(&handle, "stop:settled:").await;
    assert_eq!(seen.lock().unwrap().len(), 1, "no second run");
    assert_eq!(stop_records(&rig, &handle.id).len(), 1, "one disposition");
    assert!(handle.cell.queued.load().is_empty(), "the redelivered completion was not queued");
    // After a reload: the same delivery is consumed again, nothing runs, nothing is handed back.
    let saved: Vec<Record> = rig.store.records(&handle.id).into_iter().map(|(_, record)| record).collect();
    let replayed: Arc<Mutex<Vec<String>>> = Arc::default();
    let (replay, restarted, reopened) = reopened(saved, &handle.id, &replayed).await;
    restarted.queue_completion_durably(&handle.id, "shell", "job-1", "completed", "job-1 finished.".into()).await.expect("consumed after the reload");
    super::tests::caught_up(&reopened).await;
    assert!(idle(&reopened) && !reopened.cell.busy.load(SeqCst), "nothing started");
    assert!(replayed.lock().unwrap().is_empty(), "no run after the reload");
    assert_eq!(stop_records(&replay, &handle.id).len(), 1);
    assert!(restores(&replay, &reopened).is_empty(), "a cancelled completion owes no hand-back");
    assert!(reopened.cell.queued.load().is_empty());
}

/// The output commits while the Stop stands between its reads and its decision: the decision sees it (Node's "output already
/// produced"), the prompt stays in the transcript.
#[tokio::test]
async fn an_output_that_commits_while_the_stop_is_reading_hands_nothing_back() {
    let rig = Rig::new();
    let emit = Arc::new(Notify::new());
    let (_directory, handle) = running(&rig, &emit).await;
    start(&handle).await;
    let prompt = handle.cell.run.load_full().expect("the run").prompt.clone();
    let (reached, go) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *prompt.pause.lock().unwrap() = Some((reached.clone(), go.clone()));
    let stopped = stop(&handle);
    awaiting(|| "the Stop to stand between its reads and its decision".to_owned(), reached.notified()).await;
    emit.notify_one();
    eventually_on!(&[&handle.cell.stepped], || prompt.snapshot().committed.then_some(())).await;
    go.notify_one();
    let reply = awaiting(|| "the Stop's reply".to_owned(), stopped).await.expect("stop task");
    stop_answered(&reply, "", &[]);
    assert_eq!(*prompt.between.lock().unwrap(), Some(false), "no output commit could land between the Stop's decision and its record");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert!(rows(&handle).contains(&("user", "draft".to_owned())), "the prompt stays: {:?}", rows(&handle));
}

/// The Stop decides first and the output commits after: the hand-back stands (Node's "prompt handed back"), and the prompt leaves.
#[tokio::test]
async fn an_output_that_commits_after_the_stop_decided_does_not_take_the_hand_back_away() {
    let rig = Rig::new();
    let emit = Arc::new(Notify::new());
    let (_directory, handle) = running(&rig, &emit).await;
    start(&handle).await;
    let prompt = handle.cell.run.load_full().expect("the run").prompt.clone();
    let (reached, go) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *prompt.pause.lock().unwrap() = Some((reached.clone(), go.clone()));
    let stopped = stop(&handle);
    awaiting(|| "the Stop to stand between its reads and its decision".to_owned(), reached.notified()).await;
    go.notify_one();
    let reply = awaiting(|| "the Stop's reply".to_owned(), stopped).await.expect("stop task");
    stop_answered(&reply, "draft", &["sub1"]);
    assert_eq!(*prompt.between.lock().unwrap(), Some(false), "no output commit could land between the Stop's decision and its record");
    emit.notify_one();
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    assert!(rows(&handle).is_empty(), "the prompt left: {:?}", rows(&handle));
}
