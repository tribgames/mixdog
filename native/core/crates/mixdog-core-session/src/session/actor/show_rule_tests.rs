//! The show rule (`outbox.rs`) against a slow disk. One turn is played as Node's loop emits it, nothing waiting for a save
//! (`tool-phase.mjs`, `turn.mjs` `toolHandlers`): at `T0` the response ends with a call (`onToolCall` opens its card, the
//! assistant row is committed) and its tool starts (`onToolPhaseStarted`); at `T0 + 15` the tool completes (`onToolResult`,
//! its result row); at `T0 + 30` the answer streams. The disk takes no write until `T0 + DISK`. Node showed each at the time
//! it happened; a failed save left them shown and kept them for the next save (`turn-durability.mjs`, the `save-failure`
//! recording); a crash reopens on what the disk holds.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering::SeqCst;

use mixdog_app_protocol::v2::thread::ToolBatchPhase;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::ids::ItemId;
use mixdog_protocol::ThreadItem;
use mixdog_store::schema::blob::Slot;
use mixdog_store::schema::record::Record;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;

use crate::session::RunOutcome;
use crate::session::SessionDirectory;
use crate::session::SessionHandle;
use crate::session::run::ItemCommit;
use crate::session::testing::Rig;
use crate::session::tests::caught_up;
use crate::session::tests::echo;
use crate::session::tests::idle;
use crate::session::tests::start_thread;
use crate::session::tests::turn;

const T0: u64 = 10_000;
/// How long the disk takes the turn's first write.
const DISK: u64 = 400;

#[tokio::test(start_paused = true)]
async fn early_result_preparation_starts_behind_a_held_row_read_but_end_waits_for_both() {
    let rig = Rig::new();
    let ready = Arc::new(tokio::sync::Notify::new());
    let go = Arc::new(tokio::sync::Notify::new());
    rig.set_script(Arc::new({
        let (ready, go) = (ready.clone(), go.clone());
        move |run| {
            let (ready, go) = (ready.clone(), go.clone());
            Box::pin(async move {
                run.port.input_durable().await.unwrap();
                ready.notify_one();
                go.notified().await;
                let row = ItemCommit { iid: ItemId::from("reply"), role: Some("assistant".into()), model: true, visible: true, body: json!({"text":"answer"}), prompt: None };
                drop(run.port.queue_item(row).await.unwrap());
                run.port.early_result(json!({"role":"tool","toolCallId":"c","content":"finished"})).await.unwrap();
                RunOutcome::Completed(Default::default())
            })
        }
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "go", "go-op").await;
    ready.notified().await;
    caught_up(&handle).await;
    let io = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo);
    let cpu = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::CpuInteractive);
    go.notify_one();
    crate::session::testing::awaiting(|| "both preparations to start without either lane free".into(), async {
        tokio::join!(io.met_by_a_submit(), cpu.met_by_a_submit());
    }).await;
    drop(cpu);
    assert!(!idle(&handle), "the end cannot pass the unread commit");
    drop(io);
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    assert!(rig.store.records(&handle.id).into_iter().any(|(_, record)| matches!(record, Record::Item(ref row) if row.iid.as_str() == "reply")));
}

/// The turn of the module doc, one step per go of the test.
struct Played {
    rig: Rig,
    _directory: SessionDirectory,
    handle: Arc<SessionHandle>,
    /// The disk, held: no write lands until it is dropped.
    full: Option<mixdog_rt::testing::HeldFull>,
    sent: mpsc::UnboundedReceiver<()>,
    go: mpsc::UnboundedSender<()>,
    /// What a client was shown of the turn, each at the scripted time it first saw it.
    timeline: Vec<(&'static str, u64)>,
}

impl Played {
    /// The turn has started and its start is on disk; the disk is held from here on.
    async fn new() -> Self {
        let rig = Rig::new();
        let (sent_tx, sent) = mpsc::unbounded_channel();
        let (go, go_rx) = mpsc::unbounded_channel();
        let steps = Arc::new(Mutex::new(Some((sent_tx, go_rx))));
        let clock = rig.clock.clone();
        rig.set_script(Arc::new(move |run| {
            let (steps, clock) = (steps.clone(), clock.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let Some((sent, mut go)) = steps.lock().unwrap().take() else { return RunOutcome::Completed(Default::default()) };
                let row = |iid: String, role: &str, body: Value| ItemCommit { iid: ItemId::from(iid), role: Some(role.into()), model: true, visible: true, body, prompt: None };
                let _ = sent.send(());
                go.recv().await;
                clock.0.store(T0, SeqCst);
                let call = json!({ "id": "c1", "name": "shell", "arguments": { "command": "ls" } });
                let (port, item) = (run.port.clone(), row(format!("a-{}", run.turn), "assistant", json!({ "text": "listing", "toolCalls": [call] })));
                let call_row = tokio::spawn(async move { port.commit_item(item).await });
                let _ = sent.send(());
                go.recv().await;
                run.port.tool_batch(1, ToolBatchPhase::Started, None).await.expect("the tool starts");
                let _ = sent.send(());
                go.recv().await;
                clock.0.store(T0 + 15, SeqCst);
                let (port, item) = (run.port.clone(), row(format!("t-{}", run.turn), "tool", json!({ "toolCallId": "c1", "text": "a.txt" })));
                let result_row = tokio::spawn(async move { port.commit_item(item).await });
                let _ = sent.send(());
                go.recv().await;
                clock.0.store(T0 + 30, SeqCst);
                run.port.delta(ItemId::from("reply"), "Done.".into()).await.expect("the answer streams");
                let _ = sent.send(());
                go.recv().await;
                // A failed save does not fail the turn: its rows are kept for the next save.
                call_row.await.expect("the call's task").expect("the call row is kept");
                result_row.await.expect("the result's task").expect("the result row is kept");
                RunOutcome::Completed(Default::default())
            })
        }));
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        turn(&handle, "first task", "op-1").await;
        let mut played = Self { rig, _directory: directory, handle, full: None, sent, go, timeline: Vec::new() };
        crate::session::testing::awaiting(|| "the run's start".to_owned(), played.sent.recv()).await;
        crate::eventually_on!(&[&played.handle.cell.stepped], || (played.handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
        played.full = Some(mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::DurabilityIo));
        played
    }

    /// The run takes its next step; once the session has taken all it sent, what the client was shown is noted.
    async fn step(&mut self) {
        self.go.send(()).expect("the run waits");
        crate::session::testing::awaiting(|| "the run's step".to_owned(), self.sent.recv()).await;
        // The producers are read before the inbox, and an encode's result before both: the step's records are encoded.
        caught_up(&self.handle).await;
        self.note();
    }

    /// The four steps, the disk still held: the call's write is at the disk, and none of the turn's has landed.
    async fn play(&mut self) {
        self.step().await;
        self.full.as_ref().expect("the disk is held").met_by_a_submit().await;
        for _ in 0..3 {
            self.step().await;
        }
        assert!(self.handle.cell.unacked.load(SeqCst) > 0, "no write of the turn has landed");
    }

    fn note(&mut self) {
        let at = self.rig.clock.0.load(SeqCst);
        for name in shown(&self.rig, &self.handle) {
            if !self.timeline.iter().any(|(seen, _)| *seen == name) {
                self.timeline.push((name, at));
            }
        }
    }
}

/// What the feed showed of the turn, in the order it first showed each.
fn shown(rig: &Rig, handle: &SessionHandle) -> Vec<&'static str> {
    let mut out = Vec::new();
    for (_, method, params) in rig.feeds.frames(handle.id.as_str()) {
        let card = params["item"]["id"] == "call:c1";
        let name = match method.as_str() {
            "item/completed" if card && params["item"]["run"]["completedAt"].is_null() => "card",
            "item/completed" if card => "result",
            "thread/runtime/updated" if params["value"]["activeToolSummary"].is_string() => "running",
            "thread/toolBatch/updated" if params["phase"] == "started" => "tool started",
            "item/agentMessage/delta" if params["delta"] == "Done." => "text",
            _ => continue,
        };
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// The item texts the store holds, empty ones left out.
fn stored(rig: &Rig, handle: &SessionHandle) -> Vec<String> {
    rig.store
        .records(&handle.id)
        .into_iter()
        .filter_map(|(_, record)| match record {
            Record::Item(item) => match item.body {
                Slot::Inline(body) => body.get("text").or_else(|| body.get("content")).and_then(Value::as_str).map(str::to_owned),
                Slot::Blob(_) => None,
            },
            _ => None,
        })
        .filter(|text| !text.is_empty())
        .collect()
}

/// The ids of the items the feed completed, in the order it first showed each.
fn completed_ids(rig: &Rig, handle: &SessionHandle) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, method, params) in rig.feeds.frames(handle.id.as_str()) {
        let id = params["item"]["id"].as_str().unwrap_or_default().to_owned();
        if method == "item/completed" && !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Every item of the turn reaches the feed when it happens, however long its record takes to reach the disk: none waits
/// for an ack (before the rule each waited for the first write's, all at `T0 + DISK`).
#[tokio::test(start_paused = true)]
async fn a_slow_disk_delays_no_item_of_the_turn() {
    let mut played = Played::new().await;
    played.play().await;
    played.rig.clock.0.store(T0 + DISK, SeqCst);
    drop(played.full.take());
    played.go.send(()).expect("the run waits");
    crate::eventually_on!(&[&played.handle.cell.stepped], || (idle(&played.handle) && played.handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    played.note();
    for (name, at) in &played.timeline {
        eprintln!("{name}: shown at T0 + {} (the disk acked at T0 + {DISK})", at - T0);
    }
    assert_eq!(played.timeline, [("card", T0), ("running", T0), ("tool started", T0), ("result", T0 + 15), ("text", T0 + 30)]);
    assert_eq!(stored(&played.rig, &played.handle), ["first task", "listing", "a.txt"], "every row is written, in order");
}

/// A save that fails after its items were shown withdraws none of them: they stay shown, the save failure is told, the turn
/// goes on, and the next save writes them before the next turn (Node keeps the session in memory, `turn-durability.mjs`).
#[tokio::test(start_paused = true)]
async fn a_failed_save_withdraws_nothing_it_showed_and_the_next_writes_it() {
    let mut played = Played::new().await;
    played.play().await;
    assert_eq!(played.timeline.len(), 5, "everything was shown before the save: {:?}", played.timeline);
    *played.rig.store.failing.lock().unwrap() = Some("EIO: injected".into());
    drop(played.full.take());
    played.go.send(()).expect("the run waits");
    let rig = &played.rig;
    let handle = played.handle.clone();
    crate::eventually_on!(&[&rig.notices.1], || rig.notices.0.lock().unwrap().iter().any(|notice| notice == "save-failed").then_some(())).await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.turn_busy()).then_some(())).await;
    assert_eq!(stored(rig, &handle), ["first task"], "nothing of the failed save is on disk");
    let view = handle.cell.view.load_full();
    let card = view.items.iter().find(|item| item.id().as_str() == "call:c1").expect("the card stays shown");
    let ThreadItem::ToolCall { run, .. } = card.as_ref() else { panic!("a tool call: {card:?}") };
    assert_eq!(run.completed_at, Some(10_015), "with its result");

    *rig.store.failing.lock().unwrap() = None;
    turn(&handle, "second task", "op-2").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && stored(rig, &handle).contains(&"second task".to_owned())).then_some(())).await;
    assert_eq!(stored(rig, &handle), ["first task", "listing", "a.txt", "second task"]);
}

/// The text of call `c1`'s card in view, and whether it is complete; `None` before the card is shown.
fn card_result(handle: &SessionHandle) -> Option<(Option<String>, bool)> {
    let view = handle.cell.view.load_full();
    let card = view.items.iter().find(|item| item.id().as_str() == "call:c1")?;
    let ThreadItem::ToolCall { run, .. } = card.as_ref() else { panic!("a tool call: {card:?}") };
    let text = match &run.result {
        Some(mixdog_protocol::MaybeBlob::Inline(text)) => Some(text.clone()),
        _ => None,
    };
    Some((text, run.completed_at.is_some()))
}

/// The results the feed completed call `c1`'s card with, in order.
fn card_results(rig: &Rig, handle: &SessionHandle) -> Vec<String> {
    rig.feeds
        .frames(handle.id.as_str())
        .into_iter()
        .filter(|(_, method, params)| method == "item/completed" && params["item"]["id"] == "call:c1")
        .filter_map(|(_, _, params)| params["item"]["run"]["result"].as_str().map(str::to_owned))
        .collect()
}

/// An early result is kept until its card is shown, and the committed result is the call's final one (Node's `onToolResult`
/// closes a card once, `__earlyNotify`): the tool finished before the response's row was taken in, so its card is shown
/// already closed; the committed result replaces it; an early result arriving after that changes nothing.
#[tokio::test(start_paused = true)]
async fn an_early_result_waits_for_its_card_and_never_follows_the_committed_one() {
    let rig = Rig::new();
    let (sent_tx, mut sent) = mpsc::unbounded_channel();
    let (go, go_rx) = mpsc::unbounded_channel::<()>();
    let steps = Arc::new(Mutex::new(Some((sent_tx, go_rx))));
    rig.set_script(Arc::new(move |run| {
        let steps = steps.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let Some((sent, mut go)) = steps.lock().unwrap().take() else { return RunOutcome::Completed(Default::default()) };
            let row = |iid: String, role: &str, body: Value| ItemCommit { iid: ItemId::from(iid), role: Some(role.into()), model: true, visible: true, body, prompt: None };
            let call = json!({ "id": "c1", "name": "shell", "arguments": { "command": "ls" } });
            run.port.early_result(json!({ "toolCallId": "c1", "text": "early" })).await.expect("the early result");
            run.port.commit_item(row(format!("a-{}", run.turn), "assistant", json!({ "text": "listing", "toolCalls": [call] }))).await.expect("the call row");
            let _ = sent.send(());
            go.recv().await;
            run.port.commit_item(row(format!("t-{}", run.turn), "tool", json!({ "toolCallId": "c1", "text": "final" }))).await.expect("the result row");
            run.port.early_result(json!({ "toolCallId": "c1", "text": "late" })).await.expect("a late early result");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first task", "op-1").await;
    crate::session::testing::awaiting(|| "the call row".to_owned(), sent.recv()).await;
    crate::eventually_on!(&[&handle.cell.stepped], || card_result(&handle).is_some_and(|card| card.1).then_some(())).await;
    assert_eq!(card_result(&handle), Some((Some("early".to_owned()), true)), "the card is shown closed by the result that came first");
    go.send(()).expect("the run waits");
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    assert_eq!(card_result(&handle), Some((Some("final".to_owned()), true)), "the committed result is final");
    assert_eq!(card_results(&rig, &handle).last().map(String::as_str), Some("final"), "no early result follows the committed one");
    assert!(!card_results(&rig, &handle).contains(&"late".to_owned()), "the late early result was dropped");
    drop(directory);
}

/// The text streamed before a tool call is final when the call starts (`settleSegmentBeforeToolCall`), not when the
/// response's row commits: `item/completed` with the text so far goes out at once, and the committed row of the same item
/// takes its place, one row.
#[tokio::test(start_paused = true)]
async fn the_text_before_a_tool_call_is_final_when_the_call_starts() {
    let rig = Rig::new();
    let (sent_tx, mut sent) = mpsc::unbounded_channel();
    let (go, go_rx) = mpsc::unbounded_channel::<()>();
    let steps = Arc::new(Mutex::new(Some((sent_tx, go_rx))));
    rig.set_script(Arc::new(move |run| {
        let steps = steps.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let Some((sent, mut go)) = steps.lock().unwrap().take() else { return RunOutcome::Completed(Default::default()) };
            let id = ItemId::from("seg");
            let started = ThreadItem::AgentMessage { id: id.clone(), text: mixdog_protocol::MaybeBlob::Inline(String::new()), imported_tool_runs: Vec::new(), meta: Default::default() };
            run.port.item_started(started).await.expect("the text starts");
            run.port.delta(id.clone(), "listing".into()).await.expect("the text streams");
            run.port.text_settled(id.clone()).await.expect("the call starts");
            let _ = sent.send(());
            go.recv().await;
            let call = json!({ "id": "c1", "name": "shell", "arguments": { "command": "ls" } });
            let row = ItemCommit { iid: id, role: Some("assistant".into()), model: true, visible: true, body: json!({ "text": "listing", "toolCalls": [call] }), prompt: None };
            run.port.commit_item(row).await.expect("the call row");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first task", "op-1").await;
    crate::session::testing::awaiting(|| "the call's start".to_owned(), sent.recv()).await;
    let final_text = |rig: &Rig| {
        rig.feeds
            .frames(handle.id.as_str())
            .into_iter()
            .filter(|(_, method, params)| method == "item/completed" && params["item"]["id"] == "seg")
            .map(|(_, _, params)| params["item"]["text"].clone())
            .collect::<Vec<Value>>()
    };
    crate::eventually_on!(&[&handle.cell.stepped], || (!final_text(&rig).is_empty()).then_some(())).await;
    assert_eq!(final_text(&rig), [json!("listing")], "final before the row is committed");
    go.send(()).expect("the run waits");
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    let view = handle.cell.view.load_full();
    assert_eq!(view.items.iter().filter(|item| item.id().as_str() == "seg").count(), 1, "the committed row took the settled row's place");
    drop(directory);
}

/// The settle of a segment reaches the session after its reply's commit (the run hands them on apart: its shown events and
/// its rows), while the committed row is still encoding: the segment shows no row of its own, the reply's row is its one row.
#[tokio::test(start_paused = true)]
async fn a_text_settled_after_its_reply_committed_adds_no_second_row() {
    let rig = Rig::new();
    let (sent_tx, mut sent) = mpsc::unbounded_channel();
    let (go, go_rx) = mpsc::unbounded_channel::<()>();
    let steps = Arc::new(Mutex::new(Some((sent_tx, go_rx))));
    rig.set_script(Arc::new(move |run| {
        let steps = steps.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let Some((sent, mut go)) = steps.lock().unwrap().take() else { return RunOutcome::Completed(Default::default()) };
            let id = ItemId::from("seg");
            let started = ThreadItem::AgentMessage { id: id.clone(), text: mixdog_protocol::MaybeBlob::Inline(String::new()), imported_tool_runs: Vec::new(), meta: Default::default() };
            run.port.item_started(started).await.expect("the text starts");
            run.port.delta(id.clone(), "listing".into()).await.expect("the text streams");
            let _ = sent.send(());
            go.recv().await;
            let call = json!({ "id": "c1", "name": "shell", "arguments": { "command": "ls" } });
            let row = ItemCommit { iid: id.clone(), role: Some("assistant".into()), model: true, visible: true, body: json!({ "text": "listing", "toolCalls": [call] }), prompt: None };
            let queued = run.port.queue_item(row).await.expect("the call row");
            run.port.text_settled(id).await.expect("the settle, after the commit");
            let _ = sent.send(());
            run.port.saved(queued).await.expect("the call row is saved");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first task", "op-1").await;
    crate::session::testing::awaiting(|| "the text streams".to_owned(), sent.recv()).await;
    caught_up(&handle).await;
    // The committed row's encode waits on the held lane while the settle arrives.
    let cpu = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::CpuInteractive);
    go.send(()).expect("the run waits");
    crate::session::testing::awaiting(|| "the settle sent".to_owned(), sent.recv()).await;
    cpu.met_by_a_submit().await;
    caught_up(&handle).await;
    drop(cpu);
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    let view = handle.cell.view.load_full();
    assert_eq!(view.items.iter().filter(|item| item.id().as_str() == "seg").count(), 1, "one row of the reply: {:?}", view.items);
    drop(directory);
}

/// A codec that refuses the reply row `listing`, as a store that cannot take it would.
struct RefusesReply;

impl crate::session::seams::RecordCodec for RefusesReply {
    fn encode(&self, lane: &mixdog_rt::InLane<mixdog_rt::CpuInteractive>, record: &Record) -> Result<crate::session::seams::EncodedRecord, mixdog_core_api::CoreError> {
        match record {
            Record::Item(item) if matches!(&item.body, Slot::Inline(body) if body["text"] == "listing") => {
                Err(mixdog_core_api::CoreError::Internal { incident_id: "reply-refused".into() })
            }
            _ => crate::session::store::StoreCodec.encode(lane, record),
        }
    }
}

/// The settle of a reply's text arrives while that reply's commit is still encoding (the cpu lane held), and the encode then
/// fails: the settle, accepted behind the commit, is decided once the commit is gone, finds no row of the text and shows it;
/// it stays shown when the turn ends. The text the user saw is not lost.
#[tokio::test(start_paused = true)]
async fn a_text_settled_while_its_reply_fails_to_encode_stays_shown() {
    let rig = Rig::new();
    let (sent_tx, mut sent) = mpsc::unbounded_channel();
    let (go, go_rx) = mpsc::unbounded_channel::<()>();
    let steps = Arc::new(Mutex::new(Some((sent_tx, go_rx))));
    rig.set_script(Arc::new(move |run| {
        let steps = steps.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let Some((sent, mut go)) = steps.lock().unwrap().take() else { return RunOutcome::Completed(Default::default()) };
            let id = ItemId::from("seg");
            let started = ThreadItem::AgentMessage { id: id.clone(), text: mixdog_protocol::MaybeBlob::Inline(String::new()), imported_tool_runs: Vec::new(), meta: Default::default() };
            run.port.item_started(started).await.expect("the text starts");
            run.port.delta(id.clone(), "listing".into()).await.expect("the text streams");
            let _ = sent.send(());
            go.recv().await;
            let row = ItemCommit { iid: id.clone(), role: Some("assistant".into()), model: true, visible: true, body: json!({ "text": "listing" }), prompt: None };
            let queued = run.port.queue_item(row).await.expect("the reply is handed on");
            run.port.text_settled(id).await.expect("the settle, after the commit");
            let _ = sent.send(());
            assert!(run.port.saved(queued).await.is_err(), "the reply's commit fails");
            RunOutcome::Completed(Default::default())
        })
    }));
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.codec = Arc::new(RefusesReply);
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    turn(&handle, "first task", "op-1").await;
    crate::session::testing::awaiting(|| "the text streams".to_owned(), sent.recv()).await;
    caught_up(&handle).await;
    // The reply's encode waits on the held lane: the settle arrives while the commit is pending.
    let cpu = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::CpuInteractive);
    go.send(()).expect("the run waits");
    crate::session::testing::awaiting(|| "the settle sent".to_owned(), sent.recv()).await;
    cpu.met_by_a_submit().await;
    caught_up(&handle).await;
    let completed = |rig: &Rig| rig.feeds.frames(handle.id.as_str()).into_iter().filter(|(_, method, params)| method == "item/completed" && params["item"]["id"] == "seg").count();
    assert_eq!(completed(&rig), 0, "the settle waits behind its reply's pending commit");
    drop(cpu);
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    let view = handle.cell.view.load_full();
    let texts: Vec<String> = view
        .items
        .iter()
        .filter(|item| item.id().as_str() == "seg")
        .map(|item| match item.as_ref() {
            ThreadItem::AgentMessage { text: mixdog_protocol::MaybeBlob::Inline(text), .. } => text.clone(),
            other => panic!("the reply's text: {other:?}"),
        })
        .collect();
    assert_eq!(texts, ["listing"], "the settled text stays, once: {:?}", view.items);
    assert_eq!(completed(&rig), 1, "told once, by the settle");
    drop(directory);
}

/// Where the reply of a turn that ends with its text shown stands when the turn ends (`settleStreamingTailAtClose`).
#[derive(Clone, Copy, PartialEq)]
enum AtEnd {
    /// Never committed.
    Shown,
    /// Committed, its encode held on the cpu lane; it then encodes.
    Encoding,
    /// Committed, its encode held; the encode then fails.
    EncodeFails,
    /// Committed, its facts read held on the io lane while the run ends; the read then answers.
    Reading,
    /// Committed, its facts read in flight while the run ends; the read fails (the io lane refuses it).
    ReadFails,
}

/// A turn streams `listing` under item `seg` and ends with its reply where `at` says; returns the rig, the handle and the
/// directory once everything settled. The run's end is taken only once the reply's commit is accepted (its facts read), and
/// the close's settle and end are told behind that commit, in outbox order.
async fn ended(at: AtEnd) -> (Rig, Arc<SessionHandle>, SessionDirectory) {
    let rig = Rig::new();
    let (sent_tx, mut sent) = mpsc::unbounded_channel();
    let (go, go_rx) = mpsc::unbounded_channel::<()>();
    let steps = Arc::new(Mutex::new(Some((sent_tx, go_rx))));
    let commits = at != AtEnd::Shown;
    rig.set_script(Arc::new(move |run| {
        let steps = steps.clone();
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let Some((sent, mut go)) = steps.lock().unwrap().take() else { return RunOutcome::Completed(Default::default()) };
            let id = ItemId::from("seg");
            let started = ThreadItem::AgentMessage { id: id.clone(), text: mixdog_protocol::MaybeBlob::Inline(String::new()), imported_tool_runs: Vec::new(), meta: Default::default() };
            run.port.item_started(started).await.expect("the text starts");
            run.port.delta(id.clone(), "listing".into()).await.expect("the text streams");
            let _ = sent.send(());
            go.recv().await;
            if commits {
                let row = ItemCommit { iid: id, role: Some("assistant".into()), model: true, visible: true, body: json!({ "text": "listing" }), prompt: None };
                drop(run.port.queue_item(row).await.expect("the reply is handed on"));
            }
            RunOutcome::Completed(Default::default())
        })
    }));
    let mut deps = rig.deps_parts(rig.store.clone());
    if at == AtEnd::EncodeFails {
        deps.codec = Arc::new(RefusesReply);
    }
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    turn(&handle, "first task", "op-1").await;
    crate::session::testing::awaiting(|| "the text streams".to_owned(), sent.recv()).await;
    caught_up(&handle).await;
    let lane = match at {
        AtEnd::Shown | AtEnd::ReadFails => None,
        AtEnd::Encoding | AtEnd::EncodeFails => Some(mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::CpuInteractive)),
        AtEnd::Reading => Some(mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::InteractiveIo)),
    };
    // The reply's facts read is the next job submitted: refused at its first attempt, as a lane that cannot run it, it fails.
    // (A refusal of a submit already waiting on a held lane is only more waiting: `submit_wait` waits out a full lane.)
    let refused = (at == AtEnd::ReadFails).then(|| mixdog_rt::testing::refuse_nth_job_on_this_thread(0));
    go.send(()).expect("the run waits");
    if let Some(lane) = lane {
        lane.met_by_a_submit().await;
        if matches!(at, AtEnd::Encoding | AtEnd::EncodeFails) {
            // The commit was accepted, then the run's end: the turn closed, its settle and end accepted behind the commit.
            crate::eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
        }
        caught_up(&handle).await;
        // While its facts are read the commit is not accepted yet, and the run's end waits for it.
        assert_eq!(idle(&handle), matches!(at, AtEnd::Encoding | AtEnd::EncodeFails), "the end waits for the commit being read");
        // The commit is pending: neither the text's row nor the turn's end has been told.
        assert_eq!(seg_told(&rig, &handle), 0, "nothing of the reply is told while its commit is pending");
        assert!(rig.feeds.frames(handle.id.as_str()).iter().all(|(_, method, _)| method != "turn/completed"), "the end waits behind it");
        drop(lane);
        caught_up(&handle).await;
    }
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    if let Some(refused) = refused {
        assert!(!stored(&rig, &handle).contains(&"listing".to_owned()), "the reply's read failed: its commit was not made");
        drop(refused);
        // The run's end came while the failing read was in flight: it was parked, and the read's failure released it.
        let ledger = handle.cell.stop_ledger.lock().unwrap().clone();
        assert!(ledger.iter().any(|event| event.starts_with("run:end-parked:")), "the end waited for the read: {ledger:?}");
    }
    (rig, handle, directory)
}

/// How many times the feed told item `seg` complete.
fn seg_told(rig: &Rig, handle: &SessionHandle) -> usize {
    rig.feeds.frames(handle.id.as_str()).iter().filter(|(_, method, params)| method == "item/completed" && params["item"]["id"] == "seg").count()
}

/// The texts of the rows `seg` holds in view.
fn seg_rows(handle: &SessionHandle) -> Vec<String> {
    handle
        .cell
        .view
        .load_full()
        .items
        .iter()
        .filter(|item| item.id().as_str() == "seg")
        .map(|item| match item.as_ref() {
            ThreadItem::AgentMessage { text: mixdog_protocol::MaybeBlob::Inline(text), .. } => text.clone(),
            other => panic!("the reply's text: {other:?}"),
        })
        .collect()
}

/// The text the turn showed is told complete before the turn's end (a client clears its live text at `turn/completed`).
fn told_before_the_end(rig: &Rig, handle: &SessionHandle) -> bool {
    let feed = rig.feeds.frames(handle.id.as_str());
    let at = |wanted: &dyn Fn(&str, &Value) -> bool| feed.iter().position(|(_, method, params)| wanted(method, params));
    let row = at(&|method, params| method == "item/completed" && params["item"]["id"] == "seg");
    let end = at(&|method, _| method == "turn/completed");
    matches!((row, end), (Some(row), Some(end)) if row < end)
}

/// A turn that ends with text shown and never committed keeps it: one row, told before the end.
#[tokio::test(start_paused = true)]
async fn a_turn_ending_with_its_text_shown_keeps_it() {
    let (rig, handle, _directory) = ended(AtEnd::Shown).await;
    assert_eq!(seg_rows(&handle), ["listing"]);
    assert_eq!(seg_told(&rig, &handle), 1);
    assert!(told_before_the_end(&rig, &handle));
}

/// A turn that ends while its reply's commit encodes: the commit's row is the one row, the end's settlement adds none.
#[tokio::test(start_paused = true)]
async fn a_turn_ending_while_its_reply_encodes_shows_the_reply_once() {
    let (rig, handle, _directory) = ended(AtEnd::Encoding).await;
    assert_eq!(seg_rows(&handle), ["listing"]);
    assert!(told_before_the_end(&rig, &handle));
}

/// A turn that ends while its reply's commit encodes, and the encode fails: the end's settlement shows the text, once.
#[tokio::test(start_paused = true)]
async fn a_turn_ending_while_its_reply_fails_to_encode_keeps_the_text() {
    let (rig, handle, _directory) = ended(AtEnd::EncodeFails).await;
    assert_eq!(seg_rows(&handle), ["listing"]);
    assert_eq!(seg_told(&rig, &handle), 1);
    assert!(told_before_the_end(&rig, &handle));
}

/// A turn that ends while its reply's facts are read: the end waits for the read, the commit's row is the one row, told
/// once, and the end's settlement adds none.
#[tokio::test(start_paused = true)]
async fn a_turn_ending_while_its_reply_is_read_keeps_the_text() {
    let (rig, handle, _directory) = ended(AtEnd::Reading).await;
    assert_eq!(seg_rows(&handle), ["listing"]);
    assert_eq!(seg_told(&rig, &handle), 1);
    assert!(told_before_the_end(&rig, &handle));
}

/// A turn that ends while its reply's facts are read, and the read then fails: the end waits for the read, then its
/// settlement shows the text, once.
#[tokio::test(start_paused = true)]
async fn a_turn_ending_while_its_reply_fails_to_be_read_keeps_the_text() {
    let (rig, handle, _directory) = ended(AtEnd::ReadFails).await;
    assert_eq!(seg_rows(&handle), ["listing"]);
    assert_eq!(seg_told(&rig, &handle), 1);
    assert!(told_before_the_end(&rig, &handle));
}

/// A process that dies after the turn's items were shown, none of their records on disk: the next open shows what the disk
/// holds, a prefix of what the client was shown, never an item it was not.
#[tokio::test(start_paused = true)]
async fn a_crash_after_the_turn_was_shown_reopens_on_a_prefix_of_it() {
    let mut played = Played::new().await;
    played.play().await;
    let published = completed_ids(&played.rig, &played.handle);
    assert!(published.contains(&"call:c1".to_owned()), "the card was shown: {published:?}");
    // The process dies here: the disk holds what it took before. The held disk is this test's thread-local hold, which refuses
    // every durability submit on this thread: the next process starts without it.
    let on_disk = played.rig.store.records(&played.handle.id);
    let copied = on_disk.len();
    drop(played.full.take());
    let replay = Rig::new();
    replay.set_script(echo());
    for (_, record) in on_disk {
        replay.store.append_record(&played.handle.id, record);
    }
    let restarted = SessionDirectory::new(replay.deps());
    let reopened = restarted.open_handle(&played.handle.id, &CallContext::internal("test")).await.expect("reopen");
    crate::eventually_on!(&[&reopened.cell.stepped], || reopened.recovered().then_some(())).await;
    let reopened_ids: Vec<String> = reopened.cell.view.load_full().items.iter().map(|item| item.id().as_str().to_owned()).collect();
    // Rows the reopen itself wrote (the recovery's end of the interrupted turn) are new; every other row was shown before.
    let recovered: Vec<String> = replay
        .store
        .records(&played.handle.id)
        .into_iter()
        .skip(copied)
        .filter_map(|(_, record)| match record {
            Record::Item(item) => Some(item.iid.as_str().to_owned()),
            _ => None,
        })
        .collect();
    let unseen: Vec<&String> = reopened_ids.iter().filter(|id| !published.contains(id) && !recovered.contains(id)).collect();
    assert!(unseen.is_empty(), "the reopen shows no stored row the client was not shown: {unseen:?} (shown: {published:?})");
    let seen: Vec<String> = reopened_ids.into_iter().filter(|id| published.contains(id)).collect();
    assert_eq!(seen, published[..seen.len()], "the reopened rows are a prefix of what was shown");
    assert!(seen.len() < published.len(), "the unwritten call is not replayed: {seen:?}");
}

/// A reply is published complete in the source text it streamed in: the preamble before a tool and the closing answer after it
/// (and a reply with leading or trailing whitespace) end as exactly the concatenation of the deltas streamed for their item, so
/// a client that rendered the stream does not rebuild what it showed when the item completes.
async fn completed_equals_streamed(final_text: &'static str, stamped: bool) {
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let row = |iid: &str, body: Value| ItemCommit { iid: ItemId::from(iid), role: Some("assistant".into()), model: true, visible: true, body, prompt: None };
            let started = |id: &ItemId| ThreadItem::AgentMessage { id: id.clone(), text: mixdog_protocol::MaybeBlob::Inline(String::new()), imported_tool_runs: Vec::new(), meta: Default::default() };
            let pre = ItemId::from("pre");
            run.port.item_started(started(&pre)).await.expect("the preamble starts");
            run.port.delta(pre.clone(), "Let me ".into()).await.expect("streams");
            run.port.delta(pre.clone(), "look.".into()).await.expect("streams");
            run.port.text_settled(pre.clone()).await.expect("the call starts");
            let call = json!({ "id": "c1", "name": "shell", "arguments": { "command": "ls" } });
            run.port.commit_item(row("pre", json!({ "content": "Let me look.", "toolCalls": [call] }))).await.expect("the call row");
            run.port.commit_item(ItemCommit { iid: ItemId::from("t1"), role: Some("tool".into()), model: true, visible: true, body: json!({ "toolCallId": "c1", "text": "a.txt" }), prompt: None }).await.expect("the result row");
            let fin = ItemId::from("fin");
            run.port.item_started(started(&fin)).await.expect("the answer starts");
            let (head, tail) = final_text.split_at(final_text.len() / 2);
            run.port.delta(fin.clone(), head.into()).await.expect("streams");
            run.port.delta(fin.clone(), tail.into()).await.expect("streams");
            let mut body = json!({ "content": final_text });
            if stamped {
                body["meta"] = json!({ "transcript": { "attemptId": "att" } });
            }
            run.port.commit_item(row("fin", body)).await.expect("the answer row");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first task", "op-1").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    let frames = rig.feeds.frames(handle.id.as_str());
    for id in ["pre", "fin"] {
        let streamed: String = frames
            .iter()
            .filter(|(_, method, params)| method == "item/agentMessage/delta" && params["itemId"] == id)
            .map(|(_, _, params)| params["delta"].as_str().unwrap_or_default())
            .collect();
        let completed = frames.iter().rev().find(|(_, method, params)| method == "item/completed" && params["item"]["id"] == id).map(|(_, _, params)| params["item"]["text"].clone());
        assert_eq!(completed, Some(json!(streamed)), "item {id} ({final_text:?}, stamped {stamped}) completes as it streamed");
    }
    drop(directory);
}

#[tokio::test(start_paused = true)]
async fn a_closing_answer_completes_as_it_streamed() {
    completed_equals_streamed("Answer.", false).await;
}

#[tokio::test(start_paused = true)]
async fn a_closing_answer_with_surrounding_whitespace_completes_as_it_streamed() {
    completed_equals_streamed("\n\n  Answer ok.  \n", false).await;
}

#[tokio::test(start_paused = true)]
async fn a_stamped_answer_with_surrounding_whitespace_completes_as_it_streamed() {
    completed_equals_streamed("\n\n  Answer ok.  \n", true).await;
}

/// A stamped response that streams only whitespace under one item, crosses a tool boundary and streams the answer under
/// another: each item that survives completes as its own deltas, the answer without the whitespace of the item before it.
#[tokio::test(start_paused = true)]
async fn a_stamped_answer_after_a_whitespace_only_segment_completes_as_it_streamed() {
    let rig = Rig::new();
    rig.set_script(Arc::new(move |run| {
        Box::pin(async move {
            run.port.input_durable().await.expect("input durable");
            let started = |id: &ItemId| ThreadItem::AgentMessage { id: id.clone(), text: mixdog_protocol::MaybeBlob::Inline(String::new()), imported_tool_runs: Vec::new(), meta: Default::default() };
            let (blank, fin) = (ItemId::from("blank"), ItemId::from("fin"));
            run.port.item_started(started(&blank)).await.expect("starts");
            run.port.delta(blank.clone(), "\n\n".into()).await.expect("streams");
            run.port.text_settled(blank.clone()).await.expect("the call starts");
            let stamp = json!({ "transcript": { "attemptId": "att" } });
            let call = json!({ "id": "c1", "name": "shell", "arguments": { "command": "ls" } });
            let row = |iid: &str, body: Value| ItemCommit { iid: ItemId::from(iid), role: Some("assistant".into()), model: true, visible: true, body, prompt: None };
            run.port.commit_item(row("blank", json!({ "content": "\n\n", "toolCalls": [call], "meta": stamp.clone() }))).await.expect("the call row");
            run.port.commit_item(ItemCommit { iid: ItemId::from("t1"), role: Some("tool".into()), model: true, visible: true, body: json!({ "toolCallId": "c1", "text": "a.txt" }), prompt: None }).await.expect("the result row");
            run.port.item_started(started(&fin)).await.expect("starts");
            run.port.delta(fin.clone(), "Answer.".into()).await.expect("streams");
            run.port.commit_item(row("fin", json!({ "content": "Answer.", "meta": stamp }))).await.expect("the answer row");
            RunOutcome::Completed(Default::default())
        })
    }));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    turn(&handle, "first task", "op-1").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    let frames = rig.feeds.frames(handle.id.as_str());
    for id in ["blank", "fin"] {
        let streamed: String = frames
            .iter()
            .filter(|(_, method, params)| method == "item/agentMessage/delta" && params["itemId"] == id)
            .map(|(_, _, params)| params["delta"].as_str().unwrap_or_default())
            .collect();
        let completed = frames.iter().rev().find(|(_, method, params)| method == "item/completed" && params["item"]["id"] == id).map(|(_, _, params)| params["item"]["text"].clone());
        if let Some(completed) = completed {
            assert_eq!(completed, json!(streamed), "item {id} completes as it streamed");
        } else {
            assert_ne!(id, "fin", "the answer is completed");
        }
    }
    drop(directory);
}
