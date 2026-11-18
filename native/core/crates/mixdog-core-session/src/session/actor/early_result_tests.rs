//! Early results at the show point (`SessionActor::release`, `early_result`): a call's card and any result retained for it
//! are folded before the card's notification is built, so the feed never tells a card open after it told it closed, and the
//! committed result is the call's final one. Node installed a batch's cards, then applied the results it had retained
//! (`turn-tool-cards.mjs`). Every check reads the feed as a client reduces it (`item/completed` replaces the item by id) and
//! compares it with the actor's own snapshot, with the disk held so that no write of the turn has been acknowledged.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::Ordering::SeqCst;

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
use crate::session::tests::idle;
use crate::session::tests::start_thread;
use crate::session::tests::turn;

/// One move of the run, as the loop makes it: an assistant row with calls (their cards), a call's early result, a call's
/// committed result row (handed on, its save not awaited), or the run's end.
enum Step {
    Card(Vec<&'static str>),
    Early(&'static str, &'static str),
    Result(&'static str, &'static str),
    End,
}

struct Played {
    rig: Rig,
    _directory: SessionDirectory,
    handle: Arc<SessionHandle>,
    steps: mpsc::UnboundedSender<Step>,
    done: mpsc::UnboundedReceiver<()>,
    /// The disk, held from the turn's start on.
    full: Option<mixdog_rt::testing::HeldFull>,
}

impl Played {
    /// A started turn whose start is on disk, the disk held from here on.
    async fn new() -> Self {
        let rig = Rig::new();
        let (steps, steps_rx) = mpsc::unbounded_channel();
        let (done_tx, done) = mpsc::unbounded_channel();
        let slot = Arc::new(Mutex::new(Some((steps_rx, done_tx))));
        rig.set_script(Arc::new(move |run| {
            let slot = slot.clone();
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let Some((mut steps, done)) = slot.lock().unwrap().take() else { return RunOutcome::Completed(Default::default()) };
                let row = |iid: String, role: &str, body: Value| ItemCommit { iid: ItemId::from(iid), role: Some(role.into()), model: true, visible: true, body, prompt: None };
                let mut n = 0;
                while let Some(step) = steps.recv().await {
                    n += 1;
                    match step {
                        Step::Card(calls) => {
                            let calls: Vec<Value> = calls.iter().map(|id| json!({ "id": id, "name": "shell", "arguments": { "command": "ls" } })).collect();
                            drop(run.port.queue_item(row(format!("a{n}-{}", run.turn), "assistant", json!({ "text": "", "toolCalls": calls }))).await.expect("the call row"));
                        }
                        Step::Early(call, text) => run.port.early_result(json!({ "toolCallId": call, "text": text })).await.expect("the early result"),
                        Step::Result(call, text) => {
                            drop(run.port.queue_item(row(format!("t{n}-{}", run.turn), "tool", json!({ "toolCallId": call, "text": text }))).await.expect("the result row"));
                        }
                        Step::End => break,
                    }
                    let _ = done.send(());
                }
                RunOutcome::Completed(Default::default())
            })
        }));
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        turn(&handle, "first task", "op-1").await;
        crate::eventually_on!(&[&handle.cell.stepped], || (handle.cell.run.load().is_some() && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
        let full = Some(mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::DurabilityIo));
        Self { rig, _directory: directory, handle, steps, done, full }
    }

    async fn step(&mut self, step: Step) {
        self.steps.send(step).expect("the run takes steps");
        crate::session::testing::awaiting(|| "the run's step".to_owned(), self.done.recv()).await;
    }

    /// Waits until the feed shows `cards` as a client reduces it, then checks the actor's snapshot agrees.
    async fn shows(&self, cards: &[(&str, Option<&str>, bool)]) {
        let expected: BTreeMap<String, (Option<String>, bool)> =
            cards.iter().map(|(id, result, closed)| ((*id).to_owned(), (result.map(str::to_owned), *closed))).collect();
        crate::eventually_on!(&[&self.handle.cell.stepped, &*self.rig.feeds.published], || (reduced(&self.rig, &self.handle) == expected).then_some(())).await;
        assert_eq!(snapshot(&self.handle), expected, "the actor's snapshot is what the feed told");
    }
}

/// The call cards as a client holds them after the feed: `item/completed` replaces the item by id. A card told open after it
/// was told closed fails the test (the client would show it running again).
fn reduced(rig: &Rig, handle: &SessionHandle) -> BTreeMap<String, (Option<String>, bool)> {
    let mut cards = BTreeMap::new();
    for (_, method, params) in rig.feeds.frames(handle.id.as_str()) {
        let Some(id) = params["item"]["id"].as_str().filter(|id| id.starts_with("call:")) else { continue };
        if method != "item/completed" {
            continue;
        }
        let closed = !params["item"]["run"]["completedAt"].is_null();
        let result = params["item"]["run"]["result"].as_str().map(str::to_owned);
        if let Some((_, was_closed)) = cards.get(id) {
            assert!(!was_closed || closed, "card {id} was told open after it was told closed: {params}");
        }
        cards.insert(id.to_owned(), (result, closed));
    }
    cards
}

/// The call cards in the actor's published view.
fn snapshot(handle: &SessionHandle) -> BTreeMap<String, (Option<String>, bool)> {
    handle
        .cell
        .view
        .load_full()
        .items
        .iter()
        .filter_map(|item| match item.as_ref() {
            ThreadItem::ToolCall { id, run, .. } => {
                let result = match &run.result {
                    Some(mixdog_protocol::MaybeBlob::Inline(text)) => Some(text.clone()),
                    _ => None,
                };
                Some((id.as_str().to_owned(), (result, run.completed_at.is_some())))
            }
            _ => None,
        })
        .collect()
}

/// How many times the feed told card `id`, open and closed.
fn told(rig: &Rig, handle: &SessionHandle, id: &str) -> (usize, usize) {
    let frames = rig.feeds.frames(handle.id.as_str());
    let card = frames.iter().filter(|(_, method, params)| method == "item/completed" && params["item"]["id"] == id);
    let (open, closed): (Vec<_>, Vec<_>) = card.partition(|(_, _, params)| params["item"]["run"]["completedAt"].is_null());
    (open.len(), closed.len())
}

fn unacked(handle: &SessionHandle) -> bool {
    handle.cell.unacked.load(SeqCst) > 0
}

/// The result came before its card, whose row is still encoding: nothing of the card is told until it is shown, and then it
/// is told once, closed.
#[tokio::test(start_paused = true)]
async fn a_result_before_its_card_is_told_with_the_card_closed_once() {
    let mut played = Played::new().await;
    played.step(Step::Early("c1", "early")).await;
    crate::session::tests::caught_up(&played.handle).await;
    // The interactive cpu lane is held (its jobs run on this test's thread): the card's row waits for its encoding. A codec that
    // blocked inside the encode would block this runtime with it.
    let cpu = mixdog_rt::testing::hold_full(mixdog_rt::LaneKind::CpuInteractive);
    played.step(Step::Card(vec!["c1"])).await;
    cpu.met_by_a_submit().await;
    crate::session::tests::caught_up(&played.handle).await;
    assert_eq!(reduced(&played.rig, &played.handle), BTreeMap::new(), "nothing of the card is told before it is shown");
    drop(cpu);
    played.shows(&[("call:c1", Some("early"), true)]).await;
    assert_eq!(told(&played.rig, &played.handle, "call:c1"), (0, 1), "told once, closed");
    assert!(unacked(&played.handle), "no write of the turn was acknowledged");
}

/// The card is shown first, then its result closes it; the committed result supersedes the early one.
#[tokio::test(start_paused = true)]
async fn a_card_shown_before_its_result_is_closed_by_it_then_superseded() {
    let mut played = Played::new().await;
    played.step(Step::Card(vec!["c1"])).await;
    played.shows(&[("call:c1", None, false)]).await;
    played.step(Step::Early("c1", "early")).await;
    played.shows(&[("call:c1", Some("early"), true)]).await;
    played.step(Step::Result("c1", "final")).await;
    played.shows(&[("call:c1", Some("final"), true)]).await;
    assert!(unacked(&played.handle), "no write of the turn was acknowledged");
}

/// The committed result is shown before an early result for the same call: the early one changes nothing.
#[tokio::test(start_paused = true)]
async fn an_early_result_after_the_committed_one_changes_nothing() {
    let mut played = Played::new().await;
    played.step(Step::Card(vec!["c1"])).await;
    played.step(Step::Result("c1", "final")).await;
    played.shows(&[("call:c1", Some("final"), true)]).await;
    played.step(Step::Early("c1", "late")).await;
    // The next row is shown after the early result (the run's messages are taken in order, the early one's items read
    // before the next): once its card is told, the early result was shown.
    played.step(Step::Card(vec!["c2"])).await;
    played.shows(&[("call:c1", Some("final"), true), ("call:c2", None, false)]).await;
    let frames = played.rig.feeds.frames(played.handle.id.as_str());
    assert!(!frames.iter().any(|(_, _, params)| params["item"]["run"]["result"] == "late"), "the late early result is never told");
}

/// An early result, then a failed save of the turn's rows, then a save that lands: the card is not created again and not
/// reopened; it stays as it was told.
#[tokio::test(start_paused = true)]
async fn a_failed_save_and_its_retry_neither_recreate_nor_reopen_a_closed_card() {
    let mut played = Played::new().await;
    played.step(Step::Card(vec!["c1"])).await;
    played.step(Step::Early("c1", "early")).await;
    played.shows(&[("call:c1", Some("early"), true)]).await;
    let rig = &played.rig;
    *rig.store.failing.lock().unwrap() = Some("EIO: injected".into());
    drop(played.full.take());
    played.steps.send(Step::End).expect("the run takes steps");
    let handle = played.handle.clone();
    crate::eventually_on!(&[&rig.notices.1], || rig.notices.0.lock().unwrap().iter().any(|notice| notice == "save-failed").then_some(())).await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && !handle.turn_busy()).then_some(())).await;
    *rig.store.failing.lock().unwrap() = None;
    turn(&handle, "second task", "op-2").await;
    crate::eventually_on!(&[&handle.cell.stepped], || (idle(&handle) && handle.cell.unacked.load(SeqCst) == 0).then_some(())).await;
    let stored_calls = rig
        .store
        .records(&handle.id)
        .into_iter()
        .filter(|(_, record)| matches!(record, Record::Item(item) if matches!(&item.body, Slot::Inline(body) if body.get("toolCalls").is_some())))
        .count();
    assert_eq!(stored_calls, 1, "the retry wrote the call's row once");
    assert_eq!(told(rig, &handle, "call:c1"), (1, 1), "created once, closed once");
    assert_eq!(reduced(rig, &handle), snapshot(&handle));
}

/// Several calls of one batch completing out of order, each before its committed result, which follow in call order: at
/// every step the feed and the snapshot agree, and no card is told open after it was closed.
#[tokio::test(start_paused = true)]
async fn calls_completing_out_of_order_never_reopen_a_card() {
    let mut played = Played::new().await;
    played.step(Step::Card(vec!["c1", "c2", "c3"])).await;
    played.shows(&[("call:c1", None, false), ("call:c2", None, false), ("call:c3", None, false)]).await;
    played.step(Step::Early("c3", "r3")).await;
    played.shows(&[("call:c1", None, false), ("call:c2", None, false), ("call:c3", Some("r3"), true)]).await;
    played.step(Step::Early("c1", "r1")).await;
    played.shows(&[("call:c1", Some("r1"), true), ("call:c2", None, false), ("call:c3", Some("r3"), true)]).await;
    played.step(Step::Result("c1", "f1")).await;
    played.step(Step::Result("c2", "f2")).await;
    played.step(Step::Result("c3", "f3")).await;
    played.shows(&[("call:c1", Some("f1"), true), ("call:c2", Some("f2"), true), ("call:c3", Some("f3"), true)]).await;
    assert!(unacked(&played.handle), "no write of the turn was acknowledged");
}
