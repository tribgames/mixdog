//! A tool step is published as it happens. Nothing of it waits for a gate, for another call, or for its batch to end: the
//! feed carries, in the order the session accepted them, the usage, the cards, a finished call's result, the batch's start, the
//! person's own message, a notice and a toast, while a call of the batch is still blocked; a client that attaches then reads what
//! the live feed told. Every check waits on an explicit barrier of the run (its `sent`/`go` channels), never on elapsed time.

use std::sync::Arc;
use std::sync::Mutex;

use mixdog_app_protocol::v2::thread::ModelRequestPhase;
use mixdog_app_protocol::v2::thread::ToolBatchPhase;
use mixdog_core_api::domain::approval::ApprovalAsk;
use mixdog_core_api::domain::approval::ApprovalGate;
use mixdog_core_api::domain::approval::ApprovalKind;
use mixdog_core_api::ids::ItemId;
use mixdog_protocol::ThreadItem;
use serde_json::Value;
use serde_json::json;
use tokio::sync::mpsc;

use crate::session::RunOutcome;
use crate::session::SessionDirectory;
use crate::session::SessionHandle;
use crate::session::run::CallMark;
use crate::session::run::ItemCommit;
use crate::session::run::RunPort;
use crate::session::testing::Rig;
use crate::session::tests::caught_up;
use crate::session::tests::start_thread;
use crate::session::tests::turn;

/// The run's side of a barrier: it says it reached the step (`sent`) and waits to be let go (`go`).
struct Barrier {
    sent: mpsc::UnboundedSender<()>,
    go: mpsc::UnboundedReceiver<()>,
}

impl Barrier {
    async fn wait(&mut self) {
        let _ = self.sent.send(());
        self.go.recv().await;
    }
}

/// A turn whose run is `script(port, barrier)`, started, with the test's side of the barrier.
struct Turn {
    rig: Rig,
    directory: SessionDirectory,
    handle: Arc<SessionHandle>,
    sent: mpsc::UnboundedReceiver<()>,
    go: mpsc::UnboundedSender<()>,
}

impl Turn {
    async fn start<F, Fut>(script: F) -> Self
    where
        F: Fn(RunPort, Barrier) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let rig = Rig::new();
        let (sent_tx, sent) = mpsc::unbounded_channel();
        let (go, go_rx) = mpsc::unbounded_channel();
        let parts = Arc::new(Mutex::new(Some((sent_tx, go_rx))));
        let script = Arc::new(script);
        rig.set_script(Arc::new(move |run| {
            let (parts, script) = (parts.clone(), script.clone());
            Box::pin(async move {
                run.port.input_durable().await.expect("input durable");
                let Some((sent, go)) = parts.lock().unwrap().take() else { return RunOutcome::Completed(Default::default()) };
                script(run.port.clone(), Barrier { sent, go }).await;
                RunOutcome::Completed(Default::default())
            })
        }));
        let directory = SessionDirectory::new(rig.deps());
        let handle = start_thread(&directory).await;
        turn(&handle, "go", "op-1").await;
        Self { rig, directory, handle, sent, go }
    }

    /// The run reached its next barrier and the session took everything the run sent before it.
    async fn reached(&mut self) {
        crate::session::testing::awaiting(|| "the run's barrier".to_owned(), self.sent.recv()).await;
        caught_up(&self.handle).await;
    }

    /// The run goes on to its next barrier, or its end.
    fn release(&self) {
        self.go.send(()).expect("the run waits");
    }

    fn frames(&self) -> Vec<(u64, String, Value)> {
        self.rig.feeds.frames(self.handle.id.as_str())
    }

    fn position(&self, wanted: impl Fn(&str, &Value) -> bool) -> Option<usize> {
        self.frames().iter().position(|(_, method, params)| wanted(method, params))
    }

    /// A `thread/frame` follows the frame at `at`: a framed consumer (the phone's fold) is told the state at once too.
    fn framed_after(&self, at: usize) -> bool {
        self.frames().iter().skip(at + 1).any(|(_, method, _)| method == "thread/frame")
    }
}

fn row(iid: String, role: &str, body: Value) -> ItemCommit {
    ItemCommit { iid: ItemId::from(iid), role: Some(role.into()), model: true, visible: true, body, prompt: None }
}

fn usage() -> crate::session::UsageReport {
    crate::session::UsageReport {
        iteration: 1,
        usage: mixdog_core_api::domain::provider::Usage { input_tokens: 10, output_tokens: 2, ..Default::default() },
        model: "m".into(),
        requested_model: "m".into(),
        delta_tool_calls: 2,
        request_ms: 0,
        delta_prompt: 10,
        send_tools: Vec::new(),
        reasoning_tokens: None,
        reasoning_tokens_complete: false,
        outgoing: Vec::new().into(),
        sent_at_ms: 0,
        input_excludes_cache: false, tail_book: None,
    }
}

fn calls() -> Value {
    json!([{ "id": "c1", "name": "shell", "arguments": { "command": "a" } }, { "id": "c2", "name": "shell", "arguments": { "command": "b" } }])
}

fn is_card(params: &Value, id: &str) -> bool {
    params["item"]["id"] == id
}

/// The ids of the items the feed completed, in the order it first showed each (a client's rows, in its order).
fn told_order(turn: &Turn) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, method, params) in turn.frames() {
        if method == "item/completed" {
            let id = params["item"]["id"].as_str().unwrap_or_default().to_owned();
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    out
}

/// The ids of the items in the actor's published view (what a client that attaches now reads).
fn view_order(turn: &Turn) -> Vec<String> {
    turn.handle.cell.view.load_full().items.iter().map(|item: &Arc<ThreadItem>| item.id().as_str().to_owned()).collect()
}

/// The owner's case. Calls start as their blocks stream, so the first finishes while the second is still blocked, and the step's
/// usage came after the first's gate; the ids the model request reported (a compat decoder's synthetic ones) are not the ones the
/// batch returned. Before the blocked call is released the feed carries the usage, both cards, the first's result, the batch's
/// start, a message the person sent and a toast; a framed consumer is told after each.
#[tokio::test(start_paused = true)]
async fn a_step_with_a_call_still_blocked_is_published_as_it_happens() {
    let mut turn = Turn::start(|port, mut barrier| async move {
        port.model_request(1, ModelRequestPhase::Completed, Some(vec![json!({ "id": "synthetic-1" })])).await.expect("shown");
        port.usage(usage()).await.expect("usage");
        port.call_mark(CallMark::ToolCall).await.expect("shown");
        let (p, item) = (port.clone(), row("a-1".into(), "assistant", json!({ "text": "listing", "toolCalls": calls() })));
        let call_row = tokio::spawn(async move { p.commit_item(item).await });
        port.tool_batch(1, ToolBatchPhase::Started, None).await.expect("the batch starts");
        let (p, item) = (port.clone(), row("t-1".into(), "tool", json!({ "toolCallId": "c1", "text": "a.txt" })));
        let first_result = tokio::spawn(async move { p.commit_item(item).await });
        // The second call is blocked: nothing below happens until the test lets the run go.
        barrier.wait().await;
        let (p, item) = (port.clone(), row("t-2".into(), "tool", json!({ "toolCallId": "c2", "text": "b.txt" })));
        p.commit_item(item).await.expect("the second result");
        port.call_mark(CallMark::ToolPhaseCompleted).await.expect("shown");
        call_row.await.expect("task").expect("the call row");
        first_result.await.expect("task").expect("the first result");
    })
    .await;
    turn.reached().await;
    // The person's message and a toast arrive while the batch is blocked.
    let typed = crate::session::tests::turn(&turn.handle, "typed while blocked", "op-2").await;
    let _ = typed;
    turn.directory.hosting(&turn.handle.id).expect("hosted").push_toast("setup needed", "info").await.expect("toast");
    caught_up(&turn.handle).await;

    let usage_at = turn.position(|method, _| method == "thread/tokenUsage/updated").expect("the step's usage is published");
    let card_1 = turn.position(|method, params| method == "item/completed" && is_card(params, "call:c1")).expect("the first card is shown");
    turn.position(|method, params| method == "item/completed" && is_card(params, "call:c2")).expect("the second card is shown");
    let closed = turn
        .position(|method, params| method == "item/completed" && is_card(params, "call:c1") && !params["item"]["run"]["completedAt"].is_null())
        .expect("the first call's result closes its card");
    assert!(card_1 <= closed, "the same card, shown before it was closed");
    let batch = turn.position(|method, params| method == "thread/toolBatch/updated" && params["phase"] == "started").expect("the batch's start is published");
    let queued = turn.position(|method, _| method == "thread/queue/changed").expect("the person's message is published");
    let toast = turn
        .position(|method, params| method == "thread/runtime/updated" && params["value"]["toasts"].as_array().is_some_and(|toasts| toasts.iter().any(|toast| toast["text"] == "setup needed")))
        .expect("the toast is published");
    // A framed consumer is told the state of each change at the next frame boundary (a timer of the session's: the paused clock is
    // moved past it).
    tokio::time::advance(std::time::Duration::from_millis(20)).await;
    for at in [usage_at, closed, batch, queued, toast] {
        crate::eventually_on!(&[&turn.handle.cell.stepped], || turn.framed_after(at).then_some(())).await;
    }
    assert_eq!(told_order(&turn).iter().filter(|id| id.starts_with("call:")).count(), 2, "each card once, in the feed's order");

    turn.release();
    crate::eventually_on!(&[&turn.handle.cell.stepped], || crate::session::tests::idle(&turn.handle).then_some(())).await;
}

/// Rows are appended by a client in the order the feed tells them: a tool row, then a notice and a person's message, told before the
/// batch ends, are in that order for the live fold, the actor's view and so for a client that attaches.
#[tokio::test(start_paused = true)]
async fn rows_told_before_the_batch_ends_are_in_one_order_for_the_feed_and_the_view() {
    let mut turn = Turn::start(|port, mut barrier| async move {
        let (p, item) = (port.clone(), row("a-1".into(), "assistant", json!({ "text": "listing", "toolCalls": calls() })));
        let call_row = tokio::spawn(async move { p.commit_item(item).await });
        port.notice("heads up".into(), mixdog_agent::env::Tone::Info).await.expect("notice");
        barrier.wait().await;
        call_row.await.expect("task").expect("the call row");
    })
    .await;
    turn.reached().await;
    crate::session::tests::turn(&turn.handle, "typed while blocked", "op-2").await;
    caught_up(&turn.handle).await;
    let told = told_order(&turn);
    let view = view_order(&turn);
    let in_view: Vec<String> = told.iter().filter(|id| view.contains(id)).cloned().collect();
    assert!(in_view.iter().any(|id| id.starts_with("call:")), "the cards are in view: {view:?}");
    assert_eq!(in_view, view.iter().filter(|id| told.contains(id)).cloned().collect::<Vec<_>>(), "the feed's order is the view's");
    turn.release();
    crate::eventually_on!(&[&turn.handle.cell.stepped], || crate::session::tests::idle(&turn.handle).then_some(())).await;
}

/// An approval is published, with the spinner's `tool-approval`, at once: before or after the step's card, and while the batch's
/// other calls and its end are still to come; the cards the feed told are those a client that attaches then reads.
async fn the_approval_is_published_at_once(approval_first: bool) {
    let mut turn = Turn::start(move |port, mut barrier| async move {
        let ask = || ApprovalAsk {
            kind: ApprovalKind::Tool,
            call_id: None,
            tool: Some("shell".into()),
            action_kind: None,
            reason: Some("shell needs a look".into()),
            payload: json!({ "name": "shell" }),
            remember: Vec::new(),
            expires_after: None,
        };
        let card = |port: RunPort| {
            let item = row("a-1".into(), "assistant", json!({ "text": "listing", "toolCalls": calls() }));
            tokio::spawn(async move { port.commit_item(item).await })
        };
        let mut call_row = None;
        if !approval_first {
            call_row = Some(card(port.clone()));
            barrier.wait().await;
        }
        port.call_mark(CallMark::ToolApproval).await.expect("shown");
        let asking = port.clone();
        let asked = tokio::spawn(async move { asking.request(ask()).await });
        if approval_first {
            call_row = Some(card(port.clone()));
        }
        port.usage(usage()).await.expect("usage");
        barrier.wait().await;
        asked.abort();
        call_row.expect("the card").await.expect("task").expect("the call row");
    })
    .await;
    turn.reached().await;
    if !approval_first {
        // The card is out and attached to; the approval comes later in the same step.
        let attached = view_order(&turn);
        assert!(attached.iter().any(|id| id == "call:c1"), "an attaching client reads the card: {attached:?}");
        turn.release();
        turn.reached().await;
    }
    let mode = |method: &str, params: &Value| method == "thread/runtime/updated" && params["value"]["spinner"]["mode"] == "tool-approval";
    let approval = turn.position(mode).expect("the approval's spinner transition is published without the step's end");
    turn.position(|method, params| method == "item/completed" && is_card(params, "call:c1")).expect("the card is published too");
    crate::eventually_on!(&[&turn.handle.cell.stepped], || turn.framed_after(approval).then_some(())).await;
    let told: Vec<String> = told_order(&turn).into_iter().filter(|id| id.starts_with("call:")).collect();
    let attached: Vec<String> = view_order(&turn).into_iter().filter(|id| id.starts_with("call:")).collect();
    assert_eq!(told, attached, "the live client and the attaching one hold the same cards");
    turn.release();
    crate::eventually_on!(&[&turn.handle.cell.stepped], || crate::session::tests::idle(&turn.handle).then_some(())).await;
}

#[tokio::test(start_paused = true)]
async fn an_approval_raised_before_its_card_is_published_at_once() {
    the_approval_is_published_at_once(true).await;
}

#[tokio::test(start_paused = true)]
async fn an_approval_raised_after_its_card_is_published_at_once() {
    the_approval_is_published_at_once(false).await;
}
