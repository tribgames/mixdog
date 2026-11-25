use std::sync::Arc;
use std::sync::atomic::Ordering::SeqCst;

use mixdog_core_api::RunControl;
use mixdog_core_api::ThreadHandle;
use mixdog_protocol::PromptContent;
use mixdog_protocol::ThreadItem;
use mixdog_rt::LaneKind;
use mixdog_rt::testing::hold_full;
use serde_json::Value;
use serde_json::json;

use crate::eventually_on;
use crate::session::RunOutcome;
use crate::session::SessionDirectory;
use crate::session::SessionHandle;
use crate::session::StartHold;
use crate::session::testing::Rig;
use crate::session::testing::Script;
use crate::session::tests::caught_up;
use crate::session::tests::idle;
use crate::session::tests::request;
use crate::session::tests::start_thread;
use crate::session::tests::turn;

fn prompt_of(input: &mixdog_app_protocol::v2::thread::TurnInput) -> String {
    match &input.prompt {
        PromptContent::Text(text) => text.clone(),
        PromptContent::Parts(_) => String::new(),
    }
}

/// A run of `first` waits for `gate`; a run of `stop` waits for its interrupt; any other ends once its input is durable.
fn script(gate: Arc<tokio::sync::Notify>) -> Script {
    Arc::new(move |run| {
        let gate = gate.clone();
        Box::pin(async move {
            match prompt_of(&run.input).as_str() {
                "stop" => {
                    run.cancel.cancelled().await;
                    return RunOutcome::Interrupted;
                }
                "first" => gate.notified().await,
                _ => {}
            }
            if run.port.input_durable().await.is_err() {
                return RunOutcome::Interrupted;
            }
            RunOutcome::Completed(Default::default())
        })
    })
}

fn is_row(params: &Value, prompt: &str) -> bool {
    params["item"]["type"] == "userMessage" && params["item"]["displayText"] == prompt
}

/// Where the feed, read in order as a client reads it, held `prompt`'s row with the session idle before its turn ran: a
/// publication (`thread/frame`, the phone's) or an idle runtime after the row and before the turn's busy runtime.
fn idle_with_row(rig: &Rig, handle: &SessionHandle, prompt: &str) -> Vec<String> {
    let (mut told, mut waiting) = (false, false);
    let mut out = Vec::new();
    for (seq, method, params) in rig.feeds.frames(handle.id.as_str()) {
        match method.as_str() {
            "item/started" | "item/completed" if !told && is_row(&params, prompt) => (told, waiting) = (true, true),
            "thread/runtime/updated" if waiting && params["value"]["busy"] == true => waiting = false,
            "thread/runtime/updated" if waiting => out.push(format!("{seq}: an idle runtime")),
            "thread/frame" if waiting => out.push(format!("{seq}: a publication")),
            _ => {}
        }
    }
    if waiting {
        out.push("the end of the feed".to_owned());
    }
    out
}

fn told_row(rig: &Rig, handle: &SessionHandle, prompt: &str) -> bool {
    rig.feeds.frames(handle.id.as_str()).iter().any(|(_, method, params)| method.starts_with("item/") && is_row(params, prompt))
}

/// The snapshot (the actor's published view): whether it holds `prompt`'s row, and whether the session is busy.
fn snapshot(handle: &SessionHandle, prompt: &str) -> (bool, bool) {
    let view = handle.cell.view.load_full();
    let row = view.items.iter().any(|item| matches!(item.as_ref(), ThreadItem::UserMessage { display_text, .. } if display_text == prompt));
    (row, view.state.runtime.as_ref().is_some_and(|runtime| runtime.busy))
}

fn queues(rows: &Value, prompt: &str) -> bool {
    rows.as_array().is_some_and(|rows| rows.iter().any(|row| row["text"] == prompt))
}

/// Where the feed, read as a client reads it, held `prompt` (once queued) in neither the queue nor the rows at a publication
/// (`thread/frame`) or at its end.
fn in_neither(rig: &Rig, handle: &SessionHandle, prompt: &str) -> Vec<String> {
    let (mut queued, mut was_queued, mut row) = (false, false, false);
    let mut out = Vec::new();
    for (seq, method, params) in rig.feeds.frames(handle.id.as_str()) {
        match method.as_str() {
            "thread/queue/changed" => {
                queued = queues(&params["queued"], prompt);
                was_queued |= queued;
            }
            "item/started" | "item/completed" if is_row(&params, prompt) => row = true,
            "thread/frame" if was_queued && !queued && !row => out.push(format!("{seq}: a publication")),
            _ => {}
        }
    }
    if was_queued && !queued && !row {
        out.push("the end of the feed".to_owned());
    }
    out
}

/// Whether the snapshot's queue holds `prompt`.
fn queued_in_snapshot(handle: &SessionHandle, prompt: &str) -> bool {
    let view = handle.cell.view.load_full();
    view.state.queued.as_ref().is_some_and(|rows| rows.iter().any(|row| row["text"] == prompt))
}

/// A drain ready to go: `first` ran and ended, `second` waits in the queue, and the core's hold keeps the drain until `.2`
/// opens it.
async fn drain_ready(rig: &Rig) -> (SessionDirectory, Arc<SessionHandle>, tokio::sync::watch::Sender<StartHold>) {
    let gate = Arc::new(tokio::sync::Notify::new());
    rig.set_script(script(gate.clone()));
    let (hold, start_hold) = tokio::sync::watch::channel(StartHold::Open);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.start_hold = start_hold;
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    assert_eq!(turn(&handle, "first", "op-1").await["kind"], "started");
    assert_eq!(turn(&handle, "second", "op-2").await["kind"], "queued");
    hold.send_replace(StartHold::Held);
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (settled(&handle) && completed(rig, &handle).len() == 1).then_some(())).await;
    assert!(queued_in_snapshot(&handle, "second"));
    (directory, handle, hold)
}

/// The position in the feed of the `n`th (from 0) frame `wanted` takes.
fn nth(rig: &Rig, handle: &SessionHandle, n: usize, wanted: impl Fn(&str, &Value) -> bool) -> usize {
    let feed = rig.feeds.frames(handle.id.as_str());
    feed.iter().enumerate().filter(|(_, (_, method, params))| wanted(method, params)).nth(n).map(|(at, _)| at).unwrap_or_else(|| panic!("frame {n} not told"))
}

fn settled(handle: &SessionHandle) -> bool {
    idle(handle) && handle.cell.unacked.load(SeqCst) == 0
}

fn completed(rig: &Rig, handle: &SessionHandle) -> Vec<Value> {
    rig.feeds.frames(handle.id.as_str()).into_iter().filter(|(_, method, _)| method == "turn/completed").map(|(_, _, params)| params).collect()
}

/// A direct start whose turn start reaches the disk late: while its encodes wait, and while its write waits, no client is told
/// the row and the snapshot holds none; once the start lands, the row and the busy session are told together.
#[tokio::test(start_paused = true)]
async fn a_started_prompts_row_comes_with_its_running_turn() {
    let rig = Rig::new();
    rig.set_script(script(Default::default()));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    eventually_on!(&[&handle.cell.stepped], || settled(&handle).then_some(())).await;
    let disk = hold_full(LaneKind::DurabilityIo);
    let cpu = hold_full(LaneKind::CpuInteractive);
    let started = {
        let handle = handle.clone();
        tokio::spawn(async move { turn(&handle, "hello", "op-1").await })
    };
    cpu.met_by_a_submit().await;
    caught_up(&handle).await;
    assert!(!told_row(&rig, &handle, "hello"), "nothing is told while the records encode");
    assert_eq!(snapshot(&handle, "hello"), (false, false));

    drop(cpu);
    disk.met_by_a_submit().await;
    caught_up(&handle).await;
    assert!(!told_row(&rig, &handle, "hello"), "the row waits for its turn's start, still at the disk");
    assert_eq!(snapshot(&handle, "hello"), (false, false), "the snapshot holds no row of an idle session");

    drop(disk);
    assert_eq!(started.await.expect("the start")["kind"], "started");
    eventually_on!(&[&handle.cell.stepped, &*rig.feeds.published], || told_row(&rig, &handle, "hello").then_some(())).await;
    assert_eq!(idle_with_row(&rig, &handle, "hello"), Vec::<String>::new());
    eventually_on!(&[&handle.cell.stepped], || settled(&handle).then_some(())).await;
    assert_eq!(idle_with_row(&rig, &handle, "hello"), Vec::<String>::new());
}

/// A prompt queued behind a running turn, drained once that turn ends: between the end and the drained turn's start no
/// client holds the drained row with the session idle, and a snapshot taken while the new start is at the disk holds none.
#[tokio::test(start_paused = true)]
async fn a_drained_prompts_row_comes_with_its_running_turn() {
    let rig = Rig::new();
    let gate = Arc::new(tokio::sync::Notify::new());
    rig.set_script(script(gate.clone()));
    let (hold, start_hold) = tokio::sync::watch::channel(StartHold::Open);
    let mut deps = rig.deps_parts(rig.store.clone());
    deps.start_hold = start_hold;
    let directory = SessionDirectory::new(Arc::new(deps));
    let handle = start_thread(&directory).await;
    assert_eq!(turn(&handle, "first", "op-1").await["kind"], "started");
    assert_eq!(turn(&handle, "second", "op-2").await["kind"], "queued");

    // The drain is held while the first turn ends and lands, then let go with the disk held: the drained start waits there.
    hold.send_replace(StartHold::Held);
    gate.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (settled(&handle) && completed(&rig, &handle).len() == 1).then_some(())).await;
    assert_eq!(snapshot(&handle, "second"), (false, false));
    assert!(queued_in_snapshot(&handle, "second"), "the prompt waits in the queue");
    let disk = hold_full(LaneKind::DurabilityIo);
    hold.send_replace(StartHold::Open);
    eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load().is_some().then_some(())).await;
    disk.met_by_a_submit().await;
    caught_up(&handle).await;
    assert!(!told_row(&rig, &handle, "second"), "the drained row waits for its turn's start, still at the disk");
    assert_eq!(snapshot(&handle, "second"), (false, false), "the snapshot holds no drained row of an idle session");
    assert!(queued_in_snapshot(&handle, "second"), "the snapshot still queues the prompt: its dequeue shows with its row");
    assert_eq!(in_neither(&rig, &handle, "second"), Vec::<String>::new(), "no client lost the prompt from both places");

    drop(disk);
    eventually_on!(&[&handle.cell.stepped], || (settled(&handle) && completed(&rig, &handle).len() == 2).then_some(())).await;
    assert!(told_row(&rig, &handle, "second"));
    assert!(!queued_in_snapshot(&handle, "second") && snapshot(&handle, "second").0, "the prompt moved from the queue to the rows");
    assert_eq!(idle_with_row(&rig, &handle, "second"), Vec::<String>::new());
    assert_eq!(idle_with_row(&rig, &handle, "first"), Vec::<String>::new());
    assert_eq!(in_neither(&rig, &handle, "second"), Vec::<String>::new(), "no publication held the prompt in neither place");
}

/// A prompt that waited in the queue is stored with its read mark (`fromQueue`), as the turn it starts reads it; a prompt that
/// started its turn at once is stored with none.
#[tokio::test(start_paused = true)]
async fn a_drained_prompt_is_stored_with_its_read_mark() {
    let rig = Rig::new();
    let (_directory, handle, hold) = drain_ready(&rig).await;
    hold.send_replace(StartHold::Open);
    eventually_on!(&[&handle.cell.stepped], || (settled(&handle) && completed(&rig, &handle).len() == 2).then_some(())).await;
    let mark = |prompt: &str| {
        rig.store.records(&handle.id).into_iter().find_map(|(_, record)| match record {
            mixdog_store::schema::record::Record::Item(item) => match &item.body {
                mixdog_store::schema::blob::Slot::Inline(body) if body["content"] == prompt => Some(body["meta"]["transcript"]["fromQueue"].clone()),
                _ => None,
            },
            _ => None,
        })
    };
    assert_eq!(mark("second"), Some(json!(true)));
    assert_eq!(mark("first"), Some(Value::Null));
}

/// A start whose save fails is refused: its caller hears the failure, and no client was told its row or a busy session (the
/// unit is withdrawn whole); the snapshot holds neither.
#[tokio::test(start_paused = true)]
async fn a_refused_start_tells_no_client_its_row() {
    let rig = Rig::new();
    rig.set_script(script(Default::default()));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    eventually_on!(&[&handle.cell.stepped], || settled(&handle).then_some(())).await;
    *rig.store.failing.lock().unwrap() = Some("EIO: injected".into());
    let refused = handle.request(request("turn/start", json!({ "threadId": handle.id, "opId": "op-1", "input": { "prompt": "doomed" } }), "op-1")).await;
    assert!(refused.is_err(), "the start is refused: {refused:?}");
    eventually_on!(&[&handle.cell.stepped], || idle(&handle).then_some(())).await;
    caught_up(&handle).await;
    assert!(!told_row(&rig, &handle, "doomed"), "the refused prompt's row was never told");
    assert_eq!(snapshot(&handle, "doomed"), (false, false));
    assert!(rig.feeds.frames(handle.id.as_str()).iter().all(|(_, method, _)| method != "turn/started"), "nor its start");
}

/// A start stopped while it is still at the disk: once it lands, the row and the busy session are told together, then the
/// turn's interrupted end; the row stays (a stop that does not restore the prompt keeps it).
#[tokio::test(start_paused = true)]
async fn a_start_stopped_before_it_lands_tells_its_row_with_its_turn_then_the_end() {
    let rig = Rig::new();
    rig.set_script(script(Default::default()));
    let directory = SessionDirectory::new(rig.deps());
    let handle = start_thread(&directory).await;
    eventually_on!(&[&handle.cell.stepped], || settled(&handle).then_some(())).await;
    let disk = hold_full(LaneKind::DurabilityIo);
    let started = {
        let handle = handle.clone();
        tokio::spawn(async move { turn(&handle, "stop", "op-1").await })
    };
    let run = eventually_on!(&[&handle.cell.stepped], || handle.cell.run.load_full()).await;
    disk.met_by_a_submit().await;
    handle.interrupt(&run.turn, None).expect("interrupt");
    caught_up(&handle).await;
    assert!(!told_row(&rig, &handle, "stop"), "nothing of the start is told before it lands");
    assert_eq!(snapshot(&handle, "stop"), (false, false));

    drop(disk);
    assert_eq!(started.await.expect("the start")["kind"], "started");
    eventually_on!(&[&handle.cell.stepped], || (settled(&handle) && completed(&rig, &handle).len() == 1).then_some(())).await;
    assert_eq!(idle_with_row(&rig, &handle, "stop"), Vec::<String>::new());
    let feed = rig.feeds.frames(handle.id.as_str());
    let at = |wanted: &dyn Fn(&str, &Value) -> bool| feed.iter().position(|(_, method, params)| wanted(method, params)).expect("told");
    let (row, start, end) = (
        at(&|method, params| method.starts_with("item/") && is_row(params, "stop")),
        at(&|method, _| method == "turn/started"),
        at(&|method, _| method == "turn/completed"),
    );
    assert!(row < start && start < end, "the row, its start, then its end: {row} {start} {end}");
    assert_eq!(completed(&rig, &handle)[0]["turn"]["status"], "interrupted");
    assert_eq!(snapshot(&handle, "stop"), (true, false), "the stopped turn's row stays, the session idle after its end");
}

/// A drained prompt whose start is refused (the write of its row and start fails): the dequeue the start would have carried
/// shows on its own, nothing of the start is told, and the session goes on: a later turn starts and lands.
#[tokio::test(start_paused = true)]
async fn a_drained_prompt_whose_start_is_refused_leaves_the_queue_on_its_own() {
    let rig = Rig::new();
    let (_directory, handle, hold) = drain_ready(&rig).await;
    let second = |record: &mixdog_store::schema::record::Record| {
        matches!(record, mixdog_store::schema::record::Record::Item(item)
            if matches!(&item.body, mixdog_store::schema::blob::Slot::Inline(body) if body["content"] == "second"))
    };
    *crate::session::testing::lock(&rig.store.fail_when) = Some((Box::new(second), false));
    hold.send_replace(StartHold::Open);
    eventually_on!(&[&handle.cell.stepped], || (settled(&handle)
        && crate::session::testing::lock(&rig.store.fail_when).is_none()
        && !queued_in_snapshot(&handle, "second"))
    .then_some(()))
    .await;
    caught_up(&handle).await;
    assert!(!told_row(&rig, &handle, "second"), "the refused start's row is never told");
    assert_eq!(snapshot(&handle, "second"), (false, false));
    assert_eq!(rig.feeds.frames(handle.id.as_str()).iter().filter(|(_, method, _)| method == "turn/started").count(), 1, "only the first turn started");
    assert!(
        !queues(
            &rig.feeds.frames(handle.id.as_str()).iter().rev().find(|(_, method, _)| method == "thread/queue/changed").expect("the dequeue is told").2["queued"],
            "second"
        ),
        "the client's queue let the prompt go"
    );

    assert_eq!(turn(&handle, "third", "op-3").await["kind"], "started", "a later turn starts");
    eventually_on!(&[&handle.cell.stepped], || (settled(&handle) && completed(&rig, &handle).len() == 2).then_some(())).await;
    assert_eq!(snapshot(&handle, "third"), (true, false));
    assert_eq!(idle_with_row(&rig, &handle, "third"), Vec::<String>::new());
}

/// A drained prompt whose start is deferred behind the idle auto-clear's compaction: the dequeue shows on its own while the
/// compaction runs (whatever it writes meanwhile is not held behind it), and the turn starts once the compaction ended, its row
/// with its running turn.
#[tokio::test(start_paused = true)]
async fn a_drained_prompt_deferred_behind_the_idle_clear_leaves_the_queue_on_its_own() {
    let rig = Rig::new();
    let (_directory, handle, hold) = drain_ready(&rig).await;
    // Armed only now: with a zero window the first turn's own start would be cleared too, and that compaction, held and
    // given up at its bound, would stay parked on the hold and take the release meant for the deferred start's.
    *crate::session::testing::lock(&rig.compaction.route) = mixdog_app_protocol::v2::thread::ThreadRoute {
        auto_clear: Some(json!({ "enabled": true, "idleMs": 0, "minContextPercent": 0 })),
        ..Default::default()
    };
    let compaction = Arc::new(tokio::sync::Notify::new());
    *crate::session::testing::lock(&rig.compaction.hold) = Some(compaction.clone());
    hold.send_replace(StartHold::Open);
    eventually_on!(&[&handle.cell.stepped, &rig.compaction.called], || {
        crate::session::testing::lock(&rig.compaction.calls).iter().any(|call| call.starts_with("compact auto_clear")).then_some(())
    })
    .await;
    eventually_on!(&[&handle.cell.stepped], || (handle.cell.unacked.load(SeqCst) == 0 && !queued_in_snapshot(&handle, "second")).then_some(())).await;
    caught_up(&handle).await;
    assert!(idle(&handle), "the turn waits for the compaction");
    assert!(!told_row(&rig, &handle, "second"));
    assert_eq!(snapshot(&handle, "second"), (false, false), "the dequeue showed on its own; nothing of the turn yet");

    *crate::session::testing::lock(&rig.compaction.hold) = None;
    compaction.notify_one();
    eventually_on!(&[&handle.cell.stepped], || (settled(&handle) && completed(&rig, &handle).len() == 2).then_some(())).await;
    assert_eq!(snapshot(&handle, "second"), (true, false));
    assert_eq!(idle_with_row(&rig, &handle, "second"), Vec::<String>::new());
}

#[tokio::test(start_paused = true)]
async fn controls_during_a_drained_starts_read_are_handled_and_shown_in_order() {
    let rig = Rig::new();
    let (_directory, handle, hold) = drain_ready(&rig).await;
    let io = hold_full(LaneKind::InteractiveIo);
    hold.send_replace(StartHold::Open);
    io.met_by_a_submit().await;
    caught_up(&handle).await;
    assert!(idle(&handle), "the start is still reading");
    assert!(queued_in_snapshot(&handle, "second"), "the client's queue keeps the prompt while its start is read");
    let stopped = handle.interrupt(&mixdog_core_api::ids::TurnId::from("none"), None);
    assert!(matches!(stopped, Err(mixdog_core_api::CoreError::TurnNotActive { .. })), "{stopped:?}");
    let third = {
        let handle = handle.clone();
        tokio::spawn(async move { turn(&handle, "third", "op-3").await })
    };
    caught_up(&handle).await;
    assert!(!told_row(&rig, &handle, "second"));

    drop(io);
    assert_eq!(third.await.expect("the queued prompt")["kind"], "queued");
    eventually_on!(&[&handle.cell.stepped], || (settled(&handle) && completed(&rig, &handle).len() == 3).then_some(())).await;
    let row = nth(&rig, &handle, 0, |method, params| method.starts_with("item/") && is_row(params, "second"));
    let start = nth(&rig, &handle, 1, |method, _| method == "turn/started");
    let queued_third = nth(&rig, &handle, 0, |method, params| method == "thread/queue/changed" && queues(&params["queued"], "third"));
    let dequeued =
        nth(&rig, &handle, 0, |method, params| method == "thread/queue/changed" && !queues(&params["queued"], "second") && !queues(&params["queued"], "third"));
    assert!(dequeued < queued_third && queued_third < row && row < start, "dequeue {dequeued}, the new prompt {queued_third}, row {row}, start {start}");
    let feed = rig.feeds.frames(handle.id.as_str());
    assert!(feed[dequeued..start].iter().all(|(_, method, _)| method != "thread/frame"), "one publication: {:?}", &feed[dequeued..=start]);
    assert_eq!(in_neither(&rig, &handle, "second"), Vec::<String>::new());
    assert_eq!(idle_with_row(&rig, &handle, "second"), Vec::<String>::new());
    assert_eq!(snapshot(&handle, "third"), (true, false), "the new prompt ran next");
}
